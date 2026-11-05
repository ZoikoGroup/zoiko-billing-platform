"""
app/modules/tax/address_resolver.py
-----------------------------------
Address resolution for sub-national tax (ZB-TAX-ARCH-001 Phase 4c, T07).

An AddressResolver is separate from the tax-provider adapter (procurement
decides whether one vendor provides both). Like providers, resolvers are
code-defined (ADDRESS_RESOLVERS); a tenant never supplies a URL.

Rules:
  * A ZIP / postal code alone never resolves a US jurisdiction: a street line
    is required, and only rooftop or parcel precision (ACCEPTED_PRECISIONS)
    counts as RESOLVED.
  * More than one candidate, or a lower precision, is AMBIGUOUS: issuing
    is blocked (NEEDS_EVIDENCE) until the address is corrected.
  * Each resolution is recorded (tax_address_resolutions): resolver, source,
    precision/confidence and the jurisdiction codes, write-once evidence.
"""
import enum
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session

from app.core.exceptions import BadRequestException

#: Countries whose buyer jurisdictions come from a resolved street address.
ADDRESS_RESOLUTION_COUNTRIES = frozenset({"US"})


class ResolutionStatus(str, enum.Enum):
    RESOLVED  = "resolved"
    AMBIGUOUS = "ambiguous"
    NOT_FOUND = "not_found"


class ResolutionPrecision(str, enum.Enum):
    ROOFTOP      = "rooftop"
    PARCEL       = "parcel"
    STREET       = "street"
    ZIP_PLUS4    = "zip_plus4"
    ZIP_CENTROID = "zip_centroid"
    MANUAL       = "manual"           # Phase 4d: two-person manual resolution with evidence


ACCEPTED_PRECISIONS = frozenset({ResolutionPrecision.ROOFTOP, ResolutionPrecision.PARCEL})
MANUAL_RESOLVER = "manual"


@dataclass(frozen=True)
class Resolution:
    status: ResolutionStatus
    precision: Optional[ResolutionPrecision] = None
    jurisdiction_codes: tuple = ()          # e.g. ("US", "US-CA", "US-CA-LOSANGELES", "US-CA-DIST-123")
    candidates: int = 0
    source: str = ""                        # the resolver / data source
    dataset_version: Optional[str] = None   # the dataset this answer came from, when the resolver says


class AddressResolver(ABC):
    name: str
    #: The resolver's current dataset version, when it reports one. A stored
    #: resolution on another version is stale.
    dataset_version: Optional[str] = None

    @abstractmethod
    def resolve(self, address: dict) -> Resolution:
        """`address`: line1, line2, city, subdivision_code, postal_code, country_code."""


#: name -> AddressResolver. Empty in production until procured (4d).
ADDRESS_RESOLVERS: dict = {}


def default_resolver() -> Optional[AddressResolver]:
    return next(iter(ADDRESS_RESOLVERS.values()), None)


def resolve_address(db: Session, organization_id: int, actor_id: Optional[int], address_id: int,
                    resolver: Optional[AddressResolver] = None, customer_id: Optional[int] = None):
    """Resolve a recorded buyer tax address and keep the result as evidence."""
    from app.modules.tax.models import CustomerTaxAddress, TaxAddressResolution

    address = db.query(CustomerTaxAddress).filter(CustomerTaxAddress.id == address_id,
                                                  CustomerTaxAddress.organization_id == organization_id).first()
    if address is None or (customer_id is not None and address.customer_id != customer_id):
        from app.core.exceptions import NotFoundException

        raise NotFoundException("Tax address", address_id)
    resolver = resolver or default_resolver()
    if resolver is None:
        raise BadRequestException("No address resolver is available yet.")
    if not (address.line1 or "").strip():
        raise BadRequestException("A street line is required: a postal code alone never resolves a jurisdiction.")
    result = resolver.resolve({"line1": address.line1, "line2": address.line2, "city": address.city,
                               "subdivision_code": address.subdivision_code, "postal_code": address.postal_code,
                               "country_code": address.country_code})
    status = result.status
    if status == ResolutionStatus.RESOLVED and (result.candidates > 1 or result.precision not in ACCEPTED_PRECISIONS):
        status = ResolutionStatus.AMBIGUOUS                        # not precise enough to pick one district
    row = TaxAddressResolution(
        organization_id=organization_id, address_id=address.id, resolver_name=resolver.name,
        source=result.source or resolver.name, dataset_version=result.dataset_version or resolver.dataset_version,
        status=status.name,
        precision=result.precision.name if result.precision else None, candidates=result.candidates,
        jurisdiction_codes=list(result.jurisdiction_codes) if status == ResolutionStatus.RESOLVED else [],
        resolved_by=actor_id, resolved_at=datetime.now(timezone.utc))
    db.add(row)
    db.flush()
    from app.modules.billing.models import BillingAuditAction
    from app.modules.billing.services.audit_service import BillingAuditService

    BillingAuditService(db).log_no_commit(organization_id, actor_id, BillingAuditAction.CREATE, "TaxAddressResolution",
                                          row.id, new_values={"address_id": address.id, "status": row.status,
                                                              "precision": row.precision,
                                                              "resolver": row.resolver_name})
    db.commit()
    return row


