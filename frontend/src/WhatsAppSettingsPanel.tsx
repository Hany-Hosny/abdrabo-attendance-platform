import { useEffect, useMemo, useRef, useState } from "react";

type Language = "ar" | "en";
type Translator = (key: string, values?: Record<string, string>) => string;
type WhatsAppSettings = {
  auto_send: boolean;
  templates: string[];
  grade_templates: string[];
  receipt_templates: string[];
  advance_payment_templates: string[];
  absence_templates: string[];
  min_delay_seconds: number;
  max_delay_seconds: number;
  portal_base_url?: string;
};
type WhatsAppStatus = {
  status: "disconnected" | "connecting" | "connected";
  phone_number: string | null;
  has_qr?: boolean;
};
type Props = { token: string; language: Language; canManage?: boolean; canControlConnection?: boolean; t: Translator };
type WhatsAppHistoryRow = {
  id: number;
  notification_type: string;
  phone_number: string;
  status: string;
  attempts: number;
  ref_code: string;
  template_index: number | null;
  template_text: string;
  rendered_message: string;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
  student_name: string | null;
  student_code: string | null;
};

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_URL || "/api";
const TEMPLATE_TOKEN_PATTERN = /\{\{?\s*([a-zA-Z0-9_-]+)\s*\}\}?/gi;
const normalizeTeacherDisplayName = (value: string) => value.replace(/مستر أحمد عبدربه/g, "Mr. Ahmed Abdrabo");

function templateUsesPlaceholder(template: string, placeholder: string) {
  const key = placeholder.replace(/^\{+|\}+$/g, "").trim().toLowerCase();
  return Array.from(String(template || "").matchAll(TEMPLATE_TOKEN_PATTERN))
    .some((match) => match[1].toLowerCase() === key);
}

const fallbackTemplates = ["مرحباً بحضرتك، من منصة مستر أحمد عبدربه 👨‍🏫\nتم تسجيل حضور الطالب: {student_name}\nاليوم: {date} الساعة {time} في مجموعة: {group_name}.\nكود الطالب: {student_code}\nتقرير المتابعة: {portal_link}\nالمرجع: {ref_code}", "تنبيه حضور - مستر أحمد عبدربه:\nحضر الطالب {student_name} حصة {group_name} بتاريخ {date} في تمام الساعة {time}.\nرابط ملف المتابعة: {portal_link}\nالمرجع: {ref_code}", "إشعار حضور | مستر أحمد عبدربه\nتم تسجيل حضور {student_name} بنجاح في مجموعة {group_name}.\nالتاريخ: {date} - الوقت: {time}.\nكود الطالب: {student_code}\nتقرير فوري: {portal_link}\nرقم المرجع: {ref_code}"];
const fallbackGradeTemplates = ["نتيجة تقييم - مستر أحمد عبدربه 📝\nمرحباً بحضرتك، تم رصد نتيجة امتحان {exam_title} للطالب: {student_name}.\nالدرجة: {score} من {max_score} (النسبة: {percentage}%).\nكود الطالب: {student_code}\nتقرير الإجابات والتقييم: {portal_link}\nالمرجع: {ref_code}", "إشعار درجات | منصة مستر أحمد عبدربه\nحصل الطالب {student_name} في {exam_title} على نتيجة {score}/{max_score} بمعدل {percentage}%.\nتفاصيل التقييم: {portal_link}\nمع تحيات مستر أحمد عبدربه وإدارة المنصة.\nالمرجع: {ref_code}", "تقييم دراسي - مستر أحمد عبدربه:\nتم تصحيح {exam_title} للطالب {student_name}.\nالنتيجة المحققة: {score} من أصل {max_score}.\nرابط التقرير الكامل: {portal_link}\nكود: {ref_code}"];
const fallbackReceiptTemplates = ["إيصال سداد مصروفات - مستر أحمد عبدربه 🧾\nالسلام عليكم يا فندم، تم استلام مبلغ {amount_paid} ج.م سداداً لمصروفات شهر {month} للطالب: {student_name}.\nرقم الإيصال: {receipt_number}\nكود الطالب: {student_code}\nعرض الإيصال: {portal_link}\nشكراً لتعاونكم الدائم.", "سند قبض إلكتروني | مستر أحمد عبدربه\nتم بنجاح تسجيل دفعة مالية بقيمة {amount_paid} ج.م لحساب الطالب: {student_name} (سداد {month}).\nرقم السند: {receipt_number}\nالسجل المالي: {portal_link}\nالمرجع: {ref_code}", "إشعار تحصيل نقدية - مكتب مستر أحمد عبدربه:\nتم استلام مبلغ {amount_paid} جنيه لمصروفات {month} الخاصة بالطالب {student_name}.\nإيصال رقم: #{receipt_number}.\nمتابعة الحساب: {portal_link}"];
const fallbackAdvancePaymentTemplates = ["إشعار دفع مقدم - مستر أحمد عبدربه 💳\nتم استلام مبلغ {amount_paid} ج.م كدفعة مقدمة للطالب: {student_name} عن شهور: {months}.\nرقم الإيصال: {receipt_number}\nمتابعة الحساب: {portal_link}", "تم بنجاح تسجيل دفعة مالية مقدمة بقيمة {amount_paid} ج.م لحساب الطالب: {student_name}.\nالشهور المسددة: {months}\nسند رقم: {receipt_number}\nالمرجع: {ref_code}", "إيصال استلام نقدية (دفع مقدم) | مستر أحمد عبدربه\nالطالب: {student_name}\nالمبلغ: {amount_paid} جنيه\nالشهور: {months}\nالإيصال: #{receipt_number}\nالرابط: {portal_link}"];
const fallbackAbsenceTemplates = ["تنبيه غياب - منصة مستر أحمد عبدربه\nلم يتم تسجيل حضور الطالب {student_name} في مجموعة {group_name} بتاريخ {date}.\nبرجاء التواصل مع إدارة المنصة.", "إشعار غياب الطالب {student_name}\nنحيط حضرتكم علماً بعدم تسجيل حضور الطالب في حصة {group_name} بتاريخ {date}.", "متابعة الحضور | {student_name}\nتم إغلاق جلسة {group_name} بتاريخ {date} دون تسجيل حضور الطالب."];

