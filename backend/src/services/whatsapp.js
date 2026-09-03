import fs from "node:fs";
import path from "node:path";
import { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import { pool, query } from "../db/pool.js";

const DEFAULT_TEMPLATES = Object.freeze([
  "مرحباً، تم تسجيل حضور الطالب {student_name} ({student_code}) اليوم {date} الساعة {time} في {group_name}.\nرابط البوابة: {portal_link}\nكود المتابعة: {ref_code}",
  "تنبيه حضور: حضر الطالب {student_name} حصة {group_name} بتاريخ {date} في تمام {time}.\nيمكنك متابعة البوابة من هنا: {portal_link}\nالمرجع: {ref_code}",
  "تم تسجيل حضور {student_name} بنجاح في مجموعة {group_name}. التاريخ: {date}، الوقت: {time}.\nكود الطالب: {student_code}\nرابط الطالب: {portal_link}\nرقم المرجع: {ref_code}"
]);

const DEFAULT_SETTINGS = Object.freeze({
  auto_send: false,
  templates: [...DEFAULT_TEMPLATES],
  min_delay_seconds: 4,
  max_delay_seconds: 8
});

const publicAppUrl = String(process.env.PUBLIC_APP_URL || "https://abdrabo.up.railway.app").replace(/\/+$/, "");

const authDirectory = path.resolve(process.env.WHATSAPP_AUTH_DIR || path.resolve(process.cwd(), "whatsapp_auth"));
const state = {
  status: "disconnected",
  phoneNumber: null,
  qr: null,
  socket: null,
  connecting: null,
  reconnectTimer: null,
  manuallyDisconnected: false,
  workerTimer: null,
  workerRunning: false,
  lastSentAt: 0
};

function normalizeDigits(value) {
  return String(value ?? "").replace(/[٠-٩۰-۹]/g, (digit) => {
    const arabic = "٠١٢٣٤٥٦٧٨٩";
    const eastern = "۰۱۲۳۴۵۶۷۸۹";
    const index = arabic.indexOf(digit);
    return String(index >= 0 ? index : eastern.indexOf(digit));
  });
}

export function normalizeEgyptianPhone(value) {
  let digits = normalizeDigits(value).replace(/[^\d]/g, "");
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("0")) digits = `20${digits.slice(1)}`;
  if (digits.startsWith("1") && digits.length === 10) digits = `20${digits}`;
  if (!/^20(?:10|11|12|15)\d{8}$/.test(digits)) return null;
  return `+${digits}`;
}

function normalizeSettings(row) {
  const templates = Array.isArray(row?.templates)
    ? row.templates.map((template) => String(template ?? "").trim()).filter(Boolean).slice(0, 4)
    : [];
  const min = Number(row?.min_delay_seconds);
  const max = Number(row?.max_delay_seconds);
  return {
    auto_send: row?.auto_send === true,
    templates: templates.length ? templates : [...DEFAULT_TEMPLATES],
    min_delay_seconds: Number.isInteger(min) && min >= 4 && min <= 8 ? min : DEFAULT_SETTINGS.min_delay_seconds,
    max_delay_seconds: Number.isInteger(max) && max >= 4 && max <= 8 ? max : DEFAULT_SETTINGS.max_delay_seconds,
    portal_base_url: publicAppUrl
  };
}

export function validateWhatsAppSettings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_whatsapp_settings");
  if (typeof input.auto_send !== "boolean") throw new Error("invalid_auto_send");
  if (!Array.isArray(input.templates) || input.templates.length < 3 || input.templates.length > 4) throw new Error("invalid_templates");
  const templates = input.templates.map((template) => String(template ?? "").trim());
  if (templates.some((template) => template.length < 5 || template.length > 2000)) throw new Error("invalid_template_length");
  const min = Number(input.min_delay_seconds);
  const max = Number(input.max_delay_seconds);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 4 || max > 8 || min > max) throw new Error("invalid_delay_range");
  return { auto_send: input.auto_send, templates, min_delay_seconds: min, max_delay_seconds: max };
}

export async function getWhatsAppSettings(db = query) {
  const result = await db("SELECT auto_send, templates, min_delay_seconds, max_delay_seconds FROM whatsapp_settings WHERE id = 1");
  return normalizeSettings(result.rows[0]);
}

