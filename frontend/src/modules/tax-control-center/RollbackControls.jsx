import { useEffect, useId, useState } from "react";
import { Undo2 } from "lucide-react";

import { Button, Field, FORM_CONTROL_CLASS, FormModal, Select } from "../../components/billing-ui";
import { canApproveTaxRegistry } from "./access";
import { decideRollback, listRollbackCandidates, proposeRollback } from "./taxRegistryService";
import { InlineError, MUTED, ReasonModal, STRONG, usePeopleNames } from "./shared";

/* Phase 8 PR 3: emergency rollback. A TAX_PUBLISHER proposes with a reason
 * and a severity; a different TAX_PUBLISHER approves with MFA and it applies
 * at once. For a pack, R runs the restored version's code from today; the
 * rolled-back version's date range then fails closed (RULE_PACK_ROLLED_BACK).
 * A version a later one already follows can only be quarantined. */

export const SEVERITIES = [
  { value: "SEV1", label: "SEV1: wrong tax is being charged now" },
  { value: "SEV2", label: "SEV2: wrong tax in limited cases" },
  { value: "SEV3", label: "SEV3: precautionary" },
];

function ProposeModal({ open, kind, version, onCancel, onDone }) {
  const id = useId();
  const quarantine = kind === "rule_pack" && Boolean(version.valid_to);
  const [candidates, setCandidates] = useState([]);
  const [target, setTarget] = useState("");
  const [severity, setSeverity] = useState("SEV1");
  const [reason, setReason] = useState("");
  const [zone, setZone] = useState("");
  const [cancelSchedule, setCancelSchedule] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (!open) return;
    setTarget(quarantine ? "quarantine" : ""); setSeverity("SEV1"); setReason(""); setCancelSchedule(false);
    setZone(version.default_timezone || ""); setError(null);
    listRollbackCandidates(kind, version.id).then((d) => setCandidates(d?.items || [])).catch(() => setCandidates([]));
  }, [open, kind, version, quarantine]);
  const options = quarantine
    ? [{ value: "quarantine", label: "Quarantine only: a later version already follows it" }]
    : candidates.filter((c) => !c.integrity || c.integrity === "MATCH").map((c) => ({
      value: String(c.id),
      label: kind === "rule_pack"
        ? `v${c.version} (#${c.id}, ${c.valid_from || "the start"} → ${c.valid_to || "open"})`
        : `#${c.id}: ${c.mode} (${c.status})`,
    }));
  const unusable = candidates.filter((c) => c.integrity && c.integrity !== "MATCH");
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await proposeRollback({
        kind, version_id: version.id, restore_to_id: target === "quarantine" || !target ? null : Number(target),
        reason: reason.trim(), severity, cancel_schedule: cancelSchedule,
        ...(kind === "rule_pack" && zone ? { timezone: zone } : {}),
      }));
    } catch (err) {
      setError(err?.message || "Couldn't propose the rollback.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormModal open={open} onClose={onCancel} onSubmit={submit} busy={busy} error={error} title="Propose an emergency rollback"
               submitLabel="Propose rollback"
               description="A different TAX_PUBLISHER must approve with MFA; it then applies at once. Issued invoices never change.">
      <Field label="Restore to" htmlFor={`${id}-target`} required>
        <Select id={`${id}-target`} value={target} onChange={setTarget} options={options} placeholder="Choose a version"
                aria-label="Restore to" />
      </Field>
      <Field label="Severity" htmlFor={`${id}-sev`} required>
        <Select id={`${id}-sev`} value={severity} onChange={setSeverity} options={SEVERITIES} placeholder=""
                aria-label="Severity" />
      </Field>
      {unusable.length > 0 && (
        <p className={`text-xs ${MUTED}`}>
          Can't be restored (code not shipping as approved): {unusable.map((c) => `v${c.version} (${c.integrity})`).join(", ")}.
        </p>
      )}
      {kind === "rule_pack" && !quarantine && (
        <Field label="Time zone whose date the rollback starts on (IANA)" htmlFor={`${id}-zone`}>
          <input id={`${id}-zone`} className={FORM_CONTROL_CLASS} value={zone} placeholder="Europe/London"
                 onChange={(e) => setZone(e.target.value)} />
        </Field>
      )}
      <Field label="Reason" htmlFor={`${id}-reason`} required>
        <textarea id={`${id}-reason`} className={FORM_CONTROL_CLASS} rows={3} minLength={3} required value={reason}
                  onChange={(e) => setReason(e.target.value)} />
      </Field>
      <label className={`flex items-start gap-2 text-sm ${STRONG}`}>
        <input type="checkbox" checked={cancelSchedule} onChange={(e) => setCancelSchedule(e.target.checked)} />
        If a version is scheduled to follow this one, cancel that schedule as part of this rollback.
      </label>
    </FormModal>
  );
}

