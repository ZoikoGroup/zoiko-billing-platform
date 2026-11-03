import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { KeyRound, FileSearch, ShieldAlert, Gauge, GitPullRequestArrow, KeySquare, AlertTriangle, X, Layers } from "lucide-react";
import {
  listCommercialPlans,
  listCommercialPlanVersions,
  listEntitlementDefinitions,
  listPlanVersionEntitlements,
} from "../../service/commercialService";
import { PageHeader, SectionCard, DataTable, SearchInput, Button, Select } from "../../components/billing-ui";
import { ErrorState, Spinner } from "../../components/billing-shared";
import {
  ENTITLEMENT_ENFORCEMENT_OPTIONS,
  ENTITLEMENT_RISK_OPTIONS,
  ENTITLEMENT_VALUE_TYPE_OPTIONS,
  EntitlementEnforcementBadge,
  EntitlementRiskBadge,
  EntitlementValueTypeBadge,
  displayValue,
  formatEntitlementValue,
} from "./constants";

// The enforcement layer treats a null INTEGER limit as "no limit enforced"
// (EntitlementEnforcementService.assert_within_limit), so say that instead of
// a bare "—" that reads the same as "no value bound".
function formatPlanValue(ent) {
  if (ent.value_type === "integer" && !ent.is_contracted && (ent.value === null || ent.value === undefined)) {
    return "No limit";
  }
  return formatEntitlementValue(ent.value, ent.value_type, ent.is_contracted);
}

