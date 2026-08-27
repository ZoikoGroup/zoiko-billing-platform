import React, { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  CreditCard,
  FileWarning,
  Landmark,
  Receipt,
  TrendingUp,
  UserCheck,
  Building2,
  Send,
  CheckCircle,
  XCircle,
  Clock,
  DollarSign,
  AlertTriangle,
  ClipboardCheck,
  Plus,
  Eye,
} from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import {
  canWriteCommercialQuote,
  canApproveCommercialQuote,
  canWriteCommercialPayment,
  canWriteCommercialFinancial,
  canWriteEvaluationProgram,
} from "../../config/roles";
import { getSaasCommercialReporting, listCommercialAccounts, listCommercialPlans } from "../../service/commercialService";
import {
  listCommercialQuotes,
  createCommercialQuote,
  getCommercialQuote,
  addCommercialQuoteItem,
  setCommercialQuoteDiscount,
  sendCommercialQuote,
  approveCommercialQuote,
  rejectCommercialQuote,
  convertCommercialQuote,
  listPlatformInvoices,
  createPlatformInvoice,
  getPlatformInvoice,
  addPlatformInvoiceItem,
  finalizePlatformInvoice,
  voidPlatformInvoice,
  sendPlatformInvoice,
  listPlatformPayments,
  recordPlatformPayment,
  allocatePlatformPayment,
  deallocatePlatformPayment,
  triggerPlatformReconciliation,
  listPlatformReconciliationRuns,
  listEvaluationPrograms,
  createEvaluationProgram,
  setEvaluationProgramStatus,
} from "../../service/commandCenterService";
import { PageHeader, DataTable, FormModal, Modal, Field, Select, Button } from "../../components/billing-ui";
import {
  DashboardStatCard,
  DashboardStatCardSkeleton,
  ErrorState,
  Spinner,
  useConfirmationDialog,
} from "../../components/billing-shared";
import {
  SUBSCRIPTION_STATUS_OPTIONS,
  ACCOUNT_STATUS_OPTIONS,
  formatDateTime,
} from "./constants";

function labelFor(options, value) {
  const match = (options || []).find((o) => o.value === value);
  return match ? match.label : value;
}

function errorMessage(err, fallback) {
  return err?.detail || err?.message || fallback;
}

