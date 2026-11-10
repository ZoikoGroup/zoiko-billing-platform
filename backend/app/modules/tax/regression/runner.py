"""
app/modules/tax/regression/runner.py
------------------------------------
Historical regression (ZB-TAX-ARCH-001 Phase 7 PR 2, handoff §10.1 step 06).

Replays a fixed set of anonymised invoice inputs (fixtures/*.json, never
production data) through the governed engine's real native rule packs, and
reports every change in outcome, rate or tax between the version in force
(the baseline) and a candidate:

  rule_pack  candidate: the pack version in code, with the published rates.
             baseline: the results recorded when the ACTIVE version of the
             same pack was approved (none for a first version).
  rate       candidate: the published rates with the staged rate laid over
             them for its validity; baseline: the published rates alone.

A report attaches to the approval like the golden-test report. Approving a
rule pack or a staged rate is refused without a CURRENT report (same fixture
set, same baseline, generated within TAX_REGRESSION_MAX_AGE_HOURS), unless
TAX_REGRESSION_REQUIRED is off. Running a report changes nothing else.
"""
import hashlib
import json
from datetime import date, datetime, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path
from types import SimpleNamespace
from typing import Optional

from sqlalchemy.orm import Session

from app.config import settings

FIXTURE_DIR = Path(__file__).resolve().parent / "fixtures"
TWO = Decimal("0.01")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value):
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def load_fixtures() -> dict:
    """All fixture sets, merged, and a hash of their exact content."""
    cases, names, raw = [], [], b""
    for path in sorted(FIXTURE_DIR.glob("*.json")):
        content = path.read_bytes()
        raw += path.name.encode() + b"\0" + content
        data = json.loads(content)
        names.append(data["name"])
        cases.extend(data["cases"])
    return {"names": names, "cases": cases, "hash": hashlib.sha256(raw).hexdigest()}


# ── one engine run ──────────────────────────────────────────────────────

def _rate_overlay(db: Session, staged):
    """lookup_rates with the staged rate laid over the published ones."""
    from app.modules.tax.registry_models import TaxComponent
    from app.modules.tax.registry_service import RegistryReadService

    real = RegistryReadService(db).lookup_rates
    component = db.get(TaxComponent, staged.component_id)

    def lookup(*, jurisdiction_id, tax_code, as_of, **kw):
        result = real(jurisdiction_id=jurisdiction_id, tax_code=tax_code, as_of=as_of, **kw)
        valid = staged.valid_from is not None and staged.valid_from <= as_of and (
            staged.valid_to is None or as_of < staged.valid_to)
        if not valid or (staged.tax_code or "").upper() != (tax_code or "").upper() \
                or component is None or component.jurisdiction_id != jurisdiction_id:
            return result
        items = [i for i in result["items"] if not (i["component_code"] == component.code
                                                    and i["product_scope"] == staged.product_scope)]
        items.append({"id": f"staged:{staged.id}", "component_code": component.code, "component_name": component.name,
                      "product_scope": staged.product_scope, "rate_percent": Decimal(staged.rate_percent)})
        return {**result, "items": items}
    return lookup


