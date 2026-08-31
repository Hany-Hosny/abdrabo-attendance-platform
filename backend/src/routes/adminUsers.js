import express from "express";
import { requireAdmin, requirePermission } from "../middleware/requireTeacher.js";
import { pool, query } from "../db/pool.js";
import { hashPassword, verifyPassword } from "../services/auth.js";
import { auditLog, changedFields } from "../services/audit.js";
import { DEFAULT_ADMIN_PERMISSIONS, DEFAULT_STAFF_PERMISSIONS, canGrantPermissions, isOwner, normalizePermissions } from "../services/rbac.js";

export const adminUsersRouter = express.Router();

const allowedRoles = new Set(["owner", "admin", "staff"]);

function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    username: row.username,
    email: row.email,
    role: row.role,
    is_active: row.is_active,
    deleted_at: row.deleted_at,
    print_student_labels: row.print_student_labels,
    max_label_reprints: row.max_label_reprints,
    can_use_inbox: row.can_use_inbox,
    permissions: normalizePermissions(row.permissions),
    is_owner: row.role === "owner",
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function actorOwnsAccount(req) {
  return isOwner(req.teacher);
}

function permissionPayload(body, role) {
  if (Array.isArray(body?.permissions)) return normalizePermissions(body.permissions);
  return role === "staff" ? [...DEFAULT_STAFF_PERMISSIONS] : [];
}

function auditUserDetails(user, extra = {}) {
  return {
    target_user_id: user.id,
    target_user: { name: user.name, username: user.username, email: user.email },
    previous_role: extra.previous_role ?? null,
    new_role: extra.new_role ?? user.role,
    previous_permissions: extra.previous_permissions ?? [],
    new_permissions: extra.new_permissions ?? normalizePermissions(user.permissions),
    ...extra
  };
}

adminUsersRouter.use(requireAdmin);

adminUsersRouter.post("/transfer-ownership", async (req, res, next) => {
  if (!actorOwnsAccount(req)) return res.status(403).json({ ok: false, status: "owner_only" });
  const targetUserId = Number(req.body?.target_user_id);
  const currentPassword = String(req.body?.current_password || "");
  if (!Number.isInteger(targetUserId) || targetUserId <= 0 || targetUserId === Number(req.teacher.id) || !currentPassword) return res.status(400).json({ ok: false, status: "invalid_transfer_payload" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const currentResult = await client.query("SELECT id, name, username, email, role, permissions, password_hash FROM teachers WHERE id = $1 FOR UPDATE", [req.teacher.id]);
    const targetResult = await client.query("SELECT id, name, username, email, role, permissions, is_active, deleted_at FROM teachers WHERE id = $1 FOR UPDATE", [targetUserId]);
    const current = currentResult.rows[0];
    const target = targetResult.rows[0];
    if (!current || current.role !== "owner" || !verifyPassword(currentPassword, current.password_hash)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ ok: false, status: "invalid_owner_password" });
    }
    if (!target || target.deleted_at || !target.is_active || target.role === "owner") {
      await client.query("ROLLBACK");
      return res.status(400).json({ ok: false, status: "invalid_owner_target" });
    }
    await client.query("UPDATE teachers SET role = 'admin', permissions = $1::jsonb, permissions_initialized = TRUE, updated_at = NOW() WHERE id = $2", [JSON.stringify(DEFAULT_ADMIN_PERMISSIONS), current.id]);
    await client.query("UPDATE teachers SET role = 'owner', permissions_initialized = TRUE, updated_at = NOW() WHERE id = $1", [target.id]);
    await auditLog({
      db: client,
      action: "ownership_transferred",
      actorId: current.id,
      details: {
        operation: "ownership_transfer",
        target_user_id: target.id,
        target_user: { name: target.name, username: target.username, email: target.email },
        previous_role: target.role,
        new_role: "owner",
        previous_permissions: normalizePermissions(target.permissions),
        new_permissions: normalizePermissions(target.permissions),
        previous_owner_id: current.id,
        new_owner_id: target.id,
        changes: [
          { field: "owner_user_id", before: current.id, after: target.id },
          { field: "previous_owner_role", before: "owner", after: "admin" },
          { field: "new_owner_role", before: target.role, after: "owner" }
        ]
      }
    });
    await client.query("COMMIT");
    return res.json({ ok: true, owner: { ...publicUser({ ...target, role: "owner" }), is_owner: true } });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    return next(error);
  } finally {
    client.release();
  }
});

