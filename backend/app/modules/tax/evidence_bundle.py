"""
app/modules/tax/evidence_bundle.py
----------------------------------
Audit-evidence bundles (ZB-TAX-ARCH-001 Phase 5c, launch gate 06, G-5a-5).

One record's evidence as a self-contained, sealed document:
  * the version itself (the same view the screens show);
  * its sources and evidence hashes (source revisions' server SHA-256,
    evidence documents' SHA-256, gate evidence references, the golden-test
    report reference);
  * every state change from the audit log, with names and timestamps;
  * the two-person approvals, and for platform decisions whether an MFA
    step-up succeeded just before them.

The bundle carries `bundle_sha256`: SHA-256 over its own canonical JSON
(sorted keys, without that field), so a copy can be checked later. Every
export is audited.

Platform bundles (sources, rates, tax-code sets, rule packs, market
availability) are for tax roles only and contain platform data only: no
tenant identifiers. Tenant bundles (registrations, legal bases,
activations, classification decisions, regime changes) are scoped to the
caller's organization; platform roles never reach them (T13).
"""
import hashlib
import html
import json
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session

from app.core.exceptions import BadRequestException, NotFoundException

PLATFORM_KINDS = ("source_revision", "rate", "tax_code_set", "rule_pack", "market_availability")
TENANT_KINDS = ("registration", "legal_basis", "activation", "classification", "regime_change")
#: An MFA step-up counts for a decision when it succeeded this long before it, by the same person.
STEP_UP_WINDOW = timedelta(minutes=10)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value):
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def canonical(obj) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), default=str)


def seal(bundle: dict) -> dict:
    body = {k: v for k, v in bundle.items() if k != "bundle_sha256"}
    sealed = json.loads(canonical(body))                       # plain JSON types only
    sealed["bundle_sha256"] = hashlib.sha256(canonical(sealed).encode()).hexdigest()
    return sealed


def verify(bundle: dict) -> bool:
    """True when `bundle_sha256` matches the rest of the bundle."""
    return seal(bundle)["bundle_sha256"] == bundle.get("bundle_sha256")


def _names(db: Session, ids, organization_id: Optional[int]) -> dict:
    """id -> "First Last (role)". Platform bundles name platform users only;
    tenant bundles name the organization's own users only."""
    from app.modules.auth.models import User

    ids = {i for i in ids if i is not None}
    if not ids:
        return {}
    q = db.query(User).filter(User.id.in_(ids))
    q = q.filter(User.organization_id.is_(None)) if organization_id is None else \
        q.filter(User.organization_id == organization_id)
    out = {}
    for u in q:
        role = (u.platform_role.name if organization_id is None and u.platform_role is not None
                else getattr(u.role, "name", str(u.role)))
        out[u.id] = f"{(u.first_name or '').strip()} {(u.last_name or '').strip()}".strip() + f" ({role})"
    return out


def _who(names: dict, user_id) -> Optional[dict]:
    if user_id is None:
        return None
    return {"user_id": user_id, "name": names.get(user_id, f"user #{user_id}")}


# ── platform ────────────────────────────────────────────────────────────

