import { DEFAULT_GEMINI_MODEL, GEMINI_MODELS, getGeminiConfig } from "./geminiConfig.js";
import { getAiProviderStatuses, getAiProviderTestConfig } from "./aiProviderRegistry.js";
import { generateWithAiProvider } from "./aiProviderAdapters.js";

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
  if (!providers.length) return { ...SAFE_FAILURE, status: "provider_not_configured", message: "The AI service is not configured. Please try again later." };
  const deadline = Date.now() + overallTimeoutMs;
  for (const provider of providers) {
    const remaining = Math.min(Number(provider.timeoutMs) || 12000, deadline - Date.now());
    if (remaining <= 0) break;
    let result;
    try {
      if (provider.id === "gemini") {
        const config = await loadGeminiConfigSafely();
        const apiKey = String(config?.apiKey || process.env.GEMINI_API_KEY || "").trim();
        const model = GEMINI_MODELS.includes(provider.model) ? provider.model : DEFAULT_GEMINI_MODEL;
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