adminUsersRouter.get("/", requirePermission("users.view"), async (req, res, next) => {
  try {
    const result = await query(
      `
        SELECT id, name, username, email, role, permissions, is_active, deleted_at, print_student_labels, max_label_reprints, can_use_inbox, created_at, updated_at
        FROM teachers
        WHERE ($1 = 'all') OR ($1 = 'deleted' AND deleted_at IS NOT NULL) OR ($1 = 'active' AND deleted_at IS NULL AND is_active = TRUE) OR ($1 = 'disabled' AND deleted_at IS NULL AND is_active = FALSE)
        ORDER BY created_at ASC
      `, [String(req.query.status || "active")]
    );

    return res.json({ ok: true, users: result.rows.map(publicUser) });
  } catch (error) {
    next(error);
  }
});

adminUsersRouter.post("/", requirePermission("users.create"), async (req, res, next) => {
  try {
    const name = String(req.body?.name || "").trim();
    const username = String(req.body?.username || "").trim().toLowerCase();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const role = String(req.body?.role || "staff").trim();
    const permissions = permissionPayload(req.body, role);
    const canUseInbox = Boolean(req.body?.can_use_inbox);

    if (!name || !username || !email || !password || !allowedRoles.has(role) || role === "owner") {
      return res.status(400).json({ ok: false, status: "invalid_user_payload" });
    }
    if (!canGrantPermissions(req.teacher, permissions)) return res.status(403).json({ ok: false, status: "permission_grant_forbidden" });

    const result = await query(
      `
        INSERT INTO teachers (name, username, email, password_hash, role, permissions, permissions_initialized, is_active, can_use_inbox, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, TRUE, TRUE, $7, NOW())
        RETURNING id, name, username, email, role, permissions, is_active, deleted_at, print_student_labels, max_label_reprints, can_use_inbox, created_at, updated_at
      `,
      [name, username, email, hashPassword(password), role, JSON.stringify(permissions), canUseInbox]
    );

    const user = publicUser(result.rows[0]);
    await auditLog({ action: "user_created", actorId: req.teacher.id, details: auditUserDetails(user, { previous_role: null, new_role: user.role, previous_permissions: [], new_permissions: user.permissions, after: user }), request: req });
    return res.status(201).json({ ok: true, user });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ ok: false, status: "user_exists" });
    }
    next(error);
  }
});

adminUsersRouter.put("/:id", requirePermission("users.edit"), async (req, res, next) => {
  try {
    const targetUserId = Number(req.params.id);
    const currentUserId = Number(req.teacher?.sub);
    const name = String(req.body?.name || "").trim();
    const username = String(req.body?.username || "").trim().toLowerCase();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const role = String(req.body?.role || "").trim();
    const permissions = permissionPayload(req.body, role);
    const canUseInbox = Boolean(req.body?.can_use_inbox);
    const isActive = Boolean(req.body?.is_active);
    const printStudentLabels = Boolean(req.body?.print_student_labels);
    const maxLabelReprints = Math.max(0, Number(req.body?.max_label_reprints ?? 2));

    if (!name || !username || !email || !allowedRoles.has(role)) {
      return res.status(400).json({ ok: false, status: "invalid_user_payload" });
    }

    if (targetUserId === currentUserId && !isActive) {
      return res.status(403).json({
        ok: false,
        status: "self_disable_forbidden",
        message: "You cannot disable your own account"
      });
    }

    const beforeResult = await query("SELECT id, name, username, email, role, permissions, is_active, print_student_labels, max_label_reprints, can_use_inbox FROM teachers WHERE id = $1 AND deleted_at IS NULL", [targetUserId]);
    if (!beforeResult.rowCount) return res.status(404).json({ ok: false, status: "not_found" });
    const before = beforeResult.rows[0];
    if (before.role === "owner" && !actorOwnsAccount(req)) return res.status(403).json({ ok: false, status: "owner_protected" });
    if (before.role === "owner" && role !== "owner") return res.status(403).json({ ok: false, status: "owner_protected" });
    if (role === "owner" && before.role !== "owner") return res.status(403).json({ ok: false, status: "owner_transfer_required" });
    if (targetUserId === currentUserId && before.role !== "owner" && role !== before.role) return res.status(403).json({ ok: false, status: "self_role_forbidden" });
    if (!canGrantPermissions(req.teacher, permissions)) return res.status(403).json({ ok: false, status: "permission_grant_forbidden" });
    const result = await query(
      `
        UPDATE teachers
        SET
          name = $1,
          username = $2,
          email = $3,
          role = $4,
          permissions = $5::jsonb,
          is_active = $6,
          print_student_labels = $7,
          max_label_reprints = $8,
          can_use_inbox = $9,
          updated_at = NOW()
        WHERE id = $10 AND deleted_at IS NULL
        RETURNING id, name, username, email, role, permissions, is_active, deleted_at, print_student_labels, max_label_reprints, can_use_inbox, created_at, updated_at
      `,
      [name, username, email, role, JSON.stringify(before.role === "owner" ? normalizePermissions(before.permissions) : permissions), isActive, printStudentLabels, maxLabelReprints, canUseInbox, req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ ok: false, status: "not_found" });
    }

    const user = publicUser(result.rows[0]);
    const previousPermissions = normalizePermissions(before.permissions);
    const newPermissions = user.permissions;
    const permissionsAdded = newPermissions.filter((permission) => !previousPermissions.includes(permission));
    const permissionsRemoved = previousPermissions.filter((permission) => !newPermissions.includes(permission));
    const roleChanged = before.role !== user.role;
    const permissionsChanged = permissionsAdded.length > 0 || permissionsRemoved.length > 0;
    const action = roleChanged ? "role_changed" : permissionsChanged ? "permissions_changed" : "user_updated";
    await auditLog({ action, actorId: req.teacher.id, details: auditUserDetails(user, { previous_role: before.role, new_role: user.role, previous_permissions: previousPermissions, new_permissions: newPermissions, permissions_added: permissionsAdded, permissions_removed: permissionsRemoved, changes: changedFields(before, user), before, after: user }), request: req });
    return res.json({ ok: true, user });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ ok: false, status: "user_exists" });
    }
    next(error);
  }
});

