import { query } from "../db/pool.js";
import { hasPermission } from "./rbac.js";
import { listStudentsNeedingAttention } from "./studentAttention.js";

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
