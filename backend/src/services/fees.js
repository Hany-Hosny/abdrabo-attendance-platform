import { pool, query } from "../db/pool.js";
import { auditLog } from "./audit.js";

// Creates any missing monthly dues up to the current month. The unique key on
// fee_dues makes this safe to run at startup, on the first day, or on demand.
export async function ensureMonthlyFees(studentId = null) {
  await query(`
    INSERT INTO fee_dues (student_id, group_id, due_month, amount)
    SELECT s.id, s.group_id, months.due_month::date, g.fees_amount
    FROM students s
    JOIN groups g ON g.id = s.group_id
    CROSS JOIN LATERAL generate_series(
      date_trunc('month', s.created_at AT TIME ZONE 'Africa/Cairo')::date,
      date_trunc('month', (NOW() AT TIME ZONE 'Africa/Cairo'))::date,
      INTERVAL '1 month'
    ) AS months(due_month)
    WHERE s.is_active = TRUE AND s.deleted_at IS NULL
      AND g.is_active = TRUE AND g.deleted_at IS NULL
      AND ($1::integer IS NULL OR s.id = $1)
    ON CONFLICT (student_id, due_month) DO NOTHING
  `, [studentId]);
}

export async function getFeeSummary(studentId, { ensure = true } = {}) {
  if (ensure) await ensureMonthlyFees(Number(studentId));
  const result = await query(`
    WITH bounds AS (
      SELECT date_trunc('month', (NOW() AT TIME ZONE 'Africa/Cairo'))::date AS current_month,
        (date_trunc('month', (NOW() AT TIME ZONE 'Africa/Cairo')) + INTERVAL '1 month')::date AS upcoming_month,
        (date_trunc('month', (NOW() AT TIME ZONE 'Africa/Cairo')) + INTERVAL '2 months' - INTERVAL '1 day')::date AS month_end,
        (NOW() AT TIME ZONE 'Africa/Cairo')::date AS today
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
        BOOL_OR(fd.due_month < (SELECT current_month FROM bounds) AND fd.amount > fd.paid_amount) AS has_overdue
      FROM fee_dues fd WHERE fd.student_id = $1
    )
    SELECT s.id, s.full_name, s.student_serial, s.student_code,
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
      CASE WHEN totals.remaining_balance <= 0 THEN 'paid'
        WHEN totals.has_overdue THEN 'overdue' ELSE 'unpaid' END AS payment_status,
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
    GROUP BY s.id, g.id, bounds.current_month, bounds.upcoming_month, bounds.month_end, bounds.today,
      current_due.amount, current_due.paid_amount, upcoming_due.amount, upcoming_due.paid_amount,
      totals.required_amount, totals.paid_amount, totals.remaining_balance, totals.has_overdue
  `, [studentId]);
  return result.rows[0] || null;
}

export async function recordFullPayment({ studentId, actorId, paymentMethod = "cash", notes = null, idempotencyKey = null, request = null }) {
  await ensureMonthlyFees(Number(studentId));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (idempotencyKey) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [idempotencyKey]);
      const existing = await client.query("SELECT * FROM payments WHERE idempotency_key = $1 FOR UPDATE", [idempotencyKey]);
      if (existing.rowCount) {
        if (Number(existing.rows[0].student_id) !== Number(studentId) || existing.rows[0].payment_type !== "normal" || existing.rows[0].payment_method !== paymentMethod) {
          await client.query("ROLLBACK");
          return { idempotency_conflict: true };
        }
        await client.query("COMMIT");
        return existing.rows[0];
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
        notes, recorded_by, paid_by, payment_months, idempotency_key,
        student_name_snapshot, student_code_snapshot, student_serial_snapshot,
        scan_serial_snapshot, group_name_snapshot, grade_level_snapshot
      ) VALUES ($1, $2, $3, NOW(), NOW(), $4, $5, $6, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT DO NOTHING
      RETURNING *
    `, [
      studentId, groupId, remaining, paymentMethod, notes, actorId, JSON.stringify(coveredMonths), idempotencyKey,
      dues.rows[0].full_name, dues.rows[0].student_code, dues.rows[0].student_serial,
      dues.rows[0].scan_serial, dues.rows[0].group_name, dues.rows[0].grade_level
    ]);
    if (!payment.rowCount && idempotencyKey) {
      const existing = await client.query("SELECT * FROM payments WHERE idempotency_key = $1 FOR UPDATE", [idempotencyKey]);
      await client.query("COMMIT");
      return existing.rows[0] || null;
    }
    const paymentReference = `P-${String(payment.rows[0].id).padStart(8, "0")}`;
    await client.query("UPDATE payments SET payment_reference = $1 WHERE id = $2", [paymentReference, payment.rows[0].id]);
    payment.rows[0].payment_reference = paymentReference;
    await auditLog({
      db: client,
      action: "payment_created",
      actorId,
      studentId,
      paymentId: payment.rows[0].id,
      request,
      details: {
        amount: Number(remaining),
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
    return payment.rows[0];
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
    SELECT s.id, s.full_name, s.student_code, s.student_serial,
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

export async function recordAdvancePayment({ studentId, actorId, months, paymentMethod = "cash", notes = null, idempotencyKey = null, request = null }) {
  await ensureMonthlyFees(Number(studentId));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (idempotencyKey) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [idempotencyKey]);
      const existing = await client.query("SELECT * FROM payments WHERE idempotency_key = $1 FOR UPDATE", [idempotencyKey]);
      if (existing.rowCount) {
        if (Number(existing.rows[0].student_id) !== Number(studentId) || existing.rows[0].payment_type !== "advance" || existing.rows[0].payment_method !== paymentMethod) {
          await client.query("ROLLBACK");
          return { error: "idempotency_conflict" };
        }
        await client.query("COMMIT");
        return { payment: existing.rows[0], months: existing.rows[0].payment_months || [], replayed: true };
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
      INSERT INTO payments (student_id, group_id, amount, payment_date, paid_at, payment_method,
        notes, recorded_by, paid_by, payment_months, payment_type, idempotency_key,
        student_name_snapshot, student_code_snapshot, student_serial_snapshot,
        scan_serial_snapshot, group_name_snapshot, grade_level_snapshot)
      VALUES ($1, $2, $3, NOW(), NOW(), $4, $5, $6, $6, $7::jsonb, 'advance', $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT DO NOTHING
      RETURNING *
    `, [
      student.id, student.group_id, amount, paymentMethod, notes, actorId, JSON.stringify(coveredMonths), idempotencyKey,
      student.full_name, student.student_code, student.student_serial,
      student.scan_serial, student.group_name, student.grade_level
    ]);
    if (!payment.rowCount && idempotencyKey) {
      const existing = await client.query("SELECT * FROM payments WHERE idempotency_key = $1 FOR UPDATE", [idempotencyKey]);
      await client.query("COMMIT");
      return { payment: existing.rows[0] || null, months: existing.rows[0]?.payment_months || [], replayed: true };
    }
    const paymentReference = `P-${String(payment.rows[0].id).padStart(8, "0")}`;
    await client.query("UPDATE payments SET payment_reference = $1 WHERE id = $2", [paymentReference, payment.rows[0].id]);
    payment.rows[0].payment_reference = paymentReference;
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
    return { payment: payment.rows[0], months: coveredMonths };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
