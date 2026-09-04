import express from "express";
import crypto from "node:crypto";
import { query } from "../db/pool.js";
import { createTeacherToken, verifyPassword } from "../services/auth.js";
import { requireTeacher } from "../middleware/requireTeacher.js";
import { auditLog } from "../services/audit.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { ipKeyGenerator } from "express-rate-limit";
import { requestPasswordReset, resetPassword, verifyPasswordResetCode, GENERIC_RESET_MESSAGE, INVALID_CODE_MESSAGE, PasswordRecoveryUnavailableError } from "../services/passwordRecovery.js";

export const teacherRouter = express.Router();
export const loginRateLimit = createRateLimiter({ windowMs: 60_000, max: 10, key: (req) => `teacher-login:${ipKeyGenerator(req.ip || "unknown")}` });
export const resetRequestIpRateLimit = createRateLimiter({ windowMs: 15 * 60_000, max: 8, key: (req) => `password-reset-ip:${ipKeyGenerator(req.ip || "unknown")}` });
const resetRequestIdentifierRateLimit = createRateLimiter({
  windowMs: 15 * 60_000,
  max: 5,
  key: (req) => {
    const identifier = String(req.body?.identifier || "").trim().toLowerCase();
    return `password-reset-identifier:${crypto.createHash("sha256").update(identifier).digest("hex")}`;
  }
});
const resetVerifyIpRateLimit = createRateLimiter({ windowMs: 15 * 60_000, max: 10, key: (req) => `password-reset-verify-ip:${ipKeyGenerator(req.ip || "unknown")}` });
const resetPasswordIpRateLimit = createRateLimiter({ windowMs: 15 * 60_000, max: 10, key: (req) => `password-reset-complete-ip:${ipKeyGenerator(req.ip || "unknown")}` });

function localizedError(language) {
  return language === "ar" ? "بيانات الدخول غير صحيحة." : "Invalid login credentials.";
}

teacherRouter.post("/login", loginRateLimit, async (req, res, next) => {
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
        SELECT id, name, email, username, password_hash, role, permissions, auth_version
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

teacherRouter.get("/me", requireTeacher, async (req, res) => {
  const teacher = req.teacher;
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

teacherRouter.post("/forgot-password", resetRequestIpRateLimit, resetRequestIdentifierRateLimit, async (req, res, next) => {
  const language = req.body?.language === "ar" ? "ar" : "en";
  try {
    const result = await requestPasswordReset(req.body?.identifier, { language, request: req });
    return res.status(202).json({ ok: true, status: "accepted", flowId: result.flowId, message: GENERIC_RESET_MESSAGE[language] });
  } catch (error) {
    if (error instanceof PasswordRecoveryUnavailableError) {
      return res.status(503).json({
        ok: false,
        status: "password_recovery_unavailable",
        message: language === "ar"
          ? "استعادة كلمة المرور غير متاحة حالياً. يرجى التواصل مع مدير النظام."
          : "Password recovery is currently unavailable. Please contact the system administrator."
      });
    }
    return next(error);
  }
});

teacherRouter.post("/verify-reset-code", resetVerifyIpRateLimit, async (req, res, next) => {
  const language = req.body?.language === "ar" ? "ar" : "en";
  try {
    const result = await verifyPasswordResetCode(req.body?.flowId || req.body?.requestId, req.body?.code, { request: req });
    if (!result.ok) return res.status(400).json({ ok: false, status: result.status, message: INVALID_CODE_MESSAGE[language] });
    return res.json({ ok: true, status: "verified", resetToken: result.resetToken, message: language === "ar" ? "تم التحقق من الرمز." : "Code verified." });
  } catch (error) {
    return next(error);
  }
});

teacherRouter.post("/reset-password", resetPasswordIpRateLimit, async (req, res, next) => {
  const language = req.body?.language === "ar" ? "ar" : "en";
  try {
    const result = await resetPassword(req.body?.resetToken, req.body?.password, req.body?.confirmation ?? req.body?.confirmPassword, { request: req });
    if (!result.ok) {
      const messages = {
        invalid_password: language === "ar" ? "يجب أن تتكون كلمة المرور من 8 أحرف على الأقل." : "Password must be at least 8 characters.",
        password_mismatch: language === "ar" ? "كلمتا المرور غير متطابقتين." : "Passwords do not match.",
        invalid_reset_authorization: language === "ar" ? "انتهت جلسة الاستعادة. اطلب رمزاً جديداً." : "The recovery session expired. Request a new code."
      };
      return res.status(400).json({ ok: false, status: result.status, message: messages[result.status] || messages.invalid_reset_authorization });
    }
    return res.json({ ok: true, status: "reset", message: language === "ar" ? "تم تغيير كلمة المرور بنجاح." : "Password changed successfully." });
  } catch (error) {
    return next(error);
  }
});
