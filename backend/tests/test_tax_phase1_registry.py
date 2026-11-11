"""tests/test_tax_phase1_registry.py
----------------------------------
ZB-TAX-ARCH-001 Phase 1: Global Tax Reference Registry (SQLite, service level).

Handoff QA references: T02 (no overlapping ACTIVE intervals except cumulative
components), T04 (corrections are new versions; history is never rewritten),
T11 (a conflicting source stays unpublished and escalates; the prior version
stays active), T13 / §12.1 (registry is non-tenant; no tenant data on
reference endpoints; tenants never reach privileged evidence).

Postgres-only guarantees (triggers, EXCLUDE constraint) are covered by
test_tax_phase1_registry_pg.py.
"""
import hashlib
import io
import json
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import pytest
from starlette.datastructures import Headers, UploadFile

from app.core.capabilities import has_capability, require_capability
from app.core.exceptions import BadRequestException, ForbiddenException
from app.database import Base
from app.modules.auth.models import PlatformRole, User, UserRole
from app.modules.super_admin.models import ApprovalRequest, AttentionItem, PlatformAuditAction, PlatformAuditLog
from app.modules.tax.legal_entity_service import LegalEntityService
from app.modules.tax.enums import (
    AcquisitionMethod,
    EvidenceStatus,
    RateKind,
    RateVersionStatus,
    RedistributionPermission,
    SourceTier,
    StagedRateStatus,
    StagingOrigin,
    TaxOperatingMode,
)
from app.modules.tax.registry_models import (
    TaxAuthority,
    TaxComponent,
    TaxJurisdiction,
    TaxLegalSourceRevision,
    TaxRateStaging,
    TaxRateVersion,
    TaxSourceArtifact,
    TaxTypeDefinition,
)
from app.modules.tax import registry_router
from app.modules.tax.registry_schemas import RateLookupResponse, RegistryJurisdictionListResponse, StepUpRequest
from app.modules.tax.registry_seed import EU_MEMBER_STATES, seed_registry
from app.modules.tax.registry_service import (
    MakerCheckerError,
    RegistryImmutabilityError,
    RegistryReadService,
    RegistryStateError,
    TaxRegistryPipeline,
    public_source_summary,
)
from tests.conftest import make_customer, make_invoice, make_organization

REGISTRY_TABLES = (
    "tax_jurisdictions", "tax_authorities", "tax_type_definitions", "tax_components", "tax_source_artifacts",
    "tax_legal_source_revisions", "tax_rate_staging", "tax_change_approvals", "tax_rate_versions",
)
EVIDENCE = b"%PDF-1.7 captured official source"


# ── fixtures / helpers ──────────────────────────────────────────────────

def _staff(db, email, platform_role, first="Tess", last="Reviewer"):
    user = User(email=email, hashed_password="x", role=UserRole.SUPER_ADMIN, platform_role=platform_role,
                organization_id=None, first_name=first, last_name=last, is_active=True, is_verified=True)
    db.add(user)
    db.flush()
    return user


@pytest.fixture()
def people(db_session):
    return {
        "maker": _staff(db_session, "maker@tax.example", PlatformRole.TAX_REVIEWER, "Mara", "Maker"),
        "maker2": _staff(db_session, "maker2@tax.example", PlatformRole.TAX_REVIEWER, "Milo", "Maker"),
        "checker": _staff(db_session, "checker@tax.example", PlatformRole.TAX_PUBLISHER, "Chen", "Checker"),
    }


@pytest.fixture()
def registry(db_session, people):
    """GB jurisdiction + VAT component + an evidenced HMRC source."""
    db = db_session
    gb = TaxJurisdiction(code="GB", name="United Kingdom", level="country", country_code="GB", timezone="Europe/London")
    multi = TaxJurisdiction(code="CA", name="Canada", level="country", country_code="CA", timezone=None)
    db.add_all([gb, multi])
    db.flush()
    authority = TaxAuthority(code="GB-HMRC", name="HM Revenue & Customs", jurisdiction_id=gb.id)
    vat = TaxTypeDefinition(code="VAT", name="Value added tax")
    db.add_all([authority, vat])
    db.flush()
    component = TaxComponent(code="GB-VAT", name="UK VAT", jurisdiction_id=gb.id, tax_type_id=vat.id,
                             authority_id=authority.id)
    cumulative = TaxComponent(code="GB-LEVY", name="Cumulative levy", jurisdiction_id=gb.id, tax_type_id=vat.id,
                              authority_id=authority.id, is_cumulative=True)
    db.add_all([component, cumulative])
    db.flush()
    pipeline = TaxRegistryPipeline(db)
    source = _source(pipeline, authority.id)
    pipeline.attach_evidence(actor_id=people["maker"].id, revision_id=source.id, content=EVIDENCE,
                             media_type="application/pdf", filename="hmrc.pdf",
                             redistribution_permission=RedistributionPermission.PERMITTED)
    db.flush()
    return {"gb": gb, "multi": multi, "authority": authority, "component": component,
            "cumulative": cumulative, "source": source, "pipeline": pipeline}


