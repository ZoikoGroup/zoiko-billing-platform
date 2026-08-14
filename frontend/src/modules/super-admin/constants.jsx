import { StatusBadge } from "../../components/billing-shared";

/**
 * Shared Super Admin commercial-plane presentation constants.
 * Labels/colors only — no business values are invented here.
 */

export const PAGE_SIZE = 20;

export const COMMERCIAL_SOURCE_OPTIONS = [
  { value: "registered_via_standalone", label: "Registered via Standalone" },
  { value: "registered_via_zoiko_one", label: "Registered via Zoiko One" },
];

export const COMMERCIAL_CLASSIFICATION_OPTIONS = [
  { value: "commercial_standalone", label: "Commercial Standalone" },
  { value: "commercial_zoiko_one", label: "Commercial Zoiko One" },
];

export const COMMERCIAL_SOURCE_BADGES = {
  registered_via_standalone: { label: "Standalone", color: "bg-brand-100 text-brand-700" },
  registered_via_zoiko_one: { label: "Zoiko One", color: "bg-indigo-100 text-indigo-700" },
};

export const COMMERCIAL_CLASSIFICATION_BADGES = {
  commercial_standalone: { label: "Standalone", color: "bg-brand-100 text-brand-700" },
  commercial_zoiko_one: { label: "Zoiko One", color: "bg-indigo-100 text-indigo-700" },
};

export const ACCOUNT_STATUS_OPTIONS = [
  { value: "active", label: "Active", color: "bg-emerald-100 text-emerald-700" },
  { value: "suspended", label: "Suspended", color: "bg-amber-100 text-amber-700" },
];

export const PLAN_STATUS_OPTIONS = [
  { value: "active", label: "Active", color: "bg-emerald-100 text-emerald-700" },
  { value: "inactive", label: "Inactive", color: "bg-amber-100 text-amber-700" },
  { value: "archived", label: "Archived", color: "bg-slate-100 text-slate-600" },
];

export const SUBSCRIPTION_STATUS_OPTIONS = [
  { value: "pending", label: "Pending", color: "bg-amber-100 text-amber-700" },
  { value: "active", label: "Active", color: "bg-emerald-100 text-emerald-700" },
  { value: "suspended", label: "Suspended", color: "bg-slate-100 text-slate-600" },
  { value: "cancelled", label: "Cancelled", color: "bg-red-100 text-red-700" },
  { value: "expired", label: "Expired", color: "bg-slate-100 text-slate-600" },
];

export const BILLING_INTERVAL_OPTIONS = [
  { value: "monthly", label: "Monthly" },
  { value: "annual", label: "Annual" },
];

// ── Platform audit log presentation (PHASE 11) ────────────────────────────
// Mirrors the backend PlatformAuditAction enum — labels/colors only.

export const AUDIT_ACTION_OPTIONS = [
  { value: "create", label: "Create" },
  { value: "update", label: "Update" },
  { value: "activate", label: "Activate" },
  { value: "deactivate", label: "Deactivate" },
  { value: "set_default", label: "Set Default" },
  { value: "clear_default", label: "Clear Default" },
  { value: "archive", label: "Archive" },
];

export const AUDIT_ACTION_BADGES = {
  create: { label: "Create", color: "bg-emerald-100 text-emerald-700" },
  update: { label: "Update", color: "bg-blue-100 text-blue-700" },
  activate: { label: "Activate", color: "bg-green-100 text-green-700" },
  deactivate: { label: "Deactivate", color: "bg-amber-100 text-amber-700" },
  set_default: { label: "Set Default", color: "bg-indigo-100 text-indigo-700" },
  clear_default: { label: "Clear Default", color: "bg-slate-100 text-slate-600" },
  archive: { label: "Archive", color: "bg-red-100 text-red-700" },
};

// Entity types currently recorded on the platform-plane audit trail.
export const AUDIT_ENTITY_OPTIONS = [
  { value: "CommercialPlan", label: "Commercial Plan" },
];

export function AuditActionBadge({ value }) {
  const option = AUDIT_ACTION_BADGES[value] || {};
  return (
    <StatusBadge
      status={value}
      options={[{ value, ...option }]}
      fallbackColor="bg-slate-100 text-slate-600"
    />
  );
}

/**
 * Allowed subscription lifecycle transitions — mirrors the backend state
 * machine in modules/commercial/service.py. Used only to render which
 * actions make sense; the backend remains the single source of truth and
 * surfaces its own errors on illegal transitions.
 */
export const SUBSCRIPTION_TRANSITIONS = {
  pending: ["active", "cancelled"],
  active: ["suspended", "cancelled", "expired"],
  suspended: ["active", "cancelled"],
  cancelled: [],
  expired: [],
};

/**
 * Display helpers
 */
export function formatDateTime(value) {
  if (value === null || value === undefined || value === "") return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDateOnly(value) {
  if (value === null || value === undefined || value === "") return "—";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}

export function displayValue(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") return value.toLocaleString();
  return String(value);
}

export function formatFeatureList(features) {
  if (!features) return null;
  if (Array.isArray(features)) return features;
  if (typeof features === "object") {
    return Object.entries(features).map(([key, value]) => ({ key, value }));
  }
  return null;
}

export function CommercialSourceBadge({ value }) {
  const option = COMMERCIAL_SOURCE_BADGES[value];
  return <StatusBadge status={value} options={[{ value, ...(option || {}) }]} fallbackColor="bg-slate-100 text-slate-600" />;
}

export function CommercialClassificationBadge({ value }) {
  const option = COMMERCIAL_CLASSIFICATION_BADGES[value];
  return <StatusBadge status={value} options={[{ value, ...(option || {}) }]} fallbackColor="bg-slate-100 text-slate-600" />;
}
