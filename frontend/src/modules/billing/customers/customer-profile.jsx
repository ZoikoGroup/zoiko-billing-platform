import { useState, useEffect, useCallback } from "react";
import { useParams, useNavigate } from 'react-router-dom';
import HRPage from '../../../components/HRPage';
import { customerApi, invoiceApi, paymentApi, contractApi, subscriptionApi, creditNoteApi, settingsApi, quoteApi } from '../../../service/billingService';
import { ArrowLeft, Mail, Phone, Building2, User, CreditCard,
  FileText, RefreshCw, Plus, Pencil, Trash2, CheckCircle,
  AlertCircle, Loader2, Star, Ban, Play, Activity, Files, StickyNote,
  Download, Upload, Pin, Clock, MapPin, BarChart3,
  Tag, Search, X, Hash, UserPlus, DollarSign } from "lucide-react"
import { formatDisplayCurrency, formatDisplayDate } from '../../../utils/billing-helpers';
import { getCurrencySelectOptions, getCountrySelectOptions, getCurrencyForCountry } from '../../../utils/currency';
import { getCustomerTaxFields } from '../utils/countryIntelligence';
import { useCurrency } from '../utils/CurrencyContext';
import { useTerminology } from '../utils/TerminologyContext';
import { Spinner, ErrorState, EmptyState } from '../../../components/billing-shared';



function ConfirmModal({ open, title, message, onConfirm, onCancel, loading, confirmLabel, variant }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onCancel}>
      <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
        <div className={`h-12 w-12 rounded-full flex items-center justify-center mx-auto mb-4 ${variant === 'danger' ? 'bg-red-100' : 'bg-brand-100'}`}>
          {variant === 'danger' ? <AlertCircle className="h-6 w-6 text-red-600" /> : <CheckCircle className="h-6 w-6 text-brand-600" />}
        </div>
        <h3 className="text-lg font-semibold text-gray-900 text-center mb-2">{title}</h3>
        <p className="text-sm text-gray-500 text-center mb-6">{message}</p>
        <div className="flex gap-3 justify-center">
          <button onClick={onCancel} disabled={loading}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors">
            Cancel
          </button>
          <button onClick={onConfirm} disabled={loading}
            className={`inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-colors ${
              variant === 'danger' ? 'bg-red-600 hover:bg-red-700' : 'bg-brand-600 hover:bg-brand-700'
            }`}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null} {confirmLabel || 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Toast({ message, type, onClose }) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onClose, 4000);
    return () => clearTimeout(t);
  }, [message, onClose]);
  if (!message) return null;
  const styles = {
    success: 'bg-emerald-600 text-white',
    error: 'bg-red-600 text-white',
    info: 'bg-brand-600 text-white',
  };
  return (
    <div className="fixed top-4 right-4 z-50 animate-slide-down">
      <div className={`flex items-center gap-2 px-4 py-3 rounded-xl shadow-lg text-sm font-medium ${styles[type] || styles.info}`}>
        {type === 'success' ? <CheckCircle className="h-4 w-4" /> : type === 'error' ? <AlertCircle className="h-4 w-4" /> : null}
        {message}
        <button onClick={onClose} className="ml-2 hover:opacity-70" aria-label="Close notification"><X className="h-3.5 w-3.5" /></button>
      </div>
    </div>
  );
}

function TagBadge({ tag, onRemove }) {
  return (
    <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium bg-brand-100 text-brand-700">
      <Hash className="h-3 w-3" />{tag}
      {onRemove && (
        <button onClick={() => onRemove(tag)} className="hover:text-brand-800" aria-label={`Remove tag ${tag}`}><X className="h-3 w-3" /></button>
      )}
    </span>
  );
}

const TABS = [
  { key: 'overview', label: 'Overview', icon: User },
  { key: 'contacts', label: 'Contacts', icon: Mail },
  { key: 'payment-methods', label: 'Payment Methods', icon: CreditCard },
  { key: 'billing-overview', label: 'Billing Overview', icon: FileText },
  { key: 'quotations', label: 'Quotations', icon: FileText },
  { key: 'contracts', label: 'Contracts', icon: FileText },
  { key: 'subscriptions', label: 'Subscriptions', icon: FileText },
  { key: 'credit-notes', label: 'Credit Notes', icon: FileText },
  { key: 'timeline', label: 'Timeline', icon: Clock },
  { key: 'documents', label: 'Documents', icon: Files },
  { key: 'notes', label: 'Notes', icon: StickyNote },
];



function StatusBadge({ status }) {
  const styles = {
    active: 'bg-emerald-100 text-emerald-700',
    inactive: 'bg-gray-100 text-gray-600',
    suspended: 'bg-amber-100 text-amber-700',
    pending: 'bg-blue-100 text-blue-700',
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium ${styles[status] || 'bg-gray-100 text-gray-600'}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${
        status === 'active' ? 'bg-emerald-500' :
        status === 'suspended' ? 'bg-amber-500' :
        status === 'inactive' ? 'bg-gray-400' : 'bg-blue-500'
      }`} />
      {status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Unknown'}
    </span>
  );
}

function InvoiceStatusBadge({ status }) {
  const styles = {
    paid: 'bg-emerald-100 text-emerald-700',
    unpaid: 'bg-amber-100 text-amber-700',
    overdue: 'bg-red-100 text-red-700',
    draft: 'bg-gray-100 text-gray-600',
    cancelled: 'bg-slate-100 text-slate-500',
    void: 'bg-slate-100 text-slate-500',
  };
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${styles[status] || 'bg-gray-100 text-gray-600'}`}>
      {status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Unknown'}
    </span>
  );
}



function InlineEditField({ label, value, editing, onChange, type = 'text', required }) {
  if (!editing) {
    return (
      <div>
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</p>
        <p className="text-sm text-gray-900 mt-0.5">{value || '—'}</p>
      </div>
    );
  }
  return (
    <div>
      <label className="text-xs font-medium text-gray-500 uppercase tracking-wider">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
      />
    </div>
  );
}

