import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { ArrowLeft, FileSignature, RefreshCw, AlertCircle, Loader2, Send,
  CheckCircle, XCircle, Ban, RotateCcw, FileText, DollarSign, User,
  Package, CreditCard, Clock, Activity, FileEdit, Hash, Copy } from "lucide-react"
import HRPage from "../../../components/HRPage";
import { quoteApi, customerApi, contractApi } from "../../../service/billingService";
import { formatDisplayCurrency, formatDisplayDate } from "../../../utils/billing-helpers";
import { useCurrency } from "../utils/CurrencyContext";
import { useTerminology } from "../utils/TerminologyContext";
import { StatusBadge as SharedStatusBadge } from "../../../components/billing-shared";

const STATUS_OPTIONS = [
  { value: "draft", label: "Draft", color: "bg-slate-100 text-slate-600" },
  { value: "sent", label: "Sent", color: "bg-blue-100 text-blue-700" },
  { value: "accepted", label: "Accepted", color: "bg-emerald-100 text-emerald-700" },
  { value: "rejected", label: "Rejected", color: "bg-red-100 text-red-700" },
  { value: "cancelled", label: "Cancelled", color: "bg-amber-100 text-amber-700" },
  { value: "converted", label: "Converted", color: "bg-brand-100 text-brand-700" },
  { value: "expired", label: "Expired", color: "bg-slate-100 text-slate-500" },
];

function StatusBadge({ status }) {
  return <SharedStatusBadge status={status} options={STATUS_OPTIONS} />;
}

