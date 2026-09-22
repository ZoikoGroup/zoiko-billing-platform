import { settingsApi } from "./billingService";

// Phase 7 (Billing performance remediation, cont'd) — settingsApi.getConfig()
// itself coalesces concurrent HTTP calls and short-TTL-caches the raw response
// (see billingService.js), but every consumer of the full config object still
// called it directly and independently: CurrencyContext and TerminologyContext
// each kept their OWN, separate, indefinitely-lived module caches derived from
// it, and ~19 more page/wizard components called settingsApi.getConfig()
// straight from a useEffect with no caching at all. None of these caches knew
// about each other, so (a) a single navigation could still fan out several
// logical "give me the config" calls with nothing coordinating them, and (b)
// after a settings save, CurrencyContext/TerminologyContext's own caches had
// no way to learn the config had changed and kept serving pre-save values
// until a hard reload.
//
// This module is the ONE shared cache of the full config object every read-only
// consumer should read from (module-level singleton + in-flight-promise dedup,
// same shape as orgAdminService.getOrganizationDetails()). invalidateGlobalBillingConfig()
// is the single hook editor pages call right after a successful
// settingsApi.updateConfig(...)/resetConfig() save, and it's also wired into
// AuthContext.logout() — mirroring invalidateOrganizationDetailsCache() — so a
// login/logout account switch in the same tab can never serve one org's cached
// config to the next session. subscribeBillingConfigInvalidation() lets
// derived caches (CurrencyContext, TerminologyContext) react immediately
// instead of only picking up the change on their next unrelated remount.
let cachedConfig = null;
let inflight = null;
const listeners = new Set();

export function loadGlobalBillingConfig() {
  if (cachedConfig) return Promise.resolve(cachedConfig);
  if (inflight) return inflight;
  inflight = settingsApi
    .getConfig()
    .then((data) => {
      cachedConfig = data;
      inflight = null;
      return data;
    })
    .catch((err) => {
      inflight = null;
      throw err;
    });
  return inflight;
}

export function invalidateGlobalBillingConfig() {
  cachedConfig = null;
  inflight = null;
  listeners.forEach((fn) => {
    try {
      fn();
    } catch {
      // A misbehaving listener must not stop the others from being notified.
    }
  });
}

// Lets a derived cache (CurrencyContext, TerminologyContext) learn the config
// was invalidated so it can clear/refresh its own derived value instead of
// serving a stale one until its next unrelated remount. Returns an unsubscribe
// function.
export function subscribeBillingConfigInvalidation(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
