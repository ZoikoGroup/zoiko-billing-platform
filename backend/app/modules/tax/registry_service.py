"""
app/modules/tax/registry_service.py
-----------------------------------
Global Tax Reference Registry services (ZB-TAX-ARCH-001 Phase 1).

  * RegistryReadService — reference lookups for /api/v1/tax/jurisdictions and
    /rates. Facts only, never an "amount owed" (§09.1). Returns published
    versions exclusively; staged proposals are invisible here.
  * TaxRegistryPipeline — staging -> validation -> maker-checker approval ->
    publish (§10.1). Ingestion never writes tax_rate_versions directly; a
    conflicting source escalates and stays unpublished while the prior
    approved version remains active (T11).

Like ApprovalService and PlatformAuditService, nothing here commits: the
caller's transaction owns atomicity, so a correction's supersede + insert is
one unit (and the deferred EXCLUDE constraint is checked at commit).
"""
import hashlib
import json
import logging
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Optional
from zoneinfo import ZoneInfo

from sqlalchemy import event, inspect, or_
from sqlalchemy.orm import Session

from app.core.exceptions import BadRequestException, NotFoundException, ZoikoException
from app.modules.super_admin.approval_service import ApprovalService, SelfApprovalError
from app.modules.super_admin.audit_service import PlatformAuditService
from app.modules.super_admin.models import ApprovalRequest, AttentionSeverity, PlatformAuditAction
from app.modules.tax.enums import (
    AMENDABLE_STAGED_STATUSES,
    OPEN_STAGED_STATUSES,
    ChangeKind,
    EvidenceStatus,
    JurisdictionLevel,
    RateKind,
    RateVersionStatus,
    RedistributionPermission,
    SourceTier,
    StagedRateStatus,
    StagingOrigin,
    TaxOperatingMode,
)
from app.modules.tax.registry_models import (
    EVIDENCE_ATTACH_FIELDS,
    RATE_VERSION_MUTABLE_FIELDS,
    TaxAuthority,
    TaxChangeApproval,
    TaxComponent,
    TaxJurisdiction,
    TaxLegalSourceRevision,
    TaxRateStaging,
    TaxRateVersion,
    TaxSourceArtifact,
)

logger = logging.getLogger("zoiko_billing.tax.registry")

APPROVAL_REQUEST_TYPE = "tax_rate_publish"
MAX_ARTIFACT_BYTES = 25 * 1024 * 1024
RATE_MAX = Decimal("100")
RATE_QUANTUM = Decimal("0.000001")
REFERENCE_DISCLAIMER = (
    "Reference information only. This is not a tax determination, does not state an amount owed, "
    "and is not cleared for production invoicing."
)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class RegistryImmutabilityError(ZoikoException):
    def __init__(self, message: str):
        super().__init__(status_code=409, error_code="TAX_REGISTRY_IMMUTABLE", message=message)


class RegistryStateError(ZoikoException):
    def __init__(self, message: str):
        super().__init__(status_code=409, error_code="TAX_REGISTRY_STATE", message=message)


class MakerCheckerError(ZoikoException):
    def __init__(self, message: str):
        super().__init__(status_code=403, error_code="TAX_REGISTRY_MAKER_CHECKER", message=message)


# ── ORM immutability guard ───────────────────────────────────────────────
# Gives a clear error for ORM writes. query().update() and raw SQL bypass
# this; on Postgres the triggers in registry_models.py catch those.

def _changed_columns(obj) -> set[str]:
    state = inspect(obj)
    return {attr.key for attr in state.mapper.column_attrs if state.attrs[attr.key].history.has_changes()}


def _committed_value(obj, key: str):
    state = inspect(obj)
    hist = state.attrs[key].history
    if hist.deleted:
        return hist.deleted[0]
    return getattr(obj, key)


@event.listens_for(Session, "before_flush")
def _guard_registry_immutability(session, flush_context, instances):
    for obj in session.deleted:
        if isinstance(obj, (TaxRateVersion, TaxLegalSourceRevision, TaxSourceArtifact)):
            raise RegistryImmutabilityError(f"{type(obj).__name__} rows are immutable and cannot be deleted.")
    for obj in session.dirty:
        if isinstance(obj, TaxRateVersion):
            changed = _changed_columns(obj)
            if not changed:
                continue
            illegal = changed - set(RATE_VERSION_MUTABLE_FIELDS)
            if illegal:
                raise RegistryImmutabilityError(
                    f"Published tax rate version {obj.id} is immutable ({', '.join(sorted(illegal))}); "
                    "publish a new version instead."
                )
            if _committed_value(obj, "status") == RateVersionStatus.SUPERSEDED:
                raise RegistryImmutabilityError(f"Tax rate version {obj.id} is already superseded.")
        elif isinstance(obj, TaxLegalSourceRevision):
            changed = _changed_columns(obj)
            if not changed:
                continue
            if _committed_value(obj, "evidence_status") == EvidenceStatus.CAPTURED:
                raise RegistryImmutabilityError(
                    f"Legal source revision {obj.id} already has evidence attached; register a new revision."
                )
            illegal = changed - set(EVIDENCE_ATTACH_FIELDS)
            if illegal:
                raise RegistryImmutabilityError(
                    f"Legal source revision {obj.id} is immutable ({', '.join(sorted(illegal))}); "
                    "register a new revision instead."
                )
        elif isinstance(obj, TaxSourceArtifact) and _changed_columns(obj):
            raise RegistryImmutabilityError("Source artifacts are write-once.")


