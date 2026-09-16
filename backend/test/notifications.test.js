import test from "node:test";
import assert from "node:assert/strict";
import { formatAggregatedNotification, getAggregatedNotificationRecipients, upsertAggregatedNotification } from "../src/services/notifications.js";
import { NotificationType } from "../src/services/notificationTypes.js";
import { recordWhatsAppConnectionNotification } from "../src/services/notifications.js";

test("formats aggregated notifications with singular and plural copy", () => {
  assert.equal(
    formatAggregatedNotification({ type: NotificationType.ATTENDANCE_ABSENCE, groupName: "Grade 7-A", studentCount: 1 }).message,
    "1 student in Grade 7-A missed today's session."
  );
  assert.equal(
    formatAggregatedNotification({ type: NotificationType.LOW_EXAM_GRADE, groupName: "Grade 7-A", examName: "Midterm Exam", studentCount: 5, threshold: 50 }).message,
    "5 students in Grade 7-A scored below 50% in Midterm Exam."
  );
});

test("aggregated notification upsert creates once and deduplicates retries", async () => {
  const calls = [];
  let first = true;
  const db = async (sql, params) => {
    calls.push({ sql, params });
    return { rowCount: 1, rows: [{ id: 42, inserted: first }] };
  };
  const input = {
    type: NotificationType.UNPAID_FEES,
    groupId: 7,
    referenceId: "2026-10",
    groupName: "Grade 7-A",
    studentCount: 8,
    metadata: { billingPeriod: "2026-10", paymentStatus: "unpaid" },
    recipients: [{ id: 3 }],
    db
  };
  const created = await upsertAggregatedNotification(input);
  first = false;
  const retried = await upsertAggregatedNotification(input);

  assert.deepEqual(created, { created: 1, deduplicated: 0, skipped: false });
  assert.deepEqual(retried, { created: 0, deduplicated: 1, skipped: false });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].params[0], 3);
  assert.equal(calls[0].params[1], NotificationType.UNPAID_FEES);
  assert.equal(calls[0].params[8], "2026-10");
  assert.match(calls[0].params[11], /^unpaid_fees:recipient:3:group:7:reference:2026-10$/);
});

test("aggregated notification upsert skips zero-result groups", async () => {
  let calls = 0;
  const result = await upsertAggregatedNotification({
    type: NotificationType.ATTENDANCE_ABSENCE,
    groupId: 7,
    referenceId: "123",
    groupName: "Grade 7-A",
    studentCount: 0,
    recipients: [3],
    db: async () => { calls += 1; return { rows: [] }; }
  });
  assert.deepEqual(result, { created: 0, deduplicated: 0, skipped: true });
  assert.equal(calls, 0);
});

test("aggregated recipients preserve permissions and group scope", async () => {
  const recipients = await getAggregatedNotificationRecipients({
    type: NotificationType.UNPAID_FEES,
    groupId: 7,
    db: async () => ({ rows: [
      { id: 1, role: "owner", permissions: [], group_ids: [] },
      { id: 2, role: "staff", permissions: ["payments.reports.view", "dashboard.alerts.view"], group_ids: [7] },
      { id: 3, role: "staff", permissions: ["dashboard.alerts.view"], group_ids: [7] },
      { id: 4, role: "staff", permissions: ["payments.reports.view", "dashboard.alerts.view"], group_ids: [8] }
    ] })
  });
  assert.deepEqual(recipients.map((recipient) => recipient.id), [1, 2]);
});

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
  const notificationInserts = inserts.filter(({ sql }) => sql.includes("INSERT INTO notifications"));
  assert.equal(notificationInserts.length, 2);
  assert.deepEqual(JSON.parse(notificationInserts[0].params[1]), {
    status: "disconnected",
    reason: "logged_out",
    phoneNumber: "+201012345678"
  });
  assert.equal(notificationInserts[0].params[0], 1);
  assert.equal(notificationInserts[1].params[0], 2);
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

test("suppresses repeated WhatsApp disconnect notifications and emails during the cooldown", async () => {
  let gateClaimed = false;
  let emailCount = 0;
  const db = async (sql) => {
    if (sql.startsWith("SELECT id, role, permissions, email")) {
      return { rows: [{ id: 1, role: "owner", permissions: [], email: "owner@example.com" }] };
    }
    if (sql.includes("RETURNING id")) {
      if (gateClaimed) return { rowCount: 0, rows: [] };
      gateClaimed = true;
      return { rowCount: 1, rows: [{ id: 1 }] };
    }
    return { rowCount: 1, rows: [] };
  };
  const options = {
    reason: "connection_closed",
    db,
    getEmailConfig: async () => ({ providerConfigured: true, provider: "resend", fromEmail: "no-reply@example.com", senderName: "Abdrabo System", apiKey: "re_test" }),
    sendEmail: async () => { emailCount += 1; }
  };

  const first = await recordWhatsAppConnectionNotification(options);
  const second = await recordWhatsAppConnectionNotification(options);

  assert.equal(first.recorded, 1);
  assert.equal(first.sent, 1);
  assert.equal(second.recorded, 0);
  assert.equal(second.sent, 0);
  assert.equal(second.suppressed, true);
  assert.equal(emailCount, 1);
});
