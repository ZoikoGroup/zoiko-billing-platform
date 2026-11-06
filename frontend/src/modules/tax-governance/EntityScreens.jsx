import { useEffect, useId, useState } from "react";
import { AlertTriangle, Plus } from "lucide-react";

import { Button, Field, FORM_CONTROL_CLASS, FormGrid, FormModal, Select } from "../../components/billing-ui";
import {
  DefinitionList, InlineError, LoadMore, MUTED, PANEL, STRONG, TaxStatusBadge, formatDateTime, useCursorList,
} from "../tax-control-center/shared";
import {
  DecisionBar, SectionTitle, isOrgAdmin, useLegalEntities, useTenantNames,
} from "./common";
import {
  createLegalEntity, decideRegimeChange, getRegimeEligibility, listRegimeChanges, proposeRegimeChange,
  setDefaultLegalEntity, updateLegalEntity, withdrawRegimeChange,
} from "./governanceService";

/* T1 Overview, T2 Legal entities and T5 Regime (ZB-TAX-ARCH-001 Phase 5b). */

export function LegacyNotice() {
  return (
    <p className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200">
      <strong>Legacy manual tax:</strong> invoices keep using your Tax Rates settings exactly as today. Nothing on these
      screens changes an invoice until a switch to Governed is proposed and approved by a different finance approver.
    </p>
  );
}

function useEligibility(entities) {
  const [byId, setById] = useState({});
  useEffect(() => {
    let cancelled = false;
    Promise.all(entities.map((e) => getRegimeEligibility(e.id).then((r) => [e.id, r]).catch(() => [e.id, null])))
      .then((pairs) => { if (!cancelled) setById(Object.fromEntries(pairs)); });
    return () => { cancelled = true; };
  }, [entities]);
  return byId;
}

// ── T1 Overview ─────────────────────────────────────────────────────────

