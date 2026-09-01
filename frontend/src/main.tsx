import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import JsBarcode from "jsbarcode";
import "./styles.css";
import { normalizeDigits } from "./utils/normalizeDigits";
import { createIdempotencyKey, normalizeScanValue, playScannerFeedback, type ScannerState } from "./utils/scanner";
import { AdminExecutiveDashboard } from "./AdminExecutiveDashboard";
import { SystemSettingsPanel } from "./SystemSettingsPanel";

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
  student_token?: string;
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
    permissions?: string[];
  };
};

type AdminUser = {
  id: number;
  name: string;
  username: string;
  email: string;
  role: "owner" | "admin" | "staff";
  is_active: boolean;
  created_at?: string;
  updated_at?: string;
  deleted_at?: string | null;
  print_student_labels?: boolean;
  max_label_reprints?: number;
  can_use_inbox?: boolean;
  permissions?: PermissionKey[];
  is_owner?: boolean;
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
type AdminTab = "overview" | "add-user" | "users" | "site-content" | "students" | "groups" | "attendance" | "scanner" | "fees" | "exams" | "inbox" | "audit-logs" | "settings";

const adminTabIds: AdminTab[] = ["overview", "add-user", "users", "site-content", "students", "groups", "attendance", "scanner", "fees", "exams", "inbox", "audit-logs", "settings"];
const mobilePrimaryAdminTabIds: AdminTab[] = ["overview", "students", "attendance", "fees"];
const adminTabIcons: Partial<Record<AdminTab, string>> = {
  overview: "⌂",
  students: "♙",
  attendance: "✓",
  fees: "₤",
  groups: "▦",
  scanner: "▥",
  exams: "▤",
  inbox: "✉",
  users: "♙",
  "add-user": "+",
  "site-content": "▤",
  "audit-logs": "◷",
  settings: "⚙"
};

function adminTabFromLocation(): AdminTab {
  const requestedTab = new URLSearchParams(window.location.search).get("tab");
  return requestedTab && adminTabIds.includes(requestedTab as AdminTab) ? requestedTab as AdminTab : "overview";
}

function persistAdminTab(tab: AdminTab) {
  const params = new URLSearchParams(window.location.search);
  if (tab === "overview") params.delete("tab");
  else params.set("tab", tab);
  const query = params.toString();
  const nextUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
  window.history.replaceState({}, "", nextUrl);
}

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
    "scanner.deletedStudent": "هذا الطالب محذوف ولا يمكن استخدامه.",
    "scanner.invalidScan": "قيمة المسح غير صالحة.",
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
    "admin.messagesUnreadOne": "الرسائل، رسالة غير مقروءة",
    "admin.messagesUnreadMany": "الرسائل، {{count}} رسائل غير مقروءة",
    "admin.tabs.auditLogs": "سجل النشاط",
    "admin.tabs.settings": "إعدادات النظام",
    "admin.mobileMore": "المزيد",
    "admin.mobileCloseMore": "إغلاق",
    "admin.mobileAccount": "الحساب",
    "admin.mobileLanguage": "اللغة",
    "admin.mobileNavigation": "تنقل لوحة الإدارة",
    "settings.title": "إعدادات النظام",
    "settings.subtitle": "إدارة الإعدادات التشغيلية التي تؤثر على الحضور والتنبيهات.",
    "settings.generalTitle": "الإعدادات العامة",
    "settings.generalDescription": "بيانات المنصة والهوية البصرية تظل في مصدرها الحالي.",
    "settings.brandingSource": "الهوية والمحتوى",
    "settings.brandingSourceDescription": "يتم تعديل الاسم والصورة والمادة من محتوى الموقع.",
    "settings.currencyLabel": "العملة الحالية",
    "settings.currencyDescription": "تُدار قيم المصروفات من إعدادات كل مجموعة.",
    "settings.attendanceTitle": "إعدادات الحضور",
    "settings.attendanceDescription": "تتحكم القيم التالية في الجلسات الجديدة مع احترام إعدادات الجدول المخصصة.",
    "settings.openBeforeLabel": "فتح الحضور قبل البداية",
    "settings.openBeforeDescription": "المدة الافتراضية قبل بداية الحصة.",
    "settings.closeAfterLabel": "إغلاق الحضور بعد النهاية",
    "settings.closeAfterDescription": "المدة الافتراضية بعد نهاية الحصة.",
    "settings.attendanceAlertLabel": "حد تنبيه الحضور",
    "settings.attendanceAlertDescription": "يظهر التنبيه عند انخفاض حضور الطالب عن هذه النسبة.",
    "settings.minutes": "دقيقة",
    "settings.evaluationTitle": "إعدادات التقييمات",
    "settings.evaluationDescription": "يُستخدم الحد التالي في تنبيهات متوسطات التقييم داخل لوحة التحكم.",
    "settings.evaluationAlertLabel": "حد تنبيه التقييمات",
    "settings.evaluationAlertDescription": "يظهر التنبيه عند انخفاض متوسط تقييم الطالب عن هذه النسبة.",
    "settings.paymentsTitle": "إعدادات المصروفات",
    "settings.paymentsDescription": "تظل قواعد الاستحقاق والعكس مرتبطة بالنظام المالي الحالي.",
    "settings.paymentFeesSource": "قيمة المصروفات",
    "settings.paymentFeesSourceDescription": "تُدار من إعدادات كل مجموعة ولا يتم تكرارها هنا.",
    "settings.reversalSource": "عكس المدفوعات",
    "settings.reversalSourceDescription": "يستمر استبعاد المدفوعات المعكوسة من التقارير.",
    "settings.safeDefaults": "القيم الافتراضية آمنة وتحافظ على السلوك الحالي.",
    "settings.save": "حفظ التغييرات",
    "settings.saving": "جاري الحفظ...",
    "settings.saved": "تم الحفظ",
    "settings.saveFailed": "تعذر حفظ الإعدادات.",
    "settings.loadFailed": "تعذر تحميل الإعدادات.",
    "settings.invalidValues": "تحقق من القيم المدخلة وحدودها.",
    "settings.accessDenied": "ليس لديك صلاحية للوصول إلى إعدادات النظام.",
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
    "inbox.selectThreadTitle": "اختر محادثة",
    "inbox.selectThreadDescription": "اختر رسالة من القائمة لعرض التفاصيل هنا.",
    "inbox.backToList": "العودة إلى المحادثات",
    "inbox.conversations": "المحادثات",
    "inbox.conversationDetails": "تفاصيل المحادثة",
    "inbox.workspaceDescription": "إدارة المحادثات والرسائل الواردة",
    "inbox.publicInquiry": "استفسار عام",
    "inbox.senderStudent": "طالب",
    "inbox.senderPublic": "زائر",
    "inbox.senderAdmin": "مسؤول",
    "inbox.senderTeacher": "مدرس",
    "inbox.senderAssistant": "مساعد",
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
    "audit.allActions": "كل الإجراءات",
    "audit.user": "المستخدم",
    "audit.payment": "رقم الدفعة",
    "audit.student": "رقم الطالب",
    "audit.dateFrom": "من تاريخ",
    "audit.dateTo": "إلى تاريخ",
    "audit.refresh": "تحديث",
    "audit.refreshing": "جاري التحديث...",
    "audit.refreshed": "تم التحديث",
    "audit.maintenance": "صيانة متقدمة",
    "audit.maintenanceWarning": "حذف سجل النشاط نهائي ولا يمكن التراجع عنه.",
    "audit.maintenanceFrom": "من تاريخ",
    "audit.maintenanceTo": "إلى تاريخ",
    "audit.maintenancePin": "رقم سجل النشاط",
    "audit.maintenancePassword": "كلمة مرور المدير",
    "audit.maintenanceReason": "سبب الحذف",
    "audit.maintenanceReasonPlaceholder": "اكتب سبب حذف السجلات",
    "audit.maintenanceConfirmation": "التأكيد الكتابي",
    "audit.maintenanceConfirmationHint": "اكتب DELETE AUDIT LOGS للتأكيد",
    "audit.maintenancePreview": "معاينة السجلات",
    "audit.maintenancePreviewing": "جاري المعاينة...",
    "audit.maintenancePreviewFirst": "قم بمعاينة السجلات أولاً قبل الحذف.",
    "audit.maintenanceCount": "عدد السجلات المطابقة: {{count}}",
    "audit.maintenanceDelete": "حذف السجلات",
    "audit.maintenanceDeleting": "جاري الحذف...",
    "audit.maintenanceDeleted": "تم حذف {{count}} سجل بنجاح.",
    "audit.maintenanceInvalidDates": "اختر تاريخين صحيحين.",
    "audit.maintenancePreviewFailed": "تعذر معاينة السجلات.",
    "audit.maintenanceDeleteFailed": "تعذر حذف السجلات.",
    "audit.maintenanceInvalidPassword": "كلمة مرور المدير غير صحيحة.",
    "audit.maintenancePasswordRequired": "اكتب كلمة مرور المدير.",
    "audit.maintenanceInvalidConfirmation": "اكتب DELETE AUDIT LOGS كما هو للتأكيد.",
    "audit.maintenanceReasonRequired": "اكتب سبب الحذف (3 أحرف على الأقل).",
    "audit.maintenancePinNotConfigured": "يجب إعداد رقم سجل النشاط أولاً.",
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
    "audit.action.studentChanged": "تم تعديل الطالب",
    "audit.action.studentStatusChanged": "تم تغيير حالة طالب",
    "audit.action.studentRestored": "تم استرجاع طالب",
    "audit.action.studentArchived": "تم أرشفة طالب",
    "audit.action.studentsBulkArchived": "تمت أرشفة طلاب محددون",
    "audit.action.studentsBulkPermanentlyDeleted": "تم حذف طلاب نهائيًا",
    "audit.action.studentLabelPrinted": "تمت طباعة ليبل الطالب",
    "audit.action.studentPurged": "تم حذف البيانات الشخصية للطالب",
    "audit.action.attendanceRecorded": "تم تسجيل الحضور",
    "audit.action.messageAction": "تم تنفيذ إجراء على رسالة",
    "audit.action.noteAction": "تم تنفيذ إجراء على ملاحظة",
    "audit.action.pinChanged": "تم تغيير رقم سجل النشاط",
    "audit.action.logsUnlocked": "تم فتح سجل النشاط",
    "audit.action.pinFailed": "فشلت محاولة فتح سجل النشاط",
    "audit.action.systemRequest": "إجراء بالنظام",
    "audit.action.userCreated": "تم إنشاء مستخدم",
    "audit.action.userUpdated": "تم تعديل مستخدم",
    "audit.action.permissionsChanged": "تم تعديل صلاحيات مستخدم",
    "audit.action.roleChanged": "تم تغيير دور مستخدم",
    "audit.action.ownershipTransferred": "تم نقل ملكية النظام",
    "audit.action.userPasswordReset": "تم تغيير كلمة مرور مستخدم",
    "audit.action.userStatusChanged": "تم تغيير حالة مستخدم",
    "audit.action.userArchived": "تمت أرشفة مستخدم",
    "audit.action.userRestored": "تم استرجاع مستخدم",
    "audit.action.userPermanentlyDeleted": "تم حذف مستخدم نهائياً",
    "audit.action.loginSucceeded": "تم تسجيل الدخول",
    "audit.action.loginFailed": "فشلت محاولة تسجيل الدخول",
    "audit.action.logout": "تم تسجيل الخروج",
    "audit.action.groupCreated": "تم إنشاء مجموعة",
    "audit.action.groupUpdated": "تم تعديل المجموعة",
    "audit.action.groupStatusChanged": "تم تغيير حالة المجموعة",
    "audit.action.groupArchived": "تمت أرشفة المجموعة",
    "audit.action.examResultCreated": "تم تسجيل نتيجة امتحان",
    "audit.action.examResultUpdated": "تم تعديل نتيجة امتحان",
    "audit.action.examResultDeleted": "تم حذف نتيجة امتحان",
    "audit.action.homeworkCreated": "تم إنشاء واجب",
    "audit.action.homeworkUpdated": "تم تعديل واجب",
    "audit.action.homeworkDeleted": "تم حذف واجب",
    "audit.action.noteCreated": "تمت إضافة ملاحظة",
    "audit.action.noteUpdated": "تم تعديل ملاحظة",
    "audit.action.noteDeleted": "تم حذف ملاحظة",
    "audit.action.messageSent": "تم إرسال رسالة",
    "audit.action.messageDeleted": "تم حذف رسالة",
    "audit.action.messageRead": "تم تحديث حالة قراءة الرسالة",
    "audit.action.attendanceChanged": "تم تغيير الحضور",
    "audit.action.attendanceScanned": "تم تنفيذ مسح الحضور",
    "audit.action.attendanceSessionCreated": "تم إنشاء جلسة حضور",
    "audit.action.suspiciousScan": "تم تسجيل محاولة مسح مشبوهة",
    "audit.action.studentScanSerialRegenerated": "تم تجديد سريال مسح الطالب",
    "audit.action.studentPermanentlyAnonymized": "تم إخفاء بيانات الطالب نهائياً",
    "audit.action.sitePageUpdated": "تم تعديل محتوى صفحة الموقع",
    "audit.action.publicInquiryCreated": "تم إنشاء استفسار عام",
    "audit.action.systemAction": "إجراء إداري بالنظام",
    "audit.action.systemSettingsChanged": "تم تعديل إعدادات النظام",
    "audit.detail.summary": "وصف العملية",
    "audit.detail.before": "قبل التغيير",
    "audit.detail.after": "بعد التغيير",
    "audit.detail.changes": "التغييرات",
    "audit.detail.studentId": "معرّف الطالب",
    "audit.detail.studentName": "اسم الطالب",
    "audit.detail.studentCode": "كود الطالب",
    "audit.detail.userId": "معرّف المستخدم",
    "audit.detail.targetUser": "المستخدم المتأثر",
    "audit.detail.groupId": "معرّف المجموعة",
    "audit.detail.examId": "معرّف الامتحان",
    "audit.detail.resultId": "معرّف النتيجة",
    "audit.detail.noteId": "معرّف الملاحظة",
    "audit.detail.threadId": "معرّف المحادثة",
    "audit.detail.messageId": "معرّف الرسالة",
    "audit.detail.recordId": "معرّف سجل الحضور",
    "audit.detail.statusBefore": "الحالة قبل التغيير",
    "audit.detail.statusAfter": "الحالة بعد التغيير",
    "audit.detail.amount": "المبلغ",
    "audit.detail.scannedValue": "القيمة الممسوحة",
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
    "audit.detail.actor": "بواسطة",
    "audit.detail.outcome": "النتيجة",
    "audit.detail.printType": "نوع الطباعة",
    "audit.detail.serial": "السريال",
    "audit.detail.scanSerial": "سريال المسح",
    "audit.detail.remainingPrintCount": "عدد مرات الطباعة المتبقية",
    "audit.detail.sessionDate": "تاريخ الجلسة",
    "audit.detail.checkinTime": "وقت التسجيل",
    "audit.detail.guardianPhone": "رقم ولي الأمر",
    "audit.detail.phone": "رقم الهاتف",
    "audit.detail.grade": "الصف الدراسي",
    "audit.detail.groupName": "المجموعة",
    "audit.detail.field": "الحقل",
    "audit.detail.valueBefore": "القيمة السابقة",
    "audit.detail.valueAfter": "القيمة الجديدة",
    "audit.detail.content": "المحتوى",
    "audit.value.success": "نجحت",
    "audit.value.failure": "فشلت",
    "audit.value.reprint": "إعادة طباعة",
    "audit.value.initialPrint": "طباعة",
    "audit.value.set": "تم التعيين",
    "audit.narrative.userCreated": "تم إنشاء المستخدم: {{name}} — اسم المستخدم: {{username}} — الدور: {{role}}",
    "audit.narrative.userUpdated": "تم تعديل المستخدم: {{name}} — اسم المستخدم: {{username}}",
    "audit.narrative.userPasswordReset": "تم تغيير كلمة مرور المستخدم: {{name}}",
    "audit.narrative.userArchived": "تم حذف المستخدم: {{name}}",
    "audit.narrative.student": "تم {{action}} الطالب: {{name}} — كود الطالب: {{code}}",
    "audit.narrative.payment": "تم تسجيل دفع مصروفات للطالب: {{name}} — الكود: {{code}} — المبلغ: {{amount}} جنيه",
    "audit.narrative.advancePayment": "تم تسجيل دفع مقدم للطالب: {{name}} — الكود: {{code}} — المبلغ: {{amount}} جنيه",
    "audit.narrative.reversed": "تم عكس الدفعة رقم {{payment}} للطالب: {{name}} — المبلغ: {{amount}} جنيه — السبب: {{reason}}",
    "audit.narrative.attendance": "تم تسجيل حضور الطالب: {{name}} — كود الطالب: {{code}}",
    "audit.narrative.labelPrinted": "تمت {{printType}} ليبل الطالب: {{name}} — كود الطالب: {{code}}",
    "audit.narrative.serialRegenerated": "تم تجديد سريال مسح الطالب: {{name}} — كود الطالب: {{code}}",
    "audit.narrative.logsUnlocked": "قام المستخدم {{actor}} بفتح سجل النشاط بنجاح.",
    "audit.narrative.pinFailed": "فشلت محاولة المستخدم {{actor}} لفتح سجل النشاط.",
    "audit.narrative.generic": "تم تنفيذ إجراء: {{action}}",
    "audit.word.created": "إنشاء",
    "audit.word.updated": "تعديل",
    "audit.word.deleted": "حذف",
    "audit.word.restored": "استرجاع",
    "audit.word.statusChanged": "تغيير حالة",
    "admin.siteContent": "محتوى الموقع",
    "dashboard.adminTitle": "لوحة التحكم",
    "dashboard.adminSubtitle": "نظرة عامة على الأداء المالي والطلاب والمجموعات",
    "admin.permission.dashboard.view": "عرض لوحة التحكم",
    "admin.permission.dashboard.financial": "عرض البيانات المالية",
    "admin.permission.dashboard.groupPerformance": "عرض أداء المجموعات",
    "admin.permission.dashboard.alerts": "عرض التنبيهات",
    "admin.permission.dashboard.activity": "عرض النشاط",
    "dashboard.filters": "الفلاتر",
    "dashboard.period": "الفترة",
    "dashboard.currentPeriod": "الشهر الحالي",
    "dashboard.previousPeriod": "الشهر السابق",
    "dashboard.last3Months": "آخر 3 شهور",
    "dashboard.last6Months": "آخر 6 شهور",
    "dashboard.currentYear": "السنة الحالية",
    "dashboard.customPeriod": "فترة مخصصة",
    "dashboard.from": "من",
    "dashboard.to": "إلى",
    "dashboard.allGroups": "كل المجموعات",
    "dashboard.totalIncome": "إجمالي الدخل منذ البداية",
    "dashboard.periodIncome": "إجمالي دخل الفترة",
    "dashboard.paidStudents": "الطلاب الذين دفعوا",
    "dashboard.overdueStudents": "الطلاب المتأخرون عن الدفع",
    "dashboard.collectionRate": "نسبة التحصيل",
    "dashboard.collectionStatus": "حالة التحصيل",
    "dashboard.required": "إجمالي المطلوب",
    "dashboard.collected": "تم تحصيله",
    "dashboard.remaining": "المتبقي",
    "dashboard.studentStatus": "حالة الطلاب",
    "dashboard.paid": "دفع",
    "dashboard.overdue": "متأخر",
    "dashboard.groupPerformance": "أداء المجموعات",
    "dashboard.attendanceRate": "نسبة الحضور",
    "dashboard.evaluationAverage": "متوسط التقييمات",
    "dashboard.students": "إجمالي الطلاب",
    "dashboard.activeStudents": "الطلاب النشطون",
    "dashboard.revenueTrend": "تطور الدخل خلال آخر 6 أشهر",
    "dashboard.importantAlerts": "تنبيهات مهمة",
    "dashboard.attendanceAlert": "طلاب أقل من نسبة الحضور المحددة",
    "dashboard.evaluationAlert": "طلاب بمتوسط تقييم منخفض",
    "dashboard.threshold": "الحد الأدنى {{value}}%",
    "dashboard.recentPayments": "آخر التحصيلات",
    "dashboard.paymentMethod": "طريقة الدفع",
    "dashboard.viewTransactions": "عرض كل المعاملات",
    "dashboard.previous": "عن الفترة السابقة",
    "dashboard.noData": "لا توجد بيانات كافية لهذه الفترة",
    "dashboard.needsAttention": "يحتاجون متابعة",
    "dashboard.noAttention": "لا يوجد طلاب يحتاجون متابعة حاليًا",
    "dashboard.attentionAttendance": "غياب مرتفع — الحضور {{value}}%",
    "dashboard.attentionEvaluation": "متوسط التقييمات {{value}}%",
    "dashboard.attentionPayment": "مصروفات متأخرة — {{amount}}",
    "dashboard.quickActions": "إجراءات سريعة",
    "dashboard.addStudent": "إضافة طالب",
    "dashboard.recordAttendance": "تسجيل حضور",
    "dashboard.recordPayment": "تسجيل دفعة",
    "dashboard.addEvaluation": "إضافة تقييم",
    "dashboard.student360": "ملف الطالب الشامل",
    "dashboard.student360Subtitle": "ملخص الحضور والتقييمات والمصروفات",
    "dashboard.noStudentData": "لا توجد بيانات كافية لهذا الطالب",
    "dashboard.metricAttendance": "الحضور",
    "dashboard.metricEvaluations": "التقييمات",
    "dashboard.metricPayments": "المصروفات",
    "dashboard.metricSessions": "{{present}} من {{total}} حصة",
    "dashboard.metricAverage": "متوسط",
    "dashboard.metricCollected": "{{paid}} / {{required}} جنيه",
    "dashboard.currentAttention": "يحتاج متابعة",
    "dashboard.noCurrentAttention": "لا توجد تنبيهات حالية",
    "dashboard.searchOpen": "فتح البحث",
    "dashboard.searchClose": "إغلاق البحث",
    "dashboard.searchStudents": "بحث عن طالب",
    "dashboard.searchPlaceholder": "ابحث بالاسم أو الكود أو الهاتف",
    "dashboard.searchHint": "اكتب حرفين على الأقل للبحث",
    "dashboard.searchLoading": "جاري البحث...",
    "dashboard.searchNoResults": "لا توجد نتائج مطابقة",
    "dashboard.notificationCenter": "مركز الإشعارات",
    "dashboard.notifications": "الإشعارات",
    "dashboard.noNotifications": "لا توجد إشعارات جديدة",
    "dashboard.viewAllNotifications": "عرض كل الإشعارات",
    "dashboard.markAllRead": "تحديد الكل كمقروء",
    "dashboard.markRead": "تحديد كمقروء",
    "dashboard.newMessageNotification": "رسالة جديدة",
    "dashboard.attendanceNotification": "تنبيه حضور",
    "dashboard.evaluationNotification": "تنبيه تقييم",
    "dashboard.paymentNotification": "تنبيه مصروفات",
    "dashboard.notificationDescriptionMessage": "رسالة جديدة من {{name}}",
    "dashboard.notificationDescriptionAttendance": "{{name}} يحتاج متابعة في الحضور",
    "dashboard.notificationDescriptionEvaluation": "{{name}} لديه متوسط تقييم منخفض",
    "dashboard.notificationDescriptionPayment": "{{name}} لديه مصروفات متأخرة",
    "dashboard.notificationsLoadFailed": "تعذر تحميل الإشعارات",
    "dashboard.loading": "جاري تحميل بيانات اللوحة...",
    "dashboard.retry": "إعادة المحاولة",
    "dashboard.accessDenied": "ليس لديك صلاحية لعرض لوحة التحكم.",
    "dashboard.cash": "نقدي",
    "dashboard.bank": "تحويل بنكي",
    "dashboard.card": "بطاقة",
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
    "admin.userDetails": "بيانات المستخدم",
    "admin.userSettings": "الصلاحيات والإعدادات",
    "admin.userList": "قائمة المستخدمين",
    "admin.printLabels": "السماح بطباعة الليبل",
    "admin.maxReprints": "الحد الأقصى لإعادة الطباعة",
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
    "admin.restoring": "جاري الاسترجاع...",
    "admin.restored": "تم الاسترجاع",
    "admin.loadingDetails": "جاري تحميل التفاصيل...",
    "admin.detailsLoaded": "تم تحميل التفاصيل",
    "admin.disabling": "جاري التعطيل...",
    "admin.disabledSuccessfully": "تم التعطيل",
    "admin.enabling": "جاري التفعيل...",
    "admin.enabledSuccessfully": "تم التفعيل",
    "admin.deleting": "جاري الحذف...",
    "admin.deletedSuccessfully": "تم الحذف",
    "admin.deleteStudent": "حذف",
    "admin.studentDeleting": "جاري الحذف...",
    "admin.studentDeleted": "تم الحذف",
    "admin.studentArchiveConfirm": "هل أنت متأكد من أرشفة الطالب {{name}} ({{code}})؟",
    "admin.studentPermanentDeleteConfirm": "سيتم حذف الطالب {{name}} ({{code}}) نهائيًا ولا يمكن استرجاعه. هل أنت متأكد؟",
    "admin.labelReady": "الليبل جاهز للطباعة",
    "admin.printPopupBlocked": "اسمح بالنوافذ المنبثقة للطباعة",
    "admin.labelPrintLimitReached": "انتهت صلاحية أو عدد طباعة الليبل",
    "admin.permanentDelete": "حذف نهائي",
    "admin.permanentDeleteConfirm": "سيتم حذف الطالب نهائياً ولا يمكن استرجاعه. هل أنت متأكد؟",
    "admin.retentionPrompt": "ما البيانات التي تريد الاحتفاظ بها بعد حذف الطالب نهائيًا؟",
    "admin.retentionEvaluations": "الامتحانات والتقييمات",
    "admin.retentionFinancial": "السجلات المالية والمدفوعات",
    "admin.retentionAttendance": "الحضور والانضباط",
    "admin.retentionNotes": "الملاحظات / السجل الأكاديمي",
    "admin.retentionSelectAll": "تحديد الكل",
    "admin.retentionFinancialWarning": "تحذير: حذف السجلات المالية قد يغيّر إجماليات الإيرادات والتقارير التاريخية.",
    "admin.retentionIdentityWarning": "سيتم حذف هوية الطالب وملفه وبيانات التواصل والقدرة على الاسترجاع نهائيًا.",
    "admin.retentionConfirmSingle": "تأكيد الحذف النهائي",
    "admin.retentionConfirmBulk": "تأكيد الحذف النهائي لـ {{count}} طلاب",
    "admin.invalidRetention": "اختيارات الاحتفاظ بالبيانات غير صالحة.",
    "admin.permanentDeleteUserConfirm": "سيتم حذف المستخدم نهائياً من قاعدة البيانات ولا يمكن استرجاعه. هل أنت متأكد؟",
    "admin.permanentlyDeleting": "جاري الحذف النهائي...",
    "admin.permanentlyDeleted": "تم الحذف",
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
    "admin.resettingPassword": "جاري إعادة تعيين كلمة المرور...",
    "admin.deleteUser": "حذف",
    "admin.ownershipTransferred": "تم نقل ملكية النظام بنجاح.",
    "admin.adminOnly": "هذا القسم متاح للمدير فقط.",
    "admin.ownerBadge": "مالك النظام",
    "admin.primaryAdmin": "المدير الأساسي",
    "admin.role.owner": "مالك النظام",
    "admin.role.admin": "مدير",
    "admin.role.staff": "موظف",
    "admin.permissions": "الصلاحيات",
    "admin.permissionPreset": "قالب الصلاحيات",
    "admin.permissionPreset.full": "صلاحيات كاملة",
    "admin.permissionPreset.students": "إدارة الطلاب",
    "admin.permissionPreset.finance": "الحسابات",
    "admin.permissionPreset.readOnly": "عرض فقط",
    "admin.permissionPreset.custom": "صلاحيات مخصصة",
    "admin.permissionGroup.students": "الطلاب",
    "admin.permissionGroup.attendance": "الحضور والغياب",
    "admin.permissionGroup.exams": "الامتحانات والتقييمات",
    "admin.permissionGroup.homework": "الواجبات",
    "admin.permissionGroup.schedule": "الجداول والحصص",
    "admin.permissionGroup.payments": "المصروفات",
    "admin.permissionGroup.messages": "الرسائل",
    "admin.permissionGroup.notes": "الملاحظات",
    "admin.permissionGroup.users": "المستخدمون",
    "admin.permissionGroup.activity": "سجل النشاط",
    "admin.permissionGroup.settings": "الإعدادات",
    "admin.permissionGroup.dashboard": "لوحة التحكم التنفيذية",
    "admin.permission.view": "عرض",
    "admin.permission.manage": "إدارة",
    "admin.permission.collect": "تسجيل دفع",
    "admin.permission.advance": "دفع مقدم",
    "admin.permission.reportsView": "عرض التقارير",
    "admin.permission.reverse": "إلغاء / عكس دفعة",
    "admin.permission.create": "إنشاء مستخدم",
    "admin.permission.edit": "تعديل",
    "admin.permission.disable": "تعطيل",
    "admin.permission.delete": "حذف",
    "admin.transferOwnership": "نقل الملكية",
    "admin.transferOwnershipConfirm": "سيتم نقل ملكية النظام لهذا المستخدم. أدخل كلمة مرورك للتأكيد.",
    "admin.currentPassword": "كلمة المرور الحالية",
    "admin.ownerProtected": "هذا هو مالك النظام ولا يمكن للمديرين تعديل دوره أو صلاحياته أو تعطيله أو حذفه.",
    "admin.permissionGrantForbidden": "لا يمكنك منح صلاحيات لا تملكها.",
    "admin.ownerOnly": "هذا الإجراء متاح لمالك النظام فقط.",
    "admin.role.teacher": "موظف",
    "admin.role.assistant": "موظف",
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
    "admin.scheduleRequired": "اختر يوم حصة واحدًا على الأقل.",
    "admin.scheduleTimeRequired": "اختر وقت البداية والنهاية.",
    "admin.invalidNumber": "أدخل قيمة رقمية صحيحة.",
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
    "admin.generateCode": "توليد كود",
    "admin.groupSaved": "تم حفظ المجموعة.",
    "admin.groupHasStudents": "لا يمكن حذف مجموعة بها طلاب. قم بنقل الطلاب أو تعطيل المجموعة.",
    "admin.groupDeletePinTitle": "حذف مجموعة بها طلاب",
    "admin.groupDeletePinDescription": "تحتوي هذه المجموعة على {{count}} طلاب. أدخل الرمز السري لسجل النشاطات للسماح بالحذف. سيتم أرشفة المجموعة فقط ولن يتم حذف سجلات الطلاب.",
    "admin.groupDeletePin": "الرمز السري لسجل النشاطات",
    "admin.groupDeletePinAction": "تأكيد حذف المجموعة",
    "admin.groupDeletePinLoading": "جاري حذف المجموعة...",
    "admin.groupDeletePinRequired": "أدخل الرمز السري لسجل النشاطات.",
    "admin.groupDeletePinInvalid": "الرمز السري لسجل النشاطات غير صحيح.",
    "admin.groupDeletePinLocked": "تم قفل الرمز السري مؤقتًا. حاول مرة أخرى لاحقًا.",
    "admin.groupDeletePinNotConfigured": "لم يتم إعداد الرمز السري لسجل النشاطات.",
    "admin.studentSaved": "تم حفظ الطالب. الكود: {{code}}",
    "admin.noGroups": "لا توجد مجموعات بعد.",
    "admin.noStudents": "لا يوجد طلاب بعد.",
    "admin.searchStudents": "ابحث باسم الطالب أو الكود أو الهاتف أو المجموعة",
    "admin.groupFilter": "المجموعة",
    "admin.allGroups": "كل المجموعات",
    "admin.selectAll": "تحديد الكل",
    "admin.deselectAll": "إلغاء تحديد الكل",
    "admin.clearDaySelection": "إلغاء تحديد الأيام",
    "admin.selectStudentCheckbox": "تحديد الطالب",
    "admin.selectedStudents": "تم تحديد {{count}} طلاب",
    "admin.bulkDelete": "حذف المحدد ({{count}})",
    "admin.bulkDeleteLoading": "جاري حذف {{count}} طلاب...",
    "admin.bulkDeleteSuccess": "تم حذف {{count}} طلاب",
    "admin.bulkDeleteConfirm": "هل أنت متأكد من حذف {{count}} طلاب؟ سيؤثر هذا الإجراء على عدة سجلات.",
    "admin.permanentBulkDelete": "حذف نهائي ({{count}})",
    "admin.permanentBulkDeleteLoading": "جاري الحذف النهائي لـ {{count}} طلاب...",
    "admin.permanentBulkDeleteSuccess": "تم حذف {{count}} طلاب نهائيًا.",
    "admin.permanentBulkDeleteTitle": "حذف نهائي للطلاب",
    "admin.permanentBulkDeleteWarning": "سيتم حذف {{count}} طلاب نهائيًا من النظام. هذا الإجراء لا يمكن التراجع عنه.",
    "admin.permanentBulkDeletePhrasePrompt": "للتأكيد، اكتب: حذف نهائي",
    "admin.permanentBulkDeletePhrase": "حذف نهائي",
    "admin.permanentDeleteProtectedRecords": "تعذر الحذف النهائي لأن بعض الطلاب لديهم سجلات مالية أو تاريخية أو رسائل محمية.",
    "admin.permanentDeleteTooMany": "يمكن حذف 100 طالب كحد أقصى في العملية الواحدة.",
    "admin.actionFailedDelete": "تعذر الحذف",
    "admin.actionFailedSave": "تعذر الحفظ",
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
    "errors.ownerProtected": "لا يمكن تعديل أو تعطيل أو حذف مالك النظام.",
    "errors.permissionRequired": "ليس لديك الصلاحية لتنفيذ هذا الإجراء.",
    "errors.ownerOnly": "هذا الإجراء متاح لمالك النظام فقط.",
    "errors.ownerTransferRequired": "لا يمكن تعيين مالك جديد من خلال تعديل عادي. استخدم نقل الملكية.",
    "errors.permissionGrantForbidden": "لا يمكنك منح صلاحيات لا تملكها.",
    "errors.invalidOwnerPassword": "كلمة مرور مالك النظام غير صحيحة.",
    "errors.invalidOwnerTarget": "المستخدم المختار غير صالح لنقل الملكية.",
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
    "scanner.deletedStudent": "This student is deleted and cannot be used.",
    "scanner.invalidScan": "The scanned value is invalid.",
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
    "admin.messagesUnreadOne": "Messages, 1 unread message",
    "admin.messagesUnreadMany": "Messages, {{count}} unread messages",
    "admin.tabs.auditLogs": "Audit Logs",
    "admin.tabs.settings": "System Settings",
    "admin.mobileMore": "More",
    "admin.mobileCloseMore": "Close",
    "admin.mobileAccount": "Account",
    "admin.mobileLanguage": "Language",
    "admin.mobileNavigation": "Admin navigation",
    "settings.title": "System Settings",
    "settings.subtitle": "Manage operational settings that affect attendance and alerts.",
    "settings.generalTitle": "General settings",
    "settings.generalDescription": "Platform identity and branding remain owned by their existing source of truth.",
    "settings.brandingSource": "Branding and content",
    "settings.brandingSourceDescription": "Update the name, photo, and subject from Site Content.",
    "settings.currencyLabel": "Current currency",
    "settings.currencyDescription": "Fee amounts are managed per group.",
    "settings.attendanceTitle": "Attendance settings",
    "settings.attendanceDescription": "These values control new sessions while respecting custom schedule settings.",
    "settings.openBeforeLabel": "Open attendance before start",
    "settings.openBeforeDescription": "Default window before a class starts.",
    "settings.closeAfterLabel": "Close attendance after end",
    "settings.closeAfterDescription": "Default window after a class ends.",
    "settings.attendanceAlertLabel": "Attendance alert threshold",
    "settings.attendanceAlertDescription": "Alerts appear when a student falls below this rate.",
    "settings.minutes": "minutes",
    "settings.evaluationTitle": "Evaluation settings",
    "settings.evaluationDescription": "This threshold is used by dashboard low-evaluation alerts.",
    "settings.evaluationAlertLabel": "Evaluation alert threshold",
    "settings.evaluationAlertDescription": "Alerts appear when a student evaluation average falls below this rate.",
    "settings.paymentsTitle": "Payment settings",
    "settings.paymentsDescription": "Due and reversal rules remain connected to the existing financial model.",
    "settings.paymentFeesSource": "Fee amounts",
    "settings.paymentFeesSourceDescription": "Managed per group and intentionally not duplicated here.",
    "settings.reversalSource": "Payment reversals",
    "settings.reversalSourceDescription": "Reversed payments continue to be excluded from reports.",
    "settings.safeDefaults": "Safe defaults preserve current application behavior.",
    "settings.save": "Save changes",
    "settings.saving": "Saving...",
    "settings.saved": "Saved",
    "settings.saveFailed": "Could not save settings.",
    "settings.loadFailed": "Could not load settings.",
    "settings.invalidValues": "Check the values and their allowed ranges.",
    "settings.accessDenied": "You do not have permission to access System Settings.",
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
    "inbox.selectThreadTitle": "Select a conversation",
    "inbox.selectThreadDescription": "Choose a message from the list to view its details here.",
    "inbox.backToList": "Back to conversations",
    "inbox.conversations": "Conversations",
    "inbox.conversationDetails": "Conversation details",
    "inbox.workspaceDescription": "Manage incoming conversations and messages",
    "inbox.publicInquiry": "Public inquiry",
    "inbox.senderStudent": "Student",
    "inbox.senderPublic": "Visitor",
    "inbox.senderAdmin": "Admin",
    "inbox.senderTeacher": "Teacher",
    "inbox.senderAssistant": "Assistant",
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
    "audit.allActions": "All actions",
    "audit.user": "User",
    "audit.payment": "Payment ID",
    "audit.student": "Student ID",
    "audit.dateFrom": "Date from",
    "audit.dateTo": "Date to",
    "audit.refresh": "Refresh",
    "audit.refreshing": "Refreshing...",
    "audit.refreshed": "Updated",
    "audit.maintenance": "Advanced maintenance",
    "audit.maintenanceWarning": "Deleting audit logs is permanent and cannot be undone.",
    "audit.maintenanceFrom": "Date from",
    "audit.maintenanceTo": "Date to",
    "audit.maintenancePin": "Audit PIN",
    "audit.maintenancePassword": "Admin password",
    "audit.maintenanceReason": "Deletion reason",
    "audit.maintenanceReasonPlaceholder": "Write the reason for deleting these records",
    "audit.maintenanceConfirmation": "Typed confirmation",
    "audit.maintenanceConfirmationHint": "Type DELETE AUDIT LOGS to confirm",
    "audit.maintenancePreview": "Preview records",
    "audit.maintenancePreviewing": "Previewing...",
    "audit.maintenancePreviewFirst": "Preview the records before deleting them.",
    "audit.maintenanceCount": "Matching records: {{count}}",
    "audit.maintenanceDelete": "Delete records",
    "audit.maintenanceDeleting": "Deleting...",
    "audit.maintenanceDeleted": "{{count}} records deleted successfully.",
    "audit.maintenanceInvalidDates": "Choose two valid dates.",
    "audit.maintenancePreviewFailed": "Could not preview the records.",
    "audit.maintenanceDeleteFailed": "Could not delete the records.",
    "audit.maintenanceInvalidPassword": "The admin password is incorrect.",
    "audit.maintenancePasswordRequired": "Enter the admin password.",
    "audit.maintenanceInvalidConfirmation": "Type DELETE AUDIT LOGS exactly to confirm.",
    "audit.maintenanceReasonRequired": "Write a deletion reason (at least 3 characters).",
    "audit.maintenancePinNotConfigured": "Set up the audit PIN first.",
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
    "audit.action.studentChanged": "Student changed",
    "audit.action.studentStatusChanged": "Student status changed",
    "audit.action.studentRestored": "Student restored",
    "audit.action.studentArchived": "Student archived",
    "audit.action.studentsBulkArchived": "Students archived in bulk",
    "audit.action.studentsBulkPermanentlyDeleted": "Students permanently deleted in bulk",
    "audit.action.studentLabelPrinted": "Student label printed",
    "audit.action.studentPurged": "Student personal data purged",
    "audit.action.attendanceRecorded": "Attendance recorded",
    "audit.action.messageAction": "Message action",
    "audit.action.noteAction": "Note action",
    "audit.action.pinChanged": "Audit PIN changed",
    "audit.action.logsUnlocked": "Audit logs unlocked",
    "audit.action.pinFailed": "Audit PIN attempt failed",
    "audit.action.systemRequest": "System action",
    "audit.action.userCreated": "User created",
    "audit.action.userUpdated": "User updated",
    "audit.action.permissionsChanged": "User permissions changed",
    "audit.action.roleChanged": "User role changed",
    "audit.action.ownershipTransferred": "System ownership transferred",
    "audit.action.userPasswordReset": "User password changed",
    "audit.action.userStatusChanged": "User status changed",
    "audit.action.userArchived": "User archived",
    "audit.action.userRestored": "User restored",
    "audit.action.userPermanentlyDeleted": "User permanently deleted",
    "audit.action.loginSucceeded": "Login successful",
    "audit.action.loginFailed": "Login attempt failed",
    "audit.action.logout": "Logged out",
    "audit.action.groupCreated": "Group created",
    "audit.action.groupUpdated": "Group updated",
    "audit.action.groupStatusChanged": "Group status changed",
    "audit.action.groupArchived": "Group archived",
    "audit.action.examResultCreated": "Exam result recorded",
    "audit.action.examResultUpdated": "Exam result updated",
    "audit.action.examResultDeleted": "Exam result deleted",
    "audit.action.homeworkCreated": "Homework created",
    "audit.action.homeworkUpdated": "Homework updated",
    "audit.action.homeworkDeleted": "Homework deleted",
    "audit.action.noteCreated": "Note added",
    "audit.action.noteUpdated": "Note updated",
    "audit.action.noteDeleted": "Note deleted",
    "audit.action.messageSent": "Message sent",
    "audit.action.messageDeleted": "Message deleted",
    "audit.action.messageRead": "Message read status updated",
    "audit.action.attendanceChanged": "Attendance changed",
    "audit.action.attendanceScanned": "Attendance scan processed",
    "audit.action.attendanceSessionCreated": "Attendance session created",
    "audit.action.suspiciousScan": "Suspicious scan recorded",
    "audit.action.studentScanSerialRegenerated": "Student scan serial regenerated",
    "audit.action.studentPermanentlyAnonymized": "Student data permanently anonymized",
    "audit.action.sitePageUpdated": "Site page content updated",
    "audit.action.publicInquiryCreated": "Public inquiry created",
    "audit.action.systemAction": "Administrative system action",
    "audit.action.systemSettingsChanged": "System settings changed",
    "audit.detail.summary": "Operation summary",
    "audit.detail.before": "Before change",
    "audit.detail.after": "After change",
    "audit.detail.changes": "Changes",
    "audit.detail.studentId": "Student ID",
    "audit.detail.studentName": "Student name",
    "audit.detail.studentCode": "Student code",
    "audit.detail.userId": "User ID",
    "audit.detail.targetUser": "Affected user",
    "audit.detail.groupId": "Group ID",
    "audit.detail.examId": "Exam ID",
    "audit.detail.resultId": "Result ID",
    "audit.detail.noteId": "Note ID",
    "audit.detail.threadId": "Thread ID",
    "audit.detail.messageId": "Message ID",
    "audit.detail.recordId": "Attendance record ID",
    "audit.detail.statusBefore": "Status before",
    "audit.detail.statusAfter": "Status after",
    "audit.detail.amount": "Amount",
    "audit.detail.scannedValue": "Scanned value",
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
    "audit.detail.actor": "Performed by",
    "audit.detail.outcome": "Outcome",
    "audit.detail.printType": "Print type",
    "audit.detail.serial": "Serial",
    "audit.detail.scanSerial": "Scan serial",
    "audit.detail.remainingPrintCount": "Remaining print count",
    "audit.detail.sessionDate": "Session date",
    "audit.detail.checkinTime": "Check-in time",
    "audit.detail.guardianPhone": "Guardian phone",
    "audit.detail.phone": "Phone",
    "audit.detail.grade": "Grade level",
    "audit.detail.groupName": "Group",
    "audit.detail.field": "Field",
    "audit.detail.valueBefore": "Previous value",
    "audit.detail.valueAfter": "New value",
    "audit.detail.content": "Content",
    "audit.value.success": "Success",
    "audit.value.failure": "Failed",
    "audit.value.reprint": "Reprint",
    "audit.value.initialPrint": "Print",
    "audit.value.set": "Set",
    "audit.narrative.userCreated": "User created: {{name}} — Username: {{username}} — Role: {{role}}",
    "audit.narrative.userUpdated": "User updated: {{name}} — Username: {{username}}",
    "audit.narrative.userPasswordReset": "User password changed: {{name}}",
    "audit.narrative.userArchived": "User deleted: {{name}}",
    "audit.narrative.student": "Student {{action}}: {{name}} — Student code: {{code}}",
    "audit.narrative.payment": "Payment recorded for student: {{name}} — Code: {{code}} — Amount: {{amount}} EGP",
    "audit.narrative.advancePayment": "Advance payment recorded for student: {{name}} — Code: {{code}} — Amount: {{amount}} EGP",
    "audit.narrative.reversed": "Payment #{{payment}} reversed for student: {{name}} — Amount: {{amount}} EGP — Reason: {{reason}}",
    "audit.narrative.attendance": "Attendance recorded for student: {{name}} — Student code: {{code}}",
    "audit.narrative.labelPrinted": "Student label {{printType}}: {{name}} — Student code: {{code}}",
    "audit.narrative.serialRegenerated": "Student scan serial regenerated: {{name}} — Student code: {{code}}",
    "audit.narrative.logsUnlocked": "User {{actor}} unlocked the activity log successfully.",
    "audit.narrative.pinFailed": "User {{actor}} failed to unlock the activity log.",
    "audit.narrative.generic": "Action completed: {{action}}",
    "audit.word.created": "created",
    "audit.word.updated": "updated",
    "audit.word.deleted": "deleted",
    "audit.word.restored": "restored",
    "audit.word.statusChanged": "status changed",
    "admin.siteContent": "Site Content",
    "dashboard.adminTitle": "Executive Dashboard",
    "dashboard.adminSubtitle": "A focused view of financial, student, and group performance",
    "admin.permission.dashboard.view": "View dashboard",
    "admin.permission.dashboard.financial": "View financial data",
    "admin.permission.dashboard.groupPerformance": "View group performance",
    "admin.permission.dashboard.alerts": "View alerts",
    "admin.permission.dashboard.activity": "View activity",
    "dashboard.filters": "Filters",
    "dashboard.period": "Period",
    "dashboard.currentPeriod": "Current month",
    "dashboard.previousPeriod": "Previous month",
    "dashboard.last3Months": "Last 3 months",
    "dashboard.last6Months": "Last 6 months",
    "dashboard.currentYear": "Current year",
    "dashboard.customPeriod": "Custom period",
    "dashboard.from": "From",
    "dashboard.to": "To",
    "dashboard.allGroups": "All groups",
    "dashboard.totalIncome": "Total income since launch",
    "dashboard.periodIncome": "Period income",
    "dashboard.paidStudents": "Students who paid",
    "dashboard.overdueStudents": "Students overdue",
    "dashboard.collectionRate": "Collection rate",
    "dashboard.collectionStatus": "Collection status",
    "dashboard.required": "Expected",
    "dashboard.collected": "Collected",
    "dashboard.remaining": "Remaining",
    "dashboard.studentStatus": "Student payment status",
    "dashboard.paid": "Paid",
    "dashboard.overdue": "Overdue",
    "dashboard.groupPerformance": "Group performance",
    "dashboard.attendanceRate": "Attendance rate",
    "dashboard.evaluationAverage": "Evaluation average",
    "dashboard.students": "Total students",
    "dashboard.activeStudents": "Active students",
    "dashboard.revenueTrend": "Revenue trend over the last 6 months",
    "dashboard.importantAlerts": "Important alerts",
    "dashboard.attendanceAlert": "Students below the attendance threshold",
    "dashboard.evaluationAlert": "Students with a low evaluation average",
    "dashboard.threshold": "Threshold {{value}}%",
    "dashboard.recentPayments": "Recent payments",
    "dashboard.paymentMethod": "Payment method",
    "dashboard.viewTransactions": "View all transactions",
    "dashboard.previous": "vs previous period",
    "dashboard.noData": "There is not enough data for this period",
    "dashboard.needsAttention": "Needs attention",
    "dashboard.noAttention": "No students currently need attention",
    "dashboard.attentionAttendance": "Low attendance — {{value}}%",
    "dashboard.attentionEvaluation": "Low evaluation average — {{value}}%",
    "dashboard.attentionPayment": "Overdue payments — {{amount}}",
    "dashboard.quickActions": "Quick actions",
    "dashboard.addStudent": "Add student",
    "dashboard.recordAttendance": "Record attendance",
    "dashboard.recordPayment": "Record payment",
    "dashboard.addEvaluation": "Add evaluation",
    "dashboard.student360": "Student 360",
    "dashboard.student360Subtitle": "Attendance, evaluation, and payment summary",
    "dashboard.noStudentData": "There is not enough data for this student",
    "dashboard.metricAttendance": "Attendance",
    "dashboard.metricEvaluations": "Evaluations",
    "dashboard.metricPayments": "Payments",
    "dashboard.metricSessions": "{{present}} of {{total}} sessions",
    "dashboard.metricAverage": "Average",
    "dashboard.metricCollected": "{{paid}} / {{required}} EGP",
    "dashboard.currentAttention": "Needs attention",
    "dashboard.noCurrentAttention": "No current alerts",
    "dashboard.searchOpen": "Open search",
    "dashboard.searchClose": "Close search",
    "dashboard.searchStudents": "Search students",
    "dashboard.searchPlaceholder": "Search by name, code, or phone",
    "dashboard.searchHint": "Type at least two characters to search",
    "dashboard.searchLoading": "Searching...",
    "dashboard.searchNoResults": "No matching results",
    "dashboard.notificationCenter": "Notification center",
    "dashboard.notifications": "Notifications",
    "dashboard.noNotifications": "No new notifications",
    "dashboard.viewAllNotifications": "View all notifications",
    "dashboard.markAllRead": "Mark all as read",
    "dashboard.markRead": "Mark as read",
    "dashboard.newMessageNotification": "New message",
    "dashboard.attendanceNotification": "Attendance alert",
    "dashboard.evaluationNotification": "Evaluation alert",
    "dashboard.paymentNotification": "Payment alert",
    "dashboard.notificationDescriptionMessage": "New message from {{name}}",
    "dashboard.notificationDescriptionAttendance": "{{name}} needs attendance follow-up",
    "dashboard.notificationDescriptionEvaluation": "{{name}} has a low evaluation average",
    "dashboard.notificationDescriptionPayment": "{{name}} has overdue payments",
    "dashboard.notificationsLoadFailed": "Unable to load notifications",
    "dashboard.loading": "Loading dashboard data...",
    "dashboard.retry": "Retry",
    "dashboard.accessDenied": "You do not have permission to view the dashboard.",
    "dashboard.cash": "Cash",
    "dashboard.bank": "Bank transfer",
    "dashboard.card": "Card",
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
    "admin.userDetails": "User details",
    "admin.userSettings": "Permissions & settings",
    "admin.userList": "User list",
    "admin.printLabels": "Allow label printing",
    "admin.maxReprints": "Maximum reprints",
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
    "admin.restoring": "Restoring...",
    "admin.restored": "Restored",
    "admin.loadingDetails": "Loading details...",
    "admin.detailsLoaded": "Details loaded",
    "admin.disabling": "Disabling...",
    "admin.disabledSuccessfully": "Disabled",
    "admin.enabling": "Enabling...",
    "admin.enabledSuccessfully": "Enabled",
    "admin.deleting": "Deleting...",
    "admin.deletedSuccessfully": "Deleted",
    "admin.deleteStudent": "Delete",
    "admin.studentDeleting": "Deleting...",
    "admin.studentDeleted": "Deleted",
    "admin.studentArchiveConfirm": "Are you sure you want to archive student {{name}} ({{code}})?",
    "admin.studentPermanentDeleteConfirm": "Student {{name}} ({{code}}) will be permanently deleted and cannot be restored. Are you sure?",
    "admin.labelReady": "Label ready for printing",
    "admin.printPopupBlocked": "Please allow pop-ups to print labels",
    "admin.labelPrintLimitReached": "Label print permission or limit reached",
    "admin.permanentDelete": "Permanent Delete",
    "admin.permanentDeleteConfirm": "This student will be permanently deleted and cannot be restored. Are you sure?",
    "admin.retentionPrompt": "What data would you like to retain after permanently deleting the student?",
    "admin.retentionEvaluations": "Exams and evaluations",
    "admin.retentionFinancial": "Financial records and payments",
    "admin.retentionAttendance": "Attendance and discipline",
    "admin.retentionNotes": "Notes / academic record",
    "admin.retentionSelectAll": "Select all",
    "admin.retentionFinancialWarning": "Warning: deleting financial history may change historical revenue and report totals.",
    "admin.retentionIdentityWarning": "The student's identity, profile, contact details, and restore capability will be permanently removed.",
    "admin.retentionConfirmSingle": "Confirm permanent delete",
    "admin.retentionConfirmBulk": "Confirm permanent delete for {{count}} students",
    "admin.invalidRetention": "The retention selections are invalid.",
    "admin.permanentDeleteUserConfirm": "This user will be permanently deleted from the database and cannot be restored. Are you sure?",
    "admin.permanentlyDeleting": "Permanently deleting...",
    "admin.permanentlyDeleted": "Deleted",
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
    "admin.resettingPassword": "Resetting password...",
    "admin.deleteUser": "Delete",
    "admin.ownershipTransferred": "System ownership transferred successfully.",
    "admin.adminOnly": "This section is available to admins only.",
    "admin.ownerBadge": "System Owner",
    "admin.primaryAdmin": "Primary Admin",
    "admin.role.owner": "Owner",
    "admin.role.admin": "Admin",
    "admin.role.staff": "Staff",
    "admin.permissions": "Permissions",
    "admin.permissionPreset": "Permission preset",
    "admin.permissionPreset.full": "Full permissions",
    "admin.permissionPreset.students": "Student management",
    "admin.permissionPreset.finance": "Accounts",
    "admin.permissionPreset.readOnly": "Read only",
    "admin.permissionPreset.custom": "Custom permissions",
    "admin.permissionGroup.students": "Students",
    "admin.permissionGroup.attendance": "Attendance",
    "admin.permissionGroup.exams": "Exams and assessments",
    "admin.permissionGroup.homework": "Homework",
    "admin.permissionGroup.schedule": "Schedules and classes",
    "admin.permissionGroup.payments": "Payments",
    "admin.permissionGroup.messages": "Messages",
    "admin.permissionGroup.notes": "Notes",
    "admin.permissionGroup.users": "Users",
    "admin.permissionGroup.activity": "Activity log",
    "admin.permissionGroup.settings": "Settings",
    "admin.permissionGroup.dashboard": "Executive dashboard",
    "admin.permission.view": "View",
    "admin.permission.manage": "Manage",
    "admin.permission.collect": "Record payment",
    "admin.permission.advance": "Advance payment",
    "admin.permission.reportsView": "View reports",
    "admin.permission.reverse": "Reverse payment",
    "admin.permission.create": "Create user",
    "admin.permission.edit": "Edit",
    "admin.permission.disable": "Disable",
    "admin.permission.delete": "Delete",
    "admin.transferOwnership": "Transfer ownership",
    "admin.transferOwnershipConfirm": "Ownership will be transferred to this user. Enter your password to confirm.",
    "admin.currentPassword": "Current password",
    "admin.ownerProtected": "This is the system owner. Admins cannot change the owner role or permissions, disable, or delete this account.",
    "admin.permissionGrantForbidden": "You cannot grant permissions that you do not have.",
    "admin.ownerOnly": "This action is available only to the system owner.",
    "admin.role.teacher": "Staff",
    "admin.role.assistant": "Staff",
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
    "admin.scheduleRequired": "Select at least one class day.",
    "admin.scheduleTimeRequired": "Select both a start and end time.",
    "admin.invalidNumber": "Enter a valid number.",
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
    "admin.groupHasStudents": "Cannot delete a group that has students. Move students or disable the group.",
    "admin.groupDeletePinTitle": "Delete group with students",
    "admin.groupDeletePinDescription": "This group contains {{count}} students. Enter the Activity Log PIN to allow deletion. Only the group will be archived; student records will not be deleted.",
    "admin.groupDeletePin": "Activity Log PIN",
    "admin.groupDeletePinAction": "Confirm group deletion",
    "admin.groupDeletePinLoading": "Deleting group...",
    "admin.groupDeletePinRequired": "Enter the Activity Log PIN.",
    "admin.groupDeletePinInvalid": "The Activity Log PIN is incorrect.",
    "admin.groupDeletePinLocked": "The PIN is temporarily locked. Try again later.",
    "admin.groupDeletePinNotConfigured": "Set up the Activity Log PIN first.",
    "admin.studentSaved": "Student saved. Code: {{code}}",
    "admin.noGroups": "No groups yet.",
    "admin.noStudents": "No students yet.",
    "admin.searchStudents": "Search by student name, code, phone, or group",
    "admin.groupFilter": "Group",
    "admin.selectAll": "Select All",
    "admin.deselectAll": "Deselect All",
    "admin.clearDaySelection": "Clear day selection",
    "admin.selectStudentCheckbox": "Select student",
    "admin.selectedStudents": "{{count}} students selected",
    "admin.bulkDelete": "Delete selected ({{count}})",
    "admin.bulkDeleteLoading": "Deleting {{count}} students...",
    "admin.bulkDeleteSuccess": "Deleted {{count}} students",
    "admin.bulkDeleteConfirm": "Are you sure you want to delete {{count}} students? This action affects multiple records.",
    "admin.permanentBulkDelete": "Permanent Delete ({{count}})",
    "admin.permanentBulkDeleteLoading": "Permanently deleting {{count}} students...",
    "admin.permanentBulkDeleteSuccess": "{{count}} students permanently deleted.",
    "admin.permanentBulkDeleteTitle": "Permanently delete students",
    "admin.permanentBulkDeleteWarning": "{{count}} students will be permanently deleted from the system. This action cannot be undone.",
    "admin.permanentBulkDeletePhrasePrompt": "To confirm, type: PERMANENT DELETE",
    "admin.permanentBulkDeletePhrase": "PERMANENT DELETE",
    "admin.permanentDeleteProtectedRecords": "Permanent deletion is blocked because some students have protected financial, historical, or message records.",
    "admin.permanentDeleteTooMany": "You can permanently delete up to 100 students at a time.",
    "admin.actionFailedDelete": "Delete failed",
    "admin.actionFailedSave": "Save failed",
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
    "errors.ownerProtected": "The system owner cannot be modified, disabled, or deleted.",
    "errors.permissionRequired": "You do not have permission to perform this action.",
    "errors.ownerOnly": "This action is available only to the system owner.",
    "errors.ownerTransferRequired": "A new owner must be assigned through the secure ownership transfer action.",
    "errors.permissionGrantForbidden": "You cannot grant permissions that you do not have.",
    "errors.invalidOwnerPassword": "The system owner password is incorrect.",
    "errors.invalidOwnerTarget": "The selected user cannot receive ownership.",
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
type PermissionKey =
  | "students.view" | "students.manage" | "students.delete"
  | "attendance.view" | "attendance.manage"
  | "exams.view" | "exams.manage"
  | "homework.view" | "homework.manage"
  | "schedule.view" | "schedule.manage"
  | "payments.view" | "payments.manage" | "payments.collect" | "payments.advance" | "payments.reports.view" | "payments.reverse"
  | "messages.view" | "messages.manage"
  | "notes.view" | "notes.manage"
  | "users.view" | "users.create" | "users.edit" | "users.disable" | "users.delete"
  | "activity_log.view" | "settings.manage"
  | "dashboard.view" | "dashboard.financial.view" | "dashboard.group_performance.view" | "dashboard.alerts.view" | "dashboard.activity.view";

const allRbacPermissions: PermissionKey[] = [
  "students.view", "students.manage", "students.delete", "attendance.view", "attendance.manage", "exams.view", "exams.manage",
  "homework.view", "homework.manage", "schedule.view", "schedule.manage", "payments.view", "payments.collect", "payments.advance", "payments.reports.view", "payments.reverse",
  "messages.view", "messages.manage", "notes.view", "notes.manage", "users.view", "users.create", "users.edit", "users.disable",
  "users.delete", "activity_log.view", "settings.manage", "dashboard.view", "dashboard.financial.view",
  "dashboard.group_performance.view", "dashboard.alerts.view", "dashboard.activity.view"
];

const permissionGroups: Array<{ label: TranslationKey; permissions: Array<{ key: PermissionKey; label: TranslationKey }> }> = [
  { label: "admin.permissionGroup.students", permissions: [{ key: "students.view", label: "admin.permission.view" }, { key: "students.manage", label: "admin.permission.manage" }, { key: "students.delete", label: "admin.permission.delete" }] },
  { label: "admin.permissionGroup.attendance", permissions: [{ key: "attendance.view", label: "admin.permission.view" }, { key: "attendance.manage", label: "admin.permission.manage" }] },
  { label: "admin.permissionGroup.exams", permissions: [{ key: "exams.view", label: "admin.permission.view" }, { key: "exams.manage", label: "admin.permission.manage" }] },
  { label: "admin.permissionGroup.homework", permissions: [{ key: "homework.view", label: "admin.permission.view" }, { key: "homework.manage", label: "admin.permission.manage" }] },
  { label: "admin.permissionGroup.schedule", permissions: [{ key: "schedule.view", label: "admin.permission.view" }, { key: "schedule.manage", label: "admin.permission.manage" }] },
  { label: "admin.permissionGroup.payments", permissions: [
    { key: "payments.view", label: "admin.permission.view" },
    { key: "payments.collect", label: "admin.permission.collect" },
    { key: "payments.advance", label: "admin.permission.advance" },
    { key: "payments.reports.view", label: "admin.permission.reportsView" },
    { key: "payments.reverse", label: "admin.permission.reverse" }
  ] },
  { label: "admin.permissionGroup.messages", permissions: [{ key: "messages.view", label: "admin.permission.view" }, { key: "messages.manage", label: "admin.permission.manage" }] },
  { label: "admin.permissionGroup.notes", permissions: [{ key: "notes.view", label: "admin.permission.view" }, { key: "notes.manage", label: "admin.permission.manage" }] },
  { label: "admin.permissionGroup.users", permissions: [{ key: "users.view", label: "admin.permission.view" }, { key: "users.create", label: "admin.permission.create" }, { key: "users.edit", label: "admin.permission.edit" }, { key: "users.disable", label: "admin.permission.disable" }, { key: "users.delete", label: "admin.permission.delete" }] },
  { label: "admin.permissionGroup.activity", permissions: [{ key: "activity_log.view", label: "admin.permission.view" }] },
  { label: "admin.permissionGroup.settings", permissions: [{ key: "settings.manage", label: "admin.permission.manage" }] },
  { label: "admin.permissionGroup.dashboard", permissions: [
    { key: "dashboard.view", label: "admin.permission.dashboard.view" },
    { key: "dashboard.financial.view", label: "admin.permission.dashboard.financial" },
    { key: "dashboard.group_performance.view", label: "admin.permission.dashboard.groupPerformance" },
    { key: "dashboard.alerts.view", label: "admin.permission.dashboard.alerts" },
    { key: "dashboard.activity.view", label: "admin.permission.dashboard.activity" }
  ] }
];

const permissionPresets: Array<{ key: string; label: TranslationKey; permissions: PermissionKey[] }> = [
  { key: "full", label: "admin.permissionPreset.full", permissions: allRbacPermissions },
  { key: "students", label: "admin.permissionPreset.students", permissions: ["students.view", "students.manage", "attendance.view", "attendance.manage", "exams.view", "exams.manage", "homework.view", "homework.manage"] },
  { key: "finance", label: "admin.permissionPreset.finance", permissions: ["students.view", "payments.view", "payments.collect", "payments.advance", "payments.reports.view", "payments.reverse"] },
  { key: "readOnly", label: "admin.permissionPreset.readOnly", permissions: allRbacPermissions.filter((permission) => permission.endsWith(".view")) },
  { key: "custom", label: "admin.permissionPreset.custom", permissions: [] }
];

function sessionHasPermission(session: TeacherSession, permission: PermissionKey) {
  if (session.teacher.role === "owner" || session.teacher.permissions?.includes(permission) === true) return true;
  return (permission === "payments.collect" || permission === "payments.advance") && session.teacher.permissions?.includes("payments.manage") === true;
}

function editorPermissions(permissions: PermissionKey[] = []) {
  const next = permissions.filter((permission) => permission !== "payments.manage");
  if (permissions.includes("payments.manage")) next.push("payments.collect", "payments.advance");
  return [...new Set(next)];
}

type ActionButtonState = "idle" | "loading" | "success" | "error";

function useActionFeedback() {
  const [state, setState] = useState<ActionButtonState>("idle");
  const timerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  async function run(action: () => Promise<void>, successDuration = 1800) {
    if (state === "loading") return false;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    setState("loading");
    try {
      await action();
      setState("success");
      timerRef.current = window.setTimeout(() => setState("idle"), successDuration);
      return true;
    } catch (error) {
      setState("error");
      timerRef.current = window.setTimeout(() => setState("idle"), 1800);
      throw error;
    }
  }

  return { state, run };
}

function actionButtonText(state: ActionButtonState, labels: { idle: string; loading: string; success: string; error: string }) {
  if (state === "loading") return labels.loading;
  if (state === "success") return `✓ ${labels.success}`;
  if (state === "error") return labels.error;
  return labels.idle;
}

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
    student_token: data.student_token,
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

function studentAuthHeaders(studentCode: string) {
  let token = "";
  try {
    const stored = sessionStorage.getItem(STUDENT_SESSION_STORAGE_KEY);
    token = stored ? String((JSON.parse(stored) as LoginResponse).student_token || "") : "";
  } catch (_error) {
    token = "";
  }
  return { "X-Student-Code": studentCode, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
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
  const key = data.teacher.role === "owner" || data.teacher.role === "admin"
    ? ADMIN_SESSION_STORAGE_KEY
    : data.teacher.role === "assistant"
      ? ASSISTANT_SESSION_STORAGE_KEY
      : TEACHER_SESSION_STORAGE_KEY;
  sessionStorage.setItem(
    key,
    JSON.stringify({
      token: data.token,
      teacher: {
        id: data.teacher.id,
        name: data.teacher.name,
        email: data.teacher.email,
        username: data.teacher.username,
        role: data.teacher.role,
        permissions: data.teacher.permissions || []
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
    deleted_student: "scanner.deletedStudent",
    student_not_found: "scanner.invalidCode",
    invalid_scan_value: "scanner.invalidScan",
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
  if (status === "owner_protected") return t("errors.ownerProtected");
  if (status === "owner_only") return t("errors.ownerOnly");
  if (status === "owner_transfer_required") return t("errors.ownerTransferRequired");
  if (status === "permission_grant_forbidden") return t("errors.permissionGrantForbidden");
  if (status === "permission_required") return t("errors.permissionRequired");
  if (status === "invalid_owner_password") return t("errors.invalidOwnerPassword");
  if (status === "invalid_owner_target" || status === "invalid_transfer_payload") return t("errors.invalidOwnerTarget");
  if (status === "group_delete_pin_required") return t("admin.groupDeletePinRequired");
  if (status === "invalid_audit_pin") return t("admin.groupDeletePinInvalid");
  if (status === "audit_pin_locked") return t("admin.groupDeletePinLocked");
  if (status === "audit_pin_not_configured") return t("admin.groupDeletePinNotConfigured");
  if (status === "student_code_exists") return t("admin.codeExists");
  if (status === "invalid_retention") return t("admin.invalidRetention");
  if (status === "invalid_student_code") return t("admin.invalidStudentCode");
  if (status === "invalid_phone") return t("errors.phoneLength");
  if (status === "invalid_national_id") return t("errors.nationalIdLength");
  if (status === "invalid_group" || status === "invalid_group_payload" || status === "invalid_student_payload") {
    return t("admin.invalidPayload");
  }
  if (status === "student_has_protected_records") return t("admin.permanentDeleteProtectedRecords");
  if (status === "too_many_student_ids") return t("admin.permanentDeleteTooMany");
  if (status === "invalid_student_ids" || status === "student_not_found" || status === "student_already_deleted" || status === "bulk_delete_conflict" || status === "permanent_delete_conflict") {
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
    if (!teacherSession?.token) return;
    let cancelled = false;
    fetch(`${API_BASE_URL}/teacher/me`, { headers: { Authorization: `Bearer ${teacherSession.token}` } })
      .then((response) => response.json().then((data) => ({ response, data })))
      .then(({ response, data }) => {
        if (cancelled || !response.ok || !data.ok || !data.teacher) return;
        const refreshed = { token: teacherSession.token, teacher: data.teacher } as TeacherSession;
        saveTeacherSession(refreshed);
        setTeacherSession(refreshed);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [teacherSession?.token]);

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

  async function handleLogout() {
    const code = loginData?.student?.student_code;
    if (code) await fetch(`${API_BASE_URL}/student/logout`, { method: "POST", headers: studentAuthHeaders(code) }).catch(() => undefined);
    sessionStorage.removeItem(STUDENT_SESSION_STORAGE_KEY);
    setLoginData(null);
    setStudentCode("");
    setError("");
    resetLookupModal();
    navigate("/");
  }

  async function handleTeacherLogout() {
    if (teacherSession?.token) await fetch(`${API_BASE_URL}/teacher/logout`, { method: "POST", headers: { Authorization: `Bearer ${teacherSession.token}` } }).catch(() => undefined);
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
              onChange={(event) => setStudentCode(normalizeScanValue(event.target.value))}
              placeholder={t("student.codePlaceholder")}
              autoComplete="off"
              autoFocus
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
    const response = await fetch(`${API_BASE_URL}/site/contact`, { method: "POST", headers: { "Content-Type": "application/json", ...(studentCode ? studentAuthHeaders(studentCode) : {}) }, body: JSON.stringify({ ...contactForm, student_id: studentId }) });
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

function AnimatedTabPanel({ children }: { children: React.ReactNode }) {
  return <div className="admin-tab-transition">{children}</div>;
}

type GlobalSearchResult = {
  id: number;
  name: string;
  studentCode?: string;
  studentSerial?: string;
  groupName?: string;
  gradeLevel?: string;
  isActive?: boolean;
};

type HeaderNotification = {
  id: number;
  type: string;
  entity_type?: string | null;
  entity_id?: number | null;
  target_section?: string | null;
  payload?: { studentName?: string; studentCode?: string; groupName?: string; amount?: number | null; value?: number | null };
  is_read: boolean;
  created_at: string;
};

function GlobalSearch({ session, language, t, onSelect }: { session: TeacherSession; language: Language; t: Translator; onSelect: (studentId: number) => void }) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<GlobalSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  useEffect(() => () => requestRef.current?.abort(), []);
  useEffect(() => {
    if (!open) return undefined;
    const onOutside = (event: MouseEvent) => { if (!containerRef.current?.contains(event.target as Node)) setOpen(false); };
    const onEscape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); setTerm(""); } };
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onEscape);
    return () => { document.removeEventListener("mousedown", onOutside); document.removeEventListener("keydown", onEscape); };
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const value = term.trim();
    if (value.length < 2) { requestRef.current?.abort(); setResults([]); setLoading(false); setError(""); setActiveIndex(-1); return undefined; }
    const timer = window.setTimeout(() => {
      requestRef.current?.abort();
      const controller = new AbortController();
      requestRef.current = controller;
      setLoading(true);
      setError("");
      fetch(`${API_BASE_URL}/admin/search?q=${encodeURIComponent(value)}&limit=12`, { headers: { Authorization: `Bearer ${session.token}` }, signal: controller.signal })
        .then(async (response) => {
          const payload = await response.json().catch(() => ({}));
          if (!response.ok || !payload.ok) throw new Error("search_failed");
          return payload.results as GlobalSearchResult[];
        })
        .then((nextResults) => { if (!controller.signal.aborted) { setResults(nextResults || []); setActiveIndex(-1); } })
        .catch((reason) => { if (reason?.name !== "AbortError") setError(t("errors.loginFailed")); })
        .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [open, term, session.token, t]);

  function choose(result: GlobalSearchResult) {
    setOpen(false);
    setTerm("");
    onSelect(result.id);
  }

  return <div className="admin-header-tool global-search" ref={containerRef}>
    <button className={`admin-tool-button ${open ? "active" : ""}`} type="button" aria-label={open ? t("dashboard.searchClose") : t("dashboard.searchOpen")} title={t("dashboard.searchOpen")} aria-expanded={open} onClick={() => { setOpen(true); window.setTimeout(() => inputRef.current?.focus(), 0); }}>⌕</button>
    {open ? <div className="header-popover search-popover" role="dialog" aria-label={t("dashboard.searchStudents")}>
      <label className="visually-hidden" htmlFor="global-student-search">{t("dashboard.searchStudents")}</label>
      <input id="global-student-search" ref={inputRef} value={term} onChange={(event) => setTerm(event.target.value)} onKeyDown={(event) => {
        if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((value) => Math.min(results.length - 1, value + 1)); }
        if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((value) => Math.max(0, value - 1)); }
        if (event.key === "Enter" && activeIndex >= 0 && results[activeIndex]) { event.preventDefault(); choose(results[activeIndex]); }
        if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
      }} placeholder={t("dashboard.searchPlaceholder")} autoComplete="off" />
      {loading ? <p className="header-popover-state">{t("dashboard.searchLoading")}</p> : error ? <p className="header-popover-state form-error">{error}</p> : term.trim().length < 2 ? <p className="header-popover-state">{t("dashboard.searchHint")}</p> : results.length ? <div className="search-results" role="listbox">{results.map((result, index) => <button type="button" role="option" aria-selected={index === activeIndex} className={`search-result ${index === activeIndex ? "active" : ""}`} key={result.id} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(result)}><span className="search-result-avatar">{result.name.slice(0, 1)}</span><span><strong>{result.name}</strong><small>{result.studentCode || result.studentSerial || "—"} · {result.groupName || "—"}</small></span></button>)}</div> : <p className="header-popover-state">{t("dashboard.searchNoResults")}</p>}
    </div> : null}
  </div>;
}

function notificationTitle(type: string, t: Translator) {
  if (type === "new_message") return t("dashboard.newMessageNotification");
  if (type === "attendance_low") return t("dashboard.attendanceNotification");
  if (type === "evaluation_low") return t("dashboard.evaluationNotification");
  return t("dashboard.paymentNotification");
}

function notificationDescription(notification: HeaderNotification, t: Translator, language: Language) {
  const name = notification.payload?.studentName || (language === "ar" ? "الطالب" : "Student");
  if (notification.type === "new_message") return t("dashboard.notificationDescriptionMessage", { name });
  if (notification.type === "attendance_low") return t("dashboard.notificationDescriptionAttendance", { name });
  if (notification.type === "evaluation_low") return t("dashboard.notificationDescriptionEvaluation", { name });
  return t("dashboard.notificationDescriptionPayment", { name });
}

function NotificationCenter({ session, language, t, onSelect }: { session: TeacherSession; language: Language; t: Translator; onSelect: (notification: HeaderNotification) => void }) {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<HeaderNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const readBusyRef = useRef(new Set<number>());
  const markAllBusyRef = useRef(false);

  async function load(limit = expanded ? 20 : 10, signal?: AbortSignal) {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/admin/notifications?limit=${limit}`, { headers: { Authorization: `Bearer ${session.token}` }, signal });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error("notifications_failed");
      if (!signal?.aborted) { setNotifications(payload.notifications || []); setUnreadCount(Number(payload.unreadCount || 0)); setError(""); }
    } catch (reason: unknown) {
      const isAbortError = reason !== null && typeof reason === "object" && "name" in reason && reason.name === "AbortError";
      if (!isAbortError) setError(t("dashboard.notificationsLoadFailed"));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    requestRef.current = controller;
    void load(10, controller.signal);
    const interval = window.setInterval(() => { if (!document.hidden) void load(expanded ? 20 : 10); }, 45000);
    return () => { controller.abort(); requestRef.current?.abort(); window.clearInterval(interval); };
  }, [session.token]);
  useEffect(() => {
    if (!open) return undefined;
    const onOutside = (event: MouseEvent) => { if (!containerRef.current?.contains(event.target as Node)) setOpen(false); };
    const onEscape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onEscape);
    return () => { document.removeEventListener("mousedown", onOutside); document.removeEventListener("keydown", onEscape); };
  }, [open]);

  async function markRead(id: number) {
    if (readBusyRef.current.has(id)) return;
    readBusyRef.current.add(id);
    try {
      const response = await fetch(`${API_BASE_URL}/admin/notifications/${id}/read`, { method: "PATCH", headers: { Authorization: `Bearer ${session.token}` } });
      if (!response.ok) return;
      setNotifications((items) => items.map((item) => item.id === id ? { ...item, is_read: true } : item));
      setUnreadCount((count) => Math.max(0, count - 1));
    } catch (_error) { /* keep the item unread when the request fails */ }
    finally { readBusyRef.current.delete(id); }
  }
  async function markAllRead() {
    if (!unreadCount || markAllBusyRef.current) return;
    markAllBusyRef.current = true;
    try {
      const response = await fetch(`${API_BASE_URL}/admin/notifications/read-all`, { method: "POST", headers: { Authorization: `Bearer ${session.token}` } });
      if (!response.ok) return;
      setNotifications((items) => items.map((item) => ({ ...item, is_read: true })));
      setUnreadCount(0);
    } catch (_error) { /* keep unread state when the request fails */ }
    finally { markAllBusyRef.current = false; }
  }
  const badge = unreadCount > 99 ? "99+" : String(unreadCount);
  return <div className="admin-header-tool notification-center" ref={containerRef}>
    <button className={`admin-tool-button ${open ? "active" : ""}`} type="button" aria-label={t("dashboard.notificationCenter")} title={t("dashboard.notificationCenter")} aria-expanded={open} onClick={() => setOpen((value) => !value)}>🔔{unreadCount > 0 ? <span className="header-unread-badge" aria-label={badge}>{badge}</span> : null}</button>
    {open ? <div className="header-popover notification-popover" role="dialog" aria-label={t("dashboard.notifications")}><div className="notification-popover-heading"><strong>{t("dashboard.notifications")}</strong><button type="button" onClick={markAllRead} disabled={!unreadCount}>{t("dashboard.markAllRead")}</button></div>{loading && !notifications.length ? <p className="header-popover-state">{t("dashboard.loading")}</p> : error ? <p className="header-popover-state form-error">{error}</p> : notifications.length ? <div className="notification-list">{notifications.map((notification) => <button type="button" className={`notification-item ${notification.is_read ? "" : "unread"}`} key={notification.id} onClick={() => { if (!notification.is_read) void markRead(notification.id); setOpen(false); onSelect(notification); }}><span className={`notification-icon notification-icon-${notification.type}`}>{notification.type === "new_message" ? "✉" : notification.type === "payment_overdue" ? "₤" : "!"}</span><span><strong>{notificationTitle(notification.type, t)}</strong><small>{notificationDescription(notification, t, language)}</small><time>{new Intl.DateTimeFormat(language === "ar" ? "ar-EG" : "en-US", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Africa/Cairo" }).format(new Date(notification.created_at))}</time></span></button>)}</div> : <p className="header-popover-state">{t("dashboard.noNotifications")}</p>}<button className="notification-view-all" type="button" onClick={() => { setExpanded(true); void load(20); }}>{t("dashboard.viewAllNotifications")} <span>←</span></button></div> : null}
  </div>;
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
  const can = (permission: PermissionKey) => sessionHasPermission(session, permission);
  const dashboardTranslator = useMemo(
    () => (key: string, values?: Record<string, string>) => t(key as TranslationKey, values),
    [t]
  );
  const [inboxUnread, setInboxUnread] = useState(0);
  const previousInboxUnread = useRef(0);
  const [inboxBadgeAnimationKey, setInboxBadgeAnimationKey] = useState(0);
  useEffect(() => {
    if (inboxUnread > previousInboxUnread.current && inboxUnread > 0) {
      setInboxBadgeAnimationKey((current) => current + 1);
    }
    previousInboxUnread.current = inboxUnread;
  }, [inboxUnread]);
  useEffect(() => {
    fetch(`${API_BASE_URL}/admin/inbox/unread-count`, { headers: { Authorization: `Bearer ${session.token}` } })
      .then((response) => response.json())
      .then((payload) => setInboxUnread(Number(payload.count || 0)))
      .catch(() => undefined);
  }, [session.token]);
  const adminTabs = ([
    { id: "overview", label: t("admin.tabs.overview") },
    { id: "add-user", label: t("admin.tabs.addUser"), permission: "users.create" },
    { id: "users", label: t("admin.tabs.users"), permission: "users.view" },
    { id: "site-content", label: t("admin.tabs.siteContent"), permission: "settings.manage" },
    { id: "audit-logs", label: t("admin.tabs.auditLogs"), permission: "activity_log.view" },
    { id: "students", label: t("admin.tabs.students"), permission: "students.view" },
    { id: "groups", label: t("admin.tabs.groups"), permission: "schedule.view" },
    { id: "attendance", label: t("admin.tabs.attendance"), permission: "attendance.view" },
    { id: "scanner", label: t("admin.tabs.scanner"), permission: "attendance.manage" },
    { id: "fees", label: t("admin.tabs.fees"), permission: "payments.view" },
    { id: "exams", label: t("admin.tabs.exams"), permission: "exams.view" },
    { id: "inbox", label: t("admin.tabs.inbox"), permission: "messages.view" },
    { id: "settings", label: t("admin.tabs.settings"), permission: "settings.manage" }
  ] satisfies Array<{ id: AdminTab; label: string; permission?: PermissionKey }>).filter((tab) => (!tab.permission || can(tab.permission)) && (tab.id !== "overview" || can("dashboard.view")));
  const primaryAdminTabs = adminTabs.filter((tab) => ["overview", "students", "groups", "attendance", "scanner", "fees", "exams", "inbox"].includes(tab.id));
  const gearOrder: AdminTab[] = ["users", "add-user", "site-content", "audit-logs", "settings"];
  const gearAdminTabs = gearOrder.map((id) => adminTabs.find((tab) => tab.id === id)).filter((tab): tab is (typeof adminTabs)[number] => Boolean(tab));
  const [gearOpen, setGearOpen] = useState(false);
  const gearRef = useRef<HTMLDivElement | null>(null);
  const gearButtonRef = useRef<HTMLButtonElement | null>(null);
  const gearMenuRef = useRef<HTMLDivElement | null>(null);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<AdminTab>(() => {
    const requestedTab = adminTabFromLocation();
    return adminTabs.some((tab) => tab.id === requestedTab) ? requestedTab : (adminTabs[0]?.id || "overview");
  });
  const mobilePrimaryTabs = mobilePrimaryAdminTabIds
    .map((id) => adminTabs.find((tab) => tab.id === id))
    .filter((tab): tab is (typeof adminTabs)[number] => Boolean(tab));
  const mobileMoreTabs = adminTabs.filter((tab) => !mobilePrimaryAdminTabIds.includes(tab.id));

  const placeholderTitles: Partial<Record<AdminTab, string>> = {
    attendance: t("admin.tabs.attendance"),
    exams: t("admin.tabs.exams")
  };

  useEffect(() => {
    if (!adminTabs.some((tab) => tab.id === activeTab)) {
      const fallbackTab = adminTabs[0]?.id || "overview";
      setActiveTab(fallbackTab);
      persistAdminTab(fallbackTab);
    }
  }, [activeTab, adminTabs]);

  useEffect(() => {
    persistAdminTab(activeTab);
  }, [activeTab]);

  useEffect(() => {
    if (!gearOpen) return undefined;
    function closeOnOutside(event: MouseEvent) {
      if (!gearRef.current?.contains(event.target as Node)) setGearOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setGearOpen(false);
        gearButtonRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", closeOnOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [gearOpen]);

  useEffect(() => {
    if (!mobileMoreOpen) return undefined;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setMobileMoreOpen(false);
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [mobileMoreOpen]);

  function navigateAdmin(tab: AdminTab, studentId?: number, section?: string) {
    if (!adminTabs.some((item) => item.id === tab)) return;
    setActiveTab(tab);
    const params = new URLSearchParams(window.location.search);
    if (tab === "overview") params.delete("tab"); else params.set("tab", tab);
    if (studentId) params.set("studentId", String(studentId)); else params.delete("studentId");
    if (section) params.set("section", section); else params.delete("section");
    const query = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
    window.dispatchEvent(new Event("admin-location-change"));
  }

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
          <span className="admin-brand-copy-desktop">
            <strong>{t("teacher.dashboardTitle")}</strong>
            <small>{t("site.name")}</small>
          </span>
          <span className="admin-brand-copy-mobile">
            <strong>{session.teacher.name}</strong>
            <small>{t("teacher.dashboardTitle")}</small>
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
            className="admin-nav admin-desktop-nav"
            aria-label={language === "ar" ? "تنقل لوحة الإدارة" : "Admin navigation"}
            style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "6px" }}
          >
            {primaryAdminTabs.map((tab) => {
              const isInboxTab = tab.id === "inbox";
              const inboxBadgeText = inboxUnread >= 100 ? "99+" : String(inboxUnread);
              const inboxNavLabel = inboxUnread === 1
                ? t("admin.messagesUnreadOne")
                : t("admin.messagesUnreadMany", { count: String(inboxUnread) });
              return (
                <button
                  key={tab.id}
                  className={`${activeTab === tab.id ? "active" : ""} ${isInboxTab ? "messages-nav-item" : ""}`}
                  type="button"
                  aria-label={isInboxTab && inboxUnread > 0 ? inboxNavLabel : tab.label}
                  onClick={() => setActiveTab(tab.id)}
                >
                  {tab.label}
                  {isInboxTab && inboxUnread > 0 ? <span key={inboxBadgeAnimationKey} className="nav-unread-badge" aria-hidden="true">{inboxBadgeText}</span> : null}
                </button>
              );
            })}
          </nav>
          <div className="admin-header-tools">
            {can("students.view") ? <GlobalSearch session={session} language={language} t={t} onSelect={(studentId) => navigateAdmin("students", studentId)} /> : null}
            {can("dashboard.alerts.view") || can("messages.view") ? <NotificationCenter session={session} language={language} t={t} onSelect={(notification) => {
              if (notification.entity_type === "student" && notification.entity_id && adminTabs.some((item) => item.id === "students")) navigateAdmin("students", Number(notification.entity_id), notification.target_section || undefined);
              else if (can("messages.view")) navigateAdmin("inbox");
            }} /> : null}
          </div>
          {gearAdminTabs.length ? <div className="admin-gear-menu admin-desktop-admin-actions" ref={gearRef}>
            <button
              ref={gearButtonRef}
              className={`admin-gear-button ${gearOpen ? "active" : ""}`}
              type="button"
              aria-label={language === "ar" ? "الإدارة والإعدادات" : "Administration and settings"}
              title={language === "ar" ? "الإدارة والإعدادات" : "Administration and settings"}
              aria-haspopup="menu"
              aria-expanded={gearOpen}
              onClick={() => setGearOpen((open) => !open)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" && !gearOpen) {
                  event.preventDefault();
                  setGearOpen(true);
                  window.setTimeout(() => gearMenuRef.current?.querySelector<HTMLButtonElement>("button")?.focus(), 0);
                }
              }}
            >⚙<span className="visually-hidden">{language === "ar" ? "الإدارة والإعدادات" : "Administration and settings"}</span></button>
            {gearOpen ? <div className="gear-dropdown" role="menu" ref={gearMenuRef}>
              {gearAdminTabs.map((tab, index) => <span key={tab.id} className={tab.id === "settings" ? "gear-menu-settings" : ""}>
                {tab.id === "settings" ? <span className="gear-divider" role="separator" /> : null}
                <button type="button" role="menuitem" onClick={() => { navigateAdmin(tab.id); setGearOpen(false); }} onKeyDown={(event) => {
                  if (event.key === "Escape") { event.preventDefault(); setGearOpen(false); gearButtonRef.current?.focus(); return; }
                  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
                  event.preventDefault();
                  const items = Array.from(gearMenuRef.current?.querySelectorAll<HTMLButtonElement>("button[role='menuitem']") || []);
                  if (!items.length) return;
                  const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
                  items[nextIndex]?.focus();
                }}><span aria-hidden="true">{tab.id === "users" ? "♙" : tab.id === "add-user" ? "+" : tab.id === "site-content" ? "▤" : tab.id === "audit-logs" ? "◷" : "⚙"}</span>{tab.label}</button>
              </span>)}
            </div> : null}
            <button className="admin-logout-tab" type="button" onClick={onLogout} style={{ flexShrink: 0 }}>{t("teacher.logout")}</button>
          </div> : null}
          <nav
            className="admin-nav admin-mobile-nav"
            aria-label={language === "ar" ? "تنقل لوحة الإدارة" : "Admin navigation"}
            style={{ display: "none", alignItems: "center", flexWrap: "wrap", gap: "6px" }}
          >
            {adminTabs.map((tab) => {
              const isInboxTab = tab.id === "inbox";
              const inboxBadgeText = inboxUnread >= 100 ? "99+" : String(inboxUnread);
              const inboxNavLabel = inboxUnread === 1
                ? t("admin.messagesUnreadOne")
                : t("admin.messagesUnreadMany", { count: String(inboxUnread) });
              return (
                <button
                  key={tab.id}
                  className={`${activeTab === tab.id ? "active" : ""} ${isInboxTab ? "messages-nav-item" : ""}`}
                  type="button"
                  aria-label={isInboxTab && inboxUnread > 0 ? inboxNavLabel : tab.label}
                  onClick={() => setActiveTab(tab.id)}
                >
                  {tab.label}
                  {isInboxTab && inboxUnread > 0 ? <span key={inboxBadgeAnimationKey} className="nav-unread-badge" aria-hidden="true">{inboxBadgeText}</span> : null}
                </button>
              );
            })}
            <button className="admin-logout-tab" type="button" onClick={onLogout} style={{ flexShrink: 0 }}>
              {t("teacher.logout")}
            </button>
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
        </div>
      </header>
      <main className={`dashboard admin-dashboard ${activeTab === "inbox" ? "admin-dashboard-inbox" : ""}`}>
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

        <section className="admin-tab-panel">
          <AnimatedTabPanel key={activeTab}>
            {!adminTabs.length ? (
              <div className="admin-editor forbidden-panel">
                <p className="eyebrow">403</p>
                <h2>{t("dashboard.accessDenied")}</h2>
              </div>
            ) : null}
            {activeTab === "overview" && can("dashboard.view") ? <AdminExecutiveDashboard token={session.token} language={language} t={dashboardTranslator} can={(permission) => can(permission as PermissionKey)} onNavigate={(tab, studentId, section) => navigateAdmin(tab as AdminTab, studentId, section)} /> : null}
            {activeTab === "add-user" && can("users.create") ? <UsersTeamManager mode="create" session={session} t={t} /> : null}
            {activeTab === "users" && can("users.view") ? <UsersTeamManager mode="list" session={session} t={t} /> : null}
            {activeTab === "site-content" && can("settings.manage") ? <SiteContentEditor session={session} language={language} t={t} /> : null}
            {activeTab === "audit-logs" && can("activity_log.view") ? <AuditLogsPanel session={session} language={language} t={t} /> : null}
            {activeTab === "settings" && can("settings.manage") ? <SystemSettingsPanel token={session.token} language={language} t={(key, values) => t(key as TranslationKey, values)} /> : null}
            {activeTab === "groups" && can("schedule.view") ? <AcademicManager kind="groups" session={session} t={t} /> : null}
            {activeTab === "students" && can("students.view") ? <AcademicManager kind="students" session={session} t={t} /> : null}
            {activeTab === "scanner" && can("attendance.manage") ? <ScannerPanel session={session} t={t} /> : null}
          {activeTab === "fees" && can("payments.view") ? <><FeesPanel session={session} t={t} />{can("payments.reports.view") ? <><PaymentReportsPanel session={session} t={t} canReverse={can("payments.reverse")} /><LatePaymentsReportPanel session={session} t={t} /></> : null}</> : null}
            {activeTab === "attendance" && can("attendance.view") ? <AttendancePanel session={session} language={language} t={t} /> : null}
            {activeTab === "exams" && can("exams.view") ? <ExamResultsManager session={session} t={t} /> : null}
            {activeTab === "inbox" && can("messages.view") ? <StaffInboxControls session={session} language={language} t={t} onUnreadCountChange={setInboxUnread} /> : null}
            {activeTab !== "overview" && activeTab !== "attendance" && activeTab !== "exams" && activeTab !== "settings" && placeholderTitles[activeTab] ? (
              <div className="admin-editor placeholder-panel">
                <p className="eyebrow">V1</p>
                <h2>{placeholderTitles[activeTab]}</h2>
                <p>{t("teacher.dashboardSubtitle")}</p>
              </div>
            ) : null}
          </AnimatedTabPanel>
        </section>
      </main>
      <footer className="site-footer" dir="ltr" lang="en">
        © 2026 Mr. Ahmed Abdrabo · Designed &amp; Developed by Eng. Hany Hosny
      </footer>
      <nav className="mobile-bottom-nav" aria-label={t("admin.mobileNavigation")}>
        {mobilePrimaryTabs.map((tab) => (
          <button
            key={tab.id}
            className={activeTab === tab.id ? "active" : ""}
            type="button"
            aria-current={activeTab === tab.id ? "page" : undefined}
            onClick={() => { navigateAdmin(tab.id); setMobileMoreOpen(false); }}
          >
            <span className="mobile-bottom-nav-icon" aria-hidden="true">{adminTabIcons[tab.id] || "•"}</span>
            <span>{tab.label}</span>
          </button>
        ))}
        <button
          className={mobileMoreOpen || !mobilePrimaryAdminTabIds.includes(activeTab) ? "active" : ""}
          type="button"
          aria-expanded={mobileMoreOpen}
          onClick={() => setMobileMoreOpen((open) => !open)}
        >
          <span className="mobile-bottom-nav-icon" aria-hidden="true">⋯</span>
          <span>{t("admin.mobileMore")}</span>
        </button>
      </nav>
      {mobileMoreOpen ? (
        <div className="mobile-more-backdrop" role="presentation" onClick={() => setMobileMoreOpen(false)}>
          <section
            className="mobile-more-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-more-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mobile-more-heading">
              <div>
                <span className="panel-kicker">{t("admin.mobileMore")}</span>
                <h2 id="mobile-more-title">{t("admin.mobileMore")}</h2>
              </div>
              <button className="mobile-more-close" type="button" aria-label={t("admin.mobileCloseMore")} onClick={() => setMobileMoreOpen(false)}>×</button>
            </div>
            <div className="mobile-more-account">
              <img className="mobile-more-avatar" src="/assets/teacher-profile.png" alt="" aria-hidden="true" />
              <span><strong>{session.teacher.name}</strong><small>{session.teacher.email}</small></span>
              <span className={`role-badge role-${session.teacher.role}`}>{roleLabel(session.teacher.role, t)}</span>
            </div>
            <div className="mobile-more-links">
              {mobileMoreTabs.map((tab) => (
                <button key={tab.id} className={activeTab === tab.id ? "active" : ""} type="button" onClick={() => { navigateAdmin(tab.id); setMobileMoreOpen(false); }}>
                  <span className="mobile-more-link-icon" aria-hidden="true">{adminTabIcons[tab.id] || "•"}</span>
                  <span>{tab.label}</span>
                  <span className="mobile-more-link-arrow" aria-hidden="true">›</span>
                </button>
              ))}
            </div>
            <div className="mobile-more-language">
              <span>{t("admin.mobileLanguage")}</span>
              <div className="mobile-language-switcher" role="group" aria-label={t("admin.mobileLanguage")}>
                <button className={language === "ar" ? "active" : ""} type="button" onClick={() => setLanguage("ar")}>AR</button>
                <button className={language === "en" ? "active" : ""} type="button" onClick={() => setLanguage("en")}>EN</button>
              </div>
            </div>
            <button className="mobile-more-logout" type="button" onClick={onLogout}>{t("teacher.logout")}</button>
          </section>
        </div>
      ) : null}
    </div>
  );
}

const emptyUserForm = {
  name: "",
  username: "",
  email: "",
  password: "",
  role: "staff" as AdminUser["role"],
  is_active: true,
  print_student_labels: false,
  max_label_reprints: 2,
  can_use_inbox: false,
  permissions: [] as PermissionKey[],
  permissionPreset: "custom"
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
  const [saveState, setSaveState] = useState<ActionButtonState>("idle");
  const [saveMode, setSaveMode] = useState<"create" | "update">("create");
  const saveTimer = useRef<number | null>(null);
  const resetPasswordFeedback = useActionFeedback();
  const [userActionStates, setUserActionStates] = useState<Record<string, ActionButtonState>>({});
  const userActionTimers = useRef<Record<string, number>>({});
  const [userRowNotice, setUserRowNotice] = useState<{ userId: number; message: string } | null>(null);
  const userRowNoticeTimer = useRef<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<RecordStatusFilter>("active");
  const [transferTarget, setTransferTarget] = useState<AdminUser | null>(null);
  const [transferPassword, setTransferPassword] = useState("");
  const editorFormRef = useRef<HTMLFormElement>(null);
  const isOwner = session.teacher.role === "owner";

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

  useEffect(() => () => {
    Object.values(userActionTimers.current).forEach((timer) => window.clearTimeout(timer));
    if (userRowNoticeTimer.current !== null) window.clearTimeout(userRowNoticeTimer.current);
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
  }, []);

  function userActionState(key: string): ActionButtonState {
    return userActionStates[key] || "idle";
  }

  async function runUserAction(key: string, action: () => Promise<void>) {
    if (userActionState(key) !== "idle") return;
    setStatus("");
    setUserActionStates((current) => ({ ...current, [key]: "loading" }));
    try {
      await action();
      setUserActionStates((current) => ({ ...current, [key]: "success" }));
      userActionTimers.current[key] = window.setTimeout(() => {
        setUserActionStates((current) => ({ ...current, [key]: "idle" }));
        loadUsers().catch(() => setStatus(t("errors.loginFailed")));
      }, 1800);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("errors.loginFailed"));
      setUserActionStates((current) => ({ ...current, [key]: "error" }));
      userActionTimers.current[key] = window.setTimeout(() => setUserActionStates((current) => ({ ...current, [key]: "idle" })), 1800);
    }
  }

  function showUserRowNotice(userId: number, message: string) {
    if (userRowNoticeTimer.current !== null) window.clearTimeout(userRowNoticeTimer.current);
    setUserRowNotice({ userId, message });
    userRowNoticeTimer.current = window.setTimeout(() => setUserRowNotice(null), 1800);
  }

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
      can_use_inbox: user.can_use_inbox ?? false,
      permissions: editorPermissions(user.permissions || []),
      permissionPreset: "custom"
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

  function applyPermissionPreset(presetKey: string) {
    const preset = permissionPresets.find((item) => item.key === presetKey);
    if (!preset || preset.key === "custom") {
      setForm((value) => ({ ...value, permissionPreset: "custom" }));
      return;
    }
    const available = isOwner ? preset.permissions : preset.permissions.filter((permission) => sessionHasPermission(session, permission));
    setForm((value) => ({ ...value, permissions: available, permissionPreset: preset.key }));
  }

  function togglePermission(permission: PermissionKey) {
    if (!isOwner && !sessionHasPermission(session, permission)) return;
    setForm((value) => ({
      ...value,
      permissionPreset: "custom",
      permissions: value.permissions.includes(permission)
        ? value.permissions.filter((item) => item !== permission)
        : [...value.permissions, permission]
    }));
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

    const savedUserId = editingId;
    setLoading(true);
    setSaveState("loading");
    setSaveMode(savedUserId ? "update" : "create");
    try {
      const response = await fetch(
        savedUserId ? `${API_BASE_URL}/admin/users/${savedUserId}` : `${API_BASE_URL}/admin/users`,
        {
          method: savedUserId ? "PUT" : "POST",
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
      if (savedUserId) {
        setStatus("");
        showUserRowNotice(savedUserId, t("admin.userSaved"));
      } else {
        setStatus(t("admin.userSaved"));
      }
      setSaveState("success");
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => setSaveState("idle"), 1800);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("errors.loginFailed"));
      setSaveState("idle");
    } finally {
      setLoading(false);
    }
  }

  async function updateStatus(user: AdminUser, isActive: boolean) {
    setLoading(true);
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
    } catch (error) {
      throw error;
    } finally {
      setLoading(false);
    }
  }

  async function deleteUser(user: AdminUser) {
    if (user.id === session.teacher.id) { setStatus("لا يمكنك حذف حسابك الحالي / You cannot delete yourself"); return; }
    if (!window.confirm("هل أنت متأكد من حذف هذا المستخدم؟ / Are you sure you want to delete this user?")) return;
    await runUserAction(`delete:${user.id}`, async () => {
      setLoading(true);
      try {
        const response = await fetch(`${API_BASE_URL}/admin/users/${user.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${session.token}` } });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.status === "self_delete_forbidden" ? "لا يمكنك حذف حسابك الحالي / You cannot delete yourself" : t("errors.loginFailed"));
      } finally {
        setLoading(false);
      }
    });
  }

  async function restoreUser(user: AdminUser) {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/admin/users/${user.id}/restore`, { method: "PATCH", headers: { Authorization: `Bearer ${session.token}` } });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(adminApiErrorMessage(data.status, t));
    } finally {
      setLoading(false);
    }
  }

  async function permanentlyDeleteUser(user: AdminUser) {
    if (!window.confirm(t("admin.permanentDeleteUserConfirm"))) return;
    await runUserAction(`permanent-delete:${user.id}`, async () => {
      setLoading(true);
      try {
        const response = await fetch(`${API_BASE_URL}/admin/users/${user.id}/permanent`, { method: "DELETE", headers: { Authorization: `Bearer ${session.token}` } });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(adminApiErrorMessage(data.status, t));
      } finally {
        setLoading(false);
      }
    });
  }

  async function submitPasswordReset(userId: number) {
    setStatus("");
    if (resetPassword.length < 8) {
      setStatus(t("errors.passwordLength"));
      return;
    }

    setLoading(true);
    try {
      await resetPasswordFeedback.run(async () => {
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
        setResetPassword("");
        setStatus("");
        showUserRowNotice(userId, t("admin.passwordReset"));
      });
      window.setTimeout(() => setResetPasswordId(null), 1800);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("errors.loginFailed"));
    } finally {
      setLoading(false);
    }
  }

  async function transferOwnership() {
    if (!transferTarget || !transferPassword) return;
    setLoading(true);
    setStatus("");
    try {
      const response = await fetch(`${API_BASE_URL}/admin/users/transfer-ownership`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ target_user_id: transferTarget.id, current_password: transferPassword })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(adminApiErrorMessage(data.status, t));
      setTransferTarget(null);
      setTransferPassword("");
      setStatus(t("admin.ownershipTransferred"));
      await loadUsers();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("errors.loginFailed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="admin-editor users-manager">
      <div className="section-heading users-manager-heading">
        <p className="eyebrow">{t("admin.usersTeam")}</p>
        <h2>{mode === "create" ? t("admin.createUser") : editingId ? t("admin.editUser") : t("admin.usersTeam")}</h2>
      </div>

      {mode === "create" || editingId ? (
      <form ref={editorFormRef} className="users-form-card" onSubmit={saveUser} aria-labelledby="users-form-title">
        <div className="users-form-header">
          <div>
            <p className="eyebrow">{t("admin.userDetails")}</p>
            <h3 id="users-form-title">{editingId ? t("admin.editUser") : t("admin.createUser")}</h3>
          </div>
          <span className="form-mode-badge">{editingId ? t("admin.update") : t("admin.create")}</span>
        </div>

        <div className="user-identity-section">
          <div className="subsection-heading">
            <span>{t("admin.userDetails")}</span>
            <small>{t("admin.usersTeam")}</small>
          </div>
          <div className="user-identity-grid">
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
                onChange={(event) => setForm({ ...form, role: event.target.value as AdminUser["role"], permissions: event.target.value === "staff" ? permissionPresets.find((item) => item.key === "students")?.permissions || [] : form.permissions })}
                disabled={Boolean(editingId && users.find((user) => user.id === editingId)?.is_owner)}
              >
                <option value="staff">{t("admin.role.staff")}</option>
                <option value="admin">{t("admin.role.admin")}</option>
              </select>
            </label>
            {!editingId ? (
              <label>
                {t("admin.password")}
                <input type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
              </label>
            ) : null}
          </div>
        </div>

        <section className="user-settings-section" aria-labelledby="user-settings-title">
          <div className="subsection-heading">
            <div>
              <span>{t("admin.userSettings")}</span>
              <small>{t("admin.permissions")}</small>
            </div>
            <h3 id="user-settings-title">{t("admin.userSettings")}</h3>
          </div>
          <div className="user-settings-grid">
            <label className="checkbox-label setting-toggle">
              <input
                type="checkbox"
                checked={form.is_active}
                disabled={editingId === session.teacher.id}
                onChange={(event) => setForm({ ...form, is_active: event.target.checked })}
              />
              <span>{t("admin.active")}</span>
            </label>
            <label className="checkbox-label setting-toggle">
              <input type="checkbox" checked={form.print_student_labels} onChange={(event) => setForm({ ...form, print_student_labels: event.target.checked })} />
              <span>{t("admin.printLabels")}</span>
            </label>
            <label className="checkbox-label setting-toggle">
              <input type="checkbox" checked={form.can_use_inbox} onChange={(event) => setForm({ ...form, can_use_inbox: event.target.checked })} />
              <span>{t("inbox.permission")}</span>
            </label>
            <label className="number-field">
              {t("admin.maxReprints")}
              <input type="number" min="0" value={form.max_label_reprints} onChange={(event) => setForm({ ...form, max_label_reprints: Number(event.target.value) })} />
            </label>
          </div>

          {form.role === "admin" || form.role === "staff" ? (
            <section className="permissions-editor" aria-labelledby="user-permissions-title">
              <div className="section-heading">
                <p className="eyebrow">{t("admin.permissions")}</p>
                <h3 id="user-permissions-title">{t("admin.permissions")}</h3>
              </div>
              <label className="permissions-preset-field">
                {t("admin.permissionPreset")}
                <select value={form.permissionPreset} onChange={(event) => applyPermissionPreset(event.target.value)}>
                  {permissionPresets.map((preset) => <option key={preset.key} value={preset.key}>{t(preset.label)}</option>)}
                </select>
              </label>
              <div className="permission-groups">
                {permissionGroups.map((group) => (
                  <fieldset key={group.label} className="permission-group">
                    <legend>{t(group.label)}</legend>
                    {group.permissions.map(({ key, label }) => {
                      const allowedToGrant = isOwner || sessionHasPermission(session, key);
                      const dashboardChild = key.startsWith("dashboard.") && key !== "dashboard.view";
                      const dashboardGatewayMissing = dashboardChild && !form.permissions.includes("dashboard.view");
                      const paymentChild = ["payments.collect", "payments.advance", "payments.reports.view", "payments.reverse"].includes(key);
                      const paymentGatewayMissing = paymentChild && !form.permissions.includes("payments.view");
                      return (
                        <label key={key} className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={form.permissions.includes(key)}
                            disabled={!allowedToGrant || ((dashboardGatewayMissing || paymentGatewayMissing) && !form.permissions.includes(key)) || (editingId !== null && users.find((user) => user.id === editingId)?.is_owner === true)}
                            onChange={() => togglePermission(key)}
                          />
                          {t(label)}
                        </label>
                      );
                    })}
                  </fieldset>
                ))}
              </div>
              {!isOwner ? <p className="form-hint">{t("admin.permissionGrantForbidden")}</p> : null}
            </section>
          ) : null}
        </section>

        <div className="form-actions user-form-actions">
          <button className={`primary-button editor-save user-form-primary action-feedback-${saveState} ${saveState === "success" ? "success-button" : ""}`} type="submit" disabled={loading || saveState === "loading"}>
            {actionButtonText(saveState, {
              idle: editingId ? t("admin.update") : t("admin.create"),
              loading: editingId ? t("admin.updating") : t("admin.creating"),
              success: t(saveMode === "update" ? "admin.updated" : "admin.created"),
              error: t("admin.actionFailedSave")
            })}
          </button>
          {editingId ? (
            <button className="secondary-button compact-button user-form-secondary" type="button" onClick={resetForm}>
              {t("admin.cancel")}
            </button>
          ) : null}
        </div>
      </form>
      ) : null}

      {mode === "list" ? (
      <div className="users-list">
        <div className="users-list-toolbar">
          <div className="users-list-heading">
            <p className="eyebrow">{t("admin.usersTeam")}</p>
            <h3>{t("admin.userList")} <span className="users-count">{users.length}</span></h3>
          </div>
          <div className="status-filter-buttons" role="tablist" aria-label={t("admin.status")}>
            {(["active","disabled","deleted","all"] as RecordStatusFilter[]).map((filter)=><button key={filter} className={statusFilter===filter?"active":""} type="button" role="tab" aria-selected={statusFilter === filter} onClick={()=>setStatusFilter(filter)}>{filter==="active"?"Active / النشط":filter==="disabled"?"Disabled / المعطل":filter==="deleted"?"Deleted / المحذوف":"All / الكل"}</button>)}
          </div>
        </div>
        <div className="users-list-items">
        {users.map((user) => {
          const isCurrentUser = user.id === session.teacher.id;
          const targetIsOwner = user.is_owner || user.role === "owner";
          const ownerLockedForActor = targetIsOwner && !isOwner;
          return (
            <article key={user.id} className={`user-row ${targetIsOwner ? "user-row-owner" : ""}`}>
              <div className="user-identity">
                <strong>{user.name}</strong>
                <span>
                  {user.username} · {user.email}
                </span>
              </div>
              <div className="user-badges">
                <span className={`role-badge role-${user.role}`}>{roleLabel(user.role, t)}</span>
                <span className={user.deleted_at ? "status-deleted" : user.is_active ? "status-active" : "status-disabled"}>{recordStatusLabel(user, t)}</span>
              </div>
              {targetIsOwner ? <p className="form-hint user-owner-notice">{t("admin.ownerProtected")}</p> : null}
              <div className="row-actions">
                {!user.deleted_at && !ownerLockedForActor ? <button className="secondary-button compact-button user-action user-action-primary" type="button" onClick={() => startEdit(user)}>
                  {t("admin.editUser")}
                </button> : null}
                {!user.deleted_at && !ownerLockedForActor ? <button className="secondary-button compact-button user-action user-action-secondary" type="button" onClick={() => setResetPasswordId(user.id)}>
                  {t("admin.resetPassword")}
                </button> : null}
                {!user.deleted_at && !isCurrentUser && !ownerLockedForActor ? (
                  <button
                    className={`secondary-button compact-button user-action ${user.is_active ? "user-action-warning" : "user-action-success"} action-feedback-${userActionState(`status:${user.id}`)}`}
                    type="button"
                    onClick={() => void runUserAction(`status:${user.id}`, () => updateStatus(user, !user.is_active))}
                    disabled={loading || userActionState(`status:${user.id}`) !== "idle"}
                  >
                    {actionButtonText(userActionState(`status:${user.id}`), {
                      idle: user.is_active ? t("admin.disable") : t("admin.enable"),
                      loading: user.is_active ? t("admin.disabling") : t("admin.enabling"),
                      success: user.is_active ? t("admin.disabledSuccessfully") : t("admin.enabledSuccessfully"),
                      error: t("admin.actionFailedSave")
                    })}
                  </button>
                ) : null}
                {user.deleted_at && !ownerLockedForActor ? <>
                  <button
                    className={`secondary-button compact-button user-action user-action-success restore-user-button action-feedback-${userActionState(`restore:${user.id}`)}`}
                    type="button"
                    onClick={() => void runUserAction(`restore:${user.id}`, () => restoreUser(user))}
                    disabled={loading || userActionState(`restore:${user.id}`) !== "idle" || userActionState(`permanent-delete:${user.id}`) !== "idle"}
                  >
                    {actionButtonText(userActionState(`restore:${user.id}`), {
                      idle: t("admin.restore"),
                      loading: t("admin.restoring"),
                      success: t("admin.restored"),
                      error: t("admin.actionFailedSave")
                    })}
                  </button>
                  <button
                    className={`secondary-button compact-button user-action danger-button action-feedback-${userActionState(`permanent-delete:${user.id}`)}`}
                    type="button"
                    onClick={() => void permanentlyDeleteUser(user)}
                    disabled={loading || userActionState(`permanent-delete:${user.id}`) !== "idle" || userActionState(`restore:${user.id}`) !== "idle"}
                  >
                    {actionButtonText(userActionState(`permanent-delete:${user.id}`), {
                      idle: t("admin.permanentDelete"),
                      loading: t("admin.permanentlyDeleting"),
                      success: t("admin.permanentlyDeleted"),
                      error: t("admin.actionFailedDelete")
                    })}
                  </button>
                </> : !isCurrentUser && !ownerLockedForActor ? (
                  <button
                    className={`secondary-button compact-button user-action danger-button action-feedback-${userActionState(`delete:${user.id}`)}`}
                    type="button"
                    onClick={() => void deleteUser(user)}
                    disabled={loading || userActionState(`delete:${user.id}`) !== "idle"}
                  >
                    {actionButtonText(userActionState(`delete:${user.id}`), {
                      idle: t("admin.deleteUser"),
                      loading: t("admin.deleting"),
                      success: t("admin.deletedSuccessfully"),
                      error: t("admin.actionFailedDelete")
                    })}
                  </button>
                ) : null}
                {isOwner && !targetIsOwner && !user.deleted_at ? <button className="secondary-button compact-button user-action user-action-secondary" type="button" onClick={() => { setTransferTarget(user); setTransferPassword(""); setStatus(""); }} disabled={loading}>{t("admin.transferOwnership")}</button> : null}
              </div>
              {resetPasswordId === user.id ? (
                <div className="password-reset-row">
                  <input type="password" value={resetPassword} onChange={(event) => setResetPassword(event.target.value)} placeholder={t("admin.password")} />
                  <button
                    className="primary-button compact-button"
                    type="button"
                    onClick={() => submitPasswordReset(user.id)}
                    disabled={loading || resetPasswordFeedback.state !== "idle"}
                  >
                    {actionButtonText(resetPasswordFeedback.state, {
                      idle: t("admin.resetPassword"),
                      loading: t("admin.resettingPassword"),
                      success: t("admin.passwordReset"),
                      error: t("errors.loginFailed")
                    })}
                  </button>
                </div>
              ) : null}
            </article>
          );
        })}
        </div>
      </div>
      ) : null}

      {transferTarget ? (
        <div className="modal-backdrop" role="presentation">
          <section className="modal admin-editor" role="dialog" aria-modal="true" aria-labelledby="transfer-ownership-title">
            <div className="section-heading">
              <p className="eyebrow">{t("admin.transferOwnership")}</p>
              <h3 id="transfer-ownership-title">{transferTarget.name}</h3>
            </div>
            <p>{t("admin.transferOwnershipConfirm")}</p>
            <label>
              {t("admin.currentPassword")}
              <input type="password" autoFocus value={transferPassword} onChange={(event) => setTransferPassword(event.target.value)} />
            </label>
            <div className="form-actions">
              <button className="primary-button compact-button" type="button" onClick={transferOwnership} disabled={loading || !transferPassword}>{t("admin.transferOwnership")}</button>
              <button className="secondary-button compact-button" type="button" onClick={() => { setTransferTarget(null); setTransferPassword(""); }}>{t("admin.cancel")}</button>
            </div>
          </section>
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
  day_of_week: "",
  start_time: "",
  end_time: "",
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
  start_time: "08:00",
  end_time: "08:30",
  opens_before_minutes: "3",
  closes_after_minutes: "20",
  is_active: true
});

const scheduleDayOrder = [6, 0, 1, 2, 3, 4, 5];
const scheduleTimeOptions = [
  ...Array.from({ length: 32 }, (_, index) => {
    const minutes = 8 * 60 + index * 30;
    const hour = Math.floor(minutes / 60);
    const minute = minutes % 60;
    const value = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    return { value, label: value };
  }),
  { value: "00:00", label: "00:00" }
];

function scheduleTimeLabel(value: string, language: Language) {
  const [hour, minute] = value.split(":").map(Number);
  const date = new Date(2026, 0, 1, hour, minute);
  return new Intl.DateTimeFormat(language === "ar" ? "ar-EG" : "en-US", { hour: "numeric", minute: "2-digit", hour12: true }).format(date);
}

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

const emptyStudentForm: {
  full_name: string;
  student_code: string;
  scan_serial: string;
  phone: string;
  guardian_phone: string;
  gender: "male" | "female" | "unknown";
  national_id: string;
  group_id: string;
  is_active: boolean;
} = {
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

type StudentCardNotice = {
  type: "success" | "error";
  message: string;
};

type StudentRetention = {
  evaluations: boolean;
  financial: boolean;
  attendance: boolean;
  notes: boolean;
};

const defaultStudentRetention: StudentRetention = {
  evaluations: true,
  financial: true,
  attendance: true,
  notes: true
};

const studentRetentionFields: Array<{ key: keyof StudentRetention; label: TranslationKey }> = [
  { key: "evaluations", label: "admin.retentionEvaluations" },
  { key: "financial", label: "admin.retentionFinancial" },
  { key: "attendance", label: "admin.retentionAttendance" },
  { key: "notes", label: "admin.retentionNotes" }
];

function StudentRetentionOptions({ value, onChange, t }: { value: StudentRetention; onChange: (next: StudentRetention) => void; t: Translator }) {
  const allSelected = studentRetentionFields.every(({ key }) => value[key]);
  return <fieldset className="student-retention-options">
    <legend>{t("admin.retentionPrompt")}</legend>
    {studentRetentionFields.map(({ key, label }) => <label className="checkbox-label student-retention-option" key={key}>
      <input type="checkbox" checked={value[key]} onChange={(event) => onChange({ ...value, [key]: event.target.checked })} />
      <span>{t(label)}</span>
    </label>)}
    <label className="checkbox-label student-retention-option select-all-retention">
      <input type="checkbox" checked={allSelected} onChange={(event) => onChange(Object.fromEntries(studentRetentionFields.map(({ key }) => [key, event.target.checked])) as StudentRetention)} />
      <strong>{t("admin.retentionSelectAll")}</strong>
    </label>
  </fieldset>;
}

type StudentCardProps = {
  student: AdminStudent;
  t: Translator;
  selected: boolean;
  canManage: boolean;
  canDelete: boolean;
  notice?: StudentCardNotice;
  getActionState: (key: string) => ActionButtonState;
  onToggleSelect: (studentId: number) => void;
  onOpenProfile: (studentId: number) => void;
  onEdit: (student: AdminStudent) => void;
  onPrint: (student: AdminStudent) => void;
  onStatus: (student: AdminStudent) => void;
  onDelete: (student: AdminStudent) => void;
  onRestore: (student: AdminStudent) => void;
  onPermanentDelete: (student: AdminStudent) => void;
};

function StudentActionIcon({ name }: { name: "edit" | "printer" | "power" | "trash" | "restore" }) {
  const commonProps = { className: "student-card-action-icon", viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (name === "edit") return <svg {...commonProps}><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>;
  if (name === "printer") return <svg {...commonProps}><path d="M6 9V2h12v7" /><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" /><path d="M6 14h12v8H6z" /></svg>;
  if (name === "power") return <svg {...commonProps}><path d="M18.36 6.64a9 9 0 1 1-12.73 0" /><path d="M12 2v10" /></svg>;
  if (name === "restore") return <svg {...commonProps}><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v6h6" /></svg>;
  return <svg {...commonProps}><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 15H6L5 6" /><path d="M10 11v6M14 11v6" /></svg>;
}

function StudentCard({
  student,
  t,
  selected,
  canManage,
  canDelete,
  notice,
  getActionState,
  onToggleSelect,
  onOpenProfile,
  onEdit,
  onPrint,
  onStatus,
  onDelete,
  onRestore,
  onPermanentDelete
}: StudentCardProps) {
  const isDeleted = Boolean(student.deleted_at);
  const statusKey = `status:${student.id}`;
  const printKey = `print:${student.id}`;
  const deleteKey = `delete:${student.id}`;
  const restoreKey = `restore:${student.id}`;
  const permanentDeleteKey = `permanent-delete:${student.id}`;
  const statusState = getActionState(statusKey);
  const printState = getActionState(printKey);
  const deleteState = getActionState(deleteKey);
  const restoreState = getActionState(restoreKey);
  const permanentDeleteState = getActionState(permanentDeleteKey);
  const actionIsBusy = (state: ActionButtonState) => state !== "idle";
  const anyActionBusy = [statusState, printState, deleteState, restoreState, permanentDeleteState].some(actionIsBusy);
  const code = student.student_serial || student.student_code;
  const phone = student.phone || student.guardian_phone;

  function openProfile(event: React.MouseEvent<HTMLElement>) {
    const target = event.target as HTMLElement;
    if (target.closest("button, input, label, select, textarea, .student-card-actions")) return;
    onOpenProfile(student.id);
  }

  function openProfileWithKeyboard(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = event.target as HTMLElement;
    if (target !== event.currentTarget && target.closest("button, input, label, select, textarea, .student-card-actions")) return;
    event.preventDefault();
    onOpenProfile(student.id);
  }

  return (
    <article className={`student-card ${isDeleted ? "student-card-deleted" : ""}`} key={student.id} role="button" tabIndex={0} onClick={openProfile} onKeyDown={openProfileWithKeyboard} aria-label={`${t("admin.viewProfile")}: ${student.full_name}`}>
      <label className="student-card-select" onClick={(event) => event.stopPropagation()}>
        <input type="checkbox" checked={selected} onChange={() => onToggleSelect(student.id)} aria-label={`${t("admin.selectStudentCheckbox")} ${student.full_name}`} />
        <span className="visually-hidden">{t("admin.selectStudentCheckbox")}</span>
      </label>

      <div className="student-card-content">
        <div className="student-card-heading">
          <strong>{student.full_name}</strong>
          <span className={`student-card-status ${isDeleted ? "status-deleted" : student.is_active ? "status-active" : "status-disabled"}`}>{recordStatusLabel(student, t)}</span>
        </div>
        <div className="student-card-meta" aria-label={t("admin.basicInfo")}>
          <span dir="ltr">{code || "—"}</span>
          <span>{student.group_name || "—"}</span>
          <span dir="ltr">{phone || "—"}</span>
        </div>
        {isDeleted && purgeDaysLeft(student.purge_after) !== null ? <small className="purge-countdown">{t("admin.purgeDaysLeft", { days: String(purgeDaysLeft(student.purge_after)) })}</small> : null}
        {notice ? <p className={`student-card-notice ${notice.type}`} role={notice.type === "error" ? "alert" : "status"}>{notice.message}</p> : null}
      </div>

      <div className="student-card-actions" onClick={(event) => event.stopPropagation()}>
        {isDeleted ? <>
          {canManage ? <button className={`secondary-button compact-button student-card-action restore-student-action action-feedback-${restoreState}`} type="button" disabled={!student.purge_after || anyActionBusy} onClick={() => onRestore(student)}>
            <StudentActionIcon name="restore" />{actionButtonText(restoreState, { idle: t("admin.restore"), loading: t("admin.restoring"), success: t("admin.restored"), error: t("admin.actionFailedSave") })}
          </button> : null}
          {canDelete ? <button className={`danger-button compact-button student-card-action student-card-delete-action action-feedback-${permanentDeleteState}`} type="button" disabled={anyActionBusy} onClick={() => onPermanentDelete(student)}>
            <StudentActionIcon name="trash" />{actionButtonText(permanentDeleteState, { idle: t("admin.permanentDelete"), loading: t("admin.permanentlyDeleting"), success: t("admin.permanentlyDeleted"), error: t("admin.actionFailedDelete") })}
          </button> : null}
        </> : <>
          <div className="student-card-primary-actions">
            {canManage ? <button className="primary-button compact-button student-card-action student-card-edit-action" type="button" disabled={anyActionBusy} onClick={() => onEdit(student)}>
              <StudentActionIcon name="edit" />{t("admin.editUser")}
            </button> : null}
            {canManage && student.qr_token ? <button className={`secondary-button compact-button student-card-action action-feedback-${printState}`} type="button" disabled={anyActionBusy} onClick={() => onPrint(student)}>
              <StudentActionIcon name="printer" />{actionButtonText(printState, { idle: t("admin.printLabel"), loading: t("admin.printingLabel"), success: t("admin.labelReady"), error: t("admin.actionFailedSave") })}
            </button> : null}
            {canManage ? <button className={`secondary-button compact-button student-card-action student-card-status-action action-feedback-${statusState}`} type="button" disabled={anyActionBusy} onClick={() => onStatus(student)}>
              <StudentActionIcon name="power" />{actionButtonText(statusState, { idle: student.is_active ? t("admin.disable") : t("admin.enable"), loading: student.is_active ? t("admin.disabling") : t("admin.enabling"), success: student.is_active ? t("admin.disabledSuccessfully") : t("admin.enabledSuccessfully"), error: t("admin.actionFailedSave") })}
            </button> : null}
          </div>
          {canDelete ? <button className={`danger-button compact-button student-card-action student-card-delete-action action-feedback-${deleteState}`} type="button" disabled={anyActionBusy} onClick={() => onDelete(student)}>
            <StudentActionIcon name="trash" />{actionButtonText(deleteState, { idle: t("admin.deleteStudent"), loading: t("admin.studentDeleting"), success: t("admin.studentDeleted"), error: t("admin.actionFailedDelete") })}
          </button> : null}
        </>}
      </div>
    </article>
  );
}

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
  const [scheduleRows, setScheduleRows] = useState<ScheduleDraft[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [saveState, setSaveState] = useState<ActionButtonState>("idle");
  const [saveMode, setSaveMode] = useState<"create" | "update">("create");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [showStudents, setShowStudents] = useState(false);
  const [statusFilter, setStatusFilter] = useState<RecordStatusFilter>("active");
  const [groupDetails, setGroupDetails] = useState<any>(null);
  const [detailFilter, setDetailFilter] = useState<RecordStatusFilter>("all");
  const [studentSearch, setStudentSearch] = useState("");
  const [studentGroupId, setStudentGroupId] = useState("");
  const [selectedStudentIds, setSelectedStudentIds] = useState<number[]>([]);
  const [bulkDeleteConfirmOpen, setBulkDeleteConfirmOpen] = useState(false);
  const [permanentBulkDeleteConfirmOpen, setPermanentBulkDeleteConfirmOpen] = useState(false);
  const [permanentBulkDeletePhrase, setPermanentBulkDeletePhrase] = useState("");
  const [permanentBulkDeleteRetention, setPermanentBulkDeleteRetention] = useState<StudentRetention>({ ...defaultStudentRetention });
  const [permanentDeleteTarget, setPermanentDeleteTarget] = useState<AdminStudent | null>(null);
  const [permanentDeleteRetention, setPermanentDeleteRetention] = useState<StudentRetention>({ ...defaultStudentRetention });
  const [groupDeletePinTarget, setGroupDeletePinTarget] = useState<AdminGroup | null>(null);
  const [groupDeletePin, setGroupDeletePin] = useState("");
  const bulkDeleteFeedback = useActionFeedback();
  const permanentBulkDeleteFeedback = useActionFeedback();
  const [studentActionStates, setStudentActionStates] = useState<Record<string, ActionButtonState>>({});
  const studentActionTimers = useRef<Record<string, number>>({});
  const [studentCardNotices, setStudentCardNotices] = useState<Record<number, StudentCardNotice | undefined>>({});
  const studentNoticeTimers = useRef<Record<number, number>>({});
  const [groupActionStates, setGroupActionStates] = useState<Record<string, ActionButtonState>>({});
  const [groupActionErrors, setGroupActionErrors] = useState<Record<string, string>>({});
  const groupActionTimers = useRef<Record<string, number>>({});
  const [profileStudentId, setProfileStudentId] = useState<number | null>(null);
  const [profileSection, setProfileSection] = useState<string | undefined>(() => new URLSearchParams(window.location.search).get("section") || undefined);
  const [profilePickerId, setProfilePickerId] = useState("");
  const [profileScanValue, setProfileScanValue] = useState("");
  const [profileScanStatus, setProfileScanStatus] = useState("");
  const [profileScanLoading, setProfileScanLoading] = useState(false);
  const profileScanRef = useRef<HTMLInputElement>(null);
  const profileScanBusyRef = useRef(false);
  const profileScanAbortRef = useRef<AbortController | null>(null);

  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` };
  function syncProfileFromLocation() {
    if (kind !== "students") return;
    const params = new URLSearchParams(window.location.search);
    const requestedStudentId = Number(params.get("studentId"));
    setProfileStudentId(Number.isInteger(requestedStudentId) && requestedStudentId > 0 ? requestedStudentId : null);
    setProfileSection(params.get("section") || undefined);
  }
  useEffect(() => {
    if (kind !== "students") return;
    syncProfileFromLocation();
    window.addEventListener("admin-location-change", syncProfileFromLocation);
    return () => window.removeEventListener("admin-location-change", syncProfileFromLocation);
  }, [kind]);
  useEffect(() => {
    if (kind !== "students") return;
    const timer = window.setTimeout(() => profileScanRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [kind]);
  useEffect(() => () => profileScanAbortRef.current?.abort(), []);

  function openStudentProfile(studentId: number, section?: string) {
    setProfileStudentId(studentId);
    setProfileSection(section);
    const params = new URLSearchParams(window.location.search);
    params.set("studentId", String(studentId));
    if (section) params.set("section", section); else params.delete("section");
    const query = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
  }

  function closeStudentProfile() {
    setProfileStudentId(null);
    setProfileSection(undefined);
    const params = new URLSearchParams(window.location.search);
    params.delete("studentId");
    params.delete("section");
    const query = params.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`);
  }

  async function loadData() {
    const groupResponse = await fetch(`${API_BASE_URL}/admin/groups`, { headers });
    const groupData = (await groupResponse.json()) as { ok: boolean; groups?: AdminGroup[]; centers?: Array<{ id: number; name: string }> };
    if (!groupResponse.ok || !groupData.ok) throw new Error(t("errors.loginFailed"));
    setGroups(groupData.groups || []);
    setCenters(groupData.centers || []);
    if (!groupForm.center_id && groupData.centers?.[0]) setGroupForm((value) => ({ ...value, center_id: String(groupData.centers![0].id) }));

    const params = new URLSearchParams({ status: statusFilter });
    if (studentSearch.trim()) params.set("q", studentSearch.trim());
    if (studentGroupId) params.set("group_id", studentGroupId);
    const studentResponse = await fetch(`${API_BASE_URL}/admin/students?${params.toString()}`, { headers });
    const studentData = (await studentResponse.json()) as { ok: boolean; students?: AdminStudent[] };
    if (!studentResponse.ok || !studentData.ok) throw new Error(t("errors.loginFailed"));
    setStudents(studentData.students || []);
  }

  useEffect(() => {
    loadData().catch((error) => setStatus(error instanceof Error ? error.message : t("errors.loginFailed")));
  }, [statusFilter, studentSearch, studentGroupId]);

  useEffect(() => {
    const visibleIds = new Set(students.map((student) => student.id));
    setSelectedStudentIds((current) => current.filter((id) => visibleIds.has(id)));
  }, [students]);

  useEffect(() => () => {
    Object.values(groupActionTimers.current).forEach((timer) => window.clearTimeout(timer));
    Object.values(studentActionTimers.current).forEach((timer) => window.clearTimeout(timer));
    Object.values(studentNoticeTimers.current).forEach((timer) => window.clearTimeout(timer));
  }, []);

  function groupActionState(key: string): ActionButtonState {
    return groupActionStates[key] || "idle";
  }

  function studentActionState(key: string): ActionButtonState {
    return studentActionStates[key] || "idle";
  }

  function showStudentNotice(studentId: number, notice: StudentCardNotice) {
    const existingTimer = studentNoticeTimers.current[studentId];
    if (existingTimer) window.clearTimeout(existingTimer);
    setStudentCardNotices((current) => ({ ...current, [studentId]: notice }));
    studentNoticeTimers.current[studentId] = window.setTimeout(() => {
      setStudentCardNotices((current) => ({ ...current, [studentId]: undefined }));
    }, 3000);
  }

  async function runStudentAction(key: string, studentId: number, action: () => Promise<void>, successMessage: string, refresh = false) {
    if (studentActionState(key) !== "idle") return;
    const existingTimer = studentActionTimers.current[key];
    if (existingTimer) window.clearTimeout(existingTimer);
    setStatus("");
    setStudentCardNotices((current) => ({ ...current, [studentId]: undefined }));
    setStudentActionStates((current) => ({ ...current, [key]: "loading" }));
    setLoading(true);
    try {
      await action();
      setStudentActionStates((current) => ({ ...current, [key]: "success" }));
      showStudentNotice(studentId, { type: "success", message: successMessage });
      studentActionTimers.current[key] = window.setTimeout(() => {
        setStudentActionStates((current) => ({ ...current, [key]: "idle" }));
        if (refresh) loadData().catch((error) => showStudentNotice(studentId, { type: "error", message: error instanceof Error ? error.message : t("errors.loginFailed") }));
      }, 1800);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : t("errors.loginFailed");
      setStudentActionStates((current) => ({ ...current, [key]: "error" }));
      showStudentNotice(studentId, { type: "error", message });
      studentActionTimers.current[key] = window.setTimeout(() => setStudentActionStates((current) => ({ ...current, [key]: "idle" })), 1800);
      return false;
    } finally {
      setLoading(false);
    }
  }

  async function runGroupAction(key: string, action: () => Promise<void>, refresh = false, onSuccess?: () => void) {
    if (groupActionState(key) !== "idle") return;
    setStatus("");
    setGroupActionErrors((current) => ({ ...current, [key]: "" }));
    setGroupActionStates((current) => ({ ...current, [key]: "loading" }));
    setLoading(true);
    try {
      await action();
      setGroupActionStates((current) => ({ ...current, [key]: "success" }));
      groupActionTimers.current[key] = window.setTimeout(() => {
        setGroupActionStates((current) => ({ ...current, [key]: "idle" }));
        if (refresh) loadData().catch((error) => setStatus(error instanceof Error ? error.message : t("errors.loginFailed")));
        onSuccess?.();
      }, 1800);
    } catch (error) {
      setGroupActionErrors((current) => ({ ...current, [key]: error instanceof Error ? error.message : t("errors.loginFailed") }));
      setGroupActionStates((current) => ({ ...current, [key]: "error" }));
      groupActionTimers.current[key] = window.setTimeout(() => {
        setGroupActionStates((current) => ({ ...current, [key]: "idle" }));
        setGroupActionErrors((current) => ({ ...current, [key]: "" }));
      }, 1800);
    } finally {
      setLoading(false);
    }
  }

  const allVisibleStudentsSelected = students.length > 0 && students.every((student) => selectedStudentIds.includes(student.id));

  function toggleAllVisibleStudents() {
    setSelectedStudentIds((current) => {
      const visibleIds = students.map((student) => student.id);
      if (visibleIds.length && visibleIds.every((id) => current.includes(id))) return current.filter((id) => !visibleIds.includes(id));
      return [...new Set([...current, ...visibleIds])];
    });
  }

  function toggleStudentSelection(studentId: number) {
    setSelectedStudentIds((current) => current.includes(studentId) ? current.filter((id) => id !== studentId) : [...current, studentId]);
  }

  function bulkDeleteStudents() {
    const count = selectedStudentIds.length;
    if (!count || !sessionHasPermission(session, "students.delete")) return;
    setBulkDeleteConfirmOpen(true);
  }

  function permanentBulkDeleteStudents() {
    const count = selectedStudentIds.length;
    if (!count || !sessionHasPermission(session, "students.delete")) return;
    setPermanentBulkDeletePhrase("");
    setPermanentBulkDeleteRetention({ ...defaultStudentRetention });
    setPermanentBulkDeleteConfirmOpen(true);
  }

  async function confirmBulkDeleteStudents() {
    const count = selectedStudentIds.length;
    if (!count) return;
    setBulkDeleteConfirmOpen(false);
    await bulkDeleteFeedback.run(async () => {
      const response = await fetch(`${API_BASE_URL}/admin/students/bulk-delete`, {
        method: "POST",
        headers,
        body: JSON.stringify({ studentIds: selectedStudentIds })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(adminApiErrorMessage(data.status, t));
      await loadData();
      window.setTimeout(() => setSelectedStudentIds([]), 1800);
    }).catch((error) => setStatus(error instanceof Error ? error.message : t("errors.loginFailed")));
  }

  async function confirmPermanentBulkDeleteStudents() {
    const count = selectedStudentIds.length;
    const confirmationPhrase = t("admin.permanentBulkDeletePhrase");
    if (!count || !sessionHasPermission(session, "students.delete") || permanentBulkDeletePhrase.trim() !== confirmationPhrase) return;
    const studentIds = [...selectedStudentIds];
    try {
      await permanentBulkDeleteFeedback.run(async () => {
        const response = await fetch(`${API_BASE_URL}/admin/students/bulk-permanent`, {
          method: "DELETE",
          headers,
          body: JSON.stringify({ studentIds, retain: permanentBulkDeleteRetention })
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(adminApiErrorMessage(data.status, t));
      });
      setSelectedStudentIds([]);
      setPermanentBulkDeletePhrase("");
      setPermanentBulkDeleteConfirmOpen(false);
      setStatus(t("admin.permanentBulkDeleteSuccess", { count: String(count) }));
      await loadData().catch((error) => setStatus(error instanceof Error ? error.message : t("errors.loginFailed")));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("errors.loginFailed"));
    }
  }

  function resetForm() {
    setEditingId(null);
    setStatus("");
    setFieldErrors({});
    setGroupForm({ ...emptyGroupForm, center_id: centers[0] ? String(centers[0].id) : "" });
    setStudentForm(emptyStudentForm);
    setScheduleRows([]);
  }

  async function editGroup(group: AdminGroup) {
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

  function updateGroupField(field: keyof typeof emptyGroupForm, value: string | boolean) {
    setGroupForm((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  function updateScheduleField(index: number, field: keyof ScheduleDraft, value: string | boolean) {
    setScheduleRows((current) => current.map((row, rowIndex) => rowIndex === index ? { ...row, [field]: value } : row));
    const errorKey = `schedule-${index}-${field}`;
    const errorKeys = field === "start_time" || field === "end_time" ? [`schedule-${index}-time`] : [errorKey];
    setFieldErrors((current) => {
      if (!errorKeys.some((key) => current[key])) return current;
      const next = { ...current };
      errorKeys.forEach((key) => delete next[key]);
      return next;
    });
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setStatus("");
    if (kind === "groups") {
      const errors: Record<string, string> = {};
      const feesAmount = Number(normalizeDigits(groupForm.fees_amount));
      if (!groupForm.name.trim()) errors.name = t("admin.fieldRequired");
      if (!groupForm.grade.trim()) errors.grade = t("admin.fieldRequired");
      if (!groupForm.subject.trim()) errors.subject = t("admin.fieldRequired");
      if (!groupForm.fees_amount.trim()) errors.fees_amount = t("admin.fieldRequired");
      else if (!Number.isFinite(feesAmount) || feesAmount < 0) errors.fees_amount = t("admin.invalidNumber");
      if (!scheduleRows.length) errors.schedules = t("admin.scheduleRequired");
      scheduleRows.forEach((row, index) => {
        if (!row.start_time || !row.end_time) {
          errors[`schedule-${index}-time`] = t("admin.scheduleTimeRequired");
        }
        if (!/^\d+$/.test(normalizeDigits(row.opens_before_minutes)) || Number(row.opens_before_minutes) < 0) {
          errors[`schedule-${index}-opens_before_minutes`] = t("admin.invalidNumber");
        }
        if (!/^\d+$/.test(normalizeDigits(row.closes_after_minutes)) || Number(row.closes_after_minutes) < 0) {
          errors[`schedule-${index}-closes_after_minutes`] = t("admin.invalidNumber");
        }
      });
      setFieldErrors(errors);
      if (Object.keys(errors).length) return;
    } else {
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
    setSaveMode(editingId ? "update" : "create");
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
      const savedStudentId = !isGroup ? editingId : null;
      const savedStudentCode = data.student?.student_code || normalizedStudentForm.student_code;
      const remainingLoadingTime = 1200 - (Date.now() - saveStartedAt);
      if (remainingLoadingTime > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, remainingLoadingTime));
      }
      resetForm();
      if (isGroup) {
        setStatus(t("admin.groupSaved"));
      } else if (savedStudentId) {
        setStatus("");
        showStudentNotice(savedStudentId, { type: "success", message: t("admin.studentSaved", { code: savedStudentCode }) });
      } else {
        setStatus(t("admin.studentSaved", { code: savedStudentCode }));
      }
      setSaveState("success");
      window.setTimeout(() => setSaveState("idle"), 2000);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : t("errors.loginFailed"));
      setSaveState("error");
      window.setTimeout(() => setSaveState("idle"), 1800);
    } finally {
      setLoading(false);
    }
  }

  function toggleScheduleDay(day: string) {
    setFieldErrors((current) => {
      if (!current.schedules) return current;
      const next = { ...current };
      delete next.schedules;
      return next;
    });
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

  async function updateGroupStatus(id: number, isActive: boolean) {
    const response = await fetch(`${API_BASE_URL}/admin/groups/${id}/status`, {
      method: "PATCH", headers, body: JSON.stringify({ is_active: isActive })
    });
    const data = (await response.json()) as { ok: boolean; status?: string };
    if (!response.ok || !data.ok) throw new Error(adminApiErrorMessage(data.status, t));
  }

  async function sendGroupDeleteRequest(group: AdminGroup, pin = "") {
    const response = await fetch(`${API_BASE_URL}/admin/groups/${group.id}`, {
      method: "DELETE",
      headers,
      body: pin ? JSON.stringify({ audit_pin: pin }) : undefined
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      if (data.status === "group_delete_pin_required") {
        setGroupDeletePinTarget(group);
        setGroupDeletePin("");
      }
      throw new Error(adminApiErrorMessage(data.status, t));
    }
  }

  async function deleteGroup(group: AdminGroup) {
    const confirmed = window.confirm("هل أنت متأكد من حذف المجموعة؟ / Are you sure you want to delete this group?");
    if (!confirmed) return;
    if (Number(group.students_count || 0) > 0) {
      setGroupDeletePinTarget(group);
      setGroupDeletePin("");
      setGroupActionErrors((current) => ({ ...current, [`delete:${group.id}`]: "" }));
      return;
    }
    await runGroupAction(`delete:${group.id}`, () => sendGroupDeleteRequest(group), true);
  }

  async function confirmGroupDeleteWithPin() {
    const group = groupDeletePinTarget;
    const pin = normalizeDigits(groupDeletePin).trim();
    if (!group) return;
    if (!/^\d{4}$/.test(pin)) {
      setGroupActionErrors((current) => ({ ...current, [`delete:${group.id}`]: t("admin.groupDeletePinRequired") }));
      return;
    }
    await runGroupAction(`delete:${group.id}`, () => sendGroupDeleteRequest(group, pin), true, () => {
      setGroupDeletePinTarget(null);
      setGroupDeletePin("");
    });
  }

  async function updateStudentStatus(student: AdminStudent) {
    await runStudentAction(`status:${student.id}`, student.id, async () => {
      const response = await fetch(`${API_BASE_URL}/admin/students/${student.id}/status`, {
        method: "PATCH", headers, body: JSON.stringify({ is_active: !student.is_active })
      });
      const data = (await response.json()) as { ok: boolean; status?: string };
      if (!response.ok || !data.ok) throw new Error(adminApiErrorMessage(data.status, t));
    }, student.is_active ? t("admin.disabledSuccessfully") : t("admin.enabledSuccessfully"), true);
  }

  async function deleteStudent(student: AdminStudent) {
    if (!sessionHasPermission(session, "students.delete")) return;
    if (!window.confirm(t("admin.studentArchiveConfirm", { name: student.full_name, code: student.student_code }))) return;
    await runStudentAction(`delete:${student.id}`, student.id, async () => {
      const response = await fetch(`${API_BASE_URL}/admin/students/${student.id}`, { method: "DELETE", headers });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(adminApiErrorMessage(data.status, t));
    }, t("admin.studentDeleted"), true);
  }

  async function permanentlyDeleteStudent(student: AdminStudent) {
    if (!sessionHasPermission(session, "students.delete")) return;
    setPermanentDeleteRetention({ ...defaultStudentRetention });
    setPermanentDeleteTarget(student);
  }

  async function confirmPermanentDeleteStudent() {
    const student = permanentDeleteTarget;
    if (!student) return;
    const succeeded = await runStudentAction(`permanent-delete:${student.id}`, student.id, async () => {
      const response = await fetch(`${API_BASE_URL}/admin/students/${student.id}/permanent`, { method: "DELETE", headers, body: JSON.stringify({ retain: permanentDeleteRetention }) });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(adminApiErrorMessage(data.status, t));
    }, t("admin.permanentlyDeleted"), true);
    if (succeeded) setPermanentDeleteTarget(null);
  }

  async function restoreStudent(student: AdminStudent) {
    await runStudentAction(`restore:${student.id}`, student.id, async () => {
      const response = await fetch(`${API_BASE_URL}/admin/students/${student.id}/restore`, { method: "PATCH", headers });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(t("errors.loginFailed"));
    }, t("admin.restored"), true);
  }

  async function openGroupDetails(groupId: number) {
    const response = await fetch(`${API_BASE_URL}/admin/groups/${groupId}/details`, { headers });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(t("errors.loginFailed"));
    setDetailFilter("all");
    setGroupDetails(data);
  }

  async function openStudentProfileFromScan() {
    if (profileScanBusyRef.current) return;
    const value = normalizeScanValue(profileScanValue);
    setProfileScanValue("");
    setProfileScanStatus("");
    if (!value) {
      setProfileScanStatus(t("scanner.scanRequired"));
      profileScanRef.current?.focus();
      return;
    }

    profileScanBusyRef.current = true;
    setProfileScanLoading(true);
    const controller = new AbortController();
    profileScanAbortRef.current = controller;
    try {
      const response = await fetch(`${API_BASE_URL}/scanner/student-lookup`, { method: "POST", headers, body: JSON.stringify({ value }), signal: controller.signal });
      const data = (await response.json()) as { ok: boolean; student?: AdminStudent; status?: string };
      if (!response.ok || !data.ok) throw new Error(scannerStatusMessage(String(data.status || ""), t));
      const student = data.student;
      if (!student) {
        setProfileScanStatus(t("scanner.invalidCode"));
        return;
      }
      setProfilePickerId(String(student.id));
      openStudentProfile(student.id);
      setProfileScanStatus(t("scanner.profileOpened"));
    } catch (error) {
      if (controller.signal.aborted) return;
      setProfileScanStatus(error instanceof Error ? error.message : t("errors.loginFailed"));
    } finally {
      profileScanBusyRef.current = false;
      profileScanAbortRef.current = null;
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
    await runStudentAction(`print:${student.id}`, student.id, async () => {
      const printWindow = window.open("", "_blank", "width=420,height=620");
      if (!printWindow) throw new Error(t("admin.printPopupBlocked"));
      try {
        const response = await fetch(`${API_BASE_URL}/admin/students/${student.id}/print-label`, { method: "POST", headers });
        const data = await response.json();
        if (!response.ok || !data.ok || !(data.student?.scan_serial || data.student?.student_serial)) throw new Error(data.status === "label_print_limit_reached" ? t("admin.labelPrintLimitReached") : t("errors.loginFailed"));
        printWindow.document.write(buildStudentLabelMarkup(data.student));
        printWindow.document.close();
        printWindow.focus();
        window.setTimeout(() => printWindow.print(), 250);
      } catch (error) {
        printWindow.close();
        throw error;
      }
    }, t("admin.labelReady"));
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
      {profileStudentId ? <StudentProfileModal studentId={profileStudentId} initialSection={profileSection} session={session} t={t} onClose={closeStudentProfile} /> : null}
      <div className="section-heading">
        <p className="eyebrow">{t(`admin.tabs.${kind}` as TranslationKey)}</p>
        <h2>{editingId ? t("admin.update") : t(`admin.tabs.${kind}` as TranslationKey)}</h2>
      </div>
      <form onSubmit={save} noValidate>
        {kind === "groups" ? (
          <div className="editor-grid">
            <label className={fieldErrors.name ? "field-with-error" : ""}>{t("admin.groupName")}<input required aria-invalid={Boolean(fieldErrors.name)} value={groupForm.name} onChange={(e) => updateGroupField("name", e.target.value)} />{fieldErrors.name ? <small className="field-error">{fieldErrors.name}</small> : null}</label>
            <label className={fieldErrors.grade ? "field-with-error" : ""}>{t("admin.grade")}<select required aria-invalid={Boolean(fieldErrors.grade)} value={groupForm.grade} onChange={(e) => updateGroupField("grade", e.target.value)}><option value="">{t("admin.grade")}</option>{gradeLevels.map(([ar,en]) => <option key={ar} value={ar}>{language === "en" ? en : ar}</option>)}</select>{fieldErrors.grade ? <small className="field-error">{fieldErrors.grade}</small> : null}</label>
            <label className={fieldErrors.subject ? "field-with-error" : ""}>{t("admin.subject")}<input required aria-invalid={Boolean(fieldErrors.subject)} value={groupForm.subject} onChange={(e) => updateGroupField("subject", e.target.value)} />{fieldErrors.subject ? <small className="field-error">{fieldErrors.subject}</small> : null}</label>
            <label className={fieldErrors.fees_amount ? "field-with-error" : ""}>Fees / المصروفات<input required type="text" inputMode="decimal" aria-invalid={Boolean(fieldErrors.fees_amount)} value={groupForm.fees_amount} onChange={(e) => updateGroupField("fees_amount", normalizeDigits(e.target.value))} />{fieldErrors.fees_amount ? <small className="field-error">{fieldErrors.fees_amount}</small> : null}</label>
            <label className="checkbox-label group-active-toggle"><input type="checkbox" checked={groupForm.is_active} onChange={(e) => updateGroupField("is_active", e.target.checked)} />{t("admin.groupActive")}</label>
            <div className={`schedule-editor ${fieldErrors.schedules ? "field-with-error" : ""}`}>
              <div className="schedule-days-label">Class days / أيام الحصص (1–3)</div>
              <div className="schedule-day-picker">
                <button className="secondary-button compact-button schedule-clear-days" type="button" onClick={() => setScheduleRows([])} disabled={!scheduleRows.length}>{t("admin.clearDaySelection")}</button>
                {scheduleDayOrder.map((day) => <label className="checkbox-label" key={day}><input type="checkbox" checked={scheduleRows.some((row) => row.day_of_week === String(day))} onChange={() => toggleScheduleDay(String(day))} />{t(`days.${day}` as TranslationKey)}</label>)}
              </div>
              {fieldErrors.schedules ? <small className="field-error">{fieldErrors.schedules}</small> : null}
              {scheduleRows.map((row, index) => <div className="schedule-row" key={row.day_of_week}>
                <strong>{t(`days.${row.day_of_week}` as TranslationKey)}</strong>
                <label className={fieldErrors[`schedule-${index}-time`] ? "field-with-error" : ""}>Start / البداية<select required aria-invalid={Boolean(fieldErrors[`schedule-${index}-time`])} value={row.start_time} onChange={(e) => updateScheduleField(index, "start_time", e.target.value)}><option value="">Select time / اختر الوقت</option>{scheduleTimeOptions.map((option) => <option key={`start-${option.value}`} value={option.value}>{scheduleTimeLabel(option.value, language)}</option>)}</select>{fieldErrors[`schedule-${index}-time`] ? <small className="field-error">{fieldErrors[`schedule-${index}-time`]}</small> : null}</label>
                <label className={fieldErrors[`schedule-${index}-time`] ? "field-with-error" : ""}>End / النهاية<select required aria-invalid={Boolean(fieldErrors[`schedule-${index}-time`])} value={row.end_time} onChange={(e) => updateScheduleField(index, "end_time", e.target.value)}><option value="">Select time / اختر الوقت</option>{scheduleTimeOptions.map((option) => <option key={`end-${option.value}`} value={option.value}>{scheduleTimeLabel(option.value, language)}</option>)}</select></label>
                <label className={fieldErrors[`schedule-${index}-opens_before_minutes`] ? "field-with-error" : ""}>Open before / فتح قبل<input type="number" min="0" aria-invalid={Boolean(fieldErrors[`schedule-${index}-opens_before_minutes`])} value={row.opens_before_minutes} onChange={(e) => updateScheduleField(index, "opens_before_minutes", e.target.value)} />{fieldErrors[`schedule-${index}-opens_before_minutes`] ? <small className="field-error">{fieldErrors[`schedule-${index}-opens_before_minutes`]}</small> : null}</label>
                <label className={fieldErrors[`schedule-${index}-closes_after_minutes`] ? "field-with-error" : ""}>Close after / إغلاق بعد<input type="number" min="0" aria-invalid={Boolean(fieldErrors[`schedule-${index}-closes_after_minutes`])} value={row.closes_after_minutes} onChange={(e) => updateScheduleField(index, "closes_after_minutes", e.target.value)} />{fieldErrors[`schedule-${index}-closes_after_minutes`] ? <small className="field-error">{fieldErrors[`schedule-${index}-closes_after_minutes`]}</small> : null}</label>
                <label className="checkbox-label schedule-active-toggle"><input type="checkbox" checked={row.is_active} onChange={(e) => updateScheduleField(index, "is_active", e.target.checked)} />Active / نشط</label>
              </div>)}
            </div>
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
        {kind === "groups" && status ? <p className={status === t("admin.groupSaved") ? "lookup-result" : "form-error"} role="alert">{status}</p> : null}
        <div className="form-actions"><button className={`primary-button compact-button action-feedback-${saveState} ${saveState === "success" ? "success-button" : ""}`} type="submit" disabled={loading || saveState === "loading"}>{actionButtonText(saveState, { idle: editingId ? t("admin.update") : t("admin.create"), loading: editingId ? t("admin.updating") : t("admin.creating"), success: saveMode === "update" ? t("admin.updated") : t("admin.created"), error: t("admin.actionFailedSave") })}</button>{editingId ? <button className="secondary-button compact-button" type="button" onClick={resetForm}>{t("admin.cancel")}</button> : null}</div>
      </form>

      {kind === "students" && session.teacher.role === "admin" ? <div className="student-list-toolbar"><div className="status-filter-buttons">{(["active","disabled","deleted","all"] as RecordStatusFilter[]).map((filter)=><button key={filter} className={statusFilter===filter?"active":""} type="button" onClick={()=>setStatusFilter(filter)}>{filter==="active"?"Active / النشط":filter==="disabled"?"Disabled / المعطل":filter==="deleted"?"Deleted / المحذوف":"All / الكل"}</button>)}</div><button className="secondary-button student-list-toggle" type="button" onClick={() => setShowStudents((value) => !value)}>{showStudents ? `${t("admin.hideStudents")} ▲` : `${t("admin.showStudents")} ▼`}</button></div> : null}

      {kind === "students" && session.teacher.role !== "admin" ? <div className="student-list-toolbar"><div className="status-filter-buttons">{(["active","disabled","deleted","all"] as RecordStatusFilter[]).map((filter)=><button key={filter} className={statusFilter===filter?"active":""} type="button" onClick={()=>setStatusFilter(filter)}>{filter==="active"?"Active / النشط":filter==="disabled"?"Disabled / المعطل":filter==="deleted"?"Deleted / المحذوف":"All / الكل"}</button>)}</div><button className="secondary-button student-list-toggle" type="button" onClick={() => setShowStudents((value) => !value)}>{showStudents ? `${t("admin.hideStudents")} ▲` : `${t("admin.showStudents")} ▼`}</button></div> : null}

      {kind === "students" ? <label className="student-search-field">{t("admin.searchStudents")}<input value={studentSearch} onChange={(e) => setStudentSearch(normalizeDigits(e.target.value))} placeholder={t("admin.searchStudents")} /></label> : null}
      {kind === "students" ? <div className="student-bulk-toolbar">
        <label className="student-group-filter">{t("admin.groupFilter")}
          <select value={studentGroupId} onChange={(event) => setStudentGroupId(event.target.value)}>
            <option value="">{t("admin.allGroups")}</option>
            {groups.map((group) => <option key={group.id} value={group.id}>{group.display_name || group.name}</option>)}
          </select>
        </label>
        <div className="student-selection-actions">
          <button className="secondary-button compact-button" type="button" onClick={toggleAllVisibleStudents} disabled={!students.length || !showStudents}>
            {allVisibleStudentsSelected ? t("admin.deselectAll") : t("admin.selectAll")}
          </button>
          {selectedStudentIds.length && sessionHasPermission(session, "students.delete") ? <button className={`danger-button compact-button permanent-bulk-delete-button action-feedback-${permanentBulkDeleteFeedback.state}`} type="button" disabled={permanentBulkDeleteFeedback.state === "loading"} onClick={() => permanentBulkDeleteStudents()}>
            {actionButtonText(permanentBulkDeleteFeedback.state, { idle: t("admin.permanentBulkDelete", { count: String(selectedStudentIds.length) }), loading: t("admin.permanentBulkDeleteLoading", { count: String(selectedStudentIds.length) }), success: t("admin.permanentBulkDeleteSuccess", { count: String(selectedStudentIds.length) }), error: t("admin.actionFailedDelete") })}
          </button> : null}
          {selectedStudentIds.length ? <span className="selected-student-count">{t("admin.selectedStudents", { count: String(selectedStudentIds.length) })}</span> : null}
          {selectedStudentIds.length && sessionHasPermission(session, "students.delete") ? <button className={`danger-button compact-button action-feedback-${bulkDeleteFeedback.state}`} type="button" disabled={bulkDeleteFeedback.state === "loading"} onClick={() => void bulkDeleteStudents()}>
            {actionButtonText(bulkDeleteFeedback.state, { idle: t("admin.bulkDelete", { count: String(selectedStudentIds.length) }), loading: t("admin.bulkDeleteLoading", { count: String(selectedStudentIds.length) }), success: t("admin.bulkDeleteSuccess", { count: String(selectedStudentIds.length) }), error: t("admin.actionFailedDelete") })}
          </button> : null}
        </div>
      </div> : null}
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
        <button className="secondary-button compact-button profile-open-button" type="button" disabled={!profilePickerId} onClick={() => openStudentProfile(Number(profilePickerId))}>{t("admin.viewProfile")}</button>
        {profileScanStatus ? <small className={`profile-scan-status ${profileScanStatus === t("scanner.profileOpened") ? "success" : "error"}`} role="status">{profileScanStatus}</small> : null}
      </div> : null}
      {kind === "groups" ? <div className="academic-list">
        {groups.map((group) => {
          const detailsState = groupActionState(`details:${group.id}`);
          const editState = groupActionState(`edit:${group.id}`);
          const statusState = groupActionState(`status:${group.id}`);
          const deleteState = groupActionState(`delete:${group.id}`);
          const actionError = groupActionErrors[`delete:${group.id}`] || groupActionErrors[`status:${group.id}`] || groupActionErrors[`edit:${group.id}`] || groupActionErrors[`details:${group.id}`];
          return (
            <article className="academic-row" key={group.id}>
              {actionError ? <p className="group-action-error" role="alert">{actionError}</p> : null}
              <div>
                <strong>{group.display_name || group.name}</strong>
                <span>{group.grade_level || group.grade} · {group.subject} · {group.day_of_week != null && group.start_time && group.end_time ? `${t(`days.${group.day_of_week}` as TranslationKey)} ${group.start_time.slice(0, 5)} - ${group.end_time.slice(0, 5)} · ` : ""}{group.fees_amount ?? 0} EGP</span>
                <span className="student-count-badge">Students / عدد الطلاب: {group.students_count ?? 0}</span>
              </div>
              <span className={group.is_active ? "status-active" : "status-disabled"}>{group.is_active ? t("admin.active") : t("admin.disabled")}</span>
              <div className="row-actions">
                <button className={`secondary-button compact-button action-feedback-${detailsState}`} type="button" disabled={loading || detailsState !== "idle"} onClick={() => void runGroupAction(`details:${group.id}`, () => openGroupDetails(group.id))}>
                  {actionButtonText(detailsState, { idle: "Details / التفاصيل", loading: t("admin.loadingDetails"), success: t("admin.detailsLoaded"), error: t("admin.actionFailedSave") })}
                </button>
                <button className={`secondary-button compact-button action-feedback-${editState}`} type="button" disabled={loading || editState !== "idle"} onClick={() => void runGroupAction(`edit:${group.id}`, () => editGroup(group))}>
                  {actionButtonText(editState, { idle: t("admin.editGroup"), loading: t("admin.updating"), success: t("admin.updated"), error: t("admin.actionFailedSave") })}
                </button>
                <button className={`secondary-button compact-button action-feedback-${statusState}`} type="button" disabled={loading || statusState !== "idle"} onClick={() => void runGroupAction(`status:${group.id}`, () => updateGroupStatus(group.id, !group.is_active), true)}>
                  {actionButtonText(statusState, { idle: group.is_active ? t("admin.disable") : t("admin.enable"), loading: group.is_active ? t("admin.disabling") : t("admin.enabling"), success: group.is_active ? t("admin.disabledSuccessfully") : t("admin.enabledSuccessfully"), error: t("admin.actionFailedSave") })}
                </button>
                <button className={`secondary-button compact-button action-feedback-${deleteState}`} type="button" disabled={loading || deleteState !== "idle"} onClick={() => void deleteGroup(group)}>
                  {actionButtonText(deleteState, { idle: "Delete / حذف", loading: t("admin.deleting"), success: t("admin.deletedSuccessfully"), error: t("admin.actionFailedDelete") })}
                </button>
              </div>
            </article>
          );
        })}
        {groups.length === 0 ? <p className="empty-state">{t("admin.noGroups")}</p> : null}
      </div> : null}
      {kind === "students" && showStudents ? <div className="academic-list student-selection-list">
        {students.map((student) => <StudentCard
          key={student.id}
          student={student}
          t={t}
          selected={selectedStudentIds.includes(student.id)}
          canManage={sessionHasPermission(session, "students.manage")}
          canDelete={sessionHasPermission(session, "students.delete")}
          notice={studentCardNotices[student.id]}
          getActionState={studentActionState}
          onToggleSelect={toggleStudentSelection}
          onOpenProfile={(studentId) => openStudentProfile(studentId)}
          onEdit={editStudent}
          onPrint={(value) => void printStudentLabel(value)}
          onStatus={(value) => void updateStudentStatus(value)}
          onDelete={(value) => void deleteStudent(value)}
          onRestore={(value) => void restoreStudent(value)}
          onPermanentDelete={(value) => void permanentlyDeleteStudent(value)}
        />)}
        {!students.length ? <p className="empty-state">{t("admin.noStudents")}</p> : null}
      </div> : null}
      {kind !== "groups" && status ? <p className={status.startsWith(t("admin.studentSaved", { code: "" })) ? "lookup-result" : "form-error"}>{status}</p> : null}
      {bulkDeleteConfirmOpen ? <div className="modal-backdrop" role="presentation"><section className="modal-card bulk-delete-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="bulk-delete-confirm-title">
        <h3 id="bulk-delete-confirm-title">{t("admin.bulkDelete", { count: String(selectedStudentIds.length) })}</h3>
        <p>{t("admin.bulkDeleteConfirm", { count: String(selectedStudentIds.length) })}</p>
        <div className="form-actions">
          <button className="danger-button compact-button" type="button" disabled={bulkDeleteFeedback.state === "loading"} onClick={() => void confirmBulkDeleteStudents()}>{t("admin.bulkDelete", { count: String(selectedStudentIds.length) })}</button>
          <button className="secondary-button compact-button" type="button" disabled={bulkDeleteFeedback.state === "loading"} onClick={() => setBulkDeleteConfirmOpen(false)}>{t("admin.cancel")}</button>
        </div>
      </section></div> : null}
      {permanentDeleteTarget ? <div className="modal-backdrop" role="presentation"><section className="modal-card permanent-delete-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="permanent-delete-confirm-title">
        <h3 id="permanent-delete-confirm-title">{t("admin.retentionConfirmSingle")}</h3>
        <p><strong>{permanentDeleteTarget.full_name}</strong> · <span dir="ltr">{permanentDeleteTarget.student_code}</span></p>
        <p>{t("admin.retentionIdentityWarning")}</p>
        <StudentRetentionOptions value={permanentDeleteRetention} onChange={setPermanentDeleteRetention} t={t} />
        {!permanentDeleteRetention.financial ? <p className="permanent-delete-financial-warning" role="alert">{t("admin.retentionFinancialWarning")}</p> : null}
        <div className="form-actions">
          <button className="danger-button compact-button" type="button" disabled={studentActionState(`permanent-delete:${permanentDeleteTarget.id}`) === "loading"} onClick={() => void confirmPermanentDeleteStudent()}>{actionButtonText(studentActionState(`permanent-delete:${permanentDeleteTarget.id}`), { idle: t("admin.permanentDelete"), loading: t("admin.permanentlyDeleting"), success: t("admin.permanentlyDeleted"), error: t("admin.actionFailedDelete") })}</button>
          <button className="secondary-button compact-button" type="button" disabled={studentActionState(`permanent-delete:${permanentDeleteTarget.id}`) === "loading"} onClick={() => setPermanentDeleteTarget(null)}>{t("admin.cancel")}</button>
        </div>
      </section></div> : null}
      {permanentBulkDeleteConfirmOpen ? <div className="modal-backdrop" role="presentation"><section className="modal-card permanent-bulk-delete-confirm-modal" role="dialog" aria-modal="true" aria-labelledby="permanent-bulk-delete-confirm-title">
        <h3 id="permanent-bulk-delete-confirm-title">{t("admin.permanentBulkDeleteTitle")}</h3>
        <p>{t("admin.permanentBulkDeleteWarning", { count: String(selectedStudentIds.length) })}</p>
        {selectedStudentIds.length <= 8 ? <ul className="permanent-delete-student-list">{selectedStudentIds.map((studentId) => { const student = students.find((item) => item.id === studentId); return student ? <li key={student.id}><strong>{student.full_name}</strong><span dir="ltr">{student.student_code}</span></li> : null; })}</ul> : null}
        <p>{t("admin.retentionIdentityWarning")}</p>
        <StudentRetentionOptions value={permanentBulkDeleteRetention} onChange={setPermanentBulkDeleteRetention} t={t} />
        {!permanentBulkDeleteRetention.financial ? <p className="permanent-delete-financial-warning" role="alert">{t("admin.retentionFinancialWarning")}</p> : null}
        <label className="permanent-delete-confirmation-field">{t("admin.permanentBulkDeletePhrasePrompt")}<input autoFocus value={permanentBulkDeletePhrase} onChange={(event) => setPermanentBulkDeletePhrase(event.target.value)} autoComplete="off" /></label>
        <div className="form-actions">
          <button className="danger-button compact-button" type="button" disabled={permanentBulkDeleteFeedback.state === "loading" || permanentBulkDeletePhrase.trim() !== t("admin.permanentBulkDeletePhrase")} onClick={() => void confirmPermanentBulkDeleteStudents()}>{permanentBulkDeleteFeedback.state === "loading" ? t("admin.permanentBulkDeleteLoading", { count: String(selectedStudentIds.length) }) : t("admin.permanentBulkDelete", { count: String(selectedStudentIds.length) })}</button>
          <button className="secondary-button compact-button" type="button" disabled={permanentBulkDeleteFeedback.state === "loading"} onClick={() => { setPermanentBulkDeleteConfirmOpen(false); setPermanentBulkDeletePhrase(""); }}>{t("admin.cancel")}</button>
        </div>
      </section></div> : null}
      {groupDeletePinTarget ? <div className="modal-backdrop" role="presentation"><section className="modal-card group-delete-pin-modal" role="dialog" aria-modal="true" aria-labelledby="group-delete-pin-title">
        <h3 id="group-delete-pin-title">{t("admin.groupDeletePinTitle")}</h3>
        <p><strong>{groupDeletePinTarget.display_name || groupDeletePinTarget.name}</strong></p>
        <p>{t("admin.groupDeletePinDescription", { count: String(groupDeletePinTarget.students_count || 0) })}</p>
        <label>{t("admin.groupDeletePin")}<input autoFocus type="password" inputMode="numeric" maxLength={4} value={groupDeletePin} onChange={(event) => setGroupDeletePin(normalizeDigits(event.target.value).replace(/\D/g, "").slice(0, 4))} /></label>
        {groupActionErrors[`delete:${groupDeletePinTarget.id}`] ? <p className="form-error" role="alert">{groupActionErrors[`delete:${groupDeletePinTarget.id}`]}</p> : null}
        <div className="form-actions">
          <button className={`danger-button compact-button action-feedback-${groupActionState(`delete:${groupDeletePinTarget.id}`)}`} type="button" disabled={groupActionState(`delete:${groupDeletePinTarget.id}`) !== "idle"} onClick={() => void confirmGroupDeleteWithPin()}>
            {actionButtonText(groupActionState(`delete:${groupDeletePinTarget.id}`), { idle: t("admin.groupDeletePinAction"), loading: t("admin.groupDeletePinLoading"), success: t("admin.deletedSuccessfully"), error: t("admin.actionFailedDelete") })}
          </button>
          <button className="secondary-button compact-button" type="button" disabled={groupActionState(`delete:${groupDeletePinTarget.id}`) !== "idle"} onClick={() => { setGroupDeletePinTarget(null); setGroupDeletePin(""); }}>{t("admin.cancel")}</button>
        </div>
      </section></div> : null}
      {groupDetails ? <div className="modal-backdrop" role="presentation"><section className="modal group-details-modal" role="dialog" aria-modal="true"><button className="close-button" type="button" onClick={()=>setGroupDetails(null)}>×</button><p className="eyebrow">Group details / تفاصيل المجموعة</p><h2>{groupDetails.group.display_name || groupDetails.group.name}</h2><p>{groupDetails.group.grade_level || groupDetails.group.grade} · {groupDetails.group.subject} · {groupDetails.group.fees_amount} EGP</p><div className="detail-stats"><span>Total: {groupDetails.group.students_count ?? 0}</span><span>Active: {groupDetails.group.active_students_count ?? 0}</span><span>Disabled: {groupDetails.group.disabled_students_count ?? 0}</span><span>Deleted: {groupDetails.group.deleted_students_count ?? 0}</span></div><div className="status-filter-buttons group-details-filters" role="group" aria-label="Student status filters">{(["all","active","disabled","deleted"] as RecordStatusFilter[]).map((filter)=><button key={filter} className={detailFilter===filter?"active":""} type="button" onClick={()=>setDetailFilter(filter)}>{recordStatusFilterLabel(filter,t)}</button>)}</div><div className="schedule-detail-list">{groupDetails.schedules.map((schedule:any)=><span key={schedule.id}>{t(`days.${schedule.day_of_week}` as TranslationKey)} · {schedule.start_time.slice(0,5)}–{schedule.end_time.slice(0,5)}</span>)}</div><div className="academic-list group-student-list">{groupDetails.students.filter((student:any)=>detailFilter==="all"||(detailFilter==="deleted"?student.deleted_at:!student.deleted_at&&(detailFilter==="active"?student.is_active:!student.is_active))).map((student:any)=><article className="academic-row group-student-row" key={student.id}><div className="group-student-info"><div className="group-student-heading"><strong>{student.full_name}</strong><span className={student.deleted_at?"status-deleted":student.is_active?"status-active":"status-disabled"}>{recordStatusLabel(student,t)}</span></div><span>Code / الكود: {student.student_serial || student.student_code || "—"}</span><span>Phone / الهاتف: {student.phone || "—"} · Guardian / ولي الأمر: {student.guardian_phone || "—"}</span></div></article>)}</div></section></div> : null}
    </section>
  );
}

function StudentProfileModal({ studentId, session, t, onClose, initialSection }: { studentId: number; session: TeacherSession; t: Translator; onClose: () => void; initialSection?: string }) {
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
  useEffect(() => {
    if (!profile || !initialSection) return undefined;
    const timer = window.setTimeout(() => document.getElementById(`student360-${initialSection}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
    return () => window.clearTimeout(timer);
  }, [profile, initialSection]);

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
    if (!sessionHasPermission(session, "students.manage") || serialRegenerating || !window.confirm(t("admin.regenerateScanSerialConfirm"))) return;
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

  const money = (value: unknown) => Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)} EGP` : "—";
  const profilePercent = (value: unknown) => value == null || !Number.isFinite(Number(value)) ? "—" : `${Number(value).toFixed(1)}%`;
  const attentionReasonLabel = (reason: any) => reason.type === "attendance" ? t("dashboard.attentionAttendance", { value: profilePercent(reason.value) }) : reason.type === "evaluation" ? t("dashboard.attentionEvaluation", { value: profilePercent(reason.value) }) : t("dashboard.attentionPayment", { amount: money(reason.amount) });
  return <div className="modal-backdrop" role="presentation"><section className="modal student-profile-modal" role="dialog" aria-modal="true" aria-label={t("admin.studentProfile")}>
    <button className="close-button" type="button" onClick={onClose}>×</button>
    {loading ? <p className="empty-state">{t("admin.profileLoading")}</p> : profile ? <>
      <div className="section-heading"><p className="eyebrow">{t("dashboard.student360")}</p><h2>{profile.student.full_name}</h2><p>{profile.student.student_code || profile.student.student_serial || "—"} · {profile.student.group_name || "—"} · {recordStatusLabel(profile.student, t)}</p></div>
      <section className="student360-summary" aria-label={t("dashboard.student360Subtitle")}>
        <article><span>{t("dashboard.metricAttendance")}</span><strong>{profile.summary?.attendance ? profilePercent(profile.summary.attendance.percentage) : "—"}</strong><small>{profile.summary?.attendance ? t("dashboard.metricSessions", { present: String(profile.summary.attendance.presentCount), total: String(profile.summary.attendance.totalSessions) }) : t("dashboard.noStudentData")}</small></article>
        <article><span>{t("dashboard.metricEvaluations")}</span><strong>{profile.summary?.evaluations ? profilePercent(profile.summary.evaluations.average) : "—"}</strong><small>{profile.summary?.evaluations ? `${t("dashboard.metricAverage")} · ${profile.summary.evaluations.count || 0}` : t("dashboard.noStudentData")}</small></article>
        <article><span>{t("dashboard.metricPayments")}</span><strong>{profile.summary?.payments ? profilePercent(profile.summary.payments.percentage) : "—"}</strong><small>{profile.summary?.payments ? t("dashboard.metricCollected", { paid: money(profile.summary.payments.paid), required: money(profile.summary.payments.required) }) : t("dashboard.noStudentData")}</small></article>
        <article className="student360-attention-card"><span>{t("dashboard.needsAttention")}</span>{profile.summary?.attention?.length ? <ul>{profile.summary.attention.map((reason: any, index: number) => <li key={`${reason.type}-${index}`}>{attentionReasonLabel(reason)}</li>)}</ul> : <strong className="student360-ok">{t("dashboard.noCurrentAttention")}</strong>}</article>
      </section>
      <section className="profile-section"><h3>{t("admin.basicInfo")}</h3><div className="profile-info-grid">
        <span><b>{t("admin.studentName")}</b>{profile.student.full_name}</span><span><b>{t("admin.studentCode")}</b>{profile.student.student_code || "—"}</span><span><b>{t("admin.scanSerial")}</b>{profile.student.scan_serial || "—"}</span><span><b>{t("admin.selectGroup")}</b>{profile.student.group_name || "—"}</span><span><b>{t("admin.grade")}</b>{profile.student.grade || "—"}</span><span><b>{t("admin.phone")}</b>{profile.student.phone || "—"}</span><span><b>{t("admin.guardianPhone")}</b>{profile.student.guardian_phone || "—"}</span><span><b>{t("admin.active")}</b>{recordStatusLabel(profile.student, t)}</span>
      </div></section>
      <section className="profile-section profile-label-section"><h3>{t("admin.labelDetails")}</h3><div className="profile-label-card"><StudentLabelPreview student={profile.student} />{sessionHasPermission(session, "students.manage") ? <div className="label-actions"><button className="secondary-button compact-button" type="button" onClick={printProfileLabel} disabled={labelPrinting || !labelScanSerial(profile.student)}>{labelPrinting ? t("admin.printingLabel") : t("admin.printLabel")}</button><button className="secondary-button compact-button" type="button" onClick={regenerateProfileScanSerial} disabled={serialRegenerating}>{serialRegenerating ? t("admin.updating") : t("admin.regenerateScanSerial")}</button></div> : null}</div></section>
      {profile.attendance ? <section className="profile-section" id="student360-attendance"><h3>{t("admin.attendanceSummary")}</h3><div className="profile-stat-grid"><span><b>{t("admin.totalSessions")}</b>{profile.attendance.total_sessions}</span><span><b>{t("admin.presentCount")}</b>{profile.attendance.present_count}</span><span><b>{t("admin.absentCount")}</b>{profile.attendance.absent_count}</span><span><b>{t("admin.attendancePercentage")}</b>{profilePercent(profile.attendance.attendance_percentage)}</span></div><h4>{t("admin.attendanceRecords")}</h4>{profile.attendance.records?.length ? <div className="profile-record-list">{profile.attendance.records.map((row: any) => <div key={`${row.session_id}-${row.session_date}`}><span>{row.session_date} · {row.start_time?.slice(0, 5)}–{row.end_time?.slice(0, 5)}</span><AttendanceStatusBadge status={row.status} t={t} /></div>)}</div> : <p className="empty-state">{t("admin.noProfileAttendance")}</p>}</section> : null}
      {profile.exams ? <section className="profile-section" id="student360-evaluations"><h3>{t("admin.examHistory")}</h3>{profile.exams?.length ? <div className="profile-record-list profile-exam-list">{profile.exams.map((row: any) => { const evaluation = scoreEvaluation(row.score, row.max_score, t); return <div className="profile-exam-record" key={row.id}><div className="profile-exam-details"><strong>{displayValue(row.title, language)}</strong><small>{t("dashboard.latestExamDate")}: {formatDateOnly(String(row.exam_date || ""), language, "—")}</small>{row.note ? <small>{t("admin.assessment")}: {displayValue(row.note, language)}</small> : null}</div><div className="profile-exam-score">{row.score == null ? <strong>—</strong> : <><strong className={`score-value score-${evaluation?.tone || ""}`}>{row.score}/{row.max_score}</strong>{evaluation ? <small className={`profile-exam-evaluation score-${evaluation.tone}`}>{evaluation.percentage.toFixed(0)}% — {evaluation.label}</small> : null}</>}</div></div>; })}</div> : <p className="empty-state">{t("admin.noProfileExams")}</p>}</section> : null}
      {profile.notes ? <section className="profile-section" id="student360-notes"><h3>{t("admin.notes")}</h3>{sessionHasPermission(session, "notes.manage") ? <form className="profile-note-form" onSubmit={saveNote}><textarea value={noteBody} onChange={(e) => setNoteBody(e.target.value)} placeholder={t("admin.notePlaceholder")} rows={3} /><button className="secondary-button compact-button" type="submit">{editingNoteId ? t("admin.editNote") : t("admin.addNote")}</button></form> : null}{profile.notes?.length ? <div className="profile-record-list">{profile.notes.map((note: any) => <div key={note.id}><span>{note.body}<small>{note.author_name} · {new Date(note.created_at).toLocaleString()}</small></span>{sessionHasPermission(session, "notes.manage") ? <div className="row-actions"><button className="secondary-button compact-button" type="button" onClick={() => { setEditingNoteId(Number(note.id)); setNoteBody(note.body); }}>{t("admin.editNote")}</button><button className="secondary-button compact-button" type="button" onClick={() => deleteNote(Number(note.id))}>{t("admin.deleteNote")}</button></div> : null}</div>)}</div> : <p className="empty-state">{t("admin.noProfileNotes")}</p>}</section> : null}
      {profile.fees ? <section className="profile-section" id="student360-payments"><h3>{t("admin.feesSummary")}</h3><div className="profile-stat-grid"><span><b>{t("admin.monthlyFee")}</b>{money(profile.fees.fees_amount)}</span><span><b>{t("admin.requiredFees")}</b>{money(profile.fees.required_amount)}</span><span><b>{t("admin.paidFees")}</b>{money(profile.fees.paid_amount)}</span><span><b>{t("admin.remainingFees")}</b>{money(profile.fees.remaining_balance)}</span></div><h4>{t("admin.overdueMonths")}</h4><p>{(profile.fees.monthly_dues || []).filter((due: any) => Number(due.remaining_amount) > 0).map((due: any) => String(due.month).slice(0, 7)).join(" · ") || "—"}</p>{profile.fees.payments ? <><h4>{t("admin.paymentHistory")}</h4>{profile.fees.payments.length ? <div className="profile-record-list">{profile.fees.payments.map((row: any) => <div key={row.id}><span>{new Date(row.paid_at || row.payment_date).toLocaleString()} · {row.paid_by || "—"}</span><strong>{money(row.amount)}</strong></div>)}</div> : <p className="empty-state">{t("admin.noProfilePayments")}</p>}</> : null}</section> : null}
      {profile.inbox ? <section className="profile-section" id="student360-messages"><h3>{t("admin.profileMessages")}</h3>{profile.inbox?.length ? <div className="profile-record-list">{profile.inbox.map((row: any) => <div key={row.id}><span>{row.subject}<small>{row.last_message || "—"}</small></span><strong>{row.message_count}</strong></div>)}</div> : <p className="empty-state">{t("admin.noProfileMessages")}</p>}</section> : null}
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
  return <section className="admin-editor"><div className="section-heading"><p className="eyebrow">{t("admin.tabs.attendance")}</p><h2>Attendance / الحضور</h2></div><label>Date / التاريخ<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label><label>Session / الحصة<select value={selected} onChange={(e) => setSelected(e.target.value)}><option value="">Select session / اختر الحصة</option>{sessions.map((item) => <option key={item.id} value={item.id}>{item.group_name} - {t(`days.${item.day_of_week}` as TranslationKey)} {item.start_time?.slice(0, 5)} إلى {item.end_time?.slice(0, 5)}</option>)}</select></label>{selectedSession ? <p className="field-hint">{formatSessionWindow(selectedSession, language)}</p> : <p className="field-hint">{t("attendance.noRealSessions")}</p>}<div className="academic-list">{groupStudents.map((student) => { const currentStatus = records.find((record) => record.student_id === student.id)?.status || "not_marked"; const feedback = rowFeedback[student.id]; return <article className="academic-row attendance-row" key={student.id}><div className="student-info"><strong>{student.full_name}</strong><span>{student.student_serial || student.student_code} · {student.group_name} · {student.grade}</span></div><div className="attendance-actions"><div className="attendance-buttons"><button className="secondary-button compact-button" disabled={!selected} onClick={() => mark(student.id, "present")}>Present / حاضر</button><button className="secondary-button compact-button" disabled={!selected} onClick={() => mark(student.id, "absent")}>Absent / غائب</button><AttendanceStatusBadge status={currentStatus} t={t} /></div>{feedback ? <small className={`attendance-row-feedback ${feedback === t("attendance.alreadyRegistered") ? "duplicate" : "success"}`} role="status">{feedback}</small> : null}</div></article>; })}</div>{status ? <p className="form-error">{status}</p> : null}</section>;
}

function ScannerPanel({ session, t }: { session: TeacherSession; t: Translator }) {
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [student, setStudent] = useState<any>(null);
  const [scanState, setScanState] = useState<ScannerState>("idle");
  const [scanning, setScanning] = useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const scanBusyRef = React.useRef(false);
  const lastScanRef = React.useRef({ value: "", at: 0 });
  const scanAbortRef = React.useRef<AbortController | null>(null);
  const successMessageTimerRef = React.useRef<number | null>(null);
  useEffect(() => { inputRef.current?.focus(); }, [message, scanning]);
  useEffect(() => () => {
    if (successMessageTimerRef.current !== null) window.clearTimeout(successMessageTimerRef.current);
    scanAbortRef.current?.abort();
  }, []);

  async function scan(event: React.FormEvent) {
    event.preventDefault();
    if (scanBusyRef.current) return;
    if (successMessageTimerRef.current !== null) {
      window.clearTimeout(successMessageTimerRef.current);
      successMessageTimerRef.current = null;
    }

    const token = normalizeScanValue(code);
    const now = Date.now();
    if (!token || (lastScanRef.current.value === token && now - lastScanRef.current.at < 300)) {
      if (!token) {
        setScanState("error");
        setMessage(t("scanner.scanRequired"));
        playScannerFeedback("error");
      }
      inputRef.current?.focus();
      return;
    }
    lastScanRef.current = { value: token, at: now };
    setCode("");
    setMessage("");
    setStudent(null);
    setScanState("scanning");
    scanBusyRef.current = true;
    setScanning(true);
    setScanState("loading");
    const controller = new AbortController();
    scanAbortRef.current = controller;
    try {
      const response = await fetch(`${API_BASE_URL}/scanner/attendance`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.token}`,
          "Idempotency-Key": createIdempotencyKey()
        },
        body: JSON.stringify({ value: token }),
        signal: controller.signal
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
        setMessage(`${data.student?.full_name || ""} — ${t("scanner.recorded")}`);
        playScannerFeedback("success");
        successMessageTimerRef.current = window.setTimeout(() => {
          setMessage("");
          setStudent(null);
          setScanState("idle");
          successMessageTimerRef.current = null;
          inputRef.current?.focus();
        }, 1800);
      } else {
        setScanState("error");
        setMessage(`${data.student?.full_name ? `${data.student.full_name} — ` : ""}${scannerStatusMessage(String(data.status || ""), t)}`);
        playScannerFeedback("error");
      }
    } catch (_error) {
      if (controller.signal.aborted) return;
      setScanState("error");
      setMessage(t("scanner.networkError"));
      playScannerFeedback("error");
    } finally {
      scanBusyRef.current = false;
      scanAbortRef.current = null;
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

function FeesPanel({ session, t }: { session: TeacherSession; t: Translator }) {
  const canCollect = sessionHasPermission(session, "payments.collect");
  const canAdvance = sessionHasPermission(session, "payments.advance");
  const [mode, setMode] = useState<"new" | "advance">(() => canCollect ? "new" : canAdvance ? "advance" : "new");
  const [code, setCode] = useState("");
  const [summary, setSummary] = useState<any>(null);
  const [advanceData, setAdvanceData] = useState<any>(null);
  const [selectedMonths, setSelectedMonths] = useState<string[]>([]);
  const [status, setStatus] = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);
  const [paymentLoading, setPaymentLoading] = useState(false);
  const [advanceLoading, setAdvanceLoading] = useState(false);
  const auth = { Authorization: `Bearer ${session.token}` };
  const inputRef = React.useRef<HTMLInputElement>(null);
  const lookupBusyRef = React.useRef(false);
  const requestAbortRef = React.useRef<AbortController | null>(null);
  const lastLookupRef = React.useRef({ value: "", at: 0 });
  useEffect(() => () => requestAbortRef.current?.abort(), []);
  useEffect(() => {
    requestAbortRef.current?.abort();
    lookupBusyRef.current = false;
    setLookupLoading(false);
  }, [mode]);

  async function lookup(event: React.FormEvent) {
    event.preventDefault();
    setStatus("");
    setSummary(null);
    setAdvanceData(null);
    setSelectedMonths([]);
    const value = normalizeScanValue(code);
    const now = Date.now();
    if (!value) {
      setStatus(t("fees.studentNotFound"));
      inputRef.current?.focus();
      return;
    }
    if (lookupBusyRef.current || (lastLookupRef.current.value === value && now - lastLookupRef.current.at < 300)) return;
    lookupBusyRef.current = true;
    lastLookupRef.current = { value, at: now };
    setCode("");
    setLookupLoading(true);
    const controller = new AbortController();
    requestAbortRef.current = controller;
    try {
      const response = await fetch(`${API_BASE_URL}/admin/fees/scan-lookup`, { method: "POST", headers: { "Content-Type": "application/json", ...auth }, body: JSON.stringify({ value, mode }), signal: controller.signal });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        setStatus(paymentErrorMessage(data.status, data.message, t));
        return;
      }
      if (mode === "advance") setAdvanceData(data);
      else setSummary(data.summary || null);
      setStatus("");
    } catch {
      if (controller.signal.aborted) return;
      setStatus(mode === "advance" ? t("fees.advanceFailed") : t("fees.paymentFailed"));
    } finally {
      lookupBusyRef.current = false;
      requestAbortRef.current = null;
      setLookupLoading(false);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }

  async function pay() {
    if (!summary) return;
    if (Number(summary.remaining_balance) <= 0) {
      setStatus(Number(summary.required_amount) > 0 ? t("fees.alreadyPaid") : t("fees.noOutstanding"));
      return;
    }
    if (paymentLoading) return;
    setPaymentLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/admin/fees/payments`, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": createIdempotencyKey(), ...auth }, body: JSON.stringify({ student_id: summary.id })
      });
      const data = await response.json();
      if (!data.ok) { setStatus(paymentErrorMessage(data.status, data.message, t)); return; }
      setStatus(t("fees.paymentRecorded"));
      setSummary({ ...summary, paid_amount: summary.required_amount, remaining_balance: 0, current_cycle_paid: summary.current_cycle_fee, current_cycle_outstanding: 0 });
      window.dispatchEvent(new Event("fees-updated"));
    } catch { setStatus(t("fees.paymentFailed")); } finally { setPaymentLoading(false); }
  }

  async function saveAdvance() {
    if (!advanceData?.student || !selectedMonths.length) return;
    if (selectedMonths.length > 1 && !window.confirm(t("fees.advanceConfirm"))) return;
    if (advanceLoading) return;
    setAdvanceLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/admin/fees/advance-payments`, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": createIdempotencyKey(), ...auth },
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
    } catch { setStatus(t("fees.advanceFailed")); } finally { setAdvanceLoading(false); }
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
      {canCollect ? <button className={mode === "new" ? "active" : ""} type="button" onClick={() => { setMode("new"); setSummary(null); setAdvanceData(null); setSelectedMonths([]); setStatus(""); }}>{t("fees.newPayment")}</button> : null}
      {canAdvance ? <button className={mode === "advance" ? "active" : ""} type="button" onClick={() => { setMode("advance"); setSummary(null); setAdvanceData(null); setSelectedMonths([]); setStatus(""); }}>{t("fees.advancePayment")}</button> : null}
    </div>
    <form onSubmit={lookup}><label>{t("fees.scanStudent")}<input ref={inputRef} autoFocus dir="ltr" type="text" value={code} onChange={(event) => setCode(event.target.value)} placeholder="A-2303" autoComplete="off" disabled={lookupLoading} /></label><button className="primary-button" type="submit" disabled={lookupLoading || !code.trim()}>{lookupLoading ? t("dashboard.refreshing") : t("fees.find")}</button></form>
    {mode === "new" && summary ? Number(summary.remaining_balance || 0) <= 0 && Number(summary.current_cycle_outstanding || 0) <= 0 ? <div className="status-panel success paid-summary"><strong>{t("fees.paidStudentName", { name: summary.full_name })}</strong><span className="paid-summary-status">{t("fees.paidStudentStatus")}</span></div> : <div className="status-panel success"><strong>{summary.full_name}</strong><span>{summary.student_serial} · {summary.group_name} · {summary.grade_level}</span>{dueMonths ? <span>{t(dueMonthsKey, { months: dueMonths })}</span> : null}<span>{t("studentFees.currentCycleFee")}: {Number(summary.current_cycle_fee || 0).toFixed(2)} EGP · {t("studentFees.currentCyclePaid")}: {Number(summary.current_cycle_paid || 0).toFixed(2)} EGP · {t("studentFees.currentCycleOutstanding")}: {Number(summary.current_cycle_outstanding || 0).toFixed(2)} EGP</span><span>{t("fees.required")}: {Number(summary.required_amount || 0).toFixed(2)} EGP · {t("fees.paid")}: {Number(summary.paid_amount || 0).toFixed(2)} EGP · {t("fees.remaining")}: {Number(summary.remaining_balance || 0).toFixed(2)} EGP</span>{canCollect ? <><small>{t("fees.fullOnly")}</small><button className="secondary-button" type="button" onClick={pay} disabled={paymentLoading}>{paymentLoading ? t("dashboard.refreshing") : t("fees.payFull")}</button></> : null}</div> : null}
      {mode === "advance" && canAdvance && advanceData ? <div className="advance-payment-panel"><div className="status-panel success"><strong>{advanceData.student.full_name}</strong><span>{advanceData.student.student_code} · {advanceData.student.group_name}</span><span>{t("studentFees.monthlyFee")}: {monthlyFee.toFixed(2)} EGP</span></div>{Number(advanceData.current_cycle_outstanding || 0) > 0 ? <p className="form-error advance-lock-message">{t("fees.advanceCurrentMonthUnpaid")}</p> : <><h3>{t("fees.advanceMonths")}</h3><div className="advance-month-grid">{(advanceData.months || []).filter((month: any) => month.available).map((month: any) => <label className="advance-month-option" key={month.month}><input type="checkbox" checked={selectedMonths.includes(month.month.slice(0, 7))} onChange={(event) => setSelectedMonths((current) => event.target.checked ? [...current, month.month.slice(0, 7)] : current.filter((item) => item !== month.month.slice(0, 7)))} /><span>{monthLabel(month.month)}</span><b>{Number(month.remaining_amount).toFixed(2)} EGP</b></label>)}</div>{!(advanceData.months || []).some((month: any) => month.available) ? <p className="empty-state">{t("fees.advanceNoMonths")}</p> : <><p className="advance-total">{t("fees.advanceSelected")}: {selectedMonths.length} · {t("fees.advanceTotal")}: {totalAdvance.toFixed(2)} EGP</p><button className="primary-button" type="button" disabled={!selectedMonths.length || advanceLoading} onClick={saveAdvance}>{advanceLoading ? t("dashboard.refreshing") : t("fees.advancePayment")}</button></>}</>}</div> : null}
    {status ? <p className="lookup-result">{status}</p> : null}
  </section>;
}

function resolveAuditAction(action: string, details: Record<string, unknown> = {}) {
  if (action !== "system_request") return action;
  const request = details.request && typeof details.request === "object" ? details.request as Record<string, unknown> : {};
  const path = String(details.path || request.path || "");
  const method = details.method || request.method;
  if (path.includes("/reset-password")) return "user_password_reset";
  if (path.endsWith("/users") && method === "POST") return "user_created";
  if (path.includes("/users/") && method === "PUT") return "user_updated";
  if (path.includes("/users/") && method === "DELETE") return "user_archived";
  if (path.includes("/audit-logs/unlock")) return "audit_logs_unlocked";
  if (path.includes("/audit-logs/pin")) return "audit_pin_changed";
  return "system_action";
}

function auditActionKey(action: string, details: Record<string, unknown> = {}): TranslationKey {
  const resolvedAction = resolveAuditAction(action, details);
  if (resolvedAction !== action) return auditActionKey(resolvedAction, details);
  const keys: Record<string, TranslationKey> = {
    payment_created: "audit.action.paymentCreated",
    advance_payment_created: "audit.action.advancePaymentCreated",
    payment_reversed: "audit.action.paymentReversed",
    student_created: "audit.action.studentCreated",
    student_updated: "audit.action.studentUpdated",
    student_changed: "audit.action.studentChanged",
    student_status_changed: "audit.action.studentStatusChanged",
    student_restored: "audit.action.studentRestored",
    student_archived: "audit.action.studentArchived",
    students_bulk_archived: "audit.action.studentsBulkArchived",
    students_bulk_permanently_deleted: "audit.action.studentsBulkPermanentlyDeleted",
    student_label_printed: "audit.action.studentLabelPrinted",
    student_personal_data_purged: "audit.action.studentPurged",
    attendance_recorded: "audit.action.attendanceRecorded",
    message_action: "audit.action.messageAction",
    note_action: "audit.action.noteAction",
    audit_pin_changed: "audit.action.pinChanged",
    audit_logs_unlocked: "audit.action.logsUnlocked",
    audit_pin_failed: "audit.action.pinFailed",
    system_request: "audit.action.systemRequest",
    user_created: "audit.action.userCreated",
    user_updated: "audit.action.userUpdated",
    user_changed: "audit.action.userUpdated",
    permissions_changed: "audit.action.permissionsChanged",
    role_changed: "audit.action.roleChanged",
    ownership_transferred: "audit.action.ownershipTransferred",
    user_password_reset: "audit.action.userPasswordReset",
    user_status_changed: "audit.action.userStatusChanged",
    user_archived: "audit.action.userArchived",
    user_restored: "audit.action.userRestored",
    user_permanently_deleted: "audit.action.userPermanentlyDeleted",
    login_succeeded: "audit.action.loginSucceeded",
    login_failed: "audit.action.loginFailed",
    logout: "audit.action.logout",
    group_created: "audit.action.groupCreated",
    group_updated: "audit.action.groupUpdated",
    group_changed: "audit.action.groupUpdated",
    group_status_changed: "audit.action.groupStatusChanged",
    group_archived: "audit.action.groupArchived",
    exam_result_created: "audit.action.examResultCreated",
    exam_result_updated: "audit.action.examResultUpdated",
    exam_result_changed: "audit.action.examResultUpdated",
    exam_result_deleted: "audit.action.examResultDeleted",
    homework_created: "audit.action.homeworkCreated",
    homework_updated: "audit.action.homeworkUpdated",
    homework_deleted: "audit.action.homeworkDeleted",
    note_created: "audit.action.noteCreated",
    note_updated: "audit.action.noteUpdated",
    note_deleted: "audit.action.noteDeleted",
    message_sent: "audit.action.messageSent",
    message_deleted: "audit.action.messageDeleted",
    inbox_message_deleted: "audit.action.messageDeleted",
    message_read_status_changed: "audit.action.messageRead",
    attendance_changed: "audit.action.attendanceChanged",
    attendance_session_changed: "audit.action.attendanceSessionCreated",
    attendance_scanned: "audit.action.attendanceScanned",
    attendance_session_created: "audit.action.attendanceSessionCreated",
    suspicious_scan: "audit.action.suspiciousScan",
    student_scan_serial_regenerated: "audit.action.studentScanSerialRegenerated",
    student_permanently_anonymized: "audit.action.studentPermanentlyAnonymized",
    site_page_updated: "audit.action.sitePageUpdated",
    public_inquiry_created: "audit.action.publicInquiryCreated",
    system_settings_changed: "audit.action.systemSettingsChanged",
    system_action: "audit.action.systemAction"
  };
  return keys[action] || "audit.action.systemRequest";
}

const auditActionOptions: Array<{ value: string; label: TranslationKey }> = [
  { value: "login_succeeded", label: "audit.action.loginSucceeded" },
  { value: "login_failed", label: "audit.action.loginFailed" },
  { value: "logout", label: "audit.action.logout" },
  { value: "student_created", label: "audit.action.studentCreated" },
  { value: "student_updated", label: "audit.action.studentUpdated" },
  { value: "student_changed", label: "audit.action.studentChanged" },
  { value: "student_status_changed", label: "audit.action.studentStatusChanged" },
  { value: "student_restored", label: "audit.action.studentRestored" },
  { value: "student_archived", label: "audit.action.studentArchived" },
  { value: "students_bulk_archived", label: "audit.action.studentsBulkArchived" },
  { value: "students_bulk_permanently_deleted", label: "audit.action.studentsBulkPermanentlyDeleted" },
  { value: "student_label_printed", label: "audit.action.studentLabelPrinted" },
  { value: "student_scan_serial_regenerated", label: "audit.action.studentScanSerialRegenerated" },
  { value: "student_personal_data_purged", label: "audit.action.studentPurged" },
  { value: "student_permanently_anonymized", label: "audit.action.studentPermanentlyAnonymized" },
  { value: "payment_created", label: "audit.action.paymentCreated" },
  { value: "advance_payment_created", label: "audit.action.advancePaymentCreated" },
  { value: "payment_reversed", label: "audit.action.paymentReversed" },
  { value: "attendance_recorded", label: "audit.action.attendanceRecorded" },
  { value: "attendance_changed", label: "audit.action.attendanceChanged" },
  { value: "attendance_scanned", label: "audit.action.attendanceScanned" },
  { value: "attendance_session_created", label: "audit.action.attendanceSessionCreated" },
  { value: "suspicious_scan", label: "audit.action.suspiciousScan" },
  { value: "group_created", label: "audit.action.groupCreated" },
  { value: "group_updated", label: "audit.action.groupUpdated" },
  { value: "group_changed", label: "audit.action.groupUpdated" },
  { value: "group_status_changed", label: "audit.action.groupStatusChanged" },
  { value: "group_archived", label: "audit.action.groupArchived" },
  { value: "exam_result_created", label: "audit.action.examResultCreated" },
  { value: "exam_result_updated", label: "audit.action.examResultUpdated" },
  { value: "exam_result_changed", label: "audit.action.examResultUpdated" },
  { value: "exam_result_deleted", label: "audit.action.examResultDeleted" },
  { value: "homework_created", label: "audit.action.homeworkCreated" },
  { value: "homework_updated", label: "audit.action.homeworkUpdated" },
  { value: "homework_deleted", label: "audit.action.homeworkDeleted" },
  { value: "note_created", label: "audit.action.noteCreated" },
  { value: "note_updated", label: "audit.action.noteUpdated" },
  { value: "note_deleted", label: "audit.action.noteDeleted" },
  { value: "note_action", label: "audit.action.noteAction" },
  { value: "message_sent", label: "audit.action.messageSent" },
  { value: "message_deleted", label: "audit.action.messageDeleted" },
  { value: "inbox_message_deleted", label: "audit.action.messageDeleted" },
  { value: "message_read_status_changed", label: "audit.action.messageRead" },
  { value: "message_action", label: "audit.action.messageAction" },
  { value: "user_created", label: "audit.action.userCreated" },
  { value: "user_updated", label: "audit.action.userUpdated" },
  { value: "user_changed", label: "audit.action.userUpdated" },
  { value: "permissions_changed", label: "audit.action.permissionsChanged" },
  { value: "role_changed", label: "audit.action.roleChanged" },
  { value: "ownership_transferred", label: "audit.action.ownershipTransferred" },
  { value: "user_password_reset", label: "audit.action.userPasswordReset" },
  { value: "user_status_changed", label: "audit.action.userStatusChanged" },
  { value: "user_archived", label: "audit.action.userArchived" },
  { value: "user_restored", label: "audit.action.userRestored" },
  { value: "user_permanently_deleted", label: "audit.action.userPermanentlyDeleted" },
  { value: "audit_pin_changed", label: "audit.action.pinChanged" },
  { value: "audit_logs_unlocked", label: "audit.action.logsUnlocked" },
  { value: "audit_pin_failed", label: "audit.action.pinFailed" },
  { value: "site_page_updated", label: "audit.action.sitePageUpdated" },
  { value: "system_settings_changed", label: "audit.action.systemSettingsChanged" },
  { value: "public_inquiry_created", label: "audit.action.publicInquiryCreated" },
  { value: "system_action", label: "audit.action.systemAction" },
  { value: "system_request", label: "audit.action.systemRequest" }
];

function auditDetailLabelKey(key: string): TranslationKey | null {
  const keys: Record<string, TranslationKey> = {
    body: "audit.detail.content", path: "audit.detail.path", query: "audit.detail.query", method: "audit.detail.method",
    status_code: "audit.detail.statusCode", access_duration_minutes: "audit.detail.accessDuration", reason: "audit.detail.reason",
    original_amount: "audit.detail.originalAmount", payment_date: "audit.detail.paymentDate", payment_type: "audit.detail.paymentType",
    payment_method: "audit.detail.paymentMethod", payment_months: "audit.detail.paymentMonths", reversal_id: "audit.detail.reversalId",
    locked: "audit.detail.locked", pin_digits: "audit.detail.pinDigits", before: "audit.detail.before", after: "audit.detail.after", changes: "audit.detail.changes",
    student_id: "audit.detail.studentId", student_name: "audit.detail.studentName", student_code: "audit.detail.studentCode", user_id: "audit.detail.userId", target_user: "audit.detail.targetUser",
    group_id: "audit.detail.groupId", exam_id: "audit.detail.examId", result_id: "audit.detail.resultId", note_id: "audit.detail.noteId", thread_id: "audit.detail.threadId", message_id: "audit.detail.messageId", record_id: "audit.detail.recordId",
    status_before: "audit.detail.statusBefore", status_after: "audit.detail.statusAfter", amount: "audit.detail.amount", scanned_value: "audit.detail.scannedValue",
    outcome: "audit.detail.outcome", print_type: "audit.detail.printType", serial: "audit.detail.serial", student_serial: "audit.detail.serial",
    scan_serial: "audit.detail.scanSerial", remaining_print_count: "audit.detail.remainingPrintCount", session_date: "audit.detail.sessionDate",
    checkin_time: "audit.detail.checkinTime", guardian_phone: "audit.detail.guardianPhone", phone: "audit.detail.phone", grade_level: "audit.detail.grade",
    group_name: "audit.detail.groupName", full_name: "audit.detail.studentName", username: "admin.username", email: "admin.email", role: "admin.role",
    message_body: "audit.detail.content", page_slug: "admin.selectPage", marked_count: "audit.detail.recordId"
  };
  return keys[key] || null;
}

const auditTechnicalDetailKeys = new Set(["request", "query", "ip", "user_agent", "path", "method", "status_code", "headers", "audit_version", "pin_digits"]);
const auditSensitiveDetailKeys = new Set(["password", "current_password", "new_password", "pin", "token", "authorization", "national_id", "national_id_hash"]);

function isAuditHiddenKey(key: string) {
  const normalized = String(key).toLowerCase();
  return auditTechnicalDetailKeys.has(normalized) || auditSensitiveDetailKeys.has(normalized) || normalized.includes("password") || normalized.includes("token");
}

function humanizeAuditKey(key: string) {
  return key.replace(/_/g, " ").replace(/\b\w/g, (letter: string) => letter.toUpperCase());
}

function formatAuditDetailValue(value: unknown, language: Language, t: Translator, depth = 0): string {
  if (value === null || value === undefined || value === "") return "—";
  if (value === "set") return t("audit.value.set");
  if (typeof value === "boolean") return value ? (language === "ar" ? "نعم" : "Yes") : (language === "ar" ? "لا" : "No");
  if (typeof value !== "object") return String(value);
  if (depth >= 2) return "…";
  if (Array.isArray(value)) {
    return value.map((entry) => formatAuditDetailValue(entry, language, t, depth + 1)).filter(Boolean).join("\n");
  }
  return Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !isAuditHiddenKey(key) && !key.startsWith("_"))
    .map(([key, entryValue]) => `${auditDetailLabelKey(key) ? t(auditDetailLabelKey(key) as TranslationKey) : humanizeAuditKey(key)}: ${formatAuditDetailValue(entryValue, language, t, depth + 1)}`)
    .join("\n");
}

function auditDetailText(key: string, value: unknown, language: Language, t: Translator): string {
  if (key === "outcome") return value === "success" ? t("audit.value.success") : value === "failure" ? t("audit.value.failure") : formatAuditDetailValue(value, language, t);
  if (key === "print_type") return value === "reprint" ? t("audit.value.reprint") : t("audit.value.initialPrint");
  if (key === "payment_type") return value === "advance" ? t("fees.advancePaymentLabel") : t("fees.normalPayment");
  if (key === "changes" && Array.isArray(value)) {
    return value.map((change) => {
      if (!change || typeof change !== "object") return formatAuditDetailValue(change, language, t);
      const item = change as Record<string, unknown>;
      const field = String(item.field || item.setting || "field");
      const label = auditDetailLabelKey(field) ? t(auditDetailLabelKey(field) as TranslationKey) : humanizeAuditKey(field);
      return `${label}: ${formatAuditDetailValue(item.before ?? item.previous_value, language, t)} → ${formatAuditDetailValue(item.after ?? item.new_value, language, t)}`;
    }).join("\n");
  }
  return formatAuditDetailValue(value, language, t);
}

function auditNarrativeFromDetails(action: string, details: Record<string, any>, language: Language, t: Translator, actorName = "—") {
  const resolvedAction = resolveAuditAction(action, details);
  const body = details.body && typeof details.body === "object" ? details.body : {};
  const targetUser = details.target_user && typeof details.target_user === "object" ? details.target_user as Record<string, any> : {};
  const after = details.after && typeof details.after === "object" && !Array.isArray(details.after) ? details.after as Record<string, any> : {};
  const name = String(details.student_name_snapshot || details._student_name || details.full_name || body.full_name || details.student_name || after.full_name || after.name || targetUser.name || details.name || "—");
  const code = String(details.student_code_snapshot || details._student_code || details.student_code || body.student_code || after.student_code || "—");
  const role = body.role ? roleLabel(String(body.role), t) : after.role ? roleLabel(String(after.role), t) : targetUser.role ? roleLabel(String(targetUser.role), t) : "—";
  if (resolvedAction === "user_created") return t("audit.narrative.userCreated", { name: String(body.name || name), username: String(body.username || "—"), role });
  if (resolvedAction === "user_updated") return t("audit.narrative.userUpdated", { name: String(body.name || name), username: String(body.username || "—") });
  if (resolvedAction === "user_password_reset") return t("audit.narrative.userPasswordReset", { name: String(body.name || name) });
  if (resolvedAction === "user_archived") return t("audit.narrative.userArchived", { name: String(body.name || name) });
  if (["student_created", "student_updated", "student_status_changed", "student_restored", "student_archived"].includes(resolvedAction)) {
    const word = resolvedAction === "student_created" ? t("audit.word.created") : resolvedAction === "student_updated" ? t("audit.word.updated") : resolvedAction === "student_restored" ? t("audit.word.restored") : resolvedAction === "student_status_changed" ? t("audit.word.statusChanged") : t("audit.word.deleted");
    return t("audit.narrative.student", { action: word, name, code });
  }
  if (resolvedAction === "student_label_printed") return t("audit.narrative.labelPrinted", { printType: details.print_type === "reprint" ? t("audit.value.reprint") : t("audit.value.initialPrint"), name, code });
  if (resolvedAction === "student_scan_serial_regenerated") return t("audit.narrative.serialRegenerated", { name, code });
  if (resolvedAction === "payment_reversed") return t("audit.narrative.reversed", { payment: String(details._payment_id || details.payment_id || "—"), name, amount: String(details.original_amount || details._payment_amount || "—"), reason: String(details.reason || "—") });
  if (resolvedAction === "payment_created") return t("audit.narrative.payment", { name, code, amount: String(details.amount || details.original_amount || details._payment_amount || "—") });
  if (resolvedAction === "advance_payment_created") return t("audit.narrative.advancePayment", { name, code, amount: String(details.amount || details._payment_amount || "—") });
  if (["attendance_recorded", "attendance_scanned", "attendance_changed"].includes(resolvedAction)) return t("audit.narrative.attendance", { name, code });
  if (resolvedAction === "audit_logs_unlocked") return t("audit.narrative.logsUnlocked", { actor: actorName });
  if (resolvedAction === "audit_pin_failed") return t("audit.narrative.pinFailed", { actor: actorName });
  if (resolvedAction === "login_succeeded") return language === "ar" ? `تم تسجيل الدخول بنجاح للمستخدم ${name !== "—" ? name : code}.` : `Login succeeded for ${name !== "—" ? name : code}.`;
  if (resolvedAction === "login_failed") return language === "ar" ? `فشلت محاولة تسجيل الدخول (${String(details.reason || "سبب غير محدد")}).` : `Login attempt failed (${String(details.reason || "unknown reason")}).`;
  if (resolvedAction === "logout") return language === "ar" ? `تم تسجيل خروج المستخدم ${name !== "—" ? name : String(details.username || "—")}.` : `User ${name !== "—" ? name : String(details.username || "—")} logged out.`;
  return t("audit.narrative.generic", { action: t(auditActionKey(resolvedAction, details)) });
}

function formatAuditDetails(details: Record<string, unknown>, language: Language, t: Translator = createTranslator(language), actorName = "") {
  const action = String(details?._audit_action || details?.action || "system_action");
  const summary = auditNarrativeFromDetails(action, details as Record<string, any>, language, t, actorName || "—");
  const rows = [{ key: t("audit.detail.summary"), value: summary }];
  if (actorName) rows.push({ key: t("audit.detail.actor"), value: actorName });
  if (Array.isArray(details.changes) && details.changes.length) rows.push({ key: t("audit.detail.changes"), value: auditDetailText("changes", details.changes, language, t) });
  Object.entries(details || {}).forEach(([key, value]) => {
    if (key.startsWith("_") || isAuditHiddenKey(key) || ["action", "audit_version", "before", "after", "changes"].includes(key)) return;
    if (key === "body" && value && typeof value === "object" && !Array.isArray(value)) {
      Object.entries(value as Record<string, unknown>).forEach(([bodyKey, bodyValue]) => {
        if (!isAuditHiddenKey(bodyKey)) rows.push({ key: auditDetailLabelKey(bodyKey) ? t(auditDetailLabelKey(bodyKey) as TranslationKey) : humanizeAuditKey(bodyKey), value: auditDetailText(bodyKey, bodyValue, language, t) });
      });
      return;
    }
    rows.push({ key: auditDetailLabelKey(key) ? t(auditDetailLabelKey(key) as TranslationKey) : humanizeAuditKey(key), value: auditDetailText(key, value, language, t) });
  });
  return rows;
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
  const [studentId, setStudentId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [logs, setLogs] = useState<any[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(false);
  const [refreshState, setRefreshState] = useState<"idle" | "loading" | "success">("idle");
  const [maintenanceOperation, setMaintenanceOperation] = useState<"idle" | "preview" | "delete">("idle");
  const [maintenanceFrom, setMaintenanceFrom] = useState("");
  const [maintenanceTo, setMaintenanceTo] = useState("");
  const [maintenancePin, setMaintenancePin] = useState("");
  const [maintenancePassword, setMaintenancePassword] = useState("");
  const [maintenanceReason, setMaintenanceReason] = useState("");
  const [maintenanceConfirmation, setMaintenanceConfirmation] = useState("");
  const [maintenanceCount, setMaintenanceCount] = useState<number | null>(null);
  const [maintenanceStatus, setMaintenanceStatus] = useState("");
  const [maintenanceStatusTone, setMaintenanceStatusTone] = useState<"idle" | "success" | "error">("idle");
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
    if (!token) return false;
    setLoading(true); setStatus("");
    try {
      const params = new URLSearchParams({ page: String(nextPage), limit: "50" });
      if (search.trim()) params.set("search", search.trim()); if (action) params.set("action", action); if (userId.trim()) params.set("user_id", userId.trim()); if (studentId.trim()) params.set("student_id", studentId.trim()); if (dateFrom) params.set("date_from", dateFrom); if (dateTo) params.set("date_to", dateTo);
      const response = await fetch(`${API_BASE_URL}/admin/audit-logs?${params}`, { headers: { ...auth, "X-Audit-Access-Token": token } });
      const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.status || "logs_failed");
      setLogs(Array.isArray(data.logs) ? data.logs : []); setTotal(Number(data.total || 0)); setPage(nextPage);
      return true;
    } catch (error) { if (error instanceof Error && error.message === "audit_access_required") { setUnlocked(false); setAccessToken(""); } setStatus(t("fees.reportLoadFailed")); return false; }
    finally { setLoading(false); }
  }

  async function refreshLogs() {
    setRefreshState("loading");
    const refreshed = await loadLogs(1);
    if (!refreshed) { setRefreshState("idle"); return; }
    setRefreshState("success");
    window.setTimeout(() => setRefreshState("idle"), 1500);
  }

  function maintenanceError(statusValue: string, fallback: TranslationKey) {
    const keys: Record<string, TranslationKey> = {
      invalid_date_range: "audit.maintenanceInvalidDates",
      invalid_pin: "audit.invalidPin",
      audit_pin_not_configured: "audit.maintenancePinNotConfigured",
      audit_pin_locked: "audit.locked",
      invalid_admin_password: "audit.maintenanceInvalidPassword",
      invalid_confirmation: "audit.maintenanceInvalidConfirmation",
      invalid_reason: "audit.maintenanceReasonRequired"
    };
    return t(keys[statusValue] || fallback);
  }

  function maintenanceDateRange() {
    const isValidDate = (value: string) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const parsed = new Date(`${value}T00:00:00Z`);
      return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
    };
    if (!isValidDate(maintenanceFrom) || !isValidDate(maintenanceTo)) return null;
    return maintenanceFrom <= maintenanceTo ? { date_from: maintenanceFrom, date_to: maintenanceTo } : { date_from: maintenanceTo, date_to: maintenanceFrom };
  }

  async function previewMaintenance() {
    setMaintenanceStatus(""); setMaintenanceStatusTone("idle"); setMaintenanceCount(null);
    const range = maintenanceDateRange();
    if (!range) { setMaintenanceStatus(t("audit.maintenanceInvalidDates")); setMaintenanceStatusTone("error"); return; }
    setMaintenanceOperation("preview");
    try {
      const params = new URLSearchParams(range);
      const response = await fetch(`${API_BASE_URL}/admin/audit-logs/maintenance/preview?${params}`, { headers: { ...auth, "X-Audit-Access-Token": accessToken } });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.status || "preview_failed");
      setMaintenanceCount(Number(data.count || 0));
    } catch (error) {
      setMaintenanceStatus(maintenanceError(error instanceof Error ? error.message : "preview_failed", "audit.maintenancePreviewFailed")); setMaintenanceStatusTone("error");
    } finally { setMaintenanceOperation("idle"); }
  }

  async function deleteMaintenance(event: React.FormEvent) {
    event.preventDefault(); setMaintenanceStatus(""); setMaintenanceStatusTone("idle");
    const range = maintenanceDateRange();
    if (!range) { setMaintenanceStatus(t("audit.maintenanceInvalidDates")); setMaintenanceStatusTone("error"); return; }
    if (maintenanceCount === null) { setMaintenanceStatus(t("audit.maintenancePreviewFirst")); setMaintenanceStatusTone("error"); return; }
    if (!/^\d{4}$/.test(maintenancePin)) { setMaintenanceStatus(t("audit.invalidPin")); setMaintenanceStatusTone("error"); return; }
    if (!maintenancePassword.trim()) { setMaintenanceStatus(t("audit.maintenancePasswordRequired")); setMaintenanceStatusTone("error"); return; }
    if (maintenanceConfirmation.trim() !== "DELETE AUDIT LOGS") { setMaintenanceStatus(t("audit.maintenanceInvalidConfirmation")); setMaintenanceStatusTone("error"); return; }
    if (maintenanceReason.trim().length < 3) { setMaintenanceStatus(t("audit.maintenanceReasonRequired")); setMaintenanceStatusTone("error"); return; }
    setMaintenanceOperation("delete");
    try {
      const response = await fetch(`${API_BASE_URL}/admin/audit-logs/maintenance/delete`, { method: "POST", headers: { ...auth, "Content-Type": "application/json", "X-Audit-Access-Token": accessToken }, body: JSON.stringify({ ...range, pin: maintenancePin, current_password: maintenancePassword, reason: maintenanceReason, confirmation: maintenanceConfirmation }) });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.status || "delete_failed");
      const deletedCount = Number(data.deleted_count || 0);
      setMaintenanceCount(0); setMaintenanceStatus(t("audit.maintenanceDeleted", { count: String(deletedCount) })); setMaintenanceStatusTone("success"); setMaintenancePin(""); setMaintenancePassword(""); setMaintenanceReason(""); setMaintenanceConfirmation("");
      await loadLogs(1);
    } catch (error) {
      setMaintenanceStatus(maintenanceError(error instanceof Error ? error.message : "delete_failed", "audit.maintenanceDeleteFailed")); setMaintenanceStatusTone("error");
    } finally { setMaintenanceOperation("idle"); }
  }

  if (configured === null) return <section className="admin-editor audit-logs-panel"><p className="field-hint">{t("fees.reportLoadFailed")}</p></section>;
  if (!configured || showChangePin) return <section className="admin-editor audit-logs-panel"><div className="section-heading"><p className="eyebrow">{t("admin.tabs.auditLogs")}</p><h2>{configured ? t("audit.changePin") : t("audit.setup")}</h2></div><form onSubmit={savePin} className="audit-pin-form"><label>{t("audit.pin")}<input value={newPin} onChange={(event) => setNewPin(normalizeDigits(event.target.value).replace(/\D/g, "").slice(0, 4))} inputMode="numeric" type="password" maxLength={4} autoComplete="new-password" /></label><label>{t("audit.adminPassword")}<input value={adminPassword} onChange={(event) => setAdminPassword(event.target.value)} type="password" autoComplete="current-password" /></label><div className="report-actions"><button className="primary-button" type="submit">{t("audit.setup")}</button>{configured ? <button className="secondary-button" type="button" onClick={() => setShowChangePin(false)}>{t("admin.cancel")}</button> : null}</div>{status ? <p className="form-error">{status}</p> : null}</form></section>;
  if (!unlocked) return <section className="admin-editor audit-logs-panel"><div className="section-heading"><p className="eyebrow">{t("admin.tabs.auditLogs")}</p><h2>{t("audit.title")}</h2></div><form onSubmit={unlock} className="audit-pin-form"><label>{t("audit.pin")}<input value={pin} onChange={(event) => setPin(normalizeDigits(event.target.value).replace(/\D/g, "").slice(0, 4))} inputMode="numeric" type="password" maxLength={4} autoComplete="one-time-code" /></label><button className="primary-button" type="submit">{t("audit.unlock")}</button>{status ? <p className="form-error">{status}</p> : null}</form></section>;
  const refreshLabel = refreshState === "loading" ? t("audit.refreshing") : refreshState === "success" ? t("audit.refreshed") : t("audit.refresh");
  const maintenancePanel = <details className="audit-maintenance"><summary>{t("audit.maintenance")}</summary><form className="audit-maintenance-form" onSubmit={deleteMaintenance}><p className="audit-maintenance-warning">{t("audit.maintenanceWarning")}</p><div className="audit-maintenance-fields"><label>{t("audit.maintenanceFrom")}<input type="date" value={maintenanceFrom} onChange={(event) => { setMaintenanceFrom(event.target.value); setMaintenanceCount(null); setMaintenanceStatus(""); }} /></label><label>{t("audit.maintenanceTo")}<input type="date" value={maintenanceTo} onChange={(event) => { setMaintenanceTo(event.target.value); setMaintenanceCount(null); setMaintenanceStatus(""); }} /></label><label>{t("audit.maintenancePin")}<input value={maintenancePin} onChange={(event) => setMaintenancePin(normalizeDigits(event.target.value).replace(/\D/g, "").slice(0, 4))} inputMode="numeric" type="password" maxLength={4} autoComplete="one-time-code" /></label><label>{t("audit.maintenancePassword")}<input value={maintenancePassword} onChange={(event) => setMaintenancePassword(event.target.value)} type="password" autoComplete="current-password" /></label></div><label>{t("audit.maintenanceReason")}<textarea value={maintenanceReason} onChange={(event) => setMaintenanceReason(event.target.value)} placeholder={t("audit.maintenanceReasonPlaceholder")} rows={3} maxLength={500} /></label><label>{t("audit.maintenanceConfirmation")}<input value={maintenanceConfirmation} onChange={(event) => setMaintenanceConfirmation(event.target.value)} placeholder={t("audit.maintenanceConfirmationHint")} autoComplete="off" /></label><div className="report-actions"><button className="secondary-button compact-button" type="button" disabled={maintenanceOperation !== "idle"} onClick={previewMaintenance}>{maintenanceOperation === "preview" ? t("audit.maintenancePreviewing") : t("audit.maintenancePreview")}</button><button className="danger-button compact-button" type="submit" disabled={maintenanceOperation !== "idle" || maintenanceCount === null}>{maintenanceOperation === "delete" ? t("audit.maintenanceDeleting") : t("audit.maintenanceDelete")}</button></div>{maintenanceCount !== null ? <p className="audit-maintenance-count">{t("audit.maintenanceCount", { count: String(maintenanceCount) })}</p> : null}{maintenanceStatus ? <p className={`audit-maintenance-status ${maintenanceStatusTone}`}>{maintenanceStatus}</p> : null}</form></details>;
  return <section className="admin-editor audit-logs-panel"><div className="section-heading"><p className="eyebrow">{t("admin.tabs.auditLogs")}</p><h2>{t("audit.title")}</h2></div><div className="report-filters payment-report-filters"><label>{t("audit.search")}<input value={search} onChange={(event) => setSearch(event.target.value)} /></label><label>{t("audit.action")}<select value={action} onChange={(event) => { setAction(event.target.value); setPage(1); }}><option value="">{t("audit.allActions")}</option>{auditActionOptions.map((option) => <option key={option.value} value={option.value}>{t(option.label)}</option>)}</select></label><label>{t("audit.user")}<input value={userId} onChange={(event) => setUserId(normalizeDigits(event.target.value))} inputMode="numeric" /></label><label>{t("audit.student")}<input value={studentId} onChange={(event) => setStudentId(normalizeDigits(event.target.value))} inputMode="numeric" /></label><label>{t("audit.dateFrom")}<input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label><label>{t("audit.dateTo")}<input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label></div><div className="report-actions"><button className="primary-button compact-button" type="button" disabled={loading} onClick={refreshLogs}>{refreshLabel}</button><button className="secondary-button compact-button" type="button" onClick={() => { setUnlocked(false); setAccessToken(""); setLogs([]); }}>{t("admin.cancel")}</button><button className="secondary-button compact-button" type="button" onClick={() => setShowChangePin(true)}>{t("audit.changePin")}</button></div><p className="report-total">{total} · {t("audit.title")}</p>{logs.length ? <div className="table-wrap"><table><thead><tr><th>{t("audit.date")}</th><th>{t("audit.user")}</th><th>{t("audit.action")}</th><th>{t("audit.student")}</th><th>{t("audit.payment")}</th><th>{t("audit.details")}</th></tr></thead><tbody>{logs.map((log) => <tr key={log.id}><td>{new Date(log.created_at).toLocaleString(language === "ar" ? "ar-EG" : "en-US")}</td><td>{log.actor_name || log.actor_username || "—"}</td><td>{t(auditActionKey(log.action))}</td><td><strong>{log.student_name || "—"}</strong>{log.student_code ? <small className="audit-student-code">{log.student_code}</small> : log.student_id ? <small className="audit-student-code">ID: {log.student_id}</small> : null}</td><td>{log.payment_id ? `${log.payment_id}${log.payment_amount ? ` · ${log.payment_amount} EGP` : ""}` : "—"}</td><td><details><summary>{t("audit.details")}</summary><div className="audit-detail-list">{formatAuditDetails(log.details || {}, language, t, log.actor_name || log.actor_username || "").map((item) => <div className="audit-detail-item" key={item.key}><b>{item.key}</b><span>{item.value}</span></div>)}{log.reversal_reason ? <div className="audit-detail-item"><b>{t("audit.reason")}</b><span>{log.reversal_reason}</span></div> : null}</div></details></td></tr>)}</tbody></table></div> : <p className="empty-state">{t("audit.noLogs")}</p>}<div className="report-actions audit-pagination"><button className="secondary-button compact-button" type="button" disabled={page <= 1 || loading} onClick={() => loadLogs(page - 1)}>{"‹"}</button><span>{page} / {Math.max(1, Math.ceil(total / 50))}</span><button className="secondary-button compact-button" type="button" disabled={page >= Math.max(1, Math.ceil(total / 50)) || loading} onClick={() => loadLogs(page + 1)}>{"›"}</button></div>{maintenancePanel}{status ? <p className="form-error">{status}</p> : null}</section>;
}

function PaymentReportsPanel({ session, t, canReverse }: { session: TeacherSession; t: Translator; canReverse: boolean }) {
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
    if (!canReverse || !reverseTarget || reverseReason.trim().length < 3) return;
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
    {rows.length ? <div className="table-wrap"><table><thead><tr><th>{t("admin.studentName")}</th><th>{t("admin.studentCode")}</th><th>{t("admin.selectGroup")}</th><th>{t("admin.grade")}</th><th>{t("fees.amount")}</th><th>{t("fees.paymentType")}</th><th>{t("fees.paymentDate")}</th>{canReverse ? <th>{t("fees.reversePayment")}</th> : null}</tr></thead><tbody>{rows.map((row) => <tr key={row.id}><td>{row.full_name}</td><td>{row.student_code}</td><td>{row.group_name}</td><td>{gradeLevelLabel(row.grade_level, document.documentElement.lang === "en" ? "en" : "ar")}</td><td>{row.amount} EGP</td><td>{row.payment_type === "advance" ? t("fees.advancePaymentLabel") : t("fees.normalPayment")}</td><td>{row.paid_at ? new Date(row.paid_at).toLocaleString() : "—"}</td>{canReverse ? <td><button className="secondary-button compact-button" type="button" onClick={() => { setReverseTarget(row); setReverseReason(""); }}>{t("fees.reversePayment")}</button></td> : null}</tr>)}</tbody></table></div> : <p className="empty-state">{status || t("fees.noMatchingResults")}</p>}
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

function inboxSubjectLabel(subject: unknown, t: Translator) {
  const value = typeof subject === "string" ? subject.trim() : "";
  if (value.toLowerCase() === "public inquiry") return t("inbox.publicInquiry");
  return value || t("inbox.showing");
}

function inboxContactLabel(thread: any, t: Translator) {
  return thread.full_name || thread.public_name || thread.public_phone || t("inbox.showing");
}

function inboxSenderLabel(senderType: unknown, t: Translator) {
  const value = typeof senderType === "string" ? senderType.toLowerCase() : "";
  if (value === "student") return t("inbox.senderStudent");
  if (value === "public") return t("inbox.senderPublic");
  if (value === "admin") return t("inbox.senderAdmin");
  if (value === "teacher") return t("inbox.senderTeacher");
  if (value === "assistant") return t("inbox.senderAssistant");
  return typeof senderType === "string" && senderType.trim() ? senderType : t("inbox.showing");
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
      setSelected((current: any) => current ? { ...current, unread_count: 0, read_status: "read" } : current);
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

  return <section className={`admin-editor inbox-panel ${selected ? "inbox-has-selection" : ""}`}>
    <div className="inbox-heading">
      <div>
        <h2>{t("inbox.title")}</h2>
        <p>{t("inbox.workspaceDescription")}</p>
      </div>
    </div>
    <div className="inbox-toolbar">
      <div className="inbox-toolbar-primary">
        <label className="inbox-search-control">
          <span className="visually-hidden">{t("inbox.search")}</span>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("inbox.search")} aria-label={t("inbox.search")} />
        </label>
        <label className="inbox-date-control">
          <span className="visually-hidden">{t("inbox.date")}</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label={t("inbox.date")} />
        </label>
      </div>
      <div className="inbox-toolbar-secondary">
        <div className="inbox-status-filters" role="tablist" aria-label={t("inbox.read")}>
          <button type="button" role="tab" aria-selected={readFilter === "all"} className={readFilter === "all" ? "active" : ""} onClick={() => setReadFilter("all")}>{t("inbox.all")}</button>
          <button type="button" role="tab" aria-selected={readFilter === "unread"} className={readFilter === "unread" ? "active" : ""} onClick={() => setReadFilter("unread")}>{t("inbox.unread")}</button>
          <button type="button" role="tab" aria-selected={readFilter === "read"} className={readFilter === "read" ? "active" : ""} onClick={() => setReadFilter("read")}>{t("inbox.read")}</button>
        </div>
        <div className="inbox-utility-actions">
          <button className="secondary-button compact-button inbox-utility-button" type="button" onClick={() => markRead()} disabled={!canMarkRead || markingRead}>{markingRead ? t("inbox.markingRead") : t("inbox.markRead")}</button>
          <button className="secondary-button compact-button inbox-utility-button" type="button" onClick={() => refresh()} disabled={refreshing}><span aria-hidden="true">↻</span>{refreshing ? t("inbox.refreshing") : t("inbox.refresh")}</button>
        </div>
      </div>
    </div>
    <div className="inbox-layout">
      <div className="inbox-list-panel">
        <div className="inbox-list-heading"><h3>{t("inbox.conversations")}</h3></div>
        <div className="inbox-list">
          {threads.length ? threads.map((thread) => {
            const isUnread = Number(thread.unread_count) > 0;
            const threadTimestamp = thread.last_message_at || thread.updated_at || thread.created_at;
            return <button className={`inbox-thread ${selected?.id === thread.id ? "active" : ""} ${isUnread ? "unread" : "read"}`} key={thread.id} type="button" onClick={() => openThread(thread)}>
              <div className="inbox-thread-identity"><strong>{inboxContactLabel(thread, t)}</strong>{isUnread ? <b aria-label={t("inbox.unread")}>{thread.unread_count}</b> : null}</div>
              <span className="inbox-thread-subject">{inboxSubjectLabel(thread.subject, t)}</span>
              {thread.public_phone ? <small className="inbox-phone">{t("contact.phone")}: {thread.public_phone}</small> : null}
              <span className="inbox-thread-preview">{thread.group_name ? `${thread.group_name} · ` : ""}{thread.last_message || "—"}</span>
              <div className="inbox-thread-footer"><em className={isUnread ? "unread" : "read"}>{thread.read_status === "unread" ? t("inbox.unread") : t("inbox.read")}</em>{threadTimestamp ? <time dateTime={typeof threadTimestamp === "string" ? threadTimestamp : undefined}>{formatInboxTimestamp(threadTimestamp, language)}</time> : null}</div>
            </button>;
          }) : <div className="inbox-empty-list"><p className="empty-state">{t("inbox.noMessages")}</p></div>}
        </div>
      </div>
      <div className="inbox-conversation">
        {selected ? <>
          <div className="inbox-conversation-header">
            <button className="secondary-button compact-button inbox-back-button" type="button" onClick={() => { setSelected(null); setMessages([]); }}><span aria-hidden="true">‹</span>{t("inbox.backToList")}</button>
            <div>
              <p className="eyebrow">{t("inbox.conversationDetails")}</p>
              <h3>{inboxSubjectLabel(selected.subject, t)}</h3>
              <p className="inbox-contact-details"><strong>{inboxContactLabel(selected, t)}</strong>{selected.public_phone ? <a href={`tel:${selected.public_phone}`}>{t("contact.phone")}: {selected.public_phone}</a> : null}</p>
            </div>
          </div>
          <div className="inbox-messages">{messages.length ? messages.map((message) => <article className={`inbox-message ${["admin", "teacher", "assistant"].includes(message.sender_type) ? "mine" : ""} ${message.is_read ? "read" : "unread"}`} key={message.id}>
            <p>{message.body}</p>
            <small className="message-meta"><span>{message.sender_name || inboxSenderLabel(message.sender_type, t)}</span><span className="message-read-status">{inboxMessageStatus(message, "staff", t)}</span><time dateTime={typeof message.created_at === "string" ? message.created_at : undefined}>{formatInboxTimestamp(message.created_at, language)}</time></small>
            {sessionHasPermission(session, "messages.manage") ? <button type="button" className="message-delete-button" onClick={() => deleteMessage(Number(message.id))}>{t("inbox.deleteMessage")}</button> : null}
          </article>) : <p className="empty-state">{t("inbox.noMessages")}</p>}</div>
          <form className="inbox-reply-form" onSubmit={sendReply}><textarea value={reply} onChange={(e) => setReply(e.target.value)} placeholder={t("inbox.reply")} rows={3}/><button className={`primary-button inbox-reply-button ${replyState === "sent" ? "success-button" : ""}`} type="submit" disabled={replyState === "sending"}>{replyState === "sending" ? t("inbox.sending") : replyState === "sent" ? t("inbox.sentStatus") : t("inbox.reply")}</button></form>
        </> : <div className="inbox-empty-state"><span className="inbox-empty-icon" aria-hidden="true">✉</span><h3>{t("inbox.selectThreadTitle")}</h3><p>{t("inbox.selectThreadDescription")}</p></div>}
      </div>
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
    try { const response = await fetch(`${API_BASE_URL}/student/homework`, { headers: studentAuthHeaders(studentCode) }); const data = await response.json(); if (!response.ok || !data.ok) throw new Error("homework_load_failed"); setHomeworks(Array.isArray(data.homework) ? data.homework : []); }
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
      const response = await fetch(`${API_BASE_URL}/student/me/notes`, { headers: studentAuthHeaders(studentCode) });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error("notes_load_failed");
      const nextNotes = Array.isArray(data.notes) ? data.notes : [];
      setNotes(nextNotes);
      onUnreadCountChange(Number(data.unread_count || 0));
      if (Number(data.unread_count || 0) > 0) {
        await fetch(`${API_BASE_URL}/student/me/notes/read`, { method: "PUT", headers: studentAuthHeaders(studentCode) });
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
    fetch(`${API_BASE_URL}/student/me/fees`, { headers: studentAuthHeaders(student.student_code) })
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
    fetch(`${API_BASE_URL}/student/me/exams`, { headers: studentAuthHeaders(student.student_code) })
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
    fetch(`${API_BASE_URL}/student/${student.id}/inbox/unread-count`, { headers: studentAuthHeaders(student.student_code) })
      .then((response) => response.json())
      .then((payload) => setInboxUnread(Number(payload.count || 0)))
      .catch(() => undefined);
  }, [activeTab, refreshKey, student.id]);

  async function refreshDashboard() {
    setRefreshing(true);
    setRefreshStatus("");
    try {
      const response = await fetch(`${API_BASE_URL}/student/me/dashboard`, { headers: studentAuthHeaders(student.student_code) });
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
            <Tab
              id="inbox"
              active={activeTab}
              onClick={setActiveTab}
              label={t("admin.tabs.inbox")}
              unreadCount={inboxUnread}
              ariaLabel={inboxUnread === 1 ? t("admin.messagesUnreadOne") : t("admin.messagesUnreadMany", { count: String(inboxUnread) })}
            />
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
  const headers = { "Content-Type": "application/json", ...studentAuthHeaders(studentCode) };
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
  const headers = { "Content-Type": "application/json", ...studentAuthHeaders(studentCode) };
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
      setSelected((current: any) => current ? { ...current, unread_count: 0 } : current);
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
  label,
  unreadCount = 0,
  ariaLabel
}: {
  id: string;
  active: string;
  onClick: (id: string) => void;
  label: string;
  unreadCount?: number;
  ariaLabel?: string;
}) {
  const showUnreadBadge = id === "inbox" && unreadCount > 0;
  return (
    <button type="button" className={`${active === id ? "active" : ""} ${showUnreadBadge ? "messages-nav-item" : ""}`} aria-label={showUnreadBadge ? ariaLabel : label} role="tab" onClick={() => onClick(id)}>
      <span>{label}</span>
      {showUnreadBadge ? <span className="nav-unread-badge" aria-hidden="true">{unreadCount >= 100 ? "99+" : unreadCount}</span> : null}
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
