import { query } from "../db/pool.js";
import { verifyStudentToken } from "./auth.js";
import { normalizeStudentCode } from "../utils/normalizeDigits.js";

export async function authenticatedStudent(req, db = query) {
  req.studentAuthStatus = undefined;
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const tokenPayload = verifyStudentToken(token);
  if (tokenPayload) {
    const result = await db("SELECT id, group_id, is_active, absence_frozen FROM students WHERE id=$1 AND deleted_at IS NULL LIMIT 1", [tokenPayload.sub]);
    const student = result.rows[0];
    if (student?.absence_frozen) {
      req.studentAuthStatus = "account_frozen";
      return null;
    }
    return student && student.is_active !== false ? student : null;
  }

  // Student identity must come from the signed session token by default. A
  // header-only fallback is an explicit opt-in for legacy local tooling.
  if (process.env.ALLOW_INSECURE_STUDENT_HEADER !== "true") return null;
  const code = normalizeStudentCode(req.headers["x-student-code"] || "");
  const result = await db(
    "SELECT id, group_id, is_active, absence_frozen FROM students WHERE (student_code=$1 OR student_serial=$1 OR student_serial=$2) AND deleted_at IS NULL LIMIT 1",
    [code, code.replace(/^A(\d{4})$/, "A-$1")]
  );
  const student = result.rows[0];
  if (student?.absence_frozen) {
    req.studentAuthStatus = "account_frozen";
    return null;
  }
  return student && student.is_active !== false ? student : null;
}

export function studentAuthFailure(req, res, extra = {}) {
  return res.status(401).json({ ok: false, status: req.studentAuthStatus || "unauthorized", ...extra });
}