export function OverviewScreen() {
  const { entities, error } = useLegalEntities();
  const eligibility = useEligibility(entities);
  const anyLegacy = entities.some((e) => e.tax_regime === "LEGACY_MANUAL");
  return (
    <section className={PANEL} aria-labelledby="t1-title">
      <SectionTitle id="t1-title" title="Overview">
        Each seller entity's tax regime and what still blocks governed issuing.
      </SectionTitle>
      <InlineError message={error} />
      {anyLegacy && <div className="mb-4"><LegacyNotice /></div>}
      <ul className="space-y-3">
        {entities.map((e) => {
          const el = eligibility[e.id];
          return (
            <li key={e.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className={`font-semibold ${STRONG}`}>{e.entity_code} — {e.legal_name}{e.is_default ? " (default)" : ""}</span>
                <TaxStatusBadge status={e.tax_regime} />
              </div>
              {el == null ? (
                <p className={`mt-1 text-sm ${MUTED}`}>Checking readiness…</p>
              ) : el.would_qualify ? (
                <p className="mt-1 text-sm text-emerald-800 dark:text-emerald-200">
                  Ready for governed issuing: {el.effective_activations.length} activation(s) in effect.
                </p>
              ) : (
                <div className="mt-1">
                  <p className={`text-sm font-semibold ${STRONG}`}>What blocks governed issuing:</p>
                  <ul className="mt-1 list-disc pl-5 text-sm text-amber-900 dark:text-amber-200">
                    {el.unmet_conditions.map((c) => <li key={c}>{c}</li>)}
                  </ul>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ── T2 Legal entities ───────────────────────────────────────────────────

const ENTITY_FIELDS = ["entity_code", "legal_name", "country_code", "subdivision_code", "timezone",
                       "address_line1", "city", "postal_code", "primary_tax_id"];

function EntityFormModal({ open, existing, onClose, onDone }) {
  const base = useId();
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (open) { setError(null); setForm(Object.fromEntries(ENTITY_FIELDS.map((f) => [f, existing?.[f] ?? ""]))); }
  }, [open, existing]);
  const submit = async () => {
    setBusy(true);
    setError(null);
    const body = Object.fromEntries(Object.entries(form).filter(([, v]) => v !== ""));
    try {
      onDone(existing ? await updateLegalEntity(existing.id, { ...body, expected_version: existing.version })
        : await createLegalEntity(body));
    } catch (err) {
      setError(err?.message || "Couldn't save the entity.");
    } finally {
      setBusy(false);
    }
  };
  const labels = { entity_code: "Entity code", legal_name: "Legal name", country_code: "Country (ISO 2)",
                   subdivision_code: "State / province", timezone: "Timezone", address_line1: "Address",
                   city: "City", postal_code: "Postal code", primary_tax_id: "Primary tax ID" };
  return (
    <FormModal open={open} onClose={onClose} onSubmit={submit} busy={busy} error={error} size="lg" icon={Plus}
               title={existing ? `Edit ${existing.entity_code}` : "Add a seller entity"}
               submitLabel={existing ? "Save changes" : "Add entity"}
               description="The tax regime is changed on the Regime screen, never here.">
      <FormGrid>
        {ENTITY_FIELDS.map((f) => (
          <Field key={f} label={labels[f]} htmlFor={`${base}-${f}`} required={!existing && (f === "entity_code" || f === "legal_name")}>
            <input id={`${base}-${f}`} className={FORM_CONTROL_CLASS} value={form[f] ?? ""}
                   required={!existing && (f === "entity_code" || f === "legal_name")}
                   maxLength={f === "country_code" ? 2 : undefined}
                   onChange={(e) => setForm((v) => ({ ...v, [f]: e.target.value }))} />
          </Field>
        ))}
      </FormGrid>
    </FormModal>
  );
}

export function EntitiesScreen({ user }) {
  const [reload, setReload] = useState(0);
  const { entities, error } = useLegalEntities(reload);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(null);
  const [actionError, setActionError] = useState(null);
  const admin = isOrgAdmin(user?.role);
  const makeDefault = async (e) => {
    setBusy(e.id);
    setActionError(null);
    try { await setDefaultLegalEntity(e.id); setReload((n) => n + 1); }
    catch (err) { setActionError(err?.message || "Couldn't change the default."); }
    finally { setBusy(null); }
  };
  return (
    <section className={PANEL} aria-labelledby="t2-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SectionTitle id="t2-title" title="Legal entities">The entities that issue your invoices. Organization admins manage them.</SectionTitle>
        {admin && <Button variant="primary" size="sm" icon={Plus} onClick={() => setForm({ existing: null })}>Add entity</Button>}
      </div>
      <InlineError message={error || actionError} />
      <ul className="space-y-3">
        {entities.map((e) => (
          <li key={e.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className={`font-semibold ${STRONG}`}>{e.entity_code} — {e.legal_name}</span>
              <TaxStatusBadge status={e.tax_regime} />
            </div>
            <DefinitionList rows={[
              ["Country", [e.country_code, e.subdivision_code].filter(Boolean).join("-") || null],
              ["Timezone", e.timezone], ["Primary tax ID", e.primary_tax_id],
              ["Default issuing entity", e.is_default ? "Yes" : "No"],
            ]} />
            {admin && (
              <div className="mt-2 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => setForm({ existing: e })}>Edit</Button>
                {!e.is_default && <Button size="sm" loading={busy === e.id} onClick={() => makeDefault(e)}>Make default</Button>}
              </div>
            )}
          </li>
        ))}
      </ul>
      <EntityFormModal open={Boolean(form)} existing={form?.existing} onClose={() => setForm(null)}
                       onDone={() => { setForm(null); setReload((n) => n + 1); }} />
    </section>
  );
}

// ── T5 Regime ───────────────────────────────────────────────────────────

function RegimeProposeModal({ open, entity, eligibility, onClose, onDone }) {
  const id = useId();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const target = entity?.tax_regime === "GOVERNED" ? "LEGACY_MANUAL" : "GOVERNED";
  useEffect(() => { if (open) { setReason(""); setError(null); } }, [open]);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try { onDone(await proposeRegimeChange(entity.id, { tax_regime: target, reason: reason || undefined })); }
    catch (err) { setError(err?.message || "Couldn't propose the change."); }
    finally { setBusy(false); }
  };
  return (
    <FormModal open={open} onClose={onClose} onSubmit={submit} busy={busy} error={error} icon={AlertTriangle}
               title={`Propose switching ${entity?.entity_code} to ${target === "GOVERNED" ? "Governed" : "Legacy manual"}`}
               submitLabel="Propose switch"
               description="A different finance approver must approve it; nothing changes until then.">
      <div role="note" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
        <p className="flex items-start gap-1.5 font-semibold"><AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden="true" />When it is approved:</p>
        <ul className="mt-1 list-disc pl-6">
          <li>open draft invoices' tax quotes go stale and must be re-quoted before issue;</li>
          <li>invoices already issued never change.</li>
        </ul>
      </div>
      {target === "GOVERNED" && eligibility && !eligibility.would_qualify && (
        <div>
          <p className={`text-sm font-semibold ${STRONG}`}>This entity doesn't qualify yet:</p>
          <ul className="mt-1 list-disc pl-5 text-sm text-red-800 dark:text-red-200">
            {eligibility.unmet_conditions.map((c) => <li key={c}>{c}</li>)}
          </ul>
        </div>
      )}
      <Field label="Reason" htmlFor={id} hint="Recorded with the proposal.">
        <textarea id={id} rows={2} className={FORM_CONTROL_CLASS} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </FormModal>
  );
}

export function RegimeScreen({ user }) {
  const [reload, setReload] = useState(0);
  const { entities, error } = useLegalEntities(reload);
  const eligibility = useEligibility(entities);
  const [entityId, setEntityId] = useState("");
  const entity = entities.find((e) => String(e.id) === String(entityId)) || entities[0];
  const changes = useCursorList(({ cursor }) => listRegimeChanges({ seller_entity_id: entity?.id, cursor }), [entity?.id, reload]);
  const [proposing, setProposing] = useState(false);
  const nameOf = useTenantNames();
  const el = entity ? eligibility[entity.id] : null;
  const open = changes.items.some((c) => c.status === "PROPOSED");
  return (
    <section className={PANEL} aria-labelledby="t5-title">
      <SectionTitle id="t5-title" title="Regime">
        Switching between legacy manual and governed tax needs two people, in either direction.
      </SectionTitle>
      <InlineError message={error || changes.error} />
      <div className="mb-3 max-w-sm">
        <Field label="Seller entity" htmlFor="t5-entity">
          <Select id="t5-entity" value={entity?.id ?? ""} onChange={setEntityId} placeholder=""
                  options={entities.map((e) => ({ value: e.id, label: `${e.entity_code} — ${e.legal_name}` }))} />
        </Field>
      </div>
      {entity && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`text-sm ${STRONG}`}>Current regime:</span><TaxStatusBadge status={entity.tax_regime} />
          </div>
          <div className="mt-3">
            <p className={`text-sm font-semibold ${STRONG}`}>Eligibility for governed tax</p>
            {el == null ? <p className={`text-sm ${MUTED}`}>Checking…</p> : el.would_qualify ? (
              <p className="text-sm text-emerald-800 dark:text-emerald-200">Qualifies: {el.backing_activations.length} activation(s) back it.</p>
            ) : (
              <ul className="mt-1 list-disc pl-5 text-sm text-amber-900 dark:text-amber-200">
                {el.unmet_conditions.map((c) => <li key={c}>{c}</li>)}
              </ul>
            )}
          </div>
          {isOrgAdmin(user?.role) && (
            <div className="mt-3">
              <Button variant="primary" size="sm" disabled={open} onClick={() => setProposing(true)}
                      aria-describedby={open ? "t5-open" : undefined}>
                {entity.tax_regime === "GOVERNED" ? "Propose switch to legacy manual" : "Propose switch to governed"}
              </Button>
              {open && <p id="t5-open" className={`mt-1 text-xs ${MUTED}`}>A regime change is already awaiting a decision.</p>}
            </div>
          )}
          <h3 className={`mt-5 mb-2 text-sm font-bold ${STRONG}`}>Regime changes</h3>
          <ul className="space-y-2">
            {changes.items.map((c) => (
              <li key={c.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className={`text-sm font-semibold ${STRONG}`}>{c.from_regime} → {c.to_regime}</span>
                  <TaxStatusBadge status={c.status} />
                </div>
                <p className={`text-xs ${MUTED}`}>
                  Proposed by {nameOf(c.proposed_by)} · {formatDateTime(c.created_at)}
                  {c.approved_by ? ` · decided by ${nameOf(c.approved_by)}` : ""}{c.reason ? ` · ${c.reason}` : ""}
                </p>
                <DecisionBar user={user} record={c} proposerId={c.proposed_by} noun="regime change"
                             decide={decideRegimeChange} withdraw={withdrawRegimeChange} withdrawRoles={["org_admin"]}
                             onDone={() => setReload((n) => n + 1)} />
              </li>
            ))}
          </ul>
          <LoadMore list={changes} noun="changes" />
        </>
      )}
      <RegimeProposeModal open={proposing} entity={entity} eligibility={el} onClose={() => setProposing(false)}
                          onDone={() => { setProposing(false); setReload((n) => n + 1); }} />
    </section>
  );
}
