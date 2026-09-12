import crypto from "node:crypto";
import { pool } from "../db/pool.js";
import { auditLog } from "./audit.js";
import { getWhatsAppSettings, normalizeEgyptianPhone, resolveSpintax } from "./whatsapp.js";

const FINALIZER_LOCK_KEY = "abdrabo-attendance-expiry-finalizer";
const ABSENCE_QUEUE_BATCH_SIZE = 500;

function randomTemplate(templates) {
  const index = Math.floor(Math.random() * templates.length);
  return { index, template: templates[index] };
}

function absenceReference(studentId) {
  const entropy = `${Date.now()}-${studentId}-${crypto.randomUUID()}`;
  const suffix = crypto.createHash("sha256").update(entropy).digest("hex").slice(0, 12);
  return `ABS-${Date.now()}-${studentId}-${suffix}`;
}

function sessionDateLabel(value) {
  const raw = String(value || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
}

async function queueAbsenceNotifications(client, session, absentStudents) {
  const eligible = [];
  for (const student of absentStudents) {
    const phoneNumber = normalizeEgyptianPhone(student.guardian_phone);
    if (!phoneNumber) continue;

    const refCode = absenceReference(student.student_id);
    const selected = randomTemplate(session.templates);
    const template = selected.template;
    const renderedMessage = resolveSpintax(template, {
      student_name: student.student_name,
      student_code: student.student_code,
      group_name: session.group_name,
      date: sessionDateLabel(session.session_date),
      ref_code: refCode
    }).trim();

    eligible.push({
      source_id: Number(student.attendance_record_id),
      attendance_record_id: Number(student.attendance_record_id),
      student_id: Number(student.student_id),
      phone_number: phoneNumber,
      payload: {
        type: "absence",
        student_name: student.student_name,
        student_code: student.student_code,
        group_name: session.group_name,
        session_id: Number(session.session_id),
        event_time: session.session_date
      },
      ref_code: refCode,
      template_index: selected.index,
      template_text: template,
      rendered_message: `${renderedMessage}\n\nRef: ${refCode}`
    });
  }

  const invalidPhoneCount = absentStudents.length - eligible.length;
  if (!eligible.length) return { queuedCount: 0, unresolvedCount: invalidPhoneCount };

  // A session is row-locked by the caller. Still inspect all historical jobs
  // so a recovered database cannot create a second message for an already
  // delivered absence notification.
  const sourceIds = eligible.map((row) => row.source_id);
  const existing = await client.query(
    `SELECT source_id, status
     FROM whatsapp_notification_jobs
     WHERE notification_type = 'absence' AND source_id = ANY($1::bigint[])`,
    [sourceIds]
  );
  const dispatchedSources = new Set(
    existing.rows
      .filter((row) => ["pending", "processing", "sent", "failed", "skipped", "delivery_unknown"].includes(row.status))
      .map((row) => Number(row.source_id))
  );
  const pending = eligible.filter((row) => !dispatchedSources.has(row.source_id));

  let insertedCount = 0;
  for (let offset = 0; offset < pending.length; offset += ABSENCE_QUEUE_BATCH_SIZE) {
    const batch = pending.slice(offset, offset + ABSENCE_QUEUE_BATCH_SIZE);
    const inserted = await client.query(
      `INSERT INTO whatsapp_notification_jobs
        (notification_type, source_id, attendance_record_id, student_id, phone_number,
         payload, ref_code, status, template_index, template_text, rendered_message,
         next_attempt_at, created_at, updated_at)
       SELECT 'absence', row.source_id, row.attendance_record_id, row.student_id,
         row.phone_number, row.payload, row.ref_code, 'pending', row.template_index, row.template_text,
         row.rendered_message, NOW(), NOW(), NOW()
       FROM jsonb_to_recordset($1::jsonb) AS row(
         source_id bigint, attendance_record_id bigint, student_id integer,
         phone_number text, payload jsonb, ref_code text, template_index integer, template_text text,
         rendered_message text
       )
       ON CONFLICT DO NOTHING`,
      [JSON.stringify(batch)]
    );
    insertedCount += inserted.rowCount;
  }

  return { queuedCount: insertedCount, unresolvedCount: invalidPhoneCount };
}

async function processSession(sessionId, now = null) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const sessionResult = await client.query(
      `SELECT s.id AS session_id, s.group_id, s.schedule_id, s.session_date,
          s.status, s.absence_dispatched, g.name AS group_name
       FROM attendance_sessions s
       JOIN groups g ON g.id = s.group_id
       WHERE s.id = $1 AND g.is_active = TRUE AND g.deleted_at IS NULL
       FOR UPDATE OF s`,
      [sessionId]
    );
    if (!sessionResult.rowCount) {
      await client.query("COMMIT");
      return { skipped: true, reason: "session_not_active" };
    }

    const session = sessionResult.rows[0];
    if (session.status === "closed" && session.absence_dispatched === true) {
      await client.query("COMMIT");
      return { skipped: true, reason: "already_dispatched" };
    }

    const scheduleResult = session.schedule_id
      ? await client.query(
        `SELECT cs.id, cs.start_time, cs.end_time, cs.opens_before_minutes,
            cs.closes_after_minutes, cs.is_active, cs.deleted_at,
            ((s.session_date::date + cs.start_time) AT TIME ZONE 'Africa/Cairo') AS starts_at,
            ((s.session_date::date + cs.start_time - (cs.opens_before_minutes || ' minutes')::interval) AT TIME ZONE 'Africa/Cairo') AS opens_at,
            ((s.session_date::date + cs.start_time + (cs.closes_after_minutes || ' minutes')::interval) AT TIME ZONE 'Africa/Cairo') AS closes_at,
            (((s.session_date::date + CASE WHEN cs.end_time <= cs.start_time THEN 1 ELSE 0 END) + cs.end_time) AT TIME ZONE 'Africa/Cairo') AS ends_at,
            COALESCE($2::timestamptz, CURRENT_TIMESTAMP) AS effective_now
         FROM attendance_sessions s
         JOIN class_schedules cs ON cs.id = s.schedule_id AND cs.group_id = s.group_id
         WHERE s.id = $1
         FOR SHARE OF cs`,
        [sessionId, now]
      )
      : { rowCount: 0, rows: [] };
    const schedule = scheduleResult.rows[0] || null;

    if (session.status === "open") {
      if (!schedule || schedule.is_active !== true || schedule.deleted_at || new Date(schedule.effective_now) < new Date(schedule.closes_at)) {
        await client.query("COMMIT");
        return { skipped: true, reason: "not_expired" };
      }

      await client.query(
        `INSERT INTO attendance_records (
           session_id, student_id, student_name_snapshot, student_code_snapshot,
           status, method, checkin_time
         )
         SELECT $1, st.id, st.full_name, st.student_code,
           'absent', 'system', $3
         FROM students st
         WHERE st.group_id = $2
           AND st.is_active = TRUE
           AND st.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM attendance_records ar
             WHERE ar.session_id = $1 AND ar.student_id = st.id
           )
         ON CONFLICT (session_id, student_id) DO NOTHING`,
        [session.session_id, session.group_id, schedule.closes_at]
      );

      await client.query(
        `UPDATE attendance_sessions
         SET status = 'closed', starts_at = $2, opens_at = $3, closes_at = $4,
             ends_at = $5
         WHERE id = $1 AND status = 'open'`,
        [session.session_id, schedule.starts_at, schedule.opens_at, schedule.closes_at, schedule.ends_at]
      );
      session.status = "closed";
    }

    if (session.status !== "closed") {
      await client.query("COMMIT");
      return { skipped: true, reason: "session_not_closed" };
    }

    const whatsappSettings = await getWhatsAppSettings(client.query.bind(client));
    if (!whatsappSettings.auto_send) {
      await client.query("COMMIT");
      return { session_id: session.session_id, queued_count: 0, deferred: true, reason: "auto_send_disabled" };
    }

    const templatesResult = await client.query(
      `SELECT id, message_body
       FROM whatsapp_templates
       WHERE category = 'absence' AND is_active = TRUE
       ORDER BY id`
    );
    const templates = templatesResult.rows.map((row) => String(row.message_body || "").trim()).filter(Boolean);
    if (!templates.length) throw new Error("no_active_absence_templates");
    session.templates = templates;

    const absentResult = await client.query(
      `SELECT absence.id AS attendance_record_id, st.id AS student_id,
          st.full_name AS student_name, st.student_code, st.guardian_phone
       FROM students st
       JOIN attendance_records absence
         ON absence.session_id = $1 AND absence.student_id = st.id
        AND absence.status = 'absent'
       LEFT JOIN attendance_records scan
         ON scan.session_id = $1 AND scan.student_id = st.id
        AND scan.status IN ('present', 'late')
       WHERE st.group_id = $2
         AND st.is_active = TRUE
         AND st.deleted_at IS NULL
         AND st.whatsapp_opted_out = FALSE
         AND scan.id IS NULL
       ORDER BY st.id`,
      [session.session_id, session.group_id]
    );

    const queueResult = await queueAbsenceNotifications(client, session, absentResult.rows);
    if (queueResult.unresolvedCount === 0) {
      await client.query(
        `UPDATE attendance_sessions
         SET absence_dispatched = TRUE
         WHERE id = $1 AND status = 'closed' AND absence_dispatched = FALSE`,
        [session.session_id]
      );
    }

    await auditLog({
      db: client,
      action: "attendance_session_auto_finalized",
      sessionId: session.session_id,
      details: {
        session_id: session.session_id,
        session_date: session.session_date instanceof Date ? session.session_date.toISOString().slice(0, 10) : String(session.session_date || "").slice(0, 10),
        group_id: session.group_id,
        group_name: session.group_name,
        schedule_id: session.schedule_id,
        closed_at: schedule?.closes_at ? new Date(schedule.closes_at).toISOString() : null,
        automatic_absence_count: absentResult.rowCount,
        absence_notification_count: queueResult.queuedCount,
        eligible_absence_count: absentResult.rowCount,
        unresolved_absence_count: queueResult.unresolvedCount,
        status_after: "closed",
        absence_dispatched: queueResult.unresolvedCount === 0
      }
    });

    await client.query("COMMIT");
    return { session_id: session.session_id, queued_count: queueResult.queuedCount, unresolved_count: queueResult.unresolvedCount };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error(`Failed to finalize attendance session ${sessionId}`, error.stack || error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Closes expired sessions, creates missing system absence records, and queues
 * one WhatsApp absence job per absent student. Every session is processed in
 * its own transaction so a failed bulk insert leaves that session retryable.
 */
export async function finalizeExpiredAttendanceSessions({ now = null } = {}) {
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const lockResult = await client.query(
      "SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked",
      [FINALIZER_LOCK_KEY]
    );
    if (lockResult.rows[0]?.locked !== true) {
      await client.query("ROLLBACK");
      transactionStarted = false;
      return { finalized_sessions: [], skipped: true, reason: "already_running" };
    }

    const candidates = await client.query(
      `SELECT s.id, s.status
       FROM attendance_sessions s
       JOIN groups g ON g.id = s.group_id
        AND g.is_active = TRUE AND g.deleted_at IS NULL
       LEFT JOIN class_schedules cs ON cs.id = s.schedule_id
        AND cs.group_id = s.group_id
       WHERE (s.status = 'closed' AND s.absence_dispatched = FALSE)
          OR (s.status = 'open'
              AND cs.is_active = TRUE AND cs.deleted_at IS NULL
              AND ((s.session_date::date + cs.start_time
                    + (cs.closes_after_minutes || ' minutes')::interval)
                   AT TIME ZONE 'Africa/Cairo')
                  <= COALESCE($1::timestamptz, CURRENT_TIMESTAMP))
       ORDER BY s.session_date, s.id`,
      [now]
    );

    const finalized = [];
    for (const candidate of candidates.rows) {
      const result = await processSession(candidate.id, now);
      if (result?.session_id) finalized.push(result);
    }
    await client.query("COMMIT");
    transactionStarted = false;
    return { finalized_sessions: finalized };
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined);
    console.error("Failed to run attendance finalizer", error.stack || error);
    throw error;
  } finally {
    client.release();
  }
}