type TemplateKey = "templates" | "grade_templates" | "receipt_templates" | "advance_payment_templates" | "absence_templates";
type WhatsAppTemplateRow = { id: number; category: string; message_body: string; is_active?: boolean };
type TemplateGroup = {
  key: TemplateKey;
  number: string;
  titleKey: string;
  descriptionKey: string;
  placeholders: string[];
};

const templateGroups: TemplateGroup[] = [
  { key: "templates", number: "03", titleKey: "whatsapp.attendanceTemplatesTitle", descriptionKey: "whatsapp.attendanceTemplatesDescription", placeholders: ["{student_name}", "{student_code}", "{date}", "{time}", "{group_name}", "{ref_code}", "{portal_link}"] },
  { key: "absence_templates", number: "04", titleKey: "whatsapp.absenceTemplatesTitle", descriptionKey: "whatsapp.absenceTemplatesDescription", placeholders: ["{student_name}", "{student_code}", "{date}", "{group_name}", "{ref_code}", "{portal_link}"] },
  { key: "grade_templates", number: "05", titleKey: "whatsapp.gradeTemplatesTitle", descriptionKey: "whatsapp.gradeTemplatesDescription", placeholders: ["{student_name}", "{student_code}", "{exam_title}", "{score}", "{max_score}", "{percentage}", "{portal_link}", "{ref_code}"] },
  { key: "receipt_templates", number: "06", titleKey: "whatsapp.receiptTemplatesTitle", descriptionKey: "whatsapp.receiptTemplatesDescription", placeholders: ["{student_name}", "{student_code}", "{amount_paid}", "{month}", "{receipt_number}", "{portal_link}", "{ref_code}"] },
  { key: "advance_payment_templates", number: "07", titleKey: "whatsapp.advancePaymentTemplatesTitle", descriptionKey: "whatsapp.advancePaymentTemplatesDescription", placeholders: ["{student_name}", "{student_code}", "{amount_paid}", "{months}", "{receipt_number}", "{portal_link}", "{ref_code}"] }
];

const defaultSettings: WhatsAppSettings = {
  auto_send: false,
  templates: fallbackTemplates.map(normalizeTeacherDisplayName),
  grade_templates: fallbackGradeTemplates.map(normalizeTeacherDisplayName),
  receipt_templates: fallbackReceiptTemplates.map(normalizeTeacherDisplayName),
  advance_payment_templates: fallbackAdvancePaymentTemplates.map(normalizeTeacherDisplayName),
  absence_templates: fallbackAbsenceTemplates.map(normalizeTeacherDisplayName),
  min_delay_seconds: 4,
  max_delay_seconds: 8
};

