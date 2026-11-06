import { useId, useState } from "react";
import { KeyRound, Plus } from "lucide-react";

import { Button, Field, FORM_CONTROL_CLASS, FormModal, FormGrid, Select } from "../../components/billing-ui";
import {
  ActionBar, InlineError, LoadMore, MUTED, PANEL, ReasonModal, STRONG, TaxStatusBadge, formatAge, formatDateTime,
  humanize, useCursorList, useReferenceList, useStepUp,
} from "../tax-control-center/shared";
import {
  DecisionBar, EntitySelect, SectionTitle, TenantEvidenceExport, canDecide, canPropose, useLegalEntities, useTenantNames,
} from "./common";
import {
  decideModeChange, decideProviderConnection, listProviderConnections, listProviderTransactions, listProviders,
  proposeProviderConnection, providerConnectionAction, providerTransactionAction, requestModeChange,
  revokeProviderCredentials, setProviderCredentials, withdrawModeChange, withdrawProviderConnection,
} from "./governanceService";

/* Provider Connections and the stuck-transaction view (Phase 5c PR 2).
 * Tenant data only. Credentials are write-only: the screen sends a secret
 * once and never shows one (the API returns only whether one is set and its
 * masked last four). Every change is two-person where the backend says so. */

// ── Provider Connections ────────────────────────────────────────────────

function ProposeConnectionModal({ open, entities, onClose, onDone }) {
  const base = useId();
  const providers = useReferenceList(() => listProviders(), open);
  const [form, setForm] = useState({ mode: "ESTIMATE_ONLY", environment: "SANDBOX" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));
  const provider = providers.find((p) => p.name === form.provider_name);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await proposeProviderConnection({ seller_entity_id: Number(form.seller_entity_id),
        provider_name: form.provider_name, environment: form.environment, mode: form.mode }));
      setForm({ mode: "ESTIMATE_ONLY", environment: "SANDBOX" });
    } catch (err) {
      setError(err?.message || "Couldn't propose the connection.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormModal open={open} onClose={onClose} onSubmit={submit} busy={busy} error={error} icon={Plus}
               title="Propose a provider connection" submitLabel="Propose" size="lg"
               description="Choose a provider Zoiko supports; its address is fixed by Zoiko, never entered here. A different finance approver approves it.">
      <FormGrid>
        <Field label="Seller entity" htmlFor={`${base}-e`} required>
          <Select id={`${base}-e`} value={form.seller_entity_id ?? ""} onChange={set("seller_entity_id")} required placeholder="Choose…"
                  options={entities.map((e) => ({ value: e.id, label: `${e.entity_code} — ${e.legal_name}` }))} />
        </Field>
        <Field label="Provider" htmlFor={`${base}-p`} required
               hint={providers.length ? undefined : "No provider is available yet. Zoiko adds providers once contracted."}>
          <Select id={`${base}-p`} value={form.provider_name ?? ""} onChange={set("provider_name")} required placeholder="Choose…"
                  options={providers.map((p) => ({ value: p.name, label: p.name }))} />
        </Field>
        <Field label="Environment" htmlFor={`${base}-env`} required>
          <Select id={`${base}-env`} value={form.environment} onChange={set("environment")} required placeholder=""
                  options={(provider?.environments || ["SANDBOX"]).map((e) => ({ value: e, label: humanize(e) }))} />
        </Field>
        <Field label="Mode" htmlFor={`${base}-m`} required
               hint="Safe mode quotes tax but can never issue an invoice through the provider.">
          <Select id={`${base}-m`} value={form.mode} onChange={set("mode")} required placeholder=""
                  options={[{ value: "ESTIMATE_ONLY", label: "Safe mode: estimate only" },
                            { value: "COMMIT", label: "Commit: issue invoices through the provider" }]} />
        </Field>
      </FormGrid>
    </FormModal>
  );
}

