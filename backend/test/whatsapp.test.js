import test from "node:test";
import assert from "node:assert/strict";
import { absenceCorrectionTransition, applyTemplate, buildStudentPortalLink, buildWhatsAppDisplayReference, enqueueAdvancePaymentNotificationInTransaction, enqueueAttendanceNotificationForTest, enqueueCancellationNotificationsInTransaction, enqueueCustomWhatsAppMessage, enqueueGradeNotificationInTransaction, enqueueReceiptNotificationInTransaction, formatWhatsAppMonthList, getWhatsAppSettings, gradeQueuePreviewPayload, isRetryableWhatsAppNotificationJob, normalizeEgyptianPhone, normalizeManualRetryReason, paymentMonthsValue, resolveWhatsAppTemplate, updateAttendanceNotificationsEnabled, validateWhatsAppSettings, validateWhatsAppTemplate } from "../src/services/whatsapp.js";
import { WHATSAPP_TEMPLATE_CATALOG, WHATSAPP_TEMPLATE_CATEGORIES, normalizeStudentGender } from "../src/services/whatsappTemplateCatalog.js";
import { hasPermission } from "../src/services/rbac.js";
import { createStudentPortalAccessToken, hashStudentPortalAccessToken } from "../src/services/auth.js";
import { queueAbsenceNotifications } from "../src/services/attendanceFinalizer.js";

test("normalizes common Egyptian guardian phone formats", () => {
  assert.equal(normalizeEgyptianPhone("01012345678"), "+201012345678");
  assert.equal(normalizeEgyptianPhone("+20 1012345678"), "+201012345678");
  assert.equal(normalizeEgyptianPhone("٠١٠١٢٣٤٥٦٧٨"), "+201012345678");
  assert.equal(normalizeEgyptianPhone("012345"), null);
});

test("custom WhatsApp enqueue resolves canonical student, stores sender, and is idempotent", async () => {
  const calls = [];
  const existing = [];
  const db = async (sql, values = []) => {
    calls.push({ sql, values });
    if (sql.includes("WHERE idempotency_key")) return { rowCount: existing.length, rows: existing };
    if (sql.includes("FROM students WHERE id")) return { rowCount: 1, rows: [{ id: 21, full_name: "QA Student", student_code: "Q-21", guardian_phone: "01012345678", is_active: true, deleted_at: null, whatsapp_opted_out: false }] };
    if (sql.includes("INSERT INTO whatsapp_notification_jobs")) {
      const row = { id: 91, status: "pending", student_id: values[0], created_at: new Date().toISOString() };
      existing.push(row);
      return { rowCount: 1, rows: [row] };
    }
    throw new Error(`unexpected_query:${sql}`);
  };
  const first = await enqueueCustomWhatsAppMessage({ studentId: 21, message: "  مرحباً 👋  ", actorId: 7, idempotencyKey: "custom-message-key-01", db, wake: false });
  const insert = calls.find((call) => call.sql.includes("INSERT INTO whatsapp_notification_jobs"));
  assert.equal(first.status, "pending");
  assert.match(insert.sql, /created_by_teacher_id/);
  assert.equal(insert.values[1], 7);
  assert.equal(insert.values[3], "+201012345678");
  assert.equal(JSON.parse(insert.values[4]).message, "مرحباً 👋");
  const replay = await enqueueCustomWhatsAppMessage({ studentId: 21, message: "مرحباً 👋", actorId: 7, idempotencyKey: "custom-message-key-01", db, wake: false });
  assert.equal(replay.duplicate, true);
  assert.equal(calls.filter((call) => call.sql.includes("INSERT INTO whatsapp_notification_jobs")).length, 1);
});

test("custom WhatsApp enqueue rejects empty, oversized, inactive, opted-out, and phone-less recipients", async () => {
  async function run(message, student) {
    return enqueueCustomWhatsAppMessage({ studentId: 21, message, actorId: 7, idempotencyKey: "custom-message-key-02", wake: false, db: async (sql) => {
      if (sql.includes("WHERE idempotency_key")) return { rowCount: 0, rows: [] };
      if (sql.includes("FROM students WHERE id")) return { rowCount: student ? 1 : 0, rows: student ? [student] : [] };
      throw new Error("unexpected_insert");
    } });
  }
  const valid = { id: 21, guardian_phone: "01012345678", is_active: true, deleted_at: null, whatsapp_opted_out: false };
  await assert.rejects(run(" \u0000 ", valid), /custom_message_empty/);
  await assert.rejects(run("x".repeat(2001), valid), /custom_message_too_long/);
  await assert.rejects(run("hi", null), /custom_message_student_ineligible/);
  await assert.rejects(run("hi", { ...valid, is_active: false }), /custom_message_student_ineligible/);
  await assert.rejects(run("hi", { ...valid, whatsapp_opted_out: true }), /custom_message_opted_out/);
  await assert.rejects(run("hi", { ...valid, guardian_phone: "bad" }), /custom_message_invalid_phone/);
});

