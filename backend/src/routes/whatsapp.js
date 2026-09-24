import express from "express";
import { z } from "zod";
import { query } from "../db/pool.js";
import { requireAnyPermission, requirePermission, requireRoles, requireTeacher } from "../middleware/requireTeacher.js";
import { auditLog } from "../services/audit.js";
import { hasPermission } from "../services/rbac.js";
import { approveCancellationNoticeForSend } from "../services/attendanceCancellation.js";
import { isGroupScopeRestricted, normalizeGroupIds } from "../services/groupAccess.js";
import {
  disconnectWhatsApp,
  getWhatsAppQr,
  getWhatsAppSettings,
  getWhatsAppStatus,
  enqueueGradeBatchNotifications,
  enqueueGradeNotification,
  retryWhatsAppNotificationJob,
  updateWhatsAppSettings,
  updateAttendanceNotificationsEnabled,
  resolveWhatsAppTemplate,
  validateWhatsAppTemplate,
  enqueueCustomWhatsAppMessage,
  searchCustomMessageStudents
} from "../services/whatsapp.js";
import { readRequiredPaymentIdempotencyKey } from "../utils/paymentIdempotency.js";
import { WHATSAPP_TEMPLATE_AUDIENCES, WHATSAPP_TEMPLATE_CATEGORIES } from "../services/whatsappTemplateCatalog.js";

export const whatsappRouter = express.Router();
whatsappRouter.use(requireTeacher);

const HISTORY_TYPES = new Set(["attendance", "absence", "grade", "receipt", "advance_payment", "cancellation"]);
const HISTORY_STATUSES = new Set(["pending", "processing", "sent", "failed", "skipped", "delivery_unknown", "review_required"]);
const TEMPLATE_CATEGORIES = new Set(WHATSAPP_TEMPLATE_CATEGORIES);

const batchExamSchema = z.object({
  resultIds: z.array(z.coerce.number().int().positive()).min(1).max(500)
});

const customMessageSchema = z.object({ studentId: z.coerce.number().int().positive(), message: z.string().max(2000) });

function maskPhoneNumber(value) {
  const phone = String(value || "");
  if (!phone) return null;
  if (phone.length <= 4) return "****";
  return `${phone.slice(0, 3)}****${phone.slice(-2)}`;
}

function redactPortalTokens(value) {
  return String(value || "")
    .replace(/\/p\/[A-Za-z0-9_-]{20,64}/g, "/p/[secure-link]")
    .replace(/([?&]access_token=)[A-Za-z0-9._-]+/g, "$1[redacted]");
}

whatsappRouter.get("/status", requirePermission("whatsapp.view"), (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, ...getWhatsAppStatus() });
});

whatsappRouter.get("/qr", requireRoles("owner", "admin"), requirePermission("whatsapp.manage"), async (_req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json({ ok: true, ...await getWhatsAppQr() });
  } catch (error) { next(error); }
});

whatsappRouter.post("/disconnect", requireRoles("owner", "admin"), requirePermission("whatsapp.manage"), async (req, res, next) => {
  try {
    const status = await disconnectWhatsApp();
    await auditLog({ action: "whatsapp_disconnected", actorId: req.teacher.id, request: req });
    res.json({ ok: true, ...status });
  } catch (error) { next(error); }
});

whatsappRouter.get("/settings", requirePermission("whatsapp.view"), async (_req, res, next) => {
  try { res.json({ ok: true, settings: await getWhatsAppSettings() }); }
  catch (error) { next(error); }
});

whatsappRouter.put("/settings", requirePermission("whatsapp.manage"), async (req, res, next) => {
  try {
    if (req.body?.settings?.auto_send === true && !hasPermission(req.teacher, "whatsapp.send_attendance")) {
      const current = await getWhatsAppSettings();
      if (!current.auto_send) return res.status(403).json({ ok: false, status: "permission_required", permission: "whatsapp.send_attendance" });
    }
    const settings = await updateWhatsAppSettings(req.body?.settings, {
      actorId: req.teacher.id,
      request: req,
      audit: auditLog
    });
    res.json({ ok: true, settings });
  } catch (error) {
    if (String(error?.message || "").startsWith("invalid_")) return res.status(400).json({ ok: false, status: error.message });
    next(error);
  }
});

