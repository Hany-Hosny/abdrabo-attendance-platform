import { useEffect, useMemo, useRef, useState } from "react";

type Language = "ar" | "en";
type Translator = (key: string, values?: Record<string, string>) => string;
type WhatsAppSettings = {
  auto_send: boolean;
  attendance_notifications_enabled: boolean;
  templates: string[];
  grade_templates: string[];
  receipt_templates: string[];
  advance_payment_templates: string[];
  absence_templates: string[];
  cancellation_templates: string[];
  min_delay_seconds: number;
  max_delay_seconds: number;
  max_messages_per_hour: number;
  batch_size: number;
  batch_cooldown_seconds: number;
  reconnect_cooldown_seconds: number;
  portal_base_url?: string;
};
type WhatsAppStatus = {
  status: "disconnected" | "connecting" | "connected";
  phone_number: string | null;
  has_qr?: boolean;
};
type Props = { token: string; language: Language; canManage?: boolean; canCancelSessions?: boolean; canControlConnection?: boolean; t: Translator };
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
type WhatsAppHistoryStats = {
  total: number;
  sent: number;
  failed: number;
  pending: number;
  delivery_unknown: number;
  skipped_auto_send_disabled: number;
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
const fallbackCancellationTemplates = ["تم إلغاء حصة مجموعة {group_name} يوم {scheduled_date} الساعة {scheduled_time}. وقت الإلغاء: {cancellation_time}. المرجع: {ref_code}", "نحيطكم علماً بإلغاء حصة {group_name} المقررة في {scheduled_date} الساعة {scheduled_time}. تم تسجيل الإلغاء في {cancellation_time}. المرجع: {ref_code}", "إشعار إلغاء حصة المجموعة {group_name}: {scheduled_date} الساعة {scheduled_time}. وقت تسجيل الإلغاء: {cancellation_time}. المرجع: {ref_code}"];

type TemplateKey = "templates" | "grade_templates" | "receipt_templates" | "advance_payment_templates" | "absence_templates" | "cancellation_templates";
type WhatsAppTemplateRow = { id: number; category: string; audience: "male" | "female" | "neutral"; slot_number: number | null; slot_key: string | null; is_fallback: boolean; content_version: number; message_body: string; is_active?: boolean };
type TemplateSaveError = Error & { requiredPlaceholder?: string; status?: string };
type TemplateGroup = {
  key: TemplateKey;
  category: "attendance" | "absence" | "grade" | "receipt" | "advance_payment" | "cancellation";
  number: string;
  titleKey: string;
  descriptionKey: string;
  placeholders: string[];
};

const templateGroups: TemplateGroup[] = [
  { key: "templates", category: "attendance", number: "03", titleKey: "whatsapp.attendanceTemplatesTitle", descriptionKey: "whatsapp.attendanceTemplatesDescription", placeholders: ["{student_name}", "{student_code}", "{date}", "{time}", "{group_name}", "{ref_code}", "{portal_link}"] },
  { key: "absence_templates", category: "absence", number: "04", titleKey: "whatsapp.absenceTemplatesTitle", descriptionKey: "whatsapp.absenceTemplatesDescription", placeholders: ["{student_name}", "{student_code}", "{date}", "{group_name}", "{ref_code}", "{portal_link}"] },
  { key: "grade_templates", category: "grade", number: "05", titleKey: "whatsapp.gradeTemplatesTitle", descriptionKey: "whatsapp.gradeTemplatesDescription", placeholders: ["{student_name}", "{student_code}", "{exam_title}", "{score}", "{max_score}", "{percentage}", "{portal_link}", "{ref_code}"] },
  { key: "receipt_templates", category: "receipt", number: "06", titleKey: "whatsapp.receiptTemplatesTitle", descriptionKey: "whatsapp.receiptTemplatesDescription", placeholders: ["{student_name}", "{student_code}", "{amount_paid}", "{month}", "{receipt_number}", "{portal_link}", "{ref_code}"] },
  { key: "advance_payment_templates", category: "advance_payment", number: "07", titleKey: "whatsapp.advancePaymentTemplatesTitle", descriptionKey: "whatsapp.advancePaymentTemplatesDescription", placeholders: ["{student_name}", "{student_code}", "{amount_paid}", "{months}", "{receipt_number}", "{portal_link}", "{ref_code}"] },
  { key: "cancellation_templates", category: "cancellation", number: "08", titleKey: "whatsapp.cancellationTemplatesTitle", descriptionKey: "whatsapp.cancellationTemplatesDescription", placeholders: ["{group_name}", "{scheduled_date}", "{scheduled_time}", "{cancellation_time}", "{ref_code}"] }
];

const defaultSettings: WhatsAppSettings = {
  auto_send: false,
  attendance_notifications_enabled: true,
  templates: fallbackTemplates.map(normalizeTeacherDisplayName),
  grade_templates: fallbackGradeTemplates.map(normalizeTeacherDisplayName),
  receipt_templates: fallbackReceiptTemplates.map(normalizeTeacherDisplayName),
  advance_payment_templates: fallbackAdvancePaymentTemplates.map(normalizeTeacherDisplayName),
  absence_templates: fallbackAbsenceTemplates.map(normalizeTeacherDisplayName),
  cancellation_templates: fallbackCancellationTemplates,
  min_delay_seconds: 4,
  max_delay_seconds: 8,
  max_messages_per_hour: 50,
  batch_size: 25,
  batch_cooldown_seconds: 300,
  reconnect_cooldown_seconds: 300
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
    attendance_notifications_enabled: value?.attendance_notifications_enabled !== false,
    templates: normalizeTemplates(value?.templates, fallbackTemplates, "{student_name}"),
    grade_templates: normalizeTemplates(value?.grade_templates, fallbackGradeTemplates, "{exam_title}"),
    receipt_templates: normalizeTemplates(value?.receipt_templates, fallbackReceiptTemplates, "{amount_paid}"),
    advance_payment_templates: normalizeTemplates(value?.advance_payment_templates, fallbackAdvancePaymentTemplates, "{months}"),
    absence_templates: normalizeTemplates(value?.absence_templates, fallbackAbsenceTemplates, "{student_name}"),
    cancellation_templates: normalizeTemplates(value?.cancellation_templates, fallbackCancellationTemplates, "{group_name}"),
    min_delay_seconds: Number.isInteger(Number(value?.min_delay_seconds)) ? Number(value?.min_delay_seconds) : 4,
    max_delay_seconds: Number.isInteger(Number(value?.max_delay_seconds)) ? Number(value?.max_delay_seconds) : 8,
    max_messages_per_hour: Number.isInteger(Number(value?.max_messages_per_hour)) ? Number(value?.max_messages_per_hour) : 50,
    batch_size: Number.isInteger(Number(value?.batch_size)) ? Number(value?.batch_size) : 25,
    batch_cooldown_seconds: Number.isInteger(Number(value?.batch_cooldown_seconds)) ? Number(value?.batch_cooldown_seconds) : 300,
    reconnect_cooldown_seconds: Number.isInteger(Number(value?.reconnect_cooldown_seconds)) ? Number(value?.reconnect_cooldown_seconds) : 300,
    portal_base_url: String(value?.portal_base_url || window.location.origin).replace(/\/+$/, "")
  };
}

