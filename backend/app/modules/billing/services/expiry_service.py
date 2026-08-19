import logging
from datetime import date
from typing import Dict, Optional

from sqlalchemy.orm import Session

from app.config import settings
from app.modules.billing.models import (
    BillingAuditAction,
    BillingSubscriptionStatus,
    Contract,
    ContractStatus,
    Subscription,
)
from app.modules.billing.services.audit_service import BillingAuditService
from app.modules.billing.services.base import safe_commit_and_refresh

logger = logging.getLogger("zoiko_billing")


class ExpiryEngine:
    """
    Enterprise Expiry Engine for Contracts and Subscriptions.
    Runs asynchronously via background maintenance / background tasks / explicit triggers.
    Data-fetching endpoints (GET) remain strictly read-only and never call this engine directly.
    """

    def __init__(self, db: Session):
        self.db = db
        self.audit = BillingAuditService(db)

    def is_enabled(self) -> bool:
        return getattr(settings, "BILLING_AUTO_EXPIRY_ENABLED", True)

    def process_expired_contracts(self, organization_id: Optional[int] = None) -> int:
        """
        Transition active contracts with end_date < today to EXPIRED status.
        Does NOT alter TERMINATED, CANCELLED, or DRAFT contracts.
        """
        if not self.is_enabled():
            logger.info("[ExpiryEngine] Auto-expiry is disabled via configuration.")
            return 0

        query = self.db.query(Contract).filter(
            Contract.status == ContractStatus.ACTIVE,
            Contract.end_date.isnot(None),
            Contract.end_date < date.today(),
        )
        if organization_id is not None:
            query = query.filter(Contract.organization_id == organization_id)

        expired_contracts = query.all()
        count = 0
        for contract in expired_contracts:
            contract.status = ContractStatus.EXPIRED
            count += 1
            try:
                self.audit.log(
                    organization_id=contract.organization_id,
                    user_id=1,  # System background process
                    action=BillingAuditAction.UPDATE,
                    entity_name="Contract",
                    entity_id=contract.id,
                    new_values={"status": ContractStatus.EXPIRED.value, "reason": "Automatic end_date expiry"},
                )
            except Exception as e:
                logger.warning(f"[ExpiryEngine] Failed to audit contract {contract.id} expiry: {e}")

        if count > 0:
            self.db.commit()
            logger.info(f"[ExpiryEngine] Auto-expired {count} contracts.")
        return count

    def process_expired_subscriptions(self, organization_id: Optional[int] = None) -> int:
        """
        Transition active subscriptions with current_term_end < today to EXPIRED status.
        Does NOT alter PAUSED, CANCELLED, or DRAFT subscriptions.
        """
        if not self.is_enabled():
            logger.info("[ExpiryEngine] Auto-expiry is disabled via configuration.")
            return 0

        query = self.db.query(Subscription).filter(
            Subscription.status == BillingSubscriptionStatus.ACTIVE,
            Subscription.current_term_end.isnot(None),
            Subscription.current_term_end < date.today(),
        )
        if organization_id is not None:
            query = query.filter(Subscription.organization_id == organization_id)

        expired_subs = query.all()
        count = 0
        for sub in expired_subs:
            sub.status = BillingSubscriptionStatus.EXPIRED
            count += 1
            try:
                self.audit.log(
                    organization_id=sub.organization_id,
                    user_id=1,  # System background process
                    action=BillingAuditAction.UPDATE,
                    entity_name="Subscription",
                    entity_id=sub.id,
                    new_values={"status": BillingSubscriptionStatus.EXPIRED.value, "reason": "Automatic term end expiry"},
                )
            except Exception as e:
                logger.warning(f"[ExpiryEngine] Failed to audit subscription {sub.id} expiry: {e}")

        if count > 0:
            self.db.commit()
            logger.info(f"[ExpiryEngine] Auto-expired {count} subscriptions.")
        return count

    def run_all(self, organization_id: Optional[int] = None) -> Dict[str, int]:
        contracts_expired = self.process_expired_contracts(organization_id)
        subs_expired = self.process_expired_subscriptions(organization_id)
        return {
            "contracts_expired": contracts_expired,
            "subscriptions_expired": subs_expired,
        }
