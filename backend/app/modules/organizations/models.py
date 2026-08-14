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

from app.core.db_types import CaseInsensitiveEnum
from app.database import Base
from app.modules.commercial.enums import BillingClassification, BillingSource


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
    city = Column(String(100), nullable=True)
    state = Column(String(100), nullable=True)
    country = Column(String(100), nullable=True)
    postal_code = Column(String(20), nullable=True)
    email = Column(String(200), nullable=True)
    phone = Column(String(40), nullable=True)
    website = Column(String(500), nullable=True)
    legal_name = Column(String(255), nullable=True)
    # Single column covering GST/PAN/VAT/TIN.
    tax_no = Column(String(50), nullable=True)
    registration_number = Column(String(100), nullable=True)

    # Read by billing's product_service._resolve_org_currency() as the org's
    # base-currency fallback, and by recurring_billing.py's due-subscription
    # scan. ISO-4217 / IANA identifiers.
    currency = Column(String(3), nullable=False, default="USD", server_default="USD")
    timezone = Column(String(100), nullable=False, default="UTC", server_default="UTC")

    # MM-DD format, matching BillingConfiguration.fiscal_year_start/end so the
    # registration data can seed the billing configuration without reformatting.
    fiscal_year_start = Column(String(5), default="01-01", server_default="01-01")
    fiscal_year_end = Column(String(5), default="12-31", server_default="12-31")

    # Commercial-plane stamps (ZB-COM-BILL-001). Set server-side at
    # registration, never accepted from the client, and consumed by the
    # double-charge prevention check. Stored as the enum NAME by
    # CaseInsensitiveEnum.
    billing_classification = Column(
        CaseInsensitiveEnum(BillingClassification),
        default=BillingClassification.COMMERCIAL_STANDALONE,
        server_default="COMMERCIAL_STANDALONE",
        nullable=False,
    )
    billing_source = Column(
        CaseInsensitiveEnum(BillingSource),
        default=BillingSource.REGISTERED_VIA_STANDALONE,
        server_default="REGISTERED_VIA_STANDALONE",
        nullable=False,
    )

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

    # 1:1 platform-plane relationship (PHASE 6). The CommercialAccount is the
    # org's commercial relationship with Zoiko — distinct from the Billing
    # module's BillingCustomer. billing_source/classification stay here as the
    # Phase 1 server-stamped source of truth.
    commercial_account = relationship(
        "CommercialAccount",
        back_populates="organization",
        uselist=False,
    )

    def __repr__(self):
        return f"<Organization id={self.id} code={self.organization_code} name={self.organization_name!r}>"
