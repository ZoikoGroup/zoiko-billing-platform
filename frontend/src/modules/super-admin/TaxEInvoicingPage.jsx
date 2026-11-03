import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Landmark, SearchX } from "lucide-react";
import { getTaxSummary } from "../../service/commandCenterService";
import { PageHeader, DataTable, SectionCard, Button, FORM_CONTROL_CLASS } from "../../components/billing-ui";
import { ErrorState, Spinner, EmptyState } from "../../components/billing-shared";
import { StaleSectionNote, formatCurrency, sumDecimalStrings } from "./FinancialSummaryCards";
import useLiveRefresh, { LiveRefreshStatus } from "./useLiveRefresh";

// The backend groups Tax rows by the linked INVOICE's currency and falls back
// to "UNKNOWN" for rows with no invoice — credit-note taxes, whose currencies
// are therefore lumped together (financial_operations_detail_service.py
// get_tax_summary). That bucket is labelled as such and never presented as a
// real currency total.
const UNKNOWN = "UNKNOWN";

const TAX_TYPE_LABELS = {
  sales_tax: "Sales tax",
  vat: "VAT",
  gst: "GST",
  service_tax: "Service tax",
  withholding: "Withholding",
  customs: "Customs",
  UNKNOWN: "Not specified",
};

function currencyLabel(currency) {
  return currency === UNKNOWN ? "Not linked to an invoice" : currency;
}

const TAX_COLUMNS = [
  {
    key: "currency",
    label: "Currency",
    render: (r) =>
      r.currency === UNKNOWN ? (
        <span className="text-xs text-amber-700" title="Tax recorded without an invoice (e.g. on a credit note) — its currency is not known and these rows may mix currencies.">
          Not linked to an invoice
        </span>
      ) : (
        <span className="font-semibold text-slate-800">{r.currency}</span>
      ),
  },
  { key: "jurisdiction", label: "Jurisdiction", render: (r) => <span className="text-slate-600">{r.jurisdiction === UNKNOWN ? "Not specified" : r.jurisdiction || "Not specified"}</span> },
  { key: "tax_type", label: "Tax Type", render: (r) => <span className="text-xs text-slate-600">{TAX_TYPE_LABELS[r.tax_type] || String(r.tax_type || "").replaceAll("_", " ") || "Not specified"}</span> },
  { key: "record_count", label: "Records", align: "center", numeric: true, render: (r) => <span className="tabular-nums text-slate-700">{r.record_count}</span> },
  { key: "taxable_amount", label: "Taxable Amount", numeric: true, render: (r) => <span className="tabular-nums text-slate-700">{formatCurrency(r.taxable_amount, r.currency)}</span> },
  { key: "tax_amount", label: "Tax Collected", numeric: true, render: (r) => <span className="font-semibold tabular-nums text-slate-800">{formatCurrency(r.tax_amount, r.currency)}</span> },
];

// Per-currency tax totals. Summed only WITHIN one currency (exact decimal
// arithmetic), never across currencies.
function currencyTotals(buckets) {
  const byCurrency = new Map();
  for (const b of buckets) {
    const list = byCurrency.get(b.currency) || [];
    list.push(b);
    byCurrency.set(b.currency, list);
  }
  return [...byCurrency.entries()].map(([currency, rows]) => ({
    currency,
    records: rows.reduce((n, r) => n + (r.record_count || 0), 0),
    tax: sumDecimalStrings(rows.map((r) => r.tax_amount)),
  }));
}

