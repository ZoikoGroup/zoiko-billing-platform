"""
tests/test_tax_phase4a_outbox.py
--------------------------------
ZB-TAX-ARCH-001 Phase 4a-1: provider issuance through the transactional
outbox, reconciliation, the circuit breaker and the fail-closed checks,
against the fake provider. T10 (timeout after success, duplicate delivery,
crash between steps), T16 (provider suspended, source revoked), T20 (batch
isolation and idempotency), the kill switch at both transactions, committed
tax dates, estimate-only mode, REVIEW_REQUIRED, drift, and the aggregate-only
operations view.

The world is the Phase 3a one: a GOVERNED GB entity whose B2B digital lines
are routed to the fake provider.
"""
import json
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest

from app.core.exceptions import BadRequestException
from app.modules.billing.models import Invoice, InvoiceStatus
from app.modules.super_admin.kill_switch_service import TENANT_INVOICE_FINALIZATION, BillingKillSwitchService
from app.modules.tax.enums import (
    CircuitState,
    DocumentReferencePolicy,
    OutboxOperation,
    OutboxState,
    RemoteCommitState,
    ReviewItemKind,
    TaxOutcome,
    TaxQuoteStatus,
)
from app.modules.tax.issuance_gate import GovernedIssuanceGate, TaxIssuanceBlocked
from app.modules.tax.models import TaxReviewItem
from app.modules.tax.provider_contract import ProviderMode
from app.modules.tax.provider_issuance import (
    ProviderHealth,
    ProviderIssuanceBlocked,
    ProviderIssuanceService,
    aggregate_health,
    beat_for_tests,
    idempotency_key,
)
from app.modules.tax.provider_models import TaxJobHeartbeat, TaxProviderCircuit, TaxProviderOutbox
from tests.test_tax_phase3a_governed import TAX_DATE, build_world, draft, finalize, invoice_service, quote


@pytest.fixture()
def w(db_session):
    return build_world(db_session, org_code="P4A")


def issuance(w, **kw):
    return ProviderIssuanceService(w["db"], provider_lookup=lambda name: w["provider"], **kw)


def provider_draft(w, price=100, **kw):
    """A B2B digital line: routed to the fake provider (10%)."""
    inv = draft(w, [(w["dig_product"], price, 1, False)], **kw)
    q = quote(w, inv)
    assert q.status == TaxQuoteStatus.QUOTED and q.engine_name == "fake-provider", (q.refusal_code, q.refusal_reason)
    return inv, q


def rows(w, inv=None):
    q = w["db"].query(TaxProviderOutbox)
    if inv is not None:
        q = q.filter(TaxProviderOutbox.invoice_id == inv.id)
    return q.order_by(TaxProviderOutbox.id).all()


def pause(w):
    BillingKillSwitchService(w["db"]).set_enabled(TENANT_INVOICE_FINALIZATION, False, reason="test",
                                                  actor_id=w["reviewer"].id)
    w["db"].commit()


def resume_finalization(w):
    BillingKillSwitchService(w["db"]).set_enabled(TENANT_INVOICE_FINALIZATION, True, reason="test",
                                                  actor_id=w["reviewer"].id)
    w["db"].commit()


# ── happy path ──────────────────────────────────────────────────────────

def test_provider_invoice_issues_through_the_outbox(w):
    inv, q = provider_draft(w)
    issued = finalize(w, inv)
    assert issued.status == InvoiceStatus.SENT and issued.tax_quote_id == q.id
    (row,) = [r for r in rows(w, inv) if r.operation == OutboxOperation.COMMIT]
    assert row.state == OutboxState.DONE and row.idempotency_key == idempotency_key(q) == f"zb:{w['org'].id}:{inv.id}:{q.id}"
    w["db"].refresh(q)
    assert q.status == TaxQuoteStatus.COMMITTED and q.remote_commit_state == RemoteCommitState.COMMITTED
    assert q.provider_correlation_id == row.provider_transaction_id
    assert w["provider"].committed_keys() == [row.idempotency_key]
    payload = w["provider"].payloads[0]
    blob = json.dumps(payload)
    customer = w["customer"]
    for secret in (customer.email, customer.company_name, customer.display_name):
        assert secret and secret not in blob                       # no customer identity leaves the platform


# ── T10: timeouts, duplicates, crashes ──────────────────────────────────

