import crypto from "node:crypto";
import { makeWASocket, initAuthCreds, BufferJSON, proto, DisconnectReason, Browsers } from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import { pool, query } from "../db/pool.js";
import { createStudentPortalAccessToken, hashStudentPortalAccessToken } from "./auth.js";
import { recordWhatsAppConnectionNotification } from "./notifications.js";
import { auditLog } from "./audit.js";

const normalizeTeacherDisplayName = (value) => String(value ?? "").replace(/مستر أحمد عبدربه/g, "Mr. Ahmed Abdrabo");

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
const DEFAULT_ABSENCE_TEMPLATES = Object.freeze([
  "تنبيه غياب - منصة مستر أحمد عبدربه\nلم يتم تسجيل حضور الطالب {student_name} في مجموعة {group_name} بتاريخ {date}.\nبرجاء التواصل مع إدارة المنصة.",
  "إشعار غياب الطالب {student_name}\nنحيط حضرتكم علماً بعدم تسجيل حضور الطالب في حصة {group_name} بتاريخ {date}.",
  "متابعة الحضور | {student_name}\nتم إغلاق جلسة {group_name} بتاريخ {date} دون تسجيل حضور الطالب."
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

// التعديل السحري: فصل الجلسة بين اللوكال وسيرفر الإنتاج عشان يمنع الطرد والتهنيج
const WHATSAPP_AUTH_SESSION_ID = process.env.NODE_ENV === "production" ? "primary" : "local_dev";

const QR_RENDER_TIMEOUT_MS = 5000;
// WhatsApp can take several seconds to return the first QR reference, especially
// after a server restart. Keep the request open long enough for the socket to
// finish negotiating, while leaving room under the API request timeout.
const QR_WAIT_TIMEOUT_MS = 25000;
const CONNECTION_STALL_TIMEOUT_MS = 45000;
const CONNECTION_HEALTHCHECK_INTERVAL_MS = 30000;
const MAX_RECONNECT_DELAY_MS = 30000;
const WHATSAPP_OWNER_ID = String(process.env.WHATSAPP_OWNER_ID || `${process.pid}-${crypto.randomUUID()}`).slice(0, 128);
const WHATSAPP_OWNER_LEASE_KEY = WHATSAPP_AUTH_SESSION_ID;
const WHATSAPP_OWNER_LEASE_MS = 4 * 60_000;
const WHATSAPP_OWNER_RENEWAL_INTERVAL_MS = 30_000;
const WHATSAPP_OWNER_RETRY_MIN_MS = 5_000;
const WHATSAPP_OWNER_RETRY_MAX_MS = 15_000;
const WHATSAPP_SEND_SLOT_KEY = WHATSAPP_AUTH_SESSION_ID;
const JOB_LEASE_MS = 4 * 60_000;
const JOB_LEASE_RENEWAL_CHUNK_MS = 30_000;
const JOB_PROVIDER_TIMEOUT_MS = 45_000;
const GRADE_PORTAL_PREVIEW_MARKER = "[secure-link-generated-at-send]";
const RETRY_REASON_MAX_LENGTH = 500;
const state = {
  status: "disconnected",
  phoneNumber: null,
  qr: null,
  socket: null,
  connecting: null,
  reconnectTimer: null,
  manuallyDisconnected: false,
  workerTimer: null,
  workerRecoveryTimer: null,
  workerRecoveryRunning: false,
  workerRunning: false,
  lastSentAt: 0,
  connectionEstablished: false,
  qrGeneration: 0,
  reconnectAttempt: 0,
  connectionWatchdog: null,
  connectionHealthcheckClosing: false,
  whatsappOwnerToken: null,
  whatsappOwnershipRetryTimer: null,
  whatsappOwnerRenewalTimer: null,
  whatsappOwnerRenewalRetryTimer: null,
  whatsappOwnerLeaseExpiryTimer: null,
  whatsappOwnerRenewalFailures: 0,
  confirmedWhatsAppLeaseExpiresAt: null,
  ownsWhatsAppSession: false,
  whatsappOwnershipPromise: null,
  whatsappOwnershipLostPromise: null,
};

let authWriteTail = Promise.resolve();

function serializedAuthValue(value) {
  return JSON.parse(JSON.stringify(value, BufferJSON.replacer));
}

function parsedAuthValue(value) {
  return JSON.parse(JSON.stringify(value), BufferJSON.reviver);
}

function withAuthWriteLock(operation) {
  const next = authWriteTail.then(operation, operation);
  authWriteTail = next.catch(() => undefined);
  return next;
}

async function writeAuthRows(rows) {
  return withAuthWriteLock(async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await assertWhatsAppOwnershipOnClient(client);
      for (const row of rows) {
        if (row.deleted) {
          await client.query(
            "DELETE FROM whatsapp_auth_state WHERE session_id = $1 AND key_id = $2",
            [WHATSAPP_AUTH_SESSION_ID, row.keyId]
          );
        } else {
          await client.query(
            `INSERT INTO whatsapp_auth_state (session_id, key_id, key_data, updated_at)
             VALUES ($1, $2, $3::jsonb, NOW())
             ON CONFLICT (session_id, key_id) DO UPDATE SET key_data = EXCLUDED.key_data, updated_at = NOW()`,
            [WHATSAPP_AUTH_SESSION_ID, row.keyId, JSON.stringify(serializedAuthValue(row.value))]
          );
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (error?.code === "whatsapp_ownership_lost") await handleWhatsAppOwnershipLost("credential_write_rejected");
      throw error;
    } finally {
      client.release();
    }
  });
}

async function clearWhatsAppAuthState() {
  return withAuthWriteLock(async () => {
    await query("DELETE FROM whatsapp_auth_state WHERE session_id = $1", [WHATSAPP_AUTH_SESSION_ID]);
  });
}

async function hasWhatsAppAuthState() {
  const result = await query(
    "SELECT 1 FROM whatsapp_auth_state WHERE session_id = $1 AND key_id = 'creds' LIMIT 1",
    [WHATSAPP_AUTH_SESSION_ID]
  );
  return result.rowCount > 0;
}

async function usePostgresAuthState() {
  const storedCreds = await query(
    "SELECT key_data FROM whatsapp_auth_state WHERE session_id = $1 AND key_id = 'creds' LIMIT 1",
    [WHATSAPP_AUTH_SESSION_ID]
  );
  const creds = storedCreds.rows[0]?.key_data ? parsedAuthValue(storedCreds.rows[0].key_data) : initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          if (!ids.length) return {};
          const keyIds = ids.map((id) => `${type}-${id}`);
          const result = await query(
            "SELECT key_id, key_data FROM whatsapp_auth_state WHERE session_id = $1 AND key_id = ANY($2::text[])",
            [WHATSAPP_AUTH_SESSION_ID, keyIds]
          );
          const stored = new Map(result.rows.map((row) => [row.key_id, row.key_data]));
          const data = {};
          for (const id of ids) {
            const value = stored.get(`${type}-${id}`);
            if (value == null) {
              data[id] = null;
              continue;
            }
            const parsed = parsedAuthValue(value);
            data[id] = type === "app-state-sync-key"
              ? proto.Message.AppStateSyncKeyData.fromObject(parsed)
              : parsed;
          }
          return data;
        },
        set: async (data) => {
          const rows = [];
          for (const [type, values] of Object.entries(data || {})) {
            for (const [id, value] of Object.entries(values || {})) {
              rows.push({ keyId: `${type}-${id}`, value, deleted: value == null });
            }
          }
          if (rows.length) await writeAuthRows(rows);
        }
      }
    },
    saveCreds: async () => writeAuthRows([{ keyId: "creds", value: creds, deleted: false }])
  };
}

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
    const templates = Array.isArray(value) ? value.map((template) => normalizeTeacherDisplayName(String(template ?? "").trim())).filter(Boolean).slice(0, 4) : [];
    return templates.length >= 3 && templates.every((template) => templateHasPlaceholder(template, requiredPlaceholder)) ? templates : fallback.map(normalizeTeacherDisplayName);
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
    await client.query(`
      INSERT INTO whatsapp_templates (category, message_body, is_active)
      SELECT source.category, item.value, TRUE
      FROM (VALUES
        ('attendance', $1::jsonb), ('grade', $2::jsonb), ('receipt', $3::jsonb), ('advance_payment', $4::jsonb)
      ) AS source(category, template_values)
      CROSS JOIN LATERAL jsonb_array_elements_text(source.template_values) AS item(value)
      ON CONFLICT (category, message_body) DO UPDATE SET is_active = TRUE, updated_at = NOW()
    `, [JSON.stringify(settings.templates), JSON.stringify(settings.grade_templates), JSON.stringify(settings.receipt_templates), JSON.stringify(settings.advance_payment_templates)]);
    for (const [category, templates] of [["attendance", settings.templates], ["grade", settings.grade_templates], ["receipt", settings.receipt_templates], ["advance_payment", settings.advance_payment_templates]]) {
      await client.query(`UPDATE whatsapp_templates SET is_active = EXISTS (SELECT 1 FROM jsonb_array_elements_text($2::jsonb) item WHERE item.value = message_body), updated_at = NOW() WHERE category = $1`, [category, JSON.stringify(templates)]);
    }
    if (audit && JSON.stringify(before) !== JSON.stringify(settings)) {
      await audit({ db: client, action: "whatsapp_settings_updated", actorId, details: { previous: before, next: settings }, request });
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
  if (state.connectionWatchdog) clearTimeout(state.connectionWatchdog);
  if (state.connectionWatchdog) clearInterval(state.connectionWatchdog);
  state.connectionWatchdog = null;
  state.connectionHealthcheckClosing = false;
  state.status = "disconnected";
  state.phoneNumber = null;
  state.qr = null;
  state.socket = null;
  state.qrGeneration += 1;
}

function scheduleReconnect() {
  if (state.manuallyDisconnected || state.reconnectTimer || state.connecting) return;
  const delay = Math.min(3000 * (2 ** state.reconnectAttempt), MAX_RECONNECT_DELAY_MS);
  state.reconnectAttempt = Math.min(state.reconnectAttempt + 1, 4);
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    void connectWhatsApp();
  }, delay);
}

function withTimeout(promise, timeoutMs, errorCode) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(errorCode)), timeoutMs);
    Promise.resolve(promise).then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function hasUsableSocket(socket) {
  return Boolean(socket && socket.ws?.isOpen !== false);
}

async function closeStaleSocket(socket, reason = "whatsapp_stale_socket") {
  if (!socket) return;
  try {
    await Promise.resolve().then(() => socket.end(new Error(reason)));
  } catch (error) {
    console.warn("Failed to close stale WhatsApp socket", safeWorkerError(error));
  }
}

function clearWhatsAppOwnershipRetry() {
  if (state.whatsappOwnershipRetryTimer) clearTimeout(state.whatsappOwnershipRetryTimer);
  state.whatsappOwnershipRetryTimer = null;
}

function clearWhatsAppOwnershipRenewalRetry() {
  if (state.whatsappOwnerRenewalRetryTimer) clearTimeout(state.whatsappOwnerRenewalRetryTimer);
  state.whatsappOwnerRenewalRetryTimer = null;
}

