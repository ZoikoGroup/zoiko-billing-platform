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
from app.core.capabilities import require_capability
from app.core.dependencies import get_current_user
from app.core.exceptions import BadRequestException
from app.database import get_db
from app.modules.tax.enums import JurisdictionLevel, RedistributionPermission, StagedRateStatus, StagingOrigin
from app.modules.tax.registry_models import TaxLegalSourceRevision
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
from app.modules.tax.policy_models import TaxCodeSetVersion, TaxMarketAvailabilityVersion
from app.modules.tax.policy_schemas import (
    AvailabilityAmendRequest,
    AvailabilityDraftRequest,
    CodeSetDraftRequest,
    PolicyActionRequest,
    TaxCodeUpsertRequest,
)
from app.modules.tax.policy_service import (
    MarketAvailabilityService,
    TaxCodeSetService,
    view_availability,
    view_code_set,
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


def require_tax_step_up(db: Session, user, data: StepUpRequest) -> None:
    """Approve/publish always need a fresh factor, even while platform-wide
    step-up is retired (MFA_STEP_UP_ENABLED off). Must run before any
    registry mutation: verify_step_up commits the session."""
    from app.config import step_up_bypass_active
    from app.modules.auth.mfa_service import verify_step_up

    if not settings.TAX_REGISTRY_STEP_UP_REQUIRED:
        logger.warning("TAX_REGISTRY_STEP_UP_REQUIRED is off: tax registry decision by user %s without step-up.", user.id)
        return
    if not step_up_bypass_active() and not (data.code or data.recovery_code):
        raise BadRequestException("MFA step-up is required: provide a current authenticator code or a recovery code.")
    verify_step_up(db, user, code=data.code, recovery_code=data.recovery_code, enforce_when_retired=True)


# ── Public reference reads ──────────────────────────────────────────────

@reference_router.get("/jurisdictions", response_model=RegistryJurisdictionListResponse,
                      summary="Reference jurisdictions with support and freshness status")
def list_jurisdictions(
    country: Optional[str] = Query(None, max_length=2),
    level: Optional[JurisdictionLevel] = Query(None),
    parent_code: Optional[str] = Query(None, max_length=20),
    db: Session = Depends(get_db),
    _user=Depends(get_current_user),
):
    return {"items": RegistryReadService(db).list_jurisdictions(country=country, level=level, parent_code=parent_code)}


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
    db: Session = Depends(get_db),
    _user=Depends(require_capability("tax_registry.read")),
):
    rows = db.query(TaxLegalSourceRevision).order_by(TaxLegalSourceRevision.id).all()
    return {"items": [privileged_source_view(r) for r in rows]}


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
    db: Session = Depends(get_db),
    _user=Depends(require_capability("tax_registry.read")),
):
    rows, total = TaxRegistryPipeline(db).list_staged(status=status_filter, skip=skip, limit=limit)
    return {"items": [staged_view(r) for r in rows], "total": total}


@admin_router.get("/staged-rates/{staged_id}", response_model=StagedRateResponse)
def get_staged_rate(
    staged_id: int,
    db: Session = Depends(get_db),
    _user=Depends(require_capability("tax_registry.read")),
):
    return staged_view(TaxRegistryPipeline(db).get_staged(staged_id))


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
    db: Session = Depends(get_db),
    _user=Depends(require_capability("tax_registry.read")),
):
    q = db.query(TaxMarketAvailabilityVersion)
    if status_filter is not None:
        q = q.filter(TaxMarketAvailabilityVersion.status == status_filter)
    return {"items": [view_availability(r) for r in q.order_by(TaxMarketAvailabilityVersion.id)]}


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
def list_tax_code_sets(db: Session = Depends(get_db), _user=Depends(require_capability("tax_registry.read"))):
    return {"items": [view_code_set(db, r) for r in db.query(TaxCodeSetVersion).order_by(TaxCodeSetVersion.id)]}


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
