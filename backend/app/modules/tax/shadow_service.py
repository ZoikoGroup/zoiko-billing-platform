"""
app/modules/tax/shadow_service.py
---------------------------------
Shadow compare (ZB-TAX-ARCH-001 Phase 7 PR 1, handoff §10.1 step 06).

For an entity that opted in (two people), every legacy invoice issued while
shadowing is re-computed, off the request path, by the governed engine with
the rule pack the platform chose for shadows, and the difference is stored.
Nothing here changes an invoice, a regime or a quote: the computation runs
inside a savepoint that is always rolled back, and only the comparison row
is written. A failure is recorded as outcome ERROR for that invoice and
never affects issuing (the job runs after the invoice committed).

Causes of a difference, most specific first:
  DISCOUNT_AFTER_TAX     the legacy invoice taxed before a document discount (Phase 3a finding)
  TAX_MISSING_ON_LEGACY  legacy charged no tax where governed tax applies
  RATE_DIFFERENT         a line's legacy rate differs from the governed rate
  ROUNDING               same rates; totals differ by at most one minor unit per line
  UNEXPLAINED            none of the above: the exit signal requires zero of these
"""
import logging
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace
from typing import Optional

from sqlalchemy.orm import Session

from app.config import settings
from app.core.exceptions import BadRequestException, ForbiddenException, NotFoundException
from app.modules.billing.models import BillingAuditAction, Invoice, InvoiceItem
from app.modules.billing.services.audit_service import BillingAuditService
from app.modules.tax.enums import EntityTaxRegime, TaxOperatingMode, TenantApprovalStatus
from app.modules.tax.models import SellerLegalEntity
from app.modules.tax.shadow_models import TaxShadowComparison, TaxShadowEnrolment, TaxShadowSelection

logger = logging.getLogger("zoiko_billing.tax.shadow")

CAUSES = ("DISCOUNT_AFTER_TAX", "TAX_MISSING_ON_LEGACY", "RATE_DIFFERENT", "ROUNDING", "UNEXPLAINED")
EXPLAINED = frozenset({"DISCOUNT_AFTER_TAX", "TAX_MISSING_ON_LEGACY", "RATE_DIFFERENT", "ROUNDING"})
ZERO = Decimal("0")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value):
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _d(value) -> Decimal:
    return Decimal(str(value if value is not None else 0))


# ── enrolment (tenant, two people) ──────────────────────────────────────

def enrolment_state(row: TaxShadowEnrolment) -> str:
    if row.status == TenantApprovalStatus.APPROVED:
        return "ENDED" if row.ended_at else "ACTIVE"
    return row.status.name


def view_enrolment(row: TaxShadowEnrolment) -> dict:
    return {"id": row.id, "seller_entity_id": row.seller_entity_id, "state": enrolment_state(row),
            "status": row.status.name, "reason": row.reason, "proposed_by": row.proposed_by,
            "approved_by": row.approved_by, "started_at": row.approved_at, "decision_reason": row.decision_reason,
            "ended_by": row.ended_by, "ended_at": row.ended_at, "created_at": row.created_at}


