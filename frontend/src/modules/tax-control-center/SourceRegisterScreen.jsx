import { useId, useState } from "react";
import { Plus, Upload } from "lucide-react";

import { Button, Field, FORM_CONTROL_CLASS, FormGrid, FormModal, Select } from "../../components/billing-ui";
import { canWriteTaxRegistry } from "./access";
import {
  attachSourceEvidence, getEvidenceBundle, listAuthorities, listSourceRevisions, registerSourceRevision,
} from "./taxRegistryService";
import {
  DefinitionList, DetailModal, EvidenceExport, InlineError, LoadMore, MUTED, PANEL, STRONG, TaxStatusBadge, TaxTable,
  formatDateTime, humanize, useCursorList, usePeopleNames, useReferenceList,
} from "./shared";

/* P2 Source register: legal source revisions per authority and handoff ref,
 * registration, and evidence capture (upload; the server computes the
 * SHA-256 and records the redistribution permission). Evidence is
 * write-once on the backend. */

const TIERS = ["PRIMARY_LEGAL_INSTRUMENT", "OFFICIAL_DATASET", "OFFICIAL_GUIDANCE", "LICENSED_PROVIDER", "SECONDARY_COMMENTARY"];
const METHODS = ["OFFICIAL_API", "OFFICIAL_PUBLICATION", "MANUAL_VERIFIED_EXTRACTION", "COMMERCIAL_FEED"];
const PERMISSIONS = ["PERMITTED", "RESTRICTED", "DENIED", "UNKNOWN"];
const opts = (values) => values.map((v) => ({ value: v, label: humanize(v) }));

function RegisterSourceModal({ open, onClose, onDone }) {
  const authorities = useReferenceList(listAuthorities, open);
  const base = useId();
  const ids = Object.fromEntries(["a", "t", "m", "u", "ti", "c", "l", "h", "n"].map((k) => [k, `${base}-${k}`]));
  const empty = { authority_id: "", source_tier: "PRIMARY_LEGAL_INSTRUMENT", acquisition_method: "OFFICIAL_PUBLICATION",
                  permanent_url: "https://", title: "", citation: "", language: "en", handoff_ref: "", internal_notes: "" };
  const [form, setForm] = useState(empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e?.target ? e.target.value : e }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { ...form, authority_id: Number(form.authority_id) };
      for (const key of ["handoff_ref", "internal_notes"]) if (!body[key]) delete body[key];
      const created = await registerSourceRevision(body);
      setForm(empty);
      onDone(created);
    } catch (err) {
      setError(err?.message || "Couldn't register the source.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormModal open={open} onClose={onClose} onSubmit={submit} title="Register a source revision" icon={Plus}
               busy={busy} error={error} submitLabel="Register" size="lg"
               description="A revision is what a rate cites. Capture its evidence before a rate relying on it can be approved.">
      <FormGrid>
        <Field label="Authority" htmlFor={ids.a} required>
          <Select id={ids.a} value={form.authority_id} onChange={set("authority_id")} required placeholder="Choose…"
                  options={authorities.map((a) => ({ value: a.id, label: `${a.code} — ${a.name}` }))} />
        </Field>
        <Field label="Handoff ref" htmlFor={ids.h} hint="For example S11.">
          <input id={ids.h} className={FORM_CONTROL_CLASS} maxLength={10} value={form.handoff_ref} onChange={set("handoff_ref")} />
        </Field>
        <Field label="Source tier" htmlFor={ids.t} required>
          <Select id={ids.t} value={form.source_tier} onChange={set("source_tier")} options={opts(TIERS)} placeholder="" />
        </Field>
        <Field label="Acquisition method" htmlFor={ids.m} required>
          <Select id={ids.m} value={form.acquisition_method} onChange={set("acquisition_method")} options={opts(METHODS)} placeholder="" />
        </Field>
      </FormGrid>
      <Field label="Permanent URL" htmlFor={ids.u} required hint="Must be a permanent https:// address.">
        <input id={ids.u} type="url" className={FORM_CONTROL_CLASS} value={form.permanent_url} onChange={set("permanent_url")} required />
      </Field>
      <Field label="Title" htmlFor={ids.ti} required>
        <input id={ids.ti} className={FORM_CONTROL_CLASS} value={form.title} onChange={set("title")} required />
      </Field>
      <Field label="Citation" htmlFor={ids.c} required>
        <input id={ids.c} className={FORM_CONTROL_CLASS} value={form.citation} onChange={set("citation")} required />
      </Field>
      <FormGrid>
        <Field label="Language" htmlFor={ids.l} required>
          <input id={ids.l} className={FORM_CONTROL_CLASS} value={form.language} onChange={set("language")} required minLength={2} maxLength={10} />
        </Field>
        <Field label="Internal notes" htmlFor={ids.n}>
          <input id={ids.n} className={FORM_CONTROL_CLASS} value={form.internal_notes} onChange={set("internal_notes")} />
        </Field>
      </FormGrid>
    </FormModal>
  );
}