function scheduleConfirmedLeaseExpiryGuard() {
  if (state.whatsappOwnerLeaseExpiryTimer) clearTimeout(state.whatsappOwnerLeaseExpiryTimer);
  state.whatsappOwnerLeaseExpiryTimer = null;
  if (!Number.isFinite(state.confirmedWhatsAppLeaseExpiresAt)) return;
  const delay = Math.max(0, state.confirmedWhatsAppLeaseExpiresAt - Date.now());
  state.whatsappOwnerLeaseExpiryTimer = setTimeout(() => {
    state.whatsappOwnerLeaseExpiryTimer = null;
    if (!isLocallyWithinConfirmedLease()) void handleWhatsAppOwnershipLost("whatsapp_ownership_lease_expired");
  }, delay);
}

function isLocallyWithinConfirmedLease(now = Date.now()) {
  return Number.isFinite(state.confirmedWhatsAppLeaseExpiresAt)
    && state.confirmedWhatsAppLeaseExpiresAt > now;
}

export { isLocallyWithinConfirmedLease };

function scheduleWhatsAppOwnershipRetry(force = false) {
  if (state.manuallyDisconnected || state.whatsappOwnershipRetryTimer || (!force && state.ownsWhatsAppSession)) return;
  const delay = WHATSAPP_OWNER_RETRY_MIN_MS + randomInteger(0, WHATSAPP_OWNER_RETRY_MAX_MS - WHATSAPP_OWNER_RETRY_MIN_MS);
  state.whatsappOwnershipRetryTimer = setTimeout(() => {
    state.whatsappOwnershipRetryTimer = null;
    if (state.manuallyDisconnected) return;
    void acquireWhatsAppOwnership()
      .then(async (acquired) => {
        if (!acquired) {
          scheduleWhatsAppOwnershipRetry(true);
          return;
        }
        if (await hasWhatsAppAuthState()) await connectWhatsApp();
      })
      .catch((error) => {
        console.error("WhatsApp ownership retry failed", safeWorkerError(error));
        scheduleWhatsAppOwnershipRetry(true);
      });
  }, delay);
}

function startWhatsAppOwnerRenewal() {
  if (state.whatsappOwnerRenewalTimer) clearInterval(state.whatsappOwnerRenewalTimer);
  state.whatsappOwnerRenewalTimer = setInterval(() => {
    void renewWhatsAppOwnership().catch((error) => {
      console.error("WhatsApp ownership renewal failed", safeWorkerError(error));
    });
  }, WHATSAPP_OWNER_RENEWAL_INTERVAL_MS);
}

async function acquireWhatsAppOwnership() {
  if (state.whatsappOwnershipPromise) return state.whatsappOwnershipPromise;
  state.whatsappOwnershipPromise = acquireWhatsAppOwnershipOnce();
  try {
    return await state.whatsappOwnershipPromise;
  } finally {
    state.whatsappOwnershipPromise = null;
  }
}

async function acquireWhatsAppOwnershipOnce() {
  const canRenewCurrentLease = state.whatsappOwnerToken && isLocallyWithinConfirmedLease();
  if (state.ownsWhatsAppSession && !canRenewCurrentLease) {
    await handleWhatsAppOwnershipLost("confirmed_lease_expired");
  }
  const ownerToken = canRenewCurrentLease ? state.whatsappOwnerToken : crypto.randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `INSERT INTO whatsapp_session_leases
         (session_key, owner_id, owner_token, lease_expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, NOW() + ($4 * INTERVAL '1 millisecond'), NOW(), NOW())
       ON CONFLICT (session_key) DO UPDATE
       SET owner_id = EXCLUDED.owner_id,
           owner_token = EXCLUDED.owner_token,
           lease_expires_at = EXCLUDED.lease_expires_at,
           updated_at = NOW()
       WHERE whatsapp_session_leases.lease_expires_at <= NOW()
          OR (whatsapp_session_leases.owner_id = EXCLUDED.owner_id
              AND whatsapp_session_leases.owner_token = EXCLUDED.owner_token)
       RETURNING owner_id, owner_token, lease_expires_at`,
      [WHATSAPP_OWNER_LEASE_KEY, WHATSAPP_OWNER_ID, ownerToken, WHATSAPP_OWNER_LEASE_MS]
    );
    await client.query("COMMIT");
    if (!result.rowCount) {
      const wasLocalOwner = state.ownsWhatsAppSession || Boolean(state.socket);
      state.ownsWhatsAppSession = false;
      state.confirmedWhatsAppLeaseExpiresAt = null;
      if (wasLocalOwner) await handleWhatsAppOwnershipLost("whatsapp_ownership_taken_over");
      scheduleWhatsAppOwnershipRetry();
      return false;
    }
    state.whatsappOwnerToken = ownerToken;
    state.ownsWhatsAppSession = true;
    state.confirmedWhatsAppLeaseExpiresAt = new Date(result.rows[0].lease_expires_at).getTime();
    scheduleConfirmedLeaseExpiryGuard();
    state.whatsappOwnerRenewalFailures = 0;
    clearWhatsAppOwnershipRenewalRetry();
    state.manuallyDisconnected = false;
    clearWhatsAppOwnershipRetry();
    startWhatsAppOwnerRenewal();
    return true;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function handleWhatsAppOwnershipLost(reason = "whatsapp_ownership_lost") {
  if (state.whatsappOwnershipLostPromise) return state.whatsappOwnershipLostPromise;
  state.whatsappOwnershipLostPromise = (async () => {
    state.ownsWhatsAppSession = false;
    state.manuallyDisconnected = true;
    if (state.whatsappOwnerRenewalTimer) clearInterval(state.whatsappOwnerRenewalTimer);
    state.whatsappOwnerRenewalTimer = null;
    if (state.whatsappOwnerLeaseExpiryTimer) clearTimeout(state.whatsappOwnerLeaseExpiryTimer);
    state.whatsappOwnerLeaseExpiryTimer = null;
    clearWhatsAppOwnershipRenewalRetry();
    state.whatsappOwnerToken = null;
    state.confirmedWhatsAppLeaseExpiresAt = null;
    const socket = state.socket;
    state.socket = null;
    state.connectionEstablished = false;
    setDisconnected();
    if (socket) await closeStaleSocket(socket, reason);
    state.manuallyDisconnected = false;
    scheduleWhatsAppOwnershipRetry();
  })();
  try {
    await state.whatsappOwnershipLostPromise;
  } finally {
    state.whatsappOwnershipLostPromise = null;
  }
}

async function renewWhatsAppOwnership() {
  if (!state.ownsWhatsAppSession || !state.whatsappOwnerToken) return false;
  try {
    const result = await query(
      `UPDATE whatsapp_session_leases
       SET lease_expires_at = NOW() + ($4 * INTERVAL '1 millisecond'), updated_at = NOW()
       WHERE session_key = $1 AND owner_id = $2 AND owner_token = $3 AND lease_expires_at > NOW()
       RETURNING lease_expires_at`,
      [WHATSAPP_OWNER_LEASE_KEY, WHATSAPP_OWNER_ID, state.whatsappOwnerToken, WHATSAPP_OWNER_LEASE_MS]
    );
    if (result.rowCount) {
      state.confirmedWhatsAppLeaseExpiresAt = new Date(result.rows[0].lease_expires_at).getTime();
      scheduleConfirmedLeaseExpiryGuard();
      state.whatsappOwnerRenewalFailures = 0;
      clearWhatsAppOwnershipRenewalRetry();
      return true;
    }
    await handleWhatsAppOwnershipLost("whatsapp_ownership_lost");
    return false;
  } catch (error) {
    state.whatsappOwnerRenewalFailures = Math.min(state.whatsappOwnerRenewalFailures + 1, 4);
    if (isLocallyWithinConfirmedLease()) {
      const delay = Math.min(
        WHATSAPP_OWNER_RETRY_MAX_MS,
        WHATSAPP_OWNER_RETRY_MIN_MS * (2 ** Math.max(0, state.whatsappOwnerRenewalFailures - 1))
      );
      if (!state.whatsappOwnerRenewalRetryTimer) {
        state.whatsappOwnerRenewalRetryTimer = setTimeout(() => {
          state.whatsappOwnerRenewalRetryTimer = null;
          void renewWhatsAppOwnership().catch((retryError) => {
            console.error("WhatsApp ownership renewal retry failed", safeWorkerError(retryError));
          });
        }, delay);
      }
    } else {
      await handleWhatsAppOwnershipLost("whatsapp_ownership_lease_expired");
    }
    throw error;
  }
}

async function verifyWhatsAppOwnership() {
  if (!state.whatsappOwnerToken) return false;
  try {
    const result = await query(
      `SELECT lease_expires_at
       FROM whatsapp_session_leases
       WHERE session_key = $1 AND owner_id = $2 AND owner_token = $3 AND lease_expires_at > NOW()
       LIMIT 1`,
      [WHATSAPP_OWNER_LEASE_KEY, WHATSAPP_OWNER_ID, state.whatsappOwnerToken]
    );
    if (!result.rowCount) {
      await handleWhatsAppOwnershipLost("whatsapp_ownership_lost");
      return false;
    }
    state.confirmedWhatsAppLeaseExpiresAt = new Date(result.rows[0].lease_expires_at).getTime();
    scheduleConfirmedLeaseExpiryGuard();
    return isLocallyWithinConfirmedLease();
  } catch (error) {
    if (!isLocallyWithinConfirmedLease()) await handleWhatsAppOwnershipLost("whatsapp_ownership_lease_expired");
    throw error;
  }
}

export { verifyWhatsAppOwnership };

async function assertWhatsAppOwnershipOnClient(client) {
  const result = await client.query(
    `SELECT lease_expires_at
     FROM whatsapp_session_leases
     WHERE session_key = $1 AND owner_id = $2 AND owner_token = $3 AND lease_expires_at > NOW()
     FOR UPDATE`,
    [WHATSAPP_OWNER_LEASE_KEY, WHATSAPP_OWNER_ID, state.whatsappOwnerToken]
  );
  if (!result.rowCount) {
    const error = new Error("whatsapp_ownership_lost");
    error.code = "whatsapp_ownership_lost";
    throw error;
  }
  state.confirmedWhatsAppLeaseExpiresAt = new Date(result.rows[0].lease_expires_at).getTime();
  scheduleConfirmedLeaseExpiryGuard();
  return true;
}

async function releaseWhatsAppOwnership() {
  const ownerToken = state.whatsappOwnerToken;
  if (!ownerToken) return;
  await query(
    `UPDATE whatsapp_session_leases
     SET lease_expires_at = NOW(), updated_at = NOW()
     WHERE session_key = $1 AND owner_id = $2 AND owner_token = $3`,
    [WHATSAPP_OWNER_LEASE_KEY, WHATSAPP_OWNER_ID, ownerToken]
  );
  state.ownsWhatsAppSession = false;
  state.whatsappOwnerToken = null;
  state.confirmedWhatsAppLeaseExpiresAt = null;
  if (state.whatsappOwnerRenewalTimer) clearInterval(state.whatsappOwnerRenewalTimer);
  state.whatsappOwnerRenewalTimer = null;
  clearWhatsAppOwnershipRenewalRetry();
  if (state.whatsappOwnerLeaseExpiryTimer) clearTimeout(state.whatsappOwnerLeaseExpiryTimer);
  state.whatsappOwnerLeaseExpiryTimer = null;
}

