import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Layers, RefreshCw, ArrowRight, ShieldAlert } from "lucide-react";

import { getPlatformLifecycle } from "../../service/commercialService";
import { PageHeader, DataTable } from "../../components/billing-ui";
import { ErrorState, StatusBadge } from "../../components/billing-shared";
import {
  LIFECYCLE_STATE_BADGES,
  LifecycleStateBadge,
  ReadinessBadge,
  formatDateTime,
  displayValue,
} from "./constants";

/**
 * ZB-SA-P3 Phase 3C — fleet-wide Lifecycle & Onboarding.
 *
 * Everything rendered here comes from GET /super-admin/platform/lifecycle:
 * per-state organization counts, the PROVISIONING/ONBOARDING pipeline with
 * evidence-based readiness, access-blocked tenants with their latest recorded
 * transition reason, and recent governed transitions. The page never derives
 * operational state client-side and never shows monetary values — tenant
 * financials stay behind privileged access (Domain B).
 */

const READINESS_LABELS = {
  administrator: "Administrator",
  configuration: "Configuration",
  billing: "Billing",
  integration: "Integration",
};

function PipelineCard({ item }) {
  const navigate = useNavigate();
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-slate-800">{item.organization_name}</p>
          <p className="mt-0.5 text-xs text-slate-500">
            {item.organization_code} · registered {formatDateTime(item.registered_at)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <LifecycleStateBadge value={item.state} />
          <button
            type="button"
            onClick={() => navigate(`/super-admin/organizations/${item.id}`)}
            className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-brand-600 transition-colors hover:bg-brand-50"
          >
            Open <ArrowRight size={13} />
          </button>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Onboarding readiness checklist">
        {Object.entries(READINESS_LABELS).map(([key, label]) => (
          <div key={key} className="rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2.5">
            <dt className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{label}</dt>
            <dd className="mt-1.5">
              <ReadinessBadge value={item.onboarding_readiness?.[key]} />
            </dd>
          </div>
        ))}
      </dl>

      {item.blockers?.length > 0 && (
        <ul className="mt-4 space-y-1" aria-label="Open onboarding blockers">
          {item.blockers.map((blocker) => (
            <li key={blocker} className="flex items-start gap-1.5 text-xs text-slate-600">
              <ShieldAlert size={13} className="mt-0.5 shrink-0 text-amber-500" />
              {blocker}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function LifecycleOnboardingPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setError("");
    getPlatformLifecycle()
      .then((payload) => setData(payload))
      .catch((err) => setError(err?.message || "Failed to load platform lifecycle."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const blockedColumns = [
    {
      key: "organization_name",
      label: "Organization",
      render: (row) => (
        <span>
          <span className="block font-medium text-slate-800">{row.organization_name}</span>
          <span className="block text-xs text-slate-500">{row.organization_code}</span>
        </span>
      ),
    },
    { key: "lifecycle_state", label: "State", render: (row) => <LifecycleStateBadge value={row.lifecycle_state} /> },
    {
      key: "last_transition_reason",
      label: "Last Transition Reason",
      render: (row) => displayValue(row.last_transition_reason),
    },
    { key: "last_transition_at", label: "When", render: (row) => formatDateTime(row.last_transition_at), width: 180 },
    {
      key: "actions",
      label: "",
      width: 90,
      render: (row) => <BlockedOrgLink id={row.id} />,
    },
  ];

  const transitionColumns = [
    { key: "created_at", label: "When", render: (row) => formatDateTime(row.created_at), width: 180 },
    {
      key: "organization",
      label: "Organization",
      render: (row) =>
        row.organization_id ? (
          <TransitionOrgLink id={row.organization_id} code={row.organization_code} name={row.organization_name} />
        ) : (
          displayValue(row.organization_name)
        ),
    },
    {
      key: "transition",
      label: "Transition",
      render: (row) => (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <LifecycleStateBadge value={row.from_state} />
          <ArrowRight size={13} className="text-slate-400" />
          <LifecycleStateBadge value={row.to_state} />
        </span>
      ),
    },
    { key: "actor_email", label: "Actor", render: (row) => displayValue(row.actor_email) },
    { key: "reason", label: "Reason", render: (row) => displayValue(row.reason) },
    { key: "correlation_id", label: "Correlation ID", render: (row) => displayValue(row.correlation_id), width: 160 },
  ];

  if (loading && !data) {
    return (
      <div className="p-4 sm:p-6 lg:p-8">
        <PageHeader title="Lifecycle & Onboarding" description="Fleet-wide tenant lifecycle composition and evidence-based onboarding readiness." icon={Layers} />
        <div className="mt-8 flex items-center justify-center py-12">
          <RefreshCw size={24} className="animate-spin text-brand-500" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Lifecycle & Onboarding"
        description={
          <>
            Fleet-wide lifecycle composition, the onboarding pipeline with its evidence-based readiness checklist, and every
            governed transition in the platform audit trail. Tenant financial data stays behind privileged access.
          </>
        }
        icon={Layers}
        meta={data ? `${data.total_organizations} organization(s) · plane ${data.plane}` : ""}
        actions={
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        }
      />

      {error && (
        <div className="mt-6 rounded-2xl border border-red-200 bg-white">
          <ErrorState message={error} onRetry={load} title="Unable to load platform lifecycle" />
        </div>
      )}

      {data && !error && (
        <>
          {/* ── Per-state counts ─────────────────────────────────────── */}
          <section aria-label="Organizations by lifecycle state" className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
            {Object.entries(LIFECYCLE_STATE_BADGES).map(([state, meta]) => (
              <div key={state} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
                <StatusBadge status={state} options={[{ value: state, ...meta }]} />
                <p className="mt-2.5 text-2xl font-extrabold tracking-tight text-slate-900">
                  {data.counts_by_state?.[state] ?? 0}
                </p>
              </div>
            ))}
          </section>

          {/* ── Onboarding pipeline ──────────────────────────────────── */}
          <section aria-label="Onboarding pipeline" className="mt-8">
            <div className="mb-3 flex items-center gap-2 px-1">
              <h2 className="text-sm font-bold uppercase tracking-wider text-slate-600">Onboarding Pipeline</h2>
              <span className="text-xs text-slate-500">
                ({data.onboarding_pipeline.length} organization{data.onboarding_pipeline.length === 1 ? "" : "s"})
              </span>
              <span className="h-px flex-1 bg-slate-200/70" />
            </div>
            {data.onboarding_pipeline.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-slate-200 bg-white px-6 py-8 text-center text-xs text-slate-500">
                No organizations are currently provisioning or onboarding.
              </p>
            ) : (
              <div className="grid gap-4 xl:grid-cols-2">
                {data.onboarding_pipeline.map((item) => (
                  <PipelineCard key={item.id} item={item} />
                ))}
              </div>
            )}
          </section>

          {/* ── Access-blocked tenants ───────────────────────────────── */}
          <section aria-label="Access-blocked organizations" className="mt-8">
            <div className="mb-3 flex items-center gap-2 px-1">
              <h2 className="text-sm font-bold uppercase tracking-wider text-slate-600">Access-Blocked Tenants</h2>
              <span className="h-px flex-1 bg-slate-200/70" />
            </div>
            <DataTable
              columns={blockedColumns}
              data={data.blocked_organizations}
              loading={loading}
              rowKey={(row) => row.id}
              emptyTitle="No blocked tenants"
              emptyMessage="No organizations are currently suspended, deactivating or deactivated."
              minWidth={760}
            />
          </section>

          {/* ── Recent governed transitions ──────────────────────────── */}
          <section aria-label="Recent lifecycle transitions" className="mt-8">
            <div className="mb-3 flex items-center gap-2 px-1">
              <h2 className="text-sm font-bold uppercase tracking-wider text-slate-600">Recent Governed Transitions</h2>
              <span className="h-px flex-1 bg-slate-200/70" />
            </div>
            <DataTable
              columns={transitionColumns}
              data={data.recent_transitions}
              loading={loading}
              rowKey={(row) => row.id}
              emptyTitle="No transitions recorded yet"
              emptyMessage="Governed lifecycle transitions will appear here as they happen."
              minWidth={980}
            />
          </section>
        </>
      )}
    </div>
  );
}

function BlockedOrgLink({ id }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate(`/super-admin/organizations/${id}`)}
      className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-brand-600 transition-colors hover:bg-brand-50"
    >
      Open <ArrowRight size={13} />
    </button>
  );
}

function TransitionOrgLink({ id, code, name }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate(`/super-admin/organizations/${id}`)}
      className="text-left"
      title={`Open ${name || code}`}
    >
      <span className="block font-medium text-brand-600 hover:text-brand-700">{name || code}</span>
      <span className="block text-xs text-slate-500">{code}</span>
    </button>
  );
}
