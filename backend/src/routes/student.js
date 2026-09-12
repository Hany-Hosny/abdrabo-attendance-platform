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
import { authenticatedStudent } from "../services/studentAuth.js";
import { ipKeyGenerator } from "express-rate-limit";
import { requireActiveSessionAttendance } from "../middleware/requireActiveSessionAttendance.js";
import path from "node:path";
import fs from "node:fs";

export const studentRouter = express.Router();
const studentCodePattern = /^A-\d{4}$/;
const studentLoginRateLimit = createRateLimiter({ windowMs: 60_000, max: 10, key: (req) => `student-login:${ipKeyGenerator(req.ip || "unknown")}` });
const studentLookupRateLimit = createRateLimiter({ windowMs: 15 * 60_000, max: 10, key: (req) => `student-lookup:${ipKeyGenerator(req.ip || "unknown")}` });
const studentPortalAccessRateLimit = createRateLimiter({ windowMs: 15 * 60_000, max: 30, key: (req) => `student-portal-access:${ipKeyGenerator(req.ip || "unknown")}` });

function hashValue(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
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
        g.name AS group_name, g.grade, COALESCE(g.grade_level, g.grade) AS grade_level, g.subject
       FROM students s
       JOIN groups g ON g.id = s.group_id
       WHERE s.id = $1 AND s.is_active = TRUE AND s.deleted_at IS NULL
         AND g.is_active = TRUE AND g.deleted_at IS NULL
       LIMIT 1`,
      [access.rows[0].student_id]
    );
    if (!result.rowCount) return res.status(404).json({ ok: false, status: "student_not_found" });

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

studentRouter.post("/login", studentLoginRateLimit, async (req, res, next) => {
  try {
    const { student_code } = req.body || {};
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

    const result = await query(
      `
        SELECT st.id, st.full_name, st.student_code, st.student_serial, st.scan_serial,
          st.group_id, g.name AS group_name, g.grade,
          COALESCE(g.grade_level, g.grade) AS grade_level, g.subject
        FROM students st
        LEFT JOIN groups g ON g.id = st.group_id
        WHERE (st.student_code = $1 OR st.student_serial = $1 OR st.student_serial = $2)
          AND st.is_active = TRUE AND st.deleted_at IS NULL
        LIMIT 1
      `,
      [normalizedCode, String(normalizedCode).replace(/^A(\d{4})$/, "A-$1")]
    );

    if (!result.rowCount) {
      await auditLog({ action: "login_failed", details: { actor_type: "student", identifier: normalizedCode, reason: "invalid_student" }, request: req });
      return res.status(401).json({ ok: false, status: "invalid_student", message: "Invalid or inactive student code." });
    }

    const row = result.rows[0];
    const student = {
      id: row.id,
      full_name: row.full_name,
      student_code: row.student_code,
      student_serial: row.student_serial,
      scan_serial: row.scan_serial,
      group_name: row.group_name,
      grade: row.grade,
      grade_level: row.grade_level,
      subject: row.subject
    };
    const dashboard = await getDashboardData(row.id);
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
      student_token: createStudentToken(student),
      student,
      dashboard
    });
  } catch (error) {
    next(error);
  }
});

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

    const result = await query(
      `
        SELECT student_code
        FROM students
        WHERE is_active = TRUE AND deleted_at IS NULL
          AND (
            guardian_phone = $1
            OR phone = $1
            OR national_id_hash = $2
          )
        LIMIT 1
      `,
      [identifier, hashValue(identifier)]
    );

    if (!result.rowCount) {
      return res.json({ ok: false, status: "not_found" });
    }

    return res.json({ ok: true, student_code: result.rows[0].student_code });
  } catch (error) {
    next(error);
  }
});

studentRouter.get("/me/dashboard", async (req, res, next) => {
  try {
    const student = await authenticatedStudent(req);
    if (!student) return res.status(401).json({ ok: false, status: "unauthorized" });
    const dashboard = await getDashboardData(student.id);
    return res.json({ ok: true, dashboard });
  } catch (error) {
    next(error);
  }
});

studentRouter.get("/me/profile", async (req, res, next) => {
  try {
    const authenticated = await authenticatedStudent(req);
    if (!authenticated) return res.status(401).json({ ok: false, status: "unauthorized" });
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
      return res.status(401).json({ ok: false, status: "unauthorized", message: "بيانات الطالب غير صالحة. / Invalid student session." });
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
    if (!student) return res.status(401).json({ ok: false, status: "unauthorized", notes: [], unread_count: 0 });
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
    if (!student) return res.status(401).json({ ok: false, status: "unauthorized" });
    const result = await query("UPDATE student_notes SET is_read = TRUE WHERE student_id = $1 AND is_read = FALSE RETURNING id", [student.id]);
    return res.json({ ok: true, marked_count: result.rowCount, unread_count: 0 });
  } catch (error) {
    next(error);
  }
});

studentRouter.get("/homework", async (req,res,next)=>{try{const student=await authenticatedStudent(req);if(!student)return res.status(401).json({ok:false,status:"unauthorized",homework:[]});const result=await query(`SELECT h.id,h.title,h.description,h.due_date,h.attachment_url,COALESCE(hs.status,CASE WHEN h.due_date IS NOT NULL AND h.due_date<CURRENT_TIMESTAMP THEN 'late' ELSE 'new' END) AS status,hs.submitted_at FROM homeworks h LEFT JOIN homework_submissions hs ON hs.homework_id=h.id AND hs.student_id=$1 WHERE h.group_id=$2 ORDER BY h.due_date NULLS LAST,h.created_at DESC`,[student.id,student.group_id]);res.json({ok:true,homework:result.rows||[]});}catch(error){next(error);}});

studentRouter.get("/me/exams", async (req, res, next) => {
  try {
    const student = await authenticatedStudent(req);
    if (!student) return res.status(401).json({ ok: false, status: "unauthorized", exams: [] });
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
    if (!student || Number(student.id) !== Number(req.params.id)) return res.status(401).json({ ok: false, status: "unauthorized" });
    const result = await query(
      `
        SELECT ar.*, s.session_date, s.starts_at, g.name AS group_name, g.subject
        FROM attendance_records ar
        JOIN attendance_sessions s ON s.id = ar.session_id
        JOIN groups g ON g.id = s.group_id
        WHERE ar.student_id = $1
        ORDER BY ar.checkin_time DESC
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
    if (!student || Number(student.id) !== Number(req.params.id)) return res.status(401).json({ ok: false, status: "unauthorized" });
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
    // مسار تحميل مباشر للأبلكيشن
router.get("/app/download", (_req, res) => {
  const filePath = path.resolve(process.cwd(), "public/downloads/Mr_Abdrabo_Edu.apk");

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ ok: false, status: "file_not_found" });
  }

  // يرسل الملف ويبدأ التحميل فوراً مع فرض اسم الملف
  res.download(filePath, "Mr_Abdrabo_Edu.apk", (err) => {
    if (err && !res.headersSent) {
      res.status(500).json({ ok: false, status: "download_failed" });
    }
  });
});
