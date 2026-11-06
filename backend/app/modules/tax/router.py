"""
Tax domain HTTP API (ZB-TAX-ARCH-001 §09), mounted at /api/v1/tax.

Phase 0 exposes seller legal entities; Phase 2 adds registrations, legal
bases, activations, product classifications, buyer tax evidence, review items
and the read-only tax context. Every route resolves the tenant via
get_organization_id, which refuses super-admin tokens outright: platform
super administrators have no standing access to tenant tax data (§12.1,
§13 T13). Support access goes through the existing JIT grant flow instead.
"""
from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, Header, Query, UploadFile, status
from sqlalchemy.orm import Session

from app.core.dependencies import (
    get_current_billing_admin,
    get_current_finance_approver,
    get_current_org_admin,
    get_current_user,
    get_organization_id,
    require_active_subscription,
)
from app.core.exceptions import BadRequestException, ForbiddenException, NotFoundException
from app.database import get_db
from app.modules.tax.buyer_evidence_service import (
    BuyerEvidenceService,
    view_address,
    view_certificate,
    view_tax_id,
)
from app.modules.tax.classification_service import ClassificationService, view_classification
from app.modules.tax.context_builder import DOCUMENT_TYPES, build_tax_context
from app.modules.tax.determination_service import TaxDeterminationService, view_quote
from app.modules.tax.enums import ReviewItemStatus
from app.modules.tax.governed_credit_service import GovernedCreditService, view_credit_lines
from app.modules.tax.pagination import PageParams, decode_cursor, paginate
from app.modules.tax.quote_models import TaxQuote
from app.modules.tax.report_service import TaxFindingsReportService
from app.modules.tax.models import EntityTaxActivation, EntityTaxLegalBasis, ProductTaxClassification
from app.modules.tax.policy_schemas import (
    ActivationCreate,
    CertificateCreate,
    ClassificationCreate,
    DecisionRequest,
    GovernedCreditCreate,
    ImpactPreviewRequest,
    QuoteCreate,
    LegalBasisCreate,
    ProviderConnectionCreate,
    ProviderCredentialsSet,
    ReasonRequest,
    RegimeChangeRequest,
    RegistrationCreate,
    RegistrationUpdate,
    ManualResolutionCreate,
    TaxAddressCreate,
    TaxIdCreate,
    TaxIdVerification,
)
from app.modules.tax.policy_service import active_code_set, view_tax_code
from app.modules.tax.review_service import TaxReviewService, view_review_item
from app.modules.tax.tenant_tax_service import (
    TenantTaxService,
    view_activation,
    view_legal_basis,
    view_registration,
)
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
    page: PageParams = Depends(),
    db: Session = Depends(get_db),
    organization_id: int = Depends(get_organization_id),
):
    svc = LegalEntityService(db)
    # Lazily guarantee the bootstrap default exists for pre-Phase-0 orgs on
    # SQLite dev databases that never ran the Alembic backfill.
    if svc.get_default_entity(organization_id) is None:
        svc.ensure_default_entity(organization_id)
        db.commit()
    items, next_cursor = paginate(svc.list_entities(organization_id, include_inactive=include_inactive), page)
    return {"items": items, "next_cursor": next_cursor}


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


# ═════════════════════════════════════════════════════════════════════════
# Phase 2 — obligations, activation, classification, buyer evidence, context
# All tenant-scoped through get_organization_id (refuses super-admin tokens;
# support staff reach tenant data only through an approved JIT grant).
# Maker-checker: org_admin/billing_admin propose, a different
# finance_approver decides.
# ═════════════════════════════════════════════════════════════════════════

# ── Regime (GOVERNED stays refused until Phase 3) ───────────────────────

@router.get("/legal-entities/{entity_id}/regime-eligibility", summary="Would this entity qualify for GOVERNED?")
def regime_eligibility(
    entity_id: int,
    as_of: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    organization_id: int = Depends(get_organization_id),
):
    return TenantTaxService(db).regime_eligibility(organization_id, entity_id, as_of)


@router.post("/legal-entities/{entity_id}/regime", status_code=status.HTTP_201_CREATED,
             summary="Propose a tax regime change (a different finance approver decides)",
             dependencies=[Depends(get_current_org_admin)])
def request_regime(
    entity_id: int,
    data: RegimeChangeRequest,
    db: Session = Depends(get_db),
    organization_id: int = Depends(get_organization_id),
    current_user=Depends(get_current_user),
):
    from app.modules.tax.tenant_tax_service import view_regime_change

    return view_regime_change(TenantTaxService(db).request_regime(
        organization_id, current_user.id, entity_id, data.tax_regime, data.reason))


@router.get("/regime-changes", summary="Regime change proposals and decisions")
def list_regime_changes(seller_entity_id: Optional[int] = Query(None), page: PageParams = Depends(),
                        db: Session = Depends(get_db), organization_id: int = Depends(get_organization_id)):
    from app.modules.tax.tenant_tax_service import view_regime_change

    rows, next_cursor = paginate(TenantTaxService(db).list_regime_changes(organization_id, seller_entity_id), page)
    return {"items": [view_regime_change(r) for r in rows], "next_cursor": next_cursor}


def _decide_regime(approve: bool):
    def handler(change_id: int, data: DecisionRequest, db: Session = Depends(get_db),
                organization_id: int = Depends(get_organization_id), current_user=Depends(get_current_user)):
        from app.modules.tax.tenant_tax_service import view_regime_change

        return view_regime_change(TenantTaxService(db).decide_regime_change(
            organization_id, current_user.id, change_id, approve=approve, reason=data.reason))
    return handler


router.add_api_route("/regime-changes/{change_id}/approve", _decide_regime(True), methods=["POST"],
                     dependencies=[Depends(get_current_finance_approver)],
                     summary="Approve a regime change (different user)")
router.add_api_route("/regime-changes/{change_id}/reject", _decide_regime(False), methods=["POST"],
                     dependencies=[Depends(get_current_finance_approver)], summary="Reject a regime change")


# ── Pseudonymous customer reference key (Phase 4c) ──────────────────────

@router.get("/pseudonym-key", summary="Pseudonym key status (fingerprints only, never the key)")
def pseudonym_key_status(db: Session = Depends(get_db), organization_id: int = Depends(get_organization_id)):
    from app.modules.tax.pseudonym import PseudonymKeyService

    return PseudonymKeyService(db).status(organization_id)


@router.get("/pseudonym-key/acknowledgements", summary="Pseudonym key acknowledgements")
def list_pseudonym_key_acknowledgements(page: PageParams = Depends(), db: Session = Depends(get_db),
                                        organization_id: int = Depends(get_organization_id)):
    from app.modules.tax.pseudonym import PseudonymKeyService, view_key_record

    rows, next_cursor = paginate(PseudonymKeyService(db).list(organization_id), page)
    return {"items": [view_key_record(r) for r in rows], "next_cursor": next_cursor}


