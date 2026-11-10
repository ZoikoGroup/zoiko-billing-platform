"""ZB-TAX-ARCH-001 Phase 8 PR 3: emergency rollback (handoff §10.3) for
effective-dated packs (the tax date picks the version) and clock-switched
market availability."""
from datetime import date, datetime, timezone
from decimal import Decimal

import pytest

from app.config import settings
from app.core.exceptions import BadRequestException
from app.modules.auth.models import PlatformRole, UserRole
from app.modules.billing.models import Invoice
from app.modules.super_admin.models import AttentionItem, AttentionSeverity, AttentionStatus, PlatformAuditLog
from app.modules.tax import rule_pack_integrity as rpi
from app.modules.tax import rule_pack_retention as retention
from app.modules.tax.engines import RULE_PACK_VERSIONS, RULE_PACKS
from app.modules.tax.enums import (
    PlatformVersionStatus as S, ReviewItemKind, TaxOperatingMode, TaxQuoteStatus, TransactionClass,
)
from app.modules.tax.issuance_gate import TaxIssuanceBlocked
from app.modules.tax.models import TaxReviewItem
from app.modules.tax.policy_models import TaxMarketAvailabilityVersion, TaxRollbackRequest, TaxRulePackVersion
from app.modules.tax.policy_service import MarketAvailabilityService, RulePackService, view_rule_pack
from app.modules.tax.quote_models import TaxQuote
from app.modules.tax.registry_service import MakerCheckerError, RegistryImmutabilityError, RegistryStateError
from app.modules.tax import rollback_service as rb
from app.modules.tax.rollback_service import RollbackService
from app.modules.tax.rule_packs import UkVatDomesticServices
from tests.privacy.test_tax_phase8_scheduled_activation import approved_pack, published_pack
from tests.test_tax_phase3b_packs import GATES, _user, build_world, draft, govern, issue, quote

UTC = timezone.utc
V_START = date(2031, 1, 1)
CODE = UkVatDomesticServices.code


class UkV2(UkVatDomesticServices):
    version = "2"


class UkV3(UkVatDomesticServices):
    version = "3"


@pytest.fixture(autouse=True)
def _fresh_hashes():
    rpi.clear_cache()
    yield
    rpi.clear_cache()


@pytest.fixture()
def packs(monkeypatch):
    for cls in (UkV2, UkV3):
        monkeypatch.setitem(RULE_PACK_VERSIONS, (CODE, cls.version), cls)
    monkeypatch.setitem(RULE_PACKS, CODE, UkV3)


@pytest.fixture()
def emails(monkeypatch):
    sent = []
    from app.modules.notifications import service as notifications

    monkeypatch.setattr(notifications, "dispatch_email", lambda **kw: sent.append(kw))
    return sent


@pytest.fixture()
def w(db_session, packs):
    w = build_world(db_session, org_code="P8R")
    w["publisher2"] = _user(db_session, "pub2@p8r.example", UserRole.SUPER_ADMIN, platform_role=PlatformRole.TAX_PUBLISHER)
    w["p"] = published_pack(w, version="1")                      # P: in force from the start
    w["v"] = published_pack(w, valid_from=V_START, version="2")    # V: from 1 Jan 2031
    govern(w, w["uk"])
    return w


def at(moment):
    return lambda: moment


def propose(w, **kw):
    args = {"actor_id": w["publisher"].id, "kind": "rule_pack", "version_id": w["v"].id, "restore_to_id": w["p"].id,
            "reason": "V charges the wrong rate", "severity": "SEV1"}
    args.update(kw)
    return RollbackService(w["db"]).propose(**args)


def approve(w, request, when=datetime(2031, 3, 1, 12, 0, tzinfo=UTC), monkeypatch=None):
    if monkeypatch is not None:
        monkeypatch.setattr(rb, "utcnow", at(when))
    return RollbackService(w["db"]).decide(actor_id=w["publisher2"].id, request_id=request.id, approve=True)


def q(w, day, price=100):
    return quote(w, draft(w, [(w["svc"], price, 1)], tax_date=day))


# ── T03 / T04: the rolled-back range fails closed; nothing issued changes ──

