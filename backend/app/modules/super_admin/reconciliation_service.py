"""
modules/super_admin/reconciliation_service.py
---------------------------------------------
REC-01 (Production Acceptance Table 13): the ledger reconciliation engine.

HONEST SCOPE (mirrors FinancialConsistencyService):
- Internal ledger invariants are fully evaluated every run:
    1. invoice_balance_arithmetic  — balance_due must equal
       total_amount - paid_amount on every non-draft invoice.
    2. payment_allocation_integrity — a payment's allocations must never
       exceed its amount (over-allocation), and every allocation's invoice
       must belong to the same organization as the payment.
- ISS-017 processor comparison (`compare_processor=True`) is a THIRD,
  optional check: a genuine, bounded Payment<->Stripe-PaymentIntent
  comparison (see `stripe_reconciliation.py`), never a fabricated one. A
  clean run only claims VERIFIED when this comparison actually executed
  against Stripe for at least one organization, with zero processor errors
  and zero truncation. With no processor comparison requested (the
  default) or none possible/complete, a clean run is honestly capped at
  PARTIAL — it never claims VERIFIED merely because
  `settings.STRIPE_SECRET_KEY` happens to be configured.
- Exceptions carry an ownership workflow: OPEN -> ACKNOWLEDGED(owner)
  -> RESOLVED(note). A run with open exceptions is FAILED; failures feed
  the Attention Engine (source "reconciliation") like financial integrity.
"""

import logging
import uuid
from datetime import date, datetime, timedelta
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.modules.billing.models import Invoice, Payment, PaymentAllocation
from app.config import settings
from app.modules.super_admin.models import (
    AttentionSeverity,
    ReconciliationException,
    ReconciliationExceptionStatus,
    ReconciliationRun,
    ReconciliationRunState,
)
from app.modules.super_admin.stripe_reconciliation import (
    MAX_RANGE_DAYS,
    reconcile_processor_payments,
)

logger = logging.getLogger("zoiko_billing.super_admin.reconciliation")

NON_DRAFT_INVOICE_STATUSES = (
    "sent", "paid", "overdue", "partially_paid", "refunded", "written_off",
)


