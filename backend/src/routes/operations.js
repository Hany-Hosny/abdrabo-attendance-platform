import crypto from "node:crypto";
import express from "express";
import XLSX from "xlsx";
import { pool, query } from "../db/pool.js";
import { requireAnyPermission, requirePermission, requireRoles, requireTeacher } from "../middleware/requireTeacher.js";
import { createAuditAccessToken, hashPassword, verifyAuditAccessToken, verifyPassword } from "../services/auth.js";
import { ensureMonthlyFees, getAdvanceOptions, getFeeSummary, recordAdvancePayment, recordFullPayment } from "../services/fees.js";
import { finalizeExpiredAttendanceSessions } from "../services/attendanceFinalizer.js";
import { normalizeDigits } from "../utils/normalizeDigits.js";
import { cairoDateString } from "../utils/time.js";
import { assertAttendanceWindow } from "../utils/attendanceWindow.js";
import { auditLog } from "../services/audit.js";
import { getAttendanceTimingDefaults } from "../services/systemSettings.js";
import { isValidScanValue, normalizeIdempotencyKey, normalizeScanValue, scanLookupValues } from "../utils/scan.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { hasPermission } from "../services/rbac.js";
import { ipKeyGenerator } from "express-rate-limit";
import { enqueueAttendanceNotification, enqueueAttendanceNotificationInTransaction, wakeWhatsAppWorker } from "../services/whatsapp.js";
import { MANUAL_ATTENDANCE_STATUSES } from "../utils/attendanceStatus.js";

export const operationsRouter = express.Router();
operationsRouter.use(requireTeacher);
// Every fee/payment workflow is gated by the base view capability. Action and
// report middleware below then apply the narrower capability for that route.
operationsRouter.use("/fees/payments", requirePermission("payments.view"));
operationsRouter.use("/fees/overdue", requirePermission("payments.view"));
const scannerRateLimit = createRateLimiter({ windowMs: 60_000, max: 600, key: (req) => `scanner:${req.teacher?.id || ipKeyGenerator(req.ip || "unknown")}` });
const paymentRateLimit = createRateLimiter({ windowMs: 60_000, max: 30, key: (req) => `payment:${req.teacher?.id || ipKeyGenerator(req.ip || "unknown")}` });
const recentScannerRequests = new Map();

function isRecentScannerDuplicate(teacherId, token, idempotencyKey = null) {
  const now = Date.now();
  const key = `${teacherId}:${token}`;
  const previous = recentScannerRequests.get(key);
  if (idempotencyKey && previous?.idempotencyKey === idempotencyKey) return false;
  recentScannerRequests.set(key, { at: now, idempotencyKey });
  if (recentScannerRequests.size > 10_000) {
    for (const [candidate, entry] of recentScannerRequests) {
      if (now - entry.at > 2_000) recentScannerRequests.delete(candidate);
    }
  }
  return Boolean(previous && now - previous.at < 2_000);
}

function cairoSessionTimeSql(dateExpression, timeExpression) {
  return `((${dateExpression}::date + ${timeExpression}) AT TIME ZONE 'Africa/Cairo')`;
}

function cairoSessionEndTimeSql(dateExpression) {
  return `(((${dateExpression}::date + CASE WHEN cs.end_time <= cs.start_time THEN 1 ELSE 0 END) + cs.end_time) AT TIME ZONE 'Africa/Cairo')`;
}

function cairoSessionCloseSql(dateExpression, fallbackCloseParam) {
  const startsAt = cairoSessionTimeSql(dateExpression, "cs.start_time");
  const groupOverride = `(${startsAt} + (cs.closes_after_minutes::text || ' minutes')::interval)`;
  const systemFallback = `(${startsAt} + (${fallbackCloseParam}::text || ' minutes')::interval)`;
  return `CASE
    WHEN cs.closes_after_minutes IS NOT NULL AND cs.closes_after_minutes <> 20 THEN ${groupOverride}
    WHEN ${fallbackCloseParam} <> 20 THEN ${systemFallback}
    ELSE ${startsAt} + INTERVAL '20 minutes'
  END`;
}

const studentDetails = `SELECT s.id, s.full_name, s.student_serial, s.scan_serial, s.student_code, s.qr_token, s.group_id,
  s.phone, s.guardian_phone, s.is_active, g.name AS group_name, COALESCE(g.grade_level,g.grade) AS grade_level,
  g.fees_amount, g.is_active AS group_active FROM students s JOIN groups g ON g.id=s.group_id AND s.deleted_at IS NULL`;

function normalizedSearch(value) {
  return normalizeDigits(value).trim().toLocaleLowerCase("ar-EG")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[إأآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/ـ/g, "");
}

function searchableSql(field) {
  return `LOWER(${field}) ILIKE '%' || $SEARCH || '%' OR LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(${field},'إ','ا'),'أ','ا'),'آ','ا'),'ٱ','ا'),'ى','ي'),'ة','ه')) ILIKE '%' || $SEARCH || '%'`;
}

const activePaymentFilter = "NOT EXISTS (SELECT 1 FROM payment_reversals pr WHERE pr.payment_id = p.id)";
const paymentMethods = new Set(["cash", "bank_transfer", "card", "other"]);

function collectionSummary(summary) {
  if (!summary) return null;
  const allowedFields = [
    "id", "full_name", "student_serial", "student_code", "group_name", "grade_level",
    "required_amount", "paid_amount", "remaining_balance", "current_cycle_fee",
    "current_cycle_paid", "current_cycle_outstanding", "payment_status", "monthly_dues"
  ];
  return Object.fromEntries(allowedFields.filter((field) => Object.prototype.hasOwnProperty.call(summary, field)).map((field) => [field, summary[field]]));
}

function requireAuditAccess(req, res, next) {
  if (!verifyAuditAccessToken(req.headers["x-audit-access-token"], req.teacher.id)) {
    return res.status(403).json({ ok: false, status: "audit_access_required" });
  }
  return next();
}

function auditDateRange(fromValue, toValue) {
  const dateFrom = normalizeDigits(String(fromValue || "")).trim();
  const dateTo = normalizeDigits(String(toValue || "")).trim();
  const isValidDate = (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  };
  if (!isValidDate(dateFrom) || !isValidDate(dateTo)) return null;
  return dateFrom <= dateTo ? { dateFrom, dateTo } : { dateFrom: dateTo, dateTo: dateFrom };
}

const auditTargetTypes = new Set(["students", "groups", "attendance", "fees", "exams", "whatsapp", "settings", "login"]);
const auditOutcomes = new Set(["success", "failure"]);

