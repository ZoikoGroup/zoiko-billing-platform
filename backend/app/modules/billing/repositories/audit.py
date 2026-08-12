from typing import Any, Dict, List, Optional

from app.modules.billing.models import BillingAuditAction, BillingAuditLog
from app.modules.billing.repositories.base import BaseRepository


class BillingAuditLogRepository(BaseRepository[BillingAuditLog]):
    def __init__(self, db):
        super().__init__(db, BillingAuditLog)

    def list_by_entity(
        self,
        organization_id: int,
        entity_type: str,
        entity_id: int,
        limit: int = 100,
    ) -> List[BillingAuditLog]:
        return self.db.query(BillingAuditLog).filter(
            BillingAuditLog.organization_id == organization_id,
            BillingAuditLog.entity_type == entity_type,
            BillingAuditLog.entity_id == entity_id,
        ).order_by(BillingAuditLog.timestamp.desc()).limit(limit).all()

    def list_by_action(
        self,
        organization_id: int,
        action: str,
        limit: int = 100,
    ) -> List[BillingAuditLog]:
        return self.db.query(BillingAuditLog).filter(
            BillingAuditLog.organization_id == organization_id,
            BillingAuditLog.action == action,
        ).order_by(BillingAuditLog.timestamp.desc()).limit(limit).all()

    def list_by_actor(
        self,
        organization_id: int,
        actor_id: int,
        limit: int = 100,
    ) -> List[BillingAuditLog]:
        return self.db.query(BillingAuditLog).filter(
            BillingAuditLog.organization_id == organization_id,
            BillingAuditLog.actor_id == actor_id,
        ).order_by(BillingAuditLog.timestamp.desc()).limit(limit).all()

    def list_paginated(
        self,
        organization_id: int,
        page: int = 1,
        per_page: int = 20,
        sort_by: Optional[str] = None,
        sort_order: str = "desc",
        search_term: Optional[str] = None,
        entity_type: Optional[str] = None,
        entity_id: Optional[int] = None,
        action: Optional[str] = None,
        actor_id: Optional[int] = None,
        search_fields: Optional[List[str]] = None,
        **filters: Any,
    ) -> Dict[str, Any]:
        if entity_type:
            filters["entity_type"] = entity_type
        if entity_id is not None:
            filters["entity_id"] = entity_id
        if action:
            filters["action"] = action
        if actor_id:
            filters["actor_id"] = actor_id
        filters.pop("search_fields", None)
        return super().list_paginated(
            organization_id=organization_id,
            page=page,
            per_page=per_page,
            sort_by=sort_by or "timestamp",
            sort_order=sort_order,
            active_only=False,
            search_term=search_term,
            search_fields=search_fields or ["entity_type", "ip_address", "request_id"],
            **filters,
        )
