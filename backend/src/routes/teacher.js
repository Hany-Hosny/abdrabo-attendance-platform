import express from "express";
import { query } from "../db/pool.js";
import { createTeacherToken, verifyPassword, verifyTeacherToken } from "../services/auth.js";

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
      return res.status(400).json({
        ok: false,
        status: "invalid_credentials",
        message: localizedError(language)
      });
    }

    const result = await query(
      `
        SELECT id, name, email, username, password_hash, role
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
      return res.status(401).json({
        ok: false,
        status: "invalid_credentials",
        message: localizedError(language)
      });
    }

    return res.json({
      ok: true,
      token: createTeacherToken(teacher),
      teacher: {
        id: teacher.id,
        name: teacher.name,
        email: teacher.email,
        username: teacher.username,
        role: teacher.role
      }
    });
  } catch (error) {
    next(error);
  }
});

teacherRouter.get("/me", async (req, res) => {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const payload = verifyTeacherToken(token);

  if (!payload) {
    return res.status(401).json({ ok: false, status: "unauthorized" });
  }

  return res.json({
    ok: true,
      teacher: {
        id: payload.sub,
        name: payload.name,
        email: payload.email,
        username: payload.username,
        role: payload.role
      }
  });
});