@router.post("/pseudonym-key/acknowledgements", status_code=status.HTTP_201_CREATED,
             summary="Propose acknowledging the current pseudonym key (after remapping)",
             dependencies=[Depends(get_current_billing_admin)])
def propose_pseudonym_key_acknowledgement(data: ReasonRequest, db: Session = Depends(get_db),
                                          organization_id: int = Depends(get_organization_id),
                                          current_user=Depends(get_current_user)):
    from app.modules.tax.pseudonym import PseudonymKeyService, view_key_record

    return view_key_record(PseudonymKeyService(db).propose(organization_id, current_user.id, data.reason))


@router.post("/pseudonym-key/remap-export", dependencies=[Depends(get_current_billing_admin)],
             summary="Old -> new customer references for the provider, during a key rotation (CSV)")
def pseudonym_key_remap_export(db: Session = Depends(get_db), organization_id: int = Depends(get_organization_id),
                               current_user=Depends(get_current_user)):
    import csv
    import io

    from fastapi.responses import Response

    from app.modules.tax.pseudonym import PseudonymKeyService

    rows = PseudonymKeyService(db).remap_export(organization_id, current_user.id)
    out = io.StringIO()
    writer = csv.writer(out)
    writer.writerow(["old_customer_ref", "new_customer_ref"])
    writer.writerows(rows)
    return Response(content=out.getvalue(), media_type="text/csv",
                    headers={"Cache-Control": "no-store",
                             "Content-Disposition": 'attachment; filename="pseudonym-remap.csv"'})


def _decide_pseudonym_key(approve: bool):
    def handler(record_id: int, data: DecisionRequest, db: Session = Depends(get_db),
                organization_id: int = Depends(get_organization_id), current_user=Depends(get_current_user)):
        from app.modules.tax.pseudonym import PseudonymKeyService, view_key_record

        return view_key_record(PseudonymKeyService(db).decide(organization_id, current_user.id, record_id,
                                                              approve=approve, reason=data.reason))
    return handler


router.add_api_route("/pseudonym-key/acknowledgements/{record_id}/approve", _decide_pseudonym_key(True),
                     methods=["POST"], dependencies=[Depends(get_current_finance_approver)],
                     summary="Approve a pseudonym key acknowledgement (different user)")
router.add_api_route("/pseudonym-key/acknowledgements/{record_id}/reject", _decide_pseudonym_key(False),
                     methods=["POST"], dependencies=[Depends(get_current_finance_approver)],
                     summary="Reject a pseudonym key acknowledgement")


@router.post("/regime-changes/{change_id}/withdraw", summary="Withdraw a proposed regime change",
             dependencies=[Depends(get_current_org_admin)])
def withdraw_regime_change(change_id: int, db: Session = Depends(get_db),
                           organization_id: int = Depends(get_organization_id), current_user=Depends(get_current_user)):
    from app.modules.tax.models import TaxRegimeChange
    from app.modules.tax.tenant_tax_service import view_regime_change

    return view_regime_change(TenantTaxService(db).withdraw(TaxRegimeChange, "Regime change", organization_id,
                                                           current_user.id, change_id))


# ── Registrations ───────────────────────────────────────────────────────

@router.get("/registrations", summary="List tax registrations")
def list_registrations(
    seller_entity_id: Optional[int] = Query(None),
    page: PageParams = Depends(),
    db: Session = Depends(get_db),
    organization_id: int = Depends(get_organization_id),
):
    rows, next_cursor = paginate(TenantTaxService(db).list_registrations(organization_id, seller_entity_id), page)
    return {"items": [view_registration(r) for r in rows], "next_cursor": next_cursor}


@router.post("/registrations", status_code=status.HTTP_201_CREATED, summary="Record a tax registration",
             dependencies=[Depends(get_current_billing_admin)])
def create_registration(
    data: RegistrationCreate,
    db: Session = Depends(get_db),
    organization_id: int = Depends(get_organization_id),
    current_user=Depends(get_current_user),
):
    return view_registration(TenantTaxService(db).create_registration(organization_id, current_user.id, **data.model_dump()))


@router.patch("/registrations/{registration_id}", summary="Record validity end, status or verification",
              dependencies=[Depends(get_current_billing_admin)])
def update_registration(
    registration_id: int,
    data: RegistrationUpdate,
    db: Session = Depends(get_db),
    organization_id: int = Depends(get_organization_id),
    current_user=Depends(get_current_user),
):
    return view_registration(TenantTaxService(db).update_registration(
        organization_id, current_user.id, registration_id, **data.model_dump(exclude_unset=True)))


# ── Legal bases (collecting without a registration) ─────────────────────

# ── Phase 5c: who may read tenant tax documents and evidence bundles ──

#: Tenant roles that may download tax evidence documents and evidence
#: bundles: the roles that upload (org_admin, billing_admin) and decide
#: (finance_approver). Other tenant roles (auditor) get 403; platform
#: tokens are refused by get_organization_id (T13).
TAX_EVIDENCE_READER_ROLES = ("org_admin", "billing_admin", "finance_approver")


def get_tax_evidence_reader(current_user=Depends(get_current_user)):
    role = getattr(current_user.role, "value", current_user.role)
    if str(role).lower() not in TAX_EVIDENCE_READER_ROLES:
        raise ForbiddenException("Tax evidence is available to org admins, billing admins and finance approvers.")
    return current_user


# ── Phase 5b: evidence documents for registrations and legal bases ──

def _evidence_routes(kind: str, path: str, view):
    async def upload(record_id: int, file: UploadFile = File(...), sha256: Optional[str] = Form(None, max_length=64),
                     db: Session = Depends(get_db), organization_id: int = Depends(get_organization_id),
                     current_user=Depends(get_current_user)):
        from app.config import settings
        from app.modules.tax.tenant_tax_service import attach_obligation_evidence

        content = await file.read(settings.TAX_EVIDENCE_MAX_BYTES + 1)
        return view(attach_obligation_evidence(db, organization_id, current_user.id, kind, record_id, content=content,
                                               media_type=file.content_type or "", filename=file.filename,
                                               expected_sha256=sha256))

    def download(record_id: int, db: Session = Depends(get_db), organization_id: int = Depends(get_organization_id)):
        from fastapi.responses import Response

        from app.modules.tax.tenant_tax_service import obligation_evidence

        stored = obligation_evidence(db, organization_id, kind, record_id)
        return Response(content=stored.content, media_type=stored.media_type,
                        headers={"X-Content-SHA256": stored.sha256, "Cache-Control": "no-store",
                                 "Content-Disposition": f'attachment; filename="{kind}-{record_id}"'})

    router.add_api_route(f"/{path}/{{record_id}}/evidence", upload, methods=["POST"],
                         dependencies=[Depends(get_current_billing_admin)],
                         summary=f"Attach the {kind.replace('_', ' ')} evidence document once (PDF, PNG or JPEG)")
    router.add_api_route(f"/{path}/{{record_id}}/evidence", download, methods=["GET"],
                         dependencies=[Depends(get_tax_evidence_reader)],
                         summary=f"Download the {kind.replace('_', ' ')} evidence document")


