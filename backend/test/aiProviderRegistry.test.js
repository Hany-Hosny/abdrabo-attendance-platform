import test from "node:test";
import assert from "node:assert/strict";
import { adminSettingsRouter } from "../src/routes/adminSettings.js";
import { decryptSecret } from "../src/services/secretStorage.js";
import { AI_PROVIDERS, AI_PROVIDER_IDS, getAiProviderStatuses, getAiRoutingStrategy, updateAiProviderCredential, updateAiProviderSettings, updateAiRoutingStrategy, validateAiProviderSettings, validateAiRoutingStrategy } from "../src/services/aiProviderRegistry.js";

const emptyProviderDb = async (text) => text.includes("system_settings") ? { rows: [] } : { rows: [] };

test("provider registry contains the stable initial provider set in order", () => {
  assert.deepEqual(AI_PROVIDER_IDS, ["gemini", "groq", "mistral", "openrouter", "cloudflare"]);
  assert.deepEqual(Object.keys(AI_PROVIDERS), AI_PROVIDER_IDS);
});

test("provider registry contains metadata only and no secret values", () => {
  const serialized = JSON.stringify(AI_PROVIDERS);
  assert.doesNotMatch(serialized, /AIza|gsk_|sk-[A-Za-z0-9]|Bearer\s/i);
  assert.equal(AI_PROVIDERS.cloudflare.credentialFields.includes("apiToken"), true);
});

test("normalized statuses preserve Gemini config and hide credentials", async () => {
  const statuses = await getAiProviderStatuses({
    db: emptyProviderDb,
    loadGeminiConfig: async () => ({
      model: "gemini-3.5-flash",
      apiKey: "never-return-this",
      apiKeyConfigured: true,
      encryptionConfigured: true
    })
  });
  assert.deepEqual(statuses[0], {
    id: "gemini",
    label: "Google Gemini",
    enabled: true,
    configured: true,
    model: "gemini-3.5-flash",
    priority: 1,
    timeoutMs: 12000,
    supportsConnectionTest: true,
    apiKeyConfigured: true
  });
  assert.equal(Object.prototype.hasOwnProperty.call(statuses[0], "apiKey"), false);
  assert.doesNotMatch(JSON.stringify(statuses), /never-return-this/);
});