def _platform_record(db: Session, kind: str, record_id: int):
    """(row, view, entity types+ids for the audit log, sources, golden report)."""
    from app.modules.tax.policy_models import TaxCodeSetVersion, TaxMarketAvailabilityVersion, TaxRulePackVersion
    from app.modules.tax.policy_service import (
        source_dependency_status, view_availability, view_code_set, view_rule_pack,
    )
    from app.modules.tax.registry_models import TaxLegalSourceRevision, TaxRateStaging
    from app.modules.tax.registry_service import privileged_source_view

    def source_entry(rev):
        if rev is None:
            return None
        return {"source_revision_id": rev.id, "handoff_ref": rev.handoff_ref, "title": rev.title,
                "citation": rev.citation, "permanent_url": rev.permanent_url,
                "evidence_status": getattr(rev.evidence_status, "name", rev.evidence_status),
                "evidence_sha256": rev.sha256,
                "redistribution_permission": getattr(rev.redistribution_permission, "name",
                                                     rev.redistribution_permission)}

    if kind == "source_revision":
        row = db.get(TaxLegalSourceRevision, record_id)
        if row is None:
            raise NotFoundException("Source revision", record_id)
        view = privileged_source_view(row)
        view.pop("artifact_storage_uri", None)                  # storage location stays internal
        return row, view, [("TaxLegalSourceRevision", row.id)], [source_entry(row)], None
    if kind == "rate":
        from app.modules.tax.registry_router import staged_view

        row = db.get(TaxRateStaging, record_id)
        if row is None:
            raise NotFoundException("Staged rate", record_id)
        refs = [("TaxRateStaging", row.id)]
        if row.published_rate_version_id:
            refs.append(("TaxRateVersion", row.published_rate_version_id))
        rev = db.get(TaxLegalSourceRevision, row.source_revision_id) if row.source_revision_id else None
        return row, staged_view(row), refs, [s for s in [source_entry(rev)] if s], None
    if kind == "tax_code_set":
        row = db.get(TaxCodeSetVersion, record_id)
        if row is None:
            raise NotFoundException("Tax-code set", record_id)
        return row, view_code_set(db, row), [("TaxCodeSetVersion", row.id)], [], None
    if kind == "rule_pack":
        row = db.get(TaxRulePackVersion, record_id)
        if row is None:
            raise NotFoundException("Rule pack", record_id)
        sources = []
        for dep in row.source_dependencies or []:
            ref = dep.get("handoff_ref") if isinstance(dep, dict) else dep
            status = source_dependency_status(db, ref)
            rev = db.get(TaxLegalSourceRevision, status["source_id"]) if status["source_id"] else None
            sources.append({**(source_entry(rev) or {"handoff_ref": ref}), "approved": status["approved"],
                            "reason": status["reason"]})
        return row, view_rule_pack(row), [("TaxRulePackVersion", row.id)], sources, row.golden_test_report
    if kind == "market_availability":
        row = db.get(TaxMarketAvailabilityVersion, record_id)
        if row is None:
            raise NotFoundException("Market availability version", record_id)
        gates = [{"gate": g, "status": (e or {}).get("status"), "evidence_ref": (e or {}).get("evidence_ref"),
                  "notes": (e or {}).get("notes")} for g, e in sorted((row.gates or {}).items())]
        return row, view_availability(row), [("TaxMarketAvailabilityVersion", row.id)], gates, None
    raise BadRequestException(f"Unknown evidence kind {kind!r}; use one of {', '.join(PLATFORM_KINDS)}.")


def _is_decision(action_name: str, metadata) -> bool:
    meta = metadata or {}
    return ("APPROVED" in action_name or "PUBLISH" in action_name or bool(meta.get("approved"))
            or bool(meta.get("published")))


