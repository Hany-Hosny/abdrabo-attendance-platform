import crypto from "node:crypto";
import { pool, query } from "../db/pool.js";
import { auditLog } from "./audit.js";
import { readPasswordRecoverySettings } from "./systemSettings.js";
import { decryptSecret, encryptSecret, hasEncryptionKey, SecretStorageError } from "./secretStorage.js";
import { EMAIL_PROVIDERS, emailProviderStatus, readGmailSmtpConfig } from "./email.js";

const API_KEY_SECRET = "resend_api_key";
const RESET_SECRET = "password_reset_secret";

function configuredEnvironmentSecret(name) {
  const value = String(process.env[name] || "");
  return value.length >= 32 ? value : "";
}

async function readStoredSecrets(db = query) {
  const execute = typeof db === "function" ? db : db.query.bind(db);
  const result = await execute(
    "SELECT key, encrypted_value, iv, auth_tag FROM system_secrets WHERE key = ANY($1::text[])",
    [[API_KEY_SECRET, RESET_SECRET]]
  );
  const secrets = {};
  for (const row of result.rows) {
    try {
      secrets[row.key] = decryptSecret(row);
    } catch (_error) {
      secrets[row.key] = "";
    }
  }
  return secrets;
}

export async function getPasswordRecoveryConfig(db = query) {
  const { settings, updatedAt } = await readPasswordRecoverySettings(db);
  const stored = await readStoredSecrets(db);
  const apiKey = stored[API_KEY_SECRET] || String(process.env.RESEND_API_KEY || "");
  const resetSecret = stored[RESET_SECRET] || configuredEnvironmentSecret("PASSWORD_RESET_SECRET");
  const configuredProvider = settings.password_recovery_provider || EMAIL_PROVIDERS.GMAIL_SMTP;
  const provider = updatedAt.password_recovery_provider
    ? configuredProvider
    : String(process.env.EMAIL_PROVIDER || "").trim().toLowerCase() || configuredProvider;
  const smtp = readGmailSmtpConfig();
  const resendFromEmail = settings.password_recovery_from_email || String(process.env.PASSWORD_RESET_FROM_EMAIL || "").trim().toLowerCase();
  const providerStatus = emailProviderStatus(provider, { apiKey, fromEmail: resendFromEmail, smtpConfig: smtp });
  const fromEmail = providerStatus.senderEmail;
  const configured = Boolean(resetSecret) && providerStatus.configured;
  return {
    enabled: settings.password_recovery_enabled === true && configured,
    requestedEnabled: settings.password_recovery_enabled === true,
    provider,
    fromEmail,
    senderName: providerStatus.senderName,
    smtp,
    apiKey,
    resetSecret,
    apiKeyConfigured: provider === EMAIL_PROVIDERS.RESEND && Boolean(stored[API_KEY_SECRET] || process.env.RESEND_API_KEY),
    resetSecretConfigured: Boolean(stored[RESET_SECRET] || configuredEnvironmentSecret("PASSWORD_RESET_SECRET")),
    configured,
    encryptionConfigured: hasEncryptionKey(),
    providerConfigured: providerStatus.configured,
    smtpConfigured: Boolean(smtp.configured)
  };
}

export function safePasswordRecoveryConfig(config) {
  return {
    enabled: config.enabled,
    requestedEnabled: config.requestedEnabled,
    provider: config.provider,
    fromEmail: config.fromEmail,
    senderName: config.senderName,
    senderEmail: config.fromEmail,
    providerConfigured: config.providerConfigured,
    smtpConfigured: config.smtpConfigured,
    apiKeyConfigured: config.apiKeyConfigured,
    resetSecretConfigured: config.resetSecretConfigured,
    encryptionConfigured: config.encryptionConfigured,
    configured: config.configured
  };
}

