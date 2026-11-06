import { useId, useMemo, useState } from "react";
import { Plus } from "lucide-react";

import { Button, Field, FORM_CONTROL_CLASS, FormGrid, FormModal, Select } from "../../components/billing-ui";
import {
  InlineError, LoadMore, MUTED, PANEL, STRONG, TaxStatusBadge, humanize, useCursorList,
  useReferenceList,
} from "../tax-control-center/shared";
import {
  DecisionBar, EntitySelect, EvidenceUpload, SectionTitle, canPropose, useLegalEntities, useTenantNames,
} from "./common";
import {
  createRegistration, decideActivation, decideLegalBasis, getActivationEffective, listActivations, listCoverage,
  listJurisdictions, listLegalBases, listProviderConnections, listRegistrations, listTaxTypes, proposeActivation,
  proposeLegalBasis, withdrawActivation, withdrawLegalBasis,
} from "./governanceService";

/* T3 Registrations and legal bases, T4 Activations (Phase 5b). */

const CLASSES = ["B2B_SERVICES", "B2C_SERVICES", "B2B_DIGITAL", "B2C_DIGITAL", "B2B_GOODS", "B2C_GOODS"];
const ACTIVATABLE = ["TENANT_CONFIG_APPROVED", "NATIVE_RULEPACK_APPROVED", "PROVIDER_APPROVED"];
const opts = (values) => values.map((v) => ({ value: v, label: humanize(v) }));

function useRefs(open) {
  const jurisdictions = useReferenceList(listJurisdictions, open);
  const taxTypes = useReferenceList(listTaxTypes, open);
  return { jurisdictions, taxTypes };
}

function SimpleForm({ open, title, fields, onClose, onSubmit, submitLabel, description }) {
  const base = useId();
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));
  const submit = async () => {
    setBusy(true);
    setError(null);
    try { await onSubmit(form); setForm({}); }
    catch (err) { setError(err?.message || "Couldn't save."); }
    finally { setBusy(false); }
  };
  return (
    <FormModal open={open} onClose={onClose} onSubmit={submit} busy={busy} error={error} title={title} icon={Plus}
               submitLabel={submitLabel} description={description} size="lg">
      <FormGrid>
        {fields.filter((f) => !f.hidden?.(form)).map((f) => (
          <Field key={f.key} label={f.label} htmlFor={`${base}-${f.key}`} required={f.required} hint={f.hint}>
            {f.options ? (
              <Select id={`${base}-${f.key}`} value={form[f.key] ?? ""} onChange={set(f.key)} required={f.required}
                      placeholder="Choose…" options={typeof f.options === "function" ? f.options(form) : f.options} />
            ) : (
              <input id={`${base}-${f.key}`} type={f.type || "text"} className={FORM_CONTROL_CLASS} value={form[f.key] ?? ""}
                     onChange={set(f.key)} required={f.required} />
            )}
          </Field>
        ))}
      </FormGrid>
    </FormModal>
  );
}

const jurOpts = (list) => list.map((j) => ({ value: j.id, label: `${j.code} — ${j.name}` }));
const typeOpts = (list) => list.map((t) => ({ value: t.id, label: `${t.code} — ${t.name}` }));
const num = (v) => (v === "" || v == null ? undefined : Number(v));
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== "" && v !== undefined));

// ── T3 ──────────────────────────────────────────────────────────────────

