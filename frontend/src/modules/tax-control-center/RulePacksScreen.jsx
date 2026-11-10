import { useEffect, useId, useState } from "react";
import { ClipboardCheck, Plus } from "lucide-react";

import { Button, Field, FORM_CONTROL_CLASS, FormGrid, FormModal } from "../../components/billing-ui";
import { approveBlockedReason, canApproveTaxRegistry, canWriteTaxRegistry } from "./access";
import { SIGNOFF_CHECKLISTS } from "./signoffChecklists";
import {
  getEvidenceBundle, amendRulePack, getRulePackCatalogue, listRulePacks, registerRulePack, rulePackAction,
} from "./taxRegistryService";
import {
  ActionBar, DefinitionList, DetailModal, EvidenceExport, InlineError, LoadMore, MUTED, PANEL, ReasonModal, STRONG, TaxStatusBadge,
  TaxTable, ValidationList, VersionTimeline, humanize, useApprovalVerdict, useCursorList, useStepUp,
} from "./shared";
import { RegressionPanel } from "./RegressionPanel";
import { CancelSchedule, PublishModal, ScheduleInfo } from "./ScheduleControls";
import { RollbackControls } from "./RollbackControls";

/* P7 Rule packs: the native packs available in code (their declarations,
 * live source-dependency status), their registry versions, the golden-test
 * report, the TAX_PHASE3B sign-off checklist beside the pack, and the
 * two-person workflow. */

const EDITABLE = ["PENDING_REVIEW", "VALIDATION_FAILED", "VALIDATED"];

/* Phase 8 PR 1: the approved code hash against the code running now. A
 * mismatch on an ACTIVE pack means quotes for its markets are refused. */
function IntegrityBanner({ pack }) {
  if (!pack.integrity || pack.integrity === "MATCH" || pack.status !== "ACTIVE") return null;
  return (
    <div role="alert" className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-100">
      <strong>Quotes for this pack's markets are refused (RULE_PACK_INTEGRITY_FAILED).</strong>{" "}
      {pack.integrity === "CODE_MISSING"
        ? "The approved version's code is not running."
        : "The running code differs from the approved code hash."}{" "}
      Roll back the deploy, or register, review and publish a new pack version.
    </div>
  );
}

const shortHash = (h) => (h ? `${h.slice(0, 12)}…` : "none");

/* Phase 8 PR 2: packs are effective-dated; the quote's tax date picks the version. */
const inForce = (p) => `${p.valid_from || "the start"} → ${p.valid_to ? `${p.valid_to} (exclusive)` : "open-ended"}`;

function StartDateModal({ open, pack, onClose, onDone }) {
  const id = useId();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => { if (open) { setValue(pack?.valid_from || ""); setError(null); } }, [open, pack]);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await amendRulePack(pack.id, { valid_from: value || null }));
    } catch (err) {
      setError(err?.message || "Couldn't set the start date.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormModal open={open} onClose={onClose} onSubmit={submit} busy={busy} error={error} title="Start date (tax dates)"
               submitLabel="Save"
               description="The local legal date from which this version decides tax. Leave it empty to replace the current version from the same start.">
      <Field label="In force from" htmlFor={`${id}-from`}>
        <input id={`${id}-from`} type="date" className={FORM_CONTROL_CLASS} value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>
    </FormModal>
  );
}

function SourceDependencies({ deps }) {
  if (!deps?.length) return <p className={`text-sm ${MUTED}`}>No source dependencies declared.</p>;
  return (
    <ul className="space-y-1 text-sm">
      {deps.map((d) => (
        <li key={d.handoff_ref} className="flex flex-wrap items-center gap-2">
          <TaxStatusBadge status={d.approved ? "PASSED" : "FAILED"} />
          <span className={STRONG}><strong>{d.handoff_ref}</strong> {d.title || "(not in the source register)"}</span>
          {!d.approved && <span className={MUTED}>— {d.reason}</span>}
        </li>
      ))}
    </ul>
  );
}

