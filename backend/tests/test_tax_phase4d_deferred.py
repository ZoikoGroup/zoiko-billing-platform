"""
tests/test_tax_phase4d_deferred.py
----------------------------------
ZB-TAX-ARCH-001 Phase 4d: the two items deferred from 4c.

Manual address resolution: for an address the resolver could not place
(AMBIGUOUS / NOT_FOUND), a billing admin proposes the districts with a
reason, attaches an evidence document, and a different finance approver
approves; only then does the address count as RESOLVED (precision MANUAL).

Pseudonym remapping export: during a key rotation, old -> new customer
references for every customer the provider holds records for, only when the
outgoing key is the acknowledged one.
"""
from decimal import Decimal

import pytest

from app.config import settings
from app.core.exceptions import BadRequestException, ForbiddenException
from app.modules.billing.models import BillingAuditLog, InvoiceStatus
from app.modules.billing.services.invoice_service import InvoiceService
from app.modules.tax.address_resolver import ADDRESS_RESOLVERS, ManualResolutionService, latest_resolution
from app.modules.tax.enums import TaxQuoteStatus
from app.modules.tax.issuance_gate import GovernedIssuanceGate
from app.modules.tax.models import TaxRecordFrozenError
from app.modules.tax.pseudonym import PseudonymKeyService, customer_pseudonym
from tests.test_tax_phase4c_us import COUNTY, D2, STATE, build_us, buyer, quote_for

PDF = b"%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n"
CODES = ["US", STATE, COUNTY, D2]


@pytest.fixture()
def w(db_session):
    world = build_us(db_session, code="P4DDEF")
    yield world
    ADDRESS_RESOLVERS.clear()


def svc(w):
    return ManualResolutionService(w["db"])


def ambiguous_buyer(w):
    return buyer(w, "5 Split Rd")                                 # two candidates -> AMBIGUOUS


def propose(w, c, a, codes=None, actor="maker"):
    return svc(w).propose(w["org"].id, w[actor].id, c.id, a.id, jurisdiction_codes=codes or CODES,
                          reason="Two parcels share the street number; the county lookup puts the unit in D2.")


# ── manual address resolution ───────────────────────────────────────────

def test_a_manual_resolution_needs_evidence_and_a_second_person_then_quotes(w):
    c, a = ambiguous_buyer(w)
    _, blocked = quote_for(w, c)
    assert blocked.status == TaxQuoteStatus.NEEDS_EVIDENCE

    row = propose(w, c, a)
    with pytest.raises(BadRequestException, match="evidence"):
        svc(w).decide(w["org"].id, w["checker"].id, row.id, approve=True)
    svc(w).attach_evidence(w["org"].id, w["maker"].id, row.id, content=PDF, media_type="application/pdf")
    with pytest.raises(ForbiddenException):
        svc(w).decide(w["org"].id, w["maker"].id, row.id, approve=True)
    _, still = quote_for(w, c)
    assert still.status == TaxQuoteStatus.NEEDS_EVIDENCE             # nothing counts before approval

    svc(w).decide(w["org"].id, w["checker"].id, row.id, approve=True)
    resolution = latest_resolution(w["db"], w["org"].id, a.id)
    assert (resolution.status, resolution.precision, resolution.resolver_name) == ("RESOLVED", "MANUAL", "manual")
    assert resolution.source == f"manual:{row.id}" and resolution.jurisdiction_codes == CODES
    assert row.resolution_id == resolution.id and resolution.resolved_by == w["checker"].id
    _, q = quote_for(w, c)
    assert q.status == TaxQuoteStatus.QUOTED and q.tax_amount == Decimal("8.25")
    assert q.supply_address["resolution_id"] == resolution.id
    actions = [l.action.name for l in w["db"].query(BillingAuditLog).filter(
        BillingAuditLog.entity_type == "TaxManualResolutionRequest", BillingAuditLog.entity_id == row.id)]
    assert actions == ["CREATE", "UPDATE", "APPROVE"]


