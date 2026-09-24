import crypto from "node:crypto";
import { pool } from "../db/pool.js";
import { auditLog } from "./audit.js";
import { getAttendanceTimingDefaults } from "./systemSettings.js";
import { readSystemSettings } from "./systemSettings.js";
import { getWhatsAppSettings, normalizeEgyptianPhone, wakeWhatsAppWorker } from "./whatsapp.js";
import { getAggregatedNotificationRecipients, upsertAggregatedNotification } from "./notifications.js";
import { NotificationType } from "./notificationTypes.js";

const FINALIZER_LOCK_KEY = "abdrabo-attendance-expiry-finalizer";
const ABSENCE_QUEUE_BATCH_SIZE = 500;

function absenceReference(studentId) {
  const entropy = `${Date.now()}-${studentId}-${crypto.randomUUID()}`;
  const suffix = crypto.createHash("sha256").update(entropy).digest("hex").slice(0, 12);
  return `ABS-${Date.now()}-${studentId}-${suffix}`;
}

function sessionDateLabel(value) {
  const raw = String(value || "").slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : "";
}

export async function queueAbsenceNotifications(client, session, absentStudents, { autoSend = true } = {}) {
  const eligible = [];
  const unresolved = [];
  for (const student of absentStudents) {
    const phoneNumber = normalizeEgyptianPhone(student.guardian_phone);
    const sourceId = Number(student.attendance_record_id);
    const studentId = Number(student.student_id);
    const payload = {
      type: "absence",
      student_name: student.student_name,
      student_code: student.student_code,
      group_name: session.group_name,
      session_id: Number(session.session_id),
      event_time: session.session_date
    };
    if (!phoneNumber && autoSend) {
      unresolved.push({
        source_id: sourceId,
        attendance_record_id: sourceId,
        student_id: studentId,
        payload,
        ref_code: absenceReference(studentId),
        last_error: "invalid_phone"
      });
      continue;
    }

    const refCode = absenceReference(studentId);
    eligible.push({
      source_id: sourceId,
      attendance_record_id: sourceId,
      student_id: studentId,
      phone_number: phoneNumber,
      payload,
      ref_code: refCode,
      template_index: null,
      template_text: null,
      rendered_message: null
    });
  }

  // A session is row-locked by the caller. Still inspect all historical jobs
  // so a recovered database cannot create a second message for an already
  // delivered absence notification.
  const sourceIds = absentStudents.map((student) => Number(student.attendance_record_id));
  const existing = await client.query(
    `SELECT source_id, status
     FROM whatsapp_notification_jobs
     WHERE notification_type = 'absence' AND source_id = ANY($1::bigint[])`,
    [sourceIds]
  );
  if (!autoSend) {
    const alreadyRecorded = new Set(existing.rows.map((row) => Number(row.source_id)));
    const skipped = absentStudents
      .filter((student) => !alreadyRecorded.has(Number(student.attendance_record_id)))
      .map((student) => {
        const sourceId = Number(student.attendance_record_id);
        const studentId = Number(student.student_id);
        return {
          source_id: sourceId,
          attendance_record_id: sourceId,
          student_id: studentId,
          phone_number: normalizeEgyptianPhone(student.guardian_phone),
          payload: {
            type: "absence",
            student_name: student.student_name,
            student_code: student.student_code,
            group_name: session.group_name,
            session_id: Number(session.session_id),
            event_time: session.session_date
          },
          ref_code: absenceReference(studentId)
        };
      });
    let insertedCount = 0;
    for (let offset = 0; offset < skipped.length; offset += ABSENCE_QUEUE_BATCH_SIZE) {
      const batch = skipped.slice(offset, offset + ABSENCE_QUEUE_BATCH_SIZE);
      const inserted = await client.query(
        `INSERT INTO whatsapp_notification_jobs
          (notification_type, source_id, attendance_record_id, student_id, phone_number,
           payload, ref_code, status, last_error, next_attempt_at, created_at, updated_at)
         SELECT 'absence', row.source_id, row.attendance_record_id, row.student_id,
           row.phone_number, row.payload, row.ref_code, 'skipped', 'auto_send_disabled', NOW(), NOW(), NOW()
         FROM jsonb_to_recordset($1::jsonb) AS row(
           source_id bigint, attendance_record_id bigint, student_id integer,
           phone_number text, payload jsonb, ref_code text
         )
         ON CONFLICT DO NOTHING`,
        [JSON.stringify(batch)]
      );
      insertedCount += inserted.rowCount;
    }
    return { queuedCount: 0, unresolvedCount: 0, skippedCount: insertedCount };
  }

  const eligibleSourceIds = eligible.map((row) => row.source_id);
  const failedEligibleSources = existing.rows
    .filter((row) => row.status === "failed" && eligibleSourceIds.includes(Number(row.source_id)))
    .map((row) => Number(row.source_id));
  if (failedEligibleSources.length) {
    await client.query(
      `UPDATE whatsapp_notification_jobs
       SET status = 'pending',
           attempts = 0,
           last_error = NULL,
           next_attempt_at = NOW(),
           sent_at = NULL,
           lease_expires_at = NULL,
           claim_token = NULL,
           send_started_at = NULL,
           template_index = NULL,
           template_text = NULL,
           rendered_message = NULL,
           updated_at = NOW()
       WHERE notification_type = 'absence'
         AND source_id = ANY($1::bigint[])
         AND status = 'failed'`,
      [failedEligibleSources]
    );
  }
  const dispatchedSources = new Set(
    existing.rows
      .filter((row) => ["pending", "processing", "sent", "skipped", "delivery_unknown"].includes(row.status))
      .map((row) => Number(row.source_id))
  );
  for (const sourceId of failedEligibleSources) dispatchedSources.add(sourceId);
  const pending = eligible.filter((row) => !dispatchedSources.has(row.source_id));
  const unresolvedPending = unresolved.filter((row) => !dispatchedSources.has(row.source_id));

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

  for (let offset = 0; offset < unresolvedPending.length; offset += ABSENCE_QUEUE_BATCH_SIZE) {
    const batch = unresolvedPending.slice(offset, offset + ABSENCE_QUEUE_BATCH_SIZE);
    await client.query(
      `INSERT INTO whatsapp_notification_jobs
        (notification_type, source_id, attendance_record_id, student_id, phone_number,
         payload, ref_code, status, last_error, next_attempt_at, created_at, updated_at)
       SELECT 'absence', row.source_id, row.attendance_record_id, row.student_id,
         NULL, row.payload, row.ref_code, 'skipped', row.last_error, NOW(), NOW(), NOW()
       FROM jsonb_to_recordset($1::jsonb) AS row(
         source_id bigint, attendance_record_id bigint, student_id integer,
         payload jsonb, ref_code text, last_error text
       )
       ON CONFLICT DO NOTHING`,
      [JSON.stringify(batch)]
    );
  }

  return { queuedCount: insertedCount, unresolvedCount: unresolved.length };
}

