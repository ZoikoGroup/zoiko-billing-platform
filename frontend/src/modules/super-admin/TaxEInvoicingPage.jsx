import React, { useCallback, useEffect, useState } from "react";
import { Landmark, FileWarning } from "lucide-react";
import { getTaxSummary } from "../../service/commandCenterService";
import { PageHeader, DataTable } from "../../components/billing-ui";
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
  { key: "record_count", label: "Records", align: "center", render: (r) => <span className="text-slate-700">{r.record_count}</span> },
  { key: "taxable_amount", label: "Taxable Amount", render: (r) => <span className="text-slate-700">{money(r.taxable_amount)}</span> },
  { key: "tax_amount", label: "Tax Collected", render: (r) => <span className="font-semibold text-slate-800">{money(r.tax_amount)}</span> },
];

export default function TaxEInvoicingPage() {
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
      <div className="p-4 sm:p-6 lg:p-8">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Tax & E-Invoicing"
        description="Real applied-tax amounts recorded per invoice/credit note, grouped by currency, jurisdiction, and tax type across every tenant. Figures are per-currency and never summed across currencies."
        icon={Landmark}
        meta={summary ? `${summary.total_records} tax record(s)` : null}
      />

      <div className="mt-6 grid grid-cols-1 gap-6">
        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-[0_4px_20px_rgba(0,0,0,0.02)]">
          <h3 className="text-sm font-bold uppercase tracking-wider text-slate-800">Tax Collected</h3>
          <p className="mt-1 text-xs text-slate-500">From the `taxes` table — real per-transaction tax amounts, not configuration rates.</p>
          <div className="mt-4">
            {error ? (
              <ErrorState title="Unable to load tax summary" message={error} onRetry={load} />
            ) : (summary?.buckets || []).length === 0 ? (
              <EmptyState icon={Landmark} title="No tax records yet" message="Tax calculated on invoices or credit notes will appear here." />
            ) : (
              <DataTable columns={TAX_COLUMNS} data={summary.buckets} rowKey={(r) => `${r.currency}-${r.jurisdiction}-${r.tax_type}`} minWidth={800} />
            )}
          </div>
        </div>

        <div className="rounded-3xl border border-dashed border-slate-200 bg-slate-50 p-6">
          <div className="flex items-start gap-3">
            <FileWarning size={18} className="mt-0.5 shrink-0 text-slate-400" />
            <div className="text-xs text-slate-600">
              <p className="font-bold text-slate-700">E-Invoicing Compliance — Not integrated</p>
              <p className="mt-1">
                This codebase has no e-invoicing network integration — no Peppol, KSeF, Factur-X, or ZATCA
                transmission, and no VIES VAT-ID validation. GSTIN/VAT numbers are stored and printed on PDFs
                as plain tax-ID fields only, not validated against any government registry or transmitted to
                any tax authority portal. Building this requires a new integration project, not a UI change.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