function validAuditFilterDate(value) {
  const normalized = normalizeDigits(String(value || "")).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  const parsed = new Date(`${normalized}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === normalized ? normalized : null;
}

function auditEntityTypeSql() {
  return `COALESCE(NULLIF(a.details->>'entity_type', ''), CASE
    WHEN a.action LIKE 'student%' OR a.action LIKE 'students%' THEN 'students'
    WHEN a.action LIKE 'group%' THEN 'groups'
    WHEN a.action LIKE 'attendance%' OR a.action = 'suspicious_scan' THEN 'attendance'
    WHEN a.action LIKE 'payment%' OR a.action LIKE 'advance_payment%' THEN 'fees'
    WHEN a.action LIKE 'exam%' OR a.action LIKE 'homework%' THEN 'exams'
    WHEN a.action LIKE 'whatsapp%' OR a.action LIKE 'message%' OR a.action LIKE 'inbox%' THEN 'whatsapp'
    WHEN a.action LIKE 'login%' OR a.action = 'logout' THEN 'login'
    WHEN a.action LIKE 'user%' OR a.action LIKE '%permission%' OR a.action LIKE '%role%' OR a.action LIKE 'ownership%' OR a.action LIKE 'audit_%' OR a.action LIKE 'system_%' THEN 'settings'
    WHEN COALESCE(a.details->>'path', a.details->'request'->>'path') LIKE '%/students%' THEN 'students'
    WHEN COALESCE(a.details->>'path', a.details->'request'->>'path') LIKE '%/groups%' THEN 'groups'
    WHEN COALESCE(a.details->>'path', a.details->'request'->>'path') LIKE '%/attendance%' OR COALESCE(a.details->>'path', a.details->'request'->>'path') LIKE '%/scanner%' THEN 'attendance'
    WHEN COALESCE(a.details->>'path', a.details->'request'->>'path') LIKE '%/fees%' OR COALESCE(a.details->>'path', a.details->'request'->>'path') LIKE '%/payments%' THEN 'fees'
    WHEN COALESCE(a.details->>'path', a.details->'request'->>'path') LIKE '%/exams%' OR COALESCE(a.details->>'path', a.details->'request'->>'path') LIKE '%/homework%' THEN 'exams'
    WHEN COALESCE(a.details->>'path', a.details->'request'->>'path') LIKE '%/whatsapp%' OR COALESCE(a.details->>'path', a.details->'request'->>'path') LIKE '%/inbox%' THEN 'whatsapp'
    WHEN COALESCE(a.details->>'path', a.details->'request'->>'path') LIKE '%/login%' OR COALESCE(a.details->>'path', a.details->'request'->>'path') LIKE '%/logout%' THEN 'login'
    ELSE 'settings'
  END)`;
}

function auditOutcomeSql() {
  return `CASE
    WHEN a.details->>'outcome' IN ('success', 'failure') THEN a.details->>'outcome'
    WHEN a.details->>'status_code' ~ '^([45][0-9]{2})$' THEN 'failure'
    WHEN a.action LIKE '%failed%' OR a.action = 'audit_pin_failed' THEN 'failure'
    ELSE 'success'
  END`;
}

function auditGroupIdSql() {
  return `CASE WHEN COALESCE(s.group_id::text, a.details->>'group_id') ~ '^[0-9]+$'
    THEN COALESCE(s.group_id::text, a.details->>'group_id')::bigint END`;
}

function buildAuditLogQuery(queryParams = {}, { includePagination = true } = {}) {
  const values = [];
  const filters = ["TRUE"];
  const add = (sql, value) => {
    values.push(value);
    filters.push(sql.replaceAll("?", `$${values.length}`));
  };
  const addRepeated = (sql, repeatedValues) => {
    const placeholders = repeatedValues.map((value) => {
      values.push(value);
      return `$${values.length}`;
    });
    let placeholderIndex = 0;
    filters.push(sql.replaceAll("?", () => placeholders[placeholderIndex++]));
  };
  const search = normalizedSearch(queryParams.q || queryParams.search);
  if (search) {
    const searchParam = `%${search}%`;
    addRepeated(`(
      LOWER(a.action) ILIKE ? OR LOWER(COALESCE(t.name,'')) ILIKE ? OR LOWER(COALESCE(t.username,'')) ILIKE ? OR
      LOWER(COALESCE(t.email,'')) ILIKE ? OR LOWER(COALESCE(s.full_name,'')) ILIKE ? OR
      LOWER(COALESCE(s.student_code,'')) ILIKE ? OR LOWER(COALESCE(s.student_serial,'')) ILIKE ? OR
      LOWER(COALESCE(s.scan_serial,'')) ILIKE ? OR LOWER(COALESCE(g.display_name,g.name,'')) ILIKE ? OR
      a.id::text ILIKE ? OR a.details::text ILIKE ?
    )`, Array(11).fill(searchParam));
  }
  if (queryParams.action) add("a.action = ?", String(queryParams.action).trim());
  if (queryParams.actor_id || queryParams.user_id) {
    const actorId = Number(normalizeDigits(queryParams.actor_id || queryParams.user_id));
    if (Number.isSafeInteger(actorId) && actorId > 0) add("a.actor_id = ?", actorId);
  }
  if (queryParams.actor_role) add("t.role = ?", String(queryParams.actor_role).trim());
  if (queryParams.student_id) {
    const studentId = Number(normalizeDigits(queryParams.student_id));
    if (Number.isSafeInteger(studentId) && studentId > 0) add("a.student_id = ?", studentId);
  }
  const studentQuery = normalizedSearch(queryParams.student || queryParams.student_query);
  if (studentQuery) {
    const studentParam = `%${studentQuery}%`;
    addRepeated(`(LOWER(COALESCE(s.full_name,'')) ILIKE ? OR LOWER(COALESCE(s.student_code,'')) ILIKE ? OR LOWER(COALESCE(s.student_serial,'')) ILIKE ? OR LOWER(COALESCE(s.scan_serial,'')) ILIKE ? OR LOWER(COALESCE(s.phone,'')) ILIKE ? OR LOWER(COALESCE(s.guardian_phone,'')) ILIKE ?)`, Array(6).fill(studentParam));
  }
  if (queryParams.group_id) {
    const groupId = Number(normalizeDigits(queryParams.group_id));
    if (Number.isSafeInteger(groupId) && groupId > 0) add(`${auditGroupIdSql()} = ?`, groupId);
  }
  if (queryParams.entity_type && auditTargetTypes.has(String(queryParams.entity_type))) add(`${auditEntityTypeSql()} = ?`, String(queryParams.entity_type));
  if (queryParams.outcome && auditOutcomes.has(String(queryParams.outcome))) add(`${auditOutcomeSql()} = ?`, String(queryParams.outcome));
  const dateFrom = validAuditFilterDate(queryParams.date_from);
  const dateTo = validAuditFilterDate(queryParams.date_to);
  if (dateFrom) add("a.created_at >= (CAST(CAST(? AS date) AS timestamp) AT TIME ZONE 'Africa/Cairo')", dateFrom);
  if (dateTo) add("a.created_at < (CAST(CAST(? AS date) + INTERVAL '1 day' AS timestamp) AT TIME ZONE 'Africa/Cairo')", dateTo);
  if (queryParams.payment_id) {
    const paymentId = Number(normalizeDigits(queryParams.payment_id));
    if (Number.isSafeInteger(paymentId) && paymentId > 0) add("a.payment_id = ?", paymentId);
  }
  if (queryParams.log_id) {
    const logId = Number(normalizeDigits(queryParams.log_id));
    if (Number.isSafeInteger(logId) && logId > 0) add("a.id = ?", logId);
  }

  let page = Math.max(1, Number(queryParams.page || 1));
  let limit = Math.min(200, Math.max(1, Number(queryParams.limit || queryParams.page_size || 50)));
  if (!Number.isSafeInteger(page)) page = 1;
  if (!Number.isSafeInteger(limit)) limit = 50;
  const maxPageForSafeOffset = Math.floor(Number.MAX_SAFE_INTEGER / limit) + 1;
  if (page > maxPageForSafeOffset) page = maxPageForSafeOffset;
  const pagination = includePagination ? (() => {
    values.push(limit, (page - 1) * limit);
    return `LIMIT $${values.length - 1} OFFSET $${values.length}`;
  })() : "";
  return { filters, values, page, limit, pagination };
}

const auditActionLabels = {
  ar: {
    payment_created: "تم تسجيل دفع المصروفات", advance_payment_created: "تم تسجيل دفع مقدم", payment_reversed: "تم عكس دفعة",
    student_created: "تم إنشاء طالب", student_updated: "تم تعديل بيانات طالب", student_changed: "تم تعديل الطالب", student_status_changed: "تم تغيير حالة طالب", student_restored: "تم استرجاع طالب", student_archived: "تمت أرشفة طالب", students_bulk_archived: "تمت أرشفة طلاب محددون", students_bulk_permanently_deleted: "تم حذف طلاب نهائيًا", student_label_printed: "تمت طباعة ليبل الطالب", student_scan_serial_regenerated: "تم تجديد سريال مسح الطالب",
    attendance_recorded: "تم تسجيل الحضور", attendance_changed: "تم تغيير الحضور", attendance_scanned: "تم تنفيذ مسح الحضور", attendance_session_created: "تم إنشاء جلسة حضور", attendance_session_auto_finalized: "إغلاق جلسة الحضور أوتوماتيكياً", attendance_session_auto_reopened: "إعادة فتح جلسة الحضور أوتوماتيكياً", attendance_absence_notifications_queued: "تجهيز إشعارات الغياب", suspicious_scan: "تم تسجيل محاولة مسح مشبوهة",
    group_created: "تم إنشاء مجموعة", group_updated: "تم تعديل المجموعة", group_changed: "تم تعديل المجموعة", group_status_changed: "تم تغيير حالة المجموعة", group_archived: "تمت أرشفة المجموعة",
    exam_result_created: "تم تسجيل نتيجة امتحان", exam_result_updated: "تم تعديل نتيجة امتحان", exam_result_changed: "تم تعديل نتيجة امتحان", exam_result_deleted: "تم حذف نتيجة امتحان", homework_created: "تم إنشاء واجب", homework_updated: "تم تعديل واجب", homework_deleted: "تم حذف واجب",
    message_sent: "تم إرسال رسالة", message_deleted: "تم حذف رسالة", message_action: "تم تنفيذ إجراء على رسالة", message_read_status_changed: "تم تحديث حالة قراءة الرسالة", note_created: "تمت إضافة ملاحظة", note_updated: "تم تعديل ملاحظة", note_deleted: "تم حذف ملاحظة",
    user_created: "تم إنشاء مستخدم", user_updated: "تم تعديل مستخدم", user_changed: "تم تعديل مستخدم", permissions_changed: "تم تعديل صلاحيات مستخدم", role_changed: "تم تغيير دور مستخدم", ownership_transferred: "تم نقل ملكية النظام", user_password_reset: "تم تغيير كلمة مرور مستخدم", user_status_changed: "تم تغيير حالة مستخدم", user_archived: "تمت أرشفة مستخدم", user_restored: "تم استرجاع مستخدم", user_permanently_deleted: "تم حذف مستخدم نهائيًا", login_succeeded: "تم تسجيل الدخول", login_failed: "فشلت محاولة تسجيل الدخول", logout: "تم تسجيل الخروج", audit_logs_unlocked: "تم فتح سجل النشاط", audit_pin_changed: "تم تغيير رقم سجل النشاط", audit_pin_failed: "فشلت محاولة فتح سجل النشاط", audit_logs_exported: "تم تصدير سجل النشاط", system_settings_changed: "تم تعديل إعدادات النظام", whatsapp_settings_changed: "تحديث إعدادات وقوالب الواتساب", whatsapp_settings_updated: "تحديث إعدادات وقوالب الواتساب", whatsapp_disconnected: "تم فصل اتصال واتساب", whatsapp_template_created: "تم إنشاء قالب واتساب", site_content_updated: "تم تحديث محتوى الموقع", exam_results_bulk_imported: "تم استيراد نتائج امتحانات جماعياً", email_provider_tested: "تم اختبار مزود البريد الإلكتروني", advanced_settings_updated: "تم تحديث الإعدادات المتقدمة", system_admin_action: "إجراء إداري عام على النظام", system_action: "إجراء إداري عام على النظام", system_request: "إجراء عام على النظام"
  },
  en: {
    payment_created: "Payment recorded", advance_payment_created: "Advance payment recorded", payment_reversed: "Payment reversed",
    student_created: "Student created", student_updated: "Student updated", student_changed: "Student changed", student_status_changed: "Student status changed", student_restored: "Student restored", student_archived: "Student archived", students_bulk_archived: "Students archived in bulk", students_bulk_permanently_deleted: "Students permanently deleted in bulk", student_label_printed: "Student label printed", student_scan_serial_regenerated: "Student scan serial regenerated",
    attendance_recorded: "Attendance recorded", attendance_changed: "Attendance changed", attendance_scanned: "Attendance scan processed", attendance_session_created: "Attendance session created", attendance_session_auto_finalized: "Attendance session closed automatically", attendance_session_auto_reopened: "Attendance session reopened automatically", attendance_absence_notifications_queued: "Absence notifications prepared", suspicious_scan: "Suspicious scan recorded",
    group_created: "Group created", group_updated: "Group updated", group_changed: "Group updated", group_status_changed: "Group status changed", group_archived: "Group archived",
    exam_result_created: "Exam result recorded", exam_result_updated: "Exam result updated", exam_result_changed: "Exam result updated", exam_result_deleted: "Exam result deleted", homework_created: "Homework created", homework_updated: "Homework updated", homework_deleted: "Homework deleted",
    message_sent: "Message sent", message_deleted: "Message deleted", message_action: "Message action", message_read_status_changed: "Message read status updated", note_created: "Note added", note_updated: "Note updated", note_deleted: "Note deleted",
    user_created: "User created", user_updated: "User updated", user_changed: "User updated", permissions_changed: "User permissions changed", role_changed: "User role changed", ownership_transferred: "System ownership transferred", user_password_reset: "User password changed", user_status_changed: "User status changed", user_archived: "User archived", user_restored: "User restored", user_permanently_deleted: "User permanently deleted", login_succeeded: "Login successful", login_failed: "Login attempt failed", logout: "Logged out", audit_logs_unlocked: "Audit logs unlocked", audit_pin_changed: "Audit PIN changed", audit_pin_failed: "Audit PIN attempt failed", audit_logs_exported: "Audit log exported", system_settings_changed: "System settings changed", whatsapp_settings_changed: "WhatsApp settings and templates updated", whatsapp_settings_updated: "WhatsApp settings and templates updated", whatsapp_disconnected: "WhatsApp disconnected", whatsapp_template_created: "WhatsApp template created", site_content_updated: "Site content updated", exam_results_bulk_imported: "Exam results imported in bulk", email_provider_tested: "Email provider tested", advanced_settings_updated: "Advanced settings updated", system_admin_action: "General administrative system action", system_action: "General administrative system action", system_request: "General system action"
  }
};

function auditActionLabel(action, language) {
  return auditActionLabels[language][action] || auditActionLabels[language].system_action;
}

function auditExportRows(logs, language) {
  return logs.map((log) => {
    const details = log.details && typeof log.details === "object" ? log.details : {};
    const action = String(log.action || "system_action");
    const outcome = String(log.outcome || "success");
    const target = String(log.entity_type || "settings");
    const student = log.student_name ? `${log.student_name}${log.student_code ? ` (${log.student_code})` : ""}` : "—";
    const group = log.group_name || "—";
    const actor = log.actor_name || log.actor_username || log.actor_email || "System";
    const date = new Date(log.created_at).toLocaleString(language === "ar" ? "ar-EG" : "en-US", { dateStyle: "medium", timeStyle: "short" });
    const summary = details.summary || details.message || `${auditActionLabel(action, language)}${log.student_name ? ` — ${log.student_name}` : ""}`;
    return {
      "Activity ID": String(log.id),
      "Date / التاريخ": date,
      "User / المستخدم": actor,
      "Role / الدور": log.actor_role || "—",
      "Action / الإجراء": auditActionLabel(action, language),
      "Target / القسم": target,
      "Student / الطالب": student,
      "Group / المجموعة": group,
      "Payment ID / رقم الدفع": log.payment_id || "—",
      "Amount / المبلغ": log.payment_amount || "—",
      "Result / النتيجة": outcome === "failure" ? (language === "ar" ? "فشل" : "Failed") : (language === "ar" ? "نجاح" : "Success"),
      "Summary / الوصف": summary
    };
  });
}

operationsRouter.get("/payments/report", requirePermission("payments.view"), requirePermission("payments.reports.view"), async (req, res, next) => {
  try {
    const values = [];
    const filters = ["TRUE"];
    const paymentTimestamp = "COALESCE(p.paid_at, p.payment_date::timestamp AT TIME ZONE 'Africa/Cairo')";
    const add = (sql, value) => { values.push(value); filters.push(sql.replaceAll("?", `$${values.length}`)); };
    const search = normalizedSearch(req.query.q);
    if (search) {
      values.push(`%${search}%`);
      const searchParam = `$${values.length}`;
      const nationalIdHash = crypto.createHash("sha256").update(normalizeDigits(req.query.q).trim()).digest("hex");
      values.push(nationalIdHash);
      const hashParam = `$${values.length}`;
      filters.push(`(COALESCE(p.student_name_snapshot,s.full_name) ILIKE ${searchParam} OR COALESCE(p.student_code_snapshot,s.student_code) ILIKE ${searchParam} OR COALESCE(p.student_serial_snapshot,s.student_serial) ILIKE ${searchParam} OR COALESCE(p.scan_serial_snapshot,s.scan_serial) ILIKE ${searchParam} OR s.phone ILIKE ${searchParam} OR s.guardian_phone ILIKE ${searchParam} OR COALESCE(p.group_name_snapshot,COALESCE(g.display_name,g.name)) ILIKE ${searchParam} OR COALESCE(p.grade_level_snapshot,COALESCE(g.grade_level,g.grade)) ILIKE ${searchParam} OR s.national_id_hash = ${hashParam})`);
    }
    if (req.query.date_from) add(`${paymentTimestamp} >= (?::date::timestamp AT TIME ZONE 'Africa/Cairo')`, normalizeDigits(req.query.date_from).trim());
    if (req.query.date_to) add(`${paymentTimestamp} < (((?::date + INTERVAL '1 day')::timestamp) AT TIME ZONE 'Africa/Cairo')`, normalizeDigits(req.query.date_to).trim());
    if (req.query.group_id) {
      const groupValue = normalizeDigits(req.query.group_id).trim();
      if (/^\d+$/.test(groupValue)) add("g.id = ?", Number(groupValue));
      else add("COALESCE(g.display_name,g.name) ILIKE ?", `%${groupValue}%`);
    }
    if (req.query.grade_level) add("COALESCE(g.grade_level,g.grade) ILIKE ?", `%${normalizeDigits(req.query.grade_level).trim()}%`);
    const result = await query(`SELECT p.id, ${paymentTimestamp} AS paid_at, p.amount, p.payment_months, p.payment_type, p.whatsapp_notified,
        COALESCE(p.student_name_snapshot,s.full_name) AS full_name,
        COALESCE(p.student_code_snapshot,s.student_code) AS student_code,
        COALESCE(p.student_serial_snapshot,s.student_serial) AS student_serial,
        COALESCE(p.scan_serial_snapshot,s.scan_serial) AS scan_serial,
        COALESCE(p.group_name_snapshot,COALESCE(g.display_name,g.name)) AS group_name,
        COALESCE(p.grade_level_snapshot,COALESCE(g.grade_level,g.grade)) AS grade_level,
        COALESCE(u.name,u.username,u.email,'Staff') AS paid_by
      FROM payments p LEFT JOIN students s ON s.id=p.student_id JOIN groups g ON g.id=p.group_id
      LEFT JOIN teachers u ON u.id=COALESCE(p.paid_by,p.recorded_by)
      WHERE ${filters.join(" AND ")} AND ${activePaymentFilter} ORDER BY ${paymentTimestamp} DESC`, values);
    res.json({ ok: true, payments: result.rows, total_paid: result.rows.reduce((sum, row) => sum + Number(row.amount), 0), payment_count: result.rowCount });
  } catch (error) { next(error); }
});

operationsRouter.post("/fees/payments/:paymentId/reverse", requirePermission("payments.view"), requirePermission("payments.reverse"), async (req, res, next) => {
  const paymentId = Number(req.params.paymentId);
  const reason = String(req.body?.reason || "").trim();
  if (!Number.isSafeInteger(paymentId) || paymentId <= 0) return res.status(400).json({ ok: false, status: "invalid_payment" });
  if (reason.length < 3 || reason.length > 500) return res.status(400).json({ ok: false, status: "invalid_reason", message: "A reversal reason is required. / يجب إدخال سبب عكس الدفعة." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const paymentResult = await client.query(`
      SELECT p.*, s.full_name, s.student_code, s.student_serial, s.scan_serial,
        COALESCE(g.display_name, g.name) AS group_name,
        COALESCE(g.grade_level, g.grade) AS grade_level
      FROM payments p
      LEFT JOIN students s ON s.id = p.student_id
      JOIN groups g ON g.id = p.group_id
      WHERE p.id = $1
      FOR UPDATE
    `, [paymentId]);
    if (!paymentResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, status: "payment_not_found" });
    }
    const payment = paymentResult.rows[0];
    const existing = await client.query("SELECT id, created_at FROM payment_reversals WHERE payment_id = $1", [paymentId]);
    if (existing.rowCount) {
      await client.query("ROLLBACK");
      return res.status(409).json({ ok: false, status: "already_reversed", reversal: existing.rows[0] });
    }

    const reversal = await client.query(`
      INSERT INTO payment_reversals (payment_id, reversed_by, reason, original_amount)
      VALUES ($1, $2, $3, $4)
      RETURNING id, payment_id, reversed_by, reason, original_amount, created_at
    `, [paymentId, req.teacher.id, reason, payment.amount]);

    const months = Array.isArray(payment.payment_months) ? payment.payment_months : [];
    for (const covered of months) {
      const month = String(covered?.month || "").slice(0, 10);
      const amount = Number(covered?.amount || 0);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(month) || !Number.isFinite(amount) || amount <= 0) continue;
      await client.query(`
        UPDATE fee_dues
        SET paid_amount = GREATEST(0, paid_amount - $1)
        WHERE student_id = $2 AND due_month = $3::date
      `, [amount, payment.student_id, month]);
    }

    await auditLog({ db: client, action: "payment_reversed", actorId: req.teacher.id, studentId: payment.student_id, paymentId, request: req, details: {
      reversal_id: reversal.rows[0].id,
      reason,
      original_amount: Number(payment.amount),
      status_before: "paid",
      status_after: "reversed",
      payment_date: payment.payment_date,
      payment_type: payment.payment_type,
      payment_method: payment.payment_method,
      payment_months: months,
      student_name_snapshot: payment.student_name_snapshot || payment.full_name,
      student_code_snapshot: payment.student_code_snapshot || payment.student_code,
      student_serial_snapshot: payment.student_serial_snapshot || payment.student_serial,
      group_name_snapshot: payment.group_name_snapshot || payment.group_name,
      grade_level_snapshot: payment.grade_level_snapshot || payment.grade_level
    }});
    await client.query("COMMIT");
    return res.status(201).json({ ok: true, reversal: reversal.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    next(error);
  } finally {
    client.release();
  }
});

operationsRouter.get("/audit-logs/status", requirePermission("activity_log.view"), async (req, res, next) => {
  try {
    const result = await query("SELECT audit_pin_hash IS NOT NULL AS configured FROM teachers WHERE id = $1", [req.teacher.id]);
    res.json({ ok: true, configured: Boolean(result.rows[0]?.configured) });
  } catch (error) { next(error); }
});

operationsRouter.post("/audit-logs/pin", requirePermission("activity_log.view"), async (req, res, next) => {
  try {
    const pin = normalizeDigits(req.body?.pin || "").trim();
    const currentPassword = String(req.body?.current_password || "");
    if (!/^\d{4}$/.test(pin)) return res.status(400).json({ ok: false, status: "invalid_pin", message: "PIN must contain exactly 4 digits. / يجب أن يتكون الرقم السري من 4 أرقام." });
    const admin = await query("SELECT password_hash FROM teachers WHERE id = $1 AND role IN ('owner','admin') AND is_active = TRUE AND deleted_at IS NULL", [req.teacher.id]);
    if (!admin.rowCount || !verifyPassword(currentPassword, admin.rows[0].password_hash)) return res.status(403).json({ ok: false, status: "invalid_admin_password" });
    await query("UPDATE teachers SET audit_pin_hash = $1, audit_pin_failed_attempts = 0, audit_pin_locked_until = NULL, updated_at = NOW() WHERE id = $2", [hashPassword(pin), req.teacher.id]);
    await auditLog({ action: "audit_pin_changed", actorId: req.teacher.id, details: { pin_digits: 4, change: "Audit PIN was replaced." }, request: req });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

operationsRouter.post("/audit-logs/unlock", requirePermission("activity_log.view"), async (req, res, next) => {
  const pin = normalizeDigits(req.body?.pin || "").trim();
  if (!/^\d{4}$/.test(pin)) return res.status(400).json({ ok: false, status: "invalid_pin" });
  try {
    const admin = await query("SELECT audit_pin_hash, audit_pin_failed_attempts, audit_pin_locked_until FROM teachers WHERE id = $1 AND role IN ('owner','admin') AND is_active = TRUE AND deleted_at IS NULL", [req.teacher.id]);
    if (!admin.rowCount || !admin.rows[0].audit_pin_hash) return res.status(409).json({ ok: false, status: "audit_pin_not_configured" });
    const record = admin.rows[0];
    if (record.audit_pin_locked_until && new Date(record.audit_pin_locked_until).getTime() > Date.now()) return res.status(429).json({ ok: false, status: "audit_pin_locked", retry_after_seconds: Math.ceil((new Date(record.audit_pin_locked_until).getTime() - Date.now()) / 1000) });
    if (!verifyPassword(pin, record.audit_pin_hash)) {
      const failedAttempts = Number(record.audit_pin_failed_attempts || 0) + 1;
      const lockedUntil = failedAttempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
      await query("UPDATE teachers SET audit_pin_failed_attempts = $1, audit_pin_locked_until = $2 WHERE id = $3", [lockedUntil ? 0 : failedAttempts, lockedUntil, req.teacher.id]);
      await auditLog({ action: "audit_pin_failed", actorId: req.teacher.id, details: { locked: Boolean(lockedUntil), failed_attempts: failedAttempts }, request: req });
      return res.status(401).json({ ok: false, status: lockedUntil ? "audit_pin_locked" : "invalid_pin", retry_after_seconds: lockedUntil ? 900 : undefined });
    }
    await query("UPDATE teachers SET audit_pin_failed_attempts = 0, audit_pin_locked_until = NULL WHERE id = $1", [req.teacher.id]);
    await auditLog({ action: "audit_logs_unlocked", actorId: req.teacher.id, details: { access_duration_minutes: 10 }, request: req });
    res.json({ ok: true, audit_access_token: createAuditAccessToken(req.teacher.id), expires_in_seconds: 600 });
  } catch (error) { next(error); }
});

operationsRouter.get("/audit-logs/maintenance/preview", requirePermission("activity_log.view"), requireRoles("owner", "admin"), requireAuditAccess, async (req, res, next) => {
  try {
    const range = auditDateRange(req.query.date_from, req.query.date_to);
    if (!range) return res.status(400).json({ ok: false, status: "invalid_date_range" });
    const result = await query(`
      SELECT COUNT(*)::int AS count
      FROM audit_logs
      WHERE created_at >= (CAST(CAST($1 AS date) AS timestamp) AT TIME ZONE 'Africa/Cairo')
        AND created_at < (CAST(CAST($2 AS date) + INTERVAL '1 day' AS timestamp) AT TIME ZONE 'Africa/Cairo')
    `, [range.dateFrom, range.dateTo]);
    res.json({ ok: true, count: Number(result.rows[0]?.count || 0), date_from: range.dateFrom, date_to: range.dateTo });
  } catch (error) { next(error); }
});

operationsRouter.post("/audit-logs/maintenance/delete", requirePermission("activity_log.view"), requireRoles("owner", "admin"), requireAuditAccess, async (req, res, next) => {
  const range = auditDateRange(req.body?.date_from, req.body?.date_to);
  const pin = normalizeDigits(req.body?.pin || "").trim();
  const currentPassword = String(req.body?.current_password || "");
  const reason = String(req.body?.reason || "").trim();
  const confirmation = String(req.body?.confirmation || "").trim();
  if (!range) return res.status(400).json({ ok: false, status: "invalid_date_range" });
  if (!/^\d{4}$/.test(pin)) return res.status(400).json({ ok: false, status: "invalid_pin" });
  if (confirmation !== "DELETE AUDIT LOGS") return res.status(400).json({ ok: false, status: "invalid_confirmation" });
  if (reason.length < 3 || reason.length > 500) return res.status(400).json({ ok: false, status: "invalid_reason" });

  try {
    const admin = await query("SELECT password_hash, audit_pin_hash, audit_pin_failed_attempts, audit_pin_locked_until FROM teachers WHERE id = $1 AND role IN ('owner','admin') AND is_active = TRUE AND deleted_at IS NULL", [req.teacher.id]);
    if (!admin.rowCount || !admin.rows[0].audit_pin_hash) return res.status(409).json({ ok: false, status: "audit_pin_not_configured" });
    const record = admin.rows[0];
    if (record.audit_pin_locked_until && new Date(record.audit_pin_locked_until).getTime() > Date.now()) return res.status(429).json({ ok: false, status: "audit_pin_locked", retry_after_seconds: Math.ceil((new Date(record.audit_pin_locked_until).getTime() - Date.now()) / 1000) });
    if (!verifyPassword(pin, record.audit_pin_hash)) {
      const failedAttempts = Number(record.audit_pin_failed_attempts || 0) + 1;
      const lockedUntil = failedAttempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
      await query("UPDATE teachers SET audit_pin_failed_attempts = $1, audit_pin_locked_until = $2 WHERE id = $3", [lockedUntil ? 0 : failedAttempts, lockedUntil, req.teacher.id]);
      await auditLog({ action: "audit_pin_failed", actorId: req.teacher.id, details: { reason: "audit_log_deletion", locked: Boolean(lockedUntil), failed_attempts: failedAttempts }, request: req });
      return res.status(401).json({ ok: false, status: lockedUntil ? "audit_pin_locked" : "invalid_pin", retry_after_seconds: lockedUntil ? 900 : undefined });
    }
    if (!verifyPassword(currentPassword, record.password_hash)) return res.status(403).json({ ok: false, status: "invalid_admin_password" });
    await query("UPDATE teachers SET audit_pin_failed_attempts = 0, audit_pin_locked_until = NULL WHERE id = $1", [req.teacher.id]);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const deleted = await client.query(`
        WITH deleted AS (
          DELETE FROM audit_logs
          WHERE created_at >= (CAST(CAST($1 AS date) AS timestamp) AT TIME ZONE 'Africa/Cairo')
            AND created_at < (CAST(CAST($2 AS date) + INTERVAL '1 day' AS timestamp) AT TIME ZONE 'Africa/Cairo')
          RETURNING id
        )
        SELECT COUNT(*)::int AS deleted_count FROM deleted
      `, [range.dateFrom, range.dateTo]);
      const deletedCount = Number(deleted.rows[0]?.deleted_count || 0);
      await client.query(`
        INSERT INTO audit_log_deletions (actor_id, date_from, date_to, deleted_count, reason, ip_address, user_agent)
        VALUES ($1, $2::date, $3::date, $4, $5, $6, $7)
      `, [req.teacher.id, range.dateFrom, range.dateTo, deletedCount, reason, req.ip, req.get("user-agent") || null]);
      await client.query("COMMIT");
      return res.json({ ok: true, deleted_count: deletedCount, date_from: range.dateFrom, date_to: range.dateTo });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      return next(error);
    } finally {
      client.release();
    }
  } catch (error) { next(error); }
});

const auditLogJoins = `
  FROM audit_logs a
  LEFT JOIN teachers t ON t.id = a.actor_id
  LEFT JOIN students s ON s.id = a.student_id
  LEFT JOIN payments p ON p.id = a.payment_id
  LEFT JOIN payment_reversals pr ON pr.payment_id = a.payment_id
  LEFT JOIN groups g ON g.id = ${auditGroupIdSql()}
`;

function auditLogSelectSql(builder) {
  return `
    SELECT a.id, a.action, a.actor_id, a.student_id, a.payment_id, a.session_id, a.details, a.created_at,
      t.name AS actor_name, t.username AS actor_username, t.email AS actor_email, t.role AS actor_role,
      COALESCE(s.full_name, p.student_name_snapshot) AS student_name,
      COALESCE(s.student_code, p.student_code_snapshot) AS student_code,
      COALESCE(s.student_serial, p.student_serial_snapshot) AS student_serial,
      COALESCE(s.scan_serial, p.scan_serial_snapshot) AS scan_serial,
      ${auditGroupIdSql()} AS group_id,
      COALESCE(g.display_name, g.name, p.group_name_snapshot) AS group_name,
      p.amount AS payment_amount, p.payment_type, pr.id AS reversal_id, pr.reason AS reversal_reason,
      ${auditEntityTypeSql()} AS entity_type,
      ${auditOutcomeSql()} AS outcome
    ${auditLogJoins}
    WHERE ${builder.filters.join(" AND ")}
    ORDER BY a.created_at DESC, a.id DESC
    ${builder.pagination}
  `;
}

function resolveAuditLogRow(row) {
  let action = row.action;
  if (action === "system_request") {
    const request = row.details?.request && typeof row.details.request === "object" ? row.details.request : {};
    const path = String(row.details?.path || request.path || "");
    const method = row.details?.method || request.method;
    if (path.includes("/reset-password")) action = "user_password_reset";
    else if (path.endsWith("/users") && method === "POST") action = "user_created";
    else if (path.includes("/users/") && method === "PUT") action = "user_updated";
    else if (path.includes("/users/") && method === "DELETE") action = "user_archived";
    else if (path.includes("/audit-logs/unlock")) action = "audit_logs_unlocked";
    else if (path.includes("/audit-logs/pin")) action = "audit_pin_changed";
  }
  return {
    ...row,
    action,
    details: {
      ...(row.details || {}),
      _audit_action: action,
      _payment_id: row.payment_id,
      _payment_amount: row.payment_amount,
      _student_name: row.student_name,
      _student_code: row.student_code,
      _group_name: row.group_name
    }
  };
}

operationsRouter.get("/audit-logs/filters", requirePermission("activity_log.view"), requireAuditAccess, async (req, res, next) => {
  try {
    const studentSearch = normalizedSearch(req.query.student_search);
    const studentValues = studentSearch ? [`%${studentSearch}%`] : [];
    const studentWhere = studentSearch ? `WHERE LOWER(s.full_name) ILIKE $1 OR LOWER(s.student_code) ILIKE $1 OR LOWER(s.student_serial) ILIKE $1 OR LOWER(s.scan_serial) ILIKE $1 OR LOWER(s.phone) ILIKE $1 OR LOWER(s.guardian_phone) ILIKE $1` : "";
    const [users, groups, students] = await Promise.all([
      query("SELECT id, name, username, email, role FROM teachers WHERE deleted_at IS NULL ORDER BY name, username LIMIT 500"),
      query("SELECT id, COALESCE(display_name, name) AS name, COALESCE(grade_level, grade) AS grade_level FROM groups ORDER BY COALESCE(display_name, name) LIMIT 500"),
      query(`SELECT s.id, s.full_name, s.student_code, s.student_serial, s.scan_serial, s.phone, s.guardian_phone, s.group_id, COALESCE(g.display_name, g.name) AS group_name FROM students s LEFT JOIN groups g ON g.id=s.group_id ${studentWhere} ORDER BY s.full_name LIMIT 500`, studentValues)
    ]);
    res.json({ ok: true, users: users.rows, groups: groups.rows, students: students.rows });
  } catch (error) { next(error); }
});

operationsRouter.get("/audit-logs", requirePermission("activity_log.view"), requireAuditAccess, async (req, res, next) => {
  try {
    const builder = buildAuditLogQuery(req.query);
    const countBuilder = buildAuditLogQuery(req.query, { includePagination: false });
    const result = await query(auditLogSelectSql(builder), builder.values);
    const countResult = await query(`SELECT COUNT(*)::int AS total ${auditLogJoins} WHERE ${countBuilder.filters.join(" AND ")}`, countBuilder.values);
    const statsResult = await query(`
      SELECT COUNT(*) FILTER (WHERE ${auditOutcomeSql()} = 'success')::int AS success_count,
        COUNT(*) FILTER (WHERE ${auditOutcomeSql()} = 'failure')::int AS failure_count,
        COUNT(DISTINCT a.actor_id)::int AS user_count
      ${auditLogJoins}
      WHERE ${countBuilder.filters.join(" AND ")}
    `, countBuilder.values);
    const logs = result.rows.map(resolveAuditLogRow);
    const stats = statsResult.rows[0] || {};
    const totalItems = Number(countResult.rows[0]?.total || 0);
    const totalPages = Math.max(1, Math.ceil(totalItems / builder.limit));
    res.json({
      ok: true,
      data: logs,
      pagination: {
        totalItems,
        totalPages,
        currentPage: builder.page,
        limit: builder.limit
      },
      stats: { success_count: Number(stats.success_count || 0), failure_count: Number(stats.failure_count || 0), user_count: Number(stats.user_count || 0) }
    });
  } catch (error) { next(error); }
});

operationsRouter.get("/audit-logs/export", requirePermission("activity_log.export"), requireRoles("owner", "admin"), requireAuditAccess, async (req, res, next) => {
  try {
    const format = String(req.query.format || "csv").toLowerCase();
    if (!["csv", "xlsx"].includes(format)) return res.status(400).json({ ok: false, status: "invalid_export_format" });
    const scope = String(req.query.scope || "all").toLowerCase();
    const builder = buildAuditLogQuery(req.query, { includePagination: scope !== "all" });
    if (scope === "all") {
      builder.values.push(50_000);
      builder.pagination = `LIMIT $${builder.values.length}`;
    }
    const result = await query(auditLogSelectSql(builder), builder.values);
    const logs = result.rows.map(resolveAuditLogRow);
    const language = req.query.language === "ar" ? "ar" : "en";
    const exportRows = auditExportRows(logs, language);
    await auditLog({
      action: "audit_logs_exported",
      actorId: req.teacher.id,
      details: { format, scope, result_count: exportRows.length, filters: { search: req.query.search || req.query.q || "", action: req.query.action || "", entity_type: req.query.entity_type || "", outcome: req.query.outcome || "", date_from: req.query.date_from || "", date_to: req.query.date_to || "" } },
      request: req
    });
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === "xlsx") {
      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.json_to_sheet(exportRows);
      XLSX.utils.book_append_sheet(workbook, worksheet, "Activity Center");
      const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition", `attachment; filename="activity-center-${stamp}.xlsx"`);
      return res.send(buffer);
    }
    const columns = Object.keys(exportRows[0] || { "Activity ID": "" });
    const escapeCsv = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const csv = `\uFEFF${columns.map(escapeCsv).join(",")}\r\n${exportRows.map((row) => columns.map((column) => escapeCsv(row[column])).join(",")).join("\r\n")}`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="activity-center-${stamp}.csv"`);
    return res.send(csv);
  } catch (error) { next(error); }
});

