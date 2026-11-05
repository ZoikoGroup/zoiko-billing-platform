"""
app/modules/tax/buyer_evidence_service.py
-----------------------------------------
Buyer tax evidence (ZB-TAX-ARCH-001 Phase 2, §07 BuyerTaxEvidence, §08.1
step 3): structured addresses, tax identifiers with verification state, and
exemption certificates. Purely additive: the free-text fields on
billing_customers are never modified.

Rules:
  * A tax ID's raw value is stored exactly as given; value_normalized only
    strips whitespace and upper-cases (for matching). Nothing is reformatted.
  * VERIFIED requires the verification method and response to be recorded;
    an UNVERIFIED tax ID is never evidence of business status (T08).
  * Evidence is append-only: a new address supersedes the previous one; a
    tax ID or certificate is retired/revoked, not edited.
"""
import re
from datetime import date, datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session

from app.core.exceptions import BadRequestException, NotFoundException
from app.modules.billing.models import BillingAuditAction, BillingCustomer
from app.modules.billing.services.audit_service import BillingAuditService
from app.modules.tax.enums import (
    AddressConfidence,
    AddressRole,
    CertificateStatus,
    EvidenceSource,
    VerificationStatus,
)
from app.modules.tax.models import CustomerExemptionCertificate, CustomerTaxAddress, CustomerTaxId
from app.modules.tax.registry_models import TaxJurisdiction, TaxTypeDefinition

_ISO2 = re.compile(r"^[A-Z]{2}$")
_SUBDIVISION = re.compile(r"^[A-Z0-9]{1,3}$")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def normalize_tax_id(value: str) -> str:
    """Matching key only: drop whitespace, upper-case. Never shown as the value."""
    return re.sub(r"\s+", "", value or "").upper()


