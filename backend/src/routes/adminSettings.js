import express from "express";
import { requirePermission, requireRoles, requireTeacher } from "../middleware/requireTeacher.js";
import { readSystemSettings, SettingsValidationError, updateSystemSettings } from "../services/systemSettings.js";
import { createPasswordResetSecret, getPasswordRecoveryConfig, safePasswordRecoveryConfig, updatePasswordRecoveryConfig, rotatePasswordResetSecret } from "../services/passwordRecoveryConfig.js";
import { sendPasswordRecoveryEmail, verifyGmailSmtp } from "../services/email.js";
import { auditLog } from "../services/audit.js";
import { createRateLimiter } from "../middleware/rateLimit.js";

export const adminSettingsRouter = express.Router();
adminSettingsRouter.use(requireTeacher, requirePermission("settings.manage"));

adminSettingsRouter.get("/", async (_req, res, next) => {
  try {
    const result = await readSystemSettings();
    return res.json({ ok: true, ...result });
  } catch (error) {
    return next(error);
  }
});

adminSettingsRouter.patch("/", async (req, res, next) => {
  try {
    const input = req.body?.settings;
    const result = await updateSystemSettings(input, { actorId: req.teacher.id, request: req });
    return res.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof SettingsValidationError) {
      return res.status(400).json({ ok: false, status: "invalid_settings", errors: error.errors });
    }
    return next(error);
  }
});

const advancedSettingsAccess = [requireRoles("owner")];
const passwordRecoveryTestRateLimit = createRateLimiter({ windowMs: 15 * 60_000, max: 3, key: (req) => `password-recovery-test:${req.teacher?.id || "unknown"}:${req.ip}` });
adminSettingsRouter.get("/advanced/password-recovery", ...advancedSettingsAccess, async (_req, res, next) => {
  try {
    return res.json({ ok: true, ...safePasswordRecoveryConfig(await getPasswordRecoveryConfig()) });
  } catch (error) {
    return next(error);
  }
});

adminSettingsRouter.patch("/advanced/password-recovery", ...advancedSettingsAccess, async (req, res, next) => {
  try {
    const result = await updatePasswordRecoveryConfig(req.body, { actorId: req.teacher.id, request: req });
    return res.json({ ok: true, ...result });
  } catch (error) {
    if (["invalid_payload", "invalid_enabled", "invalid_provider", "invalid_from_email", "invalid_api_key", "empty_payload"].includes(error?.message)) {
      return res.status(400).json({ ok: false, status: "invalid_password_recovery_settings" });
    }
    if (error?.message === "secret_storage_unavailable") return res.status(503).json({ ok: false, status: "secret_storage_unavailable" });
    return next(error);
  }
});

adminSettingsRouter.post("/advanced/password-recovery/generate-secret", ...advancedSettingsAccess, async (req, res, next) => {
  try {
    return res.json({ ok: true, ...await createPasswordResetSecret({ actorId: req.teacher.id, request: req }) });
  } catch (error) {
    if (error?.message === "secret_storage_unavailable") return res.status(503).json({ ok: false, status: "secret_storage_unavailable" });
    return next(error);
  }
});

adminSettingsRouter.post("/advanced/password-recovery/rotate-secret", ...advancedSettingsAccess, async (req, res, next) => {
  try {
    return res.json({ ok: true, ...await rotatePasswordResetSecret({ actorId: req.teacher.id, request: req }) });
  } catch (error) {
    if (error?.message === "secret_storage_unavailable") return res.status(503).json({ ok: false, status: "secret_storage_unavailable" });
    return next(error);
  }
});

adminSettingsRouter.post("/advanced/password-recovery/test", ...advancedSettingsAccess, passwordRecoveryTestRateLimit, async (req, res, next) => {
  try {
    const config = await getPasswordRecoveryConfig();
    if (!config.configured) return res.status(400).json({ ok: false, status: "incomplete_configuration" });
    if (config.provider === "gmail-smtp") await verifyGmailSmtp({ smtpConfig: config.smtp });
    await sendPasswordRecoveryEmail({
      provider: config.provider,
      to: req.teacher.email,
      fromEmail: config.fromEmail,
      senderName: config.senderName,
      smtpConfig: config.smtp,
      apiKey: config.apiKey,
      subject: "Mr. Ahmed Abdrabo email configuration test",
      text: "Email service connection successful.",
      html: "<p>Email service connection successful.</p>"
    });
    await auditLog({ action: "email_provider_tested", actorId: req.teacher.id, details: { provider: config.provider, result: "success" }, request: req });
    return res.json({ ok: true, status: "tested" });
  } catch (_error) {
    return res.status(502).json({ ok: false, status: "email_provider_unavailable" });
  }
});
