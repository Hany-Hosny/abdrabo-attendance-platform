export const ATTENDANCE_STATUSES = Object.freeze([
  "present",
  "absent",
  "late",
  "pending_review",
  "rejected",
  "excused"
]);

export const MANUAL_ATTENDANCE_STATUSES = Object.freeze([
  "present",
  "absent",
  "late",
  "pending_review",
  "excused"
]);

export const COUNTED_ATTENDANCE_STATUSES = Object.freeze(["present", "late", "absent"]);
export const ATTENDANCE_REPORT_STATUSES = Object.freeze(["present", "late"]);

export function isFinalizedAttendanceSession(session = {}) {
  return session.status === "closed" && session.status !== "cancelled";
}

export function attendanceRateFromStatuses(records = []) {
  const counted = records.filter((record) => COUNTED_ATTENDANCE_STATUSES.includes(String(record?.status || "")));
  if (!counted.length) return null;
  const attended = counted.filter((record) => record.status === "present" || record.status === "late").length;
  return (attended / counted.length) * 100;
}
