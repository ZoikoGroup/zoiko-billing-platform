import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { KeyRound, FileSearch, ShieldAlert, Gauge, GitPullRequestArrow, KeySquare } from "lucide-react";
import {
  listCommercialPlans,
  listCommercialPlanVersions,
  listEntitlementDefinitions,
  listPlanVersionEntitlements,
} from "../../service/commercialService";
import { PageHeader, SectionCard, DataTable, SearchInput, Button } from "../../components/billing-ui";
import { ErrorState, Spinner } from "../../components/billing-shared";
import {
  ENTITLEMENT_RISK_OPTIONS,
  ENTITLEMENT_VALUE_TYPE_OPTIONS,
  EntitlementEnforcementBadge,
  EntitlementRiskBadge,
  EntitlementValueTypeBadge,
  displayValue,
  formatEntitlementValue,
} from "./constants";

// `embedded` drops this page's own PageHeader when it is mounted as a tab of
// the Products & Pricing hub; `initialSearch` prefills the key search, used by
// Usage Diagnostics' "open in Entitlement Catalog" deep link.
export default function EntitlementsPage({ embedded = false, initialSearch = "" } = {}) {
  const navigate = useNavigate();
  const [definitions, setDefinitions] = useState([]);
  const [plans, setPlans] = useState([]);
  const [planValuesByKey, setPlanValuesByKey] = useState({});
  const [search, setSearch] = useState(initialSearch);
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
      const definitions = defsData.definitions || [];
      const plans = plansData.plans || [];
      setDefinitions(definitions);
      setPlans(plans);

      // Resolve each plan's published version entitlement values (§13) so the
      // matrix shows the immutable snapshot the catalog would enforce.
      const resolved = await Promise.all(
        plans.map(async (plan) => {
          try {
            const versionsData = await listCommercialPlanVersions(plan.id);
            const versions = versionsData.versions || [];
            const published =
              versions.find((v) => v.status === "published") || versions[0];
            if (!published) return { plan, entitlements: [] };
            const entData = await listPlanVersionEntitlements(published.id);
            return { plan, entitlements: entData.entitlements || [] };
          } catch {
            return { plan, entitlements: [] };
          }
        })
      );

      const byKey = {};
      for (const { plan, entitlements } of resolved) {
        for (const ent of entitlements) {
          if (!byKey[ent.key]) byKey[ent.key] = {};
          byKey[ent.key][plan.plan_code] = ent;
        }
      }
      setPlanValuesByKey(byKey);
    } catch (err) {
      setError(err?.message || "Failed to load the entitlement catalog.");
      setDefinitions([]);
      setPlans([]);
      setPlanValuesByKey({});
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return definitions
      .filter((def) => {
        if (!term) return true;
        return (
          (def.key || "").toLowerCase().includes(term) ||
          (def.description || "").toLowerCase().includes(term)
        );
      })
      .map((def) => {
        const values = planValuesByKey[def.key] || {};
        return { def, values };
      });
  }, [definitions, planValuesByKey, search]);

  const columns = useMemo(() => {
    const planColumns = plans.map((plan) => ({
      key: `plan_${plan.id}`,
      label: plan.plan_name,
      render: (row) => {
        const ent = row.values[plan.plan_code];
        if (!ent) return <span className="text-xs text-slate-400">—</span>;
        const text = formatEntitlementValue(ent.value, ent.value_type, ent.is_contracted);
        const tone =
          ent.is_contracted
            ? "text-violet-700"
            : ent.value === null || ent.value === undefined
              ? "text-slate-400"
              : "text-slate-700";
        return (
          <span className="text-xs font-medium">
            <span className={`block ${tone}`}>{text}</span>
            {ent.is_contracted && (
              <span className="block text-[10px] text-violet-400">order form</span>
            )}
          </span>
        );
      },
    }));
    return [
      {
        key: "key",
        label: "Entitlement Key",
        render: (row) => (
          <span className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
              <KeyRound size={16} />
            </span>
            <span>
              <span className="block font-mono text-xs font-semibold text-slate-800">{row.def.key}</span>
              {row.def.description && (
                <span className="block max-w-xs truncate text-xs text-slate-500">{row.def.description}</span>
              )}
            </span>
          </span>
        ),
      },
      {
        key: "value_type",
        label: "Value Type",
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
  }, [plans, planValuesByKey]);

  // When embedded in the hub these jump to a sibling tab (staying inside the
  // Products & Pricing hub, header and all); standalone they fall back to
  // each page's own direct route.
  const goTo = (tab, path) =>
    embedded ? navigate(`/super-admin/commercial/plans?tab=${tab}`) : navigate(path);

  return (
    <div className={embedded ? "" : "p-4 sm:p-6 lg:p-8"}>
      <PageHeader
        embedded={embedded}
        accent="violet"
        title="Entitlement Catalog"
        description="ZB-COM-ENT-001 · Part 3 · typed entitlement key registry (§12–§13), enforced for 5 of 19 keys (Part 2), with real management surfaces for overrides, draft-version entitlement editing, usage diagnostics, and the plan-change queue (Part 3) — see docs/ENTITLEMENT_ENFORCEMENT_CHECKLIST.md for the full wired/unwired breakdown."
        icon={KeyRound}
        meta={`${displayValue(definitions.length)} definition(s) · ${displayValue(plans.length)} plan(s)`}
      />

      <div className={`space-y-4 ${embedded ? "" : "mt-6"}`}>
        <SectionCard variant="quiet">
          <p className="text-xs leading-5 text-slate-600">
            Catalog rows are seeded from the approved register — nothing here is invented by the UI.{" "}
            <span className="font-semibold">High-risk</span> keys (identity/security-adjacent) require dual-approval —
            a <span className="font-semibold">CommercialOverride</span> for any key must be submitted by one user and
            approved by a different one before it takes effect. A plan column showing{" "}
            <span className="font-semibold">—</span> means that plan has no published version snapshot for the key yet;{" "}
            <span className="font-semibold">Contracted</span> means the value is governed by the signed Enterprise
            order form, not this catalog row.
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

        <div className="flex items-center justify-between gap-3">
          <SearchInput value={search} onChange={setSearch} placeholder="Search by key or description…" className="w-full max-w-sm" />
          <span className="hidden items-center gap-1.5 text-xs text-slate-400 sm:flex">
            <FileSearch size={13} /> Read-only catalog
          </span>
        </div>

        {error ? (
          <ErrorState message={error} onRetry={load} title="Unable to load entitlement catalog" />
        ) : (
          <SectionCard
            variant="hero"
            accent="violet"
            icon={KeyRound}
            title="Entitlement Definitions"
            description="Every typed entitlement key in the approved register, resolved against each plan's published version snapshot."
          >
            {loading && rows.length === 0 ? (
              <Spinner />
            ) : (
              <DataTable
                columns={columns}
                data={rows}
                loading={loading}
                emptyTitle="No entitlement definitions found"
                emptyMessage={
                  search
                    ? "No definitions match your search."
                    : "The catalog is empty — run scripts/seed_entitlement_definitions.py to seed the approved register."
                }
                minWidth={960}
              />
            )}
          </SectionCard>
        )}

        {!loading && !error && definitions.length > 0 && (
          <SectionCard variant="quiet">
            <div className="flex items-center justify-between">
              <p className="text-xs text-slate-500">
                Value types:{" "}
                {ENTITLEMENT_VALUE_TYPE_OPTIONS.map((o) => o.label).join(" · ")}
              </p>
              <p className="text-xs text-slate-500">
                Risk: {ENTITLEMENT_RISK_OPTIONS.map((o) => o.label).join(" · ")}
              </p>
            </div>
          </SectionCard>
        )}
      </div>
    </div>
  );
}