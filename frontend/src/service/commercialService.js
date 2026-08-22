import { api } from "./api";

/**
 * Centralized Super Admin commercial-plane API client.
 *
 * Every Super Admin control-center page talks to the backend through this
 * module — components never call `fetch` directly. All endpoints are
 * Super-Admin-only on the backend (`get_current_super_admin`), so the
 * frontend routing guard is supplemental, never authoritative.
 *
 * No pricing values are invented anywhere in the UI: plans whose pricing
 * fields are NULL render as "—".
 */

// ── Platform dashboard stats ───────────────────────────────────────────
export const getPlatformDashboardStats = () =>
  api.get("/api/super-admin/dashboard/stats");

// ── Commercial accounts ────────────────────────────────────────────────
export const listCommercialAccounts = (params = {}) =>
  api.get("/api/super-admin/commercial-accounts", { params });

export const getCommercialAccount = (organizationId) =>
  api.get(`/api/super-admin/commercial-accounts/${organizationId}`);

// ── Consolidated commercial organization view (PHASE 9) ────────────────
export const getCommercialOrganizationDetail = (organizationId) =>
  api.get(`/api/super-admin/commercial-organizations/${organizationId}`);

// ── Organization identity profile (super-admin scope) ──────────────────
export const getOrganizationProfile = (organizationId) =>
  api.get(`/api/organizations/${organizationId}`);

// ── Organization lifecycle (super-admin scope) ──────────────────────────
export const createOrganization = (data) =>
  api.post("/api/organizations/", data);

export const setOrganizationStatus = (organizationId, isActive) =>
  api.patch(`/api/organizations/${organizationId}/status`, undefined, {
    params: { is_active: isActive },
  });

export const deleteOrganization = (organizationId) =>
  api.delete(`/api/organizations/${organizationId}`);

// ── Billing classification (ZB-COM-BILL-001 Phase 2) ────────────────────
export const updateBillingClassification = (organizationId, billingClassification, reason) =>
  api.patch(`/api/organizations/${organizationId}/billing-classification`, {
    billing_classification: billingClassification,
    reason,
  });

// ── Commercial plans ───────────────────────────────────────────────────
export const listCommercialPlans = (params = {}) =>
  api.get("/api/super-admin/commercial-plans", { params });

export const getCommercialPlan = (planId) =>
  api.get(`/api/super-admin/commercial-plans/${planId}`);

export const createCommercialPlan = (data) =>
  api.post("/api/super-admin/commercial-plans", data);

export const updateCommercialPlan = (planId, data) =>
  api.patch(`/api/super-admin/commercial-plans/${planId}`, data);

export const setCommercialPlanStatus = (planId, status) =>
  api.patch(`/api/super-admin/commercial-plans/${planId}/status`, { status });

export const setCommercialPlanDefault = (planId, isDefault) =>
  api.put(`/api/super-admin/commercial-plans/${planId}/default`, { is_default: isDefault });

// ── Commercial subscriptions ───────────────────────────────────────────
export const listCommercialSubscriptions = (params = {}) =>
  api.get("/api/super-admin/commercial-subscriptions", { params });

export const getCommercialSubscription = (organizationId) =>
  api.get(`/api/super-admin/commercial-subscriptions/${organizationId}`);

export const createCommercialSubscription = (data) =>
  api.post("/api/super-admin/commercial-subscriptions", data);

export const setCommercialSubscriptionStatus = (subscriptionId, status) =>
  api.patch(`/api/super-admin/commercial-subscriptions/${subscriptionId}/status`, { status });

// Phase 3F F5 — plan change supersedes the open subscription with one on the
// target plan (history preserved, both audit trails written server-side).
export const changeCommercialSubscriptionPlan = (subscriptionId, data) =>
  api.post(`/api/super-admin/commercial-subscriptions/${subscriptionId}/change-plan`, data);

// Phase 3F F10 — honest Plane 1 reporting read model (counts + MRR honesty).
export const getSaasCommercialReporting = () =>
  api.get("/api/super-admin/commercial-reporting");

