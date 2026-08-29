import React, { useCallback, useEffect, useMemo, useState } from "react";
import { GitPullRequestArrow, Undo2, X } from "lucide-react";
import {
  listCommercialSubscriptionChanges,
  reverseCommercialSubscriptionChange,
} from "../../service/commercialService";
import { PageHeader, DataTable, Button, Modal, Field, Select } from "../../components/billing-ui";
import { ErrorState, Spinner, SuccessMessage, StatusBadge, useConfirmationDialog } from "../../components/billing-shared";
import { SUBSCRIPTION_CHANGE_STATUS_OPTIONS, formatDateTime, displayValue } from "./constants";

const inputClass =
  "w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100";

function BlockersDetail({ change }) {
  if (!change) return null;
  const blockers = Array.isArray(change.blockers) ? change.blockers : [];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <span className="block font-semibold uppercase tracking-wider text-slate-500">Direction</span>
          <span className="text-slate-700">{change.direction}</span>
        </div>
        <div>
          <span className="block font-semibold uppercase tracking-wider text-slate-500">Status</span>
          <StatusBadge status={change.status} options={SUBSCRIPTION_CHANGE_STATUS_OPTIONS} />
        </div>
        <div>
          <span className="block font-semibold uppercase tracking-wider text-slate-500">From plan</span>
          <span className="text-slate-700">{change.from_plan_code || `#${change.from_plan_id}`}</span>
        </div>
        <div>
          <span className="block font-semibold uppercase tracking-wider text-slate-500">To plan</span>
          <span className="text-slate-700">{change.to_plan_code || `#${change.to_plan_id}`}</span>
        </div>
        <div>
          <span className="block font-semibold uppercase tracking-wider text-slate-500">Effective at</span>
          <span className="text-slate-700">{change.effective_at ? formatDateTime(change.effective_at) : "—"}</span>
        </div>
        <div>
          <span className="block font-semibold uppercase tracking-wider text-slate-500">Requested</span>
          <span className="text-slate-700">{formatDateTime(change.requested_at)}</span>
        </div>
      </div>

      {change.reason && (
        <div>
          <span className="block text-xs font-semibold uppercase tracking-wider text-slate-500">Reason</span>
          <p className="text-sm text-slate-700">{change.reason}</p>
        </div>
      )}

      <div>
        <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-500">
          Compatibility checklist ({blockers.length} blocker{blockers.length === 1 ? "" : "s"})
        </span>
        {blockers.length === 0 ? (
          <p className="text-xs text-slate-500">No blockers were recorded for this change.</p>
        ) : (
          <ul className="space-y-2">
            {blockers.map((b) => (
              <li key={b.check_id} className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
                <span className="block font-semibold">{b.label}</span>
                <span>{b.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function ReverseModal({ open, onClose, onSubmit }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) { setReason(""); setError(null); }
  }, [open]);

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(reason);
      onClose();
    } catch (err) {
      setError(err?.message || "Failed to reverse.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Reverse scheduled change" icon={Undo2} size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Reason" htmlFor="reverse-reason" required>
          <textarea id="reverse-reason" required rows={3} value={reason} onChange={(e) => setReason(e.target.value)} className={inputClass} />
        </Field>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="danger" loading={busy} disabled={!reason}>Reverse</Button>
        </div>
      </form>
    </Modal>
  );
}

export default function PlanChangesPage() {
  const [changes, setChanges] = useState([]);
  const [statusFilter, setStatusFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [detailTarget, setDetailTarget] = useState(null);
  const [reverseTarget, setReverseTarget] = useState(null);
  const { confirm, ConfirmationDialog } = useConfirmationDialog();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listCommercialSubscriptionChanges(statusFilter ? { status: statusFilter } : {});
      setChanges(data.changes || []);
    } catch (err) {
      setError(err?.message || "Failed to load the plan-change queue.");
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const columns = useMemo(
    () => [
      { key: "id", label: "#", width: 60, render: (row) => <span className="font-mono text-xs text-slate-500">{row.id}</span> },
      {
        key: "plan",
        label: "Plan change",
        render: (row) => (
          <span className="text-xs text-slate-700">
            {row.from_plan_code || `#${row.from_plan_id}`} <span className="text-slate-400">→</span>{" "}
            {row.to_plan_code || `#${row.to_plan_id}`}
          </span>
        ),
      },
      { key: "direction", label: "Direction", render: (row) => <span className="text-xs capitalize text-slate-600">{row.direction}</span> },
      { key: "status", label: "Status", render: (row) => <StatusBadge status={row.status} options={SUBSCRIPTION_CHANGE_STATUS_OPTIONS} /> },
      {
        key: "blockers",
        label: "Blockers",
        render: (row) => {
          const count = Array.isArray(row.blockers) ? row.blockers.length : 0;
          return count > 0 ? (
            <span className="text-xs font-semibold text-red-700">{count}</span>
          ) : (
            <span className="text-xs text-slate-400">0</span>
          );
        },
      },
      { key: "effective_at", label: "Effective at", render: (row) => <span className="text-xs text-slate-500">{row.effective_at ? formatDateTime(row.effective_at) : "—"}</span> },
      {
        key: "actions",
        label: "Actions",
        width: 220,
        render: (row) => (
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="secondary" onClick={() => setDetailTarget(row)}>Inspect</Button>
            {row.status === "scheduled" && (
              <Button size="sm" variant="danger" icon={X} onClick={() => setReverseTarget(row)}>Reverse</Button>
            )}
          </div>
        ),
      },
    ],
    []
  );

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Plan-Change Queue"
        description="ZB-COM-ENT-001 · Part 3 §7-§8, §16 · every upgrade/downgrade attempt, including BLOCKED ones — for investigating failed or inconsistent transitions."
        icon={GitPullRequestArrow}
        meta={`${displayValue(changes.length)} change(s)`}
      />

      <div className="mt-6 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <Select value={statusFilter} onChange={setStatusFilter} options={SUBSCRIPTION_CHANGE_STATUS_OPTIONS} placeholder="All statuses" className="w-48" />
        </div>

        {success && <SuccessMessage message={success} onDismiss={() => setSuccess(null)} />}
        {error && (
          <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
            {error}
            <button type="button" onClick={load} className="ml-3 font-semibold underline">Retry</button>
          </div>
        )}

        {loading && changes.length === 0 ? (
          <Spinner />
        ) : (
          <DataTable
            columns={columns}
            data={changes}
            loading={loading}
            rowKey={(row) => row.id}
            emptyTitle="No plan changes yet"
            emptyMessage="Upgrades and downgrades will appear here once a tenant initiates one."
            minWidth={960}
          />
        )}
      </div>

      <Modal open={Boolean(detailTarget)} onClose={() => setDetailTarget(null)} title={`Plan change #${detailTarget?.id ?? ""}`} icon={GitPullRequestArrow} size="lg">
        <BlockersDetail change={detailTarget} />
      </Modal>

      <ReverseModal
        open={Boolean(reverseTarget)}
        onClose={() => setReverseTarget(null)}
        onSubmit={async (reason) => {
          await reverseCommercialSubscriptionChange(reverseTarget.id, reason);
          setSuccess(`Plan change #${reverseTarget.id} reversed.`);
          load();
        }}
      />
      {ConfirmationDialog}
    </div>
  );
}
