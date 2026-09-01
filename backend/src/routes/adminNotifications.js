import express from "express";
import { requireTeacher } from "../middleware/requireTeacher.js";
import { requireAnyPermission, hasPermission } from "../services/rbac.js";
import { listNotificationsForUser } from "../services/notifications.js";
import { query } from "../db/pool.js";
import { normalizeDigits } from "../utils/normalizeDigits.js";

export const adminNotificationsRouter = express.Router();
adminNotificationsRouter.use(requireTeacher, requireAnyPermission("dashboard.alerts.view", "messages.view"));

adminNotificationsRouter.get("/", async (req, res, next) => {
  try {
    const result = await listNotificationsForUser(req.teacher, { limit: req.query.limit });
    const notifications = result.notifications.map((notification) => {
      const canExposePayment = notification.type !== "payment_overdue" || hasPermission(req.teacher, "payments.reports.view");
      if (canExposePayment) return notification;
      return { ...notification, payload: { ...notification.payload, amount: null } };
    });
    return res.json({ ok: true, notifications, unreadCount: result.unreadCount });
  } catch (error) {
    return next(error);
  }
});

adminNotificationsRouter.patch("/:id/read", async (req, res, next) => {
  try {
    const notificationId = Number(normalizeDigits(req.params.id));
    if (!Number.isSafeInteger(notificationId) || notificationId <= 0) return res.status(400).json({ ok: false, status: "invalid_notification" });
    const result = await query(
      `UPDATE notifications SET is_read = TRUE, read_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND recipient_user_id = $2 AND resolved_at IS NULL RETURNING id`,
      [notificationId, req.teacher.id]
    );
    if (!result.rowCount) return res.status(404).json({ ok: false, status: "not_found" });
    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

adminNotificationsRouter.post("/read-all", async (req, res, next) => {
  try {
    const result = await query(
      `UPDATE notifications SET is_read = TRUE, read_at = NOW(), updated_at = NOW()
       WHERE recipient_user_id = $1 AND resolved_at IS NULL AND is_read = FALSE`,
      [req.teacher.id]
    );
    return res.json({ ok: true, markedCount: result.rowCount });
  } catch (error) {
    return next(error);
  }
});
