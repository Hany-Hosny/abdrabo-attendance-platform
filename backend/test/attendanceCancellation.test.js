import test from "node:test";
import assert from "node:assert/strict";
import { calculateSessionCancellationWindow, isCancellableAttendanceSessionStatus } from "../src/services/attendanceCancellation.js";

const startsAt = "2026-09-17T10:00:00.000Z";
const endsAt = "2026-09-17T11:00:00.000Z";
const atMinute = (minute) => new Date(Date.parse(startsAt) + minute * 60_000).toISOString();

test("cancellation window includes pre-start, started, and exact inclusive cutoff times", () => {
  assert.equal(calculateSessionCancellationWindow({ startsAt, endsAt, now: atMinute(-10), cutoffPercentage: 60 }).eligible, true);
  assert.equal(calculateSessionCancellationWindow({ startsAt, endsAt, now: atMinute(12), cutoffPercentage: 60 }).eligible, true);
  assert.equal(calculateSessionCancellationWindow({ startsAt, endsAt, now: atMinute(36), cutoffPercentage: 60 }).eligible, true);
});

test("cancellation window closes immediately after the configured boundary", () => {
  assert.equal(calculateSessionCancellationWindow({ startsAt, endsAt, now: atMinute(36.01), cutoffPercentage: 60 }).eligible, false);
});

test("invalid timestamps and cutoff values never permit cancellation", () => {
  assert.deepEqual(calculateSessionCancellationWindow({ startsAt, endsAt, now: atMinute(1), cutoffPercentage: 91 }), { valid: false, eligible: false, cutoffAt: null });
  assert.equal(calculateSessionCancellationWindow({ startsAt, endsAt: startsAt, now: atMinute(1), cutoffPercentage: 60 }).valid, false);
});

test("a finalizer-closed session remains cancellable inside its cancellation window", () => {
  assert.equal(isCancellableAttendanceSessionStatus("closed"), true);
  assert.equal(isCancellableAttendanceSessionStatus("cancelled"), false);
  assert.equal(isCancellableAttendanceSessionStatus("draft"), false);
  assert.equal(calculateSessionCancellationWindow({ startsAt, endsAt, now: atMinute(20), cutoffPercentage: 60 }).eligible, true);
});
