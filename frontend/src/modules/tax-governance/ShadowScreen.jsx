import { useCallback, useEffect, useId, useState } from "react";
import { Download, Eye } from "lucide-react";

import { Button, Field, Select } from "../../components/billing-ui";
import {
  ActionBar, InlineError, LoadMore, MUTED, PANEL, ReasonModal, STRONG, TaxStatusBadge, formatDateTime, humanize,
  saveFile, useCursorList,
} from "../tax-control-center/shared";
import { DecisionBar, EntitySelect, SectionTitle, describeError, isOrgAdmin, useLegalEntities, useTenantNames } from "./common";
import {
  decideShadow, endShadow, exportShadowComparisons, getShadowComparison, getShadowSummary, listShadowComparisons,
  listShadowEnrolments, proposeShadow, withdrawShadow,
} from "./governanceService";

/* Shadow compare (ZB-TAX-ARCH-001 Phase 7 PR 1). A legacy entity can
 * "shadow" governed tax: each invoice it issues is re-computed by the
 * governed engine and compared, without changing anything that is
 * invoiced. The exit signal is advice only; switching the regime stays a
 * separate two-person decision. */

const OUTCOMES = ["MATCH", "DIFFERENT", "NOT_DETERMINED", "REVIEW_REQUIRED", "UNSUPPORTED", "ERROR"];
const CAUSE_LABELS = {
  DISCOUNT_AFTER_TAX: "Discount applied after tax (legacy)", TAX_MISSING_ON_LEGACY: "No tax charged on legacy",
  RATE_DIFFERENT: "Different rate", ROUNDING: "Rounding only", UNEXPLAINED: "Unexplained",
};