export async function updateWhatsAppSettings(input, { actorId, request = null, db = pool, audit } = {}) {
  const settings = validateWhatsAppSettings(input);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const before = await getWhatsAppSettings(client.query.bind(client));
    await client.query(
      `INSERT INTO whatsapp_settings (id, auto_send, templates, min_delay_seconds, max_delay_seconds, updated_by, updated_at)
       VALUES (1, $1, $2::jsonb, $3, $4, $5, NOW())
       ON CONFLICT (id) DO UPDATE SET auto_send = EXCLUDED.auto_send, templates = EXCLUDED.templates,
         min_delay_seconds = EXCLUDED.min_delay_seconds, max_delay_seconds = EXCLUDED.max_delay_seconds,
         updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [settings.auto_send, JSON.stringify(settings.templates), settings.min_delay_seconds, settings.max_delay_seconds, actorId || null]
    );
    if (audit && JSON.stringify(before) !== JSON.stringify(settings)) {
      await audit({ db: client, action: "whatsapp_settings_changed", actorId, details: { previous: before, next: settings }, request });
    }
    await client.query("COMMIT");
    return { ...settings, portal_base_url: publicAppUrl };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function setDisconnected() {
  state.status = "disconnected";
  state.phoneNumber = null;
  state.qr = null;
  state.socket = null;
}

function scheduleReconnect() {
  if (state.manuallyDisconnected || state.reconnectTimer || state.connecting) return;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    void connectWhatsApp();
  }, 3000);
}

export async function connectWhatsApp() {
  if (state.status === "connected" && state.socket) return getWhatsAppStatus();
  if (state.connecting) return state.connecting;
  state.manuallyDisconnected = false;
  state.status = "connecting";
  state.connecting = (async () => {
    await fs.promises.mkdir(authDirectory, { recursive: true });
    const { state: authState, saveCreds } = await useMultiFileAuthState(authDirectory);
    const socket = makeWASocket({
      auth: authState,
      browser: Browsers.ubuntu("Abdrabo Attendance"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      getMessage: async () => undefined
    });
    state.socket = socket;
    socket.ev.on("creds.update", saveCreds);
    socket.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        state.status = "connecting";
        state.qr = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
      }
      if (connection === "open") {
        state.status = "connected";
        state.qr = null;
        state.phoneNumber = normalizeEgyptianPhone(socket.user?.id?.split(":")[0]) || socket.user?.id?.split(":")[0] || null;
        console.log(`WhatsApp connected${state.phoneNumber ? ` as ${state.phoneNumber}` : ""}`);
      }
      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        setDisconnected();
        if (code !== DisconnectReason.loggedOut) scheduleReconnect();
      }
    });
    return getWhatsAppStatus();
  })().catch((error) => {
    setDisconnected();
    scheduleReconnect();
    console.error("WhatsApp connection failed", error);
    return getWhatsAppStatus();
  }).finally(() => {
    state.connecting = null;
    if (state.status === "disconnected" && !state.manuallyDisconnected) scheduleReconnect();
  });
  return state.connecting;
}

export function getWhatsAppStatus() {
  return { status: state.status, phone_number: state.phoneNumber, has_qr: Boolean(state.qr) };
}

export async function getWhatsAppQr() {
  if (state.status === "connected") return { ...getWhatsAppStatus(), qr: null };
  await connectWhatsApp();
  const deadline = Date.now() + 10000;
  while (!state.qr && state.status !== "connected" && Date.now() < deadline) await sleep(100);
  return { ...getWhatsAppStatus(), qr: state.qr };
}

export async function disconnectWhatsApp() {
  state.manuallyDisconnected = true;
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  try { await state.socket?.logout(); } catch (error) { console.warn("WhatsApp logout failed", error); }
  setDisconnected();
  await fs.promises.rm(authDirectory, { recursive: true, force: true });
  return getWhatsAppStatus();
}

function cairoParts(value) {
  const date = new Date(value || Date.now());
  const locale = "en-GB";
  return {
    date: new Intl.DateTimeFormat(locale, { dateStyle: "short", timeZone: "Africa/Cairo" }).format(date),
    time: new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone: "Africa/Cairo" }).format(date)
  };
}

function applyTemplate(template, values) {
  return template.replace(/\{(student_name|date|time|group_name|ref_code)\}/g, (_match, key) => values[key] ?? "");
}

function randomInteger(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function enqueueAttendanceNotification({ attendanceRecordId, studentId }) {
  const settings = await getWhatsAppSettings();
  if (!settings.auto_send) return { queued: false, reason: "disabled" };
  const result = await query(`
    SELECT ar.id AS attendance_record_id, ar.status, ar.checkin_time, st.id AS student_id,
      st.full_name AS student_name, st.student_code, st.guardian_phone, COALESCE(g.display_name, g.name) AS group_name
    FROM attendance_records ar
    JOIN students st ON st.id = ar.student_id
    JOIN attendance_sessions ats ON ats.id = ar.session_id
    JOIN groups g ON g.id = ats.group_id
    WHERE ar.id = $1 AND st.id = $2 AND ar.status IN ('present','late')`, [attendanceRecordId, studentId]);
  const row = result.rows[0];
  if (!row) return { queued: false, reason: "not_eligible" };
  const phone = normalizeEgyptianPhone(row.guardian_phone);
  if (!phone) return { queued: false, reason: "invalid_phone" };
  const refCode = `ATT-${new Date(row.checkin_time).toISOString().slice(0, 10).replaceAll("-", "")}-${row.attendance_record_id}`;
  await query(`
    INSERT INTO whatsapp_notification_jobs (attendance_record_id, student_id, phone_number, payload, ref_code)
    VALUES ($1, $2, $3, $4::jsonb, $5)
    ON CONFLICT (attendance_record_id) DO NOTHING`, [
    row.attendance_record_id,
    row.student_id,
    phone,
    JSON.stringify({ student_name: row.student_name, student_code: row.student_code, group_name: row.group_name, checkin_time: row.checkin_time }),
    refCode
  ]);
  wakeWhatsAppWorker();
  return { queued: true, ref_code: refCode };
}

async function claimNextJob() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(`SELECT * FROM whatsapp_notification_jobs
      WHERE status = 'pending' AND next_attempt_at <= NOW()
      ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`);
    if (!result.rowCount) { await client.query("COMMIT"); return null; }
    const updated = await client.query(`UPDATE whatsapp_notification_jobs
      SET status = 'processing', attempts = attempts + 1, updated_at = NOW()
      WHERE id = $1 RETURNING *`, [result.rows[0].id]);
    await client.query("COMMIT");
    return updated.rows[0];
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

async function updateJob(id, status, fields = {}) {
  await query(`UPDATE whatsapp_notification_jobs SET status = $2, last_error = $3,
    next_attempt_at = COALESCE($4, next_attempt_at), sent_at = CASE WHEN $2 = 'sent' THEN NOW() ELSE sent_at END,
    updated_at = NOW() WHERE id = $1`, [id, status, fields.error || null, fields.nextAttemptAt || null]);
}

async function processWhatsAppJob() {
  if (state.workerRunning) return;
  state.workerRunning = true;
  let job = null;
  try {
    job = await claimNextJob();
    if (!job) return;
    const settings = await getWhatsAppSettings();
    if (!settings.auto_send) { await updateJob(job.id, "skipped", { error: "auto_send_disabled" }); return; }
    if (state.status !== "connected" || !state.socket) {
      await updateJob(job.id, "pending", { error: "whatsapp_disconnected", nextAttemptAt: new Date(Date.now() + 10_000) });
      return;
    }
    const elapsed = Date.now() - state.lastSentAt;
    const delay = randomInteger(settings.min_delay_seconds, settings.max_delay_seconds) * 1000;
    if (state.lastSentAt && elapsed < delay) await sleep(delay - elapsed);
    const parts = cairoParts(job.payload?.checkin_time);
    const templates = settings.templates.filter(Boolean);
    const template = templates[randomInteger(0, templates.length - 1)];
    const body = applyTemplate(template, {
      ...job.payload,
      ...parts,
      ref_code: job.ref_code,
      portal_link: `${publicAppUrl}/student/${encodeURIComponent(String(job.payload?.student_code || ""))}`
    });
    const phone = normalizeEgyptianPhone(job.phone_number);
    if (!phone) { await updateJob(job.id, "skipped", { error: "invalid_phone" }); return; }
    await state.socket.sendMessage(`${phone.slice(1)}@s.whatsapp.net`, { text: body });
    state.lastSentAt = Date.now();
    await updateJob(job.id, "sent");
  } catch (error) {
    console.error("WhatsApp notification worker error", error);
    if (job?.id) {
      const attempts = Number(job.attempts || 0);
      const retry = attempts < 3;
      await updateJob(job.id, retry ? "pending" : "failed", {
        error: String(error.message || error),
        nextAttemptAt: retry ? new Date(Date.now() + 60_000) : null
      });
    }
  } finally { state.workerRunning = false; }
}

function wakeWhatsAppWorker() {
  if (!state.workerTimer) void processWhatsAppJob();
}

export function startWhatsAppWorker() {
  if (state.workerTimer) return;
  void query(`UPDATE whatsapp_notification_jobs
    SET status = 'pending', next_attempt_at = NOW(), last_error = 'worker_restarted', updated_at = NOW()
    WHERE status = 'processing' AND updated_at < NOW() - INTERVAL '5 minutes'`).catch((error) => {
    console.error("Failed to recover WhatsApp notification jobs", error);
  });
  state.workerTimer = setInterval(() => { void processWhatsAppJob(); }, 1000);
  void processWhatsAppJob();
}

export async function startWhatsAppService() {
  startWhatsAppWorker();
  try {
    const files = await fs.promises.readdir(authDirectory);
    if (files.length) await connectWhatsApp();
  } catch (error) {
    if (error.code !== "ENOENT") console.error("WhatsApp auth directory could not be read", error);
  }
}
