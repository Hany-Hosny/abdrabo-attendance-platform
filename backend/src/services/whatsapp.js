import fs from "node:fs";
import path from "node:path";
import { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import { pool, query } from "../db/pool.js";
import { createStudentPortalAccessToken, hashStudentPortalAccessToken } from "./auth.js";
import { recordWhatsAppConnectionNotification } from "./notifications.js";

const DEFAULT_TEMPLATES = Object.freeze([
  "مرحباً بحضرتك، من منصة مستر أحمد عبدربه 👨‍🏫\nتم تسجيل حضور الطالب: {student_name}\nاليوم: {date} الساعة {time} في مجموعة: {group_name}.\nكود الطالب: {student_code}\nتقرير المتابعة: {portal_link}\nالمرجع: {ref_code}",
  "تنبيه حضور - مستر أحمد عبدربه:\nحضر الطالب {student_name} حصة {group_name} بتاريخ {date} في تمام الساعة {time}.\nرابط ملف المتابعة: {portal_link}\nالمرجع: {ref_code}",
  "إشعار حضور | مستر أحمد عبدربه\nتم تسجيل حضور {student_name} بنجاح في مجموعة {group_name}.\nالتاريخ: {date} - الوقت: {time}.\nكود الطالب: {student_code}\nتقرير فوري: {portal_link}\nرقم المرجع: {ref_code}"
]);
const DEFAULT_GRADE_TEMPLATES = Object.freeze([
  "نتيجة تقييم - مستر أحمد عبدربه 📝\nمرحباً بحضرتك، تم رصد نتيجة امتحان {exam_title} للطالب: {student_name}.\nالدرجة: {score} من {max_score} (النسبة: {percentage}%).\nكود الطالب: {student_code}\nتقرير الإجابات والتقييم: {portal_link}\nالمرجع: {ref_code}",
  "إشعار درجات | منصة مستر أحمد عبدربه\nحصل الطالب {student_name} في {exam_title} على نتيجة {score}/{max_score} بمعدل {percentage}%.\nتفاصيل التقييم: {portal_link}\nمع تحيات مستر أحمد عبدربه وإدارة المنصة.\nالمرجع: {ref_code}",
  "تقييم دراسي - مستر أحمد عبدربه:\nتم تصحيح {exam_title} للطالب {student_name}.\nالنتيجة المحققة: {score} من أصل {max_score}.\nرابط التقرير الكامل: {portal_link}\nكود: {ref_code}"
]);
const DEFAULT_RECEIPT_TEMPLATES = Object.freeze([
  "إيصال سداد مصروفات - مستر أحمد عبدربه 🧾\nالسلام عليكم يا فندم، تم استلام مبلغ {amount_paid} ج.م سداداً لمصروفات شهر {month} للطالب: {student_name}.\nرقم الإيصال: {receipt_number}\nكود الطالب: {student_code}\nعرض الإيصال: {portal_link}\nشكراً لتعاونكم الدائم.",
  "سند قبض إلكتروني | مستر أحمد عبدربه\nتم بنجاح تسجيل دفعة مالية بقيمة {amount_paid} ج.م لحساب الطالب: {student_name} (سداد {month}).\nرقم السند: {receipt_number}\nالسجل المالي: {portal_link}\nالمرجع: {ref_code}",
  "إشعار تحصيل نقدية - مكتب مستر أحمد عبدربه:\nتم استلام مبلغ {amount_paid} جنيه لمصروفات {month} الخاصة بالطالب {student_name}.\nإيصال رقم: #{receipt_number}.\nمتابعة الحساب: {portal_link}"
]);
const DEFAULT_ADVANCE_PAYMENT_TEMPLATES = Object.freeze([
  "إشعار دفع مقدم - مستر أحمد عبدربه 💳\nتم استلام مبلغ {amount_paid} ج.م كدفعة مقدمة للطالب: {student_name} عن شهور: {months}.\nرقم الإيصال: {receipt_number}\nمتابعة الحساب: {portal_link}",
  "تم بنجاح تسجيل دفعة مالية مقدمة بقيمة {amount_paid} ج.م لحساب الطالب: {student_name}.\nالشهور المسددة: {months}\nسند رقم: {receipt_number}\nالمرجع: {ref_code}",
  "إيصال استلام نقدية (دفع مقدم) | مستر أحمد عبدربه\nالطالب: {student_name}\nالمبلغ: {amount_paid} جنيه\nالشهور: {months}\nالإيصال: #{receipt_number}\nالرابط: {portal_link}"
]);

const DEFAULT_SETTINGS = Object.freeze({
  auto_send: false,
  templates: [...DEFAULT_TEMPLATES],
  grade_templates: [...DEFAULT_GRADE_TEMPLATES],
  receipt_templates: [...DEFAULT_RECEIPT_TEMPLATES],
  advance_payment_templates: [...DEFAULT_ADVANCE_PAYMENT_TEMPLATES],
  min_delay_seconds: 4,
  max_delay_seconds: 8
});

const publicAppUrl = String(
  process.env.FRONTEND_URL ||
  process.env.PUBLIC_APP_URL ||
  (process.env.NODE_ENV === "production" ? "https://abdrabo.up.railway.app" : "http://localhost:3000")
).replace(/\/+$/, "");

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
  lastSentAt: 0,
  connectionEstablished: false,
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
  const normalizeTemplates = (value, fallback, requiredPlaceholder) => {
    const templates = Array.isArray(value) ? value.map((template) => String(template ?? "").trim()).filter(Boolean).slice(0, 4) : [];
    return templates.length >= 3 && templates.every((template) => templateHasPlaceholder(template, requiredPlaceholder)) ? templates : [...fallback];
  };
  const templates = normalizeTemplates(row?.templates, DEFAULT_TEMPLATES, "{student_name}");
  const gradeTemplates = normalizeTemplates(row?.grade_templates, DEFAULT_GRADE_TEMPLATES, "{exam_title}");
  const receiptTemplates = normalizeTemplates(row?.receipt_templates, DEFAULT_RECEIPT_TEMPLATES, "{amount_paid}");
  const advancePaymentTemplates = normalizeTemplates(row?.advance_payment_templates, DEFAULT_ADVANCE_PAYMENT_TEMPLATES, "{months}");
  const min = Number(row?.min_delay_seconds);
  const max = Number(row?.max_delay_seconds);
  return {
    auto_send: row?.auto_send === true,
    templates,
    grade_templates: gradeTemplates,
    receipt_templates: receiptTemplates,
    advance_payment_templates: advancePaymentTemplates,
    min_delay_seconds: Number.isInteger(min) && min >= 2 && min <= 60 ? min : DEFAULT_SETTINGS.min_delay_seconds,
    max_delay_seconds: Number.isInteger(max) && max >= 2 && max <= 60 ? max : DEFAULT_SETTINGS.max_delay_seconds,
    portal_base_url: publicAppUrl
  };
}