def latest_resolution(db: Session, organization_id: int, address_id: int):
    from app.modules.tax.models import TaxAddressResolution

    return db.query(TaxAddressResolution).filter(
        TaxAddressResolution.organization_id == organization_id,
        TaxAddressResolution.address_id == address_id).order_by(TaxAddressResolution.id.desc()).first()


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)


def valid_until(r) -> datetime:
    from app.config import settings

    return _aware(r.resolved_at) + timedelta(days=settings.TAX_ADDRESS_RESOLUTION_VALID_DAYS)


def resolution_staleness(r, now: datetime) -> Optional[str]:
    """Why a resolution can no longer be used, or None: past its validity
    window, or made on a dataset the resolver has since replaced."""
    until = valid_until(r)
    if _aware(now) >= until:
        return f"expired on {until.date().isoformat()}"
    resolver = ADDRESS_RESOLVERS.get(r.resolver_name)
    current = getattr(resolver, "dataset_version", None) if resolver is not None else None
    if current is not None and r.dataset_version != current:
        return f"dataset {r.dataset_version or 'unknown'} superseded by {current}"
    return None


def view_resolution(r) -> dict:
    return {"id": r.id, "address_id": r.address_id, "resolver": r.resolver_name, "source": r.source,
            "dataset_version": r.dataset_version, "status": r.status, "precision": r.precision,
            "candidates": r.candidates, "jurisdiction_codes": r.jurisdiction_codes, "resolved_at": r.resolved_at,
            "valid_until": valid_until(r)}


# ── manual resolution (Phase 4d): two people and an evidence document ───

