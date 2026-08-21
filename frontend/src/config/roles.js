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
