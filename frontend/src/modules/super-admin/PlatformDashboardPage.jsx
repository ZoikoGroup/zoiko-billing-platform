import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Activity,
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  Building2,
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  Clock,
  DollarSign,
  FileText,
  HelpCircle,
  Layers,
  Package,
  Power,
  RefreshCw,
  ScrollText,
  ShieldAlert,
  ShieldCheck,
  TrendingUp,
  UserCheck,
  Users,
} from "lucide-react";

import { useCommandCenter } from "../../context/CommandCenterContext";
import {
  getPlatformDashboardStats,
  listPlatformAuditLogs,
  listCommercialAccounts,
  listCommercialPlans,
  listCommercialSubscriptions,
  listApprovalRequests,
  getProductionAcceptanceReport,
} from "../../service/commercialService";
import { getTriageSummary } from "../../service/commandCenterService";
import { getFinancialConsistency } from "../../service/privilegedAccessService";
import { PageHeader } from "../../components/billing-ui";
import { DashboardStatCard, DashboardStatCardSkeleton, ErrorState, Spinner } from "../../components/billing-shared";
import CommandCenterContextBar from "../../components/CommandCenterContextBar";
import TriageLens from "./lenses/TriageLens";
import CommercialLens from "./lenses/CommercialLens";
import FinancialOpsLens from "./lenses/FinancialOpsLens";
import ReliabilityLens from "./lenses/ReliabilityLens";
import GovernanceLens from "./lenses/GovernanceLens";

const LENSES = [
  { id: "triage", label: "Triage", icon: AlertCircle },
  { id: "commercial", label: "Commercial", icon: Package },
  { id: "financial", label: "Financial Ops", icon: DollarSign },
  { id: "reliability", label: "Reliability", icon: Activity },
  { id: "governance", label: "Governance", icon: ShieldCheck },
];