function validateAdvancedPatch(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_payload");
  const values = {};
  if (Object.prototype.hasOwnProperty.call(input, "enabled")) {
    if (typeof input.enabled !== "boolean") throw new Error("invalid_enabled");
    values.enabled = input.enabled;
  }
  if (Object.prototype.hasOwnProperty.call(input, "provider")) {
    if (![EMAIL_PROVIDERS.GMAIL_SMTP, EMAIL_PROVIDERS.RESEND].includes(input.provider)) throw new Error("invalid_provider");
    values.provider = input.provider;
  }
  if (Object.prototype.hasOwnProperty.call(input, "fromEmail")) {
    const fromEmail = String(input.fromEmail || "").trim().toLowerCase();
    if (fromEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fromEmail)) throw new Error("invalid_from_email");
    values.fromEmail = fromEmail;
  }
  if (Object.prototype.hasOwnProperty.call(input, "apiKey")) {
    const apiKey = String(input.apiKey || "").trim();
    if (!apiKey || apiKey.length > 500) throw new Error("invalid_api_key");
    values.apiKey = apiKey;
  }
  if (!Object.keys(values).length) throw new Error("empty_payload");
  return values;
}

async function upsertSecret(client, key, value, actorId) {
  const encrypted = encryptSecret(value);
  await client.query(
    `INSERT INTO system_secrets (key, encrypted_value, iv, auth_tag, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (key) DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value,
       iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [key, encrypted.encryptedValue, encrypted.iv, encrypted.authTag, actorId]
  );
}

export async function updatePasswordRecoveryConfig(input, { actorId, request = null, db = pool, audit = auditLog } = {}) {
  const values = validateAdvancedPatch(input);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const before = await getPasswordRecoveryConfig(client);
    const settingValues = {};
    if (Object.prototype.hasOwnProperty.call(values, "enabled")) settingValues.password_recovery_enabled = values.enabled;
    if (Object.prototype.hasOwnProperty.call(values, "provider")) settingValues.password_recovery_provider = values.provider;
    if (Object.prototype.hasOwnProperty.call(values, "fromEmail")) settingValues.password_recovery_from_email = values.fromEmail;
    for (const [key, value] of Object.entries(settingValues)) {
      await client.query(
        `INSERT INTO system_settings (key, value_json, updated_by, updated_at)
         VALUES ($1, $2::jsonb, $3, NOW())
         ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [key, JSON.stringify(value), actorId]
      );
    }
    if (values.apiKey) await upsertSecret(client, API_KEY_SECRET, values.apiKey, actorId);
    const changes = [];
    if (Object.prototype.hasOwnProperty.call(values, "enabled") && before.requestedEnabled !== values.enabled) changes.push({ setting: "password_recovery_enabled", previous_value: before.requestedEnabled, new_value: values.enabled });
    if (Object.prototype.hasOwnProperty.call(values, "provider") && before.provider !== values.provider) changes.push({ setting: "password_recovery_provider", previous_value: before.provider, new_value: values.provider });
    if (Object.prototype.hasOwnProperty.call(values, "fromEmail") && before.fromEmail !== values.fromEmail) changes.push({ setting: "password_recovery_from_email", previous_value: before.fromEmail, new_value: values.fromEmail });
    if (values.apiKey) changes.push({ setting: "resend_api_key", change: "replaced" });
    if (changes.length) await audit({ db: client, action: "advanced_settings_updated", actorId, details: { changes }, request });
    const after = await getPasswordRecoveryConfig(client);
    await client.query("COMMIT");
    return safePasswordRecoveryConfig(after);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof SecretStorageError) throw new Error("secret_storage_unavailable");
    throw error;
  } finally {
    client.release();
  }
}

export async function rotatePasswordResetSecret({ actorId, request = null, db = pool, audit = auditLog, auditAction = "password_reset_secret_rotated" } = {}) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await upsertSecret(client, RESET_SECRET, crypto.randomBytes(32).toString("base64url"), actorId);
    await client.query("UPDATE password_reset_requests SET consumed_at = COALESCE(consumed_at, NOW()), updated_at = NOW() WHERE consumed_at IS NULL");
    await audit({ db: client, action: auditAction, actorId, details: { active_flows_invalidated: true }, request });
    const config = await getPasswordRecoveryConfig(client);
    await client.query("COMMIT");
    return safePasswordRecoveryConfig(config);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof SecretStorageError) throw new Error("secret_storage_unavailable");
    throw error;
  } finally {
    client.release();
  }
}

export async function createPasswordResetSecret(options = {}) {
  const result = await rotatePasswordResetSecret({ ...options, auditAction: "password_reset_secret_created" });
  return result;
}

export const PASSWORD_RECOVERY_SECRET_KEYS = Object.freeze({ API_KEY_SECRET, RESET_SECRET });
