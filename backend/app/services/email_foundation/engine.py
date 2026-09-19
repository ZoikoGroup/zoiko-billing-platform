"""
email_foundation/engine.py
---------------------------
Consent, Suppression, Idempotency, Supersession, and Audit Logging Engine
for the Zoiko Billing Email System.
"""

import json
import logging
import hashlib
from datetime import datetime
from typing import Tuple, Optional, Dict, Any
from sqlalchemy.orm import Session

from app.services.email_foundation.enums import (
    TemplateTier,
    SendStatus,
    SuppressionReason,
)
from app.services.email_foundation.models import (
    EmailSuppression,
    EmailMarketingConsent,
    EmailOrgPreference,
    CommunicationAuditLog,
)

logger = logging.getLogger("zoiko_billing")

# Supersession map: Event -> List of stale event names it supersedes for the same target_record_id
SUPERSESSION_RULES: Dict[str, list[str]] = {
    "invoice.paid": ["invoice.past_due", "invoice.pre_due_reminder", "dunning.reminder"],
    "invoice.voided": ["invoice.past_due", "invoice.pre_due_reminder", "dunning.reminder"],
    "payment.received": ["dunning.reminder", "invoice.past_due"],
}


class ConsentSuppressionEngine:
    @staticmethod
    def check_send_eligibility(
        db: Session,
        recipient: str,
        organization_id: Optional[int],
        tier: TemplateTier,
        family: str,
    ) -> Tuple[bool, Optional[SuppressionReason]]:
        """Evaluates consent, bounce/complaint suppression, legal holds, and org preferences.

        Rules:
        - T0/T1 mandatory mail bypasses marketing consent checks, but NEVER bypasses
          suppression for hard bounces or legal holds.
        - T3/T4 require explicit marketing consent.
        - Org-level notification preferences apply to T1–T4.
        """
        clean_email = recipient.strip().lower()

        # 1. Hard Bounce / Complaint / Legal Hold Suppression Check (Applies to ALL Tiers including T0/T1)
        suppression = (
            db.query(EmailSuppression)
            .filter(
                EmailSuppression.email_address == clean_email,
                (EmailSuppression.organization_id == organization_id)
                | (EmailSuppression.organization_id.is_(None)),
            )
            .first()
        )
        if suppression:
            reason_map = {
                "BOUNCE": SuppressionReason.BOUNCE,
                "COMPLAINT": SuppressionReason.COMPLAINT,
                "LEGAL_HOLD": SuppressionReason.LEGAL_HOLD,
                "OPT_OUT": SuppressionReason.OPT_OUT,
            }
            reason = reason_map.get(suppression.reason, SuppressionReason.BOUNCE)
            logger.info(f"[EMAIL_ENGINE] Recipient {clean_email} suppressed due to {reason.value}")
            return False, reason

        # 2. Org-Level Notification Preferences Check (Applies to T1-T4)
        if tier != TemplateTier.T0 and organization_id:
            org_pref = (
                db.query(EmailOrgPreference)
                .filter(
                    EmailOrgPreference.organization_id == organization_id,
                    EmailOrgPreference.category == family,
                )
                .first()
            )
            if org_pref and not org_pref.is_enabled:
                logger.info(f"[EMAIL_ENGINE] Recipient {clean_email} suppressed due to org preference for {family}")
                return False, SuppressionReason.ORG_PREFERENCE

        # 3. Explicit Marketing Consent Check (Applies to T3 & T4 ONLY)
        if tier in (TemplateTier.T3, TemplateTier.T4):
            consent = (
                db.query(EmailMarketingConsent)
                .filter(
                    EmailMarketingConsent.email_address == clean_email,
                    (EmailMarketingConsent.organization_id == organization_id)
                    | (EmailMarketingConsent.organization_id.is_(None)),
                )
                .first()
            )
            if not consent or not consent.has_consented:
                logger.info(f"[EMAIL_ENGINE] Recipient {clean_email} suppressed due to missing marketing consent")
                return False, SuppressionReason.NO_MARKETING_CONSENT

        return True, None


class IdempotencySupersessionEngine:
    @staticmethod
    def generate_dedupe_key(event_id: Optional[str], template_id: str, recipient: str) -> str:
        clean_recipient = recipient.strip().lower()
        if event_id:
            return f"{event_id}:{template_id}:{clean_recipient}"
        # Fallback hash if no explicit event_id provided
        raw = f"{template_id}:{clean_recipient}"
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    @staticmethod
    def is_duplicate(db: Session, dedupe_key: str) -> bool:
        """Checks if a send attempt with this dedupe_key was already processed."""
        existing = (
            db.query(CommunicationAuditLog)
            .filter(
                CommunicationAuditLog.dedupe_key == dedupe_key,
                CommunicationAuditLog.status.in_([SendStatus.SENT.value, SendStatus.QUEUED.value]),
            )
            .first()
        )
        return existing is not None

    @staticmethod
    def apply_supersession(
        db: Session,
        recipient: str,
        target_record_id: Optional[str],
        event_name: str,
    ) -> int:
        """Suppresses stale queued/pending messages when a newer state event occurs."""
        if not target_record_id or event_name not in SUPERSESSION_RULES:
            return 0

        stale_events = SUPERSESSION_RULES[event_name]
        clean_recipient = recipient.strip().lower()

        stale_logs = (
            db.query(CommunicationAuditLog)
            .filter(
                CommunicationAuditLog.recipient == clean_recipient,
                CommunicationAuditLog.target_record_id == target_record_id,
                CommunicationAuditLog.event_name.in_(stale_events),
                CommunicationAuditLog.status == SendStatus.QUEUED.value,
            )
            .all()
        )

        superseded_count = 0
        for log_entry in stale_logs:
            log_entry.status = SendStatus.SUPERSEDED.value
            superseded_count += 1
            logger.info(f"[EMAIL_ENGINE] Log {log_entry.id} ({log_entry.event_name}) superseded by {event_name}")

        if superseded_count > 0:
            db.commit()

        return superseded_count


class CommunicationAuditLogger:
    @staticmethod
    def log_attempt(
        db: Session,
        dedupe_key: Optional[str],
        recipient: str,
        organization_id: Optional[int],
        template_id: str,
        event_name: str,
        tier: TemplateTier,
        status: SendStatus,
        event_id: Optional[str] = None,
        target_record_id: Optional[str] = None,
        suppression_reason: Optional[SuppressionReason] = None,
        error_message: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> CommunicationAuditLog:
        """Records a durable audit log for every send attempt (sent, suppressed, failed, duplicate, superseded)."""
        log_entry = CommunicationAuditLog(
            dedupe_key=dedupe_key,
            recipient=recipient.strip().lower(),
            organization_id=organization_id,
            template_id=template_id,
            event_name=event_name,
            event_id=event_id,
            target_record_id=target_record_id,
            tier=tier.value if hasattr(tier, "value") else str(tier),
            status=status.value if hasattr(status, "value") else str(status),
            suppression_reason=suppression_reason.value if hasattr(suppression_reason, "value") and suppression_reason else None,
            error_message=error_message,
            metadata_json=json.dumps(metadata) if metadata else None,
            sent_at=datetime.utcnow(),
        )
        db.add(log_entry)
        db.commit()
        db.refresh(log_entry)
        return log_entry