operationsRouter.get("/payments/late", requirePermission("payments.view"), requirePermission("payments.reports.view"), async (req, res, next) => {
  try {
    await ensureMonthlyFees();
    const values = [];
    const filters = ["s.deleted_at IS NULL"];
    const add = (sql, value) => { values.push(value); filters.push(sql.replaceAll("?", `$${values.length}`)); };
    const search = normalizedSearch(req.query.q);
    if (search) {
      values.push(`%${search}%`);
      const searchParam = `$${values.length}`;
      values.push(crypto.createHash("sha256").update(normalizeDigits(req.query.q).trim()).digest("hex"));
      const hashParam = `$${values.length}`;
      filters.push(`(s.full_name ILIKE ${searchParam} OR s.student_code ILIKE ${searchParam} OR s.student_serial ILIKE ${searchParam} OR s.scan_serial ILIKE ${searchParam} OR s.phone ILIKE ${searchParam} OR s.guardian_phone ILIKE ${searchParam} OR COALESCE(g.display_name,g.name) ILIKE ${searchParam} OR COALESCE(g.grade_level,g.grade) ILIKE ${searchParam} OR s.national_id_hash = ${hashParam})`);
    }
    if (req.query.group_id) {
      const groupValue = normalizeDigits(req.query.group_id).trim();
      if (/^\d+$/.test(groupValue)) add("g.id = ?", Number(groupValue));
      else add("COALESCE(g.display_name,g.name) ILIKE ?", `%${groupValue}%`);
    }
    if (req.query.grade_level) add("COALESCE(g.grade_level,g.grade) ILIKE ?", `%${normalizeDigits(req.query.grade_level).trim()}%`);
    if (req.query.include_disabled !== "true") filters.push("s.is_active = TRUE");
    const from = normalizeDigits(req.query.date_from || "").trim() || null;
    const to = normalizeDigits(req.query.date_to || "").trim() || null;
    values.push(from, to);
    const fromParam = `$${values.length - 1}`;
    const toParam = `$${values.length}`;
    const result = await query(`WITH bounds AS (
        SELECT date_trunc('month', COALESCE(${fromParam}::date, (NOW() AT TIME ZONE 'Africa/Cairo')::date))::date AS month_from,
          date_trunc('month', COALESCE(${toParam}::date, (NOW() AT TIME ZONE 'Africa/Cairo')::date))::date AS month_to
      ), dues AS (
        SELECT fd.student_id, SUM(fd.amount) AS required_amount, SUM(fd.paid_amount) AS paid_amount,
          COALESCE(jsonb_agg(jsonb_build_object('month', fd.due_month, 'amount', fd.amount, 'paid_amount', fd.paid_amount, 'remaining_amount', fd.amount - fd.paid_amount) ORDER BY fd.due_month) FILTER (WHERE fd.amount > fd.paid_amount), '[]'::jsonb) AS unpaid_months
        FROM fee_dues fd CROSS JOIN bounds
        WHERE fd.due_month >= bounds.month_from AND fd.due_month <= bounds.month_to
        GROUP BY fd.student_id
      )
      SELECT s.id, s.full_name, s.student_code, s.student_serial, s.scan_serial, s.guardian_phone,
        COALESCE(g.display_name,g.name) AS group_name, COALESCE(g.grade_level,g.grade) AS grade_level,
        COALESCE(d.required_amount, 0) AS required_amount, COALESCE(d.paid_amount, 0) AS paid_amount,
        COALESCE(d.required_amount, 0) - COALESCE(d.paid_amount, 0) AS remaining_balance,
        d.unpaid_months, MAX(COALESCE(p.paid_at,p.payment_date)) AS last_payment_date
      FROM students s JOIN groups g ON g.id=s.group_id JOIN dues d ON d.student_id=s.id
      LEFT JOIN payments p ON p.student_id=s.id
      WHERE ${filters.join(" AND ")}
      GROUP BY s.id, g.id, d.required_amount, d.paid_amount, d.unpaid_months
      HAVING COALESCE(d.required_amount, 0) > COALESCE(d.paid_amount, 0)
      ORDER BY s.full_name`, values);
    res.json({ ok: true, students: result.rows, total_expected_unpaid: result.rows.reduce((sum, row) => sum + Number(row.remaining_balance), 0), late_student_count: result.rowCount });
  } catch (error) { next(error); }
});

