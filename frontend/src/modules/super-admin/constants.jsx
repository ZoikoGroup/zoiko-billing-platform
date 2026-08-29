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
// cancelled (day 45, "terminate" — never a hard delete, per N2). The four
// ZB-COM-ENT-001 Part 1 states (trialing/scheduled_change/
// cancel_at_period_end/enterprise_pending) are appended last — mirror the
// backend enums.py exactly, presentation only.
export const SUBSCRIPTION_STATUS_OPTIONS = [
  { value: "pending", label: "Pending", color: "bg-amber-100 text-amber-700" },
  { value: "active", label: "Active", color: "bg-emerald-100 text-emerald-700" },
  { value: "past_due", label: "Past Due", color: "bg-orange-100 text-orange-700" },
  { value: "restricted", label: "Restricted", color: "bg-rose-100 text-rose-700" },
  { value: "suspended", label: "Suspended", color: "bg-slate-100 text-slate-600" },
  { value: "cancelled", label: "Cancelled", color: "bg-red-100 text-red-700" },
  { value: "expired", label: "Expired", color: "bg-slate-100 text-slate-600" },
  { value: "trialing", label: "Trialing", color: "bg-sky-100 text-sky-700" },
  { value: "scheduled_change", label: "Scheduled Change", color: "bg-indigo-100 text-indigo-700" },
  { value: "cancel_at_period_end", label: "Cancel at Period End", color: "bg-violet-100 text-violet-700" },
  { value: "enterprise_pending", label: "Enterprise Pending", color: "bg-cyan-100 text-cyan-700" },
];

// ── Versioned price catalog (ZB-COM-BILL-001 §T1, Phase 4) ──────────────
export const CATALOG_VERSION_STATUS_OPTIONS = [
  { value: "draft", label: "Draft", color: "bg-slate-100 text-slate-600" },
  { value: "pending_approval", label: "Pending Approval", color: "bg-amber-100 text-amber-700" },
  { value: "published", label: "Published", color: "bg-emerald-100 text-emerald-700" },
  { value: "rejected", label: "Rejected", color: "bg-red-100 text-red-700" },
  { value: "archived", label: "Archived", color: "bg-slate-100 text-slate-600" },
];

// ── Commercial overrides (ZB-COM-ENT-001 Part 2 §16.1, dual-approval) ────
export const OVERRIDE_STATUS_OPTIONS = [
  { value: "draft", label: "Draft", color: "bg-slate-100 text-slate-600" },
  { value: "pending_approval", label: "Pending Approval", color: "bg-amber-100 text-amber-700" },
  { value: "approved", label: "Approved", color: "bg-emerald-100 text-emerald-700" },
  { value: "rejected", label: "Rejected", color: "bg-red-100 text-red-700" },
  { value: "revoked", label: "Revoked", color: "bg-slate-100 text-slate-600" },
  { value: "expired", label: "Expired", color: "bg-slate-100 text-slate-500" },
];

