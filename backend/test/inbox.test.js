import test from "node:test";
import assert from "node:assert/strict";
import { isEligibleInboxReplyRecipient, serializeInboxThread } from "../src/routes/inbox.js";

test("inbox metadata distinguishes registered students from public inquiry data", () => {
  const registered = serializeInboxThread({ id: 1, student_id: 9, student_is_active: true, student_deleted_at: null, full_name: "Student", student_code: "S-9", student_serial: "009", group_name: "Group A", grade_level: "Grade 8", public_name: "Submitted name", public_phone: "01000000000", unread_count: 2 });
  assert.equal(registered.source_type, "registered_student");
  assert.equal(registered.reply_allowed, true);
  assert.equal(registered.student_id, 9);
  assert.equal(registered.studentId, 9);
  assert.equal(registered.full_name, "Student");
  assert.equal(registered.student_code, "S-9");
  assert.equal(registered.group_name, "Group A");
  assert.equal(registered.grade_level, "Grade 8");
  assert.equal(registered.public_name, null);
  assert.equal(registered.public_phone, null);
  assert.equal(registered.read_status, "unread");
});

test("public inquiry metadata exposes submitted identity only and can never be replied to", () => {
  const thread = serializeInboxThread({ id: 2, student_id: null, student_is_active: null, student_deleted_at: null, full_name: null, student_code: null, group_name: null, grade_level: null, public_name: "External", public_phone: "01012345678", unread_count: 0 });
  assert.equal(thread.source_type, "public_inquiry");
  assert.equal(thread.reply_allowed, false);
  assert.equal(thread.public_name, "External");
  assert.equal(thread.public_phone, "01012345678");
  assert.equal(thread.student_code, null);
  assert.equal(thread.group_name, null);
  assert.equal(thread.grade_level, null);
  assert.equal(thread.read_status, "read");
  assert.equal(isEligibleInboxReplyRecipient(thread), false);
});

test("inactive or deleted registered accounts cannot receive internal replies", () => {
  assert.equal(isEligibleInboxReplyRecipient({ student_id: 9, student_is_active: false, student_deleted_at: null }), false);
  assert.equal(isEligibleInboxReplyRecipient({ student_id: 9, student_is_active: true, student_deleted_at: new Date() }), false);
  assert.equal(isEligibleInboxReplyRecipient({ student_id: 9, student_is_active: true, student_deleted_at: null }), true);
});
