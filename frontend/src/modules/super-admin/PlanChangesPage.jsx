import React, { useCallback, useEffect, useRef, useState } from "react";
import { GitPullRequestArrow, Search, Undo2, X } from "lucide-react";
import {
  listCommercialSubscriptionChanges,
  reverseCommercialSubscriptionChange,
} from "../../service/commercialService";
import { PageHeader, SectionCard, DataTable, Button, Modal, Field, FORM_CONTROL_CLASS } from "../../components/billing-ui";
import { ErrorState, Pagination, SuccessMessage, StatusBadge } from "../../components/billing-shared";
import { PAGE_SIZE, SUBSCRIPTION_CHANGE_STATUS_OPTIONS, formatDateTime, displayValue } from "./constants";

const SUCCESS_DISMISS_MS = 6000;

// "pending" is a construction-time default the backend never leaves at rest
// (SubscriptionChangeStatus docstring), so it isn't offered as a filter.
const FILTER_STATUSES = ["blocked", "scheduled", "applied", "reversed"];
const STATUS_DOTS = { blocked: "bg-red-500", scheduled: "bg-amber-500", applied: "bg-emerald-500", reversed: "bg-slate-400" };

const DIRECTION_LABELS = { upgrade: "Upgrade", downgrade: "Downgrade", expired: "Trial expiry" };

function planLabel(code, id) {
  return code || (id != null ? `Plan #${id}` : "—");
}

function DetailItem({ label, children }) {
  return (
    <div>
      <span className="block text-[11px] font-semibold uppercase tracking-wider text-slate-500">{label}</span>
      <span className="text-sm text-slate-700">{children}</span>
    </div>
  );
}

function PriceImpact({ impact }) {
  if (!impact || typeof impact !== "object") return null;
  const money = (v) => (v === null || v === undefined ? "Not set" : `${impact.currency ? `${impact.currency} ` : ""}${v}`);
  return (
    <div>
      <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-500">Price impact (estimate recorded at request time)</span>
      <div className="grid grid-cols-2 gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 sm:grid-cols-4">
        <DetailItem label="Current price">{money(impact.current_price)}</DetailItem>
        <DetailItem label="Target price">{money(impact.target_price)}</DetailItem>
        <DetailItem label="Days left in period">{displayValue(impact.days_remaining_in_period)}</DetailItem>
        <DetailItem label="Est. period delta">{money(impact.estimated_period_delta)}</DetailItem>
      </div>
      {impact.note && <p className="mt-1.5 text-xs text-slate-500">{impact.note}</p>}
    </div>
  );
}

