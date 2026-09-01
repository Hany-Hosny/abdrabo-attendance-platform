import { pool } from "../db/pool.js";
import { DEFAULT_STUDENT_RETENTION, permanentlyDeleteStudents } from "./studentDeletion.js";

// Expired archived students follow the same atomic historical-retention path
// as an explicit permanent delete. The safe default preserves all supported
// history while removing the live identity completely.
export async function purgeDeletedStudents() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(`
      SELECT id FROM students
      WHERE deleted_at IS NOT NULL AND purge_after IS NOT NULL AND purge_after <= NOW()
      FOR UPDATE
    `);
    for (const row of result.rows) await permanentlyDeleteStudents({
      client,
      studentIds: [Number(row.id)],
      retain: { ...DEFAULT_STUDENT_RETENTION },
      actorId: null,
      request: null
    });
    await client.query("COMMIT");
    return result.rowCount;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
