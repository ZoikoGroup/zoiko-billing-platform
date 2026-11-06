"""ZB-TAX-ARCH-001 Phase 5c PR 1: evidence download roles, product names on
classifications, and the audit-evidence bundles (launch gate 06, G-5a-5)."""
from datetime import date

import pytest

from app.modules.auth.models import PlatformRole, UserRole
from app.modules.billing.models import BillingAuditLog
from app.modules.super_admin.models import PlatformAuditAction, PlatformAuditLog
from app.modules.tax.evidence_bundle import canonical, verify
from app.modules.tax.models import EntityTaxRegistration
from app.modules.tax.tenant_tax_service import TenantTaxService, attach_obligation_evidence
from tests.conftest import make_organization
from tests.privacy.conftest import make_super_admin
from tests.privacy.test_tax_phase3a_reports_access import _tenant_user
from tests.test_tax_phase1_registry import _publish, _stage, people, registry  # noqa: F401 (fixtures)
from tests.test_tax_phase3a_governed import build_world

PDF = b"%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n"


@pytest.fixture()
def world(db_session):
    w = build_world(db_session, org_code="P5C1")
    w["auditor"] = _tenant_user(db_session, w["org"], UserRole.AUDITOR, "auditor@p5c1.example")
    reg = db_session.query(EntityTaxRegistration).filter(EntityTaxRegistration.organization_id == w["org"].id).first()
    attach_obligation_evidence(db_session, w["org"].id, w["maker"].id, "registration", reg.id, content=PDF,
                               media_type="application/pdf")
    w["registration"] = reg
    return w


# ── 1. evidence downloads need the upload / decide roles ────────────────

@pytest.mark.parametrize("path", ["registrations/{reg}/evidence", "legal-bases/1/evidence",
                                  "exemption-certificates/1/evidence", "manual-resolutions/1/evidence"])
def test_a_basic_role_in_the_same_org_gets_403(db_session, client_for, world, path):
    url = "/api/v1/tax/" + path.format(reg=world["registration"].id)
    assert client_for(world["auditor"]).get(url).status_code == 403


def test_upload_and_decide_roles_can_download_another_org_gets_404(db_session, client_for, world):
    url = f"/api/v1/tax/registrations/{world['registration'].id}/evidence"
    assert client_for(world["maker"]).get(url).status_code == 200
    assert client_for(world["checker"]).get(url).status_code == 200                    # finance approver
    other = make_organization(db_session, code="P5C1X", name="Other")
    assert client_for(_tenant_user(db_session, other, UserRole.ORG_ADMIN, "a@p5c1x.example")).get(url).status_code == 404
    staff = client_for(make_super_admin(db_session, "pa@p5c1.example", PlatformRole.PLATFORM_ADMINISTRATOR))
    assert staff.get(url).status_code == 403


# ── 2. classifications carry the product name ───────────────────────────

def test_classifications_show_the_product_name(db_session, client_for, world):
    items = client_for(world["maker"]).get("/api/v1/tax/product-classifications").json()["items"]
    assert items and all(i["product_name"] and not i["product_name"].startswith("#") for i in items)


# ── 3a. platform bundles ────────────────────────────────────────────────

def test_platform_rate_bundle_is_sealed_named_and_flags_step_up(db_session, client_for, registry, people):  # noqa: F811
    from app.modules.super_admin.audit_service import PlatformAuditService

    p = registry["pipeline"]
    row = _stage(registry, people["maker"])
    p.validate(actor_id=people["maker"].id, staged_id=row.id)
    p.submit(actor_id=people["maker"].id, staged_id=row.id, reason="from the legal instrument")
    PlatformAuditService(db_session).log_no_commit(actor_id=people["checker"].id, actor_role="super_admin",
                                                   action=PlatformAuditAction.MFA_CHALLENGE_SUCCESS,
                                                   entity_type="SuperAdminMFA", entity_id=1, metadata={"stage": "step_up"})
    p.approve(actor_id=people["checker"].id, staged_id=row.id)
    db_session.commit()

    body = client_for(people["maker"]).get(f"/api/v1/super-admin/tax-registry/evidence-bundles/rate/{row.id}").json()
    assert body["kind"] == "rate" and body["record"]["id"] == row.id and verify(body)
    assert body["sources_and_evidence"][0]["evidence_sha256"] == registry["source"].sha256
    actions = [h["action"] for h in body["history"]]
    assert "TAX_RATE_STAGED" in actions and "TAX_RATE_SUBMITTED" in actions and "TAX_RATE_APPROVED" in actions
    approved = next(h for h in body["history"] if h["action"] == "TAX_RATE_APPROVED")
    assert approved["step_up_verified"] is True and approved["actor"]["name"] == "Chen Checker (TAX_PUBLISHER)"
    assert body["step_up_required_for_decisions"] is True
    assert "organization_id" not in canonical(body)                       # platform data only
    tampered = {**body, "record": {**body["record"], "rate_percent": "99"}}
    assert verify(tampered) is False
    exported = db_session.query(PlatformAuditLog).filter(
        PlatformAuditLog.action == PlatformAuditAction.TAX_EVIDENCE_BUNDLE_EXPORTED).one()
    assert exported.metadata_["bundle_sha256"] == body["bundle_sha256"] and exported.actor_id == people["maker"].id


