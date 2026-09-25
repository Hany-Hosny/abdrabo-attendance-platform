import express from "express";
import crypto from "node:crypto";
import { query } from "../db/pool.js";
import { getStudentFeePortalData } from "../services/fees.js";
import { getDashboardData } from "../services/dashboard.js";
import { normalizeDigits, normalizeStudentCode } from "../utils/normalizeDigits.js";
import { normalizeScanValue } from "../utils/scan.js";
import { auditLog } from "../services/audit.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { createStudentToken, hashStudentPortalAccessToken } from "../services/auth.js";
import { authenticatedStudent, studentAuthFailure } from "../services/studentAuth.js";
import {
  accountState,
  authenticatedPayload,
  guardianMatches,
  isValidStudentPin,
  issuePinToken,
  createGuardianSelectionContext,
  consumeGuardianSelectionContext,
  findGuardianCandidates,
  findGuardianLookupCandidates,
  loadEligibleStudentForPurpose,
  publicGuardianSelectionStudent,
  loadStudentForCode,
  normalizeStudentPin,
  consumePinTokenAndSetPin,
  verifyStudentPin
} from "../services/studentPinAuth.js";
import { ipKeyGenerator } from "express-rate-limit";
import { normalizeEgyptianPhone } from "../utils/normalizePhone.js";
import { requireActiveSessionAttendance } from "../middleware/requireActiveSessionAttendance.js";
import path from "node:path";
import fs from "node:fs";

export const studentRouter = express.Router();
const appDownloadPath = path.resolve(process.cwd(), "public/downloads/Mr.Abdrabo Edu");
const appDownloadFilename = "Mr.Abdrabo Edu.apk";
const studentCodePattern = /^A-\d{4}$/;
const studentLoginRateLimit = createRateLimiter({ windowMs: 60_000, max: 10, key: (req) => `student-login:${ipKeyGenerator(req.ip || "unknown")}` });
const studentLookupRateLimit = createRateLimiter({ windowMs: 15 * 60_000, max: 10, key: (req) => `student-lookup:${ipKeyGenerator(req.ip || "unknown")}` });
const studentPortalAccessRateLimit = createRateLimiter({ windowMs: 15 * 60_000, max: 30, key: (req) => `student-portal-access:${ipKeyGenerator(req.ip || "unknown")}` });
const studentGuardianCodeRateLimit = createRateLimiter({ windowMs: 5 * 60_000, max: 5, skipSuccessfulRequests: true, limitStatus: "guardian_verification_locked", key: (req) => `student-guardian:${normalizeStudentCode(normalizeScanValue(req.body?.student_code || ""))}` });
const studentGuardianIpRateLimit = createRateLimiter({ windowMs: 5 * 60_000, max: 100, key: (req) => `student-guardian-ip:${ipKeyGenerator(req.ip || "unknown")}` });
const studentPinCodeRateLimit = createRateLimiter({ windowMs: 5 * 60_000, max: 5, skipSuccessfulRequests: true, limitStatus: "pin_login_locked", key: (req) => `student-pin:${normalizeStudentCode(normalizeScanValue(req.body?.student_code || ""))}` });
const studentPinIpRateLimit = createRateLimiter({ windowMs: 5 * 60_000, max: 100, key: (req) => `student-pin-ip:${ipKeyGenerator(req.ip || "unknown")}` });

