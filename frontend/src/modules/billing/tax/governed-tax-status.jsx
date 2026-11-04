import { CheckCircle, RefreshCw, Clock, Ban, AlertCircle, Lock } from "lucide-react";

// Governed tax (ZB-TAX-ARCH-001 §11.1): quote freshness is always shown as an
// icon AND a text label, never by colour alone (WCAG 2.2 AA, 1.4.1).
export const TAX_STATUS = {
  FRESH: { label: "Tax quote current", Icon: CheckCircle, tone: "bg-emerald-50 text-emerald-800 border-emerald-200" },
  STALE: { label: "Tax quote out of date", Icon: RefreshCw, tone: "bg-amber-50 text-amber-900 border-amber-200" },
  EXPIRED: { label: "Tax quote expired", Icon: Clock, tone: "bg-amber-50 text-amber-900 border-amber-200" },
  REFUSED: { label: "Tax not determined", Icon: Ban, tone: "bg-red-50 text-red-800 border-red-200" },
  NONE: { label: "No tax quote", Icon: AlertCircle, tone: "bg-slate-50 text-slate-800 border-slate-300" },
  COMMITTED: { label: "Tax locked at issue", Icon: Lock, tone: "bg-slate-50 text-slate-800 border-slate-300" },
};

export const OWNER_LABELS = {
  billing_admin: "Billing admin",
  org_admin: "Organization admin",
  finance_approver: "Finance approver",
  zoiko_tax_team: "Zoiko tax team",
};

export function TaxStatusBadge({ status }) {
  const meta = TAX_STATUS[status] || TAX_STATUS.NONE;
  const { Icon } = meta;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${meta.tone}`}
      data-tax-status={status}
    >
      <Icon size={14} aria-hidden="true" />
      <span>{meta.label}</span>
    </span>
  );
}
