"""
app/modules/tax/pseudonym.py
----------------------------
The pseudonymous customer reference sent to tax providers (ZB-TAX-ARCH-001
Phase 4c, plan change 9) and the guard on its key.

customer_ref = "zc_" + HMAC-SHA256(TAX_PROVIDER_PSEUDONYM_KEY, "org:customer").
The provider keys its customer (and exemption) records by that reference, so
changing the key silently orphans them. Each tenant therefore records the
fingerprint of the key its provider records were made under (never the key):

  * The first fingerprint is recorded when a provider activation is approved
    (two people) with the key set.
  * Afterwards, while the tenant has approved provider activations, a current
    fingerprint that differs from the acknowledged one (a rotated, removed or
    newly added key) blocks provider quoting and issuing:
    PROVIDER_UNAVAILABLE, "pseudonym key changed — remap required".
  * Two people acknowledge the new fingerprint (after remapping the
    provider's records; the remapping tool is deferred) to lift the block.
"""
import hashlib
import hmac
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session

from app.core.exceptions import BadRequestException, ForbiddenException, NotFoundException

KEY_CHANGED = "pseudonym key changed — remap required"


def _key() -> str:
    from app.config import settings

    return (getattr(settings, "TAX_PROVIDER_PSEUDONYM_KEY", "") or "").strip()


def key_fingerprint() -> Optional[str]:
    """A fingerprint of the current key (HMAC of a fixed label, so the key's
    hash is never stored); None when the key is unset."""
    key = _key()
    if not key:
        return None
    return hmac.new(key.encode(), b"zoiko-tax-pseudonym-key-fingerprint", hashlib.sha256).hexdigest()[:32]


def customer_pseudonym(organization_id: int, customer_id) -> Optional[str]:
    """A stable, non-reversible customer reference for the provider. None
    when the key is unset or there is no customer."""
    key = _key()
    if not key or customer_id is None:
        return None
    return "zc_" + hmac.new(key.encode(), f"{organization_id}:{customer_id}".encode(), hashlib.sha256).hexdigest()[:32]


def _now() -> datetime:
    return datetime.now(timezone.utc)