def test_manual_resolution_is_only_for_addresses_the_resolver_could_not_place(w):
    c, a = buyer(w, "100 First St")                               # resolved by the resolver
    with pytest.raises(BadRequestException, match="could not place"):
        propose(w, c, a)
    c2, a2 = buyer(w, "9 Unresolved Way", resolve=False)          # never resolved
    with pytest.raises(BadRequestException, match="resolve it first"):
        propose(w, c2, a2)


@pytest.mark.parametrize("codes, message", [
    (["US-CA", "US"], "first jurisdiction must be the address country"),
    (["US", "US-CA-LA"], "must include the address state"),
    (["US", STATE, "US-CA-LA-D9"], "Not in the tax reference registry"),
    (["US", STATE, STATE], "once"),
])
def test_proposed_districts_are_checked(w, codes, message):
    c, a = ambiguous_buyer(w)
    with pytest.raises(BadRequestException, match=message):
        propose(w, c, a, codes=codes)


def test_one_open_proposal_per_address_and_withdraw(w):
    c, a = ambiguous_buyer(w)
    row = propose(w, c, a)
    with pytest.raises(BadRequestException, match="already awaiting"):
        propose(w, c, a)
    svc(w).withdraw(w["org"].id, w["maker"].id, row.id)
    assert propose(w, c, a).id != row.id


def test_rejection_resolves_nothing(w):
    c, a = ambiguous_buyer(w)
    row = propose(w, c, a)
    svc(w).attach_evidence(w["org"].id, w["maker"].id, row.id, content=PDF, media_type="application/pdf")
    svc(w).decide(w["org"].id, w["checker"].id, row.id, approve=False, reason="lookup is for the other unit")
    assert row.status.name == "REJECTED" and latest_resolution(w["db"], w["org"].id, a.id).status == "AMBIGUOUS"


def test_evidence_is_write_once_and_the_proposal_is_frozen(w):
    c, a = ambiguous_buyer(w)
    row = propose(w, c, a)
    svc(w).attach_evidence(w["org"].id, w["maker"].id, row.id, content=PDF, media_type="application/pdf")
    with pytest.raises(BadRequestException, match="write-once"):
        svc(w).attach_evidence(w["org"].id, w["maker"].id, row.id, content=PDF + b"x", media_type="application/pdf")
    row.jurisdiction_codes = ["US", STATE]
    with pytest.raises(TaxRecordFrozenError):
        w["db"].flush()
    w["db"].rollback()


def test_a_changed_address_invalidates_the_proposal(w):
    from app.modules.tax.buyer_evidence_service import BuyerEvidenceService
    from app.modules.tax.enums import AddressRole

    c, a = ambiguous_buyer(w)
    row = propose(w, c, a)
    svc(w).attach_evidence(w["org"].id, w["maker"].id, row.id, content=PDF, media_type="application/pdf")
    BuyerEvidenceService(w["db"]).record_address(w["org"].id, w["maker"].id, c.id, role=AddressRole.BILLING,
                                                 country_code="US", subdivision_code="CA", postal_code="90012",
                                                 city="Los Angeles", line1="6 Other St")
    with pytest.raises(BadRequestException, match="replaced"):
        svc(w).decide(w["org"].id, w["checker"].id, row.id, approve=True)


def test_a_manual_resolution_expires_like_any_other(w, monkeypatch):
    c, a = ambiguous_buyer(w)
    row = propose(w, c, a)
    svc(w).attach_evidence(w["org"].id, w["maker"].id, row.id, content=PDF, media_type="application/pdf")
    svc(w).decide(w["org"].id, w["checker"].id, row.id, approve=True)
    monkeypatch.setattr(settings, "TAX_ADDRESS_RESOLUTION_VALID_DAYS", 0)
    _, q = quote_for(w, c)
    assert q.status == TaxQuoteStatus.NEEDS_EVIDENCE
    assert any(i["code"] == "ADDRESS_RESOLUTION_STALE" for i in q.issues)


def test_another_tenant_cannot_see_or_decide_a_proposal(w, db_session):
    from app.core.exceptions import NotFoundException
    from tests.conftest import make_organization

    c, a = ambiguous_buyer(w)
    row = propose(w, c, a)
    other = make_organization(db_session, code="P4DDX", name="Other")
    with pytest.raises(NotFoundException):
        svc(w).decide(other.id, w["checker"].id, row.id, approve=True)
    assert svc(w).list(other.id) == []