@router.get("/legal-bases", summary="List legal bases for collecting without registration")
def list_legal_bases(page: PageParams = Depends(), db: Session = Depends(get_db),
                     organization_id: int = Depends(get_organization_id)):
    rows, next_cursor = paginate(TenantTaxService(db).list_legal_bases(organization_id), page)
    return {"items": [view_legal_basis(r) for r in rows], "next_cursor": next_cursor}


@router.post("/legal-bases", status_code=status.HTTP_201_CREATED, summary="Propose a legal basis",
             dependencies=[Depends(get_current_billing_admin)])
def propose_legal_basis(
    data: LegalBasisCreate,
    db: Session = Depends(get_db),
    organization_id: int = Depends(get_organization_id),
    current_user=Depends(get_current_user),
):
    return view_legal_basis(TenantTaxService(db).propose_legal_basis(organization_id, current_user.id, **data.model_dump()))


@router.post("/legal-bases/{basis_id}/approve", summary="Approve a legal basis (different user)",
             dependencies=[Depends(get_current_finance_approver)])
def approve_legal_basis(basis_id: int, data: DecisionRequest, db: Session = Depends(get_db),
                        organization_id: int = Depends(get_organization_id), current_user=Depends(get_current_user)):
    return view_legal_basis(TenantTaxService(db).decide_legal_basis(
        organization_id, current_user.id, basis_id, approve=True, reason=data.reason))


@router.post("/legal-bases/{basis_id}/reject", summary="Reject a legal basis",
             dependencies=[Depends(get_current_finance_approver)])
def reject_legal_basis(basis_id: int, data: DecisionRequest, db: Session = Depends(get_db),
                       organization_id: int = Depends(get_organization_id), current_user=Depends(get_current_user)):
    return view_legal_basis(TenantTaxService(db).decide_legal_basis(
        organization_id, current_user.id, basis_id, approve=False, reason=data.reason))


@router.post("/legal-bases/{basis_id}/withdraw", summary="Withdraw a proposed legal basis",
             dependencies=[Depends(get_current_billing_admin)])
def withdraw_legal_basis(basis_id: int, db: Session = Depends(get_db),
                         organization_id: int = Depends(get_organization_id), current_user=Depends(get_current_user)):
    return view_legal_basis(TenantTaxService(db).withdraw(
        EntityTaxLegalBasis, "Legal basis", organization_id, current_user.id, basis_id))


# ── Activations ─────────────────────────────────────────────────────────

@router.get("/activations", summary="List tax activations")
def list_activations(
    seller_entity_id: Optional[int] = Query(None),
    page: PageParams = Depends(),
    db: Session = Depends(get_db),
    organization_id: int = Depends(get_organization_id),
):
    rows, next_cursor = paginate(TenantTaxService(db).list_activations(organization_id, seller_entity_id), page)
    return {"items": [view_activation(a) for a in rows], "next_cursor": next_cursor}


@router.post("/activations", status_code=status.HTTP_201_CREATED, summary="Propose a tax activation",
             dependencies=[Depends(get_current_billing_admin)])
def propose_activation(
    data: ActivationCreate,
    db: Session = Depends(get_db),
    organization_id: int = Depends(get_organization_id),
    current_user=Depends(get_current_user),
):
    return view_activation(TenantTaxService(db).propose_activation(organization_id, current_user.id, **data.model_dump()))


@router.post("/activations/{activation_id}/approve", summary="Approve a tax activation (different user)",
             dependencies=[Depends(get_current_finance_approver)])
def approve_activation(activation_id: int, data: DecisionRequest, db: Session = Depends(get_db),
                       organization_id: int = Depends(get_organization_id), current_user=Depends(get_current_user)):
    return view_activation(TenantTaxService(db).decide_activation(
        organization_id, current_user.id, activation_id, approve=True, reason=data.reason))


@router.post("/activations/{activation_id}/reject", summary="Reject a tax activation",
             dependencies=[Depends(get_current_finance_approver)])
def reject_activation(activation_id: int, data: DecisionRequest, db: Session = Depends(get_db),
                      organization_id: int = Depends(get_organization_id), current_user=Depends(get_current_user)):
    return view_activation(TenantTaxService(db).decide_activation(
        organization_id, current_user.id, activation_id, approve=False, reason=data.reason))


@router.post("/activations/{activation_id}/withdraw", summary="Withdraw a proposed activation",
             dependencies=[Depends(get_current_billing_admin)])
def withdraw_activation(activation_id: int, db: Session = Depends(get_db),
                        organization_id: int = Depends(get_organization_id), current_user=Depends(get_current_user)):
    return view_activation(TenantTaxService(db).withdraw(
        EntityTaxActivation, "Tax activation", organization_id, current_user.id, activation_id))


@router.get("/activations/{activation_id}/effective", summary="Effective state of an activation on a date")
def activation_effective_state(
    activation_id: int,
    on_date: Optional[date] = Query(None, alias="date"),
    db: Session = Depends(get_db),
    organization_id: int = Depends(get_organization_id),
):
    svc = TenantTaxService(db)
    row = svc._get(EntityTaxActivation, activation_id, organization_id, "Tax activation")
    if on_date is None:
        raise BadRequestException("Pass ?date= (the activation's legal date to evaluate); it is never assumed.")
    return svc.effective_state(row, on_date)


# ── Tax codes and product classification ─────────────────────────────────

@router.get("/tax-codes", summary="Published platform tax codes")
def list_tax_codes(db: Session = Depends(get_db), organization_id: int = Depends(get_organization_id)):
    code_set = active_code_set(db)
    if code_set is None:
        return {"code_set": None, "items": []}
    return {"code_set": {"id": code_set.id, "code": code_set.code, "version": code_set.version},
            "items": [view_tax_code(c) for c in code_set.codes]}


@router.get("/product-classifications", summary="Product tax classifications and history")
def list_classifications(
    product_id: Optional[int] = Query(None),
    page: PageParams = Depends(),
    db: Session = Depends(get_db),
    organization_id: int = Depends(get_organization_id),
):
    from app.modules.billing.models import Product

    rows, next_cursor = paginate(ClassificationService(db).list_classifications(organization_id, product_id), page)
    names = {p.id: p.name for p in db.query(Product).filter(
        Product.organization_id == organization_id, Product.id.in_([c.product_id for c in rows] or [-1]))}
    return {"items": [{**view_classification(c), "product_name": names.get(c.product_id)} for c in rows],
            "next_cursor": next_cursor}


