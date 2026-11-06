import { api } from "../../service/api";
import { ENDPOINTS } from "../../service/billingEndpoints";

/**
 * Tenant Settings → Taxes (ZB-TAX-ARCH-001 Phase 5b): the tenant tax APIs
 * under /api/v1/tax. Every route is scoped to the caller's organization by
 * the backend; platform staff are refused. Proposals need org_admin /
 * billing_admin, decisions a different finance_approver: the backend
 * enforces both, the screens only reflect them.
 */

const T = "/api/v1/tax";

/** Phase 5c (gate 06). kind: registration | legal_basis | activation | classification | regime_change. */
export const getTenantEvidenceBundle = (kind, id, format = "json") =>
  api.get(`${T}/evidence-bundles/${kind}/${id}`, { params: { format } });
const page = (params = {}) => ({ params: { limit: 50, ...params } });

// ── Reference and names ────────────────────────────────────────────────
export const listJurisdictions = ({ cursor } = {}) => api.get(`${T}/jurisdictions`, page({ cursor, limit: 200 }));
export const listTaxTypes = ({ cursor } = {}) => api.get(`${T}/tax-types`, page({ cursor, limit: 200 }));
export const listPeople = ({ cursor } = {}) => api.get(`${T}/people`, page({ cursor, limit: 200 }));
export const listCoverage = ({ cursor } = {}) => api.get(`${T}/coverage`, page({ cursor, limit: 200 }));
export const listTaxCodes = () => api.get(`${T}/tax-codes`);

// ── T1/T2 legal entities and T5 regime ─────────────────────────────────
export const listLegalEntities = ({ cursor } = {}) => api.get(`${T}/legal-entities`, page({ cursor }));
export const createLegalEntity = (body) => api.post(`${T}/legal-entities`, body);
export const updateLegalEntity = (id, body) => api.patch(`${T}/legal-entities/${id}`, body);
export const setDefaultLegalEntity = (id) => api.post(`${T}/legal-entities/${id}/set-default`);
export const getRegimeEligibility = (id) => api.get(`${T}/legal-entities/${id}/regime-eligibility`);
export const proposeRegimeChange = (id, body) => api.post(`${T}/legal-entities/${id}/regime`, body);
export const listRegimeChanges = ({ seller_entity_id, cursor } = {}) =>
  api.get(`${T}/regime-changes`, page({ seller_entity_id, cursor }));
export const decideRegimeChange = (id, approve, body = {}) =>
  api.post(`${T}/regime-changes/${id}/${approve ? "approve" : "reject"}`, body);
export const withdrawRegimeChange = (id) => api.post(`${T}/regime-changes/${id}/withdraw`);

// ── T3 registrations and legal bases ───────────────────────────────────
export const listRegistrations = ({ seller_entity_id, cursor } = {}) =>
  api.get(`${T}/registrations`, page({ seller_entity_id, cursor }));
export const createRegistration = (body) => api.post(`${T}/registrations`, body);
export const listLegalBases = ({ cursor } = {}) => api.get(`${T}/legal-bases`, page({ cursor }));
export const proposeLegalBasis = (body) => api.post(`${T}/legal-bases`, body);
export const decideLegalBasis = (id, approve, body = {}) =>
  api.post(`${T}/legal-bases/${id}/${approve ? "approve" : "reject"}`, body);
export const withdrawLegalBasis = (id) => api.post(`${T}/legal-bases/${id}/withdraw`);

/** kind: registrations | legal-bases | exemption-certificates | manual-resolutions */
export function uploadEvidence(kind, id, file, sha256) {
  const form = new FormData();
  form.append("file", file);
  if (sha256) form.append("sha256", sha256);
  return api.post(`${T}/${kind}/${id}/evidence`, form);
}

// ── T4 activations ─────────────────────────────────────────────────────
export const listActivations = ({ seller_entity_id, cursor } = {}) =>
  api.get(`${T}/activations`, page({ seller_entity_id, cursor }));
export const proposeActivation = (body) => api.post(`${T}/activations`, body);
export const decideActivation = (id, approve, body = {}) =>
  api.post(`${T}/activations/${id}/${approve ? "approve" : "reject"}`, body);
export const withdrawActivation = (id) => api.post(`${T}/activations/${id}/withdraw`);
export const getActivationEffective = (id, on) => api.get(`${T}/activations/${id}/effective`, { params: { date: on } });
export const listProviderConnections = ({ seller_entity_id, cursor } = {}) =>
  api.get(`${T}/provider-connections`, page({ seller_entity_id, cursor }));

// ── T6 product classification ──────────────────────────────────────────
export const listClassifications = ({ cursor } = {}) => api.get(`${T}/product-classifications`, page({ cursor }));
export const proposeClassification = (body) => api.post(`${T}/product-classifications`, body);
export const previewClassificationImpact = (productIds) =>
  api.post(`${T}/product-classifications/impact-preview`, { product_ids: productIds });
export const decideClassification = (id, approve, body = {}) =>
  api.post(`${T}/product-classifications/${id}/${approve ? "approve" : "reject"}`, body);
export const withdrawClassification = (id) => api.post(`${T}/product-classifications/${id}/withdraw`);
export const searchProducts = (search) => api.get(ENDPOINTS.PRODUCTS, { params: { search_term: search || undefined, per_page: 50 } });