export default function CustomerProfilePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { baseCurrency } = useCurrency();
  const { singular, plural } = useTerminology();

  const [activeTab, setActiveTab] = useState('overview');

  const [customer, setCustomer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const [contacts, setContacts] = useState([]);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [contactsError, setContactsError] = useState(null);

  const [paymentMethods, setPaymentMethods] = useState([]);
  const [paymentMethodsLoading, setPaymentMethodsLoading] = useState(false);
  const [paymentMethodsError, setPaymentMethodsError] = useState(null);

  const [invoices, setInvoices] = useState([]);
  const [invoicesLoading, setInvoicesLoading] = useState(false);
  const [invoicesError, setInvoicesError] = useState(null);

  const [payments, setPayments] = useState([]);
  const [paymentsLoading, setPaymentsLoading] = useState(false);
  const [paymentsError, setPaymentsError] = useState(null);

  const [contracts, setContracts] = useState([]);
  const [contractsLoading, setContractsLoading] = useState(false);
  const [contractsError, setContractsError] = useState(null);

  const [subscriptions, setSubscriptions] = useState([]);
  const [subscriptionsLoading, setSubscriptionsLoading] = useState(false);
  const [subscriptionsError, setSubscriptionsError] = useState(null);

  const [creditNotes, setCreditNotes] = useState([]);
  const [creditNotesLoading, setCreditNotesLoading] = useState(false);
  const [creditNotesError, setCreditNotesError] = useState(null);

  const [activity, setActivity] = useState([]);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState(null);

  const [analytics, setAnalytics] = useState(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);

  const [quotations, setQuotations] = useState([]);
  const [quotationsLoading, setQuotationsLoading] = useState(false);
  const [quotationsError, setQuotationsError] = useState(null);

  const [timeline, setTimeline] = useState([]);
  const [timelineLoading, setTimelineLoading] = useState(false);

  const [documents, setDocuments] = useState([]);
  const [documentsLoading, setDocumentsLoading] = useState(false);
  const [documentsError, setDocumentsError] = useState(null);

  const [docForm, setDocForm] = useState({ file_name: '', file_path: '', file_size: null, mime_type: '', document_type: '', notes: '' });
  const [showDocForm, setShowDocForm] = useState(false);
  const [docSaving, setDocSaving] = useState(false);

  const [notes, setNotes] = useState([]);
  const [notesLoading, setNotesLoading] = useState(false);
  const [notesError, setNotesError] = useState(null);

  const [noteForm, setNoteForm] = useState({ content: '', is_pinned: false, is_internal: false });
  const [showNoteForm, setShowNoteForm] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState(null);
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteFormError, setNoteFormError] = useState(null);

  const [editing, setEditing] = useState(false);
  const [orgConfig, setOrgConfig] = useState(null);
  const [editForm, setEditForm] = useState({
    display_name: '', company_name: '', legal_name: '',
    first_name: '', last_name: '',
    email: '', alternate_email: '', phone: '', mobile: '', website: '',
    designation: '', industry: '', employee_count: '', customer_type: 'business',
    billing_address: '', shipping_address: '', billing_country: '', shipping_country: '',
    shipping_same_as_billing: false,
    gst_number: '', vat_number: '', pan: '', tin: '', tax_id: '', tax_id_type: '', tax_category: '',
    currency: '', payment_terms: 'net_30', credit_limit: '', credit_days: 30, price_list: '',
    tags: [], notes: '',
  });
  const [tagInput, setTagInput] = useState('');

  const [contactForm, setContactForm] = useState({ first_name: '', last_name: '', email: '', phone: '', job_title: '', department: '', is_primary: false });
  const [showContactForm, setShowContactForm] = useState(false);
  const [editingContactId, setEditingContactId] = useState(null);
  const [contactSaving, setContactSaving] = useState(false);
  const [contactFormError, setContactFormError] = useState(null);

  const [pmForm, setPmForm] = useState({ type: 'card', last_four: '', expiry_date: '', cardholder_name: '', is_default: false });
  const [showPmForm, setShowPmForm] = useState(false);
  const [editingPmId, setEditingPmId] = useState(null);
  const [pmSaving, setPmSaving] = useState(false);
  const [pmFormError, setPmFormError] = useState(null);

  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState(null);

  const [toast, setToast] = useState({ message: '', type: '' });
  const showToast = useCallback((message, type = 'success') => setToast({ message, type }), []);
  const closeToast = useCallback(() => setToast({ message: '', type: '' }), []);

  const [confirmState, setConfirmState] = useState({ open: false, title: '', message: '', onConfirm: null, variant: 'danger', confirmLabel: '' });
  const openConfirm = useCallback((title, message, onConfirm, variant = 'danger', confirmLabel = 'Confirm') => {
    setConfirmState({ open: true, title, message, onConfirm, variant, confirmLabel });
  }, []);
  const closeConfirm = useCallback(() => setConfirmState({ open: false, title: '', message: '', onConfirm: null, variant: 'danger', confirmLabel: '' }), []);

  const [contactSearch, setContactSearch] = useState('');
  const [docSearch, setDocSearch] = useState('');

  const CUSTOMER_TYPES = ['business', 'individual', 'government', 'non_profit'];
  const TERMS_MAP = { due_on_receipt: 0, net_15: 15, net_30: 30, net_45: 45, net_60: 60, net_90: 90 };

  const fetchCustomer = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await customerApi.get(id);
      setCustomer(data);
      setEditForm({
        display_name: data.display_name || data.company_name || '',
        company_name: data.company_name || '',
        legal_name: data.legal_name || '',
        first_name: data.first_name || '',
        last_name: data.last_name || '',
        email: data.email || '',
        alternate_email: data.alternate_email || '',
        phone: data.phone || '',
        mobile: data.mobile || '',
        website: data.website || '',
        designation: data.designation || '',
        industry: data.industry || '',
        employee_count: data.employee_count || '',
        customer_type: data.customer_type || 'business',
        billing_address: data.billing_address || '',
        shipping_address: data.shipping_address || '',
        billing_country: data.billing_country || '',
        shipping_country: data.shipping_country || '',
        shipping_same_as_billing: false,
        gst_number: data.gst_number || '',
        vat_number: data.vat_number || '',
        pan: data.pan || '',
        tin: data.tin || '',
        tax_id: data.tax_id || '',
        tax_id_type: data.tax_id_type || '',
        tax_category: data.tax_category || '',
        currency: data.currency || '',
        payment_terms: data.payment_terms || 'net_30',
        credit_limit: data.credit_limit != null ? data.credit_limit : '',
        credit_days: data.credit_days != null ? Number(data.credit_days) : 30,
        price_list: data.price_list || '',
        tags: data.tags || [],
        notes: data.notes || '',
      });
      settingsApi.getConfig().then(setOrgConfig).catch((err) => console.error("[CustomerProfile] Failed to load config:", err));
    } catch (err) {
      setError(err?.detail || err?.message || `Failed to load ${singular.toLowerCase()}`);
    } finally {
      setLoading(false);
    }
  }, [id]);

  const fetchContacts = useCallback(async () => {
    if (!id) return;
    try {
      setContactsLoading(true);
      setContactsError(null);
      const data = await customerApi.listContacts(id);
      setContacts(Array.isArray(data) ? data : data?.items || data?.contacts || []);
    } catch (err) {
      setContactsError(err?.detail || err?.message || 'Failed to load contacts');
    } finally {
      setContactsLoading(false);
    }
  }, [id]);

  const fetchPaymentMethods = useCallback(async () => {
    if (!id) return;
    try {
      setPaymentMethodsLoading(true);
      setPaymentMethodsError(null);
      const data = await paymentApi.listMethods(id);
      setPaymentMethods(Array.isArray(data) ? data : data?.items || data?.payment_methods || []);
    } catch (err) {
      setPaymentMethodsError(err?.detail || err?.message || 'Failed to load payment methods');
    } finally {
      setPaymentMethodsLoading(false);
    }
  }, [id]);

  const fetchInvoices = useCallback(async () => {
    if (!id) return;
    try {
      setInvoicesLoading(true);
      setInvoicesError(null);
      const data = await invoiceApi.list({ customer_id: id, per_page: 20 });
      const items = Array.isArray(data) ? data : data?.items || data?.invoices || data?.data || [];
      setInvoices(items);
    } catch (err) {
      setInvoicesError(err?.detail || err?.message || 'Failed to load invoices');
    } finally {
      setInvoicesLoading(false);
    }
  }, [id]);

  const fetchPayments = useCallback(async () => {
    if (!id) return;
    try {
      setPaymentsLoading(true);
      setPaymentsError(null);
      const data = await paymentApi.list({ customer_id: id, per_page: 20 });
      const items = Array.isArray(data) ? data : data?.items || data?.payments || data?.data || [];
      setPayments(items);
    } catch (err) {
      setPaymentsError(err?.detail || err?.message || 'Failed to load payments');
    } finally {
      setPaymentsLoading(false);
    }
  }, [id]);

  const fetchContracts = useCallback(async () => {
    if (!id) return;
    try {
      setContractsLoading(true);
      setContractsError(null);
      const data = await contractApi.list({ customer_id: id, per_page: 50 });
      const items = Array.isArray(data) ? data : data?.items || data?.contracts || data?.data || [];
      setContracts(items);
    } catch (err) {
      setContractsError(err?.detail || err?.message || 'Failed to load contracts');
    } finally {
      setContractsLoading(false);
    }
  }, [id]);

  const fetchSubscriptions = useCallback(async () => {
    if (!id) return;
    try {
      setSubscriptionsLoading(true);
      setSubscriptionsError(null);
      const data = await subscriptionApi.list({ customer_id: id, per_page: 50 });
      const items = Array.isArray(data) ? data : data?.items || data?.subscriptions || data?.data || [];
      setSubscriptions(items);
    } catch (err) {
      setSubscriptionsError(err?.detail || err?.message || 'Failed to load subscriptions');
    } finally {
      setSubscriptionsLoading(false);
    }
  }, [id]);

  const fetchCreditNotes = useCallback(async () => {
    if (!id) return;
    try {
      setCreditNotesLoading(true);
      setCreditNotesError(null);
      const data = await creditNoteApi.list({ customer_id: id, per_page: 50 });
      const items = Array.isArray(data) ? data : data?.items || data?.credit_notes || data?.data || [];
      setCreditNotes(items);
    } catch (err) {
      setCreditNotesError(err?.detail || err?.message || 'Failed to load credit notes');
    } finally {
      setCreditNotesLoading(false);
    }
  }, [id]);

  const fetchActivity = useCallback(async () => {
    if (!id) return;
    try {
      setActivityLoading(true);
      setActivityError(null);
      const data = await customerApi.getActivity(id);
      setActivity(Array.isArray(data) ? data : []);
    } catch (err) {
      setActivityError(err?.detail || err?.message || 'Failed to load activity');
    } finally {
      setActivityLoading(false);
    }
  }, [id]);

  const fetchAnalytics = useCallback(async () => {
    if (!id) return;
    try {
      setAnalyticsLoading(true);
      const data = await customerApi.getAnalytics(id);
      setAnalytics(data);
    } catch {
      // Silently fail — analytics is supplementary
    } finally {
      setAnalyticsLoading(false);
    }
  }, [id]);

  const fetchQuotations = useCallback(async () => {
    if (!id) return;
    try {
      setQuotationsLoading(true);
      setQuotationsError(null);
      const data = await quoteApi.list({ customer_id: id, per_page: 50 });
      const items = Array.isArray(data) ? data : data?.items || data?.quotations || data?.data || [];
      setQuotations(items);
    } catch (err) {
      setQuotationsError(err?.detail || err?.message || 'Failed to load quotations');
    } finally {
      setQuotationsLoading(false);
    }
  }, [id]);

  const buildTimeline = useCallback(() => {
    const events = [];
    // Tracks the exact instant of every entity-specific event already added,
    // so the generic activity feed (merged last) can skip re-reporting the
    // same underlying event a second time under a different label.
    const seenTimestamps = new Set();
    const pushEvent = (date, rest) => {
      if (!date) return;
      events.push({ date, ...rest });
      const t = new Date(date).getTime();
      if (!Number.isNaN(t)) seenTimestamps.add(t);
    };
    notes.forEach((n) => {
      if (n.created_at) pushEvent(n.created_at, { type: 'note', label: 'Note Added', description: n.content?.slice(0, 120), actor: n.created_by });
    });
    invoices.forEach((inv) => {
      const d = inv.issue_date || inv.created_at;
      pushEvent(d, { type: 'invoice', label: `Invoice ${inv.invoice_number || ''}`, description: inv.status ? `Status: ${inv.status}` : '', amount: inv.total || inv.amount });
    });
    payments.forEach((p) => {
      const d = p.payment_date || p.created_at;
      pushEvent(d, { type: 'payment', label: `Payment ${p.payment_number || p.transaction_id || ''}`, description: p.payment_method || '', amount: p.amount });
    });
    quotations.forEach((q) => {
      const d = q.issue_date || q.created_at;
      pushEvent(d, { type: 'quotation', label: `Quotation ${q.quotation_number || ''}`, description: q.status ? `Status: ${q.status}` : '', amount: q.total || q.amount });
    });
    creditNotes.forEach((cn) => {
      const d = cn.issue_date || cn.created_at;
      pushEvent(d, { type: 'credit_note', label: `Credit Note ${cn.credit_note_number || ''}`, description: cn.reason || '', amount: cn.total || cn.amount });
    });
    contracts.forEach((c) => {
      const d = c.start_date || c.created_at;
      pushEvent(d, { type: 'contract', label: `Contract ${c.contract_number || c.name || ''}`, description: c.status ? `Status: ${c.status}` : '' });
    });
    subscriptions.forEach((s) => {
      const d = s.start_date || s.created_at;
      pushEvent(d, { type: 'subscription', label: `Subscription ${s.subscription_number || s.name || ''}`, description: [s.plan_name || s.plan?.name, s.status].filter(Boolean).join(' · ') });
    });
    documents.forEach((doc) => {
      pushEvent(doc.created_at, { type: 'document', label: `Document ${doc.document_number || doc.file_name || doc.title || ''}`, description: doc.document_type || doc.mime_type || '' });
    });
    if (customer?.created_at) pushEvent(customer.created_at, { type: 'customer', label: `${singular} Created`, description: `${singular} account created` });
    // Generic activity feed merged last — skip anything whose timestamp
    // exactly matches an event already added above, since that means the
    // same underlying action was already reported by its own specific
    // source (e.g. an invoice-creation activity-log row vs. the invoice
    // itself) and would otherwise render twice under a different label.
    activity.forEach((a) => {
      if (!a.timestamp) return;
      const t = new Date(a.timestamp).getTime();
      if (!Number.isNaN(t) && seenTimestamps.has(t)) return;
      pushEvent(a.timestamp, { type: 'activity', label: a.action ? a.action.charAt(0).toUpperCase() + a.action.slice(1) : 'Action', description: a.entity_type || '', actor: a.actor_id });
    });
    events.sort((a, b) => new Date(b.date) - new Date(a.date));
    setTimeline(events);
    setTimelineLoading(false);
  }, [notes, activity, invoices, payments, quotations, creditNotes, contracts, subscriptions, documents, customer, singular]);

  const fetchDocuments = useCallback(async () => {
    if (!id) return;
    try {
      setDocumentsLoading(true);
      setDocumentsError(null);
      const data = await customerApi.listDocuments(id);
      setDocuments(Array.isArray(data) ? data : []);
    } catch (err) {
      setDocumentsError(err?.detail || err?.message || 'Failed to load documents');
    } finally {
      setDocumentsLoading(false);
    }
  }, [id]);

  const fetchNotes = useCallback(async () => {
    if (!id) return;
    try {
      setNotesLoading(true);
      setNotesError(null);
      const data = await customerApi.listNotes(id);
      setNotes(Array.isArray(data) ? data : []);
    } catch (err) {
      setNotesError(err?.detail || err?.message || 'Failed to load notes');
    } finally {
      setNotesLoading(false);
    }
  }, [id]);

  const refreshAll = useCallback(() => {
    fetchCustomer();
    fetchContacts();
    fetchPaymentMethods();
    fetchInvoices();
    fetchPayments();
    fetchContracts();
    fetchSubscriptions();
    fetchCreditNotes();
    fetchActivity();
    fetchAnalytics();
    fetchQuotations();
    fetchDocuments();
    fetchNotes();
  }, [fetchCustomer, fetchContacts, fetchPaymentMethods, fetchInvoices, fetchPayments, fetchContracts, fetchSubscriptions, fetchCreditNotes, fetchActivity, fetchAnalytics, fetchQuotations, fetchDocuments, fetchNotes]);

  useEffect(() => {
    if (id) fetchCustomer();
  }, [id, fetchCustomer]);

  useEffect(() => {
    if (id && activeTab === 'overview') {
      fetchInvoices();
      fetchPayments();
      fetchActivity();
      fetchAnalytics();
      fetchNotes();
      fetchQuotations();
      fetchContracts();
      fetchSubscriptions();
    }
  }, [id, activeTab, fetchInvoices, fetchPayments, fetchActivity, fetchAnalytics, fetchNotes, fetchQuotations, fetchContracts, fetchSubscriptions]);

  useEffect(() => {
    if (id && activeTab === 'contacts') fetchContacts();
  }, [id, activeTab, fetchContacts]);

  useEffect(() => {
    if (id && activeTab === 'payment-methods') fetchPaymentMethods();
  }, [id, activeTab, fetchPaymentMethods]);

  useEffect(() => {
    if (id && activeTab === 'billing-overview') { fetchInvoices(); fetchPayments(); fetchCreditNotes(); }
  }, [id, activeTab, fetchInvoices, fetchPayments, fetchCreditNotes]);

  useEffect(() => {
    if (id && activeTab === 'quotations') fetchQuotations();
  }, [id, activeTab, fetchQuotations]);

  useEffect(() => {
    if (id && activeTab === 'contracts') fetchContracts();
  }, [id, activeTab, fetchContracts]);

  useEffect(() => {
    if (id && activeTab === 'subscriptions') fetchSubscriptions();
  }, [id, activeTab, fetchSubscriptions]);

  useEffect(() => {
    if (id && activeTab === 'credit-notes') fetchCreditNotes();
  }, [id, activeTab, fetchCreditNotes]);

  useEffect(() => {
    if (id && activeTab === 'timeline') {
      setTimelineLoading(true);
      fetchInvoices();
      fetchPayments();
      fetchActivity();
      fetchNotes();
      fetchQuotations();
      fetchCreditNotes();
      fetchContracts();
      fetchSubscriptions();
      fetchDocuments();
    }
  }, [id, activeTab, fetchInvoices, fetchPayments, fetchActivity, fetchNotes, fetchQuotations, fetchCreditNotes, fetchContracts, fetchSubscriptions, fetchDocuments]);

  useEffect(() => {
    if (activeTab === 'timeline' && !activityLoading && !invoicesLoading && !paymentsLoading && !notesLoading && !contractsLoading && !subscriptionsLoading && !documentsLoading) {
      buildTimeline();
    }
  }, [activeTab, activityLoading, invoicesLoading, paymentsLoading, notesLoading, contractsLoading, subscriptionsLoading, documentsLoading, buildTimeline]);

  useEffect(() => {
    if (id && activeTab === 'documents') fetchDocuments();
  }, [id, activeTab, fetchDocuments]);

  useEffect(() => {
    if (id && activeTab === 'notes') fetchNotes();
  }, [id, activeTab, fetchNotes]);

  const handleSave = async () => {
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (editForm.customer_type === 'business' && !editForm.company_name?.trim()) {
      setError(`Company name is required for business ${plural.toLowerCase()}`);
      return;
    }
    if (editForm.email?.trim() && !emailRe.test(editForm.email.trim())) {
      setError("Please enter a valid email address");
      return;
    }
    try {
      setSaving(true);
      const payload = { ...editForm };
      if (editForm.shipping_same_as_billing) payload.shipping_address = editForm.billing_address;
      if (editForm.shipping_same_as_billing) payload.shipping_country = editForm.billing_country;
      delete payload.shipping_same_as_billing;
      payload.credit_days = editForm.credit_days === "" || editForm.credit_days == null
        ? TERMS_MAP[editForm.payment_terms] ?? 30
        : Math.max(0, parseInt(editForm.credit_days, 10) || 0);
      if (editForm.credit_limit === "" || editForm.credit_limit == null) {
        delete payload.credit_limit;
      } else {
        payload.credit_limit = Math.max(0, parseFloat(editForm.credit_limit) || 0);
      }
      if (editForm.employee_count === "" || editForm.employee_count == null) {
        delete payload.employee_count;
      } else {
        payload.employee_count = Math.max(0, parseInt(editForm.employee_count, 10) || 0);
      }
      if (!Array.isArray(payload.tags)) payload.tags = [];
      payload.customer_type = editForm.customer_type || 'business';
      await customerApi.update(id, payload);
      setEditing(false);
      showToast(`${singular} updated successfully`);
      await fetchCustomer();
    } catch (err) {
      setError(err?.detail || err?.message || `Failed to update ${singular.toLowerCase()}`);
    } finally {
      setSaving(false);
    }
  };

  const handleAction = async (action) => {
    try {
      setActionLoading(true);
      setActionError(null);
      const actions = { activate: customerApi.activate, deactivate: customerApi.deactivate, suspend: customerApi.suspend };
      await actions[action](id);
      showToast(`${singular} ${action}d successfully`);
      await fetchCustomer();
    } catch (err) {
      setActionError(err?.detail || err?.message || `Failed to ${action} ${singular.toLowerCase()}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleSaveContact = async (e) => {
    e.preventDefault();
    try {
      setContactSaving(true);
      setContactFormError(null);
      if (editingContactId) {
        await customerApi.updateContact(id, editingContactId, contactForm);
      } else {
        await customerApi.addContact(id, contactForm);
      }
      setShowContactForm(false);
      setEditingContactId(null);
      setContactForm({ first_name: '', last_name: '', email: '', phone: '', job_title: '', department: '', is_primary: false });
      await fetchContacts();
    } catch (err) {
      setContactFormError(err?.detail || err?.message || 'Failed to save contact');
    } finally {
      setContactSaving(false);
    }
  };

  const handleRemoveContact = async (contactId) => {
    try {
      setContactSaving(true);
      await customerApi.removeContact(id, contactId);
      showToast('Contact removed successfully');
      await fetchContacts();
    } catch (err) {
      setContactsError(err?.detail || err?.message || 'Failed to remove contact');
    } finally {
      setContactSaving(false);
    }
  };

  const handleSetPrimaryContact = async (contactId) => {
    try {
      setContactSaving(true);
      await customerApi.setPrimaryContact(id, contactId);
      await fetchContacts();
    } catch (err) {
      setContactsError(err?.detail || err?.message || 'Failed to set primary contact');
    } finally {
      setContactSaving(false);
    }
  };

  const handleSavePm = async (e) => {
    e.preventDefault();
    try {
      setPmSaving(true);
      setPmFormError(null);
      if (editingPmId) {
        await paymentApi.updateMethod(editingPmId, pmForm);
      } else {
        await paymentApi.addMethod({ ...pmForm, customer_id: id });
      }
      setShowPmForm(false);
      setEditingPmId(null);
      setPmForm({ type: 'card', last_four: '', expiry_date: '', cardholder_name: '', is_default: false });
      await fetchPaymentMethods();
    } catch (err) {
      setPmFormError(err?.detail || err?.message || 'Failed to save payment method');
    } finally {
      setPmSaving(false);
    }
  };

  const handleRemovePm = async (pmId) => {
    try {
      setPmSaving(true);
      await paymentApi.removeMethod(pmId);
      showToast('Payment method removed');
      await fetchPaymentMethods();
    } catch (err) {
      setPaymentMethodsError(err?.detail || err?.message || 'Failed to remove payment method');
    } finally {
      setPmSaving(false);
    }
  };

  const handleSetDefaultPm = async (pmId) => {
    try {
      setPmSaving(true);
      await paymentApi.setDefaultMethod(pmId);
      await fetchPaymentMethods();
    } catch (err) {
      setPaymentMethodsError(err?.detail || err?.message || 'Failed to set default payment method');
    } finally {
      setPmSaving(false);
    }
  };

  const handleSaveDoc = async (e) => {
    e.preventDefault();
    try {
      setDocSaving(true);
      await customerApi.addDocument(id, docForm);
      setShowDocForm(false);
      setDocForm({ file_name: '', file_path: '', file_size: null, mime_type: '', document_type: '', notes: '' });
      await fetchDocuments();
    } catch (err) {
      setDocumentsError(err?.detail || err?.message || 'Failed to save document');
    } finally {
      setDocSaving(false);
    }
  };

  const handleDeleteDoc = async (docId) => {
    try {
      await customerApi.deleteDocument(id, docId);
      showToast('Document deleted');
      await fetchDocuments();
    } catch (err) {
      setDocumentsError(err?.detail || err?.message || 'Failed to delete document');
    }
  };

  const handleSaveNote = async (e) => {
    e.preventDefault();
    try {
      setNoteSaving(true);
      setNoteFormError(null);
      if (editingNoteId) {
        await customerApi.updateNote(id, editingNoteId, noteForm);
      } else {
        await customerApi.addNote(id, noteForm);
      }
      setShowNoteForm(false);
      setEditingNoteId(null);
      setNoteForm({ content: '', is_pinned: false, is_internal: false });
      await fetchNotes();
    } catch (err) {
      setNoteFormError(err?.detail || err?.message || 'Failed to save note');
    } finally {
      setNoteSaving(false);
    }
  };

  const handleDeleteNote = async (noteId) => {
    try {
      await customerApi.deleteNote(id, noteId);
      showToast('Note deleted');
      await fetchNotes();
    } catch (err) {
      setNotesError(err?.detail || err?.message || 'Failed to delete note');
    }
  };

  if (loading) {
    return (
      <HRPage title={`${singular} Profile`} subtitle={`Loading ${singular.toLowerCase()} details...`}>
        <Spinner />
      </HRPage>
    );
  }

  if (error && !customer) {
    return (
      <HRPage title={`${singular} Profile`} subtitle={`Error loading ${singular.toLowerCase()}`}>
        <ErrorState message={error} onRetry={fetchCustomer} />
      </HRPage>
    );
  }

  return (
    <HRPage title={customer?.display_name || customer?.company_name || `${singular} Profile`} subtitle={`${singular} #${id}`}>

      <div className="mb-4">
        <button onClick={() => navigate('/billing/customers')} className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 transition-colors">
          <ArrowLeft className="h-4 w-4" /> Back to {plural}
        </button>
      </div>

      {actionError && (
        <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0" /> {actionError}
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 p-6 mb-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="h-14 w-14 rounded-full bg-brand-100 flex items-center justify-center">
              <User className="h-7 w-7 text-brand-600" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-bold text-gray-900">{customer?.display_name || customer?.company_name}</h2>
                <StatusBadge status={customer?.status} />
              </div>
              <div className="flex items-center gap-3 mt-1 text-sm text-gray-500">
                {customer?.email && <span className="flex items-center gap-1"><Mail className="h-3.5 w-3.5" /> {customer.email}</span>}
                {customer?.phone && <span className="flex items-center gap-1"><Phone className="h-3.5 w-3.5" /> {customer.phone}</span>}
                {customer?.company_name && <span className="flex items-center gap-1"><Building2 className="h-3.5 w-3.5" /> {customer.company_name}</span>}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {customer?.status === 'active' && (
              <button onClick={() => handleAction('deactivate')} disabled={actionLoading}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 disabled:opacity-50 transition-colors">
                {actionLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />} Deactivate
              </button>
            )}
            {customer?.status === 'inactive' && (
              <button onClick={() => handleAction('activate')} disabled={actionLoading}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors">
                {actionLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} Activate
              </button>
            )}
            {customer?.status === 'active' && (
              <button onClick={() => handleAction('suspend')} disabled={actionLoading}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-amber-700 bg-amber-100 rounded-lg hover:bg-amber-200 disabled:opacity-50 transition-colors">
                {actionLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <AlertCircle className="h-4 w-4" />} Suspend
              </button>
            )}
            <button onClick={refreshAll} className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors">
              <RefreshCw className="h-4 w-4" /> Refresh
            </button>
          </div>
        </div>
      </div>

      {/* Business Dashboard Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Outstanding</p>
          <p className="text-xl font-bold text-amber-600 mt-1 truncate" title={formatDisplayCurrency(customer?.outstanding_balance || 0, baseCurrency)}>{formatDisplayCurrency(customer?.outstanding_balance || 0, baseCurrency)}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Total Revenue</p>
          <p className="text-xl font-bold text-emerald-600 mt-1 truncate" title={formatDisplayCurrency(customer?.total_revenue || 0, baseCurrency)}>{formatDisplayCurrency(customer?.total_revenue || 0, baseCurrency)}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Credit Limit</p>
          <p className="text-xl font-bold text-slate-800 mt-1 truncate" title={formatDisplayCurrency(customer?.credit_limit || 0, baseCurrency)}>{formatDisplayCurrency(customer?.credit_limit || 0, baseCurrency)}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Credit Balance</p>
          <p className="text-xl font-bold text-blue-600 mt-1 truncate" title={formatDisplayCurrency(customer?.credit_balance || 0, baseCurrency)}>{formatDisplayCurrency(customer?.credit_balance || 0, baseCurrency)}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Lifetime Value</p>
          <p className="text-xl font-bold text-brand-600 mt-1 truncate" title={formatDisplayCurrency(customer?.lifetime_value || customer?.total_revenue || 0, baseCurrency)}>{formatDisplayCurrency(customer?.lifetime_value || customer?.total_revenue || 0, baseCurrency)}</p>
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Total Invoices</p>
          <p className="text-xl font-bold text-gray-800 mt-1 whitespace-nowrap">{customer?.total_invoices || 0}</p>
        </div>
      </div>

      {/* Quick Actions Bar */}
      <div className="bg-gradient-to-r from-brand-50 to-blue-50 rounded-xl border border-brand-200 p-4 mb-6">
        <div className="flex items-center gap-2 mb-3">
          <div className="h-6 w-6 rounded-full bg-brand-100 flex items-center justify-center">
            <Play className="h-3 w-3 text-brand-600" />
          </div>
          <span className="text-xs font-bold text-brand-700 uppercase tracking-wider">Quick Actions</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button onClick={() => navigate(`/billing/invoices/create?customer_id=${id}`)}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-brand-600 rounded-lg hover:bg-brand-700 shadow-sm transition-all hover:shadow-md">
            <FileText className="h-4 w-4" /> Create Invoice
          </button>
          <button onClick={() => navigate(`/billing/quotations?create=1&customer_id=${id}`)}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 shadow-sm transition-all hover:shadow-md">
            <FileText className="h-4 w-4" /> Create Quotation
          </button>
          <button onClick={() => navigate(`/billing/payments?create=1&customer_id=${id}`)}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 shadow-sm transition-all hover:shadow-md">
            <CreditCard className="h-4 w-4" /> Record Payment
          </button>
          <button onClick={() => navigate(`/billing/invoices/send?customer_id=${id}`)}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-amber-600 rounded-lg hover:bg-amber-700 shadow-sm transition-all hover:shadow-md">
            <Mail className="h-4 w-4" /> Send Invoice
          </button>
          <div className="w-px h-6 bg-brand-200 mx-1 hidden sm:block" />
          <button onClick={() => { setActiveTab('contacts'); setShowContactForm(true); }}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-brand-700 bg-white border border-brand-200 rounded-lg hover:bg-brand-50 transition-colors">
            <UserPlus className="h-4 w-4" /> Add Contact
          </button>
          <button onClick={() => { setActiveTab('notes'); setShowNoteForm(true); }}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-brand-700 bg-white border border-brand-200 rounded-lg hover:bg-brand-50 transition-colors">
            <StickyNote className="h-4 w-4" /> Add Note
          </button>
        </div>
      </div>

      <div className="border-b border-gray-200 mb-6">
        <nav className="flex gap-0 -mb-px overflow-x-auto">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`inline-flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
                  activeTab === tab.key
                    ? 'border-brand-600 text-brand-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                <Icon className="h-4 w-4" /> {tab.label}
              </button>
            );
          })}
        </nav>
      </div>

      {activeTab === 'overview' && (
        <div className="space-y-6">
          {/* Health + Insights Section */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Customer Health */}
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-1.5"><AlertCircle size={14} className="text-brand-500" /> {singular} Health</h4>
              {(() => {
                const hasOverdue = invoices.some((i) => i.status === 'overdue');
                const hasUnpaid = invoices.some((i) => i.status === 'unpaid' || i.status === 'sent');
                const nearCreditLimit = customer?.credit_limit > 0 && (customer?.outstanding_balance || 0) / customer.credit_limit >= 0.8;
                const isHealthy = customer?.status === 'active' && !hasOverdue && !nearCreditLimit;
                const needsAttention = customer?.status === 'active' && (hasOverdue || nearCreditLimit);
                let healthStatus, healthColor, healthBg;
                if (customer?.status === 'inactive' || customer?.status === 'suspended') {
                  healthStatus = 'Inactive'; healthColor = 'text-gray-600'; healthBg = 'bg-gray-100';
                } else if (isHealthy) {
                  healthStatus = 'Healthy'; healthColor = 'text-emerald-700'; healthBg = 'bg-emerald-100';
                } else if (needsAttention) {
                  healthStatus = 'Attention Required'; healthColor = 'text-amber-700'; healthBg = 'bg-amber-100';
                } else {
                  healthStatus = 'Pending'; healthColor = 'text-blue-700'; healthBg = 'bg-blue-100';
                }
                return (
                  <>
                    <div className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium ${healthBg} ${healthColor} mb-3`}>
                      <span className={`w-2 h-2 rounded-full ${healthColor === 'text-emerald-700' ? 'bg-emerald-500' : healthColor === 'text-amber-700' ? 'bg-amber-500' : healthColor === 'text-gray-600' ? 'bg-gray-400' : 'bg-blue-500'}`} />
                      {healthStatus}
                    </div>
                    {customer?.credit_limit > 0 && (
                      <div className="mb-3">
                        <div className="flex justify-between text-xs mb-1">
                          <span className="text-gray-500">Credit Utilization</span>
                          <span className={`font-medium ${((customer.outstanding_balance || 0) / customer.credit_limit * 100) >= 80 ? 'text-red-600' : ((customer.outstanding_balance || 0) / customer.credit_limit * 100) >= 50 ? 'text-amber-600' : 'text-emerald-600'}`}>
                            {((customer.outstanding_balance || 0) / customer.credit_limit * 100).toFixed(0)}%
                          </span>
                        </div>
                        <div className="w-full h-2 bg-gray-100 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full transition-all duration-500 ${
                            ((customer.outstanding_balance || 0) / customer.credit_limit * 100) >= 80 ? 'bg-red-500' :
                            ((customer.outstanding_balance || 0) / customer.credit_limit * 100) >= 50 ? 'bg-amber-500' : 'bg-emerald-500'
                          }`} style={{ width: `${Math.min(100, ((customer.outstanding_balance || 0) / customer.credit_limit * 100))}%` }} />
                        </div>
                      </div>
                    )}
                    <div className="space-y-2 text-xs">
                      <div className="flex justify-between"><span className="text-gray-500">Overdue Invoices</span><span className="font-medium text-gray-800">{invoices.filter((i) => i.status === 'overdue').length}</span></div>
                      <div className="flex justify-between"><span className="text-gray-500">Unpaid Invoices</span><span className="font-medium text-gray-800">{invoices.filter((i) => i.status === 'unpaid' || i.status === 'sent').length}</span></div>
                      <div className="flex justify-between"><span className="text-gray-500">Active Contracts</span><span className="font-medium text-gray-800">{contracts.filter((c) => c.status === 'active').length}</span></div>
                      <div className="flex justify-between"><span className="text-gray-500">Active Subscriptions</span><span className="font-medium text-gray-800">{subscriptions.filter((s) => s.status === 'active').length}</span></div>
                      <div className="flex justify-between"><span className="text-gray-500">Credit Balance</span><span className="font-medium text-gray-800">{formatDisplayCurrency(customer?.credit_balance || 0, baseCurrency)}</span></div>
                      <div className="flex justify-between"><span className="text-gray-500">Lifetime Value</span><span className="font-medium text-gray-800">{formatDisplayCurrency(customer?.lifetime_value || 0, baseCurrency)}</span></div>
                    </div>
                  </>
                );
              })()}
            </div>

            {/* Customer Insights */}
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-1.5"><BarChart3 size={14} className="text-brand-500" /> Insights</h4>
              {(() => {
                const thisYear = new Date().getFullYear();
                const invThisYear = invoices.filter((i) => {
                  const d = i.issue_date || i.created_at; return d && new Date(d).getFullYear() === thisYear;
                });
                const pmtThisYear = payments.filter((p) => {
                  const d = p.payment_date || p.created_at; return d && new Date(d).getFullYear() === thisYear;
                });
                const revenueThisYear = invThisYear.reduce((s, i) => s + Number(i.total || i.amount || 0), 0);
                const avgInvoice = invoices.length > 0 ? invoices.reduce((s, i) => s + Number(i.total || i.amount || 0), 0) / invoices.length : 0;
                const totalPmts = payments.length;
                const successfulPmts = payments.filter((p) => p.status === 'completed' || p.status === 'succeeded').length;
                const successRate = totalPmts > 0 ? (successfulPmts / totalPmts * 100).toFixed(0) : '—';
                return (
                  <div className="space-y-2 text-xs">
                    <div className="flex justify-between"><span className="text-gray-500">Invoices This Year</span><span className="font-medium text-gray-800">{invThisYear.length}</span></div>
                    <div className="flex justify-between"><span className="text-gray-500">Payments This Year</span><span className="font-medium text-gray-800">{pmtThisYear.length}</span></div>
                    <div className="flex justify-between"><span className="text-gray-500">Revenue This Year</span><span className="font-medium text-emerald-700">{formatDisplayCurrency(revenueThisYear, baseCurrency)}</span></div>
                    <div className="flex justify-between"><span className="text-gray-500">Avg Invoice Value</span><span className="font-medium text-gray-800">{formatDisplayCurrency(avgInvoice, baseCurrency)}</span></div>
                    <div className="flex justify-between"><span className="text-gray-500">Payment Success Rate</span><span className="font-medium text-gray-800">{successRate}{successRate !== '—' ? '%' : ''}</span></div>
                    <div className="flex justify-between"><span className="text-gray-500">Last Invoice</span><span className="font-medium text-gray-800">{invoices.length > 0 ? formatDisplayDate(invoices[0]?.issue_date || invoices[0]?.created_at) : '—'}</span></div>
                    <div className="flex justify-between"><span className="text-gray-500">Last Payment</span><span className="font-medium text-gray-800">{payments.length > 0 ? formatDisplayDate(payments[0]?.payment_date || payments[0]?.created_at) : '—'}</span></div>
                  </div>
                );
              })()}
            </div>

            {/* Activity Timeline */}
            <div className="bg-white rounded-xl border border-gray-200 p-5">
              <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3 flex items-center gap-1.5"><Activity size={14} className="text-brand-500" /> Activity Timeline</h4>
              {activityLoading ? (
                <div className="flex items-center justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-gray-300" /></div>
              ) : activityError ? (
                <p className="text-xs text-red-500 text-center py-6 flex items-center justify-center gap-1.5"><AlertCircle size={13} /> {activityError}</p>
              ) : activity.length === 0 ? (
                <p className="text-xs text-gray-400 text-center py-6">No recent activity</p>
              ) : (
                <div className="space-y-3">
                  {activity.slice(0, 10).map((entry) => {
                    const actionIcons = {
                      create: <Plus className="h-3 w-3" />,
                      update: <Pencil className="h-3 w-3" />,
                      delete: <Trash2 className="h-3 w-3" />,
                      activate: <Play className="h-3 w-3" />,
                      deactivate: <Ban className="h-3 w-3" />,
                      send: <Mail className="h-3 w-3" />,
                      payment: <DollarSign className="h-3 w-3" />,
                    };
                    const actionColors = {
                      create: 'bg-emerald-100 text-emerald-600',
                      update: 'bg-blue-100 text-blue-600',
                      delete: 'bg-red-100 text-red-600',
                      activate: 'bg-emerald-100 text-emerald-600',
                      deactivate: 'bg-gray-100 text-gray-600',
                      send: 'bg-brand-100 text-brand-600',
                      payment: 'bg-amber-100 text-amber-600',
                    };
                    const actionKey = entry.action?.toLowerCase() || '';
                    const icon = actionIcons[actionKey] || <Clock className="h-3 w-3" />;
                    const color = actionColors[actionKey] || 'bg-gray-100 text-gray-600';
                    return (
                      <div key={entry.id} className="flex items-start gap-2.5 text-xs">
                        <div className={`h-5 w-5 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5 ${color}`}>
                          {icon}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-gray-700">
                            {entry.action ? entry.action.charAt(0).toUpperCase() + entry.action.slice(1) : 'Activity'}
                            {entry.entity_type && <span className="text-gray-400 font-normal"> · {entry.entity_type}{entry.entity_id ? ` #${entry.entity_id}` : ''}</span>}
                          </p>
                          {entry.changes ? <p className="text-gray-400 mt-0.5 truncate">{typeof entry.changes === "string" ? entry.changes : JSON.stringify(entry.changes)}</p> : entry.details ? <p className="text-gray-400 mt-0.5 truncate">{entry.details}</p> : null}
                          <p className="text-gray-400 mt-0.5">{formatDisplayDate(entry.timestamp || entry.created_at)}</p>
                        </div>
                      </div>
                    );
                  })}
                  {activity.length > 10 && (
                    <button onClick={() => setActiveTab('timeline')} className="text-brand-600 hover:text-brand-700 text-xs font-medium">View all →</button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Financial Overview */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4 flex items-center gap-1.5"><DollarSign size={14} className="text-brand-500" /> Financial Overview</h3>
            {analyticsLoading ? (
              <div className="flex items-center justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-gray-300" /></div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                <div className="bg-brand-50 rounded-lg p-4">
                  <p className="text-[10px] font-medium text-brand-600 uppercase">Lifetime Value</p>
                  <p className="text-lg font-bold text-brand-700 mt-1 truncate" title={formatDisplayCurrency(analytics?.total_revenue || customer?.lifetime_value || customer?.total_revenue || 0, baseCurrency)}>{formatDisplayCurrency(analytics?.total_revenue || customer?.lifetime_value || customer?.total_revenue || 0, baseCurrency)}</p>
                </div>
                <div className="bg-emerald-50 rounded-lg p-4">
                  <p className="text-[10px] font-medium text-emerald-600 uppercase">Total Paid</p>
                  <p className="text-lg font-bold text-emerald-700 mt-1 truncate" title={formatDisplayCurrency(analytics?.total_paid || 0, baseCurrency)}>{formatDisplayCurrency(analytics?.total_paid || 0, baseCurrency)}</p>
                </div>
                <div className="bg-amber-50 rounded-lg p-4">
                  <p className="text-[10px] font-medium text-amber-600 uppercase">Outstanding Balance</p>
                  <p className="text-lg font-bold text-amber-700 mt-1 truncate" title={formatDisplayCurrency(analytics?.outstanding_balance || customer?.outstanding_balance || 0, baseCurrency)}>{formatDisplayCurrency(analytics?.outstanding_balance || customer?.outstanding_balance || 0, baseCurrency)}</p>
                </div>
                <div className="bg-blue-50 rounded-lg p-4">
                  <p className="text-[10px] font-medium text-blue-600 uppercase">Credit Balance</p>
                  <p className="text-lg font-bold text-blue-700 mt-1 truncate" title={formatDisplayCurrency(customer?.credit_balance || 0, baseCurrency)}>{formatDisplayCurrency(customer?.credit_balance || 0, baseCurrency)}</p>
                </div>
                <div className="bg-gray-50 rounded-lg p-4">
                  <p className="text-[10px] font-medium text-gray-500 uppercase">Last Invoice Date</p>
                  <p className="text-sm font-bold text-gray-800 mt-1">{invoices.length > 0 ? formatDisplayDate(invoices[0]?.issue_date || invoices[0]?.created_at) : '—'}</p>
                </div>
                <div className="bg-gray-50 rounded-lg p-4">
                  <p className="text-[10px] font-medium text-gray-500 uppercase">Last Payment Date</p>
                  <p className="text-sm font-bold text-gray-800 mt-1">{payments.length > 0 ? formatDisplayDate(payments[0]?.payment_date || payments[0]?.created_at) : '—'}</p>
                </div>
              </div>
            )}
          </div>

          {/* Existing Detail Sections */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-lg font-semibold text-gray-900">{singular} Details</h3>
              <div className="flex items-center gap-2">
                {editing ? (
                  <>
                    <button onClick={() => { setEditing(false); setEditForm({
                      display_name: customer?.display_name || customer?.company_name || '',
                      company_name: customer?.company_name || '',
                      legal_name: customer?.legal_name || '',
                      first_name: customer?.first_name || '',
                      last_name: customer?.last_name || '',
                      email: customer?.email || '',
                      alternate_email: customer?.alternate_email || '',
                      phone: customer?.phone || '',
                      mobile: customer?.mobile || '',
                      website: customer?.website || '',
                      designation: customer?.designation || '',
                      industry: customer?.industry || '',
                      employee_count: customer?.employee_count || '',
                      customer_type: customer?.customer_type || 'business',
                      billing_address: customer?.billing_address || '',
                      shipping_address: customer?.shipping_address || '',
                      billing_country: customer?.billing_country || '',
                      shipping_country: customer?.shipping_country || '',
                      shipping_same_as_billing: false,
                      gst_number: customer?.gst_number || '',
                      vat_number: customer?.vat_number || '',
                      pan: customer?.pan || '',
                      tin: customer?.tin || '',
                      tax_id: customer?.tax_id || '',
                      tax_id_type: customer?.tax_id_type || '',
                      tax_category: customer?.tax_category || '',
                      currency: customer?.currency || '',
                      payment_terms: customer?.payment_terms || 'net_30',
                      credit_limit: customer?.credit_limit != null ? customer.credit_limit : '',
                      credit_days: customer?.credit_days != null ? customer.credit_days : 30,
                      price_list: customer?.price_list || '',
                      tags: customer?.tags || [],
                      notes: customer?.notes || '',
                    }); }}
                      className="px-3 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors">
                      Cancel
                    </button>
                    <button onClick={handleSave} disabled={saving}
                      className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors">
                      {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />} Save Changes
                    </button>
                  </>
                ) : (
                  <button onClick={() => setEditing(true)}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-brand-600 bg-brand-50 rounded-lg hover:bg-brand-100 transition-colors">
                    <Pencil className="h-4 w-4" /> Edit
                  </button>
                )}
              </div>
            </div>

            {/* Company Information Section */}
            <div className="mb-8">
              <h4 className="text-sm font-semibold text-gray-900 flex items-center gap-2 mb-4"><Building2 size={16} className="text-brand-500" /> Company Information</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                <InlineEditField label="Display Name" value={editForm.display_name} editing={editing} onChange={(v) => setEditForm({ ...editForm, display_name: v })} />
                <InlineEditField label="Company Name" value={editForm.company_name} editing={editing} onChange={(v) => setEditForm({ ...editForm, company_name: v })} />
                <InlineEditField label="Legal Name" value={editForm.legal_name} editing={editing} onChange={(v) => setEditForm({ ...editForm, legal_name: v })} />
                {!editing && <InlineEditField label="Customer Code" value={customer?.customer_code} editing={false} />}
                {editing ? (
                  <div>
                    <label className="text-xs font-medium text-gray-500 uppercase tracking-wider">Customer Type</label>
                    <select value={editForm.customer_type}
                      onChange={(v) => setEditForm({ ...editForm, customer_type: v.target.value })}
                      className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
                      {CUSTOMER_TYPES.map((t) => (
                        <option key={t} value={t}>{t.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}</option>
                      ))}
                    </select>
                  </div>
                ) : (
                  <InlineEditField label="Customer Type" value={customer?.customer_type ? customer.customer_type.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '—'} editing={false} />
                )}
                {editing && (
                  <>
                    <InlineEditField label="First Name" value={editForm.first_name} editing onChange={(v) => setEditForm({ ...editForm, first_name: v })} />
                    <InlineEditField label="Last Name" value={editForm.last_name} editing onChange={(v) => setEditForm({ ...editForm, last_name: v })} />
                  </>
                )}
                {!editing && (customer?.first_name || customer?.last_name) && (
                  <InlineEditField label="Contact Person" value={`${customer.first_name || ''} ${customer.last_name || ''}`.trim()} editing={false} />
                )}
                <InlineEditField label="Industry" value={editing ? editForm.industry : (customer?.industry || '—')} editing={editing} onChange={(v) => setEditForm({ ...editForm, industry: v })} />
                {editing ? (
                  <div>
                    <label className="text-xs font-medium text-gray-500 uppercase tracking-wider">Employee Count</label>
                    <input type="number" min="0" value={editForm.employee_count}
                      onChange={(v) => setEditForm({ ...editForm, employee_count: v.target.value })}
                      className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                  </div>
                ) : customer?.employee_count ? (
                  <InlineEditField label="Employee Count" value={String(customer.employee_count)} editing={false} />
                ) : null}
                <InlineEditField label="Designation" value={editing ? editForm.designation : (customer?.designation || '—')} editing={editing} onChange={(v) => setEditForm({ ...editForm, designation: v })} />
              </div>
            </div>

            {/* Contact Information Section */}
            <div className="mb-8 pt-6 border-t border-gray-100">
              <h4 className="text-sm font-semibold text-gray-900 flex items-center gap-2 mb-4"><Mail size={16} className="text-brand-500" /> Contact Information</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                <InlineEditField label="Email" value={editForm.email} editing={editing} onChange={(v) => setEditForm({ ...editForm, email: v })} type="email" />
                <InlineEditField label="Alternate Email" value={editing ? editForm.alternate_email : (customer?.alternate_email || '—')} editing={editing} onChange={(v) => setEditForm({ ...editForm, alternate_email: v })} type="email" />
                <InlineEditField label="Phone" value={editForm.phone} editing={editing} onChange={(v) => setEditForm({ ...editForm, phone: v })} />
                <InlineEditField label="Mobile" value={editing ? editForm.mobile : (customer?.mobile || '—')} editing={editing} onChange={(v) => setEditForm({ ...editForm, mobile: v })} />
                <InlineEditField label="Website" value={editForm.website} editing={editing} onChange={(v) => setEditForm({ ...editForm, website: v })} />
              </div>
            </div>

            {/* Billing Profile Section */}
            <div className="mb-8 pt-6 border-t border-gray-100">
              <h4 className="text-sm font-semibold text-gray-900 flex items-center gap-2 mb-4"><CreditCard size={16} className="text-brand-500" /> Billing Profile</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {editing ? (
                  <>
                    <div>
                      <label className="text-xs font-medium text-gray-500 uppercase tracking-wider">Default Currency</label>
                      <select value={editForm.currency}
                        onChange={(v) => setEditForm({ ...editForm, currency: v.target.value })}
                        className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
                        <option value="">Select currency</option>
                        {getCurrencySelectOptions().map((c) => (
                          <option key={c.value} value={c.value}>{c.value} - {c.label}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-500 uppercase tracking-wider">Payment Terms</label>
                      <select value={editForm.payment_terms}
                        onChange={(v) => {
                          const terms = v.target.value;
                          const TERMS_MAP = { due_on_receipt: 0, net_15: 15, net_30: 30, net_45: 45, net_60: 60, net_90: 90 };
                          setEditForm({ ...editForm, payment_terms: terms, credit_days: TERMS_MAP[terms] ?? 30 });
                        }}
                        className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
                        <option value="due_on_receipt">Due on Receipt</option>
                        <option value="net_15">Net 15</option>
                        <option value="net_30">Net 30</option>
                        <option value="net_45">Net 45</option>
                        <option value="net_60">Net 60</option>
                        <option value="net_90">Net 90</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-500 uppercase tracking-wider">Credit Limit</label>
                      <input type="number" min="0" step="0.01" value={editForm.credit_limit}
                        onChange={(v) => setEditForm({ ...editForm, credit_limit: v.target.value })}
                        className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                    </div>
                    <div>
                      <label className="text-xs font-medium text-gray-500 uppercase tracking-wider">Credit Days</label>
                      <input type="number" min="0" step="1" value={editForm.credit_days ?? ''}
                        onChange={(v) => setEditForm({ ...editForm, credit_days: v.target.value === '' ? '' : Math.max(0, parseInt(v.target.value, 10) || 0) })}
                        className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                    </div>
                  </>
                ) : (
                  <>
                    <InlineEditField label="Default Currency" value={customer?.currency || orgConfig?.base_currency || orgConfig?.default_currency || '—'} editing={false} />
                    <InlineEditField label="Payment Terms" value={customer?.payment_terms ? customer.payment_terms.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : 'Net 30'} editing={false} />
                    <InlineEditField label="Credit Limit" value={customer?.credit_limit != null ? formatDisplayCurrency(customer.credit_limit, baseCurrency) : '—'} editing={false} />
                    <InlineEditField label="Credit Days" value={customer?.credit_days != null ? String(customer.credit_days) : '—'} editing={false} />
                    <InlineEditField label="Price List" value={customer?.price_list || '—'} editing={false} />
                  </>
                )}
              </div>
            </div>

            {/* Addresses Section */}
            <div className="mb-8 pt-6 border-t border-gray-100">
              <h4 className="text-sm font-semibold text-gray-900 flex items-center gap-2 mb-4"><MapPin size={16} className="text-brand-500" /> Addresses</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  {editing ? (
                    <>
                      <label className="text-xs font-medium text-gray-500 uppercase tracking-wider">Billing Address</label>
                      <textarea rows={3} value={editForm.billing_address}
                        onChange={(v) => setEditForm({ ...editForm, billing_address: v.target.value })}
                        className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                      <div className="mt-3">
                        <label className="text-xs font-medium text-gray-500 uppercase tracking-wider">Billing Country</label>
                        <select value={editForm.billing_country || ''} onChange={(e) => { const country = e.target.value; const curInfo = getCurrencyForCountry(country); setEditForm((p) => ({ ...p, billing_country: country, shipping_country: p.shipping_same_as_billing ? country : p.shipping_country, currency: p.currency || (curInfo ? curInfo.code : p.currency) })); }}
                          className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
                          <option value="">Select Country</option>
                          {getCountrySelectOptions().map((c) => (<option key={c.code} value={c.value}>{c.label}</option>))}
                        </select>
                      </div>
                    </>
                  ) : (
                    <>
                      <InlineEditField label="Billing Address" value={customer?.billing_address || '—'} editing={false} />
                      {customer?.billing_country && <p className="text-sm text-slate-600">{customer.billing_country}</p>}
                    </>
                  )}
                </div>
                <div>
                  {editing ? (
                    <>
                      <label className="flex items-center gap-2 text-xs text-gray-500 mb-2">
                        <input type="checkbox" checked={editForm.shipping_same_as_billing}
                          onChange={(e) => setEditForm({ ...editForm, shipping_same_as_billing: e.target.checked, shipping_address: e.target.checked ? editForm.billing_address : (customer?.shipping_address || ''), shipping_country: e.target.checked ? editForm.billing_country : (customer?.shipping_country || '') })}
                          className="rounded border-gray-300 text-brand-600 focus:ring-brand/30" />
                        Same as Billing Address
                      </label>
                      {!editForm.shipping_same_as_billing && (
                        <>
                          <label className="text-xs font-medium text-gray-500 uppercase tracking-wider">Shipping Address</label>
                          <textarea rows={3} value={editForm.shipping_address}
                            onChange={(v) => setEditForm({ ...editForm, shipping_address: v.target.value })}
                            className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                          <div className="mt-3">
                            <label className="text-xs font-medium text-gray-500 uppercase tracking-wider">Shipping Country</label>
                            <select value={editForm.shipping_country || ''} onChange={(e) => setEditForm((p) => ({ ...p, shipping_country: e.target.value }))}
                              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
                              <option value="">Select Country</option>
                              {getCountrySelectOptions().map((c) => (<option key={c.code} value={c.value}>{c.label}</option>))}
                            </select>
                          </div>
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      <InlineEditField label="Shipping Address" value={customer?.shipping_address === customer?.billing_address && customer?.shipping_address ? 'Same as Billing Address' : (customer?.shipping_address || '—')} editing={false} />
                      {customer?.shipping_country && <p className="text-sm text-slate-600">{customer.shipping_country}</p>}
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Tax Information Section */}
            <div className="mb-8 pt-6 border-t border-gray-100">
              <h4 className="text-sm font-semibold text-gray-900 flex items-center gap-2 mb-4"><Building2 size={16} className="text-brand-500" /> Tax Information</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {getCustomerTaxFields(editing ? editForm.billing_country : customer?.billing_country).map((f) => (
                  <InlineEditField
                    key={f.key}
                    label={f.label}
                    value={editing ? editForm[f.key] : (customer?.[f.key] || '—')}
                    editing={editing}
                    onChange={(v) => setEditForm({ ...editForm, [f.key]: v })}
                  />
                ))}
                {editing && !editForm.billing_country && (
                  <p className="lg:col-span-3 text-xs text-gray-400">Set a billing country in Addresses above to show its relevant tax identifier(s).</p>
                )}
                <InlineEditField label="Tax ID Type" value={editing ? editForm.tax_id_type : (customer?.tax_id_type || '—')} editing={editing} onChange={(v) => setEditForm({ ...editForm, tax_id_type: v })} />
                <InlineEditField label="Tax Category" value={editing ? editForm.tax_category : (customer?.tax_category || '—')} editing={editing} onChange={(v) => setEditForm({ ...editForm, tax_category: v })} />
              </div>
            </div>

            {/* Tags Section */}
            <div className="mb-8 pt-6 border-t border-gray-100">
              <h4 className="text-sm font-semibold text-gray-900 flex items-center gap-2 mb-4"><Tag size={16} className="text-brand-500" /> Tags</h4>
              {editing ? (
                <div>
                  <div className="flex flex-wrap gap-2 mb-3">
                    {(Array.isArray(editForm.tags) ? editForm.tags : []).map((tag, i) => (
                      <TagBadge key={i} tag={tag} onRemove={(t) => setEditForm({ ...editForm, tags: editForm.tags.filter((x) => x !== t) })} />
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <input value={tagInput} onChange={(e) => setTagInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && tagInput.trim()) {
                          e.preventDefault();
                          if (!(Array.isArray(editForm.tags) ? editForm.tags : []).includes(tagInput.trim())) {
                            setEditForm({ ...editForm, tags: [...(editForm.tags || []), tagInput.trim()] });
                          }
                          setTagInput('');
                        }
                      }}
                      placeholder="Type a tag and press Enter"
                      className="block w-full max-w-xs rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                    <button type="button" onClick={() => {
                      if (tagInput.trim() && !(Array.isArray(editForm.tags) ? editForm.tags : []).includes(tagInput.trim())) {
                        setEditForm({ ...editForm, tags: [...(editForm.tags || []), tagInput.trim()] });
                      }
                      setTagInput('');
                    }} className="px-3 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors">
                      Add
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {Array.isArray(customer?.tags) && customer.tags.length > 0
                    ? customer.tags.map((tag, i) => <TagBadge key={i} tag={tag} />)
                    : <span className="text-sm text-gray-400">No tags</span>}
                </div>
              )}
            </div>

            {/* Account Summary Section */}
            <div className="pt-6 border-t border-gray-100">
              <h4 className="text-sm font-semibold text-gray-900 mb-4">Account Summary</h4>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-gray-50 rounded-lg p-4">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Created</p>
                  <p className="text-sm font-semibold text-gray-900 mt-1">{formatDisplayDate(customer?.created_at || customer?.createdAt)}</p>
                </div>
                <div className="bg-gray-50 rounded-lg p-4">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Updated</p>
                  <p className="text-sm font-semibold text-gray-900 mt-1">{formatDisplayDate(customer?.updated_at || customer?.updatedAt)}</p>
                </div>
                <div className="bg-gray-50 rounded-lg p-4">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Total Invoices</p>
                  <p className="text-sm font-semibold text-gray-900 mt-1">{invoices.length}</p>
                </div>
                <div className="bg-gray-50 rounded-lg p-4">
                  <p className="text-xs font-medium text-gray-500 uppercase tracking-wider">Status</p>
                  <p className="text-sm font-semibold text-gray-900 mt-1">
                    <StatusBadge status={customer?.status} />
                  </p>
                </div>
              </div>
            </div>

            {customer?.notes && (
              <div className="mt-6 pt-6 border-t border-gray-100">
                <h4 className="text-sm font-semibold text-gray-900 mb-2">Notes</h4>
                {editing ? (
                  <textarea rows={2} value={editForm.notes}
                    onChange={(v) => setEditForm({ ...editForm, notes: v.target.value })}
                    className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                ) : (
                  <p className="text-sm text-gray-600 whitespace-pre-wrap">{customer?.notes || '—'}</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'contacts' && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
            <h3 className="text-lg font-semibold text-gray-900">Contacts ({contacts.length})</h3>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <input value={contactSearch} onChange={(e) => setContactSearch(e.target.value)}
                  placeholder="Search contacts..." className="pl-9 pr-8 py-2 text-sm border border-gray-300 rounded-lg transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30 w-52" />
                {contactSearch && <button onClick={() => setContactSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600" aria-label="Clear search"><X className="h-4 w-4" /></button>}
              </div>
              <button onClick={() => { setShowContactForm(true); setEditingContactId(null); setContactForm({ first_name: '', last_name: '', email: '', phone: '', job_title: '', department: '', is_primary: false }); }}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors">
                <Plus className="h-4 w-4" /> Add Contact
              </button>
            </div>
          </div>

          {contactsError && (
            <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2">
              <AlertCircle className="h-4 w-4 flex-shrink-0" /> {contactsError}
            </div>
          )}

          {showContactForm && (
            <form onSubmit={handleSaveContact} className="mb-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
              <h4 className="text-sm font-semibold text-gray-900 mb-3">{editingContactId ? 'Edit Contact' : 'Add Contact'}</h4>
              {contactFormError && (
                <p className="mb-3 text-xs text-red-600">{contactFormError}</p>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">First Name *</label>
                  <input required value={contactForm.first_name} onChange={(e) => setContactForm({ ...contactForm, first_name: e.target.value })}
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Last Name *</label>
                  <input required value={contactForm.last_name} onChange={(e) => setContactForm({ ...contactForm, last_name: e.target.value })}
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Email *</label>
                  <input type="email" required value={contactForm.email} onChange={(e) => setContactForm({ ...contactForm, email: e.target.value })}
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Phone</label>
                  <input value={contactForm.phone} onChange={(e) => setContactForm({ ...contactForm, phone: e.target.value })}
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Job Title</label>
                  <input value={contactForm.job_title} onChange={(e) => setContactForm({ ...contactForm, job_title: e.target.value })}
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Department</label>
                  <select value={contactForm.department} onChange={(e) => setContactForm({ ...contactForm, department: e.target.value })}
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
                    <option value="">Select department</option>
                    <option value="Billing">Billing</option>
                    <option value="Finance">Finance</option>
                    <option value="Purchasing">Purchasing</option>
                    <option value="Technical">Technical</option>
                    <option value="Management">Management</option>
                    <option value="Other">Other</option>
                  </select>
                </div>
              </div>
              <div className="flex items-center gap-2 mt-3">
                <input type="checkbox" id="is_primary" checked={contactForm.is_primary}
                  onChange={(e) => setContactForm({ ...contactForm, is_primary: e.target.checked })}
                  className="rounded border-gray-300 text-brand-600 focus:ring-brand/30" />
                <label htmlFor="is_primary" className="text-sm text-gray-700">Set as primary contact</label>
              </div>
              <div className="flex gap-2 mt-4">
                <button type="submit" disabled={contactSaving}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors">
                  {contactSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />} {editingContactId ? 'Update' : 'Add'} Contact
                </button>
                <button type="button" onClick={() => { setShowContactForm(false); setEditingContactId(null); setContactFormError(null); }}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors">
                  Cancel
                </button>
              </div>
            </form>
          )}

          {contactsLoading ? (
            <Spinner />
          ) : contacts.length === 0 ? (
            <EmptyState icon={Mail} title="No contacts" message="Add a contact to get started." />
          ) : (() => {
            const filteredContacts = contactSearch
              ? contacts.filter((c) =>
                  `${c.first_name} ${c.last_name} ${c.email} ${c.phone || ''} ${c.job_title || ''} ${c.department || ''}`
                    .toLowerCase().includes(contactSearch.toLowerCase())
                )
              : contacts;
            if (filteredContacts.length === 0) {
              return <EmptyState icon={Search} title="No matching contacts" message="Try adjusting your search." />;
            }
            return (
            <>
              {contactSearch && (
                <p className="text-xs text-gray-400 mb-2">
                  Showing {filteredContacts.length} of {contacts.length} contacts
                </p>
              )}
              <div className="space-y-3">
              {filteredContacts.map((contact) => (
                <div key={contact.id || contact._id} className="flex items-center justify-between p-4 bg-gray-50 rounded-lg border border-gray-100">
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-full bg-brand-100 flex items-center justify-center">
                      <User className="h-4 w-4 text-brand-600" />
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <p className="text-sm font-medium text-gray-900">{contact.first_name} {contact.last_name}</p>
                        {contact.is_primary && <Star className="h-3.5 w-3.5 text-amber-400" />}
                      </div>
                      <p className="text-xs text-gray-500">{contact.email}{contact.phone ? ` · ${contact.phone}` : ''}{contact.job_title ? ` · ${contact.job_title}` : ''}{contact.department ? ` · ${contact.department}` : ''}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    {!contact.is_primary && (
                      <button onClick={() => handleSetPrimaryContact(contact.id)} title="Set primary" aria-label="Set as primary contact"
                        className="p-1.5 text-gray-400 hover:text-amber-500 rounded-lg hover:bg-amber-50 transition-colors">
                        <Star className="h-4 w-4" />
                      </button>
                    )}
                    <button onClick={() => { setEditingContactId(contact.id); setContactForm({ first_name: contact.first_name || '', last_name: contact.last_name || '', email: contact.email, phone: contact.phone || '', job_title: contact.job_title || '', department: contact.department || '', is_primary: contact.is_primary || false }); setShowContactForm(true); }}
                      className="p-1.5 text-gray-400 hover:text-brand-600 rounded-lg hover:bg-brand-50 transition-colors" aria-label="Edit contact">
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button onClick={() => openConfirm('Remove Contact', 'Are you sure you want to remove this contact? This action cannot be undone.', () => handleRemoveContact(contact.id))}
                      className="p-1.5 text-gray-400 hover:text-red-600 rounded-lg hover:bg-red-50 transition-colors" aria-label="Delete contact">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            </>
            );
          })()}
        </div>
      )}

      {activeTab === 'payment-methods' && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">Payment Methods</h3>
            <button onClick={() => { setShowPmForm(true); setEditingPmId(null); setPmForm({ type: 'card', last_four: '', expiry_date: '', cardholder_name: '', is_default: false }); }}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors">
              <Plus className="h-4 w-4" /> Add Method
            </button>
          </div>

          {paymentMethodsError && (
            <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2">
              <AlertCircle className="h-4 w-4 flex-shrink-0" /> {paymentMethodsError}
            </div>
          )}

          {showPmForm && (
            <form onSubmit={handleSavePm} className="mb-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
              <h4 className="text-sm font-semibold text-gray-900 mb-3">{editingPmId ? 'Edit Payment Method' : 'Add Payment Method'}</h4>
              {pmFormError && (
                <p className="mb-3 text-xs text-red-600">{pmFormError}</p>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Type *</label>
                  <select required value={pmForm.type} onChange={(e) => setPmForm({ ...pmForm, type: e.target.value })}
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30">
                    <option value="card">Card</option>
                    <option value="bank_account">Bank Account</option>
                    <option value="paypal">PayPal</option>
                    <option value="other">Other</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Cardholder Name</label>
                  <input value={pmForm.cardholder_name} onChange={(e) => setPmForm({ ...pmForm, cardholder_name: e.target.value })}
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Last Four *</label>
                  <input required maxLength={4} value={pmForm.last_four} onChange={(e) => setPmForm({ ...pmForm, last_four: e.target.value })}
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Expiry Date</label>
                  <input placeholder="MM/YY" value={pmForm.expiry_date} onChange={(e) => setPmForm({ ...pmForm, expiry_date: e.target.value })}
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
              </div>
              <div className="flex items-center gap-2 mt-3">
                <input type="checkbox" id="pm_default" checked={pmForm.is_default}
                  onChange={(e) => setPmForm({ ...pmForm, is_default: e.target.checked })}
                  className="rounded border-gray-300 text-brand-600 focus:ring-brand/30" />
                <label htmlFor="pm_default" className="text-sm text-gray-700">Set as default method</label>
              </div>
              <div className="flex gap-2 mt-4">
                <button type="submit" disabled={pmSaving}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors">
                  {pmSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />} {editingPmId ? 'Update' : 'Add'} Method
                </button>
                <button type="button" onClick={() => { setShowPmForm(false); setEditingPmId(null); setPmFormError(null); }}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors">
                  Cancel
                </button>
              </div>
            </form>
          )}

          {paymentMethodsLoading ? (
            <Spinner />
          ) : paymentMethods.length === 0 ? (
            <EmptyState icon={CreditCard} title="No payment methods" message="Add a payment method to get started." />
          ) : (
            <div className="space-y-3">
              {paymentMethods.map((pm) => (
                <div key={pm.id || pm._id} className="flex items-center justify-between p-4 bg-gray-50 rounded-lg border border-gray-100">
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-full bg-blue-100 flex items-center justify-center">
                      <CreditCard className="h-4 w-4 text-blue-600" />
                    </div>
                    <div>
                      <div className="flex items-center gap-1.5">
                        <p className="text-sm font-medium text-gray-900">
                          {pm.type === 'card' ? '•••• ' : ''}{pm.last_four || pm.lastFour || pm.last_four_digits}
                        </p>
                        {pm.is_default && <span className="text-[10px] font-medium text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">Default</span>}
                      </div>
                      <p className="text-xs text-gray-500">{pm.cardholder_name}{pm.expiry_date ? ` · Exp: ${pm.expiry_date}` : ''}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    {!pm.is_default && (
                      <button onClick={() => handleSetDefaultPm(pm.id)} title="Set default" aria-label="Set as default payment method"
                        className="p-1.5 text-gray-400 hover:text-amber-500 rounded-lg hover:bg-amber-50 transition-colors">
                        <Star className="h-4 w-4" />
                      </button>
                    )}
                    <button onClick={() => { setEditingPmId(pm.id); setPmForm({ type: pm.type, last_four: pm.last_four || pm.lastFour || '', expiry_date: pm.expiry_date || '', cardholder_name: pm.cardholder_name || '', is_default: pm.is_default }); setShowPmForm(true); }}
                      className="p-1.5 text-gray-400 hover:text-brand-600 rounded-lg hover:bg-brand-50 transition-colors" aria-label="Edit payment method">
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button onClick={() => openConfirm('Remove Payment Method', 'Are you sure you want to remove this payment method?', () => handleRemovePm(pm.id))}
                      className="p-1.5 text-gray-400 hover:text-red-600 rounded-lg hover:bg-red-50 transition-colors" aria-label="Delete payment method">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'billing-overview' && (
        <div className="space-y-6">
          {/* Financial Summary */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-4 flex items-center gap-1.5"><BarChart3 size={14} className="text-brand-500" /> Billing Summary</h4>
            {(() => {
              const totalOutstanding = invoices.filter((i) => i.status === 'unpaid' || i.status === 'sent' || i.status === 'overdue').reduce((s, i) => s + Number(i.total || i.amount || 0), 0);
              const totalPaid = invoices.filter((i) => i.status === 'paid').reduce((s, i) => s + Number(i.total || i.amount || 0), 0);
              const totalOverdue = invoices.filter((i) => i.status === 'overdue').reduce((s, i) => s + Number(i.total || i.amount || 0), 0);
              const totalDraft = invoices.filter((i) => i.status === 'draft').reduce((s, i) => s + Number(i.total || i.amount || 0), 0);
              const totalCancelled = invoices.filter((i) => i.status === 'cancelled' || i.status === 'void').reduce((s, i) => s + Number(i.total || i.amount || 0), 0);
              const avgPaymentDays = payments.length > 0 && invoices.length > 0 ? Math.round(payments.reduce((s, p) => {
                const inv = invoices.find((i) => i.id === p.invoice_id);
                if (inv && inv.issue_date && p.payment_date) {
                  return s + Math.round((new Date(p.payment_date) - new Date(inv.issue_date)) / (1000 * 60 * 60 * 24));
                }
                return s;
              }, 0) / Math.min(payments.length, invoices.length)) : '—';
              const creditUsed = customer?.credit_limit > 0 ? ((customer.outstanding_balance || 0) / customer.credit_limit * 100).toFixed(0) : '—';
              const availableCredit = customer?.credit_limit > 0 ? Math.max(0, Number(customer.credit_limit) - Number(customer.outstanding_balance || 0)) : '—';
              return (
                <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
                  <div className="bg-gray-50 rounded-lg p-4"><p className="text-[10px] font-medium text-gray-500 uppercase">Outstanding</p><p className="text-sm font-bold text-amber-600 mt-0.5 truncate" title={formatDisplayCurrency(totalOutstanding, baseCurrency)}>{formatDisplayCurrency(totalOutstanding, baseCurrency)}</p></div>
                  <div className="bg-gray-50 rounded-lg p-4"><p className="text-[10px] font-medium text-gray-500 uppercase">Paid</p><p className="text-sm font-bold text-emerald-600 mt-0.5 truncate" title={formatDisplayCurrency(totalPaid, baseCurrency)}>{formatDisplayCurrency(totalPaid, baseCurrency)}</p></div>
                  <div className="bg-gray-50 rounded-lg p-4"><p className="text-[10px] font-medium text-gray-500 uppercase">Overdue</p><p className="text-sm font-bold text-red-600 mt-0.5 truncate" title={formatDisplayCurrency(totalOverdue, baseCurrency)}>{formatDisplayCurrency(totalOverdue, baseCurrency)}</p></div>
                  <div className="bg-gray-50 rounded-lg p-4"><p className="text-[10px] font-medium text-gray-500 uppercase">Draft</p><p className="text-sm font-bold text-gray-600 mt-0.5 truncate" title={formatDisplayCurrency(totalDraft, baseCurrency)}>{formatDisplayCurrency(totalDraft, baseCurrency)}</p></div>
                  <div className="bg-gray-50 rounded-lg p-4"><p className="text-[10px] font-medium text-gray-500 uppercase">Cancelled</p><p className="text-sm font-bold text-gray-400 mt-0.5 truncate" title={formatDisplayCurrency(totalCancelled, baseCurrency)}>{formatDisplayCurrency(totalCancelled, baseCurrency)}</p></div>
                  <div className="bg-gray-50 rounded-lg p-4"><p className="text-[10px] font-medium text-gray-500 uppercase">Avg Payment Days</p><p className="text-sm font-bold text-gray-800 mt-0.5 whitespace-nowrap">{avgPaymentDays !== '—' ? `${avgPaymentDays} days` : '—'}</p></div>
                  <div className="bg-gray-50 rounded-lg p-4"><p className="text-[10px] font-medium text-gray-500 uppercase">Credit Limit</p><p className="text-sm font-bold text-gray-800 mt-0.5 truncate" title={formatDisplayCurrency(customer?.credit_limit || 0, baseCurrency)}>{formatDisplayCurrency(customer?.credit_limit || 0, baseCurrency)}</p></div>
                  <div className="bg-gray-50 rounded-lg p-4"><p className="text-[10px] font-medium text-gray-500 uppercase">Credit Used</p><p className="text-sm font-bold text-gray-800 mt-0.5 whitespace-nowrap">{creditUsed !== '—' ? `${creditUsed}%` : '—'}</p></div>
                  <div className="bg-gray-50 rounded-lg p-4"><p className="text-[10px] font-medium text-gray-500 uppercase">Available Credit</p><p className="text-sm font-bold text-emerald-600 mt-0.5 truncate" title={availableCredit !== '—' ? formatDisplayCurrency(availableCredit, baseCurrency) : '—'}>{availableCredit !== '—' ? formatDisplayCurrency(availableCredit, baseCurrency) : '—'}</p></div>
                </div>
              );
            })()}
          </div>

          {/* Invoices */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900">Invoices <span className="text-sm font-normal text-gray-400">({invoices.length})</span></h3>
            </div>
            {invoicesLoading ? (
              <Spinner />
            ) : invoicesError ? (
              <ErrorState message={invoicesError} onRetry={fetchInvoices} />
            ) : invoices.length === 0 ? (
              <EmptyState icon={FileText} title="No invoices" message="This customer has no invoices yet." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Invoice</th>
                      <th className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Date</th>
                      <th className="text-right py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Amount</th>
                      <th className="text-center py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map((inv) => (
                      <tr key={inv.id || inv._id} onClick={() => navigate(`/billing/invoices/${inv.id}`)} className="border-b border-gray-50 hover:bg-brand-50/60 cursor-pointer">
                        <td className="py-3 px-3 font-medium text-gray-900">{inv.invoice_number || inv.number || inv.id}</td>
                        <td className="py-3 px-3 text-gray-500">{formatDisplayDate(inv.issue_date || inv.date || inv.created_at)}</td>
                        <td className="py-3 px-3 text-right font-medium text-gray-900">{formatDisplayCurrency(inv.total || inv.amount || inv.total_amount, baseCurrency)}</td>
                        <td className="py-3 px-3 text-center"><InvoiceStatusBadge status={inv.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Payments */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900">Payments <span className="text-sm font-normal text-gray-400">({payments.length})</span></h3>
            </div>
            {paymentsLoading ? (
              <Spinner />
            ) : paymentsError ? (
              <ErrorState message={paymentsError} onRetry={fetchPayments} />
            ) : payments.length === 0 ? (
              <EmptyState icon={FileText} title="No payments" message="This customer has no payments yet." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Payment</th>
                      <th className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Date</th>
                      <th className="text-right py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Amount</th>
                      <th className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Method</th>
                      <th className="text-center py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payments.map((p) => (
                      <tr key={p.id || p._id} onClick={() => navigate(`/billing/payments/${p.id}`)} className="border-b border-gray-50 hover:bg-brand-50/60 cursor-pointer">
                        <td className="py-3 px-3 font-medium text-gray-900">{p.payment_number || p.transaction_id || p.id}</td>
                        <td className="py-3 px-3 text-gray-500">{formatDisplayDate(p.payment_date || p.date || p.created_at)}</td>
                        <td className="py-3 px-3 text-right font-medium text-gray-900">{formatDisplayCurrency(p.amount || p.total_amount, baseCurrency)}</td>
                        <td className="py-3 px-3 text-gray-500">{p.payment_method || p.method || p.type || '—'}</td>
                        <td className="py-3 px-3 text-center">
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                            p.status === 'completed' || p.status === 'succeeded' ? 'bg-emerald-100 text-emerald-700' :
                            p.status === 'pending' ? 'bg-amber-100 text-amber-700' :
                            p.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'
                          }`}>
                            {p.status ? p.status.charAt(0).toUpperCase() + p.status.slice(1) : 'Unknown'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Credit Notes */}
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900">Credit Notes <span className="text-sm font-normal text-gray-400">({creditNotes.length})</span></h3>
            </div>
            {creditNotesLoading ? (
              <Spinner />
            ) : creditNotesError ? (
              <ErrorState message={creditNotesError} onRetry={fetchCreditNotes} />
            ) : creditNotes.length === 0 ? (
              <EmptyState icon={FileText} title="No credit notes" message="This customer has no credit notes." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Credit Note</th>
                      <th className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Date</th>
                      <th className="text-right py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Amount</th>
                      <th className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Reason</th>
                      <th className="text-center py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {creditNotes.map((cn) => (
                      <tr key={cn.id || cn._id} onClick={() => navigate(`/billing/credit-notes/${cn.id}`)} className="border-b border-gray-50 hover:bg-brand-50/60 cursor-pointer">
                        <td className="py-3 px-3 font-medium text-gray-900">{cn.credit_note_number || cn.number || cn.id}</td>
                        <td className="py-3 px-3 text-gray-500">{formatDisplayDate(cn.issue_date || cn.date || cn.created_at)}</td>
                        <td className="py-3 px-3 text-right font-medium text-gray-900">{formatDisplayCurrency(cn.total || cn.amount || cn.total_amount, baseCurrency)}</td>
                        <td className="py-3 px-3 text-gray-500">{cn.reason || cn.description || '—'}</td>
                        <td className="py-3 px-3 text-center"><InvoiceStatusBadge status={cn.status} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'contracts' && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">Contracts <span className="text-sm font-normal text-gray-400">({contracts.length})</span></h3>
          </div>
          {contractsLoading ? (
            <Spinner />
          ) : contractsError ? (
            <ErrorState message={contractsError} onRetry={fetchContracts} />
          ) : contracts.length === 0 ? (
            <EmptyState icon={FileText} title="No contracts" message="This customer has no contracts." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Contract</th>
                    <th className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Start Date</th>
                    <th className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">End Date</th>
                    <th className="text-right py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Value</th>
                    <th className="text-center py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {contracts.map((c) => (
                    <tr key={c.id || c._id} onClick={() => navigate(`/billing/contracts/${c.id}`)} className="border-b border-gray-50 hover:bg-brand-50/60 cursor-pointer">
                      <td className="py-3 px-3 font-medium text-gray-900">{c.contract_number || c.name || c.id}</td>
                      <td className="py-3 px-3 text-gray-500">{formatDisplayDate(c.start_date || c.startDate)}</td>
                      <td className="py-3 px-3 text-gray-500">{formatDisplayDate(c.end_date || c.endDate)}</td>
                      <td className="py-3 px-3 text-right font-medium text-gray-900">{formatDisplayCurrency(c.value || c.total_value || c.contract_value, baseCurrency)}</td>
                      <td className="py-3 px-3 text-center"><StatusBadge status={c.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === 'subscriptions' && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">Subscriptions <span className="text-sm font-normal text-gray-400">({subscriptions.length})</span></h3>
          </div>
          {subscriptionsLoading ? (
            <Spinner />
          ) : subscriptionsError ? (
            <ErrorState message={subscriptionsError} onRetry={fetchSubscriptions} />
          ) : subscriptions.length === 0 ? (
            <EmptyState icon={FileText} title="No subscriptions" message="This customer has no subscriptions." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Subscription</th>
                    <th className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Plan</th>
                    <th className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Start</th>
                    <th className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Next Billing</th>
                    <th className="text-right py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Amount</th>
                    <th className="text-center py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {subscriptions.map((sub) => (
                    <tr key={sub.id || sub._id} onClick={() => navigate(`/billing/subscriptions/${sub.id}`)} className="border-b border-gray-50 hover:bg-brand-50/60 cursor-pointer">
                      <td className="py-3 px-3 font-medium text-gray-900">{sub.subscription_number || sub.name || sub.id}</td>
                      <td className="py-3 px-3 text-gray-500">{sub.plan_name || sub.plan?.name || '—'}</td>
                      <td className="py-3 px-3 text-gray-500">{formatDisplayDate(sub.start_date || sub.startDate)}</td>
                      <td className="py-3 px-3 text-gray-500">{formatDisplayDate(sub.next_billing_date || sub.nextBillingDate)}</td>
                      <td className="py-3 px-3 text-right font-medium text-gray-900">{formatDisplayCurrency(sub.amount || sub.price || sub.recurring_amount, baseCurrency)}</td>
                      <td className="py-3 px-3 text-center"><StatusBadge status={sub.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === 'credit-notes' && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">Credit Notes</h3>
          {creditNotesLoading ? (
            <Spinner />
          ) : creditNotesError ? (
            <ErrorState message={creditNotesError} onRetry={fetchCreditNotes} />
          ) : creditNotes.length === 0 ? (
            <EmptyState icon={FileText} title="No credit notes" message="This customer has no credit notes." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Credit Note</th>
                    <th className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Date</th>
                    <th className="text-right py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Amount</th>
                    <th className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Reason</th>
                    <th className="text-center py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {creditNotes.map((cn) => (
                    <tr key={cn.id || cn._id} className="border-b border-gray-50 hover:bg-gray-50">
                      <td className="py-3 px-3 font-medium text-gray-900">{cn.credit_note_number || cn.number || cn.id}</td>
                      <td className="py-3 px-3 text-gray-500">{formatDisplayDate(cn.issue_date || cn.date || cn.created_at)}</td>
                      <td className="py-3 px-3 text-right font-medium text-gray-900">{formatDisplayCurrency(cn.total || cn.amount || cn.total_amount, baseCurrency)}</td>
                      <td className="py-3 px-3 text-gray-500">{cn.reason || cn.description || '—'}</td>
                      <td className="py-3 px-3 text-center"><InvoiceStatusBadge status={cn.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === 'timeline' && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">{singular} Timeline</h3>
          </div>
          {timelineLoading ? (
            <Spinner />
          ) : timeline.length === 0 ? (
            <EmptyState icon={Clock} title={`No ${singular.toLowerCase()} timeline events`} message="Events will appear here as activity happens." />
          ) : (
            <div className="flow-root">
              <ul className="-mb-8">
                {timeline.slice(0, 50).map((event, idx) => {
                  const typeStyles = {
                    customer: 'bg-brand-100 text-brand-600',
                    invoice: 'bg-blue-100 text-blue-600',
                    payment: 'bg-emerald-100 text-emerald-600',
                    quotation: 'bg-brand-100 text-brand-600',
                    credit_note: 'bg-amber-100 text-amber-600',
                    contract: 'bg-indigo-100 text-indigo-600',
                    subscription: 'bg-violet-100 text-violet-600',
                    document: 'bg-cyan-100 text-cyan-600',
                    note: 'bg-gray-100 text-gray-600',
                    activity: 'bg-slate-100 text-slate-600',
                  };
                  const dotColor = typeStyles[event.type] || 'bg-gray-100 text-gray-600';
                  return (
                    <li key={idx}>
                      <div className="relative pb-8">
                        {idx < Math.min(timeline.length - 1, 49) && <span className="absolute left-4 top-4 -ml-px h-full w-0.5 bg-gray-200" aria-hidden="true" />}
                        <div className="relative flex gap-3">
                          <div className={`h-8 w-8 rounded-full flex items-center justify-center ring-8 ring-white flex-shrink-0 ${dotColor}`}>
                            {event.type === 'payment' ? <CheckCircle className="h-4 w-4" /> :
                             event.type === 'invoice' ? <FileText className="h-4 w-4" /> :
                             event.type === 'quotation' ? <FileText className="h-4 w-4" /> :
                             event.type === 'credit_note' ? <FileText className="h-4 w-4" /> :
                             event.type === 'contract' ? <FileText className="h-4 w-4" /> :
                             event.type === 'subscription' ? <RefreshCw className="h-4 w-4" /> :
                             event.type === 'document' ? <Files className="h-4 w-4" /> :
                             event.type === 'note' ? <StickyNote className="h-4 w-4" /> :
                             <Clock className="h-4 w-4" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-sm font-medium text-gray-900">{event.label || 'Event'}</p>
                              <span className="text-xs text-gray-500">{event.date ? formatDisplayDate(event.date) : ''}</span>
                            </div>
                            <p className="text-xs text-gray-500 mt-0.5">
                              {event.description || ''}
                              {event.amount ? ` · ${formatDisplayCurrency(event.amount, baseCurrency)}` : ''}
                              {event.actor ? ` · by ${event.actor}` : ''}
                            </p>
                          </div>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}

      {activeTab === 'quotations' && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900">Quotations <span className="text-sm font-normal text-gray-400">({quotations.length})</span></h3>
              <button onClick={() => navigate(`/billing/quotations?create=1&customer_id=${id}`)}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors">
                <Plus className="h-4 w-4" /> New Quotation
              </button>
            </div>
          {quotationsLoading ? (
            <Spinner />
          ) : quotationsError ? (
            <ErrorState message={quotationsError} onRetry={fetchQuotations} />
          ) : quotations.length === 0 ? (
            <EmptyState icon={FileText} title="No quotations" message="This customer has no quotations." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-100">
                    <th className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Quotation</th>
                    <th className="text-left py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Date</th>
                    <th className="text-right py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Amount</th>
                    <th className="text-center py-3 px-3 font-medium text-gray-500 text-xs uppercase tracking-wider">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {quotations.map((q) => (
                    <tr key={q.id || q._id} onClick={() => navigate(`/billing/quotations/${q.id}`)} className="border-b border-gray-50 hover:bg-brand-50/60 cursor-pointer">
                      <td className="py-3 px-3 font-medium text-gray-900">{q.quotation_number || q.number || q.id}</td>
                      <td className="py-3 px-3 text-gray-500">{formatDisplayDate(q.issue_date || q.date || q.created_at)}</td>
                      <td className="py-3 px-3 text-right font-medium text-gray-900">{formatDisplayCurrency(q.total || q.amount || q.total_amount, baseCurrency)}</td>
                      <td className="py-3 px-3 text-center">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                          q.status === 'accepted' ? 'bg-emerald-100 text-emerald-700' :
                          q.status === 'pending' || q.status === 'sent' ? 'bg-blue-100 text-blue-700' :
                          q.status === 'draft' ? 'bg-gray-100 text-gray-600' :
                          q.status === 'rejected' || q.status === 'cancelled' ? 'bg-red-100 text-red-700' :
                          q.status === 'converted' ? 'bg-brand-100 text-brand-700' : 'bg-gray-100 text-gray-600'
                        }`}>
                          {q.status ? q.status.charAt(0).toUpperCase() + q.status.slice(1) : 'Unknown'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {activeTab === 'documents' && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
            <h3 className="text-lg font-semibold text-gray-900">Documents ({documents.length})</h3>
            <div className="flex items-center gap-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                <input value={docSearch} onChange={(e) => setDocSearch(e.target.value)}
                  placeholder="Search documents..." className="pl-9 pr-8 py-2 text-sm border border-gray-300 rounded-lg transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30 w-52" />
                {docSearch && <button onClick={() => setDocSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600" aria-label="Clear search"><X className="h-4 w-4" /></button>}
              </div>
              <button onClick={() => { setShowDocForm(true); setDocForm({ file_name: '', file_path: '', file_size: null, mime_type: '', document_type: '', notes: '' }); }}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors">
                <Upload className="h-4 w-4" /> Add Document
              </button>
            </div>
          </div>

          {documentsError && (
            <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2">
              <AlertCircle className="h-4 w-4 flex-shrink-0" /> {documentsError}
            </div>
          )}

          {showDocForm && (
            <form onSubmit={handleSaveDoc} className="mb-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
              <h4 className="text-sm font-semibold text-gray-900 mb-3">Add Document</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">File Name *</label>
                  <input required value={docForm.file_name} onChange={(e) => setDocForm({ ...docForm, file_name: e.target.value })}
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">File Path</label>
                  <input value={docForm.file_path} onChange={(e) => setDocForm({ ...docForm, file_path: e.target.value })}
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">Document Type</label>
                  <input value={docForm.document_type} onChange={(e) => setDocForm({ ...docForm, document_type: e.target.value })}
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-700 mb-1">MIME Type</label>
                  <input value={docForm.mime_type} onChange={(e) => setDocForm({ ...docForm, mime_type: e.target.value })}
                    className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                </div>
              </div>
              <div className="mt-4">
                <label className="block text-xs font-medium text-gray-700 mb-1">Notes</label>
                <textarea value={docForm.notes} onChange={(e) => setDocForm({ ...docForm, notes: e.target.value })} rows={2}
                  className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
              <div className="flex gap-2 mt-4">
                <button type="submit" disabled={docSaving}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors">
                  {docSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Add Document
                </button>
                <button type="button" onClick={() => setShowDocForm(false)}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors">
                  Cancel
                </button>
              </div>
            </form>
          )}

          {documentsLoading ? (
            <Spinner />
          ) : documents.length === 0 ? (
            <EmptyState icon={Files} title="No documents" message="Upload a document to get started." />
          ) : (() => {
            const filteredDocuments = docSearch
              ? documents.filter((d) =>
                  `${d.file_name} ${d.document_type || ''} ${d.mime_type || ''} ${d.notes || ''}`
                    .toLowerCase().includes(docSearch.toLowerCase())
                )
              : documents;
            if (filteredDocuments.length === 0) {
              return <EmptyState icon={Search} title="No matching documents" message="Try adjusting your search." />;
            }
            return (
            <>
              {docSearch && (
                <p className="text-xs text-gray-400 mb-2">
                  Showing {filteredDocuments.length} of {documents.length} documents
                </p>
              )}
              <div className="space-y-3">
              {filteredDocuments.map((doc) => (
                <div key={doc.id || doc._id} className="flex items-center justify-between p-4 bg-gray-50 rounded-lg border border-gray-100">
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-full bg-amber-100 flex items-center justify-center">
                      <FileText className="h-4 w-4 text-amber-600" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-900">{doc.file_name}</p>
                      <p className="text-xs text-gray-500">{doc.document_type ? `${doc.document_type}` : ''}{doc.file_size ? ` · ${(doc.file_size / 1024).toFixed(1)} KB` : ''}{doc.mime_type ? ` · ${doc.mime_type}` : ''}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    {doc.file_path && (
                      <a href={doc.file_path} target="_blank" rel="noopener noreferrer"
                        className="p-1.5 text-gray-400 hover:text-brand-600 rounded-lg hover:bg-brand-50 transition-colors">
                        <Download className="h-4 w-4" />
                      </a>
                    )}
                    <button onClick={() => openConfirm('Delete Document', 'Are you sure you want to delete this document? This cannot be undone.', () => handleDeleteDoc(doc.id))}
                      className="p-1.5 text-gray-400 hover:text-red-600 rounded-lg hover:bg-red-50 transition-colors">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
            </>
            );
          })()}
        </div>
      )}

      <Toast message={toast.message} type={toast.type} onClose={closeToast} />
      <ConfirmModal
        open={confirmState.open}
        title={confirmState.title}
        message={confirmState.message}
        variant={confirmState.variant}
        confirmLabel={confirmState.confirmLabel}
        onConfirm={() => { confirmState.onConfirm?.(); closeConfirm(); }}
        onCancel={closeConfirm}
      />

      {activeTab === 'notes' && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900">Notes</h3>
            <button onClick={() => { setShowNoteForm(true); setEditingNoteId(null); setNoteForm({ content: '', is_pinned: false, is_internal: false }); }}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors">
              <Plus className="h-4 w-4" /> Add Note
            </button>
          </div>

          {notesError && (
            <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700 flex items-center gap-2">
              <AlertCircle className="h-4 w-4 flex-shrink-0" /> {notesError}
            </div>
          )}

          {showNoteForm && (
            <form onSubmit={handleSaveNote} className="mb-6 p-4 bg-gray-50 rounded-lg border border-gray-200">
              <h4 className="text-sm font-semibold text-gray-900 mb-3">{editingNoteId ? 'Edit Note' : 'Add Note'}</h4>
              {noteFormError && (
                <p className="mb-3 text-xs text-red-600">{noteFormError}</p>
              )}
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Content *</label>
                <textarea required rows={3} value={noteForm.content} onChange={(e) => setNoteForm({ ...noteForm, content: e.target.value })}
                  className="block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
              </div>
              <div className="flex items-center gap-4 mt-3">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={noteForm.is_pinned} onChange={(e) => setNoteForm({ ...noteForm, is_pinned: e.target.checked })}
                    className="rounded border-gray-300 text-brand-600 focus:ring-brand/30" />
                  <span className="text-sm text-gray-700"><Pin className="h-3.5 w-3.5 inline mr-1" />Pinned</span>
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={noteForm.is_internal} onChange={(e) => setNoteForm({ ...noteForm, is_internal: e.target.checked })}
                    className="rounded border-gray-300 text-brand-600 focus:ring-brand/30" />
                  <span className="text-sm text-gray-700">Internal note</span>
                </label>
              </div>
              <div className="flex gap-2 mt-4">
                <button type="submit" disabled={noteSaving}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50 transition-colors">
                  {noteSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />} {editingNoteId ? 'Update' : 'Add'} Note
                </button>
                <button type="button" onClick={() => { setShowNoteForm(false); setEditingNoteId(null); setNoteFormError(null); }}
                  className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors">
                  Cancel
                </button>
              </div>
            </form>
          )}

          {notesLoading ? (
            <Spinner />
          ) : notes.length === 0 ? (
            <EmptyState icon={StickyNote} title="No notes" message="Add a note to get started." />
          ) : (
            <div className="space-y-3">
              {notes.filter(n => n.is_pinned).concat(notes.filter(n => !n.is_pinned)).map((note) => (
                <div key={note.id || note._id} className="p-4 bg-gray-50 rounded-lg border border-gray-100">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 mb-1">
                        {note.is_pinned && <Pin className="h-3.5 w-3.5 text-amber-400" />}
                        {note.is_internal && <span className="text-[10px] font-medium text-amber-700 bg-amber-100 px-1.5 py-0.5 rounded">Internal</span>}
                      </div>
                      <p className="text-sm text-gray-700 whitespace-pre-wrap">{note.content}</p>
                      <p className="text-xs text-gray-400 mt-2">
                        {note.created_at ? formatDisplayDate(note.created_at) : ''}
                        {note.created_by ? ` · by #${note.created_by}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button onClick={() => { setEditingNoteId(note.id); setNoteForm({ content: note.content, is_pinned: note.is_pinned || false, is_internal: note.is_internal || false }); setShowNoteForm(true); }}
                        className="p-1.5 text-gray-400 hover:text-brand-600 rounded-lg hover:bg-brand-50 transition-colors">
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button onClick={() => openConfirm('Delete Note', 'Are you sure you want to delete this note?', () => handleDeleteNote(note.id))}
                        className="p-1.5 text-gray-400 hover:text-red-600 rounded-lg hover:bg-red-50 transition-colors">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </HRPage>
  );
}
