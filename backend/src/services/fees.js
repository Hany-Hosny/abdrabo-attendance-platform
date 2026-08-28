import { pool, query } from "../db/pool.js";

// Creates any missing monthly dues up to the current month. The unique key on
// fee_dues makes this safe to run at startup, on the first day, or on demand.
export async function ensureMonthlyFees() {
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
    ON CONFLICT (student_id, due_month) DO NOTHING
  `);
}

export async function getFeeSummary(studentId) {
  await ensureMonthlyFees();
  const result = await query(`
    WITH current_due AS (
      SELECT fd.amount, fd.paid_amount
      FROM fee_dues fd
      WHERE fd.student_id = $1
        AND fd.due_month = date_trunc('month', (NOW() AT TIME ZONE 'Africa/Cairo'))::date
    ), totals AS (
      SELECT COALESCE(SUM(fd.amount), 0) AS required_amount,
        COALESCE(SUM(fd.paid_amount), 0) AS paid_amount,
        COALESCE(SUM(fd.amount - fd.paid_amount), 0) AS remaining_balance,
        BOOL_OR(fd.due_month < date_trunc('month', (NOW() AT TIME ZONE 'Africa/Cairo'))::date AND fd.amount > fd.paid_amount) AS has_overdue
      FROM fee_dues fd WHERE fd.student_id = $1
    )
    SELECT s.id, s.full_name, s.student_serial, s.student_code,
      COALESCE(g.grade_level, g.grade) AS grade_level, g.name AS group_name,
      g.fees_amount,
      totals.required_amount, totals.paid_amount, totals.remaining_balance,
      COALESCE((SELECT SUM(amount) FROM current_due), 0) AS current_cycle_fee,
      COALESCE((SELECT SUM(paid_amount) FROM current_due), 0) AS current_cycle_paid,
      COALESCE((SELECT SUM(amount - paid_amount) FROM current_due), 0) AS current_cycle_outstanding,
      COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.student_id = s.id), 0) AS total_historical_payments,
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
    CROSS JOIN totals
    LEFT JOIN fee_dues fd ON fd.student_id = s.id
    WHERE s.id = $1
    GROUP BY s.id, g.id, totals.required_amount, totals.paid_amount, totals.remaining_balance, totals.has_overdue
  `, [studentId]);
  return result.rows[0] || null;
}

export async function recordFullPayment({ studentId, actorId, paymentMethod = "cash", notes = null }) {
  await ensureMonthlyFees();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const dues = await client.query(`
      SELECT fd.id, fd.due_month, fd.amount, fd.paid_amount, fd.group_id
      FROM fee_dues fd
      JOIN students s ON s.id = fd.student_id
      JOIN groups g ON g.id = fd.group_id
      WHERE fd.student_id = $1 AND s.is_active = TRUE AND g.is_active = TRUE
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
        notes, recorded_by, paid_by, payment_months
      ) VALUES ($1, $2, $3, NOW(), NOW(), $4, $5, $6, $6, $7::jsonb)
      RETURNING *
    `, [studentId, groupId, remaining, paymentMethod, notes, actorId, JSON.stringify(coveredMonths)]);
    await client.query("COMMIT");
    return payment.rows[0];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
