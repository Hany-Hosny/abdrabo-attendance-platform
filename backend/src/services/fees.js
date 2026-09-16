import crypto from "node:crypto";
import { pool, query } from "../db/pool.js";
import { auditLog } from "./audit.js";
import { enqueueAdvancePaymentNotificationInTransaction, enqueueReceiptNotificationInTransaction, settlePaymentNotificationJobsForReversal } from "./whatsapp.js";
import { hasGroupAccess, isGroupScopeRestricted } from "./groupAccess.js";

function resolveExecutor(executor = query) {
  if (typeof executor === "function") return executor;
  if (executor && typeof executor.query === "function") return executor.query.bind(executor);
  return query;
}

function roundedAmount(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function normalizedPaymentMonths(value) {
  return (Array.isArray(value) ? value : [])
    .map((item) => String(item?.month || item || "").slice(0, 7))
    .filter((month) => /^\d{4}-\d{2}$/.test(month))
    .sort();
}

export function paymentRequestMatches(existing, { studentId, paymentType, paymentMethod, discountAmount = 0, isExempt = false, months = null }) {
  if (Number(existing.student_id) !== Number(studentId)) return false;
  if ((existing.payment_type || "normal") !== paymentType) return false;
  if (existing.payment_method !== paymentMethod) return false;
  if (Boolean(existing.is_exempt) !== Boolean(isExempt)) return false;
  if (!isExempt && roundedAmount(existing.discount_amount) !== roundedAmount(discountAmount)) return false;
  if (paymentType === "advance") {
    const requestedMonths = normalizedPaymentMonths(months);
    if (requestedMonths.join(",") !== normalizedPaymentMonths(existing.payment_months).join(",")) return false;
  }
  return true;
}

const reversalErrorMessages = Object.freeze({
  idempotency_conflict: "This reversal request conflicts with an existing operation key. No change was committed. / يتعارض طلب عكس الدفعة مع عملية موجودة. لم يتم اعتماد أي تغيير.",
  idempotency_incomplete: "The previous reversal request did not complete and must be reviewed before retrying. No change was committed. / لم تكتمل عملية عكس الدفعة السابقة، ويجب مراجعتها قبل إعادة المحاولة. لم يتم اعتماد أي تغيير.",
  payment_not_found: "The payment was not found. No change was committed. / الدفعة غير موجودة. لم يتم اعتماد أي تغيير.",
  payment_student_missing: "This payment cannot be reversed because its student record is missing or deleted. No change was committed. / لا يمكن عكس هذه الدفعة لأن سجل الطالب غير موجود أو تم حذفه. لم يتم اعتماد أي تغيير.",
  group_access_forbidden: "You cannot reverse a payment outside your assigned groups. No change was committed. / لا يمكنك عكس دفعة خارج نطاق مجموعاتك. لم يتم اعتماد أي تغيير.",
  payment_student_group_mismatch: "The payment student does not belong to the payment group. No change was committed. / الطالب المرتبط بالدفعة لا ينتمي إلى مجموعة الدفعة. لم يتم اعتماد أي تغيير.",
  payment_group_missing: "This payment cannot be reversed because its group record is missing or deleted. No change was committed. / لا يمكن عكس هذه الدفعة لأن سجل المجموعة غير موجود أو تم حذفه. لم يتم اعتماد أي تغيير.",
  payment_not_reversible: "This payment does not contain a valid reversible amount. No change was committed. / لا تحتوي هذه الدفعة على مبلغ صالح للعكس. لم يتم اعتماد أي تغيير.",
  payment_history_incomplete: "The payment is missing its covered-dues allocation history. No change was committed. / تفتقد الدفعة سجل توزيع المصروفات المغطاة. لم يتم اعتماد أي تغيير.",
  malformed_payment_months: "The payment covered-dues data is malformed. No change was committed. / بيانات المصروفات المغطاة في الدفعة غير صحيحة. لم يتم اعتماد أي تغيير.",
  duplicate_payment_month: "The payment contains duplicate covered months. No change was committed. / تحتوي الدفعة على شهور مكررة ضمن المصروفات المغطاة. لم يتم اعتماد أي تغيير.",
  covered_total_mismatch: "The covered-dues allocations do not match the payment totals. No change was committed. / لا تتطابق توزيعات المصروفات المغطاة مع إجمالي الدفعة. لم يتم اعتماد أي تغيير.",
  fee_due_not_found: "A covered fee due could not be found for this student. No change was committed. / تعذر العثور على أحد الاستحقاقات المغطاة لهذا الطالب. لم يتم اعتماد أي تغيير.",
  fee_due_relationship_invalid: "A covered fee due does not belong to this payment’s student and group. No change was committed. / أحد الاستحقاقات المغطاة لا ينتمي إلى طالب ومجموعة الدفعة. لم يتم اعتماد أي تغيير.",
  invalid_covered_amount: "A covered allocation is invalid for its fee due. No change was committed. / أحد توزيعات المصروفات المغطاة غير صالح للاستحقاق. لم يتم اعتماد أي تغيير.",
  fee_due_insufficient_paid: "A covered fee due does not have enough paid balance to reverse. No change was committed. / لا يحتوي أحد الاستحقاقات المغطاة على رصيد مدفوع كافٍ للعكس. لم يتم اعتماد أي تغيير.",
  fee_due_allocation_mismatch: "A fee due changed while the reversal was being applied. No change was committed. / تغير أحد الاستحقاقات أثناء تنفيذ العكس. لم يتم اعتماد أي تغيير."
});

function reversalFailure(code, details = {}) {
  const error = new Error(reversalErrorMessages[code] || `Payment reversal failed (${code}). No change was committed.`);
  error.code = code;
  Object.assign(error, details);
  return error;
}

function moneyCents(value, { allowZero = true } = {}) {
  const text = String(value ?? "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const cents = Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
  if (!Number.isSafeInteger(cents) || (!allowZero && cents <= 0)) return null;
  return cents;
}

function validDueMonth(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-(?:0[1-9]|1[0-2])-01$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function parseReversalMonths(value) {
  if (!Array.isArray(value) || value.length === 0) throw reversalFailure("payment_history_incomplete");
  const seen = new Set();
  const months = value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw reversalFailure("malformed_payment_months");
    const keys = Object.keys(entry);
    if (keys.length !== 2 || !keys.includes("month") || !keys.includes("amount") || typeof entry.month !== "string" || typeof entry.amount !== "number" || !Number.isFinite(entry.amount)) {
      throw reversalFailure("malformed_payment_months");
    }
    const month = entry.month.trim();
    const amountCents = moneyCents(entry.amount, { allowZero: false });
    if (!validDueMonth(month) || amountCents === null) throw reversalFailure("malformed_payment_months");
    if (seen.has(month)) throw reversalFailure("duplicate_payment_month");
    seen.add(month);
    return { month, amountCents };
  });
  return months.sort((left, right) => left.month.localeCompare(right.month));
}

function reversalFingerprint(paymentId, reason) {
  return crypto.createHash("sha256")
    .update(JSON.stringify({ operation: "payment_reversal_v1", payment_id: paymentId, reason }))
    .digest("hex");
}

export async function reversePayment({ paymentId, actorId, reason, user, idempotencyKey, request = null, dbPool = pool }) {
  const fingerprint = reversalFingerprint(paymentId, reason);
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");

    const insertedKey = await client.query(
      `INSERT INTO payment_reversal_idempotency (idempotency_key, payment_id, request_fingerprint)
       VALUES ($1, $2, $3)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING idempotency_key`,
      [idempotencyKey, paymentId, fingerprint]
    );
    if (!insertedKey.rowCount) {
      const existingKey = await client.query(
        `SELECT payment_id, request_fingerprint, reversal_id, response
         FROM payment_reversal_idempotency
         WHERE idempotency_key = $1
         FOR UPDATE`,
        [idempotencyKey]
      );
      const record = existingKey.rows[0];
      if (!record || Number(record.payment_id) !== paymentId || record.request_fingerprint !== fingerprint) {
        throw reversalFailure("idempotency_conflict");
      }
      if (record.reversal_id && record.response) {
        if (request) request.auditLogged = true;
        await client.query("COMMIT");
        return { replayed: true, reversal: record.response };
      }
      throw reversalFailure("idempotency_incomplete");
    }

    const paymentResult = await client.query("SELECT * FROM payments WHERE id = $1 FOR UPDATE", [paymentId]);
    if (!paymentResult.rowCount) throw reversalFailure("payment_not_found");
    const payment = paymentResult.rows[0];

    const existingReversal = await client.query(
      `SELECT id, payment_id, reversed_by, reason, original_amount, covered_amount,
          discount_amount, exemption_amount, created_at
       FROM payment_reversals WHERE payment_id = $1`,
      [paymentId]
    );
    if (existingReversal.rowCount) {
      await client.query("ROLLBACK");
      return { alreadyReversed: true, reversal: existingReversal.rows[0] };
    }

    if (payment.student_id == null) throw reversalFailure("payment_student_missing");
    if (!hasGroupAccess(user, payment.group_id)) throw reversalFailure("group_access_forbidden");

    const studentResult = await client.query(
      `SELECT id, group_id, full_name, student_code, student_serial, scan_serial, is_active, deleted_at
       FROM students WHERE id = $1 FOR UPDATE`,
      [payment.student_id]
    );
    const student = studentResult.rows[0];
    if (!student || student.deleted_at) throw reversalFailure("payment_student_missing");
    if (Number(student.group_id) !== Number(payment.group_id)) throw reversalFailure("payment_student_group_mismatch");

    const groupResult = await client.query(
      `SELECT id, name, display_name, grade, grade_level, is_active, deleted_at
       FROM groups WHERE id = $1 FOR UPDATE`,
      [payment.group_id]
    );
    const group = groupResult.rows[0];
    if (!group || group.deleted_at) throw reversalFailure("payment_group_missing");
    if (isGroupScopeRestricted(user) && !group.is_active) throw reversalFailure("group_access_forbidden");

    const netCents = moneyCents(payment.amount);
    const paidCents = moneyCents(payment.paid_amount);
    const discountCents = moneyCents(payment.discount_amount);
    if (netCents === null || paidCents === null || discountCents === null || paidCents !== netCents) {
      throw reversalFailure("payment_not_reversible");
    }
    if (payment.is_exempt === true && netCents !== 0) throw reversalFailure("payment_not_reversible");
    const exemptionCents = payment.is_exempt === true ? discountCents : 0;
    const coveredCents = netCents + discountCents;
    if (coveredCents <= 0 || (payment.is_exempt === true && exemptionCents <= 0)) {
      throw reversalFailure("payment_not_reversible");
    }
    const months = parseReversalMonths(payment.payment_months);
    const allocatedCents = months.reduce((sum, item) => {
      const next = sum + item.amountCents;
      return Number.isSafeInteger(next) ? next : null;
    }, 0);
    if (allocatedCents === null || allocatedCents !== coveredCents) {
      throw reversalFailure("covered_total_mismatch");
    }

    const dueResult = await client.query(
      `SELECT id, student_id, group_id, to_char(due_month, 'YYYY-MM-DD') AS due_month, amount, paid_amount
       FROM fee_dues
       WHERE student_id = $1 AND due_month = ANY($2::date[])
       ORDER BY due_month, id
       FOR UPDATE`,
      [payment.student_id, months.map((item) => item.month)]
    );
    if (dueResult.rowCount !== months.length) throw reversalFailure("fee_due_not_found");
    const duesByMonth = new Map(dueResult.rows.map((due) => [String(due.due_month).slice(0, 10), due]));
    for (const covered of months) {
      const due = duesByMonth.get(covered.month);
      const dueCents = moneyCents(due?.amount, { allowZero: false });
      const paidDueCents = moneyCents(due?.paid_amount);
      if (!due) throw reversalFailure("fee_due_not_found");
      if (Number(due.student_id) !== Number(payment.student_id) || Number(due.group_id) !== Number(payment.group_id)) {
        throw reversalFailure("fee_due_relationship_invalid");
      }
      if (dueCents === null || paidDueCents === null || paidDueCents > dueCents || covered.amountCents > dueCents) {
        throw reversalFailure("invalid_covered_amount");
      }
      if (paidDueCents < covered.amountCents) throw reversalFailure("fee_due_insufficient_paid");
    }

    for (const covered of months) {
      const restored = await client.query(
        `UPDATE fee_dues
         SET paid_amount = paid_amount - $1::numeric
         WHERE student_id = $2 AND group_id = $3 AND due_month = $4::date
           AND paid_amount >= $1::numeric
         RETURNING id, paid_amount`,
        [covered.amountCents / 100, payment.student_id, payment.group_id, covered.month]
      );
      const originalPaidCents = moneyCents(duesByMonth.get(covered.month)?.paid_amount);
      const expectedPaidCents = originalPaidCents === null ? null : originalPaidCents - covered.amountCents;
      const restoredPaidCents = moneyCents(restored.rows[0]?.paid_amount);
      if (restored.rowCount !== 1 || expectedPaidCents === null || expectedPaidCents < 0 || restoredPaidCents !== expectedPaidCents) {
        throw reversalFailure("fee_due_allocation_mismatch");
      }
    }

    const reversal = await client.query(
      `INSERT INTO payment_reversals
         (payment_id, reversed_by, reason, original_amount, covered_amount, discount_amount, exemption_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, payment_id, reversed_by, reason, original_amount, covered_amount,
         discount_amount, exemption_amount, created_at`,
      [paymentId, actorId, reason, netCents / 100, coveredCents / 100, discountCents / 100, exemptionCents / 100]
    );
    const whatsappJobs = await settlePaymentNotificationJobsForReversal({ client, paymentId });
    const reversalRecord = reversal.rows[0];
    const response = { ...reversalRecord };
    await client.query(
      `UPDATE payment_reversal_idempotency
       SET reversal_id = $2, response = $3::jsonb
       WHERE idempotency_key = $1`,
      [idempotencyKey, reversalRecord.id, JSON.stringify(response)]
    );
    try {
      await auditLog({
        db: client,
        action: "payment_reversed",
        actorId,
        studentId: payment.student_id,
        paymentId,
        request,
        details: {
          reversal_id: reversalRecord.id,
          reason,
          original_amount: netCents / 100,
          covered_amount: coveredCents / 100,
          discount_amount: discountCents / 100,
          exemption_amount: exemptionCents / 100,
          status_before: "paid",
          status_after: "reversed",
          payment_type: payment.payment_type,
          payment_method: payment.payment_method,
          payment_months: months.map((item) => ({ month: item.month, amount: item.amountCents / 100 })),
          whatsapp_jobs: whatsappJobs.map((job) => ({ id: job.id, notification_type: job.notification_type, status: job.status, send_started: Boolean(job.send_started_at) }))
        },
        throwOnError: true
      });
    } catch (error) {
      const auditError = new Error("The reversal audit record could not be written. No change was committed. / تعذر تسجيل سجل عكس الدفعة. لم يتم اعتماد أي تغيير.");
      auditError.code = "reversal_audit_log_failed";
      auditError.cause = error;
      throw auditError;
    }
    await client.query("COMMIT");
    return { reversal: response };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// Creates any missing monthly dues up to the current month.
// Respects s.billing_start_month so newly registered students don't accrue past or current-month dues prematurely.
export async function ensureMonthlyFees(studentId = null, executor = query) {
  await resolveExecutor(executor)(`
    INSERT INTO fee_dues (student_id, group_id, due_month, amount)
    SELECT s.id, s.group_id, months.due_month::date, g.fees_amount
    FROM students s
    JOIN groups g ON g.id = s.group_id
    CROSS JOIN LATERAL generate_series(
      COALESCE(
        date_trunc('month', s.billing_start_month)::date,
        date_trunc('month', s.created_at AT TIME ZONE 'Africa/Cairo')::date
      ),
      date_trunc('month', (NOW() AT TIME ZONE 'Africa/Cairo'))::date,
      INTERVAL '1 month'
    ) AS months(due_month)
    WHERE s.is_active = TRUE AND s.deleted_at IS NULL
      AND g.is_active = TRUE AND g.deleted_at IS NULL
      AND ($1::integer IS NULL OR s.id = $1)
    ON CONFLICT (student_id, due_month) DO NOTHING
  `, [studentId]);
}

export async function getFeeSummary(studentId, { ensure = true, db = query } = {}) {
  const execute = resolveExecutor(db);
  if (ensure) await ensureMonthlyFees(Number(studentId), execute);
  const result = await execute(`
    WITH bounds AS (
      SELECT date_trunc('month', (NOW() AT TIME ZONE 'Africa/Cairo'))::date AS current_month,
        (date_trunc('month', (NOW() AT TIME ZONE 'Africa/Cairo')) + INTERVAL '1 month')::date AS upcoming_month,
        (date_trunc('month', (NOW() AT TIME ZONE 'Africa/Cairo')) + INTERVAL '2 months' - INTERVAL '1 day')::date AS month_end,
        (NOW() AT TIME ZONE 'Africa/Cairo')::date AS today,
        EXTRACT(DAY FROM (NOW() AT TIME ZONE 'Africa/Cairo'))::integer AS current_day
    ), current_due AS (
      SELECT COALESCE(SUM(fd.amount), 0) AS amount, COALESCE(SUM(fd.paid_amount), 0) AS paid_amount
      FROM fee_dues fd CROSS JOIN bounds
      WHERE fd.student_id = $1 AND fd.due_month = bounds.current_month
    ), upcoming_due AS (
      SELECT COALESCE(SUM(fd.amount), 0) AS amount, COALESCE(SUM(fd.paid_amount), 0) AS paid_amount
      FROM fee_dues fd CROSS JOIN bounds
      WHERE fd.student_id = $1 AND fd.due_month = bounds.upcoming_month
    ), totals AS (
      SELECT COALESCE(SUM(fd.amount), 0) AS required_amount,
        COALESCE(SUM(fd.paid_amount), 0) AS paid_amount,
        COALESCE(SUM(fd.amount - fd.paid_amount), 0) AS remaining_balance,
        COALESCE(BOOL_OR(
          fd.amount > fd.paid_amount AND (
            fd.due_month < (SELECT current_month FROM bounds)
            OR (
              fd.due_month = (SELECT current_month FROM bounds)
              AND (SELECT current_day FROM bounds) >= 6
            )
          )
        ), FALSE) AS has_overdue
      FROM fee_dues fd WHERE fd.student_id = $1
    )
    SELECT s.id, s.full_name, s.student_serial, s.student_code,
      COALESCE(s.billing_start_month, date_trunc('month', s.created_at AT TIME ZONE 'Africa/Cairo')::date)::text AS billing_start_month,
      COALESCE(g.grade_level, g.grade) AS grade_level, g.name AS group_name,
      g.fees_amount,
      totals.required_amount, totals.paid_amount, totals.remaining_balance,
      current_due.amount AS current_cycle_fee,
      current_due.paid_amount AS current_cycle_paid,
      GREATEST(0, current_due.amount - current_due.paid_amount) AS current_cycle_outstanding,
      upcoming_due.amount AS upcoming_cycle_fee,
      upcoming_due.paid_amount AS upcoming_cycle_paid,
      GREATEST(0, upcoming_due.amount - upcoming_due.paid_amount) AS upcoming_cycle_outstanding,
      bounds.current_month::text AS current_month,
      bounds.upcoming_month::text AS upcoming_month,
      (upcoming_due.amount > 0 AND upcoming_due.amount <= upcoming_due.paid_amount) AS upcoming_month_covered,
      (
        NOT (upcoming_due.amount > 0 AND upcoming_due.amount <= upcoming_due.paid_amount)
        AND (
          current_due.amount > current_due.paid_amount
          OR bounds.today >= (bounds.month_end - 5)
        )
      ) AS renewal_should_show,
      CASE WHEN current_due.amount > current_due.paid_amount THEN bounds.current_month ELSE bounds.upcoming_month END::text AS renewal_target_month,
      CASE WHEN current_due.amount > current_due.paid_amount THEN g.fees_amount ELSE COALESCE(upcoming_due.amount, g.fees_amount) END AS renewal_amount,
      COALESCE((SELECT SUM(p.amount) FROM payments p
        WHERE p.student_id = s.id
          AND NOT EXISTS (SELECT 1 FROM payment_reversals pr WHERE pr.payment_id = p.id)), 0) AS total_historical_payments,
      CASE
        WHEN totals.remaining_balance <= 0 THEN 'paid'
        WHEN totals.has_overdue THEN 'overdue'
        ELSE 'unpaid'
      END AS payment_status,
      CASE
        WHEN totals.remaining_balance <= 0 THEN 'none'
        WHEN bounds.current_day > 10 THEN 'critical'
        WHEN bounds.current_day >= 6 THEN 'late'
        ELSE 'grace'
      END AS billing_stage,
      (totals.remaining_balance > 0 AND (totals.has_overdue OR bounds.current_day > 10)) AS critical_alert_active,
      COALESCE(jsonb_agg(
        jsonb_build_object('month', fd.due_month, 'amount', fd.amount,
          'paid_amount', fd.paid_amount,
          'remaining_amount', fd.amount - fd.paid_amount)
        ORDER BY fd.due_month
      ) FILTER (WHERE fd.id IS NOT NULL), '[]'::jsonb) AS monthly_dues
    FROM students s
    JOIN groups g ON g.id = s.group_id
    CROSS JOIN bounds
    CROSS JOIN current_due
    CROSS JOIN upcoming_due
    CROSS JOIN totals
    LEFT JOIN fee_dues fd ON fd.student_id = s.id
    WHERE s.id = $1
    GROUP BY s.id, s.billing_start_month, g.id, bounds.current_month, bounds.upcoming_month, bounds.month_end, bounds.today, bounds.current_day,
      current_due.amount, current_due.paid_amount, upcoming_due.amount, upcoming_due.paid_amount,
      totals.required_amount, totals.paid_amount, totals.remaining_balance, totals.has_overdue
  `, [studentId]);
  return result.rows[0] || null;
}

export async function getStudentPaymentHistory(studentId, { db = query } = {}) {
  const result = await resolveExecutor(db)(
    `SELECT p.id, p.amount, p.payment_date, p.paid_at, p.payment_method, p.notes, p.payment_months, p.whatsapp_notified,
        (pr.id IS NOT NULL) AS is_reversed,
        pr.created_at AS reversed_at,
        COALESCE(t.name, t.username, t.email, 'Staff') AS paid_by
       FROM payments p
       LEFT JOIN payment_reversals pr ON pr.payment_id = p.id
       LEFT JOIN teachers t ON t.id = COALESCE(p.paid_by, p.recorded_by)
       WHERE p.student_id=$1
       ORDER BY COALESCE(p.paid_at, p.payment_date) DESC`,
    [studentId]
  );
  return result.rows;
}

export async function getStudentFeePortalData(studentId, { dbPool = pool } = {}) {
  const normalizedStudentId = Number(studentId);
  await ensureMonthlyFees(normalizedStudentId, dbPool);
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const db = client.query.bind(client);
    const summary = await getFeeSummary(normalizedStudentId, { ensure: false, db });
    const payments = await getStudentPaymentHistory(normalizedStudentId, { db });
    await client.query("COMMIT");
    return { summary, payments, payment_status: summary?.payment_status || "unpaid" };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function recordFullPayment({ studentId, actorId, paymentMethod = "cash", notes = null, idempotencyKey = null, whatsappNotified = false, discountAmount = 0, isExempt = false, request = null }) {
  await ensureMonthlyFees(Number(studentId));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (idempotencyKey) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [idempotencyKey]);
      const existing = await client.query("SELECT * FROM payments WHERE idempotency_key = $1 FOR UPDATE", [idempotencyKey]);
      if (existing.rowCount) {
        if (!paymentRequestMatches(existing.rows[0], { studentId, paymentType: "normal", paymentMethod, discountAmount, isExempt })) {
          await client.query("ROLLBACK");
          return { idempotency_conflict: true };
        }
        const whatsapp = whatsappNotified
          ? await enqueueReceiptNotificationInTransaction(client, { paymentId: existing.rows[0].id })
          : null;
        if (whatsappNotified) {
          const considered = Boolean(whatsapp?.queued || ["already_queued", "already_sent", "already_processed"].includes(whatsapp?.reason));
          await client.query("UPDATE payments SET whatsapp_notified = $2 WHERE id = $1", [existing.rows[0].id, considered]);
        }
        await client.query("COMMIT");
        return { payment: existing.rows[0], whatsapp, replayed: true };
      }
    }
    const dues = await client.query(`
      SELECT fd.id, fd.due_month, fd.amount, fd.paid_amount, fd.group_id,
        s.full_name, s.student_code, s.student_serial, s.scan_serial,
        COALESCE(g.display_name, g.name) AS group_name,
        COALESCE(g.grade_level, g.grade) AS grade_level
      FROM fee_dues fd
      JOIN students s ON s.id = fd.student_id
      JOIN groups g ON g.id = fd.group_id
      WHERE fd.student_id = $1 AND s.is_active = TRUE AND s.deleted_at IS NULL AND g.is_active = TRUE
        AND fd.amount > fd.paid_amount
      ORDER BY fd.due_month
      FOR UPDATE
    `, [studentId]);
    const remaining = dues.rows.reduce((sum, due) => sum + Number(due.amount) - Number(due.paid_amount), 0);
    if (remaining <= 0) {
      await client.query("ROLLBACK");
      return null;
    }

    const rawDiscount = Number(discountAmount);
    if (!Number.isFinite(rawDiscount) || rawDiscount < 0) {
      await client.query("ROLLBACK");
      return { error: "invalid_discount" };
    }
    const normalizedDiscount = Math.round(rawDiscount * 100) / 100;
    if (normalizedDiscount > remaining + 0.001) {
      await client.query("ROLLBACK");
      return { error: "invalid_discount" };
    }
    const appliedDiscount = isExempt ? Math.round(remaining * 100) / 100 : normalizedDiscount;
    const paidAmount = isExempt ? 0 : Math.max(0, Math.round((remaining - appliedDiscount) * 100) / 100);
    const coveredMonths = [];
    for (const due of dues.rows) {
      const dueRemaining = Number(due.amount) - Number(due.paid_amount);
      if (dueRemaining <= 0) continue;
      coveredMonths.push({ month: due.due_month, amount: dueRemaining });
      await client.query("UPDATE fee_dues SET paid_amount = amount WHERE id = $1", [due.id]);
    }
    const groupId = dues.rows[0].group_id;
    const payment = await client.query(`
      INSERT INTO payments (
        student_id, group_id, amount, payment_date, paid_at, payment_method,
        notes, recorded_by, paid_by, payment_months, paid_amount, discount_amount, is_exempt, whatsapp_notified, idempotency_key,
        student_name_snapshot, student_code_snapshot, student_serial_snapshot,
        scan_serial_snapshot, group_name_snapshot, grade_level_snapshot
      ) VALUES ($1, $2, $3, NOW(), NOW(), $4, $5, $6, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
      ON CONFLICT DO NOTHING
      RETURNING *
    `, [
      studentId, groupId, paidAmount, paymentMethod, notes, actorId, JSON.stringify(coveredMonths), paidAmount, appliedDiscount, Boolean(isExempt), Boolean(whatsappNotified), idempotencyKey,
      dues.rows[0].full_name, dues.rows[0].student_code, dues.rows[0].student_serial,
      dues.rows[0].scan_serial, dues.rows[0].group_name, dues.rows[0].grade_level
    ]);
    if (!payment.rowCount && idempotencyKey) {
      const existing = await client.query("SELECT * FROM payments WHERE idempotency_key = $1 FOR UPDATE", [idempotencyKey]);
      const whatsapp = whatsappNotified && existing.rows[0]
        ? await enqueueReceiptNotificationInTransaction(client, { paymentId: existing.rows[0].id })
        : null;
      if (whatsappNotified && existing.rows[0]) {
        const considered = Boolean(whatsapp?.queued || ["already_queued", "already_sent", "already_processed"].includes(whatsapp?.reason));
        await client.query("UPDATE payments SET whatsapp_notified = $2 WHERE id = $1", [existing.rows[0].id, considered]);
      }
      await client.query("COMMIT");
      return { payment: existing.rows[0] || null, whatsapp, replayed: true };
    }
    const paymentReference = `P-${String(payment.rows[0].id).padStart(8, "0")}`;
    await client.query("UPDATE payments SET payment_reference = $1 WHERE id = $2", [paymentReference, payment.rows[0].id]);
    payment.rows[0].payment_reference = paymentReference;
    const whatsapp = whatsappNotified
      ? await enqueueReceiptNotificationInTransaction(client, { paymentId: payment.rows[0].id })
      : null;
    if (whatsappNotified) {
      const considered = Boolean(whatsapp?.queued || ["already_queued", "already_sent", "already_processed"].includes(whatsapp?.reason));
      await client.query("UPDATE payments SET whatsapp_notified = $2 WHERE id = $1", [payment.rows[0].id, considered]);
      payment.rows[0].whatsapp_notified = considered;
    }
    await auditLog({
      db: client,
      action: "payment_created",
      actorId,
      studentId,
      paymentId: payment.rows[0].id,
      request,
      details: {
        amount: Number(paidAmount),
        discount_amount: Number(appliedDiscount),
        is_exempt: Boolean(isExempt),
        payment_type: "normal",
        payment_method: paymentMethod,
        payment_months: coveredMonths,
        student_name_snapshot: dues.rows[0].full_name,
        student_code_snapshot: dues.rows[0].student_code,
        status_after: "paid",
        affected_dues: coveredMonths
      },
      throwOnError: true
    });
    await client.query("COMMIT");
    payment.rows[0].gross_amount = remaining;
    payment.rows[0].discount_amount = appliedDiscount;
    payment.rows[0].is_exempt = Boolean(isExempt);
    return { payment: payment.rows[0], whatsapp };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function advanceMonthKeys(currentMonth, count = 6) {
  const [year, month] = currentMonth.split("-").map(Number);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(year, month - 1 + index + 1, 1));
    return monthKey(date);
  });
}

