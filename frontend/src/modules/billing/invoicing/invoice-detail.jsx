import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { ArrowLeft, FileText, RefreshCw, AlertCircle, Loader2, Send, CheckCircle, Ban, Repeat, Printer, Copy, CreditCard, Undo2, Mail, X, Receipt, Trash2, RotateCcw, Bell, ShieldAlert, Edit3 } from "lucide-react";
import { PageHeader, Button, Modal, StickyFooter, ActivityTimeline, CommunicationHistory } from "../../../components/billing-ui";
import { invoiceApi, auditApi, paymentApi } from "../../../service/billingService";
import { formatDisplayCurrency, formatDisplayDate } from "../../../utils/billing-helpers";
import { useTerminology } from "../utils/TerminologyContext";

function StatusBadge({ status }) {
  const styles = {
    draft: "bg-slate-100 text-slate-600",
    pending: "bg-blue-100 text-blue-700",
    sent: "bg-blue-100 text-blue-700",
    paid: "bg-emerald-100 text-emerald-700",
    overdue: "bg-red-100 text-red-700",
    partially_paid: "bg-amber-100 text-amber-700",
    cancelled: "bg-slate-100 text-slate-500",
    void: "bg-slate-100 text-slate-500",
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium ${styles[status] || "bg-slate-100 text-slate-600"}`}>
      {status ? status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, " ") : "Unknown"}
    </span>
  );
}

const titleize = (value, fallback = "Activity") => {
  if (!value) return fallback;
  return String(value).replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
};

const firstValue = (...values) => values.find((value) => value !== undefined && value !== null && value !== "");

const normalizeCommunicationStatus = (comm) => {
  const eventType = String(comm.event_type || comm.type || "").toLowerCase();
  return String(firstValue(comm.status, comm.delivery_status, comm.email_status, comm.metadata?.status, eventType.includes("failed") ? "failed" : eventType.includes("delivered") ? "delivered" : eventType.includes("sent") ? "sent" : "recorded")).toLowerCase();
};

export default function InvoiceDetailPage() {
  const { singular, plural, getLabel } = useTerminology();
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [flashMessage, setFlashMessage] = useState(location.state?.flashMessage || null);
  const [invoice, setInvoice] = useState(null);
  const [items, setItems] = useState([]);
  const [statusHistory, setStatusHistory] = useState([]);
  const [emailHistory, setEmailHistory] = useState([]);
  const [timeline, setTimeline] = useState([]);
  const [communications, setCommunications] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);
  const [showSendModal, setShowSendModal] = useState(false);
  const [showMarkPaidModal, setShowMarkPaidModal] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [showDuplicateModal, setShowDuplicateModal] = useState(false);

  const fetchInvoice = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const [invData, itemsData, historyData] = await Promise.all([
        invoiceApi.get(id),
        invoiceApi.listItems(id).catch(() => { /* error logged by api layer */ return []; }),
        invoiceApi.listStatusHistory(id).catch(() => { /* error logged by api layer */ return []; }),
      ]);
      setInvoice(invData);
      setItems(Array.isArray(itemsData) ? itemsData : itemsData?.items || []);
      setStatusHistory(Array.isArray(historyData) ? historyData : historyData?.history || []);
      // Delivery-status honesty (Task 7): the invoice's own status/sent_at only
      // say "we attempted a send" — whether the email actually delivered lives
      // in the audit log's new_values.email_delivered. Surface it here so that
      // information isn't write-only after the initial send-time toast.
      auditApi.list({ entity_type: "Invoice", entity_id: Number(id), per_page: 20 })
        .then((d) => {
          const logs = Array.isArray(d) ? d : d?.items || [];
          setEmailHistory(logs.filter((log) => log.new_values && "email_delivered" in log.new_values));
        })
        .catch((err) => console.error("[InvoiceDetail] Failed to load email history:", err));
      invoiceApi.getTimeline(Number(id))
        .then((d) => setTimeline(d?.entries || []))
        .catch((err) => console.error("[InvoiceDetail] Failed to load timeline:", err));
      invoiceApi.listCommunications(Number(id))
        .then((d) => setCommunications(Array.isArray(d) ? d : []))
        .catch((err) => console.error("[InvoiceDetail] Failed to load communications:", err));
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to load invoice");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchInvoice(); }, [fetchInvoice]);

  // Consume the one-time flash message passed from the create wizard, then strip it
  // from history state so it doesn't reappear on refresh or back-navigation.
  useEffect(() => {
    if (location.state?.flashMessage) {
      navigate(location.pathname, { replace: true, state: {} });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleAction = async (action, actionFn) => {
    if (actionLoading) return;
    setActionLoading(action);
    try {
      await actionFn();
      await fetchInvoice({ silent: true });
    } catch (err) {
      setError(err?.detail || err?.message || `Failed to ${action} invoice`);
    } finally {
      setActionLoading(null);
    }
  };

  // There is no dedicated "mark paid" endpoint — a payment record and its
  // allocation are the actual source of truth for an invoice's paid status,
  // so this records a full-balance payment and allocates it in one step.
  const handleMarkPaid = async (amount, currencyCode) => {
    const payment = await paymentApi.create({
      customer_id: Number(invoice.customer_id),
      payment_number: `PAY-${Date.now().toString(36).toUpperCase()}`,
      payment_type: "invoice_payment",
      amount,
      currency: currencyCode,
      payment_date: new Date().toISOString().split("T")[0],
      notes: `Recorded via Mark as Paid on invoice ${invoice.invoice_number || `#${id}`}`,
    });
    await paymentApi.allocate(payment.id, { invoice_id: Number(id), amount });
  };

  const handleDuplicate = async () => {
    if (!invoice?.customer_id) return;
    setActionLoading("duplicate");
    try {
      const today = new Date().toISOString().slice(0, 10);
      const dueDate = invoice.due_date && invoice.issue_date
        ? new Date(Date.now() + Math.max(0, new Date(invoice.due_date) - new Date(invoice.issue_date))).toISOString().slice(0, 10)
        : today;
      const created = await invoiceApi.create({
        customer_id: Number(invoice.customer_id),
        issue_date: today,
        due_date: dueDate,
        currency: invoice.currency || "USD",
        notes: invoice.notes || undefined,
        payment_terms: invoice.payment_terms || "net_30",
        po_number: invoice.po_number || undefined,
        discount_percentage: Number(invoice.discount_percentage || 0),
        shipping_amount: Number(invoice.shipping_amount || 0),
        round_off: Number(invoice.round_off || 0),
      });
      const newId = created.id || created.invoice_id;
      if (items.length > 0) {
        await invoiceApi.bulkSetItems(newId, items.map((item, idx) => ({
          line_number: idx + 1,
          product_id: item.product_id || undefined,
          description: item.description || item.name || "Item",
          quantity: Number(item.quantity || 1),
          unit_price: Number(item.unit_price || 0),
          discount_percentage: Number(item.discount_percentage || 0),
          tax_percentage: Number(item.tax_percentage || 0),
          total: Number(item.total_price || item.total || 0),
          is_tax_inclusive: item.is_tax_inclusive === true,
          pricing_plan_id: item.pricing_plan_id || undefined,
          price_source: item.price_source || undefined,
          resolved_price_type: item.resolved_price_type || undefined,
        })));
      }
      navigate(`/billing/invoices/${newId}`);
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to duplicate invoice");
    } finally {
      setActionLoading(null);
    }
  };

  const handleDeleteDraft = async () => {
    if ((invoice?.status || "").toLowerCase() !== "draft") return;
    const ok = window.confirm(`Delete draft invoice ${invoice.invoice_number || `#${id}`}? This cannot be undone.`);
    if (!ok) return;
    setActionLoading("delete");
    try {
      await invoiceApi.bulkDelete([Number(id)]);
      navigate("/billing/invoices");
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to delete draft invoice");
      setActionLoading(null);
    }
  };

  const handleSendEmail = async () => {
    if (actionLoading) return;
    setActionLoading("send-email");
    try {
      const result = await invoiceApi.sendEmail(id);
      if (result?.email_delivered === false) {
        setFlashMessage({ type: "warning", text: result.message || "Invoice marked as sent, but the email could not be delivered." });
      } else {
        setFlashMessage({ type: "success", text: result?.message || `Invoice emailed to ${result?.email_sent_to || getLabel("singularLower")}.` });
      }
      setShowSendModal(false);
      await fetchInvoice({ silent: true });
    } catch (err) {
      setShowSendModal(false);
      setFlashMessage({ type: "warning", text: err?.detail || err?.message || "Failed to send invoice email" });
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6 px-4 py-6 sm:px-6">
        <PageHeader
          crumbs={[{ label: "Billing", href: "/billing" }, { label: "Invoices", href: "/billing/invoices" }, { label: "Invoice Detail" }]}
          title="Invoice Detail"
          description="Loading invoice details…"
          icon={Receipt}
        />
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-brand-500" />
        </div>
      </div>
    );
  }

  if (error && !invoice) {
    return (
      <div className="space-y-6 px-4 py-6 sm:px-6">
        <PageHeader
          crumbs={[{ label: "Billing", href: "/billing" }, { label: "Invoices", href: "/billing/invoices" }, { label: "Invoice Detail" }]}
          title="Invoice Detail"
          description="Error loading invoice"
          icon={Receipt}
          actions={<Button variant="secondary" icon={ArrowLeft} onClick={() => navigate("/billing/invoices")}>Back</Button>}
        />
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <AlertCircle className="h-10 w-10 text-red-400 mb-3" />
          <p className="text-sm text-red-600 mb-3">{error}</p>
          <Button variant="primary" icon={RefreshCw} onClick={fetchInvoice}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (!invoice) {
    return (
      <div className="space-y-6 px-4 py-6 sm:px-6">
        <PageHeader
          crumbs={[{ label: "Billing", href: "/billing" }, { label: "Invoices", href: "/billing/invoices" }, { label: "Invoice Detail" }]}
          title="Invoice Detail"
          description="Invoice not found"
          icon={Receipt}
          actions={<Button variant="secondary" icon={ArrowLeft} onClick={() => navigate("/billing/invoices")}>Back</Button>}
        />
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <FileText className="h-10 w-10 text-slate-300 mb-3" />
          <p className="text-sm font-medium text-slate-500">Invoice not found</p>
        </div>
      </div>
    );
  }

  const status = (invoice.status || "").toLowerCase();
  const isDraft = status === "draft";
  const isSent = status === "sent";
  const isPaid = status === "paid";
  const isOverdue = status === "overdue";
  const isPartiallyPaid = status === "partially_paid";
  const isClosed = ["paid", "cancelled", "written_off", "refunded"].includes(status);
  const invoiceTotal = Number(invoice.total_amount ?? invoice.amount ?? 0);
  const balanceDue = Number(invoice.balance_due ?? invoice.amount_due ?? 0);
  const paidAmount = Math.max(0, invoiceTotal - balanceDue);
  const currency = invoice.currency || "USD";
  const hasBalanceDue = balanceDue > 0.005;
  const canFinalize = isDraft;
  const canRecordPayment = hasBalanceDue && (isSent || isOverdue || isPartiallyPaid);
  const canSendEmail = isDraft || isSent || isOverdue || isPartiallyPaid;
  const canCancel = !isClosed;
  const canRecalculate = !isClosed;
  const actionable = canFinalize || canRecordPayment || canSendEmail || canCancel || canRecalculate;

  const timelineEntries = (() => {
    const entries = [];
    timeline.forEach((entry, i) => {
      const eventType = String(firstValue(entry.event_type, entry.action, entry.type, "activity")).toLowerCase();
      const toStatus = firstValue(entry.metadata?.to_status, entry.to_status, entry.status);
      entries.push({
        id: entry.id || `timeline-${i}`,
        eventType,
        title: firstValue(entry.title, titleize(eventType)),
        description: firstValue(entry.description, entry.message, entry.metadata?.message),
        timestamp: firstValue(entry.timestamp, entry.created_at, entry.updated_at),
        actor: firstValue(entry.actor_name, entry.user_name, entry.created_by_name, entry.created_by, entry.metadata?.actor, entry.metadata?.user, "System"),
        status: toStatus,
        recipient: firstValue(entry.metadata?.recipient, entry.recipient),
        amount: firstValue(entry.metadata?.amount, entry.amount),
      });
    });
    statusHistory.forEach((entry, i) => {
      entries.push({
        id: entry.id || `status-${i}`,
        eventType: "status_change",
        title: "Status Changed",
        description: `${titleize(entry.from_status || entry.old_status || "previous")} -> ${titleize(entry.to_status || entry.new_status || entry.status || "current")}`,
        timestamp: firstValue(entry.created_at, entry.timestamp, entry.changed_at),
        actor: firstValue(entry.changed_by_name, entry.created_by_name, entry.user_name, entry.changed_by, "System"),
        status: firstValue(entry.to_status, entry.new_status, entry.status),
      });
    });
    emailHistory.forEach((entry, i) => {
      const delivered = entry.new_values?.email_delivered;
      entries.push({
        id: entry.id || `email-${i}`,
        eventType: delivered === false ? "email_failed" : "email_sent",
        title: delivered === false ? "Email Delivery Failed" : "Email Delivery Recorded",
        description: firstValue(entry.new_values?.message, entry.description, entry.action),
        timestamp: firstValue(entry.created_at, entry.timestamp),
        actor: firstValue(entry.user_name, entry.created_by_name, "System"),
        status: delivered === false ? "failed" : "sent",
        recipient: firstValue(entry.new_values?.email_sent_to, entry.new_values?.recipient),
      });
    });
    if (entries.length === 0 && invoice.created_at) {
      entries.push({
        id: "invoice-created",
        eventType: "created",
        title: "Invoice Created",
        description: `Initial status: ${titleize(status || "draft")}`,
        timestamp: invoice.created_at,
        actor: firstValue(invoice.created_by_name, invoice.created_by, "System"),
        status,
      });
    }
    return entries.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));
  })();

  const communicationEntries = (() => {
    return communications.map((comm, i) => {
      const metadata = comm.metadata || {};
      return {
        id: comm.id || `comm-${i}`,
        type: titleize(firstValue(comm.type, comm.channel, comm.event_type, "communication")),
        recipient: firstValue(comm.recipient, comm.email_to, comm.to, metadata.recipient, invoice.customer_email),
        subject: firstValue(comm.subject, metadata.subject, invoice.invoice_number ? `Invoice ${invoice.invoice_number}` : "Invoice communication"),
        status: normalizeCommunicationStatus(comm),
        createdAt: firstValue(comm.created_at, comm.sent_at, comm.timestamp),
        sentAt: firstValue(comm.sent_at, metadata.sent_at),
        deliveredAt: firstValue(comm.delivered_at, metadata.delivered_at),
        openedAt: firstValue(comm.opened_at, metadata.opened_at),
        failedAt: firstValue(comm.failed_at, metadata.failed_at),
        reminderNumber: firstValue(comm.reminder_number, metadata.reminder_number),
        attachments: firstValue(comm.attachments, metadata.attachments, []),
        providerResponse: firstValue(comm.provider_response, comm.error_message, metadata.provider_response, metadata.error),
        preview: firstValue(comm.body_preview, comm.message, metadata.message),
      };
    });
  })();

  return (
    <>
      <div className="space-y-6 px-4 py-6 sm:px-6">
        <PageHeader
          crumbs={[
            { label: "Billing", href: "/billing" },
            { label: "Invoices", href: "/billing/invoices" },
            { label: `Invoice ${invoice.invoice_number || `#${id}`}` },
          ]}
          title={`Invoice ${invoice.invoice_number || `#${id}`}`}
          description={`${invoice.customer_name || `${singular} #${invoice.customer_id || "—"}`} · ${currency} · ${invoice.payment_terms?.replace(/_/g, " ") || "standard terms"} · issued ${formatDisplayDate(invoice.issue_date || invoice.created_at)}`}
          icon={Receipt}
          meta={<StatusBadge status={invoice.status} />}
          actions={
            <Button variant="secondary" icon={ArrowLeft} onClick={() => navigate("/billing/invoices")}>
              Back
            </Button>
          }
        />

        {flashMessage && (
          <div className={`flex items-start gap-2 rounded-xl border px-4 py-3 text-sm ${
            flashMessage.type === "warning"
              ? "border-amber-200 bg-amber-50 text-amber-800"
              : "border-emerald-200 bg-emerald-50 text-emerald-800"
          }`}>
            {flashMessage.type === "warning" ? <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" /> : <CheckCircle className="h-4 w-4 mt-0.5 shrink-0" />}
            <span className="flex-1">{flashMessage.text}</span>
            <button onClick={() => setFlashMessage(null)} className="shrink-0 opacity-70 hover:opacity-100">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* ── HEADER: Summary + Quick Actions ── */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_320px]">
          <div className="rounded-3xl border border-slate-200 bg-white p-6">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-slate-500">Invoice Summary</p>
                <h2 className="mt-1 text-xl font-bold text-slate-900">
                  {invoice.customer_id ? (
                    <button onClick={() => navigate(`/billing/customers/${invoice.customer_id}`)} className="text-brand-600 hover:text-brand-700 hover:underline">
                      {invoice.customer_name || `${singular} #${invoice.customer_id}`}
                    </button>
                  ) : (
                    invoice.customer_name || `${singular} #${invoice.customer_id || "—"}`
                  )}
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  {invoice.invoice_number || `#${id}`} &middot; {currency} &middot; {invoice.payment_terms?.replace(/_/g, " ") || "standard terms"} &middot; issued {formatDisplayDate(invoice.issue_date || invoice.created_at)}
                </p>
                {invoice.po_number && <p className="mt-0.5 text-xs text-slate-400">PO: {invoice.po_number}</p>}
              </div>
              <StatusBadge status={invoice.status} />
            </div>
            <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-500">Subtotal</p>
                <p className="mt-1 text-lg font-bold text-slate-900 whitespace-nowrap">{formatDisplayCurrency(invoice.subtotal || 0, "\u2014", currency)}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-500">Tax</p>
                <p className="mt-1 text-lg font-bold text-slate-900 whitespace-nowrap">{formatDisplayCurrency(invoice.tax_amount || 0, "\u2014", currency)}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-500">Total</p>
                <p className="mt-1 text-lg font-bold text-brand-600 whitespace-nowrap">{formatDisplayCurrency(invoice.total_amount ?? invoice.amount, "\u2014", currency)}</p>
              </div>
            </div>
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-lg bg-emerald-50 p-4">
                <p className="text-xs font-medium text-emerald-600">Paid</p>
                <p className="mt-1 text-lg font-bold text-emerald-700 whitespace-nowrap">{formatDisplayCurrency(paidAmount, "\u2014", currency)}</p>
                {invoice.paid_at && <p className="text-xs text-emerald-500 mt-0.5">{formatDisplayDate(invoice.paid_at)}</p>}
              </div>
              <div className="rounded-lg bg-amber-50 p-4">
                <p className="text-xs font-medium text-amber-600">Balance Due</p>
                <p className="mt-1 text-lg font-bold text-amber-700 whitespace-nowrap">{formatDisplayCurrency(balanceDue, "\u2014", currency)}</p>
              </div>
              <div className="rounded-lg bg-slate-50 p-4">
                <p className="text-xs font-medium text-slate-500">Due Date</p>
                <p className="mt-1 text-lg font-bold text-slate-900">{formatDisplayDate(invoice.due_date)}</p>
                {invoice.sent_at && <p className="text-xs text-slate-400 mt-0.5">Sent: {formatDisplayDate(invoice.sent_at)}</p>}
              </div>
            </div>
          </div>
          <div className="rounded-3xl border border-slate-200 bg-white p-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Quick Actions</p>
            <div className="mt-4 grid grid-cols-2 gap-2">
              {isDraft && (
                <button disabled title="Edit invoice workflow is not registered yet" className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-400 disabled:cursor-not-allowed disabled:opacity-60" aria-label="Edit invoice unavailable">
                  <Edit3 className="h-3.5 w-3.5" /> Edit
                </button>
              )}
              <button onClick={() => window.print()} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50" aria-label="Preview or download invoice as PDF">
                <Printer className="h-3.5 w-3.5" /> {isDraft ? "Preview" : "Download"}
              </button>
              {isDraft && (
                <button onClick={() => setShowSendModal(true)} disabled={actionLoading === "send-email"} className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-linear-to-r from-brand to-brand-hover px-3 py-2 text-xs font-medium text-white hover:shadow-lg disabled:opacity-50">
                  {actionLoading === "send-email" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />} Send
                </button>
              )}
              {isDraft && (
                <button onClick={handleDeleteDraft} disabled={actionLoading === "delete"} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50">
                  {actionLoading === "delete" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Delete
                </button>
              )}
              {canRecordPayment && (
                <button onClick={() => navigate(`/billing/payments?create=1&invoice_id=${id}`)} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50" aria-label="Record payment for this invoice">
                  <CreditCard className="h-3.5 w-3.5" /> Record Payment
                </button>
              )}
              {invoice.paid_amount > 0 && (
                <button onClick={() => navigate(`/billing/payments?invoice_id=${id}`)} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50" aria-label="View payments for this invoice">
                  <CreditCard className="h-3.5 w-3.5" /> View Payments
                </button>
              )}
              {canSendEmail && !isDraft && (
                <button onClick={() => setShowSendModal(true)} disabled={actionLoading === "send-email"} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                  {actionLoading === "send-email" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Bell className="h-3.5 w-3.5" />} {isOverdue ? "Reminder" : "Send Email"}
                </button>
              )}
              {!isDraft && (
                <button onClick={() => setShowDuplicateModal(true)} disabled={actionLoading === "duplicate"} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50" aria-label="Duplicate invoice">
                  {actionLoading === "duplicate" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Copy className="h-3.5 w-3.5" />} Duplicate
                </button>
              )}
              {(isSent || isPaid || isOverdue || isPartiallyPaid) && (
                <button onClick={() => navigate(`/billing/credit-notes?invoice_id=${id}`)} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50" aria-label="Create credit note for this invoice">
                  <Undo2 className="h-3.5 w-3.5" /> Credit Note
                </button>
              )}
              {isPaid && (
                <button onClick={() => navigate(`/billing/refunds?create=1&invoice_id=${id}`)} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50" aria-label="Create refund for this invoice">
                  <RotateCcw className="h-3.5 w-3.5" /> Refund
                </button>
              )}
              {isOverdue && (
                <button onClick={() => navigate(`/billing/dunning?invoice_id=${id}`)} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-xs font-medium text-red-700 hover:bg-red-50" aria-label="Escalate overdue invoice">
                  <ShieldAlert className="h-3.5 w-3.5" /> Escalate
                </button>
              )}
              {isOverdue && (
                <button onClick={() => navigate(`/billing/payments?create=1&invoice_id=${id}&partial=1`)} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-amber-200 px-3 py-2 text-xs font-medium text-amber-700 hover:bg-amber-50" aria-label="Record partial payment">
                  <CreditCard className="h-3.5 w-3.5" /> Partial Payment
                </button>
              )}
              {canRecordPayment && (
                <button onClick={() => setShowMarkPaidModal(true)} disabled={actionLoading === "mark-paid"} className="col-span-2 inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
                  {actionLoading === "mark-paid" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle className="h-3.5 w-3.5" />} Mark as Paid
                </button>
              )}
              {!isDraft && (
                <a
                  href={`/invoice/${id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="col-span-2 inline-flex items-center justify-center gap-1.5 rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-xs font-semibold text-brand-700 hover:bg-brand-100 transition-colors"
                  aria-label="View customer-facing invoice and payment options"
                >
                  <CreditCard className="h-3.5 w-3.5" /> View Invoice &amp; Payment Options
                </a>
              )}
            </div>
          </div>
        </div>

        {/* ── CUSTOMER INFORMATION ── */}
        <div className="rounded-3xl border border-slate-200 bg-white p-6">
          <h3 className="text-lg font-semibold text-slate-900 mb-4">{singular} Information</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-3">
              <div>
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Name</p>
                {invoice.customer_id ? (
                  <button onClick={() => navigate(`/billing/customers/${invoice.customer_id}`)} className="text-sm font-semibold text-brand-600 hover:text-brand-700 hover:underline text-left mt-0.5 block">
                    {invoice.customer_name || invoice.customer_display_name || invoice.customer_company_name || "—"}
                  </button>
                ) : (
                  <p className="text-sm font-semibold text-slate-900 mt-0.5">{invoice.customer_name || invoice.customer_display_name || invoice.customer_company_name || "—"}</p>
                )}
                {(invoice.customer_first_name || invoice.customer_last_name) && (
                  <p className="text-xs text-slate-500">{invoice.customer_first_name || ""} {invoice.customer_last_name || ""}</p>
                )}
              </div>
              <div>
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Email</p>
                <p className="text-sm text-slate-900 mt-0.5">{invoice.customer_email || "—"}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Phone</p>
                <p className="text-sm text-slate-900 mt-0.5">{invoice.customer_phone || invoice.customer_mobile || "—"}</p>
              </div>
              {(invoice.customer_gst_number || invoice.customer_vat_number || invoice.customer_pan || invoice.customer_tax_id) && (
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Tax IDs</p>
                  {invoice.customer_gst_number && <p className="text-sm text-slate-900 mt-0.5">GST: {invoice.customer_gst_number}</p>}
                  {invoice.customer_vat_number && <p className="text-sm text-slate-900">VAT: {invoice.customer_vat_number}</p>}
                  {invoice.customer_pan && <p className="text-sm text-slate-900">PAN: {invoice.customer_pan}</p>}
                  {invoice.customer_tax_id && <p className="text-sm text-slate-900">{invoice.customer_tax_id_type || "Tax"}: {invoice.customer_tax_id}</p>}
                </div>
              )}
            </div>
            <div className="space-y-3">
              <div>
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Billing Address</p>
                <p className="text-sm text-slate-900 mt-0.5 whitespace-pre-line">{invoice.customer_billing_address || "—"}</p>
              </div>
              <div>
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Shipping Address</p>
                <p className="text-sm text-slate-900 mt-0.5 whitespace-pre-line">{invoice.customer_shipping_address || "—"}</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                {invoice.customer_credit_days != null && (
                  <div>
                    <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Credit Days</p>
                    <p className="text-sm text-slate-900 mt-0.5">{invoice.customer_credit_days} days</p>
                  </div>
                )}
                {invoice.customer_payment_terms && (
                  <div>
                    <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Payment Terms</p>
                    <p className="text-sm text-slate-900 mt-0.5">{invoice.customer_payment_terms.replace(/_/g, " ")}</p>
                  </div>
                )}
                {invoice.customer_currency && (
                  <div>
                    <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">{singular} Currency</p>
                    <p className="text-sm text-slate-900 mt-0.5">{invoice.customer_currency}</p>
                  </div>
                )}
                {invoice.customer_credit_limit != null && (
                  <div>
                    <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Credit Limit</p>
                    <p className="text-sm text-slate-900 mt-0.5">{formatDisplayCurrency(invoice.customer_credit_limit, "\u2014", currency)}</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── FINANCIAL SUMMARY ── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-white rounded-3xl border border-slate-200 p-6">
            <h4 className="text-sm font-semibold text-slate-900 mb-3">Tax Summary</h4>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-500">Tax Amount</span>
                <span className="font-medium">{formatDisplayCurrency(invoice.tax_amount || 0, "\u2014", currency)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Tax %</span>
                <span className="font-medium">—</span>
              </div>
              <div className="border-t border-slate-100 pt-2 flex justify-between">
                <span className="font-semibold text-slate-700">Total Tax</span>
                <span className="font-bold text-slate-900">{formatDisplayCurrency(invoice.tax_amount || 0, "\u2014", currency)}</span>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-3xl border border-slate-200 p-6">
            <h4 className="text-sm font-semibold text-slate-900 mb-3">Discount Summary</h4>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-slate-500">Discount %</span>
                <span className="font-medium">{invoice.discount_percentage || 0}%</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Discount Amount</span>
                <span className="font-medium text-red-600">-{formatDisplayCurrency(invoice.discount_amount || 0, "\u2014", currency)}</span>
              </div>
              <div className="border-t border-slate-100 pt-2 flex justify-between">
                <span className="font-semibold text-slate-700">Total Discount</span>
                <span className="font-bold text-red-600">-{formatDisplayCurrency(invoice.discount_amount || 0, "\u2014", currency)}</span>
              </div>
            </div>
          </div>
          <div className="bg-white rounded-3xl border border-slate-200 p-6">
            <h4 className="text-sm font-semibold text-slate-900 mb-3">Payment Summary</h4>
            <div className="space-y-2 text-sm">
              {Number(invoice.shipping_amount || 0) !== 0 && (
                <div className="flex justify-between">
                  <span className="text-slate-500">Shipping</span>
                  <span className="font-medium">{formatDisplayCurrency(invoice.shipping_amount, "\u2014", currency)}</span>
                </div>
              )}
              {Number(invoice.round_off || 0) !== 0 && (
                <div className="flex justify-between">
                  <span className="text-slate-500">Round Off</span>
                  <span className="font-medium">{formatDisplayCurrency(invoice.round_off, "\u2014", currency)}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-slate-500">Invoice Total</span>
                <span className="font-medium">{formatDisplayCurrency(invoice.total_amount ?? invoice.amount, "\u2014", currency)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Paid Amount</span>
                <span className="font-medium text-emerald-600">{formatDisplayCurrency(paidAmount, "\u2014", currency)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Balance Due</span>
                <span className="font-bold text-amber-700">{formatDisplayCurrency(balanceDue, "\u2014", currency)}</span>
              </div>
              {invoice.paid_at && (
                <div className="border-t border-slate-100 pt-2">
                  <p className="text-xs text-slate-400">Paid on {formatDisplayDate(invoice.paid_at)}</p>
                </div>
              )}
              {invoice.cancelled_at && (
                <div className="border-t border-slate-100 pt-2">
                  <p className="text-xs text-red-400">Cancelled on {formatDisplayDate(invoice.cancelled_at)}</p>
                  {invoice.cancellation_reason && <p className="text-xs text-slate-400">Reason: {invoice.cancellation_reason}</p>}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── CURRENCY & EXCHANGE RATE ── */}
        {(invoice.exchange_rate && invoice.exchange_rate != 1) || invoice.currency ? (
          <div className="bg-white rounded-3xl border border-slate-200 p-6">
            <h4 className="text-sm font-semibold text-slate-900 mb-3">Currency Information</h4>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Invoice Currency</p>
                <p className="text-slate-900 mt-0.5 font-medium">{currency}</p>
              </div>
              {invoice.customer_currency && invoice.customer_currency !== currency && (
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">{singular} Currency</p>
                  <p className="text-slate-900 mt-0.5">{invoice.customer_currency}</p>
                </div>
              )}
              {!(invoice.exchange_rate == null || invoice.exchange_rate == 1) && (
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Exchange Rate</p>
                  <p className="text-slate-900 mt-0.5 font-mono">{Number(invoice.exchange_rate).toFixed(6)}</p>
                </div>
              )}
              {invoice.subtotal && invoice.total_amount && (
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Subtotal</p>
                  <p className="text-slate-900 mt-0.5">{formatDisplayCurrency(invoice.subtotal, "\u2014", currency)}</p>
                </div>
              )}
            </div>
          </div>
        ) : null}

        {/* ── LINE ITEMS ── */}
        {items.length > 0 && (
          <div className="bg-white rounded-3xl border border-slate-200 p-6">
            <h3 className="text-lg font-semibold text-slate-900 mb-4">Line Items</h3>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200">
                <thead>
                  <tr className="text-xs font-medium text-slate-500 uppercase tracking-wider">
                    <th className="text-left py-3 px-4">#</th>
                    <th className="text-left py-3 px-4">Description</th>
                    <th className="text-right py-3 px-4">Qty</th>
                    <th className="text-right py-3 px-4">Unit Price</th>
                    <th className="text-right py-3 px-4">Disc %</th>
                    <th className="text-right py-3 px-4">Tax %</th>
                    <th className="text-right py-3 px-4">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {items.map((item, i) => (
                    <tr key={item.id || i} className="text-sm text-slate-900">
                      <td className="py-3 px-4 text-slate-400">{i + 1}</td>
                      <td className="py-3 px-4">
                        <p className="font-medium">{item.description || item.name || "Item"}</p>
                        {item.product_id && <p className="text-xs text-slate-400">Product #{item.product_id}</p>}
                      </td>
                      <td className="py-3 px-4 text-right">{Number(item.quantity).toFixed(2)}</td>
                      <td className="py-3 px-4 text-right">{formatDisplayCurrency(item.unit_price, "\u2014", item.invoice_currency || currency)}</td>
                      <td className="py-3 px-4 text-right">{item.discount_percentage ? `${Number(item.discount_percentage).toFixed(1)}%` : "—"}</td>
                      <td className="py-3 px-4 text-right">{item.tax_percentage ? `${Number(item.tax_percentage).toFixed(1)}%` : "—"}</td>
                      <td className="py-3 px-4 text-right font-medium">{formatDisplayCurrency(item.total ?? item.total_price ?? item.quantity * item.unit_price, "\u2014", item.invoice_currency || currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {items.some(i => i.original_currency && i.invoice_currency && i.original_currency !== i.invoice_currency) && (
              <div className="mt-4 p-3 bg-amber-50 rounded-xl border border-amber-100">
                <p className="text-xs font-semibold text-amber-700 uppercase tracking-wider mb-2">Currency Conversion Details</p>
                <div className="space-y-1.5 text-xs text-amber-800">
                  {items.filter(i => i.original_currency && i.invoice_currency && i.original_currency !== i.invoice_currency).map((item, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <span className="font-medium">{item.description || `Item ${idx + 1}`}:</span>
                      <span>{item.original_currency} {formatDisplayCurrency(item.original_amount || item.unit_price, "\u2014", item.original_currency)}</span>
                      <span>× {Number(item.exchange_rate || 1).toFixed(6)}</span>
                      <span>= {item.invoice_currency} {formatDisplayCurrency(item.converted_amount || item.unit_price, "\u2014", item.invoice_currency)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── NOTES ── */}
        {invoice.notes && (
          <div className="bg-white rounded-3xl border border-slate-200 p-6">
            <h4 className="text-sm font-semibold text-slate-900 mb-3">Notes</h4>
            <p className="text-sm text-slate-700 whitespace-pre-wrap">{invoice.notes}</p>
          </div>
        )}

        {/* ── ACTIVITY TIMELINE ── */}
        <div className="bg-white rounded-3xl border border-slate-200 p-6">
          <h3 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
            <RefreshCw className="h-4 w-4 text-brand-500" /> Activity Timeline
          </h3>
          <ActivityTimeline entries={timelineEntries} emptyMessage="No activity recorded for this invoice yet." />
        </div>
        {/* -- COMMUNICATIONS -- */}
        <div className="bg-white rounded-3xl border border-slate-200 p-6">
          <h3 className="text-lg font-semibold text-slate-900 mb-4 flex items-center gap-2">
            <Mail className="h-4 w-4 text-brand-500" /> Communication History
          </h3>
          <CommunicationHistory entries={communicationEntries} emptyMessage="No communications sent for this invoice yet." />
        </div>

      </div>

      {actionable && (
        <StickyFooter>
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-slate-500">Balance due</p>
            <p className="text-lg font-bold text-slate-900">{formatDisplayCurrency(balanceDue, "\u2014", currency)}</p>
            <StatusBadge status={invoice.status} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {isDraft && (
              <Button variant="primary" icon={CheckCircle} loading={actionLoading === "finalize"} onClick={() => handleAction("finalize", () => invoiceApi.finalize(id))}>
                Finalize
              </Button>
            )}
            {isPartiallyPaid && (
              <Button className="border-transparent bg-emerald-600 text-white hover:bg-emerald-700" icon={CheckCircle} loading={actionLoading === "mark-paid"} onClick={() => setShowMarkPaidModal(true)}>
                Mark as Paid
              </Button>
            )}
            <Button variant="danger" icon={Ban} loading={actionLoading === "cancel"} onClick={() => setShowCancelModal(true)}>
              Cancel
            </Button>
            <Button variant="ghost" icon={Repeat} loading={actionLoading === "recalculate"} onClick={() => handleAction("recalculate", () => invoiceApi.recalculate(id))}>
              Recalculate
            </Button>
          </div>
        </StickyFooter>
      )}

      <Modal
        open={showSendModal}
        onClose={() => setShowSendModal(false)}
        title="Send Invoice via Email"
        icon={Mail}
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowSendModal(false)}>
              Cancel
            </Button>
            <Button variant="primary" icon={Send} loading={actionLoading === "send-email"} onClick={handleSendEmail}>
              {actionLoading === "send-email" ? "Sending..." : "Send Invoice"}
            </Button>
          </>
        }
      >
        {invoice.status === "sent" && (
          <div className="flex items-start gap-2 p-3 mb-4 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
            <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
            <span>
              This invoice was already marked sent{invoice.sent_at ? ` on ${formatDisplayDate(invoice.sent_at)}` : ""}. Sending again will email the {getLabel("singularLower")} a second time.
            </span>
          </div>
        )}
        <p className="text-sm text-slate-600 mb-4">
          This will email invoice <strong>{invoice.invoice_number || `#${id}`}</strong> to the {getLabel("singularLower")}'s registered email address.
        </p>
        <div className="bg-slate-50 rounded-xl p-4 mb-4">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-slate-500">{singular}:</span>
            <span className="font-medium text-slate-900">{invoice.customer_name || `#${invoice.customer_id}`}</span>
          </div>
          <div className="flex items-center gap-2 text-sm mt-1">
            <span className="text-slate-500">Amount:</span>
            <span className="font-medium text-slate-900">{formatDisplayCurrency(invoice.total_amount ?? invoice.amount, "\u2014", currency)}</span>
          </div>
        </div>
        {/* View Invoice & Payment Options preview */}
        <div className="rounded-xl border border-blue-100 bg-blue-50 p-4 mb-2">
          <p className="text-xs font-semibold text-blue-700 uppercase tracking-wider mb-2 flex items-center gap-1">
            <CreditCard className="h-3.5 w-3.5" /> Customer Payment Page
          </p>
          <p className="text-xs text-blue-600 mb-3">
            The email will include a <strong>"View Invoice &amp; Payment Options"</strong> button. Preview what the customer will see:
          </p>
          <a
            href={`/invoice/${id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center gap-1.5 w-full rounded-lg bg-brand px-3 py-2.5 text-sm font-semibold text-white hover:bg-brand-hover transition-colors shadow-sm"
          >
            <CreditCard className="h-4 w-4" />
            View Invoice &amp; Payment Options
          </a>
          <p className="text-xs text-blue-400 mt-2 text-center">↑ Opens in a new tab · Share this link directly if needed</p>
        </div>
      </Modal>

      <Modal
        open={showMarkPaidModal}
        onClose={() => setShowMarkPaidModal(false)}
        title="Mark Invoice as Paid"
        icon={CheckCircle}
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowMarkPaidModal(false)}>
              Cancel
            </Button>
            <Button className="border-transparent bg-emerald-600 text-white hover:bg-emerald-700" icon={CheckCircle} loading={actionLoading === "mark-paid"} onClick={async () => { setShowMarkPaidModal(false); await handleAction("mark-paid", () => handleMarkPaid(balanceDue, currency)); }}>
              Confirm Payment
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600 mb-4">
          Are you sure you want to mark invoice <strong>{invoice.invoice_number || `#${id}`}</strong> as paid? This will set the balance due to zero.
        </p>
        <div className="bg-slate-50 rounded-xl p-4 mb-4">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-slate-500">Amount:</span>
            <span className="font-medium text-slate-900">{formatDisplayCurrency(balanceDue, "\u2014", currency)}</span>
          </div>
        </div>
      </Modal>

      <Modal
        open={showCancelModal}
        onClose={() => setShowCancelModal(false)}
        title="Cancel Invoice"
        icon={Ban}
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowCancelModal(false)}>
              Go Back
            </Button>
            <Button variant="danger" icon={Ban} loading={actionLoading === "cancel"} onClick={async () => { setShowCancelModal(false); await handleAction("cancel", () => invoiceApi.cancel(id)); }}>
              Cancel Invoice
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600 mb-4">
          Are you sure you want to cancel invoice <strong>{invoice.invoice_number || `#${id}`}</strong>? This action is <span className="font-semibold text-red-600">irreversible</span> and the invoice will no longer be payable.
        </p>
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-4 text-sm text-red-700">
          <p className="font-medium">This will:</p>
          <ul className="mt-1 list-disc list-inside space-y-0.5">
            <li>Set the invoice status to Cancelled</li>
            <li>Prevent any further payments</li>
            <li>Notify the {getLabel("singularLower")} of cancellation</li>
          </ul>
        </div>
      </Modal>

      <Modal
        open={showDuplicateModal}
        onClose={() => setShowDuplicateModal(false)}
        title="Duplicate Invoice"
        icon={Copy}
        footer={
          <>
            <Button variant="ghost" onClick={() => setShowDuplicateModal(false)}>
              Cancel
            </Button>
            <Button variant="primary" icon={Copy} loading={actionLoading === "duplicate"} onClick={async () => { setShowDuplicateModal(false); await handleDuplicate(); }}>
              Duplicate Invoice
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600 mb-4">
          This will create a new draft invoice for the same {getLabel("singularLower")} with the same line items, dated today. Invoice <strong>{invoice.invoice_number || `#${id}`}</strong> itself is not affected.
        </p>
      </Modal>
    </>
  );
}
