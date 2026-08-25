import React, { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
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
  draft: { label: "Draft", bg: "bg-slate-100", text: "text-slate-600", dot: "bg-slate-400" },
  issued: { label: "Issued", bg: "bg-blue-100", text: "text-blue-700", dot: "bg-blue-500" },
  delivered: { label: "Delivered", bg: "bg-blue-100", text: "text-blue-700", dot: "bg-blue-500" },
  due: { label: "Due", bg: "bg-amber-100", text: "text-amber-700", dot: "bg-amber-500" },
  partially_paid: { label: "Partially Paid", bg: "bg-amber-100", text: "text-amber-700", dot: "bg-amber-500" },
  paid: { label: "Paid", bg: "bg-emerald-100", text: "text-emerald-700", dot: "bg-emerald-500" },
  overdue: { label: "Overdue", bg: "bg-red-100", text: "text-red-700", dot: "bg-red-500" },
  voided: { label: "Voided", bg: "bg-slate-100", text: "text-slate-500", dot: "bg-slate-300" },
};

function StatusBadge({ status }) {
  const s = (status || "").toLowerCase();
  const cfg = STATUS_MAP[s] || { label: s || "Unknown", bg: "bg-gray-100", text: "text-gray-600", dot: "bg-gray-400" };
  return (
    <span className={`pinv-badge ${cfg.bg} ${cfg.text}`}>
      <span className={`pinv-badge-dot ${cfg.dot}`} />
      {cfg.label}
    </span>
  );
}

function SectionCard({ title, icon, children }) {
  return (
    <div className="pinv-card">
      {title && (
        <div className="pinv-card-header">
          {icon && <span className="pinv-card-icon">{icon}</span>}
          <h2 className="pinv-card-title">{title}</h2>
        </div>
      )}
      {children}
    </div>
  );
}

