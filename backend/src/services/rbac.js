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
  "settings.manage"
]);

export const DEFAULT_ADMIN_PERMISSIONS = Object.freeze([...PERMISSIONS]);
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
  return isOwner(user) || normalizePermissions(user?.permissions).includes(permission);
}

export function canGrantPermissions(actor, permissions) {
  if (isOwner(actor)) return true;
  const actorPermissions = new Set(normalizePermissions(actor?.permissions));
  return normalizePermissions(permissions).every((permission) => actorPermissions.has(permission));
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
