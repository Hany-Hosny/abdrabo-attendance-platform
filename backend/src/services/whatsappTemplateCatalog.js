export const WHATSAPP_TEMPLATE_CATEGORIES = Object.freeze([
  "attendance",
  "absence",
  "grade",
  "receipt",
  "advance_payment"
]);

export const WHATSAPP_TEMPLATE_AUDIENCES = Object.freeze(["male", "female", "neutral"]);

export const WHATSAPP_TEMPLATE_PLACEHOLDERS = Object.freeze({
  attendance: Object.freeze(["student_name", "student_code", "date", "time", "group_name", "portal_link", "ref_code"]),
  absence: Object.freeze(["student_name", "student_code", "date", "group_name", "portal_link", "ref_code"]),
  grade: Object.freeze(["student_name", "student_code", "exam_title", "score", "max_score", "percentage", "portal_link", "ref_code"]),
  receipt: Object.freeze(["student_name", "student_code", "amount_paid", "month", "receipt_number", "portal_link", "ref_code"]),
  advance_payment: Object.freeze(["student_name", "student_code", "amount_paid", "months", "receipt_number", "portal_link", "ref_code"])
});

export const WHATSAPP_REQUIRED_PLACEHOLDERS = Object.freeze({
  attendance: ["student_name", "group_name", "date"],
  absence: ["student_name", "group_name", "date"],
  grade: ["student_name", "exam_title", "score", "max_score"],
  receipt: ["student_name", "amount_paid", "receipt_number"],
  advance_payment: ["student_name", "amount_paid", "months", "receipt_number"]
});

const attendanceMale = [
  "تم تسجيل حضور الطالب {student_name} في حصة {group_name} بتاريخ {date} في تمام الساعة {time}.\nكود الطالب: {student_code}\nرابط المتابعة: {portal_link}\nالمرجع: {ref_code}",
  "نحيطكم علماً بأن الطالب {student_name} حضر حصة {group_name}.\nالتاريخ: {date}\nالوقت: {time}\nللمتابعة: {portal_link}\nرقم المرجع: {ref_code}",
  "إشعار حضور\nحضر الطالب {student_name} جلسة {group_name} بتاريخ {date} الساعة {time}.\nكود الطالب: {student_code}\nتفاصيل المتابعة: {portal_link}\nالمرجع: {ref_code}",
  "أهلاً بكم، تم إثبات حضور الطالب {student_name} في مجموعة {group_name} يوم {date} الساعة {time}.\nيمكنكم مراجعة الملف عبر {portal_link}\nالمرجع: {ref_code}"
];

const attendanceFemale = [
  "تم تسجيل حضور الطالبة {student_name} في حصة {group_name} بتاريخ {date} في تمام الساعة {time}.\nكود الطالبة: {student_code}\nرابط المتابعة: {portal_link}\nالمرجع: {ref_code}",
  "نحيطكم علماً بأن الطالبة {student_name} حضرت حصة {group_name}.\nالتاريخ: {date}\nالوقت: {time}\nللمتابعة: {portal_link}\nرقم المرجع: {ref_code}",
  "إشعار حضور\nحضرت الطالبة {student_name} جلسة {group_name} بتاريخ {date} الساعة {time}.\nكود الطالبة: {student_code}\nتفاصيل المتابعة: {portal_link}\nالمرجع: {ref_code}",
  "أهلاً بكم، تم إثبات حضور الطالبة {student_name} في مجموعة {group_name} يوم {date} الساعة {time}.\nيمكنكم مراجعة الملف عبر {portal_link}\nالمرجع: {ref_code}"
];

const absenceMale = [
  "السادة أولياء الأمور، نود إبلاغكم بأنه لم يُسجل حضور الطالب {student_name} في حصة {group_name} بتاريخ {date}.\nللمتابعة: {portal_link}\nالمرجع: {ref_code}",
  "تنبيه متابعة: لم يظهر تسجيل حضور للطالب {student_name} في جلسة {group_name} يوم {date}.\nكود الطالب: {student_code}\nالتفاصيل: {portal_link}\nالمرجع: {ref_code}",
  "نحيطكم علماً بأن سجل الحضور لا يتضمن حضور الطالب {student_name} في مجموعة {group_name} بتاريخ {date}.\nرابط المتابعة: {portal_link}\nرقم المرجع: {ref_code}",
  "إشعار بشأن الحضور\nلم يتم تسجيل حضور الطالب {student_name} لهذه الحصة في {group_name} بتاريخ {date}.\nيمكنكم مراجعة السجل عبر {portal_link}\nالمرجع: {ref_code}"
];

