import express from "express";
import { requirePermission, requireTeacher } from "../middleware/requireTeacher.js";
import { hasPermission } from "../services/rbac.js";
import { getExecutiveDashboard } from "../services/dashboard.js";
import { listStudentsNeedingAttention } from "../services/studentAttention.js";
import { normalizeDigits } from "../utils/normalizeDigits.js";

export const adminDashboardRouter = express.Router();
adminDashboardRouter.use(requireTeacher);
adminDashboardRouter.use(requirePermission("dashboard.view"));

adminDashboardRouter.get("/summary", async (req, res, next) => {
  try {
    const groupIdValue = normalizeDigits(req.query.group_id || "").trim();
    if (groupIdValue && (!/^\d+$/.test(groupIdValue) || Number(groupIdValue) <= 0)) {
      return res.status(400).json({ ok: false, status: "invalid_group" });
    }
    const groupId = groupIdValue ? Number(groupIdValue) : null;
    const data = await getExecutiveDashboard({
      period: String(req.query.period || "current"),
      from: normalizeDigits(req.query.from || "").trim(),
      to: normalizeDigits(req.query.to || "").trim(),
      groupId
    }, {
      financial: hasPermission(req.teacher, "dashboard.financial.view"),
      groupPerformance: hasPermission(req.teacher, "dashboard.group_performance.view"),
      alerts: hasPermission(req.teacher, "dashboard.alerts.view"),
      activity: hasPermission(req.teacher, "dashboard.activity.view")
    });
    return res.json(data);
  } catch (error) {
    return next(error);
  }
});

adminDashboardRouter.get("/attention", requirePermission("dashboard.alerts.view"), async (req, res, next) => {
  try {
    const groupIdValue = normalizeDigits(req.query.group_id || "").trim();
    if (groupIdValue && (!/^\d+$/.test(groupIdValue) || Number(groupIdValue) <= 0)) {
      return res.status(400).json({ ok: false, status: "invalid_group" });
    }
    const result = await listStudentsNeedingAttention({
      groupId: groupIdValue ? Number(groupIdValue) : null,
      includePayment: hasPermission(req.teacher, "payments.reports.view")
    });
    return res.json({ ok: true, thresholds: result.thresholds, students: result.students });
  } catch (error) {
    return next(error);
  }
});
