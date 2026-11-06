import { useId, useState } from "react";
import { Search } from "lucide-react";

import { Button, Field, FORM_CONTROL_CLASS, Select } from "../../components/billing-ui";
import { InlineError, MUTED, STRONG, TaxStatusBadge, humanize, useReferenceList } from "./shared";

/* Published reference rates for one jurisdiction on a date (Phase 5c PR 3):
 * T9 for tenants and the P4 explorer for tax staff. Read-only. A
 * jurisdiction with no approved rate says so: never an implied 0%. */

export function RateLookup({ listJurisdictions, lookupRates, idPrefix = "rates" }) {
  const base = useId();
  const jurisdictions = useReferenceList(listJurisdictions, true);
  const [jurisdictionId, setJurisdictionId] = useState("");
  const [asOf, setAsOf] = useState("");
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async (e) => {
    e.preventDefault();
    if (!jurisdictionId) { setError("Choose a jurisdiction."); return; }
    setBusy(true);
    setError(null);
    try {
      setResult(await lookupRates({ jurisdiction_id: Number(jurisdictionId), as_of: asOf || undefined }));
    } catch (err) {
      setError(err?.message || "Couldn't look up rates.");
    } finally {
      setBusy(false);
    }
  };
  const approved = result?.coverage === "APPROVED_REFERENCE_RATES" && result.items?.length;
  return (
    <div className="space-y-3">
      <form onSubmit={run} className="flex flex-wrap items-end gap-2" aria-label="Look up reference rates">
        <div className="w-72">
          <Field label="Jurisdiction" htmlFor={`${base}-j`} required>
            <Select id={`${base}-j`} value={jurisdictionId} onChange={setJurisdictionId} placeholder="Choose…"
                    options={jurisdictions.map((j) => ({ value: j.id, label: `${j.code} — ${j.name}` }))} />
          </Field>
        </div>
        <div className="w-48">
          <Field label="On date" htmlFor={`${base}-d`} hint="Leave empty for today">
            <input id={`${base}-d`} type="date" className={FORM_CONTROL_CLASS} value={asOf} onChange={(e) => setAsOf(e.target.value)} />
          </Field>
        </div>
        <Button type="submit" size="sm" icon={Search} loading={busy}>Look up</Button>
      </form>
      <InlineError message={error} />
      {result && (
        <div className="space-y-2" aria-live="polite" id={`${idPrefix}-result`}>
          <p className={`text-sm ${STRONG}`}>
            {result.jurisdiction?.code} — {result.jurisdiction?.name} on {result.as_of}:{" "}
            {approved ? `${result.items.length} approved reference rate(s)` : "no approved rate. This is not 0%: tax is not determined here."}
          </p>
          <p className={`text-xs ${MUTED}`}>{result.disclaimer}</p>
          {approved ? (
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <caption className="sr-only">Reference rates</caption>
                <thead>
                  <tr className={`border-b border-slate-200 text-xs uppercase dark:border-slate-700 ${MUTED}`}>
                    {["Component", "Tax code", "Scope", "Rate", "Valid", "Status", "Source"].map((h) => (
                      <th key={h} scope="col" className="px-2 py-2 font-semibold">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.items.map((r) => (
                    <tr key={r.id} className="border-b border-slate-100 dark:border-slate-800">
                      <td className={`px-2 py-2 ${STRONG}`}>{r.component_code} · {r.tax_type}</td>
                      <td className={`px-2 py-2 ${STRONG}`}>{r.tax_code}</td>
                      <td className={`px-2 py-2 ${STRONG}`}>{humanize(r.product_scope)}</td>
                      <td className={`px-2 py-2 font-semibold ${STRONG}`}>{r.rate_percent}%</td>
                      <td className={`px-2 py-2 ${STRONG}`}>{r.valid_from} → {r.valid_to || "open"}</td>
                      <td className="px-2 py-2"><TaxStatusBadge status={r.status} /></td>
                      <td className={`px-2 py-2 ${MUTED}`}>
                        {r.source?.permanent_url
                          ? <a href={r.source.permanent_url} target="_blank" rel="noreferrer" className="text-brand-700 underline dark:text-brand-300">{r.source.title}</a>
                          : r.source?.title}
                        {r.source?.citation ? ` (${r.source.citation})` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
