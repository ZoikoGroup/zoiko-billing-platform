"""tests/test_tax_phase3a_governed.py
-----------------------------------
ZB-TAX-ARCH-001 Phase 3a: governed determination, quotes/snapshots, issuance
gating on every DRAFT -> SENT path, governed credit notes, Phase 0 fixes (a)-(d),
plan changes A-E. SQLite, service level; Postgres-only guarantees are in
test_tax_phase3a_pg.py.

QA references: T01 (missing rate/address -> NOT_DETERMINED, issue fails),
T03 (local legal date at effective boundaries), T08 (unverified tax ID never
0%), T09 (inclusive/exclusive, discount allocation, rounding, credit balances
to the cent), T10 (provider timeout after remote success: no duplicate commit),
T15 (credit references the original calculation), T17 (DST / leap day),
T18 (negative amounts keep direction), T19 (classification change -> stale).

Rates come from a TEST-ONLY rule pack fixture (tests/fixtures), never a real
market pack. GOVERNED stays refused by the API in 3a; tests set the regime on
the entity directly.
"""
import inspect
import pathlib
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace

import pytest

from app.core.exceptions import BadRequestException, NotFoundException
from app.modules.auth.models import PlatformRole, User, UserRole
from app.modules.billing.models import (
    ContractItem,
    CreditNoteType,
    Invoice,
    InvoiceStatus,
    Product,
    QuoteStatus,
    Tax,
)
from app.modules.billing.services.invoice_service import InvoiceService
from app.modules.super_admin.models import ApprovalRequest
from app.modules.tax.buyer_evidence_service import BuyerEvidenceService
from app.modules.tax.classification_service import ClassificationService
from app.modules.tax.determination_service import QuoteConflictError, TaxDeterminationService
from app.modules.tax.engines import RULE_PACKS, EngineResolver
from app.modules.tax.enums import (
    AddressRole,
    EntityTaxRegime,
    MarketGate,
    RateKind,
    RemoteCommitState,
    RoundingMode,
    RoundingRule,
    StagingOrigin,
    SupplyCategory,
    TaxOperatingMode,
    TaxOutcome,
    TaxQuoteStatus,
    TenantApprovalStatus,
    TransactionClass,
    VerificationStatus,
)
from app.modules.tax.determination_service import view_quote
from app.modules.tax.governed_credit_service import GovernedCreditService
from app.modules.tax.issuance_gate import GovernedIssuanceGate, RemoteCommitter, TaxIssuanceBlocked
from app.modules.tax.legal_entity_service import LegalEntityService
from app.modules.tax.models import TaxRecordFrozenError
from app.modules.tax.policy_models import TaxRulePackVersion
from app.modules.tax.policy_service import MarketAvailabilityService, TaxCodeSetService, active_code_set
from app.modules.tax.quote_models import CreditNoteTaxLine, TaxQuote
from app.modules.tax.registry_models import (
    TaxAuthority,
    TaxChangeApproval,
    TaxComponent,
    TaxJurisdiction,
    TaxRateStaging,
    TaxRateVersion,
    TaxTypeDefinition,
)
from app.modules.tax.registry_service import legal_date_at
from app.modules.tax.report_service import TaxFindingsReportService
from app.modules.tax.tenant_tax_service import TenantTaxService
from tests.conftest import (
    make_contract,
    make_customer,
    make_invoice,
    make_invoice_item,
    make_organization,
    make_quotation,
    make_quotation_item,
    make_subscription,
    make_subscription_plan,
)
from tests.fixtures.tax_fake_provider import FakeTaxProvider
from tests.fixtures.tax_test_rulepack import TEST_PACK_CODE, TestOnlyRulePack

GATES = {g.name: {"status": "PASSED", "evidence_ref": f"EV-{g.name}"} for g in MarketGate}
TAX_DATE = date(2026, 6, 1)
NOW = datetime.now(timezone.utc)


# ── world ───────────────────────────────────────────────────────────────

def _user(db, email, role, org_id=None, platform_role=None):
    u = User(email=email, hashed_password="x", role=role, organization_id=org_id, platform_role=platform_role,
             first_name="T", last_name=email.split("@")[0], is_active=True, is_verified=True)
    db.add(u)
    db.flush()
    return u


def registry_rate(db, component, rate, valid_from, valid_to=None, scope="GENERAL"):
    """A published reference rate (bypasses the Phase 1 pipeline, which has its own tests)."""
    from app.modules.tax.registry_service import TaxRegistryPipeline
    from app.modules.tax.enums import AcquisitionMethod, SourceTier

    source = TaxRegistryPipeline(db).register_source_revision(
        actor_id=None, authority_id=component.authority_id, source_tier=SourceTier.OFFICIAL_GUIDANCE,
        acquisition_method=AcquisitionMethod.MANUAL_VERIFIED_EXTRACTION, permanent_url="https://example.test/rate",
        title="Fixture source", citation="Fixture", language="en")
    staged = TaxRateStaging(origin=StagingOrigin.MANUAL, component_id=component.id, tax_code="STANDARD",
                            product_scope=scope, rate_kind=RateKind.STANDARD, observed_at=NOW, created_at=NOW)
    request = ApprovalRequest(request_type="tax_rate_publish", requested_at=datetime.utcnow())
    db.add_all([staged, request])
    db.flush()
    change = TaxChangeApproval(approval_request_id=request.id, staged_rate_id=staged.id, change_kind="NEW",
                               detector=StagingOrigin.MANUAL, submitted_at=NOW)
    db.add(change)
    db.flush()
    version = TaxRateVersion(
        component_id=component.id, jurisdiction_id=component.jurisdiction_id, tax_code="STANDARD",
        product_scope=scope, rate_kind=RateKind.STANDARD, rate_percent=Decimal(rate), valid_from=valid_from,
        valid_to=valid_to, observed_at=NOW, approved_at=NOW, published_at=NOW - timedelta(days=1),
        activated_at=NOW, is_cumulative=False, source_revision_id=source.id, evidence_status="CAPTURED",
        owner="fixture", staged_rate_id=staged.id, change_approval_id=change.id,
    )
    db.add(version)
    db.flush()
    return version


def _availability(w, cls, mode, permitted=False, gates=GATES):
    svc = MarketAvailabilityService(w["db"])
    row = svc.draft(actor_id=w["reviewer"].id, jurisdiction_id=w["gb"].id, tax_type_id=w["vat"].id,
                    transaction_class=cls, mode=mode, tenant_config_permitted=permitted, gates=gates)
    svc.validate(actor_id=w["reviewer"].id, version_id=row.id)
    assert row.validation_errors is None, row.validation_errors
    svc.submit(actor_id=w["reviewer"].id, version_id=row.id, reason="fixture")
    svc.approve(actor_id=w["publisher"].id, version_id=row.id)
    svc.publish(actor_id=w["publisher"].id, version_id=row.id)
    return row


@pytest.fixture()
def w(db_session):
    return build_world(db_session)


