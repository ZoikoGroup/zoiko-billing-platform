import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Building2,
  Users,
  FileText,
  ShieldCheck,
  ScrollText,
  Package,
  UserCheck,
  CircleDollarSign,
  ClipboardCheck,
  AlertTriangle,
} from "lucide-react";

import {
  getPlatformDashboardStats,
  listPlatformAuditLogs,
  listCommercialAccounts,
  listCommercialPlans,
  listCommercialSubscriptions,
  listApprovalRequests,
  getProductionAcceptanceReport,
} from "../../service/commercialService";
import { PageHeader, DataTable } from "../../components/billing-ui";
import {
  DashboardStatCard,
  DashboardStatCardSkeleton,
  ErrorState,
  EmptyState,
} from "../../components/billing-shared";
import { AuditActionBadge, formatDateTime } from "./constants";

const OVERALL_VERDICT_BADGE = {
  BLOCKED: "bg-red-100 text-red-700",
  CONDITIONAL: "bg-amber-100 text-amber-700",
  READY: "bg-emerald-100 text-emerald-700",
};

function SectionHeading({ children }) {
  return (
    <h2 className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-600">
      {children}
    </h2>
  );
}

/**
 * A KPI card whose source failed to load — a real 0 and a failed request
 * must never look the same (Section 10 of the enterprise hardening pass).
 */
function DegradedStatCard({ title, icon: Icon, onRetry }) {
  return (
    <div className="h-full rounded-3xl border border-amber-200 bg-amber-50/60 p-5 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold uppercase tracking-wider text-amber-700">{title}</p>
          <h3 className="mt-2 text-xl font-extrabold leading-tight text-amber-800">Unavailable</h3>
          <p className="mt-2 text-xs text-amber-600">Failed to load — data service unreachable.</p>
        </div>
        <div className="ml-3 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-600">
          <AlertTriangle size={20} />
        </div>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 w-full rounded-xl border border-amber-300 bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-200"
        >
          Retry
        </button>
      )}
    </div>
  );
}

/**
 * ONE canonical Super Admin dashboard combining Platform Health, Commercial
 * Health, Security/Governance, and Recent Activity — replacing the two
 * separate "Platform Dashboard" and "Commercial Control Center" dashboards
 * that previously existed side by side. Every KPI below comes from a real
 * backend endpoint; a source that fails to load renders as "Unavailable",
 * never as a silent 0 (Section 10).
 */