operationsRouter.get("/attendance/sessions", requirePermission("attendance.view"), async (req, res, next) => {
  try {
    await finalizeExpiredAttendanceSessions();
    const date = normalizeDigits(req.query.date || cairoDateString()).trim();
    const timing = await getAttendanceTimingDefaults();
    const groupId = req.query.group_id ? Number(normalizeDigits(req.query.group_id)) : null;
    let groupFilter = "";
    if (groupId) groupFilter = " AND s.group_id=$2";
    await query(`
      INSERT INTO attendance_sessions (group_id, schedule_id, session_date, starts_at, opens_at, closes_at, ends_at, status)
      SELECT cs.group_id, cs.id, $1::date,
        ${cairoSessionTimeSql("$1", "cs.start_time")},
        (($1::date + cs.start_time - ((CASE WHEN cs.opens_before_minutes = 3 THEN $2 ELSE cs.opens_before_minutes END) || ' minutes')::interval) AT TIME ZONE 'Africa/Cairo'),
        ${cairoSessionCloseSql("$1", "$3")},
        ${cairoSessionEndTimeSql("$1")},
        'open'
      FROM class_schedules cs
      JOIN groups g ON g.id=cs.group_id AND g.is_active=TRUE AND g.deleted_at IS NULL
      WHERE cs.is_active=TRUE AND cs.day_of_week=EXTRACT(DOW FROM $1::date)::INTEGER
        ${groupId ? "AND cs.group_id=$4" : ""}
      ON CONFLICT (group_id, schedule_id, session_date) DO NOTHING
    `, groupId ? [date, timing.openBeforeMinutes, timing.closeAfterMinutes, groupId] : [date, timing.openBeforeMinutes, timing.closeAfterMinutes]);
    await finalizeExpiredAttendanceSessions();
    const resultParams = groupId ? [date, groupId] : [date];
    const result = await query(`SELECT s.*, g.name AS group_name, COALESCE(g.grade_level,g.grade) AS grade_level,
      cs.day_of_week, cs.start_time, cs.end_time
      FROM attendance_sessions s
      JOIN groups g ON g.id=s.group_id AND g.is_active=TRUE AND g.deleted_at IS NULL
      JOIN class_schedules cs ON cs.id=s.schedule_id AND cs.group_id=s.group_id
        AND cs.is_active=TRUE AND cs.day_of_week=EXTRACT(DOW FROM s.session_date)::INTEGER
      WHERE s.session_date=$1${groupFilter} ORDER BY cs.start_time`, resultParams);
    res.json({ ok: true, sessions: result.rows });
  } catch (error) { next(error); }
});