class ManualResolutionService:
    """For an address the resolver could not place precisely (its latest
    resolution is AMBIGUOUS or NOT_FOUND): a billing admin proposes the
    districts with a reason and attaches an evidence document; a different
    finance approver approves. Approval writes a RESOLVED resolution with
    precision MANUAL (source ``manual:<request id>``). Nothing is ever
    resolved by one person or without evidence."""

    def __init__(self, db: Session):
        self.db = db

    def _audit(self, organization_id, actor_id, action, row_id, **values):
        from app.modules.billing.services.audit_service import BillingAuditService

        BillingAuditService(self.db).log_no_commit(organization_id, actor_id, action, "TaxManualResolutionRequest",
                                                   row_id, new_values=values or None)

    def get(self, organization_id: int, request_id: int):
        from app.core.exceptions import NotFoundException
        from app.modules.tax.models import TaxManualResolutionRequest

        row = self.db.query(TaxManualResolutionRequest).filter(
            TaxManualResolutionRequest.id == request_id,
            TaxManualResolutionRequest.organization_id == organization_id).first()
        if row is None:
            raise NotFoundException("Manual resolution", request_id)
        return row

    def list(self, organization_id: int, address_id: Optional[int] = None) -> list:
        from app.modules.tax.models import TaxManualResolutionRequest

        q = self.db.query(TaxManualResolutionRequest).filter(
            TaxManualResolutionRequest.organization_id == organization_id)
        if address_id is not None:
            q = q.filter(TaxManualResolutionRequest.address_id == address_id)
        return q.order_by(TaxManualResolutionRequest.id).all()

    def _address(self, organization_id: int, address_id: int, customer_id: Optional[int] = None):
        from app.core.exceptions import NotFoundException
        from app.modules.tax.models import CustomerTaxAddress

        address = self.db.query(CustomerTaxAddress).filter(CustomerTaxAddress.id == address_id,
                                                           CustomerTaxAddress.organization_id == organization_id).first()
        if address is None or (customer_id is not None and address.customer_id != customer_id):
            raise NotFoundException("Tax address", address_id)
        return address

    def _check_codes(self, address, codes: list) -> list:
        from app.modules.tax.registry_models import TaxJurisdiction

        codes = [str(c).strip().upper() for c in codes or [] if str(c).strip()]
        if not codes or len(codes) != len(set(codes)):
            raise BadRequestException("List each jurisdiction code once, starting with the country.")
        if codes[0] != address.country_code:
            raise BadRequestException(f"The first jurisdiction must be the address country, {address.country_code}.")
        state = f"{address.country_code}-{address.subdivision_code}" if address.subdivision_code else None
        if state and state not in codes:
            raise BadRequestException(f"The districts must include the address state, {state}.")
        found = {j.code: j for j in self.db.query(TaxJurisdiction).filter(TaxJurisdiction.code.in_(codes))}
        missing = [c for c in codes if c not in found]
        if missing:
            raise BadRequestException("Not in the tax reference registry: " + ", ".join(missing))
        if any(found[c].country_code != address.country_code for c in codes):
            raise BadRequestException("Every jurisdiction must be in the address country.")
        return codes

    def propose(self, organization_id: int, actor_id: int, customer_id: int, address_id: int, *,
                jurisdiction_codes: list, reason: str):
        from app.modules.billing.models import BillingAuditAction
        from app.modules.tax.enums import TenantApprovalStatus
        from app.modules.tax.models import TaxManualResolutionRequest

        address = self._address(organization_id, address_id, customer_id)
        if address.superseded_at is not None:
            raise BadRequestException("This address has been replaced; resolve the current one.")
        if address.country_code not in ADDRESS_RESOLUTION_COUNTRIES:
            raise BadRequestException("Manual resolution applies only to resolved-address countries.")
        latest = latest_resolution(self.db, organization_id, address.id)
        if latest is None or latest.status == ResolutionStatus.RESOLVED.name:
            raise BadRequestException("Manual resolution is only for an address the resolver could not place "
                                      "precisely: resolve it first.")
        if not (reason or "").strip():
            raise BadRequestException("A reason is required.")
        codes = self._check_codes(address, jurisdiction_codes)
        open_row = self.db.query(TaxManualResolutionRequest).filter(
            TaxManualResolutionRequest.address_id == address.id,
            TaxManualResolutionRequest.status == TenantApprovalStatus.PROPOSED).first()
        if open_row is not None:
            raise BadRequestException(f"Manual resolution {open_row.id} is already awaiting a decision.")
        row = TaxManualResolutionRequest(organization_id=organization_id, address_id=address.id,
                                         jurisdiction_codes=codes, reason=reason.strip(),
                                         status=TenantApprovalStatus.PROPOSED, proposed_by=actor_id,
                                         created_at=datetime.now(timezone.utc))
        self.db.add(row)
        self.db.flush()
        self._audit(organization_id, actor_id, BillingAuditAction.CREATE, row.id, address_id=address.id,
                    jurisdiction_codes=codes, after_resolution=latest.id)
        self.db.commit()
        return row

    def attach_evidence(self, organization_id: int, actor_id: int, request_id: int, *, content: bytes,
                        media_type: str, filename: Optional[str] = None, expected_sha256: Optional[str] = None):
        from app.modules.billing.models import BillingAuditAction
        from app.modules.tax.buyer_evidence_service import store_evidence_file
        from app.modules.tax.enums import TenantApprovalStatus

        row = self.get(organization_id, request_id)
        if row.status != TenantApprovalStatus.PROPOSED:
            raise BadRequestException(f"Manual resolution {row.id} is {row.status.name}, not PROPOSED.")
        if row.evidence_file_id is not None:
            raise BadRequestException("This manual resolution already has its evidence document; it is write-once.")
        stored = store_evidence_file(self.db, organization_id, actor_id, content=content, media_type=media_type,
                                     filename=filename, expected_sha256=expected_sha256)
        row.evidence_file_id = stored.id
        self.db.flush()
        self._audit(organization_id, actor_id, BillingAuditAction.UPDATE, row.id, evidence_sha256=stored.sha256)
        self.db.commit()
        return row

    def evidence(self, organization_id: int, request_id: int):
        from app.core.exceptions import NotFoundException
        from app.modules.tax.models import TaxEvidenceFile

        row = self.get(organization_id, request_id)
        stored = self.db.get(TaxEvidenceFile, row.evidence_file_id) if row.evidence_file_id else None
        if stored is None or stored.organization_id != organization_id:
            raise NotFoundException("Manual resolution evidence", request_id)
        return stored

    def decide(self, organization_id: int, actor_id: int, request_id: int, *, approve: bool,
               reason: Optional[str] = None):
        from app.core.exceptions import ForbiddenException
        from app.modules.billing.models import BillingAuditAction
        from app.modules.tax.enums import TenantApprovalStatus
        from app.modules.tax.models import TaxAddressResolution

        row = self.get(organization_id, request_id)
        if row.status != TenantApprovalStatus.PROPOSED:
            raise BadRequestException(f"Manual resolution {row.id} is {row.status.name}, not PROPOSED.")
        if row.proposed_by is not None and row.proposed_by == actor_id:
            raise ForbiddenException("You proposed this resolution; a different user must approve or reject it.")
        now = datetime.now(timezone.utc)
        if approve:
            if row.evidence_file_id is None:
                raise BadRequestException("Attach the evidence document before approving.")
            address = self._address(organization_id, row.address_id)
            if address.superseded_at is not None:
                raise BadRequestException("The address has been replaced since this proposal; propose again.")
            self._check_codes(address, row.jurisdiction_codes)          # the registry may have changed
            resolution = TaxAddressResolution(
                organization_id=organization_id, address_id=address.id, resolver_name=MANUAL_RESOLVER,
                source=f"manual:{row.id}", dataset_version=None, status=ResolutionStatus.RESOLVED.name,
                precision=ResolutionPrecision.MANUAL.name, candidates=1,
                jurisdiction_codes=list(row.jurisdiction_codes), resolved_by=actor_id, resolved_at=now)
            self.db.add(resolution)
            self.db.flush()
            row.resolution_id = resolution.id
        row.status = TenantApprovalStatus.APPROVED if approve else TenantApprovalStatus.REJECTED
        row.approved_by, row.approved_at, row.decision_reason = actor_id, now, reason
        self.db.flush()
        self._audit(organization_id, actor_id, BillingAuditAction.APPROVE if approve else BillingAuditAction.REJECT,
                    row.id, status=row.status.name, resolution_id=row.resolution_id)
        self.db.commit()
        return row

    def withdraw(self, organization_id: int, actor_id: int, request_id: int):
        from app.modules.billing.models import BillingAuditAction
        from app.modules.tax.enums import TenantApprovalStatus

        row = self.get(organization_id, request_id)
        if row.status != TenantApprovalStatus.PROPOSED:
            raise BadRequestException(f"Manual resolution {row.id} is {row.status.name}, not PROPOSED.")
        row.status = TenantApprovalStatus.WITHDRAWN
        self.db.flush()
        self._audit(organization_id, actor_id, BillingAuditAction.CANCEL, row.id)
        self.db.commit()
        return row


def view_manual_resolution(r) -> dict:
    return {"id": r.id, "address_id": r.address_id, "jurisdiction_codes": r.jurisdiction_codes, "reason": r.reason,
            "evidence_attached": r.evidence_file_id is not None, "status": r.status.name,
            "proposed_by": r.proposed_by, "approved_by": r.approved_by, "approved_at": r.approved_at,
            "decision_reason": r.decision_reason, "resolution_id": r.resolution_id, "created_at": r.created_at}
