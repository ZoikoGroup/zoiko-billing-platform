import { useEffect, useId, useMemo, useState } from "react";
import { Plus } from "lucide-react";

import { Button, Field, FORM_CONTROL_CLASS, FormGrid, FormModal, Select } from "../../components/billing-ui";
import { approveBlockedReason, canApproveTaxRegistry, canWriteTaxRegistry } from "./access";
import {
  GATES, GATE_STATUSES, MODES, TRANSACTION_CLASSES, emptyGates, gateProblems, mandatoryGates,
} from "./gates";
import {
  amendAvailability, availabilityAction, draftAvailability, listJurisdictions, listMarketAvailability,
} from "./taxRegistryService";
import {
  ActionBar, DefinitionList, DetailModal, InlineError, LoadMore, MUTED, PANEL, ReasonModal, STRONG, TaxStatusBadge,
  TaxTable, ValidationList, VersionTimeline, humanize, useApprovalVerdict, useCursorList, useStepUp,
} from "./shared";

/* P6 Market availability: jurisdiction × tax type × transaction class -> the
 * mode the platform supports, with launch gates 01–07 and their evidence.
 * The G1 rule (gate 05 must PASS for a provider market) and the other gate
 * rules are shown as the user edits; the backend validates them. */

const STATUSES = ["PENDING_REVIEW", "VALIDATION_FAILED", "VALIDATED", "IN_APPROVAL", "APPROVED", "ACTIVE",
                  "SUPERSEDED", "REJECTED"];
const EDITABLE = ["PENDING_REVIEW", "VALIDATION_FAILED", "VALIDATED"];
const opts = (values) => values.map((v) => ({ value: v, label: humanize(v) }));

function useAllJurisdictions(open) {
  const [items, setItems] = useState([]);
  useEffect(() => {
    if (!open || items.length) return;
    let cancelled = false;
    (async () => {
      let cursor;
      const all = [];
      for (let i = 0; i < 25; i += 1) {
        const data = await listJurisdictions({ cursor });
        all.push(...(data?.items || []));
        if (!data?.next_cursor) break;
        cursor = data.next_cursor;
      }
      if (!cancelled) setItems(all);
    })().catch(() => {});
    return () => { cancelled = true; };
  }, [open, items.length]);
  return items;
}

