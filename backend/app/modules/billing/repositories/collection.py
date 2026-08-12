from typing import Any, Dict, List, Optional

from sqlalchemy import func

from app.modules.billing.models import (
    CollectionAction,
    CollectionsCase,
    DunningCase,
    DunningCaseStatusHistory,
    DunningLevel,
    DunningStatus,
    CollectionsCaseStatusHistory,
)
from app.modules.billing.repositories.base import BaseRepository


class DunningLevelRepository(BaseRepository[DunningLevel]):
    def __init__(self, db):
        super().__init__(db, DunningLevel)

    def get_by_level(self, organization_id: int, level_number: int) -> Optional[DunningLevel]:
        return self.get_first(organization_id, level_number=level_number)

    def list_active(self, organization_id: int) -> List[DunningLevel]:
        return self.list_all(organization_id, active_only=True)

    def list_paginated(
        self,
        organization_id: int,
        page: int = 1,
        per_page: int = 20,
        sort_by: Optional[str] = None,
        sort_order: str = "asc",
        active_only: bool = True,
        search_fields: Optional[List[str]] = None,
        **filters: Any,
    ) -> Dict[str, Any]:
        filters.pop("search_fields", None)
        return super().list_paginated(
            organization_id=organization_id,
            page=page,
            per_page=per_page,
            sort_by=sort_by or "level_number",
            sort_order=sort_order,
            active_only=active_only,
            search_fields=search_fields or ["name", "action_type"],
            **filters,
        )


class DunningCaseRepository(BaseRepository[DunningCase]):
    def __init__(self, db):
        super().__init__(db, DunningCase)

    def list_by_customer(
        self,
        organization_id: int,
        customer_id: int,
        active_only: bool = True,
    ) -> List[DunningCase]:
        return self.list_all(organization_id, active_only=active_only, customer_id=customer_id)

    def list_by_invoice(
        self,
        organization_id: int,
        invoice_id: int,
        active_only: bool = True,
    ) -> List[DunningCase]:
        return self.list_all(organization_id, active_only=active_only, invoice_id=invoice_id)

    def list_by_status(
        self,
        organization_id: int,
        status: str,
        active_only: bool = True,
    ) -> List[DunningCase]:
        return self.list_all(organization_id, active_only=active_only, status=status)

    def list_active_cases(self, organization_id: int) -> List[DunningCase]:
        return self.list_all(organization_id, active_only=True, status="active")

    def get_by_invoice_active(self, organization_id: int, invoice_id: int) -> Optional[DunningCase]:
        """The one non-terminal (ACTIVE) case for an invoice, if any — used to
        avoid opening duplicate cases for the same invoice."""
        return self.get_first(organization_id, invoice_id=invoice_id, status=DunningStatus.ACTIVE.value)

    def get_dashboard_stats(self, organization_id: int) -> Dict[str, Any]:
        base = self.db.query(DunningCase).filter(
            DunningCase.organization_id == organization_id,
            DunningCase.is_active == True,
        )
        total_count = base.count()
        total_overdue_amount = self.db.query(func.coalesce(func.sum(DunningCase.total_overdue_amount), 0)).filter(
            DunningCase.organization_id == organization_id, DunningCase.is_active == True,
        ).scalar()
        return {
            "total_count": total_count,
            "total_overdue_amount": float(total_overdue_amount),
            "active_count": base.filter(DunningCase.status == "active").count(),
            "resolved_count": base.filter(DunningCase.status == "resolved").count(),
            "escalated_count": base.filter(DunningCase.status == "escalated").count(),
            "closed_count": base.filter(DunningCase.status == "closed").count(),
            "due_for_action_count": base.filter(
                DunningCase.status == "active", DunningCase.next_action_at <= func.current_date(),
            ).count(),
        }

    def get_level_distribution(self, organization_id: int) -> List[Dict[str, Any]]:
        rows = (
            self.db.query(DunningCase.current_level, func.count(DunningCase.id), func.coalesce(func.sum(DunningCase.total_overdue_amount), 0))
            .filter(DunningCase.organization_id == organization_id, DunningCase.is_active == True, DunningCase.status == "active")
            .group_by(DunningCase.current_level)
            .order_by(DunningCase.current_level)
            .all()
        )
        return [
            {"level": level, "count": count, "total_amount": float(total)}
            for level, count, total in rows
        ]

    def list_paginated(
        self,
        organization_id: int,
        page: int = 1,
        per_page: int = 20,
        sort_by: Optional[str] = None,
        sort_order: str = "desc",
        active_only: bool = True,
        search_term: Optional[str] = None,
        customer_id: Optional[int] = None,
        status: Optional[str] = None,
        search_fields: Optional[List[str]] = None,
        **filters: Any,
    ) -> Dict[str, Any]:
        if customer_id:
            filters["customer_id"] = customer_id
        if status:
            filters["status"] = status
        filters.pop("search_fields", None)
        return super().list_paginated(
            organization_id=organization_id,
            page=page,
            per_page=per_page,
            sort_by=sort_by or "created_at",
            sort_order=sort_order,
            active_only=active_only,
            search_term=search_term,
            search_fields=search_fields or ["resolution_note"],
            **filters,
        )


