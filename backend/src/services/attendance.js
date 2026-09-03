import { query } from "../db/pool.js";
import { getDashboardData } from "./dashboard.js";
import { finalizeExpiredAttendanceSessions } from "./attendanceFinalizer.js";
import { normalizeStudentCode } from "../utils/normalizeDigits.js";

function toRad(value) {
  return (value * Math.PI) / 180;
}

export function distanceMeters(lat1, lon1, lat2, lon2) {
  const earthRadius = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return earthRadius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function loginAndRecordAttendance({ student_code, device_id, latitude, longitude, ip }) {
  student_code = normalizeStudentCode(student_code);
  await finalizeExpiredAttendanceSessions();
  const studentResult = await query(
    `
      SELECT
        st.id,
        st.full_name,
        st.student_code,
        st.student_serial,
        st.scan_serial,
        st.group_id,
        g.name AS group_name,
        COALESCE(g.grade_level, g.grade) AS grade_level,
        g.subject,
        g.is_active AS group_active,
        c.name AS center_name,
        c.latitude AS center_latitude,
        c.longitude AS center_longitude,
        c.allowed_radius_meters
      FROM students st
      JOIN groups g ON g.id = st.group_id
      JOIN centers c ON c.id = g.center_id
      WHERE (st.student_code = $1 OR st.student_serial = $1 OR st.student_serial = $2) AND st.is_active = TRUE AND st.deleted_at IS NULL
      LIMIT 1
    `,
    [student_code, String(student_code).replace(/^A(\d{4})$/, "A-$1")]
  );

  if (!studentResult.rowCount || !studentResult.rows[0].group_active) {
    return { ok: false, status: "invalid_student", message: "Invalid or inactive student code." };
  }

  const student = studentResult.rows[0];
  const publicStudent = {
    id: student.id,
    full_name: student.full_name,
    student_code: student.student_code,
    student_serial: student.student_serial,
    scan_serial: student.scan_serial,
    group_name: student.group_name,
    grade_level: student.grade_level,
    subject: student.subject
  };
  const dashboard = await getDashboardData(student.id);
  const sessionResult = await query(
    `
      SELECT s.*, g.subject, g.name AS group_name
      FROM attendance_sessions s
      JOIN groups g ON g.id = s.group_id AND g.is_active = TRUE AND g.deleted_at IS NULL
      JOIN class_schedules cs ON cs.id = s.schedule_id AND cs.group_id = s.group_id
        AND cs.is_active = TRUE AND cs.day_of_week = EXTRACT(DOW FROM s.session_date)::INTEGER
      WHERE s.group_id = $1
        AND s.session_date = (NOW() AT TIME ZONE 'Africa/Cairo')::date
        AND s.status = 'open'
        AND NOW() BETWEEN s.opens_at AND s.closes_at
      ORDER BY s.starts_at ASC
      LIMIT 1
    `,
    [student.group_id]
  );

  if (!sessionResult.rowCount) {
    return {
      ok: true,
      status: "no_open_session",
      message: "There is no open class right now.",
      student: publicStudent,
      dashboard
    };
  }

  const session = sessionResult.rows[0];
  const hasLocation = Number.isFinite(latitude) && Number.isFinite(longitude);
  if (!hasLocation) {
    return {
      ok: true,
      status: "location_required",
      message: "Location access is required to record attendance.",
      student: publicStudent,
      today_session: session,
      dashboard
    };
  }

  const distance = distanceMeters(
    Number(latitude),
    Number(longitude),
    Number(student.center_latitude),
    Number(student.center_longitude)
  );

  if (distance > Number(student.allowed_radius_meters)) {
    return {
      ok: true,
      status: "outside_center_radius",
      message: "Student is outside the center range.",
      student: publicStudent,
      today_session: session,
      distance_meters: Math.round(distance),
      dashboard
    };
  }

  const suspiciousResult = await query(
    `
      SELECT id, student_id
      FROM attendance_records
      WHERE session_id = $1 AND device_id = $2 AND student_id <> $3
      LIMIT 1
    `,
    [session.id, device_id, student.id]
  );

  const isSuspicious = suspiciousResult.rowCount > 0;
  const recordStatus = isSuspicious ? "pending_review" : "present";
  const suspiciousReason = isSuspicious
    ? "The same device checked in another student for this session."
    : null;

  const record = await query(
    `
      INSERT INTO attendance_records (
        session_id,
        student_id,
        status,
        method,
        checkin_time,
        location_lat,
        location_lng,
        distance_meters,
        device_id,
        ip_address,
        is_suspicious,
        suspicious_reason
      )
      VALUES ($1, $2, $3, 'gps', NOW(), $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (session_id, student_id) DO UPDATE SET
        checkin_time = attendance_records.checkin_time
      RETURNING *
    `,
    [
      session.id,
      student.id,
      recordStatus,
      latitude,
      longitude,
      distance,
      device_id,
      ip,
      isSuspicious,
      suspiciousReason
    ]
  );

  return {
    ok: true,
    status: record.rows[0].status === "pending_review" ? "pending_review" : "attendance_recorded",
    message:
      record.rows[0].status === "pending_review"
        ? "Attendance recorded and pending review."
        : "Attendance recorded successfully.",
    student: publicStudent,
    today_session: session,
    attendance_record: record.rows[0],
    dashboard: await getDashboardData(student.id)
  };
}
