import express from "express";
import { requirePermission, requireTeacher } from "../middleware/requireTeacher.js";
import { readRequiredPaymentIdempotencyKey } from "../utils/paymentIdempotency.js";
import {
  createOrReuseExternalConversation,
  getExternalConversation,
  getExternalMessages,
  getExternalPrefill,
  getExternalUnreadCount,
  listExternalConversations,
  markExternalConversationRead,
  normalizeExternalPhone,
  sendExternalMessage,
  deleteExternalMessages,
  deleteExternalConversation,
  deleteAllExternalConversations
} from "../services/externalMessaging.js";

export const externalMessagingRouter = express.Router();
externalMessagingRouter.use(requireTeacher, requirePermission("messages.view"));

externalMessagingRouter.get("/prefill", async (req, res, next) => {
  try {
    const prefill = await getExternalPrefill(req.query.inquiryId);
    if (!prefill) return res.status(404).json({ ok: false, status: "inquiry_not_found" });
    res.json({ ok: true, prefill });
  } catch (error) { next(error); }
});

externalMessagingRouter.get("/unread-count", async (_req, res, next) => {
  try { res.json({ ok: true, count: await getExternalUnreadCount() }); } catch (error) { next(error); }
});

externalMessagingRouter.get("/", async (req, res, next) => {
  try {
    res.json({ ok: true, conversations: await listExternalConversations({ search: req.query.search, read: req.query.read, date: req.query.date }) });
  } catch (error) { next(error); }
});

externalMessagingRouter.delete("/", requirePermission("messages.manage"), async (req, res, next) => {
  try {
    const result = await deleteAllExternalConversations({ actorId: req.teacher.id, request: req });
    res.json({ ok: true, deleted_conversations: result.conversationCount, deleted_messages: result.messageCount });
  } catch (error) { next(error); }
});

externalMessagingRouter.post("/conversations", requirePermission("whatsapp.send_external"), async (req, res, next) => {
  try {
    const inquiryId = req.body?.inquiryId == null ? null : Number(req.body.inquiryId);
    let phone = req.body?.phone;
    let displayName = req.body?.display_name;
    let source = req.body?.source;
    let sourceType = req.body?.source_type;
    if (inquiryId) {
      const prefill = await getExternalPrefill(inquiryId);
      if (!prefill?.phone) return res.status(422).json({ ok: false, status: "inquiry_invalid_phone" });
      phone = prefill.phone;
      displayName = prefill.display_name;
      source = prefill.source;
      sourceType = "website_inquiry";
    }
    if (!normalizeExternalPhone(phone)) return res.status(400).json({ ok: false, status: "external_invalid_phone" });
    const conversation = await createOrReuseExternalConversation({ phone, displayName, inquiryId, source, sourceType, actorId: req.teacher.id, request: req });
    res.status(201).json({ ok: true, conversation });
  } catch (error) {
    if (["external_invalid_phone"].includes(error?.message)) return res.status(400).json({ ok: false, status: error.message });
    next(error);
  }
});

externalMessagingRouter.get("/:id", async (req, res, next) => {
  try {
    const conversation = await getExternalConversation(req.params.id);
    if (!conversation) return res.status(404).json({ ok: false, status: "not_found" });
    const markedCount = await markExternalConversationRead(req.params.id, req.teacher.id, req);
    res.json({ ok: true, conversation: { ...conversation, unread_count: Math.max(0, conversation.unread_count - markedCount), read_status: "read" }, messages: await getExternalMessages(req.params.id), marked_count: markedCount });
  } catch (error) { next(error); }
});

externalMessagingRouter.put("/:id/read", async (req, res, next) => {
  try { res.json({ ok: true, marked_count: await markExternalConversationRead(req.params.id, req.teacher.id, req) }); } catch (error) { next(error); }
});

externalMessagingRouter.delete("/:id/messages", requirePermission("messages.manage"), async (req, res, next) => {
  try {
    const messageIds = Array.isArray(req.body?.message_ids) ? req.body.message_ids : [];
    if (!messageIds.length) return res.status(400).json({ ok: false, status: "invalid_message_ids" });
    res.json({ ok: true, deleted_message_count: await deleteExternalMessages(req.params.id, messageIds, req.teacher.id, req) });
  } catch (error) { next(error); }
});

externalMessagingRouter.delete("/:id", requirePermission("messages.manage"), async (req, res, next) => {
  try {
    const result = await deleteExternalConversation(req.params.id, req.teacher.id, req);
    if (!result.deleted) return res.status(404).json({ ok: false, status: "not_found" });
    res.json({ ok: true, deleted: true, deleted_message_count: result.messageCount });
  } catch (error) { next(error); }
});

externalMessagingRouter.post("/:id/messages", requirePermission("whatsapp.send_external"), async (req, res, next) => {
  try {
    const idempotency = readRequiredPaymentIdempotencyKey(req, { allowBody: false });
    if (idempotency.error) return res.status(400).json({ ok: false, status: idempotency.error });
    const result = await sendExternalMessage({ conversationId: req.params.id, body: req.body?.body, actorId: req.teacher.id, idempotencyKey: idempotency.idempotencyKey, inquiryId: req.body?.inquiryId, request: req });
    res.status(result.duplicate ? 200 : 202).json({ ok: true, duplicate: result.duplicate, message: result.message });
  } catch (error) {
    const statuses = { external_conversation_not_found: 404, external_message_empty: 400, external_message_too_long: 400, invalid_idempotency_key: 400 };
    if (statuses[error?.message]) return res.status(statuses[error.message]).json({ ok: false, status: error.message });
    next(error);
  }
});
