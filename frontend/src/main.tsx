import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import JsBarcode from "jsbarcode";
import "./styles.css";
import { normalizeDigits } from "./utils/normalizeDigits";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "/api";
const LANGUAGE_STORAGE_KEY = "abdrabo_language";
const STUDENT_SESSION_STORAGE_KEY = "student_session";
const ADMIN_SESSION_STORAGE_KEY = "admin_session";
const TEACHER_SESSION_STORAGE_KEY = "teacher_session";
const ASSISTANT_SESSION_STORAGE_KEY = "assistant_session";

type Language = "ar" | "en";

type DashboardData = {
  attendance: Array<Record<string, any>>;
  exams: Array<Record<string, any>>;
  schedules: Array<Record<string, any>>;
  assignments: Array<Record<string, any>>;
  notes: Array<Record<string, any>>;
};

type LoginResponse = {
  ok: boolean;
  status: string;
  message: string;
  student?: {
    id?: number;
    full_name: string;
    student_code: string;
    group_name: string;
    subject: string;
  };
  today_session?: {
    starts_at: string;
    group_name: string;
    subject: string;
  };
  attendance_record?: {
    checkin_time: string;
    status: string;
    is_suspicious: boolean;
  };
  distance_meters?: number;
  dashboard?: DashboardData;
};

type TeacherSession = {
  token: string;
  teacher: {
    id: number;
    name: string;
    email: string;
    username?: string;
    role: string;
  };
};

type AdminUser = {
  id: number;
  name: string;
  username: string;
  email: string;
  role: "admin" | "teacher" | "assistant";
  is_active: boolean;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
  print_student_labels?: boolean;
  max_label_reprints?: number;
  can_use_inbox?: boolean;
};

type AdminGroup = {
  id: number;
  center_id: number;
  center_name: string;
  name: string;
  grade: string;
  subject: string;
  is_active: boolean;
  day_of_week: number;
  start_time: string;
  end_time: string;
  opens_before_minutes: number;
  closes_after_minutes: number;
  grade_level?: string;
  display_name?: string;
  fees_amount?: number;
  students_count?: number;
  active_students_count?: number;
  disabled_students_count?: number;
  deleted_students_count?: number;
  schedules?: Array<{
    id: number;
    day_of_week: number;
    start_time: string;
    end_time: string;
    opens_before_minutes: number;
    closes_after_minutes: number;
    is_active: boolean;
  }>;
};

type AdminStudent = {
  id: number;
  group_id: number;
  student_code: string;
  full_name: string;
  phone?: string | null;
  guardian_phone: string;
  gender?: "male" | "female" | "unknown";
  group_name: string;
  is_active: boolean;
  student_serial?: string;
  scan_serial?: string;
  qr_token?: string;
  grade?: string;
  grade_level?: string;
  deleted_at?: string | null;
  purge_after?: string | null;
};

type SiteSlug = "about-teacher" | "about-center" | "contact" | "tips";
type AdminTab = "overview" | "add-user" | "users" | "site-content" | "students" | "groups" | "attendance" | "scanner" | "fees" | "exams" | "inbox" | "audit-logs";

type SitePage = {
  slug: SiteSlug;
  title_ar: string;
  title_en: string;
  subtitle_ar: string;
  subtitle_en: string;
  content_ar: Record<string, any>;
  content_en: Record<string, any>;
  updated_at?: string;
};

const translations = {
  ar: {
    "site.name": "مستر أحمد عبدربه",
    "site.description": "مدرس العلوم",
    "site.mark": "ع",
    "nav.studentLogin": "دخول الطالب",
    "nav.teacherLogin": "دخول المستر",
    "nav.aboutTeacher": "عن المستر",
    "nav.aboutCenter": "عن السنتر",
    "nav.contact": "التواصل",
    "nav.tips": "نصائح",
    "public.statExperience": "سنوات الخبرة",
    "public.teachingStyle": "طريقة الشرح",
    "public.results": "نتائج ومؤشرات",
    "public.availableGroups": "المجموعات المتاحة",
    "public.features": "مميزات السنتر",
    "public.address": "العنوان",
    "public.loading": "جاري تحميل المحتوى...",
    "contact.whatsapp": "واتساب",
    "contact.facebook": "فيسبوك",
    "contact.youtube": "يوتيوب",
    "contact.name": "الاسم",
    "contact.phone": "رقم الهاتف",
    "contact.message": "رسالتك",
    "contact.send": "إرسال",
    "contact.success": "تم إرسال الرسالة بنجاح.",
    "home.eyebrow": "منصة حضور الطلاب",
    "home.title": "أهلاً وسهلاً بكم",
    "home.subtitle": "أدخل كود الطالب لتسجيل حضور حصة اليوم",
    "student.loginTitle": "دخول الطلاب",
    "student.codeLabel": "كود الطالب",
    "student.codePlaceholder": "أدخل كود الطالب",
    "student.enterButton": "دخول",
    "student.enteringButton": "جاري الدخول...",
    "student.findCodeButton": "معرفة كود الطالب",
    "student.lookupTitle": "معرفة كود الطالب",
    "student.lookupHelp": "أدخل الرقم القومي أو رقم ولي الأمر للاستعلام مؤقتا.",
    "student.lookupPlaceholder": "الرقم القومي أو رقم ولي الأمر",
    "student.lookupButton": "استعلام عن الكود",
    "student.lookupLoading": "جاري الاستعلام...",
    "student.lookupResult": "الاستعلام التجريبي: A1001",
    "student.lookupFound": "كود الطالب: {{code}}",
    "student.lookupNotFound": "لم يتم العثور على كود مطابق.",
    "student.copyCode": "نسخ الكود",
    "student.codeCopied": "تم نسخ الكود",
    "student.copyFailed": "تعذر نسخ الكود. اضغط مطولاً على الكود لنسخه.",
    "student.close": "إغلاق",
    "student.logout": "تسجيل الخروج",
    "teacher.loginTitle": "دخول المستر",
    "teacher.usernameLabel": "اسم المستخدم أو البريد الإلكتروني",
    "teacher.usernamePlaceholder": "teacher أو teacher@abdrabo.local",
    "teacher.passwordLabel": "كلمة المرور",
    "teacher.passwordPlaceholder": "أدخل كلمة المرور",
    "teacher.loginButton": "دخول",
    "teacher.loggingInButton": "جاري الدخول...",
    "teacher.logout": "خروج المستر",
    "teacher.dashboardTitle": "لوحة المستر",
    "teacher.dashboardSubtitle": "إدارة الحضور والطلاب والدرجات ستتوسع في الإصدارات القادمة.",
    "teacher.account": "الحساب",
    "teacher.role": "الدور",
    "teacher.serviceAvailable": "متاح الآن",
    "teacher.protectedMessage": "هذه الصفحة محمية وتتطلب جلسة مستر صالحة.",
    "teacher.loginFailed": "بيانات الدخول غير صحيحة.",
    "admin.tabs.overview": "الرئيسية",
    "admin.tabs.addUser": "إضافة مستخدم",
    "admin.tabs.users": "المستخدمون",
    "admin.tabs.siteContent": "محتوى الموقع",
    "admin.tabs.students": "الطلاب",
    "admin.tabs.groups": "المجموعات",
    "admin.tabs.attendance": "الحضور",
    "admin.tabs.scanner": "الماسح",
    "scanner.inputLabel": "امسح باركود الليبل أو رمز QR",
    "scanner.inputPlaceholder": "امسح الليبل هنا",
    "scanner.submit": "تسجيل الحضور",
    "scanner.recorded": "تم تسجيل الحضور بنجاح",
    "scanner.invalidCode": "لم يتم العثور على طالب بهذا الليبل.",
    "scanner.scanRequired": "لم يتم استقبال بيانات من الاسكانر.",
    "scanner.profileOpened": "تم فتح الملف الشخصي للطالب.",
    "scanner.scanProfilePlaceholder": "امسح الليبل لفتح الملف الشخصي",
    "scanner.inactiveStudent": "هذا الطالب غير مفعل.",
    "scanner.closedSession": "لا توجد حصة مفتوحة لهذه المجموعة الآن.",
    "scanner.duplicate": "تم تسجيل حضور هذا الطالب بالفعل.",
    "scanner.networkError": "تعذر الاتصال بالخادم. تحقق من الإنترنت وحاول مرة أخرى.",
    "scanner.serverError": "حدث خطأ أثناء تسجيل الحضور. حاول مرة أخرى.",
    "admin.tabs.fees": "المصروفات",
    "admin.tabs.exams": "الامتحانات",
    "admin.tabs.inbox": "الرسائل",
    "admin.tabs.auditLogs": "سجل النشاط",
    "inbox.title": "الرسائل",
    "inbox.newMessage": "رسالة جديدة",
    "inbox.subject": "الموضوع",
    "inbox.message": "الرسالة",
    "inbox.send": "إرسال",
    "inbox.reply": "رد",
    "inbox.unread": "غير مقروءة",
    "inbox.read": "مقروءة",
    "inbox.refresh": "تحديث",
    "inbox.refreshing": "جاري التحديث...",
    "inbox.markRead": "تحديد كمقروء",
    "inbox.markingRead": "جاري التحديد...",
    "inbox.markedRead": "تم تحديد الرسائل كمقروءة.",
    "inbox.all": "الكل",
    "inbox.search": "بحث باسم الطالب أو المسلسل أو المجموعة",
    "inbox.date": "التاريخ",
    "inbox.showing": "الرسائل",
    "inbox.noMessages": "لا توجد رسائل بعد.",
    "inbox.sent": "تم إرسال الرسالة.",
    "inbox.sending": "جاري الإرسال...",
    "inbox.sentStatus": "تم الإرسال",
    "inbox.loadFailed": "تعذر تحميل الرسائل. حاول مرة أخرى.",
    "inbox.sendFailed": "تعذر إرسال الرسالة. حاول مرة أخرى.",
    "inbox.markReadFailed": "تعذر تحديد الرسالة كمقروءة. حاول مرة أخرى.",
    "inbox.selectThread": "اختر محادثة لعرض الرسائل.",
    "inbox.deleteMessage": "حذف الرسالة",
    "inbox.confirmDeleteMessage": "هل أنت متأكد من حذف هذه الرسالة؟",
    "inbox.permission": "السماح للمساعد باستخدام الرسائل",
    "attendance.noRealSessions": "لا توجد حصص حقيقية لهذا اليوم.",
    "fees.title": "المصروفات",
    "fees.newPayment": "دفع جديد",
    "fees.advancePayment": "دفع مقدما",
    "fees.advanceTitle": "دفع مقدما",
    "fees.advanceMonths": "اختر الأشهر المستقبلية",
    "fees.advanceSelected": "الأشهر المختارة",
    "fees.advanceTotal": "إجمالي الدفع المقدم",
    "fees.advanceConfirm": "هل تريد تأكيد دفع الأشهر المحددة مقدماً؟",
    "fees.advanceSaved": "تم تسجيل الدفع المقدم بنجاح.",
    "fees.advanceNoMonths": "لا توجد أشهر متاحة للدفع مقدماً.",
    "fees.advanceFailed": "تعذر تسجيل الدفع المقدم.",
    "fees.advanceAlreadyPaid": "هذا الشهر مدفوع بالفعل.",
    "fees.advanceCurrentMonthUnpaid": "يجب سداد الشهر الحالي أولاً قبل الدفع مقدماً.",
    "fees.dueMonth": "الشهر المستحق: {{months}}",
    "fees.dueMonths": "الأشهر المستحقة: {{months}}",
    "fees.advancePaymentLabel": "دفع مقدم",
    "fees.paymentType": "نوع الدفع",
    "fees.normalPayment": "دفع عادي",
    "fees.paidPayments": "المدفوع",
    "fees.latePayments": "المتأخر",
    "fees.scanStudent": "امسح مسلسل الطالب أو رمز QR",
    "fees.find": "بحث",
    "fees.required": "المطلوب حتى الآن",
    "fees.paid": "المدفوع",
    "fees.remaining": "المتبقي",
    "fees.payFull": "دفع المبلغ الكامل",
    "fees.fullOnly": "الدفع الكامل فقط — لا يوجد دفع جزئي في الإصدار الأول.",
    "fees.paymentRecorded": "تم تسجيل الدفع.",
    "fees.studentNotFound": "الطالب غير موجود.",
    "fees.alreadyPaid": "تم سداد المصروفات بالفعل.",
    "fees.noOutstanding": "لا توجد مصروفات مستحقة لهذا الطالب.",
    "fees.paymentFailed": "تعذر إتمام الدفع. حاول مرة أخرى.",
    "fees.paidStudentName": "الاسم: {{name}}",
    "fees.paidStudentStatus": "الحالة: مدفوع",
    "fees.monthsCovered": "الأشهر المغطاة",
    "fees.noMatchingResults": "لا توجد نتائج مطابقة للبحث.",
    "fees.reports": "التقارير",
    "fees.dateFrom": "من تاريخ",
    "fees.dateTo": "إلى تاريخ",
    "fees.today": "اليوم",
    "fees.thisMonth": "هذا الشهر",
    "fees.reportSearch": "بحث بالاسم أو الكود أو السريال أو الهاتف أو المجموعة أو الرقم القومي",
    "fees.groupFilter": "المجموعة",
    "fees.gradeFilter": "الصف الدراسي",
    "fees.exportExcel": "تصدير Excel",
    "fees.totalPaid": "إجمالي المدفوع",
    "fees.paymentCount": "عدد المدفوعات",
    "fees.paymentDate": "تاريخ الدفع",
    "fees.paymentTime": "وقت الدفع",
    "fees.coveredMonth": "الشهر المغطى",
    "fees.amount": "المبلغ",
    "fees.paidBy": "تم الدفع بواسطة",
    "fees.lateReport": "تقرير المتأخرات حسب دورة الفاتورة",
    "fees.includeDisabled": "تضمين الطلاب المعطلين",
    "fees.lateStudentCount": "عدد الطلاب المتأخرين",
    "fees.totalExpectedUnpaid": "إجمالي المتوقع تحصيله",
    "fees.lastPaymentDate": "آخر تاريخ دفع",
    "fees.reportLoadFailed": "تعذر تحميل التقرير.",
    "fees.reversePayment": "عكس الدفعة",
    "fees.confirmReversal": "تأكيد عكس الدفعة",
    "fees.reversalSaved": "تم عكس الدفعة وتسجيل العملية.",
    "fees.reversalFailed": "تعذر عكس الدفعة.",
    "fees.showDeleted": "إظهار الطلاب المحذوفين",
    "audit.title": "سجل النشاط الكامل",
    "audit.pin": "الرقم السري المكون من 4 أرقام",
    "audit.adminPassword": "كلمة مرور المدير",
    "audit.unlock": "فتح سجل النشاط",
    "audit.setup": "إعداد الرقم السري",
    "audit.changePin": "تغيير الرقم السري",
    "audit.reason": "السبب",
    "audit.search": "بحث في السجل",
    "audit.action": "الإجراء",
    "audit.user": "المستخدم",
    "audit.payment": "رقم الدفعة",
    "audit.student": "رقم الطالب",
    "audit.dateFrom": "من تاريخ",
    "audit.dateTo": "إلى تاريخ",
    "audit.refresh": "تحديث",
    "audit.date": "التاريخ والوقت",
    "audit.details": "التفاصيل",
    "audit.noLogs": "لا توجد سجلات.",
    "audit.pinSaved": "تم حفظ الرقم السري.",
    "audit.locked": "تم إيقاف المحاولة مؤقتاً بسبب محاولات فاشلة.",
    "audit.invalidPin": "الرقم السري غير صحيح.",
    "audit.action.paymentCreated": "تم تسجيل دفع المصروفات",
    "audit.action.advancePaymentCreated": "تم تسجيل دفع مقدم",
    "audit.action.paymentReversed": "تم عكس دفعة",
    "audit.action.studentCreated": "تم إنشاء طالب",
    "audit.action.studentUpdated": "تم تعديل بيانات طالب",
    "audit.action.studentStatusChanged": "تم تغيير حالة طالب",
    "audit.action.studentRestored": "تم استرجاع طالب",
    "audit.action.studentArchived": "تم أرشفة طالب",
    "audit.action.attendanceRecorded": "تم تسجيل الحضور",
    "audit.action.messageAction": "تم تنفيذ إجراء على رسالة",
    "audit.action.noteAction": "تم تنفيذ إجراء على ملاحظة",
    "audit.action.pinChanged": "تم تغيير رقم سجل النشاط",
    "audit.action.logsUnlocked": "تم فتح سجل النشاط",
    "audit.action.pinFailed": "فشلت محاولة فتح سجل النشاط",
    "audit.action.systemRequest": "إجراء بالنظام",
    "audit.action.userCreated": "تم إنشاء مستخدم",
    "audit.action.userUpdated": "تم تعديل مستخدم",
    "audit.action.userPasswordReset": "تم تغيير كلمة مرور مستخدم",
    "audit.action.userStatusChanged": "تم تغيير حالة مستخدم",
    "audit.action.userArchived": "تمت أرشفة مستخدم",
    "audit.detail.body": "البيانات المرسلة",
    "audit.detail.path": "العملية",
    "audit.detail.query": "بيانات البحث",
    "audit.detail.method": "نوع الطلب",
    "audit.detail.statusCode": "نتيجة العملية",
    "audit.detail.accessDuration": "مدة فتح السجل",
    "audit.detail.reason": "السبب",
    "audit.detail.originalAmount": "المبلغ الأصلي",
    "audit.detail.paymentDate": "تاريخ الدفع",
    "audit.detail.paymentType": "نوع الدفع",
    "audit.detail.paymentMethod": "طريقة الدفع",
    "audit.detail.paymentMonths": "الأشهر المغطاة",
    "audit.detail.reversalId": "رقم عملية العكس",
    "audit.detail.locked": "تم إيقاف المحاولة",
    "audit.detail.pinDigits": "عدد أرقام الرقم السري",
    "audit.narrative.userCreated": "تم إنشاء المستخدم: {{name}} — اسم المستخدم: {{username}} — الدور: {{role}}",
    "audit.narrative.userUpdated": "تم تعديل المستخدم: {{name}} — اسم المستخدم: {{username}}",
    "audit.narrative.userPasswordReset": "تم تغيير كلمة مرور المستخدم: {{name}}",
    "audit.narrative.userArchived": "تم حذف المستخدم: {{name}}",
    "audit.narrative.student": "تم {{action}} الطالب: {{name}} — كود الطالب: {{code}}",
    "audit.narrative.payment": "تم تسجيل دفع مصروفات للطالب: {{name}} — الكود: {{code}} — المبلغ: {{amount}} جنيه",
    "audit.narrative.advancePayment": "تم تسجيل دفع مقدم للطالب: {{name}} — الكود: {{code}} — المبلغ: {{amount}} جنيه",
    "audit.narrative.reversed": "تم عكس الدفعة رقم {{payment}} للطالب: {{name}} — المبلغ: {{amount}} جنيه — السبب: {{reason}}",
    "audit.narrative.attendance": "تم تسجيل حضور الطالب: {{name}} — كود الطالب: {{code}}",
    "audit.narrative.generic": "تم تنفيذ إجراء: {{action}}",
    "audit.word.created": "إنشاء",
    "audit.word.updated": "تعديل",
    "audit.word.deleted": "حذف",
    "audit.word.restored": "استرجاع",
    "audit.word.statusChanged": "تغيير حالة",
    "admin.siteContent": "محتوى الموقع",
    "admin.selectPage": "اختر الصفحة",
    "admin.titleAr": "العنوان بالعربي",
    "admin.titleEn": "العنوان بالإنجليزي",
    "admin.subtitleAr": "الوصف بالعربي",
    "admin.subtitleEn": "الوصف بالإنجليزي",
    "admin.contentAr": "المحتوى بالعربي JSON",
    "admin.contentEn": "المحتوى بالإنجليزي JSON",
    "admin.save": "حفظ التعديلات",
    "admin.saving": "جاري الحفظ...",
    "admin.saved": "تم حفظ المحتوى.",
    "admin.invalidJson": "صيغة JSON غير صحيحة.",
    "admin.usersTeam": "المستخدمون",
    "admin.createUser": "إضافة مستخدم",
    "admin.editUser": "تعديل المستخدم",
    "admin.editGroup": "تعديل المجموعة",
    "admin.name": "الاسم",
    "admin.username": "اسم المستخدم",
    "admin.email": "البريد الإلكتروني",
    "admin.password": "كلمة المرور",
    "admin.role": "الدور",
    "admin.active": "نشط",
    "admin.groupActive": "المجموعة نشطة",
    "admin.disabled": "معطل",
    "admin.deleted": "محذوف",
    "admin.restore": "استرجاع",
    "admin.permanentDelete": "حذف نهائي",
    "admin.permanentDeleteConfirm": "سيتم حذف الطالب نهائياً ولا يمكن استرجاعه. هل أنت متأكد؟",
    "admin.purgeDaysLeft": "سيتم الحذف النهائي بعد {{days}} يوم",
    "admin.status": "الحالة",
    "admin.resetPassword": "إعادة تعيين كلمة المرور",
    "admin.disable": "تعطيل",
    "admin.enable": "تفعيل",
    "admin.create": "إنشاء",
    "admin.creating": "جاري الإنشاء...",
    "admin.created": "تم الإنشاء",
    "admin.update": "تحديث",
    "admin.updating": "جاري التحديث...",
    "admin.updated": "تم التحديث",
    "admin.cancel": "إلغاء",
    "admin.userSaved": "تم حفظ المستخدم.",
    "admin.passwordReset": "تم تحديث كلمة المرور.",
    "admin.adminOnly": "هذا القسم متاح للمدير فقط.",
    "admin.role.admin": "مدير",
    "admin.role.teacher": "مدرس",
    "admin.role.assistant": "مساعد",
    "admin.groupName": "اسم المجموعة",
    "admin.grade": "الصف الدراسي",
    "admin.subject": "المادة",
    "admin.dayOfWeek": "يوم الحصة",
    "admin.startTime": "وقت البداية",
    "admin.endTime": "وقت النهاية",
    "admin.opensBefore": "فتح الحضور قبل (دقائق)",
    "admin.closesAfter": "إغلاق الحضور بعد (دقائق)",
    "admin.center": "السنتر",
    "admin.studentName": "اسم الطالب",
    "admin.studentCode": "كود الطالب",
    "admin.fieldRequired": "هذا الحقل مطلوب.",
    "admin.studentCodeFormat": "كود الطالب يجب أن يكون مثل A1234",
    "admin.generateCodeSerial": "توليد الكود والسريال",
    "admin.labelDetails": "بيانات الليبل",
    "admin.loginCode": "كود الدخول",
    "admin.scanSerial": "السريال",
    "admin.labelPreview": "معاينة الليبل",
    "admin.printLabel": "طباعة الليبل",
    "admin.printingLabel": "جاري تجهيز الليبل...",
    "admin.regenerateScanSerialConfirm": "إعادة توليد السريال ستؤثر على الليبل المطبوع. هل تريد المتابعة؟",
    "admin.regenerateScanSerial": "إعادة توليد السريال",
    "admin.phone": "رقم الهاتف",
    "admin.guardianPhone": "رقم ولي الأمر",
    "admin.gender": "النوع",
    "admin.male": "ذكر",
    "admin.female": "أنثى",
    "admin.unknownGender": "غير محدد",
    "admin.nationalId": "الرقم القومي (اختياري)",
    "admin.selectGroup": "اختر المجموعة",
    "admin.showStudents": "إظهار الطلاب",
    "admin.hideStudents": "إخفاء الطلاب",
    "admin.selectStudent": "اختر الطالب",
    "admin.allGroups": "كل المجموعات",
    "admin.generateCode": "توليد كود",
    "admin.groupSaved": "تم حفظ المجموعة.",
    "admin.studentSaved": "تم حفظ الطالب. الكود: {{code}}",
    "admin.noGroups": "لا توجد مجموعات بعد.",
    "admin.noStudents": "لا يوجد طلاب بعد.",
    "admin.searchStudents": "ابحث باسم الطالب أو الكود أو الهاتف أو المجموعة",
    "admin.searchExamStudent": "ابحث بكود الطالب أو الاسم",
    "admin.selectedStudent": "الطالب المختار",
    "admin.selectedGroup": "المجموعة المختارة",
    "admin.viewProfile": "الملف الشخصي",
    "admin.studentProfile": "ملف الطالب",
    "admin.basicInfo": "البيانات الأساسية",
    "admin.attendanceSummary": "ملخص الحضور",
    "admin.totalSessions": "إجمالي الحصص",
    "admin.presentCount": "حاضر",
    "admin.absentCount": "غائب",
    "admin.attendancePercentage": "نسبة الحضور",
    "admin.attendanceRecords": "سجل الحضور",
    "admin.examHistory": "سجل الامتحانات",
    "admin.notes": "ملاحظات الطالب",
    "admin.addNote": "إضافة ملاحظة",
    "admin.editNote": "تعديل الملاحظة",
    "admin.deleteNote": "حذف الملاحظة",
    "admin.notePlaceholder": "اكتب ملاحظة عن الطالب",
    "admin.feesSummary": "ملخص المصروفات",
    "admin.monthlyFee": "المصروف الشهري",
    "admin.requiredFees": "إجمالي المطلوب",
    "admin.paidFees": "إجمالي المدفوع",
    "admin.remainingFees": "المتبقي",
    "admin.paymentHistory": "سجل المدفوعات",
    "admin.overdueMonths": "الشهور المتأخرة",
    "admin.profileMessages": "المحادثات والرسائل",
    "admin.profileLoading": "جار تحميل ملف الطالب...",
    "admin.profileLoadFailed": "تعذر تحميل ملف الطالب.",
    "admin.noProfileAttendance": "لا يوجد سجل حضور بعد.",
    "admin.noProfileExams": "لا توجد درجات امتحانات بعد.",
    "admin.examRecords": "سجل نتائج الامتحانات",
    "admin.noExamResults": "لا توجد نتائج امتحانات لهذا الطالب.",
    "admin.searchExamRecords": "ابحث بكود الطالب أو اسمه أو مجموعته",
    "admin.examRecordsShow": "إظهار النتائج",
    "admin.examRecordsHide": "إخفاء النتائج",
    "admin.editExamResult": "تعديل النتيجة",
    "admin.deleteExamResult": "مسح النتيجة",
    "admin.examTitle": "اسم الامتحان",
    "admin.examDate": "تاريخ الامتحان",
    "admin.maxScore": "الدرجة النهائية",
    "admin.studentScore": "درجة الطالب",
    "admin.assessment": "التقييم",
    "admin.assessmentPlaceholder": "اكتب تقييمًا مختصرًا للطالب",
    "admin.saveExamResult": "حفظ نتيجة الامتحان",
    "admin.examResultSaved": "تم حفظ نتيجة الامتحان والتقييم.",
    "admin.examResultDeleted": "تم مسح نتيجة الامتحان.",
    "admin.confirmDeleteExamResult": "هل تريد مسح نتيجة هذا الطالب؟",
    "admin.invalidExamResult": "راجع بيانات الامتحان والدرجة.",
    "admin.evaluationPreview": "التقييم التلقائي",
    "score.weak": "يحتاج إلى تحسين",
    "score.average": "متوسط الأداء",
    "score.good": "جيد",
    "score.veryGood": "جيد جدًا",
    "score.excellent": "امتياز",
    "admin.noProfileNotes": "لا توجد ملاحظات بعد.",
    "admin.noProfilePayments": "لا توجد مدفوعات بعد.",
    "admin.noProfileMessages": "لا توجد محادثات بعد.",
    "admin.invalidPayload": "أكمل البيانات المطلوبة.",
    "admin.invalidStudentCode": "كود الطالب يجب أن يكون مثل A1234",
    "admin.codeExists": "كود الطالب مستخدم بالفعل.",
    "errors.userRequired": "أكمل بيانات المستخدم المطلوبة.",
    "errors.passwordLength": "كلمة المرور يجب ألا تقل عن 8 أحرف.",
    "errors.userExists": "البريد الإلكتروني أو اسم المستخدم موجود بالفعل.",
    "errors.selfDisable": "لا يمكنك تعطيل حسابك الحالي",
    "errors.selfRole": "لا يمكنك تغيير دور حسابك الحالي من مدير.",
    "errors.lookupRequired": "أدخل الرقم أولا.",
    "errors.digitsOnly": "يُسمح بالأرقام فقط.",
    "errors.lookupLength": "يجب إدخال 11 رقمًا لرقم الموبايل أو 14 رقمًا للرقم القومي.",
    "errors.phoneLength": "يجب إدخال ١١ رقمًا لرقم الهاتف.",
    "errors.nationalIdLength": "يجب إدخال ١٤ رقمًا للرقم القومي.",
    "errors.codeRequired": "أدخل كود الطالب أولا.",
    "errors.loginFailed": "تعذر تسجيل الدخول.",
    "errors.locationUnsupported": "المتصفح لا يدعم تحديد الموقع.",
    "dashboard.eyebrow": "بوابة الطالب",
    "dashboard.welcome": "أهلاً يا {{name}}",
    "dashboard.todayClass": "حصة اليوم: {{subject}} - {{group}}",
    "dashboard.attendanceLabel": "حالة الحضور",
    "dashboard.attendanceTime": "وقت التسجيل: {{time}}",
    "dashboard.notCheckedIn": "لم يسجل بعد",
    "dashboard.studentCode": "كود الطالب",
    "dashboard.group": "المجموعة",
    "dashboard.lastScore": "آخر درجة",
    "dashboard.latestExamDate": "تاريخ الامتحان",
    "dashboard.latestExamPercentage": "النسبة",
    "dashboard.refresh": "تحديث البيانات",
    "dashboard.refreshing": "جاري التحديث...",
    "dashboard.refreshed": "تم تحديث البيانات",
    "dashboard.refreshFailed": "تعذر تحديث البيانات.",
    "dashboard.attendanceSuccess": "تم تسجيل حضورك بنجاح.",
    "dashboard.attendancePending": "تم تسجيل حضورك وهو قيد المراجعة.",
    "dashboard.noOpenSession": "لا توجد حصة مفتوحة الآن.",
    "dashboard.outsideRadius": "أنت خارج نطاق السنتر.",
    "dashboard.locationRequired": "يجب السماح بتحديد الموقع لتسجيل الحضور.",
    "dashboard.invalidStudent": "كود الطالب غير صحيح أو غير مفعل.",
    "dashboard.unknownStatus": "لم يتم تسجيل الحضور.",
    "dashboard.tabs.attendance": "الحضور والغياب",
    "dashboard.tabs.exams": "درجات الامتحانات",
    "dashboard.tabs.examResults": "نتائج الامتحانات والتقييمات",
    "dashboard.tabs.schedule": "جدول الحصص",
    "dashboard.tabs.homework": "الواجبات",
    "homework.noAvailable": "لا توجد واجبات حالياً.",
    "homework.loading": "جاري تحميل الواجبات...",
    "homework.loadError": "تعذر تحميل الواجبات. حاول مرة أخرى.",
    "homework.retry": "حاول مرة أخرى",
    "homework.description": "الوصف",
    "homework.dueDate": "تاريخ التسليم",
    "homework.status.new": "جديد",
    "homework.status.submitted": "تم التسليم",
    "homework.status.late": "متأخر",
    "homework.attachment": "المرفق أو الرابط",
    "dashboard.tabs.notes": "الملاحظات",
    "notes.title": "الملاحظات",
    "notes.add": "إضافة ملاحظة",
    "notes.edit": "تعديل الملاحظة",
    "notes.delete": "حذف الملاحظة",
    "notes.read": "مقروءة",
    "notes.unread": "غير مقروءة",
    "notes.noAvailable": "لا توجد ملاحظات متاحة.",
    "notes.refresh": "تحديث",
    "notes.loadError": "تعذر تحميل الملاحظات.",
    "dashboard.tabs.fees": "المصروفات",
    "studentFees.title": "المصروفات",
    "studentFees.monthlyFee": "المصروف الشهري",
    "studentFees.currentCycleFee": "مصروف الشهر الحالي",
    "studentFees.currentCyclePaid": "المدفوع في الشهر الحالي",
    "studentFees.currentCycleOutstanding": "المتبقي للشهر الحالي",
    "studentFees.unpaidMonths": "الأشهر غير المدفوعة",
    "studentFees.monthCountSingular": "{{count}} شهر",
    "studentFees.monthCountPlural": "{{count}} أشهر",
    "studentFees.totalRemaining": "إجمالي المتبقي",
    "studentFees.currentMonth": "الشهر الحالي",
    "studentFees.historicalPaid": "إجمالي المدفوع تاريخياً",
    "studentFees.required": "إجمالي المستحق حتى الآن",
    "studentFees.paid": "إجمالي المدفوع",
    "studentFees.remaining": "المتبقي",
    "studentFees.status": "حالة السداد",
    "studentFees.paidStatus": "مدفوع",
    "studentFees.unpaidStatus": "غير مدفوع",
    "studentFees.overdueStatus": "متأخر",
    "studentFees.history": "سجل المدفوعات",
    "studentFees.date": "التاريخ",
    "studentFees.time": "الوقت",
    "studentFees.amount": "المبلغ",
    "studentFees.paidBy": "تم الدفع بواسطة",
    "studentFees.coveredCycle": "الشهر / دورة الفوترة",
    "studentFees.notes": "ملاحظات",
    "studentFees.noHistory": "لا توجد مدفوعات مسجلة.",
    "studentFees.loadError": "تعذر تحميل بيانات المصروفات.",
    "dashboard.currentTime": "الوقت الحالي",
    "table.class": "الحصة",
    "table.date": "التاريخ",
    "table.checkinTime": "وقت التسجيل",
    "table.status": "الحالة",
    "table.exam": "الامتحان",
    "table.score": "الدرجة",
    "table.assessment": "التقييم",
    "table.note": "ملاحظة",
    "table.day": "اليوم",
    "table.subject": "المادة",
    "table.group": "المجموعة",
    "table.time": "الوقت",
    "attendance.present": "حاضر",
    "attendance.absent": "غائب",
    "attendance.notMarked": "لم يتم التحديد",
    "attendance.pendingReview": "قيد المراجعة",
    "attendance.updated": "تم تحديث الحضور.",
    "attendance.alreadyRegistered": "تم تسجيل حضور هذا الطالب بالفعل.",
    "attendance.updateFailed": "تعذر تحديث الحضور.",
    "empty.noData": "لا توجد بيانات حاليا.",
    "data.integratedScience": "العلوم",
    "data.saturdayGroup": "مجموعة السبت 6 مساء",
    "data.firstUnitExam": "امتحان الوحدة الأولى",
    "data.goodLevel": "مستوى جيد جدا",
    "data.homeworkOne": "حل أسئلة الدرس الأول",
    "data.required": "مطلوب",
    "data.noteOne": "يرجى إحضار كراسة العملي في الحصة القادمة.",
    "days.0": "الأحد",
    "days.1": "الاثنين",
    "days.2": "الثلاثاء",
    "days.3": "الأربعاء",
    "days.4": "الخميس",
    "days.5": "الجمعة",
    "days.6": "السبت"
  },
  en: {
    "site.name": "Mr. Ahmed Abdrabo",
    "site.description": "Science Teacher",
    "site.mark": "A",
    "nav.studentLogin": "Student Login",
    "nav.teacherLogin": "Teacher Login",
    "nav.aboutTeacher": "About Teacher",
    "nav.aboutCenter": "About Center",
    "nav.contact": "Contact",
    "nav.tips": "Tips",
    "public.statExperience": "Experience",
    "public.teachingStyle": "Teaching Style",
    "public.results": "Results & Stats",
    "public.availableGroups": "Available Groups",
    "public.features": "Center Features",
    "public.address": "Address",
    "public.loading": "Loading content...",
    "contact.whatsapp": "WhatsApp",
    "contact.facebook": "Facebook",
    "contact.youtube": "YouTube",
    "contact.name": "Name",
    "contact.phone": "Phone",
    "contact.message": "Message",
    "contact.send": "Send",
    "contact.success": "Message sent successfully.",
    "home.eyebrow": "Student Attendance Platform",
    "home.title": "Welcome",
    "home.subtitle": "Enter your student code to check in for today's class",
    "student.loginTitle": "Student Login",
    "student.codeLabel": "Student Code",
    "student.codePlaceholder": "Enter student code",
    "student.enterButton": "Enter",
    "student.enteringButton": "Signing in...",
    "student.findCodeButton": "Find Student Code",
    "student.lookupTitle": "Find Student Code",
    "student.lookupHelp": "Enter the national ID or guardian phone number for a temporary lookup.",
    "student.lookupPlaceholder": "National ID or guardian phone",
    "student.lookupButton": "Look up code",
    "student.lookupLoading": "Looking up...",
    "student.lookupResult": "Demo lookup result: A1001",
    "student.lookupFound": "Student code: {{code}}",
    "student.lookupNotFound": "No matching student code was found.",
    "student.copyCode": "Copy code",
    "student.codeCopied": "Code copied",
    "student.copyFailed": "Could not copy the code. Press and hold the code to copy it.",
    "student.close": "Close",
    "student.logout": "Logout",
    "teacher.loginTitle": "Teacher Login",
    "teacher.usernameLabel": "Username or Email",
    "teacher.usernamePlaceholder": "teacher or teacher@abdrabo.local",
    "teacher.passwordLabel": "Password",
    "teacher.passwordPlaceholder": "Enter password",
    "teacher.loginButton": "Login",
    "teacher.loggingInButton": "Logging in...",
    "teacher.logout": "Teacher Logout",
    "teacher.dashboardTitle": "Teacher Dashboard",
    "teacher.dashboardSubtitle": "Attendance, students, and exams management will expand in the next versions.",
    "teacher.account": "Account",
    "teacher.role": "Role",
    "teacher.serviceAvailable": "Available now",
    "teacher.protectedMessage": "This page is protected and requires a valid teacher session.",
    "teacher.loginFailed": "Invalid login credentials.",
    "admin.tabs.overview": "Overview",
    "admin.tabs.addUser": "Add User",
    "admin.tabs.users": "Users",
    "admin.tabs.siteContent": "Site Content",
    "admin.tabs.students": "Students",
    "admin.tabs.groups": "Groups",
    "admin.tabs.attendance": "Attendance",
    "admin.tabs.scanner": "Scanner",
    "scanner.inputLabel": "Scan the label barcode or QR code",
    "scanner.inputPlaceholder": "Scan the label here",
    "scanner.submit": "Record attendance",
    "scanner.recorded": "Attendance recorded successfully",
    "scanner.invalidCode": "No student was found for this label.",
    "scanner.scanRequired": "No data was received from the scanner.",
    "scanner.profileOpened": "The student profile was opened.",
    "scanner.scanProfilePlaceholder": "Scan the label to open the profile",
    "scanner.inactiveStudent": "This student is inactive.",
    "scanner.closedSession": "There is no open class for this group right now.",
    "scanner.duplicate": "This student’s attendance was already recorded.",
    "scanner.networkError": "Could not connect to the server. Check the internet and try again.",
    "scanner.serverError": "An error occurred while recording attendance. Try again.",
    "admin.tabs.fees": "Fees",
    "admin.tabs.exams": "Exams",
    "admin.tabs.inbox": "Inbox",
    "admin.tabs.auditLogs": "Audit Logs",
    "inbox.title": "Inbox",
    "inbox.newMessage": "New message",
    "inbox.subject": "Subject",
    "inbox.message": "Message",
    "inbox.send": "Send",
    "inbox.reply": "Reply",
    "inbox.unread": "Unread",
    "inbox.read": "Read",
    "inbox.refresh": "Refresh",
    "inbox.refreshing": "Refreshing...",
    "inbox.markRead": "Mark as read",
    "inbox.markingRead": "Marking...",
    "inbox.markedRead": "Messages marked as read.",
    "inbox.all": "All",
    "inbox.search": "Search by student, serial, or group",
    "inbox.date": "Date",
    "inbox.showing": "Messages",
    "inbox.noMessages": "No messages yet.",
    "inbox.sent": "Message sent.",
    "inbox.sending": "Sending...",
    "inbox.sentStatus": "Sent",
    "inbox.loadFailed": "Could not load messages. Please try again.",
    "inbox.sendFailed": "Could not send the message. Please try again.",
    "inbox.markReadFailed": "Could not mark the message as read. Please try again.",
    "inbox.selectThread": "Select a conversation to view messages.",
    "inbox.deleteMessage": "Delete message",
    "inbox.confirmDeleteMessage": "Are you sure you want to delete this message?",
    "inbox.permission": "Allow assistant to use Inbox",
    "attendance.noRealSessions": "No real class sessions for this date.",
    "fees.title": "Fees",
    "fees.newPayment": "New Payment",
    "fees.advancePayment": "Advance Payment",
    "fees.advanceTitle": "Advance Payment",
    "fees.advanceMonths": "Select future months",
    "fees.advanceSelected": "Selected months",
    "fees.advanceTotal": "Advance payment total",
    "fees.advanceConfirm": "Confirm advance payment for the selected months?",
    "fees.advanceSaved": "Advance payment recorded successfully.",
    "fees.advanceNoMonths": "No future months are available for advance payment.",
    "fees.advanceFailed": "Advance payment could not be recorded.",
    "fees.advanceAlreadyPaid": "This month is already paid.",
    "fees.advanceCurrentMonthUnpaid": "The current month must be paid before making an advance payment.",
    "fees.dueMonth": "Due month: {{months}}",
    "fees.dueMonths": "Due months: {{months}}",
    "fees.advancePaymentLabel": "Advance payment",
    "fees.paymentType": "Payment type",
    "fees.normalPayment": "Normal payment",
    "fees.paidPayments": "Paid Payments",
    "fees.latePayments": "Late Payments",
    "fees.scanStudent": "Scan student serial or QR code",
    "fees.find": "Find",
    "fees.required": "Required so far",
    "fees.paid": "Paid",
    "fees.remaining": "Remaining",
    "fees.payFull": "Pay full amount",
    "fees.fullOnly": "Full payment only — partial payments are not available in V1.",
    "fees.paymentRecorded": "Payment recorded.",
    "fees.studentNotFound": "Student not found.",
    "fees.alreadyPaid": "Fees already paid.",
    "fees.noOutstanding": "No outstanding fees for this student.",
    "fees.paymentFailed": "Payment could not be completed. Please try again.",
    "fees.paidStudentName": "Name: {{name}}",
    "fees.paidStudentStatus": "Status: Paid",
    "fees.monthsCovered": "Months covered",
    "fees.noMatchingResults": "No matching results found.",
    "fees.reports": "Reports",
    "fees.dateFrom": "Date from",
    "fees.dateTo": "Date to",
    "fees.today": "Today",
    "fees.thisMonth": "This month",
    "fees.reportSearch": "Search name, code, serial, phone, group, or national ID",
    "fees.groupFilter": "Group",
    "fees.gradeFilter": "Grade level",
    "fees.exportExcel": "Export Excel",
    "fees.totalPaid": "Total paid",
    "fees.paymentCount": "Number of payments",
    "fees.paymentDate": "Payment date",
    "fees.paymentTime": "Payment time",
    "fees.coveredMonth": "Covered month",
    "fees.amount": "Amount",
    "fees.paidBy": "Paid by",
    "fees.lateReport": "Late payments by billing cycle",
    "fees.includeDisabled": "Include disabled students",
    "fees.lateStudentCount": "Late student count",
    "fees.totalExpectedUnpaid": "Total expected unpaid",
    "fees.lastPaymentDate": "Last payment date",
    "fees.reportLoadFailed": "Could not load the report.",
    "fees.reversePayment": "Reverse payment",
    "fees.confirmReversal": "Confirm reversal",
    "fees.reversalSaved": "Payment reversed and recorded.",
    "fees.reversalFailed": "Could not reverse the payment.",
    "fees.showDeleted": "Show deleted students",
    "audit.title": "Complete Audit Logs",
    "audit.pin": "4-digit audit PIN",
    "audit.adminPassword": "Admin password",
    "audit.unlock": "Unlock audit logs",
    "audit.setup": "Set audit PIN",
    "audit.changePin": "Change PIN",
    "audit.reason": "Reason",
    "audit.search": "Search logs",
    "audit.action": "Action",
    "audit.user": "User",
    "audit.payment": "Payment ID",
    "audit.student": "Student ID",
    "audit.dateFrom": "Date from",
    "audit.dateTo": "Date to",
    "audit.refresh": "Refresh",
    "audit.date": "Date and time",
    "audit.details": "Details",
    "audit.noLogs": "No audit logs found.",
    "audit.pinSaved": "PIN saved.",
    "audit.locked": "Access is temporarily locked after failed attempts.",
    "audit.invalidPin": "The PIN is incorrect.",
    "audit.action.paymentCreated": "Payment recorded",
    "audit.action.advancePaymentCreated": "Advance payment recorded",
    "audit.action.paymentReversed": "Payment reversed",
    "audit.action.studentCreated": "Student created",
    "audit.action.studentUpdated": "Student updated",
    "audit.action.studentStatusChanged": "Student status changed",
    "audit.action.studentRestored": "Student restored",
    "audit.action.studentArchived": "Student archived",
    "audit.action.attendanceRecorded": "Attendance recorded",
    "audit.action.messageAction": "Message action",
    "audit.action.noteAction": "Note action",
    "audit.action.pinChanged": "Audit PIN changed",
    "audit.action.logsUnlocked": "Audit logs unlocked",
    "audit.action.pinFailed": "Audit PIN attempt failed",
    "audit.action.systemRequest": "System action",
    "audit.action.userCreated": "User created",
    "audit.action.userUpdated": "User updated",
    "audit.action.userPasswordReset": "User password changed",
    "audit.action.userStatusChanged": "User status changed",
    "audit.action.userArchived": "User archived",
    "audit.detail.body": "Submitted data",
    "audit.detail.path": "Operation",
    "audit.detail.query": "Search parameters",
    "audit.detail.method": "Request method",
    "audit.detail.statusCode": "Result",
    "audit.detail.accessDuration": "Access duration",
    "audit.detail.reason": "Reason",
    "audit.detail.originalAmount": "Original amount",
    "audit.detail.paymentDate": "Payment date",
    "audit.detail.paymentType": "Payment type",
    "audit.detail.paymentMethod": "Payment method",
    "audit.detail.paymentMonths": "Covered months",
    "audit.detail.reversalId": "Reversal ID",
    "audit.detail.locked": "Attempt locked",
    "audit.detail.pinDigits": "PIN digit count",
    "audit.narrative.userCreated": "User created: {{name}} — Username: {{username}} — Role: {{role}}",
    "audit.narrative.userUpdated": "User updated: {{name}} — Username: {{username}}",
    "audit.narrative.userPasswordReset": "User password changed: {{name}}",
    "audit.narrative.userArchived": "User deleted: {{name}}",
    "audit.narrative.student": "Student {{action}}: {{name}} — Student code: {{code}}",
    "audit.narrative.payment": "Payment recorded for student: {{name}} — Code: {{code}} — Amount: {{amount}} EGP",
    "audit.narrative.advancePayment": "Advance payment recorded for student: {{name}} — Code: {{code}} — Amount: {{amount}} EGP",
    "audit.narrative.reversed": "Payment #{{payment}} reversed for student: {{name}} — Amount: {{amount}} EGP — Reason: {{reason}}",
    "audit.narrative.attendance": "Attendance recorded for student: {{name}} — Student code: {{code}}",
    "audit.narrative.generic": "Action completed: {{action}}",
    "audit.word.created": "created",
    "audit.word.updated": "updated",
    "audit.word.deleted": "deleted",
    "audit.word.restored": "restored",
    "audit.word.statusChanged": "status changed",
    "admin.siteContent": "Site Content",
    "admin.selectPage": "Select Page",
    "admin.titleAr": "Arabic Title",
    "admin.titleEn": "English Title",
    "admin.subtitleAr": "Arabic Subtitle",
    "admin.subtitleEn": "English Subtitle",
    "admin.contentAr": "Arabic Content JSON",
    "admin.contentEn": "English Content JSON",
    "admin.save": "Save Changes",
    "admin.saving": "Saving...",
    "admin.saved": "Content saved.",
    "admin.invalidJson": "Invalid JSON format.",
    "admin.usersTeam": "Users / Team",
    "admin.createUser": "Create User",
    "admin.editUser": "Edit User",
    "admin.editGroup": "Edit Group",
    "admin.name": "Name",
    "admin.username": "Username",
    "admin.email": "Email",
    "admin.password": "Password",
    "admin.role": "Role",
    "admin.active": "Active",
    "admin.groupActive": "Group active",
    "admin.disabled": "Disabled",
    "admin.deleted": "Deleted",
    "admin.restore": "Restore",
    "admin.permanentDelete": "Permanent Delete",
    "admin.permanentDeleteConfirm": "This student will be permanently deleted and cannot be restored. Are you sure?",
    "admin.purgeDaysLeft": "Permanent deletion in {{days}} days",
    "admin.status": "Status",
    "admin.resetPassword": "Reset Password",
    "admin.disable": "Disable",
    "admin.enable": "Enable",
    "admin.create": "Create",
    "admin.creating": "Creating in progress",
    "admin.created": "Created",
    "admin.update": "Update",
    "admin.updating": "Updating...",
    "admin.updated": "Updated",
    "admin.cancel": "Cancel",
    "admin.userSaved": "User saved.",
    "admin.passwordReset": "Password updated.",
    "admin.adminOnly": "This section is available to admins only.",
    "admin.role.admin": "Admin",
    "admin.role.teacher": "Teacher",
    "admin.role.assistant": "Assistant",
    "admin.groupName": "Group name",
    "admin.grade": "Grade",
    "admin.subject": "Subject",
    "admin.dayOfWeek": "Class day",
    "admin.startTime": "Start time",
    "admin.endTime": "End time",
    "admin.opensBefore": "Open attendance before (minutes)",
    "admin.closesAfter": "Close attendance after (minutes)",
    "admin.center": "Center",
    "admin.studentName": "Student name",
    "admin.studentCode": "Student code",
    "admin.fieldRequired": "This field is required.",
    "admin.studentCodeFormat": "Student code must look like A1234",
    "admin.generateCodeSerial": "Generate Code & Serial",
    "admin.labelDetails": "Label details",
    "admin.loginCode": "Student login code",
    "admin.scanSerial": "Scan serial",
    "admin.labelPreview": "Label preview",
    "admin.printLabel": "Print Label",
    "admin.printingLabel": "Preparing label...",
    "admin.regenerateScanSerialConfirm": "Regenerating the scan serial affects printed labels. Continue?",
    "admin.regenerateScanSerial": "Regenerate scan serial",
    "admin.phone": "Phone",
    "admin.guardianPhone": "Guardian phone",
    "admin.gender": "Gender",
    "admin.male": "Male",
    "admin.female": "Female",
    "admin.unknownGender": "Not specified",
    "admin.nationalId": "National ID (optional)",
    "admin.selectGroup": "Select group",
    "admin.showStudents": "Show students",
    "admin.hideStudents": "Hide students",
    "admin.selectStudent": "Select student",
    "admin.allGroups": "All groups",
    "admin.generateCode": "Generate code",
    "admin.groupSaved": "Group saved.",
    "admin.studentSaved": "Student saved. Code: {{code}}",
    "admin.noGroups": "No groups yet.",
    "admin.noStudents": "No students yet.",
    "admin.searchStudents": "Search by student name, code, phone, or group",
    "admin.searchExamStudent": "Search by student code or name",
    "admin.selectedStudent": "Selected student",
    "admin.selectedGroup": "Selected group",
    "admin.viewProfile": "Student profile",
    "admin.studentProfile": "Student profile",
    "admin.basicInfo": "Basic information",
    "admin.attendanceSummary": "Attendance summary",
    "admin.totalSessions": "Total sessions",
    "admin.presentCount": "Present",
    "admin.absentCount": "Absent",
    "admin.attendancePercentage": "Attendance percentage",
    "admin.attendanceRecords": "Attendance records",
    "admin.examHistory": "Exam history",
    "admin.notes": "Student notes",
    "admin.addNote": "Add note",
    "admin.editNote": "Edit note",
    "admin.deleteNote": "Delete note",
    "admin.notePlaceholder": "Write a note about this student",
    "admin.feesSummary": "Fees summary",
    "admin.monthlyFee": "Monthly fee",
    "admin.requiredFees": "Total required",
    "admin.paidFees": "Total paid",
    "admin.remainingFees": "Remaining balance",
    "admin.paymentHistory": "Payment history",
    "admin.overdueMonths": "Overdue months",
    "admin.profileMessages": "Conversations and messages",
    "admin.profileLoading": "Loading student profile...",
    "admin.profileLoadFailed": "Could not load the student profile.",
    "admin.noProfileAttendance": "No attendance records yet.",
    "admin.noProfileExams": "No exam results yet.",
    "admin.examRecords": "Exam result records",
    "admin.noExamResults": "No exam results for this student.",
    "admin.searchExamRecords": "Search by student code, name, or group",
    "admin.examRecordsShow": "Show results",
    "admin.examRecordsHide": "Hide results",
    "admin.editExamResult": "Edit result",
    "admin.deleteExamResult": "Delete result",
    "admin.examTitle": "Exam title",
    "admin.examDate": "Exam date",
    "admin.maxScore": "Maximum score",
    "admin.studentScore": "Student score",
    "admin.assessment": "Assessment",
    "admin.assessmentPlaceholder": "Write a short assessment for the student",
    "admin.saveExamResult": "Save exam result",
    "admin.examResultSaved": "Exam result and assessment saved.",
    "admin.examResultDeleted": "Exam result deleted.",
    "admin.confirmDeleteExamResult": "Delete this student's exam result?",
    "admin.invalidExamResult": "Review the exam details and score.",
    "admin.evaluationPreview": "Automatic evaluation",
    "score.weak": "Needs improvement",
    "score.average": "Average performance",
    "score.good": "Good",
    "score.veryGood": "Very good",
    "score.excellent": "Excellent",
    "admin.noProfileNotes": "No notes yet.",
    "admin.noProfilePayments": "No payments yet.",
    "admin.noProfileMessages": "No conversations yet.",
    "admin.invalidPayload": "Complete the required details.",
    "admin.invalidStudentCode": "Student code must look like A1234",
    "admin.codeExists": "Student code is already in use.",
    "errors.userRequired": "Complete the required user details.",
    "errors.passwordLength": "Password must be at least 8 characters.",
    "errors.userExists": "Email or username already exists.",
    "errors.selfDisable": "You cannot disable your own account",
    "errors.selfRole": "You cannot change your own admin role.",
    "errors.lookupRequired": "Enter the number first.",
    "errors.digitsOnly": "Digits only are allowed.",
    "errors.lookupLength": "Please enter an 11-digit mobile number or a 14-digit national ID.",
    "errors.phoneLength": "Phone number must contain exactly 11 digits.",
    "errors.nationalIdLength": "National ID must contain exactly 14 digits.",
    "errors.codeRequired": "Enter the student code first.",
    "errors.loginFailed": "Unable to sign in.",
    "errors.locationUnsupported": "This browser does not support location access.",
    "dashboard.eyebrow": "Student Portal",
    "dashboard.welcome": "Welcome, {{name}}",
    "dashboard.todayClass": "Today's class: {{subject}} - {{group}}",
    "dashboard.attendanceLabel": "Attendance Status",
    "dashboard.attendanceTime": "Check-in time: {{time}}",
    "dashboard.notCheckedIn": "Not checked in yet",
    "dashboard.studentCode": "Student Code",
    "dashboard.group": "Group",
    "dashboard.lastScore": "Latest Score",
    "dashboard.latestExamDate": "Exam date",
    "dashboard.latestExamPercentage": "Percentage",
    "dashboard.refresh": "Refresh data",
    "dashboard.refreshing": "Refreshing...",
    "dashboard.refreshed": "Data updated",
    "dashboard.refreshFailed": "Could not refresh the data.",
    "dashboard.attendanceSuccess": "Your attendance has been recorded successfully.",
    "dashboard.attendancePending": "Your attendance has been recorded and is pending review.",
    "dashboard.noOpenSession": "There is no open class right now.",
    "dashboard.outsideRadius": "You are outside the center range.",
    "dashboard.locationRequired": "Location access is required to record attendance.",
    "dashboard.invalidStudent": "The student code is invalid or inactive.",
    "dashboard.unknownStatus": "Attendance was not recorded.",
    "dashboard.tabs.attendance": "Attendance",
    "dashboard.tabs.exams": "Exam Scores",
    "dashboard.tabs.examResults": "Exam Results & Assessments",
    "dashboard.tabs.schedule": "Class Schedule",
    "dashboard.tabs.homework": "Homework",
    "homework.noAvailable": "No homework available right now.",
    "homework.loading": "Loading homework...",
    "homework.loadError": "Could not load homework. Please try again.",
    "homework.retry": "Try again",
    "homework.description": "Description",
    "homework.dueDate": "Due date",
    "homework.status.new": "New",
    "homework.status.submitted": "Submitted",
    "homework.status.late": "Late",
    "homework.attachment": "Attachment or link",
    "dashboard.tabs.notes": "Notes",
    "notes.title": "Notes",
    "notes.add": "Add note",
    "notes.edit": "Edit note",
    "notes.delete": "Delete note",
    "notes.read": "Read",
    "notes.unread": "Unread",
    "notes.noAvailable": "No notes available.",
    "notes.refresh": "Refresh",
    "notes.loadError": "Failed to load notes.",
    "dashboard.tabs.fees": "Fees",
    "studentFees.title": "Fees",
    "studentFees.monthlyFee": "Monthly fee",
    "studentFees.currentCycleFee": "Current cycle fee",
    "studentFees.currentCyclePaid": "Paid this cycle",
    "studentFees.currentCycleOutstanding": "Current cycle outstanding",
    "studentFees.unpaidMonths": "Unpaid months",
    "studentFees.monthCountSingular": "{{count}} month",
    "studentFees.monthCountPlural": "{{count}} months",
    "studentFees.totalRemaining": "Total remaining",
    "studentFees.currentMonth": "Current month",
    "studentFees.historicalPaid": "Total historical payments",
    "studentFees.required": "Total due to date",
    "studentFees.paid": "Total paid",
    "studentFees.remaining": "Remaining",
    "studentFees.status": "Payment status",
    "studentFees.paidStatus": "Paid",
    "studentFees.unpaidStatus": "Unpaid",
    "studentFees.overdueStatus": "Overdue",
    "studentFees.history": "Payment history",
    "studentFees.date": "Date",
    "studentFees.time": "Time",
    "studentFees.amount": "Amount",
    "studentFees.paidBy": "Paid by",
    "studentFees.coveredCycle": "Covered month / billing cycle",
    "studentFees.notes": "Notes",
    "studentFees.noHistory": "No payments recorded.",
    "studentFees.loadError": "Could not load fee data.",
    "dashboard.currentTime": "Current Time",
    "table.class": "Class",
    "table.date": "Date",
    "table.checkinTime": "Check-in Time",
    "table.status": "Status",
    "table.exam": "Exam",
    "table.score": "Score",
    "table.assessment": "Assessment",
    "table.note": "Note",
    "table.day": "Day",
    "table.subject": "Subject",
    "table.group": "Group",
    "table.time": "Time",
    "attendance.present": "Present",
    "attendance.absent": "Absent",
    "attendance.notMarked": "Not marked",
    "attendance.pendingReview": "Pending review",
    "attendance.updated": "Attendance updated.",
    "attendance.alreadyRegistered": "This student is already marked present.",
    "attendance.updateFailed": "Could not update attendance.",
    "empty.noData": "No data yet.",
    "data.integratedScience": "Science",
    "data.saturdayGroup": "Saturday 6 PM Group",
    "data.firstUnitExam": "Unit One Exam",
    "data.goodLevel": "Very good level",
    "data.homeworkOne": "Solve lesson one questions",
    "data.required": "Required",
    "data.noteOne": "Please bring the practical notebook to the next class.",
    "days.0": "Sunday",
    "days.1": "Monday",
    "days.2": "Tuesday",
    "days.3": "Wednesday",
    "days.4": "Thursday",
    "days.5": "Friday",
    "days.6": "Saturday"
  }
} as const;

