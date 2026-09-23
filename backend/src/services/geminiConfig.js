import { pool, query } from "../db/pool.js";
import { auditLog } from "./audit.js";
import { decryptSecret, encryptSecret, hasEncryptionKey, SecretStorageError } from "./secretStorage.js";

const GEMINI_API_KEY_SECRET = "gemini_api_key";
const GEMINI_MODEL_SETTING = "gemini_model";
// Keep only stable, currently-supported production model IDs. Retired model
// values fall back to the default in getGeminiConfig until an admin saves a new selection.
export const GEMINI_MODELS = Object.freeze(["gemini-3.6-flash", "gemini-3.5-flash", "gemini-2.5-pro"]);
export const DEFAULT_GEMINI_MODEL = "gemini-3.6-flash";

function executeWith(db) {
  return typeof db === "function" ? db : db.query.bind(db);
}

function cleanModel(value) {
  const model = String(value || "").trim();
  if (!GEMINI_MODELS.includes(model)) throw new Error("invalid_gemini_model");
  return model;
}

function cleanApiKey(value) {
  const apiKey = String(value || "").trim();
  if (!apiKey || apiKey.length > 500) throw new Error("invalid_gemini_api_key");
  return apiKey;
}

function safeProviderMessage(value) {
  const message = String(value || "").replace(/[\r\n]+/g, " ").trim();
  return message ? message.slice(0, 240) : "gemini_connection_failed";
}

async function readStoredApiKey(db = query) {
  const execute = executeWith(db);
  const result = await execute(
    "SELECT encrypted_value, iv, auth_tag FROM system_secrets WHERE key = $1",
    [GEMINI_API_KEY_SECRET]
  );
  if (!result.rowCount) return "";
  return decryptSecret(result.rows[0]);
}

async function upsertApiKey(client, apiKey, actorId) {
  const encrypted = encryptSecret(apiKey);
  await client.query(
    `INSERT INTO system_secrets (key, encrypted_value, iv, auth_tag, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (key) DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value,
       iv = EXCLUDED.iv, auth_tag = EXCLUDED.auth_tag, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [GEMINI_API_KEY_SECRET, encrypted.encryptedValue, encrypted.iv, encrypted.authTag, actorId]
  );
}

export async function getGeminiConfig(db = query) {
  const execute = executeWith(db);
  const [modelResult, apiKey] = await Promise.all([
    execute("SELECT value_json, updated_at FROM system_settings WHERE key = $1", [GEMINI_MODEL_SETTING]),
    readStoredApiKey(db).catch((error) => {
      if (error instanceof SecretStorageError) throw error;
      return "";
    })
  ]);
  const candidateModel = String(modelResult.rows[0]?.value_json || DEFAULT_GEMINI_MODEL);
  const model = GEMINI_MODELS.includes(candidateModel) ? candidateModel : DEFAULT_GEMINI_MODEL;
  return {
    model,
    apiKey,
    apiKeyConfigured: Boolean(apiKey),
    encryptionConfigured: hasEncryptionKey(),
    updatedAt: modelResult.rows[0]?.updated_at || null
  };
}

export function safeGeminiConfig(config) {
  return {
    model: config.model,
    apiKeyConfigured: config.apiKeyConfigured,
    encryptionConfigured: config.encryptionConfigured,
    updatedAt: config.updatedAt
  };
}

export async function testGeminiConnection({ apiKey, model }) {
  const safeKey = cleanApiKey(apiKey);
  const safeModel = cleanModel(model);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(safeModel)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": safeKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text: "ping" }] }],
        generationConfig: { maxOutputTokens: 1, temperature: 0 }
      }),
      signal: controller.signal
    });
    if (response.ok) return { ok: true };
    const payload = await response.json().catch(() => ({}));
    return { ok: false, message: safeProviderMessage(payload?.error?.message || payload?.message) };
  } catch (error) {
    return { ok: false, message: error?.name === "AbortError" ? "gemini_connection_timeout" : "gemini_connection_failed" };
  } finally {
    clearTimeout(timeout);
  }
}

export async function updateGeminiConfig(input, { actorId, request = null, db = pool, audit = auditLog } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_gemini_payload");
  const model = cleanModel(input.model);
  const hasApiKey = Object.prototype.hasOwnProperty.call(input, "apiKey") && String(input.apiKey || "").trim() !== "";
  const providedApiKey = hasApiKey ? cleanApiKey(input.apiKey) : "";
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const before = await getGeminiConfig(client);
    const apiKey = providedApiKey || before.apiKey;
    if (!apiKey) throw new Error("gemini_api_key_required");
    const probe = await testGeminiConnection({ apiKey, model });
    if (!probe.ok) throw Object.assign(new Error("gemini_connection_failed"), { providerMessage: probe.message });
    await client.query(
      `INSERT INTO system_settings (key, value_json, updated_by, updated_at)
       VALUES ($1, $2::jsonb, $3, NOW())
       ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [GEMINI_MODEL_SETTING, JSON.stringify(model), actorId]
    );
    if (providedApiKey) await upsertApiKey(client, providedApiKey, actorId);
    const changes = [];
    if (before.model !== model) changes.push({ setting: GEMINI_MODEL_SETTING, previous_value: before.model, new_value: model });
    if (providedApiKey) changes.push({ setting: GEMINI_API_KEY_SECRET, change: "replaced" });
    if (changes.length) await audit({ db: client, action: "advanced_settings_updated", actorId, details: { changes }, request });
    const config = await getGeminiConfig(client);
    await client.query("COMMIT");
    return safeGeminiConfig(config);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error instanceof SecretStorageError) throw new Error("secret_storage_unavailable");
    throw error;
  } finally {
    client.release();
  }
}

export async function testGeminiConfig(input, db = query) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_gemini_payload");
  const config = await getGeminiConfig(db);
  const model = cleanModel(input.model || config.model);
  const apiKey = String(input.apiKey || "").trim() || config.apiKey;
  if (!apiKey) throw new Error("gemini_api_key_required");
  return testGeminiConnection({ apiKey, model });
}

export const GEMINI_CONFIG_KEYS = Object.freeze({ GEMINI_API_KEY_SECRET, GEMINI_MODEL_SETTING, DEFAULT_GEMINI_MODEL });
