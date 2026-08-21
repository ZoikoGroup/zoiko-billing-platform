import logging
from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.modules.billing.models import BillingAuditAction, BillingAuditLog
from app.modules.billing.repositories.audit import BillingAuditLogRepository

logger = logging.getLogger("zoiko_billing")


def _json_safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_json_safe(v) for v in value]
    if isinstance(value, tuple):
        return [_json_safe(v) for v in value]
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, Enum):
        return value.value
    return value


class BillingAuditService:
    def __init__(self, db: Session):
        self.db = db
        self.repo = BillingAuditLogRepository(db)

    def log(
        self, organization_id: int, actor_id: Optional[int],
        action: BillingAuditAction, entity_type: str, entity_id: Optional[int] = None,
        old_values: Optional[Dict[str, Any]] = None,
        new_values: Optional[Dict[str, Any]] = None,
        changes: Optional[Dict[str, Any]] = None,
        ip_address: Optional[str] = None,
        user_agent: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> BillingAuditLog:
        return self.repo.create(
            organization_id,
            actor_id=actor_id, action=action,
            entity_type=entity_type, entity_id=entity_id,
            old_values=_json_safe(old_values), new_values=_json_safe(new_values),
            changes=_json_safe(changes), ip_address=ip_address,
            user_agent=user_agent, request_id=request_id,
        )

    def log_no_commit(
        self, organization_id: int, actor_id: Optional[int],
        action: BillingAuditAction, entity_type: str, entity_id: Optional[int] = None,
        old_values: Optional[Dict[str, Any]] = None,
        new_values: Optional[Dict[str, Any]] = None,
        changes: Optional[Dict[str, Any]] = None,
        ip_address: Optional[str] = None,
        user_agent: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> BillingAuditLog:
        """Same as log() but only flushes — the entry is persisted by the
        caller's single commit. Used inside multi-statement transactions so an
        audit row can never be orphaned if the transaction later rolls back."""
        entry = BillingAuditLog(
            organization_id=organization_id,
            actor_id=actor_id, action=action,
            entity_type=entity_type, entity_id=entity_id,
            old_values=_json_safe(old_values), new_values=_json_safe(new_values),
            changes=_json_safe(changes), ip_address=ip_address,
            user_agent=user_agent, request_id=request_id,
        )
        self.db.add(entry)
        self.db.flush()
        return entry

    def list_by_entity(
        self, organization_id: int, entity_type: str, entity_id: int, limit: int = 100,
    ) -> List[BillingAuditLog]:
        return self.repo.list_by_entity(organization_id, entity_type, entity_id, limit)

    def list_by_action(
        self, organization_id: int, action: str, limit: int = 100,
    ) -> List[BillingAuditLog]:
        return self.repo.list_by_action(organization_id, action, limit)

    def list_by_actor(
        self, organization_id: int, actor_id: int, limit: int = 100,
    ) -> List[BillingAuditLog]:
        return self.repo.list_by_actor(organization_id, actor_id, limit)

    def list_logs(
        self, organization_id: int, page: int = 1, per_page: int = 20,
        entity_type: Optional[str] = None, entity_id: Optional[int] = None,
        action: Optional[str] = None, actor_id: Optional[int] = None,
        sort_by: str = "timestamp", sort_order: str = "desc",
    ) -> Dict[str, Any]:
        return self.repo.list_paginated(
            organization_id=organization_id, page=page, per_page=per_page,
            sort_by=sort_by, sort_order=sort_order,
            entity_type=entity_type, entity_id=entity_id,
            action=action, actor_id=actor_id,
        )
