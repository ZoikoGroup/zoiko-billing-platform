import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Loader2, Eye, EyeOff, AlertCircle } from "lucide-react";
import { apiFetch, setSession } from "../api/client";
import { ROLE_DEFAULT_REDIRECT, VALID_ROLES } from "../config/roles";
import { useAuth } from "../context/AuthContext";
import LandingHeader from "../landing/LandingHeader";
import Footer from "../landing/Footer";

const GoogleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
    <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
    <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z" fill="#34A853"/>
    <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
    <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
  </svg>
);

const MicrosoftIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
    <rect x="0" y="0" width="8.5" height="8.5" fill="#F25022"/>
    <rect x="9.5" y="0" width="8.5" height="8.5" fill="#7FBA00"/>
    <rect x="0" y="9.5" width="8.5" height="8.5" fill="#00A4EF"/>
    <rect x="9.5" y="9.5" width="8.5" height="8.5" fill="#FFB900"/>
  </svg>
);

const SSOIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
    <circle cx="9" cy="9" r="8" stroke="#6366F1" strokeWidth="1.5"/>
    <path d="M9 5a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm0 5c2.21 0 4 .895 4 2v.5H5V12c0-1.105 1.79-2 4-2z" fill="#6366F1"/>
  </svg>
);

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState(null);

  function defaultRedirectFor(role) {
    return VALID_ROLES.includes(role)
      ? ROLE_DEFAULT_REDIRECT[role]
      : "/login";
  }

  function completeLogin(data) {
    setSession(data);
    login(data.user).then(() => {
      const fallback = defaultRedirectFor(data.user?.role);
      const from = location.state?.from?.pathname || fallback;
      navigate(from, { replace: true });
    });
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setLocalError(null);
    setSubmitting(true);
    try {
      // ZB-SA-CMD-003 v3.0: a valid password completes the login for EVERY
      // role — including Super Admin. There is no MFA screen at login; MFA
      // is enforced only as a step-up when a privileged action demands it.
      const data = await apiFetch("/api/auth/login", {
        method: "POST",
        body: { email, password },
      });
      completeLogin(data);
    } catch (err) {
      setLocalError(err.message || "Unable to sign in. Please check your credentials.");
    } finally {
      setSubmitting(false);
    }
  }

  const inputStyle = {
    width: "100%",
    padding: "11px 14px",
    borderRadius: "8px",
    border: "1.5px solid #E5E7EB",
    fontSize: "14px",
    color: "#111827",
    outline: "none",
    boxSizing: "border-box",
    background: "white",
    fontFamily: "inherit",
  };

  return (
    <div style={{
      minHeight: "100vh",
      display: "flex",
      flexDirection: "column",
      fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
      background: "#ffffff",
    }}>
      <LandingHeader />
      <div style={{ display: "flex", flex: 1 }}>
        {/* ── Left panel: login form ── */}
        <div style={{
          flex: "1",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "48px 40px",
          background: "white",
          backgroundImage: `
            radial-gradient(circle at 20% 80%, rgba(37,99,235,0.05) 0%, transparent 50%),
            radial-gradient(circle at 80% 20%, rgba(37,99,235,0.05) 0%, transparent 50%)
          `,
        }}>
          <div style={{ width: "100%", maxWidth: "400px" }}>
            <h1 style={{ fontSize: "28px", fontWeight: "800", color: "#0F172A", margin: "0 0 32px 0", letterSpacing: "-0.5px" }}>
              Sign in to Zoiko Billing.
            </h1>

            {(localError) && (
              <div style={{
                display: "flex", alignItems: "flex-start", gap: "8px",
                background: "#FEF2F2", border: "1px solid #FECACA",
                borderRadius: "8px", padding: "12px 14px", marginBottom: "20px"
              }}>
                <AlertCircle size={15} color="#DC2626" style={{ marginTop: "1px", flexShrink: 0 }} />
                <span style={{ fontSize: "13px", color: "#DC2626" }}>{localError}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <div>
                <label htmlFor="email" style={{ display: "block", fontSize: "13px", fontWeight: "500", color: "#374151", marginBottom: "6px" }}>
                  Email address
                </label>
                <input
                  id="email" type="email" required autoComplete="email"
                  value={email} onChange={e => setEmail(e.target.value)}
                  placeholder="you@company.com"
                  style={inputStyle}
                  onFocus={e => e.target.style.borderColor = "#2563EB"}
                  onBlur={e => e.target.style.borderColor = "#E5E7EB"}
                />
              </div>

              <div>
                <label htmlFor="password" style={{ display: "block", fontSize: "13px", fontWeight: "500", color: "#374151", marginBottom: "6px" }}>
                  Password
                </label>
                <div style={{ position: "relative" }}>
                  <input
                    id="password" type={showPassword ? "text" : "password"} required
                    autoComplete="current-password" value={password}
                    onChange={e => setPassword(e.target.value)} placeholder="••••••••"
                    style={{ ...inputStyle, paddingRight: "44px" }}
                    onFocus={e => e.target.style.borderColor = "#2563EB"}
                    onBlur={e => e.target.style.borderColor = "#E5E7EB"}
                  />
                  <button type="button" onClick={() => setShowPassword(v => !v)}
                    style={{ position: "absolute", right: "8px", top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "#6B7280", padding: "6px" }}
                    aria-label={showPassword ? "Hide password" : "Show password"}>
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              <button type="submit" disabled={submitting}
                style={{
                  width: "100%", padding: "13px", borderRadius: "50px", border: "none",
                  fontSize: "15px", fontWeight: "600", color: "white",
                  cursor: submitting ? "not-allowed" : "pointer",
                  background: submitting ? "#93C5FD" : "linear-gradient(135deg, #2563EB, #1D4ED8)",
                  boxShadow: "0 4px 16px rgba(37,99,235,0.35)",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: "8px",
                  marginTop: "4px",
                  letterSpacing: "0.01em",
                }}>
                {submitting && <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} />}
                {submitting ? "Signing in…" : "Sign In →"}
              </button>
            </form>

            <div style={{ textAlign: "center", marginTop: "16px" }}>
              <Link to="/forgot-password" style={{ fontSize: "13px", color: "#2563EB", textDecoration: "none", fontWeight: "500" }}>
                Forgot password?
              </Link>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "12px", margin: "20px 0" }}>
              <div style={{ flex: 1, height: "1px", background: "#E5E7EB" }} />
              <span style={{ fontSize: "12px", color: "#6B7280" }}>or</span>
              <div style={{ flex: 1, height: "1px", background: "#E5E7EB" }} />
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {[
                { icon: <GoogleIcon />, label: "Continue with Google" },
                { icon: <MicrosoftIcon />, label: "Continue with Microsoft" },
                { icon: <SSOIcon />, label: "Continue with SSO" },
              ].map(({ icon, label }) => (
                <button key={label} type="button"
                  style={{
                    width: "100%", padding: "11px 16px", borderRadius: "8px",
                    border: "1.5px solid #E5E7EB", background: "white",
                    fontSize: "14px", color: "#374151", cursor: "pointer",
                    display: "flex", alignItems: "center", gap: "10px",
                    fontFamily: "inherit", fontWeight: "500",
                    transition: "border-color 0.15s, background 0.15s",
                  }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = "#D1D5DB"; e.currentTarget.style.background = "#F9FAFB"; }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = "#E5E7EB"; e.currentTarget.style.background = "white"; }}
                >
                  {icon}
                  <span>{label}</span>
                </button>
              ))}
            </div>

            <p style={{ fontSize: "11px", color: "#6B7280", marginTop: "24px", lineHeight: "1.6" }}>
              🔵 Your access is governed by your organization's permissions, roles, workspace settings and security policies.
            </p>
          </div>
        </div>

        {/* ── Right panel: blue promo ── */}
        <div data-panel="right" style={{
          flex: "1",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "60px 56px",
          background: "linear-gradient(164.56deg, #0B1220 0%, #101B33 60%, #0A0F1F 100%)",
          position: "relative",
          overflow: "hidden",
        }}>
          <div style={{
            position: "absolute", top: "-120px", right: "-80px",
            width: "360px", height: "360px",
            background: "radial-gradient(circle, rgba(255,255,255,0.06) 0%, transparent 70%)",
            borderRadius: "50%",
          }} />
          <div style={{
            position: "absolute", bottom: "-100px", left: "-60px",
            width: "280px", height: "280px",
            background: "radial-gradient(circle, rgba(255,255,255,0.04) 0%, transparent 70%)",
            borderRadius: "50%",
          }} />

          <div style={{ position: "relative", zIndex: 1, maxWidth: "520px" }}>
            <p style={{ fontSize: "11px", fontWeight: "700", letterSpacing: "0.12em", color: "#60A5FA", textTransform: "uppercase", margin: "0 0 16px 0", fontFamily: "'JetBrains Mono', monospace" }}>
              — NEW TO ZOIKO BILLING?
            </p>

            <h2 style={{
              fontSize: "38px", fontWeight: "800", color: "white",
              lineHeight: "1.15", margin: "0 0 16px 0", letterSpacing: "-0.5px"
            }}>
              Invoicing, subscriptions and revenue collection on one platform.
            </h2>

            <p style={{ fontSize: "14px", color: "rgba(255,255,255,0.7)", lineHeight: "1.7", margin: "0 0 36px 0" }}>
              Register your organization and run customers, invoices and subscriptions — all in one place.
            </p>

            <Link to="/register"
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                padding: "14px 24px", borderRadius: "50px",
                background: "linear-gradient(135deg, #2563EB, #1D4ED8)",
                color: "white", fontSize: "15px", fontWeight: "700",
                textDecoration: "none", marginBottom: "24px",
                boxShadow: "0 4px 16px rgba(37,99,235,0.35)",
              }}>
              Create your account →
            </Link>
          </div>
        </div>
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @media (max-width: 768px) {
          div[data-panel="right"] { display: none !important; }
        }
      `}</style>
      <Footer />
    </div>
  );
}
