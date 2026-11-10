import { useEffect, useId, useState } from "react";
import { CalendarClock } from "lucide-react";

import { Button, Field, FORM_CONTROL_CLASS, FormGrid, FormModal } from "../../components/billing-ui";
import { canApproveTaxRegistry, canWriteTaxRegistry } from "./access";
import { cancelScheduledActivation, decideActivationCancellation } from "./taxRegistryService";
import { InlineError, MUTED, ReasonModal, STRONG, formatDateTime, usePeopleNames } from "./shared";

/* Phase 8 PR 2: scheduled activation. A version can be published now or
 * scheduled at jurisdiction-local legal time; the server converts it to UTC
 * (refusing DST gaps, asking for the offset in DST overlaps). Cancelling a
 * scheduled activation takes two people: a proposal, then a different
 * TAX_PUBLISHER approves with MFA. */

function offsetMinutes(date, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(date).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** Best-effort preview of local time in a zone as UTC; the server is authoritative. */
export function previewUtc(local, timeZone) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local || "");
  if (!match || !timeZone) return null;
  try {
    const wall = Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5]);
    let utc = wall - offsetMinutes(new Date(wall), timeZone) * 60000;
    utc = wall - offsetMinutes(new Date(utc), timeZone) * 60000;
    return new Date(utc).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  } catch {
    return null;
  }
}

export function PublishModal({ open, version, noun, busy, error, onCancel, onSubmit }) {
  const base = useId();
  const [mode, setMode] = useState("now");
  const [local, setLocal] = useState("");
  const [zone, setZone] = useState("");
  const [offset, setOffset] = useState("");
  useEffect(() => {
    if (open) { setMode("now"); setLocal(""); setOffset(""); setZone(version?.default_timezone || ""); }
  }, [open, version]);
  const preview = mode === "schedule" ? previewUtc(local, zone) : null;
  const submit = () => onSubmit(mode === "now" ? {} : {
    activate_at_local: local, timezone: zone || undefined, ...(offset ? { utc_offset: offset } : {}),
  });
  return (
    <FormModal open={open} onClose={onCancel} onSubmit={submit} busy={busy} error={error} title={`Publish this ${noun}`}
               submitLabel={mode === "now" ? "Publish now" : "Schedule"}
               description="Publishing needs MFA. A scheduled version activates at that local time, after its checks run again.">
      <fieldset className="space-y-2">
        <legend className={`text-sm font-semibold ${STRONG}`}>When</legend>
        {[["now", "Publish now"], ["schedule", "Schedule at a local date and time"]].map(([value, label]) => (
          <label key={value} className={`flex items-center gap-2 text-sm ${STRONG}`}>
            <input type="radio" name={`${base}-when`} value={value} checked={mode === value} onChange={() => setMode(value)} />
            {label}
          </label>
        ))}
      </fieldset>
      {mode === "schedule" && (
        <>
          <FormGrid>
            <Field label="Local date and time" htmlFor={`${base}-local`} required>
              <input id={`${base}-local`} type="datetime-local" required className={FORM_CONTROL_CLASS} value={local}
                     onChange={(e) => setLocal(e.target.value)} />
            </Field>
            <Field label="Time zone (IANA)" htmlFor={`${base}-zone`} required={!version?.default_timezone}>
              <input id={`${base}-zone`} className={FORM_CONTROL_CLASS} value={zone} placeholder="Europe/London"
                     required={!version?.default_timezone} onChange={(e) => setZone(e.target.value)} />
            </Field>
          </FormGrid>
          <Field label="UTC offset (only when the time happens twice, as clocks go back)" htmlFor={`${base}-offset`}>
            <input id={`${base}-offset`} className={FORM_CONTROL_CLASS} value={offset} placeholder="+01:00" maxLength={6}
                   onChange={(e) => setOffset(e.target.value)} />
          </Field>
          <p className={`text-sm ${MUTED}`} aria-live="polite">
            {preview ? <>About <strong className={STRONG}>{preview}</strong>; the server confirms the exact time.</>
              : "Enter a date, time and zone to see the UTC time."}
          </p>
        </>
      )}
    </FormModal>
  );
}

export function ScheduleInfo({ version }) {
  if (!version?.activate_at && !version?.activation_error) return null;
  return (
    <div className="space-y-2">
      {version.activate_at && (
        <p className={`flex items-center gap-1.5 text-sm ${STRONG}`}>
          <CalendarClock size={15} aria-hidden="true" />
          {version.status === "SCHEDULED" ? "Activates" : "Scheduled for"} {version.activate_at_local} ({version.activate_tz})
          {" "}= {formatDateTime(version.activate_at)}
        </p>
      )}
      {version.activation_error && version.status === "SCHEDULED" && (
        <div role="alert" className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100">
          <strong>The activation checks failed, so it hasn't activated:</strong> {version.activation_error}
        </div>
      )}
    </div>
  );
}

export function CancelSchedule({ version, kind, user, stepUp, onChanged }) {
  const nameOf = usePeopleNames();
  const [asking, setAsking] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const pending = version.pending_cancellation;
  const publisher = canApproveTaxRegistry(user?.platform_role);
  const submitter = canWriteTaxRegistry(user?.platform_role) && user?.id === version.maker_user_id;
  if (version.status !== "SCHEDULED") return null;

  // The detail stays open: the version is updated from the cancellation's outcome.
  const unscheduled = { status: "APPROVED", activate_at: null, activate_at_local: null, activate_tz: null,
                        activation_error: null, scheduled_by_user_id: null };
  const run = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      const c = await fn();
      if (!c) return;
      if (c.status === "PROPOSED") onChanged({ ...version, pending_cancellation: c });
      else if (c.status === "APPROVED") onChanged({ ...version, ...unscheduled, pending_cancellation: null });
      else onChanged({ ...version, pending_cancellation: null });
    } catch (err) {
      setError(err?.message || "The action failed.");
    } finally {
      setBusy(false);
    }
  };
  const onReason = (reason) => {
    const action = asking;
    setAsking(null);
    if (action === "propose") run(() => cancelScheduledActivation(kind, version.id, reason));
    else run(() => decideActivationCancellation(pending.id, false, { reason }));
  };

  return (
    <div className="space-y-2">
      <InlineError message={error} />
      {pending ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          <p><strong>Cancellation proposed</strong> by {nameOf(pending.proposed_by)}: {pending.reason}</p>
          {publisher && user?.id !== pending.proposed_by ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="primary" loading={busy}
                      onClick={() => run(() => stepUp.run((body) => decideActivationCancellation(pending.id, true, body)))}>
                Approve cancellation
              </Button>
              <Button size="sm" disabled={busy} onClick={() => setAsking("reject")}>Reject cancellation</Button>
            </div>
          ) : (
            <p className="mt-1 text-xs">A different TAX_PUBLISHER must decide it.</p>
          )}
        </div>
      ) : (publisher || submitter) && (
        <Button size="sm" loading={busy} onClick={() => setAsking("propose")}>Cancel scheduled activation</Button>
      )}
      <ReasonModal open={Boolean(asking)} busy={false} error={null} minLength={3}
                   title={asking === "reject" ? "Reject the cancellation" : "Propose cancelling this activation"}
                   description={asking === "reject" ? "The activation stays scheduled."
                     : "A different TAX_PUBLISHER must approve, with MFA. The version then returns to Approved."}
                   submitLabel={asking === "reject" ? "Reject" : "Propose"} onCancel={() => setAsking(null)}
                   onSubmit={onReason} />
    </div>
  );
}
