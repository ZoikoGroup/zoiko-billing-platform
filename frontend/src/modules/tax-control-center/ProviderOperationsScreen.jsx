import { useCallback, useEffect, useState } from "react";

import { canApproveTaxRegistry, ROLE_REASON } from "./access";
import {
  ActionBar, InlineError, MUTED, PANEL, ReasonModal, STRONG, TaxStatusBadge, formatAge, humanize, useStepUp,
} from "./shared";
import {
  getPlatformDuplicates, getPlatformOvercollection, getProviderHealth, listAnomalyRuns, providerHealthAction,
} from "./taxRegistryService";

/* P9 Provider operations and P10 Findings (Phase 5c PR 2). Aggregate only
 * (T13): counts, ages and totals; never an organization, invoice or
 * customer. Suspend and resume need TAX_PUBLISHER and MFA step-up. */

const STALE_HEARTBEAT_SECONDS = 15 * 60;

function Heartbeat({ reconciliation }) {
  const age = reconciliation?.last_finished_age_seconds;
  const fresh = age != null && age < STALE_HEARTBEAT_SECONDS && reconciliation?.last_ok;
  return (
    <p className={`flex flex-wrap items-center gap-2 text-sm ${STRONG}`}>
      <span className="font-semibold">Reconciliation worker:</span>
      <TaxStatusBadge status={fresh ? "HEALTHY" : "UNHEALTHY"} />
      <span className={MUTED}>
        {age == null ? "has not run yet" : `last finished ${formatAge(age)} ago${reconciliation.last_ok ? "" : ", with errors"}`}
      </span>
    </p>
  );
}

function ProviderRow({ p, user, onChanged }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [suspending, setSuspending] = useState(false);
  const stepUp = useStepUp();
  const approver = canApproveTaxRegistry(user?.platform_role);
  const act = async (key, fn) => {
    setBusy(key);
    setError(null);
    try { const r = await stepUp.run(fn); if (r) onChanged(r); }
    catch (err) { setError(err?.message || "The action failed."); }
    finally { setBusy(null); }
  };
  const counts = Object.entries(p.counts || {});
  return (
    <li className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className={`text-sm font-semibold ${STRONG}`}>{p.provider}</span>
        <TaxStatusBadge status={p.circuit} />
      </div>
      <p className={`text-xs ${MUTED}`}>
        Oldest active item: {formatAge(p.oldest_active_age_seconds)}
        {counts.length ? ` · ${counts.map(([state, n]) => `${humanize(state)}: ${n}`).join(" · ")}` : " · no transactions"}
      </p>
      <InlineError message={error} />
      <div className="mt-2">
        <ActionBar busyKey={busy} actions={[
          { key: `suspend-${p.provider}`, label: "Suspend provider", hidden: p.circuit === "SUSPENDED",
            reason: approver ? null : ROLE_REASON, onClick: () => setSuspending(true) },
          { key: `resume-${p.provider}`, label: "Resume provider", variant: "primary", hidden: p.circuit !== "SUSPENDED",
            reason: approver ? null : ROLE_REASON,
            onClick: () => act(`resume-${p.provider}`, (body) => providerHealthAction(p.provider, "resume", body)) },
        ]} />
      </div>
      <ReasonModal open={suspending} title={`Suspend ${p.provider}`} submitLabel="Suspend" busy={false} error={null} minLength={3}
                   description="Every tenant's quotes and issuing through this provider stop (PROVIDER_UNAVAILABLE) until it is resumed."
                   onCancel={() => setSuspending(false)}
                   onSubmit={(reason) => { setSuspending(false);
                     act(`suspend-${p.provider}`, (body) => providerHealthAction(p.provider, "suspend", { ...body, reason })); }} />
      {stepUp.modal}
    </li>
  );
}

export default function ProviderOperationsScreen({ user }) {
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => {
    getProviderHealth().then(setHealth).catch((err) => setError(err?.message || "Couldn't load provider health."));
  }, []);
  useEffect(() => { load(); }, [load]);
  return (
    <section className={`${PANEL} space-y-4`} aria-labelledby="p9-title">
      <div>
        <h2 id="p9-title" className={`text-lg font-bold ${STRONG}`}>Provider operations</h2>
        <p className={`text-sm ${MUTED}`}>
          Health across all tenants, as counts only. Suspending a provider stops its quotes and issuing everywhere;
          it needs a reason, the tax publisher role and MFA.
        </p>
      </div>
      <InlineError message={error} />
      {health && (
        <>
          <Heartbeat reconciliation={health.reconciliation} />
          {!health.providers?.length && <p className={`text-sm ${MUTED}`}>No provider has been used yet.</p>}
          <ul className="space-y-2">
            {(health.providers || []).map((p) => <ProviderRow key={p.provider} p={p} user={user} onChanged={setHealth} />)}
          </ul>
        </>
      )}
    </section>
  );
}