@router.post("/product-classifications", status_code=status.HTTP_201_CREATED, summary="Propose a classification",
             dependencies=[Depends(get_current_billing_admin)])
def propose_classification(data: ClassificationCreate, db: Session = Depends(get_db),
                           organization_id: int = Depends(get_organization_id), current_user=Depends(get_current_user)):
    return view_classification(ClassificationService(db).propose(organization_id, current_user.id, **data.model_dump()))


@router.post("/product-classifications/impact-preview", summary="Draft invoices and open quotes a change affects")
def classification_impact_preview(data: ImpactPreviewRequest, db: Session = Depends(get_db),
                                  organization_id: int = Depends(get_organization_id)):
    return ClassificationService(db).impact_preview(organization_id, data.product_ids)


@router.post("/product-classifications/{classification_id}/approve", summary="Approve a classification (different user)",
             dependencies=[Depends(get_current_finance_approver)])
def approve_classification(classification_id: int, data: DecisionRequest, db: Session = Depends(get_db),
                           organization_id: int = Depends(get_organization_id), current_user=Depends(get_current_user)):
    return view_classification(ClassificationService(db).decide(
        organization_id, current_user.id, classification_id, approve=True, reason=data.reason))


@router.post("/product-classifications/{classification_id}/reject", summary="Reject a classification",
             dependencies=[Depends(get_current_finance_approver)])
def reject_classification(classification_id: int, data: DecisionRequest, db: Session = Depends(get_db),
                          organization_id: int = Depends(get_organization_id), current_user=Depends(get_current_user)):
    return view_classification(ClassificationService(db).decide(
        organization_id, current_user.id, classification_id, approve=False, reason=data.reason))


@router.post("/product-classifications/{classification_id}/withdraw", summary="Withdraw a proposed classification",
             dependencies=[Depends(get_current_billing_admin)])
def withdraw_classification(classification_id: int, db: Session = Depends(get_db),
                            organization_id: int = Depends(get_organization_id), current_user=Depends(get_current_user)):
    return view_classification(TenantTaxService(db).withdraw(
        ProductTaxClassification, "Product tax classification", organization_id, current_user.id, classification_id))


def _register_obligation_evidence_routes():
    from app.modules.tax.tenant_tax_service import view_legal_basis, view_registration

    _evidence_routes("registration", "registrations", view_registration)
    _evidence_routes("legal_basis", "legal-bases", view_legal_basis)


_register_obligation_evidence_routes()


@router.get("/evidence-bundles/{kind}/{record_id}",
            summary="Audit-evidence bundle for a registration, legal basis, activation, classification or regime change")
def tenant_evidence_bundle(kind: str, record_id: int, format: str = Query("json", pattern="^(json|html)$"),
                           db: Session = Depends(get_db), organization_id: int = Depends(get_organization_id),
                           current_user=Depends(get_tax_evidence_reader)):
    """Phase 5c (gate 06): the record, its evidence hashes, approvals and
    every state change, sealed with its own SHA-256 and audited."""
    from fastapi.responses import HTMLResponse

    from app.modules.tax.evidence_bundle import render_html, tenant_bundle

    bundle = tenant_bundle(db, organization_id, current_user, kind, record_id)
    if format == "html":
        return HTMLResponse(render_html(bundle), headers={"Cache-Control": "no-store", "X-Bundle-SHA256": bundle["bundle_sha256"]})
    return bundle


@router.get("/people", summary="Names of this organization's users (for tax screens)")
def tenant_people(page: PageParams = Depends(), db: Session = Depends(get_db),
                  organization_id: int = Depends(get_organization_id)):
    """Phase 5b: the caller's own organization only; id, name and role. No
    email, no platform users, no other tenants."""
    from app.modules.auth.models import User

    rows = db.query(User).filter(User.organization_id == organization_id).order_by(User.id).all()
    rows, next_cursor = paginate(rows, page)
    return {"items": [{"id": u.id, "name": f"{u.first_name or ''} {u.last_name or ''}".strip() or f"User {u.id}",
                       "role": getattr(u.role, "name", str(u.role)), "active": bool(u.is_active)} for u in rows],
            "next_cursor": next_cursor}


# ── Customer tax evidence ───────────────────────────────────────────────

@router.get("/customers/{customer_id}/tax-evidence", summary="Buyer tax evidence")
def customer_tax_evidence(customer_id: int, include_history: bool = Query(False), db: Session = Depends(get_db),
                          organization_id: int = Depends(get_organization_id)):
    return BuyerEvidenceService(db).evidence(organization_id, customer_id, include_history)


@router.post("/customers/{customer_id}/tax-addresses", status_code=status.HTTP_201_CREATED,
             summary="Record a structured tax address", dependencies=[Depends(get_current_billing_admin)])
def record_tax_address(customer_id: int, data: TaxAddressCreate, db: Session = Depends(get_db),
                       organization_id: int = Depends(get_organization_id), current_user=Depends(get_current_user)):
    return view_address(BuyerEvidenceService(db).record_address(
        organization_id, current_user.id, customer_id, **data.model_dump()))


@router.post("/customers/{customer_id}/tax-addresses/{address_id}/resolve", status_code=status.HTTP_201_CREATED,
             summary="Resolve a US tax address to its tax districts (Phase 4c)",
             dependencies=[Depends(get_current_billing_admin)])
def resolve_tax_address(customer_id: int, address_id: int, db: Session = Depends(get_db),
                        organization_id: int = Depends(get_organization_id), current_user=Depends(get_current_user)):
    from app.modules.tax.address_resolver import resolve_address, view_resolution

    return view_resolution(resolve_address(db, organization_id, current_user.id, address_id, customer_id=customer_id))


# ── Manual address resolution (Phase 4d): two people and evidence ──

@router.get("/manual-resolutions", summary="Manual address resolutions (proposals and decisions)")
def list_manual_resolutions(address_id: Optional[int] = Query(None), page: PageParams = Depends(),
                            db: Session = Depends(get_db), organization_id: int = Depends(get_organization_id)):
    from app.modules.tax.address_resolver import ManualResolutionService, view_manual_resolution

    rows, next_cursor = paginate(ManualResolutionService(db).list(organization_id, address_id), page)
    return {"items": [view_manual_resolution(r) for r in rows], "next_cursor": next_cursor}


@router.post("/customers/{customer_id}/tax-addresses/{address_id}/manual-resolutions",
             status_code=status.HTTP_201_CREATED, dependencies=[Depends(get_current_billing_admin)],
             summary="Propose the districts for an address the resolver couldn't place")
