import crypto from "node:crypto";
import express from "express";
import { pool, query } from "../db/pool.js";
import { requireRoles, requireTeacher } from "../middleware/requireTeacher.js";
import { ensureMonthlyFees, getFeeSummary } from "../services/fees.js";
import { isNationalId, isPhoneNumber, normalizeDigits, normalizeStudentCode } from "../utils/normalizeDigits.js";

export const adminAcademicRouter = express.Router();
adminAcademicRouter.use(requireTeacher);

const weekdays = new Set([0, 1, 2, 3, 4, 5, 6]);
const studentCodePattern = /^A-\d{4}$/;
const supportedGradeLevels = new Set([
  "خامسة ابتدائي", "سادسة ابتدائي", "أولى إعدادي", "ثانية إعدادي", "ثالثة إعدادي",
  "أولى ثانوي", "ثانية ثانوي", "ثالثة ثانوي", "مجاميع تقوية",
  "Primary 5", "Primary 6", "Prep 1", "Prep 2", "Prep 3",
  "Secondary 1", "Secondary 2", "Secondary 3", "Support Groups"
]);

function hashNationalId(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function generateStudentCode() {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = `A-${String(Math.floor(1000 + Math.random() * 9000))}`;
    const existing = await query("SELECT 1 FROM students WHERE student_code = $1 LIMIT 1", [candidate]);
    if (!existing.rowCount) return candidate;
  }
  throw new Error("failed_to_generate_student_code");
}

async function generateScanSerial(studentCode) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const candidate = `ABD-${studentCode.replace(/-/g, "")}-${String(Math.floor(100000 + Math.random() * 900000))}`;
    const existing = await query("SELECT 1 FROM students WHERE scan_serial = $1 LIMIT 1", [candidate]);
    if (!existing.rowCount) return candidate;
  }
  throw new Error("failed_to_generate_scan_serial");
}

function parseBoolean(value, fallback = true) {
  return typeof value === "boolean" ? value : fallback;
}

function groupPayload(body) {
  const name = String(body?.name || "").trim();
  const grade = String(body?.grade || "").trim();
  const subject = String(body?.subject || "").trim();
  const dayOfWeek = Number(normalizeDigits(body?.day_of_week));
  const startTime = String(body?.start_time || "").trim();
  const endTime = String(body?.end_time || "").trim();
  const opensBefore = Number(normalizeDigits(body?.opens_before_minutes ?? 3));
  const closesAfter = Number(normalizeDigits(body?.closes_after_minutes ?? 20));
  const centerId = Number(normalizeDigits(body?.center_id || 0));
  const hasSchedules = Array.isArray(body?.schedules);
  const schedules = (hasSchedules ? body.schedules : [{ day_of_week: dayOfWeek, start_time: startTime, end_time: endTime, opens_before_minutes: opensBefore, closes_after_minutes: closesAfter, is_active: parseBoolean(body?.is_active) }]).map((schedule) => ({
    ...schedule,
    id: schedule?.id ? Number(normalizeDigits(schedule.id)) : undefined,
    day_of_week: Number(normalizeDigits(schedule?.day_of_week)),
    opens_before_minutes: Number(normalizeDigits(schedule?.opens_before_minutes ?? 3)),
    closes_after_minutes: Number(normalizeDigits(schedule?.closes_after_minutes ?? 20))
  }));
  return {
    name,
    grade,
    subject,
    dayOfWeek,
    startTime,
    endTime,
    opensBefore,
    closesAfter,
    centerId,
    gradeLevel: String(body?.grade_level || grade).trim(),
    displayName: String(body?.display_name || name).trim(),
    feesAmount: Number(normalizeDigits(body?.fees_amount ?? 0)),
    schedules,
    hasSchedules,
    isActive: parseBoolean(body?.is_active)
  };
}

function validGroup(data) {
  return Boolean(
    data.name &&
      data.grade &&
      data.subject &&
      weekdays.has(data.dayOfWeek) &&
      /^\d{2}:\d{2}(:\d{2})?$/.test(data.startTime) &&
      /^\d{2}:\d{2}(:\d{2})?$/.test(data.endTime) &&
      Number.isInteger(data.opensBefore) &&
      data.opensBefore >= 0 &&
      Number.isInteger(data.closesAfter) &&
      data.closesAfter >= 0 &&
      Number.isFinite(data.feesAmount) && data.feesAmount >= 0 && supportedGradeLevels.has(data.gradeLevel) && data.schedules.length > 0 && data.schedules.length <= 3 && data.schedules.every((schedule) => weekdays.has(Number(schedule.day_of_week)) && /^\d{2}:\d{2}(:\d{2})?$/.test(String(schedule.start_time)) && /^\d{2}:\d{2}(:\d{2})?$/.test(String(schedule.end_time)))
  );
}

