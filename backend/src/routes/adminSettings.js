import express from "express";
import { requirePermission, requireTeacher } from "../middleware/requireTeacher.js";
import { readSystemSettings, SettingsValidationError, updateSystemSettings } from "../services/systemSettings.js";

export const adminSettingsRouter = express.Router();
adminSettingsRouter.use(requireTeacher, requirePermission("settings.manage"));

adminSettingsRouter.get("/", async (_req, res, next) => {
  try {
    const result = await readSystemSettings();
    return res.json({ ok: true, ...result });
  } catch (error) {
    return next(error);
  }
});

adminSettingsRouter.patch("/", async (req, res, next) => {
  try {
    const input = req.body?.settings;
    const result = await updateSystemSettings(input, { actorId: req.teacher.id, request: req });
    return res.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof SettingsValidationError) {
      return res.status(400).json({ ok: false, status: "invalid_settings", errors: error.errors });
    }
    return next(error);
  }
});
