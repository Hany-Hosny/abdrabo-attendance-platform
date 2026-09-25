import test from "node:test";
import assert from "node:assert/strict";
import { discoverAiProvider } from "../src/services/aiProviderAdapters.js";

function response(status, body) { return { ok: status >= 200 && status < 300, status, async json() { return body; } }; }

test("Gemini discovery is instance-specific and normalizes model IDs", async () => {
  const first = await discoverAiProvider("gemini", { credentials: { apiKey: "key-one" }, fetchImpl: async (_url, options) => { assert.equal(options.headers["x-goog-api-key"], "key-one"); return response(200, { models: [{ name: "models/gemini-one", displayName: "One", supportedGenerationMethods: ["generateContent"] }] }); } });
  const second = await discoverAiProvider("gemini", { credentials: { apiKey: "key-two" }, fetchImpl: async (_url, options) => { assert.equal(options.headers["x-goog-api-key"], "key-two"); return response(200, { models: [{ name: "models/gemini-two", displayName: "Two", supportedGenerationMethods: ["generateContent"] }] }); } });
  assert.deepEqual(first.models.map((model) => model.id), ["gemini-one"]);
  assert.deepEqual(second.models.map((model) => model.id), ["gemini-two"]);
});

test("Cloudflare discovery auto-selects one account and requires selection for multiple accounts", async () => {
  const one = await discoverAiProvider("cloudflare", { credentials: { apiToken: "token" }, fetchImpl: async (url) => url.includes("/accounts?") ? response(200, { result: [{ id: "account-one", name: "One" }] }) : response(200, { result: [{ id: "@cf/model", name: "@cf/model" }] }) });
  assert.deepEqual(one.discoveredConfig, { accountId: "account-one" });
  assert.equal(one.models[0].id, "@cf/model");
  const multiple = await discoverAiProvider("cloudflare", { credentials: { apiToken: "token" }, fetchImpl: async () => response(200, { result: [{ id: "one", name: "One" }, { id: "two", name: "Two" }] }) });
  assert.equal(multiple.valid, true);
  assert.equal(multiple.models.length, 0);
  assert.equal(multiple.discoveredAccounts.length, 2);
});

test("invalid discovery credentials return sanitized errors", async () => {
  const result = await discoverAiProvider("groq", { credentials: { apiKey: "secret-that-must-not-return" }, fetchImpl: async () => response(401, { error: { message: "secret-that-must-not-return rejected" } }) });
  assert.equal(result.valid, false);
  assert.doesNotMatch(JSON.stringify(result), /secret-that-must-not-return/);
});
