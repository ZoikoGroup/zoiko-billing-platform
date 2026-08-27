"""
modules/commercial/plan_change_compatibility.py
---------------------------------------------------
ZB-COM-ENT-001 Part 3, §8 — the downgrade compatibility checklist. Mirrors
entitlement_resolver.py's precedence-chain shape: a fixed, ordered list of
small, independently-testable checker callables, always run in full (never
short-circuited) so the checklist a caller sees is always complete.

Two of the eight rows (API/webhook dependents, SSO/SCIM dependency) are
documented no-ops: no such subsystem exists anywhere in this codebase
(confirmed by exhaustive search during Part 2 and re-confirmed for Part 3).
They are still returned as rows — marked not_applicable with an explicit
reason — rather than silently omitted, so the checklist is honest about its
own completeness.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable

from sqlalchemy.orm import Session

from app.modules.commercial.models import (
    CommercialOverride,
    CommercialOverrideStatus,
    CommercialPlan,
    CommercialSubscription,
)


@dataclass
class CompatibilityCheckContext:
    db: Session
    organization_id: int
    subscription: CommercialSubscription
    target_plan: CommercialPlan


@dataclass
class CompatibilityCheckResult:
    check_id: str
    label: str
    severity: str  # "blocker" | "warning" | "pass" | "not_applicable"
    current_count: int | None
    target_limit: Any | None
    detail: str


def _resolve_target_plan_value(db: Session, organization_id: int, target_plan_id: int, key: str) -> Any | None:
    """What `key` would resolve to if the org were on target_plan_id today.

    NOT the same as entitlement_resolver.resolve_entitlement(), which
    resolves against the org's CURRENT open subscription — this resolves
    against a hypothetical target. An org-level CommercialOverride is not
    plan-scoped (it survives a plan change), so it's checked first — a
    downgrade should not show a false blocker on a key an approved override
    already covers. Falls back to the target plan's latest PUBLISHED
    PlanEntitlement value, same fallback pattern used by create_subscription/
    resolve_price/EntitlementSnapshotService.
    """
    from app.modules.commercial.entitlement_snapshot_service import EntitlementSnapshotService
    from app.modules.commercial.enums import CommercialPlanVersionStatus
    from app.modules.commercial.models import (
        CommercialPlanVersion,
        EntitlementDefinition,
        PlanEntitlement,
    )

    definition = db.query(EntitlementDefinition).filter(EntitlementDefinition.key == key).first()
    if definition is None:
        return None

    now = datetime.utcnow()
    override = (
        db.query(CommercialOverride)
        .filter(
            CommercialOverride.organization_id == organization_id,
            CommercialOverride.entitlement_definition_id == definition.id,
            CommercialOverride.status == CommercialOverrideStatus.APPROVED,
        )
        .filter((CommercialOverride.expires_at.is_(None)) | (CommercialOverride.expires_at > now))
        .order_by(CommercialOverride.id.desc())
        .first()
    )
    if override is not None:
        return override.value

    latest_published = (
        db.query(CommercialPlanVersion)
        .filter(
            CommercialPlanVersion.plan_id == target_plan_id,
            CommercialPlanVersion.status == CommercialPlanVersionStatus.PUBLISHED,
        )
        .order_by(CommercialPlanVersion.version_number.desc())
        .first()
    )
    if latest_published is None:
        return None

    row = (
        db.query(PlanEntitlement)
        .filter(
            PlanEntitlement.plan_version_id == latest_published.id,
            PlanEntitlement.entitlement_definition_id == definition.id,
        )
        .first()
    )
    return row.value if row is not None else None


def _check_internal_users(ctx: CompatibilityCheckContext) -> CompatibilityCheckResult:
    from app.modules.auth.models import User

    count = (
        ctx.db.query(User)
        .filter(User.organization_id == ctx.organization_id, User.is_active.is_(True))
        .count()
    )
    limit = ctx.target_plan.max_users
    severity = "pass" if limit is None or count <= limit else "blocker"
    return CompatibilityCheckResult(
        check_id="internal_users_vs_max_users", label="Internal users",
        severity=severity, current_count=count, target_limit=limit,
        detail=(
            f"{count} active user(s); target plan allows "
            + ("unlimited." if limit is None else f"up to {limit}.")
        ),
    )


def _check_legal_entities(ctx: CompatibilityCheckContext) -> CompatibilityCheckResult:
    from app.modules.billing.models import BillingCustomer

    count = (
        ctx.db.query(BillingCustomer)
        .filter(BillingCustomer.organization_id == ctx.organization_id, BillingCustomer.deleted_at.is_(None))
        .count()
    )
    limit = _resolve_target_plan_value(ctx.db, ctx.organization_id, ctx.target_plan.id, "org.entity.max")
    severity = "pass" if limit is None or count <= limit else "blocker"
    return CompatibilityCheckResult(
        check_id="legal_entities_vs_org_entity_max", label="Legal entities",
        severity=severity, current_count=count, target_limit=limit,
        detail=(
            f"{count} billing customer(s) (legal-entity proxy); target plan allows "
            + ("unlimited." if limit is None else f"up to {limit}.")
        ),
    )


def _check_currencies(ctx: CompatibilityCheckContext) -> CompatibilityCheckResult:
    from sqlalchemy import func

    from app.modules.billing.models import CurrencyPricing

    count = (
        ctx.db.query(func.count(func.distinct(CurrencyPricing.currency)))
        .filter(
            CurrencyPricing.organization_id == ctx.organization_id,
            CurrencyPricing.is_active.is_(True),
            CurrencyPricing.deleted_at.is_(None),
        )
        .scalar()
    ) or 0
    limit = _resolve_target_plan_value(ctx.db, ctx.organization_id, ctx.target_plan.id, "currency.enabled.max")
    severity = "pass" if limit is None or count <= limit else "blocker"
    return CompatibilityCheckResult(
        check_id="currencies_vs_currency_enabled_max", label="Enabled currencies",
        severity=severity, current_count=count, target_limit=limit,
        detail=(
            f"{count} distinct currenc{'y' if count == 1 else 'ies'} in active pricing; "
            "target plan allows " + ("unlimited." if limit is None else f"up to {limit}.")
        ),
    )


def _check_payment_providers(ctx: CompatibilityCheckContext) -> CompatibilityCheckResult:
    from app.modules.billing.models import StripeConnectedAccount

    count = (
        ctx.db.query(StripeConnectedAccount)
        .filter(StripeConnectedAccount.organization_id == ctx.organization_id)
        .count()
    )
    limit = _resolve_target_plan_value(ctx.db, ctx.organization_id, ctx.target_plan.id, "payments.provider.max")
    severity = "pass" if limit is None or count <= limit else "blocker"
    return CompatibilityCheckResult(
        check_id="payment_providers_vs_payments_provider_max", label="Payment provider connections",
        severity=severity, current_count=count, target_limit=limit,
        detail=(
            f"{count} connected payment provider account(s); target plan allows "
            + ("unlimited." if limit is None else f"up to {limit}.")
        ),
    )


def _check_usage_billing_contracts(ctx: CompatibilityCheckContext) -> CompatibilityCheckResult:
    from app.modules.billing.models import CONTRACT_BLOCKED_STATUSES, Contract, ContractItem, Product, ProductType

    count = (
        ctx.db.query(Contract.id)
        .join(ContractItem, ContractItem.contract_id == Contract.id)
        .join(Product, Product.id == ContractItem.product_id)
        .filter(
            Contract.organization_id == ctx.organization_id,
            Contract.status.notin_(CONTRACT_BLOCKED_STATUSES),
            Product.product_type == ProductType.USAGE,
        )
        .distinct()
        .count()
    )
    target_allows_usage = bool(
        _resolve_target_plan_value(ctx.db, ctx.organization_id, ctx.target_plan.id, "billing.usage_metering")
    )
    severity = "pass" if count == 0 or target_allows_usage else "blocker"
    return CompatibilityCheckResult(
        check_id="usage_billing_contracts_vs_billing_usage_metering", label="Active usage-billing contracts",
        severity=severity, current_count=count, target_limit=None,
        detail=(
            f"{count} active contract(s) with a usage-metered line item; target plan "
            + ("allows usage metering." if target_allows_usage else "does NOT allow usage metering.")
        ),
    )


def _check_dunning_rules(ctx: CompatibilityCheckContext) -> CompatibilityCheckResult:
    from app.modules.billing.models import DunningLevel

    count = (
        ctx.db.query(DunningLevel)
        .filter(DunningLevel.organization_id == ctx.organization_id, DunningLevel.is_active.is_(True))
        .count()
    )
    target_allows_dunning = bool(
        _resolve_target_plan_value(ctx.db, ctx.organization_id, ctx.target_plan.id, "collections.dunning")
    )
    severity = "pass" if count == 0 or target_allows_dunning else "blocker"
    return CompatibilityCheckResult(
        check_id="dunning_rules_vs_collections_dunning", label="Active dunning rules",
        severity=severity, current_count=count, target_limit=None,
        detail=(
            f"{count} active dunning level(s); target plan "
            + ("allows automated dunning." if target_allows_dunning else "does NOT allow automated dunning.")
        ),
    )


def _check_api_webhooks_noop(ctx: CompatibilityCheckContext) -> CompatibilityCheckResult:
    return CompatibilityCheckResult(
        check_id="api_write_and_webhooks_dependents", label="API write / webhook dependents",
        severity="not_applicable", current_count=None, target_limit=None,
        detail="No ApiKey or WebhookEndpoint model exists in this codebase — this check is a documented no-op.",
    )


def _check_sso_noop(ctx: CompatibilityCheckContext) -> CompatibilityCheckResult:
    return CompatibilityCheckResult(
        check_id="sso_scim_dependency", label="SSO / SCIM dependency",
        severity="not_applicable", current_count=None, target_limit=None,
        detail="No SsoConfig or ScimConfig model exists in this codebase — this check is a documented no-op.",
    )


_COMPATIBILITY_CHECKS: list[Callable[[CompatibilityCheckContext], CompatibilityCheckResult]] = [
    _check_internal_users,
    _check_legal_entities,
    _check_currencies,
    _check_payment_providers,
    _check_usage_billing_contracts,
    _check_dunning_rules,
    _check_api_webhooks_noop,
    _check_sso_noop,
]


def run_compatibility_checks(
    db: Session, organization_id: int, subscription: CommercialSubscription, target_plan: CommercialPlan,
) -> list[CompatibilityCheckResult]:
    ctx = CompatibilityCheckContext(
        db=db, organization_id=organization_id, subscription=subscription, target_plan=target_plan,
    )
    return [check(ctx) for check in _COMPATIBILITY_CHECKS]