test("replaces attendance, portal, grade, receipt, and advance placeholders", () => {
  const template = "{student_name}|{student_code}|{portal_link}|{date}|{time}|{group_name}|{ref_code}|{exam_title}|{score}|{max_score}|{percentage}|{amount_paid}|{month}|{months}|{receipt_number}";
  assert.equal(applyTemplate(template, {
    student_name: "Ahmed", student_code: "A-4260", portal_link: "https://example.com/student/A-4260",
    date: "04/09/2026", time: "01:29 AM", group_name: "Group A", ref_code: "ATT-1",
    exam_title: "Math", score: 9, max_score: 10, percentage: "90", amount_paid: "500.00", month: "2026-09", months: "2026-10, 2026-11", receipt_number: "P-00000001"
  }), "Ahmed|A-4260|https://example.com/student/A-4260|04/09/2026|01:29 AM|Group A|ATT-1|Math|9|10|90|500.00|2026-09|2026-10, 2026-11|P-00000001");
});

test("builds compact display references without changing canonical references", () => {
  const date = "2026-09-19T12:00:00.000Z";
  assert.equal(buildWhatsAppDisplayReference({ type: "receipt", date, id: 851 }), "PAY-260919-851");
  assert.equal(buildWhatsAppDisplayReference({ type: "advance_payment", date, id: 862 }), "ADV-260919-862");
  assert.equal(buildWhatsAppDisplayReference({ type: "attendance", date, id: 145 }), "ATT-260919-145");
  assert.equal(buildWhatsAppDisplayReference({ type: "absence", date, id: 146 }), "ABS-260919-146");
  assert.equal(buildWhatsAppDisplayReference({ type: "grade", date, id: 221 }), "GRD-260919-221");
  assert.equal(buildWhatsAppDisplayReference({ type: "cancellation", date, id: 34 }), "CAN-260919-034");
});

test("renders both placeholder formats and normalizes camelCase keys", () => {
  assert.equal(applyTemplate("{{studentName}} / {student_code} / {{ portal_link }} / {portal-link}", {
    student_name: "Ahmed",
    student_code: "A-4260",
    portal_link: "https://example.com/student/A-4260",
    "portal-link": "https://example.com/student/A-4260"
  }), "Ahmed / A-4260 / https://example.com/student/A-4260 / https://example.com/student/A-4260");
});

test("validates the required placeholder for each WhatsApp template category", () => {
  assert.equal(validateWhatsAppTemplate("attendance", "Hello {student_name}").ok, true);
  assert.equal(validateWhatsAppTemplate("absence", "Absent: {{ student_name }}").ok, true);
  assert.equal(validateWhatsAppTemplate("grade", "Result: {exam_title}").ok, true);
  assert.equal(validateWhatsAppTemplate("receipt", "Paid: {amount_paid}").ok, true);
  assert.equal(validateWhatsAppTemplate("advance_payment", "Months: {months}").ok, true);
  assert.equal(validateWhatsAppTemplate("receipt", "Paid successfully").ok, false);
  assert.equal(validateWhatsAppTemplate("advance_payment", "Paid: {amount_paid}").ok, false);
});

test("catalogue contains forty-eight regular slots and six genuinely neutral fallbacks", () => {
  assert.deepEqual(Object.keys(WHATSAPP_TEMPLATE_CATALOG), WHATSAPP_TEMPLATE_CATEGORIES);
  let regularCount = 0;
  for (const category of WHATSAPP_TEMPLATE_CATEGORIES) {
    for (const audience of ["male", "female"]) {
      assert.equal(WHATSAPP_TEMPLATE_CATALOG[category][audience].length, 4);
      for (const body of WHATSAPP_TEMPLATE_CATALOG[category][audience]) {
        assert.equal(validateWhatsAppTemplate(category, body).ok, true);
        regularCount += 1;
      }
    }
    assert.equal(validateWhatsAppTemplate(category, WHATSAPP_TEMPLATE_CATALOG[category].neutral).ok, true);
    assert.doesNotMatch(WHATSAPP_TEMPLATE_CATALOG[category].neutral, /\b(الطالب|الطالبة|حضر|حضرت|له|لها)\b/);
  }
  assert.equal(regularCount, 48);
});

