import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Gauge } from "lucide-react";
import { listCommercialUsageCounters, listOrganizations } from "../../service/commercialService";
import { PageHeader, DataTable, SearchInput } from "../../components/billing-ui";
import { ErrorState, Spinner } from "../../components/billing-shared";
import { formatDateTime, displayValue } from "./constants";

export default function UsageDiagnosticsPage() {
  const [counters, setCounters] = useState([]);
  const [organizations, setOrganizations] = useState([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cData, orgData] = await Promise.all([
        listCommercialUsageCounters(),
        listOrganizations({ limit: 200 }),
      ]);
      setCounters(cData.counters || []);
      setOrganizations(orgData.organizations || []);
    } catch (err) {
      setError(err?.message || "Failed to load usage diagnostics.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const orgById = useMemo(() => {
    const m = {};
    for (const o of organizations) m[o.id] = o;
    return m;
  }, [organizations]);

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return counters.filter((row) => {
      if (!term) return true;
      const org = orgById[row.organization_id];
      const orgText = org ? `${org.organization_code} ${org.organization_name}` : "";
      return (
        (row.entitlement_key || "").toLowerCase().includes(term) ||
        orgText.toLowerCase().includes(term)
      );
    });
  }, [counters, search, orgById]);

  const columns = useMemo(
    () => [
      {
        key: "org",
        label: "Organization",
        render: (row) => {
          const org = orgById[row.organization_id];
          return (
            <span>
              <span className="block text-sm font-semibold text-slate-800">{org?.organization_code || `#${row.organization_id}`}</span>
              <span className="block text-xs text-slate-500">{org?.organization_name || "—"}</span>
            </span>
          );
        },
      },
      {
        key: "key",
        label: "Entitlement Key",
        render: (row) => <span className="font-mono text-xs font-semibold text-slate-800">{row.entitlement_key}</span>,
      },
      { key: "window", label: "Window", render: (row) => <span className="text-xs text-slate-500">{row.window_key}</span> },
      { key: "count", label: "Count", render: (row) => <span className="text-sm font-semibold text-slate-700">{displayValue(row.count)}</span> },
      {
        key: "soft_warned",
        label: "Soft-limit grace started",
        render: (row) => <span className="text-xs text-slate-500">{row.soft_warned_at ? formatDateTime(row.soft_warned_at) : "—"}</span>,
      },
      {
        key: "updated_at",
        label: "Last updated",
        render: (row) => <span className="text-xs text-slate-500">{formatDateTime(row.updated_at)}</span>,
      },
    ],
    [orgById]
  );

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Usage Diagnostics"
        description="ZB-COM-ENT-001 · Part 3 §16 · UsageCounter values per organization, for keys enforced with a numeric limit. Threshold percentages require the org's resolved limit — cross-reference the Entitlement Catalog page for context on a specific key."
        icon={Gauge}
        meta={`${displayValue(counters.length)} counter(s)`}
      />

      <div className="mt-6 space-y-4">
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800">
          Only entitlement keys that route through <span className="font-semibold">UsageMeteringService</span> (or a
          route-level <span className="font-semibold">COUNT(*)</span> check, per the enforcement checklist) ever
          produce a row here — a key with no row simply hasn't been exercised, not necessarily unused.
        </div>

        <SearchInput value={search} onChange={setSearch} placeholder="Search by organization or key…" className="w-full max-w-sm" />

        {error ? (
          <div className="rounded-3xl border border-slate-200 bg-white">
            <ErrorState message={error} onRetry={load} title="Unable to load usage diagnostics" />
          </div>
        ) : loading && rows.length === 0 ? (
          <Spinner />
        ) : (
          <DataTable
            columns={columns}
            data={rows}
            loading={loading}
            rowKey={(row) => row.id}
            emptyTitle="No usage counters yet"
            emptyMessage={search ? "No counters match your search." : "No entitlement key with a numeric limit has been exercised yet."}
            minWidth={960}
          />
        )}
      </div>
    </div>
  );
}
