"""
Global Tax Reference Registry HTTP API (ZB-TAX-ARCH-001 Phase 1, §09.1, §10.1).

reference_router — /api/v1/tax
    GET /jurisdictions, GET /rates: any authenticated user. Platform reference
    facts only: no tenant dependency, no tenant data, never an amount owed.
    GET /source-revisions/{id}: privileged evidence lookup, TAX_REVIEWER /
    TAX_PUBLISHER only (super-admin roles; tenants never see artifacts).

admin_router — /api/v1/super-admin/tax-registry
    The staging -> validation -> maker-checker -> publish pipeline.
    TAX_REVIEWER (maker): register sources, attach evidence, stage, amend,
    adopt AI proposals, validate, submit. TAX_PUBLISHER (checker): approve,
    reject, publish — approve and publish need a fresh MFA factor. Neither
    capability is implied by PLATFORM_ADMINISTRATOR.
"""
import logging
from datetime import date, datetime
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile, status
from sqlalchemy.orm import Session

from app.config import settings
from app.core.capabilities import require_any_capability, require_capability
from app.core.dependencies import get_current_user
from app.core.exceptions import BadRequestException, ForbiddenException
from app.database import get_db
from app.modules.tax.enums import JurisdictionLevel, RedistributionPermission, StagedRateStatus, StagingOrigin
from app.modules.tax.pagination import PageParams, decode_cursor, encode_cursor, paginate
from app.modules.tax.registry_models import TaxLegalSourceRevision, TaxRateStaging
from app.modules.tax.registry_schemas import (
    AmendRateRequest,
    PublishedRateResponse,
    RateLookupResponse,
    RegistryReadinessResponse,
    RegisterSourceRevisionRequest,
    RegistryJurisdictionListResponse,
    RejectRateRequest,
    SourceRevisionDetail,
    SourceRevisionListResponse,
    StagedRateListResponse,
    StagedRateResponse,
    StageRateRequest,
    StepUpRequest,
    SubmitRateRequest,
)
from app.modules.tax.enums import PlatformVersionStatus
from app.modules.tax.policy_models import (
    TaxActivationCancellation, TaxCodeSetVersion, TaxMarketAvailabilityVersion, TaxRulePackVersion,
)
from app.modules.tax.policy_schemas import ShadowSelectionRequest  # Phase 7
from app.modules.tax.policy_schemas import (
    ActivationCancelRequest,
    AvailabilityAmendRequest,
    RollbackProposeRequest,
    AvailabilityDraftRequest,
    CodeSetDraftRequest,
    PolicyActionRequest,
    RulePackAmendRequest,
    RulePackRegisterRequest,
    TaxCodeUpsertRequest,
)
from app.modules.tax.policy_service import (
    ActivationCancellationService,
    MarketAvailabilityService,
    RulePackService,
    TaxCodeSetService,
    source_dependency_status,
    view_availability,
    view_cancellation,
    view_code_set,
    view_rule_pack,
)
from app.modules.tax.registry_service import (
    RegistryReadService,
    TaxRegistryPipeline,
    privileged_source_view,
)

logger = logging.getLogger("zoiko_billing.tax.registry")

reference_router = APIRouter(prefix="/api/v1/tax", tags=["🧾 Tax Reference Registry"])
admin_router = APIRouter(prefix="/api/v1/super-admin/tax-registry", tags=["🧾 Tax Reference Registry (admin)"])


def staged_view(row) -> dict:
    data = {c.key: getattr(row, c.key) for c in row.__table__.columns if c.key in StagedRateResponse.model_fields}
    for key in ("origin", "rate_kind", "status"):
        value = data.get(key)
        data[key] = value.name if hasattr(value, "name") else value
    return data


class TaxStepUpRequired(BadRequestException):
    """400 with error code TAX_REGISTRY_STEP_UP_REQUIRED (Phase 5a): the
    Tax Control Center prompts for a code and retries the action once."""

    def __init__(self, message: str):
        from app.core.exceptions import ZoikoException

        ZoikoException.__init__(self, status_code=400, error_code="TAX_REGISTRY_STEP_UP_REQUIRED", message=message)


def require_tax_step_up(db: Session, user, data: StepUpRequest) -> None:
    """Approve/publish always need a fresh factor, even while platform-wide
    step-up is retired (MFA_STEP_UP_ENABLED off). Must run before any
    registry mutation: verify_step_up commits the session."""
    from app.config import step_up_bypass_active
    from app.modules.auth.mfa_service import verify_step_up

    if not settings.TAX_REGISTRY_STEP_UP_REQUIRED:
        logger.warning("TAX_REGISTRY_STEP_UP_REQUIRED is off: tax registry decision by user %s without step-up.", user.id)
        return
    if step_up_bypass_active():
        verify_step_up(db, user, code=data.code, recovery_code=data.recovery_code, enforce_when_retired=True)
        return
    from app.modules.auth.mfa_service import refuse_new_factor_for_tax

    refuse_new_factor_for_tax(db, user, "tax_registry")              # Phase 5d-F cooling-off
    if not (data.code or data.recovery_code):
        raise TaxStepUpRequired("MFA step-up is required: provide a current authenticator code or a recovery code.")
    verify_step_up(db, user, code=data.code, recovery_code=data.recovery_code, enforce_when_retired=True)


# ── Public reference reads ──────────────────────────────────────────────

@reference_router.get("/jurisdictions", response_model=RegistryJurisdictionListResponse,
                      summary="Reference jurisdictions with support and freshness status")
