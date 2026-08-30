import crypto from "node:crypto";
import express from "express";
import { pool, query } from "../db/pool.js";
import { requireRoles, requireTeacher } from "../middleware/requireTeacher.js";
import { createAuditAccessToken, hashPassword, verifyAuditAccessToken, verifyPassword } from "../services/auth.js";
import { ensureMonthlyFees, getAdvanceOptions, getFeeSummary, recordAdvancePayment, recordFullPayment } from "../services/fees.js";
import { normalizeDigits } from "../utils/normalizeDigits.js";

export const operationsRouter = express.Router();
const staff = ["admin", "teacher", "assistant"];
operationsRouter.use(requireTeacher, requireRoles(...staff));

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

function requireAuditAccess(req, res, next) {
  if (!verifyAuditAccessToken(req.headers["x-audit-access-token"], req.teacher.id)) {
    return res.status(403).json({ ok: false, status: "audit_access_required" });
  }
  return next();
}

operationsRouter.get("/payments/report", async (req, res, next) => {
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
      FROM payments p JOIN students s ON s.id=p.student_id JOIN groups g ON g.id=p.group_id
      LEFT JOIN teachers u ON u.id=COALESCE(p.paid_by,p.recorded_by)
      WHERE ${filters.join(" AND ")} AND ${activePaymentFilter} ORDER BY ${paymentTimestamp} DESC`, values);
    res.json({ ok: true, payments: result.rows, total_paid: result.rows.reduce((sum, row) => sum + Number(row.amount), 0), payment_count: result.rowCount });
  } catch (error) { next(error); }
});

operationsRouter.post("/fees/payments/:paymentId/reverse", requireRoles("admin"), async (req, res, next) => {
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
      JOIN students s ON s.id = p.student_id
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

    await client.query(`
      INSERT INTO audit_logs (action, actor_id, student_id, payment_id, details)
      VALUES ('payment_reversed', $1, $2, $3, $4)
    `, [req.teacher.id, payment.student_id, paymentId, JSON.stringify({
      reversal_id: reversal.rows[0].id,
      reason,
      original_amount: Number(payment.amount),
      payment_date: payment.payment_date,
      payment_type: payment.payment_type,
      payment_method: payment.payment_method,
      payment_months: months,
      student_name_snapshot: payment.student_name_snapshot || payment.full_name,
      student_code_snapshot: payment.student_code_snapshot || payment.student_code,
      student_serial_snapshot: payment.student_serial_snapshot || payment.student_serial,
      group_name_snapshot: payment.group_name_snapshot || payment.group_name,
      grade_level_snapshot: payment.grade_level_snapshot || payment.grade_level
    })]);
    await client.query("COMMIT");
    return res.status(201).json({ ok: true, reversal: reversal.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

operationsRouter.get("/audit-logs/status", requireRoles("admin"), async (req, res, next) => {
  try {
    const result = await query("SELECT audit_pin_hash IS NOT NULL AS configured FROM teachers WHERE id = $1", [req.teacher.id]);
    res.json({ ok: true, configured: Boolean(result.rows[0]?.configured) });
  } catch (error) { next(error); }
});

operationsRouter.post("/audit-logs/pin", requireRoles("admin"), async (req, res, next) => {
  try {
    const pin = normalizeDigits(req.body?.pin || "").trim();
    const currentPassword = String(req.body?.current_password || "");
    if (!/^\d{4}$/.test(pin)) return res.status(400).json({ ok: false, status: "invalid_pin", message: "PIN must contain exactly 4 digits. / يجب أن يتكون الرقم السري من 4 أرقام." });
    const admin = await query("SELECT password_hash FROM teachers WHERE id = $1 AND role = 'admin' AND is_active = TRUE AND deleted_at IS NULL", [req.teacher.id]);
    if (!admin.rowCount || !verifyPassword(currentPassword, admin.rows[0].password_hash)) return res.status(403).json({ ok: false, status: "invalid_admin_password" });
    await query("UPDATE teachers SET audit_pin_hash = $1, audit_pin_failed_attempts = 0, audit_pin_locked_until = NULL, updated_at = NOW() WHERE id = $2", [hashPassword(pin), req.teacher.id]);
    await query("INSERT INTO audit_logs (action, actor_id, details) VALUES ('audit_pin_changed', $1, $2)", [req.teacher.id, JSON.stringify({ pin_digits: 4 })]);
    res.json({ ok: true });
  } catch (error) { next(error); }
});

operationsRouter.post("/audit-logs/unlock", requireRoles("admin"), async (req, res, next) => {
  const pin = normalizeDigits(req.body?.pin || "").trim();
  if (!/^\d{4}$/.test(pin)) return res.status(400).json({ ok: false, status: "invalid_pin" });
  try {
    const admin = await query("SELECT audit_pin_hash, audit_pin_failed_attempts, audit_pin_locked_until FROM teachers WHERE id = $1 AND role = 'admin' AND is_active = TRUE AND deleted_at IS NULL", [req.teacher.id]);
    if (!admin.rowCount || !admin.rows[0].audit_pin_hash) return res.status(409).json({ ok: false, status: "audit_pin_not_configured" });
    const record = admin.rows[0];
    if (record.audit_pin_locked_until && new Date(record.audit_pin_locked_until).getTime() > Date.now()) return res.status(429).json({ ok: false, status: "audit_pin_locked", retry_after_seconds: Math.ceil((new Date(record.audit_pin_locked_until).getTime() - Date.now()) / 1000) });
    if (!verifyPassword(pin, record.audit_pin_hash)) {
      const failedAttempts = Number(record.audit_pin_failed_attempts || 0) + 1;
      const lockedUntil = failedAttempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
      await query("UPDATE teachers SET audit_pin_failed_attempts = $1, audit_pin_locked_until = $2 WHERE id = $3", [lockedUntil ? 0 : failedAttempts, lockedUntil, req.teacher.id]);
      await query("INSERT INTO audit_logs (action, actor_id, details) VALUES ('audit_pin_failed', $1, $2)", [req.teacher.id, JSON.stringify({ locked: Boolean(lockedUntil) })]);
      return res.status(401).json({ ok: false, status: lockedUntil ? "audit_pin_locked" : "invalid_pin", retry_after_seconds: lockedUntil ? 900 : undefined });
    }
    await query("UPDATE teachers SET audit_pin_failed_attempts = 0, audit_pin_locked_until = NULL WHERE id = $1", [req.teacher.id]);
    await query("INSERT INTO audit_logs (action, actor_id, details) VALUES ('audit_logs_unlocked', $1, $2)", [req.teacher.id, JSON.stringify({ access_duration_minutes: 10 })]);
    res.json({ ok: true, audit_access_token: createAuditAccessToken(req.teacher.id), expires_in_seconds: 600 });
  } catch (error) { next(error); }
});

operationsRouter.get("/audit-logs", requireRoles("admin"), requireAuditAccess, async (req, res, next) => {
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
    if (req.query.date_from) add("a.created_at >= ?::date", String(req.query.date_from).trim());
    if (req.query.date_to) add("a.created_at < (?::date + INTERVAL '1 day')", String(req.query.date_to).trim());
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
      const path = String(row.details?.path || "");
      if (path.includes("/reset-password")) action = "user_password_reset";
      else if (path.endsWith("/users") && row.details?.method === "POST") action = "user_created";
      else if (path.includes("/users/") && row.details?.method === "PUT") action = "user_updated";
      else if (path.includes("/users/") && row.details?.method === "DELETE") action = "user_archived";
      return { ...row, action, details: { ...(row.details || {}), _audit_action: action, _payment_id: row.payment_id, _payment_amount: row.payment_amount, _student_name: row.student_name, _student_code: row.student_code } };
    });
    res.json({ ok: true, logs, page, limit, total: countResult.rows[0]?.total || 0 });
  } catch (error) { next(error); }
});

operationsRouter.get("/payments/late", async (req, res, next) => {
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

operationsRouter.get("/attendance/sessions", async (req, res, next) => {
  try {
    const date = normalizeDigits(req.query.date || new Date().toISOString().slice(0, 10)).trim();
    const params = [date];
    let groupFilter = "";
    if (req.query.group_id) { params.push(Number(normalizeDigits(req.query.group_id))); groupFilter = ` AND s.group_id=$${params.length}`; }
    await query(`
      INSERT INTO attendance_sessions (group_id, schedule_id, session_date, starts_at, opens_at, closes_at, status)
      SELECT cs.group_id, cs.id, $1::date,
        (($1::date + cs.start_time) AT TIME ZONE 'Africa/Cairo'),
        (($1::date + cs.start_time - (cs.opens_before_minutes || ' minutes')::interval) AT TIME ZONE 'Africa/Cairo'),
        (($1::date + cs.end_time + (cs.closes_after_minutes || ' minutes')::interval) AT TIME ZONE 'Africa/Cairo'),
        'open'
      FROM class_schedules cs
      JOIN groups g ON g.id=cs.group_id AND g.is_active=TRUE AND g.deleted_at IS NULL
      WHERE cs.is_active=TRUE AND cs.day_of_week=EXTRACT(DOW FROM $1::date)::INTEGER
        ${req.query.group_id ? `AND cs.group_id=$2` : ""}
      ON CONFLICT (group_id, schedule_id, session_date) DO NOTHING
    `, req.query.group_id ? [date, Number(normalizeDigits(req.query.group_id))] : [date]);
    const result = await query(`SELECT s.*, g.name AS group_name, COALESCE(g.grade_level,g.grade) AS grade_level,
      cs.day_of_week, cs.start_time, cs.end_time
      FROM attendance_sessions s
      JOIN groups g ON g.id=s.group_id AND g.is_active=TRUE AND g.deleted_at IS NULL
      JOIN class_schedules cs ON cs.id=s.schedule_id AND cs.group_id=s.group_id
        AND cs.is_active=TRUE AND cs.day_of_week=EXTRACT(DOW FROM s.session_date)::INTEGER
      WHERE s.session_date=$1${groupFilter} ORDER BY cs.start_time`, params);
    res.json({ ok: true, sessions: result.rows });
  } catch (error) { next(error); }
});

operationsRouter.post("/attendance/sessions", async (req, res, next) => {
  try {
    const groupId = Number(normalizeDigits(req.body?.group_id)), scheduleId = Number(normalizeDigits(req.body?.schedule_id));
    const date = String(req.body?.session_date || new Date().toISOString().slice(0, 10));
    if (!groupId || !scheduleId) return res.status(400).json({ ok:false, status:"invalid_session_payload" });
    const result = await query(`INSERT INTO attendance_sessions (group_id,schedule_id,session_date,starts_at,opens_at,closes_at,status)
      SELECT $1, cs.id, $3::date, (($3::date + cs.start_time) AT TIME ZONE 'Africa/Cairo'), (($3::date + cs.start_time - (cs.opens_before_minutes || ' minutes')::interval) AT TIME ZONE 'Africa/Cairo'),
      (($3::date + cs.end_time + (cs.closes_after_minutes || ' minutes')::interval) AT TIME ZONE 'Africa/Cairo'), 'open'
      FROM class_schedules cs JOIN groups g ON g.id=cs.group_id AND g.is_active=TRUE AND g.deleted_at IS NULL
      WHERE cs.id=$2 AND cs.group_id=$1 AND cs.is_active=TRUE
        AND cs.day_of_week=EXTRACT(DOW FROM $3::date)::INTEGER
      RETURNING *`, [groupId, scheduleId, date]);
    if (!result.rowCount) return res.status(400).json({ok:false,status:"invalid_schedule"});
    res.status(201).json({ok:true,session:result.rows[0]});
  } catch (error) { if (error.code === "23505") return res.status(409).json({ok:false,status:"session_exists"}); next(error); }
});

operationsRouter.get("/attendance/sessions/:id/records", async (req, res, next) => {
  try { const result = await query(`SELECT ar.*, s.full_name, s.student_serial, COALESCE(g.grade_level,g.grade) AS grade_level, g.name AS group_name
    FROM attendance_records ar JOIN students s ON s.id=ar.student_id JOIN groups g ON g.id=s.group_id WHERE ar.session_id=$1 ORDER BY s.full_name`, [req.params.id]); res.json({ok:true,records:result.rows}); }
  catch (error) { next(error); }
});

async function recordAttendance({ sessionId, studentId, actorId, method = "scanner", status = "present", ip, deviceId }) {
  const result = await query(`INSERT INTO attendance_records (session_id,student_id,status,method,ip_address,device_id)
    VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (session_id,student_id) DO NOTHING RETURNING *`, [sessionId, studentId, status, method, ip, deviceId]);
  if (!result.rowCount) return { duplicate: true };
  await query("INSERT INTO audit_logs(action,actor_id,student_id,session_id,details) VALUES ('attendance_recorded',$1,$2,$3,$4)", [actorId,studentId,sessionId,JSON.stringify({method})]);
  return { record: result.rows[0] };
}

operationsRouter.post("/attendance/manual", async (req, res, next) => {
  try {
    const sessionId=Number(normalizeDigits(req.body?.session_id)), studentId=Number(normalizeDigits(req.body?.student_id)), status=String(req.body?.status||"present");
    if (!sessionId || !studentId || !["present","absent","late","pending_review"].includes(status)) return res.status(400).json({ok:false,status:"invalid_attendance_payload"});
    const check = await query("SELECT 1 FROM attendance_sessions s JOIN students st ON st.group_id=s.group_id WHERE s.id=$1 AND st.id=$2", [sessionId,studentId]);
    if (!check.rowCount) return res.status(400).json({ok:false,status:"wrong_group"});
    const saved=await recordAttendance({sessionId,studentId,actorId:req.teacher.id,status,method:"manual",ip:req.ip});
    if (saved.duplicate) return res.status(409).json({ok:false,status:"duplicate_attendance"});
    res.status(201).json({ok:true,record:saved.record});
  } catch (error) { next(error); }
});

operationsRouter.post("/scanner/attendance", async (req, res, next) => {
  try {
    const token=normalizeDigits(req.body?.qr_token||"").trim();
    const studentResult=await query(`${studentDetails} WHERE s.qr_token=$1 OR s.scan_serial=$1 OR s.student_serial=$1 OR s.student_code=$1 LIMIT 1`,[token]);
    if (!studentResult.rowCount) { await query("INSERT INTO audit_logs(action,actor_id,details) VALUES ('suspicious_scan',$1,$2)",[req.teacher.id,JSON.stringify({reason:"invalid_qr_token",ip:req.ip})]); return res.status(404).json({ok:false,status:"invalid_qr_token"}); }
    const student=studentResult.rows[0];
    await query(`INSERT INTO attendance_sessions (group_id, schedule_id, session_date, starts_at, opens_at, closes_at, status)
      SELECT cs.group_id, cs.id, (NOW() AT TIME ZONE 'Africa/Cairo')::date,
        (((NOW() AT TIME ZONE 'Africa/Cairo')::date + cs.start_time) AT TIME ZONE 'Africa/Cairo'),
        ((((NOW() AT TIME ZONE 'Africa/Cairo')::date + cs.start_time - (cs.opens_before_minutes || ' minutes')::interval)) AT TIME ZONE 'Africa/Cairo'),
        ((((NOW() AT TIME ZONE 'Africa/Cairo')::date + cs.end_time + (cs.closes_after_minutes || ' minutes')::interval)) AT TIME ZONE 'Africa/Cairo'), 'open'
      FROM class_schedules cs JOIN groups g ON g.id=cs.group_id AND g.is_active=TRUE AND g.deleted_at IS NULL
      WHERE cs.group_id=$1 AND cs.is_active=TRUE AND cs.day_of_week=EXTRACT(DOW FROM (NOW() AT TIME ZONE 'Africa/Cairo'))::INTEGER
      ON CONFLICT (group_id, schedule_id, session_date) DO NOTHING`, [student.group_id]);
    const sessionResult=await query(`SELECT s.* FROM attendance_sessions s JOIN groups g ON g.id=s.group_id AND g.is_active=TRUE AND g.deleted_at IS NULL JOIN class_schedules cs ON cs.id=s.schedule_id AND cs.group_id=s.group_id AND cs.is_active=TRUE AND cs.day_of_week=EXTRACT(DOW FROM s.session_date)::INTEGER WHERE s.group_id=$1 AND s.session_date=(NOW() AT TIME ZONE 'Africa/Cairo')::date AND s.status='open' AND NOW() BETWEEN s.opens_at AND s.closes_at ORDER BY s.starts_at LIMIT 1`,[student.group_id]);
    if (!student.is_active || !student.group_active) return res.status(409).json({ok:false,status:"inactive_student",student});
    if (!sessionResult.rowCount) return res.status(409).json({ok:false,status:"closed_session",student});
    const saved=await recordAttendance({sessionId:sessionResult.rows[0].id,studentId:student.id,actorId:req.teacher.id,ip:req.ip,deviceId:req.body?.device_id});
    if (saved.duplicate) { await query("INSERT INTO audit_logs(action,actor_id,student_id,session_id,details) VALUES ('suspicious_scan',$1,$2,$3,$4)",[req.teacher.id,student.id,sessionResult.rows[0].id,JSON.stringify({reason:"duplicate_student_scan"})]); return res.status(409).json({ok:false,status:"duplicate_attendance",student}); }
    res.json({ok:true,status:"attendance_recorded",student,record:saved.record});
  } catch (error) { next(error); }
});

operationsRouter.get("/fees/payments", async (req, res, next) => {
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
      FROM payments p JOIN students s ON s.id=p.student_id JOIN groups g ON g.id=p.group_id
      LEFT JOIN teachers u ON u.id=COALESCE(p.paid_by,p.recorded_by)
      WHERE ${filters.join(" AND ")} AND ${activePaymentFilter} ORDER BY COALESCE(p.paid_at,p.payment_date) DESC`, values);
    res.json({ ok: true, payments: result.rows, total_collected: result.rows.reduce((sum, row) => sum + Number(row.amount), 0) });
  } catch (error) { next(error); }
});

