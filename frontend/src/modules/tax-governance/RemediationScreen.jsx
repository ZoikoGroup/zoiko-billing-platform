import { useCallback, useEffect, useState } from "react";
import { Lock } from "lucide-react";

import { Button } from "../../components/billing-ui";
import {
  ActionBar, InlineError, LoadMore, MUTED, PANEL, ReasonModal, STRONG, TaxStatusBadge, formatDateTime, humanize,
  useCursorList,
} from "../tax-control-center/shared";
import { DecisionBar, SectionTitle, TenantEvidenceExport, describeError, isOrgAdmin, useTenantNames } from "./common";
import {
  decideRemediation, getDuplicateRemediation, getOvercollectionRemediation, listRemediationBatches,
  proposeRemediation, reverseRemediation, withdrawRemediation,
} from "./governanceService";

/* Targeted remediation (ZB-TAX-ARCH-001 Phase 7 PR 4): no silent historical
 * mutation. Previews change nothing. Executing a batch needs an org admin to
 * propose and a different finance approver to approve; it is capped, never
 * repeats an invoice, is audited, and produces an evidence bundle. It is off
 * for an organization until the product owner decides. */

const canRead = (role) => role === "org_admin" || role === "finance_approver";
const KIND_LABEL = { OVERCOLLECTION_CREDIT: "Corrective credit notes", DUPLICATE_ROWS: "Duplicate tax rows" };

function Off() {
  return (
    <p className={`flex items-start gap-2 text-sm ${MUTED}`} role="note">
      <Lock size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
      Running this is turned off for your organization until our product owner decides. The preview below changes nothing.
    </p>
  );
}

function Picker({ title, kind, data, rows, user, onProposed }) {
  const [selected, setSelected] = useState([]);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState(null);
  const admin = isOrgAdmin(user?.role);
  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const propose = async (reason) => {
    setAsking(false);
    setError(null);
    try { await proposeRemediation(kind, selected, reason); setSelected([]); onProposed(); }
    catch (err) { setError(describeError(err)); }
  };
  return (
    <div className="space-y-2">
      <h3 className={`text-sm font-bold ${STRONG}`}>{title}</h3>
      {!data.enabled && <Off />}
      <p className={`text-xs ${MUTED}`}>{data.note}</p>
      <InlineError message={error} />
      <ul className="space-y-1">
        {rows.map((r) => {
          const done = r.already_remediated_in_batch;
          return (
            <li key={r.invoice_id} className="flex flex-wrap items-center gap-2 text-sm">
              {data.enabled && admin && !done && r.selectable && (
                <input type="checkbox" aria-label={`Select ${r.invoice_number}`} checked={selected.includes(r.invoice_id)}
                       onChange={() => toggle(r.invoice_id)} />
              )}
              <span className={STRONG}>{r.invoice_number}</span>
              <span className={MUTED}>{r.summary}</span>
              {done && <TaxStatusBadge status="REMEDIATED" />}
            </li>
          );
        })}
        {!rows.length && <li className={`text-sm ${MUTED}`}>Nothing to remediate.</li>}
      </ul>
      {data.enabled && admin && (
        <Button size="sm" variant="primary" disabled={!selected.length || selected.length > data.max_batch}
                onClick={() => setAsking(true)}>
          Propose batch ({selected.length} of at most {data.max_batch})
        </Button>
      )}
      <ReasonModal open={asking} title={`Propose: ${KIND_LABEL[kind]}`} submitLabel="Propose" busy={false} error={null}
                   minLength={3} description="A different finance approver must approve before anything changes."
                   onCancel={() => setAsking(false)} onSubmit={propose} />
    </div>
  );
}