/** Write-only: the value lives only in this input until it is sent, then it is cleared. */
function CredentialModal({ open, connection, onClose, onDone }) {
  const inputId = useId();
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const rotating = Boolean(connection?.credentials?.present);
  const close = () => { setSecret(""); setError(null); onClose(); };
  const submit = async () => {
    if (secret.trim().length < 8) { setError("The credential must be at least 8 characters."); return; }
    setBusy(true);
    setError(null);
    try {
      const updated = await setProviderCredentials(connection.id, secret);
      setSecret("");
      onDone(updated);
    } catch (err) {
      setError(err?.message || "Couldn't save the credential.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormModal open={open} onClose={close} onSubmit={submit} busy={busy} error={error} icon={KeyRound}
               title={rotating ? "Rotate the credential" : "Set the credential"} submitLabel="Save credential"
               description="Stored encrypted and never shown again, to anyone. After a rotation, run Test connection.">
      <Field label="API credential" htmlFor={inputId} required hint="Paste it from the provider's console. It is not displayed after saving.">
        <input id={inputId} type="password" autoComplete="off" spellCheck={false} className={FORM_CONTROL_CLASS}
               value={secret} onChange={(e) => setSecret(e.target.value)} aria-required="true" />
      </Field>
    </FormModal>
  );
}

function ConnectionHealth({ health }) {
  const status = health?.checked_at ? (health.ok ? "HEALTHY" : "UNHEALTHY") : "UNCHECKED";
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <TaxStatusBadge status={status} />
      {health?.checked_at && <span className={`text-xs ${MUTED}`}>checked {formatDateTime(health.checked_at)}{health.detail ? ` · ${health.detail}` : ""}</span>}
    </span>
  );
}

const MODE_LABEL = { ESTIMATE_ONLY: "safe mode (estimate only)", COMMIT: "commit (issue invoices)" };

/** Why estimate-only -> commit can't be proposed yet, or null (mirrors the backend's gates). */
export function goLiveProblem(c) {
  if (c.status !== "APPROVED") return "Only an approved connection can go live.";
  if (!c.credentials?.present) return "Set a credential first.";
  if (c.credentials?.rotation_pending_test) return "A credential rotation is waiting for a successful test.";
  const checked = c.health?.checked_at ? new Date(c.health.checked_at) : null;
  const rotated = c.credentials?.last_rotated_at ? new Date(c.credentials.last_rotated_at) : null;
  if (!c.health?.ok || !checked || (rotated && checked < rotated)) return "Run Test connection with the current credential first.";
  return null;
}

/**
 * Safe mode <-> commit on the same connection and credentials: proposed by a
 * billing admin, approved by a different finance approver with MFA step-up.
 */
function ModeChange({ c, user, nameOf, onChanged }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [asking, setAsking] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const stepUp = useStepUp();
  const billing = canPropose(user?.role);
  const finance = canDecide(user?.role);
  const pending = c.mode_change;
  const target = c.mode === "COMMIT" ? "ESTIMATE_ONLY" : "COMMIT";
  const live = ["APPROVED", "SUSPENDED"].includes(c.status);
  const act = async (key, fn) => {
    setBusy(key);
    setError(null);
    try { const r = await fn(); if (r) onChanged(r); }
    catch (err) { setError(err?.message || "The action failed."); }
    finally { setBusy(null); }
  };
  if (!live && !pending) return null;
  const mine = pending && pending.requested_by === user?.id;
  return (
    <div className="mt-2 space-y-1">
      {pending && (
        <p className="text-xs text-amber-900 dark:text-amber-200" role="status">
          Change to {MODE_LABEL[pending.to] || humanize(pending.to)} requested by {nameOf(pending.requested_by)}
          {pending.reason ? `: ${pending.reason}` : ""}. A different finance approver must approve it, with MFA.
        </p>
      )}
      {c.mode_changed_by && !pending && (
        <p className={`text-xs ${MUTED}`}>Mode last changed by {nameOf(c.mode_changed_by)} · {formatDateTime(c.mode_changed_at)}</p>
      )}
      <InlineError message={error} />
      <ActionBar busyKey={busy} actions={[
        { key: `mode-${c.id}`, label: target === "COMMIT" ? "Propose go-live (commit)" : "Propose safe mode",
          hidden: !billing || !live || Boolean(pending),
          reason: target === "COMMIT" ? goLiveProblem(c) : null, onClick: () => setAsking(true) },
        { key: `mode-approve-${c.id}`, label: "Approve mode change", variant: "primary", hidden: !finance || !pending,
          reason: mine ? "You requested this change; a different finance approver must approve it." : null,
          onClick: () => act(`mode-approve-${c.id}`, () => stepUp.run((body) => decideModeChange(c.id, true, body))) },
        { key: `mode-reject-${c.id}`, label: "Reject mode change", hidden: !finance || !pending,
          reason: mine ? "You requested this change; a different finance approver must decide it." : null,
          onClick: () => setRejecting(true) },
        { key: `mode-withdraw-${c.id}`, label: "Withdraw mode change", hidden: !billing || !pending,
          onClick: () => act(`mode-withdraw-${c.id}`, () => withdrawModeChange(c.id)) },
      ]} />
      <ReasonModal open={asking} minLength={3} busy={false} error={null}
                   title={target === "COMMIT" ? "Propose going live (commit mode)" : "Propose safe mode (estimate only)"}
                   description={target === "COMMIT"
                     ? "After approval, invoices for this entity are issued through the provider. Same connection and credential."
                     : "After approval, new invoices can't be issued through the provider; ones already in progress finish as they are."}
                   submitLabel="Propose" onCancel={() => setAsking(false)}
                   onSubmit={(reason) => { setAsking(false); act(`mode-${c.id}`, () => requestModeChange(c.id, target, reason)); }} />
      <ReasonModal open={rejecting} title="Reject this mode change" submitLabel="Reject" busy={false} error={null}
                   onCancel={() => setRejecting(false)}
                   onSubmit={(reason) => { setRejecting(false);
                     act(`mode-reject-${c.id}`, () => decideModeChange(c.id, false, { reason })); }} />
      {stepUp.modal}
    </div>
  );
}

function ConnectionCard({ c, user, nameOf, onChanged, onCredential }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [revoking, setRevoking] = useState(false);
  const [rejectingResume, setRejectingResume] = useState(false);
  const billing = canPropose(user?.role);
  const finance = canDecide(user?.role);
  const live = !["REJECTED", "WITHDRAWN"].includes(c.status);
  const creds = c.credentials || {};
  const act = async (key, fn) => {
    setBusy(key);
    setError(null);
    try { const r = await fn(); if (r) onChanged(r); }
    catch (err) { setError(err?.message || "The action failed."); }
    finally { setBusy(null); }
  };
  const resumeBlocked = c.resume_requested_by === user?.id
    ? "You asked to resume this connection; a different finance approver must approve it." : null;
  return (
    <li className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={`text-sm font-semibold ${STRONG}`}>{c.provider_name} · {humanize(c.environment)}</span>
        <span className="flex flex-wrap gap-1"><TaxStatusBadge status={c.mode} /><TaxStatusBadge status={c.status} /></span>
      </div>
      <dl className={`mt-2 grid grid-cols-1 gap-1 text-xs sm:grid-cols-2 ${MUTED}`}>
        <div><dt className="inline font-semibold">Health: </dt><dd className="inline"><ConnectionHealth health={c.health} /></dd></div>
        <div>
          <dt className="inline font-semibold">Credential: </dt>
          <dd className="inline">
            {creds.present ? `set, ending ••••${creds.last4 || ""}${creds.last_rotated_at ? ` · rotated ${formatDateTime(creds.last_rotated_at)}` : ""}` : "not set"}
          </dd>
        </div>
        <div><dt className="inline font-semibold">Proposed by: </dt><dd className="inline">{nameOf(c.proposed_by)}</dd></div>
        {c.approved_by && <div><dt className="inline font-semibold">Decided by: </dt><dd className="inline">{nameOf(c.approved_by)}</dd></div>}
      </dl>
      {creds.rotation_pending_test && (
        <p className="mt-2 text-xs text-amber-900 dark:text-amber-200">
          Rotation pending a test: the previous credential is kept until Test connection passes.
        </p>
      )}
      {c.status === "SUSPENDED" && (
        <p className="mt-2 text-xs text-red-800 dark:text-red-200">
          Suspended{c.suspended_reason ? `: ${c.suspended_reason}` : ""}. Quotes and issuing through this connection stop until
          it is resumed by two people.{c.resume_requested_by ? ` Resume requested by ${nameOf(c.resume_requested_by)}.` : ""}
        </p>
      )}
      <InlineError message={error} />
      <div className="mt-2">
        <ActionBar busyKey={busy} actions={[
          { key: `test-${c.id}`, label: "Test connection", hidden: !billing || !live,
            reason: creds.present ? null : "Set a credential first.",
            onClick: () => act(`test-${c.id}`, () => providerConnectionAction(c.id, "test")) },
          { key: `cred-${c.id}`, label: creds.present ? "Rotate credential" : "Set credential", hidden: !billing || !live,
            onClick: () => onCredential(c) },
          { key: `revoke-${c.id}`, label: "Revoke credential", hidden: !billing || !creds.present,
            onClick: () => setRevoking(true) },
          { key: `resume-${c.id}`, label: "Ask to resume", hidden: !billing || c.status !== "SUSPENDED" || c.resume_requested_by,
            reason: creds.present ? null : "Set a new credential first.",
            onClick: () => act(`resume-${c.id}`, () => providerConnectionAction(c.id, "resume")) },
          { key: `resume-approve-${c.id}`, label: "Approve resume", variant: "primary",
            hidden: !finance || c.status !== "SUSPENDED" || !c.resume_requested_by, reason: resumeBlocked,
            onClick: () => act(`resume-approve-${c.id}`, () => providerConnectionAction(c.id, "resume-approve")) },
          { key: `resume-reject-${c.id}`, label: "Reject resume",
            hidden: !finance || c.status !== "SUSPENDED" || !c.resume_requested_by, reason: resumeBlocked,
            onClick: () => setRejectingResume(true) },
        ]} />
      </div>
      <DecisionBar user={user} record={c} proposerId={c.proposed_by} noun="provider connection"
                   decide={decideProviderConnection} withdraw={withdrawProviderConnection} onDone={onChanged} />
      <ModeChange c={c} user={user} nameOf={nameOf} onChanged={onChanged} />
      <TenantEvidenceExport user={user} kind="provider_connection" id={c.id} />
      <ReasonModal open={revoking} title="Revoke the credential" submitLabel="Revoke" busy={false} error={null}
                   description="The stored credential is destroyed and the connection is suspended at once. Resuming needs a new credential and two people."
                   onCancel={() => setRevoking(false)}
                   onSubmit={(reason) => { setRevoking(false); act(`revoke-${c.id}`, () => revokeProviderCredentials(c.id, reason)); }} />
      <ReasonModal open={rejectingResume} title="Reject resuming this connection" submitLabel="Reject" busy={false} error={null}
                   onCancel={() => setRejectingResume(false)}
                   onSubmit={(reason) => { setRejectingResume(false);
                     act(`resume-reject-${c.id}`, () => providerConnectionAction(c.id, "resume-reject", { reason })); }} />
    </li>
  );
}

export function ProviderConnectionsScreen({ user }) {
  const { entities } = useLegalEntities();
  const [entityId, setEntityId] = useState("");
  const [reload, setReload] = useState(0);
  const list = useCursorList(({ cursor }) => listProviderConnections({ seller_entity_id: entityId || undefined, cursor }), [entityId, reload]);
  const [proposing, setProposing] = useState(false);
  const [credentialFor, setCredentialFor] = useState(null);
  const nameOf = useTenantNames();
  const refresh = () => setReload((n) => n + 1);
  return (
    <section className={PANEL} aria-labelledby="conn-title">
      <SectionTitle id="conn-title" title="Provider connections">
        A seller entity's connection to a tax provider. Proposed by a billing admin, approved by a different finance
        approver. Credentials are write-only and never shown.
      </SectionTitle>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <div className="w-72"><EntitySelect entities={entities} value={entityId} onChange={setEntityId} /></div>
        {canPropose(user?.role) && <Button variant="primary" size="sm" icon={Plus} onClick={() => setProposing(true)}>Propose connection</Button>}
      </div>
      <InlineError message={list.error} />
      {!list.loading && !list.items.length && !list.error && <p className={`text-sm ${MUTED}`}>No provider connections yet.</p>}
      <ul className="space-y-2">
        {list.items.map((c) => (
          <ConnectionCard key={c.id} c={c} user={user} nameOf={nameOf} onChanged={refresh} onCredential={setCredentialFor} />
        ))}
      </ul>
      <LoadMore list={list} noun="connections" />
      <ProposeConnectionModal open={proposing} entities={entities} onClose={() => setProposing(false)}
                              onDone={() => { setProposing(false); refresh(); }} />
      <CredentialModal open={Boolean(credentialFor)} connection={credentialFor} onClose={() => setCredentialFor(null)}
                       onDone={() => { setCredentialFor(null); refresh(); }} />
    </section>
  );
}

// ── Stuck provider transactions ─────────────────────────────────────────

const STATES = ["REVIEW_REQUIRED", "UNCERTAIN", "PENDING", "REMOTE_COMMITTED", "FAILED", "CANCELLED", "DONE", "VOIDED"];
const OWNERS = { system: "Zoiko (reconciliation worker)", billing_admin: "Billing admin", finance_approver: "Finance approver" };
const RETRYABLE = ["ROW_ERROR", "UNRESOLVED_COMMIT"];

function ProviderState({ result }) {
  if (!result) return null;
  const p = result.provider || {};
  return (
    <div className="mt-2 rounded-lg border border-slate-200 p-2 text-xs dark:border-slate-700" role="status">
      {result.available === false || p.available === false ? (
        <p className={MUTED}>The provider couldn't be asked: {p.detail || result.detail || "not available"}.</p>
      ) : (
        <p className={STRONG}>
          Provider holds: <strong>{humanize(p.provider?.state)}</strong>
          {p.provider?.transaction_id ? ` · ${p.provider.transaction_id}` : ""}
          {p.provider?.total_tax != null ? ` · tax ${p.provider.total_tax} ${p.provider.currency || ""}` : ""}
          {p.provider?.tax_date ? ` · tax date ${p.provider.tax_date}` : ""}. Nothing was changed.
        </p>
      )}
    </div>
  );
}

function TransactionCard({ t, user, nameOf, onChanged }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [checked, setChecked] = useState(null);
  const billing = canPropose(user?.role);
  const finance = canDecide(user?.role);
  const act = async (key, fn) => {
    setBusy(key);
    setError(null);
    try { const r = await fn(); if (r) onChanged(r); }
    catch (err) { setError(err?.message || "The action failed."); }
    finally { setBusy(null); }
  };
  const review = t.state === "REVIEW_REQUIRED";
  const voidable = review && t.operation === "COMMIT" && t.provider_transaction_id && !t.void_requested_by;
  return (
    <li className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={`text-sm font-semibold ${STRONG}`}>
          {t.invoice_number || `Invoice #${t.invoice_id}`} · {humanize(t.operation)} · {t.provider_name}
        </span>
        <TaxStatusBadge status={t.state} />
      </div>
      <p className={`text-xs ${MUTED}`}>
        Age {formatAge(t.age_seconds)} · {t.attempts} attempt(s) · owner: {t.owner ? OWNERS[t.owner] || humanize(t.owner) : "none (closed)"}
        {t.review_reason ? ` · ${t.review_reason}` : ""}
      </p>
      {t.last_error && <p className="text-xs text-red-800 dark:text-red-200">Last error: {t.last_error}</p>}
      {t.void_requested_by && <p className="text-xs text-amber-900 dark:text-amber-200">Void requested by {nameOf(t.void_requested_by)}; a different finance approver must approve it.</p>}
      <InlineError message={error} />
      <div className="mt-2">
        <ActionBar busyKey={busy} actions={[
          { key: `check-${t.id}`, label: "Check provider state", hidden: !billing,
            onClick: () => act(`check-${t.id}`, async () => { setChecked(await providerTransactionAction(t.id, "check-state")); return null; }) },
          { key: `retry-${t.id}`, label: "Retry local finalize", hidden: !billing || !review,
            reason: RETRYABLE.includes(t.review_kind) ? null : "Only rows that failed on our side, or whose outcome is unresolved, can be retried.",
            onClick: () => act(`retry-${t.id}`, () => providerTransactionAction(t.id, "retry")) },
          { key: `void-${t.id}`, label: "Void remote", hidden: !billing || !voidable,
            onClick: () => act(`void-${t.id}`, () => providerTransactionAction(t.id, "void-request")) },
          { key: `void-approve-${t.id}`, label: "Approve void", variant: "primary", hidden: !finance || !t.void_requested_by || !review,
            reason: t.void_requested_by === user?.id ? "You requested this void; a different user must approve it." : null,
            onClick: () => act(`void-approve-${t.id}`, () => providerTransactionAction(t.id, "void-approve")) },
        ]} />
      </div>
      <ProviderState result={checked} />
    </li>
  );
}

export function ProviderTransactionsScreen({ user }) {
  const stateId = useId();
  const [state, setState] = useState("REVIEW_REQUIRED");
  const [reload, setReload] = useState(0);
  const list = useCursorList(({ cursor }) => listProviderTransactions({ state, cursor }), [state, reload]);
  const nameOf = useTenantNames();
  return (
    <section className={PANEL} aria-labelledby="txn-title">
      <SectionTitle id="txn-title" title="Provider transactions">
        Invoices issued through a provider that are stuck or need a person. Check the provider first: it changes
        nothing. Voiding at the provider needs two people and only works for invoices never sent.
      </SectionTitle>
      <div className="mb-3 w-72">
        <Field label="State" htmlFor={stateId}>
          <Select id={stateId} value={state} onChange={(e) => setState(e?.target ? e.target.value : e)} placeholder="All states"
                  options={STATES.map((s) => ({ value: s, label: humanize(s) }))} />
        </Field>
      </div>
      <InlineError message={list.error} />
      {!list.loading && !list.items.length && !list.error && <p className={`text-sm ${MUTED}`}>Nothing in this state.</p>}
      <ul className="space-y-2">
        {list.items.map((t) => <TransactionCard key={t.id} t={t} user={user} nameOf={nameOf} onChanged={() => setReload((n) => n + 1)} />)}
      </ul>
      <LoadMore list={list} noun="transactions" />
    </section>
  );
}