function normalizeSettings(value: Partial<WhatsAppSettings> | undefined): WhatsAppSettings {
  const normalizeTemplates = (input: string[] | undefined, fallback: string[], requiredPlaceholder: string) => {
    const templates = Array.isArray(input) ? input.map((item) => normalizeTeacherDisplayName(String(item ?? "").trim())).filter(Boolean).slice(0, 4) : [];
    const placeholderKey = requiredPlaceholder.replace(/^\{+|\}+$/g, "").trim().toLowerCase();
    const hasPlaceholder = (template: string) => templateUsesPlaceholder(template, placeholderKey);
    return templates.length >= 3 && templates.every(hasPlaceholder) ? templates : fallback.map(normalizeTeacherDisplayName);
  };
  return {
    auto_send: value?.auto_send === true,
    templates: normalizeTemplates(value?.templates, fallbackTemplates, "{student_name}"),
    grade_templates: normalizeTemplates(value?.grade_templates, fallbackGradeTemplates, "{exam_title}"),
    receipt_templates: normalizeTemplates(value?.receipt_templates, fallbackReceiptTemplates, "{amount_paid}"),
    advance_payment_templates: normalizeTemplates(value?.advance_payment_templates, fallbackAdvancePaymentTemplates, "{months}"),
    absence_templates: normalizeTemplates(value?.absence_templates, fallbackAbsenceTemplates, "{student_name}"),
    min_delay_seconds: Number.isInteger(Number(value?.min_delay_seconds)) ? Number(value?.min_delay_seconds) : 4,
    max_delay_seconds: Number.isInteger(Number(value?.max_delay_seconds)) ? Number(value?.max_delay_seconds) : 8,
    portal_base_url: String(value?.portal_base_url || window.location.origin).replace(/\/+$/, "")
  };
}

function ChevronIcon({ open }: { open: boolean }) {
  return <svg className={`whatsapp-template-accordion-icon ${open ? "is-open" : ""}`} viewBox="0 0 24 24" aria-hidden="true"><path d={open ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} /></svg>;
}

