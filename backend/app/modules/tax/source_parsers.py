"""
app/modules/tax/source_parsers.py
---------------------------------
Optional parser plugins for monitored sources (ZB-TAX-ARCH-001 Phase 8
PR 5). A parser reads a changed source's normalized text and may propose
staged rates. Proposals enter the normal Phase 1 pipeline as drafts with
origin OFFICIAL_FEED: they still need validation, a submitter and a
different publisher. A parser never publishes anything.

No parser is registered: SOURCE_PARSERS is empty in this PR.
"""
import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Optional

logger = logging.getLogger("zoiko_billing.tax.source_parsers")


@dataclass
class ProposedRate:
    component_id: int
    tax_code: str
    rate_percent: Decimal
    valid_from: date
    source_revision_id: int
    valid_to: Optional[date] = None
    supersedes_rate_version_id: Optional[int] = None


class SourceParser(ABC):
    @abstractmethod
    def parse(self, monitor, text: str) -> list:
        """ProposedRate items read from the source's normalized text."""


#: handoff_ref -> SourceParser. Empty: no parser is registered in PR 5.
SOURCE_PARSERS: dict = {}


def stage_proposals(db, monitor, text: str) -> list:
    """Stage a registered parser's proposals as OFFICIAL_FEED drafts."""
    from app.modules.tax.enums import RateKind, StagingOrigin
    from app.modules.tax.registry_service import TaxRegistryPipeline

    parser = SOURCE_PARSERS.get(monitor.handoff_ref or "")
    if parser is None:
        return []
    staged = []
    for p in parser.parse(monitor, text):
        staged.append(TaxRegistryPipeline(db).stage(
            actor_id=None, origin=StagingOrigin.OFFICIAL_FEED, component_id=p.component_id, tax_code=p.tax_code,
            rate_kind=RateKind.STANDARD, rate_percent=p.rate_percent, valid_from=p.valid_from, valid_to=p.valid_to,
            source_revision_id=p.source_revision_id, owner="Source monitor parser",
            supersedes_rate_version_id=p.supersedes_rate_version_id))
    logger.info("Parser for %s staged %s draft rate(s)", monitor.handoff_ref, len(staged))
    return staged
