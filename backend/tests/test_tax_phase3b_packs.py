"""
tests/test_tax_phase3b_packs.py
-------------------------------
ZB-TAX-ARCH-001 Phase 3b: the UK and Australia native rule packs, their
two-person approval, GOVERNED enablement (T12), the T05 UK golden case, T14
expiry blocking, and the invoice-editor / Exceptions read models (§11).

The packs read published registry rates only; the rates and sources here are
fixtures standing in for what the tax lead publishes. Nothing in this module
asserts a legal rate as fact.
"""
import pathlib
import re
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest

from app.core.exceptions import BadRequestException, NotFoundException
from app.modules.auth.models import PlatformRole, User, UserRole
from app.modules.billing.models import BillingAuditLog, Invoice, InvoiceStatus
from app.modules.billing.services.invoice_service import InvoiceService
from app.modules.super_admin.models import ApprovalRequest, PlatformAuditLog
from app.modules.tax.buyer_evidence_service import BuyerEvidenceService
from app.modules.tax.classification_service import ClassificationService
from app.modules.tax.determination_service import TaxDeterminationService
from app.modules.tax.engines import EngineResolver, registered_rule_packs
from app.modules.tax.enums import (
    AcquisitionMethod,
    AddressRole,
    EngineKind,
    EntityTaxRegime,
    MarketGate,
    RateKind,
    RedistributionPermission,
    RoundingMode,
    RoundingRule,
    SourceTier,
    StagingOrigin,
    SupplyCategory,
    TaxOperatingMode,
    TaxQuoteStatus,
    TransactionClass,
    VerificationStatus,
)
from app.modules.tax.exception_service import TaxExceptionService
from app.modules.tax.issuance_gate import TaxIssuanceBlocked
from app.modules.tax.legal_entity_service import LegalEntityService
from app.modules.tax.policy_models import TaxRulePackVersion
from app.modules.tax.policy_service import (
    MarketAvailabilityService,
    RulePackService,
    TaxCodeSetService,
    active_code_set,
)
from app.modules.tax.registry_models import (
    TaxAuthority,
    TaxChangeApproval,
    TaxComponent,
    TaxJurisdiction,
    TaxRateStaging,
    TaxRateVersion,
    TaxTypeDefinition,
)
from app.modules.tax.registry_service import MakerCheckerError, RegistryStateError, TaxRegistryPipeline
from app.modules.tax.rule_packs import AuGstDomesticServices, UkVatDomesticServices
from app.modules.tax.tenant_tax_service import TenantTaxService
from tests.conftest import make_customer, make_invoice, make_invoice_item, make_organization

GATES = {g.name: {"status": "PASSED", "evidence_ref": f"EV-{g.name}"} for g in MarketGate}
TAX_DATE = date(2026, 6, 1)
NOW = datetime.now(timezone.utc)
GOLDEN = {"suite": "tests/test_tax_phase3b_packs.py", "commit": "0123456789abcdef", "passed": 30, "failed": 0}
NATIVE = TaxOperatingMode.NATIVE_RULEPACK_APPROVED
SERVICES = (TransactionClass.B2B_SERVICES, TransactionClass.B2C_SERVICES)


# ── world ───────────────────────────────────────────────────────────────

def _user(db, email, role, org_id=None, platform_role=None):
    u = User(email=email, hashed_password="x", role=role, organization_id=org_id, platform_role=platform_role,
             first_name="T", last_name=email.split("@")[0], is_active=True, is_verified=True)
    db.add(u)
    db.flush()
    return u


def _source(w, authority, ref, approved=True):
    pipeline = TaxRegistryPipeline(w["db"])
    source = pipeline.register_source_revision(
        actor_id=w["reviewer"].id, authority_id=authority.id, source_tier=SourceTier.OFFICIAL_GUIDANCE,
        acquisition_method=AcquisitionMethod.MANUAL_VERIFIED_EXTRACTION, permanent_url=f"https://example.test/{ref}",
        title=f"Fixture source {ref}", citation=f"Fixture citation [{ref}]", language="en", handoff_ref=ref)
    if approved:
        pipeline.attach_evidence(actor_id=w["reviewer"].id, revision_id=source.id, content=f"<p>{ref}</p>".encode(),
                                 media_type="text/html", filename=f"{ref}.html",
                                 redistribution_permission=RedistributionPermission.PERMITTED)
    return source


