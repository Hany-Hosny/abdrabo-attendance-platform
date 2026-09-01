import { useEffect, useMemo, useState } from "react";

type Language = "ar" | "en";
type Translator = (key: string, values?: Record<string, string>) => string;
type Settings = {
  attendance_open_before_minutes: number;
  attendance_close_after_minutes: number;
  attendance_alert_threshold: number;
  evaluation_alert_threshold: number;
};

type Props = { token: string; language: Language; t: Translator };

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

export function SystemSettingsPanel({ token, language, t }: Props) {
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
    <div className="system-settings-actions"><span className={status === "error" ? "form-error" : "form-hint"} role={status === "saved" || status === "error" ? "status" : undefined}>{status === "saved" ? t("settings.saved") : error || t("settings.safeDefaults")}</span><button className={`primary-button ${status === "saved" ? "success-button" : ""}`} type="button" disabled={saving || !dirty} onClick={save}>{saving ? t("settings.saving") : status === "saved" ? t("settings.saved") : t("settings.save")}</button></div>
  </section>;
}