const groupSelect = `
  SELECT g.id, g.center_id, g.name, g.grade, g.subject, g.is_active, g.created_at,
    c.name AS center_name, g.grade_level, g.display_name, g.fees_amount,
    cs.id AS schedule_id, cs.day_of_week, cs.start_time, cs.end_time,
    cs.opens_before_minutes, cs.closes_after_minutes, g.deleted_at,
    COALESCE((
      SELECT json_agg(json_build_object(
        'id', all_cs.id,
        'day_of_week', all_cs.day_of_week,
        'start_time', all_cs.start_time,
        'end_time', all_cs.end_time,
        'opens_before_minutes', all_cs.opens_before_minutes,
        'closes_after_minutes', all_cs.closes_after_minutes,
        'is_active', all_cs.is_active
      ) ORDER BY all_cs.day_of_week, all_cs.start_time)
      FROM class_schedules all_cs
      WHERE all_cs.group_id = g.id AND all_cs.deleted_at IS NULL
    ), '[]'::json) AS schedules,
    (SELECT COUNT(*)::int FROM students stc WHERE stc.group_id=g.id AND stc.deleted_at IS NULL) AS students_count,
    (SELECT COUNT(*)::int FROM students stc WHERE stc.group_id=g.id AND stc.deleted_at IS NULL AND stc.is_active=TRUE) AS active_students_count,
    (SELECT COUNT(*)::int FROM students stc WHERE stc.group_id=g.id AND stc.deleted_at IS NULL AND stc.is_active=FALSE) AS disabled_students_count,
    (SELECT COUNT(*)::int FROM students stc WHERE stc.group_id=g.id AND stc.deleted_at IS NOT NULL) AS deleted_students_count
  FROM groups g
  JOIN centers c ON c.id = g.center_id
  LEFT JOIN LATERAL (
    SELECT * FROM class_schedules
    WHERE group_id = g.id AND deleted_at IS NULL
    ORDER BY id DESC
    LIMIT 1
  ) cs ON TRUE
`;

adminAcademicRouter.get("/groups", async (_req, res, next) => {
  try {
    const [groups, centers] = await Promise.all([
      query(`${groupSelect} WHERE g.deleted_at IS NULL ORDER BY g.created_at DESC`),
      query("SELECT id, name, address FROM centers ORDER BY id ASC LIMIT 1")
    ]);
    res.json({ ok: true, groups: groups.rows, centers: centers.rows });
  } catch (error) {
    next(error);
  }
});