export async function getAdvanceOptions(studentId) {
  await ensureMonthlyFees(Number(studentId));
  const result = await query(`
    SELECT s.id, s.full_name, s.student_code, s.student_serial, s.billing_start_month,
      g.id AS group_id, g.name AS group_name, g.fees_amount,
      to_char(date_trunc('month', (NOW() AT TIME ZONE 'Africa/Cairo')), 'YYYY-MM') AS current_month,
      COALESCE((SELECT SUM(fd.amount - fd.paid_amount) FROM fee_dues fd
        WHERE fd.student_id=s.id
          AND fd.due_month=date_trunc('month', (NOW() AT TIME ZONE 'Africa/Cairo'))::date), 0) AS current_cycle_outstanding
    FROM students s
    JOIN groups g ON g.id = s.group_id
    WHERE s.id=$1 AND s.deleted_at IS NULL AND s.is_active=TRUE
      AND g.deleted_at IS NULL AND g.is_active=TRUE
  `, [studentId]);
  const student = result.rows[0];
  if (!student) return null;

  const currentMonth = String(student.current_month).slice(0, 7);
  const keys = advanceMonthKeys(currentMonth);
  const dues = await query(`
    SELECT due_month::text AS due_month, amount, paid_amount
    FROM fee_dues
    WHERE student_id=$1 AND due_month >= $2::date AND due_month < (($2::date + INTERVAL '7 months')::date)
    ORDER BY due_month
  `, [studentId, `${currentMonth}-01`]);
  const dueByMonth = new Map(dues.rows.map((due) => [String(due.due_month).slice(0, 7), due]));
  const currentCycleOutstanding = Number(student.current_cycle_outstanding || 0);
  return {
    student: {
      id: student.id,
      full_name: student.full_name,
      student_code: student.student_code,
      student_serial: student.student_serial,
      billing_start_month: student.billing_start_month,
      group_id: student.group_id,
      group_name: student.group_name,
      fees_amount: student.fees_amount
    },
    current_month: currentMonth,
    current_cycle_outstanding: currentCycleOutstanding,
    advance_locked: currentCycleOutstanding > 0,
    months: currentCycleOutstanding > 0 ? [] : keys.map((month) => {
      const due = dueByMonth.get(month);
      const amount = Number(due?.amount ?? student.fees_amount ?? 0);
      const paidAmount = Number(due?.paid_amount ?? 0);
      return { month: `${month}-01`, amount, paid_amount: paidAmount, remaining_amount: Math.max(0, amount - paidAmount), available: amount > paidAmount };
    })
  };
}

