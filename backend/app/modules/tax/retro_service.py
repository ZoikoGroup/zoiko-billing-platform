"""
app/modules/tax/retro_service.py
--------------------------------
Retroactive change analysis (ZB-TAX-ARCH-001 Phase 8 PR 4, handoff §10.3,
T04). Strictly read-only for every issued record: quotes, snapshots,
invoices and credit notes are never written; the analysis tables are.

Triggers (each becomes one FULL analysis, enqueued automatically):
  rollback   an applied PR 3 rollback: every committed quote made with V,
             whatever its date. With a restore: compared against P's logic,
             "not a determination". Quarantine: no basis, every document
             MANUAL_REVIEW_REQUIRED.
  rate       a published rate version whose validity covers past dates:
             committed native quotes using that component in the past part
             of its validity (selected by the rate's key, not the superseded
             version id), compared against the rate now in force under the
             quote's own pack version.
  rule_pack  a published retroactive pack version: committed quotes of that
             pack (and provider quotes in its markets) dated in the past part
             of its validity, compared against that version.

Retroactive rate and pack versions need a CURRENT preview (mode PREVIEW, same
candidate, same versions in force, same in-scope committed quotes, at most
TAX_RETRO_PREVIEW_MAX_AGE_HOURS old) to be approved and published.

Commit-time facts (fix 2): a pack comparison uses the values recorded at
commit and refuses to guess:
  currency, tax date        tax_quotes (snapshot)
  line inputs and amounts   tax_quote_lines (snapshot)
  activation                tax_quote_components.activation_id (frozen once approved)
  registry product scope    tax_quotes.decision_facts (Phase 8 PR 4), else the
                            line's component rate version (immutable)
  seller / billing country  tax_quotes.decision_facts (Phase 8 PR 4)
A fact with no commit-time value -> MANUAL_REVIEW_REQUIRED ("commit-time value
unknown"); a current value that differs from it -> MANUAL_REVIEW_REQUIRED
("facts changed since commit"). Provider quotes are NOT_ANALYSABLE.
"""
import hashlib
import json
import logging
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Callable, Optional

from sqlalchemy import and_, exists, or_
from sqlalchemy.orm import Session

from app.config import settings
from app.core.exceptions import BadRequestException, NotFoundException

logger = logging.getLogger("zoiko_billing.tax.retro")

BASES = {
    "rate_in_force": "Comparison against the rate now in force for the tax date",
    "pack_in_force": "Comparison against the pack version now in force for the tax date",
    "restored": "Comparison against restored logic, not a determination",
    "quarantine": "No comparison: the rules for these dates were quarantined; manual review required",
}
FURTHEST_AHEAD = "Etc/GMT-14"          # UTC+14: a date is "past" once it has started anywhere
from app.modules.tax.aggregate_privacy import (  # noqa: E402  the one shared banding rule
    BANDS, SMALL_POPULATION, amounts_note, band, band_net, small,
)
CENT = Decimal("0.01")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _sha(obj) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()


def _dec(v) -> Decimal:
    return Decimal(str(v)) if v is not None else Decimal("0")


def legal_today(tz: Optional[str], now: Optional[datetime] = None) -> date:
    from app.modules.tax.registry_service import legal_date_at

    return legal_date_at(now or _now(), tz or FURTHEST_AHEAD)


class Manual(Exception):
    """A document that can't be compared: MANUAL_REVIEW_REQUIRED."""


# ── triggers ────────────────────────────────────────────────────────────

@dataclass
class Trigger:
    kind: str
    trigger_id: int
    basis: str
    range_from: Optional[date] = None
    range_to: Optional[date] = None
    rolled_back_id: Optional[int] = None
    pack_row: object = None                 # comparison pack (rollback restore, rule_pack)
    pack_code: Optional[str] = None
    component_code: Optional[str] = None
    jurisdiction_ids: tuple = ()
    rate_lookup: Optional[Callable] = None
    severity: Optional[str] = None
    versions_used: dict = field(default_factory=dict)
    subject_id: Optional[int] = None


def _pack_ref(row) -> dict:
    from app.modules.tax.policy_models import code_version_of

    return {"id": row.id, "code": row.code, "version": row.version, "code_version": code_version_of(row),
            "code_hash": row.code_hash}


def rollback_trigger(db: Session, request) -> Trigger:
    from app.modules.tax.policy_models import TaxRulePackVersion

    result = request.result or {}
    p = db.get(TaxRulePackVersion, request.restore_to_id) if request.restore_to_id else None
    v = db.get(TaxRulePackVersion, result.get("rolled_back_version_id"))
    used = {"rolled_back": _pack_ref(v) if v else None, "restored": _pack_ref(p) if p else None,
            "rates": "the published registry for each tax date"}
    return Trigger(kind="rollback", trigger_id=request.id, basis="restored" if p else "quarantine",
                   range_from=date.fromisoformat(result["range_from"]) if result.get("range_from") else None,
                   range_to=date.fromisoformat(result["range_to"]) if result.get("range_to") else None,
                   rolled_back_id=v.id if v else None, pack_row=p, severity=request.severity, versions_used=used)


def _pack_tz(db: Session, row) -> Optional[str]:
    from app.modules.tax.policy_service import RulePackService

    return RulePackService(db)._timezone(row)


