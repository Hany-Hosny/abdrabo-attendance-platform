import { useEffect, useMemo, useState } from "react";

type Language = "ar" | "en";
type Props = { token: string; language: Language };
type ProviderType = "gemini" | "groq" | "mistral" | "openrouter" | "cloudflare";
type Instance = { id: string; providerType: ProviderType; label: string; displayName: string; enabled: boolean; routingEnabled: boolean; configured: boolean; modelId: string | null; priority: number; timeoutMs: number; healthState: string; cooldownUntil: string | null; lastSuccessAt?: string | null; lastFailureAt?: string | null; providerConfig?: Record<string, string> };
type EditDraft = { displayName: string; modelId: string; priority: string; timeoutMs: string };
type ModelOption = { id: string; displayName?: string; recommended?: boolean; accessStatus?: "unknown" | "verified" | "unavailable" };
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_URL || "/api";
const TYPES: Array<{ id: ProviderType; label: string }> = [{ id: "gemini", label: "Google Gemini" }, { id: "groq", label: "Groq" }, { id: "mistral", label: "Mistral" }, { id: "openrouter", label: "OpenRouter" }, { id: "cloudflare", label: "Cloudflare Workers AI" }];
const strategies = ["adaptive_parallel", "sequential_fallback", "full_parallel"];

const strategyTitle = (value: string, ar: boolean) => {
  const labels: Record<string, [string, string]> = {
    adaptive_parallel: ["التوازي التكيفي", "Adaptive Parallel"],
    sequential_fallback: ["التوجيه الاحتياطي المتسلسل", "Sequential Fallback"],
    full_parallel: ["التوازي الكامل", "Full Parallel"]
  };
  return labels[value]?.[ar ? 0 : 1] || value;
};

const strategyDescription = (value: string, ar: boolean) => {
  const descriptions: Record<string, [string, string]> = {
    adaptive_parallel: ["الأفضل للتوازن بين السرعة واستهلاك الطلبات.", "Balances speed with request usage by sending providers in small waves."],
    sequential_fallback: ["يرسل الطلب لمزود واحد ثم ينتقل للآخر عند الفشل.", "Tries one provider, then falls back to the next when it fails."],
    full_parallel: ["يرسل الطلب لجميع المزودين المؤهلين في نفس الوقت.", "Sends the request to all eligible providers at the same time."]
  };
  return descriptions[value]?.[ar ? 0 : 1] || "";
};

const healthLabel = (value: string, ar: boolean) => {
  const labels: Record<string, [string, string]> = {
    unknown: ["لم يتم الاختبار", "Not tested"],
    healthy: ["سليم", "Healthy"],
    rate_limited: ["محدود مؤقتًا", "Rate limited"],
    temporarily_failed: ["مشكلة مؤقتة", "Temporary issue"],
    configuration_problem: ["يحتاج ضبط الإعدادات", "Configuration issue"],
    disabled: ["معطّل", "Disabled"]
  };
  return labels[value]?.[ar ? 0 : 1] || (ar ? "لم يتم الاختبار" : "Not tested");
};

const isSelectableModel = (model: { compatibleWithAssistant?: boolean; accessStatus?: string }) => model.compatibleWithAssistant === true && model.accessStatus !== "unavailable";

const modelOption = (providerType: ProviderType, model: any): ModelOption => {
  const rawId = String(model?.id || "");
  const displayName = String(model?.displayName || model?.name || rawId);
  const canonicalId = providerType === "cloudflare" && rawId.startsWith("cf/") ? `@${rawId}` : rawId;
  return { id: canonicalId || rawId, displayName, recommended: Boolean(model?.recommended), accessStatus: model?.accessStatus || "unknown" };
};

const testErrorLabel = (payload: any, ar: boolean) => {
  const labels: Record<string, [string, string]> = {
    provider_model_unavailable: ["هذا النموذج ظاهر في قائمة Gemini لكنه غير متاح للتوليد باستخدام بيانات الدخول الحالية. اختر نموذجًا مكتشفًا آخر ثم أعد الاختبار.", "This model is listed by Gemini but is not available for generation with these credentials. Choose another discovered model and test again."],
    provider_auth_failed: ["تعذر التحقق من بيانات اعتماد المزود.", "The provider credentials could not be verified."],
    provider_rate_limited: ["تم تجاوز حد الاستخدام مؤقتًا. حاول مرة أخرى لاحقًا.", "The provider is temporarily rate limited. Try again later."],
    provider_timeout: ["انتهت مهلة الاتصال بالمزود.", "The provider connection timed out."],
    provider_not_configured: ["إعدادات المزود أو النموذج غير مكتملة.", "The provider configuration or model is incomplete."],
    provider_permission_denied: ["بيانات الدخول صالحة، لكن الصلاحيات المطلوبة غير متاحة.", "The credentials are valid, but the required permissions are missing."],
    provider_unknown_error: ["حدث خطأ غير متوقع من المزود.", "The provider returned an unexpected error."]
  };
  const key = payload?.status || String(payload?.type || "").toLowerCase();
  return labels[key]?.[ar ? 0 : 1] || (ar ? "تعذر اختبار اتصال المزود حاليًا." : "The provider connection test failed.");
};

