import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ShieldCheck, PlayCircle, Check, X, ExternalLink, Calendar, CreditCard } from "lucide-react";
import {
  listReconciliationRuns,
  getReconciliationRun,
  triggerReconciliationRun,
  acknowledgeReconciliationException,
  resolveReconciliationException,
} from "../../service/commandCenterService";
import { PageHeader, DataTable, Button, Modal, Field } from "../../components/billing-ui";
import { ErrorState, Spinner, EmptyState, StatusBadge, SuccessMessage, useConfirmationDialog } from "../../components/billing-shared";
import { RECONCILIATION_RUN_STATE_OPTIONS, RECONCILIATION_EXCEPTION_STATUS_OPTIONS } from "./constants";

function formatDateTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

// Mirrors backend/app/modules/super_admin/stripe_reconciliation.py's
// MAX_RANGE_DAYS — this is a client-side convenience check only; the
// backend is the actual enforcement authority and re-validates on submit.
const MAX_RECONCILIATION_RANGE_DAYS = 92;

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

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
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
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
          <Button type="submit" variant="primary" loading={busy} disabled={!note}>
            Resolve
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function RunDetailModal({ run, onClose, onRefreshRun, onNotify }) {
  const [resolveTarget, setResolveTarget] = useState(null);
  const { confirm, ConfirmationDialog } = useConfirmationDialog();

  const handleAcknowledge = useCallback(
    async (exception) => {
      const ok = await confirm({
        title: "Acknowledge this exception?",
        message: "This marks the exception as being worked, without recording a resolution yet.",
        confirmLabel: "Acknowledge",
        tone: "primary",
      });
      if (!ok) return;
      try {
        await acknowledgeReconciliationException(exception.id);
        onNotify(`Exception #${exception.id} acknowledged.`);
        onRefreshRun(run.id);
      } catch (err) {
        onNotify(err?.message || "Failed to acknowledge the exception.", true);
      }
    },
    [confirm, onNotify, onRefreshRun, run]
  );

  const handleResolve = useCallback(
    async (note) => {
      await resolveReconciliationException(resolveTarget.id, note);
      onNotify(`Exception #${resolveTarget.id} resolved.`);
      onRefreshRun(run.id);
    },
    [resolveTarget, onNotify, onRefreshRun, run]
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
        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
          <StatusBadge status={run.state} options={RECONCILIATION_RUN_STATE_OPTIONS} />
          <span>{run.checks_total} check(s) run</span>
          <span>{run.exceptions_found} exception(s) found</span>
          <span>Processor source: {run.processor_source}</span>
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
                    <span className="font-semibold">Org {err.organization_id ?? "—"}:</span>{" "}
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
          <div className="max-h-[420px] overflow-y-auto rounded-2xl border border-slate-200">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-slate-50">
                <tr className="text-[10px] uppercase tracking-wider text-slate-500">
                  <th className="px-3 py-2">Kind</th>
                  <th className="px-3 py-2">Org</th>
                  <th className="px-3 py-2">Entity</th>
                  <th className="px-3 py-2">Detail</th>
                  <th className="px-3 py-2">Status</th>
                  <th className="px-3 py-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {run.exceptions.map((exc) => (
                  <tr key={exc.id} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-medium text-slate-700">{EXCEPTION_KIND_LABELS[exc.kind] || exc.kind}</td>
                    <td className="px-3 py-2 text-slate-600">{exc.organization_id ?? "—"}</td>
                    <td className="px-3 py-2 text-slate-600">
                      {exc.entity_type} #{exc.entity_id}
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
                        <span className="text-slate-400">{exc.resolution_note}</span>
                      ) : (
                        <div className="flex items-center gap-1.5">
                          {exc.status === "OPEN" && (
                            <Button size="sm" variant="secondary" onClick={() => handleAcknowledge(exc)}>
                              Acknowledge
                            </Button>
                          )}
                          <Button size="sm" variant="primary" icon={Check} onClick={() => setResolveTarget(exc)}>
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
      </div>

      <ResolveModal open={Boolean(resolveTarget)} onClose={() => setResolveTarget(null)} onSubmit={handleResolve} />
      {ConfirmationDialog}
    </Modal>
  );
}

