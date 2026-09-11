import assert from "node:assert/strict";
import test from "node:test";
import { cairoDateString } from "../src/utils/time.js";
import { evaluateAttendanceWindow } from "../src/utils/attendanceWindow.js";

test("cairoDateString uses the Cairo calendar date instead of UTC date", () => {
  assert.equal(cairoDateString(new Date("2026-09-03T22:29:00.000Z")), "2026-09-04");
});

test("attendance window uses inclusive Cairo boundaries and rejects the wrong day", () => {
  const schedule = {
    sessionDate: "2026-09-05",
    dayOfWeek: 6,
    startTime: "08:00:00",
    endTime: "08:30:00",
    openBeforeMinutes: 3,
    closeAttendanceAfterMinutes: 20
  };
  assert.equal(evaluateAttendanceWindow({ ...schedule, now: new Date("2026-09-05T04:56:59.999Z") }).status, "session_not_started");
  assert.equal(evaluateAttendanceWindow({ ...schedule, now: new Date("2026-09-05T04:57:00.000Z") }).allowed, true);
  assert.equal(evaluateAttendanceWindow({ ...schedule, now: new Date("2026-09-05T05:20:00.000Z") }).allowed, true);
  assert.equal(evaluateAttendanceWindow({ ...schedule, now: new Date("2026-09-05T05:20:00.001Z") }).status, "attendance_window_closed");
  assert.equal(evaluateAttendanceWindow({ ...schedule, now: new Date("2026-09-04T05:10:00.000Z") }).status, "attendance_day_mismatch");
});

test("attendance window models an overnight class end on the following day", () => {
  const result = evaluateAttendanceWindow({
    sessionDate: "2026-09-05",
    dayOfWeek: 6,
    startTime: "23:30:00",
    endTime: "00:30:00",
    openBeforeMinutes: 3,
    closeAttendanceAfterMinutes: 20,
    now: new Date("2026-09-05T20:30:00.000Z")
  });
  assert.equal(result.allowed, true);
  const endParts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Cairo",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).formatToParts(new Date(result.sessionEnd)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  assert.deepEqual(
    { year: endParts.year, month: endParts.month, day: endParts.day, hour: endParts.hour, minute: endParts.minute },
    { year: "2026", month: "09", day: "06", hour: "00", minute: "30" }
  );
});