whatsappRouter.get("/attendance-notifications", requirePermission("whatsapp.send_attendance"), async (_req, res, next) => {
  try {
    const settings = await getWhatsAppSettings();
    res.json({ ok: true, enabled: settings.attendance_notifications_enabled });
  } catch (error) { next(error); }
});

whatsappRouter.put("/attendance-notifications", requirePermission("whatsapp.send_attendance"), async (req, res, next) => {
  try {
    const enabled = req.body?.enabled;
    if (typeof enabled !== "boolean") return res.status(400).json({ ok: false, status: "invalid_attendance_notifications_enabled" });
    const persisted = await updateAttendanceNotificationsEnabled(enabled, {
      actorId: req.teacher.id,
      request: req,
      audit: auditLog
    });
    res.json({ ok: true, enabled: persisted });
  } catch (error) { next(error); }
});

whatsappRouter.get("/custom-messages/students", requirePermission("whatsapp.send_custom"), async (req, res, next) => {
  try { res.json({ ok: true, students: await searchCustomMessageStudents(req.query.search) }); }
  catch (error) { next(error); }
});

whatsappRouter.post("/custom-messages", requirePermission("whatsapp.send_custom"), async (req, res, next) => {
  try {
    const parsed = customMessageSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, status: "invalid_custom_message" });
    const idempotency = readRequiredPaymentIdempotencyKey(req, { allowBody: false });
    if (idempotency.error) return res.status(400).json({ ok: false, status: idempotency.error });
    const job = await enqueueCustomWhatsAppMessage({ ...parsed.data, actorId: req.teacher.id, idempotencyKey: idempotency.idempotencyKey });
    await auditLog({ action: "whatsapp_custom_message_queued", actorId: req.teacher.id, studentId: job.student_id, request: req, details: { job_id: Number(job.id), notification_type: "custom_message", status: job.status } });
    res.status(job.duplicate ? 200 : 202).json({ ok: true, job: { id: job.id, status: job.status, duplicate: job.duplicate } });
  } catch (error) {
    const statusByError = { custom_message_empty: 400, custom_message_too_long: 400, custom_message_student_ineligible: 422, custom_message_opted_out: 422, custom_message_invalid_phone: 422 };
    if (statusByError[error?.message]) return res.status(statusByError[error.message]).json({ ok: false, status: error.message });
    next(error);
  }
});

whatsappRouter.get("/custom-messages/history", requirePermission("whatsapp.send_custom"), async (req, res, next) => {
  try {
    const values = [];
    const filters = ["j.notification_type = 'custom_message'"];
    const add = (sql, value) => { values.push(value); filters.push(sql.replace("?", `$${values.length}`)); };
    const search = String(req.query.search || "").trim().slice(0, 80);
    const status = String(req.query.status || "").trim();
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();
    if (search) { values.push(`%${search.toLowerCase()}%`); const parameter = `$${values.length}`; filters.push(`(LOWER(s.full_name) LIKE ${parameter} OR LOWER(s.student_code) LIKE ${parameter} OR LOWER(COALESCE(s.student_serial,'')) LIKE ${parameter})`); }
    if (["pending", "processing", "sent", "failed", "delivery_unknown", "skipped"].includes(status)) add("j.status = ?", status);
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) add("j.created_at >= ?::date", from);
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) add("j.created_at < (?::date + INTERVAL '1 day')", to);
    const result = await query(`SELECT j.id, j.status, j.attempts, j.last_error, j.created_at, j.sent_at, j.rendered_message,
        s.full_name AS student_name, s.student_code, s.student_serial,
        COALESCE(g.display_name, g.name) AS group_name, COALESCE(g.grade_level, g.grade) AS grade_level,
        t.name AS sent_by
      FROM whatsapp_notification_jobs j
      LEFT JOIN students s ON s.id = j.student_id
      LEFT JOIN groups g ON g.id = s.group_id
      LEFT JOIN teachers t ON t.id = j.created_by_teacher_id
      WHERE ${filters.join(" AND ")}
      ORDER BY j.created_at DESC, j.id DESC LIMIT 100`, values);
    res.json({ ok: true, messages: result.rows.map((row) => ({ ...row, last_error: row.last_error && /^[a-z0-9_:-]{1,80}$/i.test(row.last_error) ? row.last_error : row.last_error ? "delivery_failed" : null })) });
  } catch (error) { next(error); }
});

