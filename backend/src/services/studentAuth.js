import { query } from "../db/pool.js";
import { verifyStudentToken } from "./auth.js";
import { normalizeStudentCode } from "../utils/normalizeDigits.js";

export async function authenticatedStudent(req, db = query) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const tokenPayload = verifyStudentToken(token);
  if (tokenPayload) {
    const result = await db("SELECT id, group_id FROM students WHERE id=$1 AND is_active=TRUE AND deleted_at IS NULL LIMIT 1", [tokenPayload.sub]);
    return result.rows[0] || null;
  }

  // Student identity must come from the signed session token by default. A
  // header-only fallback is an explicit opt-in for legacy local tooling.
  if (process.env.ALLOW_INSECURE_STUDENT_HEADER !== "true") return null;
  const code = normalizeStudentCode(req.headers["x-student-code"] || "");
  const result = await db(
    "SELECT id, group_id FROM students WHERE (student_code=$1 OR student_serial=$1 OR student_serial=$2) AND is_active=TRUE AND deleted_at IS NULL LIMIT 1",
    [code, code.replace(/^A(\d{4})$/, "A-$1")]
  );
  return result.rows[0] || null;
}
