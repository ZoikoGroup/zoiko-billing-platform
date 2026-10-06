import { X } from "lucide-react";

// Visible, removable chips for the URL-driven list filters (useListUrlFilters)
// that have no dropdown of their own, so a filter applied by a dashboard link
// is never silently in effect.
function Chip({ label, onRemove }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-brand-200 bg-brand-50 px-2.5 py-1 text-xs font-medium text-brand-700">
      {label}
      <button type="button" onClick={onRemove} aria-label={`Remove filter: ${label}`}
        className="rounded-full p-0.5 hover:bg-brand-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/40">
        <X size={12} />
      </button>
    </span>
  );
}

export default function ActiveUrlFilterChips({ expiringDays, onClearExpiring, allDates, onClearAllDates }) {
  if (!expiringDays && !allDates) return null;
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="Active filters">
      {expiringDays && <Chip label={`Expiring within ${expiringDays} days`} onRemove={onClearExpiring} />}
      {allDates && <Chip label="All dates (date range not applied)" onRemove={onClearAllDates} />}
    </div>
  );
}
