const ARABIC_DAY_NAMES = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const ENGLISH_DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function formatDisplayTime(value, locale = "ar") {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})/);
  if (!match) return String(value || "");
  const hour = Number(match[1]);
  const minute = match[2];
  const normalizedHour = hour % 12 || 12;
  const meridiem = hour >= 12 ? (locale === "ar" ? "م" : "PM") : (locale === "ar" ? "ص" : "AM");
  return `${normalizedHour}:${minute} ${meridiem}`;
}

export function composeScheduleResponse({ groups = [], locale = "ar", gradeLabel = "", includeFees = false }) {
  const relevantGroups = groups.filter(Boolean);
  if (!relevantGroups.length) return { type: "schedule_result", text: locale === "ar" ? "المواعيد المطلوبة غير متاحة حاليًا على المنصة." : "The requested schedule is not currently available.", data: { groups: [] } };
  const dayNames = locale === "ar" ? ARABIC_DAY_NAMES : ENGLISH_DAY_NAMES;
  const lines = [];
  if (gradeLabel) lines.push(locale === "ar" ? `مواعيد ${gradeLabel}:` : `${gradeLabel} schedule:`);
  for (const group of relevantGroups) {
    const groupName = group.displayName || group.grade || (locale === "ar" ? "المجموعة" : "Group");
    const fee = includeFees && Number.isFinite(Number(group.monthlyFee)) ? ` — ${Number(group.monthlyFee)} ${locale === "ar" ? "جنيه" : "EGP"}` : "";
    lines.push(`\n${groupName}${fee}`);
    const schedules = [...(group.schedules || [])].sort((left, right) => Number(left.dayOfWeek) - Number(right.dayOfWeek) || String(left.startTime).localeCompare(String(right.startTime)));
    if (!schedules.length) {
      lines.push(locale === "ar" ? "المواعيد غير متاحة حاليًا" : "Schedule unavailable");
      continue;
    }
    for (const schedule of schedules) {
      const day = dayNames[Number(schedule.dayOfWeek)] || (locale === "ar" ? "اليوم" : "Day");
      lines.push(locale === "ar" ? `• ${day}: ${formatDisplayTime(schedule.startTime, locale)} – ${formatDisplayTime(schedule.endTime, locale)}` : `• ${day}: ${formatDisplayTime(schedule.startTime, locale)} – ${formatDisplayTime(schedule.endTime, locale)}`);
    }
  }
  return { type: "schedule_result", text: lines.join("\n"), data: { groups: relevantGroups }, followUp: relevantGroups.length > 1 ? { optional: true, kind: "group_selection" } : null };
}