export function validateWhatsAppSettings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_whatsapp_settings");
  if (typeof input.auto_send !== "boolean") throw new Error("invalid_auto_send");
  if (!Array.isArray(input.templates) || input.templates.length < 3 || input.templates.length > 4) throw new Error("invalid_templates");
  const rawTemplates = input.templates.map((template) => String(template ?? "").trim());
  if (rawTemplates.some((template) => template.length < 5 || template.length > 2000)) throw new Error("invalid_template_length");
  const templates = rawTemplates.some((template) => !templateHasPlaceholder(template, "student_name")) ? [...DEFAULT_TEMPLATES] : rawTemplates;
  const normalizeOptionalTemplates = (value, fallback, requiredPlaceholder) => {
    if (value === undefined) return [...fallback];
    if (!Array.isArray(value) || value.length < 3 || value.length > 4) throw new Error("invalid_templates");
    const rawTemplates = value.map((template) => String(template ?? "").trim());
    if (rawTemplates.some((template) => template.length < 5 || template.length > 2000)) throw new Error("invalid_template_length");
    return rawTemplates.some((template) => !templateHasPlaceholder(template, requiredPlaceholder)) ? [...fallback] : rawTemplates;
  };
  const gradeTemplates = normalizeOptionalTemplates(input.grade_templates, DEFAULT_GRADE_TEMPLATES, "{exam_title}");
  const receiptTemplates = normalizeOptionalTemplates(input.receipt_templates, DEFAULT_RECEIPT_TEMPLATES, "{amount_paid}");
  const advancePaymentTemplates = normalizeOptionalTemplates(input.advance_payment_templates, DEFAULT_ADVANCE_PAYMENT_TEMPLATES, "{months}");
  const min = Number(input.min_delay_seconds);
  const max = Number(input.max_delay_seconds);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 2 || max > 60 || min > max) throw new Error("invalid_delay_range");
  return { auto_send: input.auto_send, templates, grade_templates: gradeTemplates, receipt_templates: receiptTemplates, advance_payment_templates: advancePaymentTemplates, min_delay_seconds: min, max_delay_seconds: max };
}

