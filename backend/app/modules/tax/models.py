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
    DDL,
    JSON,
    Boolean,
    Column,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Numeric,
    Text,
    UniqueConstraint,
    event,
    text,
)
from sqlalchemy import inspect as sa_inspect
from sqlalchemy.orm import Session, relationship
from sqlalchemy.sql import func

from app.core.db_types import CaseInsensitiveEnum
from app.core.exceptions import ZoikoException
from app.database import Base
from app.modules.tax.enums import (
    AddressConfidence,
    AddressRole,
    CertificateStatus,
    EntityTaxRegime,
    EvidenceSource,
    RegistrationStatus,
    ReviewItemKind,
    ReviewItemStatus,
    TaxOperatingMode,
    TenantApprovalStatus,
    TransactionClass,
    VerificationStatus,
)


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


# ═════════════════════════════════════════════════════════════════════════
# Phase 2 — tenant-private obligations, activation, classification and
# buyer evidence (ZB-TAX-ARCH-001 §05, §07, §08.1, §12.1).
#
# Every table carries organization_id and is only reachable through
# tenant-scoped routes (get_organization_id). Decided records are never
# edited in place: a change is a new row and the old one is SUPERSEDED.
# Retention vs. erasure: key fields are frozen by Postgres triggers, and rows
# can only be deleted by the tenant erasure purge, which sets the
# transaction-scoped flag zoiko.tax_erasure (see TAX_PHASE2.md for the open
# statutory-retention question).
# ═════════════════════════════════════════════════════════════════════════

def _org_fk():
    return Column(Integer, ForeignKey("organizations.id", ondelete="RESTRICT"), nullable=False, index=True)


def _fk(target, **kw):
    return Column(Integer, ForeignKey(target, ondelete="RESTRICT"), **kw)


def _user_fk():
    return Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class EntityTaxRegistration(Base):
    """A seller entity's tax registration in one jurisdiction (§07
    LegalEntityTaxProfile). Key fields are immutable; the validity end,
    status and verification may be recorded later."""
    __tablename__ = "entity_tax_registrations"

    id                      = Column(Integer, primary_key=True, index=True)
    organization_id         = _org_fk()
    seller_entity_id        = _fk("seller_legal_entities.id", nullable=False, index=True)
    jurisdiction_id         = _fk("tax_jurisdictions.id", nullable=False)
    tax_type_id             = _fk("tax_type_definitions.id", nullable=False)
    registration_number     = Column(String(100), nullable=False)
    valid_from              = Column(Date, nullable=False)
    valid_to                = Column(Date, nullable=True)        # exclusive; NULL = open-ended
    status                  = Column(CaseInsensitiveEnum(RegistrationStatus), nullable=False,
                                     default=RegistrationStatus.ACTIVE, server_default=RegistrationStatus.ACTIVE.name)
    verification_status     = Column(CaseInsensitiveEnum(VerificationStatus), nullable=False,
                                     default=VerificationStatus.UNVERIFIED, server_default=VerificationStatus.UNVERIFIED.name)
    verification_method     = Column(String(100), nullable=True)
    verification_response   = Column(JSON, nullable=True)
    verified_at             = Column(DateTime(timezone=True), nullable=True)
    verification_expires_at = Column(DateTime(timezone=True), nullable=True)
    evidence_ref            = Column(String(500), nullable=True)
    notes                   = Column(Text, nullable=True)
    created_by              = _user_fk()
    created_at              = Column(DateTime(timezone=True), nullable=False)
    updated_by              = _user_fk()
    updated_at              = Column(DateTime(timezone=True), nullable=True)

    jurisdiction            = relationship("TaxJurisdiction")
    tax_type                = relationship("TaxTypeDefinition")


