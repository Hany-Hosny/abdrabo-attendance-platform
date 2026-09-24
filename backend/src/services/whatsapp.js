import crypto from "node:crypto";
import { makeWASocket, initAuthCreds, BufferJSON, proto, DisconnectReason, Browsers } from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import { pool, query } from "../db/pool.js";
import { createStudentPortalAccessToken, hashStudentPortalAccessToken } from "./auth.js";
import { recordWhatsAppConnectionNotification } from "./notifications.js";
import { auditLog } from "./audit.js";
import {
  WHATSAPP_TEMPLATE_CATALOG,
  WHATSAPP_TEMPLATE_PLACEHOLDERS,
  normalizeStudentGender
} from "./whatsappTemplateCatalog.js";

const normalizeTeacherDisplayName = (value) => String(value ?? "").replace(/مستر أحمد عبدربه/g, "Mr. Ahmed Abdrabo");

const DEFAULT_TEMPLATES = Object.freeze([
  "*إشعار حضور الطالب* 👨‍🏫\n\n*الطالب:* {student_name}\n*المجموعة:* {group_name}\n*التاريخ:* {date}\n*الوقت:* {time}\n*كود الطالب:* {student_code}\n\nرابط المتابعة: {portal_link}\n*المرجع:* {ref_code}\n\n— منصة مستر أحمد عبدربه",
  "*تم تسجيل الحضور بنجاح* ✅\n\nحضر الطالب *{student_name}* حصة *{group_name}*.\n*التاريخ:* {date}\n*الوقت:* {time}\n\nرابط ملف المتابعة: {portal_link}\n*المرجع:* {ref_code}",
  "*إشعار حضور*\n\nتم تسجيل حضور الطالب *{student_name}* في مجموعة *{group_name}*.\n*التاريخ:* {date} | *الوقت:* {time}\n*كود الطالب:* {student_code}\n\nتقرير المتابعة: {portal_link}\n*رقم المرجع:* {ref_code}"
]);
const DEFAULT_GRADE_TEMPLATES = Object.freeze([
  "*نتيجة التقييم* 📝\n\n*الطالب:* {student_name}\n*الامتحان:* {exam_title}\n*الدرجة:* {score} من {max_score}\n*النسبة:* {percentage}%\n*كود الطالب:* {student_code}\n\nتقرير التقييم: {portal_link}\n*المرجع:* {ref_code}\n\n— منصة مستر أحمد عبدربه",
  "*إشعار نتيجة الامتحان*\n\nحصل الطالب *{student_name}* في *{exam_title}* على *{score}/{max_score}* بنسبة *{percentage}%*.\n\nتفاصيل التقييم: {portal_link}\n*المرجع:* {ref_code}",
  "*تقييم دراسي*\n\nتم تصحيح *{exam_title}* للطالب *{student_name}*.\n*النتيجة المحققة:* {score} من {max_score}\n\nرابط التقرير الكامل: {portal_link}\n*رقم المرجع:* {ref_code}"
]);
const DEFAULT_RECEIPT_TEMPLATES = Object.freeze([
  "*إيصال سداد المصروفات* 🧾\n\n*الطالب:* {student_name}\n*المبلغ المدفوع:* {amount_paid} ج.م\n*عن شهر:* {month}\n*رقم الإيصال:* {receipt_number}\n*كود الطالب:* {student_code}\n\nعرض الإيصال ومتابعة الحساب: {portal_link}\n*المرجع:* {ref_code}\n\nشكراً لتعاونكم.",
  "*سند قبض إلكتروني*\n\nتم تسجيل دفعة مالية بنجاح.\n*الطالب:* {student_name}\n*القيمة:* {amount_paid} ج.م\n*الشهر:* {month}\n*رقم السند:* {receipt_number}\n\nالسجل المالي: {portal_link}\n*المرجع:* {ref_code}",
  "*إشعار تحصيل نقدية*\n\nتم استلام مبلغ *{amount_paid} جنيه* لمصروفات *{month}* الخاصة بالطالب *{student_name}*.\n*رقم الإيصال:* {receipt_number}\n\nمتابعة الحساب: {portal_link}\n*المرجع:* {ref_code}"
]);
const DEFAULT_ADVANCE_PAYMENT_TEMPLATES = Object.freeze([
  "*إيصال الدفع المقدم* 💳\n\n*الطالب:* {student_name}\n*المبلغ المدفوع:* {amount_paid} ج.م\n*الشهور المسددة:* {months}\n*رقم الإيصال:* {receipt_number}\n\nمتابعة الحساب: {portal_link}\n*المرجع:* {ref_code}\n\n— منصة مستر أحمد عبدربه",
  "*تم تسجيل الدفع المقدم بنجاح* ✅\n\n*الطالب:* {student_name}\n*القيمة:* {amount_paid} ج.م\n*الفترة المسددة:* {months}\n*رقم السند:* {receipt_number}\n\nرابط المتابعة: {portal_link}\n*المرجع:* {ref_code}",
  "*إيصال استلام نقدية — دفع مقدم*\n\n*الطالب:* {student_name}\n*المبلغ:* {amount_paid} جنيه\n*الشهور:* {months}\n*الإيصال:* #{receipt_number}\n\nالرابط: {portal_link}\n*المرجع:* {ref_code}"
]);
const DEFAULT_ABSENCE_TEMPLATES = Object.freeze([
  "*تنبيه غياب الطالب* ⚠️\n\n*الطالب:* {student_name}\n*المجموعة:* {group_name}\n*التاريخ:* {date}\n\nلم يتم تسجيل حضور الطالب لهذه الحصة.\nرابط المتابعة: {portal_link}\n*المرجع:* {ref_code}\n\n— منصة مستر أحمد عبدربه",
  "*إشعار غياب*\n\nنحيط حضرتكم علماً بعدم تسجيل حضور الطالب *{student_name}* في حصة *{group_name}* بتاريخ *{date}*.\n\nرابط ملف المتابعة: {portal_link}\n*المرجع:* {ref_code}",
  "*متابعة الحضور*\n\nتم إغلاق جلسة *{group_name}* بتاريخ *{date}* دون تسجيل حضور الطالب *{student_name}*.\n\nرابط المتابعة: {portal_link}\n*رقم المرجع:* {ref_code}"
]);
const DEFAULT_CANCELLATION_TEMPLATES = Object.freeze([
  "تم إلغاء حصة {group_name} بتاريخ {scheduled_date} الساعة {scheduled_time}. وقت تسجيل الإلغاء: {cancellation_time}. المرجع: {ref_code}",
  "إشعار إلغاء حصة مجموعة {group_name}. الموعد: {scheduled_date} الساعة {scheduled_time}. وقت الإلغاء: {cancellation_time}. المرجع: {ref_code}",
  "نحيطكم علماً بإلغاء حصة {group_name} يوم {scheduled_date} الساعة {scheduled_time}. تم تسجيل الإلغاء في {cancellation_time}. المرجع: {ref_code}"
]);