def test_t10_timeout_after_remote_success_commits_once(w):
    inv, q = provider_draft(w)
    w["provider"].fail_mode = "timeout_after_success"
    pending = finalize(w, inv)
    assert pending.status == InvoiceStatus.DRAFT
    (row,) = rows(w, inv)
    assert row.state == OutboxState.UNCERTAIN
    issuance(w).reconcile()                                        # state lookup first, never a blind retry
    w["db"].refresh(inv)
    assert inv.status == InvoiceStatus.SENT
    assert w["provider"].commit_calls == 1 and len(w["provider"].ledger) == 1


def test_t10_timeout_before_success_recommits_with_the_same_key(w):
    inv, q = provider_draft(w)
    w["provider"].fail_mode = "timeout_before_success"
    assert finalize(w, inv).status == InvoiceStatus.DRAFT
    issuance(w).reconcile()
    w["db"].refresh(inv)
    assert inv.status == InvoiceStatus.SENT
    assert w["provider"].commit_calls == 2 and list(w["provider"].ledger) == [idempotency_key(q)]


def test_t10_duplicate_delivery_never_commits_twice(w):
    inv, q = provider_draft(w)
    svc = issuance(w)
    row = svc.begin(inv, q, w["maker"].id)
    svc.deliver(row.id)
    svc.deliver(row.id)                                            # duplicate delivery of the same row
    svc.reconcile()
    svc.reconcile()
    w["db"].refresh(inv)
    assert inv.status == InvoiceStatus.SENT
    assert w["provider"].commit_calls == 1 and len(w["provider"].ledger) == 1


@pytest.mark.parametrize("crash_after", ["transaction_1", "remote_commit"])
def test_t10_crash_between_steps_is_finished_by_reconciliation(w, crash_after):
    inv, q = provider_draft(w)
    svc = issuance(w)
    row = svc.begin(inv, q, w["maker"].id)
    if crash_after == "remote_commit":
        svc.deliver(row.id)
        assert rows(w, inv)[0].state == OutboxState.REMOTE_COMMITTED
    w["db"].expire_all()                                           # the process "restarts"
    issuance(w).reconcile()
    w["db"].refresh(inv)
    assert inv.status == InvoiceStatus.SENT and w["provider"].commit_calls == 1


def test_t10_crash_during_transaction_2_rolls_back_and_is_retried(w):
    inv, q = provider_draft(w)
    calls = {"n": 0}

    def crashing_finalizer(invoice, quote_, actor):
        from app.modules.billing.services.invoice_service import InvoiceService

        InvoiceService(w["db"]).complete_governed_issue(invoice, quote_, actor, commit=False)
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("simulated crash mid-transaction")

    svc = issuance(w, finalizer=crashing_finalizer)
    issued = svc.issue(inv, q, w["maker"].id)
    assert issued.status == InvoiceStatus.DRAFT                    # rolled back as one unit
    assert rows(w, inv)[0].state == OutboxState.REMOTE_COMMITTED
    svc.reconcile()
    w["db"].refresh(inv)
    assert inv.status == InvoiceStatus.SENT and w["provider"].commit_calls == 1


def test_locked_draft_cannot_be_edited_while_issuing(w):
    inv, q = provider_draft(w)
    issuance(w).begin(inv, q, w["maker"].id)
    inv.items[0].unit_price = Decimal("1")
    with pytest.raises(ProviderIssuanceBlocked, match="being issued"):
        w["db"].flush()
    w["db"].rollback()


# ── kill switch at transaction 1 and transaction 2 ──────────────────────

def test_kill_switch_at_transaction_1_sends_nothing(w):
    inv, q = provider_draft(w)
    pause(w)
    with pytest.raises(BadRequestException):
        issuance(w).issue(inv, q, w["maker"].id)
    assert w["provider"].commit_calls == 0 and rows(w) == []


def test_kill_switch_at_transaction_2_holds_then_voids_after_grace(w):
    inv, q = provider_draft(w)
    svc = issuance(w)
    row = svc.begin(inv, q, w["maker"].id)
    svc.deliver(row.id)
    pause(w)
    svc.finalize(row.id)
    w["db"].refresh(inv)
    assert inv.status == InvoiceStatus.DRAFT and rows(w, inv)[0].state == OutboxState.REMOTE_COMMITTED
    later = issuance(w, now=lambda: datetime.now(timezone.utc) + timedelta(minutes=16))
    later.finalize(row.id)
    (row,) = rows(w, inv)
    assert row.state == OutboxState.VOIDED and w["provider"].void_calls == 1
    w["db"].refresh(q)
    assert q.status == TaxQuoteStatus.VOIDED and q.remote_commit_state == RemoteCommitState.VOIDED
    w["db"].refresh(inv)
    assert inv.status == InvoiceStatus.DRAFT and inv.sent_at is None
    inv.notes = "editable again"                                   # unlocked once voided
    w["db"].commit()