def test_platform_bundle_html_and_other_kinds(db_session, client_for, registry, people):  # noqa: F811
    version = _publish(registry, people)
    db_session.commit()
    client = client_for(people["checker"])
    html = client.get(f"/api/v1/super-admin/tax-registry/evidence-bundles/source_revision/{registry['source'].id}",
                      params={"format": "html"})
    assert html.status_code == 200 and html.headers["content-type"].startswith("text/html")
    assert html.headers["x-bundle-sha256"] in html.text and "Tax evidence bundle" in html.text
    source = client.get(f"/api/v1/super-admin/tax-registry/evidence-bundles/source_revision/{registry['source'].id}").json()
    assert "artifact_storage_uri" not in source["record"] and source["sources_and_evidence"][0]["evidence_sha256"]
    assert client.get("/api/v1/super-admin/tax-registry/evidence-bundles/widget/1").status_code == 400
    assert client.get("/api/v1/super-admin/tax-registry/evidence-bundles/rate/999999").status_code == 404
    assert version.id


@pytest.mark.parametrize("role", [PlatformRole.PLATFORM_ADMINISTRATOR, PlatformRole.SUPPORT_OPERATOR])
def test_platform_bundles_are_for_tax_roles_only(db_session, client_for, registry, role):  # noqa: F811
    staff = client_for(make_super_admin(db_session, f"{role.value}@p5c1.example", role))
    url = f"/api/v1/super-admin/tax-registry/evidence-bundles/source_revision/{registry['source'].id}"
    assert staff.get(url).status_code == 403


# ── 3b. tenant bundles ──────────────────────────────────────────────────

def test_tenant_registration_bundle_with_evidence_hash_history_and_audit(db_session, client_for, world):
    reg = world["registration"]
    body = client_for(world["checker"]).get(f"/api/v1/tax/evidence-bundles/registration/{reg.id}").json()
    assert body["kind"] == "registration" and body["organization_id"] == world["org"].id and verify(body)
    assert any(e.get("document_sha256") for e in body["evidence"])
    assert body["history"] and all(h["actor"] is None or "user #" not in h["actor"]["name"] for h in body["history"])
    exported = db_session.query(BillingAuditLog).filter(BillingAuditLog.entity_type == "EntityTaxRegistration",
                                                        BillingAuditLog.entity_id == reg.id,
                                                        BillingAuditLog.action == "EXPORT").one()
    assert exported.new_values["evidence_bundle_sha256"] == body["bundle_sha256"]


def test_tenant_legal_basis_bundle_names_proposer_and_decider(db_session, client_for, world):
    svc = TenantTaxService(db_session)
    basis = svc.propose_legal_basis(world["org"].id, world["maker"].id, seller_entity_id=world["entity"].id,
                                    jurisdiction_id=world["gb"].id, tax_type_id=world["vat"].id,
                                    legal_basis="Sch 1A", evidence_ref="cab", valid_from=date(2025, 1, 1))
    svc.decide_legal_basis(world["org"].id, world["checker"].id, basis.id, approve=True)
    body = client_for(world["maker"]).get(f"/api/v1/tax/evidence-bundles/legal_basis/{basis.id}",
                                          params={"format": "html"})
    assert body.status_code == 200 and "Tax evidence bundle: legal_basis" in body.text
    data = client_for(world["maker"]).get(f"/api/v1/tax/evidence-bundles/legal_basis/{basis.id}").json()
    assert data["approvals"]["recorded_by"]["user_id"] == world["maker"].id
    assert data["approvals"]["decided_by"]["user_id"] == world["checker"].id


