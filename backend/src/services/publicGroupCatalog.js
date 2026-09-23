import { query } from "../db/pool.js";

function fallbackTime(hour) {
  const value = Number(hour);
  const normalized = value === 1 ? 13 : value >= 2 && value <= 7 ? value + 12 : value;
  return `${String(normalized).padStart(2, "0")}:00:00`;
}

function fallbackSlot(dayOfWeek, hour) {
  const start = Number(fallbackTime(hour).slice(0, 2));
  return { dayOfWeek, startTime: fallbackTime(hour), endTime: `${String(start + 1).padStart(2, "0")}:00:00` };
}

export const temporaryPublicSchedules = Object.freeze([
  { logicalKey: "primary-5", displayName: "5 ابتدائي", grade: "الصف الخامس الابتدائي", gradeLevel: "خامسة ابتدائي", subject: "العلوم", schedules: [[6, 5], [3, 4]] },
  { logicalKey: "primary-6", displayName: "6 ابتدائي", grade: "الصف السادس الابتدائي", gradeLevel: "سادسة ابتدائي", subject: "العلوم", schedules: [[6, 9], [3, 6]] },
  { logicalKey: "preparatory-1", displayName: "أولى إعدادي", grade: "الصف الأول الإعدادي", gradeLevel: "أولى إعدادي", subject: "العلوم", schedules: [[6, 2], [6, 3], [6, 4], [1, 2], [1, 3], [1, 5], [3, 2], [3, 3], [3, 7]] },
  { logicalKey: "preparatory-2", displayName: "ثانية إعدادي", grade: "الصف الثاني الإعدادي", gradeLevel: "ثانية إعدادي", subject: "العلوم", schedules: [[0, 3], [0, 4], [0, 5], [2, 3], [2, 4], [2, 5], [3, 3], [3, 4], [3, 5]] },
  { logicalKey: "preparatory-3", displayName: "ثالثة إعدادي", grade: "الصف الثالث الإعدادي", gradeLevel: "ثالثة إعدادي", subject: "العلوم", schedules: [[6, 12], [6, 1], [1, 12], [1, 1], [3, 12], [3, 1]] },
  { logicalKey: "secondary-1-1", displayName: "أولى ثانوي 1", grade: "الصف الأول الثانوي", gradeLevel: "أولى ثانوي", subject: "العلوم", schedules: [[0, 6], [0, 7], [2, 6], [2, 7], [4, 6], [4, 7]] },
  { logicalKey: "secondary-1-2", displayName: "أولى ثانوي 2", grade: "الصف الأول الثانوي", gradeLevel: "أولى ثانوي", subject: "العلوم", schedules: [[6, 10], [1, 4], [3, 5]] }
].map((group) => ({
  ...group,
  schedules: group.schedules.map(([dayOfWeek, hour]) => fallbackSlot(dayOfWeek, hour))
}))); 

function normalizedText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[ً-ٟ]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[^a-z0-9\u0600-\u06ff]+/g, " ")
    .trim();
}

export function publicGroupLogicalKey(group) {
  const text = normalizedText([group?.displayName, group?.grade, group?.gradeLevel].join(" "));
  const secondary = text.includes("ثانوي") || text.includes("ثانويه") || text.includes("secondary");
  const numericOrdinal = text.match(/(?:^|\s)([1-6])(?:\s|$)/)?.[1];
  const ordinal = secondary
    ? (text.includes("اول") || text.includes("اولي") ? 1 : text.includes("ثان") ? 2 : text.includes("ثال") ? 3 : null)
    : numericOrdinal ? Number(numericOrdinal) : text.includes("خامس") ? 5 : text.includes("سادس") ? 6 : text.includes("اول") || text.includes("اولي") ? 1 : text.includes("ثان") ? 2 : text.includes("ثال") ? 3 : null;
  if (secondary && ordinal === 1) {
    const groupNumber = text.match(/(?:^|\s)([12])\s*$/)?.[1] || text.match(/(?:مجموعه|group)\s*([12])/)?.[1];
    return groupNumber ? `secondary-1-${groupNumber}` : null;
  }
  if (secondary && ordinal) return `secondary-${ordinal}`;
  if (text.includes("ابتدائي") || text.includes("ابتداي") || text.includes("primary")) {
    if (ordinal === 5 || ordinal === 6) return `primary-${ordinal}`;
  }
  if (text.includes("اعدادي") || text.includes("اعداديه") || text.includes("prep")) {
    if (ordinal) return `preparatory-${ordinal}`;
  }
  return null;
}

function scheduleKey(schedule) {
  return `${Number(schedule.dayOfWeek)}|${String(schedule.startTime)}|${String(schedule.endTime)}`;
}

function reconcileSchedules(liveSchedules, fallbackSchedules) {
  const live = Array.isArray(liveSchedules) ? liveSchedules : [];
  const fallback = Array.isArray(fallbackSchedules) ? fallbackSchedules : [];
  const liveDays = new Set(live.map((schedule) => Number(schedule.dayOfWeek)));
  const merged = [...live, ...fallback.filter((schedule) => !liveDays.has(Number(schedule.dayOfWeek)))];
  const seen = new Set();
  return merged.filter((schedule) => {
    const key = scheduleKey(schedule);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => Number(left.dayOfWeek) - Number(right.dayOfWeek) || String(left.startTime).localeCompare(String(right.startTime)));
}

export async function getPublicGroupCatalog(db = query) {
  const result = await db(`
    SELECT
      g.id AS group_id,
      COALESCE(g.display_name, g.name) AS display_name,
      g.grade,
      COALESCE(g.grade_level, g.grade) AS grade_level,
      g.subject,
      g.fees_amount AS monthly_fee,
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
    FROM groups g
    LEFT JOIN class_schedules cs
      ON cs.group_id = g.id
      AND cs.is_active = TRUE
      AND cs.deleted_at IS NULL
    WHERE g.is_active = TRUE
      AND g.deleted_at IS NULL
    GROUP BY g.id, g.display_name, g.name, g.grade, g.grade_level, g.subject, g.fees_amount
    ORDER BY display_name, g.id
  `);

  const liveGroups = result.rows.map((row) => {
    const schedules = Array.isArray(row.schedules) ? row.schedules.map((schedule) => ({
      dayOfWeek: Number(schedule.day_of_week),
      startTime: schedule.start_time,
      endTime: schedule.end_time
    })) : [];
    const fallback = temporaryPublicSchedules.find((group) => group.logicalKey === publicGroupLogicalKey(row));
    return {
      groupId: Number(row.group_id),
      displayName: row.display_name,
      grade: row.grade,
      gradeLevel: row.grade_level,
      subject: row.subject,
      monthlyFee: Number(row.monthly_fee),
      schedules: reconcileSchedules(schedules, fallback?.schedules)
    };
  });

  const liveKeys = new Set(liveGroups.map((group) => publicGroupLogicalKey(group)).filter(Boolean));
  const fallbackOnlyGroups = temporaryPublicSchedules
    .filter((group) => !liveKeys.has(group.logicalKey))
    .map(({ logicalKey: _logicalKey, ...group }) => ({ ...group, schedules: reconcileSchedules([], group.schedules) }));

  return [...liveGroups, ...fallbackOnlyGroups];
}
