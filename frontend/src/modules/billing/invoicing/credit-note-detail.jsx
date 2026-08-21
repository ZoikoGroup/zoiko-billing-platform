import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft, RefreshCw, AlertCircle, Loader2, Send, CheckCircle,
  Ban, Printer, Download, Mail, X, Receipt, Wallet,
} from "lucide-react";
import { creditNoteApi } from "../../../service/billingService";
import { formatDisplayCurrency, formatDisplayDate } from "../../../utils/billing-helpers";
import { useTerminology } from "../utils/TerminologyContext";
import { StatusBadge } from "../../../components/billing-shared";
import { PageHeader, Button, Modal, ActivityTimeline, CommunicationHistory } from "../../../components/billing-ui";

// pdfmake + vfs_fonts are lazy-loaded inside buildCreditNotePdf() so the
// ~1.74 MB font bundle is only fetched when the user clicks "Download".

const STATUS_OPTIONS = [
  { value: "draft", label: "Draft", color: "bg-slate-100 text-slate-700" },
  { value: "approved", label: "Approved", color: "bg-indigo-100 text-indigo-700" },
  { value: "issued", label: "Issued", color: "bg-blue-100 text-blue-700" },
  { value: "partially_applied", label: "Partially Applied", color: "bg-amber-100 text-amber-700" },
  { value: "fully_applied", label: "Fully Applied", color: "bg-emerald-100 text-emerald-700" },
  { value: "voided", label: "Voided", color: "bg-red-100 text-red-700" },
];

const inputClass = "block w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30";
const cardClass = "rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]";
const labelClass = "text-xs font-medium uppercase tracking-wider text-slate-500";

async function buildCreditNotePdf(cn, orgSettings = {}) {
  const pdfMakeModule = await import("pdfmake/build/pdfmake");
  const pdfFontsModule = await import("pdfmake/build/vfs_fonts");
  const pdfMake = pdfMakeModule.default;
  const pdfFonts = pdfFontsModule.default;
  pdfMake.vfs = pdfFonts.pdfMake ? pdfFonts.pdfMake.vfs : pdfFonts;

  const currency = cn.currency;
  const fmt = (v) => {
    if (v == null || v === "") return "—";
    const num = Number(v);
    if (Number.isNaN(num)) return "—";
    return `${currency} ${num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };
  const orgName = orgSettings.company_name || "Your Company";

  const totalsBody = [
    [{ text: "Subtotal", style: "totalsLabel" }, { text: fmt(cn.subtotal || 0), style: "totalsValue" }],
  ];
  if (Number(cn.discount_amount || 0) > 0) {
    totalsBody.push([{ text: "Discount", style: "totalsLabel" }, { text: "-" + fmt(cn.discount_amount), style: "totalsValueRed" }]);
  }
  totalsBody.push([{ text: "Tax", style: "totalsLabel" }, { text: fmt(cn.tax_amount || 0), style: "totalsValue" }]);
  totalsBody.push([{ text: "Total", style: "totalsGrandLabel" }, { text: fmt(cn.total_amount || 0), style: "totalsGrandValue" }]);
  totalsBody.push([{ text: "Remaining", style: "totalsLabel" }, { text: fmt(cn.remaining_amount || 0), style: "totalsValue" }]);

  const docDefinition = {
    content: [
      { text: "CREDIT NOTE", style: "title" },
      { text: cn.credit_note_number || `#${cn.id}`, style: "subtitle", margin: [0, 2, 0, 10] },
      {
        columns: [
          { text: orgName, style: "companyName" },
          { text: [
            { text: `Issue Date: ${cn.issue_date ? formatDisplayDate(cn.issue_date) : "—"}\n`, style: "dateLabel" },
            { text: `Status: ${(cn.status || "").replace(/_/g, " ")}\n`, style: "dateLabel" },
            cn.invoice_id ? { text: `Against Invoice: #${cn.invoice_id}\n`, style: "dateLabel" } : "",
          ], alignment: "right" },
        ],
        margin: [0, 10, 0, 10],
      },
      { text: "Credited To", style: "sectionLabel", margin: [0, 0, 0, 4] },
      { text: cn.customer_name || `#${cn.customer_id}`, style: "customerName" },
      cn.customer_email ? { text: cn.customer_email, style: "addressDetail" } : "",
      { text: "Reason", style: "sectionLabel", margin: [0, 10, 0, 4] },
      { text: cn.reason || "—", style: "bodyText" },
      { columns: [{ width: "*", text: "" }, { width: 220, table: { body: totalsBody, widths: [120, "*"] }, layout: "noBorders" }], margin: [0, 14, 0, 0] },
    ],
    styles: {
      title: { fontSize: 20, bold: true, color: "#DC2626" },
      subtitle: { fontSize: 11, color: "#6b7280" },
      companyName: { fontSize: 13, bold: true, color: "#1e293b" },
      dateLabel: { fontSize: 9, color: "#6b7280" },
      sectionLabel: { fontSize: 9, bold: true, color: "#6b7280" },
      customerName: { fontSize: 11, bold: true, color: "#1e293b" },
      addressDetail: { fontSize: 9, color: "#6b7280" },
      bodyText: { fontSize: 9, color: "#374151" },
      totalsLabel: { fontSize: 9, color: "#6b7280" },
      totalsValue: { fontSize: 9, bold: true, color: "#1e293b", alignment: "right" },
      totalsValueRed: { fontSize: 9, bold: true, color: "#dc2626", alignment: "right" },
      totalsGrandLabel: { fontSize: 11, bold: true, color: "#1e293b" },
      totalsGrandValue: { fontSize: 13, bold: true, color: "#DC2626", alignment: "right" },
    },
    defaultStyle: { font: "Roboto" },
  };
  return pdfMake.createPdf(docDefinition);
}

