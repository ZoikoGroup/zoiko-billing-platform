import { useState, useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Loader2, AlertCircle, CheckCircle2, ArrowLeft, Eye, EyeOff } from "lucide-react";
import { apiFetch } from "../api/client";
import LandingHeader from "../landing/LandingHeader";
import Footer from "../landing/Footer";

const PASSWORD_RULES = [
  { test: (p) => p.length >= 8, label: "At least 8 characters" },
  { test: (p) => /[A-Z]/.test(p), label: "One uppercase letter" },
  { test: (p) => /[a-z]/.test(p), label: "One lowercase letter" },
  { test: (p) => /[0-9]/.test(p), label: "One number" },
];

export default function AcceptInvitePage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get("token");

  const [status, setStatus] = useState("validating"); // validating | ready | success | error
  const [email, setEmail] = useState("");
  const [orgName, setOrgName] = useState("");
  const [error, setError] = useState(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [passwordErrors, setPasswordErrors] = useState([]);

  useEffect(() => {
    if (!token) {
      setStatus("error");
      setError("No invitation token provided. Please check your email for the correct link.");
      return;
    }
    apiFetch(`/api/auth/validate-invite?token=${encodeURIComponent(token)}`)
      .then((data) => {
        if (data.valid) {
          setEmail(data.email || "");
          setOrgName(data.organization_name || "");
          setStatus("ready");
        } else {
          setStatus("error");
          const errorMessages = {
            invalid_token: "This invitation link is invalid. Please check your email for the correct link.",
            expired: "Your invitation has expired. Please ask your organization administrator to send a new invitation.",
            already_accepted: "This invitation has already been accepted. Please sign in with your existing credentials.",
          };
          setError(errorMessages[data.error] || "This invitation link is no longer valid.");
        }
      })
      .catch(() => {
        setStatus("error");
        setError("Unable to validate your invitation. Please try again later.");
      });
  }, [token]);

  useEffect(() => {
    setPasswordErrors(PASSWORD_RULES.map((r) => ({ ...r, pass: r.test(password) })));
  }, [password]);

  const passwordsMatch = password === confirmPassword && confirmPassword.length > 0;
  const allValid = passwordErrors.every((r) => r.pass) && passwordsMatch;

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    if (!allValid) {
      setError("Please meet all password requirements.");
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch("/api/auth/accept-invite", {
        method: "POST",
        body: { token, password },
      });
      setStatus("success");
    } catch (err) {
      const msg = err.message || "Something went wrong. Please try again.";
      if (msg.includes("expired")) {
        setError("Your invitation has expired. Please ask your organization administrator to send a new invitation.");
      } else if (msg.includes("already")) {
        setError("This invitation has already been accepted. Please sign in with your existing credentials.");
      } else {
        setError(msg);
      }
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
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "48px 24px" }}>
        <div style={{ width: "100%", maxWidth: "420px" }}>
          {status === "validating" && (
            <div style={{ textAlign: "center", padding: "40px 0" }}>
              <Loader2 size={32} color="#FF6B00" style={{ animation: "spin 1s linear infinite", margin: "0 auto" }} />
              <p style={{ marginTop: 16, fontSize: 14, color: "#6B7280" }}>Validating your invitation...</p>
            </div>
          )}

          {status === "error" && (
            <div style={{ textAlign: "center", padding: "8px 0" }}>
              <AlertCircle size={40} color="#DC2626" style={{ margin: "0 auto 16px" }} />
              <h1 style={{ fontSize: "22px", fontWeight: "800", color: "#0F172A", margin: "0 0 8px 0", letterSpacing: "-0.5px" }}>
                Unable to accept invitation
              </h1>
              <p style={{ fontSize: "14px", color: "#6B7280", lineHeight: "1.7", margin: "0 0 8px 0" }}>
                {error}
              </p>
            </div>
          )}

          {status === "success" && (
            <div style={{ textAlign: "center", padding: "8px 0" }}>
              <CheckCircle2 size={40} color="#059669" style={{ margin: "0 auto 16px" }} />
              <h1 style={{ fontSize: "22px", fontWeight: "800", color: "#0F172A", margin: "0 0 8px 0", letterSpacing: "-0.5px" }}>
                Account created successfully
              </h1>
              <p style={{ fontSize: "14px", color: "#6B7280", lineHeight: "1.7", margin: "0 0 24px 0" }}>
                Your password has been set. You can now sign in to Zoiko Billing.
              </p>
              <Link to="/login" style={{
                display: "inline-flex", alignItems: "center", gap: "6px",
                padding: "12px 28px", borderRadius: "50px", fontSize: "15px", fontWeight: "600",
                color: "white", background: "linear-gradient(135deg, #FF8C00, #FFA500)",
                boxShadow: "0 4px 16px rgba(255,140,0,0.4)", textDecoration: "none",
              }}>
                Continue to Login
              </Link>
            </div>
          )}

          {status === "ready" && (
            <>
              <div style={{ textAlign: "center", marginBottom: 24 }}>
                <div style={{
                  width: "48px", height: "48px", borderRadius: "12px", margin: "0 auto 16px",
                  background: "linear-gradient(135deg, #f97316 40%, #3b82f6 100%)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: "22px", color: "#ffffff", fontWeight: "700", fontStyle: "italic",
                }}>1</div>
                <h1 style={{ fontSize: "24px", fontWeight: "800", color: "#0F172A", margin: "0 0 8px 0", letterSpacing: "-0.5px" }}>
                  Set up your account
                </h1>
                <p style={{ fontSize: "14px", color: "#6B7280", lineHeight: "1.6", margin: "0" }}>
                  You've been invited to join:
                </p>
                {orgName && (
                  <p style={{ fontSize: "16px", fontWeight: "700", color: "#0F172A", margin: "6px 0 0 0" }}>
                    {orgName}
                  </p>
                )}
              </div>

              {error && (
                <div style={{
                  display: "flex", alignItems: "flex-start", gap: "8px",
                  background: "#FEF2F2", border: "1px solid #FECACA",
                  borderRadius: "8px", padding: "12px 14px", marginBottom: "20px"
                }}>
                  <AlertCircle size={15} color="#DC2626" style={{ marginTop: "1px", flexShrink: 0 }} />
                  <span style={{ fontSize: "13px", color: "#DC2626" }}>{error}</span>
                </div>
              )}

              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "block", fontSize: "13px", fontWeight: "500", color: "#374151", marginBottom: "6px" }}>
                  Email
                </label>
                <input
                  type="email"
                  value={email}
                  disabled
                  style={{ ...inputStyle, background: "#F9FAFB", color: "#6B7280", cursor: "not-allowed" }}
                />
              </div>

              <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                <div>
                  <label htmlFor="password" style={{ display: "block", fontSize: "13px", fontWeight: "500", color: "#374151", marginBottom: "6px" }}>
                    Create Password
                  </label>
                  <div style={{ position: "relative" }}>
                    <input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      autoComplete="new-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Create a strong password"
                      style={{ ...inputStyle, paddingRight: 42 }}
                      onFocus={(e) => e.target.style.borderColor = "#FF6B00"}
                      onBlur={(e) => e.target.style.borderColor = "#E5E7EB"}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      style={{
                        position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)",
                        background: "none", border: "none", cursor: "pointer", padding: 4, color: "#9CA3AF",
                      }}
                    >
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>

                <div>
                  <label htmlFor="confirmPassword" style={{ display: "block", fontSize: "13px", fontWeight: "500", color: "#374151", marginBottom: "6px" }}>
                    Confirm Password
                  </label>
                  <input
                    id="confirmPassword"
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Confirm your password"
                    style={inputStyle}
                    onFocus={(e) => e.target.style.borderColor = "#FF6B00"}
                    onBlur={(e) => e.target.style.borderColor = "#E5E7EB"}
                  />
                </div>

                {password.length > 0 && (
                  <div style={{ background: "#F9FAFB", borderRadius: "8px", padding: "12px 14px" }}>
                    <p style={{ fontSize: "12px", fontWeight: "600", color: "#374151", margin: "0 0 8px 0" }}>
                      Password requirements:
                    </p>
                    {passwordErrors.map((rule, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: "6px", marginBottom: 4 }}>
                        <CheckCircle2 size={12} color={rule.pass ? "#059669" : "#D1D5DB"} />
                        <span style={{ fontSize: "12px", color: rule.pass ? "#059669" : "#6B7280" }}>
                          {rule.label}
                        </span>
                      </div>
                    ))}
                    {confirmPassword.length > 0 && (
                      <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: 4 }}>
                        <CheckCircle2 size={12} color={passwordsMatch ? "#059669" : "#D1D5DB"} />
                        <span style={{ fontSize: "12px", color: passwordsMatch ? "#059669" : "#6B7280" }}>
                          Passwords match
                        </span>
                      </div>
                    )}
                  </div>
                )}

                <button type="submit" disabled={submitting || !allValid}
                  style={{
                    width: "100%", padding: "13px", borderRadius: "50px", border: "none",
                    fontSize: "15px", fontWeight: "600", color: "white",
                    cursor: submitting || !allValid ? "not-allowed" : "pointer",
                    background: submitting || !allValid ? "#FFA366" : "linear-gradient(135deg, #FF8C00, #FFA500)",
                    boxShadow: "0 4px 16px rgba(255,140,0,0.4)",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: "8px",
                    marginTop: "4px", letterSpacing: "0.01em",
                  }}>
                  {submitting && <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} />}
                  {submitting ? "Creating account..." : "Create Account"}
                </button>
              </form>

              <div style={{ textAlign: "center", marginTop: 24 }}>
                <p style={{ fontSize: "13px", color: "#6B7280" }}>
                  Already have an account?{" "}
                  <Link to="/login" style={{ color: "#FF6B00", fontWeight: "600", textDecoration: "none" }}>
                    Sign in
                  </Link>
                </p>
              </div>
            </>
          )}
        </div>
      </div>
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
      <Footer />
    </div>
  );
}
