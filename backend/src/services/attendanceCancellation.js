import { pool } from "../db/pool.js";
import { auditLog } from "./audit.js";
import { enqueueCancellationNotificationsInTransaction, wakeWhatsAppWorker } from "./whatsapp.js";
import { readSystemSettings } from "./systemSettings.js";
import { hasGroupAccess } from "./groupAccess.js";

export function calculateSessionCancellationWindow({ startsAt, endsAt, now, cutoffPercentage = 60 }) {
  const start = new Date(startsAt).getTime();
  const end = new Date(endsAt).getTime();
  const current = new Date(now).getTime();
  const percentage = Number(cutoffPercentage);
  if (![start, end, current, percentage].every(Number.isFinite) || end <= start || percentage < 1 || percentage > 90) {
    return { valid: false, eligible: false, cutoffAt: null };
  }
  const cutoffAt = start + ((end - start) * percentage / 100);
  return { valid: true, eligible: current <= cutoffAt, cutoffAt: new Date(cutoffAt).toISOString() };
}

export function isCancellableAttendanceSessionStatus(status) {
  return status === "open" || status === "closed";
}

export async function cancelAttendanceSession({ sessionId, actor, request = null, db = pool }) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(`
      SELECT s.id, s.group_id, s.schedule_id, s.session_date, s.starts_at, s.ends_at,
        s.status, s.cancelled_at, s.cancelled_by,
        COALESCE(NULLIF(TRIM(g.display_name), ''), NULLIF(TRIM(g.name), ''), '') AS group_name
      FROM attendance_sessions s JOIN groups g ON g.id = s.group_id
      WHERE s.id = $1 FOR UPDATE OF s`, [sessionId]);
    if (!found.rowCount) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "not_found" };
    }
    const session = found.rows[0];
    if (!hasGroupAccess(actor, session.group_id)) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "group_access_forbidden" };
    }
    if (session.status === "cancelled") {
      await client.query("ROLLBACK");
      return { ok: false, reason: "already_cancelled", cancelled_at: session.cancelled_at };
    }
    if (!isCancellableAttendanceSessionStatus(session.status)) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "session_not_cancellable" };
    }

    const { settings } = await readSystemSettings(client.query.bind(client));
    const clock = await client.query("SELECT clock_timestamp() AS server_now");
    const window = calculateSessionCancellationWindow({
      startsAt: session.starts_at,
      endsAt: session.ends_at,
      now: clock.rows[0].server_now,
      cutoffPercentage: settings.attendance_cancellation_cutoff_percentage
    });
    if (!window.valid) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "invalid_session_window" };
    }
    if (!window.eligible) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "cancellation_window_closed", cutoff_at: window.cutoffAt };
    }

    const cancelledAt = clock.rows[0].server_now;
    const updated = await client.query(`
      UPDATE attendance_sessions
      SET status = 'cancelled', cancelled_at = $2, cancelled_by = $3
      WHERE id = $1 AND status IN ('open', 'closed')
      RETURNING id, group_id, session_date, starts_at, ends_at, status, cancelled_at, cancelled_by`,
    [session.id, cancelledAt, actor.id]);
    if (!updated.rowCount) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "already_cancelled" };
    }

    const settled = await client.query(`
      UPDATE whatsapp_notification_jobs j
      SET status = 'skipped', last_error = 'attendance_session_cancelled',
        next_attempt_at = NULL, lease_expires_at = NULL, claim_token = NULL,
        send_started_at = NULL, updated_at = NOW()
      FROM attendance_records ar
      WHERE j.notification_type = 'absence'
        AND ar.session_id = $1
        AND ar.id = COALESCE(j.attendance_record_id, j.source_id)
        AND j.status IN ('pending', 'processing')
        AND j.send_started_at IS NULL`, [session.id]);

    const notices = await enqueueCancellationNotificationsInTransaction(client, {
      session: { ...session, ...updated.rows[0], group_name: session.group_name },
      actorId: actor.id
    });
    await auditLog({
      db: client,
      action: "attendance_session_cancelled",
      actorId: actor.id,
      sessionId: session.id,
      details: {
        session_id: session.id,
        group_id: session.group_id,
        session_date: String(session.session_date).slice(0, 10),
        schedule_id: session.schedule_id,
        status_before: session.status,
        status_after: "cancelled",
        cancelled_at: cancelledAt,
        cutoff_percentage: settings.attendance_cancellation_cutoff_percentage,
        cutoff_at: window.cutoffAt,
        settled_absence_jobs: settled.rowCount,
        cancellation_notice_queued: notices.queuedCount,
        cancellation_notice_review_required: notices.reviewCount,
        cancellation_notice_skipped: notices.skippedCount
      },
      request
    });
    await client.query("COMMIT");
    if (notices.queuedCount > 0) wakeWhatsAppWorker();
    return { ok: true, session: updated.rows[0], cutoff_at: window.cutoffAt, cutoff_percentage: settings.attendance_cancellation_cutoff_percentage, notices, settled_absence_jobs: settled.rowCount };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function approveCancellationNoticeForSend({ jobId, actor, request = null, db = pool }) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const scope = await client.query(`
      SELECT j.cancellation_session_id, s.group_id
      FROM whatsapp_notification_jobs j
      JOIN attendance_sessions s ON s.id = j.cancellation_session_id
      WHERE j.id = $1 AND j.notification_type = 'cancellation'`, [jobId]);
    if (!scope.rowCount) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "not_found" };
    }
    const lockedSession = await client.query(
      "SELECT id, group_id, status FROM attendance_sessions WHERE id = $1 FOR UPDATE",
      [scope.rows[0].cancellation_session_id]
    );
    if (!lockedSession.rowCount) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "not_found" };
    }
    if (!hasGroupAccess(actor, lockedSession.rows[0].group_id)) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "group_access_forbidden" };
    }
    if (lockedSession.rows[0].status !== "cancelled") {
      await client.query("ROLLBACK");
      return { ok: false, reason: "cancellation_no_longer_eligible" };
    }
    const job = await client.query(`
      SELECT id, student_id, status, last_error
      FROM whatsapp_notification_jobs
      WHERE id = $1 AND notification_type = 'cancellation'
      FOR UPDATE`, [jobId]);
    if (!job.rowCount) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "not_found" };
    }
    if (job.rows[0].status !== "review_required") {
      await client.query("ROLLBACK");
      return { ok: false, reason: job.rows[0].status === "pending" || job.rows[0].status === "sent" ? "already_approved" : "notice_not_reviewable" };
    }
    if (job.rows[0].last_error) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "notice_not_eligible" };
    }
    const approved = await client.query(`
      UPDATE whatsapp_notification_jobs
      SET status = 'pending', approved_by = $2, approved_at = NOW(),
        last_error = NULL, next_attempt_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'review_required'
      RETURNING id, status`, [jobId, actor.id]);
    await auditLog({
      db: client,
      action: "whatsapp_cancellation_notice_approved",
      actorId: actor.id,
      sessionId: lockedSession.rows[0].id,
      details: { job_id: jobId, group_id: lockedSession.rows[0].group_id, session_id: lockedSession.rows[0].id, status_after: "pending" },
      request
    });
    await client.query("COMMIT");
    wakeWhatsAppWorker();
    return { ok: true, ...approved.rows[0] };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
