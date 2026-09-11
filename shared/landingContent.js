import { z } from "zod";

export const GradeItemSchema = z.object({
  id: z.string(),
  title: z.string().min(1, "اسم المرحلة مطلوب"),
  stage: z.enum(["primary", "prep", "secondary", "special"]),
  badge: z.string().default("متاح الآن"),
  comingSoon: z.boolean().default(false),
  sortOrder: z.number().int()
}).strict();

export const FeatureItemSchema = z.object({
  id: z.string(),
  num: z.string().regex(/^\d{2}$/, "يجب أن يكون رقمين مثل 01"),
  title: z.string().min(1, "العنوان مطلوب"),
  desc: z.string().min(1, "الوصف مطلوب")
}).strict();

export const StatItemSchema = z.object({
  id: z.string(),
  value: z.string().min(1, "القيمة مطلوبة"),
  label: z.string().min(1, "التسمية مطلوبة")
}).strict();

export const LandingPageContentSchema = z.object({
  hero: z.object({
    badge: z.string().min(1),
    title: z.string().min(1),
    subtitle: z.string().min(1),
    primaryCtaText: z.string().default("دخول الطالب"),
    secondaryCtaText: z.string().default("استكشف الصفوف")
  }).strict(),
  grades: z.array(GradeItemSchema).min(1),
  features: z.array(FeatureItemSchema).length(4, "يجب تحديد 4 مميزات بدقة"),
  stats: z.array(StatItemSchema).min(1)
}).strict();

const arabicHomeContent = {
  hero: {
    badge: "مدرس العلوم",
    title: "منصة مستر أحمد عبدربه التعليمية",
    subtitle: "نظام متكامل لتعلم العلوم لكل المراحل الدراسية.",
    primaryCtaText: "دخول الطالب",
    secondaryCtaText: "استكشف الصفوف"
  },
  grades: [
    ["fifth-primary", "الصف الخامس الابتدائي", "primary"],
    ["sixth-primary", "الصف السادس الابتدائي", "primary"],
    ["first-prep", "الصف الأول الإعدادي", "prep"],
    ["second-prep", "الصف الثاني الإعدادي", "prep"],
    ["third-prep", "الصف الثالث الإعدادي", "prep"],
    ["first-secondary", "الصف الأول الثانوي", "secondary"],
    ["second-secondary", "الصف الثاني الثانوي", "secondary"],
    ["third-secondary", "الصف الثالث الثانوي", "secondary"],
    ["boost-groups", "مجاميع التقوية", "special"]
  ].map(([id, title, stage], sortOrder) => ({
    id,
    title,
    stage,
    badge: "متاح الآن",
    comingSoon: id === "third-secondary",
    sortOrder
  })),
  features: [
    { id: "whatsapp-alerts", num: "01", title: "إشعارات واتساب فورية", desc: "متابعة درجات الاختبارات والغياب." },
    { id: "practical-learning", num: "02", title: "فهم وتطبيق عملي", desc: "تبسيط التجارب قبل الحفظ." },
    { id: "regular-assessment", num: "03", title: "تقييم واختبارات دورية", desc: "قياس مستوى وبنك أسئلة متجدد." },
    { id: "individual-plans", num: "04", title: "خطط متابعة فردية", desc: "تدريب خاص لرفع مستوى الطالب." }
  ],
  stats: [
    { id: "experience", value: "+4", label: "سنوات خبرة" },
    { id: "students", value: "+1200", label: "طالب تم تدريبهم" },
    { id: "grades", value: "8", label: "صفوف دراسية متاحة" }
  ]
};

const englishHomeContent = {
  hero: {
    badge: "Science Teacher",
    title: "Mr. Ahmed Abdrabo Learning Platform",
    subtitle: "An integrated Science learning system for students across every school stage.",
    primaryCtaText: "Student Login",
    secondaryCtaText: "Explore Grades"
  },
  grades: [
    ["fifth-primary", "Grade 5 Primary", "primary"],
    ["sixth-primary", "Grade 6 Primary", "primary"],
    ["first-prep", "Grade 1 Preparatory", "prep"],
    ["second-prep", "Grade 2 Preparatory", "prep"],
    ["third-prep", "Grade 3 Preparatory", "prep"],
    ["first-secondary", "Grade 1 Secondary", "secondary"],
    ["second-secondary", "Grade 2 Secondary", "secondary"],
    ["third-secondary", "Grade 3 Secondary", "secondary"],
    ["boost-groups", "Boost Groups", "special"]
  ].map(([id, title, stage], sortOrder) => ({
    id,
    title,
    stage,
    badge: "Available now",
    comingSoon: id === "third-secondary",
    sortOrder
  })),
  features: [
    { id: "whatsapp-alerts", num: "01", title: "Instant WhatsApp Alerts", desc: "Track test scores and attendance." },
    { id: "practical-learning", num: "02", title: "Understand & Apply", desc: "Simplify experiments before memorization." },
    { id: "regular-assessment", num: "03", title: "Regular Assessment", desc: "Measure progress with a refreshed question bank." },
    { id: "individual-plans", num: "04", title: "Individual Follow-up Plans", desc: "Focused practice to raise each student’s level." }
  ],
  stats: [
    { id: "experience", value: "+4", label: "Years of experience" },
    { id: "students", value: "+1200", label: "Students trained" },
    { id: "grades", value: "8", label: "Grades available" }
  ]
};

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

export const DEFAULT_HOME_CONTENT = deepFreeze({
  ar: arabicHomeContent,
  en: englishHomeContent
});
