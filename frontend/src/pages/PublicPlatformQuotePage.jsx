import React, { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { publicPlatformQuoteApi } from "../service/platformPublicService";

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
  draft: { label: "Draft", bg: "bg-slate-100", text: "text-slate-600" },
  sent: { label: "Awaiting Your Response", bg: "bg-blue-100", text: "text-blue-700" },
  accepted: { label: "Accepted", bg: "bg-emerald-100", text: "text-emerald-700" },
  rejected: { label: "Rejected", bg: "bg-red-100", text: "text-red-700" },
  expired: { label: "Expired", bg: "bg-amber-100", text: "text-amber-700" },
  converted: { label: "Converted to Invoice", bg: "bg-purple-100", text: "text-purple-700" },
};

function StatusBadge({ status }) {
  const s = (status || "").toLowerCase();
  const cfg = STATUS_MAP[s] || { label: s || "Unknown", bg: "bg-gray-100", text: "text-gray-600" };
  return <span className={`pquo-badge ${cfg.bg} ${cfg.text}`}>{cfg.label}</span>;
}

function SectionCard({ title, icon, children }) {
  return (
    <div className="pquo-card">
      {title && (
        <div className="pquo-card-header">
          {icon && <span className="pquo-card-icon">{icon}</span>}
          <h2 className="pquo-card-title">{title}</h2>
        </div>
      )}
      {children}
    </div>
  );
}