adminAcademicRouter.post("/groups", async (req, res, next) => {
  try {
    const data = groupPayload(req.body);
    if (data.schedules.length > 3) return res.status(400).json({ ok: false, status: "too_many_schedules" });
    if (!data.centerId) data.centerId = (await query("SELECT id FROM centers ORDER BY id LIMIT 1")).rows[0]?.id;
    if (!validGroup(data)) return res.status(400).json({ ok: false, status: "invalid_group_payload" });

    const group = await query(
      `INSERT INTO groups (center_id, name, display_name, grade, grade_level, subject, fees_amount, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [data.centerId, data.name, data.displayName, data.grade, data.gradeLevel, data.subject, data.feesAmount, data.isActive]
    );
    const groupId = group.rows[0].id;
    for (const schedule of data.schedules) await query(`INSERT INTO class_schedules (group_id,day_of_week,start_time,end_time,opens_before_minutes,closes_after_minutes,is_active) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (group_id,day_of_week,start_time,end_time) DO UPDATE SET is_active=EXCLUDED.is_active,updated_at=NOW()`, [groupId, Number(schedule.day_of_week), schedule.start_time, schedule.end_time, Number(schedule.opens_before_minutes ?? 3), Number(schedule.closes_after_minutes ?? 20), parseBoolean(schedule.is_active)]);
    const result = await query(`${groupSelect} WHERE g.id = $1`, [groupId]);
    res.status(201).json({ ok: true, group: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

adminAcademicRouter.put("/groups/:id", async (req, res, next) => {
  try {
    const data = groupPayload(req.body);
    if (data.schedules.length > 3) return res.status(400).json({ ok: false, status: "too_many_schedules" });
    if (!data.centerId) data.centerId = (await query("SELECT center_id FROM groups WHERE id=$1", [Number(req.params.id)])).rows[0]?.center_id;
    if (!validGroup(data)) return res.status(400).json({ ok: false, status: "invalid_group_payload" });
    const groupId = Number(req.params.id);
    const updated = await query(
      `UPDATE groups SET center_id = $1, name = $2, display_name = $3, grade = $4, grade_level = $5, subject = $6, fees_amount = $7, is_active = $8, updated_at=NOW()
       WHERE id = $9 AND deleted_at IS NULL RETURNING id`,
      [data.centerId, data.name, data.displayName, data.grade, data.gradeLevel, data.subject, data.feesAmount, data.isActive, groupId]
    );
    if (!updated.rowCount) return res.status(404).json({ ok: false, status: "not_found" });

    if (data.hasSchedules) {
      const keptScheduleIds = [];
      for (const schedule of data.schedules) {
        if (Number.isInteger(schedule.id) && schedule.id > 0) {
          const updatedSchedule = await query(
            `UPDATE class_schedules
             SET day_of_week=$1, start_time=$2, end_time=$3, opens_before_minutes=$4,
                 closes_after_minutes=$5, is_active=$6, deleted_at=NULL, updated_at=NOW()
             WHERE id=$7 AND group_id=$8
             RETURNING id`,
            [Number(schedule.day_of_week), schedule.start_time, schedule.end_time, Number(schedule.opens_before_minutes ?? 3), Number(schedule.closes_after_minutes ?? 20), parseBoolean(schedule.is_active), schedule.id, groupId]
          );
          if (updatedSchedule.rowCount) {
            keptScheduleIds.push(updatedSchedule.rows[0].id);
            continue;
          }
        }
        const insertedSchedule = await query(
          `INSERT INTO class_schedules (group_id,day_of_week,start_time,end_time,opens_before_minutes,closes_after_minutes,is_active,deleted_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,NULL)
           ON CONFLICT (group_id,day_of_week,start_time,end_time) DO UPDATE SET
             opens_before_minutes=EXCLUDED.opens_before_minutes,
             closes_after_minutes=EXCLUDED.closes_after_minutes,
             is_active=EXCLUDED.is_active,
             deleted_at=NULL,
             updated_at=NOW()
           RETURNING id`,
          [groupId, Number(schedule.day_of_week), schedule.start_time, schedule.end_time, Number(schedule.opens_before_minutes ?? 3), Number(schedule.closes_after_minutes ?? 20), parseBoolean(schedule.is_active)]
        );
        keptScheduleIds.push(insertedSchedule.rows[0].id);
      }
      await query(
        `UPDATE class_schedules
         SET deleted_at=NOW(), is_active=FALSE, updated_at=NOW()
         WHERE group_id=$1 AND NOT (id = ANY($2::int[])) AND deleted_at IS NULL`,
        [groupId, keptScheduleIds]
      );
    }
    const result = await query(`${groupSelect} WHERE g.id = $1`, [groupId]);
    res.json({ ok: true, group: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

adminAcademicRouter.patch("/groups/:id/status", async (req, res, next) => {
  try {
    const isActive = parseBoolean(req.body?.is_active, false);
    const result = await query("UPDATE groups SET is_active = $1 WHERE id = $2 AND deleted_at IS NULL RETURNING id", [isActive, Number(req.params.id)]);
    if (!result.rowCount) return res.status(404).json({ ok: false, status: "not_found" });
    await query("UPDATE class_schedules SET is_active = $1 WHERE group_id = $2", [isActive, Number(req.params.id)]);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

adminAcademicRouter.delete("/groups/:id", requireRoles("admin"), async (req, res, next) => {
  try {
    const groupId = Number(req.params.id);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const students = await client.query("SELECT 1 FROM students WHERE group_id=$1 AND deleted_at IS NULL LIMIT 1", [groupId]);
      if (students.rowCount) {
        await client.query("ROLLBACK");
        return res.status(409).json({ok:false,status:"group_has_students"});
      }
      const result = await client.query("UPDATE groups SET deleted_at=NOW(), is_active=FALSE, updated_at=NOW() WHERE id=$1 AND deleted_at IS NULL RETURNING id", [groupId]);
      if (!result.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ok:false,status:"not_found"});
      }
      await client.query("UPDATE class_schedules SET deleted_at=NOW(), is_active=FALSE, updated_at=NOW() WHERE group_id=$1 AND deleted_at IS NULL", [groupId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    res.json({ok:true});
  } catch (error) { next(error); }
});

adminAcademicRouter.get("/groups/:id/details", async (req, res, next) => {
  try {
    const groupId = Number(req.params.id);
    const group = await query(`${groupSelect} WHERE g.id=$1`, [groupId]);
    if (!group.rowCount) return res.status(404).json({ok:false,status:"not_found"});
    const schedules = await query("SELECT id,day_of_week,start_time,end_time,opens_before_minutes,closes_after_minutes,is_active FROM class_schedules WHERE group_id=$1 AND deleted_at IS NULL ORDER BY day_of_week,start_time", [groupId]);
    const students = await query("SELECT id,full_name,student_serial,student_code,phone,guardian_phone,is_active,deleted_at,purge_after FROM students WHERE group_id=$1 ORDER BY full_name", [groupId]);
    res.json({ok:true,group:group.rows[0],schedules:schedules.rows,students:students.rows});
  } catch (error) { next(error); }
});

const studentSelect = `
  SELECT s.id, s.group_id, s.student_code, s.student_serial, s.scan_serial, s.qr_token, s.full_name, s.phone, s.guardian_phone, s.gender,
    s.is_active, s.deleted_at, s.purge_after, s.created_at, g.name AS group_name, g.grade, COALESCE(g.grade_level, g.grade) AS grade_level, g.subject
  FROM students s JOIN groups g ON g.id = s.group_id
`;

adminAcademicRouter.get("/students", async (req, res, next) => {
  try {
    const status = String(req.query.status || "active");
    const search = normalizeDigits(req.query.q || req.query.search || "").trim();
    const values = [status];
    const statusFilter = "(($1 = 'all') OR ($1 = 'deleted' AND s.deleted_at IS NOT NULL) OR ($1 = 'active' AND s.deleted_at IS NULL AND s.is_active=TRUE) OR ($1 = 'disabled' AND s.deleted_at IS NULL AND s.is_active=FALSE))";
    const filters = [statusFilter];
    if (search) {
      values.push(`%${search}%`);
      const n = values.length;
      const hash = crypto.createHash("sha256").update(search).digest("hex");
      values.push(hash);
      filters.push(`(s.full_name ILIKE $${n} OR s.student_code ILIKE $${n} OR s.student_serial ILIKE $${n} OR s.scan_serial ILIKE $${n} OR s.phone ILIKE $${n} OR s.guardian_phone ILIKE $${n} OR g.name ILIKE $${n} OR COALESCE(g.display_name,g.name) ILIKE $${n} OR COALESCE(g.grade_level,g.grade) ILIKE $${n} OR s.national_id_hash = $${n + 1})`);
    }
    const result = await query(`${studentSelect} WHERE ${filters.join(" AND ")} ORDER BY s.created_at DESC`, values);
    res.json({ ok: true, students: result.rows });
  } catch (error) {
    next(error);
  }
});

adminAcademicRouter.get("/students/:id/profile", async (req, res, next) => {
  try {
    const studentId = Number(req.params.id);
    const studentResult = await query(`${studentSelect} WHERE s.id = $1`, [studentId]);
    if (!studentResult.rowCount) return res.status(404).json({ ok: false, status: "not_found" });
    const student = studentResult.rows[0];
    await ensureMonthlyFees();
    const [attendance, exams, notes, payments, threads, feeSummary] = await Promise.all([
      query(`SELECT s.id AS session_id, s.session_date, s.starts_at, s.closes_at, cs.start_time, cs.end_time,
          g.name AS group_name, ar.status, ar.checkin_time
        FROM attendance_sessions s
        JOIN groups g ON g.id = s.group_id
        JOIN class_schedules cs ON cs.id = s.schedule_id AND cs.group_id = s.group_id
        LEFT JOIN attendance_records ar ON ar.session_id = s.id AND ar.student_id = $1
        WHERE s.group_id = $2 AND s.schedule_id IS NOT NULL
        ORDER BY s.session_date DESC, cs.start_time DESC`, [studentId, student.group_id]),
      query(`SELECT e.id, e.title, e.exam_date, e.max_score, er.score, er.note
        FROM exams e JOIN exam_results er ON er.exam_id = e.id AND er.student_id = $1
        WHERE e.group_id = $2 ORDER BY e.exam_date DESC, e.id DESC`, [studentId, student.group_id]),
      query(`SELECT n.id, n.student_id, n.body, n.created_at, n.updated_at, n.is_read, n.author_id,
          COALESCE(t.name, t.username, t.email, 'Staff') AS author_name
        FROM student_notes n LEFT JOIN teachers t ON t.id = n.author_id
        WHERE n.student_id = $1 ORDER BY n.created_at DESC`, [studentId]),
      query(`SELECT p.id, p.amount, p.payment_date, p.paid_at, p.payment_method, p.notes,
          p.payment_months, COALESCE(t.name, t.username, t.email, 'Staff') AS paid_by
        FROM payments p LEFT JOIN teachers t ON t.id = COALESCE(p.paid_by, p.recorded_by)
        WHERE p.student_id = $1 ORDER BY COALESCE(p.paid_at, p.payment_date) DESC`, [studentId]),
      query(`SELECT it.id, it.subject, it.status, it.created_at, it.updated_at,
          COUNT(im.id)::int AS message_count,
          (SELECT body FROM inbox_messages WHERE thread_id = it.id AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1) AS last_message
        FROM inbox_threads it LEFT JOIN inbox_messages im ON im.thread_id = it.id AND im.deleted_at IS NULL
        WHERE it.student_id = $1 GROUP BY it.id ORDER BY it.updated_at DESC`, [studentId]),
      getFeeSummary(studentId)
    ]);
    const totalSessions = attendance.rows.length;
    const presentCount = attendance.rows.filter((row) => row.status === "present").length;
    const absentCount = attendance.rows.filter((row) => row.status === "absent").length;
    res.json({
      ok: true,
      student,
      attendance: {
        total_sessions: totalSessions,
        present_count: presentCount,
        absent_count: absentCount,
        attendance_percentage: totalSessions ? (presentCount / totalSessions) * 100 : 0,
        records: attendance.rows
      },
      exams: exams.rows,
      notes: notes.rows,
      fees: { ...(feeSummary || {}), payments: payments.rows },
      inbox: threads.rows
    });
  } catch (error) {
    next(error);
  }
});

adminAcademicRouter.get("/exams/results", async (req, res, next) => {
  try {
    const values = [];
    const filters = ["s.deleted_at IS NULL", "s.is_active = TRUE"];
    const groupId = Number(normalizeDigits(req.query.group_id || ""));
    const studentId = Number(normalizeDigits(req.query.student_id || ""));
    const search = normalizeDigits(req.query.search || "").trim();
    if (Number.isInteger(groupId) && groupId > 0) { values.push(groupId); filters.push(`s.group_id = $${values.length}`); }
    if (Number.isInteger(studentId) && studentId > 0) { values.push(studentId); filters.push(`s.id = $${values.length}`); }
    if (search) {
      values.push(`%${search}%`);
      filters.push(`(s.full_name ILIKE $${values.length} OR s.student_code ILIKE $${values.length} OR s.student_serial ILIKE $${values.length} OR s.scan_serial ILIKE $${values.length} OR g.name ILIKE $${values.length})`);
    }
    const result = await query(
      `SELECT er.id, er.student_id, s.full_name, s.student_code, s.group_id, g.name AS group_name,
              e.id AS exam_id, e.title, e.exam_date, e.max_score, er.score, er.note, er.note AS assessment
       FROM exam_results er
       JOIN exams e ON e.id = er.exam_id
       JOIN students s ON s.id = er.student_id
       JOIN groups g ON g.id = s.group_id
       WHERE ${filters.join(" AND ")}
       ORDER BY e.exam_date DESC, s.full_name ASC, e.id DESC`,
      values
    );
    res.json({ ok: true, results: result.rows });
  } catch (error) {
    next(error);
  }
});

adminAcademicRouter.post("/exams/results", requireRoles("admin", "teacher"), async (req, res, next) => {
  try {
    const studentId = Number(normalizeDigits(req.body?.student_id));
    const title = String(req.body?.title || "").trim();
    const examDate = String(req.body?.exam_date || "").trim();
    const maxScoreValue = String(req.body?.max_score ?? "").trim();
    const scoreValue = String(req.body?.score ?? "").trim();
    const maxScore = Number(normalizeDigits(maxScoreValue));
    const score = Number(normalizeDigits(scoreValue));
    const assessment = String(req.body?.assessment || req.body?.note || "").trim();

    if (!Number.isInteger(studentId) || studentId <= 0 || !title || !/^\d{4}-\d{2}-\d{2}$/.test(examDate) || !maxScoreValue || !scoreValue || !Number.isFinite(maxScore) || maxScore <= 0 || !Number.isFinite(score) || score < 0 || score > maxScore) {
      return res.status(400).json({ ok: false, status: "invalid_exam_result" });
    }

    const student = await query("SELECT id, group_id FROM students WHERE id = $1 AND deleted_at IS NULL", [studentId]);
    if (!student.rowCount) return res.status(404).json({ ok: false, status: "not_found" });

    const existingExam = await query(
      "SELECT id FROM exams WHERE group_id = $1 AND title = $2 AND exam_date = $3::date LIMIT 1",
      [student.rows[0].group_id, title, examDate]
    );
    const examId = existingExam.rows[0]?.id || (await query(
      "INSERT INTO exams (group_id, title, max_score, exam_date) VALUES ($1, $2, $3, $4::date) RETURNING id",
      [student.rows[0].group_id, title, maxScore, examDate]
    )).rows[0].id;

    const result = await query(
      `INSERT INTO exam_results (exam_id, student_id, score, note)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (exam_id, student_id)
       DO UPDATE SET score = EXCLUDED.score, note = EXCLUDED.note
       RETURNING id, exam_id, student_id, score, note AS assessment`,
      [examId, studentId, score, assessment || null]
    );
    res.status(201).json({ ok: true, result: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

adminAcademicRouter.delete("/exams/results/:id", requireRoles("admin", "teacher"), async (req, res, next) => {
  try {
    const resultId = Number(normalizeDigits(req.params.id));
    if (!Number.isInteger(resultId) || resultId <= 0) return res.status(400).json({ ok: false, status: "invalid_exam_result" });
    const result = await query("DELETE FROM exam_results WHERE id = $1 RETURNING id", [resultId]);
    if (!result.rowCount) return res.status(404).json({ ok: false, status: "not_found" });
    res.json({ ok: true, deleted_id: result.rows[0].id });
  } catch (error) {
    next(error);
  }
});

adminAcademicRouter.post("/students/:id/notes", requireRoles("admin", "teacher"), async (req, res, next) => {
  try {
    const studentId = Number(req.params.id);
    const body = String(req.body?.body || "").trim();
    if (!body) return res.status(400).json({ ok: false, status: "invalid_note" });
    const result = await query(`INSERT INTO student_notes(student_id, author_id, body, is_read) VALUES($1, $2, $3, FALSE)
      RETURNING id, student_id, author_id, body, created_at, updated_at, is_read`, [studentId, req.teacher.id, body]);
    res.status(201).json({ ok: true, note: result.rows[0] });
  } catch (error) { next(error); }
});

adminAcademicRouter.put("/students/:id/notes/:noteId", requireRoles("admin", "teacher"), async (req, res, next) => {
  try {
    const body = String(req.body?.body || "").trim();
    if (!body) return res.status(400).json({ ok: false, status: "invalid_note" });
    const result = await query(`UPDATE student_notes SET body=$1, updated_at=NOW(), is_read=FALSE
      WHERE id=$2 AND student_id=$3 AND ($4 = 'admin' OR author_id=$5)
      RETURNING id, student_id, author_id, body, created_at, updated_at, is_read`, [body, Number(req.params.noteId), Number(req.params.id), req.teacher.role, req.teacher.id]);
    if (!result.rowCount) return res.status(404).json({ ok: false, status: "not_found" });
    res.json({ ok: true, note: result.rows[0] });
  } catch (error) { next(error); }
});

adminAcademicRouter.delete("/students/:id/notes/:noteId", requireRoles("admin", "teacher"), async (req, res, next) => {
  try {
    const result = await query(`DELETE FROM student_notes WHERE id=$1 AND student_id=$2 AND ($3 = 'admin' OR author_id=$4) RETURNING id`, [Number(req.params.noteId), Number(req.params.id), req.teacher.role, req.teacher.id]);
    if (!result.rowCount) return res.status(404).json({ ok: false, status: "not_found" });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

adminAcademicRouter.post("/students", async (req, res, next) => {
  try {
    const fullName = String(req.body?.full_name || "").trim();
    const requestedCode = normalizeStudentCode(req.body?.student_code || "");
    const guardianPhone = normalizeDigits(req.body?.guardian_phone || "").trim();
    const gender = ["male", "female", "unknown"].includes(String(req.body?.gender || "")) ? String(req.body.gender) : "unknown";
    const groupId = Number(normalizeDigits(req.body?.group_id));
    const phone = normalizeDigits(req.body?.phone || "").trim() || null;
    const nationalId = normalizeDigits(req.body?.national_id || "").trim();
    const isActive = parseBoolean(req.body?.is_active);
    if (!isPhoneNumber(guardianPhone) || (phone && !isPhoneNumber(phone))) {
      return res.status(400).json({ ok: false, status: "invalid_phone", message: "يجب إدخال ١١ رقمًا لرقم الهاتف. / Phone number must contain exactly 11 digits." });
    }
    if (nationalId && !isNationalId(nationalId)) {
      return res.status(400).json({ ok: false, status: "invalid_national_id", message: "يجب إدخال ١٤ رقمًا للرقم القومي. / National ID must contain exactly 14 digits." });
    }
    const studentCode = requestedCode || (await generateStudentCode());
    const studentSerial = studentCode.replace(/^A(\d{4})$/, "A-$1");
    const requestedScanSerial = normalizeDigits(req.body?.scan_serial || "").trim().toUpperCase();
    const scanSerial = /^ABD-A\d{4}-\d{6}$/.test(requestedScanSerial) ? requestedScanSerial : await generateScanSerial(studentCode);
    if (!fullName || !guardianPhone || !Number.isInteger(groupId) || groupId <= 0) {
      return res.status(400).json({ ok: false, status: "invalid_student_payload" });
    }
    if (!studentCodePattern.test(studentCode)) {
      return res.status(400).json({ ok: false, status: "invalid_student_code" });
    }
    const group = await query("SELECT id FROM groups WHERE id = $1 AND is_active = TRUE", [groupId]);
    if (!group.rowCount) return res.status(400).json({ ok: false, status: "invalid_group" });
    const result = await query(
      `INSERT INTO students (group_id, student_code, student_serial, scan_serial, qr_token, full_name, phone, guardian_phone, national_id_hash, gender, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [groupId, studentCode, studentSerial, scanSerial, crypto.randomBytes(24).toString("hex"), fullName, phone, guardianPhone, nationalId ? hashNationalId(nationalId) : null, gender, isActive]
    );
    const student = await query(`${studentSelect} WHERE s.id = $1`, [result.rows[0].id]);
    res.status(201).json({ ok: true, student: student.rows[0] });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ ok: false, status: "student_code_exists" });
    next(error);
  }
});