export default function PlatformDashboardPage() {
  const navigate = useNavigate();

  const [platformStats, setPlatformStats] = useState(null);
  const [commercial, setCommercial] = useState(null);
  const [pendingApprovals, setPendingApprovals] = useState(null);
  const [readiness, setReadiness] = useState(null);
  const [activity, setActivity] = useState(null);

  const [sourceErrors, setSourceErrors] = useState({});
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setFatalError(null);
    const nextErrors = {};

    const platformStatsPromise = getPlatformDashboardStats().catch((e) => {
      nextErrors.platform = e?.message || "Failed to load platform statistics.";
      return null;
    });
    const accountsPromise = listCommercialAccounts({ limit: 200 }).catch((e) => {
      nextErrors.accounts = e?.message || "Failed to load organizations.";
      return null;
    });
    const plansPromise = listCommercialPlans({ limit: 200 }).catch((e) => {
      nextErrors.plans = e?.message || "Failed to load commercial plans.";
      return null;
    });
    const subscriptionsPromise = listCommercialSubscriptions({ limit: 200 }).catch((e) => {
      nextErrors.subscriptions = e?.message || "Failed to load commercial subscriptions.";
      return null;
    });
    const approvalsPromise = listApprovalRequests({ status: "pending", limit: 1 }).catch((e) => {
      nextErrors.approvals = e?.message || "Failed to load the approval queue.";
      return null;
    });
    const readinessPromise = getProductionAcceptanceReport().catch((e) => {
      nextErrors.readiness = e?.message || "Failed to load the production readiness report.";
      return null;
    });
    const activityPromise = listPlatformAuditLogs({ limit: 5 }).catch((e) => {
      nextErrors.activity = e?.message || "Failed to load recent platform activity.";
      return null;
    });

    Promise.all([
      platformStatsPromise,
      accountsPromise,
      plansPromise,
      subscriptionsPromise,
      approvalsPromise,
      readinessPromise,
      activityPromise,
    ]).then(([stats, accounts, plans, subscriptions, approvals, readinessReport, activityLogs]) => {
      setPlatformStats(stats);
      setCommercial({ accounts, plans, subscriptions });
      setPendingApprovals(approvals ? approvals.total : null);
      setReadiness(readinessReport);
      setActivity(activityLogs ? activityLogs.logs || [] : null);
      setSourceErrors(nextErrors);

      const allFailed = Object.keys(nextErrors).length === 7;
      if (allFailed) {
        setFatalError("Unable to reach any platform data service.");
      }
      setLoading(false);
    });
  }, []);

  /**
   * Retry a single failed data source without re-fetching every source.
   */
  const retrySource = useCallback(async (sourceKey) => {
    setSourceErrors((prev) => {
      const next = { ...prev };
      delete next[sourceKey];
      return next;
    });
    try {
      let result;
      switch (sourceKey) {
        case "platform":
          result = await getPlatformDashboardStats();
          setPlatformStats(result);
          break;
        case "accounts": {
          result = await listCommercialAccounts({ limit: 200 });
          setCommercial((prev) => prev ? { ...prev, accounts: result } : { accounts: result, plans: null, subscriptions: null });
          break;
        }
        case "plans": {
          result = await listCommercialPlans({ limit: 200 });
          setCommercial((prev) => prev ? { ...prev, plans: result } : { accounts: null, plans: result, subscriptions: null });
          break;
        }
        case "subscriptions": {
          result = await listCommercialSubscriptions({ limit: 200 });
          setCommercial((prev) => prev ? { ...prev, subscriptions: result } : { accounts: null, plans: null, subscriptions: result });
          break;
        }
        case "approvals":
          result = await listApprovalRequests({ status: "pending", limit: 1 });
          setPendingApprovals(result ? result.total : null);
          break;
        case "readiness":
          result = await getProductionAcceptanceReport();
          setReadiness(result);
          break;
        case "activity":
          result = await listPlatformAuditLogs({ limit: 5 });
          setActivity(result ? result.logs || [] : null);
          break;
        default:
          break;
      }
    } catch (e) {
      setSourceErrors((prev) => ({
        ...prev,
        [sourceKey]: e?.message || `Failed to load ${sourceKey}.`,
      }));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const commercialKpis = useMemo(() => {
    if (!commercial) return [];
    const accounts = commercial.accounts?.accounts || [];
    const plans = commercial.plans?.plans || [];
    const subscriptions = commercial.subscriptions?.subscriptions || [];
    const activeSubs = subscriptions.filter((s) => s.status === "active");
    const activePlans = plans.filter((p) => p.status === "active");
    const chargeable = accounts.filter((a) => a.can_charge);
    return [
      {
        title: "Commercial Plans",
        value: commercial.plans?.total ?? plans.length,
        icon: Package,
        href: "/super-admin/commercial/plans",
        subtitle: `${activePlans.length} active`,
        failed: Boolean(sourceErrors.plans),
        retrySource: "plans",
      },
      {
        title: "Commercial Subscriptions",
        value: commercial.subscriptions?.total ?? subscriptions.length,
        icon: UserCheck,
        href: "/super-admin/commercial/subscriptions",
        subtitle: `${activeSubs.length} active`,
        failed: Boolean(sourceErrors.subscriptions),
        retrySource: "subscriptions",
      },
      {
        title: "Chargeable Orgs",
        value: chargeable.length,
        icon: CircleDollarSign,
        href: "/super-admin/organizations",
        subtitle: "May charge commercially",
        failed: Boolean(sourceErrors.accounts),
        retrySource: "accounts",
      },
    ];
  }, [commercial, sourceErrors]);

  if (loading && !platformStats && !commercial) {
    return (
      <div className="p-4 sm:p-6 lg:p-8">
        <PageHeader title="Platform Dashboard" description="Platform-wide organization, commercial, and governance overview." icon={ShieldCheck} />
        <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <DashboardStatCardSkeleton key={i} />
          ))}
        </div>
      </div>
    );
  }

  if (fatalError) {
    return (
      <div className="p-4 sm:p-6 lg:p-8">
        <PageHeader title="Platform Dashboard" description="Platform-wide organization, commercial, and governance overview." icon={ShieldCheck} />
        <div className="mt-6 rounded-3xl border border-slate-200 bg-white">
          <ErrorState message={fatalError} onRetry={load} title="Unable to load the platform dashboard" />
        </div>
      </div>
    );
  }

  const stats = platformStats;
  const suspendedOrganizations = stats ? stats.total_organizations - stats.active_organizations : null;
  const failedSourceCount = Object.values(sourceErrors).filter(Boolean).length;

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader title="Platform Dashboard" description="Platform-wide organization, commercial, and governance overview." icon={ShieldCheck} />

      {failedSourceCount > 0 && (
        <div className="mt-4 flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="alert">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <span className="flex-1">
            {failedSourceCount} data source{failedSourceCount > 1 ? "s" : ""} failed to load. Cards marked
            "Unavailable" are not real zeros — retry to try again.
          </span>
          <button type="button" onClick={load} className="shrink-0 font-semibold underline">Retry</button>
        </div>
      )}

      <div className="mt-6 space-y-8">
        <section>
          <SectionHeading><Building2 size={13} className="text-brand-500" /> Platform Health</SectionHeading>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
            {sourceErrors.platform ? (
              <>
                <DegradedStatCard title="Organizations" icon={Building2} onRetry={() => retrySource("platform")} />
                <DegradedStatCard title="Users" icon={Users} onRetry={() => retrySource("platform")} />
                <DegradedStatCard title="Customers" icon={Users} onRetry={() => retrySource("platform")} />
                <DegradedStatCard title="Invoices" icon={FileText} onRetry={() => retrySource("platform")} />
              </>
            ) : (
              <>
                <DashboardStatCard
                  title="Organizations"
                  value={stats.total_organizations}
                  icon={Building2}
                  href="/super-admin/organizations"
                  subtitle={`${stats.active_organizations} active`}
                />
                <DashboardStatCard
                  title="Users"
                  value={stats.total_users}
                  icon={Users}
                  href="/super-admin/users"
                  subtitle={`${stats.org_admins} org admins · ${stats.billing_admins} billing admins`}
                />
                <DashboardStatCard title="Customers" value={stats.total_customers} icon={Users} />
                <DashboardStatCard title="Invoices" value={stats.total_invoices} icon={FileText} />
              </>
            )}
          </div>
        </section>

        <section>
          <SectionHeading><Package size={13} className="text-brand-500" /> Commercial Health</SectionHeading>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {commercialKpis.map((kpi) =>
              kpi.failed ? (
                <DegradedStatCard key={kpi.title} title={kpi.title} icon={kpi.icon} onRetry={() => retrySource(kpi.retrySource)} />
              ) : (
                <DashboardStatCard key={kpi.title} {...kpi} />
              )
            )}
          </div>
        </section>

        <section>
          <SectionHeading><ShieldCheck size={13} className="text-brand-500" /> Security &amp; Governance</SectionHeading>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-3">
            {sourceErrors.platform ? (
              <DegradedStatCard title="Suspended Organizations" icon={Building2} onRetry={() => retrySource("platform")} />
            ) : (
              <DashboardStatCard
                title="Suspended Organizations"
                value={suspendedOrganizations}
                icon={Building2}
                href="/super-admin/organizations"
                trend={suspendedOrganizations > 0 ? "down" : "neutral"}
                trendValue={suspendedOrganizations > 0 ? "Needs attention" : "None"}
              />
            )}
            {sourceErrors.approvals ? (
              <DegradedStatCard title="Pending Approvals" icon={ClipboardCheck} onRetry={() => retrySource("approvals")} />
            ) : (
              <DashboardStatCard
                title="Pending Approvals"
                value={pendingApprovals ?? 0}
                icon={ClipboardCheck}
                href="/super-admin/approval-queue"
                trend={pendingApprovals > 0 ? "down" : "neutral"}
                trendValue={pendingApprovals > 0 ? "Awaiting review" : "None"}
              />
            )}
            <div
              className="h-full cursor-pointer rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_4px_20px_rgba(0,0,0,0.02)] transition hover:border-brand-200"
              onClick={() => navigate("/super-admin/production-readiness")}
              role="button"
              tabIndex={0}
            >
              <p className="text-xs font-semibold uppercase tracking-wider text-slate-600">Production Readiness</p>
              {sourceErrors.readiness ? (
                <>
                  <h3 className="mt-2 text-xl font-extrabold leading-tight text-amber-800">Unavailable</h3>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); retrySource("readiness"); }}
                    className="mt-2 w-full rounded-xl border border-amber-300 bg-amber-100 px-3 py-1.5 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-200"
                  >
                    Retry
                  </button>
                </>
              ) : (
                <span className={`mt-2 inline-flex rounded-full px-3 py-1 text-sm font-extrabold ${OVERALL_VERDICT_BADGE[readiness?.overall_status] || "bg-slate-100 text-slate-700"}`}>
                  {readiness?.overall_status || "Unknown"}
                </span>
              )}
              <p className="mt-2 text-xs text-slate-500">View full acceptance checklist</p>
            </div>
          </div>
        </section>

        <section>
          <SectionHeading><ScrollText size={13} className="text-brand-500" /> Recent Activity</SectionHeading>
          {sourceErrors.activity ? (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800" role="alert">
              {sourceErrors.activity}
              <button type="button" onClick={() => retrySource("activity")} className="ml-3 font-semibold underline">Retry</button>
            </div>
          ) : (activity || []).length === 0 ? (
            <EmptyState
              icon={ScrollText}
              title="No recent activity"
              message="Organization and commercial plan changes will appear here."
            />
          ) : (
            <DataTable
              columns={[
                { key: "created_at", label: "Timestamp", render: (row) => <span className="whitespace-nowrap text-xs text-slate-500">{formatDateTime(row.created_at)}</span> },
                { key: "actor", label: "Actor", render: (row) => <span className="text-xs font-medium text-slate-700">{row.actor_email || "System"}</span> },
                { key: "action", label: "Action", render: (row) => <AuditActionBadge value={row.action} /> },
                { key: "entity", label: "Entity", render: (row) => <span className="text-xs text-slate-600">{row.entity_type}{row.entity_id ? ` #${row.entity_id}` : ""}</span> },
                { key: "organization", label: "Organization", render: (row) => <span className="text-xs text-slate-600">{row.organization_name || "Platform"}</span> },
              ]}
              data={activity}
              rowKey={(row) => row.id}
              onRowClick={() => navigate("/super-admin/audit-logs")}
              minWidth={720}
            />
          )}
        </section>
      </div>
    </div>
  );
}
