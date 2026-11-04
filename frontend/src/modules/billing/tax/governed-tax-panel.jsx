import { useCallback, useEffect, useState } from "react";
import { RefreshCw, ShieldAlert } from "lucide-react";
import { Button } from "../../../components/billing-ui";
import { governedTaxApi } from "../../../service/billingService";
import { formatDisplayCurrency, formatDisplayDate } from "../../../utils/billing-helpers";
import { OWNER_LABELS, TaxStatusBadge } from "./governed-tax-status";

const titleize = (value) => String(value || "").replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

// Governed tax for one invoice (ZB-TAX-ARCH-001 §11, invoice editor/approval):
// net, tax per component, gross, tax date, legal treatment, engine and source
// labels, quote freshness and the reasons issuing is blocked. It shows only
// what the server decided; nothing here computes tax. Renders nothing for
// invoices of a LEGACY_MANUAL seller entity.
export default function GovernedTaxPanel({ invoiceId, currency, onQuoted }) {
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState(null);
  const [quoting, setQuoting] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      setSummary(await governedTaxApi.invoiceSummary(invoiceId));
    } catch (err) {
      setError(err?.message || "Could not load the governed tax summary.");
    }
  }, [invoiceId]);

  useEffect(() => { load(); }, [load]);

  const requote = async () => {
    setQuoting(true);
    try {
      await governedTaxApi.requestQuote(invoiceId);
      await load();
      onQuoted?.();
    } catch (err) {
      setError(err?.message || "The tax quote request failed.");
    } finally {
      setQuoting(false);
    }
  };

  if (error && !summary) {
    return (
      <section aria-label="Governed tax" className="bg-white rounded-3xl border border-slate-200 p-6">
        <p role="alert" className="text-sm text-red-800">{error}</p>
      </section>
    );
  }
  if (!summary || !summary.governed) return null;

  const status = summary.freshness?.status || "NONE";
  const cur = summary.currency || currency;
  const totals = summary.totals;
  const blocking = summary.blocking_reasons || [];
  const warnings = summary.warnings || [];
  const canRequote = summary.status === "DRAFT" && status !== "FRESH";

  return (
    <section aria-labelledby="governed-tax-heading" className="bg-white rounded-3xl border border-slate-200 p-6 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h4 id="governed-tax-heading" className="text-sm font-semibold text-slate-900">Governed tax</h4>
          <div className="flex flex-wrap items-center gap-2">
            <TaxStatusBadge status={status} />
            {summary.engine_label && <span className="text-xs text-slate-600">{summary.engine_label}</span>}
          </div>
        </div>
        {canRequote && (
          <Button variant="secondary" size="sm" icon={RefreshCw} loading={quoting} onClick={requote}>
            {status === "NONE" ? "Request tax quote" : "Re-quote"}
          </Button>
        )}
      </div>

      {error && <p role="alert" className="text-sm text-red-800">{error}</p>}

      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <div>
          <dt className="text-xs text-slate-500">Tax date</dt>
          <dd className="font-medium text-slate-900">{summary.tax_date ? formatDisplayDate(summary.tax_date) : "Not set"}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Net</dt>
          <dd className="font-medium text-slate-900">
            {totals ? formatDisplayCurrency(Number(totals.subtotal) - Number(totals.discount_amount || 0), "—", cur) : "—"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Tax</dt>
          <dd className="font-medium text-slate-900">
            {totals ? formatDisplayCurrency(totals.tax_amount, "—", cur) : "Not determined"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Gross</dt>
          <dd className="font-medium text-slate-900">{totals ? formatDisplayCurrency(totals.total_amount, "—", cur) : "—"}</dd>
        </div>
      </dl>

      {summary.lines?.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <caption className="sr-only">Tax by line and component</caption>
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th scope="col" className="py-1 pr-3 font-medium">Line</th>
                <th scope="col" className="py-1 pr-3 font-medium">Legal treatment</th>
                <th scope="col" className="py-1 pr-3 font-medium">Component</th>
                <th scope="col" className="py-1 pr-3 font-medium">Rate</th>
                <th scope="col" className="py-1 pr-3 font-medium text-right">Tax</th>
                <th scope="col" className="py-1 font-medium">Source</th>
              </tr>
            </thead>
            <tbody>
              {summary.lines.flatMap((line) => (line.components || []).map((comp, i) => (
                <tr key={`${line.line_number}-${comp.component_code}-${i}`} className="border-t border-slate-100 align-top">
                  <td className="py-1.5 pr-3">{line.line_number}</td>
                  <td className="py-1.5 pr-3">
                    <span className="font-medium">{titleize(line.outcome)}</span>
                    {line.legal_reason && <span className="block text-xs text-slate-500">{line.legal_reason}</span>}
                  </td>
                  <td className="py-1.5 pr-3">{comp.label || comp.component_code}</td>
                  <td className="py-1.5 pr-3">{Number(comp.rate_percent)}%</td>
                  <td className="py-1.5 pr-3 text-right">{formatDisplayCurrency(comp.tax_amount, "—", cur)}</td>
                  <td className="py-1.5 text-xs text-slate-600">
                    {comp.source
                      ? `${comp.source.source_ref ? `[${comp.source.source_ref}] ` : ""}${comp.source.source_title || ""} · rate version ${comp.source.rate_version_id}`
                      : titleize(comp.rate_source)}
                  </td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>
      )}

      {blocking.length > 0 && (
        <div role="alert" className="rounded-2xl border border-red-200 bg-red-50 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-red-900">
            <ShieldAlert size={16} aria-hidden="true" /> Issuing is blocked
          </p>
          <ul className="mt-2 space-y-2 text-sm text-red-900">
            {blocking.map((b, i) => (
              <li key={`${b.code}-${i}`}>
                <span>{b.reason}</span>
                <span className="block text-xs">
                  Who resolves it: {OWNER_LABELS[b.owner] || b.owner}. {b.resolution}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {warnings.length > 0 && (
        <details className="text-sm text-slate-700">
          <summary className="cursor-pointer">Context notes ({warnings.length})</summary>
          <ul className="mt-2 list-disc pl-5 space-y-1">
            {warnings.map((w, i) => <li key={`${w.code}-${i}`}>{w.message || w.code}</li>)}
          </ul>
        </details>
      )}
    </section>
  );
}