def published_rate(db, component, source, rate, valid_from, valid_to=None):
    """A published reference rate (the Phase 1 pipeline has its own tests)."""
    staged = TaxRateStaging(origin=StagingOrigin.MANUAL, component_id=component.id, tax_code="STANDARD",
                            product_scope="GENERAL", rate_kind=RateKind.STANDARD, observed_at=NOW, created_at=NOW)
    request = ApprovalRequest(request_type="tax_rate_publish", requested_at=datetime.utcnow())
    db.add_all([staged, request])
    db.flush()
    change = TaxChangeApproval(approval_request_id=request.id, staged_rate_id=staged.id, change_kind="NEW",
                               detector=StagingOrigin.MANUAL, submitted_at=NOW)
    db.add(change)
    db.flush()
    version = TaxRateVersion(
        component_id=component.id, jurisdiction_id=component.jurisdiction_id, tax_code="STANDARD",
        product_scope="GENERAL", rate_kind=RateKind.STANDARD, rate_percent=Decimal(rate), valid_from=valid_from,
        valid_to=valid_to, observed_at=NOW, approved_at=NOW, published_at=NOW - timedelta(days=1), activated_at=NOW,
        is_cumulative=False, source_revision_id=source.id, evidence_status="CAPTURED", owner="fixture",
        staged_rate_id=staged.id, change_approval_id=change.id,
    )
    db.add(version)
    db.flush()
    return version


def _market(w, country, tz, tax_type, authority_code, component_code, ref, rate, valid_from):
    db = w["db"]
    jurisdiction = TaxJurisdiction(code=country, name=country, level="country", country_code=country, timezone=tz)
    db.add(jurisdiction)
    db.flush()
    tt = db.query(TaxTypeDefinition).filter(TaxTypeDefinition.code == tax_type).first()
    if tt is None:
        tt = TaxTypeDefinition(code=tax_type, name=tax_type)
        db.add(tt)
        db.flush()
    authority = TaxAuthority(code=authority_code, name=authority_code, jurisdiction_id=jurisdiction.id)
    db.add(authority)
    db.flush()
    component = TaxComponent(code=component_code, name=f"{component_code} (fixture)", jurisdiction_id=jurisdiction.id,
                             tax_type_id=tt.id, authority_id=authority.id)
    db.add(component)
    db.flush()
    source = _source(w, authority, ref)
    rate_version = published_rate(db, component, source, rate, valid_from)
    svc = MarketAvailabilityService(db)
    for cls in SERVICES:
        row = svc.draft(actor_id=w["reviewer"].id, jurisdiction_id=jurisdiction.id, tax_type_id=tt.id,
                        transaction_class=cls, mode=NATIVE, gates=GATES)
        svc.validate(actor_id=w["reviewer"].id, version_id=row.id)
        svc.submit(actor_id=w["reviewer"].id, version_id=row.id, reason="fixture")
        svc.approve(actor_id=w["publisher"].id, version_id=row.id)
        svc.publish(actor_id=w["publisher"].id, version_id=row.id)
    return {"jurisdiction": jurisdiction, "tax_type": tt, "component": component, "source": source,
            "rate": rate_version}


def _activate(w, entity, market, registration_valid_to=None):
    tenant = TenantTaxService(w["db"])
    reg = tenant.create_registration(w["org"].id, w["maker"].id, seller_entity_id=entity.id,
                                     jurisdiction_id=market["jurisdiction"].id, tax_type_id=market["tax_type"].id,
                                     registration_number=f"{market['jurisdiction'].code}-REG",
                                     valid_from=date(2020, 1, 1), valid_to=registration_valid_to)
    for cls in SERVICES:
        act = tenant.propose_activation(w["org"].id, w["maker"].id, seller_entity_id=entity.id,
                                        jurisdiction_id=market["jurisdiction"].id, tax_type_id=market["tax_type"].id,
                                        transaction_class=cls, mode=NATIVE, effective_from=date(2025, 1, 1),
                                        registration_id=reg.id)
        tenant.decide_activation(w["org"].id, w["checker"].id, act.id, approve=True)
    return reg


