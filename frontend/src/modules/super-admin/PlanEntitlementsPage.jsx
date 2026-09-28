import React, { useCallback, useEffect, useMemo, useState } from "react";
import { KeySquare, Package } from "lucide-react";
import {
  listCommercialPlans,
  listCommercialPlanVersions,
  listPlanVersionEntitlements,
} from "../../service/commercialService";
import { PageHeader, SectionCard, DataTable, Select } from "../../components/billing-ui";
import { StatusBadge, ErrorState, Spinner, EmptyState } from "../../components/billing-shared";
import {
  CATALOG_VERSION_STATUS_OPTIONS,
  EntitlementEnforcementBadge,
  EntitlementRiskBadge,
  EntitlementValueTypeBadge,
  displayValue,
  formatEntitlementValue,
} from "./constants";

// `embedded` drops this page's own PageHeader when it is mounted as a tab of
// the Products & Pricing hub.
export default function PlanEntitlementsPage({ embedded = false } = {}) {
  const [plans, setPlans] = useState([]);
  const [versions, setVersions] = useState([]);
  const [selectedPlanId, setSelectedPlanId] = useState("");
  const [versionId, setVersionId] = useState("");
  const [entitlements, setEntitlements] = useState([]);
  const [loading, setLoading] = useState(true);
  const [versionLoading, setVersionLoading] = useState(false);
  const [error, setError] = useState(null);

  // Which of the three cascading fetches (plan list / versions-for-plan /
  // entitlements-for-version) last failed, so Retry re-runs that one fetch
  // instead of just clearing the message. Bumping the matching nonce below
  // re-triggers only that effect without disturbing the operator's selection.
  const [errorStage, setErrorStage] = useState(null);
  const [plansRetry, setPlansRetry] = useState(0);
  const [versionsRetry, setVersionsRetry] = useState(0);
  const [entitlementsRetry, setEntitlementsRetry] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    listCommercialPlans({ limit: 200 })
      .then((data) => {
        if (!alive) return;
        const plans = data.plans || [];
        setPlans(plans);
        if (plans.length === 1) setSelectedPlanId(String(plans[0].id));
      })
      .catch((err) => {
        if (!alive) return;
        setError(err?.message || "Failed to load plans.");
        setErrorStage("plans");
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [plansRetry]);

  // Whenever the plan changes, load its versions and reset the version picker.
  useEffect(() => {
    let alive = true;
    if (!selectedPlanId) {
      setVersions([]);
      setVersionId("");
      setEntitlements([]);
      return () => {
        alive = false;
      };
    }
    setVersionLoading(true);
    setEntitlements([]);
    setError((prev) => (errorStage === "versions" || errorStage === "entitlements" ? null : prev));
    listCommercialPlanVersions(Number(selectedPlanId))
      .then((data) => {
        if (!alive) return;
        const versions = data.versions || [];
        setVersions(versions);
        const preferred =
          versions.find((v) => v.status === "published") || versions[0];
        setVersionId(preferred ? String(preferred.id) : "");
        setErrorStage((prev) => (prev === "versions" ? null : prev));
      })
      .catch((err) => {
        if (!alive) return;
        setError(err?.message || "Failed to load versions.");
        setErrorStage("versions");
      })
      .finally(() => alive && setVersionLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedPlanId, versionsRetry]);

  useEffect(() => {
    let alive = true;
    if (!versionId) {
      setEntitlements([]);
      return () => {
        alive = false;
      };
    }
    setEntitlements([]);
    setError((prev) => (errorStage === "entitlements" ? null : prev));
    listPlanVersionEntitlements(Number(versionId))
      .then((data) => {
        if (!alive) return;
        setEntitlements(data.entitlements || []);
        setErrorStage((prev) => (prev === "entitlements" ? null : prev));
      })
      .catch((err) => {
        if (!alive) return;
        setError(err?.message || "Failed to load entitlements.");
        setErrorStage("entitlements");
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versionId, entitlementsRetry]);

  const retry = useCallback(() => {
    if (errorStage === "plans") setPlansRetry((n) => n + 1);
    else if (errorStage === "versions") setVersionsRetry((n) => n + 1);
    else if (errorStage === "entitlements") setEntitlementsRetry((n) => n + 1);
    else setError(null);
  }, [errorStage]);

  const selectedVersion = useMemo(
    () => versions.find((v) => String(v.id) === versionId),
    [versions, versionId]
  );

  const columns = useMemo(
    () => [
      {
        key: "key",
        label: "Entitlement Key",
        render: (row) => (
          <span className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
              <KeySquare size={16} />
            </span>
            <span className="font-mono text-xs font-semibold text-slate-800">{row.key}</span>
          </span>
        ),
      },
      {
        key: "value_type",
        label: "Value Type",
        render: (row) => <EntitlementValueTypeBadge value={row.value_type} />,
      },
      {
        key: "risk",
        label: "Risk",
        render: (row) => <EntitlementRiskBadge value={row.risk_classification} />,
      },
      {
        key: "enforcement",
        label: "Enforcement",
        render: (row) => <EntitlementEnforcementBadge value={row.enforcement_type} />,
      },
      {
        key: "value",
        label: "Value",
        render: (row) => {
          const text = formatEntitlementValue(row.value, row.value_type, row.is_contracted);
          const tone =
            row.is_contracted
              ? "text-violet-700"
              : row.value === null || row.value === undefined
                ? "text-slate-400"
                : "text-slate-700";
          return (
            <span className="text-xs font-medium">
              <span className={`block ${tone}`}>{text}</span>
              {row.is_contracted && <span className="block text-[10px] text-violet-400">order form</span>}
            </span>
          );
        },
      },
    ],
    []
  );

  return (
    <div className={embedded ? "" : "p-4 sm:p-6 lg:p-8"}>
      <PageHeader
        embedded={embedded}
        accent="violet"
        title="Plan Entitlements"
        description="ZB-COM-ENT-001 · Part 1 · read-only per-plan-version entitlement matrix (§13). Pick a plan and version to inspect its typed entitlement snapshot."
        icon={KeySquare}
        meta={selectedVersion ? `v${selectedVersion.version_number} · ${selectedVersion.status}` : null}
      />

      <div className={`space-y-4 ${embedded ? "" : "mt-6"}`}>
        <div className="flex flex-wrap items-start gap-4">
          <div className="w-full max-w-sm">
            <label className="mb-1 block text-xs font-semibold text-slate-600" htmlFor="pe-plan">
              Commercial Plan
            </label>
            <Select
              id="pe-plan"
              value={selectedPlanId}
              onChange={setSelectedPlanId}
              options={plans.map((p) => ({
                value: String(p.id),
                label: `${p.plan_name} (${p.plan_code}) — ${p.status}`,
              }))}
              placeholder="Select plan…"
            />
          </div>
          <div className="w-full max-w-sm">
            <label className="mb-1 block text-xs font-semibold text-slate-600" htmlFor="pe-version">
              Version
            </label>
            <Select
              id="pe-version"
              value={versionId}
              onChange={setVersionId}
              options={versions.map((v) => ({
                value: String(v.id),
                label: `v${v.version_number} — ${v.status}`,
              }))}
              placeholder={versionLoading ? "Loading versions…" : "No versions yet"}
              disabled={versionLoading || versions.length === 0}
            />
          </div>
        </div>

        {selectedVersion && (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Package size={13} className="text-brand-600" />
            Snapshot: {selectedVersion.plan_name || `v${selectedVersion.version_number}`} ·
            effective {selectedVersion.effective_from ? new Date(selectedVersion.effective_from).toLocaleDateString() : "—"}
            the published version is immutable; values shown are the approved bundle.
          </div>
        )}

        {error ? (
          <ErrorState message={error} onRetry={retry} title="Unable to load plan entitlements" />
        ) : (
          <SectionCard
            variant="hero"
            accent="violet"
            icon={KeySquare}
            title="Plan Entitlement Matrix"
            description="Read-only per-plan-version entitlement snapshot — the published version is immutable, so values shown are the approved bundle."
          >
            {loading ? (
              <Spinner />
            ) : !selectedPlanId ? (
              <EmptyState
                icon={KeySquare}
                title="No plan selected"
                message="Select a commercial plan to inspect its versioned entitlement bundle."
              />
            ) : (
              <DataTable
                columns={columns}
                data={entitlements}
                loading={versionLoading}
                emptyTitle="No entitlements bound to this version"
                emptyMessage="This version has no PlanEntitlement rows yet — parts of the bundle may be unseeded for drafts."
                minWidth={820}
              />
            )}
          </SectionCard>
        )}

        {!error && !loading && entitlements.length > 0 && (
          <SectionCard variant="quiet">
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <StatusBadge status={selectedVersion?.status || ""} options={CATALOG_VERSION_STATUS_OPTIONS} />
              {displayValue(entitlements.length)} entitlement(s) resolved for this version.
            </div>
          </SectionCard>
        )}
      </div>
    </div>
  );
}