def _market_jurisdictions(db: Session, row) -> tuple:
    from app.modules.tax.registry_models import TaxJurisdiction

    codes = [m.get("jurisdiction_code") for m in row.markets or []]
    return tuple(j.id for j in db.query(TaxJurisdiction).filter(TaxJurisdiction.code.in_(codes or ["-"])))


def pack_trigger(db: Session, row, now: Optional[datetime] = None) -> Trigger:
    today = legal_today(_pack_tz(db, row), now)
    return Trigger(kind="rule_pack", trigger_id=row.id, subject_id=row.id, basis="pack_in_force",
                   range_from=row.valid_from, range_to=today, pack_row=row, pack_code=row.code,
                   jurisdiction_ids=_market_jurisdictions(db, row), versions_used={"pack": _pack_ref(row)})


def _rate_window(db: Session, jurisdiction_id: int, valid_from, valid_to, now=None) -> tuple:
    from app.modules.tax.registry_models import TaxJurisdiction

    jurisdiction = db.get(TaxJurisdiction, jurisdiction_id)
    today = legal_today(jurisdiction.timezone if jurisdiction else None, now)
    end = min(valid_to, today) if valid_to else today
    return valid_from, end


def rate_trigger(db: Session, *, staged=None, version=None, now=None) -> Trigger:
    """A published rate version (FULL) or a staged candidate (PREVIEW)."""
    from app.modules.tax.registry_models import TaxComponent, TaxRateVersion
    from app.modules.tax.registry_service import RegistryReadService

    subject = version or staged
    component = db.get(TaxComponent, subject.component_id)
    start, end = _rate_window(db, component.jurisdiction_id, subject.valid_from, subject.valid_to, now)
    in_force = sorted(r.id for r in db.query(TaxRateVersion).filter(TaxRateVersion.component_id == component.id,
                                                                     TaxRateVersion.status == "ACTIVE"))
    used = {"component": component.code, "rate_versions_in_force": in_force,
            "candidate": ({"staged_rate_id": staged.id, "rate_percent": str(staged.rate_percent),
                           "product_scope": staged.product_scope} if staged is not None else None),
            "published_rate_version_id": version.id if version is not None else None}
    if staged is not None:
        from app.modules.tax.regression.runner import _rate_overlay

        lookup = _rate_overlay(db, staged)
    else:
        lookup = RegistryReadService(db).lookup_rates
    return Trigger(kind="rate", trigger_id=(version.id if version is not None else staged.id),
                   subject_id=(staged.id if staged is not None else version.staged_rate_id), basis="rate_in_force",
                   range_from=start, range_to=end, component_code=component.code,
                   jurisdiction_ids=(component.jurisdiction_id,), rate_lookup=lookup, versions_used=used)


# ── scope ───────────────────────────────────────────────────────────────

def scope_query(db: Session, t: Trigger, organization_id: Optional[int] = None):
    from app.modules.tax.enums import EngineKind, TaxQuoteStatus
    from app.modules.tax.quote_models import TaxQuote, TaxQuoteComponent

    q = db.query(TaxQuote).filter(TaxQuote.status == TaxQuoteStatus.COMMITTED, TaxQuote.document_type == "invoice")
    if t.kind == "rollback":
        q = q.filter(TaxQuote.rule_pack_version_id == (t.rolled_back_id or -1))
    else:
        if t.range_from is not None:
            q = q.filter(TaxQuote.tax_date >= t.range_from)
        if t.range_to is not None:
            q = q.filter(TaxQuote.tax_date < t.range_to)
        in_market = exists().where(and_(TaxQuoteComponent.tax_quote_id == TaxQuote.id,
                                        TaxQuoteComponent.jurisdiction_id.in_(t.jurisdiction_ids or (-1,))))
        provider = and_(TaxQuote.engine_kind == EngineKind.PROVIDER, in_market)
        if t.kind == "rate":
            native = and_(TaxQuote.engine_kind == EngineKind.NATIVE_RULE_PACK, exists().where(and_(
                TaxQuoteComponent.tax_quote_id == TaxQuote.id,
                TaxQuoteComponent.jurisdiction_id.in_(t.jurisdiction_ids or (-1,)),
                TaxQuoteComponent.component_code == t.component_code)))
        else:
            native = and_(TaxQuote.engine_kind == EngineKind.NATIVE_RULE_PACK, TaxQuote.engine_name == t.pack_code)
        q = q.filter(or_(native, provider))
    if organization_id is not None:
        q = q.filter(TaxQuote.organization_id == organization_id)
    return q.order_by(TaxQuote.id)


def scope_hash(db: Session, t: Trigger) -> str:
    """Sorted in-scope committed quote ids (fix 4): a quote created earlier
    and committed later joins the scope and changes this."""
    return _sha(sorted(q.id for q in scope_query(db, t)))


def inputs_hash(t: Trigger) -> str:
    return _sha({"kind": t.kind, "basis": t.basis, "range": [t.range_from, t.range_to], "versions": t.versions_used})


# ── one document ────────────────────────────────────────────────────────

