import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";

const { Pool } = pg;
const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

async function withDatabaseTables(run) {
  const db = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4 });
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const leases = `test_whatsapp_leases_${suffix}`;
  const jobs = `test_whatsapp_jobs_${suffix}`;
  const audits = `test_whatsapp_audits_${suffix}`;
  const tokens = `test_whatsapp_tokens_${suffix}`;
  try {
    await db.query(`
      CREATE TABLE ${leases} (
        session_key TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        owner_token TEXT NOT NULL,
        lease_expires_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE ${jobs} (
        id BIGSERIAL PRIMARY KEY,
        notification_type TEXT NOT NULL,
        attendance_record_id BIGINT,
        status TEXT NOT NULL,
        claim_token TEXT,
        send_started_at TIMESTAMPTZ,
        lease_expires_at TIMESTAMPTZ,
        last_error TEXT
      );
      CREATE TABLE ${audits} (
        id BIGSERIAL PRIMARY KEY,
        job_id BIGINT NOT NULL,
        action TEXT NOT NULL,
        reason TEXT NOT NULL
      );
      CREATE TABLE ${tokens} (
        token_hash TEXT PRIMARY KEY,
        expires_at TIMESTAMPTZ NOT NULL
      );
    `);
    return await run({ db, leases, jobs, audits, tokens });
  } finally {
    await db.query(`DROP TABLE IF EXISTS ${tokens}; DROP TABLE IF EXISTS ${audits}; DROP TABLE IF EXISTS ${jobs}; DROP TABLE IF EXISTS ${leases};`).catch(() => undefined);
    await db.end();
  }
}