function Batches({ user, reloadKey, onChanged }) {
  const nameOf = useTenantNames();
  const list = useCursorList(({ cursor }) => listRemediationBatches({ cursor }), [reloadKey]);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [reversing, setReversing] = useState(null);
  const admin = isOrgAdmin(user?.role);
  const reverse = async (reason) => {
    const b = reversing;
    setReversing(null);
    setBusy(b.id);
    setError(null);
    try { await reverseRemediation(b.id, reason); onChanged(); } catch (err) { setError(describeError(err)); }
    finally { setBusy(null); }
  };
  return (
    <div className="space-y-2">
      <h3 className={`text-sm font-bold ${STRONG}`}>Batches</h3>
      <InlineError message={error || list.error} />
      <ul className="space-y-2">
        {list.items.map((b) => (
          <li key={b.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className={`text-sm font-semibold ${STRONG}`}>Batch #{b.id}: {KIND_LABEL[b.kind] || humanize(b.kind)}</span>
              <TaxStatusBadge status={b.state} />
            </div>
            <p className={`text-xs ${MUTED}`}>
              {b.invoice_ids.length} invoice(s) · proposed by {nameOf(b.proposed_by)}: {b.reason}
              {b.approved_by ? ` · decided by ${nameOf(b.approved_by)} ${formatDateTime(b.approved_at)}` : ""}
              {b.reversed_at ? ` · reversed by ${nameOf(b.reversed_by)}: ${b.reverse_reason}` : ""}
            </p>
            {b.result?.credit_notes && <p className={`text-xs ${STRONG}`}>{b.result.credit_notes.length} draft credit note(s) created; issue them through Credit Notes.</p>}
            {b.result?.rows_removed && (
              <p className={`text-xs ${STRONG}`}>
                {b.result.rows_removed.length} row(s) removed and archived
                {b.result.rows_flagged_not_identical?.length ? ` · ${b.result.rows_flagged_not_identical.length} not identical, left alone` : ""}
              </p>
            )}
            {b.evidence_sha256 && <p className={`text-xs ${MUTED}`}>Evidence SHA-256: <code className="break-all">{b.evidence_sha256}</code></p>}
            <DecisionBar user={user} record={b} proposerId={b.proposed_by} noun="remediation batch"
                         decide={decideRemediation} withdraw={withdrawRemediation} withdrawRoles={["org_admin"]}
                         onDone={onChanged} />
            <ActionBar busyKey={busy} actions={[
              { key: b.id, label: "Reverse from archive", hidden: !admin || b.kind !== "DUPLICATE_ROWS" || b.state !== "EXECUTED",
                onClick: () => setReversing(b) },
            ]} />
            {b.state !== "PROPOSED" && <TenantEvidenceExport user={user} kind="remediation_batch" id={b.id} />}
          </li>
        ))}
      </ul>
      {!list.loading && !list.items.length && <p className={`text-sm ${MUTED}`}>No batches yet.</p>}
      <LoadMore list={list} noun="batches" />
      <ReasonModal open={Boolean(reversing)} title="Reverse this batch" submitLabel="Reverse" busy={false} error={null}
                   description="Every removed row is restored from the archive with its original id." minLength={3}
                   onCancel={() => setReversing(null)} onSubmit={reverse} />
    </div>
  );
}

export function RemediationScreen({ user }) {
  const [over, setOver] = useState(null);
  const [dups, setDups] = useState(null);
  const [error, setError] = useState(null);
  const [reload, setReload] = useState(0);
  const allowed = canRead(user?.role);
  const load = useCallback(() => {
    Promise.all([getOvercollectionRemediation(), getDuplicateRemediation()])
      .then(([o, d]) => { setOver(o); setDups(d); })
      .catch((err) => setError(err?.message || "Couldn't load the remediation previews."));
  }, []);
  useEffect(() => { if (allowed) load(); }, [allowed, load, reload]);
  if (!allowed) {
    return (
      <section className={PANEL} aria-labelledby="rem-title">
        <SectionTitle id="rem-title" title="Remediation" />
        <p className={`text-sm ${MUTED}`}>Remediation is for organization admins and finance approvers.</p>
      </section>
    );
  }
  const refresh = () => setReload((n) => n + 1);
  return (
    <section className={`${PANEL} space-y-6`} aria-labelledby="rem-title">
      <SectionTitle id="rem-title" title="Remediation">
        Correct legacy findings without changing history: previews first, then a batch approved by two people, with an
        evidence bundle for each.
      </SectionTitle>
      <InlineError message={error} />
      {over && (
        <Picker title="Legacy over-collection: corrective credit notes" kind="OVERCOLLECTION_CREDIT" data={over} user={user}
                onProposed={refresh}
                rows={over.invoices.map((i) => ({ invoice_id: i.invoice_id, invoice_number: i.invoice_number, selectable: true,
                  already_remediated_in_batch: i.already_remediated_in_batch,
                  summary: `credit ${i.credit_note_amount} ${i.currency} (tax charged ${i.tax_amount})` }))} />
      )}
      {dups && (
        <Picker title="Duplicate tax rows" kind="DUPLICATE_ROWS" data={dups} user={user} onProposed={refresh}
                rows={dups.invoices.map((i) => ({ invoice_id: i.invoice_id, invoice_number: i.invoice_number,
                  selectable: i.rows_to_remove.length > 0, already_remediated_in_batch: i.already_remediated_in_batch,
                  summary: `${i.rows_to_remove.length} to remove · ${i.rows_flagged_not_identical.length} not identical (kept) · `
                    + `rows total ${i.tax_rows_total_before} → ${i.tax_rows_total_after}; invoice unchanged` }))} />
      )}
      <Batches user={user} reloadKey={reload} onChanged={refresh} />
      <p className={`text-xs ${MUTED}`}>
        Repricing legacy quotes on conversion to invoices has no tool yet: it waits on a product decision.
      </p>
    </section>
  );
}
