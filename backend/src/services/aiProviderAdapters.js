const JSON_HEADERS = { "Content-Type": "application/json" };

export const PROVIDER_OUTCOMES = Object.freeze({
  SUCCESS: "SUCCESS",
  AUTHENTICATION_ERROR: "AUTHENTICATION_ERROR",
  PERMISSION_ERROR: "PERMISSION_ERROR",
  MODEL_UNAVAILABLE: "MODEL_UNAVAILABLE",
  RATE_LIMITED: "RATE_LIMITED",
  TIMEOUT: "TIMEOUT",
  UPSTREAM_UNAVAILABLE: "UPSTREAM_UNAVAILABLE",
  INVALID_CONFIGURATION: "INVALID_CONFIGURATION",
  UNKNOWN_PROVIDER_ERROR: "UNKNOWN_PROVIDER_ERROR"
});

const LEGACY_STATUS = Object.freeze({
  SUCCESS: "success",
  AUTHENTICATION_ERROR: "provider_auth_failed",
  PERMISSION_ERROR: "provider_permission_denied",
  MODEL_UNAVAILABLE: "provider_model_unavailable",
  RATE_LIMITED: "provider_rate_limited",
  TIMEOUT: "provider_timeout",
  UPSTREAM_UNAVAILABLE: "provider_unavailable",
  INVALID_CONFIGURATION: "provider_not_configured",
  UNKNOWN_PROVIDER_ERROR: "provider_unknown_error"
});

const OUTCOME_MESSAGES = Object.freeze({
  SUCCESS: "Connection successful.",
  AUTHENTICATION_ERROR: "The provider credentials were rejected.",
  PERMISSION_ERROR: "The provider credentials do not have the required permissions.",
  MODEL_UNAVAILABLE: "This model is listed by the provider but is not available for generation with these credentials. Choose another discovered model.",
  RATE_LIMITED: "The provider is temporarily rate limited.",
  TIMEOUT: "The provider connection timed out.",
  UPSTREAM_UNAVAILABLE: "The provider is temporarily unavailable.",
  INVALID_CONFIGURATION: "The provider configuration is incomplete or invalid.",
  UNKNOWN_PROVIDER_ERROR: "The provider returned an unexpected error."
});

const RETRYABLE_OUTCOMES = new Set([PROVIDER_OUTCOMES.RATE_LIMITED, PROVIDER_OUTCOMES.TIMEOUT, PROVIDER_OUTCOMES.UPSTREAM_UNAVAILABLE]);

function outcomeMessageKey(type) { return `provider_${String(type).toLowerCase()}`; }

