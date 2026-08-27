import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { publicPlatformInvoiceApi } from "../service/platformPublicService";

function fmtCcy(v, currency) {
  const num = Number(v ?? 0);
  if (Number.isNaN(num)) return `${currency || ""} ${v}`.trim();
  return num.toLocaleString("en-US", { style: "currency", currency: currency || "USD" });
}

// Reached via Stripe Checkout's success_url after a completed payment. The
// webhook (not this page) is the source of truth for money movement — this
// page just polls the invoice a few times in case the browser redirect wins
// the race against webhook delivery, then shows a clear confirmation either
// way rather than trusting anything from the URL itself.
const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 6;

export default function PaymentSuccessPage() {
  const { token } = useParams();
  const [invoice, setInvoice] = useState(null);
  const [error, setError] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const pollCount = useRef(0);

  const load = useCallback(async () => {
    if (!token) {
      setError("Invalid invoice link.");
      return;
    }
    try {
      const data = await publicPlatformInvoiceApi.getView(token);
      setInvoice(data);
      const isPaid = (data.status || "").toLowerCase() === "paid" || Number(data.balance_due) <= 0.005;
      if (isPaid) {
        setConfirmed(true);
        return;
      }
      pollCount.current += 1;
      if (pollCount.current < MAX_POLLS) {
        setTimeout(load, POLL_INTERVAL_MS);
      }
    } catch (err) {
      setError(err?.detail || err?.message || "Unable to load invoice.");
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const stillWaiting = invoice && !confirmed && pollCount.current >= MAX_POLLS;

  return (
    <div className="psp-root">
      <div className="psp-card">
        {error ? (
          <>
            <span className="psp-icon psp-icon--error">⚠️</span>
            <h1 className="psp-title">Something Went Wrong</h1>
            <p className="psp-msg">{error}</p>
          </>
        ) : confirmed ? (
          <>
            <span className="psp-icon psp-icon--success">✅</span>
            <h1 className="psp-title">Payment Received</h1>
            <p className="psp-msg">
              Thank you — your payment for invoice{" "}
              <span className="psp-mono">{invoice?.invoice_number}</span> has been confirmed.
            </p>
            {invoice && (
              <div className="psp-amount-card">
                <p className="psp-amount-label">Amount Paid</p>
                <p className="psp-amount-value">{fmtCcy(invoice.total_amount, invoice.currency)}</p>
              </div>
            )}
            <p className="psp-hint">A receipt has been (or will shortly be) emailed to your organization's admin.</p>
          </>
        ) : (
          <>
            <div className="psp-spinner" />
            <h1 className="psp-title">Confirming Your Payment…</h1>
            <p className="psp-msg">
              This usually takes just a few seconds while we confirm with Stripe.
            </p>
            {stillWaiting && (
              <p className="psp-hint">
                Still processing — this can occasionally take a minute. Refresh this page shortly,
                or check your email for a confirmation.
              </p>
            )}
          </>
        )}

        {token && (
          <Link to={`/platform-invoice/${token}`} className="psp-link">
            View full invoice →
          </Link>
        )}
      </div>
      <style>{STYLES}</style>
    </div>
  );
}

const STYLES = `
  .psp-root { min-height: 100vh; background: linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%); font-family: 'Inter', 'Segoe UI', system-ui, sans-serif; display: flex; align-items: center; justify-content: center; padding: 2rem 1rem; }
  .psp-card { max-width: 460px; width: 100%; text-align: center; background: rgba(30,41,59,0.75); border: 1px solid rgba(255,255,255,0.08); border-radius: 1.5rem; padding: 3rem 2.25rem; box-shadow: 0 20px 60px rgba(0,0,0,0.35); }
  .psp-icon { font-size: 3.5rem; display: block; margin-bottom: 1.25rem; }
  .psp-spinner { width: 3rem; height: 3rem; margin: 0 auto 1.5rem; border-radius: 50%; border: 3px solid rgba(59,130,246,0.2); border-top-color: #3b82f6; animation: psp-spin 0.8s linear infinite; }
  @keyframes psp-spin { to { transform: rotate(360deg); } }
  .psp-title { font-size: 1.4rem; font-weight: 800; color: #f8fafc; margin: 0 0 0.75rem; }
  .psp-msg { font-size: 0.92rem; color: #cbd5e1; line-height: 1.6; margin: 0 0 1.25rem; }
  .psp-mono { font-family: 'JetBrains Mono', 'Fira Mono', monospace; color: #93c5fd; }
  .psp-amount-card { background: linear-gradient(135deg, rgba(16,185,129,0.12), rgba(5,150,105,0.08)); border: 1px solid rgba(16,185,129,0.25); border-radius: 1rem; padding: 1.25rem; margin-bottom: 1.25rem; }
  .psp-amount-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.1em; color: #94a3b8; margin: 0 0 0.35rem; }
  .psp-amount-value { font-size: 1.9rem; font-weight: 800; color: #34d399; margin: 0; }
  .psp-hint { font-size: 0.8rem; color: #94a3b8; line-height: 1.6; margin: 0 0 1.5rem; }
  .psp-link { display: inline-block; margin-top: 0.5rem; font-size: 0.85rem; font-weight: 600; color: #60a5fa; text-decoration: none; }
  .psp-link:hover { text-decoration: underline; }
`;
