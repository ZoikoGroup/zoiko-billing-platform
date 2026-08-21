from typing import Any, Dict, List, Optional

from datetime import date as _date, timedelta as _timedelta

from sqlalchemy import func, or_

from app.modules.billing.models import (
    BillingPeriod,
    CONTRACT_BLOCKED_STATUSES,
    Contract,
    Subscription,
    SubscriptionEvent,
    SubscriptionPlan,
)
from sqlalchemy.orm import joinedload

from app.modules.billing.repositories.base import BaseRepository


class SubscriptionPlanRepository(BaseRepository[SubscriptionPlan]):
    def __init__(self, db):
        super().__init__(db, SubscriptionPlan)

    def get_by_code(self, organization_id: int, code: str) -> Optional[SubscriptionPlan]:
        return self.get_first(organization_id, plan_code=code)

    def list_public(self, organization_id: int, active_only: bool = True) -> List[SubscriptionPlan]:
        return self.list_all(organization_id, active_only=active_only, is_public=True)

    def list_paginated(
        self,
        organization_id: int,
        page: int = 1,
        per_page: int = 20,
        sort_by: Optional[str] = None,
        sort_order: str = "asc",
        active_only: bool = True,
        search_term: Optional[str] = None,
        category: Optional[str] = None,
        search_fields: Optional[List[str]] = None,
        **filters: Any,
    ) -> Dict[str, Any]:
        if category:
            filters["category"] = category
        filters.pop("search_fields", None)
        return super().list_paginated(
            organization_id=organization_id,
            page=page,
            per_page=per_page,
            sort_by=sort_by or "sort_order",
            sort_order=sort_order,
            active_only=active_only,
            search_term=search_term,
            search_fields=search_fields or ["plan_name", "plan_code", "description"],
            **filters,
        )