def propose_manual_resolution(customer_id: int, address_id: int, data: ManualResolutionCreate,
                              db: Session = Depends(get_db), organization_id: int = Depends(get_organization_id),
                              current_user=Depends(get_current_user)):
    from app.modules.tax.address_resolver import ManualResolutionService, view_manual_resolution

    return view_manual_resolution(ManualResolutionService(db).propose(
        organization_id, current_user.id, customer_id, address_id, jurisdiction_codes=data.jurisdiction_codes,
        reason=data.reason))


@router.post("/manual-resolutions/{request_id}/evidence", dependencies=[Depends(get_current_billing_admin)],
             summary="Attach the evidence document once (PDF, PNG or JPEG)")
async def attach_manual_resolution_evidence(request_id: int, file: UploadFile = File(...),
                                            sha256: Optional[str] = Form(None, max_length=64),
                                            db: Session = Depends(get_db),
                                            organization_id: int = Depends(get_organization_id),
                                            current_user=Depends(get_current_user)):
    from app.config import settings
    from app.modules.tax.address_resolver import ManualResolutionService, view_manual_resolution

    content = await file.read(settings.TAX_EVIDENCE_MAX_BYTES + 1)
    return view_manual_resolution(ManualResolutionService(db).attach_evidence(
        organization_id, current_user.id, request_id, content=content, media_type=file.content_type or "",
        filename=file.filename, expected_sha256=sha256))


@router.get("/manual-resolutions/{request_id}/evidence", summary="Download a manual resolution's evidence",
            dependencies=[Depends(get_tax_evidence_reader)])
def download_manual_resolution_evidence(request_id: int, db: Session = Depends(get_db),
                                        organization_id: int = Depends(get_organization_id)):
    from fastapi.responses import Response

    from app.modules.tax.address_resolver import ManualResolutionService

    stored = ManualResolutionService(db).evidence(organization_id, request_id)
    return Response(content=stored.content, media_type=stored.media_type,
                    headers={"X-Content-SHA256": stored.sha256, "Cache-Control": "no-store",
                             "Content-Disposition": f'attachment; filename="manual-resolution-{request_id}"'})


def _decide_manual_resolution(approve: bool):
    def handler(request_id: int, data: DecisionRequest, db: Session = Depends(get_db),
                organization_id: int = Depends(get_organization_id), current_user=Depends(get_current_user)):
        from app.modules.tax.address_resolver import ManualResolutionService, view_manual_resolution

        return view_manual_resolution(ManualResolutionService(db).decide(
            organization_id, current_user.id, request_id, approve=approve, reason=data.reason))
    return handler


router.add_api_route("/manual-resolutions/{request_id}/approve", _decide_manual_resolution(True), methods=["POST"],
                     dependencies=[Depends(get_current_finance_approver)],
                     summary="Approve a manual resolution (different user)")
router.add_api_route("/manual-resolutions/{request_id}/reject", _decide_manual_resolution(False), methods=["POST"],
                     dependencies=[Depends(get_current_finance_approver)], summary="Reject a manual resolution")


@router.post("/manual-resolutions/{request_id}/withdraw", dependencies=[Depends(get_current_billing_admin)],
             summary="Withdraw a proposed manual resolution")
def withdraw_manual_resolution(request_id: int, db: Session = Depends(get_db),
                               organization_id: int = Depends(get_organization_id),
                               current_user=Depends(get_current_user)):
    from app.modules.tax.address_resolver import ManualResolutionService, view_manual_resolution

    return view_manual_resolution(ManualResolutionService(db).withdraw(organization_id, current_user.id, request_id))


@router.post("/customers/{customer_id}/tax-ids", status_code=status.HTTP_201_CREATED,
             summary="Record a buyer tax ID (stored exactly as given)", dependencies=[Depends(get_current_billing_admin)])
def add_customer_tax_id(customer_id: int, data: TaxIdCreate, db: Session = Depends(get_db),
                        organization_id: int = Depends(get_organization_id), current_user=Depends(get_current_user)):
    return view_tax_id(BuyerEvidenceService(db).add_tax_id(organization_id, current_user.id, customer_id, **data.model_dump()))


@router.post("/tax-ids/{tax_id_id}/verification", summary="Record a tax ID verification result",
             dependencies=[Depends(get_current_billing_admin)])
def record_tax_id_verification(tax_id_id: int, data: TaxIdVerification, db: Session = Depends(get_db),
                               organization_id: int = Depends(get_organization_id), current_user=Depends(get_current_user)):
    return view_tax_id(BuyerEvidenceService(db).record_verification(
        organization_id, current_user.id, tax_id_id, **data.model_dump()))


@router.post("/tax-ids/{tax_id_id}/retire", summary="Retire a buyer tax ID",
             dependencies=[Depends(get_current_billing_admin)])
def retire_tax_id(tax_id_id: int, db: Session = Depends(get_db),
                  organization_id: int = Depends(get_organization_id), current_user=Depends(get_current_user)):
    return view_tax_id(BuyerEvidenceService(db).retire_tax_id(organization_id, current_user.id, tax_id_id))


@router.post("/customers/{customer_id}/exemption-certificates", status_code=status.HTTP_201_CREATED,
             summary="Record an exemption certificate", dependencies=[Depends(get_current_billing_admin)])
def add_exemption_certificate(customer_id: int, data: CertificateCreate, db: Session = Depends(get_db),
                              organization_id: int = Depends(get_organization_id), current_user=Depends(get_current_user)):
    return view_certificate(BuyerEvidenceService(db).add_certificate(
        organization_id, current_user.id, customer_id, **data.model_dump()))


@router.post("/exemption-certificates/{certificate_id}/revoke", summary="Revoke an exemption certificate",
             dependencies=[Depends(get_current_billing_admin)])
def revoke_exemption_certificate(certificate_id: int, db: Session = Depends(get_db),
                                 organization_id: int = Depends(get_organization_id), current_user=Depends(get_current_user)):
    return view_certificate(BuyerEvidenceService(db).revoke_certificate(organization_id, current_user.id, certificate_id))


# ── Review items (T14) and tax context ──────────────────────────────────

@router.get("/review-items", summary="Tax evidence review queue")
def list_review_items(include_resolved: bool = Query(False), page: PageParams = Depends(),
                      db: Session = Depends(get_db), organization_id: int = Depends(get_organization_id)):
    items = TaxReviewService(db).list_items(organization_id, None if include_resolved else ReviewItemStatus.OPEN)
    rows, next_cursor = paginate(items, page)
    return {"items": [view_review_item(i) for i in rows], "next_cursor": next_cursor}


@router.post("/review-items/{item_id}/resolve", summary="Resolve a review item",
             dependencies=[Depends(get_current_billing_admin)])
def resolve_review_item(item_id: int, db: Session = Depends(get_db),
                        organization_id: int = Depends(get_organization_id), current_user=Depends(get_current_user)):
    return view_review_item(TaxReviewService(db).resolve(organization_id, current_user.id, item_id))


