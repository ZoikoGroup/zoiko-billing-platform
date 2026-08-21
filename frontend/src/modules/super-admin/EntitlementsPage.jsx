import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { KeyRound, Building2, ChevronRight } from "lucide-react";
import { listCommercialAccounts, listCommercialPlans } from "../../service/commercialService";
import { PageHeader, DataTable, SearchInput } from "../../components/billing-ui";
import { StatusBadge, ErrorState, Spinner, EmptyState } from "../../components/billing-shared";
import { SUBSCRIPTION_STATUS_OPTIONS, PLAN_STATUS_OPTIONS, displayValue } from "./constants";

export default function EntitlementsPage() {
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState([]);
  const [plansByCode, setPlansByCode] = useState({});
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async (term) => {
    setLoading(true);
    setError(null);
    try {
      const [accountsData, plansData] = await Promise.all([
        listCommercialAccounts({ limit: 200, search: term }),
        listCommercialPlans({ limit: 200 }),
      ]);
      setAccounts(accountsData.accounts || []);
      const map = {};
      for (const plan of plansData.plans || []) map[plan.plan_code] = plan;
      setPlansByCode(map);
    } catch (err) {
      setError(err?.message || "Failed to load entitlements.");
      setAccounts([]);
      setPlansByCode({});
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(search);
  }, [load, search]);

  const onSearch = useCallback((value) => setSearch(value), []);

  const rows = useMemo(() => {
    return accounts.map((account) => {
      const sub = account.current_subscription;
      const plan = sub ? plansByCode[sub.plan_code] : null;
      return {
        account,
        sub,
        plan,
        limits: plan
          ? { max_users: plan.max_users, max_storage_gb: plan.max_storage_gb }
          : { max_users: null, max_storage_gb: null },
        featureCount: plan && plan.features ? Object.keys(plan.features).length : 0,
      };
    });
  }, [accounts, plansByCode]);

  const columns = useMemo(
    () => [
      {
        key: "organization",
        label: "Organization",
        render: (row) => (
          <span className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
              <Building2 size={16} />
            </span>
            <span>
              <span className="block font-semibold text-slate-800">{row.account.organization_name}</span>
              <span className="block text-xs text-slate-500">{row.account.organization_code}</span>
            </span>
          </span>
        ),
      },
      {
        key: "subscription",
        label: "Current Subscription",
        render: (row) => {
          if (!row.sub) return <span className="text-xs text-slate-500">No open subscription</span>;
          return (
            <span className="flex items-center gap-2">
              <span className="text-xs font-medium text-slate-600">{row.sub.plan_code}</span>
              <StatusBadge status={row.sub.status} options={SUBSCRIPTION_STATUS_OPTIONS} />
            </span>
          );
        },
      },
      {
        key: "plan_status",
        label: "Plan Status",
        render: (row) =>
          row.plan ? (
            <StatusBadge status={row.plan.status} options={PLAN_STATUS_OPTIONS} />
          ) : (
            <span className="text-xs text-slate-500">—</span>
          ),
      },
      {
        key: "max_users",
        label: "Max Users",
        render: (row) => <span className="text-xs text-slate-600">{displayValue(row.limits.max_users)}</span>,
      },
      {
        key: "max_storage_gb",
        label: "Max Storage (GB)",
        render: (row) => <span className="text-xs text-slate-600">{displayValue(row.limits.max_storage_gb)}</span>,
      },
      {
        key: "features",
        label: "Features",
        render: (row) => (
          <span className="text-xs text-slate-600">
            {row.plan ? (row.featureCount > 0 ? `${row.featureCount} declared` : "—") : "—"}
          </span>
        ),
      },
      {
        key: "open",
        label: "",
        width: 40,
        render: (row) => <ChevronRight size={15} className="text-slate-300" />,
      },
    ],
    []
  );

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Entitlements"
        description="Read-only entitlement view: each organization's current plan and its limits. Nothing here is enforced yet."
        icon={KeyRound}
        meta={`Showing ${displayValue(rows.length)} organization(s)`}
      />

      <div className="mt-6 space-y-4">
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800">
          Entitlements resolve from the organization's <span className="font-semibold">current open subscription's plan</span>.
          Missing (—) values mean the limit or feature is unset — they are <span className="font-semibold">not</span> unlimited.
          Entitlement resolution is a Phase 8 foundation and is <span className="font-semibold">not enforced</span> by tenant modules yet.
        </div>

        <SearchInput value={search} onChange={onSearch} placeholder="Search by organization name or code…" className="w-full max-w-sm" />

        {error ? (
          <div className="rounded-3xl border border-slate-200 bg-white">
            <ErrorState message={error} onRetry={() => load(search)} title="Unable to load entitlements" />
          </div>
        ) : loading && rows.length === 0 ? (
          <Spinner />
        ) : (
          <DataTable
            columns={columns}
            data={rows}
            loading={loading}
            onRowClick={(row) => navigate(`/super-admin/organizations/${row.account.organization_id}`)}
            emptyTitle="No organizations found"
            emptyMessage={search ? "No organizations match your search." : "Organizations will appear here once provisioned."}
            minWidth={820}
          />
        )}

        {!loading && !error && rows.length > 0 && rows.every((r) => !r.sub) && (
          <div className="rounded-2xl border border-dashed border-slate-200 bg-white p-4">
            <EmptyState
              icon={KeyRound}
              title="No entitlements yet"
              message="None of the organizations have an open commercial subscription, so no entitlements resolve."
            />
          </div>
        )}
      </div>
    </div>
  );
}
