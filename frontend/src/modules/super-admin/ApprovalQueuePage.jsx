import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckSquare,
  Check,
  X,
  FileText,
  Clock,
  AlertTriangle,
  ShieldAlert,
  Info,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import {
  listApprovalRequests,
  approveCommercialPlanVersion,
  rejectCommercialPlanVersion,
} from "../../service/commercialService";
import {
  decideApprovalRequest,
} from "../../service/commandCenterService";
import {
  PageHeader,
  DataTable,
  Select,
  Button,
  Modal,
  Field,
} from "../../components/billing-ui";
import {
  ErrorState,
  Spinner,
  SuccessMessage,
  StatusBadge,
  useConfirmationDialog,
  EmptyState,
} from "../../components/billing-shared";
import { APPROVAL_STATUS_OPTIONS, formatDateTime } from "./constants";
import { useAuth } from "../../context/AuthContext";

// ── Helpers ───────────────────────────────────────────────────────────────────

function slaCountdown(requestedAt, windowMinutes = 60) {
  if (!requestedAt) return null;
  const deadline = new Date(new Date(requestedAt).getTime() + windowMinutes * 60000);
  const nowMs = Date.now();
  const diffMs = deadline - nowMs;
  if (diffMs <= 0) return { label: "SLA Breached", breached: true };
  const diffMins = Math.floor(diffMs / 60000);
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs > 0) return { label: `${diffHrs}h ${diffMins % 60}m remaining`, breached: false };
  return { label: `${diffMins}m remaining`, breached: diffMins < 15 };
}

