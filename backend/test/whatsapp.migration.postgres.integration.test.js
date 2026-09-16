import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const execFileAsync = promisify(execFile);
const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

function databaseUrl(database) {
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

async function runMigration(url) {
  await execFileAsync("node", ["src/db/migrate.js"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, NODE_ENV: "test", DATABASE_URL: url },
    maxBuffer: 2 * 1024 * 1024
  });
}

integrationTest("gender template migration is repeatable and preserves neutral legacy rows", async () => {
  const database = `abdrabo_migration_${crypto.randomUUID().replaceAll("-", "")}`;
  const adminUrl = databaseUrl("postgres");
  const targetUrl = databaseUrl(database);
  const admin = new Pool({ connectionString: adminUrl, max: 2 });
  let db;
  try {
    await admin.query(`CREATE DATABASE ${database}`);
    await runMigration(targetUrl);
    db = new Pool({ connectionString: targetUrl, max: 4 });
    const firstCounts = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE is_fallback = FALSE AND slot_key IS NOT NULL)::int AS regular_count,
        COUNT(*) FILTER (WHERE is_fallback = TRUE)::int AS fallback_count,
        COUNT(*) FILTER (WHERE slot_key IS NULL AND is_fallback = FALSE)::int AS unassigned_count
      FROM whatsapp_templates
    `);
    assert.deepEqual(firstCounts.rows[0], { regular_count: 40, fallback_count: 5, unassigned_count: 1 });
    const catalogueByCategory = await db.query(`
      SELECT category,
        COUNT(*) FILTER (WHERE is_fallback = FALSE AND slot_key IS NOT NULL)::int AS regular_count,
        COUNT(*) FILTER (WHERE is_fallback = TRUE)::int AS fallback_count,
        ARRAY(
          SELECT slot_number
          FROM whatsapp_templates slots
          WHERE slots.category = templates.category
            AND slots.audience IN ('male', 'female')
            AND slots.is_fallback = FALSE
            AND slots.slot_key IS NOT NULL
          ORDER BY audience, slot_number
        ) AS slots
      FROM whatsapp_templates templates
      GROUP BY category
      ORDER BY category
    `);
    assert.deepEqual(catalogueByCategory.rows, [
      { category: "absence", regular_count: 8, fallback_count: 1, slots: [1, 2, 3, 4, 1, 2, 3, 4] },
      { category: "advance_payment", regular_count: 8, fallback_count: 1, slots: [1, 2, 3, 4, 1, 2, 3, 4] },
      { category: "attendance", regular_count: 8, fallback_count: 1, slots: [1, 2, 3, 4, 1, 2, 3, 4] },
      { category: "grade", regular_count: 8, fallback_count: 1, slots: [1, 2, 3, 4, 1, 2, 3, 4] },
      { category: "receipt", regular_count: 8, fallback_count: 1, slots: [1, 2, 3, 4, 1, 2, 3, 4] }
    ]);

    await db.query(`
      INSERT INTO whatsapp_templates (category, message_body, audience, is_fallback, content_version)
      VALUES
        ('absence', 'رسالة الطالبة {student_name} في {group_name} بتاريخ {date}', 'neutral', FALSE, 1),
        ('absence', 'رسالة متابعة {student_name} في {group_name} بتاريخ {date}', 'neutral', FALSE, 1)
    `);
    await runMigration(targetUrl);
    const secondCounts = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE is_fallback = FALSE AND slot_key IS NOT NULL)::int AS regular_count,
        COUNT(*) FILTER (WHERE is_fallback = TRUE)::int AS fallback_count,
        COUNT(*) FILTER (WHERE slot_key IS NULL AND is_fallback = FALSE)::int AS unassigned_count,
        COUNT(*) FILTER (WHERE audience = 'male' AND message_body LIKE '%الطالبة%')::int AS female_in_male_count
      FROM whatsapp_templates
    `);
    assert.deepEqual(secondCounts.rows[0], { regular_count: 40, fallback_count: 5, unassigned_count: 3, female_in_male_count: 0 });

    const duplicateCheck = await db.query(`
      SELECT category, message_body, COUNT(*)::int AS count
      FROM whatsapp_templates
      GROUP BY category, message_body
      HAVING COUNT(*) > 1
    `);
    assert.equal(duplicateCheck.rowCount, 0);
    const classifier = await db.query(`
      SELECT
        'الطالبة {student_name}' ~ 'الطالب(?![ء-ي])' AS female_matches_male,
        'الطالب {student_name}' ~ 'الطالب(?![ء-ي])' AS male_matches_male
    `);
    assert.deepEqual(classifier.rows[0], { female_matches_male: false, male_matches_male: true });
    const rotations = await db.query("SELECT COUNT(*)::int AS count FROM whatsapp_template_rotation_state");
    assert.equal(rotations.rows[0].count, 10);
  } finally {
    await db?.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
  }
});