class ShadowEnrolmentService:
    def __init__(self, db: Session):
        self.db = db
        self.audit = BillingAuditService(db)

    def _log(self, row, actor_id, action, **values):
        self.audit.log_no_commit(row.organization_id, actor_id, action, "TaxShadowEnrolment", row.id, new_values=values)

    def get(self, organization_id: int, enrolment_id: int) -> TaxShadowEnrolment:
        row = self.db.query(TaxShadowEnrolment).filter(TaxShadowEnrolment.id == enrolment_id,
                                                       TaxShadowEnrolment.organization_id == organization_id).first()
        if row is None:
            raise NotFoundException("Shadow enrolment", enrolment_id)
        return row

    def list(self, organization_id: int, seller_entity_id: Optional[int] = None) -> list:
        q = self.db.query(TaxShadowEnrolment).filter(TaxShadowEnrolment.organization_id == organization_id)
        if seller_entity_id:
            q = q.filter(TaxShadowEnrolment.seller_entity_id == seller_entity_id)
        return q.order_by(TaxShadowEnrolment.id.desc()).all()

    def propose(self, organization_id: int, actor_id: int, seller_entity_id: int, reason: str) -> TaxShadowEnrolment:
        entity = self.db.query(SellerLegalEntity).filter(SellerLegalEntity.id == seller_entity_id,
                                                         SellerLegalEntity.organization_id == organization_id).first()
        if entity is None:
            raise NotFoundException("Seller legal entity", seller_entity_id)
        if entity.tax_regime != EntityTaxRegime.LEGACY_MANUAL:
            raise BadRequestException("Shadowing is for LEGACY_MANUAL entities: a governed entity already uses governed tax.")
        if not (reason or "").strip():
            raise BadRequestException("A reason is required.")
        open_row = self.db.query(TaxShadowEnrolment).filter(
            TaxShadowEnrolment.organization_id == organization_id, TaxShadowEnrolment.seller_entity_id == seller_entity_id,
            TaxShadowEnrolment.status.in_([TenantApprovalStatus.PROPOSED, TenantApprovalStatus.APPROVED]),
            TaxShadowEnrolment.ended_at.is_(None)).first()
        if open_row is not None:
            raise BadRequestException("This entity is already shadowing or has a shadow proposal waiting.")
        row = TaxShadowEnrolment(organization_id=organization_id, seller_entity_id=seller_entity_id,
                                 status=TenantApprovalStatus.PROPOSED, reason=reason.strip(), proposed_by=actor_id,
                                 created_at=_now())
        self.db.add(row)
        self.db.flush()
        self._log(row, actor_id, BillingAuditAction.CREATE, shadow="proposed", seller_entity_id=seller_entity_id)
        self.db.commit()
        return row

    def decide(self, organization_id: int, actor_id: int, enrolment_id: int, *, approve: bool,
               reason: Optional[str] = None) -> TaxShadowEnrolment:
        row = self.get(organization_id, enrolment_id)
        if row.status != TenantApprovalStatus.PROPOSED:
            raise BadRequestException(f"Shadow enrolment {row.id} is {enrolment_state(row)}, not PROPOSED.")
        if row.proposed_by == actor_id:
            raise ForbiddenException("You proposed this shadow; a different user must approve or reject it.")
        if not approve and not (reason or "").strip():
            raise BadRequestException("A reason is required to reject.")
        row.status = TenantApprovalStatus.APPROVED if approve else TenantApprovalStatus.REJECTED
        row.approved_by, row.decision_reason = actor_id, reason
        if approve:
            row.approved_at = _now()
        self._log(row, actor_id, BillingAuditAction.APPROVE if approve else BillingAuditAction.REJECT,
                  shadow="approved" if approve else "rejected", reason=reason)
        self.db.commit()
        return row

    def withdraw(self, organization_id: int, actor_id: int, enrolment_id: int) -> TaxShadowEnrolment:
        row = self.get(organization_id, enrolment_id)
        if row.status != TenantApprovalStatus.PROPOSED:
            raise BadRequestException("Only a proposed shadow can be withdrawn.")
        row.status = TenantApprovalStatus.WITHDRAWN
        self._log(row, actor_id, BillingAuditAction.UPDATE, shadow="withdrawn")
        self.db.commit()
        return row

    def end(self, organization_id: int, actor_id: int, enrolment_id: int, reason: Optional[str] = None):
        row = self.get(organization_id, enrolment_id)
        if enrolment_state(row) != "ACTIVE":
            raise BadRequestException("Only an active shadow can be ended.")
        row.ended_by, row.ended_at = actor_id, _now()
        self._log(row, actor_id, BillingAuditAction.UPDATE, shadow="ended", reason=reason)
        self.db.commit()
        return row


# ── platform: the shadow pack and the tax lead's exit threshold ─────────

def view_selection(db: Session, row: TaxShadowSelection) -> dict:
    from app.modules.tax.policy_models import TaxRulePackVersion

    pack = db.get(TaxRulePackVersion, row.rule_pack_version_id)
    return {"id": row.id, "rule_pack_version_id": row.rule_pack_version_id,
            "pack_code": pack.code if pack else None, "pack_version": pack.version if pack else None,
            "pack_status": pack.status.name if pack else None, "markets": pack.markets if pack else [],
            "exit_min_invoices": row.exit_min_invoices, "exit_min_days": row.exit_min_days, "active": row.active,
            "reason": row.reason, "chosen_by": row.chosen_by, "chosen_at": row.chosen_at,
            "ended_by": row.ended_by, "ended_at": row.ended_at}


