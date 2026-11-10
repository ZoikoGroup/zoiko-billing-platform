"""
app/modules/tax/remediation_service.py
--------------------------------------
Targeted remediation (ZB-TAX-ARCH-001 Phase 7 PR 4, handoff §10.1 step 08):
no silent historical mutation.

  Legacy discount over-collection  per affected invoice, a corrective credit
                                   note for the over-collected tax (created as
                                   a DRAFT; issued through the normal flow)
  Duplicate legacy tax rows        remove true duplicates; every removed row is
                                   archived whole and the batch can be reversed

Rules for both:
  * previews are always available and change nothing;
  * executing needs a batch proposed by an org admin and approved by a
    different finance approver; it is capped (TAX_REMEDIATION_MAX_BATCH),
    idempotent (an invoice is never remediated twice for the same kind),
    audited, and produces an evidence bundle (Phase 5c format);
  * it is OFF per organization until the product owner decides:
    TAX_REMEDIATION_OVERCOLLECTION_ORGS / TAX_REMEDIATION_DUPLICATES_ORGS
    list the organization ids allowed to execute.

Legacy quote -> invoice repricing (product question 1) has no tooling: it
waits on the product decision.
"""
from collections import defaultdict
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Optional

from sqlalchemy.orm import Session

from app.config import settings
from app.core.exceptions import BadRequestException, ForbiddenException, NotFoundException
from app.modules.billing.models import BillingAuditAction, CreditNoteType, Invoice, Tax
from app.modules.billing.services.audit_service import BillingAuditService
from app.modules.tax.enums import TenantApprovalStatus
from app.modules.tax.remediation_models import (
    DUPLICATE_ROWS, OVERCOLLECTION_CREDIT, REMEDIATION_KINDS, TaxDuplicateRowArchive, TaxRemediationBatch,
    TaxRemediationItem,
)

ROW_COLUMNS = ("id", "organization_id", "invoice_id", "credit_note_id", "tax_rate_id", "taxable_amount", "tax_amount",
               "tax_percentage", "jurisdiction", "tax_type", "is_reverse_charge", "is_active", "created_by", "created_at")
SAME_FIELDS = ("credit_note_id", "taxable_amount", "tax_amount", "tax_percentage", "jurisdiction", "tax_type",
               "is_reverse_charge")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _ids(raw: str) -> set:
    return {int(x) for x in (raw or "").replace(" ", "").split(",") if x.strip().isdigit()}


def enabled(organization_id: int, kind: str) -> bool:
    raw = getattr(settings, "TAX_REMEDIATION_OVERCOLLECTION_ORGS" if kind == OVERCOLLECTION_CREDIT
                  else "TAX_REMEDIATION_DUPLICATES_ORGS", "")
    return organization_id in _ids(raw)


def max_batch() -> int:
    return int(getattr(settings, "TAX_REMEDIATION_MAX_BATCH", 25))


def _remediated(db: Session, kind: str, invoice_ids) -> dict:
    return {i.invoice_id: i.batch_id for i in db.query(TaxRemediationItem).filter(
        TaxRemediationItem.kind == kind, TaxRemediationItem.invoice_id.in_(list(invoice_ids) or [-1]))}


def _row_dict(row: Tax) -> dict:
    out = {}
    for c in ROW_COLUMNS:
        v = getattr(row, c)
        out[c] = v.isoformat() if hasattr(v, "isoformat") else (getattr(v, "name", None) or (str(v) if isinstance(v, Decimal) else v))
    return out


# ── previews (change nothing) ───────────────────────────────────────────

def overcollection_preview(db: Session, organization_id: int) -> dict:
    from app.modules.tax.report_service import TaxFindingsReportService

    report = TaxFindingsReportService(db).tenant_overcollection(organization_id)
    done = _remediated(db, OVERCOLLECTION_CREDIT, [i["invoice_id"] for i in report["invoices"]])
    return {
        "enabled": enabled(organization_id, OVERCOLLECTION_CREDIT), "max_batch": max_batch(), "method": report["method"],
        "invoices": [{**i, "credit_note_amount": i["estimated_overcollected_tax"],
                      "already_remediated_in_batch": done.get(i["invoice_id"])} for i in report["invoices"]],
        "note": "Preview only: executing creates DRAFT corrective credit notes, issued through the normal flow.",
    }