class EntityTaxLegalBasis(Base):
    """A recorded legal basis for collecting tax without a registration,
    approved by tenant maker-checker. Never a free-text field on an
    activation."""
    __tablename__ = "entity_tax_legal_bases"

    id               = Column(Integer, primary_key=True, index=True)
    organization_id  = _org_fk()
    seller_entity_id = _fk("seller_legal_entities.id", nullable=False, index=True)
    jurisdiction_id  = _fk("tax_jurisdictions.id", nullable=False)
    tax_type_id      = _fk("tax_type_definitions.id", nullable=False)
    legal_basis      = Column(Text, nullable=False)
    evidence_ref     = Column(String(500), nullable=False)
    valid_from       = Column(Date, nullable=False)
    valid_to         = Column(Date, nullable=True)
    status           = Column(CaseInsensitiveEnum(TenantApprovalStatus), nullable=False, index=True,
                              default=TenantApprovalStatus.PROPOSED, server_default=TenantApprovalStatus.PROPOSED.name)
    recorded_by      = _user_fk()
    approved_by      = _user_fk()
    approved_at      = Column(DateTime(timezone=True), nullable=True)
    decision_reason  = Column(Text, nullable=True)
    predecessor_id   = _fk("entity_tax_legal_bases.id", nullable=True)
    created_at       = Column(DateTime(timezone=True), nullable=False)
    superseded_at    = Column(DateTime(timezone=True), nullable=True)


class EntityTaxActivation(Base):
    """Tenant activation: seller entity × jurisdiction × tax type × transaction
    class -> calculating mode. Only APPROVED rows are live, and even then the
    effective state is recomputed at use time (current platform availability,
    registration or legal-basis validity)."""
    __tablename__ = "entity_tax_activations"

    id                      = Column(Integer, primary_key=True, index=True)
    organization_id         = _org_fk()
    seller_entity_id        = _fk("seller_legal_entities.id", nullable=False, index=True)
    jurisdiction_id         = _fk("tax_jurisdictions.id", nullable=False)
    tax_type_id             = _fk("tax_type_definitions.id", nullable=False)
    transaction_class       = Column(CaseInsensitiveEnum(TransactionClass), nullable=False)
    mode                    = Column(CaseInsensitiveEnum(TaxOperatingMode), nullable=False)
    effective_from          = Column(Date, nullable=False)
    effective_to            = Column(Date, nullable=True)
    registration_id         = _fk("entity_tax_registrations.id", nullable=True)
    legal_basis_id          = _fk("entity_tax_legal_bases.id", nullable=True)
    # Platform availability version in force when the activation was approved.
    availability_version_id = _fk("tax_market_availability_versions.id", nullable=True)
    # TENANT_CONFIG_APPROVED only: the tenant's own rate and legal source,
    # always labelled "tenant-configured, not verified by Zoiko".
    tenant_rate_percent     = Column(Numeric(9, 6), nullable=True)
    tenant_source_citation  = Column(Text, nullable=True)
    tenant_source_url       = Column(String(1000), nullable=True)
    # PROVIDER_APPROVED only: the tenant's approved provider connection (Phase 4a-2).
    provider_connection_id  = _fk("tax_provider_connections.id", nullable=True)
    status                  = Column(CaseInsensitiveEnum(TenantApprovalStatus), nullable=False, index=True,
                                     default=TenantApprovalStatus.PROPOSED, server_default=TenantApprovalStatus.PROPOSED.name)
    proposed_by             = _user_fk()
    approved_by             = _user_fk()
    approved_at             = Column(DateTime(timezone=True), nullable=True)
    decision_reason         = Column(Text, nullable=True)
    predecessor_id          = _fk("entity_tax_activations.id", nullable=True)
    created_at              = Column(DateTime(timezone=True), nullable=False)
    superseded_at           = Column(DateTime(timezone=True), nullable=True)

    jurisdiction            = relationship("TaxJurisdiction")
    tax_type                = relationship("TaxTypeDefinition")
    registration            = relationship("EntityTaxRegistration")
    legal_basis             = relationship("EntityTaxLegalBasis")

    __table_args__ = (
        Index("uq_entity_tax_activations_one_approved",
              "organization_id", "seller_entity_id", "jurisdiction_id", "tax_type_id", "transaction_class",
              unique=True, sqlite_where=text("status = 'APPROVED'"), postgresql_where=text("status = 'APPROVED'")),
    )


