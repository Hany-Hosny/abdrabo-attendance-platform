import express from "express";
import { requirePermission, requireTeacher } from "../middleware/requireTeacher.js";
import { auditLog } from "../services/audit.js";
import {
  disconnectWhatsApp,
  getWhatsAppQr,
  getWhatsAppSettings,
  getWhatsAppStatus,
  updateWhatsAppSettings
} from "../services/whatsapp.js";

export const whatsappRouter = express.Router();
whatsappRouter.use(requireTeacher);

whatsappRouter.get("/status", requirePermission("whatsapp.view"), (_req, res) => {
  res.json({ ok: true, ...getWhatsAppStatus() });
});

whatsappRouter.get("/qr", requirePermission("whatsapp.manage"), async (_req, res, next) => {
  try {
    res.json({ ok: true, ...await getWhatsAppQr() });
  } catch (error) { next(error); }
});

whatsappRouter.post("/disconnect", requirePermission("whatsapp.manage"), async (req, res, next) => {
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
