"""
scripts/seed_commercial_plans.py
---------------------------------
Seeds the Plane 1 (Zoiko Commercial Billing) price catalog: the four public
plans (Essentials / Professional / Business / Enterprise) as CommercialPlan
rows, each with one PUBLISHED CommercialPlanVersion.

This is the actual root blocker for the whole Registration -> Plan -> Quote
-> Invoice -> Payment chain: CommercialSubscriptionService.
provision_default_subscription() correctly refuses to invent a subscription
when no is_default/ACTIVE CommercialPlan exists. Until this script runs,
every self-serve registration leaves the org without a subscription.

Essentials/Professional/Business prices are PLACEHOLDER values — clearly
flagged via is_placeholder_pricing=True on their CommercialPlanVersion — NOT
an approved price list. /production-acceptance's COM-01 check reflects this
honestly (WARNING, not PASS) until real Finance-approved numbers replace
them. Enterprise carries no price at all: it is quote/order-form controlled
(is_quote_only=True) and is never provisioned automatically.

Idempotent: skips any plan_code that already exists. Safe to run any number
of times; never mutates or deletes existing rows.

Usage:
    python -m scripts.seed_commercial_plans
"""

import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.database import SessionLocal, initialize_database
from app.modules.commercial.enums import (
    CommercialBillingInterval,
    CommercialPlanStatus,
    CommercialPlanVersionStatus,
)
from app.modules.commercial.models import CommercialPlan, CommercialPlanVersion

# PLACEHOLDER — replace with approved pricing registry values before
# production. Amounts are illustrative only; no approved price list backs
# them yet (ZB-COM-BILL-001 §B2).
PLAN_DEFINITIONS = [
    {
        "plan_code": "essentials",
        "plan_name": "Essentials",
        "description": "Entry-level self-serve plan for small teams.",
        "is_default": True,
        "is_quote_only": False,
        "billing_interval": CommercialBillingInterval.MONTHLY,
        "currency": "USD",
        "price_amount": 49.00,
        "max_users": 5,
        "is_placeholder_pricing": True,
    },
    {
        "plan_code": "professional",
        "plan_name": "Professional",
        "description": "Growing-team self-serve plan with expanded limits.",
        "is_default": False,
        "is_quote_only": False,
        "billing_interval": CommercialBillingInterval.MONTHLY,
        "currency": "USD",
        "price_amount": 149.00,
        "max_users": 25,
        "is_placeholder_pricing": True,
    },
    {
        "plan_code": "business",
        "plan_name": "Business",
        "description": "Self-serve plan for larger teams needing higher limits.",
        "is_default": False,
        "is_quote_only": False,
        "billing_interval": CommercialBillingInterval.MONTHLY,
        "currency": "USD",
        "price_amount": 399.00,
        "max_users": 100,
        "is_placeholder_pricing": True,
    },
    {
        "plan_code": "enterprise",
        "plan_name": "Enterprise",
        "description": "Contract-based plan; price is quote/order-form controlled — never sold self-serve.",
        "is_default": False,
        "is_quote_only": True,
        "billing_interval": None,
        "currency": None,
        "price_amount": None,
        "max_users": None,
        "is_placeholder_pricing": False,
    },
]


def main() -> None:
    initialize_database()

    db = SessionLocal()
    try:
        for definition in PLAN_DEFINITIONS:
            existing = (
                db.query(CommercialPlan)
                .filter(CommercialPlan.plan_code == definition["plan_code"])
                .first()
            )
            if existing:
                print(f"Skipping {definition['plan_code']} — already seeded (plan id={existing.id}).")
                continue

            plan = CommercialPlan(
                plan_code=definition["plan_code"],
                plan_name=definition["plan_name"],
                description=definition["description"],
                status=CommercialPlanStatus.ACTIVE,
                is_default=definition["is_default"],
                is_quote_only=definition["is_quote_only"],
                billing_interval=definition["billing_interval"],
                currency=definition["currency"],
                price_amount=definition["price_amount"],
                max_users=definition["max_users"],
            )
            db.add(plan)
            db.flush()

            version = CommercialPlanVersion(
                plan_id=plan.id,
                version_number=1,
                status=CommercialPlanVersionStatus.PUBLISHED,
                plan_name=definition["plan_name"],
                description=definition["description"],
                billing_interval=definition["billing_interval"],
                currency=definition["currency"],
                price_amount=definition["price_amount"],
                max_users=definition["max_users"],
                is_placeholder_pricing=definition["is_placeholder_pricing"],
                published_at=datetime.now(timezone.utc),
            )
            db.add(version)
            db.commit()
            print(f"Seeded {definition['plan_code']} (plan id={plan.id}, version id={version.id}).")

        print("Commercial plan catalog seed complete.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
