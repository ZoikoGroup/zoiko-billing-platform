import React, { useCallback, useEffect, useMemo, useState } from "react";
import { KeySquare, Package, X, AlertTriangle } from "lucide-react";
import {
  listCommercialPlans,
  listCommercialPlanVersions,
  listPlanVersionEntitlements,
} from "../../service/commercialService";
import { PageHeader, SectionCard, DataTable, Select, SearchInput, Button, Field } from "../../components/billing-ui";
import { StatusBadge, ErrorState, Spinner, EmptyState } from "../../components/billing-shared";
import {
  CATALOG_VERSION_STATUS_OPTIONS,
  ENTITLEMENT_ENFORCEMENT_OPTIONS,
  ENTITLEMENT_RISK_OPTIONS,
  ENTITLEMENT_VALUE_TYPE_OPTIONS,
  EntitlementEnforcementBadge,
  EntitlementRiskBadge,
  EntitlementValueTypeBadge,
  displayValue,
  formatEntitlementValue,
} from "./constants";

const versionStatusLabel = (status) =>
  CATALOG_VERSION_STATUS_OPTIONS.find((o) => o.value === status)?.label || String(status || "").replace(/_/g, " ");

// effective_from is a plain date ("2026-01-01"). new Date() on that string is
// UTC midnight, which renders as the previous day west of UTC — build a local
// date from its parts instead.
function formatPlainDate(value) {
  if (!value) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  const date = match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

// A null INTEGER limit is enforced as "no limit" (assert_within_limit).
function formatPlanValue(row) {
  if (row.value_type === "integer" && !row.is_contracted && (row.value === null || row.value === undefined)) {
    return "No limit";
  }
  return formatEntitlementValue(row.value, row.value_type, row.is_contracted);
}

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
  const [entitlementsLoading, setEntitlementsLoading] = useState(false);
  const [error, setError] = useState(null);

  // Row filters over the selected version's entitlements (client-side: one
  // version's bundle is small and already fully loaded).
  const [search, setSearch] = useState("");
  const [riskFilter, setRiskFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [enforcementFilter, setEnforcementFilter] = useState("");
  // Bumped on clear to remount SearchInput, so text still inside its debounce
  // window is discarded instead of re-applying a moment later.
  const [searchResetKey, setSearchResetKey] = useState(0);

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
        const plans = data?.plans || [];
        setPlans(plans);
        setErrorStage(null);
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
  // The previous plan's versions are cleared up front: otherwise a failed
  // fetch left the old plan's version selected under the new plan.
  useEffect(() => {
    let alive = true;
    setVersions([]);
    setVersionId("");
    setEntitlements([]);
    if (!selectedPlanId) {
      return () => {
        alive = false;
      };
    }
    setVersionLoading(true);
    setError((prev) => (errorStage === "versions" || errorStage === "entitlements" ? null : prev));
    listCommercialPlanVersions(Number(selectedPlanId))
      .then((data) => {
        if (!alive) return;
        const versions = data?.versions || [];
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
    setEntitlements([]);
    if (!versionId) {
      setEntitlementsLoading(false);
      return () => {
        alive = false;
      };
    }
    // Without a loading flag here the table briefly claimed "No entitlements
    // bound to this version" while the request was still in flight.
    setEntitlementsLoading(true);
    setError((prev) => (errorStage === "entitlements" ? null : prev));
    listPlanVersionEntitlements(Number(versionId))
      .then((data) => {
        if (!alive) return;
        setEntitlements(data?.entitlements || []);
        setErrorStage((prev) => (prev === "entitlements" ? null : prev));
      })
      .catch((err) => {
        if (!alive) return;
        setError(err?.message || "Failed to load entitlements.");
        setErrorStage("entitlements");
      })
      .finally(() => alive && setEntitlementsLoading(false));
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

  const selectedPlan = useMemo(
    () => plans.find((p) => String(p.id) === selectedPlanId),
    [plans, selectedPlanId]
  );
  const selectedVersion = useMemo(
    () => versions.find((v) => String(v.id) === versionId),
    [versions, versionId]
  );
  const isPublished = selectedVersion?.status === "published";
  const tableLoading = versionLoading || entitlementsLoading;

  const hasActiveFilters = Boolean(search || riskFilter || typeFilter || enforcementFilter);
  const clearFilters = useCallback(() => {
    setSearchResetKey((k) => k + 1);
    setSearch("");
    setRiskFilter("");
    setTypeFilter("");
    setEnforcementFilter("");
  }, []);

  const filteredEntitlements = useMemo(() => {
    const term = search.trim().toLowerCase();
    return entitlements.filter(
      (row) =>
        (!term || (row.key || "").toLowerCase().includes(term)) &&
        (!riskFilter || row.risk_classification === riskFilter) &&
        (!typeFilter || row.value_type === typeFilter) &&
        (!enforcementFilter || row.enforcement_type === enforcementFilter)
    );
  }, [entitlements, search, riskFilter, typeFilter, enforcementFilter]);

  const counts = useMemo(
    () => ({
      enabled: entitlements.filter((e) => e.value_type === "boolean" && e.value === true).length,
      limits: entitlements.filter((e) => e.value_type === "integer").length,
      highRisk: entitlements.filter((e) => e.risk_classification === "high_risk").length,
      contracted: entitlements.filter((e) => e.is_contracted).length,
    }),
    [entitlements]
  );

  const planOptions = useMemo(
    () =>
      plans.map((p) => ({
        value: String(p.id),
        label: p.status && p.status !== "active" ? `${p.plan_name} (${p.plan_code}) — ${p.status}` : `${p.plan_name} (${p.plan_code})`,
      })),
    [plans]
  );
  const versionOptions = useMemo(
    () =>
      versions.map((v) => ({
        value: String(v.id),
        label: `Version ${v.version_number} — ${versionStatusLabel(v.status)}`,
      })),
    [versions]
  );

  const columns = useMemo(
    () => [
      {
        key: "key",
        label: "Entitlement",
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
        key: "value",
        label: "Value",
        render: (row) => {
          const tone = row.is_contracted
            ? "text-violet-700"
            : row.value === null || row.value === undefined || row.value === false
              ? "text-slate-500"
              : "text-slate-800";
          return (
            <span className="text-xs font-medium">
              <span className={`block ${tone}`}>{formatPlanValue(row)}</span>
              {row.is_contracted && <span className="block text-[10px] text-violet-400">order form</span>}
            </span>
          );
        },
      },
      {
        key: "value_type",
        label: "Type",
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
    ],
    []
  );

  const statusText = selectedVersion ? String(selectedVersion.status || "").replace(/_/g, " ") : "";

  return (
    <div className={embedded ? "" : "p-4 sm:p-6 lg:p-8"}>
      <PageHeader
        embedded={embedded}
        accent="violet"
        title="Plan Entitlements"
        description="What a single plan version grants: every feature flag and limit in its bundle. Pick a plan and version to inspect it."
        icon={KeySquare}
        meta={!embedded && selectedVersion ? `v${selectedVersion.version_number} · ${versionStatusLabel(selectedVersion.status)}` : null}
      />

      <div className={`space-y-4 ${embedded ? "" : "mt-6"}`}>
        <SectionCard variant="standard">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Plan" htmlFor="pe-plan">
              <Select
                id="pe-plan"
                value={selectedPlanId}
                onChange={setSelectedPlanId}
                options={planOptions}
                placeholder={loading ? "Loading plans…" : plans.length ? "Select a plan…" : "No plans yet"}
                disabled={loading || plans.length === 0}
              />
            </Field>
            <Field
              label="Version"
              htmlFor="pe-version"
              hint={selectedPlanId && !versionLoading && versions.length === 0 && errorStage !== "versions" ? "This plan has no versions yet." : undefined}
            >
              <Select
                id="pe-version"
                value={versionId}
                onChange={setVersionId}
                options={versionOptions}
                placeholder={versionLoading ? "Loading versions…" : selectedPlanId ? "No versions yet" : "Select a plan first"}
                disabled={versionLoading || versions.length === 0}
              />
            </Field>
          </div>

          {selectedVersion && (
            <div
              className={`mt-4 flex items-start gap-2 rounded-xl px-3 py-2 text-xs ${
                isPublished ? "bg-slate-50 text-slate-600" : "bg-amber-50 text-amber-800"
              }`}
            >
              {isPublished ? (
                <Package size={14} className="mt-0.5 shrink-0 text-brand-600" />
              ) : (
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              )}
              <span>
                {selectedVersion.plan_name || selectedPlan?.plan_name || `Version ${selectedVersion.version_number}`} · effective{" "}
                {formatPlainDate(selectedVersion.effective_from)} ·{" "}
                {isPublished
                  ? "the published version is immutable; values shown are the approved bundle."
                  : `this version is ${statusText}, so these values are not yet the approved bundle.`}
              </span>
            </div>
          )}
        </SectionCard>

        {!error && entitlements.length > 0 && (
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { label: "Features enabled", value: counts.enabled },
              { label: "Usage limits", value: counts.limits },
              { label: "High-risk keys", value: counts.highRisk, tone: counts.highRisk ? "text-rose-700" : "" },
              { label: "Contracted (order form)", value: counts.contracted, tone: counts.contracted ? "text-violet-700" : "" },
            ].map((tile) => (
              <div key={tile.label} className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{tile.label}</p>
                <p className={`mt-1 text-2xl font-bold ${tile.tone || "text-slate-900"}`}>{displayValue(tile.value)}</p>
              </div>
            ))}
          </div>
        )}

        {selectedPlanId && entitlements.length > 0 && (
          <div className="flex flex-wrap items-center gap-3">
            <SearchInput
              key={searchResetKey}
              value={search}
              onChange={setSearch}
              placeholder="Search entitlement key…"
              className="w-full sm:max-w-xs"
            />
            <Select value={riskFilter} onChange={setRiskFilter} options={ENTITLEMENT_RISK_OPTIONS} placeholder="All risk levels" className="w-full sm:w-40" aria-label="Filter by risk" />
            <Select value={typeFilter} onChange={setTypeFilter} options={ENTITLEMENT_VALUE_TYPE_OPTIONS} placeholder="All value types" className="w-full sm:w-40" aria-label="Filter by value type" />
            <Select value={enforcementFilter} onChange={setEnforcementFilter} options={ENTITLEMENT_ENFORCEMENT_OPTIONS} placeholder="All enforcement" className="w-full sm:w-44" aria-label="Filter by enforcement" />
            <Button
              size="sm"
              variant="secondary"
              icon={X}
              onClick={clearFilters}
              disabled={!hasActiveFilters}
              title={hasActiveFilters ? "Reset search, risk, value type and enforcement filters" : "No filters applied"}
            >
              Clear filters
            </Button>
          </div>
        )}

        {error ? (
          <SectionCard variant="standard">
            <ErrorState message={error} onRetry={retry} title="Unable to load plan entitlements" />
          </SectionCard>
        ) : (
          <SectionCard
            variant="hero"
            accent="violet"
            icon={KeySquare}
            title="Entitlement bundle"
            description={
              selectedVersion && !isPublished
                ? "Read-only view of this version's values. It is not published, so these are not yet the approved bundle — edit drafts from the plan's Versions page."
                : "Read-only view of the selected version's values — a published version is immutable, so these are the approved bundle."
            }
            meta={
              entitlements.length > 0 && !tableLoading
                ? hasActiveFilters
                  ? `Showing ${filteredEntitlements.length} of ${entitlements.length} entitlement(s) for this version.`
                  : `${displayValue(entitlements.length)} entitlement(s) resolved for this version.`
                : null
            }
            actions={selectedVersion ? <StatusBadge status={selectedVersion.status || ""} options={CATALOG_VERSION_STATUS_OPTIONS} /> : null}
          >
            {loading ? (
              <Spinner />
            ) : !selectedPlanId ? (
              <EmptyState
                icon={KeySquare}
                title={plans.length ? "No plan selected" : "No plans yet"}
                message={
                  plans.length
                    ? "Select a plan above to see what its version grants."
                    : "Create a plan on the Plans tab first; its entitlement bundle will appear here."
                }
              />
            ) : !versionLoading && versions.length === 0 ? (
              <EmptyState
                icon={KeySquare}
                title="This plan has no versions yet"
                message="Entitlements are bound to a plan version. Create a draft version from the plan's Versions page."
              />
            ) : (
              <DataTable
                columns={columns}
                data={filteredEntitlements}
                loading={tableLoading}
                emptyTitle={hasActiveFilters ? "No entitlements match your filters" : "No entitlements bound to this version"}
                emptyMessage={
                  hasActiveFilters
                    ? "Try a different key, risk level, value type or enforcement."
                    : "This version has no entitlement values yet — parts of the bundle may be unseeded for drafts."
                }
                emptyAction={
                  hasActiveFilters ? (
                    <Button variant="secondary" size="sm" icon={X} onClick={clearFilters}>Clear filters</Button>
                  ) : null
                }
                minWidth={820}
              />
            )}
          </SectionCard>
        )}
      </div>
    </div>
  );
}
