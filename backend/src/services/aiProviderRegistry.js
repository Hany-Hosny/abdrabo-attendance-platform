import { pool, query } from "../db/pool.js";
import { auditLog } from "./audit.js";
import { decryptSecret, encryptSecret, SecretStorageError } from "./secretStorage.js";
import { getGeminiConfig, GEMINI_MODELS, DEFAULT_GEMINI_MODEL } from "./geminiConfig.js";

const AI_PROVIDER_SETTING_KEYS = Object.freeze({ gemini: "ai_provider_gemini", groq: "ai_provider_groq", mistral: "ai_provider_mistral", openrouter: "ai_provider_openrouter", cloudflare: "ai_provider_cloudflare" });
const AI_PROVIDER_SECRET_KEYS = Object.freeze({ groq: "ai_provider_groq_key", mistral: "ai_provider_mistral_key", openrouter: "ai_provider_openrouter_key", cloudflare: "ai_provider_cloudflare_token" });
export const AI_ROUTING_SETTING_KEY = "ai_routing_strategy";
export const AI_ROUTING_STRATEGIES = Object.freeze(["failover"]);
const DEFAULT_TIMEOUT_MS = 12_000;

export const AI_PROVIDERS = Object.freeze({
  gemini: Object.freeze({ id: "gemini", label: "Google Gemini", enabledByDefault: true, credentialFields: Object.freeze(["apiKey"]), models: GEMINI_MODELS, defaultModel: DEFAULT_GEMINI_MODEL, supportsConnectionTest: true, defaultTimeoutMs: DEFAULT_TIMEOUT_MS }),
  groq: Object.freeze({ id: "groq", label: "Groq", enabledByDefault: false, credentialFields: Object.freeze(["apiKey"]), models: Object.freeze([]), defaultModel: null, supportsConnectionTest: true, defaultTimeoutMs: DEFAULT_TIMEOUT_MS }),
  mistral: Object.freeze({ id: "mistral", label: "Mistral", enabledByDefault: false, credentialFields: Object.freeze(["apiKey"]), models: Object.freeze([]), defaultModel: null, supportsConnectionTest: true, defaultTimeoutMs: DEFAULT_TIMEOUT_MS }),
  openrouter: Object.freeze({ id: "openrouter", label: "OpenRouter", enabledByDefault: false, credentialFields: Object.freeze(["apiKey"]), models: Object.freeze([]), defaultModel: null, supportsConnectionTest: true, defaultTimeoutMs: DEFAULT_TIMEOUT_MS }),
  cloudflare: Object.freeze({ id: "cloudflare", label: "Cloudflare Workers AI", enabledByDefault: false, credentialFields: Object.freeze(["accountId", "apiToken"]), models: Object.freeze([]), defaultModel: null, supportsConnectionTest: true, defaultTimeoutMs: DEFAULT_TIMEOUT_MS })
});
export const AI_PROVIDER_IDS = Object.freeze(Object.keys(AI_PROVIDERS));
export const AI_CONFIGURABLE_PROVIDER_IDS = Object.freeze(Object.keys(AI_PROVIDER_SETTING_KEYS));

function executeWith(db) { return typeof db === "function" ? db : db.query.bind(db); }
function providerOrThrow(providerId) { if (!AI_CONFIGURABLE_PROVIDER_IDS.includes(providerId)) throw new Error("invalid_ai_provider"); return AI_PROVIDERS[providerId]; }
function normalizeConfig(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_ai_provider_settings");
  if (Object.keys(value).some((key) => !["enabled", "model", "priority", "timeoutMs", "accountId"].includes(key))) throw new Error("invalid_ai_provider_settings");
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw new Error("invalid_ai_provider_settings");
  const enabled = value.enabled ?? false;
  const model = value.model === undefined || value.model === null ? null : String(value.model).trim();
  if (model !== null && (!model || model.length > 200)) throw new Error("invalid_ai_provider_settings");
  const priority = value.priority === undefined || value.priority === null ? null : Number(value.priority);
  if (priority !== null && (!Number.isInteger(priority) || priority < 1 || priority > 1000)) throw new Error("invalid_ai_provider_priority");
  if (enabled && priority === null) throw new Error("invalid_ai_provider_priority");
  const timeoutMs = value.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Number(value.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error("invalid_ai_provider_timeout");
  const accountId = value.accountId === undefined || value.accountId === null ? null : String(value.accountId).trim();
  if (accountId !== null && (!accountId || accountId.length > 200)) throw new Error("invalid_ai_provider_account_id");
  return { enabled, model, priority, timeoutMs, ...(Object.prototype.hasOwnProperty.call(value, "accountId") ? { accountId } : {}) };
}

export function validateAiProviderSettings(providerId, value) {
  providerOrThrow(providerId);
  if (providerId === "gemini") {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["enabled", "priority", "timeoutMs"].includes(key))) throw new Error("invalid_ai_provider_settings");
    const config = normalizeConfig(value);
    return { enabled: config.enabled, priority: config.priority, timeoutMs: config.timeoutMs };
  }
  if (providerId !== "cloudflare" && Object.prototype.hasOwnProperty.call(value || {}, "accountId")) throw new Error("invalid_ai_provider_settings");
  return normalizeConfig(value);
}
export function validateAiRoutingStrategy(value) { if (!AI_ROUTING_STRATEGIES.includes(value)) throw new Error("invalid_ai_routing_strategy"); return value; }

