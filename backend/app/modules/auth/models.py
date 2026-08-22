"""
modules/auth/models.py
----------------------
User + single-use security action tokens.

User is the login-user record for the whole platform. It replaces the old
platform's `employees` table as the target of every created_by/approved_by
style FK in the Billing module (those FK strings are remapped from
"employees.id" to "users.id").

Roles:
    super_admin    → platform-level, organization_id is NULL
    org_admin      → owns an organization
    billing_admin  → runs billing day-to-day inside an org
"""

import enum
from datetime import datetime

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Enum,
    ForeignKey,
    Integer,
    String,
    Text,
)
from sqlalchemy.orm import relationship

from app.core.db_types import CaseInsensitiveEnum

from app.database import Base


class UserRole(str, enum.Enum):
    SUPER_ADMIN = "super_admin"
    ORG_ADMIN = "org_admin"
    BILLING_ADMIN = "billing_admin"
    # §25 Segregation-of-Duties Doctrine: distinct approver/read-only roles so
    # maker-checker gates (refunds/write-offs/credit-notes/discounts) have a
    # role to require that isn't the same one that can create the request.
    FINANCE_APPROVER = "finance_approver"
    AUDITOR = "auditor"


class PlatformRole(str, enum.Enum):
    """ZB-SA-CMD-003 §26 — a second, ORTHOGONAL dimension applying only to
    users with UserRole.SUPER_ADMIN. `role=super_admin` remains the floor
    every Command Center endpoint checks first (unchanged); `platform_role`
    narrows WHICH capabilities that specific super_admin account holds
    within the Command Center surface — see app/core/capabilities.py.

    NULL (unset) is treated as PLATFORM_ADMINISTRATOR (full access) for
    backward compatibility — every super_admin account that existed before
    this column was added keeps exactly the access it had before, with no
    data migration required.
    """
    PLATFORM_ADMINISTRATOR = "platform_administrator"
    SUPPORT_OPERATOR = "support_operator"
    SECURITY_OPERATOR = "security_operator"
    RELIABILITY_OPERATOR = "reliability_operator"
    AUDITOR = "auditor"
    FINANCE_READONLY = "finance_readonly"


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String(200), unique=True, index=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)

    role = Column(Enum(UserRole), nullable=False, default=UserRole.BILLING_ADMIN)
    # Only meaningful when role=SUPER_ADMIN (ZB-SA-CMD-003 §26 capability
    # scaffolding — see PlatformRole docstring). CaseInsensitiveEnum
    # (VARCHAR-backed), matching every other enum column added to this
    # schema after initial table creation, so no native Postgres ENUM TYPE
    # DDL is needed from the self-healing _add_missing_columns() path.
    platform_role = Column(CaseInsensitiveEnum(PlatformRole), nullable=True)
    # NULL for super_admin; required for every org-scoped role.
    organization_id = Column(
        Integer,
        ForeignKey("organizations.id", ondelete="CASCADE"),
        index=True,
        nullable=True,
    )

    first_name = Column(String(120), nullable=False)
    last_name = Column(String(120), nullable=False)
    phone = Column(String(40), nullable=True)

    is_active = Column(Boolean, default=True, nullable=False)
    is_verified = Column(Boolean, default=False, nullable=False)

    # ZB-SA-P3 (Phase 3B): real evidence of the last successful login,
    # stamped by auth/service.login(). NULL means "never logged in" and is
    # reported honestly as UNKNOWN — never inferred or fabricated.
    last_login_at = Column(DateTime, nullable=True)

    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    organization = relationship(
        "Organization",
        back_populates="users",
        foreign_keys=[organization_id],
    )

    @property
    def full_name(self) -> str:
        return f"{self.first_name} {self.last_name}".strip()

    def __repr__(self):
        return f"<User id={self.id} email={self.email!r} role={self.role}>"


class SecurityActionPurpose(str, enum.Enum):
    INVITE = "invite"
    RESET = "reset"


class SecurityActionToken(Base):
    """Single-use action token (invite / password reset). Only the SHA-256
    hash is stored; the raw token goes in the emailed link."""

    __tablename__ = "security_action_tokens"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String(200), index=True, nullable=False)
    organization_id = Column(
        Integer,
        ForeignKey("organizations.id", ondelete="CASCADE"),
        nullable=True,
    )
    purpose = Column(Enum(SecurityActionPurpose), nullable=False)
    token_hash = Column(String(64), unique=True, index=True, nullable=False)
    expires_at = Column(DateTime, nullable=False)
    used_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


# ── Super Admin MFA (TOTP) — Release-Blocker Pass, Blocker 4 ────────────────
# Backend-enforced: the full-privilege access/refresh token pair is only
# minted after a real TOTP (or recovery-code) verification server-side (see
# auth/service.py's login/mfa_* functions). A frontend flag can never
# substitute for this — there is no code path that hands out a real access
# token for a super_admin without going through here first.
#
# Scoped to role=SUPER_ADMIN only, matching this entire engagement's
# boundary (org_admin/billing_admin authentication is explicitly untouched).

class SuperAdminMFA(Base):
    """One row per Super Admin user. `secret_encrypted` is a Fernet-encrypted
    TOTP secret (core/mfa_crypto.py) — the raw secret is never persisted and
    is only ever shown to the user once, at enrollment time."""

    __tablename__ = "super_admin_mfa"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), unique=True, nullable=False, index=True)
    secret_encrypted = Column(Text, nullable=False)
    is_enabled = Column(Boolean, default=False, nullable=False)

    # Brute-force protection independent of the IP-based slowapi rate limit
    # on the endpoint — this blocks a distributed attempt against one
    # account regardless of source IP.
    failed_attempts = Column(Integer, default=0, nullable=False)
    locked_until = Column(DateTime, nullable=True)

    # TOTP replay protection (session 5 security hardening): a bare
    # window-based `pyotp.verify()` accepts the SAME code again for its
    # whole validity window (~90s with valid_window=1) — a code observed
    # once (shoulder-surfed, logged, intercepted) could otherwise be
    # replayed to complete a second login or step-up within that window.
    # Only the SHA-256 hash is stored, matching the recovery-code pattern.
    last_used_code_hash = Column(String(64), nullable=True)
    last_used_code_at = Column(DateTime, nullable=True)

    enrolled_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    enabled_at = Column(DateTime, nullable=True)
    disabled_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    user = relationship("User", foreign_keys=[user_id])


class SuperAdminMFARecoveryCode(Base):
    """Single-use recovery codes, stored only as a SHA-256 hash (same
    never-store-the-raw-value pattern as SecurityActionToken above). The raw
    code is shown to the user exactly once, at generation time."""

    __tablename__ = "super_admin_mfa_recovery_codes"

    id = Column(Integer, primary_key=True, index=True)
    mfa_id = Column(Integer, ForeignKey("super_admin_mfa.id", ondelete="CASCADE"), nullable=False, index=True)
    code_hash = Column(String(64), unique=True, index=True, nullable=False)
    used_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    mfa = relationship("SuperAdminMFA", foreign_keys=[mfa_id])
