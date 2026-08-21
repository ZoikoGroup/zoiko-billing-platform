"""
modules/billing/services/document_sequence.py
---------------------------------------------
Concurrency-safe per-organization per-document-type numbering.

Replaces the old count()-based numbering (count of rows + 1), which could
produce duplicate numbers under concurrency and after voiding/soft-deleting
documents. Every next_number() call locks the sequence row with SELECT FOR
UPDATE, so concurrent issuers are serialized and can never observe the same
last_number.

Each org has one row per doc_type. When the sequence reset window (monthly /
quarterly / annual) rolls over, last_number restarts at 1.
"""
import logging
from datetime import datetime
from typing import Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.modules.billing.models import DocumentSequence
from app.modules.billing.services.base import render_document_number, sequence_window_start

logger = logging.getLogger("zoiko_billing")


class DocumentSequenceService:
    def __init__(self, db: Session):
        self.db = db

    def next_number(
        self,
        organization_id: int,
        doc_type: str,
        prefix: str,
        number_format,
        sequence_reset,
        now: Optional[datetime] = None,
    ) -> str:
        """Atomically advance the sequence and render the next document number.

        The sequence row is locked with FOR UPDATE for the duration of the
        caller's transaction; the rendered number is unique per org+doc_type
        even under concurrent issuance.
        """
        now = now or datetime.utcnow()
        seq = self._next_sequence(organization_id, doc_type, sequence_reset, now)
        return render_document_number(prefix, number_format, seq, now, also_replace_year_month=True)

    def _next_sequence(
        self,
        organization_id: int,
        doc_type: str,
        sequence_reset,
        now: datetime,
    ) -> int:
        row = self._get_or_create(organization_id, doc_type, sequence_reset, now)
        # Re-query under lock — the FOR UPDATE is what serializes concurrent
        # issuers. (SQLite ignores FOR UPDATE; its file-level write lock still
        # serializes writers, so logic is preserved for tests.)
        row = (
            self.db.query(DocumentSequence)
            .filter(
                DocumentSequence.id == row.id,
            )
            .with_for_update()
            .one()
        )
        window_start = sequence_window_start(now, sequence_reset)
        # window_start is a Date column and sequence_window_start() returns a
        # plain date, so compare date-to-date — treating a date as a datetime
        # and calling .date() on it raises AttributeError, and comparing a
        # datetime against a date is always unequal (which would reset the
        # counter on every call, re-issuing stale numbers).
        if row.window_start is not None and window_start is not None and row.window_start != window_start:
            row.last_number = 0
            row.window_start = window_start
        elif row.window_start is None and window_start is not None:
            # Row predates window tracking: backfill the current window start
            # without resetting, or the next number collides with existing docs.
            row.window_start = window_start
        row.last_number += 1
        self.db.flush()
        return row.last_number

    def _get_or_create(
        self,
        organization_id: int,
        doc_type: str,
        sequence_reset,
        now: datetime,
    ) -> DocumentSequence:
        row = (
            self.db.query(DocumentSequence)
            .filter(
                DocumentSequence.organization_id == organization_id,
                DocumentSequence.doc_type == doc_type,
            )
            .first()
        )
        if row is not None:
            return row

        window_start = sequence_window_start(now, sequence_reset)
        try:
            row = DocumentSequence(
                organization_id=organization_id,
                doc_type=doc_type,
                last_number=0,
                window_start=window_start if window_start is not None else None,
            )
            self.db.add(row)
            # Commit only the seed row so a concurrent first-issuer race
            # resolves deterministically instead of deadlocking the outer tx.
            self.db.commit()
            self.db.refresh(row)
            return row
        except IntegrityError:
            self.db.rollback()
            row = (
                self.db.query(DocumentSequence)
                .filter(
                    DocumentSequence.organization_id == organization_id,
                    DocumentSequence.doc_type == doc_type,
                )
                .first()
            )
            if row is None:
                raise
            return row

    def peek_next_number(
        self,
        organization_id: int,
        doc_type: str,
        prefix: str,
        number_format,
        sequence_reset,
        now: Optional[datetime] = None,
    ) -> str:
        """Read-only preview of the next number (used by UI wizards). Does not
        advance the sequence, so the preview can differ from the issued number
        under concurrent issuance — it is advisory only."""
        now = now or datetime.utcnow()
        row = (
            self.db.query(DocumentSequence)
            .filter(
                DocumentSequence.organization_id == organization_id,
                DocumentSequence.doc_type == doc_type,
            )
            .first()
        )
        window_start = sequence_window_start(now, sequence_reset)
        last_number = 0
        if row is not None and row.last_number is not None:
            if window_start is not None and row.window_start == window_start:
                last_number = row.last_number
        return render_document_number(prefix, number_format, last_number + 1, now, also_replace_year_month=True)


def get_document_sequence_service(db: Session) -> DocumentSequenceService:
    return DocumentSequenceService(db)
