import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import {
  markWhatsAppReconnect,
  processWhatsAppJobForTest,
  reserveWhatsAppSendSlot
} from "../src/services/whatsapp.js";

const { Pool } = pg;
const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;
const SESSION_KEY = "local_dev";
const QA_PREFIX = "QA-E2E-";

async function withQaSchema(run) {
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
  const schema = `whatsapp_qa_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const tableNames = [
    "whatsapp_settings", "whatsapp_notification_jobs", "whatsapp_send_slots", "whatsapp_send_rate_events",
    "whatsapp_templates", "whatsapp_template_rotation_state", "students", "groups", "attendance_sessions", "attendance_records",
    "exams", "exam_results", "payments", "payment_reversals", "student_portal_access_tokens", "external_contacts",
    "external_conversations", "external_messages"
  ];
  for (const table of tableNames) {
    await admin.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING DEFAULTS INCLUDING GENERATED)`);
  }
  await admin.query(`ALTER TABLE ${schema}.whatsapp_settings ADD PRIMARY KEY (id)`);
  await admin.query(`ALTER TABLE ${schema}.whatsapp_notification_jobs ADD PRIMARY KEY (id)`);
  await admin.query(`ALTER TABLE ${schema}.whatsapp_send_slots ADD PRIMARY KEY (session_key)`);
  await admin.query(`ALTER TABLE ${schema}.whatsapp_template_rotation_state ADD PRIMARY KEY (category, audience)`);
  await admin.query(`ALTER TABLE ${schema}.student_portal_access_tokens ADD PRIMARY KEY (token_hash)`);
  const db = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 16, options: `-c search_path=${schema}` });
  try {
    await seedQaSchema(db);
    return await run({ db, schema });
  } finally {
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => undefined);
    await admin.end();
  }
}

