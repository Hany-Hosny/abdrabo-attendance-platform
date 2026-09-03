import { useEffect, useMemo, useState } from "react";

type Language = "ar" | "en";
type Translator = (key: string, values?: Record<string, string>) => string;
type WhatsAppSettings = {
  auto_send: boolean;
  templates: string[];
  min_delay_seconds: number;
  max_delay_seconds: number;
  portal_base_url?: string;
};
type WhatsAppStatus = {
  status: "disconnected" | "connecting" | "connected";
  phone_number: string | null;
  has_qr?: boolean;
};
type Props = { token: string; language: Language; canManage?: boolean; t: Translator };

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_URL || "/api";
const PLACEHOLDERS = ["{student_name}", "{student_code}", "{date}", "{time}", "{group_name}", "{ref_code}", "{portal_link}"];
const fallbackTemplates = ["{student_name} ({student_code}) · {group_name} · {date} · {time}\n{portal_link}\n{ref_code}", "{student_name} attended {group_name} at {time} on {date}.\nPortal: {portal_link}\nRef: {ref_code}", "Attendance recorded for {student_name} ({group_name}) — {date} {time}\nStudent code: {student_code}\n{portal_link}\n{ref_code}"];

const defaultSettings: WhatsAppSettings = {
  auto_send: false,
  templates: fallbackTemplates,
  min_delay_seconds: 4,
  max_delay_seconds: 8
};

function normalizeSettings(value: Partial<WhatsAppSettings> | undefined): WhatsAppSettings {
  const templates = Array.isArray(value?.templates) ? value.templates.map((item) => String(item ?? "")).slice(0, 4) : [];
  return {
    auto_send: value?.auto_send === true,
    templates: [...templates, ...fallbackTemplates].slice(0, 3),
    min_delay_seconds: Number.isInteger(Number(value?.min_delay_seconds)) ? Number(value?.min_delay_seconds) : 4,
    max_delay_seconds: Number.isInteger(Number(value?.max_delay_seconds)) ? Number(value?.max_delay_seconds) : 8,
    portal_base_url: String(value?.portal_base_url || window.location.origin).replace(/\/+$/, "")
  };
}