def _duplicate_plan(db: Session, organization_id: int, invoice_ids: Optional[list] = None) -> dict:
    """{invoice_id: {"remove": [Tax], "flagged": [Tax], "kept": [Tax]}} for active duplicate rows."""
    q = db.query(Tax).filter(Tax.organization_id == organization_id, Tax.is_active.is_(True), Tax.invoice_id.isnot(None))
    if invoice_ids is not None:
        q = q.filter(Tax.invoice_id.in_(invoice_ids or [-1]))
    groups = defaultdict(list)
    for row in q.order_by(Tax.id):
        groups[(row.invoice_id, row.tax_rate_id)].append(row)
    plan = defaultdict(lambda: {"remove": [], "flagged": [], "kept": []})
    for (invoice_id, _rate), rows in groups.items():
        if len(rows) < 2:
            continue
        keep, rest = rows[0], rows[1:]
        plan[invoice_id]["kept"].append(keep)
        for r in rest:
            same = all(getattr(r, f) == getattr(keep, f) for f in SAME_FIELDS)
            plan[invoice_id]["remove" if same else "flagged"].append(r)
    return plan


def duplicates_preview(db: Session, organization_id: int) -> dict:
    plan = _duplicate_plan(db, organization_id)
    invoices = {i.id: i for i in db.query(Invoice).filter(Invoice.organization_id == organization_id,
                                                          Invoice.id.in_(list(plan) or [-1]))}
    done = _remediated(db, DUPLICATE_ROWS, list(plan))
    out = []
    for invoice_id, p in sorted(plan.items()):
        active = db.query(Tax).filter(Tax.invoice_id == invoice_id, Tax.is_active.is_(True)).all()
        before = sum((Decimal(str(r.tax_amount)) for r in active), Decimal("0"))
        after = before - sum((Decimal(str(r.tax_amount)) for r in p["remove"]), Decimal("0"))
        inv = invoices.get(invoice_id)
        out.append({
            "invoice_id": invoice_id, "invoice_number": inv.invoice_number if inv else None,
            "invoice_tax_amount": Decimal(str(inv.tax_amount)) if inv else None,
            "rows_to_remove": [_row_dict(r) for r in p["remove"]],
            "rows_flagged_not_identical": [_row_dict(r) for r in p["flagged"]],
            "tax_rows_total_before": before, "tax_rows_total_after": after,
            # True duplicates never change the invoice: its tax_amount isn't derived from these rows.
            "invoice_totals_change": False,
            "already_remediated_in_batch": done.get(invoice_id),
        })
    return {"enabled": enabled(organization_id, DUPLICATE_ROWS), "max_batch": max_batch(), "invoices": out,
            "note": "Preview only. Only rows identical to the kept row are removed; others are flagged and left alone. "
                    "Every removed row is archived and the batch can be reversed."}


# ── batches (two people) ────────────────────────────────────────────────

def view_batch(row: TaxRemediationBatch) -> dict:
    state = row.status.name if row.status != TenantApprovalStatus.APPROVED else (
        "REVERSED" if row.reversed_at else "EXECUTED")
    return {"id": row.id, "kind": row.kind, "state": state, "status": row.status.name, "invoice_ids": row.invoice_ids,
            "reason": row.reason, "proposed_by": row.proposed_by, "approved_by": row.approved_by,
            "approved_at": row.approved_at, "decision_reason": row.decision_reason, "result": row.result,
            "evidence_sha256": row.evidence_sha256, "reversed_by": row.reversed_by, "reversed_at": row.reversed_at,
            "reverse_reason": row.reverse_reason, "created_at": row.created_at}


