import test from "node:test";
import assert from "node:assert/strict";
import { generateWithFailover } from "../src/services/aiProviderRouter.js";

const request = { messages: [{ role: "user", content: "اشرح" }], systemInstruction: "تعليمات", maxOutputTokens: 20, temperature: 0 };

function router(options = {}) {
  const calls = [];
  const result = generateWithFailover({
    ...request,
    loadProviderStatuses: async () => options.statuses || [{ id: "gemini", enabled: true, configured: true, model: "gemini-3.6-flash", priority: 1, timeoutMs: 1000 }],
    loadGeminiConfig: async () => ({ apiKey: "gemini-secret", model: "gemini-3.6-flash", apiKeyConfigured: true }),
    createGeminiClient: () => ({ models: { generateContent: async () => { calls.push("gemini"); return { text: "gemini response" }; } } }),
    loadProviderTestConfig: async (provider) => ({ model: "provider-model", timeoutMs: 1000, credentials: { apiKey: `${provider}-secret` }, providerConfig: {} }),
    fetchImpl: async (url) => { calls.push(url); return { ok: true, status: 200, async json() { return { choices: [{ message: { content: "provider response" } }] }; } }; },
    ...options
  });
  return { result, calls };
}

test("Gemini-only routing preserves the existing generation path", async () => {
  const { result, calls } = router();
  const response = await result;
  assert.equal(response.provider, "gemini");
  assert.equal(response.content, "gemini response");
  assert.deepEqual(calls, ["gemini"]);
});

test("retryable first-provider failures fall through in priority order", async () => {
  const calls = [];
  const response = await generateWithFailover({
    ...request,
    loadProviderStatuses: async () => [
      { id: "groq", enabled: true, configured: true, model: "groq", priority: 1, timeoutMs: 1000 },
      { id: "mistral", enabled: true, configured: true, model: "mistral", priority: 2, timeoutMs: 1000 }
    ],
    loadProviderTestConfig: async (provider) => ({ model: provider, credentials: { apiKey: "secret" }, providerConfig: {} }),
    fetchImpl: async (url) => { calls.push(url); return calls.length === 1 ? { ok: false, status: 429 } : { ok: true, status: 200, async json() { return { choices: [{ message: { content: "second response" } }] }; } }; }
  });
  assert.equal(response.provider, "mistral");
  assert.equal(calls.length, 2);
});

test("Gemini rate limits are normalized so failover can continue", async () => {
  const calls = [];
  const response = await generateWithFailover({
    ...request,
    loadProviderStatuses: async () => [
      { id: "gemini", enabled: true, configured: true, model: "gemini-3.6-flash", priority: 1, timeoutMs: 1000 },
      { id: "groq", enabled: true, configured: true, model: "groq-model", priority: 2, timeoutMs: 1000 }
    ],
    loadGeminiConfig: async () => ({ apiKey: "gemini-secret", model: "gemini-3.6-flash", apiKeyConfigured: true }),
    createGeminiClient: () => ({ models: { generateContent: async () => { calls.push("gemini"); throw Object.assign(new Error("quota"), { status: 429 }); } } }),
    loadProviderTestConfig: async () => ({ model: "groq-model", credentials: { apiKey: "groq-secret" }, providerConfig: {} }),
    fetchImpl: async () => { calls.push("groq"); return { ok: true, status: 200, async json() { return { choices: [{ message: { content: "fallback response" } }] }; } }; }
  });
  assert.equal(response.provider, "groq");
  assert.deepEqual(calls, ["gemini", "groq"]);
});

test("disabled and unconfigured providers are skipped and first success stops routing", async () => {
  const { result, calls } = router({ statuses: [
    { id: "groq", enabled: false, configured: true, model: "groq", priority: 1, timeoutMs: 1000 },
    { id: "mistral", enabled: true, configured: false, model: "mistral", priority: 2, timeoutMs: 1000 },
    { id: "gemini", enabled: true, configured: true, model: "gemini-3.6-flash", priority: 3, timeoutMs: 1000 }
  ] });
  const response = await result;
  assert.equal(response.provider, "gemini");
  assert.deepEqual(calls, ["gemini"]);
});

test("all provider failures return one safe normalized unavailable result", async () => {
  const response = await generateWithFailover({
    ...request,
    loadProviderStatuses: async () => [{ id: "groq", enabled: true, configured: true, model: "groq", priority: 1, timeoutMs: 1000 }],
    loadProviderTestConfig: async () => ({ model: "groq", credentials: { apiKey: "secret" }, providerConfig: {} }),
    fetchImpl: async () => ({ ok: false, status: 503 })
  });
  assert.deepEqual(response, { ok: false, status: "provider_unavailable", message: "The AI service is temporarily unavailable. Please try again." });
  assert.doesNotMatch(JSON.stringify(response), /secret/);
});

test("provider priority determines attempt order", async () => {
  const calls = [];
  const response = await generateWithFailover({
    ...request,
    loadProviderStatuses: async () => [
      { id: "mistral", enabled: true, configured: true, model: "mistral", priority: 5, timeoutMs: 1000 },
      { id: "groq", enabled: true, configured: true, model: "groq", priority: 1, timeoutMs: 1000 }
    ],
    loadProviderTestConfig: async (provider) => ({ model: provider, credentials: { apiKey: "secret" }, providerConfig: {} }),
    fetchImpl: async (url) => { calls.push(url); return { ok: true, status: 200, async json() { return { choices: [{ message: { content: "first" } }] }; } }; }
  });
  assert.equal(response.provider, "groq");
  assert.match(calls[0], /groq/);
});
