import { query } from "../db/pool.js";
import { hasPermission } from "./rbac.js";
import { getDashboardAlertThresholds } from "./systemSettings.js";
import { hasGroupAccess } from "./groupAccess.js";
import { NotificationType, AGGREGATED_NOTIFICATION_TYPES } from "./notificationTypes.js";
import { sendPasswordRecoveryEmail } from "./email.js";
import { getPasswordRecoveryConfig } from "./passwordRecoveryConfig.js";

const WHATSAPP_CONNECTION_ALERT_COOLDOWN_MINUTES = 30;

function notificationPermissionScope(teacher) {
  return {
    attention: hasPermission(teacher, "dashboard.alerts.view"),
    payment: hasPermission(teacher, "payments.reports.view"),
    messages: hasPermission(teacher, "messages.view")
  };
}

function safeCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0 ? count : 0;
}

function normalizedReferenceId(value) {
  const referenceId = String(value ?? "").trim();
  return referenceId || null;
}

export function formatAggregatedNotification({ type, groupName, studentCount, examName, billingPeriod, threshold }) {
  const count = safeCount(studentCount);
  const group = String(groupName || "Group").trim();
  const exam = String(examName || "exam").trim();
  const period = String(billingPeriod || "billing period").trim();
  const scoreThreshold = Number.isFinite(Number(threshold)) ? Number(threshold) : 0;
  const subject = count === 1 ? "student" : "students";
  const arabicSubject = count === 1 ? "طالب" : "طلاب";

  if (type === NotificationType.ATTENDANCE_ABSENCE) {
    return {
      title: "Attendance alert",
      message: `${count} ${subject} in ${group} missed today's session.`,
      titleAr: "تنبيه حضور",
      messageAr: `${count} ${arabicSubject} في ${group} تغيبوا عن حصة اليوم.`
    };
  }
  if (type === NotificationType.UNPAID_FEES) {
    return {
      title: "Unpaid fees alert",
      message: `${count} ${subject} in ${group} have unpaid fees for ${period}.`,
      titleAr: "تنبيه رسوم غير مدفوعة",
      messageAr: `${count} ${arabicSubject} في ${group} لديهم رسوم غير مدفوعة عن ${period}.`
    };
  }
  if (type === NotificationType.LOW_EXAM_GRADE) {
    return {
      title: "Low exam grade alert",
      message: `${count} ${subject} in ${group} scored below ${scoreThreshold}% in ${exam}.`,
      titleAr: "تنبيه درجات منخفضة",
      messageAr: `${count} ${arabicSubject} في ${group} حصلوا على أقل من ${scoreThreshold}% في ${exam}.`
    };
  }
  throw new Error("unsupported_aggregated_notification_type");
}

function aggregatedPayload({ type, groupId, groupName, referenceId, studentCount, metadata, content }) {
  return {
    ...metadata,
    groupId: Number(groupId),
    groupName,
    referenceId,
    studentCount,
    notificationType: type,
    title: content.title,
    message: content.message,
    titleAr: content.titleAr,
    messageAr: content.messageAr
  };
}

