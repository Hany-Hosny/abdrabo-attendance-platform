import "../config/env.js";

export const OWNER_USER_ID = Number(process.env.PRIMARY_OWNER_USER_ID || 1);

export const PERMISSIONS = Object.freeze([
  "students.view",
  "students.manage",
  "students.delete",
  "attendance.view",
  "attendance.manage",
  "exams.view",
  "exams.manage",
  "homework.view",
  "homework.manage",
  "schedule.view",
  "schedule.manage",
  "payments.view",
  "payments.manage",
  "payments.collect",
  "payments.advance",
  "payments.reports.view",
  "payments.reverse",
  "messages.view",
  "messages.manage",
  "notes.view",
  "notes.manage",
  "users.view",
  "users.create",
  "users.edit",
  "users.disable",
  "users.delete",
  "activity_log.view",
  "whatsapp.view",
  "whatsapp.manage",
  "settings.manage",
  "dashboard.view",
  "dashboard.financial.view",
  "dashboard.group_performance.view",
  "dashboard.alerts.view",
  "dashboard.activity.view"
]);

export const DASHBOARD_PERMISSIONS = Object.freeze([
  "dashboard.view",
  "dashboard.financial.view",
  "dashboard.group_performance.view",
  "dashboard.alerts.view",
  "dashboard.activity.view"
]);

// payments.manage predates the fine-grained payment capabilities. It remains a
// compatibility alias for collecting and advancing payments only. It never
// grants access to financial reports.
const LEGACY_PERMISSION_ALIASES = Object.freeze({
  "payments.collect": ["payments.collect", "payments.manage"],
  "payments.advance": ["payments.advance", "payments.manage"],
  "whatsapp.view": ["whatsapp.view", "whatsapp.manage", "settings.manage"],
  "whatsapp.manage": ["whatsapp.manage", "settings.manage"]
});

const DEFAULT_ADMIN_EXCLUDED_PERMISSIONS = new Set([
  ...DASHBOARD_PERMISSIONS,
  "payments.collect",
  "payments.advance",
  "payments.reports.view"
]);

// Dashboard permissions are intentionally excluded from the normal admin default.
// Owners receive them through hasPermission(), while normal admins must be assigned
// dashboard permissions explicitly through the existing permissions editor.
export const DEFAULT_ADMIN_PERMISSIONS = Object.freeze(
  PERMISSIONS.filter((permission) => !DEFAULT_ADMIN_EXCLUDED_PERMISSIONS.has(permission))
);
export const DEFAULT_STAFF_PERMISSIONS = Object.freeze([
  "students.view",
  "students.manage",
  "attendance.view",
  "attendance.manage",
  "exams.view",
  "exams.manage",
  "homework.view",
  "homework.manage",
  "schedule.view",
  "payments.view",
  "messages.view",
  "messages.manage",
  "notes.view",
  "notes.manage"
]);

export function normalizePermissions(value) {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values.map((permission) => String(permission || "").trim()).filter((permission) => PERMISSIONS.includes(permission)))].sort();
}

export function isOwner(user) {
  return user?.role === "owner";
}

export function hasPermission(user, permission) {
  if (isOwner(user)) return true;
  const assigned = new Set(normalizePermissions(user?.permissions));
  return (LEGACY_PERMISSION_ALIASES[permission] || [permission]).some((candidate) => assigned.has(candidate));
}

export function canGrantPermissions(actor, permissions) {
  if (isOwner(actor)) return true;
  return normalizePermissions(permissions).every((permission) => hasPermission(actor, permission));
}

export function requirePermission(permission) {
  return (req, res, next) => {
    if (!hasPermission(req.teacher, permission)) return res.status(403).json({ ok: false, status: "permission_required", permission });
    return next();
  };
}

export function requireAnyPermission(...permissions) {
  return (req, res, next) => {
    if (!permissions.some((permission) => hasPermission(req.teacher, permission))) return res.status(403).json({ ok: false, status: "permission_required", permission: permissions.join(",") });
    return next();
  };
}

export function roleIsAtLeastAdmin(user) {
  return user?.role === "owner" || user?.role === "admin";
}