function SignoffChecklist({ code }) {
  const items = SIGNOFF_CHECKLISTS[code];
  if (!items) return <p className={`text-sm ${MUTED}`}>No sign-off checklist is recorded for this pack.</p>;
  return (
    <div>
      <h3 className={`mb-1 flex items-center gap-1.5 text-sm font-bold ${STRONG}`}>
        <ClipboardCheck size={15} aria-hidden="true" /> Tax lead sign-off checklist (TAX_PHASE3B)
      </h3>
      <p className={`mb-2 text-xs ${MUTED}`}>Work through each item before approving. Evidence lives in the source register, the rates, the availability gates and the golden-test report below.</p>
      <ol className={`list-decimal space-y-1.5 pl-5 text-sm ${STRONG}`}>
        {items.map((item) => <li key={item}>{item}</li>)}
      </ol>
    </div>
  );
}

function GoldenReportModal({ open, pack, onClose, onDone }) {
  const base = useId();
  const blank = { suite: "", commit: "", passed: "", failed: "0", ci_run_url: "", notes: "" };
  const [form, setForm] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (open) { setError(null); setForm(pack?.golden_test_report ? { ...blank, ...pack.golden_test_report } : blank); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pack]);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));
  const submit = async () => {
    setBusy(true);
    setError(null);
    const report = { suite: form.suite, commit: form.commit, passed: Number(form.passed), failed: Number(form.failed),
                     ...(form.ci_run_url ? { ci_run_url: form.ci_run_url } : {}), ...(form.notes ? { notes: form.notes } : {}) };
    try {
      onDone(await amendRulePack(pack.id, { golden_test_report: report }));
    } catch (err) {
      setError(err?.message || "Couldn't attach the report.");
    } finally {
      setBusy(false);
    }
  };
  const field = (key, label, props = {}) => (
    <Field label={label} htmlFor={`${base}-${key}`} required={props.required}>
      <input id={`${base}-${key}`} className={FORM_CONTROL_CLASS} value={form[key]} onChange={set(key)} {...props} />
    </Field>
  );
  return (
    <FormModal open={open} onClose={onClose} onSubmit={submit} busy={busy} error={error} title="Attach the golden-test report"
               submitLabel="Attach" description="From the CI run of the pack's golden tests on the release commit.">
      <FormGrid>
        {field("suite", "Suite", { required: true, maxLength: 255 })}
        {field("commit", "Commit", { required: true, minLength: 7, maxLength: 64 })}
        {field("passed", "Passed", { required: true, type: "number", min: 0 })}
        {field("failed", "Failed", { required: true, type: "number", min: 0 })}
      </FormGrid>
      {field("ci_run_url", "CI run URL", { type: "url" })}
      {field("notes", "Notes")}
    </FormModal>
  );
}

