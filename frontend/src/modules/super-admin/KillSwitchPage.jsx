import React, { useCallback, useEffect, useRef, useState } from "react";
import { Clock, Power, RefreshCw, ShieldAlert } from "lucide-react";
import { getBillingKillSwitch, setBillingKillSwitch } from "../../service/commercialService";
import { PageHeader, Modal, Field, Button, FORM_CONTROL_CLASS } from "../../components/billing-ui";
import { ErrorState, Spinner, SuccessMessage } from "../../components/billing-shared";
import useIsDesktopViewport from "../../hooks/useIsDesktopViewport";
import MobileWriteBlock from "./MobileWriteBlock";
import { formatDateTime } from "./constants";

// Disabling commercial charging is the high-impact direction (it blocks new
// revenue-generating subscription activity platform-wide) — Section 23 of
// the enterprise hardening pass requires typed confirmation for
// destructive/high-impact Super Admin operations, matching the pattern
// already used for org hard-delete.
const DISABLE_CONFIRMATION_PHRASE = "DISABLE CHARGING";

// Mirrors DEFAULT_AUTO_EXPIRE_MINUTES in kill_switch_service.py: this
// endpoint never sends a window, so every disable auto-lifts after 8 hours.
const DEFAULT_PAUSE_HOURS = 8;
const REASON_MAX_LENGTH = 1000; // BillingKillSwitchUpdate.reason max_length

