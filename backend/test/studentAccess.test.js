import test from "node:test";
import assert from "node:assert/strict";
import { verifySessionAttendance } from "../src/middleware/requireActiveSessionAttendance.js";

const schedule = {
  session_id: 55,
  group_id: 8,
  session_date: "2026-09-05",
  status: "open",
  day_of_week: 6,
  start_time: "08:00:00",
  end_time: "08:30:00",
  opens_before_minutes: 3,
  closes_after_minutes: 20,
  group_name: "Saturday Group",
  subject: "Science"
};

function mockDatabase({ attendance = [] } = {}) {
  return async (sql) => {
    if (sql.includes("SELECT CURRENT_TIMESTAMP")) {
      return { rowCount: 1, rows: [{ server_now: new Date("2026-09-05T05:00:00.000Z") }] };
    }
    if (sql.includes("FROM attendance_records")) {
      return { rowCount: attendance.length, rows: attendance };
    }
    return { rowCount: 1, rows: [schedule] };
  };
}

test("live session access requires a scanned attendance record", async () => {
  const denied = await verifySessionAttendance(101, mockDatabase());
  assert.equal(denied.allowed, false);
  assert.equal(denied.reason, "attendance_required");

  const allowed = await verifySessionAttendance(101, mockDatabase({
    attendance: [{ id: 99, session_id: 55, status: "present", checkin_time: "2026-09-05T05:01:00.000Z" }]
  }));
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.session.session_id, 55);
});

test("live session access is evaluated from the database server clock", async () => {
  const calls = [];
  const db = async (sql) => {
    calls.push(sql);
    if (sql.includes("SELECT CURRENT_TIMESTAMP")) {
      return { rowCount: 1, rows: [{ server_now: new Date("2026-09-05T05:20:00.001Z") }] };
    }
    return { rowCount: 1, rows: [schedule] };
  };

  const result = await verifySessionAttendance(101, db);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "no_active_session");
  assert.equal(calls.some((sql) => sql.includes("CURRENT_TIMESTAMP")), true);
});
