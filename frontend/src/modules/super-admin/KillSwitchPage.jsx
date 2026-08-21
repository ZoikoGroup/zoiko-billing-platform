import React, { useCallback, useEffect, useState } from "react";
import { Power, ShieldAlert } from "lucide-react";
import { getBillingKillSwitch, setBillingKillSwitch } from "../../service/commercialService";
import { PageHeader, Modal, Field, Button } from "../../components/billing-ui";
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

function ToggleModal({ open, onClose, targetEnabled, onSaved }) {
  const [reason, setReason] = useState("");
  const [confirmationText, setConfirmationText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const requiresTypedConfirmation = !targetEnabled;
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
      await onSaved(targetEnabled, reason);
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
      onClose={onClose}
      title={targetEnabled ? "Re-enable commercial charging?" : "Disable commercial charging?"}
      icon={targetEnabled ? Power : ShieldAlert}
      size="sm"
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm text-slate-600">
          {targetEnabled
            ? "This re-enables commercial subscription creation and activation. Existing subscriptions and read access were never affected while disabled."
            : "This immediately blocks NEW commercial subscription creation and activation across the entire platform. It does not cancel, suspend, or delete any existing subscription or data, and read access is unaffected."}
        </p>
        <Field label="Reason" htmlFor="kill-switch-reason" required hint="Required for the audit record.">
          <textarea
            id="kill-switch-reason"
            required
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand-100"
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
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-mono focus:border-red-300 focus:outline-none focus:ring-2 focus:ring-red-100"
            />
          </Field>
        )}
        {error && (
          <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </p>
        )}
        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button
            type="submit"
            variant={targetEnabled ? "primary" : "danger"}
            loading={busy}
            disabled={!reason || !confirmationSatisfied}
          >
            {targetEnabled ? "Re-enable charging" : "Disable charging"}
          </Button>
        </div>
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

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getBillingKillSwitch()
      .then(setSwitchState)
      .catch((e) => setError(e?.message || "Failed to load the billing kill switch."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSave(enabled, reason) {
    const updated = await setBillingKillSwitch(enabled, reason);
    setSwitchState(updated);
    setNotice(enabled ? "Commercial charging re-enabled." : "Commercial charging disabled.");
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Billing Kill Switch"
        description="Real, audited control over the one live commercial-charging path in this platform: subscription creation and activation (ZB-COM-BILL-001 §30.1)."
        icon={Power}
      />

      {notice && <div className="mt-4"><SuccessMessage message={notice} onDismiss={() => setNotice(null)} /></div>}

      <div className="mt-6">
        {loading ? (
          <Spinner />
        ) : error ? (
          <div className="rounded-3xl border border-slate-200 bg-white">
            <ErrorState message={error} onRetry={load} title="Unable to load the kill switch" />
          </div>
        ) : (
          <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-slate-600">Commercial Subscription Charging</p>
                <p className={`mt-1 text-2xl font-extrabold ${switchState.enabled ? "text-emerald-700" : "text-red-600"}`}>
                  {switchState.enabled ? "Enabled" : "Disabled"}
                </p>
                {switchState.reason && (
                  <p className="mt-2 text-sm text-slate-500">Last reason: {switchState.reason}</p>
                )}
                <p className="mt-1 text-xs text-slate-500">
                  Last changed {formatDateTime(switchState.changed_at)}
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
              the Production Acceptance report for what remains unimplemented.
            </p>
          </div>
        )}
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