async function readProviderRows(db) {
  const execute = executeWith(db);
  const [settingsResult, secretsResult] = await Promise.all([
    execute("SELECT key, value_json, updated_at FROM system_settings WHERE key = ANY($1::text[])", [Object.values(AI_PROVIDER_SETTING_KEYS).concat(AI_ROUTING_SETTING_KEY)]),
    execute("SELECT key, encrypted_value, iv, auth_tag FROM system_secrets WHERE key = ANY($1::text[])", [Object.values(AI_PROVIDER_SECRET_KEYS)])
  ]);
  const settings = new Map((settingsResult.rows || []).map((row) => [row.key, row]));
  const secrets = new Map();
  for (const row of secretsResult.rows || []) { try { secrets.set(row.key, Boolean(decryptSecret(row))); } catch (_error) { secrets.set(row.key, false); } }
  return { settings, secrets };
}

function safeProviderStatus(provider, overrides = {}) {
  const configured = Boolean(overrides.configured);
  const status = { id: provider.id, label: provider.label, enabled: overrides.enabled ?? provider.enabledByDefault, configured, model: overrides.model ?? provider.defaultModel, priority: overrides.priority ?? null, timeoutMs: overrides.timeoutMs ?? provider.defaultTimeoutMs, supportsConnectionTest: provider.supportsConnectionTest };
  if (provider.credentialFields.includes("apiKey")) status.apiKeyConfigured = Boolean(overrides.apiKeyConfigured ?? configured);
  if (provider.credentialFields.includes("apiToken")) status.tokenConfigured = Boolean(overrides.tokenConfigured ?? configured);
  if (provider.id === "cloudflare") status.accountId = overrides.accountId ?? null;
  return status;
}

export async function getAiProviderStatuses({ db = query, loadGeminiConfig = getGeminiConfig } = {}) {
  const [gemini, stored] = await Promise.all([loadGeminiConfig(), readProviderRows(db)]);
  return AI_PROVIDER_IDS.map((id) => {
    const provider = AI_PROVIDERS[id];
    if (id === "gemini") {
      let config = { enabled: true, priority: 1, timeoutMs: provider.defaultTimeoutMs };
      try { if (stored.settings.has(AI_PROVIDER_SETTING_KEYS.gemini)) config = { ...config, ...validateAiProviderSettings("gemini", stored.settings.get(AI_PROVIDER_SETTING_KEYS.gemini).value_json) }; } catch (_error) { /* preserve legacy defaults */ }
      const configured = gemini.apiKeyConfigured || Boolean(String(process.env.GEMINI_API_KEY || "").trim());
      return safeProviderStatus(provider, { configured, apiKeyConfigured: configured, enabled: config.enabled, model: gemini.model, priority: config.priority, timeoutMs: config.timeoutMs });
    }
    const settingKey = AI_PROVIDER_SETTING_KEYS[id];
    let config = {};
    try { config = stored.settings.has(settingKey) ? normalizeConfig(stored.settings.get(settingKey).value_json) : {}; } catch (_error) { config = {}; }
    const configured = id === "cloudflare" ? Boolean(config.accountId && stored.secrets.get(AI_PROVIDER_SECRET_KEYS[id])) : Boolean(stored.secrets.get(AI_PROVIDER_SECRET_KEYS[id]));
    return safeProviderStatus(provider, { enabled: config.enabled ?? false, configured, apiKeyConfigured: id !== "cloudflare" && configured, tokenConfigured: id === "cloudflare" && configured, model: config.model ?? null, priority: config.priority ?? null, timeoutMs: config.timeoutMs ?? provider.defaultTimeoutMs, accountId: config.accountId ?? null });
  });
}

