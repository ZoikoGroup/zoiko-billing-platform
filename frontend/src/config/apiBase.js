/**
 * config/apiBase.js
 * -----------------
 * Single source of truth for the backend origin the BROWSER calls.
 *
 * WHY THIS EXISTS
 * ---------------
 * Vite inlines `import.meta.env.VITE_*` into the bundle at BUILD time. Every
 * module that read `VITE_API_BASE_URL || "http://localhost:8001"` therefore
 * shipped a literal `http://localhost:8001` to every visitor. That address
 * resolves on the VISITOR'S machine, not the server's, so:
 *
 *   - the developer, whose own laptop runs the backend, signed in fine
 *   - every other user got ERR_CONNECTION_REFUSED and "Unable to connect.
 *     Check your internet connection and try again."
 *
 * The origin that is always correct is the one the user is already on, so the
 * default is a SAME-ORIGIN relative base ("") and the request goes to
 * `<current-host>/api/...`. The reverse proxy that forwards /api to the
 * FastAPI backend lives in nginx (frontend/nginx.conf for the container; the
 * VM's site config for the bare-metal deploy) and in the Vite dev server
 * (vite.config.js). Both already proxy /api.
 *
 * `VITE_API_BASE_URL` is still honoured, but only for split-host deployments
 * where the backend genuinely lives on a different origin than the frontend.
 * A loopback origin in a production build is a bug that only reproduces for
 * users other than the developer's own machine, so it is logged loudly rather
 * than silently shipped.
 */

// Matches http(s)://localhost:8001, 127.0.0.1, ::1 and 0.0.0.0, with any port/path.
const LOOPBACK_ORIGIN =
  /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:\/|$)/i;

/** Configured origin, or "" for same-origin. Trailing slashes trimmed. */
const configured = String(import.meta.env.VITE_API_BASE_URL || "").trim();

/**
 * Base prepended to every API path.
 * "" (same-origin) by default, so requests resolve against the host the app
 * was loaded from. An explicit VITE_API_BASE_URL overrides it.
 */
export const API_BASE_URL = configured.replace(/\/+$/, "");

/** True when the app is calling its own machine rather than the server. */
export const IS_LOOPBACK_BASE = LOOPBACK_ORIGIN.test(API_BASE_URL);

/** True for `npm run build` output, false under `npm run dev`. */
const IS_PRODUCTION_BUILD = Boolean(import.meta.env.PROD);

// A loopback origin only ever works for whoever is sitting at the server that
// hosts the backend. Shipping one to real users produces a login that fails
// for everyone except the developer - the exact failure this module replaces.
// Warn instead of throwing: a hard failure here would white-screen the whole
// app, whereas the misconfiguration is already obvious and recoverable.
if (IS_PRODUCTION_BUILD && IS_LOOPBACK_BASE) {
  console.error(
    "[api-base] VITE_API_BASE_URL points at a loopback address " +
      `(${API_BASE_URL}). Every visitor's browser would call their OWN machine, ` +
      "so sign-in fails for everyone except the developer. Unset " +
      "VITE_API_BASE_URL to use the same-origin /api path, or set it to the " +
      "real backend origin if the API is on a different host."
  );
}

/**
 * Resolve an API path against the configured base.
 *
 * Returns an absolute URL string. With the same-origin default the path is
 * resolved against `window.location.origin` - `new URL(path)` on its own
 * throws, which is why this helper exists instead of callers doing it inline.
 *
 * @param {string} path API path, e.g. "/api/auth/login".
 * @returns {string} Absolute URL.
 */
export function apiUrl(path) {
  const suffix = String(path || "");
  if (API_BASE_URL) return `${API_BASE_URL}${suffix}`;
  if (typeof window !== "undefined" && window.location?.origin) {
    return new URL(suffix, window.location.origin).toString();
  }
  // SSR / non-DOM test environment: no origin to resolve against. Returning the
  // relative path keeps callers from crashing; the browser resolves it.
  return suffix;
}

export default API_BASE_URL;
