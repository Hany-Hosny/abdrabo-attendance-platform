import crypto from "node:crypto";
import { pool, query } from "../db/pool.js";
import { hashPassword, verifyPassword, createStudentToken } from "./auth.js";
import { normalizeDigits, normalizeStudentCode } from "../utils/normalizeDigits.js";
import { normalizeEgyptianPhone } from "../utils/normalizePhone.js";
import { getDashboardData } from "./dashboard.js";

export const PIN_SETUP_TTL_SECONDS = 10 * 60;
const guardianSelectionContexts = new Map();
const GUARDIAN_SELECTION_TTL_MS = PIN_SETUP_TTL_SECONDS * 1000;
const MAX_GUARDIAN_SELECTION_CONTEXTS = 5000;

export function normalizeStudentPin(value) {
  return normalizeDigits(String(value ?? "")).trim();
}

export function isValidStudentPin(value) {
  return /^\d{4}$/.test(normalizeStudentPin(value));
}

export function hashPinToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

export function createPinToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function selectionPurpose(purpose) {
  return purpose === "pin_setup" || purpose === "pin_recovery" ? purpose : null;
}

function cleanupGuardianSelectionContexts() {
  const now = Date.now();
  for (const [token, context] of guardianSelectionContexts) {
    if (context.expiresAt <= now) guardianSelectionContexts.delete(token);
  }
}

function guardianPhoneVariants(guardianPhone) {
  const canonicalPhone = normalizeEgyptianPhone(guardianPhone);
  if (!canonicalPhone) return null;
  const digits = canonicalPhone.slice(1);
  const localPhone = `0${digits.slice(2)}`;
  return {
    canonicalPhone,
    phoneVariants: [...new Set([digits, localPhone, `00${digits}`])]
  };
}

