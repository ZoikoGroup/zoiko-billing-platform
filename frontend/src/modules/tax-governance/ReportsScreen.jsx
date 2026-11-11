import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Download, Lock } from "lucide-react";

import { Button } from "../../components/billing-ui";
import { InlineError, MUTED, PANEL, STRONG, humanize, saveFile } from "../tax-control-center/shared";
import { fetchAllPages } from "../tax-control-center/taxRegistryService";
import { SectionTitle } from "./common";
import {
  getDuplicateRowsReport, getOvercollectionReport, getShadowSummary, listLegalEntities, listRemediationBatches,
  listRetroAnalyses, listReviewItems,
} from "./governanceService";
import { ANOMALY_KINDS, formatMoney } from "./money";

/* T10 Reports hub (Phase 5c; Phase 8 PR 6): every tax report for this
 * organization in one place: legacy findings, shadow compare, anomaly
 * findings, remediation and retroactive analyses. Each card loads on its own
 * (an error or a refused API stays on that card), links to its own screen,
 * and shows amounts with the currency's minor units. Read-only. Org admins and
 * finance approvers only. */

export const canReadTaxReports = (role) => role === "org_admin" || role === "finance_approver";
const BASE = "/billing/tax/governance";

function useCard(load, deps = []) {
  const [state, setState] = useState({ loading: true });
  useEffect(() => {
    let cancelled = false;
    setState({ loading: true });
    load().then((data) => { if (!cancelled) setState({ data }); })
      .catch((err) => { if (!cancelled) setState({ denied: err?.status === 403, error: err?.message || "Couldn't load this report." }); });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

function Card({ id, title, state, link, linkLabel, notApplicable, children, actions }) {
  return (
    <div className="space-y-2 rounded-xl border border-slate-200 p-4 dark:border-slate-700" aria-labelledby={id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={id} className={`text-sm font-bold ${STRONG}`}>{title}</h3>
        <span className="flex flex-wrap items-center gap-2">
          {actions}
          {link && <Link to={link} className="text-sm font-semibold text-brand-700 underline underline-offset-2 dark:text-brand-300">{linkLabel}</Link>}
        </span>
      </div>
      {notApplicable ? <p className={`text-sm ${MUTED}`}>{notApplicable}</p>
        : state.loading ? <p className={`text-sm ${MUTED}`}>Loading…</p>
          : state.denied ? (
            <p className={`flex items-start gap-2 text-sm ${MUTED}`}><Lock size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
              Your role can't open this report.</p>
          ) : state.error ? <InlineError message={state.error} /> : children}
    </div>
  );
}

function CsvButton({ label, fetchCsv, filename }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try { saveFile(filename, String((await fetchCsv()) ?? ""), "text/csv"); }
    catch (err) { setError(err?.message || "The export failed."); }
    finally { setBusy(false); }
  };
  return (
    <span>
      <Button size="sm" icon={Download} loading={busy} onClick={run}>{label}</Button>
      <InlineError message={error} />
    </span>
  );
}

function Table({ caption, columns, rows, empty }) {
  if (!rows.length) return <p className={`text-sm ${MUTED}`}>{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className={`border-b border-slate-200 text-xs uppercase dark:border-slate-700 ${MUTED}`}>
            {columns.map(([key, label]) => <th key={key} scope="col" className="px-2 py-2 font-semibold">{label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.invoice_id ?? row.currency ?? i} className="border-b border-slate-100 dark:border-slate-800">
              {columns.map(([key, , fmt]) => (
                <td key={key} className={`px-2 py-2 ${STRONG}`}>{fmt ? fmt(row[key], row) : (row[key] ?? "—")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ReportsScreen({ user }) {
  const allowed = canReadTaxReports(user?.role);
  if (!allowed) {
    return (
      <section className={PANEL} aria-labelledby="t10-title">
        <SectionTitle id="t10-title" title="Reports" />
        <p className={`flex items-start gap-2 text-sm ${MUTED}`}>
          <Lock size={15} className="mt-0.5 shrink-0" aria-hidden="true" />
          Tax findings reports are available to organization admins and finance approvers.
        </p>
      </section>
    );
  }
  return <Hub />;
}

function Hub() {
  const entities = useCard(() => fetchAllPages(listLegalEntities));
  const over = useCard(() => getOvercollectionReport());
  const dups = useCard(() => getDuplicateRowsReport());
  const shadow = useCard(() => getShadowSummary());
  const anomalies = useCard(() => fetchAllPages(({ cursor }) => listReviewItems({ kinds: ANOMALY_KINDS, cursor })));
  const batches = useCard(() => fetchAllPages(listRemediationBatches));
  const retro = useCard(() => listRetroAnalyses());

  const regimes = new Set((entities.data || []).map((e) => e.tax_regime));
  const known = Boolean(entities.data);
  const governed = regimes.has("GOVERNED");
  const legacy = regimes.has("LEGACY_MANUAL") || (known && regimes.size === 0);
  const notGoverned = known && !governed ? "Applies once your entity uses governed tax." : null;
  const notLegacy = known && !legacy ? "Applies to invoices issued under legacy manual tax; all your entities use governed tax." : null;

  const byState = (rows) => Object.entries(rows.reduce((acc, b) => ({ ...acc, [b.state]: (acc[b.state] || 0) + 1 }), {}));

  return (
    <section className={`${PANEL} space-y-4`} aria-labelledby="t10-title">
      <SectionTitle id="t10-title" title="Reports">
        Every tax report for your organization. Read-only: no invoice is changed here.
      </SectionTitle>

      <Card id="t10-over" title="Legacy over-collection (discount after tax)" state={over} notApplicable={notLegacy}
            actions={over.data && <CsvButton label="Export CSV" filename="tax-legacy-discount-overcollection.csv" fetchCsv={() => getOvercollectionReport("csv")} />}>
        {over.data && (
          <>
            <p className={`text-xs ${MUTED}`}>{over.data.method}</p>
            <Table caption="Over-collection totals by currency" empty="No affected invoices."
                   columns={[["currency", "Currency"], ["invoice_count", "Invoices"],
                             ["tax_amount", "Tax charged", (v, r) => formatMoney(v, r.currency)],
                             ["estimated_overcollected_tax", "Estimated over-collected", (v, r) => formatMoney(v, r.currency)]]}
                   rows={over.data.totals_by_currency || []} />
            <Table caption="Invoices with estimated over-collection" empty="No affected invoices."
                   columns={[["invoice_number", "Invoice"], ["issue_date", "Issued"], ["status", "Status", humanize],
                             ["document_discount", "Document discount", (v, r) => (r.discount_percentage > 0
                               ? `${formatMoney(v, r.currency)} (${r.discount_percentage}%)` : `${formatMoney(v, r.currency)} (fixed)`)],
                             ["tax_amount", "Tax charged", (v, r) => formatMoney(v, r.currency)],
                             ["estimated_overcollected_tax", "Estimated over-collected", (v, r) => formatMoney(v, r.currency)]]}
                   rows={over.data.invoices || []} />
          </>
        )}
      </Card>

      <Card id="t10-dups" title="Duplicate tax rows" state={dups} notApplicable={notLegacy}
            actions={dups.data && <CsvButton label="Export CSV" filename="tax-duplicate-tax-rows.csv" fetchCsv={() => getDuplicateRowsReport("csv")} />}>
        {dups.data && (
          <>
            <p className={`text-sm ${STRONG}`}>{dups.data.duplicate_rows} duplicate row(s). {dups.data.note}</p>
            <Table caption="Invoices with duplicate tax rows" empty="No duplicate rows."
                   columns={[["invoice_number", "Invoice"], ["duplicate_rows", "Duplicate rows"]]} rows={dups.data.invoices || []} />
          </>
        )}
      </Card>

      <Card id="t10-shadow" title="Shadow compare" state={shadow} notApplicable={notLegacy}
            link={`${BASE}/shadow`} linkLabel="Open shadow compare">
        {shadow.data && (shadow.data.compared ? (
          <p className={`text-sm ${STRONG}`}>
            {shadow.data.compared} invoice(s) compared; match rate {Math.round((shadow.data.match_rate || 0) * 100)}%;
            {" "}{shadow.data.would_have_been_blocked} would have been blocked; {shadow.data.unexplained} unexplained.
            {Object.keys(shadow.data.differences_by_cause || {}).length > 0 && (
              <> Differences: {Object.entries(shadow.data.differences_by_cause).map(([c, n]) => `${n} ${humanize(c).toLowerCase()}`).join(", ")}.</>
            )}
          </p>
        ) : <p className={`text-sm ${MUTED}`}>No shadow comparison yet: a legacy entity has to be enrolled in a shadow period.</p>)}
      </Card>

      <Card id="t10-anomalies" title="Anomaly findings" state={anomalies} notApplicable={notGoverned}
            link={`${BASE}/review?kind=anomalies`} linkLabel="Open in review items">
        {anomalies.data && (anomalies.data.length ? (
          <p className={`text-sm ${STRONG}`}>
            {anomalies.data.length} open finding(s): {ANOMALY_KINDS.map((k) => `${anomalies.data.filter((i) => i.kind === k).length} ${humanize(k).toLowerCase()}`).join(", ")}.
          </p>
        ) : <p className={`text-sm ${MUTED}`}>No open anomaly findings.</p>)}
      </Card>

      <Card id="t10-remediation" title="Remediation" state={batches} notApplicable={notLegacy}
            link={`${BASE}/remediation`} linkLabel="Open remediation">
        {batches.data && (batches.data.length ? (
          <p className={`text-sm ${STRONG}`}>{byState(batches.data).map(([s, n]) => `${n} ${humanize(s).toLowerCase()}`).join(", ")} batch(es).</p>
        ) : <p className={`text-sm ${MUTED}`}>No remediation batches yet.</p>)}
      </Card>

      <Card id="t10-retro" title="Retroactive analyses" state={retro} notApplicable={notGoverned}
            link={`${BASE}/retro`} linkLabel="Open retroactive analysis">
        {retro.data && (retro.data.items?.length ? (
          <ul className="space-y-1 text-sm">
            {retro.data.items.map((a) => (
              <li key={a.id} className={STRONG}>
                Analysis #{a.id} ({humanize(a.trigger_kind).toLowerCase()}): {a.documents} document(s)
                {Object.entries(a.per_currency || {}).map(([cur, v]) => ` · ${cur}: over-collected ${formatMoney(v.over, cur)}, under-collected ${formatMoney(v.under, cur)}`).join("")}
              </li>
            ))}
          </ul>
        ) : <p className={`text-sm ${MUTED}`}>No retroactive analysis has affected your organization yet.</p>)}
      </Card>
    </section>
  );
}
