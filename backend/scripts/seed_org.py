"""
scripts/seed_org.py
-------------------
Create an organization + org_admin + optional billing_admin directly in the
database (no invite emails). Useful for local testing and for the Super
Admin to spin up a demo tenant.

Usage:
    python -m scripts.seed_org \
        --org "Acme Corp" \
        --admin-email admin@acme.zoiko.com --admin-password "password123" \
        --billing-email billing@acme.zoiko.com --billing-password "password123"
"""

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.code_generation import generate_organization_code
from app.core.security import hash_password
from app.database import SessionLocal, initialize_database
from app.modules.auth.models import User, UserRole
from app.modules.organizations.models import Organization


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed an organization with users.")
    parser.add_argument("--org", required=True, help="Organization name")
    parser.add_argument("--admin-email", required=True)
    parser.add_argument("--admin-password", required=True)
    parser.add_argument("--billing-email", default=None)
    parser.add_argument("--billing-password", default=None)
    args = parser.parse_args()

    initialize_database()

    db = SessionLocal()
    try:
        code = generate_organization_code(args.org, db)
        org = Organization(
            organization_name=args.org,
            organization_code=code,
            is_active=True,
        )
        db.add(org)
        db.flush()
        print(f"Organization created: {args.org} ({code}) id={org.id}")

        def _add_user(email, password, role, name):
            existing = db.query(User).filter(User.email == email).first()
            if existing:
                print(f"  SKIP {email} — already exists")
                return
            user = User(
                email=email,
                hashed_password=hash_password(password),
                role=role,
                organization_id=org.id,
                first_name=name,
                last_name=role.value.title(),
                phone="",
                is_active=True,
                is_verified=True,
            )
            db.add(user)
            print(f"  Created {role.value}: {email}")

        _add_user(args.admin_email, args.admin_password, UserRole.ORG_ADMIN, "Org")
        if args.billing_email:
            _add_user(args.billing_email, args.billing_password, UserRole.BILLING_ADMIN, "Billing")

        db.commit()
        print("Done.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