export function AiProviderInstancesPanel({ token, language }: Props) {
  const ar = language === "ar";
  const [instances, setInstances] = useState<Instance[]>([]);
  const [strategy, setStrategy] = useState("adaptive_parallel");
  const [adding, setAdding] = useState(false);
  const [type, setType] = useState<ProviderType>("gemini");
  const [name, setName] = useState("");
  const [credential, setCredential] = useState("");
  const [accountId, setAccountId] = useState("");
  const [discovered, setDiscovered] = useState<any>(null);
  const [accounts, setAccounts] = useState<Array<{ id: string; displayName: string }>>([]);
  const [modelId, setModelId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft>({ displayName: "", modelId: "", priority: "", timeoutMs: "" });
  const [editModels, setEditModels] = useState<ModelOption[]>([]);
  const [editModelsLoading, setEditModelsLoading] = useState(false);
  const [testError, setTestError] = useState<{ id: string; message: string } | null>(null);
  const [unavailableModels, setUnavailableModels] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const endpoint = `${API_BASE_URL}/admin/settings/advanced/ai`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const configuredCount = useMemo(() => instances.filter((item) => item.configured).length, [instances]);
  const routingCount = useMemo(() => instances.filter((item) => item.enabled && item.routingEnabled).length, [instances]);

  async function load() {
    const response = await fetch(`${endpoint}/instances`, { headers }); const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error(payload.status || "load_failed");
    setInstances(payload.providers || []); setStrategy(payload.routingStrategy || "adaptive_parallel");
  }
  useEffect(() => { void load().catch(() => setError(ar ? "تعذر تحميل مزودي الذكاء الاصطناعي." : "Could not load AI providers.")); }, [token]);
  function resetForm() { setCredential(""); setAccountId(""); setDiscovered(null); setAccounts([]); setModelId(""); setName(""); }
  async function discover() {
    if (!credential.trim()) { setError(ar ? "أدخل المفتاح أو الرمز أولًا." : "Enter a key or token first."); return; }
    setBusy("discover"); setError("");
    try { const response = await fetch(`${endpoint}/instances/discover`, { method: "POST", headers, body: JSON.stringify({ providerType: type, credentials: type === "cloudflare" ? { apiToken: credential.trim() } : { apiKey: credential.trim() }, providerConfig: type === "cloudflare" ? { accountId: accountId.trim() || undefined } : {} }) }); const payload = await response.json().catch(() => ({})); if (!response.ok || !payload.ok) throw new Error(payload.warnings?.[0] || "discovery_failed"); const models = Array.isArray(payload.models) ? payload.models.filter(isSelectableModel).map((model: any) => ({ ...model, ...modelOption(type, model) })) : []; setDiscovered({ ...payload, models }); setAccounts(payload.discoveredAccounts || []); setModelId(models.find((item: any) => item.recommended)?.id || models[0]?.id || ""); } catch (reason) { setError(reason instanceof Error ? reason.message : "Discovery failed."); } finally { setBusy(null); }
  }
  async function saveNew() {
    if (!discovered?.valid || !modelId) { setError(ar ? "اكتشف الإعدادات واختر نموذجًا أولًا." : "Discover configuration and choose a model first."); return; }
    setBusy("save"); setError("");
    try { const sameType = instances.filter((item) => item.providerType === type).length; const response = await fetch(`${endpoint}/instances`, { method: "POST", headers, body: JSON.stringify({ providerType: type, displayName: name.trim() || `${TYPES.find((item) => item.id === type)?.label || type} ${sameType + 1}`, enabled: true, routingEnabled: true, modelId, priority: (sameType + 1) * 10, credentials: type === "cloudflare" ? { apiToken: credential.trim() } : { apiKey: credential.trim() }, providerConfig: type === "cloudflare" ? { accountId: accountId.trim() } : {} }) }); const payload = await response.json().catch(() => ({})); if (!response.ok || !payload.ok) throw new Error(payload.status || "save_failed"); await load(); resetForm(); setAdding(false); setMessage(ar ? "تمت إضافة نسخة المزود بأمان." : "Provider instance added securely."); window.setTimeout(() => setMessage(""), 2200); } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not save provider."); } finally { setBusy(null); }
  }
  async function patch(id: string, value: Partial<Instance>) { setBusy(id); try { const response = await fetch(`${endpoint}/instances/${id}`, { method: "PATCH", headers, body: JSON.stringify(value) }); if (!response.ok) throw new Error("update_failed"); await load(); } catch (_error) { setError(ar ? "تعذر تحديث نسخة المزود." : "Could not update provider instance."); } finally { setBusy(null); } }
  async function loadEditModels(item: Instance) { const unavailable = unavailableModels[item.id]; setEditModels(item.modelId && item.modelId !== unavailable ? [{ id: item.modelId, displayName: item.modelId, accessStatus: "unknown" }] : []); setEditModelsLoading(true); try { const response = await fetch(`${endpoint}/instances/${item.id}/discover`, { method: "POST", headers }); const payload = await response.json().catch(() => ({})); if (!response.ok || !payload.ok) throw new Error("model_discovery_failed"); const models = Array.isArray(payload.models) ? payload.models.filter(isSelectableModel).map((model: any) => modelOption(item.providerType, model)).filter((model: ModelOption) => model.id !== unavailable) : []; setEditModels((current) => Array.from(new Map([...current, ...models].map((model) => [model.id, model])).values())); } catch (_error) { setError(ar ? "تعذر تحميل النماذج المتاحة لهذا المزود." : "Could not load available provider models."); } finally { setEditModelsLoading(false); } }
  function startEdit(item: Instance) { setEditingId(item.id); setOpenMenuId(null); setTestError(null); setError(""); setEditDraft({ displayName: item.displayName, modelId: unavailableModels[item.id] === item.modelId ? "" : (item.modelId || ""), priority: String(item.priority), timeoutMs: String(item.timeoutMs) }); void loadEditModels(item); }
  async function saveEdit(item: Instance) { const priority = Number(editDraft.priority); const timeoutMs = Number(editDraft.timeoutMs); if (!editDraft.displayName.trim() || !editDraft.modelId.trim() || !Number.isInteger(priority) || !Number.isInteger(timeoutMs)) { setError(ar ? "أكمل بيانات المزود بقيم صحيحة." : "Complete the provider details with valid values."); return; } await patch(item.id, { displayName: editDraft.displayName.trim(), modelId: editDraft.modelId.trim(), priority, timeoutMs }); setEditingId(null); }
  async function remove(item: Instance) { if (!window.confirm(ar ? `هل تريد حذف ${item.displayName}؟` : `Delete ${item.displayName}?`)) return; setBusy(item.id); try { const response = await fetch(`${endpoint}/instances/${item.id}`, { method: "DELETE", headers }); if (!response.ok) throw new Error("delete_failed"); await load(); } catch (_error) { setError(ar ? "تعذر حذف نسخة المزود." : "Could not delete provider instance."); } finally { setBusy(null); } }
  async function test(item: Instance) {
    setBusy(`test:${item.id}`); setError(""); setTestError(null); setMessage("");
    try {
      const response = await fetch(`${endpoint}/instances/${item.id}/test`, { method: "POST", headers });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw payload;
      setMessage(ar ? `تم الاتصال بـ ${item.displayName} بنجاح.` : `${item.displayName} connection succeeded.`);
    } catch (reason) {
      const failure = reason as { status?: string; type?: string };
      if (failure?.status === "provider_model_unavailable" || failure?.type === "MODEL_UNAVAILABLE") setUnavailableModels((current) => ({ ...current, [item.id]: item.modelId || "" }));
      setTestError({ id: item.id, message: testErrorLabel(reason, ar) });
    } finally {
      try { await load(); } catch (_error) { setError(ar ? "تعذر تحديث حالة المزود بعد الاختبار." : "Could not refresh provider state after testing."); }
      setBusy(null);
    }
  }
  async function saveStrategy(value: string) { setStrategy(value); await fetch(`${endpoint}/routing`, { method: "PATCH", headers, body: JSON.stringify({ strategy: value }) }); }

  return <section className="settings-section ai-providers-panel ai-provider-instances-panel" dir={ar ? "rtl" : "ltr"}>
    <div className="ai-providers-page-header">
      <div className="ai-providers-heading-copy"><span className="ai-providers-section-number">06</span><div><h3>{ar ? "مزودو الذكاء الاصطناعي" : "AI Providers"}</h3><p>{ar ? "إدارة مزودي الذكاء الاصطناعي ومسارات التوجيه." : "Manage AI providers and routing paths."}</p></div></div>
      <button className="primary-button compact-button ai-provider-add-button" type="button" onClick={() => { setAdding(true); setError(""); }}>{ar ? "+ إضافة مزود" : "+ Add Provider"}</button>
    </div>
    <div className="ai-provider-summary" aria-label={ar ? "ملخص المزودين" : "Provider summary"}><span><b>{instances.length}</b> {ar ? "مزودين" : "providers"}</span><span><b>{configuredCount}</b> {ar ? "مُعدّ" : "configured"}</span><span><b>{routingCount}</b> {ar ? "في التوجيه" : "in routing"}</span></div>
    <div className="ai-routing-row ai-routing-card"><div className="ai-routing-copy"><span className="ai-routing-eyebrow">{ar ? "استراتيجية التوجيه" : "Routing strategy"}</span><strong>{strategyTitle(strategy, ar)}</strong><p>{strategyDescription(strategy, ar)}</p></div><label className="system-setting-field ai-routing-select"><span>{ar ? "تغيير الاستراتيجية" : "Change strategy"}</span><select value={strategy} aria-label={ar ? "تغيير استراتيجية التوجيه" : "Change routing strategy"} onChange={(event) => void saveStrategy(event.target.value)}>{strategies.map((value) => <option key={value} value={value}>{strategyTitle(value, ar)} — {strategyDescription(value, ar)}</option>)}</select></label></div>
    {adding ? <div className="ai-provider-instance-form"><div className="ai-provider-fields"><label className="system-setting-field"><span>{ar ? "نوع المزود" : "Provider type"}</span><select value={type} onChange={(event) => { setType(event.target.value as ProviderType); resetForm(); }}>{TYPES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label><label className="system-setting-field"><span>{ar ? "اسم العرض (اختياري)" : "Display name (optional)"}</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder={`${TYPES.find((item) => item.id === type)?.label} ${instances.filter((item) => item.providerType === type).length + 1}`} /></label><label className="system-setting-field"><span>{type === "cloudflare" ? "API token" : "API key"}</span><input type="password" autoComplete="new-password" value={credential} onChange={(event) => setCredential(event.target.value)} /></label>{type === "cloudflare" && accounts.length > 1 ? <label className="system-setting-field"><span>{ar ? "حساب Cloudflare" : "Cloudflare account"}</span><select value={accountId} onChange={(event) => { setAccountId(event.target.value); setDiscovered(null); }}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.displayName}</option>)}</select></label> : type === "cloudflare" ? <label className="system-setting-field"><span>{ar ? "معرّف الحساب (عند الحاجة)" : "Account ID (if required)"}</span><input value={accountId} onChange={(event) => setAccountId(event.target.value)} /></label> : null}</div><div className="ai-provider-actions"><button className="secondary-button compact-button" type="button" disabled={busy === "discover"} onClick={() => void discover()}>{busy === "discover" ? (ar ? "جارٍ الاكتشاف..." : "Discovering...") : (ar ? "اكتشاف" : "Discover")}</button>{discovered?.models?.length ? <label className="system-setting-field"><span>{ar ? "النموذج المكتشف" : "Discovered model"}</span><select value={modelId} onChange={(event) => setModelId(event.target.value)}>{discovered.models.map((item: any) => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label> : null}<button className="primary-button compact-button" type="button" disabled={busy === "save"} onClick={() => void saveNew()}>{busy === "save" ? (ar ? "جارٍ الحفظ..." : "Saving...") : (ar ? "حفظ النسخة" : "Save instance")}</button><button className="secondary-button compact-button" type="button" onClick={() => { setAdding(false); resetForm(); }}>{ar ? "إلغاء" : "Cancel"}</button></div></div> : null}
    <div className="ai-provider-accordion-list">{instances.map((item) => <article className="ai-provider-card" key={item.id}><div className="ai-provider-card-heading"><div className="ai-provider-card-title"><h4>{item.displayName}</h4><span className="ai-provider-type">{item.label}</span></div><div className="ai-provider-card-menu"><button className="ai-provider-more-button" type="button" aria-expanded={openMenuId === item.id} aria-controls={`ai-provider-menu-${item.id}`} onClick={() => setOpenMenuId((current) => current === item.id ? null : item.id)}>{ar ? "المزيد" : "More"} ⋮</button>{openMenuId === item.id ? <div id={`ai-provider-menu-${item.id}`} className="ai-provider-more-menu" role="menu"><button type="button" role="menuitem" disabled={busy === item.id} onClick={() => startEdit(item)}>{ar ? "تعديل المزود" : "Edit provider"}</button><button type="button" role="menuitem" disabled={busy === item.id} onClick={() => { setOpenMenuId(null); void patch(item.id, { enabled: !item.enabled }); }}>{item.enabled ? (ar ? "تعطيل المزود" : "Disable provider") : (ar ? "تفعيل المزود" : "Enable provider")}</button><button type="button" role="menuitem" disabled={busy === item.id} onClick={() => { setOpenMenuId(null); void patch(item.id, { routingEnabled: !item.routingEnabled }); }}>{item.routingEnabled ? (ar ? "استبعاد من التوجيه" : "Exclude from routing") : (ar ? "إدراج في التوجيه" : "Include in routing")}</button><button className="is-destructive" type="button" role="menuitem" disabled={busy === item.id} onClick={() => { setOpenMenuId(null); void remove(item); }}>{ar ? "حذف المزود" : "Delete provider"}</button></div> : null}</div></div><div className="ai-provider-card-model" dir="ltr">{item.modelId || "—"}</div>{editingId === item.id ? <div className="ai-provider-inline-editor"><label><span>{ar ? "اسم المزود" : "Provider name"}</span><input value={editDraft.displayName} onChange={(event) => setEditDraft((current) => ({ ...current, displayName: event.target.value }))} /></label><label><span>{ar ? "النموذج" : "Model"}</span><select className="ai-provider-model-select" dir="ltr" value={editDraft.modelId} disabled={editModelsLoading || !editModels.length} aria-label={ar ? "النموذج" : "Model"} onChange={(event) => setEditDraft((current) => ({ ...current, modelId: event.target.value }))}>{!editModels.length ? <option value="">{ar ? "لا توجد نماذج متاحة" : "No models available"}</option> : null}{editModels.map((model) => <option key={model.id} value={model.id}>{model.displayName || model.id}</option>)}</select></label><label><span>{ar ? "الأولوية" : "Priority"}</span><input type="number" min="1" max="100000" step="1" value={editDraft.priority} onChange={(event) => setEditDraft((current) => ({ ...current, priority: event.target.value }))} /></label><label><span>{ar ? "المهلة (مللي ثانية)" : "Timeout (ms)"}</span><input type="number" min="1000" max="120000" step="1000" value={editDraft.timeoutMs} onChange={(event) => setEditDraft((current) => ({ ...current, timeoutMs: event.target.value }))} /></label><div className="ai-provider-inline-editor-actions"><button className="primary-button compact-button" type="button" disabled={busy === item.id} onClick={() => void saveEdit(item)}>{busy === item.id ? (ar ? "جارٍ الحفظ..." : "Saving...") : (ar ? "حفظ التعديلات" : "Save changes")}</button><button className="secondary-button compact-button" type="button" disabled={busy === item.id} onClick={() => setEditingId(null)}>{ar ? "إلغاء" : "Cancel"}</button></div></div> : null}<div className="ai-provider-status-row"><span className={`ai-provider-status-chip ${item.enabled ? "is-enabled" : "is-disabled"}`}>{item.enabled ? (ar ? "مفعّل" : "Enabled") : (ar ? "معطّل" : "Disabled")}</span><span className={`ai-provider-status-chip ${item.routingEnabled && item.enabled ? "is-routing" : ""}`}>{item.routingEnabled && item.enabled ? (ar ? "في التوجيه" : "In routing") : (ar ? "خارج التوجيه" : "Not in routing")}</span><span className="ai-provider-status-chip is-health">{healthLabel(item.healthState, ar)}</span></div><div className="ai-provider-instance-meta"><span>{ar ? "الأولوية" : "Priority"} {item.priority}</span><span>{ar ? "آخر نجاح: " : "Last success: "}{item.lastSuccessAt ? new Date(item.lastSuccessAt).toLocaleString(ar ? "ar-EG" : "en-US") : "—"}</span></div>{testError?.id === item.id ? <p className="ai-provider-card-error" role="alert">{testError.message}</p> : null}<div className="ai-provider-actions"><button className="secondary-button compact-button" type="button" disabled={!item.configured || busy === `test:${item.id}`} onClick={() => void test(item)}>{busy === `test:${item.id}` ? (ar ? "جارٍ الاختبار..." : "Testing...") : (ar ? "اختبار الاتصال" : "Test connection")}</button></div></article>)}</div>{message ? <p className="gemini-status is-success">{message}</p> : null}{error ? <p className="gemini-status is-error">{error}</p> : null}
  </section>;
}
