import { useCallback, useEffect, useId, useState } from "react";
import { Plus, Search } from "lucide-react";

import { Button, Field, FORM_CONTROL_CLASS, FormGrid, FormModal, Select } from "../../components/billing-ui";
import {
  InlineError, LoadMore, MUTED, PANEL, STRONG, TaxStatusBadge, formatDateTime, humanize, useCursorList,
  useReferenceList,
} from "../tax-control-center/shared";
import { DecisionBar, EvidenceUpload, SectionTitle, TenantEvidenceExport, canPropose, useTenantNames } from "./common";
import {
  addCertificate, addTaxId, decideClassification, decideManualResolution, getCustomerTaxEvidence, listJurisdictions,
  listClassifications, listManualResolutions, listReviewItems, listTaxCodes, previewClassificationImpact,
  proposeClassification, proposeManualResolution, recordTaxAddress, resolveReviewItem, resolveTaxAddress,
  retireTaxId, revokeCertificate, searchCustomers, searchProducts, withdrawClassification, withdrawManualResolution,
} from "./governanceService";

/* T6 Product classification, T7 Customer tax evidence, T8 Review items (Phase 5b). */

const itemsOf = (data) => data?.items || (Array.isArray(data) ? data : []);
const today = () => new Date().toISOString().slice(0, 10);

function SearchPicker({ label, search, describe, onPick }) {
  const id = useId();
  const [term, setTerm] = useState("");
  const [results, setResults] = useState([]);
  const [error, setError] = useState(null);
  const run = async (e) => {
    e?.preventDefault();
    setError(null);
    try { setResults(itemsOf(await search(term))); } catch (err) { setError(err?.message); }
  };
  return (
    <form onSubmit={run} className="space-y-2" aria-label={`Find ${label.toLowerCase()}`}>
      <div className="flex flex-wrap items-end gap-2">
        <Field label={label} htmlFor={id} className="w-72">
          <input id={id} className={FORM_CONTROL_CLASS} value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search…" />
        </Field>
        <Button type="submit" size="sm" icon={Search}>Search</Button>
      </div>
      <InlineError message={error} />
      {results.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {results.map((r) => (
            <li key={r.id}><Button size="sm" onClick={() => { onPick(r); setResults([]); }}>{describe(r)}</Button></li>
          ))}
        </ul>
      )}
    </form>
  );
}

// ── T6 ──────────────────────────────────────────────────────────────────

function ImpactPreview({ productId }) {
  const [impact, setImpact] = useState(null);
  const [error, setError] = useState(null);
  const run = () => previewClassificationImpact([productId]).then(setImpact).catch((e) => setError(e?.message));
  if (!impact) return (
    <div className="mt-2"><Button size="sm" onClick={run}>Preview impact</Button><InlineError message={error} /></div>
  );
  const drafts = impact.draft_invoices || [];
  const quotes = impact.open_quotes || [];
  return (
    <div className="mt-2 rounded-lg border border-slate-200 p-2 text-sm dark:border-slate-700" role="status">
      <p className={STRONG}>If approved: {drafts.length} draft invoice(s) and {quotes.length} open quote(s) must be re-quoted.</p>
      {drafts.length > 0 && <p className={`text-xs ${MUTED}`}>Drafts: {drafts.map((d) => d.invoice_number || `#${d.id}`).join(", ")}</p>}
      {quotes.length > 0 && <p className={`text-xs ${MUTED}`}>Quotes: {quotes.map((q) => q.quote_number || `#${q.id}`).join(", ")}</p>}
    </div>
  );
}

