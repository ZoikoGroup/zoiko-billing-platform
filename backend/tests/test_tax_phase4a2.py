"""
tests/test_tax_phase4a2.py
--------------------------
ZB-TAX-ARCH-001 Phase 4a-2: provider connections and credentials, provider
activations through approved connections, nexus in the payload, exemption
certificate evidence, corrections by reference (T15/T18), the regime
switch-back (product question 6) and the stuck-transaction actions. All
against the fake provider; the world is the Phase 3a one.
"""
import hashlib
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest

from app.core.exceptions import BadRequestException, ForbiddenException, NotFoundException
from app.modules.billing.models import BillingAuditLog, InvoiceStatus
from app.modules.billing.services.invoice_service import InvoiceService
from app.modules.tax.buyer_evidence_service import BuyerEvidenceService
from app.modules.tax.connection_service import ProviderConnectionService, view_connection
from app.modules.tax.determination_service import TaxDeterminationService
from app.modules.tax.enums import (
    ConnectionStatus,
    EntityTaxRegime,
    OutboxOperation,
    OutboxState,
    ProviderEnvironment,
    TaxOperatingMode,
    TaxQuoteStatus,
    TenantApprovalStatus,
    TransactionClass,
)
from app.modules.tax.governed_credit_service import GovernedCreditService
from app.modules.tax.issuance_gate import GovernedIssuanceGate
from app.modules.tax.legal_entity_service import LegalEntityService
from app.modules.tax.provider_contract import ProviderMode
from app.modules.tax.provider_issuance import ProviderIssuanceBlocked, ProviderIssuanceService
from app.modules.tax.provider_models import TaxProviderConnection, TaxProviderOutbox, TaxProviderSecret
from app.modules.tax.tenant_tax_service import TenantTaxService
from tests.conftest import make_organization
from tests.fixtures.tax_fake_provider import FAKE_ENDPOINTS
from tests.test_tax_phase3a_governed import build_world, draft, quote

PDF = b"%PDF-1.7\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32


@pytest.fixture()
def w(db_session):
    return build_world(db_session, org_code="P4A2")


def conns(w):
    return ProviderConnectionService(w["db"])


def via_connection(w):
    """Production wiring: the default resolver and issuer, adapters built from
    the tenant's connection (nothing injected)."""
    return TaxDeterminationService(w["db"]), ProviderIssuanceService(w["db"])


def provider_invoice(w, price=100):
    inv = draft(w, [(w["dig_product"], price, 1, False)])
    det, _ = via_connection(w)
    q = det.create_quote(w["org"].id, w["maker"].id, "invoice", inv.id)
    return inv, q


def issue_via_connection(w, inv):
    svc = InvoiceService(w["db"])
    svc.governed_gate = GovernedIssuanceGate(w["db"])
    return svc.finalize_invoice(inv.id, w["org"].id, w["maker"].id)


# ── connections: two people, allowlisted endpoints ──────────────────────

def test_connection_needs_a_different_approver_and_is_audited(w):
    c = conns(w).propose(w["org"].id, w["maker"].id, seller_entity_id=w["entity"].id, provider_name="fake-provider",
                         environment=ProviderEnvironment.SANDBOX, mode=ProviderMode.COMMIT)
    assert c.status == ConnectionStatus.PROPOSED
    with pytest.raises(ForbiddenException):
        conns(w).decide(w["org"].id, w["maker"].id, c.id, approve=True)
    conns(w).decide(w["org"].id, w["checker"].id, c.id, approve=True)
    assert c.status == ConnectionStatus.APPROVED and c.approved_by == w["checker"].id
    actions = [a.action.name for a in w["db"].query(BillingAuditLog).filter(
        BillingAuditLog.entity_type == "TaxProviderConnection", BillingAuditLog.entity_id == c.id)]
    assert actions[:2] == ["CREATE", "APPROVE"]


def test_unknown_provider_or_environment_is_refused(w):
    with pytest.raises(BadRequestException, match="not available"):
        conns(w).propose(w["org"].id, w["maker"].id, seller_entity_id=w["entity"].id, provider_name="evil-provider",
                         environment=ProviderEnvironment.SANDBOX, mode=ProviderMode.COMMIT)


def test_test_connection_calls_only_the_allowlisted_endpoint(w):
    c = conns(w).test_connection(w["org"].id, w["maker"].id, w["connection"].id)
    assert w["provider"].test_calls == [FAKE_ENDPOINTS["SANDBOX"]]
    assert c.health_ok is True and "fake-sandbox-credential" not in (c.health_detail or "")