const TABS = [
  { key: "overview", label: "Overview", icon: FileText },
  { key: "customer", label: "Customer", icon: User },
  { key: "products", label: "Products", icon: Package },
  { key: "pricing", label: "Pricing", icon: CreditCard },
  { key: "timeline", label: "Timeline", icon: Clock },
  { key: "notes", label: "Notes", icon: FileEdit },
  { key: "activity", label: "Activity", icon: Activity },
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
            }`}>
            <Icon className="h-4 w-4" /> {tab.label}
          </button>
        );
      })}
    </nav>
  );
}

export default function QuotationDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { singular } = useTerminology();
  const [quote, setQuote] = useState(null);
  const [items, setItems] = useState([]);
  const [customer, setCustomer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);
  const [activeTab, setActiveTab] = useState("overview");
  const { baseCurrency: orgDefaultCurrency } = useCurrency();

  const [showConvertModal, setShowConvertModal] = useState(false);
  const [convertForm, setConvertForm] = useState({
    invoice_number: "",
    issue_date: new Date().toISOString().split("T")[0],
    due_date: new Date(Date.now() + 30 * 86400000).toISOString().split("T")[0],
  });
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [showConvertContractModal, setShowConvertContractModal] = useState(false);
  const [convertContractForm, setConvertContractForm] = useState({
    start_date: new Date().toISOString().split("T")[0],
    end_date: "",
    contract_name: "",
  });
  const [convertedContractId, setConvertedContractId] = useState(null);

  const [showCancelModal, setShowCancelModal] = useState(false);

  const CONTRACT_LINK_KEY = `zoiko_quote_contract_${id}`;

  const fetchQuote = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const [qData, itemsData] = await Promise.all([
        quoteApi.get(id),
        quoteApi.listItems(id).catch(() => []),
      ]);
      setQuote(qData);
      setItems(Array.isArray(itemsData) ? itemsData : itemsData?.items || []);
      try {
        const contractsRes = await contractApi.list({ quotation_id: id });
        const contractsList = Array.isArray(contractsRes) ? contractsRes : contractsRes?.items || [];
        if (contractsList.length > 0) {
          setConvertedContractId(contractsList[0].id);
        }
      } catch (e) {
        console.error("[QuoteDetail] Failed to fetch linked contracts:", e);
      }
      
      if (qData.customer_id) {
        customerApi.get(qData.customer_id).then(setCustomer).catch((err) => console.error("[QuoteDetail] Failed to load customer:", err));
      }
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to load quotation");
    } finally {
      if (!silent) setLoading(false);
    }
  }, [id, CONTRACT_LINK_KEY]);

  useEffect(() => { fetchQuote(); }, [fetchQuote]);

  async function handleAction(action) {
    try {
      setActionLoading(action);
      setError(null);
      switch (action) {
        case "send": await quoteApi.send(id); break;
        case "accept": await quoteApi.accept(id); break;
        case "recalculate": await quoteApi.recalculate(id); break;
        case "duplicate": { const dup = await quoteApi.duplicate(id); navigate(`/billing/quotations/${dup.id}`); return; }
      }
      await fetchQuote({ silent: true });
    } catch (err) {
      setError(err?.detail || err?.message || `Failed to ${action} quotation`);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleCancelConfirm() {
    try {
      setActionLoading("cancel");
      setError(null);
      await quoteApi.cancel(id);
      setShowCancelModal(false);
      await fetchQuote({ silent: true });
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to cancel quotation");
    } finally {
      setActionLoading(null);
    }
  }

  async function handleReject() {
    if (!rejectReason.trim()) return;
    try {
      setActionLoading("reject");
      setError(null);
      await quoteApi.reject(id, rejectReason.trim());
      setShowRejectModal(false);
      setRejectReason("");
      await fetchQuote({ silent: true });
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to reject quotation");
    } finally {
      setActionLoading(null);
    }
  }

  async function handleConvert() {
    if (!convertForm.invoice_number || !convertForm.issue_date || !convertForm.due_date) return;
    try {
      setActionLoading("convert");
      setError(null);
      const newInvoice = await quoteApi.convertToInvoice(id, convertForm);
      setShowConvertModal(false);
      await fetchQuote({ silent: true });
      if (newInvoice && newInvoice.id) {
        navigate(`/billing/invoices/${newInvoice.id}`);
      }
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to convert quotation");
    } finally {
      setActionLoading(null);
    }
  }

  async function handleConvertToContract() {
    if (!convertContractForm.start_date) return;
    try {
      setActionLoading("convertContract");
      setError(null);
      const contract = await contractApi.convertFromQuotation({
        quotation_id: id,
        start_date: convertContractForm.start_date,
        end_date: convertContractForm.end_date || undefined,
        contract_name: convertContractForm.contract_name || undefined,
      });
      setShowConvertContractModal(false);
      setConvertedContractId(contract.id);
      await fetchQuote({ silent: true });
      setTimeout(() => navigate(`/billing/contracts/${contract.id}`), 1200);
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to convert quotation to contract");
    } finally {
      setActionLoading(null);
    }
  }

  if (loading) {
    return (
      <HRPage title="Quotation Detail" subtitle="Loading quotation details...">
        <div className="flex items-center justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-brand-600" /></div>
      </HRPage>
    );
  }

  if (error && !quote) {
    return (
      <HRPage title="Quotation Detail" subtitle="Error loading quotation">
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <AlertCircle className="h-10 w-10 text-red-400 mb-3" />
          <p className="text-sm text-red-600 mb-3">{error}</p>
          <button onClick={fetchQuote} className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors">
            <RefreshCw className="h-4 w-4" /> Retry
          </button>
        </div>
      </HRPage>
    );
  }

  if (!quote) {
    return (
      <HRPage title="Quotation Detail" subtitle="Quotation not found">
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <FileSignature className="h-10 w-10 text-slate-300 mb-3" />
          <p className="text-sm font-medium text-slate-500">Quotation not found</p>
        </div>
      </HRPage>
    );
  }

  const btnClass = "inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50";
  const isActing = (a) => actionLoading === a;

  const InfoRow = ({ label, value }) => (
    <div className="flex items-center justify-between py-2 border-b border-slate-50 last:border-0">
      <span className="text-sm text-slate-500">{label}</span>
      <span className="text-sm font-medium text-slate-800">{value || "—"}</span>
    </div>
  );

  const renderOverview = () => (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-5">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Status</p>
          <div className="mt-2"><StatusBadge status={quote.status} /></div>
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-5">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Total Amount</p>
          <p className="text-2xl font-bold text-slate-900 mt-1 whitespace-nowrap">{formatDisplayCurrency(quote.total_amount, quote.currency)}</p>
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-5">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Valid Until</p>
          <p className="text-2xl font-bold text-slate-900 mt-1">{formatDisplayDate(quote.valid_until)}</p>
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-5">
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Items</p>
          <p className="text-2xl font-bold text-slate-900 mt-1">{items.length}</p>
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-6">
        <h3 className="text-sm font-semibold text-slate-900 mb-4">Quotation Information</h3>
        <div className="grid grid-cols-2 gap-x-8">
          <InfoRow label="Quote Number" value={quote.quote_number} />
          <InfoRow label="Version" value={`v${quote.quote_version || 1}`} />
          <div className="flex items-center justify-between py-2 border-b border-slate-50 last:border-0">
            <span className="text-sm text-slate-500">{singular}</span>
            {quote.customer_id ? (
              <button onClick={() => navigate(`/billing/customers/${quote.customer_id}`)} className="text-sm font-medium text-brand-600 hover:underline">
                {quote.customer_name || `Customer #${quote.customer_id}`}
              </button>
            ) : (
              <span className="text-sm font-medium text-slate-800">{quote.customer_name || "—"}</span>
            )}
          </div>
          <InfoRow label="Currency" value={quote.currency || orgDefaultCurrency} />
          <InfoRow label="Created" value={formatDisplayDate(quote.created_at)} />
          <InfoRow label="Expires" value={formatDisplayDate(quote.valid_until)} />
          <InfoRow label="Subtotal" value={formatDisplayCurrency(quote.subtotal, quote.currency)} />
          <InfoRow label="Discount" value={parseFloat(quote.discount_percentage || 0) > 0 ? `${quote.discount_percentage}%` : "—"} />
          <InfoRow label="Tax" value={formatDisplayCurrency(quote.tax_amount, quote.currency)} />
          <InfoRow label="Total" value={formatDisplayCurrency(quote.total_amount, quote.currency)} />
          {quote.accepted_at && <InfoRow label="Accepted At" value={formatDisplayDate(quote.accepted_at)} />}
          {quote.converted_to_invoice_id && (
            <div className="flex items-center justify-between py-2 border-b border-slate-50 last:border-0">
              <span className="text-sm text-slate-500">Converted to Invoice</span>
              <button onClick={() => navigate(`/billing/invoices/${quote.converted_to_invoice_id}`)} className="text-sm font-medium text-brand-600 hover:underline">
                #{quote.converted_to_invoice_id} →
              </button>
            </div>
          )}
          {convertedContractId && (
            <div className="flex items-center justify-between py-2 border-b border-slate-50 last:border-0">
              <span className="text-sm text-slate-500">Converted to Contract</span>
              <button onClick={() => navigate(`/billing/contracts/${convertedContractId}`)} className="text-sm font-medium text-brand-600 hover:underline">
                #{convertedContractId} →
              </button>
            </div>
          )}
        </div>
        {quote.subject && (
          <div className="mt-4 p-3 bg-slate-50 rounded-lg">
            <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1">Subject</p>
            <p className="text-sm text-slate-700">{quote.subject}</p>
          </div>
        )}
      </div>

      {quote.status === "draft" && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 text-sm text-amber-700 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          This quotation is in draft status. Send it to the customer for review.
        </div>
      )}
    </div>
  );

  const renderCustomer = () => (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-slate-900 flex items-center gap-2"><User size={16} className="text-brand-500" /> {singular} Details</h3>
        {quote.customer_id && (
          <button onClick={() => navigate(`/billing/customers/${quote.customer_id}`)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-brand-600 bg-brand-50 rounded-lg hover:bg-brand-100 transition-colors">
            <User className="h-4 w-4" /> View {singular} Profile
          </button>
        )}
      </div>
      {customer ? (
        <div className="space-y-4">
          <div className="flex items-center gap-4 p-4 bg-slate-50 rounded-xl">
            <div className="h-14 w-14 rounded-full bg-gradient-to-br from-brand to-brand-hover text-white flex items-center justify-center text-xl font-bold">
              {(customer.display_name || customer.company_name || "?").charAt(0).toUpperCase()}
            </div>
            <div>
              <h4 onClick={() => navigate(`/billing/customers/${quote.customer_id}`)}
                className="text-lg font-bold text-slate-800 hover:text-brand-600 cursor-pointer transition-colors">
                {customer.display_name || customer.company_name}
              </h4>
              <p className="text-sm text-slate-500">{customer.customer_code}</p>
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
          <p className="text-xs text-slate-400 mt-1">{singular} #{quote.customer_id}</p>
        </div>
      )}
    </div>
  );

  const renderProducts = () => (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-6">
      <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2"><Package size={16} className="text-brand-500" /> Line Items ({items.length})</h3>
      {items.length === 0 ? (
        <div className="text-center py-8 text-slate-400">
          <Package size={32} className="mx-auto mb-2 text-slate-300" />
          <p className="text-sm">No line items</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead>
              <tr className="text-xs font-medium text-slate-500 uppercase tracking-wider">
                <th scope="col" className="text-left py-3 px-4">#</th>
                <th scope="col" className="text-left py-3 px-4">Description</th>
                <th scope="col" className="text-right py-3 px-4">Qty</th>
                <th scope="col" className="text-right py-3 px-4">Unit Price</th>
                <th scope="col" className="text-right py-3 px-4">Disc %</th>
                <th scope="col" className="text-right py-3 px-4">Tax %</th>
                <th scope="col" className="text-right py-3 px-4">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map((item, i) => (
                <tr key={item.id || i} onClick={() => item.product_id && navigate(`/billing/products/${item.product_id}`)}
                  className={`text-sm text-slate-900 hover:bg-slate-50 ${item.product_id ? "cursor-pointer" : ""}`}>
                  <td className="py-3 px-4 text-slate-400">{item.line_number || i + 1}</td>
                  <td className="py-3 px-4">
                    <p className="font-medium text-slate-800">{item.description || "Item"}</p>
                    {item.product_id && <p className="text-xs text-brand-600 hover:underline">Product #{item.product_id} →</p>}
                  </td>
                  <td className="py-3 px-4 text-right">{parseFloat(item.quantity).toFixed(2)}</td>
                  <td className="py-3 px-4 text-right">{formatDisplayCurrency(item.unit_price, quote.currency)}</td>
                  <td className="py-3 px-4 text-right text-slate-500">{parseFloat(item.discount_percentage || 0) > 0 ? `${item.discount_percentage}%` : "—"}</td>
                  <td className="py-3 px-4 text-right text-slate-500">{parseFloat(item.tax_percentage || 0) > 0 ? `${item.tax_percentage}%` : "—"}</td>
                  <td className="py-3 px-4 text-right font-medium">{formatDisplayCurrency(item.total_amount, quote.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  const renderPricing = () => {
    const discPct = parseFloat(quote.discount_percentage || 0);
    const discAmt = parseFloat(quote.discount_amount || 0);
    return (
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-6">
          <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2"><CreditCard size={16} className="text-brand-500" /> Pricing Summary</h3>
          <div className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">Subtotal ({items.length} items)</span>
              <span className="font-medium text-slate-800">{formatDisplayCurrency(quote.subtotal, quote.currency)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">Discount</span>
              <span className="font-medium text-red-500">-{formatDisplayCurrency(discAmt, quote.currency)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-500">Tax</span>
              <span className="font-medium text-slate-800">{formatDisplayCurrency(quote.tax_amount, quote.currency)}</span>
            </div>
            <div className="flex justify-between text-base font-bold text-slate-800 border-t border-slate-200 pt-3">
              <span>Total</span>
              <span>{formatDisplayCurrency(quote.total_amount, quote.currency)}</span>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-6">
          <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2"><Hash size={16} className="text-brand-500" /> Details</h3>
          <div className="space-y-3">
          <InfoRow label="Currency" value={quote.currency || orgDefaultCurrency} />
            <InfoRow label="Discount %" value={discPct > 0 ? `${discPct}%` : "—"} />
            <InfoRow label="Discount Amount" value={discAmt > 0 ? formatDisplayCurrency(discAmt, quote.currency) : "—"} />
            <InfoRow label="Tax Amount" value={formatDisplayCurrency(quote.tax_amount, quote.currency)} />
            <InfoRow label="Valid Until" value={formatDisplayDate(quote.valid_until)} />
            <InfoRow label="Version" value={`v${quote.quote_version || 1}`} />
          </div>
        </div>
      </div>
    );
  };

  const renderTimeline = () => (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-6">
      <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2"><Clock size={16} className="text-brand-500" /> Timeline</h3>
      <div className="space-y-4">
        <TimelineEvent icon={FileSignature} label="Created" date={quote.created_at} color="bg-brand-500" />
        {quote.sent_at && <TimelineEvent icon={Send} label={`Sent to ${singular}`} date={quote.sent_at} color="bg-blue-500" />}
        {quote.accepted_at && <TimelineEvent icon={CheckCircle} label="Accepted" date={quote.accepted_at} color="bg-emerald-500" />}
        {quote.rejected_reason && <TimelineEvent icon={XCircle} label={`Rejected: ${quote.rejected_reason}`} date={quote.updated_at} color="bg-red-500" />}
        {quote.converted_to_invoice_id && <TimelineEvent icon={FileText} label="Converted to Invoice" date={quote.updated_at} color="bg-brand-500" />}
        {convertedContractId && <TimelineEvent icon={FileSignature} label="Converted to Contract" date={quote.updated_at} color="bg-blue-500" />}
        {quote.status === "cancelled" && <TimelineEvent icon={Ban} label="Cancelled" date={quote.updated_at} color="bg-amber-500" />}
      </div>
    </div>
  );

  const TimelineEvent = ({ icon: Icon, label, date, color }) => (
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

  const renderNotes = () => (
    <div className="space-y-6">
      {quote.notes && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-6">
          <h3 className="text-sm font-semibold text-slate-900 mb-2 flex items-center gap-2"><FileEdit size={16} className="text-brand-500" /> Notes</h3>
          <p className="text-sm text-slate-700 whitespace-pre-wrap">{quote.notes}</p>
        </div>
      )}
      {quote.terms && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-6">
          <h3 className="text-sm font-semibold text-slate-900 mb-2 flex items-center gap-2"><FileText size={16} className="text-brand-500" /> Terms & Conditions</h3>
          <p className="text-sm text-slate-700 whitespace-pre-wrap">{quote.terms}</p>
        </div>
      )}
      {!quote.notes && !quote.terms && (
        <div className="text-center py-8 text-slate-400">
          <FileEdit size={32} className="mx-auto mb-2 text-slate-300" />
          <p className="text-sm">No notes or terms</p>
        </div>
      )}
    </div>
  );

  const renderActivity = () => (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-6">
      <h3 className="text-sm font-semibold text-slate-900 mb-4 flex items-center gap-2"><Activity size={16} className="text-brand-500" /> Recent Activity</h3>
      <div className="space-y-3">
        <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg">
          <div className="w-8 h-8 rounded-full bg-brand-100 text-brand-600 flex items-center justify-center"><FileSignature size={14} /></div>
          <div className="flex-1">
            <p className="text-sm font-medium text-slate-800">Quotation created</p>
            <p className="text-xs text-slate-400">{formatDisplayDate(quote.created_at)}</p>
          </div>
        </div>
        {quote.status === "sent" && (
          <div className="flex items-center gap-3 p-3 bg-blue-50 rounded-lg">
            <div className="w-8 h-8 rounded-full bg-blue-100 text-blue-600 flex items-center justify-center"><Send size={14} /></div>
            <div className="flex-1">
              <p className="text-sm font-medium text-slate-800">Sent to customer</p>
              <p className="text-xs text-slate-400">{formatDisplayDate(quote.updated_at)}</p>
            </div>
          </div>
        )}
        {quote.accepted_at && (
          <div className="flex items-center gap-3 p-3 bg-emerald-50 rounded-lg">
            <div className="w-8 h-8 rounded-full bg-emerald-100 text-emerald-600 flex items-center justify-center"><CheckCircle size={14} /></div>
            <div className="flex-1">
              <p className="text-sm font-medium text-slate-800">Accepted by customer</p>
              <p className="text-xs text-slate-400">{formatDisplayDate(quote.accepted_at)}</p>
            </div>
          </div>
        )}
        {quote.rejected_reason && (
          <div className="flex items-center gap-3 p-3 bg-red-50 rounded-lg">
            <div className="w-8 h-8 rounded-full bg-red-100 text-red-600 flex items-center justify-center"><XCircle size={14} /></div>
            <div className="flex-1">
              <p className="text-sm font-medium text-slate-800">Rejected: {quote.rejected_reason}</p>
              <p className="text-xs text-slate-400">{formatDisplayDate(quote.updated_at)}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );

  const renderTabContent = () => {
    switch (activeTab) {
      case "overview": return renderOverview();
      case "customer": return renderCustomer();
      case "products": return renderProducts();
      case "pricing": return renderPricing();
      case "timeline": return renderTimeline();
      case "notes": return renderNotes();
      case "activity": return renderActivity();
      default: return renderOverview();
    }
  };

  return (
    <HRPage
      title={`Quotation ${quote.quote_number || `#${id}`}`}
      subtitle={
        <span className="flex items-center gap-2">
          <StatusBadge status={quote.status} />
          {quote.quote_version > 1 && <span className="text-xs text-slate-400">v{quote.quote_version}</span>}
        </span>
      }
      actions={
        <div className="flex items-center gap-2">
          <button onClick={() => navigate("/billing/quotations")}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors">
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
          <div className="bg-white rounded-2xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-6">
            <h3 className="text-sm font-semibold text-slate-900 mb-4">Actions</h3>
            <div className="space-y-3">
              {quote.status === "draft" && (
                <>
                  <button onClick={() => handleAction("send")} disabled={isActing("send")}
                    className={`${btnClass} w-full text-white bg-brand-600 hover:bg-brand-700`}>
                    {isActing("send") ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    Send Quotation
                  </button>
                  <button onClick={() => handleAction("recalculate")} disabled={isActing("recalculate")}
                    className={`${btnClass} w-full text-slate-700 bg-slate-100 hover:bg-slate-200`}>
                    {isActing("recalculate") ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                    Recalculate
                  </button>
                  <button onClick={() => setShowCancelModal(true)} disabled={isActing("cancel")}
                    className={`${btnClass} w-full text-red-700 bg-red-50 hover:bg-red-100`}>
                    {isActing("cancel") ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
                    Cancel Quotation
                  </button>
                </>
              )}

              {quote.status === "sent" && (
                <>
                  <button onClick={() => handleAction("accept")} disabled={isActing("accept")}
                    className={`${btnClass} w-full text-white bg-emerald-600 hover:bg-emerald-700`}>
                    {isActing("accept") ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />}
                    Accept Quotation
                  </button>
                  <button onClick={() => setShowRejectModal(true)} disabled={isActing("reject")}
                    className={`${btnClass} w-full text-red-700 bg-red-50 hover:bg-red-100`}>
                    <XCircle className="h-4 w-4" /> Reject Quotation
                  </button>
                </>
              )}

              {quote.status === "accepted" && (
                <>
                  <button onClick={() => setShowConvertContractModal(true)} disabled={isActing("convertContract")}
                    className={`${btnClass} w-full text-white bg-blue-600 hover:bg-blue-700`}>
                    {isActing("convertContract") ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                    Convert to Contract
                  </button>
                  <button onClick={() => setShowConvertModal(true)} disabled={isActing("convert")}
                    className={`${btnClass} w-full text-white bg-brand-600 hover:bg-brand-700`}>
                    {isActing("convert") ? <Loader2 className="h-4 w-4 animate-spin" /> : <DollarSign className="h-4 w-4" />}
                    Convert to Invoice
                  </button>
                </>
              )}

              {convertedContractId && (
                <button onClick={() => navigate(`/billing/contracts/${convertedContractId}`)}
                  className={`${btnClass} w-full text-blue-700 bg-blue-50 hover:bg-blue-100`}>
                  <FileText className="h-4 w-4" /> View Contract #{convertedContractId}
                </button>
              )}

              {quote.customer_id && (
                <button onClick={() => navigate(`/billing/customers/${quote.customer_id}`)}
                  className={`${btnClass} w-full text-blue-700 bg-blue-50 hover:bg-blue-100`}>
                  <User className="h-4 w-4" /> View {singular}
                </button>
              )}

              {quote.converted_to_invoice_id && (
                <button onClick={() => navigate(`/billing/invoices/${quote.converted_to_invoice_id}`)}
                  className={`${btnClass} w-full text-brand-700 bg-brand-50 hover:bg-brand-100`}>
                  <DollarSign className="h-4 w-4" /> View Invoice #{quote.converted_to_invoice_id}
                </button>
              )}

              {quote.rejected_reason && (
                <div className="p-3 rounded-lg bg-red-50 text-sm">
                  <p className="text-xs font-medium text-red-700 uppercase tracking-wider mb-1">Rejection Reason</p>
                  <p className="text-red-600">{quote.rejected_reason}</p>
                </div>
              )}

              <div className="border-t border-slate-100 pt-3 mt-3">
                <button onClick={() => handleAction("duplicate")} disabled={isActing("duplicate")}
                  className={`${btnClass} w-full text-slate-700 bg-slate-50 hover:bg-slate-100`}>
                  {isActing("duplicate") ? <Loader2 className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />}
                  Duplicate Quotation
                </button>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 shadow-[0_4px_20px_rgba(0,0,0,0.02)] p-6">
            <h3 className="text-sm font-semibold text-slate-900 mb-3">Quick Summary</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between"><span className="text-slate-500">Subtotal</span><span className="font-medium">{formatDisplayCurrency(quote.subtotal, quote.currency)}</span></div>
              <div className="flex justify-between"><span className="text-slate-500">Tax</span><span className="font-medium">{formatDisplayCurrency(quote.tax_amount, quote.currency)}</span></div>
              <div className="flex justify-between text-base font-bold text-slate-800 border-t border-slate-200 pt-2 mt-2">
                <span>Total</span><span>{formatDisplayCurrency(quote.total_amount, quote.currency)}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {showRejectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowRejectModal(false)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-slate-900 mb-2">Reject Quotation</h3>
            <p className="text-sm text-slate-500 mb-4">Provide a reason for rejecting this quotation.</p>
            <textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)}
              rows={3} placeholder="Reason for rejection..."
              className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30 mb-4" />
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowRejectModal(false)}
                className="px-4 py-2 text-sm font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200">Cancel</button>
              <button onClick={handleReject} disabled={!rejectReason.trim() || isActing("reject")}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50">
                {isActing("reject") ? <Loader2 className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />} Reject
              </button>
            </div>
          </div>
        </div>
      )}

      {showCancelModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowCancelModal(false)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-slate-900 mb-2">Cancel Quotation</h3>
            <p className="text-sm text-slate-500 mb-4">Are you sure you want to cancel this quotation? This action cannot be undone.</p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowCancelModal(false)}
                className="px-4 py-2 text-sm font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200">Cancel</button>
              <button onClick={handleCancelConfirm} disabled={isActing("cancel")}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50">
                {isActing("cancel") ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />} Cancel Quotation
              </button>
            </div>
          </div>
        </div>
      )}

      {showConvertContractModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowConvertContractModal(false)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-slate-900 mb-2">Convert to Contract</h3>
            <p className="text-sm text-slate-500 mb-4">Create a contract from this accepted quotation.</p>
            <div className="space-y-3 mb-4">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Contract Name</label>
                <input type="text" value={convertContractForm.contract_name}
                  onChange={(e) => setConvertContractForm((f) => ({ ...f, contract_name: e.target.value }))}
                  placeholder={quote.subject || "Contract from " + quote.quote_number}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Start Date</label>
                <input type="date" value={convertContractForm.start_date}
                  onChange={(e) => setConvertContractForm((f) => ({ ...f, start_date: e.target.value }))}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">End Date (optional)</label>
                <input type="date" value={convertContractForm.end_date}
                  onChange={(e) => setConvertContractForm((f) => ({ ...f, end_date: e.target.value }))}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500" />
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowConvertContractModal(false)}
                className="px-4 py-2 text-sm font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200">Cancel</button>
              <button onClick={handleConvertToContract}
                disabled={!convertContractForm.start_date || isActing("convertContract")}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50">
                {isActing("convertContract") ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />} Create Contract
              </button>
            </div>
          </div>
        </div>
      )}

      {showConvertModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowConvertModal(false)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-md shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-slate-900 mb-2">Convert to Invoice</h3>
            <p className="text-sm text-slate-500 mb-4">Create an invoice from this accepted quotation.</p>
            <div className="space-y-3 mb-4">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Invoice Number</label>
                <input type="text" value={convertForm.invoice_number}
                  onChange={(e) => setConvertForm((f) => ({ ...f, invoice_number: e.target.value }))}
                  placeholder="INV-0001"
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Issue Date</label>
                <input type="date" value={convertForm.issue_date}
                  onChange={(e) => setConvertForm((f) => ({ ...f, issue_date: e.target.value }))}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Due Date</label>
                <input type="date" value={convertForm.due_date}
                  onChange={(e) => setConvertForm((f) => ({ ...f, due_date: e.target.value }))}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
            </div>
            <div className="flex justify-end gap-3">
              <button onClick={() => setShowConvertModal(false)}
                className="px-4 py-2 text-sm font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200">Cancel</button>
              <button onClick={handleConvert}
                disabled={!convertForm.invoice_number || !convertForm.issue_date || !convertForm.due_date || isActing("convert")}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50">
                {isActing("convert") ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />} Convert
              </button>
            </div>
          </div>
        </div>
      )}
    </HRPage>
  );
}
