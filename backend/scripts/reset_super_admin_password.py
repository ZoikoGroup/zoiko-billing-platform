"""
scripts/reset_super_admin_password.py
-------------------------------------
Resets the password for an existing Super Admin user.

Usage:
    set BILLING_SUPER_ADMIN_EMAIL=admin@example.com
    set BILLING_SUPER_ADMIN_PASSWORD=new-strong-password
    python -m scripts.reset_super_admin_password
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.core.security import hash_password
from app.database import SessionLocal
from app.modules.auth.models import User, UserRole

EMAIL = os.environ.get("BILLING_SUPER_ADMIN_EMAIL", "").strip()
PASSWORD = os.environ.get("BILLING_SUPER_ADMIN_PASSWORD", "").strip()


def main() -> None:
    if not EMAIL or not PASSWORD:
        sys.exit("ERROR: BILLING_SUPER_ADMIN_EMAIL and BILLING_SUPER_ADMIN_PASSWORD are required.")
    if len(PASSWORD) < 8:
        sys.exit("ERROR: BILLING_SUPER_ADMIN_PASSWORD must be at least 8 characters.")

    db = SessionLocal()
    try:
        user = db.query(User).filter(User.email == EMAIL).first()
        if not user:
            sys.exit(f"ERROR: no user found with email {EMAIL}.")
        if user.role != UserRole.SUPER_ADMIN:
            sys.exit(f"ERROR: user {EMAIL} has role {user.role}, not super_admin.")

        user.hashed_password = hash_password(PASSWORD)
        db.commit()
        print(f"Password reset for {EMAIL} (role=super_admin).")
    finally:
        db.close()


if __name__ == "__main__":
    main()
