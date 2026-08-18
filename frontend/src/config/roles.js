export const ROLES = {
  SUPER_ADMIN: "super_admin",
  ORG_ADMIN: "org_admin",
  BILLING_ADMIN: "billing_admin",
};

export const ROLE_LABELS = {
  [ROLES.SUPER_ADMIN]: "Super Admin",
  [ROLES.ORG_ADMIN]: "Organization Admin",
  [ROLES.BILLING_ADMIN]: "Billing Admin",
};

export const ROLE_DEFAULT_REDIRECT = {
  [ROLES.SUPER_ADMIN]: "/dashboard",
  [ROLES.ORG_ADMIN]: "/organization-admin/dashboard",
  [ROLES.BILLING_ADMIN]: "/billing/workspace/dashboard",
};

export const VALID_ROLES = Object.values(ROLES);