function SummaryTile({ label, value, hint, tone = "text-slate-900" }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${tone}`}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

// `embedded` drops this page's own PageHeader when it is mounted as a tab of
// the Products & Pricing hub; `initialSearch` prefills the key search, used by
// Usage Diagnostics' "open in Entitlement Catalog" deep link.
export default function EntitlementsPage({ embedded = false, initialSearch = "" } = {}) {
  const navigate = useNavigate();
  const [definitions, setDefinitions] = useState([]);
  const [plans, setPlans] = useState([]);
  const [planValuesByKey, setPlanValuesByKey] = useState({});
  // Per plan id: "ok" (published snapshot loaded), "none" (no published
  // version) or "failed" (its versions/entitlements fetch errored).
  const [planState, setPlanState] = useState({});
  const [search, setSearch] = useState(initialSearch);
  const [riskFilter, setRiskFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [enforcementFilter, setEnforcementFilter] = useState("");
  const [searchResetKey, setSearchResetKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [defsData, plansData] = await Promise.all([
        listEntitlementDefinitions(),
        listCommercialPlans({ limit: 200 }),
      ]);
      const definitions = defsData?.definitions || [];
      const plans = plansData?.plans || [];
      setDefinitions(definitions);
      setPlans(plans);

      // Resolve each plan's published version entitlement values (§13) so the
      // matrix shows the immutable snapshot the catalog would enforce. Only a
      // PUBLISHED version counts — a draft/rejected one is not the approved
      // bundle and must not be shown as if it were.
      const resolved = await Promise.all(
        plans.map(async (plan) => {
          try {
            const versionsData = await listCommercialPlanVersions(plan.id);
            const versions = versionsData?.versions || [];
            const published = versions.find((v) => v.status === "published");
            if (!published) return { plan, state: "none", entitlements: [] };
            const entData = await listPlanVersionEntitlements(published.id);
            return { plan, state: "ok", entitlements: entData?.entitlements || [] };
          } catch {
            return { plan, state: "failed", entitlements: [] };
          }
        })
      );

      const byKey = {};
      const states = {};
      for (const { plan, state, entitlements } of resolved) {
        states[plan.id] = state;
        for (const ent of entitlements) {
          if (!byKey[ent.key]) byKey[ent.key] = {};
          byKey[ent.key][plan.id] = ent;
        }
      }
      setPlanValuesByKey(byKey);
      setPlanState(states);
    } catch (err) {
      setError(err?.message || "Failed to load the entitlement catalog.");
      setDefinitions([]);
      setPlans([]);
      setPlanValuesByKey({});
      setPlanState({});
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const hasActiveFilters = Boolean(search || riskFilter || typeFilter || enforcementFilter);
  const clearFilters = useCallback(() => {
    setSearchResetKey((k) => k + 1);
    setSearch("");
    setRiskFilter("");
    setTypeFilter("");
    setEnforcementFilter("");
  }, []);

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return definitions
      .filter(
        (def) =>
          (!term ||
            (def.key || "").toLowerCase().includes(term) ||
            (def.description || "").toLowerCase().includes(term)) &&
          (!riskFilter || def.risk_classification === riskFilter) &&
          (!typeFilter || def.value_type === typeFilter) &&
          (!enforcementFilter || def.enforcement_type === enforcementFilter)
      )
      .map((def) => ({ def, values: planValuesByKey[def.key] || {} }));
  }, [definitions, planValuesByKey, search, riskFilter, typeFilter, enforcementFilter]);

  const failedPlans = plans.filter((p) => planState[p.id] === "failed");
  const publishedPlanCount = plans.filter((p) => planState[p.id] === "ok").length;
  const highRiskCount = definitions.filter((d) => d.risk_classification === "high_risk").length;

  const columns = useMemo(() => {
    const planColumns = plans.map((plan) => {
      const state = planState[plan.id];
      return {
        key: `plan_${plan.id}`,
        label: (
          <span className="block">
            <span className="block">{plan.plan_name}</span>
            {state === "none" && <span className="block text-[10px] font-medium normal-case tracking-normal text-amber-600">No published version</span>}
            {state === "failed" && <span className="block text-[10px] font-medium normal-case tracking-normal text-red-600">Couldn't load</span>}
            {plan.status && plan.status !== "active" && (
              <span className="block text-[10px] font-medium normal-case tracking-normal text-slate-400">{plan.status}</span>
            )}
          </span>
        ),
        render: (row) => {
          if (state === "failed") {
            return <span className="text-xs text-red-500" title="This plan's published snapshot couldn't be loaded">Unavailable</span>;
          }
          const ent = row.values[plan.id];
          if (!ent) {
            return (
              <span className="text-xs text-slate-400" title={state === "none" ? "This plan has no published version yet" : "Not part of this plan's published bundle"}>
                —
              </span>
            );
          }
          const tone = ent.is_contracted
            ? "text-violet-700"
            : ent.value === null || ent.value === undefined || ent.value === false
              ? "text-slate-500"
              : "text-slate-800";
          return (
            <span className="text-xs font-medium">
              <span className={`block ${tone}`}>{formatPlanValue(ent)}</span>
              {ent.is_contracted && <span className="block text-[10px] text-violet-400">order form</span>}
            </span>
          );
        },
      };
    });
    return [
      {
        key: "key",
        label: "Entitlement",
        render: (row) => (
          <span className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
              <KeyRound size={16} />
            </span>
            <span className="min-w-0">
              <span className="block font-mono text-xs font-semibold text-slate-800">{row.def.key}</span>
              {row.def.description && (
                <span className="block max-w-xs truncate text-xs text-slate-500" title={row.def.description}>
                  {row.def.description}
                </span>
              )}
            </span>
          </span>
        ),
      },
      {
        key: "value_type",
        label: "Type",
        render: (row) => <EntitlementValueTypeBadge value={row.def.value_type} />,
      },
      {
        key: "risk",
        label: "Risk",
        render: (row) => <EntitlementRiskBadge value={row.def.risk_classification} />,
      },
      {
        key: "enforcement",
        label: "Enforcement",
        render: (row) => <EntitlementEnforcementBadge value={row.def.enforcement_type} />,
      },
      ...planColumns,
    ];
  }, [plans, planState]);

  // When embedded in the hub these jump to a sibling tab (staying inside the
  // Products & Pricing hub, header and all); standalone they fall back to
  // each page's own direct route.
  const goTo = (tab, path) =>
    embedded ? navigate(`/super-admin/commercial/plans?tab=${tab}`) : navigate(path);

  const showSummary = !error && !(loading && definitions.length === 0);

  return (
    <div className={embedded ? "" : "p-4 sm:p-6 lg:p-8"}>
      <PageHeader
        embedded={embedded}
        accent="violet"
        title="Entitlement Catalog"
        description="Every feature flag and usage limit the platform knows about, and the value each plan's published version grants. Read-only — the catalog is seeded from the approved register."
        icon={KeyRound}
        meta={error ? null : `${displayValue(definitions.length)} entitlement(s) · ${displayValue(plans.length)} plan(s)`}
      />

      <div className={`space-y-4 ${embedded ? "" : "mt-6"}`}>
        {showSummary && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <SummaryTile label="Entitlement keys" value={displayValue(definitions.length)} hint="In the approved register" />
            <SummaryTile
              label="High-risk keys"
              value={displayValue(highRiskCount)}
              hint="Identity / security-adjacent"
              tone={highRiskCount ? "text-rose-700" : "text-slate-900"}
            />
            <SummaryTile
              label="Plans with a published version"
              value={`${publishedPlanCount} / ${plans.length}`}
              hint={plans.length - publishedPlanCount > 0 ? "Plans without one show — in every row" : "Every plan has an approved bundle"}
            />
          </div>
        )}

        <SectionCard variant="quiet">
          <p className="text-xs leading-5 text-slate-600">
            Nothing here is invented by the UI — rows come from the seeded register and each plan column from that plan's
            latest <span className="font-semibold">published</span> version.{" "}
            <span className="font-semibold">—</span> means the plan has no published value for that key;{" "}
            <span className="font-semibold">Contracted</span> means the value comes from a signed Enterprise order form.
            To grant one organization a different value, use <span className="font-semibold">Overrides</span> (every
            override needs a second Super Admin to approve it).
          </p>
        </SectionCard>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" icon={KeySquare} onClick={() => goTo("plan-entitlements", "/super-admin/commercial/plan-entitlements")}>
            Plan entitlements
          </Button>
          <Button size="sm" variant="secondary" icon={ShieldAlert} onClick={() => goTo("overrides", "/super-admin/commercial/overrides")}>
            Overrides
          </Button>
          <Button size="sm" variant="secondary" icon={Gauge} onClick={() => goTo("usage-diagnostics", "/super-admin/commercial/usage-diagnostics")}>
            Usage diagnostics
          </Button>
          <Button size="sm" variant="secondary" icon={GitPullRequestArrow} onClick={() => goTo("plan-changes", "/super-admin/commercial/plan-changes")}>
            Plan-change queue
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <SearchInput
            key={searchResetKey}
            value={search}
            onChange={setSearch}
            placeholder="Search by key or description…"
            className="w-full sm:max-w-sm"
          />
          <Select value={riskFilter} onChange={setRiskFilter} options={ENTITLEMENT_RISK_OPTIONS} placeholder="All risk levels" className="w-full sm:w-40" aria-label="Filter by risk" />
          <Select value={typeFilter} onChange={setTypeFilter} options={ENTITLEMENT_VALUE_TYPE_OPTIONS} placeholder="All value types" className="w-full sm:w-40" aria-label="Filter by value type" />
          <Select value={enforcementFilter} onChange={setEnforcementFilter} options={ENTITLEMENT_ENFORCEMENT_OPTIONS} placeholder="All enforcement" className="w-full sm:w-44" aria-label="Filter by enforcement" />
          <Button size="sm" variant="secondary" icon={X} onClick={clearFilters} disabled={!hasActiveFilters}>
            Clear filters
          </Button>
          <span className="ml-auto hidden items-center gap-1.5 text-xs text-slate-400 lg:flex">
            <FileSearch size={13} /> Read-only catalog
          </span>
        </div>

        {!loading && !error && failedPlans.length > 0 && (
          <div role="alert" className="flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <span className="flex-1">
              Couldn't load the published values for {failedPlans.map((p) => p.plan_name).join(", ")}. Those columns
              show "Unavailable" rather than a guess.
            </span>
            <button type="button" onClick={load} className="text-xs font-semibold underline">
              Retry
            </button>
          </div>
        )}

        {error ? (
          <ErrorState message={error} onRetry={() => load()} title="Unable to load entitlement catalog" />
        ) : (
          <SectionCard
            variant="hero"
            accent="violet"
            icon={Layers}
            title="Entitlements by plan"
            description="Each row is one entitlement key; each plan column shows the value that plan's published version grants."
            meta={hasActiveFilters && !loading ? `Showing ${rows.length} of ${definitions.length}` : null}
          >
            {loading && rows.length === 0 ? (
              <Spinner />
            ) : (
              <DataTable
                columns={columns}
                data={rows}
                loading={loading}
                rowKey={(row) => row.def.id ?? row.def.key}
                emptyTitle={hasActiveFilters ? "No entitlements match your filters" : "No entitlement definitions found"}
                emptyMessage={
                  hasActiveFilters
                    ? "Try a different key, risk level, value type or enforcement."
                    : "The catalog is empty — run scripts/seed_entitlement_definitions.py to seed the approved register."
                }
                emptyAction={
                  hasActiveFilters ? (
                    <Button variant="secondary" size="sm" icon={X} onClick={clearFilters}>Clear filters</Button>
                  ) : null
                }
                minWidth={760 + plans.length * 120}
              />
            )}
          </SectionCard>
        )}
      </div>
    </div>
  );
}
