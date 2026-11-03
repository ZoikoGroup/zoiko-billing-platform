import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Gauge, RefreshCw } from "lucide-react";
import { listCommercialUsageCounters, listOrganizations } from "../../service/commercialService";
import { PageHeader, SectionCard, DataTable, SearchInput, Select, Button } from "../../components/billing-ui";
import { ErrorState, Spinner } from "../../components/billing-shared";
import { formatDateTime, displayValue } from "./constants";

// /super-admin/organizations caps `limit` at 200; page through so counters
// for organizations past the first 200 still show a name. Bounded so a huge
// fleet can't turn one tab open into an unbounded request loop.
const ORG_PAGE_SIZE = 200;
const ORG_MAX_PAGES = 25;

async function loadAllOrganizations() {
  const all = [];
  for (let pageIdx = 0; pageIdx < ORG_MAX_PAGES; pageIdx += 1) {
    const data = await listOrganizations({ skip: pageIdx * ORG_PAGE_SIZE, limit: ORG_PAGE_SIZE });
    const batch = data?.organizations || [];
    all.push(...batch);
    const total = typeof data?.total === "number" ? data.total : null;
    if (batch.length < ORG_PAGE_SIZE || (total !== null && all.length >= total)) break;
  }
  return all;
}

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// UsageMeteringService.current_window_key: "YYYY-MM" (monthly) or
// "YYYY-MM-DD" (daily). Anything else is shown as stored.
function describeWindow(windowKey) {
  if (!windowKey) return "—";
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(windowKey);
  if (!m) return windowKey;
  const month = MONTH_NAMES[Number(m[2]) - 1];
  if (!month) return windowKey;
  return m[3] ? `${Number(m[3])} ${month} ${m[1]} (daily)` : `${month} ${m[1]} (monthly)`;
}

const GRACE_FILTER_OPTIONS = [
  { value: "grace", label: "Soft limit exceeded" },
  { value: "no_grace", label: "Within limit" },
];