export async function upsertAggregatedNotification({
  type,
  groupId,
  referenceId,
  studentCount,
  groupName,
  metadata = {},
  recipients = [],
  db = query
} = {}) {
  if (!AGGREGATED_NOTIFICATION_TYPES.includes(type)) throw new Error("unsupported_aggregated_notification_type");
  const count = safeCount(studentCount);
  const normalizedGroupId = Number(groupId);
  const normalizedReferenceId = normalizedReferenceIdValue(referenceId);
  if (!Number.isSafeInteger(normalizedGroupId) || normalizedGroupId <= 0 || !normalizedReferenceId || !count) return { created: 0, deduplicated: 0, skipped: true };

  const content = formatAggregatedNotification({ type, groupName, studentCount: count, examName: metadata.examName || metadata.exam_name, billingPeriod: metadata.billingPeriod || metadata.billing_period, threshold: metadata.threshold });
  const payload = aggregatedPayload({ type, groupId: normalizedGroupId, groupName, referenceId: normalizedReferenceId, studentCount: count, metadata, content });
  const targetSection = type === NotificationType.ATTENDANCE_ABSENCE ? "attendance" : type === NotificationType.UNPAID_FEES ? "payments" : "evaluations";
  const entityId = /^\d+$/.test(normalizedReferenceId) ? normalizedReferenceId : null;
  let created = 0;
  let deduplicated = 0;
  for (const recipient of recipients) {
    const recipientId = Number(typeof recipient === "object" ? recipient.id : recipient);
    if (!Number.isSafeInteger(recipientId) || recipientId <= 0) continue;
    const dedupeKey = `${type}:recipient:${recipientId}:group:${normalizedGroupId}:reference:${normalizedReferenceId}`;
    const result = await db(
      `INSERT INTO notifications (
         recipient_user_id, type, notification_type, entity_type, entity_id, target_section,
         payload, title, message, group_id, reference_id, student_count, metadata,
         dedupe_key, is_read, read_at, resolved_at
       ) VALUES ($1,$2,$2,'group',$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11::jsonb,$12,FALSE,NULL,NULL)
       ON CONFLICT (recipient_user_id, dedupe_key) DO UPDATE SET
         type = EXCLUDED.type,
         notification_type = EXCLUDED.notification_type,
         entity_type = EXCLUDED.entity_type,
         entity_id = EXCLUDED.entity_id,
         target_section = EXCLUDED.target_section,
         payload = EXCLUDED.payload,
         title = EXCLUDED.title,
         message = EXCLUDED.message,
         group_id = EXCLUDED.group_id,
         reference_id = EXCLUDED.reference_id,
         student_count = EXCLUDED.student_count,
         metadata = EXCLUDED.metadata,
         is_read = CASE WHEN notifications.resolved_at IS NOT NULL THEN FALSE ELSE notifications.is_read END,
         read_at = CASE WHEN notifications.resolved_at IS NOT NULL THEN NULL ELSE notifications.read_at END,
         resolved_at = NULL,
         updated_at = NOW()
       RETURNING id, (xmax = 0) AS inserted`,
      [recipientId, type, entityId, targetSection, JSON.stringify(payload), content.title, content.message, normalizedGroupId, normalizedReferenceId, count, JSON.stringify({ ...metadata, group_id: normalizedGroupId, group_name: groupName, reference_id: normalizedReferenceId, student_count: count, title_ar: content.titleAr, message_ar: content.messageAr }) , dedupeKey]
    );
    const inserted = result.rows?.[0]?.inserted === true;
    if (inserted) {
      created += 1;
      console.info(JSON.stringify({ event: "aggregated_notification_created", notification_type: type, group_id: normalizedGroupId, reference_id: normalizedReferenceId, student_count: count, recipient_user_id: recipientId }));
    } else {
      deduplicated += 1;
      console.info(JSON.stringify({ event: "aggregated_notification_deduplicated", dedupe_key: dedupeKey }));
    }
  }
  return { created, deduplicated, skipped: false };
}

function normalizedReferenceIdValue(value) {
  return normalizedReferenceId(value);
}

export async function getAggregatedNotificationRecipients({ type, groupId, db = query } = {}) {
  const permission = type === NotificationType.UNPAID_FEES ? "payments.reports.view" : "dashboard.alerts.view";
  const result = await db(`
    SELECT t.id, t.role, t.permissions,
      COALESCE((SELECT array_agg(tga.group_id ORDER BY tga.group_id) FROM teacher_group_access tga WHERE tga.teacher_id = t.id), '{}') AS group_ids
    FROM teachers t
    WHERE t.is_active = TRUE AND t.deleted_at IS NULL`);
  return (result.rows || []).filter((recipient) =>
    hasPermission(recipient, permission) && hasGroupAccess({ ...recipient, group_ids: recipient.group_ids }, groupId)
  );
}

