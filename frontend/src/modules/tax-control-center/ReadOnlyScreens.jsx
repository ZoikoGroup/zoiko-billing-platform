import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { RateLookup } from "./RateLookup";
import {
  EvidenceExport, InlineError, LoadMore, MUTED, PANEL, STRONG, TaxStatusBadge, formatDateTime, humanize, useCursorList,
} from "./shared";
import {
  fetchAllPages, getEvidenceBundle, getProviderHealth, getReadiness, listApprovalsInbox, listCoverage,
  listJurisdictions, listTaxCodeSets, lookupReferenceRates,
} from "./taxRegistryService";

/* Read-only console screens (Phase 5c PR 3, minimum): P1 overview, P4
 * jurisdictions and rates explorer, P5 tax-code catalogue. Approvals stay in
 * the inbox; nothing here changes the registry. */

function Card({ title, children, to }) {
  return (
    <div className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
      <h3 className={`text-sm font-bold ${STRONG}`}>{to ? <Link to={to} className="underline">{title}</Link> : title}</h3>
      <div className={`mt-1 text-sm ${STRONG}`}>{children}</div>
    </div>
  );
}

// ── P1 overview ─────────────────────────────────────────────────────────

export function OverviewScreen() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let cancelled = false;
    Promise.all([getReadiness(), fetchAllPages(listApprovalsInbox), fetchAllPages(listCoverage), getProviderHealth()])
      .then(([readiness, inbox, coverage, health]) => { if (!cancelled) setData({ readiness, inbox, coverage, health }); })
      .catch((err) => { if (!cancelled) setError(err?.message || "Couldn't load the overview."); });
    return () => { cancelled = true; };
  }, []);
  const byState = (data?.coverage || []).reduce((acc, c) => ({ ...acc, [c.state]: (acc[c.state] || 0) + 1 }), {});
  const r = data?.readiness;
  const unhealthy = (data?.health?.providers || []).filter((p) => p.circuit !== "CLOSED");
  return (
    <section className={`${PANEL} space-y-4`} aria-labelledby="p1-title">
      <div>
        <h2 id="p1-title" className={`text-lg font-bold ${STRONG}`}>Overview</h2>
        <p className={`text-sm ${MUTED}`}>Where the platform tax registry stands. Read-only.</p>
      </div>
      <InlineError message={error} />
      {data && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Card title="Two-person publishing">
            <span className="flex flex-wrap items-center gap-2">
              <TaxStatusBadge status={r.ready ? "HEALTHY" : "UNHEALTHY"} />
              {r.ready ? "Ready" : "Not ready"}
            </span>
            <p className={`text-xs ${MUTED}`}>
              {r.active_reviewers} reviewer(s), {r.active_publishers} publisher(s), {r.publishers_with_mfa} publisher(s) with MFA
              {r.step_up_required ? "; MFA step-up required" : "; step-up is OFF"}
            </p>
          </Card>
          <Card title="Waiting for approval" to="/super-admin/tax/inbox">
            {data.inbox.length} item(s)
            {data.inbox.length ? (
              <p className={`text-xs ${MUTED}`}>
                {Object.entries(data.inbox.reduce((a, i) => ({ ...a, [i.kind]: (a[i.kind] || 0) + 1 }), {}))
                  .map(([k, n]) => `${humanize(k)}: ${n}`).join(" · ")}
              </p>
            ) : null}
          </Card>
          <Card title="Published coverage">
            {["SUPPORTED", "LIMITED", "UNSUPPORTED"].map((s) => `${humanize(s)}: ${byState[s] || 0}`).join(" · ")}
            <p className={`text-xs ${MUTED}`}>Market cells by published availability (what Sales and tenants see).</p>
          </Card>
          <Card title="Providers" to="/super-admin/tax/providers">
            {unhealthy.length ? `${unhealthy.length} not normal: ${unhealthy.map((p) => `${p.provider} (${humanize(p.circuit)})`).join(", ")}`
              : `${data.health.providers?.length || 0} provider(s), all normal`}
          </Card>
        </div>
      )}
    </section>
  );
}

// ── P4 jurisdictions and rates explorer ─────────────────────────────────

