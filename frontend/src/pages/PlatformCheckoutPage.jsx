import React, { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { publicPlatformInvoiceApi } from "../service/platformPublicService";

// Reached by navigating here (not by an inline API call) so clicking "Pay"
// always opens a real page/tab immediately — this page then starts the
// Stripe Checkout session and forwards the browser there. If Stripe isn't
// configured yet, that failure is shown here, on a dedicated page, instead
// of as a small inline error on the invoice page.
// What the error page says depends on WHY checkout failed. Every failure used
// to show "Online payment isn't set up yet", including an invalid/expired
// link (404), which sent people chasing a Stripe problem that wasn't there.
export function checkoutErrorView(err) {
  const status = err?.status;
  const message = err?.detail || err?.message || "Unable to start checkout. Please try again.";
  if (status === 404) {
    return {
      title: "Payment Link Not Valid",
      linkInvalid: true,
      message,
      hint: "This payment link has expired or was replaced. Open Zoiko Subscription in your Billing workspace and use Pay Now there, or contact Zoiko Billing Accounts.",
    };
  }
  if (status === 400 && /not configured|not installed/i.test(message)) {
    return {
      title: "Checkout Unavailable",
      message,
      hint: "Online payment isn't set up yet for this account. Zoiko Billing Accounts will follow up separately with payment instructions.",
    };
  }
  if (status === 400) {
    return { title: "This Invoice Can't Be Paid Online", message, hint: "Check the invoice status, or contact Zoiko Billing Accounts." };
  }
  return { title: "Checkout Unavailable", message, hint: "Please try again shortly. If this keeps happening, contact Zoiko Billing Accounts." };
}

export default function PlatformCheckoutPage() {
  const { token } = useParams();
  const [state, setState] = useState("starting"); // starting | redirecting | error
  const [error, setError] = useState(null); // checkoutErrorView() result

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setError(checkoutErrorView({ status: 404, message: "Invalid invoice link." }));
      setState("error");
      return;
    }
    publicPlatformInvoiceApi.checkout(token)
      .then((result) => {
        if (cancelled) return;
        if (result?.checkout_url) {
          setState("redirecting");
          window.location.href = result.checkout_url;
        } else {
          setError(checkoutErrorView({ message: "Unable to start checkout. Please try again." }));
          setState("error");
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setError(checkoutErrorView(err));
        setState("error");
      });
    return () => { cancelled = true; };
  }, [token]);

  return (
    <div className="pcp-root">
      <div className="pcp-card">
        {state !== "error" ? (
          <>
            <div className="pcp-spinner" />
            <h1 className="pcp-title">
              {state === "redirecting" ? "Redirecting to Secure Checkout…" : "Starting Checkout…"}
            </h1>
            <p className="pcp-msg">You'll be taken to Stripe to complete your payment securely.</p>
          </>
        ) : (
          <>
            <span className="pcp-icon">⚠️</span>
            <h1 className="pcp-title">{error?.title}</h1>
            <p className="pcp-msg pcp-msg--error" role="alert">{error?.message}</p>
            <p className="pcp-hint">{error?.hint}</p>
          </>
        )}

        {token && !error?.linkInvalid && (
          <Link to={`/platform-invoice/${token}`} className="pcp-link">
            ← Back to invoice
          </Link>
        )}
      </div>
      <style>{STYLES}</style>
    </div>
  );
}

const STYLES = `
  .pcp-root { min-height: 100vh; background: linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%); font-family: 'Inter', 'Segoe UI', system-ui, sans-serif; display: flex; align-items: center; justify-content: center; padding: 2rem 1rem; }
  .pcp-card { max-width: 440px; width: 100%; text-align: center; background: rgba(30,41,59,0.75); border: 1px solid rgba(255,255,255,0.08); border-radius: 1.5rem; padding: 3rem 2.25rem; box-shadow: 0 20px 60px rgba(0,0,0,0.35); }
  .pcp-icon { font-size: 3.5rem; display: block; margin-bottom: 1.25rem; }
  .pcp-spinner { width: 3rem; height: 3rem; margin: 0 auto 1.5rem; border-radius: 50%; border: 3px solid rgba(59,130,246,0.2); border-top-color: #3b82f6; animation: pcp-spin 0.8s linear infinite; }
  @keyframes pcp-spin { to { transform: rotate(360deg); } }
  .pcp-title { font-size: 1.3rem; font-weight: 800; color: #f8fafc; margin: 0 0 0.75rem; }
  .pcp-msg { font-size: 0.9rem; color: #cbd5e1; line-height: 1.6; margin: 0 0 0.5rem; }
  .pcp-msg--error { color: #fca5a5; font-weight: 600; margin-bottom: 1rem; }
  .pcp-hint { font-size: 0.8rem; color: #94a3b8; line-height: 1.6; margin: 0 0 1.5rem; }
  .pcp-link { display: inline-block; margin-top: 0.5rem; font-size: 0.85rem; font-weight: 600; color: #60a5fa; text-decoration: none; }
  .pcp-link:hover { text-decoration: underline; }
`;