def _current_facts(db: Session, quote) -> dict:
    """The values the pack reads, as they are today (drift detection only)."""
    from app.modules.tax.context_builder import TaxContextBuilder

    with db.begin_nested() as sp:
        try:
            context = TaxContextBuilder(db).build(quote.organization_id, "invoice", quote.document_id)
            facts = context.facts or {}
        finally:
            sp.rollback()
    seller = (facts.get("seller_entity") or {}).get("country_code")
    billing = (((facts.get("buyer") or {}).get("addresses") or {}).get("BILLING") or {}).get("country_code")
    return {"seller_country": seller, "billing_country": billing}


def _commit_facts(db: Session, quote) -> dict:
    recorded = quote.decision_facts or {}
    missing = [k for k in ("seller_country", "billing_country") if not recorded.get(k)]
    if missing:
        raise Manual("commit-time value unknown: " + ", ".join(m.replace("_", " ") for m in missing)
                     + " (not recorded on quotes committed before Phase 8 PR 4)")
    current = _current_facts(db, quote)
    changed = [k for k in ("seller_country", "billing_country")
               if current.get(k) is not None and current.get(k) != recorded.get(k)]
    if changed:
        raise Manual("facts changed since commit: " + ", ".join(c.replace("_", " ") for c in changed))
    return recorded


def _line_scope(db: Session, quote, line, recorded: dict) -> str:
    from app.modules.tax.registry_models import TaxRateVersion

    scopes = recorded.get("line_scopes") or {}
    if str(line.document_line_id) in scopes and scopes[str(line.document_line_id)]:
        return scopes[str(line.document_line_id)]
    for comp in line.components:
        if comp.rate_version_id:
            rate = db.get(TaxRateVersion, comp.rate_version_id)
            if rate is not None:
                return rate.product_scope
    raise Manual(f"commit-time value unknown: product scope of line {line.line_number}")


def _original(quote) -> dict:
    lines = []
    for line in sorted(quote.lines, key=lambda l: l.line_number):
        lines.append({"line_number": line.line_number, "outcome": line.outcome.name, "rate": str(line.effective_rate),
                      "tax": str(line.tax_amount),
                      "components": [{"code": c.component_code, "rate": str(c.rate_percent), "tax": str(c.tax_amount),
                                      "rate_version_id": c.rate_version_id} for c in line.components]})
    return {"tax": _dec(quote.tax_amount), "lines": lines}


def compare(db: Session, quote, t: Trigger) -> dict:
    """{status, reason, lines, totals, versions_used, inputs_hash}; never writes."""
    from app.modules.tax.engines import EngineRequest, LineInput, rule_pack_class
    from app.modules.tax.enums import EngineKind
    from app.modules.tax.models import EntityTaxActivation
    from app.modules.tax.policy_models import TaxRulePackVersion, code_version_of

    original = _original(quote)
    base = {"currency": quote.currency, "original_tax": original["tax"], "lines": None, "inputs_hash": None,
            "versions_used": t.versions_used}
    if quote.engine_kind == EngineKind.PROVIDER:
        return {**base, "status": "NOT_ANALYSABLE",
                "reason": "Decided by the tax provider; a provider re-run isn't available."}
    if t.basis == "quarantine":
        return {**base, "status": "MANUAL_REVIEW_REQUIRED",
                "reason": "The rules for this tax date were quarantined; there is no approved basis to compare against."}
    try:
        if t.kind == "rate":
            row = db.get(TaxRulePackVersion, quote.rule_pack_version_id) if quote.rule_pack_version_id else None
            if row is None:
                raise Manual("commit-time value unknown: the quote's pack version (committed before Phase 8 PR 1)")
        else:
            row = t.pack_row
        pack_cls = rule_pack_class(row.code, code_version_of(row))
        if pack_cls is None:
            raise Manual(f"the code of {row.code} v{code_version_of(row)} no longer ships")
        recorded = _commit_facts(db, quote)
        facts = {"seller_entity": {"country_code": recorded["seller_country"]},
                 "buyer": {"addresses": {"BILLING": {"country_code": recorded["billing_country"]}}}}
        pack = pack_cls()
        lookup = t.rate_lookup
        lines, used_rates, inputs = [], set(), []
        for line in sorted(quote.lines, key=lambda l: l.line_number):
            activation_ids = sorted({c.activation_id for c in line.components if c.activation_id})
            if not activation_ids:
                raise Manual(f"commit-time value unknown: activation of line {line.line_number}")
            activations = [db.get(EntityTaxActivation, a) for a in activation_ids]
            scope = _line_scope(db, quote, line, recorded)
            line_input = LineInput(line_id=line.document_line_id, line_number=line.line_number,
                                   product_id=line.product_id, tax_code=line.tax_code,
                                   supply_category=line.supply_category, registry_product_scope=scope,
                                   transaction_class=line.transaction_class, is_tax_inclusive=line.is_tax_inclusive)
            request = EngineRequest(db=db, tax_date=quote.tax_date, currency=quote.currency, facts=facts,
                                    line=line_input, activations=activations,
                                    business_buyer=recorded.get("business_buyer"), rate_lookup=lookup)
            result = pack.determine(request)
            if result.outcome.name == "NOT_DETERMINED" or not result.components:
                raise Manual(f"the comparison basis does not determine line {line.line_number} "
                             f"({result.explanation_code})")
            used_rates.update(str(c.rate_version_id) for c in result.components if c.rate_version_id)
            lines.append((line, result))
            inputs.append({"line": line.document_line_id, "gross": str(line.gross_unrounded),
                           "discounts": [str(line.line_discount_unrounded), str(line.document_discount_unrounded)],
                           "inclusive": line.is_tax_inclusive, "scope": scope, "class": line.transaction_class.name,
                           "activations": activation_ids})
        comparison = _money(quote, lines, pack_cls)
    except Manual as manual:
        return {**base, "status": "MANUAL_REVIEW_REQUIRED", "reason": str(manual)}
    used = {**t.versions_used, "comparison_pack": _pack_ref(row), "comparison_rate_version_ids": sorted(used_rates)}
    difference = original["tax"] - comparison["tax"]
    out_lines = []
    for o, c in zip(original["lines"], comparison["lines"]):
        out_lines.append({"line_number": o["line_number"], "original": o, "comparison": c})
    return {**base, "status": "COMPARED" if difference != 0 else "NO_DIFFERENCE", "reason": None,
            "comparison_tax": comparison["tax"], "difference": difference,
            "direction": "OVER" if difference > 0 else "UNDER" if difference < 0 else "NONE",
            "lines": out_lines, "versions_used": used,
            "inputs_hash": _sha({"quote": quote.id, "tax_date": quote.tax_date, "currency": quote.currency,
                                 "facts": facts, "lines": inputs, "versions": used})}


