"""
email_foundation/models.py
--------------------------
SQLAlchemy database models for the Zoiko Billing Email System foundation infrastructure.
"""

from datetime import datetime
from sqlalchemy import Column, Integer, String, Boolean, DateTime, Text, Index
from app.database import Base


class EmailSuppression(Base):
    __tablename__ = "email_suppressions"

    id = Column(Integer, primary_key=True, index=True)
    email_address = Column(String(255), nullable=False, index=True)
    organization_id = Column(Integer, nullable=True, index=True)
    reason = Column(String(50), nullable=False)  # BOUNCE, COMPLAINT, LEGAL_HOLD, OPT_OUT
    details = Column(String(500), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    __table_args__ = (
        Index("idx_suppression_email_org", "email_address", "organization_id"),
    )


class EmailMarketingConsent(Base):
    __tablename__ = "email_marketing_consents"

    id = Column(Integer, primary_key=True, index=True)
    email_address = Column(String(255), nullable=False, index=True)
    organization_id = Column(Integer, nullable=True, index=True)
    has_consented = Column(Boolean, default=False, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    __table_args__ = (
        Index("idx_consent_email_org", "email_address", "organization_id"),
    )


class EmailOrgPreference(Base):
    __tablename__ = "email_org_preferences"

    id = Column(Integer, primary_key=True, index=True)
    organization_id = Column(Integer, nullable=False, index=True)
    category = Column(String(100), nullable=False)  # e.g., "INV", "COL", "SUB", "PAY"
    is_enabled = Column(Boolean, default=True, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    __table_args__ = (
        Index("idx_org_pref_org_cat", "organization_id", "category", unique=True),
    )


class CommunicationAuditLog(Base):
    __tablename__ = "communication_audit_logs"

    id = Column(Integer, primary_key=True, index=True)
    dedupe_key = Column(String(255), nullable=True, index=True)
    recipient = Column(String(255), nullable=False, index=True)
    organization_id = Column(Integer, nullable=True, index=True)
    template_id = Column(String(50), nullable=False, index=True)
    event_name = Column(String(100), nullable=False, index=True)
    event_id = Column(String(255), nullable=True, index=True)
    target_record_id = Column(String(255), nullable=True, index=True)
    tier = Column(String(10), nullable=False)
    status = Column(String(20), nullable=False, index=True)  # SENT, SUPPRESSED, FAILED, DUPLICATE, SUPERSEDED, QUEUED
    suppression_reason = Column(String(50), nullable=True)
    error_message = Column(Text, nullable=True)
    metadata_json = Column(Text, nullable=True)
    sent_at = Column(DateTime, default=datetime.utcnow, nullable=False)