function EvidenceForm({ revision, onDone }) {
  const fileId = useId();
  const permId = useId();
  const [file, setFile] = useState(null);
  const [permission, setPermission] = useState("PERMITTED");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      onDone(await attachSourceEvidence(revision.id, file, permission));
    } catch (err) {
      setError(err?.message || "Couldn't capture the evidence.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Capture evidence">
      <InlineError message={error} />
      <FormGrid>
        <Field label="Evidence file" htmlFor={fileId} required hint="The captured page or document. The server computes its SHA-256.">
          <input id={fileId} type="file" className="block w-full text-sm" onChange={(e) => setFile(e.target.files?.[0] || null)} aria-required="true" />
        </Field>
        <Field label="Redistribution permission" htmlFor={permId} required>
          <Select id={permId} value={permission} onChange={setPermission} options={opts(PERMISSIONS)} placeholder="" />
        </Field>
      </FormGrid>
      <Button type="submit" variant="primary" size="sm" icon={Upload} loading={busy} disabled={!file}>Capture evidence</Button>
    </form>
  );
}

export default function SourceRegisterScreen({ user }) {
  const canWrite = canWriteTaxRegistry(user?.platform_role);
  const list = useCursorList(({ cursor }) => listSourceRevisions({ cursor }), []);
  const [registering, setRegistering] = useState(false);
  const [open, setOpen] = useState(null);
  const nameOf = usePeopleNames();

  const columns = [
    { key: "id", label: "#" },
    { key: "authority", label: "Authority" },
    { key: "handoff_ref", label: "Ref" },
    { key: "title", label: "Title" },
    { key: "source_tier", label: "Tier", render: (r) => humanize(r.source_tier) },
    { key: "evidence_status", label: "Evidence", render: (r) => <TaxStatusBadge status={r.evidence_status} /> },
    { key: "redistribution_permission", label: "Redistribution", render: (r) => humanize(r.redistribution_permission) },
  ];

  return (
    <section className={PANEL} aria-labelledby="sources-title">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="sources-title" className={`text-lg font-bold ${STRONG}`}>Source register</h2>
          <p className={`text-sm ${MUTED}`}>Legal sources behind every rate. A source without captured evidence cannot back an approved rate.</p>
        </div>
        {canWrite && <Button variant="primary" size="sm" icon={Plus} onClick={() => setRegistering(true)}>Register source</Button>}
      </div>
      <InlineError message={list.error} />
      <TaxTable caption="Source revisions" columns={columns} rows={list.items} onOpen={setOpen} empty="No source revisions yet." />
      <LoadMore list={list} noun="sources" />

      <RegisterSourceModal open={registering} onClose={() => setRegistering(false)}
                           onDone={() => { setRegistering(false); list.reload(); }} />
      <DetailModal open={Boolean(open)} onClose={() => setOpen(null)} title={open ? `Source #${open.id}: ${open.title}` : ""}>
        {open && (
          <>
            <DefinitionList rows={[
              ["Authority", open.authority], ["Handoff ref", open.handoff_ref],
              ["Tier", humanize(open.source_tier)], ["Acquisition", humanize(open.acquisition_method)],
              ["Permanent URL", <a key="u" href={open.permanent_url} target="_blank" rel="noreferrer" className="break-all text-brand-700 underline dark:text-brand-300">{open.permanent_url}</a>],
              ["Citation", open.citation], ["Language", open.language],
              ["Evidence", <TaxStatusBadge key="e" status={open.evidence_status} />],
              ["Redistribution", humanize(open.redistribution_permission)],
              ["SHA-256 (server)", open.sha256 ? <code key="s" className="break-all text-xs">{open.sha256}</code> : "—"],
              ["Captured", formatDateTime(open.retrieved_at)],
              ["Artifact", open.artifact_media_type ? `${open.artifact_media_type}, ${open.artifact_size_bytes} bytes` : "—"],
              ["Reviewed by", open.reviewed_by || (open.reviewer_user_id ? nameOf(open.reviewer_user_id) : null)],
              ["Registered", formatDateTime(open.created_at)],
              ["Internal notes", open.internal_notes],
            ]} />
            {canWrite && open.evidence_status !== "CAPTURED" && (
              <div>
                <h3 className={`mb-2 text-sm font-bold ${STRONG}`}>Capture evidence</h3>
                <EvidenceForm revision={open} onDone={(updated) => { setOpen(updated); list.reload(); }} />
              </div>
            )}
            {open.evidence_status === "CAPTURED" && (
              <p className={`text-sm ${MUTED}`}>Evidence is captured and write-once. To withdraw a source, register a new revision and capture it with redistribution DENIED.</p>
            )}
            <EvidenceExport noun="source" filename={`tax-evidence-source-${open.id}`}
                            fetchBundle={(format) => getEvidenceBundle("source_revision", open.id, format)} />
          </>
        )}
      </DetailModal>
    </section>
  );
}
