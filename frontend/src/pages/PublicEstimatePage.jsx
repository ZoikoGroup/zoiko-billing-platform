import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { publicQuoteApi } from "../service/billingService";
import { formatDisplayCurrency } from "../utils/billing-helpers";

const STATUS_BADGE = {
  sent: { label: "Awaiting Your Decision", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  accepted: { label: "Accepted", cls: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  rejected: { label: "Rejected", cls: "bg-red-50 text-red-700 border-red-200" },
  expired: { label: "Expired", cls: "bg-slate-100 text-slate-600 border-slate-200" },
  cancelled: { label: "Cancelled", cls: "bg-slate-100 text-slate-600 border-slate-200" },
  draft: { label: "Draft", cls: "bg-slate-100 text-slate-600 border-slate-200" },
};

function Spinner() {
  return (
    <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#FF7A00] border-t-transparent" />
  );
}

export default function PublicEstimatePage() {
  const { token } = useParams();
  const [state, setState] = useState({ loading: true, error: "", quote: null });
  const [submitting, setSubmitting] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [result, setResult] = useState(null);

  const loadQuote = useCallback(async () => {
    setState({ loading: true, error: "", quote: null });
    try {
      const quote = await publicQuoteApi.getByToken(token);
      setState({ loading: false, error: "", quote });
    } catch (err) {
      setState({
        loading: false,
        error: err?.message || "This estimate link is invalid or has expired.",
        quote: null,
      });
    }
  }, [token]);

  useEffect(() => {
    loadQuote();
  }, [loadQuote]);

  const quote = state.quote;
  const badge = quote ? STATUS_BADGE[quote.status] || STATUS_BADGE.draft : null;
  const canRespond = quote?.status === "sent";
  const currency = quote?.currency || "USD";

  const items = useMemo(() => {
    return (quote?.items || []).filter((i) => i.description || parseFloat(i.total_amount || 0) !== 0);
  }, [quote]);

  const handleAccept = async () => {
    setSubmitting(true);
    setSubmitError("");
    try {
      await publicQuoteApi.accept(token);
      setResult({ action: "accepted", quoteNumber: quote.quote_number });
      setState((s) => ({ ...s, quote: { ...s.quote, status: "accepted" } }));
    } catch (err) {
      setSubmitError(err?.message || "Something went wrong while accepting. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleReject = async () => {
    const trimmed = reason.trim();
    if (!trimmed) {
      setSubmitError("Please tell us why you are declining this estimate.");
      return;
    }
    setSubmitting(true);
    setSubmitError("");
    try {
      await publicQuoteApi.reject(token, trimmed);
      setResult({ action: "rejected", quoteNumber: quote.quote_number });
      setState((s) => ({ ...s, quote: { ...s.quote, status: "rejected" } }));
    } catch (err) {
      setSubmitError(err?.message || "Something went wrong while declining. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  if (state.loading) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-[#F8F7F4]">
        <Spinner />
        <p className="mt-4 text-sm text-slate-500">Loading estimate…</p>
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F8F7F4] px-4">
        <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-50">
            <svg className="h-6 w-6 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h1 className="mb-2 text-lg font-semibold text-slate-800">Estimate link unavailable</h1>
          <p className="mb-6 text-sm leading-6 text-slate-500">{state.error}</p>
          <p className="text-xs text-slate-400">If you were sent this link, please ask the sender to re-issue it.</p>
        </div>
      </div>
    );
  }

  if (result) {
    const accepted = result.action === "accepted";
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F8F7F4] px-4">
        <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm">
          <div
            className={`mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full ${
              accepted ? "bg-emerald-50" : "bg-red-50"
            }`}
          >
            {accepted ? (
              <svg className="h-7 w-7 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="h-7 w-7 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            )}
          </div>
          <h1 className="mb-2 text-xl font-bold text-slate-800">
            Estimate {result.quoteNumber} {accepted ? "accepted" : "declined"}
          </h1>
          <p className="text-sm leading-6 text-slate-500">
            {accepted
              ? "Thank you. We have been notified and will be in touch with next steps."
              : "Thank you. We have been notified of your decision."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#F8F7F4] px-4 py-10">
      <div className="mx-auto max-w-3xl">
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          {/* Header */}
          <div className="flex items-center justify-between gap-4 border-b border-slate-100 bg-gradient-to-r from-[#FF7A00] to-[#FF9A3D] px-6 py-5 sm:px-8">
            <div className="flex items-center gap-3">
              {quote.company.logo_url ? (
                <img
                  src={quote.company.logo_url}
                  alt={quote.company.name}
                  className="h-9 w-9 rounded-lg bg-white/90 object-contain p-1"
                />
              ) : (
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/90 text-sm font-bold text-[#FF7A00]">
                  {(quote.company.name || "Z").charAt(0).toUpperCase()}
                </div>
              )}
              <div>
                <p className="text-sm font-bold text-white">{quote.company.name}</p>
                <p className="text-[11px] text-white/80">via Zoiko Billing</p>
              </div>
            </div>
            {badge && (
              <span className={`rounded-full border px-3 py-1 text-[11px] font-semibold ${badge.cls}`}>
                {badge.label}
              </span>
            )}
          </div>

          <div className="px-6 py-6 sm:px-8">
            {/* Title */}
            <h1 className="text-xl font-bold text-slate-800">Estimate {quote.quote_number}</h1>
            {quote.subject && <p className="mt-1 text-sm text-slate-500">{quote.subject}</p>}

            {/* Meta grid */}
            <div className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Issued</p>
                <p className="mt-1 text-sm font-medium text-slate-700">{quote.issue_date || "—"}</p>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Valid Until</p>
                <p className="mt-1 text-sm font-medium text-slate-700">{quote.valid_until || "—"}</p>
              </div>
              <div className="col-span-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Prepared For</p>
                <p className="mt-1 text-sm font-medium text-slate-700">{quote.customer.name || "—"}</p>
                {quote.customer.email && <p className="text-xs text-slate-400">{quote.customer.email}</p>}
              </div>
            </div>

            {/* Items table */}
            <div className="mt-6 overflow-hidden rounded-xl border border-slate-200">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-3 font-semibold">Item</th>
                    <th className="hidden px-4 py-3 text-right font-semibold sm:table-cell">Qty</th>
                    <th className="hidden px-4 py-3 text-right font-semibold sm:table-cell">Unit Price</th>
                    <th className="px-4 py-3 text-right font-semibold">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, idx) => (
                    <tr key={`${item.line_number || idx}`} className="border-b border-slate-100 last:border-b-0">
                      <td className="px-4 py-3 text-slate-700">{item.description || "Item"}</td>
                      <td className="hidden px-4 py-3 text-right text-slate-600 sm:table-cell">{item.quantity}</td>
                      <td className="hidden px-4 py-3 text-right text-slate-600 sm:table-cell">
                        {formatDisplayCurrency(item.unit_price, currency)}
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-slate-800">
                        {formatDisplayCurrency(item.total_amount, currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Totals */}
            <div className="mt-4 flex flex-col items-end gap-1 text-sm">
              <div className="flex w-full max-w-[260px] justify-between text-slate-500">
                <span>Subtotal</span>
                <span>{formatDisplayCurrency(quote.subtotal, currency)}</span>
              </div>
              {parseFloat(quote.discount_amount || 0) !== 0 && (
                <div className="flex w-full max-w-[260px] justify-between text-slate-500">
                  <span>Discount{quote.discount_percentage ? ` (${quote.discount_percentage}%)` : ""}</span>
                  <span>- {formatDisplayCurrency(quote.discount_amount, currency)}</span>
                </div>
              )}
              {parseFloat(quote.tax_amount || 0) !== 0 && (
                <div className="flex w-full max-w-[260px] justify-between text-slate-500">
                  <span>Tax</span>
                  <span>{formatDisplayCurrency(quote.tax_amount, currency)}</span>
                </div>
              )}
              <div className="mt-1 flex w-full max-w-[260px] justify-between border-t border-slate-200 pt-2 text-base font-bold text-slate-800">
                <span>Total</span>
                <span>{formatDisplayCurrency(quote.total_amount, currency)}</span>
              </div>
            </div>

            {/* Notes / terms */}
            {quote.notes && (
              <div className="mt-6 rounded-xl bg-slate-50 p-4">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Notes</p>
                <p className="mt-1 text-sm leading-6 text-slate-600 whitespace-pre-wrap">{quote.notes}</p>
              </div>
            )}
            {quote.terms && (
              <div className="mt-3 rounded-xl bg-slate-50 p-4">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Terms</p>
                <p className="mt-1 text-sm leading-6 text-slate-600 whitespace-pre-wrap">{quote.terms}</p>
              </div>
            )}
            {quote.status === "rejected" && quote.rejected_reason && (
              <div className="mt-3 rounded-xl border border-red-100 bg-red-50 p-4">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-red-400">Reason for declining</p>
                <p className="mt-1 text-sm leading-6 text-red-700 whitespace-pre-wrap">{quote.rejected_reason}</p>
              </div>
            )}
            {quote.status === "accepted" && quote.accepted_at && (
              <div className="mt-3 rounded-xl border border-emerald-100 bg-emerald-50 p-4">
                <p className="text-sm leading-6 text-emerald-700">Accepted on {quote.accepted_at}.</p>
              </div>
            )}

            {/* Decision area */}
            {canRespond && (
              <div className="mt-8 border-t border-slate-100 pt-6">
                {!rejectOpen ? (
                  <>
                    <p className="mb-4 text-sm text-slate-500">
                      Ready to move forward? Accept this estimate and we will get the next steps underway.
                    </p>
                    {submitError && (
                      <p className="mb-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-600">{submitError}</p>
                    )}
                    <div className="flex flex-col gap-3 sm:flex-row">
                      <button
                        type="button"
                        disabled={submitting}
                        onClick={handleAccept}
                        className="inline-flex items-center justify-center rounded-xl bg-emerald-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:opacity-60"
                      >
                        {submitting ? <Spinner /> : "Accept Estimate"}
                      </button>
                      <button
                        type="button"
                        disabled={submitting}
                        onClick={() => setRejectOpen(true)}
                        className="inline-flex items-center justify-center rounded-xl border border-slate-300 bg-white px-6 py-3 text-sm font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-60"
                      >
                        Decline
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <label htmlFor="reject-reason" className="mb-2 block text-sm font-semibold text-slate-700">
                      Let us know why you are declining (optional but helpful)
                    </label>
                    <textarea
                      id="reject-reason"
                      rows="3"
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="e.g. Pricing, timeline, or scope does not match our current needs…"
                      className="w-full resize-y rounded-xl border border-slate-300 px-4 py-3 text-sm text-slate-700 outline-none transition focus:border-[#FF7A00] focus:ring-2 focus:ring-[#FF7A00]/20"
                    />
                    {submitError && (
                      <p className="mt-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-600">{submitError}</p>
                    )}
                    <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                      <button
                        type="button"
                        disabled={submitting}
                        onClick={handleReject}
                        className="inline-flex items-center justify-center rounded-xl bg-red-600 px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-red-700 disabled:opacity-60"
                      >
                        {submitting ? <Spinner /> : "Confirm Decline"}
                      </button>
                      <button
                        type="button"
                        disabled={submitting}
                        onClick={() => {
                          setRejectOpen(false);
                          setSubmitError("");
                        }}
                        className="inline-flex items-center justify-center rounded-xl border border-slate-300 bg-white px-6 py-3 text-sm font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-60"
                      >
                        Cancel
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Footer */}
            <p className="mt-8 text-center text-xs leading-5 text-slate-400">
              This estimate is not an invoice and does not represent a completed charge.
              <br />
              Sent by Zoiko Billing on behalf of {quote.company.name}.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