export async function getAiRoutingStrategy(db = query) {
  const { settings } = await readProviderRows(db);
  const value = settings.get(AI_ROUTING_SETTING_KEY)?.value_json;
  return AI_ROUTING_STRATEGIES.includes(value) ? value : "failover";
}

export async function getAiProviderTestConfig(providerId, db = query) {
  providerOrThrow(providerId);
  const execute = executeWith(db);
  const [settingsResult, secretsResult] = await Promise.all([
    execute("SELECT value_json FROM system_settings WHERE key = $1", [AI_PROVIDER_SETTING_KEYS[providerId]]),
    execute("SELECT encrypted_value, iv, auth_tag FROM system_secrets WHERE key = $1", [AI_PROVIDER_SECRET_KEYS[providerId]])
  ]);
  let config = {};
  try { config = normalizeConfig(settingsResult.rows?.[0]?.value_json || {}); } catch (_error) { config = {}; }
  let secret = "";
  if (secretsResult.rows?.[0]) {
    try { secret = decryptSecret(secretsResult.rows[0]); } catch (_error) { secret = ""; }
  }
  return {
    model: config.model,
    timeoutMs: config.timeoutMs || DEFAULT_TIMEOUT_MS,
    providerConfig: config,
    credentials: providerId === "cloudflare" ? { apiToken: secret } : { apiKey: secret }
  };
}

async function upsertSecret(client, key, value, actorId) {
  const encrypted = encryptSecret(value);
  await client.query("INSERT INTO system_secrets (key, encrypted_value, iv, auth_tag, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, NOW()) ON CONFLICT (key) DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value, iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag, updated_by = EXCLUDED.updated_by, updated_at = NOW()", [key, encrypted.encryptedValue, encrypted.iv, encrypted.authTag, actorId]);
}

export async function updateAiProviderSettings(providerId, input, { actorId, request = null, db = pool, audit = auditLog, loadGeminiConfig = getGeminiConfig } = {}) {
  const config = validateAiProviderSettings(providerId, input);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO system_settings (key, value_json, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, NOW()) ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_by = EXCLUDED.updated_by, updated_at = NOW()", [AI_PROVIDER_SETTING_KEYS[providerId], JSON.stringify(config), actorId || null]);
    await audit({ db: client, action: "advanced_settings_updated", actorId, details: { provider: providerId, settings: config }, request });
    await client.query("COMMIT");
    return (await getAiProviderStatuses({ db: client, loadGeminiConfig })).find((status) => status.id === providerId);
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function updateAiProviderCredential(providerId, input, { actorId, request = null, db = pool, audit = auditLog, loadGeminiConfig = getGeminiConfig } = {}) {
  providerOrThrow(providerId);
  if (providerId === "gemini") throw new Error("invalid_ai_provider_credential");
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_ai_provider_credential");
  const field = providerId === "cloudflare" ? "apiToken" : "apiKey";
  const value = String(input[field] || "").trim();
  if (!value || value.length > 500 || Object.keys(input).some((key) => key !== field)) throw new Error("invalid_ai_provider_credential");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await upsertSecret(client, AI_PROVIDER_SECRET_KEYS[providerId], value, actorId);
    await audit({ db: client, action: "advanced_settings_updated", actorId, details: { provider: providerId, credential: field, change: "replaced" }, request });
    await client.query("COMMIT");
    return (await getAiProviderStatuses({ db: client, loadGeminiConfig })).find((status) => status.id === providerId);
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); if (error instanceof SecretStorageError) throw new Error("secret_storage_unavailable"); throw error; }
  finally { client.release(); }
}

export async function updateAiRoutingStrategy(value, { actorId, request = null, db = pool, audit = auditLog } = {}) {
  const strategy = validateAiRoutingStrategy(value);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO system_settings (key, value_json, updated_by, updated_at) VALUES ($1, $2::jsonb, $3, NOW()) ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_by = EXCLUDED.updated_by, updated_at = NOW()", [AI_ROUTING_SETTING_KEY, JSON.stringify(strategy), actorId || null]);
    await audit({ db: client, action: "advanced_settings_updated", actorId, details: { setting: AI_ROUTING_SETTING_KEY, value: strategy }, request });
    await client.query("COMMIT");
    return { strategy };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

export const AI_PROVIDER_CONFIG_KEYS = Object.freeze({ ...AI_PROVIDER_SETTING_KEYS, ...AI_PROVIDER_SECRET_KEYS });
