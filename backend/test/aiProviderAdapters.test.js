import test from "node:test";
import assert from "node:assert/strict";
import { testAiProviderConnection } from "../src/services/aiProviderAdapters.js";

function response(status = 200) { return { ok: status >= 200 && status < 300, status, async json() { return {}; } }; }

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
});
