import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft, Undo2, RefreshCw, AlertCircle, Loader2, Send, CheckCircle,
  Ban, Printer, Download, Mail, X, XCircle, Wallet, Clock,
} from "lucide-react";
import HRPage from "../../../components/HRPage";
import { ActivityTimeline } from "../../../components/billing-ui";
import { refundApi } from "../../../service/billingService";
import { formatDisplayCurrency, formatDisplayDate } from "../../../utils/billing-helpers";
import { useTerminology } from "../utils/TerminologyContext";

// pdfmake + vfs_fonts are lazy-loaded inside buildRefundPdf() so the
// ~1.74 MB font bundle is only fetched when the user clicks "Download".

const STATUS_STYLES = {
  draft: "bg-slate-100 text-slate-600",
  pending_approval: "bg-amber-100 text-amber-700",
  approved: "bg-indigo-100 text-indigo-700",
  processing: "bg-blue-100 text-blue-700",
  completed: "bg-emerald-100 text-emerald-700",
  failed: "bg-red-100 text-red-700",
  rejected: "bg-red-100 text-red-700",
  cancelled: "bg-slate-200 text-slate-600",
};

function StatusBadge({ status }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${STATUS_STYLES[status] || "bg-slate-100 text-slate-600"}`}>
      {status ? status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "Unknown"}
    </span>
  );
}

async function buildRefundPdf(refund, orgSettings = {}) {
  const pdfMakeModule = await import("pdfmake/build/pdfmake");
  const pdfFontsModule = await import("pdfmake/build/vfs_fonts");
  const pdfMake = pdfMakeModule.default;
  const pdfFonts = pdfFontsModule.default;
  pdfMake.vfs = pdfFonts.pdfMake ? pdfFonts.pdfMake.vfs : pdfFonts;

  const currency = refund.currency;
  const fmt = (v) => {
    if (v == null || v === "") return "—";
    const num = Number(v);
    if (Number.isNaN(num)) return "—";
    return `${currency} ${num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };
  const orgName = orgSettings.company_name || "Your Company";

  const detailLines = [
    { text: `Refund Date: ${refund.completed_at ? formatDisplayDate(refund.completed_at) : formatDisplayDate(refund.created_at)}\n`, style: "dateLabel" },
    { text: `Status: ${(refund.status || "").replace(/_/g, " ")}\n`, style: "dateLabel" },
    { text: `Type: ${(refund.refund_type || "").replace(/_/g, " ")}\n`, style: "dateLabel" },
  ];
  if (refund.refund_method) detailLines.push({ text: `Method: ${refund.refund_method.replace(/_/g, " ")}\n`, style: "dateLabel" });
  if (refund.payment_id) detailLines.push({ text: `Against Payment: #${refund.payment_id}\n`, style: "dateLabel" });
  if (refund.invoice_id) detailLines.push({ text: `Against Invoice: #${refund.invoice_id}\n`, style: "dateLabel" });
  if (refund.credit_note_id) detailLines.push({ text: `Against Credit Note: #${refund.credit_note_id}\n`, style: "dateLabel" });
  if (refund.reference_number) detailLines.push({ text: `Reference #: ${refund.reference_number}\n`, style: "dateLabel" });

  const docDefinition = {
    content: [
      { text: "REFUND RECEIPT", style: "title" },
      { text: refund.refund_number || `#${refund.id}`, style: "subtitle", margin: [0, 2, 0, 10] },
      {
        columns: [
          { text: orgName, style: "companyName" },
          { text: detailLines, alignment: "right" },
        ],
        margin: [0, 10, 0, 10],
      },
      { text: "Refunded To", style: "sectionLabel", margin: [0, 0, 0, 4] },
      { text: refund.customer_name || `#${refund.customer_id}`, style: "customerName" },
      refund.customer_email ? { text: refund.customer_email, style: "addressDetail" } : "",
      { text: "Reason", style: "sectionLabel", margin: [0, 10, 0, 4] },
      { text: refund.reason || "—", style: "bodyText" },
      {
        columns: [{ width: "*", text: "" }, { width: 220, table: { body: [[{ text: "Amount", style: "totalsGrandLabel" }, { text: fmt(refund.amount), style: "totalsGrandValue" }]], widths: [120, "*"] }, layout: "noBorders" }],
        margin: [0, 14, 0, 0],
      },
    ],
    styles: {
      title: { fontSize: 20, bold: true, color: "#0EA5E9" },
      subtitle: { fontSize: 11, color: "#6b7280" },
      companyName: { fontSize: 13, bold: true, color: "#1e293b" },
      dateLabel: { fontSize: 9, color: "#6b7280" },
      sectionLabel: { fontSize: 9, bold: true, color: "#6b7280" },
      customerName: { fontSize: 11, bold: true, color: "#1e293b" },
      addressDetail: { fontSize: 9, color: "#6b7280" },
      bodyText: { fontSize: 9, color: "#374151" },
      totalsGrandLabel: { fontSize: 11, bold: true, color: "#1e293b" },
      totalsGrandValue: { fontSize: 13, bold: true, color: "#0EA5E9", alignment: "right" },
    },
    defaultStyle: { font: "Roboto" },
  };
  return pdfMake.createPdf(docDefinition);
}