async function seedQaSchema(db) {
  await db.query("INSERT INTO whatsapp_settings SELECT * FROM public.whatsapp_settings WHERE id = 1");
  await db.query("INSERT INTO whatsapp_templates SELECT * FROM public.whatsapp_templates");
  await db.query(`
    INSERT INTO groups (id, center_id, name, display_name, subject, is_active, grade)
    VALUES (990001, 1, 'QA E2E Group', 'QA E2E Group', 'QA Subject', TRUE, 'QA')
  `);
  await db.query(`
    INSERT INTO attendance_sessions
      (id, group_id, occurrence_key, session_date, starts_at, opens_at, closes_at, ends_at,
       original_starts_at, original_opens_at, original_closes_at, original_ends_at, status, cancelled_at)
    VALUES
      (990001, 990001, 'qa-closed', CURRENT_DATE, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '3 hours', NOW() - INTERVAL '1 hour', NOW(), NOW() - INTERVAL '2 hours', NOW() - INTERVAL '3 hours', NOW() - INTERVAL '1 hour', NOW(), 'closed', NULL),
      (990002, 990001, 'qa-cancelled', CURRENT_DATE, NOW() + INTERVAL '1 hour', NOW(), NOW() + INTERVAL '2 hours', NOW() + INTERVAL '3 hours', NOW() + INTERVAL '1 hour', NOW(), NOW() + INTERVAL '2 hours', NOW() + INTERVAL '3 hours', 'cancelled', NOW())
  `);
  await db.query(`
    INSERT INTO students (id, group_id, student_code, full_name, guardian_phone, gender, is_active, whatsapp_opted_out)
    SELECT 1000000 + n, 990001, 'QA-' || n, 'QA Student ' || n,
      '010' || lpad((10000000 + n)::text, 8, '0'),
      CASE WHEN n % 2 = 0 THEN 'female' ELSE 'male' END, TRUE, FALSE
    FROM generate_series(1, 500) AS s(n)
  `);
  await db.query(`
    INSERT INTO attendance_records (id, session_id, student_id, status, checkin_time)
    SELECT 1000000 + n, 990001, 1000000 + n,
      CASE WHEN n <= 180 THEN 'present' ELSE 'absent' END,
      NOW() - INTERVAL '1 hour'
    FROM generate_series(1, 347) AS s(n)
  `);
  await db.query(`
    INSERT INTO exams (id, group_id, title, max_score, exam_date)
    VALUES (990001, 990001, 'QA Exam', 100, CURRENT_DATE)
  `);
  await db.query(`
    INSERT INTO exam_results (id, exam_id, student_id, score, note)
    SELECT 1000200 + n, 990001, 1000347 + n, 80 + n, 'QA result'
    FROM generate_series(1, 10) AS s(n)
  `);
  await db.query(`
    INSERT INTO payments
      (id, student_id, group_id, amount, paid_amount, discount_amount, is_exempt,
       payment_date, paid_at, payment_months, payment_type, payment_reference)
    SELECT 1000300 + n, 1000357 + n, 990001, 100, 100, 0, FALSE,
      CURRENT_DATE, NOW(), jsonb_build_array(CURRENT_DATE::text), CASE WHEN n <= 5 THEN 'normal' ELSE 'advance' END,
      'QA-PAY-' || n
    FROM generate_series(1, 10) AS s(n)
  `);
  await db.query(`
    INSERT INTO external_contacts (id, canonical_phone, display_phone, display_name, source)
    VALUES (990001, '201012345678', '01012345678', 'QA External', 'qa')
  `);
  await db.query(`
    INSERT INTO external_conversations (id, external_contact_id, status, source_type)
    VALUES (990001, 990001, 'open', 'qa')
  `);
  await db.query(`
    INSERT INTO external_messages (id, external_conversation_id, direction, body, is_read, delivery_status, created_by_teacher_id)
    SELECT 1000400 + n, 990001, 'outbound', 'QA external message ' || n, TRUE, 'queued', 1
    FROM generate_series(1, 5) AS s(n)
  `);
  await db.query(`
    INSERT INTO whatsapp_notification_jobs
      (id, notification_type, source_id, attendance_record_id, cancellation_session_id, student_id,
       phone_number, payload, ref_code, status, created_by_teacher_id, external_message_id, created_at, next_attempt_at)
    SELECT 1000000 + n, 'attendance', 1000000 + n, 1000000 + n, NULL::integer, 1000000 + n,
      (SELECT guardian_phone FROM students WHERE id = 1000000 + n),
      jsonb_build_object('type', 'attendance'), 'QA-E2E-ATT-' || n, 'pending', NULL::integer, NULL::bigint,
      NOW() - INTERVAL '31 minutes', NOW()
    FROM generate_series(1, 100) AS s(n)
    UNION ALL
    SELECT 1000100 + n, 'absence', 1000100 + n, 1000100 + n, NULL::integer, 1000100 + n,
      (SELECT guardian_phone FROM students WHERE id = 1000000 + 100 + n),
      jsonb_build_object('type', 'absence'), 'QA-E2E-ABS-' || n, 'pending', NULL::integer, NULL::bigint,
      NOW() - INTERVAL '30 minutes', NOW()
    FROM generate_series(1, 50) AS s(n)
    UNION ALL
    SELECT 1000200 + n, 'grade', 1000200 + n, NULL::bigint, NULL::integer, 1000347 + n,
      (SELECT guardian_phone FROM students WHERE id = 1000347 + n),
      jsonb_build_object('type', 'grade'), 'QA-E2E-GRD-' || n, 'pending', NULL::integer, NULL::bigint,
      NOW() - INTERVAL '29 minutes', NOW()
    FROM generate_series(1, 10) AS s(n)
    UNION ALL
    SELECT 1000210 + n, CASE WHEN n <= 5 THEN 'receipt' ELSE 'advance_payment' END, 1000300 + n, NULL::bigint, NULL::integer, 1000357 + n,
      (SELECT guardian_phone FROM students WHERE id = 1000357 + n),
      jsonb_build_object('type', CASE WHEN n <= 5 THEN 'receipt' ELSE 'advance_payment' END), 'QA-E2E-PAY-' || n, 'pending', NULL::integer, NULL::bigint,
      NOW() - INTERVAL '28 minutes', NOW()
    FROM generate_series(1, 10) AS s(n)
    UNION ALL
    SELECT 1000220 + n, 'cancellation', 990002, NULL::bigint, 990002, 1000000 + n,
      (SELECT guardian_phone FROM students WHERE id = 1000000 + n),
      jsonb_build_object('type', 'cancellation'), 'QA-E2E-CAN-' || n, 'pending', NULL::integer, NULL::bigint,
      NOW() - INTERVAL '27 minutes', NOW()
    FROM generate_series(1, 5) AS s(n)
    UNION ALL
    SELECT 1000230 + n, 'custom_message', 1000000 + n, NULL::bigint, NULL::integer, 1000000 + n,
      (SELECT guardian_phone FROM students WHERE id = 1000000 + n),
      jsonb_build_object('type', 'custom_message', 'message', 'QA custom message ' || n), 'QA-E2E-CUS-' || n, 'pending', 1, NULL::bigint,
      NOW() - INTERVAL '26 minutes', NOW()
    FROM generate_series(1, 5) AS s(n)
    UNION ALL
    SELECT 1000240 + n, 'external_message', 1000400 + n, NULL::bigint, NULL::integer, NULL::integer, '01012345678',
      jsonb_build_object('type', 'external_message'), 'QA-E2E-EXT-' || n, 'pending', 1, 1000400 + n,
      NOW() - INTERVAL '25 minutes', NOW()
    FROM generate_series(1, 5) AS s(n)
  `);
  await db.query(`
    INSERT INTO whatsapp_notification_jobs
      (id, notification_type, source_id, attendance_record_id, student_id, phone_number, payload, ref_code, status, created_at, next_attempt_at)
    SELECT 2000000 + n,
      CASE WHEN n <= 180 THEN 'attendance' ELSE 'absence' END,
      1000000 + n, 1000000 + n, 1000000 + n,
      (SELECT guardian_phone FROM students WHERE id = 1000000 + n),
      jsonb_build_object('type', CASE WHEN n <= 180 THEN 'attendance' ELSE 'absence' END),
      CASE WHEN n <= 180 THEN 'QA-E2E-BULK-ATT-' ELSE 'QA-E2E-BULK-ABS-' END || n,
      'pending', NOW() - INTERVAL '10 minutes', NOW()
    FROM generate_series(1, 347) AS s(n)
    UNION ALL
    SELECT 2000347 + n, 'grade', 1000200 + ((n - 1) % 10) + 1, NULL, 1000347 + ((n - 1) % 10) + 1,
      (SELECT guardian_phone FROM students WHERE id = 1000347 + ((n - 1) % 10) + 1),
      jsonb_build_object('type', 'grade'), 'QA-E2E-BULK-GRD-' || n, 'pending', NOW() - INTERVAL '9 minutes', NOW()
    FROM generate_series(1, 10) AS s(n)
    UNION ALL
    SELECT 2000357 + n, 'custom_message', 1000000 + ((n - 1) % 5) + 1, NULL, 1000000 + ((n - 1) % 5) + 1,
      (SELECT guardian_phone FROM students WHERE id = 1000000 + ((n - 1) % 5) + 1),
      jsonb_build_object('type', 'custom_message', 'message', 'QA bulk custom ' || n), 'QA-E2E-BULK-CUS-' || n, 'pending', NOW() - INTERVAL '8 minutes', NOW()
    FROM generate_series(1, 4) AS s(n)
  `);
  await db.query("INSERT INTO whatsapp_send_slots (session_key) VALUES ($1)", [SESSION_KEY]);
}

