import test from "node:test";
import assert from "node:assert/strict";
import { discoverAiProvider, normalizeProviderError, testAiProviderConnection } from "../src/services/aiProviderAdapters.js";

function response(status = 200, body = {}) { return { ok: status >= 200 && status < 300, status, async json() { return body; } }; }

test("Groq adapter performs a minimal request and normalizes success/auth failure", async () => {
  let request;
  const success = await testAiProviderConnection("groq", { credentials: { apiKey: "secret" }, model: "groq-model", timeoutMs: 1000, fetchImpl: async (url, options) => { request = { url, options }; return response(); } });
  assert.equal(success.ok, true);
  assert.match(request.url, /api\.groq\.com/);
  assert.equal(request.options.headers.Authorization, "Bearer secret");
  const failure = await testAiProviderConnection("groq", { credentials: { apiKey: "secret" }, model: "groq-model", fetchImpl: async () => response(401) });
  assert.equal(failure.status, "provider_auth_failed");
  assert.doesNotMatch(JSON.stringify(failure), /secret/);
});
test("OpenRouter and Mistral adapters normalize provider failures", async () => {
  const openrouter = await testAiProviderConnection("openrouter", { credentials: { apiKey: "secret" }, model: "router-model", fetchImpl: async (url) => { assert.match(url, /openrouter/); return response(404); } });
  assert.equal(openrouter.status, "provider_model_unavailable");
  const mistral = await testAiProviderConnection("mistral", { credentials: { apiKey: "secret" }, model: "mistral-model", fetchImpl: async () => response(429) });
  assert.equal(mistral.status, "provider_rate_limited");
});

test("Cloudflare requires account ID and token and supports successful tests", async () => {
  const missing = await testAiProviderConnection("cloudflare", { credentials: { apiToken: "token" }, model: "@cf/model", fetchImpl: async () => response() });
  assert.equal(missing.status, "provider_not_configured");
  let url = "";
  const success = await testAiProviderConnection("cloudflare", { credentials: { apiToken: "token" }, providerConfig: { accountId: "account" }, model: "@cf/model", fetchImpl: async (requestUrl) => { url = requestUrl; return response(); } });
  assert.equal(success.ok, true);
  assert.match(url, /accounts%2Faccount|accounts\/account/);
});

test("adapter timeout is normalized and missing models are rejected", async () => {
  const timeout = await testAiProviderConnection("mistral", { credentials: { apiKey: "secret" }, model: "model", timeoutMs: 1000, fetchImpl: (_url, options) => new Promise((_, reject) => { options.signal.addEventListener("abort", () => { const error = new Error("aborted"); error.name = "AbortError"; reject(error); }); }) });
  assert.equal(timeout.status, "provider_timeout");
  const missing = await testAiProviderConnection("mistral", { credentials: { apiKey: "secret" }, fetchImpl: async () => response() });
  assert.equal(missing.status, "provider_not_configured");
  assert.equal(missing.type, "INVALID_CONFIGURATION");
});

test("provider outcomes distinguish permission, model, and transient failures", async () => {
  const permission = await testAiProviderConnection("cloudflare", { credentials: { apiToken: "token" }, providerConfig: { accountId: "account" }, model: "@cf/model", fetchImpl: async () => response(403) });
  assert.equal(permission.type, "PERMISSION_ERROR");
  assert.equal(permission.status, "provider_permission_denied");
  assert.equal(permission.retryable, false);
  const model = await testAiProviderConnection("gemini", { credentials: { apiKey: "key" }, model: "missing-model", fetchImpl: async () => response(404) });
  assert.equal(model.type, "MODEL_UNAVAILABLE");
  const upstream = await testAiProviderConnection("groq", { credentials: { apiKey: "key" }, model: "model", fetchImpl: async () => response(503) });
  assert.equal(upstream.type, "UPSTREAM_UNAVAILABLE");
  assert.equal(upstream.retryable, true);
  assert.equal(normalizeProviderError({ status: 401 }).type, "AUTHENTICATION_ERROR");
});

test("Gemini test uses generation-compatible request semantics", async () => {
  let request;
  const result = await testAiProviderConnection("gemini", { credentials: { apiKey: "key" }, model: " models/gemini-test ", fetchImpl: async (url, options) => { request = { url, options }; return response(); } });
  assert.equal(result.ok, true);
  assert.match(request.url, /models\/gemini-test:generateContent/);
  assert.doesNotMatch(request.url, /models\/models\//);
  assert.equal(result.model, "gemini-test");
  const body = JSON.parse(request.options.body);
  assert.equal(body.contents[0].parts[0].text, "ping");
  assert.equal(body.generationConfig.maxOutputTokens, 1);
});

test("discovery filters non-assistant models using provider capabilities", async () => {
  const result = await discoverAiProvider("gemini", { credentials: { apiKey: "key" }, fetchImpl: async () => response(200, { models: [
    { name: "models/chat-model", supportedGenerationMethods: ["generateContent"] },
    { name: "models/embed-model", supportedGenerationMethods: ["embedContent"] },
    { name: "models/image-model", capabilities: { imageGeneration: true, textGeneration: false } },
    { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-3-flash", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-flash-latest", supportedGenerationMethods: ["generateContent"] },
    { name: "models/experimental-chat", supportedGenerationMethods: ["chat"] }
  ] }) });
  assert.deepEqual(result.models.map((model) => model.id).sort(), ["chat-model", "gemini-2.5-flash", "gemini-3-flash", "gemini-flash-latest"].sort());
  const current = result.models.find((model) => model.id === "gemini-2.5-flash");
  const newer = result.models.find((model) => model.id === "gemini-3-flash");
  const alias = result.models.find((model) => model.id === "gemini-flash-latest");
  assert.equal(current.compatibleWithAssistant, true);
  assert.equal(current.accessStatus, "unknown");
  assert.equal(current.recommended, false);
  assert.equal(newer.recommended, true);
  assert.equal(alias.recommended, false);
});

test("model unavailable is an access result, not a malformed model ID", async () => {
  const result = await testAiProviderConnection("gemini", { credentials: { apiKey: "key" }, model: "gemini-2.5-flash", fetchImpl: async () => response(404, { error: { code: 404, message: "model is not available for this project" } }) });
  assert.equal(result.type, "MODEL_UNAVAILABLE");
  assert.equal(result.accessStatus, "unavailable");
  assert.match(result.message, /listed by the provider/);
  assert.doesNotMatch(result.message, /malformed|invalid ID/i);
});

test("upstream error metadata is sanitized and retains provider status", async () => {
  const result = await testAiProviderConnection("gemini", { credentials: { apiKey: "secret" }, model: "gemini-test", fetchImpl: async () => response(429, { error: { code: 429, message: "quota for key=secret?key=secret" } }) });
  assert.equal(result.type, "RATE_LIMITED");
  assert.equal(result.providerStatus, 429);
  assert.equal(result.upstreamCode, 429);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});
