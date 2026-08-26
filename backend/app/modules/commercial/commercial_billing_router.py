"""
modules/commercial/commercial_billing_router.py
-----------------------------------------------
Plane 1 — Commercial billing endpoints for the Super Admin Command Center.

Authenticated endpoints require capability checks. Public quote endpoints
(token-based, unauthenticated) are mounted separately.

DOCTRINE:
  - All capability checks use require_capability from core/capabilities.py
  - Public quote endpoints are OUTSIDE the authenticated router
  - No client-side money aggregation — all totals from backend
"""

import logging
from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, Depends, Query, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.capabilities import require_capability
from app.core.dependencies import get_current_super_admin
from app.database import get_db
from app.modules.commercial.enums import (
    CommercialQuoteStatus,
    PlatformInvoiceStatus,
    PlatformPaymentStatus,
)
from app.modules.commercial.models import (
    CommercialQuote,
    CommercialQuoteItem,
    PlatformCreditNote,
    PlatformInvoice,
    PlatformInvoiceItem,
    PlatformPayment,
    PlatformPaymentAllocation,
    PlatformRefund,
)
from app.modules.commercial.platform_invoice_service import PlatformInvoiceService
from app.modules.commercial.platform_payment_service import PlatformPaymentService
from app.modules.commercial.platform_reconciliation_service import PlatformReconciliationService
from app.modules.commercial.quote_service import CommercialQuoteService
from app.modules.super_admin.kill_switch_service import (
    PAUSE_PLATFORM_INVOICE_FINALIZATION,
    BillingBlockedError,
    BillingKillSwitchService,
)

logger = logging.getLogger("zoiko_billing.commercial.router")

# ═══════════════════════════════════════════════════════════════════════════════
# Schemas
# ═══════════════════════════════════════════════════════════════════════════════


class QuoteCreateRequest(BaseModel):
    account_id: int
    subject: Optional[str] = None
    notes: Optional[str] = None
    terms: Optional[str] = None
    valid_until: Optional[date] = None
    currency: str = "USD"
    subscription_id: Optional[int] = None


class QuoteItemRequest(BaseModel):
    line_number: int
    description: str
    quantity: Decimal = Decimal("1")
    unit_price: Decimal
    discount_amount: Decimal = Decimal("0")
    tax_amount: Decimal = Decimal("0")


class QuoteRejectRequest(BaseModel):
    reason: str = ""


class QuoteDiscountRequest(BaseModel):
    discount_amount: Decimal
    reason: Optional[str] = None
    approver_id: Optional[int] = None


class InvoiceCreateRequest(BaseModel):
    account_id: int
    subscription_id: Optional[int] = None
    issue_date: Optional[date] = None
    due_date: Optional[date] = None
    notes: Optional[str] = None
    currency: str = "USD"


class InvoiceItemRequest(BaseModel):
    line_number: int
    description: str
    quantity: Decimal = Decimal("1")
    unit_price: Decimal
    discount_amount: Decimal = Decimal("0")
    tax_amount: Decimal = Decimal("0")


class InvoiceVoidRequest(BaseModel):
    reason: str


class PaymentRecordRequest(BaseModel):
    account_id: int
    amount: Decimal
    currency: str = "USD"
    payment_method: Optional[str] = None
    transaction_id: Optional[str] = None
    notes: Optional[str] = None


class PaymentAllocateRequest(BaseModel):
    invoice_id: int
    amount: Decimal


class CreditNoteCreateRequest(BaseModel):
    account_id: int
    invoice_id: Optional[int] = None
    reason: Optional[str] = None
    subtotal: Decimal = Decimal("0")
    discount_amount: Decimal = Decimal("0")
    tax_amount: Decimal = Decimal("0")
    total_amount: Decimal
    currency: str = "USD"


class RefundCreateRequest(BaseModel):
    account_id: int
    invoice_id: Optional[int] = None
    payment_id: Optional[int] = None
    credit_note_id: Optional[int] = None
    amount: Decimal
    currency: str = "USD"
    reason: Optional[str] = None


# ═══════════════════════════════════════════════════════════════════════════════
# Authenticated router (requires super_admin + capability)
# ═══════════════════════════════════════════════════════════════════════════════

router = APIRouter(
    prefix="/super-admin/commercial-billing",
    tags=["Plane 1 Commercial Billing"],
)


# ── Quotes ──────────────────────────────────────────────────────────────────

