import { pool, query } from "../db/pool.js";
import { auditLog } from "./audit.js";
import { normalizeEgyptianPhone } from "../utils/normalizePhone.js";

export const EXTERNAL_MESSAGE_MAX_LENGTH = 2000;

function clean(value) {
  return String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
}

function preview(value) {
  return clean(value).slice(0, 240);
}

function safeId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function normalizeExternalPhone(value) {
  return normalizeEgyptianPhone(value);
}

export function isIgnoredExternalJid(value) {
  const jid = String(value || "");
  return !jid || jid.endsWith("@broadcast") || jid.endsWith("@g.us") || jid.endsWith("@newsletter");
}

export async function resolveExternalSenderJid(remoteJid, lidMapping) {
  const jid = String(remoteJid || "");
  if (!jid) return null;
  if (!jid.endsWith("@lid") && !jid.endsWith("@hosted.lid")) return jid;
  const resolved = await lidMapping?.getPNForLID?.(jid);
  return resolved ? String(resolved) : null;
}

export function extractExternalMessageText(message) {
  return message?.message?.conversation
    || message?.message?.extendedTextMessage?.text
    || message?.message?.imageMessage?.caption
    || message?.message?.videoMessage?.caption
    || "";
}

function conversationDto(row) {
  if (!row) return null;
  const unread = Number(row.unread_count || 0);
  return {
    id: Number(row.id),
    conversation_type: "external",
    source_type: "external",
    external_contact_id: Number(row.external_contact_id),
    display_name: row.display_name || null,
    canonical_phone: row.canonical_phone,
    display_phone: row.display_phone || row.canonical_phone,
    status: row.status,
    inquiry_id: row.last_inquiry_id ? Number(row.last_inquiry_id) : null,
    inquiry_source: row.last_inquiry_id ? "website_inquiry" : null,
    last_message: row.last_message_preview || null,
    last_message_at: row.last_message_at || row.updated_at || row.created_at,
    updated_at: row.updated_at,
    created_at: row.created_at,
    unread_count: unread,
    read_status: unread > 0 ? "unread" : "read",
    reply_allowed: true
  };
}

const conversationSelect = `
  SELECT ecv.id, ecv.external_contact_id, ecv.status, ecv.last_inquiry_id,
    ecv.last_message_at, ecv.last_message_preview, ecv.created_at, ecv.updated_at,
    ec.canonical_phone, ec.display_phone, ec.display_name,
    (SELECT COUNT(*)::int FROM external_messages em
      WHERE em.external_conversation_id = ecv.id AND em.direction = 'inbound'
        AND em.is_read = FALSE AND em.delivery_status <> 'review_required') AS unread_count
  FROM external_conversations ecv
  JOIN external_contacts ec ON ec.id = ecv.external_contact_id`;

export async function getExternalConversation(conversationId, db = query) {
  const id = safeId(conversationId);
  if (!id) return null;
  const result = await db(`${conversationSelect} WHERE ecv.id = $1`, [id]);
  return conversationDto(result.rows[0]);
}

export async function listExternalConversations({ search = "", read = "", date = "" } = {}, db = query) {
  const values = [];
  const filters = ["ecv.status = 'open'"];
  const term = clean(search).slice(0, 80);
  if (term) {
    values.push(`%${term}%`);
    filters.push(`(ec.display_name ILIKE $${values.length} OR ec.display_phone ILIKE $${values.length} OR ec.canonical_phone ILIKE $${values.length})`);
  }
  if (read === "unread") filters.push("EXISTS (SELECT 1 FROM external_messages eu WHERE eu.external_conversation_id = ecv.id AND eu.direction = 'inbound' AND eu.is_read = FALSE AND eu.delivery_status <> 'review_required')");
  if (read === "read") filters.push("NOT EXISTS (SELECT 1 FROM external_messages er WHERE er.external_conversation_id = ecv.id AND er.direction = 'inbound' AND er.is_read = FALSE AND er.delivery_status <> 'review_required')");
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    values.push(String(date));
    filters.push(`ecv.created_at >= $${values.length}::date AND ecv.created_at < ($${values.length}::date + INTERVAL '1 day')`);
  }
  const result = await db(`${conversationSelect} WHERE ${filters.join(" AND ")} ORDER BY COALESCE(ecv.last_message_at, ecv.updated_at) DESC, ecv.id DESC`, values);
  return result.rows.map(conversationDto);
}

export async function getExternalMessages(conversationId, db = query) {
  const id = safeId(conversationId);
  if (!id) return [];
  const result = await db(`SELECT id, external_conversation_id, direction, body, is_read, delivery_status,
      provider_message_id, whatsapp_job_id, created_by_teacher_id, created_at, updated_at
    FROM external_messages WHERE external_conversation_id = $1 ORDER BY created_at, id`, [id]);
  return result.rows;
}

