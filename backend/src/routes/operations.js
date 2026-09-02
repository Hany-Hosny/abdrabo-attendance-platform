import crypto from "node:crypto";
import express from "express";
import { pool, query } from "../db/pool.js";
import { requireAnyPermission, requirePermission, requireRoles, requireTeacher } from "../middleware/requireTeacher.js";
import { createAuditAccessToken, hashPassword, verifyAuditAccessToken, verifyPassword } from "../services/auth.js";
import { ensureMonthlyFees, getAdvanceOptions, getFeeSummary, recordAdvancePayment, recordFullPayment } from "../services/fees.js";
import { finalizeExpiredAttendanceSessions } from "../services/attendanceFinalizer.js";
import { normalizeDigits } from "../utils/normalizeDigits.js";
import { auditLog } from "../services/audit.js";
import { getAttendanceTimingDefaults } from "../services/systemSettings.js";
import { isValidScanValue, normalizeIdempotencyKey, normalizeScanValue, scanLookupValues } from "../utils/scan.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { hasPermission } from "../services/rbac.js";

export const operationsRouter = express.Router();
operationsRouter.use(requireTeacher);
// Every fee/payment workflow is gated by the base view capability. Action and
// report middleware below then apply the narrower capability for that route.
operationsRouter.use("/fees/payments", requirePermission("payments.view"));
operationsRouter.use("/fees/overdue", requirePermission("payments.view"));
const scannerRateLimit = createRateLimiter({ windowMs: 60_000, max: 180, key: (req) => `scanner:${req.teacher?.id || req.ip}` });
const paymentRateLimit = createRateLimiter({ windowMs: 60_000, max: 30, key: (req) => `payment:${req.teacher?.id || req.ip}` });

const studentDetails = `SELECT s.id, s.full_name, s.student_serial, s.scan_serial, s.student_code, s.qr_token, s.group_id,
  s.phone, s.guardian_phone, s.is_active, g.name AS group_name, COALESCE(g.grade_level,g.grade) AS grade_level,
  g.fees_amount, g.is_active AS group_active FROM students s JOIN groups g ON g.id=s.group_id AND s.deleted_at IS NULL`;

function normalizedSearch(value) {
  return normalizeDigits(value).trim().toLocaleLowerCase("ar-EG")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[إأآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/ـ/g, "");
}

function searchableSql(field) {
  return `LOWER(${field}) ILIKE '%' || $SEARCH || '%' OR LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(${field},'إ','ا'),'أ','ا'),'آ','ا'),'ٱ','ا'),'ى','ي'),'ة','ه')) ILIKE '%' || $SEARCH || '%'`;
}

const activePaymentFilter = "NOT EXISTS (SELECT 1 FROM payment_reversals pr WHERE pr.payment_id = p.id)";
const paymentMethods = new Set(["cash", "bank_transfer", "card", "other"]);

function collectionSummary(summary) {
  if (!summary) return null;
  const allowedFields = [
    "id", "full_name", "student_serial", "student_code", "group_name", "grade_level",
    "required_amount", "paid_amount", "remaining_balance", "current_cycle_fee",
    "current_cycle_paid", "current_cycle_outstanding", "payment_status", "monthly_dues"
  ];
  return Object.fromEntries(allowedFields.filter((field) => Object.prototype.hasOwnProperty.call(summary, field)).map((field) => [field, summary[field]]));
}

function requireAuditAccess(req, res, next) {
  if (!verifyAuditAccessToken(req.headers["x-audit-access-token"], req.teacher.id)) {
    return res.status(403).json({ ok: false, status: "audit_access_required" });
  }
  return next();
}

function auditDateRange(fromValue, toValue) {
  const dateFrom = normalizeDigits(String(fromValue || "")).trim();
  const dateTo = normalizeDigits(String(toValue || "")).trim();
  const isValidDate = (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  };
  if (!isValidDate(dateFrom) || !isValidDate(dateTo)) return null;
  return dateFrom <= dateTo ? { dateFrom, dateTo } : { dateFrom: dateTo, dateTo: dateFrom };
}

operationsRouter.get("/payments/report", requirePermission("payments.view"), requirePermission("payments.reports.view"), async (req, res, next) => {
  try {
    const values = [];
    const filters = ["TRUE"];
    const paymentTimestamp = "COALESCE(p.paid_at, p.payment_date::timestamp AT TIME ZONE 'Africa/Cairo')";
    const add = (sql, value) => { values.push(value); filters.push(sql.replaceAll("?", `$${values.length}`)); };
    const search = normalizedSearch(req.query.q);
    if (search) {
      values.push(`%${search}%`);
      const searchParam = `$${values.length}`;
      const nationalIdHash = crypto.createHash("sha256").update(normalizeDigits(req.query.q).trim()).digest("hex");
      values.push(nationalIdHash);
      const hashParam = `$${values.length}`;
      filters.push(`(COALESCE(p.student_name_snapshot,s.full_name) ILIKE ${searchParam} OR COALESCE(p.student_code_snapshot,s.student_code) ILIKE ${searchParam} OR COALESCE(p.student_serial_snapshot,s.student_serial) ILIKE ${searchParam} OR COALESCE(p.scan_serial_snapshot,s.scan_serial) ILIKE ${searchParam} OR s.phone ILIKE ${searchParam} OR s.guardian_phone ILIKE ${searchParam} OR COALESCE(p.group_name_snapshot,COALESCE(g.display_name,g.name)) ILIKE ${searchParam} OR COALESCE(p.grade_level_snapshot,COALESCE(g.grade_level,g.grade)) ILIKE ${searchParam} OR s.national_id_hash = ${hashParam})`);
    }
    if (req.query.date_from) add(`${paymentTimestamp} >= (?::date::timestamp AT TIME ZONE 'Africa/Cairo')`, normalizeDigits(req.query.date_from).trim());
    if (req.query.date_to) add(`${paymentTimestamp} < (((?::date + INTERVAL '1 day')::timestamp) AT TIME ZONE 'Africa/Cairo')`, normalizeDigits(req.query.date_to).trim());
    if (req.query.group_id) {
      const groupValue = normalizeDigits(req.query.group_id).trim();
      if (/^\d+$/.test(groupValue)) add("g.id = ?", Number(groupValue));
      else add("COALESCE(g.display_name,g.name) ILIKE ?", `%${groupValue}%`);
    }
    if (req.query.grade_level) add("COALESCE(g.grade_level,g.grade) ILIKE ?", `%${normalizeDigits(req.query.grade_level).trim()}%`);
    const result = await query(`SELECT p.id, ${paymentTimestamp} AS paid_at, p.amount, p.payment_months, p.payment_type,
        COALESCE(p.student_name_snapshot,s.full_name) AS full_name,
        COALESCE(p.student_code_snapshot,s.student_code) AS student_code,
        COALESCE(p.student_serial_snapshot,s.student_serial) AS student_serial,
        COALESCE(p.scan_serial_snapshot,s.scan_serial) AS scan_serial,
        COALESCE(p.group_name_snapshot,COALESCE(g.display_name,g.name)) AS group_name,
        COALESCE(p.grade_level_snapshot,COALESCE(g.grade_level,g.grade)) AS grade_level,
        COALESCE(u.name,u.username,u.email,'Staff') AS paid_by
      FROM payments p LEFT JOIN students s ON s.id=p.student_id JOIN groups g ON g.id=p.group_id
      LEFT JOIN teachers u ON u.id=COALESCE(p.paid_by,p.recorded_by)
      WHERE ${filters.join(" AND ")} AND ${activePaymentFilter} ORDER BY ${paymentTimestamp} DESC`, values);
    res.json({ ok: true, payments: result.rows, total_paid: result.rows.reduce((sum, row) => sum + Number(row.amount), 0), payment_count: result.rowCount });
  } catch (error) { next(error); }
});