# ── Helpers ──────────────────────────────────────────────────────────────

def _enum_name(value) -> Optional[str]:
    return value.name if hasattr(value, "name") else value


def _canonical_sha256(payload: Any) -> Optional[str]:
    if payload is None:
        return None
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()


def _intervals_overlap(a_from: date, a_to: Optional[date], b_from: date, b_to: Optional[date]) -> bool:
    """Half-open [from, to) overlap; None means open-ended."""
    return (b_to is None or a_from < b_to) and (a_to is None or b_from < a_to)


def jurisdiction_local_today(jurisdiction: TaxJurisdiction) -> Optional[date]:
    """Today's date in the jurisdiction's legal calendar, or None when the
    jurisdiction has no single timezone (the caller must then be explicit)."""
    if not jurisdiction.timezone:
        return None
    return datetime.now(ZoneInfo(jurisdiction.timezone)).date()


def legal_date_at(instant: datetime, timezone_name: str) -> date:
    """The jurisdiction-local legal date of a UTC instant (T03/T17): valid_from
    / valid_to and tax dates are dates in the jurisdiction's own calendar, so
    23:30 in Toronto on 31 December is still 31 December there."""
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=timezone.utc)
    return instant.astimezone(ZoneInfo(timezone_name)).date()


def _user_display_name(user) -> Optional[str]:
    if user is None:
        return None
    name = f"{user.first_name or ''} {user.last_name or ''}".strip()
    return name or None


def public_source_summary(revision: TaxLegalSourceRevision) -> dict:
    """The tenant-safe view of a source: where to read it and who reviewed
    it. Never includes the captured artifact, its hash, storage location or
    internal notes — those stay on the privileged /source-revisions route,
    whatever the artifact's redistribution permission."""
    return {
        "authority": revision.authority.name if revision.authority else None,
        "title": revision.title,
        "permanent_url": revision.permanent_url,
        "citation": revision.citation,
        "reviewed_by": _user_display_name(revision.reviewer),
        "reviewed_at": revision.reviewed_at,
    }


def privileged_source_view(revision: TaxLegalSourceRevision) -> dict:
    return {
        "id": revision.id,
        "authority_id": revision.authority_id,
        "authority": revision.authority.name if revision.authority else None,
        "handoff_ref": revision.handoff_ref,
        "source_tier": _enum_name(revision.source_tier),
        "acquisition_method": _enum_name(revision.acquisition_method),
        "permanent_url": revision.permanent_url,
        "document_id": revision.document_id,
        "document_version": revision.document_version,
        "title": revision.title,
        "citation": revision.citation,
        "language": revision.language,
        "internal_notes": revision.internal_notes,
        "evidence_status": _enum_name(revision.evidence_status),
        "redistribution_permission": _enum_name(revision.redistribution_permission),
        "retrieved_at": revision.retrieved_at,
        "sha256": revision.sha256,
        "artifact_storage_uri": revision.artifact_storage_uri,
        "artifact_media_type": revision.artifact_media_type,
        "artifact_size_bytes": revision.artifact_size_bytes,
        "reviewer_user_id": revision.reviewer_user_id,
        "reviewed_by": _user_display_name(revision.reviewer),
        "reviewed_at": revision.reviewed_at,
        "created_at": revision.created_at,
    }


# ── Read side ────────────────────────────────────────────────────────────

