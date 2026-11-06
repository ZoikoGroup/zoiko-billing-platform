import { useCallback, useEffect, useId, useState } from "react";
import { KeyRound } from "lucide-react";

import { Button, Field, FORM_CONTROL_CLASS } from "../../components/billing-ui";
import {
  ActionBar, InlineError, MUTED, PANEL, ReasonModal, STRONG, TaxStatusBadge, formatDateTime, humanize,
} from "../tax-control-center/shared";
import { SectionTitle, isOrgAdmin, useTenantNames } from "./common";
import {
  approveMfaReset, cancelMfaReset, disableMfa, getMfaStatus, listMfaUsers, requestMfaReset, startMfa, verifyMfa,
} from "./governanceService";

/* MFA for tax approvals (ZB-TAX-ARCH-001 Phase 5d PR 2). Opt-in TOTP
 * enrolment for tenant users. It is used ONLY for step-up when approving a
 * regime switch, a provider activation, a connection mode change or a
 * provider void; signing in never asks for it. Org admins see who is
 * enrolled and reset a colleague's MFA with a second org admin. */

function Enrol({ onDone }) {
  const base = useId();
  const [setup, setSetup] = useState(null);
  const [codeValue, setCodeValue] = useState("");
  const [codes, setCodes] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const run = async (key, fn) => {
    setBusy(key);
    setError(null);
    try { await fn(); } catch (err) { setError(err?.message || "That didn't work."); } finally { setBusy(null); }
  };
  if (codes) {
    return (
      <div className="space-y-2" role="status">
        <p className={`text-sm font-semibold ${STRONG}`}>MFA is on. Save these recovery codes now; they are shown only once.</p>
        <p className={`text-xs ${MUTED}`}>Each one works once, instead of an authenticator code, if you lose your phone.</p>
        <ul className="grid grid-cols-2 gap-1 font-mono text-sm sm:grid-cols-5" aria-label="Recovery codes">
          {codes.map((c) => <li key={c}>{c}</li>)}
        </ul>
        <Button size="sm" onClick={() => { setCodes(null); onDone(); }}>I've saved them</Button>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <InlineError message={error} />
      {!setup ? (
        <Button size="sm" variant="primary" icon={KeyRound} loading={busy === "start"}
                onClick={() => run("start", async () => setSetup(await startMfa()))}>Set up MFA</Button>
      ) : (
        <>
          <ol className={`list-decimal space-y-1 pl-5 text-sm ${STRONG}`}>
            <li>In your authenticator app, add an account with this key: <code className="break-all font-mono">{setup.secret}</code></li>
            <li>Or open this link on the phone with the app: <a href={setup.otpauth_url} className="break-all text-brand-700 underline dark:text-brand-300">add to authenticator</a></li>
            <li>Enter the 6-digit code the app shows.</li>
          </ol>
          <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault();
            run("verify", async () => { setCodes((await verifyMfa(codeValue.trim())).recovery_codes || []); setSetup(null); setCodeValue(""); }); }}>
            <div className="w-48">
              <Field label="Code from the app" htmlFor={`${base}-code`} required>
                <input id={`${base}-code`} inputMode="numeric" autoComplete="one-time-code" className={FORM_CONTROL_CLASS}
                       value={codeValue} onChange={(e) => setCodeValue(e.target.value)} aria-required="true" />
              </Field>
            </div>
            <Button type="submit" size="sm" variant="primary" loading={busy === "verify"} disabled={!codeValue.trim()}>Turn on MFA</Button>
          </form>
        </>
      )}
    </div>
  );
}

function Disable({ onDone }) {
  const base = useId();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  if (!open) return <Button size="sm" onClick={() => setOpen(true)}>Turn off MFA</Button>;
  return (
    <form className="flex flex-wrap items-end gap-2" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      setError(null);
      try { await disableMfa(password); setPassword(""); setOpen(false); onDone(); }
      catch (err) { setError(err?.message || "Couldn't turn off MFA."); }
      finally { setBusy(false); }
    }}>
      <InlineError message={error} />
      <div className="w-64">
        <Field label="Your current password" htmlFor={`${base}-pw`} required hint="You won't be able to approve until you set it up again.">
          <input id={`${base}-pw`} type="password" autoComplete="current-password" className={FORM_CONTROL_CLASS}
                 value={password} onChange={(e) => setPassword(e.target.value)} aria-required="true" />
        </Field>
      </div>
      <Button type="submit" size="sm" loading={busy} disabled={!password}>Turn off</Button>
      <Button size="sm" onClick={() => { setOpen(false); setPassword(""); }}>Cancel</Button>
    </form>
  );
}

