import { useEffect, useMemo, useState } from "react";

type Language = "ar" | "en";
type DashboardTranslator = (key: string, values?: Record<string, string>) => string;

type DashboardGroup = { id: number; name: string; grade_level?: string; active_students: number };
type DashboardSummary = {
  totalIncome: number;
  periodIncome: number;
  paidStudentsCount: number;
  paidStudentsPercentage: number | null;
  overdueStudentsCount: number;
  overdueStudentsPercentage: number | null;
  collectionRate: number | null;
  comparison: {
    periodIncome: number | null;
    paidStudents: number | null;
    overdueStudents: number | null;
    collectionRate: number | null;
  };
};
type DashboardData = {
  ok: boolean;
  filters: { period: string; from: string; to: string; groups: DashboardGroup[] };
  permissions: { financial: boolean; groupPerformance: boolean; alerts: boolean; activity: boolean };
  summary: DashboardSummary | null;
  collection: { required: number; collected: number; remaining: number; rate: number | null } | null;
  studentStatus: { paid: number; paidPercentage: number | null; overdue: number; overduePercentage: number | null } | null;
  groupPerformance: Array<{
    groupId: number;
    groupName: string;
    studentCount: number;
    activeStudents: number;
    attendanceRate: number | null;
    evaluationAverage: number | null;
    collectionRate?: number | null;
    overdueCount?: number;
  }> | null;
  revenueTrend: Array<{ month: string; amount: number }> | null;
  alerts: Array<{ type: string; count: number; threshold: number }> | null;
  recentPayments: Array<{ id: number; amount: number; paidAt: string; paymentMethod: string; studentName: string; groupName: string; studentId?: number }> | null;
};

type AttentionReason = { type: "attendance" | "evaluation" | "payment"; targetSection: string; value?: number | null; threshold?: number | null; amount?: number | null };
type AttentionStudent = {
  studentId: number;
  studentName: string;
  studentCode?: string;
  groupName?: string;
  attendanceRate: number | null;
  evaluationAverage: number | null;
  reasons: AttentionReason[];
};

type Props = {
  token: string;
  language: Language;
  t: DashboardTranslator;
  can: (permission: string) => boolean;
  onNavigate: (tab: string, studentId?: number, section?: string) => void;
  onOpenScanner?: () => void;
};

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_URL || "/api";

function safeNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function percent(value: number | null | undefined) {
  return value == null || !Number.isFinite(Number(value)) ? "—" : `${Number(value).toFixed(1)}%`;
}

function currency(value: unknown, language: Language) {
  const amount = safeNumber(value);
  return `${new Intl.NumberFormat(language === "ar" ? "ar-EG" : "en-US", { maximumFractionDigits: 0 }).format(amount)} EGP`;
}

function signedChange(value: number | null | undefined) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  const amount = Number(value);
  return `${amount > 0 ? "+" : ""}${amount.toFixed(1)}%`;
}

function periodLabel(period: string, t: DashboardTranslator) {
  const labels: Record<string, string> = {
    current: t("dashboard.currentPeriod"),
    previous: t("dashboard.previousPeriod"),
    last3: t("dashboard.last3Months"),
    last6: t("dashboard.last6Months"),
    year: t("dashboard.currentYear"),
    custom: t("dashboard.customPeriod")
  };
  return labels[period] || labels.current;
}