class ProductTaxClassification(Base):
    """Product -> platform tax code, with review workflow and history."""
    __tablename__ = "product_tax_classifications"

    id                     = Column(Integer, primary_key=True, index=True)
    organization_id        = _org_fk()
    product_id             = _fk("products.id", nullable=False, index=True)
    tax_code_id            = _fk("tax_codes.id", nullable=False)
    reason                 = Column(Text, nullable=True)
    status                 = Column(CaseInsensitiveEnum(TenantApprovalStatus), nullable=False, index=True,
                                    default=TenantApprovalStatus.PROPOSED, server_default=TenantApprovalStatus.PROPOSED.name)
    proposed_by            = _user_fk()
    approved_by            = _user_fk()
    approved_at            = Column(DateTime(timezone=True), nullable=True)
    decision_reason        = Column(Text, nullable=True)
    # The organization's classification version this approval produced.
    classification_version = Column(Integer, nullable=True)
    predecessor_id         = _fk("product_tax_classifications.id", nullable=True)
    created_at             = Column(DateTime(timezone=True), nullable=False)
    superseded_at          = Column(DateTime(timezone=True), nullable=True)

    tax_code               = relationship("TaxCode")

    __table_args__ = (
        Index("uq_product_tax_classifications_one_approved", "organization_id", "product_id", unique=True,
              sqlite_where=text("status = 'APPROVED'"), postgresql_where=text("status = 'APPROVED'")),
    )


class TaxClassificationCounter(Base):
    """Per-organization classification version, bumped atomically on every
    approved mapping change (UPDATE ... SET version = version + 1)."""
    __tablename__ = "tax_classification_counters"

    organization_id = Column(Integer, ForeignKey("organizations.id", ondelete="RESTRICT"), primary_key=True)
    version         = Column(Integer, nullable=False, default=0, server_default="0")
    updated_at      = Column(DateTime(timezone=True), nullable=True)


class CustomerTaxAddress(Base):
    """Structured buyer location evidence. The free-text address fields on
    billing_customers are left untouched; this is additive."""
    __tablename__ = "customer_tax_addresses"

    id               = Column(Integer, primary_key=True, index=True)
    organization_id  = _org_fk()
    customer_id      = _fk("billing_customers.id", nullable=False, index=True)
    role             = Column(CaseInsensitiveEnum(AddressRole), nullable=False)
    country_code     = Column(String(2), nullable=True)       # ISO 3166-1 alpha-2; NULL when unknown
    subdivision_code = Column(String(6), nullable=True)       # ISO 3166-2 suffix
    postal_code      = Column(String(20), nullable=True)
    city             = Column(String(100), nullable=True)
    line1            = Column(String(255), nullable=True)      # street line (Phase 4a-1: provider place of supply)
    line2            = Column(String(255), nullable=True)
    confidence       = Column(CaseInsensitiveEnum(AddressConfidence), nullable=False)
    source           = Column(CaseInsensitiveEnum(EvidenceSource), nullable=False)
    source_field     = Column(String(50), nullable=True)      # e.g. "billing_country" for the backfill
    validated_at     = Column(DateTime(timezone=True), nullable=True)
    created_by       = _user_fk()
    created_at       = Column(DateTime(timezone=True), nullable=False)
    superseded_at    = Column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        Index("uq_customer_tax_addresses_one_current", "customer_id", "role", unique=True,
              sqlite_where=text("superseded_at IS NULL"), postgresql_where=text("superseded_at IS NULL")),
    )


class CustomerTaxId(Base):
    """A buyer tax identifier as entered, plus its verification state. The
    raw value is never reformatted; value_normalized only strips whitespace
    and upper-cases, for matching."""
    __tablename__ = "customer_tax_ids"

    id                    = Column(Integer, primary_key=True, index=True)
    organization_id       = _org_fk()
    customer_id           = _fk("billing_customers.id", nullable=False, index=True)
    value_raw             = Column(String(100), nullable=False)
    value_normalized      = Column(String(100), nullable=False)
    id_type               = Column(String(50), nullable=True)
    country_code          = Column(String(2), nullable=True)
    source                = Column(CaseInsensitiveEnum(EvidenceSource), nullable=False)
    source_field          = Column(String(50), nullable=True)    # legacy column it was backfilled from
    verification_status   = Column(CaseInsensitiveEnum(VerificationStatus), nullable=False,
                                   default=VerificationStatus.UNVERIFIED, server_default=VerificationStatus.UNVERIFIED.name)
    verification_method   = Column(String(100), nullable=True)
    verification_response = Column(JSON, nullable=True)
    verified_at           = Column(DateTime(timezone=True), nullable=True)
    expires_at            = Column(DateTime(timezone=True), nullable=True)
    created_by            = _user_fk()
    created_at            = Column(DateTime(timezone=True), nullable=False)
    superseded_at         = Column(DateTime(timezone=True), nullable=True)


