import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertCircle,
  ArrowRight,
  CalendarClock,
  ChevronDown,
  Rocket,
  ShieldCheck,
  X,
} from "lucide-react";
import { useAuth } from "../context/AuthContext";
import {
  platformSelfServiceApi,
  getZoikoSubscriptionCached,
  invalidateZoikoSubscriptionCache,
} from "../service/platformSelfServiceApi";

/**
 * Persistent trial banner — mounted once in BillingShell so it is app-wide
 * for any org-facing view, shown only while the org's own Zoiko subscription
 * is TRIALING or TRIAL_RECOVERY. The CTA hits POST /billing/workspace/trial/
 * convert (Part 2 §5.2) and the checkout/quote/invoice route is resolved by
 * the backend, never guessed here. Dismissal is per-session and scoped to
 * (status, subscription id), so a status change re-surfaces the banner.
 */
const TRIAL_ROLES = new Set(["billing_admin", "org_admin"]);
const TRIAL_DAYS = 14;

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
      <p className="text-xs font-medium text-blue-700 flex items-center gap-1.5">
        <span className="inline-block h-3.5 w-3.5 rounded-full border-2 border-blue-600 border-t-transparent animate-spin" />
        Preparing your conversion…
      </p>
    );
  }
  if (actionError) {
    return (
      <p className="text-xs font-medium text-red-700 flex items-center gap-1.5">
        <AlertCircle className="w-3.5 h-3.5 shrink-0" />
        <span>{actionError} The trial isn't interrupted — retry or review your subscription.</span>
      </p>
    );
  }
  if (actionMsg) {
    return (
      <p className="text-xs font-medium text-emerald-800 flex items-center gap-1.5">
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
  // Phones only: the end date and trial note sit behind a toggle so the
  // banner stays one compact strip. From sm up they are always shown.
  const [showDetails, setShowDetails] = useState(false);

  const eligible = role && TRIAL_ROLES.has(role);
  const isTrial = subscription && ["trialing", "trial_recovery"].includes(subscription.status);
  const dismissKey = isTrial ? sessionDismissKey(subscription.status, subscription.id) : null;

  useEffect(() => {
    if (!eligible) {
      setLoading(false);
      return;
    }
    let alive = true;
    getZoikoSubscriptionCached()
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
      invalidateZoikoSubscriptionCache();
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

  // On the dashboards the banner is permanent — it can't be dismissed, so the
  // trial status is always the first thing an admin sees there.
  const onDashboard = typeof window !== "undefined" && /\/dashboard\/?$/.test(window.location?.pathname || "");
  if (loading || !eligible || !isTrial || (dismissed && !onDashboard)) return null;

  const recovery = subscription.status === "trial_recovery";
  const days = recovery ? daysUntil(subscription.recovery_ends_at) : daysUntil(subscription.trial_ends_at);
  const dateLabel = recovery ? fmtDate(subscription.recovery_ends_at) : fmtDate(subscription.trial_ends_at);
  const used = days == null || recovery ? 100 : Math.min(100, Math.max(0, Math.round(((TRIAL_DAYS - days) / TRIAL_DAYS) * 100)));
  const urgent = recovery || (days != null && days <= 3);

  // Below sm the banner is a slim full-width strip (title + days badge +
  // short CTA; end date and note behind a "Show trial details" toggle) so it
  // takes ~7% of a phone screen instead of ~29%. From sm up every class
  // resolves to the original card layout.
  return (
    <div
      role="status"
      aria-label="Trial subscription banner"
      className={`relative overflow-hidden border-b sm:mx-6 sm:mt-4 sm:rounded-2xl sm:border-2 sm:shadow-md lg:mx-8 ${
        urgent ? "border-red-300 bg-red-50" : "border-amber-300 bg-amber-50"
      }`}
    >
      <div className={`h-1 w-full sm:h-1.5 ${urgent ? "bg-red-100" : "bg-amber-100"}`} aria-hidden="true">
        <div
          className={`h-full transition-all ${urgent ? "bg-red-500" : "bg-amber-500"}`}
          style={{ width: `${used}%` }}
        />
      </div>
      <div
        className={`flex items-center justify-between gap-3 px-4 py-1 sm:gap-4 sm:px-6 sm:py-4 ${
          showDetails ? "max-sm:flex-wrap max-sm:py-2" : ""
        }`}
      >
        <div className={`flex min-w-0 items-start gap-3.5 ${showDetails ? "max-sm:basis-full" : ""}`}>
          <div
            className={`hidden sm:flex h-12 w-12 shrink-0 items-center justify-center rounded-xl ${
              urgent ? "bg-red-100 text-red-700" : "bg-amber-100 text-amber-700"
            }`}
          >
            {recovery ? <AlertCircle className="h-6 w-6" /> : <Rocket className="h-6 w-6" />}
          </div>
          <div className="min-w-0">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm font-bold text-slate-900 sm:gap-2 sm:text-base">
              {recovery ? (
                <>
                  {/* Short title on phones keeps title + badge on one line. */}
                  <span className="sm:hidden">Trial ended</span>
                  <span className="hidden sm:inline">Your free trial ended — you're in the recovery window</span>
                  <span className="rounded-full bg-red-600 px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-white">
                    Read / Export only
                  </span>
                </>
              ) : (
                <>
                  <span className="sm:hidden">Free trial</span>
                  <span className="hidden sm:inline">You're on the free trial</span>
                  {days != null ? (
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-white ${
                        urgent ? "bg-red-600" : "bg-amber-600"
                      }`}
                    >
                      {days} day{days === 1 ? "" : "s"} left
                    </span>
                  ) : null}
                </>
              )}
            </p>
            <p id="trial-banner-details" className={`mt-1 text-sm leading-5 text-slate-700 sm:block ${showDetails ? "block" : "hidden"}`}>
              <CalendarClock className="mr-1 inline h-4 w-4 text-slate-500" />
              {recovery
                ? dateLabel
                  ? `Recovery access until ${dateLabel} — convert to a paid plan to restore full access.`
                  : "Convert to a paid plan to restore full access."
                : dateLabel
                  ? `Your plan runs until ${dateLabel}. Conversion keeps everything — usage, data, and configuration are never reset.`
                  : "Convert to a paid plan to keep using Billing after the trial."}
            </p>
            {!recovery && (
              <p className={`mt-1 text-xs text-slate-600 sm:block ${showDetails ? "block" : "hidden"}`}>
                Quotes and invoices you create during the trial carry a “Free trial” banner until you upgrade.
              </p>
            )}
          </div>
        </div>

        <div className={`flex shrink-0 flex-col items-stretch gap-2 sm:items-end ${showDetails ? "max-sm:ml-auto" : ""}`}>
          <TrialActionMessage actionMsg={actionMsg} actionError={actionError} converting={converting} />
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleConvert}
              disabled={converting}
              className="group inline-flex min-h-11 items-center gap-2 rounded-xl bg-blue-600 px-3 py-2.5 text-sm font-bold text-white shadow-sm transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-0 sm:px-5"
            >
              <ShieldCheck className="hidden h-4 w-4 text-blue-100 sm:block" />
              {/* Short visible label on phones; the full one from sm up. */}
              <span className="sm:hidden">{recovery ? "Restore" : "Upgrade"}</span>
              <span className="hidden sm:inline">{recovery ? "Restore full access" : "Continue with paid plan"}</span>
              <ArrowRight className="hidden h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5 sm:block" />
            </button>
            <button
              type="button"
              onClick={() => setShowDetails((v) => !v)}
              aria-expanded={showDetails}
              aria-controls="trial-banner-details"
              aria-label={showDetails ? "Hide trial details" : "Show trial details"}
              className="inline-flex h-11 w-11 items-center justify-center rounded-xl text-slate-600 transition hover:bg-white/60 sm:hidden"
            >
              <ChevronDown className={`h-5 w-5 transition-transform ${showDetails ? "rotate-180" : ""}`} />
            </button>
            {!onDashboard && (
              <button
                type="button"
                onClick={handleDismiss}
                aria-label="Dismiss trial banner for this session"
                className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-slate-300 bg-white text-slate-500 transition hover:bg-slate-50 hover:text-slate-800 sm:h-9 sm:w-9"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
