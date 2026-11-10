"""ZB-TAX-ARCH-001 Phase 8 PR 4: retroactive change analysis (handoff §10.3, T04)."""
import dataclasses
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from sqlalchemy import text

from app.config import settings
from app.core.exceptions import BadRequestException
from app.modules.auth.models import PlatformRole, UserRole
from app.modules.super_admin.models import AttentionItem, AttentionSeverity, AttentionStatus
from app.modules.tax import retro_service as rs
from app.modules.tax import rollback_service as rb
from app.modules.tax import rule_pack_integrity as rpi
from app.modules.tax.engines import RULE_PACK_VERSIONS, RULE_PACKS
from app.modules.tax.enums import (
    RateKind, ReviewItemKind, StagingOrigin, TaxOperatingMode, TaxQuoteStatus, TransactionClass,
)
from app.modules.tax.models import TaxReviewItem
from app.modules.tax.policy_models import TaxRulePackVersion
from app.modules.tax.policy_service import RulePackService
from app.modules.tax.quote_models import TaxQuote
from app.modules.tax.registry_service import RegistryStateError, TaxRegistryPipeline
from app.modules.tax.retro_models import TaxRetroAnalysis, TaxRetroOrgRun, TaxRetroResult
from app.modules.tax.rollback_service import RollbackService
from app.modules.tax.rule_packs import UkVatDomesticServices
from app.modules.tax.tenant_tax_service import TenantTaxService
from tests.privacy.test_tax_phase3a_reports_access import _tenant_user
from tests.privacy.test_tax_phase8_scheduled_activation import approved_pack, published_pack
from tests.test_tax_phase3b_packs import _user, build_world, draft, govern, issue, quote

UTC = timezone.utc
CODE = UkVatDomesticServices.code
TABLES = ("invoices", "invoice_items", "tax_quotes", "tax_quote_lines", "tax_quote_components", "credit_notes",
          "credit_note_tax_lines")


class UkV2Wrong(UkVatDomesticServices):
    """A version that charges 25% instead of the published rate."""
    version = "2"

    def determine(self, request):
        result = super().determine(request)
        return dataclasses.replace(result, components=[dataclasses.replace(c, rate_percent=Decimal("25"))
                                                        for c in result.components])


@pytest.fixture(autouse=True)
def _fresh_hashes():
    rpi.clear_cache()
    yield
    rpi.clear_cache()


@pytest.fixture()
def emails(monkeypatch):
    sent = []
    from app.modules.notifications import service as notifications

    monkeypatch.setattr(notifications, "dispatch_email", lambda **kw: sent.append(kw))
    return sent


@pytest.fixture()
def gate_on(monkeypatch):
    monkeypatch.setattr(settings, "TAX_RETRO_PREVIEW_REQUIRED", True)


@pytest.fixture()
def v2(monkeypatch):
    monkeypatch.setitem(RULE_PACK_VERSIONS, (CODE, "2"), UkV2Wrong)
    monkeypatch.setitem(RULE_PACKS, CODE, UkV2Wrong)


@pytest.fixture()
def w(db_session):
    w = build_world(db_session, org_code="P8A")
    w["publisher2"] = _user(db_session, "pub2@p8a.example", UserRole.SUPER_ADMIN, platform_role=PlatformRole.TAX_PUBLISHER)
    w["p"] = published_pack(w, version="1")
    govern(w, w["uk"])
    return w


def issued(w, day=date(2026, 6, 1), price=100):
    inv = draft(w, [(w["svc"], price, 1)], tax_date=day)
    q = quote(w, inv)
    assert q.status == TaxQuoteStatus.QUOTED, (q.refusal_code, q.refusal_reason)
    issue(w, inv)
    w["db"].refresh(q)
    assert q.status == TaxQuoteStatus.COMMITTED
    return inv, q


def snapshot(db) -> dict:
    """Every issued-record row, byte for byte (T04)."""
    return {t: [tuple(r) for r in db.execute(text(f"SELECT * FROM {t} ORDER BY id")).fetchall()] for t in TABLES}


def stage_rate(w, rate, *, valid_from=date(2011, 1, 4), supersedes=True, scope=None):
    p = TaxRegistryPipeline(w["db"])
    row = p.stage(actor_id=w["reviewer"].id, origin=StagingOrigin.MANUAL, component_id=w["gb"]["component"].id,
                  tax_code="standard", rate_kind=RateKind.STANDARD, rate_percent=Decimal(rate), valid_from=valid_from,
                  valid_to=None, source_revision_id=w["gb"]["source"].id, owner="Tax compliance operations",
                  supersedes_rate_version_id=w["gb"]["rate"].id if supersedes else None)
    if scope:
        row.product_scope = scope
    return row