def build_world(db, org_code="P3B"):
    org = make_organization(db, code=org_code, name="Phase 3b Org")
    w = {
        "db": db, "org": org,
        "maker": _user(db, f"maker@{org_code.lower()}.example", UserRole.BILLING_ADMIN, org.id),
        "checker": _user(db, f"checker@{org_code.lower()}.example", UserRole.FINANCE_APPROVER, org.id),
        "admin": _user(db, f"admin@{org_code.lower()}.example", UserRole.ORG_ADMIN, org.id),
        "reviewer": _user(db, f"rev@{org_code.lower()}.example", UserRole.SUPER_ADMIN,
                          platform_role=PlatformRole.TAX_REVIEWER),
        "publisher": _user(db, f"pub@{org_code.lower()}.example", UserRole.SUPER_ADMIN,
                           platform_role=PlatformRole.TAX_PUBLISHER),
    }
    w["uk"] = LegalEntityService(db).ensure_default_entity(org.id)
    w["uk"].country_code = "GB"
    w["au"] = LegalEntityService(db).create_entity(org.id, w["maker"].id, entity_code="AU1",
                                                   legal_name="Fixture AU Pty Ltd", country_code="AU")
    w["gb"] = _market(w, "GB", "Europe/London", "VAT", "GB-HMRC", "GB-VAT", "S11", "20", date(2011, 1, 4))
    w["aus"] = _market(w, "AU", "Australia/Sydney", "GST", "AU-ATO", "AU-GST", "S16", "10", date(2000, 7, 1))

    codes = TaxCodeSetService(db)
    cs = codes.draft(actor_id=w["reviewer"].id)
    for code, category, scope in (("SVC", SupplyCategory.SERVICES, "GENERAL"),
                                  ("ZRS", SupplyCategory.SERVICES, "ZERO_RATED"),
                                  ("DIG", SupplyCategory.DIGITAL, "GENERAL")):
        codes.upsert_code(actor_id=w["reviewer"].id, version_id=cs.id, code=code, name=code, supply_category=category,
                          registry_product_scope=scope)
    codes.validate(actor_id=w["reviewer"].id, version_id=cs.id)
    codes.submit(actor_id=w["reviewer"].id, version_id=cs.id, reason="fixture")
    codes.approve(actor_id=w["publisher"].id, version_id=cs.id)
    codes.publish(actor_id=w["publisher"].id, version_id=cs.id)
    db.commit()

    w["uk_reg"] = _activate(w, w["uk"], w["gb"])
    w["au_reg"] = _activate(w, w["au"], w["aus"])
    w["svc"] = product(w, "SVC1", "SVC")
    w["zrs"] = product(w, "ZRS1", "ZRS")
    w["dig"] = product(w, "DIG1", "DIG")
    w["gb_consumer"] = customer(w, "GB", "GBC")
    w["gb_business"] = customer(w, "GB", "GBB", verified=True)
    w["au_buyer"] = customer(w, "AU", "AUB")
    db.commit()
    return w


def product(w, code, tax_code):
    from app.modules.billing.models import Product

    db = w["db"]
    p = Product(organization_id=w["org"].id, name=f"Product {code}", code=code, default_price=Decimal("100"))
    db.add(p)
    db.flush()
    tc = next(c for c in active_code_set(db).codes if c.code == tax_code)
    cls = ClassificationService(db)
    row = cls.propose(w["org"].id, w["maker"].id, product_id=p.id, tax_code_id=tc.id)
    cls.decide(w["org"].id, w["checker"].id, row.id, approve=True)
    return p


def customer(w, country, code, verified=False):
    db = w["db"]
    c = make_customer(db, w["org"].id, code=code, email=f"{code.lower()}@buyer.example")
    ev = BuyerEvidenceService(db)
    ev.record_address(w["org"].id, w["maker"].id, c.id, role=AddressRole.BILLING, country_code=country)
    if verified:
        tid = ev.add_tax_id(w["org"].id, w["maker"].id, c.id, value=f"{country}123456789")
        ev.record_verification(w["org"].id, w["maker"].id, tid.id, status=VerificationStatus.VERIFIED,
                               method="fixture", response={"valid": True})
    return c


