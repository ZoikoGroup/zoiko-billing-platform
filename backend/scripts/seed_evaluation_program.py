"""
scripts/seed_evaluation_program.py
----------------------------------
Seeds a 30-day Plane 1 (Zoiko Commercial Billing) free-trial/evaluation
program for every self-serve (non-quote-only, ACTIVE) CommercialPlan:
Essentials / Professional / Business.

Business intent: every new self-serve organisation gets a 30-day evaluation
period, after which it must pay or the trial_expiry sweep suspends its
subscription (commercial/tasks/trial_expiry.py). The sweep no-ops unless
ENABLE_COMMERCIAL_TRIAL_ENFORCEMENT is true (see app/config.py).

Idempotent: skips any plan that already has an (active or inactive)
CommercialEvaluationProgram. Existing programs are never mutated or
deleted. Safe to run any number of times after seed_commercial_plans.py.

Governance note (§B3): an evaluation program can only be activated with a
non-NULL approved_by (commercial_billing_router.py enforces this). This
script resolves approved_by to the first SUPER_ADMIN user in the users
table. If no super admin exists, the program is created but LEFT INACTIVE
and a warning is logged — this script never fabricates a user, matching the
repo's seeding conventions. The trial's granted_plan_id points at the
Professional plan (per §5, the standard trial grants Professional's
entitlement bundle regardless of signup plan).

Usage:
    python -m scripts.seed_commercial_plans   # first, if plans absent
    python -m scripts.seed_evaluation_program
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.database import SessionLocal, initialize_database
from app.modules.auth.models import User, UserRole
from app.modules.commercial.enums import (
    CommercialEvaluationConversionPolicy,
    CommercialEvaluationExpiryAction,
    CommercialEvaluationPaymentRequirement,
    CommercialPlanStatus,
)
from app.modules.commercial.models import (
    CommercialEvaluationProgram,
    CommercialPlan,
)

TRIAL_DURATION_DAYS = 30

# The plan whose entitlement bundle is granted during the trial (§5).
GRANTED_PLAN_CODE = "professional"


def main() -> None:
    initialize_database()

    db = SessionLocal()
    try:
        approved_by = (
            db.query(User)
            .filter(
                User.role == UserRole.SUPER_ADMIN,
                User.is_active.is_(True),
            )
            .order_by(User.id.asc())
            .first()
        )
        approve_user_id = approved_by.id if approved_by else None
        if approve_user_id is None:
            print(
                "WARNING: no active SUPER_ADMIN user found — evaluation programs "
                "will be created INACTIVE (set approved_by via the API to activate)."
            )

        granted_plan = (
            db.query(CommercialPlan)
            .filter(
                CommercialPlan.plan_code == GRANTED_PLAN_CODE,
                CommercialPlan.status == CommercialPlanStatus.ACTIVE,
            )
            .first()
        )
        if granted_plan is None:
            print(
                f"WARNING: no ACTIVE plan with plan_code={GRANTED_PLAN_CODE!r} — "
                "trial programs will not set granted_plan_id."
            )

        plans = (
            db.query(CommercialPlan)
            .filter(
                CommercialPlan.is_quote_only.is_(False),
                CommercialPlan.status == CommercialPlanStatus.ACTIVE,
            )
            .order_by(CommercialPlan.id.asc())
            .all()
        )
        if not plans:
            print(
                "No self-serve (ACTIVE, non-quote-only) CommercialPlan found. "
                "Run `python -m scripts.seed_commercial_plans` first."
            )

        for plan in plans:
            existing = (
                db.query(CommercialEvaluationProgram)
                .filter(CommercialEvaluationProgram.plan_id == plan.id)
                .first()
            )
            if existing is not None:
                print(
                    f"Skipping {plan.plan_code} — evaluation program already exists "
                    f"(id={existing.id}, is_active={existing.is_active})."
                )
                continue

            program = CommercialEvaluationProgram(
                plan_id=plan.id,
                is_active=approve_user_id is not None,
                duration_days=TRIAL_DURATION_DAYS,
                payment_requirement=CommercialEvaluationPaymentRequirement.NONE,
                conversion_policy=CommercialEvaluationConversionPolicy.MANUAL,
                expiry_action=CommercialEvaluationExpiryAction.SUSPEND,
                created_by=approve_user_id,
                approved_by=approve_user_id,
                granted_plan_id=granted_plan.id if granted_plan else None,
            )
            db.add(program)
            db.commit()
            print(
                f"Seeded {plan.plan_code} (program id={program.id}, "
                f"duration_days={TRIAL_DURATION_DAYS}, is_active={program.is_active})."
            )

        print("Evaluation program seed complete.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
