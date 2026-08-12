"""
modules/super_admin/models.py
-----------------------------
Platform-level configuration for the standalone Billing Platform.

Deliberately minimal: the old platform's super_admin module held
PlatformProduct / OrganizationProduct / AuditLog / LoginActivity tables
that the Billing module never imports. The standalone platform keeps only
PlatformSetting (key/value config, e.g. SMTP override) plus platform-wide
aggregate queries in the router.
"""

from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, Integer, String, Text

from app.database import Base


class PlatformSetting(Base):
    __tablename__ = "platform_settings"

    id = Column(Integer, primary_key=True, index=True)
    key = Column(String(100), unique=True, index=True, nullable=False)
    value = Column(Text, nullable=True)
    description = Column(String(500), nullable=True)
    # Read by billing's admin_service.py / email_service.py to select the
    # SMTP override rows (category == "email").
    category = Column(String(100), nullable=False, default="general", server_default="general")
    is_public = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    def __repr__(self):
        return f"<PlatformSetting key={self.key!r}>"
