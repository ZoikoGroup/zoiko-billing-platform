"""
scripts/seed_tax_registry.py
----------------------------
Loads the ZB-TAX-ARCH-001 Phase 1 REFERENCE_ONLY seed into the Global Tax
Reference Registry: jurisdictions, authorities, tax types, components, the
handoff-cited legal sources (evidence NOT_CAPTURED) and standard-rate
proposals in staging (PENDING_REVIEW).

It approves, activates and publishes nothing — that requires a TAX_REVIEWER
and a different TAX_PUBLISHER through /api/v1/super-admin/tax-registry.
See app/modules/tax/registry_seed.py for the sourcing rules.

Idempotent: skips rows that already exist; never mutates or deletes.

Usage:
    python -m scripts.seed_tax_registry            # dry run, rolls back
    python -m scripts.seed_tax_registry --apply    # writes
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.database import SessionLocal, initialize_database
from app.modules.tax.registry_seed import seed_registry


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--apply", action="store_true", help="commit the seed (default is a dry run)")
    args = parser.parse_args()

    initialize_database()
    db = SessionLocal()
    try:
        counts = seed_registry(db)
        for key, value in counts.items():
            print(f"  {key:<17} +{value}")
        if args.apply:
            db.commit()
            print("Committed. All staged rates are PENDING_REVIEW; nothing is approved or published.")
        else:
            db.rollback()
            print("Dry run: rolled back. Re-run with --apply to write.")
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()
