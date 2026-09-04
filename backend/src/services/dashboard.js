import { query } from "../db/pool.js";
import { getDashboardAlertThresholds } from "./systemSettings.js";

export const DASHBOARD_THRESHOLDS = Object.freeze({
  attendanceAlert: 70,
  evaluationAlert: 60
});

const PERIODS = new Set(["current", "previous", "last3", "last6", "year", "custom"]);

function cairoDateParts(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Cairo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(value);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}

function isoDate(year, month, day = 1) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function addMonths(value, count) {
  const date = new Date(`${value}T00:00:00Z`);
  return isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1 + count, date.getUTCDate());
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function getDashboardPeriod(period = "current", customFrom, customTo, now = new Date()) {
  const selected = PERIODS.has(period) ? period : "current";
  const current = cairoDateParts(now);
  const currentMonth = isoDate(Number(current.year), Number(current.month));
  const today = isoDate(Number(current.year), Number(current.month), Number(current.day));
  let from = currentMonth;
  let to = addMonths(today, 0);

  if (selected === "previous") {
    from = addMonths(currentMonth, -1);
    to = addMonths(currentMonth, 0);
    return {
      period: selected,
      from,
      to,
      endExclusive: to,
      dueEndExclusive: to,
      previousFrom: addMonths(from, -1),
      previousEndExclusive: from,
      previousDueEndExclusive: addMonths(from, 0)
    };
  }
  if (selected === "last3" || selected === "last6") {
    from = addMonths(currentMonth, selected === "last3" ? -2 : -5);
  } else if (selected === "year") {
    from = isoDate(Number(current.year), 1);
  } else if (selected === "custom" && isValidDate(customFrom) && isValidDate(customTo) && customFrom <= customTo) {
    from = customFrom;
    to = customTo;
  }

  const endExclusive = addDays(to, 1);
  const dueEndExclusive = dueEndForEndExclusive(endExclusive);
  const previousEndExclusive = from;
  const previousFrom = selected === "last3"
    ? addMonths(from, -3)
    : selected === "last6"
      ? addMonths(from, -6)
      : selected === "year"
        ? addMonths(from, -12)
        : selected === "custom"
          ? addDays(from, -Math.max(1, Math.round((Date.parse(`${endExclusive}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000)))
          : addMonths(from, -1);
  return {
    period: selected,
    from,
    to,
    endExclusive,
    dueEndExclusive,
    previousFrom,
    previousEndExclusive,
    previousDueEndExclusive: dueEndForEndExclusive(previousEndExclusive)
  };
}

function addDays(value, count) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

export function percentage(numerator, denominator) {
  const top = numberOrZero(numerator);
  const bottom = numberOrZero(denominator);
  return bottom > 0 ? Math.min(100, Math.max(0, (top / bottom) * 100)) : null;
}

export function changePercentage(current, previous) {
  const currentValue = numberOrZero(current);
  const previousValue = numberOrZero(previous);
  if (previousValue === 0) return currentValue === 0 ? 0 : null;
  return ((currentValue - previousValue) / Math.abs(previousValue)) * 100;
}

function groupClause(groupId, alias, values) {
  if (!groupId) return "";
  values.push(groupId);
  return ` AND ${alias}.group_id = $${values.length}`;
}

function dueEndForEndExclusive(value) {
  const date = new Date(`${value}T00:00:00Z`);
  const start = isoDate(date.getUTCFullYear(), date.getUTCMonth() + 1);
  return date.getUTCDate() === 1 ? start : addMonths(start, 1);
}

export function scopeDashboardPayload(payload, permissions = {}) {
  const canFinancial = Boolean(permissions.financial);
  const canGroups = Boolean(permissions.groupPerformance);
  const canAlerts = Boolean(permissions.alerts);
  const canActivity = Boolean(permissions.activity && canFinancial);
  const scoped = {
    ...payload,
    permissions: {
      financial: canFinancial,
      groupPerformance: canGroups,
      alerts: canAlerts,
      activity: canActivity
    }
  };

  if (!canFinancial) {
    scoped.summary = null;
    scoped.collection = null;
    scoped.previousCollection = null;
    scoped.studentStatus = null;
    scoped.revenueTrend = null;
    scoped.recentPayments = null;
    if (Array.isArray(scoped.groupPerformance)) {
      scoped.groupPerformance = scoped.groupPerformance.map(({ collectionRate, overdueCount, ...performance }) => performance);
    }
  }
  if (!canGroups) scoped.groupPerformance = null;
  if (!canAlerts) scoped.alerts = null;
  if (!canActivity) scoped.recentPayments = null;
  return scoped;
}

export async function getExecutiveDashboard({ period, from, to, groupId } = {}, permissions = {}) {
  const bounds = getDashboardPeriod(period, from, to);
  const selectedGroupId = Number.isSafeInteger(Number(groupId)) && Number(groupId) > 0 ? Number(groupId) : null;
  const canFinancial = Boolean(permissions.financial);
  const canGroups = Boolean(permissions.groupPerformance);
  const canAlerts = Boolean(permissions.alerts);
  const canActivity = Boolean(permissions.activity && permissions.financial);
  const thresholds = canAlerts ? await getDashboardAlertThresholds() : DASHBOARD_THRESHOLDS;

  const groupsPromise = query(`
    SELECT g.id, COALESCE(g.display_name, g.name) AS name,
      COALESCE(g.grade_level, g.grade) AS grade_level,
      (SELECT COUNT(*)::int FROM students st WHERE st.group_id = g.id AND st.is_active = TRUE AND st.deleted_at IS NULL) AS active_students
    FROM groups g
    WHERE g.is_active = TRUE AND g.deleted_at IS NULL
    ORDER BY COALESCE(g.display_name, g.name)
  `);

  const groups = (await groupsPromise).rows.map((row) => ({
    id: Number(row.id),
    name: row.name,
    grade_level: row.grade_level,
    active_students: Number(row.active_students || 0)
  }));

  const financialPromise = canFinancial ? (async () => {
    const values = [bounds.from, bounds.dueEndExclusive, bounds.previousFrom, bounds.previousDueEndExclusive, bounds.from, bounds.endExclusive, bounds.previousFrom, bounds.previousEndExclusive];
    const selectedClause = groupClause(selectedGroupId, "s", values);
    const previousSelectedClause = groupClause(selectedGroupId, "s", values);
    const paymentSelectedClause = groupClause(selectedGroupId, "p", values);
    const result = await query(`
      WITH current_dues AS (
        SELECT fd.student_id, SUM(fd.amount) AS required_amount,
          SUM(LEAST(fd.amount, fd.paid_amount)) AS collected_amount
        FROM fee_dues fd JOIN students s ON s.id = fd.student_id
        JOIN groups g ON g.id = fd.group_id AND g.is_active = TRUE AND g.deleted_at IS NULL
        WHERE s.is_active = TRUE AND s.deleted_at IS NULL
          AND fd.due_month >= $1::date AND fd.due_month < $2::date ${selectedClause}
        GROUP BY fd.student_id
      ), previous_dues AS (
        SELECT fd.student_id, SUM(fd.amount) AS required_amount,
          SUM(LEAST(fd.amount, fd.paid_amount)) AS collected_amount
        FROM fee_dues fd JOIN students s ON s.id = fd.student_id
        JOIN groups g ON g.id = fd.group_id AND g.is_active = TRUE AND g.deleted_at IS NULL
        WHERE s.is_active = TRUE AND s.deleted_at IS NULL
          AND fd.due_month >= $3::date AND fd.due_month < $4::date ${previousSelectedClause}
        GROUP BY fd.student_id
      ), period_payments AS (
          SELECT COALESCE(SUM(p.amount) FILTER (WHERE COALESCE(p.paid_at, p.payment_date) >= ($5::date AT TIME ZONE 'Africa/Cairo') AND COALESCE(p.paid_at, p.payment_date) < ($6::date AT TIME ZONE 'Africa/Cairo')), 0) AS period_income,
          COALESCE(SUM(p.amount) FILTER (WHERE COALESCE(p.paid_at, p.payment_date) >= ($7::date AT TIME ZONE 'Africa/Cairo') AND COALESCE(p.paid_at, p.payment_date) < ($8::date AT TIME ZONE 'Africa/Cairo')), 0) AS previous_income
        FROM payments p
        WHERE NOT EXISTS (SELECT 1 FROM payment_reversals pr WHERE pr.payment_id = p.id) ${paymentSelectedClause}
      ), historical AS (
        SELECT COALESCE(SUM(p.amount), 0) AS total_income
        FROM payments p
        WHERE NOT EXISTS (SELECT 1 FROM payment_reversals pr WHERE pr.payment_id = p.id) ${paymentSelectedClause}
      )
      SELECT
        (SELECT COALESCE(SUM(required_amount), 0) FROM current_dues) AS required_amount,
        (SELECT COALESCE(SUM(collected_amount), 0) FROM current_dues) AS collected_amount,
        (SELECT COUNT(*) FROM current_dues WHERE collected_amount > 0) AS paid_students,
        (SELECT COUNT(*) FROM current_dues WHERE collected_amount < required_amount) AS overdue_students,
        (SELECT COUNT(*) FROM current_dues) AS applicable_students,
        (SELECT COALESCE(SUM(required_amount), 0) FROM previous_dues) AS previous_required_amount,
        (SELECT COALESCE(SUM(collected_amount), 0) FROM previous_dues) AS previous_collected_amount,
        (SELECT COUNT(*) FROM previous_dues WHERE collected_amount > 0) AS previous_paid_students,
        (SELECT COUNT(*) FROM previous_dues WHERE collected_amount < required_amount) AS previous_overdue_students,
        (SELECT COUNT(*) FROM previous_dues) AS previous_applicable_students,
        period_payments.period_income, period_payments.previous_income,
        historical.total_income
      FROM period_payments CROSS JOIN historical
    `, values);
    const row = result.rows[0] || {};
    const required = numberOrZero(row.required_amount);
    const collected = numberOrZero(row.collected_amount);
    const applicable = numberOrZero(row.applicable_students);
    const previousRequired = numberOrZero(row.previous_required_amount);
    const previousCollected = numberOrZero(row.previous_collected_amount);
    return {
      summary: {
        totalIncome: numberOrZero(row.total_income),
        periodIncome: numberOrZero(row.period_income),
        paidStudentsCount: numberOrZero(row.paid_students),
        paidStudentsPercentage: percentage(row.paid_students, applicable),
        overdueStudentsCount: numberOrZero(row.overdue_students),
        overdueStudentsPercentage: percentage(row.overdue_students, applicable),
        collectionRate: percentage(collected, required),
        comparison: {
          periodIncome: changePercentage(row.period_income, row.previous_income),
          paidStudents: changePercentage(row.paid_students, row.previous_paid_students),
          overdueStudents: changePercentage(row.overdue_students, row.previous_overdue_students),
          collectionRate: changePercentage(percentage(collected, required), percentage(previousCollected, previousRequired))
        }
      },
      collection: { required, collected, remaining: Math.max(0, required - collected), rate: percentage(collected, required) },
      previousCollection: { required: previousRequired, collected: previousCollected, rate: percentage(previousCollected, previousRequired) },
      periodIncome: numberOrZero(row.period_income)
    };
  })() : Promise.resolve(null);

  const groupPerformancePromise = canGroups ? query(`
    WITH student_counts AS (
      SELECT group_id, COUNT(*)::int AS student_count
      FROM students WHERE is_active = TRUE AND deleted_at IS NULL
      GROUP BY group_id
    ), sessions AS (
      SELECT group_id, COUNT(*)::int AS session_count
      FROM attendance_sessions
      WHERE session_date >= $1::date AND session_date < $2::date
      GROUP BY group_id
    ), attendance AS (
      SELECT ats.group_id, COUNT(*) FILTER (WHERE ar.status IN ('present', 'late'))::int AS attended_count
      FROM attendance_records ar JOIN attendance_sessions ats ON ats.id = ar.session_id
      JOIN students s ON s.id = ar.student_id AND s.is_active = TRUE AND s.deleted_at IS NULL
      WHERE ats.session_date >= $1::date AND ats.session_date < $2::date
      GROUP BY ats.group_id
    ), evaluations AS (
      SELECT e.group_id, AVG(CASE WHEN e.max_score > 0 THEN er.score / e.max_score * 100 END) AS evaluation_average
      FROM exam_results er JOIN exams e ON e.id = er.exam_id
      JOIN students s ON s.id = er.student_id AND s.is_active = TRUE AND s.deleted_at IS NULL
      WHERE e.exam_date >= $1::date AND e.exam_date < $2::date
      GROUP BY e.group_id
    ), dues AS (
      SELECT fd.group_id, SUM(fd.amount) AS required_amount, SUM(LEAST(fd.amount, fd.paid_amount)) AS collected_amount,
        COUNT(*) FILTER (WHERE fd.amount > fd.paid_amount)::int AS overdue_dues
      FROM fee_dues fd JOIN students s ON s.id = fd.student_id AND s.is_active = TRUE AND s.deleted_at IS NULL
      WHERE fd.due_month >= $3::date AND fd.due_month < $4::date
      GROUP BY fd.group_id
    )
    SELECT g.id, COALESCE(g.display_name, g.name) AS name,
      COALESCE(sc.student_count, 0) AS student_count,
      COALESCE(sc.student_count, 0) AS active_students,
      COALESCE(ses.session_count, 0) AS session_count,
      COALESCE(att.attended_count, 0) AS attended_count,
      ev.evaluation_average,
      COALESCE(d.required_amount, 0) AS required_amount,
      COALESCE(d.collected_amount, 0) AS collected_amount,
      COALESCE(d.overdue_dues, 0) AS overdue_dues
    FROM groups g
    LEFT JOIN student_counts sc ON sc.group_id = g.id
    LEFT JOIN sessions ses ON ses.group_id = g.id
    LEFT JOIN attendance att ON att.group_id = g.id
    LEFT JOIN evaluations ev ON ev.group_id = g.id
    LEFT JOIN dues d ON d.group_id = g.id
    WHERE g.is_active = TRUE AND g.deleted_at IS NULL ${selectedGroupId ? "AND g.id = $5" : ""}
    ORDER BY COALESCE(g.display_name, g.name)
  `, selectedGroupId ? [bounds.from, bounds.endExclusive, bounds.from, bounds.dueEndExclusive, selectedGroupId] : [bounds.from, bounds.endExclusive, bounds.from, bounds.dueEndExclusive]) : Promise.resolve(null);

  const alertValues = [bounds.from, bounds.endExclusive];
  const alertGroupClause = selectedGroupId ? "AND s.group_id = $3" : "";
  if (selectedGroupId) alertValues.push(selectedGroupId);
  const attendanceThresholdParam = `$${alertValues.length + 1}`;
  alertValues.push(thresholds.attendanceAlert / 100);
  const evaluationThresholdParam = `$${alertValues.length + 1}`;
  alertValues.push(thresholds.evaluationAlert);

  const alertsPromise = canAlerts ? query(`
    WITH students_in_scope AS (
      SELECT s.id, s.group_id
      FROM students s JOIN groups g ON g.id = s.group_id
      WHERE s.is_active = TRUE AND s.deleted_at IS NULL AND g.is_active = TRUE AND g.deleted_at IS NULL ${alertGroupClause}
    ), attendance_scope AS (
      SELECT sis.id, COUNT(DISTINCT ats.id) AS sessions,
        COUNT(*) FILTER (WHERE ar.status IN ('present', 'late')) AS attended
      FROM students_in_scope sis
      LEFT JOIN attendance_sessions ats ON ats.group_id = sis.group_id AND ats.session_date >= $1::date AND ats.session_date < $2::date
      LEFT JOIN attendance_records ar ON ar.session_id = ats.id AND ar.student_id = sis.id
      GROUP BY sis.id
    ), low_attendance AS (
      SELECT COUNT(*)::int AS count FROM attendance_scope
      WHERE sessions > 0 AND attended / sessions::numeric < ${attendanceThresholdParam}
    ), low_evaluations AS (
      SELECT COUNT(*)::int AS count FROM (
        SELECT er.student_id, AVG(CASE WHEN e.max_score > 0 THEN er.score / e.max_score * 100 END) AS average
        FROM exam_results er JOIN exams e ON e.id = er.exam_id JOIN students s ON s.id = er.student_id
        WHERE e.exam_date >= $1::date AND e.exam_date < $2::date AND s.is_active = TRUE AND s.deleted_at IS NULL ${alertGroupClause}
        GROUP BY er.student_id
      ) scores WHERE average < ${evaluationThresholdParam}
    )
    SELECT (SELECT count FROM low_attendance) AS low_attendance_count,
      (SELECT count FROM low_evaluations) AS low_evaluation_count
  `, alertValues) : Promise.resolve(null);

  const revenueTrendPromise = canFinancial ? query(`
    WITH months AS (
      SELECT generate_series(date_trunc('month', (NOW() AT TIME ZONE 'Africa/Cairo')) - INTERVAL '5 months', date_trunc('month', (NOW() AT TIME ZONE 'Africa/Cairo')), INTERVAL '1 month')::date AS month
    )
    SELECT to_char(months.month, 'YYYY-MM') AS month,
      COALESCE(SUM(p.amount), 0) AS amount
    FROM months LEFT JOIN payments p
      ON COALESCE(p.paid_at, p.payment_date) >= (months.month AT TIME ZONE 'Africa/Cairo')
      AND COALESCE(p.paid_at, p.payment_date) < ((months.month + INTERVAL '1 month') AT TIME ZONE 'Africa/Cairo')
      AND NOT EXISTS (SELECT 1 FROM payment_reversals pr WHERE pr.payment_id = p.id)
      ${selectedGroupId ? "AND p.group_id = $1" : ""}
    GROUP BY months.month ORDER BY months.month
  `, selectedGroupId ? [selectedGroupId] : []) : Promise.resolve(null);

  const recentPaymentsPromise = canActivity ? query(`
    SELECT p.id, p.student_id, p.amount, COALESCE(p.paid_at, p.payment_date) AS paid_at,
      p.payment_method, COALESCE(p.student_name_snapshot, s.full_name) AS student_name,
      COALESCE(p.group_name_snapshot, COALESCE(g.display_name, g.name)) AS group_name
    FROM payments p LEFT JOIN students s ON s.id = p.student_id JOIN groups g ON g.id = p.group_id
    WHERE COALESCE(p.paid_at, p.payment_date) >= ($1::date AT TIME ZONE 'Africa/Cairo')
      AND COALESCE(p.paid_at, p.payment_date) < ($2::date AT TIME ZONE 'Africa/Cairo')
      AND NOT EXISTS (SELECT 1 FROM payment_reversals pr WHERE pr.payment_id = p.id)
      ${selectedGroupId ? "AND p.group_id = $3" : ""}
    ORDER BY COALESCE(p.paid_at, p.payment_date) DESC LIMIT 6
  `, selectedGroupId ? [bounds.from, bounds.endExclusive, selectedGroupId] : [bounds.from, bounds.endExclusive]) : Promise.resolve(null);

  const [financial, groupPerformance, alerts, revenueTrend, recentPayments] = await Promise.all([
    financialPromise,
    groupPerformancePromise,
    alertsPromise,
    revenueTrendPromise,
    recentPaymentsPromise
  ]);

  return scopeDashboardPayload({
    ok: true,
    filters: {
      period: bounds.period,
      from: bounds.from,
      to: bounds.to,
      groups
    },
    permissions: { financial: canFinancial, groupPerformance: canGroups, alerts: canAlerts, activity: canActivity },
    summary: financial?.summary || null,
    collection: financial?.collection || null,
    previousCollection: financial?.previousCollection || null,
    studentStatus: financial ? {
      paid: financial.summary.paidStudentsCount,
      paidPercentage: financial.summary.paidStudentsPercentage,
      overdue: financial.summary.overdueStudentsCount,
      overduePercentage: financial.summary.overdueStudentsPercentage
    } : null,
    groupPerformance: groupPerformance?.rows.map((row) => {
      const performance = {
        groupId: Number(row.id),
        groupName: row.name,
        studentCount: Number(row.student_count || 0),
        activeStudents: Number(row.active_students || 0),
        attendanceRate: percentage(row.attended_count, numberOrZero(row.session_count) * numberOrZero(row.student_count)),
        evaluationAverage: row.evaluation_average == null ? null : numberOrZero(row.evaluation_average)
      };
      return canFinancial ? { ...performance, collectionRate: percentage(row.collected_amount, row.required_amount), overdueCount: Number(row.overdue_dues || 0) } : performance;
    }) || null,
    revenueTrend: revenueTrend?.rows.map((row) => ({ month: row.month, amount: numberOrZero(row.amount) })) || null,
    alerts: alerts?.rows[0] ? [
      ...(Number(alerts.rows[0].low_attendance_count || 0) > 0 ? [{ type: "attendance", count: Number(alerts.rows[0].low_attendance_count), threshold: thresholds.attendanceAlert }] : []),
      ...(Number(alerts.rows[0].low_evaluation_count || 0) > 0 ? [{ type: "evaluation", count: Number(alerts.rows[0].low_evaluation_count), threshold: thresholds.evaluationAlert }] : [])
    ] : null,
    recentPayments: recentPayments?.rows.map((row) => ({
      id: Number(row.id),
      studentId: Number(row.student_id),
      amount: numberOrZero(row.amount),
      paidAt: row.paid_at,
      paymentMethod: row.payment_method,
      studentName: row.student_name,
      groupName: row.group_name
    })) || null
  }, { financial: canFinancial, groupPerformance: canGroups, alerts: canAlerts, activity: canActivity });
}

export async function getDashboardData(studentId) {
  const attendance = await query(
    `
      SELECT
        ar.id,
        ar.status,
        ar.checkin_time,
        ar.distance_meters,
        ar.is_suspicious,
        ar.whatsapp_notified,
        s.session_date,
        g.subject,
        g.name AS group_name
      FROM attendance_records ar
      JOIN attendance_sessions s ON s.id = ar.session_id
      JOIN groups g ON g.id = s.group_id
      WHERE ar.student_id = $1 AND EXISTS (SELECT 1 FROM students active_student WHERE active_student.id = ar.student_id AND active_student.deleted_at IS NULL)
      ORDER BY ar.checkin_time DESC
      LIMIT 10
    `,
    [studentId]
  );

  const exams = await query(
    `
      SELECT e.id, e.title, e.max_score, e.exam_date, er.score, er.note, er.note AS assessment, er.whatsapp_notified
      FROM exam_results er
      JOIN exams e ON e.id = er.exam_id
      WHERE er.student_id = $1 AND EXISTS (SELECT 1 FROM students active_student WHERE active_student.id = er.student_id AND active_student.deleted_at IS NULL)
      ORDER BY e.exam_date DESC
    `,
    [studentId]
  );

  const schedules = await query(
    `
      SELECT cs.day_of_week, cs.start_time, cs.end_time, g.subject, g.name AS group_name
      FROM students st
      JOIN groups g ON g.id = st.group_id
      JOIN class_schedules cs ON cs.group_id = g.id
      WHERE st.id = $1 AND st.deleted_at IS NULL AND cs.is_active = TRUE
      ORDER BY cs.day_of_week, cs.start_time
    `,
    [studentId]
  );

  return {
    attendance: attendance.rows,
    exams: exams.rows,
    schedules: schedules.rows,
    assignments: [],
    notes: []
  };
}