def build_world(db, org_code="P3A"):
    """A governed seller entity with every fact in place. Also used by
    test_tax_phase3a_pg.py against Postgres."""
    org = make_organization(db, code=org_code, name="Phase 3a Org")
    entity = LegalEntityService(db).ensure_default_entity(org.id)
    entity.country_code = "GB"
    entity.tax_regime = EntityTaxRegime.GOVERNED          # API still refuses this in 3a
    gb = TaxJurisdiction(code="GB", name="United Kingdom", level="country", country_code="GB", timezone="Europe/London")
    vat = TaxTypeDefinition(code="VAT", name="VAT")
    db.add_all([gb, vat])
    db.flush()
    authority = TaxAuthority(code="GB-AUTH", name="Fixture authority", jurisdiction_id=gb.id)
    db.add(authority)
    db.flush()
    component = TaxComponent(code="GB-VAT", name="Fixture VAT", jurisdiction_id=gb.id, tax_type_id=vat.id,
                             authority_id=authority.id)
    db.add(component)
    db.flush()
    world = {
        "db": db, "org": org, "entity": entity, "gb": gb, "vat": vat, "component": component,
        "maker": _user(db, "maker@p3a.example", UserRole.BILLING_ADMIN, org.id),
        "checker": _user(db, "checker@p3a.example", UserRole.FINANCE_APPROVER, org.id),
        "reviewer": _user(db, "rev@p3a.example", UserRole.SUPER_ADMIN, platform_role=PlatformRole.TAX_REVIEWER),
        "publisher": _user(db, "pub@p3a.example", UserRole.SUPER_ADMIN, platform_role=PlatformRole.TAX_PUBLISHER),
    }
    world["rate"] = registry_rate(db, component, "20", date(2011, 1, 4))

    codes = TaxCodeSetService(db)
    cs = codes.draft(actor_id=world["reviewer"].id)
    codes.upsert_code(actor_id=world["reviewer"].id, version_id=cs.id, code="SVC", name="Services",
                      supply_category=SupplyCategory.SERVICES)
    codes.upsert_code(actor_id=world["reviewer"].id, version_id=cs.id, code="DIG", name="Digital",
                      supply_category=SupplyCategory.DIGITAL)
    codes.validate(actor_id=world["reviewer"].id, version_id=cs.id)
    codes.submit(actor_id=world["reviewer"].id, version_id=cs.id, reason="fixture")
    codes.approve(actor_id=world["publisher"].id, version_id=cs.id)
    codes.publish(actor_id=world["publisher"].id, version_id=cs.id)

    native = TaxOperatingMode.NATIVE_RULEPACK_APPROVED
    _availability(world, TransactionClass.B2B_SERVICES, native)
    _availability(world, TransactionClass.B2C_SERVICES, native)
    _availability(world, TransactionClass.B2B_DIGITAL, TaxOperatingMode.PROVIDER_APPROVED)
    _availability(world, TransactionClass.B2C_DIGITAL, TaxOperatingMode.REFERENCE_ONLY, permitted=True,
                  gates={MarketGate.LEGAL_AUTHORITY_AND_USAGE_RIGHTS.name: {"status": "PASSED", "evidence_ref": "EV"}})
    db.commit()

    tenant = TenantTaxService(db)
    reg = tenant.create_registration(org.id, world["maker"].id, seller_entity_id=entity.id, jurisdiction_id=gb.id,
                                     tax_type_id=vat.id, registration_number="GB-FIXTURE", valid_from=date(2020, 1, 1))
    for cls, mode, extra in (
        (TransactionClass.B2B_SERVICES, native, {}),
        (TransactionClass.B2C_SERVICES, native, {}),
        (TransactionClass.B2B_DIGITAL, TaxOperatingMode.PROVIDER_APPROVED, {}),
        (TransactionClass.B2C_DIGITAL, TaxOperatingMode.TENANT_CONFIG_APPROVED,
         dict(tenant_rate_percent=Decimal("20"), tenant_source_citation="Tenant's own citation",
              tenant_source_url="https://example.test/law")),
    ):
        act = tenant.propose_activation(org.id, world["maker"].id, seller_entity_id=entity.id, jurisdiction_id=gb.id,
                                        tax_type_id=vat.id, transaction_class=cls, mode=mode,
                                        effective_from=date(2025, 1, 1), registration_id=reg.id, **extra)
        tenant.decide_activation(org.id, world["checker"].id, act.id, approve=True)

    world["svc_product"] = product(world, "SVC1", "SVC")
    world["dig_product"] = product(world, "DIG1", "DIG")
    world["customer"] = buyer(world, verified=True)
    world["provider"] = FakeTaxProvider()
    db.commit()
    return world


def product(w, code, tax_code):
    db = w["db"]
    p = Product(organization_id=w["org"].id, name=f"Product {code}", code=code, default_price=Decimal("100"))
    db.add(p)
    db.flush()
    tc = next(c for c in active_code_set(db).codes if c.code == tax_code)
    cls = ClassificationService(db)
    row = cls.propose(w["org"].id, w["maker"].id, product_id=p.id, tax_code_id=tc.id)
    cls.decide(w["org"].id, w["checker"].id, row.id, approve=True)
    return p


def buyer(w, verified=True, subdivision="ENG", code=None):
    db = w["db"]
    customer = make_customer(db, w["org"].id, code=code or f"C{verified}{subdivision}",
                             email=f"{code or verified}-{subdivision}@buyer.example")
    ev = BuyerEvidenceService(db)
    ev.record_address(w["org"].id, w["maker"].id, customer.id, role=AddressRole.BILLING, country_code="GB",
                      subdivision_code=subdivision)
    tid = ev.add_tax_id(w["org"].id, w["maker"].id, customer.id, value="GB123456789")
    if verified:
        ev.record_verification(w["org"].id, w["maker"].id, tid.id, status=VerificationStatus.VERIFIED,
                               method="fixture", response={"valid": True})
    return customer


def draft(w, lines, customer=None, discount_pct="0", currency="GBP", tax_date=TAX_DATE, number=None):
    """lines: [(product, unit_price, qty, inclusive)]"""
    db = w["db"]
    inv = make_invoice(db, w["org"].id, (customer or w["customer"]).id, status=InvoiceStatus.DRAFT,
                       currency=currency, invoice_number=number or f"INV-{len(db.query(Invoice).all()) + 1}")
    inv.seller_entity_id = w["entity"].id
    inv.tax_date = tax_date
    inv.discount_percentage = Decimal(discount_pct)
    for n, (prod, price, qty, inclusive) in enumerate(lines, start=1):
        item = make_invoice_item(db, w["org"].id, inv.id, line_number=n, unit_price=str(price), total=str(price),
                                 tax_percentage="5")          # client-sent tax: must be ignored
        item.product_id = prod.id if prod is not None else None
        item.quantity = Decimal(str(qty))
        item.is_tax_inclusive = inclusive
    db.commit()
    return inv


def resolver(w, rounding=RoundingRule.PER_LINE, rounding_mode=RoundingMode.HALF_UP):
    return EngineResolver(w["db"], rule_pack_lookup=lambda a: TestOnlyRulePack(rounding, rounding_mode),
                          provider_lookup=lambda a: w["provider"])


def quote(w, inv, rounding=RoundingRule.PER_LINE, key=None, document_type="invoice"):
    return TaxDeterminationService(w["db"], resolver=resolver(w, rounding)).create_quote(
        w["org"].id, w["maker"].id, document_type, inv.id, idempotency_key=key)


