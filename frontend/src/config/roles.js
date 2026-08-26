export const ROLES = {
  SUPER_ADMIN: "super_admin",
  ORG_ADMIN: "org_admin",
  BILLING_ADMIN: "billing_admin",
  FINANCE_APPROVER: "finance_approver",
  AUDITOR: "auditor",
};

export const ROLE_LABELS = {
  [ROLES.SUPER_ADMIN]: "Super Admin",
  [ROLES.ORG_ADMIN]: "Organization Admin",
  [ROLES.BILLING_ADMIN]: "Billing Admin",
  [ROLES.FINANCE_APPROVER]: "Finance Approver",
  [ROLES.AUDITOR]: "Auditor",
};

export const ROLE_DEFAULT_REDIRECT = {
  [ROLES.SUPER_ADMIN]: "/dashboard",
  [ROLES.ORG_ADMIN]: "/organization-admin/dashboard",
  [ROLES.BILLING_ADMIN]: "/billing/workspace/dashboard",
  [ROLES.FINANCE_APPROVER]: "/billing",
  [ROLES.AUDITOR]: "/billing",
};

export const VALID_ROLES = Object.values(ROLES);

// ── Platform roles (super_admin sub-roles, Phase 3B/4) ──────────────────────
// Client-side MIRROR of backend app/core/capabilities.py. Used only to avoid
// firing requests the server will certainly deny (403 noise); the backend
// remains the single source of authorization truth.
const NULL_LIKE = [null, undefined, "", "platform_administrator"];

export const PLATFORM_ROLE_LABELS = {
  platform_administrator: "Platform Administrator",
  support_operator: "Support Operator",
  security_operator: "Security Operator",
  reliability_operator: "Reliability Operator",
  auditor: "Auditor",
  finance_readonly: "Finance (Read-Only)",
};

const RELIABILITY_READ_ROLES = ["reliability_operator", "security_operator", "auditor", "support_operator"];

export function canReadReliabilityTelemetry(platformRole) {
  return NULL_LIKE.includes(platformRole) || RELIABILITY_READ_ROLES.includes(platformRole);
}

// Mirrors backend capabilities.py's platform_config.read role set (support_operator,
// security_operator, reliability_operator, auditor) — used only to avoid firing a
// request the server will certainly deny; the backend remains the source of truth.
const CONFIGURATION_READ_ROLES = ["support_operator", "security_operator", "reliability_operator", "auditor"];

export function canReadConfiguration(platformRole) {
  return NULL_LIKE.includes(platformRole) || CONFIGURATION_READ_ROLES.includes(platformRole);
}

// Mirrors backend capabilities.py's Plane 1 commercial-billing capability map
// (commercial_quote.write / commercial_quote.approve / commercial_payment.write /
// commercial_financial.read / commercial_financial.write /
// commercial_evaluation_program.write) — client-side hint only, the backend's
// require_capability dependency remains the real gate.
const COMMERCIAL_QUOTE_WRITE_ROLES = ["support_operator"];
const COMMERCIAL_QUOTE_APPROVE_ROLES = ["auditor"];
const COMMERCIAL_PAYMENT_WRITE_ROLES = ["security_operator"];
const COMMERCIAL_FINANCIAL_READ_ROLES = ["auditor", "finance_readonly"];
const COMMERCIAL_FINANCIAL_WRITE_ROLES = ["security_operator"];
// commercial_evaluation_program.write has no explicit role set on the
// backend (platform_administrator only) — NULL_LIKE already covers that.

export function canWriteCommercialQuote(platformRole) {
  return NULL_LIKE.includes(platformRole) || COMMERCIAL_QUOTE_WRITE_ROLES.includes(platformRole);
}

export function canApproveCommercialQuote(platformRole) {
  return NULL_LIKE.includes(platformRole) || COMMERCIAL_QUOTE_APPROVE_ROLES.includes(platformRole);
}

export function canWriteCommercialPayment(platformRole) {
  return NULL_LIKE.includes(platformRole) || COMMERCIAL_PAYMENT_WRITE_ROLES.includes(platformRole);
}

// Read-only Plane 1 financial views (invoice/quote/payment lists and detail).
export function canReadCommercialFinancial(platformRole) {
  return NULL_LIKE.includes(platformRole) || COMMERCIAL_FINANCIAL_READ_ROLES.includes(platformRole);
}

// Mutating Plane 1 invoice actions (create/add-item/finalize/void/send) —
// gated by commercial_financial.write on the backend.
export function canWriteCommercialFinancial(platformRole) {
  return NULL_LIKE.includes(platformRole) || COMMERCIAL_FINANCIAL_WRITE_ROLES.includes(platformRole);
}

// Creating/activating a Plane 1 evaluation (trial) program — platform_administrator only.
export function canWriteEvaluationProgram(platformRole) {
  return NULL_LIKE.includes(platformRole);
}
