import { query } from "../db/pool.js";

export async function getDashboardData(studentId) {
  const attendance = await query(
    `
      SELECT
        ar.id,
        ar.status,
        ar.checkin_time,
        ar.distance_meters,
        ar.is_suspicious,
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
      SELECT e.id, e.title, e.max_score, e.exam_date, er.score, er.note
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
