import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { useFieldArray, useForm, type Path, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  LandingPageContentSchema,
  type FeatureItem,
  type LandingPageContent,
  type LandingPageLocale,
  type LocalizedLandingPageContent
} from "@abdrabo/shared/landingContent.js";
import { cloneHomeContent, fetchHomeContent, normalizeLocalizedHomeContent } from "./homeContent";

type CmsTranslator = (key: string, values?: Record<string, string>) => string;
type SitePageSlug = "home" | "about-teacher" | "about-center" | "contact" | "tips";
type HomePageOption = { slug: SitePageSlug; label: string };
type AccordionKey = "hero" | "grades" | "features" | "stats";

type Props = {
  apiBaseUrl: string;
  token: string;
  language: "ar" | "en";
  t: CmsTranslator;
  pageOptions: HomePageOption[];
  onPageChange: (slug: SitePageSlug) => void;
  onRegisterLeaveGuard?: (guard: (() => boolean) | null) => void;
  onConfirmLeave?: () => void;
};

const localeLabels: Record<LandingPageLocale, string> = { ar: "العربية", en: "English" };
const stageOptions: Array<{ value: LandingPageContent["grades"][number]["stage"]; ar: string; en: string }> = [
  { value: "primary", ar: "ابتدائي", en: "Primary" },
  { value: "prep", ar: "إعدادي", en: "Preparatory" },
  { value: "secondary", ar: "ثانوي", en: "Secondary" },
  { value: "special", ar: "دعم إضافي", en: "Extra support" }
];

function fieldMessage(errors: unknown, path: string): string | null {
  const value = path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, errors);
  if (!value || typeof value !== "object") return null;
  const message = (value as { message?: unknown }).message;
  return typeof message === "string" ? message : null;
}

function FieldError({ message }: { message: string | null }) {
  return message ? <span className="cms-field-error" role="alert">{message}</span> : null;
}

function AccordionSection({ title, description, section, open, onToggle, children }: {
  title: string;
  description: string;
  section: AccordionKey;
  open: boolean;
  onToggle: (section: AccordionKey) => void;
  children: React.ReactNode;
}) {
  const contentId = `cms-section-${section}`;
  return (
    <section className={`cms-accordion ${open ? "is-open" : ""}`}>
      <button className="cms-accordion-toggle" type="button" aria-expanded={open} aria-controls={contentId} onClick={() => onToggle(section)}>
        <span className="cms-accordion-heading"><strong>{title}</strong><small>{description}</small></span>
        <span className="cms-accordion-chevron" aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      <div className="cms-accordion-content" id={contentId} aria-hidden={!open}>
        <div>{children}</div>
      </div>
    </section>
  );
}

function LocaleToggle({ locale, onChange, disabled }: { locale: LandingPageLocale; onChange: (locale: LandingPageLocale) => void; disabled: boolean }) {
  return (
    <div className="cms-locale-toggle" role="group" aria-label="Content language">
      {(Object.keys(localeLabels) as LandingPageLocale[]).map((value) => (
        <button key={value} type="button" className={locale === value ? "is-active" : ""} aria-pressed={locale === value} disabled={disabled} onClick={() => onChange(value)}>
          {localeLabels[value]}
        </button>
      ))}
    </div>
  );
}

function FeaturePreview({ feature, language }: { feature: FeatureItem; language: LandingPageLocale }) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.article key={`${feature.id}-${feature.num}-${feature.title}-${feature.desc}-${language}`} className="cms-feature-preview" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }}>
        <span>{feature.num || "00"}</span>
        <strong>{feature.title || "—"}</strong>
        <small>{feature.desc || "—"}</small>
      </motion.article>
    </AnimatePresence>
  );
}

