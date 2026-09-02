import { query } from "../db/pool.js";
import { verifyPassword } from "./auth.js";
import { normalizeDigits } from "../utils/normalizeDigits.js";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEYS = new Set([
  "password",
  "current_password",
  "new_password",
  "pin",
  "token",
  "authorization",
  "national_id",
  "national_id_hash",
  "api_key",
  "resend_api_key",
  "password_reset_secret",
  "settings_encryption_key",
  "confirmation"
]);

function isSensitiveKey(key) {
  const normalized = String(key).toLowerCase();
  return SENSITIVE_KEYS.has(normalized) || normalized.includes("password") || normalized.includes("token") || normalized.includes("secret") || normalized.includes("apikey") || normalized.includes("api_key") || normalized.includes("encrypted_value") || normalized.includes("auth_tag");
}

export function sanitizeAuditValue(value, key = "") {
  if (isSensitiveKey(key)) return REDACTED;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > 4000 ? `${value.slice(0, 4000)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => sanitizeAuditValue(entry));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([entryKey, entryValue]) => [entryKey, sanitizeAuditValue(entryValue, entryKey)]));
  }
  return value;
}

export function auditSafeBody(value) {
  return sanitizeAuditValue(value && typeof value === "object" ? value : {});
}

export async function verifyAuditPin({ teacherId, pin, purpose = "protected_action", request = null, db = query }) {
  const execute = typeof db === "function" ? db : db.query.bind(db);
  const normalizedPin = normalizeDigits(String(pin || "")).trim();
  if (!/^\d{4}$/.test(normalizedPin)) return { ok: false, status: "invalid_audit_pin" };

  const result = await execute(
    "SELECT audit_pin_hash, audit_pin_failed_attempts, audit_pin_locked_until FROM teachers WHERE id = $1 AND is_active = TRUE AND deleted_at IS NULL",
    [teacherId]
  );
  if (!result.rowCount || !result.rows[0].audit_pin_hash) return { ok: false, status: "audit_pin_not_configured" };

  const record = result.rows[0];
  if (record.audit_pin_locked_until && new Date(record.audit_pin_locked_until).getTime() > Date.now()) {
    return {
      ok: false,
      status: "audit_pin_locked",
      retry_after_seconds: Math.ceil((new Date(record.audit_pin_locked_until).getTime() - Date.now()) / 1000)
    };
  }

  if (!verifyPassword(normalizedPin, record.audit_pin_hash)) {
    const failedAttempts = Number(record.audit_pin_failed_attempts || 0) + 1;
    const lockedUntil = failedAttempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
    await execute(
      "UPDATE teachers SET audit_pin_failed_attempts = $1, audit_pin_locked_until = $2 WHERE id = $3",
      [lockedUntil ? 0 : failedAttempts, lockedUntil, teacherId]
    );
    await auditLog({
      action: "audit_pin_failed",
      actorId: teacherId,
      details: { reason: purpose, locked: Boolean(lockedUntil), failed_attempts: failedAttempts },
      request,
      db: execute
    });
    return {
      ok: false,
      status: lockedUntil ? "audit_pin_locked" : "invalid_audit_pin",
      retry_after_seconds: lockedUntil ? 900 : undefined
    };
  }

  await execute("UPDATE teachers SET audit_pin_failed_attempts = 0, audit_pin_locked_until = NULL WHERE id = $1", [teacherId]);
  return { ok: true };
}

export function auditRequestDetails(req, statusCode = null) {
  return {
    request: {
      method: req.method,
      path: req.originalUrl?.split("?")[0] || req.path,
      status_code: statusCode ?? null,
      ip: req.ip,
      user_agent: req.get?.("user-agent") || null
    },
    query: auditSafeBody(Object.fromEntries(Object.entries(req.query || {}).filter(([key]) => !isSensitiveKey(key)))),
    body: auditSafeBody(req.body)
  };
}

export function changedFields(before, after, fields = null) {
  const keys = fields || [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])];
  return keys
    .filter((field) => JSON.stringify(before?.[field] ?? null) !== JSON.stringify(after?.[field] ?? null))
    .map((field) => ({ field, before: sanitizeAuditValue(before?.[field], field), after: sanitizeAuditValue(after?.[field], field) }));
}

function actionForRequest(req) {
  const path = req.path;
  if (/\/teacher\/login$|\/student\/login$/.test(path)) return "login";
  if (/\/logout$/.test(path)) return "logout";
  if (/\/fees\/payments\/\d+\/reverse$/.test(path)) return "payment_reversed";
  if (/\/fees\/advance-payments$/.test(path)) return "advance_payment_created";
  if (/\/fees\/payments$/.test(path)) return "payment_created";
  if (/\/scanner\/attendance$/.test(path)) return "attendance_scanned";
  if (/\/attendance\/(manual|sessions)$/.test(path)) return path.endsWith("/sessions") ? "attendance_session_changed" : "attendance_changed";
  if (/\/groups\/.+\/status$/.test(path)) return "group_status_changed";
  if (/\/groups\/\d+$/.test(path)) return req.method === "DELETE" ? "group_archived" : "group_updated";
  if (/\/groups$/.test(path)) return req.method === "POST" ? "group_created" : "group_changed";
  if (/\/exams\/results/.test(path)) return req.method === "DELETE" ? "exam_result_deleted" : "exam_result_changed";
  if (/\/homework/.test(path)) return req.method === "POST" ? "homework_created" : req.method === "DELETE" ? "homework_deleted" : "homework_updated";
  if (/\/notes/.test(path)) return req.method === "POST" ? "note_created" : req.method === "DELETE" ? "note_deleted" : "note_updated";
  if (/\/students\/.+\/print-label$/.test(path)) return "student_label_printed";
  if (/\/students\/.+\/regenerate-scan-serial$/.test(path)) return "student_scan_serial_regenerated";
  if (/\/students\/bulk-delete$/.test(path)) return "students_bulk_archived";
  if (/\/students\/bulk-permanent$/.test(path)) return "students_bulk_permanently_deleted";
  if (/\/students\/.+\/status$/.test(path)) return "student_status_changed";
  if (/\/students\/.+\/restore$/.test(path)) return "student_restored";
  if (/\/students\/\d+$/.test(path)) return req.method === "DELETE" ? "student_archived" : "student_changed";
  if (/\/students$/.test(path)) return req.method === "POST" ? "student_created" : req.method === "DELETE" ? "student_archived" : "student_changed";
  if (/\/users\/.+\/reset-password$/.test(path)) return "user_password_reset";
  if (/\/users\/.+\/status$/.test(path)) return "user_status_changed";
  if (/\/users\/.+\/restore$/.test(path)) return "user_restored";
  if (/\/users\/\d+$/.test(path)) return req.method === "DELETE" ? "user_archived" : "user_changed";
  if (/\/users$/.test(path)) return req.method === "POST" ? "user_created" : "user_changed";
  if (/\/inbox/.test(path)) return path.includes("read") ? "message_read_status_changed" : req.method === "DELETE" ? "message_deleted" : "message_sent";
  if (/\/site\/pages/.test(path)) return "site_page_updated";
  if (/\/contact$/.test(path)) return "public_inquiry_created";
  if (/\/audit-logs\/pin$/.test(path)) return "audit_pin_changed";
  if (/\/audit-logs\/unlock$/.test(path)) return "audit_logs_unlocked";
  return "system_action";
}

export async function auditLog({
  action,
  actorId = null,
  studentId = null,
  paymentId = null,
  sessionId = null,
  details = {},
  request = null,
  db = query,
  throwOnError = false
}) {
  const execute = typeof db === "function" ? db : db.query.bind(db);
  const structuredDetails = sanitizeAuditValue({
    ...details,
    audit_version: 2,
    action,
    ...(request ? auditRequestDetails(request, null) : {})
  });
  try {
    const result = await execute(
      `INSERT INTO audit_logs (action, actor_id, student_id, payment_id, session_id, details)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id, created_at`,
      [action, actorId, studentId, paymentId, sessionId, JSON.stringify(structuredDetails)]
    );
    if (request) request.auditLogged = true;
    return result.rows?.[0] || null;
  } catch (error) {
    console.error("Failed to write audit log", { action, error: error.message });
    if (throwOnError) throw error;
    return null;
  }
}

export function installAuditFallback(app) {
  app.use((req, res, next) => {
    res.on("finish", () => {
      if (req.auditLogged || req.path.includes("/audit-logs") || req.path === "/api/health") return;
      if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
      const actorId = Number(req.teacher?.id || req.teacher?.sub) || null;
      const details = {
        ...auditRequestDetails(req, res.statusCode),
        outcome: res.statusCode >= 200 && res.statusCode < 400 ? "success" : "failure"
      };
      const studentMatch = req.path.match(/\/students\/(\d+)/);
      const paymentMatch = req.path.match(/\/payments\/(\d+)/);
      auditLog({
        action: actionForRequest(req),
        actorId,
        studentId: Number(studentMatch?.[1]) || Number(req.body?.student_id) || null,
        paymentId: Number(paymentMatch?.[1]) || Number(req.body?.payment_id) || null,
        details,
        request: null
      });
    });
    next();
  });
}
