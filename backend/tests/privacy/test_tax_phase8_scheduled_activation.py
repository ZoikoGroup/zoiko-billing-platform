"""ZB-TAX-ARCH-001 Phase 8 PR 2: scheduled activation (step 07).

Decision (approved with the plan): rule packs are effective-dated, so the
quote's tax date picks the version in force (T03/T17); market availability
switches at activate_at regardless of tax date.
"""
from datetime import date, datetime, timezone

import pytest

from app.core.exceptions import BadRequestException, ForbiddenException
from app.modules.auth.models import PlatformRole, UserRole
from app.modules.super_admin.models import AttentionItem, AttentionSeverity, AttentionStatus, PlatformAuditLog
from app.modules.tax import monitoring
from app.modules.tax import rule_pack_integrity as rpi
from app.modules.tax.activation import ALERT_KEY, activate_due, local_to_utc
from app.modules.tax.engines import RULE_PACK_VERSIONS, RULE_PACKS
from app.modules.tax.enums import PlatformVersionStatus, TaxOperatingMode, TaxQuoteStatus, TransactionClass
from app.modules.tax.issuance_gate import TaxIssuanceBlocked
from app.modules.tax.policy_models import TaxActivationCancellation, TaxRulePackVersion
from app.modules.tax.policy_service import (
    ActivationCancellationService, MarketAvailabilityService, RulePackService, view_availability, view_rule_pack,
)
from app.modules.tax.registry_service import MakerCheckerError, RegistryStateError
from app.modules.tax.rule_packs import UkVatDomesticServices
from tests.test_tax_phase3b_packs import GATES, GOLDEN, _user, build_world, draft, govern, issue, quote

UTC = timezone.utc
BOUNDARY = date(2031, 1, 1)                         # far enough ahead that "now" is always before it


class UkVatV2(UkVatDomesticServices):
    """A second version of the UK pack, as a deploy would ship it beside v1."""
    version = "2"


@pytest.fixture(autouse=True)
def _fresh_hashes():
    rpi.clear_cache()
    yield
    rpi.clear_cache()


@pytest.fixture()
def w(db_session):
    w = build_world(db_session, org_code="P8S")
    w["publisher2"] = _user(db_session, "pub2@p8s.example", UserRole.SUPER_ADMIN, platform_role=PlatformRole.TAX_PUBLISHER)
    return w


@pytest.fixture()
def v2(monkeypatch):
    monkeypatch.setitem(RULE_PACK_VERSIONS, (UkVatV2.code, "2"), UkVatV2)
    monkeypatch.setitem(RULE_PACKS, UkVatV2.code, UkVatV2)
    return UkVatV2


def approved_pack(w, valid_from=None, version=None):
    svc = RulePackService(w["db"])
    row = svc.register(actor_id=w["reviewer"].id, code=UkVatDomesticServices.code, valid_from=valid_from,
                       version=version)
    svc.amend(actor_id=w["reviewer"].id, version_id=row.id, changes={"golden_test_report": GOLDEN})
    svc.validate(actor_id=w["reviewer"].id, version_id=row.id)
    assert row.validation_errors is None, row.validation_errors
    svc.submit(actor_id=w["reviewer"].id, version_id=row.id, reason="pilot")
    svc.approve(actor_id=w["publisher"].id, version_id=row.id)
    return row


def published_pack(w, valid_from=None, version=None, **schedule):
    row = approved_pack(w, valid_from, version)
    RulePackService(w["db"]).publish(actor_id=w["publisher"].id, version_id=row.id, **schedule)
    w["db"].commit()
    return row


def at(year, month, day, hour=0, minute=0):
    return lambda: datetime(year, month, day, hour, minute, tzinfo=UTC)


def item(db, key):
    return db.query(AttentionItem).filter(
        AttentionItem.source_key == f"tax:{key}",
        AttentionItem.status.in_([AttentionStatus.OPEN, AttentionStatus.ACKNOWLEDGED])).first()


# ── local time -> UTC (T17) ─────────────────────────────────────────────