export function ExplorerScreen() {
  const list = useCursorList(({ cursor }) => listJurisdictions({ cursor }), []);
  return (
    <section className={`${PANEL} space-y-5`} aria-labelledby="p4-title">
      <div>
        <h2 id="p4-title" className={`text-lg font-bold ${STRONG}`}>Jurisdictions and rates</h2>
        <p className={`text-sm ${MUTED}`}>Published registry data, read-only. Draft and staged rates are under Rates &amp; change review.</p>
      </div>
      <RateLookup listJurisdictions={listJurisdictions} lookupRates={lookupReferenceRates} idPrefix="p4" />
      <InlineError message={list.error} />
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <caption className={`mb-2 text-left text-sm font-bold ${STRONG}`}>Jurisdictions</caption>
          <thead>
            <tr className={`border-b border-slate-200 text-xs uppercase dark:border-slate-700 ${MUTED}`}>
              {["Code", "Name", "Level", "Reference status", "Published rate versions", "Last published"].map((h) => (
                <th key={h} scope="col" className="px-2 py-2 font-semibold">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.items.map((j) => (
              <tr key={j.id} className="border-b border-slate-100 dark:border-slate-800">
                <td className={`px-2 py-2 font-semibold ${STRONG}`}>{j.code}</td>
                <td className={`px-2 py-2 ${STRONG}`}>{j.name}</td>
                <td className={`px-2 py-2 ${STRONG}`}>{humanize(j.level)}</td>
                <td className={`px-2 py-2 ${STRONG}`}>
                  {humanize(j.reference_status)}
                  {j.billing_clearance && <span className={`block text-xs ${MUTED}`}>{j.billing_clearance}</span>}
                </td>
                <td className={`px-2 py-2 ${STRONG}`}>{j.published_rate_versions}</td>
                <td className={`px-2 py-2 ${MUTED}`}>{formatDateTime(j.last_published_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <LoadMore list={list} noun="jurisdictions" />
    </section>
  );
}

// ── P5 tax-code catalogue ───────────────────────────────────────────────

export function TaxCodeCatalogueScreen() {
  const list = useCursorList(({ cursor }) => listTaxCodeSets({ cursor }), []);
  return (
    <section className={`${PANEL} space-y-4`} aria-labelledby="p5-title">
      <div>
        <h2 id="p5-title" className={`text-lg font-bold ${STRONG}`}>Tax-code catalogue</h2>
        <p className={`text-sm ${MUTED}`}>
          Tax-code set versions and their codes, read-only. Approving and publishing a set happens in the{" "}
          <Link to="/super-admin/tax/inbox" className="underline">approvals inbox</Link>.
        </p>
      </div>
      <InlineError message={list.error} />
      {!list.loading && !list.items.length && !list.error && <p className={`text-sm ${MUTED}`}>No tax-code sets yet.</p>}
      <ul className="space-y-3">
        {list.items.map((set) => (
          <li key={set.id} className="rounded-xl border border-slate-200 p-3 dark:border-slate-700">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className={`text-sm font-semibold ${STRONG}`}>{set.code} v{set.version}</span>
              <TaxStatusBadge status={set.status} />
            </div>
            <p className={`text-xs ${MUTED}`}>
              {set.codes.length} code(s){set.published_at ? ` · published ${formatDateTime(set.published_at)}` : ""}
              {set.superseded_at ? ` · superseded ${formatDateTime(set.superseded_at)}` : ""}
            </p>
            {set.codes.length > 0 && (
              <div className="mt-2 overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <caption className="sr-only">Codes in {set.code} v{set.version}</caption>
                  <thead>
                    <tr className={`border-b border-slate-200 text-xs uppercase dark:border-slate-700 ${MUTED}`}>
                      {["Code", "Name", "Supply category", "Registry scope", "Parent"].map((h) => (
                        <th key={h} scope="col" className="px-2 py-1 font-semibold">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {set.codes.map((c) => (
                      <tr key={c.id} className="border-b border-slate-100 dark:border-slate-800">
                        <td className={`px-2 py-1 font-semibold ${STRONG}`}>{c.code}</td>
                        <td className={`px-2 py-1 ${STRONG}`}>{c.name}</td>
                        <td className={`px-2 py-1 ${STRONG}`}>{humanize(c.supply_category)}</td>
                        <td className={`px-2 py-1 ${STRONG}`}>{c.registry_product_scope || "—"}</td>
                        <td className={`px-2 py-1 ${MUTED}`}>{c.parent_code || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="mt-2">
              <EvidenceExport noun="tax-code set" filename={`tax-evidence-tax_code_set-${set.id}`}
                              fetchBundle={(format) => getEvidenceBundle("tax_code_set", set.id, format)} />
            </div>
          </li>
        ))}
      </ul>
      <LoadMore list={list} noun="sets" />
    </section>
  );
}