operationsRouter.post("/attendance/sessions", requirePermission("attendance.manage"), async (req, res, next) => {
  try {
    const groupId = Number(normalizeDigits(req.body?.group_id)), scheduleId = Number(normalizeDigits(req.body?.schedule_id));
    const date = String(req.body?.session_date || cairoDateString());
    if (!groupId || !scheduleId) return res.status(400).json({ ok:false, status:"invalid_session_payload" });
    const timing = await getAttendanceTimingDefaults();
    const result = await query(`INSERT INTO attendance_sessions (group_id,schedule_id,session_date,starts_at,opens_at,closes_at,ends_at,status)
      SELECT $1, cs.id, $3::date, ${cairoSessionTimeSql("$3", "cs.start_time")}, (($3::date + cs.start_time - ((CASE WHEN cs.opens_before_minutes = 3 THEN $4 ELSE cs.opens_before_minutes END) || ' minutes')::interval) AT TIME ZONE 'Africa/Cairo'),
      ${cairoSessionCloseSql("$3", "$5")},
      ${cairoSessionEndTimeSql("$3")}, 'open'
      FROM class_schedules cs JOIN groups g ON g.id=cs.group_id AND g.is_active=TRUE AND g.deleted_at IS NULL
      WHERE cs.id=$2 AND cs.group_id=$1 AND cs.is_active=TRUE
        AND cs.day_of_week=EXTRACT(DOW FROM $3::date)::INTEGER
      RETURNING *`, [groupId, scheduleId, date, timing.openBeforeMinutes, timing.closeAfterMinutes]);
    if (!result.rowCount) return res.status(400).json({ok:false,status:"invalid_schedule"});
    await auditLog({ action: "attendance_session_created", actorId: req.teacher.id, sessionId: result.rows[0].id, details: { group_id: groupId, schedule_id: scheduleId, session_date: date, status_after: result.rows[0].status }, request: req });
    res.status(201).json({ok:true,session:result.rows[0]});
  } catch (error) { if (error.code === "23505") return res.status(409).json({ok:false,status:"session_exists"}); next(error); }
});

operationsRouter.get("/attendance/sessions/:id/records", requirePermission("attendance.view"), async (req, res, next) => {
  try { await finalizeExpiredAttendanceSessions(); const result = await query(`SELECT ar.*, s.full_name, s.student_serial, COALESCE(g.grade_level,g.grade) AS grade_level, g.name AS group_name
    FROM attendance_records ar JOIN students s ON s.id=ar.student_id JOIN groups g ON g.id=s.group_id WHERE ar.session_id=$1 ORDER BY s.full_name`, [req.params.id]); res.json({ok:true,records:result.rows}); }
  catch (error) { next(error); }
});

operationsRouter.get("/scanner/students", requirePermission("attendance.manage"), async (req, res, next) => {
  try {
    const result = await query(`
      SELECT s.id, s.full_name, s.student_code, s.student_serial, s.scan_serial, s.qr_token,
        s.group_id, COALESCE(g.display_name, g.name) AS group_name,
        COALESCE(g.grade_level, g.grade) AS grade_level, s.is_active
      FROM students s
      JOIN groups g ON g.id = s.group_id
      WHERE s.deleted_at IS NULL AND s.is_active = TRUE
        AND g.deleted_at IS NULL AND g.is_active = TRUE
      ORDER BY s.id
    `);
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, students: result.rows });
  } catch (error) { next(error); }
});

operationsRouter.post("/scanner/student-lookup", requireAnyPermission("students.view", "attendance.view", "payments.view"), async (req, res, next) => {
  try {
    const value = normalizeScanValue(req.body?.value ?? req.body?.qr_token);
    const lookupValues = scanLookupValues(value).map((candidate) => candidate.toLowerCase());
    if (!isValidScanValue(value) || !lookupValues.length) return res.status(400).json({ ok: false, status: "invalid_scan_value" });
    const result = await query(`
      SELECT s.id, s.full_name, s.student_code, s.student_serial, s.scan_serial,
        s.group_id, s.is_active, s.deleted_at,
        g.name AS group_name, COALESCE(g.grade_level, g.grade) AS grade_level,
        g.is_active AS group_active
      FROM students s
      LEFT JOIN groups g ON g.id = s.group_id
      WHERE LOWER(COALESCE(s.qr_token, '')) = ANY($1::text[])
         OR LOWER(COALESCE(s.scan_serial, '')) = ANY($1::text[])
         OR LOWER(COALESCE(s.student_serial, '')) = ANY($1::text[])
         OR LOWER(COALESCE(s.student_code, '')) = ANY($1::text[])
      ORDER BY s.deleted_at NULLS FIRST, s.is_active DESC
      LIMIT 1
    `, [lookupValues]);
    if (!result.rowCount) return res.status(404).json({ ok: false, status: "student_not_found" });
    const student = result.rows[0];
    const status = student.deleted_at ? "deleted_student" : !student.is_active || student.group_active === false ? "inactive_student" : "student_found";
    return res.status(status === "student_found" ? 200 : 409).json({
      ok: status === "student_found",
      status,
      student: {
        id: student.id,
        full_name: student.full_name,
        student_code: student.student_code,
        student_serial: student.student_serial,
        scan_serial: student.scan_serial,
        group_id: student.group_id,
        group_name: student.group_name,
        grade_level: student.grade_level,
        is_active: student.is_active,
        deleted_at: student.deleted_at
      }
    });
  } catch (error) { next(error); }
});

operationsRouter.post("/fees/scan-lookup", requirePermission("payments.view"), async (req, res, next) => {
  try {
    const value = normalizeScanValue(req.body?.value ?? req.body?.qr_token);
    const lookupValues = scanLookupValues(value).map((candidate) => candidate.toLowerCase());
    if (!isValidScanValue(value) || !lookupValues.length) return res.status(400).json({ ok: false, status: "invalid_scan_value" });
    const studentResult = await query(`
      SELECT s.id, s.full_name, s.student_code, s.student_serial, s.scan_serial,
        s.is_active, s.deleted_at, g.name AS group_name,
        COALESCE(g.grade_level, g.grade) AS grade_level, g.is_active AS group_active
      FROM students s JOIN groups g ON g.id=s.group_id
      WHERE s.deleted_at IS NULL AND s.is_active=TRUE AND g.deleted_at IS NULL AND g.is_active=TRUE
        AND (LOWER(COALESCE(s.qr_token,''))=ANY($1::text[]) OR LOWER(COALESCE(s.scan_serial,''))=ANY($1::text[])
          OR LOWER(COALESCE(s.student_serial,''))=ANY($1::text[]) OR LOWER(COALESCE(s.student_code,''))=ANY($1::text[]))
      LIMIT 1
    `, [lookupValues]);
    if (!studentResult.rowCount) return res.status(404).json({ ok: false, status: "student_not_found" });
    const studentId = studentResult.rows[0].id;
    const mode = req.body?.mode === "advance" ? "advance" : "new";
    if (mode === "advance" && !hasPermission(req.teacher, "payments.advance")) {
      return res.status(403).json({ ok: false, status: "permission_required", permission: "payments.advance" });
    }
    const data = mode === "advance" ? await getAdvanceOptions(studentId) : await getFeeSummary(studentId);
    if (!data) return res.status(404).json({ ok: false, status: "student_not_found" });
    return res.json({ ok: true, status: "student_found", mode, ...(mode === "advance" ? data : { summary: collectionSummary(data) }) });
  } catch (error) { next(error); }
});