def _money(quote, lines: list, pack_cls) -> dict:
    """The determination money path on the snapshot's amounts."""
    from app.modules.tax.determination_service import _apply_rates, _Line

    rows = []
    for line, result in lines:
        gross, ld, dd = _dec(line.gross_unrounded), _dec(line.line_discount_unrounded), _dec(line.document_discount_unrounded)
        item = _Line(input=None, source=line, gross=gross, line_discount=ld, document_discount=dd, net=gross - ld - dd)
        item.result = result
        item.input = type("LineFlags", (), {"is_tax_inclusive": line.is_tax_inclusive})()
        rows.append(item)
    _apply_rates(rows, quote.currency_decimals or 2, pack_cls.rounding_rule, pack_cls.rounding_mode)
    out, total = [], Decimal("0")
    for item in rows:
        tax = sum(item.component_rounded, Decimal("0"))
        total += tax
        out.append({"line_number": item.source.line_number, "outcome": item.result.outcome.name,
                    "rate": str(item.rate), "tax": str(tax),
                    "components": [{"code": c.component_code, "rate": str(c.rate_percent), "tax": str(t_),
                                    "rate_version_id": c.rate_version_id}
                                   for c, t_ in zip(item.result.components, item.component_rounded)]})
    return {"tax": total, "lines": out}


# ── aggregates (platform: no identifiers; small populations banded) ─────

def aggregate(results) -> dict:
    orgs, by_status, per_currency = set(), {}, {}
    for r in results:
        orgs.add(r["organization_id"])
        by_status[r["status"]] = by_status.get(r["status"], 0) + 1
        if r["status"] == "COMPARED":
            cur = per_currency.setdefault(r["currency"] or "?", {"net": Decimal("0"), "over": Decimal("0"),
                                                                  "under": Decimal("0"), "documents": 0})
            d = _dec(r["difference"])
            cur["net"] += d
            cur["over" if d > 0 else "under"] += abs(d)
            cur["documents"] += 1
    return {"organizations_affected": len(orgs), "documents": sum(by_status.values()), "by_status": by_status,
            "per_currency": {k: {kk: (str(vv) if isinstance(vv, Decimal) else vv) for kk, vv in v.items()}
                             for k, v in sorted(per_currency.items())}}


def platform_view(aggregates: Optional[dict]) -> Optional[dict]:
    """Fewer than 3 organizations: amounts become magnitude bands (fix B),
    by the shared rule in aggregate_privacy.py."""
    if not aggregates:
        return aggregates
    orgs = aggregates.get("organizations_affected", 0)
    if not small(orgs):
        return {**aggregates, "amounts": amounts_note(orgs)}
    banded = {}
    for cur, v in (aggregates.get("per_currency") or {}).items():
        banded[cur] = {"net": band_net(v.get("net")), "over": band(v.get("over")), "under": band(v.get("under")),
                       "documents": v.get("documents")}
    return {**aggregates, "per_currency": banded, "amounts": amounts_note(orgs)}


def summary_text(aggregates: dict) -> str:
    view = platform_view(aggregates) or {}
    status = ", ".join(f"{n} {s.lower().replace('_', ' ')}" for s, n in sorted((view.get("by_status") or {}).items()))
    money = "; ".join(f"{cur}: net {v['net']}, over {v['over']}, under {v['under']}"
                      for cur, v in (view.get("per_currency") or {}).items())
    return (f"{view.get('organizations_affected', 0)} organizations, {view.get('documents', 0)} documents"
            + (f" ({status})" if status else "") + (f"; {money}" if money else "") + ".")


# ── previews and the approval gate ──────────────────────────────────────

def _row_of(r, organization_id) -> dict:
    return {"organization_id": organization_id, "status": r["status"], "currency": r.get("currency"),
            "difference": r.get("difference")}