type TranslationKey = keyof typeof translations.ar;
type Translator = ReturnType<typeof createTranslator>;

const fallbackSitePages: Record<SiteSlug, SitePage> = {
  "about-teacher": {
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
  "about-center": {
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
  contact: {
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
  tips: {
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
      features: ["Study consistently", "Solve varied questions", "Review your mistakes", "Track your scores after every exam"]
    }
  }
};

function createTranslator(language: Language) {
  return (key: TranslationKey, values: Record<string, string> = {}) => {
    let text: string = translations[language][key] || translations.ar[key] || key;
    Object.entries(values).forEach(([name, value]) => {
      text = text.replace(`{{${name}}}`, value);
    });
    return text;
  };
}

function scoreEvaluation(score: unknown, maxScore: unknown, t: Translator) {
  const scoreValue = Number(score);
  const maxValue = Number(maxScore);
  if (!Number.isFinite(scoreValue) || !Number.isFinite(maxValue) || maxValue <= 0) return null;
  const percentage = (scoreValue / maxValue) * 100;
  const key = percentage < 50
    ? "score.weak"
    : percentage < 70
      ? "score.average"
      : percentage < 90
        ? "score.veryGood"
        : "score.excellent";
  const tone = percentage < 50 ? "weak" : percentage < 70 ? "average" : percentage < 90 ? "very-good" : "excellent";
  return { label: t(key), tone, percentage };
}

function displayValue(value: unknown, language: Language) {
  if (typeof value !== "string") return String(value ?? "");
  const dictionary: Record<string, TranslationKey> = {
    "العلوم المتكاملة": "data.integratedScience",
    "مجموعة السبت 6 مساء": "data.saturdayGroup",
    "امتحان الوحدة الأولى": "data.firstUnitExam",
    "مستوى جيد جدا": "data.goodLevel",
    "حل أسئلة الدرس الأول": "data.homeworkOne",
    "مطلوب": "data.required",
    "يرجى إحضار كراسة العملي في الحصة القادمة.": "data.noteOne"
  };
  const key = dictionary[value];
  return key ? createTranslator(language)(key) : value;
}

function ensureDeviceId() {
  const key = "abdrabo_device_id";
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const value =
    crypto.randomUUID?.() || `device_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  localStorage.setItem(key, value);
  return value;
}

function safeSessionPayload(data: LoginResponse): LoginResponse {
  return {
    ok: data.ok,
    status: data.status,
    message: data.message,
    student: data.student
      ? {
          id: data.student.id,
          full_name: data.student.full_name,
          student_code: data.student.student_code,
          group_name: data.student.group_name,
          subject: data.student.subject
        }
      : undefined,
    today_session: data.today_session
      ? {
          starts_at: data.today_session.starts_at,
          group_name: data.today_session.group_name,
          subject: data.today_session.subject
        }
      : undefined,
    attendance_record: data.attendance_record
      ? {
          checkin_time: data.attendance_record.checkin_time,
          status: data.attendance_record.status,
          is_suspicious: data.attendance_record.is_suspicious
        }
      : undefined,
    dashboard: data.dashboard
  };
}

function loadStoredStudentSession() {
  try {
    const stored = sessionStorage.getItem(STUDENT_SESSION_STORAGE_KEY);
    if (!stored) return null;
    const data = JSON.parse(stored) as LoginResponse;
    return data?.student?.student_code && data?.student?.full_name ? data : null;
  } catch (_error) {
    sessionStorage.removeItem(STUDENT_SESSION_STORAGE_KEY);
    return null;
  }
}

function saveStudentSession(data: LoginResponse) {
  sessionStorage.setItem(STUDENT_SESSION_STORAGE_KEY, JSON.stringify(safeSessionPayload(data)));
}

function loadStoredTeacherSession() {
  try {
    const stored = [ADMIN_SESSION_STORAGE_KEY, TEACHER_SESSION_STORAGE_KEY, ASSISTANT_SESSION_STORAGE_KEY].map((key) => sessionStorage.getItem(key)).find(Boolean);
    if (!stored) return null;
    const data = JSON.parse(stored) as TeacherSession;
    return data?.token && data?.teacher?.id ? data : null;
  } catch (_error) {
    [ADMIN_SESSION_STORAGE_KEY, TEACHER_SESSION_STORAGE_KEY, ASSISTANT_SESSION_STORAGE_KEY].forEach((key) => sessionStorage.removeItem(key));
    return null;
  }
}

function saveTeacherSession(data: TeacherSession) {
  const key = data.teacher.role === "admin" ? ADMIN_SESSION_STORAGE_KEY : data.teacher.role === "assistant" ? ASSISTANT_SESSION_STORAGE_KEY : TEACHER_SESSION_STORAGE_KEY;
  sessionStorage.setItem(
    key,
    JSON.stringify({
      token: data.token,
      teacher: {
        id: data.teacher.id,
        name: data.teacher.name,
        email: data.teacher.email,
        username: data.teacher.username,
        role: data.teacher.role
      }
    })
  );
}

function formatDateOnly(value: string | undefined, language: Language, emptyText: string) {
  if (!value) return emptyText;
  const dateValue = value.slice(0, 10);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateValue) ? new Date(`${dateValue}T12:00:00`) : new Date(value);
  if (Number.isNaN(date.getTime())) return emptyText;
  return new Intl.DateTimeFormat(language === "ar" ? "ar-EG" : "en-US", { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Cairo" }).format(date);
}

function formatDateTime(value: string | undefined, language: Language, emptyText: string) {
  if (!value) return emptyText;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return emptyText;
  const locale = language === "ar" ? "ar-EG" : "en-US";
  const dateText = new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Cairo" }).format(date);
  const timeText = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Africa/Cairo" }).format(date);
  return language === "ar" ? `${dateText}، ${timeText}` : `${dateText}, ${timeText}`;
}

function localDateInputValue(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function formatLocalTime(value: string | undefined, language: Language) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(language === "ar" ? "ar-EG" : "en-US", { hour: "numeric", minute: "2-digit" }).format(date);
}

function formatSessionWindow(session: Record<string, any>, language: Language) {
  const start = formatLocalTime(session.starts_at || session.opens_at, language);
  const end = formatLocalTime(session.closes_at, language);
  return language === "ar" ? `من ${start} إلى ${end}` : `${start} - ${end}`;
}

function statusMessage(status: string, t: Translator) {
  const statusKey: Record<string, TranslationKey> = {
    attendance_recorded: "dashboard.attendanceSuccess",
    pending_review: "dashboard.attendancePending",
    no_open_session: "dashboard.noOpenSession",
    outside_center_radius: "dashboard.outsideRadius",
    location_required: "dashboard.locationRequired",
    invalid_student: "dashboard.invalidStudent"
  };
  return t(statusKey[status] || "dashboard.unknownStatus");
}

function scannerStatusMessage(status: string, t: Translator) {
  const statusKey: Record<string, TranslationKey> = {
    attendance_recorded: "scanner.recorded",
    invalid_qr_token: "scanner.invalidCode",
    scan_value_required: "scanner.scanRequired",
    inactive_student: "scanner.inactiveStudent",
    closed_session: "scanner.closedSession",
    duplicate_attendance: "scanner.duplicate"
  };
  return t(statusKey[status] || "scanner.serverError");
}

function attendanceStatusBadge(status: unknown, t: Translator) {
  const value = String(status || "");
  if (value === "present") return { label: t("attendance.present"), className: "attendance-status-badge attendance-status-present" };
  if (value === "absent") return { label: t("attendance.absent"), className: "attendance-status-badge attendance-status-absent" };
  if (value === "pending_review") return { label: t("attendance.pendingReview"), className: "attendance-status-badge attendance-status-pending" };
  return { label: t("attendance.notMarked"), className: "attendance-status-badge attendance-status-not-marked" };
}

function AttendanceStatusBadge({ status, t }: { status: unknown; t: Translator }) {
  const badge = attendanceStatusBadge(status, t);
  return <span className={badge.className}>{badge.label}</span>;
}

function getCurrentSiteSlug(path: string): SiteSlug | null {
  const slug = path.replace(/^\//, "");
  return slug === "about-teacher" || slug === "about-center" || slug === "contact" || slug === "tips"
    ? slug
    : null;
}

function localizedPage(page: SitePage, language: Language) {
  return {
    title: language === "ar" ? page.title_ar : page.title_en,
    subtitle: language === "ar" ? page.subtitle_ar : page.subtitle_en,
    content: language === "ar" ? page.content_ar : page.content_en
  };
}

function roleLabel(role: string, t: Translator) {
  const key = `admin.role.${role}` as TranslationKey;
  return key in translations.ar ? t(key) : role;
}

function adminApiErrorMessage(status: string | undefined, t: Translator) {
  if (status === "too_many_schedules") return "يمكن اختيار 3 أيام فقط كحد أقصى / You can select up to 3 days only.";
  if (status === "user_exists") return t("errors.userExists");
  if (status === "password_too_short") return t("errors.passwordLength");
  if (status === "self_disable_forbidden") return t("errors.selfDisable");
  if (status === "self_role_forbidden") return t("errors.selfRole");
  if (status === "student_code_exists") return t("admin.codeExists");
  if (status === "invalid_student_code") return t("admin.invalidStudentCode");
  if (status === "invalid_phone") return t("errors.phoneLength");
  if (status === "invalid_national_id") return t("errors.nationalIdLength");
  if (status === "invalid_group" || status === "invalid_group_payload" || status === "invalid_student_payload") {
    return t("admin.invalidPayload");
  }
  return t("errors.loginFailed");
}

function paymentErrorMessage(status: unknown, message: unknown, t: Translator) {
  const backendMessage = typeof message === "string" ? message.trim() : "";
  if (backendMessage && backendMessage.toLowerCase() !== "undefined" && backendMessage.toLowerCase() !== "null") return backendMessage;
  if (status === "already_paid") return t("fees.alreadyPaid");
  if (status === "no_outstanding_fees" || status === "no_payable_balance") return t("fees.noOutstanding");
  return t("fees.paymentFailed");
}

type RecordStatusFilter = "active" | "disabled" | "deleted" | "all";

function recordStatusLabel(record: { deleted_at?: string | null; is_active: boolean }, t: Translator) {
  if (record.deleted_at) return t("admin.deleted");
  return record.is_active ? t("admin.active") : t("admin.disabled");
}

function recordStatusFilterLabel(filter: RecordStatusFilter, t: Translator) {
  if (filter === "active") return t("admin.active");
  if (filter === "disabled") return t("admin.disabled");
  if (filter === "deleted") return t("admin.deleted");
  return t("inbox.all");
}

function purgeDaysLeft(purgeAfter?: string | null) {
  if (!purgeAfter) return null;
  return Math.max(0, Math.ceil((Date.parse(purgeAfter) - Date.now()) / (24 * 60 * 60 * 1000)));
}

const studentCodePattern = /^A-\d{4}$/;

function normalizeStudentCode(value: string) {
  return normalizeDigits(value).trim().toUpperCase().replace(/^A(\d{4})$/, "A-$1");
}

const arabicKeyboardToLatin: Record<string, string> = {
  "\u0636": "q", "\u0635": "w", "\u062b": "e", "\u0642": "r", "\u0641": "t", "\u063a": "y", "\u0639": "u", "\u0647": "i", "\u062e": "o", "\u062d": "p", "\u062c": "[", "\u062f": "]",
  "\u0634": "a", "\u0633": "s", "\u064a": "d", "\u0628": "f", "\u0644": "g", "\u0627": "h", "\u062a": "j", "\u0646": "k", "\u0645": "l", "\u0643": ";", "\u0637": "'",
  "\u0626": "z", "\u0621": "x", "\u0624": "c", "\u0631": "v", "\u0649": "n", "\u0629": "m", "\u0648": ",", "\u0632": ".", "\u0638": "/"
};

function restoreScannerKeyboardLayout(value: unknown) {
  return String(value ?? "")
    .replace(/\uFEFB|\uFEFC/g, "b")
    .replace(/\u0644\u0627/g, "b")
    .split("")
    .map((character) => arabicKeyboardToLatin[character] || character)
    .join("");
}

function normalizeScanValue(value: unknown) {
  return restoreScannerKeyboardLayout(normalizeDigits(value))
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .replace(/^\](?:C[0-3]|Q[0-9]|d[0-9])/i, "")
    .trim()
    .toUpperCase();
}

function normalizeAdminStudentCode(value: string) {
  const normalized = normalizeStudentCode(value);
  return normalized.replace(/^A(\d{4})$/, "A-$1");
}

function escapeHtml(value: unknown) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character] || character));
}

function labelScanSerial(student: Record<string, any>) {
  return String(student.scan_serial || student.student_serial || "").trim();
}

function buildStudentLabelMarkup(student: Record<string, any>) {
  const scanSerial = labelScanSerial(student);
  const barcode = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  if (scanSerial) {
    JsBarcode(barcode, scanSerial, { format: "CODE128", displayValue: false, height: 52, width: 1.45, margin: 0 });
  }
  const grade = student.grade || student.grade_level || "";
  const group = student.group_name || student.group || "";
  const gradeAndGroup = [grade, group].filter(Boolean).join(" · ");
  return `<!doctype html><html dir="rtl"><head><meta charset="utf-8"><title>Student Label</title><style>
    @page{size:58mm 32mm;margin:0}
    *{box-sizing:border-box}
    html,body{width:58mm;min-height:32mm;margin:0;padding:0}
    body{display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden;padding:1mm 2mm;font-family:Arial,Tahoma,sans-serif;text-align:center;color:#111;background:#fff}
    .brand,.name,.code,.grade,.scan-value{max-width:54mm;white-space:nowrap;overflow:hidden;text-overflow:clip}
    .brand{font-size:10px;line-height:1.05;font-weight:700}
    .name{font-size:12.5px;line-height:1.05;font-weight:700;margin:.8mm 0 .35mm}
    .code{font-size:11px;line-height:1.05;font-weight:800}
    .grade{font-size:8.5px;line-height:1.05;margin-top:.35mm}
    .barcode{display:flex;align-items:center;justify-content:center;width:54mm;height:8.5mm;margin:.7mm auto 0;overflow:hidden}
    .barcode svg{display:block;width:54mm;height:8.5mm}
    .scan-value{font-size:9.2px;line-height:1;font-weight:700;margin-top:.2mm;letter-spacing:.15px}
  </style></head><body>
    <div class="brand">مستر أحمد عبدربه / Mr. Ahmed Abdrabo</div>
    <div class="name">${escapeHtml(student.full_name || "")}</div>
    <div class="code">Student code / كود الطالب: ${escapeHtml(student.student_code || "")}</div>
    <div class="grade">${escapeHtml(gradeAndGroup)}</div>
    ${scanSerial ? `<div class="barcode">${barcode.outerHTML}</div><div class="scan-value">${escapeHtml(scanSerial)}</div>` : ""}
  </body></html>`;
}

function DateTimeWidget({
  language,
  compact = false
}: {
  language: Language;
  compact?: boolean;
}) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60 * 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className={`date-time-widget ${compact ? "compact-date-time" : ""}`}>
      <strong>
        {new Intl.DateTimeFormat(language === "ar" ? "ar-EG" : "en-US", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit"
        }).format(now)}
      </strong>
    </div>
  );
}

function App() {
  const [path, setPath] = useState(() => window.location.pathname);
  const [language, setLanguageState] = useState<Language>(() => {
    return localStorage.getItem(LANGUAGE_STORAGE_KEY) === "en" ? "en" : "ar";
  });
  const [studentCode, setStudentCode] = useState("");
  const [lookupOpen, setLookupOpen] = useState(false);
  const [lookupValue, setLookupValue] = useState("");
  const [lookupError, setLookupError] = useState("");
  const [lookupResult, setLookupResult] = useState("");
  const [lookupStudentCode, setLookupStudentCode] = useState("");
  const [lookupCopied, setLookupCopied] = useState(false);
  const lookupCopyResetTimer = useRef<number | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [loginData, setLoginData] = useState<LoginResponse | null>(() => loadStoredStudentSession());
  const [teacherSession, setTeacherSession] = useState<TeacherSession | null>(() =>
    loadStoredTeacherSession()
  );
  const t = useMemo(() => createTranslator(language), [language]);

  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
    localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  }, [language]);

  useEffect(() => {
    const updatePath = () => setPath(window.location.pathname);
    window.addEventListener("popstate", updatePath);
    return () => window.removeEventListener("popstate", updatePath);
  }, []);

  function navigate(nextPath: string) {
    window.history.pushState({}, "", nextPath);
    setPath(window.location.pathname);
  }

  function setLanguage(nextLanguage: Language) {
    setLanguageState(nextLanguage);
    setError("");
    setLookupError("");
  }

  function resetLookupModal() {
    setLookupValue("");
    setLookupError("");
    setLookupResult("");
    setLookupStudentCode("");
    setLookupCopied(false);
    if (lookupCopyResetTimer.current !== null) {
      window.clearTimeout(lookupCopyResetTimer.current);
      lookupCopyResetTimer.current = null;
    }
    setLookupLoading(false);
  }

  function openLookupModal() {
    resetLookupModal();
    setLookupOpen(true);
  }

  function closeLookupModal() {
    resetLookupModal();
    setLookupOpen(false);
  }

  function handleLogout() {
    sessionStorage.removeItem(STUDENT_SESSION_STORAGE_KEY);
    setLoginData(null);
    setStudentCode("");
    setError("");
    resetLookupModal();
    navigate("/");
  }

  function handleTeacherLogout() {
    [ADMIN_SESSION_STORAGE_KEY, TEACHER_SESSION_STORAGE_KEY, ASSISTANT_SESSION_STORAGE_KEY].forEach((key) => sessionStorage.removeItem(key));
    setTeacherSession(null);
    navigate("/teacher/login");
  }

  async function handleLookup(event?: React.FormEvent) {
    event?.preventDefault();
    const value = normalizeDigits(lookupValue).trim();
    setLookupValue(value);
    setLookupError("");
    setLookupResult("");
    setLookupStudentCode("");
    setLookupCopied(false);

    if (!value) {
      setLookupError(t("errors.lookupRequired"));
      return;
    }

    if (!/^\d+$/.test(value)) {
      setLookupError(t("errors.digitsOnly"));
      return;
    }

    if (value.length === 11 && !/^\d{11}$/.test(value)) {
      setLookupError(t("errors.phoneLength"));
      return;
    }

    if (value.length === 14 && !/^\d{14}$/.test(value)) {
      setLookupError(t("errors.nationalIdLength"));
      return;
    }

    if (value.length !== 11 && value.length !== 14) {
      setLookupError(t("errors.lookupLength"));
      return;
    }

    setLookupLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/student/find-code`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: value })
      });
      const data = (await response.json()) as { ok: boolean; student_code?: string };
      setLookupStudentCode(data.ok && data.student_code ? data.student_code : "");
      setLookupResult(
        data.ok && data.student_code
          ? t("student.lookupFound", { code: data.student_code })
          : t("student.lookupNotFound")
      );
    } catch (_error) {
      setLookupError(t("errors.loginFailed"));
    } finally {
      setLookupLoading(false);
    }
  }

  async function copyLookupStudentCode() {
    if (!lookupStudentCode) return;

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(lookupStudentCode);
      } else {
        const copyField = document.createElement("textarea");
        copyField.value = lookupStudentCode;
        copyField.setAttribute("readonly", "");
        copyField.style.position = "fixed";
        copyField.style.opacity = "0";
        document.body.appendChild(copyField);
        copyField.select();
        const copied = document.execCommand("copy");
        copyField.remove();
        if (!copied) throw new Error("copy_failed");
      }
      setLookupCopied(true);
      if (lookupCopyResetTimer.current !== null) {
        window.clearTimeout(lookupCopyResetTimer.current);
      }
      lookupCopyResetTimer.current = window.setTimeout(() => {
        setLookupCopied(false);
        lookupCopyResetTimer.current = null;
      }, 1500);
    } catch (_error) {
      setLookupError(t("student.copyFailed"));
    }
  }

  async function postLogin(latitude: number | null, longitude: number | null) {
    const normalizedCode = normalizeStudentCode(studentCode);
    const response = await fetch(`${API_BASE_URL}/student/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        student_code: normalizedCode,
        device_id: ensureDeviceId(),
        latitude,
        longitude
      })
    });

    const data = (await response.json()) as LoginResponse;
    if (!response.ok) {
      throw new Error(statusMessage(data.status, t) || data.message || t("errors.loginFailed"));
    }
    return data;
  }

  async function handleLogin(event: React.FormEvent) {
    event.preventDefault();
    const normalizedCode = normalizeStudentCode(studentCode);
    setStudentCode(normalizedCode);

    if (!normalizedCode) {
      setError(t("errors.codeRequired"));
      return;
    }

    if (!studentCodePattern.test(normalizedCode)) {
      setError(t("admin.invalidStudentCode"));
      return;
    }

    setLoading(true);
    setError("");

    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        if (!navigator.geolocation) {
          reject(new Error(t("errors.locationUnsupported")));
          return;
        }
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 0
        });
      });

      const data = await postLogin(position.coords.latitude, position.coords.longitude);
      saveStudentSession(data);
      setLoginData(data);
      navigate("/student/dashboard");
    } catch (_locationError) {
      try {
        const data = await postLogin(null, null);
        saveStudentSession(data);
        setLoginData(data);
        navigate("/student/dashboard");
      } catch (apiError) {
        setError(apiError instanceof Error ? apiError.message : t("errors.loginFailed"));
      }
    } finally {
      setLoading(false);
    }
  }

  if (path === "/teacher/login") {
    if (teacherSession) {
      window.history.replaceState({}, "", "/teacher/dashboard");
      return (
        <TeacherDashboard
          session={teacherSession}
          language={language}
          setLanguage={setLanguage}
          onLogout={handleTeacherLogout}
          t={t}
        />
      );
    }

    return (
      <TeacherLogin
        language={language}
        setLanguage={setLanguage}
        onLogin={(session) => {
          saveTeacherSession(session);
          setTeacherSession(session);
          navigate("/teacher/dashboard");
        }}
        t={t}
      />
    );
  }

  if (path === "/teacher/dashboard") {
    if (!teacherSession) {
      window.history.replaceState({}, "", "/teacher/login");
      return (
        <TeacherLogin
          language={language}
          setLanguage={setLanguage}
          onLogin={(session) => {
            saveTeacherSession(session);
            setTeacherSession(session);
            navigate("/teacher/dashboard");
          }}
          t={t}
        />
      );
    }

    return (
      <TeacherDashboard
        session={teacherSession}
        language={language}
        setLanguage={setLanguage}
        onLogout={handleTeacherLogout}
        t={t}
      />
    );
  }

  const publicSlug = getCurrentSiteSlug(path);
  if (publicSlug) {
    return (
      <PublicContentPage
        slug={publicSlug}
        studentId={loginData?.student?.id}
        studentCode={loginData?.student?.student_code}
        language={language}
        setLanguage={setLanguage}
        t={t}
      />
    );
  }

  if (loginData?.student || path === "/student/dashboard") {
    if (!loginData?.student) {
      window.history.replaceState({}, "", "/");
    } else {
      return (
        <StudentDashboard
          data={loginData}
          language={language}
          setLanguage={setLanguage}
          onLogout={handleLogout}
          t={t}
        />
      );
    }
  }

  if (loginData?.student) {
    return (
      <StudentDashboard
        data={loginData}
        language={language}
        setLanguage={setLanguage}
        onLogout={handleLogout}
        t={t}
      />
    );
  }

  return (
    <Shell language={language} setLanguage={setLanguage} t={t}>
      <main className="hero">
        <section className="hero-copy" aria-labelledby="hero-title">
          <p className="eyebrow">{t("home.eyebrow")}</p>
          <h1 id="hero-title">{t("home.title")}</h1>
          <p className="subtitle">{t("home.subtitle")}</p>
          <div className="teacher-strip">
            <img className="teacher-mark teacher-avatar" src="/assets/teacher-profile.png" alt="" aria-hidden="true" />
            <div>
              <strong>{t("site.name")}</strong>
              <span>{t("site.description")}</span>
            </div>
          </div>
        </section>

        <section className="login-card" id="student-login" aria-labelledby="login-title">
          <h2 id="login-title">{t("student.loginTitle")}</h2>
          <form onSubmit={handleLogin}>
            <label htmlFor="student-code">{t("student.codeLabel")}</label>
            <input
              id="student-code"
              value={studentCode}
              onChange={(event) => setStudentCode(normalizeDigits(event.target.value))}
              placeholder={t("student.codePlaceholder")}
              autoComplete="off"
            />
            {error ? <p className="form-error">{error}</p> : null}
            <button className="primary-button" disabled={loading} type="submit">
              {loading ? t("student.enteringButton") : t("student.enterButton")}
            </button>
            <button className="secondary-button" type="button" onClick={openLookupModal}>
              {t("student.findCodeButton")}
            </button>
          </form>
        </section>
      </main>

      {lookupOpen ? (
        <div className="modal-backdrop" role="presentation">
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="lookup-title">
            <button
              className="close-button"
              aria-label={t("student.close")}
              onClick={closeLookupModal}
            >
              ×
            </button>
            <h2 id="lookup-title">{t("student.lookupTitle")}</h2>
            <p>{t("student.lookupHelp")}</p>
            <form onSubmit={handleLookup}>
              <input
                value={lookupValue}
                onChange={(event) => {
                  setLookupValue(normalizeDigits(event.target.value));
                  setLookupError("");
                  setLookupResult("");
                }}
                placeholder={t("student.lookupPlaceholder")}
                inputMode="numeric"
                autoComplete="off"
              />
              {lookupError ? <p className="form-error">{lookupError}</p> : null}
              <button className="primary-button" type="submit" disabled={lookupLoading}>
                {lookupLoading ? t("student.lookupLoading") : t("student.lookupButton")}
              </button>
              {lookupResult ? (
                <div className="lookup-result-row" aria-live="polite">
                  <p className="lookup-result">{lookupResult}</p>
                  {lookupStudentCode ? (
                    <>
                      <button
                        className="copy-code-button"
                        type="button"
                        onClick={copyLookupStudentCode}
                      aria-label={t("student.copyCode")}
                    >
                      {lookupCopied ? t("student.codeCopied") : t("student.copyCode")}
                    </button>
                  </>
                  ) : null}
                </div>
              ) : null}
            </form>
          </section>
        </div>
      ) : null}
    </Shell>
  );
}

function PublicContentPage({
  slug,
  studentId,
  studentCode,
  language,
  setLanguage,
  t
}: {
  slug: SiteSlug;
  studentId?: number;
  studentCode?: string;
  language: Language;
  setLanguage: (language: Language) => void;
  t: Translator;
}) {
  const [page, setPage] = useState<SitePage | null>(null);
  const [loadedSlug, setLoadedSlug] = useState<SiteSlug | null>(null);
  const [contactSent, setContactSent] = useState(false);
  const [contactError, setContactError] = useState("");
  const [contactForm, setContactForm] = useState({ name: "", phone: "", message: "" });
  const isLoading = loadedSlug !== slug;
  const view = page && !isLoading ? localizedPage(page, language) : null;

  useEffect(() => {
    let ignore = false;
    setPage(null);
    setLoadedSlug(null);

    fetch(`${API_BASE_URL}/site/pages/${slug}`)
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((data: { page?: SitePage }) => {
        if (!ignore) setPage(data.page || fallbackSitePages[slug]);
      })
      .catch(() => {
        if (!ignore) setPage(fallbackSitePages[slug]);
      })
      .finally(() => {
        if (!ignore) setLoadedSlug(slug);
      });

    return () => {
      ignore = true;
    };
  }, [slug]);

  async function submitContact(event: React.FormEvent) {
    event.preventDefault();
    const phone = normalizeDigits(contactForm.phone).trim();
    setContactForm((value) => ({ ...value, phone }));
    setContactError(!/^\d{11}$/.test(phone) ? t("errors.phoneLength") : "");
    if (!/^\d{11}$/.test(phone)) return;
    const response = await fetch(`${API_BASE_URL}/site/contact`, { method: "POST", headers: { "Content-Type": "application/json", ...(studentCode ? { "X-Student-Code": studentCode } : {}) }, body: JSON.stringify({ ...contactForm, student_id: studentId }) });
    if (response.ok) { setContactSent(true); setContactForm({ name: "", phone: "", message: "" }); }
  }

  if (!view) {
    return (
      <Shell language={language} setLanguage={setLanguage} t={t}>
        <main className="content-page">
          <section className="content-hero content-loading" aria-live="polite">
            <p>{t("public.loading")}</p>
          </section>
        </main>
      </Shell>
    );
  }

  return (
    <Shell language={language} setLanguage={setLanguage} t={t}>
      <main className="content-page">
        <section className="content-hero">
          {slug !== "about-teacher" ? (
            <p className="eyebrow">
              {t(
                `nav.${
                  slug === "about-center"
                    ? "aboutCenter"
                    : slug === "tips"
                      ? "tips"
                      : "contact"
                }` as TranslationKey
              )}
            </p>
          ) : null}
          <h1>{view.title}</h1>
          <p>{view.subtitle}</p>
        </section>

        {slug === "about-teacher" ? (
          <section className="content-grid">
            <article className="content-panel wide teacher-profile-panel">
              <div className="teacher-profile-photo">
                <img src="/assets/teacher-profile.png" alt={view.content.teacherName} />
              </div>
              <div className="teacher-profile-copy">
                <h2>{view.content.teacherName}</h2>
                <p>{view.content.bio}</p>
              </div>
            </article>
            <article className="content-panel">
              <span>{t("public.statExperience")}</span>
              <strong>{view.content.experienceYears}</strong>
            </article>
            <article className="content-panel">
              <span>{t("public.teachingStyle")}</span>
              <p>{view.content.teachingStyle}</p>
            </article>
            <article className="content-panel wide">
              <span>{t("public.results")}</span>
              <div className="pill-row">
                {(view.content.stats || []).map((item: string) => (
                  <span key={item}>{item}</span>
                ))}
              </div>
            </article>
          </section>
        ) : null}

        {slug === "about-center" ? (
          <section className="content-grid">
            <article className="content-panel wide">
              <span>{t("nav.aboutCenter")}</span>
              <p>{view.content.intro}</p>
            </article>
            <article className="content-panel">
              <span>{t("public.address")}</span>
              <strong>{view.content.address}</strong>
            </article>
            <article className="content-panel">
              <span>{t("public.availableGroups")}</span>
              <ul>
                {(view.content.groups || []).map((item: string) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </article>
            <article className="content-panel wide">
              <span>{t("public.features")}</span>
              <div className="pill-row">
                {(view.content.features || []).map((item: string) => (
                  <span key={item}>{item}</span>
                ))}
              </div>
            </article>
          </section>
        ) : null}

        {slug === "tips" ? (
          <section className="content-grid">
            <article className="content-panel wide">
              <span>{t("nav.tips")}</span>
              <p>{view.content.intro}</p>
            </article>
            <article className="content-panel wide">
              <span>{t("public.features")}</span>
              <div className="pill-row">
                {(view.content.features || []).map((item: string) => (
                  <span key={item}>{item}</span>
                ))}
              </div>
            </article>
          </section>
        ) : null}

        {slug === "contact" ? (
          <section className="content-grid">
            <article className="content-panel">
              <span>{t("contact.whatsapp")}</span>
              <strong>{view.content.whatsapp}</strong>
            </article>
            <article className="content-panel">
              <span>{t("contact.facebook")}</span>
              <strong>{view.content.facebook}</strong>
            </article>
            <article className="content-panel">
              <span>{t("contact.youtube")}</span>
              <strong>{view.content.youtube}</strong>
            </article>
            <article className="content-panel contact-form-panel">
              <span>{view.content.formIntro}</span>
              <form onSubmit={submitContact}>
                <input value={contactForm.name} onChange={(e)=>setContactForm({...contactForm,name:e.target.value})} placeholder={t("contact.name")} />
                <input type="text" value={contactForm.phone} onChange={(e)=>{setContactError("");setContactForm({...contactForm,phone:normalizeDigits(e.target.value)});}} placeholder={t("contact.phone")} inputMode="numeric" />
                {contactError ? <p className="form-error">{contactError}</p> : null}
                <textarea value={contactForm.message} onChange={(e)=>setContactForm({...contactForm,message:e.target.value})} placeholder={t("contact.message")} rows={4} />
                <button className="primary-button" type="submit">
                  {t("contact.send")}
                </button>
                {contactSent ? <p className="lookup-result">{t("contact.success")}</p> : null}
              </form>
            </article>
          </section>
        ) : null}
      </main>
    </Shell>
  );
}

function TeacherLogin({
  language,
  setLanguage,
  onLogin,
  t
}: {
  language: Language;
  setLanguage: (language: Language) => void;
  onLogin: (session: TeacherSession) => void;
  t: Translator;
}) {
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleTeacherLogin(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setLoading(true);

    try {
      const response = await fetch(`${API_BASE_URL}/teacher/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier: identifier.trim(),
          password,
          language
        })
      });
      const data = (await response.json()) as TeacherSession & { ok: boolean; message?: string };

      if (!response.ok || !data.token || !data.teacher) {
        throw new Error(data.message || t("teacher.loginFailed"));
      }

      onLogin({ token: data.token, teacher: data.teacher });
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : t("teacher.loginFailed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Shell language={language} setLanguage={setLanguage} t={t}>
      <main className="teacher-auth">
        <section className="login-card teacher-login-card" aria-labelledby="teacher-login-title">
          <p className="eyebrow">{t("nav.teacherLogin")}</p>
          <h1 id="teacher-login-title">{t("teacher.loginTitle")}</h1>
          <form onSubmit={handleTeacherLogin}>
            <label htmlFor="teacher-identifier">{t("teacher.usernameLabel")}</label>
            <input
              id="teacher-identifier"
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              placeholder={t("teacher.usernamePlaceholder")}
              autoComplete="username"
            />
            <label htmlFor="teacher-password">{t("teacher.passwordLabel")}</label>
            <input
              id="teacher-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t("teacher.passwordPlaceholder")}
              autoComplete="current-password"
            />
            {error ? <p className="form-error">{error}</p> : null}
            <button className="primary-button" type="submit" disabled={loading}>
              {loading ? t("teacher.loggingInButton") : t("teacher.loginButton")}
            </button>
          </form>
        </section>
      </main>
    </Shell>
  );
}

