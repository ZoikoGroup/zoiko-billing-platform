import React, { useCallback, useEffect, useMemo, useState } from "react";
import { CheckSquare, Check, X } from "lucide-react";
import {
  listApprovalRequests,
  approveCommercialPlanVersion,
  rejectCommercialPlanVersion,
} from "../../service/commercialService";
import { PageHeader, DataTable, Select, Button, Modal, Field } from "../../components/billing-ui";
import { ErrorState, Spinner, SuccessMessage, StatusBadge, useConfirmationDialog } from "../../components/billing-shared";
import { APPROVAL_STATUS_OPTIONS, formatDateTime } from "./constants";

function RejectModal({ open, onClose, onSubmit }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setReason("");
      setError(null);
    }
  }, [open]);

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(reason);
      onClose();
    } catch (err) {
      setError(err?.message || "Failed to reject the request.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Reject request" icon={X} size="sm">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Rejection reason" htmlFor="rejection-reason" required>
          <textarea
            id="rejection-reason"
            required
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
          />
        </Field>
        {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" variant="danger" loading={busy} disabled={!reason}>Reject</Button>
        </div>
      </form>
    </Modal>
  );
}

export default function ApprovalQueuePage() {
  const [requests, setRequests] = useState([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState("pending");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [rejectTarget, setRejectTarget] = useState(null);
  const { confirm, ConfirmationDialog } = useConfirmationDialog();

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    listApprovalRequests({ status, limit: 100 })
      .then((data) => {
        setRequests(data.requests || []);
        setTotal(data.total || 0);
      })
      .catch((e) => setError(e?.message || "Failed to load approval requests."))
      .finally(() => setLoading(false));
  }, [status]);

  useEffect(() => {
    load();
  }, [load]);

  const handleApprove = useCallback(
    async (request) => {
      const ok = await confirm({
        title: "Approve this request?",
        message: `This publishes the catalog version and cannot be undone by re-rejecting it. You cannot approve your own request — the backend will reject it if you try.`,
        confirmLabel: "Approve",
        tone: "primary",
      });
      if (!ok) return;
      try {
        await approveCommercialPlanVersion(request.scope.version_id);
        setSuccess(`Request #${request.id} approved and published.`);
        load();
      } catch (err) {
        setError(err?.message || "Failed to approve the request.");
      }
    },
    [confirm, load]
  );

  const handleReject = useCallback(
    async (reason) => {
      await rejectCommercialPlanVersion(rejectTarget.scope.version_id, reason);
      setSuccess(`Request #${rejectTarget.id} rejected.`);
      load();
    },
    [rejectTarget, load]
  );

  const columns = useMemo(
    () => [
      { key: "id", label: "ID", width: 60, render: (row) => <span className="text-xs text-slate-500">#{row.id}</span> },
      { key: "type", label: "Type", render: (row) => <span className="text-sm text-slate-700">{row.request_type}</span> },
      { key: "requested_by", label: "Requested By", render: (row) => <span className="text-xs text-slate-600">{row.requested_by_email || "—"}</span> },
      { key: "requested_at", label: "Requested At", render: (row) => <span className="text-xs text-slate-500">{formatDateTime(row.requested_at)}</span> },
      { key: "reason", label: "Reason", render: (row) => <span className="text-xs text-slate-500">{row.reason || "—"}</span> },
      { key: "status", label: "Status", render: (row) => <StatusBadge status={row.status} options={APPROVAL_STATUS_OPTIONS} /> },
      {
        key: "actions",
        label: "Actions",
        width: 180,
        render: (row) =>
          row.status === "pending" && row.request_type === "catalog_version_publish" ? (
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="primary" icon={Check} onClick={() => handleApprove(row)}>Approve</Button>
              <Button size="sm" variant="danger" icon={X} onClick={() => setRejectTarget(row)}>Reject</Button>
            </div>
          ) : (
            <span className="text-xs text-slate-400">
              {row.approver_email ? `by ${row.approver_email}` : "—"}
            </span>
          ),
      },
    ],
    [handleApprove]
  );

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Approval Queue"
        description="Maker-checker requests for material commercial operations (ZB-COM-BILL-001 Phase 5). A requester can never approve their own request — enforced server-side, not just here."
        icon={CheckSquare}
        meta={`${total} request(s)`}
      />

      {success && <div className="mt-4"><SuccessMessage message={success} onDismiss={() => setSuccess(null)} /></div>}
      {error && (
        <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
          {error}
          <button type="button" onClick={load} className="ml-3 font-semibold underline">Retry</button>
        </div>
      )}

      <div className="mt-6 max-w-xs">
        <Select value={status} onChange={setStatus} options={APPROVAL_STATUS_OPTIONS} placeholder="All statuses" />
      </div>

      <div className="mt-4">
        {loading ? (
          <Spinner />
        ) : (
          <DataTable
            columns={columns}
            data={requests}
            rowKey={(row) => row.id}
            emptyTitle="No approval requests"
            emptyMessage="Requests for catalog version publishing and other material operations will appear here."
            minWidth={920}
          />
        )}
      </div>

      <RejectModal open={Boolean(rejectTarget)} onClose={() => setRejectTarget(null)} onSubmit={handleReject} />
      {ConfirmationDialog}
    </div>
  );
}