class CustomerExemptionCertificate(Base):
    __tablename__ = "customer_exemption_certificates"

    id                 = Column(Integer, primary_key=True, index=True)
    organization_id    = _org_fk()
    customer_id        = _fk("billing_customers.id", nullable=False, index=True)
    certificate_number = Column(String(100), nullable=False)
    jurisdiction_id    = _fk("tax_jurisdictions.id", nullable=False)
    tax_type_id        = _fk("tax_type_definitions.id", nullable=True)   # NULL = every tax type there
    scope_description  = Column(Text, nullable=False)
    valid_from         = Column(Date, nullable=False)
    expires_at         = Column(Date, nullable=True)        # exclusive; NULL = no stated expiry
    evidence_ref       = Column(String(500), nullable=False)
    reason_code        = Column(String(50), nullable=True)      # e.g. RESALE, CHARITY, GOVERNMENT (Phase 4a-2)
    # The uploaded certificate document (tenant-scoped, write-once; Phase 4a-2).
    evidence_file_id   = _fk("tax_evidence_files.id", nullable=True)
    status             = Column(CaseInsensitiveEnum(CertificateStatus), nullable=False,
                                default=CertificateStatus.ACTIVE, server_default=CertificateStatus.ACTIVE.name)
    created_by         = _user_fk()
    created_at         = Column(DateTime(timezone=True), nullable=False)
    revoked_by         = _user_fk()
    revoked_at         = Column(DateTime(timezone=True), nullable=True)


class TaxAddressResolution(Base):
    """Phase 4c: one resolution of a buyer tax address to tax jurisdictions,
    kept as write-once evidence (resolver, source, precision, candidates)."""
    __tablename__ = "tax_address_resolutions"

    id                 = Column(Integer, primary_key=True, index=True)
    organization_id    = _org_fk()
    address_id         = _fk("customer_tax_addresses.id", nullable=False, index=True)
    resolver_name      = Column(String(100), nullable=False)
    source             = Column(String(200), nullable=False)
    dataset_version    = Column(String(100), nullable=True)        # the resolver's dataset, when it says
    status             = Column(String(20), nullable=False)        # ResolutionStatus name
    precision          = Column(String(20), nullable=True)         # ResolutionPrecision name
    candidates         = Column(Integer, nullable=False, default=0)
    jurisdiction_codes = Column(JSON, nullable=False)
    resolved_by        = _user_fk()
    resolved_at        = Column(DateTime(timezone=True), nullable=False)


class TaxPseudonymKeyRecord(Base):
    """Phase 4c: which TAX_PROVIDER_PSEUDONYM_KEY a tenant's provider records
    were made under, by fingerprint (never the key). A changed key blocks
    provider issuing until two people acknowledge the new fingerprint (after
    remapping the provider's customer records)."""
    __tablename__ = "tax_pseudonym_key_records"

    id              = Column(Integer, primary_key=True, index=True)
    organization_id = _org_fk()
    fingerprint     = Column(String(32), nullable=True)            # None = no key
    reason          = Column(Text, nullable=True)
    status          = Column(CaseInsensitiveEnum(TenantApprovalStatus), nullable=False, index=True,
                             default=TenantApprovalStatus.PROPOSED, server_default=TenantApprovalStatus.PROPOSED.name)
    proposed_by     = _user_fk()
    approved_by     = _user_fk()
    approved_at     = Column(DateTime(timezone=True), nullable=True)
    decision_reason = Column(Text, nullable=True)
    created_at      = Column(DateTime(timezone=True), nullable=False)

    __table_args__ = (
        Index("uq_tax_pseudonym_key_records_one_open", "organization_id", unique=True,
              sqlite_where=text("status = 'PROPOSED'"), postgresql_where=text("status = 'PROPOSED'")),
    )