class ShadowSelectionService:
    def __init__(self, db: Session):
        self.db = db

    def _audit(self, actor_id, action, row, **metadata):
        from app.modules.super_admin.audit_service import PlatformAuditService

        PlatformAuditService(self.db).log_no_commit(actor_id=actor_id, actor_role="super_admin", action=action,
                                                    entity_type="TaxShadowSelection", entity_id=row.id,
                                                    metadata=metadata)

    def choose(self, actor_id: int, rule_pack_version_id: int, *, exit_min_invoices: int, exit_min_days: int,
               reason: str) -> TaxShadowSelection:
        from app.modules.super_admin.models import PlatformAuditAction
        from app.modules.tax.engines import rule_pack_class
        from app.modules.tax.enums import PlatformVersionStatus
        from app.modules.tax.policy_models import TaxRulePackVersion

        pack = self.db.get(TaxRulePackVersion, rule_pack_version_id)
        if pack is None:
            raise NotFoundException("Rule pack version", rule_pack_version_id)
        if pack.status in (PlatformVersionStatus.SUPERSEDED, PlatformVersionStatus.REJECTED):
            raise BadRequestException(f"A {pack.status.name} rule pack can't be used for shadows.")
        cls = rule_pack_class(pack.code, pack.version)
        if cls is None:
            raise BadRequestException("That rule pack version isn't the one in code; register the current version.")
        if exit_min_invoices < 1 or exit_min_days < 1:
            raise BadRequestException("The exit threshold needs at least 1 invoice and 1 day.")
        if not (reason or "").strip():
            raise BadRequestException("A reason is required.")
        for old in self.db.query(TaxShadowSelection).filter(TaxShadowSelection.active.is_(True)):
            other = self.db.get(TaxRulePackVersion, old.rule_pack_version_id)
            if other is not None and other.code == pack.code:
                old.active, old.ended_by, old.ended_at = False, actor_id, _now()     # one per pack code
        row = TaxShadowSelection(rule_pack_version_id=pack.id, exit_min_invoices=exit_min_invoices,
                                 exit_min_days=exit_min_days, active=True, reason=reason.strip(), chosen_by=actor_id,
                                 chosen_at=_now())
        self.db.add(row)
        self.db.flush()
        self._audit(actor_id, PlatformAuditAction.UPDATE, row, shadow_selection="chosen", pack=pack.code,
                    version=pack.version, pack_status=pack.status.name, exit_min_invoices=exit_min_invoices,
                    exit_min_days=exit_min_days)
        self.db.commit()
        return row

    def end(self, actor_id: int, selection_id: int) -> TaxShadowSelection:
        from app.modules.super_admin.models import PlatformAuditAction

        row = self.db.get(TaxShadowSelection, selection_id)
        if row is None:
            raise NotFoundException("Shadow selection", selection_id)
        if not row.active:
            raise BadRequestException("This shadow selection has already ended.")
        row.active, row.ended_by, row.ended_at = False, actor_id, _now()
        self._audit(actor_id, PlatformAuditAction.UPDATE, row, shadow_selection="ended")
        self.db.commit()
        return row


# ── the shadow computation ──────────────────────────────────────────────

class _ShadowResolver:
    def engine_for(self, activation, tax_date=None):
        from app.modules.tax.engines import RulePackEngine

        return RulePackEngine(activation.pack_cls()), None


def _shadow_determination(db: Session, selections: list):
    """A TaxDeterminationService that routes lines to the shadow packs instead
    of the tenant's activations, and captures the result instead of writing a
    quote. Same _determine: the shadow is exactly what governed issuing would
    compute with that pack."""
    from app.modules.tax.determination_service import TaxDeterminationService
    from app.modules.tax.engines import rule_pack_class
    from app.modules.tax.policy_models import TaxRulePackVersion
    from app.modules.tax.registry_models import TaxJurisdiction, TaxTypeDefinition

    packs = []
    for sel in selections:
        row = db.get(TaxRulePackVersion, sel.rule_pack_version_id)
        cls = rule_pack_class(row.code, row.version) if row else None
        if row is not None and cls is not None:
            packs.append((sel, row, cls))

    class ShadowDetermination(TaxDeterminationService):
        captured = None

        def resolver(self, organization_id):
            return _ShadowResolver()

        def _effective_activations(self, organization_id, seller_entity_id, jurisdiction_ids, cls, tax_date):
            out = []
            jurisdictions = {j.code: j for j in db.query(TaxJurisdiction).filter(TaxJurisdiction.id.in_(jurisdiction_ids))}
            for sel, row, pack_cls in packs:
                if cls not in getattr(pack_cls, "transaction_classes", ()):
                    continue
                for market in row.markets or []:
                    j = jurisdictions.get(market.get("jurisdiction_code"))
                    tt = db.query(TaxTypeDefinition).filter(TaxTypeDefinition.code == market.get("tax_type")).first()
                    if j is None or tt is None:
                        continue
                    out.append(SimpleNamespace(id=None, jurisdiction=j, tax_type=tt, jurisdiction_id=j.id,
                                               tax_type_id=tt.id, mode=TaxOperatingMode.NATIVE_RULEPACK_APPROVED,
                                               pack_cls=pack_cls, selection=sel, pack_row=row))
            return out

        def _persist(self, quote, organization_id, engine, lines, decimals, warnings):
            self.captured = {"engine": engine, "lines": lines, "warnings": warnings}

    return ShadowDetermination(db)