export function ClassificationScreen({ user }) {
  const [reload, setReload] = useState(0);
  const list = useCursorList(({ cursor }) => listClassifications({ cursor }), [reload]);
  const [codes, setCodes] = useState([]);
  const [proposing, setProposing] = useState(false);
  const [product, setProduct] = useState(null);
  const [codeId, setCodeId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const nameOf = useTenantNames();
  const codeFieldId = useId();
  const reasonId = useId();
  useEffect(() => { listTaxCodes().then((d) => setCodes(d?.items || [])).catch(() => {}); }, []);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await proposeClassification({ product_id: product.id, tax_code_id: Number(codeId), ...(reason ? { reason } : {}) });
      setProposing(false); setProduct(null); setCodeId(""); setReason(""); setReload((n) => n + 1);
    } catch (err) { setError(err?.message || "Couldn't propose."); } finally { setBusy(false); }
  };
  return (
    <section className={PANEL} aria-labelledby="t6-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <SectionTitle id="t6-title" title="Product classification">
          Each product's tax code decides how it is taxed. A change re-prices open drafts; preview the impact before approving.
        </SectionTitle>
        {canPropose(user?.role) && <Button variant="primary" size="sm" icon={Plus} onClick={() => setProposing(true)}>Propose classification</Button>}
      </div>
      <InlineError message={list.error} />
      <ul className="space-y-2">
        {list.items.map((c) => (
          <li key={c.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className={`text-sm font-semibold ${STRONG}`}>{c.product_name || `Product #${c.product_id}`} → {c.tax_code} ({humanize(c.supply_category)})</span>
              <TaxStatusBadge status={c.status} />
            </div>
            <p className={`text-xs ${MUTED}`}>
              Proposed by {nameOf(c.proposed_by)} · {formatDateTime(c.created_at)}{c.reason ? ` · ${c.reason}` : ""}
              {c.approved_by ? ` · decided by ${nameOf(c.approved_by)}` : ""}
            </p>
            {c.status === "PROPOSED" && <ImpactPreview productId={c.product_id} />}
            <DecisionBar user={user} record={c} proposerId={c.proposed_by} noun="classification"
                         decide={decideClassification} withdraw={withdrawClassification} onDone={() => setReload((n) => n + 1)} />
            <TenantEvidenceExport user={user} kind="classification" id={c.id} />
          </li>
        ))}
      </ul>
      <LoadMore list={list} noun="classifications" />
      <FormModal open={proposing} onClose={() => setProposing(false)} onSubmit={submit} busy={busy} error={error}
                 title="Propose a product classification" submitLabel="Propose" icon={Plus}
                 description="A different finance approver decides it.">
        {product ? (
          <p className={`text-sm ${STRONG}`}>Product: <strong>{product.name}</strong> (#{product.id}) <Button size="sm" onClick={() => setProduct(null)}>Change</Button></p>
        ) : (
          <SearchPicker label="Product" search={searchProducts} describe={(p) => `${p.name}${p.code ? ` (${p.code})` : ""}`} onPick={setProduct} />
        )}
        <Field label="Tax code" htmlFor={codeFieldId} required>
          <Select id={codeFieldId} value={codeId} onChange={setCodeId} required placeholder="Choose…"
                  options={codes.map((c) => ({ value: c.id, label: `${c.code} — ${c.name} (${humanize(c.supply_category)})` }))} />
        </Field>
        <Field label="Reason" htmlFor={reasonId}>
          <input id={reasonId} className={FORM_CONTROL_CLASS} value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </FormModal>
    </section>
  );
}

// ── T7 ──────────────────────────────────────────────────────────────────

/** RESOLVED / AMBIGUOUS / NOT_FOUND from the resolution, STALE when past valid_until, NOT_RESOLVED when none. */
export function resolutionState(resolution, now = new Date()) {
  if (!resolution) return "NOT_RESOLVED";
  if (resolution.status === "RESOLVED" && resolution.valid_until && new Date(resolution.valid_until) <= now) return "STALE";
  return resolution.status;
}

function ManualResolutions({ user, address, customerId, onChanged }) {
  const nameOf = useTenantNames();
  const [reload, setReload] = useState(0);
  const list = useCursorList(({ cursor }) => listManualResolutions({ address_id: address.id, cursor }), [address.id, reload]);
  const [codes, setCodes] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState(null);
  const codesId = useId();
  const reasonId = useId();
  const state = resolutionState(address.resolution);
  const canRequest = canPropose(user?.role) && ["AMBIGUOUS", "NOT_FOUND"].includes(state)
    && !list.items.some((m) => m.status === "PROPOSED");
  const propose = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      await proposeManualResolution(customerId, address.id, {
        jurisdiction_codes: codes.split(",").map((c) => c.trim()).filter(Boolean), reason });
      setCodes(""); setReason(""); setReload((n) => n + 1);
    } catch (err) { setError(err?.message || "Couldn't request a manual resolution."); }
  };
  return (
    <div className="mt-2 space-y-2">
      {list.items.map((m) => (
        <div key={m.id} className="rounded-lg border border-slate-200 p-2 dark:border-slate-700">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className={`text-sm ${STRONG}`}>Manual resolution #{m.id}: {m.jurisdiction_codes.join(" › ")}</span>
            <TaxStatusBadge status={m.status} />
          </div>
          <p className={`text-xs ${MUTED}`}>{m.reason} · proposed by {nameOf(m.proposed_by)} · evidence {m.evidence_attached ? "attached" : "missing"}</p>
          {m.status === "PROPOSED" && !m.evidence_attached && canPropose(user?.role) && (
            <EvidenceUpload kind="manual-resolutions" id={m.id} label="Lookup evidence" onDone={() => setReload((n) => n + 1)} />
          )}
          <DecisionBar user={user} record={m} proposerId={m.proposed_by} noun="manual resolution"
                       decide={decideManualResolution} withdraw={withdrawManualResolution}
                       onDone={() => { setReload((n) => n + 1); onChanged(); }} />
        </div>
      ))}
      {canRequest && (
        <form onSubmit={propose} className="space-y-2" aria-label="Request a manual resolution">
          <p className={`text-xs ${MUTED}`}>The resolver couldn't place this address. Propose the districts (country first) with evidence; a different finance approver decides.</p>
          <InlineError message={error} />
          <FormGrid>
            <Field label="Jurisdiction codes" htmlFor={codesId} required hint="Comma-separated, e.g. US, US-CA, US-CA-LA">
              <input id={codesId} className={FORM_CONTROL_CLASS} value={codes} onChange={(e) => setCodes(e.target.value)} required />
            </Field>
            <Field label="Reason" htmlFor={reasonId} required>
              <input id={reasonId} className={FORM_CONTROL_CLASS} value={reason} onChange={(e) => setReason(e.target.value)} required />
            </Field>
          </FormGrid>
          <Button type="submit" size="sm">Request manual resolution</Button>
        </form>
      )}
    </div>
  );
}

