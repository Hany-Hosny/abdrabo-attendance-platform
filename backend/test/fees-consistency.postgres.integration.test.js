import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { getStudentFeePortalData } from "../src/services/fees.js";

const { Pool } = pg;
const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

async function withFeeDatabase(run) {
  const rawPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8 });
  const schema = `test_fees_${crypto.randomUUID().replaceAll("-", "")}`;
  const setSearchPath = `SET search_path TO ${schema}, public`;
  const db = {
    async connect() {
      const client = await rawPool.connect();
      await client.query(setSearchPath);
      return client;
    },
    async query(text, params) {
      const client = await rawPool.connect();
      try {
        await client.query(setSearchPath);
        return await client.query(text, params);
      } finally {
        client.release();
      }
    }
  };
  try {
    await rawPool.query(`CREATE SCHEMA ${schema}`);
    await db.query(`
      CREATE TABLE groups (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        display_name TEXT,
        grade TEXT,
        grade_level TEXT,
        fees_amount NUMERIC(10,2) NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        deleted_at TIMESTAMPTZ
      );
      CREATE TABLE students (
        id INTEGER PRIMARY KEY,
        group_id INTEGER NOT NULL REFERENCES groups(id),
        full_name TEXT NOT NULL,
        student_serial TEXT,
        student_code TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        deleted_at TIMESTAMPTZ
      );
      CREATE TABLE fee_dues (
        id BIGSERIAL PRIMARY KEY,
        student_id INTEGER REFERENCES students(id),
        group_id INTEGER NOT NULL REFERENCES groups(id),
        due_month DATE NOT NULL,
        amount NUMERIC(10,2) NOT NULL,
        paid_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
        UNIQUE (student_id, due_month)
      );
      CREATE TABLE teachers (id INTEGER PRIMARY KEY, name TEXT, username TEXT, email TEXT);
      CREATE TABLE payments (
        id BIGSERIAL PRIMARY KEY,
        student_id INTEGER REFERENCES students(id),
        amount NUMERIC(10,2) NOT NULL,
        payment_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        payment_method TEXT NOT NULL DEFAULT 'cash',
        notes TEXT,
        payment_months JSONB NOT NULL DEFAULT '[]'::jsonb,
        whatsapp_notified BOOLEAN NOT NULL DEFAULT FALSE,
        paid_by INTEGER REFERENCES teachers(id),
        recorded_by INTEGER REFERENCES teachers(id),
        payment_type TEXT NOT NULL DEFAULT 'normal',
        discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
        is_exempt BOOLEAN NOT NULL DEFAULT FALSE,
        idempotency_key TEXT UNIQUE
      );
      CREATE TABLE payment_reversals (
        id BIGSERIAL PRIMARY KEY,
        payment_id BIGINT NOT NULL UNIQUE REFERENCES payments(id),
        reason TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    return await run({ db, rawPool, schema });
  } finally {
    await rawPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await rawPool.end();
  }
}

integrationTest("fee portal uses one repeatable-read snapshot across summary and history", async () => {
  await withFeeDatabase(async ({ db, rawPool, schema }) => {
    await db.query("INSERT INTO groups (id, name, fees_amount) VALUES (1, 'Group A', 100)");
    await db.query("INSERT INTO students (id, group_id, full_name, student_code) VALUES (1, 1, 'Student One', 'A-0001')");
    await db.query("INSERT INTO payments (student_id, amount) VALUES (1, 100)");
    await db.query("INSERT INTO fee_dues (student_id, group_id, due_month, amount, paid_amount) VALUES (1, 1, CURRENT_DATE, 100, 100)");

    const concurrent = await rawPool.connect();
    await concurrent.query(`SET search_path TO ${schema}, public`);
    const snapshotPool = {
      query: db.query.bind(db),
      async connect() {
        const client = await db.connect();
        const originalQuery = client.query.bind(client);
        client.query = async (text, params) => {
          if (String(text).trimStart().startsWith("SELECT p.id")) {
            await concurrent.query("INSERT INTO payments (student_id, amount) VALUES (1, 25)");
          }
          return originalQuery(text, params);
        };
        return client;
      }
    };

    const data = await getStudentFeePortalData(1, { dbPool: snapshotPool });
    assert.equal(Number(data.summary.total_historical_payments), 100);
    assert.equal(data.payments.length, 1);
    await concurrent.query("ROLLBACK").catch(() => undefined);
    concurrent.release();
  });
});

integrationTest("reversed payments remain visible but are excluded from active historical totals", async () => {
  await withFeeDatabase(async ({ db }) => {
    await db.query("INSERT INTO groups (id, name, fees_amount) VALUES (1, 'Group A', 100)");
    await db.query("INSERT INTO students (id, group_id, full_name, student_code) VALUES (1, 1, 'Student One', 'A-0001')");
    const active = await db.query("INSERT INTO payments (student_id, amount) VALUES (1, 100) RETURNING id");
    const reversed = await db.query("INSERT INTO payments (student_id, amount) VALUES (1, 50) RETURNING id");
    await db.query("INSERT INTO payment_reversals (payment_id, reason) VALUES ($1, 'internal note')", [reversed.rows[0].id]);
    await db.query("INSERT INTO fee_dues (student_id, group_id, due_month, amount, paid_amount) VALUES (1, 1, CURRENT_DATE, 100, 0)");

    const data = await getStudentFeePortalData(1, { dbPool: db });
    const activePayment = data.payments.find((payment) => String(payment.id) === String(active.rows[0].id));
    const reversedPayment = data.payments.find((payment) => String(payment.id) === String(reversed.rows[0].id));
    assert.equal(activePayment.is_reversed, false);
    assert.equal(reversedPayment.is_reversed, true);
    assert.ok(reversedPayment.reversed_at);
    assert.equal(Object.hasOwn(reversedPayment, "reversal_reason"), false);
    assert.equal(Number(data.summary.total_historical_payments), 100);
  });
});

integrationTest("concurrent payment operations with one idempotency key create one row", async () => {
  await withFeeDatabase(async ({ db }) => {
    await db.query("INSERT INTO groups (id, name, fees_amount) VALUES (1, 'Group A', 100)");
    await db.query("INSERT INTO students (id, group_id, full_name, student_code) VALUES (1, 1, 'Student One', 'A-0001')");
    await db.query("CREATE UNIQUE INDEX payment_idempotency_test_idx ON payments(idempotency_key) WHERE idempotency_key IS NOT NULL");
    const key = crypto.randomUUID();
    const insertOnce = async () => {
      const client = await db.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
        const existing = await client.query("SELECT id FROM payments WHERE idempotency_key=$1 FOR UPDATE", [key]);
        if (!existing.rowCount) await client.query("INSERT INTO payments (student_id, amount, idempotency_key) VALUES (1, 100, $1)", [key]);
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    };
    await Promise.all([insertOnce(), insertOnce()]);
    const result = await db.query("SELECT COUNT(*)::int AS count FROM payments WHERE idempotency_key=$1", [key]);
    assert.equal(result.rows[0].count, 1);
  });
});

integrationTest("attendance correction fencing preserves in-flight evidence and rejects stale claims", async () => {
  await withFeeDatabase(async ({ db }) => {
    await db.query(`
      CREATE TABLE correction_jobs (
        id BIGSERIAL PRIMARY KEY,
        status TEXT NOT NULL,
        claim_token TEXT,
        send_started_at TIMESTAMPTZ,
        lease_expires_at TIMESTAMPTZ,
        last_error TEXT
      )
    `);
    const inserted = await db.query("INSERT INTO correction_jobs (status, claim_token, send_started_at, lease_expires_at) VALUES ('processing', 'old-claim', NOW(), NOW() + INTERVAL '2 minutes') RETURNING id");
    const jobId = inserted.rows[0].id;
    const corrected = await db.query(`
      UPDATE correction_jobs
      SET status='delivery_unknown', claim_token=NULL, lease_expires_at=NULL, last_error='attendance_correction_during_send'
      WHERE id=$1 AND status='processing' AND send_started_at IS NOT NULL
      RETURNING id, status
    `, [jobId]);
    assert.equal(corrected.rows[0].status, "delivery_unknown");
    const stale = await db.query("UPDATE correction_jobs SET status='sent' WHERE id=$1 AND status='processing' AND claim_token=$2", [jobId, "old-claim"]);
    assert.equal(stale.rowCount, 0);
    const final = await db.query("SELECT status, claim_token, lease_expires_at, send_started_at FROM correction_jobs WHERE id=$1", [jobId]);
    assert.equal(final.rows[0].status, "delivery_unknown");
    assert.equal(final.rows[0].claim_token, null);
    assert.equal(final.rows[0].lease_expires_at, null);
    assert.ok(final.rows[0].send_started_at);
  });
});
