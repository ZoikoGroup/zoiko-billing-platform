"""
scripts/backfill_default_trials.py
-----------------------------------
One-off backfill for accounts provisioned before COMMERCIAL_DEFAULT_TRIAL_DAYS
existed: every open CommercialSubscription that is still PENDING and never
had a trial_ends_at is granted a trial now, using the exact same rule
provision_default_subscription() uses for new signups (CommercialSubscriptionService.
start_trial_if_eligible — an active CommercialEvaluationProgram for its plan,
otherwise settings.COMMERCIAL_DEFAULT_TRIAL_DAYS with default terms).

Only touches PENDING subscriptions with trial_ends_at IS NULL. ACTIVE,
SUSPENDED, CANCELLED, EXPIRED and already-TRIALING rows are never touched —
this never overwrites a paying or already-decided subscription. §5 (one
standard trial per organization) is still enforced per row.

Usage:
    python -m scripts.backfill_default_trials            # dry run, no writes
    python -m scripts.backfill_default_trials --apply     # actually writes
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.database import SessionLocal, initialize_database
from app.modules.commercial.enums import CommercialSubscriptionStatus
from app.modules.commercial.models import CommercialPlan, CommercialSubscription
from app.modules.commercial.service import CommercialSubscriptionService


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--apply", action="store_true",
        help="Actually write changes. Without this flag, only previews what would change.",
    )
    args = parser.parse_args()

    initialize_database()
    db = SessionLocal()
    try:
        svc = CommercialSubscriptionService(db)
        candidates = (
            db.query(CommercialSubscription)
            .filter(
                CommercialSubscription.status == CommercialSubscriptionStatus.PENDING,
                CommercialSubscription.trial_ends_at.is_(None),
            )
            .order_by(CommercialSubscription.id.asc())
            .all()
        )
        print(f"Found {len(candidates)} PENDING subscription(s) with no trial_ends_at.")
        if not args.apply:
            print("DRY RUN — no changes will be written. Re-run with --apply to commit.\n")

        granted = 0
        skipped_ineligible = 0
        skipped_no_plan = 0

        for sub in candidates:
            plan = db.query(CommercialPlan).filter(CommercialPlan.id == sub.commercial_plan_id).first()
            if plan is None:
                skipped_no_plan += 1
                print(f"  sub {sub.id}: plan {sub.commercial_plan_id} not found — skipping")
                continue

            if not svc.is_trial_eligible(sub.commercial_account_id):
                skipped_ineligible += 1
                print(
                    f"  sub {sub.id} (account {sub.commercial_account_id}): "
                    "already used its one standard trial — skipping"
                )
                continue

            if args.apply:
                ok = svc.start_trial_if_eligible(sub, plan)
                if ok:
                    svc._recompute_snapshot_for_account(
                        sub.commercial_account_id, reason="trial_backfill",
                    )
                    db.commit()
                    granted += 1
                    print(
                        f"  sub {sub.id} (account {sub.commercial_account_id}, "
                        f"plan {plan.plan_code}): TRIALING, trial_ends_at={sub.trial_ends_at}"
                    )
                else:
                    skipped_ineligible += 1
            else:
                granted += 1
                print(
                    f"  [dry-run] sub {sub.id} (account {sub.commercial_account_id}, "
                    f"plan {plan.plan_code}) would be granted a trial"
                )

        verb = "Granted" if args.apply else "Would grant"
        print(
            f"\n{verb}: {granted} | skipped (already used trial): {skipped_ineligible} "
            f"| skipped (plan missing): {skipped_no_plan}"
        )
        if not args.apply:
            print("Re-run with --apply to write these changes.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