whatsappRouter.get("/templates", requirePermission("whatsapp.view"), async (req, res, next) => {
  try {
    const category = String(req.query.category || "").trim();
    const values = [];
    const where = category && TEMPLATE_CATEGORIES.has(category) ? (values.push(category), "WHERE category = $1") : "";
    if (category && !TEMPLATE_CATEGORIES.has(category)) return res.status(400).json({ ok: false, status: "invalid_template_category" });
    const result = await query(`SELECT id, category, audience, slot_number, slot_key, is_fallback, content_version, message_body, is_active, created_at, updated_at FROM whatsapp_templates ${where} ORDER BY category, is_fallback, audience, slot_number NULLS LAST, id`, values);
    res.json({ ok: true, templates: result.rows });
  } catch (error) { next(error); }
});

whatsappRouter.post("/templates/resolve", requirePermission("whatsapp.view"), async (req, res, next) => {
  try {
    const category = String(req.body?.category || "").trim();
    if (!TEMPLATE_CATEGORIES.has(category)) return res.status(400).json({ ok: false, status: "invalid_template_category" });
    const audience = WHATSAPP_TEMPLATE_AUDIENCES.includes(String(req.body?.audience || "")) ? String(req.body.audience) : "neutral";
    const slotNumber = req.body?.slot_number == null ? null : Number(req.body.slot_number);
    const resolved = await resolveWhatsAppTemplate({ category, audience, slotNumber, values: req.body?.values && typeof req.body.values === "object" ? req.body.values : {} });
    res.json({ ok: true, ...resolved });
  } catch (error) { next(error); }
});

whatsappRouter.post("/templates", requirePermission("whatsapp.manage"), async (req, res, next) => {
  try {
    const category = String(req.body?.category || "").trim();
    const messageBody = String(req.body?.message_body || "").trim();
    const audience = String(req.body?.audience || "neutral").trim().toLowerCase();
    const isFallback = req.body?.is_fallback === true;
    const slotNumber = req.body?.slot_number == null ? null : Number(req.body.slot_number);
    if (!TEMPLATE_CATEGORIES.has(category)) return res.status(400).json({ ok: false, status: "invalid_template_category" });
    if (!WHATSAPP_TEMPLATE_AUDIENCES.includes(audience)) return res.status(400).json({ ok: false, status: "invalid_template_audience" });
    if (audience === "neutral" ? (slotNumber !== null || !isFallback) : (isFallback || !Number.isInteger(slotNumber) || slotNumber < 1 || slotNumber > 4)) return res.status(400).json({ ok: false, status: "invalid_template_assignment" });
    if (messageBody.length < 5 || messageBody.length > 2000) return res.status(400).json({ ok: false, status: "invalid_template_length" });
    const validation = validateWhatsAppTemplate(category, messageBody);
    if (!validation.ok) {
      return res.status(400).json({
        ok: false,
        status: validation.unknownPlaceholder ? "unknown_placeholder" : validation.malformed ? "invalid_template_syntax" : validation.hasForbiddenLiteral ? "invalid_template_value" : "missing_required_placeholder",
        required_placeholder: validation.missingPlaceholders?.length ? `{${validation.missingPlaceholders[0]}}` : `{${validation.requiredPlaceholder}}`,
        unknown_placeholder: validation.unknownPlaceholder ? `{${validation.unknownPlaceholder}}` : undefined
      });
    }
    const slotKey = isFallback ? `${category}:neutral:fallback` : `${category}:${audience}:${slotNumber}`;
    const result = await query(`INSERT INTO whatsapp_templates (category, audience, slot_number, slot_key, is_fallback, message_body, is_active) VALUES ($1, $2, $3, $4, $5, $6, TRUE) RETURNING *`, [category, audience, slotNumber, slotKey, isFallback, messageBody]);
    await auditLog({ action: "whatsapp_template_created", actorId: req.teacher.id, request: req, details: { category, template_id: result.rows[0].id } });
    res.status(201).json({ ok: true, template: result.rows[0] });
  } catch (error) {
    if (error?.code === "23505") return res.status(409).json({ ok: false, status: "duplicate_template" });
    next(error);
  }
});