const DEFAULT_SETTINGS = Object.freeze({
  auto_send: false,
  attendance_notifications_enabled: true,
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

const WHATSAPP_ENABLED = !["0", "false", "no", "off"].includes(
  String(process.env.WHATSAPP_ENABLED ?? "true").trim().toLowerCase()
);
const WHATSAPP_AUTH_SESSION_ID = String(
  process.env.WHATSAPP_SESSION_ID || (process.env.NODE_ENV === "production" ? "primary" : "local_dev")
).trim() || "local_dev";

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
    attendance_notifications_enabled: row?.attendance_notifications_enabled !== false,
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
  if (input.attendance_notifications_enabled !== undefined && typeof input.attendance_notifications_enabled !== "boolean") throw new Error("invalid_attendance_notifications_enabled");
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
  return { auto_send: input.auto_send, attendance_notifications_enabled: input.attendance_notifications_enabled !== false, templates, grade_templates: gradeTemplates, receipt_templates: receiptTemplates, advance_payment_templates: advancePaymentTemplates, min_delay_seconds: min, max_delay_seconds: max };
}

export async function getWhatsAppSettings(db = query) {
  const result = await db("SELECT auto_send, attendance_notifications_enabled, templates, grade_templates, receipt_templates, advance_payment_templates, min_delay_seconds, max_delay_seconds FROM whatsapp_settings WHERE id = 1");
  return normalizeSettings(result.rows[0]);
}

export async function updateAttendanceNotificationsEnabled(enabled, { actorId = null, request = null, db = pool, audit } = {}) {
  if (typeof enabled !== "boolean") throw new Error("invalid_attendance_notifications_enabled");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const before = await getWhatsAppSettings(client.query.bind(client));
    await client.query(
      `INSERT INTO whatsapp_settings (id, attendance_notifications_enabled, updated_by, updated_at)
       VALUES (1, $1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET
         attendance_notifications_enabled = EXCLUDED.attendance_notifications_enabled,
         updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [enabled, actorId]
    );
    const after = await getWhatsAppSettings(client.query.bind(client));
    if (audit && before.attendance_notifications_enabled !== after.attendance_notifications_enabled) {
      await audit({
        db: client,
        action: "whatsapp_attendance_notifications_setting_updated",
        actorId,
        details: {
          previous: before.attendance_notifications_enabled,
          next: after.attendance_notifications_enabled
        },
        request
      });
    }
    await client.query("COMMIT");
    return after.attendance_notifications_enabled;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function updateWhatsAppSettings(input, { actorId, request = null, db = pool, audit } = {}) {
  const settings = validateWhatsAppSettings(input);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const before = await getWhatsAppSettings(client.query.bind(client));
    const attendanceNotificationsEnabled = Object.hasOwn(input, "attendance_notifications_enabled")
      ? settings.attendance_notifications_enabled
      : before.attendance_notifications_enabled;
    await client.query(
      `INSERT INTO whatsapp_settings (id, auto_send, attendance_notifications_enabled, templates, grade_templates, receipt_templates, advance_payment_templates, min_delay_seconds, max_delay_seconds, updated_by, updated_at)
       VALUES (1, $1, $2, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7, $8, $9, NOW())
       ON CONFLICT (id) DO UPDATE SET auto_send = EXCLUDED.auto_send,
         attendance_notifications_enabled = EXCLUDED.attendance_notifications_enabled, templates = EXCLUDED.templates,
         grade_templates = EXCLUDED.grade_templates, receipt_templates = EXCLUDED.receipt_templates,
         advance_payment_templates = EXCLUDED.advance_payment_templates,
         min_delay_seconds = EXCLUDED.min_delay_seconds, max_delay_seconds = EXCLUDED.max_delay_seconds,
         updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [settings.auto_send, attendanceNotificationsEnabled, JSON.stringify(settings.templates), JSON.stringify(settings.grade_templates), JSON.stringify(settings.receipt_templates), JSON.stringify(settings.advance_payment_templates), settings.min_delay_seconds, settings.max_delay_seconds, actorId || null]
    );
    await client.query(`
      INSERT INTO whatsapp_templates (category, message_body, is_active, audience, is_fallback)
      SELECT source.category, item.value, FALSE, 'neutral', FALSE
      FROM (VALUES
        ('attendance', $1::jsonb), ('grade', $2::jsonb), ('receipt', $3::jsonb), ('advance_payment', $4::jsonb)
      ) AS source(category, template_values)
      CROSS JOIN LATERAL jsonb_array_elements_text(source.template_values) AS item(value)
      WHERE NOT EXISTS (
        SELECT 1 FROM whatsapp_templates existing
        WHERE existing.category = source.category AND existing.message_body = item.value
      )
    `, [JSON.stringify(settings.templates), JSON.stringify(settings.grade_templates), JSON.stringify(settings.receipt_templates), JSON.stringify(settings.advance_payment_templates)]);
    const nextSettings = { ...settings, attendance_notifications_enabled: attendanceNotificationsEnabled };
    if (audit && JSON.stringify(before) !== JSON.stringify(nextSettings)) {
      await audit({ db: client, action: "whatsapp_settings_updated", actorId, details: { previous: before, next: nextSettings }, request });
    }
    await client.query("COMMIT");
    return { ...nextSettings, portal_base_url: publicAppUrl };
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
  if (!WHATSAPP_ENABLED) {
    state.status = "disabled";
    state.qr = null;
    return getWhatsAppStatus();
  }
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
        await query(
          `UPDATE whatsapp_notification_jobs
           SET next_attempt_at = NOW(), updated_at = NOW()
           WHERE status = 'pending' AND last_error = 'whatsapp_disconnected'`
        ).catch((error) => console.error("Failed to wake disconnected WhatsApp jobs", safeWorkerError(error)));
        wakeWhatsAppWorker();
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
  return { enabled: WHATSAPP_ENABLED, status: state.status, phone_number: state.phoneNumber, has_qr: Boolean(state.qr) };
}

export async function getWhatsAppQr() {
  if (!WHATSAPP_ENABLED) return { ...getWhatsAppStatus(), qr: null };
  if (state.status === "connected") return { ...getWhatsAppStatus(), qr: null };
  await connectWhatsApp();
  const deadline = Date.now() + QR_WAIT_TIMEOUT_MS;
  while (!state.qr && state.status !== "connected" && Date.now() < deadline) await sleep(100);
  return { ...getWhatsAppStatus(), qr: state.qr };
}

export async function disconnectWhatsApp() {
  if (!WHATSAPP_ENABLED) return getWhatsAppStatus();
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

function normalizeNotificationType(value) {
  const type = String(value || "").trim().toLowerCase();
  if (type === "grade" || type === "exam") return "grade";
  if (type === "receipt" || type === "fee") return "receipt";
  if (["advance_payment", "advance-payment", "advance"].includes(type)) return "advance_payment";
  if (type === "attendance") return "attendance";
  if (type === "absence") return "absence";
  if (type === "cancellation" || type === "cancelled_session") return "cancellation";
  if (type === "custom_message") return "custom_message";
  return null;
}

export const requiredPlaceholders = Object.freeze({
  attendance: "student_name",
  absence: "student_name",
  grade: "exam_title",
  receipt: "amount_paid",
  advance_payment: "months",
  cancellation: "group_name"
});

export function validateWhatsAppTemplate(category, messageBody) {
  const normalizedCategory = normalizeNotificationType(category);
  const source = String(messageBody ?? "");
  const allowed = WHATSAPP_TEMPLATE_PLACEHOLDERS[normalizedCategory] || [];
  const tokens = [...source.matchAll(TEMPLATE_TOKEN_PATTERN)].map((match) => normalizeTemplateKey(match[1]));
  const unknownPlaceholder = tokens.find((token) => !allowed.includes(token));
  const spintaxFree = source
    .replace(TEMPLATE_TOKEN_PATTERN, "")
    .replace(/\{([^{}|]+(?:\|[^{}|]+)+)\}/g, "$1");
  const malformed = /[{}]/.test(spintaxFree);
  const required = requiredPlaceholders[normalizedCategory] ? [requiredPlaceholders[normalizedCategory]] : [];
  const missing = required.filter((key) => !tokens.includes(key));
  const requiredPlaceholder = requiredPlaceholders[normalizedCategory];
  const hasForbiddenLiteral = /\b(undefined|null)\b|\[object Object\]/i.test(source);
  return {
    ok: Boolean(normalizedCategory && source.trim() && !unknownPlaceholder && !malformed && !hasForbiddenLiteral && !missing.length),
    requiredPlaceholder,
    missingPlaceholders: missing,
    unknownPlaceholder,
    malformed,
    hasForbiddenLiteral,
    allowedPlaceholders: allowed
  };
}

const PREVIEW_REFERENCE_PREFIXES = Object.freeze({
  attendance: "ATT",
  absence: "ABS",
  grade: "EXM",
  receipt: "REC",
  advance_payment: "ADV",
  cancellation: "CNL"
});

const DISPLAY_REFERENCE_PREFIXES = Object.freeze({
  attendance: "ATT",
  absence: "ABS",
  grade: "GRD",
  receipt: "PAY",
  advance_payment: "ADV",
  cancellation: "CAN"
});

function notificationTypeFromReference(value) {
  const reference = String(value || "").trim().toUpperCase();
  if (reference.startsWith("GRD-") || reference.startsWith("EXM-")) return "grade";
  if (reference.startsWith("RCT-") || reference.startsWith("REC-")) return "receipt";
  if (reference.startsWith("ADV-")) return "advance_payment";
  if (reference.startsWith("ATT-")) return "attendance";
  if (reference.startsWith("ABS-")) return "absence";
  if (reference.startsWith("CNL-")) return "cancellation";
  return null;
}

function notificationTypeForJob(job) {
  const referenceType = notificationTypeFromReference(job.ref_code);
  if (referenceType && referenceType !== "attendance") return referenceType;
  return normalizeNotificationType(job.payload?.type || job.type || job.notification_type) || referenceType;
}

async function activeTemplateRows(category, db = query) {
  const result = await db(
    `SELECT id, category, audience, slot_number, slot_key, is_fallback,
        content_version, message_body, is_active
     FROM whatsapp_templates
     WHERE category = $1 AND is_active = TRUE
       AND ((audience IN ('male', 'female') AND slot_number BETWEEN 1 AND 4 AND is_fallback = FALSE)
         OR (audience = 'neutral' AND is_fallback = TRUE AND slot_number IS NULL))
     ORDER BY audience, slot_number NULLS LAST, id`,
    [category]
  );
  return result.rows.filter((row) => validateWhatsAppTemplate(category, row.message_body).ok);
}

export function resolveSpintax(template, values = {}) {
  const expanded = String(template || "").replace(/\{([^{}|]+(?:\|[^{}|]+)+)\}/g, (_match, choices) => {
    const options = String(choices).split("|");
    return options[randomInteger(0, options.length - 1)].trim();
  });
  return applyTemplate(expanded, values);
}

function displayReferenceDate(value) {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return "000000";
  return date.toISOString().slice(2, 10).replaceAll("-", "");
}

export function buildWhatsAppDisplayReference({ type, date, id }) {
  const normalizedType = normalizeNotificationType(type);
  const prefix = DISPLAY_REFERENCE_PREFIXES[normalizedType] || "MSG";
  const numericId = Number(id);
  const suffix = Number.isSafeInteger(numericId) && numericId > 0 ? String(numericId).padStart(3, "0") : "000";
  return `${prefix}-${displayReferenceDate(date)}-${suffix}`;
}

function displayReferenceForJob(job, type) {
  return buildWhatsAppDisplayReference({
    type,
    date: job.payload?.event_time || job.payload?.checkin_time || job.payload?.exam_date || job.payload?.scheduled_date || job.created_at,
    id: job.source_id || job.attendance_record_id || job.cancellation_session_id || job.id
  });
}

export async function resolveWhatsAppTemplate({ category, audience = "neutral", slotNumber = null, values = {}, sourceId = "preview", db = query }) {
  const normalizedCategory = normalizeNotificationType(category);
  const rows = await activeTemplateRows(normalizedCategory, db);
  const normalizedAudience = audience === "male" || audience === "female" ? audience : "neutral";
  const candidates = rows.filter((row) => row.audience === normalizedAudience && (slotNumber == null || Number(row.slot_number) === Number(slotNumber)));
  const selected = candidates[0] || rows.find((row) => row.audience === "neutral" && row.is_fallback);
  if (!selected) throw new Error("no_whatsapp_templates");
  const entropy = `${Date.now()}-${sourceId}-${crypto.randomUUID()}`;
  const uniqueHash = crypto.createHash("sha256").update(entropy).digest("hex").slice(0, 16);
  const referencePrefix = PREVIEW_REFERENCE_PREFIXES[normalizedCategory] || "MSG";
  const reference = `${referencePrefix}-${Date.now()}-${selected.id}-${uniqueHash}`;
  const displayReference = buildWhatsAppDisplayReference({ type: normalizedCategory, date: Date.now(), id: sourceId });
  const safeValues = { ...values, portal_link: "[secure-link-preview]", ref_code: displayReference };
  const rendered = resolveSpintax(selected.message_body, safeValues);
  const message = templateHasPlaceholder(selected.message_body, "ref_code") ? rendered : `${rendered}\n\nRef:${displayReference}`;
  return { id: Number(selected.id), audience: selected.audience, slot_number: selected.slot_number, message, reference, displayReference };
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
  const execute = typeof db === "function" ? db : db.query.bind(db);
  await execute(
    `INSERT INTO student_portal_access_tokens (token_hash, student_id, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '1 hour')
     ON CONFLICT (token_hash) DO NOTHING`,
    [hashStudentPortalAccessToken(accessToken), studentId]
  );
}

function portalTokenFromLink(value) {
  return String(value || "").match(/\/p\/([A-Za-z0-9_-]{20,64})(?:[?#]|$)/)?.[1] || null;
}

async function removePortalAccessRecord(accessToken, db = query) {
  if (!accessToken) return;
  const execute = typeof db === "function" ? db : db.query.bind(db);
  await execute("DELETE FROM student_portal_access_tokens WHERE token_hash = $1", [hashStudentPortalAccessToken(accessToken)]);
}

async function cleanupJobPortalAccess(job, extraToken = null, db = query) {
  const tokens = [portalTokenFromLink(job?.payload?.portal_link), extraToken].filter(Boolean);
  for (const token of tokens) await removePortalAccessRecord(token, db).catch(() => undefined);
}

async function scrubClaimedGradePortalLink(job, db = query) {
  const token = portalTokenFromLink(job?.payload?.portal_link);
  if (token) await removePortalAccessRecord(token, db);
  const payload = { ...(job?.payload && typeof job.payload === "object" ? job.payload : {}), portal_link: GRADE_PORTAL_PREVIEW_MARKER };
  const execute = typeof db === "function" ? db : db.query.bind(db);
  const result = await execute(
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

export async function settlePaymentNotificationJobsForReversal({ client, paymentId }) {
  const result = await client.query(
    `UPDATE whatsapp_notification_jobs
     SET status = CASE
           WHEN status = 'processing' AND send_started_at IS NOT NULL THEN 'delivery_unknown'
           ELSE 'skipped'
         END,
         last_error = CASE
           WHEN status = 'processing' AND send_started_at IS NOT NULL THEN 'payment_reversed_during_send'
           ELSE 'payment_reversed_before_send'
         END,
         next_attempt_at = NULL,
         lease_expires_at = NULL,
         claim_token = NULL,
         send_started_at = CASE
           WHEN status = 'processing' AND send_started_at IS NOT NULL THEN send_started_at
           ELSE NULL
         END,
         updated_at = NOW()
     WHERE notification_type IN ('receipt', 'advance_payment')
       AND source_id = $1
       AND status IN ('pending', 'processing')
     RETURNING id, notification_type, status, send_started_at`,
    [paymentId]
  );
  return result.rows;
}

async function reserveWhatsAppSendSlot(settings, dbPool = pool) {
  const client = await dbPool.connect();
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
    const settings = await getWhatsAppSettings(client.query.bind(client));
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
      if (settings.auto_send && !phone) {
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

    const queueRows = pendingCandidates.map(({ row, phone }, offset) => {
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
      const refCode = notificationRefCode("GRD", row.exam_date, row.result_id, true);
      return {
        resultId: Number(row.result_id),
        studentId: Number(row.student_id),
        phoneNumber: phone,
        payload,
        refCode,
        templateIndex: null,
        template: null,
        renderedMessage: null
      };
    });

    if (!settings.auto_send) {
      const skippedResultIds = [];
      for (const row of queueRows) {
        const skipped = await enqueueJob({
          notificationType: "grade",
          sourceId: row.resultId,
          studentId: row.studentId,
          phone: row.phoneNumber,
          payload: row.payload,
          refCode: row.refCode,
          db: client.query.bind(client),
          wake: false,
          autoSend: false
        });
        if (skipped.status === "skipped" && skipped.reason === "auto_send_disabled") skippedResultIds.push(row.resultId);
      }
      if (skippedResultIds.length) {
        await client.query("UPDATE exam_results SET whatsapp_notified = FALSE WHERE id = ANY($1::int[])", [skippedResultIds]);
      }
      await client.query("COMMIT");
      return { queuedCount: 0, skippedCount: skippedResultIds.length, ignoredCount: ignored.length, ignored, queuedResultIds: [], errors: [] };
    }

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
  const settings = await getWhatsAppSettings(client.query.bind(client));
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
  if (settings.auto_send && !normalizedPhone) return { queued: false, reason: "invalid_phone" };

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

  if (!settings.auto_send) {
    const skipped = await enqueueJob({
      notificationType: "grade",
      sourceId: row.result_id,
      studentId: row.student_id,
      phone,
      refCode,
      payload,
      db: client.query.bind(client),
      wake: false,
      autoSend: false
    });
    await client.query("UPDATE exam_results SET whatsapp_notified = FALSE WHERE id = $1", [row.result_id]);
    return { ...skipped, ref_code: skipped.ref_code || refCode, result_id: row.result_id };
  }

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

  const values = [
    row.student_id,
    phone,
    JSON.stringify(payload),
    refCode,
    null,
    null,
    null
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
    if (!isRetryableWhatsAppNotificationJob(job)) {
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
      WHERE id = $1
        AND (status IN ('failed', 'delivery_unknown')
          OR (status = 'skipped' AND last_error = 'invalid_phone'))
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

async function enqueueJob({ notificationType, sourceId, studentId, phone, payload, refCode, attendanceRecordId = null, db = query, wake = true, dedupeCompleted = false, autoSend = null, disabledReason = "auto_send_disabled" }) {
  const execute = typeof db === "function" ? db : db.query.bind(db);
  const queuedPayload = { ...(payload || {}), type: notificationType };
  const existing = await execute(
    `SELECT id, status, last_error, ref_code
     FROM whatsapp_notification_jobs
     WHERE notification_type = $1 AND source_id = $2
     ORDER BY id DESC
     LIMIT 1`,
    [notificationType, sourceId]
  );
  const previous = existing.rows[0];
  const resolvedAutoSend = autoSend == null
    ? (await getWhatsAppSettings(execute)).auto_send
    : autoSend === true;

  // This is evaluated at the business-event boundary. A disabled automated
  // message is retained for audit/history, but it must never enter the worker.
  if (!resolvedAutoSend) {
    if (previous?.status === "skipped" && previous?.last_error === disabledReason) {
      return { queued: false, skipped: true, reason: disabledReason, job_id: previous.id, status: previous.status, ref_code: previous.ref_code };
    }
    if (previous?.status === "pending") {
      const skipped = await execute(
        `UPDATE whatsapp_notification_jobs
         SET status = 'skipped', last_error = $2,
             lease_expires_at = NULL, claim_token = NULL,
             send_started_at = NULL, updated_at = NOW()
         WHERE id = $1 AND status = 'pending'
         RETURNING id, status, ref_code`,
        [previous.id, disabledReason]
      );
      if (skipped.rowCount) return { queued: false, skipped: true, reason: disabledReason, job_id: skipped.rows[0].id, status: skipped.rows[0].status, ref_code: skipped.rows[0].ref_code };
    }
    if (previous?.status === "processing") {
      // The worker performs the claim-fenced recheck immediately before send.
      return { queued: false, reason: "already_processing", job_id: previous.id, status: previous.status, ref_code: previous.ref_code };
    }
    if (dedupeCompleted && (previous?.status === "sent" || previous?.status === "skipped")) {
      return { queued: false, reason: previous.status === "sent" ? "already_sent" : "already_processed", job_id: previous.id, status: previous.status, ref_code: previous.ref_code };
    }
    if (previous?.status === "delivery_unknown") {
      return { queued: false, reason: "delivery_unknown_requires_confirmation", job_id: previous.id, status: previous.status, ref_code: previous.ref_code };
    }
    if (previous?.status === "failed") {
      const skipped = await execute(
        `UPDATE whatsapp_notification_jobs
         SET student_id = $2, phone_number = $3, payload = $4::jsonb, ref_code = $5,
             status = 'skipped', last_error = $6, attempts = 0,
             sent_at = NULL, lease_expires_at = NULL,
             claim_token = NULL, send_started_at = NULL, updated_at = NOW()
         WHERE id = $1 AND status = 'failed'
         RETURNING id, status, ref_code`,
        [previous.id, studentId, phone || null, JSON.stringify(queuedPayload), refCode, disabledReason]
      );
      if (skipped.rowCount) return { queued: false, skipped: true, reason: disabledReason, job_id: skipped.rows[0].id, status: skipped.rows[0].status, ref_code: skipped.rows[0].ref_code };
    }
    const insertedSkipped = await execute(
      `INSERT INTO whatsapp_notification_jobs
        (notification_type, source_id, attendance_record_id, student_id, phone_number, payload, ref_code,
         status, last_error)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'skipped', $8)
       ON CONFLICT DO NOTHING
       RETURNING id, status, ref_code`,
      [notificationType, sourceId, attendanceRecordId, studentId, phone || null, JSON.stringify(queuedPayload), refCode, disabledReason]
    );
    if (insertedSkipped.rowCount) {
      return { queued: false, skipped: true, reason: disabledReason, job_id: insertedSkipped.rows[0].id, status: insertedSkipped.rows[0].status, ref_code: insertedSkipped.rows[0].ref_code };
    }
    return { queued: false, reason: "queue_conflict" };
  }

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

export const CUSTOM_WHATSAPP_MESSAGE_MAX_LENGTH = 2000;

export async function enqueueCustomWhatsAppMessage({ studentId, message, actorId, idempotencyKey, db = query, wake = true }) {
  const execute = typeof db === "function" ? db : db.query.bind(db);
  const text = String(message ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
  if (!text) throw new Error("custom_message_empty");
  if (text.length > CUSTOM_WHATSAPP_MESSAGE_MAX_LENGTH) throw new Error("custom_message_too_long");
  if (!Number.isSafeInteger(Number(actorId)) || Number(actorId) <= 0) throw new Error("custom_message_sender_required");
  if (!/^[-A-Za-z0-9_:]{8,128}$/.test(String(idempotencyKey || ""))) throw new Error("invalid_idempotency_key");
  const existing = await execute("SELECT id, status, student_id, created_at FROM whatsapp_notification_jobs WHERE idempotency_key = $1", [idempotencyKey]);
  if (existing.rowCount) return { ...existing.rows[0], duplicate: true };
  const studentResult = await execute(`SELECT id, full_name, student_code, guardian_phone, whatsapp_opted_out, is_active, deleted_at
    FROM students WHERE id = $1`, [studentId]);
  const student = studentResult.rows[0];
  if (!student || !student.is_active || student.deleted_at) throw new Error("custom_message_student_ineligible");
  if (student.whatsapp_opted_out) throw new Error("custom_message_opted_out");
  const phone = normalizeEgyptianPhone(student.guardian_phone);
  if (!phone) throw new Error("custom_message_invalid_phone");
  const refCode = `CUS-${Date.now()}-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const inserted = await execute(`INSERT INTO whatsapp_notification_jobs
      (notification_type, source_id, student_id, created_by_teacher_id, idempotency_key, phone_number, payload, ref_code, rendered_message, status)
    VALUES ('custom_message', NULL, $1, $2, $3, $4, $5::jsonb, $6, $7, 'pending')
    ON CONFLICT DO NOTHING
    RETURNING id, status, student_id, created_at`, [student.id, actorId, idempotencyKey, phone, JSON.stringify({ type: "custom_message", message: text }), refCode, text]);
  if (!inserted.rowCount) {
    const duplicate = await execute("SELECT id, status, student_id, created_at FROM whatsapp_notification_jobs WHERE idempotency_key = $1", [idempotencyKey]);
    if (duplicate.rowCount) return { ...duplicate.rows[0], duplicate: true };
    throw new Error("custom_message_enqueue_conflict");
  }
  if (wake) wakeWhatsAppWorker();
  return { ...inserted.rows[0], duplicate: false };
}

export async function searchCustomMessageStudents(search, db = query) {
  const term = String(search || "").trim().slice(0, 80);
  if (term.length < 2) return [];
  const result = await db(`SELECT s.id, s.full_name, s.student_code, s.student_serial,
      s.guardian_phone, COALESCE(g.display_name, g.name) AS group_name,
      COALESCE(g.grade_level, g.grade) AS grade_level
    FROM students s LEFT JOIN groups g ON g.id = s.group_id
    WHERE s.is_active = TRUE AND s.deleted_at IS NULL
      AND (s.full_name ILIKE $1 OR s.student_code ILIKE $1 OR s.student_serial ILIKE $1)
    ORDER BY s.full_name LIMIT 20`, [`%${term}%`]);
  return result.rows.map((row) => ({ ...row, phone_number: row.guardian_phone ? `${String(row.guardian_phone).slice(0, 3)}****${String(row.guardian_phone).slice(-2)}` : null, guardian_phone: undefined }));
}

export async function enqueueCancellationNotificationsInTransaction(client, { session, actorId = null }) {
  const settings = await getWhatsAppSettings(client.query.bind(client));
  const students = await client.query(`
    SELECT id, guardian_phone
    FROM students
    WHERE group_id = $1 AND is_active = TRUE AND deleted_at IS NULL
      AND whatsapp_opted_out = FALSE
    ORDER BY id`, [session.group_id]);
  const sessionId = Number(session.id || session.session_id);
  const scheduled = cairoParts(session.starts_at);
  const cancelled = cairoParts(session.cancelled_at);
  let queuedCount = 0;
  let skippedCount = 0;
  for (const student of students.rows) {
    const phone = normalizeEgyptianPhone(student.guardian_phone);
    // Automated cancellation notices follow the same event-time policy as
    // every other automated WhatsApp notification. Auto Send wins over the
    // connection state and over later manual review.
    const status = !settings.auto_send ? "skipped" : !phone ? "skipped" : "pending";
    const lastError = !settings.auto_send ? "auto_send_disabled" : !phone ? "invalid_phone" : null;
    const result = await client.query(`
      INSERT INTO whatsapp_notification_jobs
        (notification_type, cancellation_session_id, student_id, phone_number,
         payload, ref_code, status, last_error, next_attempt_at, created_at, updated_at)
      VALUES ('cancellation', $1, $2, $3, $4::jsonb, $5, $6, $7,
        NOW(), NOW(), NOW())
      ON CONFLICT (cancellation_session_id, student_id)
        WHERE notification_type = 'cancellation' AND cancellation_session_id IS NOT NULL AND student_id IS NOT NULL
      DO NOTHING
      RETURNING id`, [
      sessionId,
      student.id,
      phone,
      JSON.stringify({
        type: "cancellation",
        session_id: sessionId,
        group_name: session.group_name,
        scheduled_date: scheduled.date,
        scheduled_time: scheduled.time,
        cancellation_time: `${cancelled.date} ${cancelled.time}`,
        starts_at: session.starts_at,
        cancelled_at: session.cancelled_at
      }),
      `CNL-${sessionId}-${student.id}`,
      status,
      lastError
    ]);
    if (result.rowCount) {
      if (status === "pending") queuedCount += 1;
      else skippedCount += 1;
    }
  }
  return { queuedCount, reviewCount: 0, skippedCount, eligibleCount: students.rowCount, autoSend: settings.auto_send, actorId };
}

export async function enqueueAttendanceNotification({ attendanceRecordId, studentId }) {
  return enqueueAttendanceNotificationWithDb({ attendanceRecordId, studentId });
}

async function enqueueAttendanceNotificationWithDb({ attendanceRecordId, studentId, db = query, wake = true }) {
  const execute = typeof db === "function" ? db : db.query.bind(db);
  const settings = await getWhatsAppSettings(execute);
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
  const sendAllowed = settings.auto_send && settings.attendance_notifications_enabled;
  if (sendAllowed && !phone) return { queued: false, reason: "invalid_phone" };
  const refCode = notificationRefCode("ATT", row.checkin_time, row.attendance_record_id);
  const queue = await enqueueJob({
    notificationType: "attendance",
    sourceId: row.attendance_record_id,
    attendanceRecordId: row.attendance_record_id,
    studentId: row.student_id,
    phone: phone || (sendAllowed ? null : String(row.guardian_phone || "not_provided").trim() || "not_provided"),
    payload: { student_name: row.student_name, student_code: row.student_code, group_name: row.group_name, checkin_time: row.checkin_time },
    refCode,
    db: execute,
    wake,
    dedupeCompleted: true,
    autoSend: sendAllowed,
    disabledReason: settings.auto_send ? "attendance_notifications_disabled" : "auto_send_disabled"
  });
  return { ...queue, ref_code: queue.ref_code || refCode };
}

export async function enqueueAttendanceNotificationInTransaction(client, { attendanceRecordId, studentId }) {
  return enqueueAttendanceNotificationWithDb({ attendanceRecordId, studentId, db: client.query.bind(client), wake: false });
}

export async function enqueueAttendanceNotificationForTest({ attendanceRecordId, studentId, db }) {
  return enqueueAttendanceNotificationWithDb({ attendanceRecordId, studentId, db, wake: false });
}

export async function enqueueGradeNotification({ resultId }) {
  const settings = await getWhatsAppSettings(query);
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
  if (settings.auto_send && !phone) return { queued: false, reason: "invalid_phone" };
  const maxScore = Number(row.max_score);
  const score = Number(row.score);
  const percentage = maxScore > 0 ? ((score / maxScore) * 100).toFixed(1).replace(/\.0$/, "") : "0";
  const refCode = notificationRefCode("GRD", row.exam_date, row.result_id, true);
  await query("UPDATE exam_results SET whatsapp_notified = FALSE WHERE id = $1", [row.result_id]);
  const queue = await enqueueJob({ notificationType: "grade", sourceId: row.result_id, studentId: row.student_id, phone, refCode, payload: {
    student_name: row.student_name, student_code: row.student_code, exam_title: row.exam_title,
    score, max_score: maxScore, percentage, event_time: row.exam_date
  }, autoSend: settings.auto_send });
  return { ...queue, ref_code: queue.ref_code || refCode };
}

async function enqueuePaymentNotificationWithDb({ paymentId, paymentType, notificationType, referencePrefix, db = query, wake = true }) {
  const execute = typeof db === "function" ? db : db.query.bind(db);
  const settings = await getWhatsAppSettings(execute);
  const result = await execute(`
    SELECT p.id AS payment_id, p.amount, p.paid_amount, p.discount_amount, p.is_exempt, p.payment_reference,
      p.payment_months, p.payment_date, p.paid_at,
      s.id AS student_id, s.full_name AS student_name, s.student_code, s.guardian_phone
    FROM payments p
    JOIN students s ON s.id = p.student_id
    WHERE p.id = $1 AND p.payment_type = $2
      AND NOT EXISTS (SELECT 1 FROM payment_reversals pr WHERE pr.payment_id = p.id)
      AND s.is_active = TRUE AND s.deleted_at IS NULL AND s.whatsapp_opted_out = FALSE`, [paymentId, paymentType]);
  const row = result.rows[0];
  if (!row) return { queued: false, reason: "not_found" };
  const phone = normalizeEgyptianPhone(row.guardian_phone);
  if (settings.auto_send && !phone) return { queued: false, reason: "invalid_phone" };
  const month = paymentMonthsValue(row.payment_months, row.payment_date, row.paid_at);
  const refCode = notificationRefCode(referencePrefix, row.payment_date, row.payment_id, true);
  const queue = await enqueueJob({ notificationType, sourceId: row.payment_id, studentId: row.student_id, phone, refCode, dedupeCompleted: true, db: execute, wake, autoSend: settings.auto_send, payload: {
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

async function claimNextJob(dbPool = pool, dbClient = null) {
  const client = dbClient || await dbPool.connect();
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

async function updateJob(id, status, fields = {}, claimToken, dbPool = pool) {
  if (!claimToken) return false;
  const result = await dbPool.query(`UPDATE whatsapp_notification_jobs SET status = $2, last_error = $3,
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

async function deferDisconnectedJob(job, dbPool = pool) {
  const result = await dbPool.query(
    `UPDATE whatsapp_notification_jobs
     SET status = 'pending', attempts = GREATEST(attempts - 1, 0),
         last_error = 'whatsapp_disconnected',
         next_attempt_at = NOW() + INTERVAL '30 seconds',
         lease_expires_at = NULL, claim_token = NULL, send_started_at = NULL,
         updated_at = NOW()
     WHERE id = $1 AND status = 'processing' AND claim_token = $2
     RETURNING id`,
    [job.id, job.claim_token]
  );
  return result.rowCount > 0;
}

async function extendJobLease(job, phase, dbPool = pool, audit = auditWhatsAppJob) {
  if (!job?.id || !job.claim_token) return false;
  const result = await dbPool.query(
    `UPDATE whatsapp_notification_jobs
     SET lease_expires_at = NOW() + ($3 * INTERVAL '1 millisecond'), updated_at = NOW()
     WHERE id = $1 AND status = 'processing' AND claim_token = $2
     RETURNING lease_expires_at`,
    [job.id, job.claim_token, JOB_LEASE_MS]
  );
  if (!result.rowCount) return false;
  await audit(job, "whatsapp_job_lease_extended", { phase }).catch(() => undefined);
  return true;
}

async function markSendStartedWithResult(job, type, dbPool = pool) {
  if (!job?.id || !job.claim_token) return { ok: false, reason: "stale_claim" };
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");
    if (type === "absence" || type === "cancellation") {
      const scope = await client.query(`
        SELECT COALESCE(j.cancellation_session_id, ar.session_id) AS session_id
        FROM whatsapp_notification_jobs j
        LEFT JOIN attendance_records ar ON ar.id = COALESCE(j.attendance_record_id, j.source_id)
        WHERE j.id = $1 AND j.status = 'processing' AND j.claim_token = $2`, [job.id, job.claim_token]);
      if (!scope.rowCount || !scope.rows[0].session_id) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "stale_claim" };
      }
      const lockedSession = await client.query(
        "SELECT id, status FROM attendance_sessions WHERE id = $1 FOR UPDATE",
        [scope.rows[0].session_id]
      );
      const cancelledAbsence = type === "absence" && lockedSession.rows[0]?.status === "cancelled";
      const invalidCancellation = type === "cancellation" && lockedSession.rows[0]?.status !== "cancelled";
      if (cancelledAbsence || invalidCancellation) {
        const settled = await client.query(`
          UPDATE whatsapp_notification_jobs
          SET status = 'skipped', last_error = $3, next_attempt_at = NULL,
              lease_expires_at = NULL, claim_token = NULL, send_started_at = NULL, updated_at = NOW()
          WHERE id = $1 AND status = 'processing' AND claim_token = $2
          RETURNING id`, [job.id, job.claim_token, cancelledAbsence ? "attendance_session_cancelled" : "cancellation_no_longer_eligible"]);
        if (!settled.rowCount) {
          await client.query("ROLLBACK");
          return { ok: false, reason: "stale_claim" };
        }
        await client.query("COMMIT");
        return { ok: false, reason: cancelledAbsence ? "attendance_session_cancelled" : "cancellation_no_longer_eligible", settledStatus: "skipped" };
      }
    }
    const currentJob = await client.query(
      `SELECT id, student_id
       FROM whatsapp_notification_jobs
       WHERE id = $1 AND status = 'processing' AND claim_token = $2
       FOR UPDATE`,
      [job.id, job.claim_token]
    );
    if (!currentJob.rowCount) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "stale_claim" };
    }

    const studentResult = currentJob.rows[0].student_id == null
      ? { rowCount: 0, rows: [] }
      : await client.query(
        `SELECT gender, is_active, deleted_at, whatsapp_opted_out
         FROM students
         WHERE id = $1
         FOR UPDATE`,
        [currentJob.rows[0].student_id]
      );

    let rejectionReason = null;
    let retryWithCurrentStudent = false;
    if (!studentResult.rowCount || !studentResult.rows[0].is_active || studentResult.rows[0].deleted_at) {
      rejectionReason = "student_inactive";
    } else if (studentResult.rows[0].whatsapp_opted_out) {
      rejectionReason = "whatsapp_opted_out";
    } else if (normalizeStudentGender(studentResult.rows[0].gender) !== normalizeStudentGender(job.template_gender)) {
      rejectionReason = "student_gender_changed";
      retryWithCurrentStudent = true;
    }

    if (rejectionReason) {
      const settled = retryWithCurrentStudent
        ? await client.query(
          `UPDATE whatsapp_notification_jobs
           SET status = 'pending', attempts = GREATEST(attempts - 1, 0),
               last_error = NULL, next_attempt_at = NOW(), lease_expires_at = NULL,
               claim_token = NULL, send_started_at = NULL,
               template_id = NULL, template_version = NULL, template_category = NULL,
               template_audience = NULL, template_slot_number = NULL,
               template_body_snapshot = NULL, template_gender = NULL,
               template_index = NULL, template_text = NULL, rendered_message = NULL,
               updated_at = NOW()
           WHERE id = $1 AND status = 'processing' AND claim_token = $2
           RETURNING id`,
          [job.id, job.claim_token]
        )
        : await client.query(
          `UPDATE whatsapp_notification_jobs
           SET status = 'skipped', last_error = $3, next_attempt_at = NULL,
               lease_expires_at = NULL, claim_token = NULL, send_started_at = NULL,
               updated_at = NOW()
           WHERE id = $1 AND status = 'processing' AND claim_token = $2
           RETURNING id`,
          [job.id, job.claim_token, rejectionReason]
        );
      if (!settled.rowCount) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "stale_claim" };
      }
      await client.query("COMMIT");
      return {
        ok: false,
        reason: rejectionReason,
        settledStatus: retryWithCurrentStudent ? "pending" : "skipped"
      };
    }

    if (type === "receipt" || type === "advance_payment") {
      const payment = await client.query(
        `SELECT p.id
         FROM payments p
         WHERE p.id = $1
           AND NOT EXISTS (SELECT 1 FROM payment_reversals pr WHERE pr.payment_id = p.id)
         FOR UPDATE`,
        [job.source_id]
      );
      if (!payment.rowCount) {
        const settled = await client.query(
          `UPDATE whatsapp_notification_jobs
           SET status = 'skipped', last_error = 'payment_reversed', next_attempt_at = NULL,
               lease_expires_at = NULL, claim_token = NULL, send_started_at = NULL,
               updated_at = NOW()
           WHERE id = $1 AND status = 'processing' AND claim_token = $2
           RETURNING id`,
          [job.id, job.claim_token]
        );
        if (!settled.rowCount) {
          await client.query("ROLLBACK");
          return { ok: false, reason: "stale_claim" };
        }
        await client.query("COMMIT");
        return { ok: false, reason: "payment_reversed", settledStatus: "skipped" };
      }
    }
    const result = await client.query(
      `UPDATE whatsapp_notification_jobs
       SET send_started_at = NOW(), lease_expires_at = NOW() + ($3 * INTERVAL '1 millisecond'), updated_at = NOW()
       WHERE id = $1 AND status = 'processing' AND claim_token = $2
       RETURNING id`,
      [job.id, job.claim_token, JOB_LEASE_MS]
    );
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "stale_claim" };
    }
    await client.query("COMMIT");
    return { ok: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function markSendStarted(job, type, dbPool = pool) {
  const result = await markSendStartedWithResult(job, type, dbPool);
  return result.ok;
}

async function completeSentJob(job, providerMessageId, dbPool = pool) {
  const client = await dbPool.connect();
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
      approved_by: job?.approved_by || null,
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

export async function revalidateWhatsAppJob(job, type, db = query) {
  const execute = typeof db === "function" ? db : db.query.bind(db);
  if (!job?.student_id) return { ok: false, reason: "student_missing" };
  const studentResult = await execute(`
    SELECT id, full_name, student_code, guardian_phone, gender, is_active, deleted_at, whatsapp_opted_out
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
  } else if (type === "cancellation") {
    const source = await execute(`
      SELECT ats.id AS session_id, ats.status, ats.starts_at, ats.cancelled_at,
        to_char(ats.session_date, 'YYYY-MM-DD') AS session_date,
        COALESCE(NULLIF(TRIM(g.display_name), ''), NULLIF(TRIM(g.name), ''), '') AS group_name
      FROM attendance_sessions ats
      JOIN groups g ON g.id = ats.group_id
      JOIN whatsapp_notification_jobs j ON j.cancellation_session_id = ats.id
      WHERE j.id = $1 AND j.student_id = $2 AND ats.status = 'cancelled'`, [job.id, student.id]);
    if (!source.rowCount) return { ok: false, reason: "cancellation_no_longer_eligible" };
    const session = source.rows[0];
    const scheduled = cairoParts(session.starts_at);
    const cancelled = cairoParts(session.cancelled_at);
    payload = {
      ...payload,
      group_name: session.group_name,
      session_id: session.session_id,
      scheduled_date: scheduled.date,
      scheduled_time: scheduled.time,
      cancellation_time: `${cancelled.date} ${cancelled.time}`,
      event_time: session.cancelled_at
    };
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
      FROM payments
      WHERE id = $1 AND student_id = $2 AND payment_type = $3
        AND NOT EXISTS (SELECT 1 FROM payment_reversals pr WHERE pr.payment_id = payments.id)`,
      [job.source_id, student.id, type === "receipt" ? "normal" : "advance"]
    );
    if (!source.rowCount) {
      const reversed = await execute("SELECT 1 FROM payment_reversals WHERE payment_id = $1", [job.source_id]);
      return { ok: false, reason: reversed.rowCount ? "payment_reversed" : "payment_no_longer_exists" };
    }
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

function selectionSnapshotIsCurrent(job, row, category, audience, gender) {
  return Boolean(
    Number(job.template_id) === Number(row.id)
      && Number(job.template_version) === Number(row.content_version)
      && String(job.template_category || "") === category
      && String(job.template_audience || "") === audience
      && (job.template_slot_number == null
        ? row.slot_number == null
        : Number(job.template_slot_number) === Number(row.slot_number))
      && String(job.template_body_snapshot || "") === String(row.message_body)
      && (job.template_text == null || String(job.template_text) === String(row.message_body))
      && String(job.template_gender || "") === gender
  );
}

async function selectAndPersistWhatsAppTemplate({ job, type, dbPool = pool }) {
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `SELECT * FROM whatsapp_notification_jobs
       WHERE id = $1
         AND status = 'processing'
         AND claim_token = $2
         AND (lease_expires_at IS NULL OR lease_expires_at > NOW())
       FOR UPDATE`,
      [job.id, job.claim_token]
    );
    if (!locked.rowCount) {
      await client.query("ROLLBACK");
      return { ok: false, stale: true, reason: "stale_claim" };
    }
    const currentJob = locked.rows[0];
    const eligibility = await revalidateWhatsAppJob(currentJob, type, client.query.bind(client));
    if (!eligibility.ok) {
      await client.query("ROLLBACK");
      return eligibility;
    }
    const gender = normalizeStudentGender(eligibility.student.gender);
    const audience = gender === "unknown" ? "neutral" : gender;

    if (currentJob.template_id != null) {
      if (audience === "neutral") {
        const fallback = await client.query(
          `SELECT id, category, audience, slot_number, slot_key, is_fallback,
                  content_version, message_body, is_active
           FROM whatsapp_templates
           WHERE id = $1 AND category = $2 AND audience = 'neutral' AND is_fallback = TRUE
             AND is_active = TRUE AND slot_number IS NULL
           LIMIT 1
           FOR SHARE`,
          [currentJob.template_id, type]
        );
        const row = fallback.rows[0];
        if (row && validateWhatsAppTemplate(type, row.message_body).ok && selectionSnapshotIsCurrent(currentJob, row, type, "neutral", gender)) {
          await client.query("COMMIT");
          return { ok: true, assignment: { ...row, audience: "neutral", gender, warning: null }, eligibility };
        }
      } else {
        const existing = await client.query(
          `SELECT id, category, audience, slot_number, slot_key, is_fallback,
                  content_version, message_body, is_active
           FROM whatsapp_templates
           WHERE id = $1 AND category = $2 AND audience = $3 AND is_fallback = FALSE
             AND is_active = TRUE AND slot_number BETWEEN 1 AND 4
           LIMIT 1
           FOR SHARE`,
          [currentJob.template_id, type, audience]
        );
        const row = existing.rows[0];
        if (row && validateWhatsAppTemplate(type, row.message_body).ok && selectionSnapshotIsCurrent(currentJob, row, type, audience, gender)) {
          await client.query("COMMIT");
          return { ok: true, assignment: { ...row, audience, gender, warning: null }, eligibility };
        }
      }
    }

    const rowsResult = await client.query(
      `SELECT id, category, audience, slot_number, slot_key, is_fallback,
          content_version, message_body, is_active
       FROM whatsapp_templates
       WHERE category = $1 AND is_active = TRUE
         AND audience = $2 AND is_fallback = FALSE
         AND slot_number BETWEEN 1 AND 4
       ORDER BY slot_number
       FOR SHARE`,
      [type, audience]
    );
    const validRows = rowsResult.rows.filter((row) => validateWhatsAppTemplate(type, row.message_body).ok);
    let selected = null;
    let warning = null;
    let usedAudience = audience;
    let shouldAdvance = false;

    if (audience === "neutral") {
      const fallback = await client.query(
        `SELECT id, category, audience, slot_number, slot_key, is_fallback,
            content_version, message_body, is_active
         FROM whatsapp_templates
         WHERE category = $1 AND audience = 'neutral' AND is_fallback = TRUE
           AND is_active = TRUE AND slot_number IS NULL
         LIMIT 1
         FOR SHARE`,
        [type]
      );
      selected = fallback.rows.find((row) => validateWhatsAppTemplate(type, row.message_body).ok) || null;
      if (!selected) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "whatsapp_template_configuration_missing" };
      }
    } else if (validRows.length) {
      await client.query(
        `INSERT INTO whatsapp_template_rotation_state (category, audience, next_slot)
         VALUES ($1, $2, 1)
         ON CONFLICT (category, audience) DO NOTHING`,
        [type, audience]
      );
      const cursorResult = await client.query(
        `SELECT next_slot FROM whatsapp_template_rotation_state
         WHERE category = $1 AND audience = $2 FOR UPDATE`,
        [type, audience]
      );
      const nextSlot = Number(cursorResult.rows[0]?.next_slot || 1);
      let candidateIndex = validRows.findIndex((row) => Number(row.slot_number) >= nextSlot);
      if (candidateIndex < 0) candidateIndex = 0;
      selected = validRows[candidateIndex];

      const previous = await client.query(
        `SELECT template_id
         FROM whatsapp_notification_jobs
         WHERE student_id = $1 AND notification_type = $2
           AND template_audience = $3 AND status = 'sent'
           AND provider_accepted_at IS NOT NULL
         ORDER BY provider_accepted_at DESC, id DESC
         LIMIT 1`,
        [currentJob.student_id, type, audience]
      );
      if (validRows.length > 1 && Number(previous.rows[0]?.template_id) === Number(selected.id)) {
        selected = validRows[(candidateIndex + 1) % validRows.length];
        warning = "repeat_avoidance_adjusted_rotation";
      }
      shouldAdvance = true;
      warning = warning || (validRows.length < 4 ? `${audience}_template_pool_incomplete` : null);
    } else {
      const fallback = await client.query(
        `SELECT id, category, audience, slot_number, slot_key, is_fallback,
            content_version, message_body, is_active
         FROM whatsapp_templates
         WHERE category = $1 AND audience = 'neutral' AND is_fallback = TRUE
           AND is_active = TRUE AND slot_number IS NULL
         LIMIT 1
         FOR SHARE`,
        [type]
      );
      selected = fallback.rows.find((row) => validateWhatsAppTemplate(type, row.message_body).ok) || null;
      usedAudience = "neutral";
      warning = `${audience}_template_pool_empty_using_neutral_fallback`;
      if (!selected) {
        await client.query("ROLLBACK");
        return { ok: false, reason: "whatsapp_template_configuration_missing" };
      }
    }

    const canReuse = selectionSnapshotIsCurrent(currentJob, selected, type, usedAudience, gender);
    const nextSlot = shouldAdvance ? (Number(selected.slot_number) % 4) + 1 : null;
    if (shouldAdvance && !canReuse) {
      await client.query(
        `UPDATE whatsapp_template_rotation_state
         SET next_slot = $3, updated_at = NOW()
         WHERE category = $1 AND audience = $2`,
        [type, audience, nextSlot]
      );
    }

    if (!canReuse) {
      await client.query(
        `UPDATE whatsapp_notification_jobs
         SET template_id = $2, template_version = $3, template_category = $4,
             template_audience = $5, template_slot_number = $6,
             template_body_snapshot = $7, template_gender = $8,
             template_index = $9, template_text = $7, rendered_message = NULL,
             updated_at = NOW()
         WHERE id = $1 AND status = 'processing' AND claim_token = $10`,
        [currentJob.id, selected.id, selected.content_version, type, usedAudience, selected.slot_number,
          selected.message_body, gender, selected.slot_number == null ? null : Number(selected.slot_number) - 1, currentJob.claim_token]
      );
    } else {
      selected = { ...selected, message_body: currentJob.template_body_snapshot || currentJob.template_text };
    }
    await client.query("COMMIT");
    return { ok: true, assignment: { ...selected, audience: usedAudience, gender, warning }, eligibility };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function selectWhatsAppTemplateForTest(options) {
  return selectAndPersistWhatsAppTemplate(options);
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

async function waitWithJobLease(job, waitMs, dbPool = pool, audit = auditWhatsAppJob, ownsSession = () => state.ownsWhatsAppSession) {
  let remaining = Math.max(0, Number(waitMs) || 0);
  while (remaining > 0) {
    if (!ownsSession() || !(await extendJobLease(job, "send_slot_wait", dbPool, audit))) return false;
    const chunk = Math.min(remaining, JOB_LEASE_RENEWAL_CHUNK_MS);
    await sleep(chunk);
    remaining -= chunk;
  }
  return extendJobLease(job, "after_send_slot_wait", dbPool, audit);
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

export function isRetryableWhatsAppNotificationJob(job) {
  return job?.status === "failed"
    || job?.status === "delivery_unknown"
    || (job?.status === "skipped" && job?.last_error === "invalid_phone");
}

async function markDeliveryUnknown(job, reason, providerMessageId = null, dbPool = pool, audit = auditWhatsAppJob) {
  const updated = await updateJob(job.id, "delivery_unknown", {
    error: "delivery_unknown",
    nextAttemptAt: null,
    providerMessageId
  }, job.claim_token, dbPool);
  if (updated) {
    await audit(job, "whatsapp_job_delivery_unknown", { reason }).catch(() => undefined);
  } else {
    await audit(job, "whatsapp_job_stale_claim_rejected", { phase: "delivery_unknown" }).catch(() => undefined);
  }
  return updated;
}

async function processWhatsAppJob({ dbPool = pool, provider = state.socket, settingsOverride = null, auditEnabled = true, ownership = null, errorObserver = null } = {}) {
  const auditJob = auditEnabled ? auditWhatsAppJob : async () => undefined;
  const ownsSession = ownership?.owns || (() => state.ownsWhatsAppSession);
  const renewOwnership = ownership?.renew || renewWhatsAppOwnership;
  const verifyOwnership = ownership?.verify || verifyWhatsAppOwnership;
  const connected = ownership?.connected || (() => state.status === "connected" && Boolean(provider || state.socket));
  const auditStale = (job, phase) => auditJob(job, "whatsapp_job_stale_claim_rejected", { phase }).catch(() => undefined);
  if (!ownsSession()) return;
  if (state.workerRunning) return;
  state.workerRunning = true;
  let job = null;
  let portalAccessToken = null;
  let providerAccepted = false;
  let providerMessageId = null;
  try {
    job = await claimNextJob(dbPool);
    if (!job) return;
    await auditJob(job, "whatsapp_job_claimed", { lease_expires_at: job.lease_expires_at }).catch(() => undefined);
    const settings = settingsOverride || await getWhatsAppSettings(dbPool.query.bind(dbPool));
    const type = notificationTypeForJob(job);
    if (!type) {
      const updated = await updateJob(job.id, "skipped", { error: "unsupported_whatsapp_notification_type" }, job.claim_token, dbPool);
      if (updated) await auditJob(job, "whatsapp_job_skipped", { reason: "unsupported_whatsapp_notification_type" });
      else await auditStale(job, "unsupported_type");
      return;
    }
    const policySkipReason = type === "custom_message" && !job.created_by_teacher_id
      ? "custom_message_sender_missing"
      : !settings.auto_send && type !== "custom_message"
      ? "auto_send_disabled"
      : type === "attendance" && settings.attendance_notifications_enabled === false
        ? "attendance_notifications_disabled"
        : null;
    if (policySkipReason) {
      const updated = await updateJob(job.id, "skipped", { error: policySkipReason }, job.claim_token, dbPool);
      if (updated) await auditJob(job, "whatsapp_job_skipped", { reason: policySkipReason });
      else await auditStale(job, policySkipReason);
      return;
    }
    if (!connected()) {
      // A disconnected local WhatsApp session is not a delivery attempt. Keep
      // the PostgreSQL outbox item durable and restore the claim increment so
      // temporary disconnections never exhaust the real provider retry budget.
      const deferred = await deferDisconnectedJob(job, dbPool);
      if (deferred) await auditJob(job, "whatsapp_job_deferred", { reason: "whatsapp_disconnected" });
      else await auditStale(job, "whatsapp_disconnected");
      return;
    }

    const waitMs = await reserveWhatsAppSendSlot(settings, dbPool);
    if (!(await waitWithJobLease(job, waitMs, dbPool, auditJob, ownsSession))) {
      await auditStale(job, "send_slot_wait");
      return;
    }
    let eligibility = await revalidateWhatsAppJob(job, type, dbPool.query.bind(dbPool));
    if (!eligibility.ok) {
      const updated = await updateJob(job.id, "skipped", { error: eligibility.reason, nextAttemptAt: null }, job.claim_token, dbPool);
      if (updated) {
        await cleanupJobPortalAccess(job, portalAccessToken, dbPool);
        await auditJob(job, "whatsapp_job_skipped", { reason: eligibility.reason });
      } else await auditStale(job, "initial_revalidation");
      return;
    }
    if (type === "grade" && !(await scrubClaimedGradePortalLink(job, dbPool))) {
      await auditStale(job, "grade_portal_link_scrub");
      return;
    }
    const selection = type === "custom_message"
      ? { ok: true, eligibility, assignment: { id: null, content_version: null, message_body: String(eligibility.payload?.message || ""), audience: "neutral", slot_number: null, gender: null } }
      : await selectAndPersistWhatsAppTemplate({ job, type, dbPool });
    if (!selection.ok) {
      const terminalReason = selection.stale ? "stale_claim" : selection.reason || "whatsapp_template_configuration_missing";
      const updated = selection.stale
        ? false
        : await updateJob(job.id, "failed", { error: terminalReason, nextAttemptAt: null }, job.claim_token, dbPool);
      if (updated) {
        await cleanupJobPortalAccess(job, null, dbPool);
        await auditJob(job, "whatsapp_job_failed", { reason: terminalReason });
      } else if (selection.stale) await auditStale(job, terminalReason);
      return;
    }
    eligibility = selection.eligibility || eligibility;
    let assignment = selection.assignment;
    let templateIndex = assignment.slot_number == null ? null : Number(assignment.slot_number) - 1;
    let template = String(assignment.message_body || "");
    job.template_id = assignment.id;
    job.template_version = assignment.content_version;
    job.template_category = type;
    job.template_audience = assignment.audience;
    job.template_slot_number = assignment.slot_number;
    job.template_body_snapshot = template;
    job.template_gender = assignment.gender;

    let payload = eligibility.payload || {};
    if (type === "grade") {
      if (!(await scrubClaimedGradePortalLink(job, dbPool))) {
        await auditStale(job, "grade_portal_link_scrub");
        return;
      }
      payload = { ...payload, portal_link: GRADE_PORTAL_PREVIEW_MARKER };
    }
    const parts = cairoParts(payload.event_time || payload.checkin_time);
    const studentCode = String(payload.student_code || "").trim();
    portalAccessToken = createStudentPortalAccessToken();
    const portalLink = type === "custom_message" ? "" : buildStudentPortalLink(job.student_id, studentCode, portalAccessToken);
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
    const displayReference = displayReferenceForJob(job, type);
    const templateValues = { ...formattedPayload, ...parts, ref_code: displayReference, student_code: studentCode, portal_link: portalLink };
    const renderedBody = type === "custom_message" ? String(payload.message || "").trim() : compileWhatsAppMessage(type, template, templateValues).trim();
    const body = portalLink && !templateHasPlaceholder(template, "portal_link") ? `${renderedBody}\n${portalLink}` : renderedBody;
    const adjustmentLine = type === "receipt" && (payload.is_exempt === true || Number(payload.discount_amount || 0) > 0)
      ? payload.is_exempt === true
        ? (locale === "ar-EG" ? "حالة السداد: إعفاء كامل" : "Payment status: Full exemption")
        : (locale === "ar-EG" ? `الخصم المطبق: ${payload.discount_amount} ج.م` : `Discount applied: ${payload.discount_amount} EGP`)
      : "";
    const adjustedBody = adjustmentLine && !body.includes(adjustmentLine) ? `${body}\n${adjustmentLine}` : body;
    const footer = type === "custom_message" ? "" : locale === "ar-EG" ? "— Mr. Ahmed Abdrabo Platform" : "— Abdrabo Attendance Platform";
    const finalBody = adjustedBody.includes(footer) ? adjustedBody : `${adjustedBody}\n\n${footer}`;
    const contentUpdated = await dbPool.query(
      `UPDATE whatsapp_notification_jobs
       SET template_index = $2, template_text = $3, rendered_message = $4, template_body_snapshot = $3,
           template_category = $5, template_audience = $6, template_slot_number = $7,
           template_gender = $8, updated_at = NOW()
       WHERE id = $1 AND status = 'processing' AND claim_token = $9
       RETURNING id`,
      [job.id, templateIndex, template, redactPortalLink(finalBody), type, assignment.audience, assignment.slot_number, assignment.gender, job.claim_token]
    );
    if (!contentUpdated.rowCount) {
      await auditStale(job, "rendered_content");
      return;
    }
    if (!ownsSession()
      || !(await extendJobLease(job, "before_provider", dbPool, auditJob))
      || !(await renewOwnership())
      || !(await verifyOwnership())) {
      await auditStale(job, "before_provider");
      return;
    }
    if (!connected()) {
      const deferred = await deferDisconnectedJob(job, dbPool);
      if (deferred) await auditJob(job, "whatsapp_job_deferred", { reason: "whatsapp_disconnected" });
      else await auditStale(job, "whatsapp_disconnected_before_provider");
      return;
    }
    // Re-read the setting immediately before crossing the provider boundary.
    // This closes the race where an administrator disables automated sending
    // after the job was queued or rendered but before it is actually sent.
    const deliverySettings = settingsOverride || await getWhatsAppSettings(dbPool.query.bind(dbPool));
    const deliverySkipReason = type === "custom_message" && !job.created_by_teacher_id
      ? "custom_message_sender_missing"
      : !deliverySettings.auto_send && type !== "custom_message"
      ? "auto_send_disabled"
      : type === "attendance" && deliverySettings.attendance_notifications_enabled === false
        ? "attendance_notifications_disabled"
        : null;
    if (deliverySkipReason) {
      const updated = await updateJob(job.id, "skipped", { error: deliverySkipReason }, job.claim_token, dbPool);
      if (updated) {
        await cleanupJobPortalAccess(job, portalAccessToken, dbPool);
        await auditJob(job, "whatsapp_job_skipped", { reason: deliverySkipReason });
      } else await auditStale(job, `${deliverySkipReason}_before_provider`);
      return;
    }
    const sendStart = await markSendStartedWithResult(job, type, dbPool);
    if (!sendStart.ok) {
      if (sendStart.settledStatus === "skipped") {
        await cleanupJobPortalAccess(job, portalAccessToken, dbPool);
        await auditJob(job, "whatsapp_job_skipped", { reason: sendStart.reason }).catch(() => undefined);
      } else if (sendStart.settledStatus === "pending") {
        await auditJob(job, "whatsapp_job_retry_scheduled", { reason: sendStart.reason }).catch(() => undefined);
      } else {
        await auditStale(job, "send_start");
      }
      return;
    }
    if (portalAccessToken) {
      await cleanupJobPortalAccess(job, null, dbPool);
      await createPortalAccessRecord(job.student_id, portalAccessToken, dbPool);
    }
    const messagePayload = { text: finalBody };
    console.log(`[WhatsApp] Sending TYPE: ${type}, TEMPLATE: ${templateIndex + 1}`);
    const providerResponse = await withTimeout(
      (provider || state.socket).sendMessage(`${eligibility.phone.slice(1)}@s.whatsapp.net`, messagePayload),
      JOB_PROVIDER_TIMEOUT_MS,
      "whatsapp_provider_timeout"
    );
    providerAccepted = true;
    providerMessageId = providerResponse?.key?.id || null;
    if (!ownsSession() || (!ownership && !isLocallyWithinConfirmedLease())) throw new Error("whatsapp_ownership_lost_during_send");
    state.lastSentAt = Date.now();
    const completed = await completeSentJob(job, providerMessageId, dbPool);
    if (!completed) {
      await auditStale(job, "sent_completion");
      return;
    }
    await auditJob(job, "whatsapp_job_accepted", { provider_message_id: providerResponse?.key?.id || null });
  } catch (error) {
    if (errorObserver) errorObserver(error);
    const reason = safeWorkerError(error);
    console.error("WhatsApp notification worker error", reason);
    if (job?.id) {
      const deliveryUnknown = reason === "whatsapp_provider_timeout" || reason === "whatsapp_ownership_lost_during_send" || providerAccepted;
      if (deliveryUnknown) {
        await markDeliveryUnknown(job, reason, providerMessageId, dbPool, auditJob);
      } else {
        await cleanupJobPortalAccess(job, portalAccessToken, dbPool);
        const attempts = Number(job.attempts || 0);
        const retry = attempts < 3;
        const retryDelayMs = Math.min(15 * 60_000, 15_000 * (2 ** Math.max(0, attempts - 1)));
        const updated = await updateJob(job.id, retry ? "pending" : "failed", {
          error: reason,
          nextAttemptAt: retry ? new Date(Date.now() + retryDelayMs) : null
        }, job.claim_token, dbPool);
        if (updated) await auditJob(job, retry ? "whatsapp_job_retry_scheduled" : "whatsapp_job_failed", { reason }).catch(() => undefined);
        else await auditStale(job, "worker_error");
      }
    }
  } finally {
    state.workerRunning = false;
  }
}

// Test-only worker seam. It injects the database and provider while keeping
// the production worker path above unchanged; no WhatsApp socket or audit
// tables are needed by tests that opt into the fake ownership callbacks.
export async function processWhatsAppJobForTest({ dbPool = pool, provider, settings, ownership = {}, errorObserver = null } = {}) {
  if (!provider || typeof provider.sendMessage !== "function") throw new Error("test_provider_required");
  const previous = {
    status: state.status,
    socket: state.socket,
    ownsWhatsAppSession: state.ownsWhatsAppSession,
    confirmedWhatsAppLeaseExpiresAt: state.confirmedWhatsAppLeaseExpiresAt,
    workerRunning: state.workerRunning
  };
  state.status = "connected";
  state.socket = provider;
  state.ownsWhatsAppSession = true;
  state.confirmedWhatsAppLeaseExpiresAt = Date.now() + JOB_LEASE_MS;
  state.workerRunning = false;
  try {
    return await processWhatsAppJob({
      dbPool,
      provider,
      settingsOverride: settings,
      auditEnabled: false,
      errorObserver,
      ownership: {
        owns: ownership.owns || (() => true),
        connected: ownership.connected || (() => true),
        renew: ownership.renew || (async () => true),
        verify: ownership.verify || (async () => true)
      }
    });
  } finally {
    state.status = previous.status;
    state.socket = previous.socket;
    state.ownsWhatsAppSession = previous.ownsWhatsAppSession;
    state.confirmedWhatsAppLeaseExpiresAt = previous.confirmedWhatsAppLeaseExpiresAt;
    state.workerRunning = previous.workerRunning;
  }
}

export function wakeWhatsAppWorker() {
  if (!WHATSAPP_ENABLED) return;
  if (!state.workerTimer) void processWhatsAppJob();
}

export function startWhatsAppWorker() {
  if (!WHATSAPP_ENABLED) return;
  if (state.workerTimer) return;
  void recoverStaleWhatsAppJobs().catch((error) => console.error("Failed to recover WhatsApp notification jobs", safeWorkerError(error)));
  state.workerRecoveryTimer = setInterval(() => {
    void recoverStaleWhatsAppJobs().catch((error) => console.error("Failed to recover WhatsApp notification jobs", safeWorkerError(error)));
  }, 60_000);
  state.workerTimer = setInterval(() => { void processWhatsAppJob(); }, 1000);
  void processWhatsAppJob();
}

export async function startWhatsAppService() {
  if (!WHATSAPP_ENABLED) {
    state.status = "disabled";
    return getWhatsAppStatus();
  }
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
