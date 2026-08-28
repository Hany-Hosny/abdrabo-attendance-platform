import { verifyTeacherToken } from "../services/auth.js";
import { query } from "../db/pool.js";

export async function requireTeacher(req, res, next) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const payload = verifyTeacherToken(token);

  if (!payload) {
    return res.status(401).json({ ok: false, status: "unauthorized" });
  }

  try {
    const result = await query("SELECT id, name, email, username, role, is_active, deleted_at, can_use_inbox FROM teachers WHERE id = $1", [payload.sub]);
    const user = result.rows[0];
    if (!user || !user.is_active || user.deleted_at || user.role !== payload.role) return res.status(401).json({ ok: false, status: "unauthorized" });
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
    if (req.teacher?.role !== "admin") {
      return res.status(403).json({ ok: false, status: "forbidden" });
    }

    return next();
  });
}