def platform_bundle(db: Session, actor, kind: str, record_id: int) -> dict:
    from app.config import settings
    from app.modules.super_admin.models import PlatformAuditAction, PlatformAuditLog

    row, view, refs, sources, golden = _platform_record(db, kind, record_id)
    events = []
    for entity_type, entity_id in refs:
        events += db.query(PlatformAuditLog).filter(
            PlatformAuditLog.entity_type == entity_type, PlatformAuditLog.entity_id == entity_id,
            PlatformAuditLog.organization_id.is_(None)).all()
    events.sort(key=lambda e: (_aware(e.created_at) or _now(), e.id))
    actor_ids = {e.actor_id for e in events} | {getattr(row, f, None) for f in (
        "maker_user_id", "checker_user_id", "publisher_user_id", "created_by_user_id", "adopted_by_user_id",
        "reviewer_user_id")}
    names = _names(db, actor_ids, None)
    step_ups = db.query(PlatformAuditLog).filter(
        PlatformAuditLog.action == PlatformAuditAction.MFA_CHALLENGE_SUCCESS,
        PlatformAuditLog.actor_id.in_([e.actor_id for e in events if e.actor_id] or [-1])).all()

    def stepped_up(event) -> bool:
        at = _aware(event.created_at)
        return any(s.actor_id == event.actor_id and (s.metadata_ or {}).get("stage") == "step_up"
                   and at - STEP_UP_WINDOW <= _aware(s.created_at) <= at for s in step_ups)

    history = []
    for e in events:
        action = getattr(e.action, "name", str(e.action))
        entry = {"at": _aware(e.created_at), "action": action, "entity": f"{e.entity_type}#{e.entity_id}",
                 "actor": _who(names, e.actor_id), "reason": e.reason, "details": e.metadata_ or e.new_values}
        if _is_decision(action, e.metadata_):
            entry["step_up_verified"] = stepped_up(e)
        history.append(entry)
    approvals = {role: _who(names, getattr(row, field, None)) for role, field in (
        ("drafted_by", "created_by_user_id"), ("maker", "maker_user_id"), ("checker", "checker_user_id"),
        ("publisher", "publisher_user_id"), ("adopted_by", "adopted_by_user_id"), ("reviewer", "reviewer_user_id"))
        if getattr(row, field, None) is not None}
    bundle = {
        "bundle_type": "zoiko.tax.evidence.platform", "kind": kind, "record_id": record_id,
        "generated_at": _now(), "generated_by": _who(_names(db, [actor.id], None), actor.id),
        "step_up_required_for_decisions": bool(settings.TAX_REGISTRY_STEP_UP_REQUIRED),
        "record": view, "sources_and_evidence": sources, "golden_test_report": golden,
        "approvals": approvals, "history": history,
    }
    sealed = seal(bundle)
    from app.modules.super_admin.audit_service import PlatformAuditService

    PlatformAuditService(db).log_no_commit(
        actor_id=actor.id, actor_role="super_admin", action=PlatformAuditAction.TAX_EVIDENCE_BUNDLE_EXPORTED,
        entity_type=refs[0][0], entity_id=refs[0][1], metadata={"kind": kind, "bundle_sha256": sealed["bundle_sha256"]})
    db.commit()
    return sealed


# ── tenant ──────────────────────────────────────────────────────────────

def _tenant_record(db: Session, organization_id: int, kind: str, record_id: int):
    from app.modules.tax.classification_service import view_classification
    from app.modules.tax.models import (
        EntityTaxActivation, EntityTaxLegalBasis, EntityTaxRegistration, ProductTaxClassification, TaxEvidenceFile,
        TaxRegimeChange,
    )
    from app.modules.tax.tenant_tax_service import (
        view_activation, view_legal_basis, view_regime_change, view_registration,
    )

    spec = {
        "registration": (EntityTaxRegistration, "EntityTaxRegistration", view_registration),
        "legal_basis": (EntityTaxLegalBasis, "EntityTaxLegalBasis", view_legal_basis),
        "activation": (EntityTaxActivation, "EntityTaxActivation", view_activation),
        "classification": (ProductTaxClassification, "ProductTaxClassification", view_classification),
        "regime_change": (TaxRegimeChange, "TaxRegimeChange", view_regime_change),
    }.get(kind)
    if spec is None:
        raise BadRequestException(f"Unknown evidence kind {kind!r}; use one of {', '.join(TENANT_KINDS)}.")
    model, entity_type, view = spec
    row = db.query(model).filter(model.id == record_id, model.organization_id == organization_id).first()
    if row is None:
        raise NotFoundException(entity_type, record_id)
    evidence = []
    file_id = getattr(row, "evidence_file_id", None)
    if file_id:
        stored = db.get(TaxEvidenceFile, file_id)
        if stored is not None and stored.organization_id == organization_id:
            evidence.append({"document_sha256": stored.sha256, "media_type": stored.media_type,
                             "size_bytes": stored.size_bytes, "uploaded_at": stored.created_at})
    if getattr(row, "evidence_ref", None):
        evidence.append({"evidence_ref": row.evidence_ref})
    return row, view(row), entity_type, evidence


