export type NotificationActionInput = {
  type?: string | null;
  notification_type?: string | null;
  entity_id?: number | string | null;
  reference_id?: number | string | null;
  group_id?: number | string | null;
  metadata?: Record<string, any> | null;
  payload?: Record<string, any> | null;
};

function positiveId(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return /^\d+$/.test(normalized) && Number(normalized) > 0 ? normalized : null;
}

function safePeriod(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return /^\d{4}-\d{2}$/.test(normalized) ? normalized : null;
}

function metadataValue(notification: NotificationActionInput, ...keys: string[]) {
  const sources = [notification.metadata || {}, notification.payload || {}];
  for (const key of keys) {
    for (const source of sources) {
      if (source[key] !== undefined && source[key] !== null && source[key] !== "") return source[key];
    }
  }
  return null;
}

export function getNotificationAction(notification: NotificationActionInput): string | null {
  try {
    const type = String(notification.notification_type || notification.type || "");
    const groupId = positiveId(notification.group_id ?? metadataValue(notification, "groupId", "group_id"));
    if (!groupId) return null;

    if (type === "attendance_absence") {
      const sessionId = positiveId(notification.reference_id ?? metadataValue(notification, "sessionId", "session_id") ?? notification.entity_id);
      if (!sessionId) return null;
      const date = String(metadataValue(notification, "sessionDate", "session_date") || "").match(/^\d{4}-\d{2}-\d{2}$/)?.[0];
      const params = new URLSearchParams({ tab: "attendance", group_id: groupId, sessionId, status: "absent" });
      if (date) params.set("date", date);
      return `/teacher/dashboard?${params.toString()}`;
    }

    if (type === "unpaid_fees") {
      const period = safePeriod(notification.reference_id ?? metadataValue(notification, "billingPeriod", "billing_period"));
      if (!period) return null;
      return `/teacher/dashboard?${new URLSearchParams({ tab: "reports", view: "overdue", group_id: groupId, period, status: "unpaid" }).toString()}`;
    }

    if (type === "low_exam_grade") {
      const examId = positiveId(notification.reference_id ?? metadataValue(notification, "examId", "exam_id") ?? notification.entity_id);
      if (!examId) return null;
      const threshold = Number(metadataValue(notification, "threshold") ?? 0);
      const params = new URLSearchParams({ tab: "exams", group_id: groupId, exam_id: examId });
      if (Number.isFinite(threshold) && threshold >= 0 && threshold <= 100) params.set("maxScorePercentage", String(threshold));
      return `/teacher/dashboard?${params.toString()}`;
    }
  } catch (_error) {
    // A malformed or legacy row remains displayable without a navigation action.
  }
  return null;
}