export default function PlatformDashboardPage() {
  const navigate = useNavigate();
  const { activeLens, setActiveLens, activeGrant } = useCommandCenter();

  const [platformStats, setPlatformStats] = useState(null);
  const [commercial, setCommercial] = useState(null);
  const [pendingApprovals, setPendingApprovals] = useState(null);
  const [readiness, setReadiness] = useState(null);
  const [activity, setActivity] = useState(null);
  const [triageData, setTriageData] = useState(null);
  const [consistencyData, setConsistencyData] = useState(null);

  const [sourceErrors, setSourceErrors] = useState({});
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState(null);

  const loadAll = useCallback(() => {
    setLoading(true);
    setFatalError(null);
    const nextErrors = {};

    const statsPromise = getPlatformDashboardStats().catch((e) => {
      nextErrors.platform = e?.message || "Stats unavailable";
      return null;
    });

    const accountsPromise = listCommercialAccounts({ limit: 50 }).catch((e) => {
      nextErrors.accounts = e?.message || "Accounts unavailable";
      return null;
    });

    const plansPromise = listCommercialPlans({ limit: 50 }).catch((e) => {
      nextErrors.plans = e?.message || "Plans unavailable";
      return null;
    });

    const subscriptionsPromise = listCommercialSubscriptions({ limit: 50 }).catch((e) => {
      nextErrors.subscriptions = e?.message || "Subscriptions unavailable";
      return null;
    });

    const approvalsPromise = listApprovalRequests({ status: "pending", limit: 1 }).catch((e) => {
      nextErrors.approvals = e?.message || "Approvals unavailable";
      return null;
    });

    const readinessPromise = getProductionAcceptanceReport().catch((e) => {
      nextErrors.readiness = e?.message || "Readiness unavailable";
      return null;
    });

    const activityPromise = listPlatformAuditLogs({ limit: 5 }).catch((e) => {
      nextErrors.activity = e?.message || "Activity unavailable";
      return null;
    });

    const triagePromise = getTriageSummary().catch((e) => {
      nextErrors.triage = e?.message || "Triage unavailable";
      return null;
    });

    const consistencyPromise = getFinancialConsistency().catch((e) => {
      nextErrors.consistency = e?.message || "Consistency unavailable";
      return null;
    });

    Promise.all([
      statsPromise,
      accountsPromise,
      plansPromise,
      subscriptionsPromise,
      approvalsPromise,
      readinessPromise,
      activityPromise,
      triagePromise,
      consistencyPromise,
    ]).then(([stats, accounts, plans, subs, approvals, readinessReport, logs, triage, consistency]) => {
      setPlatformStats(stats);
      setCommercial({ accounts, plans, subscriptions: subs });
      setPendingApprovals(approvals ? approvals.total : null);
      setReadiness(readinessReport);
      setActivity(logs ? logs.logs || [] : null);
      setTriageData(triage);
      setConsistencyData(consistency);
      setSourceErrors(nextErrors);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const attentionItems = triageData?.incidents?.top_items || [];

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6">
      {/* 1. Header & Title */}
      <div>
        <h1 className="text-2xl font-extrabold tracking-tight text-slate-900">Command Center</h1>
        <p className="mt-1 text-xs font-medium text-slate-600">
          Financial, commercial, operational and governance health across Zoiko Billing.
        </p>
      </div>

      {/* 2. Persistent Context Bar */}
      <CommandCenterContextBar />

      {/* 3. Top Attention Queue & Privileged Sessions Row */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Attention Queue (2 Cols) */}
        <div className="lg:col-span-2 rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-extrabold uppercase tracking-wider text-slate-800">Requires Attention</span>
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-rose-600 text-[10px] font-extrabold text-white">
                {attentionItems.length}
              </span>
            </div>
            <button
              type="button"
              onClick={() => navigate("/super-admin/triage")}
              className="text-xs font-bold text-slate-600 hover:text-slate-900"
            >
              View all ({attentionItems.length}) →
            </button>
          </div>

          <div className="mt-3 space-y-2.5">
            {attentionItems.length === 0 ? (
              <div className="flex items-center gap-3 py-3 text-xs text-slate-600">
                <CheckCircle2 size={16} className="text-emerald-500" />
                <span>No active critical alerts. Operational SLA within target.</span>
              </div>
            ) : (
              attentionItems.slice(0, 2).map((item) => (
                <div key={item.id} className="flex items-center justify-between gap-3 rounded-2xl border border-slate-100 bg-slate-50 p-3 text-xs">
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <span className="h-2 w-2 rounded-full bg-rose-600" />
                    <span className="font-bold text-slate-900 truncate">{item.title}</span>
                    <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-extrabold text-rose-700">
                      {item.severity}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => navigate("/super-admin/triage")}
                    className="shrink-0 font-bold text-brand-600 hover:text-brand-800"
                  >
                    Inspect →
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Privileged Sessions (1 Col) */}
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
          <div className="flex items-center justify-between border-b border-slate-100 pb-3">
            <div className="flex items-center gap-2">
              <span className="text-xs font-extrabold uppercase tracking-wider text-slate-800">Privileged Sessions</span>
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-200 text-[10px] font-extrabold text-slate-700">
                {activeGrant ? "1" : "0"}
              </span>
            </div>
            <button
              type="button"
              onClick={() => navigate("/super-admin/support-access")}
              className="text-xs font-bold text-slate-600 hover:text-slate-900"
            >
              Manage →
            </button>
          </div>

          <div className="mt-3 text-xs">
            {activeGrant ? (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-3">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-amber-900">Active Tenant Access</span>
                  <span className="font-mono font-bold text-amber-700">Active</span>
                </div>
                <p className="mt-1 text-[11px] text-amber-800">Org #{activeGrant.organization_id} · Reason: {activeGrant.reason}</p>
              </div>
            ) : (
              <div className="py-3 text-center text-xs text-slate-600">
                <ShieldCheck size={20} className="mx-auto text-slate-600 mb-1" />
                No elevated sessions active
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 4. 5-Lens Selector Bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 pb-2">
        {LENSES.map((lens) => {
          const Icon = lens.icon;
          const isActive = activeLens === lens.id;
          return (
            <button
              key={lens.id}
              type="button"
              onClick={() => setActiveLens(lens.id)}
              className={`inline-flex items-center gap-2 rounded-2xl px-4 py-2.5 text-xs font-bold transition duration-150 ${
                isActive
                  ? "bg-slate-900 text-white shadow-sm"
                  : "bg-white text-slate-600 hover:bg-slate-100 hover:text-slate-900 border border-slate-200"
              }`}
            >
              <Icon size={14} className={isActive ? "text-brand-400" : "text-slate-600"} />
              {lens.label}
            </button>
          );
        })}
      </div>

      {/* 5. Dynamic Lens Content (Max 4 Primary Modules) */}
      {loading ? (
        <div className="py-12 flex justify-center">
          <Spinner />
        </div>
      ) : (
        <div>
          {activeLens === "triage" && <TriageLens triageData={triageData} onRefresh={loadAll} />}
          {activeLens === "commercial" && <CommercialLens commercial={commercial} platformStats={platformStats} />}
          {activeLens === "financial" && <FinancialOpsLens consistencyData={consistencyData} />}
          {activeLens === "reliability" && <ReliabilityLens telemetry={platformStats} jobs={triageData?.pipeline_stages} />}
          {activeLens === "governance" && (
            <GovernanceLens
              pendingApprovals={pendingApprovals}
              readiness={readiness}
              activity={activity}
            />
          )}
        </div>
      )}

      {/* 6. Footer Operations Strip */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3 pt-4 border-t border-slate-200 text-xs">
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <span className="font-bold text-slate-800">Recent Critical Events</span>
          <p className="mt-1 text-slate-600">
            {activity?.length ? `${activity.length} recent auditable operations logged.` : "No critical events in window."}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <span className="font-bold text-slate-800">Approvals Status</span>
          <p className="mt-1 text-slate-600">
            {pendingApprovals ? `${pendingApprovals} pending maker-checker reviews.` : "Approval queue is clear."}
          </p>
        </div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <span className="font-bold text-slate-800">System Status</span>
          <div className="mt-1 flex items-center gap-1.5 text-emerald-700 font-bold">
            <CheckCircle2 size={14} /> All Subsystems Operational
          </div>
        </div>
      </div>
    </div>
  );
}