class RemediationService:
    def __init__(self, db: Session):
        self.db = db
        self.audit = BillingAuditService(db)

    def _log(self, row, actor_id, action, **values):
        self.audit.log_no_commit(row.organization_id, actor_id, action, "TaxRemediationBatch", row.id, new_values=values)

    def get(self, organization_id: int, batch_id: int) -> TaxRemediationBatch:
        row = self.db.query(TaxRemediationBatch).filter(TaxRemediationBatch.id == batch_id,
                                                        TaxRemediationBatch.organization_id == organization_id).first()
        if row is None:
            raise NotFoundException("Remediation batch", batch_id)
        return row

    def list(self, organization_id: int) -> list:
        return self.db.query(TaxRemediationBatch).filter(TaxRemediationBatch.organization_id == organization_id).order_by(
            TaxRemediationBatch.id.desc()).all()

    def _eligible(self, organization_id: int, kind: str) -> set:
        if kind == OVERCOLLECTION_CREDIT:
            return {i["invoice_id"] for i in overcollection_preview(self.db, organization_id)["invoices"]}
        return {i["invoice_id"] for i in duplicates_preview(self.db, organization_id)["invoices"] if i["rows_to_remove"]}

    def _require_enabled(self, organization_id: int, kind: str) -> None:
        if not enabled(organization_id, kind):
            raise ForbiddenException("This remediation is turned off for your organization until the product owner "
                                     "decides. Previews stay available.")

    def propose(self, organization_id: int, actor_id: int, kind: str, invoice_ids: list, reason: str):
        if kind not in REMEDIATION_KINDS:
            raise BadRequestException(f"kind must be one of {', '.join(REMEDIATION_KINDS)}.")
        self._require_enabled(organization_id, kind)
        ids = sorted({int(i) for i in invoice_ids or []})
        if not ids:
            raise BadRequestException("Choose at least one invoice.")
        if len(ids) > max_batch():
            raise BadRequestException(f"A batch is capped at {max_batch()} invoices.")
        if not (reason or "").strip():
            raise BadRequestException("A reason is required.")
        eligible = self._eligible(organization_id, kind)
        outside = [i for i in ids if i not in eligible]
        if outside:
            raise BadRequestException(f"Invoices {outside} are not in this organization's current findings.")
        done = _remediated(self.db, kind, ids)
        if done:
            raise BadRequestException(f"Already remediated (never twice): invoices {sorted(done)}.")
        pending = self.db.query(TaxRemediationBatch).filter(
            TaxRemediationBatch.organization_id == organization_id, TaxRemediationBatch.kind == kind,
            TaxRemediationBatch.status == TenantApprovalStatus.PROPOSED).all()
        clash = sorted(set(ids) & {i for b in pending for i in b.invoice_ids})
        if clash:
            raise BadRequestException(f"Invoices {clash} are already in a proposed batch.")
        row = TaxRemediationBatch(organization_id=organization_id, kind=kind, status=TenantApprovalStatus.PROPOSED,
                                  invoice_ids=ids, reason=reason.strip(), proposed_by=actor_id, created_at=_now())
        self.db.add(row)
        self.db.flush()
        self._log(row, actor_id, BillingAuditAction.CREATE, remediation="proposed", kind=kind, invoices=ids)
        self.db.commit()
        return row

    def withdraw(self, organization_id: int, actor_id: int, batch_id: int):
        row = self.get(organization_id, batch_id)
        if row.status != TenantApprovalStatus.PROPOSED:
            raise BadRequestException("Only a proposed batch can be withdrawn.")
        row.status = TenantApprovalStatus.WITHDRAWN
        self._log(row, actor_id, BillingAuditAction.UPDATE, remediation="withdrawn")
        self.db.commit()
        return row

    def decide(self, organization_id: int, actor_id: int, batch_id: int, *, approve: bool,
               reason: Optional[str] = None):
        row = self.get(organization_id, batch_id)
        if row.status != TenantApprovalStatus.PROPOSED:
            raise BadRequestException(f"Remediation batch {row.id} is {view_batch(row)['state']}, not PROPOSED.")
        if row.proposed_by == actor_id:
            raise ForbiddenException("You proposed this batch; a different finance approver must decide it.")
        if not approve:
            if not (reason or "").strip():
                raise BadRequestException("A reason is required to reject.")
            row.status, row.approved_by, row.decision_reason = TenantApprovalStatus.REJECTED, actor_id, reason
            self._log(row, actor_id, BillingAuditAction.REJECT, remediation="rejected", reason=reason)
            self.db.commit()
            return row
        self._require_enabled(organization_id, row.kind)
        result = self._execute_credits(row, actor_id) if row.kind == OVERCOLLECTION_CREDIT \
            else self._execute_duplicates(row)
        row.status, row.approved_by, row.approved_at = TenantApprovalStatus.APPROVED, actor_id, _now()
        row.decision_reason, row.result = reason, result
        self._log(row, actor_id, BillingAuditAction.APPROVE, remediation="executed", result=result)
        self.db.commit()
        self._seal(row, actor_id)
        return row

    def _execute_credits(self, row: TaxRemediationBatch, actor_id: int) -> dict:
        from app.modules.billing.services.credit_note_service import CreditNoteService

        current = {i["invoice_id"]: i for i in overcollection_preview(self.db, row.organization_id)["invoices"]}
        done = _remediated(self.db, OVERCOLLECTION_CREDIT, row.invoice_ids)
        created, skipped = [], []
        credits = CreditNoteService(self.db)
        for invoice_id in row.invoice_ids:
            finding = current.get(invoice_id)
            if invoice_id in done or finding is None:
                skipped.append({"invoice_id": invoice_id,
                                "reason": "already remediated" if invoice_id in done else "no longer a finding"})
                continue
            inv = self.db.get(Invoice, invoice_id)
            amount = Decimal(str(finding["estimated_overcollected_tax"]))
            note = credits.create_credit_note(
                row.organization_id, actor_id, customer_id=inv.customer_id, credit_note_number="auto",
                credit_note_type=CreditNoteType.ADJUSTMENT, total_amount=amount, issue_date=date.today(),
                subtotal=Decimal("0"), discount_amount=Decimal("0"), tax_amount=amount, invoice_id=inv.id,
                reason=f"Corrective credit: tax over-collected by legacy discount-after-tax (remediation batch {row.id}).",
                currency=inv.currency)
            self.db.add(TaxRemediationItem(organization_id=row.organization_id, batch_id=row.id,
                                           kind=OVERCOLLECTION_CREDIT, invoice_id=invoice_id, credit_note_id=note.id,
                                           amount=amount, created_at=_now()))
            self.db.flush()
            created.append({"invoice_id": invoice_id, "credit_note_id": note.id, "amount": str(amount)})
        return {"credit_notes": created, "skipped": skipped, "status": "DRAFT credit notes created"}

    def _execute_duplicates(self, row: TaxRemediationBatch) -> dict:
        plan = _duplicate_plan(self.db, row.organization_id, row.invoice_ids)
        done = _remediated(self.db, DUPLICATE_ROWS, row.invoice_ids)
        removed, flagged, skipped = [], [], []
        for invoice_id in row.invoice_ids:
            p = plan.get(invoice_id)
            if invoice_id in done or p is None or not p["remove"]:
                skipped.append({"invoice_id": invoice_id,
                                "reason": "already remediated" if invoice_id in done else "no duplicates now"})
                continue
            for r in p["remove"]:
                self.db.add(TaxDuplicateRowArchive(organization_id=row.organization_id, batch_id=row.id, tax_row_id=r.id,
                                                   invoice_id=invoice_id, row=_row_dict(r), archived_at=_now()))
                self.db.flush()
                self.db.delete(r)
                removed.append(r.id)
            flagged += [f.id for f in p["flagged"]]
            self.db.add(TaxRemediationItem(organization_id=row.organization_id, batch_id=row.id, kind=DUPLICATE_ROWS,
                                           invoice_id=invoice_id, rows_removed=len(p["remove"]), created_at=_now()))
            self.db.flush()
        return {"rows_removed": removed, "rows_flagged_not_identical": flagged, "skipped": skipped}

    def reverse(self, organization_id: int, actor_id: int, batch_id: int, reason: str):
        """Duplicate-row batches only: re-insert every archived row with its id."""
        from app.modules.billing.models import TaxType

        row = self.get(organization_id, batch_id)
        if row.kind != DUPLICATE_ROWS:
            raise BadRequestException("Only duplicate-row batches are reversed here; void corrective credit notes "
                                      "through the credit-note flow.")
        if view_batch(row)["state"] != "EXECUTED":
            raise BadRequestException("Only an executed batch can be reversed.")
        if not (reason or "").strip():
            raise BadRequestException("A reason is required.")
        restored = []
        for a in self.db.query(TaxDuplicateRowArchive).filter(TaxDuplicateRowArchive.batch_id == row.id,
                                                              TaxDuplicateRowArchive.restored_at.is_(None)):
            data = dict(a.row)
            created_at = data.pop("created_at", None)
            for money in ("taxable_amount", "tax_amount", "tax_percentage"):
                data[money] = Decimal(data[money]) if data.get(money) is not None else None
            if data.get("tax_type"):
                data["tax_type"] = TaxType[data["tax_type"]]
            restored_row = Tax(**data)
            if created_at:
                restored_row.created_at = datetime.fromisoformat(created_at)
            self.db.add(restored_row)
            a.restored_at = _now()
            restored.append(a.tax_row_id)
        row.reversed_by, row.reversed_at, row.reverse_reason = actor_id, _now(), reason.strip()
        self._log(row, actor_id, BillingAuditAction.REVERSE, remediation="reversed", rows_restored=restored)
        self.db.commit()
        self._seal(row, actor_id)
        return row

    def _seal(self, row: TaxRemediationBatch, actor_id: int) -> None:
        """Every remediation produces an evidence bundle (Phase 5c format)."""
        from app.modules.auth.models import User
        from app.modules.tax.evidence_bundle import tenant_bundle

        actor = self.db.get(User, actor_id)
        bundle = tenant_bundle(self.db, row.organization_id, actor, "remediation_batch", row.id)
        row.evidence_sha256 = bundle["bundle_sha256"]
        self.db.commit()