function AddForm({ title, fields, onSubmit, submitLabel }) {
  const base = useId();
  const [form, setForm] = useState({});
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try { await onSubmit(form); setForm({}); setOpen(false); }
    catch (err) { setError(err?.message || "Couldn't save."); }
    finally { setBusy(false); }
  };
  return (
    <>
      <Button size="sm" icon={Plus} onClick={() => setOpen(true)}>{title}</Button>
      <FormModal open={open} onClose={() => setOpen(false)} onSubmit={submit} busy={busy} error={error} title={title}
                 submitLabel={submitLabel}>
        <FormGrid>
          {fields.map((f) => (
            <Field key={f.key} label={f.label} htmlFor={`${base}-${f.key}`} required={f.required}>
              {f.options ? (
                <Select id={`${base}-${f.key}`} value={form[f.key] ?? ""} onChange={(v) => setForm((x) => ({ ...x, [f.key]: v }))}
                        required={f.required} placeholder="Choose…" options={f.options} />
              ) : (
                <input id={`${base}-${f.key}`} type={f.type || "text"} className={FORM_CONTROL_CLASS} value={form[f.key] ?? ""}
                       required={f.required} onChange={(e) => setForm((x) => ({ ...x, [f.key]: e.target.value }))} />
              )}
            </Field>
          ))}
        </FormGrid>
      </FormModal>
    </>
  );
}

