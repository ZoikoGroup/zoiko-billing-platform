"""
modules/notifications/suppression_service.py
------------------------------------------------
Hard-suppression checks. A suppressed recipient is blocked regardless of
template tier — T0/T1 mandatory mail bypasses marketing-consent checks
(see consent_service) but NEVER bypasses hard suppression.
"""

from datetime import datetime
from typing import Optional

from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.modules.notifications.models import SuppressedRecipient, SuppressionReason


def is_suppressed(
    db: Session, email: str, organization_id: Optional[int]
) -> Optional[SuppressedRecipient]:
    """Returns the blocking row (global or org-scoped) if this recipient is
    currently suppressed, else None. A global suppression (organization_id
    IS NULL) blocks regardless of which org is sending."""
    normalized_email = email.strip().lower()
    query = db.query(SuppressedRecipient).filter(
        SuppressedRecipient.email == normalized_email,
        SuppressedRecipient.lifted_at.is_(None),
    )
    if organization_id is not None:
        query = query.filter(
            or_(
                SuppressedRecipient.organization_id.is_(None),
                SuppressedRecipient.organization_id == organization_id,
            )
        )
    else:
        query = query.filter(SuppressedRecipient.organization_id.is_(None))
    return query.order_by(SuppressedRecipient.id.desc()).first()


def record_suppression(
    db: Session,
    email: str,
    *,
    organization_id: Optional[int] = None,
    reason: SuppressionReason,
    detail: Optional[str] = None,
    created_by_user_id: Optional[int] = None,
) -> SuppressedRecipient:
    row = SuppressedRecipient(
        email=email.strip().lower(),
        organization_id=organization_id,
        reason=reason,
        detail=detail,
        created_by_user_id=created_by_user_id,
    )
    db.add(row)
    db.flush()
    return row


def lift_suppression(db: Session, suppression_id: int) -> Optional[SuppressedRecipient]:
    row = db.query(SuppressedRecipient).filter(SuppressedRecipient.id == suppression_id).first()
    if row is not None and row.lifted_at is None:
        row.lifted_at = datetime.utcnow()
        db.flush()
    return row
