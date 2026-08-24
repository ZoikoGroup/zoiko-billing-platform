"""
modules/super_admin/financial_operations_detail_service.py
------------------------------------------------------------
Cross-tenant (Domain B, platform-wide) read models backing the split
Financial Operations sub-pages: Invoice Engine, Payments & Disputes,
Balances & Allocations, Credits/Adjustments/Refunds, and Tax.

Every query here drops the org filter that the equivalent tenant-scoped
billing services apply — same shape, platform-wide scope — following the
established pattern in billing_command_center_service.py. No client-side
math beyond simple Python dict joins on already-aggregated SQL results.

Usage/metering and e-invoicing have no backing data model anywhere in this
codebase, so there are deliberately no methods here for them — the
frontend renders an honest "not available" panel instead of calling an
endpoint that doesn't exist.
"""

from typing import Any, Dict, List, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session


class FinancialOperationsDetailService:
    def __init__(self, db: Session):
        self.db = db

    # -- shared helper (mirrors billing_command_center_service.py) ---------
    def _customer_name_map(self, customer_ids: List[int]) -> Dict[int, str]:
        from app.modules.billing.models import BillingCustomer

        ids = [c for c in set(customer_ids) if c is not None]
        if not ids:
            return {}
        rows = (
            self.db.query(BillingCustomer.id, BillingCustomer.company_name, BillingCustomer.display_name)
            .filter(BillingCustomer.id.in_(ids))
            .all()
        )
        return {r[0]: r[1] or r[2] or f"Customer #{r[0]}" for r in rows}

    # ── Invoice Engine ──────────────────────────────────────────────────
    def invoice_status_distribution(self) -> Dict[str, Any]:
        from app.modules.billing.models import Invoice

        rows = (
            self.db.query(
                Invoice.status,
                func.count(Invoice.id),
                func.coalesce(func.sum(Invoice.total_amount), 0),
            )
            .filter(Invoice.deleted_at.is_(None))
            .group_by(Invoice.status)
            .all()
        )
        buckets = [
            {
                "status": s.value if hasattr(s, "value") else str(s),
                "count": int(c or 0),
                "total_amount": str(amt or 0),
            }
            for s, c, amt in rows
        ]
        return {"buckets": buckets, "total_invoices": sum(b["count"] for b in buckets)}

    def invoice_delivery_diagnostics(self) -> Dict[str, Any]:
        from app.modules.billing.models import InvoiceCommunication

        rows = (
            self.db.query(InvoiceCommunication.status, func.count(InvoiceCommunication.id))
            .group_by(InvoiceCommunication.status)
            .all()
        )
        counts = {(s.value if hasattr(s, "value") else str(s)): int(c or 0) for s, c in rows}
        return {
            "sent": counts.get("sent", 0),
            "delivered": counts.get("delivered", 0),
            "failed": counts.get("failed", 0),
            "bounced": counts.get("bounced", 0),
            "total": sum(counts.values()),
        }

    # ── Payments & Disputes ─────────────────────────────────────────────
    def list_failed_payments(self, limit: int = 50) -> Dict[str, Any]:
        from app.modules.billing.models import Payment, PaymentStatus, PaymentAttempt
        from app.modules.organizations.models import Organization

        base = self.db.query(Payment).filter(Payment.status == PaymentStatus.FAILED, Payment.deleted_at.is_(None))
        total = base.with_entities(func.count(Payment.id)).scalar() or 0
        rows = (
            base.join(Organization, Organization.id == Payment.organization_id)
            .order_by(Payment.payment_date.desc())
            .limit(limit)
            .with_entities(
                Payment.id,
                Payment.organization_id,
                Organization.organization_name,
                Payment.customer_id,
                Payment.amount,
                Payment.currency,
                Payment.failure_code,
                Payment.failure_reason,
                Payment.payment_date,
            )
            .all()
        )
        customer_names = self._customer_name_map([r[3] for r in rows])
        payment_ids = [r[0] for r in rows]
        attempt_counts: Dict[int, int] = {}
        if payment_ids:
            attempt_counts = dict(
                self.db.query(PaymentAttempt.payment_id, func.count(PaymentAttempt.id))
                .filter(PaymentAttempt.payment_id.in_(payment_ids))
                .group_by(PaymentAttempt.payment_id)
                .all()
            )
        items = [
            {
                "payment_id": r[0],
                "organization_id": r[1],
                "organization_name": r[2],
                "customer_name": customer_names.get(r[3], "UNKNOWN"),
                "amount": str(r[4] or 0),
                "currency": r[5] or "UNKNOWN",
                "failure_code": r[6],
                "failure_reason": r[7],
                "payment_date": r[8],
                "attempt_count": int(attempt_counts.get(r[0], 0)),
            }
            for r in rows
        ]
        return {"total": total, "items": items}

    def list_dunning_cases(self, limit: int = 50) -> Dict[str, Any]:
        from app.modules.billing.models import DunningCase, Invoice
        from app.modules.organizations.models import Organization

        total = self.db.query(func.count(DunningCase.id)).scalar() or 0
        rows = (
            self.db.query(
                DunningCase.id,
                DunningCase.organization_id,
                Organization.organization_name,
                DunningCase.customer_id,
                DunningCase.invoice_id,
                Invoice.invoice_number,
                Invoice.currency,
                DunningCase.status,
                DunningCase.current_level,
                DunningCase.total_overdue_amount,
                DunningCase.days_overdue,
                DunningCase.last_action_at,
                DunningCase.next_action_at,
            )
            .join(Organization, Organization.id == DunningCase.organization_id)
            .outerjoin(Invoice, Invoice.id == DunningCase.invoice_id)
            .order_by(DunningCase.days_overdue.desc())
            .limit(limit)
            .all()
        )
        customer_names = self._customer_name_map([r[3] for r in rows])
        items = [
            {
                "dunning_case_id": r[0],
                "organization_id": r[1],
                "organization_name": r[2],
                "customer_name": customer_names.get(r[3], "UNKNOWN"),
                "invoice_id": r[4],
                "invoice_number": r[5],
                "currency": r[6] or "UNKNOWN",
                "status": r[7].value if hasattr(r[7], "value") else str(r[7]),
                "current_level": r[8],
                "total_overdue_amount": str(r[9] or 0),
                "days_overdue": r[10],
                "last_action_at": r[11],
                "next_action_at": r[12],
            }
            for r in rows
        ]
        return {"total": total, "items": items}

    # ── Balances & Allocations ──────────────────────────────────────────
    def list_allocation_exceptions(self, limit: int = 50) -> Dict[str, Any]:
        from app.modules.billing.models import Invoice, PaymentAllocation
        from app.modules.organizations.models import Organization

        allocated_totals = (
            self.db.query(
                PaymentAllocation.invoice_id.label("invoice_id"),
                func.sum(PaymentAllocation.amount).label("allocated"),
            )
            .group_by(PaymentAllocation.invoice_id)
            .subquery()
        )
        over_allocated = (
            self.db.query(
                Invoice.id,
                Invoice.organization_id,
                Organization.organization_name,
                Invoice.invoice_number,
                Invoice.currency,
                Invoice.total_amount,
                allocated_totals.c.allocated,
            )
            .join(allocated_totals, allocated_totals.c.invoice_id == Invoice.id)
            .join(Organization, Organization.id == Invoice.organization_id)
            .filter(allocated_totals.c.allocated > Invoice.total_amount)
            .all()
        )
        total = len(over_allocated)
        items = [
            {
                "invoice_id": r[0],
                "organization_id": r[1],
                "organization_name": r[2],
                "invoice_number": r[3],
                "currency": r[4] or "UNKNOWN",
                "total_amount": str(r[5] or 0),
                "allocated_amount": str(r[6] or 0),
            }
            for r in over_allocated[:limit]
        ]
        return {"total": total, "items": items}

    def list_credit_applications(self, limit: int = 50) -> Dict[str, Any]:
        from app.modules.billing.models import CreditNoteApplication, CreditNote, Invoice
        from app.modules.organizations.models import Organization

        total = self.db.query(func.count(CreditNoteApplication.id)).scalar() or 0
        rows = (
            self.db.query(
                CreditNoteApplication.id,
                CreditNoteApplication.organization_id,
                Organization.organization_name,
                CreditNote.credit_note_number,
                Invoice.invoice_number,
                CreditNoteApplication.amount,
                CreditNote.currency,
                CreditNoteApplication.created_at,
            )
            .join(CreditNote, CreditNote.id == CreditNoteApplication.credit_note_id)
            .join(Invoice, Invoice.id == CreditNoteApplication.invoice_id)
            .join(Organization, Organization.id == CreditNoteApplication.organization_id)
            .order_by(CreditNoteApplication.created_at.desc())
            .limit(limit)
            .all()
        )
        items = [
            {
                "application_id": r[0],
                "organization_id": r[1],
                "organization_name": r[2],
                "credit_note_number": r[3],
                "invoice_number": r[4],
                "amount": str(r[5] or 0),
                "currency": r[6] or "UNKNOWN",
                "created_at": r[7],
            }
            for r in rows
        ]
        return {"total": total, "items": items}

    # ── Credits, Adjustments & Refunds ──────────────────────────────────
    def list_credit_notes(self, limit: int = 50) -> Dict[str, Any]:
        from app.modules.billing.models import CreditNote
        from app.modules.organizations.models import Organization

        base = self.db.query(CreditNote).filter(CreditNote.deleted_at.is_(None))
        total = base.with_entities(func.count(CreditNote.id)).scalar() or 0
        status_rows = (
            base.with_entities(CreditNote.status, func.count(CreditNote.id)).group_by(CreditNote.status).all()
        )
        status_distribution = [
            {"status": s.value if hasattr(s, "value") else str(s), "count": int(c or 0)} for s, c in status_rows
        ]
        rows = (
            base.join(Organization, Organization.id == CreditNote.organization_id)
            .order_by(CreditNote.issue_date.desc())
            .limit(limit)
            .with_entities(
                CreditNote.id,
                CreditNote.organization_id,
                Organization.organization_name,
                CreditNote.customer_id,
                CreditNote.credit_note_number,
                CreditNote.credit_note_type,
                CreditNote.status,
                CreditNote.total_amount,
                CreditNote.remaining_amount,
                CreditNote.currency,
                CreditNote.issue_date,
            )
            .all()
        )
        customer_names = self._customer_name_map([r[3] for r in rows])
        items = [
            {
                "credit_note_id": r[0],
                "organization_id": r[1],
                "organization_name": r[2],
                "customer_name": customer_names.get(r[3], "UNKNOWN"),
                "credit_note_number": r[4],
                "credit_note_type": r[5].value if hasattr(r[5], "value") else str(r[5]),
                "status": r[6].value if hasattr(r[6], "value") else str(r[6]),
                "total_amount": str(r[7] or 0),
                "remaining_amount": str(r[8] or 0),
                "currency": r[9] or "UNKNOWN",
                "issue_date": r[10],
            }
            for r in rows
        ]
        return {"total": total, "items": items, "status_distribution": status_distribution}

    def list_refunds(self, limit: int = 50) -> Dict[str, Any]:
        from app.modules.billing.models import Refund
        from app.modules.organizations.models import Organization

        base = self.db.query(Refund).filter(Refund.deleted_at.is_(None))
        total = base.with_entities(func.count(Refund.id)).scalar() or 0
        status_rows = base.with_entities(Refund.status, func.count(Refund.id)).group_by(Refund.status).all()
        status_distribution = [
            {"status": s.value if hasattr(s, "value") else str(s), "count": int(c or 0)} for s, c in status_rows
        ]
        rows = (
            base.join(Organization, Organization.id == Refund.organization_id)
            .order_by(Refund.created_at.desc())
            .limit(limit)
            .with_entities(
                Refund.id,
                Refund.organization_id,
                Organization.organization_name,
                Refund.customer_id,
                Refund.refund_number,
                Refund.refund_type,
                Refund.status,
                Refund.amount,
                Refund.currency,
                Refund.reason,
                Refund.created_at,
            )
            .all()
        )
        customer_names = self._customer_name_map([r[3] for r in rows])
        items = [
            {
                "refund_id": r[0],
                "organization_id": r[1],
                "organization_name": r[2],
                "customer_name": customer_names.get(r[3], "UNKNOWN"),
                "refund_number": r[4],
                "refund_type": r[5].value if hasattr(r[5], "value") else str(r[5]),
                "status": r[6].value if hasattr(r[6], "value") else str(r[6]),
                "amount": str(r[7] or 0),
                "currency": r[8] or "UNKNOWN",
                "reason": r[9],
                "created_at": r[10],
            }
            for r in rows
        ]
        return {"total": total, "items": items, "status_distribution": status_distribution}

    def list_write_offs(self, limit: int = 50) -> Dict[str, Any]:
        from app.modules.billing.models import WriteOff
        from app.modules.organizations.models import Organization

        base = self.db.query(WriteOff).filter(WriteOff.deleted_at.is_(None))
        total = base.with_entities(func.count(WriteOff.id)).scalar() or 0
        status_rows = base.with_entities(WriteOff.status, func.count(WriteOff.id)).group_by(WriteOff.status).all()
        status_distribution = [
            {"status": s.value if hasattr(s, "value") else str(s), "count": int(c or 0)} for s, c in status_rows
        ]
        rows = (
            base.join(Organization, Organization.id == WriteOff.organization_id)
            .order_by(WriteOff.created_at.desc())
            .limit(limit)
            .with_entities(
                WriteOff.id,
                WriteOff.organization_id,
                Organization.organization_name,
                WriteOff.customer_id,
                WriteOff.write_off_number,
                WriteOff.write_off_type,
                WriteOff.status,
                WriteOff.amount,
                WriteOff.currency,
                WriteOff.reason,
                WriteOff.created_at,
            )
            .all()
        )
        customer_names = self._customer_name_map([r[3] for r in rows])
        items = [
            {
                "write_off_id": r[0],
                "organization_id": r[1],
                "organization_name": r[2],
                "customer_name": customer_names.get(r[3], "UNKNOWN"),
                "write_off_number": r[4],
                "write_off_type": r[5].value if hasattr(r[5], "value") else str(r[5]),
                "status": r[6].value if hasattr(r[6], "value") else str(r[6]),
                "amount": str(r[7] or 0),
                "currency": r[8] or "UNKNOWN",
                "reason": r[9],
                "created_at": r[10],
            }
            for r in rows
        ]
        return {"total": total, "items": items, "status_distribution": status_distribution}

    # ── Tax ──────────────────────────────────────────────────────────────
    def get_tax_summary(self, date_from: Optional[str] = None, date_to: Optional[str] = None) -> Dict[str, Any]:
        from app.modules.billing.models import Tax, Invoice

        # Bound parameters inside coalesce() must be the SAME expression object
        # in both SELECT and GROUP BY, or Postgres treats them as structurally
        # different expressions (differing parameter placeholders) and rejects
        # the query even though the literal fallback value is identical.
        currency_expr = func.coalesce(Invoice.currency, "UNKNOWN")
        jurisdiction_expr = func.coalesce(Tax.jurisdiction, "UNKNOWN")

        query = (
            self.db.query(
                currency_expr,
                jurisdiction_expr,
                Tax.tax_type,
                func.count(Tax.id),
                func.coalesce(func.sum(Tax.taxable_amount), 0),
                func.coalesce(func.sum(Tax.tax_amount), 0),
            )
            .outerjoin(Invoice, Invoice.id == Tax.invoice_id)
            .filter(Tax.is_active.is_(True))
        )
        if date_from:
            query = query.filter(func.date(Tax.created_at) >= date_from)
        if date_to:
            query = query.filter(func.date(Tax.created_at) <= date_to)
        rows = query.group_by(currency_expr, jurisdiction_expr, Tax.tax_type).all()

        buckets = [
            {
                "currency": currency,
                "jurisdiction": jurisdiction,
                "tax_type": (tax_type.value if hasattr(tax_type, "value") else str(tax_type)) if tax_type else "UNKNOWN",
                "record_count": int(count or 0),
                "taxable_amount": str(taxable or 0),
                "tax_amount": str(tax_amt or 0),
            }
            for currency, jurisdiction, tax_type, count, taxable, tax_amt in rows
        ]
        return {"buckets": buckets, "total_records": sum(b["record_count"] for b in buckets)}
