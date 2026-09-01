import { query } from "../db/pool.js";
import { getDashboardAlertThresholds } from "./systemSettings.js";

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function boundedPercentage(numerator, denominator) {
  const bottom = finiteNumber(denominator);
  if (bottom <= 0) return null;
  return Math.min(100, Math.max(0, (finiteNumber(numerator) / bottom) * 100));
}

export function buildStudentAttention({
  attendanceSessions = 0,
  attendanceAttended = 0,
  evaluationAverage = null,
  paymentOverdue = false,
  paymentRemaining = 0,
  thresholds = { attendanceAlert: 70, evaluationAlert: 60 },
  includePayment = false
} = {}) {
  const attendanceRate = boundedPercentage(attendanceAttended, attendanceSessions);
  const evaluationRate = evaluationAverage == null ? null : finiteNumber(evaluationAverage, null);
  const reasons = [];

  if (attendanceRate != null && attendanceRate < thresholds.attendanceAlert) {
    reasons.push({ type: "attendance", targetSection: "attendance", value: attendanceRate, threshold: thresholds.attendanceAlert });
  }
  if (evaluationRate != null && evaluationRate < thresholds.evaluationAlert) {
    reasons.push({ type: "evaluation", targetSection: "evaluations", value: evaluationRate, threshold: thresholds.evaluationAlert });
  }
  if (includePayment && paymentOverdue) {
    reasons.push({ type: "payment", targetSection: "payments", amount: Math.max(0, finiteNumber(paymentRemaining)) });
  }

  return { attendanceRate, evaluationRate, reasons };
}

export async function listStudentsNeedingAttention({ groupId = null, includePayment = false, limit = 25, db = query } = {}) {
  const thresholds = await getDashboardAlertThresholds(db);
  const safeLimit = Math.min(50, Math.max(1, Number(limit) || 25));
  const values = [thresholds.attendanceAlert, thresholds.evaluationAlert];
  const groupFilter = groupId ? "AND s.group_id = $3" : "";
  const attentionFilter = `AND (
      (COALESCE(a.attendance_sessions, 0) > 0 AND COALESCE(a.attendance_attended, 0) / a.attendance_sessions::numeric * 100 < $1)
      OR (e.evaluation_average IS NOT NULL AND e.evaluation_average < $2)
      ${includePayment ? "OR COALESCE(f.payment_overdue, FALSE)" : ""}
    )`;
  if (groupId) values.push(groupId);
  values.push(safeLimit);
  const limitParam = `$${values.length}`;
  const result = await db(`
    WITH attendance_summary AS (
      SELECT s.id,
        COUNT(DISTINCT ats.id)::int AS attendance_sessions,
        COUNT(ar.id) FILTER (WHERE ar.status IN ('present', 'late'))::int AS attendance_attended
      FROM students s
      LEFT JOIN attendance_sessions ats
        ON ats.group_id = s.group_id
       AND ats.status <> 'cancelled'
       AND ats.session_date <= (NOW() AT TIME ZONE 'Africa/Cairo')::date
      LEFT JOIN attendance_records ar ON ar.session_id = ats.id AND ar.student_id = s.id
      WHERE s.is_active = TRUE AND s.deleted_at IS NULL ${groupFilter}
      GROUP BY s.id
    ), evaluation_summary AS (
      SELECT er.student_id,
        AVG(CASE WHEN e.max_score > 0 THEN er.score / e.max_score * 100 END) AS evaluation_average
      FROM exam_results er
      JOIN exams e ON e.id = er.exam_id
      WHERE e.exam_date <= (NOW() AT TIME ZONE 'Africa/Cairo')::date
      GROUP BY er.student_id
    ), fee_summary AS (
      SELECT fd.student_id,
        SUM(fd.amount - fd.paid_amount) AS remaining_amount,
        BOOL_OR(fd.due_month < date_trunc('month', (NOW() AT TIME ZONE 'Africa/Cairo'))::date AND fd.amount > fd.paid_amount) AS payment_overdue
      FROM fee_dues fd
      GROUP BY fd.student_id
    )
    SELECT s.id, s.full_name, s.student_code, s.student_serial, s.group_id,
      COALESCE(g.display_name, g.name) AS group_name,
      COALESCE(a.attendance_sessions, 0) AS attendance_sessions,
      COALESCE(a.attendance_attended, 0) AS attendance_attended,
      e.evaluation_average,
      COALESCE(f.payment_overdue, FALSE) AS payment_overdue,
      ${includePayment ? "COALESCE(f.remaining_amount, 0)" : "0"} AS payment_remaining
    FROM students s
    JOIN groups g ON g.id = s.group_id AND g.is_active = TRUE AND g.deleted_at IS NULL
    LEFT JOIN attendance_summary a ON a.id = s.id
    LEFT JOIN evaluation_summary e ON e.student_id = s.id
    LEFT JOIN fee_summary f ON f.student_id = s.id
    WHERE s.is_active = TRUE AND s.deleted_at IS NULL ${groupFilter} ${attentionFilter}
    ORDER BY s.full_name ASC
    LIMIT ${limitParam}
  `, values);

  return {
    thresholds,
    students: result.rows.map((row) => {
      const attention = buildStudentAttention({
        attendanceSessions: row.attendance_sessions,
        attendanceAttended: row.attendance_attended,
        evaluationAverage: row.evaluation_average,
        paymentOverdue: row.payment_overdue,
        paymentRemaining: row.payment_remaining,
        thresholds,
        includePayment
      });
      return {
        studentId: Number(row.id),
        studentName: row.full_name,
        studentCode: row.student_code,
        studentSerial: row.student_serial,
        groupId: Number(row.group_id),
        groupName: row.group_name,
        attendanceRate: attention.attendanceRate,
        evaluationAverage: attention.evaluationRate,
        reasons: attention.reasons
      };
    }).filter((student) => student.reasons.length > 0)
  };
}