function TeacherDashboard({
  session,
  language,
  setLanguage,
  onLogout,
  t
}: {
  session: TeacherSession;
  language: Language;
  setLanguage: (language: Language) => void;
  onLogout: () => void;
  t: Translator;
}) {
  const isAdmin = session.teacher.role === "admin";
  const [inboxUnread, setInboxUnread] = useState(0);
  useEffect(() => {
    fetch(`${API_BASE_URL}/admin/inbox/unread-count`, { headers: { Authorization: `Bearer ${session.token}` } })
      .then((response) => response.json())
      .then((payload) => setInboxUnread(Number(payload.count || 0)))
      .catch(() => undefined);
  }, [session.token]);
  const adminTabs = ([
    { id: "overview", label: t("admin.tabs.overview") },
    { id: "add-user", label: t("admin.tabs.addUser"), adminOnly: true },
    { id: "users", label: t("admin.tabs.users"), adminOnly: true },
    { id: "site-content", label: t("admin.tabs.siteContent"), adminOnly: true },
    { id: "audit-logs", label: t("admin.tabs.auditLogs"), adminOnly: true },
    { id: "students", label: t("admin.tabs.students") },
    { id: "groups", label: t("admin.tabs.groups") },
    { id: "attendance", label: t("admin.tabs.attendance") },
    { id: "scanner", label: t("admin.tabs.scanner") },
    { id: "fees", label: t("admin.tabs.fees") },
    { id: "exams", label: t("admin.tabs.exams") },
    { id: "inbox", label: `${t("admin.tabs.inbox")}${inboxUnread ? ` (${inboxUnread})` : ""}` }
  ] satisfies Array<{ id: AdminTab; label: string; adminOnly?: boolean }>).filter((tab) => !tab.adminOnly || isAdmin);
  const [activeTab, setActiveTab] = useState<AdminTab>("overview");

  const placeholderTitles: Partial<Record<AdminTab, string>> = {
    attendance: t("admin.tabs.attendance"),
    exams: t("admin.tabs.exams")
  };

  useEffect(() => {
    if (!adminTabs.some((tab) => tab.id === activeTab)) {
      setActiveTab("overview");
    }
  }, [activeTab, adminTabs]);

  return (
    <div className="app-shell admin-shell">
      <header
        className="site-header admin-header"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "16px",
          width: "100%"
        }}
      >
        <a
          className="brand"
          href="/teacher/dashboard"
          style={{ flexShrink: 0, minWidth: "fit-content", display: "inline-flex", alignItems: "center", gap: "10px" }}
        >
          <img className="brand-icon teacher-avatar" src="/assets/teacher-profile.png" alt="" aria-hidden="true" />
          <span>
            <strong>{t("teacher.dashboardTitle")}</strong>
            <small>{t("site.name")}</small>
          </span>
        </a>
        <div
          className="header-actions"
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "12px",
            justifyContent: "flex-end",
            flex: "1 1 auto"
          }}
        >
          <nav
            className="admin-nav"
            aria-label={language === "ar" ? "تنقل لوحة الإدارة" : "Admin navigation"}
            style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "6px" }}
          >
            {adminTabs.map((tab) => (
              <button
                key={tab.id}
                className={activeTab === tab.id ? "active" : ""}
                type="button"
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </nav>
          <button className="admin-logout-tab" type="button" onClick={onLogout} style={{ flexShrink: 0 }}>
            {t("teacher.logout")}
          </button>
          <div
            className="language-switcher"
            aria-label={language === "ar" ? "اختيار اللغة" : "Language selector"}
            style={{ flexShrink: 0 }}
          >
            <button
              className={language === "ar" ? "active" : ""}
              type="button"
              onClick={() => setLanguage("ar")}
              aria-pressed={language === "ar"}
            >
              AR
            </button>
            <button
              className={language === "en" ? "active" : ""}
              type="button"
              onClick={() => setLanguage("en")}
              aria-pressed={language === "en"}
            >
              EN
            </button>
          </div>
        </div>
      </header>
      <main className="dashboard admin-dashboard">
        <section className="dashboard-hero">
          <div>
            <p className="eyebrow">{t("teacher.protectedMessage")}</p>
            <h1>{t("teacher.dashboardTitle")}</h1>
            <p>{t("teacher.dashboardSubtitle")}</p>
            <DateTimeWidget language={language} />
          </div>
          <div className="status-panel success">
            <span>{t("teacher.account")}</span>
            <strong>{session.teacher.name}</strong>
            <small>{session.teacher.email}</small>
            <span className={`role-badge role-${session.teacher.role}`}>
              {roleLabel(session.teacher.role, t)}
            </span>
          </div>
        </section>

        <section className="summary-grid">
          <Metric label={t("teacher.role")} value={roleLabel(session.teacher.role, t)} />
          <Metric label={t("dashboard.tabs.attendance")} value={t("teacher.serviceAvailable")} />
          <Metric label={t("dashboard.tabs.exams")} value={t("teacher.serviceAvailable")} />
        </section>

        <section className="admin-tab-panel">
          {activeTab === "overview" ? (
            <div className="admin-editor">
              <div className="section-heading">
                <p className="eyebrow">{t("admin.tabs.overview")}</p>
                <h2>{t("teacher.account")}</h2>
              </div>
              <div className="summary-grid compact-summary">
                <Metric label={t("admin.usersTeam")} value={isAdmin ? t("admin.active") : t("admin.adminOnly")} />
                <Metric label={t("admin.siteContent")} value={isAdmin ? t("admin.active") : t("admin.adminOnly")} />
                <Metric label={t("teacher.role")} value={roleLabel(session.teacher.role, t)} />
              </div>
            </div>
          ) : null}
          {activeTab === "add-user" && isAdmin ? <UsersTeamManager mode="create" session={session} t={t} /> : null}
          {activeTab === "users" && isAdmin ? <UsersTeamManager mode="list" session={session} t={t} /> : null}
          {activeTab === "site-content" && isAdmin ? <SiteContentEditor session={session} language={language} t={t} /> : null}
          {activeTab === "audit-logs" && isAdmin ? <AuditLogsPanel session={session} language={language} t={t} /> : null}
          {activeTab === "groups" ? <AcademicManager kind="groups" session={session} t={t} /> : null}
          {activeTab === "students" ? <AcademicManager kind="students" session={session} t={t} /> : null}
          {activeTab === "scanner" ? <ScannerPanel session={session} t={t} /> : null}
          {activeTab === "fees" ? <><FeesPanel session={session} t={t} /><PaymentReportsPanel session={session} t={t} /><LatePaymentsReportPanel session={session} t={t} /></> : null}
          {activeTab === "attendance" ? <AttendancePanel session={session} language={language} t={t} /> : null}
          {activeTab === "exams" ? <ExamResultsManager session={session} t={t} /> : null}
          {activeTab === "inbox" ? <StaffInboxControls session={session} language={language} t={t} onUnreadCountChange={setInboxUnread} /> : null}
          {activeTab !== "overview" && activeTab !== "attendance" && activeTab !== "exams" && placeholderTitles[activeTab] ? (
            <div className="admin-editor placeholder-panel">
              <p className="eyebrow">V1</p>
              <h2>{placeholderTitles[activeTab]}</h2>
              <p>{t("teacher.dashboardSubtitle")}</p>
            </div>
          ) : null}
        </section>
      </main>
      <footer className="site-footer" dir="ltr" lang="en">
        © 2026 Mr. Ahmed Abdrabo · Designed &amp; Developed by Eng. Hany Hosny
      </footer>
    </div>
  );
}

const emptyUserForm = {
  name: "",
  username: "",
  email: "",
  password: "",
  role: "assistant" as AdminUser["role"],
  is_active: true,
  print_student_labels: false,
  max_label_reprints: 2,
  can_use_inbox: false
};

function UsersTeamManager({
  mode,
  session,
  t
}: {
  mode: "create" | "list";
  session: TeacherSession;
  t: Translator;
}) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [form, setForm] = useState(emptyUserForm);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [resetPasswordId, setResetPasswordId] = useState<number | null>(null);
  const [resetPassword, setResetPassword] = useState("");
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "loading" | "success">("idle");
  const [statusFilter, setStatusFilter] = useState<RecordStatusFilter>("active");
  const editorFormRef = useRef<HTMLFormElement>(null);

  async function loadUsers() {
    const response = await fetch(`${API_BASE_URL}/admin/users?status=${statusFilter}`, {
      headers: { Authorization: `Bearer ${session.token}` }
    });
    const data = (await response.json()) as { ok: boolean; users?: AdminUser[] };
    if (response.ok && data.ok) setUsers(data.users || []);
  }

  useEffect(() => {
    loadUsers().catch(() => setStatus(t("errors.loginFailed")));
  }, [statusFilter]);

  function startEdit(user: AdminUser) {
    setEditingId(user.id);
    setResetPasswordId(null);
    setResetPassword("");
    setStatus("");
    setForm({
      name: user.name,
      username: user.username,
      email: user.email,
      password: "",
      role: user.role,
      is_active: user.is_active
      , print_student_labels: user.print_student_labels ?? false,
      max_label_reprints: user.max_label_reprints ?? 2,
      can_use_inbox: user.can_use_inbox ?? false
    });
    window.requestAnimationFrame(() => editorFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function resetForm() {
    setEditingId(null);
    setResetPasswordId(null);
    setResetPassword("");
    setStatus("");
    setForm(emptyUserForm);
  }

  async function saveUser(event: React.FormEvent) {
    event.preventDefault();
    setStatus("");

    if (!form.name.trim() || !form.username.trim() || !form.email.trim()) {
      setStatus(t("errors.userRequired"));
      return;
    }

    if (!editingId && form.password.length < 8) {
      setStatus(t("errors.passwordLength"));
      return;
    }

    setLoading(true);
    setSaveState("loading");
    try {
      const response = await fetch(
        editingId ? `${API_BASE_URL}/admin/users/${editingId}` : `${API_BASE_URL}/admin/users`,
        {
          method: editingId ? "PUT" : "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.token}`
          },
          body: JSON.stringify(form)
        }
      );
      const data = (await response.json()) as { ok: boolean; status?: string };

      if (!response.ok || !data.ok) {
        throw new Error(adminApiErrorMessage(data.status, t));
      }

      await loadUsers();
      resetForm();
      setStatus(t("admin.userSaved"));
      setSaveState("success");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("errors.loginFailed"));
      setSaveState("idle");
    } finally {
      setLoading(false);
    }
  }

  async function updateStatus(user: AdminUser, isActive: boolean) {
    setLoading(true);
    setStatus("");
    try {
      const response = await fetch(`${API_BASE_URL}/admin/users/${user.id}/status`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.token}`
        },
        body: JSON.stringify({ is_active: isActive })
      });
      const data = (await response.json()) as { ok: boolean; status?: string };
      if (!response.ok || !data.ok) throw new Error(adminApiErrorMessage(data.status, t));
      await loadUsers();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("errors.loginFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function deleteUser(user: AdminUser) {
    if (user.id === session.teacher.id) { setStatus("لا يمكنك حذف حسابك الحالي / You cannot delete yourself"); return; }
    if (!window.confirm("هل أنت متأكد من حذف هذا المستخدم؟ / Are you sure you want to delete this user?")) return;
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/admin/users/${user.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${session.token}` } });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.status === "self_delete_forbidden" ? "لا يمكنك حذف حسابك الحالي / You cannot delete yourself" : t("errors.loginFailed"));
      await loadUsers();
    } catch (error) { setStatus(error instanceof Error ? error.message : t("errors.loginFailed")); }
    finally { setLoading(false); }
  }

  async function restoreUser(user: AdminUser) {
    setLoading(true);
    try { const response = await fetch(`${API_BASE_URL}/admin/users/${user.id}/restore`, {method:"PATCH",headers:{Authorization:`Bearer ${session.token}`}}); const data=await response.json(); if(!response.ok||!data.ok)throw new Error(t("errors.loginFailed")); await loadUsers(); }
    catch(error){setStatus(error instanceof Error?error.message:t("errors.loginFailed"));} finally{setLoading(false);}
  }

  async function submitPasswordReset(userId: number) {
    setStatus("");
    if (resetPassword.length < 8) {
      setStatus(t("errors.passwordLength"));
      return;
    }

    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/admin/users/${userId}/reset-password`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.token}`
        },
        body: JSON.stringify({ password: resetPassword })
      });
      const data = (await response.json()) as { ok: boolean; status?: string };
      if (!response.ok || !data.ok) throw new Error(adminApiErrorMessage(data.status, t));
      setResetPasswordId(null);
      setResetPassword("");
      setStatus(t("admin.passwordReset"));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("errors.loginFailed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="admin-editor">
      <div className="section-heading">
        <p className="eyebrow">{t("admin.usersTeam")}</p>
        <h2>{mode === "create" ? t("admin.createUser") : t("admin.usersTeam")}</h2>
      </div>

      {mode === "create" || editingId ? (
      <form ref={editorFormRef} onSubmit={saveUser}>
        <div className="editor-grid">
          <label>
            {t("admin.name")}
            <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </label>
          <label>
            {t("admin.username")}
            <input value={form.username} onChange={(event) => setForm({ ...form, username: event.target.value })} />
          </label>
          <label>
            {t("admin.email")}
            <input value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
          </label>
          <label>
            {t("admin.role")}
            <select
              value={form.role}
              onChange={(event) => setForm({ ...form, role: event.target.value as AdminUser["role"] })}
              disabled={editingId === session.teacher.id}
            >
              <option value="assistant">{t("admin.role.assistant")}</option>
              <option value="teacher">{t("admin.role.teacher")}</option>
              <option value="admin">{t("admin.role.admin")}</option>
            </select>
          </label>
          {!editingId ? (
            <label>
              {t("admin.password")}
              <input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
            </label>
          ) : null}
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={form.is_active}
              disabled={editingId === session.teacher.id}
              onChange={(event) => setForm({ ...form, is_active: event.target.checked })}
            />
            {t("admin.active")}
          </label>
          <label className="checkbox-label"><input type="checkbox" checked={form.print_student_labels} onChange={(event) => setForm({ ...form, print_student_labels: event.target.checked })} />Print labels / السماح بطباعة الليبل</label>
          <label className="checkbox-label"><input type="checkbox" checked={form.can_use_inbox} onChange={(event) => setForm({ ...form, can_use_inbox: event.target.checked })} />{t("inbox.permission")}</label>
          <label>Max reprints / الحد الأقصى لإعادة الطباعة<input type="number" min="0" value={form.max_label_reprints} onChange={(event) => setForm({ ...form, max_label_reprints: Number(event.target.value) })} /></label>
        </div>

        <div className="form-actions">
          <button className="primary-button editor-save" type="submit" disabled={loading}>
            {saveState === "loading"
              ? t(editingId ? "admin.updating" : "admin.creating")
              : saveState === "success"
                ? t(editingId ? "admin.updated" : "admin.created")
                : editingId
                  ? t("admin.update")
                  : t("admin.create")}
          </button>
          {editingId ? (
            <button className="secondary-button compact-button" type="button" onClick={resetForm}>
              {t("admin.cancel")}
            </button>
          ) : null}
        </div>
      </form>
      ) : null}

      {mode === "list" ? (
      <div className="users-list">
        <div className="status-filter-buttons">{(["active","disabled","deleted","all"] as RecordStatusFilter[]).map((filter)=><button key={filter} className={statusFilter===filter?"active":""} type="button" onClick={()=>setStatusFilter(filter)}>{filter==="active"?"Active / النشط":filter==="disabled"?"Disabled / المعطل":filter==="deleted"?"Deleted / المحذوف":"All / الكل"}</button>)}</div>
        {users.map((user) => {
          const isCurrentUser = user.id === session.teacher.id;
          return (
            <article key={user.id} className="user-row">
              <div>
                <strong>{user.name}</strong>
                <span>
                  {user.username} · {user.email}
                </span>
              </div>
              <span className={`role-badge role-${user.role}`}>{roleLabel(user.role, t)}</span>
              <span className={user.deleted_at ? "status-deleted" : user.is_active ? "status-active" : "status-disabled"}>{recordStatusLabel(user, t)}</span>
              <div className="row-actions">
                {!user.deleted_at ? <button className="secondary-button compact-button" type="button" onClick={() => startEdit(user)}>
                  {t("admin.editUser")}
                </button> : null}
                {!user.deleted_at ? <button className="secondary-button compact-button" type="button" onClick={() => setResetPasswordId(user.id)}>
                  {t("admin.resetPassword")}
                </button> : null}
                {!user.deleted_at && !isCurrentUser ? (
                  <button className="secondary-button compact-button" type="button" onClick={() => updateStatus(user, !user.is_active)} disabled={loading}>
                    {user.is_active ? t("admin.disable") : t("admin.enable")}
                  </button>
                ) : null}
                {user.deleted_at ? <button className="secondary-button compact-button" type="button" onClick={() => restoreUser(user)} disabled={loading}>Restore / استرجاع</button> : !isCurrentUser ? <button className="secondary-button compact-button" type="button" onClick={() => deleteUser(user)} disabled={loading}>Delete / حذف</button> : null}
              </div>
              {resetPasswordId === user.id ? (
                <div className="password-reset-row">
                  <input type="password" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} placeholder={t("admin.password")} />
                  <button className="primary-button compact-button" type="button" onClick={() => submitPasswordReset(user.id)}>
                    {t("admin.resetPassword")}
                  </button>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
      ) : null}

      {status ? (
        <p className={status === t("admin.userSaved") || status === t("admin.passwordReset") ? "lookup-result" : "form-error"}>
          {status}
        </p>
      ) : null}
    </section>
  );
}

const emptyGroupForm = {
  name: "",
  grade: "",
  subject: "",
  center_id: "",
  day_of_week: "6",
  start_time: "18:00",
  end_time: "19:30",
  opens_before_minutes: "3",
  closes_after_minutes: "20",
  fees_amount: "0",
  is_active: true
};

type ScheduleDraft = {
  id?: number;
  day_of_week: string;
  start_time: string;
  end_time: string;
  opens_before_minutes: string;
  closes_after_minutes: string;
  is_active: boolean;
};

const defaultScheduleDraft = (day = "6"): ScheduleDraft => ({
  day_of_week: day,
  start_time: "18:00",
  end_time: "19:30",
  opens_before_minutes: "3",
  closes_after_minutes: "20",
  is_active: true
});

const gradeLevels = [
  ["خامسة ابتدائي", "Primary 5"], ["سادسة ابتدائي", "Primary 6"],
  ["أولى إعدادي", "Prep 1"], ["ثانية إعدادي", "Prep 2"], ["ثالثة إعدادي", "Prep 3"],
  ["أولى ثانوي", "Secondary 1"], ["ثانية ثانوي", "Secondary 2"], ["ثالثة ثانوي", "Secondary 3"],
  ["مجاميع تقوية", "Support Groups"]
] as const;

function gradeLevelLabel(value: unknown, language: Language) {
  const text = String(value ?? "").trim();
  const match = gradeLevels.find(([ar, en]) => ar === text || en === text);
  return match ? (language === "en" ? match[1] : match[0]) : text;
}

const emptyStudentForm = {
  full_name: "",
  student_code: "",
  scan_serial: "",
  phone: "",
  guardian_phone: "",
  gender: "unknown" as const,
  national_id: "",
  group_id: "",
  is_active: true
};

function AcademicManager({
  kind,
  session,
  t
}: {
  kind: "groups" | "students";
  session: TeacherSession;
  t: Translator;
}) {
  const language: Language = document.documentElement.lang === "en" ? "en" : "ar";
  const [groups, setGroups] = useState<AdminGroup[]>([]);
  const [students, setStudents] = useState<AdminStudent[]>([]);
  const [centers, setCenters] = useState<Array<{ id: number; name: string }>>([]);
  const [groupForm, setGroupForm] = useState(emptyGroupForm);
  const [studentForm, setStudentForm] = useState(emptyStudentForm);
  const [scheduleRows, setScheduleRows] = useState<ScheduleDraft[]>([defaultScheduleDraft()]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [saveState, setSaveState] = useState<"idle" | "loading" | "success">("idle");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [showStudents, setShowStudents] = useState(false);
  const [statusFilter, setStatusFilter] = useState<RecordStatusFilter>("active");
  const [groupDetails, setGroupDetails] = useState<any>(null);
  const [detailFilter, setDetailFilter] = useState<RecordStatusFilter>("all");
  const [studentSearch, setStudentSearch] = useState("");
  const [profileStudentId, setProfileStudentId] = useState<number | null>(null);
  const [profilePickerId, setProfilePickerId] = useState("");
  const [profileScanValue, setProfileScanValue] = useState("");
  const [profileScanStatus, setProfileScanStatus] = useState("");
  const [profileScanLoading, setProfileScanLoading] = useState(false);
  const profileScanRef = useRef<HTMLInputElement>(null);

  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` };

  async function loadData() {
    const groupResponse = await fetch(`${API_BASE_URL}/admin/groups`, { headers });
    const groupData = (await groupResponse.json()) as { ok: boolean; groups?: AdminGroup[]; centers?: Array<{ id: number; name: string }> };
    if (!groupResponse.ok || !groupData.ok) throw new Error(t("errors.loginFailed"));
    setGroups(groupData.groups || []);
    setCenters(groupData.centers || []);
    if (!groupForm.center_id && groupData.centers?.[0]) setGroupForm((value) => ({ ...value, center_id: String(groupData.centers![0].id) }));

    const params = new URLSearchParams({ status: statusFilter });
    if (studentSearch.trim()) params.set("q", studentSearch.trim());
    const studentResponse = await fetch(`${API_BASE_URL}/admin/students?${params.toString()}`, { headers });
    const studentData = (await studentResponse.json()) as { ok: boolean; students?: AdminStudent[] };
    if (!studentResponse.ok || !studentData.ok) throw new Error(t("errors.loginFailed"));
    setStudents(studentData.students || []);
  }

  useEffect(() => {
    loadData().catch((error) => setStatus(error instanceof Error ? error.message : t("errors.loginFailed")));
  }, [statusFilter, studentSearch]);

  function resetForm() {
    setEditingId(null);
    setStatus("");
    setFieldErrors({});
    setGroupForm({ ...emptyGroupForm, center_id: centers[0] ? String(centers[0].id) : "" });
    setStudentForm(emptyStudentForm);
    setScheduleRows([defaultScheduleDraft()]);
  }

  async function editGroup(group: AdminGroup) {
    setLoading(true);
    setStatus("");
    try {
      const response = await fetch(`${API_BASE_URL}/admin/groups/${group.id}/details`, { headers });
      const data = (await response.json()) as { ok: boolean; group?: AdminGroup; schedules?: AdminGroup["schedules"] };
      if (!response.ok || !data.ok) throw new Error(t("errors.loginFailed"));

      const savedGroup = data.group || group;
      const savedSchedules = Array.isArray(data.schedules)
        ? data.schedules
        : Array.isArray(savedGroup.schedules) ? savedGroup.schedules : [];
      const firstSchedule = savedSchedules[0] || savedGroup;
      const scheduleRowsFromGroup = savedSchedules.length
        ? savedSchedules.map((schedule) => ({
            id: schedule.id,
            day_of_week: String(schedule.day_of_week),
            start_time: String(schedule.start_time || "").slice(0, 5),
            end_time: String(schedule.end_time || "").slice(0, 5),
            opens_before_minutes: String(schedule.opens_before_minutes ?? 3),
            closes_after_minutes: String(schedule.closes_after_minutes ?? 20),
            is_active: schedule.is_active !== false
          }))
        : savedGroup.day_of_week != null && savedGroup.start_time && savedGroup.end_time
          ? [{
              day_of_week: String(savedGroup.day_of_week),
              start_time: String(savedGroup.start_time).slice(0, 5),
              end_time: String(savedGroup.end_time).slice(0, 5),
              opens_before_minutes: String(savedGroup.opens_before_minutes ?? 3),
              closes_after_minutes: String(savedGroup.closes_after_minutes ?? 20),
              is_active: savedGroup.is_active
            }]
          : [];
      setEditingId(savedGroup.id);
      setGroupForm({
        name: savedGroup.name,
        grade: savedGroup.grade_level || savedGroup.grade,
        subject: savedGroup.subject,
        center_id: String(savedGroup.center_id),
        day_of_week: firstSchedule?.day_of_week == null ? "" : String(firstSchedule.day_of_week),
        start_time: firstSchedule?.start_time ? String(firstSchedule.start_time).slice(0, 5) : "",
        end_time: firstSchedule?.end_time ? String(firstSchedule.end_time).slice(0, 5) : "",
        opens_before_minutes: String(firstSchedule?.opens_before_minutes ?? 3),
        closes_after_minutes: String(firstSchedule?.closes_after_minutes ?? 20),
        fees_amount: String(savedGroup.fees_amount ?? 0),
        is_active: savedGroup.is_active
      });
      setScheduleRows(scheduleRowsFromGroup);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("errors.loginFailed"));
    } finally {
      setLoading(false);
    }
  }

  function editStudent(student: AdminStudent) {
    setEditingId(student.id);
    setFieldErrors({});
    setStudentForm({
      full_name: student.full_name,
      student_code: normalizeAdminStudentCode(student.student_code),
      scan_serial: student.scan_serial || student.student_serial || "",
      phone: student.phone || "",
      guardian_phone: student.guardian_phone || "",
      gender: student.gender || "unknown",
      national_id: "",
      group_id: String(student.group_id),
      is_active: student.is_active
    });
  }

  function updateStudentField(field: keyof typeof emptyStudentForm, value: string) {
    setStudentForm((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setStatus("");
    if (kind === "students") {
      const phone = normalizeDigits(studentForm.phone).trim();
      const guardianPhone = normalizeDigits(studentForm.guardian_phone).trim();
      const nationalId = normalizeDigits(studentForm.national_id).trim();
      const errors: Record<string, string> = {};
      if (!studentForm.full_name.trim()) errors.full_name = t("admin.fieldRequired");
      if (!studentForm.student_code.trim()) errors.student_code = t("admin.fieldRequired");
      if (!studentForm.scan_serial.trim()) errors.scan_serial = t("admin.generateCodeSerial");
      if (!guardianPhone) errors.guardian_phone = t("admin.fieldRequired");
      if (!studentForm.group_id) errors.group_id = t("admin.fieldRequired");
      if (phone && !/^\d{11}$/.test(phone)) errors.phone = t("errors.phoneLength");
      if (guardianPhone && !/^\d{11}$/.test(guardianPhone)) errors.guardian_phone = t("errors.phoneLength");
      if (nationalId && !/^\d{14}$/.test(nationalId)) errors.national_id = t("errors.nationalIdLength");
      setFieldErrors(errors);
      if (Object.keys(errors).length) return;
      setStudentForm((value) => ({ ...value, phone, guardian_phone: guardianPhone, national_id: nationalId }));
    }
    setLoading(true);
    setSaveState("loading");
    const saveStartedAt = Date.now();
    try {
      const isGroup = kind === "groups";
      const normalizedStudentForm = {
        ...studentForm,
        student_code: normalizeAdminStudentCode(studentForm.student_code),
        phone: normalizeDigits(studentForm.phone).trim(),
        guardian_phone: normalizeDigits(studentForm.guardian_phone).trim(),
        national_id: normalizeDigits(studentForm.national_id).trim()
      };
      const payload = isGroup
        ? {
            ...groupForm,
            center_id: Number(groupForm.center_id),
            fees_amount: Number(groupForm.fees_amount),
            schedules: scheduleRows.map((row) => ({ ...row, day_of_week: Number(row.day_of_week), opens_before_minutes: Number(row.opens_before_minutes), closes_after_minutes: Number(row.closes_after_minutes) }))
          }
        : { ...normalizedStudentForm, group_id: Number(normalizeDigits(studentForm.group_id)) };
      const response = await fetch(
        `${API_BASE_URL}/admin/${isGroup ? "groups" : "students"}${editingId ? `/${editingId}` : ""}`,
        { method: editingId ? "PUT" : "POST", headers, body: JSON.stringify(payload) }
      );
      const data = (await response.json()) as { ok: boolean; status?: string; student?: { student_code?: string } };
      if (!response.ok || !data.ok) throw new Error(adminApiErrorMessage(data.status, t));
      await loadData();
      const remainingLoadingTime = 1200 - (Date.now() - saveStartedAt);
      if (remainingLoadingTime > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, remainingLoadingTime));
      }
      resetForm();
      setStatus(isGroup ? t("admin.groupSaved") : "");
      setSaveState("success");
      window.setTimeout(() => setSaveState("idle"), 2000);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("errors.loginFailed"));
      setSaveState("idle");
    } finally {
      setLoading(false);
    }
  }

  function toggleScheduleDay(day: string) {
    const exists = scheduleRows.some((row) => row.day_of_week === day);
    if (exists) {
      if (scheduleRows.length === 1) return;
      setScheduleRows(scheduleRows.filter((row) => row.day_of_week !== day));
    } else if (scheduleRows.length < 3) {
      setScheduleRows([...scheduleRows, defaultScheduleDraft(day)]);
    } else {
      setStatus("يمكن اختيار 3 أيام فقط كحد أقصى / You can select up to 3 days only.");
    }
  }

  async function updateStatus(id: number, isActive: boolean, resource: "groups" | "students") {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/admin/${resource}/${id}/status`, {
        method: "PATCH", headers, body: JSON.stringify({ is_active: isActive })
      });
      const data = (await response.json()) as { ok: boolean; status?: string };
      if (!response.ok || !data.ok) throw new Error(adminApiErrorMessage(data.status, t));
      await loadData();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("errors.loginFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function deleteGroup(id: number) {
    const confirmed = window.confirm("هل أنت متأكد من حذف المجموعة؟ / Are you sure you want to delete this group?");
    if (!confirmed) return;
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/admin/groups/${id}`, { method: "DELETE", headers });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        const reason = data.status === "group_has_students"
          ? "لا يمكن حذف مجموعة بها طلاب. قم بنقل الطلاب أو تعطيل المجموعة. / Cannot delete a group that has students. Move students or disable the group."
          : data.message || data.status || t("errors.loginFailed");
        throw new Error(reason);
      }
      await loadData();
    } catch (error) { setStatus(error instanceof Error ? error.message : t("errors.loginFailed")); }
    finally { setLoading(false); }
  }

  async function deleteStudent(id: number) {
    if (session.teacher.role !== "admin") return;
    if (!window.confirm("هل أنت متأكد من أرشفة هذا الطالب؟ / Are you sure you want to archive this student?")) return;
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/admin/students/${id}`, { method: "DELETE", headers });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(t("errors.loginFailed"));
      await loadData();
    } catch (error) { setStatus(error instanceof Error ? error.message : t("errors.loginFailed")); }
    finally { setLoading(false); }
  }

  async function permanentlyDeleteStudent(id: number) {
    if (session.teacher.role !== "admin") return;
    if (!window.confirm(t("admin.permanentDeleteConfirm"))) return;
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/admin/students/${id}/permanent`, { method: "DELETE", headers });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.message || t("errors.loginFailed"));
      await loadData();
      setStatus("Student personal data anonymized / تم إخفاء بيانات الطالب الشخصية");
    } catch (error) { setStatus(error instanceof Error ? error.message : t("errors.loginFailed")); }
    finally { setLoading(false); }
  }

  async function restoreStudent(id: number) {
    setLoading(true);
    try { const response=await fetch(`${API_BASE_URL}/admin/students/${id}/restore`,{method:"PATCH",headers}); const data=await response.json(); if(!response.ok||!data.ok)throw new Error(t("errors.loginFailed")); await loadData(); }
    catch(error){setStatus(error instanceof Error?error.message:t("errors.loginFailed"));} finally{setLoading(false);}
  }

  async function openGroupDetails(groupId: number) {
    try { const response=await fetch(`${API_BASE_URL}/admin/groups/${groupId}/details`,{headers}); const data=await response.json(); if(!response.ok||!data.ok)throw new Error(t("errors.loginFailed")); setDetailFilter("all"); setGroupDetails(data); }
    catch(error){setStatus(error instanceof Error?error.message:t("errors.loginFailed"));}
  }

  async function openStudentProfileFromScan() {
    if (profileScanLoading) return;
    const value = normalizeScanValue(profileScanValue);
    setProfileScanValue("");
    setProfileScanStatus("");
    if (!value) {
      setProfileScanStatus(t("scanner.scanRequired"));
      profileScanRef.current?.focus();
      return;
    }

    setProfileScanLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/admin/students?status=all&q=${encodeURIComponent(value)}`, { headers });
      const data = (await response.json()) as { ok: boolean; students?: AdminStudent[] };
      if (!response.ok || !data.ok) throw new Error(t("errors.loginFailed"));
      const student = (data.students || []).find((item) =>
        normalizeScanValue(item.scan_serial) === value ||
        normalizeScanValue(item.student_serial) === value ||
        normalizeScanValue(item.student_code) === value ||
        normalizeScanValue(item.qr_token) === value
      );
      if (!student) {
        setProfileScanStatus(t("scanner.invalidCode"));
        return;
      }
      setProfilePickerId(String(student.id));
      setProfileStudentId(student.id);
      setProfileScanStatus(t("scanner.profileOpened"));
    } catch (error) {
      setProfileScanStatus(error instanceof Error ? error.message : t("errors.loginFailed"));
    } finally {
      setProfileScanLoading(false);
      window.setTimeout(() => profileScanRef.current?.focus(), 0);
    }
  }

  function generateStudentIdentifiers() {
    let candidate = "";
    let attempts = 0;
    do {
      candidate = `A-${String(Math.floor(1000 + Math.random() * 9000))}`;
      attempts += 1;
    } while (students.some((student) => student.student_code === candidate) && attempts < 25);
    const scanSerial = `ABD-${candidate.replace(/-/g, "")}-${String(Math.floor(100000 + Math.random() * 900000))}`;
    setStudentForm((value) => ({ ...value, student_code: candidate, scan_serial: scanSerial }));
    setStatus("تم توليد الكود والسريال / Student code and scan serial generated.");
  }

  async function regenerateScanSerial() {
    if (!editingId || !window.confirm(t("admin.regenerateScanSerialConfirm"))) return;
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/admin/students/${editingId}/regenerate-scan-serial`, { method: "POST", headers });
      const data = await response.json();
      if (!response.ok || !data.ok || !data.student?.scan_serial) throw new Error(t("errors.loginFailed"));
      setStudentForm((value) => ({ ...value, scan_serial: data.student.scan_serial }));
      setStatus(`${t("admin.scanSerial")} / ${t("admin.scanSerial")} updated.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("errors.loginFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function printStudentLabel(student: AdminStudent) {
    const printWindow = window.open("", "_blank", "width=420,height=620");
    if (!printWindow) { setStatus("Please allow pop-ups to print labels / اسمح بالنوافذ المنبثقة للطباعة"); return; }
    try {
      const response = await fetch(`${API_BASE_URL}/admin/students/${student.id}/print-label`, { method: "POST", headers });
      const data = await response.json();
      if (!response.ok || !data.ok || !(data.student?.scan_serial || data.student?.student_serial)) throw new Error(data.status === "label_print_limit_reached" ? "Label print permission or limit reached / انتهت صلاحية أو عدد طباعة الليبل" : t("errors.loginFailed"));
      printWindow.document.write(buildStudentLabelMarkup(data.student)); printWindow.document.close(); printWindow.focus(); setTimeout(() => printWindow.print(), 250); setStatus("Label ready for printing / الليبل جاهز للطباعة");
    } catch (error) { printWindow.close(); setStatus(error instanceof Error ? error.message : t("errors.loginFailed")); }
  }

  function printGeneratedLabel() {
    if (!studentForm.full_name || !studentForm.student_code || !studentForm.scan_serial) return;
    const printWindow = window.open("", "_blank", "width=420,height=620");
    if (!printWindow) { setStatus("Please allow pop-ups to print labels / اسمح بالنوافذ المنبثقة للطباعة"); return; }
    const group = groups.find((item) => String(item.id) === studentForm.group_id);
    printWindow.document.write(buildStudentLabelMarkup({ full_name: studentForm.full_name, student_code: studentForm.student_code, scan_serial: studentForm.scan_serial, grade: group?.grade_level || group?.grade, group_name: group?.display_name || group?.name }));
    printWindow.document.close(); printWindow.focus(); setTimeout(() => printWindow.print(), 250);
    setStatus("Label ready for printing / الليبل جاهز للطباعة");
  }

  return (
    <section className="admin-editor academic-manager">
      {profileStudentId ? <StudentProfileModal studentId={profileStudentId} session={session} t={t} onClose={() => setProfileStudentId(null)} /> : null}
      <div className="section-heading">
        <p className="eyebrow">{t(`admin.tabs.${kind}` as TranslationKey)}</p>
        <h2>{editingId ? t("admin.update") : t(`admin.tabs.${kind}` as TranslationKey)}</h2>
      </div>
      <form onSubmit={save} noValidate={kind === "students"}>
        {kind === "groups" ? (
          <div className="editor-grid">
            <label>{t("admin.groupName")}<input required value={groupForm.name} onChange={(e) => setGroupForm({ ...groupForm, name: e.target.value })} /></label>
            <label>{t("admin.grade")}<select required value={groupForm.grade} onChange={(e) => setGroupForm({ ...groupForm, grade: e.target.value })}><option value="">{t("admin.grade")}</option>{gradeLevels.map(([ar,en]) => <option key={ar} value={ar}>{language === "en" ? en : ar}</option>)}</select></label>
            <label>{t("admin.subject")}<input required value={groupForm.subject} onChange={(e) => setGroupForm({ ...groupForm, subject: e.target.value })} /></label>
            <label>Fees / المصروفات<input required type="text" inputMode="decimal" value={groupForm.fees_amount} onChange={(e) => setGroupForm({ ...groupForm, fees_amount: normalizeDigits(e.target.value) })} /></label>
            <label className="checkbox-label group-active-toggle"><input type="checkbox" checked={groupForm.is_active} onChange={(e) => setGroupForm({ ...groupForm, is_active: e.target.checked })} />{t("admin.groupActive")}</label>
            <div className="schedule-editor"><div className="schedule-days-label">Class days / أيام الحصص (1–3)</div><div className="schedule-day-picker">{[0,1,2,3,4,5,6].map((day)=><label className="checkbox-label" key={day}><input type="checkbox" checked={scheduleRows.some((row)=>row.day_of_week===String(day))} onChange={()=>toggleScheduleDay(String(day))} />{t(`days.${day}` as TranslationKey)}</label>)}</div>{scheduleRows.map((row,index)=><div className="schedule-row" key={row.day_of_week}><strong>{t(`days.${row.day_of_week}` as TranslationKey)}</strong><label>Start / البداية<input required type="time" value={row.start_time} onChange={(e)=>setScheduleRows(scheduleRows.map((item,i)=>i===index?{...item,start_time:e.target.value}:item))} /></label><label>End / النهاية<input required type="time" value={row.end_time} onChange={(e)=>setScheduleRows(scheduleRows.map((item,i)=>i===index?{...item,end_time:e.target.value}:item))} /></label><label>Open before / فتح قبل<input type="number" min="0" value={row.opens_before_minutes} onChange={(e)=>setScheduleRows(scheduleRows.map((item,i)=>i===index?{...item,opens_before_minutes:e.target.value}:item))} /></label><label>Close after / إغلاق بعد<input type="number" min="0" value={row.closes_after_minutes} onChange={(e)=>setScheduleRows(scheduleRows.map((item,i)=>i===index?{...item,closes_after_minutes:e.target.value}:item))} /></label><label className="checkbox-label"><input type="checkbox" checked={row.is_active} onChange={(e)=>setScheduleRows(scheduleRows.map((item,i)=>i===index?{...item,is_active:e.target.checked}:item))} />Active / نشط</label></div>)}</div>
          </div>
        ) : (
          <>
          <div className="editor-grid">
            <label>{t("admin.studentName")}<input required value={studentForm.full_name} onChange={(e) => updateStudentField("full_name", e.target.value)} />{fieldErrors.full_name ? <small className="field-error">{fieldErrors.full_name}</small> : null}</label>
            <label>{t("admin.gender")}<select required value={studentForm.gender} onChange={(e) => setStudentForm({ ...studentForm, gender: e.target.value as "male" | "female" | "unknown" })}><option value="male">{t("admin.male")}</option><option value="female">{t("admin.female")}</option><option value="unknown">{t("admin.unknownGender")}</option></select></label>
            <label>{t("admin.studentCode")}<input required type="text" inputMode="text" autoCapitalize="characters" value={studentForm.student_code} onChange={(e) => updateStudentField("student_code", normalizeAdminStudentCode(e.target.value))} />{fieldErrors.student_code ? <small className="field-error">{fieldErrors.student_code}</small> : null}<div className="serial-actions"><button className="secondary-button compact-button" type="button" onClick={generateStudentIdentifiers} disabled={Boolean(editingId)}>{t("admin.generateCodeSerial")}</button></div></label>
            <label>{t("admin.phone")}<input type="text" inputMode="numeric" value={studentForm.phone} onChange={(e) => updateStudentField("phone", normalizeDigits(e.target.value))} />{fieldErrors.phone ? <small className="field-error">{fieldErrors.phone}</small> : null}</label>
            <label>{t("admin.guardianPhone")}<input required type="text" inputMode="numeric" value={studentForm.guardian_phone} onChange={(e) => updateStudentField("guardian_phone", normalizeDigits(e.target.value))} />{fieldErrors.guardian_phone ? <small className="field-error">{fieldErrors.guardian_phone}</small> : null}</label>
            <label>{t("admin.nationalId")}<input type="text" inputMode="numeric" value={studentForm.national_id} onChange={(e) => updateStudentField("national_id", normalizeDigits(e.target.value))} />{fieldErrors.national_id ? <small className="field-error">{fieldErrors.national_id}</small> : null}</label>
            <label>{t("admin.selectGroup")}<select required value={studentForm.group_id} onChange={(e) => updateStudentField("group_id", e.target.value)}><option value="">{t("admin.selectGroup")}</option>{groups.filter((group) => group.is_active).map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select>{fieldErrors.group_id ? <small className="field-error">{fieldErrors.group_id}</small> : null}</label>
            <label className="checkbox-label"><input type="checkbox" checked={studentForm.is_active} onChange={(e) => setStudentForm({ ...studentForm, is_active: e.target.checked })} />{t("admin.active")}</label>
          </div>
          <section className="student-label-details" aria-label={t("admin.labelDetails")}>
            <div className="section-heading"><p className="eyebrow">{t("admin.labelDetails")}</p><h3>{t("admin.labelDetails")}</h3></div>
            <div className="label-detail-grid">
              <div><span>{t("admin.loginCode")}</span><strong>{studentForm.student_code || "—"}</strong></div>
              <div><span>{t("admin.scanSerial")}</span><strong>{studentForm.scan_serial || "—"}</strong></div>
            </div>
            {studentForm.scan_serial ? <div className="student-label-preview"><strong>{t("admin.labelPreview")}</strong><span>مستر أحمد عبدربه / Mr. Ahmed Abdrabo</span><span>{studentForm.full_name || "Student name"} · {studentForm.student_code}</span><BarcodePreview value={studentForm.scan_serial} displayValue={false} /><strong className="label-preview-serial">{studentForm.scan_serial}</strong><div className="label-actions"><button className="secondary-button compact-button" type="button" onClick={printGeneratedLabel}>{t("admin.printLabel")}</button>{editingId ? <button className="secondary-button compact-button" type="button" onClick={regenerateScanSerial} disabled={loading}>{t("admin.regenerateScanSerial")}</button> : null}</div></div> : <><p className="field-hint">{t("admin.generateCodeSerial")}</p>{fieldErrors.scan_serial ? <small className="field-error">{fieldErrors.scan_serial}</small> : null}</>}
          </section>
          </>
        )}
        <div className="form-actions"><button className={`primary-button compact-button ${saveState === "success" ? "success-button" : ""}`} type="submit" disabled={loading}>{saveState === "loading" ? t(editingId ? "admin.updating" : "admin.creating") : saveState === "success" ? t(editingId ? "admin.updated" : "admin.created") : editingId ? t("admin.update") : t("admin.create")}</button>{editingId ? <button className="secondary-button compact-button" type="button" onClick={resetForm}>{t("admin.cancel")}</button> : null}</div>
      </form>

      {kind === "students" && session.teacher.role === "admin" ? <div className="student-list-toolbar"><div className="status-filter-buttons">{(["active","disabled","deleted","all"] as RecordStatusFilter[]).map((filter)=><button key={filter} className={statusFilter===filter?"active":""} type="button" onClick={()=>setStatusFilter(filter)}>{filter==="active"?"Active / النشط":filter==="disabled"?"Disabled / المعطل":filter==="deleted"?"Deleted / المحذوف":"All / الكل"}</button>)}</div><button className="secondary-button student-list-toggle" type="button" onClick={() => setShowStudents((value) => !value)}>{showStudents ? `${t("admin.hideStudents")} ▲` : `${t("admin.showStudents")} ▼`}</button></div> : null}

      {kind === "students" ? <label className="student-search-field">{t("admin.searchStudents")}<input value={studentSearch} onChange={(e) => setStudentSearch(normalizeDigits(e.target.value))} placeholder={t("admin.searchStudents")} /></label> : null}
      {kind === "students" ? <div className="student-profile-picker">
        <div className="student-profile-scan">
            <input
            ref={profileScanRef}
            dir="ltr"
            value={profileScanValue}
            onChange={(event) => setProfileScanValue(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void openStudentProfileFromScan(); } }}
            placeholder={t("scanner.scanProfilePlaceholder")}
            aria-label={t("scanner.scanProfilePlaceholder")}
            autoComplete="off"
            disabled={profileScanLoading}
          />
          <button className="secondary-button compact-button scanner-action-button" type="button" onClick={() => void openStudentProfileFromScan()} disabled={profileScanLoading || !profileScanValue.trim()}>
            <span className="barcode-icon" aria-hidden="true">▥</span>
            {profileScanLoading ? t("dashboard.refreshing") : t("admin.tabs.scanner")}
          </button>
        </div>
        <div className="student-profile-select">
          <select value={profilePickerId} onChange={(e) => setProfilePickerId(e.target.value)}>
            <option value="">{t("admin.viewProfile")}</option>
            {students.map((student) => <option key={student.id} value={student.id}>{student.full_name} · {student.student_code}</option>)}
          </select>
        </div>
        <button className="secondary-button compact-button profile-open-button" type="button" disabled={!profilePickerId} onClick={() => setProfileStudentId(Number(profilePickerId))}>{t("admin.viewProfile")}</button>
        {profileScanStatus ? <small className={`profile-scan-status ${profileScanStatus === t("scanner.profileOpened") ? "success" : "error"}`} role="status">{profileScanStatus}</small> : null}
      </div> : null}
      {kind === "groups" || showStudents ? <div className="academic-list">
        {kind === "groups" ? groups.map((group) => <article className="academic-row" key={group.id}><div><strong>{group.display_name || group.name}</strong><span>{group.grade_level || group.grade} · {group.subject} · {group.day_of_week != null && group.start_time && group.end_time ? `${t(`days.${group.day_of_week}` as TranslationKey)} ${group.start_time.slice(0, 5)} - ${group.end_time.slice(0, 5)} · ` : ""}{group.fees_amount ?? 0} EGP</span><span className="student-count-badge">Students / عدد الطلاب: {group.students_count ?? 0}</span></div><span className={group.is_active ? "status-active" : "status-disabled"}>{group.is_active ? t("admin.active") : t("admin.disabled")}</span><div className="row-actions"><button className="secondary-button compact-button" type="button" onClick={() => openGroupDetails(group.id)}>Details / التفاصيل</button><button className="secondary-button compact-button" type="button" onClick={() => editGroup(group)}>{t("admin.editGroup")}</button><button className="secondary-button compact-button" type="button" disabled={loading} onClick={() => updateStatus(group.id, !group.is_active, "groups")}>{group.is_active ? t("admin.disable") : t("admin.enable")}</button><button className="secondary-button compact-button" type="button" disabled={loading} onClick={() => deleteGroup(group.id)}>Delete / حذف</button></div></article>) : students.map((student) => <article className="academic-row" key={student.id}><div><strong>{student.full_name}</strong><span>{student.student_serial || student.student_code} · {student.group_name} · {student.guardian_phone}</span>{student.deleted_at && purgeDaysLeft(student.purge_after) !== null ? <small className="purge-countdown">{t("admin.purgeDaysLeft", { days: String(purgeDaysLeft(student.purge_after)) })}</small> : null}</div><span className={student.deleted_at ? "status-deleted" : student.is_active ? "status-active" : "status-disabled"}>{recordStatusLabel(student, t)}</span><div className="row-actions">{student.deleted_at ? <><button className="secondary-button compact-button" type="button" disabled={loading || !student.purge_after} onClick={() => restoreStudent(student.id)}>{t("admin.restore")}</button><button className="danger-button compact-button" type="button" disabled={loading} onClick={() => permanentlyDeleteStudent(student.id)}>{t("admin.permanentDelete")}</button></> : <><button className="secondary-button compact-button" type="button" onClick={() => editStudent(student)}>{t("admin.editUser")}</button>{student.qr_token ? <button className="secondary-button compact-button" type="button" disabled={loading} onClick={() => printStudentLabel(student)}>Print Label / طباعة الليبل</button> : null}<button className="secondary-button compact-button" type="button" disabled={loading} onClick={() => updateStatus(student.id, !student.is_active, "students")}>{student.is_active ? t("admin.disable") : t("admin.enable")}</button>{session.teacher.role === "admin" ? <button className="secondary-button compact-button" type="button" disabled={loading} onClick={() => deleteStudent(student.id)}>Delete / حذف</button> : null}</>}</div></article>)}
        {((kind === "groups" && groups.length === 0) || (kind === "students" && students.length === 0)) ? <p className="empty-state">{t(kind === "groups" ? "admin.noGroups" : "admin.noStudents")}</p> : null}
      </div> : null}
      {status ? <p className={status === t("admin.groupSaved") || status === t("admin.studentSaved") ? "lookup-result" : "form-error"}>{status}</p> : null}
      {groupDetails ? <div className="modal-backdrop" role="presentation"><section className="modal group-details-modal" role="dialog" aria-modal="true"><button className="close-button" type="button" onClick={()=>setGroupDetails(null)}>×</button><p className="eyebrow">Group details / تفاصيل المجموعة</p><h2>{groupDetails.group.display_name || groupDetails.group.name}</h2><p>{groupDetails.group.grade_level || groupDetails.group.grade} · {groupDetails.group.subject} · {groupDetails.group.fees_amount} EGP</p><div className="detail-stats"><span>Total: {groupDetails.group.students_count ?? 0}</span><span>Active: {groupDetails.group.active_students_count ?? 0}</span><span>Disabled: {groupDetails.group.disabled_students_count ?? 0}</span><span>Deleted: {groupDetails.group.deleted_students_count ?? 0}</span></div><div className="status-filter-buttons group-details-filters" role="group" aria-label="Student status filters">{(["all","active","disabled","deleted"] as RecordStatusFilter[]).map((filter)=><button key={filter} className={detailFilter===filter?"active":""} type="button" onClick={()=>setDetailFilter(filter)}>{recordStatusFilterLabel(filter,t)}</button>)}</div><div className="schedule-detail-list">{groupDetails.schedules.map((schedule:any)=><span key={schedule.id}>{t(`days.${schedule.day_of_week}` as TranslationKey)} · {schedule.start_time.slice(0,5)}–{schedule.end_time.slice(0,5)}</span>)}</div><div className="academic-list group-student-list">{groupDetails.students.filter((student:any)=>detailFilter==="all"||(detailFilter==="deleted"?student.deleted_at:!student.deleted_at&&(detailFilter==="active"?student.is_active:!student.is_active))).map((student:any)=><article className="academic-row group-student-row" key={student.id}><div className="group-student-info"><div className="group-student-heading"><strong>{student.full_name}</strong><span className={student.deleted_at?"status-deleted":student.is_active?"status-active":"status-disabled"}>{recordStatusLabel(student,t)}</span></div><span>Code / الكود: {student.student_serial || student.student_code || "—"}</span><span>Phone / الهاتف: {student.phone || "—"} · Guardian / ولي الأمر: {student.guardian_phone || "—"}</span></div></article>)}</div></section></div> : null}
    </section>
  );
}

function StudentProfileModal({ studentId, session, t, onClose }: { studentId: number; session: TeacherSession; t: Translator; onClose: () => void }) {
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [labelPrinting, setLabelPrinting] = useState(false);
  const [serialRegenerating, setSerialRegenerating] = useState(false);
  const [noteBody, setNoteBody] = useState("");
  const [editingNoteId, setEditingNoteId] = useState<number | null>(null);
  const auth = { Authorization: `Bearer ${session.token}` };
  const language: Language = document.documentElement.lang === "en" ? "en" : "ar";

  async function loadProfile() {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/admin/students/${studentId}/profile`, { headers: auth });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(t("admin.profileLoadFailed"));
      setProfile(data);
      setStatus("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("admin.profileLoadFailed"));
    } finally { setLoading(false); }
  }

  useEffect(() => { loadProfile().catch(() => undefined); }, [studentId]);

  async function saveNote(event: React.FormEvent) {
    event.preventDefault();
    const body = noteBody.trim();
    if (!body) return;
    const url = editingNoteId ? `${API_BASE_URL}/admin/students/${studentId}/notes/${editingNoteId}` : `${API_BASE_URL}/admin/students/${studentId}/notes`;
    const response = await fetch(url, { method: editingNoteId ? "PUT" : "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ body }) });
    const data = await response.json();
    if (!response.ok || !data.ok) { setStatus(t("admin.profileLoadFailed")); return; }
    setNoteBody(""); setEditingNoteId(null); await loadProfile();
  }

  async function deleteNote(noteId: number) {
    if (!window.confirm(t("admin.deleteNote"))) return;
    const response = await fetch(`${API_BASE_URL}/admin/students/${studentId}/notes/${noteId}`, { method: "DELETE", headers: auth });
    if (response.ok) await loadProfile(); else setStatus(t("admin.profileLoadFailed"));
  }

  async function printProfileLabel() {
    if (!profile?.student || labelPrinting) return;
    const printWindow = window.open("", "_blank", "width=420,height=620");
    if (!printWindow) { setStatus("Please allow pop-ups to print labels / اسمح بالنوافذ المنبثقة للطباعة"); return; }
    setLabelPrinting(true);
    try {
      const response = await fetch(`${API_BASE_URL}/admin/students/${studentId}/print-label`, { method: "POST", headers: auth });
      const data = await response.json();
      if (!response.ok || !data.ok || !(data.student?.scan_serial || data.student?.student_serial)) throw new Error(data.status === "label_print_limit_reached" ? "Label print permission or limit reached / انتهت صلاحية أو عدد طباعة الليبل" : t("errors.loginFailed"));
      printWindow.document.write(buildStudentLabelMarkup(data.student));
      printWindow.document.close();
      printWindow.focus();
      setTimeout(() => printWindow.print(), 250);
    } catch (error) {
      printWindow.close();
      setStatus(error instanceof Error ? error.message : t("errors.loginFailed"));
    } finally { setLabelPrinting(false); }
  }

  async function regenerateProfileScanSerial() {
    if (session.teacher.role !== "admin" || serialRegenerating || !window.confirm(t("admin.regenerateScanSerialConfirm"))) return;
    setSerialRegenerating(true);
    try {
      const response = await fetch(`${API_BASE_URL}/admin/students/${studentId}/regenerate-scan-serial`, { method: "POST", headers: auth });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(t("errors.loginFailed"));
      await loadProfile();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("errors.loginFailed"));
    } finally { setSerialRegenerating(false); }
  }

  const money = (value: unknown) => `${Number(value || 0).toFixed(2)} EGP`;
  return <div className="modal-backdrop" role="presentation"><section className="modal student-profile-modal" role="dialog" aria-modal="true" aria-label={t("admin.studentProfile")}>
    <button className="close-button" type="button" onClick={onClose}>×</button>
    {loading ? <p className="empty-state">{t("admin.profileLoading")}</p> : profile ? <>
      <div className="section-heading"><p className="eyebrow">{t("admin.studentProfile")}</p><h2>{profile.student.full_name}</h2></div>
      <section className="profile-section"><h3>{t("admin.basicInfo")}</h3><div className="profile-info-grid">
        <span><b>{t("admin.studentName")}</b>{profile.student.full_name}</span><span><b>{t("admin.studentCode")}</b>{profile.student.student_code || "—"}</span><span><b>{t("admin.scanSerial")}</b>{profile.student.scan_serial || "—"}</span><span><b>{t("admin.selectGroup")}</b>{profile.student.group_name || "—"}</span><span><b>{t("admin.grade")}</b>{profile.student.grade || "—"}</span><span><b>{t("admin.phone")}</b>{profile.student.phone || "—"}</span><span><b>{t("admin.guardianPhone")}</b>{profile.student.guardian_phone || "—"}</span><span><b>{t("admin.active")}</b>{recordStatusLabel(profile.student, t)}</span>
      </div></section>
      <section className="profile-section profile-label-section"><h3>{t("admin.labelDetails")}</h3><div className="profile-label-card"><StudentLabelPreview student={profile.student} /><div className="label-actions"><button className="secondary-button compact-button" type="button" onClick={printProfileLabel} disabled={labelPrinting || !labelScanSerial(profile.student)}>{labelPrinting ? t("admin.printingLabel") : t("admin.printLabel")}</button>{session.teacher.role === "admin" ? <button className="secondary-button compact-button" type="button" onClick={regenerateProfileScanSerial} disabled={serialRegenerating}>{serialRegenerating ? t("admin.updating") : t("admin.regenerateScanSerial")}</button> : null}</div></div></section>
      <section className="profile-section"><h3>{t("admin.attendanceSummary")}</h3><div className="profile-stat-grid"><span><b>{t("admin.totalSessions")}</b>{profile.attendance.total_sessions}</span><span><b>{t("admin.presentCount")}</b>{profile.attendance.present_count}</span><span><b>{t("admin.absentCount")}</b>{profile.attendance.absent_count}</span><span><b>{t("admin.attendancePercentage")}</b>{Number(profile.attendance.attendance_percentage || 0).toFixed(1)}%</span></div><h4>{t("admin.attendanceRecords")}</h4>{profile.attendance.records?.length ? <div className="profile-record-list">{profile.attendance.records.map((row: any) => <div key={`${row.session_id}-${row.session_date}`}><span>{row.session_date} · {row.start_time?.slice(0, 5)}–{row.end_time?.slice(0, 5)}</span><AttendanceStatusBadge status={row.status} t={t} /></div>)}</div> : <p className="empty-state">{t("admin.noProfileAttendance")}</p>}</section>
      <section className="profile-section"><h3>{t("admin.examHistory")}</h3>{profile.exams?.length ? <div className="profile-record-list profile-exam-list">{profile.exams.map((row: any) => { const evaluation = scoreEvaluation(row.score, row.max_score, t); return <div className="profile-exam-record" key={row.id}><div className="profile-exam-details"><strong>{displayValue(row.title, language)}</strong><small>{t("dashboard.latestExamDate")}: {formatDateOnly(String(row.exam_date || ""), language, "—")}</small>{row.note ? <small>{t("admin.assessment")}: {displayValue(row.note, language)}</small> : null}</div><div className="profile-exam-score">{row.score == null ? <strong>—</strong> : <><strong className={`score-value score-${evaluation?.tone || ""}`}>{row.score}/{row.max_score}</strong>{evaluation ? <small className={`profile-exam-evaluation score-${evaluation.tone}`}>{evaluation.percentage.toFixed(0)}% — {evaluation.label}</small> : null}</>}</div></div>; })}</div> : <p className="empty-state">{t("admin.noProfileExams")}</p>}</section>
      <section className="profile-section"><h3>{t("admin.notes")}</h3><form className="profile-note-form" onSubmit={saveNote}><textarea value={noteBody} onChange={(e) => setNoteBody(e.target.value)} placeholder={t("admin.notePlaceholder")} rows={3} /><button className="secondary-button compact-button" type="submit">{editingNoteId ? t("admin.editNote") : t("admin.addNote")}</button></form>{profile.notes?.length ? <div className="profile-record-list">{profile.notes.map((note: any) => <div key={note.id}><span>{note.body}<small>{note.author_name} · {new Date(note.created_at).toLocaleString()}</small></span><div className="row-actions"><button className="secondary-button compact-button" type="button" onClick={() => { setEditingNoteId(Number(note.id)); setNoteBody(note.body); }}>{t("admin.editNote")}</button><button className="secondary-button compact-button" type="button" onClick={() => deleteNote(Number(note.id))}>{t("admin.deleteNote")}</button></div></div>)}</div> : <p className="empty-state">{t("admin.noProfileNotes")}</p>}</section>
      <section className="profile-section"><h3>{t("admin.feesSummary")}</h3><div className="profile-stat-grid"><span><b>{t("admin.monthlyFee")}</b>{money(profile.fees.fees_amount)}</span><span><b>{t("admin.requiredFees")}</b>{money(profile.fees.required_amount)}</span><span><b>{t("admin.paidFees")}</b>{money(profile.fees.paid_amount)}</span><span><b>{t("admin.remainingFees")}</b>{money(profile.fees.remaining_balance)}</span></div><h4>{t("admin.overdueMonths")}</h4><p>{(profile.fees.monthly_dues || []).filter((due: any) => Number(due.remaining_amount) > 0).map((due: any) => String(due.month).slice(0, 7)).join(" · ") || "—"}</p><h4>{t("admin.paymentHistory")}</h4>{profile.fees.payments?.length ? <div className="profile-record-list">{profile.fees.payments.map((row: any) => <div key={row.id}><span>{new Date(row.paid_at || row.payment_date).toLocaleString()} · {row.paid_by || "—"}</span><strong>{money(row.amount)}</strong></div>)}</div> : <p className="empty-state">{t("admin.noProfilePayments")}</p>}</section>
      <section className="profile-section"><h3>{t("admin.profileMessages")}</h3>{profile.inbox?.length ? <div className="profile-record-list">{profile.inbox.map((row: any) => <div key={row.id}><span>{row.subject}<small>{row.last_message || "—"}</small></span><strong>{row.message_count}</strong></div>)}</div> : <p className="empty-state">{t("admin.noProfileMessages")}</p>}</section>
    </> : <p className="form-error">{status || t("admin.profileLoadFailed")}</p>}
    {status && profile ? <p className="form-error">{status}</p> : null}
  </section></div>;
}

function AttendancePanel({ session, language, t }: { session: TeacherSession; language: Language; t: Translator }) {
  const [date, setDate] = useState(localDateInputValue());
  const [sessions, setSessions] = useState<any[]>([]);
  const [students, setStudents] = useState<any[]>([]);
  const [records, setRecords] = useState<any[]>([]);
  const [selected, setSelected] = useState("");
  const [status, setStatus] = useState("");
  const [rowFeedback, setRowFeedback] = useState<Record<number, string>>({});
  const headers = { Authorization: `Bearer ${session.token}` };
  async function load() { const [sr, st] = await Promise.all([fetch(`${API_BASE_URL}/admin/attendance/sessions?date=${date}`, { headers }), fetch(`${API_BASE_URL}/admin/students`, { headers })]); const sd = await sr.json(), td = await st.json(); setSessions(Array.isArray(sd.sessions) ? sd.sessions : []); setStudents(Array.isArray(td.students) ? td.students : []); setSelected(sd.sessions?.[0] ? String(sd.sessions[0].id) : ""); }
  async function loadRecords(id: string) { const r = await fetch(`${API_BASE_URL}/admin/attendance/sessions/${id}/records`, { headers }); const d = await r.json(); setRecords(Array.isArray(d.records) ? d.records : []); }
  useEffect(() => { load().catch(() => setStatus("تعذر تحميل الحضور / Could not load attendance")); }, [date]);
  useEffect(() => { if (selected) loadRecords(selected).catch(() => undefined); else setRecords([]); }, [selected]);
  async function mark(studentId: number, statusValue: string) {
    setRowFeedback((current) => { const next = { ...current }; delete next[studentId]; return next; });
    const response = await fetch(`${API_BASE_URL}/admin/attendance/manual`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ session_id: Number(selected), student_id: studentId, status: statusValue }) });
    const data = await response.json();
    const message = data.ok ? t("attendance.updated") : data.status === "duplicate_attendance" ? t("attendance.alreadyRegistered") : t("attendance.updateFailed");
    setRowFeedback((current) => ({ ...current, [studentId]: message }));
    window.setTimeout(() => setRowFeedback((current) => { const next = { ...current }; delete next[studentId]; return next; }), 3500);
    loadRecords(selected);
  }
  const selectedSession = sessions.find((item) => String(item.id) === selected);
  const groupStudents = students.filter((item) => !selectedSession || item.group_id === selectedSession.group_id);
  return <section className="admin-editor"><div className="section-heading"><p className="eyebrow">{t("admin.tabs.attendance")}</p><h2>Attendance / الحضور</h2></div><label>Date / التاريخ<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label><label>Session / الحصة<select value={selected} onChange={(e) => setSelected(e.target.value)}><option value="">Select session / اختر الحصة</option>{sessions.map((item) => <option key={item.id} value={item.id}>{item.group_name} - {t(`days.${item.day_of_week}` as TranslationKey)} {item.start_time?.slice(0, 5)} إلى {item.end_time?.slice(0, 5)}</option>)}</select></label>{selectedSession ? <p className="field-hint">{formatSessionWindow(selectedSession, language)}</p> : <p className="field-hint">{t("attendance.noRealSessions")}</p>}<div className="academic-list">{groupStudents.map((student) => { const currentStatus = records.find((record) => record.student_id === student.id)?.status || "not_marked"; return <article className="academic-row attendance-row" key={student.id}><div className="student-info"><strong>{student.full_name}</strong><span>{student.student_serial || student.student_code} · {student.group_name} · {student.grade}</span></div><div className="attendance-actions"><div className="attendance-buttons"><button className="secondary-button compact-button" disabled={!selected} onClick={() => mark(student.id, "present")}>Present / حاضر</button><button className="secondary-button compact-button" disabled={!selected} onClick={() => mark(student.id, "absent")}>Absent / غائب</button><AttendanceStatusBadge status={currentStatus} t={t} /></div>{rowFeedback[student.id] ? <small className="attendance-row-feedback">{rowFeedback[student.id]}</small> : null}</div></article>; })}</div>{status ? <p className="form-error">{status}</p> : null}</section>;
}

function ScannerPanel({ session, t }: { session: TeacherSession; t: Translator }) {
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [student, setStudent] = useState<any>(null);
  const [scanState, setScanState] = useState<"idle" | "success" | "error">("idle");
  const [scanning, setScanning] = useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const successMessageTimerRef = React.useRef<number | null>(null);
  useEffect(() => { inputRef.current?.focus(); }, [message, scanning]);
  useEffect(() => () => {
    if (successMessageTimerRef.current !== null) window.clearTimeout(successMessageTimerRef.current);
  }, []);

  async function scan(event: React.FormEvent) {
    event.preventDefault();
    if (scanning) return;
    if (successMessageTimerRef.current !== null) {
      window.clearTimeout(successMessageTimerRef.current);
      successMessageTimerRef.current = null;
    }

    const token = normalizeScanValue(code);
    setCode("");
    setMessage("");
    setStudent(null);
    setScanState("idle");
    if (!token) return;

    setScanning(true);
    try {
      const response = await fetch(`${API_BASE_URL}/scanner/attendance`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.token}`
        },
        body: JSON.stringify({ qr_token: token })
      });
      const rawBody = await response.text();
      let data: { ok?: boolean; status?: string; student?: any } = {};
      try {
        data = rawBody ? JSON.parse(rawBody) : {};
      } catch (_error) {
        data = {};
      }

      setStudent(data.student || null);
      if (response.ok && data.ok) {
        setScanState("success");
        setMessage(t("scanner.recorded"));
        successMessageTimerRef.current = window.setTimeout(() => {
          setMessage("");
          setStudent(null);
          setScanState("idle");
          successMessageTimerRef.current = null;
          inputRef.current?.focus();
        }, 1800);
      } else {
        setScanState("error");
        setMessage(scannerStatusMessage(String(data.status || ""), t));
      }
    } catch (_error) {
      setScanState("error");
      setMessage(t("scanner.networkError"));
    } finally {
      setScanning(false);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }
  return (
    <section className="admin-editor scanner-panel">
      <div className="section-heading">
        <p className="eyebrow">{t("admin.tabs.scanner")}</p>
        <h2>{t("admin.tabs.scanner")}</h2>
      </div>
      <form onSubmit={scan}>
        <label>
          {t("scanner.inputLabel")}
          <input
            ref={inputRef}
            dir="ltr"
            autoFocus
            type="text"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder={t("scanner.inputPlaceholder")}
            autoComplete="off"
            disabled={scanning}
          />
        </label>
        <button className="primary-button" type="submit" disabled={scanning || !code.trim()}>
          {scanning ? t("dashboard.refreshing") : t("scanner.submit")}
        </button>
      </form>
      {student ? (
        <div className={`status-panel ${scanState === "success" ? "success" : "warning"}`}>
          <strong>{student.full_name}</strong>
          <span>{student.student_serial || student.scan_serial || student.student_code} · {student.group_name} · {student.grade_level}</span>
        </div>
      ) : null}
      {message ? <p className={scanState === "success" ? "lookup-result" : "form-error"} role="status">{message}</p> : null}
    </section>
  );
}

