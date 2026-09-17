import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { reversePayment } from "../src/services/fees.js";
import { markSendStarted, revalidateWhatsAppJob, settlePaymentNotificationJobsForReversal } from "../src/services/whatsapp.js";

const { Pool } = pg;
const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;
const owner = { id: 9, role: "owner", group_ids: [] };

async function withDatabase(run) {
  const rawPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 12 });
  const schema = `test_payment_reversal_${crypto.randomUUID().replaceAll("-", "")}`;
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
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, display_name TEXT, grade TEXT,
        grade_level TEXT, is_active BOOLEAN NOT NULL DEFAULT TRUE, deleted_at TIMESTAMPTZ
      );
      CREATE TABLE students (
        id INTEGER PRIMARY KEY, group_id INTEGER NOT NULL, full_name TEXT NOT NULL,
        student_code TEXT, student_serial TEXT, scan_serial TEXT, guardian_phone TEXT,
        gender TEXT, is_active BOOLEAN NOT NULL DEFAULT TRUE, deleted_at TIMESTAMPTZ,
        whatsapp_opted_out BOOLEAN NOT NULL DEFAULT FALSE
      );
      CREATE TABLE payments (
        id BIGSERIAL PRIMARY KEY, student_id INTEGER, group_id INTEGER NOT NULL,
        amount NUMERIC(10,2) NOT NULL, paid_amount NUMERIC(10,2) NOT NULL,
        discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0, is_exempt BOOLEAN NOT NULL DEFAULT FALSE,
        payment_date TIMESTAMPTZ NOT NULL DEFAULT NOW(), paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        payment_method TEXT NOT NULL DEFAULT 'cash', payment_type TEXT NOT NULL DEFAULT 'normal',
        payment_months JSONB NOT NULL DEFAULT '[]'::jsonb, student_name_snapshot TEXT,
        student_code_snapshot TEXT, student_serial_snapshot TEXT, scan_serial_snapshot TEXT,
        group_name_snapshot TEXT, grade_level_snapshot TEXT, payment_reference TEXT
      );
      CREATE TABLE fee_dues (
        id BIGSERIAL PRIMARY KEY, student_id INTEGER, group_id INTEGER NOT NULL,
        due_month DATE NOT NULL, amount NUMERIC(10,2) NOT NULL, paid_amount NUMERIC(10,2) NOT NULL
      );
      CREATE TABLE payment_reversals (
        id BIGSERIAL PRIMARY KEY, payment_id BIGINT NOT NULL UNIQUE, reversed_by INTEGER,
        reason TEXT NOT NULL, original_amount NUMERIC(10,2) NOT NULL,
        covered_amount NUMERIC(10,2), discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
        exemption_amount NUMERIC(10,2) NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE payment_reversal_idempotency (
        idempotency_key TEXT PRIMARY KEY, payment_id BIGINT NOT NULL,
        request_fingerprint TEXT NOT NULL, reversal_id BIGINT, response JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE audit_logs (
        id BIGSERIAL PRIMARY KEY, action TEXT NOT NULL, actor_id INTEGER, student_id INTEGER,
        payment_id BIGINT, session_id INTEGER, details JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE whatsapp_notification_jobs (
        id BIGSERIAL PRIMARY KEY, notification_type TEXT NOT NULL, source_id BIGINT, student_id INTEGER,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 1, claim_token TEXT, send_started_at TIMESTAMPTZ,
        next_attempt_at TIMESTAMPTZ, lease_expires_at TIMESTAMPTZ, last_error TEXT,
        template_id BIGINT, template_version INTEGER, template_category TEXT,
        template_audience TEXT, template_slot_number INTEGER, template_body_snapshot TEXT,
        template_gender TEXT, template_index INTEGER, template_text TEXT, rendered_message TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await run({ db, rawPool, schema });
  } finally {
    await rawPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
    await rawPool.end();
  }
}

async function seedCase(db, { amount = 100, paidAmount = amount, discountAmount = 0, isExempt = false, paymentType = "normal", months = [{ month: "2026-10-01", amount }], dueMonths = months.map((item) => item.month), duePaidAmount = amount } = {}) {
  await db.query("INSERT INTO groups (id, name, display_name, grade, grade_level) VALUES (1, 'Group A', 'Group A', 'Prep 1', 'Prep 1')");
  await db.query("INSERT INTO students (id, group_id, full_name, student_code, student_serial, scan_serial, guardian_phone, gender) VALUES (1, 1, 'Student One', 'A-0001', 'S-0001', 'Q-0001', '01012345678', 'male')");
  for (const month of dueMonths) {
    const dueItem = months.find((item) => item.month === month);
    await db.query("INSERT INTO fee_dues (student_id, group_id, due_month, amount, paid_amount) VALUES (1, 1, $1::date, $2, $2)", [month, dueItem?.amount || amount]);
  }
  const result = await db.query(
    `INSERT INTO payments (student_id, group_id, amount, paid_amount, discount_amount, is_exempt, payment_type, payment_months)
     VALUES (1, 1, $1, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
    [amount, paidAmount, discountAmount, isExempt, paymentType, JSON.stringify(months)]
  );
  if (duePaidAmount !== amount) await db.query("UPDATE fee_dues SET paid_amount = $1 WHERE student_id = 1", [duePaidAmount]);
  return Number(result.rows[0].id);
}

async function reverse(db, paymentId, key, reason = "operator correction") {
  return reversePayment({ paymentId, actorId: owner.id, reason, user: owner, idempotencyKey: key, dbPool: db });
}

async function assertNoFinancialChange(db, paymentId, expectedPaid) {
  assert.equal((await db.query("SELECT COUNT(*)::int AS count FROM payment_reversals WHERE payment_id = $1", [paymentId])).rows[0].count, 0);
  const due = await db.query("SELECT paid_amount FROM fee_dues WHERE student_id = 1 ORDER BY id LIMIT 1");
  if (expectedPaid === null) assert.equal(due.rowCount, 0);
  else assert.equal(Number(due.rows[0].paid_amount), expectedPaid);
}

integrationTest("normal payment reversal restores the exact due and writes a mandatory audit", async () => {
  await withDatabase(async ({ db }) => {
    const paymentId = await seedCase(db);
    const result = await reverse(db, paymentId, crypto.randomUUID());
    assert.equal(Number(result.reversal.original_amount), 100);
    assert.equal(Number(result.reversal.covered_amount), 100);
    assert.equal(Number((await db.query("SELECT paid_amount FROM fee_dues WHERE id = 1")).rows[0].paid_amount), 0);
    assert.equal((await db.query("SELECT COUNT(*)::int AS count FROM audit_logs WHERE action = 'payment_reversed'")).rows[0].count, 1);
  });
});

integrationTest("discounted payment reversal preserves net cash, gross covered, and discount", async () => {
  await withDatabase(async ({ db }) => {
    const paymentId = await seedCase(db, { amount: 90, discountAmount: 10, months: [{ month: "2026-10-01", amount: 100 }] });
    const result = await reverse(db, paymentId, crypto.randomUUID());
    assert.deepEqual([Number(result.reversal.original_amount), Number(result.reversal.covered_amount), Number(result.reversal.discount_amount)], [90, 100, 10]);
  });
});

integrationTest("exempt payment reversal restores covered dues with zero cash", async () => {
  await withDatabase(async ({ db }) => {
    const paymentId = await seedCase(db, { amount: 0, paidAmount: 0, discountAmount: 100, isExempt: true, months: [{ month: "2026-10-01", amount: 100 }] });
    const result = await reverse(db, paymentId, crypto.randomUUID());
    assert.equal(Number(result.reversal.original_amount), 0);
    assert.equal(Number(result.reversal.covered_amount), 100);
    assert.equal(Number(result.reversal.exemption_amount), 100);
  });
});

integrationTest("advance payment reversal restores every selected month", async () => {
  await withDatabase(async ({ db }) => {
    const months = [{ month: "2026-10-01", amount: 100 }, { month: "2026-11-01", amount: 100 }];
    const paymentId = await seedCase(db, { amount: 200, paymentType: "advance", months });
    await reverse(db, paymentId, crypto.randomUUID());
    const dues = await db.query("SELECT paid_amount FROM fee_dues ORDER BY due_month");
    assert.deepEqual(dues.rows.map((row) => Number(row.paid_amount)), [0, 0]);
  });
});

for (const [name, mutate, expected] of [
  ["malformed payment_months", async (db, id) => db.query("UPDATE payments SET payment_months = '{\"month\":\"2026-10-01\"}'::jsonb WHERE id = $1", [id]), "payment_history_incomplete"],
  ["missing fee-due row", async (db) => db.query("DELETE FROM fee_dues WHERE id = 1"), "fee_due_not_found"],
  ["duplicate month entries", async (db, id) => db.query("UPDATE payments SET payment_months = $2::jsonb WHERE id = $1", [id, JSON.stringify([{ month: "2026-10-01", amount: 50 }, { month: "2026-10-01", amount: 50 }])]), "duplicate_payment_month"],
  ["incorrect covered total", async (db, id) => db.query("UPDATE payments SET payment_months = $2::jsonb WHERE id = $1", [id, JSON.stringify([{ month: "2026-10-01", amount: 90 }])]), "covered_total_mismatch"],
  ["fee-due with insufficient paid balance", async (db) => db.query("UPDATE fee_dues SET paid_amount = 50 WHERE id = 1"), "fee_due_insufficient_paid"],
  ["deleted student", async (db) => db.query("UPDATE students SET deleted_at = NOW() WHERE id = 1"), "payment_student_missing"],
  ["detached student", async (db) => db.query("UPDATE students SET group_id = 2 WHERE id = 1"), "payment_student_group_mismatch"]
]) {
  integrationTest(`reversal rejects ${name} and rolls back`, async () => {
    await withDatabase(async ({ db }) => {
      const paymentId = await seedCase(db);
      await mutate(db, paymentId);
      await assert.rejects(() => reverse(db, paymentId, crypto.randomUUID()), (error) => error.code === expected);
      await assertNoFinancialChange(db, paymentId, name === "missing fee-due row" ? null : name === "fee-due with insufficient paid balance" ? 50 : 100);
    });
  });
}

integrationTest("audit insertion failure rolls back reversal and fee restoration", async () => {
  await withDatabase(async ({ db }) => {
    const paymentId = await seedCase(db);
    const failingPool = {
      connect: async () => {
        const client = await db.connect();
        const originalQuery = client.query.bind(client);
        client.query = (text, params, callback) => {
          if (String(text).includes("INSERT INTO audit_logs")) {
            const error = Object.assign(new Error("audit failure"), { code: "audit_failure" });
            if (typeof callback === "function") {
              callback(error);
              return undefined;
            }
            return Promise.reject(error);
          }
          return originalQuery(text, params, callback);
        };
        return client;
      }
    };
    await assert.rejects(() => reversePayment({ paymentId, actorId: owner.id, reason: "audit failure test", user: owner, idempotencyKey: crypto.randomUUID(), dbPool: failingPool }), (error) => error.code === "reversal_audit_log_failed");
    await assertNoFinancialChange(db, paymentId, 100);
  });
});

integrationTest("same reversal idempotency key replays exactly one committed result", async () => {
  await withDatabase(async ({ db }) => {
    const paymentId = await seedCase(db);
    const key = crypto.randomUUID();
    const first = await reverse(db, paymentId, key);
    const second = await reverse(db, paymentId, key);
    assert.equal(second.replayed, true);
    assert.equal(Number(second.reversal.id), Number(first.reversal.id));
    assert.equal((await db.query("SELECT COUNT(*)::int AS count FROM payment_reversals")).rows[0].count, 1);
  });
});

integrationTest("same reversal idempotency key with a different reason conflicts", async () => {
  await withDatabase(async ({ db }) => {
    const paymentId = await seedCase(db);
    const key = crypto.randomUUID();
    await reverse(db, paymentId, key, "first reason");
    await assert.rejects(() => reverse(db, paymentId, key, "different reason"), (error) => error.code === "idempotency_conflict");
  });
});

integrationTest("different keys racing still create one reversal", async () => {
  await withDatabase(async ({ db }) => {
    const paymentId = await seedCase(db);
    const results = await Promise.all([reverse(db, paymentId, crypto.randomUUID()), reverse(db, paymentId, crypto.randomUUID())]);
    assert.equal(results.filter((result) => result.alreadyReversed !== true).length, 1);
    assert.equal((await db.query("SELECT COUNT(*)::int AS count FROM payment_reversals")).rows[0].count, 1);
  });
});

integrationTest("two concurrent requests with the same key create one reversal and replay the result", async () => {
  await withDatabase(async ({ db }) => {
    const paymentId = await seedCase(db);
    const key = crypto.randomUUID();
    const results = await Promise.all([reverse(db, paymentId, key), reverse(db, paymentId, key)]);
    assert.equal(results.every((result) => result.reversal), true);
    assert.equal(results.filter((result) => result.replayed).length, 1);
    assert.equal((await db.query("SELECT COUNT(*)::int AS count FROM payment_reversals")).rows[0].count, 1);
  });
});

integrationTest("admin history retains reversed rows while active totals exclude them", async () => {
  await withDatabase(async ({ db }) => {
    const paymentId = await seedCase(db);
    await reverse(db, paymentId, crypto.randomUUID());
    const history = await db.query("SELECT p.id, pr.id AS reversal_id FROM payments p LEFT JOIN payment_reversals pr ON pr.payment_id = p.id");
    assert.equal(history.rowCount, 1);
    assert.ok(history.rows[0].reversal_id);
    assert.equal(Number((await db.query("SELECT COALESCE(SUM(p.amount) FILTER (WHERE pr.id IS NULL), 0) AS total FROM payments p LEFT JOIN payment_reversals pr ON pr.payment_id = p.id")).rows[0].total), 0);
  });
});

integrationTest("dashboard totals exclude a committed reversal", async () => {
  await withDatabase(async ({ db }) => {
    const paymentId = await seedCase(db);
    await reverse(db, paymentId, crypto.randomUUID());
    const totals = await db.query(`
      SELECT COALESCE(SUM(p.amount) FILTER (WHERE NOT EXISTS (
        SELECT 1 FROM payment_reversals pr WHERE pr.payment_id = p.id
      )), 0) AS active_income
      FROM payments p
    `);
    assert.equal(Number(totals.rows[0].active_income), 0);
  });
});

integrationTest("a new payment after reversal can be committed and reversed independently", async () => {
  await withDatabase(async ({ db }) => {
    const firstPayment = await seedCase(db);
    await reverse(db, firstPayment, crypto.randomUUID());
    const secondPayment = await db.query("INSERT INTO payments (student_id, group_id, amount, paid_amount, payment_months) VALUES (1, 1, 100, 100, $1::jsonb) RETURNING id", [JSON.stringify([{ month: "2026-10-01", amount: 100 }])]);
    await db.query("UPDATE fee_dues SET paid_amount = 100 WHERE id = 1");
    const result = await reverse(db, Number(secondPayment.rows[0].id), crypto.randomUUID(), "new payment correction");
    assert.equal(Number(result.reversal.covered_amount), 100);
  });
});

integrationTest("pending, processing-before-send, processing-after-send, and sent receipt jobs fence correctly", async () => {
  await withDatabase(async ({ db }) => {
    const paymentId = await seedCase(db);
    await db.query(`INSERT INTO whatsapp_notification_jobs (notification_type, source_id, status, claim_token) VALUES
      ('receipt', $1, 'pending', 'pending-token'), ('receipt', $1, 'processing', 'before-token'),
      ('receipt', $1, 'processing', 'after-token'), ('receipt', $1, 'sent', NULL)`, [paymentId]);
    await db.query("UPDATE whatsapp_notification_jobs SET send_started_at = NOW() WHERE claim_token = 'after-token'");
    await reverse(db, paymentId, crypto.randomUUID());
    const jobs = await db.query("SELECT status, send_started_at FROM whatsapp_notification_jobs ORDER BY id");
    assert.deepEqual(jobs.rows.map((row) => [row.status, Boolean(row.send_started_at)]), [["skipped", false], ["skipped", false], ["delivery_unknown", true], ["sent", false]]);
  });
});

integrationTest("worker revalidation explicitly rejects a reversed payment", async () => {
  await withDatabase(async ({ db }) => {
    const paymentId = await seedCase(db);
    await reverse(db, paymentId, crypto.randomUUID());
    const result = await revalidateWhatsAppJob({ id: 1, source_id: paymentId, student_id: 1, phone_number: "+201012345678" }, "receipt", db.query.bind(db));
    assert.deepEqual(result, { ok: false, reason: "payment_reversed" });
  });
});

integrationTest("send-start fencing refuses a post-reversal receipt job", async () => {
  await withDatabase(async ({ db }) => {
    const paymentId = await seedCase(db);
    await reverse(db, paymentId, crypto.randomUUID());
    await db.query("INSERT INTO whatsapp_notification_jobs (id, notification_type, source_id, student_id, status, claim_token, template_gender) VALUES (1, 'receipt', $1, 1, 'processing', 'late-token', 'male')", [paymentId]);
    assert.equal(await markSendStarted({ id: 1, source_id: paymentId, student_id: 1, claim_token: "late-token", template_gender: "male" }, "receipt", db), false);
    const job = (await db.query("SELECT status, last_error, send_started_at FROM whatsapp_notification_jobs WHERE id = 1")).rows[0];
    assert.equal(job.status, "skipped");
    assert.equal(job.last_error, "payment_reversed");
    assert.equal(job.send_started_at, null);
  });
});

integrationTest("send-start fencing skips missing, inactive, deleted, and opted-out students", async () => {
  await withDatabase(async ({ db }) => {
    const paymentId = await seedCase(db);
    await db.query("INSERT INTO students (id, group_id, full_name, gender, is_active, deleted_at, whatsapp_opted_out) VALUES (2, 1, 'Inactive Student', 'male', FALSE, NULL, FALSE), (3, 1, 'Deleted Student', 'male', TRUE, NOW(), FALSE), (4, 1, 'Opted Out Student', 'male', TRUE, NULL, TRUE)");
    const cases = [
      { id: 1, studentId: 999, reason: "student_inactive" },
      { id: 2, studentId: 2, reason: "student_inactive" },
      { id: 3, studentId: 3, reason: "student_inactive" },
      { id: 4, studentId: 4, reason: "whatsapp_opted_out" }
    ];
    for (const item of cases) {
      await db.query(
        "INSERT INTO whatsapp_notification_jobs (id, notification_type, source_id, student_id, status, claim_token, template_gender) VALUES ($1, 'receipt', $2, $3, 'processing', $4, 'male')",
        [item.id, paymentId, item.studentId, `claim-${item.id}`]
      );
      assert.equal(await markSendStarted({ id: item.id, source_id: paymentId, student_id: item.studentId, claim_token: `claim-${item.id}`, template_gender: "male" }, "receipt", db), false);
      const job = (await db.query("SELECT status, last_error, send_started_at FROM whatsapp_notification_jobs WHERE id = $1", [item.id])).rows[0];
      assert.equal(job.status, "skipped");
      assert.equal(job.last_error, item.reason);
      assert.equal(job.send_started_at, null);
    }
  });
});

integrationTest("send-start fencing requeues a job when the student's gender changes", async () => {
  await withDatabase(async ({ db }) => {
    const paymentId = await seedCase(db);
    await db.query("UPDATE students SET gender = 'female' WHERE id = 1");
    await db.query(`INSERT INTO whatsapp_notification_jobs
      (id, notification_type, source_id, student_id, status, claim_token, attempts,
       template_id, template_version, template_category, template_audience,
       template_slot_number, template_body_snapshot, template_gender, template_index,
       template_text, rendered_message)
      VALUES (1, 'receipt', $1, 1, 'processing', 'gender-token', 1,
        12, 1, 'receipt', 'male', 1, 'old template', 'male', 0, 'old template', 'old rendered')`, [paymentId]);

    assert.equal(await markSendStarted({ id: 1, source_id: paymentId, student_id: 1, claim_token: "gender-token", template_gender: "male" }, "receipt", db), false);
    const job = (await db.query("SELECT status, attempts, claim_token, template_id, template_text, rendered_message, send_started_at FROM whatsapp_notification_jobs WHERE id = 1")).rows[0];
    assert.equal(job.status, "pending");
    assert.equal(job.attempts, 0);
    assert.equal(job.claim_token, null);
    assert.equal(job.template_id, null);
    assert.equal(job.template_text, null);
    assert.equal(job.rendered_message, null);
    assert.equal(job.send_started_at, null);
  });
});

integrationTest("settlement helper remains safe with a committed in-flight send fence", async () => {
  await withDatabase(async ({ db }) => {
    const paymentId = await seedCase(db);
    await db.query("INSERT INTO whatsapp_notification_jobs (notification_type, source_id, status, claim_token, send_started_at) VALUES ('receipt', $1, 'processing', 'send-token', NOW())", [paymentId]);
    const client = await db.connect();
    try {
      const jobs = await settlePaymentNotificationJobsForReversal({ client, paymentId });
      assert.equal(jobs[0].status, "delivery_unknown");
    } finally {
      client.release();
    }
  });
});
