"""
modules/super_admin/kill_switch_service.py
----------------------------------------------
Real, scope-generic circuit-breaker state (ZB-COM-BILL-001 §30.1 /
ZB-SA-CMD-003 §9 "Circuit breakers and safe intervention"). One
`BillingKillSwitch` row per scope; each scope is enforced at real billing
code paths — never a UI toggle with nothing behind it.

Scopes registered today (§9.2 launch catalog):
  - COMMERCIAL_SUBSCRIPTION_CHARGING (Domain A) — gates
    CommercialSubscriptionService creating/activating a subscription.
  - TENANT_INVOICE_FINALIZATION (Domain B) — gates
    InvoiceService.finalize_invoice() / mark_sent() ("Pause invoice
    finalization").
  - TENANT_PAYMENT_ATTEMPTS (Domain B) — gates platform-initiated payment
    captures: StripeService.create_payment_intent() /
    create_checkout_session() and PaymentService.record_attempt()
    ("Pause automatic payment attempts"). Deliberately NOT enforced in the
    Stripe webhook handlers — per §9.2 those are in-flight processor
    activity that "will not be canceled".
  - TENANT_DUNNING (Domain B) — gates DunningService.process_dunning() and
    process_due_reminders(), the automated retry/collection loop
    ("Suspend dunning/retries").
  - TENANT_BILLING_COMMUNICATIONS (Domain B) — gates outbound customer
    billing email sends: InvoiceService.send_invoice_via_email() and the
    dunning reminder sends ("Pause customer billing communications ... while
    preserving generated artifacts").

  Not registrable in this codebase (documented, not hidden): "Freeze
  outbound connector sync" (no ERP/accounting connector abstraction exists)
  and "Release block / change freeze" (no deployment pipeline exists here).

Auto-expiry (§9.1 "All breakers auto-expire. Permanent breaker states are
prohibited"): a pause may carry an `expires_at`. The check is lazy — every
`is_enabled()`/`require_enabled()` call re-evaluates expiry first, so an
expired pause self-lifts at the very next gated operation or state read,
exactly like PrivilegedTenantAccessGrant's lazy expiry. The lift is audited
(BREAKER_AUTO_EXPIRED) and auto-resolves the breaker's Attention item.

Disabling a switch stops the ONE gated action; it never mutates, cancels,
or deletes existing data, and read access is unaffected.
"""

import logging
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy.orm import Session

from app.modules.super_admin.models import BillingKillSwitch

logger = logging.getLogger("zoiko_billing.super_admin.kill_switch")

COMMERCIAL_SUBSCRIPTION_CHARGING = "commercial_subscription_charging"
TENANT_INVOICE_FINALIZATION = "tenant_invoice_finalization"
TENANT_PAYMENT_ATTEMPTS = "tenant_payment_attempts"
TENANT_DUNNING = "tenant_dunning"
TENANT_BILLING_COMMUNICATIONS = "tenant_billing_communications"

# ZB-SA-CMD-003 §9.2 launch catalog — Domain B entries with a REAL enforced
# code path in this repository. Each entry carries its blast-radius preview
# metadata (§9.1 "shows a blast-radius preview before execution") so the UI
# can render what engaging the breaker actually stops before an operator
# confirms anything.
DOMAIN_B_BREAKER_CATALOG: dict[str, dict] = {
    TENANT_INVOICE_FINALIZATION: {
        "display_name": "Pause invoice finalization",
        "domain": "B",
        "effect": (
            "Prevents new tenant invoice finalization/generation "
            "(InvoiceService.finalize_invoice / mark_sent). Queued drafts are "
            "preserved for controlled replay."
        ),
        "gated_paths": [
            "POST /api/billing/invoices/{id}/finalize",
            "POST /api/billing/invoices/{id}/mark-sent",
        ],
    },
    TENANT_PAYMENT_ATTEMPTS: {
        "display_name": "Pause automatic payment attempts",
        "domain": "B",
        "effect": (
            "Stops NEW platform-initiated payment captures/retries (Stripe "
            "PaymentIntent/Checkout creation, manual attempt records). "
            "In-flight processor activity is NOT canceled — webhook "
            "confirmations keep working."
        ),
        "gated_paths": [
            "StripeService.create_payment_intent",
            "StripeService.create_checkout_session",
            "PaymentService.record_attempt",
        ],
    },
    TENANT_DUNNING: {
        "display_name": "Suspend dunning/retries",
        "domain": "B",
        "effect": (
            "Prevents the automated dunning/retry loop from opening cases, "
            "progressing levels, applying late fees, or sending collection "
            "communications. Manual operator actions are unaffected."
        ),
        "gated_paths": [
            "DunningService.process_dunning",
            "DunningService.process_due_reminders",
        ],
    },
    TENANT_BILLING_COMMUNICATIONS: {
        "display_name": "Pause customer billing communications",
        "domain": "B",
        "effect": (
            "Stops invoice/dunning customer emails while preserving the "
            "generated artifacts (PDFs, case state, communication records)."
        ),
        "gated_paths": [
            "InvoiceService.send_invoice_via_email",
            "DunningService reminder email sends",
        ],
    },
}

KNOWN_BREAKER_SCOPES = {
    COMMERCIAL_SUBSCRIPTION_CHARGING,
    *DOMAIN_B_BREAKER_CATALOG.keys(),
}

