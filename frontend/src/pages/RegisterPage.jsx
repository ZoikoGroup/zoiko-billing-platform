import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  AlertCircle,
  ArrowRight,
  Check,
  CreditCard,
  Eye,
  EyeOff,
  Gift,
  Loader2,
  Lock,
  Minus,
  ShieldCheck,
} from "lucide-react";
import { apiFetch, setSession } from "../api/client";
import { ROLE_DEFAULT_REDIRECT } from "../config/roles";
import { useAuth } from "../context/AuthContext";
import { getCurrencyInfo } from "../utils/currency";
import {
  REGISTRATION_COUNTRIES,
  getStatesForCountryName,
  getTimezonesForCountryName,
  getDefaultTimezoneForCountry,
} from "../utils/registrationRegions";
import LandingHeader from "../landing/LandingHeader";
import Footer from "../landing/Footer";
import {
  FEATURE_META,
  LIMIT_META,
  PLAN_CATALOG,
  PLAN_ORDER,
} from "../modules/billing-admin/zoikoPlanCatalog";

const TRIAL_DAYS = 14;
const SELF_SERVE_PLANS = ["essentials", "professional", "business"];

const inputCls =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 placeholder-slate-400 " +
  "outline-none transition focus:border-blue-600 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50 disabled:text-slate-400";
const labelCls = "mb-1.5 block text-[13px] font-semibold text-slate-700";

// What each plan is for, in the words a buyer needs. Numbers come from the
// plan catalog so this page, the comparison table and the in-app subscription
// page never disagree.
const PLAN_BLURB = {
  essentials: "Core invoicing for a small team getting started.",
  professional: "Automation, collections and security for a growing team.",
  business: "Higher limits and multi-entity control for larger teams.",
};

const PLAN_HIGHLIGHTS = {
  essentials: ["Core invoicing & flat pricing", "1 payment provider, 1 currency", "Email & webhook basics"],
  professional: ["Everything in Essentials", "Recurring billing, proration, usage metering", "Dunning, reconciliation, SSO, API write access"],
  business: ["Everything in Professional", "Stairstep pricing & up to 10 entities", "20 currencies, 24-month audit search"],
};

function priceLabel(planKey) {
  const price = PLAN_CATALOG[planKey].price;
  return price == null ? "Custom" : `$${price}`;
}

function limitValue(planKey, metaKey) {
  const plan = PLAN_CATALOG[planKey];
  const v = metaKey === "users" ? plan.maxUsers : plan.limits[metaKey];
  return v == null ? "Per contract" : v.toLocaleString("en-US");
}

function Cell({ planKey, metaKey }) {
  return <span>{limitValue(planKey, metaKey)}</span>;
}

function Stepper({ n, title, children }) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-7">
      <div className="mb-5 flex items-center gap-3">
        <span className="grid h-7 w-7 place-items-center rounded-full bg-blue-600 text-sm font-bold text-white">{n}</span>
        <h2 className="text-lg font-bold tracking-tight text-slate-900">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Field({ id, label, required, hint, children }) {
  return (
    <div>
      <label htmlFor={id} className={labelCls}>
        {label}
        {required && <span className="text-red-500"> *</span>}
      </label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-slate-500">{hint}</p>}
    </div>
  );
}

// Google sign-in sends an unknown (but Google-verified) identity here in the
// URL fragment. Nothing is created until this form is submitted.
function readGoogleSignup() {
  const frag = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const ticket = frag.get("google_ticket");
  if (!ticket) return null;
  return { ticket, email: frag.get("email") || "", name: frag.get("name") || "" };
}

