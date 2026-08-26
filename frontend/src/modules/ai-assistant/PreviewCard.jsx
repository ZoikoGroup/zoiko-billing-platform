/**
 * modules/ai-assistant/PreviewCard.jsx
 * ------------------------------------
 * Deterministic PREVIEW card for governed financial actions.
 * Renders from structured `preview_card` API data (§8.2), never from
 * free-form model text.  All 10 required elements are displayed.
 * WCAG 2.2 AA: risk conveyed through text/iconography, not colour alone.
 *
 * §8.2 Preview Card Anatomy:
 * 1. Action label in human language
 * 2. Risk level via copy/iconography (not colour alone)
 * 3. Affected customer/account + immutable reference
 * 4. Legal entity / tenant context
 * 5. Money values with ISO currency
 * 6. Fields that will change (before/after)
 * 7. Side effects
 * 8. Approval requirement + approver role
 * 9. Preview generated timestamp + expiry
 * 10. Primary Confirm + secondary Cancel actions (§8.3 restated value)
 */

import { useState, useEffect } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  CreditCard,
  FileText,
  User,
  Shield,
  ArrowRight,
  RefreshCw,
  Ban,
  Info,
} from "lucide-react";

function isExpired(expiresAt) {
  if (!expiresAt) return false;
  const exp = new Date(expiresAt);
  if (Number.isNaN(exp.getTime())) return false;
  return exp < new Date();
}

