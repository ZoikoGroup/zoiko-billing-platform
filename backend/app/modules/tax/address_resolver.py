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
from datetime import datetime, timezone
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


ACCEPTED_PRECISIONS = frozenset({ResolutionPrecision.ROOFTOP, ResolutionPrecision.PARCEL})


@dataclass(frozen=True)
class Resolution:
    status: ResolutionStatus
    precision: Optional[ResolutionPrecision] = None
    jurisdiction_codes: tuple = ()          # e.g. ("US", "US-CA", "US-CA-LOSANGELES", "US-CA-DIST-123")
    candidates: int = 0
    source: str = ""                        # the resolver's dataset / version


class AddressResolver(ABC):
    name: str

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
        source=result.source or resolver.name, status=status.name,
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


def view_resolution(r) -> dict:
    return {"id": r.id, "address_id": r.address_id, "resolver": r.resolver_name, "source": r.source,
            "status": r.status, "precision": r.precision, "candidates": r.candidates,
            "jurisdiction_codes": r.jurisdiction_codes, "resolved_at": r.resolved_at}