class BuyerEvidenceService:
    def __init__(self, db: Session):
        self.db = db
        self.audit = BillingAuditService(db)

    def _customer(self, customer_id: int, organization_id: int) -> BillingCustomer:
        customer = self.db.query(BillingCustomer).filter(
            BillingCustomer.id == customer_id, BillingCustomer.organization_id == organization_id,
        ).first()
        if customer is None:
            raise NotFoundException("Customer", customer_id)
        return customer

    def _get(self, model, record_id: int, organization_id: int, label: str):
        row = self.db.query(model).filter(model.id == record_id, model.organization_id == organization_id).first()
        if row is None:
            raise NotFoundException(label, record_id)
        return row

    def _log(self, organization_id, actor_id, action, entity_type, entity_id, **kw):
        self.audit.log_no_commit(organization_id, actor_id, action, entity_type, entity_id, **kw)

    # ── reads ──
    def evidence(self, organization_id: int, customer_id: int, include_history: bool = False) -> dict:
        self._customer(customer_id, organization_id)

        def q(model):
            query = self.db.query(model).filter(model.organization_id == organization_id,
                                                model.customer_id == customer_id)
            if not include_history and hasattr(model, "superseded_at"):
                query = query.filter(model.superseded_at.is_(None))
            return query.order_by(model.id).all()

        return {
            "customer_id": customer_id,
            "addresses": [view_address(a) for a in q(CustomerTaxAddress)],
            "tax_ids": [view_tax_id(t) for t in q(CustomerTaxId)],
            "exemption_certificates": [view_certificate(c) for c in q(CustomerExemptionCertificate)],
        }

    # ── addresses ──
    def record_address(self, organization_id: int, actor_id: int, customer_id: int, *, role: AddressRole,
                       country_code: Optional[str], subdivision_code: Optional[str] = None,
                       postal_code: Optional[str] = None, city: Optional[str] = None,
                       line1: Optional[str] = None, line2: Optional[str] = None,
                       confidence: AddressConfidence = AddressConfidence.ENTERED) -> CustomerTaxAddress:
        self._customer(customer_id, organization_id)
        country = (country_code or "").strip().upper() or None
        subdivision = (subdivision_code or "").strip().upper() or None
        if country is not None and not _ISO2.match(country):
            raise BadRequestException("country_code must be an ISO 3166-1 alpha-2 code.")
        if subdivision is not None and (country is None or not _SUBDIVISION.match(subdivision)):
            raise BadRequestException("subdivision_code must be an ISO 3166-2 suffix and needs a country_code.")
        if confidence == AddressConfidence.DERIVED:
            raise BadRequestException("DERIVED is reserved for the legacy backfill.")
        now = _now()
        current = self.db.query(CustomerTaxAddress).filter(
            CustomerTaxAddress.organization_id == organization_id, CustomerTaxAddress.customer_id == customer_id,
            CustomerTaxAddress.role == role, CustomerTaxAddress.superseded_at.is_(None),
        ).first()
        if current is not None:
            current.superseded_at = now
            self.db.flush()
        row = CustomerTaxAddress(
            organization_id=organization_id, customer_id=customer_id, role=role, country_code=country,
            subdivision_code=subdivision, postal_code=(postal_code or "").strip() or None,
            city=(city or "").strip() or None, line1=(line1 or "").strip() or None,
            line2=(line2 or "").strip() or None, confidence=confidence, source=EvidenceSource.TENANT_ENTERED,
            validated_at=now if confidence == AddressConfidence.VALIDATED else None,
            created_by=actor_id, created_at=now,
        )
        self.db.add(row)
        self.db.flush()
        self._log(organization_id, actor_id, BillingAuditAction.CREATE, "CustomerTaxAddress", row.id,
                  new_values={"role": role.name, "country_code": country, "subdivision_code": subdivision})
        self.db.commit()
        return row

    # ── tax IDs ──
    def add_tax_id(self, organization_id: int, actor_id: int, customer_id: int, *, value: str,
                   id_type: Optional[str] = None, country_code: Optional[str] = None) -> CustomerTaxId:
        self._customer(customer_id, organization_id)
        if not (value or "").strip():
            raise BadRequestException("A tax ID value is required.")
        country = (country_code or "").strip().upper() or None
        if country is not None and not _ISO2.match(country):
            raise BadRequestException("country_code must be an ISO 3166-1 alpha-2 code.")
        row = CustomerTaxId(
            organization_id=organization_id, customer_id=customer_id, value_raw=value,
            value_normalized=normalize_tax_id(value), id_type=id_type, country_code=country,
            source=EvidenceSource.TENANT_ENTERED, verification_status=VerificationStatus.UNVERIFIED,
            created_by=actor_id, created_at=_now(),
        )
        self.db.add(row)
        self.db.flush()
        self._log(organization_id, actor_id, BillingAuditAction.CREATE, "CustomerTaxId", row.id)
        self.db.commit()
        return row

    def record_verification(self, organization_id: int, actor_id: int, tax_id_id: int, *,
                            status: VerificationStatus, method: str, response: Optional[dict],
                            verified_at: Optional[datetime] = None,
                            expires_at: Optional[datetime] = None) -> CustomerTaxId:
        row = self._get(CustomerTaxId, tax_id_id, organization_id, "Customer tax ID")
        if row.superseded_at is not None:
            raise BadRequestException("This tax ID has been retired; add the current one instead.")
        if status == VerificationStatus.UNVERIFIED:
            raise BadRequestException("Record VERIFIED or INVALID, with the verification response.")
        if not (method or "").strip() or not response:
            raise BadRequestException("A verification needs the method and the verification response.")
        row.verification_status = status
        row.verification_method = method.strip()
        row.verification_response = response
        row.verified_at = verified_at or _now()
        row.expires_at = expires_at
        self.db.flush()
        self._log(organization_id, actor_id, BillingAuditAction.UPDATE, "CustomerTaxId", row.id,
                  new_values={"verification_status": status.name, "method": row.verification_method})
        self.db.commit()
        return row

    def retire_tax_id(self, organization_id: int, actor_id: int, tax_id_id: int) -> CustomerTaxId:
        row = self._get(CustomerTaxId, tax_id_id, organization_id, "Customer tax ID")
        if row.superseded_at is None:
            row.superseded_at = _now()
            self.db.flush()
            self._log(organization_id, actor_id, BillingAuditAction.UPDATE, "CustomerTaxId", row.id,
                      new_values={"retired": True})
            self.db.commit()
        return row

    # ── exemption certificates ──
    def add_certificate(self, organization_id: int, actor_id: int, customer_id: int, *, certificate_number: str,
                        jurisdiction_id: int, scope_description: str, valid_from: date, evidence_ref: str,
                        tax_type_id: Optional[int] = None,
                        expires_at: Optional[date] = None) -> CustomerExemptionCertificate:
        self._customer(customer_id, organization_id)
        if self.db.get(TaxJurisdiction, jurisdiction_id) is None:
            raise BadRequestException(f"Jurisdiction {jurisdiction_id} is not in the tax reference registry.")
        if tax_type_id is not None and self.db.get(TaxTypeDefinition, tax_type_id) is None:
            raise BadRequestException(f"Tax type {tax_type_id} is not in the tax reference registry.")
        if not (certificate_number or "").strip() or not (scope_description or "").strip() \
                or not (evidence_ref or "").strip():
            raise BadRequestException("A certificate needs its number, scope and an evidence reference.")
        if expires_at is not None and expires_at <= valid_from:
            raise BadRequestException("expires_at must be after valid_from.")
        row = CustomerExemptionCertificate(
            organization_id=organization_id, customer_id=customer_id, certificate_number=certificate_number.strip(),
            jurisdiction_id=jurisdiction_id, tax_type_id=tax_type_id, scope_description=scope_description.strip(),
            valid_from=valid_from, expires_at=expires_at, evidence_ref=evidence_ref.strip(),
            status=CertificateStatus.ACTIVE, created_by=actor_id, created_at=_now(),
        )
        self.db.add(row)
        self.db.flush()
        self._log(organization_id, actor_id, BillingAuditAction.CREATE, "CustomerExemptionCertificate", row.id)
        self.db.commit()
        return row

    def revoke_certificate(self, organization_id: int, actor_id: int, certificate_id: int) -> CustomerExemptionCertificate:
        row = self._get(CustomerExemptionCertificate, certificate_id, organization_id, "Exemption certificate")
        if row.status == CertificateStatus.ACTIVE:
            row.status = CertificateStatus.REVOKED
            row.revoked_by = actor_id
            row.revoked_at = _now()
            self.db.flush()
            self._log(organization_id, actor_id, BillingAuditAction.VOID, "CustomerExemptionCertificate", row.id)
            self.db.commit()
        return row


