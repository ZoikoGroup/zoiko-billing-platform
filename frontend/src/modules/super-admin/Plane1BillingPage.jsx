import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  AlertTriangle,
  Building2,
  CheckCircle,
  ClipboardCheck,
  Clock,
  CreditCard,
  ExternalLink,
  Eye,
  Landmark,
  Plus,
  Receipt,
  RefreshCw,
  Send,
  TrendingUp,
  UserCheck,
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
  approveEvaluationProgram,
  getConfigurationInventory,
} from "../../service/commandCenterService";
import {
  PageHeader,
  DataTable,
  FormModal,
  Modal,
  Field,
  Select,
  Button,
  HubTabs,
  SearchInput,
  SectionCard,
  FORM_CONTROL_CLASS,
} from "../../components/billing-ui";
import {
  DashboardStatCard,
  DashboardStatCardSkeleton,
  ErrorState,
  Spinner,
  SuccessMessage,
  useConfirmationDialog,
} from "../../components/billing-shared";
import { SUBSCRIPTION_STATUS_OPTIONS, ACCOUNT_STATUS_OPTIONS, formatDateTime } from "./constants";

// ── helpers ─────────────────────────────────────────────────────────────────

function labelFor(options, value) {
  const match = (options || []).find((o) => o.value === value);
  if (match) return match.label;
  if (value === null || value === undefined || value === "") return "—";
  return String(value).replaceAll("_", " ");
}

function errorMessage(err, fallback) {
  return err?.message || err?.detail || fallback;
}

// Plane 1 timestamps are naive-UTC columns (datetime.utcnow) serialized
// without an offset; JS would read such a string as LOCAL time and shift every
// stamp by the viewer's UTC offset. Offset-less values are read as UTC here.
export function parseServerDateTime(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return value;
  const s = String(value).trim();
  const hasTime = /T\d{2}:\d{2}/.test(s) || / \d{2}:\d{2}/.test(s);
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/i.test(s);
  const d = new Date(hasTime && !hasOffset ? `${s.replace(" ", "T")}Z` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatServerDateTime(value) {
  const d = parseServerDateTime(value);
  return d ? formatDateTime(d) : "—";
}

// Date-only values (issue/due/valid-until) are calendar dates: new Date("2026-03-01")
// is UTC midnight and renders as the previous day west of UTC.
export function formatCalendarDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? ""));
  if (!m) return "—";
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// Amounts arrive as decimal strings and are formatted one row/currency at a
// time — never summed across currencies. An unknown or malformed currency
// code (the create forms used to accept any text) must not throw a
// RangeError out of toLocaleString and take the whole table down.
export function formatCurrency(amount, currency) {
  if (amount === null || amount === undefined || amount === "") return "—";
  const num = Number(amount);
  if (!Number.isFinite(num)) return String(amount);
  const code = String(currency || "").trim().toUpperCase();
  if (/^[A-Z]{3}$/.test(code)) {
    try {
      return num.toLocaleString("en-US", { style: "currency", currency: code });
    } catch {
      /* fall through to the plain format */
    }
  }
  const plain = num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return code ? `${plain} ${code}` : plain;
}

const CURRENCY_RE = /^[A-Z]{3}$/;
const DECIMAL_RE = /^\d+(\.\d{1,4})?$/;

function isPositiveDecimal(value) {
  const s = String(value ?? "").trim();
  return DECIMAL_RE.test(s) && Number(s) > 0;
}

function isNonNegativeDecimal(value) {
  const s = String(value ?? "").trim();
  return s === "" || DECIMAL_RE.test(s);
}

function UpdatedAgo({ date }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, []);
  if (!date) return <span>Loading…</span>;
  const secs = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  const label = secs < 5 ? "just now" : secs < 60 ? `${secs}s ago` : `${Math.floor(secs / 60)}m ago`;
  return <span>Updated {label}</span>;
}