async function resetGovernor(db) {
  await db.query("UPDATE whatsapp_send_slots SET next_available_at = NOW() - INTERVAL '1 second', batch_count = 0, batch_cooldown_until = NULL, reconnect_cooldown_until = NULL WHERE session_key = $1", [SESSION_KEY]);
}

async function makeRunnable(db, id) {
  await db.query("UPDATE whatsapp_notification_jobs SET next_attempt_at = NOW(), status = 'pending', last_error = NULL, claim_token = NULL, lease_expires_at = NULL WHERE id = $1", [id]);
}

integrationTest("real queue QA simulation with fake provider and isolated PostgreSQL schema", async () => {
  await withQaSchema(async ({ db, schema }) => {
    const providerCalls = [];
    let providerMode = "success";
    let callInFlight = false;
    const provider = {
      sendMessage: async (_jid, payload) => {
        assert.equal(callInFlight, false, "provider calls must not overlap");
        callInFlight = true;
        const started = new Date();
        const result = providerMode === "success" ? { key: { id: `qa-provider-${providerCalls.length + 1}` } } : null;
        providerCalls.push({ started, payload: payload.text, simulated_result: providerMode });
        if (providerMode === "timeout") {
          const error = new Error("qa_timeout");
          error.code = "whatsapp_provider_timeout";
          callInFlight = false;
          throw error;
        }
        if (providerMode === "transient_error") {
          callInFlight = false;
          throw new Error("qa_transient_error");
        }
        callInFlight = false;
        return result;
      }
    };
    const fastSettings = {
      auto_send: true,
      attendance_notifications_enabled: true,
      min_delay_seconds: 2,
      max_delay_seconds: 2,
      max_messages_per_hour: 10000,
      batch_size: 10000,
      batch_cooldown_seconds: 0,
      reconnect_cooldown_seconds: 0
    };
    const countResult = await db.query("SELECT notification_type, COUNT(*)::int AS count FROM whatsapp_notification_jobs WHERE id BETWEEN 1000001 AND 1000245 GROUP BY notification_type ORDER BY notification_type");
    assert.equal(countResult.rows.reduce((sum, row) => sum + row.count, 0), 185);
    assert.deepEqual(countResult.rows.map((row) => [row.notification_type, row.count]), [
      ["absence", 50], ["advance_payment", 5], ["attendance", 100], ["cancellation", 5], ["custom_message", 5], ["external_message", 5], ["grade", 10], ["receipt", 5]
    ]);
    assert.equal(Number((await db.query("SELECT COUNT(*)::int AS count FROM whatsapp_notification_jobs WHERE id >= 2000000")).rows[0].count), 361);

    await resetGovernor(db);
    const baselineIds = [1000241, 1000242, 1000243, 1000244];
    await db.query("UPDATE whatsapp_notification_jobs SET next_attempt_at = NOW() + INTERVAL '1 hour' WHERE status = 'pending'");
    for (const id of baselineIds) {
      await makeRunnable(db, id);
      await processWhatsAppJobForTest({ dbPool: db, provider, settings: fastSettings });
      await resetGovernor(db);
    }
    const baselineRows = (await db.query("SELECT id, notification_type, status, provider_call_started_at, provider_call_finished_at FROM whatsapp_notification_jobs WHERE id = ANY($1::bigint[]) ORDER BY id", [baselineIds])).rows;
    assert.ok(baselineRows.every((row) => row.status === "sent"));
    assert.ok(baselineRows.every((row) => row.provider_call_started_at && row.provider_call_finished_at));

    await db.query("UPDATE whatsapp_settings SET min_delay_seconds = 30, max_delay_seconds = 30");
    await resetGovernor(db);
    const firstReservation = await reserveWhatsAppSendSlot(null, db);
    assert.equal(firstReservation.reserved, true);
    let delay = (await db.query("SELECT next_available_at FROM whatsapp_send_slots WHERE session_key = $1", [SESSION_KEY])).rows[0].next_available_at;
    const delay30 = new Date(delay).getTime() - Date.now();
    assert.ok(delay30 >= 29_000 && delay30 <= 31_000);
    await db.query("UPDATE whatsapp_settings SET min_delay_seconds = 60, max_delay_seconds = 60");
    await resetGovernor(db);
    const secondReservation = await reserveWhatsAppSendSlot(null, db);
    assert.equal(secondReservation.reserved, true);
    delay = (await db.query("SELECT next_available_at FROM whatsapp_send_slots WHERE session_key = $1", [SESSION_KEY])).rows[0].next_available_at;
    const delay60 = new Date(delay).getTime() - Date.now();
    assert.ok(delay60 >= 59_000 && delay60 <= 61_000);
    await db.query("UPDATE whatsapp_settings SET min_delay_seconds = 60, max_delay_seconds = 90, batch_size = 10000");
    const rangeDelays = [];
    for (let index = 0; index < 5; index += 1) {
      await resetGovernor(db);
      await reserveWhatsAppSendSlot(null, db);
      delay = (await db.query("SELECT next_available_at FROM whatsapp_send_slots WHERE session_key = $1", [SESSION_KEY])).rows[0].next_available_at;
      rangeDelays.push(new Date(delay).getTime() - Date.now());
    }
    assert.ok(rangeDelays.every((value) => value >= 59_000 && value <= 91_000));

    const disconnectId = 1000245;
    await resetGovernor(db);
    await makeRunnable(db, disconnectId);
    const beforeDisconnect = (await db.query("SELECT status, attempts, next_attempt_at, last_error FROM whatsapp_notification_jobs WHERE id = $1", [disconnectId])).rows[0];
    await processWhatsAppJobForTest({ dbPool: db, provider, settings: fastSettings, ownership: { connected: () => false } });
    const afterDisconnect = (await db.query("SELECT status, attempts, next_attempt_at, last_error FROM whatsapp_notification_jobs WHERE id = $1", [disconnectId])).rows[0];
    assert.deepEqual(afterDisconnect, beforeDisconnect);
    assert.equal(providerCalls.length, 4);

    const beforeReconnect = (await db.query("SELECT COUNT(*)::int AS count FROM whatsapp_notification_jobs WHERE last_error = 'whatsapp_disconnected' AND id >= 2000000")).rows[0].count;
    await markWhatsAppReconnect({ db });
    const afterReconnect = (await db.query("SELECT COUNT(*)::int AS count FROM whatsapp_notification_jobs WHERE last_error = 'whatsapp_disconnected' AND id >= 2000000")).rows[0].count;
    assert.equal(afterReconnect, beforeReconnect);
    await processWhatsAppJobForTest({ dbPool: db, provider });
    const heldAfterReconnect = (await db.query("SELECT status, attempts FROM whatsapp_notification_jobs WHERE id = $1", [disconnectId])).rows[0];
    assert.equal(heldAfterReconnect.status, "pending");
    assert.equal(Number(heldAfterReconnect.attempts), 0);

    await db.query("UPDATE whatsapp_send_slots SET reconnect_cooldown_until = NULL WHERE session_key = $1", [SESSION_KEY]);
    await resetGovernor(db);
    await processWhatsAppJobForTest({ dbPool: db, provider, settings: fastSettings });
    assert.equal((await db.query("SELECT status FROM whatsapp_notification_jobs WHERE id = $1", [disconnectId])).rows[0].status, "sent");

    await db.query("UPDATE whatsapp_settings SET max_messages_per_hour = 1, batch_size = 1, batch_cooldown_seconds = 300, min_delay_seconds = 2, max_delay_seconds = 2");
    await db.query("DELETE FROM whatsapp_send_rate_events");
    await resetGovernor(db);
    const capOne = await reserveWhatsAppSendSlot(null, db);
    const capTwo = await reserveWhatsAppSendSlot(null, db);
    assert.equal(capOne.reserved, true);
    assert.equal(capTwo.reserved, false);
    assert.ok(["hourly_cap", "batch_cooldown"].includes(capTwo.reason));
    await db.query("UPDATE whatsapp_settings SET max_messages_per_hour = 10000, batch_size = 10000, batch_cooldown_seconds = 0, min_delay_seconds = 2, max_delay_seconds = 2");
    await db.query("DELETE FROM whatsapp_send_rate_events");
    await resetGovernor(db);

    const concurrent = await Promise.all([
      reserveWhatsAppSendSlot(null, db),
      reserveWhatsAppSendSlot(null, db)
    ]);
    assert.equal(concurrent.filter((result) => result.reserved).length, 1);

    await db.query("UPDATE whatsapp_notification_jobs SET next_attempt_at = NOW() WHERE id >= 2000000 AND status = 'pending'");
    const priorityHead = (await db.query(`
      SELECT notification_type
      FROM whatsapp_notification_jobs
      WHERE status = 'pending' AND next_attempt_at <= NOW()
      ORDER BY GREATEST(0, CASE notification_type
        WHEN 'external_message' THEN 0 WHEN 'custom_message' THEN 0
        WHEN 'receipt' THEN 1 WHEN 'advance_payment' THEN 1
        WHEN 'cancellation' THEN 2 WHEN 'grade' THEN 2 ELSE 3 END
        - FLOOR(EXTRACT(EPOCH FROM (NOW() - created_at)) / 900)), created_at, id
      LIMIT 1`)).rows[0];
    assert.equal(priorityHead.notification_type, "custom_message");

    await db.query("UPDATE whatsapp_settings SET max_messages_per_hour = 1, batch_size = 10000, batch_cooldown_seconds = 0");
    await db.query("DELETE FROM whatsapp_send_rate_events");
    await resetGovernor(db);
    assert.equal((await reserveWhatsAppSendSlot(null, db)).reserved, true);
    const restartedDb = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 4, options: `-c search_path=${schema}` });
    try {
      const afterRestart = await reserveWhatsAppSendSlot(null, restartedDb);
      assert.equal(afterRestart.reserved, false);
      assert.equal(afterRestart.reason, "hourly_cap");
    } finally {
      await restartedDb.end();
    }

    await db.query("UPDATE whatsapp_notification_jobs SET next_attempt_at = NOW() + INTERVAL '1 hour' WHERE id >= 2000000 AND status = 'pending'");
    await db.query("INSERT INTO external_messages (id, external_conversation_id, direction, body, is_read, delivery_status, created_by_teacher_id) VALUES (1000501, 990001, 'outbound', 'QA transient', TRUE, 'queued', 1), (1000502, 990001, 'outbound', 'QA timeout', TRUE, 'queued', 1)");
    await db.query("INSERT INTO whatsapp_notification_jobs (id, notification_type, source_id, phone_number, payload, ref_code, status, created_by_teacher_id, external_message_id, created_at, next_attempt_at) VALUES (1000251, 'external_message', 1000501, '01012345678', '{\"type\":\"external_message\"}', 'QA-E2E-FAIL-1', 'pending', 1, 1000501, NOW(), NOW()), (1000252, 'external_message', 1000502, '01012345678', '{\"type\":\"external_message\"}', 'QA-E2E-FAIL-2', 'pending', 1, 1000502, NOW(), NOW())");
    providerMode = "transient_error";
    await db.query("UPDATE whatsapp_send_slots SET next_available_at = NOW() - INTERVAL '1 second' WHERE session_key = $1", [SESSION_KEY]);
    await makeRunnable(db, 1000251);
    await processWhatsAppJobForTest({ dbPool: db, provider, settings: fastSettings });
    assert.equal((await db.query("SELECT status FROM whatsapp_notification_jobs WHERE id = 1000251")).rows[0].status, "pending");
    providerMode = "timeout";
    await db.query("UPDATE whatsapp_send_slots SET next_available_at = NOW() - INTERVAL '1 second' WHERE session_key = $1", [SESSION_KEY]);
    await makeRunnable(db, 1000252);
    await processWhatsAppJobForTest({ dbPool: db, provider, settings: fastSettings });
    assert.equal((await db.query("SELECT status FROM whatsapp_notification_jobs WHERE id = 1000252")).rows[0].status, "delivery_unknown");

    const telemetry = (await db.query(`
      SELECT id AS job_id, notification_type, provider_call_started_at AS started_at,
             provider_call_finished_at AS finished_at,
             EXTRACT(EPOCH FROM (provider_call_started_at - LAG(provider_call_started_at) OVER (ORDER BY provider_call_started_at))) * 1000 AS gap_ms
      FROM whatsapp_notification_jobs
      WHERE id BETWEEN 1000001 AND 1000245 AND provider_call_started_at IS NOT NULL
      ORDER BY provider_call_started_at
      LIMIT 10`)).rows;
    assert.ok(telemetry.length >= 4);
    assert.ok(telemetry.every((row) => row.started_at && row.finished_at));
    console.log(JSON.stringify({
      fixture_counts: { baseline: 185, backlog: 361 },
      provider_calls: providerCalls.length,
      observed_baseline_start_gaps_ms: telemetry.slice(1).map((row) => row.gap_ms).filter(Boolean),
      delay30_ms: delay30,
      delay60_ms: delay60,
      range_delays_ms: rangeDelays,
      backlog_pending_after_simulation: Number((await db.query("SELECT COUNT(*)::int AS count FROM whatsapp_notification_jobs WHERE id >= 2000000 AND status = 'pending'")).rows[0].count),
      telemetry: telemetry.map((row) => ({ job_id: row.job_id, type: row.notification_type, started_at: row.started_at, finished_at: row.finished_at, gap_ms: row.gap_ms }))
    }, null, 2));
  });
});