def draft(w, lines, *, entity=None, buyer=None, currency="GBP", tax_date=TAX_DATE):
    """lines: [(product, unit_price, qty)]"""
    db = w["db"]
    inv = make_invoice(db, w["org"].id, (buyer or w["gb_consumer"]).id, status=InvoiceStatus.DRAFT,
                       currency=currency, invoice_number=f"P3B-{db.query(Invoice).count() + 1}")
    inv.seller_entity_id = (entity or w["uk"]).id
    inv.tax_date = tax_date
    for n, (prod, price, qty) in enumerate(lines, start=1):
        item = make_invoice_item(db, w["org"].id, inv.id, line_number=n, unit_price=str(price), total=str(price),
                                 tax_percentage="5")          # client-sent tax: ignored when governed
        item.product_id = prod.id
        item.quantity = Decimal(str(qty))
    db.commit()
    return inv


def publish_pack(w, code, golden=GOLDEN):
    svc = RulePackService(w["db"])
    row = svc.register(actor_id=w["reviewer"].id, code=code)
    svc.amend(actor_id=w["reviewer"].id, version_id=row.id, changes={"golden_test_report": golden})
    svc.validate(actor_id=w["reviewer"].id, version_id=row.id)
    assert row.validation_errors is None, row.validation_errors
    svc.submit(actor_id=w["reviewer"].id, version_id=row.id, reason="pilot")
    svc.approve(actor_id=w["publisher"].id, version_id=row.id)
    svc.publish(actor_id=w["publisher"].id, version_id=row.id)
    w["db"].commit()
    return row


def govern(w, entity):
    """Phase 4a-2: an org admin proposes, a different finance approver decides."""
    svc = TenantTaxService(w["db"])
    change = svc.request_regime(w["org"].id, w["admin"].id, entity.id, EntityTaxRegime.GOVERNED)
    svc.decide_regime_change(w["org"].id, w["checker"].id, change.id, approve=True)
    return svc.regime_eligibility(w["org"].id, entity.id)


def quote(w, inv):
    return TaxDeterminationService(w["db"]).create_quote(w["org"].id, w["maker"].id, "invoice", inv.id)


def issue(w, inv):
    return InvoiceService(w["db"]).finalize_invoice(inv.id, w["org"].id, w["maker"].id)


@pytest.fixture()
def w(db_session):
    return build_world(db_session)


@pytest.fixture()
def uk(w):
    publish_pack(w, UkVatDomesticServices.code)
    govern(w, w["uk"])
    return w


@pytest.fixture()
def au(w):
    publish_pack(w, AuGstDomesticServices.code)
    govern(w, w["au"])
    return w


# ── §14 scope: native packs are UK and Australia only ───────────────────

def test_native_packs_are_uk_and_australia_only():
    packs = registered_rule_packs()
    assert set(packs) == {UkVatDomesticServices.code, AuGstDomesticServices.code}
    markets = {(m["jurisdiction_code"], m["tax_type"]) for p in packs.values() for m in p.markets()}
    assert markets == {("GB", "VAT"), ("AU", "GST")}
    assert not any(code.startswith(("US", "CA")) for code, _ in markets)          # provider markets (Phase 4)


@pytest.mark.parametrize("pack", [UkVatDomesticServices, AuGstDomesticServices])
def test_packs_declare_required_facts_rounding_and_coverage(pack):
    d = pack.declaration()
    assert d["required_facts"] and d["rounding_rule"] in RoundingRule.__members__
    assert d["rounding_mode"] in RoundingMode.__members__
    cov = d["coverage"]
    assert cov["seller_country"] == cov["buyer_country"] == pack.country and cov["currencies"] == [pack.currency]
    assert cov["supply_categories"] == ["SERVICES"] and cov["outside_coverage"] == "NOT_DETERMINED"
    assert d["source_refs"] and all(re.fullmatch(r"S\d+", r) for r in d["source_refs"])


