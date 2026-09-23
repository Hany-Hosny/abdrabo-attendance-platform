import test from "node:test";
import assert from "node:assert/strict";
import { getStudentAssistantContext } from "../src/services/studentAssistantContext.js";

test("student assistant context is read-only and scoped to the authenticated student group", async () => {
  const calls = [];
  const db = async (text, params) => {
    calls.push({ text, params });
    if (text.includes("split_part")) {
      return {
        rows: [{
          display_name: "سارة",
          group_name: "مجموعة العلوم",
          grade: "أولى إعدادي",
          grade_level: "أولى إعدادي",
          subject: "العلوم",
          schedules: [{ day_of_week: 6, start_time: "14:00", end_time: "15:00" }]
        }]
      };
    }
    if (text.includes("WITH bounds")) {
      return {
        rows: [{
          current_month: "2026-09-01",
          payment_status: "unpaid",
          required_amount: "300",
          paid_amount: "100",
          remaining_balance: "200",
          current_cycle_fee: "150",
          current_cycle_paid: "100",
          current_cycle_outstanding: "50",
          monthly_dues: [{ month: "2026-09-01", amount: 150 }]
        }]
      };
    }
    if (text.includes("FROM attendance_records")) {
      return { rows: [{ status: "present", session_date: "2026-09-20" }, { status: "absent", session_date: "2026-09-19" }] };
    }
    if (text.includes("FROM exam_results")) {
      return { rows: [{ title: "اختبار العلوم", exam_date: "2026-09-18", max_score: "20", score: "18", note: null }] };
    }
    if (text.includes("FROM homeworks")) {
      return { rows: [{ title: "واجب الفصل الأول", due_date: "2026-09-22", attachment_url: null, status: "new", submitted_at: null }] };
    }
    throw new Error(`Unexpected query: ${text}`);
  };

  const context = await getStudentAssistantContext({ id: 42, group_id: 7 }, db);

  assert.deepEqual(context, {
    displayName: "سارة",
    groupName: "مجموعة العلوم",
    grade: "أولى إعدادي",
    gradeLevel: "أولى إعدادي",
    subject: "العلوم",
    schedules: [{ dayOfWeek: 6, startTime: "14:00", endTime: "15:00" }],
    financial: {
      currentMonth: "2026-09-01",
      paymentStatus: "unpaid",
      requiredAmount: 300,
      paidAmount: 100,
      remainingBalance: 200,
      currentCycleFee: 150,
      currentCyclePaid: 100,
      currentCycleOutstanding: 50
    },
    attendance: {
      present: 1,
      absent: 1,
      late: 0,
      excused: 0,
      attendanceRate: 50,
      latestSession: { date: "2026-09-20", status: "present" }
    },
    exams: [{ title: "اختبار العلوم", date: "2026-09-18", score: 18, maxScore: 20 }],
    homework: [{ title: "واجب الفصل الأول", dueDate: "2026-09-22", status: "new" }]
  });
  assert.equal(calls.some(({ text }) => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(text)), false);
  assert.deepEqual(calls.find(({ text }) => text.includes("WITH bounds"))?.params, [42]);
  assert.equal(JSON.stringify(context).includes("monthly_dues"), false);
});
