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
      "payments.provider.max": 1,
      "org.entity.max": 1,
      "currency.enabled.max": 1,
      "api.requests_per_day": 5000,
      "webhooks.endpoint.max": 2,
      "audit.search_months": 3,
      "sandbox.workspace.max": 1,
    },
    features: {
      "billing.invoice.create": true,
      "billing.recurring.manage": false,
      "billing.subscription.lifecycle": false,
      "billing.proration.manage": false,
      "billing.usage_metering": false,
      "reconciliation.automation": false,
      "collections.dunning": false,
      "security.custom_roles": false,
      "security.sso": false,
      "api.write": false,
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
      "payments.provider.max": 2,
      "org.entity.max": 2,
      "currency.enabled.max": 5,
      "api.requests_per_day": 50000,
      "webhooks.endpoint.max": 10,
      "audit.search_months": 12,
      "sandbox.workspace.max": 3,
    },
    features: {
      "billing.invoice.create": true,
      "billing.recurring.manage": true,
      "billing.subscription.lifecycle": true,
      "billing.proration.manage": true,
      "billing.usage_metering": true,
      "reconciliation.automation": true,
      "collections.dunning": true,
      "security.custom_roles": true,
      "security.sso": true,
      "api.write": true,
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
      "payments.provider.max": 5,
      "org.entity.max": 10,
      "currency.enabled.max": 20,
      "api.requests_per_day": 200000,
      "webhooks.endpoint.max": 50,
      "audit.search_months": 24,
      "sandbox.workspace.max": 10,
    },
    features: {
      "billing.invoice.create": true,
      "billing.recurring.manage": true,
      "billing.subscription.lifecycle": true,
      "billing.proration.manage": true,
      "billing.usage_metering": true,
      "reconciliation.automation": true,
      "collections.dunning": true,
      "security.custom_roles": true,
      "security.sso": true,
      "api.write": true,
    },
    pricingModels: ["flat", "tiered", "volume", "stairstep"],
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

export const LIMIT_META = [
  { key: "users", label: "Team Members / Seats", unit: "users", hint: "Users who can sign in to this workspace." },
  { key: "billing.invoice.monthly_limit", label: "Invoices per month", unit: "invoices", hint: "Invoices you can create per calendar month." },
  { key: "payments.provider.max", label: "Payment providers", unit: "providers", hint: "Connected payment gateways." },
  { key: "org.entity.max", label: "Legal entities", unit: "entities", hint: "Billing entities in one workspace." },
  { key: "currency.enabled.max", label: "Currencies", unit: "currencies", hint: "Currencies you can enable for invoicing." },
  { key: "api.requests_per_day", label: "API requests per day", unit: "requests", hint: "Requests above this are throttled." },
  { key: "webhooks.endpoint.max", label: "Webhook endpoints", unit: "endpoints", hint: "Active webhook destinations." },
  { key: "audit.search_months", label: "Audit-log search window", unit: "months", hint: "How far back the audit log is searchable." },
  { key: "sandbox.workspace.max", label: "Sandbox workspaces", unit: "workspaces", hint: "Test workspaces." },
];

export const FEATURE_META = [
  { key: "billing.invoice.create", label: "Invoice creation" },
  { key: "billing.recurring.manage", label: "Recurring billing" },
  { key: "billing.subscription.lifecycle", label: "Subscription lifecycle" },
  { key: "billing.proration.manage", label: "Proration" },
  { key: "billing.usage_metering", label: "Usage metering" },
  { key: "reconciliation.automation", label: "Automated reconciliation" },
  { key: "collections.dunning", label: "Dunning & collections" },
  { key: "security.custom_roles", label: "Custom roles" },
  { key: "security.sso", label: "Single sign-on (SSO)" },
  { key: "api.write", label: "API write access" },
];

export const PRICING_MODEL_KEY = "billing.pricing_model_set";
