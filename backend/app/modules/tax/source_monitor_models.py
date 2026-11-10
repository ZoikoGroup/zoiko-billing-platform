"""
app/modules/tax/source_monitor_models.py
----------------------------------------
Source change detection and review cadence (ZB-TAX-ARCH-001 Phase 8 PR 5,
handoff §10.1 steps 01-03, §10.2). Platform data only: no tenant data.

  TaxSourceMonitor        a monitored official source: URL (allowlisted
                          host), risk tier (sets the cadence), access mode.
  TaxSourceMonitorChange  a proposed change that could weaken detection
                          (disable, delete, lower the tier, switch to manual,
                          change the URL): a second person decides.
  TaxSourceObservation    append-only: one check (time, HTTP status, raw and
                          normalized hashes; the raw artifact only when the
                          normalized hash changed, or the first time).
  TaxSourceReview         a review item for TAX_REVIEWER: SOURCE_CHANGED (with
                          a text diff), MANUAL_CHECK_DUE, PRE_EFFECTIVE_CHECK.
                          Detection only: nothing here creates a source
                          revision, a staged rate or a publication.
  TaxReviewDue            the revalidation due date of an ACTIVE source or
                          availability version.
  TaxSourceHost           per host: robots.txt (cached a day) and the last
                          request (at most one per minute).
"""
from sqlalchemy import (
    Boolean, Column, DateTime, ForeignKey, Index, Integer, JSON, String, Text, UniqueConstraint, event, text,
)
from sqlalchemy.orm import Session, object_session

from app.database import Base

TIERS = ("HIGH_VOLATILITY", "NATIONAL_VAT_GST", "RESEARCH_ONLY")
ACCESS_MODES = ("AUTOMATED", "MANUAL_CHECK")
REVIEW_KINDS = ("SOURCE_CHANGED", "MANUAL_CHECK_DUE", "PRE_EFFECTIVE_CHECK")


def _user():
    return Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)


class TaxSourceMonitor(Base):
    __tablename__ = "tax_source_monitors"

    id                   = Column(Integer, primary_key=True, index=True)
    handoff_ref          = Column(String(20), nullable=True, index=True)
    title                = Column(String(300), nullable=False)
    monitoring_url       = Column(String(1000), nullable=False)
    host                 = Column(String(255), nullable=False, index=True)
    jurisdiction_id      = Column(Integer, ForeignKey("tax_jurisdictions.id", ondelete="RESTRICT"), nullable=True)
    risk_tier            = Column(String(20), nullable=False)
    access_mode          = Column(String(20), nullable=False, default="AUTOMATED")
    manual_reason        = Column(Text, nullable=True)
    enabled              = Column(Boolean, nullable=False, default=True)
    retired_at           = Column(DateTime(timezone=True), nullable=True)   # "deleted": history kept
    next_check_due       = Column(DateTime(timezone=True), nullable=False, index=True)
    last_checked_at      = Column(DateTime(timezone=True), nullable=True)
    last_outcome         = Column(String(30), nullable=True)
    last_observation_id  = Column(Integer, nullable=True)
    consecutive_failures = Column(Integer, nullable=False, default=0)
    consecutive_429      = Column(Integer, nullable=False, default=0)
    retry_after_until    = Column(DateTime(timezone=True), nullable=True)
    dismissals           = Column(Integer, nullable=False, default=0)
    created_by           = _user()
    created_at           = Column(DateTime(timezone=True), nullable=False)
    updated_at           = Column(DateTime(timezone=True), nullable=True)


class TaxSourceMonitorChange(Base):
    __tablename__ = "tax_source_monitor_changes"

    id          = Column(Integer, primary_key=True, index=True)
    monitor_id  = Column(Integer, ForeignKey("tax_source_monitors.id", ondelete="RESTRICT"), nullable=False, index=True)
    action      = Column(String(20), nullable=False)        # DISABLE | DELETE | LOWER_TIER | TO_MANUAL | CHANGE_URL
    value       = Column(String(1000), nullable=True)
    reason      = Column(Text, nullable=False)
    status      = Column(String(10), nullable=False, default="PROPOSED")
    proposed_by = _user()
    decided_by  = _user()
    decided_at  = Column(DateTime(timezone=True), nullable=True)
    created_at  = Column(DateTime(timezone=True), nullable=False)