# ── committed dates and currency ────────────────────────────────────────

def test_transaction_2_stamps_the_committed_tax_date_after_local_midnight(w):
    inv, q = provider_draft(w)
    # 23:30 UTC on 1 June is 00:30 on 2 June in London: the invoice keeps the committed date.
    after_midnight = datetime(2026, 6, 1, 23, 30, tzinfo=timezone.utc)
    issued = issuance(w, now=lambda: after_midnight).issue(inv, q, w["maker"].id)
    assert issued.status == InvoiceStatus.SENT
    assert issued.tax_date == q.tax_date == TAX_DATE and issued.currency == q.currency == "GBP"


# ── estimate-only can quote, never issue ────────────────────────────────

def test_estimate_only_mode_can_quote_but_never_issue(w):
    w["provider"].mode = ProviderMode.ESTIMATE_ONLY
    inv, q = provider_draft(w)                                     # quoting works
    with pytest.raises(ProviderIssuanceBlocked, match="estimate-only"):
        finalize(w, inv)
    w["db"].refresh(inv)
    assert inv.status == InvoiceStatus.DRAFT and w["provider"].commit_calls == 0
    with pytest.raises(TaxIssuanceBlocked, match="has not committed"):
        GovernedIssuanceGate(w["db"]).commit(inv, q, w["maker"].id)     # no SENT without a remote commit


# ── fail closed: circuit, heartbeat, suspension (T16) ───────────────────

def test_circuit_opens_after_repeated_failures_and_blocks(w):
    w["provider"].fail = {"determine_error"}                       # persistent outage
    inv = draft(w, [(w["dig_product"], 100, 1, False)])
    for _ in range(5):
        q = quote(w, inv)
        assert q.status == TaxQuoteStatus.PROVIDER_UNAVAILABLE and q.tax_amount is None
    assert w["db"].get(TaxProviderCircuit, "fake-provider").state == CircuitState.OPEN
    w["provider"].fail = set()
    q = quote(w, inv)                                              # still within the cool-down
    assert q.status == TaxQuoteStatus.PROVIDER_UNAVAILABLE and "circuit open" in q.refusal_reason
    with pytest.raises(TaxIssuanceBlocked):
        finalize(w, inv)


def test_stale_heartbeat_blocks_provider_issuing(w):
    inv, q = provider_draft(w)
    beat_for_tests(w["db"], at=datetime.now(timezone.utc) - timedelta(hours=1))
    w["db"].commit()
    with pytest.raises(ProviderIssuanceBlocked, match="reconciliation is not running"):
        finalize(w, inv)
    assert w["provider"].commit_calls == 0
    w["db"].refresh(q)
    assert q.status == TaxQuoteStatus.PROVIDER_UNAVAILABLE


def test_t16_suspended_provider_freezes_quotes_and_issuing(w):
    inv, q = provider_draft(w)
    ProviderHealth(w["db"]).suspend("fake-provider", "contract ended")
    w["db"].commit()
    with pytest.raises(ProviderIssuanceBlocked, match="suspended"):
        finalize(w, inv)
    again = quote(w, inv)
    assert again.status == TaxQuoteStatus.PROVIDER_UNAVAILABLE and "suspended" in again.refusal_reason
    health = aggregate_health(w["db"])
    assert health["providers"][0]["circuit"] == "SUSPENDED"


# ── REVIEW_REQUIRED and reason codes ────────────────────────────────────

def _hook(**changes):
    def hook(request, result):
        for key, value in changes.items():
            setattr(result, key, value(request, result) if callable(value) else value)
        return result
    return hook


@pytest.mark.parametrize("changes, fragment", [
    ({"applied_jurisdiction_ids": lambda r, res: [9999]}, "no recorded registration"),
    ({"provider_tax_date": date(2026, 5, 31)}, "tax date"),
    ({"provider_currency": "EUR"}, "currency"),
    ({"provider_line_tax": Decimal("10.00"),
      "components": lambda r, res: [setattr(c, "provider_tax_amount", Decimal("9.99")) or c for c in res.components]},
     "do not add up"),
    ({"provider_line_tax": Decimal("0"), "reason_code": None}, "no reason"),
    ({"provider_line_tax": Decimal("0"), "reason_code": "MYSTERY"}, "unrecognised reason MYSTERY"),
])
def test_provider_contradictions_are_review_required(w, changes, fragment):
    w["provider"].result_hook = _hook(**changes)
    q = quote(w, draft(w, [(w["dig_product"], 100, 1, False)]))
    assert q.status == TaxQuoteStatus.REVIEW_REQUIRED and q.refusal_code == "PROVIDER_CONTRADICTS_CONTEXT"
    assert fragment in q.refusal_reason and q.tax_amount is None


