import { useCallback, useEffect, useId, useState } from "react";

import { Button, Field, FORM_CONTROL_CLASS, FormGrid, FormModal, Select } from "../../components/billing-ui";
import { canApproveTaxRegistry, ROLE_REASON } from "./access";
import {
  ActionBar, InlineError, MUTED, PANEL, STRONG, TaxStatusBadge, formatDateTime, humanize, useReferenceList, useStepUp,
} from "./shared";
import {
  chooseShadowSelection, endShadowSelection, getShadowAggregate, listRulePacks, listShadowSelections,
} from "./taxRegistryService";

/* Shadow compare, platform side (Phase 7 PR 1): which rule pack (active or
 * draft) shadows use, the tax lead's advisory exit threshold, and the
 * cross-tenant aggregate (counts only, T13). */

function ChooseModal({ open, onClose, onDone }) {
  const base = useId();
  const packs = useReferenceList(listRulePacks, open);
  const stepUp = useStepUp();
  const [form, setForm] = useState({ exit_min_invoices: 50, exit_min_days: 30 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e?.target ? e.target.value : e }));
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { rule_pack_version_id: Number(form.rule_pack_version_id), reason: form.reason || "",
        exit_min_invoices: Number(form.exit_min_invoices), exit_min_days: Number(form.exit_min_days) };
      const row = await stepUp.run((factor) => chooseShadowSelection({ ...body, ...factor }));
      if (row) onDone(row);
    } catch (err) {
      setError(err?.message || "Couldn't choose the pack.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <FormModal open={open} onClose={onClose} onSubmit={submit} busy={busy} error={error} size="lg"
                 title="Choose the pack for shadows" submitLabel="Choose"
                 description="Shadows compare tenants' legacy invoices with this pack. A draft pack is allowed: shadows never issue anything. The exit threshold is advice to tenants, never an automatic switch.">
        <FormGrid>
          <Field label="Rule pack version" htmlFor={`${base}-p`} required>
            <Select id={`${base}-p`} value={form.rule_pack_version_id ?? ""} onChange={set("rule_pack_version_id")} required
                    placeholder="Choose…"
                    options={packs.filter((p) => !["SUPERSEDED", "REJECTED"].includes(p.status))
                      .map((p) => ({ value: p.id, label: `${p.code} v${p.version} (${humanize(p.status)})` }))} />
          </Field>
          <Field label="Exit: at least this many invoices" htmlFor={`${base}-n`} required>
            <input id={`${base}-n`} type="number" min="1" className={FORM_CONTROL_CLASS} value={form.exit_min_invoices}
                   onChange={set("exit_min_invoices")} required />
          </Field>
          <Field label="Exit: over at least this many days" htmlFor={`${base}-d`} required>
            <input id={`${base}-d`} type="number" min="1" className={FORM_CONTROL_CLASS} value={form.exit_min_days}
                   onChange={set("exit_min_days")} required />
          </Field>
          <Field label="Reason" htmlFor={`${base}-r`} required>
            <input id={`${base}-r`} className={FORM_CONTROL_CLASS} value={form.reason ?? ""} onChange={set("reason")} required />
          </Field>
        </FormGrid>
      </FormModal>
      {stepUp.modal}
    </>
  );
}

export default function ShadowSelectionScreen({ user }) {
  const [items, setItems] = useState(null);
  const [aggregate, setAggregate] = useState(null);
  const [error, setError] = useState(null);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(null);
  const approver = canApproveTaxRegistry(user?.platform_role);
  const load = useCallback(() => {
    Promise.all([listShadowSelections(), getShadowAggregate()])
      .then(([s, a]) => { setItems(s.items || []); setAggregate(a); })
      .catch((err) => setError(err?.message || "Couldn't load shadows."));
  }, []);
  useEffect(() => { load(); }, [load]);
  const end = async (id) => {
    setBusy(id);
    try { await endShadowSelection(id); load(); } catch (err) { setError(err?.message); } finally { setBusy(null); }
  };
  return (
    <section className={`${PANEL} space-y-4`} aria-labelledby="shadow-p-title">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 id="shadow-p-title" className={`text-lg font-bold ${STRONG}`}>Shadow compare</h2>
          <p className={`text-sm ${MUTED}`}>The pack tenants' shadows use, and how they are doing (counts only).</p>
        </div>
        <ActionBar actions={[{ key: "choose", label: "Choose pack", variant: "primary",
          reason: approver ? null : ROLE_REASON, onClick: () => setChoosing(true) }]} />
      </div>
      <InlineError message={error} />
      {items && (
        <ul className="space-y-2">
          {items.map((s) => (
            <li key={s.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className={`text-sm font-semibold ${STRONG}`}>{s.pack_code} v{s.pack_version}</span>
                <span className="flex gap-1"><TaxStatusBadge status={s.pack_status} /><TaxStatusBadge status={s.active ? "SHADOWING" : "ENDED"} /></span>
              </div>
              <p className={`text-xs ${MUTED}`}>
                Exit advice: {s.exit_min_invoices} invoices over {s.exit_min_days} days with zero unexplained differences ·
                chosen {formatDateTime(s.chosen_at)}{s.reason ? ` · ${s.reason}` : ""}
              </p>
              {s.active && approver && (
                <Button size="sm" loading={busy === s.id} onClick={() => end(s.id)}>Stop using for shadows</Button>
              )}
            </li>
          ))}
          {!items.length && <li className={`text-sm ${MUTED}`}>No pack chosen: shadows report "no shadow pack".</li>}
        </ul>
      )}
      {aggregate && (
        <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
          <h3 className={`text-sm font-bold ${STRONG}`}>Across tenants</h3>
          <p className={`text-sm ${STRONG}`}>
            {Object.entries(aggregate.enrolments_by_state).map(([k, n]) => `${humanize(k)}: ${n}`).join(" · ") || "No shadows yet"}
          </p>
          <p className={`text-sm ${STRONG}`}>
            {aggregate.compared} invoice(s) compared · match rate {aggregate.match_rate == null ? "—" : `${Math.round(aggregate.match_rate * 1000) / 10}%`}
            {" "}· {aggregate.unexplained} unexplained
          </p>
        </div>
      )}
      <ChooseModal open={choosing} onClose={() => setChoosing(false)} onDone={() => { setChoosing(false); load(); }} />
    </section>
  );
}