def _refusal_outcome(status_name: str) -> str:
    if status_name == "UNSUPPORTED":
        return "UNSUPPORTED"
    if status_name == "REVIEW_REQUIRED":
        return "REVIEW_REQUIRED"
    return "NOT_DETERMINED"


def compute_comparison(db: Session, enrolment: TaxShadowEnrolment, invoice: Invoice, selections: list) -> dict:
    """The comparison fields for one issued legacy invoice. Writes nothing."""
    from app.modules.tax.context_builder import TaxContextBuilder
    from app.modules.tax.determination_service import _Refusal, load_document
    from app.modules.tax.quote_models import TaxQuote

    base = {"organization_id": invoice.organization_id, "seller_entity_id": invoice.seller_entity_id,
            "enrolment_id": enrolment.id, "invoice_id": invoice.id, "invoice_number": invoice.invoice_number,
            "issue_date": invoice.issue_date, "currency": invoice.currency, "legacy_tax": _d(invoice.tax_amount)}
    if not selections:
        return {**base, "outcome": "NOT_DETERMINED", "cause": "NO_SHADOW_PACK",
                "reason": "The platform has not chosen a rule pack for shadows."}
    service = _shadow_determination(db, selections)
    doc, items = load_document(db, invoice.organization_id, "invoice", invoice.id)
    context = TaxContextBuilder(db).build(invoice.organization_id, "invoice", invoice.id, now=_now())
    quote = TaxQuote(organization_id=invoice.organization_id, document_type="invoice", document_id=invoice.id)
    try:
        service._determine(quote, invoice.organization_id, doc, items, context)
    except _Refusal as refusal:
        return {**base, "outcome": _refusal_outcome(refusal.status.name), "cause": refusal.code,
                "reason": refusal.reason, "lines": {"issues": refusal.issues or [], "warnings": refusal.warnings or []}}
    captured = service.captured
    engine, lines = captured["engine"], captured["lines"]
    routed = next((line.routing[1][0] for line in lines if getattr(line, "routing", None)), None)
    pack_row = getattr(routed, "pack_row", None)
    return {**base, **_diff(invoice, items, lines), "pack_code": engine.name, "pack_version": engine.version,
            "rule_pack_version_id": getattr(pack_row, "id", None)}


