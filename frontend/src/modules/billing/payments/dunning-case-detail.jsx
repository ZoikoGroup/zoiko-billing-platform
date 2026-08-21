import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft, Bell, RefreshCw, AlertCircle, Loader2, ArrowUpCircle,
  CheckCircle, X, Clock, HandCoins,
} from "lucide-react";
import HRPage from "../../../components/HRPage";
import { dunningApi, promiseToPayApi } from "../../../service/billingService";
import { formatDisplayCurrency, formatDisplayDate } from "../../../utils/billing-helpers";

const STATUS_STYLES = {
  active: "bg-amber-100 text-amber-700",
  resolved: "bg-emerald-100 text-emerald-700",
  escalated: "bg-red-100 text-red-700",
  closed: "bg-slate-100 text-slate-500",
};

function StatusBadge({ status }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${STATUS_STYLES[status] || "bg-slate-100 text-slate-600"}`}>
      {status ? status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "Unknown"}
    </span>
  );
}

export default function DunningCaseDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [dunningCase, setCase] = useState(null);
  const [timeline, setTimeline] = useState([]);
  const [promises, setPromises] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);
  const [resolveModal, setResolveModal] = useState({ open: false, note: "" });
  const [promiseModal, setPromiseModal] = useState({ open: false, amount: "", date: "", notes: "" });

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await dunningApi.getCase(id);
      setCase(data);
      dunningApi.getCaseTimeline(id).then((d) => setTimeline(d?.entries || [])).catch(() => setTimeline([]));
      if (data?.customer_id) {
        promiseToPayApi.listByCustomer(data.customer_id).then((p) => setPromises(Array.isArray(p) ? p : [])).catch(() => setPromises([]));
      }
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to load dunning case");
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

  const handleCreatePromise = async () => {
    setActionLoading("promise");
    try {
      await promiseToPayApi.create({
        customer_id: dunningCase.customer_id,
        invoice_id: dunningCase.invoice_id,
        dunning_case_id: dunningCase.id,
        promise_amount: Number(promiseModal.amount),
        promise_date: promiseModal.date,
        notes: promiseModal.notes || undefined,
      });
      setPromiseModal({ open: false, amount: "", date: "", notes: "" });
      await fetchAll();
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to create promise to pay");
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <HRPage title="Dunning Case" subtitle="Loading...">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-brand-600" />
        </div>
      </HRPage>
    );
  }

  if (error && !dunningCase) {
    return (
      <HRPage title="Dunning Case" subtitle="Error loading case">
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

  if (!dunningCase) {
    return (
      <HRPage title="Dunning Case" subtitle="Not found">
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Bell className="h-10 w-10 text-slate-300 mb-3" />
          <p className="text-sm font-medium text-slate-500">Dunning case not found</p>
        </div>
      </HRPage>
    );
  }

  const isActive = dunningCase.status === "active";

  return (
    <HRPage
      title={`Dunning Case #${dunningCase.id}`}
      subtitle={<StatusBadge status={dunningCase.status} />}
      actions={
        <button onClick={() => navigate("/billing/dunning")} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50">
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
          <div className="rounded-3xl border border-slate-200 bg-white p-6">
            <p className="text-xs font-medium uppercase tracking-wider text-slate-600">Case Summary</p>
            <h2 className="mt-1 text-xl font-bold text-slate-900">{dunningCase.customer_name || `Customer #${dunningCase.customer_id}`}</h2>
            <p className="mt-1 text-sm text-slate-500">Invoice {dunningCase.invoice_number || `#${dunningCase.invoice_id}`}</p>
            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-500">Overdue Amount</p>
                <p className="mt-1 text-lg font-bold text-amber-700 whitespace-nowrap">{formatDisplayCurrency(dunningCase.total_overdue_amount, "—")}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-500">Days Overdue</p>
                <p className="mt-1 text-lg font-bold text-slate-900">{dunningCase.days_overdue}d</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-500">Level</p>
                <p className="mt-1 text-lg font-bold text-slate-900">Level {dunningCase.current_level}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-500">Next Action</p>
                <p className="mt-1 text-sm font-semibold text-slate-900">{dunningCase.next_action_at ? formatDisplayDate(dunningCase.next_action_at) : "—"}</p>
              </div>
            </div>
            {dunningCase.notes && (
              <div className="mt-3 rounded-lg bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-500">Notes</p>
                <p className="mt-1 text-sm font-medium text-slate-900">{dunningCase.notes}</p>
              </div>
            )}
            {dunningCase.resolution_note && (
              <div className="mt-3 rounded-lg bg-emerald-50 p-4">
                <p className="text-xs font-medium text-emerald-700">Resolution</p>
                <p className="mt-1 text-sm font-medium text-emerald-800">{dunningCase.resolution_note}</p>
              </div>
            )}
          </div>
          <div className="rounded-3xl border border-slate-200 bg-white p-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-600">Quick Actions</p>
            <div className="mt-4 grid grid-cols-1 gap-2">
              {isActive && (
                <>
                  <button onClick={() => handleAction("escalate", () => dunningApi.escalateCase(dunningCase.id))} disabled={actionLoading === "escalate"}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-amber-600 px-3 py-2 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50">
                    {actionLoading === "escalate" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUpCircle className="h-3.5 w-3.5" />} Escalate Level
                  </button>
                  <button onClick={() => setPromiseModal({ open: true, amount: "", date: "", notes: "" })}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50">
                    <HandCoins className="h-3.5 w-3.5" /> Log Promise to Pay
                  </button>
                  <button onClick={() => setResolveModal({ open: true, note: "" })}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-700">
                    <CheckCircle className="h-3.5 w-3.5" /> Resolve
                  </button>
                  <button onClick={() => handleAction("close", () => dunningApi.closeCase(dunningCase.id))} disabled={actionLoading === "close"}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-slate-600 px-3 py-2 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50">
                    Close Case
                  </button>
                </>
              )}
            </div>
          </div>
        </div>

        {promises.length > 0 && (
          <div className="rounded-3xl border border-slate-200 bg-white p-6">
            <h3 className="text-lg font-semibold text-slate-900 mb-4">Promise to Pay History</h3>
            <div className="space-y-2">
              {promises.map((p) => (
                <div key={p.id} className="flex items-center justify-between rounded-lg bg-slate-50 p-3 text-sm">
                  <span className="text-slate-700">{formatDisplayCurrency(p.promise_amount, "—")} by {formatDisplayDate(p.promise_date)}</span>
                  <StatusBadge status={p.status} />
                </div>
              ))}
            </div>
          </div>
        )}

        {timeline.length > 0 && (
          <div className="bg-white rounded-3xl border border-slate-200 p-6">
            <h3 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
              <Clock className="h-4 w-4 text-brand-500" /> Timeline &amp; Audit History
            </h3>
            <div className="relative">
              <div className="absolute left-4 top-2 bottom-2 w-0.5 bg-slate-200" />
              <div className="space-y-4">
                {timeline.map((entry, i) => (
                  <div key={i} className="relative flex items-start gap-4 pl-10">
                    <div className="absolute left-2.5 w-3 h-3 rounded-full border-2 mt-1.5 bg-brand-400 border-brand-400" />
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium text-slate-900">{entry.title}</span>
                      {entry.description && <p className="text-xs text-slate-500 mt-0.5">{entry.description}</p>}
                      <p className="text-xs text-slate-500 mt-1">{formatDisplayDate(entry.timestamp)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {resolveModal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setResolveModal({ open: false, note: "" })}>
          <div className="bg-white rounded-3xl p-8 w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-slate-900 mb-4">Resolve Dunning Case</h2>
            <textarea value={resolveModal.note} onChange={(e) => setResolveModal((p) => ({ ...p, note: e.target.value }))} rows={3} placeholder="Resolution note (optional)"
              className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30 mb-4" />
            <div className="flex justify-end gap-3">
              <button onClick={() => setResolveModal({ open: false, note: "" })} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-xl">Cancel</button>
              <button
                onClick={async () => { const note = resolveModal.note; setResolveModal({ open: false, note: "" }); await handleAction("resolve", () => dunningApi.resolveCase(dunningCase.id, note || undefined)); }}
                disabled={actionLoading === "resolve"}
                className="px-6 py-2 bg-emerald-600 text-white rounded-xl text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 inline-flex items-center gap-2">
                {actionLoading === "resolve" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />} Resolve
              </button>
            </div>
          </div>
        </div>
      )}

      {promiseModal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setPromiseModal({ open: false, amount: "", date: "", notes: "" })}>
          <div className="bg-white rounded-3xl p-8 w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-slate-900 mb-4">Log a Promise to Pay</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Amount *</label>
                <input type="number" min="0" step="0.01" value={promiseModal.amount} onChange={(e) => setPromiseModal((p) => ({ ...p, amount: e.target.value }))}
                  className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Promise Date *</label>
                <input type="date" value={promiseModal.date} onChange={(e) => setPromiseModal((p) => ({ ...p, date: e.target.value }))}
                  className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Notes</label>
                <textarea value={promiseModal.notes} onChange={(e) => setPromiseModal((p) => ({ ...p, notes: e.target.value }))} rows={2}
                  className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button onClick={() => setPromiseModal({ open: false, amount: "", date: "", notes: "" })} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-xl">Cancel</button>
              <button onClick={handleCreatePromise} disabled={actionLoading === "promise" || !promiseModal.amount || !promiseModal.date}
                className="px-6 py-2 bg-brand-600 text-white rounded-xl text-sm font-medium hover:bg-brand-700 disabled:opacity-50 inline-flex items-center gap-2">
                {actionLoading === "promise" ? <Loader2 className="h-4 w-4 animate-spin" /> : <HandCoins className="h-4 w-4" />} Save
              </button>
            </div>
          </div>
        </div>
      )}
    </HRPage>
  );
}
