import React, { useCallback, useEffect, useState } from "react";
import { ShieldCheck, PlayCircle, Check, X, ExternalLink } from "lucide-react";
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

const EXCEPTION_KIND_LABELS = {
  invoice_balance_mismatch: "Invoice balance mismatch",
  payment_over_allocation: "Payment over-allocation",
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
        </div>
        {run.processor_note && <p className="text-xs text-slate-500">{run.processor_note}</p>}

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
                      <pre className="max-w-[220px] whitespace-pre-wrap text-[10px]">{JSON.stringify(exc.detail)}</pre>
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
    key: "actions",
    label: "",
    render: (r) => (
      <Button size="sm" variant="ghost" icon={ExternalLink} onClick={() => onOpen(r.id)}>
        View
      </Button>
    ),
  },
];

export default function ReconciliationPage() {
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [success, setSuccess] = useState(null);
  const [detailRun, setDetailRun] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    listReconciliationRuns(20)
      .then((data) => setRuns(data.items || []))
      .catch((e) => setError(e?.message || "Failed to load reconciliation runs."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleRunNow = useCallback(async () => {
    setRunning(true);
    try {
      const run = await triggerReconciliationRun();
      setSuccess(`Run #${run.id} completed — ${run.exceptions_found} exception(s) found.`);
      load();
    } catch (err) {
      setError(err?.message || "Failed to trigger a reconciliation run.");
    } finally {
      setRunning(false);
    }
  }, [load]);

  const openRun = useCallback((runId) => {
    getReconciliationRun(runId)
      .then(setDetailRun)
      .catch((e) => setError(e?.message || "Failed to load run detail."));
  }, []);

  const handleNotify = useCallback((message, isError) => {
    if (isError) setError(message);
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
        title="Tenant Ledger Reconciliation"
        description="Internal tenant ledger reconciliation engine (REC-01) — invoice balance and payment-allocation invariants, checked on a daily schedule or on demand."
        icon={ShieldCheck}
        actions={
          <Button variant="primary" icon={PlayCircle} loading={running} onClick={handleRunNow}>
            Run Now
          </Button>
        }
      />

      {success && (
        <div className="mt-4">
          <SuccessMessage message={success} onDismiss={() => setSuccess(null)} />
        </div>
      )}

      <div className="mt-6">
        {error ? (
          <ErrorState title="Unable to load reconciliation runs" message={error} onRetry={load} />
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
