import { useCallback, useEffect, useState } from "react";

import { Button } from "../../components/billing-ui";
import { canApproveTaxRegistry, canWriteTaxRegistry } from "./access";
import { getRetroPreview, listRetroAnalyses, runRetroPreview } from "./taxRegistryService";
import { InlineError, LoadMore, MUTED, PANEL, STRONG, TaxStatusBadge, formatDateTime, humanize, useCursorList } from "./shared";

/* Phase 8 PR 4: retroactive change analysis, platform side. Aggregates only
 * (no tenant identifiers); amounts are magnitude bands when fewer than three
 * organizations are affected. */

export function AggregateSummary({ aggregates }) {
  if (!aggregates) return null;
  const statuses = Object.entries(aggregates.by_status || {});
  const currencies = Object.entries(aggregates.per_currency || {});
  return (
    <div className={`text-sm ${STRONG}`}>
      <p>
        {aggregates.organizations_affected} organization(s), {aggregates.documents} document(s)
        {statuses.length > 0 && <> ({statuses.map(([s, n]) => `${n} ${humanize(s).toLowerCase()}`).join(", ")})</>}
      </p>
      {currencies.length > 0 && (
        <ul className={`mt-1 text-xs ${MUTED}`} aria-label="Net difference per currency">
          {currencies.map(([cur, v]) => (
            <li key={cur}><strong>{cur}</strong>: net {v.net}, over-collected {v.over}, under-collected {v.under}</li>
          ))}
        </ul>
      )}
      {aggregates.amounts && aggregates.amounts !== "exact" && <p className={`text-xs ${MUTED}`}>Amounts {aggregates.amounts}.</p>}
    </div>
  );
}

/* On a staged rate or a pack version: a retroactive version needs a current
 * preview before it can be approved or published (the backend decides). */
export function RetroPreviewPanel({ kind, id, user }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const load = useCallback(() => {
    getRetroPreview(kind, id).then(setData).catch((err) => setError(err?.message || "Couldn't load the preview."));
  }, [kind, id]);
  useEffect(() => { load(); }, [load]);
  if (!data || (!data.retroactive && !data.preview)) return null;
  const run = async () => {
    setBusy(true);
    setError(null);
    try { await runRetroPreview(kind, id); load(); } catch (err) { setError(err?.message || "The preview failed."); }
    finally { setBusy(false); }
  };
  const current = !data.current_problem;
  const canRun = canWriteTaxRegistry(user?.platform_role) || canApproveTaxRegistry(user?.platform_role);
  return (
    <div className="space-y-2" role="group" aria-label="Retroactive analysis preview">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className={`text-sm font-bold ${STRONG}`}>Retroactive analysis preview</h3>
        <TaxStatusBadge status={current ? "REGRESSION_CURRENT" : "REGRESSION_MISSING"} />
      </div>
      {data.retroactive && <p className={`text-sm ${STRONG}`}>This version changes tax for past dates.</p>}
      <InlineError message={error} />
      {data.current_problem && (
        <p className="text-xs text-amber-900 dark:text-amber-200">Approval and publishing are refused until it is current: {data.current_problem}.</p>
      )}
      {data.preview && (
        <>
          <p className={`text-xs ${MUTED}`}>{data.preview.basis_label}; tax dates {data.preview.range_from || "from the start"} to {data.preview.range_to}; run {formatDateTime(data.preview.created_at)}.</p>
          <AggregateSummary aggregates={data.preview.aggregates} />
        </>
      )}
      {canRun && <Button size="sm" loading={busy} onClick={run}>{data.preview ? "Run preview again" : "Run preview"}</Button>}
    </div>
  );
}

export default function RetroAnalysesScreen() {
  const list = useCursorList(({ cursor }) => listRetroAnalyses({ cursor }), []);
  return (
    <section className={PANEL} aria-labelledby="retro-title">
      <div className="mb-4">
        <h2 id="retro-title" className={`text-lg font-bold ${STRONG}`}>Retroactive analyses</h2>
        <p className={`text-sm ${MUTED}`}>Issued invoices compared after a rollback or a rate or pack change for past dates. Read-only: nothing issued changes. Aggregates only; each organization sees its own report.</p>
      </div>
      <InlineError message={list.error} />
      <ul className="space-y-3">
        {list.items.map((a) => (
          <li key={a.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className={`font-semibold ${STRONG}`}>Analysis #{a.id}: {humanize(a.trigger_kind)} #{a.trigger_id}{a.severity ? ` (${a.severity})` : ""}</span>
              <TaxStatusBadge status={a.status === "DONE" ? "DONE" : a.status === "FAILED" ? "ERROR" : "SHADOWING"} />
            </div>
            <p className={`text-xs ${MUTED}`}>{a.basis_label}; tax dates {a.range_from || "from the start"} to {a.range_to || "open"}.</p>
            {a.status !== "DONE" && (
              <p className={`text-xs ${MUTED}`}>Progress: {a.progress.organizations_done} of {a.progress.organizations_total} organization(s); {a.progress.documents_total} document(s) in scope.</p>
            )}
            {a.error && <p className="text-xs text-red-800 dark:text-red-200">Failed, will retry: {a.error}</p>}
            <AggregateSummary aggregates={a.aggregates} />
          </li>
        ))}
      </ul>
      {!list.loading && list.items.length === 0 && <p className={`py-6 text-center text-sm ${MUTED}`}>No retroactive analysis has run.</p>}
      <LoadMore list={list} noun="analyses" />
    </section>
  );
}