test("normalized Gemini status recognizes the existing environment fallback without exposing it", async () => {
  const previous = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "environment-key-that-must-not-return";
  try {
    const statuses = await getAiProviderStatuses({ db: emptyProviderDb, loadGeminiConfig: async () => ({ model: "gemini-3.6-flash", apiKeyConfigured: false }) });
    assert.equal(statuses[0].configured, true);
    assert.doesNotMatch(JSON.stringify(statuses), /environment-key-that-must-not-return/);
  } finally {
    if (previous === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous;
  }
});

test("Gemini provider settings default safely and persist routing controls without duplicating its model", async () => {
  const db = createProviderDb();
  const loadGeminiConfig = async () => ({ model: "gemini-3.5-flash", apiKeyConfigured: true });
  const defaults = await getAiProviderStatuses({ db, loadGeminiConfig });
  assert.deepEqual(defaults[0], { id: "gemini", label: "Google Gemini", enabled: true, configured: true, model: "gemini-3.5-flash", priority: 1, timeoutMs: 12000, supportsConnectionTest: true, apiKeyConfigured: true });
  const saved = await updateAiProviderSettings("gemini", { enabled: false, priority: 2, timeoutMs: 9000 }, { db, actorId: 7, audit: async () => undefined, loadGeminiConfig });
  assert.deepEqual(db.settings.get("ai_provider_gemini"), { enabled: false, priority: 2, timeoutMs: 9000 });
  assert.equal(saved.enabled, false);
  assert.equal(saved.model, "gemini-3.5-flash");
});

test("unimplemented providers remain disabled and unconfigured", async () => {
  const statuses = await getAiProviderStatuses({ db: emptyProviderDb, loadGeminiConfig: async () => ({ model: "gemini-3.6-flash", apiKeyConfigured: false }) });
  for (const status of statuses.slice(1)) {
    assert.equal(status.enabled, false);
    assert.equal(status.configured, false);
    assert.equal(status.model, null);
    assert.equal(status.priority, null);
  }
});

test("provider status endpoint is owner-scoped under advanced settings", () => {
  const route = adminSettingsRouter.stack.find((layer) => layer.route?.path === "/advanced/ai/providers");
  assert.ok(route);
  assert.equal(route.route.methods.get, true);
  assert.equal(route.route.stack.length, 2);
  assert.equal(adminSettingsRouter.stack.some((layer) => layer.name === "requireTeacher"), true);
});

test("generic provider test endpoint is owner-scoped and distinct from Gemini legacy testing", () => {
  const route = adminSettingsRouter.stack.find((layer) => layer.route?.path === "/advanced/ai/providers/:providerId/test");
  assert.ok(route);
  assert.equal(route.route.methods.post, true);
  assert.equal(route.route.stack.length, 2);
});

function createProviderDb() {
  const settings = new Map();
  const secrets = new Map();
  let lastSecretParams = null;
  const client = {
    async query(text, params = []) {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(text)) return { rows: [] };
      if (text.includes("SELECT key, value_json")) return { rows: [...settings].map(([key, value_json]) => ({ key, value_json })) };
      if (text.includes("SELECT key, encrypted_value")) return { rows: [...secrets.values()] };
      if (text.startsWith("INSERT INTO system_settings")) { settings.set(params[0], JSON.parse(params[1])); return { rows: [] }; }
      if (text.startsWith("INSERT INTO system_secrets")) {
        lastSecretParams = params;
        secrets.set(params[0], { key: params[0], encrypted_value: params[1], iv: params[2], auth_tag: params[3] });
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${text}`);
    },
    release() {}
  };
  return { settings, secrets, get lastSecretParams() { return lastSecretParams; }, async connect() { return client; }, query: client.query.bind(client) };
}

test("provider settings persist for Groq, Mistral, OpenRouter, and Cloudflare", async () => {
  const db = createProviderDb();
  const audit = async () => undefined;
  const loadGeminiConfig = async () => ({ model: "gemini-3.6-flash", apiKeyConfigured: false });
  for (const providerId of ["groq", "mistral", "openrouter"]) {
    await updateAiProviderSettings(providerId, { enabled: true, model: "future-model", priority: 2, timeoutMs: 15000 }, { db, actorId: 7, audit, loadGeminiConfig });
    assert.equal(db.settings.get(`ai_provider_${providerId}`).enabled, true);
  }
  const cloudflare = await updateAiProviderSettings("cloudflare", { enabled: false, model: null, priority: null, timeoutMs: 12000, accountId: "account-123" }, { db, actorId: 7, audit, loadGeminiConfig });
  assert.equal(db.settings.get("ai_provider_cloudflare").accountId, "account-123");
  assert.equal(cloudflare.id, "cloudflare");
});

test("provider credentials are encrypted and status exposes only configured booleans", async () => {
  const previous = process.env.SETTINGS_ENCRYPTION_KEY;
  process.env.SETTINGS_ENCRYPTION_KEY = "d".repeat(64);
  try {
    const db = createProviderDb();
    await updateAiProviderCredential("groq", { apiKey: "groq-secret-value" }, { db, actorId: 7, audit: async () => undefined, loadGeminiConfig: async () => ({ model: "gemini-3.6-flash", apiKeyConfigured: false }) });
    assert.equal(db.lastSecretParams[1].includes("groq-secret-value"), false);
    assert.equal(decryptSecret({ encrypted_value: db.lastSecretParams[1], iv: db.lastSecretParams[2], auth_tag: db.lastSecretParams[3] }), "groq-secret-value");
    const statuses = await getAiProviderStatuses({ db, loadGeminiConfig: async () => ({ model: "gemini-3.6-flash", apiKeyConfigured: false }) });
    const groq = statuses.find((status) => status.id === "groq");
    assert.equal(groq.configured, true);
    assert.doesNotMatch(JSON.stringify(statuses), /groq-secret-value/);
  } finally {
    if (previous === undefined) delete process.env.SETTINGS_ENCRYPTION_KEY;
    else process.env.SETTINGS_ENCRYPTION_KEY = previous;
  }
});

test("provider validation rejects unsafe settings and only supports failover routing", () => {
  assert.throws(() => validateAiProviderSettings("unknown", {}), /invalid_ai_provider/);
  assert.deepEqual(validateAiProviderSettings("gemini", { enabled: true, priority: 1, timeoutMs: 12000 }), { enabled: true, priority: 1, timeoutMs: 12000 });
  assert.throws(() => validateAiProviderSettings("gemini", { enabled: true, model: "duplicate" }), /invalid_ai_provider_settings/);
  assert.throws(() => validateAiProviderSettings("groq", { enabled: true, priority: null }), /invalid_ai_provider_priority/);
  assert.throws(() => validateAiProviderSettings("groq", { enabled: false, timeoutMs: 999 }), /invalid_ai_provider_timeout/);
  assert.deepEqual(validateAiProviderSettings("cloudflare", { enabled: false, model: null, priority: null, timeoutMs: 12000, accountId: "acct" }), { enabled: false, model: null, priority: null, timeoutMs: 12000, accountId: "acct" });
  assert.equal(validateAiRoutingStrategy("failover"), "failover");
  assert.throws(() => validateAiRoutingStrategy("weighted"), /invalid_ai_routing_strategy/);
});

test("routing strategy persists only the supported failover value", async () => {
  const db = createProviderDb();
  const result = await updateAiRoutingStrategy("failover", { db, actorId: 7, audit: async () => undefined });
  assert.equal(result.strategy, "failover");
  assert.equal(db.settings.get("ai_routing_strategy"), "failover");
  assert.equal(await getAiRoutingStrategy(db), "failover");
});