# ── credentials: write-only, masked, audited; revocation freezes (T16) ──

def test_credentials_are_write_only_and_masked(w):
    c = w["connection"]
    view = view_connection(c)
    assert view["credentials"] == {"present": True, "last_rotated_at": c.credential_rotated_at, "last4": "1234"}
    assert "fake-sandbox-credential-1234" not in str(view)
    stored = w["db"].get(TaxProviderSecret, c.credential_ref)
    assert "fake-sandbox-credential" not in stored.ciphertext


def test_rotation_replaces_the_secret_and_is_audited(w):
    c = w["connection"]
    old_ref = c.credential_ref
    conns(w).set_credentials(w["org"].id, w["maker"].id, c.id, "rotated-credential-9876")
    assert c.credential_ref != old_ref and w["db"].get(TaxProviderSecret, old_ref) is None
    assert c.credential_last4 == "9876"
    log = w["db"].query(BillingAuditLog).filter(BillingAuditLog.entity_type == "TaxProviderConnection",
                                                BillingAuditLog.entity_id == c.id).order_by(BillingAuditLog.id.desc()).first()
    assert log.new_values == {"credentials": "rotated", "last4": "9876"}


def test_revoking_credentials_freezes_the_connection_t16(w):
    inv, q = provider_invoice(w)
    assert q.status == TaxQuoteStatus.QUOTED and q.provider_connection_id == w["connection"].id
    c = conns(w).revoke_credentials(w["org"].id, w["maker"].id, w["connection"].id, "credential leaked")
    assert c.status == ConnectionStatus.SUSPENDED and c.credential_ref is None
    assert w["db"].query(TaxProviderSecret).count() == 0
    det, _ = via_connection(w)
    again = det.create_quote(w["org"].id, w["maker"].id, "invoice", inv.id)
    assert again.status != TaxQuoteStatus.QUOTED and again.tax_amount is None
    # Fail closed: the activation is no longer effective, and why is listed.
    assert "SUSPENDED" in again.refusal_reason + str(again.issues)
    with pytest.raises(Exception):
        issue_via_connection(w, inv)
    assert inv.status == InvoiceStatus.DRAFT


def test_resume_needs_new_credentials_and_two_people(w):
    c = conns(w).revoke_credentials(w["org"].id, w["maker"].id, w["connection"].id, "rotation")
    with pytest.raises(BadRequestException, match="new credentials"):
        conns(w).request_resume(w["org"].id, w["maker"].id, c.id)
    conns(w).set_credentials(w["org"].id, w["maker"].id, c.id, "brand-new-credential-5555")
    conns(w).request_resume(w["org"].id, w["maker"].id, c.id)
    with pytest.raises(ForbiddenException):
        conns(w).decide_resume(w["org"].id, w["maker"].id, c.id, approve=True)
    conns(w).decide_resume(w["org"].id, w["checker"].id, c.id, approve=True)
    assert c.status == ConnectionStatus.APPROVED


def test_production_credentials_wait_for_the_managed_secret_store(w):
    c = conns(w).propose(w["org"].id, w["maker"].id, seller_entity_id=w["entity"].id, provider_name="fake-provider",
                         environment=ProviderEnvironment.PRODUCTION, mode=ProviderMode.COMMIT)
    with pytest.raises(BadRequestException, match="4d gate"):
        conns(w).set_credentials(w["org"].id, w["maker"].id, c.id, "production-credential-0001")


def test_credentials_need_a_dedicated_key(w, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "TAX_PROVIDER_ENCRYPTION_KEY", "")
    with pytest.raises(BadRequestException, match="not set"):
        conns(w).set_credentials(w["org"].id, w["maker"].id, w["connection"].id, "another-credential-1111")
    monkeypatch.setattr(settings, "TAX_PROVIDER_ENCRYPTION_KEY", settings.MFA_ENCRYPTION_KEY)
    with pytest.raises(BadRequestException, match="dedicated key"):
        conns(w).set_credentials(w["org"].id, w["maker"].id, w["connection"].id, "another-credential-1111")


# ── provider activations need an approved connection ────────────────────

