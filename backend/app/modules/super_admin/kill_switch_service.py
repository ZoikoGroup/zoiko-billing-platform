"""
modules/super_admin/kill_switch_service.py
----------------------------------------------
Narrow, real billing kill switch (ZB-COM-BILL-001 §30.1).

Scoped to the ONE live commercial-charging code path that actually exists in
this codebase — CommercialSubscriptionService creating/activating a
subscription. This does NOT claim to gate a tenant payment webhook or a
Plane-1 payment processor, because neither exists yet.

Disabling the switch stops NEW charging state (subscription creation /
activation); it never mutates, cancels, or deletes existing subscriptions,
and read access is unaffected — matching the standard's explicit
"without deleting data or disabling read access" requirement.
"""

import logging
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from app.modules.super_admin.models import BillingKillSwitch

logger = logging.getLogger("zoiko_billing.super_admin.kill_switch")

COMMERCIAL_SUBSCRIPTION_CHARGING = "commercial_subscription_charging"


class BillingBlockedError(ValueError):
    """Raised when a charging action is attempted while its kill switch is off."""


class BillingKillSwitchService:
    def __init__(self, db: Session):
        self.db = db

    def ensure_switch(self, scope: str) -> BillingKillSwitch:
        """Idempotent get-or-create. Defaults to enabled=True so behavior is
        unchanged until a Super Admin explicitly disables it — flipping a
        switch off must always be an explicit, audited action, never an
        implicit side effect of this table not having a row yet."""
        existing = self.db.query(BillingKillSwitch).filter(BillingKillSwitch.scope == scope).first()
        if existing:
            return existing
        switch = BillingKillSwitch(scope=scope, enabled=True)
        self.db.add(switch)
        self.db.flush()
        return switch

    def is_enabled(self, scope: str) -> bool:
        switch = self.db.query(BillingKillSwitch).filter(BillingKillSwitch.scope == scope).first()
        if switch is None:
            return True  # no row yet == never explicitly disabled
        return switch.enabled

    def require_enabled(self, scope: str) -> None:
        if not self.is_enabled(scope):
            raise BillingBlockedError(
                f"Billing kill switch '{scope}' is currently disabled by a Super Admin. "
                "New charging actions are blocked until it is re-enabled."
            )

    def set_enabled(self, scope: str, enabled: bool, *, reason: str, actor_id: Optional[int]) -> BillingKillSwitch:
        switch = self.ensure_switch(scope)
        switch.enabled = enabled
        switch.reason = reason
        switch.changed_by_user_id = actor_id
        switch.changed_at = datetime.utcnow()
        self.db.flush()
        logger.warning(
            "Billing kill switch '%s' set to enabled=%s by user %s (reason: %s)",
            scope, enabled, actor_id, reason,
        )
        return switch
