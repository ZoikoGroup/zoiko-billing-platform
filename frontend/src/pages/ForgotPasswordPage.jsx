import { useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, AlertCircle, CheckCircle2, ArrowLeft } from "lucide-react";
import { apiFetch } from "../api/client";
import LandingHeader from "../landing/LandingHeader";
import Footer from "../landing/Footer";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch("/api/auth/forgot-password", {
        method: "POST",
        body: { email },
      });
      setSent(true);
    } catch (err) {
      setError(err.message || "Something went wrong. Please try again.");
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
          {!sent ? (
            <>
              <h1 style={{ fontSize: "24px", fontWeight: "800", color: "#0F172A", margin: "0 0 8px 0", letterSpacing: "-0.5px" }}>
                Forgot your password?
              </h1>
              <p style={{ fontSize: "14px", color: "#6B7280", lineHeight: "1.6", margin: "0 0 28px 0" }}>
                Enter the email address for your account and we'll send you a secure link to reset your password.
              </p>

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
                    onFocus={e => e.target.style.borderColor = "#FF6B00"}
                    onBlur={e => e.target.style.borderColor = "#E5E7EB"}
                  />
                </div>

                <button type="submit" disabled={submitting}
                  style={{
                    width: "100%", padding: "13px", borderRadius: "50px", border: "none",
                    fontSize: "15px", fontWeight: "600", color: "white",
                    cursor: submitting ? "not-allowed" : "pointer",
                    background: submitting ? "#FFA366" : "linear-gradient(135deg, #FF8C00, #FFA500)",
                    boxShadow: "0 4px 16px rgba(255,140,0,0.4)",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: "8px",
                    marginTop: "4px", letterSpacing: "0.01em",
                  }}>
                  {submitting && <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} />}
                  {submitting ? "Sending…" : "Send reset link"}
                </button>
              </form>
            </>
          ) : (
            <div style={{ textAlign: "center", padding: "8px 0" }}>
              <CheckCircle2 size={40} color="#059669" style={{ margin: "0 auto 16px" }} />
              <h1 style={{ fontSize: "22px", fontWeight: "800", color: "#0F172A", margin: "0 0 8px 0", letterSpacing: "-0.5px" }}>
                Check your email
              </h1>
              <p style={{ fontSize: "14px", color: "#6B7280", lineHeight: "1.7", margin: "0 0 8px 0" }}>
                If an account exists for <strong>{email}</strong>, a password reset link has been sent.
              </p>
              <p style={{ fontSize: "13px", color: "#9CA3AF", margin: "0 0 24px 0" }}>
                The link expires in 24 hours.
              </p>
              <button type="button" onClick={() => { setSent(false); setEmail(""); }}
                style={{
                  background: "none", border: "none", cursor: "pointer",
                  fontSize: "13px", color: "#FF6B00", fontWeight: "600", fontFamily: "inherit",
                }}>
                Use a different email
              </button>
            </div>
          )}

          <div style={{ textAlign: "center", marginTop: "24px" }}>
            <Link to="/login"
              style={{
                display: "inline-flex", alignItems: "center", gap: "6px",
                fontSize: "13px", color: "#374151", textDecoration: "none", fontWeight: "500",
              }}>
              <ArrowLeft size={14} />
              Back to sign in
            </Link>
          </div>
        </div>
      </div>
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
      <Footer />
    </div>
  );
}
