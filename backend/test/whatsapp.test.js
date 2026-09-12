import test from "node:test";
import assert from "node:assert/strict";
import { absenceCorrectionTransition, applyTemplate, buildStudentPortalLink, enqueueGradeNotificationInTransaction, formatWhatsAppMonthList, gradeQueuePreviewPayload, normalizeEgyptianPhone, normalizeManualRetryReason, paymentMonthsValue, validateWhatsAppSettings } from "../src/services/whatsapp.js";
import { hasPermission } from "../src/services/rbac.js";
import { createStudentPortalAccessToken, hashStudentPortalAccessToken } from "../src/services/auth.js";

test("normalizes common Egyptian guardian phone formats", () => {
  assert.equal(normalizeEgyptianPhone("01012345678"), "+201012345678");
  assert.equal(normalizeEgyptianPhone("+20 1012345678"), "+201012345678");
  assert.equal(normalizeEgyptianPhone("٠١٠١٢٣٤٥٦٧٨"), "+201012345678");
  assert.equal(normalizeEgyptianPhone("012345"), null);
});

test("replaces attendance, portal, grade, receipt, and advance placeholders", () => {
  const template = "{student_name}|{student_code}|{portal_link}|{date}|{time}|{group_name}|{ref_code}|{exam_title}|{score}|{max_score}|{percentage}|{amount_paid}|{month}|{months}|{receipt_number}";
  assert.equal(applyTemplate(template, {
    student_name: "Ahmed", student_code: "A-4260", portal_link: "https://example.com/student/A-4260",
    date: "04/09/2026", time: "01:29 AM", group_name: "Group A", ref_code: "ATT-1",
    exam_title: "Math", score: 9, max_score: 10, percentage: "90", amount_paid: "500.00", month: "2026-09", months: "2026-10, 2026-11", receipt_number: "P-00000001"
  }), "Ahmed|A-4260|https://example.com/student/A-4260|04/09/2026|01:29 AM|Group A|ATT-1|Math|9|10|90|500.00|2026-09|2026-10, 2026-11|P-00000001");
});

test("renders both placeholder formats and normalizes camelCase keys", () => {
  assert.equal(applyTemplate("{{studentName}} / {student_code} / {{ portal_link }} / {portal-link}", {
    student_name: "Ahmed",
    student_code: "A-4260",
    portal_link: "https://example.com/student/A-4260",
    "portal-link": "https://example.com/student/A-4260"
  }), "Ahmed / A-4260 / https://example.com/student/A-4260 / https://example.com/student/A-4260");
});

test("creates a short opaque portal link with a hashed one-hour access token", () => {
  const accessToken = createStudentPortalAccessToken();
  const link = buildStudentPortalLink(101, "A-0101", accessToken);
  const parsed = new URL(link);
  assert.match(accessToken, /^[A-Za-z0-9_-]{20,64}$/);
  assert.equal(parsed.pathname, `/p/${accessToken}`);
  assert.equal(parsed.search, "");
  assert.match(hashStudentPortalAccessToken(accessToken), /^[a-f0-9]{64}$/);
  assert.equal(buildStudentPortalLink(0, "A-0101", accessToken), "");
});

test("preserves editable bilingual templates and supports flexible placeholder spelling", () => {
  const settings = validateWhatsAppSettings({
    auto_send: false,
    templates: [
      "Attendance for {student_name} ({student_code})",
      "حضور الطالب {{ student_name }} في {group_name}",
      "تم الحضور: {student_name}"
    ],
    receipt_templates: [
      "Payment {amount_paid} for {student_name}",
      "سداد {amount_paid} للطالب {student_name}",
      "Receipt {{ amount_paid }} - {student_name}"
    ],
    min_delay_seconds: 2,
    max_delay_seconds: 8
  });
  assert.equal(settings.templates[0], "Attendance for {student_name} ({student_code})");
  assert.equal(settings.receipt_templates[0], "Payment {amount_paid} for {student_name}");
  assert.equal(applyTemplate("{studentCode}|{{ portal_link }}|{unknown}", {
    student_code: "A-4260",
    portal_link: "https://example.com/student/A-4260"
  }), "A-4260|https://example.com/student/A-4260|");
});

test("accepts only three or four templates and a 2–60 second delay range", () => {
  const valid = validateWhatsAppSettings({
    auto_send: true,
    templates: ["Template one", "Template two", "Template three"],
    min_delay_seconds: 4,
    max_delay_seconds: 8
  });
  assert.equal(valid.max_delay_seconds, 8);
  assert.throws(() => validateWhatsAppSettings({ ...valid, templates: ["one", "two"] }));
  assert.equal(validateWhatsAppSettings({ ...valid, min_delay_seconds: 2, max_delay_seconds: 60 }).max_delay_seconds, 60);
  assert.throws(() => validateWhatsAppSettings({ ...valid, min_delay_seconds: 1 }));
});