def run_case(db: Session, case: dict, pack_cls, rate_lookup=None) -> dict:
    """Outcome, rate and tax per line, and the document tax, for one fixture."""
    from app.modules.tax.engines import EngineRequest, LineInput
    from app.modules.tax.enums import SupplyCategory, TaxOutcome, TransactionClass
    from app.modules.tax.registry_models import TaxJurisdiction, TaxTypeDefinition

    jurisdiction = db.query(TaxJurisdiction).filter(TaxJurisdiction.code == pack_cls.country).first()
    tax_type = db.query(TaxTypeDefinition).filter(TaxTypeDefinition.code == pack_cls.tax_type).first()
    if jurisdiction is None or tax_type is None:
        return {"error": f"{pack_cls.country} {pack_cls.tax_type} is not in the registry"}
    activation = SimpleNamespace(id=None, jurisdiction=jurisdiction, tax_type=tax_type, jurisdiction_id=jurisdiction.id,
                                 tax_type_id=tax_type.id)
    facts = {"seller_entity": {"country_code": case["seller_country"]},
             "buyer": {"addresses": {"BILLING": {"country_code": case["buyer_country"]}},
                       "business_status": "BUSINESS" if case.get("business") else "CONSUMER"}}
    tax_date = date.fromisoformat(case["tax_date"])
    pack = pack_cls()
    lines, unrounded_total = [], Decimal("0")
    for n, line in enumerate(case["lines"], start=1):
        request = EngineRequest(
            db=db, tax_date=tax_date, currency=case["currency"], facts=facts,
            line=LineInput(line_id=n, line_number=n, product_id=None, tax_code="SVC",
                           supply_category=SupplyCategory[line.get("supply_category", "SERVICES")],
                           registry_product_scope=line.get("scope", "GENERAL"),
                           transaction_class=TransactionClass[case["transaction_class"]], is_tax_inclusive=False),
            activations=[activation], business_buyer=bool(case.get("business")), rate_lookup=rate_lookup)
        result = pack.determine(request)
        net = Decimal(line["net"])
        rate = sum((Decimal(c.rate_percent) for c in result.components), Decimal("0"))
        determined = result.outcome != TaxOutcome.NOT_DETERMINED and result.components
        unrounded = net * rate / 100 if determined else Decimal("0")
        unrounded_total += unrounded
        lines.append({"outcome": result.outcome.name, "explanation": result.explanation_code,
                      "rate": format(rate.normalize(), "f") if determined else None,
                      "tax": str(unrounded.quantize(TWO, rounding=ROUND_HALF_UP)) if determined else None})
    per_document = pack_cls.rounding_rule.name == "PER_DOCUMENT"
    determined_lines = [l for l in lines if l["tax"] is not None]
    if not determined_lines:
        total = None
    elif per_document:
        total = str(unrounded_total.quantize(TWO, rounding=ROUND_HALF_UP))
    else:
        total = str(sum((Decimal(l["tax"]) for l in determined_lines), Decimal("0")))
    return {"lines": lines, "tax": total}


def run(db: Session, cases: list, packs: dict, rate_lookup=None) -> dict:
    return {c["id"]: run_case(db, c, packs[c["pack"]], rate_lookup) for c in cases if c["pack"] in packs}


# ── reports ─────────────────────────────────────────────────────────────

def _changes(baseline: Optional[dict], candidate: dict) -> tuple:
    changed, new = [], []
    for case_id, after in sorted(candidate.items()):
        before = (baseline or {}).get(case_id)
        if before is None:
            new.append(case_id)
            continue
        if before != after:
            changed.append({"case": case_id, "before": before, "after": after})
    return changed, new


def _rate_baseline_ref(db: Session, staged) -> str:
    from app.modules.tax.registry_models import TaxRateVersion

    ids = [str(v.id) for v in db.query(TaxRateVersion).filter(TaxRateVersion.component_id == staged.component_id)
           .order_by(TaxRateVersion.id)]
    return "rates:" + ",".join(ids)


def _pack_baseline(db: Session, row):
    from app.modules.tax.enums import PlatformVersionStatus
    from app.modules.tax.policy_models import TaxRulePackVersion
    from app.modules.tax.regression_models import TaxRegressionReport

    active = db.query(TaxRulePackVersion).filter(TaxRulePackVersion.code == row.code,
                                                 TaxRulePackVersion.status == PlatformVersionStatus.ACTIVE,
                                                 TaxRulePackVersion.id != row.id).order_by(TaxRulePackVersion.id.desc()).first()
    if active is None:
        return "rule_pack:none", None
    report = db.query(TaxRegressionReport).filter(TaxRegressionReport.subject_kind == "rule_pack",
                                                  TaxRegressionReport.subject_id == active.id).order_by(
        TaxRegressionReport.id.desc()).first()
    return f"rule_pack:{active.id}", (report.report or {}).get("results") if report else None


