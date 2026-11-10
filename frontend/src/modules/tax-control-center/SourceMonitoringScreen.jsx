import { useCallback, useEffect, useId, useState } from "react";

import { Button, Field, FORM_CONTROL_CLASS, FormGrid, FormModal, Select } from "../../components/billing-ui";
import { canApproveTaxRegistry, canWriteTaxRegistry } from "./access";
import {
  checkSourceNow, closeSourceReview, createSourceMonitor, decideMonitorChange, listReviewDues, listSourceMonitors,
  listSourceReviews, markDueReviewed, proposeMonitorChange, raiseMonitorTier,
} from "./taxRegistryService";
import { InlineError, MUTED, PANEL, ReasonModal, STRONG, TaxStatusBadge, formatDateTime, humanize, usePeopleNames } from "./shared";

/* Phase 8 PR 5: official source monitoring. Detection only: a change opens a
 * review; formal evidence is still captured through the source register.
 * Fetched text and diffs are untrusted: shown as escaped plain text, never
 * as HTML. Changes that can weaken detection need a second person. */

const TIERS = [
  { value: "HIGH_VOLATILITY", label: "High volatility (daily)" },
  { value: "NATIONAL_VAT_GST", label: "National VAT/GST (weekly)" },
  { value: "RESEARCH_ONLY", label: "Research only (quarterly)" },
];
const WEAKEN = [
  { value: "LOWER_TIER", label: "Check less often" }, { value: "TO_MANUAL", label: "Switch to manual checks" },
  { value: "CHANGE_URL", label: "Change the URL" }, { value: "DISABLE", label: "Disable" }, { value: "DELETE", label: "Delete (history kept)" },
];
const RANK = { HIGH_VOLATILITY: 0, NATIONAL_VAT_GST: 1, RESEARCH_ONLY: 2 };

function AddMonitor({ onDone }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: "", monitoring_url: "", risk_tier: "NATIONAL_VAT_GST", handoff_ref: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));
  const submit = async () => {
    setBusy(true);
    setError(null);
    try { await createSourceMonitor({ ...form, handoff_ref: form.handoff_ref || undefined }); setOpen(false); onDone(); }
    catch (err) { setError(err?.message || "Couldn't add the monitor."); }
    finally { setBusy(false); }
  };
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>Monitor a source</Button>
      <FormModal open={open} onClose={() => setOpen(false)} onSubmit={submit} busy={busy} error={error}
                 title="Monitor an official source" submitLabel="Add"
                 description="https only, on an allowlisted official host. Detection only: nothing is published from it.">
        <FormGrid>
          <Field label="Title" htmlFor={`${id}-t`} required><input id={`${id}-t`} className={FORM_CONTROL_CLASS} required value={form.title} onChange={set("title")} /></Field>
          <Field label="Source reference (e.g. S11)" htmlFor={`${id}-r`}><input id={`${id}-r`} className={FORM_CONTROL_CLASS} value={form.handoff_ref} onChange={set("handoff_ref")} /></Field>
        </FormGrid>
        <Field label="Monitoring URL" htmlFor={`${id}-u`} required><input id={`${id}-u`} type="url" className={FORM_CONTROL_CLASS} required value={form.monitoring_url} onChange={set("monitoring_url")} /></Field>
        <Field label="Risk tier" htmlFor={`${id}-k`} required>
          <Select id={`${id}-k`} value={form.risk_tier} onChange={set("risk_tier")} options={TIERS} placeholder="" aria-label="Risk tier" />
        </Field>
      </FormModal>
    </>
  );
}

function ProposeChange({ monitor, onDone }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ action: "LOWER_TIER", value: "", reason: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));
  const submit = async () => {
    setBusy(true);
    setError(null);
    try { await proposeMonitorChange(monitor.id, { action: form.action, reason: form.reason, value: form.value || undefined }); setOpen(false); onDone(); }
    catch (err) { setError(err?.message || "Couldn't propose the change."); }
    finally { setBusy(false); }
  };
  const needsValue = form.action === "LOWER_TIER" || form.action === "CHANGE_URL";
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>Propose change</Button>
      <FormModal open={open} onClose={() => setOpen(false)} onSubmit={submit} busy={busy} error={error}
                 title={`Propose a change to ${monitor.title}`} submitLabel="Propose"
                 description="These changes can weaken detection: a different reviewer or publisher decides.">
        <Field label="Change" htmlFor={`${id}-a`} required>
          <Select id={`${id}-a`} value={form.action} onChange={set("action")} options={WEAKEN} placeholder="" aria-label="Change" />
        </Field>
        {needsValue && form.action === "LOWER_TIER" && (
          <Field label="New tier" htmlFor={`${id}-v`} required>
            <Select id={`${id}-v`} value={form.value} onChange={set("value")} aria-label="New tier"
                    options={TIERS.filter((t) => RANK[t.value] > RANK[monitor.risk_tier])} placeholder="Choose" />
          </Field>
        )}
        {needsValue && form.action === "CHANGE_URL" && (
          <Field label="New URL" htmlFor={`${id}-v`} required><input id={`${id}-v`} type="url" className={FORM_CONTROL_CLASS} required value={form.value} onChange={set("value")} /></Field>
        )}
        <Field label="Reason" htmlFor={`${id}-why`} required>
          <textarea id={`${id}-why`} className={FORM_CONTROL_CLASS} rows={3} required minLength={3} value={form.reason} onChange={set("reason")} />
        </Field>
      </FormModal>
    </>
  );
}

