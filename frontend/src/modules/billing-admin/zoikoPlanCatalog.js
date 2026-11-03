// Display catalog for the four public Zoiko plans. Mirrors the values seeded by
// backend/scripts/seed_commercial_plans.py and seed_entitlement_definitions.py.
// The live, authoritative limits for the caller's own org come from
// GET /billing/workspace/plan-limits; this catalog only drives the
// "compare plans" table and the fallback shown when that call fails.
// `null` = contract-governed (Enterprise).

export const PLAN_ORDER = ["essentials", "professional", "business", "enterprise"];

export const PLAN_CATALOG = {
  essentials: {
    name: "Essentials",
    tagline: "Entry-level plan for small teams",
    price: 49,
    maxUsers: 5,
    limits: {
      "billing.invoice.monthly_limit": 100,
      "billing.customer.max": 100,
      "currency.enabled.max": 1,
      "audit.search_months": 3,
    },
    features: {
      "billing.invoice.create": true,
      "billing.recurring.manage": false,
      "billing.usage_metering": false,
      "collections.dunning": false,
      "security.custom_roles": false,
    },
    pricingModels: ["flat"],
  },
  professional: {
    name: "Professional",
    tagline: "Growing teams with expanded limits",
    price: 149,
    maxUsers: 25,
    limits: {
      "billing.invoice.monthly_limit": 1000,
      "billing.customer.max": 1000,
      "currency.enabled.max": 5,
      "audit.search_months": 12,
    },
    features: {
      "billing.invoice.create": true,
      "billing.recurring.manage": true,
      "billing.usage_metering": true,
      "collections.dunning": true,
      "security.custom_roles": true,
    },
    pricingModels: ["flat", "tiered", "volume"],
  },
  business: {
    name: "Business",
    tagline: "Larger teams needing higher limits",
    price: 399,
    maxUsers: 100,
    limits: {
      "billing.invoice.monthly_limit": 10000,
      "billing.customer.max": 10000,
      "currency.enabled.max": 20,
      "audit.search_months": 24,
    },
    features: {
      "billing.invoice.create": true,
      "billing.recurring.manage": true,
      "billing.usage_metering": true,
      "collections.dunning": true,
      "security.custom_roles": true,
    },
    pricingModels: ["flat", "tiered", "volume"],
  },
  enterprise: {
    name: "Enterprise",
    tagline: "Contract-based; limits set in your order form",
    price: null,
    maxUsers: null,
    limits: {},
    features: {},
    pricingModels: null,
  },
};

// Only limits and features the product actually has and enforces. The
// backend catalog also carries keys for features that aren't built yet
// (payment providers beyond Stripe, legal entities, API keys and request
// limits, webhooks, sandboxes, SSO, proration, automated reconciliation);
// those stay off the plan pages until they exist.
export const LIMIT_META = [
  { key: "users", label: "Team Members / Seats", unit: "users", hint: "Users who can sign in, including pending invites." },
  { key: "billing.customer.max", label: "Customers", unit: "customers", hint: "Billing customers in this workspace." },
  { key: "billing.invoice.monthly_limit", label: "Invoices per month", unit: "invoices", hint: "Invoices you can create per calendar month." },
  { key: "currency.enabled.max", label: "Currencies", unit: "currencies", hint: "Distinct currencies you can set product prices in." },
  { key: "audit.search_months", label: "Audit-log search window", unit: "months", hint: "How far back the audit log is searchable." },
];

export const FEATURE_META = [
  { key: "billing.invoice.create", label: "Invoice creation" },
  { key: "billing.recurring.manage", label: "Recurring billing & subscriptions" },
  { key: "billing.usage_metering", label: "Usage-based billing" },
  { key: "collections.dunning", label: "Dunning & collections" },
  { key: "security.custom_roles", label: "Role management" },
];

// Plan-facing names for the billing.pricing_model_set families. Each family
// covers the billing module's matching models (flat includes per-unit,
// tiered includes graduated). Unknown values are dropped from display.
export const PRICING_MODEL_LABELS = {
  flat: "Flat & per-unit",
  tiered: "Tiered & graduated",
  volume: "Volume",
};

export function pricingModelLabels(models) {
  if (!Array.isArray(models)) return null;
  return models.map((m) => PRICING_MODEL_LABELS[String(m).toLowerCase()]).filter(Boolean);
}

export const PRICING_MODEL_KEY = "billing.pricing_model_set";