function WhatsAppMessageHistory({ token, language, t }: Pick<Props, "token" | "language" | "t">) {
  const [messages, setMessages] = useState<WhatsAppHistoryRow[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ limit: "100" });
    if (type) params.set("type", type);
    if (status) params.set("status", status);
    if (search.trim()) params.set("search", search.trim());
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    setLoading(true);
    fetch(`${API_BASE_URL}/whatsapp/history?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (response.status === 403 || payload.permission === "whatsapp.view") throw new Error("history_permission_denied");
        if (!response.ok || !payload.ok) throw new Error("history_failed");
        const nextMessages = Array.isArray(payload.messages) ? payload.messages : [];
        setMessages(nextMessages);
        setTotalCount(Number.isSafeInteger(Number(payload.total)) ? Number(payload.total) : nextMessages.length);
        setError(false);
        setPermissionDenied(false);
      })
      .catch((reason) => { if (reason?.name !== "AbortError") { setError(true); setPermissionDenied(reason?.message === "history_permission_denied"); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [from, refreshKey, search, status, to, token, type]);

  const typeLabel = (value: string) => t(`whatsapp.historyType.${value}`);
  const statusLabel = (value: string) => t(`whatsapp.historyStatus.${value}`);
  const formatDate = (value: string) => new Intl.DateTimeFormat(language === "ar" ? "ar-EG" : "en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo" }).format(new Date(value));

  return <div className="whatsapp-history-panel">
    <div className="whatsapp-history-toolbar"><span className="whatsapp-history-count">{t("whatsapp.historyCount", { count: String(totalCount) })}</span><button className={`secondary-button compact-button whatsapp-history-refresh ${loading ? "is-loading" : ""}`} type="button" onClick={() => setRefreshKey((current) => current + 1)} disabled={loading}><span className="whatsapp-history-refresh-icon" aria-hidden="true">↻</span><span>{loading ? t("whatsapp.historyRefreshing") : t("whatsapp.historyRefresh")}</span></button></div>
    <div className="whatsapp-history-filters">
      <label><span>{t("whatsapp.historyTypeLabel")}</span><select value={type} onChange={(event) => setType(event.target.value)}><option value="">{t("whatsapp.historyAllTypes")}</option><option value="attendance">{typeLabel("attendance")}</option><option value="grade">{typeLabel("grade")}</option><option value="receipt">{typeLabel("receipt")}</option><option value="advance_payment">{typeLabel("advance_payment")}</option></select></label>
      <label><span>{t("whatsapp.historyStatusLabel")}</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">{t("whatsapp.historyAllStatuses")}</option><option value="sent">{statusLabel("sent")}</option><option value="pending">{statusLabel("pending")}</option><option value="processing">{statusLabel("processing")}</option><option value="failed">{statusLabel("failed")}</option><option value="skipped">{statusLabel("skipped")}</option></select></label>
      <label className="whatsapp-history-search"><span>{t("whatsapp.historyStudentFilter")}</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("whatsapp.historyStudentPlaceholder")} /></label>
      <label><span>{t("whatsapp.historyFrom")}</span><input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
      <label><span>{t("whatsapp.historyTo")}</span><input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
    </div>
    {loading ? <p className="form-hint">{t("whatsapp.historyLoading")}</p> : error ? <div className="whatsapp-history-load-error"><p className="form-error">{permissionDenied ? t("whatsapp.historyPermissionDenied") : t("whatsapp.historyLoadFailed")}</p><button className="secondary-button compact-button" type="button" onClick={() => setRefreshKey((current) => current + 1)}>{t("whatsapp.historyRefresh")}</button></div> : !messages.length ? <p className="form-hint">{t("whatsapp.historyEmpty")}</p> : <div className="whatsapp-history-list">
      {messages.map((message) => {
        const isOpen = expandedId === message.id;
        return <article className={`whatsapp-history-item ${isOpen ? "is-open" : ""}`} key={message.id}>
          <button className="whatsapp-history-toggle" type="button" aria-expanded={isOpen} onClick={() => setExpandedId(isOpen ? null : message.id)}>
            <span className="whatsapp-history-main"><strong>{message.student_name || message.student_code || t("whatsapp.historyUnknownStudent")}</strong><small>{typeLabel(message.notification_type)} · {message.ref_code}</small></span>
            <span className={`whatsapp-history-status ${message.status}`}>{statusLabel(message.status)}</span>
            <span className="whatsapp-history-date">{formatDate(message.created_at)}</span>
            <ChevronIcon open={isOpen} />
          </button>
          {isOpen ? <div className="whatsapp-history-details">
            <dl><div><dt>{t("whatsapp.historyStudent")}</dt><dd>{message.student_name || "—"}{message.student_code ? ` (${message.student_code})` : ""}</dd></div><div><dt>{t("whatsapp.historyRecipient")}</dt><dd>{message.phone_number || "—"}</dd></div><div><dt>{t("whatsapp.historyReference")}</dt><dd>{message.ref_code}</dd></div><div><dt>{t("whatsapp.historyTemplate")}</dt><dd>{message.template_index == null ? "—" : `#${message.template_index + 1}`}</dd></div><div><dt>{t("whatsapp.historyCreated")}</dt><dd>{formatDate(message.created_at)}</dd></div>{message.sent_at ? <div><dt>{t("whatsapp.historySent")}</dt><dd>{formatDate(message.sent_at)}</dd></div> : null}</dl>
            <div><span className="whatsapp-history-label">{t("whatsapp.historyMessage")}</span><pre className="whatsapp-history-message" dir="auto">{message.rendered_message || "—"}</pre></div>
            {message.last_error ? <div className="whatsapp-history-error"><span className="whatsapp-history-label">{t("whatsapp.historyError")}</span><p>{message.last_error}</p></div> : null}
          </div> : null}
        </article>;
      })}
    </div>}
  </div>;
}

