import { useEffect, useState } from "react";
import { Download, Lock } from "lucide-react";

import { Button } from "../../components/billing-ui";
import { InlineError, MUTED, PANEL, STRONG, humanize, saveFile } from "../tax-control-center/shared";
import { SectionTitle } from "./common";
import { getDuplicateRowsReport, getOvercollectionReport } from "./governanceService";

/* T10 Reports (Phase 5c): this organization's legacy findings, with invoice
 * detail and CSV export. Org admins and finance approvers only (the backend
 * refuses everyone else); nothing here changes an invoice. */

export const canReadTaxReports = (role) => role === "org_admin" || role === "finance_approver";

function CsvButton({ label, fetchCsv, filename }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      saveFile(filename, String((await fetchCsv()) ?? ""), "text/csv");
    } catch (err) {
      setError(err?.message || "The export failed.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <Button size="sm" icon={Download} loading={busy} onClick={run}>{label}</Button>
      <InlineError message={error} />
    </div>
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
  const [over, setOver] = useState(null);
  const [dups, setDups] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!allowed) return undefined;
    let cancelled = false;
    Promise.all([getOvercollectionReport(), getDuplicateRowsReport()])
      .then(([o, d]) => { if (!cancelled) { setOver(o); setDups(d); } })
      .catch((err) => { if (!cancelled) setError(err?.message || "Couldn't load the reports."); });
    return () => { cancelled = true; };
  }, [allowed]);

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

  return (
    <section className={`${PANEL} space-y-6`} aria-labelledby="t10-title">
      <SectionTitle id="t10-title" title="Reports">
        Findings on invoices issued under legacy manual tax. Read-only: no invoice is changed.
      </SectionTitle>
      <InlineError message={error} />

      <div className="space-y-3" aria-labelledby="t10-over">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="t10-over" className={`text-sm font-bold ${STRONG}`}>Legacy over-collection (discount after tax)</h3>
          {over && <CsvButton label="Export CSV" filename="tax-legacy-discount-overcollection.csv"
                              fetchCsv={() => getOvercollectionReport("csv")} />}
        </div>
        {over && (
          <>
            <p className={`text-xs ${MUTED}`}>{over.method}</p>
            <Table caption="Over-collection totals by currency" empty="No affected invoices."
                   columns={[["currency", "Currency"], ["invoice_count", "Invoices"], ["tax_amount", "Tax charged"],
                             ["estimated_overcollected_tax", "Estimated over-collected"]]}
                   rows={over.totals_by_currency || []} />
            <Table caption="Invoices with estimated over-collection" empty="No affected invoices."
                   columns={[["invoice_number", "Invoice"], ["issue_date", "Issued"], ["status", "Status", humanize],
                             ["currency", "Currency"],
                             ["document_discount", "Document discount", (v, r) => (r.discount_percentage > 0 ? `${v} (${r.discount_percentage}%)` : `${v} (fixed)`)],
                             ["tax_amount", "Tax charged"], ["estimated_overcollected_tax", "Estimated over-collected"]]}
                   rows={over.invoices || []} />
          </>
        )}
      </div>

      <div className="space-y-3" aria-labelledby="t10-dups">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="t10-dups" className={`text-sm font-bold ${STRONG}`}>Duplicate tax rows</h3>
          {dups && <CsvButton label="Export CSV" filename="tax-duplicate-tax-rows.csv"
                              fetchCsv={() => getDuplicateRowsReport("csv")} />}
        </div>
        {dups && (
          <>
            <p className={`text-sm ${STRONG}`}>{dups.duplicate_rows} duplicate row(s). {dups.note}</p>
            <Table caption="Invoices with duplicate tax rows" empty="No duplicate rows."
                   columns={[["invoice_number", "Invoice"], ["duplicate_rows", "Duplicate rows"]]}
                   rows={dups.invoices || []} />
          </>
        )}
      </div>
    </section>
  );
}