# ── pseudonym remapping export ──────────────────────────────────────────

def _issue(w, c):
    inv, q = quote_for(w, c)
    assert q.status == TaxQuoteStatus.QUOTED
    service = InvoiceService(w["db"])
    service.governed_gate = GovernedIssuanceGate(w["db"])
    assert service.finalize_invoice(inv.id, w["org"].id, w["maker"].id).status == InvoiceStatus.SENT


def test_remap_export_pairs_old_and_new_references_for_provider_customers(w, monkeypatch):
    c1, _ = buyer(w, "100 First St")
    c2, _ = buyer(w, "900 Ninth St")
    c3, _ = buyer(w, "100 First St")                              # never invoiced through the provider
    _issue(w, c1)
    _issue(w, c2)
    old = {c.id: customer_pseudonym(w["org"].id, c.id) for c in (c1, c2)}
    sent_refs = {p["buyer"]["customer_ref"] for p in w["provider"].payloads}
    assert sent_refs == set(old.values())

    outgoing = settings.TAX_PROVIDER_PSEUDONYM_KEY
    monkeypatch.setattr(settings, "TAX_PROVIDER_PSEUDONYM_KEY", "the-new-pseudonym-key")
    monkeypatch.setattr(settings, "TAX_PROVIDER_PSEUDONYM_KEY_PREVIOUS", outgoing)
    keys = PseudonymKeyService(w["db"])
    assert keys.status(w["org"].id)["remap_export_available"] is True
    rows = keys.remap_export(w["org"].id, w["maker"].id)
    new = {c.id: customer_pseudonym(w["org"].id, c.id) for c in (c1, c2)}
    assert sorted(rows) == sorted((old[cid], new[cid]) for cid in (c1.id, c2.id))
    assert customer_pseudonym(w["org"].id, c3.id) not in {n for _, n in rows}
    assert all(r.startswith("zc_") for pair in rows for r in pair)
    log = w["db"].query(BillingAuditLog).filter(BillingAuditLog.entity_type == "TaxPseudonymKeyRecord") \
        .order_by(BillingAuditLog.id.desc()).first()
    assert log.action.name == "EXPORT" and log.new_values["remap_export"] == 2
    assert outgoing not in str(log.new_values) and "the-new-pseudonym-key" not in str(log.new_values)


def test_remap_export_refuses_the_wrong_outgoing_key(w, monkeypatch):
    c, _ = buyer(w, "100 First St")
    _issue(w, c)
    monkeypatch.setattr(settings, "TAX_PROVIDER_PSEUDONYM_KEY", "the-new-pseudonym-key")
    monkeypatch.setattr(settings, "TAX_PROVIDER_PSEUDONYM_KEY_PREVIOUS", "not-the-key-we-used")
    with pytest.raises(BadRequestException, match="not the acknowledged key"):
        PseudonymKeyService(w["db"]).remap_export(w["org"].id, w["maker"].id)


def test_remap_export_needs_a_rotation_in_progress(w, monkeypatch):
    keys = PseudonymKeyService(w["db"])
    with pytest.raises(BadRequestException, match="PREVIOUS"):
        keys.remap_export(w["org"].id, w["maker"].id)
    monkeypatch.setattr(settings, "TAX_PROVIDER_PSEUDONYM_KEY_PREVIOUS", settings.TAX_PROVIDER_PSEUDONYM_KEY)
    with pytest.raises(BadRequestException, match="unchanged"):
        keys.remap_export(w["org"].id, w["maker"].id)


def test_the_previous_key_secret_must_be_a_numbered_version(monkeypatch):
    from app.modules.tax.secret_store import SecretStoreUnavailable, config_secret

    monkeypatch.setattr(settings, "TAX_PROVIDER_PSEUDONYM_KEY_PREVIOUS_SECRET",
                        "projects/p/secrets/tax-provider-pseudonym-key/versions/latest")
    with pytest.raises(SecretStoreUnavailable, match="numbered version"):
        config_secret("TAX_PROVIDER_PSEUDONYM_KEY_PREVIOUS")
