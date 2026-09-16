export const NotificationType = Object.freeze({
  ATTENDANCE_ABSENCE: "attendance_absence",
  UNPAID_FEES: "unpaid_fees",
  LOW_EXAM_GRADE: "low_exam_grade"
});

export const AGGREGATED_NOTIFICATION_TYPES = Object.freeze([
  NotificationType.ATTENDANCE_ABSENCE,
  NotificationType.UNPAID_FEES,
  NotificationType.LOW_EXAM_GRADE
]);

export function isAggregatedNotificationType(value) {
  return AGGREGATED_NOTIFICATION_TYPES.includes(String(value || ""));
}