# §9.1 auto-expiry bounds: a pause must always be time-bound. 14 days is the
# widest defensible "temporary containment" window; anything longer should be
# a deliberate configuration/policy change, not a forgotten breaker.
MIN_AUTO_EXPIRE_MINUTES = 5
MAX_AUTO_EXPIRE_MINUTES = 14 * 24 * 60
DEFAULT_AUTO_EXPIRE_MINUTES = 8 * 60


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

    def _lift_expired_pause(self, switch: BillingKillSwitch) -> bool:
        """Lazy auto-expiry (§9.1). Returns True if a paused breaker was just
        re-enabled because its expires_at passed. Audited + de-escalates the
        matching Attention item, inside the caller's transaction."""
        if switch.enabled or switch.expires_at is None:
            return False
        if datetime.utcnow() < switch.expires_at:
            return False
        scope = switch.scope
        previous_expiry = switch.expires_at
        switch.enabled = True
        switch.expires_at = None
        switch.reason = f"Auto-expired (was paused until {previous_expiry.isoformat()}Z)."
        switch.changed_by_user_id = None
        switch.changed_at = datetime.utcnow()
        self.db.flush()
        logger.warning("Circuit breaker '%s' auto-expired and was re-enabled", scope)

        try:
            from app.modules.super_admin.audit_service import PlatformAuditService
            from app.modules.super_admin.models import PlatformAuditAction

            PlatformAuditService(self.db).log_no_commit(
                actor_id=None,
                actor_role="system",
                action=PlatformAuditAction.ACTIVATE,
                entity_type="BillingKillSwitch",
                entity_id=switch.id,
                reason=f"Circuit breaker '{scope}' auto-expired at {previous_expiry.isoformat()}Z.",
                old_values={"enabled": False, "expires_at": previous_expiry.isoformat()},
                new_values={"enabled": True, "expires_at": None},
            )
        except Exception:  # noqa: BLE001 - audit bookkeeping must not block the gated path
            logger.exception("Audit bookkeeping failed for auto-expiry of '%s'", scope)

        try:
            from app.modules.super_admin.attention_service import AttentionService

            AttentionService(self.db).auto_resolve(
                source="kill_switch", source_key=f"kill_switch:{scope}",
                resolution_note=f"Breaker pause auto-expired at {previous_expiry.isoformat()}Z.",
            )
        except Exception:  # noqa: BLE001
            logger.exception("Attention bookkeeping failed for auto-expiry of '%s'", scope)
        return True

    def effective_state(self, scope: str) -> BillingKillSwitch:
        """Returns the switch row after lazily lifting any expired pause.
        All reads and all enforcement go through this, so no code path can
        observe a stale 'paused' state past its expiry."""
        switch = self.ensure_switch(scope)
        self._lift_expired_pause(switch)
        return switch

    def is_enabled(self, scope: str) -> bool:
        return self.effective_state(scope).enabled

    def require_enabled(self, scope: str) -> None:
        if not self.is_enabled(scope):
            raise BillingBlockedError(
                f"Billing operation blocked: circuit breaker '{scope}' is currently engaged "
                "(paused) by a platform operator. This action is preserved, not canceled — "
                "retry once the breaker is released."
            )

    def set_enabled(
        self,
        scope: str,
        enabled: bool,
        *,
        reason: str,
        actor_id: Optional[int],
        auto_expire_minutes: Optional[int] = None,
    ) -> BillingKillSwitch:
        """Engage (enabled=False) or release (enabled=True) a breaker.

        Engaging REQUIRES a time bound (§9.1: permanent breaker states are
        prohibited): auto_expire_minutes defaults to DEFAULT_AUTO_EXPIRE_MINUTES
        when omitted and is clamped to [MIN, MAX]. Releasing clears any expiry.
        """
        if not enabled:
            if auto_expire_minutes is None:
                auto_expire_minutes = DEFAULT_AUTO_EXPIRE_MINUTES
            if auto_expire_minutes < MIN_AUTO_EXPIRE_MINUTES or auto_expire_minutes > MAX_AUTO_EXPIRE_MINUTES:
                raise ValueError(
                    f"auto_expire_minutes must be between {MIN_AUTO_EXPIRE_MINUTES} "
                    f"and {MAX_AUTO_EXPIRE_MINUTES}."
                )

        switch = self.ensure_switch(scope)
        switch.enabled = enabled
        switch.reason = reason
        switch.changed_by_user_id = actor_id
        switch.changed_at = datetime.utcnow()
        switch.expires_at = (
            datetime.utcnow() + timedelta(minutes=auto_expire_minutes) if not enabled else None
        )
        self.db.flush()
        logger.warning(
            "Circuit breaker '%s' set to enabled=%s by user %s (reason: %s, expires_at: %s)",
            scope, enabled, actor_id, reason, switch.expires_at,
        )

        # ZB-SA-CMD-003 §10 — an engaged safety control is itself a real,
        # non-financial operational signal worth surfacing on the Attention
        # queue (governance-relevant, not tenant/domain-B financial data).
        try:
            from app.modules.super_admin.attention_service import AttentionService
            from app.modules.super_admin.models import AttentionSeverity

            attention = AttentionService(self.db)
            if not enabled:
                attention.report_or_update(
                    source="kill_switch",
                    source_key=f"kill_switch:{scope}",
                    title=f"Circuit breaker engaged: {scope}",
                    description=reason,
                    base_severity=AttentionSeverity.P1,
                )
            else:
                attention.auto_resolve(source="kill_switch", source_key=f"kill_switch:{scope}")
        except Exception:  # noqa: BLE001
            logger.exception("Attention-Engine bookkeeping failed for circuit breaker '%s'", scope)

        return switch
