export const ATTENDANCE_TIME_ZONE = "Africa/Cairo";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

function parseTime(value, fieldName) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/);
  if (!match) throw new TypeError(`${fieldName} must be an HH:MM time`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  if (hour > 23 || minute > 59 || second > 59) throw new TypeError(`${fieldName} is invalid`);
  return ((hour * 60) + minute) * MINUTE_MS + second * 1000;
}

function parseDate(value) {
  const text = String(value || "");
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new TypeError("sessionDate must be YYYY-MM-DD");
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.toISOString().slice(0, 10) !== text) throw new TypeError("sessionDate is invalid");
  return date;
}

function zonedParts(value, timeZone) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError("now must be a valid Date");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "iso8601",
    numberingSystem: "latn",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    millisecond: date.getMilliseconds()
  };
}

function localWallTimeMs(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, parts.millisecond);
}

function localDateTimeToInstant(wallTimeMs, timeZone) {
  let guessMs = wallTimeMs;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observedWallMs = localWallTimeMs(zonedParts(new Date(guessMs), timeZone));
    guessMs += wallTimeMs - observedWallMs;
  }
  return guessMs;
}

/**
 * Evaluate a schedule occurrence using only a trusted server/database time.
 * The schedule day is the local day on which the class starts. An end time
 * earlier than the start time is therefore treated as the following day.
 */
export function evaluateAttendanceWindow({
  now = new Date(),
  sessionDate,
  dayOfWeek,
  startTime,
  endTime,
  openBeforeMinutes = 3,
  closeAttendanceAfterMinutes = 20,
  timeZone = ATTENDANCE_TIME_ZONE
} = {}) {
  const day = Number(dayOfWeek);
  const openBefore = Number(openBeforeMinutes);
  const closeAfter = Number(closeAttendanceAfterMinutes);
  if (!Number.isInteger(day) || day < 0 || day > 6) throw new TypeError("dayOfWeek must be between 0 and 6");
  if (!Number.isInteger(openBefore) || openBefore < 0) throw new TypeError("openBeforeMinutes must be a non-negative integer");
  if (!Number.isInteger(closeAfter) || closeAfter < 0) throw new TypeError("closeAttendanceAfterMinutes must be a non-negative integer");

  const local = zonedParts(now, timeZone);
  const currentInstantMs = (now instanceof Date ? now : new Date(now)).getTime();
  const occurrenceDateMs = parseDate(sessionDate).getTime();
  const currentDateMs = Date.UTC(local.year, local.month - 1, local.day);
  const currentDayOfWeek = new Date(currentDateMs).getUTCDay();
  const startOffsetMs = parseTime(startTime, "startTime");
  const endOffsetMs = parseTime(endTime, "endTime");
  const startWallMs = occurrenceDateMs + startOffsetMs;
  const endWallMs = occurrenceDateMs + (endOffsetMs <= startOffsetMs ? DAY_MS : 0) + endOffsetMs;
  const windowStartMs = startWallMs - openBefore * MINUTE_MS;
  const windowEndMs = startWallMs + closeAfter * MINUTE_MS;
  const windowStartInstantMs = localDateTimeToInstant(windowStartMs, timeZone);
  const windowEndInstantMs = localDateTimeToInstant(windowEndMs, timeZone);
  const sessionEndInstantMs = localDateTimeToInstant(endWallMs, timeZone);
  const sameScheduledDay = currentDateMs === occurrenceDateMs;
  const sameWeekday = currentDayOfWeek === day;

  let status = "attendance_window_open";
  if (!sameScheduledDay || !sameWeekday) status = "attendance_day_mismatch";
  else if (currentInstantMs < windowStartInstantMs) status = "session_not_started";
  else if (currentInstantMs > windowEndInstantMs) status = "attendance_window_closed";

  return {
    allowed: status === "attendance_window_open",
    status,
    timeZone,
    currentDayOfWeek,
    windowStart: new Date(windowStartInstantMs).toISOString(),
    windowEnd: new Date(windowEndInstantMs).toISOString(),
    sessionEnd: new Date(sessionEndInstantMs).toISOString()
  };
}

export function assertAttendanceWindow(schedule, options = {}) {
  const result = evaluateAttendanceWindow({ ...schedule, ...options });
  if (result.allowed) return result;
  const error = new Error(result.status);
  error.code = result.status;
  error.statusCode = 409;
  error.attendanceWindow = result;
  throw error;
}
