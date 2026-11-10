"""
app/modules/tax/approvals_inbox.py
----------------------------------
The platform tax approvals inbox (Tax Control Center gap B1, screen P8).

Every platform tax change awaiting a checker's decision, across the four
maker-checker workflows: staged rates, tax-code sets, rule packs and market
availability. Each item says whether the calling user may approve it, and if
not, why: a role without the approve capability, or the author, submitter or
adopter of the change. The workflows themselves still enforce this on
approve; the inbox only reflects it.

Platform data only: these records carry no organization, customer or
invoice data.
"""
from typing import Optional

from sqlalchemy.orm import Session

from app.core.capabilities import has_capability
from app.modules.tax.enums import PlatformVersionStatus, StagedRateStatus
from app.modules.tax.policy_models import TaxCodeSetVersion, TaxMarketAvailabilityVersion, TaxRulePackVersion
from app.modules.tax.registry_models import TaxChangeApproval, TaxRateStaging

KINDS = ("staged_rate", "tax_code_set", "rule_pack", "market_availability", "activation_cancel")


def _iso(value) -> Optional[str]:
    return value.isoformat() if value is not None else None


def _verdict(user, involved: set) -> tuple[bool, Optional[str]]:
    if not has_capability(user, "tax_registry.approve"):
        return False, "Your role cannot approve tax registry changes (TAX_PUBLISHER only)."
    if user.id in involved:
        return False, "You prepared or submitted this change; a different person must approve it."
    return True, None


def _staged_rates(db: Session, user) -> list:
    items = []
    rows = db.query(TaxRateStaging).filter(TaxRateStaging.status == StagedRateStatus.IN_APPROVAL).all()
    changes = {c.id: c for c in db.query(TaxChangeApproval).filter(
        TaxChangeApproval.id.in_([r.change_approval_id for r in rows if r.change_approval_id] or [0]))}
    for row in rows:
        change = changes.get(row.change_approval_id)
        maker = change.maker_user_id if change else None
        can, why = _verdict(user, {maker, row.created_by_user_id, row.adopted_by_user_id} - {None})
        component = row.component.code if row.component else f"component {row.component_id}"
        rate = f"{row.rate_percent.normalize()}%" if row.rate_percent is not None else "no rate"
        items.append({
            "kind": "staged_rate", "id": row.id,
            "title": f"{component} {row.tax_code}/{row.product_scope} {rate} from {row.valid_from or '?'}",
            "submitted_by": maker, "submitted_at": _iso(change.submitted_at if change else None),
            "can_approve": can, "reason_if_not": why,
        })
    return items


def _versions(db: Session, user, model, kind: str, title) -> list:
    items = []
    for row in db.query(model).filter(model.status == PlatformVersionStatus.IN_APPROVAL).all():
        can, why = _verdict(user, {row.maker_user_id, row.created_by_user_id} - {None})
        items.append({
            "kind": kind, "id": row.id, "title": title(row),
            "submitted_by": row.maker_user_id, "submitted_at": _iso(row.submitted_at),
            "can_approve": can, "reason_if_not": why,
        })
    return items


def _availability_title(row) -> str:
    jurisdiction = row.jurisdiction.code if row.jurisdiction else row.jurisdiction_id
    tax_type = row.tax_type.code if row.tax_type else row.tax_type_id
    return f"{jurisdiction} {tax_type} {row.transaction_class.name} -> {row.mode.name}"


def _cancellations(db: Session, user) -> list:
    """Phase 8 PR 2: proposed cancellations of scheduled activations."""
    from app.modules.tax.policy_models import TaxActivationCancellation

    items = []
    for c in db.query(TaxActivationCancellation).filter(TaxActivationCancellation.status == "PROPOSED").all():
        model = TaxRulePackVersion if c.version_kind == "rule_pack" else TaxMarketAvailabilityVersion
        row = db.get(model, c.version_id)
        if row is None:
            continue
        subject = f"rule pack {row.code} v{row.version}" if c.version_kind == "rule_pack" else _availability_title(row)
        can, why = _verdict(user, {c.proposed_by} - {None})
        items.append({
            "kind": "activation_cancel", "id": c.id,
            "title": f"Cancel the scheduled activation of {subject} ({row.activate_at_local} {row.activate_tz})",
            "submitted_by": c.proposed_by, "submitted_at": _iso(c.created_at),
            "can_approve": can, "reason_if_not": why,
            "version_kind": c.version_kind, "version_id": c.version_id, "reason": c.reason,
        })
    return items


def approvals_inbox(db: Session, user, kind: Optional[str] = None) -> list:
    """All items awaiting approval, oldest submission first (ties: kind, id)."""
    sources = {
        "staged_rate": lambda: _staged_rates(db, user),
        "tax_code_set": lambda: _versions(db, user, TaxCodeSetVersion, "tax_code_set",
                                          lambda r: f"Tax codes {r.code} v{r.version}"),
        "rule_pack": lambda: _versions(db, user, TaxRulePackVersion, "rule_pack",
                                       lambda r: f"Rule pack {r.code} v{r.version}"),
        "market_availability": lambda: _versions(db, user, TaxMarketAvailabilityVersion, "market_availability",
                                                 _availability_title),
        "activation_cancel": lambda: _cancellations(db, user),
    }
    items = []
    for name in ([kind] if kind else KINDS):
        items += sources[name]()
    return sorted(items, key=lambda i: (i["submitted_at"] or "", i["kind"], i["id"]))


def item_key(item: dict) -> str:
    return f"{item['kind']}:{item['id']}"
