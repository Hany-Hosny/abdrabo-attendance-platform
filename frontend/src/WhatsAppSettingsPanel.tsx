import { useEffect, useMemo, useRef, useState } from "react";

type Language = "ar" | "en";
type Translator = (key: string, values?: Record<string, string>) => string;
type WhatsAppSettings = {
  auto_send: boolean;
  templates: string[];
  grade_templates: string[];
  receipt_templates: string[];
  advance_payment_templates: string[];
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
const TEMPLATE_TOKEN_PATTERN = /\{\{?\s*([a-zA-Z0-9_-]+)\s*\}\}?/gi;

const fallbackTemplates = ["مرحباً بحضرتك، من منصة مستر أحمد عبدربه 👨‍🏫\nتم تسجيل حضور الطالب: {student_name}\nاليوم: {date} الساعة {time} في مجموعة: {group_name}.\nكود الطالب: {student_code}\nتقرير المتابعة: {portal_link}\nالمرجع: {ref_code}", "تنبيه حضور - مستر أحمد عبدربه:\nحضر الطالب {student_name} حصة {group_name} بتاريخ {date} في تمام الساعة {time}.\nرابط ملف المتابعة: {portal_link}\nالمرجع: {ref_code}", "إشعار حضور | مستر أحمد عبدربه\nتم تسجيل حضور {student_name} بنجاح في مجموعة {group_name}.\nالتاريخ: {date} - الوقت: {time}.\nكود الطالب: {student_code}\nتقرير فوري: {portal_link}\nرقم المرجع: {ref_code}"];
const fallbackGradeTemplates = ["نتيجة تقييم - مستر أحمد عبدربه 📝\nمرحباً بحضرتك، تم رصد نتيجة امتحان {exam_title} للطالب: {student_name}.\nالدرجة: {score} من {max_score} (النسبة: {percentage}%).\nكود الطالب: {student_code}\nتقرير الإجابات والتقييم: {portal_link}\nالمرجع: {ref_code}", "إشعار درجات | منصة مستر أحمد عبدربه\nحصل الطالب {student_name} في {exam_title} على نتيجة {score}/{max_score} بمعدل {percentage}%.\nتفاصيل التقييم: {portal_link}\nمع تحيات مستر أحمد عبدربه وإدارة المنصة.\nالمرجع: {ref_code}", "تقييم دراسي - مستر أحمد عبدربه:\nتم تصحيح {exam_title} للطالب {student_name}.\nالنتيجة المحققة: {score} من أصل {max_score}.\nرابط التقرير الكامل: {portal_link}\nكود: {ref_code}"];
const fallbackReceiptTemplates = ["إيصال سداد مصروفات - مستر أحمد عبدربه 🧾\nالسلام عليكم يا فندم، تم استلام مبلغ {amount_paid} ج.م سداداً لمصروفات شهر {month} للطالب: {student_name}.\nرقم الإيصال: {receipt_number}\nكود الطالب: {student_code}\nعرض الإيصال: {portal_link}\nشكراً لتعاونكم الدائم.", "سند قبض إلكتروني | مستر أحمد عبدربه\nتم بنجاح تسجيل دفعة مالية بقيمة {amount_paid} ج.م لحساب الطالب: {student_name} (سداد {month}).\nرقم السند: {receipt_number}\nالسجل المالي: {portal_link}\nالمرجع: {ref_code}", "إشعار تحصيل نقدية - مكتب مستر أحمد عبدربه:\nتم استلام مبلغ {amount_paid} جنيه لمصروفات {month} الخاصة بالطالب {student_name}.\nإيصال رقم: #{receipt_number}.\nمتابعة الحساب: {portal_link}"];
const fallbackAdvancePaymentTemplates = ["إشعار دفع مقدم - مستر أحمد عبدربه 💳\nتم استلام مبلغ {amount_paid} ج.م كدفعة مقدمة للطالب: {student_name} عن شهور: {months}.\nرقم الإيصال: {receipt_number}\nمتابعة الحساب: {portal_link}", "تم بنجاح تسجيل دفعة مالية مقدمة بقيمة {amount_paid} ج.م لحساب الطالب: {student_name}.\nالشهور المسددة: {months}\nسند رقم: {receipt_number}\nالمرجع: {ref_code}", "إيصال استلام نقدية (دفع مقدم) | مستر أحمد عبدربه\nالطالب: {student_name}\nالمبلغ: {amount_paid} جنيه\nالشهور: {months}\nالإيصال: #{receipt_number}\nالرابط: {portal_link}"];

type TemplateKey = "templates" | "grade_templates" | "receipt_templates" | "advance_payment_templates";
type TemplateGroup = {
  key: TemplateKey;
  number: string;
  titleKey: string;
  descriptionKey: string;
  placeholders: string[];
};

const templateGroups: TemplateGroup[] = [
  { key: "templates", number: "03", titleKey: "whatsapp.attendanceTemplatesTitle", descriptionKey: "whatsapp.attendanceTemplatesDescription", placeholders: ["{student_name}", "{student_code}", "{date}", "{time}", "{group_name}", "{ref_code}", "{portal_link}"] },
  { key: "grade_templates", number: "04", titleKey: "whatsapp.gradeTemplatesTitle", descriptionKey: "whatsapp.gradeTemplatesDescription", placeholders: ["{student_name}", "{student_code}", "{exam_title}", "{score}", "{max_score}", "{percentage}", "{portal_link}", "{ref_code}"] },
  { key: "receipt_templates", number: "05", titleKey: "whatsapp.receiptTemplatesTitle", descriptionKey: "whatsapp.receiptTemplatesDescription", placeholders: ["{student_name}", "{student_code}", "{amount_paid}", "{month}", "{receipt_number}", "{portal_link}", "{ref_code}"] },
  { key: "advance_payment_templates", number: "06", titleKey: "whatsapp.advancePaymentTemplatesTitle", descriptionKey: "whatsapp.advancePaymentTemplatesDescription", placeholders: ["{student_name}", "{student_code}", "{amount_paid}", "{months}", "{receipt_number}", "{portal_link}", "{ref_code}"] }
];

const defaultSettings: WhatsAppSettings = {
  auto_send: false,
  templates: fallbackTemplates,
  grade_templates: fallbackGradeTemplates,
  receipt_templates: fallbackReceiptTemplates,
  advance_payment_templates: fallbackAdvancePaymentTemplates,
  min_delay_seconds: 4,
  max_delay_seconds: 8
};

function normalizeSettings(value: Partial<WhatsAppSettings> | undefined): WhatsAppSettings {
  const normalizeTemplates = (input: string[] | undefined, fallback: string[], requiredPlaceholder: string) => {
    const templates = Array.isArray(input) ? input.map((item) => String(item ?? "").trim()).filter(Boolean).slice(0, 4) : [];
    const placeholderKey = requiredPlaceholder.replace(/^\{+|\}+$/g, "").trim().toLowerCase();
    const hasPlaceholder = (template: string) => Array.from(template.matchAll(TEMPLATE_TOKEN_PATTERN))
      .some((match) => match[1].toLowerCase() === placeholderKey);
    return templates.length >= 3 && templates.every(hasPlaceholder) ? templates : [...fallback];
  };
  return {
    auto_send: value?.auto_send === true,
    templates: normalizeTemplates(value?.templates, fallbackTemplates, "{student_name}"),
    grade_templates: normalizeTemplates(value?.grade_templates, fallbackGradeTemplates, "{exam_title}"),
    receipt_templates: normalizeTemplates(value?.receipt_templates, fallbackReceiptTemplates, "{amount_paid}"),
    advance_payment_templates: normalizeTemplates(value?.advance_payment_templates, fallbackAdvancePaymentTemplates, "{months}"),
    min_delay_seconds: Number.isInteger(Number(value?.min_delay_seconds)) ? Number(value?.min_delay_seconds) : 4,
    max_delay_seconds: Number.isInteger(Number(value?.max_delay_seconds)) ? Number(value?.max_delay_seconds) : 8,
    portal_base_url: String(value?.portal_base_url || window.location.origin).replace(/\/+$/, "")
  };
}

function ChevronIcon({ open }: { open: boolean }) {
  return <svg className={`whatsapp-template-accordion-icon ${open ? "is-open" : ""}`} viewBox="0 0 24 24" aria-hidden="true"><path d={open ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} /></svg>;
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
  const [openTemplateGroups, setOpenTemplateGroups] = useState<Record<TemplateKey, boolean>>({ templates: false, grade_templates: false, receipt_templates: false, advance_payment_templates: false });
  const textareaRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
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

  function updateTemplate(group: TemplateKey, index: number, value: string) {
    if (!canManage) return;
    setFeedback("idle");
    setSettings((current) => ({ ...current, [group]: current[group].map((template, templateIndex) => templateIndex === index ? value : template) }));
  }

  function insertPlaceholder(group: TemplateKey, index: number, placeholder: string) {
    if (!canManage) return;
    const refKey = `${group}-${index}`;
    const textarea = textareaRefs.current[refKey];
    const current = settings[group][index] || "";
    const start = textarea?.selectionStart ?? current.length;
    const end = textarea?.selectionEnd ?? start;
    const next = `${current.slice(0, start)}${placeholder}${current.slice(end)}`;
    updateTemplate(group, index, next);
    window.setTimeout(() => {
      const element = textareaRefs.current[refKey];
      if (!element) return;
      const cursor = start + placeholder.length;
      element.focus();
      element.setSelectionRange(cursor, cursor);
    }, 0);
  }

  function applyDelayPreset(min: number, max: number) {
    if (!canManage) return;
    setFeedback("idle");
    setSettings((current) => ({ ...current, min_delay_seconds: min, max_delay_seconds: max }));
  }

  function toggleTemplateGroup(group: TemplateKey) {
    setOpenTemplateGroups((current) => ({ ...current, [group]: !current[group] }));
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
        <div className="whatsapp-delay-card"><div><strong>{t("whatsapp.delayLabel")}</strong><small>{t("whatsapp.delayDescription")}</small></div><div className="whatsapp-delay-control"><div className="whatsapp-delay-fields"><label><span>{t("whatsapp.minimum")}</span><input disabled={!canManage} type="number" min="2" max="60" value={settings.min_delay_seconds} onChange={(event) => { setFeedback("idle"); setSettings((current) => ({ ...current, min_delay_seconds: Number(event.target.value) })); }} /><em>{t("whatsapp.seconds")}</em></label><span>—</span><label><span>{t("whatsapp.maximum")}</span><input disabled={!canManage} type="number" min="2" max="60" value={settings.max_delay_seconds} onChange={(event) => { setFeedback("idle"); setSettings((current) => ({ ...current, max_delay_seconds: Number(event.target.value) })); }} /><em>{t("whatsapp.seconds")}</em></label></div><div className="whatsapp-delay-presets">{[[3, 6, "whatsapp.presetFast"], [5, 12, "whatsapp.presetBalanced"], [10, 30, "whatsapp.presetSafe"]].map(([min, max, label]) => <button className={settings.min_delay_seconds === min && settings.max_delay_seconds === max ? "active" : ""} key={label} type="button" disabled={!canManage} onClick={() => applyDelayPreset(Number(min), Number(max))}>{t(label as string)}</button>)}</div></div></div>
      </div>
    </section>

    <section className="whatsapp-templates-section">
      <div className="settings-section-heading"><span>03–06</span><div><h3>{t("whatsapp.templatesTitle")}</h3><p>{t("whatsapp.templatesDescription")}</p></div></div>
      <div className="whatsapp-template-groups">
        {templateGroups.map((group) => {
          const isOpen = openTemplateGroups[group.key];
          const templates = settings[group.key];
          const contentId = `whatsapp-${group.key}-content`;
          return <article className={`whatsapp-template-accordion ${isOpen ? "is-open" : ""}`} key={group.key}>
            <button className="whatsapp-template-accordion-toggle" type="button" aria-expanded={isOpen} aria-controls={contentId} onClick={() => toggleTemplateGroup(group.key)}>
              <span className="whatsapp-template-accordion-heading"><span className="whatsapp-template-number">{group.number}</span><span className="whatsapp-template-accordion-copy"><strong>{t(group.titleKey)}</strong><small>{t(group.descriptionKey)}</small><span className="whatsapp-template-accordion-badge">{t("whatsapp.activeTemplates", { count: String(templates.length) })}</span></span></span>
              <ChevronIcon open={isOpen} />
            </button>
            <div className={`whatsapp-template-accordion-content ${isOpen ? "is-open" : ""}`} id={contentId} aria-hidden={!isOpen}>
              <div className="whatsapp-template-accordion-inner">
                <div className="whatsapp-template-list">{templates.map((template, index) => { const refKey = `${group.key}-${index}`; return <label className="whatsapp-template-card" key={index}><span className="whatsapp-template-number">{String(index + 1).padStart(2, "0")}</span><strong>{t("whatsapp.templateLabel", { number: String(index + 1) })}</strong><textarea ref={(element) => { textareaRefs.current[refKey] = element; }} disabled={!canManage} dir="auto" value={template} onChange={(event) => updateTemplate(group.key, index, event.target.value)} maxLength={2000} /><span className="whatsapp-placeholder-label">{t("whatsapp.placeholders")}</span><div className="whatsapp-placeholder-chips">{group.placeholders.map((placeholder) => { const isUsed = template.includes(placeholder); return <button className={isUsed ? "is-used" : ""} disabled={!canManage || isUsed} type="button" key={placeholder} aria-label={isUsed ? `Used ${placeholder}` : `Insert ${placeholder}`} onClick={() => insertPlaceholder(group.key, index, placeholder)}>{isUsed ? `✓ ${placeholder}` : placeholder}</button>; })}</div></label>; })}</div>
                {group.key === "templates" ? <div className="whatsapp-preview-box"><div><strong>{t("whatsapp.previewTitle")}</strong><small>{t("whatsapp.previewDescription")}</small></div><p>{previewParts.map((part, index) => <span key={`${part}-${index}`}>{index ? <a href={portalLink} target="_blank" rel="noreferrer">{portalLink}</a> : null}{part}</span>)}</p></div> : null}
              </div>
            </div>
          </article>;
        })}
      </div>
      <div className="whatsapp-save-row"><span className={feedback === "error" ? "form-error" : feedback === "saved" ? "lookup-result" : "form-hint"} role={feedback !== "idle" ? "status" : undefined}>{feedback === "saved" ? t("whatsapp.saved") : feedback === "error" ? t("whatsapp.saveFailed") : t("whatsapp.saveHint")}</span><button className={`primary-button ${feedback === "saved" ? "success-button" : ""}`} type="button" disabled={!canManage || saving || !dirty} onClick={() => void save()}>{saving ? t("whatsapp.saving") : feedback === "saved" ? t("whatsapp.saved") : t("whatsapp.save")}</button></div>
    </section>
  </section>;
}
