import { useState, useEffect, useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowLeft, Search, CheckCircle, AlertCircle, FileText, User, Package, Eye,
  Calendar, Loader2 } from "lucide-react"
import { subscriptionApi, contractApi, customerApi, settingsApi } from "../../../service/billingService";
import { formatDisplayCurrency, formatDisplayDate, extractArray } from "../../../utils/billing-helpers";
import { useCurrency } from "../utils/CurrencyContext";
import { useTerminology } from "../utils/TerminologyContext";

const WIZARD_STEPS = [
  { id: 1, label: "Source / Customer", icon: User, description: "Select customer or contract" },
  { id: 2, label: "Billing Schedule", icon: Calendar, description: "Billing period & term" },
  { id: 3, label: "Plan & Pricing", icon: Package, description: "Subscription plan details" },
  { id: 4, label: "Review & Create", icon: Eye, description: "Verify all details" },
];

export default function CreateSubscriptionWizardPage({ onClose, onCreated }) {
  const navigate = useNavigate();
  const { singular } = useTerminology();
  const [searchParams] = useSearchParams();

  const [step, setStep] = useState(1);
  const [creationMode, setCreationMode] = useState("");
  const { baseCurrency: orgCurrency } = useCurrency();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [orgConfig, setOrgConfig] = useState(null);

  const [wizardData, setWizardData] = useState({
    contract_id: "", contract_number: "", contract_name: "", contract_value: 0,
    contract_currency: "", contract_billing_period: "monthly", contract_billing_day: 1,
    contract_start_date: "", contract_end_date: "", contract_auto_renew: false, contract_renewal_term: "",
    customer_id: "", customer_name: "", customer_email: "", customer_currency: "",
    plan_id: "", plan_name: "", plan_billing_period: "monthly", plan_unit_price: 0,
    quantity: 1, unit_price: 0, setup_fee: 0, discount_percentage: 0, tax_percentage: 0,
    subscription_number: "", start_date: new Date().toISOString().split("T")[0],
    current_term_end: "", trial_end_date: "",
    notes: "",
  });

  const [contractSearch, setContractSearch] = useState("");
  const [contractResults, setContractResults] = useState([]);
  const [contractSearching, setContractSearching] = useState(false);

  const [customerSearch, setCustomerSearch] = useState("");
  const [customerResults, setCustomerResults] = useState([]);
  const [customerSearching, setCustomerSearching] = useState(false);

  const [planSearch, setPlanSearch] = useState("");
  const [planResults, setPlanResults] = useState([]);
  const [planSearching, setPlanSearching] = useState(false);

  useEffect(() => {
    settingsApi.getConfig().then((config) => {
      setOrgConfig(config);
      const prefix = "SUB-";
      const ts = Date.now().toString(36).toUpperCase();
      setWizardData((p) => ({ ...p, subscription_number: `${prefix}${ts}` }));
    }).catch(() => {
      const ts = Date.now().toString(36).toUpperCase();
      setWizardData((p) => ({ ...p, subscription_number: `SUB-${ts}` }));
    });
  }, []);

  const contractIdParam = searchParams.get("contract_id");
  const customerIdParam = searchParams.get("customer_id");

  useEffect(() => {
    if (contractIdParam) {
      setCreationMode("contract");
      contractApi.get(contractIdParam).then((c) => {
        if (c.status !== "active") {
          setError("Only active contracts can be used for subscription creation");
          return;
        }
        selectContract(c);
      }).catch(() => {
        setError("Could not load the specified contract. It may not exist or you may lack access.");
      });
    } else if (customerIdParam) {
      setCreationMode("direct");
      customerApi.get(customerIdParam).then((cust) => {
        setWizardData((p) => ({
          ...p,
          customer_id: cust.id,
          customer_name: cust.display_name || cust.company_name || cust.name || `${singular} #${cust.id}`,
          customer_email: cust.email || "",
          customer_currency: cust.currency || "",
        }));
      }).catch(() => {
        setError("Could not load the specified customer. It may not exist or you may lack access.");
      });
    }
  }, [contractIdParam, customerIdParam]);

  const handleBack = () => {
    if (onClose) onClose();
    else navigate("/billing/subscriptions");
  };

  const searchContracts = useCallback(async (term) => {
    if (!term.trim()) { setContractResults([]); return; }
    setContractSearching(true);
    try {
      const data = await contractApi.list({ search_term: term, status: "active", per_page: 10 });
      setContractResults(extractArray(data));
    } catch { setContractResults([]); }
    finally { setContractSearching(false); }
  }, []);

  useEffect(() => {
    if (step !== 1 || creationMode !== "contract") return;
    const timer = setTimeout(() => searchContracts(contractSearch), 300);
    return () => clearTimeout(timer);
  }, [contractSearch, step, creationMode, searchContracts]);

  useEffect(() => {
    if (step !== 1 || creationMode !== "direct") return;
    const timer = setTimeout(async () => {
      if (!customerSearch.trim()) { setCustomerResults([]); return; }
      setCustomerSearching(true);
      try {
        const data = await customerApi.list({ search_term: customerSearch, per_page: 10 });
        setCustomerResults(extractArray(data));
      } catch { setCustomerResults([]); }
      finally { setCustomerSearching(false); }
    }, 300);
    return () => clearTimeout(timer);
  }, [customerSearch, step, creationMode]);

  const selectContract = async (c) => {
    setWizardData((p) => ({
      ...p,
      contract_id: c.id, contract_number: c.contract_number, contract_name: c.contract_name,
      contract_value: parseFloat(c.value || 0), contract_currency: c.currency || orgCurrency,
      contract_billing_period: c.billing_period || "monthly", contract_billing_day: c.billing_day || 1,
      contract_start_date: c.start_date, contract_end_date: c.end_date || "",
      contract_auto_renew: c.auto_renew, contract_renewal_term: c.renewal_term_days || "",
      customer_id: c.customer_id,
    }));
    setContractResults([]); setContractSearch("");
    const cust = await customerApi.get(c.customer_id).catch(() => null);
    if (cust) {
      setWizardData((p) => ({
        ...p,
        customer_name: cust.display_name || cust.company_name || cust.name || `Customer #${cust.id}`,
        customer_email: cust.email || "", customer_currency: cust.currency || orgCurrency,
      }));
    }
    const plans = await subscriptionApi.listPlans({ customer_id: c.customer_id, per_page: 20 }).catch(() => ({ items: [] }));
    setPlanResults(extractArray(plans));
  };

  const searchPlans = useCallback(async (term) => {
    if (!term.trim()) { setPlanResults([]); return; }
    setPlanSearching(true);
    try {
      const data = await subscriptionApi.listPlans({ search_term: term, per_page: 10 });
      setPlanResults(extractArray(data));
    } catch { setPlanResults([]); }
    finally { setPlanSearching(false); }
  }, []);

  useEffect(() => {
    if (step !== 3) return;
    const timer = setTimeout(() => searchPlans(planSearch), 300);
    return () => clearTimeout(timer);
  }, [planSearch, step, searchPlans]);

  const selectPlan = (plan) => {
    setWizardData((p) => ({
      ...p,
      plan_id: plan.id, plan_name: plan.plan_name, plan_billing_period: plan.billing_period,
      plan_unit_price: parseFloat(plan.unit_price || plan.flat_fee || 0),
      unit_price: parseFloat(plan.unit_price || plan.flat_fee || 0),
      currency: plan.currency || orgCurrency,
    }));
    setPlanResults([]); setPlanSearch("");
  };

  const computeCurrentTermEnd = (start, period) => {
    const d = new Date(start);
    if (period === "monthly") d.setMonth(d.getMonth() + 1);
    else if (period === "quarterly") d.setMonth(d.getMonth() + 3);
    else if (period === "semi_annual") d.setMonth(d.getMonth() + 6);
    else if (period === "annual") d.setFullYear(d.getFullYear() + 1);
    return d.toISOString().split("T")[0];
  };

  const validateStep = (s) => {
    if (s === 1) {
      if (!creationMode) return "Please select a creation method";
      if (creationMode === "contract" && !wizardData.contract_id) return "Please select a contract";
      if (creationMode === "direct" && !wizardData.customer_id) return "Please select a customer";
    }
    if (s === 3 && !wizardData.plan_id) return "Please select a subscription plan";
    return null;
  };

  const handleNext = () => {
    const err = validateStep(step);
    if (err) { setError(err); return; }
    setError(null);
    setStep((s) => Math.min(4, s + 1));
  };

  const handlePrev = () => {
    setError(null);
    setStep((s) => Math.max(1, s - 1));
  };

  const handleCreate = async () => {
    if (creationMode === "contract" && (!wizardData.contract_id || !wizardData.plan_id || !wizardData.start_date)) return;
    if (creationMode === "direct" && (!wizardData.customer_id || !wizardData.plan_id || !wizardData.start_date)) return;
    setLoading(true); setError(null);
    try {
      const payload = {
        customer_id: Number(wizardData.customer_id),
        plan_id: Number(wizardData.plan_id),
        subscription_number: wizardData.subscription_number,
        quantity: parseInt(wizardData.quantity || 1),
        unit_price: parseFloat(wizardData.unit_price || 0),
        setup_fee: parseFloat(wizardData.setup_fee || 0),
        discount_percentage: parseFloat(wizardData.discount_percentage || 0),
        tax_percentage: parseFloat(wizardData.tax_percentage || 0),
        start_date: wizardData.start_date,
        current_term_start: wizardData.start_date,
        current_term_end: wizardData.current_term_end || computeCurrentTermEnd(wizardData.start_date, wizardData.plan_billing_period),
        trial_end_date: wizardData.trial_end_date || undefined,
        notes: wizardData.notes || undefined,
      };
      if (creationMode === "contract" && wizardData.contract_id) {
        payload.contract_id = Number(wizardData.contract_id);
      }
      const resp = await subscriptionApi.create(payload);
      onCreated?.(resp);
      navigate(`/billing/subscriptions/${resp.id}`);
    } catch (err) {
      setError(err?.detail || err?.message || "Failed to create subscription");
    } finally { setLoading(false); }
  };

  const displayCurrency = wizardData.customer_currency || wizardData.contract_currency || orgCurrency;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <button onClick={handleBack} aria-label="Go back"
            className="p-2 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-700 transition-colors">
            <ArrowLeft size={20} />
          </button>
          <div>
            <h1 className="text-xl font-bold text-slate-900">Create Subscription</h1>
            <p className="text-sm text-slate-500 mt-0.5">Step {step} of {WIZARD_STEPS.length}</p>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 overflow-x-auto pb-2">
        {WIZARD_STEPS.map((s, i) => (
          <div key={s.id} className="flex items-center gap-2">
            <button
              onClick={() => { if (s.id < step) { setStep(s.id); setError(null); } }}
              disabled={s.id > step}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-colors whitespace-nowrap ${
                s.id === step ? "bg-brand-600 text-white" :
                s.id < step ? "bg-brand-100 text-brand-700 hover:bg-brand-200 cursor-pointer" :
                "bg-slate-100 text-slate-500 cursor-not-allowed"
              }`}>
              {s.id < step ? <CheckCircle size={14} /> : <span className="w-5 h-5 rounded-full bg-white/20 flex items-center justify-center text-xs font-bold">{s.id}</span>}
              {s.id === 1 ? `${singular} / Source` : s.label}
            </button>
            {i < WIZARD_STEPS.length - 1 && <div className="w-6 h-px bg-slate-200 flex-shrink-0" />}
          </div>
        ))}
      </div>

      {error && (
        <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
          <AlertCircle size={16} />{error}
        </div>
      )}

      {step === 1 && (
        <div className="space-y-6">
          {!creationMode ? (
            <div className="space-y-4">
              <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
                <FileText size={20} className="text-brand-500" /> How would you like to create this subscription?
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <button onClick={() => setCreationMode("contract")}
                  className="p-6 border-2 border-slate-200 rounded-lg hover:border-brand-200 hover:bg-brand-50 transition-all text-left">
                  <FileText size={28} className="text-brand-500 mb-3" />
                  <p className="font-semibold text-slate-800">From Contract</p>
                  <p className="text-sm text-slate-500 mt-1">Link to an existing active contract. Currency and billing terms inherited from contract.</p>
                </button>
                <button onClick={() => setCreationMode("direct")}
                  className="p-6 border-2 border-slate-200 rounded-lg hover:border-brand-200 hover:bg-brand-50 transition-all text-left">
                  <User size={28} className="text-brand-500 mb-3" />
                  <p className="font-semibold text-slate-800">Direct Creation</p>
                  <p className="text-sm text-slate-500 mt-1">Select a customer and create a subscription directly. Currency resolved from customer or organization defaults.</p>
                </button>
              </div>
            </div>
          ) : creationMode === "contract" ? (
            <div>
              <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2 mb-4">
                <FileText size={20} className="text-brand-500" /> Select Active Contract
              </h3>
              {wizardData.contract_id ? (
                <div className="p-4 bg-brand-50 border border-brand-200 rounded-lg">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-full bg-gradient-to-br from-brand to-brand-hover text-white flex items-center justify-center font-bold">
                        {wizardData.contract_number?.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <p className="font-medium text-slate-800">{wizardData.contract_name}</p>
                        <p className="text-xs text-slate-500">{wizardData.contract_number} · {formatDisplayCurrency(wizardData.contract_value, wizardData.contract_currency)} · {wizardData.contract_billing_period?.replace(/_/g, " ")}</p>
                      </div>
                    </div>
                    <button onClick={() => setWizardData((p) => ({ ...p, contract_id: "", contract_number: "", contract_name: "", customer_id: "" }))}
                      className="text-sm text-brand-600 hover:text-brand-700 font-medium">Change</button>
                  </div>
                  <div className="grid grid-cols-4 gap-3 text-sm p-3 bg-white rounded-lg border border-slate-200">
                    <div><span className="text-xs text-slate-500">Term</span><p className="font-medium">{formatDisplayDate(wizardData.contract_start_date)} — {formatDisplayDate(wizardData.contract_end_date) || "Ongoing"}</p></div>
                    <div><span className="text-xs text-slate-500">Auto Renew</span><p className="font-medium">{wizardData.contract_auto_renew ? "Yes" : "No"}</p></div>
                    <div><span className="text-xs text-slate-500">Billing Day</span><p className="font-medium">Day {wizardData.contract_billing_day || 1}</p></div>
                    <div><span className="text-xs text-slate-500">{singular}</span><p className="font-medium">{wizardData.customer_name || "—"}</p></div>
                  </div>
                </div>
              ) : (
                <div>
                  <div className="relative mb-3">
                    <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                    <input type="text" placeholder="Search active contracts by name or number..." value={contractSearch}
                      onChange={(e) => setContractSearch(e.target.value)}
                      className="w-full pl-9 pr-4 py-2.5 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                  </div>
                  {contractSearching && <p className="text-sm text-slate-500 text-center py-2">Searching...</p>}
                  {contractResults.length > 0 && (
                    <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-60 overflow-y-auto">
                      {contractResults.map((c) => (
                        <button key={c.id} onClick={() => selectContract(c)}
                          className={`w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors ${wizardData.contract_id === c.id ? "bg-blue-50 border-l-4 border-l-blue-500" : ""}`}>
                          <p className="font-medium text-slate-800">{c.contract_name}</p>
                          <p className="text-xs text-slate-500">{c.contract_number} · {formatDisplayCurrency(c.value, c.currency)} · {formatDisplayDate(c.start_date)} — {formatDisplayDate(c.end_date) || "Ongoing"}</p>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2 mb-4">
                <User size={20} className="text-brand-500" /> Select {singular}
              </h3>
              {wizardData.customer_id ? (
                <div className="p-4 bg-brand-50 border border-brand-200 rounded-lg">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-full bg-gradient-to-br from-brand to-brand-hover text-white flex items-center justify-center font-bold">
                        {(wizardData.customer_name || "C").charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <p className="font-medium text-slate-800">{wizardData.customer_name}</p>
                        <p className="text-xs text-slate-500">{wizardData.customer_email} · {wizardData.customer_currency || "—"}</p>
                      </div>
                    </div>
                    <button onClick={() => setWizardData((p) => ({ ...p, customer_id: "", customer_name: "", customer_email: "", customer_currency: "" }))}
                      className="text-sm text-brand-600 hover:text-brand-700 font-medium">Change</button>
                  </div>
                </div>
              ) : (
                <div>
                  <div className="relative mb-3">
                    <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                    <input type="text" placeholder={`Search ${singular.toLowerCase()}s by name or email...`} value={customerSearch}
                      onChange={(e) => setCustomerSearch(e.target.value)}
                      className="w-full pl-9 pr-4 py-2.5 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                  </div>
                  {customerSearching && <p className="text-sm text-slate-500 text-center py-2">Searching...</p>}
                  {customerResults.length > 0 && (
                    <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-60 overflow-y-auto">
                      {customerResults.map((cust) => (
                        <button key={cust.id} onClick={() => {
                          setWizardData((p) => ({ ...p, customer_id: cust.id, customer_name: cust.display_name || cust.company_name || cust.name || `Customer #${cust.id}`, customer_email: cust.email || "", customer_currency: cust.currency || "" }));
                          setCustomerResults([]); setCustomerSearch("");
                        }}
                          className="w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors">
                          <p className="font-medium text-slate-800">{cust.display_name || cust.company_name || cust.name}</p>
                          <p className="text-xs text-slate-500">{cust.email || "\u2014"} · {cust.currency || "No currency set"}</p>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Subscription Number *</label>
              <input type="text" value={wizardData.subscription_number}
                onChange={(e) => setWizardData((p) => ({ ...p, subscription_number: e.target.value }))}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Start Date</label>
              <input type="date" value={wizardData.start_date}
                onChange={(e) => setWizardData((p) => ({ ...p, start_date: e.target.value }))}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
            </div>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-6">
          <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
            <Calendar size={20} className="text-brand-500" /> Billing Schedule
          </h3>
          {creationMode === "contract" && wizardData.contract_id ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="bg-white rounded-lg border border-slate-200 p-4">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Billing Period</p>
                  <p className="text-lg font-bold text-slate-900 mt-1 capitalize">{wizardData.contract_billing_period?.replace(/_/g, " ")}</p>
                </div>
                <div className="bg-white rounded-lg border border-slate-200 p-4">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Billing Day</p>
                  <p className="text-lg font-bold text-slate-900 mt-1">Day {wizardData.contract_billing_day || 1}</p>
                </div>
                <div className="bg-white rounded-lg border border-slate-200 p-4">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Contract Term</p>
                  <p className="text-lg font-bold text-slate-900 mt-1">{formatDisplayDate(wizardData.contract_start_date)} — {formatDisplayDate(wizardData.contract_end_date) || "Ongoing"}</p>
                </div>
                <div className="bg-white rounded-lg border border-slate-200 p-4">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Auto Renew</p>
                  <p className="text-lg font-bold text-slate-900 mt-1">{wizardData.contract_auto_renew ? "Yes" : "No"}</p>
                </div>
              </div>
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
                <h4 className="text-sm font-semibold text-slate-800 mb-3">Subscription Billing Alignment</h4>
                <p className="text-sm text-slate-600 mb-3">The subscription will align its billing cycle with the contract's billing period.</p>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">First Billing Date</label>
                    <input type="date" value={wizardData.start_date}
                      onChange={(e) => setWizardData((p) => ({ ...p, start_date: e.target.value }))}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Current Term End</label>
                    <input type="date" value={wizardData.current_term_end || computeCurrentTermEnd(wizardData.start_date, wizardData.contract_billing_period)}
                      onChange={(e) => setWizardData((p) => ({ ...p, current_term_end: e.target.value }))}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                  </div>
                </div>
              </div>
              {wizardData.contract_auto_renew && wizardData.contract_renewal_term && (
                <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-lg">
                  <p className="text-sm font-medium text-emerald-800">Contract Auto-Renew Enabled</p>
                  <p className="text-xs text-emerald-700 mt-1">Subscription will auto-renew every {wizardData.contract_renewal_term} days per contract terms.</p>
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                <div className="bg-white rounded-lg border border-slate-200 p-4">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Billing Period</p>
                  <p className="text-lg font-bold text-slate-900 mt-1 capitalize">{wizardData.plan_billing_period?.replace(/_/g, " ")}</p>
                </div>
                <div className="bg-white rounded-lg border border-slate-200 p-4">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Start Date</p>
                  <p className="text-lg font-bold text-slate-900 mt-1">{formatDisplayDate(wizardData.start_date)}</p>
                </div>
                <div className="bg-white rounded-lg border border-slate-200 p-4">
                  <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Term End</p>
                  <p className="text-lg font-bold text-slate-900 mt-1">{formatDisplayDate(wizardData.current_term_end || computeCurrentTermEnd(wizardData.start_date, wizardData.plan_billing_period))}</p>
                </div>
              </div>
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
                <h4 className="text-sm font-semibold text-slate-800 mb-3">Subscription Billing Alignment</h4>
                <p className="text-sm text-slate-600 mb-3">The subscription billing cycle will be based on the selected plan's billing period.</p>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">First Billing Date</label>
                    <input type="date" value={wizardData.start_date}
                      onChange={(e) => setWizardData((p) => ({ ...p, start_date: e.target.value }))}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Current Term End</label>
                    <input type="date" value={wizardData.current_term_end || computeCurrentTermEnd(wizardData.start_date, wizardData.plan_billing_period)}
                      onChange={(e) => setWizardData((p) => ({ ...p, current_term_end: e.target.value }))}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {step === 3 && (
        <div className="space-y-6">
          <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
            <Package size={20} className="text-brand-500" /> Select Subscription Plan
          </h3>
          <div className="space-y-4">
            <div className="relative">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input type="text" placeholder="Search plans..." value={planSearch}
                onChange={(e) => setPlanSearch(e.target.value)}
                className="w-full pl-9 pr-4 py-2.5 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
            </div>
            {planSearching && <p className="text-sm text-slate-500 text-center py-2">Searching plans...</p>}
            {planResults.length > 0 && (
              <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-60 overflow-y-auto">
                {planResults.map((plan) => (
                  <button key={plan.id} onClick={() => selectPlan(plan)}
                    className={`w-full text-left px-4 py-3 hover:bg-slate-50 transition-colors ${wizardData.plan_id === plan.id ? "bg-blue-50 border-l-4 border-l-blue-500" : ""}`}>
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-medium text-slate-800">{plan.plan_name}</p>
                        <p className="text-xs text-slate-500">{plan.category || "General"} · {plan.billing_period?.replace(/_/g, " ")} · {formatDisplayCurrency(plan.unit_price || plan.flat_fee, plan.currency)}</p>
                      </div>
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${plan.is_active ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>{plan.is_active ? "Active" : "Inactive"}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
            {wizardData.plan_id && (
              <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                <div className="flex items-center justify-between mb-2">
                  <p className="font-medium text-slate-800">{wizardData.plan_name}</p>
                  <button onClick={() => setWizardData((p) => ({ ...p, plan_id: "", plan_name: "", plan_unit_price: 0 }))}
                    className="text-xs text-blue-600 hover:text-blue-800">Change</button>
                </div>
                <div className="grid grid-cols-4 gap-3 text-sm">
                  <div><span className="text-xs text-slate-500">Billing Period</span><p className="font-medium capitalize">{wizardData.plan_billing_period?.replace(/_/g, " ")}</p></div>
                  <div><span className="text-xs text-slate-500">Unit Price</span><p className="font-medium">{formatDisplayCurrency(wizardData.plan_unit_price, displayCurrency)}</p></div>
                  <div><span className="text-xs text-slate-500">Quantity</span>
                    <input type="number" min="1" value={wizardData.quantity}
                      onChange={(e) => setWizardData((p) => ({ ...p, quantity: parseInt(e.target.value) || 1 }))}
                      className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                  </div>
                  <div><span className="text-xs text-slate-500">Setup Fee</span>
                    <input type="number" min="0" step="0.01" value={wizardData.setup_fee}
                      onChange={(e) => setWizardData((p) => ({ ...p, setup_fee: parseFloat(e.target.value) || 0 }))}
                      className="w-full px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand/30" />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4 mt-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Discount %</label>
                    <input type="number" min="0" max="100" step="0.01" value={wizardData.discount_percentage}
                      onChange={(e) => setWizardData((p) => ({ ...p, discount_percentage: parseFloat(e.target.value) || 0 }))}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Tax %</label>
                    <input type="number" min="0" max="100" step="0.01" value={wizardData.tax_percentage}
                      onChange={(e) => setWizardData((p) => ({ ...p, tax_percentage: parseFloat(e.target.value) || 0 }))}
                      className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="space-y-6">
          <h3 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
            <Eye size={20} className="text-brand-500" /> Review & Create Subscription
          </h3>
          <div className="border border-slate-200 rounded-lg p-6 bg-white">
            <div className="flex justify-between items-start mb-6">
              <div>
                <h2 className="text-2xl font-bold text-slate-800">SUBSCRIPTION PREVIEW</h2>
                <p className="text-sm text-slate-500 mt-1">#{wizardData.subscription_number}</p>
              </div>
              <div className="text-right">
                <p className="text-sm text-slate-500">Date: {formatDisplayDate(wizardData.start_date)}</p>
                <p className="text-xs text-slate-500 mt-1">Status: Draft</p>
              </div>
            </div>
            {wizardData.contract_id && (
              <div className="mb-6 p-4 bg-slate-50 rounded-lg">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1">Contract</p>
                <p className="font-medium text-slate-800">{wizardData.contract_name || "\u2014"}</p>
                {wizardData.contract_number && <p className="text-sm text-slate-500">{wizardData.contract_number}</p>}
              </div>
            )}
            <div className="mb-6 p-4 bg-slate-50 rounded-lg">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider mb-1">{singular}</p>
              <p className="font-medium text-slate-800">{wizardData.customer_name || "\u2014"}</p>
              {wizardData.customer_email && <p className="text-sm text-slate-500">{wizardData.customer_email}</p>}
            </div>
            <div className="border-t border-slate-200 pt-4 space-y-2">
              <div className="flex justify-between text-sm"><span className="text-slate-500">Plan</span><span className="font-medium text-slate-800">{wizardData.plan_name || "\u2014"}</span></div>
              <div className="flex justify-between text-sm"><span className="text-slate-500">Billing Period</span><span className="font-medium text-slate-800 capitalize">{wizardData.plan_billing_period?.replace(/_/g, " ")}</span></div>
              <div className="flex justify-between text-sm"><span className="text-slate-500">Quantity</span><span className="font-medium text-slate-800">{wizardData.quantity}</span></div>
              <div className="flex justify-between text-sm"><span className="text-slate-500">Unit Price</span><span className="font-medium text-slate-800">{formatDisplayCurrency(wizardData.unit_price, displayCurrency)}</span></div>
              <div className="flex justify-between text-sm"><span className="text-slate-500">Setup Fee</span><span className="font-medium text-slate-800">{wizardData.setup_fee > 0 ? formatDisplayCurrency(wizardData.setup_fee, displayCurrency) : "\u2014"}</span></div>
              <div className="flex justify-between text-sm"><span className="text-slate-500">Discount</span><span className="font-medium text-red-500">{wizardData.discount_percentage > 0 ? `${wizardData.discount_percentage}%` : "\u2014"}</span></div>
              <div className="flex justify-between text-sm"><span className="text-slate-500">Tax</span><span className="font-medium text-slate-800">{wizardData.tax_percentage > 0 ? `${wizardData.tax_percentage}%` : "\u2014"}</span></div>
              <div className="flex justify-between text-sm"><span className="text-slate-500">Currency</span><span className="font-medium text-slate-800">{displayCurrency}</span></div>
              <div className="flex justify-between text-base font-bold text-slate-800 border-t border-slate-200 pt-3 mt-2">
                <span>Recurring Amount</span>
                <span>{formatDisplayCurrency((wizardData.unit_price * wizardData.quantity) * (1 - wizardData.discount_percentage / 100) * (1 + wizardData.tax_percentage / 100), displayCurrency)}</span>
              </div>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Notes</label>
            <textarea value={wizardData.notes} onChange={(e) => setWizardData((p) => ({ ...p, notes: e.target.value }))}
              rows={2} placeholder="Optional notes..."
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm transition-colors focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/30" />
          </div>
        </div>
      )}

      <div className="flex justify-between mt-8 pt-6 border-t border-slate-100">
        <div>
          {step > 1 && (
            <button onClick={handlePrev}
              className="px-4 py-2 text-sm font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors">Back</button>
          )}
        </div>
        <div className="flex gap-3">
          <button onClick={handleBack}
            className="px-4 py-2 text-sm font-medium text-slate-700 border border-slate-300 rounded-lg hover:bg-slate-50 transition-colors">Cancel</button>
          {step < 4 ? (
            <button onClick={handleNext}
              disabled={step === 1 && (!creationMode || (creationMode === "contract" && !wizardData.contract_id) || (creationMode === "direct" && !wizardData.customer_id))}
              className="px-6 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50 transition-colors">
              Continue
            </button>
          ) : (
            <button onClick={handleCreate} disabled={loading}
              className="inline-flex items-center gap-2 px-6 py-2 bg-brand-600 text-white rounded-lg text-sm font-medium hover:bg-brand-700 disabled:opacity-50 transition-colors">
              {loading ? <Loader2 size={16} className="animate-spin" /> : <CheckCircle size={16} />}
              {loading ? "Creating..." : "Create Subscription"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