const absenceFemale = [
  "السادة أولياء الأمور، نود إبلاغكم بأنه لم يُسجل حضور الطالبة {student_name} في حصة {group_name} بتاريخ {date}.\nللمتابعة: {portal_link}\nالمرجع: {ref_code}",
  "تنبيه متابعة: لم يظهر تسجيل حضور للطالبة {student_name} في جلسة {group_name} يوم {date}.\nكود الطالبة: {student_code}\nالتفاصيل: {portal_link}\nالمرجع: {ref_code}",
  "نحيطكم علماً بأن سجل الحضور لا يتضمن حضور الطالبة {student_name} في مجموعة {group_name} بتاريخ {date}.\nرابط المتابعة: {portal_link}\nرقم المرجع: {ref_code}",
  "إشعار بشأن الحضور\nلم يتم تسجيل حضور الطالبة {student_name} لهذه الحصة في {group_name} بتاريخ {date}.\nيمكنكم مراجعة السجل عبر {portal_link}\nالمرجع: {ref_code}"
];

const gradeMale = [
  "تم رصد نتيجة الطالب {student_name} في امتحان {exam_title}: {score} من {max_score} بنسبة {percentage}%.\nتقرير التقييم: {portal_link}\nالمرجع: {ref_code}",
  "نتيجة الطالب {student_name} في {exam_title} هي {score}/{max_score}، بنسبة {percentage}%.\nيمكنكم الاطلاع على التفاصيل هنا: {portal_link}\nرقم المرجع: {ref_code}",
  "نحيطكم علماً بظهور نتيجة الطالب {student_name} في امتحان {exam_title}.\nالدرجة: {score} من {max_score}\nالنسبة: {percentage}%\nالرابط: {portal_link}\nالمرجع: {ref_code}",
  "إشعار نتيجة\nحصل الطالب {student_name} على {score} من {max_score} في {exam_title}، بنسبة {percentage}%.\nتفاصيل النتيجة: {portal_link}\nالمرجع: {ref_code}"
];

const gradeFemale = [
  "تم رصد نتيجة الطالبة {student_name} في امتحان {exam_title}: {score} من {max_score} بنسبة {percentage}%.\nتقرير التقييم: {portal_link}\nالمرجع: {ref_code}",
  "نتيجة الطالبة {student_name} في {exam_title} هي {score}/{max_score}، بنسبة {percentage}%.\nيمكنكم الاطلاع على التفاصيل هنا: {portal_link}\nرقم المرجع: {ref_code}",
  "نحيطكم علماً بظهور نتيجة الطالبة {student_name} في امتحان {exam_title}.\nالدرجة: {score} من {max_score}\nالنسبة: {percentage}%\nالرابط: {portal_link}\nالمرجع: {ref_code}",
  "إشعار نتيجة\nحصلت الطالبة {student_name} على {score} من {max_score} في {exam_title}، بنسبة {percentage}%.\nتفاصيل النتيجة: {portal_link}\nالمرجع: {ref_code}"
];

const receiptMale = [
  "تم تسجيل سداد بقيمة {amount_paid} ج.م للطالب {student_name} عن {month}.\nرقم الإيصال: {receipt_number}\nكشف الحساب: {portal_link}\nالمرجع: {ref_code}",
  "إيصال مصروفات\nاستلمنا مبلغ {amount_paid} ج.م لحساب الطالب {student_name} عن {month}.\nمرجع الدفع: {receipt_number}\nللمتابعة: {portal_link}\nالمرجع: {ref_code}",
  "نؤكد استلام الدفعة الخاصة بالطالب {student_name}.\nالمبلغ: {amount_paid} ج.م\nالفترة: {month}\nرقم العملية: {receipt_number}\nالتفاصيل: {portal_link}\nالمرجع: {ref_code}",
  "تم تحديث حساب الطالب {student_name} بعد سداد {amount_paid} ج.م عن {month}.\nرقم الإيصال {receipt_number}\nرابط الحساب: {portal_link}\nالمرجع: {ref_code}"
];

const receiptFemale = [
  "تم تسجيل سداد بقيمة {amount_paid} ج.م للطالبة {student_name} عن {month}.\nرقم الإيصال: {receipt_number}\nكشف الحساب: {portal_link}\nالمرجع: {ref_code}",
  "إيصال مصروفات\nاستلمنا مبلغ {amount_paid} ج.م لحساب الطالبة {student_name} عن {month}.\nمرجع الدفع: {receipt_number}\nللمتابعة: {portal_link}\nالمرجع: {ref_code}",
  "نؤكد استلام الدفعة الخاصة بالطالبة {student_name}.\nالمبلغ: {amount_paid} ج.م\nالفترة: {month}\nرقم العملية: {receipt_number}\nالتفاصيل: {portal_link}\nالمرجع: {ref_code}",
  "تم تحديث حساب الطالبة {student_name} بعد سداد {amount_paid} ج.م عن {month}.\nرقم الإيصال {receipt_number}\nرابط الحساب: {portal_link}\nالمرجع: {ref_code}"
];

