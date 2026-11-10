import { useEffect, useState } from "react";

import { Button } from "../../components/billing-ui";
import {
  InlineError, LoadMore, MUTED, PANEL, STRONG, TaxStatusBadge, formatDateTime, humanize, saveFile, useCursorList,
} from "../tax-control-center/shared";
import { SectionTitle } from "./common";
import { exportRetroDocuments, listRetroAnalyses, listRetroDocuments } from "./governanceService";

/* Phase 8 PR 4: the organization's own retroactive analyses. Issued
 * invoices are compared, never changed; over-collection shows a proposed
 * tax-only credit as a preview (drafts arrive later); under-collection is
 * report only. Organization admins and finance approvers only. */

const canRead = (role) => role === "org_admin" || role === "finance_approver";

function Totals({ perCurrency }) {
  const rows = Object.entries(perCurrency || {});
  if (!rows.length) return null;
  return (
    <ul className={`text-xs ${MUTED}`}>
      {rows.map(([cur, v]) => <li key={cur}><strong>{cur}</strong>: net {v.net}, over-collected {v.over}, under-collected {v.under}</li>)}
    </ul>
  );
}

function Lines({ lines }) {
  if (!lines?.length) return null;
  return (
    <table className="mt-2 w-full text-xs">
      <caption className="sr-only">Original and comparison per line</caption>
      <thead><tr className={MUTED}><th scope="col" className="text-left">Line</th><th scope="col" className="text-left">Original</th><th scope="col" className="text-left">Comparison</th></tr></thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.line_number}>
            <td>{l.line_number}</td>
            <td>{humanize(l.original.outcome)} · {Number(l.original.rate)}% · {l.original.tax}</td>
            <td>{humanize(l.comparison.outcome)} · {Number(l.comparison.rate)}% · {l.comparison.tax}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Documents({ analysis }) {
  const list = useCursorList(({ cursor }) => listRetroDocuments(analysis.id, { cursor }), [analysis.id]);
  const [error, setError] = useState(null);
  const exportCsv = async () => {
    setError(null);
    try { saveFile(`tax-retro-analysis-${analysis.id}.csv`, String((await exportRetroDocuments(analysis.id)) ?? ""), "text/csv"); }
    catch (err) { setError(err?.message || "Couldn't export the report."); }
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className={`text-sm font-bold ${STRONG}`}>Documents in analysis #{analysis.id}</h3>
        <Button size="sm" onClick={exportCsv}>Export CSV</Button>
      </div>
      <InlineError message={error || list.error} />
      <ul className="space-y-2">
        {list.items.map((d) => (
          <li key={d.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className={`text-sm font-semibold ${STRONG}`}>Invoice #{d.invoice_id}</span>
              <TaxStatusBadge status={d.status === "COMPARED" ? (d.direction === "OVER" ? "REVIEW_REQUIRED" : "SHADOW_DIFFERENT") : d.status === "NO_DIFFERENCE" ? "SHADOW_MATCH" : "UNCHECKED"} />
            </div>
            <p className={`text-xs ${MUTED}`}>{humanize(d.status)}{d.reason ? `: ${d.reason}` : ""}</p>
            {d.difference != null && (
              <p className={`text-sm ${STRONG}`}>
                Tax charged {d.original_tax} {d.currency}; comparison {d.comparison_tax}; {d.direction === "OVER" ? "over-collected" : d.direction === "UNDER" ? "under-collected" : "difference"} {String(d.difference).replace("-", "")}
              </p>
            )}
            {d.superseded_by && <p className="text-xs text-amber-900 dark:text-amber-200">Superseded by analysis #{d.superseded_by}.</p>}
            <Lines lines={d.lines} />
            {d.remediation_preview && (
              <p className={`mt-1 text-xs ${STRONG}`}>Proposed {d.remediation_preview.kind}: {d.remediation_preview.amount} {d.currency}. {d.remediation_preview.drafts}</p>
            )}
            {d.under_collection && <p className={`mt-1 text-xs ${MUTED}`}>{d.under_collection}</p>}
            <p className={`mt-1 text-xs ${MUTED}`}>{d.basis_label}</p>
          </li>
        ))}
      </ul>
      <LoadMore list={list} noun="documents" />
    </div>
  );
}

export function RetroScreen({ user }) {
  const allowed = canRead(user?.role);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(null);
  useEffect(() => {
    if (allowed) listRetroAnalyses().then(setData).catch((err) => setError(err?.message || "Couldn't load the analyses."));
  }, [allowed]);
  if (!allowed) {
    return (
      <section className={PANEL} aria-labelledby="retro-title">
        <SectionTitle id="retro-title" title="Retroactive analysis" />
        <p className={`text-sm ${MUTED}`}>Retroactive analysis is for organization admins and finance approvers.</p>
      </section>
    );
  }
  return (
    <section className={`${PANEL} space-y-4`} aria-labelledby="retro-title">
      <SectionTitle id="retro-title" title="Retroactive analysis">
        When tax rules for past dates change, your issued invoices are compared here. Issued invoices are never changed.
      </SectionTitle>
      <InlineError message={error} />
      {data && (
        <p className={`text-xs ${MUTED}`}>
          {data.remediation_enabled ? "Correction drafts are enabled for your organization." : "Corrections are a preview only for now."} Under-collection: {data.under_collection}
        </p>
      )}
      <ul className="space-y-2">
        {(data?.items || []).map((a) => (
          <li key={a.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className={`text-sm font-semibold ${STRONG}`}>Analysis #{a.id}: {humanize(a.trigger_kind)}</span>
              <Button size="sm" onClick={() => setOpen(a)} aria-pressed={open?.id === a.id}>Show documents</Button>
            </div>
            <p className={`text-xs ${MUTED}`}>{a.basis_label}; tax dates {a.range_from || "from the start"} to {a.range_to || "open"}; {a.documents} document(s){a.finished_at ? `; finished ${formatDateTime(a.finished_at)}` : ""}.</p>
            <p className={`text-xs ${MUTED}`}>{Object.entries(a.by_status || {}).map(([s, n]) => `${n} ${humanize(s).toLowerCase()}`).join(", ")}</p>
            <Totals perCurrency={a.per_currency} />
          </li>
        ))}
      </ul>
      {data && !data.items.length && <p className={`text-sm ${MUTED}`}>No retroactive analysis has affected your organization.</p>}
      {open && <Documents analysis={open} />}
    </section>
  );
}
