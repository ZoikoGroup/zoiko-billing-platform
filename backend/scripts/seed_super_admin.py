"""
scripts/seed_super_admin.py
---------------------------
Creates the platform's first Super Admin account. Super Admin accounts can
NEVER be created through /auth/register (that endpoint only creates a new
organization + its first org_admin). This script requires SETUP_KEY in the
environment to run, and the email must not already exist.

Usage:
    set SETUP_KEY=your-setup-key
    set BILLING_SUPER_ADMIN_EMAIL=admin@example.com
    set BILLING_SUPER_ADMIN_PASSWORD=strong-password
    python -m scripts.seed_super_admin
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import settings
from app.core.security import hash_password
from app.database import SessionLocal, initialize_database
from app.modules.auth.models import User, UserRole

SETUP_KEY = os.environ.get("SETUP_KEY", "").strip()
EMAIL = os.environ.get("BILLING_SUPER_ADMIN_EMAIL", "").strip()
PASSWORD = os.environ.get("BILLING_SUPER_ADMIN_PASSWORD", "").strip()
FIRST_NAME = os.environ.get("BILLING_SUPER_ADMIN_FIRST_NAME", "Platform").strip()
LAST_NAME = os.environ.get("BILLING_SUPER_ADMIN_LAST_NAME", "Admin").strip()


def main() -> None:
    if not SETUP_KEY:
        sys.exit("ERROR: SETUP_KEY environment variable is required to seed a Super Admin.")
    if not EMAIL or not PASSWORD:
        sys.exit("ERROR: BILLING_SUPER_ADMIN_EMAIL and BILLING_SUPER_ADMIN_PASSWORD are required.")
    if len(PASSWORD) < 8:
        sys.exit("ERROR: BILLING_SUPER_ADMIN_PASSWORD must be at least 8 characters.")

    initialize_database()

    db = SessionLocal()
    try:
        existing = db.query(User).filter(User.email == EMAIL).first()
        if existing:
            sys.exit(f"ERROR: a user with email {EMAIL} already exists.")

        user = User(
            email=EMAIL,
            hashed_password=hash_password(PASSWORD),
            role=UserRole.SUPER_ADMIN,
            organization_id=None,
            first_name=FIRST_NAME,
            last_name=LAST_NAME,
            phone="",
            is_active=True,
            is_verified=True,
        )
        db.add(user)
        db.commit()
        print(f"Super Admin created: {EMAIL} (role=super_admin, no organization).")
    finally:
        db.close()


if __name__ == "__main__":
    main()