function normalizeSearchText(value: unknown) {
  return normalizeDigits(value)
    .trim()
    .trim()
    .toLocaleLowerCase("ar-EG")
    .normalize("NFD")
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ـ/g, "")
    .replace(/\s+/g, " ");
}

function LegacyFeesPanel({ session, t }: { session: TeacherSession; t: Translator }) {
  const [mode, setMode] = useState<"new"|"paid"|"late">("new"); const [code, setCode] = useState(""); const [summary, setSummary] = useState<any>(null); const [status, setStatus] = useState(""); const [payments, setPayments] = useState<any[]>([]); const [overdue, setOverdue] = useState<any[]>([]); const [filter, setFilter] = useState(""); const [from, setFrom] = useState(""); const [to, setTo] = useState(""); const [showDeleted, setShowDeleted] = useState(false);
  const reportRequestId = React.useRef(0);
  async function lookup(event: React.FormEvent) { event.preventDefault(); setStatus(""); setSummary(null); const value=code.trim().toUpperCase(); if(!value){setStatus(t("fees.studentNotFound"));return;} try { const s=await fetch(`${API_BASE_URL}/admin/students`,{headers:{Authorization:`Bearer ${session.token}`}}); const data=await s.json(); if(!s.ok||!data.ok){setStatus(paymentErrorMessage(data.status,data.message,t));return;} const student=(data.students||[]).find((item:any)=>item.scan_serial===value||item.student_serial===value||item.student_code===value||item.qr_token===code.trim()); if(!student){setStatus(t("fees.studentNotFound"));return;} const r=await fetch(`${API_BASE_URL}/admin/fees/summary/${student.id}`,{headers:{Authorization:`Bearer ${session.token}`}}); const d=await r.json(); if(!r.ok||!d.ok){setStatus(paymentErrorMessage(d.status,d.message,t));return;} setSummary(d.summary||null); if(!d.summary)setStatus(t("fees.paymentFailed")); } catch { setStatus(t("fees.paymentFailed")); } }
  async function pay(){ if(!summary)return; if(Number(summary.remaining_balance)<=0){setStatus(Number(summary.required_amount)>0?t("fees.alreadyPaid"):t("fees.noOutstanding"));return;} try { const r=await fetch(`${API_BASE_URL}/admin/fees/payments`,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${session.token}`},body:JSON.stringify({student_id:summary.id})}); const d=await r.json(); if(d.ok){setStatus(t("fees.paymentRecorded"));setSummary({...summary,paid_amount:summary.required_amount,remaining_balance:0});}else setStatus(paymentErrorMessage(d.status,d.message,t)); } catch { setStatus(t("fees.paymentFailed")); } }
  async function loadReports(){ const requestId=++reportRequestId.current; const headers={Authorization:`Bearer ${session.token}`}; const params=new URLSearchParams(); const search=normalizeSearchText(filter); if(search)params.set("search",search); if(from)params.set("from",from); if(to)params.set("to",to); if(showDeleted)params.set("include_deleted","true"); const [p,o]=await Promise.all([fetch(`${API_BASE_URL}/admin/fees/payments?${params}`,{headers}),fetch(`${API_BASE_URL}/admin/fees/overdue?${params}`,{headers})]); const [paymentsData,overdueData]=await Promise.all([p.json(),o.json()]); if(requestId!==reportRequestId.current)return; const nextPayments=paymentsData.payments||[], nextOverdue=overdueData.students||[]; setPayments(nextPayments); setOverdue(nextOverdue); setStatus((mode==="paid"?nextPayments:nextOverdue).length||!search?"":t("fees.noMatchingResults")); }
  useEffect(()=>{if(mode!=="new")loadReports().catch(()=>setStatus("Could not load report / تعذر تحميل التقرير"));},[mode,filter,from,to,showDeleted]);
  const visiblePayments=payments; const visibleOverdue=overdue;
  return <section className="admin-editor fees-panel"><div className="section-heading"><p className="eyebrow">{t("admin.tabs.fees")}</p><h2>{t("fees.title")}</h2></div><div className="internal-tabs"><button className={mode==="new"?"active":""} onClick={()=>setMode("new")}>{t("fees.newPayment")}</button><button className={mode==="paid"?"active":""} onClick={()=>setMode("paid")}>{t("fees.paidPayments")}</button><button className={mode==="late"?"active":""} onClick={()=>setMode("late")}>{t("fees.latePayments")}</button></div>{mode==="new"?<><form onSubmit={lookup}><label>{t("fees.scanStudent")}<input autoFocus dir="ltr" value={code} onChange={(e)=>setCode(e.target.value)} placeholder="A-2303" /></label><button className="primary-button" type="submit">{t("fees.find")}</button></form>{summary?<div className="status-panel success"><strong>{summary.full_name}</strong><span>{summary.student_serial} · {summary.group_name} · {summary.grade_level}</span><span>{t("fees.required")}: {Number(summary.required_amount).toFixed(2)} EGP · {t("fees.paid")}: {Number(summary.paid_amount).toFixed(2)} EGP · {t("fees.remaining")}: {Number(summary.remaining_balance).toFixed(2)} EGP</span><small>{t("fees.fullOnly")}</small><button className="secondary-button" type="button" onClick={pay} disabled={Number(summary.remaining_balance)<=0}>{t("fees.payFull")}</button></div>:null}</>:<><div className="report-filters"><label>Search / بحث<input value={filter} onChange={(e)=>setFilter(e.target.value)} placeholder="Name, serial, group, phone" /></label><label>Date from / من<input type="date" value={from} onChange={(e)=>setFrom(e.target.value)} /></label><label>Date to / إلى<input type="date" value={to} onChange={(e)=>setTo(e.target.value)} /></label><button className="primary-button report-search-button" type="button" onClick={()=>loadReports().catch(()=>setStatus("Could not load report / تعذر تحميل التقرير"))}>{t("fees.find")}</button></div>{mode==="paid"?<><p className="report-total">Total paid / إجمالي المدفوع: {visiblePayments.reduce((sum,row)=>sum+Number(row.amount),0).toFixed(2)} EGP</p><div className="academic-list">{visiblePayments.map((row)=><article className="academic-row" key={row.id}><div><strong>{row.full_name}</strong><span>{row.student_serial} · {row.group_name} · {row.grade_level}</span></div><span>{row.amount} EGP</span><span>{new Date(row.paid_at || row.payment_date).toLocaleString()}</span></article>)}</div></>:<><p className="report-total">Expected unpaid / إجمالي المتأخر: {visibleOverdue.reduce((sum,row)=>sum+Number(row.remaining_balance),0).toFixed(2)} EGP</p><div className="academic-list">{visibleOverdue.map((row)=><article className="academic-row" key={row.id}><div><strong>{row.full_name}</strong><span>{row.student_serial} · {row.group_name} · {row.grade_level} · {row.guardian_phone}</span></div><span>{row.remaining_balance} EGP</span></article>)}</div></>}</>}{status?<p className="lookup-result">{status}</p>:null}</section>;
}

function FeesPanel({ session, t }: { session: TeacherSession; t: Translator }) {
  const [mode, setMode] = useState<"new" | "advance">("new");
  const [code, setCode] = useState("");
  const [summary, setSummary] = useState<any>(null);
  const [advanceData, setAdvanceData] = useState<any>(null);
  const [selectedMonths, setSelectedMonths] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const auth = { Authorization: `Bearer ${session.token}` };

  async function lookup(event: React.FormEvent) {
    event.preventDefault();
    setStatus("");
    setSummary(null);
    setAdvanceData(null);
    setSelectedMonths([]);
    const value = normalizeScanValue(code);
    if (!value) {
      setStatus(t("fees.studentNotFound"));
      return;
    }
    setCode("");
    try {
      const response = await fetch(`${API_BASE_URL}/admin/students?status=all&q=${encodeURIComponent(value)}`, { headers: auth });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        setStatus(paymentErrorMessage(data.status, data.message, t));
        return;
      }
      const student = (data.students || []).find((item: any) => !item.deleted_at && (
        normalizeScanValue(item.scan_serial) === value ||
        normalizeScanValue(item.student_serial) === value ||
        normalizeScanValue(item.student_code) === value ||
        normalizeScanValue(item.qr_token) === value
      ));
      if (!student) {
        setStatus(t("fees.studentNotFound"));
        return;
      }
      const endpoint = mode === "advance"
        ? `${API_BASE_URL}/admin/fees/advance-options/${student.id}`
        : `${API_BASE_URL}/admin/fees/summary/${student.id}`;
      const detailsResponse = await fetch(endpoint, { headers: auth });
      const details = await detailsResponse.json();
      if (!detailsResponse.ok || !details.ok) {
        setStatus(paymentErrorMessage(details.status, details.message, t));
        return;
      }
      if (mode === "advance") setAdvanceData(details);
      else setSummary(details.summary || null);
    } catch {
      setStatus(mode === "advance" ? t("fees.advanceFailed") : t("fees.paymentFailed"));
    }
  }

  async function pay() {
    if (!summary) return;
    if (Number(summary.remaining_balance) <= 0) {
      setStatus(Number(summary.required_amount) > 0 ? t("fees.alreadyPaid") : t("fees.noOutstanding"));
      return;
    }
    try {
      const response = await fetch(`${API_BASE_URL}/admin/fees/payments`, {
        method: "POST", headers: { "Content-Type": "application/json", ...auth }, body: JSON.stringify({ student_id: summary.id })
      });
      const data = await response.json();
      if (!data.ok) { setStatus(paymentErrorMessage(data.status, data.message, t)); return; }
      setStatus(t("fees.paymentRecorded"));
      setSummary({ ...summary, paid_amount: summary.required_amount, remaining_balance: 0, current_cycle_paid: summary.current_cycle_fee, current_cycle_outstanding: 0 });
      window.dispatchEvent(new Event("fees-updated"));
    } catch { setStatus(t("fees.paymentFailed")); }
  }

  async function saveAdvance() {
    if (!advanceData?.student || !selectedMonths.length) return;
    if (selectedMonths.length > 1 && !window.confirm(t("fees.advanceConfirm"))) return;
    try {
      const response = await fetch(`${API_BASE_URL}/admin/fees/advance-payments`, {
        method: "POST", headers: { "Content-Type": "application/json", ...auth },
        body: JSON.stringify({ student_id: advanceData.student.id, months: selectedMonths })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        setStatus(data.status === "month_already_paid" ? t("fees.advanceAlreadyPaid") : t("fees.advanceFailed"));
        return;
      }
      setStatus(t("fees.advanceSaved"));
      setSelectedMonths([]);
      const refresh = await fetch(`${API_BASE_URL}/admin/fees/advance-options/${advanceData.student.id}`, { headers: auth });
      const refreshed = await refresh.json();
      if (refresh.ok && refreshed.ok) setAdvanceData(refreshed);
      window.dispatchEvent(new Event("fees-updated"));
    } catch { setStatus(t("fees.advanceFailed")); }
  }

  const monthlyFee = Number(advanceData?.student?.fees_amount || 0);
  const totalAdvance = selectedMonths.length * monthlyFee;
  const monthLabel = (value: string) => new Date(`${value.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString(document.documentElement.lang === "en" ? "en-US" : "ar-EG", { month: "long", year: "numeric", timeZone: "UTC" });
  const dueMonths = summary && Array.isArray(summary.monthly_dues)
    ? summary.monthly_dues.filter((due: any) => Number(due?.remaining_amount || 0) > 0).map((due: any) => monthLabel(String(due.month))).join(document.documentElement.lang === "en" ? ", " : "، ")
    : "";
  const dueMonthsKey = dueMonths && dueMonths.split(document.documentElement.lang === "en" ? "," : "،").length > 1 ? "fees.dueMonths" : "fees.dueMonth";

  return <section className="admin-editor fees-panel">
    <div className="section-heading"><p className="eyebrow">{t("admin.tabs.fees")}</p><h2>{mode === "advance" ? t("fees.advanceTitle") : t("fees.title")}</h2></div>
    <div className="internal-tabs">
      <button className={mode === "new" ? "active" : ""} type="button" onClick={() => { setMode("new"); setSummary(null); setAdvanceData(null); setSelectedMonths([]); setStatus(""); }}>{t("fees.newPayment")}</button>
      <button className={mode === "advance" ? "active" : ""} type="button" onClick={() => { setMode("advance"); setSummary(null); setAdvanceData(null); setSelectedMonths([]); setStatus(""); }}>{t("fees.advancePayment")}</button>
    </div>
    <form onSubmit={lookup}><label>{t("fees.scanStudent")}<input autoFocus dir="ltr" type="text" value={code} onChange={(event) => setCode(event.target.value)} placeholder="A-2303" autoComplete="off" /></label><button className="primary-button" type="submit">{t("fees.find")}</button></form>
    {mode === "new" && summary ? Number(summary.remaining_balance || 0) <= 0 && Number(summary.current_cycle_outstanding || 0) <= 0 ? <div className="status-panel success paid-summary"><strong>{t("fees.paidStudentName", { name: summary.full_name })}</strong><span className="paid-summary-status">{t("fees.paidStudentStatus")}</span></div> : <div className="status-panel success"><strong>{summary.full_name}</strong><span>{summary.student_serial} · {summary.group_name} · {summary.grade_level}</span>{dueMonths ? <span>{t(dueMonthsKey, { months: dueMonths })}</span> : null}<span>{t("studentFees.currentCycleFee")}: {Number(summary.current_cycle_fee || 0).toFixed(2)} EGP · {t("studentFees.currentCyclePaid")}: {Number(summary.current_cycle_paid || 0).toFixed(2)} EGP · {t("studentFees.currentCycleOutstanding")}: {Number(summary.current_cycle_outstanding || 0).toFixed(2)} EGP</span><span>{t("fees.required")}: {Number(summary.required_amount || 0).toFixed(2)} EGP · {t("fees.paid")}: {Number(summary.paid_amount || 0).toFixed(2)} EGP · {t("fees.remaining")}: {Number(summary.remaining_balance || 0).toFixed(2)} EGP</span><small>{t("fees.fullOnly")}</small><button className="secondary-button" type="button" onClick={pay}>{t("fees.payFull")}</button></div> : null}
    {mode === "advance" && advanceData ? <div className="advance-payment-panel"><div className="status-panel success"><strong>{advanceData.student.full_name}</strong><span>{advanceData.student.student_code} · {advanceData.student.group_name}</span><span>{t("studentFees.monthlyFee")}: {monthlyFee.toFixed(2)} EGP</span></div>{Number(advanceData.current_cycle_outstanding || 0) > 0 ? <p className="form-error advance-lock-message">{t("fees.advanceCurrentMonthUnpaid")}</p> : <><h3>{t("fees.advanceMonths")}</h3><div className="advance-month-grid">{(advanceData.months || []).filter((month: any) => month.available).map((month: any) => <label className="advance-month-option" key={month.month}><input type="checkbox" checked={selectedMonths.includes(month.month.slice(0, 7))} onChange={(event) => setSelectedMonths((current) => event.target.checked ? [...current, month.month.slice(0, 7)] : current.filter((item) => item !== month.month.slice(0, 7)))} /><span>{monthLabel(month.month)}</span><b>{Number(month.remaining_amount).toFixed(2)} EGP</b></label>)}</div>{!(advanceData.months || []).some((month: any) => month.available) ? <p className="empty-state">{t("fees.advanceNoMonths")}</p> : <><p className="advance-total">{t("fees.advanceSelected")}: {selectedMonths.length} · {t("fees.advanceTotal")}: {totalAdvance.toFixed(2)} EGP</p><button className="primary-button" type="button" disabled={!selectedMonths.length} onClick={saveAdvance}>{t("fees.advancePayment")}</button></>}</>}</div> : null}
    {status ? <p className="lookup-result">{status}</p> : null}
  </section>;
}

function auditActionKey(action: string, details: Record<string, unknown> = {}): TranslationKey {
  if (action === "system_request") {
    const path = String(details.path || "");
    if (path.includes("/reset-password")) return "audit.action.userPasswordReset";
    if (path.endsWith("/users") && details.method === "POST") return "audit.action.userCreated";
    if (path.includes("/users/") && details.method === "PUT") return "audit.action.userUpdated";
    if (path.includes("/users/") && details.method === "DELETE") return "audit.action.userArchived";
  }
  const keys: Record<string, TranslationKey> = {
    payment_created: "audit.action.paymentCreated",
    advance_payment_created: "audit.action.advancePaymentCreated",
    payment_reversed: "audit.action.paymentReversed",
    student_created: "audit.action.studentCreated",
    student_updated: "audit.action.studentUpdated",
    student_status_changed: "audit.action.studentStatusChanged",
    student_restored: "audit.action.studentRestored",
    student_archived: "audit.action.studentArchived",
    attendance_recorded: "audit.action.attendanceRecorded",
    message_action: "audit.action.messageAction",
    note_action: "audit.action.noteAction",
    audit_pin_changed: "audit.action.pinChanged",
    audit_logs_unlocked: "audit.action.logsUnlocked",
    audit_pin_failed: "audit.action.pinFailed",
    system_request: "audit.action.systemRequest",
    user_created: "audit.action.userCreated",
    user_updated: "audit.action.userUpdated",
    user_password_reset: "audit.action.userPasswordReset",
    user_status_changed: "audit.action.userStatusChanged",
    user_archived: "audit.action.userArchived"
  };
  return keys[action] || "audit.action.systemRequest";
}

function auditDetailLabelKey(key: string): TranslationKey | null {
  const keys: Record<string, TranslationKey> = {
    body: "audit.detail.body", path: "audit.detail.path", query: "audit.detail.query", method: "audit.detail.method",
    status_code: "audit.detail.statusCode", access_duration_minutes: "audit.detail.accessDuration", reason: "audit.detail.reason",
    original_amount: "audit.detail.originalAmount", payment_date: "audit.detail.paymentDate", payment_type: "audit.detail.paymentType",
    payment_method: "audit.detail.paymentMethod", payment_months: "audit.detail.paymentMonths", reversal_id: "audit.detail.reversalId",
    locked: "audit.detail.locked", pin_digits: "audit.detail.pinDigits"
  };
  return keys[key] || null;
}

function auditDetailText(key: string, value: unknown, language: Language, t: Translator): string {
  if (key === "body") return language === "ar" ? "تم تسجيل البيانات (المعلومات الحساسة مخفية)" : "Data recorded (sensitive values hidden)";
  if (key === "query" && (!value || (typeof value === "object" && Object.keys(value as object).length === 0))) return language === "ar" ? "لا توجد بيانات بحث" : "No search parameters";
  if (key === "path") {
    const path = String(value);
    if (path.includes("/reset-password")) return t("audit.action.userPasswordReset");
    if (path.includes("/fees/payments") && path.includes("/reverse")) return t("audit.action.paymentReversed");
    if (path.endsWith("/fees/payments")) return t("audit.action.paymentCreated");
    if (path.endsWith("/fees/advance-payments")) return t("audit.action.advancePaymentCreated");
  }
  if (key === "method") return ({ GET: language === "ar" ? "عرض" : "View", POST: language === "ar" ? "إضافة" : "Create", PUT: language === "ar" ? "تعديل" : "Update", PATCH: language === "ar" ? "تحديث" : "Update", DELETE: language === "ar" ? "حذف" : "Delete" } as Record<string, string>)[String(value)] || String(value);
  if (key === "status_code") return Number(value) >= 200 && Number(value) < 300 ? (language === "ar" ? "تمت بنجاح" : "Successful") : String(value);
  if (key === "payment_type") return value === "advance" ? t("fees.advancePaymentLabel") : t("fees.normalPayment");
  return formatAuditDetailValue(value, language);
}

function auditNarrativeFromDetails(action: string, details: Record<string, any>, language: Language, t: Translator) {
  const body = details.body && typeof details.body === "object" ? details.body : {};
  const name = String(details.student_name_snapshot || details._student_name || details.full_name || body.full_name || details.student_name || "—");
  const code = String(details.student_code_snapshot || details._student_code || details.student_code || body.student_code || "—");
  const role = body.role ? roleLabel(String(body.role), t) : "—";
  if (action === "user_created") return t("audit.narrative.userCreated", { name: String(body.name || name), username: String(body.username || "—"), role });
  if (action === "user_updated") return t("audit.narrative.userUpdated", { name: String(body.name || name), username: String(body.username || "—") });
  if (action === "user_password_reset") return t("audit.narrative.userPasswordReset", { name: String(body.name || name) });
  if (action === "user_archived") return t("audit.narrative.userArchived", { name: String(body.name || name) });
  if (action === "student_created" || action === "student_updated" || action === "student_status_changed" || action === "student_restored" || action === "student_archived") {
    const word = action === "student_created" ? t("audit.word.created") : action === "student_updated" ? t("audit.word.updated") : action === "student_restored" ? t("audit.word.restored") : action === "student_status_changed" ? t("audit.word.statusChanged") : t("audit.word.deleted");
    return t("audit.narrative.student", { action: word, name, code });
  }
  if (action === "payment_reversed") return t("audit.narrative.reversed", { payment: String(details._payment_id || details.payment_id || "—"), name, amount: String(details.original_amount || details._payment_amount || "—"), reason: String(details.reason || "—") });
  if (action === "payment_created") return t("audit.narrative.payment", { name, code, amount: String(details.amount || details.original_amount || details._payment_amount || "—") });
  if (action === "advance_payment_created") return t("audit.narrative.advancePayment", { name, code, amount: String(details.amount || details._payment_amount || "—") });
  if (action === "attendance_recorded") return t("audit.narrative.attendance", { name, code });
  return t("audit.narrative.generic", { action: t(auditActionKey(action)) });
}

function formatAuditDetailValue(value: unknown, language: Language) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? (language === "ar" ? "نعم" : "Yes") : (language === "ar" ? "لا" : "No");
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

function formatAuditDetails(details: Record<string, unknown>, language: Language, t: Translator = createTranslator(language)) {
  if (details?._audit_action) return [{ key: "", value: auditNarrativeFromDetails(String(details._audit_action), details as Record<string, any>, language, t) }];
  return Object.entries(details || {}).filter(([key]) => key !== "pin_digits").map(([key, value]) => ({
    key: auditDetailLabelKey(key) ? t(auditDetailLabelKey(key) as TranslationKey) : key.replaceAll("_", " "), value: auditDetailText(key, value, language, t)
  }));
}

function AuditLogsPanel({ session, language, t }: { session: TeacherSession; language: Language; t: Translator }) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [accessToken, setAccessToken] = useState("");
  const [pin, setPin] = useState("");
  const [newPin, setNewPin] = useState("");
  const [adminPassword, setAdminPassword] = useState("");
  const [showChangePin, setShowChangePin] = useState(false);
  const [search, setSearch] = useState("");
  const [action, setAction] = useState("");
  const [userId, setUserId] = useState("");
  const [paymentId, setPaymentId] = useState("");
  const [studentId, setStudentId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [logs, setLogs] = useState<any[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const auth = { Authorization: `Bearer ${session.token}` };

  useEffect(() => {
    fetch(`${API_BASE_URL}/admin/audit-logs/status`, { headers: auth })
      .then((response) => response.json())
      .then((data) => { setConfigured(Boolean(data.configured)); if (!data.configured) setStatus(""); })
      .catch(() => setStatus(t("fees.reportLoadFailed")));
  }, [session.token]);

  async function savePin(event: React.FormEvent) {
    event.preventDefault(); setStatus("");
    try {
      const response = await fetch(`${API_BASE_URL}/admin/audit-logs/pin`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ pin: newPin, current_password: adminPassword }) });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.status || "pin_failed");
      setConfigured(true); setNewPin(""); setAdminPassword(""); setShowChangePin(false); setStatus(t("audit.pinSaved"));
    } catch { setStatus(t("audit.invalidPin")); }
  }

  async function unlock(event: React.FormEvent) {
    event.preventDefault(); setStatus("");
    try {
      const response = await fetch(`${API_BASE_URL}/admin/audit-logs/unlock`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ pin }) });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.status || "unlock_failed");
      setAccessToken(data.audit_access_token); setUnlocked(true); setPin(""); setPage(1); await loadLogs(1, data.audit_access_token);
    } catch (error) { setStatus(error instanceof Error && error.message === "audit_pin_locked" ? t("audit.locked") : t("audit.invalidPin")); }
  }

  async function loadLogs(nextPage = page, token = accessToken) {
    if (!token) return;
    setLoading(true); setStatus("");
    try {
      const params = new URLSearchParams({ page: String(nextPage), limit: "50" });
      if (search.trim()) params.set("search", search.trim()); if (action) params.set("action", action); if (userId.trim()) params.set("user_id", userId.trim()); if (paymentId.trim()) params.set("payment_id", paymentId.trim()); if (studentId.trim()) params.set("student_id", studentId.trim()); if (dateFrom) params.set("date_from", dateFrom); if (dateTo) params.set("date_to", dateTo);
      const response = await fetch(`${API_BASE_URL}/admin/audit-logs?${params}`, { headers: { ...auth, "X-Audit-Access-Token": token } });
      const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.status || "logs_failed");
      setLogs(Array.isArray(data.logs) ? data.logs : []); setTotal(Number(data.total || 0)); setPage(nextPage);
    } catch (error) { if (error instanceof Error && error.message === "audit_access_required") { setUnlocked(false); setAccessToken(""); } setStatus(t("fees.reportLoadFailed")); }
    finally { setLoading(false); }
  }

  if (configured === null) return <section className="admin-editor audit-logs-panel"><p className="field-hint">{t("fees.reportLoadFailed")}</p></section>;
  if (!configured || showChangePin) return <section className="admin-editor audit-logs-panel"><div className="section-heading"><p className="eyebrow">{t("admin.tabs.auditLogs")}</p><h2>{configured ? t("audit.changePin") : t("audit.setup")}</h2></div><form onSubmit={savePin} className="audit-pin-form"><label>{t("audit.pin")}<input value={newPin} onChange={(event) => setNewPin(normalizeDigits(event.target.value).replace(/\D/g, "").slice(0, 4))} inputMode="numeric" type="password" maxLength={4} autoComplete="new-password" /></label><label>{t("audit.adminPassword")}<input value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} type="password" autoComplete="current-password" /></label><div className="report-actions"><button className="primary-button" type="submit">{t("audit.setup")}</button>{configured ? <button className="secondary-button" type="button" onClick={() => setShowChangePin(false)}>{t("admin.cancel")}</button> : null}</div>{status ? <p className="form-error">{status}</p> : null}</form></section>;
  if (!unlocked) return <section className="admin-editor audit-logs-panel"><div className="section-heading"><p className="eyebrow">{t("admin.tabs.auditLogs")}</p><h2>{t("audit.title")}</h2></div><p className="field-hint">{t("audit.pin")}</p><form onSubmit={unlock} className="audit-pin-form"><label>{t("audit.pin")}<input value={pin} onChange={(event) => setPin(normalizeDigits(event.target.value).replace(/\D/g, "").slice(0, 4))} inputMode="numeric" type="password" maxLength={4} autoComplete="one-time-code" /></label><button className="primary-button" type="submit">{t("audit.unlock")}</button>{status ? <p className="form-error">{status}</p> : null}</form></section>;
  return <section className="admin-editor audit-logs-panel"><div className="section-heading"><p className="eyebrow">{t("admin.tabs.auditLogs")}</p><h2>{t("audit.title")}</h2></div><div className="report-filters payment-report-filters"><label>{t("audit.search")}<input value={search} onChange={(event) => setSearch(event.target.value)} /></label><label>{t("audit.action")}<input value={action} onChange={(event) => setAction(event.target.value)} placeholder="payment_reversed" /></label><label>{t("audit.user")}<input value={userId} onChange={(event) => setUserId(normalizeDigits(event.target.value))} inputMode="numeric" /></label><label>{t("audit.payment")}<input value={paymentId} onChange={(event) => setPaymentId(normalizeDigits(event.target.value))} inputMode="numeric" /></label><label>{t("audit.student")}<input value={studentId} onChange={(event) => setStudentId(normalizeDigits(event.target.value))} inputMode="numeric" /></label><label>{t("audit.dateFrom")}<input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label><label>{t("audit.dateTo")}<input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label></div><div className="report-actions"><button className="primary-button compact-button" type="button" disabled={loading} onClick={() => loadLogs(1)}>{t("audit.refresh")}</button><button className="secondary-button compact-button" type="button" onClick={() => { setUnlocked(false); setAccessToken(""); setLogs([]); }}>{t("admin.cancel")}</button><button className="secondary-button compact-button" type="button" onClick={() => setShowChangePin(true)}>{t("audit.changePin")}</button></div><p className="report-total">{total} · {t("audit.title")}</p>{logs.length ? <div className="table-wrap"><table><thead><tr><th>{t("audit.date")}</th><th>{t("audit.user")}</th><th>{t("audit.action")}</th><th>{t("audit.student")}</th><th>{t("audit.payment")}</th><th>{t("audit.details")}</th></tr></thead><tbody>{logs.map((log) => <tr key={log.id}><td>{new Date(log.created_at).toLocaleString(language === "ar" ? "ar-EG" : "en-US")}</td><td>{log.actor_name || log.actor_username || "—"}</td><td>{t(auditActionKey(log.action))}</td><td><strong>{log.student_name || "—"}</strong>{log.student_code ? <small className="audit-student-code">{log.student_code}</small> : log.student_id ? <small className="audit-student-code">ID: {log.student_id}</small> : null}</td><td>{log.payment_id ? `${log.payment_id}${log.payment_amount ? ` · ${log.payment_amount} EGP` : ""}` : "—"}</td><td><details><summary>{t("audit.details")}</summary><div className="audit-detail-list">{formatAuditDetails(log.details || {}, language).map((item) => <div className="audit-detail-item" key={item.key}><b>{item.key}</b><span>{item.value}</span></div>)}{log.reversal_reason ? <div className="audit-detail-item"><b>{t("audit.reason")}</b><span>{log.reversal_reason}</span></div> : null}</div></details></td></tr>)}</tbody></table></div> : <p className="empty-state">{t("audit.noLogs")}</p>}<div className="report-actions audit-pagination"><button className="secondary-button compact-button" type="button" disabled={page <= 1 || loading} onClick={() => loadLogs(page - 1)}>{"‹"}</button><span>{page} / {Math.max(1, Math.ceil(total / 50))}</span><button className="secondary-button compact-button" type="button" disabled={page >= Math.max(1, Math.ceil(total / 50)) || loading} onClick={() => loadLogs(page + 1)}>{"›"}</button></div>{status ? <p className="form-error">{status}</p> : null}</section>;
}