test("gender normalization maps invalid and unknown legacy values to the neutral route", () => {
  assert.equal(normalizeStudentGender("male"), "male");
  assert.equal(normalizeStudentGender("female"), "female");
  assert.equal(normalizeStudentGender(""), "unknown");
  assert.equal(normalizeStudentGender("other"), "unknown");
  assert.equal(normalizeStudentGender(null), "unknown");
});

test("template validation rejects unknown placeholders and forbidden rendered values", () => {
  assert.equal(validateWhatsAppTemplate("attendance", "Hello {student_name} {unknown}").ok, false);
  assert.equal(validateWhatsAppTemplate("attendance", "Hello {student_name} undefined").ok, false);
  assert.equal(validateWhatsAppTemplate("attendance", "Hello {student_name} {broken").ok, false);
});

test("preview uses synthetic values without duplicating a template reference", async () => {
  const body = WHATSAPP_TEMPLATE_CATALOG.absence.neutral;
  const preview = await resolveWhatsAppTemplate({
    category: "absence",
    audience: "neutral",
    slotNumber: null,
    values: { student_name: "Synthetic Student", group_name: "Sample Group", date: "04/09/2026" },
    db: async () => ({ rows: [{ id: 99, category: "absence", audience: "neutral", slot_number: null, slot_key: "absence:neutral:fallback", is_fallback: true, content_version: 1, message_body: body, is_active: true }] })
  });
  assert.match(preview.message, /Synthetic Student/);
  assert.equal((preview.message.match(/Ref:/g) || []).length, 0);
  assert.match(preview.message, /\[secure-link-preview\]/);
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
  assert.equal(valid.attendance_notifications_enabled, true);
});

