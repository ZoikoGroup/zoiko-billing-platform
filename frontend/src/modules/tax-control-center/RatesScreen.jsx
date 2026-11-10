import { useEffect, useId, useState } from "react";
import { Plus } from "lucide-react";

import { Button, Field, FORM_CONTROL_CLASS, FormGrid, FormModal, Select } from "../../components/billing-ui";
import { approveBlockedReason, canApproveTaxRegistry, canWriteTaxRegistry } from "./access";
import {
  getEvidenceBundle, amendStagedRate, getStagedRateComparison, listComponents, listSourceRevisions, listStagedRates, stageRate,
  stagedRateAction,
} from "./taxRegistryService";
import {
  ActionBar, DefinitionList, DetailModal, EvidenceExport, InlineError, LoadMore, MUTED, PANEL, ReasonModal, STRONG, TaxStatusBadge,
  TaxTable, ValidationList, formatDateTime, humanize, useApprovalVerdict, useCursorList, usePeopleNames,
  useReferenceList, useStepUp,
} from "./shared";
import { RegressionPanel } from "./RegressionPanel";
import { RetroPreviewPanel } from "./RetroScreens";

/* P3 Rates and change review: staged rates through validate, submit,
 * approve (or reject) and publish, with the proposal shown beside the rate
 * it replaces and any ACTIVE version its period overlaps. Approve and
 * publish need MFA step-up and a different person from the maker. */

const STATUSES = ["PENDING_REVIEW", "VALIDATION_FAILED", "CONFLICT_ESCALATED", "VALIDATED", "IN_APPROVAL", "APPROVED",
                  "REJECTED", "PUBLISHED"];
const KINDS = ["STANDARD", "REDUCED", "SUPER_REDUCED", "PARKING", "ZERO_RATED"];
const EDITABLE = ["PENDING_REVIEW", "VALIDATION_FAILED", "CONFLICT_ESCALATED", "VALIDATED"];
const opts = (values) => values.map((v) => ({ value: v, label: humanize(v) }));

const FIELDS = ["component_id", "tax_code", "product_scope", "rate_kind", "rate_percent", "valid_from", "valid_to",
                "source_revision_id", "owner", "supersedes_rate_version_id", "reviewer_notes"];

