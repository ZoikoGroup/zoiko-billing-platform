import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Loader2, Eye, EyeOff, AlertCircle, Sparkles } from "lucide-react";
import { apiFetch } from "../api/client";
import { getCurrencyInfo } from "../utils/currency";
import {
  REGISTRATION_COUNTRIES,
  getStatesForCountryName,
  getTimezonesForCountryName,
  getDefaultTimezoneForCountry,
} from "../utils/registrationRegions";
import LandingHeader from "../landing/LandingHeader";
import Footer from "../landing/Footer";

const FOCUS_BORDER = "#3B82F6";
const BLUR_BORDER = "rgba(255,255,255,0.12)";

const fieldStyle = {
  width: "100%", padding: "11px 14px", borderRadius: "10px",
  border: `1.5px solid ${BLUR_BORDER}`, fontSize: "14px", color: "#E5E7EB",
  outline: "none", boxSizing: "border-box", transition: "border-color 0.2s",
  background: "rgba(255,255,255,0.04)",
};

const selectStyle = {
  ...fieldStyle,
  appearance: "auto",
};

const labelStyle = {
  display: "block", fontSize: "13px", fontWeight: "600", color: "#E2E8F0", marginBottom: "6px",
};

export default function RegisterPage() {
  const navigate = useNavigate();

  const [form, setForm] = useState({
    orgName: "",
    adminName: "",
    adminEmail: "",
    password: "",
    phone: "",
    address: "",
    city: "",
    state: "",
    country: "",
    timezone: "",
    industry: "",
    currency: "",
    intendedPlan: "essentials",
    termsAccepted: false,
  });
  const [showPassword, setShowPassword] = useState(false);
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

  function update(field, value) {
    setForm((f) => ({ ...f, [field]: value }));
  }

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

  async function handleSubmit(e) {
    e.preventDefault();
    setLocalError(null);
    setSubmitting(true);
    try {
      await apiFetch("/api/auth/register", {
        method: "POST",
        body: {
          organization: form.orgName,
          name: form.adminName,
          email: form.adminEmail,
          password: form.password,
          phone: form.phone,
          address: form.address,
          city: form.city,
          state: form.state,
          country: form.country,
          timezone: form.timezone,
          industry: form.industry,
          currency: form.currency || undefined,
          intended_plan: form.intendedPlan,
        },
      });
      navigate("/register/success", {
        state: {
          organizationName: form.orgName,
          email: form.adminEmail,
        },
      });
    } catch (err) {
      setLocalError(err.message || "Unable to create your account.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{
      minHeight: "100vh", display: "flex", flexDirection: "column",
      background: "#05070D",
      backgroundImage: "radial-gradient(ellipse 900px 500px at 50% 0%, rgba(37,99,235,0.16) 0%, transparent 70%)",
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
      position: "relative", overflow: "hidden",
    }}>
      {/* Same top bar as LoginPage — LandingHeader. */}
      <LandingHeader />

      {/* Decorative sparkle accent, bottom-right — purely visual. */}
      <Sparkles size={30} style={{ position: "absolute", right: "48px", bottom: "64px", color: "rgba(96,165,250,0.35)", pointerEvents: "none" }} />

      <div style={{
        position: "relative", zIndex: 1,
        flex: 1, display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        padding: "32px 24px 40px",
      }}>
        <div style={{ width: "100%", maxWidth: "680px" }}>
          <div style={{
            position: "relative", overflow: "hidden",
            background: "#0E1526", borderRadius: "20px",
            boxShadow: "0 24px 60px rgba(0,0,0,0.45)",
            border: "1px solid rgba(255,255,255,0.08)",
          }}>
            {/* Top glow section — echoes LoginPage's dark promo panel, blended into the card. */}
            <div style={{
              position: "relative", overflow: "hidden",
              background: "linear-gradient(180deg, rgba(37,99,235,0.35) 0%, rgba(37,99,235,0.08) 60%, transparent 100%)",
              padding: "30px 36px 22px", textAlign: "center",
            }}>
              <h1 style={{ fontSize: "24px", fontWeight: "800", color: "#ffffff", margin: "0 0 6px 0", letterSpacing: "-0.4px" }}>
                Create your account
              </h1>
              <p style={{ fontSize: "13.5px", color: "rgba(226,232,240,0.75)", margin: 0 }}>
                Register your organization for Zoiko Billing and start invoicing customers in minutes.
              </p>
            </div>

            <div style={{ padding: "28px 36px 36px" }}>
            {localError && (
              <div style={{
                display: "flex", alignItems: "flex-start", gap: "8px",
                background: "rgba(220,38,38,0.12)", border: "1px solid rgba(248,113,113,0.35)",
                borderRadius: "10px", padding: "12px 14px", marginBottom: "20px"
              }}>
                <AlertCircle size={16} color="#F87171" style={{ marginTop: "1px", flexShrink: 0 }} />
                <span style={{ fontSize: "13px", color: "#FCA5A5" }}>{localError}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "18px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "18px" }}>
                <div>
                  <label htmlFor="orgName" style={labelStyle}>
                    Organization Name
                  </label>
                  <input
                    id="orgName"
                    type="text"
                    required
                    autoComplete="organization"
                    value={form.orgName}
                    onChange={(e) => update("orgName", e.target.value)}
                    placeholder="Acme Inc."
                    style={fieldStyle}
                    onFocus={e => e.target.style.borderColor = FOCUS_BORDER}
                    onBlur={e => e.target.style.borderColor = BLUR_BORDER}
                  />
                </div>

                <div>
                  <label htmlFor="adminName" style={labelStyle}>
                    Admin Name
                  </label>
                  <input
                    id="adminName"
                    type="text"
                    required
                    autoComplete="name"
                    value={form.adminName}
                    onChange={(e) => update("adminName", e.target.value)}
                    placeholder="Jane Doe"
                    style={fieldStyle}
                    onFocus={e => e.target.style.borderColor = FOCUS_BORDER}
                    onBlur={e => e.target.style.borderColor = BLUR_BORDER}
                  />
                </div>

                <div>
                  <label htmlFor="adminEmail" style={labelStyle}>
                    Admin Email
                  </label>
                  <input
                    id="adminEmail"
                    type="email"
                    required
                    autoComplete="email"
                    value={form.adminEmail}
                    onChange={(e) => update("adminEmail", e.target.value)}
                    placeholder="admin@company.com"
                    style={fieldStyle}
                    onFocus={e => e.target.style.borderColor = FOCUS_BORDER}
                    onBlur={e => e.target.style.borderColor = BLUR_BORDER}
                  />
                </div>

                <div>
                  <label htmlFor="password" style={labelStyle}>
                    Password
                  </label>
                  <div style={{ position: "relative" }}>
                    <input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      required
                      minLength={8}
                      autoComplete="new-password"
                      value={form.password}
                      onChange={(e) => update("password", e.target.value)}
                      placeholder="At least 8 characters"
                      style={{ ...fieldStyle, padding: "11px 44px 11px 14px" }}
                      onFocus={e => e.target.style.borderColor = FOCUS_BORDER}
                      onBlur={e => e.target.style.borderColor = BLUR_BORDER}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(v => !v)}
                      style={{
                        position: "absolute", right: "12px", top: "50%", transform: "translateY(-50%)",
                        background: "none", border: "none", cursor: "pointer", color: "#9CA3AF", padding: 0
                      }}
                      aria-label={showPassword ? "Hide password" : "Show password"}
                    >
                      {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                    </button>
                  </div>
                </div>

                <div>
                  <label htmlFor="phone" style={labelStyle}>
                    Phone Number
                  </label>
                  <input
                    id="phone"
                    type="tel"
                    required
                    autoComplete="tel"
                    value={form.phone}
                    onChange={(e) => update("phone", e.target.value)}
                    placeholder="+1 (555) 123-4567"
                    style={fieldStyle}
                    onFocus={e => e.target.style.borderColor = FOCUS_BORDER}
                    onBlur={e => e.target.style.borderColor = BLUR_BORDER}
                  />
                </div>

                <div>
                  <label htmlFor="industry" style={labelStyle}>
                    Industry
                  </label>
                  <input
                    id="industry"
                    type="text"
                    value={form.industry}
                    onChange={(e) => update("industry", e.target.value)}
                    placeholder="Technology"
                    style={fieldStyle}
                    onFocus={e => e.target.style.borderColor = FOCUS_BORDER}
                    onBlur={e => e.target.style.borderColor = BLUR_BORDER}
                  />
                </div>
              </div>

              <div>
                <label htmlFor="address" style={labelStyle}>
                  Address
                </label>
                <textarea
                  id="address"
                  required
                  value={form.address}
                  onChange={(e) => update("address", e.target.value)}
                  placeholder="123 Main St, Suite 100"
                  rows={2}
                  style={{ ...fieldStyle, resize: "vertical", fontFamily: "inherit" }}
                  onFocus={e => e.target.style.borderColor = FOCUS_BORDER}
                  onBlur={e => e.target.style.borderColor = BLUR_BORDER}
                />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "18px" }}>
                <div>
                  <label htmlFor="city" style={labelStyle}>
                    City
                  </label>
                  <input
                    id="city"
                    type="text"
                    value={form.city}
                    onChange={(e) => update("city", e.target.value)}
                    placeholder="New York"
                    style={fieldStyle}
                    onFocus={e => e.target.style.borderColor = FOCUS_BORDER}
                    onBlur={e => e.target.style.borderColor = BLUR_BORDER}
                  />
                </div>
                <div>
                  <label htmlFor="state" style={labelStyle}>
                    State / Province
                  </label>
                  <select
                    id="state"
                    value={form.state}
                    onChange={(e) => update("state", e.target.value)}
                    disabled={countryStates.length === 0}
                    style={{ ...selectStyle, cursor: countryStates.length === 0 ? "not-allowed" : "default" }}
                    onFocus={e => e.target.style.borderColor = FOCUS_BORDER}
                    onBlur={e => e.target.style.borderColor = BLUR_BORDER}
                  >
                    <option value="">
                      {countryStates.length === 0 ? "Select country first" : "Select state"}
                    </option>
                    {countryStates.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="country" style={labelStyle}>
                    Country
                  </label>
                  <select
                    id="country"
                    required
                    value={form.country}
                    onChange={(e) => handleCountryChange(e.target.value)}
                    style={selectStyle}
                    onFocus={e => e.target.style.borderColor = FOCUS_BORDER}
                    onBlur={e => e.target.style.borderColor = BLUR_BORDER}
                  >
                    <option value="">Select country</option>
                    {REGISTRATION_COUNTRIES.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "18px" }}>
                <div>
                  <label htmlFor="timezone" style={labelStyle}>
                    Timezone
                  </label>
                  <select
                    id="timezone"
                    value={form.timezone}
                    onChange={(e) => update("timezone", e.target.value)}
                    disabled={countryTimezones.length === 0}
                    style={{ ...selectStyle, cursor: countryTimezones.length === 0 ? "not-allowed" : "default" }}
                    onFocus={e => e.target.style.borderColor = FOCUS_BORDER}
                    onBlur={e => e.target.style.borderColor = BLUR_BORDER}
                  >
                    {countryTimezones.length === 0 ? (
                      <option value="">Select a country first</option>
                    ) : (
                      countryTimezones.map((tz) => (
                        <option key={tz} value={tz}>{tz}</option>
                      ))
                    )}
                  </select>
                </div>

                <div>
                  <label htmlFor="currency" style={labelStyle}>
                    Currency
                  </label>
                  <select
                    id="currency"
                    value={form.currency}
                    onChange={(e) => update("currency", e.target.value)}
                    disabled={currencyLoading && currencyOptions.length === 0}
                    style={{ ...selectStyle, cursor: currencyLoading && currencyOptions.length === 0 ? "not-allowed" : "default" }}
                    onFocus={e => e.target.style.borderColor = FOCUS_BORDER}
                    onBlur={e => e.target.style.borderColor = BLUR_BORDER}
                  >
                    <option value="">
                      {currencyLoading && currencyOptions.length === 0 ? "Loading currencies…" : "Auto (by country)"}
                    </option>
                    {currencyOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                  <p style={{ margin: "4px 0 0", fontSize: "11px", color: "#9CA3AF" }}>
                    Auto-suggested from your country; you can change it.
                  </p>
                </div>

                <div>
                  <label htmlFor="intendedPlan" style={labelStyle}>
                    Plan <span style={{ color: "#F87171" }}>*</span>
                  </label>
                  <select
                    id="intendedPlan"
                    required
                    value={form.intendedPlan}
                    onChange={(e) => update("intendedPlan", e.target.value)}
                    style={selectStyle}
                    onFocus={e => e.target.style.borderColor = FOCUS_BORDER}
                    onBlur={e => e.target.style.borderColor = BLUR_BORDER}
                  >
                    <option value="essentials">Essentials</option>
                    <option value="professional">Professional</option>
                    <option value="business">Business</option>
                  </select>
                  <p style={{ margin: "4px 0 0", fontSize: "11px", color: "#9CA3AF" }}>
                    Need Enterprise? Contact your Zoiko representative — it's
                    contract-based and isn't available through self-serve signup.
                  </p>
                </div>
              </div>

              <div style={{ display: "flex", alignItems: "flex-start", gap: "10px" }}>
                <input
                  id="termsAccepted"
                  type="checkbox"
                  required
                  checked={form.termsAccepted}
                  onChange={(e) => update("termsAccepted", e.target.checked)}
                  style={{
                    marginTop: "2px", width: "16px", height: "16px", flexShrink: 0,
                    accentColor: "#2563EB", cursor: "pointer"
                  }}
                />
                <label htmlFor="termsAccepted" style={{ fontSize: "13px", color: "#CBD5E1", cursor: "pointer", lineHeight: "1.4" }}>
                  I accept the Terms &amp; Conditions
                </label>
              </div>

              <button
                type="submit"
                disabled={submitting}
                style={{
                  width: "100%", padding: "13px", borderRadius: "10px", border: "none",
                  fontSize: "15px", fontWeight: "700", color: "white", cursor: submitting ? "not-allowed" : "pointer",
                  background: submitting ? "#93C5FD" : "linear-gradient(135deg, #2563EB, #1D4ED8)",
                  boxShadow: "0 6px 20px rgba(37,99,235,0.35)",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: "8px",
                  transition: "all 0.2s", marginTop: "8px"
                }}
              >
                {submitting && <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} />}
                {submitting ? "Creating account…" : "Create account"}
              </button>
            </form>

            <p style={{ textAlign: "center", fontSize: "13px", color: "#94A3B8", marginTop: "20px", marginBottom: 0 }}>
              Already have an account?{" "}
              <Link to="/login" style={{ color: "#60A5FA", fontWeight: "600", textDecoration: "none" }}>
                Sign in
              </Link>
            </p>
            </div>
          </div>

          <p style={{ textAlign: "center", marginTop: "20px" }}>
            <Link to="/login" style={{ fontSize: "13px", color: "#64748B", textDecoration: "none" }}>
              ← Back to sign in
            </Link>
          </p>
        </div>
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
      <Footer />
    </div>
  );
}