function Enrolments({ user, entityId, onChanged, reloadKey }) {
  const nameOf = useTenantNames();
  const list = useCursorList(({ cursor }) => listShadowEnrolments({ seller_entity_id: entityId || undefined, cursor }),
    [entityId, reloadKey]);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [proposing, setProposing] = useState(false);
  const [ending, setEnding] = useState(null);
  const admin = isOrgAdmin(user?.role);
  const open = list.items.some((e) => ["PROPOSED", "ACTIVE"].includes(e.state));
  const act = async (key, fn) => {
    setBusy(key);
    setError(null);
    try { await fn(); onChanged(); } catch (err) { setError(describeError(err)); } finally { setBusy(null); }
  };
  return (
    <div className="space-y-2">
      <InlineError message={error} />
      {admin && entityId && !open && (
        <Button size="sm" variant="primary" onClick={() => setProposing(true)}>Propose shadowing this entity</Button>
      )}
      {!entityId && <p className={`text-sm ${MUTED}`}>Choose a seller entity to propose shadowing it.</p>}
      <ul className="space-y-2">
        {list.items.map((e) => (
          <li key={e.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className={`text-sm font-semibold ${STRONG}`}>Shadow #{e.id}</span>
              <TaxStatusBadge status={e.state === "ACTIVE" ? "SHADOWING" : e.state} />
            </div>
            <p className={`text-xs ${MUTED}`}>
              Proposed by {nameOf(e.proposed_by)}{e.reason ? `: ${e.reason}` : ""}
              {e.started_at ? ` · started ${formatDateTime(e.started_at)} by ${nameOf(e.approved_by)}` : ""}
              {e.ended_at ? ` · ended ${formatDateTime(e.ended_at)}` : ""}
            </p>
            {e.exit_signal && (
              <p role="status" className={`mt-1 text-sm ${e.exit_signal.ready ? "text-emerald-800 dark:text-emerald-200" : STRONG}`}>
                <TaxStatusBadge status={e.exit_signal.ready ? "EXIT_READY" : "EXIT_NOT_YET"} /> {e.exit_signal.message}
              </p>
            )}
            <DecisionBar user={user} record={{ ...e, status: e.status }} proposerId={e.proposed_by} noun="shadow"
                         decide={decideShadow} withdraw={withdrawShadow} withdrawRoles={["org_admin"]} onDone={onChanged} />
            <ActionBar busyKey={busy} actions={[
              { key: `end-${e.id}`, label: "End shadowing", hidden: !admin || e.state !== "ACTIVE",
                onClick: () => setEnding(e) },
            ]} />
          </li>
        ))}
      </ul>
      <LoadMore list={list} noun="shadow periods" />
      <ReasonModal open={proposing} title="Propose shadowing" submitLabel="Propose" busy={false} error={null} minLength={3}
                   description="Invoices stay on legacy tax. Each one issued while shadowing is compared with what governed tax would have been. A different finance approver approves."
                   onCancel={() => setProposing(false)}
                   onSubmit={(reason) => { setProposing(false);
                     act("propose", () => proposeShadow({ seller_entity_id: Number(entityId), reason })); }} />
      <ReasonModal open={Boolean(ending)} title="End shadowing" submitLabel="End" busy={false} error={null}
                   onCancel={() => setEnding(null)}
                   onSubmit={(reason) => { const e = ending; setEnding(null); act(`end-${e.id}`, () => endShadow(e.id, reason)); }} />
    </div>
  );
}

function Summary({ entityId, reloadKey }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let cancelled = false;
    getShadowSummary({ seller_entity_id: entityId }).then((d) => { if (!cancelled) setData(d); })
      .catch((err) => { if (!cancelled) setError(err?.message || "Couldn't load the shadow summary."); });
    return () => { cancelled = true; };
  }, [entityId, reloadKey]);
  if (error) return <InlineError message={error} />;
  if (!data) return null;
  const pct = data.match_rate == null ? "—" : `${Math.round(data.match_rate * 1000) / 10}%`;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
        <h3 className={`text-sm font-bold ${STRONG}`}>Match rate</h3>
        <p className={`text-2xl font-bold ${STRONG}`}>{pct}</p>
        <p className={`text-xs ${MUTED}`}>{data.compared} invoice(s) compared · {data.unexplained} unexplained</p>
      </div>
      <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
        <h3 className={`text-sm font-bold ${STRONG}`}>Differences by cause</h3>
        <ul className={`text-sm ${STRONG}`}>
          {Object.entries(data.differences_by_cause).map(([cause, n]) => <li key={cause}>{CAUSE_LABELS[cause] || humanize(cause)}: {n}</li>)}
          {!Object.keys(data.differences_by_cause).length && <li className={MUTED}>None</li>}
        </ul>
      </div>
      <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
        <h3 className={`text-sm font-bold ${STRONG}`}>Would have been blocked</h3>
        <ul className={`text-sm ${STRONG}`}>
          {Object.entries(data.would_have_been_blocked).map(([why, n]) => <li key={why}>{humanize(why)}: {n}</li>)}
          {!Object.keys(data.would_have_been_blocked).length && <li className={MUTED}>None</li>}
        </ul>
      </div>
    </div>
  );
}

function ComparisonDetail({ id }) {
  const [row, setRow] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { getShadowComparison(id).then(setRow).catch((e) => setError(e?.message)); }, [id]);
  if (error) return <InlineError message={error} />;
  if (!row) return <p className={`text-xs ${MUTED}`}>Loading…</p>;
  const lines = row.lines?.lines || [];
  const issues = row.lines?.issues || [];
  return (
    <div className="mt-2 overflow-x-auto">
      {lines.length > 0 && (
        <table className="min-w-full text-left text-xs">
          <caption className="sr-only">Lines of invoice {row.invoice_number}</caption>
          <thead><tr className={MUTED}>
            {["Line", "Legacy rate", "Governed rate", "Legacy tax", "Governed tax", "Difference", "Components"].map((h) => (
              <th key={h} scope="col" className="py-1 pr-3">{h}</th>))}
          </tr></thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.line_number} className="border-t border-slate-100 dark:border-slate-800">
                <td className="py-1 pr-3">{l.line_number}</td><td className="py-1 pr-3">{l.legacy_rate}%</td>
                <td className="py-1 pr-3">{Number(l.shadow_rate)}%</td><td className="py-1 pr-3">{l.legacy_tax}</td>
                <td className="py-1 pr-3">{l.shadow_tax}</td><td className="py-1 pr-3">{l.difference}</td>
                <td className="py-1">{l.components.map((c) => `${c.label || c.component_code} ${Number(c.rate_percent)}%: ${c.tax}`).join("; ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {issues.length > 0 && (
        <ul className="text-xs text-amber-900 dark:text-amber-200">
          {issues.map((i, n) => <li key={n}>{i.code}: {i.message || i.reason || ""}</li>)}
        </ul>
      )}
    </div>
  );
}