// `embedded` drops this page's own PageHeader (and its page padding) when it
// is mounted as a tab of the Products & Pricing hub. `onOpenKey`, if given,
// turns each row's entitlement key into a link that jumps to that key's own
// entry in the Entitlement Catalog tab — the catalog cross-reference this
// page's own description already promises, made followable instead of manual.
export default function UsageDiagnosticsPage({ embedded = false, onOpenKey } = {}) {
  const [counters, setCounters] = useState([]);
  const [organizations, setOrganizations] = useState([]);
  const [orgLookupError, setOrgLookupError] = useState(null);
  const [search, setSearch] = useState("");
  const [windowFilter, setWindowFilter] = useState("");
  const [graceFilter, setGraceFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    // Organization names are only a label lookup — failing to load them must
    // not hide the counters themselves (rows fall back to the org id).
    const [cResult, orgResult] = await Promise.allSettled([
      listCommercialUsageCounters(),
      loadAllOrganizations(),
    ]);
    if (cResult.status === "fulfilled") {
      setCounters(cResult.value?.counters || []);
    } else {
      setError(cResult.reason?.message || "Failed to load usage diagnostics.");
      setCounters([]);
    }
    if (orgResult.status === "fulfilled") {
      setOrganizations(orgResult.value);
      setOrgLookupError(null);
    } else {
      setOrgLookupError(orgResult.reason?.message || "Organization names could not be loaded.");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const orgById = useMemo(() => {
    const m = {};
    for (const o of organizations) m[o.id] = o;
    return m;
  }, [organizations]);

  const windows = useMemo(
    () => [...new Set(counters.map((c) => c.window_key).filter(Boolean))].sort().reverse(),
    [counters]
  );

  const summary = useMemo(
    () => ({
      counters: counters.length,
      organizations: new Set(counters.map((c) => c.organization_id)).size,
      keys: new Set(counters.map((c) => c.entitlement_key).filter(Boolean)).size,
      inGrace: counters.filter((c) => c.soft_warned_at).length,
    }),
    [counters]
  );

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    return counters.filter((row) => {
      if (windowFilter && row.window_key !== windowFilter) return false;
      if (graceFilter === "grace" && !row.soft_warned_at) return false;
      if (graceFilter === "no_grace" && row.soft_warned_at) return false;
      if (!term) return true;
      const org = orgById[row.organization_id];
      const orgText = org ? `${org.organization_code} ${org.organization_name}` : `#${row.organization_id}`;
      return (
        (row.entitlement_key || "").toLowerCase().includes(term) ||
        orgText.toLowerCase().includes(term)
      );
    });
  }, [counters, search, windowFilter, graceFilter, orgById]);

  const filtered = Boolean(search || windowFilter || graceFilter);
  const clearFilters = () => {
    setSearch("");
    setWindowFilter("");
    setGraceFilter("");
  };

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
              <span className="block text-xs text-slate-500">{org?.organization_name || "Name not available"}</span>
            </span>
          );
        },
      },
      {
        key: "key",
        label: "Feature (entitlement key)",
        render: (row) => {
          if (!row.entitlement_key) {
            return <span className="text-xs text-slate-500">definition #{row.entitlement_definition_id}</span>;
          }
          return onOpenKey ? (
            <button
              type="button"
              onClick={() => onOpenKey(row.entitlement_key)}
              title="Open this key in the Entitlement Catalog"
              className="rounded font-mono text-xs font-semibold text-brand-600 underline decoration-dotted underline-offset-2 hover:text-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              {row.entitlement_key}
            </button>
          ) : (
            <span className="font-mono text-xs font-semibold text-slate-800">{row.entitlement_key}</span>
          );
        },
      },
      {
        key: "window",
        label: "Period",
        render: (row) => <span className="text-xs text-slate-500" title={row.window_key}>{describeWindow(row.window_key)}</span>,
      },
      { key: "count", label: "Used", numeric: true, render: (row) => <span className="text-sm font-semibold text-slate-700">{displayValue(row.count)}</span> },
      {
        key: "soft_warned",
        label: "Soft limit exceeded",
        render: (row) =>
          row.soft_warned_at ? (
            <span className="text-xs font-medium text-amber-700">Since {formatDateTime(row.soft_warned_at)}</span>
          ) : (
            <span className="text-xs text-slate-400">—</span>
          ),
      },
      {
        key: "updated_at",
        label: "Last updated",
        render: (row) => <span className="text-xs text-slate-500">{row.updated_at ? formatDateTime(row.updated_at) : "—"}</span>,
      },
    ],
    [orgById, onOpenKey]
  );

  const tiles = [
    { label: "Counters", value: summary.counters },
    { label: "Organizations", value: summary.organizations },
    { label: "Features tracked", value: summary.keys },
    { label: "Over soft limit", value: summary.inGrace, warn: summary.inGrace > 0 },
  ];

  return (
    <div className={embedded ? "" : "p-4 sm:p-6 lg:p-8"}>
      <PageHeader
        embedded={embedded}
        accent="violet"
        title="Usage Diagnostics"
        description="How much each organization has used of the features that have a numeric limit, per period. Click a feature key to see its limits in the Entitlement Catalog."
        icon={Gauge}
        meta={`${displayValue(counters.length)} counter(s)`}
        actions={
          <Button variant="secondary" icon={RefreshCw} onClick={() => load()} disabled={loading}>
            Refresh
          </Button>
        }
      />

      <div className={`space-y-4 ${embedded ? "" : "mt-6"}`}>
        <SectionCard variant="quiet">
          <p className="text-xs leading-5 text-slate-600">
            A row appears only once a limited feature has actually been used (it is recorded by{" "}
            <span className="font-semibold">UsageMeteringService</span> or a route-level{" "}
            <span className="font-semibold">COUNT(*)</span> check). A feature with no row simply hasn&apos;t been
            exercised — that doesn&apos;t prove it is unused. Usage percentages aren&apos;t shown because they depend on
            each organization&apos;s resolved limit.
          </p>
        </SectionCard>

        {!error && counters.length > 0 && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {tiles.map((tile) => (
              <div key={tile.label} className="rounded-2xl border border-slate-200 bg-white p-3.5">
                <span className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500">{tile.label}</span>
                <span className={`mt-1.5 block text-2xl font-extrabold ${tile.warn ? "text-amber-700" : "text-slate-800"}`}>
                  {tile.value.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}

        {orgLookupError && !error && (
          <p className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
            Organization names couldn&apos;t be loaded ({orgLookupError}), so rows show organization IDs.
          </p>
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <SearchInput value={search} onChange={setSearch} placeholder="Search by organization or key…" className="w-full sm:max-w-sm" />
          <Select
            value={windowFilter}
            onChange={setWindowFilter}
            options={windows.map((w) => ({ value: w, label: describeWindow(w) }))}
            placeholder="All periods"
            aria-label="Filter by period"
            className="w-full sm:w-52"
          />
          <Select
            value={graceFilter}
            onChange={setGraceFilter}
            options={GRACE_FILTER_OPTIONS}
            placeholder="Any limit state"
            aria-label="Filter by soft-limit state"
            className="w-full sm:w-52"
          />
          {filtered && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          )}
        </div>

        {error ? (
          <ErrorState message={error} onRetry={() => load()} title="Unable to load usage diagnostics" />
        ) : (
          <SectionCard
            variant="hero"
            accent="violet"
            icon={Gauge}
            title="Usage Counters"
            description="Most recently updated first."
            meta={filtered ? `${rows.length.toLocaleString()} of ${counters.length.toLocaleString()} shown` : undefined}
          >
            {loading && counters.length === 0 ? (
              <Spinner />
            ) : (
              <DataTable
                columns={columns}
                data={rows}
                loading={loading && counters.length === 0}
                rowKey={(row) => row.id}
                emptyTitle={filtered && counters.length > 0 ? "No counters match" : "No usage counters yet"}
                emptyMessage={
                  filtered && counters.length > 0
                    ? "Try a different search, period or limit state."
                    : "No feature with a numeric limit has been used yet."
                }
                emptyAction={
                  filtered && counters.length > 0 ? (
                    <Button variant="secondary" onClick={clearFilters}>Clear filters</Button>
                  ) : null
                }
                minWidth={960}
              />
            )}
          </SectionCard>
        )}
      </div>
    </div>
  );
}
