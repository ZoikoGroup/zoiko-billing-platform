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

from fastapi import APIRouter, Depends, Header, Query, status
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
    RegimeChangeRequest,
    RegistrationCreate,
    RegistrationUpdate,
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


@router.post("/legal-entities/{entity_id}/regime", summary="Request a tax regime change",
             dependencies=[Depends(get_current_org_admin)])
def request_regime(
    entity_id: int,
    data: RegimeChangeRequest,
    db: Session = Depends(get_db),
    organization_id: int = Depends(get_organization_id),
    current_user=Depends(get_current_user),
):
    return TenantTaxService(db).request_regime(organization_id, current_user.id, entity_id, data.tax_regime)


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
    rows, next_cursor = paginate(ClassificationService(db).list_classifications(organization_id, product_id), page)
    return {"items": [view_classification(c) for c in rows], "next_cursor": next_cursor}


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


@router.get("/reports/legacy-discount-overcollection",
            summary="Estimated tax over-collected by legacy discount-after-tax (this organization)")
def tenant_overcollection_report(
    db: Session = Depends(get_db),
    organization_id: int = Depends(get_organization_id),
    _user=Depends(require_tax_report_role),
):
    return TaxFindingsReportService(db).tenant_overcollection(organization_id)


@router.get("/reports/duplicate-tax-rows", summary="Duplicate legacy tax snapshot rows (this organization)")
def tenant_duplicate_tax_rows(
    db: Session = Depends(get_db),
    organization_id: int = Depends(get_organization_id),
    _user=Depends(require_tax_report_role),
):
    return TaxFindingsReportService(db).tenant_duplicates(organization_id)