const ANOMALY_LABELS = { snapshot: "Invoices that differ from their tax snapshot", provider_drift: "Provider totals that differ from ours",
  credits: "Credit notes exceeding the original" };

/** Phase 7 PR 3: the latest daily anomaly check, counts and market shares only. */
function AnomalyChecks() {
  const [runs, setRuns] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    listAnomalyRuns().then((d) => setRuns(d.items || [])).catch((err) => setError(err?.message || "Couldn't load anomaly checks."));
  }, []);
  if (error) return <InlineError message={error} />;
  if (!runs) return null;
  const last = runs[0];
  return (
    <div aria-labelledby="anomaly-title">
      <h3 id="anomaly-title" className={`mb-1 text-sm font-bold ${STRONG}`}>Daily anomaly checks</h3>
      {!last ? <p className={`text-sm ${MUTED}`}>No check has run yet.</p> : (
        <>
          <p className={`text-xs ${MUTED}`}>Last run {new Date(last.started_at).toLocaleString()}. Each tenant has review items for its own invoices.</p>
          <ul className={`mt-1 text-sm ${STRONG}`}>
            {Object.entries(last.counts).map(([k, v]) => (
              <li key={k}>{ANOMALY_LABELS[k] || humanize(k)}: {v.found} of {v.checked} checked</li>
            ))}
          </ul>
          <ul className={`mt-1 text-sm ${STRONG}`} aria-label="Markets">
            {Object.entries(last.markets).map(([m, v]) => (
              <li key={m} className="flex flex-wrap items-center gap-2">
                <span>{m}: {v.invoices} invoice(s), zero tax {Math.round(v.zero_tax_share * 100)}% (baseline {Math.round(v.baseline_zero_tax_share * 100)}%)</span>
                {(v.zero_tax_alert || v.rate_mix_alert) && <TaxStatusBadge status="REVIEW_REQUIRED" />}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function FindingsScreen() {
  const [over, setOver] = useState(null);
  const [dups, setDups] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let cancelled = false;
    Promise.all([getPlatformOvercollection(), getPlatformDuplicates()])
      .then(([o, d]) => { if (!cancelled) { setOver(o); setDups(d); } })
      .catch((err) => { if (!cancelled) setError(err?.message || "Couldn't load the findings."); });
    return () => { cancelled = true; };
  }, []);
  return (
    <section className={`${PANEL} space-y-5`} aria-labelledby="p10-title">
      <div>
        <h2 id="p10-title" className={`text-lg font-bold ${STRONG}`}>Findings</h2>
        <p className={`text-sm ${MUTED}`}>
          Legacy findings across all tenants, as counts and totals only. Tenants see their own invoice detail under
          Tax governance → Reports.
        </p>
      </div>
      <InlineError message={error} />
      {over && (
        <div>
          <h3 className={`mb-1 text-sm font-bold ${STRONG}`}>Legacy over-collection (discount after tax)</h3>
          <p className={`text-sm ${STRONG}`}>{over.organizations_affected} organization(s) · {over.invoice_count} invoice(s)</p>
          <ul className={`mt-1 text-sm ${STRONG}`}>
            {(over.totals_by_currency || []).map((t) => (
              <li key={t.currency}>
                {t.currency}: {t.invoice_count} invoice(s), tax charged {t.tax_amount}, estimated over-collected {t.estimated_overcollected_tax}
              </li>
            ))}
          </ul>
          <p className={`mt-1 text-xs ${MUTED}`}>{over.method}</p>
        </div>
      )}
      {dups && (
        <div>
          <h3 className={`mb-1 text-sm font-bold ${STRONG}`}>Duplicate tax rows</h3>
          <p className={`text-sm ${STRONG}`}>
            {dups.duplicate_rows} duplicate row(s) on {dups.invoices_affected} invoice(s) in {dups.organizations_affected} organization(s).
          </p>
          <p className={`text-xs ${MUTED}`}>{dups.note}</p>
        </div>
      )}
      <AnomalyChecks />
    </section>
  );
}
