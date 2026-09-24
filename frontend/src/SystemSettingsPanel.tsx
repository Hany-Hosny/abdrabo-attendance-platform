import { type ReactNode, useEffect, useMemo, useState } from "react";

type Language = "ar" | "en";
type Translator = (key: string, values?: Record<string, string>) => string;
type Settings = {
  attendance_open_before_minutes: number;
  attendance_close_after_minutes: number;
  attendance_alert_threshold: number;
  attendance_cancellation_cutoff_percentage: number;
  absence_freeze_limit: number;
  evaluation_alert_threshold: number;
};
type CenterLocation = { name: string; address: string; latitude: number; longitude: number };
type CenterLocationDraft = Omit<CenterLocation, "latitude" | "longitude"> & { latitude: number | string; longitude: number | string };
type CenterLocationResponse = { ok?: boolean; center?: CenterLocation; name?: string; address?: string; latitude?: number; longitude?: number };

type Props = { token: string; language: Language; isOwner?: boolean; t: Translator };

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_URL || "/api";
const defaultSettings: Settings = {
  attendance_open_before_minutes: 3,
  attendance_close_after_minutes: 20,
  attendance_alert_threshold: 70,
  attendance_cancellation_cutoff_percentage: 60,
  absence_freeze_limit: 4,
  evaluation_alert_threshold: 60
};

function normalizeSettings(value: Partial<Settings> | undefined): Settings {
  return Object.fromEntries(Object.keys(defaultSettings).map((key) => {
    const settingKey = key as keyof Settings;
    const numericValue = Number(value?.[settingKey]);
    return [settingKey, Number.isFinite(numericValue) ? numericValue : defaultSettings[settingKey]];
  })) as Settings;
}

