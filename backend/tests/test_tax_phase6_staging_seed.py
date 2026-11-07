"""ZB-TAX-ARCH-001 Phase 6 PR 1: the pilot-rehearsal seed script and the
staging deploy workflow's guards."""
from pathlib import Path

import pytest

from app.modules.auth.models import PlatformRole, User, UserRole
from app.modules.billing.models import BillingCustomer, Product
from app.modules.tax.models import SellerLegalEntity
from scripts import seed_tax_pilot_rehearsal as seed_mod

WORKFLOW = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "deploy-staging.yml"


@pytest.fixture()
def staging(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "staging")


def test_seed_creates_every_runbook_role_with_test_data_only(db_session, staging):
    result = seed_mod.seed(db_session, with_platform_staff=True)
    org_id = result["organization_id"]
    users = db_session.query(User).filter(User.email.like("%@rehearsal.zoiko.test")).all()
    roles = sorted(getattr(u.role, "name", u.role) for u in users if u.organization_id == org_id)
    assert roles == ["AUDITOR", "BILLING_ADMIN", "FINANCE_APPROVER", "FINANCE_APPROVER", "ORG_ADMIN", "ORG_ADMIN"]
    staff = {u.platform_role for u in users if u.role == UserRole.SUPER_ADMIN}
    assert staff == {PlatformRole.TAX_REVIEWER, PlatformRole.TAX_PUBLISHER}
    assert all(u.organization_id is None for u in users if u.role == UserRole.SUPER_ADMIN)
    entities = {e.entity_code: e for e in db_session.query(SellerLegalEntity).filter(SellerLegalEntity.organization_id == org_id)}
    assert entities["AU"].country_code == "AU" and any(e.country_code == "GB" and e.is_default for e in entities.values())
    assert all(e.tax_regime.name == "LEGACY_MANUAL" for e in entities.values())   # going GOVERNED is the rehearsal
    customers = db_session.query(BillingCustomer).filter(BillingCustomer.organization_id == org_id).all()
    assert len(customers) == 2 and all("(TEST)" in c.display_name and c.email.endswith(".test") for c in customers)
    assert db_session.query(Product).filter(Product.organization_id == org_id).count() == 2
    assert len(result["passwords"]) == 8 and len(set(result["passwords"].values())) == 8


def test_seed_is_idempotent(db_session, staging):
    first = seed_mod.seed(db_session)
    again = seed_mod.seed(db_session)
    assert again["organization_id"] == first["organization_id"]
    assert again["created"] == [] and again["passwords"] == {}
    assert db_session.query(User).filter(User.email.like("%@rehearsal.zoiko.test")).count() == 6


def test_seed_refuses_production(db_session, monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "production")
    with pytest.raises(SystemExit, match="production"):
        seed_mod.seed(db_session)
    monkeypatch.delenv("ENVIRONMENT")
    monkeypatch.delenv("APP_ENV", raising=False)
    from app.config import settings

    monkeypatch.setattr(settings, "DEBUG", False)                      # unset + DEBUG off = production
    with pytest.raises(SystemExit):
        seed_mod.seed(db_session)


def test_seed_refuses_a_deliverable_email_domain(db_session, staging):
    with pytest.raises(SystemExit, match="reserved"):
        seed_mod.seed(db_session, domain="zoikobilling.com")


def test_staging_workflow_guards():
    text = WORKFLOW.read_text(encoding="utf-8")
    assert "workflow_dispatch" in text and "branches: [staging]" in text
    assert "environment: staging" in text                                  # GitHub environment secrets
    assert "set_env ENVIRONMENT staging" in text
    assert "set_env TAX_PROVIDER_PRODUCTION_CREDENTIALS_ALLOWED false" in text
    assert "set_env MFA_STEP_UP_BYPASS false" in text and "sk_live_" in text     # no bypass, no live Stripe key
    assert "GCP_SSH_HOST" in text and "same host as production" in text      # refuses the production VM
    assert "cd /var/www/zoiko-billing-backend" not in text                  # never the production checkout
    assert "This VM runs production" in text                                # refuses a production VM
    assert "zoiko-billing-staging-backend" in text
    assert "alembic upgrade head" in text
    assert "group: staging-deploy" in text