export function WhatsAppSettingsPanel({ token, language, canManage = false, t }: Props) {
  const [status, setStatus] = useState<WhatsAppStatus>({ status: "disconnected", phone_number: null });
  const [settings, setSettings] = useState<WhatsAppSettings>(defaultSettings);
  const [savedSettings, setSavedSettings] = useState<WhatsAppSettings>(defaultSettings);
  const [qr, setQr] = useState("");
  const [loading, setLoading] = useState(true);
  const [pairing, setPairing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<"idle" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  const dirty = useMemo(() => JSON.stringify(settings) !== JSON.stringify(savedSettings), [settings, savedSettings]);

  async function loadStatus() {
    const response = await fetch(`${API_BASE_URL}/whatsapp/status`, { headers: { Authorization: `Bearer ${token}` } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error("status_failed");
    setStatus({ status: payload.status, phone_number: payload.phone_number || null, has_qr: payload.has_qr });
    if (payload.status === "connected") setQr("");
  }

  async function loadSettings() {
    const response = await fetch(`${API_BASE_URL}/whatsapp/settings`, { headers: { Authorization: `Bearer ${token}` } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) throw new Error("settings_failed");
    const next = normalizeSettings(payload.settings);
    setSettings(next);
    setSavedSettings(next);
  }

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      fetch(`${API_BASE_URL}/whatsapp/status`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal }).then((response) => response.json()),
      fetch(`${API_BASE_URL}/whatsapp/settings`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal }).then((response) => response.json())
    ]).then(([statusPayload, settingsPayload]) => {
      if (!statusPayload.ok || !settingsPayload.ok) throw new Error("load_failed");
      setStatus({ status: statusPayload.status, phone_number: statusPayload.phone_number || null, has_qr: statusPayload.has_qr });
      const next = normalizeSettings(settingsPayload.settings);
      setSettings(next); setSavedSettings(next); setError("");
    }).catch((reason) => { if (reason?.name !== "AbortError") setError(t("whatsapp.loadFailed")); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token]);

  useEffect(() => {
    if (status.status === "connected") return undefined;
    const interval = window.setInterval(() => { void loadStatus().catch(() => undefined); }, 2000);
    return () => window.clearInterval(interval);
  }, [status.status, token]);

  async function startPairing() {
    if (!canManage || pairing || status.status === "connected") return;
    setPairing(true); setError("");
    try {
      const response = await fetch(`${API_BASE_URL}/whatsapp/qr`, { headers: { Authorization: `Bearer ${token}` } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error("pairing_failed");
      setStatus({ status: payload.status, phone_number: payload.phone_number || null, has_qr: payload.has_qr });
      setQr(payload.qr || "");
    } catch (_error) { setError(t("whatsapp.connectionFailed")); }
    finally { setPairing(false); }
  }

  async function disconnect() {
    if (!canManage || disconnecting) return;
    setDisconnecting(true); setError("");
    try {
      const response = await fetch(`${API_BASE_URL}/whatsapp/disconnect`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error("disconnect_failed");
      setStatus({ status: "disconnected", phone_number: null }); setQr("");
    } catch (_error) { setError(t("whatsapp.connectionFailed")); }
    finally { setDisconnecting(false); }
  }

  async function save() {
    if (!canManage || saving || !dirty) return;
    setSaving(true); setFeedback("idle"); setError("");
    try {
      const response = await fetch(`${API_BASE_URL}/whatsapp/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ settings })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error("save_failed");
      const next = normalizeSettings(payload.settings);
      setSettings(next); setSavedSettings(next); setFeedback("saved");
      window.setTimeout(() => setFeedback("idle"), 2200);
    } catch (_error) { setFeedback("error"); setError(t("whatsapp.saveFailed")); }
    finally { setSaving(false); }
  }

  function updateTemplate(index: number, value: string) {
    if (!canManage) return;
    setFeedback("idle");
    setSettings((current) => ({ ...current, templates: current.templates.map((template, templateIndex) => templateIndex === index ? value : template) }));
  }

  const portalLink = `${settings.portal_base_url || window.location.origin}/student/A-1001`;
  const previewTextWithoutLink = (settings.templates[0] || "")
    .replace(/\{student_name\}/g, t("whatsapp.sampleStudent"))
    .replace(/\{student_code\}/g, "A-1001")
    .replace(/\{date\}/g, "04/09/2026")
    .replace(/\{time\}/g, "06:00 PM")
    .replace(/\{group_name\}/g, t("whatsapp.sampleGroup"))
    .replace(/\{ref_code\}/g, "ATT-20260904-1001")
    .replace(/\{portal_link\}/g, portalLink);
  const previewText = previewTextWithoutLink.includes(portalLink) ? previewTextWithoutLink : `${previewTextWithoutLink}\n${portalLink}`;
  const previewParts = previewText.split(portalLink);

  if (loading) return <section className="admin-editor whatsapp-settings-panel"><div className="section-heading"><p className="eyebrow">{t("admin.tabs.whatsapp")}</p><h2>{t("whatsapp.title")}</h2></div><div className="system-settings-skeleton" aria-hidden="true"><i /><i /><i /></div></section>;

  return <section className="admin-editor whatsapp-settings-panel" dir={language === "ar" ? "rtl" : "ltr"}>
    <div className="section-heading whatsapp-settings-heading"><div><p className="eyebrow">{t("admin.tabs.whatsapp")}</p><h2>{t("whatsapp.title")}</h2><p>{t("whatsapp.subtitle")}</p></div><span className="whatsapp-heading-mark" aria-hidden="true">◉</span></div>

    {error ? <div className="settings-error whatsapp-inline-error" role="alert"><p>{error}</p></div> : null}

    <section className="whatsapp-connection-card">
      <div className="whatsapp-card-heading"><div><p className="eyebrow">01</p><h3>{t("whatsapp.connectionTitle")}</h3><p>{t("whatsapp.connectionDescription")}</p></div><span className={`whatsapp-status-badge ${status.status}`}><i aria-hidden="true" />{t(`whatsapp.status.${status.status}`)}</span></div>
      <div className="whatsapp-connection-body">
        <div className="whatsapp-connection-copy">
          <strong>{status.phone_number ? t("whatsapp.connectedAs", { phone: status.phone_number }) : t("whatsapp.noPhone")}</strong>
          <small>{status.status === "connected" ? t("whatsapp.readyDescription") : t("whatsapp.pairDescription")}</small>
          <div className="whatsapp-connection-actions">
            {canManage ? (status.status === "connected" ? <button className="secondary-button" type="button" disabled={disconnecting} onClick={() => void disconnect()}>{disconnecting ? t("whatsapp.disconnecting") : t("whatsapp.disconnect")}</button> : <button className="primary-button" type="button" disabled={pairing} onClick={() => void startPairing()}>{pairing ? t("whatsapp.connecting") : t("whatsapp.connect")}</button>) : <small className="whatsapp-view-only">{t("whatsapp.viewOnly")}</small>}
          </div>
        </div>
        {status.status !== "connected" && (qr || status.status === "connecting") ? <div className="whatsapp-qr-panel"><div className="whatsapp-qr-frame">{qr ? <img src={qr} alt={t("whatsapp.qrAlt")} /> : <span className="whatsapp-qr-loading">{t("whatsapp.qrLoading")}</span>}</div><small>{t("whatsapp.qrHint")}</small></div> : null}
      </div>
    </section>

    <section className="whatsapp-automation-section">
      <div className="settings-section-heading"><span>02</span><div><h3>{t("whatsapp.automationTitle")}</h3><p>{t("whatsapp.automationDescription")}</p></div></div>
      <div className="whatsapp-automation-grid">
        <label className="whatsapp-toggle-card"><span><strong>{t("whatsapp.autoSendLabel")}</strong><small>{t("whatsapp.autoSendDescription")}</small></span><input type="checkbox" disabled={!canManage} checked={settings.auto_send} onChange={(event) => { setFeedback("idle"); setSettings((current) => ({ ...current, auto_send: event.target.checked })); }} /><i aria-hidden="true" /></label>
        <div className="whatsapp-delay-card"><div><strong>{t("whatsapp.delayLabel")}</strong><small>{t("whatsapp.delayDescription")}</small></div><div className="whatsapp-delay-fields"><label><span>{t("whatsapp.minimum")}</span><input disabled={!canManage} type="number" min="4" max="8" value={settings.min_delay_seconds} onChange={(event) => setSettings((current) => ({ ...current, min_delay_seconds: Number(event.target.value) }))} /><em>{t("whatsapp.seconds")}</em></label><span>—</span><label><span>{t("whatsapp.maximum")}</span><input disabled={!canManage} type="number" min="4" max="8" value={settings.max_delay_seconds} onChange={(event) => setSettings((current) => ({ ...current, max_delay_seconds: Number(event.target.value) }))} /><em>{t("whatsapp.seconds")}</em></label></div></div>
      </div>
    </section>

    <section className="whatsapp-templates-section">
      <div className="settings-section-heading"><span>03</span><div><h3>{t("whatsapp.templatesTitle")}</h3><p>{t("whatsapp.templatesDescription")}</p></div></div>
      <div className="whatsapp-template-list">{settings.templates.map((template, index) => <label className="whatsapp-template-card" key={index}><span className="whatsapp-template-number">{String(index + 1).padStart(2, "0")}</span><strong>{t("whatsapp.templateLabel", { number: String(index + 1) })}</strong><textarea disabled={!canManage} dir="auto" value={template} onChange={(event) => updateTemplate(index, event.target.value)} maxLength={2000} /><span className="whatsapp-placeholder-label">{t("whatsapp.placeholders")}</span><div className="whatsapp-placeholder-chips">{PLACEHOLDERS.map((placeholder) => <button disabled={!canManage} type="button" key={placeholder} onClick={() => updateTemplate(index, `${template}${template && !template.endsWith(" ") ? " " : ""}${placeholder}`)}>{placeholder}</button>)}</div></label>)}</div>
      <div className="whatsapp-preview-box"><div><strong>{t("whatsapp.previewTitle")}</strong><small>{t("whatsapp.previewDescription")}</small></div><p>{previewParts.map((part, index) => <span key={`${part}-${index}`}>{index ? <a href={portalLink} target="_blank" rel="noreferrer">{portalLink}</a> : null}{part}</span>)}</p></div>
      <div className="whatsapp-save-row"><span className={feedback === "error" ? "form-error" : feedback === "saved" ? "lookup-result" : "form-hint"} role={feedback !== "idle" ? "status" : undefined}>{feedback === "saved" ? t("whatsapp.saved") : feedback === "error" ? t("whatsapp.saveFailed") : t("whatsapp.saveHint")}</span><button className={`primary-button ${feedback === "saved" ? "success-button" : ""}`} type="button" disabled={!canManage || saving || !dirty} onClick={() => void save()}>{saving ? t("whatsapp.saving") : feedback === "saved" ? t("whatsapp.saved") : t("whatsapp.save")}</button></div>
    </section>
  </section>;
}
