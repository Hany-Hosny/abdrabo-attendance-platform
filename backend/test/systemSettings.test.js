import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SYSTEM_SETTINGS,
  getAttendanceTimingDefaults,
  getDashboardAlertThresholds,
  readSystemSettings,
  SettingsValidationError,
  updateSystemSettings,
  validateSettingsPatch
} from "../src/services/systemSettings.js";

test("system settings defaults preserve existing attendance and dashboard behavior", () => {
  assert.deepEqual(DEFAULT_SYSTEM_SETTINGS, {
    attendance_open_before_minutes: 3,
    attendance_close_after_minutes: 20,
    attendance_alert_threshold: 70,
    evaluation_alert_threshold: 60
  });
});

test("system settings validation normalizes supported partial updates", () => {
  assert.deepEqual(validateSettingsPatch({ attendance_close_after_minutes: "30", evaluation_alert_threshold: 55 }), {
    attendance_close_after_minutes: 30,
    evaluation_alert_threshold: 55
  });
});

test("system settings validation rejects unsupported, malformed, and out-of-range values atomically", () => {
  assert.throws(
    () => validateSettingsPatch({ attendance_alert_threshold: 101, unsupported_key: 1 }),
    (error) => error instanceof SettingsValidationError && error.errors.attendance_alert_threshold.error === "out_of_range" && error.errors.unsupported_key.error === "unsupported_setting"
  );
  assert.throws(() => validateSettingsPatch({ attendance_open_before_minutes: 1.5 }), SettingsValidationError);
  assert.throws(() => validateSettingsPatch({}), SettingsValidationError);
  assert.throws(() => validateSettingsPatch({ attendance_close_after_minutes: [] }), SettingsValidationError);
});

function createSettingsDatabase(initial = {}) {
  const values = new Map(Object.entries(initial));
  const auditEntries = [];
  let committed = false;
  const client = {
    async query(text, params = []) {
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
        if (text === "COMMIT") committed = true;
        return { rows: [], rowCount: 0 };
      }
      if (text.startsWith("SELECT key, value_json, updated_at")) {
        return {
          rows: [...values.entries()].map(([key, value_json]) => ({ key, value_json, updated_at: "2026-09-01T00:00:00.000Z" }))
        };
      }
      if (text.startsWith("INSERT INTO system_settings")) {
        values.set(params[0], JSON.parse(params[1]));
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL in settings test: ${text}`);
    },
    release() {}
  };
  return {
    values,
    auditEntries,
    get committed() { return committed; },
    async connect() { return client; },
    async query(text, params) { return client.query(text, params); }
  };
}

test("settings read-back and business consumers use persisted values", async () => {
  const db = createSettingsDatabase({
    attendance_open_before_minutes: 30,
    attendance_alert_threshold: 65
  });
  const read = await readSystemSettings(db);
  assert.equal(read.settings.attendance_open_before_minutes, 30);
  assert.equal(read.settings.attendance_close_after_minutes, 20);
  assert.deepEqual(await getAttendanceTimingDefaults(db), { openBeforeMinutes: 30, closeAfterMinutes: 20 });
  assert.deepEqual(await getDashboardAlertThresholds(db), { attendanceAlert: 65, evaluationAlert: 60 });
});

test("partial settings update persists only requested values and audits one change set", async () => {
  const db = createSettingsDatabase({ attendance_close_after_minutes: 20 });
  const request = {};
  const result = await updateSystemSettings(
    { attendance_close_after_minutes: "30" },
    {
      actorId: 7,
      request,
      db,
      audit: async (entry) => { db.auditEntries.push(entry); }
    }
  );
  assert.equal(db.committed, true);
  assert.equal(db.values.get("attendance_close_after_minutes"), 30);
  assert.equal(result.settings.attendance_close_after_minutes, 30);
  assert.equal(result.settings.evaluation_alert_threshold, 60);
  assert.deepEqual(result.changes, [{ setting: "attendance_close_after_minutes", previous_value: 20, new_value: 30 }]);
  assert.equal(db.auditEntries.length, 1);
  assert.deepEqual(db.auditEntries[0].details.changes, result.changes);
  assert.equal(request.auditLogged, undefined);
});

test("invalid settings are rejected before database access", async () => {
  let connected = false;
  await assert.rejects(
    () => updateSystemSettings({ attendance_alert_threshold: 101 }, { db: { async connect() { connected = true; } } }),
    SettingsValidationError
  );
  assert.equal(connected, false);
});