// ── T7 customer tax evidence ───────────────────────────────────────────
export const searchCustomers = (search) => api.get(ENDPOINTS.CUSTOMERS, { params: { search_term: search || undefined, per_page: 50 } });
export const getCustomerTaxEvidence = (customerId) => api.get(`${T}/customers/${customerId}/tax-evidence`);
export const recordTaxAddress = (customerId, body) => api.post(`${T}/customers/${customerId}/tax-addresses`, body);
export const resolveTaxAddress = (customerId, addressId) =>
  api.post(`${T}/customers/${customerId}/tax-addresses/${addressId}/resolve`);
export const proposeManualResolution = (customerId, addressId, body) =>
  api.post(`${T}/customers/${customerId}/tax-addresses/${addressId}/manual-resolutions`, body);
export const listManualResolutions = ({ address_id, cursor } = {}) =>
  api.get(`${T}/manual-resolutions`, page({ address_id, cursor }));
export const decideManualResolution = (id, approve, body = {}) =>
  api.post(`${T}/manual-resolutions/${id}/${approve ? "approve" : "reject"}`, body);
export const withdrawManualResolution = (id) => api.post(`${T}/manual-resolutions/${id}/withdraw`);
export const addTaxId = (customerId, body) => api.post(`${T}/customers/${customerId}/tax-ids`, body);
export const retireTaxId = (id) => api.post(`${T}/tax-ids/${id}/retire`);
export const addCertificate = (customerId, body) => api.post(`${T}/customers/${customerId}/exemption-certificates`, body);
export const revokeCertificate = (id) => api.post(`${T}/exemption-certificates/${id}/revoke`);

// ── T8 review items ────────────────────────────────────────────────────
export const listReviewItems = ({ include_resolved, cursor } = {}) =>
  api.get(`${T}/review-items`, page({ include_resolved, cursor }));
export const resolveReviewItem = (id) => api.post(`${T}/review-items/${id}/resolve`);

// ── Phase 5c: T10 reports (org admin, finance approver) ─────────────────
/** format: json | csv (an audited export). */
export const getOvercollectionReport = (format = "json") =>
  api.get(`${T}/reports/legacy-discount-overcollection`, { params: { format } });
export const getDuplicateRowsReport = (format = "json") =>
  api.get(`${T}/reports/duplicate-tax-rows`, { params: { format } });

// ── Phase 5c: provider connections (credentials are write-only) ─────────
export const listProviders = () => api.get(`${T}/providers`);
export const proposeProviderConnection = (body) => api.post(`${T}/provider-connections`, body);
/** action: approve | reject | withdraw | resume | resume-approve | resume-reject | test */
export const providerConnectionAction = (id, action, body) =>
  api.post(`${T}/provider-connections/${id}/${action}`, body);
export const decideProviderConnection = (id, approve, body = {}) =>
  providerConnectionAction(id, approve ? "approve" : "reject", body);
export const withdrawProviderConnection = (id) => providerConnectionAction(id, "withdraw");
export const setProviderCredentials = (id, secret) => api.put(`${T}/provider-connections/${id}/credentials`, { secret });
export const revokeProviderCredentials = (id, reason) =>
  api.post(`${T}/provider-connections/${id}/credentials/revoke`, { reason });

// ── Phase 5c: provider transactions (the stuck-transaction view) ────────
export const listProviderTransactions = ({ state, cursor } = {}) =>
  api.get(`${T}/provider-transactions`, page({ state: state || undefined, cursor }));
/** action: check-state | retry | void-request | void-approve (void-approve carries the MFA factor). */
export const providerTransactionAction = (id, action, body) =>
  api.post(`${T}/provider-transactions/${id}/${action}`, body);

// ── Phase 5c PR 3: T9 reference rates; connection mode change ───────────
export const lookupReferenceRates = ({ jurisdiction_id, as_of }) =>
  api.get(`${T}/rates`, { params: { jurisdiction_id, as_of: as_of || undefined } });
/** mode: ESTIMATE_ONLY (safe mode) | COMMIT; same connection and credentials. */
export const requestModeChange = (id, mode, reason) =>
  api.post(`${T}/provider-connections/${id}/mode-change`, { mode, reason });
/** Approve needs MFA step-up (code / recovery_code in body); reject needs a reason. */
export const decideModeChange = (id, approve, body = {}) =>
  api.post(`${T}/provider-connections/${id}/mode-change/${approve ? "approve" : "reject"}`, body);
export const withdrawModeChange = (id) => api.post(`${T}/provider-connections/${id}/mode-change/withdraw`);

// ── Phase 5d PR 2: tenant MFA (step-up only; login is unchanged) ────────
const AUTH = "/api/auth/mfa";
export const getMfaStatus = () => api.get(`${AUTH}/status`);
export const startMfa = () => api.post(`${AUTH}/setup/start`);
export const verifyMfa = (code) => api.post(`${AUTH}/setup/verify`, { code });
export const disableMfa = (currentPassword) => api.post(`${AUTH}/disable`, { current_password: currentPassword });
export const listMfaUsers = () => api.get(`${T}/mfa/users`);
export const requestMfaReset = (userId, reason) => api.post(`${T}/mfa/users/${userId}/reset-request`, { reason });
export const approveMfaReset = (userId) => api.post(`${T}/mfa/users/${userId}/reset-approve`);
export const cancelMfaReset = (userId) => api.post(`${T}/mfa/users/${userId}/reset-cancel`);