function armConnectionWatchdog(socket) {
  if (state.connectionWatchdog) clearTimeout(state.connectionWatchdog);
  state.connectionWatchdog = setTimeout(() => {
    if (state.socket !== socket || state.status === "connected" || state.manuallyDisconnected) return;
    console.warn("WhatsApp connection stalled; closing the socket so it can reconnect safely");
    void Promise.resolve(socket.end(new Error("whatsapp_connection_timeout"))).catch((error) => {
      console.error("Failed to close stalled WhatsApp socket", safeWorkerError(error));
    });
  }, CONNECTION_STALL_TIMEOUT_MS);
}

function armConnectedWatchdog(socket) {
  if (state.connectionWatchdog) clearTimeout(state.connectionWatchdog);
  if (state.connectionWatchdog) clearInterval(state.connectionWatchdog);
  const watchdog = setInterval(() => {
    if (state.socket !== socket || state.status !== "connected" || state.manuallyDisconnected) {
      clearInterval(watchdog);
      if (state.connectionWatchdog === watchdog) state.connectionWatchdog = null;
      return;
    }

    if (socket.ws?.isOpen === false && !state.connectionHealthcheckClosing) {
      state.connectionHealthcheckClosing = true;
      console.warn("WhatsApp health check found a closed WebSocket; reconnecting");
      void Promise.resolve(socket.end(new Error("whatsapp_healthcheck_failed"))).catch((error) => {
        console.error("Failed to close unhealthy WhatsApp socket", safeWorkerError(error));
      }).finally(() => { state.connectionHealthcheckClosing = false; });
    }
  }, CONNECTION_HEALTHCHECK_INTERVAL_MS);
  state.connectionWatchdog = watchdog;
}

export async function connectWhatsApp() {
  state.manuallyDisconnected = false;
  try {
    if (!await acquireWhatsAppOwnership()) return getWhatsAppStatus();
  } catch (error) {
    scheduleWhatsAppOwnershipRetry();
    throw error;
  }
  if (state.status === "connected" && hasUsableSocket(state.socket)) return getWhatsAppStatus();
  if (state.status === "connected" && state.socket) {
    const staleSocket = state.socket;
    setDisconnected();
    await closeStaleSocket(staleSocket);
  }
  if (state.status === "connecting" && state.socket) return getWhatsAppStatus();
  if (state.connecting) await state.connecting.catch(() => undefined);
  state.status = "connecting";
  state.connecting = (async () => {
    const { state: authState, saveCreds } = await usePostgresAuthState();
    // Auth state loading performs database reads. Re-check immediately before
    // creating the socket so a lease that expired while loading cannot open a
    // stale Baileys connection.
    if (!(await renewWhatsAppOwnership()) || !(await verifyWhatsAppOwnership())) {
      await handleWhatsAppOwnershipLost("whatsapp_ownership_unverified_before_socket");
      return getWhatsAppStatus();
    }
    const socket = makeWASocket({
      auth: authState,
      browser: Browsers.ubuntu("Abdrabo Attendance"),
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
      qrTimeout: 60000,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      fireInitQueries: true,
      generateHighQualityLinkPreview: false,
      getMessage: async () => undefined
    });
    state.socket = socket;
    armConnectionWatchdog(socket);
    socket.ev.on("creds.update", () => {
      void saveCreds().catch((error) => {
        console.error("Failed to persist WhatsApp credentials", safeWorkerError(error));
      });
    });
    socket.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      if (state.socket !== socket) return;
      if (qr) {
        state.status = "connecting";
        state.qr = null;
        armConnectionWatchdog(socket);
        const generation = ++state.qrGeneration;
        try {
          const qrData = await withTimeout(QRCode.toDataURL(qr, { margin: 1, width: 320 }), QR_RENDER_TIMEOUT_MS, "qr_generation_timeout");
          if (state.socket === socket && state.status === "connecting" && state.qrGeneration === generation) state.qr = qrData;
        } catch (error) {
          console.error("WhatsApp QR generation failed", safeWorkerError(error));
        }
      }
      if (connection === "open") {
        let ownershipVerified = false;
        try {
          ownershipVerified = await verifyWhatsAppOwnership();
        } catch (error) {
          console.error("WhatsApp ownership could not be verified before connect", safeWorkerError(error));
        }
        if (!ownershipVerified) {
          if (state.socket === socket) {
            state.socket = null;
            state.connectionEstablished = false;
            setDisconnected();
          }
          await closeStaleSocket(socket, "whatsapp_ownership_unverified");
          scheduleWhatsAppOwnershipRetry(true);
          return;
        }
        state.status = "connected";
        state.connectionEstablished = true;
        state.connectionHealthcheckClosing = false;
        state.reconnectAttempt = 0;
        if (state.connectionWatchdog) clearTimeout(state.connectionWatchdog);
        state.connectionWatchdog = null;
        state.qrGeneration += 1;
        state.qr = null;
        state.phoneNumber = normalizeEgyptianPhone(socket.user?.id?.split(":")[0]) || socket.user?.id?.split(":")[0] || null;
        armConnectedWatchdog(socket);
        console.log("WhatsApp connected");
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
          }).then((result) => {
            if (result.failed) console.error(`WhatsApp disconnect alert email failures: ${result.failed}`);
          }).catch((error) => console.error("Failed to record WhatsApp disconnect notification", safeWorkerError(error)));
        }
        if (code === DisconnectReason.loggedOut) {
          void clearWhatsAppAuthState().catch((error) => console.error("Failed to clear logged-out WhatsApp session", safeWorkerError(error)));
        } else {
          scheduleReconnect();
        }
      }
    });
    return getWhatsAppStatus();
  })().catch((error) => {
    setDisconnected();
    scheduleReconnect();
    console.error("WhatsApp connection failed", safeWorkerError(error));
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
  const deadline = Date.now() + QR_WAIT_TIMEOUT_MS;
  while (!state.qr && state.status !== "connected" && Date.now() < deadline) await sleep(100);
  return { ...getWhatsAppStatus(), qr: state.qr };
}

export async function disconnectWhatsApp() {
  if (!state.ownsWhatsAppSession && !state.socket) return getWhatsAppStatus();
  if (!isLocallyWithinConfirmedLease()) {
    await handleWhatsAppOwnershipLost("whatsapp_disconnect_unverified");
    return getWhatsAppStatus();
  }
  const wasEstablished = state.connectionEstablished;
  const phoneNumber = state.phoneNumber;
  state.manuallyDisconnected = true;
  state.reconnectAttempt = 0;
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  try { await state.socket?.logout(); } catch (error) { console.warn("WhatsApp logout failed", safeWorkerError(error)); }
  setDisconnected();
  state.connectionEstablished = false;
  await clearWhatsAppAuthState();
  await releaseWhatsAppOwnership();
  if (wasEstablished) {
    void recordWhatsAppConnectionNotification({ status: "disconnected", reason: "manual_disconnect", phoneNumber })
      .catch((error) => console.error("Failed to record WhatsApp disconnect notification", safeWorkerError(error)));
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
  if (type === "absence") return "absence";
  return null;
}

function notificationTypeFromReference(value) {
  const reference = String(value || "").trim().toUpperCase();
  if (reference.startsWith("GRD-")) return "grade";
  if (reference.startsWith("RCT-")) return "receipt";
  if (reference.startsWith("ADV-")) return "advance_payment";
  if (reference.startsWith("ATT-")) return "attendance";
  if (reference.startsWith("ABS-")) return "absence";
  return null;
}

function notificationTypeForJob(job) {
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
    case "absence":
      return [...DEFAULT_ABSENCE_TEMPLATES];
    default:
      throw new Error("unsupported_whatsapp_notification_type");
  }
}

async function activeTemplateRows(category, db = query) {
  const result = await db(
    `SELECT id, message_body FROM whatsapp_templates
     WHERE category = $1 AND is_active = TRUE
     ORDER BY id`,
    [category]
  );
  return result.rows;
}

async function getNotificationTemplates(settings, type, db = query) {
  const category = normalizeNotificationType(type);
  const rows = await activeTemplateRows(category, db);
  if (rows.length) return rows.map((row) => String(row.message_body));
  return notificationTemplates(settings, category);
}

export function resolveSpintax(template, values = {}) {
  const expanded = String(template || "").replace(/\{([^{}|]+(?:\|[^{}|]+)+)\}/g, (_match, choices) => {
    const options = String(choices).split("|");
    return options[randomInteger(0, options.length - 1)].trim();
  });
  return applyTemplate(expanded, values);
}

export async function resolveWhatsAppTemplate({ category, values = {}, sourceId = "preview", db = query }) {
  const templates = await getNotificationTemplates({}, category, db);
  if (!templates.length) throw new Error("no_whatsapp_templates");
  const rows = await activeTemplateRows(normalizeNotificationType(category), db);
  const selected = rows.length ? rows[randomInteger(0, rows.length - 1)] : { id: 0, message_body: templates[randomInteger(0, templates.length - 1)] };
  const entropy = `${Date.now()}-${sourceId}-${crypto.randomUUID()}`;
  const uniqueHash = crypto.createHash("sha256").update(entropy).digest("hex").slice(0, 16);
  const reference = `ABS-${Date.now()}-${selected.id}-${uniqueHash}`;
  return { id: Number(selected.id), message: `${resolveSpintax(selected.message_body || selected, { ...values, ref_code: reference })}\n\nRef:${reference}`, reference };
}

function compileWhatsAppMessage(_type, template, values) {
  return resolveSpintax(template, values);
}

export function buildStudentPortalLink(studentId, _studentCode, accessToken) {
  const numericStudentId = Number(studentId);
  if (!Number.isSafeInteger(numericStudentId) || numericStudentId <= 0 || !/^[A-Za-z0-9_-]{20,64}$/.test(String(accessToken || ""))) return "";
  return `${publicAppUrl}/p/${encodeURIComponent(accessToken)}`;
}

function formatMonthLabel(value, locale) {
  const month = paymentMonthKey(value);
  if (!month) return "";
  const date = new Date(`${month}-01T12:00:00Z`);
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "Africa/Cairo" }).format(date);
}

function paymentMonthKey(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", timeZone: "Africa/Cairo" }).formatToParts(value);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    return year && month ? `${year}-${month}` : null;
  }
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?(?:$|T|\s)/) || text.match(/^(\d{4})-(\d{1,2})$/);
  if (!match) return null;
  const month = Number(match[2]);
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  return `${match[1]}-${String(month).padStart(2, "0")}`;
}