operationsRouter.post("/fees/payments/:paymentId/reverse", requirePermission("payments.view"), requirePermission("payments.reverse"), async (req, res, next) => {
  const paymentId = Number(req.params.paymentId);
  const reason = String(req.body?.reason || "").trim();
  if (!Number.isSafeInteger(paymentId) || paymentId <= 0) return res.status(400).json({ ok: false, status: "invalid_payment" });
  if (reason.length < 3 || reason.length > 500) return res.status(400).json({ ok: false, status: "invalid_reason", message: "A reversal reason is required. / يجب إدخال سبب عكس الدفعة." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const paymentResult = await client.query(`
      SELECT p.*, s.full_name, s.student_code, s.student_serial, s.scan_serial,
        COALESCE(g.display_name, g.name) AS group_name,
        COALESCE(g.grade_level, g.grade) AS grade_level
      FROM payments p
      LEFT JOIN students s ON s.id = p.student_id
      JOIN groups g ON g.id = p.group_id
      WHERE p.id = $1
      FOR UPDATE
    `, [paymentId]);
    if (!paymentResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, status: "payment_not_found" });
    }
    const payment = paymentResult.rows[0];
    const existing = await client.query("SELECT id, created_at FROM payment_reversals WHERE payment_id = $1", [paymentId]);
    if (existing.rowCount) {
      await client.query("ROLLBACK");
      return res.status(409).json({ ok: false, status: "already_reversed", reversal: existing.rows[0] });
    }

    const reversal = await client.query(`
      INSERT INTO payment_reversals (payment_id, reversed_by, reason, original_amount)
      VALUES ($1, $2, $3, $4)
      RETURNING id, payment_id, reversed_by, reason, original_amount, created_at
    `, [paymentId, req.teacher.id, reason, payment.amount]);

    const months = Array.isArray(payment.payment_months) ? payment.payment_months : [];
    for (const covered of months) {
      const month = String(covered?.month || "").slice(0, 10);
      const amount = Number(covered?.amount || 0);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(month) || !Number.isFinite(amount) || amount <= 0) continue;
      await client.query(`
        UPDATE fee_dues
        SET paid_amount = GREATEST(0, paid_amount - $1)
        WHERE student_id = $2 AND due_month = $3::date
      `, [amount, payment.student_id, month]);
    }

    await auditLog({ db: client, action: "payment_reversed", actorId: req.teacher.id, studentId: payment.student_id, paymentId, request: req, details: {
      reversal_id: reversal.rows[0].id,
      reason,
      original_amount: Number(payment.amount),
      status_before: "paid",
      status_after: "reversed",
      payment_date: payment.payment_date,
      payment_type: payment.payment_type,
      payment_method: payment.payment_method,
      payment_months: months,
      student_name_snapshot: payment.student_name_snapshot || payment.full_name,
      student_code_snapshot: payment.student_code_snapshot || payment.student_code,
      student_serial_snapshot: payment.student_serial_snapshot || payment.student_serial,
      group_name_snapshot: payment.group_name_snapshot || payment.group_name,
      grade_level_snapshot: payment.grade_level_snapshot || payment.grade_level
    }});
    await client.query("COMMIT");
    return res.status(201).json({ ok: true, reversal: reversal.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

operationsRouter.get("/audit-logs/status", requirePermission("activity_log.view"), async (req, res, next) => {
  try {
    const result = await query("SELECT audit_pin_hash IS NOT NULL AS configured FROM teachers WHERE id = $1", [req.teacher.id]);
    res.json({ ok: true, configured: Boolean(result.rows[0]?.configured) });
  } catch (error) { next(error); }
});

operationsRouter.post("/audit-logs/pin", requirePermission("activity_log.view"), async (req, res, next) => {
  try {
    const pin = normalizeDigits(req.body?.pin || "").trim();
    const currentPassword = String(req.body?.current_password || "");
    if (!/^\d{4}$/.test(pin)) return res.status(400).json({ ok: false, status: "invalid_pin", message: "PIN must contain exactly 4 digits. / يجب أن يتكون الرقم السري من 4 أرقام." });
    const admin = await query("SELECT password_hash FROM teachers WHERE id = $1 AND role IN ('owner','admin') AND is_active = TRUE AND deleted_at IS NULL", [req.teacher.id]);
    if (!admin.rowCount || !verifyPassword(currentPassword, admin.rows[0].password_hash)) return res.status(403).json({ ok: false, status: "invalid_admin_password" });
    await query("UPDATE teachers SET audit_pin_hash = $1, audit_pin_failed_attempts = 0, audit_pin_locked_until = NULL, updated_at = NOW() WHERE id = $2", [hashPassword(pin), req.teacher.id]);
    await auditLog({ action: "audit_pin_changed", actorId: req.teacher.id, details: { pin_digits: 4, change: "Audit PIN was replaced." }, request: req });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

operationsRouter.post("/audit-logs/unlock", requirePermission("activity_log.view"), async (req, res, next) => {
  const pin = normalizeDigits(req.body?.pin || "").trim();
  if (!/^\d{4}$/.test(pin)) return res.status(400).json({ ok: false, status: "invalid_pin" });
  try {
    const admin = await query("SELECT audit_pin_hash, audit_pin_failed_attempts, audit_pin_locked_until FROM teachers WHERE id = $1 AND role IN ('owner','admin') AND is_active = TRUE AND deleted_at IS NULL", [req.teacher.id]);
    if (!admin.rowCount || !admin.rows[0].audit_pin_hash) return res.status(409).json({ ok: false, status: "audit_pin_not_configured" });
    const record = admin.rows[0];
    if (record.audit_pin_locked_until && new Date(record.audit_pin_locked_until).getTime() > Date.now()) return res.status(429).json({ ok: false, status: "audit_pin_locked", retry_after_seconds: Math.ceil((new Date(record.audit_pin_locked_until).getTime() - Date.now()) / 1000) });
    if (!verifyPassword(pin, record.audit_pin_hash)) {
      const failedAttempts = Number(record.audit_pin_failed_attempts || 0) + 1;
      const lockedUntil = failedAttempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
      await query("UPDATE teachers SET audit_pin_failed_attempts = $1, audit_pin_locked_until = $2 WHERE id = $3", [lockedUntil ? 0 : failedAttempts, lockedUntil, req.teacher.id]);
      await auditLog({ action: "audit_pin_failed", actorId: req.teacher.id, details: { locked: Boolean(lockedUntil), failed_attempts: failedAttempts }, request: req });
      return res.status(401).json({ ok: false, status: lockedUntil ? "audit_pin_locked" : "invalid_pin", retry_after_seconds: lockedUntil ? 900 : undefined });
    }
    await query("UPDATE teachers SET audit_pin_failed_attempts = 0, audit_pin_locked_until = NULL WHERE id = $1", [req.teacher.id]);
    await auditLog({ action: "audit_logs_unlocked", actorId: req.teacher.id, details: { access_duration_minutes: 10 }, request: req });
    res.json({ ok: true, audit_access_token: createAuditAccessToken(req.teacher.id), expires_in_seconds: 600 });
  } catch (error) { next(error); }
});

operationsRouter.get("/audit-logs/maintenance/preview", requirePermission("activity_log.view"), requireRoles("owner", "admin"), requireAuditAccess, async (req, res, next) => {
  try {
    const range = auditDateRange(req.query.date_from, req.query.date_to);
    if (!range) return res.status(400).json({ ok: false, status: "invalid_date_range" });
    const result = await query(`
      SELECT COUNT(*)::int AS count
      FROM audit_logs
      WHERE created_at >= (CAST(CAST($1 AS date) AS timestamp) AT TIME ZONE 'Africa/Cairo')
        AND created_at < (CAST(CAST($2 AS date) + INTERVAL '1 day' AS timestamp) AT TIME ZONE 'Africa/Cairo')
    `, [range.dateFrom, range.dateTo]);
    res.json({ ok: true, count: Number(result.rows[0]?.count || 0), date_from: range.dateFrom, date_to: range.dateTo });
  } catch (error) { next(error); }
});

operationsRouter.post("/audit-logs/maintenance/delete", requirePermission("activity_log.view"), requireRoles("owner", "admin"), requireAuditAccess, async (req, res, next) => {
  const range = auditDateRange(req.body?.date_from, req.body?.date_to);
  const pin = normalizeDigits(req.body?.pin || "").trim();
  const currentPassword = String(req.body?.current_password || "");
  const reason = String(req.body?.reason || "").trim();
  const confirmation = String(req.body?.confirmation || "").trim();
  if (!range) return res.status(400).json({ ok: false, status: "invalid_date_range" });
  if (!/^\d{4}$/.test(pin)) return res.status(400).json({ ok: false, status: "invalid_pin" });
  if (confirmation !== "DELETE AUDIT LOGS") return res.status(400).json({ ok: false, status: "invalid_confirmation" });
  if (reason.length < 3 || reason.length > 500) return res.status(400).json({ ok: false, status: "invalid_reason" });

  try {
    const admin = await query("SELECT password_hash, audit_pin_hash, audit_pin_failed_attempts, audit_pin_locked_until FROM teachers WHERE id = $1 AND role IN ('owner','admin') AND is_active = TRUE AND deleted_at IS NULL", [req.teacher.id]);
    if (!admin.rowCount || !admin.rows[0].audit_pin_hash) return res.status(409).json({ ok: false, status: "audit_pin_not_configured" });
    const record = admin.rows[0];
    if (record.audit_pin_locked_until && new Date(record.audit_pin_locked_until).getTime() > Date.now()) return res.status(429).json({ ok: false, status: "audit_pin_locked", retry_after_seconds: Math.ceil((new Date(record.audit_pin_locked_until).getTime() - Date.now()) / 1000) });
    if (!verifyPassword(pin, record.audit_pin_hash)) {
      const failedAttempts = Number(record.audit_pin_failed_attempts || 0) + 1;
      const lockedUntil = failedAttempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
      await query("UPDATE teachers SET audit_pin_failed_attempts = $1, audit_pin_locked_until = $2 WHERE id = $3", [lockedUntil ? 0 : failedAttempts, lockedUntil, req.teacher.id]);
      await auditLog({ action: "audit_pin_failed", actorId: req.teacher.id, details: { reason: "audit_log_deletion", locked: Boolean(lockedUntil), failed_attempts: failedAttempts }, request: req });
      return res.status(401).json({ ok: false, status: lockedUntil ? "audit_pin_locked" : "invalid_pin", retry_after_seconds: lockedUntil ? 900 : undefined });
    }
    if (!verifyPassword(currentPassword, record.password_hash)) return res.status(403).json({ ok: false, status: "invalid_admin_password" });
    await query("UPDATE teachers SET audit_pin_failed_attempts = 0, audit_pin_locked_until = NULL WHERE id = $1", [req.teacher.id]);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const deleted = await client.query(`
        WITH deleted AS (
          DELETE FROM audit_logs
          WHERE created_at >= (CAST(CAST($1 AS date) AS timestamp) AT TIME ZONE 'Africa/Cairo')
            AND created_at < (CAST(CAST($2 AS date) + INTERVAL '1 day' AS timestamp) AT TIME ZONE 'Africa/Cairo')
          RETURNING id
        )
        SELECT COUNT(*)::int AS deleted_count FROM deleted
      `, [range.dateFrom, range.dateTo]);
      const deletedCount = Number(deleted.rows[0]?.deleted_count || 0);
      await client.query(`
        INSERT INTO audit_log_deletions (actor_id, date_from, date_to, deleted_count, reason, ip_address, user_agent)
        VALUES ($1, $2::date, $3::date, $4, $5, $6, $7)
      `, [req.teacher.id, range.dateFrom, range.dateTo, deletedCount, reason, req.ip, req.get("user-agent") || null]);
      await client.query("COMMIT");
      return res.json({ ok: true, deleted_count: deletedCount, date_from: range.dateFrom, date_to: range.dateTo });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      return next(error);
    } finally {
      client.release();
    }
  } catch (error) { next(error); }
});

operationsRouter.get("/audit-logs", requirePermission("activity_log.view"), requireAuditAccess, async (req, res, next) => {
  try {
    const values = [];
    const filters = ["TRUE"];
    const add = (sql, value) => { values.push(value); filters.push(sql.replaceAll("?", `$${values.length}`)); };
    const search = normalizedSearch(req.query.q || req.query.search);
    if (search) add(`(a.action ILIKE ? OR COALESCE(t.name,'') ILIKE ? OR COALESCE(t.username,'') ILIKE ? OR COALESCE(t.email,'') ILIKE ? OR COALESCE(s.full_name,'') ILIKE ? OR COALESCE(s.student_code,'') ILIKE ? OR a.details::text ILIKE ?)`, `%${search}%`);
    if (req.query.action) add("a.action = ?", String(req.query.action).trim());
    if (req.query.actor_id || req.query.user_id) add("a.actor_id = ?", Number(req.query.actor_id || req.query.user_id));
    if (req.query.student_id) add("a.student_id = ?", Number(req.query.student_id));
    if (req.query.payment_id) add("a.payment_id = ?", Number(req.query.payment_id));
    if (req.query.date_from) add("a.created_at >= (CAST(CAST(? AS date) AS timestamp) AT TIME ZONE 'Africa/Cairo')", String(req.query.date_from).trim());
    if (req.query.date_to) add("a.created_at < (CAST(CAST(? AS date) + INTERVAL '1 day' AS timestamp) AT TIME ZONE 'Africa/Cairo')", String(req.query.date_to).trim());
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    values.push(limit, (page - 1) * limit);
    const result = await query(`
      SELECT a.id, a.action, a.actor_id, a.student_id, a.payment_id, a.session_id, a.details, a.created_at,
        t.name AS actor_name, t.username AS actor_username, t.email AS actor_email, t.role AS actor_role,
        COALESCE(s.full_name, p.student_name_snapshot) AS student_name,
        COALESCE(s.student_code, p.student_code_snapshot) AS student_code,
        p.amount AS payment_amount, p.payment_type, pr.id AS reversal_id, pr.reason AS reversal_reason
      FROM audit_logs a
      LEFT JOIN teachers t ON t.id = a.actor_id
      LEFT JOIN students s ON s.id = a.student_id
      LEFT JOIN payments p ON p.id = a.payment_id
      LEFT JOIN payment_reversals pr ON pr.payment_id = a.payment_id
      WHERE ${filters.join(" AND ")}
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $${values.length - 1} OFFSET $${values.length}
    `, values);
    const countResult = await query(`
      SELECT COUNT(*)::int AS total
      FROM audit_logs a
      LEFT JOIN teachers t ON t.id = a.actor_id
      LEFT JOIN students s ON s.id = a.student_id
      WHERE ${filters.join(" AND ")}
    `, values.slice(0, -2));
    const logs = result.rows.map((row) => {
      let action = row.action;
      if (action !== "system_request") return { ...row, details: { ...(row.details || {}), _audit_action: action, _payment_id: row.payment_id, _payment_amount: row.payment_amount, _student_name: row.student_name, _student_code: row.student_code } };
      const request = row.details?.request && typeof row.details.request === "object" ? row.details.request : {};
      const path = String(row.details?.path || request.path || "");
      const method = row.details?.method || request.method;
      if (path.includes("/reset-password")) action = "user_password_reset";
      else if (path.endsWith("/users") && method === "POST") action = "user_created";
      else if (path.includes("/users/") && method === "PUT") action = "user_updated";
      else if (path.includes("/users/") && method === "DELETE") action = "user_archived";
      else if (path.includes("/audit-logs/unlock")) action = "audit_logs_unlocked";
      else if (path.includes("/audit-logs/pin")) action = "audit_pin_changed";
      return { ...row, action, details: { ...(row.details || {}), _audit_action: action, _payment_id: row.payment_id, _payment_amount: row.payment_amount, _student_name: row.student_name, _student_code: row.student_code } };
    });
    res.json({ ok: true, logs, page, limit, total: countResult.rows[0]?.total || 0 });
  } catch (error) { next(error); }
});

operationsRouter.get("/payments/late", requirePermission("payments.view"), requirePermission("payments.reports.view"), async (req, res, next) => {
  try {
    await ensureMonthlyFees();
    const values = [];
    const filters = ["s.deleted_at IS NULL"];
    const add = (sql, value) => { values.push(value); filters.push(sql.replaceAll("?", `$${values.length}`)); };
    const search = normalizedSearch(req.query.q);
    if (search) {
      values.push(`%${search}%`);
      const searchParam = `$${values.length}`;
      values.push(crypto.createHash("sha256").update(normalizeDigits(req.query.q).trim()).digest("hex"));
      const hashParam = `$${values.length}`;
      filters.push(`(s.full_name ILIKE ${searchParam} OR s.student_code ILIKE ${searchParam} OR s.student_serial ILIKE ${searchParam} OR s.scan_serial ILIKE ${searchParam} OR s.phone ILIKE ${searchParam} OR s.guardian_phone ILIKE ${searchParam} OR COALESCE(g.display_name,g.name) ILIKE ${searchParam} OR COALESCE(g.grade_level,g.grade) ILIKE ${searchParam} OR s.national_id_hash = ${hashParam})`);
    }
    if (req.query.group_id) {
      const groupValue = normalizeDigits(req.query.group_id).trim();
      if (/^\d+$/.test(groupValue)) add("g.id = ?", Number(groupValue));
      else add("COALESCE(g.display_name,g.name) ILIKE ?", `%${groupValue}%`);
    }
    if (req.query.grade_level) add("COALESCE(g.grade_level,g.grade) ILIKE ?", `%${normalizeDigits(req.query.grade_level).trim()}%`);
    if (req.query.include_disabled !== "true") filters.push("s.is_active = TRUE");
    const from = normalizeDigits(req.query.date_from || "").trim() || null;
    const to = normalizeDigits(req.query.date_to || "").trim() || null;
    values.push(from, to);
    const fromParam = `$${values.length - 1}`;
    const toParam = `$${values.length}`;
    const result = await query(`WITH bounds AS (
        SELECT date_trunc('month', COALESCE(${fromParam}::date, (NOW() AT TIME ZONE 'Africa/Cairo')::date))::date AS month_from,
          date_trunc('month', COALESCE(${toParam}::date, (NOW() AT TIME ZONE 'Africa/Cairo')::date))::date AS month_to
      ), dues AS (
        SELECT fd.student_id, SUM(fd.amount) AS required_amount, SUM(fd.paid_amount) AS paid_amount,
          COALESCE(jsonb_agg(jsonb_build_object('month', fd.due_month, 'amount', fd.amount, 'paid_amount', fd.paid_amount, 'remaining_amount', fd.amount - fd.paid_amount) ORDER BY fd.due_month) FILTER (WHERE fd.amount > fd.paid_amount), '[]'::jsonb) AS unpaid_months
        FROM fee_dues fd CROSS JOIN bounds
        WHERE fd.due_month >= bounds.month_from AND fd.due_month <= bounds.month_to
        GROUP BY fd.student_id
      )
      SELECT s.id, s.full_name, s.student_code, s.student_serial, s.scan_serial, s.guardian_phone,
        COALESCE(g.display_name,g.name) AS group_name, COALESCE(g.grade_level,g.grade) AS grade_level,
        COALESCE(d.required_amount, 0) AS required_amount, COALESCE(d.paid_amount, 0) AS paid_amount,
        COALESCE(d.required_amount, 0) - COALESCE(d.paid_amount, 0) AS remaining_balance,
        d.unpaid_months, MAX(COALESCE(p.paid_at,p.payment_date)) AS last_payment_date
      FROM students s JOIN groups g ON g.id=s.group_id JOIN dues d ON d.student_id=s.id
      LEFT JOIN payments p ON p.student_id=s.id
      WHERE ${filters.join(" AND ")}
      GROUP BY s.id, g.id, d.required_amount, d.paid_amount, d.unpaid_months
      HAVING COALESCE(d.required_amount, 0) > COALESCE(d.paid_amount, 0)
      ORDER BY s.full_name`, values);
    res.json({ ok: true, students: result.rows, total_expected_unpaid: result.rows.reduce((sum, row) => sum + Number(row.remaining_balance), 0), late_student_count: result.rowCount });
  } catch (error) { next(error); }
});

operationsRouter.get("/attendance/sessions", requirePermission("attendance.view"), async (req, res, next) => {
  try {
    await finalizeExpiredAttendanceSessions();
    const date = normalizeDigits(req.query.date || new Date().toISOString().slice(0, 10)).trim();
    const timing = await getAttendanceTimingDefaults();
    const groupId = req.query.group_id ? Number(normalizeDigits(req.query.group_id)) : null;
    let groupFilter = "";
    if (groupId) groupFilter = " AND s.group_id=$2";
    await query(`
      INSERT INTO attendance_sessions (group_id, schedule_id, session_date, starts_at, opens_at, closes_at, ends_at, status)
      SELECT cs.group_id, cs.id, $1::date,
        (($1::date + cs.start_time) AT TIME ZONE 'Africa/Cairo'),
        (($1::date + cs.start_time - ((CASE WHEN cs.opens_before_minutes = 3 THEN $2 ELSE cs.opens_before_minutes END) || ' minutes')::interval) AT TIME ZONE 'Africa/Cairo'),
        (($1::date + cs.start_time + ((CASE WHEN cs.closes_after_minutes = 20 THEN $3 ELSE cs.closes_after_minutes END) || ' minutes')::interval) AT TIME ZONE 'Africa/Cairo'),
        (($1::date + cs.end_time) AT TIME ZONE 'Africa/Cairo'),
        'open'
      FROM class_schedules cs
      JOIN groups g ON g.id=cs.group_id AND g.is_active=TRUE AND g.deleted_at IS NULL
      WHERE cs.is_active=TRUE AND cs.day_of_week=EXTRACT(DOW FROM $1::date)::INTEGER
        ${groupId ? "AND cs.group_id=$4" : ""}
      ON CONFLICT (group_id, schedule_id, session_date) DO NOTHING
    `, groupId ? [date, timing.openBeforeMinutes, timing.closeAfterMinutes, groupId] : [date, timing.openBeforeMinutes, timing.closeAfterMinutes]);
    await finalizeExpiredAttendanceSessions();
    const resultParams = groupId ? [date, groupId] : [date];
    const result = await query(`SELECT s.*, g.name AS group_name, COALESCE(g.grade_level,g.grade) AS grade_level,
      cs.day_of_week, cs.start_time, cs.end_time
      FROM attendance_sessions s
      JOIN groups g ON g.id=s.group_id AND g.is_active=TRUE AND g.deleted_at IS NULL
      JOIN class_schedules cs ON cs.id=s.schedule_id AND cs.group_id=s.group_id
        AND cs.is_active=TRUE AND cs.day_of_week=EXTRACT(DOW FROM s.session_date)::INTEGER
      WHERE s.session_date=$1${groupFilter} ORDER BY cs.start_time`, resultParams);
    res.json({ ok: true, sessions: result.rows });
  } catch (error) { next(error); }
});

operationsRouter.post("/attendance/sessions", requirePermission("attendance.manage"), async (req, res, next) => {
  try {
    const groupId = Number(normalizeDigits(req.body?.group_id)), scheduleId = Number(normalizeDigits(req.body?.schedule_id));
    const date = String(req.body?.session_date || new Date().toISOString().slice(0, 10));
    if (!groupId || !scheduleId) return res.status(400).json({ ok:false, status:"invalid_session_payload" });
    const timing = await getAttendanceTimingDefaults();
    const result = await query(`INSERT INTO attendance_sessions (group_id,schedule_id,session_date,starts_at,opens_at,closes_at,ends_at,status)
      SELECT $1, cs.id, $3::date, (($3::date + cs.start_time) AT TIME ZONE 'Africa/Cairo'), (($3::date + cs.start_time - ((CASE WHEN cs.opens_before_minutes = 3 THEN $4 ELSE cs.opens_before_minutes END) || ' minutes')::interval) AT TIME ZONE 'Africa/Cairo'),
      (($3::date + cs.start_time + ((CASE WHEN cs.closes_after_minutes = 20 THEN $5 ELSE cs.closes_after_minutes END) || ' minutes')::interval) AT TIME ZONE 'Africa/Cairo'),
      (($3::date + cs.end_time) AT TIME ZONE 'Africa/Cairo'), 'open'
      FROM class_schedules cs JOIN groups g ON g.id=cs.group_id AND g.is_active=TRUE AND g.deleted_at IS NULL
      WHERE cs.id=$2 AND cs.group_id=$1 AND cs.is_active=TRUE
        AND cs.day_of_week=EXTRACT(DOW FROM $3::date)::INTEGER
      RETURNING *`, [groupId, scheduleId, date, timing.openBeforeMinutes, timing.closeAfterMinutes]);
    if (!result.rowCount) return res.status(400).json({ok:false,status:"invalid_schedule"});
    await auditLog({ action: "attendance_session_created", actorId: req.teacher.id, sessionId: result.rows[0].id, details: { group_id: groupId, schedule_id: scheduleId, session_date: date, status_after: result.rows[0].status }, request: req });
    res.status(201).json({ok:true,session:result.rows[0]});
  } catch (error) { if (error.code === "23505") return res.status(409).json({ok:false,status:"session_exists"}); next(error); }
});

operationsRouter.get("/attendance/sessions/:id/records", requirePermission("attendance.view"), async (req, res, next) => {
  try { await finalizeExpiredAttendanceSessions(); const result = await query(`SELECT ar.*, s.full_name, s.student_serial, COALESCE(g.grade_level,g.grade) AS grade_level, g.name AS group_name
    FROM attendance_records ar JOIN students s ON s.id=ar.student_id JOIN groups g ON g.id=s.group_id WHERE ar.session_id=$1 ORDER BY s.full_name`, [req.params.id]); res.json({ok:true,records:result.rows}); }
  catch (error) { next(error); }
});

operationsRouter.post("/scanner/student-lookup", requireAnyPermission("students.view", "attendance.view", "payments.view"), async (req, res, next) => {
  try {
    const value = normalizeScanValue(req.body?.value ?? req.body?.qr_token);
    const lookupValues = scanLookupValues(value).map((candidate) => candidate.toLowerCase());
    if (!isValidScanValue(value) || !lookupValues.length) return res.status(400).json({ ok: false, status: "invalid_scan_value" });
    const result = await query(`
      SELECT s.id, s.full_name, s.student_code, s.student_serial, s.scan_serial,
        s.group_id, s.is_active, s.deleted_at,
        g.name AS group_name, COALESCE(g.grade_level, g.grade) AS grade_level,
        g.is_active AS group_active
      FROM students s
      LEFT JOIN groups g ON g.id = s.group_id
      WHERE LOWER(COALESCE(s.qr_token, '')) = ANY($1::text[])
         OR LOWER(COALESCE(s.scan_serial, '')) = ANY($1::text[])
         OR LOWER(COALESCE(s.student_serial, '')) = ANY($1::text[])
         OR LOWER(COALESCE(s.student_code, '')) = ANY($1::text[])
      ORDER BY s.deleted_at NULLS FIRST, s.is_active DESC
      LIMIT 1
    `, [lookupValues]);
    if (!result.rowCount) return res.status(404).json({ ok: false, status: "student_not_found" });
    const student = result.rows[0];
    const status = student.deleted_at ? "deleted_student" : !student.is_active || student.group_active === false ? "inactive_student" : "student_found";
    return res.status(status === "student_found" ? 200 : 409).json({
      ok: status === "student_found",
      status,
      student: {
        id: student.id,
        full_name: student.full_name,
        student_code: student.student_code,
        student_serial: student.student_serial,
        scan_serial: student.scan_serial,
        group_id: student.group_id,
        group_name: student.group_name,
        grade_level: student.grade_level,
        is_active: student.is_active,
        deleted_at: student.deleted_at
      }
    });
  } catch (error) { next(error); }
});

operationsRouter.post("/fees/scan-lookup", requirePermission("payments.view"), async (req, res, next) => {
  try {
    const value = normalizeScanValue(req.body?.value ?? req.body?.qr_token);
    const lookupValues = scanLookupValues(value).map((candidate) => candidate.toLowerCase());
    if (!isValidScanValue(value) || !lookupValues.length) return res.status(400).json({ ok: false, status: "invalid_scan_value" });
    const studentResult = await query(`
      SELECT s.id, s.full_name, s.student_code, s.student_serial, s.scan_serial,
        s.is_active, s.deleted_at, g.name AS group_name,
        COALESCE(g.grade_level, g.grade) AS grade_level, g.is_active AS group_active
      FROM students s JOIN groups g ON g.id=s.group_id
      WHERE s.deleted_at IS NULL AND s.is_active=TRUE AND g.deleted_at IS NULL AND g.is_active=TRUE
        AND (LOWER(COALESCE(s.qr_token,''))=ANY($1::text[]) OR LOWER(COALESCE(s.scan_serial,''))=ANY($1::text[])
          OR LOWER(COALESCE(s.student_serial,''))=ANY($1::text[]) OR LOWER(COALESCE(s.student_code,''))=ANY($1::text[]))
      LIMIT 1
    `, [lookupValues]);
    if (!studentResult.rowCount) return res.status(404).json({ ok: false, status: "student_not_found" });
    const studentId = studentResult.rows[0].id;
    const mode = req.body?.mode === "advance" ? "advance" : "new";
    if (mode === "advance" && !hasPermission(req.teacher, "payments.advance")) {
      return res.status(403).json({ ok: false, status: "permission_required", permission: "payments.advance" });
    }
    const data = mode === "advance" ? await getAdvanceOptions(studentId) : await getFeeSummary(studentId);
    if (!data) return res.status(404).json({ ok: false, status: "student_not_found" });
    return res.json({ ok: true, status: "student_found", mode, ...(mode === "advance" ? data : { summary: collectionSummary(data) }) });
  } catch (error) { next(error); }
});

async function recordAttendance({ sessionId, studentId, actorId, method = "scanner", status = "present", ip, deviceId, idempotencyKey = null, request }) {
  const result = await query(`INSERT INTO attendance_records (session_id,student_id,status,method,ip_address,device_id,idempotency_key)
    VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING *`, [sessionId, studentId, status, method, ip, deviceId, idempotencyKey]);
  if (!result.rowCount) {
    const existing = await query("SELECT * FROM attendance_records WHERE (session_id=$1 AND student_id=$2) OR ($3 IS NOT NULL AND idempotency_key=$3) ORDER BY id LIMIT 1", [sessionId, studentId, idempotencyKey]);
    if (idempotencyKey && existing.rows[0] && (Number(existing.rows[0].session_id) !== Number(sessionId) || Number(existing.rows[0].student_id) !== Number(studentId))) {
      return { duplicate: true, idempotencyConflict: true, record: null };
    }
    return { duplicate: true, record: existing.rows[0] || null };
  }
  await auditLog({ action: "attendance_recorded", actorId, studentId, sessionId, details: { method, status_after: status, record_id: result.rows[0].id, checkin_time: result.rows[0].checkin_time }, request });
  return { record: result.rows[0] };
}

operationsRouter.post("/attendance/manual", requirePermission("attendance.manage"), async (req, res, next) => {
  try {
    const sessionId=Number(normalizeDigits(req.body?.session_id)), studentId=Number(normalizeDigits(req.body?.student_id)), status=String(req.body?.status||"present");
    if (!sessionId || !studentId || !["present","absent","late","pending_review"].includes(status)) return res.status(400).json({ok:false,status:"invalid_attendance_payload"});
    const check = await query("SELECT 1 FROM attendance_sessions s JOIN students st ON st.group_id=s.group_id WHERE s.id=$1 AND st.id=$2", [sessionId,studentId]);
    if (!check.rowCount) return res.status(400).json({ok:false,status:"wrong_group"});
    const existing = await query("SELECT id, status, method FROM attendance_records WHERE session_id=$1 AND student_id=$2 LIMIT 1", [sessionId, studentId]);
    if (existing.rowCount && existing.rows[0].method === "system" && existing.rows[0].status === "absent") {
      const updated = await query(`UPDATE attendance_records
        SET status=$1, method='manual', checkin_time=NOW()
        WHERE id=$2
        RETURNING *`, [status, existing.rows[0].id]);
      await auditLog({ action: "attendance_recorded", actorId: req.teacher.id, studentId, sessionId, details: { method: "manual", status_before: "absent", status_after: status, record_id: updated.rows[0].id }, request: req });
      return res.status(200).json({ok:true,record:updated.rows[0],corrected:true});
    }
    const saved=await recordAttendance({sessionId,studentId,actorId:req.teacher.id,status,method:"manual",ip:req.ip,request:req});
    if (saved.duplicate) return res.status(409).json({ok:false,status:"duplicate_attendance"});
    res.status(201).json({ok:true,record:saved.record});
  } catch (error) { next(error); }
});

operationsRouter.post("/scanner/attendance", scannerRateLimit, requirePermission("attendance.manage"), async (req, res, next) => {
  try {
    await finalizeExpiredAttendanceSessions();
    const token = normalizeScanValue(req.body?.value ?? req.body?.qr_token);
    const lookupValues = scanLookupValues(token).map((candidate) => candidate.toLowerCase());
    if (!isValidScanValue(token) || !lookupValues.length) return res.status(400).json({ ok: false, status: "invalid_scan_value" });
    const deviceId = String(req.body?.device_id || "").trim();
    if (deviceId && deviceId.length > 128) return res.status(400).json({ ok: false, status: "invalid_device_id" });
    const rawIdempotencyKey = req.get("Idempotency-Key") || req.body?.idempotency_key;
    const idempotencyKey = normalizeIdempotencyKey(rawIdempotencyKey);
    if (rawIdempotencyKey && !idempotencyKey) return res.status(400).json({ ok: false, status: "invalid_idempotency_key" });
    const studentResult = await query(
      `SELECT s.id, s.full_name, s.student_serial, s.scan_serial, s.student_code, s.qr_token, s.group_id,
        s.phone, s.guardian_phone, s.is_active, s.deleted_at, g.name AS group_name,
        COALESCE(g.grade_level,g.grade) AS grade_level, g.fees_amount, g.is_active AS group_active,
        g.deleted_at AS group_deleted_at
       FROM students s LEFT JOIN groups g ON g.id=s.group_id
       WHERE LOWER(COALESCE(s.qr_token, '')) = ANY($1::text[])
        OR LOWER(COALESCE(s.scan_serial, '')) = ANY($1::text[])
        OR LOWER(COALESCE(s.student_serial, '')) = ANY($1::text[])
        OR LOWER(COALESCE(s.student_code, '')) = ANY($1::text[])
       ORDER BY s.deleted_at NULLS FIRST, s.is_active DESC LIMIT 1`,
      [lookupValues]
    );
    if (!studentResult.rowCount) { await auditLog({ action: "suspicious_scan", actorId: req.teacher.id, details: { reason: "student_not_found", scanned_value: token, ip: req.ip }, request: req }); return res.status(404).json({ok:false,status:"student_not_found"}); }
    const student=studentResult.rows[0];
    const publicStudent = {
      id: student.id,
      full_name: student.full_name,
      student_serial: student.student_serial,
      scan_serial: student.scan_serial,
      student_code: student.student_code,
      group_id: student.group_id,
      group_name: student.group_name,
      grade_level: student.grade_level,
      is_active: student.is_active,
      deleted_at: student.deleted_at
    };
    if (student.deleted_at) return res.status(409).json({ok:false,status:"deleted_student",student: publicStudent});
    if (!student.is_active || !student.group_active || student.group_deleted_at) return res.status(409).json({ok:false,status:"inactive_student",student: publicStudent});
    const timing = await getAttendanceTimingDefaults();
    await query(`INSERT INTO attendance_sessions (group_id, schedule_id, session_date, starts_at, opens_at, closes_at, ends_at, status)
      SELECT cs.group_id, cs.id, (NOW() AT TIME ZONE 'Africa/Cairo')::date,
        (((NOW() AT TIME ZONE 'Africa/Cairo')::date + cs.start_time) AT TIME ZONE 'Africa/Cairo'),
        ((((NOW() AT TIME ZONE 'Africa/Cairo')::date + cs.start_time - ((CASE WHEN cs.opens_before_minutes = 3 THEN $2 ELSE cs.opens_before_minutes END) || ' minutes')::interval)) AT TIME ZONE 'Africa/Cairo'),
        ((((NOW() AT TIME ZONE 'Africa/Cairo')::date + cs.start_time + ((CASE WHEN cs.closes_after_minutes = 20 THEN $3 ELSE cs.closes_after_minutes END) || ' minutes')::interval)) AT TIME ZONE 'Africa/Cairo'),
        ((((NOW() AT TIME ZONE 'Africa/Cairo')::date + cs.end_time)) AT TIME ZONE 'Africa/Cairo'), 'open'
      FROM class_schedules cs JOIN groups g ON g.id=cs.group_id AND g.is_active=TRUE AND g.deleted_at IS NULL
      WHERE cs.group_id=$1 AND cs.is_active=TRUE AND cs.day_of_week=EXTRACT(DOW FROM (NOW() AT TIME ZONE 'Africa/Cairo'))::INTEGER
      ON CONFLICT (group_id, schedule_id, session_date) DO NOTHING`, [student.group_id, timing.openBeforeMinutes, timing.closeAfterMinutes]);
    await finalizeExpiredAttendanceSessions();
    const sessionResult=await query(`SELECT s.* FROM attendance_sessions s JOIN groups g ON g.id=s.group_id AND g.is_active=TRUE AND g.deleted_at IS NULL JOIN class_schedules cs ON cs.id=s.schedule_id AND cs.group_id=s.group_id AND cs.is_active=TRUE AND cs.day_of_week=EXTRACT(DOW FROM s.session_date)::INTEGER WHERE s.group_id=$1 AND s.session_date=(NOW() AT TIME ZONE 'Africa/Cairo')::date AND s.status='open' AND NOW() BETWEEN s.opens_at AND s.closes_at ORDER BY s.starts_at LIMIT 1`,[student.group_id]);
    if (!sessionResult.rowCount) return res.status(409).json({ok:false,status:"closed_session",student: publicStudent});
    const saved=await recordAttendance({sessionId:sessionResult.rows[0].id,studentId:student.id,actorId:req.teacher.id,ip:req.ip,deviceId,idempotencyKey,request:req});
    if (saved.duplicate) { await auditLog({ action: "suspicious_scan", actorId: req.teacher.id, studentId: student.id, sessionId: sessionResult.rows[0].id, details: { reason: saved.idempotencyConflict ? "idempotency_key_conflict" : "duplicate_student_scan", student_name: student.full_name, student_code: student.student_code }, request: req }); return res.status(409).json({ok:false,status:saved.idempotencyConflict ? "idempotency_conflict" : "duplicate_attendance",student: publicStudent,record:saved.record}); }
    res.json({ok:true,status:"attendance_recorded",student: publicStudent,record:saved.record});
  } catch (error) { next(error); }
});

operationsRouter.get("/fees/payments", requirePermission("payments.view"), requirePermission("payments.reports.view"), async (req, res, next) => {
  try {
    const term = normalizedSearch(req.query.search ?? req.query.student);
    const values = [];
    const filters = ["TRUE"];
    if (term) {
      values.push(`%${term}%`, crypto.createHash("sha256").update(String(req.query.search ?? req.query.student).trim()).digest("hex"));
      const fields = ["COALESCE(p.student_name_snapshot,s.full_name)", "COALESCE(p.student_serial_snapshot,s.student_serial)", "COALESCE(p.student_code_snapshot,s.student_code)", "s.phone", "s.guardian_phone", "COALESCE(p.group_name_snapshot,COALESCE(g.display_name,g.name))", "COALESCE(p.grade_level_snapshot,COALESCE(g.grade_level,g.grade))"];
      filters.push(`(${fields.map(searchableSql).join(" OR ")} OR s.national_id_hash = $2)` .replaceAll("$SEARCH", "$1"));
    }
    if (req.query.from) { values.push(String(req.query.from)); filters.push(`COALESCE(p.paid_at,p.payment_date) >= $${values.length}::date`); }
    if (req.query.to) { values.push(String(req.query.to)); filters.push(`COALESCE(p.paid_at,p.payment_date) < ($${values.length}::date + INTERVAL '1 day')`); }
    const result = await query(`SELECT p.*, COALESCE(p.student_name_snapshot,s.full_name) AS full_name,
      COALESCE(p.student_serial_snapshot,s.student_serial) AS student_serial,
      COALESCE(p.student_code_snapshot,s.student_code) AS student_code,
      s.phone, s.guardian_phone,
      COALESCE(p.grade_level_snapshot,COALESCE(g.grade_level,g.grade)) AS grade_level,
      COALESCE(p.group_name_snapshot,COALESCE(g.display_name,g.name)) AS group_name,
      u.name AS recorded_by_name
      FROM payments p LEFT JOIN students s ON s.id=p.student_id JOIN groups g ON g.id=p.group_id
      LEFT JOIN teachers u ON u.id=COALESCE(p.paid_by,p.recorded_by)
      WHERE ${filters.join(" AND ")} AND ${activePaymentFilter} ORDER BY COALESCE(p.paid_at,p.payment_date) DESC`, values);
    res.json({ ok: true, payments: result.rows, total_collected: result.rows.reduce((sum, row) => sum + Number(row.amount), 0) });
  } catch (error) { next(error); }
});

operationsRouter.get("/fees/overdue", requirePermission("payments.view"), requirePermission("payments.reports.view"), async (req, res, next) => {
  try {
    await ensureMonthlyFees();
    const term = normalizedSearch(req.query.search ?? req.query.student);
    const values = [];
    const filters = [req.query.include_deleted === "true" ? "TRUE" : "s.deleted_at IS NULL", "s.is_active=TRUE"];
    if (term) {
      values.push(term, crypto.createHash("sha256").update(String(req.query.search ?? req.query.student).trim()).digest("hex"));
      const fields = ["s.full_name", "s.student_serial", "s.student_code", "s.phone", "s.guardian_phone", "COALESCE(g.display_name,g.name)", "COALESCE(g.grade_level,g.grade)"];
      filters.push(`(${fields.map(searchableSql).join(" OR ")} OR s.national_id_hash = $2)`.replaceAll("$SEARCH", "$1"));
    }
    const result = await query(`SELECT s.id,s.full_name,s.student_serial,s.student_code,s.phone,s.guardian_phone,
      COALESCE(g.grade_level,g.grade) AS grade_level,COALESCE(g.display_name,g.name) AS group_name,g.fees_amount,
      COALESCE(SUM(fd.amount),0) AS required_amount,COALESCE(SUM(fd.paid_amount),0) AS paid_amount,
      COALESCE(SUM(fd.amount-fd.paid_amount),0) AS remaining_balance
      FROM students s JOIN groups g ON g.id=s.group_id LEFT JOIN fee_dues fd ON fd.student_id=s.id
      WHERE ${filters.join(" AND ")} GROUP BY s.id,g.id
      HAVING COALESCE(SUM(fd.amount-fd.paid_amount),0)>0 ORDER BY s.full_name`, values);
    res.json({ ok: true, students: result.rows, total_expected_unpaid: result.rows.reduce((sum, row) => sum + Number(row.remaining_balance), 0) });
  } catch (error) { next(error); }
});

operationsRouter.get("/fees/summary/:studentId", requirePermission("payments.view"), async (req,res,next)=>{ try { const summary = await getFeeSummary(req.params.studentId); if(!summary)return res.status(404).json({ok:false,status:"not_found"}); res.json({ok:true,summary: collectionSummary(summary)}); }catch(e){next(e);} });
operationsRouter.get("/fees/advance-options/:studentId", requirePermission("payments.view"), requirePermission("payments.advance"), async (req, res, next) => {
  try {
    const options = await getAdvanceOptions(Number(normalizeDigits(req.params.studentId)));
    if (!options) return res.status(404).json({ ok: false, status: "student_not_found" });
    res.json({ ok: true, ...options });
  } catch (error) { next(error); }
});
operationsRouter.post("/fees/advance-payments", paymentRateLimit, requirePermission("payments.view"), requirePermission("payments.advance"), async (req, res, next) => {
  try {
    const studentId = Number(normalizeDigits(req.body?.student_id));
    const paymentMethod = String(req.body?.payment_method || "cash").trim().toLowerCase();
    if (!Number.isSafeInteger(studentId) || studentId <= 0) return res.status(400).json({ ok: false, status: "invalid_student" });
    if (!paymentMethods.has(paymentMethod)) return res.status(400).json({ ok: false, status: "invalid_payment_method" });
    const rawIdempotencyKey = req.get("Idempotency-Key") || req.body?.idempotency_key;
    const idempotencyKey = normalizeIdempotencyKey(rawIdempotencyKey);
    if (rawIdempotencyKey && !idempotencyKey) return res.status(400).json({ ok: false, status: "invalid_idempotency_key" });
    const result = await recordAdvancePayment({
      studentId,
      actorId: req.teacher.id,
      months: req.body?.months,
      paymentMethod,
      notes: req.body?.notes || null,
      idempotencyKey,
      request: req
    });
    if (result.error === "idempotency_conflict") return res.status(409).json({ ok: false, status: result.error });
    if (result.error === "student_not_found") return res.status(404).json({ ok: false, status: result.error });
    if (result.error === "current_month_unpaid") return res.status(409).json({ ok: false, status: result.error, message: "The current month must be paid before making an advance payment. / يجب سداد الشهر الحالي أولاً قبل الدفع مقدماً." });
    if (result.error === "invalid_months") return res.status(400).json({ ok: false, status: result.error, message: "Invalid advance months. / أشهر الدفع المقدم غير صحيحة." });
    if (result.error === "month_already_paid") return res.status(409).json({ ok: false, status: result.error, month: result.month, message: "This month is already paid. / هذا الشهر مدفوع بالفعل." });
    res.status(201).json({ ok: true, payment: result.payment, months: result.months });
  } catch (error) { next(error); }
});
operationsRouter.post("/fees/payments", paymentRateLimit, requirePermission("payments.view"), requirePermission("payments.collect"), async (req, res, next) => {
  try {
    const studentId = Number(normalizeDigits(req.body?.student_id));
    if (!Number.isSafeInteger(studentId) || studentId <= 0) return res.status(400).json({ ok: false, status: "invalid_student", message: "الطالب غير موجود. / Student was not found." });
    const paymentMethod = String(req.body?.payment_method || "cash").trim().toLowerCase();
    if (!paymentMethods.has(paymentMethod)) return res.status(400).json({ ok: false, status: "invalid_payment_method" });
    const rawIdempotencyKey = req.get("Idempotency-Key") || req.body?.idempotency_key;
    const idempotencyKey = normalizeIdempotencyKey(rawIdempotencyKey);
    if (rawIdempotencyKey && !idempotencyKey) return res.status(400).json({ ok: false, status: "invalid_idempotency_key" });
    if (idempotencyKey) {
      const replay = await query("SELECT * FROM payments WHERE idempotency_key = $1 LIMIT 1", [idempotencyKey]);
      if (replay.rowCount) {
        if (Number(replay.rows[0].student_id) !== studentId || replay.rows[0].payment_type !== "normal" || replay.rows[0].payment_method !== paymentMethod) return res.status(409).json({ ok: false, status: "idempotency_conflict" });
        return res.status(200).json({ ok: true, payment: replay.rows[0], paid_amount: replay.rows[0].amount, replayed: true });
      }
    }
    const summary = await getFeeSummary(studentId);
    if (!summary) return res.status(404).json({ ok: false, status: "not_found", message: "الطالب غير موجود. / Student was not found." });
    if (Number(summary.remaining_balance) <= 0) {
      const status = Number(summary.required_amount) > 0 ? "already_paid" : "no_outstanding_fees";
      const message = status === "already_paid" ? "تم سداد المصروفات بالفعل. / Fees already paid." : "لا توجد مصروفات مستحقة لهذا الطالب. / No outstanding fees for this student.";
      return res.status(409).json({ ok: false, status, message });
    }
    const payment = await recordFullPayment({ studentId, actorId: req.teacher.id, paymentMethod, notes: req.body?.notes || null, idempotencyKey, request: req });
    if (payment?.idempotency_conflict) return res.status(409).json({ ok: false, status: "idempotency_conflict" });
    if (!payment) return res.status(409).json({ ok: false, status: "already_paid", message: "تم سداد المصروفات بالفعل. / Fees already paid." });
    return res.status(201).json({ ok: true, payment, paid_amount: payment.amount });
  } catch (error) { next(error); }
});
