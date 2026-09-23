import { query } from "../db/pool.js";
import { getFeeSummary } from "./fees.js";
import { attendanceRateFromStatuses } from "../utils/attendanceStatus.js";

function amount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function getStudentAssistantContext(student, db = query) {
  const studentId = Number(student?.id);
  const groupId = Number(student?.group_id);
  if (!Number.isInteger(studentId) || !Number.isInteger(groupId)) throw new Error("student_context_unavailable");

  const [studentResult, feeSummary, attendanceResult, examsResult, homeworkResult] = await Promise.all([
    db(`
      SELECT
        split_part(trim(s.full_name), ' ', 1) AS display_name,
        COALESCE(g.display_name, g.name) AS group_name,
        g.grade,
        COALESCE(g.grade_level, g.grade) AS grade_level,
        g.subject,
        COALESCE(
          json_agg(
            json_build_object(
              'day_of_week', cs.day_of_week,
              'start_time', cs.start_time,
              'end_time', cs.end_time
            ) ORDER BY cs.day_of_week, cs.start_time
          ) FILTER (WHERE cs.id IS NOT NULL),
          '[]'::json
        ) AS schedules
      FROM students s
      JOIN groups g ON g.id = s.group_id
        AND g.is_active = TRUE
        AND g.deleted_at IS NULL
      LEFT JOIN class_schedules cs ON cs.group_id = g.id
        AND cs.is_active = TRUE
        AND cs.deleted_at IS NULL
      WHERE s.id = $1
        AND s.group_id = $2
        AND s.is_active = TRUE
        AND s.deleted_at IS NULL
      GROUP BY s.full_name, g.display_name, g.name, g.grade, g.grade_level, g.subject
      LIMIT 1
    `, [studentId, groupId]),
    getFeeSummary(studentId, { ensure: false, db }),
    db(`
      SELECT ar.status, s.session_date
      FROM attendance_records ar
      JOIN attendance_sessions s ON s.id = ar.session_id
      WHERE ar.student_id = $1
        AND s.group_id = $2
        AND s.status <> 'cancelled'
      ORDER BY s.session_date DESC, s.starts_at DESC
    `, [studentId, groupId]),
    db(`
      SELECT e.title, e.exam_date, e.max_score, er.score, er.note
      FROM exam_results er
      JOIN exams e ON e.id = er.exam_id
      WHERE er.student_id = $1
      ORDER BY e.exam_date DESC, e.id DESC
    `, [studentId]),
    db(`
      SELECT h.title, h.due_date, h.attachment_url,
        COALESCE(hs.status, CASE WHEN h.due_date IS NOT NULL AND h.due_date < CURRENT_TIMESTAMP THEN 'late' ELSE 'new' END) AS status,
        hs.submitted_at
      FROM homeworks h
      LEFT JOIN homework_submissions hs ON hs.homework_id = h.id AND hs.student_id = $1
      WHERE h.group_id = $2
      ORDER BY h.due_date NULLS LAST, h.created_at DESC
    `, [studentId, groupId])
  ]);

  const row = studentResult.rows[0];
  if (!row) throw new Error("student_context_unavailable");

  return {
    displayName: row.display_name || "الطالب",
    groupName: row.group_name,
    grade: row.grade,
    gradeLevel: row.grade_level,
    subject: row.subject,
    schedules: Array.isArray(row.schedules) ? row.schedules.map((schedule) => ({
      dayOfWeek: Number(schedule.day_of_week),
      startTime: schedule.start_time,
      endTime: schedule.end_time
    })) : [],
    financial: feeSummary ? {
      currentMonth: feeSummary.current_month,
      paymentStatus: feeSummary.payment_status,
      requiredAmount: amount(feeSummary.required_amount),
      paidAmount: amount(feeSummary.paid_amount),
      remainingBalance: amount(feeSummary.remaining_balance),
      currentCycleFee: amount(feeSummary.current_cycle_fee),
      currentCyclePaid: amount(feeSummary.current_cycle_paid),
      currentCycleOutstanding: amount(feeSummary.current_cycle_outstanding)
    } : { unavailable: true },
    attendance: (() => {
      const records = attendanceResult.rows || [];
      const counts = records.reduce((summary, record) => {
        const status = String(record.status || "");
        if (Object.prototype.hasOwnProperty.call(summary, status)) summary[status] += 1;
        return summary;
      }, { present: 0, absent: 0, late: 0, excused: 0 });
      return {
        ...counts,
        attendanceRate: attendanceRateFromStatuses(records),
        latestSession: records[0] ? { date: records[0].session_date, status: records[0].status } : null
      };
    })(),
    exams: (examsResult.rows || []).map((exam) => ({
      title: exam.title,
      date: exam.exam_date,
      score: amount(exam.score),
      maxScore: amount(exam.max_score),
      ...(exam.note ? { note: String(exam.note).slice(0, 500) } : {})
    })),
    homework: (homeworkResult.rows || []).map((homework) => ({
      title: homework.title,
      dueDate: homework.due_date,
      status: homework.status,
      ...(homework.attachment_url ? { attachmentUrl: homework.attachment_url } : {}),
      ...(homework.submitted_at ? { submittedAt: homework.submitted_at } : {})
    }))
  };
}

export async function getPublicAssistantSiteContext(db = query) {
  const [centerResult, pagesResult, homeResult] = await Promise.all([
    db("SELECT name, address, latitude, longitude FROM centers ORDER BY id ASC LIMIT 1"),
    db(`
      SELECT slug, title_ar, title_en, subtitle_ar, subtitle_en, content_ar, content_en
      FROM site_pages
      WHERE slug IN ('about-teacher', 'contact')
      ORDER BY slug
    `),
    db("SELECT content FROM site_content WHERE key = 'home' LIMIT 1")
  ]);

  const contactPage = (pagesResult.rows || []).find((page) => page.slug === "contact");
  const whatsapp = contactPage?.content_ar?.whatsapp || contactPage?.content_en?.whatsapp || null;
  return {
    center: centerResult.rows[0] ? {
      name: centerResult.rows[0].name,
      address: centerResult.rows[0].address,
      latitude: Number(centerResult.rows[0].latitude),
      longitude: Number(centerResult.rows[0].longitude)
    } : null,
    whatsapp,
    pages: (pagesResult.rows || []).map((page) => ({
      slug: page.slug,
      titleAr: page.title_ar,
      titleEn: page.title_en,
      subtitleAr: page.subtitle_ar,
      subtitleEn: page.subtitle_en,
      contentAr: page.content_ar,
      contentEn: page.content_en
    })),
    home: homeResult.rows[0]?.content || null
  };
}
