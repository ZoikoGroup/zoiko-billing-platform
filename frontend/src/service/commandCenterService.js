import { api } from "./api";

/**
 * Super Admin Command Center — Attention Engine, global search, and the
 * Metric Dictionary (ZB-SA-CMD-003 §10/§13/§10.1). Kept separate from
 * privilegedAccessService.js (Domain B/C) since these are cross-cutting
 * governance/shell concerns, not tenant-scoped data.
 */

export const listAttentionItems = (limit = 50) =>
  api.get("/api/super-admin/attention", { params: { limit } });

export const getAttentionCounts = () =>
  api.get("/api/super-admin/attention/counts");

export const acknowledgeAttentionItem = (itemId) =>
  api.post(`/api/super-admin/attention/${itemId}/acknowledge`, {});

export const assignAttentionItem = (itemId, ownerUserId) =>
  api.post(`/api/super-admin/attention/${itemId}/assign`, { owner_user_id: ownerUserId });

export const transitionAttentionItem = (itemId, toStatus, resolutionCode) =>
  api.post(`/api/super-admin/attention/${itemId}/transition`, {
    to_status: toStatus,
    resolution_code: resolutionCode || undefined,
  });

export const suppressAttentionItem = (itemId, reason, minutes) =>
  api.post(`/api/super-admin/attention/${itemId}/suppress`, { reason, minutes });

export const globalSearch = (q) =>
  api.get("/api/super-admin/search", { params: { q } });

export const getMetricDictionary = (domain) =>
  api.get("/api/super-admin/metric-dictionary", { params: domain ? { domain } : {} });

// ZB-SA-CMD-003 §18 — Domain B circuit breaker (session 6). Real,
// server-enforced (InvoiceService.finalize_invoice() itself checks this
// state) — not a UI-only switch. Toggling requires fresh MFA step-up.
export const getInvoiceFinalizationBreaker = () =>
  api.get("/api/super-admin/circuit-breakers/tenant-invoice-finalization");

export const setInvoiceFinalizationBreaker = (enabled, reason, code, recoveryCode) =>
  api.put("/api/super-admin/circuit-breakers/tenant-invoice-finalization", {
    enabled,
    reason,
    code: code || undefined,
    recovery_code: recoveryCode || undefined,
  });

// ZB-SA-CMD-003 §9 — generalized breaker catalog + break-glass toggle
// (session 7). Engaging REQUIRES an incident_reference; every engaged pause
// carries a mandatory bounded auto-expiry window.
export const getCircuitBreakerCatalog = () =>
  api.get("/api/super-admin/circuit-breakers");

export const getCircuitBreaker = (scope) =>
  api.get(`/api/super-admin/circuit-breakers/${scope}`);

export const setCircuitBreaker = (scope, { enabled, reason, incidentReference, autoExpireMinutes, code, recoveryCode }) =>
  api.put(`/api/super-admin/circuit-breakers/${scope}`, {
    enabled,
    reason,
    incident_reference: incidentReference || undefined,
    auto_expire_minutes: autoExpireMinutes ?? undefined,
    code: code || undefined,
    recovery_code: recoveryCode || undefined,
  });

// §9 maker-checker path: stage a breaker change for a second Super Admin.
export const proposeCircuitBreakerChange = (scope, { enabled, reason, incidentReference, autoExpireMinutes }) =>
  api.post(`/api/super-admin/circuit-breakers/${scope}/approval-request`, {
    enabled,
    reason,
    incident_reference: incidentReference || undefined,
    auto_expire_minutes: autoExpireMinutes ?? undefined,
  });

// Generic checker decision endpoint (request_type="circuit_breaker_change").
// The checker must also present fresh MFA step-up.
export const decideApprovalRequest = (requestId, { decision, reason, code, recoveryCode }) =>
  api.post(`/api/super-admin/approval-requests/${requestId}/decision`, {
    decision,
    reason,
    code: code || undefined,
    recovery_code: recoveryCode || undefined,
  });

// §11 — Triage lens: one pane composing incidents, pipeline stages, safety
// controls and critical events from their real upstream sources.
export const getTriageSummary = () =>
  api.get("/api/super-admin/triage/summary");