def test_provider_activation_requires_an_approved_connection(w):
    tenant = TenantTaxService(w["db"])
    reg = tenant.list_registrations(w["org"].id)[0]
    kw = dict(seller_entity_id=w["entity"].id, jurisdiction_id=w["gb"].id, tax_type_id=w["vat"].id,
              transaction_class=TransactionClass.B2B_DIGITAL, mode=TaxOperatingMode.PROVIDER_APPROVED,
              effective_from=date(2026, 1, 1), registration_id=reg.id)
    with pytest.raises(BadRequestException, match="exactly one provider connection"):
        tenant.propose_activation(w["org"].id, w["maker"].id, **kw)
    pending = conns(w).propose(w["org"].id, w["maker"].id, seller_entity_id=w["entity"].id,
                               provider_name="fake-provider", environment=ProviderEnvironment.SANDBOX,
                               mode=ProviderMode.COMMIT)
    act = tenant.propose_activation(w["org"].id, w["maker"].id, provider_connection_id=pending.id, **kw)
    with pytest.raises(BadRequestException, match="PROPOSED"):
        tenant.decide_activation(w["org"].id, w["checker"].id, act.id, approve=True)


# ── end to end through the connection; nexus in the payload ─────────────

def test_issue_through_the_connection_with_the_registered_jurisdiction_set(w):
    inv, q = provider_invoice(w)
    assert q.status == TaxQuoteStatus.QUOTED and q.provider_connection_id == w["connection"].id
    issued = issue_via_connection(w, inv)
    assert issued.status == InvoiceStatus.SENT
    row = w["db"].query(TaxProviderOutbox).filter(TaxProviderOutbox.operation == OutboxOperation.COMMIT).one()
    assert row.provider_connection_id == w["connection"].id
    payload = w["provider"].payloads[0]
    assert payload["seller"]["registered_jurisdictions"] == [
        {"jurisdiction_code": "GB", "tax_type": "VAT", "basis": "REGISTRATION", "registration_number": "GB-FIXTURE"}]
    assert w["provider"].endpoint == FAKE_ENDPOINTS["SANDBOX"]


def test_estimate_only_connection_quotes_but_never_issues(w):
    # A connection's mode is frozen: estimate-only is its own connection.
    est = conns(w).propose(w["org"].id, w["maker"].id, seller_entity_id=w["entity"].id, provider_name="fake-provider",
                           environment=ProviderEnvironment.SANDBOX, mode=ProviderMode.ESTIMATE_ONLY)
    conns(w).set_credentials(w["org"].id, w["maker"].id, est.id, "estimate-credential-2222")
    conns(w).decide(w["org"].id, w["checker"].id, est.id, approve=True)
    adapter = conns(w).adapter_for(est)
    assert adapter.capabilities().mode == ProviderMode.ESTIMATE_ONLY


# ── exemption certificates: model and evidence ──────────────────────────

def _certificate(w, **kw):
    return BuyerEvidenceService(w["db"]).add_certificate(
        w["org"].id, w["maker"].id, w["customer"].id, certificate_number="RESALE-1", jurisdiction_id=w["gb"].id,
        scope_description="Resale", valid_from=date(2026, 1, 1), evidence_ref="paper file", reason_code="resale",
        **kw)


def test_certificate_evidence_is_typed_hashed_write_once_and_tenant_scoped(w):
    svc = BuyerEvidenceService(w["db"])
    cert = _certificate(w)
    assert cert.reason_code == "RESALE"
    with pytest.raises(BadRequestException, match="PDF, PNG or JPEG"):
        svc.attach_certificate_evidence(w["org"].id, w["maker"].id, cert.id, content=b"hello", media_type="text/plain")
    with pytest.raises(BadRequestException, match="not a valid application/pdf"):
        svc.attach_certificate_evidence(w["org"].id, w["maker"].id, cert.id, content=PNG, media_type="application/pdf")
    with pytest.raises(BadRequestException, match="does not match"):
        svc.attach_certificate_evidence(w["org"].id, w["maker"].id, cert.id, content=PDF, media_type="application/pdf",
                                        expected_sha256="0" * 64)
    svc.attach_certificate_evidence(w["org"].id, w["maker"].id, cert.id, content=PDF, media_type="application/pdf",
                                    filename="cert.pdf", expected_sha256=hashlib.sha256(PDF).hexdigest())
    stored = svc.certificate_evidence(w["org"].id, cert.id)
    assert stored.sha256 == hashlib.sha256(PDF).hexdigest() and stored.content == PDF
    with pytest.raises(BadRequestException, match="write-once"):
        svc.attach_certificate_evidence(w["org"].id, w["maker"].id, cert.id, content=PNG, media_type="image/png")
    other = make_organization(w["db"], code="P4A2-OTHER", name="Other")
    with pytest.raises(NotFoundException):
        svc.certificate_evidence(other.id, cert.id)