def test_packs_hold_no_rates():
    src = "".join(f.read_text(encoding="utf-8") for f in sorted(pathlib.Path("app/modules/tax/rule_packs").glob("*.py")))
    assert not re.search(r"Decimal\(\s*[\"']\d", src) and "rate_percent=Decimal(rate" in src


# ── Rule-pack approval: two people, drafts never used ───────────────────

def test_rule_pack_review_is_two_person_and_audited(w):
    db, svc = w["db"], RulePackService(w["db"])
    row = svc.register(actor_id=w["reviewer"].id, code=UkVatDomesticServices.code)
    assert row.status.name == "PENDING_REVIEW" and row.rounding_mode == "HALF_UP"
    assert row.source_dependencies == [{"handoff_ref": "S11", "source_id": w["gb"]["source"].id,
                                        "title": "Fixture source S11", "approved": True, "reason": None}]
    with pytest.raises(RegistryStateError, match="already registered"):
        svc.register(actor_id=w["reviewer"].id, code=UkVatDomesticServices.code)

    svc.validate(actor_id=w["reviewer"].id, version_id=row.id)
    assert any("golden-test report" in e for e in row.validation_errors)
    svc.amend(actor_id=w["reviewer"].id, version_id=row.id, changes={"golden_test_report": {**GOLDEN, "failed": 1}})
    svc.validate(actor_id=w["reviewer"].id, version_id=row.id)
    assert any("no failures" in e for e in row.validation_errors)
    svc.amend(actor_id=w["reviewer"].id, version_id=row.id, changes={"golden_test_report": GOLDEN})
    svc.validate(actor_id=w["reviewer"].id, version_id=row.id)
    assert row.validation_errors is None
    svc.submit(actor_id=w["reviewer"].id, version_id=row.id, reason="pilot")

    with pytest.raises(MakerCheckerError):
        svc.approve(actor_id=w["reviewer"].id, version_id=row.id)                # the author can't approve
    svc.approve(actor_id=w["publisher"].id, version_id=row.id)
    with pytest.raises(MakerCheckerError):
        svc.publish(actor_id=w["reviewer"].id, version_id=row.id)
    svc.publish(actor_id=w["publisher"].id, version_id=row.id)
    assert row.status.name == "ACTIVE" and row.checker_user_id == w["publisher"].id
    trail = db.query(PlatformAuditLog).filter(PlatformAuditLog.entity_type == "TaxRulePackVersion",
                                              PlatformAuditLog.entity_id == row.id).count()
    assert trail >= 7                                    # register, 3 amends/validations..., submit, approve, publish


def test_unapproved_source_blocks_the_pack(w):
    db = w["db"]
    authority = db.query(TaxAuthority).filter(TaxAuthority.code == "GB-HMRC").one()
    _source(w, authority, "S11", approved=False)            # a newer, unreviewed revision of S11
    svc = RulePackService(db)
    row = svc.register(actor_id=w["reviewer"].id, code=UkVatDomesticServices.code)
    assert row.source_dependencies[0]["approved"] is False
    svc.amend(actor_id=w["reviewer"].id, version_id=row.id, changes={"golden_test_report": GOLDEN})
    svc.validate(actor_id=w["reviewer"].id, version_id=row.id)
    assert any("Source S11 is not approved" in e for e in row.validation_errors)
    with pytest.raises(RegistryStateError):
        svc.submit(actor_id=w["reviewer"].id, version_id=row.id, reason="pilot")


def test_draft_pack_is_never_used_and_never_backs_governed(w):
    svc = RulePackService(w["db"])
    row = svc.register(actor_id=w["reviewer"].id, code=UkVatDomesticServices.code)
    svc.amend(actor_id=w["reviewer"].id, version_id=row.id, changes={"golden_test_report": GOLDEN})
    svc.validate(actor_id=w["reviewer"].id, version_id=row.id)
    svc.submit(actor_id=w["reviewer"].id, version_id=row.id, reason="pilot")
    svc.approve(actor_id=w["publisher"].id, version_id=row.id)                  # approved, not yet published
    w["db"].commit()
    act = next(a for a in TenantTaxService(w["db"]).list_activations(w["org"].id) if a.seller_entity_id == w["uk"].id)
    engine, reason = EngineResolver(w["db"]).engine_for(act)
    assert engine is None and "No approved native rule pack" in reason
    with pytest.raises(BadRequestException, match="does not qualify"):
        govern(w, w["uk"])
    assert w["uk"].tax_regime == EntityTaxRegime.LEGACY_MANUAL


