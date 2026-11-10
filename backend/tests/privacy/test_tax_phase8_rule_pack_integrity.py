"""ZB-TAX-ARCH-001 Phase 8 PR 1: rule-pack integrity (step 07)."""
from decimal import Decimal

import pytest
from sqlalchemy import text

from app.modules.super_admin.models import AttentionItem, AttentionSeverity, AttentionStatus
from app.modules.tax import monitoring
from app.modules.tax import rule_pack_integrity as rpi
from app.modules.tax.enums import EngineKind, PlatformVersionStatus, TaxQuoteStatus
from app.modules.tax.evidence_bundle import verify
from app.modules.tax.issuance_gate import TaxIssuanceBlocked
from app.modules.tax.policy_models import TaxRulePackVersion
from app.modules.tax.policy_service import RulePackService, view_rule_pack
from app.modules.tax.quote_models import TaxQuote
from app.modules.tax.registry_service import RegistryImmutabilityError
from app.modules.tax.rule_packs import AuGstDomesticServices, UkVatDomesticServices
from tests.test_tax_phase3b_packs import GOLDEN, build_world, draft, govern, issue, publish_pack, quote

GB_MODULE = UkVatDomesticServices.__module__


@pytest.fixture(autouse=True)
def _fresh_hashes():
    rpi.clear_cache()
    yield
    rpi.clear_cache()


@pytest.fixture()
def w(db_session):
    return build_world(db_session, org_code="P8I")


@pytest.fixture()
def uk(w):
    publish_pack(w, UkVatDomesticServices.code)
    govern(w, w["uk"])
    return w


def tamper(monkeypatch, module=GB_MODULE, extra="\n# hot-fixed without a new approved version\n"):
    """Change the pack's running code as a deploy would (the source the hash reads)."""
    real = rpi._read_module
    monkeypatch.setattr(rpi, "_read_module", lambda name: real(name) + (extra if name == module else ""))
    rpi.clear_cache()


def alert(db):
    return db.query(AttentionItem).filter(
        AttentionItem.source_key == f"tax:{rpi.ALERT_KEY}",
        AttentionItem.status.in_([AttentionStatus.OPEN, AttentionStatus.ACKNOWLEDGED])).first()


# ── the hash ────────────────────────────────────────────────────────────

def test_hash_is_stable_line_ending_neutral_and_covers_code_and_declarations(monkeypatch):
    first = rpi.code_hash(UkVatDomesticServices)
    assert len(first) == 64 and rpi.compute_hash(UkVatDomesticServices) == first
    assert rpi.code_hash(AuGstDomesticServices) != first
    assert set(rpi.pack_sources(UkVatDomesticServices)) == {GB_MODULE, "app.modules.tax.rule_packs.domestic"}

    real = rpi._read_module
    monkeypatch.setattr(rpi, "_read_module", lambda name: real(name).replace("\n", "\r\n"))
    assert rpi.compute_hash(UkVatDomesticServices) == first                     # CRLF checkout hashes the same

    tamper(monkeypatch)
    assert rpi.compute_hash(UkVatDomesticServices) != first                     # code change
    monkeypatch.setattr(rpi, "_read_module", real)
    monkeypatch.setattr(UkVatDomesticServices, "summary", "a different coverage statement")
    assert rpi.compute_hash(UkVatDomesticServices) != first                     # declaration change

    shared = rpi.compute_hash(AuGstDomesticServices)
    tamper(monkeypatch, module="app.modules.tax.rule_packs.domestic")
    assert rpi.compute_hash(AuGstDomesticServices) != shared                    # shared logic is covered too


def test_hash_is_recorded_at_registration_and_frozen(w):
    db, svc = w["db"], RulePackService(w["db"])
    row = svc.register(actor_id=w["reviewer"].id, code=UkVatDomesticServices.code)
    assert row.code_hash == rpi.code_hash(UkVatDomesticServices)
    published = publish_pack(w, AuGstDomesticServices.code)
    assert published.status == PlatformVersionStatus.ACTIVE
    published.code_hash = "0" * 64
    with pytest.raises(RegistryImmutabilityError):
        db.flush()
    db.rollback()


