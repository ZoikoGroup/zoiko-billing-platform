import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import HRPage from '../../../components/HRPage';
import { productApi, pricingApi, invoiceApi, quoteApi, contractApi, subscriptionApi } from '../../../service/billingService';
import { ArrowLeft, Package, Plus, FileText,
  AlertCircle, DollarSign, RefreshCw,
  CreditCard, Activity, StickyNote, Files, Zap, History } from "lucide-react"
import { formatDisplayCurrency, formatDisplayDate } from '../../../utils/billing-helpers';
import { useCurrency } from '../utils/CurrencyContext';
import { auditApi } from '../../../service/billingService';
import { Spinner as SharedSpinner, ErrorState as SharedErrorState, EmptyState as SharedEmptyState, StatusBadge as SharedStatusBadge } from '../../../components/billing-shared';

const PRODUCT_STATUS_BADGE_OPTIONS = [
  { value: 'active', label: 'active', color: 'bg-green-100 text-green-700' },
  { value: 'inactive', label: 'inactive', color: 'bg-slate-100 text-slate-700' },
  { value: 'archived', label: 'archived', color: 'bg-slate-100 text-slate-600' },
];

const TABS = [
  { key: 'overview', label: 'Overview', icon: Package },
  { key: 'billing', label: 'Billing Profile', icon: CreditCard },
  { key: 'pricing', label: 'Pricing Plans', icon: DollarSign },
  { key: 'usage', label: 'Usage Settings', icon: Zap },
  { key: 'quotations', label: 'Quotations', icon: FileText },
  { key: 'invoices', label: 'Invoices', icon: FileText },
  { key: 'contracts', label: 'Contracts', icon: FileText },
  { key: 'subscriptions', label: 'Subscriptions', icon: CreditCard },
  { key: 'audit', label: 'Audit History', icon: History },
  { key: 'notes', label: 'Notes', icon: StickyNote },
  { key: 'documents', label: 'Documents', icon: Files },
];

