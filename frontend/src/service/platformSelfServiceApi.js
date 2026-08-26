import { api } from "./api";

/**
 * Plane 1 (Zoiko-billing-the-org) org-facing self-service endpoint.
 *
 * Distinct from commandCenterService.js (Super-Admin-only) and
 * platformPublicService.js (unauthenticated, token-based). This one is
 * authenticated as the caller's own org_admin/billing_admin and scoped
 * server-side to their own organization — never a client-supplied account id.
 */

export const platformSelfServiceApi = {
  getZoikoSubscription: () => api.get("/billing/workspace/zoiko-subscription"),
};