def test_known_reason_code_maps_to_our_outcome(w):
    w["provider"].rate = Decimal("0")
    # (EXEMPT additionally needs a valid certificate on file: Phase 4c tests.)
    w["provider"].result_hook = _hook(provider_line_tax=Decimal("0"), reason_code="ZERO_RATED")
    q = quote(w, draft(w, [(w["dig_product"], 100, 1, False)]))
    assert q.status == TaxQuoteStatus.QUOTED and q.tax_amount == Decimal("0.00")
    assert q.lines[0].outcome == TaxOutcome.ZERO_RATED and q.lines[0].explanation_code == "PROVIDER_ZERO_RATED"


# ── drift ───────────────────────────────────────────────────────────────

def test_drift_at_commit_is_review_required_and_not_issued(w):
    inv, q = provider_draft(w)
    w["provider"].remote_tax_delta = Decimal("0.01")
    assert finalize(w, inv).status == InvoiceStatus.DRAFT
    (row,) = rows(w, inv)
    assert row.state == OutboxState.REVIEW_REQUIRED and "tax" in row.review_reason


def test_drift_after_commit_raises_a_tenant_review_item(w):
    inv, q = provider_draft(w)
    finalize(w, inv)
    w["provider"].remote_tax_delta = Decimal("1.00")
    stats = issuance(w).reconcile()
    assert stats["drift"] == 1
    item = w["db"].query(TaxReviewItem).filter(TaxReviewItem.kind == ReviewItemKind.PROVIDER_DRIFT).one()
    assert item.organization_id == w["org"].id and "tax" in item.detail
    assert issuance(w).reconcile()["drift"] == 0                   # one open item, not one per run


# ── invoice-number seam (tax lead decides) ──────────────────────────────

def test_key_only_policy_links_the_invoice_number_after_commit(w, monkeypatch):
    monkeypatch.setattr("app.config.settings.TAX_PROVIDER_DOCUMENT_REFERENCE", DocumentReferencePolicy.KEY_ONLY.value)
    inv, q = provider_draft(w)
    finalize(w, inv)
    assert w["provider"].payloads[0]["document_reference"] == idempotency_key(q)
    link = [r for r in rows(w, inv) if r.operation == OutboxOperation.LINK]
    assert len(link) == 1 and link[0].state == OutboxState.PENDING
    issuance(w).reconcile()
    assert w["provider"].links == {rows(w, inv)[0].provider_transaction_id: inv.invoice_number}


def test_invoice_number_policy_sends_the_reserved_number(w, monkeypatch):
    monkeypatch.setattr("app.config.settings.TAX_PROVIDER_DOCUMENT_REFERENCE",
                        DocumentReferencePolicy.INVOICE_NUMBER.value)
    inv, q = provider_draft(w)
    finalize(w, inv)
    assert w["provider"].payloads[0]["document_reference"] == inv.invoice_number
    assert [r.operation for r in rows(w, inv)] == [OutboxOperation.COMMIT]


# ── email: nothing until SENT ───────────────────────────────────────────

def test_send_intent_is_emailed_exactly_once_after_issue(w, monkeypatch):
    """Fix 5: provider slow -> ISSUING; reconciliation finalizes -> exactly one email."""
    from app.modules.billing.models import BillingAuditLog

    sent = []
    monkeypatch.setattr("app.services.email_service.send_invoice_email", lambda **kw: sent.append(kw) or True)
    monkeypatch.setattr("app.modules.billing.services.pdf_service.generate_invoice_pdf", lambda *a, **kw: b"%PDF")
    inv, q = provider_draft(w)
    w["provider"].fail_mode = "timeout_after_success"
    result = invoice_service(w).send_invoice_via_email(inv.id, w["org"].id, w["maker"].id)
    assert result["status"] == "ISSUING" and result["email_delivered"] is False and sent == []
    commit_row = [r for r in rows(w, inv) if r.operation == OutboxOperation.COMMIT][0]
    assert commit_row.send_intent["channel"] == "email" and commit_row.send_intent["requested_by"] == w["maker"].id
    issuance(w).reconcile()
    issuance(w).reconcile()                                         # a second run never emails again
    w["db"].refresh(inv)
    assert inv.status == InvoiceStatus.SENT and len(sent) == 1 and w["provider"].commit_calls == 1
    (email_row,) = [r for r in rows(w, inv) if r.operation == OutboxOperation.EMAIL]
    assert email_row.state == OutboxState.DONE
    audit = w["db"].query(BillingAuditLog).filter(BillingAuditLog.entity_id == inv.id,
                                                  BillingAuditLog.entity_type == "Invoice").all()
    assert any((a.new_values or {}).get("provider_issue_email") == "delivered" for a in audit)


