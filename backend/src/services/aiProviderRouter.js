import { randomUUID } from "node:crypto";
import { DEFAULT_GEMINI_MODEL, GEMINI_MODELS, getGeminiConfig } from "./geminiConfig.js";
import { getAiProviderStatuses, getAiProviderTestConfig } from "./aiProviderRegistry.js";
import { generateWithAiProvider, normalizeModelId } from "./aiProviderAdapters.js";
import { getAiProviderInstance, listAiProviderInstances, updateAiProviderHealth } from "./aiProviderInstances.js";

const RETRYABLE_FAILURES = new Set(["provider_rate_limited", "provider_timeout", "provider_unavailable", "provider_model_unavailable", "provider_auth_failed", "provider_not_configured"]);
const SAFE_FAILURE = { ok: false, status: "provider_unavailable", message: "The AI service is temporarily unavailable. Please try again." };

function fallbackGeminiStatus(config) {
  const configured = Boolean(config?.apiKey || config?.apiKeyConfigured || String(process.env.GEMINI_API_KEY || "").trim());
  return { id: "gemini", enabled: true, configured, model: config?.model || DEFAULT_GEMINI_MODEL, priority: 1, timeoutMs: 12000 };
}

function orderedProviders(statuses) {
  return statuses.filter((provider) => provider.enabled && provider.configured).sort((left, right) => (left.priority ?? Number.MAX_SAFE_INTEGER) - (right.priority ?? Number.MAX_SAFE_INTEGER));
}

function normalizeGeminiError(error) {
  const status = Number(error?.status || error?.statusCode || error?.code || 0);
  if (status === 401 || status === 403) return "provider_auth_failed";
  if (status === 429) return "provider_rate_limited";
  if (status === 400 || status === 404) return "provider_model_unavailable";
  if (error?.status === "provider_timeout" || error?.message === "provider_timeout") return "provider_timeout";
  return "provider_unavailable";
}

async function withTimeout(task, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      task(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("provider_timeout"), { status: "provider_timeout" })), timeoutMs); })
    ]);
  } finally { clearTimeout(timer); }
}

export async function generateWithFailover({ messages, systemInstruction, maxOutputTokens = 320, temperature = 0.55, db, loadGeminiConfig = getGeminiConfig, loadProviderStatuses = getAiProviderStatuses, loadProviderTestConfig = getAiProviderTestConfig, createGeminiClient, fetchImpl = fetch, overallTimeoutMs = 45_000 } = {}) {
  let geminiConfigPromise;
  const loadGeminiConfigSafely = async () => {
    if (!geminiConfigPromise) geminiConfigPromise = Promise.resolve().then(() => loadGeminiConfig()).catch(() => ({ model: DEFAULT_GEMINI_MODEL, apiKey: String(process.env.GEMINI_API_KEY || "").trim(), apiKeyConfigured: Boolean(String(process.env.GEMINI_API_KEY || "").trim()) }));
    return geminiConfigPromise;
  };
  let statuses;
  try { statuses = await loadProviderStatuses({ db, loadGeminiConfig: loadGeminiConfigSafely }); } catch (_error) {
    statuses = [fallbackGeminiStatus(await loadGeminiConfigSafely())];
  }
  const providers = orderedProviders(statuses || []);
  if (!providers.length) {
    const legacyGemini = fallbackGeminiStatus(await loadGeminiConfigSafely());
    if (legacyGemini.configured) providers.push(legacyGemini);
    else return { ...SAFE_FAILURE, status: "provider_not_configured", message: "The AI service is not configured. Please try again later." };
  }
  const deadline = Date.now() + overallTimeoutMs;
  for (const provider of providers) {
    const remaining = Math.min(Number(provider.timeoutMs) || 12000, deadline - Date.now());
    if (remaining <= 0) break;
    let result;
    try {
      if (provider.id === "gemini") {
        const config = await loadGeminiConfigSafely();
        const apiKey = String(config?.apiKey || process.env.GEMINI_API_KEY || "").trim();
        const configuredModel = normalizeModelId(provider.model);
        const model = GEMINI_MODELS.includes(configuredModel) ? configuredModel : DEFAULT_GEMINI_MODEL;
        if (!apiKey || !model) result = { ok: false, status: "provider_not_configured" };
        else {
          const client = createGeminiClient(apiKey);
          const response = await withTimeout(() => client.models.generateContent({ model, contents: messages.slice(-12).map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] })), config: { systemInstruction, temperature, maxOutputTokens } }), remaining);
          const content = String(response?.text || "").trim();
          result = content ? { ok: true, provider: "gemini", model, content, usage: null } : { ok: false, status: "provider_unavailable" };
        }
      } else {
        const config = await loadProviderTestConfig(provider.id, db);
        result = await generateWithAiProvider(provider.id, { ...config, messages, systemInstruction, maxOutputTokens, temperature, timeoutMs: remaining, fetchImpl });
      }
    } catch (error) {
      result = { ok: false, status: provider.id === "gemini" ? normalizeGeminiError(error) : (error?.status === "provider_timeout" || error?.message === "provider_timeout" ? "provider_timeout" : "provider_unavailable") };
    }
    if (result?.ok) return result;
    if (!RETRYABLE_FAILURES.has(result?.status)) break;
  }
  return SAFE_FAILURE;
}

