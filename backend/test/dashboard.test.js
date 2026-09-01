import test from "node:test";
import assert from "node:assert/strict";
import { changePercentage, getDashboardPeriod, percentage, scopeDashboardPayload } from "../src/services/dashboard.js";

test("dashboard period bounds use Cairo dates and the full due month", () => {
  const bounds = getDashboardPeriod("current", "", "", new Date("2026-09-15T12:00:00Z"));
  assert.deepEqual(bounds, {
    period: "current",
    from: "2026-09-01",
    to: "2026-09-15",
    endExclusive: "2026-09-16",
    dueEndExclusive: "2026-10-01",
    previousFrom: "2026-08-01",
    previousEndExclusive: "2026-09-01",
    previousDueEndExclusive: "2026-09-01"
  });
});

test("dashboard percentages and comparisons are safe for zero denominators", () => {
  assert.equal(percentage(10, 0), null);
  assert.equal(percentage(25, 100), 25);
  assert.equal(changePercentage(10, 0), null);
  assert.equal(changePercentage(0, 0), 0);
  assert.equal(changePercentage(90, 100), -10);
});

test("custom dashboard periods compare with an equal-length preceding range", () => {
  const bounds = getDashboardPeriod("custom", "2026-09-10", "2026-09-12", new Date("2026-09-15T12:00:00Z"));
  assert.equal(bounds.from, "2026-09-10");
  assert.equal(bounds.to, "2026-09-12");
  assert.equal(bounds.previousFrom, "2026-09-07");
  assert.equal(bounds.previousEndExclusive, "2026-09-10");
});

test("financial dashboard payload is removed for group-only admins", () => {
  const scoped = scopeDashboardPayload({
    summary: { totalIncome: 1000 },
    collection: { required: 1200, collected: 1000, remaining: 200, rate: 83.3 },
    previousCollection: { required: 900, collected: 800, rate: 88.8 },
    studentStatus: { paid: 4, overdue: 2 },
    revenueTrend: [{ month: "2026-09", amount: 1000 }],
    recentPayments: [{ id: 1, amount: 100 }],
    groupPerformance: [{ groupId: 1, collectionRate: 83.3, overdueCount: 2, attendanceRate: 90 }],
    alerts: []
  }, { groupPerformance: true });

  assert.equal(scoped.summary, null);
  assert.equal(scoped.collection, null);
  assert.equal(scoped.previousCollection, null);
  assert.equal(scoped.studentStatus, null);
  assert.equal(scoped.revenueTrend, null);
  assert.equal(scoped.recentPayments, null);
  assert.deepEqual(scoped.groupPerformance, [{ groupId: 1, attendanceRate: 90 }]);
});

test("group performance permission preserves group metrics without financial fields", () => {
  const scoped = scopeDashboardPayload({
    summary: null,
    collection: null,
    previousCollection: null,
    studentStatus: null,
    revenueTrend: null,
    recentPayments: null,
    groupPerformance: [{ groupId: 7, studentCount: 12, attendanceRate: 75 }],
    alerts: null
  }, { groupPerformance: true });
  assert.equal(scoped.permissions.groupPerformance, true);
  assert.deepEqual(scoped.groupPerformance, [{ groupId: 7, studentCount: 12, attendanceRate: 75 }]);
});