function OrgEnrolment({ user }) {
  const nameOf = useTenantNames();
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [resetFor, setResetFor] = useState(null);
  const load = useCallback(() => {
    listMfaUsers().then((d) => setItems(d.items || [])).catch((err) => setError(err?.message || "Couldn't load MFA status."));
  }, []);
  useEffect(() => { load(); }, [load]);
  const act = async (key, fn) => {
    setBusy(key);
    setError(null);
    try { await fn(); load(); } catch (err) { setError(err?.message || "The action failed."); } finally { setBusy(null); }
  };
  return (
    <div className="space-y-2">
      <h3 className={`text-sm font-bold ${STRONG}`}>Who can approve with MFA</h3>
      <InlineError message={error} />
      {items && (
        <ul className="space-y-2">
          {items.map((u) => {
            const self = u.user_id === user?.id;
            const mine = u.reset_requested_by === user?.id;
            return (
              <li key={u.user_id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className={`text-sm font-semibold ${STRONG}`}>{u.name} ({humanize(u.role)})</span>
                  <TaxStatusBadge status={u.enrolled ? "MFA_ENROLLED" : "MFA_NOT_ENROLLED"} />
                </div>
                {u.reset_requested_by && (
                  <p className="text-xs text-amber-900 dark:text-amber-200">
                    Reset requested by {nameOf(u.reset_requested_by)} · {formatDateTime(u.reset_requested_at)}. A different org admin must approve it.
                  </p>
                )}
                <div className="mt-2">
                  <ActionBar busyKey={busy} actions={[
                    { key: `reset-${u.user_id}`, label: "Request MFA reset", hidden: !u.enrolled || Boolean(u.reset_requested_by),
                      reason: self ? "You can't reset your own MFA; ask another organization admin." : null,
                      onClick: () => setResetFor(u) },
                    { key: `approve-${u.user_id}`, label: "Approve MFA reset", variant: "primary", hidden: !u.reset_requested_by,
                      reason: mine ? "You requested this reset; a different organization admin must approve it."
                        : self ? "You can't approve a reset of your own MFA." : null,
                      onClick: () => act(`approve-${u.user_id}`, () => approveMfaReset(u.user_id)) },
                    { key: `cancel-${u.user_id}`, label: "Cancel reset", hidden: !u.reset_requested_by,
                      onClick: () => act(`cancel-${u.user_id}`, () => cancelMfaReset(u.user_id)) },
                  ]} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <ReasonModal open={Boolean(resetFor)} title={resetFor ? `Reset MFA for ${resetFor.name}` : ""} submitLabel="Request reset"
                   busy={false} error={null} minLength={3}
                   description="For a lost phone with no recovery codes. A different organization admin must approve; then they set MFA up again."
                   onCancel={() => setResetFor(null)}
                   onSubmit={(reason) => { const u = resetFor; setResetFor(null); act(`reset-${u.user_id}`, () => requestMfaReset(u.user_id, reason)); }} />
    </div>
  );
}

export function MfaScreen({ user }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => {
    getMfaStatus().then(setStatus).catch((err) => setError(err?.message || "Couldn't load your MFA status."));
  }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <section className={`${PANEL} space-y-5`} aria-labelledby="mfa-title">
      <SectionTitle id="mfa-title" title="MFA for approvals">
        Approving a regime switch, a provider activation, a connection mode change or a provider void asks for a code
        from an authenticator app. Signing in doesn't change.
      </SectionTitle>
      <InlineError message={error} />
      {status && (
        <div className="space-y-3">
          <p className={`flex flex-wrap items-center gap-2 text-sm ${STRONG}`}>
            Your MFA: <TaxStatusBadge status={status.enrolled ? "MFA_ENROLLED" : "MFA_NOT_ENROLLED"} />
            {!status.tax_tenant_step_up_required && <span className={MUTED}>(step-up is currently off for tax approvals)</span>}
          </p>
          {status.enrolled ? <Disable onDone={load} /> : <Enrol onDone={load} />}
        </div>
      )}
      {isOrgAdmin(user?.role) && <OrgEnrolment user={user} />}
    </section>
  );
}