def _source(pipeline, authority_id, url="https://www.gov.uk/guidance/vat-rates-on-different-goods-and-services"):
    return pipeline.register_source_revision(
        actor_id=None, authority_id=authority_id, source_tier=SourceTier.OFFICIAL_GUIDANCE,
        acquisition_method=AcquisitionMethod.MANUAL_VERIFIED_EXTRACTION, permanent_url=url,
        title="VAT rates on different goods and services", citation="HMRC guidance [S11]", language="en",
    )


def _stage(reg, maker, *, rate="20", valid_from=date(2011, 1, 4), valid_to=None, component=None,
           supersedes=None, origin=StagingOrigin.MANUAL, source=None):
    return reg["pipeline"].stage(
        actor_id=maker.id if maker else None, origin=origin, component_id=(component or reg["component"]).id,
        tax_code="standard", rate_kind=RateKind.STANDARD, rate_percent=Decimal(rate) if rate is not None else None,
        valid_from=valid_from, valid_to=valid_to, source_revision_id=(source or reg["source"]).id,
        owner="Tax compliance operations", supersedes_rate_version_id=supersedes,
    )


def _publish(reg, people, **kwargs):
    p = reg["pipeline"]
    row = _stage(reg, people["maker"], **kwargs)
    p.validate(actor_id=people["maker"].id, staged_id=row.id)
    assert row.status == StagedRateStatus.VALIDATED, row.validation_errors
    p.submit(actor_id=people["maker"].id, staged_id=row.id, reason="New HMRC rate")
    p.approve(actor_id=people["checker"].id, staged_id=row.id)
    return p.publish(actor_id=people["checker"].id, staged_id=row.id)


# ── Separation from tenant data (§12.1) ─────────────────────────────────

def test_registry_tables_hold_no_tenant_keys():
    allowed_targets = set(REGISTRY_TABLES) | {"users", "approval_requests"}
    for name in REGISTRY_TABLES:
        table = Base.metadata.tables[name]
        assert "organization_id" not in table.columns, name
        for fk in table.foreign_keys:
            assert fk.column.table.name in allowed_targets, (name, fk.target_fullname)


# ── Seed (REFERENCE_ONLY, PENDING_REVIEW, nothing approved) ─────────────

def test_seed_stages_everything_pending_review_and_publishes_nothing(db_session):
    counts = seed_registry(db_session)
    db_session.flush()

    assert counts["jurisdictions"] == 4 + 13 + len(EU_MEMBER_STATES)
    assert counts["staged_rates"] == 8 + len(EU_MEMBER_STATES)
    assert db_session.query(TaxRateVersion).count() == 0
    assert db_session.query(ApprovalRequest).count() == 0

    for row in db_session.query(TaxRateStaging).all():
        assert row.status == StagedRateStatus.PENDING_REVIEW
        assert row.origin == StagingOrigin.SEED
        assert row.valid_from is None and row.owner is None        # never filled from outside knowledge
        assert row.source_revision.permanent_url.startswith("https://")
        assert row.source_revision.citation
    for source in db_session.query(TaxLegalSourceRevision).all():
        assert source.evidence_status == EvidenceStatus.NOT_CAPTURED
        assert source.redistribution_permission == RedistributionPermission.UNKNOWN
        assert source.sha256 is None and source.retrieved_at is None
        assert source.handoff_ref in {"S9", "S10", "S11", "S12", "S16"}


def test_seed_records_only_rates_stated_on_the_cited_page(db_session):
    seed_registry(db_session)
    stated = {
        r.component.code: r.rate_percent
        for r in db_session.query(TaxRateStaging).all() if r.rate_percent is not None
    }
    assert stated == {"CA-ON-HST": Decimal("13"), "CA-NS-HST": Decimal("14")}


def test_seed_has_provincial_pst_qst_components_without_rates(db_session):
    seed_registry(db_session)
    for code in ("CA-BC-PST", "CA-MB-PST", "CA-SK-PST", "CA-QC-QST"):
        component = db_session.query(TaxComponent).filter_by(code=code).one()
        assert component.authority_id is None
        assert db_session.query(TaxRateStaging).filter_by(component_id=component.id).count() == 0


def test_seed_is_idempotent(db_session):
    seed_registry(db_session)
    db_session.flush()
    again = seed_registry(db_session)
    assert all(v == 0 for v in again.values())


def test_seeded_rows_cannot_pass_validation_until_a_reviewer_completes_them(db_session):
    seed_registry(db_session)
    pipeline = TaxRegistryPipeline(db_session)
    row = db_session.query(TaxRateStaging).filter(TaxRateStaging.external_ref == "seed:CA-ON-HST:STANDARD:GENERAL").one()
    pipeline.validate(actor_id=None, staged_id=row.id)
    assert row.status == StagedRateStatus.VALIDATION_FAILED
    joined = " ".join(row.validation_errors)
    assert "valid_from is required" in joined and "owner is required" in joined


