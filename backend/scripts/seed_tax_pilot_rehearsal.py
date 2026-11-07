"""
scripts/seed_tax_pilot_rehearsal.py
-----------------------------------
ZB-TAX-ARCH-001 Phase 6: seed a STAGING (or local) database for the UK/AU
pilot rehearsal (backend/docs/TAX_PILOT_RUNBOOK_UK_AU.md).

Creates, idempotently (a second run changes nothing and prints what exists):
  * one test tenant, "Pilot Rehearsal Ltd (TEST)", with two seller entities:
    PRIMARY (GB, Europe/London) and AU (Australia/Sydney), both LEGACY_MANUAL.
    Switching to GOVERNED is part of the rehearsal, not the seed.
  * tenant users for every runbook role: two org admins, a billing admin,
    two finance approvers and an auditor.
  * optionally (--with-platform-staff) a TAX_REVIEWER and a TAX_PUBLISHER.
  * two test customers (one GB, one AU) and two service products.

No real data: every name says TEST, every email is on a reserved,
non-deliverable domain (default rehearsal.zoiko.test, RFC 2606), and no
customer data is copied from anywhere. Passwords are generated per run and
printed once; nothing is written to disk.

Refuses to run in production (ENVIRONMENT=production, or ENVIRONMENT unset
with DEBUG off), using the same check as the tax secret store.

Usage (on the staging VM, from backend/ with the venv active):
    ENVIRONMENT=staging python -m scripts.seed_tax_pilot_rehearsal [--with-platform-staff]
"""
import argparse
import secrets
import sys
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

ORG_NAME = "Pilot Rehearsal Ltd (TEST)"
DEFAULT_DOMAIN = "rehearsal.zoiko.test"

TENANT_USERS = (
    # (local part, first, last, role)
    ("org-admin", "Ana", "Admin (TEST)", "ORG_ADMIN"),
    ("org-admin-2", "Omar", "Admin (TEST)", "ORG_ADMIN"),
    ("billing", "Bo", "Billing (TEST)", "BILLING_ADMIN"),
    ("finance", "Fay", "Finance (TEST)", "FINANCE_APPROVER"),
    ("finance-2", "Gil", "Finance (TEST)", "FINANCE_APPROVER"),
    ("auditor", "Aud", "Auditor (TEST)", "AUDITOR"),
)
PLATFORM_USERS = (
    ("tax-reviewer", "Mara", "Reviewer (TEST)", "TAX_REVIEWER"),
    ("tax-publisher", "Chen", "Publisher (TEST)", "TAX_PUBLISHER"),
)


class ProductionRefused(SystemExit):
    pass


def refuse_production() -> None:
    from app.modules.tax.secret_store import is_production

    if is_production():
        raise ProductionRefused("Refusing to seed: this looks like production. Set ENVIRONMENT=staging (or "
                                "development) on a staging or local database.")


def _password() -> str:
    return secrets.token_urlsafe(14) + "!9a"