function PackDetail({ pack, catalogueEntry, user, onChanged }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [reasonFor, setReasonFor] = useState(null);
  const [reporting, setReporting] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [dating, setDating] = useState(false);
  const stepUp = useStepUp();
  const fallback = approveBlockedReason(user, pack);
  const verdict = useApprovalVerdict("rule_pack", pack, fallback);
  const canWrite = canWriteTaxRegistry(user?.platform_role);
  const canApprove = canApproveTaxRegistry(user?.platform_role);
  const s = pack.status;
  const report = pack.golden_test_report;

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
      <IntegrityBanner pack={pack} />
      <DefinitionList rows={[
        ["Pack", `${pack.code} v${pack.version}`], ["Status", <TaxStatusBadge key="s" status={s} />],
        ["Code hash (approved)", <code key="h" className="break-all" title={pack.code_hash || ""}>{pack.code_hash || "Not recorded"}</code>],
        ["Code hash (running)", <code key="r" className="break-all">{pack.running_code_hash || "Not running"}</code>],
        ["Integrity", pack.integrity ? <TaxStatusBadge key="i" status={`INTEGRITY_${pack.integrity}`} /> : null],
        ["Markets", (pack.markets || []).map((m) => `${m.jurisdiction_code} ${m.tax_type}`).join(", ")],
        ["Rounding", `${humanize(pack.rounding_rule)} · ${humanize(pack.rounding_mode)}`],
        ["In force for tax dates", inForce(pack)],
        ["Required facts", (pack.required_facts || []).join(", ")], ["Notes", pack.notes],
      ]} />
      <ValidationList title="Validation errors" items={pack.validation_errors} />
      <ScheduleInfo version={pack} />
      <CancelSchedule version={pack} kind="rule_pack" user={user} stepUp={stepUp} onChanged={onChanged} />
      <RollbackControls kind="rule_pack" version={pack} user={user} stepUp={stepUp} onChanged={onChanged} />
      <div>
        <h3 className={`mb-2 text-sm font-bold ${STRONG}`}>Source dependencies (live)</h3>
        <SourceDependencies deps={catalogueEntry?.source_dependencies || pack.source_dependencies} />
      </div>
      <div>
        <h3 className={`mb-2 text-sm font-bold ${STRONG}`}>Golden-test report</h3>
        {report ? (
          <p className={`text-sm ${STRONG}`}>
            {report.suite} at {report.commit}: {report.passed} passed, {report.failed} failed
            {report.ci_run_url && <> · <a href={report.ci_run_url} target="_blank" rel="noreferrer" className="text-brand-700 underline dark:text-brand-300">CI run</a></>}
          </p>
        ) : <p className={`text-sm ${MUTED}`}>Not attached yet.</p>}
      </div>
      <SignoffChecklist code={pack.code} />
      <div>
        <h3 className={`mb-2 text-sm font-bold ${STRONG}`}>History</h3>
        <VersionTimeline version={pack} />
      </div>
      <ActionBar busyKey={busy} actions={[
        { key: "report", label: report ? "Replace golden-test report" : "Attach golden-test report",
          hidden: !canWrite || !EDITABLE.includes(s), onClick: () => setReporting(true) },
        { key: "dates", label: pack.valid_from ? "Change start date" : "Set start date",
          hidden: !canWrite || !EDITABLE.includes(s), onClick: () => setDating(true) },
        { key: "validate", label: "Validate", hidden: !canWrite || !EDITABLE.includes(s),
          onClick: () => act("validate", () => rulePackAction(pack.id, "validate")) },
        { key: "submit", label: "Submit for approval", variant: "primary", hidden: !canWrite || s !== "VALIDATED",
          onClick: () => setReasonFor("submit") },
        { key: "approve", label: "Approve", variant: "primary", hidden: !canApprove || s !== "IN_APPROVAL",
          reason: verdict.loading ? null : verdict.reason, disabled: verdict.loading,
          onClick: () => act("approve", () => stepUp.run((body) => rulePackAction(pack.id, "approve", body))) },
        { key: "reject", label: "Reject", hidden: !canApprove || s !== "IN_APPROVAL", onClick: () => setReasonFor("reject") },
        { key: "publish", label: "Publish", variant: "primary", hidden: !canApprove || s !== "APPROVED", reason: fallback,
          onClick: () => setPublishing(true) },
      ]} />
      <PublishModal open={publishing} version={pack} noun="rule pack" busy={false} error={null}
                    onCancel={() => setPublishing(false)}
                    onSubmit={(when) => { setPublishing(false);
                      act("publish", () => stepUp.run((body) => rulePackAction(pack.id, "publish", { ...when, ...body }))); }} />
      <StartDateModal open={dating} pack={pack} onClose={() => setDating(false)}
                      onDone={(updated) => { setDating(false); onChanged(updated); }} />
      <ReasonModal open={Boolean(reasonFor)} busy={false} error={null}
                   title={reasonFor === "reject" ? "Reject this rule pack" : "Submit for approval"}
                   submitLabel={reasonFor === "reject" ? "Reject" : "Submit"} onCancel={() => setReasonFor(null)}
                   onSubmit={(reason) => { const action = reasonFor; setReasonFor(null);
                     act(action, () => rulePackAction(pack.id, action, { reason })); }} />
      <GoldenReportModal open={reporting} pack={pack} onClose={() => setReporting(false)}
                         onDone={(updated) => { setReporting(false); onChanged(updated); }} />
      <RegressionPanel kind="rule_pack" id={pack.id} user={user} />
      <EvidenceExport noun="rule pack" filename={`tax-evidence-rule_pack-${pack.id}`}
                      fetchBundle={(format) => getEvidenceBundle("rule_pack", pack.id, format)} />
      {stepUp.modal}
    </>
  );
}

