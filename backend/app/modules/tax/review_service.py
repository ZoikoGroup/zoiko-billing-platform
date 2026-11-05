"""
app/modules/tax/review_service.py
---------------------------------
T14: flag expiring and expired tax evidence for tenant review
(ZB-TAX-ARCH-001 Phase 2).

The sweep looks at seller registrations, buyer exemption certificates and
buyer tax-ID verifications, and writes tenant-private ``tax_review_items``
(one OPEN item per subject and kind). When something that was "expiring"
has now expired, the EXPIRING item is resolved and an EXPIRED item opened.

This only raises review items. Expiry itself takes effect at use time
regardless (TenantTaxService.effective_state, the context builder), so a
late or failed sweep never lets expired evidence count.
"""
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from sqlalchemy.orm import Session

from app.core.exceptions import NotFoundException
from app.modules.tax.enums import (
    CertificateStatus,
    RegistrationStatus,
    ReviewItemKind,
    ReviewItemStatus,
    VerificationStatus,
)
from app.modules.tax.models import (
    CustomerExemptionCertificate,
    CustomerTaxId,
    EntityTaxRegistration,
    TaxReviewItem,
)

# kind pairs: (expiring, expired)
_KINDS = {
    "EntityTaxRegistration": (ReviewItemKind.REGISTRATION_EXPIRING, ReviewItemKind.REGISTRATION_EXPIRED),
    "CustomerExemptionCertificate": (ReviewItemKind.CERTIFICATE_EXPIRING, ReviewItemKind.CERTIFICATE_EXPIRED),
    "CustomerTaxId": (None, ReviewItemKind.TAX_ID_VERIFICATION_EXPIRED),
    "TaxAddressResolution": (None, ReviewItemKind.ADDRESS_RESOLUTION_STALE),
}


class TaxReviewService:
    def __init__(self, db: Session):
        self.db = db

    def _open(self, organization_id: int, kind: ReviewItemKind, subject_type: str, subject_id: int):
        return self.db.query(TaxReviewItem).filter(
            TaxReviewItem.organization_id == organization_id, TaxReviewItem.kind == kind,
            TaxReviewItem.subject_type == subject_type, TaxReviewItem.subject_id == subject_id,
            TaxReviewItem.status == ReviewItemStatus.OPEN,
        ).first()

    def _raise(self, now, organization_id, subject_type, subject_id, due: Optional[date], expired: bool, detail: str):
        expiring_kind, expired_kind = _KINDS[subject_type]
        kind = expired_kind if expired else expiring_kind
        if expired and expiring_kind is not None:
            earlier = self._open(organization_id, expiring_kind, subject_type, subject_id)
            if earlier is not None:
                earlier.status = ReviewItemStatus.RESOLVED
                earlier.resolved_at = now
        if self._open(organization_id, kind, subject_type, subject_id) is not None:
            return 0
        self.db.add(TaxReviewItem(organization_id=organization_id, kind=kind, subject_type=subject_type,
                                  subject_id=subject_id, due_date=due, detail=detail, created_at=now))
        self.db.flush()
        return 1

    def sweep(self, now: Optional[datetime] = None, window_days: int = 30) -> int:
        """Create review items across every organization; returns how many
        were created. Flushes only — the caller commits."""
        now = now or datetime.now(timezone.utc)
        today = now.date()
        horizon = today + timedelta(days=window_days)
        created = 0

        for r in self.db.query(EntityTaxRegistration).filter(
            EntityTaxRegistration.status == RegistrationStatus.ACTIVE,
            EntityTaxRegistration.valid_to.isnot(None), EntityTaxRegistration.valid_to <= horizon,
        ):
            expired = r.valid_to <= today
            created += self._raise(now, r.organization_id, "EntityTaxRegistration", r.id, r.valid_to, expired,
                                   f"Registration {r.registration_number} "
                                   f"{'ended' if expired else 'ends'} on {r.valid_to.isoformat()}.")

        for c in self.db.query(CustomerExemptionCertificate).filter(
            CustomerExemptionCertificate.status == CertificateStatus.ACTIVE,
            CustomerExemptionCertificate.expires_at.isnot(None), CustomerExemptionCertificate.expires_at <= horizon,
        ):
            expired = c.expires_at <= today
            created += self._raise(now, c.organization_id, "CustomerExemptionCertificate", c.id, c.expires_at, expired,
                                   f"Exemption certificate {c.certificate_number} for customer {c.customer_id} "
                                   f"{'expired' if expired else 'expires'} on {c.expires_at.isoformat()}.")

        for t in self.db.query(CustomerTaxId).filter(
            CustomerTaxId.verification_status == VerificationStatus.VERIFIED,
            CustomerTaxId.superseded_at.is_(None), CustomerTaxId.expires_at.isnot(None),
        ):
            expires = t.expires_at if t.expires_at.tzinfo else t.expires_at.replace(tzinfo=timezone.utc)
            if expires <= now:
                created += self._raise(now, t.organization_id, "CustomerTaxId", t.id, expires.date(), True,
                                       f"Verification of tax ID {t.id} for customer {t.customer_id} has expired.")
        return created

    # ── tenant API ──
    def list_items(self, organization_id: int, status: Optional[ReviewItemStatus] = ReviewItemStatus.OPEN):
        q = self.db.query(TaxReviewItem).filter(TaxReviewItem.organization_id == organization_id)
        if status is not None:
            q = q.filter(TaxReviewItem.status == status)
        return q.order_by(TaxReviewItem.due_date, TaxReviewItem.id).all()

    def resolve(self, organization_id: int, actor_id: int, item_id: int) -> TaxReviewItem:
        item = self.db.query(TaxReviewItem).filter(TaxReviewItem.id == item_id,
                                                   TaxReviewItem.organization_id == organization_id).first()
        if item is None:
            raise NotFoundException("Tax review item", item_id)
        if item.status == ReviewItemStatus.OPEN:
            item.status = ReviewItemStatus.RESOLVED
            item.resolved_at = datetime.now(timezone.utc)
            item.resolved_by = actor_id
            self.db.commit()
        return item


def view_review_item(i: TaxReviewItem) -> dict:
    return {"id": i.id, "kind": i.kind.name, "subject_type": i.subject_type, "subject_id": i.subject_id,
            "due_date": i.due_date, "detail": i.detail, "status": i.status.name, "created_at": i.created_at,
            "resolved_at": i.resolved_at, "resolved_by": i.resolved_by}
