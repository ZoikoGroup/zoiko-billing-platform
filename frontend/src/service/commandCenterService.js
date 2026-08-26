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

export const escalateAttentionItem = (itemId, reason) =>
  api.post(`/api/super-admin/attention/${itemId}/escalate`, { reason });

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

export const getFinancialConsistency = () =>
  api.get("/api/super-admin/financial-consistency");

export const getFinancialOperationsSummary = () =>
  api.get("/api/super-admin/financial-operations");

// ZB-SA-CMD-003 — Billing Command Center (Domain B read models) backing the
// /super-admin/billing-command-center page.
export const getBillingCommandOverview = () =>
  api.get("/api/super-admin/billing-command-center/overview");

export const getBillingCommandTrend = (granularity, currency) =>
  api.get("/api/super-admin/billing-command-center/trend", {
    params: { granularity, currency: currency || undefined },
  });

export const listBillingOverdueInvoices = (limit = 10) =>
  api.get("/api/super-admin/billing-command-center/overdue-invoices", {
    params: { limit },
  });

export const listBillingCollectionsRisk = (limit = 10) =>
  api.get("/api/super-admin/billing-command-center/collections-risk", {
    params: { limit },
  });

export const listBillingRecentActivity = (limit = 8) =>
  api.get("/api/super-admin/billing-command-center/recent-activity", {
    params: { limit },
  });

// Phase 4 (G-05) — real server-side latency + error-rate telemetry for
// /api/super-admin/* (sliding window; single-process, resets on restart).
export const getApiTelemetry = () =>
  api.get("/api/super-admin/telemetry/api");

// Phase 4 (G-03) — configuration governance inventory: DB-backed platform
// settings, code-declared operational thresholds, and environment capability
// status (presence only). Requires the platform_config.read capability.
export const getConfigurationInventory = () =>
  api.get("/api/super-admin/configuration");

export const getLaunchReadiness = () =>
  api.get("/api/super-admin/launch-readiness");

// ── Financial Operations detail pages — Invoice Engine, Payments &
// Disputes, Balances & Allocations, Credits/Adjustments/Refunds, Tax.
// Cross-tenant read models backing the 7 Financial Operations sub-pages.

export const getInvoiceStatusDistribution = () =>
  api.get("/api/super-admin/financial-operations/invoice-status-distribution");

export const getInvoiceDeliveryDiagnostics = () =>
  api.get("/api/super-admin/financial-operations/invoice-delivery-diagnostics");

export const listFailedPayments = (limit = 50) =>
  api.get("/api/super-admin/financial-operations/failed-payments", { params: { limit } });

export const listDunningCases = (limit = 50) =>
  api.get("/api/super-admin/financial-operations/dunning-cases", { params: { limit } });

export const listAllocationExceptions = (limit = 50) =>
  api.get("/api/super-admin/financial-operations/allocation-exceptions", { params: { limit } });

export const listCreditApplications = (limit = 50) =>
  api.get("/api/super-admin/financial-operations/credit-applications", { params: { limit } });

export const listCreditNotesAdmin = (limit = 50) =>
  api.get("/api/super-admin/financial-operations/credit-notes", { params: { limit } });

export const listRefundsAdmin = (limit = 50) =>
  api.get("/api/super-admin/financial-operations/refunds", { params: { limit } });

export const listWriteOffsAdmin = (limit = 50) =>
  api.get("/api/super-admin/financial-operations/write-offs", { params: { limit } });

export const getTaxSummary = (dateFrom, dateTo) =>
  api.get("/api/super-admin/financial-operations/tax-summary", {
    params: { date_from: dateFrom || undefined, date_to: dateTo || undefined },
  });

// ── Reconciliation (REC-01) ─────────────────────────────────────────────

export const triggerReconciliationRun = () =>
  api.post("/api/super-admin/reconciliation-runs/run", {});

export const listReconciliationRuns = (limit = 10) =>
  api.get("/api/super-admin/reconciliation-runs", { params: { limit } });

export const getReconciliationRun = (runId) =>
  api.get(`/api/super-admin/reconciliation-runs/${runId}`);

export const acknowledgeReconciliationException = (exceptionId, note) =>
  api.post(`/api/super-admin/reconciliation-exceptions/${exceptionId}/acknowledge`, {
    note: note || undefined,
  });