export function CustomerEvidenceScreen({ user }) {
  const [customer, setCustomer] = useState(null);
  const [evidence, setEvidence] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const writer = canPropose(user?.role);
  const jurisdictions = useReferenceList(listJurisdictions, Boolean(customer));
  const load = useCallback(async (c = customer) => {
    if (!c) return;
    setError(null);
    try { setEvidence(await getCustomerTaxEvidence(c.id)); } catch (err) { setError(err?.message); }
  }, [customer]);
  useEffect(() => { load(); }, [load]);
  const act = async (key, fn) => {
    setBusy(key); setError(null);
    try { await fn(); await load(); } catch (err) { setError(err?.message || "The action failed."); } finally { setBusy(null); }
  };
  const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== "" && v != null));

  return (
    <section className={PANEL} aria-labelledby="t7-title">
      <SectionTitle id="t7-title" title="Customer tax evidence">
        Addresses (with district resolution), tax IDs and exemption certificates that decide how a customer is taxed.
      </SectionTitle>
      <SearchPicker label="Customer" search={searchCustomers}
                    describe={(c) => c.display_name || c.company_name || `Customer #${c.id}`} onPick={setCustomer} />
      <InlineError message={error} />
      {customer && evidence && (
        <div className="mt-4 space-y-5">
          <p className={`font-semibold ${STRONG}`}>{customer.display_name || customer.company_name}</p>
          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className={`text-sm font-bold ${STRONG}`}>Addresses</h3>
              {writer && (
                <AddForm title="Record address" submitLabel="Record"
                         fields={[{ key: "role", label: "Role", required: true, options: ["BILLING", "SHIPPING", "SERVICE_LOCATION"].map((v) => ({ value: v, label: humanize(v) })) },
                                  { key: "country_code", label: "Country (ISO 2)", required: true }, { key: "subdivision_code", label: "State / province" },
                                  { key: "line1", label: "Street" }, { key: "city", label: "City" }, { key: "postal_code", label: "Postal code" }]}
                         onSubmit={(f) => act("address", () => recordTaxAddress(customer.id, clean(f)))} />
              )}
            </div>
            <ul className="space-y-2">
              {(evidence.addresses || []).map((a) => {
                const state = resolutionState(a.resolution);
                return (
                  <li key={a.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className={`text-sm font-semibold ${STRONG}`}>{humanize(a.role)}: {[a.line1, a.city, a.subdivision_code, a.postal_code, a.country_code].filter(Boolean).join(", ")}</span>
                      {a.country_code === "US" && <TaxStatusBadge status={state} />}
                    </div>
                    {a.resolution && (
                      <p className={`text-xs ${MUTED}`}>
                        {a.resolution.jurisdiction_codes?.join(" › ") || "No districts"} · {humanize(a.resolution.precision)} ·
                        {" "}{a.resolution.resolver} · valid until {formatDateTime(a.resolution.valid_until)}
                      </p>
                    )}
                    {a.country_code === "US" && writer && state !== "RESOLVED" && (
                      <Button size="sm" className="mt-2" loading={busy === `resolve-${a.id}`}
                              onClick={() => act(`resolve-${a.id}`, () => resolveTaxAddress(customer.id, a.id))}>
                        {state === "STALE" ? "Resolve again" : "Resolve address"}
                      </Button>
                    )}
                    {a.country_code === "US" && (
                      <ManualResolutions user={user} address={a} customerId={customer.id} onChanged={() => load()} />
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className={`text-sm font-bold ${STRONG}`}>Tax IDs</h3>
              {writer && (
                <AddForm title="Add tax ID" submitLabel="Add"
                         fields={[{ key: "value", label: "Tax ID", required: true }, { key: "id_type", label: "Type" },
                                  { key: "country_code", label: "Country (ISO 2)" }]}
                         onSubmit={(f) => act("taxid", () => addTaxId(customer.id, clean(f)))} />
              )}
            </div>
            <ul className="space-y-2">
              {(evidence.tax_ids || []).map((t) => (
                <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                  <span className={`text-sm ${STRONG}`}>{t.value} {t.id_type ? `(${t.id_type})` : ""}</span>
                  <span className="flex items-center gap-2">
                    <TaxStatusBadge status={t.verification_status} />
                    {writer && <Button size="sm" loading={busy === `retire-${t.id}`} onClick={() => act(`retire-${t.id}`, () => retireTaxId(t.id))}>Retire</Button>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className={`text-sm font-bold ${STRONG}`}>Exemption certificates</h3>
              {writer && (
                <AddForm title="Add certificate" submitLabel="Add"
                         fields={[{ key: "certificate_number", label: "Certificate number", required: true },
                                  { key: "jurisdiction_id", label: "Jurisdiction", required: true,
                                    options: jurisdictions.map((j) => ({ value: j.id, label: `${j.code} — ${j.name}` })) },
                                  { key: "scope_description", label: "Scope", required: true },
                                  { key: "valid_from", label: "Valid from", type: "date", required: true },
                                  { key: "expires_at", label: "Expires", type: "date" },
                                  { key: "evidence_ref", label: "Evidence reference", required: true },
                                  { key: "reason_code", label: "Reason code" }]}
                         onSubmit={(f) => act("cert", () => addCertificate(customer.id, clean({ ...f, jurisdiction_id: Number(f.jurisdiction_id) })))} />
              )}
            </div>
            <ul className="space-y-2">
              {(evidence.exemption_certificates || []).map((c) => {
                const status = c.status === "ACTIVE" && c.expires_at && c.expires_at <= today() ? "EXPIRED" : c.status;
                return (
                  <li key={c.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className={`text-sm font-semibold ${STRONG}`}>{c.certificate_number} · {c.scope_description}</span>
                      <TaxStatusBadge status={status} />
                    </div>
                    <p className={`text-xs ${MUTED}`}>Valid {c.valid_from} → {c.expires_at || "no expiry"} · evidence {c.evidence_attached ? "document attached" : "missing"}</p>
                    {writer && c.status === "ACTIVE" && !c.evidence_attached && (
                      <EvidenceUpload kind="exemption-certificates" id={c.id} label="Certificate document" onDone={() => load()} />
                    )}
                    {writer && c.status === "ACTIVE" && (
                      <Button size="sm" className="mt-2" loading={busy === `revoke-${c.id}`} onClick={() => act(`revoke-${c.id}`, () => revokeCertificate(c.id))}>Revoke</Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}

// ── T8 ──────────────────────────────────────────────────────────────────

export function ReviewItemsScreen({ user }) {
  const [includeResolved, setIncludeResolved] = useState(false);
  const list = useCursorList(({ cursor }) => listReviewItems({ include_resolved: includeResolved || undefined, cursor }), [includeResolved]);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const resolve = async (item) => {
    setBusy(item.id); setError(null);
    try { await resolveReviewItem(item.id); list.reload(); } catch (err) { setError(err?.message || "Couldn't resolve."); } finally { setBusy(null); }
  };
  return (
    <section className={PANEL} aria-labelledby="t8-title">
      <SectionTitle id="t8-title" title="Review items">
        Things that need a person: expired or expiring registrations and certificates, stale address resolutions,
        provider drift, credential versions not destroyed.
      </SectionTitle>
      <label className={`mb-3 flex items-center gap-2 text-sm ${STRONG}`}>
        <input type="checkbox" checked={includeResolved} onChange={(e) => setIncludeResolved(e.target.checked)} />
        Include resolved items
      </label>
      <InlineError message={error || list.error} />
      {list.items.length === 0 && !list.loading && <p className={`py-4 text-sm ${MUTED}`}>Nothing needs review.</p>}
      <ul className="space-y-2">
        {list.items.map((i) => (
          <li key={i.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className={`text-sm font-semibold ${STRONG}`}>{humanize(i.kind)}</span>
              <TaxStatusBadge status={i.status} />
            </div>
            <p className={`text-sm ${STRONG}`}>{i.detail}</p>
            <p className={`text-xs ${MUTED}`}>
              {humanize(i.subject_type)} #{i.subject_id}{i.due_date ? ` · due ${i.due_date}` : ""}
              {i.owner_role ? ` · owner: ${humanize(i.owner_role)}` : ""}{i.age_days != null ? ` · open ${i.age_days} day(s)` : ""}
            </p>
            {i.status === "OPEN" && canPropose(user?.role) && (
              <Button size="sm" className="mt-2" loading={busy === i.id} onClick={() => resolve(i)}>Mark resolved</Button>
            )}
          </li>
        ))}
      </ul>
      <LoadMore list={list} noun="items" />
    </section>
  );
}
