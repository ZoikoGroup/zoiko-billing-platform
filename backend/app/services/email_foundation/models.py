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


class EmailOutbox(Base):
    """Durable work queue for asynchronously-dispatched emails (B1).

    A sibling table to CommunicationAuditLog, not a replacement: this table
    exists so a process crash between "the API request returned" and "the
    background thread pool actually opened an SMTP connection" never silently
    drops a message. A row here holds everything needed to reconstruct and
    redeliver the send (template name + pre-render context + attachments),
    which CommunicationAuditLog was never designed to hold. CommunicationAuditLog
    keeps recording every attempt (SENT/FAILED/etc) exactly as it did before —
    this table is only consulted by the async dispatch path and the recovery
    sweep in email_foundation/recovery.py.
    """
    __tablename__ = "email_outbox"

    id = Column(Integer, primary_key=True, index=True)
    dedupe_key = Column(String(255), nullable=True, index=True)
    recipient = Column(String(255), nullable=False, index=True)
    organization_id = Column(Integer, nullable=True, index=True)
    template_name = Column(String(255), nullable=False)
    template_id = Column(String(50), nullable=True, index=True)
    event_name = Column(String(100), nullable=True, index=True)
    event_id = Column(String(255), nullable=True, index=True)
    target_record_id = Column(String(255), nullable=True, index=True)
    # Pre-render context (json.dumps'd dict) + template_name are stored rather
    # than the already-rendered body so a retry always picks up the current
    # template/branding, not a stale render from before this row was queued.
    context_json = Column(Text, nullable=True)
    # JSON list of [filename, base64_bytes] pairs — see send_approval_email's
    # async_send path for how this is populated / decoded on redelivery.
    attachments_json = Column(Text, nullable=True)
    from_email_override = Column(String(255), nullable=True)
    from_display_name_override = Column(String(255), nullable=True)
    status = Column(String(20), nullable=False, index=True, default="QUEUED")  # QUEUED, SENT, FAILED
    attempts = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False, index=True)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
    last_error = Column(Text, nullable=True)

    __table_args__ = (
        Index("idx_email_outbox_status_created", "status", "created_at"),
    )