test("accepts and preserves isolated advance-payment templates", () => {
  const settings = validateWhatsAppSettings({
    auto_send: true,
    templates: ["حضور {student_name}", "حضور {student_name}", "حضور {student_name}"],
    advance_payment_templates: ["دفعة {amount_paid} عن {months}", "سداد {amount_paid} شهور {months}", "إيصال {amount_paid} {months}"],
    min_delay_seconds: 2,
    max_delay_seconds: 60
  });
  assert.equal(settings.advance_payment_templates[0], "دفعة {amount_paid} عن {months}");
  assert.equal(settings.advance_payment_templates.length, 3);
});

test("formats one and multiple advance-payment months for both locales", () => {
  assert.equal(formatWhatsAppMonthList("2026-10", "en-US"), "October 2026");
  assert.equal(formatWhatsAppMonthList("2026-10, 2026-11", "en-US"), "October 2026, November 2026");
  assert.match(formatWhatsAppMonthList("2026-10, 2026-11", "ar-EG"), /٢٠٢٦|2026/);
  assert.equal(applyTemplate("{months}", { months: formatWhatsAppMonthList("2026-10, 2026-11", "en-US") }), "October 2026, November 2026");
});

test("normalizes payment months from arrays, JSON, PostgreSQL arrays, and fallback dates", () => {
  assert.equal(paymentMonthsValue([{ month: "2026-10-01" }, { month: "2026-11-01" }]), "2026-10, 2026-11");
  assert.equal(paymentMonthsValue('[{"month":"2026-10-01"},{"month":"2026-11-01"}]'), "2026-10, 2026-11");
  assert.equal(paymentMonthsValue("{2026-10-01,2026-11-01}"), "2026-10, 2026-11");
  assert.equal(paymentMonthsValue(null, null, "2026-12-15T12:00:00Z"), "2026-12");
  assert.match(formatWhatsAppMonthList(null, "ar-EG", "2026-12-15T12:00:00Z"), /ديسمبر/);
});

test("single-grade enqueue rejects opted-out, inactive, and invalid-phone students before creating a job", async () => {
  const row = {
    result_id: 10,
    student_id: 20,
    student_name: "Student",
    student_code: "S-20",
    guardian_phone: "01012345678",
    whatsapp_opted_out: true,
    is_active: true,
    deleted_at: null
  };
  const queries = [];
  const client = { query: async (sql) => { queries.push(sql); return { rowCount: 1, rows: [row] }; } };
  assert.deepEqual(await enqueueGradeNotificationInTransaction(client, { resultId: 10 }), { queued: false, reason: "whatsapp_opted_out" });
  assert.equal(queries.length, 1);

  row.whatsapp_opted_out = false;
  row.is_active = false;
  queries.length = 0;
  assert.deepEqual(await enqueueGradeNotificationInTransaction(client, { resultId: 10 }), { queued: false, reason: "student_inactive" });
  assert.equal(queries.length, 1);

  row.is_active = true;
  row.guardian_phone = "invalid";
  queries.length = 0;
  assert.deepEqual(await enqueueGradeNotificationInTransaction(client, { resultId: 10 }), { queued: false, reason: "invalid_phone" });
  assert.equal(queries.length, 1);
});

test("absence correction fences an in-flight provider call as delivery_unknown", () => {
  assert.deepEqual(absenceCorrectionTransition("pending", null), {
    status: "skipped",
    lastError: "attendance_corrected_before_send"
  });
  assert.deepEqual(absenceCorrectionTransition("processing", null), {
    status: "skipped",
    lastError: "attendance_corrected_before_send"
  });
  assert.deepEqual(absenceCorrectionTransition("processing", "2026-09-12T01:00:00Z"), {
    status: "delivery_unknown",
    lastError: "attendance_correction_during_send"
  });
});

test("manual retry reasons are bounded and normalized before database access", () => {
  assert.deepEqual(normalizeManualRetryReason("  corrected phone number  "), { ok: true, value: "corrected phone number" });
  assert.deepEqual(normalizeManualRetryReason(""), { ok: false, reason: "retry_reason_required" });
  assert.deepEqual(normalizeManualRetryReason("x"), { ok: false, reason: "retry_reason_required" });
  assert.deepEqual(normalizeManualRetryReason("x".repeat(501)), { ok: false, reason: "retry_reason_too_long" });
});

test("grade queue payloads never contain a usable portal token", () => {
  const payload = gradeQueuePreviewPayload({ student_name: "Student", portal_link: "https://example.com/p/old-token" });
  assert.equal(payload.portal_link, "[secure-link-generated-at-send]");
  assert.doesNotMatch(JSON.stringify(payload), /old-token/);
});

test("WhatsApp access can be assigned independently while management includes viewing", () => {
  assert.equal(hasPermission({ role: "staff", permissions: ["whatsapp.view"] }, "whatsapp.view"), true);
  assert.equal(hasPermission({ role: "staff", permissions: ["whatsapp.view"] }, "whatsapp.manage"), false);
  assert.equal(hasPermission({ role: "staff", permissions: ["whatsapp.manage"] }, "whatsapp.view"), true);
});

test("WhatsApp send permissions remain independently assignable", () => {
  const user = { role: "staff", permissions: ["whatsapp.send_grades"] };
  assert.equal(hasPermission(user, "whatsapp.send_grades"), true);
  assert.equal(hasPermission(user, "whatsapp.send_attendance"), false);
  assert.equal(hasPermission(user, "whatsapp.send_receipts"), false);
});
