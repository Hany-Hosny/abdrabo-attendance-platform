import express from "express";
import { pool, query } from "../db/pool.js";
import { requirePermission, requireTeacher } from "../middleware/requireTeacher.js";
import { createPublicInquiry } from "./inbox.js";
import { normalizeDigits } from "../utils/normalizeDigits.js";
import { isPhoneNumber } from "../utils/normalizeDigits.js";
import { auditLog } from "../services/audit.js";
import { authenticatedStudent } from "../services/studentAuth.js";
import { createRateLimiter } from "../middleware/rateLimit.js";
import { ipKeyGenerator } from "express-rate-limit";
import { DEFAULT_HOME_CONTENT, LandingPageContentSchema } from "@abdrabo/shared/landingContent.js";

export const siteRouter = express.Router();
export const adminSiteRouter = express.Router();
export const siteContentRouter = express.Router();
const publicContactRateLimit = createRateLimiter({ windowMs: 15 * 60_000, max: 10, key: (req) => `public-contact:${ipKeyGenerator(req.ip || "unknown")}` });

const homeContentCache = {
  value: null,
  updatedAt: null
};

function normalizeHomeContent(value) {
  const source = value && typeof value === "object" ? value : {};
  const arabic = LandingPageContentSchema.safeParse(source.ar);
  const english = LandingPageContentSchema.safeParse(source.en);
  return {
    ar: arabic.success ? arabic.data : DEFAULT_HOME_CONTENT.ar,
    en: english.success ? english.data : DEFAULT_HOME_CONTENT.en
  };
}

function invalidateSiteContentCache(tag) {
  if (tag !== "home") return;
  homeContentCache.value = null;
  homeContentCache.updatedAt = null;
}

async function getHomeContent() {
  if (homeContentCache.value) {
    return { content: homeContentCache.value, updated_at: homeContentCache.updatedAt };
  }
  const result = await query("SELECT content, updated_at FROM site_content WHERE key = 'home' LIMIT 1");
  const content = normalizeHomeContent(result.rows[0]?.content);
  homeContentCache.value = content;
  homeContentCache.updatedAt = result.rows[0]?.updated_at || null;
  return { content, updated_at: homeContentCache.updatedAt };
}

function structuredValidationErrors(error) {
  const fieldErrors = {};
  for (const issue of error.issues || []) {
    const field = issue.path.length ? issue.path.join(".") : "content";
    if (!fieldErrors[field]) fieldErrors[field] = [];
    fieldErrors[field].push(issue.message);
  }
  return { fieldErrors, issues: error.issues || [] };
}

async function saveHomeContent(req, res, next) {
  try {
    if (String(req.query.page || "home") !== "home") return res.status(404).json({ ok: false, status: "not_found" });
    const locale = String(req.body?.locale || "").toLowerCase();
    if (locale !== "ar" && locale !== "en") {
      return res.status(422).json({ ok: false, status: "invalid_locale", fieldErrors: { locale: ["Locale must be ar or en."] } });
    }

    const parsed = await LandingPageContentSchema.safeParseAsync(req.body?.content);
    if (!parsed.success) {
      return res.status(422).json({ ok: false, status: "validation_failed", ...structuredValidationErrors(parsed.error) });
    }

    const client = await pool.connect();
    let saved;
    try {
      await client.query("BEGIN");
      const currentResult = await client.query("SELECT content, updated_at FROM site_content WHERE key = 'home' FOR UPDATE");
      const currentContent = normalizeHomeContent(currentResult.rows[0]?.content);
      const nextContent = { ...currentContent, [locale]: parsed.data };
      const result = await client.query(
        `INSERT INTO site_content (key, content, updated_at)
         VALUES ('home', $1::jsonb, NOW())
         ON CONFLICT (key) DO UPDATE SET content = EXCLUDED.content, updated_at = NOW()
         RETURNING content, updated_at`,
        [JSON.stringify(nextContent)]
      );
      await client.query("COMMIT");
      saved = result.rows[0];
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    invalidateSiteContentCache("home");
    await auditLog({
      action: "site_content_updated",
      actorId: req.teacher.id,
      details: { page: "home", locale },
      request: req
    });
    return res.json({ ok: true, page: "home", content: normalizeHomeContent(saved.content), updated_at: saved.updated_at });
  } catch (error) {
    return next(error);
  }
}

siteContentRouter.get("/", async (req, res, next) => {
  try {
    if (String(req.query.page || "home") !== "home") return res.status(404).json({ ok: false, status: "not_found" });
    const home = await getHomeContent();
    res.set("Cache-Control", "no-store");
    return res.json({ ok: true, page: "home", content: home.content, updated_at: home.updated_at });
  } catch (error) {
    return next(error);
  }
});

siteContentRouter.put("/", requireTeacher, requirePermission("settings.manage"), saveHomeContent);
siteContentRouter.post("/", requireTeacher, requirePermission("settings.manage"), saveHomeContent);

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
