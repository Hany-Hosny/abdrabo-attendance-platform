import "../config/env.js";
import { pool, query } from "./pool.js";

const LEGACY_ATTENDANCE_WHERE = `
  entity_type = 'student'
  AND entity_id IS NOT NULL
  AND group_id IS NULL
  AND COALESCE(notification_type, type) = 'attendance_low'
`;

export async function countLegacyAttendanceNotifications(db = query) {
  const result = await db(`SELECT COUNT(*)::int AS count FROM notifications WHERE ${LEGACY_ATTENDANCE_WHERE}`);
  return Number(result.rows[0]?.count || 0);
}

export async function cleanupLegacyAttendanceNotifications({ apply = false } = {}) {
  const before = await countLegacyAttendanceNotifications();
  if (!apply) return { dryRun: true, matched: before, deleted: 0 };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(`DELETE FROM notifications WHERE ${LEGACY_ATTENDANCE_WHERE} RETURNING id`);
    await client.query("COMMIT");
    return { dryRun: false, matched: before, deleted: result.rowCount };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1]?.endsWith("cleanupLegacyAttendanceNotifications.js")) {
  const apply = process.argv.includes("--apply");
  cleanupLegacyAttendanceNotifications({ apply })
    .then((result) => {
      console.log(JSON.stringify({ event: apply ? "legacy_attendance_notifications_deleted" : "legacy_attendance_notifications_verification", ...result }));
    })
    .catch((error) => {
      console.error("Legacy attendance notification cleanup failed", error);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