# ── T12: GOVERNED only via POST /regime with a backed activation ────────

def test_t12_no_governed_via_toggle_currency_or_plan(w):
    db, org, entity = w["db"], w["org"], w["uk"]
    with pytest.raises(BadRequestException, match="cannot be enabled from settings"):
        LegalEntityService(db).update_entity(entity.id, org.id, w["admin"].id, tax_regime=EntityTaxRegime.GOVERNED)
    org.currency = "GBP"
    w["gb_consumer"].currency = "GBP"
    from app.modules.organizations.models import BillingClassification

    org.billing_classification = next(c for c in BillingClassification if c != org.billing_classification)  # "plan"
    db.commit()
    db.refresh(entity)
    assert entity.tax_regime == EntityTaxRegime.LEGACY_MANUAL
    # No code path but request_regime writes the regime.
    app_dir = pathlib.Path("app")
    writers = sorted(str(p.relative_to(app_dir)) for p in app_dir.rglob("*.py")
                     if re.search(r"\.tax_regime\s*=\s*(?!=)", p.read_text(encoding="utf-8")))
    assert writers == [str(pathlib.Path("modules/tax/tenant_tax_service.py"))]
    with pytest.raises(BadRequestException, match="does not qualify"):
        govern(w, entity)


def test_t12_governed_accepted_once_a_published_pack_backs_an_activation(w):
    db, entity = w["db"], w["uk"]
    version = entity.version
    publish_pack(w, UkVatDomesticServices.code)
    report = govern(w, entity)
    assert report["current_regime"] == "GOVERNED" and report["backing_activations"]
    assert entity.tax_regime == EntityTaxRegime.GOVERNED and entity.version == version + 1
    log = db.query(BillingAuditLog).filter(BillingAuditLog.entity_type == "SellerLegalEntity",
                                           BillingAuditLog.entity_id == entity.id).order_by(BillingAuditLog.id.desc()).first()
    assert log.new_values["tax_regime"] == "GOVERNED" and log.actor_id == w["checker"].id    # the approver applies it
    # The AU entity is unaffected: its pack is still unpublished.
    with pytest.raises(BadRequestException, match="does not qualify"):
        govern(w, w["au"])


# ── T05: UK standard-rated service ──────────────────────────────────────

def test_t05_uk_standard_rate_preserves_rate_and_source_version(uk):
    w, db = uk, uk["db"]
    inv = draft(w, [(w["svc"], 100, 1)])
    q = quote(w, inv)
    assert q.status == TaxQuoteStatus.QUOTED, (q.refusal_code, q.refusal_reason)
    assert (q.engine_kind, q.engine_name, q.engine_version) == (EngineKind.NATIVE_RULE_PACK, UkVatDomesticServices.code, "1")
    assert (q.subtotal, q.tax_amount, q.total_amount) == (Decimal("100.00"), Decimal("20.00"), Decimal("120.00"))
    comp = q.lines[0].components[0]
    assert comp.rate_percent == Decimal("20") and comp.rate_version_id == w["gb"]["rate"].id
    assert db.get(TaxRateVersion, comp.rate_version_id).source_revision.handoff_ref == "S11"
    issue(w, inv)
    db.refresh(inv)
    assert inv.status == InvoiceStatus.SENT and inv.tax_quote_id == q.id
    assert (inv.subtotal, inv.tax_amount, inv.total_amount) == (Decimal("100.00"), Decimal("20.00"), Decimal("120.00"))

    # A later rate revision never rewrites the issued invoice; new quotes use the new version.
    old = w["gb"]["rate"]
    old.status = "SUPERSEDED"
    old.superseded_at = NOW
    db.flush()
    newer = published_rate(db, w["gb"]["component"], w["gb"]["source"], "22", date(2011, 1, 4))
    db.commit()
    db.refresh(q)
    db.refresh(inv)
    assert q.tax_amount == inv.tax_amount == Decimal("20.00") and q.lines[0].components[0].rate_version_id == old.id
    later = quote(w, draft(w, [(w["svc"], 100, 1)]))
    assert later.tax_amount == Decimal("22.00") and later.lines[0].components[0].rate_version_id == newer.id


