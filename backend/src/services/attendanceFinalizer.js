import { pool } from "../db/pool.js";
import { auditLog } from "./audit.js";

const FINALIZER_LOCK_KEY = "abdrabo-attendance-expiry-finalizer";

/**
 * Closes expired attendance sessions and fills in missing student records.
 *
 * The operation is intentionally idempotent: the attendance record unique
 * constraint protects against duplicate rows, while the session lock keeps
 * concurrent workers from finalizing the same session at the same time.
 */
export async function finalizeExpiredAttendanceSessions({ now = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [FINALIZER_LOCK_KEY]);

    const expired = await client.query(`
      SELECT s.id, s.group_id, s.closes_at, s.ends_at
      FROM attendance_sessions s
      JOIN groups g ON g.id = s.group_id AND g.deleted_at IS NULL
      JOIN class_schedules cs ON cs.id = s.schedule_id AND cs.group_id = s.group_id
      WHERE s.status = 'open'
        AND s.ends_at <= COALESCE($1::timestamptz, NOW())
      ORDER BY s.ends_at, s.id
      FOR UPDATE OF s
    `, [now]);

    const finalized = [];
    for (const session of expired.rows) {
      const inserted = await client.query(`
        INSERT INTO attendance_records (
          session_id, student_id, student_name_snapshot, student_code_snapshot,
          status, method, checkin_time
        )
        SELECT $1, st.id, st.full_name, st.student_code,
          'absent', 'system', $3
        FROM students st
        WHERE st.group_id = $2
          AND st.is_active = TRUE
          AND st.deleted_at IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM attendance_records ar
            WHERE ar.session_id = $1 AND ar.student_id = st.id
          )
        ON CONFLICT (session_id, student_id) DO NOTHING
        RETURNING id, student_id
      `, [session.id, session.group_id, session.ends_at]);

      const closed = await client.query(`
        UPDATE attendance_sessions
        SET status = 'closed'
        WHERE id = $1 AND status = 'open'
        RETURNING id
      `, [session.id]);

      if (!closed.rowCount) continue;

      await auditLog({
        db: client,
        action: "attendance_session_auto_finalized",
        sessionId: session.id,
        details: {
          group_id: session.group_id,
          status_after: "closed",
          automatic_absence_count: inserted.rowCount,
          automatic_absence_student_ids: inserted.rows.map((row) => row.student_id)
        }
      });

      finalized.push({
        session_id: session.id,
        automatic_absence_count: inserted.rowCount
      });
    }

    await client.query("COMMIT");
    return { finalized_sessions: finalized };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
