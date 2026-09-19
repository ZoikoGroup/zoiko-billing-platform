"""
modules/notifications/consent_service.py
--------------------------------------------
Marketing consent checks. Gates T3/T4 sends ONLY (templates carrying
ControlRuleFlag.REQUIRES_MARKETING_CONSENT) — T0/T1/T2 never call this.
"""

from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from app.modules.notifications.models import MarketingConsent, MarketingConsentScope


def get_consent_state(
    db: Session, email: str, organization_id: Optional[int]
) -> Optional[MarketingConsent]:
    """Returns the most-recent applicable consent row, preferring a
    RECIPIENT_LEVEL row over an ORG_LEVEL row when both exist."""
    normalized_email = email.strip().lower()

    recipient_row = (
        db.query(MarketingConsent)
        .filter(
            MarketingConsent.email == normalized_email,
            MarketingConsent.scope == MarketingConsentScope.RECIPIENT_LEVEL,
        )
        .order_by(MarketingConsent.id.desc())
        .first()
    )
    if recipient_row is not None:
        return recipient_row

    if organization_id is not None:
        org_row = (
            db.query(MarketingConsent)
            .filter(
                MarketingConsent.email == normalized_email,
                MarketingConsent.organization_id == organization_id,
                MarketingConsent.scope == MarketingConsentScope.ORG_LEVEL,
            )
            .order_by(MarketingConsent.id.desc())
            .first()
        )
        if org_row is not None:
            return org_row

    return None


def record_consent(
    db: Session,
    email: str,
    *,
    organization_id: Optional[int] = None,
    scope: MarketingConsentScope,
    granted: bool,
    source: Optional[str] = None,
    created_by_user_id: Optional[int] = None,
) -> MarketingConsent:
    now = datetime.utcnow()
    row = MarketingConsent(
        email=email.strip().lower(),
        organization_id=organization_id,
        scope=scope,
        granted=granted,
        granted_at=now if granted else None,
        revoked_at=now if not granted else None,
        source=source,
        created_by_user_id=created_by_user_id,
    )
    db.add(row)
    db.flush()
    return row