function PaymentReportsPanel({ session, t }: { session: TeacherSession; t: Translator }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("");
  const [grade, setGrade] = useState("");
  const [rows, setRows] = useState<any[]>([]);
  const [totalPaid, setTotalPaid] = useState(0);
  const [paymentCount, setPaymentCount] = useState(0);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [reverseTarget, setReverseTarget] = useState<any>(null);
  const [reverseReason, setReverseReason] = useState("");
  const [reversing, setReversing] = useState(false);
  const auth = { Authorization: `Bearer ${session.token}` };

  async function searchReport(nextFrom = from, nextTo = to) {
    setLoading(true); setStatus("");
    try {
      const params = new URLSearchParams();
      if (nextFrom.trim()) params.set("date_from", nextFrom.trim());
      if (nextTo.trim()) params.set("date_to", nextTo.trim());
      if (query.trim()) params.set("q", normalizeSearchText(query));
      if (group.trim()) params.set("group_id", group.trim());
      if (grade.trim()) params.set("grade_level", grade.trim());
      const response = await fetch(`${API_BASE_URL}/admin/payments/report?${params.toString()}`, { headers: auth });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error("report_failed");
      setRows(Array.isArray(data.payments) ? data.payments : []);
      setTotalPaid(Number(data.total_paid || 0));
      setPaymentCount(Number(data.payment_count || 0));
      if (!data.payments?.length && (query.trim() || nextFrom || nextTo || group.trim() || grade.trim())) setStatus(t("fees.noMatchingResults"));
    } catch { setStatus(t("fees.reportLoadFailed")); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    const refreshReports = () => { searchReport().catch(() => undefined); };
    window.addEventListener("fees-updated", refreshReports);
    return () => window.removeEventListener("fees-updated", refreshReports);
  }, [from, to, query, group, grade]);

  function setToday() {
    const today = localDateInputValue(); setFrom(today); setTo(today); searchReport(today, today).catch(() => undefined);
  }

  function setThisMonth() {
    const today = localDateInputValue(); const monthStart = `${today.slice(0, 7)}-01`; setFrom(monthStart); setTo(today); searchReport(monthStart, today).catch(() => undefined);
  }

  function exportCsv() {
    const headers = [t("fees.paymentDate"), t("fees.paymentTime"), t("admin.studentName"), t("admin.studentCode"), t("admin.scanSerial"), t("admin.selectGroup"), t("admin.grade"), t("fees.amount"), t("fees.paidBy"), t("fees.coveredMonth"), t("fees.paymentType")];
    const csvRows = rows.map((row) => { const date = new Date(row.paid_at); const months = Array.isArray(row.payment_months) ? row.payment_months.map((item: any) => String(item.month || "").slice(0, 7)).join("; ") : ""; return [date.toLocaleDateString(), date.toLocaleTimeString(), row.full_name, row.student_code, row.scan_serial, row.group_name, row.grade_level, row.amount, row.paid_by, months, row.payment_type === "advance" ? t("fees.advancePaymentLabel") : t("fees.normalPayment")]; });
    const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const csv = [headers, ...csvRows].map((row) => row.map(escape).join(",")).join("\r\n");
    const blob = new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" }); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `payments-report-${localDateInputValue()}.csv`; link.click(); URL.revokeObjectURL(url);
  }

  async function reversePayment() {
    if (!reverseTarget || reverseReason.trim().length < 3) return;
    setReversing(true); setStatus("");
    try {
      const response = await fetch(`${API_BASE_URL}/admin/fees/payments/${reverseTarget.id}/reverse`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ reason: reverseReason.trim() }) });
      const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.status || "reverse_failed");
      setReverseTarget(null); setReverseReason(""); setStatus(t("fees.reversalSaved")); await searchReport(); window.dispatchEvent(new Event("fees-updated"));
    } catch { setStatus(t("fees.reversalFailed")); }
    finally { setReversing(false); }
  }

  return <section className="admin-editor payment-reports">
    <div className="section-heading reports-header"><p className="eyebrow">{t("fees.reports")}</p><h2>{t("fees.reports")}</h2></div>
    <div className="report-filters payment-report-filters">
      <label>{t("fees.dateFrom")}<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
      <label>{t("fees.dateTo")}<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
      <label>{t("fees.reportSearch")}<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("fees.reportSearch")} /></label>
      <label>{t("fees.groupFilter")}<input value={group} onChange={(event) => setGroup(event.target.value)} /></label>
      <label>{t("fees.gradeFilter")}<input value={grade} onChange={(event) => setGrade(event.target.value)} /></label>
    </div>
    <div className="report-actions"><button className="secondary-button compact-button" type="button" onClick={setToday}>{t("fees.today")}</button><button className="secondary-button compact-button" type="button" onClick={setThisMonth}>{t("fees.thisMonth")}</button><button className="primary-button compact-button" type="button" disabled={loading} onClick={() => searchReport().catch(() => undefined)}>{t("fees.find")}</button><button className="secondary-button compact-button" type="button" disabled={!rows.length} onClick={exportCsv}>{t("fees.exportExcel")}</button></div>
    <p className="report-total">{t("fees.totalPaid")}: {totalPaid.toFixed(2)} EGP · {t("fees.paymentCount")}: {paymentCount}</p>
    {rows.length ? <div className="table-wrap"><table><thead><tr><th>{t("admin.studentName")}</th><th>{t("admin.studentCode")}</th><th>{t("admin.selectGroup")}</th><th>{t("admin.grade")}</th><th>{t("fees.amount")}</th><th>{t("fees.paymentType")}</th><th>{t("fees.paymentDate")}</th><th>{t("fees.reversePayment")}</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td>{row.full_name}</td><td>{row.student_code}</td><td>{row.group_name}</td><td>{gradeLevelLabel(row.grade_level, document.documentElement.lang === "en" ? "en" : "ar")}</td><td>{row.amount} EGP</td><td>{row.payment_type === "advance" ? t("fees.advancePaymentLabel") : t("fees.normalPayment")}</td><td>{row.paid_at ? new Date(row.paid_at).toLocaleString() : "—"}</td><td><button className="secondary-button compact-button" type="button" onClick={() => { setReverseTarget(row); setReverseReason(""); }}>{t("fees.reversePayment")}</button></td></tr>)}</tbody></table></div> : <p className="empty-state">{status || t("fees.noMatchingResults")}</p>}
    {reverseTarget ? <div className="modal-backdrop"><div className="modal-card" role="dialog" aria-modal="true"><h3>{t("fees.reversePayment")}</h3><p>{reverseTarget.full_name} · {reverseTarget.amount} EGP</p><label>{t("audit.reason")}<textarea value={reverseReason} onChange={(event) => setReverseReason(event.target.value)} rows={4} autoFocus /></label><div className="report-actions"><button className="primary-button" type="button" disabled={reversing || reverseReason.trim().length < 3} onClick={reversePayment}>{t("fees.confirmReversal")}</button><button className="secondary-button" type="button" disabled={reversing} onClick={() => setReverseTarget(null)}>{t("admin.cancel")}</button></div></div></div> : null}
  </section>;
}