adminUsersRouter.post("/:id/reset-password", requirePermission("users.edit"), async (req, res, next) => {
  try {
    const password = String(req.body?.password || "");
    if (password.length < 8) {
      return res.status(400).json({ ok: false, status: "password_too_short" });
    }

    const beforeResult = await query("SELECT id, name, username, email, role, permissions, is_active FROM teachers WHERE id = $1 AND deleted_at IS NULL", [Number(req.params.id)]);
    if (!beforeResult.rowCount) return res.status(404).json({ ok: false, status: "not_found" });
    if (beforeResult.rows[0].role === "owner" && !actorOwnsAccount(req)) return res.status(403).json({ ok: false, status: "owner_protected" });
    const result = await query(
      `
        UPDATE teachers
        SET password_hash = $1, updated_at = NOW()
        WHERE id = $2 AND deleted_at IS NULL
      RETURNING id, name, username, email, role, permissions, is_active, print_student_labels, max_label_reprints, created_at, updated_at
      `,
      [hashPassword(password), req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ ok: false, status: "not_found" });
    }

    const user = publicUser(result.rows[0]);
    await auditLog({ action: "user_password_reset", actorId: req.teacher.id, details: auditUserDetails(user, { password_changed: true }), request: req });
    return res.json({ ok: true, user });
  } catch (error) {
    next(error);
  }
});

adminUsersRouter.patch("/:id/status", requirePermission("users.disable"), async (req, res, next) => {
  try {
    const targetUserId = Number(req.params.id);
    const currentUserId = Number(req.teacher?.sub);
    const isActive = Boolean(req.body?.is_active);

    if (targetUserId === currentUserId && !isActive) {
      return res.status(403).json({
        ok: false,
        status: "self_disable_forbidden",
        message: "You cannot disable your own account"
      });
    }

    const beforeResult = await query("SELECT id, name, username, email, role, permissions, is_active FROM teachers WHERE id = $1 AND deleted_at IS NULL", [targetUserId]);
    if (!beforeResult.rowCount) return res.status(404).json({ ok: false, status: "not_found" });
    if (beforeResult.rows[0].role === "owner" && !actorOwnsAccount(req)) return res.status(403).json({ ok: false, status: "owner_protected" });
    const result = await query(
      `
        UPDATE teachers
        SET is_active = $1, updated_at = NOW()
        WHERE id = $2 AND deleted_at IS NULL
        RETURNING id, name, username, email, role, permissions, is_active, created_at, updated_at
      `,
      [isActive, req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ ok: false, status: "not_found" });
    }

    const user = publicUser(result.rows[0]);
    await auditLog({ action: "user_status_changed", actorId: req.teacher.id, details: auditUserDetails(user, { previous_role: beforeResult.rows[0].role, previous_permissions: normalizePermissions(beforeResult.rows[0].permissions), changes: changedFields(beforeResult.rows[0], user), before: { is_active: beforeResult.rows[0].is_active }, after: { is_active: user.is_active } }), request: req });
    return res.json({ ok: true, user });
  } catch (error) {
    next(error);
  }
});

