import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ShieldCheck, PlayCircle, Check, X, ExternalLink, Calendar, CreditCard, Building2, AlertTriangle } from "lucide-react";
import {
  listReconciliationRuns,
  getReconciliationRun,
  triggerReconciliationRun,
  acknowledgeReconciliationException,
  resolveReconciliationException,
} from "../../service/commandCenterService";
import { listOrganizations } from "../../service/commercialService";
import { PageHeader, DataTable, Button, Modal, Field, Select } from "../../components/billing-ui";
import { ErrorState, Spinner, EmptyState, StatusBadge, SuccessMessage, useConfirmationDialog } from "../../components/billing-shared";
import { OrganizationLink, CurrencyTotals, MaskedValue, SupportAccessNote } from "./PrivacyCells";
import { RECONCILIATION_RUN_STATE_OPTIONS, RECONCILIATION_EXCEPTION_STATUS_OPTIONS } from "./constants";
import useLiveRefresh, { LiveRefreshStatus } from "./useLiveRefresh";

function orgLabel(org) {
  if (!org) return null;
  return `${org.organization_code} — ${org.organization_name}`;
}

// Run/exception timestamps are naive UTC: the columns are `datetime.utcnow()`
// and the router serialises them with str(), e.g. "2026-08-31 10:00:00.123456"
// — no "T", no offset (super_admin/router.py _serialize_reconciliation_run).
// `new Date()` reads that as LOCAL time, so every run showed shifted by the
// viewer's UTC offset. An offset-less value is read as UTC here.
export function parseApiUtc(value) {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).trim().replace(" ", "T");
  const hasTime = /T\d{2}:\d{2}/.test(s);
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/i.test(s);
  // JS Date keeps milliseconds only; trim Python's microseconds.
  const normalised = s.replace(/(\.\d{3})\d+/, "$1");
  const d = new Date(hasTime && !hasOffset ? `${normalised}Z` : normalised);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDateTime(value) {
  const d = parseApiUtc(value);
  if (!d) return "—";
  return d.toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Mirrors backend/app/modules/super_admin/stripe_reconciliation.py's
// MAX_RANGE_DAYS — this is a client-side convenience check only; the
// backend is the actual enforcement authority and re-validates on submit.
const MAX_RECONCILIATION_RANGE_DAYS = 92;

// The viewer's LOCAL calendar date. toISOString() gave the UTC date, which
// east of UTC (e.g. IST before 05:30) is still "yesterday", so today could
// not be picked as the range end.
function todayIso() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Mirrors ReconciliationExceptionActionRequest.note (max_length=500).
const RESOLUTION_NOTE_MAX = 500;
// GET /super-admin/organizations caps `limit` at 200; the scope picker used
// to ask for one page of 200, so organisations past the 200th could never
// be selected. It now pages through (bounded).
const ORG_PAGE_SIZE = 200;
const ORG_MAX_PAGES = 25;

// Backend validation rules (stripe_reconciliation.py / reconciliation_service.py),
// mirrored here for immediate feedback — never the sole guard.
function validateReconciliationRange(compareProcessor, rangeStart, rangeEnd) {
  if (!compareProcessor) return null;
  if (!rangeStart || !rangeEnd) {
    return "Select a start and end date to compare with Stripe.";
  }
  if (rangeStart > rangeEnd) {
    return "Start date must be on or before the end date.";
  }
  const days = Math.round((new Date(rangeEnd) - new Date(rangeStart)) / 86400000);
  if (days > MAX_RECONCILIATION_RANGE_DAYS) {
    return `The reconciliation range cannot exceed ${MAX_RECONCILIATION_RANGE_DAYS} days.`;
  }
  return null;
}

// Uses only backend-provided fields — never claims VERIFIED/reasons the
// backend itself didn't return.
function summarizeRunResult(run) {
  if (run.state === "verified") {
    return `Run #${run.id} VERIFIED — Stripe comparison completed with 0 discrepancies.`;
  }
  if (run.state === "failed") {
    const n = run.exceptions_found;
    return `Run #${run.id} found ${n} discrepanc${n === 1 ? "y" : "ies"} — review below.`;
  }
  if (run.processor_note) {
    return `Run #${run.id} (${run.state}): ${run.processor_note}`;
  }
  return `Run #${run.id} completed — ${run.exceptions_found} exception(s) found.`;
}

const EXCEPTION_KIND_LABELS = {
  invoice_balance_mismatch: "Invoice balance mismatch",
  payment_over_allocation: "Payment over-allocation",
  // ISS-017 — Stripe processor comparison (Phase 11)
  stripe_missing_in_stripe: "Missing in Stripe",
  stripe_missing_in_ledger: "Missing in ledger",
  stripe_amount_mismatch: "Amount mismatch (Stripe)",
  stripe_currency_mismatch: "Currency mismatch (Stripe)",
  stripe_status_mismatch: "Status mismatch (Stripe)",
  stripe_duplicate_processor_record: "Duplicate Stripe record",
  stripe_duplicate_ledger_record: "Duplicate ledger record",
  stripe_identifier_mismatch: "Invalid Stripe identifier",
  stripe_unsupported_mapping: "Unsupported Stripe mapping",
};

function ResolveModal({ open, onClose, onSubmit }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setNote("");
      setError(null);
    }
  }, [open]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy || !note.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(note);
      onClose();
    } catch (err) {
      setError(err?.message || "Failed to resolve the exception.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Resolve exception" icon={Check} size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Resolution note" required>
          <textarea
            required
            rows={3}
            maxLength={RESOLUTION_NOTE_MAX}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
          <p className="mt-1 text-right text-[11px] text-slate-500">
            {note.length}/{RESOLUTION_NOTE_MAX}
          </p>
        </Field>
        {error && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={busy} disabled={busy || !note.trim()}>
            Resolve
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function RunDetailModal({ run, onClose, onRefreshRun, onMutated, orgById }) {
  const [resolveTarget, setResolveTarget] = useState(null);
  // Acknowledge/resolve feedback renders INSIDE this modal. It used to go to
  // the page-level banner, which sits behind the modal overlay — a failed
  // acknowledge was invisible until the modal was closed.
  const [notice, setNotice] = useState(null);
  const [ackBusyId, setAckBusyId] = useState(null);
  const { confirm, ConfirmationDialog } = useConfirmationDialog();

  useEffect(() => {
    if (!notice || notice.error) return undefined;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  // A failed re-fetch after a SUCCESSFUL action must not read as the action
  // failing (the resolve modal would stay open and a retry would hit
  // "already resolved"), so it is reported separately.
  const reloadRun = useCallback(async () => {
    try {
      await onRefreshRun(run.id);
    } catch (err) {
      setNotice({ message: `Saved, but the run could not be reloaded: ${err?.message || "unknown error"}`, error: true });
    }
  }, [onRefreshRun, run]);

  const handleAcknowledge = useCallback(
    async (exception) => {
      if (ackBusyId !== null) return;
      const ok = await confirm({
        title: "Acknowledge this exception?",
        message: "This marks the exception as being worked, without recording a resolution yet.",
        confirmLabel: "Acknowledge",
        tone: "primary",
      });
      if (!ok) return;
      setAckBusyId(exception.id);
      setNotice(null);
      try {
        await acknowledgeReconciliationException(exception.id);
        setNotice({ message: `Exception #${exception.id} acknowledged.` });
        onMutated?.();
        await reloadRun();
      } catch (err) {
        setNotice({ message: err?.message || "Failed to acknowledge the exception.", error: true });
      } finally {
        setAckBusyId(null);
      }
    },
    [ackBusyId, confirm, reloadRun, onMutated]
  );

  const handleResolve = useCallback(
    async (note) => {
      await resolveReconciliationException(resolveTarget.id, note);
      setNotice({ message: `Exception #${resolveTarget.id} resolved.` });
      onMutated?.();
      await reloadRun();
    },
    [resolveTarget, reloadRun, onMutated]
  );

  if (!run) return null;

  return (
    <Modal
      open={Boolean(run)}
      onClose={onClose}
      title={`Reconciliation run #${run.id}`}
      description={`${run.trigger === "scheduled" ? "Scheduled" : "Manual"} run · ${formatDateTime(run.started_at)}`}
      icon={ShieldCheck}
      size="xl"
    >
      <div className="space-y-4">
        {notice &&
          (notice.error ? (
            <p role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              <span className="flex-1">{notice.message}</span>
              <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss error" className="text-red-700">
                <X size={14} />
              </button>
            </p>
          ) : (
            <SuccessMessage message={notice.message} onDismiss={() => setNotice(null)} />
          ))}
        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
          <StatusBadge status={run.state} options={RECONCILIATION_RUN_STATE_OPTIONS} />
          <span>{run.checks_total} check(s) run</span>
          <span>{run.exceptions_found} exception(s) found</span>
          <span>Processor source: {run.processor_source}</span>
          <span>Finished {formatDateTime(run.finished_at)}</span>
          {run.processor_environment && (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 uppercase tracking-wide text-slate-600">
              Stripe {run.processor_environment}
            </span>
          )}
        </div>
        {run.processor_note && <p className="text-xs text-slate-500">{run.processor_note}</p>}
        {run.processor_stats && (
          <div className="space-y-2 rounded-xl border border-slate-100 bg-slate-50 p-3">
            <div className="flex flex-wrap gap-3 text-xs text-slate-600">
              <span>Range: {run.processor_stats.range_start} → {run.processor_stats.range_end}</span>
              <span>{run.processor_stats.records_inspected} record(s) inspected</span>
              <span>{run.processor_stats.records_matched} matched</span>
              <span>{(run.processor_stats.organizations_compared || []).length} organization(s) compared</span>
            </div>
            {(run.processor_stats.processor_errors || []).length > 0 && (
              <ul className="space-y-1 text-xs text-red-700">
                {run.processor_stats.processor_errors.map((err, idx) => (
                  <li key={idx}>
                    <span className="font-semibold">
                      {orgLabel(orgById[err.organization_id]) || `Org ${err.organization_id ?? "—"}`}:
                    </span>{" "}
                    {err.category || err.error_type} — {err.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {(run.exceptions || []).length === 0 ? (
          <EmptyState icon={ShieldCheck} title="No exceptions on this run" message="Every internal ledger invariant checked out clean." />
        ) : (
          <div className="overflow-x-auto rounded-2xl border border-slate-200 sm:max-h-[420px] sm:overflow-y-auto">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-slate-50">
                <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                  <th className="px-3 py-2">Kind</th>
                  <th className="px-3 py-2">Org</th>
                  <th className="px-3 py-2">Record type</th>
                  <th className="px-3 py-2">Detail</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {run.exceptions.map((exc) => (
                  <tr key={exc.id} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-medium text-slate-700">{EXCEPTION_KIND_LABELS[exc.kind] || exc.kind}</td>
                    <td className="px-3 py-2 text-slate-600">
                      {exc.organization_id != null ? (
                        <OrganizationLink
                          organizationId={exc.organization_id}
                          name={exc.organization_name || orgLabel(orgById[exc.organization_id])}
                        />
                      ) : "—"}
                    </td>
                    <td className="px-3 py-2 capitalize text-slate-600">
                      {String(exc.entity_type || "").replaceAll("_", " ")}
                    </td>
                    <td className="px-3 py-2 text-slate-500">
                      <pre className="max-w-[260px] whitespace-pre-wrap break-words text-[10px]">
                        {JSON.stringify(exc.detail, null, 2)}
                      </pre>
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={exc.status} options={RECONCILIATION_EXCEPTION_STATUS_OPTIONS} />
                    </td>
                    <td className="px-3 py-2">
                      {exc.status === "RESOLVED" ? (
                        <span className="text-slate-500">{exc.resolution_note}</span>
                      ) : (
                        <div className="flex items-center gap-1.5">
                          {exc.status === "OPEN" && (
                            <Button
                              size="sm"
                              variant="secondary"
                              loading={ackBusyId === exc.id}
                              disabled={ackBusyId !== null}
                              onClick={() => handleAcknowledge(exc)}
                            >
                              Acknowledge
                            </Button>
                          )}
                          <Button size="sm" variant="primary" icon={Check} disabled={ackBusyId !== null} onClick={() => setResolveTarget(exc)}>
                            Resolve
                          </Button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {(run.exception_summary || []).length > 0 && (
          <div className="mt-4 overflow-x-auto rounded-2xl border border-slate-200">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50">
                <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                  <th className="px-3 py-2">Organization</th>
                  <th className="px-3 py-2">Kind</th>
                  <th className="px-3 py-2">Exceptions</th>
                  <th className="px-3 py-2 text-right">Discrepancy by currency</th>
                </tr>
              </thead>
              <tbody>
                {run.exception_summary.map((row, i) => (
                  <tr key={`${row.organization_id}-${row.exception_kind}-${i}`} className="border-t border-slate-100">
                    <td className="px-3 py-2">
                      {row.organization_id != null ? (
                        <OrganizationLink organizationId={row.organization_id} name={row.organization_name} />
                      ) : "—"}
                    </td>
                    <td className="px-3 py-2 font-medium text-slate-700">{EXCEPTION_KIND_LABELS[row.exception_kind] || row.exception_kind}</td>
                    <td className="px-3 py-2 font-semibold text-slate-700"><MaskedValue value={row.count} label={row.count_label} /></td>
                    <td className="px-3 py-2 text-right"><CurrencyTotals totals={row.discrepancy_total_by_currency} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {((run.exceptions || []).length > 0 || (run.exception_summary || []).length > 0) && <SupportAccessNote />}
      </div>

      <ResolveModal open={Boolean(resolveTarget)} onClose={() => setResolveTarget(null)} onSubmit={handleResolve} />
      {ConfirmationDialog}
    </Modal>
  );
}

const RUN_COLUMNS = (onOpen, openingId) => [
  { key: "id", label: "Run", width: 70, render: (r) => <span className="text-xs font-semibold text-slate-700">#{r.id}</span> },
  { key: "trigger", label: "Trigger", render: (r) => <span className="text-xs capitalize text-slate-600">{r.trigger}</span> },
  { key: "state", label: "State", render: (r) => <StatusBadge status={r.state} options={RECONCILIATION_RUN_STATE_OPTIONS} /> },
  {
    key: "processor",
    label: "Processor",
    render: (r) =>
      r.processor_environment ? (
        <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-600">
          <CreditCard size={11} /> Stripe {r.processor_environment}
        </span>
      ) : (
        <span className="text-xs text-slate-500">Ledger only</span>
      ),
  },
  { key: "checks_total", label: "Checks", align: "center", numeric: true, render: (r) => <span className="text-slate-700">{r.checks_total}</span> },
  {
    key: "exceptions_found",
    label: "Exceptions",
    align: "center",
    numeric: true,
    render: (r) => (
      <span className={r.exceptions_found > 0 ? "font-semibold text-red-600" : "text-slate-700"}>{r.exceptions_found}</span>
    ),
  },
  { key: "started_at", label: "Started", render: (r) => <span className="text-xs text-slate-500">{formatDateTime(r.started_at)}</span> },
  { key: "finished_at", label: "Finished", render: (r) => <span className="text-xs text-slate-500">{formatDateTime(r.finished_at)}</span> },
  {
    // A previously-empty `<th>` here failed axe's empty-table-header rule
    // once this page got its first real accessibility test (Phase 12) — a
    // visually-hidden label fixes it without changing the visual layout.
    key: "actions",
    label: <span className="sr-only">Actions</span>,
    render: (r) => (
      <Button size="sm" variant="ghost" icon={ExternalLink} loading={openingId === r.id} disabled={openingId !== null} onClick={() => onOpen(r.id)}>
        View
      </Button>
    ),
  },
];

// `embedded` drops this page's own PageHeader and padding when it is mounted
// as a tab of the Financial Operations hub, whose header already titles it.
export default function ReconciliationPage({ embedded = false, refreshSignal = 0 } = {}) {
  const [runs, setRuns] = useState(null);
  // `actionError` is a dismissible banner for a failed trigger/validation/
  // run-detail lookup — it must NOT hide a run history that loaded
  // successfully underneath it.
  const [actionError, setActionError] = useState(null);
  const [running, setRunning] = useState(false);
  // The last manual run's outcome. A run that FOUND discrepancies is not a
  // "success" — it renders as a warning, not the green success banner.
  const [runResult, setRunResult] = useState(null);
  const [detailRun, setDetailRun] = useState(null);
  const [openingId, setOpeningId] = useState(null);

  // ISS-017 processor-comparison controls. Disabled (the default) preserves
  // the original internal-checks-only run exactly — no default behavior
  // change without an explicit opt-in.
  const [compareProcessor, setCompareProcessor] = useState(false);
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");

  // Organization scope. Empty string ("") means "All organizations" — the
  // original platform-wide sweep — matching the backend's
  // organization_id=None default exactly.
  const [organizations, setOrganizations] = useState([]);
  const [orgsError, setOrgsError] = useState(null);
  const [organizationId, setOrganizationId] = useState("");

  const rangeValidationError = useMemo(
    () => validateReconciliationRange(compareProcessor, rangeStart, rangeEnd),
    [compareProcessor, rangeStart, rangeEnd]
  );

  const orgOptions = useMemo(
    () => organizations.map((o) => ({ value: String(o.id), label: orgLabel(o) })),
    [organizations]
  );

  const orgById = useMemo(() => {
    const m = {};
    for (const o of organizations) m[o.id] = o;
    return m;
  }, [organizations]);

  const loadRuns = useCallback(
    (signal) =>
      listReconciliationRuns(20).then((data) => {
        if (signal?.aborted) return;
        setRuns(data?.items || []);
      }),
    []
  );

  // Background refresh of the run history. Paused while a run is being
  // triggered; the open detail modal and the form inputs are separate state,
  // so a refresh never closes or resets them.
  const live = useLiveRefresh(loadRuns, { paused: running });
  const { refresh } = live;
  useEffect(() => {
    if (refreshSignal) refresh();
  }, [refreshSignal, refresh]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const all = [];
      try {
        for (let page = 0; page < ORG_MAX_PAGES; page += 1) {
          const data = await listOrganizations({ limit: ORG_PAGE_SIZE, skip: page * ORG_PAGE_SIZE });
          const batch = data?.organizations || [];
          all.push(...batch);
          if (batch.length < ORG_PAGE_SIZE || (data?.total != null && all.length >= data.total)) break;
        }
        if (!cancelled) setOrganizations(all);
      } catch (e) {
        if (cancelled) return;
        // Keep whatever pages did load selectable.
        setOrganizations(all);
        setOrgsError(e?.message || "Failed to load organizations.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleRunNow = useCallback(async () => {
    if (running) return; // belt-and-suspenders against a double-click race; the button is also disabled while running
    const validationError = validateReconciliationRange(compareProcessor, rangeStart, rangeEnd);
    if (validationError) {
      setActionError(validationError);
      return;
    }
    setRunning(true);
    setActionError(null);
    try {
      const payload = { compareProcessor, rangeStart, rangeEnd };
      if (organizationId) {
        payload.organizationId = organizationId;
      }
      const run = await triggerReconciliationRun(payload);
      setRunResult({ message: summarizeRunResult(run), warning: run.state === "failed" });
      refresh();
    } catch (err) {
      setActionError(err?.message || "Failed to trigger a reconciliation run.");
    } finally {
      setRunning(false);
    }
  }, [running, compareProcessor, rangeStart, rangeEnd, organizationId, refresh]);

  // Only the latest "View" click may open the modal — a slow response for an
  // earlier click must not replace it.
  const openSeq = useRef(0);
  const openRun = useCallback((runId) => {
    const seq = ++openSeq.current;
    setOpeningId(runId);
    return getReconciliationRun(runId)
      .then((data) => {
        if (seq === openSeq.current) setDetailRun(data);
      })
      .catch((e) => {
        if (seq === openSeq.current) setActionError(e?.message || "Failed to load run detail.");
      })
      .finally(() => {
        if (seq === openSeq.current) setOpeningId(null);
      });
  }, []);

  // Re-fetches the open run after an acknowledge/resolve. Its errors surface
  // inside the modal (the caller awaits it), not behind the overlay.
  const refreshOpenRun = useCallback(async (runId) => {
    const data = await getReconciliationRun(runId);
    setDetailRun(data);
  }, []);

  if (!live.hasLoaded) {
    return (
      <div className={embedded ? "" : "p-4 sm:p-6 lg:p-8"}>
        <Spinner />
      </div>
    );
  }

  return (
    <div className={embedded ? "" : "p-4 sm:p-6 lg:p-8"}>
      {!embedded && (
        <PageHeader
          title="Tenant Ledger Reconciliation"
          description="Checks every tenant's ledger — invoice balances and payment allocations — on a daily schedule or on demand, optionally comparing payments with Stripe."
          icon={ShieldCheck}
          accent="brand"
        />
      )}

      <div className={`rounded-2xl border border-slate-200 bg-white p-4 ${embedded ? "" : "mt-4"}`}>
        <Field label="Organization" hint="Leave as “All organizations” to sweep the whole platform.">
          <div className="flex items-center gap-2">
            <Building2 size={14} className="shrink-0 text-slate-500" aria-hidden="true" />
            <Select
              value={organizationId}
              onChange={setOrganizationId}
              options={orgOptions}
              placeholder="All organizations"
              className="max-w-xs"
              aria-label="Organization"
              disabled={running}
            />
          </div>
        </Field>
        {orgsError && (
          <p role="alert" className="mt-1 text-xs text-red-600">
            {orgsError}
          </p>
        )}

        <label className="mt-4 flex items-start gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={compareProcessor}
            disabled={running}
            onChange={(e) => setCompareProcessor(e.target.checked)}
            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand/30"
          />
          <span>
            <span className="font-medium text-slate-800">Compare with Stripe</span>
            <span className="block text-xs text-slate-500">
              Also compares ledger payments against{" "}
              {organizationId ? "the selected organization's connected Stripe account" : "every organization's connected Stripe account"}{" "}
              for the selected dates. Read-only — no invoice, payment, or balance is ever changed
              automatically.
            </span>
          </span>
        </label>

        {compareProcessor && (
          <div className="mt-3 flex flex-wrap items-center gap-3" aria-live="polite">
            <Calendar size={14} className="text-slate-500" aria-hidden="true" />
            <div>
              <label htmlFor="reconciliation-range-start" className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-600">
                Start date
              </label>
              <input
                id="reconciliation-range-start"
                type="date"
                value={rangeStart}
                max={rangeEnd || todayIso()}
                disabled={running}
                onChange={(e) => setRangeStart(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
              />
            </div>
            <span className="pt-5 text-slate-500">to</span>
            <div>
              <label htmlFor="reconciliation-range-end" className="mb-1 block text-xs font-semibold uppercase tracking-wider text-slate-600">
                End date
              </label>
              <input
                id="reconciliation-range-end"
                type="date"
                value={rangeEnd}
                min={rangeStart || undefined}
                max={todayIso()}
                disabled={running}
                onChange={(e) => setRangeEnd(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
              />
            </div>
            <span className="pt-5 text-xs text-slate-500">Max {MAX_RECONCILIATION_RANGE_DAYS} days.</span>
          </div>
        )}

        {compareProcessor && rangeValidationError && (
          <p role="alert" className="mt-2 text-xs text-red-600">
            {rangeValidationError}
          </p>
        )}

        <div className="mt-4">
          <Button
            variant="primary"
            icon={PlayCircle}
            loading={running}
            disabled={running || Boolean(rangeValidationError)}
            onClick={handleRunNow}
          >
            {running ? "Running reconciliation…" : "Run Now"}
          </Button>
        </div>
      </div>

      {runResult && (
        <div className="mt-4">
          {runResult.warning ? (
            <div role="status" className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              <AlertTriangle size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span className="flex-1">{runResult.message}</span>
              <button type="button" onClick={() => setRunResult(null)} aria-label="Dismiss run result" className="text-amber-700">
                <X size={16} />
              </button>
            </div>
          ) : (
            <SuccessMessage message={runResult.message} onDismiss={() => setRunResult(null)} />
          )}
        </div>
      )}
      {actionError && (
        <div className="mt-4">
          <p role="alert" className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            <span className="flex-1">{actionError}</span>
            <button type="button" onClick={() => setActionError(null)} aria-label="Dismiss error" className="text-red-700">
              <X size={16} />
            </button>
          </p>
        </div>
      )}

      <div className="mt-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold text-slate-800">Recent runs</h2>
          <LiveRefreshStatus
            lastUpdated={live.lastUpdated}
            refreshing={live.refreshing}
            refreshError={live.refreshError}
            onRefresh={refresh}
          />
        </div>
        {live.refreshError && runs === null ? (
          <ErrorState title="Unable to load reconciliation runs" message={live.refreshError} onRetry={() => refresh()} />
        ) : (runs || []).length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="No reconciliation runs yet"
            message="Runs happen automatically once a day, or you can trigger one now."
          />
        ) : (
          <>
            <DataTable columns={RUN_COLUMNS(openRun, openingId)} data={runs} rowKey={(r) => r.id} minWidth={900} />
            {runs.length >= 20 && (
              <p className="mt-2 text-[11px] text-slate-500">Showing the 20 most recent runs.</p>
            )}
          </>
        )}
      </div>

      <RunDetailModal
        run={detailRun}
        onClose={() => setDetailRun(null)}
        onRefreshRun={refreshOpenRun}
        onMutated={refresh}
        orgById={orgById}
      />
    </div>
  );
}
