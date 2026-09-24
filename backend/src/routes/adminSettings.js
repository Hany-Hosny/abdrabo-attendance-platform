import express from "express";
import { requirePermission, requireRoles, requireTeacher } from "../middleware/requireTeacher.js";
import { readSystemSettings, SettingsValidationError, updateSystemSettings } from "../services/systemSettings.js";
import { createPasswordResetSecret, getPasswordRecoveryConfig, safePasswordRecoveryConfig, updatePasswordRecoveryConfig, rotatePasswordResetSecret } from "../services/passwordRecoveryConfig.js";
import { sendPasswordRecoveryEmail, verifyGmailSmtp } from "../services/email.js";
import { getGeminiConfig, safeGeminiConfig, testGeminiConfig, updateGeminiConfig } from "../services/geminiConfig.js";
import { getAiProviderStatuses, getAiProviderTestConfig, getAiRoutingStrategy, updateAiProviderCredential, updateAiProviderSettings, updateAiRoutingStrategy } from "../services/aiProviderRegistry.js";
import { testAiProviderConnection } from "../services/aiProviderAdapters.js";
import { auditLog } from "../services/audit.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { ipKeyGenerator } from "express-rate-limit";

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
const passwordRecoveryTestRateLimit = createRateLimiter({ windowMs: 15 * 60_000, max: 3, key: (req) => `password-recovery-test:${req.teacher?.id || "unknown"}:${ipKeyGenerator(req.ip || "unknown")}` });
const geminiTestRateLimit = createRateLimiter({ windowMs: 15 * 60_000, max: 3, key: (req) => `gemini-test:${req.teacher?.id || "unknown"}:${ipKeyGenerator(req.ip || "unknown")}` });
function normalizeGeminiTestFailure(value) {
  const detail = String(value || "").toLowerCase();
  if (detail.includes("429") || detail.includes("quota") || detail.includes("resource_exhausted")) return "provider_rate_limited";
  if (detail.includes("401") || detail.includes("403") || detail.includes("api key") || detail.includes("credential")) return "provider_auth_failed";
  if (detail.includes("timeout")) return "provider_timeout";
  if (detail.includes("404") || detail.includes("model")) return "provider_model_unavailable";
  return "provider_unavailable";
}
adminSettingsRouter.get("/advanced/ai/providers", ...advancedSettingsAccess, async (_req, res, next) => {
  try {
    return res.json({ ok: true, providers: await getAiProviderStatuses(), routingStrategy: await getAiRoutingStrategy() });
  } catch (error) {
    return next(error);
  }
});
adminSettingsRouter.patch("/advanced/ai/providers/:providerId", ...advancedSettingsAccess, async (req, res, next) => {
  try {
    return res.json({ ok: true, provider: await updateAiProviderSettings(req.params.providerId, req.body, { actorId: req.teacher.id, request: req }) });
  } catch (error) {
    if (["invalid_ai_provider", "invalid_ai_provider_settings", "invalid_ai_provider_priority", "invalid_ai_provider_timeout", "invalid_ai_provider_account_id"].includes(error?.message)) return res.status(400).json({ ok: false, status: error.message });
    return next(error);
  }
});
adminSettingsRouter.post("/advanced/ai/providers/:providerId/credential", ...advancedSettingsAccess, async (req, res, next) => {
  try {
    return res.json({ ok: true, provider: await updateAiProviderCredential(req.params.providerId, req.body, { actorId: req.teacher.id, request: req }) });
  } catch (error) {
    if (["invalid_ai_provider", "invalid_ai_provider_credential"].includes(error?.message)) return res.status(400).json({ ok: false, status: error.message });
    if (error?.message === "secret_storage_unavailable") return res.status(503).json({ ok: false, status: error.message });
    return next(error);
  }
});
adminSettingsRouter.patch("/advanced/ai/routing", ...advancedSettingsAccess, async (req, res, next) => {
  try {
    return res.json({ ok: true, ...(await updateAiRoutingStrategy(req.body?.strategy, { actorId: req.teacher.id, request: req })) });
  } catch (error) {
    if (error?.message === "invalid_ai_routing_strategy") return res.status(400).json({ ok: false, status: error.message });
    return next(error);
  }
});
adminSettingsRouter.post("/advanced/ai/providers/:providerId/test", ...advancedSettingsAccess, async (req, res, next) => {
  try {
    const config = await getAiProviderTestConfig(req.params.providerId);
    const result = await testAiProviderConnection(req.params.providerId, config);
    return res.status(result.ok ? 200 : result.status === "provider_not_configured" ? 400 : 502).json(result);
  } catch (error) {
    if (error?.message === "invalid_ai_provider") return res.status(400).json({ ok: false, status: error.message, message: "The requested provider is not supported." });
    return next(error);
  }
});
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

adminSettingsRouter.get("/advanced/gemini", ...advancedSettingsAccess, async (_req, res, next) => {
  try {
    return res.json({ ok: true, ...safeGeminiConfig(await getGeminiConfig()) });
  } catch (error) {
    if (error?.name === "SecretStorageError") return res.status(503).json({ ok: false, status: "secret_storage_unavailable" });
    return next(error);
  }
});

adminSettingsRouter.post("/advanced/gemini/test", ...advancedSettingsAccess, geminiTestRateLimit, async (req, res, next) => {
  try {
    const result = await testGeminiConfig(req.body);
    if (!result.ok) return res.status(502).json({ ok: false, status: normalizeGeminiTestFailure(result.message) });
    await auditLog({ action: "advanced_settings_updated", actorId: req.teacher.id, details: { integration: "gemini", action: "connection_tested", result: "success" }, request: req });
    return res.json({ ok: true, status: "tested" });
  } catch (error) {
    if (error?.message === "gemini_api_key_required") return res.status(400).json({ ok: false, status: "provider_not_configured" });
    if (["invalid_gemini_payload", "invalid_gemini_model", "invalid_gemini_api_key"].includes(error?.message)) return res.status(400).json({ ok: false, status: "invalid_gemini_settings" });
    if (error?.name === "SecretStorageError") return res.status(503).json({ ok: false, status: "secret_storage_unavailable" });
    return next(error);
  }
});

adminSettingsRouter.patch("/advanced/gemini", ...advancedSettingsAccess, async (req, res, next) => {
  try {
    return res.json({ ok: true, ...await updateGeminiConfig(req.body, { actorId: req.teacher.id, request: req }) });
  } catch (error) {
    if (error?.message === "gemini_api_key_required") return res.status(400).json({ ok: false, status: "gemini_api_key_required" });
    if (["invalid_gemini_payload", "invalid_gemini_model", "invalid_gemini_api_key"].includes(error?.message)) return res.status(400).json({ ok: false, status: "invalid_gemini_settings" });
    if (error?.message === "gemini_connection_failed") return res.status(502).json({ ok: false, status: normalizeGeminiTestFailure(error.providerMessage) });
    if (error?.message === "secret_storage_unavailable") return res.status(503).json({ ok: false, status: "secret_storage_unavailable" });
    return next(error);
  }
});