function ChevronIcon({ open }: { open: boolean }) {
  return <svg className={`whatsapp-template-accordion-icon ${open ? "is-open" : ""}`} viewBox="0 0 24 24" aria-hidden="true"><path d={open ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} /></svg>;
}

function WhatsAppMessageHistory({ token, language, canManage = false, canCancelSessions = false, t }: Pick<Props, "token" | "language" | "canManage" | "canCancelSessions" | "t">) {
  const [messages, setMessages] = useState<WhatsAppHistoryRow[]>([]);
  const [stats, setStats] = useState<WhatsAppHistoryStats>({ total: 0, sent: 0, failed: 0, pending: 0, delivery_unknown: 0, skipped_auto_send_disabled: 0 });
  const [statsLoading, setStatsLoading] = useState(true);
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
  const [retryingId, setRetryingId] = useState<number | null>(null);
  const [approvingId, setApprovingId] = useState<number | null>(null);
  const [retryFeedback, setRetryFeedback] = useState<{ id: number; kind: "success" | "error"; key: string } | null>(null);

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
        setError(false);
        setPermissionDenied(false);
      })
      .catch((reason) => { if (reason?.name !== "AbortError") { setError(true); setPermissionDenied(reason?.message === "history_permission_denied"); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [from, refreshKey, search, status, to, token, type]);

  useEffect(() => {
    const controller = new AbortController();
    setStatsLoading(true);
    fetch(`${API_BASE_URL}/whatsapp/history/stats`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.ok) throw new Error("history_stats_failed");
        const nextStats = payload.stats || {};
        setStats({
          total: Number(nextStats.total) || 0,
          sent: Number(nextStats.sent) || 0,
          failed: Number(nextStats.failed) || 0,
          pending: Number(nextStats.pending) || 0,
          delivery_unknown: Number(nextStats.delivery_unknown) || 0,
          skipped_auto_send_disabled: Number(nextStats.skipped_auto_send_disabled) || 0
        });
      })
      .catch((reason) => { if (reason?.name !== "AbortError") setStats({ total: 0, sent: 0, failed: 0, pending: 0, delivery_unknown: 0, skipped_auto_send_disabled: 0 }); })
      .finally(() => { if (!controller.signal.aborted) setStatsLoading(false); });
    return () => controller.abort();
  }, [refreshKey, token]);

  const typeLabel = (value: string) => t(`whatsapp.historyType.${value}`);
  const statusLabel = (value: string) => t(`whatsapp.historyStatus.${value}`);
  const formatDate = (value: string) => new Intl.DateTimeFormat(language === "ar" ? "ar-EG" : "en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo" }).format(new Date(value));
  const formatCount = (value: number) => value.toLocaleString(language === "ar" ? "ar-EG" : "en-US");
  const retryNotEligibleStatuses = new Set(["student_inactive", "whatsapp_opted_out", "invalid_phone", "attendance_excused", "attendance_no_longer_eligible", "absence_no_longer_eligible", "grade_no_longer_exists", "payment_no_longer_exists"]);

  async function retryFailedMessage(message: WhatsAppHistoryRow) {
    if (!canManage || !["failed", "delivery_unknown"].includes(message.status) || retryingId !== null) return;
    if (message.status === "delivery_unknown" && !window.confirm(t("whatsapp.historyRetryUnknownConfirm"))) return;
    setRetryingId(message.id);
    setRetryFeedback(null);
    try {
      const response = await fetch(`${API_BASE_URL}/whatsapp/jobs/${message.id}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          reason: t("whatsapp.historyRetryReason"),
          confirm_delivery_unknown: message.status === "delivery_unknown"
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) {
        const errorKey = retryNotEligibleStatuses.has(String(payload.status))
          ? "whatsapp.historyRetryNotEligible"
          : "whatsapp.historyRetryFailed";
        throw new Error(errorKey);
      }
      setMessages((current) => current.map((item) => item.id === message.id
        ? { ...item, status: payload.status || "pending", attempts: 0, last_error: null, sent_at: null }
        : item));
      setStats((current) => ({
        ...current,
        failed: message.status === "failed" ? Math.max(0, current.failed - 1) : current.failed,
        delivery_unknown: message.status === "delivery_unknown" ? Math.max(0, current.delivery_unknown - 1) : current.delivery_unknown,
        pending: current.pending + 1
      }));
      setRetryFeedback({ id: message.id, kind: "success", key: "whatsapp.historyRetryQueued" });
      window.setTimeout(() => setRetryFeedback((current) => current?.id === message.id ? null : current), 2400);
    } catch (error) {
      setRetryFeedback({
        id: message.id,
        kind: "error",
        key: error instanceof Error && error.message.startsWith("whatsapp.") ? error.message : "whatsapp.historyRetryFailed"
      });
    } finally {
      setRetryingId(null);
    }
  }

  async function approveCancellationNotice(message: WhatsAppHistoryRow) {
    if (!canCancelSessions || message.notification_type !== "cancellation" || message.status !== "review_required" || approvingId !== null) return;
    setApprovingId(message.id); setRetryFeedback(null);
    try {
      const response = await fetch(`${API_BASE_URL}/whatsapp/jobs/${message.id}/cancellation-send`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error("whatsapp.cancellationReviewFailed");
      setMessages((current) => current.map((item) => item.id === message.id ? { ...item, status: "pending" } : item));
      setRetryFeedback({ id: message.id, kind: "success", key: "whatsapp.cancellationReviewQueued" });
      window.setTimeout(() => setRetryFeedback((current) => current?.id === message.id ? null : current), 3000);
    } catch (_error) { setRetryFeedback({ id: message.id, kind: "error", key: "whatsapp.cancellationReviewFailed" }); }
    finally { setApprovingId(null); }
  }

  const statCards = [
    { key: "total", label: "whatsapp.historyStatsTotal", tone: "total", icon: "◉" },
    { key: "sent", label: "whatsapp.historyStatsSent", tone: "sent", icon: "✓" },
    { key: "failed", label: "whatsapp.historyStatsFailed", tone: "failed", icon: "!" },
    { key: "pending", label: "whatsapp.historyStatsPending", tone: "pending", icon: "◌" },
    { key: "delivery_unknown", label: "whatsapp.historyStatsDeliveryUnknown", tone: "delivery-unknown", icon: "?" },
    { key: "skipped_auto_send_disabled", label: "whatsapp.historyStatsSkipped", tone: "skipped", icon: "–" }
  ] as const;

  return <div className="whatsapp-history-panel">
    <div className="whatsapp-history-toolbar"><button className={`secondary-button compact-button whatsapp-history-refresh ${loading ? "is-loading" : ""}`} type="button" onClick={() => setRefreshKey((current) => current + 1)} disabled={loading}><span className="whatsapp-history-refresh-icon" aria-hidden="true">↻</span><span>{loading ? t("whatsapp.historyRefreshing") : t("whatsapp.historyRefresh")}</span></button></div>
    <div className="whatsapp-history-stats" aria-label={t("whatsapp.messageHistoryTitle")}>
      {statCards.map((card) => {
        const content = <><span className="whatsapp-history-stat-icon" aria-hidden="true">{card.icon}</span><span className="whatsapp-history-stat-copy"><strong>{statsLoading ? "—" : formatCount(stats[card.key])}</strong><small>{t(card.label)}</small></span></>;
        return ["failed", "delivery_unknown"].includes(card.key)
          ? <button className={`whatsapp-history-stat-card ${card.tone} is-clickable ${status === card.key ? "is-active" : ""}`} type="button" key={card.key} onClick={() => { setStatus(card.key); setExpandedId(null); }} aria-pressed={status === card.key}>{content}</button>
          : <div className={`whatsapp-history-stat-card ${card.tone}`} key={card.key}>{content}</div>;
      })}
    </div>
    <div className="whatsapp-history-filters">
      <label><span>{t("whatsapp.historyTypeLabel")}</span><select value={type} onChange={(event) => setType(event.target.value)}><option value="">{t("whatsapp.historyAllTypes")}</option><option value="attendance">{typeLabel("attendance")}</option><option value="absence">{typeLabel("absence")}</option><option value="grade">{typeLabel("grade")}</option><option value="receipt">{typeLabel("receipt")}</option><option value="advance_payment">{typeLabel("advance_payment")}</option><option value="cancellation">{typeLabel("cancellation")}</option></select></label>
      <label><span>{t("whatsapp.historyStatusLabel")}</span><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">{t("whatsapp.historyAllStatuses")}</option><option value="sent">{statusLabel("sent")}</option><option value="pending">{statusLabel("pending")}</option><option value="processing">{statusLabel("processing")}</option><option value="review_required">{statusLabel("review_required")}</option><option value="failed">{statusLabel("failed")}</option><option value="skipped">{statusLabel("skipped")}</option><option value="delivery_unknown">{statusLabel("delivery_unknown")}</option></select></label>
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
            {canCancelSessions && message.notification_type === "cancellation" && message.status === "review_required" ? <div className="whatsapp-history-retry-row"><button className="primary-button compact-button" type="button" disabled={approvingId !== null} onClick={() => void approveCancellationNotice(message)}>{approvingId === message.id ? t("whatsapp.cancellationReviewSending") : t("whatsapp.cancellationReviewSend")}</button>{retryFeedback?.id === message.id ? <span className={`whatsapp-history-retry-feedback ${retryFeedback.kind}`} role="status">{t(retryFeedback.key)}</span> : null}</div> : null}
            {canManage && (["failed", "delivery_unknown"].includes(message.status) || retryFeedback?.id === message.id) ? <div className="whatsapp-history-retry-row">
              {["failed", "delivery_unknown"].includes(message.status) ? <button className={`primary-button compact-button whatsapp-history-retry-button ${retryingId === message.id ? "is-loading" : ""}`} type="button" onClick={() => void retryFailedMessage(message)} disabled={retryingId !== null}>
                {retryingId === message.id ? t("whatsapp.historyRetrying") : t("whatsapp.historyRetry")}
              </button> : null}
              {retryFeedback?.id === message.id ? <span className={`whatsapp-history-retry-feedback ${retryFeedback.kind}`} role="status">{t(retryFeedback.key)}</span> : null}
            </div> : null}
          </div> : null}
        </article>;
      })}
    </div>}
  </div>;
}

export function WhatsAppSettingsPanel({ token, language, canManage = false, canCancelSessions = false, canControlConnection = canManage, t }: Props) {
  const [status, setStatus] = useState<WhatsAppStatus>({ status: "disconnected", phone_number: null });
  const [settings, setSettings] = useState<WhatsAppSettings>(defaultSettings);
  const [savedSettings, setSavedSettings] = useState<WhatsAppSettings>(defaultSettings);
  const [templateRows, setTemplateRows] = useState<WhatsAppTemplateRow[]>([]);
  const [savedTemplateRows, setSavedTemplateRows] = useState<WhatsAppTemplateRow[]>([]);
  const [qr, setQr] = useState("");
  const [loading, setLoading] = useState(true);
  const [pairing, setPairing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [autoSendSaving, setAutoSendSaving] = useState(false);
  const [feedback, setFeedback] = useState<"idle" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  const [activeTab, setActiveTab] = useState<"templates" | "history">("templates");
  const [openTemplateGroups, setOpenTemplateGroups] = useState<Record<TemplateKey, boolean>>({ templates: false, absence_templates: false, grade_templates: false, receipt_templates: false, advance_payment_templates: false, cancellation_templates: false });
  const [absenceTemplateRows, setAbsenceTemplateRows] = useState<WhatsAppTemplateRow[]>([]);
  const [absenceTemplateIds, setAbsenceTemplateIds] = useState<Array<number | null>>([]);
  const textareaRefs = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const dirty = useMemo(() => JSON.stringify(settings) !== JSON.stringify(savedSettings) || JSON.stringify(templateRows) !== JSON.stringify(savedTemplateRows), [settings, savedSettings, templateRows, savedTemplateRows]);

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
      const assignmentRows = allTemplateRows.filter((item) => item.slot_key || item.is_fallback);
      setTemplateRows(assignmentRows);
      setSavedTemplateRows(assignmentRows);
      const dbTemplates = assignmentRows.filter((item) => item.is_active !== false);
      const absenceRows = allTemplateRows.filter((item) => item.category === "absence" && item.message_body);
      const activeAbsenceRows = absenceRows.filter((item) => item.is_active !== false).slice(0, 4);
      const categoryMap: Record<string, TemplateKey> = { attendance: "templates", absence: "absence_templates", grade: "grade_templates", receipt: "receipt_templates", advance_payment: "advance_payment_templates", cancellation: "cancellation_templates" };
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
      const { absence_templates: _absenceTemplates, cancellation_templates: _cancellationTemplates, ...settingsPayload } = settings;
      const response = await fetch(`${API_BASE_URL}/whatsapp/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ settings: settingsPayload })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) {
        const failure = new Error(String(payload.status || "save_failed")) as TemplateSaveError;
        failure.status = String(payload.status || "");
        failure.requiredPlaceholder = String(payload.required_placeholder || "").trim() || undefined;
        throw failure;
      }
      await saveTemplateRows();
      const next = normalizeSettings(payload.settings);
      next.absence_templates = settings.absence_templates;
      setSettings(next); setSavedSettings(next); setFeedback("saved");
      window.setTimeout(() => setFeedback("idle"), 2200);
    } catch (error) {
      setFeedback("error");
      const templateError = error instanceof Error ? error as TemplateSaveError : null;
      const requiredPlaceholder = templateError?.requiredPlaceholder;
      const status = templateError?.status || templateError?.message;
      setError(requiredPlaceholder
        ? t("whatsapp.templateMissingPlaceholder", { placeholder: requiredPlaceholder })
        : status === "duplicate_template"
          ? t("whatsapp.duplicateTemplate")
          : status === "invalid_template_length"
            ? t("whatsapp.invalidTemplateLength")
            : t("whatsapp.saveFailed"));
    }
    finally { setSaving(false); }
  }

  async function saveTemplateRows() {
    const changedRows = templateRows.filter((row) => {
      const previous = savedTemplateRows.find((item) => item.id === row.id);
      return previous && (previous.message_body !== row.message_body || previous.is_active !== row.is_active);
    });
    if (!changedRows.length) return;
    const responses = await Promise.all(changedRows.map((row) => fetch(`${API_BASE_URL}/whatsapp/templates/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ message_body: row.message_body, is_active: row.is_active !== false, expected_content_version: row.content_version })
    })));
    const payloads = await Promise.all(responses.map((response) => response.json().catch(() => ({}))));
    const refreshedResponse = await fetch(`${API_BASE_URL}/whatsapp/templates`, { headers: { Authorization: `Bearer ${token}` } });
    const refreshedPayload = await refreshedResponse.json().catch(() => ({}));
    if (!refreshedResponse.ok || !refreshedPayload.ok) throw new Error("template_load_failed");
    const refreshed = (Array.isArray(refreshedPayload.templates) ? refreshedPayload.templates : []) as WhatsAppTemplateRow[];
    const assignments = refreshed.filter((row) => row.slot_key || row.is_fallback);
    const failedIds = new Set(changedRows.filter((_row, index) => !responses[index].ok || !payloads[index].ok).map((row) => row.id));
    setTemplateRows(assignments.map((row) => failedIds.has(row.id) ? (templateRows.find((current) => current.id === row.id) || row) : row));
    setSavedTemplateRows(assignments);
    const failure = payloads.find((payload, index) => !responses[index].ok || !payload.ok);
    if (failure) {
      const error = new Error(String(failure.status || "template_save_failed")) as TemplateSaveError;
      error.status = String(failure.status || "template_save_failed");
      error.requiredPlaceholder = String(failure.required_placeholder || "").trim() || undefined;
      throw error;
    }
  }

  function updateSlot(id: number, patch: Partial<Pick<WhatsAppTemplateRow, "message_body" | "is_active">>) {
    if (!canManage) return;
    setFeedback("idle");
    setTemplateRows((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));
  }

  function insertSlotPlaceholder(row: WhatsAppTemplateRow, group: TemplateGroup, placeholder: string, refKey = `${group.category}-${row.audience}-${row.slot_number}`) {
    if (!canManage || saving) return;
    const textarea = textareaRefs.current[refKey];
    const current = row.message_body || "";
    const start = textarea?.selectionStart ?? current.length;
    const end = textarea?.selectionEnd ?? start;
    const next = `${current.slice(0, start)}${placeholder}${current.slice(end)}`;
    updateSlot(row.id, { message_body: next });
    window.setTimeout(() => {
      textarea?.focus();
      const cursor = start + placeholder.length;
      textarea?.setSelectionRange(cursor, cursor);
    }, 0);
  }

  function previewTemplate(row: WhatsAppTemplateRow, group: TemplateGroup) {
    const values: Record<string, string> = {
      student_name: row.audience === "female" ? t("whatsapp.sampleFemaleStudent") : t("whatsapp.sampleStudent"),
      student_code: "A-1001",
      date: "04/09/2026",
      time: "06:00 PM",
      scheduled_date: "04/09/2026",
      scheduled_time: "06:00 PM",
      cancellation_time: "04/09/2026 03:15 PM",
      group_name: t("whatsapp.sampleGroup"),
      exam_title: t("whatsapp.sampleExam"),
      score: "18",
      max_score: "20",
      percentage: "90",
      amount_paid: "500.00",
      month: "September 2026",
      months: "September 2026, October 2026",
      receipt_number: "P-00000001",
      portal_link: "[secure-link-preview]",
      ref_code: `${group.category.toUpperCase()}-PREVIEW`
    };
    return row.message_body.replace(/\{\{?\s*([a-zA-Z0-9_-]+)\s*\}\}?/gi, (_match, key: string) => values[key.toLowerCase()] ?? "");
  }

  async function toggleAutoSend(enabled: boolean) {
    if (!canManage || saving || autoSendSaving || enabled === settings.auto_send) return;
    const previousValue = settings.auto_send;
    setAutoSendSaving(true);
    setFeedback("idle");
    setError("");
    setSettings((current) => ({ ...current, auto_send: enabled }));
    try {
      const { absence_templates: _absenceTemplates, cancellation_templates: _cancellationTemplates, ...savedSettingsPayload } = savedSettings;
      const response = await fetch(`${API_BASE_URL}/whatsapp/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ settings: { ...savedSettingsPayload, auto_send: enabled } })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error("auto_send_save_failed");
      const persistedValue = payload.settings?.auto_send === true;
      setSavedSettings((current) => ({ ...current, auto_send: persistedValue }));
      setSettings((current) => ({ ...current, auto_send: persistedValue }));
      setFeedback("saved");
      window.setTimeout(() => setFeedback("idle"), 2200);
    } catch (_error) {
      setSettings((current) => ({ ...current, auto_send: previousValue }));
      setFeedback("error");
      setError(t("whatsapp.autoSendSaveFailed"));
    } finally {
      setAutoSendSaving(false);
    }
  }

  async function saveAbsenceTemplates(templates: string[]) {
    if (new Set(templates.map((template) => template.trim())).size !== templates.length) {
      const error = new Error("duplicate_template") as TemplateSaveError;
      error.status = "duplicate_template";
      throw error;
    }
    const activeIds = new Set(absenceTemplateIds.filter((id): id is number => Number.isSafeInteger(id)));
    const requests: Promise<Response>[] = [];
    templates.forEach((messageBody, index) => {
      const id = absenceTemplateIds[index];
      const existingRow = absenceTemplateRows.find((row) => row.message_body === messageBody);
      if (existingRow && existingRow.id !== id) {
        activeIds.add(existingRow.id);
        requests.push(fetch(`${API_BASE_URL}/whatsapp/templates/${existingRow.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ is_active: true })
        }));
        return;
      }
      if (id) {
        activeIds.add(id);
        requests.push(fetch(`${API_BASE_URL}/whatsapp/templates/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ message_body: messageBody, is_active: true })
        }));
      } else {
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
    await Promise.all(responses.map(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (response.status === 400 && payload.status === "missing_required_placeholder") {
        const error = new Error("missing_required_placeholder") as TemplateSaveError;
        error.requiredPlaceholder = String(payload.required_placeholder || "").trim();
        throw error;
      }
      if (payload.status === "duplicate_template" || payload.status === "invalid_template_length") {
        const error = new Error(String(payload.status)) as TemplateSaveError;
        error.status = String(payload.status);
        throw error;
      }
      if (!response.ok || !payload.ok) throw new Error("absence_templates_save_failed");
      return response;
    }));
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
        <label className="whatsapp-toggle-card"><span><strong>{t("whatsapp.autoSendLabel")}</strong><small>{t("whatsapp.autoSendDescription")}</small><em className={settings.auto_send ? "is-enabled" : "is-disabled"} aria-live="polite">{settings.auto_send ? t("whatsapp.autoSendEnabled") : t("whatsapp.autoSendDisabled")}</em></span><input type="checkbox" disabled={!canManage || saving || autoSendSaving} checked={settings.auto_send} onChange={(event) => void toggleAutoSend(event.target.checked)} aria-label={t("whatsapp.autoSendLabel")} /><i aria-hidden="true" /></label>
        <div className="whatsapp-delay-card"><div><strong>{t("whatsapp.delayLabel")}</strong><small>{t("whatsapp.delayDescription")}</small></div><div className="whatsapp-delay-control"><div className="whatsapp-delay-fields"><label><span>{t("whatsapp.minimum")}</span><input disabled={!canManage} type="number" min="2" max="600" value={settings.min_delay_seconds} onChange={(event) => { setFeedback("idle"); setSettings((current) => ({ ...current, min_delay_seconds: Number(event.target.value) })); }} /><em>{t("whatsapp.seconds")}</em></label><span>—</span><label><span>{t("whatsapp.maximum")}</span><input disabled={!canManage} type="number" min="2" max="600" value={settings.max_delay_seconds} onChange={(event) => { setFeedback("idle"); setSettings((current) => ({ ...current, max_delay_seconds: Number(event.target.value) })); }} /><em>{t("whatsapp.seconds")}</em></label></div><div className="whatsapp-delay-presets">{[[3, 6, "whatsapp.presetFast"], [5, 12, "whatsapp.presetBalanced"], [10, 30, "whatsapp.presetSafe"]].map(([min, max, label]) => <button className={settings.min_delay_seconds === min && settings.max_delay_seconds === max ? "active" : ""} key={label} type="button" disabled={!canManage} onClick={() => applyDelayPreset(Number(min), Number(max))}>{t(label as string)}</button>)}</div></div></div>
        <div className="whatsapp-delay-card"><div><strong>{t("whatsapp.governorTitle")}</strong><small>{t("whatsapp.governorDescription")}</small></div><div className="whatsapp-delay-control"><div className="whatsapp-delay-fields"><label><span>{t("whatsapp.maxMessagesPerHour")}</span><input disabled={!canManage} type="number" min="1" max="10000" value={settings.max_messages_per_hour} onChange={(event) => { setFeedback("idle"); setSettings((current) => ({ ...current, max_messages_per_hour: Number(event.target.value) })); }} /><em>{t("whatsapp.messages")}</em></label><label><span>{t("whatsapp.batchSize")}</span><input disabled={!canManage} type="number" min="1" max="1000" value={settings.batch_size} onChange={(event) => { setFeedback("idle"); setSettings((current) => ({ ...current, batch_size: Number(event.target.value) })); }} /><em>{t("whatsapp.messages")}</em></label></div><div className="whatsapp-delay-fields"><label><span>{t("whatsapp.batchCooldown")}</span><input disabled={!canManage} type="number" min="0" max="86400" value={settings.batch_cooldown_seconds} onChange={(event) => { setFeedback("idle"); setSettings((current) => ({ ...current, batch_cooldown_seconds: Number(event.target.value) })); }} /><em>{t("whatsapp.seconds")}</em></label><label><span>{t("whatsapp.reconnectCooldown")}</span><input disabled={!canManage} type="number" min="0" max="86400" value={settings.reconnect_cooldown_seconds} onChange={(event) => { setFeedback("idle"); setSettings((current) => ({ ...current, reconnect_cooldown_seconds: Number(event.target.value) })); }} /><em>{t("whatsapp.seconds")}</em></label></div></div></div>
      </div>
    </section>

    <section className="whatsapp-templates-section">
      <div className="whatsapp-panel-tabs" role="tablist" aria-label={t("whatsapp.panelTabsLabel")}>
        <button className={activeTab === "templates" ? "active" : ""} type="button" role="tab" aria-selected={activeTab === "templates"} onClick={() => setActiveTab("templates")}>{t("whatsapp.templatesTab")}</button>
        <button className={activeTab === "history" ? "active" : ""} type="button" role="tab" aria-selected={activeTab === "history"} onClick={() => setActiveTab("history")}>{t("whatsapp.historyTab")}</button>
      </div>
      <div className="settings-section-heading">{activeTab === "templates" ? <span>03–07</span> : null}<div><h3>{t(activeTab === "templates" ? "whatsapp.templatesTitle" : "whatsapp.messageHistoryTitle")}</h3><p>{t(activeTab === "templates" ? "whatsapp.templatesDescription" : "whatsapp.messageHistoryDescription")}</p></div></div>
      {activeTab === "history" ? <WhatsAppMessageHistory token={token} language={language} canManage={canManage} canCancelSessions={canCancelSessions} t={t} /> : <>
        <div className="whatsapp-template-groups">
          {templateGroups.map((group) => {
            const isOpen = openTemplateGroups[group.key];
            const categoryRows = templateRows.filter((row) => row.category === group.category);
            const activeCount = categoryRows.filter((row) => row.is_fallback === false && row.is_active !== false).length;
            const contentId = `whatsapp-${group.key}-content`;
            return <article className={`whatsapp-template-accordion ${isOpen ? "is-open" : ""}`} key={group.key}>
              <button id={`${contentId}-toggle`} className="whatsapp-template-accordion-toggle" type="button" aria-expanded={isOpen} aria-controls={contentId} onClick={() => toggleTemplateGroup(group.key)}>
                <span className="whatsapp-template-accordion-heading"><span className="whatsapp-template-number">{group.number}</span><span className="whatsapp-template-accordion-copy"><strong>{t(group.titleKey)}</strong><small>{t(group.descriptionKey)}</small><span className="whatsapp-template-accordion-metrics"><span className="whatsapp-template-accordion-badge">{t("whatsapp.genderPoolCount", { male: String(categoryRows.filter((row) => row.audience === "male" && row.is_active !== false).length), female: String(categoryRows.filter((row) => row.audience === "female" && row.is_active !== false).length), total: String(activeCount) })}</span><span className="whatsapp-template-accordion-badge is-total">{t("whatsapp.activeSlotCount", { count: String(activeCount) })}</span></span></span></span>
                <ChevronIcon open={isOpen} />
              </button>
              <div className={`whatsapp-template-accordion-content ${isOpen ? "is-open" : ""}`} id={contentId} role="region" aria-labelledby={`${contentId}-toggle`} aria-hidden={!isOpen}>
                <div className="whatsapp-template-accordion-inner">
                  <div className="gender-template-audiences">
                    {(["male", "female"] as const).map((audience) => <section className="gender-template-audience" key={audience}>
                      <div className="gender-template-heading"><h4>{t(audience === "male" ? "whatsapp.boysTemplates" : "whatsapp.girlsTemplates")}</h4><span>{categoryRows.filter((row) => row.audience === audience && row.is_active !== false).length}/4 {t("whatsapp.enabled")}</span></div>
                      <div className="whatsapp-template-list">{[1, 2, 3, 4].map((slotNumber) => {
                        const row = categoryRows.find((item) => item.audience === audience && item.slot_number === slotNumber);
                        if (!row) return <div className="whatsapp-template-card" key={`${audience}-${slotNumber}`}><strong>{audience === "male" ? "M" : "F"}{slotNumber}</strong><p className="form-error">{t("whatsapp.slotMissing")}</p></div>;
                        const refKey = `${group.category}-${audience}-${slotNumber}`;
                        const preview = previewTemplate(row, group);
                        return <article className={`whatsapp-template-card ${row.is_active === false ? "is-disabled" : ""}`} key={row.id}>
                          <div className="whatsapp-template-card-head"><div className="whatsapp-template-card-identity"><span className="whatsapp-template-slot-badge">{audience === "male" ? "M" : "F"}{slotNumber}</span><div><strong>{t("whatsapp.templateSlotLabel", { audience: audience === "male" ? t("whatsapp.boys") : t("whatsapp.girls"), number: String(slotNumber) })}</strong><small>{t(audience === "male" ? "whatsapp.boysTemplates" : "whatsapp.girlsTemplates")}</small></div></div><span className={`whatsapp-template-status ${row.is_active === false ? "is-disabled" : "is-enabled"}`} role="status"><i aria-hidden="true" />{row.is_active === false ? t("whatsapp.slotDisabled") : t("whatsapp.slotEnabled")}</span></div>
                          <label className="whatsapp-template-enabled"><input type="checkbox" disabled={!canManage || saving} checked={row.is_active !== false} onChange={(event) => updateSlot(row.id, { is_active: event.target.checked })} /><span>{t("whatsapp.enabled")}</span></label>
                          <div className="whatsapp-template-editor"><div className="whatsapp-template-field-label"><span>{t("whatsapp.editorLabel")}</span><small>{t("whatsapp.editorHint")}</small></div><textarea ref={(element) => { textareaRefs.current[refKey] = element; }} disabled={!canManage || saving} dir="auto" value={row.message_body} onChange={(event) => updateSlot(row.id, { message_body: event.target.value })} maxLength={2000} /></div>
                          <div className="whatsapp-template-preview-panel"><div className="whatsapp-template-field-label"><span>{t("whatsapp.previewTitle")}</span><small>{t("whatsapp.previewDescription")}</small></div><p className="whatsapp-template-preview" dir="auto">{preview}</p></div>
                          <div className="whatsapp-template-variables"><span className="whatsapp-placeholder-label">{t("whatsapp.placeholders")}</span><div className="whatsapp-placeholder-chips">{group.placeholders.map((placeholder) => { const isUsed = templateUsesPlaceholder(row.message_body, placeholder); return <button className={isUsed ? "is-used" : ""} disabled={!canManage || saving || isUsed} type="button" key={placeholder} aria-label={t(isUsed ? "whatsapp.placeholderUsed" : "whatsapp.placeholderInsert", { placeholder })} onClick={() => insertSlotPlaceholder(row, group, placeholder)}>{isUsed ? `✓ ${placeholder}` : placeholder}</button>; })}</div></div>
                        </article>;
                      })}</div>
                    </section>)}
                  </div>
                  <details className="whatsapp-neutral-fallback"><summary>{t("whatsapp.neutralFallback")}</summary>{(() => { const row = categoryRows.find((item) => item.is_fallback && item.audience === "neutral"); if (!row) return <p className="form-error">{t("whatsapp.slotMissing")}</p>; const refKey = `${group.category}-neutral`; return <article className={`whatsapp-template-card ${row.is_active === false ? "is-disabled" : ""}`}><div className="whatsapp-template-card-head"><div className="whatsapp-template-card-identity"><span className="whatsapp-template-slot-badge">N</span><div><strong>{t("whatsapp.neutralFallback")}</strong><small>{t("whatsapp.neutralFallback")}</small></div></div><span className={`whatsapp-template-status ${row.is_active === false ? "is-disabled" : "is-enabled"}`} role="status"><i aria-hidden="true" />{row.is_active === false ? t("whatsapp.slotDisabled") : t("whatsapp.slotEnabled")}</span></div><label className="whatsapp-template-enabled"><input type="checkbox" disabled={!canManage || saving} checked={row.is_active !== false} onChange={(event) => updateSlot(row.id, { is_active: event.target.checked })} /><span>{t("whatsapp.enabled")}</span></label><div className="whatsapp-template-editor"><div className="whatsapp-template-field-label"><span>{t("whatsapp.editorLabel")}</span><small>{t("whatsapp.editorHint")}</small></div><textarea ref={(element) => { textareaRefs.current[refKey] = element; }} disabled={!canManage || saving} dir="auto" value={row.message_body} onChange={(event) => updateSlot(row.id, { message_body: event.target.value })} maxLength={2000} /></div><div className="whatsapp-template-preview-panel"><div className="whatsapp-template-field-label"><span>{t("whatsapp.previewTitle")}</span><small>{t("whatsapp.previewDescription")}</small></div><p className="whatsapp-template-preview" dir="auto">{previewTemplate(row, group)}</p></div><div className="whatsapp-template-variables"><span className="whatsapp-placeholder-label">{t("whatsapp.placeholders")}</span><div className="whatsapp-placeholder-chips">{group.placeholders.map((placeholder) => { const isUsed = templateUsesPlaceholder(row.message_body, placeholder); return <button className={isUsed ? "is-used" : ""} disabled={!canManage || saving || isUsed} type="button" key={placeholder} aria-label={t(isUsed ? "whatsapp.placeholderUsed" : "whatsapp.placeholderInsert", { placeholder })} onClick={() => insertSlotPlaceholder(row, group, placeholder, refKey)}>{isUsed ? `✓ ${placeholder}` : placeholder}</button>; })}</div></div></article>; })()}</details>
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

export function CancellationReviewPanel({ token, language, t }: Pick<Props, "token" | "language" | "t">) {
  const [messages, setMessages] = useState<WhatsAppHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [sendingId, setSendingId] = useState<number | null>(null);
  const [feedback, setFeedback] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API_BASE_URL}/whatsapp/history?type=cancellation&limit=100`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
      .then(async (response) => { const payload = await response.json().catch(() => ({})); if (!response.ok || !payload.ok) throw new Error("load_failed"); setMessages(Array.isArray(payload.messages) ? payload.messages : []); })
      .catch((error) => { if (error?.name !== "AbortError") setFeedback(t("whatsapp.historyLoadFailed")); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token, refreshKey]);
  async function send(id: number) {
    if (sendingId !== null) return;
    setSendingId(id); setFeedback("");
    try {
      const response = await fetch(`${API_BASE_URL}/whatsapp/jobs/${id}/cancellation-send`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error("send_failed");
      setFeedback(t("whatsapp.cancellationReviewQueued")); setRefreshKey((value) => value + 1);
    } catch (_error) { setFeedback(t("whatsapp.cancellationReviewFailed")); }
    finally { setSendingId(null); }
  }
  const formatDate = (value: string) => new Intl.DateTimeFormat(language === "ar" ? "ar-EG" : "en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Cairo" }).format(new Date(value));
  return <section className="admin-editor whatsapp-settings-panel" dir={language === "ar" ? "rtl" : "ltr"}><div className="section-heading"><div><p className="eyebrow">{t("whatsapp.historyType.cancellation")}</p><h2>{t("whatsapp.messageHistoryTitle")}</h2></div></div>{feedback ? <p role="status" className="form-hint">{feedback}</p> : null}{loading ? <p className="form-hint">{t("whatsapp.historyLoading")}</p> : messages.length ? <div className="whatsapp-history-list">{messages.map((message) => <article className="whatsapp-history-item" key={message.id}><div className="whatsapp-history-toggle"><span className="whatsapp-history-main"><strong>{message.student_name || message.student_code || t("whatsapp.historyUnknownStudent")}</strong><small>{message.ref_code} · {formatDate(message.created_at)}</small></span><span className={`whatsapp-history-status ${message.status}`}>{t(`whatsapp.historyStatus.${message.status}`)}</span></div><pre className="whatsapp-history-message" dir="auto">{message.rendered_message || message.template_text}</pre>{message.status === "review_required" ? <button type="button" className="primary-button compact-button" disabled={sendingId !== null} onClick={() => void send(message.id)}>{sendingId === message.id ? t("whatsapp.cancellationReviewSending") : t("whatsapp.cancellationReviewSend")}</button> : null}</article>)}</div> : <p className="form-hint">{t("whatsapp.historyEmpty")}</p>}</section>;
}