export default function PublicPlatformInvoicePage() {
  const { token } = useParams();
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

  if (loading) {
    return (
      <div className="pinv-root">
        <div className="pinv-spinner-wrap"><div className="pinv-spinner" /></div>
        <style>{STYLES}</style>
      </div>
    );
  }

  if (error) {
    return (
      <div className="pinv-root">
        <div className="pinv-error-card">
          <span className="pinv-error-icon">⚠️</span>
          <h1 className="pinv-error-title">Invoice Unavailable</h1>
          <p className="pinv-error-msg">{error}</p>
          <p className="pinv-error-help">If you believe this is a mistake, contact Zoiko Billing Accounts.</p>
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

  return (
    <div className="pinv-root">
      <div className="pinv-top-strip">
        <div className="pinv-brand">
          <span className="pinv-brand-icon">⚡</span>
          <span className="pinv-brand-name">Zoiko Billing Accounts</span>
        </div>
        <div className="pinv-top-strip-right">
          <StatusBadge status={invoice.status} />
          {isOverdue && <span className="pinv-overdue-chip">⚠ Overdue</span>}
        </div>
      </div>

      <div className="pinv-content">
        <div className="pinv-hero">
          <div className="pinv-hero-left">
            <p className="pinv-hero-eyebrow">Zoiko Billing Invoice</p>
            <h1 className="pinv-hero-number">{invoice.invoice_number || "Invoice"}</h1>
            <p className="pinv-hero-customer">Billed to {invoice.recipient_org_name || "your organization"}</p>
          </div>
          <div className="pinv-hero-right">
            <div className="pinv-amount-card">
              <p className="pinv-amount-label">Amount Due</p>
              <p className={`pinv-amount-value ${isPaid ? "pinv-amount-value--paid" : ""} ${isOverdue ? "pinv-amount-value--overdue" : ""}`}>
                {fmtCcy(invoice.balance_due, currency)}
              </p>
              <p className="pinv-amount-currency">{currency}</p>
              {invoice.due_date && (
                <p className={`pinv-amount-due ${isOverdue ? "pinv-amount-due--overdue" : ""}`}>
                  Due {fmtDate(invoice.due_date)}
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="pinv-grid">
          <SectionCard title="Invoice Details" icon="📋">
            <div className="pinv-details-grid">
              <div className="pinv-info-row"><span className="pinv-info-label">Invoice #</span><span className="pinv-info-value pinv-mono">{invoice.invoice_number || "—"}</span></div>
              <div className="pinv-info-row"><span className="pinv-info-label">Issue Date</span><span className="pinv-info-value">{fmtDate(invoice.issue_date)}</span></div>
              <div className="pinv-info-row"><span className="pinv-info-label">Due Date</span><span className="pinv-info-value">{fmtDate(invoice.due_date)}</span></div>
              <div className="pinv-info-row"><span className="pinv-info-label">Currency</span><span className="pinv-info-value">{currency}</span></div>
            </div>
          </SectionCard>
          <SectionCard title="Billed To" icon="🏢">
            <p className="pinv-billing-name">{invoice.recipient_org_name || "—"}</p>
            <p className="pinv-billing-detail">Zoiko Billing subscription charges</p>
          </SectionCard>
        </div>

        <SectionCard title="Line Items" icon="📦">
          {items.length === 0 ? (
            <p className="pinv-empty-items">No line items on this invoice.</p>
          ) : (
            <div className="pinv-table-wrap">
              <table className="pinv-table">
                <thead>
                  <tr>
                    <th className="pinv-th pinv-th--left">Description</th>
                    <th className="pinv-th pinv-th--right">Qty</th>
                    <th className="pinv-th pinv-th--right">Unit Price</th>
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
        </SectionCard>

        <SectionCard title="Financial Summary" icon="📊">
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
            <div className="pinv-fin-row pinv-fin-row--due"><span>Balance Due</span><span className="pinv-mono">{fmtCcy(invoice.balance_due, currency)}</span></div>
          </div>
        </SectionCard>

        {canPay && (
          <SectionCard title="Pay This Invoice" icon="💳">
            <div className="pinv-coming-soon">
              <span className="pinv-coming-soon-icon">🔧</span>
              <div>
                <p className="pinv-coming-soon-title">Online payment isn't enabled yet</p>
                <p className="pinv-coming-soon-msg">
                  Zoiko Billing Accounts will follow up separately with payment
                  instructions for this invoice.
                </p>
              </div>
            </div>
          </SectionCard>
        )}

        {isPaid && (
          <div className="pinv-paid-banner">
            <span className="pinv-paid-banner-icon">✅</span>
            <p className="pinv-paid-banner-title">This invoice is fully paid. Thank you.</p>
          </div>
        )}

        {invoice.notes && (
          <SectionCard title="Notes" icon="📝">
            <p className="pinv-notes">{invoice.notes}</p>
          </SectionCard>
        )}

        <div className="pinv-page-footer">
          <p>Sent by Zoiko Billing Accounts</p>
        </div>
      </div>
      <style>{STYLES}</style>
    </div>
  );
}

const STYLES = `
  .pinv-root { min-height: 100vh; background: linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%); font-family: 'Inter', 'Segoe UI', system-ui, sans-serif; color: #e2e8f0; padding-bottom: 3rem; }
  .pinv-spinner-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .pinv-spinner { width: 3rem; height: 3rem; border-radius: 50%; border: 3px solid rgba(59,130,246,0.2); border-top-color: #3b82f6; animation: pinv-spin 0.8s linear infinite; }
  @keyframes pinv-spin { to { transform: rotate(360deg); } }
  .pinv-top-strip { background: rgba(15,23,42,0.95); border-bottom: 1px solid rgba(255,255,255,0.06); padding: 1rem 2rem; display: flex; align-items: center; justify-content: space-between; position: sticky; top: 0; z-index: 50; backdrop-filter: blur(12px); }
  .pinv-brand { display: flex; align-items: center; gap: 0.5rem; font-weight: 700; font-size: 1rem; }
  .pinv-brand-name { background: linear-gradient(90deg, #3b82f6, #7c3aed); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  .pinv-top-strip-right { display: flex; align-items: center; gap: 0.75rem; }
  .pinv-overdue-chip { font-size: 0.7rem; font-weight: 700; padding: 0.2rem 0.6rem; background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.4); border-radius: 999px; color: #fca5a5; letter-spacing: 0.05em; }
  .pinv-badge { display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.7rem; font-weight: 600; letter-spacing: 0.05em; padding: 0.25rem 0.75rem; border-radius: 999px; }
  .pinv-badge-dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .pinv-content { max-width: 900px; margin: 0 auto; padding: 2rem 1rem; display: flex; flex-direction: column; gap: 1.5rem; }
  .pinv-hero { display: flex; align-items: flex-start; justify-content: space-between; gap: 1.5rem; flex-wrap: wrap; background: linear-gradient(135deg, rgba(30,41,59,0.9), rgba(15,23,42,0.9)); border: 1px solid rgba(255,255,255,0.08); border-radius: 1.25rem; padding: 2rem; }
  .pinv-hero-eyebrow { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.15em; color: #3b82f6; margin-bottom: 0.5rem; }
  .pinv-hero-number { font-size: 2rem; font-weight: 800; color: #f8fafc; margin: 0 0 0.5rem; }
  .pinv-hero-customer { font-size: 1rem; color: #cbd5e1; }
  .pinv-amount-card { text-align: right; background: linear-gradient(135deg, rgba(59,130,246,0.12), rgba(124,58,237,0.08)); border: 1px solid rgba(59,130,246,0.25); border-radius: 1rem; padding: 1.5rem 2rem; }
  .pinv-amount-label { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.12em; color: #94a3b8; margin-bottom: 0.25rem; }
  .pinv-amount-value { font-size: 2.25rem; font-weight: 800; color: #f8fafc; line-height: 1; }
  .pinv-amount-value--paid { color: #34d399; }
  .pinv-amount-value--overdue { color: #f87171; }
  .pinv-amount-currency { font-size: 0.75rem; color: #64748b; margin-top: 0.25rem; }
  .pinv-amount-due { font-size: 0.8rem; color: #94a3b8; margin-top: 0.5rem; }
  .pinv-amount-due--overdue { color: #f87171; font-weight: 600; }
  .pinv-card { background: rgba(30,41,59,0.7); border: 1px solid rgba(255,255,255,0.07); border-radius: 1.25rem; padding: 1.75rem; }
  .pinv-card-header { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 1.25rem; border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 1rem; }
  .pinv-card-title { font-size: 1rem; font-weight: 700; color: #f8fafc; margin: 0; }
  .pinv-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
  @media(max-width:640px){ .pinv-grid { grid-template-columns: 1fr; } }
  .pinv-details-grid { display: flex; flex-direction: column; gap: 0.75rem; }
  .pinv-info-row { display: flex; justify-content: space-between; font-size: 0.85rem; gap: 1rem; }
  .pinv-info-label { color: #64748b; }
  .pinv-info-value { color: #e2e8f0; font-weight: 500; text-align: right; }
  .pinv-mono { font-family: 'JetBrains Mono', 'Fira Mono', monospace; font-size: 0.82rem; }
  .pinv-billing-name { font-size: 1rem; font-weight: 700; color: #f8fafc; margin: 0 0 0.4rem; }
  .pinv-billing-detail { font-size: 0.85rem; color: #94a3b8; margin: 0; }
  .pinv-table-wrap { overflow-x: auto; }
  .pinv-table { width: 100%; border-collapse: separate; border-spacing: 0; min-width: 520px; }
  .pinv-th { font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #64748b; padding: 0.75rem 0.5rem; border-bottom: 1px solid rgba(255,255,255,0.07); }
  .pinv-th--left { text-align: left; }
  .pinv-th--right { text-align: right; }
  .pinv-tr:not(:last-child) .pinv-td { border-bottom: 1px solid rgba(255,255,255,0.04); }
  .pinv-td { padding: 0.85rem 0.5rem; font-size: 0.85rem; color: #e2e8f0; }
  .pinv-td--right { text-align: right; }
  .pinv-td--bold { font-weight: 700; color: #f8fafc; }
  .pinv-empty-items { color: #64748b; font-size: 0.9rem; text-align: center; padding: 1.5rem 0; }
  .pinv-fin-rows { display: flex; flex-direction: column; gap: 0.6rem; }
  .pinv-fin-row { display: flex; justify-content: space-between; font-size: 0.85rem; color: #94a3b8; padding: 0.5rem 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
  .pinv-fin-row--total { color: #f8fafc; font-weight: 700; font-size: 0.95rem; border-top: 2px solid rgba(255,255,255,0.1); border-bottom: none; padding-top: 0.75rem; margin-top: 0.25rem; }
  .pinv-fin-row--due { color: #f8fafc; font-weight: 700; border-bottom: none; font-size: 1.05rem; }
  .pinv-coming-soon { display: flex; align-items: flex-start; gap: 1rem; padding: 1rem 1.25rem; border-radius: 0.875rem; background: rgba(99,102,241,0.06); border: 1px dashed rgba(99,102,241,0.3); }
  .pinv-coming-soon-icon { font-size: 1.5rem; }
  .pinv-coming-soon-title { font-size: 0.9rem; font-weight: 700; color: #f1f5f9; margin: 0 0 0.25rem; }
  .pinv-coming-soon-msg { font-size: 0.82rem; color: #94a3b8; margin: 0; line-height: 1.5; }
  .pinv-paid-banner { display: flex; align-items: center; gap: 1rem; padding: 1.25rem 1.75rem; border-radius: 1.25rem; background: linear-gradient(135deg, rgba(16,185,129,0.1), rgba(5,150,105,0.08)); border: 1px solid rgba(16,185,129,0.25); }
  .pinv-paid-banner-icon { font-size: 1.75rem; }
  .pinv-paid-banner-title { font-size: 0.95rem; font-weight: 700; color: #34d399; margin: 0; }
  .pinv-notes { font-size: 0.88rem; color: #94a3b8; line-height: 1.7; white-space: pre-wrap; margin: 0; }
  .pinv-error-card { max-width: 480px; margin: 8rem auto; text-align: center; padding: 2.5rem; background: rgba(30,41,59,0.8); border: 1px solid rgba(239,68,68,0.2); border-radius: 1.25rem; }
  .pinv-error-icon { font-size: 3rem; display: block; margin-bottom: 1rem; }
  .pinv-error-title { font-size: 1.25rem; font-weight: 700; color: #f8fafc; margin-bottom: 0.75rem; }
  .pinv-error-msg { font-size: 0.9rem; color: #f87171; margin-bottom: 1rem; }
  .pinv-error-help { font-size: 0.82rem; color: #64748b; }
  .pinv-page-footer { text-align: center; padding: 1rem 0; font-size: 0.78rem; color: #334155; border-top: 1px solid rgba(255,255,255,0.04); }
`;
