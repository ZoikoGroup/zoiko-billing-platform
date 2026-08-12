import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  ArrowLeft, FileText, RefreshCw, AlertCircle, Loader2, Play, Ban, RotateCcw, FileText as FileTextIcon, User,
  Package, CreditCard, Clock, Activity, File, FileEdit, Calendar, Hash,
  XCircle, Info, Receipt, Building2, Send, Shield, Plus,
} from "lucide-react";
import HRPage from "../../../components/HRPage";
import { contractApi, customerApi, invoiceApi, subscriptionApi, auditApi } from "../../../service/billingService";
import { formatDisplayCurrency, formatDisplayDate, extractArray } from "../../../utils/billing-helpers";
import { useTerminology } from "../utils/TerminologyContext";

const STATUS_STYLES = {
  draft: "bg-slate-100 text-slate-700",
  pending: "bg-blue-100 text-blue-700",
  active: "bg-emerald-100 text-emerald-700",
  expired: "bg-gray-100 text-gray-700",
  terminated: "bg-red-100 text-red-700",
  cancelled: "bg-slate-100 text-slate-500",
};

function StatusBadge({ status }) {
  const s = STATUS_STYLES[status] || "bg-gray-100 text-gray-600";
  const icons = { active: Play, pending: Clock, draft: FileTextIcon, expired: Clock, terminated: XCircle, cancelled: Ban };
  const Icon = icons[status] || Clock;
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium ${s}`}>
      <Icon size={12} /> {status ? status.charAt(0).toUpperCase() + status.slice(1) : "Unknown"}
    </span>
  );
}

const TABS = [
  { key: "overview", label: "Overview", icon: FileTextIcon },
  { key: "customer", label: "Customer", icon: User },
  { key: "products", label: "Products", icon: Package },
  { key: "pricing", label: "Pricing", icon: CreditCard },
  { key: "billing", label: "Billing Schedule", icon: Calendar },
  { key: "amendments", label: "Amendments", icon: FileEdit },
  { key: "timeline", label: "Timeline", icon: Clock },
  { key: "documents", label: "Documents", icon: File },
  { key: "notes", label: "Notes", icon: FileEdit },
  { key: "activity", label: "Activity", icon: Activity },
];

function TabNav({ tabs, active, onChange }) {
  return (
    <nav className="flex gap-0 border-b border-gray-200 overflow-x-auto">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        return (
          <button key={tab.key} onClick={() => onChange(tab.key)}
            className={`inline-flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
              active === tab.key ? "border-brand-600 text-brand-600" : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
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

function TimelineEvent({ icon: Icon, label, date, color }) {
  return (
    <div className="flex gap-3">
      <div className={`w-8 h-8 rounded-full ${color} text-white flex items-center justify-center flex-shrink-0 mt-0.5`}>
        <Icon size={14} />
      </div>
      <div>
        <p className="text-sm font-medium text-slate-800">{label}</p>
        <p className="text-xs text-slate-400">{formatDisplayDate(date)}</p>
      </div>
    </div>
  );
}

export default function ContractDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { singular } = useTerminology();

  const [contract, setContract] = useState(null);
  const [customer, setCustomer] = useState(null);
  const [invoices, setInvoices] = useState([]);
  const [subscriptions, setSubscriptions] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [contractItems, setContractItems] = useState([]);
  const [amendments, setAmendments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);
  const [activeTab, setActiveTab] = useState("overview");

  const [showRenewModal, setShowRenewModal] = useState(false);
  const [renewForm, setRenewForm] = useState({
    new_end_date: new Date(Date.now() + 365 * 86400000).toISOString().split("T")[0],
  });
  const [showTerminateModal, setShowTerminateModal] = useState(false);
  const [terminateReason, setTerminateReason] = useState("");
  const [showAmendmentModal, setShowAmendmentModal] = useState(false);
  const [amendmentForm, setAmendmentForm] = useState({
    effective_date: new Date().toISOString().split("T")[0],
    reason: "",
  });

  const fetchContract = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const cData = await contractApi.get(id);
      setContract(cData);

      if (cData.customer_id) {
        customerApi.get(cData.customer_id).then(setCustomer).catch((err) => console.error("[ContractDetail] Failed to load customer:", err));
      }

      invoiceApi.list({ contract_id: id, per_page: 20 }).then((d) => setInvoices(extractArray(d))).catch((err) => console.error("[ContractDetail] Failed to load invoices:", err));
      subscriptionApi.list({ contract_id: id, per_page: 20 }).then((d) => setSubscriptions(extractArray(d))).catch((err) => console.error("[ContractDetail] Failed to load subscriptions:", err));
      auditApi.list({ resource_type: "contract", resource_id: id, per_page: 20 }).then((d) => setAuditLogs(extractArray(d))).catch((err) => console.error("[ContractDetail] Failed to load audit logs:", err));
      
      // Fetch contract items and amendments
      contractApi.getItems(id).then((d) => setContractItems(extractArray(d))).catch((err) => console.error("[ContractDetail] Failed to load items:", err));
      contractApi.getAmendments(id).then((d) => setAmendments(extractArray(d))).catch((err) => console.error("[ContractDetail] Failed to load amendments:", err));
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to load contract");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchContract(); }, [fetchContract]);

  async function handleAction(action, actionFn) {
    try {
      setActionLoading(action);
      setError(null);
      await actionFn();
      await fetchContract({ silent: true });
    } catch (err) {
      setError(err?.detail || err?.message || `Failed to ${action} contract`);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleRenew() {
    if (!renewForm.new_end_date) return;
    try {
      setActionLoading("renew");
      setError(null);
      await contractApi.renew(id, renewForm.new_end_date);
      setShowRenewModal(false);
      await fetchContract({ silent: true });
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to renew contract");
    } finally {
      setActionLoading(null);
    }
  }

  async function handleGenerateInvoice() {
    try {
      setActionLoading("generate invoice");
      setError(null);
      const res = await contractApi.generateInvoice(id);
      if (res && res.id) {
        navigate(`/billing/invoices/${res.id}`);
      } else {
        await fetchContract({ silent: true });
      }
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to generate invoice");
    } finally {
      setActionLoading(null);
    }
  }

  async function handleTerminate() {
    if (!terminateReason.trim()) return;
    try {
      setActionLoading("terminate");
      setError(null);
      await contractApi.terminate(id, { reason: terminateReason.trim() });
      setShowTerminateModal(false);
      setTerminateReason("");
      await fetchContract({ silent: true });
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to terminate contract");
    } finally {
      setActionLoading(null);
    }
  }

  async function handleCreateAmendment() {
    if (!amendmentForm.effective_date) return;
    setActionLoading("create amendment");
    setError(null);
    try {
      await contractApi.createAmendment(id, {
        amendment_date: new Date().toISOString().split("T")[0],
        effective_date: amendmentForm.effective_date,
        reason: amendmentForm.reason || null,
        previous_values: {},
        new_values: {},
      });
      setShowAmendmentModal(false);
      setAmendmentForm({ effective_date: new Date().toISOString().split("T")[0], reason: "" });
      await fetchContract({ silent: true });
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to create amendment");
    } finally {
      setActionLoading(null);
    }
  }

  if (loading) {
    return (
      <HRPage title="Contract Detail" subtitle="Loading contract details...">
        <div className="flex items-center justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-brand-600" /></div>
      </HRPage>
    );
  }

  if (error && !contract) {
    return (
      <HRPage title="Contract Detail" subtitle="Error loading contract">
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <AlertCircle className="h-10 w-10 text-red-400 mb-3" />
          <p className="text-sm text-red-600 mb-3">{error}</p>
          <button onClick={fetchContract} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors">
            <RefreshCw className="h-4 w-4" /> Retry
          </button>
        </div>
      </HRPage>
    );
  }

  if (!contract) {
    return (
      <HRPage title="Contract Detail" subtitle="Contract not found">
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <FileText className="h-10 w-10 text-gray-300 mb-3" />
          <p className="text-sm font-medium text-gray-500">Contract not found</p>
        </div>
      </HRPage>
    );
  }

  const btnClass = "inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50";
  const isActing = (a) => actionLoading === a;

  const isDraft = contract.status === "draft";
  const isPending = contract.status === "pending";
  const isActive = contract.status === "active";
  const isExpired = contract.status === "expired";
  const isTerminated = contract.status === "terminated";
  const isCancelled = contract.status === "cancelled";

  const totalInvoices = invoices.length;
  const totalInvoiceValue = invoices.reduce((s, inv) => s + parseFloat(inv.total_amount || 0), 0);
  const outstandingInvoices = invoices.filter((inv) => inv.status === "sent" || inv.status === "overdue" || inv.status === "partially_paid");
  const outstandingValue = outstandingInvoices.reduce((s, inv) => s + parseFloat(inv.balance_due || 0), 0);
  const paidInvoices = invoices.filter((inv) => inv.status === "paid");
  const paidValue = paidInvoices.reduce((s, inv) => s + parseFloat(inv.paid_amount || 0), 0);

  const renderOverview = () => (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Contract Value</p>
          <p className="text-2xl font-bold text-gray-900 mt-1 whitespace-nowrap">{formatDisplayCurrency(contract.total_value ?? contract.value, contract.currency)}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Status</p>
          <div className="mt-2"><StatusBadge status={contract.status} /></div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Term</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">
            {formatDisplayDate(contract.start_date)} — {formatDisplayDate(contract.end_date) || "Ongoing"}
          </p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Billing</p>
          <p className="text-2xl font-bold text-gray-900 mt-1 capitalize">{contract.billing_period?.replace(/_/g, " ")}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Contract Information</h3>
          <div className="space-y-3">
            <InfoRow label="Contract Number" value={contract.contract_number} />
            <InfoRow label="Contract Name" value={contract.contract_name} />
            <InfoRow label={singular} value={contract.customer_name || `${singular} #${contract.customer_id}`} />
            <InfoRow label="Currency" value={contract.currency} />
            <InfoRow label="Start Date" value={formatDisplayDate(contract.start_date)} />
            <InfoRow label="End Date" value={formatDisplayDate(contract.end_date) || "—"} />
            <InfoRow label="Notice Period" value={`${contract.notice_period_days || 30} days`} />
            <InfoRow label="Auto Renew" value={contract.auto_renew ? "Yes" + (contract.renewal_term_days ? ` (every ${contract.renewal_term_days} days)` : "") : "No"} />
            <InfoRow label="Created" value={formatDisplayDate(contract.created_at)} />
            <InfoRow label="Updated" value={formatDisplayDate(contract.updated_at)} />
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Financial Summary</h3>
          <div className="space-y-3">
            <InfoRow label="Contract Value" value={formatDisplayCurrency(contract.total_value ?? contract.value, contract.currency)} />
            <InfoRow label="Total Invoiced" value={formatDisplayCurrency(totalInvoiceValue, contract.currency)} />
            <InfoRow label="Paid" value={formatDisplayCurrency(paidValue, contract.currency)} />
            <InfoRow label="Outstanding" value={formatDisplayCurrency(outstandingValue, contract.currency)} />
            <InfoRow label="Invoices" value={`${totalInvoices} total (${outstandingInvoices.length} outstanding)`} />
            {contract.quotation_id && (
              <div className="flex items-center justify-between py-2 border-b border-slate-50 last:border-0">
                <span className="text-sm text-slate-500">From Quotation</span>
                <button onClick={() => navigate(`/billing/quotations/${contract.quotation_id}`)}
                  className="text-sm font-medium text-brand-600 hover:underline">
                  #{contract.quotation_id} →
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <h3 className="text-sm font-semibold text-gray-900 mb-3">Subscriptions</h3>
          {subscriptions.length === 0 ? (
            <div className="text-center py-4 text-slate-400">
              <CreditCard size={24} className="mx-auto mb-2 text-slate-300" />
              <p className="text-sm">No subscriptions linked</p>
            </div>
          ) : (
            <div className="space-y-2">
              {subscriptions.map((sub) => (
                <div key={sub.id} onClick={() => navigate(`/billing/subscriptions/${sub.id}`)}
                  className="flex items-center justify-between p-2 bg-slate-50 rounded-lg cursor-pointer hover:bg-slate-100 transition-colors">
                  <div>
                    <p className="text-sm font-medium text-slate-800 hover:text-brand-600">{sub.subscription_number || `#${sub.id}`}</p>
                    <p className="text-xs text-slate-500">{sub.status}</p>
                  </div>
                  <span className="text-sm font-medium text-slate-800">{formatDisplayCurrency(sub.unit_price, contract.currency)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {isDraft && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-700 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          This contract is in draft status. Activate it to start billing.
        </div>
      )}
    </div>
  );

  const renderCustomer = () => (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2"><User size={16} className="text-brand-500" /> {singular} Details</h3>
      {customer ? (
        <div className="space-y-4">
          <div className="flex items-center gap-4 p-4 bg-slate-50 rounded-xl">
            <div className="h-14 w-14 rounded-full bg-gradient-to-br from-brand to-brand-hover text-white flex items-center justify-center text-xl font-bold">
              {(customer.display_name || customer.company_name || "?").charAt(0).toUpperCase()}
            </div>
            <div>
              <p className="text-lg font-semibold text-slate-800">{customer.display_name || customer.company_name}</p>
              {customer.customer_code && <p className="text-sm text-slate-500">{customer.customer_code}</p>}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-x-8">
            <InfoRow label="Email" value={customer.email} />
            <InfoRow label="Phone" value={customer.phone} />
            <InfoRow label="Mobile" value={customer.mobile} />
            <InfoRow label="Website" value={customer.website} />
            <InfoRow label="Currency" value={customer.currency} />
            <InfoRow label="Payment Terms" value={customer.payment_terms?.replace("_", " ")} />
            <InfoRow label="Tax ID" value={customer.tax_id} />
            <InfoRow label={`${singular} Type`} value={customer.customer_type} />
          </div>
          {customer.billing_address && (
            <div className="p-3 bg-slate-50 rounded-lg">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1">Billing Address</p>
              <p className="text-sm text-slate-700 whitespace-pre-wrap">{customer.billing_address}</p>
            </div>
          )}
          {customer.shipping_address && (
            <div className="p-3 bg-slate-50 rounded-lg">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1">Shipping Address</p>
              <p className="text-sm text-slate-700 whitespace-pre-wrap">{customer.shipping_address}</p>
            </div>
          )}
        </div>
      ) : (
        <div className="text-center py-8 text-slate-400">
          <User size={32} className="mx-auto mb-2 text-slate-300" />
          <p className="text-sm">{singular} details not available</p>
          <p className="text-xs text-slate-400 mt-1">{singular} #{contract.customer_id}</p>
        </div>
      )}
    </div>
  );

  const renderProducts = () => {
    const products = contractItems;
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2"><Package size={16} className="text-brand-500" /> Products ({products.length})</h3>
        {products.length === 0 ? (
          <div className="text-center py-8 text-slate-400">
            <Package size={32} className="mx-auto mb-2 text-slate-300" />
            <p className="text-sm">No products linked to this contract</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead>
                <tr className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                  <th className="text-left py-3 px-4">#</th>
                  <th className="text-left py-3 px-4">Description</th>
                  <th className="text-right py-3 px-4">Qty</th>
                  <th className="text-right py-3 px-4">Unit Price</th>
                  <th className="text-right py-3 px-4">Discount %</th>
                  <th className="text-right py-3 px-4">Tax %</th>
                  <th className="text-right py-3 px-4">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {products.map((item, i) => (
                  <tr key={item.id || i} onClick={() => item.product_id && navigate(`/billing/products/${item.product_id}`)}
                    className={`text-sm text-gray-900 hover:bg-slate-50 ${item.product_id ? "cursor-pointer" : ""}`}>
                    <td className="py-3 px-4 text-gray-400">{item.line_number || i + 1}</td>
                    <td className="py-3 px-4">
                      <p className="font-medium text-slate-800">{item.description || "Item"}</p>
                      {item.product_id && <p className="text-xs text-brand-600 hover:underline">Product #{item.product_id} →</p>}
                    </td>
                    <td className="py-3 px-4 text-right">{parseFloat(item.quantity || 1).toFixed(2)}</td>
                    <td className="py-3 px-4 text-right">{formatDisplayCurrency(item.unit_price, contract.currency)}</td>
                    <td className="py-3 px-4 text-right text-gray-500">{parseFloat(item.discount_percentage || 0) > 0 ? `${item.discount_percentage}%` : "—"}</td>
                    <td className="py-3 px-4 text-right text-gray-500">{parseFloat(item.tax_percentage || 0) > 0 ? `${item.tax_percentage}%` : "—"}</td>
                    <td className="py-3 px-4 text-right font-medium">{formatDisplayCurrency(item.total_amount, contract.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };

  const renderPricing = () => {
    const products = contractItems;
    const subtotal = products.reduce((s, i) => s + parseFloat(i.quantity || 1) * parseFloat(i.unit_price || 0), 0);
    const discAmt = products.reduce((s, i) => s + parseFloat(i.discount_amount || 0), 0);
    const taxAmt = products.reduce((s, i) => s + parseFloat(i.tax_amount || 0), 0);
    const total = subtotal - discAmt + taxAmt;
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2"><CreditCard size={16} className="text-brand-500" /> Pricing Summary</h3>
          <div className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">Subtotal ({products.length} items)</span>
              <span className="font-medium text-slate-800">{formatDisplayCurrency(subtotal, contract.currency)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">Discount</span>
              <span className="font-medium text-red-500">-{formatDisplayCurrency(discAmt, contract.currency)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">Tax</span>
              <span className="font-medium text-slate-800">{formatDisplayCurrency(taxAmt, contract.currency)}</span>
            </div>
            <div className="flex justify-between text-base font-bold text-slate-800 border-t border-slate-200 pt-3">
              <span>Total</span>
              <span>{formatDisplayCurrency(total, contract.currency)}</span>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2"><Hash size={16} className="text-brand-500" /> Details</h3>
          <div className="space-y-3">
            <InfoRow label="Currency" value={contract.currency} />
            <InfoRow label="Billing Period" value={contract.billing_period?.replace(/_/g, " ")} />
            <InfoRow label="Billing Day" value={contract.billing_day ? `Day ${contract.billing_day}` : "—"} />
            <InfoRow label="Notice Period" value={`${contract.notice_period_days || 30} days`} />
            <InfoRow label="Auto Renew" value={contract.auto_renew ? "Yes" + (contract.renewal_term_days ? ` (${contract.renewal_term_days} days)` : "") : "No"} />
          </div>
        </div>
      </div>
    );
  };

  const renderBilling = () => (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Billing Period</p>
          <p className="text-2xl font-bold text-gray-900 mt-1 capitalize">{contract.billing_period?.replace(/_/g, " ")}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Billing Day</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{contract.billing_day ? `Day ${contract.billing_day}` : "—"}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Next Billing</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{contract.next_billing_date ? formatDisplayDate(contract.next_billing_date) : "—"}</p>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2"><Calendar size={16} className="text-brand-500" /> Invoice Schedule</h3>
        {invoices.length === 0 ? (
          <div className="text-center py-8 text-slate-400">
            <Receipt size={32} className="mx-auto mb-2 text-slate-300" />
            <p className="text-sm">No invoices generated yet</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead>
                <tr className="text-xs font-medium text-gray-500 uppercase tracking-wider">
                  <th className="text-left py-3 px-4">Invoice</th>
                  <th className="text-left py-3 px-4">Issue Date</th>
                  <th className="text-left py-3 px-4">Due Date</th>
                  <th className="text-right py-3 px-4">Amount</th>
                  <th className="text-right py-3 px-4">Paid</th>
                  <th className="text-right py-3 px-4">Balance</th>
                  <th className="text-left py-3 px-4">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {invoices.map((inv) => (
                  <tr key={inv.id} onClick={() => navigate(`/billing/invoices/${inv.id}`)} className="text-sm text-gray-900 hover:bg-slate-50 cursor-pointer">
                    <td className="py-3 px-4 font-medium text-brand-600 hover:underline">{inv.invoice_number || `#${inv.id}`}</td>
                    <td className="py-3 px-4 whitespace-nowrap">{formatDisplayDate(inv.issue_date)}</td>
                    <td className="py-3 px-4 whitespace-nowrap">{formatDisplayDate(inv.due_date)}</td>
                    <td className="py-3 px-4 text-right font-medium">{formatDisplayCurrency(inv.total_amount, inv.currency)}</td>
                    <td className="py-3 px-4 text-right text-emerald-600">{formatDisplayCurrency(inv.paid_amount, inv.currency)}</td>
                    <td className="py-3 px-4 text-right text-amber-600 font-medium">{formatDisplayCurrency(inv.balance_due, inv.currency)}</td>
                    <td className="py-3 px-4">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        inv.status === "paid" ? "bg-emerald-100 text-emerald-700" :
                        inv.status === "overdue" ? "bg-red-100 text-red-700" :
                        inv.status === "partially_paid" ? "bg-amber-100 text-amber-700" :
                        inv.status === "sent" ? "bg-blue-100 text-blue-700" :
                        "bg-gray-100 text-gray-600"
                      }`}>{inv.status?.replace(/_/g, " ")}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );

  const renderTimeline = () => {
    const events = [];
    events.push({ icon: FileText, label: "Contract created", date: contract.created_at, color: "bg-brand-500" });
    if (contract.signed_by_customer && contract.signed_at) events.push({ icon: Send, label: "Signed by customer", date: contract.signed_at, color: "bg-blue-500" });
    if (contract.signed_by_org && contract.signed_at) events.push({ icon: Shield, label: "Signed by organization", date: contract.signed_at, color: "bg-indigo-500" });
    if (contract.status === "active" && contract.start_date) events.push({ icon: Play, label: "Activated", date: contract.start_date, color: "bg-emerald-500" });
    if (invoices.length > 0) {
      const firstInv = invoices[invoices.length - 1];
      events.push({ icon: Receipt, label: `First invoice generated (${invoices.length} total)`, date: firstInv.created_at, color: "bg-brand-500" });
    }
    if (contract.status === "terminated" && contract.end_date) events.push({ icon: XCircle, label: "Terminated", date: contract.end_date, color: "bg-red-500" });
    if (contract.status === "cancelled" && contract.updated_at) events.push({ icon: Ban, label: "Cancelled", date: contract.updated_at, color: "bg-amber-500" });
    if (contract.status === "expired" && contract.end_date) events.push({ icon: Clock, label: "Expired", date: contract.end_date, color: "bg-gray-500" });

    return (
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2"><Clock size={16} className="text-brand-500" /> Timeline</h3>
        <div className="space-y-4">
          {events.map((ev, i) => (
            <TimelineEvent key={i} icon={ev.icon} label={ev.label} date={ev.date} color={ev.color} />
          ))}
        </div>
      </div>
    );
  };

  const renderDocuments = () => (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2"><File size={16} className="text-brand-500" /> Documents</h3>
      {contract.document_url ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg">
            <FileText className="h-8 w-8 text-brand-500" />
            <div className="flex-1">
              <p className="font-medium text-slate-800">Contract Document</p>
              <p className="text-xs text-slate-400">Uploaded: {formatDisplayDate(contract.updated_at)}</p>
            </div>
            <a href={contract.document_url} target="_blank" rel="noopener noreferrer" className="text-sm text-brand-600 hover:text-brand-700 font-medium">View</a>
          </div>
        </div>
      ) : (
        <div className="text-center py-8 text-slate-400">
          <File size={32} className="mx-auto mb-2 text-slate-300" />
          <p className="text-sm">No documents uploaded</p>
        </div>
      )}
    </div>
  );

  const renderNotes = () => (
    <div className="space-y-6">
      {contract.notes && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h3 className="text-sm font-semibold text-gray-900 mb-2 flex items-center gap-2"><FileEdit size={16} className="text-brand-500" /> Notes</h3>
          <p className="text-sm text-slate-700 whitespace-pre-wrap">{contract.notes}</p>
        </div>
      )}
      {contract.terms && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h3 className="text-sm font-semibold text-gray-900 mb-2 flex items-center gap-2"><FileTextIcon size={16} className="text-brand-500" /> Terms & Conditions</h3>
          <p className="text-sm text-slate-700 whitespace-pre-wrap">{contract.terms}</p>
        </div>
      )}
      {!contract.notes && !contract.terms && (
        <div className="text-center py-8 text-slate-400">
          <FileEdit size={32} className="mx-auto mb-2 text-slate-300" />
          <p className="text-sm">No notes or terms</p>
        </div>
      )}
    </div>
  );

  const renderActivity = () => (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <h3 className="text-sm font-semibold text-gray-900 mb-4 flex items-center gap-2"><Activity size={16} className="text-brand-500" /> Recent Activity</h3>
      {auditLogs.length === 0 ? (
        <div className="text-center py-8 text-slate-400">
          <Activity size={32} className="mx-auto mb-2 text-slate-300" />
          <p className="text-sm">No activity recorded</p>
        </div>
      ) : (
        <div className="space-y-3">
          {auditLogs.slice(0, 10).map((log, i) => (
            <div key={log.id || i} className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                log.action === "created" ? "bg-brand-100 text-brand-600" :
                log.action === "updated" ? "bg-blue-100 text-blue-600" :
                log.action === "deleted" ? "bg-red-100 text-red-600" :
                "bg-slate-100 text-slate-600"
              }`}>
                <Info size={14} />
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-slate-800 capitalize">{log.action || log.event_type || "Activity"}</p>
                <p className="text-xs text-slate-500">{log.details || log.description || log.message || "—"}</p>
              </div>
              <span className="text-xs text-slate-400 whitespace-nowrap">{formatDisplayDate(log.created_at || log.timestamp)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const renderAmendments = () => (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2"><FileEdit size={16} className="text-brand-500" /> Amendments ({amendments.length})</h3>
        <button 
          onClick={() => setShowAmendmentModal(true)}
          className="px-3 py-1.5 text-xs font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors"
        >
          <Plus size={12} className="inline mr-1" /> Create Amendment
        </button>
      </div>
      {amendments.length === 0 ? (
        <div className="text-center py-8 text-slate-400">
          <FileEdit size={32} className="mx-auto mb-2 text-slate-300" />
          <p className="text-sm">No amendments recorded</p>
        </div>
      ) : (
        <div className="space-y-4">
          {amendments.map((amendment) => (
            <div key={amendment.id} className="border border-slate-200 rounded-xl p-4">
              <div className="flex items-start justify-between gap-4 mb-3">
                <div>
                  <p className="font-medium text-slate-800">Amendment #{amendment.amendment_number}</p>
                  <p className="text-xs text-slate-500">Created: {formatDisplayDate(amendment.created_at)}</p>
                </div>
                <span className="px-2 py-0.5 bg-brand-50 text-brand-700 text-xs font-medium rounded-full">
                  {amendment.effective_date ? `Effective: ${formatDisplayDate(amendment.effective_date)}` : "Pending"}
                </span>
              </div>
              {amendment.reason && (
                <div className="mb-3 p-3 bg-slate-50 rounded-lg">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1">Reason</p>
                  <p className="text-sm text-slate-700">{amendment.reason}</p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">Previous Values</p>
                  <pre className="text-xs bg-slate-50 p-2 rounded max-h-32 overflow-auto">{JSON.stringify(amendment.previous_values || {}, null, 2)}</pre>
                </div>
                <div>
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-2">New Values</p>
                  <pre className="text-xs bg-slate-50 p-2 rounded max-h-32 overflow-auto">{JSON.stringify(amendment.new_values || {}, null, 2)}</pre>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  const renderTabContent = () => {
    switch (activeTab) {
      case "overview": return renderOverview();
      case "customer": return renderCustomer();
      case "products": return renderProducts();
      case "pricing": return renderPricing();
      case "billing": return renderBilling();
      case "amendments": return renderAmendments();
      case "timeline": return renderTimeline();
      case "documents": return renderDocuments();
      case "notes": return renderNotes();
      case "activity": return renderActivity();
      default: return renderOverview();
    }
  };

  return (
    <HRPage
      title={`Contract ${contract.contract_number || `#${id}`}`}
      subtitle={
        <span className="flex items-center gap-2">
          <StatusBadge status={contract.status} />
          {contract.contract_version > 1 && <span className="text-xs text-slate-400">v{contract.contract_version}</span>}
        </span>
      }
      actions={
        <div className="flex items-center gap-2">
          <button onClick={() => navigate("/billing/contracts")}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors">
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
            <TabNav tabs={TABS.map(t => t.key === "customer" ? {...t, label: singular} : t)} active={activeTab} onChange={setActiveTab} />
          </div>
          {renderTabContent()}
        </div>

        <div className="space-y-6">
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h3 className="text-sm font-semibold text-gray-900 mb-4">Actions</h3>
            <div className="space-y-3">
              <button onClick={() => navigate(`/billing/contracts/${id}/edit`)}
                className={`${btnClass} w-full text-slate-700 bg-white border border-slate-300 hover:bg-slate-50`}>
                <FileEdit className="h-4 w-4" /> Edit Contract
              </button>

              {isDraft && (
                <>
                  <button onClick={() => handleAction("activate", () => contractApi.activate(id))} disabled={isActing("activate")}
                    className={`${btnClass} w-full text-white bg-emerald-600 hover:bg-emerald-700`}>
                    {isActing("activate") ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                    Activate Contract
                  </button>
                  <button onClick={() => handleAction("cancel", () => contractApi.cancel(id))} disabled={isActing("cancel")}
                    className={`${btnClass} w-full text-red-700 bg-red-50 hover:bg-red-100`}>
                    {isActing("cancel") ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                    Cancel Contract
                  </button>
                </>
              )}

              {isPending && (
                <>
                  <button onClick={() => handleAction("activate", () => contractApi.activate(id))} disabled={isActing("activate")}
                    className={`${btnClass} w-full text-white bg-emerald-600 hover:bg-emerald-700`}>
                    {isActing("activate") ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                    Activate Contract
                  </button>
                </>
              )}

              {isActive && (
                <>
                  {totalInvoices === 0 && (
                    <button onClick={handleGenerateInvoice} disabled={isActing("generate invoice")}
                      className={`${btnClass} w-full text-white bg-brand-600 hover:bg-brand-700`}>
                      {isActing("generate invoice") ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileTextIcon className="h-4 w-4" />} Generate Invoice
                    </button>
                  )}
                  <button onClick={() => navigate(`/billing/subscriptions?contract_id=${id}`)}
                    className={`${btnClass} w-full text-brand-700 bg-brand-50 hover:bg-brand-100`}>
                    <CreditCard className="h-4 w-4" /> Create Subscription
                  </button>
                  <button onClick={() => setShowRenewModal(true)}
                    className={`${btnClass} w-full text-brand-700 bg-brand-50 hover:bg-brand-100`}>
                    <RotateCcw className="h-4 w-4" /> Renew Contract
                  </button>
                  <button onClick={() => setShowTerminateModal(true)}
                    className={`${btnClass} w-full text-red-700 bg-red-50 hover:bg-red-100`}>
                    <XCircle className="h-4 w-4" /> Terminate Contract
                  </button>
                </>
              )}

              {isExpired && (
                <button onClick={() => setShowRenewModal(true)}
                  className={`${btnClass} w-full text-brand-700 bg-brand-50 hover:bg-brand-100`}>
                  <RotateCcw className="h-4 w-4" /> Renew Contract
                </button>
              )}

              {contract.customer_id && (
                <button onClick={() => navigate(`/billing/customers/${contract.customer_id}`)}
                  className={`${btnClass} w-full text-blue-700 bg-blue-50 hover:bg-blue-100`}>
                  <Building2 className="h-4 w-4" /> View {singular}
                </button>
              )}

              {contract.quotation_id && (
                <button onClick={() => navigate(`/billing/quotations/${contract.quotation_id}`)}
                  className={`${btnClass} w-full text-slate-700 bg-slate-50 hover:bg-slate-100`}>
                  <FileTextIcon className="h-4 w-4" /> View Quotation
                </button>
              )}

              {totalInvoices > 0 && (
                <button onClick={() => navigate(`/billing/invoices?contract_id=${id}`)}
                  className={`${btnClass} w-full text-green-700 bg-green-50 hover:bg-green-100`}>
                  <Receipt className="h-4 w-4" /> View Invoices ({totalInvoices})
                </button>
              )}

              {outstandingValue > 0 && contract.customer_id && (
                <button onClick={() => navigate(`/billing/payments?create=1&customer_id=${contract.customer_id}`)}
                  className={`${btnClass} w-full text-white bg-emerald-600 hover:bg-emerald-700`}>
                  <CreditCard className="h-4 w-4" /> Record Payment ({formatDisplayCurrency(outstandingValue, contract.currency)})
                </button>
              )}

              {subscriptions.length > 0 && (
                <button onClick={() => navigate(`/billing/subscriptions?contract_id=${id}`)}
                  className={`${btnClass} w-full text-brand-700 bg-brand-50 hover:bg-brand-100`}>
                  <CreditCard className="h-4 w-4" /> View Subscriptions ({subscriptions.length})
                </button>
              )}
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h3 className="text-sm font-semibold text-gray-900 mb-3">Quick Summary</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-slate-500">Contract Value</span><span className="font-medium">{formatDisplayCurrency(contract.total_value ?? contract.value, contract.currency)}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Total Invoiced</span><span className="font-medium">{formatDisplayCurrency(totalInvoiceValue, contract.currency)}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Paid</span><span className="font-medium text-emerald-600">{formatDisplayCurrency(paidValue, contract.currency)}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Outstanding</span><span className="font-medium text-amber-600">{formatDisplayCurrency(outstandingValue, contract.currency)}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Invoices</span><span className="font-medium">{totalInvoices} ({outstandingInvoices.length} outstanding)</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Subscriptions</span><span className="font-medium">{subscriptions.length}</span></div>
              <div className="flex justify-between text-base font-bold text-slate-800 border-t border-slate-200 pt-2 mt-2">
                <span>Term</span><span>{formatDisplayDate(contract.start_date)} — {formatDisplayDate(contract.end_date) || "Ongoing"}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {showRenewModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowRenewModal(false)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Renew Contract</h3>
            <p className="text-sm text-gray-500 mb-4">Set the new end date for contract renewal.</p>
            <div className="space-y-3 mb-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">New End Date</label>
                <input type="date" value={renewForm.new_end_date}
                  onChange={(e) => setRenewForm((f) => ({ ...f, new_end_date: e.target.value }))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                {renewForm.new_end_date && contract.end_date && new Date(renewForm.new_end_date) <= new Date(contract.end_date) && (
                  <p className="text-xs text-red-500 mt-1">New end date must be later than the current end date ({formatDisplayDate(contract.end_date)}).</p>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowRenewModal(false)}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200">Cancel</button>
              <button onClick={handleRenew} disabled={!renewForm.new_end_date || (contract.end_date && new Date(renewForm.new_end_date) <= new Date(contract.end_date)) || isActing("renew")}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50">
                {isActing("renew") ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />} Renew
              </button>
            </div>
          </div>
        </div>
      )}

      {showTerminateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowTerminateModal(false)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Terminate Contract</h3>
            <p className="text-sm text-gray-500 mb-4">Provide a reason for terminating this contract.</p>
            <textarea value={terminateReason} onChange={(e) => setTerminateReason(e.target.value)}
              rows={3} placeholder="Reason for termination..."
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30 mb-4" />
            <div className="flex justify-end gap-3">
              <button onClick={() => { setShowTerminateModal(false); setTerminateReason(""); }}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200">Cancel</button>
              <button onClick={handleTerminate} disabled={!terminateReason.trim() || isActing("terminate")}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50">
                {isActing("terminate") ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />} Terminate
              </button>
            </div>
          </div>
        </div>
      )}

      {showAmendmentModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowAmendmentModal(false)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-gray-900 mb-2">Create Amendment</h3>
            <p className="text-sm text-gray-500 mb-4">Record a new amendment for this contract.</p>
            <div className="space-y-3 mb-4">
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Effective Date</label>
                <input type="date" value={amendmentForm.effective_date}
                  onChange={(e) => setAmendmentForm((f) => ({ ...f, effective_date: e.target.value }))}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Reason</label>
                <textarea value={amendmentForm.reason} onChange={(e) => setAmendmentForm((f) => ({ ...f, reason: e.target.value }))}
                  rows={3} placeholder="Reason for amendment..."
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => { setShowAmendmentModal(false); setAmendmentForm({ effective_date: new Date().toISOString().split("T")[0], reason: "" }); }}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200">Cancel</button>
              <button onClick={handleCreateAmendment} disabled={!amendmentForm.effective_date || isActing("create amendment")}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50">
                {isActing("create amendment") ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileEdit className="h-4 w-4" />} Create Amendment
              </button>
            </div>
          </div>
        </div>
      )}
    </HRPage>
  );
}