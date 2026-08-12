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
)
from sqlalchemy.orm import relationship

from app.database import Base


class UserRole(str, enum.Enum):
    SUPER_ADMIN = "super_admin"
    ORG_ADMIN = "org_admin"
    BILLING_ADMIN = "billing_admin"


class User(Base):
    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)
    email = Column(String(200), unique=True, index=True, nullable=False)
    hashed_password = Column(String(255), nullable=False)

    role = Column(Enum(UserRole), nullable=False, default=UserRole.BILLING_ADMIN)
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