function normalizeCenterLocation(payload: CenterLocationResponse): CenterLocation | null {
  const source = payload.center || payload;
  const latitude = Number(source.latitude);
  const longitude = Number(source.longitude);
  const address = String(source.address || "").trim();
  if (!address || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
  return { name: String(source.name || ""), address, latitude, longitude };
}

function CenterLocationSettings({ token, language, t }: { token: string; language: Language; t: Translator }) {
  const [location, setLocation] = useState<CenterLocationDraft>({ name: "", address: "", latitude: 30.0444, longitude: 31.2357 });
  const [savedLocation, setSavedLocation] = useState<CenterLocation | null>(null);
  const [debouncedCoordinates, setDebouncedCoordinates] = useState({ latitude: 30.0444, longitude: 31.2357 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  const dirty = !savedLocation || JSON.stringify(location) !== JSON.stringify(savedLocation);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API_BASE_URL}/admin/center`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.ok) throw new Error("load_failed");
        const nextLocation = normalizeCenterLocation(payload);
        if (!nextLocation) throw new Error("invalid_center");
        return nextLocation;
      })
      .then((nextLocation) => { setLocation(nextLocation); setSavedLocation(nextLocation); setDebouncedCoordinates(nextLocation); setError(""); })
      .catch((reason) => { if (reason?.name !== "AbortError") setError(t("settings.locationLoadFailed")); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token]);

  useEffect(() => {
    const latitude = Number(location.latitude);
    const longitude = Number(location.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return undefined;
    const timer = window.setTimeout(() => setDebouncedCoordinates({ latitude, longitude }), 500);
    return () => window.clearTimeout(timer);
  }, [location.latitude, location.longitude]);

  function update(field: "address" | "latitude" | "longitude", value: string) {
    setStatus("idle"); setError("");
    setLocation((current) => ({ ...current, [field]: field === "address" ? value : value.trim() === "" ? "" : Number(value) }));
  }

  function detectLocation() {
    if (!navigator.geolocation) { setError(t("settings.locationUnavailable")); return; }
    setDetecting(true); setStatus("idle"); setError("");
    try {
      navigator.geolocation.getCurrentPosition(
        ({ coords }) => { setLocation((current) => ({ ...current, latitude: Number(coords.latitude.toFixed(6)), longitude: Number(coords.longitude.toFixed(6)) })); setDetecting(false); },
        () => { setError(t("settings.locationPermissionDenied")); setDetecting(false); },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
      );
    } catch (_error) { setError(t("settings.locationUnavailable")); setDetecting(false); }
  }

  async function save() {
    if (saving || !dirty) return;
    const latitude = Number(location.latitude); const longitude = Number(location.longitude);
    if (!location.address.trim() || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) { setStatus("error"); setError(t("settings.locationInvalid")); return; }
    setSaving(true); setStatus("idle"); setError("");
    try {
      const response = await fetch(`${API_BASE_URL}/admin/center`, { method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ address: location.address.trim(), latitude, longitude }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error("save_failed");
      const nextLocation = normalizeCenterLocation(payload);
      if (!nextLocation) throw new Error("invalid_center");
      setLocation(nextLocation); setSavedLocation(nextLocation); setStatus("saved");
      window.setTimeout(() => setStatus("idle"), 2200);
    } catch (_error) { setStatus("error"); setError(t("settings.locationSaveFailed")); }
    finally { setSaving(false); }
  }

  const mapUrl = `https://maps.google.com/maps?q=${encodeURIComponent(`${debouncedCoordinates.latitude},${debouncedCoordinates.longitude}`)}&hl=${language}&z=16&output=embed`;
  return <section className="settings-section center-location-settings">
    <div className="settings-section-heading"><span>05</span><div><h3>{t("settings.locationTitle")}</h3><p>{t("settings.locationDescription")}</p></div></div>
    {loading ? <div className="center-location-skeleton" aria-hidden="true"><i /><i /><i /></div> : <div className="center-location-layout">
      <div className="center-location-fields">
        <label className="system-setting-field center-location-address"><span>{t("settings.addressLabel")}</span><small>{t("settings.addressDescription")}</small><input value={location.address} maxLength={500} onChange={(event) => update("address", event.target.value)} /></label>
        <div className="center-location-coordinate-grid">
          <label className="system-setting-field"><span>{t("settings.latitudeLabel")}</span><small>{t("settings.latitudeDescription")}</small><input type="number" inputMode="decimal" min={-90} max={90} step="any" value={location.latitude} onChange={(event) => update("latitude", event.target.value)} /></label>
          <label className="system-setting-field"><span>{t("settings.longitudeLabel")}</span><small>{t("settings.longitudeDescription")}</small><input type="number" inputMode="decimal" min={-180} max={180} step="any" value={location.longitude} onChange={(event) => update("longitude", event.target.value)} /></label>
        </div>
        <button className="secondary-button compact-button" type="button" onClick={detectLocation} disabled={detecting || saving}>{detecting ? t("settings.detectingLocation") : t("settings.detectLocation")}</button>
        <div className="system-settings-actions"><span className={status === "error" ? "form-error" : status === "saved" ? "lookup-result" : "form-hint"} role={status !== "idle" || error ? "status" : undefined}>{error || (status === "saved" ? t("settings.saved") : t("settings.locationHint"))}</span><button className={`primary-button compact-button ${status === "saved" ? "success-button" : ""}`} type="button" disabled={saving || !dirty} onClick={() => void save()}>{saving ? t("settings.saving") : status === "saved" ? t("settings.saved") : t("settings.saveLocation")}</button></div>
      </div>
      <div className="center-location-preview"><div className="center-location-preview-heading"><span>{t("settings.mapPreview")}</span><small>{t("settings.mapPreviewDescription")}</small></div><iframe className="center-location-map-frame filter invert-[90%] hue-rotate-180 contrast-[85%] grayscale-[10%]" src={mapUrl} title={t("settings.mapPreview")} loading="lazy" /></div>
    </div>}
  </section>;
}

type GeminiConfig = { model: "gemini-3.6-flash" | "gemini-3.5-flash" | "gemini-2.5-pro"; apiKeyConfigured: boolean; encryptionConfigured: boolean };
const geminiModels: GeminiConfig["model"][] = ["gemini-3.6-flash", "gemini-3.5-flash", "gemini-2.5-pro"];

function GeminiSettingsPanel({ token, language, t, embedded = false }: { token: string; language: Language; t: Translator; embedded?: boolean }) {
  const endpoint = `${API_BASE_URL}/admin/settings/advanced/gemini`;
  const ar = language === "ar";
  const [config, setConfig] = useState<GeminiConfig | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState<GeminiConfig["model"]>("gemini-3.6-flash");
  const [visible, setVisible] = useState(false);
  const [credentialEditing, setCredentialEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"idle" | "success" | "error">("idle");
  const [message, setMessage] = useState("");
  const [verified, setVerified] = useState(false);
  const [open, setOpen] = useState(false);
  const [providerSettings, setProviderSettings] = useState({ enabled: true, priority: 1, timeoutMs: 12000 });
  const aiEnabled = verified && Boolean(apiKey.trim() || config?.apiKeyConfigured);

  useEffect(() => {
    const controller = new AbortController();
    fetch(endpoint, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.ok) throw new Error(payload.status || "load_failed");
        return payload as GeminiConfig;
      })
      .then((next) => { setConfig(next); setModel(geminiModels.includes(next.model) ? next.model : "gemini-3.6-flash"); setVerified(Boolean(next.apiKeyConfigured)); })
      .catch((error) => {
        if (error?.name !== "AbortError") { setStatus("error"); setMessage(error?.message === "secret_storage_unavailable" ? t("settings.secretStorageUnavailable") : t("settings.geminiLoadFailed")); }
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token]);

  useEffect(() => {
    fetch(`${API_BASE_URL}/admin/settings/advanced/ai/providers`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (response) => { const payload = await response.json().catch(() => ({})); if (!response.ok || !payload.ok) throw new Error("load_failed"); return payload; })
      .then((payload) => { const provider = payload.providers?.find((item: ProviderStatus) => item.id === "gemini"); if (provider) setProviderSettings({ enabled: Boolean(provider.enabled), priority: Number(provider.priority) || 1, timeoutMs: Number(provider.timeoutMs) || 12000 }); })
      .catch(() => undefined);
  }, [token]);

  function resetVerification() {
    setVerified(false); setStatus("idle"); setMessage("");
  }

  function connectionError(payload: any) {
    if (payload?.status === "secret_storage_unavailable") return t("settings.secretStorageUnavailable");
    if (payload?.status === "provider_not_configured") return t("settings.geminiKeyRequired");
    if (payload?.status === "provider_rate_limited") return language === "ar" ? "تم الوصول إلى حد الاستخدام الحالي لـ Gemini. حاول لاحقًا أو استخدم مزودًا احتياطيًا." : "Gemini usage is currently rate limited. Try again later or use a fallback provider.";
    if (payload?.status === "provider_auth_failed") return language === "ar" ? "تعذر التحقق من بيانات اعتماد Gemini." : "Gemini credentials could not be verified.";
    if (payload?.status === "provider_timeout") return language === "ar" ? "انتهت مهلة الاتصال بـ Gemini." : "Gemini connection timed out.";
    if (payload?.status === "provider_model_unavailable") return language === "ar" ? "النموذج المحدد غير متاح حاليًا." : "The selected Gemini model is currently unavailable.";
    return language === "ar" ? "تعذر الاتصال بـ Gemini حاليًا." : "Gemini is currently unavailable.";
  }

  async function testConnection() {
    if (testing || saving) return;
    if (!apiKey.trim() && !config?.apiKeyConfigured) { setStatus("error"); setMessage(t("settings.geminiKeyRequired")); return; }
    setTesting(true); setStatus("idle"); setMessage("");
    try {
      const body: Record<string, string> = { model };
      if (apiKey.trim()) body.apiKey = apiKey.trim();
      const response = await fetch(`${endpoint}/test`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw payload;
      setVerified(true); setStatus("success"); setMessage(t("settings.geminiTestSuccess"));
      window.setTimeout(() => setStatus("idle"), 2200);
    } catch (error) {
      setVerified(false); setStatus("error"); setMessage(connectionError(error));
    } finally { setTesting(false); }
  }

  async function save() {
    if (saving || testing) return;
    if (!verified) { setStatus("error"); setMessage(t("settings.geminiVerifyBeforeSave")); return; }
    setSaving(true); setStatus("idle"); setMessage("");
    try {
      const body: Record<string, string> = { model };
      if (apiKey.trim()) body.apiKey = apiKey.trim();
      const response = await fetch(endpoint, { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw payload;
      const providerResponse = await fetch(`${API_BASE_URL}/admin/settings/advanced/ai/providers/gemini`, { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(providerSettings) });
      if (!providerResponse.ok) throw await providerResponse.json().catch(() => ({}));
      setConfig(payload as GeminiConfig); setApiKey(""); setVisible(false); setCredentialEditing(false); setVerified(true); setStatus("success"); setMessage(t("settings.geminiSaved"));
      window.setTimeout(() => setStatus("idle"), 2200);
    } catch (error) {
      setStatus("error"); setMessage(connectionError(error));
    } finally { setSaving(false); }
  }

  return <section className={embedded ? "ai-provider-accordion-item ai-provider-accordion-gemini" : "settings-section gemini-settings-panel"} dir={language === "ar" ? "rtl" : "ltr"}>
    <div className="gemini-accordion-header">
      <button id="gemini-settings-trigger" className="gemini-accordion-trigger" type="button" aria-expanded={open} aria-controls="gemini-settings-content" onClick={() => setOpen((current) => !current)}>
        <span className="gemini-section-number">06</span>
        <span className="gemini-accordion-copy"><h3>Google Gemini</h3><span>{embedded ? null : t("settings.geminiDescription")}</span></span>
        <svg className={`gemini-accordion-chevron ${open ? "is-open" : ""}`} viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      <div className={`gemini-header-status ${providerSettings.enabled ? "is-active" : "is-pending"}`} role="status" aria-live="polite"><i aria-hidden="true" /><span>{config?.apiKeyConfigured ? (ar ? "مُعدّ" : "Configured") : (ar ? "غير مُعدّ" : "Not configured")} · {providerSettings.enabled ? (ar ? "مفعّل" : "Enabled") : (ar ? "معطّل" : "Disabled")}</span>{providerSettings.enabled ? <small>{ar ? `أولوية ${providerSettings.priority}` : `Priority ${providerSettings.priority}`}</small> : null}</div>
    </div>
    <div id="gemini-settings-content" className={`gemini-accordion-content ${open ? "is-open" : ""}`} role="region" aria-labelledby="gemini-settings-trigger" aria-hidden={!open}>
      <div className="gemini-accordion-content-inner">
        {loading ? <div className="system-settings-skeleton" aria-hidden="true"><i /><i /></div> : <>
        <div className="gemini-settings-content ai-provider-expanded-shell">
          <div className={`ai-provider-expanded-status ${providerSettings.enabled ? "is-active" : "is-pending"}`} role="status" aria-live="polite"><span><i aria-hidden="true" />{ar ? "الحالة" : "Status"}</span><strong>{providerSettings.enabled ? (ar ? "مفعّل في التوجيه" : "Enabled for routing") : (ar ? "معطّل" : "Disabled")}</strong><small>{model}</small></div>
          <label className="ai-provider-expanded-toggle"><span>{ar ? "تفعيل المزود" : "Enable provider"}</span><input type="checkbox" checked={providerSettings.enabled} onChange={(event) => setProviderSettings((current) => ({ ...current, enabled: event.target.checked }))} /><small>{ar ? "عند التعطيل لن يتم استخدام هذا المزود في التوجيه." : "Disabled providers do not participate in routing."}</small></label>
          <div className="ai-provider-fields gemini-config-fields"><label className="system-setting-field"><span>{t("settings.geminiModel")}</span><select value={model} onChange={(event) => { setModel(event.target.value as GeminiConfig["model"]); resetVerification(); }}>{geminiModels.map((value) => <option key={value} value={value}>{t(`settings.geminiModel.${value}`)}</option>)}</select></label><label className="system-setting-field"><span>{ar ? "الأولوية" : "Priority"}</span><input type="number" min="1" step="1" value={providerSettings.priority} onChange={(event) => setProviderSettings((current) => ({ ...current, priority: Number(event.target.value) || 1 }))} /></label><label className="system-setting-field"><span>{ar ? "المهلة (مللي ثانية)" : "Timeout (ms)"}</span><input type="number" min="1000" max="120000" step="1000" value={providerSettings.timeoutMs} onChange={(event) => setProviderSettings((current) => ({ ...current, timeoutMs: Number(event.target.value) || 12000 }))} /></label></div>
          <div className="ai-provider-credential-row gemini-credential-row">{credentialEditing || !config?.apiKeyConfigured ? <label className="system-setting-field ai-provider-credential"><span>{t("settings.geminiApiKey")}</span><small>{t("settings.geminiKeyHint")}</small><div className="gemini-api-key-input"><input type={visible ? "text" : "password"} value={apiKey} onChange={(event) => { setApiKey(event.target.value); resetVerification(); }} placeholder={t("settings.geminiKeyPlaceholder")} autoComplete="new-password" spellCheck={false} /><button type="button" onClick={() => setVisible((current) => !current)} aria-label={visible ? t("settings.geminiHideKey") : t("settings.geminiShowKey")} title={visible ? t("settings.geminiHideKey") : t("settings.geminiShowKey")}><EyeIcon open={visible} /></button></div></label> : <span className="ai-provider-credential-status"><span className="ai-provider-badge is-configured">{ar ? "بيانات الاعتماد مُعدّة" : "Credential configured"}</span><small>{ar ? "القيمة المحفوظة لا تظهر هنا." : "Saved credentials are never displayed."}</small></span>}{config?.apiKeyConfigured ? <button className="ai-provider-credential-button" type="button" onClick={() => setCredentialEditing((current) => !current)}>{credentialEditing ? (ar ? "إلغاء" : "Cancel") : (ar ? "استبدال بيانات الاعتماد" : "Replace credential")}</button> : null}</div>
          <div className="gemini-settings-actions"><button className={`secondary-button compact-button gemini-test-button ${status === "success" && message === t("settings.geminiTestSuccess") ? "success-button" : ""}`} type="button" onClick={() => void testConnection()} disabled={testing || saving}>{testing ? <><SpinnerIcon />{t("settings.geminiTesting")}</> : status === "success" && message === t("settings.geminiTestSuccess") ? t("settings.geminiVerified") : t("settings.geminiTest")}</button><button className={`primary-button compact-button ${status === "success" && message === t("settings.geminiSaved") ? "success-button" : ""}`} type="button" onClick={() => void save()} disabled={testing || saving || !verified}>{saving ? <><SpinnerIcon />{t("settings.geminiSaving")}</> : status === "success" && message === t("settings.geminiSaved") ? t("settings.saved") : t("settings.geminiSave")}</button></div>
          <p className={`gemini-status ${status === "success" ? "is-success" : status === "error" ? "is-error" : ""}`} role={status === "idle" ? undefined : "status"} aria-live="polite">{message || t("settings.geminiSecurityHint")}</p>
        </div></>}
      </div>
    </div>
  </section>;
}

function EyeIcon({ open }: { open: boolean }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.8 12s3.3-5.4 9.2-5.4S21.2 12 21.2 12 17.9 17.4 12 17.4 2.8 12 2.8 12Z" /><circle cx="12" cy="12" r="2.7" />{open ? null : <path d="M4 4 20 20" />}</svg>;
}

function SpinnerIcon() {
  return <span className="gemini-spinner" aria-hidden="true" />;
}

type ProviderStatus = {
  id: "gemini" | "groq" | "mistral" | "openrouter" | "cloudflare";
  label: string;
  enabled: boolean;
  configured: boolean;
  apiKeyConfigured?: boolean;
  tokenConfigured?: boolean;
  accountId?: string | null;
  model: string | null;
  priority: number | null;
  timeoutMs: number;
  supportsConnectionTest: boolean;
};

type ProviderDraft = { enabled: boolean; model: string; priority: string; timeoutMs: string; accountId: string };
const genericProviderIds: ProviderStatus["id"][] = ["groq", "mistral", "openrouter", "cloudflare"];

function MultiProviderSettingsPanel({ token, language, children }: { token: string; language: Language; children?: ReactNode }) {
  const ar = language === "ar";
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [geminiProvider, setGeminiProvider] = useState<ProviderStatus | null>(null);
  const [routingStrategy, setRoutingStrategy] = useState("failover");
  const [drafts, setDrafts] = useState<Record<string, ProviderDraft>>({});
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [credentialEditing, setCredentialEditing] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [providerSaved, setProviderSaved] = useState<Record<string, boolean>>({});
  const [providerTestResult, setProviderTestResult] = useState<Record<string, "success" | "error" | undefined>>({});
  const [openProvider, setOpenProvider] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  function load() {
    return fetch(`${API_BASE_URL}/admin/settings/advanced/ai/providers`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (response) => { const payload = await response.json().catch(() => ({})); if (!response.ok || !payload.ok) throw new Error(payload.status || "load_failed"); return payload; })
      .then((payload) => {
        const allProviders = (payload.providers || []) as ProviderStatus[];
        const nextProviders = allProviders.filter((provider) => genericProviderIds.includes(provider.id));
        setGeminiProvider(allProviders.find((provider) => provider.id === "gemini") || null);
        setProviders(nextProviders);
        setRoutingStrategy(payload.routingStrategy || "failover");
        setDrafts(Object.fromEntries(nextProviders.map((provider: ProviderStatus) => [provider.id, { enabled: provider.enabled, model: provider.model || "", priority: provider.priority === null ? "" : String(provider.priority), timeoutMs: String(provider.timeoutMs), accountId: provider.accountId || "" }])));
      });
  }

  useEffect(() => { load().catch(() => setError(ar ? "تعذر تحميل إعدادات المزودين." : "Could not load provider settings.")); }, [token]);

  function updateDraft(id: string, field: keyof ProviderDraft, value: string | boolean) {
    setDrafts((current) => ({ ...current, [id]: { ...current[id], [field]: value } }));
    setMessage(""); setError("");
  }

  async function saveProvider(provider: ProviderStatus) {
    const draft = drafts[provider.id];
    const priority = draft.priority.trim() === "" ? null : Number(draft.priority);
    const timeoutMs = Number(draft.timeoutMs);
    if (draft.enabled && (priority === null || !Number.isInteger(priority) || priority < 1)) { setError(ar ? "الأولوية يجب أن تكون رقمًا صحيحًا موجبًا." : "Priority must be a positive integer."); return; }
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) { setError(ar ? "المهلة يجب أن تكون بين 1000 و120000 مللي ثانية." : "Timeout must be between 1000 and 120000 ms."); return; }
    setBusy((current) => ({ ...current, [provider.id]: true })); setError(""); setMessage("");
    try {
      const body = { enabled: draft.enabled, model: draft.model.trim() || null, priority, timeoutMs, ...(provider.id === "cloudflare" ? { accountId: draft.accountId.trim() || null } : {}) };
      const response = await fetch(`${API_BASE_URL}/admin/settings/advanced/ai/providers/${provider.id}`, { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.status || "save_failed");
      await load();
      setProviderSaved((current) => ({ ...current, [provider.id]: true }));
      window.setTimeout(() => setProviderSaved((current) => ({ ...current, [provider.id]: false })), 1800);
    } catch (_error) { setError(ar ? "تعذر حفظ إعدادات المزود." : "Could not save provider settings."); }
    finally { setBusy((current) => ({ ...current, [provider.id]: false })); }
  }

  async function saveCredential(provider: ProviderStatus) {
    const value = credentials[provider.id]?.trim();
    if (!value) { setError(ar ? "أدخل بيانات الاعتماد أولًا." : "Enter a credential first."); return; }
    setBusy((current) => ({ ...current, [`${provider.id}-credential`]: true })); setError("");
    try {
      const field = provider.id === "cloudflare" ? "apiToken" : "apiKey";
      const response = await fetch(`${API_BASE_URL}/admin/settings/advanced/ai/providers/${provider.id}/credential`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ [field]: value }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.status || "credential_failed");
      setCredentials((current) => ({ ...current, [provider.id]: "" })); setCredentialEditing((current) => ({ ...current, [provider.id]: false })); await load(); setMessage(ar ? "تم حفظ بيانات الاعتماد بأمان." : "Credential saved securely.");
    } catch (_error) { setError(ar ? "تعذر حفظ بيانات الاعتماد." : "Could not save credential."); }
    finally { setBusy((current) => ({ ...current, [`${provider.id}-credential`]: false })); }
  }

  async function testProvider(provider: ProviderStatus) {
    if (!provider.configured) { setError(ar ? "اضبط بيانات الاعتماد أولًا." : "Configure credentials first."); return; }
    setBusy((current) => ({ ...current, [`${provider.id}-test`]: true })); setProviderTestResult((current) => ({ ...current, [provider.id]: undefined })); setError(""); setMessage("");
    try {
      const response = await fetch(`${API_BASE_URL}/admin/settings/advanced/ai/providers/${provider.id}/test`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.message || "test_failed");
      setProviderTestResult((current) => ({ ...current, [provider.id]: "success" }));
      window.setTimeout(() => setProviderTestResult((current) => ({ ...current, [provider.id]: undefined })), 2200);
    } catch (_error) {
      setProviderTestResult((current) => ({ ...current, [provider.id]: "error" }));
      window.setTimeout(() => setProviderTestResult((current) => ({ ...current, [provider.id]: undefined })), 2800);
    }
    finally { setBusy((current) => ({ ...current, [`${provider.id}-test`]: false })); }
  }

  async function saveRouting(value: string) {
    setRoutingStrategy(value);
    try { await fetch(`${API_BASE_URL}/admin/settings/advanced/ai/routing`, { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ strategy: value }) }); setMessage(ar ? "تم حفظ استراتيجية التوجيه." : "Routing strategy saved."); } catch (_error) { setError(ar ? "تعذر حفظ استراتيجية التوجيه." : "Could not save routing strategy."); }
  }

  return <section className="settings-section ai-providers-panel" dir={ar ? "rtl" : "ltr"}>
    <div className="settings-section-heading ai-providers-heading"><span>06</span><div><h3>{ar ? "مزودو الذكاء الاصطناعي" : "AI Providers"}</h3><p>{ar ? "إدارة المزودين وترتيب التوجيه الاحتياطي." : "Manage providers and fallback routing."}</p></div><div className="ai-provider-summary"><b>{providers.length + 1} {ar ? "مزودين" : "providers"}</b><span>{providers.filter((provider) => provider.enabled).length + (geminiProvider?.configured ? 1 : 0)} {ar ? "مفعّل" : "active"}</span><span>{providers.filter((provider) => provider.configured).length + (geminiProvider?.configured ? 1 : 0)} {ar ? "مُعدّ" : "configured"}</span></div></div>
    <div className="ai-routing-row"><label className="system-setting-field"><span>{ar ? "استراتيجية التوجيه" : "Routing strategy"}</span><small>{ar ? "المتاح حاليًا: التوجيه الاحتياطي فقط." : "Currently supported: sequential failover only."}</small><select value={routingStrategy} onChange={(event) => void saveRouting(event.target.value)}><option value="failover">{ar ? "التوجيه الاحتياطي" : "Failover"}</option></select></label><p>{ar ? "الأولوية الأقل تُجرّب أولًا: 1 أساسي، 2 احتياطي أول." : "Lower priority numbers are tried first: 1 primary, 2 first fallback."}</p></div>
    <div className="ai-provider-accordion-list">
      {children}
      {providers.map((provider) => { const draft = drafts[provider.id]; if (!draft) return null; const credentialLabel = provider.id === "cloudflare" ? "Cloudflare API token" : (ar ? "مفتاح API" : "API key"); const isEditingCredential = credentialEditing[provider.id] || !provider.configured; return <article className={`ai-provider-card ai-provider-card-${provider.id}`} key={provider.id}>
        <div className="ai-provider-card-heading"><button className="ai-provider-accordion-trigger" type="button" aria-expanded={openProvider === provider.id} aria-controls={`ai-provider-content-${provider.id}`} onClick={() => setOpenProvider((current) => current === provider.id ? null : provider.id)}><span className="ai-provider-card-title"><h4>{provider.label}</h4><span className="ai-provider-badges"><span className={`ai-provider-badge ${provider.configured ? "is-configured" : ""}`}>{provider.configured ? (ar ? "مُعدّ" : "Configured") : (ar ? "غير مُعدّ" : "Not configured")}</span><span className={`ai-provider-badge ${draft.enabled ? "is-enabled" : ""}`}>{draft.enabled ? (ar ? "مفعّل" : "Active") : (ar ? "معطّل" : "Disabled")}</span>{draft.enabled && draft.priority ? <span className="ai-provider-priority">{ar ? "أولوية" : "Priority"} {draft.priority}</span> : null}</span></span><span className={`ai-provider-accordion-chevron ${openProvider === provider.id ? "is-open" : ""}`} aria-hidden="true">›</span></button></div>
        <div id={`ai-provider-content-${provider.id}`} className={`ai-provider-accordion-content ${openProvider === provider.id ? "is-open" : ""}`} aria-hidden={openProvider !== provider.id}><div className="ai-provider-accordion-inner"><label className="ai-provider-expanded-toggle"><span>{ar ? "تفعيل المزود" : "Enable provider"}</span><input type="checkbox" checked={draft.enabled} onChange={(event) => updateDraft(provider.id, "enabled", event.target.checked)} /><small>{draft.enabled ? (ar ? "نشط في التوجيه" : "Included in routing") : (ar ? "متوقف" : "Disabled")}</small></label><div className="ai-provider-fields"><label className="system-setting-field"><span>{ar ? "النموذج" : "Model"}</span><input value={draft.model} onChange={(event) => updateDraft(provider.id, "model", event.target.value)} placeholder={ar ? "اسم النموذج" : "Model name"} /></label><label className="system-setting-field"><span>{ar ? "الأولوية" : "Priority"}</span><input type="number" min="1" step="1" value={draft.priority} onChange={(event) => updateDraft(provider.id, "priority", event.target.value)} /></label><label className="system-setting-field"><span>{ar ? "المهلة (مللي ثانية)" : "Timeout (ms)"}</span><input type="number" min="1000" max="120000" step="1000" value={draft.timeoutMs} onChange={(event) => updateDraft(provider.id, "timeoutMs", event.target.value)} /></label>{provider.id === "cloudflare" ? <label className="system-setting-field"><span>Account ID</span><input value={draft.accountId} onChange={(event) => updateDraft(provider.id, "accountId", event.target.value)} placeholder={ar ? "معرّف الحساب" : "Account ID"} /></label> : null}</div>
        <div className={`ai-provider-credential-row ${isEditingCredential ? "is-editing" : ""}`}>{isEditingCredential ? <label className="system-setting-field ai-provider-credential"><span>{credentialLabel}</span><small>{ar ? "لن تظهر القيمة المحفوظة في المتصفح." : "Saved values are never shown in the browser."}</small><input type="password" autoComplete="new-password" value={credentials[provider.id] || ""} onChange={(event) => setCredentials((current) => ({ ...current, [provider.id]: event.target.value }))} /></label> : <span className="ai-provider-credential-status"><span className="ai-provider-badge is-configured">{ar ? "بيانات الاعتماد مُعدّة" : "Credential configured"}</span><small>{ar ? "القيمة المحفوظة لا تظهر هنا." : "Saved credentials are never displayed."}</small></span>}{provider.configured ? <button className="ai-provider-credential-button" type="button" onClick={() => setCredentialEditing((current) => ({ ...current, [provider.id]: !isEditingCredential }))}>{isEditingCredential ? (ar ? "إلغاء" : "Cancel") : (ar ? "استبدال بيانات الاعتماد" : "Replace credential")}</button> : null}</div>
        {isEditingCredential ? <div className="ai-provider-credential-actions"><button className="secondary-button compact-button" type="button" disabled={busy[`${provider.id}-credential`]} onClick={() => void saveCredential(provider)}>{busy[`${provider.id}-credential`] ? (ar ? "جارٍ الحفظ..." : "Saving...") : (ar ? "حفظ بيانات الاعتماد" : "Save credential")}</button></div> : null}
        <div className="ai-provider-actions"><button className={`secondary-button compact-button ${providerTestResult[provider.id] === "success" ? "success-button" : providerTestResult[provider.id] === "error" ? "test-error-button" : ""}`} type="button" disabled={!provider.configured || !draft.model.trim() || busy[`${provider.id}-test`]} onClick={() => void testProvider(provider)}>{busy[`${provider.id}-test`] ? (ar ? "جارٍ الاختبار..." : "Testing...") : providerTestResult[provider.id] === "success" ? (ar ? "تم الاختبار" : "Verified") : providerTestResult[provider.id] === "error" ? (ar ? "فشل الاختبار" : "Test failed") : provider.configured ? (ar ? "اختبار الاتصال" : "Test connection") : (ar ? "بيانات الاعتماد غير مُعدّة" : "Credentials not configured")}</button><button className={`primary-button compact-button ${providerSaved[provider.id] ? "success-button" : ""}`} type="button" disabled={busy[provider.id]} onClick={() => void saveProvider(provider)}>{busy[provider.id] ? (ar ? "جارٍ الحفظ..." : "Saving...") : providerSaved[provider.id] ? (ar ? "تم الحفظ" : "Saved") : (ar ? "حفظ الإعدادات" : "Save settings")}</button></div></div></div>
      </article>; })}
    </div>
    {message ? <p className="gemini-status is-success">{message}</p> : null}{error ? <p className="gemini-status is-error">{error}</p> : null}
  </section>;
}

function NumberSetting({ label, description, value, min, max, suffix, onChange }: {
  label: string;
  description: string;
  value: number;
  min: number;
  max: number;
  suffix: string;
  onChange: (value: number) => void;
}) {
  return <label className="system-setting-field">
    <span>{label}</span>
    <small>{description}</small>
    <div className="system-setting-input"><input type="number" min={min} max={max} step={1} value={value} onChange={(event) => onChange(Number(event.target.value))} /><em>{suffix}</em></div>
  </label>;
}

export function SystemSettingsPanel({ token, language, isOwner = false, t }: Props) {
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [savedSettings, setSavedSettings] = useState<Settings>(defaultSettings);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const dirty = useMemo(() => JSON.stringify(settings) !== JSON.stringify(savedSettings), [settings, savedSettings]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetch(`${API_BASE_URL}/admin/settings`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.ok) throw new Error(response.status === 403 ? "forbidden" : "request_failed");
        return normalizeSettings(payload.settings);
      })
      .then((nextSettings) => { setSettings(nextSettings); setSavedSettings(nextSettings); setError(""); })
      .catch((reason) => { if (reason?.name !== "AbortError") setError(reason?.message === "forbidden" ? t("settings.accessDenied") : t("settings.loadFailed")); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token]);

  function update(key: keyof Settings, value: number) {
    setStatus("idle");
    setSettings((current) => ({ ...current, [key]: Number.isFinite(value) ? value : 0 }));
  }

  async function save() {
    if (saving || !dirty) return;
    setSaving(true);
    setStatus("idle");
    setError("");
    try {
      const response = await fetch(`${API_BASE_URL}/admin/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ settings })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(response.status === 400 ? "validation" : "request_failed");
      const nextSettings = normalizeSettings(payload.settings);
      setSettings(nextSettings);
      setSavedSettings(nextSettings);
      setStatus("saved");
      window.setTimeout(() => setStatus("idle"), 2200);
    } catch (reason) {
      setStatus("error");
      setError(reason instanceof Error && reason.message === "validation" ? t("settings.invalidValues") : t("settings.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <section className="admin-editor system-settings-panel"><div className="section-heading"><p className="eyebrow">{t("admin.tabs.settings")}</p><h2>{t("settings.title")}</h2></div><div className="system-settings-skeleton" aria-hidden="true"><i /><i /><i /></div></section>;
  if (error && !dirty && JSON.stringify(settings) === JSON.stringify(defaultSettings) && JSON.stringify(savedSettings) === JSON.stringify(defaultSettings)) {
    return <section className="admin-editor system-settings-panel"><div className="section-heading"><p className="eyebrow">{t("admin.tabs.settings")}</p><h2>{t("settings.title")}</h2></div><div className="settings-error"><p>{error}</p><button className="secondary-button" type="button" onClick={() => window.location.reload()}>{t("dashboard.retry")}</button></div></section>;
  }

  return <section className="admin-editor system-settings-panel" dir={language === "ar" ? "rtl" : "ltr"}>
    <div className="section-heading system-settings-heading"><div><p className="eyebrow">{t("admin.tabs.settings")}</p><h2>{t("settings.title")}</h2><p>{t("settings.subtitle")}</p></div><div className="system-settings-heading-actions"><span className={status === "error" ? "form-error" : "form-hint"} role={status === "saved" || status === "error" ? "status" : undefined}>{status === "saved" ? t("settings.saved") : error || t("settings.safeDefaults")}</span><button className={`primary-button compact-button ${status === "saved" ? "success-button" : ""}`} type="button" disabled={saving || !dirty} onClick={save}><SaveIcon />{saving ? t("settings.saving") : status === "saved" ? t("settings.saved") : t("settings.save")}</button></div></div>
    <div className="settings-sections">
      <section className="settings-section settings-section-readonly"><div className="settings-section-heading"><span>01</span><div><h3>{t("settings.generalTitle")}</h3><p>{t("settings.generalDescription")}</p></div></div><div className="settings-note-grid"><div><strong>{t("settings.brandingSource")}</strong><span>{t("settings.brandingSourceDescription")}</span></div><div><strong>{t("settings.currencyLabel")}</strong><span>EGP · {t("settings.currencyDescription")}</span></div></div></section>
      <section className="settings-section"><div className="settings-section-heading"><span>02</span><div><h3>{t("settings.attendanceTitle")}</h3><p>{t("settings.attendanceDescription")}</p></div></div><div className="system-settings-grid"><NumberSetting label={t("settings.openBeforeLabel")} description={t("settings.openBeforeDescription")} value={settings.attendance_open_before_minutes} min={0} max={180} suffix={t("settings.minutes")} onChange={(value) => update("attendance_open_before_minutes", value)} /><NumberSetting label={t("settings.closeAfterLabel")} description={t("settings.closeAfterDescription")} value={settings.attendance_close_after_minutes} min={0} max={240} suffix={t("settings.minutes")} onChange={(value) => update("attendance_close_after_minutes", value)} /><NumberSetting label={t("settings.attendanceAlertLabel")} description={t("settings.attendanceAlertDescription")} value={settings.attendance_alert_threshold} min={0} max={100} suffix="%" onChange={(value) => update("attendance_alert_threshold", value)} /><NumberSetting label={t("settings.cancellationCutoffLabel")} description={t("settings.cancellationCutoffDescription")} value={settings.attendance_cancellation_cutoff_percentage} min={1} max={90} suffix="%" onChange={(value) => update("attendance_cancellation_cutoff_percentage", value)} /><NumberSetting label={t("settings.absenceFreezeLimitLabel")} description={t("settings.absenceFreezeLimitDescription")} value={settings.absence_freeze_limit} min={1} max={20} suffix={t("settings.absences")} onChange={(value) => update("absence_freeze_limit", value)} /></div></section>
      <section className="settings-section"><div className="settings-section-heading"><span>03</span><div><h3>{t("settings.evaluationTitle")}</h3><p>{t("settings.evaluationDescription")}</p></div></div><div className="system-settings-grid system-settings-grid-single"><NumberSetting label={t("settings.evaluationAlertLabel")} description={t("settings.evaluationAlertDescription")} value={settings.evaluation_alert_threshold} min={0} max={100} suffix="%" onChange={(value) => update("evaluation_alert_threshold", value)} /></div></section>
      <section className="settings-section settings-section-readonly"><div className="settings-section-heading"><span>04</span><div><h3>{t("settings.paymentsTitle")}</h3><p>{t("settings.paymentsDescription")}</p></div></div><div className="settings-note-grid"><div><strong>{t("settings.paymentFeesSource")}</strong><span>{t("settings.paymentFeesSourceDescription")}</span></div><div><strong>{t("settings.reversalSource")}</strong><span>{t("settings.reversalSourceDescription")}</span></div></div></section>
      <CenterLocationSettings token={token} language={language} t={t} />
      {isOwner ? <MultiProviderSettingsPanel token={token} language={language}><GeminiSettingsPanel token={token} language={language} t={t} embedded /></MultiProviderSettingsPanel> : null}
    </div>
    {isOwner ? <AdvancedPasswordRecoveryPanel token={token} t={t} open={advancedOpen} onToggle={() => setAdvancedOpen((value) => !value)} /> : null}
  </section>;
}

function SaveIcon() {
  return <svg className="settings-action-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4.5h11.2L19.5 8v11.5H5z" /><path d="M8 4.5v5h8v-5M8.5 19.5v-5h7v5" /></svg>;
}

function ChevronIcon({ open }: { open: boolean }) {
  return <svg className="settings-accordion-icon" viewBox="0 0 24 24" aria-hidden="true"><path d={open ? "m5 15 7-7 7 7" : "m5 9 7 7 7-7"} /></svg>;
}

type RecoveryConfig = {
  enabled: boolean;
  requestedEnabled: boolean;
  provider: "gmail-smtp" | "resend";
  senderName: string;
  senderEmail: string;
  fromEmail: string;
  apiKeyConfigured: boolean;
  providerConfigured: boolean;
  smtpConfigured: boolean;
  resetSecretConfigured: boolean;
  encryptionConfigured: boolean;
  configured: boolean;
};

function AdvancedPasswordRecoveryPanel({ token, t, open, onToggle }: { token: string; t: Translator; open: boolean; onToggle: () => void }) {
  const [config, setConfig] = useState<RecoveryConfig | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState<RecoveryConfig["provider"]>("gmail-smtp");
  const [fromEmail, setFromEmail] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [statusTone, setStatusTone] = useState<"success" | "error" | "hint">("hint");
  const endpoint = `${API_BASE_URL}/admin/settings/advanced/password-recovery`;

  async function load() {
    setLoading(true);
    try {
      const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.status || "load_failed");
      const next = payload as RecoveryConfig;
      setConfig(next); setEnabled(Boolean(next.requestedEnabled)); setProvider(next.provider); setFromEmail(String(next.senderEmail || next.fromEmail || "")); setStatus("");
    } catch (error) {
      setStatus(error instanceof Error && error.message === "secret_storage_unavailable" ? t("settings.secretStorageUnavailable") : t("settings.loadFailed")); setStatusTone("error");
    } finally { setLoading(false); }
  }

  useEffect(() => { void load(); }, [token]);

  async function save() {
    if (busy) return;
    setBusy(true); setStatus("");
    try {
      const body: Record<string, string | boolean> = { enabled, provider };
      if (provider === "resend") body.fromEmail = fromEmail;
      if (provider === "resend" && apiKey.trim()) body.apiKey = apiKey.trim();
      const response = await fetch(endpoint, { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.status || "save_failed");
      setConfig(payload as RecoveryConfig); setApiKey(""); setStatus(t("settings.saved")); setStatusTone("success");
    } catch (error) {
      setStatus(error instanceof Error && error.message === "secret_storage_unavailable" ? t("settings.secretStorageUnavailable") : t("settings.saveFailed")); setStatusTone("error");
    } finally { setBusy(false); }
  }

  async function secretAction(path: "generate-secret" | "rotate-secret") {
    if (busy) return;
    if (path === "rotate-secret" && !window.confirm(t("settings.rotateWarning"))) return;
    setBusy(true); setStatus("");
    try {
      const response = await fetch(`${endpoint}/${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.status || "secret_failed");
      setConfig(payload as RecoveryConfig); setStatus(t("settings.saved")); setStatusTone("success");
    } catch (error) {
      setStatus(error instanceof Error && error.message === "secret_storage_unavailable" ? t("settings.secretStorageUnavailable") : t("settings.saveFailed")); setStatusTone("error");
    } finally { setBusy(false); }
  }

  async function testEmail() {
    if (busy) return;
    setBusy(true); setStatus("");
    try {
      const response = await fetch(`${endpoint}/test`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error("test_failed");
      setStatus(t("settings.emailTestSuccess")); setStatusTone("success");
    } catch (_error) { setStatus(t("settings.emailTestFailed")); setStatusTone("error"); }
    finally { setBusy(false); }
  }

  const advancedContent = loading
    ? <div className="system-settings-skeleton"><i /><i /></div>
    : !config
      ? <div className="settings-error"><p className="form-error">{status}</p><button className="secondary-button compact-button" type="button" onClick={() => void load()}>{t("dashboard.retry")}</button></div>
      : <>
        <div className="system-settings-grid">
          <label className="checkbox-label setting-toggle"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span>{t("settings.passwordRecoveryEnabled")}</span></label>
          <label className="system-setting-field"><span>{t("settings.emailProvider")}</span><select value={provider} onChange={(event) => setProvider(event.target.value as RecoveryConfig["provider"])}><option value="gmail-smtp">{t("settings.gmailSmtp")}</option><option value="resend">Resend</option></select></label>
          {provider === "gmail-smtp" ? <div className="settings-provider-status"><b>{t("settings.smtpCredentials")}</b><span>{provider === config.provider && config.smtpConfigured ? t("settings.configured") : t("settings.notConfigured")}</span><small>{t("settings.smtpCredentialsHint")}</small></div> : <label className="system-setting-field"><span>{t("settings.resendApiKey")}</span><small>{config.apiKeyConfigured ? t("settings.apiKeyConfigured") : t("settings.apiKeyReplace")}</small><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={config.apiKeyConfigured ? t("settings.apiKeyReplace") : "re_..."} autoComplete="new-password" /></label>}
          <label className="system-setting-field"><span>{t("settings.senderName")}</span><input value={config.senderName} readOnly /></label>
          <label className="system-setting-field"><span>{t("settings.senderEmail")}</span><input type="email" value={fromEmail} onChange={(event) => setFromEmail(event.target.value)} placeholder="no-reply@example.com" autoComplete="email" disabled={provider === "gmail-smtp"} /></label>
        </div>
        <div className="settings-secret-status"><span><b>{t("settings.securitySecret")}</b><small>{config.resetSecretConfigured ? t("settings.secretConfigured") : t("settings.secretMissing")}</small></span>{config.resetSecretConfigured ? <button className="secondary-button compact-button" type="button" disabled={busy} onClick={() => void secretAction("rotate-secret")}>{t("settings.rotateSecret")}</button> : <button className="secondary-button compact-button" type="button" disabled={busy} onClick={() => void secretAction("generate-secret")}>{t("settings.generateSecret")}</button>}</div>
        {provider !== config.provider || !config.providerConfigured || !config.resetSecretConfigured ? <p className="form-hint">{t("settings.incompleteRecovery")}</p> : null}
        <div className="system-settings-actions advanced-settings-actions"><span className={statusTone === "error" ? "form-error" : statusTone === "success" ? "lookup-result" : "form-hint"} role={status ? "status" : undefined}>{status || t("settings.secretConfigured")}</span><div className="report-actions"><button className="secondary-button compact-button" type="button" disabled={busy} onClick={() => void testEmail()}>{busy ? t("settings.testingEmail") : t("settings.testEmail")}</button><button className={`primary-button compact-button ${statusTone === "success" ? "success-button" : ""}`} type="button" disabled={busy} onClick={() => void save()}>{busy ? t("settings.savingEmail") : t("settings.saveEmail")}</button></div></div>
      </>;

  return <section className="settings-section settings-advanced-section">
    <button className="settings-accordion-toggle" type="button" aria-expanded={open} aria-controls="advanced-settings-content" onClick={onToggle}>
      <span className="settings-section-heading"><span>06</span><span className="settings-accordion-copy"><strong>{t("settings.advancedTitle")}</strong><small>{t("settings.passwordRecoveryTitle")}</small><small className="settings-advanced-hint">{t("settings.advancedHint")}</small></span></span>
      <ChevronIcon open={open} />
    </button>
    <div id="advanced-settings-content" className={`settings-accordion-content ${open ? "is-open" : ""}`} aria-hidden={!open}><div>{advancedContent}</div></div>
  </section>;
}