def invoice_service(w, rounding=RoundingRule.PER_LINE):
    svc = InvoiceService(w["db"])
    svc.governed_gate = GovernedIssuanceGate(
        w["db"], determination=TaxDeterminationService(w["db"], resolver=resolver(w, rounding)),
        committer=RemoteCommitter(provider_lookup=lambda q: w["provider"]))
    return svc


def finalize(w, inv, **kw):
    return invoice_service(w, **kw).finalize_invoice(inv.id, w["org"].id, w["maker"].id)


# ── Test-only pack isolation ────────────────────────────────────────────

def test_test_only_pack_is_never_loadable_or_registered_by_the_app(w):
    app_dir = pathlib.Path(__file__).resolve().parent.parent / "app"
    offenders = [str(p.relative_to(app_dir)) for p in app_dir.rglob("*.py")
                 if "tests.fixtures" in p.read_text(encoding="utf-8") or "tax_test_rulepack" in p.read_text(encoding="utf-8")]
    assert offenders == []
    assert TEST_PACK_CODE not in RULE_PACKS and all("test" not in c.lower() for c in RULE_PACKS)
    assert pathlib.Path(inspect.getfile(TestOnlyRulePack)).parent.name == "fixtures"

    inv = draft(w, [(w["svc_product"], 100, 1, False)])
    finalize_quote = quote(w, inv)
    finalize(w, inv)
    assert finalize_quote.engine_name == TEST_PACK_CODE
    assert w["db"].query(TaxRulePackVersion).count() == 0                    # never inserted

    # The application's own resolver cannot find it.
    act = next(a for a in TenantTaxService(w["db"]).list_activations(w["org"].id)
               if a.mode == TaxOperatingMode.NATIVE_RULEPACK_APPROVED)
    engine, reason = EngineResolver(w["db"]).engine_for(act)
    assert engine is None and "No approved native rule pack" in reason


# ── Happy path and T01 ──────────────────────────────────────────────────

def test_governed_quote_and_issue_ignore_client_tax(w):
    inv = draft(w, [(w["svc_product"], 100, 2, False)], customer=buyer(w, verified=False, code="B2C"))
    q = quote(w, inv)
    assert q.status == TaxQuoteStatus.QUOTED
    assert (q.subtotal, q.tax_amount, q.total_amount) == (Decimal("200.00"), Decimal("40.00"), Decimal("240.00"))
    issued = finalize(w, inv)
    assert issued.status == InvoiceStatus.SENT and issued.tax_quote_id == q.id
    assert issued.tax_amount == Decimal("40.00") and issued.total_amount == Decimal("240.00")
    assert issued.items[0].tax_percentage == Decimal("20")                 # client sent 5
    assert q.status == TaxQuoteStatus.COMMITTED
    assert w["db"].query(Tax).filter(Tax.invoice_id == inv.id).count() == 0  # snapshot = committed quote


def test_t01_missing_rate_is_not_determined_and_blocks_issue(w):
    w["rate"].status = "SUPERSEDED"                                    # the only reference rate is withdrawn
    w["rate"].superseded_at = NOW
    w["db"].commit()
    inv = draft(w, [(w["svc_product"], 100, 1, False)], customer=buyer(w, verified=False, code="T01"))
    q = quote(w, inv)
    assert q.status == TaxQuoteStatus.NEEDS_EVIDENCE and q.refusal_code == "NO_APPROVED_RATE"
    early = quote(w, draft(w, [(w["svc_product"], 100, 1, False)], tax_date=date(2010, 6, 1)))
    assert early.status == TaxQuoteStatus.NEEDS_EVIDENCE and early.refusal_code == "NOT_DETERMINED"
    assert not q.lines
    with pytest.raises(TaxIssuanceBlocked, match="NOT_DETERMINED"):
        finalize(w, inv)
    w["db"].refresh(inv)
    assert inv.status == InvoiceStatus.DRAFT


def test_t01_unresolved_buyer_address_blocks(w):
    customer = make_customer(w["db"], w["org"].id, code="NOADDR", email="noaddr@buyer.example")
    inv = draft(w, [(w["svc_product"], 100, 1, False)], customer=customer)
    q = quote(w, inv)
    assert q.status == TaxQuoteStatus.NEEDS_EVIDENCE
    assert "BUYER_COUNTRY_MISSING" in {i["code"] for i in q.issues}
    assert q.tax_amount is None                                            # never 0%


def test_no_quote_means_no_issue(w):
    inv = draft(w, [(w["svc_product"], 100, 1, False)])
    with pytest.raises(TaxIssuanceBlocked, match="request a governed tax quote"):
        finalize(w, inv)


# ── Plan change C: only required facts block ────────────────────────────

def test_missing_non_required_fact_is_a_warning_not_a_block(w):
    customer = buyer(w, verified=True, subdivision=None, code="NOSUB")
    inv = draft(w, [(w["svc_product"], 100, 1, False)], customer=customer)
    q = quote(w, inv)
    assert q.status == TaxQuoteStatus.QUOTED
    assert "BUYER_SUBDIVISION_MISSING" in {i["code"] for i in q.warnings}


# ── T08: business status from evidence only ─────────────────────────────

def test_t08_unverified_tax_id_never_yields_zero(w):
    unverified = buyer(w, verified=False, code="UNVER")
    q = quote(w, draft(w, [(w["svc_product"], 100, 1, False)], customer=unverified))
    assert q.status == TaxQuoteStatus.QUOTED
    assert q.lines[0].outcome == TaxOutcome.STANDARD and q.tax_amount == Decimal("20.00")

    verified = quote(w, draft(w, [(w["svc_product"], 100, 1, False)]))
    assert verified.lines[0].outcome == TaxOutcome.REVERSE_CHARGE and verified.tax_amount == Decimal("0.00")
    assert verified.lines[0].components[0].is_reverse_charge


def test_t08_engine_without_consumer_rule_refuses_unresolved_buyer(w):
    unverified = buyer(w, verified=False, code="UNVER2")
    q = quote(w, draft(w, [(w["dig_product"], 100, 1, False)], customer=unverified))   # tenant-config engine
    assert q.status == TaxQuoteStatus.NEEDS_EVIDENCE
    assert "BUYER_STATUS_UNRESOLVED" in {i["code"] for i in q.issues}


# ── Plan changes B, D, E ────────────────────────────────────────────────

@pytest.mark.parametrize("currency", ["KWD", "BHD", "JOD", "CLF", "UYW", "ZZZ", "XAU", "XDR", "HRK", "US"])
def test_unknown_invalid_or_over_two_decimal_currencies_are_unsupported(w, currency):
    # F1: an ISO 4217 allowlist. Unknown (ZZZ), withdrawn (HRK), no minor units
    # (XAU, XDR), malformed (US) and 3/4-decimal codes are all UNSUPPORTED.
    q = quote(w, draft(w, [(w["svc_product"], 100, 1, False)], currency=currency))
    assert q.status == TaxQuoteStatus.UNSUPPORTED and q.refusal_code == "CURRENCY_MINOR_UNITS_UNSUPPORTED"


