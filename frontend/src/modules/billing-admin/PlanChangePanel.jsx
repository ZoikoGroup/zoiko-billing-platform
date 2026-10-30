import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  CalendarClock,
  Check,
  CheckCircle2,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import { platformSelfServiceApi, invalidateZoikoSubscriptionCache } from "../../service/platformSelfServiceApi";
import { formatOrgMoney } from "./workspace-format";
import { Button, Modal } from "../../components/billing-ui";

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

const money = (amount, currency) => formatOrgMoney(amount, { default_currency: currency || "USD" });

/**
 * Upgrade / downgrade UI for the org's own Zoiko plan.
 *
 * Upgrade  -> server raises a prorated invoice; we hand the browser to Stripe
 *             Checkout (or the invoice page when Stripe isn't configured). The
 *             plan only changes once that payment clears.
 * Downgrade-> scheduled for the next renewal by default; immediate only when the
 *             server's compatibility checklist has no blockers.
 */
export default function PlanChangePanel({ subscription, pendingChange, onChanged, navigate, trial = false }) {
  const [plans, setPlans] = useState(null); // null = loading/unavailable
  const [selected, setSelected] = useState(null);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [immediate, setImmediate] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    let cancelled = false;
    Promise.resolve()
      .then(() => platformSelfServiceApi.getAvailablePlans())
      .then((res) => {
        if (!cancelled) setPlans(Array.isArray(res?.plans) ? res.plans : null);
      })
      .catch(() => {
        if (!cancelled) setPlans(null);
      });
    return () => {
      cancelled = true;
    };
  }, [subscription?.plan_code, pendingChange?.id]);

  const current = plans?.find((p) => p.is_current) || null;
  const currentPrice = current ? Number(current.price_amount) : subscription?.price_amount != null ? Number(subscription.price_amount) : null;

  const closeModal = useCallback(() => {
    setSelected(null);
    setPreview(null);
    setPreviewError(null);
    setActionError(null);
    setImmediate(false);
  }, []);

  const openPlan = useCallback(async (plan) => {
    setSelected(plan);
    setPreview(null);
    setPreviewError(null);
    setActionError(null);
    setImmediate(false);
    setNotice(null);
    if (trial) {
      // Buying outright from a trial has nothing to preview: it's the plan's
      // first-period price, paid before anything changes.
      setPreview({ direction: "purchase", blockers: [], warnings: [] });
      return;
    }
    setPreviewing(true);
    try {
      setPreview(await platformSelfServiceApi.previewPlanChange(plan.id));
    } catch (err) {
      setPreviewError(err?.message || "Could not preview this plan change.");
    } finally {
      setPreviewing(false);
    }
  }, [trial]);

  const confirm = useCallback(async () => {
    if (!selected || !preview) return;
    setSubmitting(true);
    setActionError(null);
    try {
      const res = trial
        ? await platformSelfServiceApi.convertTrialToPaid({ payment_method: "card", plan_id: selected.id })
        : await platformSelfServiceApi.commitPlanChange({
            targetPlanId: selected.id,
            confirmImmediate: preview.direction === "downgrade" && immediate,
          });
      invalidateZoikoSubscriptionCache();

      if (res?.status === "payment_required") {
        if (res.mode === "checkout" && res.checkout_url) {
          window.location.href = res.checkout_url;
          return;
        }
        if (res.public_token) {
          navigate(`/platform-invoice/${res.public_token}`);
          return;
        }
        setNotice(
          `Invoice ${res.invoice_number || ""} for ${money(res.amount, res.currency)} was created. Complete payment to switch plans.`,
        );
      } else if (res?.status === "applied") {
        setNotice(`You're now on ${selected.plan_name}.`);
      } else if (res?.status === "scheduled") {
        setNotice(`Your plan will change to ${selected.plan_name} on ${fmtDate(res.effective_at)}.`);
      }
      closeModal();
      onChanged?.();
    } catch (err) {
      const blockers = err?.serverDetail?.blockers;
      setActionError(
        blockers?.length
          ? `This change is blocked: ${blockers.map((b) => b.label).join(", ")}.`
          : err?.message || "Could not change your plan. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }, [selected, preview, immediate, trial, navigate, onChanged, closeModal]);

  const cancelPending = useCallback(async () => {
    if (!pendingChange) return;
    setCancelling(true);
    setNotice(null);
    try {
      await platformSelfServiceApi.cancelPlanChange(pendingChange.id);
      invalidateZoikoSubscriptionCache();
      setNotice("Plan change cancelled.");
      onChanged?.();
    } catch (err) {
      setNotice(err?.message || "Could not cancel the plan change.");
    } finally {
      setCancelling(false);
    }
  }, [pendingChange, onChanged]);

  if (plans === null && !pendingChange) return null;

  const isScheduled = pendingChange?.status === "scheduled";
  const isAwaitingPayment = pendingChange?.status === "pending";
  const direction = preview?.direction;
  const blockers = preview?.blockers || [];
  const warnings = preview?.warnings || [];
  const impact = preview?.price_impact;
  // A scheduled downgrade doesn't lock the picker: choosing another plan
  // replaces it server-side (the subscription is still on its current plan).
  const canChoose =
    trial || subscription?.status === "active" || subscription?.status === "scheduled_change" || isScheduled || isAwaitingPayment;
  const scheduledPlanId = isScheduled ? pendingChange.to_plan_id : null;

  return (
    <section className="bg-white rounded-2xl border border-slate-200/80 shadow-xs p-6 space-y-5" aria-label="Change plan">
      <div className="flex items-center gap-2.5">
        <ArrowUpRight className="w-5 h-5 text-[#1A56DB]" />
        <h3 className="font-bold text-slate-900 text-base">{trial ? "Choose a Plan & Pay" : "Change Plan"}</h3>
      </div>

      {notice && (
        <div role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      {isScheduled && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-3 text-sm text-blue-900">
            <CalendarClock className="w-5 h-5 shrink-0 text-[#1A56DB]" />
            <div>
              <p className="font-semibold">Downgrade scheduled</p>
              <p className="text-xs text-blue-700 mt-0.5">
                You'll move to <strong>{pendingChange.to_plan_name}</strong> on {fmtDate(pendingChange.effective_at)}. You keep your current plan until then — or pick a different plan below to change it.
              </p>
            </div>
          </div>
          <button
            onClick={cancelPending}
            disabled={cancelling}
            className="shrink-0 px-3.5 py-2 text-xs font-semibold text-blue-800 bg-white border border-blue-200 rounded-xl hover:bg-blue-100/50 disabled:opacity-50 cursor-pointer"
          >
            {cancelling ? "Cancelling…" : "Keep my current plan"}
          </button>
        </div>
      )}

      {isAwaitingPayment && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-3 text-sm text-amber-900">
            <AlertCircle className="w-5 h-5 shrink-0 text-amber-600" />
            <div>
              <p className="font-semibold">Upgrade to {pendingChange.to_plan_name} awaiting payment</p>
              <p className="text-xs text-amber-800 mt-0.5">
                Pay {money(pendingChange.amount_due, pendingChange.currency)} to switch plans. Nothing changes until the payment clears.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {pendingChange.invoice_public_token && (
              <button
                onClick={() => navigate(`/platform-invoice/${pendingChange.invoice_public_token}/checkout`)}
                className="px-3.5 py-2 text-xs font-semibold text-white bg-[#1A56DB] hover:bg-[#1546B0] rounded-xl cursor-pointer"
              >
                Complete payment
              </button>
            )}
            <button
              onClick={cancelPending}
              disabled={cancelling}
              className="px-3.5 py-2 text-xs font-semibold text-amber-800 bg-white border border-amber-200 rounded-xl hover:bg-amber-100/50 disabled:opacity-50 cursor-pointer"
            >
              {cancelling ? "Cancelling…" : "Cancel upgrade"}
            </button>
          </div>
        </div>
      )}

      {plans && plans.length > 0 && (
        <>
          {!canChoose && (
            <p className="text-xs text-slate-500">Plan changes are available while your subscription is active.</p>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {plans.map((plan) => {
              const price = Number(plan.price_amount);
              const isUpgrade = currentPrice != null && price > currentPrice;
              const isCurrent = plan.is_current && !trial;
              const isScheduledTarget = scheduledPlanId != null && plan.id === scheduledPlanId;
              return (
                <div
                  key={plan.id}
                  className={`rounded-xl border p-4 flex flex-col justify-between gap-4 ${isCurrent ? "border-[#1A56DB] bg-blue-50/40" : "border-slate-200/80 bg-slate-50/50"}`}
                >
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <h4 className="text-sm font-bold text-slate-900">{plan.plan_name}</h4>
                      {isCurrent && (
                        <span className="text-[10px] font-semibold bg-blue-50 text-[#1A56DB] border border-blue-100 rounded-full px-1.5 py-0.5">
                          Current plan
                        </span>
                      )}
                      {isScheduledTarget && (
                        <span className="text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-100 rounded-full px-1.5 py-0.5">
                          Scheduled
                        </span>
                      )}
                    </div>
                    <p className="mt-2 text-2xl font-extrabold text-[#0B192C]">
                      {money(plan.price_amount, plan.currency)}
                      <span className="text-xs font-medium text-slate-400"> / {plan.billing_interval === "annual" ? "year" : "month"}</span>
                    </p>
                    {plan.max_users != null && (
                      <p className="text-xs text-slate-500 mt-1.5">Up to {plan.max_users.toLocaleString("en-US")} team members</p>
                    )}
                  </div>
                  <button
                    disabled={isCurrent || isScheduledTarget || !canChoose}
                    onClick={() => openPlan(plan)}
                    aria-label={
                      trial
                        ? `Pay for ${plan.plan_name}`
                        : isScheduledTarget
                        ? `${plan.plan_name} is already scheduled`
                        : `${isUpgrade ? "Upgrade" : "Downgrade"} to ${plan.plan_name}`
                    }
                    className={`inline-flex items-center justify-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-xl transition disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer ${
                      isUpgrade || trial
                        ? "text-white bg-[#1A56DB] hover:bg-[#1546B0]"
                        : "text-slate-700 bg-white border border-slate-200 hover:bg-slate-50"
                    }`}
                  >
                    {isCurrent ? (
                      <>
                        <Check className="w-3.5 h-3.5" /> Current plan
                      </>
                    ) : isScheduledTarget ? (
                      <>
                        <CalendarClock className="w-3.5 h-3.5" /> Scheduled for {fmtDate(pendingChange.effective_at)}
                      </>
                    ) : trial ? (
                      <>
                        <ShieldCheck className="w-3.5 h-3.5" /> Pay &amp; activate
                      </>
                    ) : isUpgrade ? (
                      <>
                        <ArrowUpRight className="w-3.5 h-3.5" /> Upgrade
                      </>
                    ) : (
                      <>
                        <ArrowDownRight className="w-3.5 h-3.5" /> Downgrade
                      </>
                    )}
                  </button>
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-slate-400">
            Looking for Enterprise or custom terms? Contact your Zoiko representative.
          </p>
        </>
      )}

      {/* Esc / close can't dismiss the dialog while a payment is being submitted. */}
      {selected && (
        <Modal
          open
          onClose={() => { if (!submitting) closeModal(); }}
          closeOnBackdrop={false}
          ariaLabel={`Change to ${selected.plan_name}`}
          title={`${direction === "purchase" ? "Activate" : direction === "downgrade" ? "Downgrade to" : "Upgrade to"} ${selected.plan_name}`}
          size="md"
          footer={
            <>
              <Button variant="secondary" onClick={closeModal}>Not now</Button>
              <button
                onClick={confirm}
                disabled={!preview || submitting}
                className="inline-flex items-center justify-center gap-2 whitespace-nowrap px-5 py-2 text-sm font-semibold text-white bg-gradient-to-r from-[#1A56DB] to-[#0F52BA] rounded-xl max-sm:px-4 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
              >
                {submitting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <ShieldCheck className="w-4 h-4" />
                )}
                <span>
                  {direction === "purchase"
                    ? "Pay & activate"
                    : direction === "upgrade"
                    ? Number(impact?.estimated_period_delta) > 0
                      ? "Pay & upgrade"
                      : "Upgrade now"
                    : immediate
                      ? "Downgrade now"
                      : "Schedule downgrade"}
                </span>
                {!submitting && <ArrowRight className="w-4 h-4" />}
              </button>
            </>
          }
        >
          <div className="space-y-4">

          {previewing && (
            <p className="text-sm text-slate-500 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Checking your plan change…
            </p>
          )}
          {previewError && (
            <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl p-3">
              {previewError}
            </p>
          )}

          {preview && (
            <>
              {direction === "purchase" ? (
                <div className="rounded-xl bg-blue-50 border border-blue-100 p-4 text-sm text-blue-900 space-y-1">
                  <p className="font-semibold">
                    Pay {money(selected.price_amount, selected.currency)} today
                  </p>
                  <p className="text-xs text-blue-700">
                    That's the first {selected.billing_interval === "annual" ? "year" : "month"} of {selected.plan_name}. Your free trial keeps running until the payment clears, then {selected.plan_name} starts straight away with its full limits and renews at {money(selected.price_amount, selected.currency)}.
                  </p>
                </div>
              ) : null}
              {direction !== "purchase" && (
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Current</dt>
                  <dd className="font-semibold text-slate-800">{money(impact?.current_price, impact?.currency)}</dd>
                </div>
                <div>
                  <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">New</dt>
                  <dd className="font-semibold text-slate-800">{money(impact?.target_price, impact?.currency)}</dd>
                </div>
              </dl>
              )}

              {direction === "purchase" ? null : direction === "upgrade" ? (
                <div className="rounded-xl bg-blue-50 border border-blue-100 p-4 text-sm text-blue-900 space-y-1">
                  {impact?.estimated_period_delta != null && Number(impact.estimated_period_delta) > 0 ? (
                    <>
                      <p className="font-semibold">
                        Pay {money(Number(impact.estimated_period_delta).toFixed(2), impact?.currency)} today
                      </p>
                      <p className="text-xs text-blue-700">
                        That's the price difference for the remaining {impact.days_remaining_in_period} day
                        {impact.days_remaining_in_period === 1 ? "" : "s"} of this billing period. Your new plan starts as soon as the payment clears, and renews at {money(impact?.target_price, impact?.currency)}.
                      </p>
                    </>
                  ) : (
                    <p className="font-semibold">No charge today — your new plan starts immediately.</p>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <label className="flex items-start gap-2.5 rounded-xl border border-slate-200 p-3 cursor-pointer text-sm">
                    <input type="radio" name="when" checked={!immediate} onChange={() => setImmediate(false)} className="mt-1" />
                    <span>
                      <span className="font-semibold text-slate-800">At your next renewal (recommended)</span>
                      <span className="block text-xs text-slate-500">
                        Keep everything you have until {fmtDate(preview?.renewal_at || subscription?.current_period_end)}, then move to {selected.plan_name}. No refund or charge.
                      </span>
                    </span>
                  </label>
                  <label className={`flex items-start gap-2.5 rounded-xl border p-3 text-sm ${blockers.length ? "border-slate-100 bg-slate-50 opacity-60" : "border-slate-200 cursor-pointer"}`}>
                    <input
                      type="radio"
                      name="when"
                      checked={immediate}
                      disabled={blockers.length > 0}
                      onChange={() => setImmediate(true)}
                      className="mt-1"
                    />
                    <span>
                      <span className="font-semibold text-slate-800">Right now</span>
                      <span className="block text-xs text-slate-500">
                        Limits drop immediately. The price you've already paid this period isn't refunded.
                      </span>
                    </span>
                  </label>
                </div>
              )}

              {isScheduled && direction !== "purchase" && (
                <p className="rounded-xl border border-blue-100 bg-blue-50 p-3 text-xs text-blue-800">
                  This replaces your scheduled move to <strong>{pendingChange.to_plan_name}</strong>.
                </p>
              )}

              {blockers.length > 0 && (
                <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800 space-y-1">
                  <p className="font-semibold flex items-center gap-1.5">
                    <AlertTriangle className="w-4 h-4" /> Resolve these before switching right now:
                  </p>
                  <ul className="list-disc pl-5 space-y-0.5">
                    {blockers.map((b) => (
                      <li key={b.check_id}>
                        {b.label}: {b.detail}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {warnings.length > 0 && (
                <ul className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 list-disc pl-7 space-y-0.5">
                  {warnings.map((w) => (
                    <li key={w.check_id}>
                      {w.label}: {w.detail}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {actionError && (
            <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl p-3">
              {actionError}
            </p>
          )}

          </div>
        </Modal>
      )}
    </section>
  );
}