function LatePaymentsReportPanel({ session, t }: { session: TeacherSession; t: Translator }) {
  const now = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(localDateInputValue());
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("");
  const [grade, setGrade] = useState("");
  const [includeDisabled, setIncludeDisabled] = useState(false);
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [count, setCount] = useState(0);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const auth = { Authorization: `Bearer ${session.token}` };

  async function runReport() {
    setLoading(true); setStatus("");
    try {
      const params = new URLSearchParams({ date_from: from, date_to: to });
      if (query.trim()) params.set("q", normalizeSearchText(query));
      if (group.trim()) params.set("group_id", group.trim());
      if (grade.trim()) params.set("grade_level", grade.trim());
      if (includeDisabled) params.set("include_disabled", "true");
      const response = await fetch(`${API_BASE_URL}/admin/payments/late?${params}`, { headers: auth });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error("late_report_failed");
      setRows(Array.isArray(data.students) ? data.students : []); setTotal(Number(data.total_expected_unpaid || 0)); setCount(Number(data.late_student_count || 0));
      if (!data.students?.length) setStatus(t("fees.noMatchingResults"));
    } catch { setStatus(t("fees.reportLoadFailed")); }
    finally { setLoading(false); }
  }

  useEffect(() => { runReport().catch(() => undefined); }, []);

  function exportCsv() {
    const headers = [t("admin.studentName"), t("admin.studentCode"), t("admin.scanSerial"), t("admin.selectGroup"), t("admin.grade"), t("admin.guardianPhone"), t("fees.required"), t("fees.paid"), t("fees.remaining"), t("fees.coveredMonth"), t("fees.lastPaymentDate")];
    const csvRows = rows.map((row) => [row.full_name, row.student_code, row.scan_serial, row.group_name, row.grade_level, row.guardian_phone, row.required_amount, row.paid_amount, row.remaining_balance, (row.unpaid_months || []).map((month: any) => String(month.month).slice(0, 7)).join("; "), row.last_payment_date ? new Date(row.last_payment_date).toLocaleString() : ""]);
    const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const csv = [headers, ...csvRows].map((row) => row.map(escape).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: "text/csv;charset=utf-8" })); const link = document.createElement("a"); link.href = url; link.download = `late-payments-${localDateInputValue()}.csv`; link.click(); URL.revokeObjectURL(url);
  }

  return <section className="admin-editor late-payments-report"><div className="section-heading"><p className="eyebrow">{t("fees.lateReport")}</p><h2>{t("fees.lateReport")}</h2></div><div className="report-filters payment-report-filters"><label>{t("fees.dateFrom")}<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label><label>{t("fees.dateTo")}<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label><label className="payment-report-search">{t("fees.reportSearch")}<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("fees.reportSearch")} /></label><label>{t("fees.groupFilter")}<input value={group} onChange={(e) => setGroup(e.target.value)} /></label><label>{t("fees.gradeFilter")}<input value={grade} onChange={(e) => setGrade(e.target.value)} /></label><label className="checkbox-label"><input type="checkbox" checked={includeDisabled} onChange={(e) => setIncludeDisabled(e.target.checked)} />{t("fees.includeDisabled")}</label></div><div className="report-actions"><button className="primary-button compact-button" type="button" disabled={loading} onClick={() => runReport().catch(() => undefined)}>{t("fees.find")}</button><button className="secondary-button compact-button" type="button" disabled={!rows.length} onClick={exportCsv}>{t("fees.exportExcel")}</button></div><div className="report-summary"><span><b>{t("fees.lateStudentCount")}</b>{count}</span><span><b>{t("fees.totalExpectedUnpaid")}</b>{total.toFixed(2)} EGP</span></div>{rows.length ? <div className="table-wrap"><table><thead><tr><th>{t("admin.studentName")}</th><th>{t("admin.studentCode")}</th><th>{t("admin.scanSerial")}</th><th>{t("admin.selectGroup")}</th><th>{t("admin.grade")}</th><th>{t("admin.guardianPhone")}</th><th>{t("fees.required")}</th><th>{t("fees.paid")}</th><th>{t("fees.remaining")}</th><th>{t("fees.coveredMonth")}</th><th>{t("fees.lastPaymentDate")}</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td>{row.full_name}</td><td>{row.student_code}</td><td>{row.scan_serial || "—"}</td><td>{row.group_name}</td><td>{row.grade_level}</td><td>{row.guardian_phone}</td><td>{Number(row.required_amount).toFixed(2)}</td><td>{Number(row.paid_amount).toFixed(2)}</td><td>{Number(row.remaining_balance).toFixed(2)}</td><td>{(row.unpaid_months || []).map((month: any) => String(month.month).slice(0, 7)).join(" · ") || "—"}</td><td>{row.last_payment_date ? new Date(row.last_payment_date).toLocaleDateString() : "—"}</td></tr>)}</tbody></table></div> : <p className="empty-state">{status || t("fees.noMatchingResults")}</p>}{status ? <p className="form-error">{status}</p> : null}</section>;
}