class SubscriptionRepository(BaseRepository[Subscription]):
    def __init__(self, db):
        super().__init__(db, Subscription)

    def get_by_number(self, organization_id: int, number: str) -> Optional[Subscription]:
        return self.get_first(organization_id, subscription_number=number)

    def list_by_customer(
        self,
        organization_id: int,
        customer_id: int,
        active_only: bool = True,
    ) -> List[Subscription]:
        return self.list_all(organization_id, active_only=active_only, customer_id=customer_id)

    def list_by_plan(
        self,
        organization_id: int,
        plan_id: int,
        active_only: bool = True,
    ) -> List[Subscription]:
        return self.list_all(organization_id, active_only=active_only, plan_id=plan_id)

    def list_by_status(
        self,
        organization_id: int,
        status: str,
        active_only: bool = True,
    ) -> List[Subscription]:
        return self.list_all(organization_id, active_only=active_only, status=status)

    def list_active(self, organization_id: int) -> List[Subscription]:
        return self.list_all(organization_id, active_only=True, status="active")

    def count_by_status(self, organization_id: int, active_only: bool = True) -> Dict[str, int]:
        from app.modules.billing.models import BillingSubscriptionStatus
        query = self.db.query(
            Subscription.status,
            func.count(Subscription.id),
        ).filter(
            Subscription.organization_id == organization_id,
        )
        if active_only:
            query = query.filter(Subscription.is_active == True)
        query = query.group_by(Subscription.status)
        rows = {row[0]: row[1] for row in query.all()}
        return {s.value: rows.get(s.value, 0) for s in BillingSubscriptionStatus}

    def list_due_for_billing(self, organization_id: int, billing_date: str) -> List[Subscription]:
        # Eligibility guard: a subscription linked to a CANCELLED/TERMINATED
        # contract must never be selected for billing, even if its own
        # status is still ACTIVE (contract and subscription lifecycles are
        # independent — see CONTRACT_BLOCKED_STATUSES). Standalone
        # subscriptions (contract_id IS NULL) are unaffected: the outerjoin
        # leaves Contract.status NULL for them, and NULL NOT IN (...) is
        # NULL/false in SQL, so the explicit contract_id.is_(None) branch is
        # required for them to still match.
        return (
            self.db.query(Subscription)
            .outerjoin(Subscription.contract)
            .filter(
                Subscription.organization_id == organization_id,
                Subscription.is_active == True,
                Subscription.status == "active",
                Subscription.next_billing_at <= billing_date,
                or_(
                    Subscription.contract_id.is_(None),
                    Contract.status.notin_(CONTRACT_BLOCKED_STATUSES),
                ),
            )
            .all()
        )

    def cancel(self, id: int, organization_id: int, reason: Optional[str] = None) -> Subscription:
        sub = self.get_by_id(id, organization_id)
        from app.modules.billing.models import BillingSubscriptionStatus
        sub.status = BillingSubscriptionStatus.CANCELLED
        sub.is_active = False
        sub.cancelled_at = func.now()
        sub.cancellation_reason = reason
        self.db.commit()
        self.db.refresh(sub)
        return sub

    def pause(self, id: int, organization_id: int) -> Subscription:
        sub = self.get_by_id(id, organization_id)
        from app.modules.billing.models import BillingSubscriptionStatus
        sub.status = BillingSubscriptionStatus.PAUSED
        sub.paused_at = func.now()
        self.db.commit()
        self.db.refresh(sub)
        return sub

    def resume(self, id: int, organization_id: int) -> Subscription:
        sub = self.get_by_id(id, organization_id)
        from app.modules.billing.models import BillingSubscriptionStatus
        sub.status = BillingSubscriptionStatus.ACTIVE
        sub.paused_at = None
        plan = sub.plan
        if plan and plan.billing_period != BillingPeriod.ONE_TIME:
            periods = {
                BillingPeriod.MONTHLY: 30,
                BillingPeriod.QUARTERLY: 90,
                BillingPeriod.SEMI_ANNUAL: 180,
                BillingPeriod.ANNUAL: 365,
            }
            days = periods.get(plan.billing_period, 30)
            today = _date.today()
            if sub.next_billing_at and sub.next_billing_at < today:
                sub.next_billing_at = today
                sub.current_term_start = today
                sub.current_term_end = today + _timedelta(days=days)
        self.db.commit()
        self.db.refresh(sub)
        return sub

    def list_paginated(
        self,
        organization_id: int,
        page: int = 1,
        per_page: int = 20,
        sort_by: Optional[str] = None,
        sort_order: str = "asc",
        active_only: bool = True,
        search_term: Optional[str] = None,
        customer_id: Optional[int] = None,
        plan_id: Optional[int] = None,
        status: Optional[str] = None,
        search_fields: Optional[List[str]] = None,
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
        **filters: Any,
    ) -> Dict[str, Any]:
        if customer_id:
            filters["customer_id"] = customer_id
        if plan_id:
            filters["plan_id"] = plan_id
        if status:
            filters["status"] = status
        filters.pop("search_fields", None)
        return super().list_paginated(
            organization_id=organization_id,
            page=page,
            per_page=per_page,
            sort_by=sort_by or "created_at",
            sort_order=sort_order or "desc",
            active_only=active_only,
            search_term=search_term,
            search_fields=search_fields or ["subscription_number"],
            date_field="created_at",
            date_from=date_from,
            date_to=date_to,
            **filters,
        )


    def list_active_with_plan(self, organization_id: int) -> List[Subscription]:
        """Return all active subscriptions eagerly loaded with their plan."""
        return (
            self.db.query(Subscription)
            .options(joinedload(Subscription.plan))
            .filter(
                Subscription.organization_id == organization_id,
                Subscription.is_active == True,
                Subscription.status == "active",
            )
            .all()
        )


class SubscriptionEventRepository(BaseRepository[SubscriptionEvent]):
    def __init__(self, db):
        super().__init__(db, SubscriptionEvent)

    def list_by_subscription(
        self,
        organization_id: int,
        subscription_id: int,
        limit: int = 50,
    ) -> List[SubscriptionEvent]:
        query = self.db.query(SubscriptionEvent).filter(
            SubscriptionEvent.subscription_id == subscription_id,
        )
        query = self._org_filter(query, organization_id)
        return query.order_by(SubscriptionEvent.created_at.desc()).limit(limit).all()

    def log_event(
        self,
        organization_id: int,
        subscription_id: int,
        event_type: str,
        old_value: Optional[dict] = None,
        new_value: Optional[dict] = None,
        reason: Optional[str] = None,
        created_by: Optional[int] = None,
    ) -> SubscriptionEvent:
        event = SubscriptionEvent(
            organization_id=organization_id,
            subscription_id=subscription_id,
            event_type=event_type,
            old_value=old_value,
            new_value=new_value,
            reason=reason,
            created_by=created_by,
        )
        self.db.add(event)
        self.db.commit()
        self.db.refresh(event)
        return event