export function WhatsAppSettingsPanel({ token, language, canManage = false, canControlConnection = canManage, t }: Props) {
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
  const [activeTab, setActiveTab] = useState<"templates" | "history">("templates");
  const [openTemplateGroups, setOpenTemplateGroups] = useState<Record<TemplateKey, boolean>>({ templates: false, absence_templates: false, grade_templates: false, receipt_templates: false, advance_payment_templates: false });
  const [absenceTemplateRows, setAbsenceTemplateRows] = useState<WhatsAppTemplateRow[]>([]);
  const [absenceTemplateIds, setAbsenceTemplateIds] = useState<Array<number | null>>([]);
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
      fetch(`${API_BASE_URL}/whatsapp/settings`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal }).then((response) => response.json()),
      fetch(`${API_BASE_URL}/whatsapp/templates`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal }).then((response) => response.json())
    ]).then(([statusPayload, settingsPayload, templatePayload]) => {
      if (!statusPayload.ok || !settingsPayload.ok || !templatePayload.ok) throw new Error("load_failed");
      setStatus({ status: statusPayload.status, phone_number: statusPayload.phone_number || null, has_qr: statusPayload.has_qr });
      const next = normalizeSettings(settingsPayload.settings);
      const allTemplateRows = Array.isArray(templatePayload.templates) ? templatePayload.templates as WhatsAppTemplateRow[] : [];
      const dbTemplates = allTemplateRows.filter((item) => item.is_active !== false);
      const absenceRows = allTemplateRows.filter((item) => item.category === "absence" && item.message_body);
      const activeAbsenceRows = absenceRows.filter((item) => item.is_active !== false).slice(0, 4);
      const categoryMap: Record<string, TemplateKey> = { attendance: "templates", absence: "absence_templates", grade: "grade_templates", receipt: "receipt_templates", advance_payment: "advance_payment_templates" };
      dbTemplates.forEach((item: { category?: string; message_body?: string }) => {
        const key = item.category ? categoryMap[item.category] : undefined;
        if (key && key !== "absence_templates" && item.message_body) next[key] = [...next[key], String(item.message_body)].filter((value, index, values) => values.indexOf(value) === index).slice(0, 4);
      });
      if (activeAbsenceRows.length) next.absence_templates = activeAbsenceRows.map((item) => normalizeTeacherDisplayName(String(item.message_body).trim()));
      setAbsenceTemplateRows(absenceRows);
      setAbsenceTemplateIds(activeAbsenceRows.map((item) => Number(item.id)));
      setSettings(next); setSavedSettings(next); setError("");
    }).catch((reason) => { if (reason?.name !== "AbortError") setError(t("whatsapp.loadFailed")); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token]);

  const memoizedTemplateGroups = useMemo(() => templateGroups.map((group) => ({ ...group, templates: settings[group.key] })), [settings]);

  function addTemplate(group: TemplateKey) {
    if (!canManage || settings[group].length >= 4) return;
    setFeedback("idle");
    setSettings((current) => ({ ...current, [group]: [...current[group], current[group][0] || "{student_name}"] }));
    if (group === "absence_templates") setAbsenceTemplateIds((current) => [...current, null]);
  }

  function removeTemplate(group: TemplateKey, index: number) {
    if (!canManage || settings[group].length <= 3) return;
    setFeedback("idle");
    setSettings((current) => ({ ...current, [group]: current[group].filter((_value, templateIndex) => templateIndex !== index) }));
    if (group === "absence_templates") setAbsenceTemplateIds((current) => current.filter((_value, templateIndex) => templateIndex !== index));
  }

  useEffect(() => {
    const interval = window.setInterval(() => { void loadStatus().catch(() => undefined); }, status.status === "connected" ? 5000 : 2000);
    return () => window.clearInterval(interval);
  }, [status.status, token]);

  async function startPairing() {
    if (!canControlConnection || pairing || status.status === "connected") return;
    setPairing(true); setError(""); setQr("");
    const deadline = Date.now() + 75_000;
    let lastPayload: { status?: WhatsAppStatus["status"]; phone_number?: string | null; has_qr?: boolean; qr?: string; ok?: boolean } | null = null;
    try {
      while (Date.now() < deadline) {
        const controller = new AbortController();
        const timeout = window.setTimeout(() => controller.abort(), 35_000);
        try {
          const response = await fetch(`${API_BASE_URL}/whatsapp/qr?poll=${Date.now()}`, { cache: "no-store", headers: { Authorization: `Bearer ${token}` }, signal: controller.signal });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok || !payload.ok) throw new Error("pairing_failed");
          lastPayload = payload;
          setStatus({ status: payload.status, phone_number: payload.phone_number || null, has_qr: payload.has_qr });
          if (payload.qr || payload.status === "connected") {
            setQr(payload.qr || "");
            return;
          }
        } finally {
          window.clearTimeout(timeout);
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1200));
      }
      if (lastPayload?.status !== "connected") throw new Error("qr_unavailable");
    } catch (_error) { setError(t("whatsapp.connectionFailed")); }
    finally { setPairing(false); }
  }

  async function disconnect() {
    if (!canControlConnection || disconnecting) return;
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
      const { absence_templates: absenceTemplates, ...settingsPayload } = settings;
      const response = await fetch(`${API_BASE_URL}/whatsapp/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ settings: settingsPayload })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error("save_failed");
      const syncedAbsenceRows = await saveAbsenceTemplates(absenceTemplates);
      const next = normalizeSettings(payload.settings);
      next.absence_templates = syncedAbsenceRows.map((row) => normalizeTeacherDisplayName(row.message_body));
      setSettings(next); setSavedSettings(next); setFeedback("saved");
      window.setTimeout(() => setFeedback("idle"), 2200);
    } catch (_error) { setFeedback("error"); setError(t("whatsapp.saveFailed")); }
    finally { setSaving(false); }
  }

  async function saveAbsenceTemplates(templates: string[]) {
    const activeIds = new Set(absenceTemplateIds.filter((id): id is number => Number.isSafeInteger(id)));
    const requests: Promise<Response>[] = [];
    templates.forEach((messageBody, index) => {
      const id = absenceTemplateIds[index];
      if (id) {
        activeIds.add(id);
        requests.push(fetch(`${API_BASE_URL}/whatsapp/templates/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ message_body: messageBody, is_active: true })
        }));
      } else {
        const existingRow = absenceTemplateRows.find((row) => row.message_body === messageBody);
        if (existingRow) {
          activeIds.add(existingRow.id);
          requests.push(fetch(`${API_BASE_URL}/whatsapp/templates/${existingRow.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
            body: JSON.stringify({ message_body: messageBody, is_active: true })
          }));
          return;
        }
        requests.push(fetch(`${API_BASE_URL}/whatsapp/templates`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ category: "absence", message_body: messageBody })
        }));
      }
    });
    absenceTemplateRows.forEach((row) => {
      if (!activeIds.has(row.id)) {
        requests.push(fetch(`${API_BASE_URL}/whatsapp/templates/${row.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ is_active: false })
        }));
      }
    });
    const responses = await Promise.all(requests);
    if (responses.some((response) => !response.ok)) throw new Error("absence_templates_save_failed");
    const refreshedResponse = await fetch(`${API_BASE_URL}/whatsapp/templates?category=absence`, { headers: { Authorization: `Bearer ${token}` } });
    const refreshedPayload = await refreshedResponse.json().catch(() => ({}));
    if (!refreshedResponse.ok || !refreshedPayload.ok) throw new Error("absence_templates_load_failed");
    const refreshedRows = (Array.isArray(refreshedPayload.templates) ? refreshedPayload.templates : [])
      .filter((row: WhatsAppTemplateRow) => row.is_active !== false && row.message_body)
      .slice(0, 4) as WhatsAppTemplateRow[];
    setAbsenceTemplateRows(refreshedRows);
    setAbsenceTemplateIds(refreshedRows.map((row) => Number(row.id)));
    return refreshedRows;
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

  const portalLink = `${settings.portal_base_url || window.location.origin}/p/7Kx92QmY7Q4xP3nL8sV2`;
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
            {canControlConnection ? (status.status === "connected" ? <button className="secondary-button" type="button" disabled={disconnecting} onClick={() => void disconnect()}>{disconnecting ? t("whatsapp.disconnecting") : t("whatsapp.disconnect")}</button> : <button className="primary-button" type="button" disabled={pairing} onClick={() => void startPairing()}>{pairing ? t("whatsapp.connecting") : t("whatsapp.connect")}</button>) : <small className="whatsapp-view-only">{t("whatsapp.viewOnly")}</small>}
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
      <div className="whatsapp-panel-tabs" role="tablist" aria-label={t("whatsapp.panelTabsLabel")}>
        <button className={activeTab === "templates" ? "active" : ""} type="button" role="tab" aria-selected={activeTab === "templates"} onClick={() => setActiveTab("templates")}>{t("whatsapp.templatesTab")}</button>
        <button className={activeTab === "history" ? "active" : ""} type="button" role="tab" aria-selected={activeTab === "history"} onClick={() => setActiveTab("history")}>{t("whatsapp.historyTab")}</button>
      </div>
      <div className="settings-section-heading"><span>{activeTab === "templates" ? "03–07" : "08"}</span><div><h3>{t(activeTab === "templates" ? "whatsapp.templatesTitle" : "whatsapp.messageHistoryTitle")}</h3><p>{t(activeTab === "templates" ? "whatsapp.templatesDescription" : "whatsapp.messageHistoryDescription")}</p></div></div>
      {activeTab === "history" ? <WhatsAppMessageHistory token={token} language={language} t={t} /> : <>
        <div className="whatsapp-template-groups">
        {memoizedTemplateGroups.map((group) => {
          const isOpen = openTemplateGroups[group.key];
          const templates = settings[group.key];
          const contentId = `whatsapp-${group.key}-content`;
          return <article className={`whatsapp-template-accordion ${isOpen ? "is-open" : ""}`} key={group.key}>
            <button id={`${contentId}-toggle`} className="whatsapp-template-accordion-toggle flex items-center justify-between gap-4 w-full p-5 rounded-lg bg-slate-800 hover:bg-slate-700 transition-colors duration-200" type="button" aria-expanded={isOpen} aria-controls={contentId} onClick={() => toggleTemplateGroup(group.key)}>
              <span className="whatsapp-template-accordion-heading"><span className="whatsapp-template-number">{group.number}</span><span className="whatsapp-template-accordion-copy"><strong className="truncate">{t(group.titleKey)}</strong><small className="truncate">{t(group.descriptionKey)}</small><span className="whatsapp-template-accordion-badge truncate">{t("whatsapp.activeTemplates", { count: String(templates.length) })}</span></span></span>
              <ChevronIcon open={isOpen} />
            </button>
            <div className={`whatsapp-template-accordion-content ${isOpen ? "is-open" : ""}`} id={contentId} role="region" aria-labelledby={`${contentId}-toggle`} aria-hidden={!isOpen}>
              <div className="whatsapp-template-accordion-inner">
                <div className="whatsapp-template-list">{templates.map((template, index) => { const refKey = `${group.key}-${index}`; return <label className="whatsapp-template-card" key={index}><span className="whatsapp-template-number">{String(index + 1).padStart(2, "0")}</span><strong>{t("whatsapp.templateLabel", { number: String(index + 1) })}</strong><textarea ref={(element) => { textareaRefs.current[refKey] = element; }} disabled={!canManage} dir="auto" value={template} onChange={(event) => updateTemplate(group.key, index, event.target.value)} maxLength={2000} /><span className="whatsapp-placeholder-label">{t("whatsapp.placeholders")}</span><div className="whatsapp-placeholder-chips">{group.placeholders.map((placeholder) => { const isUsed = templateUsesPlaceholder(template, placeholder); return <button className={isUsed ? "is-used" : ""} disabled={!canManage || isUsed} type="button" key={placeholder} aria-label={isUsed ? `Used ${placeholder}` : `Insert ${placeholder}`} onClick={() => insertPlaceholder(group.key, index, placeholder)}>{isUsed ? `✓ ${placeholder}` : placeholder}</button>; })}</div>{canManage && templates.length > 3 ? <button className="secondary-button compact-button" type="button" onClick={() => removeTemplate(group.key, index)}>{language === "ar" ? "حذف القالب" : "Delete template"}</button> : null}</label>; })}</div><button className="secondary-button compact-button" type="button" disabled={!canManage || templates.length >= 4} onClick={() => addTemplate(group.key)}>{language === "ar" ? "إضافة قالب" : "Add template"}</button>
                {group.key === "templates" ? <div className="whatsapp-preview-box"><div><strong>{t("whatsapp.previewTitle")}</strong><small>{t("whatsapp.previewDescription")}</small></div><p>{previewParts.map((part, index) => <span key={`${part}-${index}`}>{index ? <a href={portalLink} target="_blank" rel="noreferrer">{portalLink}</a> : null}{part}</span>)}</p></div> : null}
              </div>
            </div>
          </article>;
        })}
        </div>
        <div className="whatsapp-save-row"><span className={feedback === "error" ? "form-error" : feedback === "saved" ? "lookup-result" : "form-hint"} role={feedback !== "idle" ? "status" : undefined}>{feedback === "saved" ? t("whatsapp.saved") : feedback === "error" ? t("whatsapp.saveFailed") : t("whatsapp.saveHint")}</span><button className={`primary-button ${feedback === "saved" ? "success-button" : ""}`} type="button" disabled={!canManage || saving || !dirty} onClick={() => void save()}>{saving ? t("whatsapp.saving") : feedback === "saved" ? t("whatsapp.saved") : t("whatsapp.save")}</button></div>
      </>}
    </section>
  </section>;
}
