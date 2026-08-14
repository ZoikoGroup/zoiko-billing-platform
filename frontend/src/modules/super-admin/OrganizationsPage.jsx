import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, ChevronRight } from "lucide-react";
import { listCommercialAccounts } from "../../service/commercialService";
import { PageHeader, DataTable, SearchInput } from "../../components/billing-ui";
import { Pagination, StatusBadge, ErrorState, Spinner } from "../../components/billing-shared";
import {
  PAGE_SIZE,
  ACCOUNT_STATUS_OPTIONS,
  SUBSCRIPTION_STATUS_OPTIONS,
  formatDateTime,
  displayValue,
  CommercialSourceBadge,
  CommercialClassificationBadge,
} from "./constants";

export default function OrganizationsPage() {
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async (pageNum, term) => {
    setLoading(true);
    setError(null);
    try {
      const data = await listCommercialAccounts({
        skip: (pageNum - 1) * PAGE_SIZE,
        limit: PAGE_SIZE,
        search: term,
      });
      setAccounts(data.accounts || []);
      setTotal(data.total || 0);
    } catch (err) {
      setError(err?.message || "Failed to load commercial accounts.");
      setAccounts([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(page, search);
  }, [load, page, search]);

  const onSearch = useCallback((value) => {
    setSearch(value);
    setPage(1);
  }, []);

  const columns = useMemo(
    () => [
      {
        key: "organization",
        label: "Organization",
        render: (row) => (
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
              <Building2 size={16} />
            </span>
            <span>
              <span className="block font-semibold text-slate-800">{row.organization_name}</span>
              <span className="block text-xs text-slate-400">{row.organization_code}</span>
            </span>
          </div>
        ),
      },
      {
        key: "status",
        label: "Account Status",
        render: (row) => <StatusBadge status={row.status} options={ACCOUNT_STATUS_OPTIONS} />,
      },
      {
        key: "billing_source",
        label: "Billing Source",
        render: (row) => <CommercialSourceBadge value={row.billing_source} />,
      },
      {
        key: "billing_classification",
        label: "Classification",
        render: (row) => <CommercialClassificationBadge value={row.billing_classification} />,
      },
      {
        key: "can_charge",
        label: "Chargeable",
        render: (row) =>
          row.can_charge ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-700">
              Can charge
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-600">
              Disabled
            </span>
          ),
      },
      {
        key: "current_subscription",
        label: "Current Subscription",
        render: (row) => {
          const sub = row.current_subscription;
          if (!sub) return <span className="text-xs text-slate-400">—</span>;
          return (
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-slate-600">{sub.plan_code}</span>
              <StatusBadge status={sub.status} options={SUBSCRIPTION_STATUS_OPTIONS} />
            </div>
          );
        },
      },
      {
        key: "created_at",
        label: "Created",
        render: (row) => <span className="text-xs text-slate-500">{formatDateTime(row.created_at)}</span>,
      },
      {
        key: "open",
        label: "",
        width: 40,
        render: () => <ChevronRight size={15} className="text-slate-300" />,
      },
    ],
    []
  );

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Organizations"
        description="Commercial accounts across all organizations — billing source, classification, charging readiness, and current subscription."
        icon={Building2}
        meta={`${displayValue(total)} organization(s)`}
      />

      <div className="mt-6 flex items-center justify-between gap-3">
        <SearchInput value={search} onChange={onSearch} placeholder="Search by organization name or code…" className="w-full max-w-sm" />
      </div>

      <div className="mt-4">
        {error ? (
          <div className="rounded-3xl border border-slate-200 bg-white">
            <ErrorState message={error} onRetry={() => load(page, search)} title="Unable to load organizations" />
          </div>
        ) : loading && accounts.length === 0 ? (
          <Spinner />
        ) : (
          <DataTable
            columns={columns}
            data={accounts}
            loading={loading}
            onRowClick={(row) => navigate(`/super-admin/commercial/organizations/${row.organization_id}`)}
            emptyTitle="No organizations found"
            emptyMessage={search ? "No organizations match your search." : "Organizations will appear here once they are provisioned."}
            minWidth={900}
          />
        )}
      </div>

      {!error && (
        <div className="mt-4">
          <Pagination page={page} totalPages={totalPages} onPageChange={setPage}>
            {displayValue(total)} organization(s)
          </Pagination>
        </div>
      )}
    </div>
  );
}
