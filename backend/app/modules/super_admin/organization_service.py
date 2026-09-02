"""
modules/super_admin/organization_service.py
-------------------------------------------
ZB-SA-P3 (Phase 3A) — Organizations workspace read models.

Backend-composed read models ONLY: the React layer never aggregates or
derives operational state. Every value below is read from real rows in
this database; absence of evidence is reported as None / UNKNOWN rather
than inferred.

Domain-boundary guarantees enforced here:
  - The directory and overview carry IDENTITY, LIFECYCLE and OPERATIONAL
    COUNT data. They never return monetary amounts — tenant financial
    records stay behind the Domain B privileged-access grant and the
    capability-gated Financial Operations endpoints.
  - Counts (users, incidents) are Domain C telemetry vocabulary: counts
    and states, zero currency figures.
"""

from datetime import datetime
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.exceptions import BadRequestException, NotFoundException
from app.modules.auth.models import User, UserRole
from app.modules.commercial.models import CommercialAccount, CommercialSubscription
from app.modules.commercial.service import (
    CommercialAccountService,
    CommercialSubscriptionService,
)
from app.modules.organizations.models import Organization, TenantLifecycleState
from app.modules.super_admin.lifecycle_service import TenantLifecycleService
from app.modules.super_admin.models import (
    AttentionItem,
    AttentionStatus,
    PlatformAuditLog,
    PrivilegedTenantAccessGrant,
)

# Attention statuses that count as "open" for directory/incident counts.
_OPEN_ATTENTION_STATUSES = {
    AttentionStatus.OPEN,
    AttentionStatus.ACKNOWLEDGED,
    AttentionStatus.ASSIGNED,
    AttentionStatus.MITIGATING,
    AttentionStatus.MONITORING,
}

# Roles that are tenant-side administrators (never super admins).
_TENANT_ADMIN_ROLES = {UserRole.ORG_ADMIN}