class CollectionsCaseRepository(BaseRepository[CollectionsCase]):
    def __init__(self, db):
        super().__init__(db, CollectionsCase)

    def get_by_number(self, organization_id: int, number: str) -> Optional[CollectionsCase]:
        return self.get_first(organization_id, case_number=number)

    def list_by_customer(
        self,
        organization_id: int,
        customer_id: int,
        active_only: bool = True,
    ) -> List[CollectionsCase]:
        return self.list_all(organization_id, active_only=active_only, customer_id=customer_id)

    def list_by_status(
        self,
        organization_id: int,
        status: str,
        active_only: bool = True,
    ) -> List[CollectionsCase]:
        return self.list_all(organization_id, active_only=active_only, status=status)

    def list_by_assignee(
        self,
        organization_id: int,
        assigned_to: int,
        active_only: bool = True,
    ) -> List[CollectionsCase]:
        return self.list_all(organization_id, active_only=active_only, assigned_to=assigned_to)

    def list_by_priority(
        self,
        organization_id: int,
        priority: str,
        active_only: bool = True,
    ) -> List[CollectionsCase]:
        return self.list_all(organization_id, active_only=active_only, priority=priority)

    def list_paginated(
        self,
        organization_id: int,
        page: int = 1,
        per_page: int = 20,
        sort_by: Optional[str] = None,
        sort_order: str = "desc",
        active_only: bool = True,
        search_term: Optional[str] = None,
        customer_id: Optional[int] = None,
        status: Optional[str] = None,
        assigned_to: Optional[int] = None,
        priority: Optional[str] = None,
        search_fields: Optional[List[str]] = None,
        **filters: Any,
    ) -> Dict[str, Any]:
        if customer_id:
            filters["customer_id"] = customer_id
        if status:
            filters["status"] = status
        if assigned_to:
            filters["assigned_to"] = assigned_to
        if priority:
            filters["priority"] = priority
        filters.pop("search_fields", None)
        return super().list_paginated(
            organization_id=organization_id,
            page=page,
            per_page=per_page,
            sort_by=sort_by or "created_at",
            sort_order=sort_order,
            active_only=active_only,
            search_term=search_term,
            search_fields=search_fields or ["case_number", "notes", "resolution"],
            **filters,
        )

    def get_by_invoice_open(self, organization_id: int, invoice_id: int) -> Optional[CollectionsCase]:
        """The one non-terminal case for an invoice (not resolved/closed)."""
        query = self.db.query(CollectionsCase).filter(
            CollectionsCase.invoice_id == invoice_id,
            ~CollectionsCase.status.in_(["resolved", "closed"]),
        )
        query = self._org_filter(query, organization_id)
        return query.first()

    def get_dashboard_stats(self, organization_id: int) -> Dict[str, Any]:
        base = self.db.query(CollectionsCase).filter(
            CollectionsCase.organization_id == organization_id,
            CollectionsCase.is_active == True,
        )
        total_outstanding = self.db.query(func.coalesce(func.sum(CollectionsCase.total_outstanding), 0)).filter(
            CollectionsCase.organization_id == organization_id, CollectionsCase.is_active == True,
        ).scalar()
        amount_collected = self.db.query(func.coalesce(func.sum(CollectionsCase.amount_collected), 0)).filter(
            CollectionsCase.organization_id == organization_id, CollectionsCase.is_active == True,
        ).scalar()
        return {
            "total_count": base.count(),
            "total_outstanding": float(total_outstanding),
            "amount_collected": float(amount_collected),
            "open_count": base.filter(CollectionsCase.status == "open").count(),
            "in_progress_count": base.filter(CollectionsCase.status == "in_progress").count(),
            "escalated_count": base.filter(CollectionsCase.status == "escalated").count(),
            "resolved_count": base.filter(CollectionsCase.status == "resolved").count(),
            "closed_count": base.filter(CollectionsCase.status == "closed").count(),
            "urgent_count": base.filter(CollectionsCase.priority == "urgent").count(),
        }

    def get_priority_distribution(self, organization_id: int) -> List[Dict[str, Any]]:
        rows = (
            self.db.query(CollectionsCase.priority, func.count(CollectionsCase.id), func.coalesce(func.sum(CollectionsCase.total_outstanding), 0))
            .filter(CollectionsCase.organization_id == organization_id, CollectionsCase.is_active == True)
            .group_by(CollectionsCase.priority)
            .all()
        )
        return [
            {"priority": p.value if hasattr(p, "value") else str(p), "count": count, "total_amount": float(total)}
            for p, count, total in rows
        ]

    def get_recovery_trend(self, organization_id: int, months: int = 12) -> List[Dict[str, Any]]:
        rows = (
            self.db.query(
                func.date_trunc("month", CollectionsCase.resolved_at).label("month"),
                func.count(CollectionsCase.id),
                func.coalesce(func.sum(CollectionsCase.amount_collected), 0),
            )
            .filter(
                CollectionsCase.organization_id == organization_id,
                CollectionsCase.is_active == True,
                CollectionsCase.resolved_at.isnot(None),
            )
            .group_by("month")
            .order_by("month")
            .all()
        )
        return [
            {"month": month.strftime("%Y-%m") if month else None, "count": count, "amount_collected": float(total)}
            for month, count, total in rows[-months:]
        ]


