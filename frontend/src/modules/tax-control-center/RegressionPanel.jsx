import { useCallback, useEffect, useState } from "react";

import { Button } from "../../components/billing-ui";
import { canWriteTaxRegistry } from "./access";
import { InlineError, MUTED, STRONG, TaxStatusBadge, formatDateTime } from "./shared";
import { getRegression, runRegression } from "./taxRegistryService";

/* Historical regression (Phase 7 PR 2): replays anonymised invoice fixtures
 * through the engine before and after this version and lists every change.
 * Approval is refused without a current report; the backend decides. */

export function RegressionPanel({ kind, id, user }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const load = useCallback(() => {
    getRegression(kind, id).then(setData).catch((err) => setError(err?.message || "Couldn't load the regression report."));
  }, [kind, id]);
  useEffect(() => { load(); }, [load]);
  const run = async () => {
    setBusy(true);
    setError(null);
    try { await runRegression(kind, id); load(); } catch (err) { setError(err?.message || "The regression failed."); }
    finally { setBusy(false); }
  };
  const report = data?.report;
  const current = data && !data.current_problem;
  return (
    <div className="space-y-2" aria-label="Regression report" role="group">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className={`text-sm font-bold ${STRONG}`}>Historical regression</h3>
        {data && <TaxStatusBadge status={current ? "REGRESSION_CURRENT" : "REGRESSION_MISSING"} />}
      </div>
      <InlineError message={error} />
      {data?.current_problem && <p className="text-xs text-amber-900 dark:text-amber-200">Approval is refused until it is current: {data.current_problem}.</p>}
      {report && (
        <div className={`text-sm ${STRONG}`}>
          <p>
            {report.cases} case(s) from {(report.fixture_sets || []).join(", ")} · {report.changed.length} changed ·
            {" "}{report.unchanged} unchanged · {report.new_cases.length} new · run {formatDateTime(report.generated_at)}
          </p>
          {report.changed.length > 0 && (
            <ul className={`mt-1 text-xs ${MUTED}`} aria-label="Changed cases">
              {report.changed.map((c) => (
                <li key={c.case}>
                  <strong>{c.case}</strong>: tax {c.before.tax ?? "not determined"} → {c.after.tax ?? "not determined"}
                  {c.before.lines?.[0]?.rate !== c.after.lines?.[0]?.rate
                    ? ` (rate ${c.before.lines?.[0]?.rate ?? "—"}% → ${c.after.lines?.[0]?.rate ?? "—"}%)` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {canWriteTaxRegistry(user?.platform_role) && (
        <Button size="sm" loading={busy} onClick={run}>{report ? "Run regression again" : "Run regression"}</Button>
      )}
    </div>
  );
}