def approve_rate(w, row):
    p = TaxRegistryPipeline(w["db"])
    p.validate(actor_id=w["reviewer"].id, staged_id=row.id)
    p.submit(actor_id=w["reviewer"].id, staged_id=row.id, reason="HMRC correction")
    p.approve(actor_id=w["publisher"].id, staged_id=row.id)
    return row


def run_job(db, **kw):
    return rs.run_retro_analyses(db, **kw)


def full(db, kind, trigger_id=None):
    q = db.query(TaxRetroAnalysis).filter(TaxRetroAnalysis.mode == "FULL", TaxRetroAnalysis.trigger_kind == kind)
    if trigger_id is not None:
        q = q.filter(TaxRetroAnalysis.trigger_id == trigger_id)
    return q.one()


# ── (b) a retroactive rate correction: gate, analysis, T04 ──────────────

def test_rate_correction_needs_a_current_preview_then_is_analysed_read_only(w, gate_on, emails):
    db = w["db"]
    _, q = issued(w)
    staged = stage_rate(w, "18")
    TaxRegistryPipeline(db).validate(actor_id=w["reviewer"].id, staged_id=staged.id)
    TaxRegistryPipeline(db).submit(actor_id=w["reviewer"].id, staged_id=staged.id, reason="correction")
    with pytest.raises(RegistryStateError, match="retroactive analysis preview is required .no retroactive"):
        TaxRegistryPipeline(db).approve(actor_id=w["publisher"].id, staged_id=staged.id)
    preview = rs.run_preview(db, "rate", staged.id, w["reviewer"].id)
    assert preview.aggregates["documents"] == 1 and preview.aggregates["by_status"] == {"COMPARED": 1}
    assert preview.aggregates["per_currency"]["GBP"]["over"] == "2.00"
    assert db.query(TaxRetroResult).count() == 0                                    # a preview keeps no tenant rows
    TaxRegistryPipeline(db).approve(actor_id=w["publisher"].id, staged_id=staged.id)
    version = TaxRegistryPipeline(db).publish(actor_id=w["publisher"].id, staged_id=staged.id)
    db.commit()

    before = snapshot(db)
    analysis = full(db, "rate", version.id)
    assert analysis.status == "PENDING" and analysis.basis == "rate_in_force"
    run_job(db)
    db.expire_all()
    assert snapshot(db) == before                                                     # T04: byte-identical
    analysis = db.get(TaxRetroAnalysis, analysis.id)
    assert analysis.status == "DONE"
    result = db.query(TaxRetroResult).filter(TaxRetroResult.analysis_id == analysis.id).one()
    assert (result.status, result.direction, result.original_tax, result.comparison_tax, result.difference) == (
        "COMPARED", "OVER", Decimal("20.00"), Decimal("18.00"), Decimal("2.00"))
    assert result.versions_used["comparison_pack"]["id"] == w["p"].id
    assert str(version.id) in result.versions_used["comparison_rate_version_ids"]
    assert Decimal(result.lines[0]["original"]["rate"]) == 20 and Decimal(result.lines[0]["comparison"]["rate"]) == 18
    assert result.inputs_hash and q.decision_facts["seller_country"] == "GB"


def test_under_collection_is_reported_only(w):
    db = w["db"]
    issued(w)
    staged = approve_rate(w, stage_rate(w, "22"))
    version = TaxRegistryPipeline(db).publish(actor_id=w["publisher"].id, staged_id=staged.id)
    run_job(db)
    r = db.query(TaxRetroResult).filter(TaxRetroResult.analysis_id == full(db, "rate", version.id).id).one()
    assert (r.direction, r.difference) == ("UNDER", Decimal("-2.00"))
    view = rs.view_tenant_document(r, None)
    assert view["remediation_preview"] is None and "no debit notes" in view["under_collection"]


def test_rate_scope_is_by_key_not_superseded_version(w):
    """Fix A: a product-scope rate covering past dates served by GENERAL."""
    db = w["db"]
    _, q = issued(w)
    staged = stage_rate(w, "5", supersedes=False, scope="REDUCED_SERVICES")
    t = rs.rate_trigger(db, staged=staged)
    assert [x.id for x in rs.scope_query(db, t)] == [q.id]
    assert q.lines[0].components[0].rate_version_id != staged.id


