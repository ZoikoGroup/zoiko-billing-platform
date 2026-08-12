import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft, BarChart3, RefreshCw, AlertCircle, Loader2, ArrowUpCircle,
  CheckCircle, X, Clock, HandCoins, UserPlus,
} from "lucide-react";
import HRPage from "../../../components/HRPage";
import { collectionApi } from "../../../service/billingService";
import { formatDisplayCurrency, formatDisplayDate } from "../../../utils/billing-helpers";

const STATUS_STYLES = {
  open: "bg-blue-100 text-blue-700",
  in_progress: "bg-amber-100 text-amber-700",
  resolved: "bg-emerald-100 text-emerald-700",
  closed: "bg-slate-100 text-slate-500",
  escalated: "bg-red-100 text-red-700",
};

function StatusBadge({ status }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${STATUS_STYLES[status] || "bg-gray-100 text-gray-600"}`}>
      {status ? status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "Unknown"}
    </span>
  );
}

export default function CollectionsCaseDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [caseData, setCaseData] = useState(null);
  const [timeline, setTimeline] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);
  const [resolveModal, setResolveModal] = useState({ open: false, resolution: "", amountCollected: "" });
  const [assignModal, setAssignModal] = useState({ open: false, assignedTo: "" });
  const [actionModal, setActionModal] = useState({ open: false, description: "", outcome: "" });

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await collectionApi.getCase(id);
      setCaseData(data);
      collectionApi.getCaseTimeline(id).then((d) => setTimeline(d?.entries || [])).catch(() => setTimeline([]));
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to load collections case");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const handleAction = async (action, actionFn) => {
    setActionLoading(action);
    setError(null);
    try {
      await actionFn();
      await fetchAll();
    } catch (err) {
      setError(err?.detail || err?.message || `Failed to ${action}`);
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <HRPage title="Collections Case" subtitle="Loading...">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-brand-600" />
        </div>
      </HRPage>
    );
  }

  if (error && !caseData) {
    return (
      <HRPage title="Collections Case" subtitle="Error loading case">
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <AlertCircle className="h-10 w-10 text-red-400 mb-3" />
          <p className="text-sm text-red-600 mb-3">{error}</p>
          <button onClick={fetchAll} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700">
            <RefreshCw className="h-4 w-4" /> Retry
          </button>
        </div>
      </HRPage>
    );
  }

  if (!caseData) {
    return (
      <HRPage title="Collections Case" subtitle="Not found">
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <BarChart3 className="h-10 w-10 text-gray-300 mb-3" />
          <p className="text-sm font-medium text-gray-500">Collections case not found</p>
        </div>
      </HRPage>
    );
  }

  const canWork = !["resolved", "closed"].includes(caseData.status);

  return (
    <HRPage
      title={caseData.case_number || `Collections Case #${caseData.id}`}
      subtitle={<StatusBadge status={caseData.status} />}
      actions={
        <button onClick={() => navigate("/billing/collections-receivables")} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
      }
    >
      <div className="space-y-6">
        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} className="shrink-0 opacity-70 hover:opacity-100"><X className="h-4 w-4" /></button>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
          <div className="rounded-xl border border-gray-200 bg-white p-6">
            <p className="text-xs font-medium uppercase tracking-wider text-gray-500">Case Summary</p>
            <h2 className="mt-1 text-xl font-bold text-gray-900">{caseData.customer_name || `Customer #${caseData.customer_id}`}</h2>
            <p className="mt-1 text-sm text-gray-500">Invoice {caseData.invoice_number || `#${caseData.invoice_id}`}</p>
            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-500">Outstanding</p>
                <p className="mt-1 text-lg font-bold text-red-700 whitespace-nowrap">{formatDisplayCurrency(caseData.total_outstanding, "—")}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-500">Collected</p>
                <p className="mt-1 text-lg font-bold text-emerald-700 whitespace-nowrap">{formatDisplayCurrency(caseData.amount_collected, "—")}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-500">Days Overdue</p>
                <p className="mt-1 text-lg font-bold text-slate-900">{caseData.days_overdue}d</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-500">Priority</p>
                <p className="mt-1 text-sm font-semibold text-slate-900 capitalize">{caseData.priority}</p>
              </div>
            </div>
            {caseData.notes && (
              <div className="mt-3 rounded-lg bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-500">Notes</p>
                <p className="mt-1 text-sm font-medium text-slate-900">{caseData.notes}</p>
              </div>
            )}
            {caseData.resolution && (
              <div className="mt-3 rounded-lg bg-emerald-50 p-4">
                <p className="text-xs font-medium text-emerald-600">Resolution</p>
                <p className="mt-1 text-sm font-medium text-emerald-800">{caseData.resolution}</p>
              </div>
            )}
          </div>
          <div className="rounded-xl border border-gray-200 bg-white p-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">Quick Actions</p>
            <div className="mt-4 grid grid-cols-1 gap-2">
              {canWork && (
                <>
                  <button onClick={() => setAssignModal({ open: true, assignedTo: "" })}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50">
                    <UserPlus className="h-3.5 w-3.5" /> Assign
                  </button>
                  <button onClick={() => setActionModal({ open: true, description: "", outcome: "" })}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50">
                    Log Action
                  </button>
                  <button onClick={() => handleAction("escalate", () => collectionApi.escalateCase(caseData.id))} disabled={actionLoading === "escalate"}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-amber-600 px-3 py-2 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50">
                    {actionLoading === "escalate" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpCircle className="h-3.5 w-3.5" />} Escalate
                  </button>
                  <button onClick={() => setResolveModal({ open: true, resolution: "", amountCollected: "" })}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-700">
                    <CheckCircle className="h-3.5 w-3.5" /> Resolve
                  </button>
                  <button onClick={() => handleAction("close", () => collectionApi.closeCase(caseData.id))} disabled={actionLoading === "close"}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-600 px-3 py-2 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50">
                    Close Case
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        {timeline.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
              <Clock className="h-4 w-4 text-brand-500" /> Timeline &amp; Audit History
            </h3>
            <div className="relative">
              <div className="absolute left-4 top-2 bottom-2 w-0.5 bg-gray-200" />
              <div className="space-y-4">
                {timeline.map((entry, i) => (
                  <div key={i} className="relative flex items-start gap-4 pl-10">
                    <div className="absolute left-2.5 w-3 h-3 rounded-full border-2 mt-1.5 bg-brand-400 border-brand-400" />
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium text-gray-900">{entry.title}</span>
                      {entry.description && <p className="text-xs text-gray-500 mt-0.5">{entry.description}</p>}
                      <p className="text-xs text-gray-400 mt-1">{formatDisplayDate(entry.timestamp)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {assignModal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setAssignModal({ open: false, assignedTo: "" })}>
          <div className="bg-white rounded-3xl p-8 w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-gray-900 mb-4">Assign Case</h2>
            <input type="number" placeholder="Employee ID" value={assignModal.assignedTo} onChange={(e) => setAssignModal((p) => ({ ...p, assignedTo: e.target.value }))}
              className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30 mb-4" />
            <div className="flex justify-end gap-3">
              <button onClick={() => setAssignModal({ open: false, assignedTo: "" })} className="px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 rounded-xl">Cancel</button>
              <button
                onClick={async () => { const to = Number(assignModal.assignedTo); setAssignModal({ open: false, assignedTo: "" }); await handleAction("assign", () => collectionApi.assignCase(caseData.id, to)); }}
                disabled={!assignModal.assignedTo}
                className="px-6 py-2 bg-brand-600 text-white rounded-xl text-sm font-medium hover:bg-brand-700 disabled:opacity-50">
                Assign
              </button>
            </div>
          </div>
        </div>
      )}

      {actionModal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setActionModal({ open: false, description: "", outcome: "" })}>
          <div className="bg-white rounded-3xl p-8 w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-gray-900 mb-4">Log Collection Action</h2>
            <div className="space-y-3">
              <textarea value={actionModal.description} onChange={(e) => setActionModal((p) => ({ ...p, description: e.target.value }))} rows={2} placeholder="What happened?"
                className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
              <input type="text" value={actionModal.outcome} onChange={(e) => setActionModal((p) => ({ ...p, outcome: e.target.value }))} placeholder="Outcome"
                className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button onClick={() => setActionModal({ open: false, description: "", outcome: "" })} className="px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 rounded-xl">Cancel</button>
              <button
                onClick={async () => {
                  const { description, outcome } = actionModal;
                  setActionModal({ open: false, description: "", outcome: "" });
                  await handleAction("log", () => collectionApi.logAction(caseData.id, { action_type: "phone_call", description, outcome }));
                }}
                className="px-6 py-2 bg-brand-600 text-white rounded-xl text-sm font-medium hover:bg-brand-700 inline-flex items-center gap-2">
                <HandCoins className="h-4 w-4" /> Save
              </button>
            </div>
          </div>
        </div>
      )}

      {resolveModal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setResolveModal({ open: false, resolution: "", amountCollected: "" })}>
          <div className="bg-white rounded-3xl p-8 w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-gray-900 mb-4">Resolve Collections Case</h2>
            <textarea value={resolveModal.resolution} onChange={(e) => setResolveModal((p) => ({ ...p, resolution: e.target.value }))} rows={3} placeholder="How was this resolved? (required)"
              className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30 mb-4" />
            <label className="block text-xs font-medium text-gray-500 mb-1">Amount Collected (optional)</label>
            <input type="number" min="0" step="0.01" value={resolveModal.amountCollected}
              onChange={(e) => setResolveModal((p) => ({ ...p, amountCollected: e.target.value }))}
              placeholder="0.00"
              className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30 mb-4" />
            <div className="flex justify-end gap-3">
              <button onClick={() => setResolveModal({ open: false, resolution: "", amountCollected: "" })} className="px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 rounded-xl">Cancel</button>
              <button
                onClick={async () => {
                  const { resolution, amountCollected } = resolveModal;
                  setResolveModal({ open: false, resolution: "", amountCollected: "" });
                  const parsedAmount = amountCollected !== "" ? parseFloat(amountCollected) : undefined;
                  await handleAction("resolve", () => collectionApi.resolveCase(caseData.id, resolution, parsedAmount));
                }}
                disabled={!resolveModal.resolution.trim()}
                className="px-6 py-2 bg-emerald-600 text-white rounded-xl text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 inline-flex items-center gap-2">
                <CheckCircle className="h-4 w-4" /> Resolve
              </button>
            </div>
          </div>
        </div>
      )}
    </HRPage>
  );
}