whatsappRouter.patch("/templates/:id", requirePermission("whatsapp.manage"), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const messageBody = req.body?.message_body == null ? null : String(req.body.message_body).trim();
    const isActive = req.body?.is_active == null ? null : req.body.is_active === true;
    const expectedVersion = req.body?.expected_content_version == null ? null : Number(req.body.expected_content_version);
    if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ ok: false, status: "invalid_template" });
    if (messageBody !== null && (messageBody.length < 5 || messageBody.length > 2000)) return res.status(400).json({ ok: false, status: "invalid_template_length" });
    const existing = await query("SELECT category, audience, slot_number, is_fallback, content_version FROM whatsapp_templates WHERE id = $1", [id]);
    if (!existing.rowCount) return res.status(404).json({ ok: false, status: "not_found" });
    if (messageBody !== null) {
      const validation = validateWhatsAppTemplate(existing.rows[0].category, messageBody);
      if (!validation.ok) {
        return res.status(400).json({
          ok: false,
          status: validation.unknownPlaceholder ? "unknown_placeholder" : validation.malformed ? "invalid_template_syntax" : validation.hasForbiddenLiteral ? "invalid_template_value" : "missing_required_placeholder",
          required_placeholder: validation.missingPlaceholders?.length ? `{${validation.missingPlaceholders[0]}}` : `{${validation.requiredPlaceholder}}`,
          unknown_placeholder: validation.unknownPlaceholder ? `{${validation.unknownPlaceholder}}` : undefined
        });
      }
    }
    if (expectedVersion !== null && (!Number.isInteger(expectedVersion) || expectedVersion < 1)) return res.status(400).json({ ok: false, status: "invalid_template_version" });
    const result = await query(`UPDATE whatsapp_templates
      SET message_body = COALESCE($2, message_body),
          is_active = COALESCE($3, is_active),
          content_version = CASE WHEN $2 IS NULL OR $2 = message_body THEN content_version ELSE content_version + 1 END,
          updated_at = NOW()
      WHERE id = $1 AND ($4::int IS NULL OR content_version = $4)
      RETURNING *`, [id, messageBody, isActive, expectedVersion]);
    if (!result.rowCount && expectedVersion !== null) return res.status(409).json({ ok: false, status: "template_version_conflict" });
    res.json({ ok: true, template: result.rows[0] });
  } catch (error) {
    if (error?.code === "23505") return res.status(409).json({ ok: false, status: "duplicate_template" });
    next(error);
  }
});