def test_local_time_conversion_handles_dst_gaps_and_overlaps():
    assert local_to_utc("2030-06-01T09:00", "Europe/London") == datetime(2030, 6, 1, 8, 0, tzinfo=UTC)       # BST
    assert local_to_utc("2030-01-01T00:00", "Australia/Sydney") == datetime(2029, 12, 31, 13, 0, tzinfo=UTC)  # AEDT
    with pytest.raises(BadRequestException, match="does not exist"):
        local_to_utc("2030-03-31T01:30", "Europe/London")                                 # spring-forward gap
    with pytest.raises(BadRequestException, match="happens twice.*\\+01:00 or \\+00:00"):
        local_to_utc("2030-10-27T01:30", "Europe/London")                                 # autumn overlap
    assert local_to_utc("2030-10-27T01:30", "Europe/London", "+00:00") == datetime(2030, 10, 27, 1, 30, tzinfo=UTC)
    assert local_to_utc("2030-10-27T01:30", "Europe/London", "+01:00") == datetime(2030, 10, 27, 0, 30, tzinfo=UTC)
    assert local_to_utc("2032-02-29T00:00", "UTC") == datetime(2032, 2, 29, tzinfo=UTC)                       # leap day
    with pytest.raises(BadRequestException, match="IANA"):
        local_to_utc("2030-01-01T00:00", "Mars/Olympus")


# ── effective-dated packs (T03) ─────────────────────────────────────────

def test_t03_the_tax_date_picks_the_pack_version(w, v2):
    db = w["db"]
    v1 = published_pack(w, version="1")
    govern(w, w["uk"])
    early = draft(w, [(w["svc"], 100, 1)], tax_date=date(2030, 12, 31))
    late = draft(w, [(w["svc"], 100, 1)], tax_date=BOUNDARY)
    q_late_before = quote(w, late)                                     # quoted while v1 is open-ended
    assert q_late_before.rule_pack_version_id == v1.id

    second = published_pack(w, valid_from=BOUNDARY)                    # published now, in force from 1 Jan
    db.refresh(v1)
    assert v1.status == PlatformVersionStatus.ACTIVE and v1.valid_to == BOUNDARY and second.predecessor_id == v1.id

    q_early = quote(w, early)
    assert (q_early.engine_version, q_early.rule_pack_version_id) == ("1", v1.id)       # old rules for 31 Dec
    q_late = quote(w, draft(w, [(w["svc"], 100, 1)], tax_date=BOUNDARY))
    assert (q_late.engine_version, q_late.rule_pack_version_id) == ("2", second.id)
    assert q_early.status == q_late.status == TaxQuoteStatus.QUOTED

    issue(w, early)                                                    # still in force for its date: not STALE
    with pytest.raises(TaxIssuanceBlocked, match="rule pack changed"):
        issue(w, late)                                                 # 1 Jan quoted under v1: re-quote
    view = view_rule_pack(v1)
    assert view["valid_to"] == BOUNDARY and view["integrity"] == rpi.MATCH


def test_t17_a_version_can_start_on_a_leap_day(w, v2):
    published_pack(w, version="1")
    leap = published_pack(w, valid_from=date(2032, 2, 29))
    govern(w, w["uk"])
    assert quote(w, draft(w, [(w["svc"], 100, 1)], tax_date=date(2032, 2, 28))).engine_version == "1"
    assert quote(w, draft(w, [(w["svc"], 100, 1)], tax_date=date(2032, 2, 29))).rule_pack_version_id == leap.id


def test_a_version_cannot_start_before_the_one_it_follows(w, v2):
    db = w["db"]
    published_pack(w, valid_from=date(2031, 6, 1), version="1")
    early = approved_pack(w, valid_from=date(2031, 1, 1))
    with pytest.raises(RegistryStateError, match="would start before v1"):
        RulePackService(db).publish(actor_id=w["publisher"].id, version_id=early.id)
    db.rollback()


def test_same_start_is_a_full_replacement(w, v2):
    db = w["db"]
    v1 = published_pack(w, version="1")
    fix = published_pack(w)                                            # a bug fix with the same (open) start
    db.refresh(v1)
    assert v1.status == PlatformVersionStatus.SUPERSEDED and fix.status == PlatformVersionStatus.ACTIVE
    assert v1.valid_to is None


def test_retroactive_pack_versions_wait_for_pr4(w, v2, monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "TAX_RETRO_PREVIEW_REQUIRED", True)      # PR 4: allowed only with a preview
    db = w["db"]
    published_pack(w, version="1")
    retro = approved_pack(w, valid_from=date(2020, 1, 1))
    with pytest.raises(RegistryStateError, match="retroactive"):
        RulePackService(db).publish(actor_id=w["publisher"].id, version_id=retro.id)
    db.rollback()