# ── Evidence capture ────────────────────────────────────────────────────

def test_evidence_hash_is_computed_by_the_server(db_session, registry):
    source = registry["source"]
    assert source.sha256 == hashlib.sha256(EVIDENCE).hexdigest()
    assert source.evidence_status == EvidenceStatus.CAPTURED
    assert source.retrieved_at is not None and source.reviewed_at is not None
    assert source.artifact_storage_uri == f"db://tax_source_artifacts/{source.sha256}"
    artifact = db_session.get(TaxSourceArtifact, source.sha256)
    assert artifact.content == EVIDENCE and artifact.size_bytes == len(EVIDENCE)


def test_evidence_can_be_attached_only_once(db_session, registry, people):
    with pytest.raises(RegistryImmutabilityError):
        registry["pipeline"].attach_evidence(
            actor_id=people["maker"].id, revision_id=registry["source"].id, content=b"other",
            media_type="text/html", filename=None, redistribution_permission=RedistributionPermission.PERMITTED,
        )


def test_evidence_upload_route_takes_no_client_hash(db_session, registry, people):
    source = _source(registry["pipeline"], registry["authority"].id, url="https://www.gov.uk/vat-rates")
    upload = UploadFile(file=io.BytesIO(b"<html>snapshot</html>"), filename="snap.html",
                        headers=Headers({"content-type": "text/html"}))
    result = registry_router.attach_source_evidence(
        revision_id=source.id, file=upload, redistribution_permission=RedistributionPermission.RESTRICTED,
        db=db_session, current_user=people["maker"],
    )
    assert result["sha256"] == hashlib.sha256(b"<html>snapshot</html>").hexdigest()
    assert result["redistribution_permission"] == "RESTRICTED"


# ── Pipeline + maker-checker ────────────────────────────────────────────

def test_full_pipeline_publishes_a_reference_only_version(db_session, registry, people):
    version = _publish(registry, people)
    assert version.status == RateVersionStatus.ACTIVE
    assert version.mode == TaxOperatingMode.REFERENCE_ONLY
    assert version.rate_percent == Decimal("20")
    assert version.approved_at and version.published_at and version.activated_at and version.observed_at
    staged = db_session.get(TaxRateStaging, version.staged_rate_id)
    assert staged.status == StagedRateStatus.PUBLISHED
    request = staged.change_approval.approval_request
    assert request.request_type == "tax_rate_publish"
    assert request.requested_by_user_id == people["maker"].id
    assert request.approver_user_id == people["checker"].id
    actions = {row.action for row in db_session.query(PlatformAuditLog).all()}
    assert {PlatformAuditAction.TAX_RATE_SUBMITTED, PlatformAuditAction.TAX_RATE_APPROVED,
            PlatformAuditAction.TAX_RATE_PUBLISHED} <= actions


def test_maker_cannot_approve_or_publish_own_change(db_session, registry, people):
    p = registry["pipeline"]
    row = _stage(registry, people["maker"])
    p.validate(actor_id=people["maker"].id, staged_id=row.id)
    p.submit(actor_id=people["maker"].id, staged_id=row.id, reason="r")
    with pytest.raises(MakerCheckerError):
        p.approve(actor_id=people["maker"].id, staged_id=row.id)
    p.approve(actor_id=people["checker"].id, staged_id=row.id)
    with pytest.raises(MakerCheckerError):
        p.publish(actor_id=people["maker"].id, staged_id=row.id)


def test_whoever_staged_the_row_cannot_check_it(db_session, registry, people):
    p = registry["pipeline"]
    row = _stage(registry, people["checker"])      # staged by the eventual checker
    p.validate(actor_id=people["maker"].id, staged_id=row.id)
    p.submit(actor_id=people["maker"].id, staged_id=row.id, reason="r")
    with pytest.raises(MakerCheckerError):
        p.approve(actor_id=people["checker"].id, staged_id=row.id)


def test_approval_refused_without_captured_evidence(db_session, registry, people):
    p = registry["pipeline"]
    bare = _source(p, registry["authority"].id, url="https://www.gov.uk/vat-rates")
    row = _stage(registry, people["maker"], source=bare)
    p.validate(actor_id=people["maker"].id, staged_id=row.id)
    assert any("not captured" in w for w in row.validation_warnings)
    p.submit(actor_id=people["maker"].id, staged_id=row.id, reason="r")
    with pytest.raises(RegistryStateError, match="no captured evidence"):
        p.approve(actor_id=people["checker"].id, staged_id=row.id)
    assert row.status == StagedRateStatus.IN_APPROVAL