function RateFormModal({ open, onClose, onDone, existing }) {
  const base = useId();
  const ids = Object.fromEntries(FIELDS.map((f) => [f, `${base}-${f}`]));
  const blank = { component_id: "", tax_code: "", product_scope: "GENERAL", rate_kind: "STANDARD", rate_percent: "",
                  valid_from: "", valid_to: "", source_revision_id: "", owner: "", supersedes_rate_version_id: "",
                  reviewer_notes: "" };
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const components = useReferenceList(listComponents, open);
  const sources = useReferenceList(listSourceRevisions, open);
  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm(existing ? Object.fromEntries(FIELDS.map((f) => [f, existing[f] ?? ""])) : blank);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existing]);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e?.target ? e.target.value : e }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    const body = {};
    for (const f of FIELDS) {
      const v = form[f];
      if (v === "" || v == null) continue;
      body[f] = ["component_id", "source_revision_id", "supersedes_rate_version_id"].includes(f) ? Number(v) : v;
    }
    try {
      const saved = existing ? await amendStagedRate(existing.id, body) : await stageRate(body);
      onDone(saved);
    } catch (err) {
      setError(err?.message || "Couldn't save the rate.");
    } finally {
      setBusy(false);
    }
  };

  const text = (key, label, props = {}) => (
    <Field label={label} htmlFor={ids[key]} required={props.required}>
      <input id={ids[key]} className={FORM_CONTROL_CLASS} value={form[key]} onChange={set(key)} {...props} />
    </Field>
  );

  return (
    <FormModal open={open} onClose={onClose} onSubmit={submit} busy={busy} error={error} size="lg" icon={Plus}
               title={existing ? `Amend staged rate #${existing.id}` : "Stage a rate"}
               submitLabel={existing ? "Save changes" : "Stage rate"}
               description="Take the rate and its dates from the cited legal source. Saving resets review: validate it again.">
      <FormGrid>
        <Field label="Component" htmlFor={ids.component_id} required={!existing}>
          <Select id={ids.component_id} value={form.component_id} onChange={set("component_id")} placeholder="Choose…"
                  required={!existing} disabled={Boolean(existing)}
                  options={components.map((c) => ({ value: c.id, label: `${c.code} — ${c.name} (${c.jurisdiction_code} ${c.tax_type})` }))} />
        </Field>
        {text("tax_code", "Tax code", { required: !existing, disabled: Boolean(existing), maxLength: 50 })}
        {text("product_scope", "Product scope", { disabled: Boolean(existing), maxLength: 100 })}
        <Field label="Rate kind" htmlFor={ids.rate_kind} required>
          <Select id={ids.rate_kind} value={form.rate_kind} onChange={set("rate_kind")} options={opts(KINDS)} placeholder="" disabled={Boolean(existing)} />
        </Field>
        {text("rate_percent", "Rate %", { inputMode: "decimal", pattern: "^\\d{1,2}(\\.\\d{1,6})?$", title: "A percentage below 100, up to 6 decimals" })}
        <Field label="Legal source" htmlFor={ids.source_revision_id}>
          <Select id={ids.source_revision_id} value={form.source_revision_id} onChange={set("source_revision_id")}
                  placeholder="Choose…"
                  options={sources.map((s) => ({ value: s.id, label: `#${s.id} ${s.handoff_ref ? `${s.handoff_ref} · ` : ""}${s.title}` }))} />
        </Field>
        {text("valid_from", "Valid from (local legal date)", { type: "date" })}
        {text("valid_to", "Valid to (exclusive)", { type: "date" })}
        {text("supersedes_rate_version_id", "Supersedes version ID", { type: "number", min: 1 })}
        {text("owner", "Owner", { maxLength: 150 })}
      </FormGrid>
      {text("reviewer_notes", "Reviewer notes")}
    </FormModal>
  );
}

function RateCard({ title, rate, note }) {
  return (
    <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
      <p className={`text-xs font-semibold uppercase tracking-wider ${MUTED}`}>{title}</p>
      {rate ? (
        <DefinitionList rows={[
          ["Rate", `${rate.rate_percent}%`], ["Kind", humanize(rate.rate_kind)],
          ["Valid from", rate.valid_from], ["Valid to", rate.valid_to || "Open-ended"],
          ["Status", <TaxStatusBadge key="s" status={rate.status} />],
          ["Source", rate.source ? `${rate.source.authority || ""} — ${rate.source.citation}` : rate.source_revision_id ? `Revision #${rate.source_revision_id}` : "—"],
        ]} />
      ) : (
        <p className={`mt-2 text-sm ${MUTED}`}>{note}</p>
      )}
    </div>
  );
}