@router.get("/context/{document_type}/{document_id}", summary="Assemble the tax context for a draft (read-only)")
def get_tax_context(document_type: str, document_id: int, db: Session = Depends(get_db),
                    organization_id: int = Depends(get_organization_id)):
    if document_type not in DOCUMENT_TYPES:
        raise BadRequestException(f"document_type must be one of {', '.join(DOCUMENT_TYPES)}.")
    return build_tax_context(db, organization_id, document_type, document_id)


# ═════════════════════════════════════════════════════════════════════════
# Phase 3a — governed quotes, governed credit notes, findings reports
# ═════════════════════════════════════════════════════════════════════════

def require_tax_report_role(current_user=Depends(get_current_user)):
    """Findings reports: the tenant's own admins and finance approvers."""
    role = getattr(current_user.role, "value", current_user.role)
    if role not in ("org_admin", "finance_approver"):
        raise ForbiddenException("Tax findings reports are available to organization admins and finance approvers.")
    return current_user


@router.post("/quotes", status_code=status.HTTP_201_CREATED, summary="Request a governed tax quote for a draft",
             dependencies=[Depends(get_current_billing_admin)])
def create_tax_quote(
    data: QuoteCreate,
    idempotency_key: Optional[str] = Header(None, alias="Idempotency-Key", max_length=255),
    db: Session = Depends(get_db),
    organization_id: int = Depends(get_organization_id),
    current_user=Depends(get_current_user),
):
    quote = TaxDeterminationService(db).create_quote(
        organization_id, current_user.id, data.document_type, data.document_id, idempotency_key=idempotency_key)
    return view_quote(quote)


@router.get("/quotes", summary="Governed tax quotes for a document")
def list_tax_quotes(
    document_type: str = Query(..., pattern="^(invoice|quote)$"),
    document_id: int = Query(...),
    db: Session = Depends(get_db),
    organization_id: int = Depends(get_organization_id),
):
    rows = db.query(TaxQuote).filter(TaxQuote.organization_id == organization_id,
                                     TaxQuote.document_type == document_type,
                                     TaxQuote.document_id == document_id).order_by(TaxQuote.id.desc()).all()
    return {"items": [view_quote(q) for q in rows]}


@router.get("/quotes/{quote_id}", summary="A governed tax quote, with components and explanation")
def get_tax_quote(quote_id: int, db: Session = Depends(get_db), organization_id: int = Depends(get_organization_id)):
    quote = db.query(TaxQuote).filter(TaxQuote.id == quote_id, TaxQuote.organization_id == organization_id).first()
    if quote is None:
        raise NotFoundException("Tax quote", quote_id)
    return view_quote(quote)


@router.get("/invoices/{invoice_id}/tax-summary",
            summary="Governed tax for the invoice editor: totals, components, sources, freshness, blocking reasons")
def invoice_tax_summary(invoice_id: int, db: Session = Depends(get_db),
                        organization_id: int = Depends(get_organization_id)):
    from app.modules.tax.exception_service import TaxExceptionService

    return TaxExceptionService(db).invoice_tax_summary(organization_id, invoice_id)


@router.get("/exceptions", summary="Governed drafts that cannot be issued, with reason, owner and re-quote")
def list_tax_exceptions(limit: int = Query(200, ge=1, le=500),
                        cursor: Optional[str] = Query(None, max_length=512,
                                                      description="next_cursor of the previous page"),
                        db: Session = Depends(get_db), organization_id: int = Depends(get_organization_id)):
    # Keeps its existing limit (drafts checked per page; default 200, max 500).
    from app.modules.tax.exception_service import TaxExceptionService

    return TaxExceptionService(db).list_exceptions(organization_id, limit=limit, after_invoice_id=decode_cursor(cursor))


@router.post("/invoices/{invoice_id}/credit-notes", status_code=status.HTTP_201_CREATED,
             summary="Credit a governed invoice from its tax snapshot", dependencies=[Depends(get_current_billing_admin)])
def create_governed_credit_note(
    invoice_id: int,
    data: GovernedCreditCreate,
    db: Session = Depends(get_db),
    organization_id: int = Depends(get_organization_id),
    current_user=Depends(get_current_user),
):
    from app.modules.billing.models import CreditNoteType

    try:
        note_type = CreditNoteType(data.credit_note_type.lower())
    except ValueError:
        raise BadRequestException(f"Unknown credit_note_type {data.credit_note_type!r}.")
    credit_note = GovernedCreditService(db).create(
        organization_id, current_user.id, invoice_id,
        lines=[l.model_dump() for l in data.lines], credit_note_type=note_type,
        reason=data.reason, issue_date=data.issue_date,
    )
    return {"credit_note_id": credit_note.id, "credit_note_number": credit_note.credit_note_number,
            "status": credit_note.status.name, "subtotal": credit_note.subtotal,
            "tax_amount": credit_note.tax_amount, "total_amount": credit_note.total_amount,
            "tax_lines": view_credit_lines(db, credit_note.id)}


REPORT_CSV_COLUMNS = {
    "legacy-discount-overcollection": ("invoice_number", "issue_date", "status", "currency", "discount_percentage",
                                       "document_discount", "subtotal", "tax_amount", "estimated_overcollected_tax"),
    "duplicate-tax-rows": ("invoice_number", "duplicate_rows"),
}


def _csv_cell(value) -> str:
    """One CSV cell. A text cell starting with = + - @ (or a tab / CR) is
    prefixed with ' so a spreadsheet never runs it as a formula."""
    text = "" if value is None else str(getattr(value, "isoformat", lambda: value)())
    if text and text[0] in "=+-@\t\r" and not _is_number(text):
        return "'" + text
    return text


def _is_number(text: str) -> bool:
    try:
        float(text)
        return True
    except ValueError:
        return False


def _report_response(db: Session, organization_id: int, user, name: str, report: dict, format: str):
    """T10: the report as JSON, or its invoice rows as CSV (audited export)."""
    if format != "csv":
        return report
    import csv
    import io

    from fastapi.responses import Response

    from app.modules.billing.models import BillingAuditAction
    from app.modules.billing.services.audit_service import BillingAuditService

    columns = REPORT_CSV_COLUMNS[name]
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(columns)
    for row in report.get("invoices", []):
        writer.writerow([_csv_cell(row.get(c)) for c in columns])
    BillingAuditService(db).log_no_commit(organization_id, user.id, BillingAuditAction.EXPORT, "TaxFindingsReport",
                                          None, new_values={"report": name, "rows": len(report.get("invoices", []))})
    db.commit()
    return Response(content=buffer.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Cache-Control": "no-store",
                             "Content-Disposition": f'attachment; filename="tax-{name}.csv"'})


@router.get("/reports/legacy-discount-overcollection",
            summary="Estimated tax over-collected by legacy discount-after-tax (this organization)")
