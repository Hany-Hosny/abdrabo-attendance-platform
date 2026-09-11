import assert from "node:assert/strict";
import test from "node:test";
import {
  ATTENDANCE_STATUSES,
  MANUAL_ATTENDANCE_STATUSES,
  attendanceRateFromStatuses
} from "../src/utils/attendanceStatus.js";

test("excused is a supported manual status without changing legacy statuses", () => {
  assert.deepEqual(ATTENDANCE_STATUSES, ["present", "absent", "late", "pending_review", "rejected", "excused"]);
  assert.equal(MANUAL_ATTENDANCE_STATUSES.includes("excused"), true);
});

test("attendance rate excludes excused and non-final records from the denominator", () => {
  assert.equal(attendanceRateFromStatuses([
    { status: "present" },
    { status: "late" },
    { status: "absent" },
    { status: "excused" },
    { status: "pending_review" }
  ]), (2 / 3) * 100);
  assert.equal(attendanceRateFromStatuses([{ status: "excused" }]), null);
});
