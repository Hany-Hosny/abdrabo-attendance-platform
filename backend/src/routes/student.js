import express from "express";
import crypto from "node:crypto";
import { query } from "../db/pool.js";
import { loginAndRecordAttendance } from "../services/attendance.js";
import { getFeeSummary } from "../services/fees.js";
import { getDashboardData } from "../services/dashboard.js";
import { normalizeDigits, normalizeStudentCode } from "../utils/normalizeDigits.js";
import { normalizeScanValue } from "../utils/scan.js";
import { auditLog } from "../services/audit.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { createStudentToken } from "../services/auth.js";
import { authenticatedStudent } from "../services/studentAuth.js";

export const studentRouter = express.Router();
const studentCodePattern = /^A-\d{4}$/;
const studentLoginRateLimit = createRateLimiter({ windowMs: 60_000, max: 12, key: (req) => `student-login:${req.ip}` });
const studentLookupRateLimit = createRateLimiter({ windowMs: 60_000, max: 12, key: (req) => `student-lookup:${req.ip}` });

function hashValue(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

studentRouter.post("/login", studentLoginRateLimit, async (req, res, next) => {
  try {
    const { student_code, device_id, latitude, longitude } = req.body || {};
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

    if (!device_id || typeof device_id !== "string") {
      await auditLog({ action: "login_failed", details: { actor_type: "student", identifier: normalizedCode, reason: "device_id_required" }, request: req });
      return res.status(400).json({ ok: false, status: "device_id_required", message: "Device ID is required." });
    }

    const result = await loginAndRecordAttendance({
      student_code: normalizedCode,
      device_id: device_id.trim(),
      latitude: latitude === null || latitude === undefined ? null : Number(latitude),
      longitude: longitude === null || longitude === undefined ? null : Number(longitude),
      ip: req.ip
    });

    if (!result.ok && result.status === "invalid_student") {
      await auditLog({ action: "login_failed", details: { actor_type: "student", identifier: normalizedCode, reason: result.status }, request: req });
      return res.status(401).json(result);
    }

    if (result.student?.id) {
      result.student_token = createStudentToken(result.student);
      await auditLog({
        action: "login_succeeded",
        studentId: result.student.id,
        details: { actor_type: "student", student_id: result.student.id, student_name: result.student.full_name, student_code: result.student.student_code, login_status: result.status },
        request: req
      });
      if (["attendance_recorded", "pending_review"].includes(result.status)) {
        await auditLog({
          action: "attendance_recorded",
          studentId: result.student.id,
          sessionId: result.today_session?.id || result.attendance_record?.session_id || null,
          details: { method: "student_login_gps", status_after: result.attendance_record?.status || result.status, student_name: result.student.full_name, student_code: result.student.student_code },
          request: req
        });
      }
    }

    return res.json(result);
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

studentRouter.get("/me/fees", async (req, res, next) => {
  try {
    const student = await authenticatedStudent(req);
    if (!student) {
      return res.status(401).json({ ok: false, status: "unauthorized", message: "بيانات الطالب غير صالحة. / Invalid student session." });
    }
    const summary = await getFeeSummary(student.id);
    const payments = await query(
      `SELECT p.id, p.amount, p.payment_date, p.paid_at, p.payment_method, p.notes, p.payment_months,
        COALESCE(t.name, t.username, t.email, 'Staff') AS paid_by
       FROM payments p LEFT JOIN teachers t ON t.id = COALESCE(p.paid_by, p.recorded_by)
       WHERE p.student_id=$1 ORDER BY COALESCE(p.paid_at, p.payment_date) DESC`,
      [student.id]
    );
    const paymentStatus = summary?.payment_status || "unpaid";
    return res.json({ ok: true, summary, payments: payments.rows, payment_status: paymentStatus });
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
      `SELECT e.id, e.title, e.max_score, e.exam_date, er.score, er.note, er.note AS assessment
       FROM exam_results er JOIN exams e ON e.id = er.exam_id
       WHERE er.student_id = $1 ORDER BY e.exam_date DESC, e.id DESC`,
      [student.id]
    );
    res.json({ ok: true, exams: result.rows });
  } catch (error) {
    next(error);
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
        SELECT e.id, e.title, e.max_score, e.exam_date, er.score, er.note, er.note AS assessment
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
