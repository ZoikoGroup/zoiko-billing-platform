"""
modules/super_admin/user_admin_service.py
-----------------------------------------
ZB-SA-P3 (Phase 3B) — Administrators & Users: Super-Admin-scoped mutations.

All mutations performed here:
  - are authorized upstream by get_current_super_admin (router dependency);
  - require a documented human reason (role changes, membership moves,
    status flips) that is stored verbatim in the platform audit trail;
  - write an append-only PlatformAuditLog event transactionally with the
    change (log_no_commit → caller commits; rollback discards both);
  - never allow a Super Admin to mutate their own role or deactivate
    their own account;
  - keep platform accounts (role=SUPER_ADMIN) out of tenant-scoped
    operations: tenant roles are managed here, super-admin PlatformRole
    assignments stay with the existing /users/{id}/platform-role endpoint.

Derived status is evidence-based ONLY:
  active     — is_active and verified
  suspended  — is_active False (Super Admin action)
  invited    — active but not yet verified (invite outstanding)
  locked     — SuperAdminMFA.locked_until in the future
Users who never logged in simply carry last_login_at=None and are shown as
"never logged in" — never a fabricated recency.
"""

import secrets
from datetime import datetime

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.exceptions import (
    AlreadyExistsException,
    BadRequestException,
    ForbiddenException,
    NotFoundException,
)
from app.modules.auth.models import SecurityActionPurpose, SuperAdminMFA, User, UserRole
from app.modules.organizations.models import Organization
from app.modules.super_admin.audit_service import PlatformAuditService
from app.modules.super_admin.models import PlatformAuditAction

# Roles that belong to a TENANT. Super admins are platform staff — their
# role/membership is never managed through this service.
_TENANT_ROLES = {
    UserRole.ORG_ADMIN,
    UserRole.BILLING_ADMIN,
    UserRole.FINANCE_APPROVER,
    UserRole.AUDITOR,
}

STATUS_ACTIVE = "active"
STATUS_SUSPENDED = "suspended"
STATUS_INVITED = "invited"
STATUS_LOCKED = "locked"


