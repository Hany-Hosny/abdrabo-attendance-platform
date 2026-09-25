import test from "node:test";
import assert from "node:assert/strict";
import { generateWithRouting } from "../src/services/aiProviderRouter.js";
import { updateAiProviderHealth } from "../src/services/aiProviderInstances.js";

const base = { messages: [{ role: "user", content: "hello" }], systemInstruction: "system", maxOutputTokens: 20, temperature: 0 };
function instance(id, providerType, priority) { return { id, providerType, label: providerType, displayName: id, enabled: true, routingEnabled: true, configured: true, modelId: "model", priority, timeoutMs: 1000, hedgeDelayMs: 0, maxConcurrency: null, providerConfig: {}, cooldownUntil: null }; }

test("adaptive parallel returns the first valid response and keeps duplicate provider instances independent", async () => {
  const calls = [];
  const result = await generateWithRouting({ ...base, loadProviderInstances: async () => [instance("gemini-a", "gemini", 1), instance("gemini-b", "gemini", 2), instance("openrouter-a", "openrouter", 3)], loadInstance: async (id) => ({ credentials: id.startsWith("gemini") ? { apiKey: id } : { apiKey: id } }), updateHealth: async () => undefined, createGeminiClient: (key) => ({ models: { generateContent: async () => { calls.push(key); return { text: key === "gemini-a" ? "first" : "second" }; } } }), overallTimeoutMs: 3000 });
  assert.equal(result.ok, true);
  assert.equal(result.providerInstanceId, "gemini-a");
  assert.equal(result.winner, true);
  assert.ok(calls.includes("gemini-a"));
});

test("routing excludes disabled and non-routing instances and uses a later wave after failure", async () => {
  const calls = [];
  const pool = [instance("gemini-a", "gemini", 1), { ...instance("cloudflare-a", "cloudflare", 2), routingEnabled: false }, instance("openrouter-a", "openrouter", 3)];
  const result = await generateWithRouting({ ...base, loadProviderInstances: async () => pool, loadInstance: async (id) => ({ credentials: id === "gemini-a" ? { apiKey: id } : { apiKey: id }, providerConfig: {} }), updateHealth: async () => undefined, createGeminiClient: () => ({ models: { generateContent: async () => { calls.push("gemini"); throw Object.assign(new Error("quota"), { status: 429 }); } } }), fetchImpl: async (url) => { calls.push(url); return { ok: true, status: 200, async json() { return { choices: [{ message: { content: "openrouter success" } }] }; } }; }, overallTimeoutMs: 3000 });
  assert.equal(result.ok, true);
  assert.equal(result.providerInstanceId, "openrouter-a");
  assert.equal(calls.length, 2);
});

test("full parallel still returns a valid result when another instance fails", async () => {
  const result = await generateWithRouting({ ...base, loadRoutingStrategy: async () => "full_parallel", loadProviderInstances: async () => [instance("gemini-a", "gemini", 1), instance("gemini-b", "gemini", 2)], loadInstance: async () => ({ credentials: { apiKey: "key" } }), updateHealth: async () => undefined, createGeminiClient: () => ({ models: { generateContent: async () => ({ text: "ok" }) } }) });
  assert.equal(result.ok, true);
  assert.equal(result.winner, true);
});

test("configuration-problem instances never enter the routing pool", async () => {
  const result = await generateWithRouting({ ...base, loadProviderInstances: async () => [{ ...instance("broken", "groq", 1), healthState: "configuration_problem" }], loadInstance: async () => ({ credentials: { apiKey: "key" } }), createGeminiClient: () => ({ models: { generateContent: async () => ({ text: "should not run" }) } }), overallTimeoutMs: 1000 });
  assert.notEqual(result.providerInstanceId, "broken");
});

test("health persistence maps configuration failures without a cooldown", async () => {
  let params;
  await updateAiProviderHealth("instance", { ok: false, outcome: { type: "PERMISSION_ERROR", status: "provider_permission_denied" } }, { db: async (_sql, values) => { params = values; return { rows: [] }; } });
  assert.equal(params[1], "configuration_problem");
  assert.equal(params[2], null);
  await updateAiProviderHealth("instance", { ok: true, outcome: { type: "SUCCESS" } }, { db: async (_sql, values) => { params = values; return { rows: [] }; } });
  assert.equal(params[1], "healthy");
  assert.equal(params[2], null);
});