export { RETRYABLE_FAILURES };

const instanceConcurrency = new Map();
const routingStrategies = new Set(["adaptive_parallel", "sequential_fallback", "full_parallel"]);
function eligibleInstances(instances) {
  return (instances || []).filter((instance) => instance.enabled && instance.routingEnabled && instance.configured && instance.modelId && instance.healthState !== "configuration_problem" && (!instance.cooldownUntil || new Date(instance.cooldownUntil).getTime() <= Date.now()));
}
function takeSlot(instance) {
  const current = instanceConcurrency.get(instance.id) || 0;
  if (instance.maxConcurrency && current >= instance.maxConcurrency) return false;
  instanceConcurrency.set(instance.id, current + 1);
  return true;
}
function releaseSlot(instance) { const next = (instanceConcurrency.get(instance.id) || 1) - 1; if (next > 0) instanceConcurrency.set(instance.id, next); else instanceConcurrency.delete(instance.id); }
function resultFor(instance, result, startedAt, winner = false) {
  return { ...result, providerType: instance.providerType, providerInstanceId: instance.id, displayName: instance.displayName, model: result.model || instance.modelId, latencyMs: Date.now() - startedAt, winner };
}
async function executeInstance(instance, options) {
  if (!takeSlot(instance)) return resultFor(instance, { ok: false, status: "provider_concurrency_limit", retryable: true }, Date.now());
  const startedAt = Date.now();
  const controller = new AbortController();
  options.registerController?.(instance.id, controller);
  const timer = setTimeout(() => controller.abort(), Math.min(instance.timeoutMs || 12000, options.remainingMs));
  try {
    const credentials = (await options.loadInstance(instance.id, { includeCredentials: true })).credentials || {};
    let result;
    if (instance.providerType === "gemini") {
      const apiKey = String(credentials.apiKey || "").trim();
      if (!apiKey) result = { ok: false, status: "provider_not_configured" };
      else {
        const model = normalizeModelId(instance.modelId);
        const client = options.createGeminiClient(apiKey);
        const response = await client.models.generateContent({ model, contents: options.messages.slice(-12).map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] })), config: { systemInstruction: options.systemInstruction, temperature: options.temperature, maxOutputTokens: options.maxOutputTokens }, signal: controller.signal });
        const content = String(response?.text || "").trim();
        result = content ? { ok: true, provider: "gemini", model, content, usage: null } : { ok: false, status: "provider_unavailable" };
      }
    } else {
      result = await generateWithAiProvider(instance.providerType, { credentials, model: instance.modelId, timeoutMs: Math.min(instance.timeoutMs || 12000, options.remainingMs), providerConfig: instance.providerConfig, messages: options.messages, systemInstruction: options.systemInstruction, maxOutputTokens: options.maxOutputTokens, temperature: options.temperature, fetchImpl: options.fetchImpl, signal: controller.signal });
    }
    await options.updateHealth(instance.id, { ok: Boolean(result?.ok), failureStatus: result?.status }).catch(() => undefined);
    const normalized = resultFor(instance, result, startedAt);
    options.trace?.({ request_id: options.requestId, provider_instance_id: instance.id, provider_type: instance.providerType, display_name: instance.displayName, model: instance.modelId, latency_ms: normalized.latencyMs, result_status: normalized.ok ? "success" : normalized.status, winner: false, aborted_after_winner: normalized.status === "provider_timeout" });
    return normalized;
  } catch (error) {
    const status = error?.name === "AbortError" || error?.message === "provider_timeout" ? "provider_timeout" : "provider_unavailable";
    await options.updateHealth(instance.id, { ok: false, failureStatus: status }).catch(() => undefined);
    return resultFor(instance, { ok: false, status }, startedAt);
  } finally { clearTimeout(timer); options.unregisterController?.(instance.id); releaseSlot(instance); }
}
function rotatePeers(instances) {
  const grouped = new Map();
  for (const instance of instances) { if (!grouped.has(instance.providerType)) grouped.set(instance.providerType, []); grouped.get(instance.providerType).push(instance); }
  const rotation = Number(globalThis.__abdraboGeminiRotation || 0);
  globalThis.__abdraboGeminiRotation = rotation + 1;
  for (const [type, group] of grouped) if (group.length > 1) { const offset = type === "gemini" ? rotation % group.length : 0; grouped.set(type, [...group.slice(offset), ...group.slice(0, offset)]); }
  return [...grouped.values()].flat().sort((a, b) => (a.priority - b.priority) || (a.providerType === "gemini" ? -1 : 1));
}
function chooseWaves(instances) {
  const ordered = rotatePeers(instances);
  const first = [];
  const second = [];
  const seenTypes = new Set();
  for (const instance of ordered) { if (!seenTypes.has(instance.providerType) && first.length < 2) { first.push(instance); seenTypes.add(instance.providerType); } else second.push(instance); }
  return [first, second];
}
export async function generateWithRouting({ messages, systemInstruction, maxOutputTokens = 320, temperature = 0.55, db, loadProviderInstances = listAiProviderInstances, loadInstance = getAiProviderInstance, updateHealth = updateAiProviderHealth, loadRoutingStrategy = async () => "adaptive_parallel", loadGeminiConfig = getGeminiConfig, loadProviderStatuses = getAiProviderStatuses, loadProviderTestConfig = getAiProviderTestConfig, createGeminiClient, fetchImpl = fetch, overallTimeoutMs = 45_000, requestId = randomUUID(), trace = (event) => console.info("ai_provider_attempt", event) } = {}) {
  let instances;
  try { instances = eligibleInstances(await loadProviderInstances({ db, eligibleOnly: true })); } catch (_error) { instances = []; }
  if (!instances.length) return generateWithFailover({ messages, systemInstruction, maxOutputTokens, temperature, db, loadGeminiConfig, loadProviderStatuses, loadProviderTestConfig, createGeminiClient, fetchImpl, overallTimeoutMs });
  const strategyValue = await loadRoutingStrategy(db).catch(() => "adaptive_parallel");
  const strategy = routingStrategies.has(strategyValue) ? strategyValue : "adaptive_parallel";
  const deadline = Date.now() + overallTimeoutMs;
  const execute = (instance) => executeInstance(instance, { messages, systemInstruction, maxOutputTokens, temperature, createGeminiClient, fetchImpl, loadInstance, updateHealth, requestId, trace, remainingMs: Math.max(1, deadline - Date.now()) });
  const valid = (result) => Boolean(result?.ok && String(result.content || result.text || "").trim());
  let results = [];
  if (strategy === "sequential_fallback") {
    for (const instance of rotatePeers(instances)) { const result = await execute(instance); results.push(result); if (valid(result)) { trace({ request_id: requestId, provider_instance_id: result.providerInstanceId, provider_type: result.providerType, display_name: result.displayName, model: result.model, latency_ms: result.latencyMs, result_status: "success", winner: true, aborted_after_winner: false }); return result; } }
  } else {
    const [waveOne, waveTwo] = strategy === "full_parallel" ? [rotatePeers(instances), []] : chooseWaves(instances);
    const runWave = (wave) => new Promise((resolve) => {
      if (!wave.length) return resolve({ results: [], winner: null });
      let settled = 0; const waveResults = []; const controllers = new Map();
      const finish = (value) => { if (value.winner) for (const [id, controller] of controllers) if (id !== value.winner.providerInstanceId) controller.abort(); resolve(value); };
      wave.forEach((instance) => executeInstance(instance, { messages, systemInstruction, maxOutputTokens, temperature, createGeminiClient, fetchImpl, loadInstance, updateHealth, requestId, trace, remainingMs: Math.max(1, deadline - Date.now()), registerController: (id, controller) => controllers.set(id, controller), unregisterController: (id) => controllers.delete(id) }).then((result) => { waveResults.push(result); settled += 1; if (valid(result)) finish({ results: waveResults, winner: result }); else if (settled === wave.length) finish({ results: waveResults, winner: null }); }).catch(() => { settled += 1; if (settled === wave.length) finish({ results: waveResults, winner: null }); }));
    });
    const firstWave = await runWave(waveOne); results = firstWave.results;
    if (firstWave.winner) { trace({ request_id: requestId, provider_instance_id: firstWave.winner.providerInstanceId, provider_type: firstWave.winner.providerType, display_name: firstWave.winner.displayName, model: firstWave.winner.model, latency_ms: firstWave.winner.latencyMs, result_status: "success", winner: true, aborted_after_winner: false }); return { ...firstWave.winner, winner: true }; }
    if (waveTwo.length && Date.now() < deadline) { const delay = Math.min(...waveOne.map((instance) => instance.hedgeDelayMs || 500), Math.max(0, deadline - Date.now())); if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay)); const secondWave = await runWave(waveTwo); results = results.concat(secondWave.results); if (secondWave.winner) { trace({ request_id: requestId, provider_instance_id: secondWave.winner.providerInstanceId, provider_type: secondWave.winner.providerType, display_name: secondWave.winner.displayName, model: secondWave.winner.model, latency_ms: secondWave.winner.latencyMs, result_status: "success", winner: true, aborted_after_winner: false }); return { ...secondWave.winner, winner: true }; } }
    const winnerAfterHedge = results.find(valid);
    if (winnerAfterHedge) return { ...winnerAfterHedge, winner: true };
  }
  return { ...SAFE_FAILURE, status: results.some((result) => result.status === "provider_timeout") ? "provider_timeout" : "provider_unavailable", attempts: results.map(({ providerInstanceId, providerType, status, latencyMs }) => ({ providerInstanceId, providerType, status, latencyMs })) };
}
