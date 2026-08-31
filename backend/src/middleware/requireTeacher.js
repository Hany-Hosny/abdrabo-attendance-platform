import { verifyTeacherToken } from "../services/auth.js";
import { hasPermission } from "../services/rbac.js";
import { query } from "../db/pool.js";

export async function requireTeacher(req, res, next) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const payload = verifyTeacherToken(token);

  if (!payload) {
    return res.status(401).json({ ok: false, status: "unauthorized" });
  }

  try {
    const result = await query("SELECT id, name, email, username, role, permissions, is_active, deleted_at, can_use_inbox FROM teachers WHERE id = $1", [payload.sub]);
    const user = result.rows[0];
    // The database is the source of truth for current role and permissions.
    // This also lets an existing token continue safely after an owner transfer.
    if (!user || !user.is_active || user.deleted_at) return res.status(401).json({ ok: false, status: "unauthorized" });
    req.teacher = { ...payload, ...user, sub: user.id };
    return next();
  } catch (error) { return next(error); }
}

export function requireRoles(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.teacher?.role)) return res.status(403).json({ ok: false, status: "forbidden" });
    return next();
  };
}

export function requireAdmin(req, res, next) {
  return requireTeacher(req, res, () => {
    if (!['owner', 'admin'].includes(req.teacher?.role)) {
      return res.status(403).json({ ok: false, status: "forbidden" });
    }

    return next();
  });
}

export function requirePermission(permission) {
  return (req, res, next) => {
    if (!hasPermission(req.teacher, permission)) return res.status(403).json({ ok: false, status: "permission_required", permission });
    return next();
  };
}