def test_preview_is_stale_when_a_quote_created_before_it_is_committed_after(w, gate_on):
    db = w["db"]
    inv = draft(w, [(w["svc"], 100, 1)], tax_date=date(2026, 6, 1))
    quote(w, inv)                                                         # created before the preview
    staged = stage_rate(w, "18")
    rs.run_preview(db, "rate", staged.id, w["reviewer"].id)
    assert rs.preview_problem(db, "rate", staged.id) is None
    issue(w, inv)                                                         # committed after it
    assert "committed documents in scope changed" in rs.preview_problem(db, "rate", staged.id)
    rs.run_preview(db, "rate", staged.id, w["reviewer"].id)
    p = rs.latest_preview(db, "rate", staged.id)
    p.created_at = datetime.now(UTC) - timedelta(hours=25)
    assert "older than 24 hours" in rs.preview_problem(db, "rate", staged.id)


# ── (c) a retroactive pack version ──────────────────────────────────────

def test_retro_pack_needs_a_preview_publishes_now_and_compares(w, v2, gate_on):
    db = w["db"]
    _, q = issued(w)
    row = approved_pack(w, valid_from=date(2026, 5, 1), version="2")
    db.commit()
    with pytest.raises(RegistryStateError, match="preview is required"):
        RulePackService(db).publish(actor_id=w["publisher"].id, version_id=row.id)
    db.rollback()
    with pytest.raises(RegistryStateError, match="can't be scheduled"):
        RulePackService(db).publish(actor_id=w["publisher"].id, version_id=row.id,
                                    activate_at_local="2030-06-01T09:00", timezone="Europe/London")
    db.rollback()
    preview = rs.run_preview(db, "rule_pack", row.id, w["reviewer"].id)
    assert preview.aggregates["per_currency"]["GBP"]["under"] == "5.00"
    RulePackService(db).publish(actor_id=w["publisher"].id, version_id=row.id)
    db.commit()
    analysis = full(db, "rule_pack", row.id)
    run_job(db)
    r = db.query(TaxRetroResult).filter(TaxRetroResult.analysis_id == analysis.id).one()
    assert (r.quote_id, r.status, r.direction, r.comparison_tax) == (q.id, "COMPARED", "UNDER", Decimal("25.00"))
    assert r.basis_label == rs.BASES["pack_in_force"]


def test_commit_time_facts_unknown_or_changed_are_manual_review(w):
    db = w["db"]
    _, q1 = issued(w)
    _, q2 = issued(w, price=50)
    db.execute(text("UPDATE tax_quotes SET decision_facts = NULL WHERE id = :i"), {"i": q1.id})   # pre-PR 4 quote
    db.expire_all()
    staged = stage_rate(w, "18")
    t = rs.rate_trigger(db, staged=staged)
    unknown = rs.compare(db, db.get(TaxQuote, q1.id), t)
    assert unknown["status"] == "MANUAL_REVIEW_REQUIRED" and "commit-time value unknown" in unknown["reason"]
    w["uk"].country_code = "IE"                                                        # the seller moved
    db.flush()
    changed = rs.compare(db, db.get(TaxQuote, q2.id), t)
    assert changed["status"] == "MANUAL_REVIEW_REQUIRED" and "facts changed since commit" in changed["reason"]
    assert "seller country" in changed["reason"]


def test_provider_quotes_are_not_analysable(w, v2):
    db = w["db"]
    _, q = issued(w)
    db.execute(text("UPDATE tax_quotes SET engine_kind = 'PROVIDER' WHERE id = :i"), {"i": q.id})
    db.expire_all()
    row = approved_pack(w, valid_from=date(2026, 5, 1), version="2")
    t = rs.pack_trigger(db, row)
    assert [x.id for x in rs.scope_query(db, t)] == [q.id]
    r = rs.compare(db, db.get(TaxQuote, q.id), t)
    assert r["status"] == "NOT_ANALYSABLE" and "provider" in r["reason"]


# ── (a) rollbacks: restored logic, quarantine, linked communication ─────

def _rolled_back_world(w):
    v = published_pack(w, valid_from=date(2031, 1, 1), version="2")
    inv, q = issued(w, day=date(2031, 2, 1))
    assert q.rule_pack_version_id == v.id and q.tax_amount == Decimal("25.00")
    return v, inv, q