def build_report(db: Session, subject_kind: str, subject_id: int, actor_id: Optional[int]):
    """Run the regression for a rule pack version or a staged rate and attach it."""
    from app.core.exceptions import BadRequestException, NotFoundException
    from app.modules.tax.engines import registered_rule_packs
    from app.modules.tax.policy_models import TaxRulePackVersion
    from app.modules.tax.registry_models import TaxComponent, TaxRateStaging
    from app.modules.tax.regression_models import TaxRegressionReport

    fixtures = load_fixtures()
    packs = registered_rule_packs()
    if subject_kind == "rule_pack":
        row = db.get(TaxRulePackVersion, subject_id)
        if row is None:
            raise NotFoundException("Rule pack version", subject_id)
        from app.modules.tax.engines import rule_pack_class

        cls = rule_pack_class(row.code, row.version)
        if cls is None:
            raise BadRequestException("This rule pack version is not the one in code; regression runs the code.")
        cases = [c for c in fixtures["cases"] if c["pack"] == row.code]
        baseline_ref, baseline = _pack_baseline(db, row)
        candidate = run(db, cases, {row.code: cls})
    elif subject_kind == "rate":
        row = db.get(TaxRateStaging, subject_id)
        if row is None:
            raise NotFoundException("Staged rate", subject_id)
        component = db.get(TaxComponent, row.component_id)
        relevant = {code: cls for code, cls in packs.items() if component and cls.component_code == component.code}
        cases = [c for c in fixtures["cases"] if c["pack"] in relevant]
        baseline_ref = _rate_baseline_ref(db, row)
        baseline = run(db, cases, relevant)
        candidate = run(db, cases, relevant, rate_lookup=_rate_overlay(db, row))
    else:
        raise BadRequestException("subject_kind must be rule_pack or rate.")
    changed, new = _changes(baseline, candidate)
    errors = [case for case, r in candidate.items() if "error" in r]
    report = {"fixture_sets": fixtures["names"], "fixture_hash": fixtures["hash"], "cases": len(candidate),
              "changed": changed, "unchanged": len(candidate) - len(changed) - len(new), "new_cases": new,
              "errors": errors, "baseline_ref": baseline_ref, "results": candidate}
    row = TaxRegressionReport(subject_kind=subject_kind, subject_id=subject_id, fixture_hash=fixtures["hash"],
                              baseline_ref=baseline_ref, changed_count=len(changed), case_count=len(candidate),
                              report=report, generated_by=actor_id, generated_at=_now())
    db.add(row)
    db.flush()
    from app.modules.super_admin.audit_service import PlatformAuditService
    from app.modules.super_admin.models import PlatformAuditAction

    PlatformAuditService(db).log_no_commit(actor_id=actor_id, actor_role="super_admin",
                                           action=PlatformAuditAction.UPDATE, entity_type="TaxRegressionReport",
                                           entity_id=row.id,
                                           metadata={"subject": f"{subject_kind}:{subject_id}", "cases": len(candidate),
                                                     "changed": len(changed), "fixture_hash": fixtures["hash"]})
    return row


def latest(db: Session, subject_kind: str, subject_id: int):
    from app.modules.tax.regression_models import TaxRegressionReport

    return db.query(TaxRegressionReport).filter(TaxRegressionReport.subject_kind == subject_kind,
                                                TaxRegressionReport.subject_id == subject_id).order_by(
        TaxRegressionReport.id.desc()).first()


def currency_problem(db: Session, subject_kind: str, subject_id: int) -> Optional[str]:
    """Why the latest report is not current, or None when it is."""
    from app.modules.tax.policy_models import TaxRulePackVersion
    from app.modules.tax.registry_models import TaxRateStaging

    report = latest(db, subject_kind, subject_id)
    if report is None:
        return "no regression report has been run"
    if report.fixture_hash != load_fixtures()["hash"]:
        return "the regression fixtures changed since the report was run"
    if subject_kind == "rule_pack":
        current_ref, _ = _pack_baseline(db, db.get(TaxRulePackVersion, subject_id))
    else:
        current_ref = _rate_baseline_ref(db, db.get(TaxRateStaging, subject_id))
    if report.baseline_ref != current_ref:
        return "the baseline (the version in force) changed since the report was run"
    max_age = timedelta(hours=int(getattr(settings, "TAX_REGRESSION_MAX_AGE_HOURS", 72)))
    if _aware(report.generated_at) < _now() - max_age:
        return f"the report is older than {int(max_age.total_seconds() // 3600)} hours"
    return None


def require_current(db: Session, subject_kind: str, subject_id: int) -> None:
    """Approval gate: refused without a current report (TAX_REGRESSION_REQUIRED)."""
    if not getattr(settings, "TAX_REGRESSION_REQUIRED", True):
        return
    problem = currency_problem(db, subject_kind, subject_id)
    if problem:
        from app.modules.tax.registry_service import RegistryStateError

        raise RegistryStateError(f"A current regression report is required before approval: {problem}. "
                                 "Run the regression and review its changes first.")


def view_report(row) -> Optional[dict]:
    if row is None:
        return None
    r = row.report or {}
    return {"id": row.id, "subject_kind": row.subject_kind, "subject_id": row.subject_id,
            "generated_at": row.generated_at, "generated_by": row.generated_by, "fixture_sets": r.get("fixture_sets"),
            "fixture_hash": row.fixture_hash, "baseline_ref": row.baseline_ref, "cases": row.case_count,
            "changed": r.get("changed", []), "unchanged": r.get("unchanged"), "new_cases": r.get("new_cases", []),
            "errors": r.get("errors", [])}