function Comparisons({ entityId, reloadKey }) {
  const base = useId();
  const [outcome, setOutcome] = useState("");
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const list = useCursorList(({ cursor }) => listShadowComparisons({ seller_entity_id: entityId, outcome, cursor }),
    [entityId, outcome, reloadKey]);
  const exportCsv = async () => {
    setBusy(true);
    setError(null);
    try { saveFile("tax-shadow-comparisons.csv", String(await exportShadowComparisons({ seller_entity_id: entityId, outcome }) ?? ""), "text/csv"); }
    catch (err) { setError(err?.message || "The export failed."); }
    finally { setBusy(false); }
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="w-56">
          <Field label="Outcome" htmlFor={`${base}-o`}>
            <Select id={`${base}-o`} value={outcome} onChange={setOutcome} placeholder="All outcomes"
                    options={OUTCOMES.map((o) => ({ value: o, label: humanize(o) }))} />
          </Field>
        </div>
        <Button size="sm" icon={Download} loading={busy} onClick={exportCsv}>Export CSV</Button>
      </div>
      <InlineError message={error || list.error} />
      <ul className="space-y-2">
        {list.items.map((c) => (
          <li key={c.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className={`text-sm font-semibold ${STRONG}`}>{c.invoice_number} · {c.issue_date}</span>
              <TaxStatusBadge status={c.outcome === "DIFFERENT" ? "SHADOW_DIFFERENT" : c.outcome === "MATCH" ? "SHADOW_MATCH" : c.outcome} />
            </div>
            <p className={`text-xs ${MUTED}`}>
              Legacy tax {c.legacy_tax} · governed {c.shadow_tax ?? "—"} · difference {c.tax_difference ?? "—"} {c.currency}
              {c.cause ? ` · ${CAUSE_LABELS[c.cause] || humanize(c.cause)}` : ""}{c.reason ? ` · ${c.reason}` : ""}
            </p>
            <Button size="sm" icon={Eye} onClick={() => setOpen(open === c.id ? null : c.id)} aria-expanded={open === c.id}>
              {open === c.id ? "Hide lines" : "Show lines"}
            </Button>
            {open === c.id && <ComparisonDetail id={c.id} />}
          </li>
        ))}
      </ul>
      {!list.loading && !list.items.length && <p className={`text-sm ${MUTED}`}>No invoices compared yet.</p>}
      <LoadMore list={list} noun="invoices" />
    </div>
  );
}

export function ShadowScreen({ user }) {
  const { entities } = useLegalEntities();
  const [entityId, setEntityId] = useState("");
  const [reload, setReload] = useState(0);
  const refresh = useCallback(() => setReload((n) => n + 1), []);
  return (
    <section className={`${PANEL} space-y-5`} aria-labelledby="shadow-title">
      <SectionTitle id="shadow-title" title="Shadow compare">
        Try governed tax before switching: invoices stay on legacy tax, and each one is compared with what governed
        tax would have been. Nothing that is invoiced changes.
      </SectionTitle>
      <div className="w-72"><EntitySelect entities={entities} value={entityId} onChange={setEntityId} /></div>
      <Enrolments user={user} entityId={entityId} onChanged={refresh} reloadKey={reload} />
      <Summary entityId={entityId} reloadKey={reload} />
      <Comparisons entityId={entityId} reloadKey={reload} />
    </section>
  );
}