def test_interrupted_email_is_never_resent_automatically(w, monkeypatch):
    inv, q = provider_draft(w)
    w["provider"].fail_mode = "timeout_after_success"
    finalize(w, inv)
    issuance(w).request_send(inv.id, w["maker"].id)
    crash = issuance(w, mailer=lambda *a: (_ for _ in ()).throw(SystemExit("process killed")))
    with pytest.raises(SystemExit):
        crash.reconcile()
    w["db"].rollback()
    (email_row,) = [r for r in rows(w, inv) if r.operation == OutboxOperation.EMAIL]
    assert email_row.state == OutboxState.UNCERTAIN                # claimed before sending
    sent = []
    issuance(w, mailer=lambda *a: sent.append(a) or {"email_delivered": True}).reconcile()
    w["db"].refresh(email_row)
    assert sent == [] and email_row.state == OutboxState.REVIEW_REQUIRED and email_row.review_kind == "EMAIL_UNCERTAIN"


# ── T20: batch, idempotency, isolation ──────────────────────────────────

def test_t20_batch_issuance_is_idempotent_and_isolated(w):
    from tests.conftest import make_invoice, make_organization

    other = make_organization(w["db"], code="P4A-OTHER", name="Other tenant")
    bystander = make_invoice(w["db"], other.id, w["customer"].id, status=InvoiceStatus.DRAFT, invoice_number="OTH-1")
    w["db"].commit()
    svc = issuance(w)
    batch = [provider_draft(w, price=10 + n) for n in range(12)]
    for inv, q in batch:
        svc.begin(inv, q, w["maker"].id)                           # all queued, nothing delivered yet
    svc.reconcile()
    svc.reconcile()                                                # a second pass changes nothing
    keys = [idempotency_key(q) for _, q in batch]
    assert sorted(w["provider"].committed_keys()) == sorted(keys) and w["provider"].commit_calls == len(batch)
    for inv, q in batch:
        w["db"].refresh(inv)
        w["db"].refresh(q)
        assert inv.status == InvoiceStatus.SENT and inv.tax_amount == q.tax_amount
    assert {r.organization_id for r in rows(w)} == {w["org"].id}
    w["db"].refresh(bystander)
    assert bystander.status == InvoiceStatus.DRAFT


# ── operations: aggregate only (T13) ────────────────────────────────────

def test_platform_health_view_is_aggregate_only(w):
    inv, q = provider_draft(w)
    w["provider"].fail_mode = "timeout_after_success"
    finalize(w, inv)
    health = aggregate_health(w["db"])
    blob = json.dumps(health)
    for identifier in (inv.invoice_number, w["customer"].email, w["customer"].company_name,
                       idempotency_key(q), f'"organization_id"', f'"invoice_id"'):
        assert identifier not in blob
    (provider,) = health["providers"]
    assert provider["provider"] == "fake-provider" and provider["counts"] == {"UNCERTAIN": 1}
    assert provider["oldest_active_age_seconds"] is not None and health["reconciliation"]["last_ok"] is True


def test_reconciliation_writes_a_heartbeat(w):
    w["db"].query(TaxJobHeartbeat).delete()
    w["db"].commit()
    issuance(w).reconcile()
    hb = w["db"].get(TaxJobHeartbeat, "tax_provider_reconciliation")
    assert hb.last_ok is True and hb.last_finished_at is not None and set(hb.stats) >= {"delivered", "drift"}


# ── T16: a revoked registry source freezes the packs that depend on it ──