def list_jurisdictions(
    country: Optional[str] = Query(None, max_length=2),
    level: Optional[JurisdictionLevel] = Query(None),
    parent_code: Optional[str] = Query(None, max_length=20),
    page: PageParams = Depends(),
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
    items = RegistryReadService(db).list_jurisdictions(country=country, level=level, parent_code=parent_code)
    items, next_cursor = paginate(items, page, key=lambda j: j["id"])
    return {"items": items, "next_cursor": next_cursor}


@reference_router.get("/coverage", summary="Published tax coverage (supported / limited / unsupported)")
def tax_coverage(
    state: Optional[str] = Query(None, pattern="^(SUPPORTED|LIMITED|UNSUPPORTED)$"),
    page: PageParams = Depends(),
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
    """Launch gate 07: what is approved, for Sales, Support and tenants.
    Published availability only; no drafts, gate evidence or tenant data."""
    from app.modules.tax.policy_service import COVERAGE_STATEMENT, coverage

    items = [c for c in coverage(db) if state is None or c["state"] == state]
    items, next_cursor = paginate(items, page,
                                  key=lambda c: f"{c['jurisdiction_code']}|{c['tax_type']}|{c['transaction_class']}")
    return {"statement": COVERAGE_STATEMENT, "items": items, "next_cursor": next_cursor}


@reference_router.get("/tax-types", summary="Reference tax types (for tenant pickers)")
def reference_tax_types(page: PageParams = Depends(), db: Session = Depends(get_db),
                        _user=Depends(get_current_user)):
    """Phase 5b: platform reference data (code and name), like jurisdictions."""
    from app.modules.tax.registry_models import TaxTypeDefinition

    rows, next_cursor = paginate(db.query(TaxTypeDefinition).order_by(TaxTypeDefinition.code,
                                                                      TaxTypeDefinition.id).all(), page)
    return {"items": [{"id": r.id, "code": r.code, "name": r.name} for r in rows], "next_cursor": next_cursor}


@reference_router.get("/rates", response_model=RateLookupResponse,
                      summary="Reference rate lookup (never an amount owed)")
def lookup_rates(
    jurisdiction_id: int = Query(...),
    tax_code: Optional[str] = Query(None, max_length=50),
    as_of: Optional[date] = Query(None, description="Jurisdiction-local legal date; defaults to today there"),
    known_at: Optional[datetime] = Query(None, description="Knowledge time (UTC); defaults to now"),
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
    return RegistryReadService(db).lookup_rates(
        jurisdiction_id=jurisdiction_id, tax_code=tax_code, as_of=as_of, known_at=known_at,
    )


@reference_router.get("/source-revisions/{revision_id}", response_model=SourceRevisionDetail,
                      summary="Privileged legal-source evidence lookup")
def get_source_revision(
    revision_id: int,
    db: Session = Depends(get_db),
    _user=Depends(require_capability("tax_registry.read")),
):
    return privileged_source_view(RegistryReadService(db).get_source_revision(revision_id))


# ── Readiness ───────────────────────────────────────────────────────────

@admin_router.get("/readiness", response_model=RegistryReadinessResponse,
                  summary="Are enough distinct, MFA-enrolled people in place to publish?")
def registry_readiness(
    db: Session = Depends(get_db),
    _user=Depends(require_capability("tax_registry.read")),
):
    """/auth/mfa/status reports enabled=True while platform step-up is retired,
    so it cannot show whether a TAX_PUBLISHER can pass the registry's
    always-on step-up. This reports actual enrolment."""
    from app.modules.auth.models import PlatformRole, User, UserRole
    from app.modules.auth.mfa_service import is_mfa_enabled

    def _active(role):
        return db.query(User).filter(
            User.role == UserRole.SUPER_ADMIN, User.platform_role == role, User.is_active.is_(True),
        ).all()

    reviewers = _active(PlatformRole.TAX_REVIEWER)
    publishers = _active(PlatformRole.TAX_PUBLISHER)
    publishers_mfa = sum(1 for u in publishers if is_mfa_enabled(db, u.id))
    step_up = bool(settings.TAX_REGISTRY_STEP_UP_REQUIRED)
    return {
        "step_up_required": step_up,
        "active_reviewers": len(reviewers),
        "active_publishers": len(publishers),
        "publishers_with_mfa": publishers_mfa,
        "reviewers_with_mfa": sum(1 for u in reviewers if is_mfa_enabled(db, u.id)),
        "ready": bool(reviewers) and (publishers_mfa > 0 if step_up else bool(publishers)),
    }


# ── Sources ─────────────────────────────────────────────────────────────

@admin_router.get("/source-revisions", response_model=SourceRevisionListResponse)
def list_source_revisions(
    page: PageParams = Depends(),
    db: Session = Depends(get_db),
    _user=Depends(require_capability("tax_registry.read")),
):
    rows, next_cursor = paginate(db.query(TaxLegalSourceRevision).order_by(TaxLegalSourceRevision.id).all(), page)
    return {"items": [privileged_source_view(r) for r in rows], "next_cursor": next_cursor}


@admin_router.post("/source-revisions", response_model=SourceRevisionDetail, status_code=status.HTTP_201_CREATED)
def register_source_revision(
    data: RegisterSourceRevisionRequest,
    db: Session = Depends(get_db),
    current_user=Depends(require_capability("tax_registry.write")),
):
    revision = TaxRegistryPipeline(db).register_source_revision(actor_id=current_user.id, **data.model_dump())
    db.commit()
    db.refresh(revision)
    return privileged_source_view(revision)


@admin_router.post("/source-revisions/{revision_id}/evidence", response_model=SourceRevisionDetail)
def attach_source_evidence(
    revision_id: int,
    file: UploadFile = File(...),
    redistribution_permission: RedistributionPermission = Form(...),
    db: Session = Depends(get_db),
    current_user=Depends(require_capability("tax_registry.write")),
):
    """Upload the captured artifact. The server computes the SHA-256 and sets
    retrieved_at and the storage location; no client-supplied hash exists."""
    try:
        content = file.file.read()
    finally:
        file.file.seek(0)
    revision = TaxRegistryPipeline(db).attach_evidence(
        actor_id=current_user.id, revision_id=revision_id, content=content,
        media_type=file.content_type or "application/octet-stream", filename=file.filename,
        redistribution_permission=redistribution_permission,
    )
    db.commit()
    db.refresh(revision)
    return privileged_source_view(revision)


# ── Staging pipeline ────────────────────────────────────────────────────

@admin_router.get("/staged-rates", response_model=StagedRateListResponse)
def list_staged_rates(
    status_filter: Optional[StagedRateStatus] = Query(None, alias="status"),
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
    cursor: Optional[str] = Query(None, max_length=512, description="next_cursor of the previous page"),
    db: Session = Depends(get_db),
    _user=Depends(require_capability("tax_registry.read")),
):
    # Keeps its existing skip/limit (default 100, max 500); cursor is additive.
    query = db.query(TaxRateStaging)
    if status_filter is not None:
        query = query.filter(TaxRateStaging.status == status_filter)
    total = query.count()
    after = decode_cursor(cursor)
    query = query.order_by(TaxRateStaging.id)
    query = query.filter(TaxRateStaging.id > int(after)) if after is not None else query.offset(skip)
    rows = query.limit(limit + 1).all()
    more = len(rows) > limit
    rows = rows[:limit]
    return {"items": [staged_view(r) for r in rows], "total": total,
            "next_cursor": encode_cursor(rows[-1].id) if more and rows else None}


@admin_router.get("/staged-rates/{staged_id}", response_model=StagedRateResponse)
def get_staged_rate(
    staged_id: int,
    db: Session = Depends(get_db),
    _user=Depends(require_capability("tax_registry.read")),
):
    return staged_view(TaxRegistryPipeline(db).get_staged(staged_id))


@admin_router.get("/staged-rates/{staged_id}/comparison",
                  summary="Old and new side by side: the staged rate, the rate(s) it replaces or overlaps, checks")
def compare_staged_rate(
    staged_id: int,
    db: Session = Depends(get_db),
    _user=Depends(require_capability("tax_registry.read")),
):
    """Phase 5a (P3 change review). Read-only; platform data only."""
    pipeline = TaxRegistryPipeline(db)
    row = pipeline.get_staged(staged_id)
    return {"staged": staged_view(row), **pipeline.comparison(row)}


@admin_router.post("/staged-rates", response_model=StagedRateResponse, status_code=status.HTTP_201_CREATED)
def stage_rate(
    data: StageRateRequest,
    db: Session = Depends(get_db),
    current_user=Depends(require_capability("tax_registry.write")),
):
    payload = data.model_dump()
    row = TaxRegistryPipeline(db).stage(
        actor_id=current_user.id, origin=StagingOrigin.MANUAL,
        raw_payload=data.model_dump(mode="json"), **payload,
    )
    db.commit()
    db.refresh(row)
    return staged_view(row)


@admin_router.patch("/staged-rates/{staged_id}", response_model=StagedRateResponse)
def amend_staged_rate(
    staged_id: int,
    data: AmendRateRequest,
    db: Session = Depends(get_db),
    current_user=Depends(require_capability("tax_registry.write")),
):
    row = TaxRegistryPipeline(db).amend(
        actor_id=current_user.id, staged_id=staged_id, changes=data.model_dump(exclude_unset=True),
    )
    db.commit()
    db.refresh(row)
    return staged_view(row)


@admin_router.post("/staged-rates/{staged_id}/adopt", response_model=StagedRateResponse)
def adopt_ai_proposal(
    staged_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(require_capability("tax_registry.write")),
):
    row = TaxRegistryPipeline(db).adopt(actor_id=current_user.id, staged_id=staged_id)
    db.commit()
    db.refresh(row)
    return staged_view(row)


@admin_router.post("/staged-rates/{staged_id}/validate", response_model=StagedRateResponse)
def validate_staged_rate(
    staged_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(require_capability("tax_registry.write")),
):
    row = TaxRegistryPipeline(db).validate(actor_id=current_user.id, staged_id=staged_id)
    db.commit()
    db.refresh(row)
    return staged_view(row)


@admin_router.post("/staged-rates/{staged_id}/submit", response_model=StagedRateResponse)
def submit_staged_rate(
    staged_id: int,
    data: SubmitRateRequest,
    db: Session = Depends(get_db),
    current_user=Depends(require_capability("tax_registry.write")),
):
    row = TaxRegistryPipeline(db).submit(actor_id=current_user.id, staged_id=staged_id, reason=data.reason)
    db.commit()
    db.refresh(row)
    return staged_view(row)


@admin_router.post("/staged-rates/{staged_id}/approve", response_model=StagedRateResponse)
def approve_staged_rate(
    staged_id: int,
    data: StepUpRequest,
    db: Session = Depends(get_db),
    current_user=Depends(require_capability("tax_registry.approve")),
):
    require_tax_step_up(db, current_user, data)
    row = TaxRegistryPipeline(db).approve(actor_id=current_user.id, staged_id=staged_id)
    db.commit()
    db.refresh(row)
    return staged_view(row)


@admin_router.post("/staged-rates/{staged_id}/reject", response_model=StagedRateResponse)
def reject_staged_rate(
    staged_id: int,
    data: RejectRateRequest,
    db: Session = Depends(get_db),
    current_user=Depends(require_capability("tax_registry.approve")),
):
    row = TaxRegistryPipeline(db).reject(actor_id=current_user.id, staged_id=staged_id, reason=data.reason)
    db.commit()
    db.refresh(row)
    return staged_view(row)


@admin_router.post("/staged-rates/{staged_id}/publish", response_model=PublishedRateResponse)
def publish_staged_rate(
    staged_id: int,
    data: StepUpRequest,
    db: Session = Depends(get_db),
    current_user=Depends(require_capability("tax_registry.approve")),
):
    require_tax_step_up(db, current_user, data)
    pipeline = TaxRegistryPipeline(db)
    version = pipeline.publish(actor_id=current_user.id, staged_id=staged_id)
    db.commit()
    row = pipeline.get_staged(staged_id)
    return {"staged_rate": staged_view(row), "rate_version_id": version.id, "predecessor_id": version.predecessor_id}


# ═════════════════════════════════════════════════════════════════════════
# Phase 2 — platform market availability and tax-code taxonomy
# Same roles and controls as rates: TAX_REVIEWER drafts/validates/submits;
# a different TAX_PUBLISHER approves and publishes with MFA step-up.
# ═════════════════════════════════════════════════════════════════════════

@admin_router.get("/market-availability", summary="List market availability versions")
def list_market_availability(
    status_filter: Optional[PlatformVersionStatus] = Query(None, alias="status"),
    page: PageParams = Depends(),
    db: Session = Depends(get_db),
    _user=Depends(require_capability("tax_registry.read")),
):
    q = db.query(TaxMarketAvailabilityVersion)
    if status_filter is not None:
        q = q.filter(TaxMarketAvailabilityVersion.status == status_filter)
    rows, next_cursor = paginate(q.order_by(TaxMarketAvailabilityVersion.id).all(), page)
    return {"items": [view_availability(r) for r in rows], "next_cursor": next_cursor}


@admin_router.post("/market-availability", status_code=status.HTTP_201_CREATED, summary="Draft a market availability version")
def draft_market_availability(
    data: AvailabilityDraftRequest,
    db: Session = Depends(get_db),
    current_user=Depends(require_capability("tax_registry.write")),
):
    payload = data.model_dump(exclude_none=True)
    row = MarketAvailabilityService(db).draft(actor_id=current_user.id, **payload)
    db.commit()
    return view_availability(row)


@admin_router.patch("/market-availability/{version_id}", summary="Amend a draft availability version")
def amend_market_availability(
    version_id: int,
    data: AvailabilityAmendRequest,
    db: Session = Depends(get_db),
    current_user=Depends(require_capability("tax_registry.write")),
):
    row = MarketAvailabilityService(db).amend(actor_id=current_user.id, version_id=version_id,
                                              changes=data.model_dump(exclude_unset=True))
    db.commit()
    return view_availability(row)


def _availability_action(action: str, capability: str, step_up: bool):
    def handler(
        version_id: int,
        db: Session = Depends(get_db),
        current_user=Depends(require_capability(capability)),
        data: Optional[PolicyActionRequest] = None,
    ):
        data = data or PolicyActionRequest()
        if step_up:
            require_tax_step_up(db, current_user, StepUpRequest(code=data.code, recovery_code=data.recovery_code))
        svc = MarketAvailabilityService(db)
        kwargs = {"actor_id": current_user.id, "version_id": version_id}
        if action in ("submit", "reject"):
            if not (data.reason or "").strip():
                raise BadRequestException("A reason is required.")
            kwargs["reason"] = data.reason
        if action == "publish":                     # Phase 8 PR 2: now, or scheduled
            kwargs.update(activate_at_local=data.activate_at_local, timezone=data.timezone,
                          utc_offset=data.utc_offset)
        row = getattr(svc, action)(**kwargs)
        db.commit()
        return view_availability(row)
    return handler


for _action, _cap, _step_up in (("validate", "tax_registry.write", False), ("submit", "tax_registry.write", False),
                                ("approve", "tax_registry.approve", True), ("reject", "tax_registry.approve", False),
                                ("publish", "tax_registry.approve", True)):
    admin_router.add_api_route(
        f"/market-availability/{{version_id}}/{_action}", _availability_action(_action, _cap, _step_up),
        methods=["POST"], summary=f"{_action.capitalize()} a market availability version",
    )


@admin_router.get("/tax-code-sets", summary="List tax-code set versions")
def list_tax_code_sets(page: PageParams = Depends(), db: Session = Depends(get_db),
                       _user=Depends(require_capability("tax_registry.read"))):
    rows, next_cursor = paginate(db.query(TaxCodeSetVersion).order_by(TaxCodeSetVersion.id).all(), page)
    return {"items": [view_code_set(db, r) for r in rows], "next_cursor": next_cursor}


@admin_router.post("/tax-code-sets", status_code=status.HTTP_201_CREATED, summary="Draft a tax-code set version")
def draft_tax_code_set(data: CodeSetDraftRequest, db: Session = Depends(get_db),
                       current_user=Depends(require_capability("tax_registry.write"))):
    row = TaxCodeSetService(db).draft(actor_id=current_user.id, **data.model_dump())
    db.commit()
    return view_code_set(db, row)


@admin_router.put("/tax-code-sets/{version_id}/codes", summary="Add or update a tax code in a draft set")
def upsert_tax_code(version_id: int, data: TaxCodeUpsertRequest, db: Session = Depends(get_db),
                    current_user=Depends(require_capability("tax_registry.write"))):
    TaxCodeSetService(db).upsert_code(actor_id=current_user.id, version_id=version_id, **data.model_dump())
    db.commit()
    return view_code_set(db, TaxCodeSetService(db).get(version_id))


@admin_router.delete("/tax-code-sets/{version_id}/codes/{code}", summary="Remove a tax code from a draft set")
def remove_tax_code(version_id: int, code: str, db: Session = Depends(get_db),
                    current_user=Depends(require_capability("tax_registry.write"))):
    TaxCodeSetService(db).remove_code(actor_id=current_user.id, version_id=version_id, code=code)
    db.commit()
    return view_code_set(db, TaxCodeSetService(db).get(version_id))


def _code_set_action(action: str, capability: str, step_up: bool):
    def handler(
        version_id: int,
        db: Session = Depends(get_db),
        current_user=Depends(require_capability(capability)),
        data: Optional[PolicyActionRequest] = None,
    ):
        data = data or PolicyActionRequest()
        if step_up:
            require_tax_step_up(db, current_user, StepUpRequest(code=data.code, recovery_code=data.recovery_code))
        svc = TaxCodeSetService(db)
        kwargs = {"actor_id": current_user.id, "version_id": version_id}
        if action in ("submit", "reject"):
            if not (data.reason or "").strip():
                raise BadRequestException("A reason is required.")
            kwargs["reason"] = data.reason
        row = getattr(svc, action)(**kwargs)
        db.commit()
        return view_code_set(db, row)
    return handler


for _action, _cap, _step_up in (("validate", "tax_registry.write", False), ("submit", "tax_registry.write", False),
                                ("approve", "tax_registry.approve", True), ("reject", "tax_registry.approve", False),
                                ("publish", "tax_registry.approve", True)):
    admin_router.add_api_route(
        f"/tax-code-sets/{{version_id}}/{_action}", _code_set_action(_action, _cap, _step_up),
        methods=["POST"], summary=f"{_action.capitalize()} a tax-code set version",
    )


# ═════════════════════════════════════════════════════════════════════════
# Phase 3b — native rule packs (UK, Australia). Two-person review: a
# TAX_REVIEWER registers, attaches golden tests and submits; a different
# TAX_PUBLISHER (the tax lead) approves and publishes with MFA step-up.
# ═════════════════════════════════════════════════════════════════════════

@admin_router.get("/rule-packs/catalogue", summary="Native rule packs available in code, with their declarations")
def rule_pack_catalogue(db: Session = Depends(get_db), _user=Depends(require_capability("tax_registry.read"))):
    items = []
    for code, pack in sorted(RulePackService.catalogue().items()):
        declared = pack.declaration()
        declared["source_dependencies"] = [source_dependency_status(db, ref) for ref in pack.source_refs]
        items.append(declared)
    return {"items": items}


@admin_router.get("/rule-packs", summary="List rule-pack registry versions")
def list_rule_packs(page: PageParams = Depends(), db: Session = Depends(get_db),
                    _user=Depends(require_capability("tax_registry.read"))):
    rows, next_cursor = paginate(db.query(TaxRulePackVersion).order_by(TaxRulePackVersion.id).all(), page)
    return {"items": [view_rule_pack(r) for r in rows], "next_cursor": next_cursor}


# ═════════════════════════════════════════════════════════════════════════
# Tax Control Center B1 — approvals inbox (screen P8). Tax roles only;
# platform records only (no tenant data).
# ═════════════════════════════════════════════════════════════════════════

@admin_router.get("/approvals-inbox", summary="Platform tax changes awaiting approval, with can_approve per item")
def approvals_inbox(
    kind: Optional[str] = Query(None, pattern="^(staged_rate|tax_code_set|rule_pack|market_availability)$"),
    page: PageParams = Depends(),
    db: Session = Depends(get_db),
    current_user=Depends(require_capability("tax_registry.read")),
):
    from app.modules.tax.approvals_inbox import approvals_inbox as build, item_key

    items, next_cursor = paginate(build(db, current_user, kind), page, key=item_key)
    return {"items": items, "next_cursor": next_cursor}


# ═════════════════════════════════════════════════════════════════════════
# Phase 5b (G-5a-1, G-5a-3): reference pickers and tax-staff names for the
# Tax Control Center. Read-only, tax roles only, paged (B3). Creating or
# editing authorities, tax types or components stays deferred (B2).
# ═════════════════════════════════════════════════════════════════════════

@admin_router.get("/authorities", summary="Tax authorities (read-only picker list)")
def list_authorities(page: PageParams = Depends(), db: Session = Depends(get_db),
                     _user=Depends(require_capability("tax_registry.read"))):
    from app.modules.tax.registry_models import TaxAuthority, TaxJurisdiction

    rows = db.query(TaxAuthority).order_by(TaxAuthority.code, TaxAuthority.id).all()
    rows, next_cursor = paginate(rows, page)
    codes = {j.id: j.code for j in db.query(TaxJurisdiction).filter(
        TaxJurisdiction.id.in_([r.jurisdiction_id for r in rows if r.jurisdiction_id]))}
    return {"items": [{"id": r.id, "code": r.code, "name": r.name, "jurisdiction_id": r.jurisdiction_id,
                       "jurisdiction_code": codes.get(r.jurisdiction_id)} for r in rows],
            "next_cursor": next_cursor}


@admin_router.get("/tax-types", summary="Tax types (read-only picker list)")
def list_tax_types(page: PageParams = Depends(), db: Session = Depends(get_db),
                   _user=Depends(require_capability("tax_registry.read"))):
    from app.modules.tax.registry_models import TaxTypeDefinition

    rows, next_cursor = paginate(db.query(TaxTypeDefinition).order_by(TaxTypeDefinition.code,
                                                                      TaxTypeDefinition.id).all(), page)
    return {"items": [{"id": r.id, "code": r.code, "name": r.name} for r in rows], "next_cursor": next_cursor}


@admin_router.get("/components", summary="Tax components (read-only picker list)")
def list_components(jurisdiction_id: Optional[int] = Query(None), page: PageParams = Depends(),
                    db: Session = Depends(get_db), _user=Depends(require_capability("tax_registry.read"))):
    from app.modules.tax.registry_models import TaxComponent

    q = db.query(TaxComponent)
    if jurisdiction_id is not None:
        q = q.filter(TaxComponent.jurisdiction_id == jurisdiction_id)
    rows, next_cursor = paginate(q.order_by(TaxComponent.code, TaxComponent.id).all(), page)
    return {"items": [{"id": r.id, "code": r.code, "name": r.name, "jurisdiction_id": r.jurisdiction_id,
                       "jurisdiction_code": r.jurisdiction.code if r.jurisdiction else None,
                       "tax_type_id": r.tax_type_id, "tax_type": r.tax_type.code if r.tax_type else None,
                       "is_cumulative": r.is_cumulative, "is_active": r.is_active} for r in rows],
            "next_cursor": next_cursor}


@admin_router.get("/evidence-bundles/{kind}/{record_id}",
                  summary="Audit-evidence bundle for a source, rate, tax-code set, rule pack or market availability")
def platform_evidence_bundle(kind: str, record_id: int, format: str = Query("json", pattern="^(json|html)$"),
                             db: Session = Depends(get_db),
                             current_user=Depends(require_capability("tax_registry.read"))):
    """Phase 5c (gate 06): platform data only, tax roles only; sealed with
    its own SHA-256 and audited."""
    from fastapi.responses import HTMLResponse

    from app.modules.tax.evidence_bundle import platform_bundle, render_html

    bundle = platform_bundle(db, current_user, kind, record_id)
    if format == "html":
        return HTMLResponse(render_html(bundle), headers={"Cache-Control": "no-store", "X-Bundle-SHA256": bundle["bundle_sha256"]})
    return bundle


@admin_router.get("/people", summary="Names of the platform tax staff (for inbox and history)")
def list_tax_people(page: PageParams = Depends(), db: Session = Depends(get_db),
                    _user=Depends(require_capability("tax_registry.read"))):
    """Only platform users holding a tax role (TAX_REVIEWER / TAX_PUBLISHER):
    id, name and role. No email, no other platform users, no tenant users."""
    from app.modules.auth.models import PlatformRole, User, UserRole

    rows = db.query(User).filter(
        User.role == UserRole.SUPER_ADMIN, User.organization_id.is_(None),
        User.platform_role.in_([PlatformRole.TAX_REVIEWER, PlatformRole.TAX_PUBLISHER]),
    ).order_by(User.id).all()
    rows, next_cursor = paginate(rows, page)
    return {"items": [{"id": u.id, "name": f"{u.first_name or ''} {u.last_name or ''}".strip() or f"User {u.id}",
                       "platform_role": u.platform_role.name, "active": bool(u.is_active)} for u in rows],
            "next_cursor": next_cursor}


@admin_router.post("/rule-packs", status_code=status.HTTP_201_CREATED, summary="Register a coded rule pack as a draft")
def register_rule_pack(data: RulePackRegisterRequest, db: Session = Depends(get_db),
                       current_user=Depends(require_capability("tax_registry.write"))):
    row = RulePackService(db).register(actor_id=current_user.id, code=data.code, notes=data.notes,
                                       valid_from=data.valid_from, version=data.version)
    db.commit()
    return view_rule_pack(row)


@admin_router.patch("/rule-packs/{version_id}", summary="Attach the golden-test report or notes to a draft pack")
def amend_rule_pack(version_id: int, data: RulePackAmendRequest, db: Session = Depends(get_db),
                    current_user=Depends(require_capability("tax_registry.write"))):
    changes = data.model_dump(exclude_unset=True)
    row = RulePackService(db).amend(actor_id=current_user.id, version_id=version_id, changes=changes)
    db.commit()
    return view_rule_pack(row)


def _rule_pack_action(action: str, capability: str, step_up: bool):
    def handler(
        version_id: int,
        db: Session = Depends(get_db),
        current_user=Depends(require_capability(capability)),
        data: Optional[PolicyActionRequest] = None,
    ):
        data = data or PolicyActionRequest()
        if step_up:
            require_tax_step_up(db, current_user, StepUpRequest(code=data.code, recovery_code=data.recovery_code))
        svc = RulePackService(db)
        kwargs = {"actor_id": current_user.id, "version_id": version_id}
        if action in ("submit", "reject"):
            if not (data.reason or "").strip():
                raise BadRequestException("A reason is required.")
            kwargs["reason"] = data.reason
        if action == "publish":                     # Phase 8 PR 2: now, or scheduled
            kwargs.update(activate_at_local=data.activate_at_local, timezone=data.timezone,
                          utc_offset=data.utc_offset)
        row = getattr(svc, action)(**kwargs)
        db.commit()
        return view_rule_pack(row)
    return handler


for _action, _cap, _step_up in (("validate", "tax_registry.write", False), ("submit", "tax_registry.write", False),
                                ("approve", "tax_registry.approve", True), ("reject", "tax_registry.approve", False),
                                ("publish", "tax_registry.approve", True)):
    admin_router.add_api_route(
        f"/rule-packs/{{version_id}}/{_action}", _rule_pack_action(_action, _cap, _step_up),
        methods=["POST"], summary=f"{_action.capitalize()} a rule-pack version",
    )


# ═════════════════════════════════════════════════════════════════════════
# Phase 8 PR 2 — cancelling a scheduled activation: a TAX_PUBLISHER (or the
# submitting TAX_REVIEWER) proposes with a reason; a different TAX_PUBLISHER
# approves with MFA step-up. Approving returns the version to APPROVED.
# ═════════════════════════════════════════════════════════════════════════

def _cancel_schedule(kind: str):
    def handler(version_id: int, data: ActivationCancelRequest, db: Session = Depends(get_db),
                current_user=Depends(require_capability("tax_registry.read"))):
        c = ActivationCancellationService(db).propose(actor=current_user, kind=kind, version_id=version_id,
                                                      reason=data.reason)
        db.commit()
        return view_cancellation(c)
    return handler


for _kind, _path in (("rule_pack", "rule-packs"), ("market_availability", "market-availability")):
    admin_router.add_api_route(f"/{_path}/{{version_id}}/cancel-schedule", _cancel_schedule(_kind), methods=["POST"],
                               status_code=status.HTTP_201_CREATED,
                               summary="Propose cancelling a scheduled activation (two-person)")


@admin_router.get("/activation-cancellations", summary="Activation cancellation requests")
def list_activation_cancellations(page: PageParams = Depends(), db: Session = Depends(get_db),
                                  _user=Depends(require_capability("tax_registry.read"))):
    rows = db.query(TaxActivationCancellation).order_by(TaxActivationCancellation.id.desc()).all()
    items, next_cursor = paginate(rows, page)
    return {"items": [view_cancellation(c) for c in items], "next_cursor": next_cursor}


def _decide_cancellation(approve: bool):
    def handler(cancellation_id: int, data: Optional[PolicyActionRequest] = None, db: Session = Depends(get_db),
                current_user=Depends(require_capability("tax_registry.approve"))):
        data = data or PolicyActionRequest()
        if approve:
            require_tax_step_up(db, current_user, StepUpRequest(code=data.code, recovery_code=data.recovery_code))
        c = ActivationCancellationService(db).decide(actor_id=current_user.id, cancellation_id=cancellation_id,
                                                     approve=approve, reason=data.reason)
        db.commit()
        return view_cancellation(c)
    return handler


admin_router.add_api_route("/activation-cancellations/{cancellation_id}/approve", _decide_cancellation(True),
                           methods=["POST"], summary="Approve cancelling a scheduled activation (MFA step-up)")
admin_router.add_api_route("/activation-cancellations/{cancellation_id}/reject", _decide_cancellation(False),
                           methods=["POST"], summary="Reject cancelling a scheduled activation")


# ═════════════════════════════════════════════════════════════════════════
# Phase 8 PR 3 — emergency rollback: a TAX_PUBLISHER proposes with a reason
# and a severity; a different TAX_PUBLISHER approves with MFA step-up and it
# applies at once. Platform output is aggregate (T13).
# ═════════════════════════════════════════════════════════════════════════

@admin_router.get("/rollbacks", summary="Emergency rollback requests")
def list_rollbacks(page: PageParams = Depends(), db: Session = Depends(get_db),
                   _user=Depends(require_capability("tax_registry.read"))):
    from app.modules.tax.policy_models import TaxRollbackRequest
    from app.modules.tax.rollback_service import view_rollback

    rows = db.query(TaxRollbackRequest).order_by(TaxRollbackRequest.id.desc()).all()
    items, next_cursor = paginate(rows, page)
    return {"items": [view_rollback(r) for r in items], "next_cursor": next_cursor}


@admin_router.get("/rollbacks/candidates", summary="Earlier versions a version can be rolled back to")
def rollback_candidates(kind: str, version_id: int, db: Session = Depends(get_db),
                        _user=Depends(require_capability("tax_registry.read"))):
    from app.modules.tax.rollback_service import RollbackService

    return {"items": RollbackService(db).candidates(kind, version_id)}


@admin_router.post("/rollbacks", status_code=status.HTTP_201_CREATED, summary="Propose an emergency rollback")
def propose_rollback(data: RollbackProposeRequest, db: Session = Depends(get_db),
                     current_user=Depends(require_capability("tax_registry.approve"))):
    from app.modules.tax.rollback_service import RollbackService, view_rollback

    row = RollbackService(db).propose(actor_id=current_user.id, **data.model_dump())
    db.commit()
    return view_rollback(row)


def _decide_rollback(action: str):
    def handler(request_id: int, data: Optional[PolicyActionRequest] = None, db: Session = Depends(get_db),
                current_user=Depends(require_capability("tax_registry.approve"))):
        from app.modules.tax.rollback_service import RollbackService, view_rollback

        data = data or PolicyActionRequest()
        svc = RollbackService(db)
        if action == "approve":
            require_tax_step_up(db, current_user, StepUpRequest(code=data.code, recovery_code=data.recovery_code))
            row = svc.decide(actor_id=current_user.id, request_id=request_id, approve=True, reason=data.reason)
        elif action == "reject":
            row = svc.decide(actor_id=current_user.id, request_id=request_id, approve=False, reason=data.reason)
        else:
            row = svc.withdraw(actor_id=current_user.id, request_id=request_id)
        db.commit()
        return view_rollback(row)
    return handler


for _action in ("approve", "reject", "withdraw"):
    admin_router.add_api_route(f"/rollbacks/{{request_id}}/{_action}", _decide_rollback(_action), methods=["POST"],
                               summary=f"{_action.capitalize()} an emergency rollback request")


# ═════════════════════════════════════════════════════════════════════════
# Phase 8 PR 4 — retroactive analysis: previews (gate for retroactive rate
# and pack versions) and FULL analyses. Aggregates only (T13); amounts are
# banded when fewer than 3 organizations are affected.
# ═════════════════════════════════════════════════════════════════════════

@admin_router.post("/retro-previews/{kind}/{subject_id}", status_code=status.HTTP_201_CREATED,
                   summary="Run a retroactive analysis preview for a staged rate or pack version")
def run_retro_preview(kind: str, subject_id: int, db: Session = Depends(get_db),
                      current_user=Depends(require_capability("tax_registry.read"))):
    from app.core.capabilities import has_capability
    from app.modules.tax import retro_service

    if not (has_capability(current_user, "tax_registry.write") or has_capability(current_user, "tax_registry.approve")):
        raise ForbiddenException("Tax reviewers and publishers can run a retroactive analysis preview.")
    row = retro_service.run_preview(db, kind, subject_id, current_user.id)
    db.commit()
    return {**retro_service.view_platform(row), "current_problem": None}


@admin_router.get("/retro-previews/{kind}/{subject_id}", summary="The latest preview and whether it is current")
def get_retro_preview(kind: str, subject_id: int, db: Session = Depends(get_db),
                      _user=Depends(require_capability("tax_registry.read"))):
    from app.modules.tax import retro_service

    row = retro_service.latest_preview(db, kind, subject_id)
    retroactive = retro_service.subject_is_retroactive(db, kind, subject_id)
    return {"preview": retro_service.view_platform(row) if row else None,
            "current_problem": retro_service.preview_problem(db, kind, subject_id), "retroactive": retroactive}


@admin_router.get("/retro-analyses", summary="Retroactive analyses (aggregates only)")
def list_retro_analyses(page: PageParams = Depends(), db: Session = Depends(get_db),
                        _user=Depends(require_capability("tax_registry.read"))):
    from app.modules.tax.retro_models import TaxRetroAnalysis
    from app.modules.tax.retro_service import view_platform

    rows = db.query(TaxRetroAnalysis).filter(TaxRetroAnalysis.mode == "FULL").order_by(TaxRetroAnalysis.id.desc()).all()
    items, next_cursor = paginate(rows, page)
    return {"items": [view_platform(r) for r in items], "next_cursor": next_cursor}


# ═════════════════════════════════════════════════════════════════════════
# Phase 4a-1 — provider operations: aggregate health only (T13); no
# organization, invoice or customer identifiers. Suspension freezes a
# provider (T16): its quotes and issuing become PROVIDER_UNAVAILABLE.
# ═════════════════════════════════════════════════════════════════════════

@admin_router.get("/provider-health", summary="Aggregate provider issuing health (counts, oldest age, circuit)")
def provider_health(db: Session = Depends(get_db),
                    _user=Depends(require_any_capability("tax_registry.read", "reliability.read"))):
    from app.modules.tax.provider_issuance import aggregate_health

    return aggregate_health(db)


@admin_router.post("/regression/{subject_kind}/{subject_id}",
                   summary="Run the historical regression for a rule pack version or a staged rate and attach it")
def run_regression(subject_kind: str, subject_id: int, db: Session = Depends(get_db),
                   current_user=Depends(require_capability("tax_registry.write"))):
    from app.modules.tax.regression.runner import build_report, currency_problem, view_report

    row = build_report(db, subject_kind, subject_id, current_user.id)
    db.commit()
    return {**view_report(row), "current_problem": currency_problem(db, subject_kind, subject_id)}


@admin_router.get("/regression/{subject_kind}/{subject_id}",
                  summary="The regression report attached to a rule pack version or staged rate, and whether it is current")
def get_regression(subject_kind: str, subject_id: int, db: Session = Depends(get_db),
                   _user=Depends(require_capability("tax_registry.read"))):
    from app.modules.tax.regression.runner import currency_problem, latest, view_report

    if subject_kind not in ("rule_pack", "rate"):
        raise BadRequestException("subject_kind must be rule_pack or rate.")
    report = latest(db, subject_kind, subject_id)
    return {"report": view_report(report),
            "current_problem": currency_problem(db, subject_kind, subject_id)}


@admin_router.get("/shadow/selections", summary="Rule packs chosen for shadow compare, with exit thresholds")
def list_shadow_selections(db: Session = Depends(get_db), _user=Depends(require_capability("tax_registry.read"))):
    from app.modules.tax.shadow_models import TaxShadowSelection
    from app.modules.tax.shadow_service import view_selection

    rows = db.query(TaxShadowSelection).order_by(TaxShadowSelection.id.desc()).all()
    return {"items": [view_selection(db, r) for r in rows]}


@admin_router.post("/shadow/selections", status_code=status.HTTP_201_CREATED,
                   summary="Choose the rule pack (active or draft) for shadows and the exit threshold (tax lead; MFA)")
def choose_shadow_selection(data: ShadowSelectionRequest, db: Session = Depends(get_db),
                            current_user=Depends(require_capability("tax_registry.approve"))):
    from app.modules.tax.shadow_service import ShadowSelectionService, view_selection

    require_tax_step_up(db, current_user, StepUpRequest(code=data.code, recovery_code=data.recovery_code))
    row = ShadowSelectionService(db).choose(current_user.id, data.rule_pack_version_id,
                                            exit_min_invoices=data.exit_min_invoices, exit_min_days=data.exit_min_days,
                                            reason=data.reason)
    return view_selection(db, row)


@admin_router.post("/shadow/selections/{selection_id}/end", summary="Stop using a rule pack for shadows")
def end_shadow_selection(selection_id: int, db: Session = Depends(get_db),
                         current_user=Depends(require_capability("tax_registry.approve"))):
    from app.modules.tax.shadow_service import ShadowSelectionService, view_selection

    return view_selection(db, ShadowSelectionService(db).end(current_user.id, selection_id))


@admin_router.get("/shadow/aggregate", summary="Shadow compare across tenants: counts only (T13)")
def shadow_aggregate(db: Session = Depends(get_db), _user=Depends(require_capability("tax_registry.read"))):
    from app.modules.tax.shadow_models import TaxShadowEnrolment
    from app.modules.tax.shadow_service import enrolment_state, summary

    states = {}
    for row in db.query(TaxShadowEnrolment):
        state = enrolment_state(row)
        states[state] = states.get(state, 0) + 1
    return {"enrolments_by_state": states, **summary(db, None)}


@admin_router.get("/anomalies", summary="Recent anomaly-check runs: aggregate counts and market shares only (T13)")
def tax_anomaly_runs(limit: int = Query(14, ge=1, le=90), db: Session = Depends(get_db),
                     _user=Depends(require_any_capability("tax_registry.read", "reliability.read"))):
    from app.modules.tax.anomaly_models import TaxAnomalyRun
    from app.modules.tax.anomaly_service import thresholds

    rows = db.query(TaxAnomalyRun).order_by(TaxAnomalyRun.id.desc()).limit(limit).all()
    return {"thresholds": thresholds(),
            "items": [{"id": r.id, "started_at": r.started_at, "finished_at": r.finished_at, "counts": r.counts,
                       "markets": r.markets, "alerts_fired": r.alerts_fired or []} for r in rows]}


@admin_router.get("/monitoring", summary="Tax monitoring: aggregate metrics, thresholds and alert states")
def tax_monitoring(db: Session = Depends(get_db),
                   _user=Depends(require_any_capability("tax_registry.read", "reliability.read"))):
    """Phase 6 PR 2. Aggregate only (T13). Read-only: alerts are raised by the
    scheduled tax_monitoring_job into the Attention Engine."""
    from app.modules.tax.monitoring import collect, evaluate

    metrics = collect(db)
    return {**metrics, "alerts": [{**a, "severity": a["severity"].name} for a in evaluate(metrics)]}


def _provider_freeze(action: str):
    def handler(provider_name: str, db: Session = Depends(get_db),
                current_user=Depends(require_capability("tax_registry.approve")),
                data: Optional[PolicyActionRequest] = None):
        from app.modules.tax.provider_issuance import ProviderHealth, aggregate_health

        data = data or PolicyActionRequest()
        require_tax_step_up(db, current_user, StepUpRequest(code=data.code, recovery_code=data.recovery_code))
        if action == "suspend" and not (data.reason or "").strip():
            raise BadRequestException("A reason is required.")
        health = ProviderHealth(db)
        if action == "suspend":
            health.suspend(provider_name, data.reason.strip())
        else:
            health.resume(provider_name)
        from app.modules.super_admin.audit_service import PlatformAuditService
        from app.modules.super_admin.models import PlatformAuditAction

        PlatformAuditService(db).log_no_commit(actor_id=current_user.id, actor_role="super_admin",
                                               action=PlatformAuditAction.UPDATE, entity_type="TaxProviderCircuit",
                                               entity_id=None, reason=data.reason,
                                               metadata={"provider": provider_name, "action": action})
        db.commit()
        return aggregate_health(db)
    return handler


for _action in ("suspend", "resume"):
    admin_router.add_api_route(f"/provider-health/{{provider_name}}/{_action}", _provider_freeze(_action),
                               methods=["POST"], summary=f"{_action.capitalize()} a tax provider (T16)")


# ═════════════════════════════════════════════════════════════════════════
# Phase 3a — findings reports: aggregate counts and totals only (T13).
# No organization names or ids, customers or invoice numbers.
# ═════════════════════════════════════════════════════════════════════════

@admin_router.get("/reports/legacy-discount-overcollection", summary="Aggregate legacy discount-after-tax estimate")
def platform_overcollection_report(db: Session = Depends(get_db),
                                   _user=Depends(require_capability("tax_registry.read"))):
    from app.modules.tax.report_service import TaxFindingsReportService

    return TaxFindingsReportService(db).platform_overcollection()


@admin_router.get("/reports/duplicate-tax-rows", summary="Aggregate duplicate legacy tax snapshot rows")
def platform_duplicate_tax_rows(db: Session = Depends(get_db),
                                _user=Depends(require_capability("tax_registry.read"))):
    from app.modules.tax.report_service import TaxFindingsReportService

    return TaxFindingsReportService(db).platform_duplicates()