// `embedded` drops this page's own PageHeader and padding when it is mounted
// as a tab of the Financial Operations hub, whose header already titles it.
export default function TaxEInvoicingPage({ embedded = false, refreshSignal = 0 } = {}) {
  const [summary, setSummary] = useState(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const rangeInvalid = Boolean(dateFrom && dateTo && dateFrom > dateTo);

  // The range the data on screen was fetched for; used to tell "no tax yet"
  // from "nothing in this range".
  const [shownRange, setShownRange] = useState({ from: "", to: "" });
  const rangeRef = useRef({ from: "", to: "" });
  rangeRef.current = { from: dateFrom, to: dateTo };

  const load = useCallback((signal) => {
    const { from, to } = rangeRef.current;
    if (from && to && from > to) return Promise.resolve();
    return getTaxSummary(from, to).then((data) => {
      // useLiveRefresh aborts the previous load when a newer one starts, so a
      // slow response for an old date range can't overwrite the current one.
      if (signal?.aborted) return;
      setSummary(data);
      setShownRange({ from, to });
    });
  }, []);

  const live = useLiveRefresh(load);
  const { refresh } = live;
  useEffect(() => {
    if (refreshSignal) refresh();
  }, [refreshSignal, refresh]);

  // Re-query when the range changes (after the first load).
  const firstRange = useRef(true);
  useEffect(() => {
    if (firstRange.current) {
      firstRange.current = false;
      return;
    }
    if (!rangeInvalid) refresh();
  }, [dateFrom, dateTo, rangeInvalid, refresh]);

  const buckets = useMemo(() => summary?.buckets || [], [summary]);
  const totals = useMemo(() => currencyTotals(buckets), [buckets]);
  const filtered = Boolean(shownRange.from || shownRange.to);

  if (!live.hasLoaded) {
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
          description="Applied-tax amounts recorded per invoice and credit note, grouped by currency, jurisdiction and tax type across every tenant. Figures are per currency and never summed across currencies."
          icon={Landmark}
          meta={summary ? `${summary.total_records} tax record(s)` : null}
          accent="brand"
        />
      )}

      <LiveRefreshStatus
        className={embedded ? "mb-4" : "mt-4"}
        lastUpdated={live.lastUpdated}
        refreshing={live.refreshing}
        refreshError={live.refreshError}
        onRefresh={refresh}
      />

      <div className={`grid grid-cols-1 gap-6 ${embedded ? "" : "mt-4"}`}>
        <SectionCard
          variant="hero"
          accent="brand"
          icon={Landmark}
          title="Tax Collected"
          description="Actual tax amounts recorded on transactions — not configured tax rates."
        >
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="tax-date-from" className="mb-1 block text-xs font-semibold text-slate-600">From</label>
              <input id="tax-date-from" type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} className={FORM_CONTROL_CLASS} />
            </div>
            <div>
              <label htmlFor="tax-date-to" className="mb-1 block text-xs font-semibold text-slate-600">To</label>
              <input id="tax-date-to" type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} className={FORM_CONTROL_CLASS} />
            </div>
            {(dateFrom || dateTo) && (
              <Button variant="secondary" size="sm" onClick={() => { setDateFrom(""); setDateTo(""); }}>
                Clear dates
              </Button>
            )}
          </div>
          {rangeInvalid && (
            <p role="alert" className="mb-3 text-xs text-red-600">The “From” date must be on or before the “To” date.</p>
          )}

          {live.refreshError && !summary ? (
            <ErrorState title="Unable to load tax summary" message={live.refreshError} onRetry={() => refresh()} />
          ) : (
            <>
              {live.refreshError && <StaleSectionNote message={live.refreshError} onRetry={refresh} />}
              {buckets.length === 0 ? (
                filtered ? (
                  <EmptyState
                    icon={SearchX}
                    title="No tax recorded in this date range"
                    message="Try a wider range, or clear the dates to see every tax record."
                    actionLabel="Clear dates"
                    onAction={() => { setDateFrom(""); setDateTo(""); }}
                  />
                ) : (
                  <EmptyState icon={Landmark} title="No tax records yet" message="Tax calculated on invoices or credit notes will appear here." />
                )
              ) : (
                <>
                  <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Tax collected per currency">
                    {totals.map((t) => (
                      <div key={t.currency} className={`min-w-0 rounded-2xl border p-4 ${t.currency === UNKNOWN ? "border-amber-100 bg-amber-50" : "border-slate-100 bg-slate-50"}`}>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-600">{currencyLabel(t.currency)}</p>
                        <p className="mt-1 break-words text-xl font-extrabold tabular-nums text-slate-900">
                          {t.currency === UNKNOWN ? "Currency unknown" : formatCurrency(t.tax, t.currency)}
                        </p>
                        <p className="text-[11px] text-slate-500">{t.records} record{t.records === 1 ? "" : "s"}</p>
                      </div>
                    ))}
                  </div>
                  <DataTable columns={TAX_COLUMNS} data={buckets} rowKey={(r) => `${r.currency}-${r.jurisdiction}-${r.tax_type}`} minWidth={800} />
                </>
              )}
            </>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