def test_currency_allowlist_unit():
    from app.modules.tax.currencies import ISO_4217_MINOR_UNITS, governed_currency_decimals
    assert governed_currency_decimals("gbp") == 2 and governed_currency_decimals(" AUD ") == 2
    assert governed_currency_decimals("JPY") == 0
    for bad in (None, "", "ZZZ", "GBPX", "KWD", "CLF", "UYW"):
        assert governed_currency_decimals(bad) is None
    assert all(len(c) == 3 and c.isalpha() and c.isupper() for c in ISO_4217_MINOR_UNITS)
    assert set(ISO_4217_MINOR_UNITS.values()) <= {0, 2, 3, 4}


def test_zero_decimal_currency_rounds_to_whole_units(w):
    unverified = buyer(w, verified=False, code="JPY")
    q = quote(w, draft(w, [(w["svc_product"], 1003, 1, False)], customer=unverified, currency="JPY"))
    assert q.status == TaxQuoteStatus.QUOTED and q.currency_decimals == 0
    assert q.tax_amount == Decimal("201") and q.tax_unrounded == Decimal("200.600000")


def test_mixed_engines_are_unsupported(w):
    q = quote(w, draft(w, [(w["svc_product"], 100, 1, False), (w["dig_product"], 100, 1, False)]))
    assert q.status == TaxQuoteStatus.UNSUPPORTED and q.refusal_code == "MIXED_ENGINES"


def test_unrounded_and_rounded_amounts_are_both_stored(w):
    unverified = buyer(w, verified=False, code="PREC")
    q = quote(w, draft(w, [(w["svc_product"], "10", 1, False)], customer=unverified, discount_pct="33.33"))
    line = q.lines[0]
    assert line.document_discount_unrounded == Decimal("3.333000")
    assert line.taxable_base_unrounded == Decimal("6.667000") and line.taxable_base == Decimal("6.67")
    assert line.tax_unrounded == Decimal("1.333400") and line.tax_amount == Decimal("1.33")
    assert q.tax_unrounded == Decimal("1.333400") and q.tax_amount == Decimal("1.33")


# ── T09: discounts, inclusive prices, rounding, reconciliation ───────────

def test_t09_document_discount_is_allocated_before_tax(w):
    unverified = buyer(w, verified=False, code="DISC")
    inv = draft(w, [(w["svc_product"], "33.33", 1, False)] * 3, customer=unverified, discount_pct="10")
    q = quote(w, inv)
    assert q.tax_amount == Decimal("18.00")                                # on 90.00, not 99.99
    assert q.subtotal - q.discount_amount + q.tax_amount == q.total_amount
    assert sum(l.line_total for l in q.lines) == q.total_amount


def test_t09_per_document_rounding_allocates_to_the_cent(w):
    w["rate"].status = "SUPERSEDED"                                    # replace 20% with 7.5% (new version)
    w["rate"].superseded_at = NOW
    registry_rate(w["db"], w["component"], "7.5", date(2011, 1, 4))
    w["db"].commit()
    unverified = buyer(w, verified=False, code="ROUND")
    for rule, expected in ((RoundingRule.PER_LINE, Decimal("2.25")), (RoundingRule.PER_DOCUMENT, Decimal("2.26"))):
        q = quote(w, draft(w, [(w["svc_product"], "10.03", 1, False)] * 3, customer=unverified), rounding=rule)
        assert q.status == TaxQuoteStatus.QUOTED and q.rounding_rule == rule
        assert q.tax_unrounded == Decimal("2.256750")
        assert q.tax_amount == expected
        assert sum(l.tax_amount for l in q.lines) == q.tax_amount           # lines always sum to the document
        assert q.subtotal - q.discount_amount + q.tax_amount == q.total_amount


def test_t09_inclusive_prices_reconcile(w):
    unverified = buyer(w, verified=False, code="INCL")
    q = quote(w, draft(w, [(w["svc_product"], "120", 1, True), (w["svc_product"], "10", 1, True)], customer=unverified))
    first, second = q.lines
    assert (first.taxable_base, first.tax_amount, first.line_total) == (Decimal("100.00"), Decimal("20.00"), Decimal("120.00"))
    assert (second.taxable_base, second.tax_amount, second.line_total) == (Decimal("8.33"), Decimal("1.67"), Decimal("10.00"))
    assert q.total_amount == Decimal("130.00")


def test_t09_credits_reconcile_to_the_cent(w):
    unverified = buyer(w, verified=False, code="CREDIT")
    inv = draft(w, [(w["svc_product"], "33.33", 1, False)] * 3, customer=unverified, discount_pct="10")
    quote(w, inv)
    finalize(w, inv)
    credits = GovernedCreditService(w["db"])
    lines = [{"invoice_item_id": i.id, "fraction": Decimal("0.3")} for i in inv.items]
    credits.create(w["org"].id, w["maker"].id, inv.id, lines=lines)
    lines = [{"invoice_item_id": i.id, "fraction": Decimal("0.7")} for i in inv.items]
    credits.create(w["org"].id, w["maker"].id, inv.id, lines=lines)
    rows = w["db"].query(CreditNoteTaxLine).filter(CreditNoteTaxLine.invoice_id == inv.id).all()
    assert -sum(r.credited_tax for r in rows) == inv.tax_amount
    with pytest.raises(BadRequestException, match="beyond 100%"):
        credits.create(w["org"].id, w["maker"].id, inv.id, lines=[{"invoice_item_id": inv.items[0].id, "fraction": "0.01"}])


# ── T15 and T18: credits from the original snapshot ─────────────────────

def test_t15_credit_uses_the_original_calculation_after_a_rate_change(w):
    unverified = buyer(w, verified=False, code="T15")
    inv = draft(w, [(w["svc_product"], 100, 1, False)], customer=unverified)
    quote(w, inv)
    finalize(w, inv)
    w["rate"].status = "SUPERSEDED"
    w["rate"].superseded_at = NOW
    registry_rate(w["db"], w["component"], "25", date(2011, 1, 4))
    w["db"].commit()
    note = GovernedCreditService(w["db"]).create(w["org"].id, w["maker"].id, inv.id,
                                                 lines=[{"invoice_item_id": inv.items[0].id}])
    assert note.tax_amount == Decimal("20.00") and note.total_amount == Decimal("120.00")
    assert note.credit_note_type == CreditNoteType.PARTIAL_CREDIT


def test_t15_generic_credit_flows_refuse_governed_invoices(w):
    from app.modules.billing.services.credit_note_service import CreditNoteService

    unverified = buyer(w, verified=False, code="T15G")
    inv = draft(w, [(w["svc_product"], 100, 1, False)], customer=unverified)
    quote(w, inv)
    finalize(w, inv)
    with pytest.raises(BadRequestException, match="governed tax engine"):
        CreditNoteService(w["db"]).create_credit_note(
            w["org"].id, w["maker"].id, customer_id=inv.customer_id, credit_note_number="auto",
            credit_note_type="adjustment", total_amount=Decimal("120"), issue_date=date.today(),
            subtotal=Decimal("100"), tax_amount=Decimal("20"), invoice_id=inv.id)
    note = GovernedCreditService(w["db"]).create(w["org"].id, w["maker"].id, inv.id,
                                                 lines=[{"invoice_item_id": inv.items[0].id}])
    with pytest.raises(BadRequestException, match="cannot be edited"):
        CreditNoteService(w["db"]).update_credit_note(note.id, w["org"].id, w["maker"].id, tax_amount=Decimal("1"))
    with pytest.raises(BadRequestException, match="retained"):
        CreditNoteService(w["db"]).bulk_delete_credit_notes(w["org"].id, [note.id], w["maker"].id)


