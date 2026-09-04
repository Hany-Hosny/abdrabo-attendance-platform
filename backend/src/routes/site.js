import express from "express";
import { query } from "../db/pool.js";
import { requirePermission, requireTeacher } from "../middleware/requireTeacher.js";
import { createPublicInquiry } from "./inbox.js";
import { normalizeDigits } from "../utils/normalizeDigits.js";
import { isPhoneNumber } from "../utils/normalizeDigits.js";
import { auditLog } from "../services/audit.js";
import { authenticatedStudent } from "../services/studentAuth.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { ipKeyGenerator } from "express-rate-limit";

export const siteRouter = express.Router();
export const adminSiteRouter = express.Router();
const publicContactRateLimit = createRateLimiter({ windowMs: 15 * 60_000, max: 10, key: (req) => `public-contact:${ipKeyGenerator(req.ip || "unknown")}` });

siteRouter.post("/contact", publicContactRateLimit, async (req, res, next) => {
  try {
    const name = String(req.body?.name || "").trim();
    const phone = normalizeDigits(req.body?.phone || "").trim();
    const body = String(req.body?.message || "").trim();
    const requestedStudentId = req.body?.student_id ? Number(req.body.student_id) : null;
    const student = requestedStudentId ? await authenticatedStudent(req) : null;
    const studentId = student && Number(student.id) === requestedStudentId ? requestedStudentId : null;
    if (!name || !phone || !body) return res.status(400).json({ ok: false, status: "invalid_contact" });
    if (!isPhoneNumber(phone)) return res.status(400).json({ ok: false, status: "invalid_phone", message: "يجب إدخال ١١ رقمًا لرقم الهاتف. / Phone number must contain exactly 11 digits." });
    const result = await createPublicInquiry({ studentId: Number.isFinite(studentId) ? studentId : null, name, phone, subject: "Public inquiry", body, request: req });
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

adminSiteRouter.put("/pages/:slug", requireTeacher, requirePermission("settings.manage"), async (req, res, next) => {
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

    const before = await query("SELECT slug, title_ar, title_en, subtitle_ar, subtitle_en, content_ar, content_en FROM site_pages WHERE slug=$1", [req.params.slug]);
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

    await auditLog({ action: "site_page_updated", actorId: req.teacher.id, details: { page_slug: req.params.slug, before: before.rows[0] || null, after: result.rows[0] }, request: req });
    return res.json({ ok: true, page: result.rows[0] });
  } catch (error) {
    next(error);
  }
});
