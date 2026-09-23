import test from "node:test";
import assert from "node:assert/strict";
import { getPublicGroupCatalog } from "../src/services/publicGroupCatalog.js";

const rows = [
  {
    group_id: 7,
    display_name: "مجموعة أولى إعدادي",
    grade: "الصف الأول الإعدادي",
    grade_level: "أولى إعدادي",
    subject: "العلوم",
    monthly_fee: "120.00",
    schedules: [
      { day_of_week: 0, start_time: "14:00:00", end_time: "15:00:00" },
      { day_of_week: 3, start_time: "16:00:00", end_time: "17:00:00" }
    ]
  },
  {
    group_id: 8,
    display_name: "مجموعة ثانية إعدادي",
    grade: "الصف الثاني الإعدادي",
    grade_level: "ثانية إعدادي",
    subject: "العلوم",
    monthly_fee: "150.00",
    schedules: []
  }
];

function catalogDb() {
  return async (sql) => {
    assert.match(sql, /g\.is_active = TRUE/);
    assert.match(sql, /g\.deleted_at IS NULL/);
    assert.match(sql, /cs\.is_active = TRUE/);
    assert.match(sql, /cs\.deleted_at IS NULL/);
    return { rows };
  };
}

test("returns active groups with their per-group fee and multiple schedules", async () => {
  const catalog = await getPublicGroupCatalog(catalogDb());

  const first = catalog.find((group) => group.groupId === 7);
  const second = catalog.find((group) => group.groupId === 8);
  assert.equal(first.monthlyFee, 120);
  assert.equal(second.monthlyFee, 150);
  assert.equal(first.schedules.some((schedule) => schedule.dayOfWeek === 0 && schedule.startTime === "14:00:00"), true);
  assert.equal(first.schedules.some((schedule) => schedule.dayOfWeek === 1 && schedule.startTime === "14:00:00"), true);
  assert.equal(second.schedules.some((schedule) => schedule.dayOfWeek === 0 && schedule.startTime === "15:00:00"), true);
  assert.equal(catalog[0].monthlyFee, 120);
  assert.ok(catalog.length >= 7);
  assert.notEqual(first.monthlyFee, second.monthlyFee);
});

test("excludes inactive and deleted groups and schedules through the SQL predicates", async () => {
  const sourceRows = [
    {
      ...rows[0],
      group_active: true,
      group_deleted_at: null,
      schedules: [
        ...rows[0].schedules,
        { day_of_week: 4, start_time: "18:00:00", end_time: "19:00:00", schedule_active: false, schedule_deleted_at: null },
        { day_of_week: 5, start_time: "18:00:00", end_time: "19:00:00", schedule_active: true, schedule_deleted_at: "2026-01-01" }
      ]
    },
    { ...rows[0], group_id: 9, display_name: "Inactive", group_active: false, group_deleted_at: null },
    { ...rows[0], group_id: 10, display_name: "Deleted", group_active: true, group_deleted_at: "2026-01-01" }
  ];
  const db = async (sql) => {
    assert.match(sql, /g\.is_active = TRUE/);
    assert.match(sql, /g\.deleted_at IS NULL/);
    assert.match(sql, /cs\.is_active = TRUE/);
    assert.match(sql, /cs\.deleted_at IS NULL/);
    return {
      rows: sourceRows
        .filter((row) => row.group_active && row.group_deleted_at === null)
        .map(({ group_active, group_deleted_at, schedules, ...row }) => ({
          ...row,
          schedules: schedules
            .filter((schedule) => schedule.schedule_active !== false && (schedule.schedule_deleted_at === undefined || schedule.schedule_deleted_at === null))
            .map(({ schedule_active, schedule_deleted_at, ...schedule }) => schedule)
        }))
    };
  };

  const catalog = await getPublicGroupCatalog(db);

  assert.deepEqual(catalog.filter((group) => group.groupId).map((group) => group.groupId), [7]);
  assert.equal(catalog.find((group) => group.groupId === 7).schedules.length, 8);
});

function rowsDb(sourceRows) {
  return async () => ({ rows: sourceRows });
}

test("fallback-only group schedules are available without inventing a price", async () => {
  const catalog = await getPublicGroupCatalog(rowsDb([]));
  const group = catalog.find((item) => item.displayName === "5 ابتدائي");
  assert.deepEqual(group.schedules, [
    { dayOfWeek: 3, startTime: "16:00:00", endTime: "17:00:00" },
    { dayOfWeek: 6, startTime: "17:00:00", endTime: "18:00:00" }
  ]);
  assert.equal(Object.prototype.hasOwnProperty.call(group, "monthlyFee"), false);
});