function StatusCountTable({ title, counts, options }) {
  const entries = Object.entries(counts || {});
  const total = entries.reduce((sum, [, n]) => sum + n, 0);
  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
      <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">{title}</h3>
      <p className="mt-1 text-xs text-slate-500">{total} row(s) — real database counts.</p>
      <ul className="mt-4 space-y-2">
        {entries.map(([status, count]) => (
          <li key={status} className="flex items-center justify-between gap-3 text-sm">
            <span className="text-slate-600">{labelFor(options, status)}</span>
            <span className="font-semibold text-slate-800 tabular-nums">{count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const QUOTE_STATUS_OPTIONS = [
  { value: "draft", label: "Draft" },
  { value: "sent", label: "Sent" },
  { value: "accepted", label: "Accepted" },
  { value: "rejected", label: "Rejected" },
  { value: "expired", label: "Expired" },
  { value: "converted", label: "Converted" },
];

const INVOICE_STATUS_OPTIONS = [
  { value: "draft", label: "Draft" },
  { value: "issued", label: "Issued" },
  { value: "delivered", label: "Delivered" },
  { value: "due", label: "Due" },
  { value: "partially_paid", label: "Partially Paid" },
  { value: "paid", label: "Paid" },
  { value: "overdue", label: "Overdue" },
  { value: "voided", label: "Voided" },
];

const PAYMENT_STATUS_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "processing", label: "Processing" },
  { value: "cleared", label: "Cleared" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "refunded", label: "Refunded" },
];

const PAYMENT_METHOD_OPTIONS = [
  { value: "manual", label: "Manual" },
  { value: "wire_transfer", label: "Wire Transfer" },
  { value: "ach", label: "ACH" },
  { value: "card", label: "Card (recorded manually)" },
];

const EVALUATION_PAYMENT_REQUIREMENT_OPTIONS = [
  { value: "none", label: "None" },
  { value: "card_required_upfront", label: "Card Required Upfront" },
];

const EVALUATION_CONVERSION_POLICY_OPTIONS = [
  { value: "manual", label: "Manual" },
  { value: "auto_charge_on_expiry", label: "Auto-Charge on Expiry (not yet implemented)" },
];

const EVALUATION_EXPIRY_ACTION_OPTIONS = [
  { value: "suspend", label: "Suspend" },
  { value: "downgrade", label: "Downgrade (not yet implemented)" },
];

const RECONCILIATION_STATE_OPTIONS = [
  { value: "running", label: "Running" },
  { value: "verified", label: "Verified" },
  { value: "partial", label: "Partial" },
  { value: "failed", label: "Failed" },
];

function StatusBadge({ value, options }) {
  const label = labelFor(options, value);
  const colors = {
    draft: "bg-slate-100 text-slate-600",
    sent: "bg-blue-100 text-blue-700",
    accepted: "bg-emerald-100 text-emerald-700",
    approved: "bg-emerald-100 text-emerald-700",
    rejected: "bg-red-100 text-red-700",
    expired: "bg-amber-100 text-amber-800",
    converted: "bg-purple-100 text-purple-700",
    issued: "bg-blue-100 text-blue-700",
    delivered: "bg-emerald-100 text-emerald-700",
    due: "bg-amber-100 text-amber-800",
    partially_paid: "bg-orange-100 text-orange-700",
    paid: "bg-emerald-100 text-emerald-700",
    overdue: "bg-red-100 text-red-700",
    voided: "bg-slate-200 text-slate-500",
    cleared: "bg-emerald-100 text-emerald-700",
    pending: "bg-amber-100 text-amber-800",
    processing: "bg-blue-100 text-blue-700",
    failed: "bg-red-100 text-red-700",
    cancelled: "bg-slate-200 text-slate-500",
    refunded: "bg-purple-100 text-purple-700",
    running: "bg-blue-100 text-blue-700",
    verified: "bg-emerald-100 text-emerald-700",
    partial: "bg-amber-100 text-amber-800",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${colors[value] || "bg-slate-100 text-slate-600"}`}>
      {label}
    </span>
  );
}

function formatCurrency(amount, currency = "USD") {
  const num = Number(amount ?? 0);
  return num.toLocaleString("en-US", { style: "currency", currency });
}

function CapabilityNotice({ capability }) {
  return (
    <p className="mt-2 text-xs text-amber-700">
      Not available — your platform role does not include the {capability} capability.
      Ask a Platform Administrator for access.
    </p>
  );
}

function ItemsTable({ items, currency }) {
  if (!items || items.length === 0) {
    return <p className="py-3 text-xs text-slate-500">No line items yet.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50 text-slate-500">
            <th className="px-3 py-2 text-left font-semibold">Description</th>
            <th className="px-3 py-2 text-right font-semibold">Qty</th>
            <th className="px-3 py-2 text-right font-semibold">Unit Price</th>
            <th className="px-3 py-2 text-right font-semibold">Discount</th>
            <th className="px-3 py-2 text-right font-semibold">Tax</th>
            <th className="px-3 py-2 text-right font-semibold">Total</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.line_number} className="border-b border-slate-100 last:border-0">
              <td className="px-3 py-2 text-slate-700">{it.description}</td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-600">{it.quantity}</td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-600">{formatCurrency(it.unit_price, currency)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-600">{formatCurrency(it.discount_amount, currency)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-slate-600">{formatCurrency(it.tax_amount, currency)}</td>
              <td className="px-3 py-2 text-right tabular-nums font-semibold text-slate-800">{formatCurrency(it.total, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AddItemForm({ onAdd, busy, disabled }) {
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unitPrice, setUnitPrice] = useState("");
  const [discountAmount, setDiscountAmount] = useState("0");
  const [taxAmount, setTaxAmount] = useState("0");

  if (disabled) return null;

  const submit = (e) => {
    e.preventDefault();
    if (!description.trim() || !unitPrice) return;
    onAdd({
      description: description.trim(),
      quantity,
      unit_price: unitPrice,
      discount_amount: discountAmount || "0",
      tax_amount: taxAmount || "0",
    });
    setDescription("");
    setQuantity("1");
    setUnitPrice("");
    setDiscountAmount("0");
    setTaxAmount("0");
  };

  return (
    <form onSubmit={submit} className="mt-3 grid grid-cols-12 gap-2">
      <input
        className="col-span-12 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs sm:col-span-4"
        placeholder="Description"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        disabled={busy}
      />
      <input
        className="col-span-3 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs sm:col-span-1"
        placeholder="Qty"
        value={quantity}
        onChange={(e) => setQuantity(e.target.value)}
        disabled={busy}
      />
      <input
        className="col-span-3 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs sm:col-span-2"
        placeholder="Unit price"
        value={unitPrice}
        onChange={(e) => setUnitPrice(e.target.value)}
        disabled={busy}
      />
      <input
        className="col-span-3 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs sm:col-span-2"
        placeholder="Discount"
        value={discountAmount}
        onChange={(e) => setDiscountAmount(e.target.value)}
        disabled={busy}
      />
      <input
        className="col-span-3 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs sm:col-span-2"
        placeholder="Tax"
        value={taxAmount}
        onChange={(e) => setTaxAmount(e.target.value)}
        disabled={busy}
      />
      <button
        type="submit"
        disabled={busy}
        className="col-span-12 flex items-center justify-center gap-1.5 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-slate-700 disabled:opacity-50 sm:col-span-1"
      >
        <Plus size={14} /> Add
      </button>
    </form>
  );
}

const VALID_TABS = ["quotes", "invoices", "payments", "reconciliation", "evaluation"];

const EMPTY_QUOTE_FORM = { account_id: "", subject: "", notes: "", terms: "", valid_until: "", currency: "USD" };
const EMPTY_INVOICE_FORM = { account_id: "", subscription_id: "", issue_date: "", due_date: "", notes: "", currency: "USD" };
const EMPTY_PAYMENT_FORM = { account_id: "", amount: "", currency: "USD", payment_method: "manual", transaction_id: "", notes: "" };
const EMPTY_PROGRAM_FORM = {
  plan_id: "", duration_days: "14", payment_requirement: "none",
  conversion_policy: "manual", expiry_action: "suspend", approved_by: "",
};

export default function Plane1BillingPage() {
  const { user } = useAuth();
  const platformRole = user?.platform_role;
  const canQuoteWrite = canWriteCommercialQuote(platformRole);
  const canQuoteApprove = canApproveCommercialQuote(platformRole);
  const canPaymentWrite = canWriteCommercialPayment(platformRole);
  // All current uses of this are invoice MUTATIONS (create/add-item/finalize/
  // void/send) — backed by commercial_financial.write, not the read capability.
  const canFinancial = canWriteCommercialFinancial(platformRole);
  const canEvaluationProgramWrite = canWriteEvaluationProgram(platformRole);

  const { confirm, ConfirmationDialog } = useConfirmationDialog();

  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Tab state — initialized from ?tab= so sidebar links can deep-link a specific tab
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = VALID_TABS.includes(searchParams.get("tab")) ? searchParams.get("tab") : "quotes";
  const [activeTab, setActiveTabState] = useState(initialTab);

  const setActiveTab = useCallback(
    (tab) => {
      setActiveTabState(tab);
      setSearchParams({ tab }, { replace: true });
    },
    [setSearchParams]
  );

  // Data states
  const [quotes, setQuotes] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [payments, setPayments] = useState([]);
  const [reconciliationRuns, setReconciliationRuns] = useState([]);
  const [runningReconciliation, setRunningReconciliation] = useState(false);
  const [evaluationPrograms, setEvaluationPrograms] = useState([]);
  const [loadingData, setLoadingData] = useState(false);

  // Commercial accounts — for the account picker in every create modal
  const [accounts, setAccounts] = useState([]);
  useEffect(() => {
    listCommercialAccounts({ limit: 200 })
      .then((data) => setAccounts(Array.isArray(data?.accounts) ? data.accounts : []))
      .catch(() => setAccounts([]));
  }, []);
  const accountOptions = accounts.map((a) => ({
    value: String(a.id),
    label: `${a.organization_name} (${a.organization_code})`,
  }));

  // Commercial plans — for the plan picker on the evaluation-program create form
  const [plans, setPlans] = useState([]);
  useEffect(() => {
    listCommercialPlans({ limit: 200 })
      .then((data) => setPlans(Array.isArray(data?.plans) ? data.plans : []))
      .catch(() => setPlans([]));
  }, []);
  const planOptions = plans.map((p) => ({
    value: String(p.id),
    label: `${p.plan_name} (${p.plan_code})`,
  }));

  const loadReport = useCallback(() => {
    setLoading(true);
    setError(null);
    getSaasCommercialReporting()
      .then(setReport)
      .catch((e) => setError(e?.message || "Failed to load SaaS reporting."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadReport();
  }, [loadReport]);

  const loadTabData = useCallback((tab) => {
    setLoadingData(true);
    if (tab === "quotes") {
      listCommercialQuotes({ limit: 100 })
        .then((data) => setQuotes(Array.isArray(data) ? data : data.quotes || []))
        .catch(() => setQuotes([]))
        .finally(() => setLoadingData(false));
    } else if (tab === "invoices") {
      listPlatformInvoices({ limit: 100 })
        .then((data) => setInvoices(Array.isArray(data) ? data : data.invoices || []))
        .catch(() => setInvoices([]))
        .finally(() => setLoadingData(false));
    } else if (tab === "payments") {
      listPlatformPayments({ limit: 100 })
        .then((data) => setPayments(Array.isArray(data) ? data : data.payments || []))
        .catch(() => setPayments([]))
        .finally(() => setLoadingData(false));
    } else if (tab === "reconciliation") {
      listPlatformReconciliationRuns(20)
        .then((data) => setReconciliationRuns(Array.isArray(data) ? data : data.runs || []))
        .catch(() => setReconciliationRuns([]))
        .finally(() => setLoadingData(false));
    } else if (tab === "evaluation") {
      listEvaluationPrograms()
        .then((data) => setEvaluationPrograms(Array.isArray(data) ? data : []))
        .catch(() => setEvaluationPrograms([]))
        .finally(() => setLoadingData(false));
    } else {
      setLoadingData(false);
    }
  }, []);

  useEffect(() => {
    loadTabData(activeTab);
  }, [activeTab, loadTabData]);

  const runReconciliation = useCallback(() => {
    setRunningReconciliation(true);
    triggerPlatformReconciliation()
      .then(() => loadTabData("reconciliation"))
      .catch(() => {})
      .finally(() => setRunningReconciliation(false));
  }, [loadTabData]);

  // ── Evaluation Programs (§B3) ────────────────────────────────────────────
  const [createProgramOpen, setCreateProgramOpen] = useState(false);
  const [createProgramBusy, setCreateProgramBusy] = useState(false);
  const [createProgramError, setCreateProgramError] = useState(null);
  const [createProgramForm, setCreateProgramForm] = useState(EMPTY_PROGRAM_FORM);
  const [toggleProgramBusyId, setToggleProgramBusyId] = useState(null);

  const submitCreateProgram = () => {
    if (!createProgramForm.plan_id || !createProgramForm.duration_days) {
      setCreateProgramError("Select a plan and a duration in days.");
      return;
    }
    setCreateProgramBusy(true);
    setCreateProgramError(null);
    createEvaluationProgram({
      plan_id: Number(createProgramForm.plan_id),
      duration_days: Number(createProgramForm.duration_days),
      payment_requirement: createProgramForm.payment_requirement,
      conversion_policy: createProgramForm.conversion_policy,
      expiry_action: createProgramForm.expiry_action,
      approved_by: createProgramForm.approved_by ? Number(createProgramForm.approved_by) : undefined,
    })
      .then(() => {
        setCreateProgramOpen(false);
        setCreateProgramForm(EMPTY_PROGRAM_FORM);
        loadTabData("evaluation");
      })
      .catch((e) => setCreateProgramError(errorMessage(e, "Failed to create evaluation program.")))
      .finally(() => setCreateProgramBusy(false));
  };

  const toggleProgramStatus = (program) => {
    setToggleProgramBusyId(program.id);
    setEvaluationProgramStatus(program.id, !program.is_active)
      .then(() => loadTabData("evaluation"))
      .catch(() => {})
      .finally(() => setToggleProgramBusyId(null));
  };

  // ── Create Quote ──────────────────────────────────────────────────────
  const [createQuoteOpen, setCreateQuoteOpen] = useState(false);
  const [createQuoteBusy, setCreateQuoteBusy] = useState(false);
  const [createQuoteError, setCreateQuoteError] = useState(null);
  const [createQuoteForm, setCreateQuoteForm] = useState(EMPTY_QUOTE_FORM);

  const submitCreateQuote = () => {
    if (!createQuoteForm.account_id) {
      setCreateQuoteError("Select a commercial account.");
      return;
    }
    setCreateQuoteBusy(true);
    setCreateQuoteError(null);
    createCommercialQuote({
      account_id: Number(createQuoteForm.account_id),
      subject: createQuoteForm.subject || undefined,
      notes: createQuoteForm.notes || undefined,
      terms: createQuoteForm.terms || undefined,
      valid_until: createQuoteForm.valid_until || undefined,
      currency: createQuoteForm.currency || "USD",
    })
      .then(() => {
        setCreateQuoteOpen(false);
        setCreateQuoteForm(EMPTY_QUOTE_FORM);
        loadTabData("quotes");
      })
      .catch((e) => setCreateQuoteError(errorMessage(e, "Failed to create quote.")))
      .finally(() => setCreateQuoteBusy(false));
  };

  // ── Quote detail (view / add item / send / approve / reject / convert) ──
  const [quoteDetail, setQuoteDetail] = useState(null);
  const [quoteDetailOpen, setQuoteDetailOpen] = useState(false);
  const [quoteDetailLoading, setQuoteDetailLoading] = useState(false);
  const [quoteDetailBusy, setQuoteDetailBusy] = useState(false);
  const [quoteDetailError, setQuoteDetailError] = useState(null);

  const openQuoteDetail = (row) => {
    setQuoteDetailOpen(true);
    setQuoteDetailError(null);
    setQuoteDetailLoading(true);
    getCommercialQuote(row.id)
      .then(setQuoteDetail)
      .catch((e) => setQuoteDetailError(errorMessage(e, "Failed to load quote.")))
      .finally(() => setQuoteDetailLoading(false));
  };

  const refreshQuoteDetail = () =>
    getCommercialQuote(quoteDetail.id).then(setQuoteDetail);

  const addItemToQuote = (item) => {
    setQuoteDetailBusy(true);
    setQuoteDetailError(null);
    const lineNumber = (quoteDetail?.items?.length || 0) + 1;
    addCommercialQuoteItem(quoteDetail.id, { line_number: lineNumber, ...item })
      .then(refreshQuoteDetail)
      .catch((e) => setQuoteDetailError(errorMessage(e, "Failed to add item.")))
      .finally(() => setQuoteDetailBusy(false));
  };

  const [discountForm, setDiscountForm] = useState({ discount_amount: "", reason: "", approver_id: "" });
  const [discountBusy, setDiscountBusy] = useState(false);
  const [discountError, setDiscountError] = useState(null);

  const submitDiscount = () => {
    setDiscountBusy(true);
    setDiscountError(null);
    setCommercialQuoteDiscount(quoteDetail.id, {
      discount_amount: discountForm.discount_amount || "0",
      reason: discountForm.reason || undefined,
      approver_id: discountForm.approver_id ? Number(discountForm.approver_id) : undefined,
    })
      .then(refreshQuoteDetail)
      .catch((e) => setDiscountError(errorMessage(e, "Failed to set discount.")))
      .finally(() => setDiscountBusy(false));
  };

  const sendQuoteAction = async () => {
    const ok = await confirm({
      title: "Send Quote",
      message: `Send quote ${quoteDetail.quote_number} — this generates the public link the org uses to accept or reject it with no login.`,
      confirmLabel: "Send Quote",
    });
    if (!ok) return;
    setQuoteDetailBusy(true);
    setQuoteDetailError(null);
    sendCommercialQuote(quoteDetail.id)
      .then(refreshQuoteDetail)
      .then(() => loadTabData("quotes"))
      .catch((e) => setQuoteDetailError(errorMessage(e, "Failed to send quote.")))
      .finally(() => setQuoteDetailBusy(false));
  };

  const approveQuoteAction = async () => {
    const ok = await confirm({
      title: "Approve Quote",
      message: "Record that the org has accepted this quote. You must be a different user than the quote's creator — the backend rejects self-approval.",
      confirmLabel: "Approve",
    });
    if (!ok) return;
    setQuoteDetailBusy(true);
    setQuoteDetailError(null);
    approveCommercialQuote(quoteDetail.id)
      .then(refreshQuoteDetail)
      .then(() => loadTabData("quotes"))
      .catch((e) => setQuoteDetailError(errorMessage(e, "Failed to approve quote.")))
      .finally(() => setQuoteDetailBusy(false));
  };

  const [rejectQuoteOpen, setRejectQuoteOpen] = useState(false);
  const [rejectQuoteReason, setRejectQuoteReason] = useState("");
  const [rejectQuoteBusy, setRejectQuoteBusy] = useState(false);
  const [rejectQuoteError, setRejectQuoteError] = useState(null);

  const submitRejectQuote = () => {
    setRejectQuoteBusy(true);
    setRejectQuoteError(null);
    rejectCommercialQuote(quoteDetail.id, rejectQuoteReason)
      .then(() => {
        setRejectQuoteOpen(false);
        setRejectQuoteReason("");
        return refreshQuoteDetail();
      })
      .then(() => loadTabData("quotes"))
      .catch((e) => setRejectQuoteError(errorMessage(e, "Failed to reject quote.")))
      .finally(() => setRejectQuoteBusy(false));
  };

  const [convertOpen, setConvertOpen] = useState(false);
  const [convertDueDate, setConvertDueDate] = useState("");
  const [convertBusy, setConvertBusy] = useState(false);
  const [convertError, setConvertError] = useState(null);

  const submitConvert = () => {
    setConvertBusy(true);
    setConvertError(null);
    convertCommercialQuote(quoteDetail.id, convertDueDate || undefined)
      .then(() => {
        setConvertOpen(false);
        setConvertDueDate("");
        setQuoteDetailOpen(false);
        loadTabData("quotes");
        setActiveTab("invoices");
      })
      .catch((e) => setConvertError(errorMessage(e, "Failed to convert quote.")))
      .finally(() => setConvertBusy(false));
  };

  // ── Create Invoice ────────────────────────────────────────────────────
  const [createInvoiceOpen, setCreateInvoiceOpen] = useState(false);
  const [createInvoiceBusy, setCreateInvoiceBusy] = useState(false);
  const [createInvoiceError, setCreateInvoiceError] = useState(null);
  const [createInvoiceForm, setCreateInvoiceForm] = useState(EMPTY_INVOICE_FORM);

  const submitCreateInvoice = () => {
    if (!createInvoiceForm.account_id) {
      setCreateInvoiceError("Select a commercial account.");
      return;
    }
    setCreateInvoiceBusy(true);
    setCreateInvoiceError(null);
    createPlatformInvoice({
      account_id: Number(createInvoiceForm.account_id),
      subscription_id: createInvoiceForm.subscription_id ? Number(createInvoiceForm.subscription_id) : undefined,
      issue_date: createInvoiceForm.issue_date || undefined,
      due_date: createInvoiceForm.due_date || undefined,
      notes: createInvoiceForm.notes || undefined,
      currency: createInvoiceForm.currency || "USD",
    })
      .then(() => {
        setCreateInvoiceOpen(false);
        setCreateInvoiceForm(EMPTY_INVOICE_FORM);
        loadTabData("invoices");
      })
      .catch((e) => setCreateInvoiceError(errorMessage(e, "Failed to create invoice.")))
      .finally(() => setCreateInvoiceBusy(false));
  };

  // ── Invoice detail (view / add item / finalize / send / void) ───────────
  const [invoiceDetail, setInvoiceDetail] = useState(null);
  const [invoiceDetailOpen, setInvoiceDetailOpen] = useState(false);
  const [invoiceDetailLoading, setInvoiceDetailLoading] = useState(false);
  const [invoiceDetailBusy, setInvoiceDetailBusy] = useState(false);
  const [invoiceDetailError, setInvoiceDetailError] = useState(null);

  const openInvoiceDetail = (row) => {
    setInvoiceDetailOpen(true);
    setInvoiceDetailError(null);
    setInvoiceDetailLoading(true);
    getPlatformInvoice(row.id)
      .then(setInvoiceDetail)
      .catch((e) => setInvoiceDetailError(errorMessage(e, "Failed to load invoice.")))
      .finally(() => setInvoiceDetailLoading(false));
  };

  const refreshInvoiceDetail = () =>
    getPlatformInvoice(invoiceDetail.id).then(setInvoiceDetail);

  const addItemToInvoice = (item) => {
    setInvoiceDetailBusy(true);
    setInvoiceDetailError(null);
    const lineNumber = (invoiceDetail?.items?.length || 0) + 1;
    addPlatformInvoiceItem(invoiceDetail.id, { line_number: lineNumber, ...item })
      .then(refreshInvoiceDetail)
      .catch((e) => setInvoiceDetailError(errorMessage(e, "Failed to add item.")))
      .finally(() => setInvoiceDetailBusy(false));
  };

  const finalizeInvoiceAction = async () => {
    const ok = await confirm({
      title: "Finalize Invoice",
      message: `Finalizing ${invoiceDetail.invoice_number ? invoiceDetail.invoice_number : "this invoice"} allocates its invoice number and makes it immutable — there is no edit afterwards, only void or credit.`,
      confirmLabel: "Finalize",
      tone: "danger",
    });
    if (!ok) return;
    setInvoiceDetailBusy(true);
    setInvoiceDetailError(null);
    finalizePlatformInvoice(invoiceDetail.id)
      .then(refreshInvoiceDetail)
      .then(() => loadTabData("invoices"))
      .catch((e) => setInvoiceDetailError(errorMessage(e, "Failed to finalize invoice.")))
      .finally(() => setInvoiceDetailBusy(false));
  };

  const sendInvoiceAction = async () => {
    const ok = await confirm({
      title: "Send Invoice",
      message: "Email this invoice to the org's admin from Zoiko Billing Accounts, and generate its public payment link.",
      confirmLabel: "Send Invoice",
    });
    if (!ok) return;
    setInvoiceDetailBusy(true);
    setInvoiceDetailError(null);
    sendPlatformInvoice(invoiceDetail.id)
      .then(refreshInvoiceDetail)
      .then(() => loadTabData("invoices"))
      .catch((e) => setInvoiceDetailError(errorMessage(e, "Failed to send invoice. This can mean no org_admin exists for this account, or the email itself failed to send.")))
      .finally(() => setInvoiceDetailBusy(false));
  };

  const [voidInvoiceOpen, setVoidInvoiceOpen] = useState(false);
  const [voidInvoiceReason, setVoidInvoiceReason] = useState("");
  const [voidInvoiceBusy, setVoidInvoiceBusy] = useState(false);
  const [voidInvoiceError, setVoidInvoiceError] = useState(null);

  const submitVoidInvoice = () => {
    if (!voidInvoiceReason.trim()) {
      setVoidInvoiceError("A reason is required to void an invoice.");
      return;
    }
    setVoidInvoiceBusy(true);
    setVoidInvoiceError(null);
    voidPlatformInvoice(invoiceDetail.id, voidInvoiceReason)
      .then(() => {
        setVoidInvoiceOpen(false);
        setVoidInvoiceReason("");
        return refreshInvoiceDetail();
      })
      .then(() => loadTabData("invoices"))
      .catch((e) => setVoidInvoiceError(errorMessage(e, "Failed to void invoice.")))
      .finally(() => setVoidInvoiceBusy(false));
  };

  // ── Record Payment ────────────────────────────────────────────────────
  const [recordPaymentOpen, setRecordPaymentOpen] = useState(false);
  const [recordPaymentBusy, setRecordPaymentBusy] = useState(false);
  const [recordPaymentError, setRecordPaymentError] = useState(null);
  const [recordPaymentForm, setRecordPaymentForm] = useState(EMPTY_PAYMENT_FORM);

  const submitRecordPayment = () => {
    if (!recordPaymentForm.account_id || !recordPaymentForm.amount) {
      setRecordPaymentError("Select an account and enter an amount.");
      return;
    }
    setRecordPaymentBusy(true);
    setRecordPaymentError(null);
    recordPlatformPayment({
      account_id: Number(recordPaymentForm.account_id),
      amount: recordPaymentForm.amount,
      currency: recordPaymentForm.currency || "USD",
      payment_method: recordPaymentForm.payment_method || undefined,
      transaction_id: recordPaymentForm.transaction_id || undefined,
      notes: recordPaymentForm.notes || undefined,
    })
      .then(() => {
        setRecordPaymentOpen(false);
        setRecordPaymentForm(EMPTY_PAYMENT_FORM);
        loadTabData("payments");
      })
      .catch((e) => setRecordPaymentError(errorMessage(e, "Failed to record payment.")))
      .finally(() => setRecordPaymentBusy(false));
  };

  // ── Allocate / Deallocate ─────────────────────────────────────────────
  const [allocateOpen, setAllocateOpen] = useState(false);
  const [allocateTarget, setAllocateTarget] = useState(null);
  const [allocateInvoices, setAllocateInvoices] = useState([]);
  const [allocateForm, setAllocateForm] = useState({ invoice_id: "", amount: "" });
  const [allocateBusy, setAllocateBusy] = useState(false);
  const [allocateError, setAllocateError] = useState(null);

  const openAllocate = (payment) => {
    setAllocateTarget(payment);
    setAllocateForm({ invoice_id: "", amount: String(payment.amount) });
    setAllocateError(null);
    setAllocateOpen(true);
    listPlatformInvoices({ account_id: payment.commercial_account_id, limit: 100 })
      .then((data) => {
        const rows = Array.isArray(data) ? data : data.invoices || [];
        setAllocateInvoices(rows.filter((inv) => inv.status !== "voided" && Number(inv.balance_due) > 0.005));
      })
      .catch(() => setAllocateInvoices([]));
  };

  const submitAllocate = () => {
    if (!allocateForm.invoice_id || !allocateForm.amount) {
      setAllocateError("Select an invoice and enter an amount.");
      return;
    }
    setAllocateBusy(true);
    setAllocateError(null);
    allocatePlatformPayment(allocateTarget.id, Number(allocateForm.invoice_id), allocateForm.amount)
      .then(() => {
        setAllocateOpen(false);
        loadTabData("payments");
        loadTabData("invoices");
      })
      .catch((e) => setAllocateError(errorMessage(e, "Failed to allocate payment.")))
      .finally(() => setAllocateBusy(false));
  };

  const [deallocateOpen, setDeallocateOpen] = useState(false);
  const [deallocateTarget, setDeallocateTarget] = useState(null);
  const [deallocateInvoices, setDeallocateInvoices] = useState([]);
  const [deallocateInvoiceId, setDeallocateInvoiceId] = useState("");
  const [deallocateBusy, setDeallocateBusy] = useState(false);
  const [deallocateError, setDeallocateError] = useState(null);

  const openDeallocate = (payment) => {
    setDeallocateTarget(payment);
    setDeallocateInvoiceId("");
    setDeallocateError(null);
    setDeallocateOpen(true);
    listPlatformInvoices({ account_id: payment.commercial_account_id, limit: 100 })
      .then((data) => setDeallocateInvoices(Array.isArray(data) ? data : data.invoices || []))
      .catch(() => setDeallocateInvoices([]));
  };

  const submitDeallocate = () => {
    if (!deallocateInvoiceId) {
      setDeallocateError("Select an invoice.");
      return;
    }
    setDeallocateBusy(true);
    setDeallocateError(null);
    deallocatePlatformPayment(deallocateTarget.id, Number(deallocateInvoiceId))
      .then(() => {
        setDeallocateOpen(false);
        loadTabData("payments");
        loadTabData("invoices");
      })
      .catch((e) => setDeallocateError(errorMessage(e, "Failed to deallocate payment — this invoice may have no existing allocation from this payment.")))
      .finally(() => setDeallocateBusy(false));
  };

  const mrr = report?.mrr;

  const planColumns = [
    { key: "plan_code", label: "Plan code", render: (r) => <span className="font-medium text-slate-700">{r.plan_code}</span> },
    { key: "plan_name", label: "Plan name", render: (r) => r.plan_name || "—" },
    {
      key: "open_subscriptions",
      label: "Open subscriptions",
      align: "right",
      render: (r) => <span className="tabular-nums font-semibold text-slate-800">{r.open_subscriptions}</span>,
    },
  ];

  const quoteColumns = [
    { key: "quote_number", label: "Quote #", render: (r) => <span className="font-medium text-slate-700">{r.quote_number}</span> },
    { key: "subject", label: "Subject", render: (r) => r.subject || "—" },
    {
      key: "status",
      label: "Status",
      render: (r) => <StatusBadge value={r.status} options={QUOTE_STATUS_OPTIONS} />,
    },
    {
      key: "total_amount",
      label: "Total",
      align: "right",
      render: (r) => <span className="tabular-nums font-semibold text-slate-800">{formatCurrency(r.total_amount, r.currency)}</span>,
    },
    { key: "created_at", label: "Created", render: (r) => formatDateTime(r.created_at) },
    {
      key: "actions",
      label: "",
      align: "right",
      render: (r) => (
        <Button size="sm" variant="secondary" icon={Eye} onClick={() => openQuoteDetail(r)}>
          Manage
        </Button>
      ),
    },
  ];

  const invoiceColumns = [
    { key: "invoice_number", label: "Invoice #", render: (r) => <span className="font-medium text-slate-700">{r.invoice_number || "DRAFT"}</span> },
    {
      key: "status",
      label: "Status",
      render: (r) => <StatusBadge value={r.status} options={INVOICE_STATUS_OPTIONS} />,
    },
    {
      key: "total_amount",
      label: "Total",
      align: "right",
      render: (r) => <span className="tabular-nums font-semibold text-slate-800">{formatCurrency(r.total_amount, r.currency)}</span>,
    },
    {
      key: "balance_due",
      label: "Balance Due",
      align: "right",
      render: (r) => (
        <span className={`tabular-nums font-semibold ${Number(r.balance_due) > 0 ? "text-red-600" : "text-emerald-600"}`}>
          {formatCurrency(r.balance_due, r.currency)}
        </span>
      ),
    },
    { key: "due_date", label: "Due Date", render: (r) => r.due_date || "—" },
    {
      key: "actions",
      label: "",
      align: "right",
      render: (r) => (
        <Button size="sm" variant="secondary" icon={Eye} onClick={() => openInvoiceDetail(r)}>
          Manage
        </Button>
      ),
    },
  ];

  const paymentColumns = [
    { key: "payment_number", label: "Payment #", render: (r) => <span className="font-medium text-slate-700">{r.payment_number}</span> },
    {
      key: "status",
      label: "Status",
      render: (r) => <StatusBadge value={r.status} options={PAYMENT_STATUS_OPTIONS} />,
    },
    {
      key: "amount",
      label: "Amount",
      align: "right",
      render: (r) => <span className="tabular-nums font-semibold text-slate-800">{formatCurrency(r.amount, r.currency)}</span>,
    },
    { key: "payment_method", label: "Method", render: (r) => r.payment_method || "—" },
    { key: "created_at", label: "Date", render: (r) => formatDateTime(r.created_at) },
    {
      key: "actions",
      label: "",
      align: "right",
      render: (r) => (
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={() => openAllocate(r)} disabled={!canPaymentWrite}>
            Allocate
          </Button>
          <Button size="sm" variant="ghost" onClick={() => openDeallocate(r)} disabled={!canPaymentWrite}>
            Deallocate
          </Button>
        </div>
      ),
    },
  ];

  const reconciliationColumns = [
    { key: "id", label: "Run #", render: (r) => <span className="font-medium text-slate-700">#{r.id}</span> },
    {
      key: "state",
      label: "State",
      render: (r) => <StatusBadge value={r.state} options={RECONCILIATION_STATE_OPTIONS} />,
    },
    { key: "checks_total", label: "Checks", align: "right", render: (r) => r.checks_total },
    {
      key: "exceptions_found",
      label: "Exceptions",
      align: "right",
      render: (r) => (
        <span className={`tabular-nums font-semibold ${Number(r.exceptions_found) > 0 ? "text-red-600" : "text-emerald-600"}`}>
          {r.exceptions_found}
        </span>
      ),
    },
    { key: "started_at", label: "Started", render: (r) => formatDateTime(r.started_at) },
  ];

  const evaluationProgramColumns = [
    { key: "plan_code", label: "Plan", render: (r) => <span className="font-medium text-slate-700">{r.plan_code}</span> },
    {
      key: "is_active",
      label: "Status",
      render: (r) => (
        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${r.is_active ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
          {r.is_active ? "Active" : "Inactive"}
        </span>
      ),
    },
    { key: "duration_days", label: "Duration", align: "right", render: (r) => `${r.duration_days}d` },
    { key: "payment_requirement", label: "Payment Requirement", render: (r) => r.payment_requirement },
    { key: "conversion_policy", label: "Conversion Policy", render: (r) => r.conversion_policy },
    { key: "expiry_action", label: "Expiry Action", render: (r) => r.expiry_action },
    { key: "approved_by", label: "Approved By", render: (r) => (r.approved_by ? `User #${r.approved_by}` : <span className="text-red-600">Unapproved</span>) },
    {
      key: "actions",
      label: "",
      align: "right",
      render: (r) => (
        <Button
          size="sm"
          variant={r.is_active ? "danger" : "primary"}
          onClick={() => toggleProgramStatus(r)}
          disabled={!canEvaluationProgramWrite || toggleProgramBusyId === r.id}
        >
          {r.is_active ? "Deactivate" : "Activate"}
        </Button>
      ),
    },
  ];

  function mrrValue() {
    if (!mrr) return "—";
    if (mrr.state === "unknown") return "UNKNOWN";
    if (mrr.state === "multi_currency") return `${mrr.currencies.length} currencies`;
    const amount = Number(mrr.amount ?? 0);
    return amount.toLocaleString("en-US", { style: "currency", currency: mrr.currencies[0]?.currency || "USD" });
  }

  const tabs = [
    { key: "quotes", label: "Quotes", icon: Send },
    { key: "invoices", label: "Invoices", icon: Receipt },
    { key: "payments", label: "Payments", icon: CreditCard },
    { key: "reconciliation", label: "Reconciliation", icon: ClipboardCheck },
    { key: "evaluation", label: "Evaluation Programs", icon: Clock },
  ];

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Plane 1 Billing & Reporting"
        description="PLANE 1 — Zoiko→Tenant SaaS money surfaces. Counts and MRR are computed server-side from real rows only — nothing on this page is estimated."
        icon={Landmark}
        meta={report ? `Generated ${formatDateTime(report.generated_at)}` : undefined}
      />

      <div className="mt-6 space-y-8">
        {loading && !report ? (
          <>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => <DashboardStatCardSkeleton key={i} />)}
            </div>
            <Spinner />
          </>
        ) : error && !report ? (
          <ErrorState message={error} onRetry={loadReport} title="Unable to load SaaS reporting" />
        ) : report ? (
          <>
            {/* ── SaaS Reporting ──────────────────────────────────────────── */}
            <section aria-labelledby="saas-reporting-heading">
              <h2 id="saas-reporting-heading" className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-800">
                SaaS Reporting
              </h2>
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
                <DashboardStatCard
                  title="Commercial Accounts"
                  value={report.accounts.total}
                  subtitle="All-time rows by account status"
                  icon={Building2}
                  color="from-brand to-brand-hover"
                />
                <DashboardStatCard
                  title="Open Subscriptions"
                  value={report.subscriptions.total_open}
                  subtitle={`${report.subscriptions.total_ever} ever created`}
                  icon={UserCheck}
                  color="from-emerald-500 to-emerald-600"
                />
                <DashboardStatCard
                  title="MRR"
                  value={mrrValue()}
                  subtitle={
                    mrr?.state === "computed"
                      ? `Priced published versions only · ${mrr.coverage.open_subscriptions_priced}/${mrr.coverage.open_subscriptions_total} open priced`
                      : mrr?.state === "multi_currency"
                        ? "Per-currency totals below — no cross-currency total is fabricated"
                        : "UNKNOWN — no priced published catalog version backs any open subscription"
                  }
                  icon={TrendingUp}
                  color="from-blue-500 to-blue-600"
                />
                <DashboardStatCard
                  title="Plans With Published Price"
                  value={mrr?.coverage.plans_with_published_price ?? 0}
                  subtitle="Price book coverage for MRR computation"
                  icon={Receipt}
                  color="from-slate-500 to-slate-600"
                />
              </div>

              {mrr?.basis && (
                <p className="mt-3 rounded-2xl border border-slate-200 bg-white px-5 py-3 text-xs leading-relaxed text-slate-600">
                  <span className="font-semibold text-slate-800">MRR basis: </span>{mrr.basis}
                  {mrr.currencies.length > 0 && (
                    <span className="ml-2 inline-flex flex-wrap gap-x-4">
                      {mrr.currencies.map((c) => (
                        <span key={c.currency} className="tabular-nums">
                          {c.currency}:{" "}
                          {Number(c.monthly_amount).toLocaleString("en-US", { style: "currency", currency: c.currency })}
                          {" "}
                          ({c.subscriptions} sub{c.subscriptions === 1 ? "" : "s"})
                        </span>
                      ))}
                    </span>
                  )}
                </p>
              )}

              <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-2">
                <StatusCountTable
                  title="Subscriptions by status"
                  counts={report.subscriptions.by_status}
                  options={SUBSCRIPTION_STATUS_OPTIONS}
                />
                <StatusCountTable
                  title="Accounts by status"
                  counts={report.accounts.by_status}
                  options={ACCOUNT_STATUS_OPTIONS}
                />
              </div>

              <div className="mt-5">
                <DataTable
                  columns={planColumns}
                  data={report.subscriptions.open_by_plan}
                  loading={false}
                  emptyTitle="No open subscriptions on any plan"
                  emptyMessage="Open subscriptions appear here grouped by plan with real counts."
                  minWidth={480}
                />
              </div>

              <ul className="mt-4 list-disc space-y-1 pl-5 text-xs leading-relaxed text-slate-600">
                {report.honesty_notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </section>

            {/* ── Plane 1 Transactional Billing ─────────────────────────── */}
            <section aria-labelledby="plane1-money-heading">
              <h2 id="plane1-money-heading" className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-800">
                Invoices, Payments & Collections
              </h2>

              {/* Tab bar */}
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div className="flex gap-1 rounded-xl border border-slate-200 bg-white p-1">
                  {tabs.map((tab) => {
                    const Icon = tab.icon;
                    return (
                      <button
                        key={tab.key}
                        onClick={() => setActiveTab(tab.key)}
                        className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                          activeTab === tab.key
                            ? "bg-slate-800 text-white"
                            : "text-slate-600 hover:bg-slate-100"
                        }`}
                      >
                        <Icon size={16} />
                        {tab.label}
                      </button>
                    );
                  })}
                </div>

                {activeTab === "quotes" && (
                  <div>
                    <Button variant="primary" size="sm" icon={Plus} onClick={() => setCreateQuoteOpen(true)} disabled={!canQuoteWrite}>
                      Create Quote
                    </Button>
                    {!canQuoteWrite && <CapabilityNotice capability="commercial_quote.write" />}
                  </div>
                )}
                {activeTab === "invoices" && (
                  <div>
                    <Button variant="primary" size="sm" icon={Plus} onClick={() => setCreateInvoiceOpen(true)} disabled={!canFinancial}>
                      Create Invoice
                    </Button>
                    {!canFinancial && <CapabilityNotice capability="commercial_financial.write" />}
                  </div>
                )}
                {activeTab === "payments" && (
                  <div>
                    <Button variant="primary" size="sm" icon={Plus} onClick={() => setRecordPaymentOpen(true)} disabled={!canPaymentWrite}>
                      Record Payment
                    </Button>
                    {!canPaymentWrite && <CapabilityNotice capability="commercial_payment.write" />}
                  </div>
                )}
                {activeTab === "evaluation" && (
                  <div>
                    <Button variant="primary" size="sm" icon={Plus} onClick={() => setCreateProgramOpen(true)} disabled={!canEvaluationProgramWrite}>
                      Create Program
                    </Button>
                    {!canEvaluationProgramWrite && <CapabilityNotice capability="commercial_evaluation_program.write" />}
                  </div>
                )}
              </div>

              {/* Tab content */}
              {loadingData ? (
                <Spinner />
              ) : activeTab === "quotes" ? (
                <DataTable
                  columns={quoteColumns}
                  data={quotes}
                  loading={false}
                  emptyTitle="No commercial quotes"
                  emptyMessage="Quotes appear here once created by Zoiko Sales."
                  minWidth={720}
                />
              ) : activeTab === "invoices" ? (
                <DataTable
                  columns={invoiceColumns}
                  data={invoices}
                  loading={false}
                  emptyTitle="No platform invoices"
                  emptyMessage="Invoices appear here once finalized from quotes or created manually."
                  minWidth={720}
                />
              ) : activeTab === "payments" ? (
                <DataTable
                  columns={paymentColumns}
                  data={payments}
                  loading={false}
                  emptyTitle="No platform payments"
                  emptyMessage="Payments appear here once recorded against invoices."
                  minWidth={720}
                />
              ) : activeTab === "reconciliation" ? (
                <>
                  <div className="mb-4 flex items-center justify-between">
                    <p className="text-xs text-slate-500">
                      Checks invoice balance arithmetic and payment allocation integrity across Plane 1 records.
                    </p>
                    <button
                      type="button"
                      onClick={runReconciliation}
                      disabled={runningReconciliation}
                      className="inline-flex items-center gap-2 rounded-lg bg-slate-800 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
                    >
                      <ClipboardCheck size={16} />
                      {runningReconciliation ? "Running…" : "Run Reconciliation"}
                    </button>
                  </div>
                  <DataTable
                    columns={reconciliationColumns}
                    data={reconciliationRuns}
                    loading={false}
                    emptyTitle="No reconciliation runs"
                    emptyMessage="Run reconciliation to check Plane 1 ledger integrity."
                    minWidth={640}
                  />
                </>
              ) : activeTab === "evaluation" ? (
                <>
                  <p className="mb-4 text-xs text-slate-500">
                    §B3 — no plan grants a trial unless a program below is created AND activated.
                    Activating requires a logged approver.
                  </p>
                  <DataTable
                    columns={evaluationProgramColumns}
                    data={evaluationPrograms}
                    loading={false}
                    emptyTitle="No evaluation programs"
                    emptyMessage="No plan currently grants a trial. Create a program to configure one."
                    minWidth={880}
                  />
                </>
              ) : null}
            </section>
          </>
        ) : null}
      </div>

      {/* ── Create Quote modal ──────────────────────────────────────────── */}
      <FormModal
        open={createQuoteOpen}
        onClose={() => setCreateQuoteOpen(false)}
        onSubmit={submitCreateQuote}
        title="Create Commercial Quote"
        description="A new DRAFT quote — add line items after creation, then send it to the org."
        busy={createQuoteBusy}
        error={createQuoteError}
        submitLabel="Create Quote"
      >
        <Field label="Commercial Account" required>
          <Select
            value={createQuoteForm.account_id}
            onChange={(v) => setCreateQuoteForm((f) => ({ ...f, account_id: v }))}
            options={accountOptions}
            placeholder="Select an account…"
          />
        </Field>
        <Field label="Subject">
          <input
            className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
            value={createQuoteForm.subject}
            onChange={(e) => setCreateQuoteForm((f) => ({ ...f, subject: e.target.value }))}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Valid Until">
            <input
              type="date"
              className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
              value={createQuoteForm.valid_until}
              onChange={(e) => setCreateQuoteForm((f) => ({ ...f, valid_until: e.target.value }))}
            />
          </Field>
          <Field label="Currency">
            <input
              className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
              value={createQuoteForm.currency}
              onChange={(e) => setCreateQuoteForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))}
            />
          </Field>
        </div>
        <Field label="Notes">
          <textarea
            rows={2}
            className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
            value={createQuoteForm.notes}
            onChange={(e) => setCreateQuoteForm((f) => ({ ...f, notes: e.target.value }))}
          />
        </Field>
        <Field label="Terms">
          <textarea
            rows={2}
            className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
            value={createQuoteForm.terms}
            onChange={(e) => setCreateQuoteForm((f) => ({ ...f, terms: e.target.value }))}
          />
        </Field>
      </FormModal>

      {/* ── Quote Detail modal ──────────────────────────────────────────── */}
      <Modal
        open={quoteDetailOpen}
        onClose={quoteDetailBusy ? undefined : () => setQuoteDetailOpen(false)}
        closeOnBackdrop={!quoteDetailBusy}
        title={quoteDetail ? `Quote ${quoteDetail.quote_number}` : "Quote"}
        description={quoteDetail?.subject}
        size="lg"
      >
        {quoteDetailError && (
          <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {quoteDetailError}
          </div>
        )}
        {quoteDetailLoading ? (
          <Spinner />
        ) : quoteDetail ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <StatusBadge value={quoteDetail.status} options={QUOTE_STATUS_OPTIONS} />
              <span className="text-sm font-semibold text-slate-800">
                {formatCurrency(quoteDetail.total_amount, quoteDetail.currency)}
              </span>
            </div>

            <ItemsTable items={quoteDetail.items} currency={quoteDetail.currency} />

            {quoteDetail.status === "draft" && (
              <>
                <AddItemForm onAdd={addItemToQuote} busy={quoteDetailBusy} disabled={!canQuoteWrite} />
                {!canQuoteWrite && <CapabilityNotice capability="commercial_quote.write" />}

                <div className="rounded-xl border border-slate-200 p-3.5 space-y-3">
                  <p className="text-sm font-semibold text-slate-800">
                    Quote-level discount
                    {Number(quoteDetail.discount_amount) > 0 && (
                      <span className="ml-2 font-normal text-slate-500">
                        Currently {formatCurrency(quoteDetail.discount_amount, quoteDetail.currency)}
                        {quoteDetail.discount_reason ? ` — ${quoteDetail.discount_reason}` : ""}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-slate-500">
                    A discount at or above the configured % of subtotal requires a reason and an
                    approver (a different Super Admin than the quote's creator) before this quote
                    can be sent.
                  </p>
                  <div className="grid grid-cols-3 gap-3">
                    <Field label="Discount Amount">
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
                        value={discountForm.discount_amount}
                        onChange={(e) => setDiscountForm((f) => ({ ...f, discount_amount: e.target.value }))}
                      />
                    </Field>
                    <Field label="Approver (User ID)" hint="Required above threshold">
                      <input
                        type="number"
                        className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
                        value={discountForm.approver_id}
                        onChange={(e) => setDiscountForm((f) => ({ ...f, approver_id: e.target.value }))}
                      />
                    </Field>
                    <Field label="Reason" hint="Required above threshold">
                      <input
                        type="text"
                        className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
                        value={discountForm.reason}
                        onChange={(e) => setDiscountForm((f) => ({ ...f, reason: e.target.value }))}
                      />
                    </Field>
                  </div>
                  {discountError && (
                    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-700">
                      {discountError}
                    </div>
                  )}
                  <div className="flex justify-end">
                    <Button variant="secondary" onClick={submitDiscount} disabled={!canQuoteWrite || discountBusy}>
                      Set Discount
                    </Button>
                  </div>
                </div>

                <div className="flex justify-end">
                  <Button variant="primary" onClick={sendQuoteAction} disabled={!canQuoteWrite || quoteDetailBusy}>
                    Send Quote
                  </Button>
                </div>
              </>
            )}

            {quoteDetail.status === "sent" && (
              <div>
                <div className="flex flex-wrap justify-end gap-3">
                  <Button variant="danger" onClick={() => setRejectQuoteOpen(true)} disabled={!canQuoteApprove || quoteDetailBusy}>
                    Reject
                  </Button>
                  <Button variant="primary" onClick={approveQuoteAction} disabled={!canQuoteApprove || quoteDetailBusy}>
                    Approve
                  </Button>
                </div>
                {!canQuoteApprove && <CapabilityNotice capability="commercial_quote.approve" />}
              </div>
            )}

            {quoteDetail.status === "accepted" && (
              <div className="flex justify-end">
                <Button variant="primary" onClick={() => setConvertOpen(true)} disabled={!canQuoteWrite || quoteDetailBusy}>
                  Convert to Invoice
                </Button>
              </div>
            )}
          </div>
        ) : null}
      </Modal>

      {/* ── Reject Quote modal ──────────────────────────────────────────── */}
      <FormModal
        open={rejectQuoteOpen}
        onClose={() => setRejectQuoteOpen(false)}
        onSubmit={submitRejectQuote}
        title="Reject Quote"
        description="Record that the org declined this quote."
        busy={rejectQuoteBusy}
        error={rejectQuoteError}
        submitLabel="Reject Quote"
      >
        <Field label="Reason">
          <textarea
            rows={3}
            className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
            value={rejectQuoteReason}
            onChange={(e) => setRejectQuoteReason(e.target.value)}
          />
        </Field>
      </FormModal>

      {/* ── Convert to Invoice modal ─────────────────────────────────────── */}
      <FormModal
        open={convertOpen}
        onClose={() => setConvertOpen(false)}
        onSubmit={submitConvert}
        title="Convert to Invoice"
        description="Creates a DRAFT invoice from this quote's line items. No money moves yet."
        busy={convertBusy}
        error={convertError}
        submitLabel="Convert"
      >
        <Field label="Due Date" hint="Optional">
          <input
            type="date"
            className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
            value={convertDueDate}
            onChange={(e) => setConvertDueDate(e.target.value)}
          />
        </Field>
      </FormModal>

      {/* ── Create Invoice modal ─────────────────────────────────────────── */}
      <FormModal
        open={createInvoiceOpen}
        onClose={() => setCreateInvoiceOpen(false)}
        onSubmit={submitCreateInvoice}
        title="Create Platform Invoice"
        description="A manual DRAFT invoice, not tied to any quote."
        busy={createInvoiceBusy}
        error={createInvoiceError}
        submitLabel="Create Invoice"
      >
        <Field label="Commercial Account" required>
          <Select
            value={createInvoiceForm.account_id}
            onChange={(v) => setCreateInvoiceForm((f) => ({ ...f, account_id: v }))}
            options={accountOptions}
            placeholder="Select an account…"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Issue Date">
            <input
              type="date"
              className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
              value={createInvoiceForm.issue_date}
              onChange={(e) => setCreateInvoiceForm((f) => ({ ...f, issue_date: e.target.value }))}
            />
          </Field>
          <Field label="Due Date">
            <input
              type="date"
              className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
              value={createInvoiceForm.due_date}
              onChange={(e) => setCreateInvoiceForm((f) => ({ ...f, due_date: e.target.value }))}
            />
          </Field>
        </div>
        <Field label="Currency">
          <input
            className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
            value={createInvoiceForm.currency}
            onChange={(e) => setCreateInvoiceForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))}
          />
        </Field>
        <Field label="Notes">
          <textarea
            rows={2}
            className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
            value={createInvoiceForm.notes}
            onChange={(e) => setCreateInvoiceForm((f) => ({ ...f, notes: e.target.value }))}
          />
        </Field>
      </FormModal>

      {/* ── Invoice Detail modal ─────────────────────────────────────────── */}
      <Modal
        open={invoiceDetailOpen}
        onClose={invoiceDetailBusy ? undefined : () => setInvoiceDetailOpen(false)}
        closeOnBackdrop={!invoiceDetailBusy}
        title={invoiceDetail ? `Invoice ${invoiceDetail.invoice_number || "(draft)"}` : "Invoice"}
        description={invoiceDetail ? `Billed to ${invoiceDetail.recipient_org_name || "—"}` : undefined}
        size="lg"
      >
        {invoiceDetailError && (
          <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {invoiceDetailError}
          </div>
        )}
        {invoiceDetailLoading ? (
          <Spinner />
        ) : invoiceDetail ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <StatusBadge value={invoiceDetail.status} options={INVOICE_STATUS_OPTIONS} />
              <div className="text-right">
                <div className="text-sm font-semibold text-slate-800">
                  {formatCurrency(invoiceDetail.total_amount, invoiceDetail.currency)}
                </div>
                <div className="text-xs text-slate-500">
                  Balance due: {formatCurrency(invoiceDetail.balance_due, invoiceDetail.currency)}
                </div>
              </div>
            </div>

            <ItemsTable items={invoiceDetail.items} currency={invoiceDetail.currency} />

            {invoiceDetail.delivery_attempts?.length > 0 && (
              <div className="rounded-xl border border-slate-200 p-3.5">
                <p className="text-sm font-semibold text-slate-800 mb-2">Delivery Attempts</p>
                <ul className="space-y-1.5">
                  {invoiceDetail.delivery_attempts.map((a, i) => (
                    <li key={i} className="flex items-center justify-between text-xs">
                      <span className="text-slate-600">
                        {a.channel}{a.provider ? ` via ${a.provider}` : ""}
                        {a.attempted_at ? ` — ${new Date(a.attempted_at).toLocaleString()}` : ""}
                      </span>
                      <span className={a.result === "success" ? "font-medium text-emerald-600" : "font-medium text-red-600"}>
                        {a.result}
                        {a.error_detail ? `: ${a.error_detail}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {invoiceDetail.status === "draft" && (
              <>
                <AddItemForm onAdd={addItemToInvoice} busy={invoiceDetailBusy} disabled={!canFinancial} />
                {!canFinancial && <CapabilityNotice capability="commercial_financial.write" />}
                <div className="flex justify-end">
                  <Button variant="primary" onClick={finalizeInvoiceAction} disabled={!canFinancial || invoiceDetailBusy}>
                    Finalize
                  </Button>
                </div>
              </>
            )}

            {!["draft", "paid", "voided", "credited"].includes(invoiceDetail.status) && (
              <div>
                <div className="flex flex-wrap justify-end gap-3">
                  <Button variant="danger" onClick={() => setVoidInvoiceOpen(true)} disabled={!canFinancial || invoiceDetailBusy}>
                    Void
                  </Button>
                  <Button variant="primary" onClick={sendInvoiceAction} disabled={!canFinancial || invoiceDetailBusy}>
                    Send Invoice
                  </Button>
                </div>
                {!canFinancial && <CapabilityNotice capability="commercial_financial.write" />}
              </div>
            )}
          </div>
        ) : null}
      </Modal>

      {/* ── Void Invoice modal ───────────────────────────────────────────── */}
      <FormModal
        open={voidInvoiceOpen}
        onClose={() => setVoidInvoiceOpen(false)}
        onSubmit={submitVoidInvoice}
        title="Void Invoice"
        description="Voiding is permanent — corrections happen via a new invoice or credit note, never an edit."
        busy={voidInvoiceBusy}
        error={voidInvoiceError}
        submitLabel="Void Invoice"
      >
        <Field label="Reason" required>
          <textarea
            rows={3}
            className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
            value={voidInvoiceReason}
            onChange={(e) => setVoidInvoiceReason(e.target.value)}
          />
        </Field>
      </FormModal>

      {/* ── Record Payment modal ─────────────────────────────────────────── */}
      <FormModal
        open={recordPaymentOpen}
        onClose={() => setRecordPaymentOpen(false)}
        onSubmit={submitRecordPayment}
        title="Record Platform Payment"
        description="Manual/internal recorder only — always stamped zoiko_platform, never a tenant's Stripe account."
        busy={recordPaymentBusy}
        error={recordPaymentError}
        submitLabel="Record Payment"
      >
        <Field label="Commercial Account" required>
          <Select
            value={recordPaymentForm.account_id}
            onChange={(v) => setRecordPaymentForm((f) => ({ ...f, account_id: v }))}
            options={accountOptions}
            placeholder="Select an account…"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount" required>
            <input
              className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
              value={recordPaymentForm.amount}
              onChange={(e) => setRecordPaymentForm((f) => ({ ...f, amount: e.target.value }))}
            />
          </Field>
          <Field label="Currency">
            <input
              className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
              value={recordPaymentForm.currency}
              onChange={(e) => setRecordPaymentForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))}
            />
          </Field>
        </div>
        <Field label="Payment Method">
          <Select
            value={recordPaymentForm.payment_method}
            onChange={(v) => setRecordPaymentForm((f) => ({ ...f, payment_method: v }))}
            options={PAYMENT_METHOD_OPTIONS}
            placeholder=""
          />
        </Field>
        <Field label="Transaction ID" hint="Optional — e.g. wire reference">
          <input
            className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
            value={recordPaymentForm.transaction_id}
            onChange={(e) => setRecordPaymentForm((f) => ({ ...f, transaction_id: e.target.value }))}
          />
        </Field>
        <Field label="Notes">
          <textarea
            rows={2}
            className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
            value={recordPaymentForm.notes}
            onChange={(e) => setRecordPaymentForm((f) => ({ ...f, notes: e.target.value }))}
          />
        </Field>
      </FormModal>

      {/* ── Create Evaluation Program modal (§B3) ────────────────────────── */}
      <FormModal
        open={createProgramOpen}
        onClose={() => setCreateProgramOpen(false)}
        onSubmit={submitCreateProgram}
        title="Create Evaluation Program"
        description="Starts INACTIVE — creating this grants no trial by itself. Activating it requires a logged approver."
        busy={createProgramBusy}
        error={createProgramError}
        submitLabel="Create Program"
      >
        <Field label="Plan" required>
          <Select
            value={createProgramForm.plan_id}
            onChange={(v) => setCreateProgramForm((f) => ({ ...f, plan_id: v }))}
            options={planOptions}
            placeholder="Select a plan…"
          />
        </Field>
        <Field label="Duration (days)" required>
          <input
            type="number"
            min="1"
            className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
            value={createProgramForm.duration_days}
            onChange={(e) => setCreateProgramForm((f) => ({ ...f, duration_days: e.target.value }))}
          />
        </Field>
        <Field label="Payment Requirement">
          <Select
            value={createProgramForm.payment_requirement}
            onChange={(v) => setCreateProgramForm((f) => ({ ...f, payment_requirement: v }))}
            options={EVALUATION_PAYMENT_REQUIREMENT_OPTIONS}
            placeholder=""
          />
        </Field>
        <Field label="Conversion Policy">
          <Select
            value={createProgramForm.conversion_policy}
            onChange={(v) => setCreateProgramForm((f) => ({ ...f, conversion_policy: v }))}
            options={EVALUATION_CONVERSION_POLICY_OPTIONS}
            placeholder=""
          />
        </Field>
        <Field label="Expiry Action">
          <Select
            value={createProgramForm.expiry_action}
            onChange={(v) => setCreateProgramForm((f) => ({ ...f, expiry_action: v }))}
            options={EVALUATION_EXPIRY_ACTION_OPTIONS}
            placeholder=""
          />
        </Field>
        <Field label="Approved By (User ID)" hint="Required before this program can be activated (§B3)">
          <input
            type="number"
            className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
            value={createProgramForm.approved_by}
            onChange={(e) => setCreateProgramForm((f) => ({ ...f, approved_by: e.target.value }))}
          />
        </Field>
      </FormModal>

      {/* ── Allocate Payment modal ───────────────────────────────────────── */}
      <FormModal
        open={allocateOpen}
        onClose={() => setAllocateOpen(false)}
        onSubmit={submitAllocate}
        title="Allocate Payment"
        description={allocateTarget ? `Apply payment ${allocateTarget.payment_number} against an open invoice.` : undefined}
        busy={allocateBusy}
        error={allocateError}
        submitLabel="Allocate"
      >
        <Field label="Invoice" required hint="Only open (unpaid) invoices for this payment's account are listed">
          <Select
            value={allocateForm.invoice_id}
            onChange={(v) => setAllocateForm((f) => ({ ...f, invoice_id: v }))}
            options={allocateInvoices.map((inv) => ({
              value: String(inv.id),
              label: `${inv.invoice_number || "DRAFT"} — balance ${formatCurrency(inv.balance_due, inv.currency)}`,
            }))}
            placeholder="Select an invoice…"
          />
        </Field>
        <Field label="Amount" required>
          <input
            className="w-full rounded-xl border border-slate-200 px-3.5 py-2.5 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30"
            value={allocateForm.amount}
            onChange={(e) => setAllocateForm((f) => ({ ...f, amount: e.target.value }))}
          />
        </Field>
      </FormModal>

      {/* ── Deallocate Payment modal ─────────────────────────────────────── */}
      <FormModal
        open={deallocateOpen}
        onClose={() => setDeallocateOpen(false)}
        onSubmit={submitDeallocate}
        title="Deallocate Payment"
        description={deallocateTarget ? `Remove payment ${deallocateTarget.payment_number}'s allocation from an invoice.` : undefined}
        busy={deallocateBusy}
        error={deallocateError}
        submitLabel="Deallocate"
      >
        <Field label="Invoice" required hint="The backend rejects this if the payment has no existing allocation on the invoice you pick">
          <Select
            value={deallocateInvoiceId}
            onChange={setDeallocateInvoiceId}
            options={deallocateInvoices.map((inv) => ({
              value: String(inv.id),
              label: inv.invoice_number || "DRAFT",
            }))}
            placeholder="Select an invoice…"
          />
        </Field>
      </FormModal>

      {ConfirmationDialog}
    </div>
  );
}
