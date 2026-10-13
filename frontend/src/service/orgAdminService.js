import { api } from "./api";

// Phase 7 (Billing performance remediation) — TopBar's OrgContext and the
// Organization Admin dashboard both call this independently on every mount,
// and every Billing-shell navigation remounts TopBar, so this endpoint was
// measured firing 2x per navigation for no reason (org details don't change
// mid-session). Cached per browser tab the same way CurrencyContext already
// caches settingsApi.getConfig() (module-level singleton + in-flight-promise
// dedup); explicitly invalidated below whenever the data can go stale
// (a successful update, or logout — see AuthContext.logout — so a second
// account signing in on the same tab never sees the previous tenant's cached
// details).
let cachedDetails = null;
let inflightDetails = null;
// Bumped on every invalidation. A request started before an invalidation
// (e.g. the previous account's, still in flight at logout/session expiry)
// must neither write its organization's data back into the cache nor clear
// the next session's own in-flight request when it finally settles.
let cacheGeneration = 0;

export function getOrganizationDetails() {
  if (cachedDetails) return Promise.resolve(cachedDetails);
  if (inflightDetails) return inflightDetails;
  const generation = cacheGeneration;
  const request = api.get("/api/organizations/me/detail")
    .then((data) => {
      if (generation === cacheGeneration) cachedDetails = data;
      return data;
    })
    .finally(() => {
      if (inflightDetails === request) inflightDetails = null;
    });
  inflightDetails = request;
  return request;
}

export function invalidateOrganizationDetailsCache() {
  cacheGeneration += 1;
  cachedDetails = null;
  inflightDetails = null;
}

// Sends only the fields present in `changes` (form keys; `name` maps to the
// API's organization_name). The backend applies exclude_unset, so anything
// omitted is left untouched -- the form never blanks fields it didn't edit.
export const updateOrganizationDetails = (changes) => {
  const { name, ...rest } = changes || {};
  const body = { ...rest };
  if (name !== undefined) body.organization_name = name;
  return api.put("/api/organizations/me", body).then((result) => {
    invalidateOrganizationDetailsCache();
    return result;
  });
};
export const getOrganizationDashboardStats = () => api.get("/api/organizations/me/dashboard-stats");