def test_t03_t04_rollback_restores_p_from_today_and_fails_closed_before(w, monkeypatch, emails):
    db, v, p = w["db"], w["v"], w["p"]
    committed_inv = draft(w, [(w["svc"], 100, 1)], tax_date=date(2031, 2, 1))
    committed = quote(w, committed_inv)
    assert committed.rule_pack_version_id == v.id
    issue(w, committed_inv)
    db.refresh(committed)
    lines_before = [(l.tax_amount, l.effective_rate) for l in committed.lines]
    open_in, open_after = q(w, date(2031, 2, 10)), q(w, date(2031, 3, 5))

    request = propose(w)
    assert request.regression["cases"] >= 0 and request.regression["errors"] == []
    approve(w, request, monkeypatch=monkeypatch)
    db.expire_all()
    v, request = db.get(TaxRulePackVersion, v.id), db.get(TaxRollbackRequest, request.id)
    r = db.get(TaxRulePackVersion, request.result["rollback_version_id"])

    assert v.status == S.ROLLED_BACK and v.valid_to == date(2031, 3, 1)
    assert (r.status, r.valid_from, r.code_version, r.code_hash) == (S.ACTIVE, date(2031, 3, 1), "1", p.code_hash)
    assert (r.restores_id, r.rollback_of_id) == (p.id, v.id) and r.version == f"1-rb{request.id}"
    assert view_rule_pack(r)["integrity"] == rpi.MATCH
    assert request.result["range_from"] == "2031-01-01" and request.result["range_to"] == "2031-03-01"

    before = q(w, date(2030, 12, 31))
    assert (before.status, before.rule_pack_version_id) == (TaxQuoteStatus.QUOTED, p.id)       # before V: P
    refused = q(w, date(2031, 2, 15))
    assert refused.status == TaxQuoteStatus.UNSUPPORTED and refused.refusal_code == "RULE_PACK_ROLLED_BACK"
    assert not refused.lines and refused.tax_amount is None                                      # fail closed
    after = q(w, date(2031, 3, 1))
    assert (after.rule_pack_version_id, after.engine_version) == (r.id, "1")                     # R runs P's code

    db.refresh(open_in)
    db.refresh(open_after)
    assert open_in.status == open_after.status == TaxQuoteStatus.STALE
    assert "can't be calculated" in open_in.stale_reason and "re-quote" in open_after.stale_reason
    assert (request.result["open_quotes_stale"], request.result["open_quotes_not_determined"]) == (1, 1)
    assert request.result["committed_quotes_for_analysis"] == 1                                 # for PR 4

    db.refresh(committed)                                                                        # T04
    assert committed.status == TaxQuoteStatus.COMMITTED
    assert [(l.tax_amount, l.effective_rate) for l in committed.lines] == lines_before
    inv = db.get(Invoice, committed_inv.id)
    assert inv.tax_amount == Decimal("20.00") and inv.tax_quote_id == committed.id


def test_t03_boundary_at_local_midnight(w, monkeypatch):
    request = propose(w, severity="SEV2")
    approve(w, request, when=datetime(2031, 6, 1, 23, 30, tzinfo=UTC), monkeypatch=monkeypatch)   # 00:30 BST, 2 June
    r = w["db"].get(TaxRulePackVersion, request.result["rollback_version_id"])
    assert r.valid_from == date(2031, 6, 2)
    assert q(w, date(2031, 6, 1)).refusal_code == "RULE_PACK_ROLLED_BACK"
    assert q(w, date(2031, 6, 2)).rule_pack_version_id == r.id


def test_issuing_a_quote_made_with_v_before_the_rollback_is_blocked(w, monkeypatch):
    inv = draft(w, [(w["svc"], 100, 1)], tax_date=date(2031, 4, 1))
    quote(w, inv)
    approve(w, propose(w), monkeypatch=monkeypatch)
    with pytest.raises(TaxIssuanceBlocked):
        issue(w, inv)


# ── quarantine only: V is already followed by W ─────────────────────────

def test_quarantine_leaves_w_serving_and_refuses_v_range(w, monkeypatch):
    db = w["db"]
    wv = published_pack(w, valid_from=date(2032, 1, 1), version="3")
    db.refresh(w["v"])
    assert w["v"].valid_to == date(2032, 1, 1)
    with pytest.raises(RegistryStateError, match="already followed by v3"):
        propose(w)                                                                   # a restore needs open-ended V
    with pytest.raises(RegistryStateError, match="current version"):
        propose(w, version_id=wv.id, restore_to_id=None)                              # open-ended needs a restore
    request = propose(w, restore_to_id=None, severity="SEV3")
    approve(w, request, monkeypatch=monkeypatch)
    db.expire_all()
    assert db.get(TaxRulePackVersion, w["v"].id).status == S.ROLLED_BACK
    assert db.get(TaxRulePackVersion, wv.id).status == S.ACTIVE and db.get(TaxRulePackVersion, wv.id).valid_to is None
    assert request.result["quarantine_only"] is True and "rollback_version_id" not in request.result
    assert (request.result["range_from"], request.result["range_to"]) == ("2031-01-01", "2032-01-01")
    assert q(w, date(2031, 6, 1)).refusal_code == "RULE_PACK_ROLLED_BACK"
    assert q(w, date(2032, 2, 1)).rule_pack_version_id == wv.id                     # W untouched
    assert q(w, date(2030, 6, 1)).rule_pack_version_id == w["p"].id