// ── Platform audit logs (PHASE 11) ──────────────────────────────────────
export const listPlatformAuditLogs = (params = {}) =>
  api.get("/api/super-admin/audit-logs", { params });

// ── Subscription lifecycle audit feed (PHASE 13) ────────────────────────
// Read-only projection over billing_audit_logs (entity_type=CommercialSubscription),
// surfaced separately from the platform-plane feed above since it's a
// different underlying audit table — see backend router docstring.
export const listSubscriptionAuditLogs = (params = {}) =>
  api.get("/api/super-admin/subscription-audit-logs", { params });

// ── Super Admin platform users (actor filter options) ───────────────────
export const listSuperAdminUsers = (params = {}) =>
  api.get("/api/super-admin/users", { params });

// ── Versioned price catalog (ZB-COM-BILL-001 §T1, Phase 4) ──────────────
export const listCommercialPlanVersions = (planId) =>
  api.get(`/api/super-admin/commercial-plans/${planId}/versions`);

export const getCommercialPlanVersion = (versionId) =>
  api.get(`/api/super-admin/commercial-plan-versions/${versionId}`);

export const createCommercialPlanVersion = (planId, data) =>
  api.post(`/api/super-admin/commercial-plans/${planId}/versions`, data);

export const submitCommercialPlanVersion = (versionId, reason) =>
  api.post(`/api/super-admin/commercial-plan-versions/${versionId}/submit`, { reason });

export const approveCommercialPlanVersion = (versionId) =>
  api.post(`/api/super-admin/commercial-plan-versions/${versionId}/approve`, {});

export const rejectCommercialPlanVersion = (versionId, rejectionReason) =>
  api.post(`/api/super-admin/commercial-plan-versions/${versionId}/reject`, {
    rejection_reason: rejectionReason,
  });

export const archiveCommercialPlanVersion = (versionId) =>
  api.post(`/api/super-admin/commercial-plan-versions/${versionId}/archive`, {});

// ── Maker-checker approval queue (ZB-COM-BILL-001 Phase 5) ──────────────
export const listApprovalRequests = (params = {}) =>
  api.get("/api/super-admin/approval-requests", { params });

// ── Billing kill switch (ZB-COM-BILL-001 §30.1) ─────────────────────────
export const getBillingKillSwitch = () =>
  api.get("/api/super-admin/billing-kill-switch");

export const setBillingKillSwitch = (enabled, reason) =>
  api.put("/api/super-admin/billing-kill-switch", { enabled, reason });

// ── Production Acceptance Center (ZB-COM-BILL-001 §26) ──────────────────
export const getProductionAcceptanceReport = () =>
  api.get("/api/super-admin/production-acceptance");

// ── Phase 3A organizations workspace ────────────────────────────────────
// Directory + overview read models: identity, lifecycle and operational
// counts only — the backend never returns monetary values here, so there
// is nothing to aggregate or derive client-side.
export const listOrganizations = (params = {}) =>
  api.get("/api/super-admin/organizations", { params });

export const getOrganizationOverview = (organizationId) =>
  api.get(`/api/super-admin/organizations/${organizationId}/overview`);

// ── Phase 3C governed lifecycle transitions ─────────────────────────────
// The backend validates the transition against its state machine, records
// the mandatory reason, actor and a correlation id in the platform audit
// trail, and keeps Organization.is_active in lockstep.
export const transitionOrganizationLifecycle = (organizationId, target, reason) =>
  api.post(`/api/super-admin/organizations/${organizationId}/lifecycle-transition`, {
    target,
    reason,
  });

// ── Phase 3C platform lifecycle & onboarding (fleet-wide read model) ────
// Per-state organization counts, the onboarding pipeline with evidence-based
// readiness, blocked tenants with their last recorded transition, and recent
// lifecycle audit events — all composed server-side.
export const getPlatformLifecycle = () =>
  api.get("/api/super-admin/platform/lifecycle");
