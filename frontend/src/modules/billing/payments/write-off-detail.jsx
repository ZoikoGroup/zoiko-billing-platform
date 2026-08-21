import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, ScrollText, RefreshCw, AlertCircle, Loader2, Send, CheckCircle,
  Ban, Printer, Download, Mail, X, Undo2, Clock } from "lucide-react"
import HRPage from "../../../components/HRPage";
import { writeOffApi } from "../../../service/billingService";
import { formatDisplayCurrency, formatDisplayDate } from "../../../utils/billing-helpers";
import { useTerminology } from "../utils/TerminologyContext";

// pdfmake + vfs_fonts are lazy-loaded inside buildWriteOffPdf() so the
// ~1.74 MB font bundle is only fetched when the user clicks "Download".

const STATUS_STYLES = {
  draft: "bg-slate-100 text-slate-600",
  pending_approval: "bg-amber-100 text-amber-700",
  approved: "bg-indigo-100 text-indigo-700",
  executed: "bg-emerald-100 text-emerald-700",
  reversed: "bg-orange-100 text-orange-700",
  cancelled: "bg-slate-200 text-slate-600",
};

function StatusBadge({ status }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium ${STATUS_STYLES[status] || "bg-slate-100 text-slate-600"}`}>
      {status ? status.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "Unknown"}
    </span>
  );
}

async function buildWriteOffPdf(writeOff, orgSettings = {}) {
  const pdfMakeModule = await import("pdfmake/build/pdfmake");
  const pdfFontsModule = await import("pdfmake/build/vfs_fonts");
  const pdfMake = pdfMakeModule.default;
  const pdfFonts = pdfFontsModule.default;
  pdfMake.vfs = pdfFonts.pdfMake ? pdfFonts.pdfMake.vfs : pdfFonts;

  const currency = writeOff.currency;
  const fmt = (v) => {
    if (v == null || v === "") return "—";
    const num = Number(v);
    if (Number.isNaN(num)) return "—";
    return `${currency} ${num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };
  const orgName = orgSettings.company_name || "Your Company";

  const detailLines = [
    { text: `Date: ${writeOff.executed_at ? formatDisplayDate(writeOff.executed_at) : formatDisplayDate(writeOff.created_at)}\n`, style: "dateLabel" },
    { text: `Status: ${(writeOff.status || "").replace(/_/g, " ")}\n`, style: "dateLabel" },
    { text: `Type: ${(writeOff.write_off_type || "").replace(/_/g, " ")}\n`, style: "dateLabel" },
  ];
  if (writeOff.adjustment_type) detailLines.push({ text: `Adjustment Type: ${writeOff.adjustment_type.replace(/_/g, " ")}\n`, style: "dateLabel" });
  if (writeOff.invoice_id) detailLines.push({ text: `Against Invoice: #${writeOff.invoice_id}\n`, style: "dateLabel" });

  const docDefinition = {
    content: [
      { text: "WRITE-OFF NOTICE", style: "title" },
      { text: writeOff.write_off_number || `#${writeOff.id}`, style: "subtitle", margin: [0, 2, 0, 10] },
      {
        columns: [
          { text: orgName, style: "companyName" },
          { text: detailLines, alignment: "right" },
        ],
        margin: [0, 10, 0, 10],
      },
      { text: "Account", style: "sectionLabel", margin: [0, 0, 0, 4] },
      { text: writeOff.customer_name || `#${writeOff.customer_id}`, style: "customerName" },
      writeOff.customer_email ? { text: writeOff.customer_email, style: "addressDetail" } : "",
      { text: "Reason", style: "sectionLabel", margin: [0, 10, 0, 4] },
      { text: writeOff.reason || "—", style: "bodyText" },
      {
        columns: [{ width: "*", text: "" }, { width: 220, table: { body: [[{ text: "Amount", style: "totalsGrandLabel" }, { text: fmt(writeOff.amount), style: "totalsGrandValue" }]], widths: [120, "*"] }, layout: "noBorders" }],
        margin: [0, 14, 0, 0],
      },
    ],
    styles: {
      title: { fontSize: 20, bold: true, color: "#B45309" },
      subtitle: { fontSize: 11, color: "#6b7280" },
      companyName: { fontSize: 13, bold: true, color: "#1e293b" },
      dateLabel: { fontSize: 9, color: "#6b7280" },
      sectionLabel: { fontSize: 9, bold: true, color: "#6b7280" },
      customerName: { fontSize: 11, bold: true, color: "#1e293b" },
      addressDetail: { fontSize: 9, color: "#6b7280" },
      bodyText: { fontSize: 9, color: "#374151" },
      totalsGrandLabel: { fontSize: 11, bold: true, color: "#1e293b" },
      totalsGrandValue: { fontSize: 13, bold: true, color: "#B45309", alignment: "right" },
    },
    defaultStyle: { font: "Roboto" },
  };
  return pdfMake.createPdf(docDefinition);
}