test("live-only group schedules remain available", async () => {
  const catalog = await getPublicGroupCatalog(rowsDb([{
    group_id: 99, display_name: "مجموعة تجريبية", grade: "درجة غير معروفة", grade_level: "غير معروفة", subject: "العلوم", monthly_fee: "200", schedules: [{ day_of_week: 2, start_time: "18:00:00", end_time: "19:00:00" }]
  }]));
  const group = catalog.find((item) => item.groupId === 99);
  assert.deepEqual(group.schedules, [{ dayOfWeek: 2, startTime: "18:00:00", endTime: "19:00:00" }]);
});

test("a missing live day uses the fallback day", async () => {
  const catalog = await getPublicGroupCatalog(rowsDb([{
    group_id: 11, display_name: "أولى إعدادي", grade: "الصف الأول الإعدادي", grade_level: "أولى إعدادي", subject: "العلوم", monthly_fee: "120", schedules: [{ day_of_week: 6, start_time: "15:00:00", end_time: "16:00:00" }]
  }]));
  const schedules = catalog.find((item) => item.groupId === 11).schedules;
  assert.deepEqual(schedules.filter((schedule) => schedule.dayOfWeek === 6), [{ dayOfWeek: 6, startTime: "15:00:00", endTime: "16:00:00" }]);
  assert.equal(schedules.some((schedule) => schedule.dayOfWeek === 1 && schedule.startTime === "14:00:00"), true);
});

test("live schedules replace all fallback slots for the same day", async () => {
  const catalog = await getPublicGroupCatalog(rowsDb([{
    group_id: 12, display_name: "1 اعدادي", grade: "1 اعدادي", grade_level: "1 اعدادي", subject: "العلوم", monthly_fee: "120", schedules: [{ day_of_week: 6, start_time: "15:00:00", end_time: "16:00:00" }, { day_of_week: 6, start_time: "16:00:00", end_time: "17:00:00" }]
  }]));
  const saturday = catalog.find((item) => item.groupId === 12).schedules.filter((schedule) => schedule.dayOfWeek === 6);
  assert.deepEqual(saturday, [
    { dayOfWeek: 6, startTime: "15:00:00", endTime: "16:00:00" },
    { dayOfWeek: 6, startTime: "16:00:00", endTime: "17:00:00" }
  ]);
  assert.equal(saturday.some((schedule) => schedule.startTime === "14:00:00"), false);
});

test("equivalent live schedule slots are deduplicated", async () => {
  const catalog = await getPublicGroupCatalog(rowsDb([{
    group_id: 13, display_name: "6 ابتدائي", grade: "6 ابتدائي", grade_level: "6 ابتدائي", subject: "العلوم", monthly_fee: "100", schedules: [{ day_of_week: 6, start_time: "09:00:00", end_time: "10:00:00" }, { day_of_week: 6, start_time: "09:00:00", end_time: "10:00:00" }]
  }]));
  assert.equal(catalog.find((item) => item.groupId === 13).schedules.filter((schedule) => schedule.dayOfWeek === 6).length, 1);
});

test("first secondary group one and two remain distinct", async () => {
  const catalog = await getPublicGroupCatalog(rowsDb([]));
  const first = catalog.find((group) => group.displayName === "أولى ثانوي 1");
  const second = catalog.find((group) => group.displayName === "أولى ثانوي 2");
  assert.ok(first && second);
  assert.notDeepEqual(first.schedules, second.schedules);
});

test("a later matching live group merges with its fallback instead of duplicating it", async () => {
  const catalog = await getPublicGroupCatalog(rowsDb([{
    group_id: 14, display_name: "الصف الأول الإعدادي", grade: "أولى إعدادي", grade_level: "أولى إعدادي", subject: "العلوم", monthly_fee: "125", schedules: []
  }]));
  assert.equal(catalog.filter((group) => group.displayName === "الصف الأول الإعدادي").length, 1);
  assert.equal(catalog.find((group) => group.groupId === 14).monthlyFee, 125);
});

test("fallback schedules never create a price; live group fees remain authoritative", async () => {
  const catalog = await getPublicGroupCatalog(rowsDb([{
    group_id: 15, display_name: "أولى ثانوي 1", grade: "الصف الأول الثانوي", grade_level: "أولى ثانوي", subject: "العلوم", monthly_fee: "175", schedules: []
  }]));
  assert.equal(catalog.find((group) => group.groupId === 15).monthlyFee, 175);
  assert.equal(Object.prototype.hasOwnProperty.call(catalog.find((group) => group.displayName === "أولى ثانوي 2"), "monthlyFee"), false);
});