class RegistryReadService:
    def __init__(self, db: Session):
        self.db = db

    @staticmethod
    def _known_filter(query, known_at: datetime):
        return query.filter(
            TaxRateVersion.published_at <= known_at,
            or_(TaxRateVersion.superseded_at.is_(None), TaxRateVersion.superseded_at > known_at),
        )

    def get_jurisdiction(self, jurisdiction_id: int) -> TaxJurisdiction:
        jurisdiction = self.db.query(TaxJurisdiction).filter(TaxJurisdiction.id == jurisdiction_id).first()
        if jurisdiction is None:
            raise NotFoundException("Tax jurisdiction", jurisdiction_id)
        return jurisdiction

    def list_jurisdictions(
        self, *, country: Optional[str] = None, level: Optional[JurisdictionLevel] = None,
        parent_code: Optional[str] = None,
    ) -> list[dict]:
        query = self.db.query(TaxJurisdiction).filter(TaxJurisdiction.is_active.is_(True))
        if country:
            query = query.filter(TaxJurisdiction.country_code == country.strip().upper())
        if level:
            query = query.filter(TaxJurisdiction.level == level)
        if parent_code:
            parent = self.db.query(TaxJurisdiction).filter(TaxJurisdiction.code == parent_code.strip().upper()).first()
            if parent is None:
                return []
            query = query.filter(TaxJurisdiction.parent_id == parent.id)
        jurisdictions = query.order_by(TaxJurisdiction.code).all()

        now = utcnow()
        known = self._known_filter(self.db.query(TaxRateVersion), now).all()
        by_jurisdiction: dict[int, list[TaxRateVersion]] = {}
        for version in known:
            by_jurisdiction.setdefault(version.jurisdiction_id, []).append(version)

        items = []
        for j in jurisdictions:
            versions = by_jurisdiction.get(j.id, [])
            last_published = max((v.published_at for v in versions), default=None)
            items.append({
                "id": j.id,
                "code": j.code,
                "name": j.name,
                "level": _enum_name(j.level),
                "country_code": j.country_code,
                "subdivision_code": j.subdivision_code,
                "parent_code": j.parent.code if j.parent else None,
                "official_area_id": j.official_area_id,
                "timezone": j.timezone,
                "reference_status": "REFERENCE_ONLY" if versions else "NO_APPROVED_RATES",
                # Phase 1 never enables production calculation (§05): that
                # needs a per-entity activation record (Phase 2).
                "production_calculation": "NOT_ACTIVATED",
                "published_rate_versions": len(versions),
                "last_published_at": last_published,
            })
        return items

    def lookup_rates(
        self,
        *,
        jurisdiction_id: int,
        tax_code: Optional[str] = None,
        as_of: Optional[date] = None,
        known_at: Optional[datetime] = None,
    ) -> dict:
        jurisdiction = self.get_jurisdiction(jurisdiction_id)
        if as_of is None:
            as_of = jurisdiction_local_today(jurisdiction)
            if as_of is None:
                raise BadRequestException(
                    f"Jurisdiction {jurisdiction.code} spans several timezones; pass an explicit as_of date "
                    "in its local legal calendar."
                )
        if known_at is None:
            known_at = utcnow()
        elif known_at.tzinfo is None:
            known_at = known_at.replace(tzinfo=timezone.utc)

        query = self._known_filter(
            self.db.query(TaxRateVersion).filter(TaxRateVersion.jurisdiction_id == jurisdiction.id), known_at,
        ).filter(
            TaxRateVersion.valid_from <= as_of,
            or_(TaxRateVersion.valid_to.is_(None), TaxRateVersion.valid_to > as_of),
        )
        if tax_code:
            query = query.filter(TaxRateVersion.tax_code == tax_code.strip().upper())
        versions = query.order_by(TaxRateVersion.tax_code, TaxRateVersion.product_scope, TaxRateVersion.id).all()

        return {
            "jurisdiction": {"id": jurisdiction.id, "code": jurisdiction.code, "name": jurisdiction.name,
                             "timezone": jurisdiction.timezone},
            "as_of": as_of,
            "known_at": known_at,
            "mode": TaxOperatingMode.REFERENCE_ONLY.name,
            # An empty result is "no approved reference rate", never 0%.
            "coverage": "APPROVED_REFERENCE_RATES" if versions else "NO_APPROVED_RATE",
            "disclaimer": REFERENCE_DISCLAIMER,
            "items": [self._version_view(v) for v in versions],
        }

    @staticmethod
    def _version_view(v: TaxRateVersion) -> dict:
        return {
            "id": v.id,
            "component_code": v.component.code,
            "component_name": v.component.name,
            "tax_type": v.component.tax_type.code,
            "tax_code": v.tax_code,
            "product_scope": v.product_scope,
            "rate_kind": _enum_name(v.rate_kind),
            "rate_percent": v.rate_percent,
            "is_cumulative": v.is_cumulative,
            "valid_from": v.valid_from,
            "valid_to": v.valid_to,
            "announced_at": v.announced_at,
            "observed_at": v.observed_at,
            "approved_at": v.approved_at,
            "published_at": v.published_at,
            "activated_at": v.activated_at,
            "superseded_at": v.superseded_at,
            "status": _enum_name(v.status),
            "mode": _enum_name(v.mode),
            "evidence_status": _enum_name(v.evidence_status),
            "predecessor_id": v.predecessor_id,
            "source": public_source_summary(v.source_revision),
        }

    def get_source_revision(self, revision_id: int) -> TaxLegalSourceRevision:
        revision = self.db.query(TaxLegalSourceRevision).filter(TaxLegalSourceRevision.id == revision_id).first()
        if revision is None:
            raise NotFoundException("Legal source revision", revision_id)
        return revision


# ── Pipeline ─────────────────────────────────────────────────────────────

_STAGED_EDITABLE_FIELDS = (
    "component_id", "tax_code", "product_scope", "rate_kind", "rate_percent", "valid_from", "valid_to",
    "announced_at", "source_revision_id", "owner", "supersedes_rate_version_id", "reviewer_notes",
)