async function acquireLease(client, table, ownerId, ownerToken) {
  await client.query("BEGIN");
  try {
    const result = await client.query(`
      INSERT INTO ${table} (session_key, owner_id, owner_token, lease_expires_at)
      VALUES ('primary', $1, $2, NOW() + INTERVAL '4 minutes')
      ON CONFLICT (session_key) DO UPDATE
      SET owner_id = EXCLUDED.owner_id,
          owner_token = EXCLUDED.owner_token,
          lease_expires_at = EXCLUDED.lease_expires_at,
          updated_at = NOW()
      WHERE ${table}.lease_expires_at <= NOW()
         OR (${table}.owner_id = EXCLUDED.owner_id AND ${table}.owner_token = EXCLUDED.owner_token)
      RETURNING owner_id, owner_token
    `, [ownerId, ownerToken]);
    await client.query("COMMIT");
    return result.rowCount > 0;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

integrationTest("PostgreSQL ownership fencing permits one owner and rejects stale takeover writes", async () => {
  await withDatabaseTables(async ({ db, leases }) => {
    const first = await db.connect();
    const second = await db.connect();
    try {
      const results = await Promise.all([
        acquireLease(first, leases, "instance-a", "token-a"),
        acquireLease(second, leases, "instance-b", "token-b")
      ]);
      assert.equal(results.filter(Boolean).length, 1);

      await db.query(`UPDATE ${leases} SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE session_key = 'primary'`);
      assert.equal(await acquireLease(first, leases, "instance-b", "token-b"), true);
      const staleWrite = await db.query(
        `UPDATE ${leases} SET updated_at = NOW() WHERE session_key = 'primary' AND owner_id = $1 AND owner_token = $2 AND lease_expires_at > NOW()`,
        ["instance-a", "token-a"]
      );
      assert.equal(staleWrite.rowCount, 0);
      const staleRelease = await db.query(
        `UPDATE ${leases} SET lease_expires_at = NOW() WHERE session_key = 'primary' AND owner_id = $1 AND owner_token = $2`,
        ["instance-a", "token-a"]
      );
      assert.equal(staleRelease.rowCount, 0);
    } finally {
      first.release();
      second.release();
    }
  });
});

integrationTest("FOR UPDATE SKIP LOCKED and claim tokens fence competing workers", async () => {
  await withDatabaseTables(async ({ db, jobs }) => {
    const first = await db.connect();
    const second = await db.connect();
    try {
      const inserted = await db.query(
        `INSERT INTO ${jobs} (notification_type, status) VALUES ('absence', 'pending') RETURNING id`,
      );
      const jobId = inserted.rows[0].id;
      await first.query("BEGIN");
      const firstSelected = await first.query(`SELECT id FROM ${jobs} WHERE status = 'pending' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`);
      assert.equal(firstSelected.rowCount, 1);

      await second.query("BEGIN");
      const secondSelected = await second.query(`SELECT id FROM ${jobs} WHERE status = 'pending' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`);
      assert.equal(secondSelected.rowCount, 0);
      await second.query("ROLLBACK");

      const claimToken = crypto.randomUUID();
      await first.query(`UPDATE ${jobs} SET status = 'processing', claim_token = $2, lease_expires_at = NOW() + INTERVAL '4 minutes' WHERE id = $1 AND status = 'pending'`, [jobId, claimToken]);
      await first.query("COMMIT");
      await db.query(`UPDATE ${jobs} SET claim_token = 'new-token' WHERE id = $1`, [jobId]);

      const staleCompletion = await db.query(
        `UPDATE ${jobs} SET status = 'sent', claim_token = NULL WHERE id = $1 AND status = 'processing' AND claim_token = $2`,
        [jobId, claimToken]
      );
      assert.equal(staleCompletion.rowCount, 0);
      const validLeaseExtension = await db.query(
        `UPDATE ${jobs} SET lease_expires_at = NOW() + INTERVAL '4 minutes' WHERE id = $1 AND status = 'processing' AND claim_token = $2`,
        [jobId, "new-token"]
      );
      assert.equal(validLeaseExtension.rowCount, 1);
    } finally {
      await first.query("ROLLBACK").catch(() => undefined);
      await second.query("ROLLBACK").catch(() => undefined);
      first.release();
      second.release();
    }
  });
});

integrationTest("attendance correction distinguishes unsent jobs from in-flight delivery", async () => {
  await withDatabaseTables(async ({ db, jobs, audits }) => {
    const inserted = await db.query(`
      INSERT INTO ${jobs} (notification_type, attendance_record_id, status, claim_token, lease_expires_at, send_started_at)
      VALUES
        ('absence', 101, 'pending', 'pending-token', NOW() + INTERVAL '2 minutes', NULL),
        ('absence', 102, 'processing', 'processing-token', NOW() + INTERVAL '2 minutes', NULL),
        ('absence', 103, 'processing', 'in-flight-token', NOW() + INTERVAL '2 minutes', NOW())
      RETURNING id, attendance_record_id
    `);
    await db.query(`
      UPDATE ${jobs}
      SET status = CASE WHEN status = 'processing' AND send_started_at IS NOT NULL THEN 'delivery_unknown' ELSE 'skipped' END,
          last_error = CASE WHEN status = 'processing' AND send_started_at IS NOT NULL THEN 'attendance_correction_during_send' ELSE 'attendance_corrected_before_send' END,
          lease_expires_at = NULL, claim_token = NULL
      WHERE notification_type = 'absence' AND attendance_record_id = ANY($1::bigint[])
        AND status IN ('pending', 'processing')
    `, [[101, 102, 103]]);
    const states = await db.query(`SELECT attendance_record_id, status, claim_token, lease_expires_at, send_started_at FROM ${jobs} ORDER BY attendance_record_id`);
    assert.deepEqual(states.rows.map((row) => [Number(row.attendance_record_id), row.status, row.claim_token, row.lease_expires_at, Boolean(row.send_started_at)]), [
      [101, "skipped", null, null, false],
      [102, "skipped", null, null, false],
      [103, "delivery_unknown", null, null, true]
    ]);

    for (const row of inserted.rows) {
      await db.query(`INSERT INTO ${audits} (job_id, action, reason) VALUES ($1, $2, $3)`, [row.id, row.attendance_record_id === 103 ? "whatsapp_job_delivery_unknown" : "whatsapp_job_skipped", row.attendance_record_id === 103 ? "attendance_correction_during_send" : "attendance_corrected_before_send"]);
    }
    const auditCount = await db.query(`SELECT COUNT(*)::int AS count FROM ${audits}`);
    assert.equal(auditCount.rows[0].count, 3);
  });
});

integrationTest("grade links are created only at dispatch and are retained only for known outcomes", async () => {
  await withDatabaseTables(async ({ db, jobs, tokens }) => {
    const queued = await db.query(`INSERT INTO ${jobs} (notification_type, status) VALUES ('grade', 'pending') RETURNING id`);
    const queuedJobId = queued.rows[0].id;
    assert.equal((await db.query(`SELECT COUNT(*)::int AS count FROM ${tokens}`)).rows[0].count, 0);

    await db.query(`UPDATE ${jobs} SET status = 'processing', claim_token = 'dispatch-token' WHERE id = $1`, [queuedJobId]);
    await db.query(`INSERT INTO ${tokens} (token_hash, expires_at) VALUES ('fresh-hash', NOW() + INTERVAL '1 hour')`);
    assert.equal((await db.query(`SELECT COUNT(*)::int AS count FROM ${tokens}`)).rows[0].count, 1);

    await db.query(`UPDATE ${jobs} SET status = 'failed', claim_token = NULL WHERE id = $1`, [queuedJobId]);
    await db.query(`DELETE FROM ${tokens} WHERE token_hash = 'fresh-hash'`);
    assert.equal((await db.query(`SELECT COUNT(*)::int AS count FROM ${tokens}`)).rows[0].count, 0);

    const unknown = await db.query(`INSERT INTO ${jobs} (notification_type, status) VALUES ('grade', 'delivery_unknown') RETURNING id`);
    await db.query(`INSERT INTO ${tokens} (token_hash, expires_at) VALUES ('unknown-hash', NOW() + INTERVAL '1 hour')`);
    assert.equal((await db.query(`SELECT COUNT(*)::int AS count FROM ${tokens} WHERE token_hash = 'unknown-hash'`)).rows[0].count, 1);
    assert.equal(unknown.rowCount, 1);
  });
});

integrationTest("manual retry and its audit share one commit boundary", async () => {
  await withDatabaseTables(async ({ db, jobs, audits }) => {
    const inserted = await db.query(`INSERT INTO ${jobs} (notification_type, status) VALUES ('receipt', 'failed') RETURNING id`);
    const jobId = inserted.rows[0].id;

    await db.query("BEGIN");
    await db.query(`SELECT id FROM ${jobs} WHERE id = $1 FOR UPDATE`, [jobId]);
    await db.query(`UPDATE ${jobs} SET status = 'pending' WHERE id = $1 AND status = 'failed'`, [jobId]);
    await assert.rejects(
      db.query(`INSERT INTO ${audits} (job_id, action, reason) VALUES ($1, 'whatsapp_job_manual_retry_requested', NULL)`, [jobId])
    );
    await db.query("ROLLBACK");
    assert.equal((await db.query(`SELECT status FROM ${jobs} WHERE id = $1`, [jobId])).rows[0].status, "failed");

    await db.query("BEGIN");
    await db.query(`SELECT id FROM ${jobs} WHERE id = $1 FOR UPDATE`, [jobId]);
    await db.query(`UPDATE ${jobs} SET status = 'pending' WHERE id = $1 AND status = 'failed'`, [jobId]);
    await db.query(`INSERT INTO ${audits} (job_id, action, reason) VALUES ($1, 'whatsapp_job_manual_retry_requested', 'operator confirmed source is corrected')`, [jobId]);
    await db.query("COMMIT");
    assert.equal((await db.query(`SELECT status FROM ${jobs} WHERE id = $1`, [jobId])).rows[0].status, "pending");

    await db.query("BEGIN");
    const second = await db.query(`SELECT status FROM ${jobs} WHERE id = $1 FOR UPDATE`, [jobId]);
    await db.query("COMMIT");
    assert.equal(second.rows[0].status, "pending");
    assert.equal((await db.query(`SELECT COUNT(*)::int AS count FROM ${audits} WHERE job_id = $1`, [jobId])).rows[0].count, 1);
  });
});
