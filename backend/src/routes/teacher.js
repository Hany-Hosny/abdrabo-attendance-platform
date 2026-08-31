import express from "express";
import { query } from "../db/pool.js";
import { createTeacherToken, verifyPassword, verifyTeacherToken } from "../services/auth.js";
import { requireTeacher } from "../middleware/requireTeacher.js";
import { auditLog } from "../services/audit.js";

export const teacherRouter = express.Router();

function localizedError(language) {
  return language === "ar" ? "بيانات الدخول غير صحيحة." : "Invalid login credentials.";
}

teacherRouter.post("/login", async (req, res, next) => {
  try {
    const identifier = String(req.body?.identifier || req.body?.email || req.body?.username || "")
      .trim()
      .toLowerCase();
    const password = String(req.body?.password || "");
    const language = req.body?.language === "ar" ? "ar" : "en";

    if (!identifier || !password) {
      await auditLog({ action: "login_failed", details: { actor_type: "teacher", identifier, reason: "missing_credentials" }, request: req });
      return res.status(400).json({
        ok: false,
        status: "invalid_credentials",
        message: localizedError(language)
      });
    }

    const result = await query(
      `
        SELECT id, name, email, username, password_hash, role, permissions
        FROM teachers
        WHERE is_active = TRUE
          AND deleted_at IS NULL
          AND (LOWER(email) = $1 OR LOWER(username) = $1)
        LIMIT 1
      `,
      [identifier]
    );

    const teacher = result.rows[0];
    if (!teacher || !verifyPassword(password, teacher.password_hash)) {
      await auditLog({ action: "login_failed", details: { actor_type: "teacher", identifier, reason: "invalid_credentials" }, request: req });
      return res.status(401).json({
        ok: false,
        status: "invalid_credentials",
        message: localizedError(language)
      });
    }

    await auditLog({ action: "login_succeeded", actorId: teacher.id, details: { actor_type: "teacher", user_id: teacher.id, username: teacher.username, role: teacher.role }, request: req });
    return res.json({
      ok: true,
      token: createTeacherToken(teacher),
      teacher: {
        id: teacher.id,
        name: teacher.name,
        email: teacher.email,
        username: teacher.username,
        role: teacher.role,
        permissions: Array.isArray(teacher.permissions) ? teacher.permissions : []
      }
    });
  } catch (error) {
    next(error);
  }
});

teacherRouter.post("/logout", requireTeacher, async (req, res, next) => {
  try {
    await auditLog({ action: "logout", actorId: req.teacher.id, details: { actor_type: "teacher", user_id: req.teacher.id, username: req.teacher.username }, request: req });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

teacherRouter.get("/me", async (req, res) => {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const payload = verifyTeacherToken(token);

  if (!payload) {
    return res.status(401).json({ ok: false, status: "unauthorized" });
  }
  const result = await query(
    `SELECT id, name, email, username, role, permissions
     FROM teachers
     WHERE id = $1 AND is_active = TRUE AND deleted_at IS NULL`,
    [payload.sub]
  );
  const teacher = result.rows[0];
  if (!teacher) return res.status(401).json({ ok: false, status: "unauthorized" });
  return res.json({
    ok: true,
    teacher: {
      id: teacher.id,
      name: teacher.name,
      email: teacher.email,
      username: teacher.username,
      role: teacher.role,
      permissions: Array.isArray(teacher.permissions) ? teacher.permissions : []
    }
  });
});