function ChangeDetail({ change }) {
  if (!change) return null;
  const blockers = Array.isArray(change.blockers) ? change.blockers : [];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <DetailItem label="Change">
          {planLabel(change.from_plan_code, change.from_plan_id)} <span className="text-slate-400">→</span> {planLabel(change.to_plan_code, change.to_plan_id)}
        </DetailItem>
        <DetailItem label="Status">
          <StatusBadge status={change.status} options={SUBSCRIPTION_CHANGE_STATUS_OPTIONS} />
        </DetailItem>
        <DetailItem label="Direction">{DIRECTION_LABELS[change.direction] || change.direction || "—"}</DetailItem>
        <DetailItem label="Subscription">#{change.commercial_subscription_id}</DetailItem>
        <DetailItem label="Requested">
          {formatDateTime(change.requested_at)}
          {change.requested_by_user_id != null && <span className="text-slate-500"> · user #{change.requested_by_user_id}</span>}
        </DetailItem>
        <DetailItem label="Takes effect">{change.effective_at ? formatDateTime(change.effective_at) : "Immediately / not scheduled"}</DetailItem>
        {change.applied_at && <DetailItem label="Applied">{formatDateTime(change.applied_at)}</DetailItem>}
        {change.reversed_at && (
          <DetailItem label="Reversed">
            {formatDateTime(change.reversed_at)}
            {change.reversed_by_user_id != null && <span className="text-slate-500"> · user #{change.reversed_by_user_id}</span>}
          </DetailItem>
        )}
      </div>

      {change.reason && (
        <DetailItem label="Reason">
          <span className="whitespace-pre-wrap">{change.reason}</span>
        </DetailItem>
      )}

      <PriceImpact impact={change.price_impact} />

      <div>
        <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-500">
          Compatibility checklist ({blockers.length} blocker{blockers.length === 1 ? "" : "s"})
        </span>
        {blockers.length === 0 ? (
          <p className="text-xs text-slate-500">No blockers were recorded for this change.</p>
        ) : (
          <ul className="space-y-2">
            {blockers.map((b, i) => (
              <li key={b?.check_id || i} className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                <span className="block font-semibold">{b?.label || b?.check_id || "Blocker"}</span>
                {b?.detail && <span className="block">{b.detail}</span>}
                {(b?.current_count != null || b?.target_limit != null) && (
                  <span className="mt-0.5 block text-red-700">
                    In use: {displayValue(b.current_count)} · Target plan allows: {displayValue(
                      typeof b.target_limit === "object" && b.target_limit !== null ? JSON.stringify(b.target_limit) : b.target_limit
                    )}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ReverseModal({ change, onClose, onSubmit }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const open = Boolean(change);

  useEffect(() => {
    if (open) { setReason(""); setError(null); setBusy(false); }
  }, [open]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy || !reason.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(reason.trim());
      onClose();
    } catch (err) {
      setError(err?.message || "Failed to cancel the scheduled change.");
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title="Cancel scheduled plan change"
      description={
        change
          ? `${planLabel(change.from_plan_code, change.from_plan_id)} → ${planLabel(change.to_plan_code, change.to_plan_id)}${change.effective_at ? `, due ${formatDateTime(change.effective_at)}` : ""}. The subscription stays on its current plan.`
          : undefined
      }
      icon={Undo2}
      tone="danger"
      size="sm"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Reason" htmlFor="reverse-reason" required hint="Recorded in the audit log.">
          <textarea
            id="reverse-reason"
            required
            rows={3}
            maxLength={2000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSubmit(e);
            }}
            className={FORM_CONTROL_CLASS}
          />
        </Field>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Keep scheduled change</Button>
          <Button type="submit" variant="danger" loading={busy} disabled={!reason.trim()}>Cancel change</Button>
        </div>
      </form>
    </Modal>
  );
}

/** Per-status totals that double as the status filter. */
function StatusOverview({ counts, selected, onSelect }) {
  const total = counts ? FILTER_STATUSES.reduce((sum, s) => sum + (counts[s] ?? 0), 0) : null;
  const tiles = [{ key: "", label: "All changes", count: total, dot: "bg-slate-800" }].concat(
    FILTER_STATUSES.map((key) => ({
      key,
      label: SUBSCRIPTION_CHANGE_STATUS_OPTIONS.find((o) => o.value === key)?.label || key,
      count: counts ? counts[key] ?? 0 : null,
      dot: STATUS_DOTS[key],
    }))
  );
  return (
    <div role="group" aria-label="Filter plan changes by status" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {tiles.map((tile) => {
        const active = selected === tile.key;
        return (
          <button
            key={tile.key || "all"}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(tile.key)}
            className={`rounded-2xl border p-3.5 text-left transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 ${
              active ? "border-brand-500 bg-brand-50 shadow-sm" : "border-slate-200 bg-white hover:border-slate-300 hover:shadow-sm"
            }`}
          >
            <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              <span className={`h-2 w-2 rounded-full ${tile.dot}`} aria-hidden="true" />
              {tile.label}
            </span>
            <span className={`mt-1.5 block text-2xl font-extrabold ${active ? "text-brand-700" : "text-slate-800"}`}>
              {tile.count == null ? "—" : tile.count.toLocaleString()}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// `embedded` drops this page's own PageHeader when it is mounted as a tab of
// the Products & Pricing hub.
export default function PlanChangesPage({ embedded = false } = {}) {
  const [changes, setChanges] = useState([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState(null);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [detailTarget, setDetailTarget] = useState(null);
  const [reverseTarget, setReverseTarget] = useState(null);
  const requestRef = useRef(0);

  // The endpoint pages at 50 rows by default; this page used to request no
  // skip/limit and report `changes.length` as the count, so anything past
  // the 50 newest changes silently disappeared.
  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const params = { skip: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE };
      if (statusFilter) params.status = statusFilter;
      const data = await listCommercialSubscriptionChanges(params);
      if (requestId !== requestRef.current) return;
      setChanges(data?.changes || []);
      setTotal(data?.total ?? (data?.changes || []).length);
    } catch (err) {
      if (requestId !== requestRef.current) return;
      setError(err?.message || "Failed to load the plan-change history.");
      setChanges([]);
      setTotal(0);
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [page, statusFilter]);

  const loadCounts = useCallback(async () => {
    try {
      const results = await Promise.all(
        FILTER_STATUSES.map((status) => listCommercialSubscriptionChanges({ status, limit: 1 }))
      );
      const next = {};
      FILTER_STATUSES.forEach((status, i) => { next[status] = results[i]?.total ?? 0; });
      setCounts(next);
    } catch {
      setCounts(null);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    loadCounts();
  }, [loadCounts]);

  useEffect(() => {
    if (!success) return undefined;
    const t = setTimeout(() => setSuccess(null), SUCCESS_DISMISS_MS);
    return () => clearTimeout(t);
  }, [success]);

  const changeStatusFilter = (value) => {
    setStatusFilter(value);
    setPage(1);
  };

  const columns = [
    { key: "id", label: "#", width: 60, render: (row) => <span className="font-mono text-xs text-slate-500">{row.id}</span> },
    {
      key: "plan",
      label: "Plan change",
      render: (row) => (
        <span className="text-xs text-slate-700">
          <span className="font-semibold">{planLabel(row.from_plan_code, row.from_plan_id)}</span> <span className="text-slate-400">→</span>{" "}
          <span className="font-semibold">{planLabel(row.to_plan_code, row.to_plan_id)}</span>
          <span className="block text-slate-500">Subscription #{row.commercial_subscription_id}</span>
        </span>
      ),
    },
    { key: "direction", label: "Direction", render: (row) => <span className="text-xs text-slate-600">{DIRECTION_LABELS[row.direction] || row.direction || "—"}</span> },
    { key: "status", label: "Status", render: (row) => <StatusBadge status={row.status} options={SUBSCRIPTION_CHANGE_STATUS_OPTIONS} /> },
    {
      key: "blockers",
      label: "Blockers",
      numeric: true,
      render: (row) => {
        const count = Array.isArray(row.blockers) ? row.blockers.length : 0;
        return count > 0 ? (
          <span className="text-xs font-semibold text-red-700">{count}</span>
        ) : (
          <span className="text-xs text-slate-400">0</span>
        );
      },
    },
    { key: "requested_at", label: "Requested", render: (row) => <span className="text-xs text-slate-500">{formatDateTime(row.requested_at)}</span> },
    { key: "effective_at", label: "Takes effect", render: (row) => <span className="text-xs text-slate-500">{row.effective_at ? formatDateTime(row.effective_at) : "—"}</span> },
    {
      key: "actions",
      label: "Actions",
      width: 220,
      render: (row) => (
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="secondary" icon={Search} onClick={() => setDetailTarget(row)} aria-label={`View details of plan change #${row.id}`}>Details</Button>
          {/* Only SCHEDULED changes can be reversed (reverse_scheduled_change). */}
          {row.status === "scheduled" && (
            <Button size="sm" variant="danger" icon={X} onClick={() => setReverseTarget(row)} aria-label={`Cancel scheduled plan change #${row.id}`}>Cancel</Button>
          )}
        </div>
      ),
    },
  ];

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const statusLabel = SUBSCRIPTION_CHANGE_STATUS_OPTIONS.find((o) => o.value === statusFilter)?.label;

  return (
    <div className={embedded ? "" : "p-4 sm:p-6 lg:p-8"}>
      <PageHeader
        embedded={embedded}
        accent="violet"
        title="Plan Change History"
        description="Every upgrade and downgrade an organization has attempted — including blocked ones — so you can investigate failed or stuck plan changes and cancel scheduled ones."
        icon={GitPullRequestArrow}
        meta={`${displayValue(total)} change(s)${statusLabel ? ` · ${statusLabel.toLowerCase()}` : ""}`}
      />

      <div className={`space-y-4 ${embedded ? "mt-4" : "mt-6"}`}>
        <StatusOverview counts={counts} selected={statusFilter} onSelect={changeStatusFilter} />

        {success && <SuccessMessage message={success} onDismiss={() => setSuccess(null)} />}

        <SectionCard
          variant="hero"
          accent="violet"
          icon={GitPullRequestArrow}
          title="Change History Log"
          description="Newest first. Open Details to see why a change was blocked; scheduled downgrades can be cancelled before they take effect."
        >
          {/* A failed fetch also clears `changes` to [], so the error replaces
              the table rather than sitting above "No plan changes yet" — a
              failure must not read as an empty history. The status filter
              above stays usable. */}
          {error ? (
            <ErrorState title="Couldn't load plan changes" message={error} onRetry={() => load()} />
          ) : (
            <>
              <DataTable
                columns={columns}
                data={changes}
                loading={loading}
                loadingRows={4}
                rowKey={(row) => row.id}
                emptyTitle={statusFilter ? `No ${statusLabel?.toLowerCase() || statusFilter} plan changes` : "No plan changes yet"}
                emptyMessage={
                  statusFilter
                    ? "Choose “All changes” to see every status."
                    : "Upgrades and downgrades will appear here once a tenant initiates one."
                }
                minWidth={1000}
              />
              <Pagination page={page} totalPages={totalPages} onPageChange={setPage}>
                {displayValue(total)} change(s)
              </Pagination>
            </>
          )}
        </SectionCard>
      </div>

      <Modal
        open={Boolean(detailTarget)}
        onClose={() => setDetailTarget(null)}
        title={`Plan change #${detailTarget?.id ?? ""}`}
        icon={GitPullRequestArrow}
        size="lg"
        footer={
          detailTarget?.status === "scheduled" ? (
            <Button
              variant="danger"
              icon={X}
              onClick={() => {
                setReverseTarget(detailTarget);
                setDetailTarget(null);
              }}
            >
              Cancel this scheduled change
            </Button>
          ) : undefined
        }
      >
        <ChangeDetail change={detailTarget} />
      </Modal>

      <ReverseModal
        change={reverseTarget}
        onClose={() => setReverseTarget(null)}
        onSubmit={async (reason) => {
          await reverseCommercialSubscriptionChange(reverseTarget.id, reason);
          setSuccess(`Scheduled plan change #${reverseTarget.id} cancelled — the subscription stays on ${planLabel(reverseTarget.from_plan_code, reverseTarget.from_plan_id)}.`);
          await Promise.all([load(), loadCounts()]);
        }}
      />
    </div>
  );
}
