import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  extractExternalMessageText,
  handleInboundExternalMessage,
  isIgnoredExternalJid,
  normalizeExternalPhone,
  resolveExternalSenderJid,
  deleteAllExternalConversations
} from "../src/services/externalMessaging.js";

const { Pool } = pg;
const execFileAsync = promisify(execFile);
const integrationTest = process.env.TEST_DATABASE_URL ? test : test.skip;

function databaseUrl(database) {
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

test("external phone normalization collapses Egyptian local and international forms", () => {
  assert.equal(normalizeExternalPhone("01012345678"), "+201012345678");
  assert.equal(normalizeExternalPhone("00201012345678"), "+201012345678");
  assert.equal(normalizeExternalPhone("+201012345678"), "+201012345678");
  assert.equal(normalizeExternalPhone("not-a-phone"), null);
});

test("Baileys external message filtering only extracts supported text and ignores non-chat JIDs", () => {
  assert.equal(extractExternalMessageText({ message: { conversation: "hello" } }), "hello");
  assert.equal(extractExternalMessageText({ message: { extendedTextMessage: { text: "reply" } } }), "reply");
  assert.equal(isIgnoredExternalJid("12345@g.us"), true);
  assert.equal(isIgnoredExternalJid("12345@broadcast"), true);
  assert.equal(isIgnoredExternalJid("201012345678@s.whatsapp.net"), false);
});

test("Baileys LID sender resolution uses the active mapping store", async () => {
  const calls = [];
  const mapping = { getPNForLID: async (jid) => { calls.push(jid); return "201012345678@s.whatsapp.net"; } };
  assert.equal(await resolveExternalSenderJid("123456789@lid", mapping), "201012345678@s.whatsapp.net");
  assert.deepEqual(calls, ["123456789@lid"]);
  assert.equal(await resolveExternalSenderJid("201012345678@s.whatsapp.net", mapping), "201012345678@s.whatsapp.net");
  assert.equal(await resolveExternalSenderJid("123456789@lid", { getPNForLID: async () => null }), null);
});

test("delete all external conversations is transactional, preserves queue history, and audits counts only", async () => {
  const calls = [];
  const audits = [];
  const client = {
    query: async (sql) => {
      calls.push(sql);
      if (sql.includes("SELECT")) return { rows: [{ conversations: 2, messages: 3 }] };
      return { rowCount: 2 };
    },
    release() {}
  };
  const dbPool = { connect: async () => client };
  const result = await deleteAllExternalConversations({ actorId: 7, dbPool, audit: async (entry) => audits.push(entry) });
  assert.deepEqual(result, { conversationCount: 2, messageCount: 3 });
  assert.equal(calls[0], "BEGIN");
  assert.ok(calls.some((sql) => sql.includes("DELETE FROM external_messages")));
  assert.ok(calls.some((sql) => sql.includes("DELETE FROM external_conversations")));
  assert.equal(calls.at(-1), "COMMIT");
  assert.equal(calls.some((sql) => sql.includes("whatsapp_notification_jobs")), false);
  assert.deepEqual(audits[0], { action: "external_all_conversations_deleted", actorId: 7, details: { deleted_conversation_count: 2, deleted_message_count: 3 }, request: null });
  assert.equal(JSON.stringify(audits[0]).includes("phone"), false);
  assert.equal(JSON.stringify(audits[0]).includes("body"), false);
});

test("delete all external conversations rolls back when the conversation delete fails", async () => {
  const calls = [];
  const client = {
    query: async (sql) => {
      calls.push(sql);
      if (sql.includes("SELECT")) return { rows: [{ conversations: 1, messages: 1 }] };
      if (sql.includes("external_conversations")) throw new Error("simulated_failure");
      return { rowCount: 1 };
    },
    release() {}
  };
  await assert.rejects(() => deleteAllExternalConversations({ dbPool: { connect: async () => client }, audit: async () => { throw new Error("audit_should_not_run"); } }), /simulated_failure/);
  assert.equal(calls.at(-1), "ROLLBACK");
});

integrationTest("external messaging migration is additive and repeatable", async () => {
  const database = `abdrabo_external_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl("postgres"), max: 2 });
  const target = databaseUrl(database);
  try {
    await admin.query(`CREATE DATABASE ${database}`);
    const run = () => execFileAsync("node", ["src/db/migrate.js"], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: { ...process.env, NODE_ENV: "test", DATABASE_URL: target },
      maxBuffer: 2 * 1024 * 1024
    });
    await run();
    await run();
    const db = new Pool({ connectionString: target, max: 2 });
    try {
      const tables = await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('external_contacts','external_conversations','external_messages') ORDER BY table_name`);
      assert.deepEqual(tables.rows.map((row) => row.table_name), ["external_contacts", "external_conversations", "external_messages"]);
      const constraint = await db.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'whatsapp_notification_jobs_notification_type_check'`);
      assert.match(constraint.rows[0].definition, /external_message/);
    } finally { await db.end(); }
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${database}`).catch(() => undefined);
    await admin.end();
  }
});

integrationTest("known external inbound messages are stored once and unknown senders stay unmatched", async () => {
  const db = new Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 2 });
  try {
    await db.query(`
      CREATE TEMP TABLE external_contacts (id BIGSERIAL PRIMARY KEY, canonical_phone TEXT UNIQUE NOT NULL, display_phone TEXT, display_name TEXT, source TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TEMP TABLE external_conversations (id BIGSERIAL PRIMARY KEY, external_contact_id BIGINT NOT NULL, status TEXT NOT NULL DEFAULT 'open', last_message_at TIMESTAMPTZ, last_message_preview TEXT, updated_at TIMESTAMPTZ DEFAULT NOW());
      CREATE TEMP TABLE external_messages (id BIGSERIAL PRIMARY KEY, external_conversation_id BIGINT NOT NULL, direction TEXT NOT NULL, body TEXT NOT NULL, is_read BOOLEAN DEFAULT FALSE, delivery_status TEXT DEFAULT 'pending', provider_message_id TEXT UNIQUE, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
      INSERT INTO external_contacts (canonical_phone, display_phone, display_name) VALUES ('+201012345678', '01012345678', 'External');
      INSERT INTO external_conversations (external_contact_id) VALUES (1);
    `);
    const audit = async () => undefined;
    const first = await handleInboundExternalMessage({ phone: "00201012345678", body: "hello", providerMessageId: "wamid-1", dbPool: db, audit });
    assert.equal(first.handled, true);
    assert.equal(first.duplicate, undefined);
    const duplicate = await handleInboundExternalMessage({ phone: "+201012345678", body: "hello", providerMessageId: "wamid-1", dbPool: db, audit });
    assert.equal(duplicate.duplicate, true);
    const unknown = await handleInboundExternalMessage({ phone: "01112345678", body: "unknown", providerMessageId: "wamid-2", dbPool: db, audit });
    assert.deepEqual(unknown, { handled: false, reason: "unmatched" });
    const stored = await db.query("SELECT COUNT(*)::int AS count, COUNT(*) FILTER (WHERE is_read = FALSE)::int AS unread FROM external_messages");
    assert.deepEqual(stored.rows[0], { count: 1, unread: 1 });
  } finally {
    await db.end();
  }
});