export default function PublicPlatformQuotePage() {
  const { token } = useParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [quote, setQuote] = useState(null);
  const [acting, setActing] = useState(false);
  const [actionError, setActionError] = useState(null);
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  const load = useCallback(async () => {
    if (!token) {
      setError("Invalid quote link. Please check the URL and try again.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await publicPlatformQuoteApi.getView(token);
      setQuote(data);
    } catch (err) {
      setError(err?.detail || err?.message || "Unable to load quote. The link may have expired or is invalid.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const handleAccept = useCallback(async () => {
    setActing(true);
    setActionError(null);
    try {
      const data = await publicPlatformQuoteApi.accept(token);
      setQuote(data);
    } catch (err) {
      setActionError(err?.detail || err?.message || "Unable to accept this quote. Please try again.");
    } finally {
      setActing(false);
    }
  }, [token]);

  const handleReject = useCallback(async () => {
    setActing(true);
    setActionError(null);
    try {
      const data = await publicPlatformQuoteApi.reject(token, rejectReason);
      setQuote(data);
      setShowRejectForm(false);
    } catch (err) {
      setActionError(err?.detail || err?.message || "Unable to reject this quote. Please try again.");
    } finally {
      setActing(false);
    }
  }, [token, rejectReason]);

  if (loading) {
    return (
      <div className="pquo-root">
        <div className="pquo-spinner-wrap"><div className="pquo-spinner" /></div>
        <style>{STYLES}</style>
      </div>
    );
  }

  if (error) {
    return (
      <div className="pquo-root">
        <div className="pquo-error-card">
          <span className="pquo-error-icon">⚠️</span>
          <h1 className="pquo-error-title">Quote Unavailable</h1>
          <p className="pquo-error-msg">{error}</p>
          <p className="pquo-error-help">If you believe this is a mistake, contact Zoiko Billing Accounts.</p>
        </div>
        <style>{STYLES}</style>
      </div>
    );
  }

  const currency = quote.currency;
  const status = (quote.status || "").toLowerCase();
  const canRespond = status === "sent";
  const items = Array.isArray(quote.items) ? quote.items : [];

  return (
    <div className="pquo-root">
      <div className="pquo-top-strip">
        <div className="pquo-brand">
          <span className="pquo-brand-icon">⚡</span>
          <span className="pquo-brand-name">Zoiko Billing Accounts</span>
        </div>
        <StatusBadge status={quote.status} />
      </div>

      <div className="pquo-content">
        <div className="pquo-hero">
          <p className="pquo-hero-eyebrow">Quote</p>
          <h1 className="pquo-hero-number">{quote.quote_number}</h1>
          {quote.subject && <p className="pquo-hero-subject">{quote.subject}</p>}
          <p className="pquo-hero-total">{fmtCcy(quote.total_amount, currency)}</p>
          {quote.valid_until && <p className="pquo-hero-valid">Valid until {fmtDate(quote.valid_until)}</p>}
        </div>

        <SectionCard title="What's Included" icon="📦">
          {items.length === 0 ? (
            <p className="pquo-empty-items">No line items on this quote.</p>
          ) : (
            <div className="pquo-table-wrap">
              <table className="pquo-table">
                <thead>
                  <tr>
                    <th className="pquo-th pquo-th--left">Description</th>
                    <th className="pquo-th pquo-th--right">Qty</th>
                    <th className="pquo-th pquo-th--right">Unit Price</th>
                    <th className="pquo-th pquo-th--right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.line_number} className="pquo-tr">
                      <td className="pquo-td">{item.description}</td>
                      <td className="pquo-td pquo-td--right pquo-mono">{item.quantity}</td>
                      <td className="pquo-td pquo-td--right pquo-mono">{fmtCcy(item.unit_price, currency)}</td>
                      <td className="pquo-td pquo-td--right pquo-td--bold pquo-mono">{fmtCcy(item.total, currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>

        <SectionCard title="Pricing Summary" icon="📊">
          <div className="pquo-fin-rows">
            <div className="pquo-fin-row"><span>Subtotal</span><span className="pquo-mono">{fmtCcy(quote.subtotal, currency)}</span></div>
            {Number(quote.discount_amount) > 0 && (
              <div className="pquo-fin-row"><span>Discount</span><span className="pquo-mono">-{fmtCcy(quote.discount_amount, currency)}</span></div>
            )}
            {Number(quote.tax_amount) > 0 && (
              <div className="pquo-fin-row"><span>Tax</span><span className="pquo-mono">{fmtCcy(quote.tax_amount, currency)}</span></div>
            )}
            <div className="pquo-fin-row pquo-fin-row--total"><span>Total</span><span className="pquo-mono">{fmtCcy(quote.total_amount, currency)}</span></div>
          </div>
        </SectionCard>

        {quote.terms && (
          <SectionCard title="Terms" icon="📄">
            <p className="pquo-notes">{quote.terms}</p>
          </SectionCard>
        )}

        {quote.notes && (
          <SectionCard title="Notes" icon="📝">
            <p className="pquo-notes">{quote.notes}</p>
          </SectionCard>
        )}

        {canRespond && (
          <SectionCard title="Your Response" icon="✍️">
            {actionError && <p className="pquo-action-error">{actionError}</p>}
            {!showRejectForm ? (
              <>
                <div className="pquo-action-row">
                  <button type="button" className="pquo-btn pquo-btn--accept" disabled={acting} onClick={handleAccept}>
                    {acting ? "Working…" : "Approve Quote"}
                  </button>
                  <button type="button" className="pquo-btn pquo-btn--reject" disabled={acting} onClick={() => setShowRejectForm(true)}>
                    Reject Quote
                  </button>
                </div>
                <p className="pquo-action-hint">Approving generates your invoice immediately — we'll email it to you right away.</p>
              </>
            ) : (
              <div className="pquo-reject-form">
                <label className="pquo-reject-label" htmlFor="pquo-reject-reason">Reason (optional)</label>
                <textarea
                  id="pquo-reject-reason"
                  className="pquo-reject-textarea"
                  rows={3}
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="Let us know why — optional"
                />
                <div className="pquo-action-row">
                  <button type="button" className="pquo-btn pquo-btn--reject" disabled={acting} onClick={handleReject}>
                    {acting ? "Working…" : "Confirm Rejection"}
                  </button>
                  <button type="button" className="pquo-btn pquo-btn--ghost" disabled={acting} onClick={() => setShowRejectForm(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </SectionCard>
        )}

        {status === "accepted" && (
          <div className="pquo-status-banner pquo-status-banner--accepted">
            <span>✅</span>
            <p>You've approved this quote. Your invoice has been generated and emailed to your organization's admin.</p>
          </div>
        )}
        {status === "rejected" && (
          <div className="pquo-status-banner pquo-status-banner--rejected">
            <span>✕</span>
            <p>This quote has been rejected.</p>
          </div>
        )}
        {status === "expired" && (
          <div className="pquo-status-banner pquo-status-banner--expired">
            <span>⏱</span>
            <p>This quote has expired. Contact Zoiko Billing Accounts for a new one.</p>
          </div>
        )}
        {status === "converted" && (
          <div className="pquo-status-banner pquo-status-banner--accepted">
            <span>📄</span>
            <p>This quote has been converted to an invoice.</p>
          </div>
        )}

        <div className="pquo-page-footer">
          <p>Sent by Zoiko Billing Accounts</p>
        </div>
      </div>
      <style>{STYLES}</style>
    </div>
  );
}

const STYLES = `
  .pquo-root { min-height: 100vh; background: linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%); font-family: 'Inter', 'Segoe UI', system-ui, sans-serif; color: #e2e8f0; padding-bottom: 3rem; }
  .pquo-spinner-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; }
  .pquo-spinner { width: 3rem; height: 3rem; border-radius: 50%; border: 3px solid rgba(59,130,246,0.2); border-top-color: #3b82f6; animation: pquo-spin 0.8s linear infinite; }
  @keyframes pquo-spin { to { transform: rotate(360deg); } }
  .pquo-top-strip { background: rgba(15,23,42,0.95); border-bottom: 1px solid rgba(255,255,255,0.06); padding: 1rem 2rem; display: flex; align-items: center; justify-content: space-between; position: sticky; top: 0; z-index: 50; backdrop-filter: blur(12px); }
  .pquo-brand { display: flex; align-items: center; gap: 0.5rem; font-weight: 700; font-size: 1rem; }
  .pquo-brand-name { background: linear-gradient(90deg, #3b82f6, #7c3aed); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
  .pquo-badge { font-size: 0.7rem; font-weight: 700; letter-spacing: 0.05em; padding: 0.3rem 0.85rem; border-radius: 999px; }
  .pquo-content { max-width: 900px; margin: 0 auto; padding: 2rem 1rem; display: flex; flex-direction: column; gap: 1.5rem; }
  .pquo-hero { text-align: center; background: linear-gradient(135deg, rgba(30,41,59,0.9), rgba(15,23,42,0.9)); border: 1px solid rgba(255,255,255,0.08); border-radius: 1.25rem; padding: 2.5rem 2rem; }
  .pquo-hero-eyebrow { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.15em; color: #3b82f6; margin-bottom: 0.5rem; }
  .pquo-hero-number { font-size: 1.75rem; font-weight: 800; color: #f8fafc; margin: 0 0 0.5rem; }
  .pquo-hero-subject { font-size: 1rem; color: #cbd5e1; margin-bottom: 1rem; }
  .pquo-hero-total { font-size: 2.5rem; font-weight: 800; color: #f8fafc; margin: 0.5rem 0; }
  .pquo-hero-valid { font-size: 0.8rem; color: #94a3b8; }
  .pquo-card { background: rgba(30,41,59,0.7); border: 1px solid rgba(255,255,255,0.07); border-radius: 1.25rem; padding: 1.75rem; }
  .pquo-card-header { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 1.25rem; border-bottom: 1px solid rgba(255,255,255,0.06); padding-bottom: 1rem; }
  .pquo-card-title { font-size: 1rem; font-weight: 700; color: #f8fafc; margin: 0; }
  .pquo-table-wrap { overflow-x: auto; }
  .pquo-table { width: 100%; border-collapse: separate; border-spacing: 0; min-width: 520px; }
  .pquo-th { font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #64748b; padding: 0.75rem 0.5rem; border-bottom: 1px solid rgba(255,255,255,0.07); }
  .pquo-th--left { text-align: left; }
  .pquo-th--right { text-align: right; }
  .pquo-tr:not(:last-child) .pquo-td { border-bottom: 1px solid rgba(255,255,255,0.04); }
  .pquo-td { padding: 0.85rem 0.5rem; font-size: 0.85rem; color: #e2e8f0; }
  .pquo-td--right { text-align: right; }
  .pquo-td--bold { font-weight: 700; color: #f8fafc; }
  .pquo-mono { font-family: 'JetBrains Mono', 'Fira Mono', monospace; font-size: 0.82rem; }
  .pquo-empty-items { color: #64748b; font-size: 0.9rem; text-align: center; padding: 1.5rem 0; }
  .pquo-fin-rows { display: flex; flex-direction: column; gap: 0.6rem; }
  .pquo-fin-row { display: flex; justify-content: space-between; font-size: 0.85rem; color: #94a3b8; padding: 0.5rem 0; border-bottom: 1px solid rgba(255,255,255,0.04); }
  .pquo-fin-row--total { color: #f8fafc; font-weight: 700; font-size: 0.95rem; border-top: 2px solid rgba(255,255,255,0.1); border-bottom: none; padding-top: 0.75rem; margin-top: 0.25rem; }
  .pquo-notes { font-size: 0.88rem; color: #94a3b8; line-height: 1.7; white-space: pre-wrap; margin: 0; }
  .pquo-action-error { font-size: 0.85rem; color: #f87171; margin: 0 0 1rem; }
  .pquo-action-row { display: flex; gap: 0.75rem; flex-wrap: wrap; }
  .pquo-action-hint { font-size: 0.78rem; color: #64748b; margin: 0.85rem 0 0; }
  .pquo-btn { padding: 0.75rem 1.5rem; border-radius: 0.75rem; font-size: 0.9rem; font-weight: 700; border: none; cursor: pointer; transition: all 0.15s; }
  .pquo-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .pquo-btn--accept { background: linear-gradient(135deg, #10b981, #34d399); color: #052e1f; }
  .pquo-btn--accept:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(16,185,129,0.3); }
  .pquo-btn--reject { background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.4); color: #fca5a5; }
  .pquo-btn--reject:hover:not(:disabled) { background: rgba(239,68,68,0.25); }
  .pquo-btn--ghost { background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: #cbd5e1; }
  .pquo-reject-form { display: flex; flex-direction: column; gap: 0.75rem; }
  .pquo-reject-label { font-size: 0.78rem; color: #94a3b8; }
  .pquo-reject-textarea { width: 100%; padding: 0.75rem; border-radius: 0.6rem; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); color: #e2e8f0; font-family: inherit; font-size: 0.85rem; resize: vertical; }
  .pquo-status-banner { display: flex; align-items: center; gap: 1rem; padding: 1.25rem 1.75rem; border-radius: 1.25rem; }
  .pquo-status-banner--accepted { background: linear-gradient(135deg, rgba(16,185,129,0.1), rgba(5,150,105,0.08)); border: 1px solid rgba(16,185,129,0.25); }
  .pquo-status-banner--rejected { background: linear-gradient(135deg, rgba(239,68,68,0.1), rgba(220,38,38,0.08)); border: 1px solid rgba(239,68,68,0.25); }
  .pquo-status-banner--expired { background: linear-gradient(135deg, rgba(245,158,11,0.1), rgba(217,119,6,0.08)); border: 1px solid rgba(245,158,11,0.25); }
  .pquo-status-banner p { margin: 0; font-size: 0.9rem; color: #e2e8f0; }
  .pquo-error-card { max-width: 480px; margin: 8rem auto; text-align: center; padding: 2.5rem; background: rgba(30,41,59,0.8); border: 1px solid rgba(239,68,68,0.2); border-radius: 1.25rem; }
  .pquo-error-icon { font-size: 3rem; display: block; margin-bottom: 1rem; }
  .pquo-error-title { font-size: 1.25rem; font-weight: 700; color: #f8fafc; margin-bottom: 0.75rem; }
  .pquo-error-msg { font-size: 0.9rem; color: #f87171; margin-bottom: 1rem; }
  .pquo-error-help { font-size: 0.82rem; color: #64748b; }
  .pquo-page-footer { text-align: center; padding: 1rem 0; font-size: 0.78rem; color: #334155; border-top: 1px solid rgba(255,255,255,0.04); }
`;
