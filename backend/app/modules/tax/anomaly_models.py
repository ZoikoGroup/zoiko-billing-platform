"""
app/modules/tax/anomaly_models.py
---------------------------------
Anomaly monitoring runs (ZB-TAX-ARCH-001 Phase 7 PR 3). Platform data only:
aggregate counts and per-market shares, never an organization, invoice or
customer identifier. The per-invoice findings are tenant review items.
"""
from sqlalchemy import JSON, Column, DateTime, Integer

from app.database import Base


class TaxAnomalyRun(Base):
    __tablename__ = "tax_anomaly_runs"

    id           = Column(Integer, primary_key=True, index=True)
    started_at   = Column(DateTime(timezone=True), nullable=False, index=True)
    finished_at  = Column(DateTime(timezone=True), nullable=True)
    counts       = Column(JSON, nullable=False)       # {"snapshot": {"checked", "found"}, ...}
    markets      = Column(JSON, nullable=False)       # {"GB": {"invoices", "zero_tax_share", ...}}
    alerts_fired = Column(JSON, nullable=True)        # ["tax.anomaly.snapshot", ...]