def test_t05_business_and_consumer_buyers_are_both_standard_rated(uk):
    for buyer in (uk["gb_business"], uk["gb_consumer"]):
        q = quote(uk, draft(uk, [(uk["svc"], 100, 1)], buyer=buyer))
        assert q.status == TaxQuoteStatus.QUOTED and q.tax_amount == Decimal("20.00")


@pytest.mark.parametrize("case", ["currency", "zero_rated_code", "digital", "foreign_buyer", "before_rate"])
def test_uk_outside_coverage_is_not_determined(uk, case):
    w = uk
    kwargs = {"currency": dict(currency="EUR"), "foreign_buyer": dict(buyer=w["au_buyer"]),
              "before_rate": dict(tax_date=date(2010, 1, 1))}.get(case, {})
    prod = {"zero_rated_code": w["zrs"], "digital": w["dig"]}.get(case, w["svc"])
    inv = draft(w, [(prod, 100, 1)], **kwargs)
    q = quote(w, inv)
    assert q.status in (TaxQuoteStatus.NEEDS_EVIDENCE, TaxQuoteStatus.UNSUPPORTED) and q.tax_amount is None
    if case in ("currency", "zero_rated_code"):
        assert q.refusal_code == "OUTSIDE_PACK_COVERAGE"
    with pytest.raises(TaxIssuanceBlocked):
        issue(w, inv)


# ── Australia: 10% GST, per-document rounding ───────────────────────────

def test_au_gst_ten_percent_rounded_per_document(au):
    w = au
    inv = draft(w, [(w["svc"], "33.33", 1)] * 3, entity=w["au"], buyer=w["au_buyer"], currency="AUD")
    q = quote(w, inv)
    assert q.status == TaxQuoteStatus.QUOTED, (q.refusal_code, q.refusal_reason)
    assert q.engine_name == AuGstDomesticServices.code and q.rounding_rule == RoundingRule.PER_DOCUMENT
    # 3 x 3.333 = 9.999 -> 10.00 once for the document (per line it would be 9.99).
    assert q.tax_amount == Decimal("10.00") and sum(l.tax_amount for l in q.lines) == Decimal("10.00")
    assert q.lines[0].components[0].rate_percent == Decimal("10")


def test_au_outside_coverage_is_not_determined(au):
    w = au
    q = quote(w, draft(w, [(w["svc"], 100, 1)], entity=w["au"], buyer=w["au_buyer"], currency="GBP"))
    assert q.status == TaxQuoteStatus.NEEDS_EVIDENCE and q.refusal_code == "OUTSIDE_PACK_COVERAGE"


# ── T14: expiry triggers review and blocks issue ────────────────────────

def test_t14_expired_registration_blocks_issue_and_raises_an_exception(uk):
    w, db = uk, uk["db"]
    inv = draft(w, [(w["svc"], 100, 1)])
    assert quote(w, inv).status == TaxQuoteStatus.QUOTED
    TenantTaxService(db).update_registration(w["org"].id, w["admin"].id, w["uk_reg"].id, valid_to=date(2026, 5, 1))
    db.commit()

    summary = TaxExceptionService(db).invoice_tax_summary(w["org"].id, inv.id)
    assert summary["freshness"]["status"] == "STALE" and summary["can_issue"] is False
    exc = TaxExceptionService(db).list_exceptions(w["org"].id)["items"]
    assert [e["invoice_id"] for e in exc] == [inv.id] and exc[0]["code"] == "QUOTE_STALE"
    with pytest.raises(TaxIssuanceBlocked, match="Tax facts changed"):
        issue(w, inv)

    requote = quote(w, inv)                              # the Exceptions "re-quote" action
    assert requote.status == TaxQuoteStatus.NEEDS_EVIDENCE and requote.tax_amount is None
    exc = TaxExceptionService(db).list_exceptions(w["org"].id)["items"]
    assert requote.refusal_code == "NOT_DETERMINED" and "no activation" in requote.refusal_reason
    assert exc[0]["freshness"] == "REFUSED" and exc[0]["owner"] == "org_admin"
    assert any("registration" in (m["message"] or "") for m in exc[0]["missing"])
    with pytest.raises(TaxIssuanceBlocked):
        issue(w, inv)
    db.refresh(inv)
    assert inv.status == InvoiceStatus.DRAFT