function monthLabel(value: string, language: Language) {
  const date = new Date(`${value}-01T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(language === "ar" ? "ar-EG" : "en-US", { month: "short" }).format(date);
}

function paymentMethodLabel(value: string, t: DashboardTranslator) {
  const key = value === "bank_transfer" || value === "bank" ? "dashboard.bank" : value === "card" ? "dashboard.card" : "dashboard.cash";
  return t(key);
}

function DashboardFilters({
  period,
  groupId,
  from,
  to,
  groups,
  language,
  t,
  onPeriodChange,
  onGroupChange,
  onFromChange,
  onToChange
}: {
  period: string;
  groupId: string;
  from: string;
  to: string;
  groups: DashboardGroup[];
  language: Language;
  t: DashboardTranslator;
  onPeriodChange: (value: string) => void;
  onGroupChange: (value: string) => void;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
}) {
  return (
    <section className="executive-filters dashboard-panel">
      <div className="executive-filter-heading"><span className="panel-kicker">{t("dashboard.filters")}</span><strong>{periodLabel(period, t)}</strong></div>
      <label>
        <span>{t("dashboard.period")}</span>
        <select value={period} onChange={(event) => onPeriodChange(event.target.value)}>
          <option value="current">{t("dashboard.currentPeriod")}</option>
          <option value="previous">{t("dashboard.previousPeriod")}</option>
          <option value="last3">{t("dashboard.last3Months")}</option>
          <option value="last6">{t("dashboard.last6Months")}</option>
          <option value="year">{t("dashboard.currentYear")}</option>
          <option value="custom">{t("dashboard.customPeriod")}</option>
        </select>
      </label>
      <label>
        <span>{t("dashboard.group")}</span>
        <select value={groupId} onChange={(event) => onGroupChange(event.target.value)}>
          <option value="">{t("dashboard.allGroups")}</option>
          {groups.map((group) => <option value={group.id} key={group.id}>{group.name}</option>)}
        </select>
      </label>
      {period === "custom" ? <>
        <label><span>{t("dashboard.from")}</span><input type="date" value={from} onChange={(event) => onFromChange(event.target.value)} /></label>
        <label><span>{t("dashboard.to")}</span><input type="date" value={to} onChange={(event) => onToChange(event.target.value)} /></label>
      </> : null}
      <span className="filter-calendar-mark" aria-hidden="true">{language === "ar" ? "⌄" : "⌄"}</span>
    </section>
  );
}

function KpiCard({ label, value, detail, change, tone, previousLabel }: { label: string; value: string; detail?: string; change?: number | null; tone: string; previousLabel: string }) {
  const changeText = signedChange(change);
  return <article className={`executive-kpi executive-kpi-${tone}`}>
    <div className="executive-kpi-icon" aria-hidden="true">{tone === "income" || tone === "period" ? "▣" : tone === "paid" ? "✓" : tone === "overdue" ? "!" : "%"}</div>
    <span>{label}</span>
    <strong>{value}</strong>
    {detail ? <small>{detail}</small> : null}
    {changeText ? <em className={Number(change) < 0 ? "negative" : "positive"}>{changeText} <span>{previousLabel}</span></em> : null}
  </article>;
}

function CollectionPanel({ collection, language, t, period }: { collection: DashboardData["collection"]; language: Language; t: DashboardTranslator; period: string }) {
  if (!collection) return null;
  const rate = collection.rate == null ? 0 : Math.min(100, Math.max(0, collection.rate));
  return <section className="dashboard-panel collection-panel">
    <div className="panel-heading"><div><h2>{t("dashboard.collectionStatus")} <small>— {periodLabel(period, t)}</small></h2></div><span className="panel-icon">◔</span></div>
    <div className="collection-content">
      <div className="collection-donut" style={{ "--collection-progress": `${rate}%` } as React.CSSProperties}><div><strong>{percent(collection.rate)}</strong><span>{t("dashboard.collectionRate")}</span></div></div>
      <div className="collection-breakdown">
        <div><i className="dot dot-blue" /><span>{t("dashboard.required")}</span><strong>{currency(collection.required, language)}</strong></div>
        <div><i className="dot dot-green" /><span>{t("dashboard.collected")}</span><strong>{currency(collection.collected, language)}</strong></div>
        <div><i className="dot dot-red" /><span>{t("dashboard.remaining")}</span><strong>{currency(collection.remaining, language)}</strong></div>
      </div>
    </div>
  </section>;
}

function StudentStatusPanel({ status, t }: { status: DashboardData["studentStatus"]; t: DashboardTranslator }) {
  if (!status) return null;
  const rows = [
    { key: "paid", label: t("dashboard.paid"), count: status.paid, value: status.paidPercentage, tone: "green" },
    { key: "overdue", label: t("dashboard.overdue"), count: status.overdue, value: status.overduePercentage, tone: "red" }
  ];
  return <section className="dashboard-panel student-status-panel"><div className="panel-heading"><div><h2>{t("dashboard.studentStatus")}</h2></div><span className="panel-icon">♙</span></div><div className="status-list">{rows.map((row) => <div className="status-row" key={row.key}><div className={`status-symbol status-symbol-${row.tone}`}>{row.key === "paid" ? "✓" : "!"}</div><div className="status-row-main"><div><strong>{row.label}</strong><span>{row.count}</span></div><div className="status-track"><i className={`status-fill status-fill-${row.tone}`} style={{ width: `${Math.min(100, Math.max(0, row.value || 0))}%` }} /></div></div><b>{percent(row.value)}</b></div>)}</div></section>;
}

function GroupPerformancePanel({ groups, groupId, t, onGroupChange }: { groups: DashboardData["groupPerformance"]; groupId: string; t: DashboardTranslator; onGroupChange: (value: string) => void }) {
  if (!groups) return null;
  return <section className="dashboard-panel group-performance-panel"><div className="panel-heading"><div><h2>{t("dashboard.groupPerformance")}</h2></div><select value={groupId} onChange={(event) => onGroupChange(event.target.value)}><option value="">{t("dashboard.allGroups")}</option>{groups.map((group) => <option value={group.groupId} key={group.groupId}>{group.groupName}</option>)}</select></div>{groups.length ? <div className="group-performance-grid">{groups.map((group) => <article className="group-performance-card" key={group.groupId}><div className="group-card-heading"><strong>{group.groupName}</strong><span>{group.studentCount} {t("dashboard.students")}</span></div><div className="group-metric"><span>{t("dashboard.attendanceRate")}</span><b>{percent(group.attendanceRate)}</b><i><em className="bar-cyan" style={{ width: `${Math.min(100, Math.max(0, group.attendanceRate || 0))}%` }} /></i></div><div className="group-metric"><span>{t("dashboard.evaluationAverage")}</span><b>{percent(group.evaluationAverage)}</b><i><em className="bar-purple" style={{ width: `${Math.min(100, Math.max(0, group.evaluationAverage || 0))}%` }} /></i></div>{group.collectionRate != null ? <div className="group-metric"><span>{t("dashboard.collectionRate")}</span><b>{percent(group.collectionRate)}</b><i><em className="bar-green" style={{ width: `${Math.min(100, Math.max(0, group.collectionRate || 0))}%` }} /></i></div> : null}<div className="group-card-footer"><span>{t("dashboard.activeStudents")}: <b>{group.activeStudents}</b></span></div></article>)}</div> : <p className="dashboard-empty">{t("dashboard.noData")}</p>}</section>;
}

function RevenueTrend({ trend, language, t }: { trend: DashboardData["revenueTrend"]; language: Language; t: DashboardTranslator }) {
  const points = useMemo(() => {
    if (!trend?.length) return [];
    const max = Math.max(...trend.map((item) => safeNumber(item.amount)), 1);
    return trend.map((item, index) => ({ ...item, x: trend.length === 1 ? 50 : (index / (trend.length - 1)) * 100, y: 92 - (safeNumber(item.amount) / max) * 70 }));
  }, [trend]);
  if (!trend) return null;
  const line = points.map((point) => `${point.x},${point.y}`).join(" ");
  return <section className="dashboard-panel revenue-panel"><div className="panel-heading"><div><h2>{t("dashboard.revenueTrend")}</h2></div><span className="panel-icon">⌁</span></div>{points.length ? <><div className="revenue-chart"><div className="chart-gridline chart-gridline-top" /><div className="chart-gridline chart-gridline-mid" /><div className="chart-gridline chart-gridline-bottom" /><svg viewBox="0 0 100 100" role="img" aria-label={t("dashboard.revenueTrend")} preserveAspectRatio="none"><polygon points={`0,100 ${line} 100,100`} className="chart-area" /><polyline points={line} className="chart-line" />{points.map((point) => <circle cx={point.x} cy={point.y} r="1.6" className="chart-point" key={point.month} />)}</svg></div><div className="revenue-labels">{points.map((point) => <div key={point.month}><strong>{currency(point.amount, language)}</strong><span>{monthLabel(point.month, language)}</span></div>)}</div></> : <p className="dashboard-empty">{t("dashboard.noData")}</p>}</section>;
}

function AlertsPanel({ alerts, t, onNavigate }: { alerts: DashboardData["alerts"]; t: DashboardTranslator; onNavigate: (tab: string) => void }) {
  if (!alerts) return null;
  return <section className="dashboard-panel alerts-panel"><div className="panel-heading"><div><h2>{t("dashboard.importantAlerts")}</h2></div><span className="panel-icon panel-icon-alert">!</span></div>{alerts.length ? <div className="alert-list">{alerts.map((alert) => <button type="button" className={`dashboard-alert dashboard-alert-${alert.type}`} key={alert.type} onClick={() => onNavigate(alert.type === "attendance" ? "attendance" : "exams")}><span className="alert-count">{alert.count}</span><span><strong>{alert.type === "attendance" ? t("dashboard.attendanceAlert") : t("dashboard.evaluationAlert")}</strong><small>{t("dashboard.threshold", { value: String(alert.threshold) })}</small></span><span className="alert-arrow">{t("dashboard.viewTransactions")} →</span></button>)}</div> : <p className="dashboard-empty">{t("dashboard.noData")}</p>}</section>;
}

function RecentPayments({ payments, language, t, onNavigate, openStudents }: { payments: DashboardData["recentPayments"]; language: Language; t: DashboardTranslator; onNavigate: (tab: string, studentId?: number, section?: string) => void; openStudents: boolean }) {
  if (!payments) return null;
  return <section className="dashboard-panel recent-payments-panel"><div className="panel-heading"><div><h2>{t("dashboard.recentPayments")}</h2></div><span className="panel-icon">₤</span></div>{payments.length ? <div className="payment-list">{payments.map((payment) => <button className="recent-payment-row" type="button" key={payment.id} onClick={() => payment.studentId && openStudents ? onNavigate("students", payment.studentId, "payments") : undefined} disabled={!payment.studentId || !openStudents}><div className="payment-avatar">✓</div><div className="payment-person"><strong>{payment.studentName || "—"}</strong><span>{payment.groupName || "—"} · {paymentMethodLabel(payment.paymentMethod, t)}</span></div><time>{new Intl.DateTimeFormat(language === "ar" ? "ar-EG" : "en-US", { hour: "numeric", minute: "2-digit", day: "numeric", month: "short", timeZone: "Africa/Cairo" }).format(new Date(payment.paidAt))}</time><b>{currency(payment.amount, language)}</b></button>)}</div> : <p className="dashboard-empty">{t("dashboard.noData")}</p>}<button className="dashboard-link-button" type="button" onClick={() => onNavigate("fees")}>{t("dashboard.viewTransactions")} <span>←</span></button></section>;
}

function QuickActions({ t, can, onNavigate }: { t: DashboardTranslator; can: (permission: string) => boolean; onNavigate: (tab: string) => void }) {
  const actions = [
    { id: "add-student", label: t("dashboard.addStudent"), permissions: ["students.view", "students.manage"], tab: "students", icon: "+" },
    { id: "attendance", label: t("dashboard.recordAttendance"), permissions: ["attendance.view", "attendance.manage"], tab: "attendance", icon: "✓" },
    { id: "payment", label: t("dashboard.recordPayment"), permissions: ["payments.view", "payments.collect"], tab: "fees", icon: "₤" },
    { id: "evaluation", label: t("dashboard.addEvaluation"), permissions: ["exams.view", "exams.manage"], tab: "exams", icon: "▤" }
  ].filter((action) => action.permissions.every((permission) => can(permission)));
  if (!actions.length) return null;
  return <section className="dashboard-panel quick-actions-panel"><div className="panel-heading"><div><h2>{t("dashboard.quickActions")}</h2></div><span className="panel-icon">✦</span></div><div className="quick-actions-grid">{actions.map((action) => <button type="button" className="quick-action-button" key={action.id} onClick={() => onNavigate(action.tab)}><span aria-hidden="true">{action.icon}</span>{action.label}</button>)}</div></section>;
}

function NeedsAttentionPanel({ students, loading, error, t, language, onNavigate }: { students: AttentionStudent[] | null; loading: boolean; error: string; t: DashboardTranslator; language: Language; onNavigate: (tab: string, studentId?: number, section?: string) => void }) {
  function reasonLabel(reason: AttentionReason) {
    if (reason.type === "attendance") return t("dashboard.attentionAttendance", { value: percent(reason.value) });
    if (reason.type === "evaluation") return t("dashboard.attentionEvaluation", { value: percent(reason.value) });
    return t("dashboard.attentionPayment", { amount: currency(reason.amount, language) });
  }
  return <section className="dashboard-panel needs-attention-panel"><div className="panel-heading"><div><h2>{t("dashboard.needsAttention")}</h2></div><span className="panel-icon panel-icon-alert">!</span></div>{loading ? <div className="attention-skeleton"><i /><i /><i /></div> : error ? <p className="dashboard-empty">{error}</p> : students?.length ? <div className="attention-list">{students.map((student) => <button type="button" className="attention-row" key={student.studentId} onClick={() => onNavigate("students", student.studentId, student.reasons[0]?.targetSection)}><span className="attention-avatar">{student.studentName.slice(0, 1)}</span><span className="attention-student"><strong>{student.studentName}</strong><small>{student.studentCode || "—"} · {student.groupName || "—"}</small><em>{student.reasons.map(reasonLabel).join(" · ")}</em></span><span className="attention-arrow">←</span></button>)}</div> : <p className="dashboard-empty">{t("dashboard.noAttention")}</p>}</section>;
}

function DashboardSkeleton() {
  return <div className="dashboard-skeleton" aria-hidden="true"><div className="skeleton-kpis">{Array.from({ length: 5 }, (_, index) => <i key={index} />)}</div><div className="skeleton-panels"><i /><i /><i /></div></div>;
}

export function AdminExecutiveDashboard({ token, language, t, can, onNavigate, onOpenScanner }: Props) {
  const [period, setPeriod] = useState("current");
  const [groupId, setGroupId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attention, setAttention] = useState<AttentionStudent[] | null>(null);
  const [attentionLoading, setAttentionLoading] = useState(false);
  const [attentionError, setAttentionError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const financial = can("dashboard.financial.view") && Boolean(data?.permissions.financial);
  const groupPerformance = can("dashboard.group_performance.view") && Boolean(data?.permissions.groupPerformance);
  const canAlerts = can("dashboard.alerts.view");
  const alerts = canAlerts && Boolean(data?.permissions.alerts);
  const activity = can("dashboard.activity.view") && Boolean(data?.permissions.activity);

  useEffect(() => {
    if (period === "custom" && (!from || !to)) {
      setLoading(false);
      setAttention(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ period });
    if (groupId) params.set("group_id", groupId);
    if (period === "custom") { params.set("from", from); params.set("to", to); }
    const summaryRequest = fetch(`${API_BASE_URL}/admin/dashboard/summary?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.ok) throw new Error(response.status === 403 ? "forbidden" : "request_failed");
        return payload as DashboardData;
      });
    const attentionRequest = canAlerts ? fetch(`${API_BASE_URL}/admin/dashboard/attention?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal }).then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.ok) throw new Error(response.status === 403 ? "forbidden" : "request_failed");
        return payload as { students: AttentionStudent[] };
      }).catch((reason) => {
        if (reason?.name !== "AbortError") setAttentionError(reason instanceof Error && reason.message === "forbidden" ? t("dashboard.accessDenied") : t("errors.loginFailed"));
        return null;
      }) : null;
    setAttentionLoading(canAlerts);
    setAttentionError("");
    Promise.all([summaryRequest, attentionRequest || Promise.resolve(null)])
      .then(([summary, attentionPayload]) => {
        setData(summary as DashboardData);
        if (attentionPayload) setAttention((attentionPayload as { students: AttentionStudent[] }).students || []);
      })
      .catch((reason) => { if (reason?.name !== "AbortError") setError(reason instanceof Error && reason.message === "forbidden" ? t("dashboard.accessDenied") : t("errors.loginFailed")); })
      .finally(() => { if (!controller.signal.aborted) { setLoading(false); setAttentionLoading(false); } });
    return () => controller.abort();
  }, [token, period, groupId, from, to, reloadKey, canAlerts]);

  return <div className="executive-dashboard" dir={language === "ar" ? "rtl" : "ltr"}>
    <div className="executive-title-row"><div><h1>{t("dashboard.adminTitle")}</h1><p>{t("dashboard.adminSubtitle")}</p></div>{onOpenScanner ? <button className="executive-title-mark executive-title-scan-button" type="button" onClick={onOpenScanner} aria-label={t("scanner.openCamera")} title={t("scanner.openCamera")}><span aria-hidden="true">▥</span></button> : <div className="executive-title-mark" aria-hidden="true">▥</div>}</div>
    <DashboardFilters period={period} groupId={groupId} from={from} to={to} groups={data?.filters.groups || []} language={language} t={t} onPeriodChange={setPeriod} onGroupChange={setGroupId} onFromChange={setFrom} onToChange={setTo} />
    {loading && !data ? <DashboardSkeleton /> : null}
    {error ? <div className="dashboard-error"><strong>{error}</strong><button type="button" onClick={() => setReloadKey((value) => value + 1)}>{t("dashboard.retry")}</button></div> : null}
    {data && financial && data.summary ? <div className="executive-kpi-grid">
      <KpiCard label={t("dashboard.totalIncome")} value={currency(data.summary.totalIncome, language)} tone="income" previousLabel={t("dashboard.previous")} />
      <KpiCard label={t("dashboard.periodIncome")} value={currency(data.summary.periodIncome, language)} tone="period" change={data.summary.comparison.periodIncome} previousLabel={t("dashboard.previous")} />
      <KpiCard label={t("dashboard.paidStudents")} value={String(data.summary.paidStudentsCount)} detail={percent(data.summary.paidStudentsPercentage)} tone="paid" change={data.summary.comparison.paidStudents} previousLabel={t("dashboard.previous")} />
      <KpiCard label={t("dashboard.overdueStudents")} value={String(data.summary.overdueStudentsCount)} detail={percent(data.summary.overdueStudentsPercentage)} tone="overdue" change={data.summary.comparison.overdueStudents} previousLabel={t("dashboard.previous")} />
      <KpiCard label={t("dashboard.collectionRate")} value={percent(data.summary.collectionRate)} tone="rate" change={data.summary.comparison.collectionRate} previousLabel={t("dashboard.previous")} />
    </div> : null}
    {data ? <QuickActions t={t} can={can} onNavigate={onNavigate} /> : null}
    {data && !loading && !financial && !groupPerformance && !alerts && !activity ? <div className="dashboard-empty dashboard-empty-large">{t("dashboard.noData")}</div> : null}
    {data && (financial || groupPerformance || alerts || activity) ? <div className="executive-dashboard-grid">
      {alerts ? <NeedsAttentionPanel students={attention} loading={attentionLoading} error={attentionError} t={t} language={language} onNavigate={onNavigate} /> : null}
      {financial ? <CollectionPanel collection={data.collection} language={language} t={t} period={data.filters.period} /> : null}
      <div className="dashboard-monitoring-grid">
        {financial ? <StudentStatusPanel status={data.studentStatus} t={t} /> : null}
        {groupPerformance ? <GroupPerformancePanel groups={data.groupPerformance} groupId={groupId} t={t} onGroupChange={setGroupId} /> : null}
        {activity ? <RecentPayments payments={data.recentPayments} language={language} t={t} onNavigate={onNavigate} openStudents={can("students.view")} /> : null}
      </div>
      {financial ? <RevenueTrend trend={data.revenueTrend} language={language} t={t} /> : null}
      {alerts ? <AlertsPanel alerts={data.alerts} t={t} onNavigate={onNavigate} /> : null}
    </div> : null}
  </div>;
}