@router.post(
    "/quotes",
    status_code=status.HTTP_201_CREATED,
    summary="Create a commercial quote",
    dependencies=[Depends(require_capability("commercial_quote.write"))],
)
def create_quote(
    data: QuoteCreateRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_super_admin),
):
    svc = CommercialQuoteService(db)
    quote = svc.create_quote(
        account_id=data.account_id,
        actor_id=current_user.id,
        subject=data.subject,
        notes=data.notes,
        terms=data.terms,
        valid_until=data.valid_until,
        currency=data.currency,
        subscription_id=data.subscription_id,
    )
    db.commit()
    return quote


@router.get(
    "/quotes",
    summary="List commercial quotes",
    dependencies=[Depends(require_capability("commercial_financial.read"))],
)
def list_quotes(
    db: Session = Depends(get_db),
    account_id: Optional[int] = Query(None),
    status_filter: Optional[str] = Query(None, alias="status"),
    limit: int = Query(50, ge=1, le=200),
):
    query = db.query(CommercialQuote)
    if account_id:
        query = query.filter(CommercialQuote.commercial_account_id == account_id)
    if status_filter:
        query = query.filter(CommercialQuote.status == status_filter)
    return query.order_by(CommercialQuote.created_at.desc()).limit(limit).all()


@router.get(
    "/quotes/{quote_id}",
    summary="Get a commercial quote",
    dependencies=[Depends(require_capability("commercial_financial.read"))],
)
def get_quote(quote_id: int, db: Session = Depends(get_db)):
    svc = CommercialQuoteService(db)
    return _serialize_quote_detail(svc._get_quote(quote_id))


@router.post(
    "/quotes/{quote_id}/items",
    status_code=status.HTTP_201_CREATED,
    summary="Add a line item to a DRAFT commercial quote",
    dependencies=[Depends(require_capability("commercial_quote.write"))],
)
def add_quote_item(
    quote_id: int,
    data: QuoteItemRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_super_admin),
):
    svc = CommercialQuoteService(db)
    item = svc.add_item(
        quote_id=quote_id,
        actor_id=current_user.id,
        line_number=data.line_number,
        description=data.description,
        quantity=data.quantity,
        unit_price=data.unit_price,
        discount_amount=data.discount_amount,
        tax_amount=data.tax_amount,
    )
    db.commit()
    return item


@router.post(
    "/quotes/{quote_id}/discount",
    summary="Set a quote-level discount (amount + reason + approver, §B7)",
    dependencies=[Depends(require_capability("commercial_quote.write"))],
)
def set_quote_discount(
    quote_id: int,
    data: QuoteDiscountRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_super_admin),
):
    svc = CommercialQuoteService(db)
    quote = svc.set_discount(
        quote_id=quote_id,
        actor_id=current_user.id,
        discount_amount=data.discount_amount,
        reason=data.reason,
        approver_id=data.approver_id,
    )
    db.commit()
    return quote


@router.post(
    "/quotes/{quote_id}/send",
    summary="Send a commercial quote",
    dependencies=[Depends(require_capability("commercial_quote.write"))],
)
def send_quote(
    quote_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_super_admin),
):
    svc = CommercialQuoteService(db)
    quote = svc.send_quote(quote_id=quote_id, actor_id=current_user.id)
    db.commit()
    return quote


@router.post(
    "/quotes/{quote_id}/approve",
    summary="Approve a commercial quote (enforces approver != creator)",
    dependencies=[Depends(require_capability("commercial_quote.approve"))],
)
def approve_quote(
    quote_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_super_admin),
):
    svc = CommercialQuoteService(db)
    quote = svc.approve_quote(quote_id=quote_id, actor_id=current_user.id)
    db.commit()
    return quote


@router.post(
    "/quotes/{quote_id}/reject",
    summary="Reject a commercial quote",
    dependencies=[Depends(require_capability("commercial_quote.approve"))],
)
def reject_quote(
    quote_id: int,
    data: QuoteRejectRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_super_admin),
):
    svc = CommercialQuoteService(db)
    quote = svc.reject_quote(
        quote_id=quote_id, actor_id=current_user.id, reason=data.reason
    )
    db.commit()
    return quote


@router.post(
    "/quotes/{quote_id}/convert",
    summary="Convert an accepted quote to a platform invoice",
    dependencies=[Depends(require_capability("commercial_quote.write"))],
)
def convert_quote(
    quote_id: int,
    due_date: Optional[date] = Query(None),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_super_admin),
):
    svc = CommercialQuoteService(db)
    invoice = svc.convert_to_invoice(
        quote_id=quote_id, actor_id=current_user.id, due_date=due_date
    )
    db.commit()
    return invoice


