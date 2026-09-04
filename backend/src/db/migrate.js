import "../config/env.js";
import crypto from "node:crypto";
import { pool, query } from "./pool.js";
import { hashPassword } from "../services/auth.js";
import { DEFAULT_ADMIN_PERMISSIONS, DEFAULT_STAFF_PERMISSIONS, OWNER_USER_ID } from "../services/rbac.js";

function hashValue(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export async function migrate() {
  // 1. تحديد الـ Schema وإنشاء الجداول الأساسية
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
      national_id_hash TEXT,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      purge_after TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS class_schedules (
      id SERIAL PRIMARY KEY,
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
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
      session_date DATE NOT NULL,
      starts_at TIMESTAMPTZ NOT NULL,
      opens_at TIMESTAMPTZ NOT NULL,
      closes_at TIMESTAMPTZ NOT NULL,
      ends_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS attendance_records (
      id SERIAL PRIMARY KEY,
      session_id INTEGER NOT NULL REFERENCES attendance_sessions(id) ON DELETE CASCADE,
      student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
      student_name_snapshot TEXT,
      student_code_snapshot TEXT,
      status TEXT NOT NULL DEFAULT 'present' CHECK (status IN ('present', 'absent', 'late', 'pending_review', 'rejected')),
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
      role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('owner', 'admin', 'staff')),
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
        'evaluation_alert_threshold',
        'password_recovery_enabled',
        'password_recovery_provider',
        'password_recovery_from_email'
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
      entity_type TEXT,
      entity_id BIGINT,
      target_section TEXT,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
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

  // 2. تحديث وتعديل الأعمدة (ALTERs & Constraints) لضمان التوافق
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

    ALTER TABLE system_settings DROP CONSTRAINT IF EXISTS system_settings_key_check;
    ALTER TABLE system_settings ADD CONSTRAINT system_settings_key_check CHECK (key IN (
      'attendance_open_before_minutes',
      'attendance_close_after_minutes',
      'attendance_alert_threshold',
      'evaluation_alert_threshold',
      'password_recovery_enabled',
      'password_recovery_provider',
      'password_recovery_from_email'
    ));

    ALTER TABLE teachers DROP CONSTRAINT IF EXISTS teachers_role_check;
    UPDATE teachers SET role = 'staff' WHERE role IN ('teacher', 'assistant');
    ALTER TABLE teachers ADD CONSTRAINT teachers_role_check CHECK (role IN ('owner', 'admin', 'staff'));

    ALTER TABLE groups ADD COLUMN IF NOT EXISTS grade_level TEXT;
    ALTER TABLE groups ADD COLUMN IF NOT EXISTS display_name TEXT;
    ALTER TABLE groups ADD COLUMN IF NOT EXISTS fees_amount NUMERIC(10,2) NOT NULL DEFAULT 0 CHECK (fees_amount >= 0);
    ALTER TABLE groups ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE groups ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

    ALTER TABLE class_schedules ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    ALTER TABLE class_schedules ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

    ALTER TABLE students ADD COLUMN IF NOT EXISTS student_serial TEXT;
    ALTER TABLE students ADD COLUMN IF NOT EXISTS scan_serial TEXT;
    ALTER TABLE students ADD COLUMN IF NOT EXISTS qr_token TEXT;
    ALTER TABLE students ADD COLUMN IF NOT EXISTS gender TEXT NOT NULL DEFAULT 'unknown';
    ALTER TABLE students ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    ALTER TABLE students ADD COLUMN IF NOT EXISTS purge_after TIMESTAMPTZ;
    ALTER TABLE students ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
    ALTER TABLE students DROP CONSTRAINT IF EXISTS students_gender_check;
    ALTER TABLE students ADD CONSTRAINT students_gender_check CHECK (gender IN ('male', 'female', 'unknown'));

    ALTER TABLE attendance_records DROP CONSTRAINT IF EXISTS attendance_records_status_check;
    ALTER TABLE attendance_records ADD CONSTRAINT attendance_records_status_check CHECK (status IN ('present','absent','late','pending_review','rejected'));
    ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
    ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS student_name_snapshot TEXT;
    ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS student_code_snapshot TEXT;
    ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS whatsapp_notified BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE attendance_sessions ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ;
    ALTER TABLE exam_results ADD COLUMN IF NOT EXISTS student_name_snapshot TEXT;
    ALTER TABLE exam_results ADD COLUMN IF NOT EXISTS student_code_snapshot TEXT;
    ALTER TABLE exam_results ADD COLUMN IF NOT EXISTS whatsapp_notified BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE homework_submissions ADD COLUMN IF NOT EXISTS student_name_snapshot TEXT;
    ALTER TABLE homework_submissions ADD COLUMN IF NOT EXISTS student_code_snapshot TEXT;
    UPDATE groups SET grade_level = COALESCE(grade_level, grade), display_name = COALESCE(display_name, name);
  `);

  // 3. تحديث السجلات وصيغ الأرقام والـ Serials
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

    DELETE FROM attendance_sessions WHERE schedule_id IS NULL;
    UPDATE attendance_sessions s
    SET starts_at = ((s.session_date + cs.start_time) AT TIME ZONE 'Africa/Cairo'),
        opens_at = ((s.session_date + cs.start_time - (cs.opens_before_minutes || ' minutes')::interval) AT TIME ZONE 'Africa/Cairo'),
        closes_at = CASE
          WHEN cs.closes_after_minutes IS NOT NULL AND cs.closes_after_minutes <> 20
            THEN LEAST(((s.session_date + cs.end_time) AT TIME ZONE 'Africa/Cairo'), ((s.session_date + cs.start_time + (cs.closes_after_minutes || ' minutes')::interval) AT TIME ZONE 'Africa/Cairo'))
          ELSE ((s.session_date + cs.end_time) AT TIME ZONE 'Africa/Cairo')
        END,
        ends_at = ((s.session_date + cs.end_time) AT TIME ZONE 'Africa/Cairo')
    FROM class_schedules cs
    WHERE cs.id = s.schedule_id AND cs.group_id = s.group_id;

    ALTER TABLE attendance_sessions ALTER COLUMN ends_at SET NOT NULL;

    DELETE FROM attendance_sessions duplicate
    USING attendance_sessions keeper
    WHERE duplicate.id < keeper.id
      AND duplicate.group_id = keeper.group_id
      AND duplicate.schedule_id = keeper.schedule_id
      AND duplicate.session_date = keeper.session_date;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'attendance_sessions_group_schedule_date_unique'
      ) THEN
        ALTER TABLE attendance_sessions
          ADD CONSTRAINT attendance_sessions_group_schedule_date_unique
          UNIQUE (group_id, schedule_id, session_date);
      END IF;
    END $$;
  `);

  // 4. جداول الـ Inbox والـ Audit والـ Payments
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
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS whatsapp_notified BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS student_name_snapshot TEXT;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS student_code_snapshot TEXT;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS student_serial_snapshot TEXT;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS scan_serial_snapshot TEXT;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS group_name_snapshot TEXT;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS grade_level_snapshot TEXT;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_reference TEXT;

    CREATE TABLE IF NOT EXISTS payment_reversals (
      id BIGSERIAL PRIMARY KEY,
      payment_id BIGINT NOT NULL UNIQUE REFERENCES payments(id) ON DELETE RESTRICT,
      reversed_by INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
      reason TEXT NOT NULL,
      original_amount NUMERIC(10,2) NOT NULL CHECK (original_amount > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS payment_reversals_created_at_idx ON payment_reversals(created_at DESC);

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
      templates JSONB NOT NULL DEFAULT '[]'::jsonb,
      grade_templates JSONB NOT NULL DEFAULT '[]'::jsonb,
      receipt_templates JSONB NOT NULL DEFAULT '[]'::jsonb,
      advance_payment_templates JSONB NOT NULL DEFAULT '[]'::jsonb,
      min_delay_seconds INTEGER NOT NULL DEFAULT 4 CHECK (min_delay_seconds BETWEEN 2 AND 60),
      max_delay_seconds INTEGER NOT NULL DEFAULT 8 CHECK (max_delay_seconds BETWEEN 2 AND 60),
      updated_by INTEGER REFERENCES teachers(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (min_delay_seconds <= max_delay_seconds)
    );
    CREATE TABLE IF NOT EXISTS whatsapp_notification_jobs (
      id BIGSERIAL PRIMARY KEY,
      notification_type TEXT NOT NULL DEFAULT 'attendance' CHECK (notification_type IN ('attendance', 'grade', 'receipt', 'advance_payment')),
      source_id BIGINT,
      attendance_record_id BIGINT UNIQUE REFERENCES attendance_records(id) ON DELETE CASCADE,
      student_id INTEGER REFERENCES students(id) ON DELETE SET NULL,
      phone_number TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      ref_code TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'skipped')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      last_error TEXT,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sent_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS whatsapp_notification_jobs_queue_idx
      ON whatsapp_notification_jobs(status, next_attempt_at, id);
  `);
  // Keep every DDL/DML command separate when no transaction client is used.
  // node-postgres rejects a multi-command query whenever parameters are passed
  // ("cannot insert multiple commands into a prepared statement").
  await query("ALTER TABLE whatsapp_settings ADD COLUMN IF NOT EXISTS grade_templates JSONB NOT NULL DEFAULT '[]'::jsonb");
  await query("ALTER TABLE whatsapp_settings ADD COLUMN IF NOT EXISTS receipt_templates JSONB NOT NULL DEFAULT '[]'::jsonb");
  await query("ALTER TABLE whatsapp_settings ADD COLUMN IF NOT EXISTS advance_payment_templates JSONB NOT NULL DEFAULT '[]'::jsonb");
  await query("ALTER TABLE whatsapp_settings DROP CONSTRAINT IF EXISTS whatsapp_settings_min_delay_seconds_check");
  await query("ALTER TABLE whatsapp_settings DROP CONSTRAINT IF EXISTS whatsapp_settings_max_delay_seconds_check");
  await query("ALTER TABLE whatsapp_settings ADD CONSTRAINT whatsapp_settings_min_delay_seconds_check CHECK (min_delay_seconds BETWEEN 2 AND 60)");
  await query("ALTER TABLE whatsapp_settings ADD CONSTRAINT whatsapp_settings_max_delay_seconds_check CHECK (max_delay_seconds BETWEEN 2 AND 60)");
  await query("ALTER TABLE whatsapp_notification_jobs ADD COLUMN IF NOT EXISTS notification_type TEXT NOT NULL DEFAULT 'attendance'");
  await query("ALTER TABLE whatsapp_notification_jobs ADD COLUMN IF NOT EXISTS source_id BIGINT");
  await query("ALTER TABLE whatsapp_notification_jobs ALTER COLUMN attendance_record_id DROP NOT NULL");
  await query("ALTER TABLE whatsapp_notification_jobs DROP CONSTRAINT IF EXISTS whatsapp_notification_jobs_notification_type_check");
  await query("ALTER TABLE whatsapp_notification_jobs ADD CONSTRAINT whatsapp_notification_jobs_notification_type_check CHECK (notification_type IN ('attendance', 'grade', 'receipt', 'advance_payment'))");
  await query("UPDATE whatsapp_notification_jobs SET source_id = attendance_record_id WHERE source_id IS NULL");
  await query(
    `INSERT INTO whatsapp_settings (id, templates, grade_templates, receipt_templates, advance_payment_templates)
     VALUES (1, $1::jsonb, $2::jsonb, $3::jsonb, $4::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [JSON.stringify([
    "مرحباً بحضرتك، من منصة مستر أحمد عبدربه 👨‍🏫\nتم تسجيل حضور الطالب: {student_name}\nاليوم: {date} الساعة {time} في مجموعة: {group_name}.\nكود الطالب: {student_code}\nتقرير المتابعة: {portal_link}\nالمرجع: {ref_code}",
    "تنبيه حضور - مستر أحمد عبدربه:\nحضر الطالب {student_name} حصة {group_name} بتاريخ {date} في تمام الساعة {time}.\nرابط ملف المتابعة: {portal_link}\nالمرجع: {ref_code}",
    "إشعار حضور | مستر أحمد عبدربه\nتم تسجيل حضور {student_name} بنجاح في مجموعة {group_name}.\nالتاريخ: {date} - الوقت: {time}.\nكود الطالب: {student_code}\nتقرير فوري: {portal_link}\nرقم المرجع: {ref_code}"
    ]), JSON.stringify([
      "نتيجة تقييم - مستر أحمد عبدربه 📝\nمرحباً بحضرتك، تم رصد نتيجة امتحان {exam_title} للطالب: {student_name}.\nالدرجة: {score} من {max_score} (النسبة: {percentage}%).\nكود الطالب: {student_code}\nتقرير الإجابات والتقييم: {portal_link}\nالمرجع: {ref_code}",
      "إشعار درجات | منصة مستر أحمد عبدربه\nحصل الطالب {student_name} في {exam_title} على نتيجة {score}/{max_score} بمعدل {percentage}%.\nتفاصيل التقييم: {portal_link}\nمع تحيات مستر أحمد عبدربه وإدارة المنصة.\nالمرجع: {ref_code}",
      "تقييم دراسي - مستر أحمد عبدربه:\nتم تصحيح {exam_title} للطالب {student_name}.\nالنتيجة المحققة: {score} من أصل {max_score}.\nرابط التقرير الكامل: {portal_link}\nكود: {ref_code}"
    ]), JSON.stringify([
      "إيصال سداد مصروفات - مستر أحمد عبدربه 🧾\nالسلام عليكم يا فندم، تم استلام مبلغ {amount_paid} ج.م سداداً لمصروفات شهر {month} للطالب: {student_name}.\nرقم الإيصال: {receipt_number}\nكود الطالب: {student_code}\nعرض الإيصال: {portal_link}\nشكراً لتعاونكم الدائم.",
      "سند قبض إلكتروني | مستر أحمد عبدربه\nتم بنجاح تسجيل دفعة مالية بقيمة {amount_paid} ج.م لحساب الطالب: {student_name} (سداد {month}).\nرقم السند: {receipt_number}\nالسجل المالي: {portal_link}\nالمرجع: {ref_code}",
      "إشعار تحصيل نقدية - مكتب مستر أحمد عبدربه:\nتم استلام مبلغ {amount_paid} جنيه لمصروفات {month} الخاصة بالطالب {student_name}.\nإيصال رقم: #{receipt_number}.\nمتابعة الحساب: {portal_link}"
    ]), JSON.stringify([
      "إشعار دفع مقدم - مستر أحمد عبدربه 💳\nتم استلام مبلغ {amount_paid} ج.م كدفعة مقدمة للطالب: {student_name} عن شهور: {months}.\nرقم الإيصال: {receipt_number}\nمتابعة الحساب: {portal_link}",
      "تم بنجاح تسجيل دفعة مالية مقدمة بقيمة {amount_paid} ج.م لحساب الطالب: {student_name}.\nالشهور المسددة: {months}\nسند رقم: {receipt_number}\nالمرجع: {ref_code}",
      "إيصال استلام نقدية (دفع مقدم) | مستر أحمد عبدربه\nالطالب: {student_name}\nالمبلغ: {amount_paid} جنيه\nالشهور: {months}\nالإيصال: #{receipt_number}\nالرابط: {portal_link}"
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
      "مرحباً بحضرتك، من منصة مستر أحمد عبدربه 👨‍🏫\nتم تسجيل حضور الطالب: {student_name}\nاليوم: {date} الساعة {time} في مجموعة: {group_name}.\nكود الطالب: {student_code}\nتقرير المتابعة: {portal_link}\nالمرجع: {ref_code}",
      "تنبيه حضور - مستر أحمد عبدربه:\nحضر الطالب {student_name} حصة {group_name} بتاريخ {date} في تمام الساعة {time}.\nرابط ملف المتابعة: {portal_link}\nالمرجع: {ref_code}",
      "إشعار حضور | مستر أحمد عبدربه\nتم تسجيل حضور {student_name} بنجاح في مجموعة {group_name}.\nالتاريخ: {date} - الوقت: {time}.\nكود الطالب: {student_code}\nتقرير فوري: {portal_link}\nرقم المرجع: {ref_code}"
    ]), JSON.stringify([
      "نتيجة تقييم - مستر أحمد عبدربه 📝\nمرحباً بحضرتك، تم رصد نتيجة امتحان {exam_title} للطالب: {student_name}.\nالدرجة: {score} من {max_score} (النسبة: {percentage}%).\nكود الطالب: {student_code}\nتقرير الإجابات والتقييم: {portal_link}\nالمرجع: {ref_code}",
      "إشعار درجات | منصة مستر أحمد عبدربه\nحصل الطالب {student_name} في {exam_title} على نتيجة {score}/{max_score} بمعدل {percentage}%.\nتفاصيل التقييم: {portal_link}\nمع تحيات مستر أحمد عبدربه وإدارة المنصة.\nالمرجع: {ref_code}",
      "تقييم دراسي - مستر أحمد عبدربه:\nتم تصحيح {exam_title} للطالب {student_name}.\nالنتيجة المحققة: {score} من أصل {max_score}.\nرابط التقرير الكامل: {portal_link}\nكود: {ref_code}"
    ]), JSON.stringify([
      "إيصال سداد مصروفات - مستر أحمد عبدربه 🧾\nالسلام عليكم يا فندم، تم استلام مبلغ {amount_paid} ج.م سداداً لمصروفات شهر {month} للطالب: {student_name}.\nرقم الإيصال: {receipt_number}\nكود الطالب: {student_code}\nعرض الإيصال: {portal_link}\nشكراً لتعاونكم الدائم.",
      "سند قبض إلكتروني | مستر أحمد عبدربه\nتم بنجاح تسجيل دفعة مالية بقيمة {amount_paid} ج.م لحساب الطالب: {student_name} (سداد {month}).\nرقم السند: {receipt_number}\nالسجل المالي: {portal_link}\nالمرجع: {ref_code}",
      "إشعار تحصيل نقدية - مكتب مستر أحمد عبدربه:\nتم استلام مبلغ {amount_paid} جنيه لمصروفات {month} الخاصة بالطالب {student_name}.\nإيصال رقم: #{receipt_number}.\nمتابعة الحساب: {portal_link}"
    ]), JSON.stringify([
      "إشعار دفع مقدم - مستر أحمد عبدربه 💳\nتم استلام مبلغ {amount_paid} ج.م كدفعة مقدمة للطالب: {student_name} عن شهور: {months}.\nرقم الإيصال: {receipt_number}\nمتابعة الحساب: {portal_link}",
      "تم بنجاح تسجيل دفعة مالية مقدمة بقيمة {amount_paid} ج.م لحساب الطالب: {student_name}.\nالشهور المسددة: {months}\nسند رقم: {receipt_number}\nالمرجع: {ref_code}",
      "إيصال استلام نقدية (دفع مقدم) | مستر أحمد عبدربه\nالطالب: {student_name}\nالمبلغ: {amount_paid} جنيه\nالشهور: {months}\nالإيصال: #{receipt_number}\nالرابط: {portal_link}"
    ])]
  );

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
    UPDATE payments SET payment_reference = 'P-' || LPAD(id::text, 8, '0') WHERE payment_reference IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS payments_idempotency_key_idx ON payments(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS payments_reference_idx ON payments(payment_reference) WHERE payment_reference IS NOT NULL;
    CREATE INDEX IF NOT EXISTS attendance_records_student_idx ON attendance_records(student_id, checkin_time DESC);
    CREATE INDEX IF NOT EXISTS attendance_records_session_idx ON attendance_records(session_id, student_id);
    CREATE UNIQUE INDEX IF NOT EXISTS attendance_records_idempotency_key_idx ON attendance_records(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS attendance_sessions_group_date_idx ON attendance_sessions(group_id, session_date DESC);
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

  // 5. إدخال البيانات الافتراضية (Initial Seeding)
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

  const student = await query(
    `
      INSERT INTO students (group_id, student_code, full_name, phone, guardian_phone, national_id_hash)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (student_code) DO UPDATE SET
        group_id = EXCLUDED.group_id,
        full_name = EXCLUDED.full_name,
        phone = EXCLUDED.phone,
        guardian_phone = EXCLUDED.guardian_phone,
        national_id_hash = EXCLUDED.national_id_hash,
        is_active = TRUE
      RETURNING id
    `,
    [groupId, "A-1001", "أحمد محمد", "01000000000", "01012345678", hashValue("29901011234567")]
  );

  const studentId = student.rows[0].id;
  const schedule = await query(
    `
      INSERT INTO class_schedules (group_id, day_of_week, start_time, end_time, opens_before_minutes, closes_after_minutes)
      VALUES ($1, EXTRACT(DOW FROM NOW())::INTEGER, $2::time, $3::time, 3, 20)
      ON CONFLICT DO NOTHING
      RETURNING id
    `,
    [groupId, "18:00:00", "19:30:00"]
  );

  const exam = await query(
    `
      INSERT INTO exams (group_id, title, max_score, exam_date)
      SELECT $1, $2, 50, CURRENT_DATE - INTERVAL '7 days'
      WHERE NOT EXISTS (SELECT 1 FROM exams WHERE group_id = $1 AND title = $2)
      RETURNING id
    `,
    [groupId, "امتحان الوحدة الأولى"]
  );

  const examId =
    exam.rows[0]?.id ||
    (await query("SELECT id FROM exams WHERE group_id = $1 AND title = $2 LIMIT 1", [
      groupId,
      "امتحان الوحدة الأولى"
    ])).rows[0].id;

  await query(
    `
      INSERT INTO exam_results (exam_id, student_id, score, note)
      VALUES ($1, $2, 42, 'مستوى جيد جدا')
      ON CONFLICT (exam_id, student_id) DO UPDATE SET score = EXCLUDED.score, note = EXCLUDED.note
    `,
    [examId, studentId]
  );

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
  console.log("Admin user ensured");

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
      slug: "about-center",
      title_ar: "عن السنتر",
      title_en: "About Center",
      subtitle_ar: "بيئة تعليمية مجهزة لحصص العلوم والمتابعة المنتظمة.",
      subtitle_en: "A focused learning space for Science classes and regular follow-up.",
      content_ar: {
        intro: "السنتر يوفر نظام حضور واضح، مجموعات منظمة، ومتابعة مستمرة للطلاب.",
        address: "عنوان السنتر - يتم تحديثه لاحقا",
        groups: ["مجموعة السبت 6 مساء", "مجموعات إضافية حسب الجدول"],
        features: ["منهج محدث", "تدريب امتحانات", "متابعة فردية", "شرح مسجل"]
      },
      content_en: {
        intro: "The center provides clear attendance tracking, organized groups, and continuous student follow-up.",
        address: "Center address - to be updated",
        groups: ["Saturday 6 PM Group", "Additional groups based on schedule"],
        features: ["Updated curriculum", "Exam practice", "Individual follow-up", "Recorded explanations"]
      }
    },
    {
      slug: "contact",
      title_ar: "التواصل",
      title_en: "Contact",
      subtitle_ar: "للاستفسار عن المجموعات والحضور ودرجات الطلاب.",
      subtitle_en: "For questions about groups, attendance, and student scores.",
      content_ar: {
        whatsapp: "01000000000",
        facebook: "facebook.com/abdrabo.science",
        youtube: "youtube.com/@abdrabo-science",
        formIntro: "اترك بياناتك وسيتم التواصل معك."
      },
      content_en: {
        whatsapp: "01000000000",
        facebook: "facebook.com/abdrabo.science",
        youtube: "youtube.com/@abdrabo-science",
        formIntro: "Leave your details and we will contact you."
      }
    },
    {
      slug: "tips",
      title_ar: "نصائح",
      title_en: "Tips",
      subtitle_ar: "إرشادات سريعة تساعدك على الاستعداد للحصة والامتحان.",
      subtitle_en: "Quick guidance to help you prepare for class and exams.",
      content_ar: {
        intro: "راجع الدرس قبل الحصة، حضر أسئلتك، وحل التدريب في نفس اليوم.",
        features: ["ذاكر بانتظام", "حل أسئلة متنوعة", "راجع أخطاءك", "تابع درجاتك بعد كل امتحان"]
      },
      content_en: {
        intro: "Review the lesson before class, prepare your questions, and solve practice on the same day.",
        features: [
          "Study consistently",
          "Solve varied questions",
          "Review your mistakes",
          "Track your scores after every exam"
        ]
      }
    }
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

if (import.meta.url === `file://${process.argv[1]}`) {
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