export default function RulePacksScreen({ user }) {
  const canWrite = canWriteTaxRegistry(user?.platform_role);
  const list = useCursorList(({ cursor }) => listRulePacks({ cursor }), []);
  const [catalogue, setCatalogue] = useState([]);
  const [catalogueError, setCatalogueError] = useState(null);
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    getRulePackCatalogue().then((d) => setCatalogue(d?.items || [])).catch((err) => setCatalogueError(err?.message));
  }, [list.items.length]);

  const register = async (code) => {
    setBusy(code);
    setError(null);
    try {
      setOpen(await registerRulePack({ code }));
      list.reload();
    } catch (err) {
      setError(err?.message || "Couldn't register the pack.");
    } finally {
      setBusy(null);
    }
  };

  const columns = [
    { key: "id", label: "#" },
    { key: "code", label: "Pack", render: (r) => `${r.code} v${r.version}` },
    { key: "markets", label: "Markets", render: (r) => (r.markets || []).map((m) => `${m.jurisdiction_code} ${m.tax_type}`).join(", ") },
    { key: "in_force", label: "In force", render: inForce },
    { key: "report", label: "Golden tests", render: (r) => (r.golden_test_report ? `${r.golden_test_report.passed} passed / ${r.golden_test_report.failed} failed` : "Not attached") },
    { key: "status", label: "Status", render: (r) => <TaxStatusBadge status={r.status} /> },
    { key: "integrity", label: "Code hash", render: (r) => (r.integrity
      ? <span className="flex flex-wrap items-center gap-1"><TaxStatusBadge status={`INTEGRITY_${r.integrity}`} /><code className={`text-xs ${MUTED}`}>{shortHash(r.code_hash)}</code></span>
      : "—") },
  ];

  return (
    <section className={PANEL} aria-labelledby="packs-title">
      <div className="mb-4">
        <h2 id="packs-title" className={`text-lg font-bold ${STRONG}`}>Rule packs</h2>
        <p className={`text-sm ${MUTED}`}>A coded pack stays a draft, ignored by the engine, until a second person approves and publishes it.</p>
      </div>
      <InlineError message={error || catalogueError || list.error} />
      <h3 className={`mb-2 text-sm font-bold ${STRONG}`}>Available in code</h3>
      <ul className="mb-5 space-y-3">
        {catalogue.map((p) => (
          <li key={p.code} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className={`font-semibold ${STRONG}`}>{p.code} v{p.version}</span>
              {canWrite && (
                <Button size="sm" icon={Plus} loading={busy === p.code} onClick={() => register(p.code)}>Register draft</Button>
              )}
            </div>
            <p className={`mt-1 text-xs ${MUTED}`}>
              {(p.markets || []).map((m) => `${m.jurisdiction_code} ${m.tax_type}`).join(", ")} · rounding {humanize(p.rounding_rule)} / {humanize(p.rounding_mode)}
            </p>
            <div className="mt-2"><SourceDependencies deps={p.source_dependencies} /></div>
          </li>
        ))}
      </ul>
      <h3 className={`mb-2 text-sm font-bold ${STRONG}`}>Registry versions</h3>
      <TaxTable caption="Rule-pack registry versions" columns={columns} rows={list.items} onOpen={setOpen} empty="No pack is registered yet." />
      <LoadMore list={list} noun="versions" />
      <DetailModal open={Boolean(open)} onClose={() => setOpen(null)} title={open ? `Rule pack #${open.id}` : ""}>
        {open && <PackDetail pack={open} user={user} catalogueEntry={catalogue.find((c) => c.code === open.code)}
                             onChanged={(updated) => { setOpen(updated); list.reload(); }} />}
      </DetailModal>
    </section>
  );
}