def test_rollback_with_restore_compares_against_restored_logic(w, v2, monkeypatch, emails):
    db = w["db"]
    v, inv, q = _rolled_back_world(w)
    monkeypatch.setattr(rb, "utcnow", lambda: datetime(2031, 3, 1, 12, 0, tzinfo=UTC))
    req = RollbackService(db).propose(actor_id=w["publisher"].id, kind="rule_pack", version_id=v.id,
                                      restore_to_id=w["p"].id, reason="charges 25%", severity="SEV1")
    RollbackService(db).decide(actor_id=w["publisher2"].id, request_id=req.id, approve=True)
    db.commit()
    emails.clear()
    before = snapshot(db)
    run_job(db)
    assert snapshot(db) == before                                                      # T04
    analysis = full(db, "rollback", req.id)
    assert analysis.status == "DONE" and analysis.basis == "restored" and analysis.severity == "SEV1"
    r = db.query(TaxRetroResult).filter(TaxRetroResult.analysis_id == analysis.id).one()
    assert r.basis_label == "Comparison against restored logic, not a determination"
    assert (r.direction, r.difference) == ("OVER", Decimal("5.00"))
    assert r.versions_used["restored"]["id"] == w["p"].id and r.versions_used["rolled_back"]["id"] == v.id

    # fix C: the PR 3 items are updated, not duplicated; one "analysis ready" email
    item = db.query(AttentionItem).filter(AttentionItem.source_key == f"tax:tax.rollback_applied:{req.id}").one()
    assert f"Retroactive analysis #{analysis.id}" in item.description and item.severity == AttentionSeverity.P1
    assert db.query(AttentionItem).filter(AttentionItem.source_key.like("tax:tax.retro_analysis:%")).count() == 0
    reviews = db.query(TaxReviewItem).filter(TaxReviewItem.organization_id == w["org"].id,
                                             TaxReviewItem.kind.in_([ReviewItemKind.TAX_ROLLBACK_APPLIED,
                                                                     ReviewItemKind.TAX_RETRO_ANALYSIS])).all()
    assert len(reviews) == 1 and "Retroactive analysis" in reviews[0].detail
    ready = [e for e in emails if e["template_id"] == "ZB-TAX-002"]
    assert [e["recipient_email"] for e in ready] == [w["admin"].email]
    assert "5.00" not in str(ready[0]["context"]) and "25" not in str(ready[0]["context"])


def test_quarantine_lists_documents_for_manual_review(w, v2, monkeypatch):
    db = w["db"]
    v, inv, q = _rolled_back_world(w)
    later = type("UkV3", (UkVatDomesticServices,), {"version": "3"})
    monkeypatch.setitem(RULE_PACK_VERSIONS, (CODE, "3"), later)
    monkeypatch.setitem(RULE_PACKS, CODE, later)
    published_pack(w, valid_from=date(2032, 1, 1), version="3")
    req = RollbackService(db).propose(actor_id=w["publisher"].id, kind="rule_pack", version_id=v.id,
                                      restore_to_id=None, reason="quarantine", severity="SEV2")
    RollbackService(db).decide(actor_id=w["publisher2"].id, request_id=req.id, approve=True)
    run_job(db)
    analysis = full(db, "rollback", req.id)
    r = db.query(TaxRetroResult).filter(TaxRetroResult.analysis_id == analysis.id).one()
    assert (r.status, r.comparison_tax, r.difference) == ("MANUAL_REVIEW_REQUIRED", None, None)
    assert "quarantined" in r.reason and analysis.basis == "quarantine"


# ── the job: idempotent, resumable ──────────────────────────────────────

def test_job_is_idempotent_and_resumes(w):
    db = w["db"]
    for price in (100, 50, 30):
        issued(w, price=price)
    staged = approve_rate(w, stage_rate(w, "18"))
    version = TaxRegistryPipeline(db).publish(actor_id=w["publisher"].id, staged_id=staged.id)
    db.commit()
    analysis = full(db, "rate", version.id)
    rs._start(db, analysis.id)
    run = db.query(TaxRetroOrgRun).filter(TaxRetroOrgRun.analysis_id == analysis.id).one()
    assert rs._process_org(db, run.id, batch=1) == 1                            # one batch, then a "crash"
    db.refresh(run)
    assert run.status == "PENDING" and run.documents == 1
    run_job(db, batch=1)                                                        # resumes from the cursor
    run_job(db, batch=1)                                                        # nothing left to do
    results = db.query(TaxRetroResult).filter(TaxRetroResult.analysis_id == analysis.id).all()
    assert len(results) == 3 and len({r.quote_id for r in results}) == 3
    assert db.get(TaxRetroAnalysis, analysis.id).status == "DONE"


# ── privacy: tenant report, platform aggregates ─────────────────────────