def test_t16_revoked_source_freezes_the_pack_with_no_false_coverage_claim(db_session):
    from app.modules.tax.enums import AcquisitionMethod, RedistributionPermission, SourceTier
    from app.modules.tax.registry_models import TaxAuthority
    from app.modules.tax.registry_service import TaxRegistryPipeline
    from app.modules.tax.rule_packs import UkVatDomesticServices
    from app.modules.tax.tenant_tax_service import TenantTaxService
    from tests import test_tax_phase3b_packs as p3b

    w = p3b.build_world(db_session, org_code="P4AT16")
    p3b.publish_pack(w, UkVatDomesticServices.code)
    p3b.govern(w, w["uk"])
    assert p3b.quote(w, p3b.draft(w, [(w["svc"], 100, 1)])).status == TaxQuoteStatus.QUOTED

    # The licence for S11 is withdrawn: a new revision records DENIED usage rights.
    pipeline = TaxRegistryPipeline(db_session)
    authority = db_session.query(TaxAuthority).filter(TaxAuthority.code == "GB-HMRC").one()
    revoked = pipeline.register_source_revision(
        actor_id=w["reviewer"].id, authority_id=authority.id, source_tier=SourceTier.OFFICIAL_GUIDANCE,
        acquisition_method=AcquisitionMethod.MANUAL_VERIFIED_EXTRACTION, permanent_url="https://example.test/S11",
        title="Fixture source S11", citation="Fixture citation [S11]", language="en", handoff_ref="S11")
    pipeline.attach_evidence(actor_id=w["reviewer"].id, revision_id=revoked.id, content=b"<p>S11 revoked</p>",
                             media_type="text/html", filename="S11.html",
                             redistribution_permission=RedistributionPermission.DENIED)
    db_session.commit()

    q = p3b.quote(w, p3b.draft(w, [(w["svc"], 100, 1)]))
    assert q.status == TaxQuoteStatus.NEEDS_EVIDENCE and q.refusal_code == "NOT_DETERMINED" and q.tax_amount is None
    report = TenantTaxService(db_session).regime_eligibility(w["org"].id, w["uk"].id, p3b.TAX_DATE)
    assert report["backing_activations"] == [] and report["would_qualify"] is False


# ═════════════════════════════════════════════════════════════════════════
# 4a-1 fixes (post-merge review of PR #132)
# ═════════════════════════════════════════════════════════════════════════

def at(**delta):
    """A fixed clock `delta` after now. Relative to the moment of the call, not
    to import time: in a full run a test may start long after collection."""
    moment = datetime.now(timezone.utc) + timedelta(**delta)
    return lambda: moment


def second_tenant(w, code):
    """Another GOVERNED tenant on the same platform data, routed to the same
    fake provider (fix 1: one tenant's broken row must not stop another's)."""
    from app.modules.auth.models import UserRole
    from app.modules.tax.enums import EntityTaxRegime, TaxOperatingMode, TransactionClass
    from app.modules.tax.legal_entity_service import LegalEntityService
    from app.modules.tax.tenant_tax_service import TenantTaxService
    from tests import test_tax_phase3a_governed as g
    from tests.conftest import make_organization

    db = w["db"]
    org = make_organization(db, code=code, name=f"Tenant {code}")
    entity = LegalEntityService(db).ensure_default_entity(org.id)
    entity.country_code, entity.tax_regime = "GB", EntityTaxRegime.GOVERNED
    t = {**w, "org": org, "entity": entity,
         "maker": g._user(db, f"maker@{code.lower()}.example", UserRole.BILLING_ADMIN, org.id),
         "checker": g._user(db, f"checker@{code.lower()}.example", UserRole.FINANCE_APPROVER, org.id)}
    from app.modules.tax.connection_service import ProviderConnectionService
    from app.modules.tax.enums import ProviderEnvironment
    from app.modules.tax.provider_contract import ProviderMode

    tenant = TenantTaxService(db)
    reg = tenant.create_registration(org.id, t["maker"].id, seller_entity_id=entity.id, jurisdiction_id=w["gb"].id,
                                     tax_type_id=w["vat"].id, registration_number=f"GB-{code}",
                                     valid_from=date(2020, 1, 1))
    connections = ProviderConnectionService(db)
    conn = connections.propose(org.id, t["maker"].id, seller_entity_id=entity.id, provider_name="fake-provider",
                               environment=ProviderEnvironment.SANDBOX, mode=ProviderMode.COMMIT)
    connections.set_credentials(org.id, t["maker"].id, conn.id, f"fake-credential-{code}")
    connections.decide(org.id, t["checker"].id, conn.id, approve=True)
    act = tenant.propose_activation(org.id, t["maker"].id, seller_entity_id=entity.id, jurisdiction_id=w["gb"].id,
                                    tax_type_id=w["vat"].id, transaction_class=TransactionClass.B2B_DIGITAL,
                                    mode=TaxOperatingMode.PROVIDER_APPROVED, effective_from=date(2025, 1, 1),
                                    registration_id=reg.id, provider_connection_id=conn.id)
    tenant.decide_activation(org.id, t["checker"].id, act.id, approve=True)
    t["dig_product"] = g.product(t, f"DIG{code}", "DIG")
    t["customer"] = g.buyer(t, verified=True, code=f"{code}C")
    db.commit()
    return t


