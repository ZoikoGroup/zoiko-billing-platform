import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { RefreshCw, ShieldAlert } from "lucide-react";
import { Button, PageHeader } from "../../../components/billing-ui";
import { governedTaxApi } from "../../../service/billingService";
import { formatDisplayDate } from "../../../utils/billing-helpers";
import { OWNER_LABELS, TaxStatusBadge } from "./governed-tax-status";

// Taxes -> Exceptions (ZB-TAX-ARCH-001 §11): every governed draft invoice that
// cannot be issued, with the specific reason, the missing facts, who resolves
// it and a re-quote control. The server decides all of it; re-quoting asks
// for a fresh governed quote and reloads the list.
export default function TaxExceptionsPage() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setError(null);
      const data = await governedTaxApi.exceptions();
      setItems(data?.items || []);
    } catch (err) {
      setError(err?.message || "Could not load tax exceptions.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const requote = async (item) => {
    setBusy(item.invoice_id);
    setNotice(null);
    try {
      const quote = await governedTaxApi.requestQuote(item.invoice_id);
      setNotice(`${item.invoice_number}: new tax quote is ${String(quote?.status || "").toLowerCase().replace(/_/g, " ")}.`);
      await load();
    } catch (err) {
      setError(err?.message || "The tax quote request failed.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Tax exceptions"
        description="Governed draft invoices that cannot be issued yet, why, and who resolves it."
        icon={ShieldAlert}
        actions={<Button variant="secondary" icon={RefreshCw} onClick={load} loading={loading}>Refresh</Button>}
      />
      <p role="status" aria-live="polite" className="sr-only">{notice || ""}</p>
      {notice && <p className="text-sm text-slate-700">{notice}</p>}
      {error && <p role="alert" className="text-sm text-red-800">{error}</p>}

      {!loading && !error && items.length === 0 && (
        <p className="rounded-3xl border border-slate-200 bg-white p-6 text-sm text-slate-600">
          No governed draft invoices are blocked.
        </p>
      )}

      {items.length > 0 && (
        <div className="overflow-x-auto rounded-3xl border border-slate-200 bg-white">
          <table className="min-w-full text-sm">
            <caption className="sr-only">Blocked governed draft invoices</caption>
            <thead>
              <tr className="text-left text-xs text-slate-500">
                <th scope="col" className="px-4 py-2 font-medium">Invoice</th>
                <th scope="col" className="px-4 py-2 font-medium">Status</th>
                <th scope="col" className="px-4 py-2 font-medium">Reason</th>
                <th scope="col" className="px-4 py-2 font-medium">Who resolves it</th>
                <th scope="col" className="px-4 py-2 font-medium"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.invoice_id} className="border-t border-slate-100 align-top">
                  <td className="px-4 py-3">
                    <Link to={`/billing/invoices/${item.invoice_id}`} className="font-medium text-brand underline-offset-2 hover:underline">
                      {item.invoice_number}
                    </Link>
                    {item.tax_date && <span className="block text-xs text-slate-500">Tax date {formatDisplayDate(item.tax_date)}</span>}
                  </td>
                  <td className="px-4 py-3"><TaxStatusBadge status={item.freshness} /></td>
                  <td className="px-4 py-3">
                    <span>{item.reason}</span>
                    {item.missing?.length > 0 && (
                      <ul className="mt-1 list-disc pl-5 text-xs text-slate-600">
                        {item.missing.map((m, i) => (
                          <li key={`${m.code}-${i}`}>{m.message || m.code} ({OWNER_LABELS[m.owner] || m.owner})</li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-medium">{OWNER_LABELS[item.owner] || item.owner}</span>
                    <span className="block text-xs text-slate-600">{item.resolution}</span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button variant="secondary" size="sm" icon={RefreshCw} loading={busy === item.invoice_id}
                      aria-label={`Re-quote ${item.invoice_number}`} onClick={() => requote(item)}>
                      Re-quote
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
