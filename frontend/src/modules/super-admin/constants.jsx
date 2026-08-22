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

// ZB-COM-BILL-001 Table 9 — the full approved classification set. Only
// COMMERCIAL_STANDALONE may create a live standalone commercial charge; every
// other value is display/labels only here — the backend is the sole
// enforcement point (CommercialAccountService.can_charge).
export const COMMERCIAL_CLASSIFICATION_OPTIONS = [
  { value: "commercial_standalone", label: "Commercial Standalone" },
  { value: "commercial_zoiko_one", label: "Commercial Zoiko One" },
  { value: "legacy_migration", label: "Legacy Migration" },
  { value: "pilot_non_billable", label: "Pilot (Non-Billable)" },
  { value: "internal", label: "Internal" },
  { value: "demo", label: "Demo" },
  { value: "sandbox", label: "Sandbox" },
  { value: "qa_automation", label: "QA Automation" },
];

export const COMMERCIAL_SOURCE_BADGES = {
  registered_via_standalone: { label: "Standalone", color: "bg-brand-100 text-brand-700" },
  registered_via_zoiko_one: { label: "Zoiko One", color: "bg-indigo-100 text-indigo-700" },
};

export const COMMERCIAL_CLASSIFICATION_BADGES = {
  commercial_standalone: { label: "Standalone", color: "bg-emerald-100 text-emerald-700" },
  commercial_zoiko_one: { label: "Zoiko One", color: "bg-indigo-100 text-indigo-700" },
  legacy_migration: { label: "Legacy Migration", color: "bg-amber-100 text-amber-700" },
  pilot_non_billable: { label: "Pilot (Non-Billable)", color: "bg-amber-100 text-amber-700" },
  internal: { label: "Internal", color: "bg-slate-100 text-slate-600" },
  demo: { label: "Demo", color: "bg-slate-100 text-slate-600" },
  sandbox: { label: "Sandbox", color: "bg-slate-100 text-slate-600" },
  qa_automation: { label: "QA Automation", color: "bg-slate-100 text-slate-600" },
};

export const ACCOUNT_STATUS_OPTIONS = [
  { value: "active", label: "Active", color: "bg-emerald-100 text-emerald-700" },
  { value: "suspended", label: "Suspended", color: "bg-amber-100 text-amber-700" },
];

// ── Phase 3C tenant lifecycle states ─────────────────────────────────────
// Mirrors the backend TenantLifecycleState enum — presentation only. The
// backend state machine is the single source of truth for which transitions
// are legal; the UI renders what the server returns (allowed_transitions).
export const LIFECYCLE_STATE_BADGES = {
  provisioning: { label: "Provisioning", color: "bg-sky-100 text-sky-700" },
  onboarding: { label: "Onboarding", color: "bg-indigo-100 text-indigo-700" },
  active: { label: "Active", color: "bg-emerald-100 text-emerald-700" },
  suspended: { label: "Suspended", color: "bg-amber-100 text-amber-700" },
  deactivating: { label: "Deactivating", color: "bg-orange-100 text-orange-700" },
  deactivated: { label: "Deactivated", color: "bg-slate-200 text-slate-600" },
};

export function LifecycleStateBadge({ value }) {
  const option = LIFECYCLE_STATE_BADGES[value];
  return (
    <StatusBadge
      status={value}
      options={[{ value, ...(option || {}) }]}
      fallbackColor="bg-slate-100 text-slate-600"
    />
  );
}

// Evidence-based onboarding readiness signals (Phase 3C). Values come from
// the backend as ready/pending/unknown — unknown is rendered honestly, never
// inferred green.
export const READINESS_BADGES = {
  ready: { label: "Ready", color: "bg-emerald-100 text-emerald-700" },
  pending: { label: "Pending", color: "bg-amber-100 text-amber-700" },
  unknown: { label: "Unknown", color: "bg-slate-100 text-slate-500" },
};

export function ReadinessBadge({ value }) {
  const option = READINESS_BADGES[value] || READINESS_BADGES.unknown;
  return (
    <StatusBadge
      status={value || "unknown"}
      options={[{ value: value || "unknown", ...option }]}
    />
  );
}

export const PLAN_STATUS_OPTIONS = [
  { value: "active", label: "Active", color: "bg-emerald-100 text-emerald-700" },
  { value: "inactive", label: "Inactive", color: "bg-amber-100 text-amber-700" },
  { value: "archived", label: "Archived", color: "bg-slate-100 text-slate-600" },
];