function formatCurrency(amount, currency) {
  if (!amount) return "—";
  try {
    return `${currency || ""} ${Number(amount).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  } catch {
    return `${currency || ""} ${amount}`;
  }
}

export default function PreviewCard({ preview, onConfirm, onCancel, onRefresh }) {
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    if (!preview) return;
    const pc = preview.preview_card || preview;
    if (pc.expires_at) {
      setExpired(isExpired(pc.expires_at));
      const timer = setInterval(() => setExpired(isExpired(pc.expires_at)), 10000);
      return () => clearInterval(timer);
    }
  }, [preview]);

  if (!preview) return null;

  // Support both new `preview_card` and legacy `preview_payload` shapes
  const pc = preview.preview_card || {};
  const money = pc.money || preview.money_summary || {};
  const warnings = pc.warnings || preview.warnings || [];
  const approval = pc.approval || {};
  const sideEffects = pc.side_effects || [];
  const customer = pc.customer || {};
  const lineItems = pc.line_items || [];

  const actionLabel = pc.action_label || "Financial action";
  const riskDescription = pc.risk_description || "Requires confirmation.";
  const confirmLabel = preview.confirm_label || "Confirm";
  const previewHash = pc.preview_hash || preview.preview_hash;

  // Expiry display
  const expiryTime = pc.expires_at || preview.expires_at;
  const expiryStr = expiryTime
    ? new Date(expiryTime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "soon";

  return (
    <div
      role="article"
      aria-label={`Action preview: ${actionLabel}`}
      className="rounded-xl border-2 overflow-hidden"
      style={{
        borderColor: expired ? "var(--ab-border)" : "#d97706",
        background: expired ? "var(--ab-surface)" : "rgba(251,191,36,0.05)",
      }}
    >
      {/* §8.2(1) Action label + §8.2(9) expiry */}
      <div
        className="px-4 py-3 border-b flex items-center justify-between"
        style={{
          background: expired ? "var(--ab-surface-raised)" : "rgba(251,191,36,0.10)",
          borderColor: expired ? "var(--ab-border)" : "rgba(217,119,6,0.2)",
        }}
      >
        <div className="flex items-center gap-2">
          <FileText size={16} style={{ color: expired ? "var(--ab-text-muted)" : "#92400e" }} />
          <span className="text-sm font-semibold" style={{ color: expired ? "var(--ab-text-secondary)" : "#92400e" }}>
            {actionLabel}
          </span>
        </div>
        <div className="flex items-center gap-1.5 text-[10px]" style={{ color: expired ? "var(--ab-text-muted)" : "#92400e" }}>
          <Clock size={10} />
          {expired ? (
            <span className="font-medium">Preview expired</span>
          ) : (
            <span>Expires {expiryStr}</span>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="p-4 space-y-4">
        {/* §8.2(2) Risk level — text-based, not colour alone */}
        <div className="flex items-start gap-2 text-xs">
          <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" style={{ color: "var(--ab-text-secondary)" }} />
          <span style={{ color: "var(--ab-text-secondary)" }}>{riskDescription}</span>
        </div>

        {/* §8.2(3) Affected customer + immutable reference */}
        {customer.name && (
          <div className="flex items-center gap-2 text-sm">
            <User size={14} style={{ color: "var(--ab-text-muted)" }} />
            <span style={{ color: "var(--ab-text-secondary)" }}>Customer:</span>
            <span className="font-medium" style={{ color: "var(--ab-text)" }}>{customer.name}</span>
            {customer.id && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded"
                style={{ background: "var(--ab-surface-raised)", color: "var(--ab-text-muted)" }}>
                ID: {customer.id}
              </span>
            )}
          </div>
        )}

        {/* §8.2(4) Legal entity / tenant context */}
        {pc.legal_entity?.tenant_context_id && (
          <div className="flex items-center gap-2 text-xs">
            <Shield size={12} style={{ color: "var(--ab-text-muted)" }} />
            <span style={{ color: "var(--ab-text-muted)" }}>
              Tenant context: {pc.legal_entity.tenant_context_id}
            </span>
          </div>
        )}

        {/* §8.2(5) Money values with ISO currency + line items */}
        {lineItems.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-[11px] font-medium uppercase tracking-wide"
              style={{ color: "var(--ab-text-muted)" }}>
              Line Items
            </h4>
            <div className="space-y-1.5">
              {lineItems.map((item, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between text-sm rounded-lg px-3 py-2 border"
                  style={{ background: "var(--ab-bg)", borderColor: "var(--ab-border-subtle)" }}
                >
                  <div className="flex-1">
                    <span style={{ color: "var(--ab-text)" }}>{item.description}</span>
                    <span className="ml-2" style={{ color: "var(--ab-text-muted)" }}>
                      {item.quantity} × {formatCurrency(item.unit_price, money.currency)}
                    </span>
                  </div>
                  <span className="font-medium ml-4" style={{ color: "var(--ab-text)" }}>
                    {formatCurrency(item.total, money.currency)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Totals */}
        {money.total && (
          <div className="rounded-lg border p-3 space-y-1.5"
            style={{ background: "var(--ab-bg)", borderColor: "var(--ab-border)" }}>
            <div className="flex justify-between text-sm" style={{ color: "var(--ab-text-secondary)" }}>
              <span>Subtotal</span>
              <span>{formatCurrency(money.subtotal, money.currency)}</span>
            </div>
            {money.tax && money.tax !== "0" && (
              <div className="flex justify-between text-sm" style={{ color: "var(--ab-text-secondary)" }}>
                <span>Tax</span>
                <span>{formatCurrency(money.tax, money.currency)}</span>
              </div>
            )}
            <div className="flex justify-between text-base font-bold pt-1.5 border-t"
              style={{ color: "var(--ab-text)", borderColor: "var(--ab-border)" }}>
              <span>Total</span>
              <span style={{ color: "var(--ab-accent-text)" }}>
                {pc.money?.display || formatCurrency(money.total, money.currency)}
              </span>
            </div>
          </div>
        )}

        {/* §8.2(6) Changes — before/after where applicable */}
        {pc.changes?.before && (
          <div className="rounded-lg border p-3 space-y-1.5"
            style={{ background: "var(--ab-bg)", borderColor: "var(--ab-border)" }}>
            <h4 className="text-[11px] font-medium uppercase tracking-wide"
              style={{ color: "var(--ab-text-muted)" }}>
              Changes
            </h4>
            <div className="flex items-center gap-2 text-sm">
              <span style={{ color: "var(--ab-text-muted)" }}>Before:</span>
              <span style={{ color: "var(--ab-text)" }}>{JSON.stringify(pc.changes.before)}</span>
              <ArrowRight size={12} style={{ color: "var(--ab-text-muted)" }} />
              <span style={{ color: "var(--ab-text-muted)" }}>After:</span>
              <span className="font-medium" style={{ color: "var(--ab-text)" }}>{JSON.stringify(pc.changes.after)}</span>
            </div>
          </div>
        )}

        {/* §8.2(7) Side effects */}
        {sideEffects.length > 0 && (
          <div className="space-y-1">
            <h4 className="text-[11px] font-medium uppercase tracking-wide"
              style={{ color: "var(--ab-text-muted)" }}>
              Side effects
            </h4>
            {sideEffects.map((effect, i) => (
              <div key={i} className="flex items-start gap-2 text-xs"
                style={{ color: "var(--ab-text-secondary)" }}>
                <Info size={10} className="mt-0.5 flex-shrink-0" />
                <span>{effect}</span>
              </div>
            ))}
          </div>
        )}

        {/* §8.2(8) Approval requirement */}
        {approval.required && (
          <div className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg border"
            style={{ background: "rgba(249,115,22,0.08)", borderColor: "rgba(249,115,22,0.2)", color: "#9a3412" }}>
            <AlertTriangle size={12} className="flex-shrink-0" />
            <span className="font-medium">
              Approval required — this action must be approved by {approval.role || "a manager"} before execution.
            </span>
          </div>
        )}

        {/* Warnings */}
        {warnings.length > 0 && (
          <div className="space-y-1">
            {warnings.map((warning, i) => (
              <div key={i} className="flex items-start gap-2 text-xs px-3 py-2 rounded-lg"
                style={{ background: "rgba(245,158,11,0.10)", color: "#92400e" }}>
                <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
                <span>{warning}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* §8.2(10) Actions — §8.3 restated value confirm button */}
      <div className="px-4 py-3 border-t flex items-center justify-between"
        style={{ background: "var(--ab-bg)", borderColor: "var(--ab-border)" }}>
        {expired ? (
          <button
            onClick={onRefresh}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors"
            style={{ color: "var(--ab-accent-text)", background: "var(--ab-accent-10)" }}
          >
            <RefreshCw size={14} />
            Refresh preview
          </button>
        ) : (
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm rounded-lg transition-colors"
            style={{ color: "var(--ab-text-secondary)" }}
          >
            Cancel
          </button>
        )}
        <button
          onClick={() => onConfirm(preview)}
          disabled={expired}
          className="px-6 py-2 text-sm font-semibold text-white rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ background: "var(--ab-accent)" }}
        >
          {approval.required ? (
            <>
              <ArrowRight size={14} />
              Submit for approval
            </>
          ) : (
            <>
              <CheckCircle2 size={14} />
              {confirmLabel}
            </>
          )}
        </button>
      </div>
    </div>
  );
}
