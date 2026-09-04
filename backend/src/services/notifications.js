import crypto from "node:crypto";
import { query } from "../db/pool.js";
import { hasPermission } from "./rbac.js";
import { listStudentsNeedingAttention } from "./studentAttention.js";
import { sendPasswordRecoveryEmail } from "./email.js";
import { getPasswordRecoveryConfig } from "./passwordRecoveryConfig.js";

function cairoMonth() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit" }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}`;
}

function notificationPermissionScope(teacher) {
  return {
    attention: hasPermission(teacher, "dashboard.alerts.view"),
    payment: hasPermission(teacher, "payments.reports.view"),
    messages: hasPermission(teacher, "messages.view")
  };
}

function attentionNotification(reason, student, month) {
  const key = `${reason.type}_low:${student.studentId}:${month}:${reason.threshold ?? "due"}`;
  return {
    type: reason.type === "attendance" ? "attendance_low" : reason.type === "evaluation" ? "evaluation_low" : "payment_overdue",
    dedupeKey: key,
    entityType: "student",
    entityId: student.studentId,
    targetSection: reason.targetSection,
    payload: {
      studentName: student.studentName,
      studentCode: student.studentCode,
      groupName: student.groupName,
      value: reason.value ?? null,
      threshold: reason.threshold ?? null,
      amount: reason.amount ?? null
    }
  };
}

async function syncAttentionNotifications(recipientUserId, teacher, db = query) {
  const scope = notificationPermissionScope(teacher);
  if (!scope.attention) return [];
  const attention = await listStudentsNeedingAttention({ includePayment: scope.payment, limit: 50, db });
  const month = cairoMonth();
  const notifications = attention.students.flatMap((student) => student.reasons.map((reason) => attentionNotification(reason, student, month)));
  const activeKeys = notifications.map((notification) => notification.dedupeKey);
  await db(
    `UPDATE notifications SET resolved_at = NOW(), updated_at = NOW()
     WHERE recipient_user_id = $1 AND type IN ('attendance_low','evaluation_low','payment_overdue')
       AND resolved_at IS NULL ${activeKeys.length ? "AND NOT (dedupe_key = ANY($2::text[]))" : ""}`,
    activeKeys.length ? [recipientUserId, activeKeys] : [recipientUserId]
  );
  for (const notification of notifications) {
    await db(
      `INSERT INTO notifications (recipient_user_id, type, entity_type, entity_id, target_section, payload, dedupe_key, is_read, resolved_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,FALSE,NULL)
       ON CONFLICT (recipient_user_id, dedupe_key) DO UPDATE SET
         payload = EXCLUDED.payload,
         entity_type = EXCLUDED.entity_type,
         entity_id = EXCLUDED.entity_id,
         target_section = EXCLUDED.target_section,
         updated_at = NOW(),
         is_read = CASE WHEN notifications.resolved_at IS NOT NULL THEN FALSE ELSE notifications.is_read END,
         resolved_at = NULL`,
      [recipientUserId, notification.type, notification.entityType, notification.entityId, notification.targetSection, JSON.stringify(notification.payload), notification.dedupeKey]
    );
  }
  return notifications;
}