export async function deleteExternalMessages(conversationId, messageIds, actorId = null, request = null) {
  const conversation = safeId(conversationId);
  const ids = [...new Set((Array.isArray(messageIds) ? messageIds : []).map(safeId).filter(Boolean))].slice(0, 100);
  if (!conversation || !ids.length) return 0;
  const result = await query(`DELETE FROM external_messages
    WHERE external_conversation_id = $1 AND id = ANY($2::bigint[])
    RETURNING id`, [conversation, ids]);
  if (result.rowCount) await auditLog({ action: "external_message_deleted", actorId, details: { conversation_id: conversation, message_count: result.rowCount }, request });
  return result.rowCount;
}

export async function deleteExternalConversation(conversationId, actorId = null, request = null) {
  const conversation = safeId(conversationId);
  if (!conversation) return { deleted: false, messageCount: 0 };
  const client = await pool.connect();
  let messageCount = 0;
  let deleted = false;
  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT id FROM external_conversations WHERE id = $1 FOR UPDATE", [conversation]);
    if (existing.rowCount) {
      const count = await client.query("SELECT COUNT(*)::int AS count FROM external_messages WHERE external_conversation_id = $1", [conversation]);
      messageCount = Number(count.rows[0]?.count || 0);
      const result = await client.query("DELETE FROM external_conversations WHERE id = $1 RETURNING id", [conversation]);
      deleted = result.rowCount > 0;
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  if (deleted) await auditLog({ action: "external_conversation_deleted", actorId, details: { conversation_id: conversation, message_count: messageCount }, request });
  return { deleted, messageCount };
}

export async function deleteAllExternalConversations({ actorId = null, request = null, dbPool = pool, audit = auditLog } = {}) {
  const client = await dbPool.connect();
  let conversationCount = 0;
  let messageCount = 0;
  try {
    await client.query("BEGIN");
    const counts = await client.query(`SELECT
      (SELECT COUNT(*)::int FROM external_conversations) AS conversations,
      (SELECT COUNT(*)::int FROM external_messages) AS messages`);
    conversationCount = Number(counts.rows[0]?.conversations || 0);
    messageCount = Number(counts.rows[0]?.messages || 0);
    await client.query("DELETE FROM external_messages");
    await client.query("DELETE FROM external_conversations");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  await audit({ action: "external_all_conversations_deleted", actorId, details: { deleted_conversation_count: conversationCount, deleted_message_count: messageCount }, request });
  return { conversationCount, messageCount };
}

async function getOrCreateContact(client, { phone, displayName = null, displayPhone = null, source = null }) {
  const canonicalPhone = normalizeExternalPhone(phone);
  if (!canonicalPhone) throw new Error("external_invalid_phone");
  const existing = await client.query("SELECT * FROM external_contacts WHERE canonical_phone = $1 FOR UPDATE", [canonicalPhone]);
  if (existing.rowCount) {
    const result = await client.query(`UPDATE external_contacts SET
        display_phone = COALESCE(display_phone, $2), display_name = COALESCE(NULLIF(display_name, ''), $3),
        source = COALESCE(source, $4), updated_at = NOW() WHERE id = $1 RETURNING *`,
      [existing.rows[0].id, displayPhone || clean(phone) || canonicalPhone, clean(displayName) || null, clean(source) || null]);
    return { ...result.rows[0], created: false };
  }
  const result = await client.query(`INSERT INTO external_contacts (canonical_phone, display_phone, display_name, source)
    VALUES ($1, $2, $3, $4) RETURNING *`, [canonicalPhone, displayPhone || clean(phone) || canonicalPhone, clean(displayName) || null, clean(source) || null]);
  return { ...result.rows[0], created: true };
}

async function getOrCreateConversation(client, { contactId, inquiryId = null, sourceType = null }) {
  const existing = await client.query(`${conversationSelect} WHERE ecv.external_contact_id = $1 AND ecv.status = 'open' FOR UPDATE`, [contactId]);
  if (existing.rowCount) {
    const current = existing.rows[0];
    if (inquiryId) await client.query(`UPDATE external_conversations SET last_inquiry_id = $2, source_type = COALESCE(source_type, $3), updated_at = NOW() WHERE id = $1`, [current.id, inquiryId, sourceType || "website_inquiry"]);
    return { id: Number(current.id), created: false };
  }
  const inserted = await client.query(`INSERT INTO external_conversations (external_contact_id, source_type, last_inquiry_id)
    VALUES ($1, $2, $3) RETURNING id`, [contactId, sourceType || null, inquiryId || null]);
  return { id: Number(inserted.rows[0].id), created: true };
}

export async function createOrReuseExternalConversation({ phone, displayName = null, inquiryId = null, source = null, sourceType = null, actorId = null, request = null }) {
  const canonicalPhone = normalizeExternalPhone(phone);
  if (!canonicalPhone) throw new Error("external_invalid_phone");
  const inquiry = safeId(inquiryId);
  const client = await pool.connect();
  let contact;
  let conversation;
  try {
    await client.query("BEGIN");
    contact = await getOrCreateContact(client, { phone: canonicalPhone, displayName, displayPhone: phone, source });
    conversation = await getOrCreateConversation(client, { contactId: contact.id, inquiryId: inquiry, sourceType });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  if (contact.created) await auditLog({ action: "external_contact_created", actorId, details: { external_contact_id: contact.id }, request });
  if (conversation.created) await auditLog({ action: "external_conversation_created", actorId, details: { conversation_id: conversation.id, external_contact_id: contact.id }, request });
  if (inquiry) await auditLog({ action: "external_inquiry_attached", actorId, details: { conversation_id: conversation.id, inquiry_id: inquiry }, request });
  return getExternalConversation(conversation.id);
}

export async function getExternalPrefill(inquiryId, db = query) {
  const id = safeId(inquiryId);
  if (!id) return null;
  const result = await db(`SELECT it.id, it.public_name, it.public_phone, it.subject, it.created_at,
      (SELECT body FROM inbox_messages im WHERE im.thread_id = it.id AND im.sender_type = 'public' AND im.deleted_at IS NULL ORDER BY im.created_at LIMIT 1) AS inquiry_body
    FROM inbox_threads it
    WHERE it.id = $1 AND it.student_id IS NULL`, [id]);
  const row = result.rows[0];
  if (!row) return null;
  const canonicalPhone = normalizeExternalPhone(row.public_phone);
  if (!canonicalPhone) return { inquiry_id: id, phone: null, display_phone: row.public_phone, display_name: row.public_name || null, inquiry_brief: row.inquiry_body || null, source: "website_inquiry", external_contact_id: null, external_conversation_id: null };
  const linked = await db(`SELECT ec.id AS external_contact_id, ecv.id AS external_conversation_id
    FROM external_contacts ec LEFT JOIN external_conversations ecv ON ecv.external_contact_id = ec.id AND ecv.status = 'open'
    WHERE ec.canonical_phone = $1`, [canonicalPhone]);
  return { inquiry_id: id, phone: canonicalPhone, display_phone: row.public_phone || canonicalPhone, display_name: row.public_name || null, inquiry_brief: row.inquiry_body || null, source: "website_inquiry", inquiry_source_label: row.subject || "Public inquiry", inquiry_created_at: row.created_at, external_contact_id: linked.rows[0]?.external_contact_id ? Number(linked.rows[0].external_contact_id) : null, external_conversation_id: linked.rows[0]?.external_conversation_id ? Number(linked.rows[0].external_conversation_id) : null };
}

export async function sendExternalMessage({ conversationId, body, actorId, idempotencyKey, inquiryId = null, request = null }) {
  const id = safeId(conversationId);
  const text = clean(body);
  if (!id) throw new Error("external_conversation_not_found");
  if (!text) throw new Error("external_message_empty");
  if (text.length > EXTERNAL_MESSAGE_MAX_LENGTH) throw new Error("external_message_too_long");
  if (!/^[-A-Za-z0-9_:]{8,128}$/.test(String(idempotencyKey || ""))) throw new Error("invalid_idempotency_key");
  const client = await pool.connect();
  let message;
  let duplicate = false;
  try {
    await client.query("BEGIN");
    const existing = await client.query(`SELECT em.*, j.status AS job_status FROM external_messages em LEFT JOIN whatsapp_notification_jobs j ON j.id = em.whatsapp_job_id WHERE j.idempotency_key = $1`, [idempotencyKey]);
    if (existing.rowCount) {
      message = existing.rows[0]; duplicate = true;
      await client.query("COMMIT");
    } else {
      const conversation = await client.query(`SELECT ecv.id, ec.canonical_phone FROM external_conversations ecv JOIN external_contacts ec ON ec.id = ecv.external_contact_id WHERE ecv.id = $1 AND ecv.status = 'open' FOR UPDATE`, [id]);
      if (!conversation.rowCount) throw new Error("external_conversation_not_found");
      const inserted = await client.query(`INSERT INTO external_messages (external_conversation_id, direction, body, is_read, delivery_status, created_by_teacher_id)
        VALUES ($1, 'outbound', $2, TRUE, 'pending', $3) RETURNING *`, [id, text, actorId]);
      const row = inserted.rows[0];
      const job = await client.query(`INSERT INTO whatsapp_notification_jobs
        (notification_type, source_id, external_message_id, created_by_teacher_id, idempotency_key, phone_number, payload, ref_code, rendered_message, status)
        VALUES ('external_message', $1, $2, $3, $4, $5, $6::jsonb, $7, $8, 'pending')
        RETURNING id, status`, [row.id, row.id, actorId, idempotencyKey, conversation.rows[0].canonical_phone, JSON.stringify({ type: "external_message", message: text }), `EXT-${Date.now()}-${row.id}`, text]);
      await client.query("UPDATE external_messages SET whatsapp_job_id = $2, updated_at = NOW() WHERE id = $1", [row.id, job.rows[0].id]);
      await client.query("UPDATE external_conversations SET last_message_at = NOW(), last_message_preview = $2, updated_at = NOW() WHERE id = $1", [id, preview(text)]);
      message = { ...row, whatsapp_job_id: job.rows[0].id, delivery_status: "pending" };
      await client.query("COMMIT");
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  if (duplicate) return { message, duplicate: true };
  await auditLog({ action: "external_message_queued", actorId, details: { external_message_id: message.id, conversation_id: id, job_id: message.whatsapp_job_id, inquiry_id: safeId(inquiryId) }, request });
  const { wakeWhatsAppWorker } = await import("./whatsapp.js");
  wakeWhatsAppWorker();
  return { message, duplicate: false };
}

export async function markExternalConversationRead(conversationId, actorId = null, request = null) {
  const id = safeId(conversationId);
  if (!id) return 0;
  const result = await query(`UPDATE external_messages SET is_read = TRUE, updated_at = NOW()
    WHERE external_conversation_id = $1 AND direction = 'inbound' AND is_read = FALSE RETURNING id`, [id]);
  if (result.rowCount) await auditLog({ action: "external_conversation_read", actorId, details: { conversation_id: id, marked_count: result.rowCount }, request });
  return result.rowCount;
}

export async function getExternalUnreadCount(db = query) {
  const result = await db(`SELECT COUNT(*)::int AS count FROM external_messages em
    JOIN external_conversations ecv ON ecv.id = em.external_conversation_id
    WHERE ecv.status = 'open' AND em.direction = 'inbound' AND em.is_read = FALSE AND em.delivery_status <> 'review_required'`);
  return Number(result.rows[0]?.count || 0);
}

export async function handleInboundExternalMessage({ phone, body, providerMessageId, fromMe = false, dbPool = pool, audit = auditLog }) {
  if (fromMe || !clean(body) || !providerMessageId) return { handled: false, reason: "ignored" };
  const canonicalPhone = normalizeExternalPhone(phone);
  if (!canonicalPhone) return { handled: false, reason: "invalid_phone" };
  const client = await dbPool.connect();
  try {
    await client.query("BEGIN");
    const duplicate = await client.query("SELECT id FROM external_messages WHERE provider_message_id = $1", [providerMessageId]);
    if (duplicate.rowCount) { await client.query("COMMIT"); return { handled: true, duplicate: true, message_id: Number(duplicate.rows[0].id) }; }
    const conversation = await client.query(`SELECT ecv.id, ec.display_name FROM external_conversations ecv JOIN external_contacts ec ON ec.id = ecv.external_contact_id WHERE ec.canonical_phone = $1 AND ecv.status = 'open' FOR UPDATE`, [canonicalPhone]);
    if (!conversation.rowCount) { await client.query("COMMIT"); return { handled: false, reason: "unmatched" }; }
    const inserted = await client.query(`INSERT INTO external_messages (external_conversation_id, direction, body, is_read, delivery_status, provider_message_id)
      VALUES ($1, 'inbound', $2, FALSE, 'sent', $3) RETURNING id`, [conversation.rows[0].id, clean(body), providerMessageId]);
    await client.query(`UPDATE external_conversations SET last_message_at = NOW(), last_message_preview = $2, updated_at = NOW() WHERE id = $1`, [conversation.rows[0].id, preview(body)]);
    await client.query("COMMIT");
    await audit({ action: "external_inbound_received", details: { external_message_id: inserted.rows[0].id, conversation_id: conversation.rows[0].id } });
    return { handled: true, message_id: Number(inserted.rows[0].id), conversation_id: Number(conversation.rows[0].id) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (error?.code === "23505") return { handled: true, duplicate: true };
    throw error;
  } finally { client.release(); }
}
