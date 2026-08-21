"""
modules/super_admin/financial_consistency_service.py
--------------------------------------------------------
ZB-SA-CMD-003 §15 / this session's Phase 15 — "financial integrity."

IMPORTANT NAMING HONESTY: this is NOT the composite ledger reconciliation
the spec describes (tenant ledger vs. processor/bank evidence — ISS-017,
still open, genuinely blocked on a processor/bank data source this
codebase doesn't have). This is a much smaller, real thing: an INTERNAL
consistency check within Zoiko Billing's own database, verifying that
`PaymentAllocation` rows (Domain B, tenant-scoped) never exceed the
invoice they're allocated against. That invariant is checkable today with
data that already exists; it proves something narrower than "the books are
reconciled with the bank," and this module never claims otherwise.

Deliberately conservative to avoid false positives: `CreditNote`/`Refund`
adjustments to what an invoice actually still owes are NOT factored in, so
under-allocation on a PAID invoice is reported as informational, not a
failure (a credit note could legitimately explain it). Over-allocation
(allocated amount exceeding the invoice's own total_amount) has no such
legitimate explanation in this codebase's model (there is no OVERPAID
invoice status) and is treated as a real integrity failure.
"""

from typing import Any, Dict

from sqlalchemy import func
from sqlalchemy.orm import Session


class FinancialConsistencyService:
    def __init__(self, db: Session):
        self.db = db

    def check_allocation_consistency(self, limit_examples: int = 20) -> Dict[str, Any]:
        from app.modules.billing.models import Invoice, InvoiceStatus, PaymentAllocation

        allocated_totals = (
            self.db.query(
                PaymentAllocation.invoice_id.label("invoice_id"),
                func.sum(PaymentAllocation.amount).label("allocated"),
            )
            .group_by(PaymentAllocation.invoice_id)
            .subquery()
        )

        all_over_allocated = (
            self.db.query(
                Invoice.id, Invoice.organization_id, Invoice.invoice_number,
                Invoice.total_amount, allocated_totals.c.allocated,
            )
            .join(allocated_totals, allocated_totals.c.invoice_id == Invoice.id)
            .filter(allocated_totals.c.allocated > Invoice.total_amount)
            .all()
        )
        over_allocated_count = len(all_over_allocated)
        over_allocated_rows = all_over_allocated[:limit_examples]

        under_allocated_paid_count = (
            self.db.query(func.count())
            .select_from(
                self.db.query(Invoice.id)
                .outerjoin(allocated_totals, allocated_totals.c.invoice_id == Invoice.id)
                .filter(
                    Invoice.status == InvoiceStatus.PAID,
                    func.coalesce(allocated_totals.c.allocated, 0) < Invoice.total_amount,
                )
                .subquery()
            )
            .scalar()
            or 0
        )

        total_invoices = self.db.query(func.count(Invoice.id)).scalar() or 0

        if over_allocated_count > 0:
            state = "FAILED"
        elif total_invoices == 0:
            state = "UNKNOWN"
        else:
            state = "VERIFIED"

        return {
            "state": state,
            "scope": "internal_allocation_consistency",
            "total_invoices_checked": total_invoices,
            "over_allocated_count": over_allocated_count,
            "over_allocated_examples": [
                {
                    "invoice_id": r.id,
                    "organization_id": r.organization_id,
                    "invoice_number": r.invoice_number,
                    "total_amount": str(r.total_amount),
                    "allocated_amount": str(r.allocated),
                }
                for r in over_allocated_rows
            ],
            "under_allocated_paid_count_informational": under_allocated_paid_count,
            "coverage_note": (
                "Compares PaymentAllocation totals against Invoice.total_amount only. "
                "Does not account for CreditNote/Refund adjustments — "
                "under_allocated_paid_count_informational may include invoices "
                "legitimately reduced by a credit note and is NOT a failure signal. "
                "This is an internal data-integrity check, not reconciliation "
                "against processor/bank records (no such data source exists in "
                "this codebase — see ISS-017)."
            ),
        }

    def run_scheduled_check(self) -> Dict[str, Any]:
        """Scheduled entry point (financial-consistency job). Runs the
        internal consistency check and feeds the result into the Attention
        Engine with the §8 severity floor: a financial-integrity failure is
        P0 from the first occurrence — it never enters via the P2/P3 ladder,
        because money-integrity signals are not allowed to wait for an
        escalation counter. A VERIFIED run auto-resolves the item."""
        from app.modules.super_admin.attention_service import AttentionService
        from app.modules.super_admin.models import AttentionSeverity

        result = self.check_allocation_consistency()
        attention = AttentionService(self.db)
        if result["state"] == "FAILED":
            examples = result["over_allocated_examples"][:5]
            attention.report_or_update(
                source="financial_integrity",
                source_key="financial_integrity:allocation",
                title="Financial integrity check failing (over-allocated payments)",
                description=(
                    f"{result['over_allocated_count']} invoice(s) have PaymentAllocation "
                    f"totals exceeding their total_amount. Examples: {examples}."
                ),
                base_severity=AttentionSeverity.P0,  # §8 severity floor
            )
        elif result["state"] == "VERIFIED":
            attention.auto_resolve(
                source="financial_integrity",
                source_key="financial_integrity:allocation",
                resolution_note="Financial integrity check now VERIFIED.",
            )
        # UNKNOWN (empty database) is deliberately not a signal either way.
        self.db.flush()
        return result