def test_t18_credits_are_signed_reversals_and_net_to_zero(w):
    """Invoices cannot carry negative lines (ck_invoice_items_qty/price), so
    negative amounts arise only as reversals: credit lines are signed and the
    original plus all its credits nets to exactly zero."""
    unverified = buyer(w, verified=False, code="T18")
    inv = draft(w, [(w["svc_product"], 100, 1, False), (w["svc_product"], "33.33", 1, False)], customer=unverified)
    q = quote(w, inv)
    finalize(w, inv)
    credits = GovernedCreditService(w["db"])
    credits.create(w["org"].id, w["maker"].id, inv.id, lines=[{"invoice_item_id": inv.items[0].id, "fraction": "0.5"}])
    credits.create(w["org"].id, w["maker"].id, inv.id, lines=[{"invoice_item_id": i.id, "fraction": f}
                                                              for i, f in ((inv.items[0], "0.5"), (inv.items[1], "1"))])
    rows = w["db"].query(CreditNoteTaxLine).filter(CreditNoteTaxLine.invoice_id == inv.id).all()
    assert all(r.credited_tax <= 0 and r.credited_base < 0 for r in rows)
    for line in q.lines:
        line_rows = [r for r in rows if r.tax_quote_line_id == line.id]
        assert line.tax_amount + sum(r.credited_tax for r in line_rows) == 0


def test_t18_money_path_handles_negative_bases():
    from app.modules.tax.determination_service import _Line, _apply_rates
    from app.modules.tax.engines import ComponentResult, LineInput, LineResult

    def line(net):
        li = LineInput(line_id=1, line_number=1, product_id=None, tax_code=None, supply_category=None,
                       registry_product_scope=None, transaction_class=None, is_tax_inclusive=False)
        row = _Line(input=li, source=None, gross=Decimal(net), line_discount=Decimal("0"),
                    document_discount=Decimal("0"), net=Decimal(net))
        row.result = LineResult(outcome=TaxOutcome.STANDARD, explanation_code="X",
                                components=[ComponentResult(component_code="C", rate_percent=Decimal("20"),
                                                            rate_source="REGISTRY")])
        return row

    rows = [line("100"), line("-20.025")]
    _apply_rates(rows, 2, RoundingRule.PER_LINE, RoundingMode.HALF_UP)
    assert [r.component_rounded[0] for r in rows] == [Decimal("20.00"), Decimal("-4.01")]   # symmetric half-up
    rows = [line("100"), line("-20.025")]
    _apply_rates(rows, 2, RoundingRule.PER_DOCUMENT, RoundingMode.HALF_UP)
    assert sum(r.component_rounded[0] for r in rows) == Decimal("16.00")
    # F4: the declared mode decides ties (-4.005).
    rows = [line("-20.025")]
    _apply_rates(rows, 2, RoundingRule.PER_LINE, RoundingMode.HALF_EVEN)
    assert rows[0].component_rounded[0] == Decimal("-4.00")


# ── F4: rounding mode is declared by the engine ─────────────────────────

def test_f4_governed_math_has_no_hardcoded_rounding_mode():
    import pathlib

    for name in ("determination_service.py", "issuance_gate.py", "governed_credit_service.py", "engines.py"):
        src = (pathlib.Path("app/modules/tax") / name).read_text(encoding="utf-8")
        assert "ROUND_HALF_UP" not in src and "round_money" not in src, name


@pytest.mark.parametrize("mode, expected", [(RoundingMode.HALF_UP, Decimal("0.13")),
                                            (RoundingMode.HALF_EVEN, Decimal("0.12")),
                                            (RoundingMode.DOWN, Decimal("0.12")),
                                            (RoundingMode.UP, Decimal("0.13"))])
def test_f4_pack_declared_mode_rounds_and_is_recorded(w, mode, expected):
    # 1.25 less a 50% document discount = 0.625; x 20% = 0.125, a tie at 2
    # places that goes the way the pack declares.
    unverified = buyer(w, verified=False, code=f"RM{mode.name}")
    inv = draft(w, [(w["svc_product"], "1.25", 1, False)], customer=unverified, discount_pct="50")
    q = TaxDeterminationService(w["db"], resolver=resolver(w, rounding_mode=mode)).create_quote(
        w["org"].id, w["maker"].id, "invoice", inv.id)
    assert q.status == TaxQuoteStatus.QUOTED, (q.refusal_code, q.refusal_reason)
    assert q.rounding_mode == mode and q.tax_amount == expected
    assert view_quote(q)["engine"]["rounding_mode"] == mode.name


def test_f4_engine_without_a_declared_mode_cannot_quote(w):
    q = TaxDeterminationService(w["db"], resolver=resolver(w, rounding_mode=None)).create_quote(
        w["org"].id, w["maker"].id, "invoice", draft(w, [(w["svc_product"], 100, 1, False)]).id)
    assert q.status == TaxQuoteStatus.UNSUPPORTED and q.refusal_code == "ROUNDING_MODE_UNDECLARED"


def test_f4_credits_round_with_the_quotes_mode(w):
    unverified = buyer(w, verified=False, code="RMCR")
    inv = draft(w, [(w["svc_product"], 100, 1, False)], customer=unverified)
    q = TaxDeterminationService(w["db"], resolver=resolver(w, rounding_mode=RoundingMode.HALF_EVEN)).create_quote(
        w["org"].id, w["maker"].id, "invoice", inv.id)
    assert q.rounding_mode == RoundingMode.HALF_EVEN
    finalize(w, inv)
    # 0.00625 of the line: tax 20 x 0.00625 = 0.125 -> -0.12 under the quote's
    # HALF_EVEN (HALF_UP would give -0.13); base 0.625 -> -0.62.
    note = GovernedCreditService(w["db"]).create(w["org"].id, w["maker"].id, inv.id,
                                                 lines=[{"invoice_item_id": inv.items[0].id, "fraction": "0.00625"}])
    row = w["db"].query(CreditNoteTaxLine).filter(CreditNoteTaxLine.credit_note_id == note.id).one()
    assert (row.credited_base, row.credited_tax) == (Decimal("-0.62"), Decimal("-0.12"))


# ── T03 / T17: legal dates ──────────────────────────────────────────────

def test_t03_effective_boundary_uses_the_local_legal_date(w):
    unverified = buyer(w, verified=False, code="T03")
    w["rate"].status = "SUPERSEDED"
    w["rate"].superseded_at = NOW
    registry_rate(w["db"], w["component"], "20", date(2011, 1, 4), date(2027, 1, 1))
    registry_rate(w["db"], w["component"], "25", date(2027, 1, 1))
    w["db"].commit()
    toronto_new_year_eve = datetime(2027, 1, 1, 4, 30, tzinfo=timezone.utc)   # 23:30 on 31 Dec in Toronto
    assert legal_date_at(toronto_new_year_eve, "America/Toronto") == date(2026, 12, 31)
    assert legal_date_at(toronto_new_year_eve, "UTC") == date(2027, 1, 1)
    before = quote(w, draft(w, [(w["svc_product"], 100, 1, False)], customer=unverified, tax_date=date(2026, 12, 31)))
    after = quote(w, draft(w, [(w["svc_product"], 100, 1, False)], customer=unverified, tax_date=date(2027, 1, 1)))
    assert (before.tax_amount, after.tax_amount) == (Decimal("20.00"), Decimal("25.00"))