class TaxEvidenceFile(Base):
    """Tenant-scoped, content-addressed, write-once evidence documents
    (exemption certificates). Never served to platform roles (T13); deleted
    only by the tenant erasure purge."""
    __tablename__ = "tax_evidence_files"

    id              = Column(Integer, primary_key=True, index=True)
    organization_id = _org_fk()
    sha256          = Column(String(64), nullable=False)
    media_type      = Column(String(100), nullable=False)
    size_bytes      = Column(Integer, nullable=False)
    filename        = Column(String(255), nullable=True)
    content         = Column(LargeBinary, nullable=False)
    uploaded_by     = _user_fk()
    created_at      = Column(DateTime(timezone=True), nullable=False)

    __table_args__ = (UniqueConstraint("organization_id", "sha256", name="uq_tax_evidence_files_org_sha256"),)


class TaxRegimeChange(Base):
    """A proposed change of a seller entity's tax regime, in either direction
    (product question 6). Proposed by an org admin, decided by a different
    finance approver; nothing changes regime on one person's say-so."""
    __tablename__ = "tax_regime_changes"

    id               = Column(Integer, primary_key=True, index=True)
    organization_id  = _org_fk()
    seller_entity_id = _fk("seller_legal_entities.id", nullable=False, index=True)
    from_regime      = Column(String(30), nullable=False)
    to_regime        = Column(String(30), nullable=False)
    reason           = Column(Text, nullable=True)
    eligibility      = Column(JSON, nullable=True)            # snapshot at proposal
    status           = Column(CaseInsensitiveEnum(TenantApprovalStatus), nullable=False, index=True,
                              default=TenantApprovalStatus.PROPOSED, server_default=TenantApprovalStatus.PROPOSED.name)
    proposed_by      = _user_fk()
    approved_by      = _user_fk()
    approved_at      = Column(DateTime(timezone=True), nullable=True)
    decision_reason  = Column(Text, nullable=True)
    created_at       = Column(DateTime(timezone=True), nullable=False)

    __table_args__ = (
        Index("uq_tax_regime_changes_one_open", "seller_entity_id", unique=True,
              sqlite_where=text("status = 'PROPOSED'"), postgresql_where=text("status = 'PROPOSED'")),
    )


class TaxReviewItem(Base):
    """Tenant-private review queue (T14). Deliberately NOT the platform
    AttentionItem, which super admins can read."""
    __tablename__ = "tax_review_items"

    id              = Column(Integer, primary_key=True, index=True)
    organization_id = _org_fk()
    kind            = Column(CaseInsensitiveEnum(ReviewItemKind), nullable=False)
    subject_type    = Column(String(50), nullable=False)
    subject_id      = Column(Integer, nullable=False)
    due_date        = Column(Date, nullable=True)
    detail          = Column(Text, nullable=True)
    status          = Column(CaseInsensitiveEnum(ReviewItemStatus), nullable=False, index=True,
                             default=ReviewItemStatus.OPEN, server_default=ReviewItemStatus.OPEN.name)
    owner_role      = Column(String(50), nullable=True)        # who acts on it (Phase 4d-0)
    created_at      = Column(DateTime(timezone=True), nullable=False)
    resolved_at     = Column(DateTime(timezone=True), nullable=True)
    resolved_by     = _user_fk()

    __table_args__ = (
        Index("uq_tax_review_items_one_open", "organization_id", "kind", "subject_type", "subject_id", unique=True,
              sqlite_where=text("status = 'OPEN'"), postgresql_where=text("status = 'OPEN'")),
    )