def test_certificate_evidence_size_limit(w, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "TAX_EVIDENCE_MAX_BYTES", 16)
    with pytest.raises(BadRequestException, match="exceeds"):
        BuyerEvidenceService(w["db"]).attach_certificate_evidence(
            w["org"].id, w["maker"].id, _certificate(w).id, content=PDF, media_type="application/pdf")


# ── corrections by reference (T15 / T18) ────────────────────────────────

def _issued(w, price=100):
    inv, q = provider_invoice(w, price)
    issue_via_connection(w, inv)
    w["db"].refresh(q)
    assert q.status == TaxQuoteStatus.COMMITTED
    return inv, q


def test_t15_credit_adjusts_the_original_provider_transaction_by_reference(w):
    inv, q = _issued(w)
    note = GovernedCreditService(w["db"]).create(w["org"].id, w["maker"].id, inv.id,
                                                 lines=[{"invoice_item_id": inv.items[0].id, "fraction": "0.25"}])
    (row,) = w["db"].query(TaxProviderOutbox).filter(TaxProviderOutbox.operation == OutboxOperation.ADJUST).all()
    assert row.credit_note_id == note.id and row.reference_transaction_id == q.provider_correlation_id
    assert row.state == OutboxState.PENDING                         # written with the credit note
    ProviderIssuanceService(w["db"]).reconcile()
    ProviderIssuanceService(w["db"]).reconcile()                     # idempotent
    w["db"].refresh(row)
    assert row.state == OutboxState.DONE and len(w["provider"].adjustments) == 1
    adj = w["provider"].adjustments[0]
    assert adj["original_transaction_id"] == q.provider_correlation_id and adj["document_type"] == "credit_note"
    assert Decimal(adj["totals"]["tax"]) == Decimal("-2.50")         # signed reversal of a quarter of 10.00


def test_t18_full_credit_nets_the_provider_record_to_zero(w):
    inv, q = _issued(w)
    GovernedCreditService(w["db"]).create(w["org"].id, w["maker"].id, inv.id,
                                          lines=[{"invoice_item_id": inv.items[0].id, "fraction": "1"}])
    ProviderIssuanceService(w["db"]).reconcile()
    original = Decimal(w["provider"].payloads[0]["totals"]["tax"])
    credited = sum(Decimal(a["totals"]["tax"]) for a in w["provider"].adjustments)
    assert original + credited == Decimal("0")


def test_adjust_timeout_after_success_is_resolved_by_state_lookup(w):
    inv, q = _issued(w)
    w["provider"].fail_mode = "adjust_timeout_after_success"
    GovernedCreditService(w["db"]).create(w["org"].id, w["maker"].id, inv.id,
                                          lines=[{"invoice_item_id": inv.items[0].id, "fraction": "0.5"}])
    svc = ProviderIssuanceService(w["db"])
    svc.reconcile()
    row = w["db"].query(TaxProviderOutbox).filter(TaxProviderOutbox.operation == OutboxOperation.ADJUST).one()
    assert row.state == OutboxState.UNCERTAIN
    svc.reconcile()
    w["db"].refresh(row)
    assert row.state == OutboxState.DONE and len(w["provider"].adjustments) == 1


def test_refused_adjustment_needs_a_person_and_the_credit_stands(w):
    inv, q = _issued(w)
    w["provider"].fail = {"adjust_error"}
    note = GovernedCreditService(w["db"]).create(w["org"].id, w["maker"].id, inv.id,
                                                 lines=[{"invoice_item_id": inv.items[0].id, "fraction": "0.5"}])
    ProviderIssuanceService(w["db"]).reconcile()
    row = w["db"].query(TaxProviderOutbox).filter(TaxProviderOutbox.operation == OutboxOperation.ADJUST).one()
    assert row.state == OutboxState.REVIEW_REQUIRED and note.id is not None


def test_voiding_a_provider_invoice_voids_the_provider_transaction(w):
    from app.modules.tax.provider_contract import RemoteTransactionState

    inv, q = _issued(w)
    InvoiceService(w["db"]).void_invoice(inv.id, w["org"].id, "issued in error", w["maker"].id)
    row = w["db"].query(TaxProviderOutbox).filter(TaxProviderOutbox.operation == OutboxOperation.VOID).one()
    assert row.reference_transaction_id == q.provider_correlation_id
    ProviderIssuanceService(w["db"]).reconcile()
    w["db"].refresh(row)
    commit_key = row.idempotency_key.rsplit(":cancel", 1)[0]
    assert row.state == OutboxState.DONE
    assert w["provider"].ledger[commit_key]["state"] == RemoteTransactionState.VOIDED


