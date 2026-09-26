import "../config/env.js";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pool, query } from "./pool.js";
import { hashPassword } from "../services/auth.js";
import { DEFAULT_ADMIN_PERMISSIONS, DEFAULT_STAFF_PERMISSIONS, OWNER_USER_ID } from "../services/rbac.js";
import { DEFAULT_HOME_CONTENT } from "@abdrabo/shared/landingContent.js";

export async function migrate() {
  // 1. Define the schema and create the core tables.
  await query(`
    CREATE SCHEMA IF NOT EXISTS public;
    SET search_path TO public;

    CREATE TABLE IF NOT EXISTS centers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      address TEXT NOT NULL,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      allowed_radius_meters INTEGER NOT NULL DEFAULT 150,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS groups (
      id SERIAL PRIMARY KEY,
      center_id INTEGER NOT NULL REFERENCES centers(id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      grade TEXT NOT NULL,
      subject TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS students (
      id SERIAL PRIMARY KEY,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
      student_code TEXT NOT NULL UNIQUE,
      student_serial TEXT,
      scan_serial TEXT,
      qr_token TEXT,
      full_name TEXT NOT NULL,
      phone TEXT,
      guardian_phone TEXT,
      whatsapp_opted_out BOOLEAN NOT NULL DEFAULT FALSE,
      national_id_hash TEXT,
      billing_start_month DATE,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      purge_after TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS class_schedules (
      id SERIAL PRIMARY KEY,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      slot_key TEXT NOT NULL DEFAULT md5(random()::text || clock_timestamp()::text),
      day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
      start_time TIME NOT NULL,
      end_time TIME NOT NULL,
      opens_before_minutes INTEGER NOT NULL DEFAULT 3,
      closes_after_minutes INTEGER NOT NULL DEFAULT 20,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      deleted_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS attendance_sessions (
      id SERIAL PRIMARY KEY,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      schedule_id INTEGER REFERENCES class_schedules(id) ON DELETE SET NULL,
      occurrence_key TEXT NOT NULL,
      session_date DATE NOT NULL,
      starts_at TIMESTAMPTZ NOT NULL,
      opens_at TIMESTAMPTZ NOT NULL,
      closes_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      original_starts_at TIMESTAMPTZ NOT NULL,
      original_opens_at TIMESTAMPTZ NOT NULL,
      original_closes_at TIMESTAMPTZ NOT NULL,
      original_ends_at TIMESTAMPTZ NOT NULL,
      rescheduled_at TIMESTAMPTZ,
      rescheduled_by INTEGER,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
      absence_dispatched BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS attendance_records (
      id SERIAL PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
      student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
      student_name_snapshot TEXT,
      student_code_snapshot TEXT,
      status TEXT NOT NULL DEFAULT 'present' CHECK (status IN ('present', 'absent', 'late', 'pending_review', 'rejected', 'excused')),
      method TEXT NOT NULL DEFAULT 'gps',
      checkin_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      location_lat DOUBLE PRECISION,
      location_lng DOUBLE PRECISION,
      distance_meters DOUBLE PRECISION,
      device_id TEXT,
      ip_address TEXT,
      is_suspicious BOOLEAN NOT NULL DEFAULT FALSE,
      suspicious_reason TEXT,
      whatsapp_notified BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (session_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS exams (
      id SERIAL PRIMARY KEY,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      max_score NUMERIC(6,2) NOT NULL,
      exam_date DATE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS exam_results (
      id SERIAL PRIMARY KEY,
      exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
      student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
      student_name_snapshot TEXT,
      student_code_snapshot TEXT,
      score NUMERIC(6,2) NOT NULL,
      note TEXT,
      whatsapp_notified BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (exam_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS teachers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      username TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      auth_version INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('owner', 'admin', 'manager', 'staff')),
      permissions JSONB NOT NULL DEFAULT '[]'::jsonb,
      permissions_initialized BOOLEAN NOT NULL DEFAULT FALSE,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      print_student_labels BOOLEAN NOT NULL DEFAULT FALSE,
      max_label_reprints INTEGER NOT NULL DEFAULT 2 CHECK (max_label_reprints >= 0),
      can_use_inbox BOOLEAN NOT NULL DEFAULT FALSE,
      audit_pin_hash TEXT,
      audit_pin_failed_attempts INTEGER NOT NULL DEFAULT 0,
      audit_pin_locked_until TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS teacher_group_access (
      teacher_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (teacher_id, group_id)
    );
    CREATE INDEX IF NOT EXISTS teacher_group_access_group_idx
      ON teacher_group_access(group_id, teacher_id);
    ALTER TABLE teachers ADD COLUMN IF NOT EXISTS audit_pin_hash TEXT;
    ALTER TABLE teachers ADD COLUMN IF NOT EXISTS audit_pin_failed_attempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE teachers ADD COLUMN IF NOT EXISTS audit_pin_locked_until TIMESTAMPTZ;

    CREATE TABLE IF NOT EXISTS site_pages (
      id SERIAL PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      title_ar TEXT NOT NULL,
      title_en TEXT NOT NULL,
      subtitle_ar TEXT NOT NULL,
      subtitle_en TEXT NOT NULL,
      content_ar JSONB NOT NULL DEFAULT '{}'::jsonb,
      content_en JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS site_content (
      key VARCHAR PRIMARY KEY,
      content JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS homeworks (
      id BIGSERIAL PRIMARY KEY,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      due_date TIMESTAMPTZ,
      attachment_url TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS homework_submissions (
      id BIGSERIAL PRIMARY KEY,
      homework_id BIGINT NOT NULL REFERENCES homeworks(id) ON DELETE CASCADE,
      student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
      student_name_snapshot TEXT,
      student_code_snapshot TEXT,
      status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','late')),
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (homework_id, student_id)
    );

    CREATE TABLE IF NOT EXISTS system_settings (
      key TEXT PRIMARY KEY CHECK (key IN (
        'attendance_open_before_minutes',
        'attendance_close_after_minutes',
        'attendance_alert_threshold',
        'attendance_cancellation_cutoff_percentage',
        'absence_freeze_limit',
        'evaluation_alert_threshold',
        'password_recovery_enabled',
        'password_recovery_provider',
        'password_recovery_from_email',
        'gemini_model',
        'ai_provider_gemini',
        'ai_provider_groq',
        'ai_provider_mistral',
        'ai_provider_openrouter',
        'ai_provider_cloudflare',
        'ai_routing_strategy'
      )),
      value_json JSONB NOT NULL,
      updated_by INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id BIGSERIAL PRIMARY KEY,
      recipient_user_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      notification_type TEXT,
      entity_type TEXT,
      entity_id BIGINT,
      target_section TEXT,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      title TEXT,
      message TEXT,
      group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
      reference_id TEXT,
      student_count INTEGER CHECK (student_count IS NULL OR student_count >= 0),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      dedupe_key TEXT NOT NULL,
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      read_at TIMESTAMPTZ,
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (recipient_user_id, dedupe_key)
    );
    CREATE INDEX IF NOT EXISTS notifications_recipient_state_idx
      ON notifications(recipient_user_id, resolved_at, is_read, created_at DESC);

    CREATE TABLE IF NOT EXISTS system_secrets (
      key TEXT PRIMARY KEY,
      encrypted_value TEXT NOT NULL,
      iv TEXT NOT NULL,
      auth_tag TEXT NOT NULL,
      updated_by INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS password_reset_requests (
      id UUID PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
      code_hash TEXT NOT NULL,
      reset_token_hash TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      reset_token_expires_at TIMESTAMPTZ,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      verified_at TIMESTAMPTZ,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS password_reset_requests_user_idx
      ON password_reset_requests(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS password_reset_requests_expiry_idx
      ON password_reset_requests(expires_at);
  `);
  await query(
    "INSERT INTO system_settings (key, value_json) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING",
    ["ai_routing_strategy", JSON.stringify("adaptive_parallel")]
  );

  // 2. Add compatible columns and constraints for existing installations.
  await query("ALTER TABLE system_settings DROP CONSTRAINT IF EXISTS system_settings_key_check");
  await query("ALTER TABLE system_settings ADD CONSTRAINT system_settings_key_check CHECK (key IN ('attendance_open_before_minutes', 'attendance_close_after_minutes', 'attendance_alert_threshold', 'attendance_cancellation_cutoff_percentage', 'evaluation_alert_threshold', 'password_recovery_enabled', 'password_recovery_provider', 'password_recovery_from_email', 'gemini_model', 'absence_freeze_limit', 'ai_provider_gemini', 'ai_provider_groq', 'ai_provider_mistral', 'ai_provider_openrouter', 'ai_provider_cloudflare', 'ai_routing_strategy'))");
  await query("INSERT INTO system_settings (key, value_json) VALUES ('attendance_cancellation_cutoff_percentage', '60'::jsonb), ('absence_freeze_limit', '4'::jsonb) ON CONFLICT (key) DO NOTHING");
  await query(`
    SET search_path TO public;

    ALTER TABLE teachers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE teachers ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE teachers ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '[]'::jsonb;
    ALTER TABLE teachers ADD COLUMN IF NOT EXISTS permissions_initialized BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE teachers ADD COLUMN IF NOT EXISTS print_student_labels BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE teachers ADD COLUMN IF NOT EXISTS max_label_reprints INTEGER NOT NULL DEFAULT 2 CHECK (max_label_reprints >= 0);
    ALTER TABLE teachers ADD COLUMN IF NOT EXISTS can_use_inbox BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE teachers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS notification_type TEXT;
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS title TEXT;
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS message TEXT;
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS group_id INTEGER;
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS reference_id TEXT;
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS student_count INTEGER;
    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
    UPDATE notifications SET notification_type = type WHERE notification_type IS NULL;
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notifications_group_id_fkey') THEN
        ALTER TABLE notifications ADD CONSTRAINT notifications_group_id_fkey
          FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notifications_student_count_check') THEN
        ALTER TABLE notifications ADD CONSTRAINT notifications_student_count_check
          CHECK (student_count IS NULL OR student_count >= 0);
      END IF;
    END $$;
    CREATE INDEX IF NOT EXISTS notifications_type_group_reference_idx
      ON notifications(notification_type, group_id, reference_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS notifications_group_idx
      ON notifications(group_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS notifications_reference_idx
      ON notifications(reference_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS notifications_aggregated_dedupe_unique
      ON notifications(dedupe_key)
      WHERE notification_type IN ('attendance_absence', 'unpaid_fees', 'low_exam_grade');

    ALTER TABLE system_settings DROP CONSTRAINT IF EXISTS system_settings_key_check;
    ALTER TABLE system_settings ADD CONSTRAINT system_settings_key_check CHECK (key IN (
      'attendance_open_before_minutes',
      'attendance_close_after_minutes',
      'attendance_alert_threshold',
      'attendance_cancellation_cutoff_percentage',
      'absence_freeze_limit',
      'evaluation_alert_threshold',
      'password_recovery_enabled',
      'password_recovery_provider',
      'password_recovery_from_email',
      'gemini_model',
      'ai_provider_gemini',
      'ai_provider_groq',
      'ai_provider_mistral',
      'ai_provider_openrouter',
      'ai_provider_cloudflare',
      'ai_routing_strategy'
    ));

    ALTER TABLE teachers DROP CONSTRAINT IF EXISTS teachers_role_check;
    UPDATE teachers SET role = 'staff' WHERE role IN ('teacher', 'assistant');
    ALTER TABLE teachers ADD CONSTRAINT teachers_role_check CHECK (role IN ('owner', 'admin', 'manager', 'staff'));

    ALTER TABLE groups ADD COLUMN IF NOT EXISTS grade_level TEXT;
    ALTER TABLE groups ADD COLUMN IF NOT EXISTS display_name TEXT;
    ALTER TABLE groups ADD COLUMN IF NOT EXISTS fees_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (fees_amount >= 0);
    ALTER TABLE groups ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE groups ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

    ALTER TABLE class_schedules ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    ALTER TABLE class_schedules ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE class_schedules ADD COLUMN IF NOT EXISTS slot_key TEXT;

    ALTER TABLE students ADD COLUMN IF NOT EXISTS student_serial TEXT;
    ALTER TABLE students ADD COLUMN IF NOT EXISTS scan_serial TEXT;
    ALTER TABLE students ADD COLUMN IF NOT EXISTS qr_token TEXT;
    ALTER TABLE students ADD COLUMN IF NOT EXISTS gender TEXT NOT NULL DEFAULT 'unknown';
    ALTER TABLE students ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE students ADD COLUMN IF NOT EXISTS purge_after TIMESTAMPTZ;
    ALTER TABLE students ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    ALTER TABLE students ADD COLUMN IF NOT EXISTS billing_start_month DATE;
    ALTER TABLE students ADD COLUMN IF NOT EXISTS absence_frozen BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE students ADD COLUMN IF NOT EXISTS absence_frozen_at TIMESTAMPTZ;
    ALTER TABLE students ADD COLUMN IF NOT EXISTS absence_frozen_reason TEXT;
    ALTER TABLE students ADD COLUMN IF NOT EXISTS absence_frozen_streak INTEGER;
    ALTER TABLE students ADD COLUMN IF NOT EXISTS absence_frozen_by INTEGER REFERENCES teachers(id) ON DELETE SET NULL;
    ALTER TABLE students ADD COLUMN IF NOT EXISTS absence_unfrozen_at TIMESTAMPTZ;
    ALTER TABLE students ADD COLUMN IF NOT EXISTS absence_unfrozen_by INTEGER REFERENCES teachers(id) ON DELETE SET NULL;
    ALTER TABLE students ADD COLUMN IF NOT EXISTS pin_hash TEXT;
    ALTER TABLE students ADD COLUMN IF NOT EXISTS pin_set_at TIMESTAMPTZ;
    ALTER TABLE students ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE students DROP CONSTRAINT IF EXISTS students_auth_version_check;
    ALTER TABLE students ADD CONSTRAINT students_auth_version_check CHECK (auth_version >= 0);
    ALTER TABLE students DROP CONSTRAINT IF EXISTS students_gender_check;
    ALTER TABLE students ADD CONSTRAINT students_gender_check CHECK (gender IN ('male', 'female', 'unknown'));

    ALTER TABLE attendance_records DROP CONSTRAINT IF EXISTS attendance_records_status_check;
    ALTER TABLE attendance_records ADD CONSTRAINT attendance_records_status_check CHECK (status IN ('present','absent','late','pending_review','rejected','excused'));
    ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
    ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS student_name_snapshot TEXT;
    ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS student_code_snapshot TEXT;
    ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS whatsapp_notified BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ;
    ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS absence_dispatched BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS occurrence_key TEXT;
    ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS original_starts_at TIMESTAMPTZ;
    ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS original_opens_at TIMESTAMPTZ;
    ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS original_closes_at TIMESTAMPTZ;
    ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS original_ends_at TIMESTAMPTZ;
    ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS rescheduled_at TIMESTAMPTZ;
    ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS rescheduled_by INTEGER;
    ALTER TABLE exam_results ADD COLUMN IF NOT EXISTS student_name_snapshot TEXT;
    ALTER TABLE exam_results ADD COLUMN IF NOT EXISTS student_code_snapshot TEXT;
    ALTER TABLE exam_results ADD COLUMN IF NOT EXISTS whatsapp_notified BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE homework_submissions ADD COLUMN IF NOT EXISTS student_name_snapshot TEXT;
    ALTER TABLE homework_submissions ADD COLUMN IF NOT EXISTS student_code_snapshot TEXT;
    UPDATE groups SET grade_level = COALESCE(grade_level, grade), display_name = COALESCE(display_name, name);
  `);

  // Stable schedule-slot and attendance-occurrence identities. A recurring
  // schedule can change its wall-clock time, but a dated attendance session
  // must remain the same occurrence for records and outbox jobs.
  await query(`
    SET search_path TO public;

    UPDATE class_schedules
    SET slot_key = md5('class-schedule-slot:' || id::text)
    WHERE slot_key IS NULL;

    ALTER TABLE class_schedules
      ALTER COLUMN slot_key SET DEFAULT md5(random()::text || clock_timestamp()::text);
    ALTER TABLE class_schedules ALTER COLUMN slot_key SET NOT NULL;
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'attendance_sessions_rescheduled_by_fkey'
      ) THEN
        ALTER TABLE attendance_sessions
          ADD CONSTRAINT attendance_sessions_rescheduled_by_fkey
          FOREIGN KEY (rescheduled_by) REFERENCES teachers(id) ON DELETE SET NULL;
      END IF;
    END $$;

  `);

  await query(`
    SET search_path TO public;
    CREATE TABLE IF NOT EXISTS attendance_session_reschedules (
      id BIGSERIAL PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE RESTRICT,
      actor_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
      previous_starts_at TIMESTAMPTZ NOT NULL,
      previous_opens_at TIMESTAMPTZ NOT NULL,
      previous_closes_at TIMESTAMPTZ NOT NULL,
      previous_ends_at TIMESTAMPTZ NOT NULL,
      next_starts_at TIMESTAMPTZ NOT NULL,
      next_opens_at TIMESTAMPTZ NOT NULL,
      next_closes_at TIMESTAMPTZ NOT NULL,
      next_ends_at TIMESTAMPTZ NOT NULL,
      reason TEXT NOT NULL DEFAULT 'schedule_updated',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS attendance_session_reschedules_session_idx
      ON attendance_session_reschedules(session_id, created_at DESC);
  `);

  // 3. Normalize records and serial formats.
  await query(`
    SET search_path TO public;

    UPDATE students
    SET phone = translate(phone, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'),
        guardian_phone = translate(guardian_phone, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789'),
        student_code = CASE WHEN student_code ~ '^A[0-9]{4}$' THEN 'A-' || SUBSTRING(student_code FROM 2) ELSE student_code END,
        student_serial = CASE
          WHEN student_serial IS NULL AND student_code ~ '^A-[0-9]{4}$' THEN student_code
          WHEN student_serial IS NULL AND student_code ~ '^A[0-9]{4}$' THEN 'A-' || SUBSTRING(student_code FROM 2)
          WHEN student_serial ~ '^A[0-9]{4}$' THEN 'A-' || SUBSTRING(student_serial FROM 2)
          ELSE student_serial
        END,
        scan_serial = CASE 
          WHEN scan_serial IS NOT NULL THEN translate(scan_serial, '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹', '01234567890123456789')
          ELSE scan_serial
        END
    WHERE (phone IS NOT NULL AND phone ~ '[٠-٩۰-۹]')
       OR (guardian_phone IS NOT NULL AND guardian_phone ~ '[٠-٩۰-۹]')
       OR student_code ~ '^A[0-9]{4}$'
       OR (student_serial IS NOT NULL AND (student_serial ~ '[٠-٩۰-۹]' OR student_serial ~ '^A[0-9]{4}$'))
       OR (scan_serial IS NOT NULL AND scan_serial ~ '[٠-٩۰-۹]');

    UPDATE students 
    SET student_serial = COALESCE(student_serial, CASE WHEN student_code ~ '^A[0-9]{4}$' THEN 'A-' || SUBSTRING(student_code FROM 2) ELSE student_code END), 
        qr_token = COALESCE(qr_token, md5(random()::text || clock_timestamp()::text || id::text));

    UPDATE students 
    SET scan_serial = COALESCE(scan_serial, 'ABD-' || REPLACE(COALESCE(student_code, 'A-' || id::text), '-', '') || '-' || LPAD(id::text, 6, '0'));

    CREATE UNIQUE INDEX IF NOT EXISTS students_student_serial_unique ON students(student_serial);
    CREATE UNIQUE INDEX IF NOT EXISTS students_scan_serial_unique ON students(scan_serial);
    CREATE UNIQUE INDEX IF NOT EXISTS students_qr_token_unique ON students(qr_token);
    CREATE UNIQUE INDEX IF NOT EXISTS class_schedules_group_day_time_unique ON class_schedules(group_id, day_of_week, start_time, end_time);

    -- Keep sessions whose recurring schedule was physically removed. Their
    -- occurrence and attendance history must remain auditable.
    -- Older releases capped custom attendance windows at the class end and
    -- finalized sessions using ends_at. Repair only sessions that were closed
    -- by that rule and had no real attendance activity, so the new window can
    -- be used without changing manual or scanned records.
    DELETE FROM attendance_records ar
    USING attendance_sessions s
    JOIN class_schedules cs ON cs.id = s.schedule_id AND cs.group_id = s.group_id
    WHERE ar.session_id = s.id
      AND s.status = 'closed'
      AND ar.method = 'system'
      AND cs.closes_after_minutes > 20
      AND NOT EXISTS (
        SELECT 1 FROM attendance_records existing
        WHERE existing.session_id = s.id AND existing.method <> 'system'
      )
      AND (NOW() AT TIME ZONE 'Africa/Cairo') BETWEEN
        (s.session_date + cs.start_time - (cs.opens_before_minutes || ' minutes')::interval)
        AND (s.session_date + cs.start_time + (cs.closes_after_minutes || ' minutes')::interval);

    UPDATE attendance_sessions s
    SET status = 'open'
    FROM class_schedules cs
    WHERE cs.id = s.schedule_id
      AND cs.group_id = s.group_id
      AND s.status = 'closed'
      AND cs.closes_after_minutes > 20
      AND NOT EXISTS (
        SELECT 1 FROM attendance_records ar
        WHERE ar.session_id = s.id AND ar.method <> 'system'
      )
      AND (NOW() AT TIME ZONE 'Africa/Cairo') BETWEEN
        (s.session_date + cs.start_time - (cs.opens_before_minutes || ' minutes')::interval)
        AND (s.session_date + cs.start_time + (cs.closes_after_minutes || ' minutes')::interval);

    UPDATE attendance_sessions s
    SET starts_at = ((s.session_date + cs.start_time) AT TIME ZONE 'Africa/Cairo'),
        opens_at = ((s.session_date + cs.start_time - (cs.opens_before_minutes || ' minutes')::interval) AT TIME ZONE 'Africa/Cairo'),
        closes_at = CASE
          WHEN cs.closes_after_minutes IS NOT NULL AND cs.closes_after_minutes <> 20
            THEN ((s.session_date + cs.start_time + (cs.closes_after_minutes || ' minutes')::interval) AT TIME ZONE 'Africa/Cairo')
          ELSE ((s.session_date + cs.start_time + INTERVAL '20 minutes') AT TIME ZONE 'Africa/Cairo')
        END,
        ends_at = (((s.session_date + CASE WHEN cs.end_time <= cs.start_time THEN 1 ELSE 0 END) + cs.end_time) AT TIME ZONE 'Africa/Cairo')
    FROM class_schedules cs
    WHERE cs.id = s.schedule_id AND cs.group_id = s.group_id;

    UPDATE attendance_sessions s
    SET occurrence_key = COALESCE(cs.slot_key, 'legacy-attendance-session:' || s.id::text),
        original_starts_at = COALESCE(s.original_starts_at, s.starts_at),
        original_opens_at = COALESCE(s.original_opens_at, s.opens_at),
        original_closes_at = COALESCE(s.original_closes_at, s.closes_at),
        original_ends_at = COALESCE(s.original_ends_at, s.ends_at)
    FROM class_schedules cs
    WHERE cs.id = s.schedule_id AND cs.group_id = s.group_id;

    UPDATE attendance_sessions
    SET occurrence_key = COALESCE(occurrence_key, 'legacy-attendance-session:' || id::text),
        original_starts_at = COALESCE(original_starts_at, starts_at),
        original_opens_at = COALESCE(original_opens_at, opens_at),
        original_closes_at = COALESCE(original_closes_at, closes_at),
        original_ends_at = COALESCE(original_ends_at, ends_at)
    WHERE occurrence_key IS NULL
       OR original_starts_at IS NULL
       OR original_opens_at IS NULL
       OR original_closes_at IS NULL
       OR original_ends_at IS NULL;

    ALTER TABLE attendance_sessions ALTER COLUMN ends_at SET NOT NULL;
    ALTER TABLE attendance_sessions ALTER COLUMN occurrence_key SET NOT NULL;
    ALTER TABLE attendance_sessions ALTER COLUMN original_starts_at SET NOT NULL;
    ALTER TABLE attendance_sessions ALTER COLUMN original_opens_at SET NOT NULL;
    ALTER TABLE attendance_sessions ALTER COLUMN original_closes_at SET NOT NULL;
    ALTER TABLE attendance_sessions ALTER COLUMN original_ends_at SET NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS class_schedules_slot_key_unique ON class_schedules(slot_key);
    ALTER TABLE attendance_sessions DROP CONSTRAINT IF EXISTS attendance_sessions_group_schedule_date_unique;
    CREATE UNIQUE INDEX IF NOT EXISTS attendance_sessions_group_occurrence_date_unique
      ON attendance_sessions(group_id, occurrence_key, session_date);

  `);

  // 4. Create inbox, audit, and payment tables.
  await query(`
    SET search_path TO public;

    CREATE TABLE IF NOT EXISTS inbox_threads (
      id BIGSERIAL PRIMARY KEY,
      student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
      public_name TEXT,
      public_phone TEXT,
      subject TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (student_id IS NOT NULL OR public_name IS NOT NULL)
    );
    CREATE TABLE IF NOT EXISTS inbox_messages (
      id BIGSERIAL PRIMARY KEY,
      thread_id BIGINT NOT NULL REFERENCES inbox_threads(id) ON DELETE CASCADE,
      sender_type TEXT NOT NULL CHECK (sender_type IN ('student', 'admin', 'teacher', 'assistant', 'public')),
      sender_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
      body TEXT NOT NULL,
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS inbox_threads_student_idx ON inbox_threads(student_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS inbox_messages_thread_idx ON inbox_messages(thread_id, created_at);
    CREATE INDEX IF NOT EXISTS inbox_messages_unread_idx ON inbox_messages(is_read, created_at);
    ALTER TABLE inbox_messages
      ADD COLUMN IF NOT EXISTS sender_student_id INTEGER REFERENCES students(id) ON DELETE SET NULL;

    CREATE TABLE IF NOT EXISTS external_contacts (
      id BIGSERIAL PRIMARY KEY,
      canonical_phone TEXT NOT NULL UNIQUE,
      display_phone TEXT,
      display_name TEXT,
      source TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS external_conversations (
      id BIGSERIAL PRIMARY KEY,
      external_contact_id BIGINT NOT NULL REFERENCES external_contacts(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
      source_type TEXT,
      last_inquiry_id BIGINT REFERENCES inbox_threads(id) ON DELETE SET NULL,
      last_message_at TIMESTAMPTZ,
      last_message_preview TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS external_conversations_active_contact_idx
      ON external_conversations(external_contact_id) WHERE status = 'open';
    CREATE INDEX IF NOT EXISTS external_conversations_updated_idx
      ON external_conversations(updated_at DESC);
    CREATE TABLE IF NOT EXISTS external_messages (
      id BIGSERIAL PRIMARY KEY,
      external_conversation_id BIGINT NOT NULL REFERENCES external_conversations(id) ON DELETE CASCADE,
      direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
      body TEXT NOT NULL,
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending', 'processing', 'sent', 'delivered', 'read', 'failed', 'delivery_unknown', 'review_required')),
      provider_message_id TEXT,
      whatsapp_job_id BIGINT,
      created_by_teacher_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS external_messages_provider_id_idx
      ON external_messages(provider_message_id) WHERE provider_message_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS external_messages_conversation_idx
      ON external_messages(external_conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS external_messages_unread_idx
      ON external_messages(is_read, created_at) WHERE direction = 'inbound';
  `);

  await query(`
    SET search_path TO public;

    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGSERIAL PRIMARY KEY, 
      action TEXT NOT NULL,
      actor_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
      student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
      payment_id BIGINT,
      session_id INTEGER REFERENCES attendance_sessions(id) ON DELETE SET NULL,
      details JSONB NOT NULL DEFAULT '{}'::jsonb, 
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS payment_id BIGINT;
    CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS audit_logs_actor_idx ON audit_logs(actor_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS audit_logs_action_idx ON audit_logs(action, created_at DESC);
    CREATE INDEX IF NOT EXISTS audit_logs_student_idx ON audit_logs(student_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS audit_logs_payment_idx ON audit_logs(payment_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS audit_logs_entity_type_idx ON audit_logs((details->>'entity_type'), created_at DESC);
    CREATE INDEX IF NOT EXISTS audit_logs_group_id_idx ON audit_logs(
      (CASE WHEN (details->>'group_id') ~ '^[0-9]+$' THEN (details->>'group_id')::bigint END), created_at DESC
    ) WHERE (details->>'group_id') ~ '^[0-9]+$';
    CREATE TABLE IF NOT EXISTS audit_log_deletions (
      id BIGSERIAL PRIMARY KEY,
      actor_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
      date_from DATE NOT NULL,
      date_to DATE NOT NULL,
      deleted_count INTEGER NOT NULL CHECK (deleted_count >= 0),
      reason TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS audit_log_deletions_created_at_idx ON audit_log_deletions(created_at DESC);
    CREATE TABLE IF NOT EXISTS payments (
      id BIGSERIAL PRIMARY KEY,
      student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
      amount NUMERIC(10,2) NOT NULL CHECK (amount > 0), 
      paid_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
      discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
      is_exempt BOOLEAN NOT NULL DEFAULT FALSE,
      payment_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      payment_method TEXT NOT NULL DEFAULT 'cash', 
      notes TEXT,
      recorded_by INTEGER REFERENCES teachers(id) ON DELETE SET NULL, 
      paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      paid_by INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
      payment_months JSONB NOT NULL DEFAULT '[]'::jsonb,
      payment_type TEXT NOT NULL DEFAULT 'normal',
      whatsapp_notified BOOLEAN NOT NULL DEFAULT FALSE,
      student_name_snapshot TEXT,
      student_code_snapshot TEXT,
      student_serial_snapshot TEXT,
      scan_serial_snapshot TEXT,
      group_name_snapshot TEXT,
      grade_level_snapshot TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_type TEXT NOT NULL DEFAULT 'normal';
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(10,2) NOT NULL DEFAULT 0;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS is_exempt BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS whatsapp_notified BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS student_name_snapshot TEXT;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS student_code_snapshot TEXT;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS student_serial_snapshot TEXT;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS scan_serial_snapshot TEXT;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS group_name_snapshot TEXT;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS grade_level_snapshot TEXT;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_reference TEXT;
    UPDATE payments SET paid_amount = CASE WHEN paid_amount = 0 AND amount > 0 THEN amount ELSE paid_amount END,
      discount_amount = COALESCE(discount_amount, 0), is_exempt = COALESCE(is_exempt, FALSE);
    ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_amount_check;
    ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_paid_amount_check;
    ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_discount_amount_check;
    ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_exemption_check;
    ALTER TABLE payments ADD CONSTRAINT payments_amount_check CHECK (is_exempt OR amount > 0);
    ALTER TABLE payments ADD CONSTRAINT payments_paid_amount_check CHECK (paid_amount >= 0 AND paid_amount = amount);
    ALTER TABLE payments ADD CONSTRAINT payments_discount_amount_check CHECK (discount_amount >= 0);
    ALTER TABLE payments ADD CONSTRAINT payments_exemption_check CHECK ((is_exempt AND paid_amount = 0) OR NOT is_exempt);

    CREATE TABLE IF NOT EXISTS payment_reversals (
      id BIGSERIAL PRIMARY KEY,
      payment_id BIGINT NOT NULL UNIQUE REFERENCES payments(id) ON DELETE RESTRICT,
      reversed_by INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
      reason TEXT NOT NULL,
      original_amount NUMERIC(10,2) NOT NULL CHECK (original_amount >= 0),
      covered_amount NUMERIC(10,2),
      discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
      exemption_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE payment_reversals ADD COLUMN IF NOT EXISTS original_amount NUMERIC(10,2);
    ALTER TABLE payment_reversals ADD COLUMN IF NOT EXISTS covered_amount NUMERIC(10,2);
    ALTER TABLE payment_reversals ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(10,2) NOT NULL DEFAULT 0;
    ALTER TABLE payment_reversals ADD COLUMN IF NOT EXISTS exemption_amount NUMERIC(10,2) NOT NULL DEFAULT 0;
    UPDATE payment_reversals pr
    SET original_amount = COALESCE(pr.original_amount, p.amount),
        covered_amount = COALESCE(pr.covered_amount, COALESCE(pr.original_amount, p.amount)),
        discount_amount = COALESCE(pr.discount_amount, 0),
        exemption_amount = COALESCE(pr.exemption_amount, 0)
    FROM payments p
    WHERE p.id = pr.payment_id
      AND (pr.original_amount IS NULL OR pr.covered_amount IS NULL OR pr.discount_amount IS NULL OR pr.exemption_amount IS NULL);
    ALTER TABLE payment_reversals DROP CONSTRAINT IF EXISTS payment_reversals_original_amount_check;
    ALTER TABLE payment_reversals DROP CONSTRAINT IF EXISTS payment_reversals_covered_amount_check;
    ALTER TABLE payment_reversals DROP CONSTRAINT IF EXISTS payment_reversals_discount_amount_check;
    ALTER TABLE payment_reversals DROP CONSTRAINT IF EXISTS payment_reversals_exemption_amount_check;
    ALTER TABLE payment_reversals ADD CONSTRAINT payment_reversals_original_amount_check CHECK (original_amount >= 0);
    ALTER TABLE payment_reversals ADD CONSTRAINT payment_reversals_covered_amount_check CHECK (covered_amount IS NULL OR covered_amount > 0);
    ALTER TABLE payment_reversals ADD CONSTRAINT payment_reversals_discount_amount_check CHECK (discount_amount >= 0);
    ALTER TABLE payment_reversals ADD CONSTRAINT payment_reversals_exemption_amount_check CHECK (exemption_amount >= 0);
    CREATE UNIQUE INDEX IF NOT EXISTS payment_reversals_payment_id_uidx ON payment_reversals(payment_id);
    CREATE INDEX IF NOT EXISTS payment_reversals_created_at_idx ON payment_reversals(created_at DESC);

    CREATE TABLE IF NOT EXISTS payment_reversal_idempotency (
      idempotency_key TEXT PRIMARY KEY CHECK (length(idempotency_key) BETWEEN 8 AND 128),
      payment_id BIGINT NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
      request_fingerprint TEXT NOT NULL,
      reversal_id BIGINT REFERENCES payment_reversals(id) ON DELETE RESTRICT,
      response JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS payment_reversal_idempotency_payment_idx
      ON payment_reversal_idempotency(payment_id, created_at DESC);

    UPDATE payments
    SET student_name_snapshot = COALESCE(payments.student_name_snapshot, s.full_name),
        student_code_snapshot = COALESCE(payments.student_code_snapshot, s.student_code),
        student_serial_snapshot = COALESCE(payments.student_serial_snapshot, s.student_serial),
        scan_serial_snapshot = COALESCE(payments.scan_serial_snapshot, s.scan_serial),
        group_name_snapshot = COALESCE(payments.group_name_snapshot, COALESCE(g.display_name, g.name)),
        grade_level_snapshot = COALESCE(payments.grade_level_snapshot, COALESCE(g.grade_level, g.grade))
    FROM students s, groups g
    WHERE s.id = payments.student_id
      AND g.id = payments.group_id
      AND (
        payments.student_name_snapshot IS NULL OR payments.student_code_snapshot IS NULL
        OR payments.student_serial_snapshot IS NULL OR payments.scan_serial_snapshot IS NULL
        OR payments.group_name_snapshot IS NULL OR payments.grade_level_snapshot IS NULL
      );

    CREATE TABLE IF NOT EXISTS payment_change_requests (
      id BIGSERIAL PRIMARY KEY, 
      payment_id BIGINT REFERENCES payments(id) ON DELETE SET NULL,
      requested_by INTEGER REFERENCES teachers(id) ON DELETE SET NULL, 
      action TEXT NOT NULL,
      proposed_data JSONB NOT NULL DEFAULT '{}'::jsonb, 
      status TEXT NOT NULL DEFAULT 'pending',
      reviewed_by INTEGER REFERENCES teachers(id) ON DELETE SET NULL, 
      reviewed_at TIMESTAMPTZ, 
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS serial_change_requests (
      id BIGSERIAL PRIMARY KEY, 
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE RESTRICT,
      requested_by INTEGER REFERENCES teachers(id) ON DELETE SET NULL, 
      old_serial TEXT NOT NULL, 
      new_serial TEXT NOT NULL,
      old_qr_token TEXT, 
      new_qr_token TEXT, 
      status TEXT NOT NULL DEFAULT 'pending',
      reviewed_by INTEGER REFERENCES teachers(id) ON DELETE SET NULL, 
      reviewed_at TIMESTAMPTZ, 
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS student_notes (
      id BIGSERIAL PRIMARY KEY,
      student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
      student_name_snapshot TEXT,
      student_code_snapshot TEXT,
      author_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
      body TEXT NOT NULL,
      is_read BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS student_notes_student_idx ON student_notes(student_id, created_at DESC);
  `);

  await query(`
    SET search_path TO public;

    CREATE TABLE IF NOT EXISTS whatsapp_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      auto_send BOOLEAN NOT NULL DEFAULT FALSE,
      attendance_notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      templates JSONB NOT NULL DEFAULT '[]'::jsonb,
      grade_templates JSONB NOT NULL DEFAULT '[]'::jsonb,
      receipt_templates JSONB NOT NULL DEFAULT '[]'::jsonb,
      advance_payment_templates JSONB NOT NULL DEFAULT '[]'::jsonb,
      min_delay_seconds INTEGER NOT NULL DEFAULT 4 CHECK (min_delay_seconds BETWEEN 2 AND 60),
      max_delay_seconds INTEGER NOT NULL DEFAULT 8 CHECK (max_delay_seconds BETWEEN 2 AND 60),
      max_messages_per_hour INTEGER NOT NULL DEFAULT 50,
      batch_size INTEGER NOT NULL DEFAULT 25,
      batch_cooldown_seconds INTEGER NOT NULL DEFAULT 300,
      reconnect_cooldown_seconds INTEGER NOT NULL DEFAULT 300,
      updated_by INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (min_delay_seconds <= max_delay_seconds)
    );
    ALTER TABLE whatsapp_settings
      ADD COLUMN IF NOT EXISTS attendance_notifications_enabled BOOLEAN NOT NULL DEFAULT TRUE;
    CREATE TABLE IF NOT EXISTS whatsapp_auth_state (
      session_id TEXT NOT NULL,
      key_id TEXT NOT NULL,
      key_data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (session_id, key_id)
    );
    CREATE INDEX IF NOT EXISTS whatsapp_auth_state_updated_idx
      ON whatsapp_auth_state(session_id, updated_at);
    CREATE TABLE IF NOT EXISTS whatsapp_notification_jobs (
      id BIGSERIAL PRIMARY KEY,
      notification_type TEXT NOT NULL DEFAULT 'attendance' CHECK (notification_type IN ('attendance', 'absence', 'grade', 'receipt', 'advance_payment')),
      source_id BIGINT,
      attendance_record_id BIGINT UNIQUE REFERENCES attendance_records(id) ON DELETE CASCADE,
      student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
      created_by_teacher_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
      idempotency_key TEXT,
      phone_number TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      ref_code TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'skipped', 'delivery_unknown')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      last_error TEXT,
      template_index INTEGER,
      template_text TEXT,
      rendered_message TEXT,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sent_at TIMESTAMPTZ,
      lease_expires_at TIMESTAMPTZ,
      claim_token TEXT,
      send_started_at TIMESTAMPTZ,
      provider_message_id TEXT,
      provider_accepted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS whatsapp_notification_jobs_queue_idx
      ON whatsapp_notification_jobs(status, next_attempt_at, id);
    -- A result can have multiple delivery attempts over its lifetime, but
    -- there must never be two active outbox records for the same result.
    CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_grade_active_source_idx
      ON whatsapp_notification_jobs(source_id)
      WHERE notification_type = 'grade' AND source_id IS NOT NULL
        AND status IN ('pending', 'processing');
    CREATE TABLE IF NOT EXISTS whatsapp_template_rotation (
      notification_type TEXT PRIMARY KEY CHECK (notification_type IN ('attendance', 'absence', 'grade', 'receipt', 'advance_payment')),
      next_index INTEGER NOT NULL DEFAULT 0 CHECK (next_index >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS whatsapp_templates (
      id BIGSERIAL PRIMARY KEY,
      category TEXT NOT NULL CHECK (category IN ('attendance', 'absence', 'grade', 'receipt', 'advance_payment')),
      message_body TEXT NOT NULL CHECK (length(trim(message_body)) > 0),
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      audience TEXT NOT NULL DEFAULT 'neutral',
      slot_number INTEGER,
      slot_key TEXT,
      is_fallback BOOLEAN NOT NULL DEFAULT FALSE,
      content_version INTEGER NOT NULL DEFAULT 1 CHECK (content_version > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS whatsapp_templates_category_active_idx
      ON whatsapp_templates(category, is_active);
    CREATE TABLE IF NOT EXISTS student_portal_access_tokens (
      token_hash TEXT PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS student_portal_access_tokens_expiry_idx
      ON student_portal_access_tokens(expires_at, used_at);
    CREATE TABLE IF NOT EXISTS student_pin_tokens (
      id BIGSERIAL PRIMARY KEY,
      student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      purpose TEXT NOT NULL CHECK (purpose IN ('pin_setup', 'pin_recovery')),
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS student_pin_tokens_student_active_idx
      ON student_pin_tokens(student_id, purpose, expires_at, consumed_at);
    CREATE INDEX IF NOT EXISTS student_pin_tokens_expiry_idx
      ON student_pin_tokens(expires_at, consumed_at);
    CREATE TABLE IF NOT EXISTS whatsapp_session_leases (
      session_key TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      owner_token TEXT NOT NULL,
      lease_expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS whatsapp_send_slots (
      session_key TEXT PRIMARY KEY,
      next_available_at TIMESTAMPTZ,
      batch_count INTEGER NOT NULL DEFAULT 0,
      batch_cooldown_until TIMESTAMPTZ,
      reconnect_cooldown_until TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS whatsapp_send_rate_events (
      id BIGSERIAL PRIMARY KEY,
      session_key TEXT NOT NULL,
      reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS whatsapp_send_rate_events_window_idx
      ON whatsapp_send_rate_events(session_key, reserved_at);

    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE IF NOT EXISTS ai_provider_instances (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider_type TEXT NOT NULL CHECK (provider_type IN ('gemini', 'groq', 'mistral', 'openrouter', 'cloudflare')),
      display_name TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      routing_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      model_id TEXT,
      priority INTEGER NOT NULL DEFAULT 100 CHECK (priority BETWEEN 1 AND 100000),
      weight INTEGER NOT NULL DEFAULT 1 CHECK (weight > 0),
      timeout_ms INTEGER NOT NULL DEFAULT 12000 CHECK (timeout_ms BETWEEN 1000 AND 120000),
      hedge_delay_ms INTEGER NOT NULL DEFAULT 500 CHECK (hedge_delay_ms BETWEEN 0 AND 10000),
      max_concurrency INTEGER CHECK (max_concurrency IS NULL OR max_concurrency > 0),
      provider_config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      credential_encrypted TEXT,
      credential_iv TEXT,
      credential_auth_tag TEXT,
      health_state TEXT NOT NULL DEFAULT 'unknown' CHECK (health_state IN ('healthy', 'rate_limited', 'temporarily_failed', 'unknown')),
      cooldown_until TIMESTAMPTZ,
      last_success_at TIMESTAMPTZ,
      last_failure_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_by INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
      updated_by INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
      legacy_source_key TEXT UNIQUE
    );
    DO $health_state$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'ai_provider_instances'::regclass AND conname = 'ai_provider_instances_health_state_check') THEN
        ALTER TABLE ai_provider_instances DROP CONSTRAINT ai_provider_instances_health_state_check;
      END IF;
      ALTER TABLE ai_provider_instances ADD CONSTRAINT ai_provider_instances_health_state_check CHECK (health_state IN ('healthy', 'rate_limited', 'temporarily_failed', 'configuration_problem', 'unknown'));
    EXCEPTION WHEN duplicate_object THEN
      NULL;
    END $health_state$;
    CREATE INDEX IF NOT EXISTS ai_provider_instances_routing_idx
      ON ai_provider_instances (routing_enabled, enabled, priority, provider_type);
  `);

  // Additive, repeatable compatibility import. Legacy settings and secrets are
  // retained; the unique source key makes reruns idempotent.
  await query(`
    INSERT INTO ai_provider_instances (
      provider_type, display_name, enabled, routing_enabled, model_id, priority,
      timeout_ms, provider_config_json, credential_encrypted, credential_iv,
      credential_auth_tag, legacy_source_key, created_at, updated_at
    )
    SELECT 'gemini', 'Gemini 1',
      COALESCE((s.value_json->>'enabled')::boolean, TRUE),
      COALESCE((s.value_json->>'enabled')::boolean, TRUE),
      COALESCE(m.value_json #>> '{}', 'gemini-3.6-flash'),
      COALESCE((s.value_json->>'priority')::integer, 1),
      COALESCE((s.value_json->>'timeoutMs')::integer, 12000), '{}',
      sec.encrypted_value, sec.iv, sec.auth_tag, 'legacy:gemini', NOW(), NOW()
    FROM (SELECT 1) seed
    LEFT JOIN system_settings s ON s.key = 'ai_provider_gemini'
    LEFT JOIN system_settings m ON m.key = 'gemini_model'
    LEFT JOIN system_secrets sec ON sec.key = 'gemini_api_key'
    WHERE sec.key IS NOT NULL OR s.key IS NOT NULL
    ON CONFLICT (legacy_source_key) DO NOTHING;

    INSERT INTO ai_provider_instances (
      provider_type, display_name, enabled, routing_enabled, model_id, priority,
      timeout_ms, provider_config_json, credential_encrypted, credential_iv,
      credential_auth_tag, legacy_source_key, created_at, updated_at
    )
    SELECT v.provider_type, v.display_name,
      COALESCE((settings.value_json->>'enabled')::boolean, FALSE),
      COALESCE((settings.value_json->>'enabled')::boolean, FALSE),
      NULLIF(settings.value_json->>'model', ''),
      COALESCE((settings.value_json->>'priority')::integer, 100),
      COALESCE((settings.value_json->>'timeoutMs')::integer, 12000),
      CASE WHEN v.provider_type = 'cloudflare' THEN jsonb_build_object('accountId', settings.value_json->>'accountId') ELSE '{}'::jsonb END,
      sec.encrypted_value, sec.iv, sec.auth_tag, 'legacy:' || v.provider_type, NOW(), NOW()
    FROM (VALUES
      ('groq', 'Groq 1', 'ai_provider_groq', 'ai_provider_groq_key'),
      ('mistral', 'Mistral 1', 'ai_provider_mistral', 'ai_provider_mistral_key'),
      ('openrouter', 'OpenRouter 1', 'ai_provider_openrouter', 'ai_provider_openrouter_key'),
      ('cloudflare', 'Cloudflare 1', 'ai_provider_cloudflare', 'ai_provider_cloudflare_token')
    ) AS v(provider_type, display_name, setting_key, secret_key)
    LEFT JOIN system_settings settings ON settings.key = v.setting_key
    LEFT JOIN system_secrets sec ON sec.key = v.secret_key
    WHERE settings.key IS NOT NULL OR sec.key IS NOT NULL
    ON CONFLICT (legacy_source_key) DO NOTHING;
  `);
  // Keep every DDL/DML command separate when no transaction client is used.
  // node-postgres rejects a multi-command query whenever parameters are passed
  // ("cannot insert multiple commands into a prepared statement").
  await query("ALTER TABLE whatsapp_settings ADD COLUMN IF NOT EXISTS grade_templates JSONB NOT NULL DEFAULT '[]'::jsonb");
  await query("ALTER TABLE whatsapp_settings ADD COLUMN IF NOT EXISTS receipt_templates JSONB NOT NULL DEFAULT '[]'::jsonb");
  await query("ALTER TABLE whatsapp_settings ADD COLUMN IF NOT EXISTS advance_payment_templates JSONB NOT NULL DEFAULT '[]'::jsonb");
  await query("ALTER TABLE whatsapp_settings ADD COLUMN IF NOT EXISTS max_messages_per_hour INTEGER NOT NULL DEFAULT 50");
  await query("ALTER TABLE whatsapp_settings ADD COLUMN IF NOT EXISTS batch_size INTEGER NOT NULL DEFAULT 25");
  await query("ALTER TABLE whatsapp_settings ADD COLUMN IF NOT EXISTS batch_cooldown_seconds INTEGER NOT NULL DEFAULT 300");
  await query("ALTER TABLE whatsapp_settings ADD COLUMN IF NOT EXISTS reconnect_cooldown_seconds INTEGER NOT NULL DEFAULT 300");
  await query("ALTER TABLE whatsapp_send_slots ADD COLUMN IF NOT EXISTS batch_count INTEGER NOT NULL DEFAULT 0");
  await query("ALTER TABLE whatsapp_send_slots ADD COLUMN IF NOT EXISTS batch_cooldown_until TIMESTAMPTZ");
  await query("ALTER TABLE whatsapp_send_slots ADD COLUMN IF NOT EXISTS reconnect_cooldown_until TIMESTAMPTZ");
  await query("CREATE TABLE IF NOT EXISTS whatsapp_send_rate_events (id BIGSERIAL PRIMARY KEY, session_key TEXT NOT NULL, reserved_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  await query("CREATE INDEX IF NOT EXISTS whatsapp_send_rate_events_window_idx ON whatsapp_send_rate_events(session_key, reserved_at)");
  await query("ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ");
  await query("ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS cancelled_by INTEGER REFERENCES teachers(id) ON DELETE SET NULL");
  await query("ALTER TABLE whatsapp_notification_jobs ADD COLUMN IF NOT EXISTS cancellation_session_id INTEGER REFERENCES attendance_sessions(id) ON DELETE SET NULL");
  await query("ALTER TABLE whatsapp_notification_jobs ADD COLUMN IF NOT EXISTS approved_by INTEGER REFERENCES teachers(id) ON DELETE SET NULL");
  await query("ALTER TABLE whatsapp_notification_jobs ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ");
  await query("ALTER TABLE students ADD COLUMN IF NOT EXISTS whatsapp_opted_out BOOLEAN NOT NULL DEFAULT FALSE");
  await query("COMMENT ON COLUMN students.billing_start_month IS 'First effective fee due month, normalized to YYYY-MM-01.'");
  await query("CREATE INDEX IF NOT EXISTS students_billing_start_month_idx ON students (billing_start_month)");
  await query("ALTER TABLE whatsapp_settings DROP CONSTRAINT IF EXISTS whatsapp_settings_min_delay_seconds_check");
  await query("ALTER TABLE whatsapp_settings DROP CONSTRAINT IF EXISTS whatsapp_settings_max_delay_seconds_check");
  await query("ALTER TABLE whatsapp_settings DROP CONSTRAINT IF EXISTS whatsapp_settings_max_messages_per_hour_check");
  await query("ALTER TABLE whatsapp_settings DROP CONSTRAINT IF EXISTS whatsapp_settings_batch_size_check");
  await query("ALTER TABLE whatsapp_settings DROP CONSTRAINT IF EXISTS whatsapp_settings_batch_cooldown_seconds_check");
  await query("ALTER TABLE whatsapp_settings DROP CONSTRAINT IF EXISTS whatsapp_settings_reconnect_cooldown_seconds_check");
  await query("ALTER TABLE whatsapp_settings ADD CONSTRAINT whatsapp_settings_min_delay_seconds_check CHECK (min_delay_seconds BETWEEN 2 AND 60)");
  await query("ALTER TABLE whatsapp_settings ADD CONSTRAINT whatsapp_settings_max_delay_seconds_check CHECK (max_delay_seconds BETWEEN 2 AND 600)");
  await query("ALTER TABLE whatsapp_settings ADD CONSTRAINT whatsapp_settings_max_messages_per_hour_check CHECK (max_messages_per_hour BETWEEN 1 AND 10000)");
  await query("ALTER TABLE whatsapp_settings ADD CONSTRAINT whatsapp_settings_batch_size_check CHECK (batch_size BETWEEN 1 AND 1000)");
  await query("ALTER TABLE whatsapp_settings ADD CONSTRAINT whatsapp_settings_batch_cooldown_seconds_check CHECK (batch_cooldown_seconds BETWEEN 0 AND 86400)");
  await query("ALTER TABLE whatsapp_settings ADD CONSTRAINT whatsapp_settings_reconnect_cooldown_seconds_check CHECK (reconnect_cooldown_seconds BETWEEN 0 AND 86400)");
  await query("ALTER TABLE whatsapp_notification_jobs ADD COLUMN IF NOT EXISTS notification_type TEXT NOT NULL DEFAULT 'attendance'");
  await query("ALTER TABLE whatsapp_notification_jobs ADD COLUMN IF NOT EXISTS source_id BIGINT");
  await query("ALTER TABLE whatsapp_notification_jobs ADD COLUMN IF NOT EXISTS template_index INTEGER");
  await query("ALTER TABLE whatsapp_notification_jobs ADD COLUMN IF NOT EXISTS template_text TEXT");
  await query("ALTER TABLE whatsapp_notification_jobs ADD COLUMN IF NOT EXISTS rendered_message TEXT");
  await query("ALTER TABLE whatsapp_notification_jobs ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ");
  await query("ALTER TABLE whatsapp_notification_jobs ADD COLUMN IF NOT EXISTS claim_token TEXT");
  await query("ALTER TABLE whatsapp_notification_jobs ADD COLUMN IF NOT EXISTS send_started_at TIMESTAMPTZ");
  await query("ALTER TABLE whatsapp_notification_jobs ADD COLUMN IF NOT EXISTS provider_message_id TEXT");
  await query("ALTER TABLE whatsapp_notification_jobs ADD COLUMN IF NOT EXISTS provider_accepted_at TIMESTAMPTZ");
  await query("ALTER TABLE whatsapp_notification_jobs ADD COLUMN IF NOT EXISTS provider_call_started_at TIMESTAMPTZ");
  await query("ALTER TABLE whatsapp_notification_jobs ADD COLUMN IF NOT EXISTS provider_call_finished_at TIMESTAMPTZ");
  await query("ALTER TABLE whatsapp_notification_jobs ALTER COLUMN attendance_record_id DROP NOT NULL");
  await query("ALTER TABLE whatsapp_notification_jobs ALTER COLUMN phone_number DROP NOT NULL");
  await query("ALTER TABLE whatsapp_notification_jobs DROP CONSTRAINT IF EXISTS whatsapp_notification_jobs_notification_type_check");
  await query("ALTER TABLE whatsapp_notification_jobs DROP CONSTRAINT IF EXISTS whatsapp_notification_jobs_status_check");
  await query("ALTER TABLE whatsapp_notification_jobs ADD CONSTRAINT whatsapp_notification_jobs_status_check CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'skipped', 'delivery_unknown', 'review_required'))");
  await query("ALTER TABLE whatsapp_notification_jobs ADD COLUMN IF NOT EXISTS created_by_teacher_id INTEGER REFERENCES teachers(id) ON DELETE SET NULL");
  await query("ALTER TABLE whatsapp_notification_jobs ADD COLUMN IF NOT EXISTS idempotency_key TEXT");
  await query("ALTER TABLE whatsapp_notification_jobs ADD COLUMN IF NOT EXISTS external_message_id BIGINT REFERENCES external_messages(id) ON DELETE SET NULL");
  await query("CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_notification_jobs_idempotency_key_idx ON whatsapp_notification_jobs(idempotency_key) WHERE idempotency_key IS NOT NULL");
  await query("ALTER TABLE whatsapp_notification_jobs ADD CONSTRAINT whatsapp_notification_jobs_notification_type_check CHECK (notification_type IN ('attendance', 'absence', 'grade', 'receipt', 'advance_payment', 'cancellation', 'custom_message', 'external_message'))");
  await query("ALTER TABLE whatsapp_template_rotation DROP CONSTRAINT IF EXISTS whatsapp_template_rotation_notification_type_check");
  await query("ALTER TABLE whatsapp_template_rotation ADD CONSTRAINT whatsapp_template_rotation_notification_type_check CHECK (notification_type IN ('attendance', 'absence', 'grade', 'receipt', 'advance_payment', 'cancellation'))");
  await query("ALTER TABLE whatsapp_templates DROP CONSTRAINT IF EXISTS whatsapp_templates_category_check");
  await query("ALTER TABLE whatsapp_templates ADD CONSTRAINT whatsapp_templates_category_check CHECK (category IN ('attendance', 'absence', 'grade', 'receipt', 'advance_payment', 'cancellation'))");
  await query("ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS audience TEXT NOT NULL DEFAULT 'neutral'");
  await query("ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS slot_number INTEGER");
  await query("ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS slot_key TEXT");
  await query("ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS is_fallback BOOLEAN NOT NULL DEFAULT FALSE");
  await query("ALTER TABLE whatsapp_templates ADD COLUMN IF NOT EXISTS content_version INTEGER NOT NULL DEFAULT 1");
  await query("ALTER TABLE whatsapp_notification_jobs ADD COLUMN IF NOT EXISTS template_id BIGINT");
  await query("ALTER TABLE whatsapp_notification_jobs ADD COLUMN IF NOT EXISTS template_version INTEGER");
  await query("ALTER TABLE whatsapp_notification_jobs ADD COLUMN IF NOT EXISTS template_category TEXT");
  await query("ALTER TABLE whatsapp_notification_jobs ADD COLUMN IF NOT EXISTS template_audience TEXT");
  await query("ALTER TABLE whatsapp_notification_jobs ADD COLUMN IF NOT EXISTS template_slot_number INTEGER");
  await query("ALTER TABLE whatsapp_notification_jobs ADD COLUMN IF NOT EXISTS template_body_snapshot TEXT");
  await query("ALTER TABLE whatsapp_notification_jobs ADD COLUMN IF NOT EXISTS template_gender TEXT");
  await query("ALTER TABLE whatsapp_templates DROP CONSTRAINT IF EXISTS whatsapp_templates_audience_check");
  await query("ALTER TABLE whatsapp_templates ADD CONSTRAINT whatsapp_templates_audience_check CHECK (audience IN ('male', 'female', 'neutral'))");
  await query("ALTER TABLE whatsapp_templates DROP CONSTRAINT IF EXISTS whatsapp_templates_slot_check");
  await query("ALTER TABLE whatsapp_templates ADD CONSTRAINT whatsapp_templates_slot_check CHECK ((audience IN ('male', 'female') AND slot_number BETWEEN 1 AND 4 AND is_fallback = FALSE) OR (audience = 'neutral' AND slot_number IS NULL))");
  await query("ALTER TABLE whatsapp_templates DROP CONSTRAINT IF EXISTS whatsapp_templates_fallback_check");
  await query("ALTER TABLE whatsapp_templates ADD CONSTRAINT whatsapp_templates_fallback_check CHECK (is_fallback = FALSE OR (audience = 'neutral' AND slot_number IS NULL))");
  await query("ALTER TABLE whatsapp_templates DROP CONSTRAINT IF EXISTS whatsapp_templates_category_message_body_key");
  await query("DROP INDEX IF EXISTS whatsapp_templates_category_message_body_key");
  await query("CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_templates_slot_key_idx ON whatsapp_templates(slot_key) WHERE slot_key IS NOT NULL");
  await query("CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_templates_regular_slot_idx ON whatsapp_templates(category, audience, slot_number) WHERE audience IN ('male', 'female') AND slot_number IS NOT NULL");
  await query("CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_templates_fallback_idx ON whatsapp_templates(category) WHERE is_fallback = TRUE");
  await query("CREATE TABLE IF NOT EXISTS whatsapp_template_rotation_state (category TEXT NOT NULL CHECK (category IN ('attendance', 'absence', 'grade', 'receipt', 'advance_payment', 'cancellation')), audience TEXT NOT NULL CHECK (audience IN ('male', 'female')), next_slot INTEGER NOT NULL DEFAULT 1 CHECK (next_slot BETWEEN 1 AND 4), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (category, audience))");
  await query("ALTER TABLE whatsapp_template_rotation_state DROP CONSTRAINT IF EXISTS whatsapp_template_rotation_state_category_check");
  await query("ALTER TABLE whatsapp_template_rotation_state ADD CONSTRAINT whatsapp_template_rotation_state_category_check CHECK (category IN ('attendance', 'absence', 'grade', 'receipt', 'advance_payment', 'cancellation'))");
  // Preserve the old category-wide cursor for the male pool on first
  // migration. Female pools have no prior independent cursor and start at
  // slot one. ON CONFLICT keeps later restarts from resetting either cursor.
  await query(`
    INSERT INTO whatsapp_template_rotation_state (category, audience, next_slot)
    SELECT notification_type, 'male', MOD(next_index, 4) + 1
    FROM whatsapp_template_rotation
    ON CONFLICT (category, audience) DO NOTHING
  `);
  await query("CREATE INDEX IF NOT EXISTS whatsapp_templates_assignment_idx ON whatsapp_templates(category, audience, is_fallback, is_active, slot_number)");
  await query("UPDATE whatsapp_notification_jobs SET source_id = attendance_record_id WHERE source_id IS NULL");
  await query("DROP INDEX IF EXISTS whatsapp_notification_jobs_source_type_idx");
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_notification_jobs_source_type_idx
    ON whatsapp_notification_jobs(notification_type, source_id)
    WHERE source_id IS NOT NULL AND status IN ('pending', 'processing')`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_grade_active_source_idx
    ON whatsapp_notification_jobs(source_id)
    WHERE notification_type = 'grade' AND source_id IS NOT NULL
      AND status IN ('pending', 'processing')`);
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_cancellation_session_student_unique
    ON whatsapp_notification_jobs(cancellation_session_id, student_id)
    WHERE notification_type = 'cancellation' AND cancellation_session_id IS NOT NULL AND student_id IS NOT NULL`);
  await query("CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_notification_jobs_claim_token_idx ON whatsapp_notification_jobs(claim_token) WHERE claim_token IS NOT NULL");
  await query("ALTER TABLE whatsapp_session_leases ADD COLUMN IF NOT EXISTS owner_id TEXT NOT NULL DEFAULT 'migration-recovery'");
  await query("ALTER TABLE whatsapp_session_leases ADD COLUMN IF NOT EXISTS owner_token TEXT NOT NULL DEFAULT 'migration-recovery'");
  await query("ALTER TABLE whatsapp_session_leases ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
  await query("ALTER TABLE whatsapp_session_leases ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
  await query("ALTER TABLE whatsapp_session_leases ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
  await query("ALTER TABLE whatsapp_send_slots ADD COLUMN IF NOT EXISTS next_available_at TIMESTAMPTZ");
  await query("ALTER TABLE whatsapp_send_slots ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()");
  await query("UPDATE whatsapp_session_leases SET owner_id = COALESCE(NULLIF(owner_id, ''), 'migration-recovery'), owner_token = COALESCE(NULLIF(owner_token, ''), 'migration-recovery'), lease_expires_at = COALESCE(lease_expires_at, NOW())");
  await query("CREATE INDEX IF NOT EXISTS attendance_sessions_absence_dispatch_idx ON attendance_sessions(status, absence_dispatched, closes_at, id)");
  await query(
    `INSERT INTO whatsapp_settings (id, templates, grade_templates, receipt_templates, advance_payment_templates)
     VALUES (1, $1::jsonb, $2::jsonb, $3::jsonb, $4::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify([
    "*إشعار حضور الطالب* 👨‍🏫\n\n*الطالب:* {student_name}\n*المجموعة:* {group_name}\n*التاريخ:* {date}\n*الوقت:* {time}\n*كود الطالب:* {student_code}\n\nرابط المتابعة: {portal_link}\n*المرجع:* {ref_code}\n\n— منصة مستر أحمد عبدربه",
    "*تم تسجيل الحضور بنجاح* ✅\n\nحضر الطالب *{student_name}* حصة *{group_name}*.\n*التاريخ:* {date}\n*الوقت:* {time}\n\nرابط ملف المتابعة: {portal_link}\n*المرجع:* {ref_code}",
    "*إشعار حضور*\n\nتم تسجيل حضور الطالب *{student_name}* في مجموعة *{group_name}*.\n*التاريخ:* {date} | *الوقت:* {time}\n*كود الطالب:* {student_code}\n\nتقرير المتابعة: {portal_link}\n*رقم المرجع:* {ref_code}"
    ]), JSON.stringify([
      "*نتيجة التقييم* 📝\n\n*الطالب:* {student_name}\n*الامتحان:* {exam_title}\n*الدرجة:* {score} من {max_score}\n*النسبة:* {percentage}%\n*كود الطالب:* {student_code}\n\nتقرير التقييم: {portal_link}\n*المرجع:* {ref_code}\n\n— منصة مستر أحمد عبدربه",
      "*إشعار نتيجة الامتحان*\n\nحصل الطالب *{student_name}* في *{exam_title}* على *{score}/{max_score}* بنسبة *{percentage}%*.\n\nتفاصيل التقييم: {portal_link}\n*المرجع:* {ref_code}",
      "*تقييم دراسي*\n\nتم تصحيح *{exam_title}* للطالب *{student_name}*.\n*النتيجة المحققة:* {score} من {max_score}\n\nرابط التقرير الكامل: {portal_link}\n*رقم المرجع:* {ref_code}"
    ]), JSON.stringify([
      "*إيصال سداد المصروفات* 🧾\n\n*الطالب:* {student_name}\n*المبلغ المدفوع:* {amount_paid} ج.م\n*عن شهر:* {month}\n*رقم الإيصال:* {receipt_number}\n*كود الطالب:* {student_code}\n\nعرض الإيصال ومتابعة الحساب: {portal_link}\n*المرجع:* {ref_code}\n\nشكراً لتعاونكم.",
      "*سند قبض إلكتروني*\n\nتم تسجيل دفعة مالية بنجاح.\n*الطالب:* {student_name}\n*القيمة:* {amount_paid} ج.م\n*الشهر:* {month}\n*رقم السند:* {receipt_number}\n\nالسجل المالي: {portal_link}\n*المرجع:* {ref_code}",
      "*إشعار تحصيل نقدية*\n\nتم استلام مبلغ *{amount_paid} جنيه* لمصروفات *{month}* الخاصة بالطالب *{student_name}*.\n*رقم الإيصال:* {receipt_number}\n\nمتابعة الحساب: {portal_link}\n*المرجع:* {ref_code}"
    ]), JSON.stringify([
      "*إيصال الدفع المقدم* 💳\n\n*الطالب:* {student_name}\n*المبلغ المدفوع:* {amount_paid} ج.م\n*الشهور المسددة:* {months}\n*رقم الإيصال:* {receipt_number}\n\nمتابعة الحساب: {portal_link}\n*المرجع:* {ref_code}\n\n— منصة مستر أحمد عبدربه",
      "*تم تسجيل الدفع المقدم بنجاح* ✅\n\n*الطالب:* {student_name}\n*القيمة:* {amount_paid} ج.م\n*الفترة المسددة:* {months}\n*رقم السند:* {receipt_number}\n\nرابط المتابعة: {portal_link}\n*المرجع:* {ref_code}",
      "*إيصال استلام نقدية — دفع مقدم*\n\n*الطالب:* {student_name}\n*المبلغ:* {amount_paid} جنيه\n*الشهور:* {months}\n*الإيصال:* #{receipt_number}\n\nالرابط: {portal_link}\n*المرجع:* {ref_code}"
    ])]
  );

  // Replace structurally invalid legacy arrays while preserving user customizations.
  await query(
    `UPDATE whatsapp_settings
     SET templates = CASE
         WHEN jsonb_typeof(templates) <> 'array'
           OR CASE WHEN jsonb_typeof(templates) = 'array' THEN jsonb_array_length(templates) ELSE 0 END < 3
           OR NOT (templates::text ~ '\\{student_name\\}')
         THEN $1::jsonb ELSE templates END,
       grade_templates = CASE
           WHEN jsonb_typeof(grade_templates) <> 'array'
             OR CASE WHEN jsonb_typeof(grade_templates) = 'array' THEN jsonb_array_length(grade_templates) ELSE 0 END < 3
             OR NOT (grade_templates::text ~ '\\{exam_title\\}')
           THEN $2::jsonb ELSE grade_templates END,
       receipt_templates = CASE
           WHEN jsonb_typeof(receipt_templates) <> 'array'
             OR CASE WHEN jsonb_typeof(receipt_templates) = 'array' THEN jsonb_array_length(receipt_templates) ELSE 0 END < 3
             OR NOT (receipt_templates::text ~ '\\{amount_paid\\}')
           THEN $3::jsonb ELSE receipt_templates END,
       advance_payment_templates = CASE
           WHEN jsonb_typeof(advance_payment_templates) <> 'array'
             OR CASE WHEN jsonb_typeof(advance_payment_templates) = 'array' THEN jsonb_array_length(advance_payment_templates) ELSE 0 END < 3
             OR NOT (advance_payment_templates::text ~ '\\{amount_paid\\}')
             OR NOT (advance_payment_templates::text ~ '\\{months\\}')
           THEN $4::jsonb ELSE advance_payment_templates END,
       updated_at = NOW()
     WHERE id = 1`,
    [JSON.stringify([
      "*إشعار حضور الطالب* 👨‍🏫\n\n*الطالب:* {student_name}\n*المجموعة:* {group_name}\n*التاريخ:* {date}\n*الوقت:* {time}\n*كود الطالب:* {student_code}\n\nرابط المتابعة: {portal_link}\n*المرجع:* {ref_code}\n\n— منصة مستر أحمد عبدربه",
      "*تم تسجيل الحضور بنجاح* ✅\n\nحضر الطالب *{student_name}* حصة *{group_name}*.\n*التاريخ:* {date}\n*الوقت:* {time}\n\nرابط ملف المتابعة: {portal_link}\n*المرجع:* {ref_code}",
      "*إشعار حضور*\n\nتم تسجيل حضور الطالب *{student_name}* في مجموعة *{group_name}*.\n*التاريخ:* {date} | *الوقت:* {time}\n*كود الطالب:* {student_code}\n\nتقرير المتابعة: {portal_link}\n*رقم المرجع:* {ref_code}"
    ]), JSON.stringify([
      "*نتيجة التقييم* 📝\n\n*الطالب:* {student_name}\n*الامتحان:* {exam_title}\n*الدرجة:* {score} من {max_score}\n*النسبة:* {percentage}%\n*كود الطالب:* {student_code}\n\nتقرير التقييم: {portal_link}\n*المرجع:* {ref_code}\n\n— منصة مستر أحمد عبدربه",
      "*إشعار نتيجة الامتحان*\n\nحصل الطالب *{student_name}* في *{exam_title}* على *{score}/{max_score}* بنسبة *{percentage}%*.\n\nتفاصيل التقييم: {portal_link}\n*المرجع:* {ref_code}",
      "*تقييم دراسي*\n\nتم تصحيح *{exam_title}* للطالب *{student_name}*.\n*النتيجة المحققة:* {score} من {max_score}\n\nرابط التقرير الكامل: {portal_link}\n*رقم المرجع:* {ref_code}"
    ]), JSON.stringify([
      "*إيصال سداد المصروفات* 🧾\n\n*الطالب:* {student_name}\n*المبلغ المدفوع:* {amount_paid} ج.م\n*عن شهر:* {month}\n*رقم الإيصال:* {receipt_number}\n*كود الطالب:* {student_code}\n\nعرض الإيصال ومتابعة الحساب: {portal_link}\n*المرجع:* {ref_code}\n\nشكراً لتعاونكم.",
      "*سند قبض إلكتروني*\n\nتم تسجيل دفعة مالية بنجاح.\n*الطالب:* {student_name}\n*القيمة:* {amount_paid} ج.م\n*الشهر:* {month}\n*رقم السند:* {receipt_number}\n\nالسجل المالي: {portal_link}\n*المرجع:* {ref_code}",
      "*إشعار تحصيل نقدية*\n\nتم استلام مبلغ *{amount_paid} جنيه* لمصروفات *{month}* الخاصة بالطالب *{student_name}*.\n*رقم الإيصال:* {receipt_number}\n\nمتابعة الحساب: {portal_link}\n*المرجع:* {ref_code}"
    ]), JSON.stringify([
      "*إيصال الدفع المقدم* 💳\n\n*الطالب:* {student_name}\n*المبلغ المدفوع:* {amount_paid} ج.م\n*الشهور المسددة:* {months}\n*رقم الإيصال:* {receipt_number}\n\nمتابعة الحساب: {portal_link}\n*المرجع:* {ref_code}\n\n— منصة مستر أحمد عبدربه",
      "*تم تسجيل الدفع المقدم بنجاح* ✅\n\n*الطالب:* {student_name}\n*القيمة:* {amount_paid} ج.م\n*الفترة المسددة:* {months}\n*رقم السند:* {receipt_number}\n\nرابط المتابعة: {portal_link}\n*المرجع:* {ref_code}",
      "*إيصال استلام نقدية — دفع مقدم*\n\n*الطالب:* {student_name}\n*المبلغ:* {amount_paid} جنيه\n*الشهور:* {months}\n*الإيصال:* #{receipt_number}\n\nالرابط: {portal_link}\n*المرجع:* {ref_code}"
    ])]
  );

  // Migrate the legacy JSON template arrays into indexed rows once. The
  // explicit anti-join and DISTINCT make this safe after the old
  // (category, message_body) uniqueness is removed, while preserving edits
  // already made through the legacy settings screen.
  await query(`
    INSERT INTO whatsapp_templates (category, message_body, is_active)
    SELECT DISTINCT source.category, item.value, TRUE
    FROM whatsapp_settings ws
    CROSS JOIN LATERAL (
      VALUES
        ('attendance', ws.templates),
        ('grade', ws.grade_templates),
        ('receipt', ws.receipt_templates),
        ('advance_payment', ws.advance_payment_templates)
    ) AS source(category, template_values)
    CROSS JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(source.template_values) = 'array' THEN source.template_values ELSE '[]'::jsonb END
    ) AS item(value)
    WHERE ws.id = 1
      AND length(trim(item.value)) > 0
      AND NOT EXISTS (
        SELECT 1
        FROM whatsapp_templates existing
        WHERE existing.category = source.category
          AND existing.message_body = item.value
      )
  `);

  // Seed absence templates without re-enabling templates that an operator
  // deliberately disabled. The anti-join makes this safe on every restart.
  await query(`
    INSERT INTO whatsapp_templates (category, message_body, is_active)
    SELECT DISTINCT 'absence', item.value, TRUE
    FROM jsonb_array_elements_text($1::jsonb) AS item(value)
    WHERE NOT EXISTS (
      SELECT 1
      FROM whatsapp_templates existing
      WHERE existing.category = 'absence'
        AND existing.message_body = item.value
    )
  `, [JSON.stringify([
    "*تنبيه غياب الطالب* ⚠️\n\n*الطالب:* {student_name}\n*المجموعة:* {group_name}\n*التاريخ:* {date}\n\nلم يتم تسجيل حضور الطالب لهذه الحصة.\nرابط المتابعة: {portal_link}\n*المرجع:* {ref_code}\n\n— منصة مستر أحمد عبدربه",
    "*إشعار غياب*\n\nنحيط حضرتكم علماً بعدم تسجيل حضور الطالب *{student_name}* في حصة *{group_name}* بتاريخ *{date}*.\n\nرابط ملف المتابعة: {portal_link}\n*المرجع:* {ref_code}",
    "*متابعة الحضور*\n\nتم إغلاق جلسة *{group_name}* بتاريخ *{date}* دون تسجيل حضور الطالب *{student_name}*.\n\nرابط المتابعة: {portal_link}\n*رقم المرجع:* {ref_code}"
  ])]);

  // Gender-aware template migration is additive and deterministic. Legacy
  // rows are never deleted. Only rows with explicit gendered Arabic wording
  // are assigned to regular pools; ambiguous rows remain unassigned and
  // recoverable outside the new slot catalogue.
  const { WHATSAPP_TEMPLATE_CATALOG } = await import("../services/whatsappTemplateCatalog.js");
  for (const category of Object.keys(WHATSAPP_TEMPLATE_CATALOG)) {
    await query(`
      WITH candidates AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS slot_number
        FROM whatsapp_templates
        WHERE category = $1 AND slot_key IS NULL AND is_fallback = FALSE
          AND audience = 'neutral'
          AND message_body ~ 'الطالب(?![ء-ي])'
          AND message_body !~ 'الطالبة(?![ء-ي])'
        LIMIT 4
      )
      UPDATE whatsapp_templates t
      SET audience = 'male', slot_number = candidates.slot_number,
          slot_key = $1 || ':male:' || candidates.slot_number::text,
          updated_at = NOW()
      FROM candidates
      WHERE t.id = candidates.id
        AND NOT EXISTS (SELECT 1 FROM whatsapp_templates occupied WHERE occupied.slot_key = $1 || ':male:' || candidates.slot_number::text)
    `, [category]);

    await query(`
      WITH candidates AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS slot_number
        FROM whatsapp_templates
        WHERE category = $1 AND slot_key IS NULL AND is_fallback = FALSE
          AND audience = 'neutral'
          AND message_body ~ '(الطالبة|حضرت الطالبة|لم يتم تسجيل حضور الطالبة|الخاصة بالطالبة)'
        LIMIT 4
      )
      UPDATE whatsapp_templates t
      SET audience = 'female', slot_number = candidates.slot_number,
          slot_key = $1 || ':female:' || candidates.slot_number::text,
          updated_at = NOW()
      FROM candidates
      WHERE t.id = candidates.id
        AND NOT EXISTS (SELECT 1 FROM whatsapp_templates occupied WHERE occupied.slot_key = $1 || ':female:' || candidates.slot_number::text)
    `, [category]);

    for (const audience of ["male", "female"]) {
      const bodies = WHATSAPP_TEMPLATE_CATALOG[category][audience];
      for (let slot = 1; slot <= 4; slot += 1) {
        await query(`
          INSERT INTO whatsapp_templates (category, audience, slot_number, slot_key, is_fallback, message_body, is_active, content_version)
          VALUES ($1, $2, $3, $4, FALSE, $5, TRUE, 1)
          ON CONFLICT DO NOTHING
        `, [category, audience, slot, `${category}:${audience}:${slot}`, bodies[slot - 1]]);
      }
    }
    await query(`
      INSERT INTO whatsapp_templates (category, audience, slot_number, slot_key, is_fallback, message_body, is_active, content_version)
      VALUES ($1, 'neutral', NULL, $2, TRUE, $3, TRUE, 1)
      ON CONFLICT DO NOTHING
    `, [category, `${category}:neutral:fallback`, WHATSAPP_TEMPLATE_CATALOG[category].neutral]);
    await query(`
      INSERT INTO whatsapp_template_rotation_state (category, audience, next_slot)
      VALUES ($1, 'male', 1), ($1, 'female', 1)
      ON CONFLICT (category, audience) DO NOTHING
    `, [category]);
  }

  await query(`
    SET search_path TO public;

    CREATE TABLE IF NOT EXISTS fee_dues (
      id BIGSERIAL PRIMARY KEY,
      student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
      due_month DATE NOT NULL,
      amount NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
      paid_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0 AND paid_amount <= amount),
      student_name_snapshot TEXT,
      student_code_snapshot TEXT,
      student_serial_snapshot TEXT,
      group_name_snapshot TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (student_id, due_month)
    );
    CREATE INDEX IF NOT EXISTS fee_dues_student_month_idx ON fee_dues(student_id, due_month);
    CREATE INDEX IF NOT EXISTS fee_dues_month_student_idx ON fee_dues(due_month, student_id);
    CREATE INDEX IF NOT EXISTS payments_paid_at_active_idx ON payments(paid_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS payments_student_paid_at_idx ON payments(student_id, paid_at DESC);
    CREATE INDEX IF NOT EXISTS payments_student_billing_cycle_idx ON payments(student_id, paid_at, payment_date, is_exempt, discount_amount);
    UPDATE payments SET payment_reference = 'P-' || LPAD(id::text, 8, '0') WHERE payment_reference IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS payments_idempotency_key_idx ON payments(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS payments_reference_idx ON payments(payment_reference) WHERE payment_reference IS NOT NULL;
    CREATE INDEX IF NOT EXISTS attendance_records_student_idx ON attendance_records(student_id, checkin_time DESC);
    CREATE INDEX IF NOT EXISTS attendance_records_session_idx ON attendance_records(session_id, student_id);
    CREATE INDEX IF NOT EXISTS attendance_records_student_session_created_idx ON attendance_records(student_id, session_id, created_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS attendance_records_idempotency_key_idx ON attendance_records(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS attendance_sessions_group_date_idx ON attendance_sessions(group_id, session_date DESC);
    CREATE INDEX IF NOT EXISTS attendance_sessions_group_date_status_idx ON attendance_sessions(group_id, session_date, status, closes_at);
    CREATE INDEX IF NOT EXISTS students_qr_token_lower_active_idx ON students (LOWER(COALESCE(qr_token, ''))) WHERE deleted_at IS NULL AND is_active = TRUE;
    CREATE INDEX IF NOT EXISTS students_scan_serial_lower_active_idx ON students (LOWER(COALESCE(scan_serial, ''))) WHERE deleted_at IS NULL AND is_active = TRUE;
    CREATE INDEX IF NOT EXISTS students_student_serial_lower_active_idx ON students (LOWER(COALESCE(student_serial, ''))) WHERE deleted_at IS NULL AND is_active = TRUE;
    CREATE INDEX IF NOT EXISTS students_student_code_lower_active_idx ON students (LOWER(COALESCE(student_code, ''))) WHERE deleted_at IS NULL AND is_active = TRUE;
    CREATE INDEX IF NOT EXISTS exam_results_exam_student_idx ON exam_results(exam_id, student_id);
  `);

  // Retained history must outlive the live student row. Keep foreign keys
  // enabled, but make only the student reference nullable and snapshot the
  // identity needed by historical views.
  await query(`
    SET search_path TO public;
    ALTER TABLE attendance_records ALTER COLUMN student_id DROP NOT NULL;
    ALTER TABLE exam_results ALTER COLUMN student_id DROP NOT NULL;
    ALTER TABLE homework_submissions ALTER COLUMN student_id DROP NOT NULL;
    ALTER TABLE payments ALTER COLUMN student_id DROP NOT NULL;
    ALTER TABLE student_notes ALTER COLUMN student_id DROP NOT NULL;
    ALTER TABLE fee_dues ALTER COLUMN student_id DROP NOT NULL;
    ALTER TABLE student_notes ADD COLUMN IF NOT EXISTS student_name_snapshot TEXT;
    ALTER TABLE student_notes ADD COLUMN IF NOT EXISTS student_code_snapshot TEXT;
    ALTER TABLE fee_dues ADD COLUMN IF NOT EXISTS student_name_snapshot TEXT;
    ALTER TABLE fee_dues ADD COLUMN IF NOT EXISTS student_code_snapshot TEXT;
    ALTER TABLE fee_dues ADD COLUMN IF NOT EXISTS student_serial_snapshot TEXT;
    ALTER TABLE fee_dues ADD COLUMN IF NOT EXISTS group_name_snapshot TEXT;

    DO $$
    DECLARE fk RECORD;
    BEGIN
      FOR fk IN
        SELECT c.conname, c.conrelid::regclass::text AS table_name
        FROM pg_constraint c
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
        WHERE c.contype = 'f'
          AND c.confrelid = 'public.students'::regclass
          AND c.conrelid IN ('public.attendance_records'::regclass, 'public.exam_results'::regclass,
                             'public.homework_submissions'::regclass, 'public.payments'::regclass,
                             'public.student_notes'::regclass, 'public.fee_dues'::regclass)
          AND a.attname = 'student_id'
      LOOP
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.table_name, fk.conname);
      END LOOP;
    END $$;

    ALTER TABLE attendance_records ADD CONSTRAINT attendance_records_student_id_fkey FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE SET NULL;
    ALTER TABLE exam_results ADD CONSTRAINT exam_results_student_id_fkey FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE SET NULL;
    ALTER TABLE homework_submissions ADD CONSTRAINT homework_submissions_student_id_fkey FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE SET NULL;
    ALTER TABLE payments ADD CONSTRAINT payments_student_id_fkey FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE SET NULL;
    ALTER TABLE student_notes ADD CONSTRAINT student_notes_student_id_fkey FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE SET NULL;
    ALTER TABLE fee_dues ADD CONSTRAINT fee_dues_student_id_fkey FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE SET NULL;
  `);

  // 5. Seed default data.
  const center = await query(
    `
      INSERT INTO centers (name, address, latitude, longitude, allowed_radius_meters)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT DO NOTHING
      RETURNING id
    `,
    ["سنتر مستر أحمد عبدربه", "عنوان السنتر - يتم تحديثه لاحقا", 30.0444, 31.2357, 10000000]
  );

  const centerId =
    center.rows[0]?.id || (await query("SELECT id FROM centers ORDER BY id LIMIT 1")).rows[0].id;

  const group = await query(
    `
      INSERT INTO groups (center_id, name, grade, subject)
      SELECT $1, $2, $3, $4
      WHERE NOT EXISTS (SELECT 1 FROM groups WHERE name = $2)
      RETURNING id
    `,
    [centerId, "مجموعة السبت 6 مساء", "الصف الأول الثانوي", "العلوم"]
  );

  const groupId =
    group.rows[0]?.id ||
    (await query("SELECT id FROM groups WHERE name = $1 LIMIT 1", ["مجموعة السبت 6 مساء"])).rows[0]
      .id;

  // Schedules and exams are local development fixtures. Student records are
  // intentionally never seeded here, so deleting a student remains durable.
  if (process.env.NODE_ENV !== "production") {
    await query(
      `
        INSERT INTO class_schedules (group_id, day_of_week, start_time, end_time, opens_before_minutes, closes_after_minutes)
        VALUES ($1, EXTRACT(DOW FROM NOW())::INTEGER, $2::time, $3::time, 3, 20)
        ON CONFLICT DO NOTHING
        RETURNING id
      `,
      [groupId, "18:00:00", "19:30:00"]
    );

    await query(
      `
        INSERT INTO exams (group_id, title, max_score, exam_date)
        SELECT $1, $2, 50, CURRENT_DATE - INTERVAL '7 days'
        WHERE NOT EXISTS (SELECT 1 FROM exams WHERE group_id = $1 AND title = $2)
        RETURNING id
      `,
      [groupId, "امتحان الوحدة الأولى"]
    );
  }

  const adminName = process.env.ADMIN_NAME || "Ahmed Abdrabo";
  const adminUsername = process.env.ADMIN_USERNAME || "admin";
  const adminEmail = process.env.ADMIN_EMAIL || "teacher@abdrabo.local";
  const adminPassword = process.env.ADMIN_PASSWORD || "change_me_123";
  const adminPasswordHash = hashPassword(adminPassword);
  let existingAdmin = await query(
    `
      SELECT id
      FROM teachers
      WHERE LOWER(email) = LOWER($1)
        OR LOWER(username) = LOWER($2)
      LIMIT 1
    `,
    [adminEmail, adminUsername]
  );
  if (!existingAdmin.rowCount) {
    existingAdmin = await query("SELECT id FROM teachers WHERE role = 'admin' ORDER BY id LIMIT 1");
  }

  if (existingAdmin.rowCount) {
    await query(
      `
        UPDATE teachers
        SET
          name = $1,
          email = $2,
          username = $3,
          password_hash = $4,
          role = 'admin',
          is_active = TRUE,
          updated_at = NOW()
        WHERE id = $5
      `,
      [adminName, adminEmail, adminUsername, adminPasswordHash, existingAdmin.rows[0].id]
    );
  } else {
    await query(
      `
        INSERT INTO teachers (name, email, username, password_hash, role, is_active)
        VALUES ($1, $2, $3, $4, 'admin', TRUE)
      `,
      [adminName, adminEmail, adminUsername, adminPasswordHash]
    );
  }
  const ownerCheck = await query("SELECT id FROM teachers WHERE id = $1", [OWNER_USER_ID]);
  if (!ownerCheck.rowCount) throw new Error(`Primary owner user ID ${OWNER_USER_ID} does not exist`);
  await query("UPDATE teachers SET role = 'admin' WHERE role = 'owner' AND id <> $1", [OWNER_USER_ID]);
  await query("UPDATE teachers SET role = 'owner', is_active = TRUE, deleted_at = NULL, permissions_initialized = TRUE, updated_at = NOW() WHERE id = $1", [OWNER_USER_ID]);
  await query(
    `UPDATE teachers
     SET permissions = CASE
       WHEN jsonb_typeof(permissions) = 'array' AND jsonb_array_length(permissions) > 0 THEN permissions
       WHEN role = 'admin' THEN $1::jsonb
       ELSE $2::jsonb
     END,
     permissions_initialized = TRUE
     WHERE permissions_initialized = FALSE`,
    [JSON.stringify(DEFAULT_ADMIN_PERMISSIONS), JSON.stringify(DEFAULT_STAFF_PERMISSIONS)]
  );
  await query("CREATE UNIQUE INDEX IF NOT EXISTS teachers_single_owner_idx ON teachers ((role)) WHERE role = 'owner'");
  await query(`
    UPDATE teachers
    SET permissions = (
      SELECT jsonb_agg(DISTINCT permission ORDER BY permission)
      FROM jsonb_array_elements_text(COALESCE(permissions, '[]'::jsonb) || '["activity_log.export"]'::jsonb) AS permission
    )
    WHERE role = 'admin' AND permissions ? 'activity_log.view' AND NOT (permissions ? 'activity_log.export')
  `);
  console.log("Admin user ensured");

  const OFFICIAL_PUBLIC_WHATSAPP = "201010971994";
  const sitePages = [
    {
      slug: "about-teacher",
      title_ar: "عن المستر",
      title_en: "About Teacher",
      subtitle_ar: "مستر أحمد عبدربه مدرس العلوم بخطة متابعة واضحة لكل طالب.",
      subtitle_en:
        "Mr. Ahmed Abdrabo teaches Science with a clear follow-up plan for every student.",
      content_ar: {
        teacherName: "مستر أحمد عبدربه",
        subject: "العلوم",
        bio: "شرح منظم يربط المنهج بالتطبيقات العملية ويساعد الطالب على فهم الفكرة قبل حفظها.",
        experienceYears: "10+ سنوات خبرة",
        teachingStyle: "شرح مبسط، تدريب مستمر، ومتابعة فردية بعد كل تقييم.",
        stats: ["1200+ طالب", "92% نسبة تحسن في الدرجات", "اختبارات دورية"]
      },
      content_en: {
        teacherName: "Mr. Ahmed Abdrabo",
        subject: "Science",
        bio: "Structured explanations that connect the curriculum to practical examples and help students understand before memorizing.",
        experienceYears: "10+ years of experience",
        teachingStyle: "Simple explanation, continuous practice, and individual follow-up after every assessment.",
        stats: ["1200+ students taught", "92% score improvement rate", "Regular practice exams"]
      }
    },
    {
      slug: "contact",
      title_ar: "التواصل",
      title_en: "Contact",
      subtitle_ar: "للاستفسار عن المجموعات والحضور ودرجات الطلاب.",
      subtitle_en: "For questions about groups, attendance, and student scores.",
      content_ar: {
        whatsapp: OFFICIAL_PUBLIC_WHATSAPP,
        facebook: "facebook.com/abdrabo.science",
        youtube: "youtube.com/@abdrabo-science",
        formIntro: "اترك بياناتك وسيتم التواصل معك."
      },
      content_en: {
        whatsapp: OFFICIAL_PUBLIC_WHATSAPP,
        facebook: "facebook.com/abdrabo.science",
        youtube: "youtube.com/@abdrabo-science",
        formIntro: "Leave your details and we will contact you."
      }
    },
  ];

  for (const page of sitePages) {
    await query(
      `
        INSERT INTO site_pages (
          slug,
          title_ar,
          title_en,
          subtitle_ar,
          subtitle_en,
          content_ar,
          content_en
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
        ON CONFLICT (slug) DO NOTHING
      `,
      [
        page.slug,
        page.title_ar,
        page.title_en,
        page.subtitle_ar,
        page.subtitle_en,
        JSON.stringify(page.content_ar),
        JSON.stringify(page.content_en)
      ]
    );
  }

  await query("DELETE FROM site_pages WHERE slug = $1", ["about-" + "center"]);

  await query(
    `UPDATE site_pages
     SET content_ar = jsonb_set(content_ar, '{whatsapp}', to_jsonb($1::text), TRUE),
         content_en = jsonb_set(content_en, '{whatsapp}', to_jsonb($1::text), TRUE),
         updated_at = NOW()
     WHERE slug = 'contact' AND content_ar->>'whatsapp' = '01000000000'`,
    [OFFICIAL_PUBLIC_WHATSAPP]
  );

  await query(
    `INSERT INTO site_content (key, content, updated_at)
     VALUES ('home', $1::jsonb, NOW())
     ON CONFLICT (key) DO NOTHING`,
    [JSON.stringify(DEFAULT_HOME_CONTENT)]
  );

  // Attendance history is immutable: a session with records must not be
  // deleted through a cascading foreign key.
  await query(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'attendance_records_session_id_fkey'
          AND conrelid = 'public.attendance_records'::regclass
          AND confdeltype <> 'r'
      ) THEN
        ALTER TABLE attendance_records DROP CONSTRAINT attendance_records_session_id_fkey;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'attendance_records_session_id_fkey'
          AND conrelid = 'public.attendance_records'::regclass
      ) THEN
        ALTER TABLE attendance_records
          ADD CONSTRAINT attendance_records_session_id_fkey
          FOREIGN KEY (session_id) REFERENCES attendance_sessions(id) ON DELETE RESTRICT;
      END IF;
    END $$;
  `);

  // Keep existing local seed data aligned with the current Arabic branding.
  await query("UPDATE groups SET subject = $1 WHERE subject = $2", ["العلوم", "العلوم المتكاملة"]);
  await query(
    `
      UPDATE site_pages
      SET subtitle_ar = REPLACE(subtitle_ar, $1, $2),
          content_ar = REPLACE(content_ar::text, $1, $2)::jsonb,
          subtitle_en = REPLACE(subtitle_en, $4, $5),
          content_en = REPLACE(content_en::text, $4, $5)::jsonb
      WHERE subtitle_ar LIKE $3 OR content_ar::text LIKE $3 OR subtitle_en LIKE $6 OR content_en::text LIKE $6
    `,
    ["العلوم المتكاملة", "العلوم", "%العلوم المتكاملة%", "Integrated Science", "Science", "%Integrated Science%"]
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  migrate()
    .then(() => {
      console.log("Database migrated and seeded.");
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
