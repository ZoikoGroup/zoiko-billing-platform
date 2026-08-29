"""
modules/commercial/entitlement_catalog_spec.py
------------------------------------------------
Single source of truth for the 19 canonical entitlement keys (§12,
ZB-COM-ENT-001). Both `scripts/seed_entitlement_definitions.py` (which
inserts these as EntitlementDefinition rows) and
`entitlement_enforcement.require_entitlement`/`EntitlementEnforcementService`
(which validate a key against this list before resolving it) import from
here, so the seeded catalog and route-time validation can never drift apart.
"""

from app.modules.commercial.enums import (
    EntitlementEnforcementType,
    EntitlementRiskClassification,
    EntitlementValueType,
)

ENTITLEMENT_CATALOG_SPEC = [
    # Core billing
    {
        "key": "billing.invoice.create",
        "value_type": EntitlementValueType.BOOLEAN,
        "risk_classification": EntitlementRiskClassification.STANDARD,
        "enforcement_type": EntitlementEnforcementType.HARD,
        "description": "Allow creating invoices for billing customers.",
    },
    {
        "key": "billing.invoice.monthly_limit",
        "value_type": EntitlementValueType.INTEGER,
        "risk_classification": EntitlementRiskClassification.STANDARD,
        "enforcement_type": EntitlementEnforcementType.HARD,
        "description": "Maximum number of invoices that can be created per calendar month.",
    },
    {
        "key": "billing.recurring.manage",
        "value_type": EntitlementValueType.BOOLEAN,
        "risk_classification": EntitlementRiskClassification.STANDARD,
        "enforcement_type": EntitlementEnforcementType.HARD,
        "description": "Allow creating and managing recurring billing schedules.",
    },
    {
        "key": "billing.subscription.lifecycle",
        "value_type": EntitlementValueType.BOOLEAN,
        "risk_classification": EntitlementRiskClassification.STANDARD,
        "enforcement_type": EntitlementEnforcementType.HARD,
        "description": "Allow managing billing subscription lifecycle (pause, resume, cancel).",
    },
    {
        "key": "billing.proration.manage",
        "value_type": EntitlementValueType.BOOLEAN,
        "risk_classification": EntitlementRiskClassification.STANDARD,
        "enforcement_type": EntitlementEnforcementType.HARD,
        "description": "Allow prorated charges on mid-period plan changes.",
    },
    {
        "key": "billing.usage_metering",
        "value_type": EntitlementValueType.BOOLEAN,
        "risk_classification": EntitlementRiskClassification.STANDARD,
        "enforcement_type": EntitlementEnforcementType.HARD,
        "description": "Allow usage-based metering and billing.",
    },
    {
        "key": "billing.pricing_model_set",
        "value_type": EntitlementValueType.SET,
        "risk_classification": EntitlementRiskClassification.STANDARD,
        "enforcement_type": EntitlementEnforcementType.HARD,
        "description": "Allowed pricing models (flat, tiered, volume, stairstep).",
    },
    # Payments / collections
    {
        "key": "payments.provider.max",
        "value_type": EntitlementValueType.INTEGER,
        "risk_classification": EntitlementRiskClassification.STANDARD,
        "enforcement_type": EntitlementEnforcementType.HARD,
        "description": "Maximum number of payment provider integrations.",
    },
    {
        "key": "reconciliation.automation",
        "value_type": EntitlementValueType.BOOLEAN,
        "risk_classification": EntitlementRiskClassification.STANDARD,
        "enforcement_type": EntitlementEnforcementType.HARD,
        "description": "Allow automated payment reconciliation.",
    },
    {
        "key": "collections.dunning",
        "value_type": EntitlementValueType.BOOLEAN,
        "risk_classification": EntitlementRiskClassification.STANDARD,
        "enforcement_type": EntitlementEnforcementType.HARD,
        "description": "Allow automated dunning/collections workflows.",
    },
    # Tax / multi-entity
    {
        "key": "org.entity.max",
        "value_type": EntitlementValueType.INTEGER,
        "risk_classification": EntitlementRiskClassification.STANDARD,
        "enforcement_type": EntitlementEnforcementType.HARD,
        "description": "Maximum number of legal entities (orgs) under this account.",
    },
    {
        "key": "currency.enabled.max",
        "value_type": EntitlementValueType.INTEGER,
        "risk_classification": EntitlementRiskClassification.STANDARD,
        "enforcement_type": EntitlementEnforcementType.HARD,
        "description": "Maximum number of enabled currencies.",
    },
    # Governance / security
    {
        "key": "security.custom_roles",
        "value_type": EntitlementValueType.BOOLEAN,
        "risk_classification": EntitlementRiskClassification.HIGH_RISK,
        "enforcement_type": EntitlementEnforcementType.HARD,
        "description": "Allow creating custom RBAC roles (identity/security-adjacent).",
    },
    {
        "key": "security.sso",
        "value_type": EntitlementValueType.BOOLEAN,
        "risk_classification": EntitlementRiskClassification.HIGH_RISK,
        "enforcement_type": EntitlementEnforcementType.HARD,
        "description": "Allow SSO/SAML integration (identity/security-adjacent).",
    },
    {
        "key": "api.write",
        "value_type": EntitlementValueType.BOOLEAN,
        "risk_classification": EntitlementRiskClassification.HIGH_RISK,
        "enforcement_type": EntitlementEnforcementType.HARD,
        "description": "Allow write operations via the API (identity/security-adjacent).",
    },
    # Integrations / analytics
    {
        "key": "api.requests_per_day",
        "value_type": EntitlementValueType.INTEGER,
        "risk_classification": EntitlementRiskClassification.STANDARD,
        "enforcement_type": EntitlementEnforcementType.THROTTLE,
        "description": "Maximum API requests per day (rate-limited, not blocked).",
    },
    {
        "key": "webhooks.endpoint.max",
        "value_type": EntitlementValueType.INTEGER,
        "risk_classification": EntitlementRiskClassification.STANDARD,
        "enforcement_type": EntitlementEnforcementType.HARD,
        "description": "Maximum number of webhook endpoints.",
    },
    {
        "key": "audit.search_months",
        "value_type": EntitlementValueType.INTEGER,
        "risk_classification": EntitlementRiskClassification.STANDARD,
        "enforcement_type": EntitlementEnforcementType.HARD,
        "description": "How many months of audit log are searchable.",
    },
    {
        "key": "sandbox.workspace.max",
        "value_type": EntitlementValueType.INTEGER,
        "risk_classification": EntitlementRiskClassification.STANDARD,
        "enforcement_type": EntitlementEnforcementType.HARD,
        "description": "Maximum number of sandbox workspaces.",
    },
]

KNOWN_ENTITLEMENT_KEYS = frozenset(spec["key"] for spec in ENTITLEMENT_CATALOG_SPEC)

ENTITLEMENT_CATALOG_BY_KEY = {spec["key"]: spec for spec in ENTITLEMENT_CATALOG_SPEC}