def _diff(invoice: Invoice, items: list, lines: list) -> dict:
    by_item = {i.id: i for i in items}
    out_lines, shadow_tax, rate_diff, missing, rounding_ok = [], ZERO, False, False, True
    for line in lines:
        item = by_item.get(line.input.line_id)
        legacy_line_tax = _d(getattr(item, "tax_amount", 0))
        legacy_rate = _d(getattr(item, "tax_percentage", 0))
        line_tax = sum(line.component_rounded, ZERO)
        shadow_tax += line_tax
        components = [{"component_code": c.component_code, "label": c.label, "rate_percent": str(c.rate_percent),
                       "tax": str(t)} for c, t in zip(line.result.components, line.component_rounded)]
        shadow_rate = sum((_d(c.rate_percent) for c in line.result.components), ZERO)
        if legacy_rate != shadow_rate:
            rate_diff = True
        if legacy_line_tax == 0 and line_tax != 0:
            missing = True
        if abs(line_tax - legacy_line_tax) > Decimal("0.01"):
            rounding_ok = False
        out_lines.append({"line_number": line.input.line_number, "invoice_item_id": line.input.line_id,
                          "legacy_rate": str(legacy_rate), "shadow_rate": str(shadow_rate),
                          "legacy_tax": str(legacy_line_tax), "shadow_tax": str(line_tax),
                          "difference": str(line_tax - legacy_line_tax), "outcome": line.result.outcome.name,
                          "legal_reason": line.result.legal_reason, "components": components})
    legacy_tax = _d(invoice.tax_amount)
    difference = shadow_tax - legacy_tax
    if difference == 0 and all(Decimal(l["difference"]) == 0 for l in out_lines):
        outcome, cause, reason = "MATCH", None, "Governed tax equals the tax charged."
    else:
        outcome = "DIFFERENT"
        doc_discount = _d(invoice.discount_amount) - sum((_d(i.discount_amount) for i in invoice.items), ZERO)
        if (_d(invoice.discount_percentage) > 0 or doc_discount > 0) and legacy_tax > shadow_tax and not rate_diff:
            cause, reason = "DISCOUNT_AFTER_TAX", "Legacy tax was computed before the document discount."
        elif missing:
            cause, reason = "TAX_MISSING_ON_LEGACY", "Legacy charged no tax on a line where governed tax applies."
        elif rate_diff:
            cause, reason = "RATE_DIFFERENT", "A line's legacy rate differs from the governed rate."
        elif rounding_ok and abs(difference) <= Decimal("0.01") * max(len(out_lines), 1):
            cause, reason = "ROUNDING", "Same rates; the totals differ by rounding only."
        else:
            cause, reason = "UNEXPLAINED", "The difference isn't explained by rate, discount, missing tax or rounding."
    return {"outcome": outcome, "cause": cause, "reason": reason, "shadow_tax": shadow_tax,
            "tax_difference": difference, "lines": {"lines": out_lines}}


class ShadowCompareService:
    def __init__(self, db: Session):
        self.db = db

    def active_selections(self) -> list:
        return self.db.query(TaxShadowSelection).filter(TaxShadowSelection.active.is_(True)).order_by(
            TaxShadowSelection.id).all()

    def pending_invoices(self, enrolment: TaxShadowEnrolment, limit: int) -> list:
        from app.modules.tax.report_service import ISSUED_STATUSES

        start = _aware(enrolment.approved_at)
        q = (self.db.query(Invoice)
             .outerjoin(TaxShadowComparison, TaxShadowComparison.invoice_id == Invoice.id)
             .filter(Invoice.organization_id == enrolment.organization_id,
                     Invoice.seller_entity_id == enrolment.seller_entity_id,
                     Invoice.status.in_(ISSUED_STATUSES), Invoice.tax_quote_id.is_(None),
                     Invoice.issue_date >= start.date(), TaxShadowComparison.id.is_(None)))
        if enrolment.ended_at is not None:
            q = q.filter(Invoice.issue_date <= _aware(enrolment.ended_at).date())
        return q.order_by(Invoice.id).limit(limit).all()

    def compare_one(self, enrolment: TaxShadowEnrolment, invoice: Invoice, selections: list) -> TaxShadowComparison:
        """Compute in a savepoint that is always rolled back; then write only the comparison."""
        nested = self.db.begin_nested()
        try:
            fields = compute_comparison(self.db, enrolment, invoice, selections)
        except Exception as exc:                          # never affects issuing: recorded as ERROR
            logger.exception("Shadow compare failed for invoice %s", invoice.id)
            fields = {"organization_id": invoice.organization_id, "seller_entity_id": invoice.seller_entity_id,
                      "enrolment_id": enrolment.id, "invoice_id": invoice.id, "invoice_number": invoice.invoice_number,
                      "issue_date": invoice.issue_date, "currency": invoice.currency,
                      "legacy_tax": _d(invoice.tax_amount), "outcome": "ERROR", "cause": type(exc).__name__,
                      "reason": "The shadow computation failed; issuing was not affected."}
        finally:
            nested.rollback()
        row = TaxShadowComparison(computed_at=_now(), **fields)
        self.db.add(row)
        self.db.flush()
        return row

    def run(self, limit: Optional[int] = None) -> dict:
        limit = limit or int(getattr(settings, "TAX_SHADOW_BATCH_SIZE", 200))
        selections = self.active_selections()
        enrolments = self.db.query(TaxShadowEnrolment).filter(
            TaxShadowEnrolment.status == TenantApprovalStatus.APPROVED).all()
        done = 0
        for enrolment in enrolments:
            for invoice in self.pending_invoices(enrolment, limit - done):
                self.compare_one(enrolment, invoice, selections)
                self.db.commit()
                done += 1
            if done >= limit:
                break
        return {"compared": done}