export default function RegisterPage() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [google] = useState(readGoogleSignup);

  useEffect(() => {
    if (google) window.history.replaceState(null, "", window.location.pathname);
  }, [google]);

  const [form, setForm] = useState({
    orgName: "",
    adminName: google?.name || "",
    adminEmail: google?.email || "",
    password: "",
    phone: "",
    address: "",
    city: "",
    state: "",
    country: "",
    timezone: "",
    industry: "",
    currency: "",
    termsAccepted: false,
  });
  // "trial" = 14-day Essentials trial, nothing to pay up front.
  // "paid"  = skip the trial, pick any self-serve plan and pay now.
  const [startMode, setStartMode] = useState("trial");
  const [paidPlan, setPaidPlan] = useState("professional");
  const [showPassword, setShowPassword] = useState(false);
  const [showCompare, setShowCompare] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState(null);

  // Country → default currency intelligence served by the backend's
  // authoritative mapping (GET /api/auth/country-defaults). The backend
  // persists the final Organization.currency; this is only a UX suggestion
  // that the user can override.
  const [countryCurrencyMap, setCountryCurrencyMap] = useState({});
  const [currencyOptions, setCurrencyOptions] = useState([]);
  const [currencyLoading, setCurrencyLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    apiFetch("/api/auth/country-defaults")
      .then((res) => {
        if (!mounted) return;
        const byCountry = {};
        const seen = {};
        const options = [];
        (res.countries || []).forEach((c) => {
          if (!c.currency) return;
          byCountry[c.name] = c.currency;
          if (!seen[c.currency]) {
            seen[c.currency] = true;
            const info = getCurrencyInfo(c.currency);
            options.push({
              value: c.currency,
              label: `${info?.flag ? `${info.flag} ` : ""}${c.currency}${info?.name ? ` — ${info.name}` : ""}`,
            });
          }
        });
        setCountryCurrencyMap(byCountry);
        setCurrencyOptions(options.sort((a, b) => a.value.localeCompare(b.value)));
      })
      .catch(() => {})
      .finally(() => {
        if (mounted) setCurrencyLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const update = (field, value) => setForm((f) => ({ ...f, [field]: value }));

  function handleCountryChange(value) {
    setForm((f) => ({
      ...f,
      country: value,
      state: "",
      timezone: getDefaultTimezoneForCountry(value),
      currency: countryCurrencyMap[value] || "",
    }));
  }

  const countryStates = getStatesForCountryName(form.country);
  const countryTimezones = getTimezonesForCountryName(form.country);

  const selectedPlanKey = startMode === "trial" ? "essentials" : paidPlan;
  const selectedPlan = PLAN_CATALOG[selectedPlanKey];

  const ctaLabel = useMemo(() => {
    if (submitting) return startMode === "paid" ? "Creating account…" : "Starting your trial…";
    return startMode === "paid"
      ? `Create account & pay $${selectedPlan.price}`
      : `Start my ${TRIAL_DAYS}-day free trial`;
  }, [submitting, startMode, selectedPlan.price]);

  async function handleSubmit(e) {
    e.preventDefault();
    setLocalError(null);
    setSubmitting(true);
    try {
      const res = await apiFetch("/api/auth/register", {
        method: "POST",
        timeout: 60000,
        body: {
          organization: form.orgName,
          name: form.adminName,
          email: form.adminEmail,
          ...(google ? { google_ticket: google.ticket } : {}),
          ...(form.password ? { password: form.password } : {}),
          phone: form.phone,
          address: form.address,
          city: form.city,
          state: form.state,
          country: form.country,
          timezone: form.timezone,
          industry: form.industry,
          currency: form.currency || undefined,
          intended_plan: selectedPlanKey,
          start_mode: startMode,
        },
      });

      // Google signups are logged in as the Google email straight away.
      if (google && res?.access_token && res?.user) {
        setSession(res);
        await login(res.user);
      }

      // Buy-now signups go straight to secure checkout for their first invoice.
      if (startMode === "paid" && res?.payment_token) {
        navigate(`/platform-invoice/${res.payment_token}/checkout`);
        return;
      }
      if (google && res?.access_token) {
        navigate(ROLE_DEFAULT_REDIRECT[res.user.role] || "/login", { replace: true });
        return;
      }
      navigate("/register/success", {
        state: {
          organizationName: form.orgName,
          email: form.adminEmail,
          startMode,
          planName: selectedPlan.name,
          trialDays: TRIAL_DAYS,
        },
      });
    } catch (err) {
      setLocalError(err.message || "Unable to create your account.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 text-slate-900" style={{ colorScheme: "light" }}>
      {/* Same top bar as LoginPage. */}
      <LandingHeader />

      <main className="flex-1">
        <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
          <div className="mx-auto max-w-2xl text-center">
            <h1 className="text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl">
              Create your Zoiko Billing account
            </h1>
            <p className="mt-3 text-base text-slate-600">
              Try it free for {TRIAL_DAYS} days on the Essentials plan, or skip the trial and start on the plan you need today.
            </p>
          </div>

          <form id="register-form" onSubmit={handleSubmit} className="mt-10 grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
            <div className="space-y-6">
              {/* 1 — how to start */}
              <Stepper n={1} title="How would you like to start?">
                <div role="radiogroup" aria-label="How would you like to start?" className="grid gap-4 sm:grid-cols-2">
                  <label
                    className={`relative cursor-pointer rounded-xl border-2 p-5 transition ${
                      startMode === "trial" ? "border-blue-600 bg-blue-50/60" : "border-slate-200 bg-white hover:border-slate-300"
                    }`}
                  >
                    <input
                      type="radio"
                      name="startMode"
                      value="trial"
                      checked={startMode === "trial"}
                      onChange={() => setStartMode("trial")}
                      className="sr-only"
                    />
                    <span className="absolute right-4 top-4 rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-semibold text-emerald-700">
                      Recommended
                    </span>
                    <Gift className="h-6 w-6 text-blue-600" />
                    <p className="mt-3 text-base font-bold text-slate-900">{TRIAL_DAYS}-day free trial</p>
                    <p className="mt-1 text-sm text-slate-600">
                      Full Essentials plan, no payment needed to begin. Upgrade or pay whenever you're ready.
                    </p>
                  </label>

                  <label
                    className={`relative cursor-pointer rounded-xl border-2 p-5 transition ${
                      startMode === "paid" ? "border-blue-600 bg-blue-50/60" : "border-slate-200 bg-white hover:border-slate-300"
                    }`}
                  >
                    <input
                      type="radio"
                      name="startMode"
                      value="paid"
                      checked={startMode === "paid"}
                      onChange={() => setStartMode("paid")}
                      className="sr-only"
                    />
                    <CreditCard className="h-6 w-6 text-blue-600" />
                    <p className="mt-3 text-base font-bold text-slate-900">Buy a plan now</p>
                    <p className="mt-1 text-sm text-slate-600">
                      No trial. Choose Essentials, Professional or Business and pay securely with Stripe to start straight away.
                    </p>
                  </label>
                </div>
                <p className="mt-4 text-xs text-slate-500">
                  {startMode === "trial"
                    ? `Your trial runs ${TRIAL_DAYS} days with Essentials limits. If it ends unpaid, access pauses and your data is kept for a recovery period so you can still upgrade.`
                    : "Your plan activates as soon as your payment is confirmed. Charged monthly in USD; cancel or change plan any time from Zoiko Subscription."}
                </p>
              </Stepper>

              {/* 2 — plans & limits */}
              <Stepper n={2} title={startMode === "trial" ? "Your trial plan & what's included" : "Choose your plan"}>
                <div className="grid gap-4 md:grid-cols-3">
                  {SELF_SERVE_PLANS.map((key) => {
                    const plan = PLAN_CATALOG[key];
                    const selectable = startMode === "paid";
                    const active = selectedPlanKey === key;
                    const dimmed = startMode === "trial" && key !== "essentials";
                    return (
                      <label
                        key={key}
                        className={`flex flex-col rounded-xl border-2 p-5 transition ${
                          active ? "border-blue-600 bg-blue-50/50 shadow-sm" : "border-slate-200 bg-white"
                        } ${dimmed ? "opacity-70" : ""} ${selectable ? "cursor-pointer hover:border-blue-300" : ""}`}
                      >
                        {selectable && (
                          <input
                            type="radio"
                            name="paidPlan"
                            value={key}
                            checked={paidPlan === key}
                            onChange={() => setPaidPlan(key)}
                            className="sr-only"
                            aria-label={`${plan.name} plan`}
                          />
                        )}
                        <div className="flex items-center justify-between gap-2">
                          <h3 className="text-base font-bold text-slate-900">{plan.name}</h3>
                          {startMode === "trial" && key === "essentials" && (
                            <span className="rounded-full bg-blue-600 px-2 py-0.5 text-[11px] font-semibold text-white">Your trial</span>
                          )}
                          {selectable && active && (
                            <span className="grid h-5 w-5 place-items-center rounded-full bg-blue-600 text-white">
                              <Check className="h-3 w-3" strokeWidth={3} />
                            </span>
                          )}
                        </div>
                        <p className="mt-1 text-xs text-slate-500">{PLAN_BLURB[key]}</p>
                        <p className="mt-4 text-3xl font-extrabold tracking-tight text-slate-900">
                          {priceLabel(key)}
                          <span className="text-sm font-medium text-slate-500"> / month</span>
                        </p>
                        {startMode === "trial" && key === "essentials" ? (
                          <p className="mt-0.5 text-xs font-medium text-emerald-700">Free for {TRIAL_DAYS} days</p>
                        ) : startMode === "trial" ? (
                          <p className="mt-0.5 text-xs text-slate-500">Available when you upgrade</p>
                        ) : null}

                        <dl className="mt-4 space-y-1.5 border-t border-slate-100 pt-4 text-[13px]">
                          {[
                            ["users", "Team members"],
                            ["billing.invoice.monthly_limit", "Invoices / month"],
                            ["api.requests_per_day", "API requests / day"],
                            ["org.entity.max", "Legal entities"],
                            ["currency.enabled.max", "Currencies"],
                            ["webhooks.endpoint.max", "Webhook endpoints"],
                          ].map(([metaKey, label]) => (
                            <div key={metaKey} className="flex items-baseline justify-between gap-2">
                              <dt className="text-slate-500">{label}</dt>
                              <dd className="font-semibold text-slate-900">
                                <Cell planKey={key} metaKey={metaKey} />
                              </dd>
                            </div>
                          ))}
                        </dl>

                        <ul className="mt-4 space-y-1.5 border-t border-slate-100 pt-4 text-[13px] text-slate-700">
                          {PLAN_HIGHLIGHTS[key].map((h) => (
                            <li key={h} className="flex items-start gap-2">
                              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" strokeWidth={3} />
                              <span>{h}</span>
                            </li>
                          ))}
                        </ul>
                      </label>
                    );
                  })}
                </div>

                <div className="mt-4 flex flex-col gap-1 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600 sm:flex-row sm:items-center sm:justify-between">
                  <span>
                    <strong className="text-slate-800">Need Enterprise?</strong> Custom limits, contract pricing and onboarding are arranged with your Zoiko representative — not available through self-serve signup.
                  </span>
                </div>

                <button
                  type="button"
                  onClick={() => setShowCompare((v) => !v)}
                  aria-expanded={showCompare}
                  className="mt-4 text-sm font-semibold text-blue-700 hover:underline"
                >
                  {showCompare ? "Hide full comparison" : "Compare every limit and feature"}
                </button>

                {showCompare && (
                  <div className="mt-4 overflow-x-auto rounded-xl border border-slate-200">
                    <table className="w-full min-w-[640px] border-collapse text-left text-sm">
                      <caption className="sr-only">Plan limits and features</caption>
                      <thead>
                        <tr className="bg-slate-50 text-[11px] font-bold uppercase tracking-wider text-slate-500">
                          <th scope="col" className="px-4 py-3">Limits</th>
                          {PLAN_ORDER.map((k) => (
                            <th key={k} scope="col" className={`px-4 py-3 ${k === selectedPlanKey ? "text-blue-700" : ""}`}>
                              {PLAN_CATALOG[k].name}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        <tr>
                          <th scope="row" className="px-4 py-2.5 font-semibold text-slate-700">Price</th>
                          {PLAN_ORDER.map((k) => (
                            <td key={k} className="px-4 py-2.5 text-slate-800">
                              {PLAN_CATALOG[k].price != null ? `$${PLAN_CATALOG[k].price} / mo` : "Custom"}
                            </td>
                          ))}
                        </tr>
                        {LIMIT_META.map((m) => (
                          <tr key={m.key}>
                            <th scope="row" className="px-4 py-2.5 font-semibold text-slate-700">{m.label}</th>
                            {PLAN_ORDER.map((k) => (
                              <td key={k} className="px-4 py-2.5 text-slate-800">
                                <Cell planKey={k} metaKey={m.key} />
                              </td>
                            ))}
                          </tr>
                        ))}
                        <tr className="bg-slate-50">
                          <th scope="row" colSpan={5} className="px-4 py-2 text-[11px] font-bold uppercase tracking-wider text-slate-500">
                            Features
                          </th>
                        </tr>
                        {FEATURE_META.map((f) => (
                          <tr key={f.key}>
                            <th scope="row" className="px-4 py-2.5 font-semibold text-slate-700">{f.label}</th>
                            {PLAN_ORDER.map((k) => {
                              const on = PLAN_CATALOG[k].features[f.key];
                              return (
                                <td key={k} className="px-4 py-2.5">
                                  {k === "enterprise" ? (
                                    <span className="text-slate-500">Per contract</span>
                                  ) : on ? (
                                    <Check className="h-4 w-4 text-emerald-600" strokeWidth={3} aria-label="Included" />
                                  ) : (
                                    <Minus className="h-4 w-4 text-slate-300" aria-label="Not included" />
                                  )}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                        <tr>
                          <th scope="row" className="px-4 py-2.5 font-semibold text-slate-700">Pricing models</th>
                          {PLAN_ORDER.map((k) => (
                            <td key={k} className="px-4 py-2.5 capitalize text-slate-800">
                              {PLAN_CATALOG[k].pricingModels ? PLAN_CATALOG[k].pricingModels.join(", ") : "Per contract"}
                            </td>
                          ))}
                        </tr>
                      </tbody>
                    </table>
                  </div>
                )}
              </Stepper>

              {/* 3 — account details */}
              <Stepper n={3} title="Your organization & admin account">
                {localError && (
                  <div role="alert" className="mb-5 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3.5 text-sm text-red-800">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{localError}</span>
                  </div>
                )}

                <div className="grid gap-5 sm:grid-cols-2">
                  <Field id="orgName" label="Organization name" required>
                    <input id="orgName" type="text" required autoComplete="organization" value={form.orgName}
                      onChange={(e) => update("orgName", e.target.value)} placeholder="Acme Inc." className={inputCls} />
                  </Field>
                  <Field id="industry" label="Industry">
                    <input id="industry" type="text" value={form.industry}
                      onChange={(e) => update("industry", e.target.value)} placeholder="Technology" className={inputCls} />
                  </Field>
                  <Field id="adminName" label="Admin name" required>
                    <input id="adminName" type="text" required autoComplete="name" value={form.adminName}
                      onChange={(e) => update("adminName", e.target.value)} placeholder="Jane Doe" className={inputCls} />
                  </Field>
                  <Field id="adminEmail" label="Admin email" required>
                    <input id="adminEmail" type="email" required autoComplete="email" value={form.adminEmail}
                      readOnly={!!google} title={google ? "Verified by Google" : undefined}
                      onChange={(e) => update("adminEmail", e.target.value)} placeholder="admin@company.com" className={inputCls} />
                  </Field>
                  <Field id="password" label={google ? "Password (optional)" : "Password"} required={!google}
                    hint={google ? "Optional. Leave blank to sign in with Google only." : "At least 8 characters."}>
                    <div className="relative">
                      <input id="password" type={showPassword ? "text" : "password"} required={!google} minLength={8}
                        autoComplete="new-password" value={form.password}
                        onChange={(e) => update("password", e.target.value)} placeholder="Create a password"
                        className={`${inputCls} pr-11`} />
                      <button type="button" onClick={() => setShowPassword((v) => !v)}
                        aria-label={showPassword ? "Hide password" : "Show password"}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
                        {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                      </button>
                    </div>
                  </Field>
                  <Field id="phone" label="Phone number" required>
                    <input id="phone" type="tel" required autoComplete="tel" value={form.phone}
                      onChange={(e) => update("phone", e.target.value)} placeholder="+1 (555) 123-4567" className={inputCls} />
                  </Field>
                </div>

                <div className="mt-5">
                  <Field id="address" label="Address" required>
                    <textarea id="address" required rows={2} value={form.address}
                      onChange={(e) => update("address", e.target.value)} placeholder="123 Main St, Suite 100"
                      className={`${inputCls} resize-y`} />
                  </Field>
                </div>

                <div className="mt-5 grid gap-5 sm:grid-cols-3">
                  <Field id="country" label="Country" required>
                    <select id="country" required value={form.country}
                      onChange={(e) => handleCountryChange(e.target.value)} className={inputCls}>
                      <option value="">Select country</option>
                      {REGISTRATION_COUNTRIES.map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </Field>
                  <Field id="state" label="State / Province">
                    <select id="state" value={form.state} onChange={(e) => update("state", e.target.value)}
                      disabled={countryStates.length === 0} className={inputCls}>
                      <option value="">{countryStates.length === 0 ? "Select country first" : "Select state"}</option>
                      {countryStates.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  </Field>
                  <Field id="city" label="City">
                    <input id="city" type="text" value={form.city}
                      onChange={(e) => update("city", e.target.value)} placeholder="New York" className={inputCls} />
                  </Field>
                </div>

                <div className="mt-5 grid gap-5 sm:grid-cols-2">
                  <Field id="timezone" label="Timezone">
                    <select id="timezone" value={form.timezone} onChange={(e) => update("timezone", e.target.value)}
                      disabled={countryTimezones.length === 0} className={inputCls}>
                      {countryTimezones.length === 0 ? (
                        <option value="">Select a country first</option>
                      ) : (
                        countryTimezones.map((tz) => (
                          <option key={tz} value={tz}>{tz}</option>
                        ))
                      )}
                    </select>
                  </Field>
                  <Field id="currency" label="Organization currency" hint="Auto-suggested from your country; you can change it. Plan prices are billed in USD.">
                    <select id="currency" value={form.currency} onChange={(e) => update("currency", e.target.value)}
                      disabled={currencyLoading && currencyOptions.length === 0} className={inputCls}>
                      <option value="">
                        {currencyLoading && currencyOptions.length === 0 ? "Loading currencies…" : "Auto (by country)"}
                      </option>
                      {currencyOptions.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </Field>
                </div>

                <div className="mt-6 flex items-start gap-2.5">
                  <input id="termsAccepted" type="checkbox" required checked={form.termsAccepted}
                    onChange={(e) => update("termsAccepted", e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded border-slate-300 accent-blue-600" />
                  <label htmlFor="termsAccepted" className="cursor-pointer text-sm leading-snug text-slate-700">
                    I accept the Terms &amp; Conditions
                  </label>
                </div>
              </Stepper>
            </div>

            {/* Summary */}
            <aside className="lg:sticky lg:top-6 lg:self-start">
              <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                <h2 className="text-sm font-bold uppercase tracking-wider text-slate-500">Your order</h2>

                <div className="mt-4 flex items-start justify-between gap-3">
                  <div>
                    <p className="text-lg font-bold text-slate-900">{selectedPlan.name}</p>
                    <p className="text-xs text-slate-500">
                      {startMode === "trial" ? `${TRIAL_DAYS}-day free trial` : "Billed monthly"}
                    </p>
                  </div>
                  <p className="text-right text-lg font-extrabold text-slate-900">
                    {startMode === "trial" ? "$0" : `$${selectedPlan.price}`}
                    <span className="block text-[11px] font-medium text-slate-500">
                      {startMode === "trial" ? "today" : "due today"}
                    </span>
                  </p>
                </div>

                <ul className="mt-4 space-y-2 border-t border-slate-100 pt-4 text-[13px] text-slate-700">
                  <li className="flex justify-between"><span>Team members</span><strong>{limitValue(selectedPlanKey, "users")}</strong></li>
                  <li className="flex justify-between"><span>Invoices / month</span><strong>{limitValue(selectedPlanKey, "billing.invoice.monthly_limit")}</strong></li>
                  <li className="flex justify-between"><span>API requests / day</span><strong>{limitValue(selectedPlanKey, "api.requests_per_day")}</strong></li>
                </ul>

                {startMode === "trial" && (
                  <p className="mt-4 rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
                    After {TRIAL_DAYS} days Essentials is ${PLAN_CATALOG.essentials.price}/month. You choose when to pay — nothing is charged automatically.
                  </p>
                )}

                <button
                  type="submit"
                  disabled={submitting}
                  className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-blue-700 focus:outline-none focus:ring-4 focus:ring-blue-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  <span>{ctaLabel}</span>
                  {!submitting && <ArrowRight className="h-4 w-4" />}
                </button>

                <p className="mt-4 flex items-center justify-center gap-1.5 text-[11px] text-slate-500">
                  {startMode === "paid" ? <Lock className="h-3.5 w-3.5" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                  {startMode === "paid"
                    ? "Secure payment by Stripe on the next step"
                    : "No payment details needed to start"}
                </p>
              </div>
            </aside>
          </form>
        </div>
      </main>

      <Footer />
    </div>
  );
}