class TaxSourceObservation(Base):
    __tablename__ = "tax_source_observations"

    id                = Column(Integer, primary_key=True, index=True)
    monitor_id        = Column(Integer, ForeignKey("tax_source_monitors.id", ondelete="RESTRICT"), nullable=False,
                               index=True)
    fetched_at        = Column(DateTime(timezone=True), nullable=False)
    url_fetched       = Column(String(1000), nullable=True)
    outcome           = Column(String(30), nullable=False)   # OK | CHANGED | FAILED | REFUSED | RATE_LIMITED | ROBOTS_DISALLOWED
    http_status       = Column(Integer, nullable=True)
    content_type      = Column(String(150), nullable=True)
    normalization     = Column(String(60), nullable=True)
    raw_sha256        = Column(String(64), nullable=True)
    normalized_sha256 = Column(String(64), nullable=True)
    artifact_sha256   = Column(String(64), ForeignKey("tax_source_artifacts.sha256", ondelete="RESTRICT"), nullable=True)
    error             = Column(Text, nullable=True)


class TaxSourceReview(Base):
    __tablename__ = "tax_source_reviews"

    id                      = Column(Integer, primary_key=True, index=True)
    kind                    = Column(String(30), nullable=False, index=True)
    monitor_id              = Column(Integer, ForeignKey("tax_source_monitors.id", ondelete="RESTRICT"), nullable=True)
    rate_version_id         = Column(Integer, ForeignKey("tax_rate_versions.id", ondelete="RESTRICT"), nullable=True)
    observation_id          = Column(Integer, ForeignKey("tax_source_observations.id", ondelete="RESTRICT"),
                                     nullable=True)
    previous_observation_id = Column(Integer, nullable=True)
    diff                    = Column(Text, nullable=True)       # untrusted text: rendered escaped, never as HTML
    cycle_key               = Column(String(120), nullable=False)
    status                  = Column(String(20), nullable=False, default="OPEN", index=True)
    resolution              = Column(Text, nullable=True)
    source_revision_id      = Column(Integer, ForeignKey("tax_legal_source_revisions.id", ondelete="RESTRICT"),
                                     nullable=True)
    decided_by              = _user()
    decided_at              = Column(DateTime(timezone=True), nullable=True)
    created_at              = Column(DateTime(timezone=True), nullable=False)

    __table_args__ = (UniqueConstraint("cycle_key", name="uq_tax_source_reviews_cycle"),)


class TaxReviewDue(Base):
    __tablename__ = "tax_review_dues"

    id               = Column(Integer, primary_key=True, index=True)
    subject_kind     = Column(String(20), nullable=False)       # source | availability
    subject_key      = Column(String(60), nullable=False)       # handoff ref | availability version id
    label            = Column(String(300), nullable=False)
    tier             = Column(String(20), nullable=False)
    next_review_due  = Column(DateTime(timezone=True), nullable=False, index=True)
    last_reviewed_at = Column(DateTime(timezone=True), nullable=True)
    last_reviewed_by = _user()
    note             = Column(Text, nullable=True)
    created_at       = Column(DateTime(timezone=True), nullable=False)

    __table_args__ = (UniqueConstraint("subject_kind", "subject_key", name="uq_tax_review_dues_subject"),)


class TaxSourceHost(Base):
    __tablename__ = "tax_source_hosts"

    host              = Column(String(255), primary_key=True)
    last_request_at   = Column(DateTime(timezone=True), nullable=True)
    robots_fetched_at = Column(DateTime(timezone=True), nullable=True)
    robots_status     = Column(Integer, nullable=True)
    robots_body       = Column(Text, nullable=True)


#: Platform tables (never tenant data, never purged with a tenant).
SOURCE_MONITOR_TABLES = ("tax_source_monitors", "tax_source_monitor_changes", "tax_source_observations",
                         "tax_source_reviews", "tax_review_dues", "tax_source_hosts")


# ── observations are append-only ────────────────────────────────────────

class ObservationImmutableError(Exception):
    pass


@event.listens_for(Session, "before_flush")
def _observations_append_only(session, flush_context, instances):
    for obj in list(session.dirty) + list(session.deleted):
        if isinstance(obj, TaxSourceObservation) and (obj in session.deleted or session.is_modified(obj)):
            raise ObservationImmutableError(f"Source observation {obj.id} is append-only.")


PG_OBSERVATION_GUARD = [
    """
    CREATE OR REPLACE FUNCTION tax_source_observations_guard() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'tax_source_observations % is append-only', OLD.id
        USING ERRCODE = 'integrity_constraint_violation';
    END;
    $$ LANGUAGE plpgsql
    """,
    """
    CREATE TRIGGER trg_tax_source_observations_guard
      BEFORE UPDATE OR DELETE ON tax_source_observations
      FOR EACH ROW EXECUTE FUNCTION tax_source_observations_guard()
    """,
]
for _stmt in PG_OBSERVATION_GUARD:
    from sqlalchemy import DDL

    event.listen(TaxSourceObservation.__table__, "after_create", DDL(_stmt).execute_if(dialect="postgresql"))
