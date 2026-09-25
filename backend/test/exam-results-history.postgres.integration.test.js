import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { parseOptionalMaxScorePercentage } from "../src/routes/adminAcademic.js";

const { Pool } = pg;
const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

test("missing max score percentage does not become a zero filter", () => {
  assert.equal(parseOptionalMaxScorePercentage(undefined), null);
  assert.equal(parseOptionalMaxScorePercentage(""), null);
  assert.equal(parseOptionalMaxScorePercentage("70"), 70);
  assert.equal(parseOptionalMaxScorePercentage("٧٠"), 70);
  assert.equal(parseOptionalMaxScorePercentage("101"), null);
});

integrationTest("saved exam result is returned by exam results history", async () => {
  const rawPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
  const schema = `test_exam_results_history_${crypto.randomUUID().replaceAll("-", "")}`;
  const searchPath = `SET search_path TO ${schema}, public`;
  const db = {
    async query(sql, params) {
      const client = await rawPool.connect();
      try {
        await client.query(searchPath);
        return await client.query(sql, params);
      } finally {
        client.release();
      }
    }
  };

  try {
    await rawPool.query(`CREATE SCHEMA ${schema}`);
    await db.query(`
      CREATE TABLE groups (id SERIAL PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE students (
        id SERIAL PRIMARY KEY,
        group_id INTEGER NOT NULL REFERENCES groups(id),
        full_name TEXT NOT NULL,
        student_code TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        deleted_at TIMESTAMPTZ
      );
      CREATE TABLE exams (
        id SERIAL PRIMARY KEY,
        group_id INTEGER NOT NULL REFERENCES groups(id),
        title TEXT NOT NULL,
        max_score NUMERIC(6, 2) NOT NULL,
        exam_date DATE NOT NULL
      );
      CREATE TABLE exam_results (
        id SERIAL PRIMARY KEY,
        exam_id INTEGER NOT NULL REFERENCES exams(id),
        student_id INTEGER NOT NULL REFERENCES students(id),
        score NUMERIC(6, 2) NOT NULL,
        note TEXT,
        whatsapp_notified BOOLEAN NOT NULL DEFAULT FALSE,
        UNIQUE (exam_id, student_id)
      );
      CREATE TABLE whatsapp_notification_jobs (
        id BIGSERIAL PRIMARY KEY,
        notification_type TEXT NOT NULL,
        source_id BIGINT,
        status TEXT NOT NULL,
        provider_message_id TEXT
      );
    `);

    const group = await db.query("INSERT INTO groups (name) VALUES ('QA Group') RETURNING id");
    const student = await db.query(
      "INSERT INTO students (group_id, full_name, student_code) VALUES ($1, 'Hany Hosny', 'A-2002') RETURNING id",
      [group.rows[0].id]
    );
    const exam = await db.query(
      "INSERT INTO exams (group_id, title, max_score, exam_date) VALUES ($1, 'Weekly Exam', 10, '2026-09-25') RETURNING id",
      [group.rows[0].id]
    );

    const saved = await db.query(`
      INSERT INTO exam_results (exam_id, student_id, score, note)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (exam_id, student_id)
      DO UPDATE SET score = EXCLUDED.score, note = EXCLUDED.note
      RETURNING id`, [exam.rows[0].id, student.rows[0].id, 7, "Good progress"]);
    await db.query(
      "INSERT INTO whatsapp_notification_jobs (notification_type, source_id, status, provider_message_id) VALUES ('grade', $1, 'pending', 'qa-provider-id')",
      [saved.rows[0].id]
    );

    const history = await db.query(`
      SELECT er.id, er.student_id, s.full_name, s.student_code,
             e.id AS exam_id, e.title, e.exam_date, e.max_score,
             er.score, er.note, grade_job.source_id AS whatsapp_source_id,
             grade_job.status AS whatsapp_status
      FROM exam_results er
      JOIN exams e ON e.id = er.exam_id
      JOIN students s ON s.id = er.student_id
      JOIN groups g ON g.id = s.group_id
      LEFT JOIN LATERAL (
        SELECT j.source_id, j.status
        FROM whatsapp_notification_jobs j
        WHERE j.notification_type = 'grade' AND j.source_id = er.id
        ORDER BY j.id DESC
        LIMIT 1
      ) grade_job ON TRUE
      WHERE s.deleted_at IS NULL AND s.is_active = TRUE
        AND er.id = $1`, [saved.rows[0].id]);

    assert.equal(history.rowCount, 1);
    assert.equal(history.rows[0].id, saved.rows[0].id);
    assert.equal(history.rows[0].student_code, "A-2002");
    assert.equal(Number(history.rows[0].score), 7);
    assert.equal(Number(history.rows[0].max_score), 10);
    assert.equal(history.rows[0].note, "Good progress");
    assert.equal(Number(history.rows[0].whatsapp_source_id), saved.rows[0].id);
    assert.equal(history.rows[0].whatsapp_status, "pending");
  } finally {
    await rawPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await rawPool.end();
  }
});