function paymentMonthTokens(value) {
  if (value == null || value === "") return [];
  if (Array.isArray(value)) return value.flatMap((item) => paymentMonthTokens(item));
  if (typeof value === "object") return paymentMonthTokens(value.month ?? value.due_month ?? value.date ?? value.value);

  const text = String(value).trim();
  if (!text) return [];
  if (text.startsWith("[") && text.endsWith("]")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return paymentMonthTokens(parsed);
    } catch (_error) {
      // Continue with delimiter parsing for malformed legacy values.
    }
  }
  const postgresArray = text.startsWith("{") && text.endsWith("}") ? text.slice(1, -1) : text;
  return postgresArray.split(/[,;\n]/).map((item) => item.trim().replace(/^"|"$/g, "")).filter(Boolean);
}

function cairoCurrentMonthKey() {
  return paymentMonthKey(new Date()) || "1970-01";
}

export function paymentMonthsValue(paymentMonths, ...fallbackDates) {
  const months = paymentMonthTokens(paymentMonths)
    .map((value) => paymentMonthKey(value))
    .filter(Boolean);
  const uniqueMonths = [...new Set(months)];
  if (!uniqueMonths.length) {
    const fallbackMonth = fallbackDates.map((value) => paymentMonthKey(value)).find(Boolean);
    uniqueMonths.push(fallbackMonth || cairoCurrentMonthKey());
  }
  return uniqueMonths.join(", ");
}

