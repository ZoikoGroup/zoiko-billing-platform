import { useEffect, useState } from "react";
import { Loader2, ShieldCheck, AlertCircle, Copy, Check, KeyRound } from "lucide-react";
import { apiFetch } from "../api/client";

/**
 * Real, backend-enforced Super Admin MFA UI — not a decorative screen.
 * Every action here calls a genuine /api/auth/mfa/* endpoint; the actual
 * access/refresh tokens are only ever produced by mfa_service.py after a
 * verified TOTP code (or recovery code). This component cannot itself
 * "let the user in" — it can only ask the backend to, and render whatever
 * the backend decides.
 *
 * status: "enrollment_required" | "challenge_required"
 */
export default function SuperAdminMFAGate({ status, mfaToken, onComplete, onCancel }) {
  const [phase, setPhase] = useState(status === "enrollment_required" ? "loading_enroll" : "challenge");
  const [secret, setSecret] = useState(null);
  const [otpauthUrl, setOtpauthUrl] = useState(null);
  const [code, setCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [pendingLoginData, setPendingLoginData] = useState(null);

  useEffect(() => {
    if (phase !== "loading_enroll") return;
    apiFetch("/api/auth/mfa/enroll/start", { method: "POST", body: { mfa_token: mfaToken } })
      .then((data) => {
        setSecret(data.secret);
        setOtpauthUrl(data.otpauth_url);
        setPhase("enroll");
      })
      .catch((err) => {
        setError(err.message || "Failed to start MFA enrollment.");
        setPhase("enroll");
      });
  }, [phase, mfaToken]);

  async function handleEnrollVerify(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const data = await apiFetch("/api/auth/mfa/enroll/verify", {
        method: "POST",
        body: { mfa_token: mfaToken, code },
      });
      setRecoveryCodes(data.recovery_codes);
      setPendingLoginData(data);
      setPhase("recovery_codes");
    } catch (err) {
      setError(err.message || "Incorrect verification code.");
    } finally {
      setBusy(false);
    }
  }

  async function handleChallenge(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body = useRecovery
        ? { mfa_token: mfaToken, recovery_code: recoveryCode.trim() }
        : { mfa_token: mfaToken, code };
      const data = await apiFetch("/api/auth/mfa/challenge", { method: "POST", body });
      if (data.recovery_codes_remaining !== undefined && data.recovery_codes_remaining !== null && data.recovery_codes_remaining <= 2) {
        setError(
          `Signed in. Only ${data.recovery_codes_remaining} recovery code(s) remain — consider re-enrolling MFA to generate a fresh set.`
        );
      }
      onComplete(data);
    } catch (err) {
      setError(err.message || "Incorrect verification code.");
    } finally {
      setBusy(false);
    }
  }

  function copySecret() {
    navigator.clipboard?.writeText(secret || "");
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const shellStyle = {
    minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
    background: "#ffffff", fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
    padding: "40px 20px",
  };
  const cardStyle = {
    width: "100%", maxWidth: "440px", background: "white",
    border: "1.5px solid #E5E7EB", borderRadius: "16px", padding: "32px",
    boxShadow: "0 12px 40px rgba(15,23,42,0.06)",
  };
  const inputStyle = {
    width: "100%", padding: "11px 14px", borderRadius: "8px",
    border: "1.5px solid #E5E7EB", fontSize: "16px", letterSpacing: "0.15em",
    color: "#111827", outline: "none", boxSizing: "border-box", background: "white",
    fontFamily: "inherit", textAlign: "center",
  };
  const buttonStyle = (disabled) => ({
    width: "100%", padding: "13px", borderRadius: "50px", border: "none",
    fontSize: "15px", fontWeight: "600", color: "white",
    cursor: disabled ? "not-allowed" : "pointer",
    background: disabled ? "#FFA366" : "linear-gradient(135deg, #FF8C00, #FFA500)",
    boxShadow: "0 4px 16px rgba(255,140,0,0.4)",
    display: "flex", alignItems: "center", justifyContent: "center", gap: "8px",
  });

  return (
    <div style={shellStyle}>
      <div style={cardStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}>
          <ShieldCheck size={22} color="#FF6B00" />
          <h1 style={{ fontSize: "20px", fontWeight: "800", color: "#0F172A", margin: 0 }}>
            {phase === "challenge" ? "Two-factor verification" : "Set up two-factor authentication"}
          </h1>
        </div>
        <p style={{ fontSize: "13px", color: "#6B7280", marginBottom: "20px", lineHeight: 1.6 }}>
          {phase === "challenge"
            ? "Super Admin accounts require a verification code on every sign-in."
            : "Super Admin accounts require two-factor authentication. This is enforced by the server — it cannot be skipped."}
        </p>

        {error && (
          <div style={{
            display: "flex", alignItems: "flex-start", gap: "8px",
            background: "#FEF2F2", border: "1px solid #FECACA",
            borderRadius: "8px", padding: "12px 14px", marginBottom: "16px",
          }}>
            <AlertCircle size={15} color="#DC2626" style={{ marginTop: "1px", flexShrink: 0 }} />
            <span style={{ fontSize: "13px", color: "#DC2626" }}>{error}</span>
          </div>
        )}

        {phase === "loading_enroll" && (
          <div style={{ display: "flex", justifyContent: "center", padding: "24px 0" }}>
            <Loader2 size={22} style={{ animation: "spin 1s linear infinite", color: "#FF6B00" }} />
          </div>
        )}

        {phase === "enroll" && secret && (
          <form onSubmit={handleEnrollVerify} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <div>
              <p style={{ fontSize: "12px", fontWeight: "600", color: "#374151", marginBottom: "6px" }}>
                1. Add this key to your authenticator app (Google Authenticator, Authy, 1Password, etc.) via "Enter a setup key manually":
              </p>
              <div style={{
                display: "flex", alignItems: "center", gap: "8px",
                background: "#F9FAFB", border: "1px solid #E5E7EB", borderRadius: "8px", padding: "10px 12px",
              }}>
                <code style={{ flex: 1, fontSize: "14px", letterSpacing: "0.08em", wordBreak: "break-all" }}>{secret}</code>
                <button type="button" onClick={copySecret} aria-label="Copy setup key"
                  style={{ background: "none", border: "none", cursor: "pointer", color: copied ? "#059669" : "#6B7280", flexShrink: 0 }}>
                  {copied ? <Check size={16} /> : <Copy size={16} />}
                </button>
              </div>
            </div>
            <div>
              <label htmlFor="enroll-code" style={{ display: "block", fontSize: "12px", fontWeight: "600", color: "#374151", marginBottom: "6px" }}>
                2. Enter the 6-digit code the app now shows:
              </label>
              <input
                id="enroll-code" inputMode="numeric" autoComplete="one-time-code" maxLength={8}
                value={code} onChange={(e) => setCode(e.target.value.replace(/\s/g, ""))}
                placeholder="123456" style={inputStyle} autoFocus
              />
            </div>
            <button type="submit" disabled={busy || code.length < 6} style={buttonStyle(busy || code.length < 6)}>
              {busy && <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} />}
              {busy ? "Verifying…" : "Verify & Enable"}
            </button>
          </form>
        )}

        {phase === "recovery_codes" && recoveryCodes && (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <p style={{ fontSize: "13px", color: "#374151", lineHeight: 1.6 }}>
              Save these 10 recovery codes somewhere safe. Each can be used once to sign in if you lose access to
              your authenticator app. <strong>They will not be shown again.</strong>
            </p>
            <div style={{
              display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px",
              background: "#F9FAFB", border: "1px solid #E5E7EB", borderRadius: "8px", padding: "14px",
              fontFamily: "monospace", fontSize: "13px",
            }}>
              {recoveryCodes.map((rc) => <span key={rc}>{rc}</span>)}
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "13px", color: "#374151" }}>
              <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
              I have saved these recovery codes.
            </label>
            <button
              type="button" disabled={!acknowledged}
              style={buttonStyle(!acknowledged)}
              onClick={() => onComplete(pendingLoginData)}
            >
              Continue to dashboard →
            </button>
          </div>
        )}

        {phase === "challenge" && (
          <form onSubmit={handleChallenge} style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            {!useRecovery ? (
              <div>
                <label htmlFor="challenge-code" style={{ display: "block", fontSize: "12px", fontWeight: "600", color: "#374151", marginBottom: "6px" }}>
                  6-digit code from your authenticator app
                </label>
                <input
                  id="challenge-code" inputMode="numeric" autoComplete="one-time-code" maxLength={8}
                  value={code} onChange={(e) => setCode(e.target.value.replace(/\s/g, ""))}
                  placeholder="123456" style={inputStyle} autoFocus
                />
              </div>
            ) : (
              <div>
                <label htmlFor="recovery-code" style={{ display: "block", fontSize: "12px", fontWeight: "600", color: "#374151", marginBottom: "6px" }}>
                  Recovery code
                </label>
                <input
                  id="recovery-code" autoComplete="off"
                  value={recoveryCode} onChange={(e) => setRecoveryCode(e.target.value)}
                  placeholder="a1b2c3d4e5" style={inputStyle} autoFocus
                />
              </div>
            )}
            <button
              type="submit" disabled={busy || (useRecovery ? !recoveryCode : code.length < 6)}
              style={buttonStyle(busy || (useRecovery ? !recoveryCode : code.length < 6))}
            >
              {busy && <Loader2 size={16} style={{ animation: "spin 1s linear infinite" }} />}
              {busy ? "Verifying…" : "Verify"}
            </button>
            <button
              type="button"
              onClick={() => { setUseRecovery((v) => !v); setError(null); setCode(""); setRecoveryCode(""); }}
              style={{
                background: "none", border: "none", cursor: "pointer", color: "#FF6B00",
                fontSize: "13px", fontWeight: "500", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px",
              }}
            >
              <KeyRound size={14} />
              {useRecovery ? "Use my authenticator app instead" : "Use a recovery code instead"}
            </button>
          </form>
        )}

        <button
          type="button" onClick={onCancel}
          style={{ background: "none", border: "none", cursor: "pointer", color: "#9CA3AF", fontSize: "12px", marginTop: "20px", width: "100%" }}
        >
          ← Back to sign in
        </button>
      </div>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