function TypeBadge({ type }) {
  const styles = {
    service: 'bg-blue-100 text-blue-700',
    good: 'bg-amber-100 text-amber-700',
    subscription: 'bg-brand-100 text-brand-700',
    usage: 'bg-cyan-100 text-cyan-700',
    retainer: 'bg-indigo-100 text-indigo-700',
    other: 'bg-slate-100 text-slate-600',
  };
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${styles[type] || 'bg-slate-100 text-slate-600'}`}>
      {type ? type.replace('_', ' ') : '—'}
    </span>
  );
}

const FREQ_LABELS = {
  one_time: 'One Time', monthly: 'Monthly', quarterly: 'Quarterly',
  yearly: 'Yearly', usage_based: 'Usage Based', recurring: 'Recurring',
};

const Spinner = SharedSpinner;
const ErrorState = SharedErrorState;
const EmptyState = SharedEmptyState;
const StatusBadge = ({ status }) => <SharedStatusBadge status={status} options={PRODUCT_STATUS_BADGE_OPTIONS} />;

export default function ProductProfilePage() {
  const { baseCurrency } = useCurrency();
  const { id } = useParams();
  const navigate = useNavigate();

  const [product, setProduct] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('overview');

  // Data states
  const [pricingPlans, setPricingPlans] = useState([]);
  const [pricingPlansLoading, setPricingPlansLoading] = useState(false);
  const [quotations, setQuotations] = useState([]);
  const [quotationsLoading, setQuotationsLoading] = useState(false);
  const [invoices, setInvoices] = useState([]);
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  const [contracts, setContracts] = useState([]);
  const [contractsLoading, setContractsLoading] = useState(false);
  const [subscriptions, setSubscriptions] = useState([]);
  const [subscriptionsLoading, setSubscriptionsLoading] = useState(false);
  const [categories, setCategories] = useState([]);
  const [auditLogs, setAuditLogs] = useState([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [pricingPlansError, setPricingPlansError] = useState(null);
  const [quotationsError, setQuotationsError] = useState(null);
  const [invoicesError, setInvoicesError] = useState(null);
  const [contractsError, setContractsError] = useState(null);
  const [subscriptionsError, setSubscriptionsError] = useState(null);
  const [auditError, setAuditError] = useState(null);

  const fetchProduct = useCallback(async () => {
    try {
      setLoading(true);
      const data = await productApi.get(id);
      setProduct(data);
    } catch (err) {
      setError(err.message || 'Failed to load product');
    } finally {
      setLoading(false);
    }
  }, [id]);

  const fetchPricingPlans = useCallback(async () => {
    setPricingPlansLoading(true);
    setPricingPlansError(null);
    try {
      const data = await pricingApi.listByProduct(id);
      setPricingPlans(Array.isArray(data) ? data : data?.items || data?.data || []);
    } catch (err) { setPricingPlans([]); setPricingPlansError(err?.detail || err?.message || 'Failed to load pricing plans'); }
    finally { setPricingPlansLoading(false); }
  }, [id]);

  const fetchQuotations = useCallback(async () => {
    setQuotationsLoading(true);
    setQuotationsError(null);
    try {
      const data = await quoteApi.list({ product_id: id, per_page: 10 });
      setQuotations(Array.isArray(data) ? data : data?.items || data?.data || []);
    } catch (err) { setQuotations([]); setQuotationsError(err?.detail || err?.message || 'Failed to load quotations'); }
    finally { setQuotationsLoading(false); }
  }, [id]);

  const fetchInvoices = useCallback(async () => {
    setInvoicesLoading(true);
    setInvoicesError(null);
    try {
      const data = await invoiceApi.list({ product_id: id, per_page: 10 });
      setInvoices(Array.isArray(data) ? data : data?.items || data?.data || []);
    } catch (err) { setInvoices([]); setInvoicesError(err?.detail || err?.message || 'Failed to load invoices'); }
    finally { setInvoicesLoading(false); }
  }, [id]);

  const fetchContracts = useCallback(async () => {
    setContractsLoading(true);
    setContractsError(null);
    try {
      const data = await contractApi.list({ product_id: id, per_page: 10 });
      setContracts(Array.isArray(data) ? data : data?.items || data?.data || []);
    } catch (err) { setContracts([]); setContractsError(err?.detail || err?.message || 'Failed to load contracts'); }
    finally { setContractsLoading(false); }
  }, [id]);

  const fetchSubscriptions = useCallback(async () => {
    setSubscriptionsLoading(true);
    setSubscriptionsError(null);
    try {
      const data = await subscriptionApi.list({ product_id: id, per_page: 10 });
      setSubscriptions(Array.isArray(data) ? data : data?.items || data?.data || []);
    } catch (err) { setSubscriptions([]); setSubscriptionsError(err?.detail || err?.message || 'Failed to load subscriptions'); }
    finally { setSubscriptionsLoading(false); }
  }, [id]);

  const fetchAuditLogs = useCallback(async () => {
    setAuditLoading(true);
    setAuditError(null);
    try {
      const data = await auditApi.list({ entity_type: 'Product', entity_id: id, per_page: 50 });
      const items = data?.items || data?.data || data || [];
      setAuditLogs(Array.isArray(items) ? items : []);
    } catch (err) { setAuditLogs([]); setAuditError(err?.detail || err?.message || 'Failed to load audit history'); }
    finally { setAuditLoading(false); }
  }, [id]);

  useEffect(() => { fetchProduct(); }, [fetchProduct]);
  useEffect(() => {
    productApi.listCategories({}).then((data) => {
      const items = data?.items || data?.data || data || [];
      setCategories(Array.isArray(items) ? items : []);
    }).catch((err) => console.error("[ProductProfile] Failed to load categories:", err));
  }, []);

  // Refetching the product alone is enough — its resulting state change is
  // what the effects below already react to, cascading into a refresh of
  // whichever of invoices/subscriptions/contracts/pricing/quotations/audit
  // are relevant. Calling those fetchers here too would just duplicate the
  // network calls those effects are about to make anyway.
  const refreshAll = useCallback(() => {
    setRefreshing(true);
    fetchProduct().finally(() => setRefreshing(false));
  }, [fetchProduct]);

  useEffect(() => {
    if (!activeTab || !product) return;
    switch (activeTab) {
      case 'pricing': fetchPricingPlans(); break;
      case 'quotations': fetchQuotations(); break;
      case 'invoices': fetchInvoices(); break;
      case 'contracts': fetchContracts(); break;
      case 'subscriptions': fetchSubscriptions(); break;
      case 'audit': fetchAuditLogs(); break;
    }
  }, [activeTab, product, fetchPricingPlans, fetchQuotations, fetchInvoices, fetchContracts, fetchSubscriptions, fetchAuditLogs]);

  useEffect(() => {
    if (!product) return;
    fetchInvoices();
    fetchSubscriptions();
    fetchContracts();
    fetchPricingPlans();
  }, [product, fetchInvoices, fetchSubscriptions, fetchContracts, fetchPricingPlans]);

  if (loading) {
    return (
      <HRPage title="Product" subtitle="Loading product details">
        <div className="flex flex-col items-center justify-center py-20">
          <div className="h-16 w-16 rounded-full border-4 border-slate-200 border-t-brand-600 animate-spin" />
          <p className="mt-4 text-slate-600 font-medium">Loading product...</p>
        </div>
      </HRPage>
    );
  }

  if (error || !product) {
    return (
      <HRPage title="Product" subtitle="Product details">
        <div className="flex flex-col items-center justify-center py-20">
          <div className="h-16 w-16 rounded-full bg-red-100 text-red-600 flex items-center justify-center mb-4"><AlertCircle size={32} /></div>
          <h3 className="text-xl font-bold text-slate-800 mb-2">Something went wrong</h3>
          <p className="text-slate-600 mb-6 text-center max-w-md">{error || 'Product not found'}</p>
          <div className="flex gap-3">
            <button onClick={() => navigate('/billing/products')} className="px-4 py-2 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50">Back to Products</button>
            <button onClick={fetchProduct} className="px-6 py-2 bg-gradient-to-r from-brand to-brand-hover text-white rounded-xl text-sm font-medium hover:shadow-lg">Retry</button>
          </div>
        </div>
      </HRPage>
    );
  }

  const totalRevenue = invoices.filter((i) => i.status === 'paid' || i.status === 'paid_at').reduce((s, i) => s + Number(i.total || i.amount || 0), 0);
  const totalInvoiced = invoices.reduce((s, i) => s + Number(i.total || i.amount || 0), 0);
  const activeSubscriptions = subscriptions.filter((s) => s.status === 'active').length;
  const activeContracts = contracts.filter((c) => c.status === 'active').length;

  return (
    <HRPage title={product.name || 'Product'} subtitle={`${product.code || ''} · ${product.product_type || 'Product'}`}>
      {/* Back button */}
      <button onClick={() => navigate('/billing/products')} className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-700 mb-4 transition-colors">
        <ArrowLeft size={16} /> Back to Products
      </button>

      {/* ── KPI Cards ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-4 mb-6">
        <div className="bg-white rounded-3xl border border-slate-200 p-5 min-w-0">
          <p className="text-[10px] font-medium text-slate-500 uppercase tracking-wider truncate">Status</p>
          <div className="mt-1"><StatusBadge status={product.status} /></div>
        </div>
        <div className="bg-white rounded-3xl border border-slate-200 p-5 min-w-0">
          <p className="text-[10px] font-medium text-slate-500 uppercase tracking-wider truncate">Type</p>
          <div className="mt-1.5"><TypeBadge type={product.product_type} /></div>
        </div>
        <div className="bg-white rounded-3xl border border-slate-200 p-5 min-w-0">
          <p className="text-[10px] font-medium text-slate-500 uppercase tracking-wider truncate">Default Price</p>
          <p className="text-lg font-bold text-slate-900 mt-0.5 truncate" title={formatDisplayCurrency(product.default_price || 0, product.currency)}>{formatDisplayCurrency(product.default_price || 0, product.currency)}</p>
        </div>
        <div className="bg-white rounded-3xl border border-slate-200 p-5 min-w-0">
          <p className="text-[10px] font-medium text-slate-500 uppercase tracking-wider truncate">Revenue (Paid)</p>
          <p className="text-lg font-bold text-emerald-700 mt-0.5 truncate" title={formatDisplayCurrency(totalRevenue, product.currency)}>{formatDisplayCurrency(totalRevenue, product.currency)}</p>
        </div>
        <div className="bg-white rounded-3xl border border-slate-200 p-5 min-w-0">
          <p className="text-[10px] font-medium text-slate-500 uppercase tracking-wider truncate">Total Invoiced</p>
          <p className="text-lg font-bold text-slate-900 mt-0.5 truncate" title={formatDisplayCurrency(totalInvoiced, product.currency)}>{formatDisplayCurrency(totalInvoiced, product.currency)}</p>
        </div>
        <div className="bg-white rounded-3xl border border-slate-200 p-5 min-w-0">
          <p className="text-[10px] font-medium text-slate-500 uppercase tracking-wider truncate">Active Subs</p>
          <p className="text-lg font-bold text-brand-600 mt-0.5 whitespace-nowrap">{activeSubscriptions}</p>
        </div>
        <div className="bg-white rounded-3xl border border-slate-200 p-5 min-w-0">
          <p className="text-[10px] font-medium text-slate-500 uppercase tracking-wider truncate">Active Contracts</p>
          <p className="text-lg font-bold text-blue-600 mt-0.5 whitespace-nowrap">{activeContracts}</p>
        </div>
      </div>

      {/* ── Quick Actions ── */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        <button onClick={() => navigate(`/billing/quotations?action=create&product_id=${id}`)}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors">
          <Plus className="h-4 w-4" /> New Quotation
        </button>
        <button onClick={() => navigate(`/billing/invoices?action=create&product_id=${id}`)}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors">
          <Plus className="h-4 w-4" /> New Invoice
        </button>
        <button onClick={() => navigate(`/billing/pricing?product_id=${id}`)}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors">
          <DollarSign className="h-4 w-4" /> View Pricing Plans
        </button>
        <button onClick={() => navigate(`/billing/products/pricing-plans?product_id=${id}`)}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors">
          <DollarSign className="h-4 w-4" /> Update Pricing
        </button>
        <button onClick={() => navigate(`/billing/contracts?product_id=${id}`)}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors">
          <FileText className="h-4 w-4" /> View Contracts
        </button>
        <button onClick={() => navigate(`/billing/subscriptions?product_id=${id}`)}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors">
          <CreditCard className="h-4 w-4" /> View Subscriptions
        </button>
        <div className="w-px h-6 bg-slate-200 mx-1 hidden sm:block" />
        <button onClick={refreshAll} disabled={refreshing}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50">
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {/* ── Tabs ── */}
      <div className="flex gap-1 overflow-x-auto mb-6 border-b border-slate-200">
        {TABS.map((tab) => (
          <button key={tab.key} onClick={() => setActiveTab(tab.key)}
            className={`flex items-center gap-1.5 px-4 py-3 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
              activeTab === tab.key ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
            }`}>
            <tab.icon size={15} /> {tab.label}
          </button>
        ))}
      </div>

      {/* ── Tab Content ── */}

      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* Product Overview */}
          <div className="bg-white rounded-3xl border border-slate-200 p-6">
            <h3 className="text-lg font-semibold text-slate-900 mb-4">Product Overview</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-6">
              <div><p className="text-xs text-slate-500 uppercase tracking-wider">Product Name</p><p className="text-sm font-medium text-slate-900 mt-1">{product.name}</p></div>
              <div><p className="text-xs text-slate-500 uppercase tracking-wider">SKU / Code</p><p className="text-sm font-medium text-slate-900 mt-1 font-mono">{product.code || '—'}</p></div>
              <div><p className="text-xs text-slate-500 uppercase tracking-wider">Type</p><p className="text-sm font-medium text-slate-900 mt-1 capitalize">{product.product_type?.replace('_', ' ') || '—'}</p></div>
              <div><p className="text-xs text-slate-500 uppercase tracking-wider">Category</p><p className="text-sm font-medium text-slate-900 mt-1">{categories.find(c => c.id === product.category_id)?.name || '—'}</p></div>
              <div><p className="text-xs text-slate-500 uppercase tracking-wider">Brand</p><p className="text-sm font-medium text-slate-900 mt-1">{product.brand || '—'}</p></div>
              <div><p className="text-xs text-slate-500 uppercase tracking-wider">Unit / Meter</p><p className="text-sm font-medium text-slate-900 mt-1">{product.unit_label || '—'}</p></div>
            </div>
            {product.description && (
              <div className="mt-4 pt-4 border-t border-slate-100">
                <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Description</p>
                <p className="text-sm text-slate-700">{product.description}</p>
              </div>
            )}
          </div>

          {/* Billing Profile Summary */}
          <div className="bg-white rounded-3xl border border-slate-200 p-6">
            <h3 className="text-lg font-semibold text-slate-900 mb-4">Billing Profile</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
              <div><p className="text-xs text-slate-500 uppercase tracking-wider">Default Price</p><p className="text-sm font-bold text-slate-900 mt-1">{formatDisplayCurrency(product.default_price || 0, product.currency)}</p></div>
              <div><p className="text-xs text-slate-500 uppercase tracking-wider">Currency</p><p className="text-sm font-medium text-slate-900 mt-1">{product.currency || baseCurrency}</p></div>
              <div><p className="text-xs text-slate-500 uppercase tracking-wider">Billing Frequency</p><p className="text-sm font-medium text-slate-900 mt-1 capitalize">{FREQ_LABELS[product.billing_frequency] || product.billing_frequency || '—'}</p></div>
              <div><p className="text-xs text-slate-500 uppercase tracking-wider">Default Discount</p><p className="text-sm font-medium text-slate-900 mt-1">{product.default_discount ? `${product.default_discount}%` : '—'}</p></div>
            </div>
            {product.invoice_description && (
              <div className="mt-4 pt-4 border-t border-slate-100">
                <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Invoice Description</p>
                <p className="text-sm text-slate-700">{product.invoice_description}</p>
              </div>
            )}
          </div>

          {/* Tax & Pricing Info */}
          <div className="bg-white rounded-3xl border border-slate-200 p-6">
            <h3 className="text-lg font-semibold text-slate-900 mb-4">Tax & Cost</h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
              <div><p className="text-xs text-slate-500 uppercase tracking-wider">Tax Rate</p><p className="text-sm font-medium text-slate-900 mt-1">{product.tax_percentage ? `${product.tax_percentage}%` : '0%'}</p></div>
              <div><p className="text-xs text-slate-500 uppercase tracking-wider">Tax Inclusive</p><p className="text-sm font-medium text-slate-900 mt-1">{product.tax_inclusive ? 'Yes' : 'No'}</p></div>
              <div><p className="text-xs text-slate-500 uppercase tracking-wider">Cost Price</p><p className="text-sm font-medium text-slate-900 mt-1">{formatDisplayCurrency(product.cost_price || 0, product.currency)}</p></div>
              <div><p className="text-xs text-slate-500 uppercase tracking-wider">Margin</p><p className="text-sm font-medium text-slate-900 mt-1">
                {product.default_price && product.cost_price !== null && product.cost_price !== undefined && product.cost_price !== ''
                  ? `${((1 - Number(product.cost_price) / Number(product.default_price)) * 100).toFixed(1)}%`
                  : '—'}
              </p></div>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'billing' && (
        <div className="bg-white rounded-3xl border border-slate-200 p-6">
          <h3 className="text-lg font-semibold text-slate-900 mb-4">Billing Profile</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-6">
            <div><p className="text-xs text-slate-500 uppercase tracking-wider">Default Price</p><p className="text-sm font-bold text-slate-900 mt-1">{formatDisplayCurrency(product.default_price || 0, product.currency)}</p></div>
            <div><p className="text-xs text-slate-500 uppercase tracking-wider">Preferred Currency</p><p className="text-sm font-medium text-slate-900 mt-1">{product.currency || baseCurrency}</p></div>
            <div><p className="text-xs text-slate-500 uppercase tracking-wider">Billing Frequency</p><p className="text-sm font-medium text-slate-900 mt-1 capitalize">{FREQ_LABELS[product.billing_frequency] || product.billing_frequency || '—'}</p></div>
            <div><p className="text-xs text-slate-500 uppercase tracking-wider">Default Discount</p><p className="text-sm font-medium text-slate-900 mt-1">{product.default_discount ? `${product.default_discount}%` : 'No discount'}</p></div>
            <div><p className="text-xs text-slate-500 uppercase tracking-wider">Tax Rate</p><p className="text-sm font-medium text-slate-900 mt-1">{product.tax_percentage ? `${product.tax_percentage}%` : '0%'}</p></div>
            <div><p className="text-xs text-slate-500 uppercase tracking-wider">Tax Inclusive</p><p className="text-sm font-medium text-slate-900 mt-1">{product.tax_inclusive ? 'Yes' : 'No'}</p></div>
          </div>
          {product.invoice_description && (
            <div className="mt-4 pt-4 border-t border-slate-100">
              <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Invoice Description</p>
              <p className="text-sm text-slate-700">{product.invoice_description}</p>
            </div>
          )}
        </div>
      )}

      {activeTab === 'pricing' && (
        <div className="bg-white rounded-3xl border border-slate-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-lg font-semibold text-slate-900">Pricing Plans</h3>
              <p className="text-xs text-slate-500 mt-0.5">Plans override product defaults when active</p>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => navigate(`/billing/pricing?product_id=${id}`)}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 bg-slate-100 rounded-lg hover:bg-slate-200">
                <DollarSign size={15} /> Workspace
              </button>
              <button onClick={() => navigate(`/billing/products/pricing-plans?product_id=${id}`)}
                className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700">
                <Plus size={15} /> Add Plan
              </button>
            </div>
          </div>
          {pricingPlansLoading ? (
            <Spinner />
          ) : pricingPlansError ? (
            <ErrorState message={pricingPlansError} onRetry={fetchPricingPlans} />
          ) : pricingPlans.length === 0 ? (
            <EmptyState icon={DollarSign} title="No pricing plans" message="Create a pricing plan for this product. Product defaults will be used as fallback." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100">
                    <th className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase">Plan</th>
                    <th className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase">Model</th>
                    <th className="text-right py-3 px-3 font-medium text-slate-500 text-xs uppercase">Price</th>
                    <th className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase">Period</th>
                    <th className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase">Effective</th>
                    <th className="text-center py-3 px-3 font-medium text-slate-500 text-xs uppercase">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {pricingPlans.map((plan) => (
                    <tr key={plan.id} className="border-b border-slate-50 hover:bg-slate-50 cursor-pointer" onClick={() => navigate(`/billing/pricing?product_id=${id}`)}>
                      <td className="py-3 px-3 font-medium text-slate-900">{plan.name}</td>
                      <td className="py-3 px-3 text-slate-500 capitalize">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
                          {plan.pricing_model?.replace('_', ' ') || 'flat'}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-right font-medium text-slate-900">{formatDisplayCurrency(plan.unit_price || plan.flat_fee || 0)}</td>
                      <td className="py-3 px-3 text-slate-500 capitalize">{plan.billing_period?.replace('_', ' ')}</td>
                      <td className="py-3 px-3 text-xs text-slate-500">
                        {plan.effective_from ? `${plan.effective_from.slice(0, 10)}${plan.effective_to ? ` → ${plan.effective_to.slice(0, 10)}` : ' → ∞'}` : '—'}
                      </td>
                      <td className="py-3 px-3 text-center">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                          plan.status === 'active' || plan.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'
                        }`}>{plan.status === 'active' || plan.is_active ? 'Active' : 'Inactive'}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === 'quotations' && (
        <div className="bg-white rounded-3xl border border-slate-200 p-6">
          <h3 className="text-lg font-semibold text-slate-900 mb-4">Recent Quotations</h3>
          {quotationsLoading ? <Spinner /> : quotationsError ? (
            <ErrorState message={quotationsError} onRetry={fetchQuotations} />
          ) : quotations.length === 0 ? (
            <EmptyState icon={FileText} title="No quotations" message="This product has no quotations yet." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-slate-100">
                  <th className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase">Quotation</th>
                  <th className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase">Date</th>
                  <th className="text-right py-3 px-3 font-medium text-slate-500 text-xs uppercase">Amount</th>
                  <th className="text-center py-3 px-3 font-medium text-slate-500 text-xs uppercase">Status</th>
                </tr></thead>
                <tbody>
                  {quotations.slice(0, 10).map((q) => (
                    <tr key={q.id} className="border-b border-slate-50 hover:bg-slate-50 cursor-pointer" onClick={() => navigate(`/billing/quotations/${q.id}`)}>
                      <td className="py-3 px-3 font-medium text-slate-900">{q.quotation_number || q.number || q.id}</td>
                      <td className="py-3 px-3 text-slate-500">{formatDisplayDate(q.issue_date || q.date || q.created_at)}</td>
                      <td className="py-3 px-3 text-right font-medium text-slate-900">{formatDisplayCurrency(q.total || q.amount)}</td>
                      <td className="py-3 px-3 text-center">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                          q.status === 'accepted' ? 'bg-emerald-100 text-emerald-700' :
                          q.status === 'draft' ? 'bg-slate-100 text-slate-600' :
                          q.status === 'sent' ? 'bg-blue-100 text-blue-700' :
                          q.status === 'rejected' ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-600'
                        }`}>{q.status ? q.status.charAt(0).toUpperCase() + q.status.slice(1) : 'Unknown'}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === 'invoices' && (
        <div className="bg-white rounded-3xl border border-slate-200 p-6">
          <h3 className="text-lg font-semibold text-slate-900 mb-4">Recent Invoices</h3>
          {invoicesLoading ? <Spinner /> : invoicesError ? (
            <ErrorState message={invoicesError} onRetry={fetchInvoices} />
          ) : invoices.length === 0 ? (
            <EmptyState icon={FileText} title="No invoices" message="This product has no invoices yet." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-slate-100">
                  <th className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase">Invoice</th>
                  <th className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase">Date</th>
                  <th className="text-right py-3 px-3 font-medium text-slate-500 text-xs uppercase">Amount</th>
                  <th className="text-center py-3 px-3 font-medium text-slate-500 text-xs uppercase">Status</th>
                </tr></thead>
                <tbody>
                  {invoices.slice(0, 10).map((inv) => (
                    <tr key={inv.id} className="border-b border-slate-50 hover:bg-slate-50 cursor-pointer" onClick={() => navigate(`/billing/invoices/${inv.id}`)}>
                      <td className="py-3 px-3 font-medium text-slate-900">{inv.invoice_number || inv.number || inv.id}</td>
                      <td className="py-3 px-3 text-slate-500">{formatDisplayDate(inv.issue_date || inv.date || inv.created_at)}</td>
                      <td className="py-3 px-3 text-right font-medium text-slate-900">{formatDisplayCurrency(inv.total || inv.amount)}</td>
                      <td className="py-3 px-3 text-center">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                          inv.status === 'paid' ? 'bg-emerald-100 text-emerald-700' :
                          inv.status === 'draft' ? 'bg-slate-100 text-slate-600' :
                          inv.status === 'sent' || inv.status === 'unpaid' ? 'bg-amber-100 text-amber-700' :
                          inv.status === 'overdue' ? 'bg-red-100 text-red-700' :
                          inv.status === 'cancelled' || inv.status === 'void' ? 'bg-slate-100 text-slate-600' : 'bg-slate-100 text-slate-600'
                        }`}>{inv.status ? inv.status.charAt(0).toUpperCase() + inv.status.slice(1) : 'Unknown'}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === 'contracts' && (
        <div className="bg-white rounded-3xl border border-slate-200 p-6">
          <h3 className="text-lg font-semibold text-slate-900 mb-4">Contracts</h3>
          {contractsLoading ? <Spinner /> : contractsError ? (
            <ErrorState message={contractsError} onRetry={fetchContracts} />
          ) : contracts.length === 0 ? (
            <EmptyState icon={FileText} title="No contracts" message="This product has no contracts." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-slate-100">
                  <th className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase">Contract</th>
                  <th className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase">Customer</th>
                  <th className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase">Start</th>
                  <th className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase">End</th>
                  <th className="text-center py-3 px-3 font-medium text-slate-500 text-xs uppercase">Status</th>
                </tr></thead>
                <tbody>
                  {contracts.map((c) => (
                    <tr key={c.id} className="border-b border-slate-50 hover:bg-slate-50 cursor-pointer" onClick={() => navigate(`/billing/contracts/${c.id}`)}>
                      <td className="py-3 px-3 font-medium text-slate-900">{c.contract_number || c.number || c.id}</td>
                      <td className="py-3 px-3 text-slate-500">
                        {c.customer_id ? (
                          <button onClick={(e) => { e.stopPropagation(); navigate(`/billing/customers/${c.customer_id}`); }} className="text-brand-600 hover:underline">
                            {c.customer_name || `Customer #${c.customer_id}`}
                          </button>
                        ) : (c.customer_name || '—')}
                      </td>
                      <td className="py-3 px-3 text-slate-500">{formatDisplayDate(c.start_date)}</td>
                      <td className="py-3 px-3 text-slate-500">{c.end_date ? formatDisplayDate(c.end_date) : '—'}</td>
                      <td className="py-3 px-3 text-center">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                          c.status === 'active' ? 'bg-emerald-100 text-emerald-700' :
                          c.status === 'draft' ? 'bg-slate-100 text-slate-600' :
                          c.status === 'expired' ? 'bg-amber-100 text-amber-700' :
                          c.status === 'terminated' || c.status === 'cancelled' ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-600'
                        }`}>{c.status ? c.status.charAt(0).toUpperCase() + c.status.slice(1) : 'Unknown'}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === 'subscriptions' && (
        <div className="bg-white rounded-3xl border border-slate-200 p-6">
          <h3 className="text-lg font-semibold text-slate-900 mb-4">Subscriptions</h3>
          {subscriptionsLoading ? <Spinner /> : subscriptionsError ? (
            <ErrorState message={subscriptionsError} onRetry={fetchSubscriptions} />
          ) : subscriptions.length === 0 ? (
            <EmptyState icon={CreditCard} title="No subscriptions" message="This product has no subscriptions." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-slate-100">
                  <th className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase">Subscription</th>
                  <th className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase">Customer</th>
                  <th className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase">Start</th>
                  <th className="text-left py-3 px-3 font-medium text-slate-500 text-xs uppercase">Period</th>
                  <th className="text-center py-3 px-3 font-medium text-slate-500 text-xs uppercase">Status</th>
                </tr></thead>
                <tbody>
                  {subscriptions.map((s) => (
                    <tr key={s.id} className="border-b border-slate-50 hover:bg-slate-50 cursor-pointer" onClick={() => navigate(`/billing/subscriptions/${s.id}`)}>
                      <td className="py-3 px-3 font-medium text-slate-900">{s.subscription_number || s.number || s.id}</td>
                      <td className="py-3 px-3 text-slate-500">
                        {s.customer_id ? (
                          <button onClick={(e) => { e.stopPropagation(); navigate(`/billing/customers/${s.customer_id}`); }} className="text-brand-600 hover:underline">
                            {s.customer_name || `Customer #${s.customer_id}`}
                          </button>
                        ) : (s.customer_name || '—')}
                      </td>
                      <td className="py-3 px-3 text-slate-500">{formatDisplayDate(s.start_date || s.created_at)}</td>
                      <td className="py-3 px-3 text-slate-500 capitalize">{s.billing_period?.replace('_', ' ') || '—'}</td>
                      <td className="py-3 px-3 text-center">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                          s.status === 'active' ? 'bg-emerald-100 text-emerald-700' :
                          s.status === 'paused' ? 'bg-amber-100 text-amber-700' :
                          s.status === 'cancelled' ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-600'
                        }`}>{s.status ? s.status.charAt(0).toUpperCase() + s.status.slice(1) : 'Unknown'}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === 'usage' && (
        <div className="bg-white rounded-3xl border border-slate-200 p-6">
          <h3 className="text-lg font-semibold text-slate-900 mb-4">Usage Settings</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-6">
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wider">Usage Billable</p>
              <p className="text-sm font-medium text-slate-900 mt-1">{product.is_usage_billable ? 'Yes' : 'No'}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wider">Subscribable</p>
              <p className="text-sm font-medium text-slate-900 mt-1">{product.is_subscribable ? 'Yes' : 'No'}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wider">Unit / Meter</p>
              <p className="text-sm font-medium text-slate-900 mt-1">{product.unit_label || '—'}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wider">Billing Frequency</p>
              <p className="text-sm font-medium text-slate-900 mt-1 capitalize">{FREQ_LABELS[product.billing_frequency] || product.billing_frequency || '—'}</p>
            </div>
            <div>
              <p className="text-xs text-slate-500 uppercase tracking-wider">Product Type</p>
              <p className="text-sm font-medium text-slate-900 mt-1 capitalize">{product.product_type?.replace('_', ' ') || '—'}</p>
            </div>
          </div>
          {!product.is_usage_billable && (
            <div className="mt-6 bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-700">
              <strong>Not configured for usage billing.</strong> Enable "Usage Billable" in the product edit form to track metered usage for this product.
            </div>
          )}
          {product.is_usage_billable && (
            <div className="mt-6 bg-emerald-50 border border-emerald-200 rounded-xl p-4 text-sm text-emerald-700">
              <strong>Usage billing is active.</strong> This product can be metered. Configure usage pricing plans from the Pricing Plans tab.
            </div>
          )}
        </div>
      )}

      {activeTab === 'audit' && (
        <div className="bg-white rounded-3xl border border-slate-200 p-6">
          <h3 className="text-lg font-semibold text-slate-900 mb-4">Audit History</h3>
          {auditLoading ? <Spinner /> : auditError ? (
            <ErrorState message={auditError} onRetry={fetchAuditLogs} />
          ) : auditLogs.length === 0 ? (
            <EmptyState icon={History} title="No audit records" message="No changes have been recorded for this product." />
          ) : (
            <div className="space-y-3">
              {auditLogs.map((log, idx) => (
                <div key={log.id || idx} className="flex items-start gap-3 p-3 rounded-lg bg-slate-50 border border-slate-100">
                  <div className={`h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                    log.action === 'create' ? 'bg-green-100 text-green-600' :
                    log.action === 'update' ? 'bg-blue-100 text-blue-600' :
                    log.action === 'delete' ? 'bg-red-100 text-red-600' : 'bg-slate-100 text-slate-600'
                  }`}>
                    <Activity size={14} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-900">{log.action ? log.action.charAt(0).toUpperCase() + log.action.slice(1) : 'Unknown'}</p>
                    {log.details && <p className="text-xs text-slate-500 mt-0.5 truncate">{typeof log.details === 'string' ? log.details : JSON.stringify(log.details)}</p>}
                    <p className="text-xs text-slate-500 mt-0.5">{log.created_at ? new Date(log.created_at).toLocaleString() : '—'}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'notes' && (
        <div className="bg-white rounded-3xl border border-slate-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-slate-900">Notes</h3>
          </div>
          <EmptyState icon={StickyNote} title="No notes" message="Notes will appear here." />
        </div>
      )}

      {activeTab === 'documents' && (
        <div className="bg-white rounded-3xl border border-slate-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-slate-900">Documents</h3>
          </div>
          <EmptyState icon={Files} title="No documents" message="Documents will appear here." />
        </div>
      )}
    </HRPage>
  );
}
