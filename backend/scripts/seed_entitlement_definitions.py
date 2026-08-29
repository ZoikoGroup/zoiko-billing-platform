"""
scripts/seed_entitlement_definitions.py
---------------------------------------
Seeds the typed entitlement catalog (§12–§13, ZB-COM-ENT-001):

  1. EntitlementDefinition rows — the 19 canonical keys with their value
     types, risk classifications, and enforcement types.
  2. PlanEntitlement rows — concrete values for each key on each published
     CommercialPlanVersion (Essentials / Professional / Business / Enterprise).

Enterprise rows are inserted with is_contracted=True and value=NULL: the
entitlement is governed by the signed order form, not this catalog.

Idempotent: skips any entitlement key that already exists, and skips any
PlanEntitlement for a (version, definition) pair already present. Safe to
run any number of times.

Usage:
    python -m scripts.seed_entitlement_definitions
"""

import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.database import SessionLocal, initialize_database
from app.modules.commercial.enums import CommercialPlanVersionStatus
from app.modules.commercial.entitlement_catalog_spec import ENTITLEMENT_CATALOG_SPEC
from app.modules.commercial.models import (
    CommercialPlan,
    CommercialPlanVersion,
    EntitlementDefinition,
    PlanEntitlement,
)

# §12 — the 19 canonical entitlement keys. Single source of truth lives in
# entitlement_catalog_spec.py (shared with require_entitlement's validation
# and the enforcement checklist doc) so this seed script can never drift
# from what route-time code actually validates against.
ENTITLEMENT_DEFINITIONS = ENTITLEMENT_CATALOG_SPEC

# §3 + §4 — PlanEntitlement values per plan_code for each of the 19 keys.
# Keys: plan_code -> { entitlement_key: value }
# Enterprise: all keys -> None (is_contracted=True, value=NULL).
PLAN_ENTITLEMENT_VALUES = {
    "essentials": {
        # Core billing
        "billing.invoice.create": True,
        "billing.invoice.monthly_limit": 100,
        "billing.recurring.manage": False,
        "billing.subscription.lifecycle": False,
        "billing.proration.manage": False,
        "billing.usage_metering": False,
        "billing.pricing_model_set": ["flat"],
        # Payments / collections
        "payments.provider.max": 1,
        "reconciliation.automation": False,
        "collections.dunning": False,
        # Tax / multi-entity
        "org.entity.max": 1,
        "currency.enabled.max": 1,
        # Governance / security
        "security.custom_roles": False,
        "security.sso": False,
        "api.write": False,
        # Integrations / analytics
        "api.requests_per_day": 5000,
        "webhooks.endpoint.max": 2,
        "audit.search_months": 3,
        "sandbox.workspace.max": 1,
    },
    "professional": {
        # Core billing
        "billing.invoice.create": True,
        "billing.invoice.monthly_limit": 1000,
        "billing.recurring.manage": True,
        "billing.subscription.lifecycle": True,
        "billing.proration.manage": True,
        "billing.usage_metering": True,
        "billing.pricing_model_set": ["flat", "tiered", "volume"],
        # Payments / collections
        "payments.provider.max": 2,
        "reconciliation.automation": True,
        "collections.dunning": True,
        # Tax / multi-entity
        "org.entity.max": 2,
        "currency.enabled.max": 5,
        # Governance / security
        "security.custom_roles": True,
        "security.sso": True,
        "api.write": True,
        # Integrations / analytics
        "api.requests_per_day": 50000,
        "webhooks.endpoint.max": 10,
        "audit.search_months": 12,
        "sandbox.workspace.max": 3,
    },
    "business": {
        # Core billing
        "billing.invoice.create": True,
        "billing.invoice.monthly_limit": 10000,
        "billing.recurring.manage": True,
        "billing.subscription.lifecycle": True,
        "billing.proration.manage": True,
        "billing.usage_metering": True,
        "billing.pricing_model_set": ["flat", "tiered", "volume", "stairstep"],
        # Payments / collections
        "payments.provider.max": 5,
        "reconciliation.automation": True,
        "collections.dunning": True,
        # Tax / multi-entity
        "org.entity.max": 10,
        "currency.enabled.max": 20,
        # Governance / security
        "security.custom_roles": True,
        "security.sso": True,
        "api.write": True,
        # Integrations / analytics
        "api.requests_per_day": 200000,
        "webhooks.endpoint.max": 50,
        "audit.search_months": 24,
        "sandbox.workspace.max": 10,
    },
}