def test_t17_dst_and_leap_day(w):
    assert legal_date_at(datetime(2026, 3, 29, 0, 30, tzinfo=timezone.utc), "Europe/London") == date(2026, 3, 29)
    assert legal_date_at(datetime(2026, 10, 24, 23, 30, tzinfo=timezone.utc), "Europe/London") == date(2026, 10, 25)
    unverified = buyer(w, verified=False, code="T17")
    w["rate"].status = "SUPERSEDED"
    w["rate"].superseded_at = NOW
    registry_rate(w["db"], w["component"], "20", date(2011, 1, 4), date(2028, 2, 29))
    registry_rate(w["db"], w["component"], "21", date(2028, 2, 29))
    w["db"].commit()
    leap = quote(w, draft(w, [(w["svc_product"], 100, 1, False)], customer=unverified, tax_date=date(2028, 2, 29)))
    eve = quote(w, draft(w, [(w["svc_product"], 100, 1, False)], customer=unverified, tax_date=date(2028, 2, 28)))
    assert (eve.tax_amount, leap.tax_amount) == (Decimal("20.00"), Decimal("21.00"))


# ── T19 and staleness ───────────────────────────────────────────────────

def test_t19_classification_change_makes_the_quote_stale(w):
    inv = draft(w, [(w["svc_product"], 100, 1, False)])
    q = quote(w, inv)
    dig = next(c for c in active_code_set(w["db"]).codes if c.code == "DIG")
    cls = ClassificationService(w["db"])
    row = cls.propose(w["org"].id, w["maker"].id, product_id=w["svc_product"].id, tax_code_id=dig.id)
    cls.decide(w["org"].id, w["checker"].id, row.id, approve=True)
    with pytest.raises(TaxIssuanceBlocked, match="Tax facts changed"):
        finalize(w, inv)
    w["db"].refresh(q)
    assert q.status == TaxQuoteStatus.STALE


def test_classification_decision_survives_autoflush(db_session):
    """Regression (Phase 3a CI on Postgres): the PG test session autoflushes,
    and a query between status=APPROVED and the approver fields made the
    retention guard refuse the approver. The decision must flush as one."""
    db_session.autoflush = True
    try:
        w = build_world(db_session, org_code="P3A-AF")
        dig = next(c for c in active_code_set(db_session).codes if c.code == "DIG")
        cls = ClassificationService(db_session)
        row = cls.propose(w["org"].id, w["maker"].id, product_id=w["svc_product"].id, tax_code_id=dig.id)
        decided = cls.decide(w["org"].id, w["checker"].id, row.id, approve=True)
        assert (decided.status, decided.approved_by) == (TenantApprovalStatus.APPROVED, w["checker"].id)
        inv = draft(w, [(w["svc_product"], 100, 1, False)])
        quote(w, inv)
        finalize(w, inv)
        assert inv.status == InvoiceStatus.SENT
    finally:
        db_session.autoflush = False


def test_document_change_or_expiry_makes_the_quote_unusable(w):
    inv = draft(w, [(w["svc_product"], 100, 1, False)])
    q = quote(w, inv)
    inv.items[0].quantity = Decimal("2")
    w["db"].commit()
    with pytest.raises(TaxIssuanceBlocked, match="changed since the quote"):
        finalize(w, inv)
    inv.items[0].quantity = Decimal("1")
    w["db"].commit()
    q2 = quote(w, inv)
    gate = GovernedIssuanceGate(w["db"], now=lambda: datetime.now(timezone.utc) + timedelta(days=2))
    with pytest.raises(TaxIssuanceBlocked, match="expired"):
        gate.prepare(inv)
    w["db"].refresh(q2)
    assert q.status == TaxQuoteStatus.STALE and q2.status == TaxQuoteStatus.EXPIRED


def test_idempotency_key(w):
    inv = draft(w, [(w["svc_product"], 100, 1, False)])
    first = quote(w, inv, key="k-1")
    assert quote(w, inv, key="k-1").id == first.id
    other = draft(w, [(w["svc_product"], 50, 1, False)])
    with pytest.raises(QuoteConflictError):
        quote(w, other, key="k-1")


def test_committed_quote_is_frozen(w):
    inv = draft(w, [(w["svc_product"], 100, 1, False)])
    q = quote(w, inv)
    finalize(w, inv)
    q.tax_amount = Decimal("1")
    with pytest.raises(TaxRecordFrozenError):
        w["db"].flush()
    w["db"].rollback()
    q = w["db"].get(TaxQuote, q.id)
    q.status = TaxQuoteStatus.QUOTED
    with pytest.raises(TaxRecordFrozenError):
        w["db"].flush()
    w["db"].rollback()
    q = w["db"].get(TaxQuote, q.id)
    w["db"].delete(q)
    with pytest.raises(TaxRecordFrozenError):
        w["db"].flush()


# ── T10: provider commit reconciliation ─────────────────────────────────

def test_t10_provider_timeout_after_remote_success_never_commits_twice(w):
    w["provider"].fail_mode = "timeout_after_success"
    inv = draft(w, [(w["dig_product"], 100, 1, False)])                 # B2B digital -> provider
    q = quote(w, inv)
    assert q.engine_name == "fake-provider" and q.remote_commit_state == RemoteCommitState.PENDING
    with pytest.raises(TaxIssuanceBlocked, match="did not confirm"):
        finalize(w, inv)
    w["db"].refresh(inv)
    w["db"].refresh(q)
    assert inv.status == InvoiceStatus.DRAFT and q.remote_commit_state == RemoteCommitState.UNCERTAIN
    issued = finalize(w, inv)                                          # reconciles first
    assert issued.status == InvoiceStatus.SENT
    assert w["provider"].commit_calls == 1
    assert q.remote_commit_state == RemoteCommitState.COMMITTED


# ── Plan change A: every creation path, every issuance path ─────────────

def _assert_gated(w, inv):
    assert inv.status == InvoiceStatus.DRAFT and inv.seller_entity_id == w["entity"].id
    with pytest.raises(TaxIssuanceBlocked):
        finalize(w, inv)


def test_path_api_create_invoice_is_gated(w):
    inv = InvoiceService(w["db"]).create_invoice(w["org"].id, w["maker"].id, w["customer"].id, "auto",
                                                 issue_date=date.today(), due_date=date.today())
    make_invoice_item(w["db"], w["org"].id, inv.id).product_id = w["svc_product"].id
    w["db"].commit()
    _assert_gated(w, inv)


def test_path_quote_conversion_keeps_quoted_prices_and_is_gated(w):
    from app.modules.billing.services.quote_service import QuoteService

    db = w["db"]
    q = make_quotation(db, w["org"].id, w["customer"].id, status=QuoteStatus.ACCEPTED, quote_number="Q-3A",
                       currency="GBP")
    q.seller_entity_id = w["entity"].id
    item = make_quotation_item(db, w["org"].id, q.id, unit_price="77.00", total_amount="77.00")
    item.product_id = w["svc_product"].id                              # product default price is 100
    db.commit()
    inv = QuoteService(db).convert_to_invoice(q.id, w["org"].id, w["maker"].id, "auto", date.today(),
                                              date.today() + timedelta(days=30))
    assert inv.items[0].unit_price == Decimal("77.00")                 # governed: not re-priced
    _assert_gated(w, inv)