# ── Platform Invoices ───────────────────────────────────────────────────────

@router.post(
    "/invoices",
    status_code=status.HTTP_201_CREATED,
    summary="Create a platform invoice",
    dependencies=[Depends(require_capability("commercial_financial.read"))],
)
def create_invoice(
    data: InvoiceCreateRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_super_admin),
):
    svc = PlatformInvoiceService(db)
    invoice = svc.create_draft(
        account_id=data.account_id,
        actor_id=current_user.id,
        subscription_id=data.subscription_id,
        issue_date=data.issue_date,
        due_date=data.due_date,
        notes=data.notes,
        currency=data.currency,
    )
    db.commit()
    return invoice


@router.get(
    "/invoices",
    summary="List platform invoices",
    dependencies=[Depends(require_capability("commercial_financial.read"))],
)
def list_invoices(
    db: Session = Depends(get_db),
    account_id: Optional[int] = Query(None),
    status_filter: Optional[str] = Query(None, alias="status"),
    limit: int = Query(50, ge=1, le=200),
):
    query = db.query(PlatformInvoice)
    if account_id:
        query = query.filter(PlatformInvoice.commercial_account_id == account_id)
    if status_filter:
        query = query.filter(PlatformInvoice.status == status_filter)
    return query.order_by(PlatformInvoice.created_at.desc()).limit(limit).all()


@router.get(
    "/invoices/{invoice_id}",
    summary="Get a platform invoice",
    dependencies=[Depends(require_capability("commercial_financial.read"))],
)
def get_invoice(invoice_id: int, db: Session = Depends(get_db)):
    svc = PlatformInvoiceService(db)
    return _serialize_invoice_detail(svc._get_invoice(invoice_id))


@router.post(
    "/invoices/{invoice_id}/finalize",
    summary="Finalize a platform invoice (DRAFT → ISSUED)",
    dependencies=[Depends(require_capability("commercial_financial.read"))],
)
def finalize_invoice(
    invoice_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_super_admin),
):
    # Circuit breaker check
    ks = BillingKillSwitchService(db)
    if not ks.is_enabled(PAUSE_PLATFORM_INVOICE_FINALIZATION):
        ks.ensure_switch(PAUSE_PLATFORM_INVOICE_FINALIZATION)

    svc = PlatformInvoiceService(db)
    invoice = svc.finalize(invoice_id=invoice_id, actor_id=current_user.id)
    db.commit()
    return invoice


@router.post(
    "/invoices/{invoice_id}/send",
    summary="Send an issued platform invoice to the org's admin by email",
    dependencies=[Depends(require_capability("commercial_financial.read"))],
)
def send_invoice(
    invoice_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_super_admin),
):
    svc = PlatformInvoiceService(db)
    invoice = svc.send(invoice_id=invoice_id, actor_id=current_user.id)
    db.commit()
    return invoice


@router.post(
    "/invoices/{invoice_id}/void",
    summary="Void a platform invoice",
    dependencies=[Depends(require_capability("commercial_financial.read"))],
)
def void_invoice(
    invoice_id: int,
    data: InvoiceVoidRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_super_admin),
):
    svc = PlatformInvoiceService(db)
    invoice = svc.void(
        invoice_id=invoice_id, actor_id=current_user.id, reason=data.reason
    )
    db.commit()
    return invoice


@router.post(
    "/invoices/{invoice_id}/items",
    status_code=status.HTTP_201_CREATED,
    summary="Add item to a platform invoice (DRAFT only)",
    dependencies=[Depends(require_capability("commercial_financial.read"))],
)
def add_invoice_item(
    invoice_id: int,
    data: InvoiceItemRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_super_admin),
):
    svc = PlatformInvoiceService(db)
    item = svc.add_item(
        invoice_id=invoice_id,
        actor_id=current_user.id,
        line_number=data.line_number,
        description=data.description,
        quantity=data.quantity,
        unit_price=data.unit_price,
        discount_amount=data.discount_amount,
        tax_amount=data.tax_amount,
    )
    db.commit()
    return item


# ── Platform Payments ───────────────────────────────────────────────────────

@router.post(
    "/payments",
    status_code=status.HTTP_201_CREATED,
    summary="Record a platform payment",
    dependencies=[Depends(require_capability("commercial_payment.write"))],
)
def record_payment(
    data: PaymentRecordRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_super_admin),
):
    svc = PlatformPaymentService(db)
    payment = svc.record(
        account_id=data.account_id,
        actor_id=current_user.id,
        amount=data.amount,
        currency=data.currency,
        payment_method=data.payment_method,
        transaction_id=data.transaction_id,
        notes=data.notes,
    )
    db.commit()
    return payment


