import express from "express";
import { query } from "../db/pool.js";
import { requireAdmin } from "../middleware/requireTeacher.js";
import { createPublicInquiry } from "./inbox.js";
import { normalizeDigits } from "../utils/normalizeDigits.js";
import { isPhoneNumber } from "../utils/normalizeDigits.js";

export const siteRouter = express.Router();
export const adminSiteRouter = express.Router();

siteRouter.post("/contact", async (req, res, next) => {
  try {
    const name = String(req.body?.name || "").trim();
    const phone = normalizeDigits(req.body?.phone || "").trim();
    const body = String(req.body?.message || "").trim();
    const requestedStudentId = req.body?.student_id ? Number(req.body.student_id) : null;
    const studentCode = normalizeDigits(req.headers["x-student-code"] || "").trim().toUpperCase();
    const studentCheck = requestedStudentId && studentCode
      ? await query("SELECT 1 FROM students WHERE id=$1 AND is_active=TRUE AND deleted_at IS NULL AND (student_code=$2 OR student_serial=$2)", [requestedStudentId, studentCode])
      : { rowCount: 0 };
    const studentId = studentCheck.rowCount ? requestedStudentId : null;
    if (!name || !phone || !body) return res.status(400).json({ ok: false, status: "invalid_contact" });
    if (!isPhoneNumber(phone)) return res.status(400).json({ ok: false, status: "invalid_phone", message: "يجب إدخال ١١ رقمًا لرقم الهاتف. / Phone number must contain exactly 11 digits." });
    const result = await createPublicInquiry({ studentId: Number.isFinite(studentId) ? studentId : null, name, phone, subject: "Public inquiry", body });
    res.status(201).json({ ok: true, thread_id: result.thread.id });
  } catch (error) { next(error); }
});

siteRouter.get("/pages/:slug", async (req, res, next) => {
  try {
    const result = await query(
      `
        SELECT slug, title_ar, title_en, subtitle_ar, subtitle_en, content_ar, content_en, updated_at
        FROM site_pages
        WHERE slug = $1
        LIMIT 1
      `,
      [req.params.slug]
    );

    if (!result.rowCount) {
      return res.status(404).json({ ok: false, status: "not_found" });
    }

    return res.json({ ok: true, page: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

adminSiteRouter.put("/pages/:slug", requireAdmin, async (req, res, next) => {
  try {
    const allowedSlugs = ["about-teacher", "about-center", "contact", "tips"];
    if (!allowedSlugs.includes(req.params.slug)) {
      return res.status(404).json({ ok: false, status: "not_found" });
    }

    const {
      title_ar,
      title_en,
      subtitle_ar,
      subtitle_en,
      content_ar = {},
      content_en = {}
    } = req.body || {};

    if (!title_ar || !title_en || !subtitle_ar || !subtitle_en) {
      return res.status(400).json({ ok: false, status: "missing_fields" });
    }

    const result = await query(
      `
        INSERT INTO site_pages (
          slug,
          title_ar,
          title_en,
          subtitle_ar,
          subtitle_en,
          content_ar,
          content_en,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, NOW())
        ON CONFLICT (slug) DO UPDATE SET
          title_ar = EXCLUDED.title_ar,
          title_en = EXCLUDED.title_en,
          subtitle_ar = EXCLUDED.subtitle_ar,
          subtitle_en = EXCLUDED.subtitle_en,
          content_ar = EXCLUDED.content_ar,
          content_en = EXCLUDED.content_en,
          updated_at = NOW()
        RETURNING slug, title_ar, title_en, subtitle_ar, subtitle_en, content_ar, content_en, updated_at
      `,
      [
        req.params.slug,
        title_ar,
        title_en,
        subtitle_ar,
        subtitle_en,
        JSON.stringify(content_ar),
        JSON.stringify(content_en)
      ]
    );

    return res.json({ ok: true, page: result.rows[0] });
  } catch (error) {
    next(error);
  }
});