function RateDetail({ staged, user, onChanged, onEdit }) {
  const [cmp, setCmp] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [reasonFor, setReasonFor] = useState(null);
  const stepUp = useStepUp();
  const nameOf = usePeopleNames();
  const verdict = useApprovalVerdict("staged_rate", staged, approveBlockedReason(user, staged));

  const load = () => getStagedRateComparison(staged.id).then(setCmp).catch((err) => setError(err?.message));
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [staged.id, staged.status]);

  const act = async (key, fn) => {
    setBusy(key);
    setError(null);
    try {
      const result = await fn();
      if (result) onChanged();
    } catch (err) {
      setError(err?.message || "The action failed.");
    } finally {
      setBusy(null);
    }
  };
  const canWrite = canWriteTaxRegistry(user?.platform_role);
  const canApprove = canApproveTaxRegistry(user?.platform_role);
  const s = staged.status;
  const publishReason = approveBlockedReason(user, staged);

  return (
    <>
      <InlineError message={error} />
      <div className="grid gap-3 md:grid-cols-2" aria-label="Old and new side by side">
        <RateCard title="Current (replaced or overlapped)"
                  rate={cmp?.superseded || cmp?.overlapping_active?.[0]}
                  note={cmp ? "No ACTIVE rate for this key yet: this would be the first." : "Loading…"} />
        <RateCard title="Proposed" rate={{ ...staged, status: s }} />
      </div>
      {cmp && (
        <>
          <p className={`text-sm ${MUTED}`}>
            {cmp.component.jurisdiction_name} ({cmp.component.jurisdiction_code}) · {cmp.component.tax_type} ·{" "}
            component {cmp.component.code} · tax code {staged.tax_code} · scope {staged.product_scope}
          </p>
          <ValidationList title="Errors" items={cmp.errors} />
          <ValidationList title="Conflicts (escalate to the tax lead)" items={cmp.conflicts} />
          <ValidationList title="Warnings" items={cmp.warnings} tone="amber" />
          {cmp.active_for_key?.length > 0 && (
            <div>
              <p className={`text-xs font-semibold uppercase tracking-wider ${MUTED}`}>Timeline for this key</p>
              <ol className="mt-1 space-y-1 text-sm">
                {[...cmp.active_for_key.map((v) => ({ ...v, label: `Version #${v.id}` })),
                  { ...staged, label: `Proposal #${staged.id}` }]
                  .sort((a, b) => String(a.valid_from).localeCompare(String(b.valid_from)))
                  .map((v) => (
                    <li key={v.label} className={STRONG}>
                      <strong>{v.valid_from || "no start date"}</strong> → {v.valid_to || "open"}: {v.rate_percent}% ({v.label})
                    </li>
                  ))}
              </ol>
            </div>
          )}
        </>
      )}
      <DefinitionList rows={[
        ["Origin", humanize(staged.origin)], ["Owner", staged.owner],
        ["Drafted", `${formatDateTime(staged.created_at)}${staged.created_by_user_id ? ` · ${nameOf(staged.created_by_user_id)}` : ""}`],
        ["Validated", formatDateTime(staged.validated_at)],
        staged.escalated_at && ["Escalated", `${formatDateTime(staged.escalated_at)}: ${staged.escalation_reason}`],
        staged.adopted_at && ["Adopted (AI proposal)", `${formatDateTime(staged.adopted_at)} · ${nameOf(staged.adopted_by_user_id)}`],
        staged.published_rate_version_id && ["Published as version", `#${staged.published_rate_version_id}`],
        ["Reviewer notes", staged.reviewer_notes],
      ]} />
      <ActionBar busyKey={busy} actions={[
        { key: "edit", label: "Amend", hidden: !canWrite || !EDITABLE.includes(s), onClick: onEdit },
        { key: "adopt", label: "Adopt AI proposal", hidden: !canWrite || staged.origin !== "AI_PROPOSAL" || staged.adopted_at,
          onClick: () => act("adopt", () => stagedRateAction(staged.id, "adopt")) },
        { key: "validate", label: "Validate", hidden: !canWrite || !EDITABLE.includes(s),
          onClick: () => act("validate", () => stagedRateAction(staged.id, "validate")) },
        { key: "submit", label: "Submit for approval", variant: "primary", hidden: !canWrite || s !== "VALIDATED",
          onClick: () => setReasonFor("submit") },
        { key: "approve", label: "Approve", variant: "primary", hidden: !canApprove || s !== "IN_APPROVAL",
          reason: verdict.loading ? null : verdict.reason, disabled: verdict.loading,
          onClick: () => act("approve", () => stepUp.run((body) => stagedRateAction(staged.id, "approve", body))) },
        { key: "reject", label: "Reject", hidden: !canApprove || s !== "IN_APPROVAL", onClick: () => setReasonFor("reject") },
        { key: "publish", label: "Publish", variant: "primary", hidden: !canApprove || s !== "APPROVED", reason: publishReason,
          onClick: () => act("publish", () => stepUp.run((body) => stagedRateAction(staged.id, "publish", body))) },
      ]} />
      <ReasonModal
        open={Boolean(reasonFor)} busy={busy === reasonFor} error={null} minLength={3}
        title={reasonFor === "reject" ? "Reject this rate" : "Submit for approval"}
        submitLabel={reasonFor === "reject" ? "Reject" : "Submit"}
        onCancel={() => setReasonFor(null)}
        onSubmit={(reason) => { const action = reasonFor; setReasonFor(null);
          act(action, () => stagedRateAction(staged.id, action, { reason })); }}
      />
      <RegressionPanel kind="rate" id={staged.id} user={user} />
      {staged.status !== "PUBLISHED" && <RetroPreviewPanel kind="rate" id={staged.id} user={user} />}
      <EvidenceExport noun="rate" filename={`tax-evidence-rate-${staged.id}`}
                      fetchBundle={(format) => getEvidenceBundle("rate", staged.id, format)} />
      {stepUp.modal}
    </>
  );
}