export function RollbackControls({ kind, version, user, stepUp, onChanged }) {
  const nameOf = usePeopleNames();
  const [proposing, setProposing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const publisher = canApproveTaxRegistry(user?.platform_role);
  const request = version.rollback;
  const open = request?.status === "PROPOSED" ? request : null;

  const run = async (fn, toVersion) => {
    setBusy(true);
    setError(null);
    try {
      const result = await fn();
      if (result) onChanged(toVersion(result));
    } catch (err) {
      setError(err?.message || "The action failed.");
    } finally {
      setBusy(false);
    }
  };
  const applied = (r) => ({ ...version, rollback: r, status: "ROLLED_BACK",
                            valid_to: r.result?.range_to ?? version.valid_to });

  return (
    <div className="space-y-2">
      <InlineError message={error} />
      {version.status === "ROLLED_BACK" && request?.status === "APPROVED" && (
        <div role="status" className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100">
          <p className="flex items-center gap-1.5 font-semibold"><Undo2 size={15} aria-hidden="true" /> Rolled back ({request.severity})</p>
          {kind === "rule_pack" && (
            <p>Tax dates {request.result?.range_from || "from the start"} to {request.result?.range_to || "open"} fail
              closed (RULE_PACK_ROLLED_BACK) until retroactive analysis.</p>
          )}
          <p>{request.result?.rollback_version_id ? `Restored as version #${request.result.rollback_version_id}.`
            : "Quarantined: no version was restored."} {request.result?.organizations_affected ?? 0} organization(s) affected.</p>
        </div>
      )}
      {(version.restores_id || version.rollback_of_id) && (
        <p className={`text-sm ${STRONG}`}>Restores #{version.restores_id} (emergency rollback of #{version.rollback_of_id}).</p>
      )}
      {open && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          <p><strong>{open.severity} rollback proposed</strong> by {nameOf(open.proposed_by)}: {open.reason}</p>
          <p className="text-xs">{open.quarantine_only ? "Quarantine only." : `Restores version #${open.restore_to_id}.`}
            {open.cancel_schedule ? " Cancels a pending schedule." : ""}
            {open.regression ? ` Regression: ${open.regression.cases} case(s), ${open.regression.changed?.length ?? 0} changed.` : ""}</p>
          {publisher && user?.id !== open.proposed_by && (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="primary" loading={busy}
                      onClick={() => run(() => stepUp.run((body) => decideRollback(open.id, "approve", body)), applied)}>
                Approve rollback
              </Button>
              <Button size="sm" disabled={busy} onClick={() => setRejecting(true)}>Reject rollback</Button>
            </div>
          )}
          {user?.id === open.proposed_by && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-xs">A different TAX_PUBLISHER must approve it.</span>
              <Button size="sm" disabled={busy}
                      onClick={() => run(() => decideRollback(open.id, "withdraw"), () => ({ ...version, rollback: null }))}>
                Withdraw
              </Button>
            </div>
          )}
        </div>
      )}
      {!open && version.status === "ACTIVE" && publisher && (
        <Button size="sm" icon={Undo2} onClick={() => setProposing(true)}>Propose rollback</Button>
      )}
      {version.status === "ACTIVE" && !publisher && !open && (
        <p className={`text-xs ${MUTED}`}>Emergency rollback is proposed and approved by two TAX_PUBLISHERs.</p>
      )}
      <ProposeModal open={proposing} kind={kind} version={version} onCancel={() => setProposing(false)}
                    onDone={(r) => { setProposing(false); onChanged({ ...version, rollback: r }); }} />
      <ReasonModal open={rejecting} busy={false} error={null} minLength={3} title="Reject the rollback"
                   description="The version stays active." submitLabel="Reject" onCancel={() => setRejecting(false)}
                   onSubmit={(reason) => { setRejecting(false);
                     run(() => decideRollback(open.id, "reject", { reason }), () => ({ ...version, rollback: null })); }} />
    </div>
  );
}