# ── P's fitness, integrity and the regression report ────────────────────

def test_a_tampered_or_missing_p_module_is_refused_at_proposal_and_approval(w, monkeypatch):
    real = rpi._read_module
    monkeypatch.setattr(rpi, "_read_module", lambda name: real(name) + ("\n# drift\n" if "gb_vat" in name else ""))
    rpi.clear_cache()
    with pytest.raises(RegistryStateError, match="isn't fit to use today"):
        propose(w)
    monkeypatch.setattr(rpi, "_read_module", real)
    rpi.clear_cache()
    request = propose(w)
    monkeypatch.delitem(RULE_PACK_VERSIONS, (CODE, "1"))                         # a deploy removed P's module
    with pytest.raises(RegistryStateError, match="not the pack registered in code|code is"):
        approve(w, request, monkeypatch=monkeypatch)
    assert w["db"].get(TaxRollbackRequest, request.id).status == "PROPOSED"


def test_p_must_still_validate_today(w, monkeypatch):
    from app.modules.tax import policy_service

    real = policy_service.source_dependency_status
    monkeypatch.setattr(policy_service, "source_dependency_status",
                        lambda db, ref: {**real(db, ref), "approved": False, "reason": "usage rights revoked"})
    with pytest.raises(RegistryStateError, match="Source S11 is not approved"):
        propose(w)


def test_regression_report_is_attached_and_run_errors_block(w, monkeypatch):
    request = propose(w)
    assert {"cases", "changed", "errors", "fixture_hash"} <= set(request.regression)
    from app.modules.tax.regression import runner

    monkeypatch.setattr(runner, "compare_packs", lambda *a, **k: {"cases": 1, "changed": [], "errors": ["gb-1"]})
    with pytest.raises(RegistryStateError, match="regression run of the version to restore has errors: gb-1"):
        approve(w, request, monkeypatch=monkeypatch)


# ── two people, MFA, finality, one open request ─────────────────────────

def test_two_person_rule_and_finality(w, monkeypatch):
    db = w["db"]
    request = propose(w)
    with pytest.raises(RegistryStateError, match="already waiting"):
        propose(w)
    with pytest.raises(MakerCheckerError):
        RollbackService(db).decide(actor_id=w["publisher"].id, request_id=request.id, approve=True)
    with pytest.raises(BadRequestException, match="reason"):
        RollbackService(db).decide(actor_id=w["publisher2"].id, request_id=request.id, approve=False)
    with pytest.raises(BadRequestException, match="SEV1"):
        propose(w, severity="SEV9")
    RollbackService(db).decide(actor_id=w["publisher2"].id, request_id=request.id, approve=False, reason="not needed")
    db.commit()
    with pytest.raises(RegistryStateError, match="already REJECTED"):
        approve(w, request, monkeypatch=monkeypatch)
    request.reason = "edited"
    with pytest.raises(RegistryImmutabilityError):
        db.flush()
    db.rollback()
    second = propose(w)
    with pytest.raises(MakerCheckerError):
        RollbackService(db).withdraw(actor_id=w["publisher2"].id, request_id=second.id)
    assert RollbackService(db).withdraw(actor_id=w["publisher"].id, request_id=second.id).status == "WITHDRAWN"


def test_rolled_back_version_is_immutable(w, monkeypatch):
    db = w["db"]
    approve(w, propose(w), monkeypatch=monkeypatch)
    v = db.get(TaxRulePackVersion, w["v"].id)
    v.approved_at = datetime(2020, 1, 1, tzinfo=UTC)                  # not content: the status rule applies
    with pytest.raises(RegistryImmutabilityError, match="rolled_back and immutable"):
        db.flush()
    db.rollback()