const advanceMale = [
  "تم تسجيل دفعة مقدمة بقيمة {amount_paid} ج.م للطالب {student_name} عن الشهور {months}.\nرقم الإيصال: {receipt_number}\nمتابعة الحساب: {portal_link}\nالمرجع: {ref_code}",
  "إيصال دفع مقدم\nاستلمنا {amount_paid} ج.م لحساب الطالب {student_name} عن {months}.\nمرجع العملية: {receipt_number}\nالرابط: {portal_link}\nالمرجع: {ref_code}",
  "نؤكد تسجيل الدفعة المقدمة الخاصة بالطالب {student_name}.\nالمبلغ: {amount_paid} ج.م\nالشهور المغطاة: {months}\nرقم الإيصال: {receipt_number}\nالتفاصيل: {portal_link}\nالمرجع: {ref_code}",
  "تم تحديث حساب الطالب {student_name} بدفعة مقدمة قدرها {amount_paid} ج.م للشهور {months}.\nرقم السند: {receipt_number}\nللمتابعة: {portal_link}\nالمرجع: {ref_code}"
];

const advanceFemale = [
  "تم تسجيل دفعة مقدمة بقيمة {amount_paid} ج.م للطالبة {student_name} عن الشهور {months}.\nرقم الإيصال: {receipt_number}\nمتابعة الحساب: {portal_link}\nالمرجع: {ref_code}",
  "إيصال دفع مقدم\nاستلمنا {amount_paid} ج.م لحساب الطالبة {student_name} عن {months}.\nمرجع العملية: {receipt_number}\nالرابط: {portal_link}\nالمرجع: {ref_code}",
  "نؤكد تسجيل الدفعة المقدمة الخاصة بالطالبة {student_name}.\nالمبلغ: {amount_paid} ج.م\nالشهور المغطاة: {months}\nرقم الإيصال: {receipt_number}\nالتفاصيل: {portal_link}\nالمرجع: {ref_code}",
  "تم تحديث حساب الطالبة {student_name} بدفعة مقدمة قدرها {amount_paid} ج.م للشهور {months}.\nرقم السند: {receipt_number}\nللمتابعة: {portal_link}\nالمرجع: {ref_code}"
];

export const WHATSAPP_TEMPLATE_CATALOG = Object.freeze({
  attendance: Object.freeze({ male: attendanceMale, female: attendanceFemale, neutral: "السادة أولياء الأمور، نود إبلاغكم بأنه تم تسجيل حضور باسم {student_name} في حصة {group_name} بتاريخ {date} الساعة {time}.\nرابط المتابعة: {portal_link}\nالمرجع: {ref_code}" }),
  absence: Object.freeze({ male: absenceMale, female: absenceFemale, neutral: "السادة أولياء الأمور، نود إبلاغكم بأنه لم يُسجل حضور باسم {student_name} في حصة {group_name} بتاريخ {date}.\nللمتابعة: {portal_link}\nالمرجع: {ref_code}" }),
  grade: Object.freeze({ male: gradeMale, female: gradeFemale, neutral: "نحيطكم علماً بظهور نتيجة باسم {student_name} في امتحان {exam_title}: {score} من {max_score} بنسبة {percentage}%.\nالتفاصيل: {portal_link}\nالمرجع: {ref_code}" }),
  receipt: Object.freeze({ male: receiptMale, female: receiptFemale, neutral: "تم تسجيل سداد بقيمة {amount_paid} ج.م باسم {student_name} عن {month}.\nرقم الإيصال: {receipt_number}\nكشف الحساب: {portal_link}\nالمرجع: {ref_code}" }),
  advance_payment: Object.freeze({ male: advanceMale, female: advanceFemale, neutral: "تم تسجيل دفعة مقدمة بقيمة {amount_paid} ج.م باسم {student_name} عن الشهور {months}.\nرقم الإيصال: {receipt_number}\nمتابعة الحساب: {portal_link}\nالمرجع: {ref_code}" })
});

export function normalizeStudentGender(value) {
  const gender = String(value ?? "").trim().toLowerCase();
  return gender === "male" || gender === "female" ? gender : "unknown";
}
