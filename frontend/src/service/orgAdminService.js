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

export function getOrganizationDetails() {
  if (cachedDetails) return Promise.resolve(cachedDetails);
  if (inflightDetails) return inflightDetails;
  inflightDetails = api.get("/api/organizations/me/detail")
    .then((data) => {
      cachedDetails = data;
      return data;
    })
    .finally(() => {
      inflightDetails = null;
    });
  return inflightDetails;
}

export function invalidateOrganizationDetailsCache() {
  cachedDetails = null;
  inflightDetails = null;
}

export const updateOrganizationDetails = (data) =>
  api.put("/api/organizations/me", {
    organization_name: data.name,
    display_name: data.display_name,
    industry: data.industry,
    address: data.address,
    currency: data.currency,
    timezone: data.timezone,
  }).then((result) => {
    invalidateOrganizationDetailsCache();
    return result;
  });
export const getOrganizationDashboardStats = () => api.get("/api/organizations/me/dashboard-stats");
