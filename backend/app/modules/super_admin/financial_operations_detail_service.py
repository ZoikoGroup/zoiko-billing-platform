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

from app.modules.super_admin.privacy import count_cells, currency_totals, masked_count


class FinancialOperationsDetailService:
    def __init__(self, db: Session):
        self.db = db

    # ── shared helpers (ZB-SEC-PRIV-001) ────────────────────────────────
    # Every list_* method below returns ONE ROW PER TENANT, aggregated in SQL
    # (GROUP BY organization_id) and passed through privacy.mask_small_cell.
    # `limit` means "max tenants returned" (top N by record count — never by a
    # cross-currency amount sum). No customer / record identifier is selected.

    def _org_names(self, org_ids) -> Dict[int, str]:
        from app.modules.organizations.models import Organization

        ids = [o for o in set(org_ids) if o is not None]
        if not ids:
            return {}
        rows = self.db.query(Organization.id, Organization.organization_name).filter(Organization.id.in_(ids)).all()
        return {oid: name for oid, name in rows}

    @staticmethod
    def _enum_value(value) -> str:
        return value.value if hasattr(value, "value") else str(value)

    def _top_orgs(self, build, org_col, limit: int):
        """build(*cols) -> Query over the (already filtered) record set.
        Returns ([(org_id, n)], platform_total)."""
        total = build(func.count()).scalar() or 0
        rows = (
            build(org_col, func.count().label("n"))
            .group_by(org_col)
            .order_by(func.count().desc(), org_col.asc())
            .limit(limit)
            .all()
        )
        return [(r[0], int(r[1] or 0)) for r in rows], int(total)

    def _status_totals_list(
        self, build, org_col, status_col, currency_col, amount_col, limit: int, single_status: Optional[str] = None
    ) -> Dict[str, Any]:
        top, total = self._top_orgs(build, org_col, limit)
        org_ids = [o for o, _ in top]
        status_by_org: Dict[int, Dict[str, int]] = {}
        currency_by_org: Dict[int, list] = {}
        if org_ids:
            if status_col is not None:
                for oid, st, n in (
                    build(org_col, status_col, func.count())
                    .filter(org_col.in_(org_ids))
                    .group_by(org_col, status_col)
                    .all()
                ):
                    status_by_org.setdefault(oid, {})[self._enum_value(st)] = int(n or 0)
            for oid, cur, n, amt in (
                build(org_col, currency_col, func.count(), func.coalesce(func.sum(amount_col), 0))
                .filter(org_col.in_(org_ids))
                .group_by(org_col, currency_col)
                .all()
            ):
                currency_by_org.setdefault(oid, []).append((cur, n, amt))
        names = self._org_names(org_ids)
        items = []
        for oid, n in top:
            statuses = status_by_org.get(oid) or ({single_status: n} if single_status else {})
            items.append(
                {
                    "organization_id": oid,
                    "organization_name": names.get(oid, "UNKNOWN"),
                    "count_by_status": count_cells(statuses),
                    "total_by_currency": currency_totals(currency_by_org.get(oid, [])),
                }
            )
        return {**masked_count("total", total), "items": items}

    def _status_distribution(self, model, status_col, *filters) -> list:
        rows = (
            self.db.query(status_col, func.count(model.id)).filter(*filters).group_by(status_col).all()
        )
        return [{"status": self._enum_value(s), "count": int(c or 0)} for s, c in rows]

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
        from app.modules.billing.models import Payment, PaymentStatus

        def build(*cols):
            return self.db.query(*cols).filter(Payment.status == PaymentStatus.FAILED, Payment.deleted_at.is_(None))

        top, total = self._top_orgs(build, Payment.organization_id, limit)
        org_ids = [o for o, _ in top]
        currency_by_org: Dict[int, list] = {}
        reasons_by_org: Dict[int, list] = {}
        if org_ids:
            for oid, cur, n, amt in (
                build(Payment.organization_id, Payment.currency, func.count(), func.coalesce(func.sum(Payment.amount), 0))
                .filter(Payment.organization_id.in_(org_ids))
                .group_by(Payment.organization_id, Payment.currency)
                .all()
            ):
                currency_by_org.setdefault(oid, []).append((cur, n, amt))
            # failure_code is a processor error category; free-text failure_reason
            # can embed customer details and is deliberately never selected.
            for oid, code, n in (
                build(Payment.organization_id, Payment.failure_code, func.count())
                .filter(Payment.organization_id.in_(org_ids))
                .group_by(Payment.organization_id, Payment.failure_code)
                .all()
            ):
                reasons_by_org.setdefault(oid, []).append((code or "unspecified", int(n or 0)))
        names = self._org_names(org_ids)
        items = []
        for oid, n in top:
            reasons = sorted(reasons_by_org.get(oid, []), key=lambda r: (-r[1], r[0]))[:3]
            items.append(
                {
                    "organization_id": oid,
                    "organization_name": names.get(oid, "UNKNOWN"),
                    **masked_count("failed_count", n),
                    "failed_total_by_currency": currency_totals(currency_by_org.get(oid, [])),
                    "top_failure_reasons": [
                        {"reason": reason, **masked_count("count", cnt)} for reason, cnt in reasons
                    ],
                }
            )
        return {**masked_count("total", total), "items": items}

    def list_dunning_cases(self, limit: int = 50) -> Dict[str, Any]:
        from app.modules.billing.models import DunningCase

        def build(*cols):
            return self.db.query(*cols).select_from(DunningCase)

        top, total = self._top_orgs(build, DunningCase.organization_id, limit)
        org_ids = [o for o, _ in top]
        stages: Dict[int, Dict[str, int]] = {}
        if org_ids:
            for oid, level, n in (
                build(DunningCase.organization_id, DunningCase.current_level, func.count())
                .filter(DunningCase.organization_id.in_(org_ids))
                .group_by(DunningCase.organization_id, DunningCase.current_level)
                .all()
            ):
                stages.setdefault(oid, {})[f"level_{level}"] = int(n or 0)
        names = self._org_names(org_ids)
        items = [
            {
                "organization_id": oid,
                "organization_name": names.get(oid, "UNKNOWN"),
                "case_count_by_stage": count_cells(dict(sorted(stages.get(oid, {}).items()))),
            }
            for oid, _ in top
        ]
        return {**masked_count("total", total), "items": items}

    # ── Balances & Allocations ──────────────────────────────────────────
    def list_allocation_exceptions(self, limit: int = 50) -> Dict[str, Any]:
        from app.modules.billing.models import Invoice, PaymentAllocation

        allocated_totals = (
            self.db.query(
                PaymentAllocation.invoice_id.label("invoice_id"),
                func.sum(PaymentAllocation.amount).label("allocated"),
            )
            .group_by(PaymentAllocation.invoice_id)
            .subquery()
        )

        def build(*cols):
            return (
                self.db.query(*cols)
                .select_from(Invoice)
                .join(allocated_totals, allocated_totals.c.invoice_id == Invoice.id)
                .filter(allocated_totals.c.allocated > Invoice.total_amount)
            )

        top, total = self._top_orgs(build, Invoice.organization_id, limit)
        names = self._org_names([o for o, _ in top])
        items = [
            {
                "organization_id": oid,
                "organization_name": names.get(oid, "UNKNOWN"),
                "exception_count_by_type": count_cells({"over_allocated": n}),
            }
            for oid, n in top
        ]
        return {**masked_count("total", total), "items": items}

    def list_credit_applications(self, limit: int = 50) -> Dict[str, Any]:
        from app.modules.billing.models import CreditNote, CreditNoteApplication

        def build(*cols):
            return (
                self.db.query(*cols)
                .select_from(CreditNoteApplication)
                .join(CreditNote, CreditNote.id == CreditNoteApplication.credit_note_id)
            )

        return self._status_totals_list(
            build,
            CreditNoteApplication.organization_id,
            None,
            CreditNote.currency,
            CreditNoteApplication.amount,
            limit,
            single_status="applied",
        )

    # ── Credits, Adjustments & Refunds ──────────────────────────────────
    def list_credit_notes(self, limit: int = 50) -> Dict[str, Any]:
        from app.modules.billing.models import CreditNote

        def build(*cols):
            return self.db.query(*cols).select_from(CreditNote).filter(CreditNote.deleted_at.is_(None))

        out = self._status_totals_list(
            build, CreditNote.organization_id, CreditNote.status, CreditNote.currency, CreditNote.total_amount, limit
        )
        out["status_distribution"] = self._status_distribution(
            CreditNote, CreditNote.status, CreditNote.deleted_at.is_(None)
        )
        return out

    def list_refunds(self, limit: int = 50) -> Dict[str, Any]:
        from app.modules.billing.models import Refund

        def build(*cols):
            return self.db.query(*cols).select_from(Refund).filter(Refund.deleted_at.is_(None))

        out = self._status_totals_list(
            build, Refund.organization_id, Refund.status, Refund.currency, Refund.amount, limit
        )
        out["status_distribution"] = self._status_distribution(Refund, Refund.status, Refund.deleted_at.is_(None))
        return out

    def list_write_offs(self, limit: int = 50) -> Dict[str, Any]:
        from app.modules.billing.models import WriteOff

        def build(*cols):
            return self.db.query(*cols).select_from(WriteOff).filter(WriteOff.deleted_at.is_(None))

        out = self._status_totals_list(
            build, WriteOff.organization_id, WriteOff.status, WriteOff.currency, WriteOff.amount, limit
        )
        out["status_distribution"] = self._status_distribution(WriteOff, WriteOff.status, WriteOff.deleted_at.is_(None))
        return out

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
