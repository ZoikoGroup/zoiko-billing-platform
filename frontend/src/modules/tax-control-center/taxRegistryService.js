import { api } from "../../service/api";

/**
 * Tax Control Center (ZB-TAX-ARCH-001 Phase 5a): the platform tax registry
 * API. Platform data only; every route needs a tax registry capability on
 * the backend (TAX_REVIEWER reads and drafts, TAX_PUBLISHER approves and
 * publishes). The backend enforces maker-checker and MFA step-up; the UI
 * only reflects them.
 *
 * Lists follow the B3 cursor contract: `{ items, next_cursor }`, 50 items
 * by default. Callers page with `cursor` until `next_cursor` is null.
 */

const BASE = "/api/v1/super-admin/tax-registry";

// ── Audit-evidence bundles (Phase 5c, gate 06) ──────────────────────────
/** kind: source_revision | rate | tax_code_set | rule_pack | market_availability; format: json | html. */
export const getEvidenceBundle = (kind, id, format = "json") =>
  api.get(`${BASE}/evidence-bundles/${kind}/${id}`, { params: { format } });

// ── Lists (B3: limit + cursor) ──────────────────────────────────────────
export const listApprovalsInbox = ({ kind, cursor } = {}) =>
  api.get(`${BASE}/approvals-inbox`, { params: { kind, cursor } });

export const listSourceRevisions = ({ cursor } = {}) =>
  api.get(`${BASE}/source-revisions`, { params: { cursor } });

export const listStagedRates = ({ status, cursor } = {}) =>
  api.get(`${BASE}/staged-rates`, { params: { status, cursor } });

export const listMarketAvailability = ({ status, cursor } = {}) =>
  api.get(`${BASE}/market-availability`, { params: { status, cursor } });

export const listRulePacks = ({ cursor } = {}) =>
  api.get(`${BASE}/rule-packs`, { params: { cursor } });

export const getRulePackCatalogue = () => api.get(`${BASE}/rule-packs/catalogue`);

export const listJurisdictions = ({ cursor } = {}) =>
  api.get("/api/v1/tax/jurisdictions", { params: { cursor, limit: 200 } });

// Phase 5b (G-5a-1, G-5a-3): read-only pickers and tax-staff names.
export const listAuthorities = ({ cursor } = {}) => api.get(`${BASE}/authorities`, { params: { cursor, limit: 200 } });
export const listTaxTypes = ({ cursor } = {}) => api.get(`${BASE}/tax-types`, { params: { cursor, limit: 200 } });
export const listComponents = ({ cursor } = {}) => api.get(`${BASE}/components`, { params: { cursor, limit: 200 } });
export const listTaxPeople = ({ cursor } = {}) => api.get(`${BASE}/people`, { params: { cursor, limit: 200 } });

/** Every page of a B3 list (small reference lists only). */
export async function fetchAllPages(fetchPage, maxPages = 25) {
  const all = [];
  let cursor;
  for (let i = 0; i < maxPages; i += 1) {
    const data = await fetchPage({ cursor });
    all.push(...(data?.items || []));
    if (!data?.next_cursor) break;
    cursor = data.next_cursor;
  }
  return all;
}

// ── Source register (P2) ────────────────────────────────────────────────
export const registerSourceRevision = (body) => api.post(`${BASE}/source-revisions`, body);

export function attachSourceEvidence(revisionId, file, redistributionPermission) {
  const form = new FormData();
  form.append("file", file);
  form.append("redistribution_permission", redistributionPermission);
  return api.post(`${BASE}/source-revisions/${revisionId}/evidence`, form);
}

// ── Rates and change review (P3) ────────────────────────────────────────
export const getStagedRate = (id) => api.get(`${BASE}/staged-rates/${id}`);
export const getStagedRateComparison = (id) => api.get(`${BASE}/staged-rates/${id}/comparison`);
export const stageRate = (body) => api.post(`${BASE}/staged-rates`, body);
export const amendStagedRate = (id, body) => api.patch(`${BASE}/staged-rates/${id}`, body);

/** action: adopt | validate | submit | approve | reject | publish */
export function stagedRateAction(id, action, body = {}) {
  return api.post(`${BASE}/staged-rates/${id}/${action}`, body);
}

// ── Market availability (P6) ────────────────────────────────────────────
export const draftAvailability = (body) => api.post(`${BASE}/market-availability`, body);
export const amendAvailability = (id, body) => api.patch(`${BASE}/market-availability/${id}`, body);

/** action: validate | submit | approve | reject | publish */
export function availabilityAction(id, action, body = {}) {
  return api.post(`${BASE}/market-availability/${id}/${action}`, body);
}

// ── Rule packs (P7) ─────────────────────────────────────────────────────
export const registerRulePack = (body) => api.post(`${BASE}/rule-packs`, body);
export const amendRulePack = (id, body) => api.patch(`${BASE}/rule-packs/${id}`, body);

/** action: validate | submit | approve | reject | publish */
export function rulePackAction(id, action, body = {}) {
  return api.post(`${BASE}/rule-packs/${id}/${action}`, body);
}

/** The approve route for an inbox item of the given kind. */
export function approveInboxItem(kind, id, body) {
  if (kind === "staged_rate") return stagedRateAction(id, "approve", body);
  if (kind === "market_availability") return availabilityAction(id, "approve", body);
  if (kind === "rule_pack") return rulePackAction(id, "approve", body);
  if (kind === "tax_code_set") return api.post(`${BASE}/tax-code-sets/${id}/approve`, body);
  throw new Error(`Unknown approval kind: ${kind}`);
}

// ── Phase 5c: P9 provider operations and P10 findings (aggregate only) ──
export const getProviderHealth = () => api.get(`${BASE}/provider-health`);
/** action: suspend (reason required) | resume; both need TAX_PUBLISHER and MFA step-up. */
export const providerHealthAction = (provider, action, body = {}) =>
  api.post(`${BASE}/provider-health/${encodeURIComponent(provider)}/${action}`, body);
export const getPlatformOvercollection = () => api.get(`${BASE}/reports/legacy-discount-overcollection`);
export const getPlatformDuplicates = () => api.get(`${BASE}/reports/duplicate-tax-rows`);