whatsappRouter.get("/history", requireAnyPermission("whatsapp.view", "attendance.cancel_sessions"), async (req, res, next) => {
  try {
    const values = [];
    const filters = [];
    const addFilter = (sql, value) => {
      values.push(value);
      filters.push(sql.replace("?", `$${values.length}`));
    };
    const canViewAllHistory = hasPermission(req.teacher, "whatsapp.view");
    const type = canViewAllHistory ? String(req.query.type || "").trim().toLowerCase() : "cancellation";
    const status = String(req.query.status || "").trim().toLowerCase();
    const search = String(req.query.search || "").trim().slice(0, 80);
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();
    if (HISTORY_TYPES.has(type)) addFilter("j.notification_type = ?", type);
    if (!canViewAllHistory && isGroupScopeRestricted(req.teacher)) {
      values.push(normalizeGroupIds(req.teacher?.group_ids));
      filters.push(`EXISTS (SELECT 1 FROM attendance_sessions access_session WHERE access_session.id = j.cancellation_session_id AND access_session.group_id = ANY($${values.length}::int[]))`);
    }
    if (HISTORY_STATUSES.has(status)) addFilter("j.status = ?", status);
    if (/^\d{4}-\d{2}-\d{2}$/.test(from)) addFilter("j.created_at >= ?::date", from);
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) addFilter("j.created_at < (?::date + INTERVAL '1 day')", to);
    if (search) {
      values.push(`%${search.toLowerCase()}%`);
      const parameter = `$${values.length}`;
      filters.push(`(LOWER(COALESCE(s.full_name, '')) LIKE ${parameter}
        OR LOWER(COALESCE(s.student_code, '')) LIKE ${parameter}
        OR LOWER(COALESCE(j.ref_code, '')) LIKE ${parameter})`);
    }
    const requestedLimit = Number(req.query.limit);
    const limit = Number.isSafeInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 25;
    const whereClause = filters.length ? filters.join(" AND ") : "TRUE";
    const countResult = await query(
      `SELECT COUNT(*)::int AS count
       FROM whatsapp_notification_jobs j
       LEFT JOIN students s ON s.id = j.student_id
       WHERE ${whereClause}`,
      values
    );
    values.push(limit);
    
    const result = await query(
      `SELECT j.id, j.notification_type, j.phone_number, j.status, j.attempts, j.ref_code,
          j.template_index, j.template_text, j.template_id, j.template_version,
          j.template_category, j.template_audience, j.template_slot_number,
          j.template_body_snapshot, j.template_gender, j.rendered_message, j.last_error,
          j.created_at, j.sent_at, j.next_attempt_at, j.lease_expires_at, s.full_name AS student_name, s.student_code
       FROM whatsapp_notification_jobs j
       LEFT JOIN students s ON s.id = j.student_id
       WHERE ${whereClause}
       ORDER BY j.created_at DESC, j.id DESC
       LIMIT $${values.length}`,
      values
    );
    res.json({
      ok: true,
      total: Number(countResult.rows[0]?.count || 0),
      messages: result.rows.map((row) => ({
        ...row,
        phone_number: maskPhoneNumber(row.phone_number),
        template_text: row.template_text || "",
        rendered_message: redactPortalTokens(row.rendered_message)
      }))
    });
  } catch (error) { next(error); }
});

whatsappRouter.get("/history/stats", requireAnyPermission("whatsapp.view", "attendance.cancel_sessions"), async (req, res, next) => {
  try {
    const canViewAllHistory = hasPermission(req.teacher, "whatsapp.view");
    const scoped = !canViewAllHistory;
    const values = scoped ? [normalizeGroupIds(req.teacher?.group_ids)] : [];
    const result = await query(
      `SELECT j.status, COUNT(*)::int AS count,
              COUNT(*) FILTER (WHERE j.status = 'skipped' AND j.last_error = 'auto_send_disabled')::int AS skipped_auto_send_disabled
       FROM whatsapp_notification_jobs j
       ${scoped ? "JOIN attendance_sessions s ON s.id = j.cancellation_session_id" : ""}
       WHERE ${scoped ? `j.notification_type = 'cancellation' AND s.group_id = ANY($1::int[])` : "TRUE"}
       GROUP BY j.status`, values
    );
    const counts = Object.fromEntries(result.rows.map((row) => [row.status, Number(row.count) || 0]));
    const total = result.rows.reduce((sum, row) => sum + (Number(row.count) || 0), 0);
    const skippedAutoSendDisabled = result.rows.reduce((sum, row) => sum + (Number(row.skipped_auto_send_disabled) || 0), 0);
    res.json({
      ok: true,
      stats: {
        total,
        sent: counts.sent || 0,
        failed: counts.failed || 0,
        pending: (counts.pending || 0) + (counts.processing || 0),
        delivery_unknown: counts.delivery_unknown || 0,
        skipped_auto_send_disabled: skippedAutoSendDisabled
      }
    });
  } catch (error) { next(error); }
});