export default function RefundDetailPage() {
  const { singular } = useTerminology();
  const { id } = useParams();
  const navigate = useNavigate();

  const [refund, setRefund] = useState(null);
  const [timeline, setTimeline] = useState([]);
  const [customerSummary, setCustomerSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);

  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [showFailModal, setShowFailModal] = useState(false);
  const [failReason, setFailReason] = useState("");
  const [showProcessModal, setShowProcessModal] = useState(false);
  const [processForm, setProcessForm] = useState({ gateway_refund_id: "", reference_number: "" });
  const [sendResult, setSendResult] = useState(null);

  const fetchRefund = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const data = await refundApi.get(id);
      setRefund(data);
      refundApi.getTimeline(id).then((d) => setTimeline(d?.entries || [])).catch(() => setTimeline([]));
      if (data?.customer_id) {
        refundApi.getCustomerSummary(data.customer_id).then(setCustomerSummary).catch(() => setCustomerSummary(null));
      }
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to load refund");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchRefund(); }, [fetchRefund]);

  const handleAction = async (action, actionFn) => {
    setActionLoading(action);
    setError(null);
    try {
      await actionFn();
      await fetchRefund({ silent: true });
    } catch (err) {
      setError(err?.detail || err?.message || `Failed to ${action} refund`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleSendEmail = async () => {
    setActionLoading("send-email");
    setSendResult(null);
    try {
      const result = await refundApi.sendEmail(id);
      if (result?.email_delivered === false) {
        setSendResult({ error: result.message || "Could not deliver the email." });
      } else {
        setSendResult(result);
      }
      await fetchRefund({ silent: true });
    } catch (err) {
      setSendResult({ error: err?.detail || err?.message || "Failed to send refund email" });
    } finally {
      setActionLoading(null);
    }
  };

  const handleDownloadPdf = async () => {
    if (!refund) return;
    const pdf = await buildRefundPdf(refund, {});
    pdf.download(`${(refund.refund_number || `refund-${refund.id}`).replace(/[^a-zA-Z0-9-_]/g, "_")}.pdf`);
  };

  if (loading) {
    return (
      <HRPage title="Refund" subtitle="Loading refund details...">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-brand-600" />
        </div>
      </HRPage>
    );
  }

  if (error && !refund) {
    return (
      <HRPage title="Refund" subtitle="Error loading refund">
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <AlertCircle className="h-10 w-10 text-red-400 mb-3" />
          <p className="text-sm text-red-600 mb-3">{error}</p>
          <button onClick={fetchRefund} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors">
            <RefreshCw className="h-4 w-4" /> Retry
          </button>
        </div>
      </HRPage>
    );
  }

  if (!refund) {
    return (
      <HRPage title="Refund" subtitle="Refund not found">
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Undo2 className="h-10 w-10 text-slate-300 mb-3" />
          <p className="text-sm font-medium text-slate-500">Refund not found</p>
        </div>
      </HRPage>
    );
  }

  const currency = refund.currency;
  const isDraft = refund.status === "draft";
  const isPendingApproval = refund.status === "pending_approval";
  const isApproved = refund.status === "approved";
  const isProcessing = refund.status === "processing";
  const isCompleted = refund.status === "completed";
  const canCancel = ["draft", "pending_approval", "approved", "failed"].includes(refund.status);

  const timelineEntries = timeline.map((entry, i) => ({
    id: entry.id || `timeline-${i}`,
    eventType: entry.event_type || "activity",
    title: entry.title || (entry.event_type || "Activity").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    description: entry.description,
    timestamp: entry.timestamp,
    actor: entry.actor_name || entry.user_name || entry.created_by_name || "System",
    status: entry.metadata?.to_status || entry.event_type,
    recipient: entry.metadata?.recipient,
  }));

  return (
    <HRPage
      title={`Refund ${refund.refund_number || `#${id}`}`}
      subtitle={<StatusBadge status={refund.status} />}
      actions={
        <button onClick={() => navigate("/billing/refunds")} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors">
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

        {/* ── HEADER: Summary + Quick Actions ── */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
          <div className="rounded-xl border border-slate-200 bg-white p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-slate-500">Refund Summary</p>
                <h2 className="mt-1 text-xl font-bold text-slate-900">{refund.customer_name || `${singular} #${refund.customer_id || "—"}`}</h2>
                <p className="mt-1 text-sm text-slate-500">
                  {refund.refund_number || `#${id}`} &middot; {currency} &middot; {(refund.refund_type || "").replace(/_/g, " ")} &middot; via {(refund.refund_source || "—").replace(/_/g, " ")}
                </p>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
                  {refund.payment_id && (
                    <button onClick={() => navigate(`/billing/payments/${refund.payment_id}`)} className="text-brand-600 hover:underline">Against Payment #{refund.payment_id}</button>
                  )}
                  {refund.invoice_id && (
                    <button onClick={() => navigate(`/billing/invoices/${refund.invoice_id}`)} className="text-brand-600 hover:underline">Against Invoice #{refund.invoice_id}</button>
                  )}
                  {refund.credit_note_id && (
                    <button onClick={() => navigate(`/billing/credit-notes/${refund.credit_note_id}`)} className="text-brand-600 hover:underline">Against Credit Note #{refund.credit_note_id}</button>
                  )}
                </div>
              </div>
              <StatusBadge status={refund.status} />
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-500">Amount</p>
                <p className="mt-1 text-lg font-bold text-sky-700 whitespace-nowrap">{formatDisplayCurrency(refund.amount, "—", currency)}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-500">Method</p>
                <p className="mt-1 text-sm font-semibold text-slate-900">{refund.refund_method ? refund.refund_method.replace(/_/g, " ") : "—"}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-500">Reference #</p>
                <p className="mt-1 text-sm font-semibold text-slate-900">{refund.reference_number || refund.gateway_refund_id || "—"}</p>
              </div>
            </div>
            <div className="mt-3 rounded-lg bg-slate-50 p-4">
              <p className="text-xs font-medium text-slate-500">Reason</p>
              <p className="mt-1 text-sm font-medium text-slate-900">{refund.reason || "—"}</p>
            </div>
            {refund.status === "failed" && refund.failure_reason && (
              <div className="mt-3 rounded-lg bg-red-50 p-4">
                <p className="text-xs font-medium text-red-600">Failure Reason</p>
                <p className="mt-1 text-sm font-medium text-red-800">{refund.failure_reason}</p>
              </div>
            )}
            {["cancelled", "rejected"].includes(refund.status) && refund.cancellation_reason && (
              <div className="mt-3 rounded-lg bg-slate-100 p-4">
                <p className="text-xs font-medium text-slate-500">{refund.status === "rejected" ? "Rejection" : "Cancellation"} Reason</p>
                <p className="mt-1 text-sm font-medium text-slate-900">{refund.cancellation_reason}</p>
              </div>
            )}
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Quick Actions</p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button onClick={() => window.print()} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50">
                <Printer className="h-3.5 w-3.5" /> Print
              </button>
              <button onClick={handleDownloadPdf} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50">
                <Download className="h-3.5 w-3.5" /> Download
              </button>

              {isDraft && (
                <button onClick={() => handleAction("submit", () => refundApi.submit(refund.id))} disabled={actionLoading === "submit"}
                  className="col-span-2 inline-flex items-center justify-center gap-1.5 rounded-lg bg-amber-600 px-3 py-2 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50">
                  {actionLoading === "submit" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Submit for Approval
                </button>
              )}
              {isPendingApproval && (
                <>
                  <button onClick={() => handleAction("approve", () => refundApi.approve(refund.id))} disabled={actionLoading === "approve"}
                    className="col-span-2 inline-flex items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                    {actionLoading === "approve" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle className="h-3.5 w-3.5" />} Approve
                  </button>
                  <button onClick={() => { setRejectReason(""); setShowRejectModal(true); }} disabled={actionLoading === "reject"}
                    className="col-span-2 inline-flex items-center justify-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50">
                    <XCircle className="h-3.5 w-3.5" /> Reject
                  </button>
                </>
              )}
              {isApproved && (
                <button onClick={() => { setProcessForm({ gateway_refund_id: "", reference_number: refund.reference_number || "" }); setShowProcessModal(true); }} disabled={actionLoading === "process"}
                  className="col-span-2 inline-flex items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                  {actionLoading === "process" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wallet className="h-3.5 w-3.5" />} Start Processing
                </button>
              )}
              {isProcessing && (
                <>
                  <button onClick={() => handleAction("complete", () => refundApi.complete(refund.id))} disabled={actionLoading === "complete"}
                    className="col-span-2 inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
                    {actionLoading === "complete" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle className="h-3.5 w-3.5" />} Mark Completed
                  </button>
                  <button onClick={() => { setFailReason(""); setShowFailModal(true); }} disabled={actionLoading === "fail"}
                    className="col-span-2 inline-flex items-center justify-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50">
                    <XCircle className="h-3.5 w-3.5" /> Mark Failed
                  </button>
                </>
              )}
              {isCompleted && (
                <button onClick={handleSendEmail} disabled={actionLoading === "send-email"}
                  className="col-span-2 inline-flex items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-sky-600 to-blue-600 px-3 py-2 text-xs font-medium text-white hover:shadow-lg disabled:opacity-50">
                  {actionLoading === "send-email" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />} Email Receipt
                </button>
              )}
              {canCancel && (
                <button onClick={() => { setCancelReason(""); setShowCancelModal(true); }} disabled={actionLoading === "cancel"}
                  className="col-span-2 inline-flex items-center justify-center gap-1.5 rounded-lg bg-red-600 px-3 py-2 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50">
                  {actionLoading === "cancel" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />} Cancel Refund
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ── AUDIT HISTORY ── */}
        <div className="rounded-xl border border-slate-200 bg-white p-6">
          <h4 className="text-sm font-semibold text-slate-900 mb-3">Audit History</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2 text-sm">
            {refund.approved_at && (
              <div className="flex justify-between"><span className="text-slate-500">Approved</span><span className="font-medium">{formatDisplayDate(refund.approved_at)}</span></div>
            )}
            {refund.processing_started_at && (
              <div className="flex justify-between"><span className="text-slate-500">Processing Started</span><span className="font-medium">{formatDisplayDate(refund.processing_started_at)}</span></div>
            )}
            {refund.completed_at && (
              <div className="flex justify-between"><span className="text-slate-500">Completed</span><span className="font-medium text-emerald-700">{formatDisplayDate(refund.completed_at)}</span></div>
            )}
            {refund.cancelled_at && (
              <div className="flex justify-between"><span className="text-slate-500">Cancelled</span><span className="font-medium text-red-600">{formatDisplayDate(refund.cancelled_at)}</span></div>
            )}
            <div className="flex justify-between"><span className="text-slate-500">Created</span><span className="font-medium">{formatDisplayDate(refund.created_at)}</span></div>
          </div>
        </div>

        {/* ── CUSTOMER REFUND HISTORY ── */}
        {customerSummary && (
          <div className="rounded-xl border border-slate-200 bg-white p-6">
            <h3 className="text-lg font-semibold text-slate-900 mb-4">Customer Refund History</h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-500">Total Refunded</p>
                <p className="mt-1 text-lg font-bold text-emerald-700 whitespace-nowrap">{formatDisplayCurrency(customerSummary.total_refunded, "—", currency)}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-500">Outstanding Requests</p>
                <p className="mt-1 text-lg font-bold text-amber-700 whitespace-nowrap">{formatDisplayCurrency(customerSummary.outstanding_refund_requests, "—", currency)}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-500">Total Refunds</p>
                <p className="mt-1 text-lg font-bold text-slate-900">{customerSummary.refund_count}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-500">Completed</p>
                <p className="mt-1 text-lg font-bold text-slate-900">{customerSummary.completed_count}</p>
              </div>
            </div>
            <button onClick={() => navigate(`/billing/refunds?customer_id=${refund.customer_id}`)} className="mt-3 text-xs text-brand-600 hover:underline">
              View all refunds for this {singular.toLowerCase()}
            </button>
          </div>
        )}

        {/* -- ACTIVITY TIMELINE (status history + audit + communications) -- */}
        <div className="bg-white rounded-3xl border border-slate-200 p-6">
          <h3 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
            <Clock className="h-4 w-4 text-sky-500" /> Refund Timeline &amp; Audit History
          </h3>
          <ActivityTimeline entries={timelineEntries} emptyMessage="No activity recorded for this refund yet." />
        </div>
      </div>

      {sendResult && !sendResult.error && (
        <div className="fixed bottom-6 right-6 z-50 max-w-sm bg-white rounded-2xl shadow-2xl border border-emerald-200 p-5">
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
              <CheckCircle className="h-5 w-5 text-emerald-600" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-slate-900">Refund Receipt Sent</p>
              <p className="text-xs text-slate-500 mt-1">{sendResult.message || `Emailed to ${sendResult.email_sent_to || "customer"}`}</p>
            </div>
            <button onClick={() => setSendResult(null)} className="text-slate-400 hover:text-slate-600 text-xs">✕</button>
          </div>
        </div>
      )}

      {sendResult && sendResult.error && (
        <div className="fixed bottom-6 right-6 z-50 max-w-sm bg-white rounded-2xl shadow-2xl border border-red-200 p-5">
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-full bg-red-100 flex items-center justify-center shrink-0">
              <AlertCircle className="h-5 w-5 text-red-600" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-slate-900">Failed to Send</p>
              <p className="text-xs text-slate-500 mt-1">{sendResult.error}</p>
            </div>
            <button onClick={() => setSendResult(null)} className="text-slate-400 hover:text-slate-600 text-xs">✕</button>
          </div>
        </div>
      )}

      {showProcessModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowProcessModal(false)}>
          <div className="bg-white rounded-3xl p-8 w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-slate-900 mb-4">Start Processing Refund</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Gateway Refund ID</label>
                <input type="text" value={processForm.gateway_refund_id} onChange={(e) => setProcessForm((p) => ({ ...p, gateway_refund_id: e.target.value }))}
                  placeholder="Optional gateway reference"
                  className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Reference Number</label>
                <input type="text" value={processForm.reference_number} onChange={(e) => setProcessForm((p) => ({ ...p, reference_number: e.target.value }))}
                  placeholder="Bank ref / UTR / cheque no."
                  className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button onClick={() => setShowProcessModal(false)} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-xl">Cancel</button>
              <button
                onClick={async () => { setShowProcessModal(false); await handleAction("process", () => refundApi.process(refund.id, processForm.gateway_refund_id || undefined, processForm.reference_number || undefined)); }}
                disabled={actionLoading === "process"}
                className="px-6 py-2 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 disabled:opacity-50 inline-flex items-center gap-2">
                {actionLoading === "process" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />} Start Processing
              </button>
            </div>
          </div>
        </div>
      )}

      {showRejectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowRejectModal(false)}>
          <div className="bg-white rounded-3xl p-8 w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-slate-900 mb-4">Reject Refund</h2>
            <textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} rows={3} placeholder="Reason for rejection (required)"
              className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30 mb-4" />
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowRejectModal(false)} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-xl">Go Back</button>
              <button
                onClick={async () => { setShowRejectModal(false); await handleAction("reject", () => refundApi.reject(refund.id, rejectReason)); }}
                disabled={actionLoading === "reject" || !rejectReason.trim()}
                className="px-6 py-2 bg-red-600 text-white rounded-xl text-sm font-medium hover:bg-red-700 disabled:opacity-50 inline-flex items-center gap-2">
                {actionLoading === "reject" ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />} Reject Refund
              </button>
            </div>
          </div>
        </div>
      )}

      {showFailModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowFailModal(false)}>
          <div className="bg-white rounded-3xl p-8 w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-slate-900 mb-4">Mark Refund as Failed</h2>
            <textarea value={failReason} onChange={(e) => setFailReason(e.target.value)} rows={3} placeholder="Failure reason (required)"
              className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30 mb-4" />
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowFailModal(false)} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-xl">Go Back</button>
              <button
                onClick={async () => { setShowFailModal(false); await handleAction("fail", () => refundApi.fail(refund.id, failReason)); }}
                disabled={actionLoading === "fail" || !failReason.trim()}
                className="px-6 py-2 bg-red-600 text-white rounded-xl text-sm font-medium hover:bg-red-700 disabled:opacity-50 inline-flex items-center gap-2">
                {actionLoading === "fail" ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />} Mark Failed
              </button>
            </div>
          </div>
        </div>
      )}

      {showCancelModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowCancelModal(false)}>
          <div className="bg-white rounded-3xl p-8 w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="h-10 w-10 rounded-full bg-red-100 flex items-center justify-center">
                <Ban className="h-5 w-5 text-red-600" />
              </div>
              <h2 className="text-lg font-bold text-slate-900">Cancel Refund</h2>
            </div>
            <p className="text-sm text-slate-600 mb-4">
              Are you sure you want to cancel <strong>{refund.refund_number || `#${id}`}</strong>? This action is <span className="font-semibold text-red-600">irreversible</span>.
            </p>
            <textarea value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} rows={2} placeholder="Reason (optional)"
              className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30 mb-4" />
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowCancelModal(false)} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-xl">Go Back</button>
              <button
                onClick={async () => { setShowCancelModal(false); await handleAction("cancel", () => refundApi.cancel(refund.id, cancelReason || undefined)); }}
                disabled={actionLoading === "cancel"}
                className="px-6 py-2 bg-red-600 text-white rounded-xl text-sm font-medium hover:bg-red-700 disabled:opacity-50 inline-flex items-center gap-2">
                {actionLoading === "cancel" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />} Cancel Refund
              </button>
            </div>
          </div>
        </div>
      )}
    </HRPage>
  );
}