def run_preview(db: Session, kind: str, subject_id: int, actor_id: Optional[int]):
    from app.modules.tax.retro_models import TaxRetroAnalysis

    t = subject_trigger(db, kind, subject_id)
    rows = []
    with db.begin_nested() as sp:                      # read-only: discard anything incidental
        try:
            for quote in scope_query(db, t).all():
                rows.append(_row_of(compare(db, quote, t), quote.organization_id))
        finally:
            sp.rollback()
    now = _now()
    preview = TaxRetroAnalysis(
        mode="PREVIEW", trigger_kind=kind, trigger_id=subject_id, subject_id=subject_id, basis=t.basis,
        basis_label=BASES[t.basis], versions_used=t.versions_used, inputs_hash=inputs_hash(t),
        scope_hash=scope_hash(db, t), range_from=_iso(t.range_from), range_to=_iso(t.range_to), status="DONE",
        orgs_total=len({r["organization_id"] for r in rows}), documents_total=len(rows), documents_done=len(rows),
        aggregates=aggregate(rows), created_by=actor_id, created_at=now, started_at=now, finished_at=now)
    db.add(preview)
    db.flush()
    return preview


def _iso(d) -> Optional[str]:
    return d.isoformat() if d is not None else None


def subject_trigger(db: Session, kind: str, subject_id: int) -> Trigger:
    from app.modules.tax.policy_models import TaxRulePackVersion
    from app.modules.tax.registry_models import TaxRateStaging

    if kind == "rule_pack":
        row = db.get(TaxRulePackVersion, subject_id)
        if row is None:
            raise NotFoundException("Rule pack version", subject_id)
        return pack_trigger(db, row)
    if kind == "rate":
        staged = db.get(TaxRateStaging, subject_id)
        if staged is None:
            raise NotFoundException("Staged rate", subject_id)
        return rate_trigger(db, staged=staged)
    raise BadRequestException("kind must be rate or rule_pack.")


def latest_preview(db: Session, kind: str, subject_id: int):
    from app.modules.tax.retro_models import TaxRetroAnalysis

    return db.query(TaxRetroAnalysis).filter(TaxRetroAnalysis.mode == "PREVIEW", TaxRetroAnalysis.trigger_kind == kind,
                                             TaxRetroAnalysis.subject_id == subject_id).order_by(
        TaxRetroAnalysis.id.desc()).first()


def preview_problem(db: Session, kind: str, subject_id: int) -> Optional[str]:
    """Why there is no CURRENT preview, or None when there is."""
    preview = latest_preview(db, kind, subject_id)
    if preview is None:
        return "no retroactive analysis preview has been run"
    t = subject_trigger(db, kind, subject_id)
    if preview.inputs_hash != inputs_hash(t):
        return "the versions in force or the candidate changed since the preview"
    if preview.scope_hash != scope_hash(db, t):
        return "the committed documents in scope changed since the preview"
    max_age = timedelta(hours=int(getattr(settings, "TAX_RETRO_PREVIEW_MAX_AGE_HOURS", 24)))
    created = preview.created_at if preview.created_at.tzinfo else preview.created_at.replace(tzinfo=timezone.utc)
    if created < _now() - max_age:
        return f"the preview is older than {int(max_age.total_seconds() // 3600)} hours"
    return None


def require_current_preview(db: Session, kind: str, subject_id: int) -> None:
    if not getattr(settings, "TAX_RETRO_PREVIEW_REQUIRED", True):
        return
    problem = preview_problem(db, kind, subject_id)
    if problem:
        from app.modules.tax.registry_service import RegistryStateError

        raise RegistryStateError(f"This version changes tax for past dates: a current retroactive analysis preview is "
                                 f"required ({problem}). Run the preview and review its impact first.")


def rate_is_retroactive(db: Session, staged) -> bool:
    from app.modules.tax.registry_models import TaxComponent

    if staged.valid_from is None:
        return False
    component = db.get(TaxComponent, staged.component_id)
    start, end = _rate_window(db, component.jurisdiction_id, staged.valid_from, staged.valid_to)
    return start < end


def subject_is_retroactive(db: Session, kind: str, subject_id: int) -> bool:
    """Whether publishing the subject now would change tax for past dates."""
    from app.modules.tax.policy_models import TaxRulePackVersion
    from app.modules.tax.policy_service import RulePackService
    from app.modules.tax.registry_models import TaxRateStaging

    if kind == "rate":
        staged = db.get(TaxRateStaging, subject_id)
        if staged is None:
            raise NotFoundException("Staged rate", subject_id)
        return rate_is_retroactive(db, staged)
    row = db.get(TaxRulePackVersion, subject_id)
    if row is None:
        raise NotFoundException("Rule pack version", subject_id)
    return RulePackService(db)._is_retroactive(row, _now())


# ── full analyses: enqueue, job, finish ─────────────────────────────────

def enqueue(db: Session, t: Trigger, actor_id: Optional[int] = None):
    from app.modules.tax.retro_models import TaxRetroAnalysis

    existing = db.query(TaxRetroAnalysis).filter(TaxRetroAnalysis.mode == "FULL",
                                                 TaxRetroAnalysis.trigger_kind == t.kind,
                                                 TaxRetroAnalysis.trigger_id == t.trigger_id).first()
    if existing is not None:
        return existing
    row = TaxRetroAnalysis(
        mode="FULL", trigger_kind=t.kind, trigger_id=t.trigger_id, subject_id=t.subject_id, basis=t.basis,
        basis_label=BASES[t.basis], versions_used=t.versions_used, inputs_hash=inputs_hash(t),
        scope_hash=scope_hash(db, t), range_from=_iso(t.range_from), range_to=_iso(t.range_to), severity=t.severity,
        status="PENDING", created_by=actor_id, created_at=_now())
    db.add(row)
    db.flush()
    return row


