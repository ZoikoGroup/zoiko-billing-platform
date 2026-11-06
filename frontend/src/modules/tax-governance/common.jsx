import { useCallback, useEffect, useId, useState } from "react";
import { Upload } from "lucide-react";

import { Button, Field, Select } from "../../components/billing-ui";
import { fetchAllPages } from "../tax-control-center/taxRegistryService";
import { ActionBar, InlineError, MUTED, ReasonModal, humanize, useStepUp } from "../tax-control-center/shared";
import { listLegalEntities, listPeople, uploadEvidence } from "./governanceService";

/* Shared pieces of tenant Settings → Taxes (Phase 5b). Roles mirror the
 * backend dependencies (app/core/dependencies.py): every tenant role reads;
 * org_admin / billing_admin propose; a different finance_approver decides;
 * org_admin manages legal entities and proposes regime changes. */

export const TENANT_TAX_ROLES = ["org_admin", "billing_admin", "finance_approver", "auditor"];
export const canReadTenantTax = (role) => TENANT_TAX_ROLES.includes(role);
export const canPropose = (role) => role === "org_admin" || role === "billing_admin";
export const canDecide = (role) => role === "finance_approver";
export const isOrgAdmin = (role) => role === "org_admin";

export const PROPOSER_REASON = "You proposed this; a different finance approver must decide it.";
export const DECIDER_ROLE_REASON = "Only a finance approver can approve or reject.";

/** Why the user can't approve a proposal, or null. */
export function decisionBlockedReason(user, proposerId) {
  if (!canDecide(user?.role)) return DECIDER_ROLE_REASON;
  if (proposerId != null && user?.id === proposerId) return PROPOSER_REASON;
  return null;
}

// ── names from the tenant's own directory ───────────────────────────────

let peoplePromise = null;
export function resetTenantPeopleCache() { peoplePromise = null; }
const ROLE_LABELS = { ORG_ADMIN: "Org admin", BILLING_ADMIN: "Billing admin", FINANCE_APPROVER: "Finance approver",
                      AUDITOR: "Auditor" };

/** nameOf(id) → "Ana Admin (Billing admin)"; "user #id" until loaded or if unknown. */
export function useTenantNames() {
  const [people, setPeople] = useState(null);
  useEffect(() => {
    let cancelled = false;
    if (!peoplePromise) peoplePromise = fetchAllPages(listPeople).catch(() => { peoplePromise = null; return []; });
    peoplePromise.then((all) => { if (!cancelled) setPeople(new Map(all.map((p) => [p.id, p]))); });
    return () => { cancelled = true; };
  }, []);
  return useCallback((id) => {
    if (id == null) return null;
    const p = people?.get(id);
    return p ? `${p.name} (${ROLE_LABELS[p.role] || humanize(p.role)})` : `user #${id}`;
  }, [people]);
}

// ── seller entities ─────────────────────────────────────────────────────

export function useLegalEntities(reloadKey = 0) {
  const [entities, setEntities] = useState([]);
  const [error, setError] = useState(null);
  useEffect(() => {
    let cancelled = false;
    fetchAllPages(listLegalEntities).then((all) => { if (!cancelled) setEntities(all); })
      .catch((err) => { if (!cancelled) setError(err?.message || "Couldn't load legal entities."); });
    return () => { cancelled = true; };
  }, [reloadKey]);
  return { entities, error };
}

export function EntitySelect({ entities, value, onChange }) {
  const id = useId();
  return (
    <Field label="Seller entity" htmlFor={id}>
      <Select id={id} value={value} onChange={onChange} placeholder="All entities"
              options={entities.map((e) => ({ value: e.id, label: `${e.entity_code} — ${e.legal_name}` }))} />
    </Field>
  );
}

// ── evidence upload, validated client-side too ─────────────────────────

export const EVIDENCE_TYPES = { "application/pdf": "PDF", "image/png": "PNG", "image/jpeg": "JPEG" };
export const EVIDENCE_MAX_BYTES = 5 * 1024 * 1024;     // backend TAX_EVIDENCE_MAX_BYTES default