export const resolveReconciliationException = (exceptionId, note) =>
  api.post(`/api/super-admin/reconciliation-exceptions/${exceptionId}/resolve`, { note });

// ── Plane 1 Commercial Billing ─────────────────────────────────────────

// Quotes
export const createCommercialQuote = (data) =>
  api.post("/api/super-admin/commercial-billing/quotes", data);

export const listCommercialQuotes = (params = {}) =>
  api.get("/api/super-admin/commercial-billing/quotes", { params });

export const getCommercialQuote = (quoteId) =>
  api.get(`/api/super-admin/commercial-billing/quotes/${quoteId}`);

export const sendCommercialQuote = (quoteId) =>
  api.post(`/api/super-admin/commercial-billing/quotes/${quoteId}/send`, {});

export const approveCommercialQuote = (quoteId) =>
  api.post(`/api/super-admin/commercial-billing/quotes/${quoteId}/approve`, {});

export const rejectCommercialQuote = (quoteId, reason) =>
  api.post(`/api/super-admin/commercial-billing/quotes/${quoteId}/reject`, { reason });

export const convertCommercialQuote = (quoteId, dueDate) =>
  api.post(`/api/super-admin/commercial-billing/quotes/${quoteId}/convert`, null, {
    params: dueDate ? { due_date: dueDate } : {},
  });

export const addCommercialQuoteItem = (quoteId, data) =>
  api.post(`/api/super-admin/commercial-billing/quotes/${quoteId}/items`, data);

export const setCommercialQuoteDiscount = (quoteId, data) =>
  api.post(`/api/super-admin/commercial-billing/quotes/${quoteId}/discount`, data);

// Platform Invoices
export const createPlatformInvoice = (data) =>
  api.post("/api/super-admin/commercial-billing/invoices", data);

export const listPlatformInvoices = (params = {}) =>
  api.get("/api/super-admin/commercial-billing/invoices", { params });

export const getPlatformInvoice = (invoiceId) =>
  api.get(`/api/super-admin/commercial-billing/invoices/${invoiceId}`);

export const finalizePlatformInvoice = (invoiceId) =>
  api.post(`/api/super-admin/commercial-billing/invoices/${invoiceId}/finalize`, {});

export const voidPlatformInvoice = (invoiceId, reason) =>
  api.post(`/api/super-admin/commercial-billing/invoices/${invoiceId}/void`, { reason });

export const sendPlatformInvoice = (invoiceId) =>
  api.post(`/api/super-admin/commercial-billing/invoices/${invoiceId}/send`, {});

export const addPlatformInvoiceItem = (invoiceId, data) =>
  api.post(`/api/super-admin/commercial-billing/invoices/${invoiceId}/items`, data);

// Platform Payments
export const recordPlatformPayment = (data) =>
  api.post("/api/super-admin/commercial-billing/payments", data);

export const listPlatformPayments = (params = {}) =>
  api.get("/api/super-admin/commercial-billing/payments", { params });

export const allocatePlatformPayment = (paymentId, invoiceId, amount) =>
  api.post(`/api/super-admin/commercial-billing/payments/${paymentId}/allocate`, {
    invoice_id: invoiceId,
    amount,
  });

export const deallocatePlatformPayment = (paymentId, invoiceId) =>
  api.post(`/api/super-admin/commercial-billing/payments/${paymentId}/deallocate`, null, {
    params: { invoice_id: invoiceId },
  });

// Platform Reconciliation
export const triggerPlatformReconciliation = () =>
  api.post("/api/super-admin/commercial-billing/reconciliation/run", {});

export const listPlatformReconciliationRuns = (limit = 20) =>
  api.get("/api/super-admin/commercial-billing/reconciliation/runs", { params: { limit } });

// Evaluation Programs (§B3)
export const listEvaluationPrograms = () =>
  api.get("/api/super-admin/commercial-billing/evaluation-programs");

export const createEvaluationProgram = (data) =>
  api.post("/api/super-admin/commercial-billing/evaluation-programs", data);

export const setEvaluationProgramStatus = (programId, isActive) =>
  api.patch(`/api/super-admin/commercial-billing/evaluation-programs/${programId}/status`, { is_active: isActive });
