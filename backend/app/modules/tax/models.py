"""
app/modules/tax/models.py
-------------------------
Tenant-private tax domain tables (ZB-TAX-ARCH-001).

Phase 0 introduces the issuing seller legal entity. Per §02 and §07, tax
registrations, establishments, nexus and remittance responsibilities belong
to the *issuing legal entity*, not automatically to the whole tenant; every
later tenant-private tax object (registrations, activation records, quotes,
snapshots) keys off ``seller_legal_entities.id``.

Each organization gets exactly one default entity, backfilled from its
existing profile, so single-entity tenants see no behavioural change. A
partial unique index guarantees at most one default per organization.

Global public reference data (jurisdictions, rate versions, legal sources)
will live in separate, non-tenant tables introduced in Phase 1 — it must
never share tables with these tenant-private records (§12.1).
"""
from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.core.db_types import CaseInsensitiveEnum
from app.database import Base
from app.modules.tax.enums import EntityTaxRegime


class SellerLegalEntity(Base):
    __tablename__ = "seller_legal_entities"

    id                   = Column(Integer, primary_key=True, index=True)
    organization_id      = Column(Integer, ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False, index=True)
    entity_code          = Column(String(50), nullable=False)
    legal_name           = Column(String(255), nullable=False)
    display_name         = Column(String(255), nullable=True)

    # Establishment / home jurisdiction. ISO codes only — free-text country
    # names are normalized on write (resolve_country_code) so later phases
    # can join to the Phase 1 jurisdiction registry without guesswork.
    country_code         = Column(String(2), nullable=True, index=True)      # ISO 3166-1 alpha-2
    subdivision_code     = Column(String(6), nullable=True)                  # ISO 3166-2 suffix, e.g. "ON", "NY"
    address_line1        = Column(String(255), nullable=True)
    address_line2        = Column(String(255), nullable=True)
    city                 = Column(String(100), nullable=True)
    postal_code          = Column(String(20), nullable=True)
    timezone             = Column(String(100), nullable=True)                # IANA; jurisdiction-local tax date (T03/T17)

    # Primary identifiers. Per-jurisdiction registrations with effective
    # dates arrive in Phase 2 (entity_tax_registrations); this is the
    # entity's headline identifier only. Tenant-private (§12.1).
    primary_tax_id       = Column(String(100), nullable=True)
    primary_tax_id_type  = Column(String(50), nullable=True)
    registration_number  = Column(String(100), nullable=True)

    is_merchant_of_record = Column(Boolean, nullable=False, default=True, server_default=text("true"))
    tax_regime           = Column(
        CaseInsensitiveEnum(EntityTaxRegime),
        nullable=False,
        default=EntityTaxRegime.LEGACY_MANUAL,
        server_default=EntityTaxRegime.LEGACY_MANUAL.name,
    )

    is_default           = Column(Boolean, nullable=False, default=False, server_default=text("false"))
    is_active            = Column(Boolean, nullable=False, default=True, server_default=text("true"))
    notes                = Column(Text, nullable=True)
    created_by           = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_by           = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    created_at           = Column(DateTime(timezone=True), server_default=func.now())
    updated_at           = Column(DateTime(timezone=True), onupdate=func.now())
    version              = Column(Integer, nullable=False, default=1, server_default="1")

    organization         = relationship("Organization", foreign_keys=[organization_id])

    __table_args__ = (
        UniqueConstraint("organization_id", "entity_code", name="uq_seller_legal_entities_org_code"),
        # At most one default entity per organization.
        Index(
            "uq_seller_legal_entities_one_default",
            "organization_id",
            unique=True,
            sqlite_where=text("is_default = 1"),
            postgresql_where=text("is_default = true"),
        ),
    )

    def __repr__(self):
        return f"<SellerLegalEntity id={self.id} org={self.organization_id} code={self.entity_code}>"