def tenant_bundle(db: Session, organization_id: int, actor, kind: str, record_id: int) -> dict:
    from app.modules.billing.models import BillingAuditAction, BillingAuditLog
    from app.modules.billing.services.audit_service import BillingAuditService

    row, view, entity_type, evidence = _tenant_record(db, organization_id, kind, record_id)
    events = db.query(BillingAuditLog).filter(
        BillingAuditLog.organization_id == organization_id, BillingAuditLog.entity_type == entity_type,
        BillingAuditLog.entity_id == row.id).order_by(BillingAuditLog.timestamp, BillingAuditLog.id).all()
    people = {e.actor_id for e in events} | {getattr(row, f, None) for f in (
        "proposed_by", "recorded_by", "approved_by", "created_by", "updated_by")} | {actor.id}
    names = _names(db, people, organization_id)
    history = [{"at": _aware(e.timestamp), "action": getattr(e.action, "name", str(e.action)),
                "actor": _who(names, e.actor_id), "details": e.new_values} for e in events]
    approvals = {role: _who(names, getattr(row, field, None)) for role, field in (
        ("proposed_by", "proposed_by"), ("recorded_by", "recorded_by"), ("created_by", "created_by"),
        ("decided_by", "approved_by")) if getattr(row, field, None) is not None}
    if getattr(row, "approved_at", None) is not None:
        approvals["decided_at"] = _aware(row.approved_at)
    bundle = {
        "bundle_type": "zoiko.tax.evidence.tenant", "kind": kind, "record_id": record_id,
        "organization_id": organization_id, "generated_at": _now(), "generated_by": _who(names, actor.id),
        "record": view, "evidence": evidence, "approvals": approvals, "history": history,
    }
    sealed = seal(bundle)
    BillingAuditService(db).log_no_commit(organization_id, actor.id, BillingAuditAction.EXPORT, entity_type, row.id,
                                          new_values={"evidence_bundle_sha256": sealed["bundle_sha256"]})
    db.commit()
    return sealed


# ── human-readable summary ──────────────────────────────────────────────

def render_html(bundle: dict) -> str:
    """A printable summary of a sealed bundle (save as PDF from the browser)."""
    esc = lambda v: html.escape("—" if v is None or v == "" else str(v))  # noqa: E731

    def table(rows):
        return "<table>" + "".join(f"<tr><th>{esc(k)}</th><td>{esc(v)}</td></tr>" for k, v in rows) + "</table>"

    record = bundle.get("record") or {}
    parts = [
        "<!doctype html><html lang='en'><head><meta charset='utf-8'>",
        f"<title>Tax evidence — {esc(bundle['kind'])} #{esc(bundle['record_id'])}</title>",
        "<style>body{font-family:system-ui,sans-serif;margin:2rem;color:#111}table{border-collapse:collapse;"
        "margin:0 0 1.5rem;width:100%}th,td{border:1px solid #ccc;padding:4px 8px;text-align:left;"
        "vertical-align:top;font-size:13px}th{background:#f3f4f6;width:28%}code{word-break:break-all}</style>",
        "</head><body>",
        f"<h1>Tax evidence bundle: {esc(bundle['kind'])} #{esc(bundle['record_id'])}</h1>",
        f"<p>Generated {esc(bundle['generated_at'])} by {esc((bundle.get('generated_by') or {}).get('name'))}.</p>",
        f"<p>Bundle SHA-256: <code>{esc(bundle['bundle_sha256'])}</code> (over the JSON bundle without this field).</p>",
        "<h2>Record</h2>", table([(k, v) for k, v in record.items() if not isinstance(v, (list, dict))]),
    ]
    sources = bundle.get("sources_and_evidence") or bundle.get("evidence") or []
    if sources:
        parts.append("<h2>Sources and evidence</h2>")
        for s in sources:
            parts.append(table(list(s.items())))
    if bundle.get("golden_test_report"):
        parts += ["<h2>Golden-test report</h2>", table(list(bundle["golden_test_report"].items()))]
    parts += ["<h2>Approvals</h2>", table([(k, v.get("name") if isinstance(v, dict) else v)
                                           for k, v in (bundle.get("approvals") or {}).items()])]
    parts.append("<h2>History</h2><table><tr><th>When</th><th>Action</th><th>By</th><th>Notes</th></tr>")
    for h in bundle.get("history") or []:
        note = h.get("reason") or ""
        if "step_up_verified" in h:
            note = f"{note} MFA step-up: {'verified' if h['step_up_verified'] else 'not found'}".strip()
        parts.append(f"<tr><td>{esc(h['at'])}</td><td>{esc(h['action'])}</td>"
                     f"<td>{esc((h.get('actor') or {}).get('name'))}</td><td>{esc(note)}</td></tr>")
    parts.append("</table></body></html>")
    return "".join(parts)