# (table, key fields, statuses in which they are frozen; "*" = always).
# Shared by the Postgres triggers below and the ORM guard in tenant_tax_service.
TENANT_RECORD_GUARDS = (
    ("entity_tax_registrations",
     ("organization_id", "seller_entity_id", "jurisdiction_id", "tax_type_id", "registration_number",
      "valid_from", "created_by", "created_at"), "*"),
    ("entity_tax_legal_bases",
     ("organization_id", "seller_entity_id", "jurisdiction_id", "tax_type_id", "legal_basis", "evidence_ref",
      "valid_from", "valid_to", "recorded_by", "approved_by", "approved_at", "predecessor_id", "created_at"),
     "APPROVED,SUPERSEDED,REJECTED"),
    ("entity_tax_activations",
     ("organization_id", "seller_entity_id", "jurisdiction_id", "tax_type_id", "transaction_class", "mode",
      "effective_from", "effective_to", "registration_id", "legal_basis_id", "availability_version_id",
      "tenant_rate_percent", "tenant_source_citation", "tenant_source_url", "provider_connection_id",
      "proposed_by", "approved_by", "approved_at", "predecessor_id", "created_at"),
     "APPROVED,SUPERSEDED,REJECTED"),
    ("product_tax_classifications",
     ("organization_id", "product_id", "tax_code_id", "reason", "proposed_by", "approved_by", "approved_at",
      "classification_version", "predecessor_id", "created_at"),
     "APPROVED,SUPERSEDED,REJECTED"),
    ("customer_tax_addresses",
     ("organization_id", "customer_id", "role", "country_code", "subdivision_code", "postal_code", "city",
      "line1", "line2", "confidence", "source", "source_field", "validated_at", "created_by", "created_at"), "*"),
    ("customer_tax_ids",
     ("organization_id", "customer_id", "value_raw", "value_normalized", "id_type", "country_code", "source",
      "source_field", "created_by", "created_at"), "*"),
    ("customer_exemption_certificates",
     ("organization_id", "customer_id", "certificate_number", "jurisdiction_id", "tax_type_id",
      "scope_description", "valid_from", "expires_at", "evidence_ref", "reason_code", "created_by", "created_at"),
     "*"),
)

#: Transaction-scoped Postgres setting the erasure purge sets before deleting.
ERASURE_FLAG = "zoiko.tax_erasure"

PG_TENANT_GUARD_FUNCTION = """
CREATE OR REPLACE FUNCTION tax_tenant_record_guard() RETURNS trigger AS $$
DECLARE
  f text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('zoiko.tax_erasure', true), '') <> 'on' THEN
      RAISE EXCEPTION '% rows are retained tax evidence: only the tenant erasure purge may delete them', TG_TABLE_NAME
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_ARGV[1] = '*' OR (to_jsonb(OLD) ->> 'status') = ANY (string_to_array(TG_ARGV[1], ',')) THEN
    FOREACH f IN ARRAY string_to_array(TG_ARGV[0], ',') LOOP
      IF (to_jsonb(NEW) -> f) IS DISTINCT FROM (to_jsonb(OLD) -> f) THEN
        RAISE EXCEPTION '%.% is frozen on record %; record a new version instead', TG_TABLE_NAME, f, OLD.id
          USING ERRCODE = 'integrity_constraint_violation';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
"""


def pg_tenant_trigger_sql(table: str, fields: tuple, frozen_statuses: str) -> str:
    return (f"CREATE TRIGGER trg_{table}_guard BEFORE UPDATE OR DELETE ON {table} FOR EACH ROW "
            f"EXECUTE FUNCTION tax_tenant_record_guard('{','.join(fields)}', '{frozen_statuses}')")


_GUARDED_TABLES = {t.__tablename__: t.__table__ for t in (
    EntityTaxRegistration, EntityTaxLegalBasis, EntityTaxActivation, ProductTaxClassification,
    CustomerTaxAddress, CustomerTaxId, CustomerExemptionCertificate,
)}
for _name, _fields, _frozen in TENANT_RECORD_GUARDS:
    event.listen(_GUARDED_TABLES[_name], "after_create",
                 DDL(PG_TENANT_GUARD_FUNCTION).execute_if(dialect="postgresql"))
    event.listen(_GUARDED_TABLES[_name], "after_create",
                 DDL(pg_tenant_trigger_sql(_name, _fields, _frozen)).execute_if(dialect="postgresql"))