async function recordAttendance({ sessionId, studentId, actorId, method = "scanner", status = "present", ip, deviceId, idempotencyKey = null, whatsappNotified = false, request }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM attendance_sessions WHERE id=$1 FOR UPDATE", [sessionId]);
    const result = await client.query(`INSERT INTO attendance_records (session_id,student_id,status,method,ip_address,device_id,idempotency_key,whatsapp_notified)
    SELECT $1,$2,$3,$4,$5,$6,$7,$8
    WHERE EXISTS (
      SELECT 1
      FROM attendance_sessions s
      JOIN class_schedules cs ON cs.id=s.schedule_id AND cs.group_id=s.group_id
      WHERE s.id=$1 AND s.status='open' AND cs.is_active=TRUE AND cs.deleted_at IS NULL
        AND cs.day_of_week=EXTRACT(DOW FROM (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Cairo'))::INTEGER
        AND s.session_date=(CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Cairo')::date
        AND CURRENT_TIMESTAMP BETWEEN
          ((s.session_date + cs.start_time - (cs.opens_before_minutes || ' minutes')::interval) AT TIME ZONE 'Africa/Cairo')
          AND ((s.session_date + cs.start_time + (cs.closes_after_minutes || ' minutes')::interval) AT TIME ZONE 'Africa/Cairo')
    )
    ON CONFLICT DO NOTHING RETURNING *`, [sessionId, studentId, status, method, ip, deviceId, idempotencyKey, Boolean(whatsappNotified)]);
  if (!result.rowCount) {
    const stillOpen = await client.query(`
      SELECT 1
      FROM attendance_sessions s
      JOIN class_schedules cs ON cs.id=s.schedule_id AND cs.group_id=s.group_id
      WHERE s.id=$1 AND s.status='open' AND cs.is_active=TRUE AND cs.deleted_at IS NULL
        AND cs.day_of_week=EXTRACT(DOW FROM (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Cairo'))::INTEGER
        AND s.session_date=(CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Cairo')::date
        AND CURRENT_TIMESTAMP BETWEEN
          ((s.session_date + cs.start_time - (cs.opens_before_minutes || ' minutes')::interval) AT TIME ZONE 'Africa/Cairo')
          AND ((s.session_date + cs.start_time + (cs.closes_after_minutes || ' minutes')::interval) AT TIME ZONE 'Africa/Cairo')
      LIMIT 1
    `, [sessionId]);
    if (!stillOpen.rowCount) {
      await client.query("COMMIT");
      return { windowClosed: true };
    }
    if (idempotencyKey) {
      const replay = await client.query("SELECT * FROM attendance_records WHERE idempotency_key=$1 LIMIT 1", [idempotencyKey]);
      if (replay.rowCount) {
        const record = replay.rows[0];
        if (Number(record.session_id) !== Number(sessionId) || Number(record.student_id) !== Number(studentId)) {
          await client.query("COMMIT");
          return { duplicate: true, idempotencyConflict: true, record: null };
        }
        await client.query("COMMIT");
        return { replay: true, record };
      }
    }
    const existing = await client.query("SELECT * FROM attendance_records WHERE session_id=$1 AND student_id=$2 LIMIT 1 FOR UPDATE", [sessionId, studentId]);
    if (status === "excused" && existing.rows[0]?.method === "system" && existing.rows[0]?.status === "absent") {
      const corrected = await client.query(`UPDATE attendance_records
        SET status = 'excused', method = 'manual', checkin_time = NOW(), whatsapp_notified = FALSE
        WHERE id = $1
        RETURNING *`, [existing.rows[0].id]);
      await client.query(`UPDATE whatsapp_notification_jobs
        SET status = 'skipped', last_error = 'attendance_excused', next_attempt_at = NULL,
            lease_expires_at = NULL, updated_at = NOW()
        WHERE notification_type = 'absence' AND attendance_record_id = $1
          AND status IN ('pending', 'processing')`, [existing.rows[0].id]);
      await auditLog({ db: client, action: "attendance_recorded", actorId, studentId, sessionId, details: { method: "manual", status_before: "absent", status_after: "excused", record_id: corrected.rows[0].id }, request });
      await client.query("COMMIT");
      return { corrected: true, record: corrected.rows[0] };
    }
    await client.query("COMMIT");
    return { duplicate: true, record: existing.rows[0] || null };
  }
  let whatsapp = null;
  if ((status === "present" || status === "late") && whatsappNotified) {
    whatsapp = await enqueueAttendanceNotificationInTransaction(client, { attendanceRecordId: result.rows[0].id, studentId });
    const considered = Boolean(whatsapp?.queued || ["already_queued", "already_sent", "already_processed"].includes(whatsapp?.reason));
    await client.query("UPDATE attendance_records SET whatsapp_notified = $2 WHERE id = $1", [result.rows[0].id, considered]);
    result.rows[0].whatsapp_notified = considered;
  }
  await auditLog({ db: client, action: "attendance_recorded", actorId, studentId, sessionId, details: { method, status_before: null, status_after: status, record_id: result.rows[0].id, checkin_time: result.rows[0].checkin_time, whatsapp_queue_reason: whatsapp?.reason || null }, request });
  await client.query("COMMIT");
  if (whatsapp?.queued) wakeWhatsAppWorker();
  return { record: result.rows[0], whatsapp };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function attendanceWindowMessage(status) {
  if (status === "session_not_started") return "Session not started.";
  if (status === "attendance_day_mismatch") return "This class is not scheduled today.";
  return "Attendance window closed.";
}

async function resolveRequestedAttendanceSession({ sessionId, groupId, actorId, request }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`attendance-group:${groupId}`]);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`attendance-session:${sessionId}`]);
    const sessionResult = await client.query(`
      SELECT s.*, to_char(s.session_date, 'YYYY-MM-DD') AS session_date_key,
        cs.day_of_week, cs.start_time, cs.end_time,
        cs.opens_before_minutes, cs.closes_after_minutes,
        g.is_active AS group_active, g.deleted_at AS group_deleted_at
      FROM attendance_sessions s
      JOIN class_schedules cs ON cs.id=s.schedule_id AND cs.group_id=s.group_id
        AND cs.is_active=TRUE AND cs.deleted_at IS NULL
      JOIN groups g ON g.id=s.group_id
      WHERE s.id=$1
      FOR UPDATE OF s
    `, [sessionId]);
    if (!sessionResult.rowCount) {
      await client.query("COMMIT");
      return { status: "session_not_found" };
    }
    const session = sessionResult.rows[0];
    if (Number(session.group_id) !== Number(groupId)) {
      await client.query("COMMIT");
      return { status: "wrong_group" };
    }
    if (!session.group_active || session.group_deleted_at) {
      await client.query("COMMIT");
      return { status: "attendance_window_closed", session };
    }

    const clock = await client.query("SELECT CURRENT_TIMESTAMP AS server_now");
    let window;
    try {
      window = assertAttendanceWindow({
        sessionDate: session.session_date_key,
        dayOfWeek: session.day_of_week,
        startTime: session.start_time,
        endTime: session.end_time,
        openBeforeMinutes: session.opens_before_minutes,
        closeAttendanceAfterMinutes: session.closes_after_minutes
      }, { now: clock.rows[0].server_now });
    } catch (error) {
      await client.query("COMMIT");
      return { status: error.code || "attendance_window_closed", session, window: error.attendanceWindow };
    }

    if (session.status !== "open") {
      const reopened = await client.query(`
        UPDATE attendance_sessions s
        SET status='open',
            starts_at=((s.session_date::date + cs.start_time) AT TIME ZONE 'Africa/Cairo'),
            opens_at=(((s.session_date::date + cs.start_time - (cs.opens_before_minutes || ' minutes')::interval)) AT TIME ZONE 'Africa/Cairo'),
            closes_at=(((s.session_date::date + cs.start_time + (cs.closes_after_minutes || ' minutes')::interval)) AT TIME ZONE 'Africa/Cairo'),
            ends_at=((((s.session_date::date + CASE WHEN cs.end_time <= cs.start_time THEN 1 ELSE 0 END) + cs.end_time)) AT TIME ZONE 'Africa/Cairo')
        FROM class_schedules cs
        WHERE s.id=$1 AND cs.id=s.schedule_id
        RETURNING s.*
      `, [sessionId]);
      if (!reopened.rowCount) throw new Error("attendance_session_reopen_conflict");
      await auditLog({
        db: client,
        action: "attendance_session_auto_reopened",
        actorId,
        sessionId,
        details: {
          group_id: session.group_id,
          schedule_id: session.schedule_id,
          status_before: session.status,
          status_after: "open",
          previous_bounds: { starts_at: session.starts_at, opens_at: session.opens_at, closes_at: session.closes_at, ends_at: session.ends_at },
          recalculated_bounds: { starts_at: reopened.rows[0].starts_at, opens_at: reopened.rows[0].opens_at, closes_at: reopened.rows[0].closes_at, ends_at: reopened.rows[0].ends_at },
          server_now: clock.rows[0].server_now,
          window
        },
        request
      });
      await client.query("COMMIT");
      return { status: "ok", session: reopened.rows[0], window, reopened: true };
    }
    await client.query("COMMIT");
    return { status: "ok", session, window, reopened: false };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function resolveImplicitAttendanceSession({ groupId, actorId, request }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`attendance-group:${groupId}`]);
    const result = await client.query(`
      SELECT s.*, to_char(s.session_date, 'YYYY-MM-DD') AS session_date_key,
        cs.day_of_week, cs.start_time, cs.end_time,
        cs.opens_before_minutes, cs.closes_after_minutes,
        g.is_active AS group_active, g.deleted_at AS group_deleted_at
      FROM attendance_sessions s
      JOIN groups g ON g.id=s.group_id AND g.is_active=TRUE AND g.deleted_at IS NULL
      JOIN class_schedules cs ON cs.id=s.schedule_id AND cs.group_id=s.group_id
        AND cs.is_active=TRUE AND cs.deleted_at IS NULL
      WHERE s.group_id=$1
        AND s.session_date=(CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Cairo')::date
        AND cs.day_of_week=EXTRACT(DOW FROM (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Cairo'))::INTEGER
      ORDER BY s.starts_at, s.id
      FOR UPDATE OF s
    `, [groupId]);
    const clock = await client.query("SELECT CURRENT_TIMESTAMP AS server_now");
    let fallbackStatus = "closed_session";
    for (const session of result.rows) {
      let window;
      try {
        window = assertAttendanceWindow({
          sessionDate: session.session_date_key,
          dayOfWeek: session.day_of_week,
          startTime: session.start_time,
          endTime: session.end_time,
          openBeforeMinutes: session.opens_before_minutes,
          closeAttendanceAfterMinutes: session.closes_after_minutes
        }, { now: clock.rows[0].server_now });
      } catch (error) {
        fallbackStatus = error.code || fallbackStatus;
        continue;
      }
      if (session.status !== "open") {
        const reopened = await client.query(`
          UPDATE attendance_sessions s
          SET status='open',
              starts_at=((s.session_date::date + cs.start_time) AT TIME ZONE 'Africa/Cairo'),
              opens_at=(((s.session_date::date + cs.start_time - (cs.opens_before_minutes || ' minutes')::interval)) AT TIME ZONE 'Africa/Cairo'),
              closes_at=(((s.session_date::date + cs.start_time + (cs.closes_after_minutes || ' minutes')::interval)) AT TIME ZONE 'Africa/Cairo'),
              ends_at=((((s.session_date::date + CASE WHEN cs.end_time <= cs.start_time THEN 1 ELSE 0 END) + cs.end_time)) AT TIME ZONE 'Africa/Cairo')
          FROM class_schedules cs
          WHERE s.id=$1 AND cs.id=s.schedule_id
          RETURNING s.*
        `, [session.id]);
        if (!reopened.rowCount) throw new Error("attendance_session_reopen_conflict");
        await auditLog({
          db: client,
          action: "attendance_session_auto_reopened",
          actorId,
          sessionId: session.id,
          details: { group_id: groupId, schedule_id: session.schedule_id, status_before: session.status, status_after: "open", server_now: clock.rows[0].server_now, window },
          request
        });
        await client.query("COMMIT");
        return { status: "ok", session: reopened.rows[0], window, reopened: true };
      }
      await client.query("COMMIT");
      return { status: "ok", session, window, reopened: false };
    }
    await client.query("COMMIT");
    return { status: fallbackStatus };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function correctSystemAbsence({ sessionId, studentId, actorId, ip, deviceId, idempotencyKey, whatsappNotified, request }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM attendance_sessions WHERE id=$1 FOR UPDATE", [sessionId]);
    const corrected = await client.query(`
      UPDATE attendance_records
      SET status='present', method='scanner', checkin_time=NOW(), ip_address=$3, device_id=$4,
          whatsapp_notified=$5, idempotency_key=COALESCE(idempotency_key,$6)
      WHERE session_id=$1 AND student_id=$2 AND method='system' AND status='absent'
        AND EXISTS (
          SELECT 1
          FROM attendance_sessions s
          JOIN class_schedules cs ON cs.id=s.schedule_id AND cs.group_id=s.group_id
          WHERE s.id=$1 AND s.status='open' AND cs.is_active=TRUE AND cs.deleted_at IS NULL
            AND cs.day_of_week=EXTRACT(DOW FROM (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Cairo'))::INTEGER
            AND s.session_date=(CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Cairo')::date
            AND CURRENT_TIMESTAMP BETWEEN
              ((s.session_date + cs.start_time - (cs.opens_before_minutes || ' minutes')::interval) AT TIME ZONE 'Africa/Cairo')
              AND ((s.session_date + cs.start_time + (cs.closes_after_minutes || ' minutes')::interval) AT TIME ZONE 'Africa/Cairo')
        )
      RETURNING *
    `, [sessionId, studentId, ip, deviceId, whatsappNotified, idempotencyKey]);
    if (!corrected.rowCount) {
      await client.query("COMMIT");
      return null;
    }
    const whatsapp = whatsappNotified
      ? await enqueueAttendanceNotificationInTransaction(client, { attendanceRecordId: corrected.rows[0].id, studentId })
      : null;
    const considered = Boolean(whatsapp?.queued || ["already_queued", "already_sent", "already_processed"].includes(whatsapp?.reason));
    await client.query("UPDATE attendance_records SET whatsapp_notified = $2 WHERE id = $1", [corrected.rows[0].id, considered]);
    await client.query(`UPDATE whatsapp_notification_jobs
      SET status = 'skipped', last_error = 'attendance_corrected', next_attempt_at = NULL,
          lease_expires_at = NULL, updated_at = NOW()
      WHERE notification_type = 'absence' AND attendance_record_id = $1
        AND status IN ('pending', 'processing')`, [corrected.rows[0].id]);
    corrected.rows[0].whatsapp_notified = considered;
    await auditLog({ db: client, action: "attendance_recorded", actorId, studentId, sessionId, details: { method: "scanner", status_before: "absent", status_after: "present", record_id: corrected.rows[0].id, corrected_system_absence: true, whatsapp_queue_reason: whatsapp?.reason || null }, request });
    await client.query("COMMIT");
    if (whatsapp?.queued) wakeWhatsAppWorker();
    return corrected.rows[0];
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

operationsRouter.post("/attendance/manual", requirePermission("attendance.manage"), async (req, res, next) => {
  try {
    const sessionId=Number(normalizeDigits(req.body?.session_id)), studentId=Number(normalizeDigits(req.body?.student_id)), status=String(req.body?.status||"present");
    const whatsappNotified = req.body?.send_whatsapp !== false && hasPermission(req.teacher, "whatsapp.send_attendance");
    if (!sessionId || !studentId || !MANUAL_ATTENDANCE_STATUSES.includes(status)) return res.status(400).json({ok:false,status:"invalid_attendance_payload"});
    const check = await query("SELECT 1 FROM attendance_sessions s JOIN students st ON st.group_id=s.group_id WHERE s.id=$1 AND st.id=$2", [sessionId,studentId]);
    if (!check.rowCount) return res.status(400).json({ok:false,status:"wrong_group"});
    const existing = await query("SELECT id, status, method FROM attendance_records WHERE session_id=$1 AND student_id=$2 LIMIT 1", [sessionId, studentId]);
    if (existing.rowCount && ((existing.rows[0].method === "system" && existing.rows[0].status === "absent") || existing.rows[0].status === "excused")) {
      const previousStatus = existing.rows[0].status;
      const updated = await query(`UPDATE attendance_records
        SET status=$1, method='manual', checkin_time=NOW(), whatsapp_notified=$3
        WHERE id=$2
        RETURNING *`, [status, existing.rows[0].id, status === "present" || status === "late" ? whatsappNotified : false]);
      await auditLog({ action: "attendance_recorded", actorId: req.teacher.id, studentId, sessionId, details: { method: "manual", status_before: previousStatus, status_after: status, record_id: updated.rows[0].id }, request: req });
      if (status === "present" || status === "late" || status === "excused") {
        await query(`UPDATE whatsapp_notification_jobs
          SET status = 'skipped', last_error = 'attendance_corrected', next_attempt_at = NULL,
              lease_expires_at = NULL, updated_at = NOW()
          WHERE notification_type = 'absence' AND attendance_record_id = $1
            AND status IN ('pending', 'processing')`, [updated.rows[0].id]);
        if (whatsappNotified && (status === "present" || status === "late")) {
          const whatsapp = await enqueueAttendanceNotification({ attendanceRecordId: updated.rows[0].id, studentId });
          const considered = Boolean(whatsapp?.queued || ["already_queued", "already_sent", "already_processed"].includes(whatsapp?.reason));
          await query("UPDATE attendance_records SET whatsapp_notified = $2 WHERE id = $1", [updated.rows[0].id, considered]);
          updated.rows[0].whatsapp_notified = considered;
        }
      }
      return res.status(200).json({ok:true,record:updated.rows[0],corrected:true});
    }
    const saved=await recordAttendance({sessionId,studentId,actorId:req.teacher.id,status,method:"manual",ip:req.ip,whatsappNotified,request:req});
    if (saved.corrected) return res.status(200).json({ok:true,record:saved.record,corrected:true});
    if (saved.duplicate) return res.status(409).json({ok:false,status:"duplicate_attendance"});
    res.status(201).json({ok:true,record:saved.record});
  } catch (error) { next(error); }
});

operationsRouter.post("/scanner/attendance", scannerRateLimit, requirePermission("attendance.manage"), async (req, res, next) => {
  try {
    const token = normalizeScanValue(req.body?.value ?? req.body?.qr_token);
    const lookupValues = scanLookupValues(token).map((candidate) => candidate.toLowerCase());
    if (!isValidScanValue(token) || !lookupValues.length) return res.status(400).json({ ok: false, status: "invalid_scan_value" });
    const deviceId = String(req.body?.device_id || "").trim();
    if (deviceId && deviceId.length > 128) return res.status(400).json({ ok: false, status: "invalid_device_id" });
    const rawIdempotencyKey = req.get("Idempotency-Key") || req.body?.idempotency_key;
    const idempotencyKey = normalizeIdempotencyKey(rawIdempotencyKey);
    if (rawIdempotencyKey && !idempotencyKey) return res.status(400).json({ ok: false, status: "invalid_idempotency_key" });
    const studentResult = await query(
      `SELECT s.id, s.full_name, s.student_serial, s.scan_serial, s.student_code, s.qr_token, s.group_id,
        s.phone, s.guardian_phone, s.is_active, s.deleted_at, g.name AS group_name,
        COALESCE(g.grade_level,g.grade) AS grade_level, g.fees_amount, g.is_active AS group_active,
        g.deleted_at AS group_deleted_at
       FROM students s LEFT JOIN groups g ON g.id=s.group_id
       WHERE LOWER(COALESCE(s.qr_token, '')) = ANY($1::text[])
        OR LOWER(COALESCE(s.scan_serial, '')) = ANY($1::text[])
        OR LOWER(COALESCE(s.student_serial, '')) = ANY($1::text[])
        OR LOWER(COALESCE(s.student_code, '')) = ANY($1::text[])
       ORDER BY s.deleted_at NULLS FIRST, s.is_active DESC LIMIT 1`,
      [lookupValues]
    );
    if (!studentResult.rowCount) { await auditLog({ action: "suspicious_scan", actorId: req.teacher.id, details: { reason: "student_not_found", scanned_value: token, ip: req.ip }, request: req }); return res.status(404).json({ok:false,status:"student_not_found"}); }
    const student=studentResult.rows[0];
    const publicStudent = {
      id: student.id,
      full_name: student.full_name,
      student_serial: student.student_serial,
      scan_serial: student.scan_serial,
      student_code: student.student_code,
      group_id: student.group_id,
      group_name: student.group_name,
      grade_level: student.grade_level,
      is_active: student.is_active,
      deleted_at: student.deleted_at
    };
    if (student.deleted_at) return res.status(409).json({ok:false,status:"deleted_student",student: publicStudent});
    if (!student.is_active || !student.group_active || student.group_deleted_at) return res.status(409).json({ok:false,status:"inactive_student",student: publicStudent});
    const rawSessionId = req.body?.session_id ?? req.body?.sessionId;
    const hasExplicitSessionId = rawSessionId !== undefined && rawSessionId !== null && String(rawSessionId).trim() !== "";
    let sessionResult;
    if (hasExplicitSessionId) {
      const requestedSessionId = Number(normalizeDigits(rawSessionId).trim());
      if (!Number.isSafeInteger(requestedSessionId) || requestedSessionId <= 0) return res.status(400).json({ ok: false, status: "invalid_session_id", student: publicStudent });
      const resolved = await resolveRequestedAttendanceSession({ sessionId: requestedSessionId, groupId: student.group_id, actorId: req.teacher.id, request: req });
      if (resolved.status === "session_not_found") return res.status(409).json({ ok: false, error: "session_not_found", status: "session_not_found", message: "الحصة غير موجودة", student: publicStudent });
      if (resolved.status === "wrong_group") return res.status(409).json({ ok: false, error: "wrong_group", status: "wrong_group", message: "الطالب غير مسجل في هذه المجموعة", student: publicStudent });
      if (resolved.status !== "ok") return res.status(409).json({ ok: false, error: resolved.status, status: resolved.status, message: attendanceWindowMessage(resolved.status), student: publicStudent });
      sessionResult = { rows: [resolved.session], rowCount: 1 };
    } else {
      const timing = await getAttendanceTimingDefaults();
      await query(`INSERT INTO attendance_sessions (group_id, schedule_id, session_date, starts_at, opens_at, closes_at, ends_at, status)
      SELECT cs.group_id, cs.id, (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Cairo')::date,
        ${cairoSessionTimeSql("(CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Cairo')", "cs.start_time")},
        ((((CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Cairo')::date + cs.start_time - ((CASE WHEN cs.opens_before_minutes = 3 THEN $2 ELSE cs.opens_before_minutes END) || ' minutes')::interval)) AT TIME ZONE 'Africa/Cairo'),
        ${cairoSessionCloseSql("(CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Cairo')", "$3")},
        ${cairoSessionEndTimeSql("(CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Cairo')")}, 'open'
      FROM class_schedules cs JOIN groups g ON g.id=cs.group_id AND g.is_active=TRUE AND g.deleted_at IS NULL
      WHERE cs.group_id=$1 AND cs.is_active=TRUE AND cs.day_of_week=EXTRACT(DOW FROM (CURRENT_TIMESTAMP AT TIME ZONE 'Africa/Cairo'))::INTEGER
      ON CONFLICT (group_id, schedule_id, session_date) DO NOTHING`, [student.group_id, timing.openBeforeMinutes, timing.closeAfterMinutes]);
      const resolved = await resolveImplicitAttendanceSession({ groupId: student.group_id, actorId: req.teacher.id, request: req });
      if (resolved.status !== "ok") return res.status(409).json({ ok: false, error: resolved.status, status: resolved.status, message: resolved.status === "closed_session" ? "لا توجد حصة مفتوحة لهذه المجموعة الآن" : attendanceWindowMessage(resolved.status), student: publicStudent });
      sessionResult = { rows: [resolved.session], rowCount: 1 };
    }
    // Run hardware-bounce suppression only after the student and session are
    // known to be valid, so real database/business errors are never swallowed.
    if (isRecentScannerDuplicate(req.teacher.id, token, idempotencyKey)) {
      return res.status(200).json({ ok: true, status: "ignored_hardware_bounce" });
    }
    const whatsappNotified = req.body?.send_whatsapp !== false && hasPermission(req.teacher, "whatsapp.send_attendance");
    const corrected = await correctSystemAbsence({ sessionId: sessionResult.rows[0].id, studentId: student.id, actorId: req.teacher.id, ip: req.ip, deviceId, idempotencyKey, whatsappNotified, request: req });
    if (corrected) {
      if (whatsappNotified) void enqueueAttendanceNotification({ attendanceRecordId: corrected.id, studentId: student.id })
        .catch((error) => console.error("Failed to queue WhatsApp attendance notification", error));
      return res.json({ ok: true, status: "attendance_recorded", student: publicStudent, record: corrected, corrected: true });
    }
    const saved=await recordAttendance({sessionId:sessionResult.rows[0].id,studentId:student.id,actorId:req.teacher.id,ip:req.ip,deviceId,idempotencyKey,whatsappNotified,request:req});
    if (saved.windowClosed) return res.status(409).json({ ok: false, error: "attendance_window_closed", status: "attendance_window_closed", message: "Attendance window closed.", student: publicStudent });
    if (saved.replay) return res.status(200).json({ ok: true, status: "attendance_recorded", student: publicStudent, record: saved.record, replayed: true });
    if (saved.duplicate) { await auditLog({ action: "suspicious_scan", actorId: req.teacher.id, studentId: student.id, sessionId: sessionResult.rows[0].id, details: { reason: saved.idempotencyConflict ? "idempotency_key_conflict" : "duplicate_student_scan", student_name: student.full_name, student_code: student.student_code }, request: req }); return res.status(409).json({ok:false,status:saved.idempotencyConflict ? "idempotency_conflict" : "duplicate_attendance",student: publicStudent,record:saved.record}); }
    res.json({ok:true,status:"attendance_recorded",student: publicStudent,record:saved.record});
  } catch (error) { next(error); }
});

operationsRouter.get("/fees/payments", requirePermission("payments.view"), requirePermission("payments.reports.view"), async (req, res, next) => {
  try {
    const term = normalizedSearch(req.query.search ?? req.query.student);
    const values = [];
    const filters = ["TRUE"];
    if (term) {
      values.push(`%${term}%`, crypto.createHash("sha256").update(String(req.query.search ?? req.query.student).trim()).digest("hex"));
      const fields = ["COALESCE(p.student_name_snapshot,s.full_name)", "COALESCE(p.student_serial_snapshot,s.student_serial)", "COALESCE(p.student_code_snapshot,s.student_code)", "s.phone", "s.guardian_phone", "COALESCE(p.group_name_snapshot,COALESCE(g.display_name,g.name))", "COALESCE(p.grade_level_snapshot,COALESCE(g.grade_level,g.grade))"];
      filters.push(`(${fields.map(searchableSql).join(" OR ")} OR s.national_id_hash = $2)` .replaceAll("$SEARCH", "$1"));
    }
    if (req.query.from) { values.push(String(req.query.from)); filters.push(`COALESCE(p.paid_at,p.payment_date) >= $${values.length}::date`); }
    if (req.query.to) { values.push(String(req.query.to)); filters.push(`COALESCE(p.paid_at,p.payment_date) < ($${values.length}::date + INTERVAL '1 day')`); }
    const result = await query(`SELECT p.*, COALESCE(p.student_name_snapshot,s.full_name) AS full_name,
      COALESCE(p.student_serial_snapshot,s.student_serial) AS student_serial,
      COALESCE(p.student_code_snapshot,s.student_code) AS student_code,
      s.phone, s.guardian_phone,
      COALESCE(p.grade_level_snapshot,COALESCE(g.grade_level,g.grade)) AS grade_level,
      COALESCE(p.group_name_snapshot,COALESCE(g.display_name,g.name)) AS group_name,
      u.name AS recorded_by_name
      FROM payments p LEFT JOIN students s ON s.id=p.student_id JOIN groups g ON g.id=p.group_id
      LEFT JOIN teachers u ON u.id=COALESCE(p.paid_by,p.recorded_by)
      WHERE ${filters.join(" AND ")} AND ${activePaymentFilter} ORDER BY COALESCE(p.paid_at,p.payment_date) DESC`, values);
    res.json({ ok: true, payments: result.rows, total_collected: result.rows.reduce((sum, row) => sum + Number(row.amount), 0) });
  } catch (error) { next(error); }
});

operationsRouter.get("/fees/overdue", requirePermission("payments.view"), requirePermission("payments.reports.view"), async (req, res, next) => {
  try {
    await ensureMonthlyFees();
    const term = normalizedSearch(req.query.search ?? req.query.student);
    const values = [];
    const filters = [req.query.include_deleted === "true" ? "TRUE" : "s.deleted_at IS NULL", "s.is_active=TRUE"];
    if (term) {
      values.push(term, crypto.createHash("sha256").update(String(req.query.search ?? req.query.student).trim()).digest("hex"));
      const fields = ["s.full_name", "s.student_serial", "s.student_code", "s.phone", "s.guardian_phone", "COALESCE(g.display_name,g.name)", "COALESCE(g.grade_level,g.grade)"];
      filters.push(`(${fields.map(searchableSql).join(" OR ")} OR s.national_id_hash = $2)`.replaceAll("$SEARCH", "$1"));
    }
    const result = await query(`SELECT s.id,s.full_name,s.student_serial,s.student_code,s.phone,s.guardian_phone,
      COALESCE(g.grade_level,g.grade) AS grade_level,COALESCE(g.display_name,g.name) AS group_name,g.fees_amount,
      COALESCE(SUM(fd.amount),0) AS required_amount,COALESCE(SUM(fd.paid_amount),0) AS paid_amount,
      COALESCE(SUM(fd.amount-fd.paid_amount),0) AS remaining_balance
      FROM students s JOIN groups g ON g.id=s.group_id LEFT JOIN fee_dues fd ON fd.student_id=s.id
      WHERE ${filters.join(" AND ")} GROUP BY s.id,g.id
      HAVING COALESCE(SUM(fd.amount-fd.paid_amount),0)>0 ORDER BY s.full_name`, values);
    res.json({ ok: true, students: result.rows, total_expected_unpaid: result.rows.reduce((sum, row) => sum + Number(row.remaining_balance), 0) });
  } catch (error) { next(error); }
});

operationsRouter.get("/fees/summary/:studentId", requirePermission("payments.view"), async (req,res,next)=>{ try { const summary = await getFeeSummary(req.params.studentId); if(!summary)return res.status(404).json({ok:false,status:"not_found"}); res.json({ok:true,summary: collectionSummary(summary)}); }catch(e){next(e);} });
operationsRouter.get("/fees/advance-options/:studentId", requirePermission("payments.view"), requirePermission("payments.advance"), async (req, res, next) => {
  try {
    const options = await getAdvanceOptions(Number(normalizeDigits(req.params.studentId)));
    if (!options) return res.status(404).json({ ok: false, status: "student_not_found" });
    res.json({ ok: true, ...options });
  } catch (error) { next(error); }
});
operationsRouter.post("/fees/advance-payments", paymentRateLimit, requirePermission("payments.view"), requirePermission("payments.advance"), async (req, res, next) => {
  try {
    const studentId = Number(normalizeDigits(req.body?.student_id));
    const paymentMethod = String(req.body?.payment_method || "cash").trim().toLowerCase();
    if (!Number.isSafeInteger(studentId) || studentId <= 0) return res.status(400).json({ ok: false, status: "invalid_student" });
    if (!paymentMethods.has(paymentMethod)) return res.status(400).json({ ok: false, status: "invalid_payment_method" });
    const rawIdempotencyKey = req.get("Idempotency-Key") || req.body?.idempotency_key;
    const idempotencyKey = normalizeIdempotencyKey(rawIdempotencyKey);
    if (rawIdempotencyKey && !idempotencyKey) return res.status(400).json({ ok: false, status: "invalid_idempotency_key" });
    const sendWhatsApp = req.body?.send_whatsapp === true;
    if (sendWhatsApp && !hasPermission(req.teacher, "whatsapp.send_receipts")) return res.status(403).json({ ok: false, status: "permission_required", permission: "whatsapp.send_receipts" });
    const result = await recordAdvancePayment({
      studentId,
      actorId: req.teacher.id,
      months: req.body?.months,
      whatsappNotified: sendWhatsApp,
      paymentMethod,
      notes: req.body?.notes || null,
      idempotencyKey,
      request: req
    });
    if (result.error === "idempotency_conflict") return res.status(409).json({ ok: false, status: result.error });
    if (result.error === "student_not_found") return res.status(404).json({ ok: false, status: result.error });
    if (result.error === "current_month_unpaid") return res.status(409).json({ ok: false, status: result.error, message: "The current month must be paid before making an advance payment. / يجب سداد الشهر الحالي أولاً قبل الدفع مقدماً." });
    if (result.error === "invalid_months") return res.status(400).json({ ok: false, status: result.error, message: "Invalid advance months. / أشهر الدفع المقدم غير صحيحة." });
    if (result.error === "month_already_paid") return res.status(409).json({ ok: false, status: result.error, month: result.month, message: "This month is already paid. / هذا الشهر مدفوع بالفعل." });
    res.status(result.replayed ? 200 : 201).json({ ok: true, payment: result.payment, months: result.months, whatsapp: result.whatsapp || null, replayed: Boolean(result.replayed) });
  } catch (error) {
    console.error("Failed to record advance payment", error);
    return res.status(500).json({ ok: false, status: "payment_failed" });
  }
});
operationsRouter.post("/fees/payments", paymentRateLimit, requirePermission("payments.view"), requirePermission("payments.collect"), async (req, res, next) => {
  try {
    const studentId = Number(normalizeDigits(req.body?.student_id));
    if (!Number.isSafeInteger(studentId) || studentId <= 0) return res.status(400).json({ ok: false, status: "invalid_student", message: "الطالب غير موجود. / Student was not found." });
    const paymentMethod = String(req.body?.payment_method || "cash").trim().toLowerCase();
    if (!paymentMethods.has(paymentMethod)) return res.status(400).json({ ok: false, status: "invalid_payment_method" });
    const rawIdempotencyKey = req.get("Idempotency-Key") || req.body?.idempotency_key;
    const idempotencyKey = normalizeIdempotencyKey(rawIdempotencyKey);
    if (rawIdempotencyKey && !idempotencyKey) return res.status(400).json({ ok: false, status: "invalid_idempotency_key" });
    const sendWhatsApp = req.body?.send_whatsapp === true;
    const isExempt = req.body?.is_exempt === true;
    const discountAmount = Number(normalizeDigits(req.body?.discount_amount ?? 0));
    if (!Number.isFinite(discountAmount) || discountAmount < 0) return res.status(400).json({ ok: false, status: "invalid_discount" });
    if (sendWhatsApp && !hasPermission(req.teacher, "whatsapp.send_receipts")) return res.status(403).json({ ok: false, status: "permission_required", permission: "whatsapp.send_receipts" });
    if (!idempotencyKey) {
      const summary = await getFeeSummary(studentId);
      if (!summary) return res.status(404).json({ ok: false, status: "not_found", message: "الطالب غير موجود. / Student was not found." });
      if (Number(summary.remaining_balance) <= 0) {
        const status = Number(summary.required_amount) > 0 ? "already_paid" : "no_outstanding_fees";
        const message = status === "already_paid" ? "تم سداد المصروفات بالفعل. / Fees already paid." : "لا توجد مصروفات مستحقة لهذا الطالب. / No outstanding fees for this student.";
        return res.status(409).json({ ok: false, status, message });
      }
    }
    const paymentResult = await recordFullPayment({ studentId, actorId: req.teacher.id, paymentMethod, notes: req.body?.notes || null, idempotencyKey, whatsappNotified: sendWhatsApp, discountAmount, isExempt, request: req });
    if (paymentResult?.error === "invalid_discount") return res.status(400).json({ ok: false, status: paymentResult.error });
    if (paymentResult?.idempotency_conflict) return res.status(409).json({ ok: false, status: "idempotency_conflict" });
    const payment = paymentResult?.payment;
    if (!payment) return res.status(409).json({ ok: false, status: "already_paid", message: "تم سداد المصروفات بالفعل. / Fees already paid." });
    const whatsapp = paymentResult.whatsapp || null;
    return res.status(paymentResult.replayed ? 200 : 201).json({ ok: true, payment, paid_amount: payment.paid_amount ?? payment.amount, discount_amount: payment.discount_amount ?? 0, is_exempt: payment.is_exempt === true, whatsapp, replayed: Boolean(paymentResult.replayed) });
  } catch (error) {
    console.error("Failed to record payment", error);
    return res.status(500).json({ ok: false, status: "payment_failed" });
  }
});