def test_approval_refused_while_redistribution_permission_unknown(db_session, registry, people):
    p = registry["pipeline"]
    source = _source(p, registry["authority"].id, url="https://www.gov.uk/vat-rates")
    p.attach_evidence(actor_id=people["maker"].id, revision_id=source.id, content=b"x", media_type="text/plain",
                      filename=None, redistribution_permission=RedistributionPermission.UNKNOWN)
    row = _stage(registry, people["maker"], source=source)
    p.validate(actor_id=people["maker"].id, staged_id=row.id)
    p.submit(actor_id=people["maker"].id, staged_id=row.id, reason="r")
    with pytest.raises(RegistryStateError, match="UNKNOWN"):
        p.approve(actor_id=people["checker"].id, staged_id=row.id)


def test_secondary_commentary_cannot_back_a_rate(db_session, registry, people):
    p = registry["pipeline"]
    blog = p.register_source_revision(
        actor_id=None, authority_id=registry["authority"].id, source_tier=SourceTier.SECONDARY_COMMENTARY,
        acquisition_method=AcquisitionMethod.MANUAL_VERIFIED_EXTRACTION, permanent_url="https://example.com/blog",
        title="Blog", citation="Commentary", language="en",
    )
    row = _stage(registry, people["maker"], source=blog)
    p.validate(actor_id=people["maker"].id, staged_id=row.id)
    assert row.status == StagedRateStatus.VALIDATION_FAILED


def test_validation_rejects_bad_rates_and_intervals(db_session, registry, people):
    p = registry["pipeline"]
    for rate, valid_to, needle in (("100", None, "below 100"), ("-1", None, "at least 0"),
                                   ("20", date(2010, 1, 1), "valid_to must be after")):
        row = _stage(registry, people["maker"], rate=rate, valid_to=valid_to)
        p.validate(actor_id=people["maker"].id, staged_id=row.id)
        assert row.status == StagedRateStatus.VALIDATION_FAILED
        assert any(needle in e for e in row.validation_errors)
        p.reject(actor_id=people["checker"].id, staged_id=row.id, reason="test cleanup")


def test_amend_cannot_clear_required_fields(db_session, registry, people):
    row = _stage(registry, people["maker"])
    with pytest.raises(BadRequestException):
        registry["pipeline"].amend(actor_id=people["maker"].id, staged_id=row.id, changes={"tax_code": None})


def test_amend_resets_review_state(db_session, registry, people):
    p = registry["pipeline"]
    row = _stage(registry, people["maker"], valid_from=None)
    p.validate(actor_id=people["maker"].id, staged_id=row.id)
    assert row.status == StagedRateStatus.VALIDATION_FAILED
    p.amend(actor_id=people["maker"].id, staged_id=row.id, changes={"valid_from": date(2011, 1, 4)})
    assert row.status == StagedRateStatus.PENDING_REVIEW and row.validation_errors is None
    p.validate(actor_id=people["maker"].id, staged_id=row.id)
    assert row.status == StagedRateStatus.VALIDATED


def test_six_decimal_rate_round_trips_exactly(db_session, registry, people):
    version = _publish(registry, people, rate="8.875")
    db_session.expire_all()
    assert db_session.get(TaxRateVersion, version.id).rate_percent == Decimal("8.875000")


# ── AI proposals (§06.2, §12.2) ─────────────────────────────────────────

def test_ai_proposal_needs_a_human_maker_before_approval(db_session, registry, people):
    p = registry["pipeline"]
    row = _stage(registry, None, origin=StagingOrigin.AI_PROPOSAL)
    p.validate(actor_id=None, staged_id=row.id)
    assert row.status == StagedRateStatus.VALIDATED
    with pytest.raises(MakerCheckerError):
        p.submit(actor_id=people["maker"].id, staged_id=row.id, reason="looks right")

    p.adopt(actor_id=people["maker"].id, staged_id=row.id)
    assert row.status == StagedRateStatus.PENDING_REVIEW          # must be re-validated after adoption
    p.validate(actor_id=people["maker"].id, staged_id=row.id)
    with pytest.raises(MakerCheckerError):                         # only the adopter may submit
        p.submit(actor_id=people["maker2"].id, staged_id=row.id, reason="r")
    p.submit(actor_id=people["maker"].id, staged_id=row.id, reason="Adopted and verified")
    with pytest.raises(MakerCheckerError):
        p.approve(actor_id=people["maker"].id, staged_id=row.id)
    p.approve(actor_id=people["checker"].id, staged_id=row.id)
    assert row.change_approval.detector == StagingOrigin.AI_PROPOSAL


# ── T02: overlapping ACTIVE intervals ───────────────────────────────────

def test_t02_overlap_with_different_rate_is_a_conflict(db_session, registry, people):
    _publish(registry, people)
    row = _stage(registry, people["maker"], rate="17.5", valid_from=date(2020, 1, 1))
    registry["pipeline"].validate(actor_id=people["maker"].id, staged_id=row.id)
    assert row.status == StagedRateStatus.CONFLICT_ESCALATED