export default function WriteOffDetailPage() {
  const { singular } = useTerminology();
  const { id } = useParams();
  const navigate = useNavigate();

  const [writeOff, setWriteOff] = useState(null);
  const [timeline, setTimeline] = useState([]);
  const [customerSummary, setCustomerSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);

  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [showReverseModal, setShowReverseModal] = useState(false);
  const [reverseReason, setReverseReason] = useState("");
  const [sendResult, setSendResult] = useState(null);

  const fetchWriteOff = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await writeOffApi.get(id);
      setWriteOff(data);
      writeOffApi.getTimeline(id).then((d) => setTimeline(d?.entries || [])).catch(() => setTimeline([]));
      if (data?.customer_id) {
        writeOffApi.getCustomerSummary(data.customer_id).then(setCustomerSummary).catch(() => setCustomerSummary(null));
      }
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to load write-off");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchWriteOff(); }, [fetchWriteOff]);

  const handleAction = async (action, actionFn) => {
    setActionLoading(action);
    setError(null);
    try {
      await actionFn();
      await fetchWriteOff();
    } catch (err) {
      setError(err?.detail || err?.message || `Failed to ${action} write-off`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleSendEmail = async () => {
    setActionLoading("send-email");
    setSendResult(null);
    try {
      const result = await writeOffApi.sendEmail(id);
      if (result?.email_delivered === false) {
        setSendResult({ error: result.message || "Could not deliver the email." });
      } else {
        setSendResult(result);
      }
      await fetchWriteOff();
    } catch (err) {
      setSendResult({ error: err?.detail || err?.message || "Failed to send write-off email" });
    } finally {
      setActionLoading(null);
    }
  };

  const handleDownloadPdf = async () => {
    if (!writeOff) return;
    const pdf = await buildWriteOffPdf(writeOff, {});
    pdf.download(`${(writeOff.write_off_number || `write-off-${writeOff.id}`).replace(/[^a-zA-Z0-9-_]/g, "_")}.pdf`);
  };

  if (loading) {
    return (
      <HRPage title="Write-off" subtitle="Loading write-off details...">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-brand-600" />
        </div>
      </HRPage>
    );
  }

  if (error && !writeOff) {
    return (
      <HRPage title="Write-off" subtitle="Error loading write-off">
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <AlertCircle className="h-10 w-10 text-red-400 mb-3" />
          <p className="text-sm text-red-600 mb-3">{error}</p>
          <button onClick={fetchWriteOff} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors">
            <RefreshCw className="h-4 w-4" /> Retry
          </button>
        </div>
      </HRPage>
    );
  }

  if (!writeOff) {
    return (
      <HRPage title="Write-off" subtitle="Write-off not found">
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <ScrollText className="h-10 w-10 text-slate-300 mb-3" />
          <p className="text-sm font-medium text-slate-500">Write-off not found</p>
        </div>
      </HRPage>
    );
  }

  const currency = writeOff.currency;
  const isDraft = writeOff.status === "draft";
  const isPendingApproval = writeOff.status === "pending_approval";
  const isApproved = writeOff.status === "approved";
  const isExecuted = writeOff.status === "executed";
  const canCancel = ["draft", "pending_approval", "approved"].includes(writeOff.status);

  return (
    <HRPage
      title={`Write-off ${writeOff.write_off_number || `#${id}`}`}
      subtitle={<StatusBadge status={writeOff.status} />}
      actions={
        <button onClick={() => navigate("/billing/write-offs")} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors">
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
          <div className="rounded-3xl border border-slate-200 bg-white p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-slate-500">Write-off Summary</p>
                <h2 className="mt-1 text-xl font-bold text-slate-900">{writeOff.customer_name || `${singular} #${writeOff.customer_id || "—"}`}</h2>
                <p className="mt-1 text-sm text-slate-500">
                  {writeOff.write_off_number || `#${id}`} &middot; {currency} &middot; {(writeOff.write_off_type || "").replace(/_/g, " ")} &middot; via {(writeOff.write_off_source || "—").replace(/_/g, " ")}
                </p>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
                  {writeOff.invoice_id && (
                    <button onClick={() => navigate(`/billing/invoices/${writeOff.invoice_id}`)} className="text-brand-600 hover:underline">Against Invoice #{writeOff.invoice_id}</button>
                  )}
                </div>
              </div>
              <StatusBadge status={writeOff.status} />
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-500">Amount</p>
                <p className="mt-1 text-lg font-bold text-amber-700 whitespace-nowrap">{formatDisplayCurrency(writeOff.amount, "—", currency)}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-500">Adjustment Type</p>
                <p className="mt-1 text-sm font-semibold text-slate-900">{writeOff.adjustment_type ? writeOff.adjustment_type.replace(/_/g, " ") : "—"}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-500">Exchange Rate</p>
                <p className="mt-1 text-sm font-semibold text-slate-900">{writeOff.exchange_rate || "—"}</p>
              </div>
            </div>
            <div className="mt-3 rounded-lg bg-slate-50 p-4">
              <p className="text-xs font-medium text-slate-500">Reason</p>
              <p className="mt-1 text-sm font-medium text-slate-900">{writeOff.reason || "—"}</p>
            </div>
            {writeOff.notes && (
              <div className="mt-3 rounded-lg bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-500">Notes</p>
                <p className="mt-1 text-sm font-medium text-slate-900">{writeOff.notes}</p>
              </div>
            )}
            {writeOff.status === "reversed" && writeOff.reversal_reason && (
              <div className="mt-3 rounded-lg bg-orange-50 p-4">
                <p className="text-xs font-medium text-orange-600">Reversal Reason</p>
                <p className="mt-1 text-sm font-medium text-orange-800">{writeOff.reversal_reason}</p>
              </div>
            )}
            {writeOff.status === "cancelled" && writeOff.cancellation_reason && (
              <div className="mt-3 rounded-lg bg-slate-100 p-4">
                <p className="text-xs font-medium text-slate-500">Cancellation Reason</p>
                <p className="mt-1 text-sm font-medium text-slate-900">{writeOff.cancellation_reason}</p>
              </div>
            )}
          </div>
          <div className="rounded-3xl border border-slate-200 bg-white p-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Quick Actions</p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <button onClick={() => window.print()} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50">
                <Printer className="h-3.5 w-3.5" /> Print
              </button>
              <button onClick={handleDownloadPdf} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50">
                <Download className="h-3.5 w-3.5" /> Download
              </button>

              {isDraft && (
                <button onClick={() => handleAction("submit", () => writeOffApi.submit(writeOff.id))} disabled={actionLoading === "submit"}
                  className="col-span-2 inline-flex items-center justify-center gap-1.5 rounded-lg bg-amber-600 px-3 py-2 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50">
                  {actionLoading === "submit" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />} Submit for Approval
                </button>
              )}
              {isPendingApproval && (
                <button onClick={() => handleAction("approve", () => writeOffApi.approve(writeOff.id))} disabled={actionLoading === "approve"}
                  className="col-span-2 inline-flex items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
                  {actionLoading === "approve" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle className="h-3.5 w-3.5" />} Approve
                </button>
              )}
              {isApproved && (
                <button onClick={() => handleAction("execute", () => writeOffApi.execute(writeOff.id))} disabled={actionLoading === "execute"}
                  className="col-span-2 inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
                  {actionLoading === "execute" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle className="h-3.5 w-3.5" />} Execute Write-off
                </button>
              )}
              {isExecuted && (
                <>
                  <button onClick={handleSendEmail} disabled={actionLoading === "send-email"}
                    className="col-span-2 inline-flex items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-amber-600 to-orange-600 px-3 py-2 text-xs font-medium text-white hover:shadow-lg disabled:opacity-50">
                    {actionLoading === "send-email" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />} Email Notice
                  </button>
                  <button onClick={() => { setReverseReason(""); setShowReverseModal(true); }} disabled={actionLoading === "reverse"}
                    className="col-span-2 inline-flex items-center justify-center gap-1.5 rounded-lg border border-orange-200 px-3 py-2 text-xs font-medium text-orange-700 hover:bg-orange-50 disabled:opacity-50">
                    <Undo2 className="h-3.5 w-3.5" /> Reverse Write-off
                  </button>
                </>
              )}
              {canCancel && (
                <button onClick={() => { setCancelReason(""); setShowCancelModal(true); }} disabled={actionLoading === "cancel"}
                  className="col-span-2 inline-flex items-center justify-center gap-1.5 rounded-lg bg-red-600 px-3 py-2 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50">
                  {actionLoading === "cancel" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />} Cancel Write-off
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ── AUDIT HISTORY ── */}
        <div className="rounded-3xl border border-slate-200 bg-white p-6">
          <h4 className="text-sm font-semibold text-slate-900 mb-3">Audit History</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2 text-sm">
            {writeOff.approved_at && (
              <div className="flex justify-between"><span className="text-slate-500">Approved</span><span className="font-medium">{formatDisplayDate(writeOff.approved_at)}</span></div>
            )}
            {writeOff.executed_at && (
              <div className="flex justify-between"><span className="text-slate-500">Executed</span><span className="font-medium text-emerald-700">{formatDisplayDate(writeOff.executed_at)}</span></div>
            )}
            {writeOff.reversed_at && (
              <div className="flex justify-between"><span className="text-slate-500">Reversed</span><span className="font-medium text-orange-700">{formatDisplayDate(writeOff.reversed_at)}</span></div>
            )}
            {writeOff.cancelled_at && (
              <div className="flex justify-between"><span className="text-slate-500">Cancelled</span><span className="font-medium text-red-600">{formatDisplayDate(writeOff.cancelled_at)}</span></div>
            )}
            <div className="flex justify-between"><span className="text-slate-500">Created</span><span className="font-medium">{formatDisplayDate(writeOff.created_at)}</span></div>
          </div>
        </div>

        {/* ── CUSTOMER WRITE-OFF HISTORY ── */}
        {customerSummary && (
          <div className="rounded-3xl border border-slate-200 bg-white p-6">
            <h3 className="text-lg font-semibold text-slate-900 mb-4">Customer Write-off History</h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-500">Total Written Off</p>
                <p className="mt-1 text-lg font-bold text-emerald-700 whitespace-nowrap">{formatDisplayCurrency(customerSummary.total_written_off, "—", currency)}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-500">Outstanding Requests</p>
                <p className="mt-1 text-lg font-bold text-amber-700 whitespace-nowrap">{formatDisplayCurrency(customerSummary.outstanding_write_off_requests, "—", currency)}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-500">Total Write-offs</p>
                <p className="mt-1 text-lg font-bold text-slate-900">{customerSummary.write_off_count}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-500">Executed</p>
                <p className="mt-1 text-lg font-bold text-slate-900">{customerSummary.executed_count}</p>
              </div>
            </div>
            <button onClick={() => navigate(`/billing/write-offs?customer_id=${writeOff.customer_id}`)} className="mt-3 text-xs text-brand-600 hover:underline">
              View all write-offs for this {singular.toLowerCase()}
            </button>
          </div>
        )}

        {/* ── ACTIVITY TIMELINE (status history + audit + communications) ── */}
        {timeline.length > 0 && (
          <div className="bg-white rounded-3xl border border-slate-200 p-6">
            <h3 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
              <Clock className="h-4 w-4 text-amber-500" /> Write-off Timeline &amp; Audit History
            </h3>
            <div className="relative">
              <div className="absolute left-4 top-2 bottom-2 w-0.5 bg-slate-200" />
              <div className="space-y-4">
                {timeline.map((entry, i) => {
                  const dotColor = {
                    status_change: "bg-amber-400 border-amber-400",
                    email_sent: "bg-blue-400 border-blue-400",
                    email_delivered: "bg-emerald-400 border-emerald-400",
                    email_failed: "bg-red-400 border-red-400",
                    note_added: "bg-slate-400 border-slate-400",
                    manual_resend: "bg-brand-400 border-brand-400",
                  }[entry.event_type] || "bg-amber-400 border-amber-400";
                  return (
                    <div key={i} className="relative flex items-start gap-4 pl-10">
                      <div className={`absolute left-2.5 w-3 h-3 rounded-full border-2 mt-1.5 ${dotColor}`} />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-slate-900">{entry.title}</span>
                        {entry.description && <p className="text-xs text-slate-500 mt-0.5">{entry.description}</p>}
                        <p className="text-xs text-slate-400 mt-1">
                          {formatDisplayDate(entry.timestamp)}
                          {entry.metadata?.recipient ? ` · ${entry.metadata.recipient}` : ""}
                          {entry.metadata?.from_status && entry.metadata?.to_status ? (
                            <> · {entry.metadata.from_status?.replace(/_/g, " ")} → {entry.metadata.to_status?.replace(/_/g, " ")}</>
                          ) : ""}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {sendResult && !sendResult.error && (
        <div className="fixed bottom-6 right-6 z-50 max-w-sm bg-white rounded-2xl shadow-2xl border border-emerald-200 p-5">
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
              <CheckCircle className="h-5 w-5 text-emerald-600" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-slate-900">Write-off Notice Sent</p>
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

      {showReverseModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowReverseModal(false)}>
          <div className="bg-white rounded-3xl p-8 w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-bold text-slate-900 mb-4">Reverse Write-off</h2>
            <p className="text-sm text-slate-600 mb-4">
              Reversing <strong>{writeOff.write_off_number || `#${id}`}</strong> will reopen the outstanding balance it reduced.
            </p>
            <textarea value={reverseReason} onChange={(e) => setReverseReason(e.target.value)} rows={3} placeholder="Reason for reversal (required)"
              className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30 mb-4" />
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowReverseModal(false)} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-xl">Go Back</button>
              <button
                onClick={async () => { setShowReverseModal(false); await handleAction("reverse", () => writeOffApi.reverse(writeOff.id, reverseReason)); }}
                disabled={actionLoading === "reverse" || !reverseReason.trim()}
                className="px-6 py-2 bg-orange-600 text-white rounded-xl text-sm font-medium hover:bg-orange-700 disabled:opacity-50 inline-flex items-center gap-2">
                {actionLoading === "reverse" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />} Reverse Write-off
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
              <h2 className="text-lg font-bold text-slate-900">Cancel Write-off</h2>
            </div>
            <p className="text-sm text-slate-600 mb-4">
              Are you sure you want to cancel <strong>{writeOff.write_off_number || `#${id}`}</strong>? This action is <span className="font-semibold text-red-600">irreversible</span>.
            </p>
            <textarea value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} rows={2} placeholder="Reason (optional)"
              className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30 mb-4" />
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowCancelModal(false)} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-xl">Go Back</button>
              <button
                onClick={async () => { setShowCancelModal(false); await handleAction("cancel", () => writeOffApi.cancel(writeOff.id, cancelReason || undefined)); }}
                disabled={actionLoading === "cancel"}
                className="px-6 py-2 bg-red-600 text-white rounded-xl text-sm font-medium hover:bg-red-700 disabled:opacity-50 inline-flex items-center gap-2">
                {actionLoading === "cancel" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />} Cancel Write-off
              </button>
            </div>
          </div>
        </div>
      )}
    </HRPage>
  );
}