export async function recordAdvancePayment({ studentId, actorId, months, paymentMethod = "cash", notes = null, idempotencyKey = null, whatsappNotified = false, request = null }) {
  await ensureMonthlyFees(Number(studentId));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (idempotencyKey) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [idempotencyKey]);
      const existing = await client.query("SELECT * FROM payments WHERE idempotency_key = $1 FOR UPDATE", [idempotencyKey]);
      if (existing.rowCount) {
        if (!paymentRequestMatches(existing.rows[0], { studentId, paymentType: "advance", paymentMethod, months })) {
          await client.query("ROLLBACK");
          return { error: "idempotency_conflict" };
        }
        const whatsapp = whatsappNotified
          ? await enqueueAdvancePaymentNotificationInTransaction(client, { paymentId: existing.rows[0].id })
          : null;
        if (whatsappNotified) {
          const considered = Boolean(whatsapp?.queued || ["already_queued", "already_sent", "already_processed"].includes(whatsapp?.reason));
          await client.query("UPDATE payments SET whatsapp_notified = $2 WHERE id = $1", [existing.rows[0].id, considered]);
        }
        await client.query("COMMIT");
        return { payment: existing.rows[0], months: existing.rows[0].payment_months || [], whatsapp, replayed: true };
      }
    }
    const studentResult = await client.query(`
      SELECT s.id, s.group_id, s.full_name, s.student_code, s.student_serial, s.scan_serial,
        g.fees_amount, COALESCE(g.display_name, g.name) AS group_name,
        COALESCE(g.grade_level, g.grade) AS grade_level
      FROM students s JOIN groups g ON g.id=s.group_id
      WHERE s.id=$1 AND s.deleted_at IS NULL AND s.is_active=TRUE
        AND g.deleted_at IS NULL AND g.is_active=TRUE
      FOR UPDATE OF s
    `, [studentId]);
    const student = studentResult.rows[0];
    if (!student) {
      await client.query("ROLLBACK");
      return { error: "student_not_found" };
    }

    const todayResult = await client.query("SELECT to_char(date_trunc('month', (NOW() AT TIME ZONE 'Africa/Cairo')), 'YYYY-MM') AS current_month");
    const currentMonth = String(todayResult.rows[0].current_month).slice(0, 7);
    const currentDueResult = await client.query(`
      SELECT amount, paid_amount
      FROM fee_dues
      WHERE student_id=$1 AND due_month=$2::date
      FOR UPDATE
    `, [student.id, `${currentMonth}-01`]);
    const currentOutstanding = currentDueResult.rows.reduce((sum, due) => sum + Number(due.amount) - Number(due.paid_amount), 0);
    if (currentOutstanding > 0) {
      await client.query("ROLLBACK");
      return { error: "current_month_unpaid" };
    }
    const allowedMonths = new Set(advanceMonthKeys(currentMonth));
    const selectedMonths = [...new Set((Array.isArray(months) ? months : []).map((month) => String(month).trim().slice(0, 7)))];
    if (!selectedMonths.length || selectedMonths.some((month) => !/^\d{4}-\d{2}$/.test(month) || !allowedMonths.has(month))) {
      await client.query("ROLLBACK");
      return { error: "invalid_months" };
    }

    const coveredMonths = [];
    for (const month of selectedMonths) {
      await client.query(`
        INSERT INTO fee_dues (student_id, group_id, due_month, amount)
        VALUES ($1, $2, $3::date, $4)
        ON CONFLICT (student_id, due_month) DO NOTHING
      `, [student.id, student.group_id, `${month}-01`, student.fees_amount]);
      const dueResult = await client.query(`
        SELECT id, amount, paid_amount FROM fee_dues
        WHERE student_id=$1 AND due_month=$2::date FOR UPDATE
      `, [student.id, `${month}-01`]);
      const due = dueResult.rows[0];
      if (!due || Number(due.paid_amount) >= Number(due.amount)) {
        await client.query("ROLLBACK");
        return { error: "month_already_paid", month };
      }
      const remaining = Number(due.amount) - Number(due.paid_amount);
      await client.query("UPDATE fee_dues SET paid_amount=amount WHERE id=$1", [due.id]);
      coveredMonths.push({ month: `${month}-01`, amount: remaining });
    }

    const amount = coveredMonths.reduce((sum, item) => sum + Number(item.amount), 0);
    const payment = await client.query(`
      INSERT INTO payments (student_id, group_id, amount, paid_amount, discount_amount, is_exempt, payment_date, paid_at, payment_method,
        notes, recorded_by, paid_by, payment_months, payment_type, whatsapp_notified, idempotency_key,
        student_name_snapshot, student_code_snapshot, student_serial_snapshot,
        scan_serial_snapshot, group_name_snapshot, grade_level_snapshot)
      VALUES ($1, $2, $3, $3, 0, FALSE, NOW(), NOW(), $4, $5, $6, $6, $7::jsonb, 'advance', $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT DO NOTHING
      RETURNING *
    `, [
      student.id, student.group_id, amount, paymentMethod, notes, actorId, JSON.stringify(coveredMonths), Boolean(whatsappNotified), idempotencyKey,
      student.full_name, student.student_code, student.student_serial,
      student.scan_serial, student.group_name, student.grade_level
    ]);
    if (!payment.rowCount && idempotencyKey) {
      const existing = await client.query("SELECT * FROM payments WHERE idempotency_key = $1 FOR UPDATE", [idempotencyKey]);
      const whatsapp = whatsappNotified && existing.rows[0]
        ? await enqueueAdvancePaymentNotificationInTransaction(client, { paymentId: existing.rows[0].id })
        : null;
      if (whatsappNotified && existing.rows[0]) {
        const considered = Boolean(whatsapp?.queued || ["already_queued", "already_sent", "already_processed"].includes(whatsapp?.reason));
        await client.query("UPDATE payments SET whatsapp_notified = $2 WHERE id = $1", [existing.rows[0].id, considered]);
      }
      await client.query("COMMIT");
      return { payment: existing.rows[0] || null, months: existing.rows[0]?.payment_months || [], whatsapp, replayed: true };
    }
    const paymentReference = `P-${String(payment.rows[0].id).padStart(8, "0")}`;
    await client.query("UPDATE payments SET payment_reference = $1 WHERE id = $2", [paymentReference, payment.rows[0].id]);
    payment.rows[0].payment_reference = paymentReference;
    const whatsapp = whatsappNotified
      ? await enqueueAdvancePaymentNotificationInTransaction(client, { paymentId: payment.rows[0].id })
      : null;
    if (whatsappNotified) {
      const considered = Boolean(whatsapp?.queued || ["already_queued", "already_sent", "already_processed"].includes(whatsapp?.reason));
      await client.query("UPDATE payments SET whatsapp_notified = $2 WHERE id = $1", [payment.rows[0].id, considered]);
      payment.rows[0].whatsapp_notified = considered;
    }
    await auditLog({
      db: client,
      action: "advance_payment_created",
      actorId,
      studentId: student.id,
      paymentId: payment.rows[0].id,
      request,
      details: {
        amount: Number(amount),
        payment_type: "advance",
        payment_method: paymentMethod,
        payment_months: coveredMonths,
        student_name_snapshot: student.full_name,
        student_code_snapshot: student.student_code,
        status_after: "paid",
        affected_dues: coveredMonths
      },
      throwOnError: true
    });
    await client.query("COMMIT");
    return { payment: payment.rows[0], months: coveredMonths, whatsapp };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
