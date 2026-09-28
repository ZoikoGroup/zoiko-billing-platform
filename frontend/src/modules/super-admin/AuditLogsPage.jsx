import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ScrollText,
  Filter,
  RotateCcw,
  Repeat,
  ShieldCheck,
  Settings2,
  Download,
  ArrowRight,
  ChevronDown,
  Code2,
} from "lucide-react";
import {
  listPlatformAuditLogs,
  listSubscriptionAuditLogs,
  listCommercialAccounts,
  listSuperAdminUsers,
} from "../../service/commercialService";
import { PageHeader, DataTable, Modal, Select, SearchInput, Button, Field, HubTabs, SectionCard } from "../../components/billing-ui";
import { Pagination, ErrorState, SuccessMessage } from "../../components/billing-shared";
import { downloadCSV } from "../../utils/export-helpers";
import {
  PAGE_SIZE,
  AUDIT_ACTION_OPTIONS,
  AUDIT_ENTITY_OPTIONS,
  AuditActionBadge,
  SubscriptionLifecycleBadge,
  formatDateTime,
  displayValue,
} from "./constants";
import GovernancePage from "./GovernancePage";
import ConfigurationGovernancePage from "./ConfigurationGovernancePage";

// The audit feeds have no CSV/export endpoint server-side and cap a single
// page at 200 rows, so export walks the paginated feed from the browser. Hard
// ceiling so a filter combination matching a million rows can never hang the
// tab — and the ceiling is always stated in the UI, never silently applied.
const EXPORT_PAGE_LIMIT = 200;
const EXPORT_MAX_ROWS = 5000;

const FOCUS_RING = "focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50";

/* ------------------------------------------------------------------ *
 * Before/after evidence diff
 * ------------------------------------------------------------------ */

// Field names the raw payload uses that a reader shouldn't have to decode.
const FIELD_LABELS = {
  plan_id: "Plan",
  organization_id: "Organization",
  organization_name: "Organization name",
  organization_code: "Organization code",
  entity_id: "Entity",
  entity_type: "Entity type",
  subscription_id: "Subscription",
  commercial_plan_id: "Plan",
};

function humanizeField(key) {
  if (FIELD_LABELS[key]) return FIELD_LABELS[key];
  return String(key)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\w/, (c) => c.toUpperCase());
}

