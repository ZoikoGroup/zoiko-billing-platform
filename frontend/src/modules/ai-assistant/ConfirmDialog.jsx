/**
 * modules/ai-assistant/ConfirmDialog.jsx
 * --------------------------------------
 * Explicit confirmation dialog for governed financial actions.
 * Requires deliberate user action — no accidental execution.
 * Preview hash is echoed back for server-side binding.
 */

import { useState } from "react";
import { Shield, AlertTriangle, X } from "lucide-react";

export default function ConfirmDialog({ preview, onConfirm, onCancel }) {
  const [acknowledged, setAcknowledged] = useState(false);

  if (!preview) return null;

  const payload = preview.preview_payload || {};
  const moneySummary = preview.money_summary || {};

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
            <h3 className="text-sm font-semibold">Confirm Action</h3>
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

          {/* Summary */}
          <div className="bg-slate-50 rounded-lg p-4 space-y-2 text-sm">
            {payload.customer_name && (
              <div className="flex justify-between">
                <span className="text-slate-500">Customer</span>
                <span className="font-medium">{payload.customer_name}</span>
              </div>
            )}
            {moneySummary.total && (
              <div className="flex justify-between">
                <span className="text-slate-500">Total</span>
                <span className="font-bold text-brand text-base">
                  {moneySummary.currency} {Number(moneySummary.total).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-slate-500">Action</span>
              <span className="font-medium">{payload.action_type?.replace(/_/g, " ")}</span>
            </div>
          </div>

          {/* Acknowledgment */}
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5 rounded border-slate-300 text-brand focus:ring-brand"
            />
            <span className="text-xs text-slate-600">
              I have reviewed the preview and confirm this action is correct. I understand this
              will be executed through the canonical billing service.
            </span>
          </label>
        </div>

        {/* Footer */}
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
            className="px-6 py-2 text-sm font-semibold text-white bg-brand hover:bg-brand-hover disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
          >
            Execute
          </button>
        </div>
      </div>
    </div>
  );
}
