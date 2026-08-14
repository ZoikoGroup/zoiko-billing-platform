import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Building2,
  Package,
  UserCheck,
  ShieldCheck,
  KeyRound,
  ScrollText,
  CircleDollarSign,
  PlayCircle,
  ListChecks,
} from "lucide-react";
import {
  listCommercialAccounts,
  listCommercialPlans,
  listCommercialSubscriptions,
} from "../../service/commercialService";
import {
  DashboardStatCard,
  DashboardStatCardSkeleton,
  ErrorState,
  QuickActions,
  BusinessInsights,
} from "../../components/billing-shared";
import { PageHeader } from "../../components/billing-ui";

export default function CommercialDashboardPage() {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = () => {
    setLoading(true);
    setError(null);
    Promise.all([
      listCommercialAccounts({ limit: 200 }).catch((e) => {
        setError(e?.message || "Failed to load commercial accounts.");
        return null;
      }),
      listCommercialPlans({ limit: 200 }).catch(() => null),
      listCommercialSubscriptions({ limit: 200 }).catch(() => null),
    ])
      .then(([accounts, plans, subscriptions]) => {
        setData({ accounts, plans, subscriptions });
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const kpis = useMemo(() => {
    if (!data) return [];
    const accounts = data.accounts?.accounts || [];
    const plans = data.plans?.plans || [];
    const subscriptions = data.subscriptions?.subscriptions || [];
    const activeSubs = subscriptions.filter((s) => s.status === "active");
    const activePlans = plans.filter((p) => p.status === "active");
    const activeAccounts = accounts.filter((a) => a.status === "active");
    const chargeable = accounts.filter((a) => a.can_charge);
    return [
      {
        title: "Organizations",
        value: data.accounts?.total ?? accounts.length,
        icon: Building2,
        href: "/super-admin/commercial/organizations",
        subtitle: `${activeAccounts.length} active`,
      },
      {
        title: "Commercial Plans",
        value: data.plans?.total ?? plans.length,
        icon: Package,
        href: "/super-admin/commercial/plans",
        subtitle: `${activePlans.length} active · ${plans.filter((p) => p.is_default).length} default`,
      },
      {
        title: "Commercial Subscriptions",
        value: data.subscriptions?.total ?? subscriptions.length,
        icon: UserCheck,
        href: "/super-admin/commercial/subscriptions",
        subtitle: `${activeSubs.length} active`,
      },
      {
        title: "Chargeable Orgs",
        value: chargeable.length,
        icon: CircleDollarSign,
        href: "/super-admin/commercial/organizations",
        subtitle: "Standalone may charge",
      },
    ];
  }, [data]);

  if (loading) {
    return (
      <div className="p-4 sm:p-6 lg:p-8">
        <PageHeader
          title="Commercial Control Center"
          description="Platform-plane commercial management for the standalone billing platform."
          icon={ShieldCheck}
        />
        <div className="mt-6 grid gap-5 grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <DashboardStatCardSkeleton key={i} />
          ))}
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="p-4 sm:p-6 lg:p-8">
        <PageHeader
          title="Commercial Control Center"
          description="Platform-plane commercial management for the standalone billing platform."
          icon={ShieldCheck}
        />
        <div className="mt-6 rounded-3xl border border-slate-200 bg-white">
          <ErrorState message={error} onRetry={load} title="Unable to load the commercial overview" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Commercial Control Center"
        description="Platform-plane commercial management for the standalone billing platform."
        icon={ShieldCheck}
        actions={
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => navigate("/super-admin/commercial/plans")}
              className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-brand-hover"
            >
              <Package size={16} /> Manage Plans
            </button>
            <button
              type="button"
              onClick={() => navigate("/super-admin/commercial/subscriptions")}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
            >
              <UserCheck size={16} /> Manage Subscriptions
            </button>
          </div>
        }
      />

      <div className="mt-6 space-y-6">
        <BusinessInsights
          items={[
            {
              text: "Read-only view — mutations are enforced by the backend service layer.",
              tone: "neutral",
            },
            {
              text: "No pricing values are displayed unless the backend supplies them.",
              tone: "neutral",
            },
            {
              text: "Subscription lifecycle follows the backend state machine.",
              tone: "neutral",
            },
          ]}
        />

        <div className="grid gap-5 grid-cols-1 sm:grid-cols-2 xl:grid-cols-4">
          {kpis.map((kpi) => (
            <DashboardStatCard key={kpi.title} {...kpi} />
          ))}
        </div>

        <QuickActions
          title="Quick Actions"
          actions={[
            { icon: Building2, label: "Organizations", hint: "Review commercial accounts", href: "/super-admin/commercial/organizations" },
            { icon: Package, label: "Commercial Plans", hint: "Create or manage plan templates", href: "/super-admin/commercial/plans" },
            { icon: UserCheck, label: "Subscriptions", hint: "Create or transition subscriptions", href: "/super-admin/commercial/subscriptions" },
            { icon: KeyRound, label: "Entitlements", hint: "View plan limits per organization", href: "/super-admin/commercial/entitlements" },
            { icon: ListChecks, label: "Audit Logs", hint: "Platform audit status", href: "/super-admin/commercial/audit-logs" },
          ]}
        />

        <div className="grid gap-6 md:grid-cols-2">
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
            <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-slate-500">
              <ShieldCheck size={15} className="text-brand-500" /> Commercial plane
            </h2>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              The Commercial Control Center manages the platform-plane commercial
              relationship with organizations: commercial accounts, plan templates,
              subscriptions, entitlements, and the org's billing source /
              classification used for double-charge prevention.
            </p>
            <ul className="mt-4 space-y-2 text-sm text-slate-600">
              <li>· Accounts, plans, and subscriptions are listed with live backend data.</li>
              <li>· Plan and subscription mutations go through the Phase 8 state machine.</li>
              <li>· The catalogue intentionally stays empty — pricing is not invented.</li>
            </ul>
          </div>
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
            <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-wider text-slate-500">
              <ScrollText size={15} className="text-brand-500" /> Audit status
            </h2>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              Commercial subscription mutations are recorded in the org-scoped
              <span className="font-semibold"> billing_audit_logs</span>. A
              platform-wide audit feed and plan-template audit logging are not yet
              available on the backend.
            </p>
            <button
              type="button"
              onClick={() => navigate("/super-admin/commercial/audit-logs")}
              className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-sm font-semibold text-brand-600 transition-colors hover:bg-slate-50"
            >
              <PlayCircle size={15} /> View audit status
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