def tenant_overcollection_report(
    format: str = Query("json", pattern="^(json|csv)$"),
    db: Session = Depends(get_db),
    organization_id: int = Depends(get_organization_id),
    current_user=Depends(require_tax_report_role),
):
    report = TaxFindingsReportService(db).tenant_overcollection(organization_id)
    return _report_response(db, organization_id, current_user, "legacy-discount-overcollection", report, format)


@router.get("/reports/duplicate-tax-rows", summary="Duplicate legacy tax snapshot rows (this organization)")
def tenant_duplicate_tax_rows(
    format: str = Query("json", pattern="^(json|csv)$"),
    db: Session = Depends(get_db),
    organization_id: int = Depends(get_organization_id),
    current_user=Depends(require_tax_report_role),
):
    report = TaxFindingsReportService(db).tenant_duplicates(organization_id)
    return _report_response(db, organization_id, current_user, "duplicate-tax-rows", report, format)



# ═════════════════════════════════════════════════════════════════════════
# Phase 4a-2 — provider connections, certificate evidence, provider
# transactions. Tenant-only (get_organization_id refuses platform tokens).
# ═════════════════════════════════════════════════════════════════════════

@router.get("/providers", summary="Tax providers Zoiko can connect to (names and environments; no URLs)")
def list_tax_providers(_org: int = Depends(get_organization_id)):
    """The code-defined provider registry. Endpoints are never returned and
    never accepted: a connection names a provider and an environment only."""
    from app.modules.tax.provider_contract import PROVIDER_REGISTRY

    return {"items": [{"name": name, "environments": sorted(e for e, url in d.endpoints.items()
                                                            if url and url.startswith("https://"))}
                      for name, d in sorted(PROVIDER_REGISTRY.items())]}


@router.get("/provider-connections", summary="Provider connections (credentials never returned)")
def list_provider_connections(seller_entity_id: Optional[int] = Query(None), page: PageParams = Depends(),
                              db: Session = Depends(get_db), organization_id: int = Depends(get_organization_id)):
    from app.modules.tax.connection_service import ProviderConnectionService, view_connection

    rows, next_cursor = paginate(ProviderConnectionService(db).list(organization_id, seller_entity_id), page)
    return {"items": [view_connection(r) for r in rows], "next_cursor": next_cursor}


@router.get("/provider-connections/{connection_id}", summary="A provider connection")
def get_provider_connection(connection_id: int, db: Session = Depends(get_db),
                            organization_id: int = Depends(get_organization_id)):
    from app.modules.tax.connection_service import ProviderConnectionService, view_connection

    return view_connection(ProviderConnectionService(db).get(organization_id, connection_id))


@router.post("/provider-connections", status_code=status.HTTP_201_CREATED,
             summary="Propose a provider connection (endpoint from the allowlist; no URL accepted)",
             dependencies=[Depends(get_current_billing_admin)])
def propose_provider_connection(data: ProviderConnectionCreate, db: Session = Depends(get_db),
                                organization_id: int = Depends(get_organization_id),
                                current_user=Depends(get_current_user)):
    from app.modules.tax.connection_service import ProviderConnectionService, view_connection
    from app.modules.tax.enums import ProviderEnvironment
    from app.modules.tax.provider_contract import ProviderMode

    return view_connection(ProviderConnectionService(db).propose(
        organization_id, current_user.id, seller_entity_id=data.seller_entity_id, provider_name=data.provider_name,
        environment=ProviderEnvironment[data.environment], mode=ProviderMode[data.mode]))


def _connection_action(action: str):
    def handler(connection_id: int, data: Optional[DecisionRequest] = None, db: Session = Depends(get_db),
                organization_id: int = Depends(get_organization_id), current_user=Depends(get_current_user)):
        from app.modules.tax.connection_service import ProviderConnectionService, view_connection

        svc, reason = ProviderConnectionService(db), (data.reason if data else None)
        if action in ("approve", "reject"):
            row = svc.decide(organization_id, current_user.id, connection_id, approve=action == "approve", reason=reason)
        elif action == "withdraw":
            row = svc.withdraw(organization_id, current_user.id, connection_id)
        elif action == "resume":
            row = svc.request_resume(organization_id, current_user.id, connection_id)
        elif action in ("resume-approve", "resume-reject"):
            row = svc.decide_resume(organization_id, current_user.id, connection_id,
                                    approve=action == "resume-approve", reason=reason)
        else:
            row = svc.test_connection(organization_id, current_user.id, connection_id)
        return view_connection(row)
    return handler


for _action, _dep, _summary in (
    ("approve", get_current_finance_approver, "Approve a provider connection (different user)"),
    ("reject", get_current_finance_approver, "Reject a provider connection"),
    ("withdraw", get_current_billing_admin, "Withdraw a proposed provider connection"),
    ("resume", get_current_billing_admin, "Ask to resume a suspended connection (new credentials set)"),
    ("resume-approve", get_current_finance_approver, "Approve resuming a connection (different user)"),
    ("resume-reject", get_current_finance_approver, "Reject resuming a connection"),
    ("test", get_current_billing_admin, "Test the connection (allowlisted endpoint only)"),
):
    router.add_api_route(f"/provider-connections/{{connection_id}}/{_action}", _connection_action(_action),
                         methods=["POST"], dependencies=[Depends(_dep)], summary=_summary)


@router.put("/provider-connections/{connection_id}/credentials",
            summary="Set or rotate credentials (write-only; never returned)",
            dependencies=[Depends(get_current_billing_admin)])
def set_provider_credentials(connection_id: int, data: ProviderCredentialsSet, db: Session = Depends(get_db),
                             organization_id: int = Depends(get_organization_id), current_user=Depends(get_current_user)):
    from app.modules.tax.connection_service import ProviderConnectionService, view_connection

    return view_connection(ProviderConnectionService(db).set_credentials(organization_id, current_user.id,
                                                                         connection_id, data.secret))


@router.post("/provider-connections/{connection_id}/credentials/revoke",
             summary="Revoke credentials: freezes the connection (T16)",
             dependencies=[Depends(get_current_billing_admin)])
def revoke_provider_credentials(connection_id: int, data: ReasonRequest, db: Session = Depends(get_db),
                                organization_id: int = Depends(get_organization_id),
                                current_user=Depends(get_current_user)):
    from app.modules.tax.connection_service import ProviderConnectionService, view_connection

    return view_connection(ProviderConnectionService(db).revoke_credentials(organization_id, current_user.id,
                                                                            connection_id, data.reason))


# ── exemption certificates (model + evidence) ──

@router.get("/exemption-certificates", summary="Exemption certificates")
def list_exemption_certificates(customer_id: Optional[int] = Query(None), page: PageParams = Depends(),
                                db: Session = Depends(get_db), organization_id: int = Depends(get_organization_id)):
    rows, next_cursor = paginate(BuyerEvidenceService(db).list_certificates(organization_id, customer_id), page)
    return {"items": [view_certificate(c) for c in rows], "next_cursor": next_cursor}