// ── Plan-change orchestration (ZB-COM-ENT-001 Part 3 §7-§8) ──────────────
export const SUBSCRIPTION_CHANGE_STATUS_OPTIONS = [
  { value: "pending", label: "Pending", color: "bg-slate-100 text-slate-600" },
  { value: "blocked", label: "Blocked", color: "bg-red-100 text-red-700" },
  { value: "scheduled", label: "Scheduled", color: "bg-amber-100 text-amber-700" },
  { value: "applied", label: "Applied", color: "bg-emerald-100 text-emerald-700" },
  { value: "reversed", label: "Reversed", color: "bg-slate-100 text-slate-500" },
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

// ── Financial Operations detail pages ───────────────────────────────────

export const INVOICE_STATUS_OPTIONS = [
  { value: "draft", label: "Draft", color: "bg-slate-100 text-slate-600" },
  { value: "sent", label: "Sent", color: "bg-blue-100 text-blue-700" },
  { value: "paid", label: "Paid", color: "bg-emerald-100 text-emerald-700" },
  { value: "overdue", label: "Overdue", color: "bg-red-100 text-red-700" },
  { value: "partially_paid", label: "Partially Paid", color: "bg-amber-100 text-amber-700" },
  { value: "cancelled", label: "Cancelled", color: "bg-slate-100 text-slate-600" },
  { value: "refunded", label: "Refunded", color: "bg-violet-100 text-violet-700" },
  { value: "written_off", label: "Written Off", color: "bg-rose-100 text-rose-700" },
];

export const DUNNING_STATUS_OPTIONS = [
  { value: "active", label: "Active", color: "bg-amber-100 text-amber-700" },
  { value: "resolved", label: "Resolved", color: "bg-emerald-100 text-emerald-700" },
  { value: "escalated", label: "Escalated", color: "bg-red-100 text-red-700" },
  { value: "paused", label: "Paused", color: "bg-slate-100 text-slate-600" },
];

export const CREDIT_NOTE_STATUS_OPTIONS = [
  { value: "draft", label: "Draft", color: "bg-slate-100 text-slate-600" },
  { value: "approved", label: "Approved", color: "bg-blue-100 text-blue-700" },
  { value: "issued", label: "Issued", color: "bg-emerald-100 text-emerald-700" },
  { value: "partially_applied", label: "Partially Applied", color: "bg-amber-100 text-amber-700" },
  { value: "fully_applied", label: "Fully Applied", color: "bg-emerald-100 text-emerald-700" },
  { value: "voided", label: "Voided", color: "bg-red-100 text-red-700" },
];

export const REFUND_STATUS_OPTIONS = [
  { value: "pending", label: "Pending", color: "bg-amber-100 text-amber-700" },
  { value: "draft", label: "Draft", color: "bg-slate-100 text-slate-600" },
  { value: "pending_approval", label: "Pending Approval", color: "bg-amber-100 text-amber-700" },
  { value: "approved", label: "Approved", color: "bg-blue-100 text-blue-700" },
  { value: "processing", label: "Processing", color: "bg-blue-100 text-blue-700" },
  { value: "completed", label: "Completed", color: "bg-emerald-100 text-emerald-700" },
  { value: "failed", label: "Failed", color: "bg-red-100 text-red-700" },
  { value: "rejected", label: "Rejected", color: "bg-red-100 text-red-700" },
  { value: "cancelled", label: "Cancelled", color: "bg-slate-100 text-slate-600" },
];

export const WRITE_OFF_STATUS_OPTIONS = [
  { value: "draft", label: "Draft", color: "bg-slate-100 text-slate-600" },
  { value: "pending_approval", label: "Pending Approval", color: "bg-amber-100 text-amber-700" },
  { value: "approved", label: "Approved", color: "bg-blue-100 text-blue-700" },
  { value: "executed", label: "Executed", color: "bg-emerald-100 text-emerald-700" },
  { value: "reversed", label: "Reversed", color: "bg-violet-100 text-violet-700" },
  { value: "cancelled", label: "Cancelled", color: "bg-slate-100 text-slate-600" },
];

export const RECONCILIATION_RUN_STATE_OPTIONS = [
  { value: "running", label: "Running", color: "bg-blue-100 text-blue-700" },
  { value: "verified", label: "Verified", color: "bg-emerald-100 text-emerald-700" },
  { value: "partial", label: "Partial", color: "bg-amber-100 text-amber-700" },
  { value: "failed", label: "Failed", color: "bg-red-100 text-red-700" },
];

export const RECONCILIATION_EXCEPTION_STATUS_OPTIONS = [
  { value: "OPEN", label: "Open", color: "bg-red-100 text-red-700" },
  { value: "ACKNOWLEDGED", label: "Acknowledged", color: "bg-amber-100 text-amber-700" },
  { value: "RESOLVED", label: "Resolved", color: "bg-emerald-100 text-emerald-700" },
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
  pending: ["active", "cancelled", "suspended", "trialing", "enterprise_pending"],
  active: ["past_due", "suspended", "cancelled", "expired", "scheduled_change", "cancel_at_period_end"],
  past_due: ["restricted", "active", "cancelled"],
  restricted: ["suspended", "active", "cancelled"],
  suspended: ["active", "cancelled"],
  cancelled: [],
  expired: [],
  trialing: ["active", "cancelled", "suspended", "expired"],
  scheduled_change: ["active", "cancelled"],
  cancel_at_period_end: ["active", "cancelled"],
  enterprise_pending: ["pending", "active", "cancelled"],
};

export const TRANSITION_LABELS = {
  active: "Activate",
  past_due: "Mark Past Due",
  restricted: "Restrict",
  suspended: "Suspend",
  cancelled: "Cancel",
  expired: "Expire",
  trialing: "Start Trial",
  scheduled_change: "Schedule Change",
  cancel_at_period_end: "Cancel at Period End",
  enterprise_pending: "Enterprise Pending",
};

/**
 * Free-trial remaining-time helper (COMMERCIAL_TRIAL_PERIOD_DAYS, see
 * commercial/tasks/trial_expiry.py). Meaningful while status is "pending"
 * (legacy ad-hoc trial) or "trialing" (ZB-COM-ENT-001 trial under a
 * CommercialEvaluationProgram) — and "suspended" (trial expired unpaid).
 * ACTIVE/CANCELLED/etc subscriptions have no trial countdown to show.
 * Returns null when there's nothing trial-related to display.
 */
export function formatTrialRemaining(trialEndsAt, status, recoveryEndsAt = null) {
  if (status === "suspended") return { label: "Trial expired", tone: "risk" };
  if (status !== "pending" && status !== "trialing") return null;
  if (!trialEndsAt) return null;

  const end = new Date(trialEndsAt);
  if (Number.isNaN(end.getTime())) return null;
  const diffMs = end.getTime() - Date.now();
  if (diffMs <= 0) return { label: "Trial expired", tone: "risk" };

  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  let label = days >= 1 ? `${days}d ${hours}h left` : `${hours}h left`;

  if (recoveryEndsAt) {
    const rEnd = new Date(recoveryEndsAt);
    if (!Number.isNaN(rEnd.getTime()) && rEnd.getTime() > Date.now()) {
      const rDays = Math.ceil((rEnd.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      label += ` · recovery ${rDays}d`;
    }
  }
  return { label, tone: days === 0 ? "attention" : "default" };
}

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

// ── Entitlement catalog (ZB-COM-ENT-001 Part 1 §12–§13) ───────────────────
// Presentation-only mirrors of the backend enums. The catalog is read-only
// in Part 1; values come from the seeded definitions + PlanEntitlement rows.

export const ENTITLEMENT_VALUE_TYPE_OPTIONS = [
  { value: "boolean", label: "Boolean", color: "bg-slate-100 text-slate-600" },
  { value: "integer", label: "Integer", color: "bg-blue-100 text-blue-700" },
  { value: "enum", label: "Enum", color: "bg-indigo-100 text-indigo-700" },
  { value: "set", label: "Set", color: "bg-violet-100 text-violet-700" },
];

export const ENTITLEMENT_VALUE_TYPE_BADGES = {
  boolean: { label: "Boolean", color: "bg-slate-100 text-slate-600" },
  integer: { label: "Integer", color: "bg-blue-100 text-blue-700" },
  enum: { label: "Enum", color: "bg-indigo-100 text-indigo-700" },
  set: { label: "Set", color: "bg-violet-100 text-violet-700" },
};

export const ENTITLEMENT_RISK_OPTIONS = [
  { value: "standard", label: "Standard", color: "bg-emerald-100 text-emerald-700" },
  { value: "high_risk", label: "High Risk", color: "bg-rose-100 text-rose-700" },
];

export const ENTITLEMENT_RISK_BADGES = {
  standard: { label: "Standard", color: "bg-emerald-100 text-emerald-700" },
  high_risk: { label: "High Risk", color: "bg-rose-100 text-rose-700" },
};

export const ENTITLEMENT_ENFORCEMENT_OPTIONS = [
  { value: "informational", label: "Informational", color: "bg-slate-100 text-slate-600" },
  { value: "soft_then_hard", label: "Soft then Hard", color: "bg-amber-100 text-amber-700" },
  { value: "throttle", label: "Throttle", color: "bg-sky-100 text-sky-700" },
  { value: "hard", label: "Hard", color: "bg-red-100 text-red-700" },
];

export const ENTITLEMENT_ENFORCEMENT_BADGES = {
  informational: { label: "Informational", color: "bg-slate-100 text-slate-600" },
  soft_then_hard: { label: "Soft then Hard", color: "bg-amber-100 text-amber-700" },
  throttle: { label: "Throttle", color: "bg-sky-100 text-sky-700" },
  hard: { label: "Hard", color: "bg-red-100 text-red-700" },
};

export function EntitlementValueTypeBadge({ value }) {
  const option = ENTITLEMENT_VALUE_TYPE_BADGES[value];
  return <StatusBadge status={value} options={[{ value, ...(option || {}) }]} fallbackColor="bg-slate-100 text-slate-600" />;
}

export function EntitlementRiskBadge({ value }) {
  const option = ENTITLEMENT_RISK_BADGES[value];
  return <StatusBadge status={value} options={[{ value, ...(option || {}) }]} fallbackColor="bg-slate-100 text-slate-600" />;
}

export function EntitlementEnforcementBadge({ value }) {
  const option = ENTITLEMENT_ENFORCEMENT_BADGES[value];
  return <StatusBadge status={value} options={[{ value, ...(option || {}) }]} fallbackColor="bg-slate-100 text-slate-600" />;
}

/**
 * Human-readable rendering of one typed entitlement value.
 * boolean -> on/off; set -> sorted; null + contracted -> "Contracted (order form)".
 */
export function formatEntitlementValue(value, valueType, isContracted = false) {
  if (isContracted && (value === null || value === undefined)) return "Contracted";
  if (value === null || value === undefined || value === "") return "—";
  if (valueType === "boolean") return value ? "Enabled" : "Disabled";
  if (valueType === "set" && Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