// The API serializes naive UTC datetimes (no "Z"); read them as UTC so the
// times shown here aren't shifted by the viewer's UTC offset.
function parseServerDate(value) {
  if (!value) return null;
  const text = String(value);
  return new Date(/([zZ]|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text}Z`);
}

const SUCCESS_NOTICE_MS = 6000;

function ToggleModal({ open, onClose, targetEnabled, onSaved }) {
  const [reason, setReason] = useState("");
  const [confirmationText, setConfirmationText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const requiresTypedConfirmation = !targetEnabled;
  const trimmedReason = reason.trim();
  const confirmationSatisfied = !requiresTypedConfirmation || confirmationText === DISABLE_CONFIRMATION_PHRASE;

  useEffect(() => {
    if (open) {
      setReason("");
      setConfirmationText("");
      setError(null);
    }
  }, [open]);

  async function handleSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSaved(targetEnabled, trimmedReason);
      onClose();
    } catch (err) {
      setError(err?.message || "Failed to update the kill switch.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title={targetEnabled ? "Re-enable commercial charging?" : "Disable commercial charging?"}
      icon={targetEnabled ? Power : ShieldAlert}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            type="submit" form="kill-switch-form"
            variant={targetEnabled ? "primary" : "danger"}
            loading={busy}
            disabled={!trimmedReason || !confirmationSatisfied}
          >
            {targetEnabled ? "Re-enable charging" : "Disable charging"}
          </Button>
        </>
      }
    >
      <form id="kill-switch-form" onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm text-slate-600">
          {targetEnabled
            ? "This re-enables commercial subscription creation and activation. Existing subscriptions and read access were never affected while disabled."
            : `This immediately blocks NEW commercial subscription creation and activation across the entire platform. It does not cancel, suspend, or delete any existing subscription or data, and read access is unaffected. The pause lifts automatically after ${DEFAULT_PAUSE_HOURS} hours unless you re-enable charging sooner.`}
        </p>
        <Field label="Reason" htmlFor="kill-switch-reason" required hint="Required for the audit record.">
          <textarea
            id="kill-switch-reason"
            required
            rows={3}
            maxLength={REASON_MAX_LENGTH}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className={FORM_CONTROL_CLASS}
          />
        </Field>
        {requiresTypedConfirmation && (
          <Field
            label={`Type "${DISABLE_CONFIRMATION_PHRASE}" to confirm`}
            htmlFor="kill-switch-confirm"
            required
            hint="This blocks all new commercial subscription creation and activation platform-wide."
          >
            <input
              id="kill-switch-confirm"
              type="text"
              required
              autoComplete="off"
              value={confirmationText}
              onChange={(e) => setConfirmationText(e.target.value)}
              placeholder={DISABLE_CONFIRMATION_PHRASE}
              className={`${FORM_CONTROL_CLASS} font-mono`}
            />
          </Field>
        )}
        {error && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

export default function KillSwitchPage() {
  const [switchState, setSwitchState] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [modalTarget, setModalTarget] = useState(null); // true | false | null
  // ZB-SA-CMD-003 §17 — breaker engagement is blocked below 768px.
  const isDesktop = useIsDesktopViewport();
  const seqRef = useRef(0);

  const load = useCallback(() => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    getBillingKillSwitch()
      .then((res) => {
        if (seq === seqRef.current) setSwitchState(res);
      })
      .catch((e) => {
        if (seq === seqRef.current) setError(e?.message || "Failed to load the billing kill switch.");
      })
      .finally(() => {
        if (seq === seqRef.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), SUCCESS_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  async function handleSave(enabled, reason) {
    const updated = await setBillingKillSwitch(enabled, reason);
    // Invalidate any in-flight GET so it can't overwrite the fresh state.
    seqRef.current += 1;
    setLoading(false);
    setError(null);
    setSwitchState(updated);
    setNotice(enabled ? "Commercial charging re-enabled." : "Commercial charging disabled.");
  }

  const expiresAt = switchState && !switchState.enabled ? parseServerDate(switchState.expires_at) : null;
  const expiryPassed = expiresAt ? expiresAt.getTime() <= Date.now() : false;

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Billing Kill Switch"
        description="Pause or resume the one live commercial-charging path in this platform: new platform subscription creation and activation. Every change is audited (ZB-COM-BILL-001 §30.1)."
        icon={Power}
        actions={
          <Button variant="secondary" icon={RefreshCw} onClick={() => load()} disabled={loading}>
            Refresh
          </Button>
        }
      />

      {notice && <div className="mt-4"><SuccessMessage message={notice} onDismiss={() => setNotice(null)} /></div>}

      <div className="mt-6">
        {loading && !switchState ? (
          <Spinner />
        ) : error && !switchState ? (
          <div className="rounded-3xl border border-slate-200 bg-white">
            <ErrorState message={error} onRetry={() => load()} title="Unable to load the kill switch" />
          </div>
        ) : switchState ? (
          <div className="space-y-4">
            {error && (
              <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
                Couldn't refresh: {error} Showing the last loaded state.
              </p>
            )}
            <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-slate-600">Commercial Subscription Charging</p>
                  <p className={`mt-1 text-2xl font-extrabold ${switchState.enabled ? "text-emerald-700" : "text-red-600"}`}>
                    {switchState.enabled ? "Enabled" : "Disabled"}
                  </p>
                  {expiresAt && (
                    <p className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800">
                      <Clock size={13} />
                      {expiryPassed
                        ? `Pause window ended ${formatDateTime(expiresAt)} — it lifts automatically on the next billing action.`
                        : `Pause lifts automatically at ${formatDateTime(expiresAt)}`}
                    </p>
                  )}
                  {switchState.reason && (
                    <p className="mt-2 text-sm text-slate-500">Last reason: {switchState.reason}</p>
                  )}
                  <p className="mt-1 text-xs text-slate-500">
                    Last changed {formatDateTime(parseServerDate(switchState.changed_at))}
                    {switchState.changed_by_email ? ` by ${switchState.changed_by_email}` : ""}
                  </p>
                </div>
                {isDesktop ? (
                  <Button
                    variant={switchState.enabled ? "danger" : "primary"}
                    icon={switchState.enabled ? ShieldAlert : Power}
                    onClick={() => setModalTarget(!switchState.enabled)}
                  >
                    {switchState.enabled ? "Disable charging" : "Re-enable charging"}
                  </Button>
                ) : (
                  <MobileWriteBlock action="toggling the billing kill switch" />
                )}
              </div>
              <p className="mt-6 text-xs text-slate-500">
                This switch is scoped to the one real charging path that exists today. It does not (and cannot) gate a
                tenant payment webhook or a Plane-1 payment processor, because neither exists yet in this codebase — see
                the Production Acceptance report for what remains unimplemented. The other billing circuit breakers are
                listed on the Triage & Attention page.
              </p>
            </div>
          </div>
        ) : null}
      </div>

      <ToggleModal
        open={modalTarget !== null && isDesktop}
        targetEnabled={modalTarget}
        onClose={() => setModalTarget(null)}
        onSaved={handleSave}
      />
    </div>
  );
}
