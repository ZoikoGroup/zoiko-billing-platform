import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, CreditCard, RefreshCw, AlertCircle, Loader2, CheckCircle,
  FileText, User, Layers, Clock, FileEdit, Activity, Shield, Ban, Calendar, Receipt, Plus,
  XCircle, RotateCcw } from "lucide-react"
import HRPage from "../../../components/HRPage";
import { paymentApi, invoiceApi, customerApi, auditApi, refundApi } from "../../../service/billingService";
import { formatDisplayCurrency, formatDisplayDate, extractArray } from "../../../utils/billing-helpers";

const STATUS_STYLES = {
  cleared: "bg-emerald-100 text-emerald-700",
  pending: "bg-amber-100 text-amber-700",
  processing: "bg-sky-100 text-sky-700",
  failed: "bg-red-100 text-red-700",
  refunded: "bg-blue-100 text-blue-700",
  cancelled: "bg-slate-100 text-slate-500",
};

function StatusBadge({ status }) {
  const s = STATUS_STYLES[status] || "bg-slate-100 text-slate-600";
  const icons = { cleared: CheckCircle, pending: Clock, processing: Clock, failed: XCircle, refunded: RefreshCw, cancelled: Ban };
  const Icon = icons[status] || Clock;
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium ${s}`}>
      <Icon size={12} /> {status ? status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, " ") : "Unknown"}
    </span>
  );
}

const TABS = [
  { key: "overview", label: "Overview", icon: FileText },
  { key: "invoice", label: "Invoice", icon: Receipt },
  { key: "customer", label: "Customer", icon: User },
  { key: "allocation", label: "Allocation", icon: Layers },
  { key: "timeline", label: "Timeline", icon: Clock },
  { key: "notes", label: "Notes", icon: FileEdit },
  { key: "activity", label: "Activity", icon: Activity },
  { key: "audit", label: "Audit", icon: Shield },
];

function TabNav({ tabs, active, onChange }) {
  return (
    <nav className="flex gap-0 border-b border-slate-200 overflow-x-auto">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        return (
          <button key={tab.key} onClick={() => onChange(tab.key)}
            className={`inline-flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 whitespace-nowrap transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/30 focus-visible:ring-inset rounded-t-lg ${
              active === tab.key ? "border-brand-600 text-brand-600" : "border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300"
            }`}>
            <Icon className="h-4 w-4" /> {tab.label}
          </button>
        );
      })}
    </nav>
  );
}

function InfoRow({ label, value }) {
  return (
    <div className="flex items-center justify-between py-2 border-b border-slate-50 last:border-0">
      <span className="text-sm text-slate-500">{label}</span>
      <span className="text-sm font-medium text-slate-800">{value || "—"}</span>
    </div>
  );
}

export default function PaymentDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [payment, setPayment] = useState(null);
  const [allocations, setAllocations] = useState([]);
  const [attempts, setAttempts] = useState([]);
  const [refunds, setRefunds] = useState([]);
  const [openInvoices, setOpenInvoices] = useState([]);
  const [allocateForm, setAllocateForm] = useState({ invoice_id: "", amount: "" });
  const [allocating, setAllocating] = useState(false);
  const [invoice, setInvoice] = useState(null);
  const [customer, setCustomer] = useState(null);
  const [auditLogs, setAuditLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);
  const [activeTab, setActiveTab] = useState("overview");
  const [showRefundModal, setShowRefundModal] = useState(false);
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [refundType, setRefundType] = useState("full");
  const [confirmDealloc, setConfirmDealloc] = useState(null);

  const fetchPayment = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const [payData, allocData, attemptData] = await Promise.all([
        paymentApi.get(id),
        paymentApi.listAllocations(id).catch(() => ({ allocations: [] })),
        paymentApi.listAttempts(id).catch(() => ({ attempts: [] })),
      ]);
      setPayment(payData);
      setAllocations(extractArray(allocData));
      setAttempts(extractArray(attemptData));

      const invoiceId = payData.invoice_id || (Array.isArray(allocData) ? allocData[0]?.invoice_id : allocData?.allocations?.[0]?.invoice_id);
      if (invoiceId) {
        invoiceApi.get(invoiceId).then(setInvoice).catch((err) => console.error("[PaymentDetail] Failed to load invoice:", err));
      }

      if (payData.customer_id) {
        customerApi.get(payData.customer_id).then(setCustomer).catch((err) => console.error("[PaymentDetail] Failed to load customer:", err));
        invoiceApi.list({ customer_id: payData.customer_id, status: "sent,overdue,partially_paid", per_page: 30 })
          .then((d) => setOpenInvoices(extractArray(d)))
          .catch((err) => console.error("[PaymentDetail] Failed to load open invoices:", err));
      }

      refundApi.list({ payment_id: id, per_page: 20 })
        .then((d) => setRefunds(extractArray(d)))
        .catch((err) => console.error("[PaymentDetail] Failed to load refunds:", err));

      auditApi.list({ resource_type: "payment", resource_id: id, per_page: 20 })
        .then((d) => setAuditLogs(extractArray(d)))
        .catch((err) => console.error("[PaymentDetail] Failed to load audit logs:", err));
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to load payment");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchPayment(); }, [fetchPayment]);

  const handleReconcile = async () => {
    setActionLoading("reconcile");
    try {
      await paymentApi.reconcile(id);
      await fetchPayment({ silent: true });
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to reconcile payment");
    } finally {
      setActionLoading(null);
    }
  };

  const handleUpdateStatus = async (status) => {
    setActionLoading(status);
    try {
      await paymentApi.updateStatus(id, status);
      await fetchPayment({ silent: true });
    } catch (err) {
      setError(err?.detail || err?.message || `Failed to update payment status`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleDeallocation = async (allocationId) => {
    setActionLoading("dealloc");
    setError(null);
    try {
      await paymentApi.deleteAllocation(allocationId);
      setConfirmDealloc(null);
      await fetchPayment({ silent: true });
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to reverse allocation");
    } finally {
      setActionLoading(null);
    }
  };

  const handleAllocate = async () => {
    const amt = parseFloat(allocateForm.amount);
    if (!allocateForm.invoice_id) { setError("Please select an invoice to allocate to"); return; }
    if (!amt || amt <= 0) { setError("Allocation amount must be greater than 0"); return; }
    if (amt > remaining) { setError(`Allocation amount cannot exceed unallocated balance of ${formatDisplayCurrency(remaining)}`); return; }
    setAllocating(true);
    setError(null);
    try {
      await paymentApi.allocate(id, { invoice_id: Number(allocateForm.invoice_id), amount: amt });
      setAllocateForm({ invoice_id: "", amount: "" });
      await fetchPayment({ silent: true });
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to allocate payment");
    } finally {
      setAllocating(false);
    }
  };

  const handleRefund = async () => {
    const amt = parseFloat(refundAmount);
    if (!amt || amt <= 0) { setError("Refund amount must be greater than 0"); return; }
    const refundable = parseFloat(payment.amount || 0);
    if (amt > refundable) { setError(`Refund amount cannot exceed refundable amount of ${refundable}`); return; }
    setActionLoading("refund");
    setError(null);
    try {
      const refund = await refundApi.create({
        customer_id: Number(payment.customer_id),
        payment_id: Number(id),
        refund_number: "auto",
        refund_type: refundType === "full" ? "full" : "partial",
        amount: amt,
        currency: payment.currency || "USD",
        reason: refundReason || undefined,
      });
      // A new refund starts in DRAFT — it must go through the same
      // submit → approve → process → complete governance as the full
      // Refunds workflow, so this only takes the first step and leaves
      // the rest to be actioned (with approval) from the refund's own page.
      await refundApi.submit(refund.id, refundReason || undefined);
      setShowRefundModal(false);
      setRefundAmount("");
      setRefundReason("");
      setRefundType("full");
      await fetchPayment({ silent: true });
      navigate(`/billing/refunds/${refund.id}`);
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to process refund");
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <HRPage title="Payment Detail" subtitle="Loading payment details...">
        <div className="flex items-center justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-brand-600" /></div>
      </HRPage>
    );
  }

  if (error && !payment) {
    return (
      <HRPage title="Payment Detail" subtitle="Error loading payment">
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <AlertCircle className="h-10 w-10 text-red-400 mb-3" />
          <p className="text-sm text-red-600 mb-3">{error}</p>
          <button onClick={fetchPayment} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-brand/30">
            <RefreshCw className="h-4 w-4" /> Retry
          </button>
        </div>
      </HRPage>
    );
  }

  if (!payment) {
    return (
      <HRPage title="Payment Detail" subtitle="Payment not found">
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <CreditCard className="h-10 w-10 text-slate-300 mb-3" />
          <p className="text-sm font-medium text-slate-500">Payment not found</p>
        </div>
      </HRPage>
    );
  }

  const btnClass = "inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-brand/30";
  const isActing = (a) => actionLoading === a;
  const allocatedTotal = allocations.reduce((s, a) => s + parseFloat(a.amount || 0), 0);
  const remaining = parseFloat(payment.amount || 0) - allocatedTotal;

  const renderOverview = () => (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-3xl border border-slate-200 p-5">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Amount</p>
          <p className="text-2xl font-bold text-slate-900 mt-1 whitespace-nowrap">{formatDisplayCurrency(payment.amount, payment.currency)}</p>
        </div>
        <div className="bg-white rounded-3xl border border-slate-200 p-5">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Method</p>
          <p className="text-2xl font-bold text-slate-900 mt-1 capitalize">{payment.payment_method_type || payment.payment_type?.replace(/_/g, " ") || "—"}</p>
        </div>
        <div className="bg-white rounded-3xl border border-slate-200 p-5">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Status</p>
          <div className="mt-2"><StatusBadge status={payment.status} /></div>
        </div>
        <div className="bg-white rounded-3xl border border-slate-200 p-5">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Date</p>
          <p className="text-2xl font-bold text-slate-900 mt-1">{formatDisplayDate(payment.payment_date || payment.created_at)}</p>
        </div>
      </div>

      <div className="bg-white rounded-3xl border border-slate-200 p-6">
        <h3 className="text-sm font-semibold text-slate-900 mb-4">Payment Information</h3>
        <div className="grid grid-cols-2 gap-x-8">
          <InfoRow label="Payment Number" value={payment.payment_number || `#${payment.id}`} />
          <InfoRow label="Transaction ID" value={payment.transaction_id || payment.gateway_transaction_id} />
          <InfoRow label="Customer" value={
            payment.customer_id ? (
              <button onClick={() => navigate(`/billing/customers/${payment.customer_id}`)} className="text-brand-600 hover:underline">
                {payment.customer_name || payment.customer?.name || `Customer #${payment.customer_id}`}
              </button>
            ) : (payment.customer_name || `Customer #${payment.customer_id}`)
          } />
          <InfoRow label="Currency" value={payment.currency || "USD"} />
          <InfoRow label="Reference" value={payment.reference_number} />
          <InfoRow label="Gateway" value={payment.gateway} />
          <InfoRow label="Gateway Fee" value={payment.gateway_fee > 0 ? formatDisplayCurrency(payment.gateway_fee) : "—"} />
          <InfoRow label="Exchange Rate" value={payment.exchange_rate && payment.exchange_rate !== 1 ? payment.exchange_rate : "—"} />
          <InfoRow label="Allocated" value={formatDisplayCurrency(allocatedTotal)} />
          {remaining > 0 && <InfoRow label="Unallocated" value={formatDisplayCurrency(remaining)} />}
          <InfoRow label="Created" value={formatDisplayDate(payment.created_at)} />
          {payment.updated_at && <InfoRow label="Updated" value={formatDisplayDate(payment.updated_at)} />}
        </div>
        {(payment.invoice_id || (invoice && invoice.id)) && (
          <div className="mt-4 pt-4 border-t border-slate-100">
            <button onClick={() => navigate(`/billing/invoices/${payment.invoice_id || invoice.id}`)}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:text-brand-700 hover:underline">
              <Receipt className="h-4 w-4" /> View Linked Invoice {payment.invoice_id ? `#${payment.invoice_id}` : ""}
            </button>
          </div>
        )}
      </div>

      {refunds.length > 0 && (
        <div className="bg-white rounded-3xl border border-slate-200 p-6">
          <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2"><RotateCcw size={16} className="text-brand-500" /> Refund History ({refunds.length})</h3>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead>
                <tr className="text-xs font-medium text-slate-500 uppercase tracking-wider">
                  <th className="text-left py-3 px-4">Refund</th>
                  <th className="text-left py-3 px-4">Date</th>
                  <th className="text-right py-3 px-4">Amount</th>
                  <th className="text-left py-3 px-4">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {refunds.map((r) => (
                  <tr key={r.id} onClick={() => navigate(`/billing/refunds/${r.id}`)} className="text-sm text-slate-900 hover:bg-slate-50 cursor-pointer">
                    <td className="py-3 px-4 font-medium">{r.refund_number || `#${r.id}`}</td>
                    <td className="py-3 px-4 whitespace-nowrap">{formatDisplayDate(r.created_at)}</td>
                    <td className="py-3 px-4 text-right font-medium">{formatDisplayCurrency(r.amount, r.currency)}</td>
                    <td className="py-3 px-4">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium capitalize ${
                        r.status === "completed" || r.status === "processed" ? "bg-emerald-100 text-emerald-700" :
                        r.status === "pending" || r.status === "submitted" ? "bg-amber-100 text-amber-700" :
                        r.status === "failed" || r.status === "rejected" ? "bg-red-100 text-red-700" :
                        "bg-slate-100 text-slate-600"
                      }`}>{r.status || "—"}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {payment.status === "pending" && (
        <div className="mb-6 p-4 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-700 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          This payment is pending. Mark as cleared when confirmed by the bank, then reconcile allocations.
        </div>
      )}
    </div>
  );

  const renderInvoice = () => {
    const inv = invoice || (payment.invoice_id ? { id: payment.invoice_id, invoice_number: `#${payment.invoice_id}` } : null);
    if (!inv) {
      return (
        <div className="bg-white rounded-3xl border border-slate-200 p-6">
          <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2"><Receipt size={16} className="text-brand-500" /> Invoice</h3>
          <div className="text-center py-8 text-slate-400">
            <Receipt size={32} className="mx-auto mb-2 text-slate-300" />
            <p className="text-sm">No invoice linked to this payment</p>
          </div>
        </div>
      );
    }
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-white rounded-3xl border border-slate-200 p-5">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Invoice</p>
            <p className="text-lg font-bold text-slate-900 mt-1">{inv.invoice_number}</p>
          </div>
          <div className="bg-white rounded-3xl border border-slate-200 p-5">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Total</p>
            <p className="text-lg font-bold text-slate-900 mt-1 whitespace-nowrap">{formatDisplayCurrency(inv.total_amount || inv.amount, inv.currency)}</p>
          </div>
          <div className="bg-white rounded-3xl border border-slate-200 p-5">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Status</p>
            <div className="mt-2">
              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${
                inv.status === "paid" ? "bg-emerald-100 text-emerald-700" : inv.status === "overdue" ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-600"
              }`}>{inv.status?.replace(/_/g, " ") || "—"}</span>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-3xl border border-slate-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2"><Receipt size={16} className="text-brand-500" /> Invoice Details</h3>
            <button onClick={() => navigate(`/billing/invoices/${inv.id}`)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-brand-600 bg-brand-50 rounded-lg hover:bg-brand-100 transition-colors">
              <FileText className="h-4 w-4" /> View Full Invoice
            </button>
          </div>
          <div className="grid grid-cols-2 gap-x-8">
            <InfoRow label="Invoice Number" value={inv.invoice_number} />
            <InfoRow label="Total Amount" value={formatDisplayCurrency(inv.total_amount || inv.amount, inv.currency)} />
            <InfoRow label="Paid Amount" value={formatDisplayCurrency(inv.paid_amount, inv.currency)} />
            <InfoRow label="Balance Due" value={formatDisplayCurrency(parseFloat(inv.total_amount || 0) - parseFloat(inv.paid_amount || 0), inv.currency)} />
            <InfoRow label="Status" value={<span className="capitalize">{inv.status?.replace(/_/g, " ")}</span>} />
            <InfoRow label="Payment Terms" value={inv.payment_terms} />
            <InfoRow label="Issue Date" value={formatDisplayDate(inv.issue_date)} />
            <InfoRow label="Due Date" value={formatDisplayDate(inv.due_date)} />
            {inv.currency && <InfoRow label="Currency" value={inv.currency} />}
          </div>
        </div>
      </div>
    );
  };

  const renderCustomer = () => (
    <div className="bg-white rounded-3xl border border-slate-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2"><User size={16} className="text-brand-500" /> Customer Details</h3>
        {payment.customer_id && (
          <button onClick={() => navigate(`/billing/customers/${payment.customer_id}`)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-brand-600 bg-brand-50 rounded-lg hover:bg-brand-100 transition-colors">
            <User className="h-4 w-4" /> View Customer Profile
          </button>
        )}
      </div>
      {customer ? (
        <div className="space-y-4">
          <div className="flex items-center gap-4 p-4 bg-slate-50 rounded-xl">
            <div className="h-14 w-14 rounded-full bg-gradient-to-br from-brand to-brand-hover text-white flex items-center justify-center text-xl font-bold">
              {(customer.display_name || customer.company_name || customer.name || "?").charAt(0).toUpperCase()}
            </div>
            <div>
              <p className="text-lg font-semibold text-slate-800">{customer.display_name || customer.company_name || customer.name}</p>
              {customer.customer_code && <p className="text-sm text-slate-500">{customer.customer_code}</p>}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-8">
            <InfoRow label="Email" value={customer.email} />
            <InfoRow label="Phone" value={customer.phone} />
            <InfoRow label="Mobile" value={customer.mobile} />
            <InfoRow label="Currency" value={customer.currency} />
            <InfoRow label="Payment Terms" value={customer.payment_terms?.replace(/_/g, " ")} />
            <InfoRow label="Tax ID" value={customer.tax_id} />
            <InfoRow label="Customer Type" value={customer.customer_type} />
          </div>
          {customer.billing_address && (
            <div className="p-3 bg-slate-50 rounded-lg">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1">Billing Address</p>
              <p className="text-sm text-slate-700 whitespace-pre-wrap">{customer.billing_address}</p>
            </div>
          )}
        </div>
      ) : (
        <div className="text-center py-8 text-slate-400">
          <User size={32} className="mx-auto mb-2 text-slate-300" />
          <p className="text-sm">Customer details not available</p>
          <p className="text-xs text-slate-400 mt-1">Customer #{payment.customer_id}</p>
        </div>
      )}
    </div>
  );

  const renderAllocation = () => (
    <div className="bg-white rounded-3xl border border-slate-200 p-6">
      <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2"><Layers size={16} className="text-brand-500" /> Allocations ({allocations.length})</h3>
      {allocations.length === 0 ? (
        <div className="text-center py-8 text-slate-400">
          <Layers size={32} className="mx-auto mb-2 text-slate-300" />
          <p className="text-sm">No allocations for this payment</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead>
              <tr className="text-xs font-medium text-slate-500 uppercase tracking-wider">
                <th className="text-left py-3 px-4">Invoice</th>
                <th className="text-right py-3 px-4">Amount</th>
                <th className="text-left py-3 px-4">Date</th>
                <th className="text-left py-3 px-4">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {allocations.map((alloc, i) => (
                <tr key={alloc.id || i} className="text-sm text-slate-900 hover:bg-slate-50">
                  <td className="py-3 px-4 font-medium">{alloc.invoice_number || alloc.invoice_id || "—"}</td>
                  <td className="py-3 px-4 text-right font-medium">{formatDisplayCurrency(alloc.amount)}</td>
                  <td className="py-3 px-4 whitespace-nowrap">{formatDisplayDate(alloc.created_at)}</td>
                  <td className="py-3 px-4">
                    <div className="flex items-center gap-2">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        alloc.status === "completed" ? "bg-emerald-100 text-emerald-700" :
                        alloc.status === "pending" ? "bg-amber-100 text-amber-700" :
                        "bg-slate-100 text-slate-600"
                      }`}>{alloc.status || "completed"}</span>
                      {payment.status === "cleared" && (
                        <button onClick={() => setConfirmDealloc(alloc.id)}
                          className="text-xs text-red-600 hover:text-red-800 hover:underline ml-2">
                          Reverse
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 p-4 bg-slate-50 border border-slate-200 rounded-xl">
        <div className="flex justify-between text-sm text-slate-600 mb-1">
          <span>Total Payment</span>
          <span className="font-medium text-slate-800">{formatDisplayCurrency(payment.amount)}</span>
        </div>
        <div className="flex justify-between text-sm text-slate-600 mb-1">
          <span>Allocated</span>
          <span className="font-medium text-slate-800">{formatDisplayCurrency(allocatedTotal)}</span>
        </div>
        <div className="flex justify-between text-sm font-medium border-t border-slate-200 pt-2 mt-1">
          <span>{remaining > 0 ? "Unallocated" : remaining < 0 ? "Over-allocated" : "Balance"}</span>
          <span className={remaining > 0 ? "text-amber-600" : remaining < 0 ? "text-red-600" : "text-emerald-600"}>
            {formatDisplayCurrency(Math.abs(remaining))}
          </span>
        </div>
      </div>

      {remaining > 0.005 && payment.status === "cleared" && (
        <div className="mt-4 p-4 bg-brand-50/50 border border-brand-200 rounded-xl">
          <h4 className="text-sm font-semibold text-slate-900 mb-3 flex items-center gap-2"><Plus size={15} className="text-brand-600" /> Allocate Unallocated ({formatDisplayCurrency(remaining)})</h4>
          {openInvoices.length === 0 ? (
            <p className="text-xs text-slate-500">No open invoices available for this customer.</p>
          ) : (
            <>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">Invoice</label>
                  <select value={allocateForm.invoice_id} onChange={(e) => setAllocateForm((p) => ({ ...p, invoice_id: e.target.value }))}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-white focus:border-brand-300 focus:outline-none focus:ring-1 focus:ring-brand/30">
                    <option value="">Select invoice...</option>
                    {openInvoices.map((inv) => (
                      <option key={inv.id} value={inv.id}>
                        {inv.invoice_number || `#${inv.id}`} · {formatDisplayCurrency(inv.total_amount || inv.amount || 0)} · balance {formatDisplayCurrency(inv.balance_due || parseFloat(inv.total_amount || 0) - parseFloat(inv.paid_amount || 0))}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">Amount ({payment.currency || "USD"})</label>
                  <input type="number" min="0.01" step="0.01" max={remaining.toFixed(2)} value={allocateForm.amount}
                    onChange={(e) => setAllocateForm((p) => ({ ...p, amount: e.target.value }))}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:border-brand-300 focus:outline-none focus:ring-1 focus:ring-brand/30" />
                </div>
              </div>
              <button onClick={handleAllocate} disabled={allocating || !allocateForm.invoice_id || !allocateForm.amount}
                className="mt-3 inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors">
                {allocating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Layers className="h-4 w-4" />}
                {allocating ? "Allocating..." : "Allocate"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );

  const renderTimeline = () => {
    const events = [];
    events.push({ icon: CreditCard, label: "Payment created", date: payment.created_at, color: "bg-brand-500" });

    if (payment.payment_date) {
      events.push({ icon: Calendar, label: "Payment date", date: payment.payment_date, color: "bg-blue-500" });
    }

    if (allocations.length > 0) {
      const allocDate = allocations[0]?.created_at || payment.updated_at;
      events.push({ icon: Layers, label: `Allocated to ${allocations.length} invoice(s)`, date: allocDate, color: "bg-indigo-500" });
    }

    if (payment.status === "cleared" || payment.reconciled_at) {
      events.push({ icon: CheckCircle, label: "Payment cleared", date: payment.cleared_at || payment.reconciled_at || payment.updated_at, color: "bg-emerald-500" });
    }

    if (payment.status === "failed") {
      events.push({ icon: XCircle, label: "Payment failed", date: payment.updated_at, color: "bg-red-500" });
    }

    if (payment.status === "refunded") {
      events.push({ icon: RotateCcw, label: "Payment refunded", date: payment.updated_at, color: "bg-blue-500" });
    }

    refunds.forEach((r) => {
      if (r.created_at) {
        events.push({ icon: RotateCcw, label: `Refund ${r.refund_number || `#${r.id}`} ${r.status ? `· ${r.status}` : ""}`, date: r.created_at, color: "bg-indigo-500" });
      }
    });

    if (payment.status === "cancelled") {
      events.push({ icon: Ban, label: "Payment cancelled", date: payment.updated_at, color: "bg-amber-500" });
    }

    return (
      <div className="bg-white rounded-3xl border border-slate-200 p-6">
        <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2"><Clock size={16} className="text-brand-500" /> Timeline</h3>
        <div className="space-y-4">
          {events.map((ev, i) => (
            <div key={i} className="flex gap-3">
              <div className={`w-8 h-8 rounded-full ${ev.color} text-white flex items-center justify-center flex-shrink-0 mt-0.5`}>
                <ev.icon size={14} />
              </div>
              <div>
                <p className="text-sm font-medium text-slate-800">{ev.label}</p>
                <p className="text-xs text-slate-400">{formatDisplayDate(ev.date)}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderNotes = () => (
    <div className="bg-white rounded-3xl border border-slate-200 p-6">
      <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2"><FileEdit size={16} className="text-brand-500" /> Notes</h3>
      {payment.notes ? (
        <p className="text-sm text-slate-700 whitespace-pre-wrap">{payment.notes}</p>
      ) : (
        <div className="text-center py-8 text-slate-400">
          <FileEdit size={32} className="mx-auto mb-2 text-slate-300" />
          <p className="text-sm">No notes for this payment</p>
        </div>
      )}
    </div>
  );

  const renderActivity = () => (
    <div className="bg-white rounded-3xl border border-slate-200 p-6">
      <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2"><Activity size={16} className="text-brand-500" /> Payment Attempts ({attempts.length})</h3>
      {attempts.length === 0 ? (
        <div className="text-center py-8 text-slate-400">
          <Activity size={32} className="mx-auto mb-2 text-slate-300" />
          <p className="text-sm">No payment attempts recorded</p>
        </div>
      ) : (
        <div className="space-y-3">
          {attempts.map((att, i) => (
            <div key={att.id || i} className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                att.status === "success" || att.status === "completed" ? "bg-emerald-100 text-emerald-600" :
                att.status === "failed" ? "bg-red-100 text-red-600" : "bg-slate-100 text-slate-600"
              }`}>
                {att.status === "success" || att.status === "completed" ? <CheckCircle size={14} /> :
                 att.status === "failed" ? <XCircle size={14} /> : <Clock size={14} />}
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium text-slate-800 capitalize">{att.status || "attempt"}</p>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                    att.status === "success" || att.status === "completed" ? "bg-emerald-100 text-emerald-700" :
                    att.status === "failed" ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-600"
                  }`}>{att.status || "—"}</span>
                </div>
                {att.message && <p className="text-xs text-slate-500 mt-0.5">{att.message}</p>}
                {att.gateway_response && <p className="text-xs text-slate-400 mt-0.5">Gateway: {att.gateway_response}</p>}
              </div>
              <span className="text-xs text-slate-400 whitespace-nowrap">{formatDisplayDate(att.created_at || att.attempted_at)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const renderAudit = () => (
    <div className="bg-white rounded-3xl border border-slate-200 p-6">
      <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2"><Shield size={16} className="text-brand-500" /> Audit Trail</h3>
      {auditLogs.length === 0 ? (
        <div className="text-center py-8 text-slate-400">
          <Shield size={32} className="mx-auto mb-2 text-slate-300" />
          <p className="text-sm">No audit log entries</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead>
              <tr className="text-xs font-medium text-slate-500 uppercase tracking-wider">
                <th className="text-left py-3 px-4">Action</th>
                <th className="text-left py-3 px-4">User</th>
                <th className="text-left py-3 px-4">Details</th>
                <th className="text-left py-3 px-4">Date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {auditLogs.map((log, i) => (
                <tr key={log.id || i} className="text-sm text-slate-900 hover:bg-slate-50">
                  <td className="py-3 px-4">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium capitalize ${
                      log.action === "created" ? "bg-brand-100 text-brand-700" :
                      log.action === "updated" ? "bg-blue-100 text-blue-700" :
                      log.action === "deleted" ? "bg-red-100 text-red-700" :
                      "bg-slate-100 text-slate-600"
                    }`}>{log.action || log.event_type || "—"}</span>
                  </td>
                  <td className="py-3 px-4 text-slate-600">{log.user_name || log.user_id || log.performed_by || "—"}</td>
                  <td className="py-3 px-4 text-slate-500 max-w-xs truncate">{log.details || log.description || log.message || "—"}</td>
                  <td className="py-3 px-4 text-slate-400 whitespace-nowrap">{formatDisplayDate(log.created_at || log.timestamp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  const renderTabContent = () => {
    switch (activeTab) {
      case "overview": return renderOverview();
      case "invoice": return renderInvoice();
      case "customer": return renderCustomer();
      case "allocation": return renderAllocation();
      case "timeline": return renderTimeline();
      case "notes": return renderNotes();
      case "activity": return renderActivity();
      case "audit": return renderAudit();
      default: return renderOverview();
    }
  };

  return (
    <>
    <HRPage
      title={`Payment ${payment.payment_number || `#${id}`}`}
      subtitle={<StatusBadge status={payment.status} />}
      actions={
        <div className="flex items-center gap-2">
          <button onClick={() => navigate("/billing/payments")}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-brand/30">
            <ArrowLeft className="h-4 w-4" /> Back
          </button>
        </div>
      }
    >
      {error && (
        <div className="mb-6 p-4 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0" /> {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        <div className="lg:col-span-3">
          <div className="mb-6">
            <TabNav tabs={TABS} active={activeTab} onChange={setActiveTab} />
          </div>
          {renderTabContent()}
        </div>

        <div className="space-y-6">
          <div className="bg-white rounded-3xl border border-slate-200 p-6">
            <h3 className="text-sm font-semibold text-slate-900 mb-4">Actions</h3>
            <div className="space-y-3">
              {payment.status === "pending" && (
                <>
                  <button onClick={() => handleUpdateStatus("cleared")} disabled={isActing("cleared")}
                    className={`${btnClass} w-full text-white bg-emerald-600 hover:bg-emerald-700`}>
                    {isActing("cleared") ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
                    Mark as Cleared
                  </button>
                  <button onClick={() => handleUpdateStatus("failed")} disabled={isActing("failed")}
                    className={`${btnClass} w-full text-red-700 bg-red-50 hover:bg-red-100`}>
                    {isActing("failed") ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                    Mark as Failed
                  </button>
                </>
              )}

              {payment.status === "cleared" && (
                <button onClick={handleReconcile} disabled={isActing("reconcile")}
                  className={`${btnClass} w-full text-white bg-emerald-600 hover:bg-emerald-700`}>
                  {isActing("reconcile") ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
                  Reconcile
                </button>
              )}

              {payment.status === "cleared" && (
                <button onClick={() => { setRefundType("full"); setRefundAmount(String(parseFloat(payment.amount || 0))); setRefundReason(""); setShowRefundModal(true); }}
                  className={`${btnClass} w-full text-blue-700 bg-blue-50 hover:bg-blue-100`}>
                  <RotateCcw className="h-4 w-4" />
                  Refund Payment
                </button>
              )}

              {payment.status !== "cancelled" && payment.status !== "refunded" && (
                <button onClick={() => handleUpdateStatus("cancelled")} disabled={isActing("cancelled")}
                  className={`${btnClass} w-full text-amber-700 bg-amber-50 hover:bg-amber-100`}>
                  {isActing("cancelled") ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
                  Cancel Payment
                </button>
              )}
            </div>
          </div>

          <div className="bg-white rounded-3xl border border-slate-200 p-6">
            <h3 className="text-sm font-semibold text-slate-900 mb-3">Quick Summary</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-slate-500">Amount</span><span className="font-medium">{formatDisplayCurrency(payment.amount, payment.currency)}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Allocated</span><span className="font-medium text-emerald-600">{formatDisplayCurrency(allocatedTotal)}</span></div>
              {remaining > 0 && <div className="flex justify-between"><span className="text-slate-500">Unallocated</span><span className="font-medium text-amber-600">{formatDisplayCurrency(remaining)}</span></div>}
              <div className="flex justify-between"><span className="text-slate-500">Fee</span><span className="font-medium">{payment.gateway_fee > 0 ? formatDisplayCurrency(payment.gateway_fee) : "—"}</span></div>
              <div className="flex justify-between text-base font-bold text-slate-800 border-t border-slate-200 pt-2 mt-2">
                <span>Net</span><span>{formatDisplayCurrency(parseFloat(payment.amount || 0) - parseFloat(payment.gateway_fee || 0))}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </HRPage>
    {confirmDealloc && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
        <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-2xl mx-4">
          <h3 className="text-lg font-bold text-slate-900 mb-2">Reverse Allocation</h3>
          <p className="text-sm text-slate-500 mb-5">This will remove the allocation and restore the invoice balance. This action cannot be undone.</p>
          <div className="flex justify-end gap-3">
            <button onClick={() => setConfirmDealloc(null)} disabled={isActing("dealloc")}
              className="px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 rounded-lg disabled:opacity-50">Cancel</button>
            <button onClick={() => handleDeallocation(confirmDealloc)} disabled={isActing("dealloc")}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg disabled:opacity-50">
              {isActing("dealloc") ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
              {isActing("dealloc") ? "Reversing..." : "Confirm Reversal"}
            </button>
          </div>
        </div>
      </div>
    )}
    {showRefundModal && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => { if (actionLoading !== "refund") setShowRefundModal(false); }}>
        <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-2xl mx-4" onClick={(e) => e.stopPropagation()}>
          <h3 className="text-lg font-bold text-slate-900 mb-1">Refund Payment</h3>
          <p className="text-sm text-slate-500 mb-4">Refundable amount: {formatDisplayCurrency(payment.amount, payment.currency)}</p>

          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Refund Type</label>
              <div className="flex gap-2">
                <button onClick={() => { setRefundType("full"); setRefundAmount(String(parseFloat(payment.amount || 0))); }}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${refundType === "full" ? "bg-blue-50 border-blue-300 text-blue-700" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}>
                  Full Refund
                </button>
                <button onClick={() => { setRefundType("partial"); setRefundAmount(""); }}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium border transition-colors ${refundType === "partial" ? "bg-blue-50 border-blue-300 text-blue-700" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}>
                  Partial Refund
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Refund Amount ({payment.currency || "USD"}) *</label>
              <input type="number" min="0.01" step="0.01" max={parseFloat(payment.amount || 0)} value={refundAmount}
                onChange={(e) => setRefundAmount(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500" />
              <p className="text-xs text-slate-400 mt-1">Max: {formatDisplayCurrency(payment.amount, payment.currency)}</p>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Reason</label>
              <textarea value={refundReason} onChange={(e) => setRefundReason(e.target.value)} rows={2}
                placeholder="Optional reason for refund..."
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500" />
            </div>
          </div>

          <div className="flex justify-end gap-3 mt-6">
            <button onClick={() => setShowRefundModal(false)} disabled={actionLoading === "refund"}
              className="px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-100 rounded-lg disabled:opacity-50">Cancel</button>
            <button onClick={handleRefund} disabled={actionLoading === "refund" || !refundAmount || parseFloat(refundAmount) <= 0}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-50">
              {actionLoading === "refund" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
              {actionLoading === "refund" ? "Processing..." : "Process Refund"}
            </button>
          </div>
        </div>
      </div>
    )}
  </>
  );
}
