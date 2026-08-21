/**
 * modules/ai-assistant/PreviewCard.jsx
 * ------------------------------------
 * Deterministic PREVIEW card for governed financial actions.
 * Renders from structured API data, never from free-form model text.
 * Money/currency/affected entity clearly shown, never color-only.
 * WCAG 2.2 AA: all information conveyed through text/icons, not color alone.
 */

import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  CreditCard,
  FileText,
  User,
  Calendar,
  ArrowRight,
} from "lucide-react";

export default function PreviewCard({ preview, onConfirm, onCancel }) {
  if (!preview) return null;

  const payload = preview.preview_payload || {};
  const moneySummary = preview.money_summary || {};
  const warnings = preview.warnings || [];
  const policy = preview.policy_result || {};

  return (
    <div
      role="article"
      aria-label={`Action preview: ${payload.action_type || "financial action"}`}
      className="rounded-xl border-2 border-amber-300 bg-amber-50/50 overflow-hidden"
    >
      {/* Header */}
      <div className="px-4 py-3 bg-amber-100 border-b border-amber-200 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText size={16} className="text-amber-700" />
          <span className="text-sm font-semibold text-amber-900">
            {payload.action_type === "invoice_draft"
              ? "Draft Invoice Preview"
              : "Action Preview"}
          </span>
        </div>
        <div className="flex items-center gap-1 text-[10px] text-amber-700">
          <Clock size={10} />
          <span>Expires {preview.expires_at ? new Date(preview.expires_at).toLocaleTimeString() : "soon"}</span>
        </div>
      </div>

      {/* Body */}
      <div className="p-4 space-y-4">
        {/* Affected entity */}
        {payload.customer_name && (
          <div className="flex items-center gap-2 text-sm">
            <User size={14} className="text-slate-500" />
            <span className="text-slate-600">Customer:</span>
            <span className="font-medium text-slate-900">{payload.customer_name}</span>
          </div>
        )}

        {/* Line items */}
        {payload.line_items && payload.line_items.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-xs font-medium text-slate-500 uppercase tracking-wide">
              Line Items
            </h4>
            <div className="space-y-1.5">
              {payload.line_items.map((item, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between text-sm bg-white rounded-lg px-3 py-2 border border-slate-100"
                >
                  <div className="flex-1">
                    <span className="text-slate-800">{item.description}</span>
                    <span className="text-slate-400 ml-2">
                      {item.quantity} × {payload.currency || ""} {Number(item.unit_price).toLocaleString()}
                    </span>
                  </div>
                  <span className="font-medium text-slate-900 ml-4">
                    {payload.currency || ""} {Number(item.total).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Totals */}
        {moneySummary.total && (
          <div className="bg-white rounded-lg border border-slate-200 p-3 space-y-1.5">
            <div className="flex justify-between text-sm text-slate-600">
              <span>Subtotal</span>
              <span>{moneySummary.currency} {Number(moneySummary.subtotal || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
            </div>
            {Number(moneySummary.tax || 0) > 0 && (
              <div className="flex justify-between text-sm text-slate-600">
                <span>Tax ({payload.tax_rate}%)</span>
                <span>{moneySummary.currency} {Number(moneySummary.tax).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
              </div>
            )}
            <div className="flex justify-between text-base font-bold text-slate-900 pt-1.5 border-t border-slate-200">
              <span>Total</span>
              <span className="text-brand">
                {moneySummary.currency} {Number(moneySummary.total).toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </span>
            </div>
          </div>
        )}

        {/* Policy result */}
        {policy.result && (
          <div className="flex items-center gap-2 text-xs">
            {policy.result === "APPROVAL_REQUIRED" ? (
              <>
                <AlertTriangle size={12} className="text-orange-600" />
                <span className="text-orange-700 font-medium">
                  Approval required — this action exceeds the auto-approve threshold
                </span>
              </>
            ) : policy.result === "CONFIRMATION_REQUIRED" ? (
              <>
                <CheckCircle2 size={12} className="text-blue-600" />
                <span className="text-blue-700 font-medium">
                  Confirmation required — please confirm to proceed
                </span>
              </>
            ) : (
              <>
                <CheckCircle2 size={12} className="text-emerald-600" />
                <span className="text-emerald-700 font-medium">
                  Ready to execute — low-risk action
                </span>
              </>
            )}
          </div>
        )}

        {/* Warnings */}
        {warnings.length > 0 && (
          <div className="space-y-1">
            {warnings.map((warning, i) => (
              <div
                key={i}
                className="flex items-start gap-2 text-xs text-amber-700 bg-amber-100 rounded-lg px-3 py-2"
              >
                <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
                <span>{warning}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="px-4 py-3 bg-white border-t border-slate-200 flex items-center justify-between">
        <button
          onClick={onCancel}
          className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800 hover:bg-slate-100 rounded-lg transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={() => onConfirm(preview)}
          className="px-6 py-2 text-sm font-semibold text-white bg-brand hover:bg-brand-hover rounded-lg transition-colors flex items-center gap-2"
        >
          {preview.requires_approval ? (
            <>
              <ArrowRight size={14} />
              Submit for Approval
            </>
          ) : (
            <>
              <CheckCircle2 size={14} />
              Confirm & Execute
            </>
          )}
        </button>
      </div>
    </div>
  );
}