export function calculateAbsenceStreak(records) {
  let streak = 0;
  for (const record of records || []) {
    const status = String(record?.status || "");
    if (!status || status === "pending_review" || status === "rejected") {
      streak = 0;
      continue;
    }
    if (status === "absent") streak += 1;
    else if (status === "present" || status === "late" || status === "excused") streak = 0;
  }
  return streak;
}

export async function evaluateAbsenceFreeze(client, studentId, groupId) {
  const studentResult = await client.query(
    `SELECT id, absence_frozen, absence_unfrozen_at
     FROM students
     WHERE id = $1 AND group_id = $2 AND is_active = TRUE AND deleted_at IS NULL
     FOR UPDATE`,
    [studentId, groupId]
  );
  const student = studentResult.rows[0];
  if (!student || student.absence_frozen) return null;

  const { settings } = await readSystemSettings(client);
  const limit = Number(settings.absence_freeze_limit || 4);
  const records = await client.query(
    `SELECT s.id AS session_id, ar.status
     FROM attendance_sessions s
     LEFT JOIN attendance_records ar
       ON ar.session_id = s.id AND ar.student_id = $1
     WHERE s.group_id = $2
       AND s.status = 'closed'
       AND ($3::timestamptz IS NULL OR COALESCE(s.ends_at, s.created_at) > $3::timestamptz)
     ORDER BY s.session_date ASC, s.id ASC`,
    [studentId, groupId, student.absence_unfrozen_at || null]
  );

  const streak = calculateAbsenceStreak(records.rows);
  if (streak < limit) return null;

  const updated = await client.query(
    `UPDATE students
     SET absence_frozen = TRUE,
         absence_frozen_at = NOW(),
         absence_frozen_reason = 'consecutive_absence_limit',
         absence_frozen_streak = $3,
         absence_frozen_by = NULL,
         updated_at = NOW()
     WHERE id = $1 AND group_id = $2 AND absence_frozen = FALSE
     RETURNING id, absence_frozen_at, absence_frozen_streak`,
    [studentId, groupId, streak]
  );
  if (!updated.rowCount) return null;
  await auditLog({
    db: client,
    action: "student_absence_frozen",
    studentId,
    details: { source: "automatic_absence_limit", reason: "consecutive_absence_limit", streak, limit, group_id: Number(groupId), status_after: "absence_frozen" }
  });
  return { studentId: Number(studentId), streak, limit };
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

    const timing = await getAttendanceTimingDefaults(client.query.bind(client));

    const scheduleResult = session.schedule_id
      ? await client.query(
        `SELECT cs.id, cs.start_time, cs.end_time, cs.opens_before_minutes,
            cs.closes_after_minutes, cs.is_active, cs.deleted_at,
            ((s.session_date::date + cs.start_time) AT TIME ZONE 'Africa/Cairo') AS starts_at,
            ((s.session_date::date + cs.start_time - ((CASE WHEN cs.opens_before_minutes = 3 THEN $3 ELSE cs.opens_before_minutes END)::text || ' minutes')::interval) AT TIME ZONE 'Africa/Cairo') AS opens_at,
            ((s.session_date::date + cs.start_time + ((CASE WHEN cs.closes_after_minutes = 20 THEN $4 ELSE cs.closes_after_minutes END)::text || ' minutes')::interval) AT TIME ZONE 'Africa/Cairo') AS closes_at,
            (((s.session_date::date + CASE WHEN cs.end_time <= cs.start_time THEN 1 ELSE 0 END) + cs.end_time) AT TIME ZONE 'Africa/Cairo') AS ends_at,
            COALESCE($2::timestamptz, CURRENT_TIMESTAMP) AS effective_now
         FROM attendance_sessions s
         JOIN class_schedules cs ON cs.id = s.schedule_id AND cs.group_id = s.group_id
         WHERE s.id = $1
         FOR SHARE OF cs`,
        [sessionId, now, timing.openBeforeMinutes, timing.closeAfterMinutes]
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

    const adminAbsenceResult = await client.query(
      `SELECT s.group_id, COALESCE(g.display_name, g.name) AS group_name,
          COUNT(DISTINCT ar.student_id)::int AS student_count
       FROM attendance_sessions s
       JOIN groups g ON g.id = s.group_id
       JOIN attendance_records ar ON ar.session_id = s.id AND ar.status = 'absent'
       JOIN students st ON st.id = ar.student_id AND st.is_active = TRUE AND st.deleted_at IS NULL
       WHERE s.id = $1
         AND NOT EXISTS (
           SELECT 1 FROM attendance_records replacement
           WHERE replacement.session_id = ar.session_id
             AND replacement.student_id = ar.student_id
             AND replacement.status IN ('present', 'late')
         )
       GROUP BY s.group_id, g.display_name, g.name`,
      [session.session_id]
    );
    const adminAbsence = adminAbsenceResult.rows[0];
    if (adminAbsence && Number(adminAbsence.student_count) > 0) {
      const recipients = await getAggregatedNotificationRecipients({ type: NotificationType.ATTENDANCE_ABSENCE, groupId: session.group_id, db: client.query.bind(client) });
      await upsertAggregatedNotification({
        type: NotificationType.ATTENDANCE_ABSENCE,
        groupId: session.group_id,
        referenceId: String(session.session_id),
        groupName: adminAbsence.group_name || session.group_name,
        studentCount: Number(adminAbsence.student_count),
        metadata: {
          groupId: Number(session.group_id),
          groupName: adminAbsence.group_name || session.group_name,
          sessionId: Number(session.session_id),
          sessionDate: sessionDateLabel(session.session_date),
          studentCount: Number(adminAbsence.student_count),
          reportFilter: { status: "absent", groupId: Number(session.group_id), sessionId: Number(session.session_id) }
        },
        recipients,
        db: client.query.bind(client)
      });
    }

    const whatsappSettings = await getWhatsAppSettings(client.query.bind(client));

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
    const freezeCandidates = await client.query(
      `SELECT DISTINCT absence.student_id
       FROM attendance_records absence
       JOIN students st ON st.id = absence.student_id
       WHERE absence.session_id = $1
         AND absence.status = 'absent'
         AND st.group_id = $2
         AND st.is_active = TRUE
         AND st.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM attendance_records replacement
           WHERE replacement.session_id = absence.session_id
             AND replacement.student_id = absence.student_id
             AND replacement.status IN ('present', 'late', 'excused')
         )`,
      [session.session_id, session.group_id]
    );

    const queueResult = await queueAbsenceNotifications(client, session, absentResult.rows, { autoSend: whatsappSettings.auto_send });
    // Finalization is complete once every eligible absence has been evaluated.
    // Invalid phone numbers remain visible in audit details instead of making
    // the same closed session retry forever on every finalizer run.
    await client.query(
      `UPDATE attendance_sessions
       SET absence_dispatched = TRUE
       WHERE id = $1 AND status = 'closed' AND absence_dispatched = FALSE`,
      [session.session_id]
    );

    const frozenStudents = [];
    for (const student of freezeCandidates.rows) {
      const frozen = await evaluateAbsenceFreeze(client, student.student_id, session.group_id);
      if (frozen) frozenStudents.push(frozen);
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
        skipped_auto_send_disabled_count: queueResult.skippedCount || 0,
        status_after: "closed",
        absence_dispatched: true
      }
    });

    await client.query("COMMIT");
    return { session_id: session.session_id, queued_count: queueResult.queuedCount, unresolved_count: queueResult.unresolvedCount, skipped_count: queueResult.skippedCount || 0, frozen_count: frozenStudents.length };
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

    const timing = await getAttendanceTimingDefaults(client.query.bind(client));

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
                    + ((CASE WHEN cs.closes_after_minutes = 20 THEN $2 ELSE cs.closes_after_minutes END)::text || ' minutes')::interval)
                   AT TIME ZONE 'Africa/Cairo')
                  <= COALESCE($1::timestamptz, CURRENT_TIMESTAMP))
       ORDER BY s.session_date, s.id`,
      [now, timing.closeAfterMinutes]
    );

    const finalized = [];
    for (const candidate of candidates.rows) {
      const result = await processSession(candidate.id, now);
      if (result?.session_id) finalized.push(result);
    }
    const shouldWakeWorker = finalized.some((result) => Number(result?.queued_count || 0) > 0);
    await client.query("COMMIT");
    transactionStarted = false;
    if (shouldWakeWorker) wakeWhatsAppWorker();
    return { finalized_sessions: finalized };
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK").catch(() => undefined);
    console.error("Failed to run attendance finalizer", error.stack || error);
    throw error;
  } finally {
    client.release();
  }
}