# ── summaries ───────────────────────────────────────────────────────────

def exit_threshold(db: Session) -> dict:
    sels = db.query(TaxShadowSelection).filter(TaxShadowSelection.active.is_(True)).all()
    if not sels:
        return {"min_invoices": None, "min_days": None}
    return {"min_invoices": max(s.exit_min_invoices for s in sels), "min_days": max(s.exit_min_days for s in sels)}


def summary(db: Session, organization_id: Optional[int], seller_entity_id: Optional[int] = None) -> dict:
    """organization_id None = platform aggregate (no identifiers)."""
    q = db.query(TaxShadowComparison)
    if organization_id is not None:
        q = q.filter(TaxShadowComparison.organization_id == organization_id)
    if seller_entity_id:
        q = q.filter(TaxShadowComparison.seller_entity_id == seller_entity_id)
    rows = q.all()
    by_outcome, by_cause, blocked = {}, {}, {}
    for r in rows:
        by_outcome[r.outcome] = by_outcome.get(r.outcome, 0) + 1
        if r.outcome == "DIFFERENT":
            by_cause[r.cause or "UNEXPLAINED"] = by_cause.get(r.cause or "UNEXPLAINED", 0) + 1
        if r.outcome in ("NOT_DETERMINED", "REVIEW_REQUIRED", "UNSUPPORTED"):
            blocked[r.cause or r.outcome] = blocked.get(r.cause or r.outcome, 0) + 1
    total = len(rows)
    return {"compared": total, "match_rate": round(by_outcome.get("MATCH", 0) / total, 4) if total else None,
            "by_outcome": by_outcome, "differences_by_cause": by_cause, "would_have_been_blocked": blocked,
            "unexplained": by_cause.get("UNEXPLAINED", 0) + by_outcome.get("ERROR", 0)}


def exit_signal(db: Session, enrolment: TaxShadowEnrolment) -> dict:
    """Advisory only: never switches a regime."""
    threshold = exit_threshold(db)
    s = summary(db, enrolment.organization_id, enrolment.seller_entity_id)
    started = _aware(enrolment.approved_at)
    days = ((_aware(enrolment.ended_at) or _now()) - started).days if started else 0
    ready = (threshold["min_invoices"] is not None and s["compared"] >= threshold["min_invoices"]
             and days >= threshold["min_days"] and s["unexplained"] == 0)
    return {"ready": bool(ready), "advisory": True, "compared": s["compared"], "days": days,
            "unexplained": s["unexplained"], "threshold": threshold,
            "message": (f"{s['compared']} invoices over {days} days with zero unexplained differences: the tax lead's "
                        "threshold is met. This is advice only; switching the regime is a separate two-person decision."
                        if ready else
                        f"{s['compared']} of {threshold['min_invoices'] or '?'} invoices, {days} of "
                        f"{threshold['min_days'] or '?'} days, {s['unexplained']} unexplained.")}


def view_comparison(row: TaxShadowComparison, detail: bool = False) -> dict:
    out = {"id": row.id, "seller_entity_id": row.seller_entity_id, "invoice_id": row.invoice_id,
           "invoice_number": row.invoice_number, "issue_date": row.issue_date, "currency": row.currency,
           "outcome": row.outcome, "cause": row.cause, "reason": row.reason, "legacy_tax": row.legacy_tax,
           "shadow_tax": row.shadow_tax, "tax_difference": row.tax_difference, "pack_code": row.pack_code,
           "pack_version": row.pack_version, "computed_at": row.computed_at}
    if detail:
        out["lines"] = row.lines
    return out


def run_tax_shadow_job() -> dict:
    """Scheduler entry point: compares newly issued legacy invoices of shadowing entities."""
    from app.database import SessionLocal

    if not getattr(settings, "TAX_SHADOW_ENABLED", True):
        return {"skipped": "TAX_SHADOW_ENABLED is off"}
    db = SessionLocal()
    try:
        return ShadowCompareService(db).run()
    finally:
        db.close()