const RUN_COLUMNS = (onOpen) => [
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
        <span className="text-xs text-slate-400">Ledger only</span>
      ),
  },
  { key: "checks_total", label: "Checks", align: "center", render: (r) => <span className="text-slate-700">{r.checks_total}</span> },
  {
    key: "exceptions_found",
    label: "Exceptions",
    align: "center",
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
      <Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => onOpen(r.id)}>
        View
      </Button>
    ),
  },
];

export default function ReconciliationPage() {
  const [runs, setRuns] = useState(null);
  // `loadError` blocks the run-history table (the list itself failed to
  // load — e.g. unauthorized). `actionError` is a dismissible banner for a
  // failed trigger/validation/exception-action — it must NOT hide a run
  // history that loaded successfully underneath it.
  const [loadError, setLoadError] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [success, setSuccess] = useState(null);
  const [detailRun, setDetailRun] = useState(null);

  // ISS-017 processor-comparison controls. Disabled (the default) preserves
  // the original internal-checks-only run exactly — no default behavior
  // change without an explicit opt-in.
  const [compareProcessor, setCompareProcessor] = useState(false);
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");

  const rangeValidationError = useMemo(
    () => validateReconciliationRange(compareProcessor, rangeStart, rangeEnd),
    [compareProcessor, rangeStart, rangeEnd]
  );

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    listReconciliationRuns(20)
      .then((data) => setRuns(data.items || []))
      .catch((e) => setLoadError(e?.message || "Failed to load reconciliation runs."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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
      const run = await triggerReconciliationRun({ compareProcessor, rangeStart, rangeEnd });
      setSuccess(summarizeRunResult(run));
      load();
    } catch (err) {
      setActionError(err?.message || "Failed to trigger a reconciliation run.");
    } finally {
      setRunning(false);
    }
  }, [running, compareProcessor, rangeStart, rangeEnd, load]);

  const openRun = useCallback((runId) => {
    getReconciliationRun(runId)
      .then(setDetailRun)
      .catch((e) => setActionError(e?.message || "Failed to load run detail."));
  }, []);

  const handleNotify = useCallback((message, isError) => {
    if (isError) setActionError(message);
    else setSuccess(message);
  }, []);

  if (loading) {
    return (
      <div className="p-4 sm:p-6 lg:p-8">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Reconciliation"
        description="Internal ledger reconciliation engine (REC-01) — invoice balance and payment-allocation invariants, checked on a daily schedule or on demand."
        icon={ShieldCheck}
      />

      <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-4">
        <label className="flex items-start gap-2 text-sm text-slate-700">
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
              Also compares ledger payments against your organization's connected Stripe account for the
              selected range (ISS-017). Read-only — no invoice, payment, or balance is ever changed
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
            <span className="pt-5 text-slate-400">to</span>
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
            <span className="pt-5 text-xs text-slate-400">Max {MAX_RECONCILIATION_RANGE_DAYS} days.</span>
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

      {success && (
        <div className="mt-4">
          <SuccessMessage message={success} onDismiss={() => setSuccess(null)} />
        </div>
      )}
      {actionError && (
        <div className="mt-4">
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {actionError}
          </p>
        </div>
      )}

      <div className="mt-6">
        {loadError ? (
          <ErrorState title="Unable to load reconciliation runs" message={loadError} onRetry={load} />
        ) : (runs || []).length === 0 ? (
          <EmptyState
            icon={ShieldCheck}
            title="No reconciliation runs yet"
            message="Runs happen automatically once a day, or you can trigger one now."
          />
        ) : (
          <DataTable columns={RUN_COLUMNS(openRun)} data={runs} rowKey={(r) => r.id} minWidth={900} />
        )}
      </div>

      <RunDetailModal
        run={detailRun}
        onClose={() => setDetailRun(null)}
        onRefreshRun={openRun}
        onNotify={handleNotify}
      />
    </div>
  );
}
