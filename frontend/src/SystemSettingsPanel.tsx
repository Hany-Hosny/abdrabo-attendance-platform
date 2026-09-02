import { useEffect, useMemo, useState } from "react";

type Language = "ar" | "en";
type Translator = (key: string, values?: Record<string, string>) => string;
type Settings = {
  attendance_open_before_minutes: number;
  attendance_close_after_minutes: number;
  attendance_alert_threshold: number;
  evaluation_alert_threshold: number;
};

type Props = { token: string; language: Language; isOwner?: boolean; t: Translator };

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_URL || "/api";
const defaultSettings: Settings = {
  attendance_open_before_minutes: 3,
  attendance_close_after_minutes: 20,
  attendance_alert_threshold: 70,
  evaluation_alert_threshold: 60
};

function normalizeSettings(value: Partial<Settings> | undefined): Settings {
  return Object.fromEntries(Object.keys(defaultSettings).map((key) => {
    const settingKey = key as keyof Settings;
    const numericValue = Number(value?.[settingKey]);
    return [settingKey, Number.isFinite(numericValue) ? numericValue : defaultSettings[settingKey]];
  })) as Settings;
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
    <div className="section-heading system-settings-heading"><div><p className="eyebrow">{t("admin.tabs.settings")}</p><h2>{t("settings.title")}</h2><p>{t("settings.subtitle")}</p></div><span className="settings-lock-mark" aria-hidden="true">⚙</span></div>
    <div className="settings-sections">
      <section className="settings-section settings-section-readonly"><div className="settings-section-heading"><span>01</span><div><h3>{t("settings.generalTitle")}</h3><p>{t("settings.generalDescription")}</p></div></div><div className="settings-note-grid"><div><strong>{t("settings.brandingSource")}</strong><span>{t("settings.brandingSourceDescription")}</span></div><div><strong>{t("settings.currencyLabel")}</strong><span>EGP · {t("settings.currencyDescription")}</span></div></div></section>
      <section className="settings-section"><div className="settings-section-heading"><span>02</span><div><h3>{t("settings.attendanceTitle")}</h3><p>{t("settings.attendanceDescription")}</p></div></div><div className="system-settings-grid"><NumberSetting label={t("settings.openBeforeLabel")} description={t("settings.openBeforeDescription")} value={settings.attendance_open_before_minutes} min={0} max={180} suffix={t("settings.minutes")} onChange={(value) => update("attendance_open_before_minutes", value)} /><NumberSetting label={t("settings.closeAfterLabel")} description={t("settings.closeAfterDescription")} value={settings.attendance_close_after_minutes} min={0} max={240} suffix={t("settings.minutes")} onChange={(value) => update("attendance_close_after_minutes", value)} /><NumberSetting label={t("settings.attendanceAlertLabel")} description={t("settings.attendanceAlertDescription")} value={settings.attendance_alert_threshold} min={0} max={100} suffix="%" onChange={(value) => update("attendance_alert_threshold", value)} /></div></section>
      <section className="settings-section"><div className="settings-section-heading"><span>03</span><div><h3>{t("settings.evaluationTitle")}</h3><p>{t("settings.evaluationDescription")}</p></div></div><div className="system-settings-grid system-settings-grid-single"><NumberSetting label={t("settings.evaluationAlertLabel")} description={t("settings.evaluationAlertDescription")} value={settings.evaluation_alert_threshold} min={0} max={100} suffix="%" onChange={(value) => update("evaluation_alert_threshold", value)} /></div></section>
      <section className="settings-section settings-section-readonly"><div className="settings-section-heading"><span>04</span><div><h3>{t("settings.paymentsTitle")}</h3><p>{t("settings.paymentsDescription")}</p></div></div><div className="settings-note-grid"><div><strong>{t("settings.paymentFeesSource")}</strong><span>{t("settings.paymentFeesSourceDescription")}</span></div><div><strong>{t("settings.reversalSource")}</strong><span>{t("settings.reversalSourceDescription")}</span></div></div></section>
    </div>
    {isOwner ? <AdvancedPasswordRecoveryPanel token={token} t={t} /> : null}
    <div className="system-settings-actions"><span className={status === "error" ? "form-error" : "form-hint"} role={status === "saved" || status === "error" ? "status" : undefined}>{status === "saved" ? t("settings.saved") : error || t("settings.safeDefaults")}</span><button className={`primary-button ${status === "saved" ? "success-button" : ""}`} type="button" disabled={saving || !dirty} onClick={save}>{saving ? t("settings.saving") : status === "saved" ? t("settings.saved") : t("settings.save")}</button></div>
  </section>;
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

function AdvancedPasswordRecoveryPanel({ token, t }: { token: string; t: Translator }) {
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

  if (loading) return <section className="settings-section settings-advanced-section"><div className="system-settings-skeleton"><i /><i /></div></section>;
  if (!config) return <section className="settings-section settings-advanced-section"><p className="form-error">{status}</p><button className="secondary-button compact-button" type="button" onClick={() => void load()}>{t("dashboard.retry")}</button></section>;
  return <section className="settings-section settings-advanced-section">
    <div className="settings-section-heading"><span>05</span><div><h3>{t("settings.advancedTitle")}</h3><p>{t("settings.passwordRecoveryTitle")}</p></div></div>
    <div className="system-settings-grid">
      <label className="checkbox-label setting-toggle"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span>{t("settings.passwordRecoveryEnabled")}</span></label>
      <label className="system-setting-field"><span>{t("settings.emailProvider")}</span><select value={provider} onChange={(event) => setProvider(event.target.value as RecoveryConfig["provider"])}><option value="gmail-smtp">{t("settings.gmailSmtp")}</option><option value="resend">Resend</option></select></label>
      {provider === "gmail-smtp" ? <div className="settings-provider-status"><b>{t("settings.smtpCredentials")}</b><span>{provider === config.provider && config.smtpConfigured ? t("settings.configured") : t("settings.notConfigured")}</span><small>{t("settings.smtpCredentialsHint")}</small></div> : <label className="system-setting-field"><span>{t("settings.resendApiKey")}</span><small>{config.apiKeyConfigured ? t("settings.apiKeyConfigured") : t("settings.apiKeyReplace")}</small><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={config.apiKeyConfigured ? t("settings.apiKeyReplace") : "re_..."} autoComplete="new-password" /></label>}
      <label className="system-setting-field"><span>{t("settings.senderName")}</span><input value={config.senderName} readOnly /></label>
      <label className="system-setting-field"><span>{t("settings.senderEmail")}</span><input type="email" value={fromEmail} onChange={(event) => setFromEmail(event.target.value)} placeholder="no-reply@example.com" autoComplete="email" disabled={provider === "gmail-smtp"} /></label>
    </div>
    <div className="settings-secret-status"><span><b>{t("settings.securitySecret")}</b><small>{config.resetSecretConfigured ? t("settings.secretConfigured") : t("settings.secretMissing")}</small></span>{config.resetSecretConfigured ? <button className="secondary-button compact-button" type="button" disabled={busy} onClick={() => void secretAction("rotate-secret")}>{t("settings.rotateSecret")}</button> : <button className="secondary-button compact-button" type="button" disabled={busy} onClick={() => void secretAction("generate-secret")}>{t("settings.generateSecret")}</button>}</div>
    {provider !== config.provider || !config.providerConfigured || !config.resetSecretConfigured ? <p className="form-hint">{t("settings.incompleteRecovery")}</p> : null}
    <div className="system-settings-actions advanced-settings-actions"><span className={statusTone === "error" ? "form-error" : statusTone === "success" ? "lookup-result" : "form-hint"} role={status ? "status" : undefined}>{status || t("settings.secretConfigured")}</span><div className="report-actions"><button className="secondary-button compact-button" type="button" disabled={busy} onClick={() => void testEmail()}>{busy ? t("settings.testingEmail") : t("settings.testEmail")}</button><button className={`primary-button compact-button ${statusTone === "success" ? "success-button" : ""}`} type="button" disabled={busy} onClick={() => void save()}>{busy ? t("settings.saving") : t("settings.save")}</button></div></div>
  </section>;
}