async function syncAttentionNotifications(recipientUserId, teacher, db = query) {
  const scope = notificationPermissionScope(teacher);
  if (!scope.attention) return [];
  const groupScope = !["owner", "admin"].includes(String(teacher.role || "")) ? Number.isInteger(Number(teacher.group_ids?.[0])) ? teacher.group_ids : [] : null;
  const thresholds = await getDashboardAlertThresholds(db);
  const feeValues = [];
  const feeScope = [];
  if (Array.isArray(groupScope)) { feeValues.push(groupScope); feeScope.push(`fd.group_id = ANY($${feeValues.length}::int[])`); }
  const feeRows = scope.payment ? await db(`
    SELECT fd.group_id, COALESCE(g.display_name, g.name) AS group_name,
      to_char(fd.due_month, 'YYYY-MM') AS billing_period, COUNT(DISTINCT fd.student_id)::int AS student_count
    FROM fee_dues fd JOIN groups g ON g.id = fd.group_id
    JOIN students s ON s.id = fd.student_id AND s.is_active = TRUE AND s.deleted_at IS NULL
    WHERE fd.amount > fd.paid_amount AND fd.due_month <= date_trunc('month', (NOW() AT TIME ZONE 'Africa/Cairo'))::date
      ${feeScope.length ? `AND ${feeScope.join(" AND ")}` : ""}
    GROUP BY fd.group_id, g.display_name, g.name, fd.due_month
    ORDER BY fd.due_month DESC`, feeValues) : { rows: [] };
  const examValues = [thresholds.evaluationAlert];
  const examScope = [];
  if (Array.isArray(groupScope)) { examValues.push(groupScope); examScope.push(`s.group_id = ANY($${examValues.length}::int[])`); }
  const examRows = await db(`
    SELECT e.id AS exam_id, e.group_id, COALESCE(g.display_name, g.name) AS group_name,
      e.title AS exam_name, COUNT(DISTINCT er.student_id)::int AS student_count
    FROM exam_results er JOIN exams e ON e.id = er.exam_id JOIN groups g ON g.id = e.group_id
    JOIN students s ON s.id = er.student_id AND s.is_active = TRUE AND s.deleted_at IS NULL
    WHERE e.max_score > 0 AND er.score / e.max_score * 100 < $1
      ${examScope.length ? `AND ${examScope.join(" AND ")}` : ""}
    GROUP BY e.id, e.group_id, g.display_name, g.name, e.title`, examValues);

  const activeKeys = [];
  const notifications = [];
  for (const row of feeRows.rows || []) {
    const referenceId = String(row.billing_period);
    const notification = { type: NotificationType.UNPAID_FEES, groupId: Number(row.group_id), referenceId, groupName: row.group_name, studentCount: Number(row.student_count), metadata: { billingPeriod: referenceId, paymentStatus: "unpaid", reportFilter: { status: "unpaid", groupId: Number(row.group_id), period: referenceId } } };
    notifications.push(notification);
    activeKeys.push(`${notification.type}:recipient:${recipientUserId}:group:${notification.groupId}:reference:${referenceId}`);
  }
  for (const row of examRows.rows || []) {
    const referenceId = String(row.exam_id);
    const notification = { type: NotificationType.LOW_EXAM_GRADE, groupId: Number(row.group_id), referenceId, groupName: row.group_name, studentCount: Number(row.student_count), metadata: { examId: Number(row.exam_id), examName: row.exam_name, threshold: thresholds.evaluationAlert, reportFilter: { groupId: Number(row.group_id), examId: Number(row.exam_id), maxScorePercentage: thresholds.evaluationAlert } } };
    notifications.push(notification);
    activeKeys.push(`${notification.type}:recipient:${recipientUserId}:group:${notification.groupId}:reference:${referenceId}`);
  }
  await db(
    `UPDATE notifications SET resolved_at = NOW(), updated_at = NOW()
     WHERE recipient_user_id = $1 AND type IN ($2,$3) AND resolved_at IS NULL ${activeKeys.length ? "AND NOT (dedupe_key = ANY($4::text[]))" : ""}`,
    activeKeys.length ? [recipientUserId, NotificationType.UNPAID_FEES, NotificationType.LOW_EXAM_GRADE, activeKeys] : [recipientUserId, NotificationType.UNPAID_FEES, NotificationType.LOW_EXAM_GRADE]
  );
  // Hide the old per-student dashboard alerts after the aggregated records are available.
  await db(`UPDATE notifications SET resolved_at = NOW(), updated_at = NOW() WHERE recipient_user_id = $1 AND type IN ('attendance_low','evaluation_low','payment_overdue') AND entity_type = 'student' AND resolved_at IS NULL`, [recipientUserId]);
  for (const notification of notifications) await upsertAggregatedNotification({ ...notification, recipients: [recipientUserId], db });
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
  const dedupeKey = `whatsapp_connection:${reason}`;
  const payload = { status, reason, phoneNumber: phoneNumber || null };
  const notificationRecipients = (recipients.rows || []).filter((recipient) => hasPermission(recipient, "whatsapp.view"));
  let recorded = 0;
  let shouldSendEmail = false;

  // The deterministic key plus the conditional upsert forms an atomic,
  // database-backed cooldown across every API instance.
  const gateRecipient = notificationRecipients[0];
  if (gateRecipient) {
    const gate = await db(
      `INSERT INTO notifications (recipient_user_id, type, entity_type, entity_id, target_section, payload, dedupe_key, is_read, resolved_at)
       VALUES ($1, 'whatsapp_disconnected', 'whatsapp', NULL, 'whatsapp', $2::jsonb, $3, FALSE, NULL)
       ON CONFLICT (recipient_user_id, dedupe_key) DO UPDATE SET
         payload = EXCLUDED.payload,
         is_read = FALSE,
         resolved_at = NULL,
         created_at = NOW(),
         updated_at = NOW()
       WHERE notifications.created_at < NOW() - ($4 * INTERVAL '1 minute')
       RETURNING id`,
      [gateRecipient.id, JSON.stringify(payload), dedupeKey, WHATSAPP_CONNECTION_ALERT_COOLDOWN_MINUTES]
    );
    shouldSendEmail = Boolean(gate.rowCount);
  }

  if (shouldSendEmail) {
    await db(
      `UPDATE notifications
       SET resolved_at = NOW(), is_read = TRUE, updated_at = NOW()
       WHERE recipient_user_id = ANY($1::int[])
         AND type = 'whatsapp_disconnected'
         AND resolved_at IS NULL
         AND dedupe_key LIKE 'whatsapp_connection:%'
         AND dedupe_key <> $2`,
      [notificationRecipients.map((recipient) => recipient.id), dedupeKey]
    );
  }

  if (shouldSendEmail) {
    for (const recipient of notificationRecipients) {
      if (recipient.id === gateRecipient.id) {
        recorded += 1;
        continue;
      }
      await db(
        `INSERT INTO notifications (recipient_user_id, type, entity_type, entity_id, target_section, payload, dedupe_key, is_read, resolved_at)
         VALUES ($1, 'whatsapp_disconnected', 'whatsapp', NULL, 'whatsapp', $2::jsonb, $3, FALSE, NULL)
         ON CONFLICT (recipient_user_id, dedupe_key) DO UPDATE SET
           payload = EXCLUDED.payload,
           is_read = FALSE,
           resolved_at = NULL,
           created_at = NOW(),
           updated_at = NOW()`,
        [recipient.id, JSON.stringify(payload), dedupeKey]
      );
      recorded += 1;
    }
  }

  const emails = shouldSendEmail
    ? await sendWhatsAppDisconnectEmails(recipients.rows || [], { reason, phoneNumber, db, sendEmail, getEmailConfig })
    : {
      sent: 0,
      failed: 0,
      skipped: (recipients.rows || []).filter((recipient) => validEmail(recipient.email)).length
    };
  return { recorded, status, reason, suppressed: !shouldSendEmail, ...emails };
}

export async function listNotificationsForUser(teacher, { limit = 10, db = query } = {}) {
  await db(
    `UPDATE notifications
     SET resolved_at = NOW(), is_read = TRUE, updated_at = NOW()
     WHERE recipient_user_id = $1
       AND type = 'whatsapp_disconnected'
       AND resolved_at IS NULL
       AND dedupe_key LIKE 'whatsapp_connection:%'
       AND dedupe_key NOT IN ('whatsapp_connection:connection_closed', 'whatsapp_connection:logged_out', 'whatsapp_connection:manual_disconnect')`,
    [teacher.id]
  );
  await syncNotificationsForUser(teacher, db);
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 10));
  const result = await db(
    `SELECT id, type, notification_type, entity_type, entity_id, target_section,
        group_id, reference_id, student_count, metadata, title, message,
        payload, is_read, read_at, created_at, updated_at
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