def test_path_contract_invoice_is_gated(w):
    from app.modules.billing.services.contract_service import ContractService

    db = w["db"]
    contract = make_contract(db, w["org"].id, w["customer"].id, currency="GBP")
    db.add(ContractItem(organization_id=w["org"].id, contract_id=contract.id, line_number=1, description="Work",
                        quantity=Decimal("1"), unit_price=Decimal("100"), total_amount=Decimal("100"),
                        product_id=w["svc_product"].id))
    db.commit()
    inv = ContractService(db).generate_invoice_from_contract(contract.id, w["org"].id, w["maker"].id)
    _assert_gated(w, inv)


def test_path_subscription_invoice_is_gated(w):
    from app.modules.billing.services.subscription_service import SubscriptionService

    db = w["db"]
    plan = make_subscription_plan(db, w["org"].id, code="P3A-PLAN")
    sub = make_subscription(db, w["org"].id, w["customer"].id, plan.id, subscription_number="P3A-SUB", currency="GBP")
    db.commit()
    SubscriptionService(db).generate_invoice(sub.id, w["org"].id, created_by=w["maker"].id)
    inv = db.query(Invoice).filter(Invoice.subscription_id == sub.id).one()
    _assert_gated(w, inv)
    assert quote(w, inv).status == TaxQuoteStatus.NEEDS_EVIDENCE        # subscription lines carry no product


def test_path_assistant_draft_is_gated(w):
    from app.modules.chatbot.actions.action_engine import ActionEngine

    db = w["db"]
    w["customer"].currency = "GBP"
    db.commit()
    draft_obj = SimpleNamespace(organization_id=w["org"].id, action_uid="p3a", action_type="invoice_draft",
                                proposed_params={"customer_id": w["customer"].id, "currency": "GBP",
                                                 "line_items": [{"description": "Work", "quantity": 1, "unit_price": 100}]})
    preview = SimpleNamespace(preview_payload={"currency": "GBP", "subtotal": "100", "tax_amount": "0", "total": "100",
                                               "line_items": [{"description": "Work", "quantity": 1, "unit_price": 100,
                                                               "total": 100}]})
    ctx = SimpleNamespace(user_id=w["maker"].id, organization_id=w["org"].id)
    result = ActionEngine(db)._execute_invoice_draft(draft_obj, preview, ctx)
    inv = db.get(Invoice, result["invoice_id"])
    assert result["status"] == "invoice_draft_requires_tax_quote"   # was issued straight to SENT before 3a
    _assert_gated(w, inv)


def test_path_assistant_legacy_issue_gets_phase0_stamping(w):
    from app.modules.chatbot.actions.action_engine import ActionEngine

    db = w["db"]
    w["entity"].tax_regime = EntityTaxRegime.LEGACY_MANUAL
    w["customer"].currency = "GBP"
    db.commit()
    draft_obj = SimpleNamespace(organization_id=w["org"].id, action_uid="p3a-leg", action_type="invoice_draft",
                                proposed_params={"customer_id": w["customer"].id, "currency": "GBP",
                                                 "line_items": [{"description": "Work", "quantity": 1, "unit_price": 100}]})
    preview = SimpleNamespace(preview_payload={"currency": "GBP", "subtotal": "100", "tax_amount": "0", "total": "100",
                                               "line_items": [{"description": "Work", "quantity": 1, "unit_price": 100,
                                                               "total": 100}]})
    ctx = SimpleNamespace(user_id=w["maker"].id, organization_id=w["org"].id)
    result = ActionEngine(db)._execute_invoice_draft(draft_obj, preview, ctx)
    inv = db.get(Invoice, result["invoice_id"])
    assert result["status"] == "invoice_sent" and inv.status == InvoiceStatus.SENT
    assert inv.seller_entity_id == w["entity"].id and inv.tax_date == inv.issue_date


def test_f2_assistant_legacy_issue_obeys_the_finalization_kill_switch(w):
    # F2: fix (a) covers all invoices, including the assistant's legacy path.
    from app.modules.chatbot.actions.action_engine import ActionEngine
    from app.modules.super_admin.kill_switch_service import TENANT_INVOICE_FINALIZATION, BillingKillSwitchService

    db = w["db"]
    w["entity"].tax_regime = EntityTaxRegime.LEGACY_MANUAL
    w["customer"].currency = "GBP"
    BillingKillSwitchService(db).set_enabled(TENANT_INVOICE_FINALIZATION, False, reason="test", actor_id=w["reviewer"].id)
    db.commit()
    draft_obj = SimpleNamespace(organization_id=w["org"].id, action_uid="p3b-ks", action_type="invoice_draft",
                                proposed_params={"customer_id": w["customer"].id, "currency": "GBP",
                                                 "line_items": [{"description": "Work", "quantity": 1, "unit_price": 100}]})
    preview = SimpleNamespace(preview_payload={"currency": "GBP", "subtotal": "100", "tax_amount": "0", "total": "100",
                                               "line_items": [{"description": "Work", "quantity": 1, "unit_price": 100,
                                                               "total": 100}]})
    ctx = SimpleNamespace(user_id=w["maker"].id, organization_id=w["org"].id)
    result = ActionEngine(db)._execute_invoice_draft(draft_obj, preview, ctx)
    inv = db.get(Invoice, result["invoice_id"])
    assert result["status"] == "invoice_draft_finalization_paused"
    assert inv.status == InvoiceStatus.DRAFT and inv.sent_at is None and inv.tax_date is None


def test_mark_sent_and_email_paths_are_gated(w, monkeypatch):
    svc = invoice_service(w)
    inv = draft(w, [(w["svc_product"], 100, 1, False)])
    with pytest.raises(TaxIssuanceBlocked):
        svc.mark_sent(inv.id, w["org"].id, w["maker"].id)
    sent_emails = []
    monkeypatch.setattr("app.services.email_service.send_invoice_email", lambda **kw: sent_emails.append(kw) or True)
    monkeypatch.setattr("app.modules.billing.services.pdf_service.generate_invoice_pdf", lambda *a, **kw: b"%PDF")
    with pytest.raises(TaxIssuanceBlocked):
        svc.send_invoice_via_email(inv.id, w["org"].id, w["maker"].id)
    assert sent_emails == []                                           # refused before any email
    q = quote(w, inv)
    result = invoice_service(w).send_invoice_via_email(inv.id, w["org"].id, w["maker"].id)
    w["db"].refresh(inv)
    assert result["status"] == "sent" and inv.tax_quote_id == q.id and len(sent_emails) == 1


# ── Fixes (a) (b) (c) ───────────────────────────────────────────────────