function formatDiffValue(value) {
  if (value === null) return "null";
  if (value === undefined) return "—";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a === "object" || typeof b === "object") {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

const CHANGE_META = {
  added: { label: "Added", chip: "bg-emerald-100 text-emerald-700", before: "not set" },
  removed: { label: "Removed", chip: "bg-red-100 text-red-700", after: "removed" },
  changed: { label: "Changed", chip: "bg-amber-100 text-amber-700" },
  unchanged: { label: "Unchanged", chip: "bg-slate-100 text-slate-600" },
};

function buildDiffRows(oldValues, newValues) {
  const oldObj = oldValues && typeof oldValues === "object" ? oldValues : {};
  const newObj = newValues && typeof newValues === "object" ? newValues : {};
  const keys = Array.from(new Set([...Object.keys(oldObj), ...Object.keys(newObj)]));
  return keys.map((key) => {
    const inOld = Object.prototype.hasOwnProperty.call(oldObj, key);
    const inNew = Object.prototype.hasOwnProperty.call(newObj, key);
    const change = !inOld ? "added" : !inNew ? "removed" : sameValue(oldObj[key], newObj[key]) ? "unchanged" : "changed";
    return { key, label: humanizeField(key), change, oldValue: oldObj[key], newValue: newObj[key] };
  });
}

/**
 * The evidence view for a single audit record: one row per field in the union
 * of old_values / new_values, humanized, before → after, labelled Added /
 * Removed / Unchanged. The exact raw payloads stay available in a collapsed
 * disclosure underneath for anyone who needs the literal JSON (developers,
 * copy-paste of an exact value) — they just no longer lead.
 */
function AuditValueDiff({ oldValues, newValues }) {
  const rows = buildDiffRows(oldValues, newValues);
  const changedCount = rows.filter((r) => r.change !== "unchanged").length;

  return (
    <SectionCard
      variant="standard"
      accent="slate"
      title="Field changes"
      meta={
        rows.length === 0
          ? "No field-level changes recorded"
          : `${changedCount} changed · ${rows.length - changedCount} unchanged`
      }
    >
      {rows.length === 0 ? (
        <p className="text-sm italic text-slate-500">
          This record carries no old/new state payload — it logs an event, not a mutation.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-slate-100">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-[11px] uppercase tracking-wider text-slate-500">
                <th scope="col" className="px-4 py-2.5 font-semibold">Field</th>
                <th scope="col" className="px-4 py-2.5 font-semibold">Before</th>
                <th scope="col" className="px-4 py-2.5 font-semibold">After</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const meta = CHANGE_META[row.change];
                return (
                  <tr key={row.key} className="border-b border-slate-100 last:border-0 align-top">
                    <th scope="row" className="px-4 py-3 font-semibold text-slate-700">
                      <span className="block">{row.label}</span>
                      {row.change !== "changed" && (
                        <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${meta.chip}`}>
                          {meta.label}
                        </span>
                      )}
                    </th>
                    <td className="px-4 py-3 text-slate-500">
                      {row.change === "added" ? (
                        <span className="italic text-slate-400">{meta.before}</span>
                      ) : (
                        <span className="break-words line-through decoration-slate-300">
                          {formatDiffValue(row.oldValue)}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {row.change === "removed" ? (
                        <span className="italic text-slate-400">{meta.after}</span>
                      ) : (
                        <span className="block break-words font-semibold text-slate-800">
                          <span className="inline-flex items-center gap-1.5">
                            {row.change !== "added" && (
                              <ArrowRight size={13} className="shrink-0 text-brand-500" aria-hidden="true" />
                            )}
                            {formatDiffValue(row.newValue)}
                          </span>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

function RawJsonDisclosure({ blocks }) {
  const present = blocks.filter((b) => b.value !== null && b.value !== undefined);
  if (present.length === 0) return null;
  return (
    <details className="group rounded-2xl border border-slate-200 bg-slate-50/60">
      <summary
        className={`flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-xs font-semibold uppercase tracking-wider text-slate-600 hover:text-slate-800 ${FOCUS_RING}`}
      >
        <Code2 size={14} className="text-slate-400" />
        Raw JSON
        <ChevronDown size={14} className="ml-auto text-slate-400 transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-3 border-t border-slate-200 px-4 py-4">
        {present.map((block) => (
          <div key={block.label}>
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-500">{block.label}</p>
            <pre className="max-h-56 overflow-auto rounded-lg bg-white p-3 text-xs leading-5 text-slate-700">
              {JSON.stringify(block.value, null, 2)}
            </pre>
          </div>
        ))}
      </div>
    </details>
  );
}

function DetailSummary({ children }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-xl border border-slate-200 bg-slate-50/60 p-4 text-xs text-slate-600">
      {children}
    </div>
  );
}

function ChangeSummary({ log }) {
  const hasNew = log.new_values && Object.keys(log.new_values).length > 0;
  const hasOld = log.old_values && Object.keys(log.old_values).length > 0;
  if (!hasNew && !hasOld) {
    return <span className="text-xs text-slate-500">—</span>;
  }
  const keys = buildDiffRows(log.old_values, log.new_values).filter((r) => r.change !== "unchanged");
  if (keys.length === 0) {
    return <span className="text-xs text-slate-500">—</span>;
  }
  return (
    <span className="text-xs text-slate-500" title={keys.map((k) => k.key).join(", ")}>
      {keys.map((k) => k.label).join(", ")}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Quick date ranges
 * ------------------------------------------------------------------ */

const DATE_PRESETS = [
  { key: "today", label: "Today" },
  { key: "last_7_days", label: "Last 7 days" },
  { key: "last_30_days", label: "Last 30 days" },
  { key: "custom", label: "Custom" },
];

function isoDay(date) {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

// Inclusive day bounds, matching the backend's date_from/date_to semantics
// (both are compared against midnight-anchored local day starts).
function presetBounds(presetKey) {
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (presetKey === "today") return { from: isoDay(start), to: isoDay(start) };
  if (presetKey === "last_7_days") {
    const from = new Date(start);
    from.setDate(from.getDate() - 6);
    return { from: isoDay(from), to: isoDay(start) };
  }
  if (presetKey === "last_30_days") {
    const from = new Date(start);
    from.setDate(from.getDate() - 29);
    return { from: isoDay(from), to: isoDay(start) };
  }
  return null;
}

function detectPreset(dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return "custom";
  const match = DATE_PRESETS.find((preset) => {
    const bounds = presetBounds(preset.key);
    return bounds && bounds.from === dateFrom && bounds.to === dateTo;
  });
  return match ? match.key : "custom";
}

/* ------------------------------------------------------------------ *
 * Shared filter bar — used by both audit tabs
 * ------------------------------------------------------------------ */

/**
 * One filter bar for both audit tabs, parameterized by which extra fields the
 * tab has (Platform Events adds Action + Entity type). Extracted because the
 * two tabs previously carried copy-pasted bars that could drift apart — the
 * quick-date-range presets in particular only stay correct in one place.
 */
function AuditFilterBar({
  idPrefix,
  search,
  onSearchChange,
  searchPlaceholder,
  organizationId,
  onOrganizationChange,
  orgOptions,
  actorId,
  onActorChange,
  actorOptions,
  dateFrom,
  dateTo,
  onDateFromChange,
  onDateToChange,
  showAction = false,
  action = "",
  onActionChange,
  showEntityType = false,
  entityType = "",
  onEntityTypeChange,
  onReset,
  onExport,
  exporting = false,
  exportBlockedReason = null,
  optionsError = null,
  onRetryOptions,
}) {
  const activePreset = detectPreset(dateFrom, dateTo);

  const applyPreset = (presetKey) => {
    if (presetKey === "custom") return;
    const bounds = presetBounds(presetKey);
    if (!bounds) return;
    onDateFromChange(bounds.from);
    onDateToChange(bounds.to);
  };

  return (
    <SectionCard
      variant="standard"
      accent="slate"
      icon={Filter}
      title="Filters"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            icon={Download}
            onClick={onExport}
            loading={exporting}
            title={
              exportBlockedReason ||
              `Export the rows matching these filters as CSV (up to ${EXPORT_MAX_ROWS.toLocaleString()} rows)`
            }
          >
            {exporting ? "Exporting…" : "Export CSV"}
          </Button>
          <Button size="sm" variant="ghost" icon={RotateCcw} onClick={onReset}>
            Reset
          </Button>
        </div>
      }
    >
      {exportBlockedReason && (
        <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {exportBlockedReason}
        </p>
      )}

      {optionsError && (
        <p className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <span>{optionsError}</span>
          {onRetryOptions && (
            <button type="button" onClick={onRetryOptions} className="font-semibold underline">
              Retry
            </button>
          )}
        </p>
      )}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-600">Date range</span>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick date range">
          {DATE_PRESETS.map((preset) => {
            const active = activePreset === preset.key;
            return (
              <button
                key={preset.key}
                type="button"
                onClick={() => applyPreset(preset.key)}
                aria-pressed={active}
                className={`rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors ${FOCUS_RING} ${
                  active
                    ? "border-brand-500 bg-brand-50 text-brand-700"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
        {activePreset === "custom" && (
          <span className="text-xs text-slate-500">
            {dateFrom || dateTo ? "Custom range — set the bounds below." : "All dates — set the bounds below."}
          </span>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Field label="Search" htmlFor={`${idPrefix}-search`}>
          <SearchInput id={`${idPrefix}-search`} value={search} onChange={onSearchChange} placeholder={searchPlaceholder} />
        </Field>
        {showAction && (
          <Field label="Action" htmlFor={`${idPrefix}-action`}>
            <Select
              id={`${idPrefix}-action`}
              value={action}
              onChange={onActionChange}
              options={AUDIT_ACTION_OPTIONS}
              placeholder="All actions"
            />
          </Field>
        )}
        {showEntityType && (
          <Field label="Entity type" htmlFor={`${idPrefix}-entity`}>
            <Select
              id={`${idPrefix}-entity`}
              value={entityType}
              onChange={onEntityTypeChange}
              options={AUDIT_ENTITY_OPTIONS}
              placeholder="All entities"
            />
          </Field>
        )}
        <Field label="Organization" htmlFor={`${idPrefix}-org`}>
          <Select
            id={`${idPrefix}-org`}
            value={organizationId}
            onChange={onOrganizationChange}
            options={orgOptions}
            placeholder="All organizations"
          />
        </Field>
        <Field label="Actor" htmlFor={`${idPrefix}-actor`}>
          <Select
            id={`${idPrefix}-actor`}
            value={actorId}
            onChange={onActorChange}
            options={actorOptions}
            placeholder="All actors"
          />
        </Field>
        {activePreset === "custom" && (
          <>
            <Field label="From" htmlFor={`${idPrefix}-date-from`}>
              <input
                id={`${idPrefix}-date-from`}
                type="date"
                value={dateFrom}
                onChange={(e) => onDateFromChange(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
              />
            </Field>
            <Field label="To" htmlFor={`${idPrefix}-date-to`}>
              <input
                id={`${idPrefix}-date-to`}
                type="date"
                value={dateTo}
                onChange={(e) => onDateToChange(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700 focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
              />
            </Field>
          </>
        )}
      </div>
    </SectionCard>
  );
}

/* ------------------------------------------------------------------ *
 * Tabs
 * ------------------------------------------------------------------ */

const TABS = [
  { key: "platform", label: "Platform Events" },
  { key: "subscriptions", label: "Subscription Activity" },
];

function TabBar({ tab, onChange }) {
  return (
    <div className="inline-flex flex-wrap rounded-xl border border-slate-200 bg-white p-1" role="tablist" aria-label="Audit feeds">
      {TABS.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={tab === t.key}
          onClick={() => onChange(t.key)}
          className={`rounded-lg px-3.5 py-1.5 text-sm font-semibold transition-colors ${FOCUS_RING} ${
            tab === t.key ? "bg-brand-600 text-white" : "text-slate-600 hover:bg-slate-50"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// This hub ("Audit & Evidence" in the flat Reporting sidebar section) also
// absorbs the two standalone governance pages that conceptually belong here
// as in-page tabs, deep-linkable via ?tab=. Their own standalone routes
// (/super-admin/governance/data, /super-admin/governance/configuration)
// keep working unchanged — this hub just offers a second path to the same
// components, which render with `embedded` so only the hub's header shows.
//
// Each tab carries its own title/description: the header used to branch on
// the URL path only, so switching tabs left a header describing a different
// tab sitting directly above the embedded page's own header. The former
// `/super-admin/governance/security-events` alias is now a redirect in
// App.jsx (it rendered this identical feed under a "Security Events" title
// with no filter actually isolating security events).
const HUB_TABS = [
  {
    key: "audit",
    label: "Audit Logs",
    icon: ScrollText,
    title: "Audit & Evidence",
    description:
      "Platform-plane audit trail plus subscription lifecycle activity across all organizations.",
  },
  {
    key: "data-governance",
    label: "Data Governance",
    icon: ShieldCheck,
    title: "Data Governance",
    description:
      "Attention queue, circuit-breaker safety controls and the cross-cutting governance links — oversight, not a financial view.",
  },
  {
    key: "configuration-governance",
    label: "Configuration Governance",
    icon: Settings2,
    title: "Configuration Governance",
    description:
      "Authoritative inventory of the configuration governing this control plane: platform settings, operational thresholds and environment capabilities.",
  },
];
const VALID_HUB_TABS = HUB_TABS.map((t) => t.key);

const PLATFORM_EXPORT_HEADERS = [
  "id",
  "created_at",
  "actor_email",
  "actor_role",
  "action",
  "entity_type",
  "entity_id",
  "organization_id",
  "organization_name",
  "reason",
  "correlation_id",
  "old_values",
  "new_values",
  "metadata",
];

const SUBSCRIPTION_EXPORT_HEADERS = [
  "id",
  "created_at",
  "actor_email",
  "action",
  "lifecycle_event",
  "subscription_id",
  "organization_id",
  "organization_name",
  "organization_code",
  "old_values",
  "new_values",
];

function platformExportRow(log) {
  return [
    log.id,
    log.created_at,
    log.actor_email,
    log.actor_role,
    log.action,
    log.entity_type,
    log.entity_id,
    log.organization_id,
    log.organization_name,
    log.reason,
    log.correlation_id,
    JSON.stringify(log.old_values ?? {}),
    JSON.stringify(log.new_values ?? {}),
    JSON.stringify(log.metadata ?? {}),
  ];
}

function subscriptionExportRow(log) {
  return [
    log.id,
    log.created_at,
    log.actor_email,
    log.action,
    log.lifecycle_event,
    log.subscription_id,
    log.organization_id,
    log.organization_name,
    log.organization_code,
    JSON.stringify(log.old_values ?? {}),
    JSON.stringify(log.new_values ?? {}),
  ];
}

function todayStamp() {
  return isoDay(new Date());
}

export default function AuditLogsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialHubTab = VALID_HUB_TABS.includes(searchParams.get("tab")) ? searchParams.get("tab") : "audit";
  const [activeHubTab, setActiveHubTabState] = useState(initialHubTab);
  const setActiveHubTab = useCallback(
    (key) => {
      setActiveHubTabState(key);
      setSearchParams({ tab: key }, { replace: true });
    },
    [setSearchParams]
  );
  const activeTabMeta = HUB_TABS.find((t) => t.key === activeHubTab) || HUB_TABS[0];

  const [tab, setTab] = useState("platform");

  // ── Platform Events (PlatformAuditLog: CommercialPlan + Organization) ────
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const [sortDir, setSortDir] = useState("desc");

  const [search, setSearch] = useState("");
  const [action, setAction] = useState("");
  const [entityType, setEntityType] = useState("");
  const [organizationId, setOrganizationId] = useState("");
  const [actorId, setActorId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [orgOptions, setOrgOptions] = useState([]);
  const [actorOptions, setActorOptions] = useState([]);
  const [optionsError, setOptionsError] = useState(null);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);
  const [notice, setNotice] = useState(null);

  const loadFilterOptions = useCallback(() => {
    let cancelled = false;
    setOptionsError(null);
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
        // The feed itself still works without these dropdowns, but an empty
        // Organization/Actor list looks identical to "there are none" — so
        // say so instead of failing silently.
        if (!cancelled) {
          setOptionsError(
            `Organization and actor filter options could not be loaded: ${err?.message || "unknown error"}. Other filters still work.`
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => loadFilterOptions(), [loadFilterOptions]);

  // Filter set (no pagination) — shared by the paged load and the CSV export
  // so what you export is exactly what you are looking at.
  const platformFilters = useMemo(() => {
    const params = { order: sortDir };
    if (search) params.search = search;
    if (action) params.action = action;
    if (entityType) params.entity_type = entityType;
    if (organizationId) params.organization_id = organizationId;
    if (actorId) params.actor_id = actorId;
    if (dateFrom) params.date_from = dateFrom;
    if (dateTo) params.date_to = dateTo;
    return params;
  }, [search, action, entityType, organizationId, actorId, dateFrom, dateTo, sortDir]);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listPlatformAuditLogs({
        ...platformFilters,
        skip: (page - 1) * PAGE_SIZE,
        limit: PAGE_SIZE,
      });
      setLogs(data.logs || []);
      setTotal(data.total || 0);
    } catch (err) {
      setError(err?.message || "Failed to load platform audit logs.");
      setLogs([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [page, platformFilters]);

  useEffect(() => {
    if (tab === "platform") loadLogs();
  }, [tab, loadLogs]);

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

  const onSort = (key) => {
    if (key !== "created_at") return;
    setSortDir((dir) => (dir === "desc" ? "asc" : "desc"));
    setPage(1);
  };

  const columns = useMemo(
    () => [
      {
        key: "created_at",
        label: "Timestamp",
        sortable: true,
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
        hideBelow: "xl",
        render: (row) => (
          <span className="text-xs text-slate-600">
            {row.entity_type}
            {row.entity_id ? <span className="text-slate-500"> #{row.entity_id}</span> : null}
          </span>
        ),
      },
      {
        key: "organization",
        label: "Organization",
        hideBelow: "lg",
        render: (row) => (
          <span className="text-xs text-slate-600">{row.organization_name || "Platform"}</span>
        ),
      },
      {
        key: "changes",
        label: "Changes",
        hideBelow: "xl",
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

  // ── Subscription Activity (billing_audit_logs projection, read-only) ─────
  const [subLogs, setSubLogs] = useState([]);
  const [subTotal, setSubTotal] = useState(0);
  const [subPage, setSubPage] = useState(1);
  const [subLoading, setSubLoading] = useState(true);
  const [subError, setSubError] = useState(null);
  const [subSelected, setSubSelected] = useState(null);
  const [subSortDir, setSubSortDir] = useState("desc");

  const [subSearch, setSubSearch] = useState("");
  const [subOrganizationId, setSubOrganizationId] = useState("");
  const [subActorId, setSubActorId] = useState("");
  const [subDateFrom, setSubDateFrom] = useState("");
  const [subDateTo, setSubDateTo] = useState("");

  const subscriptionFilters = useMemo(() => {
    const params = { order: subSortDir };
    if (subSearch) params.search = subSearch;
    if (subOrganizationId) params.organization_id = subOrganizationId;
    if (subActorId) params.actor_id = subActorId;
    if (subDateFrom) params.date_from = subDateFrom;
    if (subDateTo) params.date_to = subDateTo;
    return params;
  }, [subSearch, subOrganizationId, subActorId, subDateFrom, subDateTo, subSortDir]);

  const loadSubscriptionLogs = useCallback(async () => {
    setSubLoading(true);
    setSubError(null);
    try {
      const data = await listSubscriptionAuditLogs({
        ...subscriptionFilters,
        skip: (subPage - 1) * PAGE_SIZE,
        limit: PAGE_SIZE,
      });
      setSubLogs(data.logs || []);
      setSubTotal(data.total || 0);
    } catch (err) {
      setSubError(err?.message || "Failed to load subscription activity.");
      setSubLogs([]);
      setSubTotal(0);
    } finally {
      setSubLoading(false);
    }
  }, [subPage, subscriptionFilters]);

  useEffect(() => {
    if (tab === "subscriptions") loadSubscriptionLogs();
  }, [tab, loadSubscriptionLogs]);

  const resetSubFilters = () => {
    setSubSearch("");
    setSubOrganizationId("");
    setSubActorId("");
    setSubDateFrom("");
    setSubDateTo("");
    setSubPage(1);
  };

  const onSubSort = (key) => {
    if (key !== "created_at") return;
    setSubSortDir((dir) => (dir === "desc" ? "asc" : "desc"));
    setSubPage(1);
  };

  const subscriptionColumns = useMemo(
    () => [
      {
        key: "created_at",
        label: "Timestamp",
        sortable: true,
        render: (row) => <span className="whitespace-nowrap text-xs text-slate-500">{formatDateTime(row.created_at)}</span>,
      },
      {
        key: "actor",
        label: "Actor",
        render: (row) => <span className="text-xs font-medium text-slate-700">{row.actor_email || "System"}</span>,
      },
      {
        key: "event",
        label: "Event",
        render: (row) => <SubscriptionLifecycleBadge value={row.lifecycle_event} />,
      },
      {
        key: "subscription",
        label: "Subscription",
        hideBelow: "xl",
        render: (row) => (
          <span className="text-xs text-slate-600">
            {row.subscription_id ? <>Subscription <span className="text-slate-500">#{row.subscription_id}</span></> : "—"}
          </span>
        ),
      },
      {
        key: "organization",
        label: "Organization",
        hideBelow: "lg",
        render: (row) => (
          <span>
            <span className="block text-xs font-medium text-slate-700">{row.organization_name}</span>
            <span className="block text-[11px] text-slate-500">{row.organization_code}</span>
          </span>
        ),
      },
      {
        key: "changes",
        label: "Changes",
        hideBelow: "xl",
        render: (row) => <ChangeSummary log={row} />,
      },
      {
        key: "view",
        label: "",
        width: 110,
        render: (row) => (
          <Button size="sm" variant="ghost" onClick={() => setSubSelected(row)}>
            View
          </Button>
        ),
      },
    ],
    []
  );

  const subTotalPages = Math.max(1, Math.ceil(subTotal / PAGE_SIZE));

  /* ── Export ─────────────────────────────────────────────────────────── */

  const runExport = useCallback(async ({ fetchPage, total: matchTotal, headers, toRow, filename }) => {
    setExporting(true);
    setNotice(null);
    setExportError(null);
    try {
      const rows = [];
      let skip = 0;
      while (rows.length < EXPORT_MAX_ROWS) {
        const data = await fetchPage(skip, EXPORT_PAGE_LIMIT);
        const batch = data?.logs || [];
        rows.push(...batch);
        if (batch.length < EXPORT_PAGE_LIMIT) break;
        skip += EXPORT_PAGE_LIMIT;
      }
      if (rows.length === 0) {
        setNotice("No rows matched the current filters — nothing to export.");
        return;
      }
      downloadCSV(rows.map(toRow), headers, filename);
      if (rows.length >= EXPORT_MAX_ROWS && matchTotal > EXPORT_MAX_ROWS) {
        setNotice(
          `Exported the first ${rows.length.toLocaleString()} of ${matchTotal.toLocaleString()} matching rows (export cap ${EXPORT_MAX_ROWS.toLocaleString()}). Narrow the date range to capture the rest.`
        );
      } else {
        setNotice(`Exported ${rows.length.toLocaleString()} row(s) matching the current filters.`);
      }
    } catch (err) {
      // A failed export is an error, not a success notice: routing it through
      // SuccessMessage would paint a rejected request green.
      setNotice(null);
      setExportError(`Export failed: ${err?.message || "unknown error"}`);
    } finally {
      setExporting(false);
    }
  }, []);

  const exportPlatformLogs = useCallback(
    () =>
      runExport({
        fetchPage: (skip, limit) => listPlatformAuditLogs({ ...platformFilters, skip, limit }),
        total,
        headers: PLATFORM_EXPORT_HEADERS,
        toRow: platformExportRow,
        filename: `platform-audit-logs-${todayStamp()}.csv`,
      }),
    [runExport, platformFilters, total]
  );

  const exportSubscriptionLogs = useCallback(
    () =>
      runExport({
        fetchPage: (skip, limit) => listSubscriptionAuditLogs({ ...subscriptionFilters, skip, limit }),
        total: subTotal,
        headers: SUBSCRIPTION_EXPORT_HEADERS,
        toRow: subscriptionExportRow,
        filename: `subscription-audit-logs-${todayStamp()}.csv`,
      }),
    [runExport, subscriptionFilters, subTotal]
  );

  const sortNote = (dir) =>
    dir === "desc"
      ? "Sorted by timestamp, newest first — server-side, across the whole filtered set."
      : "Sorted by timestamp, oldest first — server-side, across the whole filtered set.";

  // The cap notice names the first rows the export will actually contain, which
  // depends on the current sort — hardcoding "newest first" would lie whenever
  // the operator has flipped the feed to oldest-first.
  const firstRowsLabel = (dir) => (dir === "desc" ? "newest first" : "oldest first");
  const platformExportNote =
    total > EXPORT_MAX_ROWS
      ? `${total.toLocaleString()} rows match these filters; CSV export is capped at ${EXPORT_MAX_ROWS.toLocaleString()} rows, ${firstRowsLabel(sortDir)}.`
      : null;
  const subExportNote =
    subTotal > EXPORT_MAX_ROWS
      ? `${subTotal.toLocaleString()} rows match these filters; CSV export is capped at ${EXPORT_MAX_ROWS.toLocaleString()} rows, ${firstRowsLabel(subSortDir)}.`
      : null;

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title={activeTabMeta.title}
        description={activeTabMeta.description}
        icon={activeTabMeta.icon}
        accent="slate"
        meta={
          activeHubTab === "audit" ? (
            tab === "platform" ? (
              <span>
                {displayValue(total)} log(s) match the current filters
                {total > 0 && ` · ${sortNote(sortDir)}`}
              </span>
            ) : (
              <span>
                {displayValue(subTotal)} event(s) match the current filters
                {subTotal > 0 && ` · ${sortNote(subSortDir)}`}
              </span>
            )
          ) : null
        }
      />

      <HubTabs tabs={HUB_TABS} active={activeHubTab} onChange={setActiveHubTab} label="Audit & Evidence sections" accent="slate" />

      {activeHubTab === "data-governance" ? (
        <div className="mt-6">
          <GovernancePage embedded />
        </div>
      ) : activeHubTab === "configuration-governance" ? (
        <div className="mt-6">
          <ConfigurationGovernancePage embedded />
        </div>
      ) : (
        <>
          <div className="mt-6">
            <TabBar tab={tab} onChange={setTab} />
          </div>

          {notice && (
            <div className="mt-4">
              <SuccessMessage message={notice} onDismiss={() => setNotice(null)} />
            </div>
          )}

          {exportError && (
            <div
              role="alert"
              className="mt-4 flex items-start justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 p-4"
            >
              <p className="text-sm font-semibold text-red-700">{exportError}</p>
              <button
                type="button"
                onClick={() => setExportError(null)}
                className="shrink-0 text-xs font-semibold text-red-600 hover:text-red-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
              >
                Dismiss
              </button>
            </div>
          )}

          {tab === "platform" ? (
            <div className="mt-4 space-y-4">
              {error ? (
                <SectionCard variant="hero" accent="slate">
                  <ErrorState message={error} onRetry={loadLogs} title="Unable to load platform audit logs" />
                </SectionCard>
              ) : (
                <>
                  <AuditFilterBar
                    idPrefix="audit"
                    search={search}
                    onSearchChange={(value) => {
                      setSearch(value);
                      setPage(1);
                    }}
                    searchPlaceholder="Entity or action…"
                    organizationId={organizationId}
                    onOrganizationChange={(value) => {
                      setOrganizationId(value);
                      setPage(1);
                    }}
                    orgOptions={orgOptions}
                    actorId={actorId}
                    onActorChange={(value) => {
                      setActorId(value);
                      setPage(1);
                    }}
                    actorOptions={actorOptions}
                    dateFrom={dateFrom}
                    dateTo={dateTo}
                    onDateFromChange={(value) => {
                      setDateFrom(value);
                      setPage(1);
                    }}
                    onDateToChange={(value) => {
                      setDateTo(value);
                      setPage(1);
                    }}
                    showAction
                    action={action}
                    onActionChange={(value) => {
                      setAction(value);
                      setPage(1);
                    }}
                    showEntityType
                    entityType={entityType}
                    onEntityTypeChange={(value) => {
                      setEntityType(value);
                      setPage(1);
                    }}
                    onReset={resetFilters}
                    onExport={exportPlatformLogs}
                    exporting={exporting}
                    exportBlockedReason={platformExportNote}
                    optionsError={optionsError}
                    onRetryOptions={loadFilterOptions}
                  />

                  <SectionCard variant="hero" accent="slate" title="Platform Events">
                    <DataTable
                      columns={columns}
                      data={logs}
                      loading={loading}
                      sortKey="created_at"
                      sortDir={sortDir}
                      onSort={onSort}
                      onRowClick={(row) => setSelected(row)}
                      rowKey={(row) => row.id}
                      emptyTitle="No audit logs match these filters"
                      emptyMessage="Super Admin commercial and organization mutations appear here once they happen. Widen the date range or reset the filters to see older activity."
                      minWidth={720}
                    />

                    <div className="mt-4">
                      <Pagination page={page} totalPages={totalPages} onPageChange={setPage}>
                        {displayValue(total)} log(s)
                      </Pagination>
                    </div>
                  </SectionCard>
                </>
              )}
            </div>
          ) : (
            <div className="mt-4 space-y-4">
              <p className="text-xs text-slate-500">
                Subscription lifecycle mutations are recorded in the org-scoped billing audit trail (not the platform-plane
                table above) since they are tenant-facing billing events. This is a read-only, cross-organization view over
                the same records.
              </p>

              {subError ? (
                <SectionCard variant="hero" accent="slate">
                  <ErrorState
                    message={subError}
                    onRetry={loadSubscriptionLogs}
                    title="Unable to load subscription activity"
                  />
                </SectionCard>
              ) : (
                <>
                  <AuditFilterBar
                    idPrefix="sub-audit"
                    search={subSearch}
                    onSearchChange={(value) => {
                      setSubSearch(value);
                      setSubPage(1);
                    }}
                    searchPlaceholder="Organization name or code…"
                    organizationId={subOrganizationId}
                    onOrganizationChange={(value) => {
                      setSubOrganizationId(value);
                      setSubPage(1);
                    }}
                    orgOptions={orgOptions}
                    actorId={subActorId}
                    onActorChange={(value) => {
                      setSubActorId(value);
                      setSubPage(1);
                    }}
                    actorOptions={actorOptions}
                    dateFrom={subDateFrom}
                    dateTo={subDateTo}
                    onDateFromChange={(value) => {
                      setSubDateFrom(value);
                      setSubPage(1);
                    }}
                    onDateToChange={(value) => {
                      setSubDateTo(value);
                      setSubPage(1);
                    }}
                    onReset={resetSubFilters}
                    onExport={exportSubscriptionLogs}
                    exporting={exporting}
                    exportBlockedReason={subExportNote}
                    optionsError={optionsError}
                    onRetryOptions={loadFilterOptions}
                  />

                  <SectionCard variant="hero" accent="slate" title="Subscription Activity">
                    <DataTable
                      columns={subscriptionColumns}
                      data={subLogs}
                      loading={subLoading}
                      sortKey="created_at"
                      sortDir={subSortDir}
                      onSort={onSubSort}
                      onRowClick={(row) => setSubSelected(row)}
                      rowKey={(row) => row.id}
                      emptyTitle="No subscription activity matches these filters"
                      emptyMessage="Subscription creation and lifecycle transitions appear here once they happen. Widen the date range or reset the filters to see older activity."
                      minWidth={720}
                    />

                    <div className="mt-4">
                      <Pagination page={subPage} totalPages={subTotalPages} onPageChange={setSubPage}>
                        {displayValue(subTotal)} event(s)
                      </Pagination>
                    </div>
                  </SectionCard>
                </>
              )}
            </div>
          )}
        </>
      )}

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
            <DetailSummary>
              <span><span className="font-semibold text-slate-700">Action:</span> <AuditActionBadge value={selected.action} /></span>
              <span><span className="font-semibold text-slate-700">Entity:</span> {selected.entity_type}{selected.entity_id ? ` #${selected.entity_id}` : ""}</span>
              <span><span className="font-semibold text-slate-700">Organization:</span> {selected.organization_name || "Platform"}</span>
              <span><span className="font-semibold text-slate-700">Actor:</span> {selected.actor_email || "System"}{selected.actor_role ? ` (${selected.actor_role})` : ""}</span>
              <span><span className="font-semibold text-slate-700">Timestamp:</span> {formatDateTime(selected.created_at)}</span>
              {selected.reason && <span><span className="font-semibold text-slate-700">Reason:</span> {selected.reason}</span>}
              {selected.correlation_id && <span><span className="font-semibold text-slate-700">Correlation ID:</span> {selected.correlation_id}</span>}
            </DetailSummary>
            <AuditValueDiff oldValues={selected.old_values} newValues={selected.new_values} />
            <RawJsonDisclosure
              blocks={[
                { label: "old_values", value: selected.old_values },
                { label: "new_values", value: selected.new_values },
                { label: "metadata", value: selected.metadata },
              ]}
            />
          </div>
        )}
      </Modal>

      <Modal
        open={Boolean(subSelected)}
        onClose={() => setSubSelected(null)}
        title="Subscription activity detail"
        description={subSelected ? `Subscription #${subSelected.subscription_id} — ${subSelected.lifecycle_event}` : ""}
        icon={Repeat}
        size="lg"
        footer={
          <div className="flex justify-end">
            <Button variant="primary" onClick={() => setSubSelected(null)}>Close</Button>
          </div>
        }
      >
        {subSelected && (
          <div className="space-y-4">
            <DetailSummary>
              <span><span className="font-semibold text-slate-700">Event:</span> <SubscriptionLifecycleBadge value={subSelected.lifecycle_event} /></span>
              <span><span className="font-semibold text-slate-700">Subscription:</span> #{subSelected.subscription_id}</span>
              <span><span className="font-semibold text-slate-700">Organization:</span> {subSelected.organization_name} ({subSelected.organization_code})</span>
              <span><span className="font-semibold text-slate-700">Actor:</span> {subSelected.actor_email || "System"}</span>
              <span><span className="font-semibold text-slate-700">Timestamp:</span> {formatDateTime(subSelected.created_at)}</span>
            </DetailSummary>
            <AuditValueDiff oldValues={subSelected.old_values} newValues={subSelected.new_values} />
            <RawJsonDisclosure
              blocks={[
                { label: "old_values", value: subSelected.old_values },
                { label: "new_values", value: subSelected.new_values },
              ]}
            />
          </div>
        )}
      </Modal>
    </div>
  );
}