def test_http_rollback_needs_mfa_and_a_different_publisher(w, client_for, monkeypatch):
    base = "/api/v1/super-admin/tax-registry"
    body = {"kind": "rule_pack", "version_id": w["v"].id, "restore_to_id": w["p"].id, "reason": "wrong rate",
            "severity": "SEV1"}
    assert client_for(w["reviewer"]).post(f"{base}/rollbacks", json=body).status_code == 403   # publishers only
    created = client_for(w["publisher"]).post(f"{base}/rollbacks", json=body)
    assert created.status_code == 201, created.text
    rid = created.json()["id"]
    cands = client_for(w["reviewer"]).get(f"{base}/rollbacks/candidates",
                                          params={"kind": "rule_pack", "version_id": w["v"].id}).json()
    assert [c["id"] for c in cands["items"]] == [w["p"].id] and cands["items"][0]["integrity"] == "MATCH"
    inbox = client_for(w["publisher2"]).get(f"{base}/approvals-inbox").json()
    entry = next(i for i in inbox["items"] if i["kind"] == "rollback")
    assert entry["id"] == rid and entry["can_approve"] and entry["severity"] == "SEV1"
    missing = client_for(w["publisher2"]).post(f"{base}/rollbacks/{rid}/approve", json={})
    assert missing.json()["error"] == "TAX_REGISTRY_STEP_UP_REQUIRED"
    monkeypatch.setattr(settings, "TAX_REGISTRY_STEP_UP_REQUIRED", False)
    monkeypatch.setattr(rb, "utcnow", at(datetime(2031, 3, 1, 12, 0, tzinfo=UTC)))
    assert client_for(w["publisher"]).post(f"{base}/rollbacks/{rid}/approve", json={}).status_code == 403
    done = client_for(w["publisher2"]).post(f"{base}/rollbacks/{rid}/approve", json={})
    assert done.status_code == 200 and done.json()["status"] == "APPROVED"
    assert client_for(w["reviewer"]).get(f"{base}/rollbacks").json()["items"][0]["id"] == rid


# ── a pending schedule is cancelled inside the approval ─────────────────

def test_pending_schedule_needs_acknowledgement_and_is_cancelled_by_approval(w, monkeypatch):
    db = w["db"]
    scheduled = published_pack(w, valid_from=date(2032, 1, 1), version="3", activate_at_local="2030-06-01T09:00",
                               timezone="Europe/London")
    assert scheduled.status == S.SCHEDULED
    with pytest.raises(RegistryStateError, match=f"Version {scheduled.id} is scheduled"):
        propose(w)
    request = propose(w, cancel_schedule=True)
    approve(w, request, monkeypatch=monkeypatch)
    db.expire_all()
    s = db.get(TaxRulePackVersion, scheduled.id)
    assert s.status == S.APPROVED and s.activate_at is None
    assert request.result["cancelled_schedule_id"] == scheduled.id
    audit = [a.metadata_ or {} for a in db.query(PlatformAuditLog).filter(
        PlatformAuditLog.entity_type == "TaxRulePackVersion", PlatformAuditLog.entity_id == scheduled.id)]
    assert any(m.get("activation_cancel") == "cancelled_by_rollback" and m.get("rollback_request_id") == request.id
               for m in audit)


# ── availability: immediate ─────────────────────────────────────────────

def test_availability_rollback_is_immediate(w, monkeypatch, emails):
    db = w["db"]
    svc = MarketAvailabilityService(db)
    p = svc.current_for(svc.draft(actor_id=w["reviewer"].id, jurisdiction_id=w["gb"]["jurisdiction"].id,
                                  tax_type_id=w["gb"]["tax_type"].id, transaction_class=TransactionClass.B2C_SERVICES,
                                  mode=TaxOperatingMode.SUSPENDED, gates=GATES))
    v = db.query(TaxMarketAvailabilityVersion).filter(TaxMarketAvailabilityVersion.status == S.PENDING_REVIEW).one()
    svc.validate(actor_id=w["reviewer"].id, version_id=v.id)
    svc.submit(actor_id=w["reviewer"].id, version_id=v.id, reason="suspend")
    svc.approve(actor_id=w["publisher"].id, version_id=v.id)
    svc.publish(actor_id=w["publisher"].id, version_id=v.id)
    db.commit()
    assert q(w, date(2026, 6, 1)).status != TaxQuoteStatus.QUOTED                        # suspended
    request = propose(w, kind="market_availability", version_id=v.id, restore_to_id=p.id, severity="SEV2")
    approve(w, request, monkeypatch=monkeypatch)
    db.expire_all()
    r = db.get(TaxMarketAvailabilityVersion, request.result["rollback_version_id"])
    assert r.status == S.ACTIVE and r.mode == TaxOperatingMode.NATIVE_RULEPACK_APPROVED and r.restores_id == p.id
    assert db.get(TaxMarketAvailabilityVersion, v.id).status == S.ROLLED_BACK
    assert q(w, date(2026, 6, 1)).status == TaxQuoteStatus.QUOTED                        # immediately calculating
    assert request.result["organizations_affected"] == 1 and emails