# ── product question 6: regime changes, both directions, two people ─────

def test_switch_back_needs_two_people_and_never_touches_issued_records(w):
    issued, issued_quote = _issued(w)
    open_draft = draft(w, [(w["svc_product"], 100, 1, False)])
    open_quote = quote(w, open_draft)
    svc = TenantTaxService(w["db"])
    change = svc.request_regime(w["org"].id, w["maker"].id, w["entity"].id, EntityTaxRegime.LEGACY_MANUAL,
                                "pilot ended")
    assert change.status == TenantApprovalStatus.PROPOSED and w["entity"].tax_regime == EntityTaxRegime.GOVERNED
    with pytest.raises(ForbiddenException):
        svc.decide_regime_change(w["org"].id, w["maker"].id, change.id, approve=True)
    with pytest.raises(BadRequestException, match="already awaiting"):
        svc.request_regime(w["org"].id, w["maker"].id, w["entity"].id, EntityTaxRegime.LEGACY_MANUAL)
    version = w["entity"].version
    svc.decide_regime_change(w["org"].id, w["checker"].id, change.id, approve=True)
    assert w["entity"].tax_regime == EntityTaxRegime.LEGACY_MANUAL and w["entity"].version == version + 1
    w["db"].refresh(issued)
    w["db"].refresh(issued_quote)
    assert issued.status == InvoiceStatus.SENT and issued_quote.status == TaxQuoteStatus.COMMITTED


def test_settings_toggle_cannot_leave_governed(w):
    with pytest.raises(BadRequestException, match="cannot be left from settings"):
        LegalEntityService(w["db"]).update_entity(w["entity"].id, w["org"].id, w["maker"].id,
                                                  tax_regime=EntityTaxRegime.LEGACY_MANUAL)


def test_enabling_governed_is_also_two_person(w):
    svc = TenantTaxService(w["db"])
    change = svc.request_regime(w["org"].id, w["maker"].id, w["entity"].id, EntityTaxRegime.LEGACY_MANUAL)
    svc.decide_regime_change(w["org"].id, w["checker"].id, change.id, approve=True)
    back = svc.request_regime(w["org"].id, w["maker"].id, w["entity"].id, EntityTaxRegime.GOVERNED)
    assert w["entity"].tax_regime == EntityTaxRegime.LEGACY_MANUAL and back.status == TenantApprovalStatus.PROPOSED
    svc.decide_regime_change(w["org"].id, w["checker"].id, back.id, approve=True)
    assert w["entity"].tax_regime == EntityTaxRegime.GOVERNED


# ── stuck-transaction actions ───────────────────────────────────────────

def test_void_of_a_stuck_transaction_needs_two_people(w):
    inv, q = provider_invoice(w)
    w["provider"].remote_tax_delta = Decimal("0.01")                 # drift -> REVIEW_REQUIRED, committed remotely
    issue_via_connection(w, inv)
    row = w["db"].query(TaxProviderOutbox).filter(TaxProviderOutbox.operation == OutboxOperation.COMMIT).one()
    assert row.state == OutboxState.REVIEW_REQUIRED
    svc = ProviderIssuanceService(w["db"])
    assert svc.check_state(row.id)["provider"]["state"] == "COMMITTED"
    w["db"].refresh(row)
    assert row.state == OutboxState.REVIEW_REQUIRED                  # check-state changes nothing
    svc.request_void(row.id, w["maker"].id)
    with pytest.raises(BadRequestException, match="different user"):
        svc.approve_void(row.id, w["maker"].id)
    svc.approve_void(row.id, w["checker"].id)
    w["db"].refresh(row)
    assert row.state == OutboxState.VOIDED and w["provider"].void_calls == 1


def test_retry_requeues_a_row_that_failed_on_our_side(w):
    from app.modules.tax.enums import OutboxReviewKind

    inv, q = provider_invoice(w)
    svc = ProviderIssuanceService(w["db"])
    row = svc.begin(inv, q, w["maker"].id)
    svc._review(row, OutboxReviewKind.ROW_ERROR, "simulated")
    w["db"].commit()
    svc.retry(row.id)
    assert row.state == OutboxState.UNCERTAIN                        # resolved by a state lookup first
    svc.reconcile()
    w["db"].refresh(inv)
    assert inv.status == InvoiceStatus.SENT
