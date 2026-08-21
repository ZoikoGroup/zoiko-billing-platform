import React, { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { publicInvoiceApi } from "../service/billingService";
import { formatDisplayCurrency, formatDisplayDate } from "../utils/billing-helpers";

/* ─── helpers ─────────────────────────────────────────────────────────────── */
function fmtCcy(v, currency) {
  return formatDisplayCurrency(v, "—", currency);
}
function fmtDate(d) {
  return formatDisplayDate(d);
}
function classNames(...cls) {
  return cls.filter(Boolean).join(" ");
}

/* ─── status colour map ───────────────────────────────────────────────────── */
const STATUS_MAP = {
  draft:          { label: "Draft",           bg: "bg-slate-100",  text: "text-slate-600",  dot: "bg-slate-400"  },
  sent:           { label: "Sent",             bg: "bg-blue-100",   text: "text-blue-700",   dot: "bg-blue-500"   },
  paid:           { label: "Paid",             bg: "bg-emerald-100",text: "text-emerald-700",dot: "bg-emerald-500"},
  overdue:        { label: "Overdue",          bg: "bg-red-100",    text: "text-red-700",    dot: "bg-red-500"    },
  partially_paid: { label: "Partially Paid",   bg: "bg-amber-100",  text: "text-amber-700",  dot: "bg-amber-500"  },
  cancelled:      { label: "Cancelled",        bg: "bg-slate-100",  text: "text-slate-500",  dot: "bg-slate-300"  },
  refunded:       { label: "Refunded",         bg: "bg-pink-100",   text: "text-pink-700",   dot: "bg-pink-500"   },
  written_off:    { label: "Written Off",      bg: "bg-slate-100",  text: "text-slate-500",  dot: "bg-slate-300"  },
};

/* ─── sub-components ─────────────────────────────────────────────────────── */

function Spinner() {
  return (
    <div className="pub-spinner-wrap">
      <div className="pub-spinner" />
    </div>
  );
}

function StatusBadge({ status }) {
  const s = (status || "").toLowerCase();
  const cfg = STATUS_MAP[s] || { label: s || "Unknown", bg: "bg-gray-100", text: "text-gray-600", dot: "bg-gray-400" };
  return (
    <span className={`pub-badge ${cfg.bg} ${cfg.text}`}>
      <span className={`pub-badge-dot ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}

function SectionCard({ title, icon, children, accent }) {
  return (
    <div className={classNames("pub-card", accent && "pub-card--accent")}>
      {title && (
        <div className="pub-card-header">
          {icon && <span className="pub-card-icon">{icon}</span>}
          <h2 className="pub-card-title">{title}</h2>
        </div>
      )}
      {children}
    </div>
  );
}

function InfoRow({ label, value, mono }) {
  return (
    <div className="pub-info-row">
      <span className="pub-info-label">{label}</span>
      <span className={classNames("pub-info-value", mono && "pub-mono")}>{value || "—"}</span>
    </div>
  );
}

/* Payment method tile — Stripe placeholder */
function PaymentMethodTile({ icon, label, sublabel, disabled, onClick }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={classNames("pub-pay-tile", disabled && "pub-pay-tile--disabled")}
    >
      <span className="pub-pay-tile-icon">{icon}</span>
      <span className="pub-pay-tile-label">{label}</span>
      {sublabel && <span className="pub-pay-tile-sub">{sublabel}</span>}
      {disabled && <span className="pub-pay-tile-soon">Coming soon</span>}
    </button>
  );
}

/* Progress bar for paid vs outstanding */
function PaymentProgress({ paid, total }) {
  const pct = total > 0 ? Math.min(100, (paid / total) * 100) : 0;
  return (
    <div className="pub-progress-wrap">
      <div className="pub-progress-bar">
        <div className="pub-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="pub-progress-labels">
        <span className="pub-progress-paid">{pct.toFixed(0)}% paid</span>
        <span className="pub-progress-remaining">{(100 - pct).toFixed(0)}% remaining</span>
      </div>
    </div>
  );
}

/* ─── main page ──────────────────────────────────────────────────────────── */
export default function PublicInvoicePage() {
  const { id: rawId } = useParams();
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [invoice, setInvoice]   = useState(null);
  const [items, setItems]       = useState([]);
  const [company, setCompany]   = useState(null);
  const [payment, setPayment]   = useState(null);
  const handleCheckout = useCallback(async () => {
    try {
      const successUrl = `${window.location.origin}/invoice/${rawId}?paid=true`;
      const cancelUrl = `${window.location.origin}/invoice/${rawId}`;
      const result = await publicInvoiceApi.createCheckout(rawId, successUrl, cancelUrl);
      if (result?.checkout_url) {
        window.location.href = result.checkout_url;
      } else if (result?.configured === false) {
        alert(result.message || "Online payments are not enabled yet. Please contact the sender.");
      }
    } catch (err) {
      alert(err?.detail || err?.message || "Unable to initiate checkout. Please try again later.");
    }
  }, [rawId]);

  const [payMethod, setPayMethod] = useState(null); // "card" | "bank" | "upi"

  const loadInvoice = useCallback(async () => {
    if (!rawId) {
      setError("Invalid invoice link. Please check the URL and try again.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const token = rawId;
      const data = await publicInvoiceApi.getView(token);
      setInvoice(data);
      setItems(Array.isArray(data.items) ? data.items : []);
      setCompany(data.company || null);
      setPayment(data.payment || null);
    } catch (err) {
      setError(err?.detail || err?.message || "Unable to load invoice. The link may have expired or is invalid.");
    } finally {
      setLoading(false);
    }
  }, [rawId]);

  useEffect(() => { loadInvoice(); }, [loadInvoice]);

  /* derived values — public API returns amounts as formatted strings */
  const parseMoney = (v) => {
    if (v == null) return 0;
    if (typeof v === "number") return v;
    const s = String(v).replace(/,/g, "").trim();
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
  };
  const customer = invoice?.customer || {};
  const currency     = invoice?.currency;
  const status       = (invoice?.status || "").toLowerCase();
  const isPaid       = status === "paid";
  const isCancelled  = ["cancelled", "void", "written_off"].includes(status);
  const invoiceTotal = parseMoney(invoice?.total_amount ?? invoice?.amount ?? 0);
  const balanceDue   = parseMoney(invoice?.balance_due ?? invoice?.amount_due ?? invoiceTotal);
  const paidAmount   = Math.max(0, invoiceTotal - balanceDue);
  const isOverdue    = status === "overdue";
  const canPay       = !isPaid && !isCancelled && balanceDue > 0.005;

  /* ── loading ── */
  if (loading) return (
    <div className="pub-root">
      <Spinner />
    </div>
  );

  /* ── error ── */
  if (error) return (
    <div className="pub-root">
      <div className="pub-error-card">
        <span className="pub-error-icon">⚠️</span>
        <h1 className="pub-error-title">Invoice Unavailable</h1>
        <p className="pub-error-msg">{error}</p>
        <p className="pub-error-help">
          If you believe this is a mistake, please contact the sender directly.
        </p>
      </div>
    </div>
  );

  return (
    <div className="pub-root">
      {/* ─── top strip ─── */}
      <div className="pub-top-strip">
        <div className="pub-brand">
          <span className="pub-brand-icon">⚡</span>
          <span className="pub-brand-name">Zoiko Billing</span>
        </div>
        <div className="pub-top-strip-right">
          <StatusBadge status={invoice.status} />
          {isOverdue && (
            <span className="pub-overdue-chip">⚠ Overdue</span>
          )}
        </div>
      </div>

      <div className="pub-content">

        {/* ─── invoice hero ─── */}
        <div className="pub-hero">
          <div className="pub-hero-left">
            <p className="pub-hero-eyebrow">Tax Invoice</p>
            <h1 className="pub-hero-number">{invoice.invoice_number || "Invoice"}</h1>
            <p className="pub-hero-customer">
              {customer.name || "Customer"}
            </p>
            {customer.email && (
              <p className="pub-hero-email">{customer.email}</p>
            )}
          </div>
          <div className="pub-hero-right">
            <div className="pub-amount-card">
              <p className="pub-amount-label">Amount Due</p>
              <p className={classNames("pub-amount-value", isPaid && "pub-amount-value--paid", isOverdue && "pub-amount-value--overdue")}>
                {fmtCcy(balanceDue, currency)}
              </p>
              <p className="pub-amount-currency">{currency}</p>
              {invoice.due_date && (
                <p className={classNames("pub-amount-due", isOverdue && "pub-amount-due--overdue")}>
                  Due {fmtDate(invoice.due_date)}
                </p>
              )}
            </div>
          </div>
        </div>

        {/* ─── payment progress (if any paid) ─── */}
        {paidAmount > 0 && (
          <SectionCard>
            <div className="pub-progress-section">
              <div className="pub-progress-amounts">
                <div className="pub-progress-amt">
                  <span className="pub-progress-amt-label">Paid</span>
                  <span className="pub-progress-amt-val pub-progress-amt-val--paid">{fmtCcy(paidAmount, currency)}</span>
                </div>
                <div className="pub-progress-amt">
                  <span className="pub-progress-amt-label">Remaining</span>
                  <span className="pub-progress-amt-val">{fmtCcy(balanceDue, currency)}</span>
                </div>
                <div className="pub-progress-amt">
                  <span className="pub-progress-amt-label">Total</span>
                  <span className="pub-progress-amt-val">{fmtCcy(invoiceTotal, currency)}</span>
                </div>
              </div>
              <PaymentProgress paid={paidAmount} total={invoiceTotal} />
            </div>
          </SectionCard>
        )}

        <div className="pub-grid">

          {/* ─── invoice details ─── */}
          <SectionCard title="Invoice Details" icon="📋">
            <div className="pub-details-grid">
              <InfoRow label="Invoice #"       value={invoice.invoice_number || "Invoice"} mono />
              <InfoRow label="Issue Date"      value={fmtDate(invoice.issue_date || invoice.created_at)} />
              <InfoRow label="Due Date"        value={fmtDate(invoice.due_date)} />
              <InfoRow label="Payment Terms"   value={invoice.payment_terms?.replace(/_/g, " ") || "—"} />
              {invoice.po_number && <InfoRow label="PO Number" value={invoice.po_number} mono />}
              <InfoRow label="Currency"        value={currency} />
            </div>
          </SectionCard>

          {/* ─── billing address ─── */}
          <SectionCard title="Billed To" icon="📍">
            <div className="pub-billing-block">
              <p className="pub-billing-name">
                {customer.name || "—"}
              </p>
              {customer.email && (
                <p className="pub-billing-detail">✉ {customer.email}</p>
              )}
              {(customer.phone || customer.mobile) && (
                <p className="pub-billing-detail">📞 {customer.phone || customer.mobile}</p>
              )}
              {customer.billing_address && (
                <p className="pub-billing-addr">{customer.billing_address}</p>
              )}
              {customer.gst_number && (
                <p className="pub-billing-tax">GST: {customer.gst_number}</p>
              )}
              {customer.vat_number && (
                <p className="pub-billing-tax">VAT: {customer.vat_number}</p>
              )}
              {customer.pan && (
                <p className="pub-billing-tax">PAN: {customer.pan}</p>
              )}
            </div>
          </SectionCard>
        </div>

        {/* ─── products & services table ─── */}
        <SectionCard title="Products & Services" icon="📦">
          {items.length === 0 ? (
            <p className="pub-empty-items">No line items found for this invoice.</p>
          ) : (
            <>
              <div className="pub-table-wrap">
                <table className="pub-table">
                  <thead>
                    <tr>
                      <th className="pub-th pub-th--left">#</th>
                      <th className="pub-th pub-th--left">Description</th>
                      <th className="pub-th pub-th--left">Type</th>
                      <th className="pub-th pub-th--right">Qty</th>
                      <th className="pub-th pub-th--right">Unit Price</th>
                      <th className="pub-th pub-th--right">Discount</th>
                      <th className="pub-th pub-th--right">Tax</th>
                      <th className="pub-th pub-th--right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item, i) => {
                      const lineTotal = parseMoney(item.total_amount ?? item.total ?? (parseMoney(item.quantity || 0) * parseMoney(item.unit_price || 0)));
                      const discAmt   = parseMoney(item.unit_price || 0) * parseMoney(item.quantity || 0) * parseMoney(item.discount_percentage || 0) / 100;
                      return (
                        <tr key={item.id || item.line_number || i} className="pub-tr">
                          <td className="pub-td pub-td--muted">{item.line_number || i + 1}</td>
                          <td className="pub-td">
                            <p className="pub-item-name">{item.description || "Item"}</p>
                          </td>
                          <td className="pub-td pub-td--type">
                            <span className="pub-type-badge">{item.item_type || "product"}</span>
                          </td>
                          <td className="pub-td pub-td--right pub-mono">{parseMoney(item.quantity || 0).toFixed(2)}</td>
                          <td className="pub-td pub-td--right pub-mono">{fmtCcy(parseMoney(item.unit_price), currency)}</td>
                          <td className="pub-td pub-td--right">
                            {parseMoney(item.discount_percentage || 0) > 0 ? (
                              <span className="pub-discount">
                                -{parseMoney(item.discount_percentage).toFixed(1)}%
                                <span className="pub-discount-amt">&nbsp;(-{fmtCcy(discAmt, currency)})</span>
                              </span>
                            ) : (
                              <span className="pub-td--muted">—</span>
                            )}
                          </td>
                          <td className="pub-td pub-td--right">
                            {parseMoney(item.tax_percentage || 0) > 0 ? (
                              <span className="pub-tax-pct">{parseMoney(item.tax_percentage).toFixed(1)}%</span>
                            ) : (
                              <span className="pub-td--muted">—</span>
                            )}
                          </td>
                          <td className="pub-td pub-td--right pub-td--bold pub-mono">
                            {fmtCcy(lineTotal, currency)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

            </>
          )}
        </SectionCard>

        {/* ─── financial summary ─── */}
        <SectionCard title="Financial Summary" icon="📊">
          <div className="pub-fin-grid">
            <div className="pub-fin-col">
              <h3 className="pub-fin-col-title">Charges Breakdown</h3>
              <div className="pub-fin-rows">
                <div className="pub-fin-row">
                  <span>Subtotal</span>
                  <span className="pub-mono">{fmtCcy(parseMoney(invoice.subtotal || 0), currency)}</span>
                </div>
                {parseMoney(invoice.discount_percentage || 0) > 0 && (
                  <div className="pub-fin-row pub-fin-row--discount">
                    <span>Discount ({invoice.discount_percentage}%)</span>
                    <span className="pub-mono">-{fmtCcy(parseMoney(invoice.discount_amount || 0), currency)}</span>
                  </div>
                )}
                {parseMoney(invoice.tax_amount || 0) > 0 && (
                  <div className="pub-fin-row">
                    <span>Tax</span>
                    <span className="pub-mono">{fmtCcy(parseMoney(invoice.tax_amount), currency)}</span>
                  </div>
                )}
                {parseMoney(invoice.shipping_amount || 0) > 0 && (
                  <div className="pub-fin-row">
                    <span>Shipping</span>
                    <span className="pub-mono">{fmtCcy(parseMoney(invoice.shipping_amount), currency)}</span>
                  </div>
                )}
                {parseMoney(invoice.round_off || 0) !== 0 && (
                  <div className="pub-fin-row">
                    <span>Round Off</span>
                    <span className="pub-mono">{fmtCcy(parseMoney(invoice.round_off), currency)}</span>
                  </div>
                )}
                <div className="pub-fin-row pub-fin-row--total">
                  <span>Invoice Total</span>
                  <span className="pub-mono">{fmtCcy(invoiceTotal, currency)}</span>
                </div>
              </div>
            </div>

            <div className="pub-fin-col">
              <h3 className="pub-fin-col-title">Payment Status</h3>
              <div className="pub-fin-rows">
                <div className="pub-fin-row">
                  <span>Invoice Total</span>
                  <span className="pub-mono">{fmtCcy(invoiceTotal, currency)}</span>
                </div>
                {paidAmount > 0 && (
                  <div className="pub-fin-row pub-fin-row--paid">
                    <span>Already Paid</span>
                    <span className="pub-mono">-{fmtCcy(paidAmount, currency)}</span>
                  </div>
                )}
                <div className={classNames("pub-fin-row pub-fin-row--due", isOverdue && "pub-fin-row--overdue")}>
                  <span className="pub-fin-row-due-label">Balance Due</span>
                  <span className="pub-mono pub-fin-row-due-val">{fmtCcy(balanceDue, currency)}</span>
                </div>
              </div>

              {invoice.paid_at && (
                <p className="pub-paid-note">✓ Paid on {fmtDate(invoice.paid_at)}</p>
              )}
              {invoice.cancelled_at && (
                <p className="pub-cancelled-note">✕ Cancelled on {fmtDate(invoice.cancelled_at)}</p>
              )}
              {isOverdue && !isPaid && (
                <div className="pub-overdue-banner">
                  <p className="pub-overdue-banner-title">⚠ Payment Overdue</p>
                  <p className="pub-overdue-banner-msg">
                    This invoice was due on {fmtDate(invoice.due_date)}. Please complete payment as soon as possible to avoid further charges.
                  </p>
                </div>
              )}
            </div>
          </div>
        </SectionCard>

        {/* ─── payment section ─── */}
        {canPay && (
          <SectionCard title="Pay This Invoice" icon="💳" accent>
            <div className="pub-pay-section">
              <div className="pub-pay-amount-row">
                <div>
                  <p className="pub-pay-label">Amount to Pay</p>
                  <p className="pub-pay-amount">{fmtCcy(balanceDue, currency)}</p>
                </div>
                <div className="pub-pay-secure">
                  <span className="pub-pay-secure-icon">🔒</span>
                  <span>Secured by Stripe</span>
                </div>
              </div>

              <div className="pub-pay-methods-title">Choose Payment Method</div>
              <div className="pub-pay-tiles">
                <PaymentMethodTile
                  icon="💳"
                  label="Credit / Debit Card"
                  sublabel="Visa, Mastercard, Amex"
                  onClick={() => setPayMethod("card")}
                />
                <PaymentMethodTile
                  icon="🏦"
                  label="Bank Transfer"
                  sublabel="ACH / SEPA / NEFT"
                  disabled
                />
                <PaymentMethodTile
                  icon="📱"
                  label="UPI / Wallets"
                  sublabel="GPay, PhonePe, Paytm"
                  disabled
                />
                <PaymentMethodTile
                  icon="🔗"
                  label="Crypto"
                  sublabel="BTC, ETH, USDC"
                  disabled
                />
              </div>

              {/* Card form placeholder — Stripe Elements will mount here */}
              {payMethod === "card" && (
                <div className="pub-stripe-form">
                  <div className="pub-stripe-header">
                    <span className="pub-stripe-title">Card Details</span>
                    <div className="pub-stripe-brands">
                      <span className="pub-card-chip">VISA</span>
                      <span className="pub-card-chip">MC</span>
                      <span className="pub-card-chip">AMEX</span>
                    </div>
                  </div>

                  {/* Stripe CardElement mounts here */}
                  <div className="pub-stripe-mount-placeholder" id="stripe-card-element">
                    <div className="pub-stripe-mock-field">
                      <label className="pub-stripe-mock-label">Card Number</label>
                      <div className="pub-stripe-mock-input">
                        <span className="pub-stripe-mock-placeholder">•••• •••• •••• ••••</span>
                        <span className="pub-stripe-mock-icon">💳</span>
                      </div>
                    </div>
                    <div className="pub-stripe-mock-row">
                      <div className="pub-stripe-mock-field pub-stripe-mock-field--half">
                        <label className="pub-stripe-mock-label">Expiry Date</label>
                        <div className="pub-stripe-mock-input">
                          <span className="pub-stripe-mock-placeholder">MM / YY</span>
                        </div>
                      </div>
                      <div className="pub-stripe-mock-field pub-stripe-mock-field--half">
                        <label className="pub-stripe-mock-label">CVC</label>
                        <div className="pub-stripe-mock-input">
                          <span className="pub-stripe-mock-placeholder">•••</span>
                        </div>
                      </div>
                    </div>
                    <div className="pub-stripe-mock-field">
                      <label className="pub-stripe-mock-label">Cardholder Name</label>
                      <div className="pub-stripe-mock-input">
                        <span className="pub-stripe-mock-placeholder">Full name on card</span>
                      </div>
                    </div>
                    <div className="pub-stripe-integration-note">
                      <span className="pub-stripe-note-icon">ℹ</span>
                      Stripe payment integration will be connected here. This UI is ready for
                      <code> &lt;CardElement /&gt;</code> from <code>@stripe/react-stripe-js</code>.
                    </div>
                  </div>

                  <button
                    type="button"
                    className="pub-pay-btn"
                    onClick={handleCheckout}
                  >
                    <span className="pub-pay-btn-icon">🔒</span>
                    Pay {fmtCcy(balanceDue, currency)} Securely
                  </button>

                  <p className="pub-pay-terms">
                    By clicking "Pay Securely", you agree to our&nbsp;
                    <span className="pub-pay-link">Terms of Service</span> and&nbsp;
                    <span className="pub-pay-link">Privacy Policy</span>.
                    Your card details are never stored on our servers.
                  </p>
                </div>
              )}

              <div className="pub-pay-footer">
                <div className="pub-pay-badges">
                  <span className="pub-pay-badge">🔐 SSL Encrypted</span>
                  <span className="pub-pay-badge">🛡 PCI Compliant</span>
                  <span className="pub-pay-badge">✅ Stripe Powered</span>
                </div>
              </div>
            </div>
          </SectionCard>
        )}

        {isPaid && (
          <div className="pub-paid-banner">
            <span className="pub-paid-banner-icon">✅</span>
            <div>
              <p className="pub-paid-banner-title">Invoice Fully Paid</p>
              <p className="pub-paid-banner-msg">
                Thank you for your payment of {fmtCcy(invoiceTotal, currency)}.
                {invoice.paid_at && ` Recorded on ${fmtDate(invoice.paid_at)}.`}
              </p>
            </div>
          </div>
        )}

        {/* ─── notes ─── */}
        {invoice.notes && (
          <SectionCard title="Notes" icon="📝">
            <p className="pub-notes">{invoice.notes}</p>
          </SectionCard>
        )}

        {/* ─── footer ─── */}
        <div className="pub-page-footer">
          <p>Generated by <strong>Zoiko Billing Platform</strong></p>
          <p className="pub-footer-inv">Invoice {invoice.invoice_number || "Invoice"} · {currency}</p>
        </div>

      </div>

      {/* ── styles ── */}
      <style>{`
        /* ── root / layout ── */
        .pub-root {
          min-height: 100vh;
          background: linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%);
          font-family: 'Inter', 'Segoe UI', system-ui, sans-serif;
          color: #e2e8f0;
          padding-bottom: 3rem;
        }
        .pub-spinner-wrap {
          min-height: 100vh;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .pub-spinner {
          width: 3rem; height: 3rem;
          border-radius: 50%;
          border: 3px solid rgba(251,191,36,0.2);
          border-top-color: #f59e0b;
          animation: pub-spin 0.8s linear infinite;
        }
        @keyframes pub-spin { to { transform: rotate(360deg); } }

        /* ── top strip ── */
        .pub-top-strip {
          background: rgba(15,23,42,0.95);
          border-bottom: 1px solid rgba(255,255,255,0.06);
          padding: 1rem 2rem;
          display: flex;
          align-items: center;
          justify-content: space-between;
          position: sticky; top: 0; z-index: 50;
          backdrop-filter: blur(12px);
        }
        .pub-brand { display: flex; align-items: center; gap: 0.5rem; font-weight: 700; font-size: 1rem; }
        .pub-brand-icon { font-size: 1.25rem; }
        .pub-brand-name { background: linear-gradient(90deg, #f59e0b, #fb923c); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .pub-top-strip-right { display: flex; align-items: center; gap: 0.75rem; }
        .pub-overdue-chip {
          font-size: 0.7rem; font-weight: 700; padding: 0.2rem 0.6rem;
          background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.4);
          border-radius: 999px; color: #fca5a5; letter-spacing: 0.05em;
          animation: pub-pulse 2s infinite;
        }
        @keyframes pub-pulse { 0%,100%{opacity:1} 50%{opacity:0.6} }

        /* ── status badge ── */
        .pub-badge {
          display: inline-flex; align-items: center; gap: 0.35rem;
          font-size: 0.7rem; font-weight: 600; letter-spacing: 0.05em;
          padding: 0.25rem 0.75rem; border-radius: 999px;
        }
        .pub-badge-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }

        /* ── content wrapper ── */
        .pub-content {
          max-width: 960px; margin: 0 auto; padding: 2rem 1rem;
          display: flex; flex-direction: column; gap: 1.5rem;
        }

        /* ── hero ── */
        .pub-hero {
          display: flex; align-items: flex-start; justify-content: space-between;
          gap: 1.5rem; flex-wrap: wrap;
          background: linear-gradient(135deg, rgba(30,41,59,0.9), rgba(15,23,42,0.9));
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 1.25rem; padding: 2rem;
          backdrop-filter: blur(8px);
        }
        .pub-hero-eyebrow {
          font-size: 0.7rem; font-weight: 700; text-transform: uppercase;
          letter-spacing: 0.15em; color: #f59e0b; margin-bottom: 0.5rem;
        }
        .pub-hero-number {
          font-size: 2rem; font-weight: 800; color: #f8fafc;
          margin: 0 0 0.5rem;
        }
        .pub-hero-customer { font-size: 1.1rem; font-weight: 600; color: #cbd5e1; }
        .pub-hero-email    { font-size: 0.85rem; color: #94a3b8; margin-top: 0.25rem; }

        .pub-amount-card {
          text-align: right;
          background: linear-gradient(135deg, rgba(245,158,11,0.12), rgba(251,146,60,0.08));
          border: 1px solid rgba(245,158,11,0.25); border-radius: 1rem;
          padding: 1.5rem 2rem;
        }
        .pub-amount-label  { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.12em; color: #94a3b8; margin-bottom: 0.25rem; }
        .pub-amount-value  { font-size: 2.25rem; font-weight: 800; color: #f8fafc; line-height: 1; }
        .pub-amount-value--paid    { color: #34d399; }
        .pub-amount-value--overdue { color: #f87171; }
        .pub-amount-currency { font-size: 0.75rem; color: #64748b; margin-top: 0.25rem; }
        .pub-amount-due     { font-size: 0.8rem; color: #94a3b8; margin-top: 0.5rem; }
        .pub-amount-due--overdue { color: #f87171; font-weight: 600; }

        /* ── section card ── */
        .pub-card {
          background: rgba(30,41,59,0.7);
          border: 1px solid rgba(255,255,255,0.07);
          border-radius: 1.25rem; padding: 1.75rem;
          backdrop-filter: blur(8px);
        }
        .pub-card--accent {
          border-color: rgba(245,158,11,0.3);
          background: linear-gradient(135deg, rgba(30,41,59,0.9), rgba(15,23,42,0.95));
          box-shadow: 0 0 40px rgba(245,158,11,0.08);
        }
        .pub-card-header {
          display: flex; align-items: center; gap: 0.6rem; margin-bottom: 1.25rem;
          border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 1rem;
        }
        .pub-card-icon { font-size: 1.1rem; }
        .pub-card-title { font-size: 1rem; font-weight: 700; color: #f8fafc; margin: 0; }

        /* ── two-col grid ── */
        .pub-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
        @media(max-width:640px){ .pub-grid { grid-template-columns: 1fr; } }

        /* ── info rows ── */
        .pub-details-grid { display: flex; flex-direction: column; gap: 0.75rem; }
        .pub-info-row { display: flex; justify-content: space-between; align-items: center; font-size: 0.85rem; gap: 1rem; }
        .pub-info-label { color: #64748b; white-space: nowrap; }
        .pub-info-value { color: #e2e8f0; font-weight: 500; text-align: right; }
        .pub-mono { font-family: 'JetBrains Mono', 'Fira Mono', monospace; font-size: 0.82rem; }

        /* ── billing block ── */
        .pub-billing-block { display: flex; flex-direction: column; gap: 0.4rem; }
        .pub-billing-name    { font-size: 1rem; font-weight: 700; color: #f8fafc; }
        .pub-billing-contact { font-size: 0.85rem; color: #94a3b8; }
        .pub-billing-detail  { font-size: 0.85rem; color: #94a3b8; }
        .pub-billing-addr    { font-size: 0.85rem; color: #94a3b8; margin-top: 0.5rem; white-space: pre-line; }
        .pub-billing-tax     { font-size: 0.78rem; color: #64748b; font-family: monospace; }

        /* ── table ── */
        .pub-table-wrap { overflow-x: auto; margin: 0 -0.5rem; }
        .pub-table { width: 100%; border-collapse: separate; border-spacing: 0; min-width: 640px; }
        .pub-th {
          font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em;
          color: #64748b; padding: 0.75rem 1rem;
          border-bottom: 1px solid rgba(255,255,255,0.07);
          background: rgba(15,23,42,0.4);
        }
        .pub-th--left  { text-align: left;  }
        .pub-th--right { text-align: right; }
        .pub-tr { transition: background 0.15s; }
        .pub-tr:hover { background: rgba(255,255,255,0.02); }
        .pub-tr:not(:last-child) .pub-td { border-bottom: 1px solid rgba(255,255,255,0.04); }
        .pub-td { padding: 1rem; font-size: 0.85rem; color: #e2e8f0; vertical-align: top; }
        .pub-td--right { text-align: right; }
        .pub-td--muted { color: #64748b; }
        .pub-td--bold  { font-weight: 700; color: #f8fafc; }
        .pub-td--type  { white-space: nowrap; }

        .pub-item-name  { font-weight: 600; color: #f1f5f9; }
        .pub-item-sku   { font-size: 0.72rem; color: #64748b; margin-top: 0.2rem; font-family: monospace; }
        .pub-item-tag   { display: inline-block; font-size: 0.65rem; padding: 0.1rem 0.4rem; background: rgba(99,102,241,0.15); border: 1px solid rgba(99,102,241,0.3); border-radius: 4px; color: #a5b4fc; margin-top: 0.2rem; }
        .pub-item-notes { font-size: 0.75rem; color: #94a3b8; margin-top: 0.3rem; }

        .pub-type-badge {
          font-size: 0.65rem; font-weight: 600; padding: 0.15rem 0.5rem;
          border-radius: 4px; text-transform: capitalize;
          background: rgba(148,163,184,0.1); border: 1px solid rgba(148,163,184,0.2);
          color: #94a3b8;
        }
        .pub-type-badge--plan   { background: rgba(99,102,241,0.15); border-color: rgba(99,102,241,0.3); color: #a5b4fc; }
        .pub-type-badge--manual { background: rgba(100,116,139,0.15); border-color: rgba(100,116,139,0.3); color: #94a3b8; }

        .pub-discount     { color: #fb923c; font-size: 0.8rem; font-weight: 600; }
        .pub-discount-amt { font-size: 0.72rem; opacity: 0.7; }
        .pub-tax-pct      { color: #60a5fa; font-size: 0.8rem; font-weight: 600; }

        .pub-empty-items { color: #64748b; font-size: 0.9rem; text-align: center; padding: 2rem 0; }

        /* conversion note */
        .pub-conversion-note {
          margin-top: 1rem; padding: 0.75rem 1rem;
          background: rgba(245,158,11,0.05); border: 1px solid rgba(245,158,11,0.15);
          border-radius: 0.75rem;
        }
        .pub-conversion-title { font-size: 0.75rem; font-weight: 700; color: #f59e0b; margin-bottom: 0.5rem; }
        .pub-conversion-row   { font-size: 0.8rem; color: #d97706; margin: 0.2rem 0; }

        /* ── financial summary ── */
        .pub-fin-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 2rem; }
        @media(max-width:640px){ .pub-fin-grid { grid-template-columns: 1fr; } }
        .pub-fin-col-title { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #64748b; margin-bottom: 1rem; }
        .pub-fin-rows { display: flex; flex-direction: column; gap: 0.6rem; }
        .pub-fin-row {
          display: flex; justify-content: space-between; align-items: center;
          font-size: 0.85rem; color: #94a3b8;
          padding: 0.5rem 0; border-bottom: 1px solid rgba(255,255,255,0.04);
        }
        .pub-fin-row--discount span { color: #fb923c; }
        .pub-fin-row--paid    span  { color: #34d399; }
        .pub-fin-row--total {
          color: #f8fafc; font-weight: 700; font-size: 0.95rem;
          border-top: 2px solid rgba(255,255,255,0.1); border-bottom: none;
          padding-top: 0.75rem; margin-top: 0.25rem;
        }
        .pub-fin-row--due { color: #f8fafc; font-weight: 700; border-bottom: none; }
        .pub-fin-row--overdue .pub-fin-row-due-label,
        .pub-fin-row--overdue .pub-fin-row-due-val { color: #f87171; }
        .pub-fin-row-due-label { font-size: 0.95rem; }
        .pub-fin-row-due-val   { font-size: 1.1rem; }

        .pub-paid-note      { font-size: 0.8rem; color: #34d399; margin-top: 1rem; }
        .pub-cancelled-note { font-size: 0.8rem; color: #f87171; margin-top: 1rem; }

        .pub-overdue-banner {
          margin-top: 1rem; padding: 0.85rem 1rem;
          background: rgba(239,68,68,0.08); border: 1px solid rgba(239,68,68,0.25);
          border-radius: 0.75rem;
        }
        .pub-overdue-banner-title { font-size: 0.8rem; font-weight: 700; color: #f87171; margin-bottom: 0.3rem; }
        .pub-overdue-banner-msg   { font-size: 0.78rem; color: #fca5a5; }

        /* ── payment progress ── */
        .pub-progress-section {}
        .pub-progress-amounts {
          display: flex; gap: 2rem; margin-bottom: 1rem; flex-wrap: wrap;
        }
        .pub-progress-amt { display: flex; flex-direction: column; gap: 0.25rem; }
        .pub-progress-amt-label { font-size: 0.7rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.1em; }
        .pub-progress-amt-val   { font-size: 1rem; font-weight: 700; color: #f8fafc; font-family: monospace; }
        .pub-progress-amt-val--paid { color: #34d399; }
        .pub-progress-wrap { }
        .pub-progress-bar  { height: 10px; background: rgba(255,255,255,0.07); border-radius: 999px; overflow: hidden; }
        .pub-progress-fill { height: 100%; background: linear-gradient(90deg, #10b981, #34d399); border-radius: 999px; transition: width 0.6s ease; }
        .pub-progress-labels { display: flex; justify-content: space-between; margin-top: 0.5rem; font-size: 0.72rem; color: #64748b; }
        .pub-progress-paid      { color: #34d399; }
        .pub-progress-remaining { }

        /* ── pay tiles ── */
        .pub-pay-section { display: flex; flex-direction: column; gap: 1.5rem; }
        .pub-pay-amount-row {
          display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem;
        }
        .pub-pay-label  { font-size: 0.72rem; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 0.3rem; }
        .pub-pay-amount { font-size: 2rem; font-weight: 800; color: #f8fafc; font-family: monospace; }
        .pub-pay-secure {
          display: flex; align-items: center; gap: 0.4rem;
          font-size: 0.75rem; color: #64748b;
          background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.07);
          padding: 0.4rem 0.8rem; border-radius: 0.5rem;
        }
        .pub-pay-secure-icon { font-size: 1rem; }

        .pub-pay-methods-title { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.12em; color: #64748b; }
        .pub-pay-tiles { display: grid; grid-template-columns: repeat(4,1fr); gap: 0.75rem; }
        @media(max-width:640px){ .pub-pay-tiles { grid-template-columns: repeat(2,1fr); } }

        .pub-pay-tile {
          display: flex; flex-direction: column; align-items: center; gap: 0.4rem;
          padding: 1.25rem 0.75rem; border-radius: 0.875rem; cursor: pointer;
          background: rgba(255,255,255,0.04); border: 2px solid rgba(255,255,255,0.08);
          transition: all 0.2s; text-align: center;
          color: #e2e8f0;
        }
        .pub-pay-tile:hover:not(:disabled) {
          background: rgba(245,158,11,0.08); border-color: rgba(245,158,11,0.4);
          transform: translateY(-2px);
          box-shadow: 0 8px 24px rgba(0,0,0,0.3);
        }
        .pub-pay-tile--disabled { opacity: 0.5; cursor: not-allowed; }
        .pub-pay-tile-icon  { font-size: 1.5rem; }
        .pub-pay-tile-label { font-size: 0.8rem; font-weight: 700; color: #f1f5f9; }
        .pub-pay-tile-sub   { font-size: 0.68rem; color: #64748b; }
        .pub-pay-tile-soon  { font-size: 0.62rem; padding: 0.1rem 0.4rem; background: rgba(100,116,139,0.2); border-radius: 4px; color: #64748b; }

        /* ── stripe form placeholder ── */
        .pub-stripe-form {
          background: rgba(15,23,42,0.6); border: 1px solid rgba(255,255,255,0.1);
          border-radius: 1rem; padding: 1.5rem;
          display: flex; flex-direction: column; gap: 1.25rem;
        }
        .pub-stripe-header { display: flex; align-items: center; justify-content: space-between; }
        .pub-stripe-title  { font-size: 0.9rem; font-weight: 700; color: #f8fafc; }
        .pub-stripe-brands { display: flex; gap: 0.4rem; }
        .pub-card-chip {
          font-size: 0.62rem; font-weight: 800; padding: 0.2rem 0.5rem;
          background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.1);
          border-radius: 4px; color: #94a3b8; letter-spacing: 0.05em;
        }

        .pub-stripe-mount-placeholder { display: flex; flex-direction: column; gap: 1rem; }
        .pub-stripe-mock-field { display: flex; flex-direction: column; gap: 0.35rem; }
        .pub-stripe-mock-field--half { flex: 1; }
        .pub-stripe-mock-row { display: flex; gap: 1rem; }
        .pub-stripe-mock-label { font-size: 0.72rem; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.07em; }
        .pub-stripe-mock-input {
          display: flex; align-items: center; justify-content: space-between;
          padding: 0.75rem 1rem; border-radius: 0.6rem;
          background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1);
          min-height: 48px; cursor: text;
          transition: border-color 0.2s;
        }
        .pub-stripe-mock-input:focus-within { border-color: rgba(245,158,11,0.5); }
        .pub-stripe-mock-placeholder { color: #334155; font-size: 0.9rem; font-family: monospace; }
        .pub-stripe-mock-icon { color: #334155; font-size: 1.1rem; }
        .pub-stripe-integration-note {
          padding: 0.75rem 1rem; border-radius: 0.6rem;
          background: rgba(99,102,241,0.06); border: 1px dashed rgba(99,102,241,0.3);
          font-size: 0.78rem; color: #94a3b8; line-height: 1.5;
        }
        .pub-stripe-note-icon { font-style: normal; color: #a5b4fc; margin-right: 0.3rem; }
        .pub-stripe-integration-note code {
          background: rgba(255,255,255,0.07); border-radius: 3px; padding: 0.1rem 0.3rem;
          font-size: 0.75rem; color: #a5b4fc;
        }

        /* pay button */
        .pub-pay-btn {
          display: flex; align-items: center; justify-content: center; gap: 0.6rem;
          width: 100%; padding: 1rem; border-radius: 0.875rem; border: none; cursor: pointer;
          font-size: 1rem; font-weight: 800; letter-spacing: 0.02em;
          background: linear-gradient(135deg, #f59e0b, #fb923c);
          color: #0f172a; transition: all 0.2s;
          box-shadow: 0 4px 20px rgba(245,158,11,0.35);
        }
        .pub-pay-btn:hover { transform: translateY(-1px); box-shadow: 0 8px 28px rgba(245,158,11,0.45); }
        .pub-pay-btn:active { transform: translateY(0); }
        .pub-pay-btn-icon { font-size: 1.1rem; }

        .pub-pay-terms {
          font-size: 0.72rem; color: #475569; text-align: center; line-height: 1.6;
        }
        .pub-pay-link { color: #f59e0b; cursor: pointer; }

        .pub-pay-footer { margin-top: 0.5rem; }
        .pub-pay-badges { display: flex; gap: 0.75rem; flex-wrap: wrap; justify-content: center; }
        .pub-pay-badge {
          font-size: 0.7rem; font-weight: 600;
          padding: 0.25rem 0.75rem; border-radius: 999px;
          background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);
          color: #64748b;
        }

        /* ── paid banner ── */
        .pub-paid-banner {
          display: flex; align-items: center; gap: 1rem;
          padding: 1.5rem 2rem; border-radius: 1.25rem;
          background: linear-gradient(135deg, rgba(16,185,129,0.1), rgba(5,150,105,0.08));
          border: 1px solid rgba(16,185,129,0.25);
        }
        .pub-paid-banner-icon  { font-size: 2rem; }
        .pub-paid-banner-title { font-size: 1rem; font-weight: 700; color: #34d399; }
        .pub-paid-banner-msg   { font-size: 0.85rem; color: #6ee7b7; margin-top: 0.25rem; }

        /* ── notes ── */
        .pub-notes { font-size: 0.88rem; color: #94a3b8; line-height: 1.7; white-space: pre-wrap; }

        /* ── error ── */
        .pub-error-card {
          max-width: 480px; margin: 8rem auto; text-align: center; padding: 2.5rem;
          background: rgba(30,41,59,0.8); border: 1px solid rgba(239,68,68,0.2);
          border-radius: 1.25rem;
        }
        .pub-error-icon  { font-size: 3rem; display: block; margin-bottom: 1rem; }
        .pub-error-title { font-size: 1.25rem; font-weight: 700; color: #f8fafc; margin-bottom: 0.75rem; }
        .pub-error-msg   { font-size: 0.9rem; color: #f87171; margin-bottom: 1rem; }
        .pub-error-help  { font-size: 0.82rem; color: #64748b; }

        /* ── page footer ── */
        .pub-page-footer {
          text-align: center; padding: 1rem 0; margin-top: 1rem;
          font-size: 0.78rem; color: #334155;
          border-top: 1px solid rgba(255,255,255,0.04);
        }
        .pub-footer-inv { margin-top: 0.25rem; font-family: monospace; font-size: 0.72rem; }
      `}</style>
    </div>
  );
}
