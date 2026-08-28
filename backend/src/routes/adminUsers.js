import express from "express";
import { requireAdmin } from "../middleware/requireTeacher.js";
import { query } from "../db/pool.js";
import { hashPassword } from "../services/auth.js";

export const adminUsersRouter = express.Router();

const allowedRoles = new Set(["admin", "teacher", "assistant"]);

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
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

adminUsersRouter.use(requireAdmin);

adminUsersRouter.get("/", async (req, res, next) => {
  try {
    const result = await query(
      `
        SELECT id, name, username, email, role, is_active, deleted_at, print_student_labels, max_label_reprints, can_use_inbox, created_at, updated_at
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

adminUsersRouter.post("/", async (req, res, next) => {
  try {
    const name = String(req.body?.name || "").trim();
    const username = String(req.body?.username || "").trim().toLowerCase();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const role = String(req.body?.role || "assistant").trim();
    const canUseInbox = Boolean(req.body?.can_use_inbox);

    if (!name || !username || !email || !password || !allowedRoles.has(role)) {
      return res.status(400).json({ ok: false, status: "invalid_user_payload" });
    }

    const result = await query(
      `
        INSERT INTO teachers (name, username, email, password_hash, role, is_active, can_use_inbox, updated_at)
        VALUES ($1, $2, $3, $4, $5, TRUE, $6, NOW())
        RETURNING id, name, username, email, role, is_active, deleted_at, print_student_labels, max_label_reprints, can_use_inbox, created_at, updated_at
      `,
      [name, username, email, hashPassword(password), role, canUseInbox]
    );

    return res.status(201).json({ ok: true, user: publicUser(result.rows[0]) });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ ok: false, status: "user_exists" });
    }
    next(error);
  }
});

adminUsersRouter.put("/:id", async (req, res, next) => {
  try {
    const targetUserId = Number(req.params.id);
    const currentUserId = Number(req.teacher?.sub);
    const name = String(req.body?.name || "").trim();
    const username = String(req.body?.username || "").trim().toLowerCase();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const role = String(req.body?.role || "").trim();
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

    if (targetUserId === currentUserId && role !== "admin") {
      return res.status(403).json({
        ok: false,
        status: "self_role_forbidden",
        message: "You cannot change your own admin role"
      });
    }

    const result = await query(
      `
        UPDATE teachers
        SET
          name = $1,
          username = $2,
          email = $3,
          role = $4,
          is_active = $5,
          print_student_labels = $6,
          max_label_reprints = $7,
          can_use_inbox = $8,
          updated_at = NOW()
        WHERE id = $9 AND deleted_at IS NULL
        RETURNING id, name, username, email, role, is_active, deleted_at, print_student_labels, max_label_reprints, can_use_inbox, created_at, updated_at
      `,
      [name, username, email, role, isActive, printStudentLabels, maxLabelReprints, canUseInbox, req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ ok: false, status: "not_found" });
    }

    return res.json({ ok: true, user: publicUser(result.rows[0]) });
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ ok: false, status: "user_exists" });
    }
    next(error);
  }
});

adminUsersRouter.post("/:id/reset-password", async (req, res, next) => {
  try {
    const password = String(req.body?.password || "");
    if (password.length < 8) {
      return res.status(400).json({ ok: false, status: "password_too_short" });
    }

    const result = await query(
      `
        UPDATE teachers
        SET password_hash = $1, updated_at = NOW()
        WHERE id = $2 AND deleted_at IS NULL
      RETURNING id, name, username, email, role, is_active, print_student_labels, max_label_reprints, created_at, updated_at
      `,
      [hashPassword(password), req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ ok: false, status: "not_found" });
    }

    return res.json({ ok: true, user: publicUser(result.rows[0]) });
  } catch (error) {
    next(error);
  }
});

adminUsersRouter.patch("/:id/status", async (req, res, next) => {
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

    const result = await query(
      `
        UPDATE teachers
        SET is_active = $1, updated_at = NOW()
        WHERE id = $2 AND deleted_at IS NULL
        RETURNING id, name, username, email, role, is_active, created_at, updated_at
      `,
      [isActive, req.params.id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ ok: false, status: "not_found" });
    }

    return res.json({ ok: true, user: publicUser(result.rows[0]) });
  } catch (error) {
    next(error);
  }
});

adminUsersRouter.delete("/:id", async (req, res, next) => {
  try {
    const targetUserId = Number(req.params.id);
    if (targetUserId === Number(req.teacher?.sub)) return res.status(403).json({ok:false,status:"self_delete_forbidden"});
    const result = await query("UPDATE teachers SET deleted_at=NOW(), is_active=FALSE, updated_at=NOW() WHERE id=$1 AND deleted_at IS NULL RETURNING id", [targetUserId]);
    if (!result.rowCount) return res.status(404).json({ok:false,status:"not_found"});
    res.json({ok:true});
  } catch (error) { next(error); }
});

adminUsersRouter.patch("/:id/restore", async (req, res, next) => {
  try {
    const result = await query("UPDATE teachers SET deleted_at=NULL, is_active=TRUE, updated_at=NOW() WHERE id=$1 RETURNING id, name, username, email, role, is_active, print_student_labels, max_label_reprints, created_at, updated_at", [Number(req.params.id)]);
    if (!result.rowCount) return res.status(404).json({ok:false,status:"not_found"});
    res.json({ok:true,user:publicUser(result.rows[0])});
  } catch (error) { next(error); }
});