function SlaIndicator({ requestedAt }) {
  const sla = slaCountdown(requestedAt, 120); // 2-hour approval SLA
  if (!sla) return null;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${
        sla.breached
          ? "bg-red-100 text-red-700"
          : "bg-amber-50 text-amber-700"
      }`}
    >
      <Clock size={9} />
      {sla.label}
    </span>
  );
}

function EvidencePanel({ evidence, beforeState, proposedState }) {
  const [open, setOpen] = useState(false);
  const hasContent = evidence || beforeState || proposedState;
  if (!hasContent) return <span className="text-xs text-slate-400">—</span>;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-800"
      >
        <FileText size={12} />
        Evidence
        {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {open && (
        <div className="mt-2 space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs">
          {evidence && (
            <div>
              <p className="font-semibold uppercase tracking-wider text-slate-500">Evidence</p>
              <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-slate-700">
                {JSON.stringify(evidence, null, 2)}
              </pre>
            </div>
          )}
          {beforeState && (
            <div>
              <p className="font-semibold uppercase tracking-wider text-slate-500">Before State</p>
              <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-slate-700">
                {JSON.stringify(beforeState, null, 2)}
              </pre>
            </div>
          )}
          {proposedState && (
            <div>
              <p className="font-semibold uppercase tracking-wider text-slate-500">Proposed State</p>
              <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-slate-700">
                {JSON.stringify(proposedState, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Reject modal (reused for both request types) ─────────────────────────────

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
        {error && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant="danger" loading={busy} disabled={!reason}>
            Reject
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Circuit breaker decision modal (with MFA step-up) ────────────────────────

function BreakerDecisionModal({ open, request, decision, onClose, onSubmit }) {
  const [reason, setReason] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (open) {
      setReason("");
      setCode("");
      setError(null);
    }
  }, [open]);

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ decision, reason, code });
      onClose();
    } catch (err) {
      setError(err?.message || "Failed to process decision.");
    } finally {
      setBusy(false);
    }
  }

  if (!request) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={decision === "approve" ? "Approve circuit breaker change" : "Reject circuit breaker change"}
      icon={decision === "approve" ? Check : X}
      size="sm"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          <strong>Checker step-up required.</strong> You must provide a fresh MFA code to
          {decision === "approve" ? " approve" : " reject"} this circuit breaker proposal.
          Self-approval is blocked server-side.
        </div>
        {decision === "reject" && (
          <Field label="Rejection reason" required>
            <textarea
              required
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
            />
          </Field>
        )}
        <Field label="MFA authenticator code" required hint="Fresh 6-digit code — required for every breaker decision.">
          <input
            required
            inputMode="numeric"
            maxLength={8}
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\s/g, ""))}
            placeholder="123456"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-center text-lg tracking-widest focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
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
          <Button
            type="submit"
            variant={decision === "approve" ? "primary" : "danger"}
            loading={busy}
            disabled={code.length < 6 || (decision === "reject" && !reason)}
          >
            {decision === "approve" ? "Approve" : "Reject"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ApprovalQueuePage() {
  const { user } = useAuth();
  const [requests, setRequests] = useState([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState("pending");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [rejectTarget, setRejectTarget] = useState(null);
  // Circuit-breaker checker flow
  const [breakerTarget, setBreakerTarget] = useState(null);
  const [breakerDecision, setBreakerDecision] = useState(null);
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

  // catalog_version_publish: direct approve/reject via commercialService
  const handleCatalogApprove = useCallback(
    async (request) => {
      const ok = await confirm({
        title: "Approve this request?",
        message: `This publishes the catalog version and cannot be undone. Self-approval is rejected server-side.`,
        confirmLabel: "Approve",
        tone: "primary",
      });
      if (!ok) return;
      try {
        await approveCommercialPlanVersion(request.scope?.version_id);
        setSuccess(`Request #${request.id} approved and published.`);
        load();
      } catch (err) {
        setError(err?.message || "Failed to approve the request.");
      }
    },
    [confirm, load]
  );

  const handleCatalogReject = useCallback(
    async (reason) => {
      await rejectCommercialPlanVersion(rejectTarget.scope?.version_id, reason);
      setSuccess(`Request #${rejectTarget.id} rejected.`);
      load();
    },
    [rejectTarget, load]
  );

  // circuit_breaker_change: checker flow via decideApprovalRequest + MFA
  const handleBreakerDecision = useCallback(
    async ({ decision, reason, code }) => {
      await decideApprovalRequest(breakerTarget.id, { decision, reason, code });
      setSuccess(`Circuit breaker request #${breakerTarget.id} ${decision}d.`);
      load();
    },
    [breakerTarget, load]
  );

  const isSelf = useCallback(
    (request) => user?.id && request.requested_by_user_id === user.id,
    [user]
  );

  const columns = useMemo(
    () => [
      {
        key: "id",
        label: "ID",
        width: 60,
        render: (row) => <span className="text-xs text-slate-500">#{row.id}</span>,
      },
      {
        key: "type",
        label: "Type",
        render: (row) => (
          <div className="space-y-1">
            <span className="text-sm font-medium text-slate-700">{row.request_type}</span>
            {row.status === "pending" && (
              <SlaIndicator requestedAt={row.requested_at} />
            )}
          </div>
        ),
      },
      {
        key: "requested_by",
        label: "Requested By",
        render: (row) => (
          <div>
            <span className="text-xs text-slate-600">{row.requested_by_email || "—"}</span>
            {isSelf(row) && row.status === "pending" && (
              <span className="ml-1 inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
                <AlertTriangle size={9} /> Self
              </span>
            )}
          </div>
        ),
      },
      {
        key: "requested_at",
        label: "Requested At",
        render: (row) => (
          <span className="text-xs text-slate-500">{formatDateTime(row.requested_at)}</span>
        ),
      },
      {
        key: "reason",
        label: "Reason",
        render: (row) => (
          <span className="text-xs text-slate-500">{row.reason || "—"}</span>
        ),
      },
      {
        key: "evidence",
        label: "Evidence",
        render: (row) => (
          <EvidencePanel
            evidence={row.evidence}
            beforeState={row.before_state}
            proposedState={row.proposed_state}
          />
        ),
      },
      {
        key: "status",
        label: "Status",
        render: (row) => <StatusBadge status={row.status} options={APPROVAL_STATUS_OPTIONS} />,
      },
      {
        key: "actions",
        label: "Actions",
        width: 200,
        render: (row) => {
          if (row.status !== "pending") {
            return (
              <span className="text-xs text-slate-500">
                {row.approver_email ? `by ${row.approver_email}` : row.rejection_reason ? "Rejected" : "—"}
              </span>
            );
          }
          if (isSelf(row)) {
            return (
              <span className="inline-flex items-center gap-1 text-xs text-amber-700">
                <ShieldAlert size={12} />
                Self-approval blocked
              </span>
            );
          }
          // catalog_version_publish
          if (row.request_type === "catalog_version_publish") {
            return (
              <div className="flex items-center gap-1.5">
                <Button size="sm" variant="primary" icon={Check} onClick={() => handleCatalogApprove(row)}>
                  Approve
                </Button>
                <Button size="sm" variant="danger" icon={X} onClick={() => setRejectTarget(row)}>
                  Reject
                </Button>
              </div>
            );
          }
          // circuit_breaker_change: checker MFA step-up
          if (row.request_type === "circuit_breaker_change") {
            return (
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant="primary"
                  icon={Check}
                  onClick={() => { setBreakerTarget(row); setBreakerDecision("approve"); }}
                >
                  Approve
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  icon={X}
                  onClick={() => { setBreakerTarget(row); setBreakerDecision("reject"); }}
                >
                  Reject
                </Button>
              </div>
            );
          }
          return <span className="text-xs text-slate-400">—</span>;
        },
      },
    ],
    [handleCatalogApprove, isSelf]
  );

  const pendingCount = requests.filter((r) => r.status === "pending").length;
  const selfBlockedCount = requests.filter((r) => r.status === "pending" && isSelf(r)).length;

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Approval Center"
        description="Maker-checker gate for material commercial operations (ZB-COM-BILL-001 Phase 5). A requester can never approve their own request — enforced server-side, not just in UI."
        icon={CheckSquare}
        meta={`${total} request(s)`}
      />

      {/* Self-approval warning banner */}
      {selfBlockedCount > 0 && (
        <div className="mt-4 flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4">
          <ShieldAlert size={18} className="mt-0.5 shrink-0 text-amber-600" />
          <div className="text-sm text-amber-800">
            <strong>{selfBlockedCount} pending request{selfBlockedCount > 1 ? "s" : ""}</strong> were submitted by
            you — a second Super Admin must approve or reject them. Self-approval is rejected server-side regardless.
          </div>
        </div>
      )}

      {success && (
        <div className="mt-4">
          <SuccessMessage message={success} onDismiss={() => setSuccess(null)} />
        </div>
      )}
      {error && (
        <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
          {error}
          <button type="button" onClick={load} className="ml-3 font-semibold underline">
            Retry
          </button>
        </div>
      )}

      {/* Filter */}
      <div className="mt-6 flex items-center gap-4">
        <div className="w-48">
          <Select
            value={status}
            onChange={setStatus}
            options={APPROVAL_STATUS_OPTIONS}
            placeholder="All statuses"
          />
        </div>
        {pendingCount > 0 && status === "pending" && (
          <span className="flex items-center gap-1.5 rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-800">
            <Clock size={12} />
            {pendingCount} awaiting decision
          </span>
        )}
      </div>

      {/* Summary chips */}
      {status === "pending" && requests.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {[...new Set(requests.map((r) => r.request_type))].map((type) => {
            const count = requests.filter((r) => r.request_type === type).length;
            return (
              <span key={type} className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700">
                {type}: {count}
              </span>
            );
          })}
        </div>
      )}

      <div className="mt-4">
        {loading ? (
          <Spinner />
        ) : requests.length === 0 ? (
          <EmptyState
            icon={CheckSquare}
            title={status === "pending" ? "No pending requests" : "No requests found"}
            message={
              status === "pending"
                ? "Catalog version publishing and circuit breaker proposals requiring a second Super Admin will appear here."
                : "Adjust the status filter to see requests in other states."
            }
          />
        ) : (
          <DataTable
            columns={columns}
            data={requests}
            rowKey={(row) => row.id}
            emptyTitle="No approval requests"
            emptyMessage="Material operation requests will appear here once submitted."
            minWidth={1100}
          />
        )}
      </div>

      {/* Catalog version reject modal */}
      <RejectModal
        open={Boolean(rejectTarget)}
        onClose={() => setRejectTarget(null)}
        onSubmit={handleCatalogReject}
      />

      {/* Circuit breaker MFA decision modal */}
      <BreakerDecisionModal
        open={Boolean(breakerTarget)}
        request={breakerTarget}
        decision={breakerDecision}
        onClose={() => { setBreakerTarget(null); setBreakerDecision(null); }}
        onSubmit={handleBreakerDecision}
      />

      {ConfirmationDialog}
    </div>
  );
}