# ── fix 1: poison-row isolation ─────────────────────────────────────────

def test_fix1_one_broken_row_never_stops_the_run(w):
    from app.modules.tax.provider_issuance import build_commit_payload

    b = second_tenant(w, "P4AB")
    inv_a, q_a = provider_draft(w)
    inv_b, q_b = provider_draft(b)

    def payload(db, quote_, row):
        if row.organization_id == w["org"].id:
            raise RuntimeError("corrupt row for tenant A")
        return build_commit_payload(db, quote_, row)

    svc = issuance(w, payload_builder=payload)
    row_a = svc.begin(inv_a, q_a, w["maker"].id)
    svc.begin(inv_b, q_b, b["maker"].id)
    stats = svc.reconcile()
    assert stats["row_failures"] == 1
    w["db"].refresh(inv_b)
    assert inv_b.status == InvoiceStatus.SENT                       # B issued despite A
    w["db"].refresh(row_a)
    assert row_a.state == OutboxState.REVIEW_REQUIRED and row_a.review_kind == "ROW_ERROR"
    assert "corrupt row for tenant A" in row_a.review_reason
    hb = w["db"].get(TaxJobHeartbeat, "tax_provider_reconciliation")
    assert hb.last_ok is True and hb.stats["row_failures"] == 1     # a row failure is not a job failure
    assert ProviderHealth(w["db"]).heartbeat_problem() is None


def test_fix1_job_level_failure_marks_the_heartbeat_not_ok(w, monkeypatch):
    svc = issuance(w)

    def broken(*criteria):
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(svc, "_ids", broken)
    svc.reconcile()
    hb = w["db"].get(TaxJobHeartbeat, "tax_provider_reconciliation")
    assert hb.last_ok is False
    assert "not running" in ProviderHealth(w["db"]).heartbeat_problem()


# ── fix 2: refusal vs ambiguous ─────────────────────────────────────────

def test_fix2_definite_refusal_fails_without_reconciling(w):
    inv, q = provider_draft(w)
    w["provider"].fail_mode = "commit_error"
    assert finalize(w, inv).status == InvoiceStatus.DRAFT
    (row,) = rows(w, inv)
    assert row.state == OutboxState.FAILED
    issuance(w).reconcile()
    assert w["provider"].commit_calls == 1 and w["provider"].ledger == {}
    w["db"].refresh(q)
    assert q.status == TaxQuoteStatus.PROVIDER_UNAVAILABLE
    inv.notes = "editable"                                           # FAILED releases the lock
    w["db"].commit()


@pytest.mark.parametrize("fault, commits", [("server_error", 2), ("ambiguous_after_success", 1)])
def test_fix2_ambiguous_errors_are_resolved_by_state_lookup(w, fault, commits):
    inv, q = provider_draft(w)
    w["provider"].fail_mode = fault
    assert finalize(w, inv).status == InvoiceStatus.DRAFT
    assert [r for r in rows(w, inv) if r.operation == OutboxOperation.COMMIT][0].state == OutboxState.UNCERTAIN
    issuance(w).reconcile()
    w["db"].refresh(inv)
    assert inv.status == InvoiceStatus.SENT
    assert w["provider"].commit_calls == commits and len(w["provider"].ledger) == 1


# ── fix 3: deadlines before commit ──────────────────────────────────────

def test_fix3_pending_row_is_never_committed_after_quote_expiry(w):
    from app.modules.tax.exception_service import TaxExceptionService

    inv, q = provider_draft(w)
    issuance(w).begin(inv, q, w["maker"].id)                         # crash before delivery
    issuance(w, now=at(hours=25)).reconcile()
    (row,) = rows(w, inv)
    assert row.state == OutboxState.CANCELLED and w["provider"].commit_calls == 0
    w["db"].refresh(q)
    assert q.status == TaxQuoteStatus.STALE and "Request a new tax quote" in q.stale_reason
    inv.notes = "editable again"                                     # unlocked as a DRAFT
    w["db"].commit()
    (item,) = TaxExceptionService(w["db"]).list_exceptions(w["org"].id)["items"]
    assert item["code"] == "QUOTE_STALE" and item["requote"]["path"] == "/api/v1/tax/quotes"


def test_fix3_not_found_after_expiry_is_cancelled_not_recommitted(w):
    inv, q = provider_draft(w)
    w["provider"].fail_mode = "timeout_before_success"
    finalize(w, inv)
    issuance(w, now=at(hours=25)).reconcile()
    (row,) = rows(w, inv)
    assert row.state == OutboxState.CANCELLED and w["provider"].commit_calls == 1 and w["provider"].ledger == {}