class OrganizationDirectoryService:
    def __init__(self, db: Session):
        self.db = db

    # ── Directory (list + filters + batched per-org counts) ─────────────────

    def list_organizations(
        self,
        *,
        skip: int = 0,
        limit: int = 50,
        search: str = "",
        status: Optional[str] = None,
        lifecycle_state: Optional[TenantLifecycleState] = None,
        country: Optional[str] = None,
        currency: Optional[str] = None,
        billing_classification=None,
        billing_source=None,
    ) -> dict:
        query = self.db.query(Organization)

        if search:
            like = f"%{search}%"
            query = query.filter(
                (Organization.organization_name.ilike(like))
                | (Organization.organization_code.ilike(like))
                | (Organization.legal_name.ilike(like))
            )
        if status == "active":
            query = query.filter(Organization.is_active.is_(True))
        elif status == "inactive":
            query = query.filter(Organization.is_active.is_(False))
        elif status not in (None, "", "all"):
            raise BadRequestException("status must be one of: active, inactive, all")
        if lifecycle_state is not None:
            query = query.filter(Organization.lifecycle_state == lifecycle_state)
        if country:
            query = query.filter(func.lower(Organization.country) == country.lower())
        if currency:
            query = query.filter(func.upper(Organization.currency) == currency.upper())
        if billing_classification is not None:
            query = query.filter(Organization.billing_classification == billing_classification)
        if billing_source is not None:
            query = query.filter(Organization.billing_source == billing_source)

        total = query.count()
        orgs = (
            query.order_by(Organization.created_at.desc())
            .offset(skip)
            .limit(limit)
            .all()
        )

        page_ids = [org.id for org in orgs]
        user_counts = self._user_counts(page_ids)
        incident_counts = self._open_incident_counts(page_ids)
        activity_map = self._last_activity_map(page_ids)
        # Phase 3G performance: batch the Plane 1 lookups so a directory page
        # issues a bounded number of queries regardless of page size.
        commercial_map = self._commercial_map(page_ids)

        items = [
            self._directory_item(
                org,
                user_counts.get(org.id, {}),
                incident_counts.get(org.id, 0),
                activity_map.get(org.id),
                commercial_map.get(org.id, (None, None)),
            )
            for org in orgs
        ]
        return {"total": total, "organizations": items}

    def _directory_item(self, org, user_counts, incident_counts, last_activity_at, commercial=None) -> dict:
        state = TenantLifecycleService(self.db).effective_state(org)

        if commercial is None:
            # Single-organization path (overview) — direct lookups are fine.
            account = (
                self.db.query(CommercialAccount)
                .filter(CommercialAccount.organization_id == org.id)
                .first()
            )
            current_sub = (
                CommercialSubscriptionService(self.db).get_active_subscription(account.id)
                if account is not None
                else None
            )
        else:
            account, current_sub = commercial

        counts = user_counts
        return {
            "id": org.id,
            "organization_code": org.organization_code,
            "organization_name": org.organization_name,
            "country": org.country,
            "currency": org.currency,
            "is_active": bool(org.is_active),
            "lifecycle_state": state.value,
            "billing_classification": org.billing_classification,
            "billing_source": org.billing_source,
            "commercial_account_status": account.status if account else None,
            "can_charge": CommercialAccountService(self.db).can_charge(org),
            "subscription_status": current_sub.status if current_sub else None,
            "subscription_plan_code": (
                current_sub.plan.plan_code if current_sub is not None and current_sub.plan else None
            ),
            "subscription_plan_name": (
                current_sub.plan.plan_name if current_sub is not None and current_sub.plan else None
            ),
            "trial_ends_at": current_sub.trial_ends_at if current_sub else None,
            "recovery_ends_at": current_sub.recovery_ends_at if current_sub else None,
            "total_users": counts.get("total", 0),
            "active_users": counts.get("active", 0),
            "org_admins": counts.get("org_admins", 0),
            "unverified_users": counts.get("unverified", 0),
            "open_incident_count": incident_counts,
            "created_at": org.created_at,
            "updated_at": org.updated_at,
            "last_activity_at": last_activity_at,
            "plane": "TENANT",
        }

    # ── Overview (single-organization composed read model) ──────────────────

    def get_organization_overview(self, organization_id: int) -> dict:
        org = self.db.query(Organization).filter(Organization.id == organization_id).first()
        if org is None:
            raise NotFoundException("Organization", "id")

        lifecycle = TenantLifecycleService(self.db)
        state = lifecycle.effective_state(org)

        item = self._directory_item(
            org,
            self._user_counts([org.id]).get(org.id, {}),
            self._open_incident_counts([org.id]).get(org.id, 0),
            self._last_activity_map([org.id]).get(org.id),
            self._commercial_map([org.id]).get(org.id, (None, None)),
        )

        users = (
            self.db.query(User)
            .filter(User.organization_id == org.id)
            .order_by(User.created_at.asc(), User.id.asc())
            .all()
        )
        administrators = [
            {
                "id": u.id,
                "email": u.email,
                "first_name": u.first_name,
                "last_name": u.last_name,
                "is_active": bool(u.is_active),
                "is_verified": bool(u.is_verified),
                "last_login_at": u.last_login_at,
            }
            for u in users
            if u.role in _TENANT_ADMIN_ROLES
        ]
        known_logins = sorted(
            (u for u in users if u.last_login_at is not None),
            key=lambda u: u.last_login_at,
            reverse=True,
        )[:5]
        user_summary = {
            "total_users": len(users),
            "active_users": sum(1 for u in users if u.is_active),
            "suspended_users": sum(1 for u in users if not u.is_active),
            "invited_unverified": sum(1 for u in users if not u.is_verified),
            "by_role": {role.value.lower(): sum(1 for u in users if u.role == role) for role in UserRole},
            # Real evidence only — users who never logged in are simply absent.
            "recent_logins": [
                {"email": u.email, "last_login_at": u.last_login_at} for u in known_logins
            ],
        }

        audit_rows = (
            self.db.query(PlatformAuditLog)
            .filter(PlatformAuditLog.organization_id == org.id)
            .order_by(PlatformAuditLog.id.desc())
            .limit(10)
            .all()
        )
        recent_audit_events = [
            {
                "id": row.id,
                "action": row.action.value if row.action is not None else None,
                "entity_type": row.entity_type,
                "entity_id": row.entity_id,
                "actor_role": row.actor_role,
                "reason": row.reason,
                "correlation_id": row.correlation_id,
                "created_at": row.created_at,
            }
            for row in audit_rows
        ]

        grants = (
            self.db.query(PrivilegedTenantAccessGrant)
            .filter(PrivilegedTenantAccessGrant.organization_id == org.id)
            .order_by(PrivilegedTenantAccessGrant.id.desc())
            .limit(5)
            .all()
        )
        recent_privileged_grants = [
            {
                "id": g.id,
                "status": g.status.value if hasattr(g.status, "value") else str(g.status),
                "ticket_reference": g.ticket_reference,
                "reason": g.reason,
                "scope": g.scope,
                "requested_minutes": g.requested_minutes,
                "requested_at": g.requested_at,
                "activated_at": g.activated_at,
                "expires_at": g.expires_at,
                "exited_at": g.exited_at,
            }
            for g in grants
        ]

        return {
            "organization": item,
            "lifecycle_state": state.value,
            "allowed_transitions": [s.value for s in TenantLifecycleService.allowed_transitions(state)],
            "access_blocked": TenantLifecycleService.access_blocked(state),
            "onboarding_readiness": lifecycle.onboarding_readiness(org),
            "onboarding_blockers": lifecycle.onboarding_blockers(org),
            "administrators": administrators,
            "user_summary": user_summary,
            "recent_audit_events": recent_audit_events,
            "recent_privileged_grants": recent_privileged_grants,
            "generated_at": datetime.utcnow(),
            "plane": "TENANT",
        }

    # ── Batched helpers (no N+1 on list pages) ──────────────────────────────

    def _commercial_map(self, org_ids: list[int]) -> dict[int, tuple]:
        """One query per table for the whole page: commercial accounts plus
        each account's open (PENDING/ACTIVE/SUSPENDED/…) subscription with
        its plan preloaded. Maps org_id -> (account|None, sub|None)."""
        result: dict[int, tuple] = {}
        if not org_ids:
            return result
        accounts = (
            self.db.query(CommercialAccount)
            .filter(CommercialAccount.organization_id.in_(org_ids))
            .all()
        )
        if not accounts:
            return {}
        from sqlalchemy.orm import joinedload

        subs = (
            self.db.query(CommercialSubscription)
            .options(joinedload(CommercialSubscription.plan))
            .filter(
                CommercialSubscription.commercial_account_id.in_([a.id for a in accounts]),
                CommercialSubscription.status.in_(
                    list(CommercialSubscriptionService._OPEN_STATUSES)
                ),
            )
            .all()
        )
        sub_by_account = {s.commercial_account_id: s for s in subs}
        for account in accounts:
            result[account.organization_id] = (
                account,
                sub_by_account.get(account.id),
            )
        return result

    def _user_counts(self, org_ids: list[int]) -> dict[int, dict]:
        """Group-by role/status/verified then aggregate in Python — portable
        across SQLite and PostgreSQL without dialect-specific casts."""
        result: dict[int, dict] = {}
        if not org_ids:
            return result
        rows = (
            self.db.query(User.organization_id, User.role, User.is_active, User.is_verified, func.count(User.id))
            .filter(User.organization_id.in_(org_ids))
            .group_by(User.organization_id, User.role, User.is_active, User.is_verified)
            .all()
        )
        for org_id, role, is_active, is_verified, count in rows:
            bucket = result.setdefault(
                org_id,
                {"total": 0, "active": 0, "org_admins": 0, "unverified": 0},
            )
            count = int(count or 0)
            bucket["total"] += count
            if is_active:
                bucket["active"] += count
            else:
                bucket.setdefault("suspended", 0)
                bucket["suspended"] += count
            if not is_verified:
                bucket["unverified"] += count
            if role in _TENANT_ADMIN_ROLES and is_active:
                bucket["org_admins"] += count
        return result

    def _open_incident_counts(self, org_ids: list[int]) -> dict[int, int]:
        if not org_ids:
            return {}
        rows = (
            self.db.query(AttentionItem.organization_id, func.count(AttentionItem.id))
            .filter(
                AttentionItem.organization_id.in_(org_ids),
                AttentionItem.status.in_(list(_OPEN_ATTENTION_STATUSES)),
            )
            .group_by(AttentionItem.organization_id)
            .all()
        )
        return {org_id: int(count or 0) for org_id, count in rows}

    def _last_activity_map(self, org_ids: list[int]) -> dict[int, Optional[datetime]]:
        """Latest real evidence of activity per org: max(updated_at, latest
        platform audit event created_at, latest attention last_seen_at).
        Orgs with no evidence at all map to None — never fabricated."""
        if not org_ids:
            return {}
        audit_max = dict(
            self.db.query(
                PlatformAuditLog.organization_id,
                func.max(PlatformAuditLog.created_at),
            )
            .filter(PlatformAuditLog.organization_id.in_(org_ids))
            .group_by(PlatformAuditLog.organization_id)
            .all()
        )
        attention_max = dict(
            self.db.query(AttentionItem.organization_id, func.max(AttentionItem.last_seen_at))
            .filter(AttentionItem.organization_id.in_(org_ids))
            .group_by(AttentionItem.organization_id)
            .all()
        )
        result: dict[int, Optional[datetime]] = {}
        for org in self.db.query(Organization).filter(Organization.id.in_(org_ids)).all():
            result[org.id] = self._max_activity_datetime(
                (org.updated_at, audit_max.get(org.id), attention_max.get(org.id))
            )
        return result

    @staticmethod
    def _max_activity_datetime(candidates) -> Optional[datetime]:
        """max() over a mix of naive/aware datetimes.

        PlatformAuditLog.created_at is DateTime(timezone=True) (server-side
        func.now(), tz-aware on Postgres — though SQLite silently strips
        tzinfo on round-trip, which is why this never surfaced in the
        SQLite-backed test suite) while Organization.updated_at /
        AttentionItem.last_seen_at are naive DateTime (Python-side
        datetime.utcnow()). max() over a mix of aware/naive datetimes
        raises TypeError. Normalize every candidate to naive UTC (the
        convention the rest of this codebase uses, e.g.
        billing/services/admin_service.py's staleness check) before
        comparing.
        """
        normalized = [
            c.replace(tzinfo=None) if c.tzinfo is not None else c
            for c in candidates
            if isinstance(c, datetime)
        ]
        return max(normalized) if normalized else None