adminUsersRouter.delete("/:id", requirePermission("users.delete"), async (req, res, next) => {
  try {
    const targetUserId = Number(req.params.id);
    if (targetUserId === Number(req.teacher?.sub)) return res.status(403).json({ok:false,status:"self_delete_forbidden"});
    const before = await query("SELECT id, name, username, email, role, permissions, is_active FROM teachers WHERE id=$1 AND deleted_at IS NULL", [targetUserId]);
    if (!before.rowCount) return res.status(404).json({ok:false,status:"not_found"});
    if (before.rows[0].role === "owner") return res.status(403).json({ok:false,status:"owner_protected"});
    const result = await query("UPDATE teachers SET deleted_at=NOW(), is_active=FALSE, updated_at=NOW() WHERE id=$1 AND deleted_at IS NULL RETURNING id", [targetUserId]);
    if (!result.rowCount) return res.status(404).json({ok:false,status:"not_found"});
    await auditLog({ action: "user_archived", actorId: req.teacher.id, details: auditUserDetails(before.rows[0], { previous_role: before.rows[0].role, new_role: before.rows[0].role, previous_permissions: normalizePermissions(before.rows[0].permissions), new_permissions: normalizePermissions(before.rows[0].permissions), changes: [{ field: "deleted_at", before: null, after: "set" }, { field: "is_active", before: before.rows[0].is_active, after: false }] }), request: req });
    res.json({ok:true});
  } catch (error) { next(error); }
});

adminUsersRouter.delete("/:id/permanent", requirePermission("users.delete"), async (req, res, next) => {
  const targetUserId = Number(req.params.id);
  if (!Number.isSafeInteger(targetUserId) || targetUserId <= 0) return res.status(400).json({ ok: false, status: "invalid_user_id" });
  if (targetUserId === Number(req.teacher?.sub)) return res.status(403).json({ ok: false, status: "self_delete_forbidden" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const beforeResult = await client.query(
      "SELECT id, name, username, email, role, is_active, deleted_at FROM teachers WHERE id = $1 AND deleted_at IS NOT NULL FOR UPDATE",
      [targetUserId]
    );
    if (!beforeResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, status: "not_found_or_not_deleted" });
    }
    if (beforeResult.rows[0].role === "owner") {
      await client.query("ROLLBACK");
      return res.status(403).json({ ok: false, status: "owner_protected" });
    }

    const auditEntry = await auditLog({
      db: client,
      action: "user_permanently_deleted",
      actorId: req.teacher.id,
      details: {
        target_user_id: targetUserId,
        deleted_at: beforeResult.rows[0].deleted_at,
        reason: "admin_permanent_delete"
      },
      request: req
    });
    if (!auditEntry) {
      await client.query("ROLLBACK");
      return res.status(500).json({ ok: false, status: "audit_failed" });
    }

    const result = await client.query(
      "DELETE FROM teachers WHERE id = $1 AND deleted_at IS NOT NULL RETURNING id",
      [targetUserId]
    );
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, status: "not_found_or_not_deleted" });
    }

    await client.query("COMMIT");
    return res.json({ ok: true, deleted: true });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    return next(error);
  } finally {
    client.release();
  }
});

adminUsersRouter.patch("/:id/restore", requirePermission("users.disable"), async (req, res, next) => {
  try {
    const before = await query("SELECT id, name, username, email, role, permissions, is_active, deleted_at FROM teachers WHERE id=$1", [Number(req.params.id)]);
    if (!before.rowCount) return res.status(404).json({ok:false,status:"not_found"});
    if (before.rows[0].role === "owner" && !actorOwnsAccount(req)) return res.status(403).json({ok:false,status:"owner_protected"});
    const result = await query("UPDATE teachers SET deleted_at=NULL, is_active=TRUE, updated_at=NOW() WHERE id=$1 RETURNING id, name, username, email, role, permissions, is_active, print_student_labels, max_label_reprints, created_at, updated_at", [Number(req.params.id)]);
    if (!result.rowCount) return res.status(404).json({ok:false,status:"not_found"});
    const user = publicUser(result.rows[0]);
    await auditLog({ action: "user_restored", actorId: req.teacher.id, details: { target_user_id: user.id, target_user: user, changes: changedFields(before.rows[0], user) }, request: req });
    res.json({ok:true,user});
  } catch (error) { next(error); }
});