export async function getWhatsAppSettings(db = query) {
  const result = await db("SELECT auto_send, templates, grade_templates, receipt_templates, advance_payment_templates, min_delay_seconds, max_delay_seconds FROM whatsapp_settings WHERE id = 1");
  return normalizeSettings(result.rows[0]);
}

export async function updateWhatsAppSettings(input, { actorId, request = null, db = pool, audit } = {}) {
  const settings = validateWhatsAppSettings(input);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const before = await getWhatsAppSettings(client.query.bind(client));
    await client.query(
      `INSERT INTO whatsapp_settings (id, auto_send, templates, grade_templates, receipt_templates, advance_payment_templates, min_delay_seconds, max_delay_seconds, updated_by, updated_at)
       VALUES (1, $1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6, $7, $8, NOW())
       ON CONFLICT (id) DO UPDATE SET auto_send = EXCLUDED.auto_send, templates = EXCLUDED.templates,
         grade_templates = EXCLUDED.grade_templates, receipt_templates = EXCLUDED.receipt_templates,
         advance_payment_templates = EXCLUDED.advance_payment_templates,
         min_delay_seconds = EXCLUDED.min_delay_seconds, max_delay_seconds = EXCLUDED.max_delay_seconds,
         updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [settings.auto_send, JSON.stringify(settings.templates), JSON.stringify(settings.grade_templates), JSON.stringify(settings.receipt_templates), JSON.stringify(settings.advance_payment_templates), settings.min_delay_seconds, settings.max_delay_seconds, actorId || null]
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
        state.connectionEstablished = true;
        state.qr = null;
        state.phoneNumber = normalizeEgyptianPhone(socket.user?.id?.split(":")[0]) || socket.user?.id?.split(":")[0] || null;
        console.log(`WhatsApp connected${state.phoneNumber ? ` as ${state.phoneNumber}` : ""}`);
      }
      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode;
        const wasEstablished = state.connectionEstablished;
        const wasManual = state.manuallyDisconnected;
        const phoneNumber = state.phoneNumber;
        state.connectionEstablished = false;
        setDisconnected();
        if (wasEstablished && !wasManual) {
          void recordWhatsAppConnectionNotification({
            status: "disconnected",
            reason: code === DisconnectReason.loggedOut ? "logged_out" : "connection_closed",
            phoneNumber
          }).catch((error) => console.error("Failed to record WhatsApp disconnect notification", error));
        }
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
  const wasEstablished = state.connectionEstablished;
  const phoneNumber = state.phoneNumber;
  state.manuallyDisconnected = true;
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  try { await state.socket?.logout(); } catch (error) { console.warn("WhatsApp logout failed", error); }
  setDisconnected();
  state.connectionEstablished = false;
  await fs.promises.rm(authDirectory, { recursive: true, force: true });
  if (wasEstablished) {
    void recordWhatsAppConnectionNotification({ status: "disconnected", reason: "manual_disconnect", phoneNumber })
      .catch((error) => console.error("Failed to record WhatsApp disconnect notification", error));
  }
  return getWhatsAppStatus();
}

function cairoParts(value) {
  const rawValue = String(value || "").trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(rawValue);
  const date = new Date(dateOnly ? `${rawValue}T12:00:00Z` : rawValue || Date.now());
  const locale = "en-GB";
  return {
    date: new Intl.DateTimeFormat(locale, { dateStyle: "short", timeZone: "Africa/Cairo" }).format(date),
    time: dateOnly ? "—" : new Intl.DateTimeFormat(locale, { timeStyle: "short", timeZone: "Africa/Cairo" }).format(date)
  };
}

function normalizeTemplateKey(key) {
  return String(key || "")
    .trim()
    .replace(/^\{+|\}+$/g, "")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

const TEMPLATE_TOKEN_PATTERN = /\{\{?\s*([a-zA-Z0-9_-]+)\s*\}\}?/gi;

function templateHasPlaceholder(template, key) {
  const normalizedKey = normalizeTemplateKey(key);
  const source = String(template ?? "");
  for (const match of source.matchAll(TEMPLATE_TOKEN_PATTERN)) {
    if (normalizeTemplateKey(match[1]) === normalizedKey) return true;
  }
  return false;
}

export function applyTemplate(template, values) {
  const normalizedValues = Object.fromEntries(
    Object.entries(values || {}).map(([key, value]) => [normalizeTemplateKey(key), value])
  );
  return String(template ?? "").replace(TEMPLATE_TOKEN_PATTERN, (_match, capturedKey) => {
    const key = normalizeTemplateKey(capturedKey);
    const value = normalizedValues[key];
    return value == null ? "" : String(value);
  });
}

function randomInteger(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function chooseTemplate(type, templates) {
  await query(
    `INSERT INTO whatsapp_template_rotation (notification_type, next_index)
     VALUES ($1, 0)
     ON CONFLICT (notification_type) DO NOTHING`,
    [type]
  );
  const result = await query(
    `UPDATE whatsapp_template_rotation
     SET next_index = (next_index + 1) % $2, updated_at = NOW()
     WHERE notification_type = $1
     RETURNING next_index`,
    [type, templates.length]
  );
  const nextIndex = Number(result.rows[0]?.next_index || 0);
  const index = (nextIndex + templates.length - 1) % templates.length;
  return { index, template: templates[index] };
}

function normalizeNotificationType(value) {
  const type = String(value || "").trim().toLowerCase();
  if (type === "grade" || type === "exam") return "grade";
  if (type === "receipt" || type === "fee") return "receipt";
  if (["advance_payment", "advance-payment", "advance"].includes(type)) return "advance_payment";
  if (type === "attendance") return "attendance";
  return null;
}

function notificationTypeFromReference(value) {
  const reference = String(value || "").trim().toUpperCase();
  if (reference.startsWith("GRD-")) return "grade";
  if (reference.startsWith("RCT-")) return "receipt";
  if (reference.startsWith("ADV-")) return "advance_payment";
  if (reference.startsWith("ATT-")) return "attendance";
  return null;
}

function notificationTypeForJob(job) {
  // The reference prefix is generated by the source operation and is authoritative.
  // This also repairs legacy rows that were stored with the old attendance type.
  const referenceType = notificationTypeFromReference(job.ref_code);
  if (referenceType && referenceType !== "attendance") return referenceType;
  return normalizeNotificationType(job.payload?.type || job.type || job.notification_type) || referenceType;
}

function notificationTemplates(settings, type) {
  switch (normalizeNotificationType(type)) {
    case "grade": {
      const configured = settings.grade_templates;
      const templates = Array.isArray(configured) ? configured.filter((template) => templateHasPlaceholder(template, "exam_title")) : [];
      return templates.length ? templates : [...DEFAULT_GRADE_TEMPLATES];
    }
    case "receipt": {
      const configured = settings.receipt_templates;
      const templates = Array.isArray(configured) ? configured.filter((template) => templateHasPlaceholder(template, "amount_paid")) : [];
      return templates.length ? templates : [...DEFAULT_RECEIPT_TEMPLATES];
    }
    case "advance_payment": {
      const configured = settings.advance_payment_templates;
      const templates = Array.isArray(configured)
        ? configured.filter((template) => templateHasPlaceholder(template, "amount_paid") && templateHasPlaceholder(template, "months"))
        : [];
      return templates.length ? templates : [...DEFAULT_ADVANCE_PAYMENT_TEMPLATES];
    }
    case "attendance":
      return Array.isArray(settings.templates) ? settings.templates : [...DEFAULT_TEMPLATES];
    default:
      throw new Error("unsupported_whatsapp_notification_type");
  }
}

function compileWhatsAppMessage(_type, template, values) {
  return applyTemplate(template, values);
}

export function buildStudentPortalLink(studentId, _studentCode, accessToken) {
  const numericStudentId = Number(studentId);
  if (!Number.isSafeInteger(numericStudentId) || numericStudentId <= 0 || !/^[A-Za-z0-9_-]{20,64}$/.test(String(accessToken || ""))) return "";
  return `${publicAppUrl}/p/${encodeURIComponent(accessToken)}`;
}

function formatMonthLabel(value, locale) {
  const month = String(value || "").trim().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(month)) return "";
  const date = new Date(`${month}-01T12:00:00Z`);
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "Africa/Cairo" }).format(date);
}

function formatMonthList(value, locale) {
  return String(value || "")
    .split(",")
    .map((month) => formatMonthLabel(month, locale))
    .filter(Boolean)
    .join(locale === "ar-EG" ? "، " : ", ");
}

function redactPortalLink(value) {
  return String(value || "")
    .replace(/\/p\/[A-Za-z0-9_-]{20,64}/g, "/p/[secure-link]")
    .replace(/([?&]access_token=)[A-Za-z0-9._-]+/g, "$1[redacted]");
}

async function createPortalAccessRecord(studentId, accessToken) {
  await query(
    `INSERT INTO student_portal_access_tokens (token_hash, student_id, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
    [hashStudentPortalAccessToken(accessToken), studentId]
  );
}

function notificationRefCode(prefix, dateValue, id, unique = false) {
  const date = new Date(dateValue || Date.now()).toISOString().slice(0, 10).replaceAll("-", "");
  return `${prefix}-${date}-${id}${unique ? `-${Date.now()}-${randomInteger(100, 999)}` : ""}`;
}

async function enqueueJob({ notificationType, sourceId, studentId, phone, payload, refCode, attendanceRecordId = null }) {
  const queuedPayload = { ...(payload || {}), type: notificationType };
  await query(`
    INSERT INTO whatsapp_notification_jobs (notification_type, source_id, attendance_record_id, student_id, phone_number, payload, ref_code)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
    ON CONFLICT DO NOTHING`, [
    notificationType, sourceId, attendanceRecordId, studentId, phone, JSON.stringify(queuedPayload), refCode
  ]);
  wakeWhatsAppWorker();
}

export async function enqueueAttendanceNotification({ attendanceRecordId, studentId }) {
  const settings = await getWhatsAppSettings();
  if (!settings.auto_send) return { queued: false, reason: "disabled" };
  const result = await query(`
    SELECT ar.id AS attendance_record_id, ar.status, ar.checkin_time, st.id AS student_id,
      st.full_name AS student_name, st.student_code, st.guardian_phone,
      COALESCE(NULLIF(TRIM(g.display_name), ''), NULLIF(TRIM(g.name), ''), '') AS group_name
    FROM attendance_records ar
    JOIN students st ON st.id = ar.student_id
    JOIN attendance_sessions ats ON ats.id = ar.session_id
    JOIN groups g ON g.id = ats.group_id
      WHERE ar.id = $1 AND st.id = $2 AND st.whatsapp_opted_out = FALSE AND ar.status IN ('present','late')`, [attendanceRecordId, studentId]);
  const row = result.rows[0];
  if (!row) return { queued: false, reason: "not_eligible" };
  const phone = normalizeEgyptianPhone(row.guardian_phone);
  if (!phone) return { queued: false, reason: "invalid_phone" };
  const refCode = notificationRefCode("ATT", row.checkin_time, row.attendance_record_id);
  await enqueueJob({
    notificationType: "attendance",
    sourceId: row.attendance_record_id,
    attendanceRecordId: row.attendance_record_id,
    studentId: row.student_id,
    phone,
    payload: { student_name: row.student_name, student_code: row.student_code, group_name: row.group_name, checkin_time: row.checkin_time },
    refCode
  });
  return { queued: true, ref_code: refCode };
}

export async function enqueueGradeNotification({ resultId }) {
  const result = await query(`
    SELECT er.id AS result_id, er.score, e.title AS exam_title, e.max_score, e.exam_date,
      s.id AS student_id, s.full_name AS student_name, s.student_code, s.guardian_phone
    FROM exam_results er
    JOIN exams e ON e.id = er.exam_id
    JOIN students s ON s.id = er.student_id
    WHERE er.id = $1 AND s.is_active = TRUE AND s.deleted_at IS NULL AND s.whatsapp_opted_out = FALSE`, [resultId]);
  const row = result.rows[0];
  if (!row) return { queued: false, reason: "not_found" };
  const phone = normalizeEgyptianPhone(row.guardian_phone);
  if (!phone) return { queued: false, reason: "invalid_phone" };
  const maxScore = Number(row.max_score);
  const score = Number(row.score);
  const percentage = maxScore > 0 ? ((score / maxScore) * 100).toFixed(1).replace(/\.0$/, "") : "0";
  const refCode = notificationRefCode("GRD", row.exam_date, row.result_id, true);
  await enqueueJob({ notificationType: "grade", sourceId: row.result_id, studentId: row.student_id, phone, refCode, payload: {
    student_name: row.student_name, student_code: row.student_code, exam_title: row.exam_title,
    score, max_score: maxScore, percentage, event_time: row.exam_date
  } });
  await query("UPDATE exam_results SET whatsapp_notified = TRUE WHERE id = $1", [row.result_id]);
  return { queued: true, ref_code: refCode };
}

export async function enqueueReceiptNotification({ paymentId }) {
  const result = await query(`
    SELECT p.id AS payment_id, p.amount, p.payment_reference, p.payment_months,
      p.payment_date, s.id AS student_id, s.full_name AS student_name, s.student_code, s.guardian_phone
    FROM payments p
    JOIN students s ON s.id = p.student_id
    WHERE p.id = $1 AND p.payment_type = 'normal' AND s.is_active = TRUE AND s.deleted_at IS NULL AND s.whatsapp_opted_out = FALSE`, [paymentId]);
  const row = result.rows[0];
  if (!row) return { queued: false, reason: "not_found" };
  const phone = normalizeEgyptianPhone(row.guardian_phone);
  if (!phone) return { queued: false, reason: "invalid_phone" };
  const months = Array.isArray(row.payment_months) ? row.payment_months.map((item) => String(item.month || "").slice(0, 7)).filter(Boolean) : [];
  const month = months.join(", ");
  const refCode = notificationRefCode("RCT", row.payment_date, row.payment_id, true);
  await enqueueJob({ notificationType: "receipt", sourceId: row.payment_id, studentId: row.student_id, phone, refCode, payload: {
    student_name: row.student_name, student_code: row.student_code, amount_paid: Number(row.amount).toFixed(2),
    month, receipt_number: row.payment_reference || refCode, event_time: row.payment_date
  } });
  return { queued: true, ref_code: refCode };
}

export async function enqueueAdvancePaymentNotification({ paymentId }) {
  const result = await query(`
    SELECT p.id AS payment_id, p.amount, p.payment_reference, p.payment_months,
      p.payment_date, s.id AS student_id, s.full_name AS student_name, s.student_code, s.guardian_phone
    FROM payments p
    JOIN students s ON s.id = p.student_id
    WHERE p.id = $1 AND p.payment_type = 'advance' AND s.is_active = TRUE AND s.deleted_at IS NULL AND s.whatsapp_opted_out = FALSE`, [paymentId]);
  const row = result.rows[0];
  if (!row) return { queued: false, reason: "not_found" };
  const phone = normalizeEgyptianPhone(row.guardian_phone);
  if (!phone) return { queued: false, reason: "invalid_phone" };
  const months = Array.isArray(row.payment_months)
    ? row.payment_months.map((item) => String(item?.month || "").slice(0, 7)).filter(Boolean).join(", ")
    : "";
  const refCode = notificationRefCode("ADV", row.payment_date, row.payment_id, true);
  await enqueueJob({ notificationType: "advance_payment", sourceId: row.payment_id, studentId: row.student_id, phone, refCode, payload: {
    student_name: row.student_name, student_code: row.student_code, amount_paid: Number(row.amount).toFixed(2),
    months, receipt_number: row.payment_reference || refCode, event_time: row.payment_date
  } });
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
    const type = notificationTypeForJob(job);
    if (!type) {
      await updateJob(job.id, "skipped", { error: "unsupported_whatsapp_notification_type" });
      return;
    }
    if (!settings.auto_send && type === "attendance") {
      await updateJob(job.id, "skipped", { error: "auto_send_disabled" });
      return;
    }
    if (state.status !== "connected" || !state.socket) {
      await updateJob(job.id, "pending", { error: "whatsapp_disconnected", nextAttemptAt: new Date(Date.now() + 10_000) });
      return;
    }
    const elapsed = Date.now() - state.lastSentAt;
    const delay = randomInteger(settings.min_delay_seconds, settings.max_delay_seconds) * 1000;
    if (state.lastSentAt && elapsed < delay) await sleep(delay - elapsed);
    const payload = job.payload && typeof job.payload === "object" ? job.payload : {};
    const parts = cairoParts(payload.event_time || payload.checkin_time);
    const templates = notificationTemplates(settings, type).filter(Boolean);
    if (!templates.length) {
      await updateJob(job.id, "failed", { error: "no_whatsapp_templates" });
      return;
    }
    const phone = normalizeEgyptianPhone(job.phone_number);
    if (!phone) { await updateJob(job.id, "skipped", { error: "invalid_phone" }); return; }
    const { index: templateIndex, template } = await chooseTemplate(type, templates);
    const studentCode = String(payload.student_code || "").trim();
    const accessToken = createStudentPortalAccessToken();
    const portalLink = buildStudentPortalLink(job.student_id, studentCode, accessToken);
    if (portalLink) await createPortalAccessRecord(job.student_id, accessToken);
    const locale = /[\u0600-\u06ff]/i.test(template) ? "ar-EG" : "en-US";
    const formattedPayload = {
      ...payload,
      amount_paid: payload.amount_paid == null ? payload.amount_paid : Number(payload.amount_paid).toFixed(2),
      month: payload.month ? formatMonthList(payload.month, locale) : payload.month,
      months: payload.months ? formatMonthList(payload.months, locale) : payload.months
    };
    const templateValues = {
      ...formattedPayload,
      ...parts,
      ref_code: job.ref_code,
      student_code: studentCode,
      portal_link: portalLink
    };
    const renderedBody = compileWhatsAppMessage(type, template, templateValues).trim();
    const body = portalLink && !templateHasPlaceholder(template, "portal_link")
      ? `${renderedBody}\n${portalLink}`
      : renderedBody;
    const footer = locale === "ar-EG" ? "— منصة مستر أحمد عبدربه" : "— Abdrabo Attendance Platform";
    const finalBody = body.includes(footer) ? body : `${body}\n\n${footer}`;
    await query(
      `UPDATE whatsapp_notification_jobs
       SET template_index = $2, template_text = $3, rendered_message = $4, updated_at = NOW()
       WHERE id = $1`,
      [job.id, templateIndex, template, redactPortalLink(finalBody)]
    );
    const messagePayload = { text: finalBody };
    console.log(`[WhatsApp] Sending TYPE: ${type}, TEMPLATE: ${templateIndex + 1}, TEXT: ${redactPortalLink(finalBody)}`);
    await state.socket.sendMessage(`${phone.slice(1)}@s.whatsapp.net`, messagePayload);
    state.lastSentAt = Date.now();
    await updateJob(job.id, "sent");
  } catch (error) {
    console.error("WhatsApp notification worker error", error);
    if (job?.id) {
      const attempts = Number(job.attempts || 0);
      const retry = attempts < 3;
      const retryDelayMs = Math.min(15 * 60_000, 15_000 * (2 ** Math.max(0, attempts - 1)));
      await updateJob(job.id, retry ? "pending" : "failed", {
        error: String(error.message || error),
        nextAttemptAt: retry ? new Date(Date.now() + retryDelayMs) : null
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