export function GateEditor({ mode, gates, onChange }) {
  const problems = gateProblems(mode, gates);
  const required = mandatoryGates(mode);
  const update = (key, field, value) => onChange({ ...gates, [key]: { ...gates[key], [field]: value } });
  return (
    <fieldset className="space-y-3">
      <legend className={`text-sm font-bold ${STRONG}`}>Launch gates (§13.2)</legend>
      <p className={`text-xs ${MUTED}`}>
        {mode === "PROVIDER_APPROVED"
          ? "Provider market: gates 01, 02, 04 and 05 must be PASSED with evidence (gate 05 can't be waived); the others PASSED or not applicable with a note."
          : required.length
            ? "Calculating market: gates 01, 02 and 04 must be PASSED with evidence; the others PASSED or not applicable with a note."
            : "Not a calculating mode: record the gates as they stand."}
      </p>
      {GATES.map((g) => {
        const entry = gates[g.key] || {};
        const base = `gate-${g.key}`;
        return (
          <div key={g.key} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
            <p className={`mb-2 text-sm font-semibold ${STRONG}`}>
              {g.no} · {g.label}{required.includes(g.key) ? " (required)" : ""}
            </p>
            <FormGrid cols={3} dense>
              <Field label="Status" htmlFor={`${base}-status`}>
                <Select id={`${base}-status`} value={entry.status} onChange={(v) => update(g.key, "status", v)}
                        options={opts(GATE_STATUSES)} placeholder="" />
              </Field>
              <Field label="Evidence ref" htmlFor={`${base}-ev`}>
                <input id={`${base}-ev`} className={FORM_CONTROL_CLASS} value={entry.evidence_ref || ""}
                       onChange={(e) => update(g.key, "evidence_ref", e.target.value)} maxLength={1000} />
              </Field>
              <Field label="Notes" htmlFor={`${base}-notes`}>
                <input id={`${base}-notes`} className={FORM_CONTROL_CLASS} value={entry.notes || ""}
                       onChange={(e) => update(g.key, "notes", e.target.value)} />
              </Field>
            </FormGrid>
            {problems[g.key].length > 0 && (
              <ul className="mt-2 list-disc pl-5 text-xs text-amber-900 dark:text-amber-200" aria-label={`Gate ${g.no} problems`}>
                {problems[g.key].map((p) => <li key={p}>{p}</li>)}
              </ul>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}

function AvailabilityFormModal({ open, existing, onClose, onDone }) {
  const jurisdictions = useAllJurisdictions(open && !existing);
  const base = useId();
  const blank = { jurisdiction_id: "", tax_type_id: "", transaction_class: "B2B_SERVICES", mode: "REFERENCE_ONLY",
                  tenant_config_permitted: false, notes: "", gates: emptyGates() };
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm(existing ? { ...blank, ...existing, gates: { ...emptyGates(), ...(existing.gates || {}) }, notes: existing.notes || "" } : blank);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existing]);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e?.target ? (e.target.type === "checkbox" ? e.target.checked : e.target.value) : e }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    const gates = Object.fromEntries(Object.entries(form.gates).map(([k, v]) => [k, {
      status: v.status, ...(v.evidence_ref ? { evidence_ref: v.evidence_ref } : {}), ...(v.notes ? { notes: v.notes } : {}),
    }]));
    const common = { mode: form.mode, tenant_config_permitted: Boolean(form.tenant_config_permitted), gates,
                     ...(form.notes ? { notes: form.notes } : {}) };
    try {
      const saved = existing
        ? await amendAvailability(existing.id, common)
        : await draftAvailability({ ...common, jurisdiction_id: Number(form.jurisdiction_id),
                                    tax_type_id: Number(form.tax_type_id), transaction_class: form.transaction_class });
      onDone(saved);
    } catch (err) {
      setError(err?.message || "Couldn't save the availability version.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormModal open={open} onClose={onClose} onSubmit={submit} busy={busy} error={error} size="lg" icon={Plus}
               title={existing ? `Amend availability #${existing.id}` : "Draft market availability"}
               submitLabel={existing ? "Save changes" : "Save draft"}
               description="A draft changes nothing until it is validated, approved by a second person and published.">
      <FormGrid>
        <Field label="Jurisdiction" htmlFor={`${base}-j`} required>
          {existing ? (
            <input id={`${base}-j`} className={FORM_CONTROL_CLASS} value={existing.jurisdiction_code || existing.jurisdiction_id} disabled />
          ) : (
            <Select id={`${base}-j`} value={form.jurisdiction_id} onChange={set("jurisdiction_id")} required placeholder="Choose…"
                    options={jurisdictions.map((j) => ({ value: j.id, label: `${j.code} — ${j.name}` }))} />
          )}
        </Field>
        <Field label="Tax type ID" htmlFor={`${base}-t`} required hint="The registry tax type's id (e.g. VAT).">
          <input id={`${base}-t`} type="number" min="1" className={FORM_CONTROL_CLASS}
                 value={existing ? existing.tax_type_id : form.tax_type_id} onChange={set("tax_type_id")} required disabled={Boolean(existing)} />
        </Field>
        <Field label="Transaction class" htmlFor={`${base}-c`} required>
          <Select id={`${base}-c`} value={form.transaction_class} onChange={set("transaction_class")} options={opts(TRANSACTION_CLASSES)}
                  placeholder="" disabled={Boolean(existing)} />
        </Field>
        <Field label="Mode" htmlFor={`${base}-m`} required>
          <Select id={`${base}-m`} value={form.mode} onChange={set("mode")} options={opts(MODES)} placeholder="" />
        </Field>
      </FormGrid>
      <label className={`flex items-center gap-2 text-sm ${STRONG}`}>
        <input type="checkbox" checked={Boolean(form.tenant_config_permitted)} onChange={set("tenant_config_permitted")} />
        Tenants may configure their own approved rate here (needs gate 01 PASSED)
      </label>
      <GateEditor mode={form.mode} gates={form.gates} onChange={(gates) => setForm((f) => ({ ...f, gates }))} />
      <Field label="Notes" htmlFor={`${base}-n`}>
        <textarea id={`${base}-n`} rows={2} className={FORM_CONTROL_CLASS} value={form.notes} onChange={set("notes")} />
      </Field>
    </FormModal>
  );
}

function AvailabilityDetail({ version, user, onChanged, onEdit }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [reasonFor, setReasonFor] = useState(null);
  const stepUp = useStepUp();
  const fallback = approveBlockedReason(user, version);
  const verdict = useApprovalVerdict("market_availability", version, fallback);
  const problems = useMemo(() => gateProblems(version.mode, version.gates || {}), [version]);
  const canWrite = canWriteTaxRegistry(user?.platform_role);
  const canApprove = canApproveTaxRegistry(user?.platform_role);
  const s = version.status;

  const act = async (key, fn) => {
    setBusy(key);
    setError(null);
    try {
      const result = await fn();
      if (result) onChanged(result);
    } catch (err) {
      setError(err?.message || "The action failed.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <InlineError message={error} />
      <DefinitionList rows={[
        ["Market", `${version.jurisdiction_code} · ${version.tax_type} · ${humanize(version.transaction_class)}`],
        ["Mode", humanize(version.mode)], ["Status", <TaxStatusBadge key="s" status={s} />],
        ["Tenant-configured rates", version.tenant_config_permitted ? "Permitted" : "Not permitted"],
        ["Notes", version.notes],
      ]} />
      <ValidationList title="Validation errors" items={version.validation_errors} />
      <div>
        <h3 className={`mb-2 text-sm font-bold ${STRONG}`}>Launch gates</h3>
        {version.mode === "PROVIDER_APPROVED" && (
          <p className={`mb-2 text-xs ${MUTED}`}>Provider market: gate 05 must be PASSED with evidence (rule G1).</p>
        )}
        <ul className="space-y-2">
          {GATES.map((g) => {
            const entry = version.gates?.[g.key] || {};
            return (
              <li key={g.key} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className={`text-sm font-semibold ${STRONG}`}>{g.no} · {g.label}</span>
                  <TaxStatusBadge status={entry.status || "NOT_STARTED"} />
                </div>
                <p className={`mt-1 text-xs ${MUTED}`}>
                  Evidence: {entry.evidence_ref || "—"}{entry.notes ? ` · Notes: ${entry.notes}` : ""}
                </p>
                {problems[g.key].length > 0 && (
                  <p className="mt-1 text-xs text-amber-900 dark:text-amber-200">{problems[g.key].join(" ")}</p>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      <div>
        <h3 className={`mb-2 text-sm font-bold ${STRONG}`}>History</h3>
        <VersionTimeline version={version} />
      </div>
      <ActionBar busyKey={busy} actions={[
        { key: "edit", label: "Amend", hidden: !canWrite || !EDITABLE.includes(s), onClick: onEdit },
        { key: "validate", label: "Validate", hidden: !canWrite || !EDITABLE.includes(s),
          onClick: () => act("validate", () => availabilityAction(version.id, "validate")) },
        { key: "submit", label: "Submit for approval", variant: "primary", hidden: !canWrite || s !== "VALIDATED",
          onClick: () => setReasonFor("submit") },
        { key: "approve", label: "Approve", variant: "primary", hidden: !canApprove || s !== "IN_APPROVAL",
          reason: verdict.loading ? null : verdict.reason, disabled: verdict.loading,
          onClick: () => act("approve", () => stepUp.run((body) => availabilityAction(version.id, "approve", body))) },
        { key: "reject", label: "Reject", hidden: !canApprove || s !== "IN_APPROVAL", onClick: () => setReasonFor("reject") },
        { key: "publish", label: "Publish", variant: "primary", hidden: !canApprove || s !== "APPROVED", reason: fallback,
          onClick: () => act("publish", () => stepUp.run((body) => availabilityAction(version.id, "publish", body))) },
      ]} />
      <ReasonModal open={Boolean(reasonFor)} busy={false} error={null}
                   title={reasonFor === "reject" ? "Reject this availability version" : "Submit for approval"}
                   submitLabel={reasonFor === "reject" ? "Reject" : "Submit"} onCancel={() => setReasonFor(null)}
                   onSubmit={(reason) => { const action = reasonFor; setReasonFor(null);
                     act(action, () => availabilityAction(version.id, action, { reason })); }} />
      {stepUp.modal}
    </>
  );
}

export default function MarketAvailabilityScreen({ user }) {
  const [status, setStatus] = useState("");
  const list = useCursorList(({ cursor }) => listMarketAvailability({ status: status || undefined, cursor }), [status]);
  const [open, setOpen] = useState(null);
  const [form, setForm] = useState(null);
  const canWrite = canWriteTaxRegistry(user?.platform_role);

  const columns = [
    { key: "id", label: "#" },
    { key: "market", label: "Market", render: (r) => `${r.jurisdiction_code} · ${r.tax_type}` },
    { key: "transaction_class", label: "Class", render: (r) => humanize(r.transaction_class) },
    { key: "mode", label: "Mode", render: (r) => humanize(r.mode) },
    { key: "gates", label: "Gates passed", render: (r) => `${GATES.filter((g) => r.gates?.[g.key]?.status === "PASSED").length} of 7` },
    { key: "status", label: "Status", render: (r) => <TaxStatusBadge status={r.status} /> },
  ];

  return (
    <section className={PANEL} aria-labelledby="availability-title">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="availability-title" className={`text-lg font-bold ${STRONG}`}>Market availability</h2>
          <p className={`text-sm ${MUTED}`}>Nothing calculates tax in a market until all seven gates pass and a second person publishes it.</p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="w-48 text-sm">
            <span className={`mb-1 block text-xs font-semibold uppercase tracking-wider ${MUTED}`}>Status</span>
            <Select value={status} onChange={setStatus} options={opts(STATUSES)} placeholder="All statuses" aria-label="Filter by status" />
          </label>
          {canWrite && <Button variant="primary" size="sm" icon={Plus} onClick={() => setForm({ existing: null })}>Draft availability</Button>}
        </div>
      </div>
      <InlineError message={list.error} />
      <TaxTable caption="Market availability versions" columns={columns} rows={list.items} onOpen={setOpen} empty="No availability versions." />
      <LoadMore list={list} noun="versions" />
      <DetailModal open={Boolean(open)} onClose={() => setOpen(null)}
                   title={open ? `Availability #${open.id}` : ""}>
        {open && <AvailabilityDetail version={open} user={user} onEdit={() => setForm({ existing: open })}
                                     onChanged={(updated) => { setOpen(updated); list.reload(); }} />}
      </DetailModal>
      <AvailabilityFormModal open={Boolean(form)} existing={form?.existing} onClose={() => setForm(null)}
                             onDone={(saved) => { setForm(null); if (open) setOpen(saved); list.reload(); }} />
    </section>
  );
}