function Monitors({ user, monitors, reload }) {
  const nameOf = usePeopleNames();
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const reviewer = canWriteTaxRegistry(user?.platform_role);
  const decider = reviewer || canApproveTaxRegistry(user?.platform_role);
  const run = async (fn, done) => {
    setError(null);
    setNotice(null);
    try { const r = await fn(); if (done) setNotice(done(r)); reload(); } catch (err) { setError(err?.message || "The action failed."); }
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className={`text-sm font-bold ${STRONG}`}>Monitored sources</h3>
        {reviewer && <AddMonitor onDone={reload} />}
      </div>
      <InlineError message={error} />
      {notice && <p role="status" className={`text-sm ${STRONG}`}>{notice}</p>}
      <ul className="space-y-2">
        {monitors.map((m) => (
          <li key={m.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className={`text-sm font-semibold ${STRONG}`}>{m.title}{m.handoff_ref ? ` (${m.handoff_ref})` : ""}</span>
              <span className="flex flex-wrap gap-1">
                {!m.enabled && <TaxStatusBadge status="SUSPENDED" />}
                {m.flapping && <TaxStatusBadge status="REVIEW_REQUIRED" />}
              </span>
            </div>
            <p className={`text-xs ${MUTED}`}>{m.host} · {humanize(m.risk_tier)} (every {m.cadence_hours} h) · {m.access_mode === "MANUAL_CHECK" ? "manual checks" : "automated"}
              {" "}· last {m.last_outcome ? humanize(m.last_outcome).toLowerCase() : "never checked"}{m.last_checked_at ? ` ${formatDateTime(m.last_checked_at)}` : ""} · next due {formatDateTime(m.next_check_due)}</p>
            {m.manual_reason && <p className="text-xs text-amber-900 dark:text-amber-200">Manual checks: {m.manual_reason}</p>}
            {m.flapping && (
              <p className="text-xs text-amber-900 dark:text-amber-200">
                Flapping: {m.dismissals} change(s) dismissed. Recent reasons: {m.recent_dismissal_reasons.join("; ")}
              </p>
            )}
            {m.pending_change && (
              <div className="mt-1 text-xs">
                <p className={STRONG}>Proposed by {nameOf(m.pending_change.proposed_by)}: {humanize(m.pending_change.action)}{m.pending_change.value ? ` → ${m.pending_change.value}` : ""} ({m.pending_change.reason})</p>
                {decider && user?.id !== m.pending_change.proposed_by && (
                  <div className="mt-1 flex gap-2">
                    <Button size="sm" variant="primary" onClick={() => run(() => decideMonitorChange(m.pending_change.id, true), () => "Change approved.")}>Approve change</Button>
                    <Button size="sm" onClick={() => run(() => decideMonitorChange(m.pending_change.id, false, { reason: "Keep detection as it is" }), () => "Change rejected.")}>Reject change</Button>
                  </div>
                )}
              </div>
            )}
            {reviewer && m.enabled && (
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => run(() => checkSourceNow(m.id), (r) => `Check: ${humanize(r.outcome).toLowerCase()}.`)}>Check now</Button>
                {RANK[m.risk_tier] > 0 && (
                  <Button size="sm" onClick={() => run(() => raiseMonitorTier(m.id, TIERS[RANK[m.risk_tier] - 1].value), () => "Checked more often now.")}>
                    Check more often
                  </Button>
                )}
                {!m.pending_change && <ProposeChange monitor={m} onDone={reload} />}
              </div>
            )}
          </li>
        ))}
      </ul>
      {!monitors.length && <p className={`text-sm ${MUTED}`}>No source is monitored yet.</p>}
    </div>
  );
}

