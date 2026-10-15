import React from "react";
import { Link } from "react-router-dom";
import { ShieldCheck } from "lucide-react";

/**
 * Shared presentation helpers for the per-tenant, privacy-preserving
 * Super Admin read models (ZB-SEC-PRIV-001).
 *
 * The platform API returns ONE ROW PER TENANT with counts and per-currency
 * totals only — never customer names or record numbers. Any count or amount
 * that would reveal an individual record (fewer than 5 records) is masked by
 * the backend as `count: null` / `amount: null` (+ `count_label:
 * "fewer than 5"`); every masked value renders through <MaskedValue>.
 */

export const MASKED_LABEL = "fewer than 5";
export const MASKED_TOOLTIP = "Counts under 5 are hidden to protect individual customers' privacy";
export const SUPPORT_ACCESS_PATH = "/super-admin/support-access";

/** True when a scalar count/amount is masked (the backend sends null). */
export function isMasked(value) {
  return value === null || value === undefined;
}

/** Rows array from any of the list envelopes (`items` | `rows` | `invoices`). */
export function rowsOf(resp) {
  if (!resp) return [];
  return resp.items || resp.rows || resp.invoices || [];
}

/** Tenant detail route for a row (the only drill-down a platform row has). */
export function tenantPath(organizationId) {
  return `/super-admin/organizations/${organizationId}`;
}

/** Masked marker with the privacy tooltip. */
export function MaskedBadge({ label }) {
  return (
    <span
      className="cursor-help whitespace-nowrap text-[11px] italic text-slate-400"
      title={MASKED_TOOLTIP}
      data-testid="masked-value"
    >
      {label || MASKED_LABEL}
    </span>
  );
}

/**
 * Renders `children` (or `value`) unless the value is masked, in which case it
 * renders the "fewer than 5" marker with its tooltip. `label` is the sibling
 * `<field>_label` the backend sends next to a masked scalar count.
 */
export function MaskedValue({ value, label, children }) {
  if (isMasked(value)) return <MaskedBadge label={label} />;
  return <>{children !== undefined ? children : String(value)}</>;
}

/** A count cell `{count, count_label}` (also accepts a bare number). */
export function CountCellValue({ cell }) {
  if (typeof cell === "number") return <>{cell}</>;
  return <MaskedValue value={cell?.count} label={cell?.count_label} />;
}

/**
 * Renders a per-currency map ({USD: {count, count_label, amount}}) one
 * currency per line. Totals are never summed across currencies. A cell whose
 * amount is null is masked (fewer than 5 records behind it).
 */
export function CurrencyTotals({ totals, format }) {
  const entries = totals && typeof totals === "object" ? Object.entries(totals) : [];
  if (entries.length === 0) return <span className="text-slate-400">—</span>;
  const fmt =
    format ||
    ((v) =>
      new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
        parseFloat(v)
      ));
  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      {entries.map(([currency, cell]) => {
        const amount = cell && typeof cell === "object" ? cell.amount : cell;
        return (
          <span key={currency} className="whitespace-nowrap">
            {isMasked(amount) ? (
              <MaskedBadge label={cell?.count_label} />
            ) : (
              <span className="font-semibold text-slate-800">{fmt(amount)}</span>
            )}{" "}
            <span className="text-[10px] font-normal text-slate-400">{currency}</span>
          </span>
        );
      })}
    </span>
  );
}

/**
 * Renders a map of category -> count cell ({stage_1: {count, count_label}})
 * as small chips. Masked counts render the masked marker.
 */
export function CountChips({ counts, labelFor }) {
  const entries = counts && typeof counts === "object" ? Object.entries(counts) : [];
  if (entries.length === 0) return <span className="text-slate-400">—</span>;
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {entries.map(([key, cell]) => (
        <span
          key={key}
          className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px]"
        >
          <span className="capitalize text-slate-600">
            {labelFor ? labelFor(key) : String(key).replaceAll("_", " ")}
          </span>
          <span className="font-semibold text-slate-700">
            <CountCellValue cell={cell} />
          </span>
        </span>
      ))}
    </span>
  );
}

/** Tenant name cell linking to the tenant page. */
export function OrganizationLink({ organizationId, name }) {
  const label = name || `Organization ${organizationId}`;
  if (organizationId === null || organizationId === undefined) {
    return <span className="font-medium text-slate-800">{label}</span>;
  }
  return (
    <Link
      to={tenantPath(organizationId)}
      className="font-medium text-brand-600 hover:underline"
      onClick={(e) => e.stopPropagation()}
    >
      {label}
    </Link>
  );
}

/** The one short note shown under every per-tenant aggregate table. */
export function SupportAccessNote({ className = "" }) {
  return (
    <p
      className={`mt-3 flex items-center gap-1.5 text-[11px] text-slate-500 ${className}`}
      data-testid="support-access-note"
    >
      <ShieldCheck size={12} className="shrink-0 text-slate-400" aria-hidden="true" />
      <span>
        Record-level detail requires{" "}
        <Link to={SUPPORT_ACCESS_PATH} className="font-medium text-brand-600 hover:underline">
          approved support access
        </Link>
      </span>
    </p>
  );
}

/** Failure-reason categories for a tenant: [{reason, count, count_label}]. */
export function ReasonList({ reasons }) {
  const items = Array.isArray(reasons) ? reasons : [];
  if (items.length === 0) return <span className="text-slate-400">—</span>;
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {items.map((it) => (
        <span
          key={it.reason}
          className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-600"
        >
          {String(it.reason).replaceAll("_", " ")}
          <span className="font-semibold text-slate-700">
            <MaskedValue value={it.count} label={it.count_label} />
          </span>
        </span>
      ))}
    </span>
  );
}