def test_fix3_unresolved_past_grace_is_review_required_never_voided(w):
    from app.modules.tax.exception_service import TaxExceptionService

    inv, q = provider_draft(w)
    w["provider"].fail = {"server_error", "state_error"}             # persistent
    finalize(w, inv)
    issuance(w, now=at(minutes=20)).reconcile()
    (row,) = rows(w, inv)
    assert row.state == OutboxState.REVIEW_REQUIRED and row.review_kind == "UNRESOLVED_COMMIT"
    assert w["provider"].void_calls == 0
    inv.notes = "edit"
    with pytest.raises(ProviderIssuanceBlocked):                     # still locked while unresolved
        w["db"].flush()
    w["db"].rollback()
    (item,) = TaxExceptionService(w["db"], now=at(minutes=20)).list_exceptions(w["org"].id)["items"]
    assert item["code"] == "PROVIDER_REVIEW_REQUIRED" and item["owner"] == "org_admin"
    assert item["age_seconds"] >= 19 * 60


@pytest.mark.parametrize("landed", [True, False])
def test_fix3_multi_hour_outage(w, landed):
    inv, q = provider_draft(w)
    w["provider"].fail_mode = "timeout_after_success" if landed else "server_error"
    finalize(w, inv)
    w["provider"].fail = {"state_error"}                             # the provider is down for hours
    w["provider"].once = set()
    for minutes in (5, 20, 60, 120, 180):
        issuance(w, now=at(minutes=minutes)).reconcile()
    (row,) = [r for r in rows(w, inv) if r.operation == OutboxOperation.COMMIT]
    assert row.state == OutboxState.REVIEW_REQUIRED and row.review_kind == "UNRESOLVED_COMMIT"
    assert w["provider"].void_calls == 0 and w["provider"].commit_calls == 1
    w["provider"].fail = set()                                        # recovered
    issuance(w, now=at(minutes=185)).reconcile()
    w["db"].refresh(row)
    w["db"].refresh(inv)
    if landed:
        assert inv.status == InvoiceStatus.SENT and row.state == OutboxState.DONE
    else:
        assert inv.status == InvoiceStatus.DRAFT and row.state == OutboxState.CANCELLED
    assert w["provider"].commit_calls == 1 and w["provider"].void_calls == 0


# ── fix 4: the place-of-supply address goes in the payload ──────────────

def test_fix4_payload_sends_the_quoted_place_of_supply_address(w):
    from app.modules.tax.buyer_evidence_service import BuyerEvidenceService
    from app.modules.tax.enums import AddressRole
    from app.modules.tax.provider_contract import ALLOWED_COMMIT_FIELDS

    BuyerEvidenceService(w["db"]).record_address(
        w["org"].id, w["maker"].id, w["customer"].id, role=AddressRole.BILLING, country_code="GB",
        subdivision_code="ENG", postal_code="SW1A 1AA", city="London", line1="10 Downing Street", line2="Floor 2")
    w["db"].commit()
    inv, q = provider_draft(w)
    assert q.supply_address["role"] == "BILLING_FALLBACK" and q.supply_address["line1"] == "10 Downing Street"
    finalize(w, inv)
    payload = w["provider"].payloads[0]
    assert set(payload) <= ALLOWED_COMMIT_FIELDS
    expected = {k: v for k, v in q.supply_address.items() if k != "address_id"}
    assert payload["buyer"]["address"] == expected and expected["line2"] == "Floor 2"


# ── fix 6: unverified commits are verified on the next run ──────────────

def test_fix6_unverified_commit_is_verified_regardless_of_the_drift_window(w):
    inv, q = provider_draft(w)
    w["provider"].fail_mode = "state_error"                          # the lookup right after commit fails
    assert finalize(w, inv).status == InvoiceStatus.SENT
    (row,) = [r for r in rows(w, inv) if r.operation == OutboxOperation.COMMIT]
    assert row.verified_at is None and row.remote_snapshot["verified"] is False
    w["provider"].remote_tax_delta = Decimal("0.50")
    stats = issuance(w, now=at(hours=48)).reconcile()                # well outside the 24h window
    w["db"].refresh(row)
    assert row.state == OutboxState.DONE and row.verified_at is not None and row.remote_snapshot["verified"] is True
    assert stats["verified"] == 1 and stats["drift"] == 1
    assert w["db"].query(TaxReviewItem).filter(TaxReviewItem.kind == ReviewItemKind.PROVIDER_DRIFT).count() == 1
    assert issuance(w, now=at(hours=72)).reconcile()["verified"] == 0   # verified once, then out of the window