# ── outputs: aggregate alert; tenants see their own ─────────────────────

def test_alert_is_aggregate_and_tenants_get_their_own_review_item_and_email(w, monkeypatch, emails):
    db = w["db"]
    q(w, date(2031, 2, 10))
    request = propose(w, severity="SEV1")
    approve(w, request, monkeypatch=monkeypatch)
    item = db.query(AttentionItem).filter(AttentionItem.source_key == f"tax:tax.rollback_applied:{request.id}",
                                          AttentionItem.status == AttentionStatus.OPEN).one()
    assert item.severity == AttentionSeverity.P1
    assert "2031-01-01 to 2031-03-01" in item.description and "1 organizations affected" in item.description
    org = w["org"]
    for secret in (org.organization_name, org.organization_code, "P3B-", w["admin"].email, f"organization {org.id}"):
        assert secret not in item.description and secret not in item.title
    review = db.query(TaxReviewItem).filter(TaxReviewItem.organization_id == w["org"].id,
                                            TaxReviewItem.kind == ReviewItemKind.TAX_ROLLBACK_APPLIED).one()
    assert review.due_date == date(2031, 3, 1) and "can't be calculated" in review.detail     # SEV1: due today
    mails = [e for e in emails if e["template_id"] == "ZB-TAX-001"]
    assert [m["recipient_email"] for m in mails] == [w["admin"].email]
    assert mails[0]["context"]["urgency"] == "Action needed today."
    assert "20.00" not in str(mails[0]["context"]) and "100" not in str(mails[0]["context"])   # no amounts
    from app.modules.notifications.templates.zb_tax import RENDERERS

    subject, html = RENDERERS["ZB-TAX-001"](mails[0]["context"])
    assert "rolled back" in subject and "Issued invoices are not changed" in html


# ── code retention ──────────────────────────────────────────────────────

def test_retention_manifest_checks(w):
    good = rpi.compute_hash(UkVatDomesticServices)
    manifest = retention.load_manifest('{"versions": [{"code": "%s", "version": "1", "code_hash": "%s"}]}' % (CODE, good))
    assert retention.code_problems(manifest) == []
    wrong = retention.load_manifest('{"versions": [{"code": "%s", "version": "1", "code_hash": "%s"}]}' % (CODE, "0" * 64))
    assert "hash differs" in retention.code_problems(wrong)[0]
    gone = retention.load_manifest('{"versions": [{"code": "%s", "version": "9", "code_hash": "x"}]}' % CODE)
    assert "no longer ships" in retention.code_problems(gone)[0]
    retired = retention.load_manifest('{"versions": [{"code": "%s", "version": "9", "code_hash": "x", "retired": "r"}]}'
                                      % CODE)
    assert retention.code_problems(retired) == []
    assert retention.removed_entries(manifest, retention.load_manifest('{"versions": []}')) == [f"{CODE} v1"]


def test_publish_gate_and_runtime_retention_check(w, monkeypatch):
    db = w["db"]
    monkeypatch.setattr(settings, "TAX_RULE_PACK_RETENTION_REQUIRED", True)
    row = approved_pack(w, valid_from=date(2032, 1, 1), version="3")
    db.commit()
    with pytest.raises(RegistryStateError, match="not in rule_packs/retention.json"):
        RulePackService(db).publish(actor_id=w["publisher"].id, version_id=row.id)
    db.rollback()
    listed = {(CODE, "3"): {"code": CODE, "version": "3", "code_hash": row.code_hash}}
    monkeypatch.setattr(retention, "load_manifest", lambda text=None: dict(listed))
    RulePackService(db).publish(actor_id=w["publisher"].id, version_id=row.id)
    assert row.status == S.ACTIVE
    assert rpi.check_active(db) == []
    listed[(CODE, "3")] = {**listed[(CODE, "3")], "retired": "no longer needed"}                 # retired too early
    assert {"code": CODE, "version": "3", "integrity": rpi.RETIRED} in rpi.check_active(db)
    monkeypatch.delitem(RULE_PACK_VERSIONS, (CODE, "2"))                                        # V's module removed
    assert {"code": CODE, "version": "2", "integrity": rpi.CODE_MISSING} in rpi.check_active(db)


def test_r_keeps_p_module_required(w, monkeypatch):
    db = w["db"]
    approve(w, propose(w), monkeypatch=monkeypatch)
    monkeypatch.delitem(RULE_PACK_VERSIONS, (CODE, "1"))                                        # P's module removed
    failures = rpi.check_active(db)
    assert any(f["integrity"] == rpi.CODE_MISSING and f["version"].startswith("1-rb") for f in failures)