def test_tenant_bundles_refuse_basic_roles_platform_and_other_tenants(db_session, client_for, world):
    url = f"/api/v1/tax/evidence-bundles/registration/{world['registration'].id}"
    assert client_for(world["auditor"]).get(url).status_code == 403
    staff = client_for(make_super_admin(db_session, "tax@p5c1.example", PlatformRole.TAX_PUBLISHER))
    assert staff.get(url).status_code == 403                                          # T13
    other = make_organization(db_session, code="P5C1Y", name="Other")
    assert client_for(_tenant_user(db_session, other, UserRole.ORG_ADMIN, "b@p5c1y.example")).get(url).status_code == 404


# ── every kind exports and verifies ─────────────────────────────────────

def test_every_tenant_kind_present_in_the_world_exports(db_session, client_for, world):
    from app.modules.tax.models import (
        EntityTaxActivation, EntityTaxLegalBasis, ProductTaxClassification, TaxRegimeChange,
    )
    from app.modules.tax.evidence_bundle import TENANT_KINDS

    svc = TenantTaxService(db_session)
    svc.propose_legal_basis(world["org"].id, world["maker"].id, seller_entity_id=world["entity"].id,
                            jurisdiction_id=world["gb"].id, tax_type_id=world["vat"].id,
                            legal_basis="Sch 1A", evidence_ref="cab", valid_from=date(2025, 1, 1))
    from app.modules.tax.enums import EntityTaxRegime

    current = world["entity"].tax_regime
    target = EntityTaxRegime.LEGACY_MANUAL if current == EntityTaxRegime.GOVERNED else EntityTaxRegime.GOVERNED
    svc.propose_regime_change(world["org"].id, world["maker"].id, world["entity"].id, target, reason="pilot")
    models = {"registration": EntityTaxRegistration, "legal_basis": EntityTaxLegalBasis,
              "activation": EntityTaxActivation, "classification": ProductTaxClassification,
              "regime_change": TaxRegimeChange}
    assert set(models) == set(TENANT_KINDS)
    client, exported = client_for(world["maker"]), set()
    for kind, model in models.items():
        row = db_session.query(model).filter(model.organization_id == world["org"].id).first()
        if row is None:
            continue
        body = client.get(f"/api/v1/tax/evidence-bundles/{kind}/{row.id}").json()
        assert body["kind"] == kind and verify(body), kind
        exported.add(kind)
    assert exported == set(TENANT_KINDS)
    assert client.get("/api/v1/tax/evidence-bundles/widget/1").status_code == 400


def test_every_platform_kind_present_exports(db_session, client_for, world):
    from app.modules.tax.evidence_bundle import PLATFORM_KINDS
    from app.modules.tax.policy_models import TaxCodeSetVersion, TaxMarketAvailabilityVersion, TaxRulePackVersion
    from app.modules.tax.registry_models import TaxLegalSourceRevision, TaxRateStaging

    models = {"source_revision": TaxLegalSourceRevision, "rate": TaxRateStaging, "tax_code_set": TaxCodeSetVersion,
              "rule_pack": TaxRulePackVersion, "market_availability": TaxMarketAvailabilityVersion}
    assert set(models) == set(PLATFORM_KINDS)
    from app.modules.tax.policy_service import RulePackService

    staff = make_super_admin(db_session, "tp@p5c1.example", PlatformRole.TAX_PUBLISHER)
    RulePackService(db_session).register(actor_id=staff.id, code=next(iter(RulePackService.catalogue())))
    db_session.commit()
    client = client_for(staff)
    exported = set()
    for kind, model in models.items():
        row = db_session.query(model).first()
        if row is None:
            continue
        body = client.get(f"/api/v1/super-admin/tax-registry/evidence-bundles/{kind}/{row.id}").json()
        assert body["kind"] == kind and verify(body), (kind, body)
        assert "organization_id" not in canonical(body["record"]), kind
        exported.add(kind)
    print("platform kinds exported:", sorted(exported))
    assert {"tax_code_set", "rule_pack", "market_availability"} <= exported