class UserAdminService:
    def __init__(self, db: Session):
        self.db = db
        self._audit = PlatformAuditService(db)

    # ── Derived status (honest, evidence-based) ──────────────────────────────

    def derived_status(self, user: User) -> str:
        if user.is_active is False:
            return STATUS_SUSPENDED
        if user.role == UserRole.SUPER_ADMIN:
            locked_until = (
                self.db.query(SuperAdminMFA.locked_until)
                .filter(SuperAdminMFA.user_id == user.id)
                .scalar()
            )
            if locked_until is not None and locked_until > datetime.utcnow():
                return STATUS_LOCKED
        if not user.is_verified:
            return STATUS_INVITED
        return STATUS_ACTIVE

    def get_user(self, user_id: int) -> User:
        user = self.db.query(User).filter(User.id == user_id).first()
        if user is None:
            raise NotFoundException("User", "id")
        return user

    def get_organization(self, organization_id: int) -> Organization:
        org = self.db.query(Organization).filter(Organization.id == organization_id).first()
        if org is None:
            raise NotFoundException("Organization", "id")
        return org

    # ── Invite (create tenant user) ──────────────────────────────────────────

    def invite_user(
        self,
        *,
        actor: User,
        organization_id: int,
        email: str,
        role: UserRole,
        first_name: str = "",
        last_name: str = "",
        phone: str = "",
        send_invite: bool = True,
    ) -> User:
        if role not in _TENANT_ROLES:
            raise BadRequestException(
                f"Role '{getattr(role, 'value', role)}' cannot be invited through tenant administration "
                f"(allowed: {[r.value for r in _TENANT_ROLES]})."
            )
        org = self.get_organization(organization_id)

        from app.core.dependencies import can_create_role
        from app.core.security import hash_password

        if not can_create_role("super_admin", role.value):
            raise ForbiddenException(f"Role 'super_admin' cannot create users with role '{role.value}'.")

        email = (email or "").strip().lower()
        existing = self.db.query(User).filter(func.lower(User.email) == email).first()
        if existing:
            raise AlreadyExistsException("User", "email")

        user = User(
            email=email,
            hashed_password=hash_password(secrets.token_urlsafe(24)),
            role=role,
            organization_id=org.id,
            first_name=first_name or "",
            last_name=last_name or "",
            phone=phone or "",
            is_active=True,
            is_verified=False,
        )
        self.db.add(user)
        self.db.flush()

        invite_link = None
        if send_invite:
            from app.modules.auth import service as auth_service

            raw_token, _ = auth_service._issue_action_token(
                self.db, user.email, org.id, SecurityActionPurpose.INVITE
            )
            invite_link = auth_service._action_link(SecurityActionPurpose.INVITE, raw_token)
            auth_service._send_invite_email(self.db, user, actor, invite_link)

        self._audit.log_no_commit(
            actor_id=getattr(actor, "id", None),
            actor_role="super_admin",
            action=PlatformAuditAction.CREATE,
            entity_type="User",
            entity_id=user.id,
            organization_id=org.id,
            new_values={
                "email": user.email,
                "role": role.value,
                "organization_id": org.id,
                "send_invite": bool(send_invite),
            },
            metadata={"field": "user_created", "plane": "TENANT"},
        )
        return user

    # ── Role change ──────────────────────────────────────────────────────────

    def set_role(self, *, actor: User, user_id: int, new_role: UserRole, reason: str) -> User:
        self._require_reason(reason)
        target = self.get_user(user_id)

        if target.role == UserRole.SUPER_ADMIN:
            raise BadRequestException(
                "Tenant role management does not apply to super admin accounts "
                "(use the platform-role endpoint for those)."
            )
        if target.id == actor.id:
            raise ForbiddenException("You cannot change your own role.")
        if new_role not in _TENANT_ROLES:
            raise BadRequestException(
                f"Target role must be a tenant role (allowed: {[r.value for r in _TENANT_ROLES]})."
            )

        from app.core.dependencies import can_create_role

        if not can_create_role("super_admin", new_role.value):
            raise ForbiddenException(
                f"Role 'super_admin' cannot assign the tenant role '{new_role.value}'."
            )

        old_role = target.role
        target.role = new_role
        self._audit.log_no_commit(
            actor_id=getattr(actor, "id", None),
            actor_role="super_admin",
            action=PlatformAuditAction.UPDATE,
            entity_type="User",
            entity_id=target.id,
            organization_id=target.organization_id,
            old_values={"role": old_role.value},
            new_values={"role": new_role.value},
            metadata={"field": "role", "plane": "TENANT"},
            reason=self._clean(reason),
        )
        return target

    # ── Membership move ──────────────────────────────────────────────────────

    def set_membership(
        self, *, actor: User, user_id: int, organization_id: int | None, reason: str
    ) -> User:
        self._require_reason(reason)
        target = self.get_user(user_id)

        if target.role == UserRole.SUPER_ADMIN:
            raise ForbiddenException(
                "Platform accounts (super admins) can never be moved into, or stripped of, "
                "a tenant membership."
            )
        if target.organization_id == organization_id:
            raise BadRequestException("User already belongs to this organization scope.")

        if organization_id is not None:
            self.get_organization(organization_id)

        old_org = target.organization_id
        target.organization_id = organization_id
        self._audit.log_no_commit(
            actor_id=getattr(actor, "id", None),
            actor_role="super_admin",
            action=PlatformAuditAction.UPDATE,
            entity_type="User",
            entity_id=target.id,
            organization_id=organization_id,
            old_values={"organization_id": old_org},
            new_values={"organization_id": organization_id},
            metadata={"field": "membership", "plane": "TENANT"},
            reason=self._clean(reason),
        )
        return target

    # ── Status flip ──────────────────────────────────────────────────────────

    def set_status(self, *, actor: User, user_id: int, is_active: bool, reason: str) -> User:
        self._require_reason(reason)
        target = self.get_user(user_id)

        if target.id == actor.id and not is_active:
            raise BadRequestException("You cannot deactivate your own account.")
        if target.is_active == is_active:
            raise BadRequestException(
                f"User is already {'active' if is_active else 'inactive'}."
            )

        target.is_active = is_active
        self._audit.log_no_commit(
            actor_id=getattr(actor, "id", None),
            actor_role="super_admin",
            action=PlatformAuditAction.ACTIVATE if is_active else PlatformAuditAction.DEACTIVATE,
            entity_type="User",
            entity_id=target.id,
            organization_id=target.organization_id,
            old_values={"is_active": not is_active},
            new_values={"is_active": is_active},
            metadata={"field": "status", "plane": "TENANT"},
            reason=self._clean(reason),
        )
        return target

    # ── helpers ──────────────────────────────────────────────────────────────

    @staticmethod
    def _require_reason(reason: str) -> None:
        if not reason or not reason.strip():
            raise BadRequestException("A documented reason is required for every administrator/user mutation.")

    @staticmethod
    def _clean(reason: str) -> str:
        return reason.strip()
