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
  getPlanLimits: () => api.get("/billing/workspace/plan-limits"),
  startTrial: () => api.post("/billing/workspace/start-trial", {}),
  getAvailablePlans: () => api.get("/billing/workspace/available-plans", { cacheTtl: 30_000 }),
  previewPlanChange: (targetPlanId) =>
    api.post("/billing/workspace/plan-change/preview", { target_plan_id: targetPlanId }),
  commitPlanChange: ({ targetPlanId, confirmImmediate = false, reason = null }) =>
    api.post("/billing/workspace/plan-change", {
      target_plan_id: targetPlanId,
      confirm_immediate: confirmImmediate,
      reason,
    }),
  cancelPlanChange: (changeId) => api.post(`/billing/workspace/plan-change/${changeId}/cancel`, {}),
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
// See orgAdminService.js: a request from before an invalidation (previous
// account) must not repopulate the cache or clear the next request's slot.
let cacheGeneration = 0;

export function getZoikoSubscriptionCached() {
  if (cachedSubscription) return Promise.resolve(cachedSubscription);
  if (inflightSubscription) return inflightSubscription;
  const generation = cacheGeneration;
  const request = platformSelfServiceApi
    .getZoikoSubscription()
    .then((data) => {
      if (generation === cacheGeneration) cachedSubscription = data;
      return data;
    })
    .finally(() => {
      if (inflightSubscription === request) inflightSubscription = null;
    });
  inflightSubscription = request;
  return request;
}

export function invalidateZoikoSubscriptionCache() {
  cacheGeneration += 1;
  cachedSubscription = null;
  inflightSubscription = null;
}