def _get_latest_published_version(db, plan_id: int):
    """Get the latest PUBLISHED CommercialPlanVersion for a plan."""
    return (
        db.query(CommercialPlanVersion)
        .filter(
            CommercialPlanVersion.plan_id == plan_id,
            CommercialPlanVersion.status == CommercialPlanVersionStatus.PUBLISHED,
        )
        .order_by(CommercialPlanVersion.version_number.desc())
        .first()
    )


def main() -> None:
    initialize_database()

    db = SessionLocal()
    try:
        # ── 1. Seed EntitlementDefinition rows ─────────────────────────────
        key_to_def = {}
        for defn in ENTITLEMENT_DEFINITIONS:
            existing = (
                db.query(EntitlementDefinition)
                .filter(EntitlementDefinition.key == defn["key"])
                .first()
            )
            if existing:
                print(f"  EntitlementDefinition '{defn['key']}' already exists (id={existing.id}).")
                key_to_def[defn["key"]] = existing
                continue

            ent = EntitlementDefinition(
                key=defn["key"],
                value_type=defn["value_type"],
                risk_classification=defn["risk_classification"],
                enforcement_type=defn["enforcement_type"],
                description=defn["description"],
            )
            db.add(ent)
            db.flush()
            key_to_def[defn["key"]] = ent
            print(f"  Seeded EntitlementDefinition '{defn['key']}' (id={ent.id}).")

        db.commit()
        print(f"Entitlement definitions seed complete ({len(ENTITLEMENT_DEFINITIONS)} keys).\n")

        # ── 2. Seed PlanEntitlement rows ───────────────────────────────────
        plans = db.query(CommercialPlan).all()
        plan_by_code = {p.plan_code: p for p in plans}

        seeded_count = 0
        skipped_count = 0

        for plan_code, values in PLAN_ENTITLEMENT_VALUES.items():
            plan = plan_by_code.get(plan_code)
            if plan is None:
                print(f"  WARNING: Plan '{plan_code}' not found — skipping PlanEntitlements.")
                continue

            version = _get_latest_published_version(db, plan.id)
            if version is None:
                print(f"  WARNING: No PUBLISHED version for plan '{plan_code}' — skipping.")
                continue

            for ent_key, value in values.items():
                ent_def = key_to_def.get(ent_key)
                if ent_def is None:
                    print(f"  WARNING: EntitlementDefinition '{ent_key}' not found — skipping.")
                    continue

                existing_pe = (
                    db.query(PlanEntitlement)
                    .filter(
                        PlanEntitlement.plan_version_id == version.id,
                        PlanEntitlement.entitlement_definition_id == ent_def.id,
                    )
                    .first()
                )
                if existing_pe:
                    skipped_count += 1
                    continue

                pe = PlanEntitlement(
                    plan_version_id=version.id,
                    entitlement_definition_id=ent_def.id,
                    value=value,
                    is_contracted=False,
                )
                db.add(pe)
                seeded_count += 1

        # Enterprise: all keys with is_contracted=True, value=NULL
        enterprise_plan = plan_by_code.get("enterprise")
        if enterprise_plan is not None:
            enterprise_version = _get_latest_published_version(db, enterprise_plan.id)
            if enterprise_version is not None:
                for ent_key in key_to_def:
                    ent_def = key_to_def[ent_key]
                    existing_pe = (
                        db.query(PlanEntitlement)
                        .filter(
                            PlanEntitlement.plan_version_id == enterprise_version.id,
                            PlanEntitlement.entitlement_definition_id == ent_def.id,
                        )
                        .first()
                    )
                    if existing_pe:
                        skipped_count += 1
                        continue

                    pe = PlanEntitlement(
                        plan_version_id=enterprise_version.id,
                        entitlement_definition_id=ent_def.id,
                        value=None,
                        is_contracted=True,
                    )
                    db.add(pe)
                    seeded_count += 1

        db.commit()
        print(
            f"PlanEntitlements seed complete: {seeded_count} inserted, "
            f"{skipped_count} skipped (already exist)."
        )
    finally:
        db.close()


if __name__ == "__main__":
    main()