/** Why a file can't be uploaded, or null. Mirrors the backend's rules. */
export function evidenceProblem(file) {
  if (!file) return "Choose a file.";
  if (!EVIDENCE_TYPES[file.type]) return "Evidence must be a PDF, PNG or JPEG file.";
  if (file.size === 0) return "The file is empty.";
  if (file.size > EVIDENCE_MAX_BYTES) return "The file is larger than 5 MB.";
  return null;
}

async function sha256Hex(file) {
  try {
    const buf = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return undefined;                                  // the server hashes it either way
  }
}

/** kind: registrations | legal-bases | exemption-certificates | manual-resolutions */
export function EvidenceUpload({ kind, id, onDone, label = "Evidence document" }) {
  const inputId = useId();
  const [file, setFile] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    const problem = evidenceProblem(file);
    if (problem) { setError(problem); return; }
    setBusy(true);
    setError(null);
    try {
      onDone(await uploadEvidence(kind, id, file, await sha256Hex(file)));
      setFile(null);
    } catch (err) {
      setError(err?.message || "Upload failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="space-y-2" aria-label={`Upload ${label.toLowerCase()}`}>
      <InlineError message={error} />
      <Field label={label} htmlFor={inputId} hint="PDF, PNG or JPEG, up to 5 MB. Attached once; it can't be replaced.">
        <input id={inputId} type="file" accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
               className="block w-full text-sm"
               onChange={(e) => { const f = e.target.files?.[0] || null; setFile(f); setError(f ? evidenceProblem(f) : null); }} />
      </Field>
      <Button type="submit" size="sm" icon={Upload} loading={busy} disabled={!file}>Upload</Button>
    </form>
  );
}

// ── propose / decide bar (tenant two-person) ────────────────────────────

/**
 * Approve / reject / withdraw for one PROPOSED record. Approve and reject are
 * disabled with the reason as text for the proposer or a non-approver; MFA
 * step-up is handled the same way as the platform console if the backend
 * ever asks for it.
 */
export function DecisionBar({ user, record, proposerId, decide, withdraw, onDone, withdrawRoles = ["org_admin", "billing_admin"], noun = "proposal" }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [rejecting, setRejecting] = useState(false);
  const stepUp = useStepUp();
  if (record.status !== "PROPOSED") return null;
  const blocked = decisionBlockedReason(user, proposerId);
  const act = async (key, fn) => {
    setBusy(key);
    setError(null);
    try {
      const result = await fn();
      if (result) onDone?.(result);
    } catch (err) {
      setError(err?.message || "The action failed.");
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="mt-2">
      <InlineError message={error} />
      <ActionBar busyKey={busy} actions={[
        { key: `approve-${record.id}`, label: "Approve", variant: "primary", reason: blocked,
          onClick: () => act(`approve-${record.id}`, () => stepUp.run((body) => decide(record.id, true, body))) },
        { key: `reject-${record.id}`, label: "Reject", reason: blocked, onClick: () => setRejecting(true) },
        { key: `withdraw-${record.id}`, label: "Withdraw", hidden: !withdraw || !withdrawRoles.includes(user?.role),
          onClick: () => act(`withdraw-${record.id}`, () => withdraw(record.id)) },
      ]} />
      <ReasonModal open={rejecting} title={`Reject this ${noun}`} submitLabel="Reject" busy={false} error={null}
                   onCancel={() => setRejecting(false)}
                   onSubmit={(reason) => { setRejecting(false);
                     act(`reject-${record.id}`, () => decide(record.id, false, { reason })); }} />
      {stepUp.modal}
    </div>
  );
}

export function SectionTitle({ id, title, children }) {
  return (
    <div className="mb-4">
      <h2 id={id} className="text-lg font-bold text-slate-900 dark:text-slate-100">{title}</h2>
      {children && <p className={`text-sm ${MUTED}`}>{children}</p>}
    </div>
  );
}