// Local equivalent of the shared useLiveRefresh(load, { intervalMs, enabled })
// contract → { lastUpdated, refreshing, refreshError, refresh }. Background
// refreshes run only while the tab is visible AND focused, fire immediately
// when the window regains focus, are skipped while `enabled` is false (a
// mutation is in flight), and ignore out-of-order completions. `load` must
// reject on failure so the last good data can stay on screen with a note.
function useLiveRefresh(load, { intervalMs = 45000, enabled = true } = {}) {
  const loadRef = useRef(load);
  loadRef.current = load;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const seqRef = useRef(0);
  const inFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(null);

  const refresh = useCallback(async ({ auto = false } = {}) => {
    if (auto && (!enabledRef.current || inFlightRef.current)) return;
    const id = ++seqRef.current;
    inFlightRef.current = true;
    setRefreshing(true);
    try {
      await loadRef.current();
      if (mountedRef.current && id === seqRef.current) {
        setLastUpdated(new Date());
        setRefreshError(null);
      }
    } catch (e) {
      if (mountedRef.current && id === seqRef.current) setRefreshError(e?.message || "Refresh failed");
    } finally {
      if (id === seqRef.current) {
        inFlightRef.current = false;
        if (mountedRef.current) setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    return () => {
      mountedRef.current = false;
    };
  }, [refresh]);

  useEffect(() => {
    const active = () =>
      document.visibilityState === "visible" && (typeof document.hasFocus !== "function" || document.hasFocus());
    const timer = setInterval(() => {
      if (active()) refresh({ auto: true });
    }, intervalMs);
    const onFocus = () => {
      if (active()) refresh({ auto: true });
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [intervalMs, refresh]);

  return { lastUpdated, refreshing, refreshError, refresh };
}

// ── option lists (values match backend/app/modules/commercial/enums.py) ────

const QUOTE_STATUS_OPTIONS = [
  { value: "draft", label: "Draft" },
  { value: "sent", label: "Sent" },
  { value: "accepted", label: "Accepted" },
  { value: "rejected", label: "Rejected" },
  { value: "expired", label: "Expired" },
  { value: "converted", label: "Invoiced" },
];

const INVOICE_STATUS_OPTIONS = [
  { value: "draft", label: "Draft" },
  { value: "review_required", label: "Review Required" },
  { value: "approved", label: "Approved" },
  { value: "issued", label: "Issued" },
  { value: "delivered", label: "Delivered" },
  { value: "delivery_failed", label: "Delivery Failed" },
  { value: "due", label: "Due" },
  { value: "partially_paid", label: "Partially Paid" },
  { value: "paid", label: "Paid" },
  { value: "overdue", label: "Overdue" },
  { value: "disputed", label: "Disputed" },
  { value: "credited", label: "Credited" },
  { value: "voided", label: "Voided" },
];

// PlatformInvoiceService._TRANSITIONS: statuses that can move to VOIDED.
// DRAFT is excluded explicitly by void() ("void is for issued invoices").
export const VOIDABLE_INVOICE_STATUSES = [
  "review_required",
  "approved",
  "issued",
  "delivered",
  "delivery_failed",
  "due",
  "partially_paid",
  "overdue",
  "disputed",
];
// PlatformInvoiceService.send() → _require_status(ISSUED): only ISSUED invoices
// can be emailed; every later status is rejected by the backend.
export const SENDABLE_INVOICE_STATUSES = ["issued"];
// Allocation targets: allocate() only checks balance_due > 0, but a payment
// must never settle a draft (it would flip a never-issued invoice to PAID) or
// a voided/credited one.
const ALLOCATABLE_INVOICE_EXCLUDED = ["draft", "voided", "credited", "paid"];

const PAYMENT_STATUS_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "processing", label: "Processing" },
  { value: "cleared", label: "Cleared" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "refunded", label: "Refunded" },
];

// The manual recorder only offers methods PlatformPaymentService.record()
// clears immediately. "card" is recorded as PENDING and allocate() requires
// CLEARED, so a manually recorded card payment could never be applied to an
// invoice — card payments arrive through Stripe checkout instead.
const PAYMENT_METHOD_OPTIONS = [
  { value: "wire_transfer", label: "Wire transfer" },
  { value: "ach", label: "ACH" },
  { value: "manual", label: "Other (manual)" },
];
const PAYMENT_METHOD_LABELS = [...PAYMENT_METHOD_OPTIONS, { value: "card", label: "Card" }];

const EVALUATION_PAYMENT_REQUIREMENT_OPTIONS = [
  { value: "none", label: "No card required" },
  { value: "card_required_upfront", label: "Card required up front" },
];

const EVALUATION_CONVERSION_POLICY_OPTIONS = [
  { value: "manual", label: "Manual conversion" },
  { value: "auto_charge_on_expiry", label: "Auto-charge on expiry (not yet implemented)" },
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

const BADGE_COLORS = {
  draft: "bg-slate-100 text-slate-600",
  sent: "bg-blue-100 text-blue-700",
  accepted: "bg-emerald-100 text-emerald-700",
  approved: "bg-emerald-100 text-emerald-700",
  rejected: "bg-red-100 text-red-700",
  expired: "bg-amber-100 text-amber-800",
  converted: "bg-purple-100 text-purple-700",
  review_required: "bg-amber-100 text-amber-800",
  issued: "bg-blue-100 text-blue-700",
  delivered: "bg-emerald-100 text-emerald-700",
  delivery_failed: "bg-red-100 text-red-700",
  due: "bg-amber-100 text-amber-800",
  partially_paid: "bg-orange-100 text-orange-700",
  paid: "bg-emerald-100 text-emerald-700",
  overdue: "bg-red-100 text-red-700",
  disputed: "bg-red-100 text-red-700",
  credited: "bg-purple-100 text-purple-700",
  voided: "bg-slate-200 text-slate-600",
  cleared: "bg-emerald-100 text-emerald-700",
  pending: "bg-amber-100 text-amber-800",
  processing: "bg-blue-100 text-blue-700",
  failed: "bg-red-100 text-red-700",
  cancelled: "bg-slate-200 text-slate-600",
  refunded: "bg-purple-100 text-purple-700",
  running: "bg-blue-100 text-blue-700",
  verified: "bg-emerald-100 text-emerald-700",
  partial: "bg-amber-100 text-amber-800",
};

function StatusBadge({ value, options }) {
  const key = String(value ?? "").toLowerCase();
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-bold ${BADGE_COLORS[key] || "bg-slate-100 text-slate-600"}`}>
      {labelFor(options, key)}
    </span>
  );
}

function CapabilityNotice({ capability }) {
  return (
    <p className="mt-2 text-xs text-amber-700">
      Not available — your platform role does not include the {capability} capability. Ask a Platform
      Administrator for access.
    </p>
  );
}

function InlineAlert({ children, onDismiss, tone = "error" }) {
  const cls =
    tone === "warning"
      ? "border-amber-200 bg-amber-50 text-amber-800"
      : "border-red-200 bg-red-50 text-red-700";
  return (
    <div role="alert" className={`mb-4 flex items-start gap-2 rounded-lg border p-3 text-sm ${cls}`}>
      <AlertTriangle size={16} className="mt-0.5 shrink-0" />
      <div className="flex-1">{children}</div>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="text-xs font-semibold underline">
          Dismiss
        </button>
      )}
    </div>
  );
}

function StatusCountList({ title, counts, options }) {
  const entries = Object.entries(counts || {});
  const total = entries.reduce((sum, [, n]) => sum + Number(n || 0), 0);
  return (
    <SectionCard variant="quiet" title={title} description={`${total} in total`}>
      {entries.length === 0 ? (
        <p className="text-xs text-slate-500">None yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {entries.map(([status, count]) => (
            <li key={status} className="flex items-center justify-between gap-3 text-sm">
              <span className="text-slate-600">{labelFor(options, status)}</span>
              <span className="font-semibold tabular-nums text-slate-800">{count}</span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
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
            <th className="px-3 py-2 text-right font-semibold">Unit price</th>
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
              <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-800">{formatCurrency(it.total, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SMALL_INPUT = "rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30";

// `onAdd` returns a promise resolving true on success. The inputs are cleared
// only then — they used to be wiped before the request, so a rejected line
// (bad number, wrong status) lost everything the operator had typed.
export function AddItemForm({ onAdd, busy, disabled }) {
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unitPrice, setUnitPrice] = useState("");
  const [discountAmount, setDiscountAmount] = useState("0");
  const [taxAmount, setTaxAmount] = useState("0");
  const [formError, setFormError] = useState(null);

  if (disabled) return null;

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (!description.trim()) return setFormError("Enter a description.");
    if (!isPositiveDecimal(quantity)) return setFormError("Quantity must be a positive number.");
    if (!isNonNegativeDecimal(unitPrice) || unitPrice.trim() === "") return setFormError("Enter a unit price (e.g. 49.00).");
    if (!isNonNegativeDecimal(discountAmount) || !isNonNegativeDecimal(taxAmount)) {
      return setFormError("Discount and tax must be numbers of 0 or more.");
    }
    setFormError(null);
    const ok = await onAdd({
      description: description.trim(),
      quantity: quantity.trim(),
      unit_price: unitPrice.trim(),
      discount_amount: discountAmount.trim() || "0",
      tax_amount: taxAmount.trim() || "0",
    });
    if (ok) {
      setDescription("");
      setQuantity("1");
      setUnitPrice("");
      setDiscountAmount("0");
      setTaxAmount("0");
    }
  };

  return (
    <form onSubmit={submit} className="mt-3" aria-label="Add line item">
      <div className="grid grid-cols-12 gap-2">
        <input aria-label="Description" className={`col-span-12 sm:col-span-4 ${SMALL_INPUT}`} placeholder="Description" value={description} onChange={(e) => setDescription(e.target.value)} disabled={busy} />
        <input aria-label="Quantity" inputMode="decimal" className={`col-span-3 sm:col-span-1 ${SMALL_INPUT}`} placeholder="Qty" value={quantity} onChange={(e) => setQuantity(e.target.value)} disabled={busy} />
        <input aria-label="Unit price" inputMode="decimal" className={`col-span-3 sm:col-span-2 ${SMALL_INPUT}`} placeholder="Unit price" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} disabled={busy} />
        <input aria-label="Discount" inputMode="decimal" className={`col-span-3 sm:col-span-2 ${SMALL_INPUT}`} placeholder="Discount" value={discountAmount} onChange={(e) => setDiscountAmount(e.target.value)} disabled={busy} />
        <input aria-label="Tax" inputMode="decimal" className={`col-span-3 sm:col-span-2 ${SMALL_INPUT}`} placeholder="Tax" value={taxAmount} onChange={(e) => setTaxAmount(e.target.value)} disabled={busy} />
        <button
          type="submit"
          disabled={busy}
          className="col-span-12 flex items-center justify-center gap-1.5 rounded-lg bg-slate-800 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-slate-700 disabled:opacity-50 sm:col-span-1"
        >
          <Plus size={14} /> Add
        </button>
      </div>
      {formError && <p role="alert" className="mt-1.5 text-xs font-medium text-red-600">{formError}</p>}
    </form>
  );
}

const VALID_TABS = ["quotes", "invoices", "payments", "reconciliation", "evaluation"];
const LIST_LIMIT = 200; // backend max for these list endpoints (le=200)
const LIVE_REFRESH_MS = 45000;
const SUCCESS_DISMISS_MS = 5000;

const EMPTY_QUOTE_FORM = { account_id: "", subject: "", notes: "", terms: "", valid_until: "", currency: "USD" };
const EMPTY_INVOICE_FORM = { account_id: "", issue_date: "", due_date: "", notes: "", currency: "USD" };
const EMPTY_PAYMENT_FORM = { account_id: "", amount: "", currency: "USD", payment_method: "wire_transfer", transaction_id: "", notes: "" };
const EMPTY_PROGRAM_FORM = {
  plan_id: "",
  duration_days: "14",
  payment_requirement: "none",
  conversion_policy: "manual",
  expiry_action: "suspend",
};
const EMPTY_FILTERS = { q: "", status: "" };

function rowsFrom(data, key) {
  if (Array.isArray(data)) return data;
  return Array.isArray(data?.[key]) ? data[key] : [];
}

function orgName(r) {
  return r.organization?.name || r.organization_name || "Unknown organization";
}

export default function Plane1BillingPage() {
  const { user } = useAuth();
  const platformRole = user?.platform_role;
  const canQuoteWrite = canWriteCommercialQuote(platformRole);
  const canQuoteApprove = canApproveCommercialQuote(platformRole);
  const canPaymentWrite = canWriteCommercialPayment(platformRole);
  // Invoice MUTATIONS (create/add-item/finalize/void/send) are backed by
  // commercial_financial.write, not the read capability.
  const canFinancial = canWriteCommercialFinancial(platformRole);
  const canEvaluationProgramWrite = canWriteEvaluationProgram(platformRole);

  const { confirm, ConfirmationDialog } = useConfirmationDialog();

  const [report, setReport] = useState(null);
  const [reportError, setReportError] = useState(null);

  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = VALID_TABS.includes(searchParams.get("tab")) ? searchParams.get("tab") : "quotes";
  const [activeTab, setActiveTabState] = useState(initialTab);
  const activeTabRef = useRef(initialTab);
  activeTabRef.current = activeTab;

  const setActiveTab = useCallback(
    (tab) => {
      setActiveTabState(tab);
      setSearchParams({ tab }, { replace: true });
    },
    [setSearchParams]
  );

  const [tabData, setTabData] = useState({ quotes: [], invoices: [], payments: [], reconciliation: [], evaluation: [] });
  const [tabLoaded, setTabLoaded] = useState({});
  const [tabErrors, setTabErrors] = useState({});
  const tabSeqRef = useRef({});
  const tabLoadedRef = useRef({});
  const reportRef = useRef(null);

  const [filters, setFilters] = useState({ quotes: EMPTY_FILTERS, invoices: EMPTY_FILTERS, payments: EMPTY_FILTERS });
  const setFilter = (tab, patch) => setFilters((f) => ({ ...f, [tab]: { ...f[tab], ...patch } }));

  const [success, setSuccess] = useState(null);
  useEffect(() => {
    if (!success) return undefined;
    const t = setTimeout(() => setSuccess(null), SUCCESS_DISMISS_MS);
    return () => clearTimeout(t);
  }, [success]);
  const [actionError, setActionError] = useState(null);

  // ── lookups ──────────────────────────────────────────────────────────────
  const [accounts, setAccounts] = useState([]);
  const [accountsError, setAccountsError] = useState(null);
  const loadAccounts = useCallback(() => {
    setAccountsError(null);
    listCommercialAccounts({ limit: 200 })
      .then((data) => setAccounts(rowsFrom(data, "accounts")))
      .catch((e) => setAccountsError(errorMessage(e, "Couldn't load commercial accounts.")));
  }, []);
  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);
  const accountOptions = accounts.map((a) => ({
    value: String(a.id),
    label: `${a.organization_name} (${a.organization_code})`,
  }));
  const accountName = (id) => {
    const a = accounts.find((x) => String(x.id) === String(id));
    return a ? a.organization_name : id != null ? `Account #${id}` : "—";
  };

  const [plans, setPlans] = useState([]);
  useEffect(() => {
    listCommercialPlans({ limit: 200 })
      .then((data) => setPlans(rowsFrom(data, "plans")))
      .catch(() => setPlans([]));
  }, []);
  const planOptions = plans.map((p) => ({ value: String(p.id), label: `${p.plan_name} (${p.plan_code})` }));

  // Online (card) payment of a Plane 1 invoice runs on Zoiko's own Stripe
  // account. Without PLATFORM_STRIPE_SECRET_KEY the public invoice page shows
  // "Online payment is not available yet"; without the webhook secret a paid
  // checkout is never recorded. Presence-only, from the configuration
  // inventory — "unknown" when this role can't read it.
  const [onlinePayment, setOnlinePayment] = useState({ state: "unknown" });
  useEffect(() => {
    getConfigurationInventory()
      .then((inv) => {
        const entries = Array.isArray(inv?.entries) ? inv.entries : [];
        const find = (name) => entries.find((e) => e.name === name)?.value;
        const checkout = find("stripe.platform_checkout");
        const webhook = find("stripe.platform_webhook");
        if (checkout === undefined) return setOnlinePayment({ state: "unknown" });
        if (checkout !== "CONFIGURED") return setOnlinePayment({ state: "not_configured" });
        if (webhook !== "CONFIGURED") return setOnlinePayment({ state: "webhook_missing" });
        return setOnlinePayment({ state: "configured" });
      })
      .catch(() => setOnlinePayment({ state: "unknown" }));
  }, []);

  // ── loading ─────────────────────────────────────────────────────────────
  // Every loader keeps the last good data on failure. Only a source that has
  // never loaded shows an error screen (with its filters still on screen);
  // later failures surface as the small "Couldn't refresh" note.
  const loadReport = useCallback(
    () =>
      getSaasCommercialReporting().then(
        (data) => {
          reportRef.current = data;
          setReport(data);
          setReportError(null);
        },
        (e) => {
          if (!reportRef.current) setReportError(errorMessage(e, "Failed to load SaaS reporting."));
          throw e;
        }
      ),
    []
  );

  const fetchTab = (tab) => {
    if (tab === "quotes") return listCommercialQuotes({ limit: LIST_LIMIT }).then((d) => rowsFrom(d, "quotes"));
    if (tab === "invoices") return listPlatformInvoices({ limit: LIST_LIMIT }).then((d) => rowsFrom(d, "invoices"));
    if (tab === "payments") return listPlatformPayments({ limit: LIST_LIMIT }).then((d) => rowsFrom(d, "payments"));
    if (tab === "reconciliation") return listPlatformReconciliationRuns(20).then((d) => rowsFrom(d, "runs"));
    if (tab === "evaluation") return listEvaluationPrograms().then((d) => rowsFrom(d, "programs"));
    return Promise.resolve([]);
  };

  const loadTabData = useCallback((tab) => {
    const id = (tabSeqRef.current[tab] = (tabSeqRef.current[tab] || 0) + 1);
    return fetchTab(tab).then(
      (rows) => {
        if (id !== tabSeqRef.current[tab]) return; // superseded by a newer load
        tabLoadedRef.current[tab] = true;
        setTabData((prev) => ({ ...prev, [tab]: rows }));
        setTabLoaded((prev) => ({ ...prev, [tab]: true }));
        setTabErrors((prev) => {
          if (!(tab in prev)) return prev;
          const { [tab]: _cleared, ...rest } = prev;
          return rest;
        });
      },
      (e) => {
        if (id !== tabSeqRef.current[tab]) return;
        if (!tabLoadedRef.current[tab]) {
          setTabErrors((prev) => ({ ...prev, [tab]: errorMessage(e, "Failed to load this list.") }));
        }
        throw e;
      }
    );
  }, []);

  // ── busy tracking (background refresh never fires mid-mutation) ──────────
  const [createQuoteBusy, setCreateQuoteBusy] = useState(false);
  const [quoteDetailBusy, setQuoteDetailBusy] = useState(false);
  const [discountBusy, setDiscountBusy] = useState(false);
  const [rejectQuoteBusy, setRejectQuoteBusy] = useState(false);
  const [convertBusy, setConvertBusy] = useState(false);
  const [createInvoiceBusy, setCreateInvoiceBusy] = useState(false);
  const [invoiceDetailBusy, setInvoiceDetailBusy] = useState(false);
  const [voidInvoiceBusy, setVoidInvoiceBusy] = useState(false);
  const [recordPaymentBusy, setRecordPaymentBusy] = useState(false);
  const [allocateBusy, setAllocateBusy] = useState(false);
  const [deallocateBusy, setDeallocateBusy] = useState(false);
  const [createProgramBusy, setCreateProgramBusy] = useState(false);
  const [programBusyId, setProgramBusyId] = useState(null);
  const [runningReconciliation, setRunningReconciliation] = useState(false);
  const anyBusy =
    createQuoteBusy || quoteDetailBusy || discountBusy || rejectQuoteBusy || convertBusy || createInvoiceBusy ||
    invoiceDetailBusy || voidInvoiceBusy || recordPaymentBusy || allocateBusy || deallocateBusy ||
    createProgramBusy || programBusyId !== null || runningReconciliation;

  const live = useLiveRefresh(
    () => Promise.all([loadReport(), loadTabData(activeTabRef.current)]),
    { intervalMs: LIVE_REFRESH_MS, enabled: !anyBusy }
  );
  const refreshNow = live.refresh;

  // Switching tabs shows that tab's cached rows immediately and refreshes it
  // in the background; a spinner only appears the first time a tab loads.
  const firstTabEffect = useRef(true);
  useEffect(() => {
    if (firstTabEffect.current) {
      firstTabEffect.current = false;
      return;
    }
    loadTabData(activeTab).catch(() => {});
  }, [activeTab, loadTabData]);

  const retryTab = (tab) => {
    setTabErrors(({ [tab]: _cleared, ...rest }) => rest);
    loadTabData(tab).catch(() => {});
  };

  const afterMutation = (message) => {
    if (message) setSuccess(message);
    refreshNow();
  };

  const runReconciliation = () => {
    setRunningReconciliation(true);
    setActionError(null);
    triggerPlatformReconciliation()
      .then((run) => {
        const state = String(run?.state || "").toLowerCase();
        afterMutation(
          run?.id
            ? `Reconciliation run #${run.id} finished: ${labelFor(RECONCILIATION_STATE_OPTIONS, state)}, ${run.exceptions_found ?? 0} exception(s).`
            : "Reconciliation run finished."
        );
      })
      .catch((e) => setActionError(errorMessage(e, "Reconciliation run failed.")))
      .finally(() => setRunningReconciliation(false));
  };

  // ── Evaluation Programs (§B3) ────────────────────────────────────────────
  const [createProgramOpen, setCreateProgramOpen] = useState(false);
  const [createProgramError, setCreateProgramError] = useState(null);
  const [createProgramForm, setCreateProgramForm] = useState(EMPTY_PROGRAM_FORM);

  const submitCreateProgram = () => {
    const days = Number(createProgramForm.duration_days);
    if (!createProgramForm.plan_id) return setCreateProgramError("Select a plan.");
    if (!Number.isInteger(days) || days <= 0) return setCreateProgramError("Duration must be a whole number of days greater than 0.");
    setCreateProgramBusy(true);
    setCreateProgramError(null);
    createEvaluationProgram({
      plan_id: Number(createProgramForm.plan_id),
      duration_days: days,
      payment_requirement: createProgramForm.payment_requirement,
      conversion_policy: createProgramForm.conversion_policy,
      expiry_action: createProgramForm.expiry_action,
    })
      .then(() => {
        setCreateProgramOpen(false);
        setCreateProgramForm(EMPTY_PROGRAM_FORM);
        afterMutation("Evaluation program created (inactive). Approve it, then activate it when ready.");
      })
      .catch((e) => setCreateProgramError(errorMessage(e, "Failed to create evaluation program.")))
      .finally(() => setCreateProgramBusy(false));
  };

  // The backend rejects activating an unapproved program; approval records the
  // calling admin via the audited /approve endpoint (it used to be a free-text
  // "Approved By (User ID)" field on create that accepted any number).
  const approveProgram = async (program) => {
    const ok = await confirm({
      title: "Approve evaluation program",
      message: `Record yourself as the approver for the ${program.plan_code || "selected"} trial program. Approval is audited and does not activate the program.`,
      confirmLabel: "Approve",
      tone: "primary",
    });
    if (!ok) return;
    setProgramBusyId(program.id);
    setActionError(null);
    approveEvaluationProgram(program.id)
      .then(() => afterMutation("Program approved. It can now be activated."))
      .catch((e) => setActionError(errorMessage(e, "Failed to approve program.")))
      .finally(() => setProgramBusyId(null));
  };

  const toggleProgramStatus = async (program) => {
    if (program.is_active) {
      const ok = await confirm({
        title: "Deactivate evaluation program",
        message: `New signups for ${program.plan_code || "this plan"} will no longer get a trial. Existing trials are not changed.`,
        confirmLabel: "Deactivate",
        tone: "danger",
      });
      if (!ok) return;
    }
    setProgramBusyId(program.id);
    setActionError(null);
    setEvaluationProgramStatus(program.id, !program.is_active)
      .then(() => afterMutation(program.is_active ? "Program deactivated." : "Program activated."))
      .catch((e) => setActionError(errorMessage(e, "Failed to change program status.")))
      .finally(() => setProgramBusyId(null));
  };

  // ── Create Quote ──────────────────────────────────────────────────────
  const [createQuoteOpen, setCreateQuoteOpen] = useState(false);
  const [createQuoteError, setCreateQuoteError] = useState(null);
  const [createQuoteForm, setCreateQuoteForm] = useState(EMPTY_QUOTE_FORM);

  const openCreate = (setOpen, setError) => {
    setError(null);
    if (accounts.length === 0) loadAccounts();
    setOpen(true);
  };

  const submitCreateQuote = () => {
    if (!createQuoteForm.account_id) return setCreateQuoteError("Select a commercial account.");
    if (!CURRENCY_RE.test(createQuoteForm.currency)) return setCreateQuoteError("Currency must be a 3-letter code such as USD.");
    setCreateQuoteBusy(true);
    setCreateQuoteError(null);
    createCommercialQuote({
      account_id: Number(createQuoteForm.account_id),
      subject: createQuoteForm.subject || undefined,
      notes: createQuoteForm.notes || undefined,
      terms: createQuoteForm.terms || undefined,
      valid_until: createQuoteForm.valid_until || undefined,
      currency: createQuoteForm.currency,
    })
      .then((quote) => {
        setCreateQuoteOpen(false);
        setCreateQuoteForm(EMPTY_QUOTE_FORM);
        afterMutation("Draft quote created. Open it to add line items, then send it.");
        if (quote?.id) openQuoteDetail(quote);
      })
      .catch((e) => setCreateQuoteError(errorMessage(e, "Failed to create quote.")))
      .finally(() => setCreateQuoteBusy(false));
  };

  // ── Quote detail ─────────────────────────────────────────────────────────
  const [quoteDetail, setQuoteDetail] = useState(null);
  const [quoteDetailOpen, setQuoteDetailOpen] = useState(false);
  const [quoteDetailLoading, setQuoteDetailLoading] = useState(false);
  const [quoteDetailError, setQuoteDetailError] = useState(null);
  const quoteSeqRef = useRef(0);
  const [discountForm, setDiscountForm] = useState({ discount_amount: "", reason: "", approver_id: "" });
  const [discountError, setDiscountError] = useState(null);

  // The previous quote is cleared (and the discount form reset) on open: the
  // modal used to show the last quote's title — and, if this load failed, its
  // whole body and action buttons — under the new quote's error.
  function openQuoteDetail(row) {
    const id = ++quoteSeqRef.current;
    setQuoteDetail(null);
    setQuoteDetailOpen(true);
    setQuoteDetailError(null);
    setDiscountError(null);
    setDiscountForm({ discount_amount: "", reason: "", approver_id: "" });
    setQuoteDetailLoading(true);
    getCommercialQuote(row.id)
      .then((q) => {
        if (id === quoteSeqRef.current) setQuoteDetail(q);
      })
      .catch((e) => {
        if (id === quoteSeqRef.current) setQuoteDetailError(errorMessage(e, "Failed to load quote."));
      })
      .finally(() => {
        if (id === quoteSeqRef.current) setQuoteDetailLoading(false);
      });
  }

  const refreshQuoteDetail = (quoteId) =>
    getCommercialQuote(quoteId).then((q) => {
      setQuoteDetail((cur) => (cur && cur.id === q.id ? q : cur));
    });

  const addItemToQuote = (item) => {
    setQuoteDetailBusy(true);
    setQuoteDetailError(null);
    const lineNumber = (quoteDetail?.items?.length || 0) + 1;
    return addCommercialQuoteItem(quoteDetail.id, { line_number: lineNumber, ...item })
      .then(() => refreshQuoteDetail(quoteDetail.id))
      .then(() => {
        afterMutation();
        return true;
      })
      .catch((e) => {
        setQuoteDetailError(errorMessage(e, "Failed to add item."));
        return false;
      })
      .finally(() => setQuoteDetailBusy(false));
  };

  const submitDiscount = (e) => {
    e?.preventDefault?.();
    if (!isNonNegativeDecimal(discountForm.discount_amount) || discountForm.discount_amount.trim() === "") {
      return setDiscountError("Enter a discount amount of 0 or more.");
    }
    if (discountForm.approver_id && quoteDetail?.created_by && Number(discountForm.approver_id) === quoteDetail.created_by) {
      return setDiscountError("The approver must be a different user from the quote's creator.");
    }
    setDiscountBusy(true);
    setDiscountError(null);
    setCommercialQuoteDiscount(quoteDetail.id, {
      discount_amount: discountForm.discount_amount.trim(),
      reason: discountForm.reason || undefined,
      approver_id: discountForm.approver_id ? Number(discountForm.approver_id) : undefined,
    })
      .then(() => refreshQuoteDetail(quoteDetail.id))
      .then(() => afterMutation("Discount saved."))
      .catch((err) => setDiscountError(errorMessage(err, "Failed to set discount.")))
      .finally(() => setDiscountBusy(false));
  };

  const sendQuoteAction = async () => {
    const ok = await confirm({
      title: "Send quote",
      message: `Email quote ${quoteDetail.quote_number} to the organization's admin with a link to accept or decline it (no login needed).`,
      confirmLabel: "Send quote",
      tone: "primary",
    });
    if (!ok) return;
    setQuoteDetailBusy(true);
    setQuoteDetailError(null);
    sendCommercialQuote(quoteDetail.id)
      .then(() => refreshQuoteDetail(quoteDetail.id))
      .then(() => afterMutation("Quote sent."))
      .catch((e) =>
        setQuoteDetailError(
          errorMessage(e, "Failed to send quote. The organization may have no admin user, or the email failed to send.")
        )
      )
      .finally(() => setQuoteDetailBusy(false));
  };

  const isOwnQuote = Boolean(quoteDetail?.created_by && user?.id && quoteDetail.created_by === user.id);

  const approveQuoteAction = async () => {
    const ok = await confirm({
      title: "Approve quote",
      message:
        "Record that the organization accepted this quote. This immediately creates the invoice, finalizes it (allocating its number) and emails it to the organization's admin.",
      confirmLabel: "Approve and invoice",
      tone: "primary",
    });
    if (!ok) return;
    setQuoteDetailBusy(true);
    setQuoteDetailError(null);
    approveCommercialQuote(quoteDetail.id)
      .then(() => refreshQuoteDetail(quoteDetail.id))
      .then(() => afterMutation("Quote approved and invoiced."))
      .catch((e) => setQuoteDetailError(errorMessage(e, "Failed to approve quote.")))
      .finally(() => setQuoteDetailBusy(false));
  };

  const [rejectQuoteOpen, setRejectQuoteOpen] = useState(false);
  const [rejectQuoteReason, setRejectQuoteReason] = useState("");
  const [rejectQuoteError, setRejectQuoteError] = useState(null);

  const submitRejectQuote = () => {
    setRejectQuoteBusy(true);
    setRejectQuoteError(null);
    rejectCommercialQuote(quoteDetail.id, rejectQuoteReason)
      .then(() => {
        setRejectQuoteOpen(false);
        setRejectQuoteReason("");
        return refreshQuoteDetail(quoteDetail.id);
      })
      .then(() => afterMutation("Quote marked as rejected."))
      .catch((e) => setRejectQuoteError(errorMessage(e, "Failed to reject quote.")))
      .finally(() => setRejectQuoteBusy(false));
  };

  const [convertOpen, setConvertOpen] = useState(false);
  const [convertDueDate, setConvertDueDate] = useState("");
  const [convertError, setConvertError] = useState(null);

  const submitConvert = () => {
    setConvertBusy(true);
    setConvertError(null);
    convertCommercialQuote(quoteDetail.id, convertDueDate || undefined)
      .then(() => {
        setConvertOpen(false);
        setConvertDueDate("");
        setQuoteDetailOpen(false);
        setActiveTab("invoices");
        afterMutation("Draft invoice created from the quote.");
      })
      .catch((e) => setConvertError(errorMessage(e, "Failed to convert quote.")))
      .finally(() => setConvertBusy(false));
  };

  // ── Create Invoice ────────────────────────────────────────────────────
  const [createInvoiceOpen, setCreateInvoiceOpen] = useState(false);
  const [createInvoiceError, setCreateInvoiceError] = useState(null);
  const [createInvoiceForm, setCreateInvoiceForm] = useState(EMPTY_INVOICE_FORM);

  const submitCreateInvoice = () => {
    const f = createInvoiceForm;
    if (!f.account_id) return setCreateInvoiceError("Select a commercial account.");
    if (!CURRENCY_RE.test(f.currency)) return setCreateInvoiceError("Currency must be a 3-letter code such as USD.");
    if (f.issue_date && f.due_date && f.due_date < f.issue_date) return setCreateInvoiceError("The due date can't be before the issue date.");
    setCreateInvoiceBusy(true);
    setCreateInvoiceError(null);
    createPlatformInvoice({
      account_id: Number(f.account_id),
      issue_date: f.issue_date || undefined,
      due_date: f.due_date || undefined,
      notes: f.notes || undefined,
      currency: f.currency,
    })
      .then((inv) => {
        setCreateInvoiceOpen(false);
        setCreateInvoiceForm(EMPTY_INVOICE_FORM);
        afterMutation("Draft invoice created. Add line items, then finalize it.");
        if (inv?.id) openInvoiceDetail(inv);
      })
      .catch((e) => setCreateInvoiceError(errorMessage(e, "Failed to create invoice.")))
      .finally(() => setCreateInvoiceBusy(false));
  };

  // ── Invoice detail ───────────────────────────────────────────────────────
  const [invoiceDetail, setInvoiceDetail] = useState(null);
  const [invoiceDetailOpen, setInvoiceDetailOpen] = useState(false);
  const [invoiceDetailLoading, setInvoiceDetailLoading] = useState(false);
  const [invoiceDetailError, setInvoiceDetailError] = useState(null);
  const invoiceSeqRef = useRef(0);

  function openInvoiceDetail(row) {
    const id = ++invoiceSeqRef.current;
    setInvoiceDetail(null);
    setInvoiceDetailOpen(true);
    setInvoiceDetailError(null);
    setInvoiceDetailLoading(true);
    getPlatformInvoice(row.id)
      .then((inv) => {
        if (id === invoiceSeqRef.current) setInvoiceDetail(inv);
      })
      .catch((e) => {
        if (id === invoiceSeqRef.current) setInvoiceDetailError(errorMessage(e, "Failed to load invoice."));
      })
      .finally(() => {
        if (id === invoiceSeqRef.current) setInvoiceDetailLoading(false);
      });
  }

  const refreshInvoiceDetail = (invoiceId) =>
    getPlatformInvoice(invoiceId).then((inv) => {
      setInvoiceDetail((cur) => (cur && cur.id === inv.id ? inv : cur));
    });

  const addItemToInvoice = (item) => {
    setInvoiceDetailBusy(true);
    setInvoiceDetailError(null);
    const lineNumber = (invoiceDetail?.items?.length || 0) + 1;
    return addPlatformInvoiceItem(invoiceDetail.id, { line_number: lineNumber, ...item })
      .then(() => refreshInvoiceDetail(invoiceDetail.id))
      .then(() => {
        afterMutation();
        return true;
      })
      .catch((e) => {
        setInvoiceDetailError(errorMessage(e, "Failed to add item."));
        return false;
      })
      .finally(() => setInvoiceDetailBusy(false));
  };

  const finalizeInvoiceAction = async () => {
    const ok = await confirm({
      title: "Finalize invoice",
      message:
        "Finalizing allocates the invoice number and locks the invoice — it can't be edited afterwards, only voided or credited.",
      confirmLabel: "Finalize",
      tone: "danger",
    });
    if (!ok) return;
    setInvoiceDetailBusy(true);
    setInvoiceDetailError(null);
    finalizePlatformInvoice(invoiceDetail.id)
      .then(() => refreshInvoiceDetail(invoiceDetail.id))
      .then(() => afterMutation("Invoice finalized."))
      .catch((e) => setInvoiceDetailError(errorMessage(e, "Failed to finalize invoice.")))
      .finally(() => setInvoiceDetailBusy(false));
  };

  const onlinePaymentNote =
    onlinePayment.state === "configured"
      ? "The organization can pay online by card from the invoice link."
      : onlinePayment.state === "not_configured"
        ? "Online card payment is NOT configured on this deployment, so the invoice link will say \"Online payment is not available yet\" — the organization has to pay by wire/ACH and you record that payment here."
        : onlinePayment.state === "webhook_missing"
          ? "Online card payment is only partly configured (the Stripe webhook secret is missing), so a card payment would not be recorded automatically — check the Payments tab and record it manually if needed."
          : "Whether online card payment is configured couldn't be checked from your role; if it isn't, the organization has to pay by wire/ACH.";

  const sendInvoiceAction = async () => {
    const resend = invoiceDetail.delivery_status === "sent" || invoiceDetail.delivery_status === "delivered";
    const ok = await confirm({
      title: resend ? "Resend invoice" : "Send invoice",
      message: `Email this invoice to the organization's admin with a link to view it. ${onlinePaymentNote}`,
      confirmLabel: resend ? "Resend invoice" : "Send invoice",
      tone: "primary",
    });
    if (!ok) return;
    setInvoiceDetailBusy(true);
    setInvoiceDetailError(null);
    sendPlatformInvoice(invoiceDetail.id)
      .then(() => refreshInvoiceDetail(invoiceDetail.id))
      .then(() => afterMutation("Invoice emailed."))
      .catch((e) => {
        setInvoiceDetailError(
          errorMessage(e, "Failed to send invoice. The organization may have no admin user, or the email failed to send.")
        );
        // A failed send still records a delivery attempt — show it.
        refreshInvoiceDetail(invoiceDetail.id).catch(() => {});
      })
      .finally(() => setInvoiceDetailBusy(false));
  };

  const [voidInvoiceOpen, setVoidInvoiceOpen] = useState(false);
  const [voidInvoiceReason, setVoidInvoiceReason] = useState("");
  const [voidInvoiceError, setVoidInvoiceError] = useState(null);

  const submitVoidInvoice = () => {
    if (!voidInvoiceReason.trim()) return setVoidInvoiceError("A reason is required to void an invoice.");
    setVoidInvoiceBusy(true);
    setVoidInvoiceError(null);
    voidPlatformInvoice(invoiceDetail.id, voidInvoiceReason.trim())
      .then(() => {
        setVoidInvoiceOpen(false);
        setVoidInvoiceReason("");
        return refreshInvoiceDetail(invoiceDetail.id);
      })
      .then(() => afterMutation("Invoice voided."))
      .catch((e) => setVoidInvoiceError(errorMessage(e, "Failed to void invoice.")))
      .finally(() => setVoidInvoiceBusy(false));
  };

  // ── Record Payment ────────────────────────────────────────────────────
  const [recordPaymentOpen, setRecordPaymentOpen] = useState(false);
  const [recordPaymentError, setRecordPaymentError] = useState(null);
  const [recordPaymentForm, setRecordPaymentForm] = useState(EMPTY_PAYMENT_FORM);

  const submitRecordPayment = () => {
    const f = recordPaymentForm;
    if (!f.account_id) return setRecordPaymentError("Select a commercial account.");
    if (!isPositiveDecimal(f.amount)) return setRecordPaymentError("Enter an amount greater than 0 (e.g. 1200.00).");
    if (!CURRENCY_RE.test(f.currency)) return setRecordPaymentError("Currency must be a 3-letter code such as USD.");
    setRecordPaymentBusy(true);
    setRecordPaymentError(null);
    recordPlatformPayment({
      account_id: Number(f.account_id),
      amount: f.amount.trim(),
      currency: f.currency,
      payment_method: f.payment_method || undefined,
      transaction_id: f.transaction_id || undefined,
      notes: f.notes || undefined,
    })
      .then(() => {
        setRecordPaymentOpen(false);
        setRecordPaymentForm(EMPTY_PAYMENT_FORM);
        afterMutation("Payment recorded. Allocate it to an invoice to settle the balance.");
      })
      .catch((e) => setRecordPaymentError(errorMessage(e, "Failed to record payment.")))
      .finally(() => setRecordPaymentBusy(false));
  };

  // ── Allocate / Deallocate ─────────────────────────────────────────────
  const [allocateOpen, setAllocateOpen] = useState(false);
  const [allocateTarget, setAllocateTarget] = useState(null);
  const [allocateInvoices, setAllocateInvoices] = useState([]);
  const [allocateInvoicesError, setAllocateInvoicesError] = useState(null);
  const [allocateForm, setAllocateForm] = useState({ invoice_id: "", amount: "" });
  const [allocateError, setAllocateError] = useState(null);

  const openAllocate = (payment) => {
    setAllocateTarget(payment);
    setAllocateForm({ invoice_id: "", amount: String(payment.amount ?? "") });
    setAllocateError(null);
    setAllocateInvoices([]);
    setAllocateInvoicesError(null);
    setAllocateOpen(true);
    listPlatformInvoices({ account_id: payment.commercial_account_id, limit: LIST_LIMIT })
      .then((data) => {
        // Same account (the API filter), same currency (allocate() does not
        // check it — a EUR payment must never settle a USD invoice), issued
        // and with a balance left.
        const payCurrency = String(payment.currency || "").toUpperCase();
        setAllocateInvoices(
          rowsFrom(data, "invoices").filter(
            (inv) =>
              !ALLOCATABLE_INVOICE_EXCLUDED.includes(String(inv.status).toLowerCase()) &&
              String(inv.currency || "").toUpperCase() === payCurrency &&
              Number(inv.balance_due) > 0
          )
        );
      })
      .catch((e) => setAllocateInvoicesError(errorMessage(e, "Couldn't load this account's invoices.")));
  };

  const selectAllocateInvoice = (invoiceId) => {
    const inv = allocateInvoices.find((i) => String(i.id) === invoiceId);
    setAllocateForm((f) => {
      let amount = f.amount;
      if (inv && allocateTarget && Number(inv.balance_due) < Number(allocateTarget.amount)) amount = String(inv.balance_due);
      else if (allocateTarget) amount = String(allocateTarget.amount);
      return { invoice_id: invoiceId, amount };
    });
  };

  const submitAllocate = () => {
    if (!allocateForm.invoice_id) return setAllocateError("Select an invoice.");
    if (!isPositiveDecimal(allocateForm.amount)) return setAllocateError("Enter an amount greater than 0.");
    const inv = allocateInvoices.find((i) => String(i.id) === allocateForm.invoice_id);
    if (inv && Number(allocateForm.amount) > Number(inv.balance_due)) {
      return setAllocateError(`The amount is more than the invoice's balance (${formatCurrency(inv.balance_due, inv.currency)}).`);
    }
    if (allocateTarget && Number(allocateForm.amount) > Number(allocateTarget.amount)) {
      return setAllocateError("The amount is more than the payment.");
    }
    setAllocateBusy(true);
    setAllocateError(null);
    allocatePlatformPayment(allocateTarget.id, Number(allocateForm.invoice_id), allocateForm.amount.trim())
      .then(() => {
        setAllocateOpen(false);
        afterMutation("Payment allocated.");
      })
      .catch((e) => setAllocateError(errorMessage(e, "Failed to allocate payment.")))
      .finally(() => setAllocateBusy(false));
  };

  const [deallocateOpen, setDeallocateOpen] = useState(false);
  const [deallocateTarget, setDeallocateTarget] = useState(null);
  const [deallocateInvoices, setDeallocateInvoices] = useState([]);
  const [deallocateInvoiceId, setDeallocateInvoiceId] = useState("");
  const [deallocateError, setDeallocateError] = useState(null);

  const openDeallocate = (payment) => {
    setDeallocateTarget(payment);
    setDeallocateInvoiceId("");
    setDeallocateError(null);
    setDeallocateInvoices([]);
    setDeallocateOpen(true);
    listPlatformInvoices({ account_id: payment.commercial_account_id, limit: LIST_LIMIT })
      .then((data) =>
        setDeallocateInvoices(
          rowsFrom(data, "invoices").filter(
            (inv) => String(inv.status).toLowerCase() !== "draft" && Number(inv.paid_amount ?? 1) > 0
          )
        )
      )
      .catch((e) => setDeallocateError(errorMessage(e, "Couldn't load this account's invoices.")));
  };

  const submitDeallocate = () => {
    if (!deallocateInvoiceId) return setDeallocateError("Select an invoice.");
    setDeallocateBusy(true);
    setDeallocateError(null);
    deallocatePlatformPayment(deallocateTarget.id, Number(deallocateInvoiceId))
      .then(() => {
        setDeallocateOpen(false);
        afterMutation("Allocation removed; the invoice balance has been restored.");
      })
      .catch((e) =>
        setDeallocateError(errorMessage(e, "Failed to remove the allocation — this payment may not be allocated to that invoice."))
      )
      .finally(() => setDeallocateBusy(false));
  };

  // ── derived lists ────────────────────────────────────────────────────────
  const { quotes, invoices, payments, reconciliation: reconciliationRuns, evaluation: evaluationPrograms } = tabData;

  const filtered = useMemo(() => {
    const match = (hay, q) => !q || hay.some((h) => String(h ?? "").toLowerCase().includes(q));
    const fq = filters.quotes;
    const fi = filters.invoices;
    const fp = filters.payments;
    const lc = (s) => String(s ?? "").toLowerCase();
    return {
      quotes: quotes.filter(
        (r) =>
          (!fq.status || lc(r.status) === fq.status) &&
          match([orgName(r), r.organization?.code, r.quote_number, r.subject], fq.q.trim().toLowerCase())
      ),
      invoices: invoices.filter(
        (r) =>
          (!fi.status || lc(r.status) === fi.status) &&
          match([orgName(r), r.organization?.code, r.invoice_number], fi.q.trim().toLowerCase())
      ),
      payments: payments.filter(
        (r) =>
          (!fp.status || lc(r.status) === fp.status) &&
          match(
            [r.payment_number, r.transaction_id, accounts.find((a) => a.id === r.commercial_account_id)?.organization_name],
            fp.q.trim().toLowerCase()
          )
      ),
    };
  }, [quotes, invoices, payments, filters, accounts]);

  // ── columns ──────────────────────────────────────────────────────────────
  const orgCell = (r) => (
    <div className="min-w-0">
      <span className="block truncate font-semibold text-slate-800" title={orgName(r)}>
        {orgName(r)}
      </span>
      <span className="block truncate text-xs text-slate-500">{r.organization?.code || "—"}</span>
    </div>
  );

  const quoteColumns = [
    { key: "organization", label: "Organization", render: orgCell },
    { key: "quote_number", label: "Quote #", render: (r) => <span className="font-medium text-slate-700">{r.quote_number || "—"}</span> },
    { key: "subject", label: "Subject", render: (r) => r.subject || "—" },
    { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} options={QUOTE_STATUS_OPTIONS} /> },
    {
      key: "total_amount",
      label: "Total",
      align: "right",
      render: (r) => <span className="font-semibold tabular-nums text-slate-800">{formatCurrency(r.total_amount, r.currency)}</span>,
    },
    { key: "valid_until", label: "Valid until", render: (r) => formatCalendarDate(r.valid_until) },
    { key: "created_at", label: "Created", render: (r) => formatServerDateTime(r.created_at) },
    {
      key: "actions",
      label: "",
      align: "right",
      render: (r) => (
        <Button size="sm" variant="secondary" icon={Eye} onClick={() => openQuoteDetail(r)} aria-label={`View quote ${r.quote_number || r.id}`}>
          View
        </Button>
      ),
    },
  ];

  const invoiceColumns = [
    { key: "organization", label: "Organization", render: orgCell },
    { key: "invoice_number", label: "Invoice #", render: (r) => <span className="font-medium text-slate-700">{r.invoice_number || "Draft"}</span> },
    { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} options={INVOICE_STATUS_OPTIONS} /> },
    {
      key: "total_amount",
      label: "Total",
      align: "right",
      render: (r) => <span className="font-semibold tabular-nums text-slate-800">{formatCurrency(r.total_amount, r.currency)}</span>,
    },
    {
      key: "balance_due",
      label: "Balance due",
      align: "right",
      render: (r) => (
        <span className={`font-semibold tabular-nums ${Number(r.balance_due) > 0 && r.status !== "voided" ? "text-red-600" : "text-emerald-600"}`}>
          {formatCurrency(r.balance_due, r.currency)}
        </span>
      ),
    },
    {
      key: "payment_status",
      label: "Payment",
      render: (r) => {
        const paid = r.is_paid || r.payment_status === "full";
        const label = r.status === "voided" ? "Voided" : paid ? "Paid" : r.payment_status === "partial" ? "Partially paid" : "Unpaid";
        return (
          <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${paid ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800"}`}>
            {label}
          </span>
        );
      },
    },
    { key: "due_date", label: "Due date", render: (r) => formatCalendarDate(r.due_date) },
    {
      key: "actions",
      label: "",
      align: "right",
      render: (r) => (
        <Button size="sm" variant="secondary" icon={Eye} onClick={() => openInvoiceDetail(r)} aria-label={`View invoice ${r.invoice_number || r.id}`}>
          View
        </Button>
      ),
    },
  ];

  const paymentColumns = [
    { key: "payment_number", label: "Payment #", render: (r) => <span className="font-medium text-slate-700">{r.payment_number}</span> },
    { key: "account", label: "Organization", render: (r) => accountName(r.commercial_account_id) },
    { key: "status", label: "Status", render: (r) => <StatusBadge value={r.status} options={PAYMENT_STATUS_OPTIONS} /> },
    {
      key: "amount",
      label: "Amount",
      align: "right",
      render: (r) => <span className="font-semibold tabular-nums text-slate-800">{formatCurrency(r.amount, r.currency)}</span>,
    },
    { key: "payment_method", label: "Method", render: (r) => labelFor(PAYMENT_METHOD_LABELS, r.payment_method) },
    { key: "transaction_id", label: "Reference", render: (r) => r.transaction_id || "—" },
    { key: "created_at", label: "Recorded", render: (r) => formatServerDateTime(r.created_at) },
    {
      key: "actions",
      label: "",
      align: "right",
      render: (r) => {
        // allocate() requires a CLEARED payment.
        const cleared = String(r.status).toLowerCase() === "cleared";
        return (
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => openAllocate(r)}
              disabled={!canPaymentWrite || !cleared}
              title={cleared ? undefined : "Only cleared payments can be allocated"}
            >
              Allocate
            </Button>
            <Button size="sm" variant="secondary" onClick={() => openDeallocate(r)} disabled={!canPaymentWrite}>
              Remove allocation
            </Button>
          </div>
        );
      },
    },
  ];

  const reconciliationColumns = [
    { key: "id", label: "Run #", render: (r) => <span className="font-medium text-slate-700">#{r.id}</span> },
    { key: "state", label: "Result", render: (r) => <StatusBadge value={r.state} options={RECONCILIATION_STATE_OPTIONS} /> },
    { key: "trigger", label: "Trigger", render: (r) => (r.trigger === "scheduled" ? "Scheduled" : "Manual") },
    { key: "checks_total", label: "Checks", align: "right", render: (r) => r.checks_total ?? "—" },
    {
      key: "exceptions_found",
      label: "Exceptions",
      align: "right",
      render: (r) => (
        <span className={`font-semibold tabular-nums ${Number(r.exceptions_found) > 0 ? "text-red-600" : "text-emerald-600"}`}>
          {r.exceptions_found ?? "—"}
        </span>
      ),
    },
    { key: "started_at", label: "Started", render: (r) => formatServerDateTime(r.started_at) },
    { key: "finished_at", label: "Finished", render: (r) => formatServerDateTime(r.finished_at) },
  ];

  const evaluationProgramColumns = [
    {
      key: "plan_code",
      label: "Plan",
      render: (r) => (
        <div>
          <span className="font-medium text-slate-700">{r.plan_code || `Plan #${r.plan_id}`}</span>
          {r.granted_plan_code && <span className="block text-xs text-slate-500">Grants {r.granted_plan_code} features</span>}
        </div>
      ),
    },
    {
      key: "is_active",
      label: "Status",
      render: (r) => (
        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${r.is_active ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
          {r.is_active ? "Active" : "Inactive"}
        </span>
      ),
    },
    { key: "duration_days", label: "Trial length", align: "right", render: (r) => `${r.duration_days} days` },
    { key: "payment_requirement", label: "Card", render: (r) => labelFor(EVALUATION_PAYMENT_REQUIREMENT_OPTIONS, r.payment_requirement) },
    { key: "conversion_policy", label: "Conversion", render: (r) => labelFor(EVALUATION_CONVERSION_POLICY_OPTIONS, r.conversion_policy) },
    { key: "expiry_action", label: "On expiry", render: (r) => labelFor(EVALUATION_EXPIRY_ACTION_OPTIONS, r.expiry_action) },
    {
      key: "approved_by",
      label: "Approval",
      render: (r) => (r.approved_by ? `Approved by user #${r.approved_by}` : <span className="font-medium text-amber-700">Not approved</span>),
    },
    {
      key: "actions",
      label: "",
      align: "right",
      render: (r) => (
        <div className="flex justify-end gap-2">
          {!r.approved_by && (
            <Button size="sm" variant="secondary" onClick={() => approveProgram(r)} disabled={!canEvaluationProgramWrite || programBusyId !== null}>
              Approve
            </Button>
          )}
          <Button
            size="sm"
            variant={r.is_active ? "danger" : "primary"}
            onClick={() => toggleProgramStatus(r)}
            loading={programBusyId === r.id}
            // The backend refuses to activate an unapproved program (§B3).
            disabled={!canEvaluationProgramWrite || programBusyId !== null || (!r.is_active && !r.approved_by)}
            title={!r.is_active && !r.approved_by ? "Approve the program before activating it" : undefined}
          >
            {r.is_active ? "Deactivate" : "Activate"}
          </Button>
        </div>
      ),
    },
  ];

  // ── report tiles ─────────────────────────────────────────────────────────
  const mrr = report?.mrr;
  const mrrCurrencies = Array.isArray(mrr?.currencies) ? mrr.currencies : [];
  function mrrValue() {
    if (!mrr || mrr.state === "unknown") return "Unknown";
    if (mrr.state === "multi_currency") return `${mrrCurrencies.length} currencies`;
    return formatCurrency(mrr.amount, mrrCurrencies[0]?.currency);
  }
  function mrrSubtitle() {
    if (!mrr) return undefined;
    const cov = mrr.coverage || {};
    if (mrr.state === "unknown") return "No open subscription is on a published, priced plan version yet";
    if (mrr.state === "multi_currency") return "Shown per currency below — never added together";
    return `${cov.open_subscriptions_priced ?? 0} of ${cov.open_subscriptions_total ?? 0} open subscriptions priced`;
  }
  const pricedPlanCount = mrr?.coverage?.plans_with_published_price ?? 0;

  const tabs = [
    { key: "quotes", label: "Quotes", icon: Send },
    { key: "invoices", label: "Invoices", icon: Receipt },
    { key: "payments", label: "Payments", icon: CreditCard },
    { key: "reconciliation", label: "Reconciliation", icon: ClipboardCheck },
    { key: "evaluation", label: "Trial programs", icon: Clock },
  ];

  const lastUpdatedTime = live.lastUpdated
    ? live.lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;

  const renderFilters = (tab, statusOptions, placeholder) => {
    const f = filters[tab];
    const total = tabData[tab].length;
    const shown = filtered[tab].length;
    return (
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <SearchInput
          className="w-full sm:w-72"
          value={f.q}
          onChange={(q) => setFilter(tab, { q })}
          placeholder={placeholder}
        />
        <Select
          className="w-full sm:w-48"
          value={f.status}
          onChange={(status) => setFilter(tab, { status })}
          options={statusOptions}
          placeholder="All statuses"
          aria-label="Filter by status"
        />
        {(f.q || f.status) && (
          <Button size="sm" variant="secondary" onClick={() => setFilter(tab, EMPTY_FILTERS)}>
            Clear filters
          </Button>
        )}
        <span className="text-xs text-slate-500">
          {shown === total ? `${total} shown` : `${shown} of ${total} shown`}
        </span>
      </div>
    );
  };

  const truncationNote = (tab, noun) =>
    tabData[tab].length >= LIST_LIMIT ? (
      <p className="mt-2 text-xs text-amber-700">
        Showing the {LIST_LIMIT} most recent {noun} — older ones aren't listed here.
      </p>
    ) : null;

  const listTable = (tab, columns, noun, emptyTitle, emptyMessage, minWidth = 860) => {
    const f = filters[tab];
    const filteredOut = tabData[tab].length > 0 && filtered[tab].length === 0;
    return (
      <>
        <DataTable
          columns={columns}
          data={filtered[tab]}
          loading={false}
          emptyTitle={filteredOut ? `No ${noun} match these filters` : emptyTitle}
          emptyMessage={filteredOut ? "Try a different search or status." : emptyMessage}
          emptyAction={
            filteredOut && (f.q || f.status) ? (
              <Button size="sm" variant="secondary" onClick={() => setFilter(tab, EMPTY_FILTERS)}>
                Clear filters
              </Button>
            ) : undefined
          }
          minWidth={minWidth}
        />
        {truncationNote(tab, noun)}
      </>
    );
  };

  const tabBody = () => {
    const tab = activeTab;
    const filterBar =
      tab === "quotes"
        ? renderFilters("quotes", QUOTE_STATUS_OPTIONS, "Search organization, quote # or subject")
        : tab === "invoices"
          ? renderFilters("invoices", INVOICE_STATUS_OPTIONS, "Search organization or invoice #")
          : tab === "payments"
            ? renderFilters("payments", PAYMENT_STATUS_OPTIONS, "Search payment #, reference or organization")
            : null;
    if (tabErrors[tab]) {
      return (
        <>
          {filterBar}
          <ErrorState title="Couldn't load this list" message={tabErrors[tab]} onRetry={() => retryTab(tab)} />
        </>
      );
    }
    if (!tabLoaded[tab]) return <Spinner />;
    if (tab === "quotes") {
      return (
        <>
          {filterBar}
          {listTable("quotes", quoteColumns, "quotes", "No quotes yet", "Create a quote to propose a plan and price to an organization.")}
        </>
      );
    }
    if (tab === "invoices") {
      return (
        <>
          {onlinePayment.state !== "configured" && (
            <InlineAlert tone="warning">{onlinePaymentNote}</InlineAlert>
          )}
          {filterBar}
          {listTable("invoices", invoiceColumns, "invoices", "No invoices yet", "Invoices appear here when a quote is approved or when you create one manually.")}
        </>
      );
    }
    if (tab === "payments") {
      return (
        <>
          <p className="mb-3 text-xs text-slate-500">
            Record wire/ACH payments here, then allocate them to the organization's open invoices in the same currency.
            {onlinePayment.state === "configured"
              ? " Card payments made from the invoice link are recorded automatically."
              : " Online card payment isn't confirmed as configured, so expect payments to arrive by wire/ACH."}
          </p>
          {filterBar}
          {listTable("payments", paymentColumns, "payments", "No payments recorded yet", "Record a payment when money arrives from an organization.", 960)}
        </>
      );
    }
    if (tab === "reconciliation") {
      return (
        <>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-slate-500">
              Checks invoice balance arithmetic and payment allocation integrity across Zoiko's own invoices and payments.
            </p>
            <Button variant="primary" icon={ClipboardCheck} onClick={runReconciliation} loading={runningReconciliation}>
              {runningReconciliation ? "Running…" : "Run reconciliation"}
            </Button>
          </div>
          <DataTable
            columns={reconciliationColumns}
            data={reconciliationRuns}
            loading={false}
            emptyTitle="No reconciliation runs yet"
            emptyMessage="Run reconciliation to check the platform ledger."
            minWidth={760}
          />
        </>
      );
    }
    return (
      <>
        <p className="mb-4 text-xs text-slate-500">
          No plan offers a free trial unless a program below exists, is approved, and is active. New programs start inactive.
        </p>
        <DataTable
          columns={evaluationProgramColumns}
          data={evaluationPrograms}
          loading={false}
          emptyTitle="No trial programs"
          emptyMessage="No plan currently offers a trial. Create a program to set one up."
          minWidth={980}
        />
      </>
    );
  };

  const tabAction = {
    quotes: { label: "Create quote", allowed: canQuoteWrite, cap: "commercial_quote.write", onClick: () => openCreate(setCreateQuoteOpen, setCreateQuoteError) },
    invoices: { label: "Create invoice", allowed: canFinancial, cap: "commercial_financial.write", onClick: () => openCreate(setCreateInvoiceOpen, setCreateInvoiceError) },
    payments: { label: "Record payment", allowed: canPaymentWrite, cap: "commercial_payment.write", onClick: () => openCreate(setRecordPaymentOpen, setRecordPaymentError) },
    evaluation: {
      label: "Create program",
      allowed: canEvaluationProgramWrite,
      cap: "commercial_evaluation_program.write",
      onClick: () => {
        setCreateProgramError(null);
        setCreateProgramOpen(true);
      },
    },
  }[activeTab];

  const accountsHint = accountsError
    ? `${accountsError} Close and reopen this form to retry.`
    : accounts.length === 0
      ? "No commercial accounts found."
      : undefined;

  const invoiceStatus = String(invoiceDetail?.status || "").toLowerCase();
  const canVoid = VOIDABLE_INVOICE_STATUSES.includes(invoiceStatus);
  const canSend = SENDABLE_INVOICE_STATUSES.includes(invoiceStatus);
  const invoiceHasItems = (invoiceDetail?.items?.length || 0) > 0;

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Platform Billing"
        description="Zoiko's own billing of organizations: quotes, invoices, payments and trial programs. Every figure comes from real records — nothing here is estimated."
        icon={Landmark}
        meta={
          <span>
            <UpdatedAgo date={live.lastUpdated} /> · refreshes automatically while this tab is open
          </span>
        }
        actions={
          <Button variant="secondary" size="sm" icon={RefreshCw} onClick={() => refreshNow()} loading={live.refreshing}>
            Refresh
          </Button>
        }
      />

      {live.refreshError && live.lastUpdated && (
        <p role="status" className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-amber-700">
          <AlertTriangle size={13} /> Couldn't refresh — showing data from {lastUpdatedTime}.
          <button type="button" onClick={() => refreshNow()} className="font-semibold underline">
            Retry
          </button>
        </p>
      )}

      <div className="mt-6 space-y-8">
        <SuccessMessage message={success} onDismiss={() => setSuccess(null)} />

        {/* ── SaaS reporting ─────────────────────────────────────────── */}
        <section aria-labelledby="saas-reporting-heading">
          <h2 id="saas-reporting-heading" className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-800">
            Subscription overview
          </h2>
          {!report && reportError ? (
            <ErrorState title="Unable to load subscription reporting" message={reportError} onRetry={() => refreshNow()} />
          ) : !report ? (
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <DashboardStatCardSkeleton key={i} />
              ))}
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
                <DashboardStatCard
                  title="Commercial accounts"
                  value={report.accounts?.total ?? 0}
                  subtitle="Organizations billed by Zoiko"
                  icon={Building2}
                  color="from-brand to-brand-hover"
                />
                <DashboardStatCard
                  title="Open subscriptions"
                  value={report.subscriptions?.total_open ?? 0}
                  subtitle={`${report.subscriptions?.total_ever ?? 0} created in total`}
                  icon={UserCheck}
                  color="from-emerald-500 to-emerald-600"
                />
                {/* MRR stays visible when UNKNOWN — hiding the tile used to
                    make "no priced subscriptions" indistinguishable from a
                    tile that failed to render. */}
                <DashboardStatCard
                  title="Monthly recurring revenue"
                  value={mrrValue()}
                  subtitle={mrrSubtitle()}
                  icon={TrendingUp}
                  color="from-blue-500 to-blue-600"
                />
                <DashboardStatCard
                  title="Plans with a published price"
                  value={pricedPlanCount}
                  subtitle="Only these can contribute to MRR"
                  icon={Receipt}
                  color="from-slate-500 to-slate-600"
                />
              </div>
              <div className="mt-5 grid grid-cols-1 gap-5 md:grid-cols-3">
                {mrr?.state === "multi_currency" && (
                  <SectionCard variant="quiet" title="MRR by currency" description="Each currency is totalled separately.">
                    <ul className="space-y-1.5" data-testid="mrr-by-currency">
                      {mrrCurrencies.map((c) => (
                        <li key={c.currency} className="flex items-center justify-between gap-3 text-sm">
                          <span className="text-slate-600">
                            {c.currency} · {c.subscriptions} subscription{c.subscriptions === 1 ? "" : "s"}
                          </span>
                          <span className="font-semibold tabular-nums text-slate-800">{formatCurrency(c.monthly_amount, c.currency)}</span>
                        </li>
                      ))}
                    </ul>
                  </SectionCard>
                )}
                <StatusCountList title="Accounts by status" counts={report.accounts?.by_status} options={ACCOUNT_STATUS_OPTIONS} />
                <StatusCountList title="Subscriptions by status" counts={report.subscriptions?.by_status} options={SUBSCRIPTION_STATUS_OPTIONS} />
              </div>
              <p className="mt-2 text-xs text-slate-500">Report generated {formatServerDateTime(report.generated_at)}.</p>
            </>
          )}
        </section>

        {/* ── Transactional billing ──────────────────────────────────── */}
        <section aria-labelledby="plane1-money-heading">
          <h2 id="plane1-money-heading" className="mb-3 text-sm font-bold uppercase tracking-wider text-slate-800">
            Quotes, invoices &amp; payments
          </h2>

          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <HubTabs tabs={tabs} active={activeTab} onChange={setActiveTab} label="Platform billing sections" className="" />
            {tabAction && (
              <div className="text-right">
                <Button variant="primary" size="sm" icon={Plus} onClick={tabAction.onClick} disabled={!tabAction.allowed}>
                  {tabAction.label}
                </Button>
                {!tabAction.allowed && <CapabilityNotice capability={tabAction.cap} />}
              </div>
            )}
          </div>

          {actionError && <InlineAlert onDismiss={() => setActionError(null)}>{actionError}</InlineAlert>}

          {tabBody()}
        </section>
      </div>

      {/* ── Create Quote ──────────────────────────────────────────────── */}
      <FormModal
        open={createQuoteOpen}
        onClose={() => setCreateQuoteOpen(false)}
        onSubmit={submitCreateQuote}
        title="Create quote"
        description="Creates a draft quote. Add line items next, then send it to the organization."
        busy={createQuoteBusy}
        error={createQuoteError}
        submitLabel="Create quote"
      >
        <Field label="Commercial account" required hint={accountsHint}>
          <Select
            value={createQuoteForm.account_id}
            onChange={(v) => setCreateQuoteForm((f) => ({ ...f, account_id: v }))}
            options={accountOptions}
            placeholder="Select an account…"
            aria-label="Commercial account"
          />
        </Field>
        <Field label="Subject">
          <input className={FORM_CONTROL_CLASS} value={createQuoteForm.subject} onChange={(e) => setCreateQuoteForm((f) => ({ ...f, subject: e.target.value }))} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Valid until">
            <input type="date" className={FORM_CONTROL_CLASS} value={createQuoteForm.valid_until} onChange={(e) => setCreateQuoteForm((f) => ({ ...f, valid_until: e.target.value }))} />
          </Field>
          <Field label="Currency" required hint="3-letter code, e.g. USD">
            <input
              aria-label="Currency"
              maxLength={3}
              className={FORM_CONTROL_CLASS}
              value={createQuoteForm.currency}
              onChange={(e) => setCreateQuoteForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))}
            />
          </Field>
        </div>
        <Field label="Notes">
          <textarea rows={2} className={FORM_CONTROL_CLASS} value={createQuoteForm.notes} onChange={(e) => setCreateQuoteForm((f) => ({ ...f, notes: e.target.value }))} />
        </Field>
        <Field label="Terms">
          <textarea rows={2} className={FORM_CONTROL_CLASS} value={createQuoteForm.terms} onChange={(e) => setCreateQuoteForm((f) => ({ ...f, terms: e.target.value }))} />
        </Field>
      </FormModal>

      {/* ── Quote detail ──────────────────────────────────────────────── */}
      <Modal
        open={quoteDetailOpen}
        onClose={quoteDetailBusy ? undefined : () => setQuoteDetailOpen(false)}
        closeOnBackdrop={!quoteDetailBusy}
        title={quoteDetail ? `Quote ${quoteDetail.quote_number}` : "Quote"}
        description={quoteDetail ? [quoteDetail.organization?.name, quoteDetail.subject].filter(Boolean).join(" · ") || undefined : undefined}
        size="lg"
        footer={
          quoteDetail?.status === "sent" ? (
            <>
              <Button variant="danger" onClick={() => { setRejectQuoteError(null); setRejectQuoteOpen(true); }} disabled={!canQuoteApprove || quoteDetailBusy}>
                Mark rejected
              </Button>
              <Button variant="primary" onClick={approveQuoteAction} loading={quoteDetailBusy} disabled={!canQuoteApprove || quoteDetailBusy || isOwnQuote}>
                Approve and invoice
              </Button>
            </>
          ) : quoteDetail?.status === "accepted" ? (
            <Button variant="primary" onClick={() => { setConvertError(null); setConvertOpen(true); }} disabled={!canQuoteWrite || quoteDetailBusy}>
              Convert to invoice
            </Button>
          ) : null
        }
      >
        {quoteDetailError && <InlineAlert onDismiss={quoteDetail ? () => setQuoteDetailError(null) : undefined}>{quoteDetailError}</InlineAlert>}
        {quoteDetailLoading ? (
          <Spinner />
        ) : quoteDetail ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <StatusBadge value={quoteDetail.status} options={QUOTE_STATUS_OPTIONS} />
              <div className="text-right">
                <div className="text-sm font-semibold text-slate-800">{formatCurrency(quoteDetail.total_amount, quoteDetail.currency)}</div>
                <div className="text-xs text-slate-500">Valid until {formatCalendarDate(quoteDetail.valid_until)}</div>
              </div>
            </div>

            <ItemsTable items={quoteDetail.items} currency={quoteDetail.currency} />

            {quoteDetail.status === "draft" && (
              <>
                <AddItemForm onAdd={addItemToQuote} busy={quoteDetailBusy} disabled={!canQuoteWrite} />
                {!canQuoteWrite && <CapabilityNotice capability="commercial_quote.write" />}

                <form onSubmit={submitDiscount} className="space-y-3 rounded-xl border border-slate-200 p-3.5">
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
                    A large discount needs a reason and an approver (a different admin from whoever created this quote) before the quote can be sent.
                  </p>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <Field label="Discount amount">
                      <input inputMode="decimal" className={FORM_CONTROL_CLASS} value={discountForm.discount_amount} onChange={(e) => setDiscountForm((f) => ({ ...f, discount_amount: e.target.value }))} />
                    </Field>
                    <Field label="Approver user ID" hint="Needed for large discounts">
                      <input type="number" className={FORM_CONTROL_CLASS} value={discountForm.approver_id} onChange={(e) => setDiscountForm((f) => ({ ...f, approver_id: e.target.value }))} />
                    </Field>
                    <Field label="Reason" hint="Needed for large discounts">
                      <input type="text" className={FORM_CONTROL_CLASS} value={discountForm.reason} onChange={(e) => setDiscountForm((f) => ({ ...f, reason: e.target.value }))} />
                    </Field>
                  </div>
                  {discountError && <p role="alert" className="text-xs font-medium text-red-600">{discountError}</p>}
                  <div className="flex justify-end">
                    <Button type="submit" variant="secondary" loading={discountBusy} disabled={!canQuoteWrite || discountBusy || quoteDetailBusy}>
                      Save discount
                    </Button>
                  </div>
                </form>

                <div className="flex items-center justify-end gap-3">
                  {(quoteDetail.items?.length || 0) === 0 && <span className="text-xs text-slate-500">Add at least one line item before sending.</span>}
                  <Button
                    variant="primary"
                    icon={Send}
                    onClick={sendQuoteAction}
                    loading={quoteDetailBusy}
                    disabled={!canQuoteWrite || quoteDetailBusy || (quoteDetail.items?.length || 0) === 0}
                  >
                    Send quote
                  </Button>
                </div>
              </>
            )}

            {quoteDetail.status === "sent" && !canQuoteApprove && <CapabilityNotice capability="commercial_quote.approve" />}
            {quoteDetail.status === "sent" && canQuoteApprove && isOwnQuote && (
              <p className="text-xs text-amber-700">You created this quote, so another admin has to approve it.</p>
            )}
            {quoteDetail.status === "converted" && (
              <p className="flex items-center gap-1.5 text-xs text-slate-600">
                <CheckCircle size={13} className="text-emerald-600" /> This quote has been invoiced — see the Invoices tab.
              </p>
            )}
          </div>
        ) : null}
      </Modal>

      {/* ── Reject Quote ──────────────────────────────────────────────── */}
      <FormModal
        open={rejectQuoteOpen}
        onClose={() => setRejectQuoteOpen(false)}
        onSubmit={submitRejectQuote}
        title="Mark quote as rejected"
        description="Record that the organization declined this quote."
        busy={rejectQuoteBusy}
        error={rejectQuoteError}
        submitLabel="Mark rejected"
      >
        <Field label="Reason">
          <textarea rows={3} className={FORM_CONTROL_CLASS} value={rejectQuoteReason} onChange={(e) => setRejectQuoteReason(e.target.value)} />
        </Field>
      </FormModal>

      {/* ── Convert to Invoice ────────────────────────────────────────── */}
      <FormModal
        open={convertOpen}
        onClose={() => setConvertOpen(false)}
        onSubmit={submitConvert}
        title="Convert to invoice"
        description="Creates a draft invoice from this quote's line items. Nothing is charged yet."
        busy={convertBusy}
        error={convertError}
        submitLabel="Convert"
      >
        <Field label="Due date" hint="Optional">
          <input type="date" className={FORM_CONTROL_CLASS} value={convertDueDate} onChange={(e) => setConvertDueDate(e.target.value)} />
        </Field>
      </FormModal>

      {/* ── Create Invoice ────────────────────────────────────────────── */}
      <FormModal
        open={createInvoiceOpen}
        onClose={() => setCreateInvoiceOpen(false)}
        onSubmit={submitCreateInvoice}
        title="Create invoice"
        description="Creates a draft invoice that isn't tied to a quote."
        busy={createInvoiceBusy}
        error={createInvoiceError}
        submitLabel="Create invoice"
      >
        <Field label="Commercial account" required hint={accountsHint}>
          <Select
            value={createInvoiceForm.account_id}
            onChange={(v) => setCreateInvoiceForm((f) => ({ ...f, account_id: v }))}
            options={accountOptions}
            placeholder="Select an account…"
            aria-label="Commercial account"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Issue date">
            <input type="date" className={FORM_CONTROL_CLASS} value={createInvoiceForm.issue_date} onChange={(e) => setCreateInvoiceForm((f) => ({ ...f, issue_date: e.target.value }))} />
          </Field>
          <Field label="Due date">
            <input type="date" className={FORM_CONTROL_CLASS} value={createInvoiceForm.due_date} onChange={(e) => setCreateInvoiceForm((f) => ({ ...f, due_date: e.target.value }))} />
          </Field>
        </div>
        <Field label="Currency" required hint="3-letter code, e.g. USD">
          <input aria-label="Currency" maxLength={3} className={FORM_CONTROL_CLASS} value={createInvoiceForm.currency} onChange={(e) => setCreateInvoiceForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))} />
        </Field>
        <Field label="Notes">
          <textarea rows={2} className={FORM_CONTROL_CLASS} value={createInvoiceForm.notes} onChange={(e) => setCreateInvoiceForm((f) => ({ ...f, notes: e.target.value }))} />
        </Field>
      </FormModal>

      {/* ── Invoice detail ────────────────────────────────────────────── */}
      <Modal
        open={invoiceDetailOpen}
        onClose={invoiceDetailBusy ? undefined : () => setInvoiceDetailOpen(false)}
        closeOnBackdrop={!invoiceDetailBusy}
        title={invoiceDetail ? `Invoice ${invoiceDetail.invoice_number || "(draft)"}` : "Invoice"}
        description={invoiceDetail ? `Billed to ${invoiceDetail.recipient_org_name || "—"}` : undefined}
        size="lg"
        footer={
          invoiceDetail && invoiceStatus === "draft" ? (
            <Button variant="primary" onClick={finalizeInvoiceAction} loading={invoiceDetailBusy} disabled={!canFinancial || invoiceDetailBusy || !invoiceHasItems}>
              Finalize
            </Button>
          ) : invoiceDetail && (canVoid || canSend) ? (
            <>
              {canVoid && (
                <Button variant="danger" onClick={() => { setVoidInvoiceError(null); setVoidInvoiceOpen(true); }} disabled={!canFinancial || invoiceDetailBusy}>
                  Void
                </Button>
              )}
              {canSend && (
                <Button variant="primary" icon={Send} onClick={sendInvoiceAction} loading={invoiceDetailBusy} disabled={!canFinancial || invoiceDetailBusy}>
                  {invoiceDetail.delivery_status === "sent" || invoiceDetail.delivery_status === "delivered" ? "Resend invoice" : "Send invoice"}
                </Button>
              )}
            </>
          ) : null
        }
      >
        {invoiceDetailError && <InlineAlert onDismiss={invoiceDetail ? () => setInvoiceDetailError(null) : undefined}>{invoiceDetailError}</InlineAlert>}
        {invoiceDetailLoading ? (
          <Spinner />
        ) : invoiceDetail ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <StatusBadge value={invoiceDetail.status} options={INVOICE_STATUS_OPTIONS} />
              <div className="text-right">
                <div className="text-sm font-semibold text-slate-800">{formatCurrency(invoiceDetail.total_amount, invoiceDetail.currency)}</div>
                <div className="text-xs text-slate-500">
                  Paid {formatCurrency(invoiceDetail.paid_amount, invoiceDetail.currency)} · Balance due {formatCurrency(invoiceDetail.balance_due, invoiceDetail.currency)}
                </div>
              </div>
            </div>
            <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-3">
              <div>
                <dt className="text-slate-500">Issue date</dt>
                <dd className="font-medium text-slate-800">{formatCalendarDate(invoiceDetail.issue_date)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Due date</dt>
                <dd className="font-medium text-slate-800">{formatCalendarDate(invoiceDetail.due_date)}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Email delivery</dt>
                <dd className="font-medium capitalize text-slate-800">{labelFor([], invoiceDetail.delivery_status)}</dd>
              </div>
            </dl>

            <ItemsTable items={invoiceDetail.items} currency={invoiceDetail.currency} />

            {invoiceStatus !== "draft" && invoiceDetail.public_token && (
              <div className="rounded-xl border border-slate-200 p-3.5 text-xs text-slate-600">
                <a
                  href={`/platform-invoice/${invoiceDetail.public_token}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-semibold text-brand-600 hover:underline"
                >
                  Open the organization's invoice page <ExternalLink size={12} />
                </a>
                <p className="mt-1">{onlinePaymentNote}</p>
              </div>
            )}

            {invoiceDetail.delivery_attempts?.length > 0 && (
              <div className="rounded-xl border border-slate-200 p-3.5">
                <p className="mb-2 text-sm font-semibold text-slate-800">Delivery attempts</p>
                <ul className="space-y-1.5">
                  {invoiceDetail.delivery_attempts.map((a, i) => (
                    <li key={i} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="text-slate-600">
                        {a.channel}
                        {a.provider ? ` via ${a.provider}` : ""}
                        {a.attempted_at ? ` — ${formatServerDateTime(a.attempted_at)}` : ""}
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

            {invoiceStatus === "draft" && (
              <>
                <AddItemForm onAdd={addItemToInvoice} busy={invoiceDetailBusy} disabled={!canFinancial} />
                {!canFinancial && <CapabilityNotice capability="commercial_financial.write" />}
                {!invoiceHasItems && <p className="text-xs text-slate-500">Add at least one line item before finalizing.</p>}
              </>
            )}
            {invoiceStatus !== "draft" && !canSend && !canVoid && (
              <p className="text-xs text-slate-500">No further actions are available for an invoice in this status.</p>
            )}
            {invoiceStatus !== "draft" && !canSend && canVoid && (
              <p className="text-xs text-slate-500">Only issued invoices can be emailed; this one has moved past that stage.</p>
            )}
            {(canVoid || canSend) && !canFinancial && <CapabilityNotice capability="commercial_financial.write" />}
          </div>
        ) : null}
      </Modal>

      {/* ── Void Invoice ──────────────────────────────────────────────── */}
      <FormModal
        open={voidInvoiceOpen}
        onClose={() => setVoidInvoiceOpen(false)}
        onSubmit={submitVoidInvoice}
        title="Void invoice"
        description="Voiding is permanent — corrections are made with a new invoice or a credit note, never an edit."
        busy={voidInvoiceBusy}
        error={voidInvoiceError}
        submitLabel="Void invoice"
      >
        <Field label="Reason" required>
          <textarea rows={3} className={FORM_CONTROL_CLASS} value={voidInvoiceReason} onChange={(e) => setVoidInvoiceReason(e.target.value)} />
        </Field>
      </FormModal>

      {/* ── Record Payment ────────────────────────────────────────────── */}
      <FormModal
        open={recordPaymentOpen}
        onClose={() => setRecordPaymentOpen(false)}
        onSubmit={submitRecordPayment}
        title="Record payment"
        description="Record money received from an organization by wire, ACH or another offline method. It's recorded as cleared and can then be allocated to invoices."
        busy={recordPaymentBusy}
        error={recordPaymentError}
        submitLabel="Record payment"
      >
        <Field label="Commercial account" required hint={accountsHint}>
          <Select
            value={recordPaymentForm.account_id}
            onChange={(v) => setRecordPaymentForm((f) => ({ ...f, account_id: v }))}
            options={accountOptions}
            placeholder="Select an account…"
            aria-label="Commercial account"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount" required>
            <input aria-label="Amount" inputMode="decimal" className={FORM_CONTROL_CLASS} value={recordPaymentForm.amount} onChange={(e) => setRecordPaymentForm((f) => ({ ...f, amount: e.target.value }))} />
          </Field>
          <Field label="Currency" required>
            <input aria-label="Currency" maxLength={3} className={FORM_CONTROL_CLASS} value={recordPaymentForm.currency} onChange={(e) => setRecordPaymentForm((f) => ({ ...f, currency: e.target.value.toUpperCase() }))} />
          </Field>
        </div>
        <Field label="Payment method">
          <Select
            value={recordPaymentForm.payment_method}
            onChange={(v) => setRecordPaymentForm((f) => ({ ...f, payment_method: v }))}
            options={PAYMENT_METHOD_OPTIONS}
            placeholder=""
            aria-label="Payment method"
          />
        </Field>
        <Field label="Reference" hint="e.g. the wire reference">
          <input className={FORM_CONTROL_CLASS} value={recordPaymentForm.transaction_id} onChange={(e) => setRecordPaymentForm((f) => ({ ...f, transaction_id: e.target.value }))} />
        </Field>
        <Field label="Notes">
          <textarea rows={2} className={FORM_CONTROL_CLASS} value={recordPaymentForm.notes} onChange={(e) => setRecordPaymentForm((f) => ({ ...f, notes: e.target.value }))} />
        </Field>
      </FormModal>

      {/* ── Create Evaluation Program (§B3) ───────────────────────────── */}
      <FormModal
        open={createProgramOpen}
        onClose={() => setCreateProgramOpen(false)}
        onSubmit={submitCreateProgram}
        title="Create trial program"
        description="Starts inactive — creating it grants no trial. Approve it, then activate it from the list."
        busy={createProgramBusy}
        error={createProgramError}
        submitLabel="Create program"
      >
        <Field label="Plan" required hint={plans.length === 0 ? "No commercial plans found." : undefined}>
          <Select
            value={createProgramForm.plan_id}
            onChange={(v) => setCreateProgramForm((f) => ({ ...f, plan_id: v }))}
            options={planOptions}
            placeholder="Select a plan…"
            aria-label="Plan"
          />
        </Field>
        <Field label="Trial length (days)" required>
          <input type="number" min="1" step="1" className={FORM_CONTROL_CLASS} value={createProgramForm.duration_days} onChange={(e) => setCreateProgramForm((f) => ({ ...f, duration_days: e.target.value }))} />
        </Field>
        <Field label="Card requirement">
          <Select value={createProgramForm.payment_requirement} onChange={(v) => setCreateProgramForm((f) => ({ ...f, payment_requirement: v }))} options={EVALUATION_PAYMENT_REQUIREMENT_OPTIONS} placeholder="" />
        </Field>
        <Field label="Conversion">
          <Select value={createProgramForm.conversion_policy} onChange={(v) => setCreateProgramForm((f) => ({ ...f, conversion_policy: v }))} options={EVALUATION_CONVERSION_POLICY_OPTIONS} placeholder="" />
        </Field>
        <Field label="When the trial ends">
          <Select value={createProgramForm.expiry_action} onChange={(v) => setCreateProgramForm((f) => ({ ...f, expiry_action: v }))} options={EVALUATION_EXPIRY_ACTION_OPTIONS} placeholder="" />
        </Field>
      </FormModal>

      {/* ── Allocate Payment ──────────────────────────────────────────── */}
      <FormModal
        open={allocateOpen}
        onClose={() => setAllocateOpen(false)}
        onSubmit={submitAllocate}
        title="Allocate payment"
        description={
          allocateTarget
            ? `Apply payment ${allocateTarget.payment_number} (${formatCurrency(allocateTarget.amount, allocateTarget.currency)}) to an open invoice.`
            : undefined
        }
        busy={allocateBusy}
        error={allocateError}
        submitLabel="Allocate"
      >
        <Field
          label="Invoice"
          required
          error={allocateInvoicesError || undefined}
          hint={
            allocateTarget && allocateInvoices.length === 0
              ? `This account has no open ${allocateTarget.currency} invoices with a balance.`
              : `Open ${allocateTarget?.currency || ""} invoices for this account with a balance due`
          }
        >
          <Select
            value={allocateForm.invoice_id}
            onChange={selectAllocateInvoice}
            options={allocateInvoices.map((inv) => ({
              value: String(inv.id),
              label: `${inv.invoice_number || "Draft"} — balance ${formatCurrency(inv.balance_due, inv.currency)}`,
            }))}
            placeholder="Select an invoice…"
            aria-label="Invoice"
          />
        </Field>
        <Field label="Amount" required>
          <input aria-label="Allocation amount" inputMode="decimal" className={FORM_CONTROL_CLASS} value={allocateForm.amount} onChange={(e) => setAllocateForm((f) => ({ ...f, amount: e.target.value }))} />
        </Field>
      </FormModal>

      {/* ── Deallocate Payment ────────────────────────────────────────── */}
      <FormModal
        open={deallocateOpen}
        onClose={() => setDeallocateOpen(false)}
        onSubmit={submitDeallocate}
        title="Remove allocation"
        description={deallocateTarget ? `Remove payment ${deallocateTarget.payment_number}'s allocation from an invoice. The invoice's balance goes back up by that amount.` : undefined}
        busy={deallocateBusy}
        error={deallocateError}
        submitLabel="Remove allocation"
      >
        <Field label="Invoice" required hint="Pick the invoice this payment was allocated to">
          <Select
            value={deallocateInvoiceId}
            onChange={setDeallocateInvoiceId}
            options={deallocateInvoices.map((inv) => ({
              value: String(inv.id),
              label: `${inv.invoice_number || "Draft"} — paid ${formatCurrency(inv.paid_amount, inv.currency)}`,
            }))}
            placeholder="Select an invoice…"
            aria-label="Invoice"
          />
        </Field>
      </FormModal>

      {ConfirmationDialog}
    </div>
  );
}
