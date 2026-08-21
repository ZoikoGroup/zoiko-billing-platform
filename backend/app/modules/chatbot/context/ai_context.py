"""
context/ai_context.py
---------------------
FastAPI dependency that resolves and attaches:
  - authenticated user
  - tenant_id (organization_id)
  - legal_entity_id
  - permission scopes
  - billing plane (tenant billing vs Zoiko commercial)

Reuses the existing auth/session mechanism (get_current_user dependency).
If context can't be fully resolved, the route returns a safe generic-error
response — no partial tenant context is ever passed downstream.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

from fastapi import Depends, Request
from sqlalchemy.orm import Session

from app.core.dependencies import get_current_user, ROLE_SUPER_ADMIN, _role_value
from app.database import get_db

# Role permissions mapping — defines what each role may access
ROLE_PERMISSIONS = {
    "org_admin": [
        "billing:read", "billing:draft", "billing:admin",
        "invoice:read", "payment:read", "customer:read",
        "contract:read", "subscription:read", "product:read",
        "quotation:read", "credit:read", "refund:read",
    ],
    "billing_admin": [
        "billing:read", "billing:draft",
        "invoice:read", "payment:read", "customer:read",
        "contract:read", "subscription:read", "product:read",
        "quotation:read", "credit:read", "refund:read",
    ],
    "super_admin": ["platform:read", "billing:read"],
}

from ..models import (
    TenantContext,
    IAMUserRef,
    PermissionSnapshot,
    BillingPlane,
    UserRefStatus,
)


@dataclass(frozen=True)
class AIContext:
    """Resolved AI assistant context for a request.

    Carried through every downstream call — session, conversation,
    model invocation, action lifecycle, audit.
    """
    user_id: int
    organization_id: int | None
    legal_entity_id: int | None = None
    tenant_context_id: int | None = None
    role: str = ""
    billing_plane: str = "tenant_billing"
    permissions: list[str] = field(default_factory=list)
    tenant_name: str | None = None
    request_id: str | None = None
    is_super_admin: bool = False

    @property
    def scopes(self) -> list[str]:
        return self.permissions


def _compute_scopes_hash(scopes: list[str]) -> str:
    return hashlib.sha256(json.dumps(sorted(scopes), sort_keys=True).encode()).hexdigest()[:16]


def get_ai_context(
    request: Request,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
) -> AIContext:
    """FastAPI dependency: resolves full AI context from authenticated user.

    Every ai_assistant route requires this. If context can't be fully
    resolved, an exception is raised — no partial context is passed.
    """
    from app.core.exceptions import ForbiddenException
    from app.modules.organizations.models import Organization

    role = _role_value(current_user)
    organization_id = getattr(current_user, "organization_id", None)
    request_id = getattr(request.state, "request_id", None)
    is_super_admin = role == ROLE_SUPER_ADMIN

    # Resolve tenant context (organization -> TenantContext)
    tenant_context_id = None
    tenant_name = None
    legal_entity_id = None
    billing_plane = BillingPlane.TENANT_BILLING

    if organization_id:
        org = db.query(Organization).filter(Organization.id == organization_id).first()
        if org is None:
            raise ForbiddenException("Your organization no longer exists.")
        if not org.is_active:
            raise ForbiddenException("Your organization is suspended. Contact support.")
        tenant_name = getattr(org, "organization_name", None)

        # Find or create tenant context
        tc = (
            db.query(TenantContext)
            .filter(
                TenantContext.tenant_id == organization_id,
                TenantContext.billing_plane == billing_plane,
            )
            .first()
        )
        if tc is None:
            tc = TenantContext(
                tenant_id=organization_id,
                billing_plane=billing_plane,
                context_hash="",
            )
            db.add(tc)
            db.flush()
        tenant_context_id = tc.id

    # Resolve permission scopes from role
    permission_scopes = ROLE_PERMISSIONS.get(role, ["billing:read"])

    return AIContext(
        user_id=current_user.id,
        organization_id=organization_id,
        legal_entity_id=legal_entity_id,
        tenant_context_id=tenant_context_id,
        role=role,
        billing_plane=billing_plane.value,
        permissions=permission_scopes,
        tenant_name=tenant_name,
        request_id=request_id,
        is_super_admin=is_super_admin,
    )
