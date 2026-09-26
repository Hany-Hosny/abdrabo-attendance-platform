import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { processWhatsAppJobForTest, selectWhatsAppTemplateForTest } from "../src/services/whatsapp.js";
import { WHATSAPP_TEMPLATE_CATALOG } from "../src/services/whatsappTemplateCatalog.js";

const { Pool } = pg;
const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

async function withIsolatedDatabase(run) {
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
  const schema = `gender_templates_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 12, options: `-c search_path=${schema}` });
  try {
    await db.query(`
      CREATE TABLE students (
        id INTEGER PRIMARY KEY, full_name TEXT NOT NULL, student_code TEXT NOT NULL,
        guardian_phone TEXT, gender TEXT, is_active BOOLEAN NOT NULL DEFAULT TRUE,
        deleted_at TIMESTAMPTZ, whatsapp_opted_out BOOLEAN NOT NULL DEFAULT FALSE
      );
      CREATE TABLE groups (id INTEGER PRIMARY KEY, name TEXT NOT NULL, display_name TEXT);
      CREATE TABLE attendance_sessions (id INTEGER PRIMARY KEY, status TEXT NOT NULL, session_date DATE NOT NULL, group_id INTEGER NOT NULL);
      CREATE TABLE attendance_records (id BIGINT PRIMARY KEY, student_id INTEGER NOT NULL, session_id INTEGER NOT NULL, status TEXT NOT NULL, checkin_time TIMESTAMPTZ);
      CREATE TABLE whatsapp_templates (
        id BIGINT PRIMARY KEY, category TEXT NOT NULL, audience TEXT NOT NULL, slot_number INTEGER,
        slot_key TEXT, is_fallback BOOLEAN NOT NULL, content_version INTEGER NOT NULL,
        message_body TEXT NOT NULL, is_active BOOLEAN NOT NULL
      );
      CREATE TABLE whatsapp_template_rotation_state (
        category TEXT NOT NULL, audience TEXT NOT NULL, next_slot INTEGER NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (category, audience)
      );
      CREATE TABLE whatsapp_notification_jobs (
        id BIGINT PRIMARY KEY, notification_type TEXT NOT NULL, source_id BIGINT,
        attendance_record_id BIGINT, cancellation_session_id INTEGER, student_id INTEGER, created_by_teacher_id INTEGER,
        idempotency_key TEXT, phone_number TEXT,
        payload JSONB NOT NULL, ref_code TEXT NOT NULL, status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        sent_at TIMESTAMPTZ, lease_expires_at TIMESTAMPTZ, claim_token TEXT, send_started_at TIMESTAMPTZ,
        provider_message_id TEXT, template_index INTEGER, template_text TEXT,
        rendered_message TEXT, template_id BIGINT, template_version INTEGER,
        template_category TEXT, template_audience TEXT, template_slot_number INTEGER,
        template_body_snapshot TEXT, template_gender TEXT, provider_accepted_at TIMESTAMPTZ,
        provider_call_started_at TIMESTAMPTZ, provider_call_finished_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE whatsapp_send_slots (
        session_key TEXT PRIMARY KEY, next_available_at TIMESTAMPTZ, batch_count INTEGER NOT NULL DEFAULT 0,
        batch_cooldown_until TIMESTAMPTZ, reconnect_cooldown_until TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE whatsapp_send_rate_events (
        id BIGSERIAL PRIMARY KEY, session_key TEXT NOT NULL, reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE student_portal_access_tokens (
        token_hash TEXT PRIMARY KEY, student_id INTEGER NOT NULL, expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      INSERT INTO groups (id, name, display_name) VALUES (1, 'Group A', 'Group A');
      INSERT INTO attendance_sessions (id, status, session_date, group_id) VALUES (1, 'closed', '2026-09-16', 1);
    `);
    return await run({ db, schema });
  } finally {
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => undefined);
    await admin.end();
  }
}

async function seedTemplates(db, category = "absence", firstId = 1) {
  let id = firstId;
  for (const audience of ["male", "female"]) {
    for (let slot = 1; slot <= 4; slot += 1) {
      await db.query(`INSERT INTO whatsapp_templates (id, category, audience, slot_number, slot_key, is_fallback, content_version, message_body, is_active) VALUES ($1, $2, $3, $4, $5, FALSE, 1, $6, TRUE)`, [id++, category, audience, slot, `${category}:${audience}:${slot}`, WHATSAPP_TEMPLATE_CATALOG[category][audience][slot - 1]]);
    }
  }
  await db.query(`INSERT INTO whatsapp_templates (id, category, audience, slot_key, is_fallback, content_version, message_body, is_active) VALUES ($1, $2, 'neutral', $3, TRUE, 1, $4, TRUE)`, [id, category, `${category}:neutral:fallback`, WHATSAPP_TEMPLATE_CATALOG[category].neutral]);
}

async function addAbsentJob(db, { id, gender = "male", token = `claim-${id}`, status = "processing" }) {
  await db.query(`INSERT INTO students (id, full_name, student_code, guardian_phone, gender) VALUES ($1, $2, $3, $4, $5)`, [id, `Student ${id}`, `S-${id}`, "01012345678", gender]);
  await db.query(`INSERT INTO attendance_records (id, student_id, session_id, status) VALUES ($1, $2, 1, 'absent')`, [id, id]);
  await db.query(`INSERT INTO whatsapp_notification_jobs (id, notification_type, source_id, attendance_record_id, student_id, phone_number, payload, ref_code, status, claim_token) VALUES ($1, 'absence', $1, $1, $2, '+201012345678', $3::jsonb, $4, $5, $6)`, [id, id, JSON.stringify({ type: "absence" }), `ABS-${id}`, status, status === "processing" ? token : null]);
  return { id, claim_token: token };
}

async function addAttendanceJob(db, { id, gender = "male", token = `claim-${id}` }) {
  await db.query(`INSERT INTO students (id, full_name, student_code, guardian_phone, gender) VALUES ($1, $2, $3, $4, $5)`, [id, `Student ${id}`, `S-${id}`, "01012345678", gender]);
  await db.query(`INSERT INTO attendance_records (id, student_id, session_id, status, checkin_time) VALUES ($1, $2, 1, 'present', NOW())`, [id, id]);
  await db.query(`INSERT INTO whatsapp_notification_jobs (id, notification_type, source_id, attendance_record_id, student_id, phone_number, payload, ref_code, status, claim_token) VALUES ($1, 'attendance', $1, $1, $2, '+201012345678', $3::jsonb, $4, 'processing', $5)`, [id, id, JSON.stringify({ type: "attendance" }), `ATT-${id}`, token]);
  return { id, claim_token: token };
}

integrationTest("gender-aware assignment is transactional, independent, durable, and retry-safe", async () => {
  await withIsolatedDatabase(async ({ db }) => {
    await seedTemplates(db);
    await seedTemplates(db, "attendance", 100);
    const maleJobs = [];
    const femaleJobs = [];
    for (let id = 1; id <= 20; id += 1) maleJobs.push(await addAbsentJob(db, { id, gender: "male" }));
    for (let id = 101; id <= 120; id += 1) femaleJobs.push(await addAbsentJob(db, { id, gender: "female" }));

    const maleSlots = [];
    const first = await selectWhatsAppTemplateForTest({ job: maleJobs[0], type: "absence", dbPool: db });
    const immediateRepeat = await selectWhatsAppTemplateForTest({ job: maleJobs[0], type: "absence", dbPool: db });
    assert.equal(first.ok, true);
    assert.equal(immediateRepeat.assignment.id, first.assignment.id);
    assert.equal(Number((await db.query(`SELECT next_slot FROM whatsapp_template_rotation_state WHERE category = 'absence' AND audience = 'male'`)).rows[0].next_slot), 2);
    maleSlots.push(Number(first.assignment.slot_number));
    for (const job of maleJobs.slice(1)) maleSlots.push(Number((await selectWhatsAppTemplateForTest({ job, type: "absence", dbPool: db })).assignment.slot_number));
    assert.deepEqual(maleSlots, Array.from({ length: 20 }, (_value, index) => (index % 4) + 1));

    const femaleSlots = [];
    for (const job of femaleJobs) femaleSlots.push(Number((await selectWhatsAppTemplateForTest({ job, type: "absence", dbPool: db })).assignment.slot_number));
    assert.deepEqual(femaleSlots, Array.from({ length: 20 }, (_value, index) => (index % 4) + 1));

    const retry = await selectWhatsAppTemplateForTest({ job: maleJobs[0], type: "absence", dbPool: db });
    assert.equal(retry.assignment.slot_number, 1);
    assert.equal((await db.query(`SELECT next_slot FROM whatsapp_template_rotation_state WHERE category = 'absence' AND audience = 'male'`)).rows[0].next_slot, 1);

    const categoryJob = await addAttendanceJob(db, { id: 205, gender: "male" });
    const categorySelection = await selectWhatsAppTemplateForTest({ job: categoryJob, type: "attendance", dbPool: db });
    assert.equal(categorySelection.assignment.audience, "male");
    assert.equal(Number((await db.query(`SELECT next_slot FROM whatsapp_template_rotation_state WHERE category = 'attendance' AND audience = 'male'`)).rows[0].next_slot), 2);
    assert.equal(Number((await db.query(`SELECT next_slot FROM whatsapp_template_rotation_state WHERE category = 'absence' AND audience = 'female'`)).rows[0].next_slot), 1);

    const concurrentA = await addAbsentJob(db, { id: 201, gender: "male" });
    const concurrentB = await addAbsentJob(db, { id: 202, gender: "male" });
    const concurrent = await Promise.all([
      selectWhatsAppTemplateForTest({ job: concurrentA, type: "absence", dbPool: db }),
      selectWhatsAppTemplateForTest({ job: concurrentB, type: "absence", dbPool: db })
    ]);
    assert.deepEqual(new Set(concurrent.map((item) => item.assignment.slot_number)).size, 2);
    const persisted = await db.query(`SELECT template_id, template_version, template_audience, template_slot_number, template_body_snapshot FROM whatsapp_notification_jobs WHERE id = $1`, [concurrentA.id]);
    assert.equal(persisted.rows[0].template_audience, "male");
    assert.equal(Number(persisted.rows[0].template_version), 1);
    assert.match(persisted.rows[0].template_body_snapshot, /الطالب/);

    const sameJobConcurrent = await addAbsentJob(db, { id: 307, gender: "male" });
    const concurrentSameJob = await Promise.all([
      selectWhatsAppTemplateForTest({ job: sameJobConcurrent, type: "absence", dbPool: db }),
      selectWhatsAppTemplateForTest({ job: sameJobConcurrent, type: "absence", dbPool: db })
    ]);
    assert.equal(concurrentSameJob[0].assignment.id, concurrentSameJob[1].assignment.id);

    const cursorBeforeRollback = Number((await db.query(`SELECT next_slot FROM whatsapp_template_rotation_state WHERE category = 'absence' AND audience = 'male'`)).rows[0].next_slot);
    await db.query(`
      CREATE FUNCTION fail_gender_template_assignment() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.id = 401 AND NEW.template_id IS NOT NULL THEN
          RAISE EXCEPTION 'synthetic_assignment_failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER fail_gender_template_assignment_trigger
      BEFORE UPDATE ON whatsapp_notification_jobs
      FOR EACH ROW EXECUTE FUNCTION fail_gender_template_assignment();
    `);
    const rollbackJob = await addAbsentJob(db, { id: 401, gender: "male" });
    await assert.rejects(
      selectWhatsAppTemplateForTest({ job: rollbackJob, type: "absence", dbPool: db }),
      /synthetic_assignment_failure/
    );
    const cursorAfterRollback = Number((await db.query(`SELECT next_slot FROM whatsapp_template_rotation_state WHERE category = 'absence' AND audience = 'male'`)).rows[0].next_slot);
    assert.equal(cursorAfterRollback, cursorBeforeRollback);
    await db.query("DROP TRIGGER fail_gender_template_assignment_trigger ON whatsapp_notification_jobs");
    await db.query("DROP FUNCTION fail_gender_template_assignment()");

    const unknown = await addAbsentJob(db, { id: 301, gender: "unknown" });
    const unknownSelection = await selectWhatsAppTemplateForTest({ job: unknown, type: "absence", dbPool: db });
    assert.equal(unknownSelection.assignment.audience, "neutral");
    assert.doesNotMatch(unknownSelection.assignment.message_body, /\bالطالب\b/);

    const changed = await addAbsentJob(db, { id: 302, gender: "unknown" });
    await db.query("UPDATE students SET gender = 'female' WHERE id = 302");
    const changedSelection = await selectWhatsAppTemplateForTest({ job: changed, type: "absence", dbPool: db });
    assert.equal(changedSelection.assignment.audience, "female");

    await db.query("UPDATE students SET gender = 'male' WHERE id = 302");
    const reassigned = await selectWhatsAppTemplateForTest({ job: changed, type: "absence", dbPool: db });
    assert.equal(reassigned.assignment.audience, "male");
    assert.equal(reassigned.assignment.gender, "male");

    const versionChanged = await addAbsentJob(db, { id: 305, gender: "male" });
    const beforeVersionChange = await selectWhatsAppTemplateForTest({ job: versionChanged, type: "absence", dbPool: db });
    await db.query("UPDATE whatsapp_templates SET message_body = message_body || ' نسخة', content_version = content_version + 1 WHERE id = $1", [beforeVersionChange.assignment.id]);
    const afterVersionChange = await selectWhatsAppTemplateForTest({ job: versionChanged, type: "absence", dbPool: db });
    assert.notEqual(afterVersionChange.assignment.id, beforeVersionChange.assignment.id);

    const disabledAfterAssignment = await addAbsentJob(db, { id: 306, gender: "male" });
    const beforeDisable = await selectWhatsAppTemplateForTest({ job: disabledAfterAssignment, type: "absence", dbPool: db });
    await db.query("UPDATE whatsapp_templates SET is_active = FALSE WHERE id = $1", [beforeDisable.assignment.id]);
    const afterDisable = await selectWhatsAppTemplateForTest({ job: disabledAfterAssignment, type: "absence", dbPool: db });
    assert.notEqual(afterDisable.assignment.id, beforeDisable.assignment.id);

    await db.query("UPDATE whatsapp_templates SET is_active = FALSE WHERE category = 'absence' AND audience = 'male'");
    const fallbackJob = await addAbsentJob(db, { id: 303, gender: "male" });
    const fallback = await selectWhatsAppTemplateForTest({ job: fallbackJob, type: "absence", dbPool: db });
    assert.equal(fallback.assignment.audience, "neutral");
    assert.equal(fallback.assignment.warning, "male_template_pool_empty_using_neutral_fallback");
    await db.query("UPDATE whatsapp_templates SET is_active = FALSE WHERE category = 'absence' AND is_fallback = TRUE");
    const noConfigJob = await addAbsentJob(db, { id: 304, gender: "male" });
    assert.deepEqual((await selectWhatsAppTemplateForTest({ job: noConfigJob, type: "absence", dbPool: db })).reason, "whatsapp_template_configuration_missing");
  });
});

integrationTest("worker fake-provider path sends one rendered message and fences retries", async () => {
  await withIsolatedDatabase(async ({ db }) => {
    await seedTemplates(db);
    const settings = { auto_send: true, min_delay_seconds: 2, max_delay_seconds: 2 };
    const sent = [];
    const provider = { sendMessage: async (_jid, payload) => { sent.push(payload.text); return { key: { id: `fake-${sent.length}` } }; } };
    await addAbsentJob(db, { id: 501, gender: "female", status: "pending" });
    await processWhatsAppJobForTest({ dbPool: db, provider, settings });
    assert.equal(sent.length, 1);
    assert.match(sent[0], /الطالبة/);
    const sentJob = (await db.query("SELECT status, rendered_message FROM whatsapp_notification_jobs WHERE id = 501")).rows[0];
    assert.equal(sentJob.status, "sent");
    assert.match(sentJob.rendered_message, /Student 501/);
    assert.match(sentJob.rendered_message, /Group A/);
    await processWhatsAppJobForTest({ dbPool: db, provider, settings });
    assert.equal(sent.length, 1);

    let shouldFail = true;
    const retryProvider = { sendMessage: async (_jid, payload) => {
      if (shouldFail) { shouldFail = false; throw new Error("fake_provider_failure"); }
      sent.push(payload.text);
      return { key: { id: `fake-retry-${sent.length}` } };
    } };
    await db.query("UPDATE whatsapp_send_slots SET next_available_at = NOW(), batch_count = 0, batch_cooldown_until = NULL, reconnect_cooldown_until = NULL WHERE session_key = 'local_dev'");
    await addAbsentJob(db, { id: 502, gender: "male", status: "pending" });
    await processWhatsAppJobForTest({ dbPool: db, provider: retryProvider, settings });
    const failedAttempt = await db.query("SELECT status, template_id FROM whatsapp_notification_jobs WHERE id = 502");
    assert.equal(failedAttempt.rows[0].status, "pending");
    assert.ok(failedAttempt.rows[0].template_id);
    await db.query("UPDATE whatsapp_notification_jobs SET next_attempt_at = NOW() WHERE id = 502");
    await db.query("UPDATE whatsapp_send_slots SET next_available_at = NOW(), batch_count = 0, batch_cooldown_until = NULL, reconnect_cooldown_until = NULL WHERE session_key = 'local_dev'");
    await processWhatsAppJobForTest({ dbPool: db, provider: retryProvider, settings });
    assert.equal((await db.query("SELECT status FROM whatsapp_notification_jobs WHERE id = 502")).rows[0].status, "sent");
    assert.equal((await db.query("SELECT next_slot FROM whatsapp_template_rotation_state WHERE category = 'absence' AND audience = 'male'")).rows[0].next_slot, 2);

    const unknownProvider = { sendMessage: async () => { const error = new Error("provider timeout"); error.code = "whatsapp_provider_timeout"; throw error; } };
    await db.query("UPDATE whatsapp_send_slots SET next_available_at = NOW(), batch_count = 0, batch_cooldown_until = NULL, reconnect_cooldown_until = NULL WHERE session_key = 'local_dev'");
    await addAbsentJob(db, { id: 503, gender: "male", status: "pending" });
    await processWhatsAppJobForTest({ dbPool: db, provider: unknownProvider, settings });
    assert.equal((await db.query("SELECT status, last_error FROM whatsapp_notification_jobs WHERE id = 503")).rows[0].status, "delivery_unknown");
    assert.equal((await db.query("SELECT next_slot FROM whatsapp_template_rotation_state WHERE category = 'absence' AND audience = 'male'")).rows[0].next_slot, 3);
    await processWhatsAppJobForTest({ dbPool: db, provider: unknownProvider, settings });
    assert.equal((await db.query("SELECT status FROM whatsapp_notification_jobs WHERE id = 503")).rows[0].status, "delivery_unknown");
  });
});

integrationTest("auto-send safety is global and disconnected jobs remain durable pending work", async () => {
  await withIsolatedDatabase(async ({ db }) => {
    await seedTemplates(db);
    const providerCalls = [];
    const provider = { sendMessage: async (_jid, payload) => { providerCalls.push(payload); return { key: { id: `fake-${providerCalls.length}` } }; } };

    for (const [id, notificationType] of [[601, "attendance"], [602, "absence"], [603, "grade"], [604, "receipt"], [605, "advance_payment"], [606, "cancellation"]]) {
      await db.query(
        `INSERT INTO whatsapp_notification_jobs
          (id, notification_type, source_id, payload, ref_code, status)
         VALUES ($1, $2, $1, '{}'::jsonb, $3, 'pending')`,
        [id, notificationType, `TEST-${id}`]
      );
    }
    for (let index = 0; index < 6; index += 1) {
      await processWhatsAppJobForTest({ dbPool: db, provider, settings: { auto_send: false, min_delay_seconds: 2, max_delay_seconds: 2 } });
    }
    const disabled = await db.query("SELECT notification_type, status, last_error FROM whatsapp_notification_jobs WHERE id BETWEEN 601 AND 606 ORDER BY id");
    assert.deepEqual(disabled.rows.map((row) => [row.notification_type, row.status, row.last_error]), [
      ["attendance", "skipped", "auto_send_disabled"],
      ["absence", "skipped", "auto_send_disabled"],
      ["grade", "skipped", "auto_send_disabled"],
      ["receipt", "skipped", "auto_send_disabled"],
      ["advance_payment", "skipped", "auto_send_disabled"],
      ["cancellation", "skipped", "auto_send_disabled"]
    ]);
    assert.equal(providerCalls.length, 0);

    await addAbsentJob(db, { id: 701, gender: "male", status: "pending" });
    const connected = () => false;
    const enabledSettings = { auto_send: true, min_delay_seconds: 2, max_delay_seconds: 2 };
    await processWhatsAppJobForTest({ dbPool: db, provider, settings: enabledSettings, ownership: { connected } });
    let deferred = (await db.query("SELECT status, attempts, last_error FROM whatsapp_notification_jobs WHERE id = 701")).rows[0];
    assert.deepEqual([deferred.status, Number(deferred.attempts), deferred.last_error], ["pending", 0, null]);
    await processWhatsAppJobForTest({ dbPool: db, provider, settings: enabledSettings, ownership: { connected } });
    deferred = (await db.query("SELECT status, attempts, last_error FROM whatsapp_notification_jobs WHERE id = 701")).rows[0];
    assert.deepEqual([deferred.status, Number(deferred.attempts), deferred.last_error], ["pending", 0, null]);

    await db.query("UPDATE whatsapp_notification_jobs SET next_attempt_at = NOW() WHERE id = 701");
    await processWhatsAppJobForTest({ dbPool: db, provider, settings: enabledSettings });
    assert.equal((await db.query("SELECT status FROM whatsapp_notification_jobs WHERE id = 701")).rows[0].status, "sent");
    assert.equal(providerCalls.length, 1);
  });
});