def trigger_for(db: Session, analysis) -> Trigger:
    from app.modules.tax.policy_models import TaxRollbackRequest, TaxRulePackVersion
    from app.modules.tax.registry_models import TaxRateVersion

    if analysis.trigger_kind == "rollback":
        t = rollback_trigger(db, db.get(TaxRollbackRequest, analysis.trigger_id))
    elif analysis.trigger_kind == "rule_pack":
        t = pack_trigger(db, db.get(TaxRulePackVersion, analysis.trigger_id))
    else:
        t = rate_trigger(db, version=db.get(TaxRateVersion, analysis.trigger_id))
    # The range and versions are fixed at enqueue: a re-run compares the same thing.
    t.range_from = date.fromisoformat(analysis.range_from) if analysis.range_from else None
    t.range_to = date.fromisoformat(analysis.range_to) if analysis.range_to else None
    t.versions_used = analysis.versions_used
    return t


def _locked(db: Session, model, row_id: int, skip: bool = True):
    q = db.query(model).filter(model.id == row_id).populate_existing()
    if db.get_bind().dialect.name == "postgresql":
        q = q.with_for_update(skip_locked=skip)
    return q.first()


def _start(db: Session, analysis_id: int) -> None:
    from app.modules.tax.quote_models import TaxQuote
    from app.modules.tax.retro_models import TaxRetroAnalysis, TaxRetroOrgRun

    a = _locked(db, TaxRetroAnalysis, analysis_id)
    if a is None or a.status != "PENDING":
        db.rollback()
        return
    t = trigger_for(db, a)
    # No ORDER BY with DISTINCT: Postgres requires ordered columns in the select list.
    orgs = sorted({oid for (oid,) in scope_query(db, t).order_by(None).with_entities(
        TaxQuote.organization_id).distinct()})
    now = _now()
    for org_id in orgs:
        db.add(TaxRetroOrgRun(analysis_id=a.id, organization_id=org_id, status="PENDING", cursor=0, documents=0,
                              created_at=now))
    a.status, a.started_at, a.orgs_total = "RUNNING", now, len(orgs)
    a.documents_total = scope_query(db, t).count()
    db.commit()


def _process_org(db: Session, run_id: int, batch: int) -> int:
    from app.modules.tax.quote_models import TaxQuote
    from app.modules.tax.retro_models import TaxRetroAnalysis, TaxRetroOrgRun, TaxRetroResult

    run = _locked(db, TaxRetroOrgRun, run_id)
    if run is None or run.status == "DONE":
        db.rollback()
        return 0
    analysis = db.get(TaxRetroAnalysis, run.analysis_id)
    t = trigger_for(db, analysis)
    quotes = scope_query(db, t, run.organization_id).filter(TaxQuote.id > run.cursor).limit(batch).all()
    done = 0
    for quote in quotes:
        if db.query(TaxRetroResult.id).filter(TaxRetroResult.analysis_id == analysis.id,
                                              TaxRetroResult.quote_id == quote.id).first() is None:
            with db.begin_nested() as sp:
                try:
                    r = compare(db, quote, t)
                finally:
                    sp.rollback()                          # never keep anything the comparison touched
            db.add(TaxRetroResult(
                analysis_id=analysis.id, organization_id=quote.organization_id, quote_id=quote.id,
                invoice_id=quote.document_id, status=r["status"], reason=r.get("reason"), currency=r.get("currency"),
                original_tax=r.get("original_tax"), comparison_tax=r.get("comparison_tax"),
                difference=r.get("difference"), direction=r.get("direction"), lines=_jsonable(r.get("lines")),
                basis_label=analysis.basis_label, versions_used=_jsonable(r.get("versions_used")),
                inputs_hash=r.get("inputs_hash"), created_at=_now()))
            done += 1
        run.cursor = quote.id
        run.documents += 1
    if len(quotes) < batch:
        run.status, run.finished_at = "DONE", _now()
    db.commit()
    return done


def _jsonable(obj):
    return json.loads(json.dumps(obj, default=str)) if obj is not None else None


def _finish(db: Session, analysis_id: int) -> bool:
    from app.modules.tax.retro_models import TaxRetroAnalysis, TaxRetroOrgRun, TaxRetroResult

    a = _locked(db, TaxRetroAnalysis, analysis_id, skip=False)
    if a is None or a.status != "RUNNING" or db.query(TaxRetroOrgRun).filter(
            TaxRetroOrgRun.analysis_id == a.id, TaxRetroOrgRun.status != "DONE").first() is not None:
        db.rollback()
        return False
    results = db.query(TaxRetroResult).filter(TaxRetroResult.analysis_id == a.id).all()
    a.aggregates = aggregate([{"organization_id": r.organization_id, "status": r.status, "currency": r.currency,
                               "difference": r.difference} for r in results])
    a.orgs_done = a.orgs_total
    a.documents_done = len(results)
    a.status, a.finished_at = "DONE", _now()
    db.flush()
    _communicate(db, a, results)
    db.commit()
    return True


