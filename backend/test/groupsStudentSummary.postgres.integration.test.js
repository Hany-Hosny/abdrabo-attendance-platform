import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { getGroupsStudentSummary } from "../src/routes/adminAcademic.js";

const { Pool } = pg;
const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

async function withStudentSummaryDatabase(run) {
  const rawPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
  const schema = `test_groups_summary_${crypto.randomUUID().replaceAll("-", "")}`;
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
      CREATE TABLE students (
        id SERIAL PRIMARY KEY,
        group_id INTEGER NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        deleted_at TIMESTAMPTZ
      )
    `);
    return await run(db);
  } finally {
    await rawPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await rawPool.end();
  }
}

integrationTest("Groups student summary follows active, disabled, and soft-delete semantics", async () => {
  await withStudentSummaryDatabase(async (db) => {
    const owner = { role: "owner" };
    assert.deepEqual(await getGroupsStudentSummary(owner, db.query.bind(db)), { total: 0, active: 0, disabled: 0, deleted: 0 });

    await db.query("INSERT INTO students (group_id, is_active) VALUES (1, TRUE)");
    assert.deepEqual(await getGroupsStudentSummary(owner, db.query.bind(db)), { total: 1, active: 1, disabled: 0, deleted: 0 });

    await db.query("INSERT INTO students (group_id, is_active) VALUES (1, FALSE), (1, TRUE), (2, TRUE)");
    await db.query("INSERT INTO students (group_id, is_active, deleted_at) VALUES (1, TRUE, NOW()), (2, FALSE, NOW())");

    assert.deepEqual(await getGroupsStudentSummary(owner, db.query.bind(db)), { total: 4, active: 3, disabled: 1, deleted: 2 });
    assert.deepEqual(await getGroupsStudentSummary({ role: "teacher", group_ids: [1] }, db.query.bind(db)), { total: 3, active: 2, disabled: 1, deleted: 1 });

    const groupCounts = await db.query(`
      SELECT group_id, COUNT(*)::int AS current_students
      FROM students
      WHERE deleted_at IS NULL
      GROUP BY group_id
      ORDER BY group_id
    `);
    assert.deepEqual(groupCounts.rows, [{ group_id: 1, current_students: 3 }, { group_id: 2, current_students: 1 }]);
  });
});
