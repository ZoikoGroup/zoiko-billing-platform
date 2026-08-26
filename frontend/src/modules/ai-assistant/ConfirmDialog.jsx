/**
 * modules/ai-assistant/ConfirmDialog.jsx
 * --------------------------------------
 * Explicit confirmation dialog for governed financial actions.
 * Requires deliberate user action — no accidental execution.
 * §8.3: Confirm button restates action + material value, never bare "Confirm".
 * §8.3: High-risk actions cannot use generic "Yes" — button restates full intent.
 */

import { useState } from "react";
import { Shield, AlertTriangle, X } from "lucide-react";

export default function ConfirmDialog({ preview, onConfirm, onCancel }) {
  const [acknowledged, setAcknowledged] = useState(false);

  if (!preview) return null;

  const pc = preview.preview_card || {};
  const money = pc.money || preview.money_summary || {};
  const customer = pc.customer || {};
  const actionLabel = pc.action_label || "Financial action";
  const riskDescription = pc.risk_description || "";
  const confirmLabel = preview.confirm_label || "Confirm action";
  const approval = pc.approval || {};

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Confirm financial action"
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onCancel} />

      {/* Dialog */}
      <div className="relative bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 bg-slate-900 text-white flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield size={18} />
            <h3 className="text-sm font-semibold">{actionLabel}</h3>
          </div>
          <button
            onClick={onCancel}
            className="p-1 rounded hover:bg-white/10 transition-colors"
            aria-label="Cancel"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4">
          <p className="text-sm text-slate-600">
            You are about to execute a <strong>financial action</strong>. This cannot be undone
            from the chat interface.
          </p>

          {/* Risk description (§8.2 element 2 — text, not colour) */}
          {riskDescription && (
            <div className="flex items-start gap-2 text-xs text-slate-500">
              <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
              <span>{riskDescription}</span>
            </div>
          )}

          {/* Summary */}
          <div className="bg-slate-50 rounded-lg p-4 space-y-2 text-sm">
            {customer.name && (
              <div className="flex justify-between">
                <span className="text-slate-500">Customer</span>
                <span className="font-medium">{customer.name}</span>
              </div>
            )}
            {money.total && (
              <div className="flex justify-between">
                <span className="text-slate-500">Total</span>
                <span className="font-bold text-base" style={{ color: "var(--ab-accent-text, #F5841F)" }}>
                  {money.display || `${money.currency || ""} ${Number(money.total).toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
                </span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-slate-500">Action</span>
              <span className="font-medium">{actionLabel}</span>
            </div>
          </div>

          {/* Approval notice */}
          {approval.required && (
            <div className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg bg-orange-50 text-orange-800 border border-orange-200">
              <AlertTriangle size={12} className="flex-shrink-0" />
              <span>
                This action requires approval from <strong>{approval.role || "a manager"}</strong> before execution.
              </span>
            </div>
          )}

          {/* Acknowledgment */}
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5 rounded border-slate-300 focus:ring-brand"
              style={{ accentColor: "var(--ab-accent, #F5841F)" }}
            />
            <span className="text-xs text-slate-600">
              I have reviewed the preview and confirm this action is correct. I understand this
              will be executed through the canonical billing service.
            </span>
          </label>
        </div>

        {/* Footer — §8.3: button restates action + material value */}
        <div className="px-6 py-4 bg-slate-50 border-t border-slate-200 flex items-center justify-end gap-3">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-200 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(preview)}
            disabled={!acknowledged}
            className="px-6 py-2 text-sm font-semibold text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: "var(--ab-accent, #F5841F)" }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