test("attendance preference persists and survives WhatsApp settings read normalization", async () => {
  let attendanceEnabled = true;
  const client = {
    async query(sql, values = []) {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rowCount: 0, rows: [] };
      if (sql.includes("SELECT auto_send, attendance_notifications_enabled")) {
        return { rowCount: 1, rows: [{ auto_send: true, attendance_notifications_enabled: attendanceEnabled }] };
      }
      if (sql.includes("INSERT INTO whatsapp_settings")) {
        attendanceEnabled = values[0];
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected setting query: ${sql}`);
    },
    release() {}
  };
  const db = { connect: async () => client };
  assert.equal(await updateAttendanceNotificationsEnabled(false, { db }), false);
  const persisted = await getWhatsAppSettings(async () => ({ rows: [{ auto_send: true, attendance_notifications_enabled: attendanceEnabled }] }));
  assert.equal(persisted.auto_send, true);
  assert.equal(persisted.attendance_notifications_enabled, false);
});

function attendanceQueueDb({ autoSend, attendanceEnabled, status = "present", previous = null }) {
  const inserts = [];
  const db = async (sql, values = []) => {
    if (sql.includes("FROM whatsapp_settings")) return { rowCount: 1, rows: [{ auto_send: autoSend, attendance_notifications_enabled: attendanceEnabled }] };
    if (sql.includes("FROM attendance_records ar")) return { rowCount: 1, rows: [{ attendance_record_id: 707, status, checkin_time: "2026-09-24T10:00:00Z", student_id: 51, student_name: "QA", student_code: "QA-51", guardian_phone: "01012345678", group_name: "QA Group" }] };
    if (sql.includes("SELECT id, status, last_error, ref_code")) return { rowCount: previous ? 1 : 0, rows: previous ? [previous] : [] };
    if (sql.includes("INSERT INTO whatsapp_notification_jobs")) {
      inserts.push({ sql, values });
      return { rowCount: 1, rows: [{ id: 91, status: sql.includes("'skipped'") ? "skipped" : "pending", ref_code: values[6] }] };
    }
    throw new Error(`Unexpected attendance query: ${sql}`);
  };
  return { db, inserts };
}

test("attendance enqueue applies global-first policy to present and late, and leaves disabled jobs terminal", async () => {
  for (const status of ["present", "late"]) {
    const enabled = attendanceQueueDb({ autoSend: true, attendanceEnabled: true, status });
    const queued = await enqueueAttendanceNotificationForTest({ attendanceRecordId: 707, studentId: 51, db: enabled.db });
    assert.equal(queued.queued, true);
    assert.match(enabled.inserts[0].sql, /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6::jsonb, \$7\)/);
    assert.equal(enabled.inserts[0].values[0], "attendance");

    const disabled = attendanceQueueDb({ autoSend: true, attendanceEnabled: false, status });
    const skipped = await enqueueAttendanceNotificationForTest({ attendanceRecordId: 707, studentId: 51, db: disabled.db, send_whatsapp: true });
    assert.equal(skipped.status, "skipped");
    assert.equal(skipped.reason, "attendance_notifications_disabled");
    assert.equal(disabled.inserts[0].values[7], "attendance_notifications_disabled");
    assert.equal(disabled.inserts[0].values[3], 51);

    const reopened = attendanceQueueDb({
      autoSend: true,
      attendanceEnabled: true,
      status,
      previous: { id: 91, status: "skipped", last_error: "attendance_notifications_disabled", ref_code: "ATT-OLD" }
    });
    const terminal = await enqueueAttendanceNotificationForTest({ attendanceRecordId: 707, studentId: 51, db: reopened.db });
    assert.equal(terminal.reason, "already_processed");
    assert.equal(terminal.status, "skipped");
    assert.equal(reopened.inserts.length, 0);
  }
});

test("global Auto Send reason wins over attendance preference", async () => {
  for (const attendanceEnabled of [true, false]) {
    const state = attendanceQueueDb({ autoSend: false, attendanceEnabled });
    const result = await enqueueAttendanceNotificationForTest({ attendanceRecordId: 707, studentId: 51, db: state.db });
    assert.equal(result.status, "skipped");
    assert.equal(result.reason, "auto_send_disabled");
    assert.equal(state.inserts[0].values[7], "auto_send_disabled");
  }
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
  const client = { query: async (sql) => {
    queries.push(sql);
    if (sql.includes("FROM whatsapp_settings")) return { rowCount: 1, rows: [{ auto_send: true }] };
    return { rowCount: 1, rows: [row] };
  } };
  assert.deepEqual(await enqueueGradeNotificationInTransaction(client, { resultId: 10 }), { queued: false, reason: "whatsapp_opted_out" });
  assert.equal(queries.length, 2);

  row.whatsapp_opted_out = false;
  row.is_active = false;
  queries.length = 0;
  assert.deepEqual(await enqueueGradeNotificationInTransaction(client, { resultId: 10 }), { queued: false, reason: "student_inactive" });
  assert.equal(queries.length, 2);

  row.is_active = true;
  row.guardian_phone = "invalid";
  queries.length = 0;
  assert.deepEqual(await enqueueGradeNotificationInTransaction(client, { resultId: 10 }), { queued: false, reason: "invalid_phone" });
  assert.equal(queries.length, 2);
});

test("cancellation notices ignore the attendance-only setting and continue to follow Auto Send", async () => {
  for (const [autoSend, expectedStatus] of [[true, "pending"], [false, "skipped"]]) {
    const inserts = [];
    const client = { query: async (sql, values = []) => {
      if (sql.includes("FROM whatsapp_settings")) return { rowCount: 1, rows: [{ auto_send: autoSend, attendance_notifications_enabled: false }] };
      if (sql.includes("FROM students")) {
        assert.match(sql, /is_active = TRUE/);
        assert.match(sql, /whatsapp_opted_out = FALSE/);
        return { rowCount: 1, rows: [{ id: 22, guardian_phone: "01012345678" }] };
      }
      if (sql.includes("INSERT INTO whatsapp_notification_jobs")) {
        inserts.push({ sql, values });
        return { rowCount: 1, rows: [{ id: 80 }] };
      }
      throw new Error(`Unexpected cancellation queue query: ${sql}`);
    } };
    const result = await enqueueCancellationNotificationsInTransaction(client, {
      session: { id: 17, group_id: 4, group_name: "Group A", starts_at: "2026-09-17T15:00:00Z", cancelled_at: "2026-09-17T14:00:00Z" },
      actorId: 9
    });
    assert.equal(result.autoSend, autoSend);
    assert.equal(autoSend ? result.queuedCount : result.skippedCount, 1);
    assert.equal(inserts.length, 1);
    assert.match(inserts[0].sql, /ON CONFLICT \(cancellation_session_id, student_id\)/);
    assert.equal(inserts[0].values[5], expectedStatus);
    assert.equal(inserts[0].values[6], autoSend ? null : "auto_send_disabled");
    const payload = JSON.parse(inserts[0].values[3]);
    assert.equal(payload.session_id, 17);
    assert.equal(payload.group_name, "Group A");
    assert.ok(payload.scheduled_date && payload.scheduled_time && payload.cancellation_time);
  }
});

test("grade, payment receipt, and advance receipt queues ignore the attendance-only setting", async () => {
  const gradeRow = {
    result_id: 10, student_id: 20, score: 9, note: null, exam_title: "Math", max_score: 10,
    exam_date: "2026-09-24", student_name: "Student", student_code: "S-20",
    guardian_phone: "01012345678", whatsapp_opted_out: false, is_active: true, deleted_at: null
  };
  const gradeInserts = [];
  const gradeClient = { query: async (sql, values = []) => {
    if (sql.includes("FROM whatsapp_settings")) return { rowCount: 1, rows: [{ auto_send: true, attendance_notifications_enabled: false }] };
    if (sql.includes("FROM exam_results er")) return { rowCount: 1, rows: [gradeRow] };
    if (sql.includes("status IN ('pending', 'processing')")) return { rowCount: 0, rows: [] };
    if (sql.includes("INSERT INTO whatsapp_notification_jobs")) { gradeInserts.push({ sql, values }); return { rowCount: 1, rows: [{ id: 80, status: "pending", ref_code: values[4] }] }; }
    if (sql.includes("UPDATE exam_results SET whatsapp_notified = FALSE")) return { rowCount: 1, rows: [] };
    throw new Error(`Unexpected grade query: ${sql}`);
  } };
  const grade = await enqueueGradeNotificationInTransaction(gradeClient, { resultId: 10 });
  assert.equal(grade.queued, true);
  assert.equal(gradeInserts.length, 1);

  for (const [notificationType, enqueue] of [
    ["receipt", enqueueReceiptNotificationInTransaction],
    ["advance_payment", enqueueAdvancePaymentNotificationInTransaction]
  ]) {
    const inserts = [];
    const client = { query: async (sql, values = []) => {
      if (sql.includes("FROM whatsapp_settings")) return { rowCount: 1, rows: [{ auto_send: true, attendance_notifications_enabled: false }] };
      if (sql.includes("FROM payments p")) return { rowCount: 1, rows: [{ payment_id: 23, amount: 500, paid_amount: 500, discount_amount: 0, is_exempt: false, payment_reference: "P-23", payment_months: [{ month: "2026-09-01" }], payment_date: "2026-09-24", paid_at: "2026-09-24T10:00:00Z", student_id: 20, student_name: "Student", student_code: "S-20", guardian_phone: "01012345678" }] };
      if (sql.includes("SELECT id, status, last_error, ref_code")) return { rowCount: 0, rows: [] };
      if (sql.includes("INSERT INTO whatsapp_notification_jobs")) { inserts.push({ sql, values }); return { rowCount: 1, rows: [{ id: 81, status: "pending", ref_code: values[6] }] }; }
      throw new Error(`Unexpected payment query: ${sql}`);
    } };
    const result = await enqueue(client, { paymentId: 23 });
    assert.equal(result.queued, true);
    assert.equal(inserts[0].values[0], notificationType);
  }
});

test("absence finalizer queue ignores attendance preference and follows the global setting", async () => {
  const inserts = [];
  const client = { query: async (sql, values = []) => {
    if (sql.includes("SELECT source_id, status")) return { rowCount: 0, rows: [] };
    if (sql.includes("INSERT INTO whatsapp_notification_jobs")) { inserts.push({ sql, values }); return { rowCount: 1, rows: [] }; }
    throw new Error(`Unexpected absence query: ${sql}`);
  } };
  const result = await queueAbsenceNotifications(client,
    { session_id: 30, group_name: "QA Group", session_date: "2026-09-24" },
    [{ attendance_record_id: 31, student_id: 20, student_name: "Student", student_code: "S-20", guardian_phone: "01012345678" }],
    { autoSend: true, attendanceNotificationsEnabled: false }
  );
  assert.equal(result.queuedCount, 1);
  assert.equal(inserts.length, 1);
  assert.match(inserts[0].sql, /'absence'/);
  assert.match(inserts[0].sql, /'pending'/);
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

test("policy skips are terminal while existing invalid-phone skips remain retryable", () => {
  assert.equal(isRetryableWhatsAppNotificationJob({ status: "skipped", last_error: "auto_send_disabled" }), false);
  assert.equal(isRetryableWhatsAppNotificationJob({ status: "skipped", last_error: "attendance_notifications_disabled" }), false);
  assert.equal(isRetryableWhatsAppNotificationJob({ status: "skipped", last_error: "invalid_phone" }), true);
  assert.equal(isRetryableWhatsAppNotificationJob({ status: "failed", last_error: "provider_error" }), true);
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
