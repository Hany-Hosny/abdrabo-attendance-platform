import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import { reserveWhatsAppSendSlot } from "../src/services/whatsapp.js";

const { Pool } = pg;
const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

async function withGovernorDatabase(run) {
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
  const schema = `whatsapp_governor_${crypto.randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 8, options: `-c search_path=${schema}` });
  try {
    await db.query(`
      CREATE TABLE whatsapp_settings (
        id INTEGER PRIMARY KEY,
        auto_send BOOLEAN NOT NULL,
        attendance_notifications_enabled BOOLEAN NOT NULL,
        templates JSONB NOT NULL DEFAULT '[]'::jsonb,
        grade_templates JSONB NOT NULL DEFAULT '[]'::jsonb,
        receipt_templates JSONB NOT NULL DEFAULT '[]'::jsonb,
        advance_payment_templates JSONB NOT NULL DEFAULT '[]'::jsonb,
        min_delay_seconds INTEGER NOT NULL,
        max_delay_seconds INTEGER NOT NULL,
        max_messages_per_hour INTEGER NOT NULL,
        batch_size INTEGER NOT NULL,
        batch_cooldown_seconds INTEGER NOT NULL,
        reconnect_cooldown_seconds INTEGER NOT NULL
      );
      CREATE TABLE whatsapp_send_slots (
        session_key TEXT PRIMARY KEY,
        next_available_at TIMESTAMPTZ,
        batch_count INTEGER NOT NULL DEFAULT 0,
        batch_cooldown_until TIMESTAMPTZ,
        reconnect_cooldown_until TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE whatsapp_send_rate_events (
        id BIGSERIAL PRIMARY KEY,
        session_key TEXT NOT NULL,
        reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      INSERT INTO whatsapp_settings
        (id, auto_send, attendance_notifications_enabled, min_delay_seconds, max_delay_seconds,
         max_messages_per_hour, batch_size, batch_cooldown_seconds, reconnect_cooldown_seconds)
      VALUES (1, TRUE, TRUE, 30, 30, 50, 25, 300, 300);
    `);
    return await run(db);
  } finally {
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => undefined);
    await admin.end();
  }
}

async function resetSlot(db) {
  await db.query("INSERT INTO whatsapp_send_slots (session_key) VALUES ('local_dev') ON CONFLICT (session_key) DO NOTHING");
  await db.query("UPDATE whatsapp_send_slots SET next_available_at = NOW() - INTERVAL '1 second', batch_count = 0, batch_cooldown_until = NULL, reconnect_cooldown_until = NULL WHERE session_key = 'local_dev'");
}

async function slotTime(db) {
  return new Date((await db.query("SELECT next_available_at FROM whatsapp_send_slots WHERE session_key = 'local_dev'")).rows[0].next_available_at).getTime();
}

integrationTest("live delay settings are read on every reservation without restart", async () => {
  await withGovernorDatabase(async (db) => {
    await resetSlot(db);
    await reserveWhatsAppSendSlot(null, db);
    const firstDelay = (await slotTime(db)) - Date.now();
    assert.ok(firstDelay >= 29_000 && firstDelay <= 31_000, `expected ~30s, got ${firstDelay}ms`);

    await db.query("UPDATE whatsapp_settings SET min_delay_seconds = 60, max_delay_seconds = 60");
    await resetSlot(db);
    await reserveWhatsAppSendSlot(null, db);
    const secondDelay = (await slotTime(db)) - Date.now();
    assert.ok(secondDelay >= 59_000 && secondDelay <= 61_000, `expected ~60s, got ${secondDelay}ms`);
  });
});

integrationTest("random reservations remain inside the live 60-90 second range", async () => {
  await withGovernorDatabase(async (db) => {
    await db.query("UPDATE whatsapp_settings SET min_delay_seconds = 60, max_delay_seconds = 90, batch_size = 1000");
    for (let index = 0; index < 8; index += 1) {
      await resetSlot(db);
      await reserveWhatsAppSendSlot(null, db);
      const delay = (await slotTime(db)) - Date.now();
      assert.ok(delay >= 59_000 && delay <= 91_000, `reservation ${index} outside range: ${delay}ms`);
    }
  });
});

integrationTest("hourly cap and batch cooldown are atomic across concurrent reservations", async () => {
  await withGovernorDatabase(async (db) => {
    await db.query("UPDATE whatsapp_settings SET min_delay_seconds = 2, max_delay_seconds = 2, max_messages_per_hour = 1, batch_size = 1, batch_cooldown_seconds = 300");
    await resetSlot(db);
    const results = await Promise.all([
      reserveWhatsAppSendSlot(null, db),
      reserveWhatsAppSendSlot(null, db)
    ]);
    assert.equal(results.filter((result) => result.reserved).length, 1);
    assert.equal(results.filter((result) => !result.reserved && result.reason === "hourly_cap").length, 1);
  });
});

integrationTest("reconnect cooldown blocks reservation without touching queued jobs", async () => {
  await withGovernorDatabase(async (db) => {
    await resetSlot(db);
    await db.query("UPDATE whatsapp_send_slots SET reconnect_cooldown_until = NOW() + INTERVAL '5 minutes'");
    const result = await reserveWhatsAppSendSlot(null, db);
    assert.equal(result.reserved, false);
    assert.equal(result.reason, "reconnect_cooldown");
    assert.ok(result.waitMs >= 299_000);
  });
});