function StaffInbox({ session, t }: { session: TeacherSession; t: Translator }) {
  const [threads, setThreads] = useState<any[]>([]); const [selected, setSelected] = useState<any>(null); const [messages, setMessages] = useState<any[]>([]); const [filter, setFilter] = useState(""); const [unreadOnly, setUnreadOnly] = useState(false); const [date, setDate] = useState(""); const [reply, setReply] = useState(""); const [status, setStatus] = useState("");
  const auth = { Authorization: `Bearer ${session.token}` }; const jsonAuth = { ...auth, "Content-Type": "application/json" };
  async function load() { const params=new URLSearchParams(); if(filter.trim())params.set("search",filter.trim()); if(unreadOnly)params.set("unread","true"); if(date)params.set("date",date); const response=await fetch(`${API_BASE_URL}/admin/inbox/threads?${params}`,{headers:auth}); const data=await response.json(); setThreads(data.threads||[]); }
  async function openThread(thread:any) { setSelected(thread); const response=await fetch(`${API_BASE_URL}/admin/inbox/threads/${thread.id}/messages`,{headers:auth}); const data=await response.json(); setMessages(data.messages||[]); load(); }
  useEffect(()=>{load().catch(()=>setStatus(t("inbox.noMessages")));},[filter,unreadOnly,date,session.token]);
  async function sendReply(event:React.FormEvent){event.preventDefault();if(!selected||!reply.trim())return;const response=await fetch(`${API_BASE_URL}/admin/inbox/threads/${selected.id}/messages`,{method:"POST",headers:jsonAuth,body:JSON.stringify({body:reply.trim()})});const data=await response.json();if(data.ok){setReply("");setStatus(t("inbox.sent"));openThread(selected);}}
  return <section className="admin-editor inbox-panel"><div className="section-heading"><p className="eyebrow">{t("admin.tabs.inbox")}</p><h2>{t("inbox.title")}</h2></div><div className="inbox-filters"><input value={filter} onChange={(e)=>setFilter(e.target.value)} placeholder={t("inbox.search")} /><input type="date" value={date} onChange={(e)=>setDate(e.target.value)} aria-label={t("inbox.date")} /><label className="checkbox-label"><input type="checkbox" checked={unreadOnly} onChange={(e)=>setUnreadOnly(e.target.checked)} />{t("inbox.unread")}</label><button className={!unreadOnly?"active":""} type="button" onClick={()=>setUnreadOnly(false)}>{t("inbox.all")}</button></div><div className="inbox-layout"><div className="inbox-list">{threads.length?threads.map((thread)=><button className={`inbox-thread ${selected?.id===thread.id?"active":""}`} key={thread.id} type="button" onClick={()=>openThread(thread)}><strong>{thread.subject}</strong><span>{thread.full_name||thread.public_name||thread.public_phone||t("inbox.showing")}</span>{thread.public_phone?<small className="inbox-phone">{t("contact.phone")}: {thread.public_phone}</small>:null}<small>{thread.group_name||""} · {thread.last_message}</small>{Number(thread.unread_count)>0?<b>{thread.unread_count}</b>:null}</button>):<p className="empty-state">{t("inbox.noMessages")}</p>}</div><div className="inbox-conversation">{selected?<><h3>{selected.subject}</h3><p className="inbox-contact-details">{selected.full_name||selected.public_name||t("inbox.showing")}{selected.public_phone?<a href={`tel:${selected.public_phone}`}>{t("contact.phone")}: {selected.public_phone}</a>:null}</p><div className="inbox-messages">{messages.map((message)=><article className={`inbox-message ${message.sender_type==="admin"||message.sender_type==="teacher"||message.sender_type==="assistant"?"mine":""}`} key={message.id}><p>{message.body}</p><small>{message.sender_type} · {new Date(message.created_at).toLocaleString()}</small></article>)}</div><form onSubmit={sendReply}><textarea value={reply} onChange={(e)=>setReply(e.target.value)} placeholder={t("inbox.reply")} rows={3}/><button className="primary-button" type="submit">{t("inbox.reply")}</button></form></>:<p className="empty-state">{t("inbox.selectThread")}</p>}</div></div>{status?<p className="lookup-result">{status}</p>:null}</section>;
}

function formatInboxTimestamp(value: unknown, language: Language) {
  if (!value || typeof value !== "string") return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(language === "ar" ? "ar-EG" : "en-US", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Africa/Cairo"
  }).format(date);
}

function inboxMessageStatus(message: any, viewer: "student" | "staff", t: Translator) {
  const outgoing = viewer === "student"
    ? message.sender_type === "student"
    : ["admin", "teacher", "assistant"].includes(message.sender_type);
  if (outgoing && !message.is_read) return t("inbox.sentStatus");
  return message.is_read ? t("inbox.read") : t("inbox.unread");
}

async function parseInboxResponse(response: Response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(typeof data.message === "string" ? data.message : typeof data.status === "string" ? data.status : "inbox_request_failed");
  }
  return data;
}

function StaffInboxControls({ session, language, t, onUnreadCountChange }: { session: TeacherSession; language: Language; t: Translator; onUnreadCountChange: (count: number) => void }) {
  const [threads, setThreads] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [filter, setFilter] = useState("");
  const [readFilter, setReadFilter] = useState<"all" | "unread" | "read">("all");
  const [date, setDate] = useState("");
  const [reply, setReply] = useState("");
  const [status, setStatus] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [markingRead, setMarkingRead] = useState(false);
  const [replyState, setReplyState] = useState<"idle" | "sending" | "sent">("idle");
  const auth = { Authorization: `Bearer ${session.token}` };
  const jsonAuth = { ...auth, "Content-Type": "application/json" };
  const unreadVisibleIds = threads.filter((thread) => Number(thread.unread_count) > 0).map((thread) => thread.id);
  const canMarkRead = selected ? Number(selected.unread_count) > 0 : unreadVisibleIds.length > 0;

  async function refresh() {
    setRefreshing(true);
    setStatus("");
    try {
      const params = new URLSearchParams();
      if (filter.trim()) params.set("search", filter.trim());
      if (readFilter !== "all") params.set("read", readFilter);
      if (date) params.set("date", date);
      const [threadsResponse, countResponse] = await Promise.all([
        fetch(`${API_BASE_URL}/admin/inbox?${params}`, { headers: auth }),
        fetch(`${API_BASE_URL}/admin/inbox/unread-count`, { headers: auth })
      ]);
      const [threadsData, countData] = await Promise.all([
        parseInboxResponse(threadsResponse),
        parseInboxResponse(countResponse)
      ]);
      setThreads(Array.isArray(threadsData.threads) ? threadsData.threads : []);
      onUnreadCountChange(Number(countData.count || 0));
    } catch (_error) {
      setStatus(t("inbox.loadFailed"));
      throw _error;
    } finally {
      setRefreshing(false);
    }
  }

  async function openThread(thread: any) {
    setStatus("");
    try {
      const response = await fetch(`${API_BASE_URL}/admin/inbox/${thread.id}`, { headers: auth });
      const data = await parseInboxResponse(response);
      setSelected(thread);
      setMessages(Array.isArray(data.messages) ? data.messages : []);
    } catch (_error) {
      setStatus(t("inbox.loadFailed"));
    }
  }

  useEffect(() => { refresh().catch(() => undefined); }, [filter, readFilter, date, session.token]);

  async function markRead() {
    if (!canMarkRead || markingRead) return;
    setMarkingRead(true);
    setStatus("");
    try {
      const ids = selected ? [selected.id] : unreadVisibleIds;
      const endpoint = selected ? `${API_BASE_URL}/admin/inbox/${selected.id}/read` : `${API_BASE_URL}/admin/inbox/read-visible`;
      const response = await fetch(endpoint, {
        method: selected ? "PUT" : "POST",
        headers: jsonAuth,
        body: selected ? undefined : JSON.stringify({ thread_ids: ids })
      });
      await parseInboxResponse(response);
      setMessages((current) => current.map((message) => message.sender_type === "student" || message.sender_type === "public" ? { ...message, is_read: true } : message));
      setSelected((current) => current ? { ...current, unread_count: 0, read_status: "read" } : current);
      await refresh();
      setStatus(t("inbox.markedRead"));
    } catch (_error) {
      setStatus(t("inbox.markReadFailed"));
    } finally {
      setMarkingRead(false);
    }
  }

  async function deleteMessage(messageId: number) {
    if (!selected || !window.confirm(t("inbox.confirmDeleteMessage"))) return;
    try {
      const response = await fetch(`${API_BASE_URL}/admin/inbox/${selected.id}/messages/${messageId}`, { method: "DELETE", headers: auth });
      await parseInboxResponse(response);
      await openThread(selected);
    } catch (_error) {
      setStatus(t("inbox.loadFailed"));
    }
  }

  async function sendReply(event: React.FormEvent) {
    event.preventDefault();
    if (!selected || !reply.trim() || replyState === "sending") return;
    setReplyState("sending");
    setStatus("");
    try {
      const response = await fetch(`${API_BASE_URL}/admin/inbox/${selected.id}/messages`, {
        method: "POST",
        headers: jsonAuth,
        body: JSON.stringify({ body: reply.trim() })
      });
      await parseInboxResponse(response);
      setReply("");
      await openThread(selected);
      setReplyState("sent");
      window.setTimeout(() => setReplyState("idle"), 2000);
    } catch (_error) {
      setReplyState("idle");
      setStatus(t("inbox.sendFailed"));
    }
  }

  return <section className="admin-editor inbox-panel">
    <div className="section-heading"><p className="eyebrow">{t("admin.tabs.inbox")}</p><h2>{t("inbox.title")}</h2></div>
    <div className="inbox-filters">
      <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("inbox.search")} />
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label={t("inbox.date")} />
      <button type="button" className={readFilter === "all" ? "active" : ""} onClick={() => setReadFilter("all")}>{t("inbox.all")}</button>
      <button type="button" className={readFilter === "unread" ? "active" : ""} onClick={() => setReadFilter("unread")}>{t("inbox.unread")}</button>
      <button type="button" className={readFilter === "read" ? "active" : ""} onClick={() => setReadFilter("read")}>{t("inbox.read")}</button>
      <button type="button" onClick={() => markRead()} disabled={!canMarkRead || markingRead}>{markingRead ? t("inbox.markingRead") : t("inbox.markRead")}</button>
      <button type="button" onClick={() => refresh()} disabled={refreshing}>{refreshing ? t("inbox.refreshing") : t("inbox.refresh")}</button>
    </div>
    <div className="inbox-layout">
      <div className="inbox-list">{threads.length ? threads.map((thread) => <button className={`inbox-thread ${selected?.id === thread.id ? "active" : ""}`} key={thread.id} type="button" onClick={() => openThread(thread)}>
        <strong>{thread.subject}</strong><span>{thread.full_name || thread.public_name || thread.public_phone || t("inbox.showing")}</span>{thread.public_phone ? <small className="inbox-phone">{t("contact.phone")}: {thread.public_phone}</small> : null}<small>{thread.group_name || ""} · {thread.last_message}</small><em>{thread.read_status === "unread" ? t("inbox.unread") : t("inbox.read")}</em>{Number(thread.unread_count) > 0 ? <b>{thread.unread_count}</b> : null}
      </button>) : <p className="empty-state">{t("inbox.noMessages")}</p>}</div>
      <div className="inbox-conversation">{selected ? <>
        <h3>{selected.subject}</h3>
        <p className="inbox-contact-details">{selected.full_name || selected.public_name || t("inbox.showing")}{selected.public_phone ? <a href={`tel:${selected.public_phone}`}>{t("contact.phone")}: {selected.public_phone}</a> : null}</p>
        <div className="inbox-messages">{messages.length ? messages.map((message) => <article className={`inbox-message ${["admin", "teacher", "assistant"].includes(message.sender_type) ? "mine" : ""}`} key={message.id}>
          <p>{message.body}</p>
          <small className="message-meta"><span>{message.sender_name || message.sender_type}</span><span className="message-read-status">{inboxMessageStatus(message, "staff", t)}</span><time dateTime={typeof message.created_at === "string" ? message.created_at : undefined}>{formatInboxTimestamp(message.created_at, language)}</time></small>
          {session.teacher.role === "admin" ? <button type="button" className="message-delete-button" onClick={() => deleteMessage(Number(message.id))}>{t("inbox.deleteMessage")}</button> : null}
        </article>) : <p className="empty-state">{t("inbox.noMessages")}</p>}</div>
        <form onSubmit={sendReply}><textarea value={reply} onChange={(e) => setReply(e.target.value)} placeholder={t("inbox.reply")} rows={3}/><button className={`primary-button ${replyState === "sent" ? "success-button" : ""}`} type="submit" disabled={replyState === "sending"}>{replyState === "sending" ? t("inbox.sending") : replyState === "sent" ? t("inbox.sentStatus") : t("inbox.reply")}</button></form>
      </> : <p className="empty-state">{t("inbox.selectThread")}</p>}</div>
    </div>
    {status ? <p className="lookup-result">{status}</p> : null}
  </section>;
}

function SiteContentEditor({
  session,
  language,
  t
}: {
  session: TeacherSession;
  language: Language;
  t: Translator;
}) {
  const pageOptions: Array<{ slug: SiteSlug; label: string }> = [
    { slug: "about-teacher", label: t("nav.aboutTeacher") },
    { slug: "about-center", label: t("nav.aboutCenter") },
    { slug: "contact", label: t("nav.contact") },
    { slug: "tips", label: t("nav.tips") }
  ];
  const [slug, setSlug] = useState<SiteSlug>("about-teacher");
  const [form, setForm] = useState<SitePage>(fallbackSitePages["about-teacher"]);
  const [contentAr, setContentAr] = useState(JSON.stringify(form.content_ar, null, 2));
  const [contentEn, setContentEn] = useState(JSON.stringify(form.content_en, null, 2));
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let ignore = false;
    const fallback = fallbackSitePages[slug];
    setForm(fallback);
    setContentAr(JSON.stringify(fallback.content_ar, null, 2));
    setContentEn(JSON.stringify(fallback.content_en, null, 2));
    setStatus("");

    fetch(`${API_BASE_URL}/site/pages/${slug}`)
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((data: { page?: SitePage }) => {
        if (!ignore && data.page) {
          setForm(data.page);
          setContentAr(JSON.stringify(data.page.content_ar, null, 2));
          setContentEn(JSON.stringify(data.page.content_en, null, 2));
        }
      })
      .catch(() => undefined);

    return () => {
      ignore = true;
    };
  }, [slug]);

  async function saveContent(event: React.FormEvent) {
    event.preventDefault();
    setStatus("");

    let parsedAr: Record<string, any>;
    let parsedEn: Record<string, any>;
    try {
      parsedAr = JSON.parse(contentAr);
      parsedEn = JSON.parse(contentEn);
    } catch (_error) {
      setStatus(t("admin.invalidJson"));
      return;
    }

    setSaving(true);
    try {
      const response = await fetch(`${API_BASE_URL}/admin/site/pages/${slug}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.token}`
        },
        body: JSON.stringify({
          title_ar: form.title_ar,
          title_en: form.title_en,
          subtitle_ar: form.subtitle_ar,
          subtitle_en: form.subtitle_en,
          content_ar: parsedAr,
          content_en: parsedEn
        })
      });
      const data = (await response.json()) as { ok: boolean; page?: SitePage };

      if (!response.ok || !data.ok || !data.page) {
        throw new Error();
      }

      setForm(data.page);
      setStatus(t("admin.saved"));
    } catch (_error) {
      setStatus(t("errors.loginFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="admin-editor">
      <div className="section-heading">
        <p className="eyebrow">{t("admin.siteContent")}</p>
        <h2>{t("admin.siteContent")}</h2>
      </div>
      <form onSubmit={saveContent}>
        <label htmlFor="site-page-select">{t("admin.selectPage")}</label>
        <select
          id="site-page-select"
          value={slug}
          onChange={(event) => setSlug(event.target.value as SiteSlug)}
        >
          {pageOptions.map((option) => (
            <option key={option.slug} value={option.slug}>
              {option.label}
            </option>
          ))}
        </select>

        <div className="editor-grid">
          <label>
            {t("admin.titleAr")}
            <input
              value={form.title_ar}
              onChange={(event) => setForm({ ...form, title_ar: event.target.value })}
              dir="rtl"
            />
          </label>
          <label>
            {t("admin.titleEn")}
            <input
              value={form.title_en}
              onChange={(event) => setForm({ ...form, title_en: event.target.value })}
              dir="ltr"
            />
          </label>
          <label>
            {t("admin.subtitleAr")}
            <input
              value={form.subtitle_ar}
              onChange={(event) => setForm({ ...form, subtitle_ar: event.target.value })}
              dir="rtl"
            />
          </label>
          <label>
            {t("admin.subtitleEn")}
            <input
              value={form.subtitle_en}
              onChange={(event) => setForm({ ...form, subtitle_en: event.target.value })}
              dir="ltr"
            />
          </label>
          <label>
            {t("admin.contentAr")}
            <textarea value={contentAr} onChange={(event) => setContentAr(event.target.value)} rows={10} dir="ltr" />
          </label>
          <label>
            {t("admin.contentEn")}
            <textarea value={contentEn} onChange={(event) => setContentEn(event.target.value)} rows={10} dir="ltr" />
          </label>
        </div>

        <button className="primary-button editor-save" type="submit" disabled={saving}>
          {saving ? t("admin.saving") : t("admin.save")}
        </button>
        {status ? (
          <p className={status === t("admin.saved") ? "lookup-result" : "form-error"}>{status}</p>
        ) : null}
      </form>
    </section>
  );
}

function ExamResultsManager({ session, t }: { session: TeacherSession; t: Translator }) {
  const [groups, setGroups] = useState<AdminGroup[]>([]);
  const [students, setStudents] = useState<AdminStudent[]>([]);
  const [records, setRecords] = useState<Array<Record<string, any>>>([]);
  const [selectedGroup, setSelectedGroup] = useState("");
  const [search, setSearch] = useState("");
  const [recordSearch, setRecordSearch] = useState("");
  const [recordsExpanded, setRecordsExpanded] = useState(false);
  const [form, setForm] = useState({ student_id: "", title: "", exam_date: localDateInputValue(), max_score: "10", score: "", assessment: "" });
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingRecordId, setDeletingRecordId] = useState<number | null>(null);

  useEffect(() => {
    Promise.all([
      fetch(`${API_BASE_URL}/admin/groups`, { headers: { Authorization: `Bearer ${session.token}` } }).then((response) => response.json()),
      fetch(`${API_BASE_URL}/admin/students?status=active`, { headers: { Authorization: `Bearer ${session.token}` } }).then((response) => response.json())
    ])
      .then(([groupData, studentData]) => {
        if (!groupData.ok || !studentData.ok) throw new Error(t("admin.profileLoadFailed"));
        setGroups(Array.isArray(groupData.groups) ? groupData.groups : []);
        setStudents(Array.isArray(studentData.students) ? studentData.students : []);
      })
      .catch((error) => setStatus(error instanceof Error ? error.message : t("admin.profileLoadFailed")))
      .finally(() => setLoading(false));
  }, [session.token, t]);

  useEffect(() => {
    setRecordsLoading(true);
    const params = new URLSearchParams();
    if (selectedGroup) params.set("group_id", selectedGroup);
    if (recordSearch.trim()) params.set("search", normalizeDigits(recordSearch.trim()));
    fetch(`${API_BASE_URL}/admin/exams/results?${params.toString()}`, { headers: { Authorization: `Bearer ${session.token}` } })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(t("admin.profileLoadFailed"));
        setRecords(Array.isArray(data.results) ? data.results : []);
      })
      .catch((error) => setStatus(error instanceof Error ? error.message : t("admin.profileLoadFailed")))
      .finally(() => setRecordsLoading(false));
  }, [selectedGroup, recordSearch, session.token, t]);

  const visibleStudents = students.filter((student) => {
    const matchesGroup = !selectedGroup || String(student.group_id) === selectedGroup;
    const query = normalizeDigits(search).trim().toLowerCase();
    const matchesSearch = !query || student.full_name.toLowerCase().includes(query) || student.student_code.toLowerCase().includes(query) || String(student.scan_serial || "").toLowerCase().includes(query);
    return matchesGroup && matchesSearch;
  });

  useEffect(() => {
    const normalizedSearch = normalizeStudentCode(search).trim();
    if (!/^A-\d{4}$/.test(normalizedSearch)) return;
    const exactStudent = students.find((student) => normalizeStudentCode(student.student_code) === normalizedSearch && (!selectedGroup || String(student.group_id) === selectedGroup));
    if (exactStudent && String(exactStudent.id) !== form.student_id) {
      setForm((current) => ({ ...current, student_id: String(exactStudent.id) }));
    }
  }, [search, selectedGroup, students, form.student_id]);

  const selectedStudent = students.find((student) => String(student.id) === form.student_id);
  const liveEvaluation = scoreEvaluation(form.score, form.max_score, t);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setStatus("");
    const maxScore = Number(normalizeDigits(form.max_score));
    const score = Number(normalizeDigits(form.score));
    if (!form.student_id || !form.title.trim() || !form.exam_date || !form.max_score.trim() || !form.score.trim() || !Number.isFinite(maxScore) || maxScore <= 0 || !Number.isFinite(score) || score < 0 || score > maxScore) {
      setStatus(t("admin.invalidExamResult"));
      return;
    }
    setSaving(true);
    try {
      const response = await fetch(`${API_BASE_URL}/admin/exams/results`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ ...form, student_id: Number(form.student_id), max_score: maxScore, score })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.status === "invalid_exam_result" ? t("admin.invalidExamResult") : t("errors.loginFailed"));
      setStatus(t("admin.examResultSaved"));
      setForm((current) => ({ ...current, score: "", assessment: "" }));
      const params = new URLSearchParams();
      if (selectedGroup) params.set("group_id", selectedGroup);
      if (recordSearch.trim()) params.set("search", normalizeDigits(recordSearch.trim()));
      const refreshed = await fetch(`${API_BASE_URL}/admin/exams/results?${params.toString()}`, { headers: { Authorization: `Bearer ${session.token}` } });
      const refreshedData = await refreshed.json();
      if (refreshed.ok && refreshedData.ok) setRecords(Array.isArray(refreshedData.results) ? refreshedData.results : []);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("errors.loginFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function deleteRecord(recordId: number) {
    if (!window.confirm(t("admin.confirmDeleteExamResult"))) return;
    setDeletingRecordId(recordId);
    setStatus("");
    try {
      const response = await fetch(`${API_BASE_URL}/admin/exams/results/${recordId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.token}` }
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(t("errors.loginFailed"));
      setRecords((current) => current.filter((record) => Number(record.id) !== recordId));
      setStatus(t("admin.examResultDeleted"));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("errors.loginFailed"));
    } finally {
      setDeletingRecordId(null);
    }
  }

  return (
    <section className="admin-editor exam-results-manager">
      <div className="section-heading">
        <p className="eyebrow">{t("admin.tabs.exams")}</p>
        <h2>{t("dashboard.tabs.examResults")}</h2>
      </div>
      <form onSubmit={save} className="exam-result-form">
        <div className="exam-filter-grid">
          <label>{t("admin.selectGroup")}
            <select value={selectedGroup} onChange={(event) => { setSelectedGroup(event.target.value); setForm((current) => ({ ...current, student_id: "" })); }} disabled={loading}>
              <option value="">{t("admin.allGroups")}</option>
              {groups.map((group) => <option key={group.id} value={group.id}>{group.display_name || group.name}</option>)}
            </select>
          </label>
          <label>{t("admin.searchExamStudent")}
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="A-6251" />
          </label>
          <label>{t("admin.selectStudent")}
            <select value={form.student_id} onChange={(event) => setForm((current) => ({ ...current, student_id: event.target.value }))} disabled={loading}>
              <option value="">{loading ? t("admin.profileLoading") : t("admin.selectStudent")}</option>
              {visibleStudents.map((student) => <option key={student.id} value={student.id}>{student.full_name} · {student.student_code}</option>)}
            </select>
          </label>
        </div>
        {selectedStudent ? <div className="exam-selected-student"><span><b>{t("admin.selectedStudent")}</b>{selectedStudent.full_name}</span><span><b>{t("admin.selectedGroup")}</b>{selectedStudent.group_name}</span><span><b>{t("admin.studentCode")}</b>{selectedStudent.student_code}</span></div> : null}
        <label>{t("admin.examTitle")}<input value={form.title} onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} /></label>
        <label>{t("admin.examDate")}<input type="date" value={form.exam_date} onChange={(event) => setForm((current) => ({ ...current, exam_date: event.target.value }))} /></label>
        <label>{t("admin.maxScore")}<input type="number" min="0.01" step="0.01" value={form.max_score} onChange={(event) => setForm((current) => ({ ...current, max_score: normalizeDigits(event.target.value) }))} /></label>
        <label>{t("admin.studentScore")}<input type="number" min="0" step="0.01" value={form.score} onChange={(event) => setForm((current) => ({ ...current, score: normalizeDigits(event.target.value) }))} /></label>
        {liveEvaluation ? <div className={`score-evaluation score-${liveEvaluation.tone}`}><span>{t("admin.evaluationPreview")}</span><strong>{liveEvaluation.label}</strong><small>{liveEvaluation.percentage.toFixed(0)}%</small></div> : null}
        <label className="exam-assessment-field">{t("admin.assessment")}<textarea rows={4} value={form.assessment} onChange={(event) => setForm((current) => ({ ...current, assessment: event.target.value }))} placeholder={t("admin.assessmentPlaceholder")} /></label>
        <button className="primary-button" type="submit" disabled={saving || loading}>{saving ? t("admin.saving") : t("admin.saveExamResult")}</button>
        {status ? <p className={status === t("admin.examResultSaved") || status === t("admin.examResultDeleted") ? "lookup-result" : "form-error"}>{status}</p> : null}
      </form>
      <div className="exam-records">
        <div className="exam-records-heading">
          <h3>{t("admin.examRecords")}</h3>
          <button className="secondary-button compact-button" type="button" onClick={() => setRecordsExpanded((current) => !current)} aria-expanded={recordsExpanded}>
            <span className="records-toggle-icon" aria-hidden="true">{recordsExpanded ? "▴" : "▾"}</span>
            {recordsExpanded ? t("admin.examRecordsHide") : t("admin.examRecordsShow")}
          </button>
        </div>
        {recordsExpanded ? <>
          <label className="exam-records-search">{t("admin.searchExamRecords")}
            <input value={recordSearch} onChange={(event) => setRecordSearch(event.target.value)} placeholder="A-6251" />
          </label>
          {recordsLoading ? <p className="field-hint">{t("admin.profileLoading")}</p> : records.length ? <div className="table-wrap"><table><thead><tr><th>{t("admin.studentName")}</th><th>{t("admin.studentCode")}</th><th>{t("table.exam")}</th><th>{t("table.date")}</th><th>{t("table.score")}</th><th>{t("table.assessment")}</th><th>{t("admin.editExamResult")}</th><th>{t("admin.deleteExamResult")}</th></tr></thead><tbody>{records.map((record) => <tr key={record.id}><td>{record.full_name}</td><td>{record.student_code}</td><td>{record.title}</td><td>{record.exam_date}</td><td>{record.score}/{record.max_score}</td><td>{record.assessment || record.note || "—"}</td><td><button className="secondary-button compact-button" type="button" onClick={() => setForm({ student_id: String(record.student_id), title: String(record.title || ""), exam_date: String(record.exam_date || "").slice(0, 10), max_score: String(record.max_score || "10"), score: String(record.score ?? ""), assessment: String(record.assessment || record.note || "") })}>{t("admin.editExamResult")}</button></td><td><button className="danger-button compact-button" type="button" onClick={() => deleteRecord(Number(record.id))} disabled={deletingRecordId === Number(record.id)}>{deletingRecordId === Number(record.id) ? t("admin.saving") : t("admin.deleteExamResult")}</button></td></tr>)}</tbody></table></div> : <p className="empty-state">{t("admin.noExamResults")}</p>}
        </> : null}
      </div>
    </section>
  );
}

function Shell({
  children,
  language,
  setLanguage,
  t,
  onLogout,
  logoutLabel
}: {
  children: React.ReactNode;
  language: Language;
  setLanguage: (language: Language) => void;
  t: Translator;
  onLogout?: () => void;
  logoutLabel?: string;
}) {
  const [activeNav, setActiveNav] = useState(() => getActiveNavKey());

  useEffect(() => {
    const updateActiveNav = () => setActiveNav(getActiveNavKey());
    window.addEventListener("popstate", updateActiveNav);
    window.addEventListener("hashchange", updateActiveNav);
    return () => {
      window.removeEventListener("popstate", updateActiveNav);
      window.removeEventListener("hashchange", updateActiveNav);
    };
  }, []);

  function handleNavClick(nextActiveNav: string) {
    setActiveNav(nextActiveNav);
  }

  return (
    <div className={`app-shell ${onLogout ? "student-shell" : ""}`}>
      <header
        className="site-header"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: "16px",
          width: "100%"
        }}
      >
        <div
          className="brand-cluster"
          style={{
            flexShrink: 0,
            display: "inline-flex",
            alignItems: "center",
            gap: "12px",
            minWidth: "fit-content"
          }}
        >
          <a className="brand" href="/" style={{ flexShrink: 0 }}>
            <img className="brand-icon teacher-avatar" src="/assets/teacher-profile.png" alt="" aria-hidden="true" />
            <span>
              <strong>{t("site.name")}</strong>
              <small>{t("site.description")}</small>
            </span>
          </a>
          <DateTimeWidget language={language} compact />
        </div>
        <div
          className="header-actions"
          style={{
            display: "flex",
            alignItems: "center",
            flexWrap: "wrap",
            gap: "12px",
            justifyContent: "flex-end",
            flex: "1 1 auto"
          }}
        >
          <nav
            aria-label={language === "ar" ? "التنقل الرئيسي" : "Main navigation"}
            style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "6px" }}
          >
            <a
              className={`primary-nav-link ${activeNav === "student-login" ? "active" : ""}`}
              href="/#student-login"
              onClick={() => handleNavClick("student-login")}
            >
              {t("nav.studentLogin")}
            </a>
            <a
              className={activeNav === "about-teacher" ? "active" : ""}
              href="/about-teacher"
              onClick={() => handleNavClick("about-teacher")}
            >
              {t("nav.aboutTeacher")}
            </a>
            <a
              className={activeNav === "contact" ? "active" : ""}
              href="/contact"
              onClick={() => handleNavClick("contact")}
            >
              {t("nav.contact")}
            </a>
            <a
              className={activeNav === "tips" ? "active" : ""}
              href="/tips"
              onClick={() => handleNavClick("tips")}
            >
              {t("nav.tips")}
            </a>
            <a
              className={activeNav === "teacher-login" ? "active" : ""}
              href="/teacher/login"
              onClick={() => handleNavClick("teacher-login")}
            >
              {t("nav.teacherLogin")}
            </a>
          </nav>
          <div
            className="language-switcher"
            aria-label={language === "ar" ? "اختيار اللغة" : "Language selector"}
            style={{ flexShrink: 0 }}
          >
            <button
              className={language === "ar" ? "active" : ""}
              type="button"
              onClick={() => setLanguage("ar")}
              aria-pressed={language === "ar"}
            >
              AR
            </button>
            <button
              className={language === "en" ? "active" : ""}
              type="button"
              onClick={() => setLanguage("en")}
              aria-pressed={language === "en"}
            >
              EN
            </button>
          </div>
          {onLogout ? (
            <button className="logout-button" type="button" onClick={onLogout} style={{ flexShrink: 0 }}>
              {logoutLabel || t("student.logout")}
            </button>
          ) : null}
        </div>
      </header>
      {children}
      <footer className="site-footer" dir="ltr" lang="en">
        © 2026 Mr. Ahmed Abdrabo · Designed &amp; Developed by Eng. Hany Hosny
      </footer>
    </div>
  );
}