class ReconciliationService:
    def __init__(self, db: Session):
        self.db = db

    # ------------------------------------------------------------------
    # Checks
    # ------------------------------------------------------------------
    def _check_invoice_balances(self) -> list[ReconciliationException]:
        exceptions = []
        rows = self.db.execute(
            select(Invoice).where(Invoice.status.in_(NON_DRAFT_INVOICE_STATUSES))
        ).scalars().all()
        for inv in rows:
            expected = Decimal(str(inv.total_amount or 0)) - Decimal(str(inv.paid_amount or 0))
            actual = Decimal(str(inv.balance_due or 0))
            if abs(expected - actual) > Decimal("0.005"):
                exceptions.append(
                    ReconciliationException(
                        kind="invoice_balance_mismatch",
                        organization_id=inv.organization_id,
                        entity_type="invoice",
                        entity_id=inv.id,
                        detail={
                            "invoice_number": inv.invoice_number,
                            "currency": inv.currency,
                            "total_amount": float(inv.total_amount or 0),
                            "paid_amount": float(inv.paid_amount or 0),
                            "balance_due": float(inv.balance_due or 0),
                            "expected_balance_due": float(expected),
                        },
                    )
                )
        return exceptions

    def _check_payment_allocations(self) -> list[ReconciliationException]:
        exceptions = []
        payments = self.db.execute(select(Payment)).scalars().all()
        alloc_rows = self.db.execute(
            select(PaymentAllocation.payment_id, PaymentAllocation.amount)
        ).all()
        totals: dict[int, Decimal] = {}
        for payment_id, amount in alloc_rows:
            totals[payment_id] = totals.get(payment_id, Decimal("0")) + Decimal(str(amount or 0))
        for pay in payments:
            allocated = totals.get(pay.id, Decimal("0"))
            payment_amount = Decimal(str(pay.amount or 0))
            if allocated > payment_amount + Decimal("0.005"):
                exceptions.append(
                    ReconciliationException(
                        kind="payment_over_allocation",
                        organization_id=pay.organization_id,
                        entity_type="payment",
                        entity_id=pay.id,
                        detail={
                            "payment_number": pay.payment_number,
                            "currency": pay.currency,
                            "payment_amount": float(payment_amount),
                            "allocated_total": round(float(allocated), 2),
                        },
                    )
                )
        return exceptions

    # ------------------------------------------------------------------
    # Run lifecycle
    # ------------------------------------------------------------------
    @staticmethod
    def _exception_identity(exception: ReconciliationException) -> tuple:
        """Return the stable business identity of a detected discrepancy."""
        return (
            exception.kind,
            exception.organization_id,
            exception.entity_type,
            exception.entity_id,
        )

    def _upsert_run_exceptions(
        self,
        run: ReconciliationRun,
        candidates: list[ReconciliationException],
    ) -> list[ReconciliationException]:
        """Keep one active exception row per financial discrepancy.

        A reconciliation run is still recorded every time, but an unresolved
        discrepancy is superseded onto the latest run instead of producing a
        new ownership row on every scheduled execution. Resolved exceptions
        intentionally start a new occurrence if the defect returns.
        """
        active_statuses = (
            ReconciliationExceptionStatus.OPEN,
            ReconciliationExceptionStatus.ACKNOWLEDGED,
        )
        resolved: list[ReconciliationException] = []
        seen: dict[tuple, ReconciliationException] = {}

        for candidate in candidates:
            identity = self._exception_identity(candidate)
            existing = seen.get(identity)
            if existing is None:
                query = self.db.query(ReconciliationException).filter(
                    ReconciliationException.kind == candidate.kind,
                    ReconciliationException.entity_type == candidate.entity_type,
                    ReconciliationException.status.in_(active_statuses),
                )
                if candidate.organization_id is None:
                    query = query.filter(ReconciliationException.organization_id.is_(None))
                else:
                    query = query.filter(ReconciliationException.organization_id == candidate.organization_id)
                if candidate.entity_id is None:
                    query = query.filter(ReconciliationException.entity_id.is_(None))
                else:
                    query = query.filter(ReconciliationException.entity_id == candidate.entity_id)
                existing = query.order_by(ReconciliationException.id.desc()).first()

            if existing is not None:
                # The latest run owns the currently actionable row. Preserve
                # acknowledgement/ownership state while refreshing evidence.
                existing.run_id = run.id
                existing.detail = candidate.detail
                resolved.append(existing)
                seen[identity] = existing
                continue

            candidate.run_id = run.id
            self.db.add(candidate)
            resolved.append(candidate)
            seen[identity] = candidate

        return resolved

    def run_reconciliation(
        self,
        trigger: str = "manual",
        compare_processor: bool = False,
        range_start: date | None = None,
        range_end: date | None = None,
    ) -> ReconciliationRun:
        """Run the two internal ledger-invariant checks, and optionally
        (ISS-017) a genuine bounded Payment<->Stripe-PaymentIntent
        comparison across every organization with an active Stripe
        connection.

        `compare_processor=False` (the default) preserves the exact Phase 9
        behavior/contract: no processor call is made, and a clean run caps
        at PARTIAL. `compare_processor=True` requires an explicit, bounded
        `range_start`/`range_end` (Step 20) — this never scans "all of
        Stripe" by default.
        """
        if compare_processor:
            if range_start is None or range_end is None:
                raise ValueError("range_start and range_end are required when compare_processor=True")
            if range_start > range_end:
                raise ValueError("range_start must not be after range_end")
            if (range_end - range_start) > timedelta(days=MAX_RANGE_DAYS):
                raise ValueError(f"Reconciliation range cannot exceed {MAX_RANGE_DAYS} days")

        run = ReconciliationRun(plane="plane2", trigger=trigger, state=ReconciliationRunState.RUNNING)
        self.db.add(run)
        self.db.flush()

        found: list[ReconciliationException] = []
        found += self._check_invoice_balances()
        found += self._check_payment_allocations()
        checks_total = 2

        stripe_configured = bool(settings.STRIPE_SECRET_KEY)
        if stripe_configured:
            run.processor_source = "stripe"
        processor_result = None
        if compare_processor and stripe_configured:
            processor_result = reconcile_processor_payments(self.db, range_start, range_end)
            checks_total += 1
            run.processor_environment = processor_result["environment"]
            run.processor_stats = {
                k: v for k, v in processor_result.items() if k != "exceptions"
            }
            for exc in processor_result["exceptions"]:
                found.append(ReconciliationException(
                    kind=exc["kind"],
                    organization_id=exc.get("organization_id"),
                    entity_type=exc["entity_type"],
                    entity_id=exc.get("entity_id"),
                    detail=exc.get("detail"),
                ))
            if processor_result["fully_verified"]:
                run.processor_note = (
                    f"Stripe PaymentIntent comparison completed for "
                    f"{len(processor_result['organizations_compared'])} organization(s) "
                    f"over {range_start.isoformat()}..{range_end.isoformat()}: "
                    f"{processor_result['records_inspected']} record(s) inspected, "
                    "0 discrepancies, 0 processor errors."
                )
            elif not processor_result["any_comparison_performed"]:
                run.processor_note = (
                    "Stripe processor comparison was requested, but no organization has "
                    f"an ACTIVE Stripe connection in the '{processor_result['environment']}' "
                    "environment — no Stripe API call was made."
                )
            else:
                run.processor_note = (
                    f"Stripe PaymentIntent comparison attempted for "
                    f"{len(processor_result['organizations_with_active_connection'])} organization(s); "
                    f"{len(processor_result['organizations_compared'])} fully compared, "
                    f"{len(processor_result['processor_errors'])} processor error(s)/truncation(s), "
                    f"{len(processor_result['exceptions'])} discrepanc(y/ies) found."
                )
        elif compare_processor and not stripe_configured:
            run.processor_note = (
                "Stripe processor comparison was requested, but Stripe is not configured "
                "(STRIPE_SECRET_KEY is blank) — no Stripe API call was made."
            )
        elif stripe_configured:
            run.processor_note = (
                "Stripe credentials present, but processor comparison was not requested "
                "for this run; only internal ledger invariants evaluated."
            )
        else:
            run.processor_note = (
                "No processor/bank feed connected; only internal ledger "
                "invariants evaluated this run."
            )

        found = self._upsert_run_exceptions(run, found)

        run.checks_total = checks_total
        run.exceptions_found = len(found)
        if found:
            run.state = ReconciliationRunState.FAILED
        elif processor_result is not None and processor_result["fully_verified"]:
            # A genuine, complete, bounded ledger-vs-Stripe comparison ran
            # for at least one organization with zero discrepancies, zero
            # processor errors, and zero truncation — this is the ONLY path
            # that may claim VERIFIED (Step 10's mandatory rule).
            run.state = ReconciliationRunState.VERIFIED
        else:
            # No processor comparison requested/possible/complete this run
            # — never claim VERIFIED from credential presence alone (the
            # exact fabrication Phase 9 removed). Cap at PARTIAL.
            run.state = ReconciliationRunState.PARTIAL
        run.finished_at = datetime.utcnow()
        self.db.flush()
        return run

    # ------------------------------------------------------------------
    # Exception ownership workflow
    # ------------------------------------------------------------------
    def acknowledge_exception(self, exception_id: int, owner_user_id: int) -> ReconciliationException:
        exc = self.db.get(ReconciliationException, exception_id)
        if exc is None:
            raise ValueError(f"Reconciliation exception {exception_id} not found")
        if exc.status == ReconciliationExceptionStatus.RESOLVED:
            raise ValueError("Cannot acknowledge a resolved exception")
        exc.status = ReconciliationExceptionStatus.ACKNOWLEDGED
        exc.owner_user_id = owner_user_id
        exc.acknowledged_at = datetime.utcnow()
        self.db.flush()
        return exc

    def resolve_exception(self, exception_id: int, note: str) -> ReconciliationException:
        exc = self.db.get(ReconciliationException, exception_id)
        if exc is None:
            raise ValueError(f"Reconciliation exception {exception_id} not found")
        if exc.status == ReconciliationExceptionStatus.RESOLVED:
            raise ValueError("Exception is already resolved")
        note = (note or "").strip()
        if not note:
            raise ValueError("A resolution note is required")
        exc.status = ReconciliationExceptionStatus.RESOLVED
        exc.resolution_note = note[:500]
        exc.resolved_at = datetime.utcnow()
        self.db.flush()
        return exc

    # ------------------------------------------------------------------
    # Attention Engine bridge
    # ------------------------------------------------------------------
    ATTENTION_SOURCE = "ledger_reconciliation"

    @classmethod
    def _exception_attention_key(cls, exception: ReconciliationException) -> str:
        return ":".join(
            (
                cls.ATTENTION_SOURCE,
                "exception",
                exception.kind,
                str(exception.organization_id or "none"),
                exception.entity_type,
                str(exception.entity_id or "none"),
            )
        )

    def report_to_attention_engine(self, run: ReconciliationRun) -> None:
        from app.modules.super_admin.attention_service import AttentionService
        from app.modules.super_admin.models import AttentionItem, AttentionStatus

        attention = AttentionService(self.db)
        seen_keys: set[str] = set()
        if run.state == ReconciliationRunState.FAILED:
            for exception in run.exceptions:
                key = self._exception_attention_key(exception)
                seen_keys.add(key)
                attention.report_or_update(
                    source=self.ATTENTION_SOURCE,
                    source_key=key,
                    title=f"Ledger discrepancy: {exception.kind}",
                    description=(
                        f"Reconciliation run #{run.id} detected {exception.kind} "
                        f"for {exception.entity_type} {exception.entity_id or 'without an entity id'} "
                        f"in organization {exception.organization_id or 'unknown'}. "
                        "Assign an owner in the reconciliation console."
                    ),
                    base_severity=AttentionSeverity.P1,
                    organization_id=exception.organization_id,
                )

        # A clean/partial run means previously observed discrepancies are no
        # longer present. Resolve only reconciliation-generated open items and
        # leave human mitigation/monitoring states untouched via auto_resolve.
        open_items = (
            self.db.query(AttentionItem)
            .filter(
                AttentionItem.source == self.ATTENTION_SOURCE,
                AttentionItem.source_key.like(f"{self.ATTENTION_SOURCE}:exception:%"),
                AttentionItem.status.in_([AttentionStatus.OPEN, AttentionStatus.ACKNOWLEDGED]),
            )
            .all()
        )
        for item in open_items:
            if item.source_key not in seen_keys:
                attention.auto_resolve(
                    source=self.ATTENTION_SOURCE,
                    source_key=item.source_key,
                    resolution_note=f"Reconciliation run #{run.id} no longer found this discrepancy.",
                )

        # Close summary items produced by versions that keyed attention to a
        # run id. New runs use the stable discrepancy key above, so retaining
        # those legacy rows would leave stale duplicate alerts visible.
        legacy_items = (
            self.db.query(AttentionItem)
            .filter(
                AttentionItem.source == self.ATTENTION_SOURCE,
                AttentionItem.source_key.like(f"{self.ATTENTION_SOURCE}:run-%"),
                AttentionItem.status.in_([AttentionStatus.OPEN, AttentionStatus.ACKNOWLEDGED]),
            )
            .all()
        )
        for item in legacy_items:
            attention.auto_resolve(
                source=self.ATTENTION_SOURCE,
                source_key=item.source_key,
                resolution_note=f"Reconciliation attention key migrated by run #{run.id}.",
            )
        self.db.flush()
