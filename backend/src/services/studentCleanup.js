import { pool } from "../db/pool.js";

// Preserve the student row so historical foreign keys remain valid.
export async function purgeDeletedStudents() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(`
      SELECT id FROM students
      WHERE deleted_at IS NOT NULL AND purge_after IS NOT NULL AND purge_after <= NOW()
      FOR UPDATE
    `);
    for (const row of result.rows) {
      await client.query(`
        UPDATE students
        SET full_name = 'Archived student #' || id, phone = NULL, guardian_phone = NULL,
            national_id_hash = NULL, qr_token = NULL, is_active = FALSE,
            purge_after = NULL, updated_at = NOW()
        WHERE id = $1
      `, [row.id]);
      await client.query(`
        INSERT INTO audit_logs(action, student_id, details)
        VALUES ('student_personal_data_purged', $1, $2)
      `, [row.id, JSON.stringify({ reason: "retention_window_expired" })]);
    }
    await client.query("COMMIT");
    return result.rowCount;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