def run_retro_analyses(db: Session, batch: Optional[int] = None) -> dict:
    """One pass of the job: start pending analyses, process each tenant in
    batches (one organization per lock), finish complete ones."""
    from app.modules.tax.retro_models import TaxRetroAnalysis, TaxRetroOrgRun

    batch = batch or int(getattr(settings, "TAX_RETRO_BATCH_SIZE", 200))
    ids = [i for (i,) in db.query(TaxRetroAnalysis.id).filter(TaxRetroAnalysis.mode == "FULL",
                                                               TaxRetroAnalysis.status.in_(["PENDING", "RUNNING"]))
           .order_by(TaxRetroAnalysis.id)]
    processed, finished = 0, []
    for analysis_id in ids:
        try:
            _start(db, analysis_id)
            for (run_id,) in db.query(TaxRetroOrgRun.id).filter(TaxRetroOrgRun.analysis_id == analysis_id,
                                                                 TaxRetroOrgRun.status != "DONE").order_by(
                    TaxRetroOrgRun.id).all():
                while True:
                    n = _process_org(db, run_id, batch)
                    processed += n
                    if n == 0 or n < batch:
                        break
            if _finish(db, analysis_id):
                finished.append(analysis_id)
        except Exception as exc:                               # noqa: BLE001  recorded and alerted
            db.rollback()
            logger.exception("Retroactive analysis %s failed", analysis_id)
            _fail(db, analysis_id, exc)
    return {"documents": processed, "finished": finished}


def _fail(db: Session, analysis_id: int, exc: Exception) -> None:
    from app.modules.super_admin.attention_service import AttentionService
    from app.modules.super_admin.models import AttentionSeverity
    from app.modules.tax.monitoring import SOURCE
    from app.modules.tax.retro_models import TaxRetroAnalysis

    a = db.get(TaxRetroAnalysis, analysis_id)
    if a is None:
        return
    a.error = f"{type(exc).__name__}: {exc}"[:2000]
    AttentionService(db).report_or_update(
        source=SOURCE, source_key=f"tax:tax.retro_analysis:{a.id}", title="Tax: retroactive analysis failed",
        description=f"Retroactive analysis #{a.id} ({a.trigger_kind}) failed and will be retried: {type(exc).__name__}.",
        base_severity=AttentionSeverity.P1)
    db.commit()


def run_tax_retro_analysis_job() -> dict:
    """Scheduler entry point (tracked; see core/scheduler.py)."""
    from app.database import SessionLocal

    db = SessionLocal()
    try:
        result = run_retro_analyses(db)
        if result["documents"] or result["finished"]:
            logger.info("[SCHEDULER] Tax retroactive analysis: %s", result)
        return result
    finally:
        db.close()


# ── communication (fix C) ───────────────────────────────────────────────

def _communicate(db: Session, a, results: list) -> None:
    """Platform: the rollback's PR 3 item is updated (same incident); rate and
    pack triggers get their own P2 item. Tenants: the rollback's review item
    is updated, otherwise one new item; one "analysis ready" email to admins.
    No amounts anywhere but the tenant's own report."""
    from app.modules.super_admin.attention_service import AttentionService
    from app.modules.super_admin.models import AttentionSeverity
    from app.modules.tax.monitoring import SOURCE

    summary = summary_text(a.aggregates)
    attention = AttentionService(db)
    with db.begin_nested():
        if a.trigger_kind == "rollback":
            from app.modules.tax.rollback_service import ALERT_PREFIX

            item_key = f"tax:{ALERT_PREFIX}:{a.trigger_id}"
            attention.report_or_update(
                source=SOURCE, source_key=item_key, title="Tax: emergency rollback applied",
                description=f"Retroactive analysis #{a.id} of this rollback is done: {summary} {BASES[a.basis]}.",
                base_severity=AttentionSeverity.P1)
        else:
            attention.report_or_update(
                source=SOURCE, source_key=f"tax:tax.retro_analysis:{a.id}",
                title=f"Tax: retroactive analysis done ({a.trigger_kind.replace('_', ' ')})",
                description=f"Retroactive analysis #{a.id}, tax dates {a.range_from or 'from the start'} to "
                            f"{a.range_to}: {summary}", base_severity=AttentionSeverity.P2)
    per_org = {}
    for r in results:
        counts = per_org.setdefault(r.organization_id, {})
        counts[r.status] = counts.get(r.status, 0) + 1
    for org_id, counts in per_org.items():
        _tell_tenant(db, a, org_id, counts)


