import test from "node:test";
import assert from "node:assert/strict";
import { calculateAbsenceStreak } from "../src/services/attendanceFinalizer.js";
import { authenticatedStudent } from "../src/services/studentAuth.js";
import { createStudentToken } from "../src/services/auth.js";
import { normalizeManualFreezeReason } from "../src/routes/adminAcademic.js";

test("absence freeze streak counts only consecutive persisted absences", () => {
  assert.equal(calculateAbsenceStreak([{ status: "absent" }, { status: "absent" }, { status: "absent" }]), 3);
  assert.equal(calculateAbsenceStreak([{ status: "absent" }, { status: "present" }, { status: "absent" }]), 1);
  assert.equal(calculateAbsenceStreak([{ status: "absent" }, { status: "late" }, { status: "absent" }]), 1);
  assert.equal(calculateAbsenceStreak([{ status: "absent" }, { status: "excused" }, { status: "absent" }]), 1);
});

test("unresolved, rejected, and missing attendance records do not advance the streak", () => {
  assert.equal(calculateAbsenceStreak([{ status: "absent" }, { status: "pending_review" }, { status: "absent" }, { status: "rejected" }, { status: "absent" }]), 1);
  assert.equal(calculateAbsenceStreak([{ status: "absent" }, {}, { status: "absent" }]), 1);
});

test("a frozen student token is rejected with an account_frozen status", async () => {
  const req = { headers: { authorization: `Bearer ${createStudentToken({ id: 42 })}` } };
  const student = await authenticatedStudent(req, async () => ({
    rowCount: 1,
    rows: [{ id: 42, group_id: 7, is_active: true, absence_frozen: true }]
  }));
  assert.equal(student, null);
  assert.equal(req.studentAuthStatus, "account_frozen");
});

test("manual freeze reasons are bounded, text-only, and canonical when empty", () => {
  assert.equal(normalizeManualFreezeReason("  Parent <script>alert(1)</script>  "), "Parent alert(1)");
  assert.equal(normalizeManualFreezeReason("   "), "manual_freeze");
  assert.equal(normalizeManualFreezeReason("x".repeat(250)).length, 200);
});