# ── scheduling and the job ──────────────────────────────────────────────

def test_scheduled_version_activates_at_its_time_once(w, v2):
    db = w["db"]
    v1 = published_pack(w, version="1")
    second = published_pack(w, valid_from=BOUNDARY, activate_at_local="2030-06-01T09:00", timezone="Europe/London")
    assert second.status == PlatformVersionStatus.SCHEDULED
    assert second.activate_at.replace(tzinfo=UTC) == datetime(2030, 6, 1, 8, 0, tzinfo=UTC)
    assert view_rule_pack(second)["default_timezone"] == "Europe/London"
    govern(w, w["uk"])
    assert quote(w, draft(w, [(w["svc"], 100, 1)], tax_date=BOUNDARY)).engine_version == "1"   # not yet in force

    assert activate_due(db, now=at(2030, 6, 1, 7, 59)) == {"activated": [], "not_activated": []}
    first = activate_due(db, now=at(2030, 6, 1, 8, 0))
    assert first["activated"] == [f"TaxRulePackVersion:{second.id}"]
    assert activate_due(db, now=at(2030, 6, 1, 8, 5))["activated"] == []                        # idempotent
    db.refresh(second)
    db.refresh(v1)
    assert second.status == PlatformVersionStatus.ACTIVE and second.publisher_user_id == w["publisher"].id
    assert v1.valid_to == BOUNDARY
    meta = [a.metadata_ or {} for a in db.query(PlatformAuditLog).filter(
        PlatformAuditLog.entity_type == "TaxRulePackVersion", PlatformAuditLog.entity_id == second.id)]
    assert any(m.get("scheduled") and m.get("activate_tz") == "Europe/London" for m in meta)        # audited
    assert sum(1 for m in meta if m.get("activated_by_schedule")) == 1                             # exactly once
    assert quote(w, draft(w, [(w["svc"], 100, 1)], tax_date=BOUNDARY)).engine_version == "2"


def test_one_schedule_per_pack_at_a_time(w, v2, monkeypatch):
    db = w["db"]
    published_pack(w, version="1")
    published_pack(w, valid_from=BOUNDARY, activate_at_local="2030-06-01T09:00", timezone="Europe/London")
    v3 = type("UkVatV3", (UkVatDomesticServices,), {"version": "3"})
    monkeypatch.setitem(RULE_PACK_VERSIONS, (v3.code, "3"), v3)
    monkeypatch.setitem(RULE_PACKS, v3.code, v3)
    third = approved_pack(w, valid_from=date(2032, 1, 1))
    with pytest.raises(RegistryStateError, match="already scheduled"):
        RulePackService(db).publish(actor_id=w["publisher"].id, version_id=third.id,
                                    activate_at_local="2030-07-01T09:00", timezone="Europe/London")
    db.rollback()


def test_activation_after_the_start_date_is_refused(w, v2):
    db = w["db"]
    published_pack(w, version="1")
    late = approved_pack(w, valid_from=BOUNDARY)
    with pytest.raises(RegistryStateError, match="can't be scheduled"):          # PR 4: retroactive = publish now only
        RulePackService(db).publish(actor_id=w["publisher"].id, version_id=late.id,
                                    activate_at_local="2031-01-01T09:00", timezone="Europe/London")
    db.rollback()


def test_failed_recheck_stays_scheduled_and_the_late_alert_fires_and_clears(w, v2, monkeypatch):
    db = w["db"]
    published_pack(w, version="1")
    second = published_pack(w, valid_from=BOUNDARY, activate_at_local="2030-06-01T09:00", timezone="Europe/London")
    real = rpi._read_module
    monkeypatch.setattr(rpi, "_read_module", lambda name: real(name) + ("\n# drift\n" if "gb_vat" in name else ""))
    rpi.clear_cache()
    assert activate_due(db, now=at(2030, 6, 1, 8, 0))["not_activated"] == [f"TaxRulePackVersion:{second.id}"]
    db.refresh(second)
    assert second.status == PlatformVersionStatus.SCHEDULED and "code changed" in second.activation_error

    monitoring.publish(db, monitoring.evaluate(monitoring.collect(db, now=at(2030, 6, 1, 8, 5))))
    assert item(db, ALERT_KEY) is None                                          # within 10 minutes
    monitoring.publish(db, monitoring.evaluate(monitoring.collect(db, now=at(2030, 6, 1, 8, 30))))
    late = item(db, ALERT_KEY)
    assert late is not None and late.severity == AttentionSeverity.P1
    assert "GB-VAT-DOMESTIC-SERVICES v2" in late.description and "activation check failed" in late.description

    monkeypatch.setattr(rpi, "_read_module", real)                       # the drift is rolled back
    rpi.clear_cache()
    assert activate_due(db, now=at(2030, 6, 1, 8, 31))["activated"] == [f"TaxRulePackVersion:{second.id}"]
    monitoring.publish(db, monitoring.evaluate(monitoring.collect(db, now=at(2030, 6, 1, 8, 32))))
    assert item(db, ALERT_KEY) is None