export function ObligationsScreen({ user }) {
  const { entities } = useLegalEntities();
  const [entityId, setEntityId] = useState("");
  const [reload, setReload] = useState(0);
  const regs = useCursorList(({ cursor }) => listRegistrations({ seller_entity_id: entityId || undefined, cursor }), [entityId, reload]);
  const bases = useCursorList(({ cursor }) => listLegalBases({ cursor }), [reload]);
  const [adding, setAdding] = useState(null);
  const refs = useRefs(true);
  const nameOf = useTenantNames();
  const proposer = canPropose(user?.role);
  const jName = (id) => refs.jurisdictions.find((j) => j.id === id)?.code || `#${id}`;
  const tName = (id) => refs.taxTypes.find((t) => t.id === id)?.code || `#${id}`;
  const shownBases = bases.items.filter((b) => !entityId || String(b.seller_entity_id) === String(entityId));
  const common = [
    { key: "seller_entity_id", label: "Seller entity", required: true,
      options: entities.map((e) => ({ value: e.id, label: `${e.entity_code} — ${e.legal_name}` })) },
    { key: "jurisdiction_id", label: "Jurisdiction", required: true, options: jurOpts(refs.jurisdictions) },
    { key: "tax_type_id", label: "Tax type", required: true, options: typeOpts(refs.taxTypes) },
  ];
  const done = () => { setAdding(null); setReload((n) => n + 1); };

  return (
    <section className={PANEL} aria-labelledby="t3-title">
      <SectionTitle id="t3-title" title="Registrations and legal bases">
        Where each entity is registered for tax, or the legal basis for charging it. An activation needs one of them.
      </SectionTitle>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <div className="w-72"><EntitySelect entities={entities} value={entityId} onChange={setEntityId} /></div>
        {proposer && <Button variant="primary" size="sm" icon={Plus} onClick={() => setAdding("registration")}>Add registration</Button>}
        {proposer && <Button size="sm" icon={Plus} onClick={() => setAdding("basis")}>Propose legal basis</Button>}
      </div>
      <InlineError message={regs.error || bases.error} />
      <h3 className={`mb-2 text-sm font-bold ${STRONG}`}>Registrations</h3>
      <ul className="space-y-2">
        {regs.items.map((r) => (
          <li key={r.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className={`text-sm font-semibold ${STRONG}`}>{r.jurisdiction_code} · {r.tax_type} · {r.registration_number}</span>
              <span className="flex gap-1"><TaxStatusBadge status={r.status} /><TaxStatusBadge status={r.verification_status} /></span>
            </div>
            <p className={`text-xs ${MUTED}`}>
              Valid {r.valid_from} → {r.valid_to || "open"} · recorded by {nameOf(r.created_by)} · evidence{" "}
              {r.evidence_attached ? "document attached" : r.evidence_ref ? `ref ${r.evidence_ref}` : "none"}
            </p>
            {proposer && !r.evidence_attached && (
              <div className="mt-2"><EvidenceUpload kind="registrations" id={r.id} label="Registration certificate" onDone={() => setReload((n) => n + 1)} /></div>
            )}
          </li>
        ))}
      </ul>
      <LoadMore list={regs} noun="registrations" />
      <h3 className={`mt-5 mb-2 text-sm font-bold ${STRONG}`}>Legal bases</h3>
      <ul className="space-y-2">
        {shownBases.map((b) => (
          <li key={b.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className={`text-sm font-semibold ${STRONG}`}>{jName(b.jurisdiction_id)} · {tName(b.tax_type_id)}</span>
              <TaxStatusBadge status={b.status} />
            </div>
            <p className={`text-sm ${STRONG}`}>{b.legal_basis}</p>
            <p className={`text-xs ${MUTED}`}>
              Valid {b.valid_from} → {b.valid_to || "open"} · proposed by {nameOf(b.recorded_by)}
              {b.approved_by ? ` · decided by ${nameOf(b.approved_by)}` : ""} · evidence {b.evidence_attached ? "document attached" : `ref ${b.evidence_ref}`}
            </p>
            {proposer && b.status === "PROPOSED" && !b.evidence_attached && (
              <div className="mt-2"><EvidenceUpload kind="legal-bases" id={b.id} label="Supporting document" onDone={() => setReload((n) => n + 1)} /></div>
            )}
            <DecisionBar user={user} record={b} proposerId={b.recorded_by} noun="legal basis"
                         decide={decideLegalBasis} withdraw={withdrawLegalBasis} onDone={() => setReload((n) => n + 1)} />
          </li>
        ))}
      </ul>
      <LoadMore list={bases} noun="legal bases" />

      <SimpleForm open={adding === "registration"} title="Add a registration" submitLabel="Add registration"
                  onClose={() => setAdding(null)}
                  fields={[...common,
                    { key: "registration_number", label: "Registration number", required: true },
                    { key: "valid_from", label: "Valid from", type: "date", required: true },
                    { key: "valid_to", label: "Valid to (exclusive)", type: "date" },
                    { key: "evidence_ref", label: "Evidence reference" }]}
                  onSubmit={async (f) => { await createRegistration(clean({ ...f, seller_entity_id: num(f.seller_entity_id),
                    jurisdiction_id: num(f.jurisdiction_id), tax_type_id: num(f.tax_type_id) })); done(); }} />
      <SimpleForm open={adding === "basis"} title="Propose a legal basis" submitLabel="Propose"
                  description="For charging tax without a registration. A different finance approver decides it."
                  onClose={() => setAdding(null)}
                  fields={[...common,
                    { key: "legal_basis", label: "Legal basis", required: true, hint: "Cite the provision." },
                    { key: "evidence_ref", label: "Evidence reference", required: true },
                    { key: "valid_from", label: "Valid from", type: "date", required: true },
                    { key: "valid_to", label: "Valid to (exclusive)", type: "date" }]}
                  onSubmit={async (f) => { await proposeLegalBasis(clean({ ...f, seller_entity_id: num(f.seller_entity_id),
                    jurisdiction_id: num(f.jurisdiction_id), tax_type_id: num(f.tax_type_id) })); done(); }} />
    </section>
  );
}

// ── T4 ──────────────────────────────────────────────────────────────────

function Effective({ activation }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState(null);
  const check = () => getActivationEffective(activation.id).then(setState).catch((e) => setError(e?.message));
  return (
    <div className="mt-2">
      {state ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <TaxStatusBadge status={state.effective ? "EFFECTIVE" : "NOT_EFFECTIVE"} />
          {!state.effective && <span className="text-amber-900 dark:text-amber-200">{(state.reasons || []).join("; ")}</span>}
        </div>
      ) : <Button size="sm" onClick={check}>Check if in effect today</Button>}
      <InlineError message={error} />
    </div>
  );
}

export function ActivationsScreen({ user }) {
  const { entities } = useLegalEntities();
  const [entityId, setEntityId] = useState("");
  const [reload, setReload] = useState(0);
  const list = useCursorList(({ cursor }) => listActivations({ seller_entity_id: entityId || undefined, cursor }), [entityId, reload]);
  const [proposing, setProposing] = useState(false);
  const refs = useRefs(proposing);
  const coverage = useReferenceList(listCoverage, proposing);
  const connections = useReferenceList(listProviderConnections, proposing);
  const regs = useReferenceList(listRegistrations, proposing);
  const bases = useReferenceList(listLegalBases, proposing);
  const nameOf = useTenantNames();
  const proposer = canPropose(user?.role);

  const offered = useMemo(() => (form) => {
    const j = refs.jurisdictions.find((x) => String(x.id) === String(form.jurisdiction_id));
    const t = refs.taxTypes.find((x) => String(x.id) === String(form.tax_type_id));
    const cell = coverage.find((c) => c.jurisdiction_code === j?.code && c.tax_type === t?.code && c.transaction_class === form.transaction_class);
    return cell && ACTIVATABLE.includes(cell.mode)
      ? [{ value: cell.mode, label: `${humanize(cell.mode)} (offered by the platform)` }]
      : [];
  }, [refs.jurisdictions, refs.taxTypes, coverage]);

  return (
    <section className={PANEL} aria-labelledby="t4-title">
      <SectionTitle id="t4-title" title="Activations">
        Turn on calculation for a market the platform offers. Needs a registration or approved legal basis, and a
        different finance approver.
      </SectionTitle>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <div className="w-72"><EntitySelect entities={entities} value={entityId} onChange={setEntityId} /></div>
        {proposer && <Button variant="primary" size="sm" icon={Plus} onClick={() => setProposing(true)}>Propose activation</Button>}
      </div>
      <InlineError message={list.error} />
      <ul className="space-y-2">
        {list.items.map((a) => (
          <li key={a.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className={`text-sm font-semibold ${STRONG}`}>{a.jurisdiction_code} · {a.tax_type} · {humanize(a.transaction_class)}</span>
              <TaxStatusBadge status={a.status} />
            </div>
            <p className={`text-xs ${MUTED}`}>
              {humanize(a.mode)} from {a.effective_from}{a.effective_to ? ` to ${a.effective_to}` : ""}
              {a.provider_connection_id ? ` · provider connection #${a.provider_connection_id}` : ""}
              {a.registration_id ? ` · registration #${a.registration_id}` : a.legal_basis_id ? ` · legal basis #${a.legal_basis_id}` : ""}
              {" "}· proposed by {nameOf(a.proposed_by)}{a.approved_by ? ` · decided by ${nameOf(a.approved_by)}` : ""}
            </p>
            {a.verification_label && <p className="text-xs text-amber-900 dark:text-amber-200">{a.verification_label}</p>}
            {a.status === "APPROVED" && <Effective activation={a} />}
            <DecisionBar user={user} record={a} proposerId={a.proposed_by} noun="activation"
                         decide={decideActivation} withdraw={withdrawActivation} onDone={() => setReload((n) => n + 1)} />
          </li>
        ))}
      </ul>
      <LoadMore list={list} noun="activations" />
      <SimpleForm open={proposing} title="Propose an activation" submitLabel="Propose" onClose={() => setProposing(false)}
                  description="Only the mode the platform has published for this market can be chosen."
                  fields={[
                    { key: "seller_entity_id", label: "Seller entity", required: true,
                      options: entities.map((e) => ({ value: e.id, label: `${e.entity_code} — ${e.legal_name}` })) },
                    { key: "jurisdiction_id", label: "Jurisdiction", required: true, options: jurOpts(refs.jurisdictions) },
                    { key: "tax_type_id", label: "Tax type", required: true, options: typeOpts(refs.taxTypes) },
                    { key: "transaction_class", label: "Transaction class", required: true, options: opts(CLASSES) },
                    { key: "mode", label: "Mode", required: true, options: offered,
                      hint: "Empty means the platform doesn't offer calculation for this market yet." },
                    { key: "effective_from", label: "Effective from", type: "date", required: true },
                    { key: "registration_id", label: "Registration",
                      options: (f) => regs.filter((r) => String(r.seller_entity_id) === String(f.seller_entity_id))
                        .map((r) => ({ value: r.id, label: `${r.jurisdiction_code} ${r.tax_type} ${r.registration_number}` })) },
                    { key: "legal_basis_id", label: "Or approved legal basis",
                      options: (f) => bases.filter((b) => b.status === "APPROVED" && String(b.seller_entity_id) === String(f.seller_entity_id))
                        .map((b) => ({ value: b.id, label: `#${b.id} ${b.legal_basis.slice(0, 40)}` })) },
                    { key: "provider_connection_id", label: "Provider connection", hidden: (f) => f.mode !== "PROVIDER_APPROVED",
                      options: (f) => connections.filter((c) => c.status === "APPROVED" && String(c.seller_entity_id) === String(f.seller_entity_id))
                        .map((c) => ({ value: c.id, label: `${c.provider_name} (${c.environment.toLowerCase()})` })) },
                    { key: "tenant_rate_percent", label: "Your rate %", hidden: (f) => f.mode !== "TENANT_CONFIG_APPROVED" },
                    { key: "tenant_source_citation", label: "Source citation", hidden: (f) => f.mode !== "TENANT_CONFIG_APPROVED" },
                  ]}
                  onSubmit={async (f) => {
                    await proposeActivation(clean({ ...f, seller_entity_id: num(f.seller_entity_id), jurisdiction_id: num(f.jurisdiction_id),
                      tax_type_id: num(f.tax_type_id), registration_id: num(f.registration_id), legal_basis_id: num(f.legal_basis_id),
                      provider_connection_id: num(f.provider_connection_id) }));
                    setProposing(false); setReload((n) => n + 1);
                  }} />
    </section>
  );
}