def view_address(a: CustomerTaxAddress) -> dict:
    return {"id": a.id, "role": a.role.name, "country_code": a.country_code, "subdivision_code": a.subdivision_code,
            "postal_code": a.postal_code, "city": a.city, "line1": a.line1, "line2": a.line2,
            "confidence": a.confidence.name, "source": a.source.name,
            "source_field": a.source_field, "validated_at": a.validated_at, "created_at": a.created_at,
            "superseded_at": a.superseded_at}


def view_tax_id(t: CustomerTaxId) -> dict:
    return {"id": t.id, "value": t.value_raw, "value_normalized": t.value_normalized, "id_type": t.id_type,
            "country_code": t.country_code, "source": t.source.name, "source_field": t.source_field,
            "verification_status": t.verification_status.name, "verification_method": t.verification_method,
            "verification_response": t.verification_response, "verified_at": t.verified_at,
            "expires_at": t.expires_at, "created_at": t.created_at, "superseded_at": t.superseded_at}


def view_certificate(c: CustomerExemptionCertificate) -> dict:
    return {"id": c.id, "certificate_number": c.certificate_number, "jurisdiction_id": c.jurisdiction_id,
            "tax_type_id": c.tax_type_id, "scope_description": c.scope_description, "valid_from": c.valid_from,
            "expires_at": c.expires_at, "evidence_ref": c.evidence_ref, "status": c.status.name,
            "created_at": c.created_at, "revoked_at": c.revoked_at}