export function formatWhatsAppMonthList(value, locale, ...fallbackDates) {
  return paymentMonthsValue(value, ...fallbackDates)
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

async function createPortalAccessRecord(studentId, accessToken, db = query) {
  await db(
    `INSERT INTO student_portal_access_tokens (token_hash, student_id, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '1 hour')
     ON CONFLICT (token_hash) DO NOTHING`,
    [hashStudentPortalAccessToken(accessToken), studentId]
  );
}

function portalTokenFromLink(value) {
  return String(value || "").match(/\/p\/([A-Za-z0-9_-]{20,64})(?:[?#]|$)/)?.[1] || null;
}

async function removePortalAccessRecord(accessToken) {
  if (!accessToken) return;
  await query("DELETE FROM student_portal_access_tokens WHERE token_hash = $1", [hashStudentPortalAccessToken(accessToken)]);
}

async function cleanupJobPortalAccess(job, extraToken = null) {
  const tokens = [portalTokenFromLink(job?.payload?.portal_link), extraToken].filter(Boolean);
  for (const token of tokens) await removePortalAccessRecord(token).catch(() => undefined);
}

async function scrubClaimedGradePortalLink(job) {
  const token = portalTokenFromLink(job?.payload?.portal_link);
  if (token) await removePortalAccessRecord(token);
  const payload = { ...(job?.payload && typeof job.payload === "object" ? job.payload : {}), portal_link: GRADE_PORTAL_PREVIEW_MARKER };
  const result = await query(
    `UPDATE whatsapp_notification_jobs
     SET payload = $2::jsonb, updated_at = NOW()
     WHERE id = $1 AND status = 'processing' AND claim_token = $3
     RETURNING id`,
    [job.id, JSON.stringify(payload), job.claim_token]
  );
  if (!result.rowCount) return false;
  job.payload = payload;
  return true;
}

async function scrubGradePortalLinkInTransaction(client, job) {
  const token = portalTokenFromLink(job?.payload?.portal_link);
  if (token) {
    await client.query("DELETE FROM student_portal_access_tokens WHERE token_hash = $1", [hashStudentPortalAccessToken(token)]);
  }
  const payload = { ...(job?.payload && typeof job.payload === "object" ? job.payload : {}) };
  payload.portal_link = GRADE_PORTAL_PREVIEW_MARKER;
  await client.query(
    `UPDATE whatsapp_notification_jobs
     SET payload = $2::jsonb, rendered_message = $3, updated_at = NOW()
     WHERE id = $1`,
    [job.id, JSON.stringify(payload), redactPortalLink(job.rendered_message)]
  );
}

export function gradeQueuePreviewPayload(payload = {}) {
  return { ...(payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {}), portal_link: GRADE_PORTAL_PREVIEW_MARKER };
}

export function absenceCorrectionTransition(status, sendStartedAt) {
  if (status !== "pending" && status !== "processing") return null;
  const providerStarted = status === "processing" && Boolean(sendStartedAt);
  return {
    status: providerStarted ? "delivery_unknown" : "skipped",
    lastError: providerStarted ? "attendance_correction_during_send" : "attendance_corrected_before_send"
  };
}

export async function settleAbsenceNotificationJobsForCorrection({ client, attendanceRecordId, reason = "attendance_corrected", actorId = null, studentId = null, sessionId = null, request = null }) {
  const baseReason = reason === "attendance_excused" ? "attendance_excused" : "attendance_corrected";
  const result = await client.query(
    `UPDATE whatsapp_notification_jobs
     SET status = CASE
           WHEN status = 'processing' AND send_started_at IS NOT NULL THEN 'delivery_unknown'
           ELSE 'skipped'
         END,
         last_error = CASE
           WHEN status = 'processing' AND send_started_at IS NOT NULL THEN $2
           ELSE $3
         END,
         next_attempt_at = NULL,
         lease_expires_at = NULL,
         claim_token = NULL,
         updated_at = NOW()
     WHERE notification_type = 'absence' AND attendance_record_id = $1
       AND status IN ('pending', 'processing')
     RETURNING id, status, send_started_at`,
    [attendanceRecordId, `${baseReason}_during_send`, `${baseReason}_before_send`]
  );
  for (const job of result.rows) {
    await auditLog({
      db: client,
      action: job.status === "delivery_unknown" ? "whatsapp_job_delivery_unknown" : "whatsapp_job_skipped",
      actorId,
      studentId,
      sessionId,
      details: {
        job_id: job.id,
        notification_type: "absence",
        source_id: attendanceRecordId,
        reason: job.status === "delivery_unknown" ? `${baseReason}_during_send` : `${baseReason}_before_send`,
        send_started: job.status === "delivery_unknown"
      },
      request
    });
  }
  return result.rows;
}

async function reserveWhatsAppSendSlot(settings) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO whatsapp_send_slots (session_key, next_available_at)
       VALUES ($1, NULL) ON CONFLICT (session_key) DO NOTHING`,
      [WHATSAPP_SEND_SLOT_KEY]
    );
    const current = await client.query(
      "SELECT next_available_at FROM whatsapp_send_slots WHERE session_key = $1 FOR UPDATE",
      [WHATSAPP_SEND_SLOT_KEY]
    );
    const now = Date.now();
    const availableAt = current.rows[0]?.next_available_at ? new Date(current.rows[0].next_available_at).getTime() : now;
    const waitMs = Math.max(0, availableAt - now);
    const delayMs = randomInteger(settings.min_delay_seconds, settings.max_delay_seconds) * 1000;
    const nextAvailableAt = new Date(Math.max(now, availableAt) + delayMs);
    await client.query(
      "UPDATE whatsapp_send_slots SET next_available_at = $2, updated_at = NOW() WHERE session_key = $1",
      [WHATSAPP_SEND_SLOT_KEY, nextAvailableAt]
    );
    await client.query("COMMIT");
    return waitMs;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function enqueueGradeBatchNotifications({ resultIds }) {
  const normalizedIds = [...new Set((resultIds || []).map((value) => Number(value)).filter((value) => Number.isSafeInteger(value) && value > 0))];
  if (!normalizedIds.length) return { queuedCount: 0, ignoredCount: 0, ignored: [], queuedResultIds: [], errors: [] };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const hydrated = await client.query(`
      SELECT er.id AS result_id, er.score, e.title AS exam_title, e.max_score, e.exam_date,
        s.id AS student_id, s.full_name AS student_name, s.student_code, s.guardian_phone,
        s.whatsapp_opted_out, s.is_active, s.deleted_at
      FROM exam_results er
      JOIN exams e ON e.id = er.exam_id
      JOIN students s ON s.id = er.student_id
      WHERE er.id = ANY($1::int[]) AND s.is_active = TRUE AND s.deleted_at IS NULL
      ORDER BY array_position($1::int[], er.id)`, [normalizedIds]);

    const rowsById = new Map(hydrated.rows.map((row) => [Number(row.result_id), row]));
    const ignored = [];
    const candidates = [];
    for (const resultId of normalizedIds) {
      const row = rowsById.get(resultId);
      if (!row) {
        ignored.push({ resultId, reason: "not_found" });
        continue;
      }
      if (row.whatsapp_opted_out === true) {
        ignored.push({ resultId, reason: "opted_out", studentName: row.student_name });
        continue;
      }
      const phone = normalizeEgyptianPhone(row.guardian_phone);
      if (!phone) {
        ignored.push({ resultId, reason: "invalid_phone", studentName: row.student_name });
        continue;
      }
      candidates.push({ row, phone });
    }

    if (!candidates.length) {
      await client.query("COMMIT");
      return { queuedCount: 0, ignoredCount: ignored.length, ignored, queuedResultIds: [], errors: [] };
    }

    const existing = await client.query(`
      SELECT id, source_id, status, payload, rendered_message
      FROM whatsapp_notification_jobs
      WHERE notification_type = 'grade'
        AND source_id = ANY($1::bigint[])
        AND status IN ('pending', 'processing')`, [candidates.map(({ row }) => Number(row.result_id))]);
    for (const oldJob of existing.rows) {
      if (oldJob.status === "pending") await scrubGradePortalLinkInTransaction(client, oldJob);
    }
    const activeSourceIds = new Set(existing.rows.map((row) => Number(row.source_id)));
    const pendingCandidates = candidates.filter(({ row }) => {
      const resultId = Number(row.result_id);
      if (!activeSourceIds.has(resultId)) return true;
      ignored.push({ resultId, reason: "already_queued", studentName: row.student_name });
      return false;
    });

    if (!pendingCandidates.length) {
      await client.query("COMMIT");
      return { queuedCount: 0, ignoredCount: ignored.length, ignored, queuedResultIds: [], errors: [] };
    }

    const settings = await getWhatsAppSettings(client.query.bind(client));
    const templates = (await getNotificationTemplates(settings, "grade", client.query.bind(client))).filter(Boolean);
    await client.query(
      `INSERT INTO whatsapp_template_rotation (notification_type, next_index)
       VALUES ('grade', 0) ON CONFLICT (notification_type) DO NOTHING`
    );
    const rotation = await client.query(
      `SELECT next_index FROM whatsapp_template_rotation
       WHERE notification_type = 'grade' FOR UPDATE`
    );
    const firstTemplateIndex = Number(rotation.rows[0]?.next_index || 0) % templates.length;
    await client.query(
      `UPDATE whatsapp_template_rotation
       SET next_index = (next_index + $1) % $2, updated_at = NOW()
       WHERE notification_type = 'grade'`,
      [pendingCandidates.length, templates.length]
    );

    const queueRows = pendingCandidates.map(({ row, phone }, offset) => {
      const templateIndex = (firstTemplateIndex + offset) % templates.length;
      const template = templates[templateIndex];
      const maxScore = Number(row.max_score);
      const score = Number(row.score);
      const percentage = maxScore > 0 ? ((score / maxScore) * 100).toFixed(1).replace(/\.0$/, "") : "0";
      const payload = gradeQueuePreviewPayload({
        type: "grade",
        student_name: row.student_name,
        student_code: row.student_code,
        exam_title: row.exam_title,
        score,
        max_score: maxScore,
        percentage,
        event_time: row.exam_date
      });
      const parts = cairoParts(row.exam_date);
      const locale = /[\u0600-\u06ff]/i.test(template) ? "ar-EG" : "en-US";
      const refCode = notificationRefCode("GRD", row.exam_date, row.result_id, true);
      const templateValues = { ...payload, ...parts, ref_code: refCode };
      templateValues.ref_code = refCode;
      const renderedBody = compileWhatsAppMessage("grade", template, templateValues).trim();
      const finalBody = `${renderedBody}\n\n${locale === "ar-EG" ? "— Mr. Ahmed Abdrabo Platform" : "— Abdrabo Attendance Platform"}`;
      return {
        resultId: Number(row.result_id),
        studentId: Number(row.student_id),
        phoneNumber: phone,
        payload,
        refCode,
        templateIndex,
        template,
        renderedMessage: redactPortalLink(finalBody)
      };
    });

    const inserted = await client.query(`
      INSERT INTO whatsapp_notification_jobs
        (notification_type, source_id, student_id, phone_number, payload, ref_code, status,
         template_index, template_text, rendered_message, next_attempt_at, created_at, updated_at)
      SELECT 'grade', row.source_id, row.student_id, row.phone_number, row.payload, row.ref_code, 'pending',
        row.template_index, row.template_text, row.rendered_message, NOW(), NOW(), NOW()
      FROM jsonb_to_recordset($1::jsonb) AS row(
        source_id bigint, student_id integer, phone_number text, payload jsonb, ref_code text,
        template_index integer, template_text text, rendered_message text
      )
      ON CONFLICT DO NOTHING
      RETURNING source_id`, [JSON.stringify(queueRows.map((row) => ({
        source_id: row.resultId,
        student_id: row.studentId,
        phone_number: row.phoneNumber,
        payload: row.payload,
        ref_code: row.refCode,
        template_index: row.templateIndex,
        template_text: row.template,
        rendered_message: row.renderedMessage
      })))]);

    const queuedResultIds = inserted.rows.map((row) => Number(row.source_id));
    const queuedSet = new Set(queuedResultIds);
    for (const row of queueRows) {
      if (!queuedSet.has(row.resultId)) ignored.push({ resultId: row.resultId, reason: "queue_conflict" });
    }
    if (queuedResultIds.length) {
      await client.query("UPDATE exam_results SET whatsapp_notified = FALSE WHERE id = ANY($1::int[])", [queuedResultIds]);
    }
    await client.query("COMMIT");
    if (queuedResultIds.length) wakeWhatsAppWorker();
    return { queuedCount: queuedResultIds.length, ignoredCount: ignored.length, ignored, queuedResultIds, errors: [] };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function enqueueGradeNotificationInTransaction(client, { resultId }) {
  const hydrated = await client.query(`
    SELECT er.id AS result_id, er.score, er.note, e.title AS exam_title,
      e.max_score, e.exam_date, s.id AS student_id, s.full_name AS student_name,
      s.student_code, s.guardian_phone, s.whatsapp_opted_out, s.is_active, s.deleted_at
    FROM exam_results er
    JOIN exams e ON e.id = er.exam_id
    JOIN students s ON s.id = er.student_id
    WHERE er.id = $1
    FOR UPDATE`, [resultId]);
  const row = hydrated.rows[0];
  if (!row) return { queued: false, reason: "not_found" };
  if (!row.is_active || row.deleted_at) return { queued: false, reason: "student_inactive" };
  if (row.whatsapp_opted_out === true) return { queued: false, reason: "whatsapp_opted_out" };
  const normalizedPhone = normalizeEgyptianPhone(row.guardian_phone);
  if (!normalizedPhone) return { queued: false, reason: "invalid_phone" };

  const active = await client.query(`
    SELECT id, status, ref_code, payload, rendered_message
    FROM whatsapp_notification_jobs
    WHERE notification_type = 'grade' AND source_id = $1
      AND status IN ('pending', 'processing')
    ORDER BY id DESC
    LIMIT 1
    FOR UPDATE`, [resultId]);
  if (active.rows[0]?.status === "processing") {
    return { queued: false, reason: "already_queued", job_id: active.rows[0].id, status: active.rows[0].status, ref_code: active.rows[0].ref_code };
  }
  if (active.rows[0]) await scrubGradePortalLinkInTransaction(client, active.rows[0]);

  const settings = await getWhatsAppSettings(client.query.bind(client));
  const templates = (await getNotificationTemplates(settings, "grade", client.query.bind(client))).filter(Boolean);
  if (!templates.length) throw new Error("no_whatsapp_templates");
  await client.query(`
    INSERT INTO whatsapp_template_rotation (notification_type, next_index)
    VALUES ('grade', 0)
    ON CONFLICT (notification_type) DO NOTHING`);
  const rotation = await client.query(`
    SELECT next_index FROM whatsapp_template_rotation
    WHERE notification_type = 'grade'
    FOR UPDATE`);
  const templateIndex = Number(rotation.rows[0]?.next_index || 0) % templates.length;
  await client.query(`
    UPDATE whatsapp_template_rotation
    SET next_index = (next_index + 1) % $1, updated_at = NOW()
    WHERE notification_type = 'grade'`, [templates.length]);

  const template = templates[templateIndex];
  const rawPhone = String(row.guardian_phone || "").trim();
  const phone = normalizedPhone;
  const maxScore = Number(row.max_score);
  const score = Number(row.score);
  const percentage = gradePercentage(score, maxScore);
  const refCode = notificationRefCode("GRD", row.exam_date, row.result_id, true);
  const payload = gradeQueuePreviewPayload({
    type: "grade",
    student_name: row.student_name,
    student_code: row.student_code,
    exam_title: row.exam_title,
    exam_date: row.exam_date,
    score,
    max_score: maxScore,
    percentage,
    evaluation_text: row.note || "",
    assessment: row.note || "",
    guardian_phone: rawPhone,
    parent_contact: { guardian_phone: rawPhone, whatsapp_phone: phone || null },
    whatsapp_opted_out: row.whatsapp_opted_out === true,
    event_time: row.exam_date
  });
  const parts = cairoParts(row.exam_date);
  const locale = /[\u0600-\u06ff]/i.test(template) ? "ar-EG" : "en-US";
  const templateValues = { ...payload, ...parts, ref_code: refCode };
  const renderedBody = compileWhatsAppMessage("grade", template, templateValues).trim();
  const finalBody = `${renderedBody}\n\n${locale === "ar-EG" ? "— Mr. Ahmed Abdrabo Platform" : "— Abdrabo Attendance Platform"}`;
  const values = [
    row.student_id,
    phone,
    JSON.stringify(payload),
    refCode,
    templateIndex,
    template,
    redactPortalLink(finalBody)
  ];
  let job;
  if (active.rows[0]) {
    job = await client.query(`
      UPDATE whatsapp_notification_jobs
      SET student_id = $2, phone_number = $3, payload = $4::jsonb,
        ref_code = $5, status = 'pending', attempts = 0, last_error = NULL,
        template_index = $6, template_text = $7, rendered_message = $8,
        next_attempt_at = NOW(), sent_at = NULL, updated_at = NOW()
      WHERE id = $1
      RETURNING id, status, ref_code`, [active.rows[0].id, ...values]);
  } else {
    job = await client.query(`
      INSERT INTO whatsapp_notification_jobs
        (notification_type, source_id, student_id, phone_number, payload, ref_code,
         status, template_index, template_text, rendered_message, next_attempt_at)
      VALUES ('grade', $1, $2, $3, $4::jsonb, $5, 'pending', $6, $7, $8, NOW())
      RETURNING id, status, ref_code`, [row.result_id, ...values]);
  }
  await client.query("UPDATE exam_results SET whatsapp_notified = FALSE WHERE id = $1", [row.result_id]);
  return { queued: true, job_id: job.rows[0].id, status: job.rows[0].status, ref_code: job.rows[0].ref_code, result_id: row.result_id };
}

export async function retryWhatsAppNotificationJob({ jobId, actorId = null, reason = "", allowDeliveryUnknown = false, request = null }) {
  const normalizedReason = normalizeManualRetryReason(reason);
  if (!normalizedReason.ok) return normalizedReason;
  const retryReason = normalizedReason.value;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query(`
      SELECT *
      FROM whatsapp_notification_jobs
      WHERE id = $1
      FOR UPDATE`, [jobId]);
    if (!current.rowCount) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "not_found" };
    }
    const job = current.rows[0];
    if (job.status === "delivery_unknown" && !allowDeliveryUnknown) {
      await client.query("COMMIT");
      return { ok: false, reason: "delivery_unknown_requires_confirmation", job_id: job.id, status: job.status, ref_code: job.ref_code };
    }
    if (job.status !== "failed" && job.status !== "delivery_unknown") {
      await client.query("COMMIT");
      return { ok: true, reason: "already_active", status: job.status, job_id: job.id, ref_code: job.ref_code };
    }
    const type = notificationTypeForJob(job);
    if (!type) {
      await client.query("COMMIT");
      return { ok: false, reason: "unsupported_whatsapp_notification_type", job_id: job.id, status: job.status };
    }
    const eligibility = await revalidateWhatsAppJob(job, type, client.query.bind(client));
    if (!eligibility.ok) {
      await client.query("COMMIT");
      return { ok: false, reason: eligibility.reason, job_id: job.id, status: job.status, ref_code: job.ref_code };
    }
    const retried = await client.query(`
      UPDATE whatsapp_notification_jobs
      SET status = 'pending', attempts = 0, last_error = NULL,
        next_attempt_at = NOW(), sent_at = NULL, claim_token = NULL,
        send_started_at = NULL, template_index = NULL, template_text = NULL,
        rendered_message = NULL, updated_at = NOW()
      WHERE id = $1 AND status IN ('failed', 'delivery_unknown')
      RETURNING id, status, ref_code`, [jobId]);
    await auditLog({
      db: client,
      action: "whatsapp_job_manual_retry_requested",
      actorId,
      details: {
        job_id: job.id,
        notification_type: type,
        source_id: job.source_id,
        reason: retryReason,
        confirmed_delivery_unknown: Boolean(job.status === "delivery_unknown" && allowDeliveryUnknown)
      },
      request
    });
    await client.query("COMMIT");
    wakeWhatsAppWorker();
    return { ok: true, retried: true, notification_type: type, ...retried.rows[0] };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function retryGradeNotificationJob(options = {}) {
  return retryWhatsAppNotificationJob(options);
}

function notificationRefCode(prefix, dateValue, id, unique = false) {
  const date = new Date(dateValue || Date.now()).toISOString().slice(0, 10).replaceAll("-", "");
  return `${prefix}-${date}-${id}${unique ? `-${Date.now()}-${randomInteger(100, 999)}` : ""}`;
}

async function enqueueJob({ notificationType, sourceId, studentId, phone, payload, refCode, attendanceRecordId = null, db = query, wake = true, dedupeCompleted = false }) {
  const execute = typeof db === "function" ? db : db.query.bind(db);
  const queuedPayload = { ...(payload || {}), type: notificationType };
  const existing = await execute(
    `SELECT id, status, ref_code
     FROM whatsapp_notification_jobs
     WHERE notification_type = $1 AND source_id = $2
     ORDER BY id DESC
     LIMIT 1`,
    [notificationType, sourceId]
  );
  const previous = existing.rows[0];
  if (previous?.status === "pending" || previous?.status === "processing") {
    return { queued: false, reason: "already_queued", job_id: previous.id, status: previous.status, ref_code: previous.ref_code };
  }
  if (dedupeCompleted && (previous?.status === "sent" || previous?.status === "skipped")) {
    return { queued: false, reason: previous.status === "sent" ? "already_sent" : "already_processed", job_id: previous.id, status: previous.status, ref_code: previous.ref_code };
  }
  if (previous?.status === "delivery_unknown") {
    return { queued: false, reason: "delivery_unknown_requires_confirmation", job_id: previous.id, status: previous.status, ref_code: previous.ref_code };
  }
  if (previous?.status === "failed") {
    const retried = await execute(
      `UPDATE whatsapp_notification_jobs
       SET student_id = $2, phone_number = $3, payload = $4::jsonb, ref_code = $5,
           status = 'pending', attempts = 0, last_error = NULL, template_index = NULL,
           template_text = NULL, rendered_message = NULL, next_attempt_at = NOW(),
           sent_at = NULL, updated_at = NOW()
       WHERE id = $1 AND status = 'failed'
       RETURNING id, status, ref_code`,
      [previous.id, studentId, phone, JSON.stringify(queuedPayload), refCode]
    );
    if (retried.rowCount) {
      if (wake) wakeWhatsAppWorker();
      return { queued: true, retried: true, job_id: retried.rows[0].id, status: retried.rows[0].status, ref_code: retried.rows[0].ref_code };
    }
  }
  const inserted = await execute(`
    INSERT INTO whatsapp_notification_jobs (notification_type, source_id, attendance_record_id, student_id, phone_number, payload, ref_code)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
    ON CONFLICT DO NOTHING
    RETURNING id, status, ref_code`, [
    notificationType, sourceId, attendanceRecordId, studentId, phone, JSON.stringify(queuedPayload), refCode
  ]);
  if (inserted.rowCount) {
    if (wake) wakeWhatsAppWorker();
    return { queued: true, job_id: inserted.rows[0].id, status: inserted.rows[0].status, ref_code: inserted.rows[0].ref_code };
  }
  const conflicting = await execute(
    `SELECT id, status, ref_code
     FROM whatsapp_notification_jobs
     WHERE notification_type = $1 AND source_id = $2 AND status IN ('pending', 'processing')
     ORDER BY id DESC
     LIMIT 1`,
    [notificationType, sourceId]
  );
  if (conflicting.rowCount) {
    return { queued: false, reason: "already_queued", job_id: conflicting.rows[0].id, status: conflicting.rows[0].status, ref_code: conflicting.rows[0].ref_code };
  }
  return { queued: false, reason: "queue_conflict" };
}

export async function enqueueAttendanceNotification({ attendanceRecordId, studentId }) {
  return enqueueAttendanceNotificationWithDb({ attendanceRecordId, studentId });
}

async function enqueueAttendanceNotificationWithDb({ attendanceRecordId, studentId, db = query, wake = true }) {
  const execute = typeof db === "function" ? db : db.query.bind(db);
  const settings = await getWhatsAppSettings(execute);
  if (!settings.auto_send) return { queued: false, reason: "disabled" };
  const result = await execute(`
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
  const queue = await enqueueJob({
    notificationType: "attendance",
    sourceId: row.attendance_record_id,
    attendanceRecordId: row.attendance_record_id,
    studentId: row.student_id,
    phone,
    payload: { student_name: row.student_name, student_code: row.student_code, group_name: row.group_name, checkin_time: row.checkin_time },
    refCode,
    db: execute,
    wake,
    dedupeCompleted: true
  });
  return { ...queue, ref_code: queue.ref_code || refCode };
}

export async function enqueueAttendanceNotificationInTransaction(client, { attendanceRecordId, studentId }) {
  return enqueueAttendanceNotificationWithDb({ attendanceRecordId, studentId, db: client.query.bind(client), wake: false });
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
  await query("UPDATE exam_results SET whatsapp_notified = FALSE WHERE id = $1", [row.result_id]);
  const queue = await enqueueJob({ notificationType: "grade", sourceId: row.result_id, studentId: row.student_id, phone, refCode, payload: {
    student_name: row.student_name, student_code: row.student_code, exam_title: row.exam_title,
    score, max_score: maxScore, percentage, event_time: row.exam_date
  } });
  return { ...queue, ref_code: queue.ref_code || refCode };
}

async function enqueuePaymentNotificationWithDb({ paymentId, paymentType, notificationType, referencePrefix, db = query, wake = true }) {
  const execute = typeof db === "function" ? db : db.query.bind(db);
  const result = await execute(`
    SELECT p.id AS payment_id, p.amount, p.paid_amount, p.discount_amount, p.is_exempt, p.payment_reference,
      p.payment_months, p.payment_date, p.paid_at,
      s.id AS student_id, s.full_name AS student_name, s.student_code, s.guardian_phone
    FROM payments p
    JOIN students s ON s.id = p.student_id
    WHERE p.id = $1 AND p.payment_type = $2 AND s.is_active = TRUE AND s.deleted_at IS NULL AND s.whatsapp_opted_out = FALSE`, [paymentId, paymentType]);
  const row = result.rows[0];
  if (!row) return { queued: false, reason: "not_found" };
  const phone = normalizeEgyptianPhone(row.guardian_phone);
  if (!phone) return { queued: false, reason: "invalid_phone" };
  const month = paymentMonthsValue(row.payment_months, row.payment_date, row.paid_at);
  const refCode = notificationRefCode(referencePrefix, row.payment_date, row.payment_id, true);
  const queue = await enqueueJob({ notificationType, sourceId: row.payment_id, studentId: row.student_id, phone, refCode, dedupeCompleted: true, db: execute, wake, payload: {
    student_name: row.student_name, student_code: row.student_code, amount_paid: Number(row.paid_amount ?? row.amount).toFixed(2),
    discount_amount: Number(row.discount_amount || 0).toFixed(2), is_exempt: row.is_exempt === true,
    payment_status: row.is_exempt ? "exempt" : Number(row.discount_amount || 0) > 0 ? "discounted" : "paid",
    month, months: month, receipt_number: row.payment_reference || refCode, event_time: row.paid_at || row.payment_date
  } });
  return { ...queue, ref_code: queue.ref_code || refCode };
}

export async function enqueueReceiptNotification({ paymentId }) {
  return enqueuePaymentNotificationWithDb({ paymentId, paymentType: "normal", notificationType: "receipt", referencePrefix: "RCT" });
}

export async function enqueueReceiptNotificationInTransaction(client, { paymentId }) {
  return enqueuePaymentNotificationWithDb({ paymentId, paymentType: "normal", notificationType: "receipt", referencePrefix: "RCT", db: client.query.bind(client), wake: false });
}

export async function enqueueAdvancePaymentNotification({ paymentId }) {
  return enqueuePaymentNotificationWithDb({ paymentId, paymentType: "advance", notificationType: "advance_payment", referencePrefix: "ADV" });
}

export async function enqueueAdvancePaymentNotificationInTransaction(client, { paymentId }) {
  return enqueuePaymentNotificationWithDb({ paymentId, paymentType: "advance", notificationType: "advance_payment", referencePrefix: "ADV", db: client.query.bind(client), wake: false });
}

async function claimNextJob(dbClient = null) {
  const client = dbClient || await pool.connect();
  const ownsClient = !dbClient;
  try {
    await client.query("BEGIN");
    // Rely on row-level SKIP LOCKED; session advisory locks are unsafe through pooled connections.
    const result = await client.query(`SELECT * FROM whatsapp_notification_jobs
      WHERE status = 'pending' AND next_attempt_at <= NOW()
      ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`);
    if (!result.rowCount) { await client.query("COMMIT"); return null; }
    const claimToken = crypto.randomUUID();
    const updated = await client.query(`UPDATE whatsapp_notification_jobs
      SET status = 'processing', attempts = attempts + 1,
          lease_expires_at = NOW() + ($2 * INTERVAL '1 millisecond'),
          claim_token = $3, send_started_at = NULL, updated_at = NOW()
      WHERE id = $1 AND status = 'pending' RETURNING *`, [result.rows[0].id, JOB_LEASE_MS, claimToken]);
    if (!updated.rowCount) { await client.query("COMMIT"); return null; }
    await client.query("COMMIT");
    return updated.rows[0];
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { if (ownsClient) client.release(); }
}

async function updateJob(id, status, fields = {}, claimToken) {
  if (!claimToken) return false;
  const result = await query(`UPDATE whatsapp_notification_jobs SET status = $2, last_error = $3,
    next_attempt_at = COALESCE($4, next_attempt_at), sent_at = CASE WHEN $2 = 'sent' THEN NOW() ELSE sent_at END,
    lease_expires_at = CASE WHEN $2 = 'processing' THEN lease_expires_at ELSE NULL END,
    phone_number = COALESCE($5, phone_number), provider_message_id = COALESCE($6, provider_message_id),
    provider_accepted_at = CASE WHEN $6 IS NOT NULL THEN COALESCE(provider_accepted_at, NOW()) ELSE provider_accepted_at END,
    claim_token = NULL,
    send_started_at = CASE WHEN $2 IN ('pending', 'failed', 'skipped') THEN NULL ELSE send_started_at END,
    updated_at = NOW()
    WHERE id = $1 AND status = 'processing' AND claim_token = $7
    RETURNING id`, [id, status, fields.error || null, fields.nextAttemptAt || null, fields.phoneNumber || null, fields.providerMessageId || null, claimToken]);
  return result.rowCount > 0;
}

async function extendJobLease(job, phase) {
  if (!job?.id || !job.claim_token) return false;
  const result = await query(
    `UPDATE whatsapp_notification_jobs
     SET lease_expires_at = NOW() + ($3 * INTERVAL '1 millisecond'), updated_at = NOW()
     WHERE id = $1 AND status = 'processing' AND claim_token = $2
     RETURNING lease_expires_at`,
    [job.id, job.claim_token, JOB_LEASE_MS]
  );
  if (!result.rowCount) return false;
  await auditWhatsAppJob(job, "whatsapp_job_lease_extended", { phase }).catch(() => undefined);
  return true;
}

async function markSendStarted(job) {
  const result = await query(
    `UPDATE whatsapp_notification_jobs
     SET send_started_at = NOW(), lease_expires_at = NOW() + ($3 * INTERVAL '1 millisecond'), updated_at = NOW()
     WHERE id = $1 AND status = 'processing' AND claim_token = $2
     RETURNING id`,
    [job.id, job.claim_token, JOB_LEASE_MS]
  );
  return result.rowCount > 0;
}

async function completeSentJob(job, providerMessageId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const completed = await client.query(
      `UPDATE whatsapp_notification_jobs
       SET status = 'sent', sent_at = NOW(), last_error = NULL,
           lease_expires_at = NULL, claim_token = NULL,
           provider_message_id = COALESCE($3, provider_message_id),
           provider_accepted_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'processing' AND claim_token = $2
       RETURNING id`,
      [job.id, job.claim_token, providerMessageId || null]
    );
    if (completed.rowCount && notificationTypeForJob(job) === "grade") {
      await client.query(
        `UPDATE exam_results er
         SET whatsapp_notified = TRUE
         WHERE er.id = $1 AND EXISTS (
           SELECT 1 FROM whatsapp_notification_jobs j
           WHERE j.id = $2 AND j.notification_type = 'grade'
             AND j.source_id = er.id AND j.status = 'sent'
         )`,
        [job.source_id, job.id]
      );
    }
    await client.query("COMMIT");
    return completed.rowCount > 0;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function auditWhatsAppJob(job, action, details = {}) {
  await auditLog({
    action,
    details: {
      job_id: job?.id || null,
      notification_type: notificationTypeForJob(job || {}),
      source_id: job?.source_id || null,
      attempts: Number(job?.attempts || 0),
      ...details
    }
  });
}

function gradePercentage(score, maxScore) {
  const numericScore = Number(score);
  const numericMaxScore = Number(maxScore);
  if (!Number.isFinite(numericScore) || !Number.isFinite(numericMaxScore) || numericMaxScore <= 0) return "0";
  return ((numericScore / numericMaxScore) * 100).toFixed(1).replace(/\.0$/, "");
}

async function revalidateWhatsAppJob(job, type, db = query) {
  const execute = typeof db === "function" ? db : db.query.bind(db);
  if (!job?.student_id) return { ok: false, reason: "student_missing" };
  const studentResult = await execute(`
    SELECT id, full_name, student_code, guardian_phone, is_active, deleted_at, whatsapp_opted_out
    FROM students WHERE id = $1`, [job.student_id]);
  const student = studentResult.rows[0];
  if (!student || !student.is_active || student.deleted_at) return { ok: false, reason: "student_inactive" };
  if (student.whatsapp_opted_out) return { ok: false, reason: "whatsapp_opted_out" };
  const phone = normalizeEgyptianPhone(student.guardian_phone);
  if (!phone) return { ok: false, reason: "invalid_phone" };

  const originalPayload = job.payload && typeof job.payload === "object" && !Array.isArray(job.payload) ? job.payload : {};
  let payload = { ...originalPayload, student_name: student.full_name, student_code: student.student_code };
  if (type === "attendance") {
    const source = await execute(`
      SELECT ar.checkin_time, ats.session_date,
        COALESCE(NULLIF(TRIM(g.display_name), ''), NULLIF(TRIM(g.name), ''), '') AS group_name
      FROM attendance_records ar
      JOIN attendance_sessions ats ON ats.id = ar.session_id
      JOIN groups g ON g.id = ats.group_id
      WHERE ar.id = $1 AND ar.student_id = $2 AND ar.status IN ('present', 'late')`, [job.attendance_record_id || job.source_id, student.id]);
    if (!source.rowCount) return { ok: false, reason: "attendance_no_longer_eligible" };
    payload = { ...payload, group_name: source.rows[0].group_name, checkin_time: source.rows[0].checkin_time, event_time: source.rows[0].checkin_time || source.rows[0].session_date };
  } else if (type === "absence") {
    const source = await execute(`
      SELECT ar.status, ats.status AS session_status, ats.session_date, ats.id AS session_id,
        COALESCE(NULLIF(TRIM(g.display_name), ''), NULLIF(TRIM(g.name), ''), '') AS group_name
      FROM attendance_records ar
      JOIN attendance_sessions ats ON ats.id = ar.session_id
      JOIN groups g ON g.id = ats.group_id
      WHERE ar.id = $1 AND ar.student_id = $2`, [job.attendance_record_id || job.source_id, student.id]);
    if (source.rows[0]?.status === "excused") return { ok: false, reason: "attendance_excused" };
    if (!source.rowCount || source.rows[0].status !== "absent" || source.rows[0].session_status !== "closed") return { ok: false, reason: "absence_no_longer_eligible" };
    payload = { ...payload, group_name: source.rows[0].group_name, session_id: source.rows[0].session_id, event_time: source.rows[0].session_date };
  } else if (type === "grade") {
    const source = await execute(`
      SELECT er.score, er.note, e.title AS exam_title, e.max_score, e.exam_date
      FROM exam_results er JOIN exams e ON e.id = er.exam_id
      WHERE er.id = $1 AND er.student_id = $2`, [job.source_id, student.id]);
    if (!source.rowCount) return { ok: false, reason: "grade_no_longer_exists" };
    const grade = source.rows[0];
    const score = Number(grade.score);
    const maxScore = Number(grade.max_score);
    payload = {
      ...payload,
      exam_title: grade.exam_title,
      exam_date: grade.exam_date,
      event_time: grade.exam_date,
      score,
      max_score: maxScore,
      percentage: gradePercentage(score, maxScore),
      evaluation_text: grade.note || "",
      assessment: grade.note || ""
    };
  } else if (type === "receipt" || type === "advance_payment") {
    const source = await execute(`
      SELECT amount, paid_amount, discount_amount, is_exempt, payment_reference,
        payment_months, payment_date, paid_at, payment_type
      FROM payments WHERE id = $1 AND student_id = $2 AND payment_type = $3`,
      [job.source_id, student.id, type === "receipt" ? "normal" : "advance"]
    );
    if (!source.rowCount) return { ok: false, reason: "payment_no_longer_exists" };
    const payment = source.rows[0];
    const months = paymentMonthsValue(payment.payment_months, payment.payment_date, payment.paid_at);
    payload = {
      ...payload,
      amount_paid: Number(payment.paid_amount ?? payment.amount).toFixed(2),
      discount_amount: Number(payment.discount_amount || 0).toFixed(2),
      is_exempt: payment.is_exempt === true,
      payment_status: payment.is_exempt ? "exempt" : Number(payment.discount_amount || 0) > 0 ? "discounted" : "paid",
      month: months,
      months,
      receipt_number: payment.payment_reference || job.ref_code,
      event_time: payment.paid_at || payment.payment_date
    };
  }

  if (normalizeEgyptianPhone(job.phone_number) !== phone) {
    await execute("UPDATE whatsapp_notification_jobs SET phone_number = $2, updated_at = NOW() WHERE id = $1 AND status = 'processing' AND claim_token = $3", [job.id, phone, job.claim_token || null]);
    job.phone_number = phone;
  }
  return { ok: true, phone, student, payload };
}

async function recoverStaleWhatsAppJobs() {
  if (state.workerRecoveryRunning) return;
  state.workerRecoveryRunning = true;
  try {
    const result = await query(`UPDATE whatsapp_notification_jobs
      SET status = CASE WHEN send_started_at IS NOT NULL THEN 'delivery_unknown' ELSE 'pending' END,
          next_attempt_at = CASE WHEN send_started_at IS NOT NULL THEN next_attempt_at ELSE NOW() END,
          last_error = CASE WHEN send_started_at IS NOT NULL THEN 'delivery_unknown' ELSE 'worker_lease_expired' END,
          lease_expires_at = NULL, claim_token = NULL, updated_at = NOW()
      WHERE status = 'processing'
        AND (lease_expires_at <= NOW()
          OR (lease_expires_at IS NULL AND updated_at < NOW() - INTERVAL '5 minutes'))
      RETURNING id, notification_type, source_id, attempts, status`);
    for (const job of result.rows) {
      await auditWhatsAppJob(job, job.status === "delivery_unknown" ? "whatsapp_job_delivery_unknown" : "whatsapp_job_expired_claim_recovered", {
        reason: job.status === "delivery_unknown" ? "send_was_in_flight" : "lease_expired"
      });
    }
  } finally {
    state.workerRecoveryRunning = false;
  }
}

async function auditStaleClaim(job, phase) {
  await auditWhatsAppJob(job, "whatsapp_job_stale_claim_rejected", { phase }).catch(() => undefined);
}

async function waitWithJobLease(job, waitMs) {
  let remaining = Math.max(0, Number(waitMs) || 0);
  while (remaining > 0) {
    if (!state.ownsWhatsAppSession || !(await extendJobLease(job, "send_slot_wait"))) return false;
    const chunk = Math.min(remaining, JOB_LEASE_RENEWAL_CHUNK_MS);
    await sleep(chunk);
    remaining -= chunk;
  }
  return extendJobLease(job, "after_send_slot_wait");
}

function safeWorkerError(error) {
  const code = String(error?.code || error?.message || "whatsapp_worker_error");
  return /^[A-Za-z0-9_.-]{1,80}$/.test(code) ? code : "whatsapp_worker_error";
}

export function normalizeManualRetryReason(value) {
  const reason = String(value || "").trim();
  if (reason.length < 3) return { ok: false, reason: "retry_reason_required" };
  if (reason.length > RETRY_REASON_MAX_LENGTH) return { ok: false, reason: "retry_reason_too_long" };
  return { ok: true, value: reason };
}

async function markDeliveryUnknown(job, reason, providerMessageId = null) {
  const updated = await updateJob(job.id, "delivery_unknown", {
    error: "delivery_unknown",
    nextAttemptAt: null,
    providerMessageId
  }, job.claim_token);
  if (updated) {
    await auditWhatsAppJob(job, "whatsapp_job_delivery_unknown", { reason }).catch(() => undefined);
  } else {
    await auditStaleClaim(job, "delivery_unknown");
  }
  return updated;
}

async function processWhatsAppJob() {
  if (!state.ownsWhatsAppSession) return;
  if (state.workerRunning) return;
  state.workerRunning = true;
  let job = null;
  let portalAccessToken = null;
  let providerAccepted = false;
  let providerMessageId = null;
  try {
    job = await claimNextJob();
    if (!job) return;
    await auditWhatsAppJob(job, "whatsapp_job_claimed", { lease_expires_at: job.lease_expires_at }).catch(() => undefined);
    const settings = await getWhatsAppSettings();
    const type = notificationTypeForJob(job);
    if (!type) {
      const updated = await updateJob(job.id, "skipped", { error: "unsupported_whatsapp_notification_type" }, job.claim_token);
      if (updated) await auditWhatsAppJob(job, "whatsapp_job_skipped", { reason: "unsupported_whatsapp_notification_type" });
      else await auditStaleClaim(job, "unsupported_type");
      return;
    }
    if (!settings.auto_send && (type === "attendance" || type === "absence")) {
      const updated = await updateJob(job.id, "skipped", { error: "auto_send_disabled" }, job.claim_token);
      if (updated) await auditWhatsAppJob(job, "whatsapp_job_skipped", { reason: "auto_send_disabled" });
      else await auditStaleClaim(job, "auto_send_disabled");
      return;
    }
    if (state.status !== "connected" || !state.socket) {
      const attempts = Number(job.attempts || 0);
      const retry = attempts < 3;
      const updated = await updateJob(job.id, retry ? "pending" : "failed", {
        error: "whatsapp_disconnected",
        nextAttemptAt: retry ? new Date(Date.now() + 10_000) : null
      }, job.claim_token);
      if (updated) await auditWhatsAppJob(job, retry ? "whatsapp_job_retry_scheduled" : "whatsapp_job_failed", { reason: "whatsapp_disconnected" });
      else await auditStaleClaim(job, "whatsapp_disconnected");
      return;
    }

    const waitMs = await reserveWhatsAppSendSlot(settings);
    if (!(await waitWithJobLease(job, waitMs))) {
      await auditStaleClaim(job, "send_slot_wait");
      return;
    }
    let eligibility = await revalidateWhatsAppJob(job, type);
    if (!eligibility.ok) {
      const updated = await updateJob(job.id, "skipped", { error: eligibility.reason, nextAttemptAt: null }, job.claim_token);
      if (updated) {
        await cleanupJobPortalAccess(job, portalAccessToken);
        await auditWhatsAppJob(job, "whatsapp_job_skipped", { reason: eligibility.reason });
      } else await auditStaleClaim(job, "initial_revalidation");
      return;
    }
    if (type === "grade" && !(await scrubClaimedGradePortalLink(job))) {
      await auditStaleClaim(job, "grade_portal_link_scrub");
      return;
    }
    const templates = (await getNotificationTemplates(settings, type)).filter(Boolean);
    if (!templates.length) {
      const updated = await updateJob(job.id, "failed", { error: "no_whatsapp_templates", nextAttemptAt: null }, job.claim_token);
      if (updated) {
        await cleanupJobPortalAccess(job);
        await auditWhatsAppJob(job, "whatsapp_job_failed", { reason: "no_whatsapp_templates" });
      } else await auditStaleClaim(job, "no_templates");
      return;
    }
    const persistedTemplateIndex = Number(job.template_index);
    const hasPersistedTemplate = Number.isInteger(persistedTemplateIndex) && persistedTemplateIndex >= 0 && persistedTemplateIndex < templates.length && String(job.template_text || "").trim();
    const { index: templateIndex, template } = hasPersistedTemplate
      ? { index: persistedTemplateIndex, template: String(job.template_text) }
      : await chooseTemplate(type, templates);

    if (!state.ownsWhatsAppSession || !(await extendJobLease(job, "before_final_revalidation"))) {
      await auditStaleClaim(job, "before_final_revalidation");
      return;
    }
    eligibility = await revalidateWhatsAppJob(job, type);
    if (!eligibility.ok) {
      const updated = await updateJob(job.id, "skipped", { error: eligibility.reason, nextAttemptAt: null }, job.claim_token);
      if (updated) {
        await cleanupJobPortalAccess(job);
        await auditWhatsAppJob(job, "whatsapp_job_skipped", { reason: eligibility.reason });
      } else await auditStaleClaim(job, "final_revalidation");
      return;
    }

    let payload = eligibility.payload || {};
    if (type === "grade") {
      if (!(await scrubClaimedGradePortalLink(job))) {
        await auditStaleClaim(job, "grade_portal_link_scrub");
        return;
      }
      payload = { ...payload, portal_link: GRADE_PORTAL_PREVIEW_MARKER };
    }
    const parts = cairoParts(payload.event_time || payload.checkin_time);
    const studentCode = String(payload.student_code || "").trim();
    const configuredPortalLink = type === "grade" ? "" : String(payload.portal_link || "").trim();
    if (type === "grade") portalAccessToken = createStudentPortalAccessToken();
    const portalLink = configuredPortalLink || buildStudentPortalLink(job.student_id, studentCode, portalAccessToken);
    const locale = /[\u0600-\u06ff]/i.test(template) ? "ar-EG" : "en-US";
    const formattedPayload = {
      ...payload,
      amount_paid: payload.amount_paid == null ? payload.amount_paid : Number(payload.amount_paid).toFixed(2),
      ...(type === "receipt" || type === "advance_payment" ? (() => {
        const monthValue = paymentMonthsValue(
          payload.payment_months ?? payload.months ?? payload.month,
          payload.payment_date,
          payload.paid_at,
          payload.event_time
        );
        const formattedMonths = formatWhatsAppMonthList(monthValue, locale);
        return { month: formattedMonths, months: formattedMonths };
      })() : {})
    };
    const templateValues = { ...formattedPayload, ...parts, ref_code: job.ref_code, student_code: studentCode, portal_link: portalLink };
    const renderedBody = compileWhatsAppMessage(type, template, templateValues).trim();
    const body = portalLink && !templateHasPlaceholder(template, "portal_link") ? `${renderedBody}\n${portalLink}` : renderedBody;
    const adjustmentLine = type === "receipt" && (payload.is_exempt === true || Number(payload.discount_amount || 0) > 0)
      ? payload.is_exempt === true
        ? (locale === "ar-EG" ? "حالة السداد: إعفاء كامل" : "Payment status: Full exemption")
        : (locale === "ar-EG" ? `الخصم المطبق: ${payload.discount_amount} ج.م` : `Discount applied: ${payload.discount_amount} EGP`)
      : "";
    const adjustedBody = adjustmentLine && !body.includes(adjustmentLine) ? `${body}\n${adjustmentLine}` : body;
    const footer = locale === "ar-EG" ? "— Mr. Ahmed Abdrabo Platform" : "— Abdrabo Attendance Platform";
    const finalBody = adjustedBody.includes(footer) ? adjustedBody : `${adjustedBody}\n\n${footer}`;
    const contentUpdated = await query(
      `UPDATE whatsapp_notification_jobs
       SET template_index = $2, template_text = $3, rendered_message = $4, updated_at = NOW()
       WHERE id = $1 AND status = 'processing' AND claim_token = $5
       RETURNING id`,
      [job.id, templateIndex, template, redactPortalLink(finalBody), job.claim_token]
    );
    if (!contentUpdated.rowCount) {
      await auditStaleClaim(job, "rendered_content");
      return;
    }
    if (!state.ownsWhatsAppSession
      || !(await extendJobLease(job, "before_provider"))
      || !(await renewWhatsAppOwnership())
      || !(await verifyWhatsAppOwnership())) {
      await auditStaleClaim(job, "before_provider");
      return;
    }
    if (!(await markSendStarted(job))) {
      await auditStaleClaim(job, "send_start");
      return;
    }
    if (type === "grade" && portalAccessToken) {
      await cleanupJobPortalAccess(job);
      await createPortalAccessRecord(job.student_id, portalAccessToken);
    }
    const messagePayload = { text: finalBody };
    console.log(`[WhatsApp] Sending TYPE: ${type}, TEMPLATE: ${templateIndex + 1}`);
    const providerResponse = await withTimeout(
      state.socket.sendMessage(`${eligibility.phone.slice(1)}@s.whatsapp.net`, messagePayload),
      JOB_PROVIDER_TIMEOUT_MS,
      "whatsapp_provider_timeout"
    );
    providerAccepted = true;
    providerMessageId = providerResponse?.key?.id || null;
    if (!state.ownsWhatsAppSession || !isLocallyWithinConfirmedLease()) throw new Error("whatsapp_ownership_lost_during_send");
    state.lastSentAt = Date.now();
    const completed = await completeSentJob(job, providerMessageId);
    if (!completed) {
      await auditStaleClaim(job, "sent_completion");
      return;
    }
    await auditWhatsAppJob(job, "whatsapp_job_accepted", { provider_message_id: providerResponse?.key?.id || null });
  } catch (error) {
    const reason = safeWorkerError(error);
    console.error("WhatsApp notification worker error", reason);
    if (job?.id) {
      const deliveryUnknown = reason === "whatsapp_provider_timeout" || reason === "whatsapp_ownership_lost_during_send" || providerAccepted;
      if (deliveryUnknown) {
        await markDeliveryUnknown(job, reason, providerMessageId);
      } else {
        await cleanupJobPortalAccess(job, portalAccessToken);
        const attempts = Number(job.attempts || 0);
        const retry = attempts < 3;
        const retryDelayMs = Math.min(15 * 60_000, 15_000 * (2 ** Math.max(0, attempts - 1)));
        const updated = await updateJob(job.id, retry ? "pending" : "failed", {
          error: reason,
          nextAttemptAt: retry ? new Date(Date.now() + retryDelayMs) : null
        }, job.claim_token);
        if (updated) await auditWhatsAppJob(job, retry ? "whatsapp_job_retry_scheduled" : "whatsapp_job_failed", { reason }).catch(() => undefined);
        else await auditStaleClaim(job, "worker_error");
      }
    }
  } finally {
    state.workerRunning = false;
  }
}

export function wakeWhatsAppWorker() {
  if (!state.workerTimer) void processWhatsAppJob();
}

export function startWhatsAppWorker() {
  if (state.workerTimer) return;
  void recoverStaleWhatsAppJobs().catch((error) => console.error("Failed to recover WhatsApp notification jobs", safeWorkerError(error)));
  state.workerRecoveryTimer = setInterval(() => {
    void recoverStaleWhatsAppJobs().catch((error) => console.error("Failed to recover WhatsApp notification jobs", safeWorkerError(error)));
  }, 60_000);
  state.workerTimer = setInterval(() => { void processWhatsAppJob(); }, 1000);
  void processWhatsAppJob();
}

export async function startWhatsAppService() {
  startWhatsAppWorker();
  try {
    if (await hasWhatsAppAuthState()) await connectWhatsApp();
  } catch (error) { console.error("WhatsApp PostgreSQL auth state could not be loaded", safeWorkerError(error)); }
}

export async function stopWhatsAppService() {
  state.manuallyDisconnected = true;
  state.reconnectAttempt = 0;
  if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
  if (state.workerTimer) clearInterval(state.workerTimer);
  if (state.workerRecoveryTimer) clearInterval(state.workerRecoveryTimer);
  state.reconnectTimer = null;
  state.workerTimer = null;
  state.workerRecoveryTimer = null;
  clearWhatsAppOwnershipRetry();

  if (state.connecting) {
    await withTimeout(state.connecting, 5000, "whatsapp_connect_shutdown_timeout")
      .catch((error) => console.warn("WhatsApp connection was still negotiating during shutdown", safeWorkerError(error)));
  }
  const socket = state.socket;
  state.connectionEstablished = false;
  setDisconnected();
  if (socket) {
    await withTimeout(closeStaleSocket(socket, "server_shutdown"), 5000, "whatsapp_shutdown_timeout")
      .catch((error) => console.warn("WhatsApp shutdown completed with socket close warning", safeWorkerError(error)));
  }
  await releaseWhatsAppOwnership().catch((error) => console.warn("WhatsApp ownership release failed", safeWorkerError(error)));
  return getWhatsAppStatus();
}