whatsappRouter.post("/send-grade", requirePermission("whatsapp.send_grades"), async (req, res, next) => {
  try {
    const resultId = Number(req.body?.result_id);
    if (!Number.isSafeInteger(resultId) || resultId <= 0) return res.status(400).json({ ok: false, status: "invalid_result" });
    const result = await enqueueGradeNotification({ resultId });
    if (result.reason === "not_found") return res.status(404).json({ ok: false, status: result.reason });
    if (result.reason === "invalid_phone") return res.status(409).json({ ok: false, status: result.reason });
    if (result.reason === "queue_conflict") return res.status(503).json({ ok: false, status: result.reason });
    res.status(result.reason === "already_queued" ? 200 : 202).json({ ok: true, ...result });
  } catch (error) { next(error); }
});

whatsappRouter.post("/batch-exams", requirePermission("whatsapp.send_grades"), async (req, res, next) => {
  const parsed = batchExamSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ ok: false, status: "invalid_batch_result_ids", errors: [] });
  try {
    const result = await enqueueGradeBatchNotifications({ resultIds: parsed.data.resultIds });
    res.status(200).json({ ok: true, ...result });
  } catch (error) { next(error); }
});

whatsappRouter.post("/jobs/:id/cancellation-send", requirePermission("attendance.cancel_sessions"), async (req, res, next) => {
  try {
    const jobId = Number(req.params.id);
    if (!Number.isSafeInteger(jobId) || jobId <= 0) return res.status(400).json({ ok: false, status: "invalid_job_id" });
    const result = await approveCancellationNoticeForSend({ jobId, actor: req.teacher, request: req });
    if (!result.ok) {
      const status = result.reason === "not_found" ? 404 : result.reason === "group_access_forbidden" ? 403 : result.reason === "already_approved" ? 409 : 400;
      return res.status(status).json({ ok: false, status: result.reason });
    }
    res.json(result);
  } catch (error) { next(error); }
});

whatsappRouter.post("/jobs/:id/retry", requirePermission("whatsapp.manage"), async (req, res, next) => {
  try {
    const jobId = Number(req.params.id);
    if (!Number.isSafeInteger(jobId) || jobId <= 0) return res.status(400).json({ ok: false, status: "invalid_job" });
    const result = await retryWhatsAppNotificationJob({
      jobId,
      actorId: req.teacher.id,
      reason: req.body?.reason,
      allowDeliveryUnknown: req.body?.confirm_delivery_unknown === true,
      request: req
    });
    if (!result.ok && result.reason === "not_found") return res.status(404).json({ ok: false, status: result.reason });
    if (!result.ok && result.reason === "delivery_unknown_requires_confirmation") return res.status(409).json({ ok: false, status: result.reason });
    if (!result.ok && result.reason === "retry_reason_required") return res.status(400).json({ ok: false, status: result.reason });
    if (!result.ok && result.reason === "retry_reason_too_long") return res.status(400).json({ ok: false, status: result.reason });
    if (!result.ok && result.reason === "unsupported_whatsapp_notification_type") return res.status(409).json({ ok: false, status: result.reason });
    if (!result.ok && ["student_inactive", "whatsapp_opted_out", "invalid_phone", "attendance_excused", "attendance_no_longer_eligible", "absence_no_longer_eligible", "grade_no_longer_exists", "payment_no_longer_exists"].includes(result.reason)) {
      return res.status(409).json({ ok: false, status: result.reason });
    }
    res.status(result.retried ? 202 : 200).json({ ok: true, ...result });
  } catch (error) { next(error); }
});
