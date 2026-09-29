import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { CheckCircle, AlertCircle, Loader2 } from "lucide-react";
import HRPage from "../../../components/HRPage";
import { stripeConnectApi } from "../../../service/billingService";

// Reached via the redirect_uri handed to /billing/stripe/connect/onboarding-url.
// Stripe appends ?code=...&state=... after the tenant completes (or cancels)
// the Connect OAuth flow. This page exchanges that code for a connected
// account (POST /billing/stripe/connect/callback) and then sends the admin
// back to the Stripe Connect settings page — it never talks to Stripe
// directly, and it runs exactly once per redirect (StrictMode-safe via the
// ranOnce ref) since re-submitting the same code would fail regardless.
const SETTINGS_PATH = "/billing/payments/stripe-connect";

export default function StripeConnectCallbackPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [status, setStatus] = useState("pending"); // pending | success | error
  const [error, setError] = useState(null);
  const ranOnce = useRef(false);

  useEffect(() => {
    if (ranOnce.current) return;
    ranOnce.current = true;

    const code = searchParams.get("code");
    const state = searchParams.get("state");
    const stripeError = searchParams.get("error_description") || searchParams.get("error");

    if (stripeError) {
      setStatus("error");
      setError(stripeError);
      return;
    }
    if (!code || !state) {
      setStatus("error");
      setError("Missing authorization code or state from Stripe's redirect. Please try connecting again.");
      return;
    }

    (async () => {
      try {
        await stripeConnectApi.completeOAuth(code, state);
        setStatus("success");
        setTimeout(() => navigate(SETTINGS_PATH, { replace: true }), 1500);
      } catch (err) {
        setStatus("error");
        setError(err?.detail || err?.message || "Failed to complete Stripe Connect. The link may have expired — please try connecting again.");
      }
    })();
  }, [searchParams, navigate]);

  return (
    <HRPage title="Connecting Stripe" subtitle="Finishing your Stripe Connect setup">
      <div className="max-w-lg mx-auto bg-white border border-slate-200 rounded-3xl p-10 text-center">
        {status === "pending" && (
          <>
            <Loader2 className="h-10 w-10 text-brand-600 animate-spin mx-auto mb-4" />
            <h2 className="text-lg font-semibold text-slate-900 mb-1">Confirming with Stripe…</h2>
            <p className="text-sm text-slate-500">This will only take a moment. Please don't close this page.</p>
          </>
        )}

        {status === "success" && (
          <>
            <CheckCircle className="h-10 w-10 text-emerald-600 mx-auto mb-4" />
            <h2 className="text-lg font-semibold text-slate-900 mb-1">Stripe account connected</h2>
            <p className="text-sm text-slate-500">Redirecting you back to Stripe Connect settings…</p>
          </>
        )}

        {status === "error" && (
          <>
            <AlertCircle className="h-10 w-10 text-red-600 mx-auto mb-4" />
            <h2 className="text-lg font-semibold text-slate-900 mb-1">Couldn't connect Stripe</h2>
            <p className="text-sm text-slate-500 mb-6">{error}</p>
            <button
              onClick={() => navigate(SETTINGS_PATH, { replace: true })}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 transition-colors"
            >
              Back to Stripe Connect
            </button>
          </>
        )}
      </div>
    </HRPage>
  );
}