adminAcademicRouter.post("/students/:id/regenerate-scan-serial", requireRoles("admin"), async (req, res, next) => {
  try {
    const studentId = Number(req.params.id);
    const current = await query("SELECT id, student_code FROM students WHERE id = $1 AND deleted_at IS NULL", [studentId]);
    if (!current.rowCount) return res.status(404).json({ ok: false, status: "not_found" });
    const scanSerial = await generateScanSerial(current.rows[0].student_code);
    const result = await query(
      "UPDATE students SET scan_serial = $1, updated_at = NOW() WHERE id = $2 RETURNING id, student_code, scan_serial",
      [scanSerial, studentId]
    );
    res.json({ ok: true, student: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

adminAcademicRouter.put("/students/:id", async (req, res, next) => {
  try {
    const studentId = Number(req.params.id);
    const fullName = String(req.body?.full_name || "").trim();
    const requestedCode = normalizeStudentCode(req.body?.student_code || "");
    const guardianPhone = normalizeDigits(req.body?.guardian_phone || "").trim();
    const gender = ["male", "female", "unknown"].includes(String(req.body?.gender || "")) ? String(req.body.gender) : "unknown";
    const groupId = Number(normalizeDigits(req.body?.group_id));
    const phone = normalizeDigits(req.body?.phone || "").trim() || null;
    const nationalId = normalizeDigits(req.body?.national_id || "").trim();
    const isActive = parseBoolean(req.body?.is_active);
    if (!isPhoneNumber(guardianPhone) || (phone && !isPhoneNumber(phone))) {
      return res.status(400).json({ ok: false, status: "invalid_phone", message: "يجب إدخال ١١ رقمًا لرقم الهاتف. / Phone number must contain exactly 11 digits." });
    }
    if (nationalId && !isNationalId(nationalId)) {
      return res.status(400).json({ ok: false, status: "invalid_national_id", message: "يجب إدخال ١٤ رقمًا للرقم القومي. / National ID must contain exactly 14 digits." });
    }
    const studentCode = requestedCode || (await generateStudentCode());
    const studentSerial = studentCode.replace(/^A(\d{4})$/, "A-$1");
    if (!fullName || !guardianPhone || !Number.isInteger(groupId) || groupId <= 0) {
      return res.status(400).json({ ok: false, status: "invalid_student_payload" });
    }
    if (!studentCodePattern.test(studentCode)) {
      return res.status(400).json({ ok: false, status: "invalid_student_code" });
    }
    const result = await query(
      `UPDATE students SET group_id = $1, student_code = $2, student_serial = $3, full_name = $4, phone = $5,
        guardian_phone = $6, national_id_hash = COALESCE($7, national_id_hash), gender = $8, is_active = $9, updated_at=NOW() WHERE id = $10 RETURNING id`,
      [groupId, studentCode, studentSerial, fullName, phone, guardianPhone, nationalId ? hashNationalId(nationalId) : null, gender, isActive, studentId]
    );
    if (!result.rowCount) return res.status(404).json({ ok: false, status: "not_found" });
    const student = await query(`${studentSelect} WHERE s.id = $1`, [studentId]);
    res.json({ ok: true, student: student.rows[0] });
  } catch (error) {
    if (error.code === "23505") return res.status(409).json({ ok: false, status: "student_code_exists" });
    next(error);
  }
});

adminAcademicRouter.patch("/students/:id/status", async (req, res, next) => {
  try {
    const result = await query("UPDATE students SET is_active = $1 WHERE id = $2 AND deleted_at IS NULL RETURNING id", [parseBoolean(req.body?.is_active, false), Number(req.params.id)]);
    if (!result.rowCount) return res.status(404).json({ ok: false, status: "not_found" });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

adminAcademicRouter.post("/students/:id/print-label", async (req, res, next) => {
  try {
    const studentId = Number(req.params.id);
    const student = await query(`${studentSelect} WHERE s.id=$1 AND s.deleted_at IS NULL`, [studentId]);
    if (!student.rowCount) return res.status(404).json({ok:false,status:"not_found"});
    const actor = await query("SELECT role, print_student_labels, max_label_reprints FROM teachers WHERE id=$1", [req.teacher.id]);
    const user = actor.rows[0];
    const printed = await query("SELECT COUNT(*)::int AS count FROM audit_logs WHERE action='student_label_printed' AND student_id=$1 AND actor_id=$2", [studentId, req.teacher.id]);
    const count = printed.rows[0].count;
    if (user.role !== "admin" && (!user.print_student_labels || count >= user.max_label_reprints)) return res.status(403).json({ok:false,status:"label_print_limit_reached"});
    const remaining = user.role === "admin" ? null : Math.max(0, user.max_label_reprints - count - 1);
    await query("INSERT INTO audit_logs(action,actor_id,student_id,details) VALUES ('student_label_printed',$1,$2,$3)", [req.teacher.id, studentId, JSON.stringify({serial:student.rows[0].student_serial, print_type: count ? "reprint" : "print", remaining_print_count: remaining})]);
    res.json({ok:true,student:student.rows[0],remaining_print_count:remaining});
  } catch (error) { next(error); }
});

adminAcademicRouter.delete("/students/:id", requireRoles("admin"), async (req, res, next) => {
  try {
    const studentId = Number(req.params.id);
    const result = await query("UPDATE students SET deleted_at=NOW(), purge_after=NOW() + INTERVAL '30 days', is_active=FALSE, updated_at=NOW() WHERE id=$1 AND deleted_at IS NULL RETURNING id, purge_after", [studentId]);
    if (!result.rowCount) return res.status(404).json({ok:false,status:"not_found"});
    await query("INSERT INTO audit_logs(action,actor_id,student_id,details) VALUES ('student_archived',$1,$2,$3)", [req.teacher.id, studentId, JSON.stringify({reason:"admin_delete", purge_after: result.rows[0].purge_after})]);
    res.json({ok:true, purge_after: result.rows[0].purge_after});
  } catch (error) { next(error); }
});

adminAcademicRouter.delete("/students/:id/permanent", requireRoles("admin"), async (req, res, next) => {
  try {
    const studentId = Number(req.params.id);
    const result = await query(`
      UPDATE students
      SET full_name = 'Archived student #' || id, phone = NULL, guardian_phone = NULL,
          national_id_hash = NULL, qr_token = NULL, is_active = FALSE,
          purge_after = NULL, updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NOT NULL
      RETURNING id
    `, [studentId]);
    if (!result.rowCount) return res.status(404).json({ok:false,status:"not_found"});
    await query("INSERT INTO audit_logs(action,actor_id,student_id,details) VALUES ('student_permanently_anonymized',$1,$2,$3)", [req.teacher.id, studentId, JSON.stringify({reason:"admin_permanent_delete"})]);
    res.json({ok:true, anonymized:true});
  } catch (error) { next(error); }
});

adminAcademicRouter.patch("/students/:id/restore", requireRoles("admin"), async (req, res, next) => {
  try {
    const result = await query("UPDATE students SET deleted_at=NULL, purge_after=NULL, is_active=TRUE, updated_at=NOW() WHERE id=$1 AND deleted_at IS NOT NULL AND purge_after IS NOT NULL AND purge_after > NOW() RETURNING id", [Number(req.params.id)]);
    if (!result.rowCount) return res.status(404).json({ok:false,status:"not_found_or_purged"});
    res.json({ok:true});
  } catch (error) { next(error); }
});
