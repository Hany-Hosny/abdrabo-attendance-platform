import test from "node:test";
import assert from "node:assert/strict";
import { buildStudentAttention } from "../src/services/studentAttention.js";
import { searchStudents } from "../src/services/studentSearch.js";
import { syncNotificationsForUser } from "../src/services/notifications.js";

test("student attention uses configured thresholds and transparent reasons", () => {
  const result = buildStudentAttention({
    attendanceSessions: 10,
    attendanceAttended: 6,
    evaluationAverage: 58,
    thresholds: { attendanceAlert: 70, evaluationAlert: 60 }
  });
  assert.equal(result.attendanceRate, 60);
  assert.equal(result.reasons.map((reason) => reason.type).join(","), "attendance,evaluation");
  assert.deepEqual(result.reasons[0], { type: "attendance", targetSection: "attendance", value: 60, threshold: 70 });
});

test("student attention does not invent payment reasons when payment data is not authorized", () => {
  const result = buildStudentAttention({
    paymentOverdue: true,
    paymentRemaining: 500,
    includePayment: false
  });
  assert.deepEqual(result.reasons, []);
});

test("student attention safely handles zero denominators", () => {
  const result = buildStudentAttention({ attendanceSessions: 0, attendanceAttended: 0, evaluationAverage: null });
  assert.equal(result.attendanceRate, null);
  assert.equal(result.evaluationRate, null);
  assert.deepEqual(result.reasons, []);
});

test("global student search is bounded and returns only minimal fields", async () => {
  let receivedParams;
  const result = await searchStudents("Ahmed", {
    limit: 200,
    db: async (_sql, params) => {
      receivedParams = params;
      return { rows: [{ id: 7, full_name: "Ahmed Ali", student_code: "A0007", student_serial: "A-0007", group_id: 2, group_name: "Prep 1", grade_level: "Prep 1", is_active: true, phone: "01000000000", guardian_phone: "01111111111" }] };
    }
  });
  assert.equal(receivedParams[2], 20);
  assert.deepEqual(result[0], { id: 7, name: "Ahmed Ali", studentCode: "A0007", studentSerial: "A-0007", groupId: 2, groupName: "Prep 1", gradeLevel: "Prep 1", isActive: true });
  assert.equal(Object.hasOwn(result[0], "phone"), false);
});

test("notification synchronization performs no data access without notification permissions", async () => {
  let calls = 0;
  await syncNotificationsForUser({ id: 3, role: "staff", permissions: [] }, async () => { calls += 1; return { rows: [] }; });
  assert.equal(calls, 0);
});