def test_validation_and_approval_refuse_changed_code(w, monkeypatch):
    svc = RulePackService(w["db"])
    row = svc.register(actor_id=w["reviewer"].id, code=UkVatDomesticServices.code)
    svc.amend(actor_id=w["reviewer"].id, version_id=row.id, changes={"golden_test_report": GOLDEN})
    tamper(monkeypatch)
    svc.validate(actor_id=w["reviewer"].id, version_id=row.id)
    assert row.status == PlatformVersionStatus.VALIDATION_FAILED
    assert any("code changed since this version was registered" in e for e in row.validation_errors)


def test_pre_phase8_draft_gets_its_hash_on_validation(w):
    db, svc = w["db"], RulePackService(w["db"])
    row = svc.register(actor_id=w["reviewer"].id, code=UkVatDomesticServices.code)
    db.execute(text("UPDATE tax_rule_pack_versions SET code_hash = NULL WHERE id = :i"), {"i": row.id})
    db.expire_all()
    svc.amend(actor_id=w["reviewer"].id, version_id=row.id, changes={"golden_test_report": GOLDEN})
    assert db.get(TaxRulePackVersion, row.id).code_hash == rpi.code_hash(UkVatDomesticServices)


# ── provenance ──────────────────────────────────────────────────────────

def test_native_quotes_record_the_pack_version_and_hash(uk):
    db = uk["db"]
    row = db.query(TaxRulePackVersion).filter(TaxRulePackVersion.code == UkVatDomesticServices.code).one()
    q = quote(uk, draft(uk, [(uk["svc"], 100, 1)]))
    assert q.status == TaxQuoteStatus.QUOTED and q.engine_kind == EngineKind.NATIVE_RULE_PACK
    assert (q.rule_pack_version_id, q.rule_pack_code_hash) == (row.id, row.code_hash)
    from app.modules.tax.determination_service import view_quote

    engine = view_quote(q)["engine"]
    assert engine["rule_pack_version_id"] == row.id and engine["rule_pack_code_hash"] == row.code_hash


def test_issuing_marks_the_quote_stale_when_the_pack_version_changed(uk, monkeypatch):
    db = uk["db"]
    inv = draft(uk, [(uk["svc"], 100, 1)])
    q = quote(uk, inv)
    other = publish_pack(uk, AuGstDomesticServices.code)          # any other version id
    q_row = db.get(TaxQuote, q.id)
    db.execute(text("UPDATE tax_quotes SET rule_pack_version_id = :o WHERE id = :q"), {"o": other.id, "q": q.id})
    db.commit()
    db.expire_all()
    with pytest.raises(TaxIssuanceBlocked, match="rule pack changed"):
        issue(uk, inv)
    db.refresh(q_row)
    assert q_row.status == TaxQuoteStatus.STALE


# ── fail closed ─────────────────────────────────────────────────────────

def test_changed_pack_code_fails_closed_with_a_p1_alert(uk, monkeypatch):
    db = uk["db"]
    tamper(monkeypatch)
    inv = draft(uk, [(uk["svc"], 100, 1)])
    q = quote(uk, inv)
    assert q.status == TaxQuoteStatus.UNSUPPORTED and q.refusal_code == rpi.INTEGRITY_FAILED
    assert q.tax_amount is None and not q.lines and q.engine_kind is None              # no tax, no fallback
    assert "hash" not in q.refusal_reason.lower() and UkVatDomesticServices.code not in q.refusal_reason  # T13
    item = alert(db)
    assert item is not None and item.severity == AttentionSeverity.P1
    assert UkVatDomesticServices.code in item.description and "MISMATCH" in item.description
    with pytest.raises(TaxIssuanceBlocked):
        issue(uk, inv)


def test_monitoring_raises_and_clears_the_alert(uk, monkeypatch):
    db = uk["db"]
    assert monitoring.collect(db)["rule_pack_integrity"] == []
    tamper(monkeypatch)
    monitoring.publish(db, monitoring.evaluate(monitoring.collect(db)))
    assert alert(db) is not None
    monkeypatch.undo()
    rpi.clear_cache()
    monitoring.publish(db, monitoring.evaluate(monitoring.collect(db)))
    assert alert(db) is None