// Order mirrors the backend's dunning escalation path (N1): active ->
// past_due (day 0) -> restricted (day 10) -> suspended (day 20) ->
// cancelled (day 45, "terminate" — never a hard delete, per N2).
export const SUBSCRIPTION_STATUS_OPTIONS = [
  { value: "pending", label: "Pending", color: "bg-amber-100 text-amber-700" },
  { value: "active", label: "Active", color: "bg-emerald-100 text-emerald-700" },
  { value: "past_due", label: "Past Due", color: "bg-orange-100 text-orange-700" },
  { value: "restricted", label: "Restricted", color: "bg-rose-100 text-rose-700" },
  { value: "suspended", label: "Suspended", color: "bg-slate-100 text-slate-600" },
  { value: "cancelled", label: "Cancelled", color: "bg-red-100 text-red-700" },
  { value: "expired", label: "Expired", color: "bg-slate-100 text-slate-600" },
];

// ── Versioned price catalog (ZB-COM-BILL-001 §T1, Phase 4) ──────────────
export const CATALOG_VERSION_STATUS_OPTIONS = [
  { value: "draft", label: "Draft", color: "bg-slate-100 text-slate-600" },
  { value: "pending_approval", label: "Pending Approval", color: "bg-amber-100 text-amber-700" },
  { value: "published", label: "Published", color: "bg-emerald-100 text-emerald-700" },
  { value: "rejected", label: "Rejected", color: "bg-red-100 text-red-700" },
  { value: "archived", label: "Archived", color: "bg-slate-100 text-slate-600" },
];

// ── Maker-checker approval queue (ZB-COM-BILL-001 Phase 5) ──────────────
export const APPROVAL_STATUS_OPTIONS = [
  { value: "pending", label: "Pending", color: "bg-amber-100 text-amber-700" },
  { value: "approved", label: "Approved", color: "bg-emerald-100 text-emerald-700" },
  { value: "rejected", label: "Rejected", color: "bg-red-100 text-red-700" },
  { value: "cancelled", label: "Cancelled", color: "bg-slate-100 text-slate-600" },
  { value: "expired", label: "Expired", color: "bg-slate-100 text-slate-600" },
];

// ── Production Acceptance Center (ZB-COM-BILL-001 §26) ──────────────────
export const ACCEPTANCE_STATUS_OPTIONS = [
  { value: "PASS", label: "Pass", color: "bg-emerald-100 text-emerald-700" },
  { value: "WARNING", label: "Warning", color: "bg-amber-100 text-amber-700" },
  { value: "FAIL", label: "Fail", color: "bg-red-100 text-red-700" },
  { value: "NOT_CONFIGURED", label: "Not Configured", color: "bg-slate-100 text-slate-600" },
  { value: "NOT_APPLICABLE", label: "Not Applicable", color: "bg-slate-100 text-slate-500" },
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
  { value: "delete", label: "Delete" },
];

export const AUDIT_ACTION_BADGES = {
  create: { label: "Create", color: "bg-emerald-100 text-emerald-700" },
  update: { label: "Update", color: "bg-blue-100 text-blue-700" },
  activate: { label: "Activate", color: "bg-green-100 text-green-700" },
  deactivate: { label: "Deactivate", color: "bg-amber-100 text-amber-700" },
  set_default: { label: "Set Default", color: "bg-indigo-100 text-indigo-700" },
  clear_default: { label: "Clear Default", color: "bg-slate-100 text-slate-600" },
  archive: { label: "Archive", color: "bg-red-100 text-red-700" },
  delete: { label: "Delete", color: "bg-red-100 text-red-700" },
};

// Entity types currently recorded on the platform-plane audit trail.
export const AUDIT_ENTITY_OPTIONS = [
  { value: "CommercialPlan", label: "Commercial Plan" },
  { value: "Organization", label: "Organization" },
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

// ── Subscription lifecycle audit presentation (PHASE 13) ──────────────────
// Labels/colors only, for the read-only /subscription-audit-logs feed —
// mirrors the backend's presentation-only lifecycle_event derivation
// (super_admin/router.py::_subscription_lifecycle_event). No business
// semantics live here.

export const SUBSCRIPTION_LIFECYCLE_EVENT_OPTIONS = [
  { value: "subscription_created", label: "Created" },
  { value: "subscription_activated", label: "Activated" },
  { value: "subscription_suspended", label: "Suspended" },
  { value: "subscription_cancelled", label: "Cancelled" },
  { value: "subscription_expired", label: "Expired" },
];

const SUBSCRIPTION_LIFECYCLE_EVENT_BADGES = {
  subscription_created: { label: "Created", color: "bg-emerald-100 text-emerald-700" },
  subscription_activated: { label: "Activated", color: "bg-green-100 text-green-700" },
  subscription_suspended: { label: "Suspended", color: "bg-slate-100 text-slate-600" },
  subscription_cancelled: { label: "Cancelled", color: "bg-red-100 text-red-700" },
  subscription_expired: { label: "Expired", color: "bg-slate-100 text-slate-600" },
};

export function SubscriptionLifecycleBadge({ value }) {
  const option = SUBSCRIPTION_LIFECYCLE_EVENT_BADGES[value] || {};
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
  active: ["past_due", "suspended", "cancelled", "expired"],
  past_due: ["restricted", "active", "cancelled"],
  restricted: ["suspended", "active", "cancelled"],
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
