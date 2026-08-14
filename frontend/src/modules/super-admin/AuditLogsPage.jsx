import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollText, Filter, RotateCcw } from "lucide-react";
import {
  listPlatformAuditLogs,
  listCommercialAccounts,
  listSuperAdminUsers,
} from "../../service/commercialService";
import { PageHeader, DataTable, Modal, Select, SearchInput, Button, Field } from "../../components/billing-ui";
import { Pagination, ErrorState, Spinner } from "../../components/billing-shared";
import {
  PAGE_SIZE,
  AUDIT_ACTION_OPTIONS,
  AUDIT_ENTITY_OPTIONS,
  AuditActionBadge,
  formatDateTime,
  displayValue,
} from "./constants";

function StateBlock({ title, value }) {
  const empty =
    value === null || value === undefined || (typeof value === "object" && Object.keys(value).length === 0);
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
      <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">{title}</p>
      {empty ? (
        <p className="text-sm italic text-slate-400">No state change recorded.</p>
      ) : (
        <pre className="max-h-64 overflow-auto rounded-lg bg-white p-3 text-xs leading-5 text-slate-700">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}

function ChangeSummary({ log }) {
  const hasNew = log.new_values && Object.keys(log.new_values).length > 0;
  const hasOld = log.old_values && Object.keys(log.old_values).length > 0;
  if (!hasNew && !hasOld) {
    return <span className="text-xs text-slate-400">—</span>;
  }
  const keys = Object.keys(log.new_values || log.old_values || {});
  return <span className="text-xs text-slate-500">{keys.join(", ")}</span>;
}

export default function AuditLogsPage() {
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);

  const [search, setSearch] = useState("");
  const [action, setAction] = useState("");
  const [entityType, setEntityType] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [actorId, setActorId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [orgOptions, setOrgOptions] = useState([]);
  const [actorOptions, setActorOptions] = useState([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [orgs, users] = await Promise.all([
          listCommercialAccounts({ limit: 200 }),
          listSuperAdminUsers({ limit: 200 }),
        ]);
        if (cancelled) return;
        setOrgOptions(
          (orgs.accounts || []).map((a) => ({ value: a.organization_id, label: a.organization_name }))
        );
        setActorOptions((users.users || []).map((u) => ({ value: u.id, label: u.email })));
      } catch (err) {
        // Filter options are best-effort; the feed itself still works.
        console.error("Failed to load audit filter options", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = { skip: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE };
      if (search) params.search = search;
      if (action) params.action = action;
      if (entityType) params.entity_type = entityType;
      if (organizationId) params.organization_id = organizationId;
      if (actorId) params.actor_id = actorId;
      if (dateFrom) params.date_from = dateFrom;
      if (dateTo) params.date_to = dateTo;
      const data = await listPlatformAuditLogs(params);
      setLogs(data.logs || []);
      setTotal(data.total || 0);
    } catch (err) {
      setError(err?.message || "Failed to load platform audit logs.");
      setLogs([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [page, search, action, entityType, organizationId, actorId, dateFrom, dateTo]);

  useEffect(() => {
    loadLogs();
  }, [loadLogs]);

  const resetFilters = () => {
    setSearch("");
    setAction("");
    setEntityType("");
    setOrganizationId("");
    setActorId("");
    setDateFrom("");
    setDateTo("");
    setPage(1);
  };

  const columns = useMemo(
    () => [
      {
        key: "created_at",
        label: "Timestamp",
        render: (row) => <span className="whitespace-nowrap text-xs text-slate-500">{formatDateTime(row.created_at)}</span>,
      },
      {
        key: "actor",
        label: "Actor",
        render: (row) => (
          <span className="text-xs font-medium text-slate-700">{row.actor_email || "System"}</span>
        ),
      },
      {
        key: "action",
        label: "Action",
        render: (row) => <AuditActionBadge value={row.action} />,
      },
      {
        key: "entity",
        label: "Entity",
        render: (row) => (
          <span className="text-xs text-slate-600">
            {row.entity_type}
            {row.entity_id ? <span className="text-slate-400"> #{row.entity_id}</span> : null}
          </span>
        ),
      },
      {
        key: "organization",
        label: "Organization",
        render: (row) => (
          <span className="text-xs text-slate-600">{row.organization_name || "Platform"}</span>
        ),
      },
      {
        key: "changes",
        label: "Changes",
        render: (row) => <ChangeSummary log={row} />,
      },
      {
        key: "view",
        label: "",
        width: 110,
        render: (row) => (
          <Button size="sm" variant="ghost" onClick={() => setSelected(row)}>
            View
          </Button>
        ),
      },
    ],
    []
  );

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Audit Logs"
        description="Platform-plane audit trail of Super Admin commercial mutations across all organizations."
        icon={ScrollText}
        meta={`${displayValue(total)} log(s)`}
      />

      <div className="mt-6 space-y-4">
        {error && (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
            {error}
            <button type="button" onClick={loadLogs} className="ml-3 font-semibold underline">Retry</button>
          </div>
        )}

        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
              <Filter size={13} className="text-brand-500" />
              Filters
            </div>
            <Button size="sm" variant="ghost" icon={RotateCcw} onClick={resetFilters}>
              Reset
            </Button>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <Field label="Search">
              <SearchInput
                value={search}
                onChange={setSearch}
                placeholder="Entity or action…"
              />
            </Field>
            <Field label="Action">
              <Select
                value={action}
                onChange={setAction}
                options={AUDIT_ACTION_OPTIONS}
                placeholder="All actions"
              />
            </Field>
            <Field label="Entity type">
              <Select
                value={entityType}
                onChange={setEntityType}
                options={AUDIT_ENTITY_OPTIONS}
                placeholder="All entities"
              />
            </Field>
            <Field label="Organization">
              <Select
                value={organizationId}
                onChange={setOrganizationId}
                options={orgOptions}
                placeholder="All organizations"
              />
            </Field>
            <Field label="Actor">
              <Select
                value={actorId}
                onChange={setActorId}
                options={actorOptions}
                placeholder="All actors"
              />
            </Field>
            <Field label="From">
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
              />
            </Field>
            <Field label="To">
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
              />
            </Field>
          </div>
        </div>

        {loading && logs.length === 0 ? (
          <Spinner />
        ) : (
          <DataTable
            columns={columns}
            data={logs}
            loading={loading}
            onRowClick={(row) => setSelected(row)}
            rowKey={(row) => row.id}
            emptyTitle="No audit logs yet"
            emptyMessage="Super Admin commercial mutations will appear here once they happen."
            minWidth={920}
          />
        )}

        <Pagination page={page} totalPages={totalPages} onPageChange={setPage}>
          {displayValue(total)} log(s)
        </Pagination>
      </div>

      <Modal
        open={Boolean(selected)}
        onClose={() => setSelected(null)}
        title="Audit log detail"
        description={selected ? `${selected.entity_type}${selected.entity_id ? ` #${selected.entity_id}` : ""} — ${selected.action}` : ""}
        icon={ScrollText}
        size="lg"
        footer={
          <div className="flex justify-end">
            <Button variant="primary" onClick={() => setSelected(null)}>Close</Button>
          </div>
        }
      >
        {selected && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-slate-200 bg-slate-50/60 p-4 text-xs text-slate-600">
              <span><span className="font-semibold text-slate-700">Action:</span> <AuditActionBadge value={selected.action} /></span>
              <span><span className="font-semibold text-slate-700">Entity:</span> {selected.entity_type}{selected.entity_id ? ` #${selected.entity_id}` : ""}</span>
              <span><span className="font-semibold text-slate-700">Organization:</span> {selected.organization_name || "Platform"}</span>
              <span><span className="font-semibold text-slate-700">Actor:</span> {selected.actor_email || "System"}</span>
              <span><span className="font-semibold text-slate-700">Timestamp:</span> {formatDateTime(selected.created_at)}</span>
            </div>
            <StateBlock title="Old values" value={selected.old_values} />
            <StateBlock title="New values" value={selected.new_values} />
            <StateBlock title="Metadata" value={selected.metadata} />
          </div>
        )}
      </Modal>
    </div>
  );
}
