import React, { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { publicPlatformInvoiceApi } from "../service/platformPublicService";

function fmtCcy(v, currency) {
  const num = Number(v ?? 0);
  if (Number.isNaN(num)) return `${currency || ""} ${v}`.trim();
  return num.toLocaleString("en-US", { style: "currency", currency: currency || "USD" });
}

function fmtDate(d) {
  if (!d) return "—";
  const parsed = new Date(d);
  if (Number.isNaN(parsed.getTime())) return d;
  return parsed.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

const STATUS_MAP = {
  draft: { label: "Draft", tone: "neutral" },
  issued: { label: "Issued", tone: "info" },
  delivered: { label: "Delivered", tone: "info" },
  due: { label: "Due", tone: "warn" },
  partially_paid: { label: "Partially Paid", tone: "warn" },
  paid: { label: "Paid", tone: "success" },
  overdue: { label: "Overdue", tone: "danger" },
  voided: { label: "Voided", tone: "neutral" },
};

function StatusBadge({ status }) {
  const s = (status || "").toLowerCase();
  const cfg = STATUS_MAP[s] || { label: s || "Unknown", tone: "neutral" };
  return (
    <span className={`pinv-badge pinv-badge--${cfg.tone}`}>
      <span className="pinv-badge-dot" />
      {cfg.label}
    </span>
  );
}

function Header({ right }) {
  return (
    <header className="pinv-header">
      <div className="pinv-header-inner">
        <img
          src="/zoiko-billing-logo-sm.png"
          alt="Zoiko Billing"
          width="123"
          height="44"
          className="pinv-logo"
        />
        <div className="pinv-header-right">{right}</div>
      </div>
    </header>
  );
}

function SectionCard({ title, children, className = "" }) {
  return (
    <section className={`pinv-card ${className}`}>
      {title && <h2 className="pinv-card-title">{title}</h2>}
      {children}
    </section>
  );
}

function InfoRow({ label, value, mono }) {
  return (
    <div className="pinv-info-row">
      <span className="pinv-info-label">{label}</span>
      <span className={`pinv-info-value ${mono ? "pinv-mono" : ""}`}>{value}</span>
    </div>
  );
}

export default function PublicPlatformInvoicePage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [invoice, setInvoice] = useState(null);

  const load = useCallback(async () => {
    if (!token) {
      setError("Invalid invoice link. Please check the URL and try again.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await publicPlatformInvoiceApi.getView(token);
      setInvoice(data);
    } catch (err) {
      setError(err?.detail || err?.message || "Unable to load invoice. The link may have expired or is invalid.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  // Navigates to a dedicated checkout page (rather than calling the
  // checkout API inline) so clicking "Pay" always opens a real page
  // immediately — that page starts the Stripe session and forwards the
  // browser there, or shows a clear "not configured" state of its own.
  const handlePayNow = useCallback(() => {
    if (!token) return;
    navigate(`/platform-invoice/${token}/checkout`);
  }, [token, navigate]);

  if (loading) {
    return (
      <div className="pinv-root">
        <Header />
        <div className="pinv-spinner-wrap" role="status" aria-label="Loading invoice">
          <div className="pinv-spinner" />
        </div>
        <style>{STYLES}</style>
      </div>
    );
  }

  if (error) {
    return (
      <div className="pinv-root">
        <Header />
        <div className="pinv-error-card">
          <div className="pinv-error-icon" aria-hidden="true">!</div>
          <h1 className="pinv-error-title">Invoice unavailable</h1>
          <p className="pinv-error-msg">{error}</p>
          <p className="pinv-error-help">If you believe this is a mistake, contact Zoiko Billing support.</p>
        </div>
        <style>{STYLES}</style>
      </div>
    );
  }

  const currency = invoice.currency;
  const status = (invoice.status || "").toLowerCase();
  const isPaid = status === "paid";
  const isVoided = status === "voided";
  const isOverdue = status === "overdue";
  const items = Array.isArray(invoice.items) ? invoice.items : [];
  const canPay = !isPaid && !isVoided && Number(invoice.balance_due) > 0.005;
  // Older API responses lack the flag; only an explicit false hides Pay.
  const onlinePayment = invoice.online_payment_available !== false;

  return (
    <div className="pinv-root">
      <Header right={<StatusBadge status={invoice.status} />} />

      <main className="pinv-content">
        <div className="pinv-hero">
          <div>
            <p className="pinv-hero-eyebrow">Invoice</p>
            <h1 className="pinv-hero-number">{invoice.invoice_number || "Invoice"}</h1>
            <p className="pinv-hero-customer">Billed to {invoice.recipient_org_name || "your organization"}</p>
          </div>
          <div className="pinv-amount-card">
            <p className="pinv-amount-label">{isPaid ? "Total paid" : "Amount due"}</p>
            <p className={`pinv-amount-value ${isPaid ? "pinv-amount-value--paid" : ""} ${isOverdue ? "pinv-amount-value--overdue" : ""}`}>
              {fmtCcy(isPaid ? invoice.total_amount : invoice.balance_due, currency)}
            </p>
            {invoice.due_date && !isPaid && (
              <p className={`pinv-amount-due ${isOverdue ? "pinv-amount-due--overdue" : ""}`}>
                Due {fmtDate(invoice.due_date)}
              </p>
            )}
            {canPay && onlinePayment && (
              <button type="button" className="pinv-pay-btn" onClick={handlePayNow}>
                {`Pay ${fmtCcy(invoice.balance_due, currency)}`}
              </button>
            )}
            {canPay && onlinePayment && (
              <p className="pinv-pay-hint">
                <span aria-hidden="true">🔒 </span>Secure payment by card via Stripe
              </p>
            )}
            {canPay && !onlinePayment && (
              <p className="pinv-pay-hint" role="status">
                Card payment isn't available for this invoice yet. Zoiko Billing Accounts will send payment
                instructions — or contact them quoting {invoice.invoice_number}.
              </p>
            )}
          </div>
        </div>

        {isPaid && (
          <div className="pinv-paid-banner" role="status">
            <span className="pinv-paid-banner-icon" aria-hidden="true">✓</span>
            <p className="pinv-paid-banner-title">This invoice is fully paid. Thank you.</p>
          </div>
        )}

        <div className="pinv-grid">
          <SectionCard title="Invoice details">
            <div className="pinv-details-grid">
              <InfoRow label="Invoice number" value={invoice.invoice_number || "—"} mono />
              <InfoRow label="Issue date" value={fmtDate(invoice.issue_date)} />
              <InfoRow label="Due date" value={fmtDate(invoice.due_date)} />
              <InfoRow label="Currency" value={currency} />
            </div>
          </SectionCard>
          <SectionCard title="Billed to">
            <p className="pinv-billing-name">{invoice.recipient_org_name || "—"}</p>
            <p className="pinv-billing-detail">Zoiko Billing subscription charges</p>
          </SectionCard>
        </div>

        <SectionCard title="Line items">
          {items.length === 0 ? (
            <p className="pinv-empty-items">No line items on this invoice.</p>
          ) : (
            <div className="pinv-table-wrap">
              <table className="pinv-table">
                <thead>
                  <tr>
                    <th className="pinv-th pinv-th--left">Description</th>
                    <th className="pinv-th pinv-th--right">Qty</th>
                    <th className="pinv-th pinv-th--right">Unit price</th>
                    <th className="pinv-th pinv-th--right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.line_number} className="pinv-tr">
                      <td className="pinv-td">{item.description}</td>
                      <td className="pinv-td pinv-td--right pinv-mono">{item.quantity}</td>
                      <td className="pinv-td pinv-td--right pinv-mono">{fmtCcy(item.unit_price, currency)}</td>
                      <td className="pinv-td pinv-td--right pinv-td--bold pinv-mono">{fmtCcy(item.total, currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="pinv-fin-rows">
            <div className="pinv-fin-row"><span>Subtotal</span><span className="pinv-mono">{fmtCcy(invoice.subtotal, currency)}</span></div>
            {Number(invoice.discount_amount) > 0 && (
              <div className="pinv-fin-row"><span>Discount</span><span className="pinv-mono">-{fmtCcy(invoice.discount_amount, currency)}</span></div>
            )}
            {Number(invoice.tax_amount) > 0 && (
              <div className="pinv-fin-row"><span>Tax</span><span className="pinv-mono">{fmtCcy(invoice.tax_amount, currency)}</span></div>
            )}
            <div className="pinv-fin-row pinv-fin-row--total"><span>Total</span><span className="pinv-mono">{fmtCcy(invoice.total_amount, currency)}</span></div>
            {Number(invoice.paid_amount) > 0 && (
              <div className="pinv-fin-row"><span>Paid</span><span className="pinv-mono">-{fmtCcy(invoice.paid_amount, currency)}</span></div>
            )}
            <div className="pinv-fin-row pinv-fin-row--due"><span>Balance due</span><span className="pinv-mono">{fmtCcy(invoice.balance_due, currency)}</span></div>
          </div>
        </SectionCard>

        {invoice.notes && (
          <SectionCard title="Notes">
            <p className="pinv-notes">{invoice.notes}</p>
          </SectionCard>
        )}

        <footer className="pinv-page-footer">
          <p>Sent by Zoiko Billing · Questions about this invoice? Contact Zoiko Billing support.</p>
        </footer>
      </main>
      <style>{STYLES}</style>
    </div>
  );
}

const STYLES = `
  .pinv-root { min-height: 100vh; background: #f4f6fb; font-family: 'Inter', 'Segoe UI', system-ui, sans-serif; color: #1e293b; padding-bottom: 3rem; -webkit-font-smoothing: antialiased; }
  .pinv-header { background: #ffffff; border-bottom: 1px solid #e5e9f2; position: sticky; top: 0; z-index: 50; }
  .pinv-header-inner { max-width: 960px; margin: 0 auto; padding: 0.75rem 1.5rem; display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  .pinv-logo { height: 2.75rem; width: auto; display: block; }
  .pinv-header-right { display: flex; align-items: center; gap: 0.5rem; }
  .pinv-spinner-wrap { min-height: 60vh; display: flex; align-items: center; justify-content: center; }
  .pinv-spinner { width: 2.75rem; height: 2.75rem; border-radius: 50%; border: 3px solid #dbe4f5; border-top-color: #2563eb; animation: pinv-spin 0.8s linear infinite; }
  @keyframes pinv-spin { to { transform: rotate(360deg); } }

  .pinv-badge { display: inline-flex; align-items: center; gap: 0.4rem; padding: 0.3rem 0.8rem; border-radius: 999px; font-size: 0.78rem; font-weight: 600; }
  .pinv-badge-dot { width: 0.45rem; height: 0.45rem; border-radius: 50%; background: currentColor; }
  .pinv-badge--neutral { background: #eef1f6; color: #475569; }
  .pinv-badge--info { background: #e6efff; color: #1d4ed8; }
  .pinv-badge--warn { background: #fff4de; color: #b45309; }
  .pinv-badge--success { background: #e3f7ec; color: #047857; }
  .pinv-badge--danger { background: #fde8e8; color: #b91c1c; }

  .pinv-content { max-width: 960px; margin: 0 auto; padding: 2rem 1.5rem 0; display: flex; flex-direction: column; gap: 1.25rem; }

  .pinv-hero { display: grid; grid-template-columns: 1fr auto; gap: 1.5rem; align-items: stretch; }
  .pinv-hero > div:first-child { display: flex; flex-direction: column; justify-content: center; }
  .pinv-hero-eyebrow { font-size: 0.78rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #2563eb; margin: 0 0 0.4rem; }
  .pinv-hero-number { font-size: 2.1rem; font-weight: 800; color: #0f172a; margin: 0; letter-spacing: -0.02em; }
  .pinv-hero-customer { font-size: 1rem; color: #64748b; margin: 0.5rem 0 0; }
  .pinv-amount-card { background: #ffffff; border: 1px solid #e5e9f2; border-radius: 1rem; padding: 1.5rem 1.75rem; min-width: 290px; box-shadow: 0 1px 2px rgba(15,23,42,0.04), 0 8px 24px rgba(15,23,42,0.05); display: flex; flex-direction: column; align-items: stretch; }
  .pinv-amount-label { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #64748b; margin: 0; }
  .pinv-amount-value { font-size: 2.4rem; font-weight: 800; color: #0f172a; margin: 0.25rem 0 0; letter-spacing: -0.02em; }
  .pinv-amount-value--paid { color: #047857; }
  .pinv-amount-value--overdue { color: #b91c1c; }
  .pinv-amount-due { font-size: 0.85rem; color: #64748b; margin: 0.25rem 0 0; }
  .pinv-amount-due--overdue { color: #b91c1c; font-weight: 600; }
  .pinv-pay-btn { margin-top: 1.1rem; padding: 0.85rem 1.5rem; border-radius: 0.7rem; border: none; font-size: 1rem; font-weight: 700; color: #ffffff; cursor: pointer; background: #2563eb; box-shadow: 0 4px 12px rgba(37,99,235,0.28); transition: background 0.15s, transform 0.15s; }
  .pinv-pay-btn:hover { background: #1d4ed8; }
  .pinv-pay-btn:active { transform: translateY(1px); }
  .pinv-pay-btn:focus-visible { outline: 3px solid #93b4f8; outline-offset: 2px; }
  .pinv-pay-hint { font-size: 0.78rem; color: #64748b; margin: 0.7rem 0 0; text-align: center; }

  .pinv-card { background: #ffffff; border: 1px solid #e5e9f2; border-radius: 1rem; padding: 1.5rem 1.75rem; box-shadow: 0 1px 2px rgba(15,23,42,0.03); }
  .pinv-card-title { font-size: 0.95rem; font-weight: 700; color: #0f172a; margin: 0 0 1rem; padding-bottom: 0.85rem; border-bottom: 1px solid #eef1f6; }
  .pinv-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem; }
  .pinv-details-grid { display: flex; flex-direction: column; gap: 0.7rem; }
  .pinv-info-row { display: flex; justify-content: space-between; font-size: 0.88rem; gap: 1rem; }
  .pinv-info-label { color: #64748b; }
  .pinv-info-value { color: #0f172a; font-weight: 500; text-align: right; }
  .pinv-mono { font-variant-numeric: tabular-nums; }
  .pinv-billing-name { font-size: 1.05rem; font-weight: 700; color: #0f172a; margin: 0 0 0.35rem; }
  .pinv-billing-detail { font-size: 0.88rem; color: #64748b; margin: 0; }

  .pinv-table-wrap { overflow-x: auto; }
  .pinv-table { width: 100%; border-collapse: separate; border-spacing: 0; min-width: 480px; }
  .pinv-th { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #64748b; padding: 0.7rem 0.6rem; background: #f8fafc; border-bottom: 1px solid #e5e9f2; }
  .pinv-th--left { text-align: left; border-top-left-radius: 0.5rem; }
  .pinv-th--right { text-align: right; }
  .pinv-th:last-child { border-top-right-radius: 0.5rem; }
  .pinv-tr:not(:last-child) .pinv-td { border-bottom: 1px solid #eef1f6; }
  .pinv-td { padding: 0.9rem 0.6rem; font-size: 0.9rem; color: #1e293b; }
  .pinv-td--right { text-align: right; }
  .pinv-td--bold { font-weight: 700; color: #0f172a; }
  .pinv-empty-items { color: #64748b; font-size: 0.9rem; text-align: center; padding: 1.5rem 0; margin: 0; }

  .pinv-fin-rows { display: flex; flex-direction: column; margin: 1rem 0 0 auto; max-width: 340px; }
  .pinv-fin-row { display: flex; justify-content: space-between; font-size: 0.9rem; color: #475569; padding: 0.45rem 0; }
  .pinv-fin-row--total { color: #0f172a; font-weight: 700; border-top: 1px solid #e5e9f2; margin-top: 0.3rem; padding-top: 0.75rem; }
  .pinv-fin-row--due { color: #0f172a; font-weight: 800; font-size: 1.05rem; background: #f1f5ff; border-radius: 0.5rem; padding: 0.7rem 0.75rem; margin-top: 0.4rem; }

  .pinv-paid-banner { display: flex; align-items: center; gap: 0.9rem; padding: 1rem 1.4rem; border-radius: 0.9rem; background: #e9f8f0; border: 1px solid #b7e7cd; }
  .pinv-paid-banner-icon { width: 1.9rem; height: 1.9rem; border-radius: 50%; background: #10b981; color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 800; flex-shrink: 0; }
  .pinv-paid-banner-title { font-size: 0.95rem; font-weight: 600; color: #065f46; margin: 0; }
  .pinv-notes { font-size: 0.9rem; color: #475569; line-height: 1.7; white-space: pre-wrap; margin: 0; }

  .pinv-error-card { max-width: 460px; margin: 5rem auto 0; text-align: center; padding: 2.5rem; background: #ffffff; border: 1px solid #e5e9f2; border-radius: 1rem; box-shadow: 0 8px 24px rgba(15,23,42,0.06); }
  .pinv-error-icon { width: 3rem; height: 3rem; border-radius: 50%; background: #fde8e8; color: #b91c1c; font-size: 1.5rem; font-weight: 800; display: flex; align-items: center; justify-content: center; margin: 0 auto 1rem; }
  .pinv-error-title { font-size: 1.25rem; font-weight: 700; color: #0f172a; margin: 0 0 0.6rem; }
  .pinv-error-msg { font-size: 0.92rem; color: #b91c1c; margin: 0 0 1rem; }
  .pinv-error-help { font-size: 0.82rem; color: #64748b; margin: 0; }
  .pinv-page-footer { text-align: center; padding: 1rem 0 0; font-size: 0.8rem; color: #94a3b8; }
  .pinv-page-footer p { margin: 0; }

  @media (max-width: 720px) {
    .pinv-hero { grid-template-columns: 1fr; }
    .pinv-amount-card { min-width: 0; }
    .pinv-grid { grid-template-columns: 1fr; }
    .pinv-hero-number { font-size: 1.7rem; }
    .pinv-content { padding: 1.25rem 1rem 0; }
    .pinv-header-inner { padding: 0.6rem 1rem; }
    .pinv-fin-rows { max-width: none; }
    .pinv-table { min-width: 0; }
    .pinv-th, .pinv-td { padding-left: 0.35rem; padding-right: 0.35rem; font-size: 0.8rem; }
    .pinv-card { padding: 1.25rem 1.1rem; }
  }
`;