export function createGuardianSelectionContext({ purpose, studentIds }) {
  const normalizedPurpose = selectionPurpose(purpose);
  const ids = [...new Set((studentIds || []).map((id) => Number(id)).filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!normalizedPurpose || ids.length < 2) return null;
  cleanupGuardianSelectionContexts();
  while (guardianSelectionContexts.size >= MAX_GUARDIAN_SELECTION_CONTEXTS) {
    guardianSelectionContexts.delete(guardianSelectionContexts.keys().next().value);
  }
  const token = createPinToken();
  guardianSelectionContexts.set(token, {
    purpose: normalizedPurpose,
    studentIds: new Set(ids),
    expiresAt: Date.now() + GUARDIAN_SELECTION_TTL_MS
  });
  return { token, expires_in: PIN_SETUP_TTL_SECONDS };
}

export function consumeGuardianSelectionContext({ token, purpose, studentId }) {
  cleanupGuardianSelectionContexts();
  const context = guardianSelectionContexts.get(String(token || ""));
  const id = Number(studentId);
  if (!context || context.purpose !== selectionPurpose(purpose) || !context.studentIds.has(id)) return false;
  guardianSelectionContexts.delete(String(token));
  return true;
}

export async function findGuardianCandidates(guardianPhone, purpose, db = query) {
  const normalizedPurpose = selectionPurpose(purpose);
  const variants = guardianPhoneVariants(guardianPhone);
  if (!normalizedPurpose || !variants) return [];
  const result = await db(
    `SELECT st.id, st.full_name, st.student_code, st.student_serial, st.scan_serial,
      st.is_active, st.deleted_at, st.absence_frozen, st.guardian_phone,
      st.pin_hash, g.name AS group_name, g.grade, COALESCE(g.grade_level, g.grade) AS grade_level, g.subject
     FROM students st LEFT JOIN groups g ON g.id = st.group_id
     WHERE st.is_active = TRUE AND st.deleted_at IS NULL AND st.absence_frozen = FALSE
       AND translate(regexp_replace(COALESCE(st.guardian_phone, ''), '[^0-9٠-٩۰-۹]', '', 'g'), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789') = ANY($1::text[])
       AND st.pin_hash ${normalizedPurpose === "pin_setup" ? "IS NULL" : "IS NOT NULL"}
     ORDER BY st.full_name, st.id`,
    [variants.phoneVariants]
  );
  return result.rows.filter((student) => guardianMatches(student, variants.canonicalPhone));
}

export async function findGuardianLookupCandidates(guardianPhone, db = query) {
  const variants = guardianPhoneVariants(guardianPhone);
  if (!variants) return [];
  const result = await db(
    `SELECT st.id, st.full_name, st.student_code, st.student_serial, st.scan_serial,
      st.is_active, st.deleted_at, st.absence_frozen, st.guardian_phone,
      g.name AS group_name, g.grade, COALESCE(g.grade_level, g.grade) AS grade_level, g.subject
     FROM students st LEFT JOIN groups g ON g.id = st.group_id
     WHERE st.is_active = TRUE AND st.deleted_at IS NULL
       AND translate(regexp_replace(COALESCE(st.guardian_phone, ''), '[^0-9٠-٩۰-۹]', '', 'g'), '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789') = ANY($1::text[])
     ORDER BY st.full_name, st.id`,
    [variants.phoneVariants]
  );
  return result.rows.filter((student) => guardianMatches(student, variants.canonicalPhone));
}

export async function loadEligibleStudentForPurpose(studentId, purpose, db = query) {
  const normalizedPurpose = selectionPurpose(purpose);
  if (!normalizedPurpose) return null;
  const result = await db(
    `SELECT st.id, st.full_name, st.student_code, st.student_serial, st.scan_serial,
      st.is_active, st.deleted_at, st.absence_frozen, st.guardian_phone,
      st.pin_hash, g.name AS group_name, g.grade, COALESCE(g.grade_level, g.grade) AS grade_level, g.subject
     FROM students st LEFT JOIN groups g ON g.id = st.group_id
     WHERE st.id = $1 AND st.is_active = TRUE AND st.deleted_at IS NULL AND st.absence_frozen = FALSE
       AND st.pin_hash ${normalizedPurpose === "pin_setup" ? "IS NULL" : "IS NOT NULL"}
     LIMIT 1`,
    [Number(studentId)]
  );
  return result.rows[0] || null;
}

export function publicStudent(student) {
  return {
    id: student.id,
    full_name: student.full_name,
    student_code: student.student_code,
    student_serial: student.student_serial,
    scan_serial: student.scan_serial,
    group_name: student.group_name,
    grade: student.grade,
    grade_level: student.grade_level,
    subject: student.subject
  };
}

export function publicGuardianSelectionStudent(student) {
  return {
    id: student.id,
    full_name: student.full_name,
    student_code: student.student_code,
    group_name: student.group_name,
    grade: student.grade,
    grade_level: student.grade_level
  };
}

export async function issuePinToken(studentId, purpose, db = query) {
  const rawToken = createPinToken();
  await db("DELETE FROM student_pin_tokens WHERE student_id = $1 AND (consumed_at IS NOT NULL OR expires_at <= NOW())", [studentId]);
  await db("INSERT INTO student_pin_tokens (student_id, token_hash, purpose, expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL '10 minutes')", [studentId, hashPinToken(rawToken), purpose]);
  return { token: rawToken, expires_in: PIN_SETUP_TTL_SECONDS };
}

export async function consumePinTokenAndSetPin({ token, purpose, newPin, studentId = null }) {
  const pinHash = hashPassword(newPin);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const tokenResult = await client.query(
      `SELECT id, student_id FROM student_pin_tokens
       WHERE token_hash = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > NOW()
       FOR UPDATE`,
      [hashPinToken(token), purpose]
    );
    if (!tokenResult.rowCount || (studentId && Number(tokenResult.rows[0].student_id) !== Number(studentId))) {
      await client.query("ROLLBACK");
      return { ok: false, status: "invalid_or_expired_pin_token" };
    }
    const id = tokenResult.rows[0].student_id;
    const update = purpose === "pin_setup"
      ? `UPDATE students SET pin_hash = $1, pin_set_at = NOW(), auth_version = auth_version + 1, updated_at = NOW()
         WHERE id = $2 AND pin_hash IS NULL AND is_active = TRUE AND deleted_at IS NULL AND absence_frozen = FALSE
         RETURNING id, auth_version`
      : `UPDATE students SET pin_hash = $1, pin_set_at = NOW(), auth_version = auth_version + 1, updated_at = NOW()
         WHERE id = $2 AND pin_hash IS NOT NULL AND is_active = TRUE AND deleted_at IS NULL AND absence_frozen = FALSE
         RETURNING id, auth_version`;
    const updated = await client.query(update, [pinHash, id]);
    if (!updated.rowCount) {
      await client.query("ROLLBACK");
      return { ok: false, status: purpose === "pin_setup" ? "pin_already_set_or_account_unavailable" : "account_unavailable" };
    }
    await client.query("UPDATE student_pin_tokens SET consumed_at = NOW() WHERE id = $1 AND consumed_at IS NULL", [tokenResult.rows[0].id]);
    await client.query("DELETE FROM student_pin_tokens WHERE student_id = $1 AND consumed_at IS NULL AND purpose = $2", [id, purpose]);
    await client.query("COMMIT");
    return { ok: true, student_id: id, auth_version: Number(updated.rows[0].auth_version) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function loadStudentForCode(studentCode, db = query) {
  const normalizedCode = normalizeStudentCode(normalizeDigits(studentCode));
  const result = await db(
    `SELECT st.id, st.full_name, st.student_code, st.student_serial, st.scan_serial,
      st.group_id, st.is_active, st.deleted_at, st.absence_frozen, st.absence_frozen_at,
      st.guardian_phone, st.pin_hash, st.pin_set_at, st.auth_version,
      g.name AS group_name, g.grade, COALESCE(g.grade_level, g.grade) AS grade_level, g.subject
     FROM students st LEFT JOIN groups g ON g.id = st.group_id
     WHERE (st.student_code = $1 OR st.student_serial = $1 OR st.student_serial = $2)
     LIMIT 1`,
    [normalizedCode, normalizedCode.replace(/^A(\d{4})$/, "A-$1")]
  );
  return result.rows[0] || null;
}

export function accountState(student) {
  if (!student || student.deleted_at || student.is_active === false) return "invalid_student";
  if (student.absence_frozen) return "account_frozen";
  return null;
}

export function guardianMatches(student, submittedPhone) {
  const expected = normalizeEgyptianPhone(student?.guardian_phone);
  const submitted = normalizeEgyptianPhone(submittedPhone);
  return Boolean(expected && submitted && expected === submitted);
}

export async function authenticatedPayload(studentId, db = query) {
  const result = await db(
    `SELECT st.id, st.full_name, st.student_code, st.student_serial, st.scan_serial,
      st.auth_version, g.name AS group_name, g.grade, COALESCE(g.grade_level, g.grade) AS grade_level, g.subject
     FROM students st LEFT JOIN groups g ON g.id = st.group_id
     WHERE st.id = $1 AND st.is_active = TRUE AND st.deleted_at IS NULL AND st.absence_frozen = FALSE
     LIMIT 1`,
    [studentId]
  );
  if (!result.rowCount) return null;
  const student = publicStudent(result.rows[0]);
  return { student_token: createStudentToken({ ...result.rows[0], auth_version: result.rows[0].auth_version }), student, dashboard: await getDashboardData(studentId, db) };
}

export function verifyStudentPin(pin, storedHash) {
  return isValidStudentPin(pin) && Boolean(storedHash) && verifyPassword(normalizeStudentPin(pin), storedHash);
}
