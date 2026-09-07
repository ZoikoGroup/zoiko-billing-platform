import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertCircle,
  ArrowRight,
  CalendarClock,
  Rocket,
  ShieldCheck,
  X,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { platformSelfServiceApi } from "../service/platformSelfServiceApi";

/**
 * Persistent trial banner — mounted once in BillingShell so it is app-wide
 * for any org-facing view, shown only while the org's own Zoiko subscription
 * is TRIALING or TRIAL_RECOVERY. The CTA hits POST /billing/workspace/trial/
 * convert (Part 2 §5.2) and the checkout/quote/invoice route is resolved by
 * the backend, never guessed here. Dismissal is per-session and scoped to
 * (status, subscription id), so a status change re-surfaces the banner.
 */
const TRIAL_ROLES = new Set(["billing_admin", "org_admin"]);

function sessionDismissKey(status, subscriptionId) {
  return `zoiko_billing_trial_banner_dismissed:${status}:${subscriptionId}`;
}

function daysUntil(isoDate) {
  if (!isoDate) return null;
  const ms = Date.parse(isoDate) - Date.now();
  return Math.max(0, Math.ceil(ms / 86400000));
}

function fmtDate(isoDate) {
  if (!isoDate) return null;
  return new Date(isoDate).toLocaleDateString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function TrialActionMessage({ actionMsg, actionError, converting }) {
  if (converting) {
    return (
      <p className="text-xs text-[#60A5FA] flex items-center gap-1.5">
        <span className="inline-block h-3.5 w-3.5 rounded-full border-2 border-[#60A5FA] border-t-transparent animate-spin" />
        Preparing your conversion…
      </p>
    );
  }
  if (actionError) {
    return (
      <p className="text-xs text-red-400 flex items-center gap-1.5">
        <AlertCircle className="w-3.5 h-3.5 shrink-0" />
        <span>{actionError} The trial isn't interrupted — retry or review your subscription.</span>
      </p>
    );
  }
  if (actionMsg) {
    return (
      <p className="text-xs text-emerald-300/90 flex items-center gap-1.5">
        <ShieldCheck className="w-3.5 h-3.5 shrink-0" />
        <span>{actionMsg}</span>
      </p>
    );
  }
  return null;
}

export default function TrialBanner() {
  const { role } = useAuth();
  const navigate = useNavigate();
  const [subscription, setSubscription] = useState(null);
  const [loading, setLoading] = useState(true);
  const [dismissed, setDismissed] = useState(false);
  const [converting, setConverting] = useState(false);
  const [actionMsg, setActionMsg] = useState(null);
  const [actionError, setActionError] = useState(null);

  const eligible = role && TRIAL_ROLES.has(role);
  const isTrial = subscription && ["trialing", "trial_recovery"].includes(subscription.status);
  const dismissKey = isTrial ? sessionDismissKey(subscription.status, subscription.id) : null;

  useEffect(() => {
    if (!eligible) {
      setLoading(false);
      return;
    }
    let alive = true;
    platformSelfServiceApi
      .getZoikoSubscription()
      .then((res) => {
        if (alive) setSubscription(res?.subscription || null);
      })
      .catch(() => {
        // Banner is progressive enhancement — a failed read must never
        // block any billing page.
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [eligible]);

  useEffect(() => {
    if (!dismissKey) return;
    if (sessionStorage.getItem(dismissKey) === "1") setDismissed(true);
  }, [dismissKey]);

  const handleDismiss = () => {
    if (dismissKey) sessionStorage.setItem(dismissKey, "1");
    setDismissed(true);
  };

  const handleConvert = useCallback(async () => {
    if (!subscription) return;
    setConverting(true);
    setActionError(null);
    setActionMsg(null);
    try {
      const route = await platformSelfServiceApi.convertTrialToPaid({ payment_method: "card" });
      if (route?.mode === "checkout" && route.checkout_url) {
        window.location.href = route.checkout_url;
        return;
      }
      if (route?.mode === "assisted_quote" && route.quote_url) {
        window.location.href = route.quote_url;
        return;
      }
      if (route?.mode === "invoice_due") {
        if (route.public_token) {
          navigate(`/platform-invoice/${route.public_token}`);
        } else {
          setActionMsg("Your conversion invoice is ready — a Super Admin records the payment once it clears.");
        }
        return;
      }
      setActionMsg("Please review your subscription for the next step.");
    } catch (err) {
      setActionError(err?.message || "Could not start the conversion.");
    } finally {
      setConverting(false);
    }
  }, [subscription, navigate]);

  if (loading || !eligible || !isTrial || dismissed) return null;

  const recovery = subscription.status === "trial_recovery";
  const days = recovery ? daysUntil(subscription.recovery_ends_at) : daysUntil(subscription.trial_ends_at);
  const dateLabel = recovery ? fmtDate(subscription.recovery_ends_at) : fmtDate(subscription.trial_ends_at);

  return (
    <div
      role="status"
      aria-label="Trial subscription banner"
      className={`relative mx-4 mt-4 sm:mx-6 lg:mx-8 overflow-hidden rounded-2xl border shadow-[0_24px_80px_rgba(2,6,23,0.30)] bg-gradient-to-r from-[#0B1220] via-[#101B33] to-[#0A0F1F] ${
        recovery ? "border-amber-400/40" : "border-[#2563EB]/40"
      }`}
    >
      <div className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="flex items-start gap-3.5">
          <div
            className={`hidden sm:flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${
              recovery ? "bg-amber-400/15 text-amber-300" : "bg-[#2563EB]/20 text-[#60A5FA]"
            }`}
          >
            {recovery ? <AlertCircle className="h-5 w-5" /> : <Rocket className="h-5 w-5" />}
          </div>
          <div>
            <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-white">
              {recovery ? (
                <>
                  Your free trial ended — you're in the recovery window
                  <span className="rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-amber-300">
                    Read / Export only
                  </span>
                </>
              ) : (
                <>
                  You're on the free trial
                  {days != null ? (
                    <span className="rounded-full border border-[#2563EB]/40 bg-[#2563EB]/15 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider text-[#60A5FA]">
                      {days} day{days === 1 ? "" : "s"} left
                    </span>
                  ) : null}
                </>
              )}
            </p>
            <p className="mt-0.5 text-xs leading-5 text-[#94A3B8]">
              <CalendarClock className="mr-1 inline h-3.5 w-3.5 text-slate-500" />
              {recovery
                ? dateLabel
                  ? `Recovery access until ${dateLabel} — convert to a paid plan to restore full access.`
                  : "Convert to a paid plan to restore full access."
                : dateLabel
                  ? `Your plan runs until ${dateLabel}. Conversion keeps everything — usage, data, and configuration are never reset.`
                  : "Convert to a paid plan to keep using Billing after the trial."}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
          <TrialActionMessage actionMsg={actionMsg} actionError={actionError} converting={converting} />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleConvert}
              disabled={converting}
              className="group inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-[#2563EB] to-[#1D4ED8] px-5 py-2.5 text-xs font-bold text-white shadow-lg shadow-blue-900/40 transition hover:from-[#2563EB] hover:to-[#1D4ED8] hover:shadow-blue-700/40 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <ShieldCheck className="h-4 w-4 text-blue-200" />
              <span>{recovery ? "Restore full access" : "Continue with paid plan"}</span>
              <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
            </button>
            <button
              type="button"
              onClick={handleDismiss}
              aria-label="Dismiss trial banner for this session"
              className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-slate-300 transition hover:border-white/20 hover:bg-white/10 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}