def test_t02_overlap_with_same_rate_is_a_duplicate(db_session, registry, people):
    _publish(registry, people)
    row = _stage(registry, people["maker"], valid_from=date(2020, 1, 1))
    registry["pipeline"].validate(actor_id=people["maker"].id, staged_id=row.id)
    assert row.status == StagedRateStatus.VALIDATION_FAILED
    assert any("duplicate" in e for e in row.validation_errors)


def test_t02_adjacent_intervals_do_not_overlap(db_session, registry, people):
    _publish(registry, people, rate="17.5", valid_from=date(2008, 12, 1), valid_to=date(2010, 1, 1))
    version = _publish(registry, people, rate="15", valid_from=date(2010, 1, 1), valid_to=date(2011, 1, 4))
    assert version.status == RateVersionStatus.ACTIVE


def test_t02_cumulative_components_may_overlap(db_session, registry, people):
    _publish(registry, people, component=registry["cumulative"], rate="1")
    second = _publish(registry, people, component=registry["cumulative"], rate="0.5", valid_from=date(2015, 1, 1))
    assert second.status == RateVersionStatus.ACTIVE


def test_t02_duplicate_staged_proposals_block_each_other(db_session, registry, people):
    p = registry["pipeline"]
    first = _stage(registry, people["maker"], rate="20")
    second = _stage(registry, people["maker"], rate="20", valid_from=date(2012, 1, 1))
    p.validate(actor_id=people["maker"].id, staged_id=first.id)
    assert first.status == StagedRateStatus.VALIDATION_FAILED
    assert any(f"staged proposal {second.id}" in e for e in first.validation_errors)
    p.reject(actor_id=people["checker"].id, staged_id=second.id, reason="duplicate")
    p.validate(actor_id=people["maker"].id, staged_id=first.id)
    assert first.status == StagedRateStatus.VALIDATED


def test_t02_publish_rechecks_overlap(db_session, registry, people):
    p = registry["pipeline"]
    row = _stage(registry, people["maker"], rate="20")
    p.validate(actor_id=people["maker"].id, staged_id=row.id)
    p.submit(actor_id=people["maker"].id, staged_id=row.id, reason="r")
    p.approve(actor_id=people["checker"].id, staged_id=row.id)
    # A concurrent publisher commits an overlapping version between approval and publish.
    now = datetime.now(timezone.utc)
    db_session.add(TaxRateVersion(
        component_id=registry["component"].id, jurisdiction_id=registry["gb"].id, tax_code="STANDARD",
        product_scope="GENERAL", rate_kind=RateKind.STANDARD, rate_percent=Decimal("19"),
        valid_from=date(2011, 6, 1), observed_at=now, approved_at=now, published_at=now, activated_at=now,
        is_cumulative=False, source_revision_id=registry["source"].id, evidence_status=EvidenceStatus.CAPTURED,
        owner="x", staged_rate_id=row.id, change_approval_id=row.change_approval_id,
    ))
    db_session.flush()
    with pytest.raises(RegistryStateError):
        p.publish(actor_id=people["checker"].id, staged_id=row.id)
    assert row.status == StagedRateStatus.APPROVED


# ── T11: conflicting source escalates, prior version stays active ───────

def test_t11_conflicting_source_escalates_and_keeps_prior_version(db_session, registry, people):
    original = _publish(registry, people)
    p = registry["pipeline"]
    feed = _stage(registry, None, rate="21", valid_from=date(2026, 1, 1), origin=StagingOrigin.OFFICIAL_FEED)
    p.validate(actor_id=None, staged_id=feed.id)

    assert feed.status == StagedRateStatus.CONFLICT_ESCALATED
    assert "different rate" in feed.escalation_reason
    item = db_session.query(AttentionItem).filter(AttentionItem.source == "tax_registry").one()
    assert "GB-VAT" in item.title
    with pytest.raises(RegistryStateError):
        p.submit(actor_id=people["maker"].id, staged_id=feed.id, reason="r")

    assert original.status == RateVersionStatus.ACTIVE
    result = RegistryReadService(db_session).lookup_rates(jurisdiction_id=registry["gb"].id, as_of=date(2026, 6, 1))
    assert [i["id"] for i in result["items"]] == [original.id]
    assert result["items"][0]["rate_percent"] == Decimal("20")


def test_t11_two_staged_sources_disagreeing_both_stay_unpublished(db_session, registry, people):
    p = registry["pipeline"]
    a = _stage(registry, None, rate="20", origin=StagingOrigin.OFFICIAL_FEED)
    b = _stage(registry, None, rate="21", origin=StagingOrigin.LICENSED_FEED)
    p.validate(actor_id=None, staged_id=a.id)
    p.validate(actor_id=None, staged_id=b.id)
    assert a.status == StagedRateStatus.CONFLICT_ESCALATED
    assert b.status == StagedRateStatus.CONFLICT_ESCALATED
    assert db_session.query(TaxRateVersion).count() == 0


