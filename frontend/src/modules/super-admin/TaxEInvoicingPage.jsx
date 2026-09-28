import React, { useCallback, useEffect, useState } from "react";
import { Landmark } from "lucide-react";
import { getTaxSummary } from "../../service/commandCenterService";
import { PageHeader, DataTable, SectionCard } from "../../components/billing-ui";
import { ErrorState, Spinner, EmptyState } from "../../components/billing-shared";

function money(strAmount) {
  const n = parseFloat(strAmount || "0");
  if (isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

const TAX_COLUMNS = [
  { key: "currency", label: "Currency", render: (r) => <span className="font-semibold text-slate-800">{r.currency}</span> },
  { key: "jurisdiction", label: "Jurisdiction", render: (r) => <span className="text-slate-600">{r.jurisdiction}</span> },
  { key: "tax_type", label: "Tax Type", render: (r) => <span className="text-xs uppercase text-slate-500">{r.tax_type}</span> },
  { key: "record_count", label: "Records", align: "center", numeric: true, render: (r) => <span className="text-slate-700">{r.record_count}</span> },
  { key: "taxable_amount", label: "Taxable Amount", numeric: true, render: (r) => <span className="text-slate-700">{money(r.taxable_amount)}</span> },
  { key: "tax_amount", label: "Tax Collected", numeric: true, render: (r) => <span className="font-semibold text-slate-800">{money(r.tax_amount)}</span> },
];

// `embedded` drops this page's own PageHeader and padding when it is mounted
// as a tab of the Financial Operations hub, whose header already titles it.
export default function TaxEInvoicingPage({ embedded = false } = {}) {
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    getTaxSummary()
      .then(setSummary)
      .catch((e) => setError(e?.message || "Failed to load tax summary."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className={embedded ? "" : "p-4 sm:p-6 lg:p-8"}>
        <Spinner />
      </div>
    );
  }

  return (
    <div className={embedded ? "" : "p-4 sm:p-6 lg:p-8"}>
      {!embedded && (
        <PageHeader
          title="Tax"
          description="Real applied-tax amounts recorded per invoice/credit note, grouped by currency, jurisdiction, and tax type across every tenant. Figures are per-currency and never summed across currencies."
          icon={Landmark}
          meta={summary ? `${summary.total_records} tax record(s)` : null}
          accent="brand"
        />
      )}

      <div className={`grid grid-cols-1 gap-6 ${embedded ? "" : "mt-6"}`}>
        <SectionCard
          variant="hero"
          accent="brand"
          icon={Landmark}
          title="Tax Collected"
          description="From the `taxes` table — real per-transaction tax amounts, not configuration rates."
        >
          {error ? (
            <ErrorState title="Unable to load tax summary" message={error} onRetry={load} />
          ) : (summary?.buckets || []).length === 0 ? (
            <EmptyState icon={Landmark} title="No tax records yet" message="Tax calculated on invoices or credit notes will appear here." />
          ) : (
            <DataTable columns={TAX_COLUMNS} data={summary.buckets} rowKey={(r) => `${r.currency}-${r.jurisdiction}-${r.tax_type}`} minWidth={800} />
          )}
        </SectionCard>
      </div>
    </div>
  );
}