# ── ORM guard (clear errors; Postgres triggers cover raw SQL) ────────────

class TaxRecordFrozenError(ZoikoException):
    def __init__(self, message: str):
        super().__init__(status_code=409, error_code="TAX_RECORD_FROZEN", message=message)


_GUARD_SPEC = {
    _GUARDED_TABLES[name]: (set(fields), None if frozen == "*" else set(frozen.split(",")))
    for name, fields, frozen in TENANT_RECORD_GUARDS
}


@event.listens_for(Session, "before_flush")
def _guard_tenant_tax_records(session, flush_context, instances):
    for obj in session.deleted:
        table = getattr(obj, "__table__", None)
        if table in _GUARD_SPEC and not session.info.get(ERASURE_FLAG):
            raise TaxRecordFrozenError(f"{table.name} rows are retained tax evidence and cannot be deleted.")
    for obj in session.dirty:
        table = getattr(obj, "__table__", None)
        if table not in _GUARD_SPEC:
            continue
        fields, frozen_statuses = _GUARD_SPEC[table]
        state = sa_inspect(obj)
        if frozen_statuses is not None:
            hist = state.attrs["status"].history
            old_status = hist.deleted[0] if hist.deleted else obj.status
            if getattr(old_status, "name", old_status) not in frozen_statuses:
                continue
        changed = {k for k in fields if state.attrs[k].history.has_changes()}
        if changed:
            raise TaxRecordFrozenError(
                f"{table.name} {obj.id}: {', '.join(sorted(changed))} cannot change; record a new version instead."
            )


def register_tenant_record_guard(table, fields, frozen_statuses: str = "*") -> None:
    """Put another tenant tax table under the same retention guard: the ORM
    guard above plus the Postgres trigger (on create_all) — key fields frozen,
    deletes only inside the erasure purge. Migrations install the trigger
    explicitly (frozen copy)."""
    _GUARD_SPEC[table] = (set(fields), None if frozen_statuses == "*" else set(frozen_statuses.split(",")))
    event.listen(table, "after_create", DDL(PG_TENANT_GUARD_FUNCTION).execute_if(dialect="postgresql"))
    event.listen(table, "after_create",
                 DDL(pg_tenant_trigger_sql(table.name, tuple(fields), frozen_statuses)).execute_if(dialect="postgresql"))


# Phase 4a-2 tenant records under the same retention guard.
EVIDENCE_FILE_FROZEN_FIELDS = ("organization_id", "sha256", "media_type", "size_bytes", "filename", "content",
                               "uploaded_by", "created_at")
REGIME_CHANGE_FROZEN_FIELDS = ("organization_id", "seller_entity_id", "from_regime", "to_regime", "reason",
                               "eligibility", "proposed_by", "created_at")
register_tenant_record_guard(TaxEvidenceFile.__table__, EVIDENCE_FILE_FROZEN_FIELDS)
register_tenant_record_guard(TaxRegimeChange.__table__, REGIME_CHANGE_FROZEN_FIELDS)


@event.listens_for(Session, "before_flush")
def _guard_certificate_evidence_write_once(session, flush_context, instances):
    """An exemption certificate's evidence document is attached once."""
    for obj in session.dirty:
        if isinstance(obj, CustomerExemptionCertificate):
            hist = sa_inspect(obj).attrs["evidence_file_id"].history
            if hist.deleted and hist.deleted[0] is not None:
                raise TaxRecordFrozenError(f"Exemption certificate {obj.id} already has its evidence document.")

ADDRESS_RESOLUTION_FROZEN_FIELDS = ("organization_id", "address_id", "resolver_name", "source", "dataset_version",
                                    "status", "precision", "candidates", "jurisdiction_codes", "resolved_by",
                                    "resolved_at")
PSEUDONYM_KEY_FROZEN_FIELDS = ("organization_id", "fingerprint", "reason", "proposed_by", "created_at")
register_tenant_record_guard(TaxAddressResolution.__table__, ADDRESS_RESOLUTION_FROZEN_FIELDS)
register_tenant_record_guard(TaxPseudonymKeyRecord.__table__, PSEUDONYM_KEY_FROZEN_FIELDS)
