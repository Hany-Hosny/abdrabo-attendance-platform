import express from "express";
import { requirePermission, requireRoles, requireTeacher } from "../middleware/requireTeacher.js";
import { auditLog } from "../services/audit.js";
import { hasPermission } from "../services/rbac.js";
import {
  disconnectWhatsApp,
  getWhatsAppQr,
  getWhatsAppSettings,
  getWhatsAppStatus,
  enqueueGradeNotification,
  updateWhatsAppSettings
} from "../services/whatsapp.js";

export const whatsappRouter = express.Router();
whatsappRouter.use(requireTeacher);

const HISTORY_TYPES = new Set(["attendance", "grade", "receipt", "advance_payment"]);
const HISTORY_STATUSES = new Set(["pending", "processing", "sent", "failed", "skipped"]);

function maskPhoneNumber(value) {
  const phone = String(value || "");
  if (phone.length <= 4) return "****";
  return `${phone.slice(0, 3)}****${phone.slice(-2)}`;
}

function redactPortalTokens(value) {
  return String(value || "")
    .replace(/\/p\/[A-Za-z0-9_-]{20,64}/g, "/p/[secure-link]")
    .replace(/([?&]access_token=)[A-Za-z0-9._-]+/g, "$1[redacted]");
}

whatsappRouter.get("/status", requirePermission("whatsapp.view"), (_req, res) => {
  res.json({ ok: true, ...getWhatsAppStatus() });
});

whatsappRouter.get("/qr", requireRoles("owner", "admin"), requirePermission("whatsapp.manage"), async (_req, res, next) => {
  try {
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

whatsappRouter.get("/history", requirePermission("whatsapp.view"), async (req, res, next) => {
  try {
    const values = [];
    const filters = [];
    const addFilter = (sql, value) => {
      values.push(value);
      filters.push(sql.replace("?", `$${values.length}`));
    };
    const type = String(req.query.type || "").trim().toLowerCase();
    const status = String(req.query.status || "").trim().toLowerCase();
    const search = String(req.query.search || "").trim().slice(0, 80);
    const from = String(req.query.from || "").trim();
    const to = String(req.query.to || "").trim();
    if (HISTORY_TYPES.has(type)) addFilter("j.notification_type = ?", type);
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
    values.push(limit);
    const result = await query(
      `SELECT j.id, j.notification_type, j.phone_number, j.status, j.attempts, j.ref_code,
          j.template_index, j.template_text, j.rendered_message, j.last_error,
          j.created_at, j.sent_at, s.full_name AS student_name, s.student_code
       FROM whatsapp_notification_jobs j
       LEFT JOIN students s ON s.id = j.student_id
       WHERE ${filters.length ? filters.join(" AND ") : "TRUE"}
       ORDER BY j.created_at DESC, j.id DESC
       LIMIT $${values.length}`,
      values
    );
    res.json({
      ok: true,
      messages: result.rows.map((row) => ({
        ...row,
        phone_number: maskPhoneNumber(row.phone_number),
        template_text: row.template_text || "",
        rendered_message: redactPortalTokens(row.rendered_message)
      }))
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
    res.status(202).json({ ok: true, ...result });
  } catch (error) { next(error); }
});
