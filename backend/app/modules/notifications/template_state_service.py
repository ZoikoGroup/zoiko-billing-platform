"""
modules/notifications/template_state_service.py
--------------------------------------------------
DB-level kill switch per template_id. Same precedent as
super_admin.kill_switch_service.BillingKillSwitchService, but with no
auto-expiry — disabling a template because its copy or legal review
failed must never silently self-re-enable.
"""

from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from app.modules.notifications.models import NotificationTemplateState


class NotificationTemplateStateService:
    def __init__(self, db: Session):
        self.db = db

    def ensure_row(self, template_id: str) -> NotificationTemplateState:
        row = (
            self.db.query(NotificationTemplateState)
            .filter(NotificationTemplateState.template_id == template_id)
            .first()
        )
        if row is None:
            row = NotificationTemplateState(template_id=template_id, enabled=True)
            self.db.add(row)
            self.db.flush()
        return row

    def is_enabled(self, template_id: str) -> bool:
        row = (
            self.db.query(NotificationTemplateState)
            .filter(NotificationTemplateState.template_id == template_id)
            .first()
        )
        # No row yet means no operator has ever toggled this template —
        # default to enabled (code-level `active` is the real gate).
        return True if row is None else bool(row.enabled)

    def set_enabled(
        self,
        template_id: str,
        enabled: bool,
        *,
        reason: str,
        actor_id: Optional[int] = None,
    ) -> NotificationTemplateState:
        row = self.ensure_row(template_id)
        row.enabled = enabled
        row.reason = reason
        row.changed_by_user_id = actor_id
        row.changed_at = datetime.utcnow()
        self.db.flush()
        return row
