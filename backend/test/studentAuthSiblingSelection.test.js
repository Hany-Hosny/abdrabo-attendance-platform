import test from "node:test";
import assert from "node:assert/strict";
import {
  consumeGuardianSelectionContext,
  createGuardianSelectionContext,
  findGuardianCandidates,
  publicGuardianSelectionStudent
} from "../src/services/studentPinAuth.js";

const sibling = (overrides = {}) => ({
  id: 1,
  full_name: "QA Sibling Ahmed",
  student_code: "A-1001",
  student_serial: "A-1001",
  scan_serial: "ABD-A1001-000001",
  group_name: "Group 3",
  grade: "Grade 3",
  grade_level: "Grade 3",
  subject: "Math",
  is_active: true,
  deleted_at: null,
  absence_frozen: false,
  guardian_phone: "01012345678",
  pin_hash: null,
  ...overrides
});

test("guardian candidates preserve sibling matches and setup/recovery PIN state", async () => {
  const rows = [sibling(), sibling({ id: 2, full_name: "QA Sibling Salma", student_code: "A-1002" })];
  const setup = await findGuardianCandidates("+20 1012345678", "pin_setup", async (sql) => {
    assert.match(sql, /pin_hash IS NULL/);
    return { rows };
  });
  assert.deepEqual(setup.map((student) => student.id), [1, 2]);

  const recovery = await findGuardianCandidates("٠١٠١٢٣٤٥٦٧٨", "pin_recovery", async (sql) => {
    assert.match(sql, /pin_hash IS NOT NULL/);
    return { rows: [sibling({ pin_hash: "hashed" })] };
  });
  assert.deepEqual(recovery.map((student) => student.id), [1]);
});

test("selection contexts are purpose-bound, server-authoritative, and single-use", () => {
  const context = createGuardianSelectionContext({ purpose: "pin_setup", studentIds: [12, 18] });
  assert.ok(context?.token);
  assert.equal(consumeGuardianSelectionContext({ token: context.token, purpose: "pin_setup", studentId: 99 }), false);
  assert.equal(consumeGuardianSelectionContext({ token: context.token, purpose: "pin_recovery", studentId: 18 }), false);
  assert.equal(consumeGuardianSelectionContext({ token: context.token, purpose: "pin_setup", studentId: 18 }), true);
  assert.equal(consumeGuardianSelectionContext({ token: context.token, purpose: "pin_setup", studentId: 12 }), false);
});

test("selection payload exposes only the safe public student shape", () => {
  const safe = publicGuardianSelectionStudent(sibling({ guardian_phone: "01012345678", pin_hash: "secret", auth_version: 7 }));
  assert.deepEqual(Object.keys(safe).sort(), ["full_name", "grade", "grade_level", "group_name", "id", "student_code"].sort());
  assert.equal("guardian_phone" in safe, false);
  assert.equal("pin_hash" in safe, false);
  assert.equal("auth_version" in safe, false);
});