# ── T04: corrections are new versions; history is preserved ────────────

def test_t04_correction_supersedes_without_rewriting(db_session, registry, people):
    original = _publish(registry, people, rate="20")
    db_session.flush()
    before_correction = datetime.now(timezone.utc)
    original_snapshot = (original.rate_percent, original.valid_from, original.valid_to, original.source_revision_id)

    # Retroactive notice covering the same interval as the version it replaces.
    correction = _publish(registry, people, rate="20.5", supersedes=original.id)

    assert correction.predecessor_id == original.id
    assert original.status == RateVersionStatus.SUPERSEDED and original.superseded_at is not None
    assert (original.rate_percent, original.valid_from, original.valid_to, original.source_revision_id) == original_snapshot

    reader = RegistryReadService(db_session)
    now = reader.lookup_rates(jurisdiction_id=registry["gb"].id, as_of=date(2020, 1, 1))
    assert [i["id"] for i in now["items"]] == [correction.id]
    then = reader.lookup_rates(jurisdiction_id=registry["gb"].id, as_of=date(2020, 1, 1), known_at=before_correction)
    assert [i["id"] for i in then["items"]] == [original.id]
    assert then["items"][0]["rate_percent"] == Decimal("20")


def test_t04_end_dating_is_a_new_version(db_session, registry, people):
    original = _publish(registry, people, rate="20")
    ended = _publish(registry, people, rate="20", valid_to=date(2027, 1, 1), supersedes=original.id)
    successor = _publish(registry, people, rate="22", valid_from=date(2027, 1, 1))
    reader = RegistryReadService(db_session)
    assert reader.lookup_rates(jurisdiction_id=registry["gb"].id, as_of=date(2026, 12, 31))["items"][0]["id"] == ended.id
    assert reader.lookup_rates(jurisdiction_id=registry["gb"].id, as_of=date(2027, 1, 1))["items"][0]["id"] == successor.id


def test_superseded_version_cannot_be_superseded_again(db_session, registry, people):
    original = _publish(registry, people)
    _publish(registry, people, rate="20.5", supersedes=original.id)
    row = _stage(registry, people["maker"], rate="21", supersedes=original.id)
    registry["pipeline"].validate(actor_id=people["maker"].id, staged_id=row.id)
    assert any("not ACTIVE" in e for e in row.validation_errors)


# ── Future-dated ACTIVE versions (as_of + known_at) ─────────────────────

def test_future_dated_active_rate(db_session, registry, people):
    today = date.today()
    before_publish = datetime.now(timezone.utc) - timedelta(seconds=1)
    future = _publish(registry, people, rate="21", valid_from=today + timedelta(days=60))
    assert future.status == RateVersionStatus.ACTIVE

    reader = RegistryReadService(db_session)
    gb = registry["gb"].id
    assert reader.lookup_rates(jurisdiction_id=gb, as_of=today)["coverage"] == "NO_APPROVED_RATE"
    later = reader.lookup_rates(jurisdiction_id=gb, as_of=today + timedelta(days=60))
    assert [i["id"] for i in later["items"]] == [future.id]
    unknown_then = reader.lookup_rates(jurisdiction_id=gb, as_of=today + timedelta(days=60), known_at=before_publish)
    assert unknown_then["items"] == []


# ── Reference reads: unknown is never 0% ────────────────────────────────

def test_missing_rate_is_no_approved_rate_not_zero(db_session, registry):
    result = RegistryReadService(db_session).lookup_rates(jurisdiction_id=registry["gb"].id, as_of=date(2026, 1, 1))
    assert result["coverage"] == "NO_APPROVED_RATE"
    assert result["items"] == []
    assert result["mode"] == "REFERENCE_ONLY"


def test_staged_rows_are_invisible_to_reference_reads(db_session, registry, people):
    _stage(registry, people["maker"])
    result = RegistryReadService(db_session).lookup_rates(jurisdiction_id=registry["gb"].id, as_of=date(2026, 1, 1))
    assert result["items"] == []


def test_multi_timezone_jurisdiction_requires_explicit_as_of(db_session, registry):
    with pytest.raises(BadRequestException):
        RegistryReadService(db_session).lookup_rates(jurisdiction_id=registry["multi"].id)


def test_jurisdiction_listing_reports_status_never_production(db_session, registry, people):
    _publish(registry, people)
    items = {j["code"]: j for j in RegistryReadService(db_session).list_jurisdictions()}
    assert items["GB"]["reference_status"] == "REFERENCE_ONLY"
    assert items["CA"]["reference_status"] == "NO_APPROVED_RATES"
    assert all(j["production_calculation"] == "NOT_ACTIVATED" for j in items.values())


# ── No tenant data on registry endpoints (§09.1, §11.1) ─────────────────