@router.post("/exemption-certificates/{certificate_id}/evidence",
             summary="Attach the certificate document once (PDF, PNG or JPEG)",
             dependencies=[Depends(get_current_billing_admin)])
async def attach_certificate_evidence(certificate_id: int, file: UploadFile = File(...),
                                      sha256: Optional[str] = Form(None, max_length=64),
                                      db: Session = Depends(get_db),
                                      organization_id: int = Depends(get_organization_id),
                                      current_user=Depends(get_current_user)):
    from app.config import settings

    content = await file.read(settings.TAX_EVIDENCE_MAX_BYTES + 1)
    return view_certificate(BuyerEvidenceService(db).attach_certificate_evidence(
        organization_id, current_user.id, certificate_id, content=content, media_type=file.content_type or "",
        filename=file.filename, expected_sha256=sha256))


@router.get("/exemption-certificates/{certificate_id}/evidence", summary="Download the certificate document",
            dependencies=[Depends(get_tax_evidence_reader)])
def download_certificate_evidence(certificate_id: int, db: Session = Depends(get_db),
                                  organization_id: int = Depends(get_organization_id)):
    from fastapi.responses import Response

    stored = BuyerEvidenceService(db).certificate_evidence(organization_id, certificate_id)
    return Response(content=stored.content, media_type=stored.media_type,
                    headers={"X-Content-SHA256": stored.sha256, "Cache-Control": "no-store",
                             "Content-Disposition": f'attachment; filename="certificate-{certificate_id}"'})


# ── provider transactions (the stuck-transaction view) ──

def transaction_owner(row) -> Optional[str]:
    """Who has to act next on a provider transaction (Phase 5c): the
    reconciliation worker while it is in flight, a finance approver once a
    void is requested, a billing admin when it needs a person; None once
    it is closed."""
    from app.modules.tax.enums import OutboxState

    if row.void_requested_by is not None and row.state in (OutboxState.REMOTE_COMMITTED,
                                                           OutboxState.REVIEW_REQUIRED):
        return "finance_approver"
    if row.state in (OutboxState.PENDING, OutboxState.UNCERTAIN, OutboxState.REMOTE_COMMITTED):
        return "system"
    if row.state in (OutboxState.REVIEW_REQUIRED, OutboxState.FAILED, OutboxState.CANCELLED):
        return "billing_admin"
    return None


def _transaction_view(db: Session, row, now) -> dict:
    from app.modules.billing.models import Invoice

    invoice = db.get(Invoice, row.invoice_id)
    created = row.created_at if row.created_at.tzinfo else row.created_at.replace(tzinfo=now.tzinfo)
    return {
        "id": row.id, "operation": row.operation.name, "state": row.state.name, "provider_name": row.provider_name,
        "provider_connection_id": row.provider_connection_id, "invoice_id": row.invoice_id,
        "invoice_number": invoice.invoice_number if invoice else None, "credit_note_id": row.credit_note_id,
        "review_kind": row.review_kind, "review_reason": row.review_reason, "last_error": row.last_error,
        "attempts": row.attempts, "age_seconds": int((now - created).total_seconds()),
        "grace_deadline": row.grace_deadline, "next_attempt_at": row.next_attempt_at,
        "provider_transaction_id": row.provider_transaction_id, "verified": row.verified_at is not None,
        "send_requested": bool(row.send_intent), "void_requested_by": row.void_requested_by,
        "owner": transaction_owner(row), "created_at": row.created_at, "completed_at": row.completed_at,
    }


@router.get("/provider-transactions", summary="This organization's provider transactions")
def list_provider_transactions(state: Optional[str] = Query(None, max_length=30),
                               operation: Optional[str] = Query(None, max_length=20),
                               page: PageParams = Depends(), db: Session = Depends(get_db),
                               organization_id: int = Depends(get_organization_id)):
    from datetime import datetime, timezone

    from app.modules.tax.enums import OutboxOperation, OutboxState
    from app.modules.tax.provider_models import TaxProviderOutbox

    q = db.query(TaxProviderOutbox).filter(TaxProviderOutbox.organization_id == organization_id)
    try:
        if state:
            q = q.filter(TaxProviderOutbox.state == OutboxState[state.upper()])
        if operation:
            q = q.filter(TaxProviderOutbox.operation == OutboxOperation[operation.upper()])
    except KeyError:
        raise BadRequestException("Unknown state or operation.")
    rows, next_cursor = paginate(q.order_by(TaxProviderOutbox.id.desc()).all(), page)
    now = datetime.now(timezone.utc)
    return {"items": [_transaction_view(db, r, now) for r in rows], "next_cursor": next_cursor}


def _own_transaction(db: Session, organization_id: int, row_id: int):
    from app.modules.tax.provider_models import TaxProviderOutbox

    row = db.query(TaxProviderOutbox).filter(TaxProviderOutbox.id == row_id,
                                             TaxProviderOutbox.organization_id == organization_id).first()
    if row is None:
        raise NotFoundException("Provider transaction", row_id)
    return row


@router.get("/provider-transactions/{row_id}", summary="One provider transaction")
def get_provider_transaction(row_id: int, db: Session = Depends(get_db),
                             organization_id: int = Depends(get_organization_id)):
    from datetime import datetime, timezone

    return _transaction_view(db, _own_transaction(db, organization_id, row_id), datetime.now(timezone.utc))


def _transaction_action(action: str):
    def handler(row_id: int, db: Session = Depends(get_db), organization_id: int = Depends(get_organization_id),
                current_user=Depends(get_current_user)):
        from datetime import datetime, timezone

        from app.modules.tax.provider_issuance import ProviderIssuanceService

        row = _own_transaction(db, organization_id, row_id)
        svc = ProviderIssuanceService(db)
        if action == "check-state":
            return {"transaction": _transaction_view(db, row, datetime.now(timezone.utc)),
                    "provider": svc.check_state(row.id)}
        if action == "retry":
            row = svc.retry(row.id)
        elif action == "void-request":
            row = svc.request_void(row.id, current_user.id)
        else:
            row = svc.approve_void(row.id, current_user.id)
        return _transaction_view(db, row, datetime.now(timezone.utc))
    return handler


for _action, _dep, _summary in (
    ("check-state", get_current_billing_admin, "Ask the provider what it holds (read-only)"),
    ("retry", get_current_billing_admin, "Re-queue a row that failed on our side"),
    ("void-request", get_current_billing_admin, "Ask to void a committed provider transaction"),
    ("void-approve", get_current_finance_approver, "Approve the void (different user; never-sent invoices only)"),
):
    router.add_api_route(f"/provider-transactions/{{row_id}}/{_action}", _transaction_action(_action),
                         methods=["POST"], dependencies=[Depends(_dep)], summary=_summary)
