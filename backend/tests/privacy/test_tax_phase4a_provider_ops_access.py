"""ZB-TAX-ARCH-001 Phase 4a-1 — provider operations: who sees what (T13).

Platform tax and operations roles see provider health as aggregates only: counts per state,
oldest age, circuit state and the reconciliation heartbeat. No organization,
invoice, customer or idempotency identifiers. Suspending a provider (T16)
needs the approve capability and MFA step-up, and is audited.
"""
import pytest

from app.modules.auth.models import PlatformRole
from app.modules.super_admin.models import PlatformAuditLog
from app.modules.tax.enums import CircuitState, OutboxOperation, OutboxState
from app.modules.tax.provider_models import TaxProviderCircuit, TaxProviderOutbox
from tests.privacy.conftest import make_super_admin
from tests.test_tax_phase3a_governed import build_world, draft, finalize, quote

HEALTH = "/api/v1/super-admin/tax-registry/provider-health"


@pytest.fixture()
def stuck(db_session):
    w = build_world(db_session, org_code="P4AOPS")
    inv = draft(w, [(w["dig_product"], 100, 1, False)], number="INV-OPS-SECRET-1")
    quote(w, inv)
    w["provider"].fail_mode = "timeout_after_success"
    finalize(w, inv)                                               # leaves one UNCERTAIN row
    return {"w": w, "invoice": inv}


@pytest.mark.parametrize("role", [PlatformRole.TAX_REVIEWER, PlatformRole.TAX_PUBLISHER,
                                  PlatformRole.RELIABILITY_OPERATOR, PlatformRole.SECURITY_OPERATOR])
def test_tax_and_operations_roles_see_aggregates_only(db_session, client_for, stuck, role):
    client = client_for(make_super_admin(db_session, f"{role.value}@p4a-ops.example", role))
    response = client.get(HEALTH)
    assert response.status_code == 200, response.text
    body = response.json()
    assert set(body) == {"providers", "reconciliation"}
    assert set(body["providers"][0]) == {"provider", "counts", "oldest_active_age_seconds", "circuit"}
    row = db_session.query(TaxProviderOutbox).filter(TaxProviderOutbox.operation == OutboxOperation.COMMIT).one()
    w = stuck["w"]
    for secret in ("INV-OPS-SECRET-1", row.idempotency_key, w["customer"].email, w["org"].organization_name,
                   "organization_id", "invoice_id", "customer"):
        assert secret not in response.text, secret


@pytest.mark.parametrize("role", [PlatformRole.FINANCE_READONLY])
def test_other_platform_roles_are_refused(db_session, client_for, stuck, role):
    client = client_for(make_super_admin(db_session, f"{role.value}@p4a-deny.example", role))
    assert client.get(HEALTH).status_code == 403


def test_suspend_needs_approve_capability_and_step_up(db_session, client_for, stuck, monkeypatch):
    reviewer = client_for(make_super_admin(db_session, "rev@p4a-susp.example", PlatformRole.TAX_REVIEWER))
    assert reviewer.post(f"{HEALTH}/fake-provider/suspend", json={"reason": "x"}).status_code == 403
    publisher = make_super_admin(db_session, "pub@p4a-susp.example", PlatformRole.TAX_PUBLISHER)
    client = client_for(publisher)
    monkeypatch.setattr("app.config.settings.TAX_REGISTRY_STEP_UP_REQUIRED", True)
    monkeypatch.setattr("app.config.step_up_bypass_active", lambda: False)
    refused = client.post(f"{HEALTH}/fake-provider/suspend", json={"reason": "contract ended"})
    assert refused.status_code == 400 and "step-up" in refused.text
    monkeypatch.setattr("app.config.settings.TAX_REGISTRY_STEP_UP_REQUIRED", False)
    done = client.post(f"{HEALTH}/fake-provider/suspend", json={"reason": "contract ended"})
    assert done.status_code == 200, done.text
    assert db_session.get(TaxProviderCircuit, "fake-provider").state == CircuitState.SUSPENDED
    audit = db_session.query(PlatformAuditLog).filter(PlatformAuditLog.entity_type == "TaxProviderCircuit").one()
    assert audit.actor_id == publisher.id
    assert client.post(f"{HEALTH}/fake-provider/resume", json={}).status_code == 200
    assert db_session.get(TaxProviderCircuit, "fake-provider").state == CircuitState.CLOSED
