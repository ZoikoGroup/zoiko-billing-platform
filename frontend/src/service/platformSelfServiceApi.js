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
  getWorkspaceUsage: () => api.get("/billing/workspace/usage"),
  convertTrialToPaid: (payload = {}) => api.post("/billing/workspace/trial/convert", payload),
};

// Perf (QA bug #42): TrialBanner is a single component mounted once inside
// BillingShell "so it is app-wide" (its own header comment), but every route
// in App.jsx wraps its page element as `<BillingShell>{element}</BillingShell>`
// -- a fresh element on every navigation, not a persistent parent/Outlet
// layout -- so React actually unmounts and remounts the whole shell (and
// therefore TrialBanner) on every single page navigation. Without a cache,
// that means GET /billing/workspace/zoiko-subscription fired on literally
// every page load app-wide (measured 1-3s each in this environment), even
// though trial/subscription status changes at most a few times per session.
// Same in-flight-promise-dedup + cache-until-invalidated shape already used
// by orgAdminService.js (organization details) and CurrencyContext.jsx
// (billing config) -- not a new pattern.
let cachedSubscription = null;
let inflightSubscription = null;

export function getZoikoSubscriptionCached() {
  if (cachedSubscription) return Promise.resolve(cachedSubscription);
  if (inflightSubscription) return inflightSubscription;
  inflightSubscription = platformSelfServiceApi
    .getZoikoSubscription()
    .then((data) => {
      cachedSubscription = data;
      return data;
    })
    .finally(() => {
      inflightSubscription = null;
    });
  return inflightSubscription;
}

export function invalidateZoikoSubscriptionCache() {
  cachedSubscription = null;
  inflightSubscription = null;
}