def test_registry_endpoints_carry_no_tenant_data(db_session, registry, people):

    org = make_organization(db_session, code="TENANT1")
    org.tax_no = "GB999888777"
    entity = LegalEntityService(db_session).ensure_default_entity(org.id)
    customer = make_customer(db_session, org.id)
    make_invoice(db_session, org.id, customer.id)
    tenant_user = User(email="admin@tenant.example", hashed_password="x", role=UserRole.BILLING_ADMIN,
                       organization_id=org.id, first_name="Tina", last_name="Tenant")
    db_session.add(tenant_user)
    _publish(registry, people)
    db_session.flush()

    jurisdictions = registry_router.list_jurisdictions(country=None, level=None, parent_code=None,
                                                       db=db_session, _user=tenant_user)
    rates = registry_router.lookup_rates(jurisdiction_id=registry["gb"].id, tax_code=None, as_of=date(2026, 1, 1),
                                         known_at=None, db=db_session, _user=tenant_user)
    blob = json.dumps([
        RegistryJurisdictionListResponse.model_validate(jurisdictions).model_dump(mode="json"),
        RateLookupResponse.model_validate(rates).model_dump(mode="json"),
    ])
    assert entity.primary_tax_id == "GB999888777"
    for secret in ("GB999888777", "TENANT1", "organization_id", "invoice", "customer"):
        assert secret not in blob
    # Public source summary: no artifact, hash, storage location or internal notes.
    for private in (registry["source"].sha256, "db://", "internal_notes", "sha256", "artifact"):
        assert private not in blob
    assert "Mara" not in blob and "Maker" not in blob    # Phase 8 burn-down: the team, never a person
    assert "Zoiko Tax Review" in blob


def test_public_source_summary_is_an_allow_list(registry):
    assert set(public_source_summary(registry["source"])) == {
        "authority", "title", "permanent_url", "citation", "reviewed_by", "reviewed_at",
    }


# ── Roles, capabilities, tenant isolation (T13) ─────────────────────────

def test_tax_capabilities_are_split_and_explicit_only(db_session, people):
    admin = _staff(db_session, "pa@tax.example", PlatformRole.PLATFORM_ADMINISTRATOR)
    auditor = _staff(db_session, "aud@tax.example", PlatformRole.AUDITOR)
    maker, checker = people["maker"], people["checker"]

    assert has_capability(maker, "tax_registry.write") and not has_capability(maker, "tax_registry.approve")
    assert has_capability(checker, "tax_registry.approve") and not has_capability(checker, "tax_registry.write")
    assert has_capability(maker, "tax_registry.read") and has_capability(checker, "tax_registry.read")
    for cap in ("tax_registry.read", "tax_registry.write", "tax_registry.approve"):
        assert not has_capability(admin, cap)
        assert not has_capability(auditor, cap)
    # Tax roles gain nothing else on the Command Center.
    assert not has_capability(maker, "audit.read") and not has_capability(checker, "circuit_breaker.manage")


def test_tenant_users_cannot_reach_privileged_source_evidence(db_session, registry):
    org = make_organization(db_session, code="TENANT2")
    tenant_admin = User(email="t2@tenant.example", hashed_password="x", role=UserRole.ORG_ADMIN,
                        organization_id=org.id, first_name="T", last_name="Two")
    db_session.add(tenant_admin)
    db_session.flush()
    dependency = require_capability("tax_registry.read")
    with pytest.raises(ForbiddenException):
        dependency(request=None, db=db_session, current_user=tenant_admin)


# ── MFA step-up on approve/publish ──────────────────────────────────────

def test_approve_requires_step_up_even_while_platform_step_up_is_retired(db_session, registry, people):
    from app.config import settings

    assert settings.MFA_STEP_UP_ENABLED is False
    p = registry["pipeline"]
    row = _stage(registry, people["maker"])
    p.validate(actor_id=people["maker"].id, staged_id=row.id)
    p.submit(actor_id=people["maker"].id, staged_id=row.id, reason="r")
    db_session.commit()

    with pytest.raises(BadRequestException, match="step-up is required"):
        registry_router.approve_staged_rate(staged_id=row.id, data=StepUpRequest(), db=db_session,
                                            current_user=people["checker"])
    with pytest.raises(BadRequestException, match="MFA is not enabled"):
        registry_router.approve_staged_rate(staged_id=row.id, data=StepUpRequest(code="123456"), db=db_session,
                                            current_user=people["checker"])
    db_session.refresh(row)
    assert row.status == StagedRateStatus.IN_APPROVAL


def test_publish_requires_step_up(db_session, registry, people):
    p = registry["pipeline"]
    row = _stage(registry, people["maker"])
    p.validate(actor_id=people["maker"].id, staged_id=row.id)
    p.submit(actor_id=people["maker"].id, staged_id=row.id, reason="r")
    p.approve(actor_id=people["checker"].id, staged_id=row.id)
    db_session.commit()
    with pytest.raises(BadRequestException, match="step-up is required"):
        registry_router.publish_staged_rate(staged_id=row.id, data=StepUpRequest(), db=db_session,
                                            current_user=people["checker"])
    assert db_session.query(TaxRateVersion).count() == 0


