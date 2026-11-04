"""
Tax domain HTTP API (ZB-TAX-ARCH-001 §09), mounted at /api/v1/tax.

Phase 0 exposes seller legal entities. Every route resolves the tenant via
get_organization_id, which refuses super-admin tokens outright: platform
super administrators have no standing access to tenant tax data (§12.1,
§13 T13). Support access goes through the existing JIT grant flow instead.
"""
from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.orm import Session

from app.core.dependencies import (
    get_current_org_admin,
    get_current_user,
    get_organization_id,
    require_active_subscription,
)
from app.database import get_db
from app.modules.tax.legal_entity_service import LegalEntityService
from app.modules.tax.schemas import (
    SellerLegalEntityCreate,
    SellerLegalEntityListResponse,
    SellerLegalEntityResponse,
    SellerLegalEntityUpdate,
)

router = APIRouter(
    prefix="/api/v1/tax",
    tags=["🧾 Tax Domain"],
    dependencies=[Depends(require_active_subscription("billing"))],
)


@router.get("/legal-entities", response_model=SellerLegalEntityListResponse, summary="List seller legal entities")
def list_legal_entities(
    include_inactive: bool = Query(False),
    db: Session = Depends(get_db),
    organization_id: int = Depends(get_organization_id),
):
    svc = LegalEntityService(db)
    # Lazily guarantee the bootstrap default exists for pre-Phase-0 orgs on
    # SQLite dev databases that never ran the Alembic backfill.
    if svc.get_default_entity(organization_id) is None:
        svc.ensure_default_entity(organization_id)
        db.commit()
    return {"items": svc.list_entities(organization_id, include_inactive=include_inactive)}


@router.get("/legal-entities/{entity_id}", response_model=SellerLegalEntityResponse, summary="Get a seller legal entity")
def get_legal_entity(
    entity_id: int,
    db: Session = Depends(get_db),
    organization_id: int = Depends(get_organization_id),
):
    return LegalEntityService(db).get_entity(entity_id, organization_id)


@router.post(
    "/legal-entities", response_model=SellerLegalEntityResponse, status_code=status.HTTP_201_CREATED,
    summary="Register a seller legal entity", dependencies=[Depends(get_current_org_admin)],
)
def create_legal_entity(
    data: SellerLegalEntityCreate,
    db: Session = Depends(get_db),
    organization_id: int = Depends(get_organization_id),
    current_user=Depends(get_current_user),
):
    return LegalEntityService(db).create_entity(organization_id, current_user.id, **data.model_dump(exclude_unset=True))


@router.patch(
    "/legal-entities/{entity_id}", response_model=SellerLegalEntityResponse,
    summary="Update a seller legal entity", dependencies=[Depends(get_current_org_admin)],
)
def update_legal_entity(
    entity_id: int,
    data: SellerLegalEntityUpdate,
    db: Session = Depends(get_db),
    organization_id: int = Depends(get_organization_id),
    current_user=Depends(get_current_user),
):
    payload = data.model_dump(exclude_unset=True)
    expected_version = payload.pop("expected_version", None)
    return LegalEntityService(db).update_entity(
        entity_id, organization_id, current_user.id, expected_version=expected_version, **payload,
    )


@router.post(
    "/legal-entities/{entity_id}/set-default", response_model=SellerLegalEntityResponse,
    summary="Make this the default issuing entity", dependencies=[Depends(get_current_org_admin)],
)
def set_default_legal_entity(
    entity_id: int,
    db: Session = Depends(get_db),
    organization_id: int = Depends(get_organization_id),
    current_user=Depends(get_current_user),
):
    return LegalEntityService(db).set_default(entity_id, organization_id, current_user.id)


@router.delete(
    "/legal-entities/{entity_id}", response_model=SellerLegalEntityResponse,
    summary="Deactivate a seller legal entity", dependencies=[Depends(get_current_org_admin)],
)
def deactivate_legal_entity(
    entity_id: int,
    db: Session = Depends(get_db),
    organization_id: int = Depends(get_organization_id),
    current_user=Depends(get_current_user),
):
    return LegalEntityService(db).deactivate(entity_id, organization_id, current_user.id)