def test_t14_expired_quote_blocks_and_is_listed(uk):
    w, db = uk, uk["db"]
    inv = draft(w, [(w["svc"], 100, 1)])
    quote(w, inv)
    later = TaxExceptionService(db, now=lambda: NOW + timedelta(days=3))
    assert later.invoice_tax_summary(w["org"].id, inv.id)["freshness"]["status"] == "EXPIRED"
    assert later.list_exceptions(w["org"].id)["items"][0]["code"] == "QUOTE_EXPIRED"


# ── §11 read models ─────────────────────────────────────────────────────

def test_invoice_tax_summary_shows_components_sources_and_blocking(uk):
    w, db = uk, uk["db"]
    inv = draft(w, [(w["svc"], 100, 1)])
    svc = TaxExceptionService(db)
    none = svc.invoice_tax_summary(w["org"].id, inv.id)
    assert none["freshness"]["status"] == "NONE" and none["blocking_reasons"][0]["code"] == "NO_TAX_QUOTE"
    assert none["can_issue"] is False and none["lines"] == []

    quote(w, inv)
    fresh = svc.invoice_tax_summary(w["org"].id, inv.id)
    assert fresh["freshness"]["status"] == "FRESH" and fresh["can_issue"] is True and fresh["blocking_reasons"] == []
    assert fresh["engine_label"] == f"Zoiko rule pack {UkVatDomesticServices.code} v1"
    assert fresh["totals"]["tax_amount"] == Decimal("20.00") and fresh["tax_date"] == TAX_DATE
    line = fresh["lines"][0]
    assert line["outcome"] == "STANDARD" and line["legal_reason"]
    assert line["components"][0]["source"]["source_ref"] == "S11"

    inv.items[0].unit_price = Decimal("90")
    db.commit()
    stale = svc.invoice_tax_summary(w["org"].id, inv.id)
    assert stale["freshness"]["status"] == "STALE" and stale["can_issue"] is False
    assert stale["blocking_reasons"][0]["owner"] == "billing_admin"


def test_refused_quote_lists_missing_facts_with_owners(uk):
    w, db = uk, uk["db"]
    nobody = make_customer(db, w["org"].id, code="NOADDR", email="noaddr@buyer.example")
    inv = draft(w, [(w["svc"], 100, 1)], buyer=nobody)
    q = quote(w, inv)
    assert q.status == TaxQuoteStatus.NEEDS_EVIDENCE
    item = TaxExceptionService(db).list_exceptions(w["org"].id)["items"][0]
    assert item["freshness"] == "REFUSED" and item["requote"]["path"] == "/api/v1/tax/quotes"
    assert any(m["code"] == "BUYER_COUNTRY_MISSING" and m["owner"] == "billing_admin" for m in item["missing"])


def test_legacy_invoices_are_not_governed_in_the_summary(w):
    inv = draft(w, [(w["svc"], 100, 1)])
    assert TaxExceptionService(w["db"]).invoice_tax_summary(w["org"].id, inv.id)["governed"] is False
    assert TaxExceptionService(w["db"]).list_exceptions(w["org"].id)["items"] == []


def test_read_models_are_tenant_scoped(uk):
    w, db = uk, uk["db"]
    inv = draft(w, [(w["svc"], 100, 1)])
    other = make_organization(db, code="P3B-OTHER", name="Other")
    with pytest.raises(NotFoundException):
        TaxExceptionService(db).invoice_tax_summary(other.id, inv.id)
    assert TaxExceptionService(db).list_exceptions(other.id)["items"] == []
