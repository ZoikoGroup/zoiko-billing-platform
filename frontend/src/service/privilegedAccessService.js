import { api } from "./api";

/**
 * Domain B (Tenant Financial) privileged, just-in-time tenant support
 * access, and Domain C (Tenant Telemetry) — ZB-SA-CMD-003 §6/§7/§8.
 *
 * Every endpoint here is Super-Admin-only on the backend
 * (get_current_super_admin) and every mutation is re-checked server-side
 * against the calling actor's own grant — this client never decides
 * authorization, it only reflects it.
 */

// ── Tenant selection (domain-neutral — plain organization identity only,
// no commercial/financial fields, so this step never mixes Domain A/B) ──
export const searchOrganizations = (search = "") =>
  api.get("/api/organizations/", { params: { search, limit: 20 } });

// ── Privileged access lifecycle ────────────────────────────────────────
export const requestPrivilegedAccess = (data) =>
  api.post("/api/super-admin/privileged-access/request", data);

export const getActivePrivilegedAccess = () =>
  api.get("/api/super-admin/privileged-access/active");

export const exitPrivilegedAccess = (grantId) =>
  api.post(`/api/super-admin/privileged-access/${grantId}/exit`, {});

export const listMyPrivilegedAccess = (limit = 20) =>
  api.get("/api/super-admin/privileged-access/mine", { params: { limit } });

export const revokePrivilegedAccess = (grantId, data) =>
  api.post(`/api/super-admin/privileged-access/${grantId}/revoke`, data);

// Requester withdraws their own not-yet-active request (no revoke capability needed).
export const cancelPrivilegedAccess = (grantId) =>
  api.post(`/api/super-admin/privileged-access/${grantId}/cancel`, {});

// Every pending/approved/active grant across operators (tenant_support.revoke).
export const listLivePrivilegedAccess = () =>
  api.get("/api/super-admin/privileged-access/live");

export const openBreakGlass = (data) =>
  api.post("/api/super-admin/privileged-access/break-glass", data);

export const reviewBreakGlass = (grantId, data) =>
  api.post(`/api/super-admin/privileged-access/${grantId}/review`, data);

export const listPendingReviews = () =>
  api.get("/api/super-admin/privileged-access/pending-review");

// Temporary read-only tenant login for the caller's own active session.
export const getSupportAccessCredentials = (grantId) =>
  api.get(`/api/super-admin/privileged-access/${grantId}/credentials`);

export const getPrivilegedAccessTenantSummary = (grantId) =>
  api.get(`/api/super-admin/privileged-access/${grantId}/tenant-summary`);

// ── Tenant-side endpoints ──────────────────────────────────────────────
export const getPrivilegedAccessLog = (limit = 50) =>
  api.get("/api/organizations/me/privileged-access-log", { params: { limit } });

export const tenantRevokePrivilegedAccess = (grantId, data) =>
  api.post(`/api/organizations/me/privileged-access/${grantId}/revoke`, data);

export const tenantApprovePrivilegedAccess = (grantId, data = {}) =>
  api.post(`/api/organizations/me/privileged-access/${grantId}/approve`, data);

export const tenantDenyPrivilegedAccess = (grantId, data) =>
  api.post(`/api/organizations/me/privileged-access/${grantId}/deny`, data);

// ── Domain C telemetry ──────────────────────────────────────────────────
export const getOrganizationTelemetry = () =>
  api.get("/api/super-admin/telemetry/organizations");

export const getJobTelemetry = () =>
  api.get("/api/super-admin/telemetry/jobs");

export const retryJob = (jobName, reason) =>
  api.post(`/api/super-admin/telemetry/jobs/${jobName}/retry`, { reason });

export const getTenantHealthOverview = () =>
  api.get("/api/super-admin/telemetry/tenant-health");

export const getFinancialConsistency = () =>
  api.get("/api/super-admin/financial-consistency");