# ── availability switches at activate_at ───────────────────────────────

def test_availability_switches_at_its_time_regardless_of_tax_date(w):
    db = w["db"]
    published_pack(w, version="1")
    govern(w, w["uk"])
    svc = MarketAvailabilityService(db)
    row = svc.draft(actor_id=w["reviewer"].id, jurisdiction_id=w["gb"]["jurisdiction"].id,
                    tax_type_id=w["gb"]["tax_type"].id, transaction_class=TransactionClass.B2C_SERVICES,
                    mode=TaxOperatingMode.SUSPENDED, gates=GATES)
    svc.validate(actor_id=w["reviewer"].id, version_id=row.id)
    svc.submit(actor_id=w["reviewer"].id, version_id=row.id, reason="suspend for review")
    svc.approve(actor_id=w["publisher"].id, version_id=row.id)
    svc.publish(actor_id=w["publisher"].id, version_id=row.id, activate_at_local="2030-06-01T09:00")
    db.commit()
    assert row.status == PlatformVersionStatus.SCHEDULED and row.activate_tz == "Europe/London"   # the jurisdiction's
    assert view_availability(row)["activate_at_local"] == "2030-06-01T09:00"
    old_date = date(2026, 6, 1)
    assert quote(w, draft(w, [(w["svc"], 100, 1)], tax_date=old_date)).status == TaxQuoteStatus.QUOTED
    activate_due(db, now=at(2030, 6, 1, 8, 0))
    db.refresh(row)
    assert row.status == PlatformVersionStatus.ACTIVE
    refused = quote(w, draft(w, [(w["svc"], 100, 1)], tax_date=old_date))      # an old tax date too
    assert refused.status != TaxQuoteStatus.QUOTED


def test_suspension_published_now_is_immediate(w):
    db = w["db"]
    svc = MarketAvailabilityService(db)
    row = svc.draft(actor_id=w["reviewer"].id, jurisdiction_id=w["gb"]["jurisdiction"].id,
                    tax_type_id=w["gb"]["tax_type"].id, transaction_class=TransactionClass.B2B_SERVICES,
                    mode=TaxOperatingMode.SUSPENDED, gates=GATES)
    svc.validate(actor_id=w["reviewer"].id, version_id=row.id)
    svc.submit(actor_id=w["reviewer"].id, version_id=row.id, reason="incident")
    svc.approve(actor_id=w["publisher"].id, version_id=row.id)
    svc.publish(actor_id=w["publisher"].id, version_id=row.id)
    assert row.status == PlatformVersionStatus.ACTIVE and row.activate_at is None


# ── cancelling a scheduled activation: two people ──────────────────────

def test_cancellation_is_two_person_and_returns_the_version_to_approved(w, v2):
    db = w["db"]
    published_pack(w, version="1")
    second = published_pack(w, valid_from=BOUNDARY, activate_at_local="2030-06-01T09:00", timezone="Europe/London")
    svc = ActivationCancellationService(db)
    with pytest.raises(ForbiddenException):
        svc.propose(actor=w["maker"], kind="rule_pack", version_id=second.id, reason="not tax staff")
    c = svc.propose(actor=w["publisher"], kind="rule_pack", version_id=second.id, reason="the law was postponed")
    assert view_rule_pack(second)["pending_cancellation"]["id"] == c.id
    with pytest.raises(RegistryStateError, match="already waiting"):
        svc.propose(actor=w["reviewer"], kind="rule_pack", version_id=second.id, reason="again")
    with pytest.raises(MakerCheckerError):
        svc.decide(actor_id=w["publisher"].id, cancellation_id=c.id, approve=True)
    svc.decide(actor_id=w["publisher2"].id, cancellation_id=c.id, approve=True)
    db.commit()
    db.refresh(second)
    assert second.status == PlatformVersionStatus.APPROVED and second.activate_at is None
    assert activate_due(db, now=at(2030, 6, 1, 9, 0))["activated"] == []
    c.reason = "edited later"
    with pytest.raises(Exception):
        db.flush()                                                     # decided: final
    db.rollback()
    events = [a for a in db.query(PlatformAuditLog).filter(PlatformAuditLog.entity_type == "TaxRulePackVersion",
                                                         PlatformAuditLog.entity_id == second.id)]
    assert len(events) >= 2


