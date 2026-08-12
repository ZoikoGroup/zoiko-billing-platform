"""
modules/organizations/models.py
-------------------------------
Organization model — the multi-tenant root entity of the standalone Billing
Platform. Replaces the old platform's hr.models.Organization.

Every billing row is scoped by organization_id; Super Admin is the only
role that may see across organizations.
"""

from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, Integer, String, Text, ForeignKey
from sqlalchemy.orm import relationship

from app.database import Base


class Organization(Base):
    __tablename__ = "organizations"

    id = Column(Integer, primary_key=True, index=True)
    organization_name = Column(String(200), nullable=False)
    organization_code = Column(String(20), unique=True, index=True, nullable=False)

    # Falls back to organization_name when unset — read by pdf_service.py /
    # email_service.py when rendering invoice/quote PDFs and branded emails.
    display_name = Column(String(200), nullable=True)

    # Contact / registration details
    industry = Column(String(100), nullable=True)
    address = Column(Text, nullable=True)
    email = Column(String(200), nullable=True)
    phone = Column(String(40), nullable=True)
    # Single column covering GST/PAN/VAT/TIN.
    tax_no = Column(String(50), nullable=True)
    registration_number = Column(String(100), nullable=True)

    # Read by billing's product_service._resolve_org_currency() as the org's
    # base-currency fallback, and by recurring_billing.py's due-subscription
    # scan. ISO-4217 / IANA identifiers.
    currency = Column(String(3), nullable=False, default="USD", server_default="USD")
    timezone = Column(String(100), nullable=False, default="UTC", server_default="UTC")

    # Tenant is onboarded by /auth/register and becomes active immediately.
    # Super Admin may suspend it.
    is_active = Column(Boolean, default=True, nullable=False)

    created_by_user_id = Column(
        Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    users = relationship(
        "User",
        back_populates="organization",
        foreign_keys="[User.organization_id]",
    )

    def __repr__(self):
        return f"<Organization id={self.id} code={self.organization_code} name={self.organization_name!r}>"
