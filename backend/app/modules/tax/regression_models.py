"""
app/modules/tax/regression_models.py
------------------------------------
Regression reports (ZB-TAX-ARCH-001 Phase 7 PR 2). Platform data only. One
row per run, append-only: the latest row for a subject is the one attached
to its approval (regression/runner.py).
"""
from sqlalchemy import JSON, Column, DateTime, ForeignKey, Integer, String

from app.database import Base


class TaxRegressionReport(Base):
    __tablename__ = "tax_regression_reports"

    id            = Column(Integer, primary_key=True, index=True)
    subject_kind  = Column(String(20), nullable=False, index=True)       # rule_pack | rate
    subject_id    = Column(Integer, nullable=False, index=True)          # tax_rule_pack_versions / tax_rate_staging id
    fixture_hash  = Column(String(64), nullable=False)
    baseline_ref  = Column(String(500), nullable=False)
    case_count    = Column(Integer, nullable=False)
    changed_count = Column(Integer, nullable=False)
    report        = Column(JSON, nullable=False)
    generated_by  = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    generated_at  = Column(DateTime(timezone=True), nullable=False)