export default function RatesScreen({ user }) {
  const [status, setStatus] = useState("");
  const list = useCursorList(({ cursor }) => listStagedRates({ status: status || undefined, cursor }), [status]);
  const [open, setOpen] = useState(null);
  const [form, setForm] = useState(null);
  const canWrite = canWriteTaxRegistry(user?.platform_role);

  const refreshOpen = async () => {
    list.reload();
    if (!open) return;
    try {
      const cmp = await getStagedRateComparison(open.id);
      setOpen(cmp.staged);
    } catch { setOpen(null); }
  };

  const columns = [
    { key: "id", label: "#" },
    { key: "tax_code", label: "Tax code" },
    { key: "rate_percent", label: "Rate", render: (r) => (r.rate_percent != null ? `${r.rate_percent}%` : "—") },
    { key: "valid_from", label: "From", render: (r) => r.valid_from || "—" },
    { key: "origin", label: "Origin", render: (r) => humanize(r.origin) },
    { key: "status", label: "Status", render: (r) => <TaxStatusBadge status={r.status} /> },
  ];

  return (
    <section className={PANEL} aria-labelledby="rates-title">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="rates-title" className={`text-lg font-bold ${STRONG}`}>Rates and change review</h2>
          <p className={`text-sm ${MUTED}`}>A staged rate is never live until it is approved by a second person and published.</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="w-48 text-sm">
            <span className={`mb-1 block text-xs font-semibold uppercase tracking-wider ${MUTED}`}>Status</span>
            <Select value={status} onChange={setStatus} options={opts(STATUSES)} placeholder="All statuses" aria-label="Filter by status" />
          </label>
          {canWrite && <Button variant="primary" size="sm" icon={Plus} onClick={() => setForm({ existing: null })}>Stage rate</Button>}
        </div>
      </div>
      <InlineError message={list.error} />
      <TaxTable caption="Staged rates" columns={columns} rows={list.items} onOpen={setOpen} empty="No staged rates." />
      <LoadMore list={list} noun="staged rates" />
      <DetailModal open={Boolean(open)} onClose={() => setOpen(null)}
                   title={open ? `Staged rate #${open.id}` : ""}
                   description={open ? `${open.tax_code} · ${open.rate_percent ?? "?"}% from ${open.valid_from || "?"}` : ""}>
        {open && <RateDetail staged={open} user={user} onChanged={refreshOpen} onEdit={() => setForm({ existing: open })} />}
      </DetailModal>
      <RateFormModal open={Boolean(form)} existing={form?.existing} onClose={() => setForm(null)}
                     onDone={(saved) => { setForm(null); if (open) setOpen(saved); list.reload(); }} />
    </section>
  );
}