export default function CreditNoteDetailPage() {
  const { singular, getLabel } = useTerminology();
  const { id } = useParams();
  const navigate = useNavigate();

  const [cn, setCn] = useState(null);
  const [applications, setApplications] = useState([]);
  const [timeline, setTimeline] = useState([]);
  const [communications, setCommunications] = useState([]);
  const [creditBalance, setCreditBalance] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);

  const [showApplyModal, setShowApplyModal] = useState(false);
  const [applyForm, setApplyForm] = useState({ invoice_id: "", amount: "" });
  const [showVoidModal, setShowVoidModal] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  const [sendResult, setSendResult] = useState(null);
  const [formError, setFormError] = useState(null);

  const fetchCreditNote = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const data = await creditNoteApi.get(id);
      setCn(data);
      creditNoteApi.listApplications(id).then((d) => setApplications(Array.isArray(d) ? d : [])).catch(() => setApplications([]));
      creditNoteApi.getTimeline(id).then((d) => setTimeline(d?.entries || [])).catch(() => setTimeline([]));
      creditNoteApi.listCommunications(id).then((d) => setCommunications(Array.isArray(d) ? d : [])).catch(() => setCommunications([]));
      if (data?.customer_id) {
        creditNoteApi.getCustomerBalance(data.customer_id).then(setCreditBalance).catch(() => setCreditBalance(null));
      }
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to load credit note");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchCreditNote(); }, [fetchCreditNote]);

  const handleAction = async (action, actionFn) => {
    setActionLoading(action);
    setError(null);
    try {
      await actionFn();
      await fetchCreditNote({ silent: true });
    } catch (err) {
      setError(err?.detail || err?.message || `Failed to ${action} credit note`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleSendEmail = async () => {
    setActionLoading("send-email");
    setSendResult(null);
    try {
      const result = await creditNoteApi.sendEmail(id);
      if (result?.email_delivered === false) {
        setSendResult({ error: result.message || "Could not deliver the email." });
      } else {
        setSendResult(result);
      }
      await fetchCreditNote({ silent: true });
    } catch (err) {
      setSendResult({ error: err?.detail || err?.message || "Failed to send credit note email" });
    } finally {
      setActionLoading(null);
    }
  };

  const handleApply = async () => {
    if (!cn) return;
    const amount = Number(applyForm.amount);
    if (!amount || amount <= 0) { setFormError("Amount must be greater than 0"); return; }
    if (amount > Number(cn.remaining_amount || 0)) {
      setFormError(`Amount cannot exceed the remaining credit balance of ${formatDisplayCurrency(cn.remaining_amount, "—", currency)}`);
      return;
    }
    try {
      setActionLoading("apply");
      setFormError(null);
      await creditNoteApi.applyToInvoice(cn.id, {
        invoice_id: Number(applyForm.invoice_id),
        amount: Number(applyForm.amount),
      });
      setShowApplyModal(false);
      await fetchCreditNote({ silent: true });
    } catch (err) {
      setFormError(err?.detail || err?.message || "Failed to apply credit note");
    } finally {
      setActionLoading(null);
    }
  };

  const handleDownloadPdf = async () => {
    if (!cn) return;
    const pdf = await buildCreditNotePdf(cn, {});
    pdf.download(`${(cn.credit_note_number || `credit-note-${cn.id}`).replace(/[^a-zA-Z0-9-_]/g, "_")}.pdf`);
  };

  if (loading) {
    return (
      <div className="space-y-6 px-4 py-6 sm:px-6">
        <PageHeader
          crumbs={[{ label: "Billing", href: "/billing" }, { label: "Credit Notes", href: "/billing/credit-notes" }, { label: "Credit Note" }]}
          title="Credit Note"
          description="Loading credit note details…"
          icon={Receipt}
        />
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-brand-500" />
        </div>
      </div>
    );
  }

  if (error && !cn) {
    return (
      <div className="space-y-6 px-4 py-6 sm:px-6">
        <PageHeader
          crumbs={[{ label: "Billing", href: "/billing" }, { label: "Credit Notes", href: "/billing/credit-notes" }, { label: "Credit Note" }]}
          title="Credit Note"
          description="Error loading credit note"
          icon={Receipt}
          actions={<Button variant="secondary" icon={ArrowLeft} onClick={() => navigate("/billing/credit-notes")}>Back</Button>}
        />
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <AlertCircle className="h-10 w-10 text-red-400 mb-3" />
          <p className="text-sm text-red-600 mb-3">{error}</p>
          <Button variant="primary" icon={RefreshCw} onClick={fetchCreditNote}>Retry</Button>
        </div>
      </div>
    );
  }

  if (!cn) {
    return (
      <div className="space-y-6 px-4 py-6 sm:px-6">
        <PageHeader
          crumbs={[{ label: "Billing", href: "/billing" }, { label: "Credit Notes", href: "/billing/credit-notes" }, { label: "Credit Note" }]}
          title="Credit Note"
          description="Credit note not found"
          icon={Receipt}
          actions={<Button variant="secondary" icon={ArrowLeft} onClick={() => navigate("/billing/credit-notes")}>Back</Button>}
        />
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Receipt className="h-10 w-10 text-slate-300 mb-3" />
          <p className="text-sm font-medium text-slate-500">Credit note not found</p>
        </div>
      </div>
    );
  }

  const currency = cn.currency;
  const isDraft = cn.status === "draft";
  const isApproved = cn.status === "approved";
  const canApply = cn.status === "issued" || cn.status === "partially_applied";
  const canEmail = cn.status === "issued" || cn.status === "partially_applied" || cn.status === "fully_applied";
  const canVoid = cn.status !== "voided" && cn.status !== "fully_applied";

  const timelineEntries = timeline.map((entry, i) => ({
    id: entry.id || `timeline-${i}`,
    eventType: entry.event_type || "activity",
    title: entry.title || (entry.event_type || "Activity").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    description: entry.description,
    timestamp: entry.timestamp,
    actor: entry.actor_name || entry.user_name || entry.created_by_name || "System",
    status: entry.metadata?.to_status || entry.event_type,
    recipient: entry.metadata?.recipient,
    amount: entry.metadata?.amount ? formatDisplayCurrency(entry.metadata.amount, "—", currency) : undefined,
  }));

  const communicationEntries = communications.map((comm, i) => ({
    id: comm.id || `comm-${i}`,
    type: (comm.event_type || comm.type || "Communication").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    recipient: comm.recipient || comm.email_to,
    subject: comm.subject || (cn.credit_note_number ? `Credit Note ${cn.credit_note_number}` : "Credit note communication"),
    status: (comm.status || (comm.event_type?.includes("failed") ? "failed" : comm.event_type?.includes("delivered") ? "delivered" : "sent") || "recorded").toLowerCase(),
    createdAt: comm.created_at,
    sentAt: comm.sent_at,
    deliveredAt: comm.delivered_at,
    openedAt: comm.opened_at,
    failedAt: comm.failed_at,
    reminderNumber: comm.reminder_number,
    attachments: comm.attachments,
    providerResponse: comm.provider_response || comm.error_message,
    preview: comm.body_preview || comm.message,
  }));

  return (
    <>
      <div className="space-y-6 px-4 py-6 sm:px-6">
        <PageHeader
          crumbs={[{ label: "Billing", href: "/billing" }, { label: "Credit Notes", href: "/billing/credit-notes" }, { label: cn.credit_note_number || `#${id}` }]}
          title={cn.credit_note_number || `#${id}`}
          description={`${cn.customer_name || `${singular} #${cn.customer_id || "—"}`} · ${currency} · ${(cn.credit_note_type || "").replace(/_/g, " ")} · issued ${formatDisplayDate(cn.issue_date)}`}
          icon={Receipt}
          meta={<StatusBadge status={cn.status} options={STATUS_OPTIONS} />}
          actions={
            <>
              <Button variant="secondary" icon={Download} onClick={handleDownloadPdf}>Download</Button>
              <Button variant="secondary" icon={ArrowLeft} onClick={() => navigate("/billing/credit-notes")}>Back</Button>
            </>
          }
        />

        {error && (
          <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span className="flex-1">{error}</span>
            <button onClick={() => setError(null)} className="shrink-0 opacity-70 hover:opacity-100"><X className="h-4 w-4" /></button>
          </div>
        )}

        {/* ── HEADER: Summary + Quick Actions ── */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
          <div className={cardClass}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className={labelClass}>Credit Note Summary</p>
                <h2 className="mt-1 text-xl font-bold text-slate-900">{cn.customer_name || `${singular} #${cn.customer_id || "—"}`}</h2>
                <p className="mt-1 text-sm text-slate-500">
                  {cn.credit_note_number || `#${id}`} &middot; {currency} &middot; {(cn.credit_note_type || "").replace(/_/g, " ")} &middot; issued {formatDisplayDate(cn.issue_date)}
                </p>
                {cn.invoice_id && (
                  <button onClick={() => navigate(`/billing/invoices/${cn.invoice_id}`)} className="mt-0.5 text-xs text-brand-600 hover:underline">
                    Against Invoice #{cn.invoice_id}
                  </button>
                )}
              </div>
              <StatusBadge status={cn.status} options={STATUS_OPTIONS} />
            </div>
            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-500">Subtotal</p>
                <p className="mt-1 text-lg font-bold text-slate-900 whitespace-nowrap">{formatDisplayCurrency(cn.subtotal || 0, "—", currency)}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-500">Discount</p>
                <p className="mt-1 text-lg font-bold text-red-600 whitespace-nowrap">-{formatDisplayCurrency(cn.discount_amount || 0, "—", currency)}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-500">Tax</p>
                <p className="mt-1 text-lg font-bold text-slate-900 whitespace-nowrap">{formatDisplayCurrency(cn.tax_amount || 0, "—", currency)}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-500">Total</p>
                <p className="mt-1 text-lg font-bold text-brand-600 whitespace-nowrap">{formatDisplayCurrency(cn.total_amount, "—", currency)}</p>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-lg bg-amber-50 p-4">
                <p className="text-xs font-medium text-amber-600">Remaining Balance</p>
                <p className="mt-1 text-lg font-bold text-amber-700 whitespace-nowrap">{formatDisplayCurrency(cn.remaining_amount, "—", currency)}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-500">Reason</p>
                <p className="mt-1 text-sm font-medium text-slate-900">{cn.reason || "—"}</p>
              </div>
            </div>
          </div>
          <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
            <p className={labelClass}>Quick Actions</p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              <Button size="sm" variant="secondary" icon={Printer} onClick={() => window.print()} className="w-full">Print</Button>
              <Button size="sm" variant="secondary" icon={Download} onClick={handleDownloadPdf} className="w-full">Download</Button>
              {isDraft && (
                <Button size="sm" variant="secondary" icon={CheckCircle} loading={actionLoading === "approve"} onClick={() => handleAction("approve", () => creditNoteApi.approve(cn.id))} className="col-span-2 w-full">Approve</Button>
              )}
              {isApproved && (
                <Button size="sm" variant="primary" icon={Send} loading={actionLoading === "issue"} onClick={() => handleAction("issue", () => creditNoteApi.issue(cn.id))} className="col-span-2 w-full">Issue</Button>
              )}
              {canApply && (
                <Button size="sm" variant="primary" icon={Wallet} onClick={() => { setApplyForm({ invoice_id: cn.invoice_id ? String(cn.invoice_id) : "", amount: String(cn.remaining_amount || "") }); setFormError(null); setShowApplyModal(true); }} className="col-span-2 w-full">Apply to Invoice</Button>
              )}
              {canEmail && (
                <Button size="sm" variant="secondary" icon={Mail} loading={actionLoading === "send-email"} onClick={handleSendEmail} className="col-span-2 w-full">Email</Button>
              )}
              {canVoid && (
                <Button size="sm" variant="danger" icon={Ban} loading={actionLoading === "void"} onClick={() => { setVoidReason(""); setShowVoidModal(true); }} className="col-span-2 w-full">Void</Button>
              )}
            </div>
          </div>
        </div>

        {/* ── CUSTOMER INFORMATION ── */}
        <div className={cardClass}>
          <h3 className="text-lg font-semibold text-slate-900 mb-4">{singular} Information</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-3">
              <div>
                <p className={labelClass}>Name</p>
                <p className="text-sm font-semibold text-slate-900 mt-0.5">{cn.customer_name || "—"}</p>
              </div>
              <div>
                <p className={labelClass}>Email</p>
                <p className="text-sm text-slate-900 mt-0.5">{cn.customer_email || "—"}</p>
              </div>
              <div>
                <p className={labelClass}>Phone</p>
                <p className="text-sm text-slate-900 mt-0.5">{cn.customer_phone || "—"}</p>
              </div>
            </div>
            <div className="space-y-3">
              <div>
                <p className={labelClass}>Billing Address</p>
                <p className="text-sm text-slate-900 mt-0.5 whitespace-pre-line">{cn.customer_billing_address || "—"}</p>
              </div>
              <div>
                <p className={labelClass}>Outstanding Credit Balance</p>
                <p className="text-sm font-semibold text-emerald-700 mt-0.5">
                  {creditBalance ? formatDisplayCurrency(creditBalance.outstanding_credit_balance, "—", currency) : "—"}
                </p>
                {creditBalance && <p className="text-xs text-slate-400">{creditBalance.credit_note_count} credit note(s) total</p>}
              </div>
              {!(cn.exchange_rate == null || Number(cn.exchange_rate) === 1) && (
                <div>
                  <p className={labelClass}>Exchange Rate</p>
                  <p className="text-sm text-slate-900 mt-0.5 font-mono">{Number(cn.exchange_rate).toFixed(6)}</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── APPLICATIONS ── */}
        <div className={cardClass}>
          <h3 className="text-lg font-semibold text-slate-900 mb-4">Invoice Applications</h3>
          {applications.length === 0 ? (
            <p className="text-sm text-slate-500">No applications yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 text-xs font-medium text-slate-500 uppercase tracking-wider">
                  <th className="text-left py-2">Invoice</th>
                  <th className="text-right py-2">Amount</th>
                  <th className="text-right py-2">Date</th>
                </tr>
              </thead>
              <tbody>
                {applications.map((app) => (
                  <tr key={app.id} className="border-b border-slate-50 last:border-0">
                    <td className="py-2">
                      <button onClick={() => navigate(`/billing/invoices/${app.invoice_id}`)} className="text-brand-600 hover:underline">
                        #{app.invoice_id}
                      </button>
                    </td>
                    <td className="py-2 text-right font-medium">{formatDisplayCurrency(app.amount, "—", currency)}</td>
                    <td className="py-2 text-right text-slate-500">{formatDisplayDate(app.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          )}
        </div>

        {(cn.voided_at || cn.approved_at) && (
          <div className={cardClass}>
            <h4 className="text-sm font-semibold text-slate-900 mb-3">Audit History</h4>
            <div className="space-y-2 text-sm">
              {cn.approved_at && (
                <div className="flex justify-between"><span className="text-slate-500">Approved</span><span className="font-medium">{formatDisplayDate(cn.approved_at)}</span></div>
              )}
              {cn.voided_at && (
                <>
                  <div className="flex justify-between"><span className="text-slate-500">Voided</span><span className="font-medium text-red-600">{formatDisplayDate(cn.voided_at)}</span></div>
                  {cn.voided_reason && <p className="text-xs text-slate-400">Reason: {cn.voided_reason}</p>}
                </>
              )}
            </div>
          </div>
        )}

        {/* -- ACTIVITY TIMELINE -- */}
        <div className={cardClass}>
          <h3 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
            <RefreshCw className="h-4 w-4 text-brand-500" /> Activity Timeline
          </h3>
          <ActivityTimeline entries={timelineEntries} emptyMessage="No activity recorded for this credit note yet." />
        </div>

        {/* -- COMMUNICATIONS -- */}
        <div className={cardClass}>
          <h3 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
            <Mail className="h-4 w-4 text-brand-500" /> Communication History
          </h3>
          <CommunicationHistory entries={communicationEntries} emptyMessage="No communications sent for this credit note yet." />
        </div>
      </div>

      {sendResult && !sendResult.error && (
        <div className="fixed bottom-6 right-6 z-50 max-w-sm bg-white rounded-2xl shadow-2xl border border-emerald-200 p-5">
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
              <CheckCircle className="h-5 w-5 text-emerald-600" />
            </div>
            <div className="flex-1">
              <p className="text-sm font-semibold text-slate-900">Credit Note Sent</p>
              <p className="text-xs text-slate-500 mt-1">{sendResult.message || `Emailed to ${sendResult.email_sent_to || getLabel("singularLower")}`}</p>
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

      <Modal
        open={showApplyModal}
        onClose={() => setShowApplyModal(false)}
        title="Apply to Invoice"
        icon={Wallet}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowApplyModal(false)}>Cancel</Button>
            <Button variant="primary" icon={CheckCircle} loading={actionLoading === "apply"} disabled={!applyForm.invoice_id || !applyForm.amount} onClick={handleApply}>Apply</Button>
          </>
        }
      >
        {formError && (
          <div className="flex items-center gap-2 p-3 mb-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
            <AlertCircle size={16} />{formError}
          </div>
        )}
        <p className="text-sm text-slate-600 mb-4">Remaining amount: <strong>{formatDisplayCurrency(cn.remaining_amount, "—", currency)}</strong></p>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Invoice ID *</label>
            <input type="number" value={applyForm.invoice_id} onChange={(e) => setApplyForm((p) => ({ ...p, invoice_id: e.target.value }))} className={inputClass} />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Amount *</label>
            <input type="number" min="0" max={cn.remaining_amount || undefined} step="0.01" value={applyForm.amount} onChange={(e) => setApplyForm((p) => ({ ...p, amount: e.target.value }))} className={inputClass} />
          </div>
        </div>
      </Modal>

      <Modal
        open={showVoidModal}
        onClose={() => setShowVoidModal(false)}
        title="Void Credit Note"
        icon={Ban}
        footer={
          <>
            <Button variant="secondary" onClick={() => setShowVoidModal(false)}>Go Back</Button>
            <Button
              variant="danger"
              icon={Ban}
              loading={actionLoading === "void"}
              onClick={async () => { setShowVoidModal(false); await handleAction("void", () => creditNoteApi.void(cn.id, voidReason || undefined)); }}
            >
              Void Credit Note
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600 mb-4">
          Are you sure you want to void <strong>{cn.credit_note_number || `#${id}`}</strong>? This action is <span className="font-semibold text-red-600">irreversible</span>.
        </p>
        <textarea value={voidReason} onChange={(e) => setVoidReason(e.target.value)} rows={2} placeholder="Reason (optional)" className={inputClass} />
      </Modal>
    </>
  );
}