@router.get(
    "/payments",
    summary="List platform payments",
    dependencies=[Depends(require_capability("commercial_financial.read"))],
)
def list_payments(
    db: Session = Depends(get_db),
    account_id: Optional[int] = Query(None),
    status_filter: Optional[str] = Query(None, alias="status"),
    limit: int = Query(50, ge=1, le=200),
):
    query = db.query(PlatformPayment)
    if account_id:
        query = query.filter(PlatformPayment.commercial_account_id == account_id)
    if status_filter:
        query = query.filter(PlatformPayment.status == status_filter)
    return query.order_by(PlatformPayment.created_at.desc()).limit(limit).all()


@router.post(
    "/payments/{payment_id}/allocate",
    summary="Allocate a payment to an invoice",
    dependencies=[Depends(require_capability("commercial_payment.write"))],
)
def allocate_payment(
    payment_id: int,
    data: PaymentAllocateRequest,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_super_admin),
):
    svc = PlatformPaymentService(db)
    allocation = svc.allocate(
        payment_id=payment_id,
        invoice_id=data.invoice_id,
        amount=data.amount,
        actor_id=current_user.id,
    )
    db.commit()
    return allocation


@router.post(
    "/payments/{payment_id}/deallocate",
    summary="Deallocate a payment from an invoice",
    dependencies=[Depends(require_capability("commercial_payment.write"))],
)
def deallocate_payment(
    payment_id: int,
    invoice_id: int = Query(...),
    db: Session = Depends(get_db),
    current_user=Depends(get_current_super_admin),
):
    svc = PlatformPaymentService(db)
    svc.deallocate(
        payment_id=payment_id,
        invoice_id=invoice_id,
        actor_id=current_user.id,
    )
    db.commit()
    return {"status": "deallocated"}


# ── Reconciliation ──────────────────────────────────────────────────────────

@router.post(
    "/reconciliation/run",
    summary="Run platform ledger reconciliation",
    dependencies=[Depends(require_capability("commercial_financial.read"))],
)
def run_reconciliation(
    db: Session = Depends(get_db),
):
    svc = PlatformReconciliationService(db)
    run = svc.run_reconciliation(trigger="manual")
    db.commit()
    return run


@router.get(
    "/reconciliation/runs",
    summary="List reconciliation runs",
    dependencies=[Depends(require_capability("commercial_financial.read"))],
)
def list_reconciliation_runs(
    db: Session = Depends(get_db),
    limit: int = Query(20, ge=1, le=100),
):
    from app.modules.super_admin.models import ReconciliationRun

    return (
        db.query(ReconciliationRun)
        .filter(ReconciliationRun.plane == "plane1")
        .order_by(ReconciliationRun.started_at.desc())
        .limit(limit)
        .all()
    )


# ═══════════════════════════════════════════════════════════════════════════════
# Public (unauthenticated) quote + invoice endpoints
# Mounted OUTSIDE the authenticated router (see main.py). Responses are
# hand-built dicts, never raw ORM objects — this is the one place in the
# module reachable with no auth, so internal FK ids (commercial_account_id,
# created_by, discount_approver_id, ...) must never leak into the payload.
# ═══════════════════════════════════════════════════════════════════════════════

public_quote_router = APIRouter(
    prefix="/commercial-quotes/public",
    tags=["Plane 1 Quotes (Public)"],
)

public_invoice_router = APIRouter(
    prefix="/commercial-invoices/public",
    tags=["Plane 1 Invoices (Public)"],
)


class PublicQuoteRejectRequest(BaseModel):
    reason: str = ""


def _serialize_public_quote_item(item) -> dict:
    return {
        "line_number": item.line_number,
        "description": item.description,
        "quantity": str(item.quantity),
        "unit_price": str(item.unit_price),
        "discount_amount": str(item.discount_amount),
        "tax_amount": str(item.tax_amount),
        "total": str(item.total),
    }


