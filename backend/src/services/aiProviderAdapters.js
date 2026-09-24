const JSON_HEADERS = { "Content-Type": "application/json" };

function normalizedFailure(provider, status, message) { return { ok: false, provider, status, message }; }
function classifyStatus(status) {
  if (status === 401 || status === 403) return "provider_auth_failed";
  if (status === 429) return "provider_rate_limited";
  if (status === 400 || status === 404) return "provider_model_unavailable";
  return "provider_unavailable";
}
function safeMessage(status) {
  return status === "provider_auth_failed" ? "The provider credentials were rejected." : status === "provider_rate_limited" ? "The provider is temporarily rate limited." : status === "provider_model_unavailable" ? "The configured model is unavailable." : "The provider is temporarily unavailable.";
}
function requestFor(provider, model, credentials, providerConfig) {
  const message = [{ role: "user", content: "ping" }];
  if (provider === "cloudflare") return { url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(providerConfig.accountId)}/ai/run/${model}`, headers: { ...JSON_HEADERS, Authorization: `Bearer ${credentials.apiToken}` }, body: { messages: message } };
  const base = provider === "groq" ? "https://api.groq.com/openai/v1/chat/completions" : provider === "mistral" ? "https://api.mistral.ai/v1/chat/completions" : "https://openrouter.ai/api/v1/chat/completions";
  const headers = { ...JSON_HEADERS, Authorization: `Bearer ${credentials.apiKey}` };
  if (provider === "openrouter") headers["HTTP-Referer"] = "https://abdrabo.online/";
  return { url: base, headers, body: { model, messages: message, max_tokens: 1, temperature: 0 } };
}

function generationRequestFor(provider, { messages, systemInstruction, model, maxOutputTokens, temperature, credentials, providerConfig }) {
  const normalizedMessages = [{ role: "system", content: systemInstruction }, ...messages.map((message) => ({ role: message.role === "assistant" ? "assistant" : "user", content: message.content }))];
  if (provider === "cloudflare") return { url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(providerConfig.accountId)}/ai/run/${model}`, headers: { ...JSON_HEADERS, Authorization: `Bearer ${credentials.apiToken}` }, body: { messages: normalizedMessages } };
  const base = provider === "groq" ? "https://api.groq.com/openai/v1/chat/completions" : provider === "mistral" ? "https://api.mistral.ai/v1/chat/completions" : "https://openrouter.ai/api/v1/chat/completions";
  const headers = { ...JSON_HEADERS, Authorization: `Bearer ${credentials.apiKey}` };
  if (provider === "openrouter") headers["HTTP-Referer"] = "https://abdrabo.online/";
  return { url: base, headers, body: { model, messages: normalizedMessages, max_tokens: maxOutputTokens, temperature } };
}

function responseContent(provider, payload) {
  if (provider === "cloudflare") return typeof payload?.result?.response === "string" ? payload.result.response : payload?.result?.response?.content;
  return payload?.choices?.[0]?.message?.content || payload?.choices?.[0]?.text;
}

export async function generateWithAiProvider(provider, { credentials = {}, model, timeoutMs = 12000, providerConfig = {}, messages = [], systemInstruction = "", maxOutputTokens = 320, temperature = 0.55, fetchImpl = fetch } = {}) {
  if (!model) return normalizedFailure(provider, "provider_not_configured", "The provider model is not configured.");
  const needsToken = provider === "cloudflare";
  if (needsToken ? (!providerConfig.accountId || !credentials.apiToken) : !credentials.apiKey) return normalizedFailure(provider, "provider_not_configured", "The provider credentials are not configured.");
  const request = generationRequestFor(provider, { messages, systemInstruction, model, maxOutputTokens, temperature, credentials, providerConfig });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(request.body), signal: controller.signal });
    if (!response.ok) { const status = classifyStatus(response.status); return normalizedFailure(provider, status, safeMessage(status)); }
    const payload = await response.json().catch(() => ({}));
    const content = String(responseContent(provider, payload) || "").trim();
    if (!content) return normalizedFailure(provider, "provider_unavailable", "The provider returned an empty response.");
    return { ok: true, provider, model, content, usage: payload?.usage || null };
  } catch (error) {
    if (error?.name === "AbortError") return normalizedFailure(provider, "provider_timeout", "The provider generation timed out.");
    return normalizedFailure(provider, "provider_unavailable", "The provider is temporarily unavailable.");
  } finally { clearTimeout(timeout); }
}

export async function testAiProviderConnection(provider, { credentials = {}, model, timeoutMs = 12000, providerConfig = {}, fetchImpl = fetch } = {}) {
  if (!model) return normalizedFailure(provider, "provider_not_configured", "Select a model before testing the connection.");
  const needsToken = provider === "cloudflare";
  if (needsToken ? (!providerConfig.accountId || !credentials.apiToken) : !credentials.apiKey) return normalizedFailure(provider, "provider_not_configured", "Configure the provider credentials before testing the connection.");
  const request = requestFor(provider, model, credentials, providerConfig);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(request.body), signal: controller.signal });
    if (!response.ok) { const status = classifyStatus(response.status); return normalizedFailure(provider, status, safeMessage(status)); }
    return { ok: true, provider, model, message: "Connection successful." };
  } catch (error) {
    if (error?.name === "AbortError") return normalizedFailure(provider, "provider_timeout", "The provider connection timed out.");
    return normalizedFailure(provider, "provider_unavailable", "The provider is temporarily unavailable.");
  } finally { clearTimeout(timeout); }
}