async function syncMessageNotifications(recipientUserId, teacher, db = query) {
  if (!hasPermission(teacher, "messages.view")) return [];
  const result = await db(`
    SELECT latest.id, latest.thread_id, it.student_id,
      COALESCE(s.full_name, it.public_name, 'Message') AS student_name,
      s.student_code, COALESCE(g.display_name, g.name) AS group_name
    FROM inbox_messages latest
    JOIN inbox_threads it ON it.id = latest.thread_id
    LEFT JOIN students s ON s.id = it.student_id
    LEFT JOIN groups g ON g.id = s.group_id
    WHERE latest.deleted_at IS NULL AND latest.is_read = FALSE
      AND latest.sender_type IN ('student','public')
      AND latest.id = (
        SELECT MAX(candidate.id) FROM inbox_messages candidate
        WHERE candidate.thread_id = latest.thread_id AND candidate.deleted_at IS NULL
          AND candidate.is_read = FALSE AND candidate.sender_type IN ('student','public')
      )
    ORDER BY latest.created_at DESC
    LIMIT 10
  `);
  const notifications = result.rows.map((row) => ({
    type: "new_message",
    dedupeKey: `message:${row.id}`,
    entityType: row.student_id ? "student" : "thread",
    entityId: Number(row.student_id || row.thread_id),
    targetSection: "messages",
    payload: { studentName: row.student_name, studentCode: row.student_code, groupName: row.group_name, threadId: Number(row.thread_id) }
  }));
  const activeKeys = notifications.map((notification) => notification.dedupeKey);
  await db(
    `UPDATE notifications SET resolved_at = NOW(), updated_at = NOW()
     WHERE recipient_user_id = $1 AND type = 'new_message' AND resolved_at IS NULL ${activeKeys.length ? "AND NOT (dedupe_key = ANY($2::text[]))" : ""}`,
    activeKeys.length ? [recipientUserId, activeKeys] : [recipientUserId]
  );
  for (const notification of notifications) {
    await db(
      `INSERT INTO notifications (recipient_user_id, type, entity_type, entity_id, target_section, payload, dedupe_key, is_read, resolved_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,FALSE,NULL)
       ON CONFLICT (recipient_user_id, dedupe_key) DO UPDATE SET
         payload = EXCLUDED.payload, updated_at = NOW(),
         is_read = CASE WHEN notifications.resolved_at IS NOT NULL THEN FALSE ELSE notifications.is_read END,
         resolved_at = NULL`,
      [recipientUserId, notification.type, notification.entityType, notification.entityId, notification.targetSection, JSON.stringify(notification.payload), notification.dedupeKey]
    );
  }
  return notifications;
}

export async function syncNotificationsForUser(teacher, db = query) {
  await syncAttentionNotifications(teacher.id, teacher, db);
  await syncMessageNotifications(teacher.id, teacher, db);
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function maskedPhone(value) {
  const phone = String(value || "");
  if (phone.length <= 4) return phone ? "****" : "not available";
  return `${phone.slice(0, 3)}****${phone.slice(-2)}`;
}

function whatsappDisconnectEmail({ reason, phoneNumber, occurredAt = new Date() } = {}) {
  const reasonLabel = reason === "logged_out" ? "The WhatsApp account was logged out." : "The WhatsApp connection was closed unexpectedly.";
  const arabicReason = reason === "logged_out" ? "تم تسجيل خروج حساب واتساب." : "تم فقد اتصال واتساب بشكل غير متوقع.";
  const timestamp = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Africa/Cairo"
  }).format(occurredAt);
  const safeReason = escapeHtml(reasonLabel);
  const safeArabicReason = escapeHtml(arabicReason);
  const safePhone = escapeHtml(maskedPhone(phoneNumber));
  const safeTimestamp = escapeHtml(timestamp);
  const appUrl = String(
    process.env.FRONTEND_URL ||
    process.env.PUBLIC_APP_URL ||
    (process.env.NODE_ENV === "production" ? "https://abdrabo.up.railway.app" : "http://localhost:3000")
  ).replace(/\/+$/, "");
  const settingsUrl = appUrl ? `${appUrl}/teacher/dashboard?tab=whatsapp` : "";
  const safeSettingsUrl = escapeHtml(settingsUrl);
  const actionHtml = settingsUrl
    ? `<p style="margin:24px 0 0;text-align:center;"><a href="${safeSettingsUrl}" style="display:inline-block;padding:12px 18px;border-radius:8px;background:#f59e0b;color:#111827;text-decoration:none;font-weight:700;">Open WhatsApp settings</a></p>`
    : "";
  return {
    subject: "WhatsApp connection alert - action required",
    text: [
      "WhatsApp connection alert",
      "",
      reasonLabel,
      `Time: ${timestamp}`,
      `Connected number: ${maskedPhone(phoneNumber)}`,
      "",
      "Automatic reconnection has been started. Please open WhatsApp settings and relink the account if the connection does not recover."
    ].join("\n"),
    html: `<!DOCTYPE html>
<html lang="en" dir="ltr">
  <body style="margin:0;padding:24px 12px;background:#f1f5f9;color:#0f172a;font-family:Arial,Helvetica,sans-serif;line-height:1.6;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">
        <tr><td style="padding:22px 26px;background:#0f172a;color:#ffffff;font-size:19px;font-weight:700;">WhatsApp connection alert</td></tr>
        <tr><td style="padding:28px 26px;">
          <p style="margin:0 0 10px;font-size:17px;font-weight:700;color:#b45309;">${safeReason}</p>
          <p style="margin:0 0 20px;color:#475569;">${safeArabicReason}</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e2e8f0;border-radius:10px;background:#f8fafc;">
            <tr><td style="padding:12px 14px;color:#475569;">Time</td><td style="padding:12px 14px;text-align:right;font-weight:700;">${safeTimestamp} (Cairo)</td></tr>
            <tr><td style="padding:12px 14px;color:#475569;">Connected number</td><td style="padding:12px 14px;text-align:right;font-weight:700;">${safePhone}</td></tr>
          </table>
          <p style="margin:20px 0 0;color:#475569;">Automatic reconnection has been started. If the connection does not recover, open WhatsApp settings and relink the account.</p>
          ${actionHtml}
        </td></tr>
      </table>
    </td></tr></table>
  </body>
</html>`
  };
}