def test_readiness_counts_real_mfa_enrolment_not_the_retired_flag(db_session, people):
    from app.modules.auth.models import SuperAdminMFA

    status = registry_router.registry_readiness(db=db_session, _user=people["maker"])
    assert status["step_up_required"] is True
    assert status["active_reviewers"] == 2 and status["active_publishers"] == 1
    assert status["publishers_with_mfa"] == 0 and status["ready"] is False

    db_session.add(SuperAdminMFA(user_id=people["checker"].id, secret_encrypted="x", is_enabled=True))
    db_session.flush()
    status = registry_router.registry_readiness(db=db_session, _user=people["maker"])
    assert status["publishers_with_mfa"] == 1 and status["ready"] is True


def test_step_up_flag_is_environment_only():
    """TAX_REGISTRY_STEP_UP_REQUIRED comes from Settings (environment) and no
    app code assigns to settings at runtime: PlatformSetting rows are a
    separate key/value store that is never applied to app.config.settings."""
    import pathlib
    import re

    app_dir = pathlib.Path(__file__).resolve().parent.parent / "app"
    writers = re.compile(r"setattr\(\s*settings|settings\.[A-Z_]+\s*=(?!=)")
    offenders = [
        f"{path.relative_to(app_dir)}:{n}"
        for path in app_dir.rglob("*.py")
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1)
        if writers.search(line)
    ]
    assert offenders == []


def test_tenant_purge_never_touches_registry_evidence(db_session, registry, people):
    from app.modules.super_admin.organization_purge_service import OrganizationPurgeService

    version = _publish(registry, people)
    org = make_organization(db_session, code="PURGEME")
    db_session.add(User(email="owner@purge.example", hashed_password="x", role=UserRole.ORG_ADMIN,
                        organization_id=org.id, first_name="P", last_name="Urge"))
    db_session.flush()
    admin = _staff(db_session, "purger@tax.example", PlatformRole.PLATFORM_ADMINISTRATOR)
    before = {t: db_session.execute(Base.metadata.tables[t].select()).fetchall() for t in REGISTRY_TABLES}

    result = OrganizationPurgeService(db_session).purge(org, actor=admin, reason="erasure test")

    assert not set(REGISTRY_TABLES) & set(result.per_table)
    for table in REGISTRY_TABLES:
        assert db_session.execute(Base.metadata.tables[table].select()).fetchall() == before[table], table
    assert db_session.get(TaxRateVersion, version.id).status == RateVersionStatus.ACTIVE


# ── ORM immutability guard (Postgres triggers: see the _pg test module) ──

def test_published_version_fields_cannot_be_changed_through_the_orm(db_session, registry, people):
    version_id = _publish(registry, people).id
    db_session.commit()
    for field, value in (("rate_percent", Decimal("25")), ("valid_from", date(2000, 1, 1)),
                         ("source_revision_id", None), ("valid_to", date(2030, 1, 1))):
        version = db_session.get(TaxRateVersion, version_id)
        setattr(version, field, value)
        with pytest.raises(RegistryImmutabilityError):
            db_session.flush()
        db_session.rollback()
    version = db_session.get(TaxRateVersion, version_id)
    assert version.rate_percent == Decimal("20") and version.valid_to is None
    # The one permitted transition still works.
    version.status = RateVersionStatus.SUPERSEDED
    version.superseded_at = datetime.now(timezone.utc)
    db_session.flush()


def test_published_version_cannot_be_deleted_through_the_orm(db_session, registry, people):
    version = _publish(registry, people)
    db_session.flush()
    db_session.delete(version)
    with pytest.raises(RegistryImmutabilityError):
        db_session.flush()


def test_source_revision_is_frozen_after_evidence(db_session, registry):
    source = registry["source"]
    source.citation = "rewritten"
    with pytest.raises(RegistryImmutabilityError):
        db_session.flush()


def test_source_revision_only_evidence_fields_change_before_capture(db_session, registry):
    bare = _source(registry["pipeline"], registry["authority"].id, url="https://www.gov.uk/vat-rates")
    db_session.flush()
    bare.permanent_url = "https://example.com/elsewhere"
    with pytest.raises(RegistryImmutabilityError):
        db_session.flush()


# ── Migration chain ─────────────────────────────────────────────────────

def test_migration_chain_has_a_single_head():
    from pathlib import Path

    from alembic.config import Config
    from alembic.script import ScriptDirectory

    backend = Path(__file__).resolve().parent.parent
    config = Config(str(backend / "alembic.ini"))
    config.set_main_option("script_location", str(backend / "alembic"))
    script = ScriptDirectory.from_config(config)
    assert len(script.get_heads()) == 1
    assert script.get_revision("b3d8f2a6c1e4").down_revision == "a7c4e1b9d3f0"