def _serialize_public_quote(quote: CommercialQuote) -> dict:
    return {
        "quote_number": quote.quote_number,
        "status": quote.status.value,
        "subject": quote.subject,
        "notes": quote.notes,
        "terms": quote.terms,
        "currency": quote.currency,
        "subtotal": str(quote.subtotal),
        "discount_amount": str(quote.discount_amount),
        "tax_amount": str(quote.tax_amount),
        "total_amount": str(quote.total_amount),
        "valid_until": quote.valid_until.isoformat() if quote.valid_until else None,
        "created_at": quote.created_at.isoformat() if quote.created_at else None,
        "items": [
            _serialize_public_quote_item(i)
            for i in sorted(quote.items, key=lambda i: i.line_number)
        ],
    }


def _serialize_public_invoice_item(item) -> dict:
    return {
        "line_number": item.line_number,
        "description": item.description,
        "quantity": str(item.quantity),
        "unit_price": str(item.unit_price),
        "discount_amount": str(item.discount_amount),
        "tax_amount": str(item.tax_amount),
        "total": str(item.total),
    }


def _serialize_public_invoice(invoice: PlatformInvoice) -> dict:
    return {
        "invoice_number": invoice.invoice_number,
        "status": invoice.status.value,
        "notes": invoice.notes,
        "currency": invoice.currency,
        "issue_date": invoice.issue_date.isoformat() if invoice.issue_date else None,
        "due_date": invoice.due_date.isoformat() if invoice.due_date else None,
        "subtotal": str(invoice.subtotal),
        "discount_amount": str(invoice.discount_amount),
        "tax_amount": str(invoice.tax_amount),
        "total_amount": str(invoice.total_amount),
        "paid_amount": str(invoice.paid_amount),
        "balance_due": str(invoice.balance_due),
        "recipient_org_name": (
            invoice.account.organization.organization_name
            if invoice.account and invoice.account.organization
            else None
        ),
        "items": [
            _serialize_public_invoice_item(i)
            for i in sorted(invoice.items, key=lambda i: i.line_number)
        ],
    }


def _serialize_quote_detail(quote: CommercialQuote) -> dict:
    """Authenticated (Super Admin) quote detail — same item/money shape as
    the public serializer, plus internal fields safe only for staff eyes."""
    data = _serialize_public_quote(quote)
    data.update(
        {
            "id": quote.id,
            "commercial_account_id": quote.commercial_account_id,
            "created_by": quote.created_by,
            "public_token": quote.public_token,
            "discount_reason": quote.discount_reason,
            "discount_approver_id": quote.discount_approver_id,
        }
    )
    return data


def _serialize_invoice_detail(invoice: PlatformInvoice) -> dict:
    """Authenticated (Super Admin) invoice detail — same item/money shape as
    the public serializer, plus internal fields safe only for staff eyes."""
    data = _serialize_public_invoice(invoice)
    data.update(
        {
            "id": invoice.id,
            "commercial_account_id": invoice.commercial_account_id,
            "created_by": invoice.created_by,
            "public_token": invoice.public_token,
            "delivery_status": invoice.delivery_status.value,
            "payment_status": invoice.payment_status.value,
            "delivery_attempts": [
                {
                    "channel": a.channel,
                    "provider": a.provider,
                    "attempted_at": a.attempted_at.isoformat() if a.attempted_at else None,
                    "result": a.result,
                    "error_detail": a.error_detail,
                }
                for a in sorted(invoice.delivery_attempts, key=lambda a: a.attempted_at or datetime.min)
            ],
        }
    )
    return data


@public_quote_router.get(
    "/{token}",
    summary="Publicly view a quote via signed link token",
)
def get_public_quote(token: str, db: Session = Depends(get_db)):
    svc = CommercialQuoteService(db)
    return _serialize_public_quote(svc.get_public_quote(token))


@public_quote_router.post(
    "/{token}/accept",
    summary="Publicly accept a quote via signed link token",
)
def accept_public_quote(token: str, db: Session = Depends(get_db)):
    svc = CommercialQuoteService(db)
    quote = svc.accept_public_quote(token)
    db.commit()
    return _serialize_public_quote(quote)


@public_quote_router.post(
    "/{token}/reject",
    summary="Publicly reject a quote via signed link token",
)
def reject_public_quote(
    token: str,
    data: PublicQuoteRejectRequest,
    db: Session = Depends(get_db),
):
    svc = CommercialQuoteService(db)
    quote = svc.reject_public_quote(token, data.reason)
    db.commit()
    return _serialize_public_quote(quote)


@public_invoice_router.get(
    "/{token}",
    summary="Publicly view a platform invoice via signed link token",
)
def get_public_invoice(token: str, db: Session = Depends(get_db)):
    svc = PlatformInvoiceService(db)
    return _serialize_public_invoice(svc.get_public_invoice(token))
