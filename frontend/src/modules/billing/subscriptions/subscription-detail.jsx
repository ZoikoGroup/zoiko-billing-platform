import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, Repeat, RefreshCw, AlertCircle, Loader2, Play, XCircle, FileText, FileText as FileTextIcon, DollarSign, DollarSign as DollarSignIcon, CreditCard, Calendar, Receipt, Shield as ShieldIcon, Activity, Package, Building2, Clock, FileEdit, History, RotateCcw as RotateCcwIcon, CheckCircle, PauseCircle, AlertTriangle } from "lucide-react";
import HRPage from "../../../components/HRPage";
import { subscriptionApi, contractApi, customerApi, invoiceApi, paymentApi, auditApi } from "../../../service/billingService";
import { formatDisplayCurrency, formatDisplayDate, extractArray } from "../../../utils/billing-helpers";
import { useTerminology } from "../utils/TerminologyContext";

const STATUS_STYLES = {
  active: "bg-emerald-100 text-emerald-700",
  paused: "bg-amber-100 text-amber-700",
  past_due: "bg-red-100 text-red-700",
  cancelled: "bg-slate-100 text-slate-500",
  expired: "bg-slate-100 text-slate-700",
};

function StatusBadge({ status }) {
  const s = STATUS_STYLES[status] || "bg-slate-100 text-slate-600";
  const icons = { active: CheckCircle, paused: PauseCircle, past_due: AlertTriangle, cancelled: XCircle, expired: Clock };
  const Icon = icons[status] || Clock;
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium ${s}`}>
      <Icon size={12} /> {status ? status.charAt(0).toUpperCase() + status.slice(1) : "Unknown"}
    </span>
  );
}

const TABS = [
  { key: "overview", label: "Overview", icon: FileTextIcon },
  { key: "customer", label: "Customer", icon: Building2 },
  { key: "contract", label: "Contract", icon: FileText },
  { key: "products", label: "Products", icon: Package },
  { key: "pricing", label: "Pricing", icon: DollarSignIcon },
  { key: "billing", label: "Billing Schedule", icon: Calendar },
  { key: "invoices", label: "Invoices", icon: Receipt },
  { key: "payments", label: "Payments", icon: DollarSignIcon },
  { key: "timeline", label: "Timeline", icon: Clock },
  { key: "notes", label: "Notes", icon: FileEdit },
  { key: "activity", label: "Activity", icon: Activity },
  { key: "audit", label: "Audit", icon: ShieldIcon },
];

function TabNav({ tabs, active, onChange }) {
  return (
    <nav className="flex gap-0 border-b border-slate-200 overflow-x-auto">
      {tabs.map((tab) => {
        const Icon = tab.icon;
        return (
          <button key={tab.key} onClick={() => onChange(tab.key)}
            className={`inline-flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
              active === tab.key ? "border-brand-600 text-brand-600" : "border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300"
            }`}>            <Icon className="h-4 w-4" /> {tab.label}
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

function KpiCard({ label, value, sub, color, icon: Icon }) {
  return (
    <div className="bg-white rounded-3xl border border-slate-200 p-5 min-w-0 overflow-hidden">
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs font-medium text-slate-500 uppercase tracking-wider truncate">{label}</p>
        {Icon && <Icon size={16} className="text-slate-300 shrink-0" />}
      </div>
      <p className={`text-xl font-bold whitespace-nowrap ${color || "text-slate-900"}`} title={typeof value === 'string' ? value : undefined}>{value}</p>
      {sub && <p className="text-xs text-slate-500 mt-0.5 truncate">{sub}</p>}
    </div>
  );
}

export default function SubscriptionDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { singular } = useTerminology();

  const [subscription, setSubscription] = useState(null);
  const [customer, setCustomer] = useState(null);
  const [contract, setContract] = useState(null);
  const [invoiceList, setInvoiceList] = useState([]);
  const [paymentList, setPaymentList] = useState([]);
  const [events, setEvents] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);
  const [activeTab, setActiveTab] = useState("overview");
  const [showChangePlan, setShowChangePlan] = useState(false);
  const [availablePlans, setAvailablePlans] = useState([]);
  const [changePlanLoading, setChangePlanLoading] = useState(false);
  const [selectedNewPlanId, setSelectedNewPlanId] = useState(null);
  const [showGenerateInvoice, setShowGenerateInvoice] = useState(false);
  const [generateInvoiceLoading, setGenerateInvoiceLoading] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [showPauseModal, setShowPauseModal] = useState(false);

  const fetchSubscription = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const [subData, eventsData] = await Promise.all([
        subscriptionApi.get(id),
        subscriptionApi.listEvents(id, null, 50).catch(() => []),
      ]);
      setSubscription(subData);
      setEvents(extractArray(eventsData));

      if (subData.customer_id) {
        customerApi.get(subData.customer_id).then(setCustomer).catch((err) => console.error("[SubDetail] Failed to load customer:", err));
      }

      if (subData.contract_id) {
        contractApi.get(subData.contract_id).then(setContract).catch((err) => console.error("[SubDetail] Failed to load contract:", err));
      }

      invoiceApi.list({ subscription_id: id, per_page: 20 }).then((d) => setInvoiceList(extractArray(d))).catch((err) => console.error("[SubDetail] Failed to load invoices:", err));
      paymentApi.list({ subscription_id: id, per_page: 20 }).then((d) => setPaymentList(extractArray(d))).catch((err) => console.error("[SubDetail] Failed to load payments:", err));
      auditApi.list({ resource_type: "subscription", resource_id: id, per_page: 20 }).then((d) => setAuditLogs(extractArray(d))).catch((err) => console.error("[SubDetail] Failed to load audit logs:", err));
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to load subscription");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [id]);

  useEffect(() => { fetchSubscription(); }, [fetchSubscription]);

  async function handleAction(action, actionFn) {
    try {
      setActionLoading(action);
      setError(null);
      await actionFn();
      await fetchSubscription({ silent: true });
    } catch (err) {
      setError(err?.detail || err?.message || `Failed to ${action} subscription`);
    } finally {
      setActionLoading(null);
    }
  }

  if (loading) {
    return (
      <HRPage title="Subscription Detail" subtitle="Loading subscription details...">
        <div className="flex items-center justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-brand-600" /></div>
      </HRPage>
    );
  }

  if (error && !subscription) {
    return (
      <HRPage title="Subscription Detail" subtitle="Error loading subscription">
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <AlertCircle className="h-10 w-10 text-red-400 mb-3" />
          <p className="text-sm text-red-600 mb-3">{error}</p>
          <button onClick={fetchSubscription} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors">
            <RefreshCw className="h-4 w-4" /> Retry
          </button>
        </div>
      </HRPage>
    );
  }

  if (!subscription) {
    return (
      <HRPage title="Subscription Detail" subtitle="Subscription not found">
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Repeat className="h-10 w-10 text-slate-300 mb-3" />
          <p className="text-sm font-medium text-slate-500">Subscription not found</p>
        </div>
      </HRPage>
    );
  }

  const btnClass = "inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50";
  const isActing = (a) => actionLoading === a;

  const isActive = subscription.status === "active";
  const isPaused = subscription.status === "paused";
  const isPastDue = subscription.status === "past_due";
  const isExpired = subscription.status === "expired";
  const isCancelled = subscription.status === "cancelled";

  // Renew is allowed for ACTIVE (proactive early renewal) and EXPIRED (recovery)
  const canRenew = isActive || isExpired;

  const totalInvoices = invoiceList.length;
  const totalInvoiceValue = invoiceList.reduce((s, inv) => s + parseFloat(inv.total_amount || 0), 0);
  const paidInvoices = invoiceList.filter((inv) => inv.status === "paid");
  const paidValue = paidInvoices.reduce((s, inv) => s + parseFloat(inv.paid_amount || 0), 0);
  const outstandingInvoices = invoiceList.filter((inv) => inv.status === "sent" || inv.status === "overdue" || inv.status === "partially_paid");
  const outstandingValue = outstandingInvoices.reduce((s, inv) => s + parseFloat(inv.balance_due || 0), 0);

  const totalPayments = paymentList.length;
  const totalPaymentAmount = paymentList.reduce((s, pay) => s + parseFloat(pay.amount || 0), 0);

  const renderOverview = () => (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard label="Plan" value={subscription.plan_name || subscription.plan?.name || "—"} color="text-slate-900" icon={CreditCard} />
        <KpiCard label="Next Billing" value={formatDisplayDate(subscription.next_billing_at)} color="text-slate-900" icon={Calendar} />
        <KpiCard label="Amount" value={formatDisplayCurrency(subscription.amount ?? subscription.unit_price)} color="text-slate-900" />
        <KpiCard label="Status" value={<StatusBadge status={subscription.status} />} color="text-slate-900" />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-3xl border border-slate-200 p-5">
          <h3 className="text-sm font-semibold text-slate-900 mb-3">Subscription Information</h3>
          <div className="space-y-3">
            <InfoRow label="Subscription Number" value={subscription.subscription_number} />
            <InfoRow label={singular} value={subscription.customer_name || `${singular} #${subscription.customer_id}`} />
            <InfoRow label="Plan" value={subscription.plan_name || `Plan #${subscription.plan_id}`} />
            <InfoRow label="Currency" value={subscription.currency || "—"} />
            <InfoRow label="Start Date" value={formatDisplayDate(subscription.start_date)} />
            <InfoRow label="Current Term" value={`${formatDisplayDate(subscription.current_term_start)} — ${formatDisplayDate(subscription.current_term_end)}`} />
          </div>
        </div>

        <div className="bg-white rounded-3xl border border-slate-200 p-5">
          <h3 className="text-sm font-semibold text-slate-900 mb-3">Financial Summary</h3>
          <div className="space-y-3">
            <InfoRow label="Monthly Amount" value={formatDisplayCurrency(subscription.amount || subscription.unit_price)} />
            <InfoRow label="Quantity" value={subscription.quantity} />
            <InfoRow label="Setup Fee" value={subscription.setup_fee > 0 ? formatDisplayCurrency(subscription.setup_fee) : "—"} />
            <InfoRow label="Total Invoiced" value={formatDisplayCurrency(totalInvoiceValue)} />
            <InfoRow label="Paid" value={formatDisplayCurrency(paidValue)} />
            <InfoRow label="Outstanding" value={formatDisplayCurrency(outstandingValue)} />
          </div>
        </div>

        <div className="bg-white rounded-3xl border border-slate-200 p-5">
          <h3 className="text-sm font-semibold text-slate-900 mb-3">Subscription Status</h3>
          <div className="space-y-2">
            {isActive && (
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-emerald-500" />
                <span className="text-sm text-slate-600">Active subscription</span>
              </div>
            )}
            {isPaused && (
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-amber-500" />*
                <span className="text-sm text-slate-600">Paused by customer</span>
              </div>
            )}
            {isPastDue && (
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-red-500" />*
                <span className="text-sm text-slate-600">Past due - action required</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {(isActive || isPaused) && (
        <div className="bg-brand-50 border border-brand-200 rounded-xl p-4 text-sm text-brand-700 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />*
          {isActive ? "Subscription is active and will bill on your next billing date." : "Subscription is paused. Resume billing to reactivate."}
        </div>
      )}
    </div>
  );

  const renderCustomer = () => (
    <div className="bg-white rounded-3xl border border-slate-200 p-6">
      <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2"><Building2 size={16} className="text-brand-500" /> {singular} Details</h3>
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
            <InfoRow label="Currency" value={customer.currency} />
            <InfoRow label="Payment Terms" value={customer.payment_terms?.replace(/_/g, " ")} />
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
        <div className="text-center py-8 text-slate-500">
          <Building2 size={32} className="mx-auto mb-2 text-slate-300" />
          <p className="text-sm">{singular} details not available</p>
          <p className="text-xs text-slate-500 mt-1">{singular} #{subscription.customer_id}</p>
        </div>
      )}
    </div>
  );

  const renderContract = () => {
    if (!contract) {
      return (
        <div className="bg-white rounded-3xl border border-slate-200 p-6">
          <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2"><FileText size={16} className="text-brand-500" /> Contract</h3>
          <div className="text-center py-8 text-slate-500">
            <FileText size={32} className="mx-auto mb-2 text-slate-300" />
            <p className="text-sm">No contract linked to this subscription</p>
            <p className="text-xs text-slate-500 mt-1">Contract ID: {subscription.contract_id}</p>
          </div>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <div className="bg-white rounded-3xl border border-slate-200 p-5">
          <h3 className="text-sm font-semibold text-slate-900 mb-3">Contract Information</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Contract</p>
              <p className="text-lg font-bold text-slate-900 mt-1">{contract.contract_number}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Status</p>
              <div className="mt-2"><StatusBadge status={contract.status} /></div>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Value</p>
              <p className="text-lg font-bold text-slate-900 mt-1">{formatDisplayCurrency(contract.total_value ?? contract.value)}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Start Date</p>
              <p className="text-lg font-bold text-slate-900 mt-1">{formatDisplayDate(contract.start_date)}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">End Date</p>
              <p className="text-lg font-bold text-slate-900 mt-1">{formatDisplayDate(contract.end_date) || "Ongoing"}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Auto Renew</p>
              <p className="text-lg font-bold text-slate-900 mt-1">{contract.auto_renew ? "Yes" : "No"}</p>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-3xl border border-slate-200 p-5">
          <h3 className="text-sm font-semibold text-slate-900 mb-3">Contract Details</h3>
          <div className="grid grid-cols-2 gap-4">
            <InfoRow label="Contract Name" value={contract.contract_name} />
            <InfoRow label={`${singular} ID`} value={contract.customer_id} />
            <InfoRow label="Currency" value={contract.currency} />
            <InfoRow label={`Signed By ${singular}`} value={contract.signed_by_customer ? "Yes" : "No"} />
            <InfoRow label="Signed By Organization" value={contract.signed_by_org ? "Yes" : "No"} />
            <InfoRow label="Signed At" value={formatDisplayDate(contract.signed_at)} />
            <InfoRow label="Notice Period" value={`${contract.notice_period_days} days`} />
          </div>
        </div>
      </div>
    );
  };

  const renderProducts = () => (
    <div className="bg-white rounded-3xl border border-slate-200 p-6">
      <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2"><Package size={16} className="text-brand-500" /> Subscription Products</h3>
      <div className="space-y-3">
        {subscription.plan_name && (
          <div className="p-4 bg-slate-50 rounded-lg">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium text-slate-800">Plan: {subscription.plan_name}</p>
                <p className="text-sm text-slate-500">Plan ID: {subscription.plan_id}</p>
              </div>
              <div className="text-right">
                <p className="font-medium text-slate-800">{formatDisplayCurrency(subscription.unit_price || subscription.amount)} per period</p>
                <p className="text-sm text-slate-500">Quantity: {subscription.quantity}</p>
              </div>
            </div>
          </div>
        )}
        {subscription.setup_fee > 0 && (
          <div className="p-4 bg-slate-50 rounded-lg">
            <p className="font-medium text-slate-800">Setup Fee: {formatDisplayCurrency(subscription.setup_fee)}</p>
          </div>
        )}
        {(subscription.discount_percentage || subscription.tax_percentage) && (
          <div className="p-4 bg-slate-50 rounded-lg space-y-2">
            {(subscription.discount_percentage || subscription.tax_percentage) && (
              <div className="flex items-center gap-4">
                {subscription.discount_percentage && (
                  <div>
                    <p className="text-sm text-slate-500">Discount</p>
                    <p className="font-medium text-slate-800">{subscription.discount_percentage}%</p>
                  </div>
                )}
                {subscription.tax_percentage && (
                  <div>
                    <p className="text-sm text-slate-500">Tax</p>
                    <p className="font-medium text-slate-800">{subscription.tax_percentage}%</p>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );

  const renderPricing = () => (
    <div className="bg-white rounded-3xl border border-slate-200 p-6">
      <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2"><DollarSign size={16} className="text-brand-500" /> Pricing Breakdown</h3>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <InfoRow label="Unit Price" value={formatDisplayCurrency(subscription.unit_price || subscription.amount, subscription.currency)} />
        <InfoRow label="Setup Fee" value={subscription.setup_fee > 0 ? formatDisplayCurrency(subscription.setup_fee, subscription.currency) : "—"} />
        <InfoRow label="Discount" value={subscription.discount_percentage ? `${subscription.discount_percentage}%` : "—"} />
        <InfoRow label="Tax Percentage" value={subscription.tax_percentage ? `${subscription.tax_percentage}%` : "—"} />
        <InfoRow label="Quantity" value={subscription.quantity} />
        <InfoRow label="Currency" value={subscription.currency || "—"} />
      </div>
    </div>
  );

  const renderBilling = () => (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-3xl border border-slate-200 p-5">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Billing Period</p>
          <p className="text-lg font-bold text-slate-900 mt-1 capitalize">{subscription.plan?.billing_period?.replace(/_/g, " ") || subscription.billing_period?.replace(/_/g, " ")}</p>
        </div>
        <div className="bg-white rounded-3xl border border-slate-200 p-5">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Next Billing Date</p>
          <p className="text-lg font-bold text-slate-900 mt-1">{formatDisplayDate(subscription.next_billing_at)}</p>
        </div>
        <div className="bg-white rounded-3xl border border-slate-200 p-5">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Current Term</p>
          <p className="text-lg font-bold text-slate-900 mt-1">{formatDisplayDate(subscription.current_term_start)} — {formatDisplayDate(subscription.current_term_end)}</p>
        </div>
        <div className="bg-white rounded-3xl border border-slate-200 p-5">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Trial End Date</p>
          <p className="text-lg font-bold text-slate-900 mt-1">{formatDisplayDate(subscription.trial_end_date) || "—"}</p>
        </div>
        <div className="bg-white rounded-3xl border border-slate-200 p-5">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Next Billing Amount</p>
          <p className="text-lg font-bold text-slate-900 mt-1 whitespace-nowrap">{formatDisplayCurrency(subscription.amount ?? subscription.unit_price * subscription.quantity, subscription.currency)}</p>
        </div>
        <div className="bg-white rounded-3xl border border-slate-200 p-5">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Auto Renew</p>
          <p className="text-lg font-bold text-slate-900 mt-1">{subscription.auto_renew ? "Yes" : "No"}</p>
        </div>
      </div>

      {subscription.auto_renew && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-sm text-emerald-700 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          This subscription will auto-renew based on contract renewal terms.
        </div>
      )}
    </div>
  );

  const renderInvoices = () => (
    <div className="bg-white rounded-3xl border border-slate-200 p-6">
      <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2"><Receipt size={16} className="text-brand-500" /> Invoices ({invoiceList.length})</h3>
      {invoiceList.length === 0 ? (
        <div className="text-center py-8 text-slate-500">
          <Receipt size={32} className="mx-auto mb-2 text-slate-300" />
          <p className="text-sm">No invoices generated yet</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead>
              <tr className="text-xs font-medium text-slate-500 uppercase tracking-wider">
                <th className="text-left py-3 px-4">Invoice</th>
                <th className="text-left py-3 px-4">Date</th>
                <th className="text-right py-3 px-4">Amount</th>
                <th className="text-right py-3 px-4">Paid</th>
                <th className="text-right py-3 px-4">Balance</th>
                <th className="text-left py-3 px-4">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {invoiceList.map((inv) => (
                <tr key={inv.id} onClick={() => navigate(`/billing/invoices/${inv.id}`)} className="text-sm text-slate-900 hover:bg-slate-50 cursor-pointer">
                  <td className="py-3 px-4 font-medium">{inv.invoice_number || `#${inv.id}`}</td>
                  <td className="py-3 px-4 whitespace-nowrap">{formatDisplayDate(inv.issue_date)}</td>
                  <td className="py-3 px-4 text-right font-medium">{formatDisplayCurrency(inv.total_amount, inv.currency)}</td>
                  <td className="py-3 px-4 text-right text-emerald-700">{formatDisplayCurrency(inv.paid_amount, inv.currency)}</td>
                  <td className="py-3 px-4 text-right text-amber-600 font-medium">{formatDisplayCurrency(inv.balance_due, inv.currency)}</td>
                  <td className="py-3 px-4">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                      inv.status === "paid" ? "bg-emerald-100 text-emerald-700" :
                      inv.status === "overdue" ? "bg-red-100 text-red-700" :
                      inv.status === "partially_paid" ? "bg-amber-100 text-amber-700" :
                      inv.status === "sent" ? "bg-blue-100 text-blue-700" :
                      "bg-slate-100 text-slate-600"
                    }`}>{inv.status?.replace(/_/g, " ")}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  const renderPayments = () => (
    <div className="bg-white rounded-3xl border border-slate-200 p-6">
      <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2"><DollarSignIcon size={16} className="text-brand-500" /> Payments ({paymentList.length})</h3>
      {paymentList.length === 0 ? (
        <div className="text-center py-8 text-slate-500">
          <DollarSignIcon size={32} className="mx-auto mb-2 text-slate-300" />
          <p className="text-sm">No payments recorded yet</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead>
              <tr className="text-xs font-medium text-slate-500 uppercase tracking-wider">
                <th className="text-left py-3 px-4">Payment</th>
                <th className="text-left py-3 px-4">Date</th>
                <th className="text-left py-3 px-4">Method</th>
                <th className="text-right py-3 px-4">Amount</th>
                <th className="text-left py-3 px-4">Status</th>
                <th className="text-left py-3 px-4">Transaction ID</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {paymentList.map((pay) => (
                <tr key={pay.id} onClick={() => navigate(`/billing/payments/${pay.id}`)} className="text-sm text-slate-900 hover:bg-slate-50 cursor-pointer">
                  <td className="py-3 px-4 font-medium">{pay.payment_number || `#${pay.id}`}</td>
                  <td className="py-3 px-4 whitespace-nowrap">{formatDisplayDate(pay.payment_date)}</td>
                  <td className="py-3 px-4 text-slate-600 capitalize">{pay.payment_type?.replace(/_/g, " ") || pay.payment_method || "—"}</td>
                  <td className="py-3 px-4 text-right font-medium">{formatDisplayCurrency(pay.amount, pay.currency)}</td>
                  <td className="py-3 px-4"><StatusBadge status={pay.status} /></td>
                  <td className="py-3 px-4 text-slate-500 text-xs">{pay.transaction_id || pay.gateway_transaction_id || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  const renderTimeline = () => {
    const items = [];
    // Events already reported by the API for these lifecycle moments must
    // not be duplicated by the synthetic field-derived entries below.
    const eventTypesPresent = new Set(events.map((evt) => String(evt.event_type || "").toLowerCase()));
    events.forEach((evt) => {
      const d = evt.created_at || evt.timestamp;
      if (!d) return;
      const type = evt.event_type || "event";
      const iconMap = {
        created: { icon: Play, color: "bg-brand-500" },
        activated: { icon: Play, color: "bg-emerald-500" },
        paused: { icon: PauseCircle, color: "bg-amber-500" },
        cancelled: { icon: XCircle, color: "bg-red-500" },
        plan_changed: { icon: CreditCard, color: "bg-blue-500" },
        renewed: { icon: RotateCcwIcon, color: "bg-emerald-500" },
        past_due: { icon: AlertTriangle, color: "bg-red-500" },
      };
      const mapped = iconMap[type] || { icon: History, color: "bg-slate-500" };
      items.push({
        date: d,
        label: type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        description: evt.description || evt.reason || null,
        icon: mapped.icon,
        color: mapped.color,
      });
    });
    if (!eventTypesPresent.has("created")) {
      items.push({ date: subscription.created_at, label: "Subscription created", description: null, icon: Play, color: "bg-brand-500" });
    }
    if (subscription.trial_end_date) {
      items.push({ date: subscription.trial_end_date, label: `Trial ends ${formatDisplayDate(subscription.trial_end_date)}`, description: null, icon: Clock, color: "bg-blue-500" });
    }
    if (subscription.current_term_start) {
      items.push({ date: subscription.current_term_start, label: `Billing started ${formatDisplayDate(subscription.current_term_start)}`, description: null, icon: Calendar, color: "bg-emerald-500" });
    }
    if (subscription.next_billing_at) {
      items.push({ date: subscription.next_billing_at, label: `Next billing ${formatDisplayDate(subscription.next_billing_at)}`, description: null, icon: CreditCard, color: "bg-brand-500" });
    }
    if (subscription.status === "paused" && subscription.paused_at && !eventTypesPresent.has("paused")) {
      items.push({ date: subscription.paused_at, label: `Paused on ${formatDisplayDate(subscription.paused_at)}`, description: null, icon: PauseCircle, color: "bg-amber-500" });
    }
    if (subscription.status === "cancelled" && subscription.cancelled_at && !eventTypesPresent.has("cancelled")) {
      items.push({ date: subscription.cancelled_at, label: `Cancelled on ${formatDisplayDate(subscription.cancelled_at)}`, description: null, icon: XCircle, color: "bg-red-500" });
    }
    if (subscription.status === "past_due" && subscription.current_term_start && !eventTypesPresent.has("past_due")) {
      items.push({ date: subscription.current_term_start, label: `Past due since ${formatDisplayDate(subscription.current_term_start)}`, description: null, icon: AlertTriangle, color: "bg-red-500" });
    }
    items.sort((a, b) => new Date(b.date) - new Date(a.date));

    return (
      <div className="bg-white rounded-3xl border border-slate-200 p-6">
        <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2"><Clock size={16} className="text-brand-500" /> Subscription Timeline ({items.length})</h3>
        <div className="space-y-4">
          {items.map((ev, i) => (
            <div key={i} className="flex gap-3">
              <div className={`w-8 h-8 rounded-full ${ev.color} text-white flex items-center justify-center flex-shrink-0 mt-0.5`}>                <ev.icon size={14} />
              </div>
              <div>
                <p className="text-sm font-medium text-slate-800">{ev.label}</p>
                <p className="text-xs text-slate-500">{formatDisplayDate(ev.date)}{ev.description ? ` · ${ev.description}` : ""}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderNotes = () => (
    <div className="space-y-6">
      {subscription.notes && (
        <div className="bg-white rounded-3xl border border-slate-200 p-6">
          <h3 className="text-sm font-semibold text-slate-900 mb-2 flex items-center gap-2"><FileEdit size={16} className="text-brand-500" /> Notes</h3>
          <p className="text-sm text-slate-700 whitespace-pre-wrap">{subscription.notes}</p>
        </div>
      )}
      {!subscription.notes && (
        <div className="text-center py-8 text-slate-500">
          <FileEdit size={32} className="mx-auto mb-2 text-slate-300" />
          <p className="text-sm">No notes for this subscription</p>
        </div>
      )}
    </div>
  );

  const renderActivity = () => (
    <div className="space-y-4">
      {events.length === 0 ? (
        <div className="bg-white rounded-3xl border border-slate-200 p-6">
          <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2"><Activity size={16} className="text-brand-500" /> Recent Activity</h3>
          <div className="text-center py-8 text-slate-500">
            <Activity size={32} className="mx-auto mb-2 text-slate-300" />
            <p className="text-sm">No activity recorded</p>
          </div>
        </div>
      ) : (
        <div className="bg-white rounded-3xl border border-slate-200 p-6">
          <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2"><Activity size={16} className="text-brand-500" /> Recent Activity ({events.length} events)</h3>
          <div className="space-y-2">
            {events.slice(0, 10).map((evt, i) => (
              <div key={evt.id || i} className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                  evt.status === "active" || evt.event_type === "created" ? "bg-brand-100 text-brand-600" :
                  evt.status === "paused" ? "bg-amber-100 text-amber-600" :
                  evt.status === "cancelled" ? "bg-red-100 text-red-600" :
                  "bg-slate-100 text-slate-600"
                }`}>                  {evt.event_type === "created" && <Play size={14} />}
                  {evt.event_type === "paused" && <PauseCircle size={14} />}
                  {evt.event_type === "activated" && <Play size={14} />}
                  {evt.event_type === "cancelled" && <XCircle size={14} />}
                  {evt.event_type === "plan_changed" && <CreditCard size={14} />}
                  {evt.event_type === "renewed" && <RotateCcwIcon size={14} />}
                  {evt.event_type === "past_due" && <AlertTriangle size={14} />}
                  {!["created", "paused", "activated", "cancelled", "plan_changed", "renewed", "past_due"].includes(evt.event_type) && <History size={14} />}
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium text-slate-800 capitalize">{evt.event_type}</p>
                  <p className="text-xs text-slate-500">{evt.description || evt.reason || "—"}</p>
                </div>
                <span className="text-xs text-slate-500 whitespace-nowrap">{formatDisplayDate(evt.created_at || evt.timestamp)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  const renderAudit = () => (
    <div className="bg-white rounded-3xl border border-slate-200 p-6">
      <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2"><ShieldIcon size={16} className="text-brand-500" /> Audit Trail</h3>
      {auditLogs.length === 0 ? (
        <div className="text-center py-8 text-slate-500">
          <ShieldIcon size={32} className="mx-auto mb-2 text-slate-300" />
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
                      log.action === "cancelled" ? "bg-red-100 text-red-700" :
                      log.action === "paused" ? "bg-amber-100 text-amber-700" :
                      log.action === "activated" ? "bg-emerald-100 text-emerald-700" :
                      "bg-slate-100 text-slate-600"
                    }`}>{log.action || log.event_type || "—"}</span>
                  </td>
                  <td className="py-3 px-4 text-slate-600">{log.user_name || log.user_id || log.performed_by || "—"}</td>
                  <td className="py-3 px-4 text-slate-500 max-w-xs truncate">{log.details || log.description || log.message || "—"}</td>
                  <td className="py-3 px-4 text-slate-500 whitespace-nowrap">{formatDisplayDate(log.created_at || log.timestamp)}</td>
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
      case "customer": return renderCustomer();
      case "contract": return renderContract();
      case "products": return renderProducts();
      case "pricing": return renderPricing();
      case "billing": return renderBilling();
      case "invoices": return renderInvoices();
      case "payments": return renderPayments();
      case "timeline": return renderTimeline();
      case "notes": return renderNotes();
      case "activity": return renderActivity();
      case "audit": return renderAudit();
      default: return renderOverview();
    }
  };

  return (
    <HRPage
      title={`Subscription ${subscription.subscription_number || `#${id}`}`}
      subtitle={<StatusBadge status={subscription.status} />}
      actions={
        <div className="flex items-center gap-2">
          <button onClick={() => navigate("/billing/subscriptions")} className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors">
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
          <div className="bg-white rounded-3xl border border-slate-200 p-6">
            <h3 className="text-sm font-semibold text-slate-900 mb-4">Quick Summary</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-slate-500">Subscription</span><span className="font-medium text-slate-800">{subscription.subscription_number || `#${id}`}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Plan</span><span className="font-medium text-slate-800">{subscription.plan_name || `Plan #${subscription.plan_id}`}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Next Billing</span><span className="font-medium text-brand-600">{formatDisplayDate(subscription.next_billing_at)}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Amount</span><span className="font-medium text-slate-800">{formatDisplayCurrency(subscription.amount || subscription.unit_price, subscription.currency)}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Invoices</span><span className="font-medium text-slate-800">{totalInvoices} ({paidValue > 0 ? paidValue : "—"} paid)</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Payments</span><span className="font-medium text-slate-800">{totalPaymentAmount > 0 ? formatDisplayCurrency(totalPaymentAmount, subscription.currency) : "—"}</span></div>
              <div className="flex justify-between text-base font-bold text-slate-800 border-t border-slate-200 pt-2 mt-2">
                <span>Auto Renew</span><span className="text-emerald-700">{subscription.auto_renew ? "Yes" : "No"}</span>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-3xl border border-slate-200 p-6">
            <h3 className="text-sm font-semibold text-slate-900 mb-3">Actions</h3>
            <div className="space-y-3">
{subscription.status === "active" && (
                <>
                  <button onClick={() => setShowPauseModal(true)} disabled={isActing("pause")}
                      className={`${btnClass} w-full text-amber-700 bg-amber-50 hover:bg-amber-100`}>                    {isActing("pause") ? <Loader2 className="h-4 w-4 animate-spin" /> : <PauseCircle className="h-4 w-4" />}
                      Pause Subscription
                    </button>
                  <button onClick={async () => {
                      setSelectedNewPlanId(null);
                      setShowChangePlan(true);
                      setChangePlanLoading(true);
                      try {
                        const data = await subscriptionApi.listPlans({ per_page: 50 });
                        setAvailablePlans(extractArray(data).filter((p) => p.is_active && p.id !== subscription.plan_id));
                      } catch { setAvailablePlans([]); }
                      finally { setChangePlanLoading(false); }
                    }}
                      className={`${btnClass} w-full text-brand-700 bg-brand-50 hover:bg-brand-100`}>                    <CreditCard className="h-4 w-4" /> Change Plan
                    </button>
                  <button onClick={() => setShowGenerateInvoice(true)} disabled={generateInvoiceLoading}
                      className={`${btnClass} w-full text-emerald-700 bg-emerald-50 hover:bg-emerald-100`}>                    {generateInvoiceLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                      Generate Invoice
                    </button>
                </>
              )}
              {subscription.status === "paused" && (
                <button onClick={() => handleAction("resume", () => subscriptionApi.resume(id))} disabled={isActing("resume")}
                  className={`${btnClass} w-full text-white bg-emerald-600 hover:bg-emerald-700`}>                  {isActing("resume") ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                  Resume Subscription
                </button>
              )}

              {(subscription.status === "active" || subscription.status === "paused" || subscription.status === "past_due") && (
                <button onClick={() => setShowCancelModal(true)} disabled={isActing("cancel")}
                  className={`${btnClass} w-full text-red-700 bg-red-50 hover:bg-red-100`}>                  {isActing("cancel") ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                  Cancel Subscription
                </button>
              )}

              {subscription.status === "past_due" && (
                <button onClick={() => handleAction("activate", () => subscriptionApi.activate(id))} disabled={isActing("activate")}
                  className={`${btnClass} w-full text-white bg-emerald-600 hover:bg-emerald-700`}>                  {isActing("activate") ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                  Reactivate Subscription
                </button>
              )}

              {subscription.contract_id && (
                <button onClick={() => navigate(`/billing/contracts/${subscription.contract_id}`)}
                  className={`${btnClass} w-full text-brand-700 bg-brand-50 hover:bg-brand-100`}>                  <FileText className="h-4 w-4" /> View Contract
                </button>
              )}

              {subscription.customer_id && (
                <button onClick={() => navigate(`/billing/customers/${subscription.customer_id}`)}
                  className={`${btnClass} w-full text-blue-700 bg-blue-50 hover:bg-blue-100`}>                  <Building2 className="h-4 w-4" /> View {singular}
                </button>
              )}

              {canRenew && (
                <button onClick={() => handleAction("renew", () => subscriptionApi.renew(id))}
                  disabled={isActing("renew")}
                  className={`${btnClass} w-full text-indigo-700 bg-indigo-50 hover:bg-indigo-100`}>
                  {isActing("renew") ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcwIcon className="h-4 w-4" />}
                  {isExpired ? "Renew Expired Subscription" : "Renew Subscription"}
                </button>
              )}
            </div>
          </div>

          <div className="bg-white rounded-3xl border border-slate-200 p-6">
            <h3 className="text-sm font-semibold text-slate-900 mb-3">Subscription Health</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-slate-500">Status</span><StatusBadge status={subscription.status} /></div>
              <div className="flex justify-between"><span className="text-slate-500">Created</span><span className="font-medium">{formatDisplayDate(subscription.created_at)}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Next Payment</span><span className="font-medium">{formatDisplayDate(subscription.next_billing_at)}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Current Period</span><span className="font-medium">{formatDisplayDate(subscription.current_term_start)} — {formatDisplayDate(subscription.current_term_end)}</span></div>
            </div>
          </div>
        </div>
      </div>

      {showChangePlan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowChangePlan(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-slate-800 mb-1">Change Plan</h3>
            <p className="text-sm text-slate-500 mb-4">Current plan: <span className="font-medium text-slate-700">{subscription.plan_name || `Plan #${subscription.plan_id}`}</span></p>
            {changePlanLoading ? (
              <div className="flex items-center justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-brand-600" /></div>
            ) : availablePlans.length === 0 ? (
              <p className="text-sm text-slate-500 text-center py-8">No other active plans available.</p>
            ) : (
              <div className="space-y-2 max-h-60 overflow-y-auto mb-4">
                {availablePlans.map((plan) => (
                  <button key={plan.id} onClick={() => setSelectedNewPlanId(plan.id)}
                    className={`w-full text-left p-3 rounded-xl border transition-colors ${selectedNewPlanId === plan.id ? "border-brand-300 bg-brand-50" : "border-slate-200 hover:bg-slate-50"}`}>
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-medium text-slate-800">{plan.plan_name}</p>
                        <p className="text-xs text-slate-500">{plan.billing_period?.replace(/_/g, " ")} · {plan.pricing_model}</p>
                      </div>
                      <p className="font-semibold text-slate-800">{formatDisplayCurrency(plan.unit_price, subscription.currency)}</p>
                    </div>
                  </button>
                ))}
              </div>
            )}
            <p className="text-xs text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">Plan changes take effect immediately. Proration is not currently applied.</p>
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <button onClick={() => setShowChangePlan(false)} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg">Cancel</button>
              <button disabled={!selectedNewPlanId || changePlanLoading} onClick={async () => {
                  setChangePlanLoading(true);
                  try {
                    await subscriptionApi.changePlan(subscription.id, selectedNewPlanId);
                    setShowChangePlan(false);
                    await fetchSubscription({ silent: true });
                  } catch (err) {
                    setError(err?.detail || err?.message || "Failed to change plan");
                  } finally { setChangePlanLoading(false); }
                }}
                className="px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50">
                {changePlanLoading ? <Loader2 className="h-4 w-4 animate-spin inline" /> : "Confirm Change"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showGenerateInvoice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowGenerateInvoice(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-slate-800 mb-1">Generate Invoice</h3>
            <p className="text-sm text-slate-500 mb-4">Create an invoice for the current billing period.</p>
            <div className="space-y-3 mb-4 p-4 bg-slate-50 rounded-xl">
              <div className="flex justify-between"><span className="text-sm text-slate-500">Subscription</span><span className="font-medium text-slate-800">{subscription.subscription_number}</span></div>
              <div className="flex justify-between"><span className="text-sm text-slate-500">Plan</span><span className="font-medium text-slate-800">{subscription.plan_name || `Plan #${subscription.plan_id}`}</span></div>
              <div className="flex justify-between"><span className="text-sm text-slate-500">{singular}</span><span className="font-medium text-slate-800">{customer?.company_name || customer?.name || `ID: ${subscription.customer_id}`}</span></div>
              <div className="flex justify-between"><span className="text-sm text-slate-500">Billing Period</span><span className="font-medium text-slate-800">{formatDisplayDate(subscription.current_term_start)} — {formatDisplayDate(subscription.current_term_end)}</span></div>
              <div className="flex justify-between"><span className="text-sm text-slate-500">Currency</span><span className="font-medium text-slate-800">{subscription.currency}</span></div>
              <div className="flex justify-between"><span className="text-sm text-slate-500">Amount</span><span className="font-semibold text-emerald-700">{formatDisplayCurrency(subscription.unit_price * (subscription.quantity || 1), subscription.currency)}</span></div>
            </div>
            <p className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 mb-4">Tax will be applied based on customer billing country. Invoice number will be auto-generated.</p>
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <button onClick={() => setShowGenerateInvoice(false)} disabled={generateInvoiceLoading} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg disabled:opacity-50">Cancel</button>
              <button disabled={generateInvoiceLoading} onClick={async () => {
                  setGenerateInvoiceLoading(true);
                  try {
                    const result = await subscriptionApi.generateInvoice(subscription.id);
                    if (result?.invoice_id) {
                      setShowGenerateInvoice(false);
                      navigate(`/billing/invoices/${result.invoice_id}`);
                    }
                  } catch (err) {
                    setError(err?.detail || err?.message || "Failed to generate invoice");
                  } finally { setGenerateInvoiceLoading(false); }
                }}
                className="px-4 py-2 text-sm font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50">
                {generateInvoiceLoading ? <Loader2 className="h-4 w-4 animate-spin inline" /> : "Generate Invoice"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showPauseModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowPauseModal(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-slate-800 mb-1">Pause Subscription</h3>
            <p className="text-sm text-slate-500 mb-4">Are you sure you want to pause this subscription?</p>
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-4 text-sm text-amber-700">
              <p className="font-medium">This will:</p>
              <ul className="mt-1 list-disc list-inside space-y-0.5">
                <li>Stop billing for this subscription</li>
                <li>No new invoices will be generated</li>
                <li>The subscription can be resumed later</li>
              </ul>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <button onClick={() => setShowPauseModal(false)} disabled={isActing("pause")} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg disabled:opacity-50">Cancel</button>
              <button disabled={isActing("pause")} onClick={async () => { setShowPauseModal(false); await handleAction("pause", () => subscriptionApi.pause(id)); }}
                className="px-4 py-2 text-sm font-medium text-white bg-amber-600 rounded-lg hover:bg-amber-700 disabled:opacity-50">
                {isActing("pause") ? <Loader2 className="h-4 w-4 animate-spin inline" /> : "Pause Subscription"}
              </button>
            </div>
          </div>
        </div>
      )}

      {showCancelModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowCancelModal(false)}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 p-6" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-slate-800 mb-1">Cancel Subscription</h3>
            <p className="text-sm text-slate-500 mb-4">Are you sure you want to cancel this subscription?</p>
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-4 text-sm text-red-700">
              <p className="font-medium">This action is irreversible and will:</p>
              <ul className="mt-1 list-disc list-inside space-y-0.5">
                <li>Permanently cancel the subscription</li>
                <li>Stop all future billing</li>
                <li>Send a cancellation notification to the customer</li>
              </ul>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
              <button onClick={() => setShowCancelModal(false)} disabled={isActing("cancel")} className="px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-100 rounded-lg disabled:opacity-50">Go Back</button>
              <button disabled={isActing("cancel")} onClick={async () => { setShowCancelModal(false); await handleAction("cancel", () => subscriptionApi.cancel(id)); }}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50">
                {isActing("cancel") ? <Loader2 className="h-4 w-4 animate-spin inline" /> : "Cancel Subscription"}
              </button>
            </div>
          </div>
        </div>
      )}
    </HRPage>
  );
}