import { auditLog } from "./audit.js";

export const DEFAULT_STUDENT_RETENTION = Object.freeze({
  evaluations: true,
  financial: true,
  attendance: true,
  notes: true
});

const RETENTION_KEYS = Object.keys(DEFAULT_STUDENT_RETENTION);

export function parseStudentRetention(value) {
  if (value === undefined || value === null) return { ok: true, retain: { ...DEFAULT_STUDENT_RETENTION } };
  if (typeof value !== "object" || Array.isArray(value)) return { ok: false, status: "invalid_retention" };

  if (Object.keys(value).some((key) => !RETENTION_KEYS.includes(key))) return { ok: false, status: "invalid_retention" };

  const retain = { ...DEFAULT_STUDENT_RETENTION };
  for (const key of RETENTION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key) && typeof value[key] !== "boolean") {
      return { ok: false, status: "invalid_retention" };
    }
    if (Object.prototype.hasOwnProperty.call(value, key)) retain[key] = value[key];
  }
  return { ok: true, retain };
}

async function retainRows(client, table, studentIds) {
  await client.query(
    `UPDATE ${table} r
     SET student_name_snapshot = COALESCE(r.student_name_snapshot, s.full_name),
         student_code_snapshot = COALESCE(r.student_code_snapshot, s.student_code),
         student_id = NULL
     FROM students s
     WHERE r.student_id = s.id AND r.student_id = ANY($1::int[])`,
    [studentIds]
  );
}

async function retainFinancialRows(client, studentIds) {
  await client.query(`
    UPDATE payments p
    SET student_name_snapshot = COALESCE(p.student_name_snapshot, s.full_name),
        student_code_snapshot = COALESCE(p.student_code_snapshot, s.student_code),
        student_serial_snapshot = COALESCE(p.student_serial_snapshot, s.student_serial),
        scan_serial_snapshot = COALESCE(p.scan_serial_snapshot, s.scan_serial),
        group_name_snapshot = COALESCE(p.group_name_snapshot, COALESCE(g.display_name, g.name)),
        grade_level_snapshot = COALESCE(p.grade_level_snapshot, COALESCE(g.grade_level, g.grade)),
        student_id = NULL
    FROM students s
    LEFT JOIN groups g ON g.id = p.group_id
    WHERE p.student_id = s.id AND p.student_id = ANY($1::int[])
  `, [studentIds]);
  await client.query(`
    UPDATE fee_dues fd
    SET student_name_snapshot = COALESCE(fd.student_name_snapshot, s.full_name),
        student_code_snapshot = COALESCE(fd.student_code_snapshot, s.student_code),
        student_serial_snapshot = COALESCE(fd.student_serial_snapshot, s.student_serial),
        group_name_snapshot = COALESCE(fd.group_name_snapshot, COALESCE(g.display_name, g.name)),
        student_id = NULL
    FROM students s
    LEFT JOIN groups g ON g.id = fd.group_id
    WHERE fd.student_id = s.id AND fd.student_id = ANY($1::int[])
  `, [studentIds]);
}

async function removeRows(client, studentIds, retain) {
  if (retain.financial) await retainFinancialRows(client, studentIds);
  else {
    await client.query("DELETE FROM payment_reversals WHERE payment_id IN (SELECT id FROM payments WHERE student_id = ANY($1::int[]))", [studentIds]);
    await client.query("DELETE FROM payment_change_requests WHERE payment_id IN (SELECT id FROM payments WHERE student_id = ANY($1::int[]))", [studentIds]);
    await client.query("DELETE FROM payments WHERE student_id = ANY($1::int[])", [studentIds]);
    await client.query("DELETE FROM fee_dues WHERE student_id = ANY($1::int[])", [studentIds]);
  }

  if (retain.attendance) await retainRows(client, "attendance_records", studentIds);
  else await client.query("DELETE FROM attendance_records WHERE student_id = ANY($1::int[])", [studentIds]);

  if (retain.evaluations) await retainRows(client, "exam_results", studentIds);
  else await client.query("DELETE FROM exam_results WHERE student_id = ANY($1::int[])", [studentIds]);

  if (retain.notes) {
    await retainRows(client, "student_notes", studentIds);
    await retainRows(client, "homework_submissions", studentIds);
  } else {
    await client.query("DELETE FROM student_notes WHERE student_id = ANY($1::int[])", [studentIds]);
    await client.query("DELETE FROM homework_submissions WHERE student_id = ANY($1::int[])", [studentIds]);
  }

  // These records describe the live identity or an active conversation, not a
  // retained historical category. Remove them before deleting the student so
  // the existing foreign keys remain enabled and enforceable.
  await client.query("DELETE FROM serial_change_requests WHERE student_id = ANY($1::int[])", [studentIds]);
  await client.query("DELETE FROM inbox_threads WHERE student_id = ANY($1::int[])", [studentIds]);
  await client.query("DELETE FROM notifications WHERE entity_type = 'student' AND entity_id = ANY($1::bigint[])", [studentIds]);
}

export async function permanentlyDeleteStudents({ client, studentIds, retain, actorId, request = null }) {
  const beforeResult = await client.query(`
    SELECT s.id, s.full_name, s.student_code, s.student_serial, s.scan_serial, s.group_id,
      COALESCE(g.display_name, g.name) AS group_name,
      COALESCE(g.grade_level, g.grade) AS grade_level,
      s.deleted_at
    FROM students s
    LEFT JOIN groups g ON g.id = s.group_id
    WHERE s.id = ANY($1::int[])
    FOR UPDATE OF s
  `, [studentIds]);
  const foundIds = new Set(beforeResult.rows.map((row) => Number(row.id)));
  const missingIds = studentIds.filter((id) => !foundIds.has(id));
  if (missingIds.length) {
    const error = new Error("student_not_found");
    error.status = "student_not_found";
    error.missingStudentIds = missingIds;
    throw error;
  }

  await removeRows(client, studentIds, retain);

  const auditStudents = beforeResult.rows.map((row) => ({
    id: Number(row.id),
    name: row.full_name,
    code: row.student_code,
    student_serial: row.student_serial,
    group_id: row.group_id,
    group_name: row.group_name,
    grade_level: row.grade_level
  }));
  await auditLog({
    db: client,
    action: studentIds.length === 1 ? "student_permanently_deleted" : "students_bulk_permanently_deleted",
    actorId,
    studentId: null,
    request,
    throwOnError: true,
    details: {
      operation: "permanent_student_delete",
      deletion_type: "permanent",
      students: auditStudents,
      retained_categories: Object.entries(retain).filter(([, value]) => value).map(([key]) => key),
      removed_categories: Object.entries(retain).filter(([, value]) => !value).map(([key]) => key),
      identity_removed: true,
      notifications_removed: true
    }
  });

  const deletedResult = await client.query("DELETE FROM students WHERE id = ANY($1::int[]) RETURNING id", [studentIds]);
  if (deletedResult.rowCount !== studentIds.length) {
    const error = new Error("permanent_delete_conflict");
    error.status = "permanent_delete_conflict";
    throw error;
  }
  return { deletedCount: deletedResult.rowCount, students: auditStudents };
}