def seed(db, *, domain: str = DEFAULT_DOMAIN, with_platform_staff: bool = False) -> dict:
    """Idempotent. Returns {"organization_id", "created": [...], "existing": [...], "passwords": {email: pw}}."""
    from app.core.code_generation import generate_organization_code
    from app.core.security import hash_password
    from app.modules.auth.models import PlatformRole, User, UserRole
    from app.modules.billing.models import BillingCustomer, Product
    from app.modules.organizations.models import Organization
    from app.modules.tax.legal_entity_service import LegalEntityService
    from app.modules.tax.models import SellerLegalEntity

    refuse_production()
    if not domain.endswith(".test") and not domain.endswith(".example"):
        raise SystemExit("Use a reserved, non-deliverable email domain (.test or .example) for rehearsal users.")
    created, existing, passwords = [], [], {}

    org = db.query(Organization).filter(Organization.organization_name == ORG_NAME).first()
    if org is None:
        org = Organization(organization_name=ORG_NAME, organization_code=generate_organization_code(ORG_NAME, db),
                           is_active=True, country="United Kingdom", currency="GBP", timezone="Europe/London",
                           legal_name=ORG_NAME)
        db.add(org)
        db.flush()
        try:
            from app.modules.commercial.service import CommercialAccountService

            CommercialAccountService(db).ensure_commercial_account(org.id)
        except Exception:                               # commercial catalog may be unseeded on a fresh staging DB
            pass
        created.append(f"organization {ORG_NAME}")
    else:
        existing.append(f"organization {ORG_NAME}")

    def user(local, first, last, role, platform_role=None, org_id=None):
        email = f"{local}@{domain}"
        row = db.query(User).filter(User.email == email).first()
        if row is not None:
            existing.append(email)
            return row
        pw = _password()
        row = User(email=email, hashed_password=hash_password(pw), first_name=first, last_name=last,
                   role=UserRole[role] if platform_role is None else UserRole.SUPER_ADMIN,
                   platform_role=PlatformRole[platform_role] if platform_role else None,
                   organization_id=org_id, is_active=True, is_verified=True)
        db.add(row)
        db.flush()
        created.append(email)
        passwords[email] = pw
        return row

    admin = None
    for local, first, last, role in TENANT_USERS:
        u = user(local, first, last, role, org_id=org.id)
        admin = admin or u
    if with_platform_staff:
        for local, first, last, platform_role in PLATFORM_USERS:
            user(local, first, last, None, platform_role=platform_role)

    entities = LegalEntityService(db)
    gb = entities.ensure_default_entity(org.id, created_by=admin.id)
    if gb.country_code != "GB":
        gb.country_code, gb.timezone = "GB", "Europe/London"
    au = db.query(SellerLegalEntity).filter(SellerLegalEntity.organization_id == org.id,
                                            SellerLegalEntity.entity_code == "AU").first()
    if au is None:
        au = SellerLegalEntity(organization_id=org.id, entity_code="AU", legal_name="Pilot Rehearsal Pty Ltd (TEST)",
                               display_name="Pilot Rehearsal AU (TEST)", country_code="AU", timezone="Australia/Sydney",
                               is_default=False, is_active=True, created_by=admin.id)
        db.add(au)
        db.flush()
        created.append("seller entity AU")
    else:
        existing.append("seller entity AU")

    for code, name, currency in (("TEST-GB-1", "Test Customer GB (TEST)", "GBP"),
                                 ("TEST-AU-1", "Test Customer AU (TEST)", "AUD")):
        if db.query(BillingCustomer).filter(BillingCustomer.organization_id == org.id,
                                            BillingCustomer.customer_code == code).first():
            existing.append(f"customer {code}")
            continue
        db.add(BillingCustomer(organization_id=org.id, customer_code=code, company_name=name, display_name=name,
                               currency=currency, email=f"{code.lower()}@{domain}"))
        created.append(f"customer {code}")

    for code, name, price in (("TEST-SVC-CONSULT", "Consulting hour (TEST)", "100"),
                              ("TEST-SVC-SUPPORT", "Support plan (TEST)", "50")):
        if db.query(Product).filter(Product.organization_id == org.id, Product.code == code).first():
            existing.append(f"product {code}")
            continue
        db.add(Product(organization_id=org.id, name=name, code=code, default_price=Decimal(price)))
        created.append(f"product {code}")

    db.commit()
    return {"organization_id": org.id, "created": created, "existing": existing, "passwords": passwords}


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed staging for the UK/AU tax pilot rehearsal (test data only).")
    parser.add_argument("--domain", default=DEFAULT_DOMAIN, help="Reserved email domain for the test users")
    parser.add_argument("--with-platform-staff", action="store_true",
                        help="Also create a TAX_REVIEWER and a TAX_PUBLISHER platform account")
    args = parser.parse_args()

    refuse_production()
    from app.database import SessionLocal, initialize_database

    initialize_database()
    db = SessionLocal()
    try:
        result = seed(db, domain=args.domain, with_platform_staff=args.with_platform_staff)
    finally:
        db.close()
    print(f"Organization id: {result['organization_id']}")
    for item in result["created"]:
        print(f"  created  {item}")
    for item in result["existing"]:
        print(f"  exists   {item}")
    if result["passwords"]:
        print("\nPasswords for NEW users (shown once; store them in the team's password manager):")
        for email, pw in result["passwords"].items():
            print(f"  {email}  {pw}")
    print("\nNext: follow backend/docs/TAX_PILOT_RUNBOOK_UK_AU.md. Approvers set up MFA first "
          "(/billing/tax/governance/mfa); a new factor waits TAX_STEP_UP_NEW_FACTOR_DELAY_HOURS before approving.")


if __name__ == "__main__":
    main()