export function normalizeModelId(rawModel) {
  return String(rawModel ?? "").trim().replace(/^models\//, "");
}

function sanitizeUpstreamText(value) {
  return String(value || "")
    .replace(/(?:api[_-]?key|key|token|authorization|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/([?&](?:key|api_key|token|access_token)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .slice(0, 240);
}

function safeUpstreamMetadata(payload) {
  const error = payload?.error && typeof payload.error === "object" ? payload.error : payload;
  return {
    upstreamCode: Number(error?.code || error?.status || payload?.code || 0) || null,
    upstreamMessage: sanitizeUpstreamText(error?.message || payload?.message || "") || null
  };
}

export function normalizeProviderError(error = {}, context = {}) {
  const rawType = String(error.type || context.type || "").toUpperCase();
  const status = Number(error.providerStatus ?? error.status ?? context.providerStatus) || null;
  let type = Object.prototype.hasOwnProperty.call(PROVIDER_OUTCOMES, rawType) ? rawType : "";
  if (!type) {
    if (error?.name === "AbortError" || context.timeout) type = PROVIDER_OUTCOMES.TIMEOUT;
    else if (status === 401) type = PROVIDER_OUTCOMES.AUTHENTICATION_ERROR;
    else if (status === 403) type = PROVIDER_OUTCOMES.PERMISSION_ERROR;
    else if (status === 400 || status === 404 || status === 422) type = PROVIDER_OUTCOMES.MODEL_UNAVAILABLE;
    else if (status === 429) type = PROVIDER_OUTCOMES.RATE_LIMITED;
    else if (status >= 500) type = PROVIDER_OUTCOMES.UPSTREAM_UNAVAILABLE;
    else if (context.configuration) type = PROVIDER_OUTCOMES.INVALID_CONFIGURATION;
    else type = PROVIDER_OUTCOMES.UPSTREAM_UNAVAILABLE;
  }
  const upstreamMessage = [PROVIDER_OUTCOMES.AUTHENTICATION_ERROR, PROVIDER_OUTCOMES.PERMISSION_ERROR].includes(type)
    ? ""
    : sanitizeUpstreamText(error.upstreamMessage ?? context.upstreamMessage);
  return {
    type,
    retryable: RETRYABLE_OUTCOMES.has(type),
    providerStatus: status,
    upstreamCode: Number(error.upstreamCode ?? context.upstreamCode) || null,
    upstreamMessage,
    messageKey: outcomeMessageKey(type),
    status: LEGACY_STATUS[type],
    message: OUTCOME_MESSAGES[type]
  };
}

function normalizedFailure(provider, type, context = {}) {
  const normalized = normalizeProviderError({ type, providerStatus: context.providerStatus, upstreamCode: context.upstreamCode, upstreamMessage: context.upstreamMessage }, context);
  return { ok: false, provider, accessStatus: normalized.type === PROVIDER_OUTCOMES.MODEL_UNAVAILABLE ? "unavailable" : "unknown", ...normalized };
}

function normalizedSuccess(provider, model) {
  const normalizedModel = provider === "gemini" ? normalizeModelId(model) : model;
  return { ok: true, provider, model: normalizedModel, accessStatus: "verified", type: PROVIDER_OUTCOMES.SUCCESS, retryable: false, providerStatus: 200, messageKey: outcomeMessageKey(PROVIDER_OUTCOMES.SUCCESS), status: LEGACY_STATUS.SUCCESS, message: OUTCOME_MESSAGES.SUCCESS };
}

function isClearlyNonAssistantModel(value) {
  return /(embedding|embed|bge-|distilbert|rerank|resnet|stable-diffusion|inpainting|whisper|flux-|sdxl|llava-hf|moderation|classifier|guard)/i.test(String(value || ""));
}

function normalizeCapabilities(provider, model) {
  const methods = Array.isArray(model?.supportedGenerationMethods) ? model.supportedGenerationMethods.map(String) : [];
  const rawCapabilities = model?.capabilities && typeof model.capabilities === "object" ? model.capabilities : {};
  const task = String(model?.task || model?.kind || "").toLowerCase();
  const explicitTextGeneration = typeof rawCapabilities.textGeneration === "boolean" ? rawCapabilities.textGeneration : undefined;
  const hasGenerationMethod = methods.length ? methods.some((method) => /generatecontent|chat|textgeneration|text-generation|completion/i.test(method)) : undefined;
  const taskSupportsText = task ? /text|chat|generation|conversational|language/i.test(task) && !/embedding|rerank|image|audio|moderation|classif/i.test(task) : undefined;
  return {
    textGeneration: explicitTextGeneration ?? hasGenerationMethod ?? taskSupportsText ?? !isClearlyNonAssistantModel(model?.id || model?.name),
    chat: typeof rawCapabilities.chat === "boolean" ? rawCapabilities.chat : hasGenerationMethod ?? taskSupportsText,
    embeddings: Boolean(rawCapabilities.embeddings || /embedding|embed/i.test(String(model?.id || model?.name || ""))),
    imageGeneration: Boolean(rawCapabilities.imageGeneration || /image|stable-diffusion|flux|sdxl/i.test(String(model?.id || model?.name || ""))),
    audio: Boolean(rawCapabilities.audio || /audio|whisper/i.test(String(model?.id || model?.name || ""))),
    moderation: Boolean(rawCapabilities.moderation || /moderation|guard|classifier/i.test(String(model?.id || model?.name || ""))),
    reranking: Boolean(rawCapabilities.reranking || /rerank/i.test(String(model?.id || model?.name || ""))),
    provider,
    supportedGenerationMethods: methods
  };
}

function isAssistantCompatibleModel(provider, model, capabilities) {
  if (provider === "gemini") {
    return capabilities.supportedGenerationMethods.includes("generateContent") && !/(embedding|embed|tts|image|audio|moderation|experimental)/i.test(String(model?.id || model?.name || ""));
  }
  return capabilities.textGeneration && !capabilities.embeddings && !capabilities.imageGeneration && !capabilities.audio && !capabilities.moderation && !capabilities.reranking;
}

function geminiModelRank(model) {
  const id = String(model?.id || "").toLowerCase();
  const version = id.match(/gemini-(\d+)(?:\.(\d+))?/);
  const versionScore = version ? Number(version[1]) * 100 + Number(version[2] || 0) : 0;
  const stable = !/(latest|preview|experimental|alpha|beta|deprecated|legacy)/i.test(id);
  const flash = /(?:^|-)flash(?:-|$)/i.test(id);
  const lite = /(?:^|-)lite(?:-|$)/i.test(id);
  const restrictedFamily = /(?:pro-vision|vision|tts|audio|embedding|embed|image|moderation|ultra)/i.test(id);
  return versionScore
    + (stable ? 500 : -500)
    + (flash ? 250 : 100)
    + (lite ? -20 : 0)
    - (restrictedFamily ? 800 : 0);
}

function rankDiscoveredModels(provider, models) {
  const ranked = [...models].sort((left, right) => {
    const score = provider === "gemini" ? geminiModelRank : (model) => (model.recommended ? 1 : 0);
    return score(right) - score(left) || left.id.localeCompare(right.id);
  });
  const best = ranked[0];
  return models.map((model) => ({ ...model, recommended: Boolean(best && model.id === best.id && (provider !== "gemini" || geminiModelRank(best) > 0)) }));
}

function normalizeDiscoveredModels(provider, payload) {
  const raw = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : Array.isArray(payload?.result) ? payload.result : [];
  const normalized = raw.map((model) => {
    const id = normalizeModelId(model?.id || model?.name);
    if (!id) return null;
    const capabilities = normalizeCapabilities(provider, { ...model, id });
    if (!isAssistantCompatibleModel(provider, { ...model, id }, capabilities)) return null;
    const aliasOrExperimental = /(?:latest|preview|experimental|tts)/i.test(id);
    return { id, displayName: normalizeModelId(model?.displayName || model?.name || id), capabilities, compatibleWithAssistant: true, accessStatus: "unknown", contextWindow: Number(model?.contextWindow || model?.context_length || 0) || null, recommended: !aliasOrExperimental && /flash|llama-3\.1-8b|mixtral|small/i.test(id) };
  }).filter(Boolean).slice(0, 200);
  return rankDiscoveredModels(provider, normalized);
}

function discoveryFailure(provider, type, { discoveredAccounts = [], latencyMs = 0, upstreamCode = null, upstreamMessage = null } = {}) {
  const normalized = normalizeProviderError({ type, upstreamCode, upstreamMessage });
  return { valid: false, providerType: provider, models: [], discoveredAccounts, warnings: [normalized.message], errorType: normalized.status, outcomeType: normalized.type, messageKey: normalized.messageKey, upstreamCode: normalized.upstreamCode, upstreamMessage: normalized.upstreamMessage, latencyMs };
}

export async function discoverAiProvider(provider, { credentials = {}, providerConfig = {}, fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  const startedAt = Date.now();
  const apiKey = credentials.apiKey;
  const token = credentials.apiToken;
  const headers = { ...JSON_HEADERS, Authorization: `Bearer ${apiKey || token || ""}` };
  let url;
  let discoveredAccounts = [];
  if (provider === "cloudflare" && !providerConfig.accountId) {
    const accountController = new AbortController();
    const accountTimer = setTimeout(() => accountController.abort(), timeoutMs);
    try {
      const accountResponse = await fetchImpl("https://api.cloudflare.com/client/v4/accounts?page=1&per_page=50", { headers, signal: accountController.signal });
      const accountPayload = await accountResponse.json().catch(() => ({}));
      if (!accountResponse.ok) { const metadata = safeUpstreamMetadata(accountPayload); return discoveryFailure(provider, normalizeProviderError({ providerStatus: accountResponse.status, ...metadata }).type, { ...metadata, latencyMs: Date.now() - startedAt }); }
      discoveredAccounts = (accountPayload?.result || []).map((account) => ({ id: String(account?.id || ""), displayName: String(account?.name || account?.id || "") })).filter((account) => account.id);
      if (discoveredAccounts.length !== 1) return { valid: true, providerType: provider, models: [], discoveredAccounts, discoveredConfig: {}, warnings: discoveredAccounts.length ? ["Select a Cloudflare account before discovering models."] : ["No accessible Cloudflare accounts were found."], latencyMs: Date.now() - startedAt };
      providerConfig = { ...providerConfig, accountId: discoveredAccounts[0].id };
    } catch (error) { return discoveryFailure(provider, error?.name === "AbortError" ? "TIMEOUT" : "UPSTREAM_UNAVAILABLE", { latencyMs: Date.now() - startedAt }); }
    finally { clearTimeout(accountTimer); }
  }
  if (provider === "gemini") {
    url = "https://generativelanguage.googleapis.com/v1beta/models";
    headers["x-goog-api-key"] = apiKey || "";
    delete headers.Authorization;
  } else if (provider === "cloudflare") {
    if (!providerConfig.accountId) return discoveryFailure(provider, "INVALID_CONFIGURATION", { latencyMs: Date.now() - startedAt });
    url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(providerConfig.accountId)}/ai/models/search?per_page=100`;
  } else {
    url = provider === "groq" ? "https://api.groq.com/openai/v1/models" : provider === "mistral" ? "https://api.mistral.ai/v1/models" : "https://openrouter.ai/api/v1/models";
    if (provider === "openrouter") headers["HTTP-Referer"] = "https://abdrabo.online/";
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { headers, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const metadata = safeUpstreamMetadata(payload);
      return discoveryFailure(provider, normalizeProviderError({ providerStatus: response.status, ...metadata }).type, { discoveredAccounts, ...metadata, latencyMs: Date.now() - startedAt });
    }
    const models = normalizeDiscoveredModels(provider, provider === "cloudflare" ? { data: payload?.result } : provider === "gemini" ? { models: payload?.models } : payload);
    return { valid: true, providerType: provider, discoveredAccounts, models, discoveredConfig: provider === "cloudflare" ? { accountId: providerConfig.accountId } : {}, warnings: models.length ? [] : ["No compatible models were returned."], latencyMs: Date.now() - startedAt };
  } catch (error) {
    return discoveryFailure(provider, error?.name === "AbortError" ? "TIMEOUT" : "UPSTREAM_UNAVAILABLE", { latencyMs: Date.now() - startedAt });
  } finally { clearTimeout(timer); }
}

function requestFor(provider, model, credentials, providerConfig) {
  return generationRequestFor(provider, { messages: [{ role: "user", content: "ping" }], systemInstruction: "", model, maxOutputTokens: 1, temperature: 0, credentials, providerConfig });
}

function generationRequestFor(provider, { messages, systemInstruction, model, maxOutputTokens, temperature, credentials, providerConfig }) {
  const normalizedModel = provider === "gemini" ? normalizeModelId(model) : model;
  const normalizedMessages = [{ role: "system", content: systemInstruction }, ...messages.map((message) => ({ role: message.role === "assistant" ? "assistant" : "user", content: message.content }))];
  if (provider === "cloudflare") return { url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(providerConfig.accountId)}/ai/run/${model}`, headers: { ...JSON_HEADERS, Authorization: `Bearer ${credentials.apiToken}` }, body: { messages: normalizedMessages } };
  if (provider === "gemini") return { url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(normalizedModel)}:generateContent`, headers: { ...JSON_HEADERS, "x-goog-api-key": credentials.apiKey }, body: { contents: normalizedMessages.filter((message) => message.content).map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: [{ text: message.content }] })), generationConfig: { maxOutputTokens, temperature } } };
  const base = provider === "groq" ? "https://api.groq.com/openai/v1/chat/completions" : provider === "mistral" ? "https://api.mistral.ai/v1/chat/completions" : "https://openrouter.ai/api/v1/chat/completions";
  const headers = { ...JSON_HEADERS, Authorization: `Bearer ${credentials.apiKey}` };
  if (provider === "openrouter") headers["HTTP-Referer"] = "https://abdrabo.online/";
  return { url: base, headers, body: { model, messages: normalizedMessages, max_tokens: maxOutputTokens, temperature } };
}

function responseContent(provider, payload) {
  if (provider === "cloudflare") return typeof payload?.result?.response === "string" ? payload.result.response : payload?.result?.response?.content;
  if (provider === "gemini") return payload?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("");
  return payload?.choices?.[0]?.message?.content || payload?.choices?.[0]?.text;
}

export async function generateWithAiProvider(provider, { credentials = {}, model, timeoutMs = 12000, providerConfig = {}, messages = [], systemInstruction = "", maxOutputTokens = 320, temperature = 0.55, fetchImpl = fetch, signal = null } = {}) {
  if (!model) return normalizedFailure(provider, PROVIDER_OUTCOMES.INVALID_CONFIGURATION, { configuration: true });
  const needsToken = provider === "cloudflare";
  if (needsToken ? (!providerConfig.accountId || !credentials.apiToken) : !credentials.apiKey) return normalizedFailure(provider, PROVIDER_OUTCOMES.INVALID_CONFIGURATION, { configuration: true });
  const request = generationRequestFor(provider, { messages, systemInstruction, model, maxOutputTokens, temperature, credentials, providerConfig });
  const controller = new AbortController();
  const abortFromCaller = signal ? () => controller.abort() : null;
  if (signal) signal.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(request.body), signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) { const metadata = safeUpstreamMetadata(payload); return normalizedFailure(provider, normalizeProviderError({ providerStatus: response.status, ...metadata }).type, { providerStatus: response.status, ...metadata }); }
    const content = String(responseContent(provider, payload) || "").trim();
    if (!content) return normalizedFailure(provider, PROVIDER_OUTCOMES.UPSTREAM_UNAVAILABLE);
    return { ok: true, provider, model: provider === "gemini" ? normalizeModelId(model) : model, content, usage: payload?.usage || null };
  } catch (error) {
    if (error?.name === "AbortError") return normalizedFailure(provider, PROVIDER_OUTCOMES.TIMEOUT, { timeout: true });
    return normalizedFailure(provider, PROVIDER_OUTCOMES.UPSTREAM_UNAVAILABLE);
  } finally { clearTimeout(timeout); if (signal && abortFromCaller) signal.removeEventListener("abort", abortFromCaller); }
}

export async function testAiProviderConnection(provider, { credentials = {}, model, timeoutMs = 12000, providerConfig = {}, fetchImpl = fetch } = {}) {
  if (!model) return normalizedFailure(provider, PROVIDER_OUTCOMES.INVALID_CONFIGURATION, { configuration: true });
  const needsToken = provider === "cloudflare";
  if (needsToken ? (!providerConfig.accountId || !credentials.apiToken) : !credentials.apiKey) return normalizedFailure(provider, PROVIDER_OUTCOMES.INVALID_CONFIGURATION, { configuration: true });
  const request = requestFor(provider, model, credentials, providerConfig);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(request.body), signal: controller.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) { const metadata = safeUpstreamMetadata(payload); return normalizedFailure(provider, normalizeProviderError({ providerStatus: response.status, ...metadata }).type, { providerStatus: response.status, ...metadata }); }
    return normalizedSuccess(provider, model);
  } catch (error) {
    if (error?.name === "AbortError") return normalizedFailure(provider, PROVIDER_OUTCOMES.TIMEOUT, { timeout: true });
    return normalizedFailure(provider, PROVIDER_OUTCOMES.UPSTREAM_UNAVAILABLE);
  } finally { clearTimeout(timeout); }
}
