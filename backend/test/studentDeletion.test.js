import test from "node:test";
import assert from "node:assert/strict";
import { MAX_PERMANENT_DELETE_BATCH, parseStudentIdsPayload } from "../src/routes/adminAcademic.js";
import { requirePermission } from "../src/middleware/requireTeacher.js";
import { DEFAULT_STUDENT_RETENTION, parseStudentRetention, permanentlyDeleteStudents } from "../src/services/studentDeletion.js";

test("permanent student deletion defaults to retaining every historical category", () => {
  assert.deepEqual(parseStudentRetention(undefined), { ok: true, retain: { ...DEFAULT_STUDENT_RETENTION } });
  assert.deepEqual(parseStudentRetention({ financial: false }), {
    ok: true,
    retain: { evaluations: true, financial: false, attendance: true, notes: true }
  });
});

test("permanent student deletion rejects malformed or unsupported retention options", () => {
  assert.deepEqual(parseStudentRetention({ financial: "yes" }), { ok: false, status: "invalid_retention" });
  assert.deepEqual(parseStudentRetention({ profile: true }), { ok: false, status: "invalid_retention" });
});

test("permanent student deletion detaches retained history and removes live identity in one service transaction", async () => {
  const statements = [];
  const client = {
    async query(sql) {
      statements.push(sql);
      if (sql.includes("SELECT s.id, s.full_name")) {
        return { rowCount: 1, rows: [{ id: 91, full_name: "Fixture Student", student_code: "A-0091", group_id: 4, group_name: "Group", grade_level: "Prep 1" }] };
      }
      if (sql.includes("INSERT INTO audit_logs")) return { rowCount: 1, rows: [{ id: 1, created_at: new Date().toISOString() }] };
      if (sql.includes("DELETE FROM students")) return { rowCount: 1, rows: [{ id: 91 }] };
      return { rowCount: 1, rows: [] };
    }
  };

  const result = await permanentlyDeleteStudents({
    client,
    studentIds: [91],
    retain: { evaluations: true, financial: true, attendance: true, notes: true },
    actorId: 1
  });
  assert.equal(result.deletedCount, 1);
  assert.equal(statements.some((sql) => sql.includes("UPDATE payments")), true);
  assert.equal(statements.some((sql) => sql.includes("UPDATE fee_dues")), true);
  assert.equal(statements.some((sql) => sql.includes("DELETE FROM students")), true);
  assert.equal(statements.some((sql) => sql.includes("DELETE FROM payments")), false);
  assert.equal(statements.some((sql) => sql.includes("INSERT INTO audit_logs")), true);
});

test("permanent student deletion removes every unchecked historical category", async () => {
  const statements = [];
  const client = {
    async query(sql) {
      statements.push(sql);
      if (sql.includes("SELECT s.id, s.full_name")) return { rowCount: 1, rows: [{ id: 92, full_name: "Fixture Student", student_code: "A-0092", group_id: 4 }] };
      if (sql.includes("INSERT INTO audit_logs")) return { rowCount: 1, rows: [{ id: 2, created_at: new Date().toISOString() }] };
      if (sql.includes("DELETE FROM students")) return { rowCount: 1, rows: [{ id: 92 }] };
      return { rowCount: 1, rows: [] };
    }
  };

  await permanentlyDeleteStudents({
    client,
    studentIds: [92],
    retain: { evaluations: false, financial: false, attendance: false, notes: false },
    actorId: 1
  });
  assert.equal(statements.some((sql) => sql.includes("DELETE FROM payments")), true);
  assert.equal(statements.some((sql) => sql.includes("DELETE FROM fee_dues")), true);
  assert.equal(statements.some((sql) => sql.includes("DELETE FROM attendance_records")), true);
  assert.equal(statements.some((sql) => sql.includes("DELETE FROM exam_results")), true);
  assert.equal(statements.some((sql) => sql.includes("DELETE FROM student_notes")), true);
  assert.equal(statements.some((sql) => sql.includes("UPDATE payments")), false);
});

test("permanent student deletion rejects an empty selection", () => {
  assert.deepEqual(parseStudentIdsPayload({ studentIds: [] }), { ok: false, status: "invalid_student_ids" });
  assert.deepEqual(parseStudentIdsPayload({}), { ok: false, status: "invalid_student_ids" });
});

test("permanent student deletion normalizes and deduplicates valid IDs", () => {
  assert.deepEqual(parseStudentIdsPayload({ studentIds: [12, "18", 12, "18"] }), { ok: true, studentIds: [12, 18] });
});

test("permanent student deletion rejects invalid IDs and oversized batches", () => {
  assert.equal(parseStudentIdsPayload({ studentIds: [12, 0] }).status, "invalid_student_ids");
  assert.equal(parseStudentIdsPayload({ studentIds: [12, "not-an-id"] }).status, "invalid_student_ids");
  assert.equal(parseStudentIdsPayload({ studentIds: Array.from({ length: MAX_PERMANENT_DELETE_BATCH + 1 }, (_, index) => index + 1) }).status, "too_many_student_ids");
});

test("permanent student deletion uses the existing students.delete permission", () => {
  const response = {
    statusCode: 0,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
  let continued = false;
  requirePermission("students.delete")(
    { teacher: { role: "staff", permissions: [] } },
    response,
    () => { continued = true; }
  );
  assert.equal(response.statusCode, 403);
  assert.equal(response.body.status, "permission_required");
  assert.equal(continued, false);

  response.statusCode = 0;
  response.body = null;
  requirePermission("students.delete")(
    { teacher: { role: "owner", permissions: [] } },
    response,
    () => { continued = true; }
  );
  assert.equal(response.statusCode, 0);
  assert.equal(continued, true);
});
