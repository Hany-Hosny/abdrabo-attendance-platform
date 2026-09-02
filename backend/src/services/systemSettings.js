import { pool, query } from "../db/pool.js";
import { auditLog } from "./audit.js";
import { normalizeDigits } from "../utils/normalizeDigits.js";

const SETTING_DEFINITIONS = Object.freeze({
  attendance_open_before_minutes: Object.freeze({ type: "integer", defaultValue: 3, min: 0, max: 180 }),
  attendance_close_after_minutes: Object.freeze({ type: "integer", defaultValue: 20, min: 0, max: 240 }),
  attendance_alert_threshold: Object.freeze({ type: "integer", defaultValue: 70, min: 0, max: 100 }),
  evaluation_alert_threshold: Object.freeze({ type: "integer", defaultValue: 60, min: 0, max: 100 }),
  password_recovery_enabled: Object.freeze({ type: "boolean", defaultValue: false }),
  password_recovery_provider: Object.freeze({ type: "provider", defaultValue: "gmail-smtp" }),
  password_recovery_from_email: Object.freeze({ type: "email", defaultValue: "" })
});

export const SYSTEM_SETTING_KEYS = Object.freeze([
  "attendance_open_before_minutes",
  "attendance_close_after_minutes",
  "attendance_alert_threshold",
  "evaluation_alert_threshold"
]);
export const PASSWORD_RECOVERY_SETTING_KEYS = Object.freeze([
  "password_recovery_enabled",
  "password_recovery_provider",
  "password_recovery_from_email"
]);
export const DEFAULT_SYSTEM_SETTINGS = Object.freeze(
  Object.fromEntries(SYSTEM_SETTING_KEYS.map((key) => [key, SETTING_DEFINITIONS[key].defaultValue]))
);
export const DEFAULT_PASSWORD_RECOVERY_SETTINGS = Object.freeze(
  Object.fromEntries(PASSWORD_RECOVERY_SETTING_KEYS.map((key) => [key, SETTING_DEFINITIONS[key].defaultValue]))
);

export class SettingsValidationError extends Error {
  constructor(errors) {
    super("Invalid system settings");
    this.name = "SettingsValidationError";
    this.errors = errors;
  }
}

function executeWith(db) {
  return typeof db === "function" ? db : db.query.bind(db);
}

function normalizeSettingValue(key, value) {
  const definition = SETTING_DEFINITIONS[key];
  if (!definition) return { error: "unsupported_setting" };
  if (value === null || value === undefined) return { error: "invalid_value" };
  if (definition.type === "boolean") return typeof value === "boolean" ? { value } : { error: "invalid_value" };
  if (definition.type === "provider") return ["gmail-smtp", "resend"].includes(value) ? { value } : { error: "invalid_value" };
  if (definition.type === "email") {
    const candidate = String(value).trim().toLowerCase();
    if (!candidate) return { value: "" };
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? { value: candidate } : { error: "invalid_value" };
  }
  if (value === "" || typeof value === "boolean") return { error: "invalid_value" };
  const candidate = typeof value === "number"
    ? value
    : typeof value === "string" && /^[-+]?\d+$/.test(normalizeDigits(value).trim())
      ? Number(normalizeDigits(value).trim())
      : Number.NaN;
  const normalized = Number(candidate);
  if (!Number.isFinite(normalized) || !Number.isInteger(normalized)) return { error: "invalid_value" };
  if (normalized < definition.min || normalized > definition.max) return { error: "out_of_range", min: definition.min, max: definition.max };
  return { value: normalized };
}

export function validateSettingsPatch(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SettingsValidationError({ settings: "invalid_payload" });
  }
  const entries = Object.entries(input);
  if (!entries.length) throw new SettingsValidationError({ settings: "empty_payload" });

  const values = {};
  const errors = {};
  for (const [key, value] of entries) {
    if (!SYSTEM_SETTING_KEYS.includes(key)) {
      errors[key] = { error: "unsupported_setting" };
      continue;
    }
    const normalized = normalizeSettingValue(key, value);
    if (normalized.error) errors[key] = normalized;
    else values[key] = normalized.value;
  }
  if (Object.keys(errors).length) throw new SettingsValidationError(errors);
  return values;
}

export async function readSystemSettings(db = query) {
  const execute = executeWith(db);
  const result = await execute(
    "SELECT key, value_json, updated_at FROM system_settings WHERE key = ANY($1::text[])",
    [SYSTEM_SETTING_KEYS]
  );
  const settings = { ...DEFAULT_SYSTEM_SETTINGS };
  const updatedAt = {};
  for (const row of result.rows) {
    if (!Object.prototype.hasOwnProperty.call(SETTING_DEFINITIONS, row.key)) continue;
    const normalized = normalizeSettingValue(row.key, row.value_json);
    if (!normalized.error) {
      settings[row.key] = normalized.value;
      updatedAt[row.key] = row.updated_at;
    }
  }
  return { settings, updatedAt };
}

export async function readPasswordRecoverySettings(db = query) {
  const execute = executeWith(db);
  const result = await execute(
    "SELECT key, value_json, updated_at FROM system_settings WHERE key = ANY($1::text[])",
    [PASSWORD_RECOVERY_SETTING_KEYS]
  );
  const settings = { ...DEFAULT_PASSWORD_RECOVERY_SETTINGS };
  const updatedAt = {};
  for (const row of result.rows) {
    if (!PASSWORD_RECOVERY_SETTING_KEYS.includes(row.key)) continue;
    const normalized = normalizeSettingValue(row.key, row.value_json);
    if (!normalized.error) {
      settings[row.key] = normalized.value;
      updatedAt[row.key] = row.updated_at;
    }
  }
  return { settings, updatedAt };
}

export async function getAttendanceTimingDefaults(db = query) {
  const { settings } = await readSystemSettings(db);
  return {
    openBeforeMinutes: settings.attendance_open_before_minutes,
    closeAfterMinutes: settings.attendance_close_after_minutes
  };
}

export async function getDashboardAlertThresholds(db = query) {
  const { settings } = await readSystemSettings(db);
  return {
    attendanceAlert: settings.attendance_alert_threshold,
    evaluationAlert: settings.evaluation_alert_threshold
  };
}

export async function updateSystemSettings(input, { actorId, request = null, db = pool, audit = auditLog } = {}) {
  const values = validateSettingsPatch(input);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const before = await readSystemSettings(client);
    const changes = Object.entries(values)
      .filter(([key, value]) => before.settings[key] !== value)
      .map(([key, value]) => ({ setting: key, previous_value: before.settings[key], new_value: value }));

    if (!changes.length && request) request.auditLogged = true;

    for (const [key, value] of Object.entries(values)) {
      await client.query(
        `INSERT INTO system_settings (key, value_json, updated_by, updated_at)
         VALUES ($1, $2::jsonb, $3, NOW())
         ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
        [key, JSON.stringify(value), actorId || null]
      );
    }

    if (changes.length) {
      await audit({
        db: client,
        action: "system_settings_changed",
        actorId,
        details: { changes },
        request
      });
    }
    const result = await readSystemSettings(client);
    await client.query("COMMIT");
    return { ...result, changes };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