function getActiveNavKey() {
  if (window.location.hash === "#student-login") return "student-login";
  if (window.location.pathname === "/about-teacher") return "about-teacher";
  if (window.location.pathname === "/about-center") return "center";
  if (window.location.pathname === "/contact") return "contact";
  if (window.location.pathname === "/tips") return "tips";
  if (window.location.pathname.startsWith("/teacher")) return "teacher-login";
  if (window.location.pathname.startsWith("/student")) return "student-login";
  return "student-login";
}

function HomeworkPanel({ studentCode, t, language, refreshKey = 0 }: { studentCode: string; t: Translator; language: Language; refreshKey?: number }) {
  const [homeworks, setHomeworks] = useState<Array<Record<string, any>>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  async function loadHomework() {
    setLoading(true); setError(false);
    try { const response = await fetch(`${API_BASE_URL}/student/homework`, { headers: { "X-Student-Code": studentCode } }); const data = await response.json(); if (!response.ok || !data.ok) throw new Error("homework_load_failed"); setHomeworks(Array.isArray(data.homework) ? data.homework : []); }
    catch { setHomeworks([]); setError(true); }
    finally { setLoading(false); }
  }
  useEffect(() => { loadHomework().catch(() => undefined); }, [studentCode, refreshKey]);
  if (loading) return <p className="field-hint">{t("homework.loading")}</p>;
  if (error) return <div><p className="form-error">{t("homework.loadError")}</p><button className="secondary-button" type="button" onClick={loadHomework}>{t("homework.retry")}</button></div>;
  if (!homeworks.length) return <p className="empty-state">{t("homework.noAvailable")}</p>;
  const statusLabel = (status: string) => { const key = `homework.status.${status}` as TranslationKey; return key in translations.ar ? t(key) : status; };
  return <div className="homework-list">{homeworks.map((homework, index) => <article className="homework-card" key={homework.id || index}><h3>{String(homework.title || "")}</h3>{homework.description ? <p>{String(homework.description)}</p> : null}<div className="homework-meta"><span>{statusLabel(String(homework.status || "new"))}</span>{homework.due_date ? <span>{t("homework.dueDate")}: {formatDateTime(String(homework.due_date), language, "—")}</span> : null}</div>{homework.attachment_url ? <a href={String(homework.attachment_url)} target="_blank" rel="noreferrer">{t("homework.attachment")}</a> : null}</article>)}</div>;
}

function StudentNotesPanel({ studentCode, language, t, onUnreadCountChange, refreshKey = 0 }: { studentCode: string; language: Language; t: Translator; onUnreadCountChange: (count: number) => void; refreshKey?: number }) {
  const [notes, setNotes] = useState<Array<Record<string, any>>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  async function loadNotes() {
    setLoading(true);
    setError(false);
    try {
      const response = await fetch(`${API_BASE_URL}/student/me/notes`, { headers: { "X-Student-Code": studentCode } });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error("notes_load_failed");
      const nextNotes = Array.isArray(data.notes) ? data.notes : [];
      setNotes(nextNotes);
      onUnreadCountChange(Number(data.unread_count || 0));
      if (Number(data.unread_count || 0) > 0) {
        await fetch(`${API_BASE_URL}/student/me/notes/read`, { method: "PUT", headers: { "X-Student-Code": studentCode } });
        setNotes((current) => current.map((note) => ({ ...note, is_read: true })));
        onUnreadCountChange(0);
      }
    } catch {
      setNotes([]);
      onUnreadCountChange(0);
      setError(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadNotes().catch(() => undefined); }, [studentCode, refreshKey]);
  if (loading) return <p className="field-hint">{language === "ar" ? "جاري تحميل الملاحظات..." : "Loading notes..."}</p>;
  if (error) return <div><p className="form-error">{t("notes.loadError")}</p><button className="secondary-button compact-button" type="button" onClick={loadNotes}>{t("notes.refresh")}</button></div>;
  return <section className="student-notes-panel">
    <div className="notes-toolbar"><h3>{t("notes.title")}</h3><button className="secondary-button compact-button" type="button" onClick={loadNotes}>{t("notes.refresh")}</button></div>
    {notes.length ? <div className="student-notes-list">{notes.map((note, index) => <article className={`student-note-card ${note.is_read ? "read" : "unread"}`} key={note.id || index}><p>{String(note.text || note.body || "")}</p><small className="student-note-meta">{note.creator_name || "Staff"} · {formatDateTime(note.created_at, language, "—")} · {note.is_read ? t("notes.read") : t("notes.unread")}</small></article>)}</div> : <p className="empty-state">{t("notes.noAvailable")}</p>}
  </section>;
}

function StudentDashboard({
  data,
  language,
  setLanguage,
  onLogout,
  t
}: {
  data: LoginResponse;
  language: Language;
  setLanguage: (language: Language) => void;
  onLogout: () => void;
  t: Translator;
}) {
  const [activeTab, setActiveTab] = useState("attendance");
  const [dashboardData, setDashboardData] = useState<DashboardData | undefined>(data.dashboard);
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshStatus, setRefreshStatus] = useState("");
  const [studentFees, setStudentFees] = useState<any>(null);
  const [feesLoading, setFeesLoading] = useState(false);
  const [feesError, setFeesError] = useState("");
  const [examRows, setExamRows] = useState<Array<Record<string, any>>>([]);
  const [examLoaded, setExamLoaded] = useState(false);
  const [examLoading, setExamLoading] = useState(false);
  const [notesUnread, setNotesUnread] = useState(0);
  const student = data.student!;
  const [inboxUnread, setInboxUnread] = useState(0);
  const rawDashboard: Partial<DashboardData> = dashboardData || {};
  const dashboard = {
    attendance: Array.isArray(rawDashboard.attendance) ? rawDashboard.attendance : [],
    exams: Array.isArray(rawDashboard.exams) ? rawDashboard.exams : [],
    schedules: Array.isArray(rawDashboard.schedules) ? rawDashboard.schedules : [],
    assignments: Array.isArray(rawDashboard.assignments) ? rawDashboard.assignments : [],
    notes: Array.isArray(rawDashboard.notes) ? rawDashboard.notes : []
  };

  const statusTone = useMemo(() => {
    if (data.status === "attendance_recorded") return "success";
    if (data.status === "pending_review") return "warning";
    return "muted";
  }, [data.status]);

  useEffect(() => {
    if (activeTab !== "fees") return;
    let cancelled = false;
    setFeesLoading(true);
    setFeesError("");
    fetch(`${API_BASE_URL}/student/me/fees`, { headers: { "X-Student-Code": student.student_code } })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.message || t("studentFees.loadError"));
        if (!cancelled) setStudentFees(result);
      })
      .catch((error) => {
        if (!cancelled) setFeesError(error instanceof Error && error.message ? error.message : t("studentFees.loadError"));
      })
      .finally(() => { if (!cancelled) setFeesLoading(false); });
    return () => { cancelled = true; };
  }, [activeTab, refreshKey, student.student_code, t]);

  useEffect(() => {
    if (activeTab !== "exams") return;
    let cancelled = false;
    setExamLoading(true);
    fetch(`${API_BASE_URL}/student/me/exams`, { headers: { "X-Student-Code": student.student_code } })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(t("studentFees.loadError"));
        if (!cancelled) { setExamRows(Array.isArray(result.exams) ? result.exams : []); setExamLoaded(true); }
      })
      .catch(() => { if (!cancelled) setExamLoaded(true); })
      .finally(() => { if (!cancelled) setExamLoading(false); });
    return () => { cancelled = true; };
  }, [activeTab, refreshKey, student.student_code, t]);

  useEffect(() => {
    if (!student.id) return;
    fetch(`${API_BASE_URL}/student/${student.id}/inbox/unread-count`, { headers: { "X-Student-Code": student.student_code } })
      .then((response) => response.json())
      .then((payload) => setInboxUnread(Number(payload.count || 0)))
      .catch(() => undefined);
  }, [activeTab, refreshKey, student.id]);

  async function refreshDashboard() {
    setRefreshing(true);
    setRefreshStatus("");
    try {
      const response = await fetch(`${API_BASE_URL}/student/me/dashboard`, { headers: { "X-Student-Code": student.student_code } });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(t("dashboard.refreshFailed"));
      const nextDashboard = result.dashboard as DashboardData;
      setDashboardData(nextDashboard);
      setExamRows(Array.isArray(nextDashboard.exams) ? nextDashboard.exams : []);
      setExamLoaded(true);
      setRefreshKey((current) => current + 1);
      setRefreshStatus(t("dashboard.refreshed"));
      window.setTimeout(() => setRefreshStatus(""), 2000);
    } catch (error) {
      setRefreshStatus(error instanceof Error ? error.message : t("dashboard.refreshFailed"));
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <Shell language={language} setLanguage={setLanguage} t={t} onLogout={onLogout}>
      <main className="dashboard">
        <section className="dashboard-hero">
          <div>
            <p className="eyebrow">{t("dashboard.eyebrow")}</p>
            <h1>{t("dashboard.welcome", { name: student.full_name })}</h1>
            <p>
              {t("dashboard.todayClass", {
                subject: displayValue(data.today_session?.subject || student.subject, language),
                group: displayValue(data.today_session?.group_name || student.group_name, language)
              })}
            </p>
            <DateTimeWidget language={language} />
          </div>
          <div className={`status-panel ${statusTone}`}>
            <span>{t("dashboard.attendanceLabel")}</span>
            <strong>{statusMessage(data.status, t)}</strong>
            <small>
              {t("dashboard.attendanceTime", {
                time: formatDateTime(
                  data.attendance_record?.checkin_time,
                  language,
                  t("dashboard.notCheckedIn")
                )
              })}
            </small>
          </div>
        </section>

        <section className="summary-grid">
          <Metric label={t("dashboard.studentCode")} value={student.student_code} />
          <Metric label={t("dashboard.group")} value={displayValue(student.group_name, language)} />
          <LatestExamMetric exam={dashboard.exams[0]} language={language} t={t} />
        </section>

        <section className="tabs-surface">
          <div className="tabs-toolbar">
            <div className="tabs" role="tablist" aria-label={language === "ar" ? "بيانات الطالب" : "Student data"}>
            <Tab
              id="attendance"
              active={activeTab}
              onClick={setActiveTab}
              label={t("dashboard.tabs.attendance")}
            />
            <Tab id="exams" active={activeTab} onClick={setActiveTab} label={t("dashboard.tabs.examResults")} />
            <Tab id="fees" active={activeTab} onClick={setActiveTab} label={t("dashboard.tabs.fees")} />
            <Tab
              id="assignments"
              active={activeTab}
              onClick={setActiveTab}
              label={t("dashboard.tabs.homework")}
            />
            <Tab
              id="schedule"
              active={activeTab}
              onClick={setActiveTab}
              label={t("dashboard.tabs.schedule")}
            />
            <Tab id="notes" active={activeTab} onClick={setActiveTab} label={`${t("dashboard.tabs.notes")}${notesUnread ? ` (${notesUnread})` : ""}`} />
            <Tab id="inbox" active={activeTab} onClick={setActiveTab} label={`${t("admin.tabs.inbox")}${inboxUnread ? ` (${inboxUnread})` : ""}`} />
            </div>
            <div className="refresh-control">
              <button className={`secondary-button compact-button ${refreshStatus === t("dashboard.refreshed") ? "refresh-success" : ""}`} type="button" onClick={() => refreshDashboard()} disabled={refreshing}>
                {refreshing ? <span className="refresh-icon is-spinning" aria-hidden="true">↻</span> : null}
                {refreshing ? t("dashboard.refreshing") : refreshStatus || t("dashboard.refresh")}
              </button>
            </div>
          </div>

          {activeTab === "attendance" ? (
            <AttendanceTable rows={dashboard.attendance} language={language} t={t} />
          ) : null}
          {activeTab === "exams" ? examLoading ? <p className="field-hint">{t("admin.profileLoading")}</p> : <ExamsTable rows={examLoaded ? examRows : dashboard.exams} language={language} t={t} /> : null}
          {activeTab === "schedule" ? (
            <ScheduleTable rows={dashboard.schedules} language={language} t={t} />
          ) : null}
          {activeTab === "assignments" ? <HomeworkPanel studentCode={student.student_code} language={language} t={t} refreshKey={refreshKey} /> : null}
          {activeTab === "notes" ? <StudentNotesPanel studentCode={student.student_code} language={language} t={t} onUnreadCountChange={setNotesUnread} refreshKey={refreshKey} /> : null}
          {activeTab === "fees" ? <StudentFeesPanel data={studentFees} loading={feesLoading} error={feesError} language={language} t={t} /> : null}
          {activeTab === "inbox" ? <StudentInboxControls studentCode={student.student_code} language={language} t={t} onUnreadCountChange={setInboxUnread} refreshKey={refreshKey} /> : null}
        </section>
      </main>
    </Shell>
  );
}

function LatestExamMetric({ exam, language, t }: { exam?: Record<string, any>; language: Language; t: Translator }) {
  const evaluation = exam ? scoreEvaluation(exam.score, exam.max_score, t) : null;
  return (
    <div className="metric latest-exam-metric">
      <span>{t("dashboard.lastScore")}</span>
      {exam ? <>
        <strong className={`score-value score-${evaluation?.tone || ""}`}>{exam.score}/{exam.max_score}</strong>
        {evaluation ? <small className={`latest-exam-evaluation score-${evaluation.tone}`}>{evaluation.percentage.toFixed(0)}% — {evaluation.label}</small> : null}
        <small className="latest-exam-date">{t("dashboard.latestExamDate")}: {formatDateOnly(String(exam.exam_date || ""), language, "—")}</small>
      </> : <strong>—</strong>}
    </div>
  );
}

function StudentFeesPanel({
  data,
  loading,
  error,
  language,
  t
}: {
  data: any;
  loading: boolean;
  error: string;
  language: Language;
  t: Translator;
}) {
  if (loading) return <p className="field-hint">{language === "ar" ? "جاري تحميل المصروفات..." : "Loading fees..."}</p>;
  if (error) return <p className="form-error">{error}</p>;
  if (!data?.summary) return <p className="empty-state">{t("studentFees.noHistory")}</p>;
  const summary = data.summary;
  const amount = (value: unknown) => `${Number(value || 0).toFixed(2)} EGP`;
  const status = data.payment_status || "unpaid";
  const statusText = status === "paid" ? t("studentFees.paidStatus") : status === "overdue" ? t("studentFees.overdueStatus") : t("studentFees.unpaidStatus");
  const statusClass = status === "paid" ? "status-active" : status === "overdue" ? "status-deleted" : "status-disabled";
  const coveredMonths = (payment: any) => Array.isArray(payment.payment_months)
    ? payment.payment_months.map((item: any) => item?.month ? new Date(item.month).toLocaleDateString(language === "ar" ? "ar-EG" : "en-US", { month: "long", year: "numeric" }) : "").filter(Boolean).join(", ") || "—"
    : "—";
  const unpaidMonths = Array.isArray(summary.monthly_dues)
    ? summary.monthly_dues.filter((due: any) => Number(due?.remaining_amount || 0) > 0)
    : [];
  const formatDueMonth = (value: unknown) => {
    const month = String(value || "").slice(0, 7);
    const date = new Date(`${month}-01T00:00:00Z`);
    return month && !Number.isNaN(date.getTime())
      ? date.toLocaleDateString(language === "ar" ? "ar-EG" : "en-US", { month: "long", year: "numeric", timeZone: "UTC" })
      : month;
  };
  const unpaidMonthNames = unpaidMonths
    .map((due: any) => formatDueMonth(due?.due_month || due?.month || due?.billing_month))
    .filter(Boolean)
    .join(language === "ar" ? "، " : ", ");
  const unpaidCountLabel = unpaidMonths.length === 1
    ? t("studentFees.monthCountSingular", { count: String(unpaidMonths.length) })
    : t("studentFees.monthCountPlural", { count: String(unpaidMonths.length) });
  return <div className="student-fees-panel">
    <div className="fees-summary-grid">
      <Metric label={t("studentFees.currentCycleFee")} value={amount(summary.current_cycle_fee)} />
      <Metric label={t("studentFees.currentCyclePaid")} value={amount(summary.current_cycle_paid)} />
      <Metric label={t("studentFees.remaining")} value={amount(summary.remaining_balance)} />
      <Metric label={t("studentFees.historicalPaid")} value={amount(summary.total_historical_payments)} />
    </div>
    {unpaidMonths.length ? <div className="student-fees-unpaid-summary" aria-live="polite">
      <strong>{t("studentFees.unpaidMonths")}: {unpaidCountLabel}</strong>
      <span>{unpaidMonthNames}</span>
      <span><b>{t("studentFees.totalRemaining")}</b>: {amount(summary.remaining_balance)}</span>
      <span><b>{t("studentFees.currentMonth")}</b>: {amount(summary.current_cycle_fee)} · {t("studentFees.currentCycleOutstanding")}: {amount(summary.current_cycle_outstanding)}</span>
    </div> : null}
    <p className="student-fees-status"><span>{t("studentFees.status")}</span><strong className={statusClass}>{statusText}</strong></p>
    <h3>{t("studentFees.history")}</h3>
    <div className="table-wrap"><table><thead><tr><th>{t("studentFees.date")}</th><th>{t("studentFees.time")}</th><th>{t("studentFees.amount")}</th><th>{t("studentFees.paidBy")}</th><th>{t("studentFees.coveredCycle")}</th><th>{t("studentFees.notes")}</th></tr></thead><tbody>{(data.payments || []).map((payment: any) => { const paidAt = payment.paid_at || payment.payment_date; const date = paidAt ? new Date(paidAt) : null; return <tr key={payment.id}><td>{date ? date.toLocaleDateString(language === "ar" ? "ar-EG" : "en-US") : "—"}</td><td>{date ? date.toLocaleTimeString(language === "ar" ? "ar-EG" : "en-US", { hour: "2-digit", minute: "2-digit" }) : "—"}</td><td>{amount(payment.amount)}</td><td>{payment.paid_by || "—"}</td><td>{coveredMonths(payment)}</td><td>{payment.notes || "—"}</td></tr>; })}{!data.payments?.length ? <EmptyRow columns={6} t={t} /> : null}</tbody></table></div>
  </div>;
}

function BarcodePreview({ value, displayValue = true }: { value: string; displayValue?: boolean }) {
  const barcodeRef = React.useRef<SVGSVGElement>(null);
  useEffect(() => {
    if (!barcodeRef.current || !value) return;
    try {
      JsBarcode(barcodeRef.current, value, { format: "CODE128", displayValue, fontSize: 12, height: 42, width: 1.4, margin: 0 });
    } catch (_error) {
      if (barcodeRef.current) barcodeRef.current.innerHTML = "";
    }
  }, [value, displayValue]);
  return <svg ref={barcodeRef} className="barcode-preview" aria-label={`Barcode ${value}`} />;
}

function StudentLabelPreview({ student }: { student: Record<string, any> }) {
  const scanSerial = labelScanSerial(student);
  const gradeAndGroup = [student.grade || student.grade_level, student.group_name || student.group].filter(Boolean).join(" · ");
  return <div className="profile-label-preview" dir="rtl">
    <strong className="profile-label-brand">مستر أحمد عبدربه / Mr. Ahmed Abdrabo</strong>
    <strong className="profile-label-name">{student.full_name || "—"}</strong>
    <strong className="profile-label-code">Student code / كود الطالب: {student.student_code || "—"}</strong>
    <span className="profile-label-grade">{gradeAndGroup || "—"}</span>
    {scanSerial ? <><BarcodePreview value={scanSerial} displayValue={false} /><strong className="profile-label-serial">{scanSerial}</strong></> : <span className="empty-state">—</span>}
  </div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StudentInbox({ studentId, studentCode, t }: { studentId: number; studentCode: string; t: Translator }) {
  const [threads, setThreads] = useState<any[]>([]); const [selected, setSelected] = useState<any>(null); const [messages, setMessages] = useState<any[]>([]); const [subject, setSubject] = useState(""); const [body, setBody] = useState(""); const [reply, setReply] = useState(""); const [status, setStatus] = useState("");
  const headers = { "Content-Type": "application/json", "X-Student-Code": studentCode };
  async function load() { const response=await fetch(`${API_BASE_URL}/student/${studentId}/inbox`,{headers}); const data=await response.json(); setThreads(data.threads||[]); }
  async function openThread(thread:any) { setSelected(thread); const response=await fetch(`${API_BASE_URL}/student/${studentId}/inbox/${thread.id}/messages`,{headers}); const data=await response.json(); setMessages(data.messages||[]); load(); }
  useEffect(()=>{load().catch(()=>setStatus(t("inbox.noMessages")));},[studentId]);
  async function sendNew(event:React.FormEvent){event.preventDefault();if(!subject.trim()||!body.trim())return;const response=await fetch(`${API_BASE_URL}/student/${studentId}/inbox`,{method:"POST",headers,body:JSON.stringify({subject:subject.trim(),body:body.trim()})});const data=await response.json();if(data.ok){setSubject("");setBody("");setStatus(t("inbox.sent"));await load();openThread(data.thread);} }
  async function sendReply(event:React.FormEvent){event.preventDefault();if(!selected||!reply.trim())return;const response=await fetch(`${API_BASE_URL}/student/${studentId}/inbox/${selected.id}/messages`,{method:"POST",headers,body:JSON.stringify({body:reply.trim()})});const data=await response.json();if(data.ok){setReply("");await openThread(selected);setStatus(t("inbox.sent"));}}
  return <div className="inbox-layout"><div className="inbox-list"><form onSubmit={sendNew} className="inbox-compose"><h3>{t("inbox.newMessage")}</h3><input value={subject} onChange={(e)=>setSubject(e.target.value)} placeholder={t("inbox.subject")} /><textarea value={body} onChange={(e)=>setBody(e.target.value)} placeholder={t("inbox.message")} rows={3}/><button className="primary-button" type="submit">{t("inbox.send")}</button></form>{threads.length?threads.map((thread)=><button className={`inbox-thread ${selected?.id===thread.id?"active":""}`} key={thread.id} type="button" onClick={()=>openThread(thread)}><strong>{thread.subject}</strong><span>{thread.last_message}</span>{Number(thread.unread_count)>0?<b>{thread.unread_count}</b>:null}</button>):<p className="empty-state">{t("inbox.noMessages")}</p>}</div><div className="inbox-conversation">{selected?<><h3>{selected.subject}</h3><div className="inbox-messages">{messages.map((message)=><article className={`inbox-message ${message.sender_type==="student"?"mine":""}`} key={message.id}><p>{message.body}</p><small>{new Date(message.created_at).toLocaleString()}</small></article>)}</div><form onSubmit={sendReply}><textarea value={reply} onChange={(e)=>setReply(e.target.value)} placeholder={t("inbox.reply")} rows={3}/><button className="primary-button" type="submit">{t("inbox.reply")}</button></form></>:<p className="empty-state">{t("inbox.selectThread")}</p>}</div>{status?<p className="lookup-result">{status}</p>:null}</div>;
}

function StudentInboxControls({ studentCode, language, t, onUnreadCountChange, refreshKey = 0 }: { studentCode: string; language: Language; t: Translator; onUnreadCountChange: (count: number) => void; refreshKey?: number }) {
  const [threads, setThreads] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [reply, setReply] = useState("");
  const [status, setStatus] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [markingRead, setMarkingRead] = useState(false);
  const [sendState, setSendState] = useState<"idle" | "sending" | "sent">("idle");
  const [replyState, setReplyState] = useState<"idle" | "sending" | "sent">("idle");
  const headers = { "Content-Type": "application/json", "X-Student-Code": studentCode };
  const canMarkRead = Boolean(selected && Number(selected.unread_count) > 0);

  async function refresh() {
    setRefreshing(true);
    setStatus("");
    try {
      const response = await fetch(`${API_BASE_URL}/student/inbox`, { headers });
      const data = await parseInboxResponse(response);
      setThreads(Array.isArray(data.threads) ? data.threads : []);
      onUnreadCountChange(Number(data.unread_count || 0));
    } catch (_error) {
      setStatus(t("inbox.loadFailed"));
      throw _error;
    } finally {
      setRefreshing(false);
    }
  }

  async function openThread(thread: any) {
    setStatus("");
    try {
      const response = await fetch(`${API_BASE_URL}/student/${thread.student_id}/inbox/${thread.id}/messages`, { headers });
      const data = await parseInboxResponse(response);
      setSelected(thread);
      setMessages(Array.isArray(data.messages) ? data.messages : []);
    } catch (_error) {
      setStatus(t("inbox.loadFailed"));
    }
  }

  useEffect(() => { refresh().catch(() => undefined); }, [studentCode, refreshKey]);

  async function sendNew(event: React.FormEvent) {
    event.preventDefault();
    if (!subject.trim() || !body.trim() || sendState === "sending") return;
    setSendState("sending");
    setStatus("");
    try {
      const response = await fetch(`${API_BASE_URL}/student/inbox/messages`, { method: "POST", headers, body: JSON.stringify({ subject: subject.trim(), body: body.trim() }) });
      const data = await parseInboxResponse(response);
      setSubject("");
      setBody("");
      await refresh();
      await openThread(data.thread);
      setSendState("sent");
      window.setTimeout(() => setSendState("idle"), 2000);
    } catch (_error) {
      setSendState("idle");
      setStatus(t("inbox.sendFailed"));
    }
  }

  async function sendReply(event: React.FormEvent) {
    event.preventDefault();
    if (!selected || !reply.trim() || replyState === "sending") return;
    setReplyState("sending");
    setStatus("");
    try {
      const response = await fetch(`${API_BASE_URL}/student/${selected.student_id}/inbox/${selected.id}/messages`, { method: "POST", headers, body: JSON.stringify({ body: reply.trim() }) });
      await parseInboxResponse(response);
      setReply("");
      await openThread(selected);
      setReplyState("sent");
      window.setTimeout(() => setReplyState("idle"), 2000);
    } catch (_error) {
      setReplyState("idle");
      setStatus(t("inbox.sendFailed"));
    }
  }

  async function markRead() {
    if (!selected || !canMarkRead || markingRead) return;
    setMarkingRead(true);
    setStatus("");
    try {
      const response = await fetch(`${API_BASE_URL}/student/inbox/${selected.id}/read`, { method: "PUT", headers });
      await parseInboxResponse(response);
      setMessages((current) => current.map((message) => message.sender_type !== "student" ? { ...message, is_read: true } : message));
      setSelected((current) => current ? { ...current, unread_count: 0 } : current);
      await refresh();
      setStatus(t("inbox.markedRead"));
    } catch (_error) {
      setStatus(t("inbox.markReadFailed"));
    } finally {
      setMarkingRead(false);
    }
  }

  return <div className="inbox-panel">
    <div className="inbox-actions">
      <button type="button" onClick={() => markRead()} disabled={!canMarkRead || markingRead}>{markingRead ? t("inbox.markingRead") : t("inbox.markRead")}</button>
      <button type="button" onClick={() => refresh()} disabled={refreshing}>{refreshing ? t("inbox.refreshing") : t("inbox.refresh")}</button>
    </div>
    <div className="inbox-layout">
      <div className="inbox-list">
        <form onSubmit={sendNew} className="inbox-compose"><h3>{t("inbox.newMessage")}</h3><input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder={t("inbox.subject")} /><textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder={t("inbox.message")} rows={3}/><button className={`primary-button ${sendState === "sent" ? "success-button" : ""}`} type="submit" disabled={sendState === "sending"}>{sendState === "sending" ? t("inbox.sending") : sendState === "sent" ? t("inbox.sentStatus") : t("inbox.send")}</button></form>
        {threads.length ? threads.map((thread) => <button className={`inbox-thread ${selected?.id === thread.id ? "active" : ""}`} key={thread.id} type="button" onClick={() => openThread(thread)}><strong>{thread.subject}</strong><span>{thread.last_message}</span><em>{Number(thread.unread_count) > 0 ? t("inbox.unread") : t("inbox.read")}</em>{Number(thread.unread_count) > 0 ? <b>{thread.unread_count}</b> : null}</button>) : <p className="empty-state">{t("inbox.noMessages")}</p>}
      </div>
      <div className="inbox-conversation">{selected ? <>
        <h3>{selected.subject}</h3>
        <div className="inbox-messages">{messages.map((message) => <article className={`inbox-message ${message.sender_type === "student" ? "mine" : ""}`} key={message.id}><p>{message.body}</p><small className="message-meta"><span>{message.sender_name || message.sender_type}</span><span className="message-read-status">{inboxMessageStatus(message, "student", t)}</span><time dateTime={typeof message.created_at === "string" ? message.created_at : undefined}>{formatInboxTimestamp(message.created_at, language)}</time></small></article>)}</div>
        <form onSubmit={sendReply}><textarea value={reply} onChange={(e) => setReply(e.target.value)} placeholder={t("inbox.reply")} rows={3}/><button className={`primary-button ${replyState === "sent" ? "success-button" : ""}`} type="submit" disabled={replyState === "sending"}>{replyState === "sending" ? t("inbox.sending") : replyState === "sent" ? t("inbox.sentStatus") : t("inbox.reply")}</button></form>
      </> : <p className="empty-state">{t("inbox.selectThread")}</p>}</div>
    </div>
    {status ? <p className="lookup-result">{status}</p> : null}
  </div>;
}

function Tab({
  id,
  active,
  onClick,
  label
}: {
  id: string;
  active: string;
  onClick: (id: string) => void;
  label: string;
}) {
  return (
    <button type="button" className={active === id ? "active" : ""} role="tab" onClick={() => onClick(id)}>
      {label}
    </button>
  );
}

function AttendanceTable({
  rows,
  language,
  t
}: {
  rows: Array<Record<string, any>>;
  language: Language;
  t: Translator;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{t("table.class")}</th>
            <th>{t("table.date")}</th>
            <th>{t("table.checkinTime")}</th>
            <th>{t("table.status")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                {displayValue(row.subject, language)} - {displayValue(row.group_name, language)}
              </td>
              <td>{formatDateTime(row.session_date, language, t("dashboard.notCheckedIn"))}</td>
              <td>{formatDateTime(row.checkin_time, language, t("dashboard.notCheckedIn"))}</td>
              <td><AttendanceStatusBadge status={row.status} t={t} /></td>
            </tr>
          ))}
          {!rows.length ? <EmptyRow columns={4} t={t} /> : null}
        </tbody>
      </table>
    </div>
  );
}

function ExamsTable({
  rows,
  language,
  t
}: {
  rows: Array<Record<string, any>>;
  language: Language;
  t: Translator;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{t("table.exam")}</th>
            <th>{t("table.date")}</th>
            <th>{t("table.score")}</th>
            <th>{t("table.assessment")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>{displayValue(row.title, language)}</td>
              <td>{formatDateTime(row.exam_date, language, t("dashboard.notCheckedIn"))}</td>
              <td>
                <span className={`score-value score-${scoreEvaluation(row.score, row.max_score, t)?.tone || ""}`}>
                  {row.score}/{row.max_score}
                </span>
                {scoreEvaluation(row.score, row.max_score, t) ? <small className="score-evaluation-label">{scoreEvaluation(row.score, row.max_score, t)?.label}</small> : null}
              </td>
              <td>{row.assessment || row.note ? displayValue(row.assessment || row.note, language) : "-"}</td>
            </tr>
          ))}
          {!rows.length ? <EmptyRow columns={4} t={t} /> : null}
        </tbody>
      </table>
    </div>
  );
}

function ScheduleTable({
  rows,
  language,
  t
}: {
  rows: Array<Record<string, any>>;
  language: Language;
  t: Translator;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{t("table.day")}</th>
            <th>{t("table.subject")}</th>
            <th>{t("table.group")}</th>
            <th>{t("table.time")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.day_of_week}-${index}`}>
              <td>{t(`days.${Number(row.day_of_week)}` as TranslationKey)}</td>
              <td>{displayValue(row.subject, language)}</td>
              <td>{displayValue(row.group_name, language)}</td>
              <td>
                {String(row.start_time).slice(0, 5)} - {String(row.end_time).slice(0, 5)}
              </td>
            </tr>
          ))}
          {!rows.length ? <EmptyRow columns={4} t={t} /> : null}
        </tbody>
      </table>
    </div>
  );
}

function SimpleList({
  rows,
  titleKey,
  metaKey,
  language,
  t
}: {
  rows: Array<Record<string, any>>;
  titleKey: string;
  metaKey: string;
  language: Language;
  t: Translator;
}) {
  if (!rows.length) return <p className="empty-state">{t("empty.noData")}</p>;
  return (
    <div className="list">
      {rows.map((row, index) => (
        <article key={row.id || index}>
          <strong>{displayValue(row[titleKey], language)}</strong>
          <span>
            {metaKey.includes("date") || metaKey.includes("at")
              ? formatDateTime(row[metaKey], language, t("dashboard.notCheckedIn"))
              : displayValue(row[metaKey], language)}
          </span>
        </article>
      ))}
    </div>
  );
}

function EmptyRow({ columns, t }: { columns: number; t: Translator }) {
  return (
    <tr>
      <td colSpan={columns} className="empty-state">
        {t("empty.noData")}
      </td>
    </tr>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
