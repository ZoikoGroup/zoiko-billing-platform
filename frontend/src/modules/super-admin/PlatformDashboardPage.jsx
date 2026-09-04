import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  Clock,
  FileText,
  HelpCircle,
  ShieldAlert,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";
import { BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

import { useCommandCenter } from "../../context/CommandCenterContext";
import {
  listPlatformAuditLogs,
  listApprovalRequests,
  getProductionAcceptanceReport,
  getSaasCommercialReporting,
  listOrganizations,
} from "../../service/commercialService";
import { getTriageSummary, getFinancialOperationsSummary } from "../../service/commandCenterService";
import { Spinner, DashboardChartErrorBoundary } from "../../components/billing-shared";
import CommandCenterContextBar from "../../components/CommandCenterContextBar";

const POLL_INTERVAL_MS = 60000;

export default function PlatformDashboardPage() {
  const navigate = useNavigate();
  const {
    requestRefresh,
    refreshTick,
    periodDateFrom,
    attentionCounts,
    worstFreshness,
  } = useCommandCenter();

  const [triageData, setTriageData] = useState(null);
  const [finops, setFinops] = useState(null);
  const [mrr, setMrr] = useState(null);
  const [approvals, setApprovals] = useState(null);
  const [readiness, setReadiness] = useState(null);
  const [activity, setActivity] = useState(null);
  const [trialOrgs, setTrialOrgs] = useState([]);

  const [sourceErrors, setSourceErrors] = useState({});
  const [loading, setLoading] = useState(true);

  const loadedOnceRef = useRef(false);
  const loadAllRef = useRef(() => {});
  const firstTickRef = useRef(true);

  const loadAll = useCallback(() => {
    if (!loadedOnceRef.current) setLoading(true);
    const nextErrors = {};

    const triagePromise = getTriageSummary().catch((e) => {
      nextErrors.triage = e?.message || "Triage unavailable";
      return null;
    });

    const finopsPromise = getFinancialOperationsSummary().catch((e) => {
      nextErrors.finops = e?.message || "Financial operations unavailable";
      return null;
    });

    const mrrPromise = getSaasCommercialReporting().catch((e) => {
      nextErrors.mrr = e?.message || "Commercial reporting unavailable";
      return null;
    });

    const approvalsPromise = listApprovalRequests({ status: "pending", limit: 200 }).catch((e) => {
      nextErrors.approvals = e?.message || "Approvals unavailable";
      return null;
    });

    const readinessPromise = getProductionAcceptanceReport().catch((e) => {
      nextErrors.readiness = e?.message || "Readiness unavailable";
      return null;
    });

    const activityPromise = listPlatformAuditLogs({ limit: 8, date_from: periodDateFrom }).catch((e) => {
      nextErrors.activity = e?.message || "Activity unavailable";
      return null;
    });

    const orgsPromise = listOrganizations({ skip: 0, limit: 200 }).catch((e) => {
      nextErrors.trialOrgs = e?.message || "Organizations unavailable";
      return null;
    });

    Promise.all([triagePromise, finopsPromise, mrrPromise, approvalsPromise, readinessPromise, activityPromise, orgsPromise]).then(
      ([triage, finopsReport, mrrReport, pendingApprovals, readinessReport, logs, orgsReport]) => {
        setTriageData(triage);
        setFinops(finopsReport);
        setMrr(mrrReport?.mrr ?? null);
        setApprovals(pendingApprovals ? pendingApprovals.requests || [] : null);
        setReadiness(readinessReport);
        setActivity(logs ? logs.logs || [] : null);
        setTrialOrgs(orgsReport ? orgsReport.organizations || [] : []);
        setSourceErrors(nextErrors);
        loadedOnceRef.current = true;
        setLoading(false);
      }
    );
  }, [periodDateFrom]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useEffect(() => {
    loadAllRef.current = loadAll;
  }, [loadAll]);

  useEffect(() => {
    const id = setInterval(requestRefresh, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [requestRefresh]);

  useEffect(() => {
    if (firstTickRef.current) {
      firstTickRef.current = false;
      return;
    }
    loadAllRef.current();
  }, [refreshTick]);

  // ── Derived values (every figure traces to a real backend signal) ──────
  const incidents = triageData?.incidents?.top_items || [];
  const pipeline = triageData?.pipeline_stages || [];
  const controls = triageData?.safety_controls || [];
  const schedulerEnabled = triageData?.scheduler_enabled ?? false;

  const p0 = triageData?.incidents?.counts?.p0 ?? 0;
  const p1 = triageData?.incidents?.counts?.p1 ?? 0;
  const criticalCount = attentionCounts
    ? (attentionCounts.p0 || 0) + (attentionCounts.p1 || 0)
    : p0 + p1;

  const totalInvoices = finops?.billings?.total_invoices ?? 0;
  const overdueCount = finops?.billings?.overdue_count ?? 0;
  const failedPayments = finops?.recovery?.failed_payments_count ?? 0;

  const consistency = finops?.consistency;
  const invoicesChecked = consistency?.total_invoices_checked ?? 0;
  const integrityState =
    consistency?.state === "VERIFIED" && invoicesChecked > 0
      ? "VERIFIED"
      : consistency?.state === "FAILED"
      ? "FAILED"
      : "UNKNOWN";

  const pendingCount = approvals ? approvals.length : null;
  const approvalTypes = {};
  if (approvals) {
    for (const r of approvals) approvalTypes[r.request_type] = (approvalTypes[r.request_type] || 0) + 1;
  }

  const readinessItems = readiness?.items || [];
  const failingCriteria = readinessItems.filter((i) => i.status === "FAIL").length;

  const sourceErrorCount = Object.keys(sourceErrors).length;
  const telemetryStale = worstFreshness === "stale" || worstFreshness === "unknown";

  // Trial Period Overview — remaining trial days per org across the
  // platform (trial_ends_at lives on each org's commercial subscription).
  // Most urgent first; all bars rendered blue.
  const trialChartData = useMemo(() => {
    const data = [];
    for (const row of trialOrgs) {
      if (!row.organization_name || !row.trial_ends_at) continue;
      if (row.subscription_status !== "trialing" && row.subscription_status !== "pending") continue;
      const end = new Date(row.trial_ends_at);
      if (Number.isNaN(end.getTime())) continue;
      const days = Math.max(0, Math.ceil((end.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
      data.push({ org: row.organization_name, days, color: "#3B82F6" });
    }
    return data.sort((a, b) => a.days - b.days);
  }, [trialOrgs]);

  function formatMrr() {
    if (!mrr) return "—";
    if (mrr.state === "unknown") return "UNKNOWN";
    if (mrr.state === "multi_currency") return `${mrr.currencies.length} currencies`;
    const amount = Number(mrr.amount ?? 0);
    return amount.toLocaleString("en-US", {
      style: "currency",
      currency: mrr.currencies[0]?.currency || "USD",
      maximumFractionDigits: 0,
    });
  }

  if (loading) {
    return (
      <div className="flex min-h-64 items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-4">
      {/* Header */}
      <div>
        <h1 className="text-lg font-bold text-slate-900">Command Center</h1>
        <p className="text-[11px] text-slate-500">Zoiko Billing • Financial, commercial, operational and governance health</p>
      </div>

      {/* Filter pills */}
      <CommandCenterContextBar />

      {/* Action Center */}
      <div className="bg-white border border-slate-200 rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-1.5 font-semibold text-slate-800 text-xs">
            {criticalCount > 0 || overdueCount > 0 || failedPayments > 0 ? (
              <AlertTriangle className="w-4 h-4 text-amber-500" />
            ) : (
              <CheckCircle2 className="w-4 h-4 text-emerald-500" />
            )}
            <span>Action Center</span>
          </div>
          <span className="text-[10px] text-slate-400">Live · auto-refreshes every minute</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <ActionCard
            severity={criticalCount > 0 ? "HIGH" : "CLEAR"}
            severityClass={
              criticalCount > 0
                ? "bg-red-50 text-red-600 border-red-200"
                : "bg-emerald-50 text-emerald-600 border-emerald-200"
            }
            title={
              criticalCount > 0
                ? `${criticalCount} critical attention item${criticalCount > 1 ? "s" : ""} open`
                : "No P0/P1 attention items open"
            }
            amount={attentionCounts?.sla_breaches > 0 ? `${attentionCounts.sla_breaches} SLA breach${attentionCounts.sla_breaches > 1 ? "es" : ""}` : undefined}
            actionText="Review"
            onAction={() => navigate("/super-admin/triage")}
          />
          <ActionCard
            severity={overdueCount > 0 ? "HIGH" : "CLEAR"}
            severityClass={
              overdueCount > 0
                ? "bg-red-50 text-red-600 border-red-200"
                : "bg-emerald-50 text-emerald-600 border-emerald-200"
            }
            title={
              overdueCount > 0
                ? `${overdueCount} invoice${overdueCount > 1 ? "s" : ""} overdue`
                : "No overdue invoices"
            }
            subtitle={`${totalInvoices.toLocaleString()} invoices issued to date`}
            actionText="Review"
            onAction={() => navigate("/super-admin/financial-operations")}
          />
          <ActionCard
            severity={failedPayments > 0 ? "MED" : "CLEAR"}
            severityClass={
              failedPayments > 0
                ? "bg-amber-50 text-amber-600 border-amber-200"
                : "bg-emerald-50 text-emerald-600 border-emerald-200"
            }
            title={
              failedPayments > 0
                ? `${failedPayments} failed payment${failedPayments > 1 ? "s" : ""} require action`
                : "No failed payments awaiting recovery"
            }
            subtitle={`Dunning: ${finops?.recovery?.dunning_cycle_status || "NOT CONFIGURED"}`}
            actionText="Resolve"
            onAction={() => navigate("/super-admin/financial-operations")}
          />
          <ActionCard
            severity={(pendingCount ?? 0) > 0 ? "MED" : "CLEAR"}
            severityClass={
              (pendingCount ?? 0) > 0
                ? "bg-amber-50 text-amber-600 border-amber-200"
                : "bg-emerald-50 text-emerald-600 border-emerald-200"
            }
            title={
              (pendingCount ?? 0) > 0
                ? `${pendingCount} maker-checker request${pendingCount > 1 ? "s" : ""} pending`
                : "Approval queue is clear"
            }
            subtitle={pendingCount > 0 ? "A second Super Admin must decide each request" : undefined}
            actionText="Review"
            onAction={() => navigate("/super-admin/approval-queue")}
          />
        </div>
        {sourceErrorCount > 0 && (
          <p className="mt-3 flex items-center gap-1.5 text-[11px] text-amber-700">
            <AlertTriangle size={12} /> {sourceErrorCount} data source{sourceErrorCount > 1 ? "s" : ""} unreachable — affected figures show last-known or zero values.
          </p>
        )}
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <MetricCard
          icon={<TrendingUp className="w-4 h-4 text-brand-600" />}
          iconBg="bg-brand-50"
          title="Commercial Run Rate"
          value={formatMrr()}
          subtitle={
            mrr?.state === "computed"
              ? "Monthly-normalized published prices"
              : "Priced catalog versions only"
          }
        />
        <MetricCard
          icon={<FileText className="w-4 h-4 text-blue-600" />}
          iconBg="bg-blue-50"
          title="Invoices Issued"
          value={totalInvoices.toLocaleString()}
          subtitle="Platform-wide via billing read models"
        />
        <MetricCard
          icon={<Clock className="w-4 h-4 text-amber-600" />}
          iconBg="bg-amber-50"
          title="Overdue Invoices"
          value={overdueCount.toLocaleString()}
          subtitle={overdueCount > 0 ? "Requires collections follow-up" : "All issued invoices current"}
          valueClass={overdueCount > 0 ? "text-red-600" : "text-slate-900"}
        />
        <MetricCard
          icon={
            integrityState === "VERIFIED" ? (
              <ShieldCheck className="w-4 h-4 text-emerald-600" />
            ) : integrityState === "FAILED" ? (
              <ShieldAlert className="w-4 h-4 text-red-600" />
            ) : (
              <HelpCircle className="w-4 h-4 text-amber-600" />
            )
          }
          iconBg={integrityState === "VERIFIED" ? "bg-emerald-50" : "bg-amber-50"}
          title="Ledger Integrity"
          value={integrityState}
          subtitle={`${invoicesChecked.toLocaleString()} invoices checked · ${consistency?.over_allocated_count ?? 0} over-allocated`}
          valueClass={
            integrityState === "VERIFIED"
              ? "text-emerald-600"
              : integrityState === "FAILED"
              ? "text-red-600"
              : "text-amber-600"
          }
        />
      </div>

      {/* Trial Period Overview */}
      {trialChartData.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="font-semibold text-slate-800 text-xs">Trial Period Overview</div>
            <span className="text-[11px] text-slate-400">{trialChartData.length} org(s) on trial</span>
          </div>
          <div className="h-64 w-full" aria-label="Remaining trial days per organization">
            <DashboardChartErrorBoundary>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={trialChartData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
                  <XAxis dataKey="org" tick={{ fontSize: 11, fill: "#64748B" }} interval={0} angle={-25} textAnchor="end" height={56} />
                  <YAxis tick={{ fontSize: 11, fill: "#64748B" }} allowDecimals={false} />
                  <Tooltip formatter={(value) => [`${value} day(s)`, "Trial remaining"]} />
                  <Bar dataKey="days" radius={[6, 6, 0, 0]}>
                    {trialChartData.map((d, i) => (
                      <Cell key={i} fill={d.color} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </DashboardChartErrorBoundary>
          </div>
        </div>
      )}

      {/* Pipeline & Safety Controls */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="font-semibold text-slate-800 text-xs">Processing Pipeline</div>
            <span className="text-[11px] font-medium text-slate-500">
              {schedulerEnabled ? "Scheduler Active" : "Scheduler Disabled"}
            </span>
          </div>
          {pipeline.length === 0 ? (
            <div className="py-8 text-center text-xs text-slate-500">
              <HelpCircle size={22} className="mx-auto text-slate-300 mb-1" />
              Pipeline status UNKNOWN — awaiting background telemetry runs.
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
              {pipeline.slice(0, 8).map((stage) => {
                const isStale = stage.freshness === "stale" || stage.freshness === "unknown";
                const hasFailed = stage.last_status === "failed" || (stage.failure_count_24h || 0) > 0;
                return (
                  <div key={stage.job_name} className="border border-slate-100 rounded-lg p-2.5 bg-slate-50/60 text-center">
                    <span className="block text-[11px] font-medium text-slate-600 truncate" title={stage.job_name}>
                      {stage.display_name || stage.job_name}
                    </span>
                    <span className="mt-0.5 block text-lg font-bold text-slate-900">{stage.run_count_24h ?? 0}</span>
                    <span className="block text-[10px] text-slate-400 mb-1">runs / 24h</span>
                    {isStale ? (
                      <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-amber-700">
                        <HelpCircle size={10} /> STALE
                      </span>
                    ) : hasFailed ? (
                      <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-red-600">
                        <AlertTriangle size={10} /> {stage.failure_count_24h} FAILED
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-emerald-600">
                        <CheckCircle2 size={10} /> HEALTHY
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-lg p-4 flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <div className="font-semibold text-slate-800 text-xs">Safety Controls</div>
            <button
              type="button"
              onClick={() => navigate("/super-admin/kill-switch")}
              className="text-[11px] font-medium text-brand-600 hover:underline inline-flex items-center gap-0.5"
            >
              Manage <ChevronRight size={12} />
            </button>
          </div>
          <div className="space-y-2 flex-1">
            {controls.length === 0 ? (
              <p className="py-6 text-center text-xs text-slate-500">No circuit breakers loaded.</p>
            ) : (
              controls.slice(0, 5).map((c) => (
                <div key={c.scope} className="flex items-center justify-between border border-slate-100 rounded-lg px-3 py-2 bg-slate-50/60 text-xs">
                  <div className="min-w-0">
                    <span className="font-medium text-slate-700 truncate block">{c.display_name}</span>
                    {c.expires_at && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-700">
                        <Clock size={10} /> auto-expires{" "}
                        {new Date(c.expires_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    )}
                  </div>
                  <span
                    className={`shrink-0 ml-2 rounded-full px-2 py-0.5 text-[10px] font-bold ${
                      c.enabled ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"
                    }`}
                  >
                    {c.enabled ? "ENGAGED" : "OPEN"}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Attention queue & Approval queue */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-lg p-4">
          <div className="font-semibold text-slate-800 text-xs mb-3">Attention Queue</div>
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="text-slate-400 text-[10px] uppercase border-b border-slate-100">
                <th scope="col" className="pb-2 font-medium">Severity</th>
                <th scope="col" className="pb-2 font-medium">Item</th>
                <th scope="col" className="pb-2 font-medium">Detail</th>
                <th scope="col" className="pb-2 font-medium text-right"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {incidents.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-6 text-center text-xs text-slate-500">
                    <CheckCircle2 size={18} className="mx-auto text-emerald-500 mb-1" />
                    No active incidents. All monitored signals within tolerance.
                  </td>
                </tr>
              ) : (
                incidents.slice(0, 5).map((item) => (
                  <tr key={item.id} className="text-xs">
                    <td className="py-2">
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                          item.severity === "P0"
                            ? "bg-red-100 text-red-700"
                            : item.severity === "P1"
                            ? "bg-red-50 text-red-600"
                            : "bg-amber-100 text-amber-700"
                        }`}
                      >
                        {item.severity}
                      </span>
                    </td>
                    <td className="py-2 font-medium text-slate-800">{item.title}</td>
                    <td className="py-2 text-slate-500 truncate max-w-[220px]">{item.description}</td>
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        onClick={() => navigate("/super-admin/triage")}
                        className="text-brand-600 hover:underline text-[11px] font-medium"
                      >
                        Inspect
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <div className="mt-3 text-center border-t border-slate-100 pt-2">
            <button
              type="button"
              onClick={() => navigate("/super-admin/triage")}
              className="text-brand-600 font-medium text-[11px] inline-flex items-center gap-1 hover:underline"
            >
              View full triage board <ArrowRight size={12} />
            </button>
          </div>
        </div>

        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-lg p-4 flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <div className="font-semibold text-slate-800 text-xs">Approval Queue</div>
            <button
              type="button"
              onClick={() => navigate("/super-admin/approval-queue")}
              className="text-[11px] font-medium text-brand-600 hover:underline inline-flex items-center gap-0.5"
            >
              Open <ChevronRight size={12} />
            </button>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2.5 mb-3">
            <span className="text-xs text-slate-600">Pending requests</span>
            <span className={`text-sm font-bold ${(pendingCount ?? 0) > 0 ? "text-amber-700" : "text-emerald-600"}`}>
              {pendingCount ?? "—"}
            </span>
          </div>
          <div className="space-y-2 flex-1">
            {Object.keys(approvalTypes).length === 0 ? (
              <p className="py-4 text-center text-xs text-slate-500">No request types waiting on a checker decision.</p>
            ) : (
              Object.entries(approvalTypes).map(([type, count]) => (
                <div key={type} className="flex items-center justify-between text-xs border-b border-slate-50 pb-1.5">
                  <span className="text-slate-600 capitalize">{type.replace(/_/g, " ")}</span>
                  <span className="font-semibold text-slate-800">{count}</span>
                </div>
              ))
            )}
          </div>
          {(pendingCount ?? 0) > 0 && (
            <p className="mt-3 flex items-start gap-1.5 rounded-lg border border-amber-100 bg-amber-50 px-2.5 py-2 text-[10px] text-amber-700">
              <ShieldAlert size={12} className="mt-0.5 shrink-0" />
              Self-approval is blocked server-side. A second Super Admin must decide.
            </p>
          )}
        </div>
      </div>

      {/* Production gate & Recent activity */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-lg p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="font-semibold text-slate-800 text-xs">Production Gate</div>
            <button
              type="button"
              onClick={() => navigate("/super-admin/production-readiness")}
              className="text-[11px] font-medium text-brand-600 hover:underline inline-flex items-center gap-0.5"
            >
              Checklist <ChevronRight size={12} />
            </button>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2.5">
            <div>
              <span className="text-[10px] font-medium uppercase tracking-wider text-slate-500">Table 13 verdict</span>
              <p
                className={`mt-0.5 text-base font-bold ${
                  readiness?.overall_status === "BLOCKED"
                    ? "text-red-600"
                    : readiness?.overall_status === "READY"
                    ? "text-emerald-600"
                    : "text-slate-900"
                }`}
              >
                {readiness?.overall_status || "UNKNOWN"}
              </p>
            </div>
            <div className="text-right">
              <span className="text-[10px] font-medium uppercase tracking-wider text-slate-500">Failing criteria</span>
              <p className={`mt-0.5 text-base font-bold ${failingCriteria > 0 ? "text-red-600" : "text-slate-900"}`}>
                {failingCriteria}
                <span className="text-xs text-slate-400 font-medium"> / {readinessItems.length || 18}</span>
              </p>
            </div>
          </div>
          {readiness?.overall_status === "BLOCKED" && (
            <p className="mt-3 flex items-center gap-1.5 rounded-lg border border-red-100 bg-red-50 px-2.5 py-2 text-[11px] text-red-700">
              <ShieldAlert size={12} /> Release gate BLOCKED — review failing criteria before proceeding.
            </p>
          )}
        </div>

        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-lg p-4 flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <div className="font-semibold text-slate-800 text-xs">Recent Activity</div>
            <span className="text-[10px] text-slate-400">{periodDateFrom} → today</span>
          </div>
          <div className="space-y-2.5 flex-1">
            {!activity || activity.length === 0 ? (
              <p className="py-4 text-center text-xs text-slate-500">No platform events in the selected period.</p>
            ) : (
              activity.slice(0, 6).map((log) => (
                <div key={log.id} className="flex items-start justify-between text-xs gap-2">
                  <div className="flex items-start gap-2 min-w-0">
                    <FileText size={13} className="mt-0.5 shrink-0 text-brand-500" />
                    <div className="min-w-0">
                      <span className="font-medium text-slate-700">{String(log.action).toLowerCase()}</span>
                      <span className="text-slate-500"> on {log.entity_type}</span>
                      {log.actor_email && (
                        <span className="block text-[10px] text-slate-400 truncate">by {log.actor_email}</span>
                      )}
                    </div>
                  </div>
                  <span className="shrink-0 text-[10px] text-slate-400">
                    {new Date(log.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              ))
            )}
          </div>
          <div className="mt-3 text-center border-t border-slate-100 pt-2">
            <button
              type="button"
              onClick={() => navigate("/super-admin/audit-logs")}
              className="text-brand-600 font-medium text-[11px] inline-flex items-center gap-1 hover:underline"
            >
              View all activity <ArrowRight size={12} />
            </button>
          </div>
        </div>
      </div>

      {/* System status strip */}
      <div className="bg-white border border-slate-200 rounded-lg px-4 py-3 flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-semibold text-slate-800">System Status</span>
        {sourceErrorCount > 0 ? (
          <span className="inline-flex items-center gap-1.5 font-bold text-amber-700" title={`${sourceErrorCount} dashboard source(s) returned errors on the last load.`}>
            <AlertTriangle size={13} /> Partial visibility — {sourceErrorCount} source{sourceErrorCount > 1 ? "s" : ""} unreachable
          </span>
        ) : telemetryStale ? (
          <span className="inline-flex items-center gap-1.5 font-bold text-amber-700" title="Core queries succeeded, but background job freshness is stale or unknown.">
            <AlertTriangle size={13} /> Operational — background telemetry stale
          </span>
        ) : (
          <span className="inline-flex items-center gap-1.5 font-bold text-emerald-700" title="Monitored signals healthy. See Reliability lens for per-subsystem coverage.">
            <CheckCircle2 size={13} /> Operational · monitored checks passing
          </span>
        )}
        <span className="text-[10px] text-slate-400">
          Payments engine not deployed (REC-01) — collection dollar totals are not computable and are never shown.
        </span>
      </div>
    </div>
  );
}

function ActionCard({ severity, severityClass, title, amount, subtitle, actionText, onAction }) {
  return (
    <div className="border border-slate-100 rounded-lg p-3 bg-slate-50/50 flex flex-col justify-between">
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded border ${severityClass}`}>{severity}</span>
        </div>
        <p className="text-slate-700 font-medium leading-snug text-xs">{title}</p>
        {amount && <div className="text-red-600 font-bold text-sm mt-1">{amount}</div>}
        {subtitle && <div className="text-[10px] text-slate-400 mt-1">{subtitle}</div>}
      </div>
      <button
        type="button"
        onClick={onAction}
        className="text-brand-600 font-medium text-[11px] text-left mt-3 inline-flex items-center gap-0.5 hover:underline"
      >
        {actionText} <ChevronRight className="w-3 h-3" />
      </button>
    </div>
  );
}

function MetricCard({ icon, iconBg, title, value, subtitle, valueClass = "text-slate-900" }) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-3.5">
      <div className="flex items-center gap-2 mb-1">
        <div className={`p-1.5 rounded-md ${iconBg}`}>{icon}</div>
        <span className="text-slate-500 font-medium text-xs">{title}</span>
      </div>
      <div className={`text-xl font-bold mt-1 ${valueClass}`}>{value}</div>
      <div className="text-[10px] text-slate-400 mt-0.5">{subtitle}</div>
    </div>
  );
}