async function sendWhatsAppDisconnectEmails(recipients, { reason, phoneNumber, db, sendEmail, getEmailConfig }) {
  const emailRecipients = recipients.filter((recipient) => validEmail(recipient.email));
  if (!emailRecipients.length || reason === "manual_disconnect") return { sent: 0, failed: 0, skipped: emailRecipients.length };

  let config;
  try {
    config = await getEmailConfig(db);
  } catch (error) {
    console.error("Failed to load WhatsApp disconnect email configuration", error);
    return { sent: 0, failed: emailRecipients.length, skipped: 0 };
  }
  if (!config?.providerConfigured) {
    console.warn("WhatsApp disconnect emails skipped because the email provider is not configured");
    return { sent: 0, failed: 0, skipped: emailRecipients.length };
  }

  const email = whatsappDisconnectEmail({ reason, phoneNumber });
  const results = await Promise.allSettled(emailRecipients.map((recipient) => sendEmail({
    provider: config.provider,
    to: recipient.email,
    fromEmail: config.fromEmail,
    senderName: config.senderName,
    smtpConfig: config.smtp,
    apiKey: config.apiKey,
    subject: email.subject,
    text: email.text,
    html: email.html
  })));
  return {
    sent: results.filter((result) => result.status === "fulfilled").length,
    failed: results.filter((result) => result.status === "rejected").length,
    skipped: 0
  };
}

export async function recordWhatsAppConnectionNotification({
  status = "disconnected",
  reason = "connection_closed",
  phoneNumber = null,
  db = query,
  sendEmail = sendPasswordRecoveryEmail,
  getEmailConfig = getPasswordRecoveryConfig
} = {}) {
  const recipients = await db(
    "SELECT id, role, permissions, email FROM teachers WHERE is_active = TRUE AND deleted_at IS NULL"
  );
  const dedupeKey = `whatsapp_connection:${crypto.randomUUID()}`;
  const payload = { status, reason, phoneNumber: phoneNumber || null };
  let recorded = 0;
  for (const recipient of recipients.rows || []) {
    if (!hasPermission(recipient, "whatsapp.view")) continue;
    await db(
      `INSERT INTO notifications (recipient_user_id, type, entity_type, entity_id, target_section, payload, dedupe_key, is_read, resolved_at)
       VALUES ($1, 'whatsapp_disconnected', 'whatsapp', NULL, 'whatsapp', $2::jsonb, $3, FALSE, NULL)
       ON CONFLICT (recipient_user_id, dedupe_key) DO NOTHING`,
      [recipient.id, JSON.stringify(payload), dedupeKey]
    );
    recorded += 1;
  }
  const emails = await sendWhatsAppDisconnectEmails(recipients.rows || [], { reason, phoneNumber, db, sendEmail, getEmailConfig });
  return { recorded, status, reason, ...emails };
}

export async function listNotificationsForUser(teacher, { limit = 10, db = query } = {}) {
  await syncNotificationsForUser(teacher, db);
  const safeLimit = Math.min(20, Math.max(1, Number(limit) || 10));
  const result = await db(
    `SELECT id, type, entity_type, entity_id, target_section, payload, is_read, created_at
     FROM notifications
     WHERE recipient_user_id = $1 AND resolved_at IS NULL
     ORDER BY created_at DESC LIMIT $2`,
    [teacher.id, safeLimit]
  );
  const unread = await db(
    `SELECT COUNT(*)::int AS count FROM notifications
     WHERE recipient_user_id = $1 AND resolved_at IS NULL AND is_read = FALSE`,
    [teacher.id]
  );
  return { notifications: result.rows, unreadCount: Number(unread.rows[0]?.count || 0) };
}
