import { query } from "../db/pool.js";
import { normalizeDigits } from "../utils/normalizeDigits.js";

export function normalizeStudentSearch(value) {
  return normalizeDigits(String(value ?? "")).trim().replace(/\s+/g, " ");
}

export async function searchStudents(value, { limit = 12, db = query } = {}) {
  const term = normalizeStudentSearch(value);
  if (term.length < 2) return [];
  const safeLimit = Math.min(20, Math.max(1, Number(limit) || 12));
  const result = await db(`
    SELECT s.id, s.full_name, s.student_code, s.student_serial, s.group_id,
      COALESCE(g.display_name, g.name) AS group_name,
      COALESCE(g.grade_level, g.grade) AS grade_level,
      s.is_active
    FROM students s
    JOIN groups g ON g.id = s.group_id
    WHERE s.deleted_at IS NULL AND s.is_active = TRUE
      AND g.deleted_at IS NULL AND g.is_active = TRUE
      AND (
        s.full_name ILIKE $1 OR s.student_code ILIKE $1 OR s.student_serial ILIKE $1
        OR s.scan_serial ILIKE $1 OR s.phone ILIKE $1 OR s.guardian_phone ILIKE $1
        OR COALESCE(g.display_name, g.name) ILIKE $1
      )
    ORDER BY
      CASE WHEN LOWER(s.student_code) = LOWER($2) THEN 0
           WHEN LOWER(s.student_serial) = LOWER($2) THEN 1
           WHEN LOWER(s.full_name) = LOWER($2) THEN 2
           ELSE 3 END,
      s.full_name ASC
    LIMIT $3
  `, [`%${term}%`, term, safeLimit]);
  return result.rows.map((row) => ({
    id: Number(row.id),
    name: row.full_name,
    studentCode: row.student_code,
    studentSerial: row.student_serial,
    groupId: Number(row.group_id),
    groupName: row.group_name,
    gradeLevel: row.grade_level,
    isActive: row.is_active
  }));
}
