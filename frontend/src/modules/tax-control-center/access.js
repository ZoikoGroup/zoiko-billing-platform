// Tax Control Center access (Phase 5a). Client-side MIRROR of the backend's
// tax_registry.* capabilities (app/core/capabilities.py): they are
// EXPLICIT_ONLY, so platform_administrator gets no access by default. Used
// to guard routes and hide actions; the backend remains the authority.

export const TAX_REVIEWER = "tax_reviewer";
export const TAX_PUBLISHER = "tax_publisher";

export function canReadTaxRegistry(platformRole) {
  return platformRole === TAX_REVIEWER || platformRole === TAX_PUBLISHER;
}

/** Draft, amend, validate, submit (the maker). */
export function canWriteTaxRegistry(platformRole) {
  return platformRole === TAX_REVIEWER;
}

/** Approve, reject, publish (the checker). */
export function canApproveTaxRegistry(platformRole) {
  return platformRole === TAX_PUBLISHER;
}

export const MAKER_REASON = "You prepared or submitted this change; a different person must approve it.";
export const ROLE_REASON = "Your role cannot approve tax registry changes (TAX_PUBLISHER only).";

/**
 * Why the current user can't approve or publish a version, or null. Mirrors
 * the inbox's reason_if_not for screens that show a version directly.
 */
export function approveBlockedReason(user, version) {
  if (!canApproveTaxRegistry(user?.platform_role)) return ROLE_REASON;
  const me = user?.id;
  const authors = [version?.maker_user_id, version?.created_by_user_id, version?.adopted_by_user_id];
  if (me != null && authors.some((id) => id != null && id === me)) return MAKER_REASON;
  return null;
}