function Reviews({ user, reviews, reload }) {
  const [asking, setAsking] = useState(null);                  // {id, outcome} for the reason dialog
  const [revisions, setRevisions] = useState({});             // review id -> typed source revision #
  const [error, setError] = useState(null);
  const reviewer = canWriteTaxRegistry(user?.platform_role);
  const close = async (review, outcome, reason) => {
    setError(null);
    try {
      await closeSourceReview(review.id, { outcome, reason,
        ...(outcome === "EVIDENCE_CAPTURED" ? { source_revision_id: Number(revisions[review.id]) } : {}) });
      setAsking(null);
      reload();
    } catch (err) { setError(err?.message || "Couldn't close the review."); }
  };
  return (
    <div className="space-y-2">
      <h3 className={`text-sm font-bold ${STRONG}`}>Open reviews and reminders</h3>
      <InlineError message={error} />
      <ul className="space-y-2">
        {reviews.map((r) => (
          <li key={r.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
            <p className={`text-sm font-semibold ${STRONG}`}>{humanize(r.kind)} #{r.id}{r.monitor_id ? ` · monitor #${r.monitor_id}` : ""}{r.rate_version_id ? ` · rate version #${r.rate_version_id}` : ""}</p>
            <p className={`text-xs ${MUTED}`}>Opened {formatDateTime(r.created_at)}</p>
            {r.diff && (
              /* Untrusted fetched text: React renders it escaped, as plain text. */
              <pre aria-label={`Changes in review ${r.id}`} className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-2 text-xs text-slate-800 dark:bg-slate-900 dark:text-slate-200">{r.diff}</pre>
            )}
            {reviewer && (
              <div className="mt-2 flex flex-wrap items-end gap-2">
                {r.kind === "SOURCE_CHANGED" ? (
                  <>
                    <label className="text-xs">
                      <span className={`block ${MUTED}`}>New source revision #</span>
                      <input className={FORM_CONTROL_CLASS} inputMode="numeric" aria-label={`Source revision for review ${r.id}`} value={revisions[r.id] || ""}
                             onChange={(e) => setRevisions((v) => ({ ...v, [r.id]: e.target.value }))} />
                    </label>
                    <Button size="sm" variant="primary" disabled={!revisions[r.id]} onClick={() => close(r, "EVIDENCE_CAPTURED")}>Evidence captured</Button>
                    <Button size="sm" onClick={() => setAsking({ id: r.id, outcome: "DISMISSED" })}>Dismiss</Button>
                  </>
                ) : (
                  <Button size="sm" variant="primary" onClick={() => setAsking({ id: r.id, outcome: "CHECKED" })}>Record check</Button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {!reviews.length && <p className={`text-sm ${MUTED}`}>Nothing to review.</p>}
      <ReasonModal open={Boolean(asking)} busy={false} error={null} minLength={3}
                   title={asking?.outcome === "DISMISSED" ? "Dismiss this change" : "Record the check"}
                   description={asking?.outcome === "DISMISSED" ? "Say why it isn't a legal change; dismissals are counted per source." : "Note what you checked."}
                   submitLabel={asking?.outcome === "DISMISSED" ? "Dismiss" : "Record"} onCancel={() => setAsking(null)}
                   onSubmit={(reason) => close(reviews.find((x) => x.id === asking.id), asking.outcome, reason)} />
    </div>
  );
}

function Dues({ user, dues, reload }) {
  const [marking, setMarking] = useState(null);
  const [error, setError] = useState(null);
  const reviewer = canWriteTaxRegistry(user?.platform_role);
  return (
    <div className="space-y-2">
      <h3 className={`text-sm font-bold ${STRONG}`}>Revalidation due</h3>
      <InlineError message={error} />
      <ul className="space-y-1">
        {dues.map((d) => (
          <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className={STRONG}>{d.label} <span className={MUTED}>({humanize(d.tier)}; due {formatDateTime(d.next_review_due)})</span></span>
            <span className="flex items-center gap-2">
              {d.overdue && <TaxStatusBadge status="REVIEW_REQUIRED" />}
              {reviewer && <Button size="sm" onClick={() => setMarking(d)}>Mark reviewed</Button>}
            </span>
          </li>
        ))}
      </ul>
      <ReasonModal open={Boolean(marking)} busy={false} error={null} minLength={3} title="Record the revalidation"
                   description="What did you check?" submitLabel="Mark reviewed" onCancel={() => setMarking(null)}
                   onSubmit={async (note) => { const d = marking; setMarking(null); setError(null);
                     try { await markDueReviewed(d.id, note); reload(); } catch (err) { setError(err?.message || "Couldn't record it."); } }} />
    </div>
  );
}

export default function SourceMonitoringScreen({ user }) {
  const [data, setData] = useState({ monitors: [], reviews: [], dues: [] });
  const [error, setError] = useState(null);
  const load = useCallback(() => {
    Promise.all([listSourceMonitors(), listSourceReviews({ status: "OPEN" }), listReviewDues()])
      .then(([m, r, d]) => setData({ monitors: m?.items || [], reviews: r?.items || [], dues: d?.items || [] }))
      .catch((err) => setError(err?.message || "Couldn't load source monitoring."));
  }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <section className={`${PANEL} space-y-6`} aria-labelledby="sources-mon-title">
      <div>
        <h2 id="sources-mon-title" className={`text-lg font-bold ${STRONG}`}>Source monitoring</h2>
        <p className={`text-sm ${MUTED}`}>Official sources are checked on their tier's cadence. A change opens a review; nothing is published from it. Capture the new evidence in the source register.</p>
      </div>
      <InlineError message={error} />
      <Monitors user={user} monitors={data.monitors} reload={load} />
      <Reviews user={user} reviews={data.reviews} reload={load} />
      <Dues user={user} dues={data.dues} reload={load} />
    </section>
  );
}