class TaxRegistryPipeline:
    def __init__(self, db: Session):
        self.db = db
        self.audit = PlatformAuditService(db)
        self.approvals = ApprovalService(db)

    # ── lookups ──
    def get_staged(self, staged_id: int) -> TaxRateStaging:
        row = self.db.query(TaxRateStaging).filter(TaxRateStaging.id == staged_id).first()
        if row is None:
            raise NotFoundException("Staged tax rate", staged_id)
        return row

    def list_staged(self, *, status: Optional[StagedRateStatus] = None, skip: int = 0, limit: int = 100):
        query = self.db.query(TaxRateStaging)
        if status is not None:
            query = query.filter(TaxRateStaging.status == status)
        total = query.count()
        return query.order_by(TaxRateStaging.id).offset(skip).limit(limit).all(), total

    def _component(self, component_id: int) -> TaxComponent:
        component = self.db.query(TaxComponent).filter(TaxComponent.id == component_id).first()
        if component is None:
            raise NotFoundException("Tax component", component_id)
        return component

    def _log(self, actor_id, action, entity_type, entity_id, *, old=None, new=None, metadata=None, reason=None):
        self.audit.log_no_commit(
            actor_id=actor_id, actor_role="super_admin" if actor_id else "system", action=action,
            entity_type=entity_type, entity_id=entity_id, old_values=old, new_values=new,
            metadata=metadata, reason=reason,
        )

    # ── sources ──
    def register_source_revision(
        self, *, actor_id: Optional[int], authority_id: int, source_tier, acquisition_method, permanent_url: str,
        title: str, citation: str, language: str, handoff_ref: Optional[str] = None,
        document_id: Optional[str] = None, document_version: Optional[str] = None,
        internal_notes: Optional[str] = None,
    ) -> TaxLegalSourceRevision:
        if self.db.query(TaxAuthority).filter(TaxAuthority.id == authority_id).first() is None:
            raise NotFoundException("Tax authority", authority_id)
        if not (permanent_url or "").strip().lower().startswith("https://"):
            raise BadRequestException("A legal source needs a permanent https:// URL.")
        if not (citation or "").strip() or not (title or "").strip():
            raise BadRequestException("A legal source needs a title and a citation.")
        revision = TaxLegalSourceRevision(
            authority_id=authority_id, handoff_ref=handoff_ref, source_tier=source_tier,
            acquisition_method=acquisition_method, permanent_url=permanent_url.strip(), title=title.strip(),
            citation=citation.strip(), language=language.strip(), document_id=document_id,
            document_version=document_version, internal_notes=internal_notes,
            created_by_user_id=actor_id, created_at=utcnow(),
        )
        self.db.add(revision)
        self.db.flush()
        self._log(actor_id, PlatformAuditAction.TAX_SOURCE_REGISTERED, "TaxLegalSourceRevision", revision.id,
                  new={"permanent_url": revision.permanent_url, "handoff_ref": handoff_ref})
        return revision

    def attach_evidence(
        self, *, actor_id: int, revision_id: int, content: bytes, media_type: str,
        filename: Optional[str], redistribution_permission: RedistributionPermission,
    ) -> TaxLegalSourceRevision:
        """One-shot evidence capture. The hash, retrieval timestamp and storage
        location are computed here from the uploaded bytes; nothing
        client-supplied is trusted for them."""
        revision = RegistryReadService(self.db).get_source_revision(revision_id)
        if revision.evidence_status == EvidenceStatus.CAPTURED:
            raise RegistryImmutabilityError(
                f"Legal source revision {revision.id} already has evidence attached; register a new revision."
            )
        if not content:
            raise BadRequestException("The evidence artifact is empty.")
        if len(content) > MAX_ARTIFACT_BYTES:
            raise BadRequestException(f"The evidence artifact exceeds {MAX_ARTIFACT_BYTES // (1024 * 1024)} MB.")

        now = utcnow()
        digest = hashlib.sha256(content).hexdigest()
        if self.db.query(TaxSourceArtifact).filter(TaxSourceArtifact.sha256 == digest).first() is None:
            self.db.add(TaxSourceArtifact(
                sha256=digest, content=content, media_type=media_type or "application/octet-stream",
                size_bytes=len(content), original_filename=filename, uploaded_by_user_id=actor_id, uploaded_at=now,
            ))
            self.db.flush()

        revision.evidence_status = EvidenceStatus.CAPTURED
        revision.redistribution_permission = redistribution_permission
        revision.retrieved_at = now
        revision.sha256 = digest
        revision.artifact_storage_uri = f"db://tax_source_artifacts/{digest}"
        revision.artifact_media_type = media_type or "application/octet-stream"
        revision.artifact_size_bytes = len(content)
        revision.reviewer_user_id = actor_id
        revision.reviewed_at = now
        self.db.flush()
        self._log(actor_id, PlatformAuditAction.TAX_SOURCE_EVIDENCE_ATTACHED, "TaxLegalSourceRevision", revision.id,
                  new={"sha256": digest, "size_bytes": len(content),
                       "redistribution_permission": redistribution_permission.name})
        return revision

    # ── staging ──
    def stage(
        self, *, actor_id: Optional[int], origin: StagingOrigin, component_id: int, tax_code: str,
        rate_kind: RateKind, rate_percent: Optional[Decimal] = None, product_scope: str = "GENERAL",
        valid_from: Optional[date] = None, valid_to: Optional[date] = None,
        announced_at: Optional[datetime] = None, observed_at: Optional[datetime] = None,
        source_revision_id: Optional[int] = None, owner: Optional[str] = None,
        supersedes_rate_version_id: Optional[int] = None, raw_payload: Optional[dict] = None,
        external_ref: Optional[str] = None, reviewer_notes: Optional[str] = None,
    ) -> TaxRateStaging:
        self._component(component_id)
        now = utcnow()
        row = TaxRateStaging(
            origin=origin, external_ref=external_ref, component_id=component_id,
            tax_code=(tax_code or "").strip().upper(), product_scope=(product_scope or "GENERAL").strip().upper(),
            rate_kind=rate_kind, rate_percent=rate_percent, valid_from=valid_from, valid_to=valid_to,
            announced_at=announced_at, observed_at=observed_at or now, source_revision_id=source_revision_id,
            owner=owner, supersedes_rate_version_id=supersedes_rate_version_id, raw_payload=raw_payload,
            raw_payload_sha256=_canonical_sha256(raw_payload), reviewer_notes=reviewer_notes,
            status=StagedRateStatus.PENDING_REVIEW, created_by_user_id=actor_id, created_at=now,
        )
        self.db.add(row)
        self.db.flush()
        self._log(actor_id, PlatformAuditAction.TAX_RATE_STAGED, "TaxRateStaging", row.id,
                  new={"origin": origin.name, "component_id": component_id, "tax_code": row.tax_code,
                       "rate_percent": rate_percent})
        return row

    def _reset_review(self, row: TaxRateStaging) -> None:
        row.status = StagedRateStatus.PENDING_REVIEW
        row.validation_errors = None
        row.validation_warnings = None
        row.validated_at = None
        row.escalation_reason = None
        row.escalated_at = None
        row.updated_at = utcnow()

    def amend(self, *, actor_id: int, staged_id: int, changes: dict) -> TaxRateStaging:
        row = self.get_staged(staged_id)
        if row.status not in AMENDABLE_STAGED_STATUSES:
            raise RegistryStateError(f"Staged rate {row.id} is {row.status.name}; it can no longer be amended.")
        unknown = set(changes) - set(_STAGED_EDITABLE_FIELDS)
        if unknown:
            raise BadRequestException(f"Not editable: {', '.join(sorted(unknown))}")
        required = [k for k in ("component_id", "tax_code", "product_scope", "rate_kind") if k in changes and changes[k] is None]
        if required:
            raise BadRequestException(f"Cannot clear required fields: {', '.join(required)}")
        if "component_id" in changes:
            self._component(changes["component_id"])
        before = {k: getattr(row, k) for k in changes}
        for key, value in changes.items():
            if key in ("tax_code", "product_scope") and value is not None:
                value = value.strip().upper()
            setattr(row, key, value)
        self._reset_review(row)
        self.db.flush()
        self._log(actor_id, PlatformAuditAction.TAX_RATE_AMENDED, "TaxRateStaging", row.id, old=before, new=changes)
        return row

    def adopt(self, *, actor_id: int, staged_id: int) -> TaxRateStaging:
        """A human maker takes ownership of an AI proposal. Until then it can
        never enter approval (§06.2, §12.2: AI may propose, never publish)."""
        row = self.get_staged(staged_id)
        if row.origin != StagingOrigin.AI_PROPOSAL:
            raise BadRequestException("Only AI proposals need adopting.")
        if row.adopted_by_user_id is not None:
            raise RegistryStateError(f"Staged rate {row.id} was already adopted.")
        if row.status not in AMENDABLE_STAGED_STATUSES:
            raise RegistryStateError(f"Staged rate {row.id} is {row.status.name}; it cannot be adopted.")
        row.adopted_by_user_id = actor_id
        row.adopted_at = utcnow()
        self._reset_review(row)
        self.db.flush()
        self._log(actor_id, PlatformAuditAction.TAX_RATE_ADOPTED, "TaxRateStaging", row.id)
        return row

    # ── validation (§10.1 step 4) ──
    def _check(self, row: TaxRateStaging) -> tuple[list[str], list[str], list[str]]:
        """Returns (errors, conflicts, warnings). Pure: changes nothing."""
        errors: list[str] = []
        conflicts: list[str] = []
        warnings: list[str] = []

        component = self._component(row.component_id)
        if not component.is_active:
            errors.append(f"Component {component.code} is inactive.")
        if not (row.tax_code or "").strip():
            errors.append("tax_code is required.")

        rate = row.rate_percent
        if rate is None:
            errors.append("rate_percent is required.")
        else:
            try:
                rate = Decimal(rate)
                if rate < 0 or rate >= RATE_MAX:
                    errors.append("rate_percent must be at least 0 and below 100.")
                if rate != rate.quantize(RATE_QUANTUM):
                    errors.append("rate_percent allows at most 6 decimal places.")
            except InvalidOperation:
                errors.append("rate_percent is not a decimal number.")

        if row.valid_from is None:
            errors.append("valid_from is required: take it from the legal instrument.")
        elif row.valid_to is not None and row.valid_to <= row.valid_from:
            errors.append("valid_to must be after valid_from (the interval is end-exclusive).")

        if not (row.owner or "").strip():
            errors.append("owner is required.")

        source = row.source_revision
        if source is None:
            errors.append("A legal source revision is required.")
        else:
            if source.source_tier == SourceTier.SECONDARY_COMMENTARY:
                errors.append("Secondary commentary cannot back a published rate on its own (§06.1).")
            if not (source.permanent_url or "").lower().startswith("https://") or not (source.citation or "").strip():
                errors.append("The legal source needs a permanent https:// URL and a citation.")
            if source.evidence_status != EvidenceStatus.CAPTURED:
                warnings.append("Source evidence is not captured yet; approval will be refused until it is.")
            if source.redistribution_permission == RedistributionPermission.UNKNOWN:
                warnings.append("Source redistribution permission is UNKNOWN; approval will be refused until recorded.")
            if source.source_tier == SourceTier.OFFICIAL_GUIDANCE:
                warnings.append("Source is official guidance; confirm against the legal instrument (§06.1).")

        superseded: Optional[TaxRateVersion] = None
        if row.supersedes_rate_version_id is not None:
            superseded = self.db.query(TaxRateVersion).filter(TaxRateVersion.id == row.supersedes_rate_version_id).first()
            if superseded is None:
                errors.append(f"Superseded version {row.supersedes_rate_version_id} does not exist.")
            elif superseded.status != RateVersionStatus.ACTIVE:
                errors.append(f"Version {superseded.id} is not ACTIVE and cannot be superseded.")
            elif (superseded.component_id, superseded.tax_code, superseded.product_scope) != (
                row.component_id, row.tax_code, row.product_scope
            ):
                errors.append(f"Version {superseded.id} has a different rate key.")

        if row.valid_from is not None and not component.is_cumulative:
            active = self.db.query(TaxRateVersion).filter(
                TaxRateVersion.component_id == row.component_id,
                TaxRateVersion.tax_code == row.tax_code,
                TaxRateVersion.product_scope == row.product_scope,
                TaxRateVersion.status == RateVersionStatus.ACTIVE,
            ).all()
            for version in active:
                if superseded is not None and version.id == superseded.id:
                    continue
                if not _intervals_overlap(row.valid_from, row.valid_to, version.valid_from, version.valid_to):
                    continue
                if rate is not None and Decimal(version.rate_percent) == rate:
                    errors.append(f"Overlaps active version {version.id} with the same rate (duplicate).")
                else:
                    conflicts.append(
                        f"Overlaps active version {version.id} ({version.rate_percent}%) with a different rate "
                        "and does not declare it superseded."
                    )

            others = self.db.query(TaxRateStaging).filter(
                TaxRateStaging.id != row.id,
                TaxRateStaging.component_id == row.component_id,
                TaxRateStaging.tax_code == row.tax_code,
                TaxRateStaging.product_scope == row.product_scope,
                TaxRateStaging.status.in_(list(OPEN_STAGED_STATUSES)),
            ).all()
            for other in others:
                if other.valid_from is None or not _intervals_overlap(
                    row.valid_from, row.valid_to, other.valid_from, other.valid_to
                ):
                    continue
                if other.rate_percent is not None and rate is not None and Decimal(other.rate_percent) != rate:
                    conflicts.append(
                        f"Conflicts with staged proposal {other.id} ({other.rate_percent}%) for the same key and period."
                    )
                elif other.rate_percent is not None and rate is not None:
                    errors.append(f"Duplicates staged proposal {other.id}.")
        return errors, conflicts, warnings

    def validate(self, *, actor_id: Optional[int], staged_id: int) -> TaxRateStaging:
        row = self.get_staged(staged_id)
        if row.status not in AMENDABLE_STAGED_STATUSES:
            raise RegistryStateError(f"Staged rate {row.id} is {row.status.name}; it cannot be re-validated.")
        errors, conflicts, warnings = self._check(row)
        now = utcnow()
        row.validation_errors = errors + conflicts or None
        row.validation_warnings = warnings or None
        row.validated_at = now
        row.updated_at = now
        if conflicts:
            self._escalate(row, conflicts, actor_id)
        elif errors:
            row.status = StagedRateStatus.VALIDATION_FAILED
            self.db.flush()
            self._log(actor_id, PlatformAuditAction.TAX_RATE_VALIDATION_FAILED, "TaxRateStaging", row.id,
                      metadata={"errors": errors})
        else:
            row.status = StagedRateStatus.VALIDATED
            row.escalation_reason = None
            row.escalated_at = None
            self.db.flush()
            self._log(actor_id, PlatformAuditAction.TAX_RATE_VALIDATED, "TaxRateStaging", row.id,
                      metadata={"warnings": warnings})
        return row

    def _escalate(self, row: TaxRateStaging, conflicts: list[str], actor_id: Optional[int]) -> None:
        """T11: the conflicting proposal stays unpublished and a reviewer is
        alerted; the currently published version is not touched."""
        from app.modules.super_admin.attention_service import AttentionService

        row.status = StagedRateStatus.CONFLICT_ESCALATED
        row.escalation_reason = "; ".join(conflicts)
        row.escalated_at = utcnow()
        self.db.flush()
        component = row.component
        AttentionService(self.db).report_or_update(
            source="tax_registry",
            source_key=f"tax_rate_conflict:{component.code}:{row.tax_code}:{row.product_scope}",
            title=f"Tax source conflict: {component.code} {row.tax_code}",
            description=(
                f"Staged proposal {row.id} conflicts with published or staged data and was not published. "
                f"{row.escalation_reason} Independent specialist review required (ZB-TAX-ARCH-001 §10.1)."
            ),
            base_severity=AttentionSeverity.P2,
        )
        self._log(actor_id, PlatformAuditAction.TAX_RATE_CONFLICT_ESCALATED, "TaxRateStaging", row.id,
                  metadata={"conflicts": conflicts})

    def _require_clean(self, row: TaxRateStaging) -> None:
        """Re-run validation at a decision point; refuse on any problem."""
        errors, conflicts, _ = self._check(row)
        if conflicts:
            raise RegistryStateError("Conflicts appeared since validation: " + "; ".join(conflicts))
        if errors:
            raise RegistryStateError("Validation no longer passes: " + "; ".join(errors))

    @staticmethod
    def _require_evidence(row: TaxRateStaging) -> None:
        source = row.source_revision
        if source is None or source.evidence_status != EvidenceStatus.CAPTURED:
            raise RegistryStateError("The legal source has no captured evidence; attach it before approval.")
        if source.redistribution_permission == RedistributionPermission.UNKNOWN:
            raise RegistryStateError("The legal source's redistribution permission is UNKNOWN; record it first.")

    # ── maker-checker (§10.1 step 5) ──
    def submit(self, *, actor_id: int, staged_id: int, reason: str) -> TaxRateStaging:
        row = self.get_staged(staged_id)
        if row.status != StagedRateStatus.VALIDATED:
            raise RegistryStateError(f"Staged rate {row.id} is {row.status.name}; validate it before submitting.")
        if row.origin == StagingOrigin.AI_PROPOSAL and row.adopted_by_user_id != actor_id:
            raise MakerCheckerError(
                "An AI proposal can only be submitted by the human reviewer who adopted it."
            )
        self._require_clean(row)

        superseded = None
        if row.supersedes_rate_version_id:
            superseded = self.db.get(TaxRateVersion, row.supersedes_rate_version_id)
        proposed = {
            "component_code": row.component.code, "tax_code": row.tax_code, "product_scope": row.product_scope,
            "rate_kind": row.rate_kind.name, "rate_percent": str(row.rate_percent),
            "valid_from": row.valid_from.isoformat(), "valid_to": row.valid_to.isoformat() if row.valid_to else None,
            "source_revision_id": row.source_revision_id, "owner": row.owner,
        }
        before = None
        if superseded is not None:
            before = {"rate_version_id": superseded.id, "rate_percent": str(superseded.rate_percent),
                      "valid_from": superseded.valid_from.isoformat(),
                      "valid_to": superseded.valid_to.isoformat() if superseded.valid_to else None}
        request = self.approvals.create_request(
            request_type=APPROVAL_REQUEST_TYPE, requested_by_user_id=actor_id, reason=reason,
            scope={"staged_rate_id": row.id, "component_code": row.component.code},
            before_state=before, proposed_state=proposed,
            evidence={"source_revision_id": row.source_revision_id, "raw_payload_sha256": row.raw_payload_sha256},
            correlation_id=f"tax_rate_staging:{row.id}",
        )
        change = TaxChangeApproval(
            approval_request_id=request.id, staged_rate_id=row.id,
            change_kind=(ChangeKind.SUPERSEDING if superseded is not None else ChangeKind.NEW).name,
            detector=row.origin, source_comparison={"before": before, "proposed": proposed},
            maker_user_id=actor_id, submitted_at=utcnow(),
        )
        self.db.add(change)
        self.db.flush()
        row.change_approval_id = change.id
        row.status = StagedRateStatus.IN_APPROVAL
        row.updated_at = utcnow()
        self.db.flush()
        self._log(actor_id, PlatformAuditAction.TAX_RATE_SUBMITTED, "TaxRateStaging", row.id, reason=reason,
                  metadata={"approval_request_id": request.id})
        return row

    def _change(self, row: TaxRateStaging) -> TaxChangeApproval:
        change = row.change_approval
        if change is None:
            raise RegistryStateError(f"Staged rate {row.id} has no approval record.")
        return change

    def _assert_not_maker(self, row: TaxRateStaging, change: TaxChangeApproval, actor_id: int, action: str) -> None:
        involved = {change.maker_user_id, row.created_by_user_id, row.adopted_by_user_id} - {None}
        if actor_id in involved:
            raise MakerCheckerError(f"You prepared this change; a different person must {action} it.")

    def approve(self, *, actor_id: int, staged_id: int) -> TaxRateStaging:
        row = self.get_staged(staged_id)
        if row.status != StagedRateStatus.IN_APPROVAL:
            raise RegistryStateError(f"Staged rate {row.id} is {row.status.name}, not IN_APPROVAL.")
        change = self._change(row)
        self._assert_not_maker(row, change, actor_id, "approve")
        self._require_evidence(row)
        self._require_clean(row)
        try:
            self.approvals.approve(change.approval_request, approver_user_id=actor_id)
        except SelfApprovalError as exc:
            raise MakerCheckerError(str(exc))
        change.checker_user_id = actor_id
        change.decided_at = utcnow()
        row.status = StagedRateStatus.APPROVED
        row.updated_at = change.decided_at
        self.db.flush()
        self._log(actor_id, PlatformAuditAction.TAX_RATE_APPROVED, "TaxRateStaging", row.id,
                  metadata={"approval_request_id": change.approval_request_id})
        return row

    def reject(self, *, actor_id: int, staged_id: int, reason: str) -> TaxRateStaging:
        row = self.get_staged(staged_id)
        if row.status == StagedRateStatus.IN_APPROVAL:
            change = self._change(row)
            self._assert_not_maker(row, change, actor_id, "reject")
            try:
                self.approvals.reject(change.approval_request, approver_user_id=actor_id, rejection_reason=reason)
            except SelfApprovalError as exc:
                raise MakerCheckerError(str(exc))
            change.checker_user_id = actor_id
            change.decided_at = utcnow()
        elif row.status not in AMENDABLE_STAGED_STATUSES:
            raise RegistryStateError(f"Staged rate {row.id} is {row.status.name}; it cannot be rejected.")
        row.status = StagedRateStatus.REJECTED
        row.reviewer_notes = ((row.reviewer_notes + "\n") if row.reviewer_notes else "") + f"Rejected: {reason}"
        row.updated_at = utcnow()
        self.db.flush()
        self._log(actor_id, PlatformAuditAction.TAX_RATE_REJECTED, "TaxRateStaging", row.id, reason=reason)
        return row

    # ── publish (§10.1 step 7) ──
    def publish(self, *, actor_id: int, staged_id: int) -> TaxRateVersion:
        row = self.get_staged(staged_id)
        if row.status != StagedRateStatus.APPROVED:
            raise RegistryStateError(f"Staged rate {row.id} is {row.status.name}, not APPROVED.")
        change = self._change(row)
        self._assert_not_maker(row, change, actor_id, "publish")
        self._require_evidence(row)
        self._require_clean(row)

        now = utcnow()
        predecessor = None
        if row.supersedes_rate_version_id:
            predecessor = self.db.get(TaxRateVersion, row.supersedes_rate_version_id)
            # Supersede first, so the ACTIVE set never overlaps even before
            # the deferred EXCLUDE check runs at commit.
            predecessor.status = RateVersionStatus.SUPERSEDED
            predecessor.superseded_at = now
            self.db.flush()

        component = row.component
        version = TaxRateVersion(
            component_id=component.id, jurisdiction_id=component.jurisdiction_id, tax_code=row.tax_code,
            product_scope=row.product_scope, rate_kind=row.rate_kind, rate_percent=row.rate_percent,
            valid_from=row.valid_from, valid_to=row.valid_to, announced_at=row.announced_at,
            observed_at=row.observed_at, approved_at=change.decided_at, published_at=now, activated_at=now,
            status=RateVersionStatus.ACTIVE, mode=TaxOperatingMode.REFERENCE_ONLY,
            is_cumulative=component.is_cumulative, source_revision_id=row.source_revision_id,
            evidence_status=row.source_revision.evidence_status, owner=row.owner,
            predecessor_id=predecessor.id if predecessor else None, staged_rate_id=row.id,
            change_approval_id=change.id,
        )
        self.db.add(version)
        self.db.flush()

        row.status = StagedRateStatus.PUBLISHED
        row.published_rate_version_id = version.id
        row.updated_at = now
        change.publisher_user_id = actor_id
        change.published_at = now
        self.db.flush()

        if predecessor is not None:
            self._log(actor_id, PlatformAuditAction.TAX_RATE_SUPERSEDED, "TaxRateVersion", predecessor.id,
                      old={"status": "ACTIVE"}, new={"status": "SUPERSEDED", "successor_id": version.id})
        self._log(actor_id, PlatformAuditAction.TAX_RATE_PUBLISHED, "TaxRateVersion", version.id,
                  new={"rate_percent": version.rate_percent, "valid_from": version.valid_from,
                       "valid_to": version.valid_to, "predecessor_id": version.predecessor_id},
                  metadata={"staged_rate_id": row.id, "approval_request_id": change.approval_request_id})
        return version