def test_the_submitting_reviewer_may_propose_and_rejection_needs_a_reason(w, v2):
    db = w["db"]
    published_pack(w, version="1")
    second = published_pack(w, valid_from=BOUNDARY, activate_at_local="2030-06-01T09:00", timezone="Europe/London")
    svc = ActivationCancellationService(db)
    c = svc.propose(actor=w["reviewer"], kind="rule_pack", version_id=second.id, reason="submitted too early")
    with pytest.raises(BadRequestException, match="reason"):
        svc.decide(actor_id=w["publisher"].id, cancellation_id=c.id, approve=False)
    svc.decide(actor_id=w["publisher"].id, cancellation_id=c.id, approve=False, reason="keep the date")
    assert second.status == PlatformVersionStatus.SCHEDULED


def test_an_activation_that_already_ran_cannot_be_cancelled(w, v2):
    db = w["db"]
    published_pack(w, version="1")
    second = published_pack(w, valid_from=BOUNDARY, activate_at_local="2030-06-01T09:00", timezone="Europe/London")
    c = ActivationCancellationService(db).propose(actor=w["publisher"], kind="rule_pack", version_id=second.id,
                                                  reason="too late?")
    activate_due(db, now=at(2030, 6, 1, 8, 0))
    with pytest.raises(RegistryStateError, match="emergency rollback"):
        ActivationCancellationService(db).decide(actor_id=w["publisher2"].id, cancellation_id=c.id, approve=True)


def test_http_schedule_cancel_and_inbox(w, v2, client_for, monkeypatch):
    from app.config import settings

    db = w["db"]
    base = "/api/v1/super-admin/tax-registry"
    published_pack(w, version="1")
    row = approved_pack(w, valid_from=BOUNDARY)
    db.commit()
    refused = client_for(w["publisher"]).post(f"{base}/rule-packs/{row.id}/publish",
                                              json={"activate_at_local": "2030-06-01T09:00"})
    assert refused.json()["error"] == "TAX_REGISTRY_STEP_UP_REQUIRED"              # scheduling needs MFA too
    monkeypatch.setattr(settings, "TAX_REGISTRY_STEP_UP_REQUIRED", False)          # the rest is about the flow
    body = client_for(w["publisher"]).post(f"{base}/rule-packs/{row.id}/publish",
                                           json={"activate_at_local": "2030-06-01T09:00", "timezone": "Europe/London"})
    assert body.status_code == 200, body.text
    assert body.json()["status"] == "SCHEDULED" and body.json()["activate_tz"] == "Europe/London"
    gap = client_for(w["publisher"]).post(f"{base}/rule-packs/{row.id}/cancel-schedule", json={"reason": "postponed"})
    assert gap.status_code == 201, gap.text
    cid = gap.json()["id"]
    inbox = client_for(w["publisher2"]).get(f"{base}/approvals-inbox").json()
    entry = next(i for i in inbox["items"] if i["kind"] == "activation_cancel")
    assert entry["id"] == cid and entry["can_approve"] is True
    assert client_for(w["reviewer"]).post(f"{base}/activation-cancellations/{cid}/approve", json={}).status_code == 403
    done = client_for(w["publisher2"]).post(f"{base}/activation-cancellations/{cid}/approve", json={})
    assert done.status_code == 200 and done.json()["status"] == "APPROVED"
    assert db.get(TaxActivationCancellation, cid).decided_by == w["publisher2"].id
    listed = client_for(w["reviewer"]).get(f"{base}/activation-cancellations").json()
    assert listed["items"][0]["id"] == cid
    db.expire_all()
    assert db.get(TaxRulePackVersion, row.id).status == PlatformVersionStatus.APPROVED