def test_fix_a_emailing_a_draft_obeys_the_finalization_kill_switch(w, monkeypatch):
    from app.modules.super_admin.kill_switch_service import TENANT_INVOICE_FINALIZATION, BillingKillSwitchService

    w["entity"].tax_regime = EntityTaxRegime.LEGACY_MANUAL
    w["db"].commit()
    monkeypatch.setattr("app.services.email_service.send_invoice_email", lambda **kw: True)
    monkeypatch.setattr("app.modules.billing.services.pdf_service.generate_invoice_pdf", lambda *a, **kw: b"%PDF")
    inv = draft(w, [(w["svc_product"], 100, 1, False)])
    BillingKillSwitchService(w["db"]).set_enabled(TENANT_INVOICE_FINALIZATION, False, reason="test", actor_id=w["reviewer"].id)
    w["db"].commit()
    with pytest.raises(BadRequestException):
        InvoiceService(w["db"]).send_invoice_via_email(inv.id, w["org"].id, w["maker"].id)
    w["db"].refresh(inv)
    assert inv.status == InvoiceStatus.DRAFT


def test_fix_b_resending_does_not_duplicate_tax_rows(w, monkeypatch):
    w["entity"].tax_regime = EntityTaxRegime.LEGACY_MANUAL
    w["db"].commit()
    monkeypatch.setattr("app.services.email_service.send_invoice_email", lambda **kw: True)
    monkeypatch.setattr("app.modules.billing.services.pdf_service.generate_invoice_pdf", lambda *a, **kw: b"%PDF")
    inv = draft(w, [(w["svc_product"], 100, 1, False)])
    svc = InvoiceService(w["db"])
    svc.send_invoice_via_email(inv.id, w["org"].id, w["maker"].id)
    rows = w["db"].query(Tax).filter(Tax.invoice_id == inv.id).count()
    svc.send_invoice_via_email(inv.id, w["org"].id, w["maker"].id)
    svc.send_invoice_via_email(inv.id, w["org"].id, w["maker"].id)
    assert rows >= 1 and w["db"].query(Tax).filter(Tax.invoice_id == inv.id).count() == rows


def test_fix_c_dead_resolve_tax_branch_is_gone():
    source = inspect.getsource(InvoiceService.create_invoice)
    assert "resolve_tax" not in source


def test_fix_d_legacy_quote_conversion_is_unchanged(w):
    from app.modules.billing.services.quote_service import QuoteService

    db = w["db"]
    w["entity"].tax_regime = EntityTaxRegime.LEGACY_MANUAL
    q = make_quotation(db, w["org"].id, w["customer"].id, status=QuoteStatus.ACCEPTED, quote_number="Q-LEG",
                       currency="GBP")
    q.seller_entity_id = w["entity"].id
    make_quotation_item(db, w["org"].id, q.id, unit_price="77.00", total_amount="77.00").product_id = w["svc_product"].id
    db.commit()
    inv = QuoteService(db).convert_to_invoice(q.id, w["org"].id, w["maker"].id, "auto", date.today(),
                                              date.today() + timedelta(days=30))
    assert inv.items[0].unit_price == Decimal("100.00")                # legacy re-prices (product question)


# ── Findings reports ────────────────────────────────────────────────────

def test_reports_tenant_detail_and_platform_aggregate(w):
    db = w["db"]
    legacy = make_invoice(db, w["org"].id, w["customer"].id, status=InvoiceStatus.SENT, invoice_number="LEG-1")
    legacy.discount_percentage = Decimal("10")
    legacy.tax_amount = Decimal("20.00")
    legacy.currency = "GBP"
    for _ in range(3):
        db.add(Tax(organization_id=w["org"].id, invoice_id=legacy.id, tax_rate_id=None, taxable_amount=Decimal("100"),
                   tax_amount=Decimal("20"), tax_percentage=Decimal("20"), is_active=True))
    db.commit()
    reports = TaxFindingsReportService(db)
    tenant = reports.tenant_overcollection(w["org"].id)
    assert tenant["invoices"][0]["invoice_number"] == "LEG-1"
    assert tenant["invoices"][0]["estimated_overcollected_tax"] == Decimal("2.00")
    platform = reports.platform_overcollection()
    assert platform["organizations_affected"] == 1 and platform["invoice_count"] == 1
    assert platform["totals_by_currency"][0]["estimated_overcollected_tax"] == Decimal("2.00")
    assert "LEG-1" not in str(platform) and "invoices" not in platform
    assert reports.tenant_duplicates(w["org"].id)["duplicate_rows"] == 2
    dup = reports.platform_duplicates()
    assert dup == {"organizations_affected": 1, "invoices_affected": 1, "duplicate_rows": 2, "note": dup["note"]}


def test_f3_overcollection_includes_fixed_document_discounts(w):
    """F3: a fixed document discount counts; line discounts (applied before
    tax) do not. Estimate = tax x document discount / pre-discount subtotal."""
    db = w["db"]

    def legacy(number, *, subtotal, discount_amount, line_discount, tax, pct="0"):
        inv = make_invoice(db, w["org"].id, w["customer"].id, status=InvoiceStatus.SENT, invoice_number=number,
                           currency="GBP")
        inv.subtotal, inv.discount_amount = Decimal(subtotal), Decimal(discount_amount)
        inv.discount_percentage, inv.tax_amount = Decimal(pct), Decimal(tax)
        item = make_invoice_item(db, w["org"].id, inv.id, total=subtotal, unit_price=subtotal)
        item.discount_amount = Decimal(line_discount)
        return inv

    legacy("FIXED-1", subtotal="200.00", discount_amount="15.00", line_discount="5.00", tax="40.00")   # doc 10
    legacy("PCT-1", subtotal="100.00", discount_amount="10.00", line_discount="0", tax="20.00", pct="10")
    legacy("LINE-ONLY", subtotal="100.00", discount_amount="5.00", line_discount="5.00", tax="20.00")
    db.commit()
    rows = {r["invoice_number"]: r for r in TaxFindingsReportService(db).tenant_overcollection(w["org"].id)["invoices"]}
    assert set(rows) == {"FIXED-1", "PCT-1"}
    assert rows["FIXED-1"]["document_discount"] == Decimal("10.00")
    assert rows["FIXED-1"]["estimated_overcollected_tax"] == Decimal("2.00")     # 40 x 10 / 200
    assert rows["PCT-1"]["estimated_overcollected_tax"] == Decimal("2.00")       # 20 x 10 / 100
    platform = TaxFindingsReportService(db).platform_overcollection()
    assert platform["invoice_count"] == 2 and platform["totals_by_currency"][0]["estimated_overcollected_tax"] == Decimal("4.00")
    assert "FIXED-1" not in str(platform) and "invoices" not in platform
    assert "fixed document discounts" in platform["method"]


# ── T20 (light): batch determinism and tenant isolation ─────────────────

def test_t20_batch_quotes_are_deterministic_and_isolated(w):
    unverified = buyer(w, verified=False, code="BATCH")
    invoices = [draft(w, [(w["svc_product"], 10 + n, 1, False)], customer=unverified) for n in range(10)]
    first = [quote(w, inv) for inv in invoices]
    again = [quote(w, inv) for inv in invoices]
    assert [(a.tax_amount, a.context_fingerprint) for a in first] == [(b.tax_amount, b.context_fingerprint) for b in again]
    other = make_organization(w["db"], code="P3A-OTHER")
    with pytest.raises(NotFoundException):
        TaxDeterminationService(w["db"]).create_quote(other.id, None, "invoice", invoices[0].id)
    with pytest.raises(NotFoundException):
        GovernedCreditService(w["db"]).create(other.id, None, invoices[0].id, lines=[])
