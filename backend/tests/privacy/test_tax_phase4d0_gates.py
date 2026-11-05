"""ZB-TAX-ARCH-001 Phase 4d-0: launch-gate gaps from TAX_LAUNCH_GATES.md.

G1: gate 05 (provider contracts, SLA, recovery) must be PASSED for a
PROVIDER_APPROVED market; it may stay NOT_APPLICABLE (with a note) for a
native pack.

G2: gate 07's "visible to Sales/Support": GET /api/v1/tax/coverage lists
published availability only (supported / limited / unsupported), with no
drafts, gate evidence or tenant data, to any signed-in user.
"""
import pytest
from fastapi.testclient import TestClient

from app.core.dependencies import get_current_user
from app.main import app
from app.modules.auth.models import PlatformRole, UserRole
from app.modules.tax.enums import GateStatus, MarketGate, PlatformVersionStatus, TaxOperatingMode, TransactionClass
from app.modules.tax.policy_service import MarketAvailabilityService
from app.modules.tax.registry_models import TaxJurisdiction, TaxTypeDefinition
from tests.privacy.conftest import make_super_admin
from tests.test_tax_phase3a_governed import GATES, build_world

PROVIDER_GATE = MarketGate.PROVIDER_CONTRACTS_AND_RECOVERY.name


@pytest.fixture()
def world(db_session):
    return build_world(db_session, org_code="P4DG")


def _market(db, code):
    j = TaxJurisdiction(code=code, name=f"Market {code}", level="country", country_code=code)
    t = db.query(TaxTypeDefinition).filter(TaxTypeDefinition.code == "VAT").first() or TaxTypeDefinition(
        code="VAT", name="VAT")
    db.add_all([j, t])
    db.flush()
    return j, t


def _draft(w, mode, provider_gate, code="XP", cls=TransactionClass.B2B_SERVICES):
    j, t = _market(w["db"], code)
    gates = {k: dict(v) for k, v in GATES.items()}
    gates[PROVIDER_GATE] = provider_gate
    avail = MarketAvailabilityService(w["db"])
    row = avail.draft(actor_id=w["reviewer"].id, jurisdiction_id=j.id, tax_type_id=t.id, transaction_class=cls,
                      mode=mode, gates=gates)
    return avail, avail.validate(actor_id=w["reviewer"].id, version_id=row.id)


# ── G1: gate 05 is mandatory for provider markets ───────────────────────

def test_a_provider_market_cannot_waive_the_provider_gate(world):
    _, row = _draft(world, TaxOperatingMode.PROVIDER_APPROVED,
                    {"status": GateStatus.NOT_APPLICABLE.name, "notes": "no provider yet"})
    assert row.status == PlatformVersionStatus.VALIDATION_FAILED
    assert any(f"PROVIDER_APPROVED market requires gate {PROVIDER_GATE} PASSED" in e for e in row.validation_errors)


@pytest.mark.parametrize("status", [GateStatus.NOT_STARTED.name, GateStatus.FAILED.name])
def test_a_provider_market_needs_the_provider_gate_passed(world, status):
    _, row = _draft(world, TaxOperatingMode.PROVIDER_APPROVED, {"status": status})
    assert row.status == PlatformVersionStatus.VALIDATION_FAILED


def test_a_provider_market_validates_with_the_provider_gate_passed(world):
    _, row = _draft(world, TaxOperatingMode.PROVIDER_APPROVED,
                    {"status": GateStatus.PASSED.name, "evidence_ref": "CONTRACT-2026-01 + SLA + DPA"})
    assert row.status == PlatformVersionStatus.VALIDATED, row.validation_errors


def test_a_native_market_may_mark_the_provider_gate_not_applicable(world):
    _, row = _draft(world, TaxOperatingMode.NATIVE_RULEPACK_APPROVED,
                    {"status": GateStatus.NOT_APPLICABLE.name, "notes": "native rule pack; no external provider"})
    assert row.status == PlatformVersionStatus.VALIDATED, row.validation_errors


# ── G2: coverage visible to Sales/Support (and tenants) ─────────────────

def _coverage(client, **params):
    response = client.get("/api/v1/tax/coverage", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def test_coverage_lists_published_markets_only_without_evidence(db_session, client_for, world):
    avail, draft = _draft(world, TaxOperatingMode.PROVIDER_APPROVED,
                          {"status": GateStatus.PASSED.name, "evidence_ref": "SECRET-EVIDENCE-REF"}, code="XD")
    staff = client_for(make_super_admin(db_session, "support@p4dg.example", PlatformRole.SUPPORT_OPERATOR))
    body = _coverage(staff)
    assert "does not claim global tax compliance" in body["statement"]
    codes = {c["jurisdiction_code"] for c in body["items"]}
    assert "GB" in codes and "XD" not in codes                     # the draft is not listed
    assert "SECRET-EVIDENCE-REF" not in str(body) and "EV-" not in str(body) and "gates" not in str(body)
    assert all(set(c) == {"jurisdiction_code", "jurisdiction_name", "tax_type", "transaction_class", "mode", "state",
                          "meaning", "published_at"} for c in body["items"])
    gb = [c for c in body["items"] if c["jurisdiction_code"] == "GB"]
    assert gb and all(c["state"] in ("SUPPORTED", "LIMITED", "UNSUPPORTED") for c in gb)


@pytest.mark.parametrize("role", [PlatformRole.SUPPORT_OPERATOR, PlatformRole.AUDITOR, PlatformRole.FINANCE_READONLY,
                                  PlatformRole.TAX_REVIEWER, PlatformRole.PLATFORM_ADMINISTRATOR])
def test_every_platform_role_can_read_coverage(db_session, client_for, world, role):
    staff = client_for(make_super_admin(db_session, f"{role.value}@p4dg.example", role))
    assert _coverage(staff)["items"]


def test_tenant_users_can_read_coverage(db_session, client_for, world):
    assert world["maker"].role == UserRole.BILLING_ADMIN
    assert _coverage(client_for(world["maker"]))["items"]


def test_coverage_needs_a_signed_in_user(world):
    app.dependency_overrides.pop(get_current_user, None)
    assert TestClient(app, raise_server_exceptions=False).get("/api/v1/tax/coverage").status_code == 401


def test_coverage_filters_by_state_and_pages(db_session, client_for, world):
    client = client_for(world["maker"])
    supported = _coverage(client, state="SUPPORTED")["items"]
    assert supported and all(c["state"] == "SUPPORTED" for c in supported)
    first = _coverage(client, limit=1)
    assert len(first["items"]) == 1 and first["next_cursor"]
    rest = _coverage(client, limit=200, cursor=first["next_cursor"])["items"]
    assert first["items"][0] not in rest
    assert client.get("/api/v1/tax/coverage", params={"state": "GLOBAL"}).status_code == 422