def _tell_tenant(db: Session, a, org_id: int, counts: dict) -> None:
    from app.modules.auth.models import User, UserRole
    from app.modules.tax.enums import ReviewItemKind, ReviewItemStatus
    from app.modules.tax.models import TaxReviewItem

    text = ", ".join(f"{n} {s.lower().replace('_', ' ')}" for s, n in sorted(counts.items()))
    line = f"Retroactive analysis #{a.id} is ready ({text}). Open the retroactive analysis report for details."
    item = None
    if a.trigger_kind == "rollback":
        item = db.query(TaxReviewItem).filter(
            TaxReviewItem.organization_id == org_id, TaxReviewItem.kind == ReviewItemKind.TAX_ROLLBACK_APPLIED,
            TaxReviewItem.subject_type == "TaxRollbackRequest", TaxReviewItem.subject_id == a.trigger_id).first()
    if item is not None:
        item.detail = f"{item.detail} {line}".strip()
        item.status = ReviewItemStatus.OPEN
        item.resolved_at = None
    else:
        now = _now()
        db.add(TaxReviewItem(organization_id=org_id, kind=ReviewItemKind.TAX_RETRO_ANALYSIS,
                             subject_type="TaxRetroAnalysis", subject_id=a.id, due_date=(now + timedelta(days=14)).date(),
                             detail=line, owner_role="org_admin", created_at=now))
    db.flush()
    from app.modules.notifications.service import dispatch_email

    admins = db.query(User).filter(User.organization_id == org_id, User.role == UserRole.ORG_ADMIN,
                                   User.is_active.is_(True)).all()
    for admin in admins:
        try:
            dispatch_email(
                template_id="ZB-TAX-002", recipient_email=admin.email,
                context={"recipient_first_name": admin.first_name or "there",
                         "trigger": ("the tax rule rollback we told you about" if a.trigger_kind == "rollback"
                                     else "a correction to tax rules for past dates"),
                         "date_range": f"tax dates {a.range_from or 'from the start'} to {a.range_to or 'today'}"},
                event_name="tax.retro_analysis_ready", entity_type="TaxRetroAnalysis", entity_id=a.id,
                organization_id=org_id, db=db, idempotency_key=f"tax.retro_analysis_ready:{a.id}:{admin.email}")
        except Exception:                                            # a notice never undoes the analysis
            logger.exception("Retroactive analysis notice failed (analysis %s)", a.id)


# ── views ───────────────────────────────────────────────────────────────

def view_platform(a) -> dict:
    """No tenant identifiers; amounts banded for small populations."""
    from app.modules.tax.retro_models import TaxRetroOrgRun

    from sqlalchemy.orm import object_session

    db = object_session(a)
    orgs_done = a.orgs_done
    if db is not None and a.status == "RUNNING":
        orgs_done = db.query(TaxRetroOrgRun).filter(TaxRetroOrgRun.analysis_id == a.id,
                                                    TaxRetroOrgRun.status == "DONE").count()
    return {"id": a.id, "mode": a.mode, "trigger_kind": a.trigger_kind, "trigger_id": a.trigger_id,
            "subject_id": a.subject_id, "basis": a.basis, "basis_label": a.basis_label,
            "versions_used": a.versions_used, "range_from": a.range_from, "range_to": a.range_to,
            "severity": a.severity, "status": a.status, "progress": {"organizations_done": orgs_done,
                                                                    "organizations_total": a.orgs_total,
                                                                    "documents_total": a.documents_total},
            "aggregates": platform_view(a.aggregates), "error": a.error if a.error else None,
            "created_at": a.created_at, "finished_at": a.finished_at}


def remediation_allowed(organization_id: int) -> bool:
    raw = (getattr(settings, "TAX_RETRO_REMEDIATION_ORGS", "") or "").replace(" ", "")
    return str(organization_id) in {x for x in raw.split(",") if x}


def view_tenant_document(r, superseded_by: Optional[int]) -> dict:
    proposal = None
    if r.direction == "OVER":
        components = []
        for line in r.lines or []:
            for o, c in zip(line["original"]["components"], line["comparison"]["components"]):
                delta = _dec(o["tax"]) - _dec(c["tax"])
                if delta > 0:
                    components.append({"line_number": line["line_number"], "component": o["code"],
                                       "tax_correction": str(delta)})
        proposal = {"kind": "tax-only credit (preview)", "amount": str(r.difference), "components": components,
                    "drafts": "Draft credit notes arrive with PR 4b (governed tax-only credit); this is a preview."}
    return {"id": r.id, "analysis_id": r.analysis_id, "quote_id": r.quote_id, "invoice_id": r.invoice_id,
            "status": r.status, "reason": r.reason, "currency": r.currency, "original_tax": r.original_tax,
            "comparison_tax": r.comparison_tax, "difference": r.difference, "direction": r.direction,
            "lines": r.lines, "basis_label": r.basis_label, "versions_used": r.versions_used,
            "inputs_hash": r.inputs_hash, "superseded_by": superseded_by,
            "remediation_preview": proposal,
            "under_collection": "Report only: no debit notes or extra charges (TAX_PHASE8.md)." if r.direction == "UNDER"
            else None}


def superseded_map(db: Session, organization_id: int, quote_ids: list) -> dict:
    """quote_id -> the latest DONE analysis id with a result for it (fix D)."""
    from app.modules.tax.retro_models import TaxRetroAnalysis, TaxRetroResult

    rows = db.query(TaxRetroResult.quote_id, TaxRetroResult.analysis_id).join(
        TaxRetroAnalysis, TaxRetroAnalysis.id == TaxRetroResult.analysis_id).filter(
        TaxRetroResult.organization_id == organization_id, TaxRetroResult.quote_id.in_(quote_ids or [-1]),
        TaxRetroAnalysis.status == "DONE").all()
    latest = {}
    for quote_id, analysis_id in rows:
        latest[quote_id] = max(latest.get(quote_id, 0), analysis_id)
    return latest