operationsRouter.get("/fees/overdue", async (req, res, next) => {
  try {
    await ensureMonthlyFees();
    const term = normalizedSearch(req.query.search ?? req.query.student);
    const values = [term, term ? crypto.createHash("sha256").update(String(req.query.search ?? req.query.student).trim()).digest("hex") : ""];
    const filters = [req.query.include_deleted === "true" ? "TRUE" : "s.deleted_at IS NULL", "s.is_active=TRUE"];
    if (term) {
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

operationsRouter.get("/fees/summary/:studentId", async (req,res,next)=>{ try { const summary = await getFeeSummary(req.params.studentId); if(!summary)return res.status(404).json({ok:false,status:"not_found"}); res.json({ok:true,summary}); }catch(e){next(e);} });
operationsRouter.get("/fees/advance-options/:studentId", async (req, res, next) => {
  try {
    const options = await getAdvanceOptions(Number(normalizeDigits(req.params.studentId)));
    if (!options) return res.status(404).json({ ok: false, status: "student_not_found" });
    res.json({ ok: true, ...options });
  } catch (error) { next(error); }
});
operationsRouter.post("/fees/advance-payments", async (req, res, next) => {
  try {
    const studentId = Number(normalizeDigits(req.body?.student_id));
    const result = await recordAdvancePayment({
      studentId,
      actorId: req.teacher.id,
      months: req.body?.months,
      paymentMethod: String(req.body?.payment_method || "cash"),
      notes: req.body?.notes || null
    });
    if (result.error === "student_not_found") return res.status(404).json({ ok: false, status: result.error });
    if (result.error === "current_month_unpaid") return res.status(409).json({ ok: false, status: result.error, message: "The current month must be paid before making an advance payment. / يجب سداد الشهر الحالي أولاً قبل الدفع مقدماً." });
    if (result.error === "invalid_months") return res.status(400).json({ ok: false, status: result.error, message: "Invalid advance months. / أشهر الدفع المقدم غير صحيحة." });
    if (result.error === "month_already_paid") return res.status(409).json({ ok: false, status: result.error, month: result.month, message: "This month is already paid. / هذا الشهر مدفوع بالفعل." });
    res.status(201).json({ ok: true, payment: result.payment, months: result.months });
  } catch (error) { next(error); }
});
operationsRouter.post("/fees/payments", async (req,res,next)=>{ try { const studentId=Number(req.body?.student_id); if(!studentId)return res.status(400).json({ok:false,status:"invalid_student",message:"الطالب غير موجود. / Student was not found."}); const summary=await getFeeSummary(studentId); if(!summary)return res.status(404).json({ok:false,status:"not_found",message:"الطالب غير موجود. / Student was not found."}); if(Number(summary.remaining_balance)<=0){const status=Number(summary.required_amount)>0?"already_paid":"no_outstanding_fees"; const message=status==="already_paid"?"تم سداد المصروفات بالفعل. / Fees already paid.":"لا توجد مصروفات مستحقة لهذا الطالب. / No outstanding fees for this student."; return res.status(409).json({ok:false,status,message});} const p=await recordFullPayment({studentId,actorId:req.teacher.id,paymentMethod:String(req.body?.payment_method||"cash"),notes:req.body?.notes||null}); if(!p)return res.status(409).json({ok:false,status:"already_paid",message:"تم سداد المصروفات بالفعل. / Fees already paid."}); res.status(201).json({ok:true,payment:p,paid_amount:p.amount}); }catch(e){next(e);} });
operationsRouter.get("/fees/payments", async (req,res,next)=>{try{const values=[];const filters=["s.deleted_at IS NULL"];const add=(sql,value)=>{values.push(value);filters.push(sql.replace("?",`$${values.length}`));};if(req.query.from){add("p.payment_date >= ?::date",String(req.query.from));}if(req.query.to){add("p.payment_date < (?::date + INTERVAL '1 day')",String(req.query.to));}if(req.query.student){add("(s.full_name ILIKE '%' || ? || '%' OR s.student_serial ILIKE '%' || ? || '%')",String(req.query.student));values.push(values[values.length-1]);filters[filters.length-1]=filters[filters.length-1].replace("?",`$${values.length-1}`).replace("?",`$${values.length}`);}if(req.query.group_id){add("g.id = ?",Number(req.query.group_id));}const r=await query(`SELECT p.*,s.full_name,s.student_serial,s.guardian_phone,COALESCE(g.grade_level,g.grade) AS grade_level,g.name AS group_name,u.name AS recorded_by_name FROM payments p JOIN students s ON s.id=p.student_id JOIN groups g ON g.id=p.group_id LEFT JOIN teachers u ON u.id=p.recorded_by WHERE ${filters.join(" AND ")} ORDER BY p.payment_date DESC`,values);res.json({ok:true,payments:r.rows,total_collected:r.rows.reduce((sum,row)=>sum+Number(row.amount),0)});}catch(e){next(e);}});
operationsRouter.get("/fees/overdue", async (req,res,next)=>{try{await ensureMonthlyFees();const r=await query(`SELECT s.id,s.full_name,s.student_serial,s.guardian_phone,COALESCE(g.grade_level,g.grade) AS grade_level,g.name AS group_name,g.fees_amount,COALESCE(SUM(fd.amount),0) AS required_amount,COALESCE(SUM(fd.paid_amount),0) AS paid_amount,COALESCE(SUM(fd.amount-fd.paid_amount),0) AS remaining_balance FROM students s JOIN groups g ON g.id=s.group_id LEFT JOIN fee_dues fd ON fd.student_id=s.id WHERE s.is_active=TRUE AND s.deleted_at IS NULL GROUP BY s.id,g.id HAVING COALESCE(SUM(fd.amount-fd.paid_amount),0)>0 ORDER BY s.full_name`,[]);res.json({ok:true,students:r.rows,total_expected_unpaid:r.rows.reduce((sum,row)=>sum+Number(row.remaining_balance),0)});}catch(e){next(e);}});