class PseudonymKeyService:
    def __init__(self, db: Session):
        self.db = db

    def _audit(self, organization_id, actor_id, action, record_id, **values):
        from app.modules.billing.services.audit_service import BillingAuditService

        BillingAuditService(self.db).log_no_commit(organization_id, actor_id, action, "TaxPseudonymKeyRecord",
                                                   record_id, new_values=values)

    def acknowledged(self, organization_id: int):
        from app.modules.tax.enums import TenantApprovalStatus
        from app.modules.tax.models import TaxPseudonymKeyRecord

        return self.db.query(TaxPseudonymKeyRecord).filter(
            TaxPseudonymKeyRecord.organization_id == organization_id,
            TaxPseudonymKeyRecord.status == TenantApprovalStatus.APPROVED,
        ).order_by(TaxPseudonymKeyRecord.id.desc()).first()

    def _has_provider_activations(self, organization_id: int) -> bool:
        from app.modules.tax.enums import TaxOperatingMode, TenantApprovalStatus
        from app.modules.tax.models import EntityTaxActivation

        return self.db.query(EntityTaxActivation.id).filter(
            EntityTaxActivation.organization_id == organization_id,
            EntityTaxActivation.mode == TaxOperatingMode.PROVIDER_APPROVED,
            EntityTaxActivation.status == TenantApprovalStatus.APPROVED,
        ).first() is not None

    def problem(self, organization_id: int) -> Optional[str]:
        """Why provider quoting/issuing is blocked by the key; None = fine."""
        if not self._has_provider_activations(organization_id):
            return None
        record = self.acknowledged(organization_id)
        current = key_fingerprint()
        if record is None and current is None:
            return None                                         # no key ever: no references were sent
        if record is None or record.fingerprint != current:
            return KEY_CHANGED
        return None

    def baseline_on_activation(self, organization_id: int, activation) -> None:
        """First provider activation approved with the key set: record its
        fingerprint, approved by the activation's two people. A later,
        different fingerprint is never recorded here (it needs remapping)."""
        from app.modules.tax.enums import TenantApprovalStatus
        from app.modules.tax.models import TaxPseudonymKeyRecord

        current = key_fingerprint()
        if current is None or self.acknowledged(organization_id) is not None:
            return
        row = TaxPseudonymKeyRecord(
            organization_id=organization_id, fingerprint=current, reason=f"baseline: activation {activation.id}",
            status=TenantApprovalStatus.APPROVED, proposed_by=activation.proposed_by,
            approved_by=activation.approved_by, approved_at=_now(), created_at=_now())
        self.db.add(row)
        self.db.flush()
        from app.modules.billing.models import BillingAuditAction

        self._audit(organization_id, activation.approved_by, BillingAuditAction.CREATE, row.id,
                    fingerprint=current, baseline=True)

    def propose(self, organization_id: int, actor_id: int, reason: str):
        """Propose acknowledging the current key (after remapping)."""
        from app.modules.billing.models import BillingAuditAction
        from app.modules.tax.enums import TenantApprovalStatus
        from app.modules.tax.models import TaxPseudonymKeyRecord

        current = key_fingerprint()
        record = self.acknowledged(organization_id)
        if record is not None and record.fingerprint == current:
            raise BadRequestException("The current pseudonym key is already acknowledged.")
        open_row = self.db.query(TaxPseudonymKeyRecord).filter(
            TaxPseudonymKeyRecord.organization_id == organization_id,
            TaxPseudonymKeyRecord.status == TenantApprovalStatus.PROPOSED).first()
        if open_row is not None:
            raise BadRequestException(f"Acknowledgement {open_row.id} is already awaiting a decision.")
        row = TaxPseudonymKeyRecord(organization_id=organization_id, fingerprint=current, reason=reason,
                                    status=TenantApprovalStatus.PROPOSED, proposed_by=actor_id, created_at=_now())
        self.db.add(row)
        self.db.flush()
        self._audit(organization_id, actor_id, BillingAuditAction.CREATE, row.id, fingerprint=current)
        self.db.commit()
        return row

    def decide(self, organization_id: int, actor_id: int, record_id: int, *, approve: bool,
               reason: Optional[str] = None):
        from app.modules.billing.models import BillingAuditAction
        from app.modules.tax.enums import TenantApprovalStatus
        from app.modules.tax.models import TaxPseudonymKeyRecord

        row = self.db.query(TaxPseudonymKeyRecord).filter(TaxPseudonymKeyRecord.id == record_id,
                                                          TaxPseudonymKeyRecord.organization_id == organization_id).first()
        if row is None:
            raise NotFoundException("Pseudonym key acknowledgement", record_id)
        if row.status != TenantApprovalStatus.PROPOSED:
            raise BadRequestException(f"Acknowledgement {row.id} is {row.status.name}, not PROPOSED.")
        if row.proposed_by is not None and row.proposed_by == actor_id:
            raise ForbiddenException("You proposed this change; a different user must approve or reject it.")
        if approve and row.fingerprint != key_fingerprint():
            raise BadRequestException("The pseudonym key changed again since this proposal; propose again.")
        row.status = TenantApprovalStatus.APPROVED if approve else TenantApprovalStatus.REJECTED
        row.approved_by, row.approved_at, row.decision_reason = actor_id, _now(), reason
        self.db.flush()
        self._audit(organization_id, actor_id, BillingAuditAction.APPROVE if approve else BillingAuditAction.REJECT,
                    row.id, status=row.status.name)
        self.db.commit()
        return row

    def list(self, organization_id: int) -> list:
        from app.modules.tax.models import TaxPseudonymKeyRecord

        return self.db.query(TaxPseudonymKeyRecord).filter(
            TaxPseudonymKeyRecord.organization_id == organization_id).order_by(TaxPseudonymKeyRecord.id).all()

    def status(self, organization_id: int) -> dict:
        record = self.acknowledged(organization_id)
        current = key_fingerprint()
        return {"key_set": current is not None, "current_fingerprint": current,
                "acknowledged_fingerprint": record.fingerprint if record else None,
                "blocked_reason": self.problem(organization_id)}


def view_key_record(r) -> dict:
    return {"id": r.id, "fingerprint": r.fingerprint, "reason": r.reason, "status": r.status.name,
            "proposed_by": r.proposed_by, "approved_by": r.approved_by, "approved_at": r.approved_at,
            "decision_reason": r.decision_reason, "created_at": r.created_at}