class CollectionActionRepository(BaseRepository[CollectionAction]):
    def __init__(self, db):
        super().__init__(db, CollectionAction)

    def list_by_case(self, organization_id: int, collection_id: int) -> List[CollectionAction]:
        query = self.db.query(CollectionAction).filter(
            CollectionAction.collection_id == collection_id,
        )
        query = self._org_filter(query, organization_id)
        return query.order_by(CollectionAction.performed_at.desc()).all()

    def log_action(
        self,
        organization_id: int,
        collection_id: int,
        action_type: str,
        description: Optional[str] = None,
        performed_by: Optional[int] = None,
        outcome: Optional[str] = None,
        follow_up_date: Optional[str] = None,
    ) -> CollectionAction:
        action = CollectionAction(
            organization_id=organization_id,
            collection_id=collection_id,
            action_type=action_type,
            description=description,
            performed_by=performed_by,
            outcome=outcome,
            follow_up_date=follow_up_date,
        )
        self.db.add(action)
        self.db.commit()
        self.db.refresh(action)
        return action


class DunningCaseStatusHistoryRepository(BaseRepository[DunningCaseStatusHistory]):
    def __init__(self, db):
        super().__init__(db, DunningCaseStatusHistory)

    def list_by_case(self, organization_id: int, dunning_case_id: int) -> List[DunningCaseStatusHistory]:
        query = self.db.query(DunningCaseStatusHistory).filter(
            DunningCaseStatusHistory.dunning_case_id == dunning_case_id,
        )
        query = self._org_filter(query, organization_id)
        return query.order_by(DunningCaseStatusHistory.created_at.desc()).all()

    def log_status_change(
        self,
        organization_id: int,
        dunning_case_id: int,
        from_status: Optional[str],
        to_status: str,
        changed_by: Optional[int] = None,
        reason: Optional[str] = None,
    ) -> DunningCaseStatusHistory:
        entry = DunningCaseStatusHistory(
            organization_id=organization_id,
            dunning_case_id=dunning_case_id,
            from_status=from_status,
            to_status=to_status,
            changed_by=changed_by,
            reason=reason,
        )
        self.db.add(entry)
        self.db.commit()
        self.db.refresh(entry)
        return entry


class CollectionsCaseStatusHistoryRepository(BaseRepository[CollectionsCaseStatusHistory]):
    def __init__(self, db):
        super().__init__(db, CollectionsCaseStatusHistory)

    def list_by_case(self, organization_id: int, collections_case_id: int) -> List[CollectionsCaseStatusHistory]:
        query = self.db.query(CollectionsCaseStatusHistory).filter(
            CollectionsCaseStatusHistory.collections_case_id == collections_case_id,
        )
        query = self._org_filter(query, organization_id)
        return query.order_by(CollectionsCaseStatusHistory.created_at.desc()).all()

    def log_status_change(
        self,
        organization_id: int,
        collections_case_id: int,
        from_status: Optional[str],
        to_status: str,
        changed_by: Optional[int] = None,
        reason: Optional[str] = None,
    ) -> CollectionsCaseStatusHistory:
        entry = CollectionsCaseStatusHistory(
            organization_id=organization_id,
            collections_case_id=collections_case_id,
            from_status=from_status,
            to_status=to_status,
            changed_by=changed_by,
            reason=reason,
        )
        self.db.add(entry)
        self.db.commit()
        self.db.refresh(entry)
        return entry