export function HomeContentEditor({ apiBaseUrl, token, language, t, pageOptions, onPageChange, onRegisterLeaveGuard, onConfirmLeave }: Props) {
  const [serverContent, setServerContent] = useState<LocalizedLandingPageContent>(normalizeLocalizedHomeContent(undefined));
  const [activeLocale, setActiveLocale] = useState<LandingPageLocale>(language === "en" ? "en" : "ar");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<"idle" | "saved" | "error">("idle");
  const [loadError, setLoadError] = useState(false);
  const [guardOpen, setGuardOpen] = useState(false);
  const [openSections, setOpenSections] = useState<Record<AccordionKey, boolean>>({ hero: true, grades: true, features: true, stats: true });
  const pendingActionRef = useRef<(() => void) | null>(null);
  const contentRef = useRef(serverContent);
  const form = useForm<LandingPageContent>({
    defaultValues: cloneHomeContent(serverContent[activeLocale]),
    resolver: zodResolver(LandingPageContentSchema as never) as unknown as Resolver<LandingPageContent>,
    mode: "onBlur",
    reValidateMode: "onChange"
  });
  const { control, register, handleSubmit, reset, setError, setValue, watch, formState: { errors, isDirty } } = form;
  const { fields: statFields, append, remove } = useFieldArray({ control, name: "stats", keyName: "fieldKey" });
  const watchedHero = watch("hero");
  const watchedGrades = watch("grades");
  const watchedFeatures = watch("features");
  const watchedStats = watch("stats");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    fetchHomeContent(apiBaseUrl, controller.signal)
      .then(({ content }) => {
        contentRef.current = content;
        setServerContent(content);
        reset(cloneHomeContent(content[activeLocale]));
        setLoadError(false);
      })
      .catch((error) => { if (error?.name !== "AbortError") setLoadError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [apiBaseUrl, reset]);

  useEffect(() => {
    contentRef.current = serverContent;
  }, [serverContent]);

  useEffect(() => {
    onRegisterLeaveGuard?.(() => {
      if (!isDirty) return true;
      pendingActionRef.current = null;
      setGuardOpen(true);
      return false;
    });
    return () => onRegisterLeaveGuard?.(null);
  }, [isDirty, onRegisterLeaveGuard]);

  useEffect(() => {
    if (!isDirty) return undefined;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isDirty]);

  function toggleSection(section: AccordionKey) {
    setOpenSections((current) => ({ ...current, [section]: !current[section] }));
  }

  function discardAndContinue() {
    reset(cloneHomeContent(contentRef.current[activeLocale]));
    setStatus("idle");
    setGuardOpen(false);
    const action = pendingActionRef.current;
    pendingActionRef.current = null;
    if (action) action();
    else onConfirmLeave?.();
  }

  function requestAction(action: () => void) {
    if (!isDirty) {
      action();
      return;
    }
    pendingActionRef.current = action;
    setGuardOpen(true);
  }

  function changeLocale(nextLocale: LandingPageLocale) {
    if (nextLocale === activeLocale) return;
    requestAction(() => {
      setActiveLocale(nextLocale);
      reset(cloneHomeContent(contentRef.current[nextLocale]));
    });
  }

  function changePage(nextPage: SitePageSlug) {
    requestAction(() => onPageChange(nextPage));
  }

  function applyValidationErrors(fieldErrors: Record<string, string[]>) {
    Object.entries(fieldErrors).forEach(([path, messages]) => {
      if (path === "content" || !messages?.[0]) return;
      setError(path as Path<LandingPageContent>, { type: "server", message: messages[0] });
    });
  }

  async function saveContent(values: LandingPageContent) {
    setSaving(true);
    setStatus("idle");
    try {
      const parsed = await LandingPageContentSchema.safeParseAsync(values);
      if (!parsed.success) {
        applyValidationErrors(Object.fromEntries(parsed.error.issues.map((issue) => [issue.path.join("."), [issue.message]])));
        setStatus("error");
        return;
      }
      const response = await fetch(`${apiBaseUrl}/site-content?page=home`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ page: "home", locale: activeLocale, content: parsed.data })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) {
        if (response.status === 422 && payload.fieldErrors) applyValidationErrors(payload.fieldErrors);
        throw new Error("home_content_save_failed");
      }
      const nextContent = normalizeLocalizedHomeContent(payload.content);
      contentRef.current = nextContent;
      setServerContent(nextContent);
      reset(cloneHomeContent(nextContent[activeLocale]));
      setStatus("saved");
      window.setTimeout(() => setStatus("idle"), 2400);
    } catch (_error) {
      setStatus("error");
    } finally {
      setSaving(false);
    }
  }

  function resetForm() {
    reset(cloneHomeContent(contentRef.current[activeLocale]));
    setStatus("idle");
  }

  const activeDirection = activeLocale === "ar" ? "rtl" : "ltr";
  const text = (key: string, fallback: string) => {
    const translated = t(key);
    return translated === key ? fallback : translated;
  };

  if (loading) return <div className="cms-home-editor cms-home-editor-loading" aria-busy="true"><span className="cms-loading-shimmer" /><span className="cms-loading-shimmer" /><span className="cms-loading-shimmer" /></div>;

  return (
    <div className="cms-home-editor" dir={activeDirection}>
      <div className="cms-home-toolbar">
        <label className="cms-page-picker" htmlFor="cms-page-select"><span>{text("cms.page", "الصفحة")}</span><select id="cms-page-select" value="home" onChange={(event) => changePage(event.target.value as SitePageSlug)}>{pageOptions.map((option) => <option key={option.slug} value={option.slug}>{option.label}</option>)}</select></label>
        <LocaleToggle locale={activeLocale} onChange={changeLocale} disabled={saving} />
      </div>
      {loadError ? <p className="cms-inline-notice is-warning" role="status">{text("cms.loadedFallback", "تعذر تحميل آخر نسخة، يتم عرض المحتوى الافتراضي.")}</p> : null}
      <form className="cms-home-form" onSubmit={handleSubmit(saveContent)} noValidate>
        <AccordionSection section="hero" open={openSections.hero} onToggle={toggleSection} title={text("cms.hero.title", "إعدادات الواجهة الرئيسية")} description={text("cms.hero.description", "تحكم في الرسالة الرئيسية وأزرار الدعوة لاتخاذ إجراء.")}>
          <div className="cms-form-grid cms-hero-grid">
            {(["badge", "title", "subtitle"] as const).map((field) => {
              const path = `hero.${field}` as const;
              const value = watchedHero?.[field] || "";
              const labelKey = field === "title" ? "cms.hero.titleField" : `cms.hero.${field}`;
              return <label className={field === "subtitle" ? "cms-field cms-field-wide" : "cms-field"} key={field}><span>{text(labelKey, field)}</span><div className="cms-input-with-counter"><input dir={activeDirection} {...register(path)} /><small>{value.length}</small></div><FieldError message={fieldMessage(errors, path)} /></label>;
            })}
            <label className="cms-field"><span>{text("cms.hero.primaryCta", "النص الأساسي")}</span><input dir={activeDirection} {...register("hero.primaryCtaText")} /><FieldError message={fieldMessage(errors, "hero.primaryCtaText")} /></label>
            <label className="cms-field"><span>{text("cms.hero.secondaryCta", "النص الثانوي")}</span><input dir={activeDirection} {...register("hero.secondaryCtaText")} /><FieldError message={fieldMessage(errors, "hero.secondaryCtaText")} /></label>
          </div>
        </AccordionSection>

        <AccordionSection section="grades" open={openSections.grades} onToggle={toggleSection} title={text("cms.grades.title", "مصفوفة المراحل الدراسية")} description={text("cms.grades.description", "عدّل المراحل التسع ورتّب ظهورها على الصفحة الرئيسية.")}>
          <div className="cms-grade-matrix">
            {watchedGrades.map((grade, index) => <article className="cms-grade-editor-card" key={grade.id || index}>
              <span className="cms-card-number">{String(index + 1).padStart(2, "0")}</span>
              <label className="cms-field"><span>{text("cms.grade.title", "اسم المرحلة")}</span><input dir={activeDirection} {...register(`grades.${index}.title` as const)} /><FieldError message={fieldMessage(errors, `grades.${index}.title`)} /></label>
              <label className="cms-field"><span>{text("cms.grade.stage", "التصنيف")}</span><select {...register(`grades.${index}.stage` as const)}>{stageOptions.map((stage) => <option value={stage.value} key={stage.value}>{activeLocale === "ar" ? stage.ar : stage.en}</option>)}</select><FieldError message={fieldMessage(errors, `grades.${index}.stage`)} /></label>
              <button className={`cms-switch ${grade.comingSoon ? "is-on" : ""}`} type="button" role="switch" aria-checked={grade.comingSoon} onClick={() => setValue(`grades.${index}.comingSoon` as const, !grade.comingSoon, { shouldDirty: true, shouldValidate: true })}><span /><b>{grade.comingSoon ? text("cms.grade.comingSoon", "قريباً") : text("cms.grade.available", "متاح الآن")}</b></button>
            </article>)}
          </div>
        </AccordionSection>

        <AccordionSection section="features" open={openSections.features} onToggle={toggleSection} title={text("cms.features.title", "بطاقات المميزات")} description={text("cms.features.description", "أربع بطاقات ثابتة مع معاينة مباشرة للتصميم.")}>
          <div className="cms-feature-editor-grid">
            {watchedFeatures.map((feature, index) => <article className="cms-feature-editor-card" key={feature.id || index}>
              <div className="cms-feature-editor-fields">
                <label className="cms-field cms-num-field"><span>{text("cms.feature.num", "الرقم")}</span><input dir="ltr" maxLength={2} {...register(`features.${index}.num` as const)} /><FieldError message={fieldMessage(errors, `features.${index}.num`)} /></label>
                <label className="cms-field"><span>{text("cms.feature.title", "العنوان")}</span><input dir={activeDirection} {...register(`features.${index}.title` as const)} /><FieldError message={fieldMessage(errors, `features.${index}.title`)} /></label>
                <label className="cms-field cms-field-wide"><span>{text("cms.feature.desc", "الوصف")}</span><textarea dir={activeDirection} rows={2} {...register(`features.${index}.desc` as const)} /><FieldError message={fieldMessage(errors, `features.${index}.desc`)} /></label>
              </div>
              <FeaturePreview feature={feature} language={activeLocale} />
            </article>)}
          </div>
        </AccordionSection>

        <AccordionSection section="stats" open={openSections.stats} onToggle={toggleSection} title={text("cms.stats.title", "شريط الإحصائيات")} description={text("cms.stats.description", "أضف أو عدّل مؤشرات المنصة الظاهرة أسفل الصفحة.")}>
          <div className="cms-stats-editor">
            {statFields.map((field, index) => <article className="cms-stat-editor-row" key={field.fieldKey}>
              <span className="cms-card-number">{String(index + 1).padStart(2, "0")}</span>
              <label className="cms-field"><span>{text("cms.stat.value", "القيمة")}</span><input dir="auto" {...register(`stats.${index}.value` as const)} /><FieldError message={fieldMessage(errors, `stats.${index}.value`)} /></label>
              <label className="cms-field"><span>{text("cms.stat.label", "التسمية")}</span><input dir={activeDirection} {...register(`stats.${index}.label` as const)} /><FieldError message={fieldMessage(errors, `stats.${index}.label`)} /></label>
              <button className="cms-remove-button" type="button" onClick={() => remove(index)} aria-label={text("cms.stat.remove", "حذف المؤشر")}>×</button>
            </article>)}
            <p className="cms-array-error"><FieldError message={fieldMessage(errors, "stats")} /></p>
            <button className="secondary-button cms-add-button" type="button" onClick={() => append({ id: `stat-${Date.now()}`, value: "", label: "" })}>+ {text("cms.stat.add", "إضافة مؤشر")}</button>
            <div className="cms-stats-live-preview"><AnimatePresence mode="wait" initial={false}><motion.div key={JSON.stringify(watchedStats)} className="cms-stats-preview" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>{watchedStats.map((stat) => <span key={stat.id}><strong>{stat.value || "—"}</strong><small>{stat.label || "—"}</small></span>)}</motion.div></AnimatePresence></div>
          </div>
        </AccordionSection>

        <div className="cms-action-bar">
          <div><strong>{status === "saved" ? `✓ ${text("cms.saved", "تم الحفظ")}` : status === "error" ? text("cms.saveError", "راجع الحقول وحاول مرة أخرى.") : isDirty ? text("cms.unsaved", "لديك تعديلات غير محفوظة") : text("cms.synced", "المحتوى متزامن مع الخادم")}</strong><small>{text("cms.validationHint", "سيتم التحقق من كل الحقول قبل الحفظ.")}</small></div>
          <div className="cms-action-buttons"><button className="secondary-button" type="button" disabled={!isDirty || saving} onClick={resetForm}>{text("cms.reset", "إلغاء التعديلات")}</button><button className={`primary-button ${status === "saved" ? "success-button" : ""}`} type="submit" disabled={saving || !isDirty}>{saving ? text("cms.saving", "جاري الحفظ...") : status === "saved" ? text("cms.saved", "تم الحفظ") : text("cms.save", "حفظ التعديلات")}</button></div>
        </div>
      </form>

      {guardOpen ? <div className="modal-backdrop cms-guard-backdrop" role="presentation"><section className="modal cms-guard-modal" role="dialog" aria-modal="true" aria-labelledby="cms-guard-title"><span className="cms-guard-icon" aria-hidden="true">!</span><h2 id="cms-guard-title">{text("cms.guard.title", "لديك تعديلات غير محفوظة")}</h2><p>{text("cms.guard.description", "هل تريد مغادرة الصفحة دون حفظ التعديلات الحالية؟")}</p><div className="cms-guard-actions"><button className="secondary-button" type="button" onClick={() => { setGuardOpen(false); pendingActionRef.current = null; }}>{text("cms.guard.stay", "البقاء والتعديل")}</button><button className="primary-button" type="button" onClick={discardAndContinue}>{text("cms.guard.leave", "مغادرة دون حفظ")}</button></div></section></div> : null}
    </div>
  );
}
