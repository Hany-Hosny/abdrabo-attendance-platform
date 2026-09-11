import { query } from "../db/pool.js";
import { authenticatedStudent } from "../services/studentAuth.js";
import { evaluateAttendanceWindow } from "../utils/attendanceWindow.js";

export const ATTENDANCE_REQUIRED_MESSAGE = "يجب تسجيل الحضور في الحصة أولاً لأداء الاختبار.";

function validStudentId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Verify a student's live-session entitlement using database server time.
 * The client cannot provide or influence the timestamp used by this check.
 */
export async function verifySessionAttendance(studentId, db = query) {
  const id = validStudentId(studentId);
  if (!id) return { allowed: false, reason: "invalid_student" };

  const clock = await db("SELECT CURRENT_TIMESTAMP AS server_now");
  const serverNow = clock.rows[0]?.server_now;
  if (!serverNow) return { allowed: false, reason: "server_time_unavailable" };

  const sessions = await db(
    `
      SELECT s.id AS session_id, s.group_id, s.session_date, s.status,
        cs.day_of_week, cs.start_time, cs.end_time,
        cs.opens_before_minutes, cs.closes_after_minutes,
        g.name AS group_name, g.subject
      FROM students st
      JOIN groups g ON g.id = st.group_id
        AND g.is_active = TRUE AND g.deleted_at IS NULL
      JOIN attendance_sessions s ON s.group_id = st.group_id
        AND s.status = 'open'
        AND s.session_date = (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Cairo')::date
      JOIN class_schedules cs ON cs.id = s.schedule_id
        AND cs.group_id = s.group_id
        AND cs.is_active = TRUE AND cs.deleted_at IS NULL
      WHERE st.id = $1
        AND st.is_active = TRUE AND st.deleted_at IS NULL
      ORDER BY s.starts_at ASC, s.id ASC
    `,
    [id]
  );

  const activeSession = sessions.rows
    .map((session) => ({
      session,
      window: evaluateAttendanceWindow({
        sessionDate: String(session.session_date).slice(0, 10),
        dayOfWeek: session.day_of_week,
        startTime: session.start_time,
        endTime: session.end_time,
        openBeforeMinutes: session.opens_before_minutes,
        closeAttendanceAfterMinutes: session.closes_after_minutes,
        now: serverNow
      })
    }))
    .find((candidate) => candidate.window.allowed);

  if (!activeSession) {
    return {
      allowed: false,
      reason: "no_active_session",
      serverNow,
      timeZone: "Africa/Cairo"
    };
  }

  const attendance = await db(
    `
      SELECT id, session_id, status, checkin_time, is_suspicious
      FROM attendance_records
      WHERE session_id = $1 AND student_id = $2
        AND status IN ('present', 'late', 'pending_review')
      LIMIT 1
    `,
    [activeSession.session.session_id, id]
  );

  if (!attendance.rowCount) {
    return {
      allowed: false,
      reason: "attendance_required",
      session: activeSession.session,
      window: activeSession.window,
      serverNow,
      timeZone: "Africa/Cairo"
    };
  }

  return {
    allowed: true,
    session: activeSession.session,
    attendance: attendance.rows[0],
    window: activeSession.window,
    serverNow,
    timeZone: "Africa/Cairo"
  };
}

export async function requireActiveSessionAttendance(req, res, next) {
  try {
    const student = req.student || await authenticatedStudent(req);
    if (!student) return res.status(401).json({ ok: false, status: "unauthorized" });

    const verification = await verifySessionAttendance(student.id);
    if (!verification.allowed) {
      return res.status(403).json({
        ok: false,
        code: "ATTENDANCE_REQUIRED",
        message: ATTENDANCE_REQUIRED_MESSAGE
      });
    }

    req.student = student;
    req.activeSessionAttendance = verification;
    return next();
  } catch (error) {
    return next(error);
  }
}