function hashValue(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function downloadApp(_req, res) {
  if (!fs.existsSync(appDownloadPath) || !fs.statSync(appDownloadPath).isFile()) {
    return res.status(404).json({ ok: false, status: "app_file_not_found" });
  }

  res.setHeader("Content-Type", "application/vnd.android.package-archive");
  return res.download(appDownloadPath, appDownloadFilename, (error) => {
    if (error && !res.headersSent) {
      res.status(500).json({ ok: false, status: "app_download_failed" });
    }
  });
}

studentRouter.post("/portal-access", studentPortalAccessRateLimit, async (req, res, next) => {
  try {
    const token = String(req.body?.access_token || "").trim();
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return res.status(401).json({ ok: false, status: "invalid_portal_access" });

    const access = await query(
      `UPDATE student_portal_access_tokens
       SET used_at = NOW()
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
       RETURNING student_id`,
      [hashStudentPortalAccessToken(token)]
    );
    if (!access.rowCount) return res.status(401).json({ ok: false, status: "invalid_or_expired_portal_access" });

    const result = await query(
      `SELECT s.id, s.full_name, s.student_code, s.student_serial, s.scan_serial,
        s.is_active, s.absence_frozen, s.absence_frozen_at, s.auth_version,
        g.name AS group_name, g.grade, COALESCE(g.grade_level, g.grade) AS grade_level, g.subject
       FROM students s
       JOIN groups g ON g.id = s.group_id
       WHERE s.id = $1 AND s.deleted_at IS NULL
         AND g.is_active = TRUE AND g.deleted_at IS NULL
       LIMIT 1`,
      [access.rows[0].student_id]
    );
    if (!result.rowCount || !result.rows[0].is_active) return res.status(404).json({ ok: false, status: "student_not_found" });
    if (result.rows[0].absence_frozen) return res.status(403).json({ ok: false, status: "account_frozen", frozen_at: result.rows[0].absence_frozen_at || null });

    const student = result.rows[0];
    return res.json({
      ok: true,
      status: "portal_access_granted",
      message: "Student portal access granted.",
      student_token: createStudentToken(student),
      student,
      dashboard: await getDashboardData(student.id)
    });
  } catch (error) {
    next(error);
  }
});

studentRouter.post("/login", studentLoginRateLimit, studentPinIpRateLimit, studentPinCodeRateLimit, async (req, res, next) => {
  try {
    const { student_code, pin } = req.body || {};
    const normalizedCode = normalizeStudentCode(normalizeScanValue(student_code || ""));

    if (!normalizedCode) {
      await auditLog({ action: "login_failed", details: { actor_type: "student", identifier: "", reason: "student_code_required" }, request: req });
      return res.status(400).json({ ok: false, status: "student_code_required", message: "Student code is required." });
    }

    if (!studentCodePattern.test(normalizedCode)) {
      await auditLog({ action: "login_failed", details: { actor_type: "student", identifier: normalizedCode, reason: "invalid_student_code" }, request: req });
      return res.status(400).json({
        ok: false,
        status: "invalid_student_code",
        message: "Student code must look like A1234."
      });
    }

    const row = await loadStudentForCode(normalizedCode);
    if (!row || accountState(row) === "invalid_student") {
      await auditLog({ action: "login_failed", details: { actor_type: "student", identifier: normalizedCode, reason: "invalid_student" }, request: req });
      return res.status(401).json({ ok: false, status: "invalid_student", message: "Invalid or inactive student code." });
    }

    if (accountState(row) === "account_frozen") return res.status(403).json({ ok: false, status: "account_frozen", frozen_at: row.absence_frozen_at || null });
    if (!row.pin_hash) return res.json({ ok: true, status: "pin_setup_required", requires_pin_setup: true });
    if (pin === undefined || pin === null || String(pin) === "") return res.json({ ok: true, status: "pin_required", requires_pin: true });
    if (!isValidStudentPin(pin) || !verifyStudentPin(pin, row.pin_hash)) {
      await auditLog({ action: "login_failed", details: { actor_type: "student", identifier: normalizedCode, reason: "invalid_student_pin" }, request: req });
      return res.status(401).json({ ok: false, status: "invalid_student_credentials", message: "Invalid student code or PIN." });
    }
    const payload = await authenticatedPayload(row.id);
    await auditLog({
      action: "login_succeeded",
      studentId: row.id,
      details: { actor_type: "student", student_id: row.id, student_name: row.full_name, student_code: row.student_code, login_status: "authenticated" },
      request: req
    });

    return res.json({
      ok: true,
      status: "authenticated",
      message: "Student portal access granted.",
      ...payload
    });
  } catch (error) {
    next(error);
  }
});

function guardianFailure(res) {
  return res.status(401).json({ ok: false, status: "guardian_verification_failed", message: "تعذر التحقق من البيانات المدخلة. / We could not verify the entered information." });
}

async function verifyGuardian(req, res, next, purpose) {
  try {
    const student = await loadStudentForCode(req.body?.student_code);
    const state = accountState(student);
    if (state === "account_frozen") return res.status(403).json({ ok: false, status: state, frozen_at: student.absence_frozen_at || null });
    if (state) return guardianFailure(res);
    const expectedPinState = purpose === "pin_setup" ? !student.pin_hash : Boolean(student.pin_hash);
    if (!expectedPinState) return guardianFailure(res);
    if (!normalizeEgyptianPhone(student.guardian_phone)) return res.status(409).json({ ok: false, status: "guardian_verification_unavailable", message: "تعذر إكمال التحقق تلقائيًا. برجاء التواصل مع الإدارة لمراجعة البيانات المسجلة. / Automatic verification could not be completed. Please contact administration." });
    if (!guardianMatches(student, req.body?.guardian_phone)) return guardianFailure(res);

    const candidates = await findGuardianCandidates(req.body?.guardian_phone, purpose);
    if (!candidates.length) return guardianFailure(res);
    if (candidates.length > 1) {
      const selection = createGuardianSelectionContext({ purpose, studentIds: candidates.map((candidate) => candidate.id) });
      return res.json({
        ok: true,
        status: "student_selection_required",
        selection_token: selection.token,
        expires_in: selection.expires_in,
        students: candidates.map(publicGuardianSelectionStudent)
      });
    }

    const issued = await issuePinToken(candidates[0].id, purpose);
    return res.json({ ok: true, status: "guardian_verified", setup_token: purpose === "pin_setup" ? issued.token : undefined, recovery_token: purpose === "pin_recovery" ? issued.token : undefined, expires_in: issued.expires_in });
  } catch (error) { return next(error); }
}

studentRouter.post("/pin/verify-guardian", studentGuardianCodeRateLimit, studentGuardianIpRateLimit, (req, res, next) => verifyGuardian(req, res, next, "pin_setup"));
studentRouter.post("/pin/recover", studentGuardianCodeRateLimit, studentGuardianIpRateLimit, (req, res, next) => verifyGuardian(req, res, next, "pin_recovery"));

studentRouter.post("/pin/select-student", studentGuardianIpRateLimit, async (req, res, next) => {
  try {
    const purpose = req.body?.purpose === "pin_recovery" ? "pin_recovery" : req.body?.purpose === "pin_setup" ? "pin_setup" : null;
    const studentId = Number(req.body?.student_id);
    const accepted = consumeGuardianSelectionContext({ token: req.body?.selection_token, purpose, studentId });
    if (!accepted) return guardianFailure(res);

    const student = await loadEligibleStudentForPurpose(studentId, purpose);
    if (!student) return guardianFailure(res);
    const issued = await issuePinToken(student.id, purpose);
    return res.json({ ok: true, status: "guardian_verified", setup_token: purpose === "pin_setup" ? issued.token : undefined, recovery_token: purpose === "pin_recovery" ? issued.token : undefined, expires_in: issued.expires_in });
  } catch (error) { next(error); }
});

async function completePin(req, res, next, purpose) {
  try {
    const newPin = normalizeStudentPin(req.body?.new_pin);
    const confirmPin = normalizeStudentPin(req.body?.confirm_pin);
    if (!/^\d{4}$/.test(newPin) || newPin !== confirmPin) return res.status(400).json({ ok: false, status: "invalid_pin" });
    const token = String(req.body?.[purpose === "pin_setup" ? "setup_token" : "recovery_token"] || "").trim();
    if (!/^[A-Za-z0-9_-]{32,64}$/.test(token)) return res.status(401).json({ ok: false, status: "invalid_or_expired_pin_token" });
    const result = await consumePinTokenAndSetPin({ token, purpose, newPin });
    if (!result.ok) return res.status(401).json({ ok: false, status: result.status });
    const payload = await authenticatedPayload(result.student_id);
    if (!payload) return res.status(403).json({ ok: false, status: "account_unavailable" });
    await auditLog({ action: purpose === "pin_setup" ? "student_pin_setup" : "student_pin_recovered", studentId: result.student_id, details: { student_id: result.student_id }, request: req });
    return res.json({ ok: true, status: "authenticated", message: "Student portal access granted.", ...payload });
  } catch (error) { return next(error); }
}

studentRouter.post("/pin/setup", (req, res, next) => completePin(req, res, next, "pin_setup"));
studentRouter.post("/pin/recover/complete", (req, res, next) => completePin(req, res, next, "pin_recovery"));

studentRouter.post("/logout", async (req, res, next) => {
  try {
    const student = await authenticatedStudent(req);
    if (student) await auditLog({ action: "logout", studentId: student.id, details: { actor_type: "student", student_id: student.id, logout_status: "requested" }, request: req });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

studentRouter.post("/find-code", studentLookupRateLimit, async (req, res, next) => {
  try {
    const identifier = normalizeDigits(req.body?.identifier || "").trim();

    if (!/^\d+$/.test(identifier) || (identifier.length !== 11 && identifier.length !== 14)) {
      return res.status(400).json({
        ok: false,
        status: "invalid_identifier",
        message: identifier.length === 14 ? "يجب إدخال ١٤ رقمًا للرقم القومي. / National ID must contain exactly 14 digits." : "يجب إدخال ١١ رقمًا لرقم الهاتف. / Phone number must contain exactly 11 digits."
      });
    }

    const students = identifier.length === 11
      ? await findGuardianLookupCandidates(identifier)
      : (await query(
        `SELECT student_code
         FROM students
         WHERE is_active = TRUE AND deleted_at IS NULL AND national_id_hash = $1
         ORDER BY id`,
        [hashValue(identifier)]
      )).rows;

    if (!students.length) {
      return res.json({ ok: false, status: "not_found" });
    }

    if (identifier.length === 11) {
      return res.json({
        ok: true,
        status: students.length > 1 ? "multiple_matches" : "single_match",
        students: students.map(publicGuardianSelectionStudent)
      });
    }

    return res.json({ ok: true, student_code: students[0].student_code });
  } catch (error) {
    next(error);
  }
});

studentRouter.get("/me/dashboard", async (req, res, next) => {
  try {
    const student = await authenticatedStudent(req);
    if (!student) return studentAuthFailure(req, res);
    const dashboard = await getDashboardData(student.id);
    return res.json({ ok: true, dashboard });
  } catch (error) {
    next(error);
  }
});

studentRouter.get("/me/profile", async (req, res, next) => {
  try {
    const authenticated = await authenticatedStudent(req);
    if (!authenticated) return studentAuthFailure(req, res);
    const result = await query(
      `SELECT s.id, s.full_name, s.student_code, s.student_serial, s.scan_serial,
        g.name AS group_name, g.grade, COALESCE(g.grade_level, g.grade) AS grade_level, g.subject
       FROM students s JOIN groups g ON g.id = s.group_id
       WHERE s.id = $1 AND s.is_active = TRUE AND s.deleted_at IS NULL
       LIMIT 1`,
      [authenticated.id]
    );
    if (!result.rowCount) return res.status(404).json({ ok: false, status: "not_found" });
    return res.json({ ok: true, student: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

studentRouter.get("/me/fees", async (req, res, next) => {
  res.set({
    "Cache-Control": "private, no-store, max-age=0",
    Pragma: "no-cache",
    Expires: "0"
  });
  try {
    const student = await authenticatedStudent(req);
    if (!student) {
      return studentAuthFailure(req, res, { message: "بيانات الطالب غير صالحة. / Invalid student session." });
    }
    const portalData = await getStudentFeePortalData(student.id);
    return res.json({ ok: true, ...portalData });
  } catch (error) {
    next(error);
  }
});

studentRouter.get("/me/notes", async (req, res, next) => {
  try {
    const student = await authenticatedStudent(req);
    if (!student) return studentAuthFailure(req, res, { notes: [], unread_count: 0 });
    const result = await query(
      `SELECT n.id, n.student_id, n.body AS text, n.body, n.created_at, n.is_read,
        n.created_at::date AS created_date, n.created_at::time AS created_time,
        COALESCE(t.name, t.username, t.email, 'Staff') AS creator_name
       FROM student_notes n LEFT JOIN teachers t ON t.id = n.author_id
       WHERE n.student_id = $1
       ORDER BY n.created_at DESC`,
      [student.id]
    );
    return res.json({ ok: true, notes: result.rows, unread_count: result.rows.filter((note) => !note.is_read).length });
  } catch (error) {
    next(error);
  }
});

studentRouter.put("/me/notes/read", async (req, res, next) => {
  try {
    const student = await authenticatedStudent(req);
    if (!student) return studentAuthFailure(req, res);
    const result = await query("UPDATE student_notes SET is_read = TRUE WHERE student_id = $1 AND is_read = FALSE RETURNING id", [student.id]);
    return res.json({ ok: true, marked_count: result.rowCount, unread_count: 0 });
  } catch (error) {
    next(error);
  }
});

studentRouter.get("/homework", async (req,res,next)=>{try{const student=await authenticatedStudent(req);if(!student)return studentAuthFailure(req,res,{homework:[]});const result=await query(`SELECT h.id,h.title,h.description,h.due_date,h.attachment_url,COALESCE(hs.status,CASE WHEN h.due_date IS NOT NULL AND h.due_date<CURRENT_TIMESTAMP THEN 'late' ELSE 'new' END) AS status,hs.submitted_at FROM homeworks h LEFT JOIN homework_submissions hs ON hs.homework_id=h.id AND hs.student_id=$1 WHERE h.group_id=$2 ORDER BY h.due_date NULLS LAST,h.created_at DESC`,[student.id,student.group_id]);res.json({ok:true,homework:result.rows||[]});}catch(error){next(error);}});

studentRouter.get("/me/exams", async (req, res, next) => {
  try {
    const student = await authenticatedStudent(req);
    if (!student) return studentAuthFailure(req, res, { exams: [] });
    const result = await query(
      `SELECT e.id, e.title, e.max_score, e.exam_date, er.score, er.note, er.note AS assessment, er.whatsapp_notified
       FROM exam_results er JOIN exams e ON e.id = er.exam_id
       WHERE er.student_id = $1 ORDER BY e.exam_date DESC, e.id DESC`,
      [student.id]
    );
    res.json({ ok: true, exams: result.rows });
  } catch (error) {
    next(error);
  }
});

// Live exam access is deliberately separate from historical exam results.
studentRouter.get("/active-exam", requireActiveSessionAttendance, async (req, res, next) => {
  try {
    const session = req.activeSessionAttendance.session;
    const result = await query(
      `
        SELECT id, title, max_score, exam_date
        FROM exams
        WHERE group_id = $1 AND exam_date = $2::date
        ORDER BY id DESC
        LIMIT 1
      `,
      [session.group_id, session.session_date]
    );
    return res.json({ ok: true, active_exam: result.rows[0] || null });
  } catch (error) {
    return next(error);
  }
});

studentRouter.get("/:id/attendance", async (req, res, next) => {
  try {
    const student = await authenticatedStudent(req);
    if (!student || Number(student.id) !== Number(req.params.id)) return studentAuthFailure(req, res);
    const result = await query(
      `
        SELECT ar.*, s.id AS session_id, s.status AS session_status, s.cancelled_at,
          CASE WHEN s.status = 'cancelled' THEN 'cancelled' ELSE ar.status END AS status,
          s.session_date, s.starts_at, g.name AS group_name, g.subject
        FROM attendance_sessions s
        JOIN groups g ON g.id = s.group_id
        LEFT JOIN attendance_records ar ON ar.session_id = s.id AND ar.student_id = $1 AND s.status <> 'cancelled'
        WHERE s.group_id = (SELECT group_id FROM students WHERE id = $1)
        ORDER BY s.session_date DESC, s.starts_at DESC
      `,
      [req.params.id]
    );
    res.json({ ok: true, attendance: result.rows });
  } catch (error) {
    next(error);
  }
});

studentRouter.get("/:id/exams", async (req, res, next) => {
  try {
    const student = await authenticatedStudent(req);
    if (!student || Number(student.id) !== Number(req.params.id)) return studentAuthFailure(req, res);
    const result = await query(
      `
        SELECT e.id, e.title, e.max_score, e.exam_date, er.score, er.note, er.note AS assessment, er.whatsapp_notified
        FROM exam_results er
        JOIN exams e ON e.id = er.exam_id
        WHERE er.student_id = $1
        ORDER BY e.exam_date DESC
      `,
      [req.params.id]
    );
    res.json({ ok: true, exams: result.rows });
  } catch (error) {
    next(error);
  }
});