def test_missing_pack_code_fails_closed(uk, monkeypatch):
    from app.modules.tax.engines import RULE_PACKS

    monkeypatch.setitem(RULE_PACKS, UkVatDomesticServices.code,
                        type("UkV2", (UkVatDomesticServices,), {"version": "2"}))
    rpi.clear_cache()
    row = uk["db"].query(TaxRulePackVersion).filter(TaxRulePackVersion.code == UkVatDomesticServices.code).one()
    assert view_rule_pack(row)["integrity"] == rpi.CODE_MISSING
    q = quote(uk, draft(uk, [(uk["svc"], 100, 1)]))
    assert q.refusal_code == rpi.INTEGRITY_FAILED


def test_startup_check_alerts(uk, monkeypatch):
    import app.database as database

    monkeypatch.setattr(database, "SessionLocal", lambda: _NoClose(uk["db"]))
    tamper(monkeypatch)
    failures = rpi.verify_rule_packs_at_startup()
    assert failures == [{"code": UkVatDomesticServices.code, "version": "1", "integrity": rpi.MISMATCH}]
    assert alert(uk["db"]) is not None


class _NoClose:
    def __init__(self, db):
        self._db = db

    def __getattr__(self, name):
        return getattr(self._db, name)

    def close(self):
        pass


# ── evidence, console and backfill ──────────────────────────────────────

def test_view_and_platform_bundle_carry_the_hash(uk, client_for, monkeypatch):
    db = uk["db"]
    row = db.query(TaxRulePackVersion).filter(TaxRulePackVersion.code == UkVatDomesticServices.code).one()
    view = view_rule_pack(row)
    assert view["integrity"] == rpi.MATCH and view["code_hash"] == view["running_code_hash"] == row.code_hash
    body = client_for(uk["publisher"]).get(f"/api/v1/super-admin/tax-registry/evidence-bundles/rule_pack/{row.id}")
    assert body.status_code == 200, body.text
    data = body.json()
    assert verify(data) and data["record"]["code_hash"] == row.code_hash
    listed = client_for(uk["publisher"]).get("/api/v1/super-admin/tax-registry/rule-packs").json()
    assert any(r.get("integrity") == rpi.MATCH for r in listed["items"])
    tamper(monkeypatch)
    assert view_rule_pack(row)["integrity"] == rpi.MISMATCH


def test_backfill_links_unambiguous_quotes_only(uk):
    db = uk["db"]
    row = db.query(TaxRulePackVersion).filter(TaxRulePackVersion.code == UkVatDomesticServices.code).one()
    linked = quote(uk, draft(uk, [(uk["svc"], 100, 1)]))
    unknown = quote(uk, draft(uk, [(uk["svc"], 50, 1)]))
    db.execute(text("UPDATE tax_quotes SET rule_pack_version_id = NULL, rule_pack_code_hash = NULL"))
    db.execute(text("UPDATE tax_quotes SET engine_version = '99' WHERE id = :i"), {"i": unknown.id})
    migration = _load_migration()
    counts = migration.backfill(db.connection())
    db.expire_all()
    assert counts == {"linked": 1, "left_null": 1}
    assert db.get(TaxQuote, linked.id).rule_pack_version_id == row.id
    assert db.get(TaxQuote, linked.id).rule_pack_code_hash is None                 # never claimed for the past
    assert db.get(TaxQuote, unknown.id).rule_pack_version_id is None
    assert Decimal(db.get(TaxQuote, linked.id).tax_amount) == Decimal("20.00")


def _load_migration():
    import importlib.util
    import pathlib

    path = pathlib.Path(__file__).resolve().parents[2] / "alembic" / "versions" / \
        "d2a6c8e4f1b7_tax_phase8_rule_pack_integrity.py"
    spec = importlib.util.spec_from_file_location("phase8_migration", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