def test_tenant_report_is_private_and_platform_sees_banded_aggregates(w, client_for):
    db = w["db"]
    issued(w)
    staged = approve_rate(w, stage_rate(w, "18"))
    version = TaxRegistryPipeline(db).publish(actor_id=w["publisher"].id, staged_id=staged.id)
    run_job(db)
    analysis = full(db, "rate", version.id)
    finance = _tenant_user(db, w["org"], UserRole.FINANCE_APPROVER, "fin@p8a.example")
    listed = client_for(finance).get("/api/v1/tax/retro-analyses")
    assert listed.status_code == 200 and listed.json()["items"][0]["id"] == analysis.id
    assert listed.json()["remediation_enabled"] is False
    docs = client_for(w["admin"]).get(f"/api/v1/tax/retro-analyses/{analysis.id}/documents").json()["items"]
    assert docs[0]["remediation_preview"]["amount"] == "2.00" and "PR 4b" in docs[0]["remediation_preview"]["drafts"]
    csv_body = client_for(w["admin"]).get(f"/api/v1/tax/retro-analyses/{analysis.id}/documents",
                                          params={"format": "csv"})
    assert csv_body.status_code == 200 and "COMPARED" in csv_body.text
    billing = _tenant_user(db, w["org"], UserRole.BILLING_ADMIN, "bill@p8a.example")
    assert client_for(billing).get("/api/v1/tax/retro-analyses").status_code == 403
    from tests.test_tax_phase3b_packs import make_organization

    other = make_organization(db, code="P8AX", name="Other")
    stranger = client_for(_tenant_user(db, other, UserRole.ORG_ADMIN, "x@p8ax.example"))
    assert stranger.get(f"/api/v1/tax/retro-analyses/{analysis.id}/documents").status_code == 404
    assert stranger.get("/api/v1/tax/retro-analyses").json()["items"] == []
    assert client_for(w["publisher"]).get("/api/v1/tax/retro-analyses").status_code == 403         # T13

    platform = client_for(w["publisher"]).get("/api/v1/super-admin/tax-registry/retro-analyses").json()["items"][0]
    assert platform["aggregates"]["organizations_affected"] == 1
    assert platform["aggregates"]["per_currency"]["GBP"]["over"] == "< 1k"                          # fix B
    assert "banded" in platform["aggregates"]["amounts"]
    blob = str(platform)
    for secret in (w["org"].organization_name, w["org"].organization_code, "P3B-", str(w["admin"].email)):
        assert secret not in blob
    item = db.query(AttentionItem).filter(AttentionItem.source_key == f"tax:tax.retro_analysis:{analysis.id}").one()
    assert item.severity == AttentionSeverity.P2 and "2.00" not in item.description and "< 1k" in item.description


def test_exact_amounts_from_three_organizations():
    aggregates = {"organizations_affected": 3, "documents": 3, "by_status": {"COMPARED": 3},
                  "per_currency": {"GBP": {"net": "6.00", "over": "6.00", "under": "0", "documents": 3}}}
    assert rs.platform_view(aggregates)["per_currency"]["GBP"]["over"] == "6.00"
    assert rs.band("999") == "< 1k" and rs.band("5000") == "1k–10k" and rs.band("250000") == "> 100k"


def test_superseded_by_a_later_analysis(w):
    db = w["db"]
    issued(w)
    first = TaxRegistryPipeline(db).publish(actor_id=w["publisher"].id, staged_id=approve_rate(w, stage_rate(w, "18")).id)
    run_job(db)
    w["gb"]["rate"] = first
    second = TaxRegistryPipeline(db).publish(actor_id=w["publisher"].id, staged_id=approve_rate(w, stage_rate(w, "19")).id)
    run_job(db)
    a1, a2 = full(db, "rate", first.id), full(db, "rate", second.id)
    r1 = db.query(TaxRetroResult).filter(TaxRetroResult.analysis_id == a1.id).one()
    assert rs.superseded_map(db, w["org"].id, [r1.quote_id])[r1.quote_id] == a2.id


# ── tenant-configured rates can't be past-dated over issued documents ───

def test_past_dated_tenant_rate_over_issued_documents_is_refused(w):
    issued(w)
    svc = TenantTaxService(w["db"])
    with pytest.raises(BadRequestException, match="past date that already has issued invoices"):
        svc.propose_activation(w["org"].id, w["maker"].id, seller_entity_id=w["uk"].id,
                               jurisdiction_id=w["gb"]["jurisdiction"].id, tax_type_id=w["gb"]["tax_type"].id,
                               transaction_class=TransactionClass.B2C_SERVICES,
                               mode=TaxOperatingMode.TENANT_CONFIG_APPROVED, effective_from=date(2026, 1, 1),
                               registration_id=w["uk_reg"].id, tenant_rate_percent=Decimal("20"),
                               tenant_source_citation="HMRC VAT notice", tenant_source_url="https://www.gov.uk/vat-rates")
