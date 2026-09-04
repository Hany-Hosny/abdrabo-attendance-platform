import test from "node:test";
import assert from "node:assert/strict";
import { recordWhatsAppConnectionNotification } from "../src/services/notifications.js";

test("records WhatsApp disconnect alerts only for active users with WhatsApp view access", async () => {
  const inserts = [];
  const db = async (sql, params = []) => {
    if (sql.startsWith("SELECT id, role, permissions")) {
      return {
        rows: [
          { id: 1, role: "owner", permissions: [] },
          { id: 2, role: "staff", permissions: ["whatsapp.view"] },
          { id: 3, role: "staff", permissions: [] }
        ]
      };
    }
    inserts.push({ sql, params });
    return { rowCount: 1 };
  };

  const result = await recordWhatsAppConnectionNotification({
    reason: "logged_out",
    phoneNumber: "+201012345678",
    db
  });

  assert.equal(result.recorded, 2);
  assert.equal(inserts.length, 2);
  assert.deepEqual(JSON.parse(inserts[0].params[1]), {
    status: "disconnected",
    reason: "logged_out",
    phoneNumber: "+201012345678"
  });
  assert.equal(inserts[0].params[0], 1);
  assert.equal(inserts[1].params[0], 2);
});

test("emails every active user with a valid email for an unexpected WhatsApp disconnect", async () => {
  const sent = [];
  const db = async (sql) => {
    if (sql.startsWith("SELECT id, role, permissions, email")) {
      return {
        rows: [
          { id: 1, role: "owner", permissions: [], email: "owner@example.com" },
          { id: 2, role: "staff", permissions: ["whatsapp.view"], email: "staff@example.com" },
          { id: 3, role: "staff", permissions: [], email: "no-access@example.com" },
          { id: 4, role: "staff", permissions: [], email: "not-an-email" }
        ]
      };
    }
    return { rowCount: 1, rows: [] };
  };

  const result = await recordWhatsAppConnectionNotification({
    reason: "connection_closed",
    phoneNumber: "+201012345678",
    db,
    getEmailConfig: async () => ({
      providerConfigured: true,
      provider: "resend",
      fromEmail: "no-reply@example.com",
      senderName: "Abdrabo System",
      apiKey: "re_test"
    }),
    sendEmail: async (message) => { sent.push(message); }
  });

  assert.equal(result.recorded, 2);
  assert.equal(result.sent, 3);
  assert.equal(result.failed, 0);
  assert.deepEqual(sent.map((message) => message.to), ["owner@example.com", "staff@example.com", "no-access@example.com"]);
  assert.equal(sent[0].subject, "WhatsApp connection alert - action required");
  assert.match(sent[0].text, /WhatsApp connection alert/);
  assert.match(sent[0].text, /\+20\*\*\*\*78/);
  assert.equal(sent[0].text.includes("+201012345678"), false);
});

test("does not email users for a deliberate WhatsApp logout", async () => {
  let emailCount = 0;
  const db = async (sql) => {
    if (sql.startsWith("SELECT id, role, permissions, email")) {
      return { rows: [{ id: 1, role: "owner", permissions: [], email: "owner@example.com" }] };
    }
    return { rowCount: 1, rows: [] };
  };

  const result = await recordWhatsAppConnectionNotification({
    reason: "manual_disconnect",
    db,
    getEmailConfig: async () => ({ providerConfigured: true }),
    sendEmail: async () => { emailCount += 1; }
  });

  assert.equal(result.recorded, 1);
  assert.equal(result.sent, 0);
  assert.equal(emailCount, 0);
});
