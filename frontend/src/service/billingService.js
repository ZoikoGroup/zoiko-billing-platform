import { api } from "./api";
import { ENDPOINTS } from "./billingEndpoints";

function buildUrl(base, params = {}) {
  const query = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return query ? `${base}?${query}` : base;
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function normalizePricingPlanPayload(data = {}, { isCreate = false } = {}) {
  const billingPeriod = data.billing_period || data.billing_frequency || data.billing_interval || "monthly";
  const pricingModel = data.pricing_model || data.plan_type || "flat";
  const price = data.unit_price ?? data.price;
  const normalized = {
    ...data,
    billing_period: billingPeriod,
    pricing_model: pricingModel,
    unit_price: price,
    flat_fee: data.flat_fee ?? (pricingModel === "flat" ? price : 0),
    setup_fee: data.setup_fee ?? 0,
    trial_days: data.trial_days ?? 0,
    min_quantity: data.min_quantity ?? 1,
    product_id: data.product_id ? Number(data.product_id) : undefined,
  };
  if (data.status) normalized.is_active = data.status === "active";
  if (isCreate) normalized.effective_from = data.effective_from || todayIsoDate();
  if (Object.prototype.hasOwnProperty.call(data, "effective_to")) {
    normalized.effective_to = data.effective_to || null;
  }

  delete normalized.price;
  delete normalized.currency;
  delete normalized.description;
  delete normalized.billing_frequency;
  delete normalized.billing_interval;
  delete normalized.plan_type;
  delete normalized.status;
  return normalized;
}

function normalizePricingPlanResponse(plan = {}) {
  const price = plan.price ?? plan.unit_price ?? plan.flat_fee ?? null;
  const billingFrequency = plan.billing_frequency || plan.billing_period || "monthly";
  const planType = plan.plan_type || plan.pricing_model || "flat";
  return {
    ...plan,
    price,
    billing_frequency: billingFrequency,
    billing_interval: billingFrequency,
    plan_type: planType,
    status: plan.status || (plan.is_active === false ? "inactive" : "active"),
  };
}

function normalizePricingPlanList(data) {
  if (Array.isArray(data)) return data.map(normalizePricingPlanResponse);
  if (data?.items) {
    return { ...data, items: data.items.map(normalizePricingPlanResponse) };
  }
  return data;
}

export const settingsApi = {
  get: () => api.get(ENDPOINTS.SETTINGS),
  update: (data) => api.put(ENDPOINTS.SETTINGS, data),
  getConfig: () => api.get(ENDPOINTS.SETTINGS_CONFIG),
  updateConfig: (data) => api.put(ENDPOINTS.SETTINGS_CONFIG, data),
  resetConfig: () => api.post(ENDPOINTS.SETTINGS_CONFIG_RESET),
  validateConfig: () => api.get(ENDPOINTS.SETTINGS_CONFIG_VALIDATE),
  getExchangeRates: () => api.get(ENDPOINTS.SETTINGS_EXCHANGE_RATES),
  refreshExchangeRates: (baseCurrency) => {
    const params = baseCurrency ? `?base_currency=${encodeURIComponent(baseCurrency)}` : '';
    return api.post(`${ENDPOINTS.SETTINGS_EXCHANGE_RATES_REFRESH}${params}`);
  },
  getExchangeRatePair: (from, to) =>
    api.get(`${ENDPOINTS.SETTINGS_EXCHANGE_RATES_PAIR}?from_currency=${encodeURIComponent(from)}&to_currency=${encodeURIComponent(to)}`),
  getSupportedCurrencies: () => api.get(ENDPOINTS.SETTINGS_EXCHANGE_RATES_SUPPORTED),

  // ── Phase 5C.4: Admin / Diagnostics ────────────────────────────────────
  testSmtp: (data) => api.post(ENDPOINTS.SETTINGS_ADMIN_SMTP_TEST, data),
  listEmailTemplates: () => api.get(ENDPOINTS.SETTINGS_ADMIN_EMAIL_TEMPLATES),
  previewEmailTemplate: (name, variables) => {
    const params = variables ? `?variables=${encodeURIComponent(JSON.stringify(variables))}` : '';
    return api.get(`${ENDPOINTS.SETTINGS_ADMIN_EMAIL_TEMPLATE_PREVIEW(name)}${params}`);
  },
  getNumberingDiagnostics: () => api.get(ENDPOINTS.SETTINGS_ADMIN_NUMBERING_DIAGNOSTICS),
  getTaxDiagnostics: () => api.get(ENDPOINTS.SETTINGS_ADMIN_TAX_DIAGNOSTICS),
  getExchangeRateDiagnostics: () => api.get(ENDPOINTS.SETTINGS_ADMIN_EXCHANGE_RATE_DIAGNOSTICS),
  getHealth: () => api.get(ENDPOINTS.SETTINGS_ADMIN_HEALTH),
  validateFull: () => api.post(ENDPOINTS.SETTINGS_ADMIN_VALIDATE),
};

export const dashboardApi = {
  getFull: (period, range) => api.get(buildUrl(ENDPOINTS.DASHBOARD, { ...(period ? { period } : {}), ...(range || {}) })),
  getKPIs: (period, range) => api.get(buildUrl(ENDPOINTS.DASHBOARD_KPIS, { ...(period ? { period } : {}), ...(range || {}) })),
  getMonthlyRevenue: (months = 12, period, range) =>
    api.get(buildUrl(ENDPOINTS.DASHBOARD_REVENUE, { months, ...(period ? { period } : {}), ...(range || {}) })),
  getPaymentTrend: (period, range) =>
    api.get(buildUrl(ENDPOINTS.DASHBOARD_PAYMENT_TREND, { ...(period ? { period } : {}), ...(range || {}) })),
};

export const customerApi = {
  list: (params) => api.get(buildUrl(ENDPOINTS.CUSTOMERS, params)),
  search: (term, limit = 20) =>
    api.get(buildUrl(ENDPOINTS.CUSTOMER_SEARCH, { term, limit })),
  get: (id) => api.get(ENDPOINTS.CUSTOMER(id)),
  create: (data) => api.post(ENDPOINTS.CUSTOMERS, data),
  update: (id, data) => api.put(ENDPOINTS.CUSTOMER(id), data),
  hardDelete: (id) => api.delete(ENDPOINTS.CUSTOMER_HARD_DELETE(id)),
  restore: (id) => api.put(ENDPOINTS.CUSTOMER_RESTORE(id)),
  activate: (id) => api.put(ENDPOINTS.CUSTOMER_ACTIVATE(id)),
  deactivate: (id) => api.put(ENDPOINTS.CUSTOMER_DEACTIVATE(id)),
  suspend: (id) => api.put(ENDPOINTS.CUSTOMER_SUSPEND(id)),
  bulkDelete: (ids) => api.post(ENDPOINTS.CUSTOMER_BULK_DELETE, { ids }),
  bulkStatus: (ids, status) => api.post(ENDPOINTS.CUSTOMER_BULK_STATUS, { ids, status }),
  exportData: (format) => api.get(buildUrl(ENDPOINTS.CUSTOMER_EXPORT, { format })),
  importData: (formData) => api.post(ENDPOINTS.CUSTOMER_IMPORT, formData),
  getActivity: (id) => api.get(ENDPOINTS.CUSTOMER_ACTIVITY(id)),
  listContacts: (id) => api.get(ENDPOINTS.CUSTOMER_CONTACTS(id)),
  addContact: (id, data) => api.post(ENDPOINTS.CUSTOMER_CONTACTS(id), data),
  updateContact: (cid, contactId, data) =>
    api.put(ENDPOINTS.CUSTOMER_CONTACT(cid, contactId), data),
  removeContact: (cid, contactId) =>
    api.delete(ENDPOINTS.CUSTOMER_CONTACT(cid, contactId)),
  setPrimaryContact: (cid, contactId) =>
    api.put(ENDPOINTS.CUSTOMER_CONTACT_PRIMARY(cid, contactId)),
  getKPI: (period, range) => api.get(buildUrl(ENDPOINTS.CUSTOMER_KPI, { ...(period ? { period } : {}), ...(range || {}) })),
  adjustCreditBalance: (id, data) => api.post(ENDPOINTS.CUSTOMER_CREDIT_BALANCE(id), data),
  listDocuments: (id) => api.get(ENDPOINTS.CUSTOMER_DOCUMENTS(id)),
  addDocument: (id, data) => api.post(ENDPOINTS.CUSTOMER_DOCUMENTS(id), data),
  deleteDocument: (cid, docId) => api.delete(ENDPOINTS.CUSTOMER_DOCUMENT(cid, docId)),
  listNotes: (id) => api.get(ENDPOINTS.CUSTOMER_NOTES(id)),
  addNote: (id, data) => api.post(ENDPOINTS.CUSTOMER_NOTES(id), data),
  updateNote: (cid, noteId, data) => api.put(ENDPOINTS.CUSTOMER_NOTE(cid, noteId), data),
  deleteNote: (cid, noteId) => api.delete(ENDPOINTS.CUSTOMER_NOTE(cid, noteId)),
  getAnalytics: (id) => api.get(ENDPOINTS.CUSTOMER_ANALYTICS(id)),
  importFile: (formData) => api.post(ENDPOINTS.CUSTOMER_IMPORT_FILE, formData, { headers: { 'Content-Type': 'multipart/form-data' } }),
  getStatement: (id, params) => api.get(buildUrl(ENDPOINTS.CUSTOMER_STATEMENT(id), params)),
};

export const productApi = {
  listCategories: (params) =>
    api.get(buildUrl(ENDPOINTS.PRODUCT_CATEGORIES, params)),
  getCategory: (id) => api.get(ENDPOINTS.PRODUCT_CATEGORY(id)),
  createCategory: (data) => api.post(ENDPOINTS.PRODUCT_CATEGORIES, data),
  updateCategory: (id, data) => api.put(ENDPOINTS.PRODUCT_CATEGORY(id), data),
  deleteCategory: (id) => api.delete(ENDPOINTS.PRODUCT_CATEGORY(id)),
  listChildCategories: (parentId) =>
    api.get(ENDPOINTS.PRODUCT_CATEGORY_CHILDREN(parentId)),
  list: (params) => api.get(buildUrl(ENDPOINTS.PRODUCTS, params)),
  get: (id) => api.get(ENDPOINTS.PRODUCT(id)),
  create: (data) => api.post(ENDPOINTS.PRODUCTS, data),
  update: (id, data) => api.put(ENDPOINTS.PRODUCT(id), data),
  delete: (id) => api.delete(ENDPOINTS.PRODUCT(id)),
  restore: (id) => api.post(ENDPOINTS.PRODUCT_RESTORE(id)),
  duplicate: (id) => api.post(ENDPOINTS.PRODUCT_DUPLICATE(id)),
  bulkStatus: (ids, status) => api.post(ENDPOINTS.PRODUCT_BULK_STATUS, { ids, status }),
  bulkDelete: (ids) => api.post(ENDPOINTS.PRODUCT_BULK_DELETE, { ids }),
  listSubscribable: () => api.get(ENDPOINTS.PRODUCT_SUBSCRIBABLE),
  listUsageBillable: () => api.get(ENDPOINTS.PRODUCT_USAGE_BILLABLE),
  // ── Phase 5B: Import / Export ────────────────────────────────────────────
  importPreview: (formData) =>
    api.post(ENDPOINTS.PRODUCT_IMPORT_PREVIEW, formData),
  importConfirm: (data) => api.post(ENDPOINTS.PRODUCT_IMPORT_CONFIRM, data),
  downloadTemplate: async (format = "csv") => {
    const { apiRequest, getAccessToken, API_BASE_URL } = await import("./api");
    const url = `${API_BASE_URL}${ENDPOINTS.PRODUCT_IMPORT_TEMPLATE}?format=${format}`;
    const token = getAccessToken();
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error("Template download failed");
    const blob = await res.blob();
    const ext = format === "xlsx" ? "xlsx" : "csv";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `product_import_template.${ext}`;
    a.click();
    URL.revokeObjectURL(a.href);
  },
  exportCatalog: async (data) => {
    const { getAccessToken, API_BASE_URL } = await import("./api");
    const url = `${API_BASE_URL}${ENDPOINTS.PRODUCT_EXPORT}`;
    const token = getAccessToken();
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error("Export failed");
    const blob = await res.blob();
    const ext = data.format === "xlsx" ? "xlsx" : "csv";
    const date = new Date().toISOString().split("T")[0];
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `products-${date}.${ext}`;
    a.click();
    URL.revokeObjectURL(a.href);
  },
};

export const pricingApi = {
  list: async (params) => normalizePricingPlanList(await api.get(buildUrl(ENDPOINTS.PRICING_PLANS, params))),
  get: async (id) => normalizePricingPlanResponse(await api.get(ENDPOINTS.PRICING_PLAN(id))),
  create: async (data) =>
    normalizePricingPlanResponse(
      await api.post(ENDPOINTS.PRICING_PLANS, normalizePricingPlanPayload(data, { isCreate: true }))
    ),
  update: async (id, data) =>
    normalizePricingPlanResponse(
      await api.put(ENDPOINTS.PRICING_PLAN(id), normalizePricingPlanPayload(data))
    ),
  deactivate: (id) => api.delete(ENDPOINTS.PRICING_PLAN(id)),
  activate: async (id) =>
    normalizePricingPlanResponse(
      await api.put(ENDPOINTS.PRICING_PLAN(id), { is_active: true })
    ),
  listByProduct: (productId) =>
    api.get(ENDPOINTS.PRICING_PLANS_BY_PRODUCT(productId)).then(normalizePricingPlanList),
  resolvePrice: (data) => api.post(ENDPOINTS.PRICING_PLANS_RESOLVE, data),
  addTier: (planId, data) =>
    api.post(ENDPOINTS.PRICING_PLAN_TIERS(planId), data),
  listTiers: (planId) => api.get(ENDPOINTS.PRICING_PLAN_TIERS(planId)),
  removeTier: (planId, tierId) =>
    api.delete(ENDPOINTS.PRICING_PLAN_TIER(planId, tierId)),
};

export const priceListApi = {
  list: (params) => api.get(buildUrl(ENDPOINTS.PRICE_LISTS, params)),
  get: (id) => api.get(ENDPOINTS.PRICE_LIST(id)),
  getDefault: () => api.get(ENDPOINTS.PRICE_LIST_DEFAULT),
  create: (data) => api.post(ENDPOINTS.PRICE_LISTS, data),
  update: (id, data) => api.put(ENDPOINTS.PRICE_LIST(id), data),
  deactivate: (id) => api.delete(ENDPOINTS.PRICE_LIST(id)),
  activate: (id) => api.post(`${ENDPOINTS.PRICE_LIST(id)}/activate`),
  listItems: (id) => api.get(ENDPOINTS.PRICE_LIST_ITEMS(id)),
  addItem: (id, data) => api.post(ENDPOINTS.PRICE_LIST_ITEMS(id), data),
  updateItem: (pid, iid, data) => api.put(ENDPOINTS.PRICE_LIST_ITEM(pid, iid), data),
  removeItem: (pid, iid) => api.delete(ENDPOINTS.PRICE_LIST_ITEM(pid, iid)),
};

export const pricingRuleApi = {
  list: (params) => api.get(buildUrl(ENDPOINTS.PRICING_RULES, params)),
  get: (id) => api.get(ENDPOINTS.PRICING_RULE(id)),
  create: (data) => api.post(ENDPOINTS.PRICING_RULES, data),
  update: (id, data) => api.put(ENDPOINTS.PRICING_RULE(id), data),
  deactivate: (id) => api.delete(ENDPOINTS.PRICING_RULE(id)),
  activate: (id) => api.post(`${ENDPOINTS.PRICING_RULE(id)}/activate`),
  getApplicable: (params) => api.get(buildUrl(ENDPOINTS.PRICING_RULES_APPLICABLE, params)),
  listTiers: (id) => api.get(ENDPOINTS.PRICING_RULE_TIERS(id)),
  addTier: (id, data) => api.post(ENDPOINTS.PRICING_RULE_TIERS(id), data),
  removeTier: (pid, tid) => api.delete(ENDPOINTS.PRICING_RULE_TIER(pid, tid)),
};

export const discountApi = {
  list: (params) => api.get(buildUrl(ENDPOINTS.DISCOUNTS, params)),
  get: (id) => api.get(ENDPOINTS.DISCOUNT(id)),
  create: (data) => api.post(ENDPOINTS.DISCOUNTS, data),
  update: (id, data) => api.put(ENDPOINTS.DISCOUNT(id), data),
  deactivate: (id) => api.delete(ENDPOINTS.DISCOUNT(id)),
  getValidForOrder: (params) => api.get(buildUrl(ENDPOINTS.DISCOUNTS_VALID_FOR_ORDER, params)),
  getUsage: (id, params) => api.get(buildUrl(ENDPOINTS.DISCOUNT_USAGE(id), params)),
  getUsageCount: (id) => api.get(ENDPOINTS.DISCOUNT_USAGE_COUNT(id)),
};

export const currencyPricingApi = {
  list: (params) => api.get(buildUrl(ENDPOINTS.CURRENCY_PRICING, params)),
  get: (id) => api.get(ENDPOINTS.CURRENCY_PRICING_ITEM(id)),
  create: (data) => api.post(ENDPOINTS.CURRENCY_PRICING, data),
  update: (id, data) => api.put(ENDPOINTS.CURRENCY_PRICING_ITEM(id), data),
  deactivate: (id) => api.delete(ENDPOINTS.CURRENCY_PRICING_ITEM(id)),
  listByProduct: (productId) => api.get(ENDPOINTS.CURRENCY_PRICING_BY_PRODUCT(productId)),
};

export const taxPricingApi = {
  list: (params) => api.get(buildUrl(ENDPOINTS.TAX_PRICING, params)),
  get: (id) => api.get(ENDPOINTS.TAX_PRICING_ITEM(id)),
  create: (data) => api.post(ENDPOINTS.TAX_PRICING, data),
  update: (id, data) => api.put(ENDPOINTS.TAX_PRICING_ITEM(id), data),
  deactivate: (id) => api.delete(ENDPOINTS.TAX_PRICING_ITEM(id)),
  getApplicable: (params) => api.get(buildUrl(ENDPOINTS.TAX_PRICING_APPLICABLE, params)),
  listGroups: (params) => api.get(buildUrl(ENDPOINTS.TAX_GROUPS, params)),
  getGroup: (id) => api.get(ENDPOINTS.TAX_GROUP(id)),
  createGroup: (data) => api.post(ENDPOINTS.TAX_GROUPS, data),
  updateGroup: (id, data) => api.put(ENDPOINTS.TAX_GROUP(id), data),
  deactivateGroup: (id) => api.delete(ENDPOINTS.TAX_GROUP(id)),
  listGroupMembers: (id) => api.get(ENDPOINTS.TAX_GROUP_MEMBERS(id)),
  addGroupMember: (id, data) => api.post(ENDPOINTS.TAX_GROUP_MEMBERS(id), data),
  removeGroupMember: (id) => api.delete(ENDPOINTS.TAX_GROUP_MEMBER(id)),
};

export const contractApi = {
  list: (params) => api.get(buildUrl(ENDPOINTS.CONTRACTS, params)),
  listActive: () => api.get(ENDPOINTS.CONTRACTS_ACTIVE),
  listExpiring: (withinDays = 30) =>
    api.get(buildUrl(ENDPOINTS.CONTRACTS_EXPIRING, { within_days: withinDays })),
  summary: () => api.get(ENDPOINTS.CONTRACTS_SUMMARY),
  get: (id) => api.get(ENDPOINTS.CONTRACT(id)),
  create: (data) => api.post(ENDPOINTS.CONTRACTS, data),
  update: (id, data) => api.put(ENDPOINTS.CONTRACT(id), data),
  activate: (id) => api.put(ENDPOINTS.CONTRACT_ACTIVATE(id)),
  terminate: (id, data) => api.put(ENDPOINTS.CONTRACT_TERMINATE(id), data || {}),
  cancel: (id) => api.put(ENDPOINTS.CONTRACT_CANCEL(id)),
  renew: (id, newEndDate) =>
    api.put(buildUrl(ENDPOINTS.CONTRACT_RENEW(id), { new_end_date: newEndDate })),
  getItems: (id) => api.get(ENDPOINTS.CONTRACT_ITEMS(id)),
  setItems: (id, data) => api.put(ENDPOINTS.CONTRACT_ITEMS(id), data),
  convertFromQuotation: (data) => api.post(ENDPOINTS.CONTRACT_CONVERT_FROM_QUOTATION, data),
  generateInvoice: (id, data) => api.post(ENDPOINTS.CONTRACT_GENERATE_INVOICE(id), data),
  getAmendments: (id) => api.get(ENDPOINTS.CONTRACT_AMENDMENTS(id)),
  createAmendment: (id, data) => api.post(ENDPOINTS.CONTRACT_AMENDMENTS(id), data),
  _delete: (id) => api.delete(ENDPOINTS.CONTRACT(id)),
};

export const quoteApi = {
  list: (params) => api.get(buildUrl(ENDPOINTS.QUOTATIONS, params)),
  get: (id) => api.get(ENDPOINTS.QUOTATION(id)),
  create: (data) => api.post(ENDPOINTS.QUOTATIONS, data),
  update: (id, data) => api.put(ENDPOINTS.QUOTATION(id), data),
  listItems: (id) => api.get(ENDPOINTS.QUOTATION_ITEMS(id)),
  addItem: (id, data) => api.post(ENDPOINTS.QUOTATION_ITEMS(id), data),
  updateItem: (quoteId, itemId, data) => api.put(ENDPOINTS.QUOTATION_ITEM(quoteId, itemId), data),
  removeItem: (quoteId, itemId) => api.delete(ENDPOINTS.QUOTATION_ITEM(quoteId, itemId)),
  send: (id) => api.post(ENDPOINTS.QUOTATION_SEND(id)),
  accept: (id) => api.post(ENDPOINTS.QUOTATION_ACCEPT(id)),
  reject: (id, reason) =>
    api.post(buildUrl(ENDPOINTS.QUOTATION_REJECT(id), { reason })),
  cancel: (id) => api.post(ENDPOINTS.QUOTATION_CANCEL(id)),
  convertToInvoice: (id, params) =>
    api.post(buildUrl(ENDPOINTS.QUOTATION_CONVERT(id), params)),
  recalculate: (id) => api.post(ENDPOINTS.QUOTATION_RECALCULATE(id)),
  duplicate: (id) => api.post(ENDPOINTS.QUOTATION_DUPLICATE(id)),
};

export const subscriptionApi = {
  listPlans: (params) =>
    api.get(buildUrl(ENDPOINTS.SUBSCRIPTION_PLANS, params)),
  listPublicPlans: () => api.get(ENDPOINTS.SUBSCRIPTION_PLANS_PUBLIC),
  getPlan: (id) => api.get(ENDPOINTS.SUBSCRIPTION_PLAN(id)),
  createPlan: (data) => api.post(ENDPOINTS.SUBSCRIPTION_PLANS, data),
  updatePlan: (id, data) => api.put(ENDPOINTS.SUBSCRIPTION_PLAN(id), data),
  list: (params) => api.get(buildUrl(ENDPOINTS.SUBSCRIPTIONS, params)),
  listActive: () => api.get(ENDPOINTS.SUBSCRIPTIONS_ACTIVE),
  summary: () => api.get(ENDPOINTS.SUBSCRIPTIONS_SUMMARY),
  get: (id) => api.get(ENDPOINTS.SUBSCRIPTION(id)),
  create: (data) => api.post(ENDPOINTS.SUBSCRIPTIONS, data),
  update: (id, data) => api.put(ENDPOINTS.SUBSCRIPTION(id), data),
  activate: (id) => api.post(ENDPOINTS.SUBSCRIPTION_ACTIVATE(id)),
  pause: (id) => api.post(ENDPOINTS.SUBSCRIPTION_PAUSE(id)),
  resume: (id) => api.post(ENDPOINTS.SUBSCRIPTION_RESUME(id)),
  cancel: (id) => api.post(ENDPOINTS.SUBSCRIPTION_CANCEL(id)),
  renew: (id) => api.post(ENDPOINTS.SUBSCRIPTION_RENEW(id)),
  changePlan: (id, newPlanId) =>
    api.put(
      buildUrl(ENDPOINTS.SUBSCRIPTION_CHANGE_PLAN(id), {
        new_plan_id: newPlanId,
      })
    ),
  listEvents: (id) => api.get(ENDPOINTS.SUBSCRIPTION_EVENTS(id)),
  getReporting: () => api.get(ENDPOINTS.SUBSCRIPTION_REPORTING),
  processBilling: (billingDate) =>
    api.post(`${ENDPOINTS.SUBSCRIPTION_PROCESS_BILLING}?billing_date=${billingDate}`),
  generateInvoice: (subId) =>
    api.post(ENDPOINTS.SUBSCRIPTION_GENERATE_INVOICE(subId)),
};

export const invoiceApi = {
  list: (params) => api.get(buildUrl(ENDPOINTS.INVOICES, params)),
  get: (id) => api.get(ENDPOINTS.INVOICE(id)),
  create: (data) => api.post(ENDPOINTS.INVOICES, data),
  update: (id, data) => api.put(ENDPOINTS.INVOICE(id), data),
  listOverdue: () => api.get(ENDPOINTS.INVOICES_OVERDUE),
  getOutstandingTotal: () => api.get(ENDPOINTS.INVOICES_OUTSTANDING_TOTAL),
  getDashboardStats: (period) => api.get(buildUrl(ENDPOINTS.INVOICES_DASHBOARD_STATS, period ? { period } : {})),
  getEnterpriseDashboard: (range) => api.get(buildUrl(ENDPOINTS.INVOICES_ENTERPRISE_DASHBOARD, range || {})),
  getInvoiceTrend: (months = 12) => api.get(buildUrl(ENDPOINTS.INVOICES_INVOICE_TREND, { months })),
  getRevenueTrend: (months = 12) => api.get(buildUrl(ENDPOINTS.INVOICES_REVENUE_TREND, { months })),
  getPaymentCollectionTrend: (months = 12) => api.get(buildUrl(ENDPOINTS.INVOICES_PAYMENT_COLLECTION_TREND, { months })),
  getStatusDistribution: () => api.get(ENDPOINTS.INVOICES_STATUS_DISTRIBUTION),
  getMonthlyRevenue: (months = 12) => api.get(buildUrl(ENDPOINTS.INVOICES_MONTHLY_REVENUE, { months })),
  getRecentActivity: (limit = 10) => api.get(buildUrl(ENDPOINTS.INVOICES_RECENT_ACTIVITY, { limit })),
  bulkDelete: (ids) => api.post(ENDPOINTS.INVOICES_BULK_DELETE, { ids }),
  listDueBetween: (startDate, endDate) =>
    api.get(
      buildUrl(ENDPOINTS.INVOICES_DUE_BETWEEN, {
        start_date: startDate,
        end_date: endDate,
      })
    ),
  finalize: (id) => api.post(ENDPOINTS.INVOICE_FINALIZE(id)),
  markSent: (id) => api.post(ENDPOINTS.INVOICE_SEND(id)),
  sendEmail: (id) => api.post(ENDPOINTS.INVOICE_SEND_EMAIL(id)),
  cancel: (id, reason) =>
    api.post(buildUrl(ENDPOINTS.INVOICE_CANCEL(id), { reason })),
  void: (id, reason) =>
    api.post(buildUrl(ENDPOINTS.INVOICE_VOID(id), { reason })),
  recalculate: (id) => api.post(ENDPOINTS.INVOICE_RECALCULATE(id)),
  listItems: (id) => api.get(ENDPOINTS.INVOICE_ITEMS(id)),
  addItem: (id, data) => api.post(ENDPOINTS.INVOICE_ITEMS(id), data),
  bulkSetItems: (id, items) =>
    api.put(ENDPOINTS.INVOICE_ITEMS(id), { items }),
  listStatusHistory: (id) => api.get(ENDPOINTS.INVOICE_STATUS_HISTORY(id)),
  listCommunications: (id) => api.get(ENDPOINTS.INVOICE_COMMUNICATIONS(id)),
  addCommunicationNote: (id, data) => api.post(ENDPOINTS.INVOICE_COMMUNICATIONS(id), data),
  getTimeline: (id) => api.get(ENDPOINTS.INVOICE_TIMELINE(id)),
};

export const paymentApi = {
  listMethods: (customerId) =>
    api.get(ENDPOINTS.PAYMENT_METHODS_BY_CUSTOMER(customerId)),
  addMethod: (data) => api.post(ENDPOINTS.PAYMENT_METHODS, data),
  updateMethod: (id, data) => api.put(ENDPOINTS.PAYMENT_METHOD(id), data),
  removeMethod: (id) => api.delete(ENDPOINTS.PAYMENT_METHOD(id)),
  setDefaultMethod: (id) => api.put(ENDPOINTS.PAYMENT_METHOD_DEFAULT(id)),
  list: (params) => api.get(buildUrl(ENDPOINTS.PAYMENTS, params)),
  get: (id) => api.get(ENDPOINTS.PAYMENT(id)),
  create: (data) => api.post(ENDPOINTS.PAYMENTS, data),
  updateStatus: (id, status) =>
    api.put(buildUrl(ENDPOINTS.PAYMENT_STATUS(id), { status })),
  allocate: (id, data) =>
    api.post(ENDPOINTS.PAYMENT_ALLOCATE(id), data),
  listAllocations: (id) => api.get(ENDPOINTS.PAYMENT_ALLOCATIONS(id)),
  listAttempts: (id) => api.get(ENDPOINTS.PAYMENT_ATTEMPTS(id)),
  reconcile: (id) => api.post(ENDPOINTS.PAYMENT_RECONCILE(id)),
  getTotalCollected: () => api.get(ENDPOINTS.PAYMENTS_TOTAL_COLLECTED),
  listUnallocated: (params) => api.get(buildUrl(ENDPOINTS.PAYMENT_UNALLOCATED, params)),
  getUnallocatedAmount: (id) => api.get(ENDPOINTS.PAYMENT_UNALLOCATED_AMOUNT(id)),
  deleteAllocation: (id) => api.delete(ENDPOINTS.PAYMENT_ALLOCATION_DELETE(id)),
};

export const taxApi = {
  list: (params) => api.get(buildUrl(ENDPOINTS.TAX_RATES, params)),
  get: (id) => api.get(ENDPOINTS.TAX_RATE(id)),
  create: (data) => api.post(ENDPOINTS.TAX_RATES, data),
  update: (id, data) => api.put(ENDPOINTS.TAX_RATE(id), data),
  getApplicable: (taxableType = "both") =>
    api.get(buildUrl(ENDPOINTS.TAX_RATES_APPLICABLE, { taxable_type: taxableType })),
  getDefault: (currency) =>
    api.get(buildUrl(ENDPOINTS.TAX_RATES_DEFAULT, { currency })),
  getSummary: (dateFrom, dateTo) =>
    api.get(
      buildUrl(ENDPOINTS.TAX_RATES_SUMMARY, { date_from: dateFrom, date_to: dateTo })
    ),
  calculate: (taxableAmount, jurisdiction, taxTypeFilter) =>
    api.post(
      buildUrl(ENDPOINTS.TAX_RATES_CALCULATE, {
        taxable_amount: taxableAmount,
        jurisdiction,
        tax_type_filter: taxTypeFilter,
      }), {}
    ),
};

export const creditNoteApi = {
  list: (params) => api.get(buildUrl(ENDPOINTS.CREDIT_NOTES, params)),
  get: (id) => api.get(ENDPOINTS.CREDIT_NOTE(id)),
  create: (data) => api.post(ENDPOINTS.CREDIT_NOTES, data),
  update: (id, data) => api.put(ENDPOINTS.CREDIT_NOTE(id), data),
  getOutstanding: () => api.get(ENDPOINTS.CREDIT_NOTES_OUTSTANDING),
  getDashboardStats: () => api.get(ENDPOINTS.CREDIT_NOTES_DASHBOARD_STATS),
  getStatusDistribution: () => api.get(ENDPOINTS.CREDIT_NOTES_STATUS_DISTRIBUTION),
  getTypeDistribution: () => api.get(ENDPOINTS.CREDIT_NOTES_TYPE_DISTRIBUTION),
  getMonthlyTrend: (months = 12) => api.get(buildUrl(ENDPOINTS.CREDIT_NOTES_MONTHLY_TREND, { months })),
  getCustomerBalance: (customerId) => api.get(ENDPOINTS.CREDIT_NOTES_CUSTOMER_BALANCE(customerId)),
  bulkDelete: (ids) => api.post(ENDPOINTS.CREDIT_NOTES_BULK_DELETE, { ids }),
  approve: (id, reason) =>
    api.post(buildUrl(ENDPOINTS.CREDIT_NOTE_APPROVE(id), reason ? { reason } : {})),
  issue: (id) => api.post(ENDPOINTS.CREDIT_NOTE_ISSUE(id)),
  sendEmail: (id) => api.post(ENDPOINTS.CREDIT_NOTE_SEND_EMAIL(id)),
  void: (id, reason) =>
    api.post(buildUrl(ENDPOINTS.CREDIT_NOTE_VOID(id), { reason })),
  applyToInvoice: (id, data) =>
    api.post(ENDPOINTS.CREDIT_NOTE_APPLY(id), data),
  listApplications: (id) => api.get(ENDPOINTS.CREDIT_NOTE_APPLICATIONS(id)),
  listStatusHistory: (id) => api.get(ENDPOINTS.CREDIT_NOTE_STATUS_HISTORY(id)),
  listCommunications: (id) => api.get(ENDPOINTS.CREDIT_NOTE_COMMUNICATIONS(id)),
  addCommunicationNote: (id, data) => api.post(ENDPOINTS.CREDIT_NOTE_COMMUNICATIONS(id), data),
  getTimeline: (id) => api.get(ENDPOINTS.CREDIT_NOTE_TIMELINE(id)),
};

export const refundApi = {
  list: (params) => api.get(buildUrl(ENDPOINTS.REFUNDS, params)),
  get: (id) => api.get(ENDPOINTS.REFUND(id)),
  create: (data) => api.post(ENDPOINTS.REFUNDS, data),
  update: (id, data) => api.put(ENDPOINTS.REFUND(id), data),
  getDashboardStats: () => api.get(ENDPOINTS.REFUNDS_DASHBOARD_STATS),
  getStatusDistribution: () => api.get(ENDPOINTS.REFUNDS_STATUS_DISTRIBUTION),
  getTypeDistribution: () => api.get(ENDPOINTS.REFUNDS_TYPE_DISTRIBUTION),
  getMethodDistribution: () => api.get(ENDPOINTS.REFUNDS_METHOD_DISTRIBUTION),
  getSourceDistribution: () => api.get(ENDPOINTS.REFUNDS_SOURCE_DISTRIBUTION),
  getReasonDistribution: (limit = 10) => api.get(buildUrl(ENDPOINTS.REFUNDS_REASON_DISTRIBUTION, { limit })),
  getMonthlyTrend: (months = 12) => api.get(buildUrl(ENDPOINTS.REFUNDS_MONTHLY_TREND, { months })),
  listByCustomer: (customerId, params) => api.get(buildUrl(ENDPOINTS.REFUNDS_BY_CUSTOMER(customerId), params)),
  getCustomerSummary: (customerId) => api.get(ENDPOINTS.REFUNDS_CUSTOMER_SUMMARY(customerId)),
  submit: (id, reason) => api.post(ENDPOINTS.REFUND_SUBMIT(id), { reason }),
  approve: (id, reason) => api.post(ENDPOINTS.REFUND_APPROVE(id), { reason }),
  reject: (id, reason) => api.post(ENDPOINTS.REFUND_REJECT(id), { reason }),
  cancel: (id, reason) => api.post(ENDPOINTS.REFUND_CANCEL(id), { reason }),
  process: (id, gatewayRefundId, referenceNumber) =>
    api.post(ENDPOINTS.REFUND_PROCESS(id), {
      gateway_refund_id: gatewayRefundId,
      reference_number: referenceNumber,
    }),
  complete: (id) => api.post(ENDPOINTS.REFUND_COMPLETE(id)),
  fail: (id, failureReason) =>
    api.post(ENDPOINTS.REFUND_FAIL(id), { failure_reason: failureReason }),
  sendEmail: (id) => api.post(ENDPOINTS.REFUND_SEND_EMAIL(id)),
  listStatusHistory: (id) => api.get(ENDPOINTS.REFUND_STATUS_HISTORY(id)),
  listCommunications: (id) => api.get(ENDPOINTS.REFUND_COMMUNICATIONS(id)),
  addCommunicationNote: (id, data) => api.post(ENDPOINTS.REFUND_COMMUNICATIONS(id), data),
  getTimeline: (id) => api.get(ENDPOINTS.REFUND_TIMELINE(id)),
};

export const writeOffApi = {
  list: (params) => api.get(buildUrl(ENDPOINTS.WRITE_OFFS, params)),
  get: (id) => api.get(ENDPOINTS.WRITE_OFF(id)),
  create: (data) => api.post(ENDPOINTS.WRITE_OFFS, data),
  update: (id, data) => api.put(ENDPOINTS.WRITE_OFF(id), data),
  getDashboardStats: () => api.get(ENDPOINTS.WRITE_OFFS_DASHBOARD_STATS),
  getStatusDistribution: () => api.get(ENDPOINTS.WRITE_OFFS_STATUS_DISTRIBUTION),
  getTypeDistribution: () => api.get(ENDPOINTS.WRITE_OFFS_TYPE_DISTRIBUTION),
  getAdjustmentTypeDistribution: () => api.get(ENDPOINTS.WRITE_OFFS_ADJUSTMENT_TYPE_DISTRIBUTION),
  getSourceDistribution: () => api.get(ENDPOINTS.WRITE_OFFS_SOURCE_DISTRIBUTION),
  getReasonDistribution: (limit = 10) => api.get(buildUrl(ENDPOINTS.WRITE_OFFS_REASON_DISTRIBUTION, { limit })),
  getCustomerDistribution: (limit = 10) => api.get(buildUrl(ENDPOINTS.WRITE_OFFS_CUSTOMER_DISTRIBUTION, { limit })),
  getMonthlyTrend: (months = 12) => api.get(buildUrl(ENDPOINTS.WRITE_OFFS_MONTHLY_TREND, { months })),
  listByCustomer: (customerId, params) => api.get(buildUrl(ENDPOINTS.WRITE_OFFS_BY_CUSTOMER(customerId), params)),
  getCustomerSummary: (customerId) => api.get(ENDPOINTS.WRITE_OFFS_CUSTOMER_SUMMARY(customerId)),
  submit: (id, reason) => api.post(ENDPOINTS.WRITE_OFF_SUBMIT(id), { reason }),
  approve: (id, reason) => api.post(ENDPOINTS.WRITE_OFF_APPROVE(id), { reason }),
  cancel: (id, reason) => api.post(ENDPOINTS.WRITE_OFF_CANCEL(id), { reason }),
  execute: (id) => api.post(ENDPOINTS.WRITE_OFF_EXECUTE(id)),
  reverse: (id, reason) => api.post(ENDPOINTS.WRITE_OFF_REVERSE(id), { reason }),
  sendEmail: (id) => api.post(ENDPOINTS.WRITE_OFF_SEND_EMAIL(id)),
  listStatusHistory: (id) => api.get(ENDPOINTS.WRITE_OFF_STATUS_HISTORY(id)),
  listCommunications: (id) => api.get(ENDPOINTS.WRITE_OFF_COMMUNICATIONS(id)),
  addCommunicationNote: (id, data) => api.post(ENDPOINTS.WRITE_OFF_COMMUNICATIONS(id), data),
  getTimeline: (id) => api.get(ENDPOINTS.WRITE_OFF_TIMELINE(id)),
};

export const dunningApi = {
  listLevels: () => api.get(ENDPOINTS.DUNNING_LEVELS),
  getLevel: (id) => api.get(ENDPOINTS.DUNNING_LEVEL(id)),
  createLevel: (data) => api.post(ENDPOINTS.DUNNING_LEVELS, data),
  updateLevel: (id, data) => api.put(ENDPOINTS.DUNNING_LEVEL(id), data),
  deleteLevel: (id) => api.delete(ENDPOINTS.DUNNING_LEVEL(id)),
  listCases: (params) => api.get(buildUrl(ENDPOINTS.DUNNING_CASES, params)),
  listActiveCases: () => api.get(ENDPOINTS.DUNNING_CASES_ACTIVE),
  getCase: (id) => api.get(ENDPOINTS.DUNNING_CASE(id)),
  openCase: (data) =>
    api.post(ENDPOINTS.DUNNING_CASES, {
      customer_id: data.customer_id,
      invoice_id: data.invoice_id,
      total_overdue_amount: data.total_overdue_amount,
      days_overdue: data.days_overdue,
      current_level: data.current_level ?? 1,
      auto_escalate: data.auto_escalate ?? true,
      next_action_at: data.next_action_at ?? null,
      notes: data.notes ?? null,
    }),
  escalateCase: (id) => api.post(ENDPOINTS.DUNNING_CASE_ESCALATE(id)),
  resolveCase: (id, resolutionNote) =>
    api.post(
      buildUrl(ENDPOINTS.DUNNING_CASE_RESOLVE(id), {
        resolution_note: resolutionNote,
      })
    ),
  closeCase: (id) => api.post(ENDPOINTS.DUNNING_CASE_CLOSE(id)),
  getReminderSchedule: () => api.get(ENDPOINTS.DUNNING_SCHEDULE),
  processDunning: () => api.post(ENDPOINTS.DUNNING_PROCESS),
  getDashboardStats: () => api.get(ENDPOINTS.DUNNING_DASHBOARD_STATS),
  getLevelDistribution: () => api.get(ENDPOINTS.DUNNING_LEVEL_DISTRIBUTION),
  listCaseStatusHistory: (id) => api.get(ENDPOINTS.DUNNING_CASE_STATUS_HISTORY(id)),
  getCaseTimeline: (id) => api.get(ENDPOINTS.DUNNING_CASE_TIMELINE(id)),
};

export const collectionApi = {
  listCases: (params) =>
    api.get(buildUrl(ENDPOINTS.COLLECTIONS_CASES, params)),
  getCase: (id) => api.get(ENDPOINTS.COLLECTIONS_CASE(id)),
  openCase: (data) => api.post(ENDPOINTS.COLLECTIONS_CASES, data),
  updateCase: (id, data) => api.put(ENDPOINTS.COLLECTIONS_CASE(id), data),
  assignCase: (id, assignedTo) =>
    api.post(
      buildUrl(ENDPOINTS.COLLECTIONS_CASE_ASSIGN(id), {
        assigned_to: assignedTo,
      })
    ),
  resolveCase: (id, resolution, amountCollected) =>
    api.post(
      buildUrl(ENDPOINTS.COLLECTIONS_CASE_RESOLVE(id), {
        resolution,
        ...(amountCollected != null ? { amount_collected: amountCollected } : {}),
      })
    ),
  closeCase: (id) => api.post(ENDPOINTS.COLLECTIONS_CASE_CLOSE(id)),
  escalateCase: (id) => api.post(ENDPOINTS.COLLECTIONS_CASE_ESCALATE(id)),
  logAction: (id, data) =>
    api.post(ENDPOINTS.COLLECTIONS_CASE_ACTIONS(id), data),
  getAgingBuckets: () => api.get(ENDPOINTS.COLLECTIONS_AGING),
  getCollectionsQueue: () => api.get(ENDPOINTS.COLLECTIONS_QUEUE),
  getDashboardStats: () => api.get(ENDPOINTS.COLLECTIONS_DASHBOARD_STATS),
  getPriorityDistribution: () => api.get(ENDPOINTS.COLLECTIONS_PRIORITY_DISTRIBUTION),
  listCaseStatusHistory: (id) => api.get(ENDPOINTS.COLLECTIONS_CASE_STATUS_HISTORY(id)),
  getCaseTimeline: (id) => api.get(ENDPOINTS.COLLECTIONS_CASE_TIMELINE(id)),
  getCustomerSummary: (customerId) => api.get(ENDPOINTS.COLLECTIONS_CUSTOMER_SUMMARY(customerId)),
  escalateOverdueNow: () => api.post(ENDPOINTS.COLLECTIONS_ESCALATE_OVERDUE),
  getOverdueByCustomer: (limit = 20) => api.get(buildUrl(ENDPOINTS.COLLECTIONS_REPORT_OVERDUE_BY_CUSTOMER, { limit })),
  getDunningPerformance: () => api.get(ENDPOINTS.COLLECTIONS_REPORT_DUNNING_PERFORMANCE),
  getCollectionEffectiveness: () => api.get(ENDPOINTS.COLLECTIONS_REPORT_EFFECTIVENESS),
  getRecoveryTrend: (months = 12) => api.get(buildUrl(ENDPOINTS.COLLECTIONS_REPORT_RECOVERY_TREND, { months })),
};

export const promiseToPayApi = {
  list: (params) => api.get(buildUrl(ENDPOINTS.PROMISES, params)),
  get: (id) => api.get(ENDPOINTS.PROMISE(id)),
  create: (data) => api.post(ENDPOINTS.PROMISES, data),
  update: (id, data) => api.put(ENDPOINTS.PROMISE(id), data),
  markFulfilled: (id, notes) => api.post(ENDPOINTS.PROMISE_MARK_FULFILLED(id), { notes }),
  markBroken: (id, notes) => api.post(ENDPOINTS.PROMISE_MARK_BROKEN(id), { notes }),
  cancel: (id, notes) => api.post(ENDPOINTS.PROMISE_CANCEL(id), { notes }),
  process: () => api.post(ENDPOINTS.PROMISE_PROCESS),
  getSuccessRate: () => api.get(ENDPOINTS.PROMISE_SUCCESS_RATE),
  getDashboardStats: () => api.get(ENDPOINTS.PROMISE_DASHBOARD_STATS),
  listByCustomer: (customerId) => api.get(ENDPOINTS.PROMISE_BY_CUSTOMER(customerId)),
  getTimeline: (id) => api.get(ENDPOINTS.PROMISE_TIMELINE(id)),
  getCommunications: (id) => api.get(ENDPOINTS.PROMISE_COMMUNICATIONS(id)),
};

export const revenueApi = {
  listSchedules: (params) =>
    api.get(buildUrl(ENDPOINTS.REVENUE_SCHEDULES, params)),
  getSchedule: (id) => api.get(ENDPOINTS.REVENUE_SCHEDULE(id)),
  createSchedule: (data) => api.post(ENDPOINTS.REVENUE_SCHEDULES, data),
  updateSchedule: (id, data) => api.put(ENDPOINTS.REVENUE_SCHEDULE(id), data),
  recognizeRevenue: (id, asOfDate) =>
    api.post(
      buildUrl(ENDPOINTS.REVENUE_SCHEDULE_RECOGNIZE(id), {
        as_of_date: asOfDate,
      })
    ),
  getEntries: (id) => api.get(ENDPOINTS.REVENUE_SCHEDULE_ENTRIES(id)),
  getTotalDeferred: () => api.get(ENDPOINTS.REVENUE_DEFERRED),
  recognizeAllPending: (asOfDate) =>
    api.post(
      buildUrl(ENDPOINTS.REVENUE_RECOGNIZE_ALL, { as_of_date: asOfDate })
    ),
};

export const auditApi = {
  list: (params) => api.get(buildUrl(ENDPOINTS.AUDIT_LOGS, params)),
};

export default {
  settings: settingsApi,
  dashboard: dashboardApi,
  customers: customerApi,
  products: productApi,
  pricing: pricingApi,
  priceLists: priceListApi,
  pricingRules: pricingRuleApi,
  discounts: discountApi,
  currencyPricing: currencyPricingApi,
  taxPricing: taxPricingApi,
  contracts: contractApi,
  quotes: quoteApi,
  subscriptions: subscriptionApi,
  invoices: invoiceApi,
  payments: paymentApi,
  tax: taxApi,
  creditNotes: creditNoteApi,
  refunds: refundApi,
  writeOffs: writeOffApi,
  dunning: dunningApi,
  collections: collectionApi,
  promiseToPay: promiseToPayApi,
  revenue: revenueApi,
  audit: auditApi,
};
