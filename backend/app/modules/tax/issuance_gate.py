"""
app/modules/tax/issuance_gate.py
--------------------------------
Governed issuance gate (ZB-TAX-ARCH-001 Phase 3a, §08.1 step 8, §09.2-9.3).

For a GOVERNED seller entity, every DRAFT -> SENT path (finalize, mark-sent,
email, super-admin resend) calls this gate instead of the legacy recalculation:

  prepare()  the latest committable quote for the invoice must exist, be
             unexpired, and still match the current context fingerprint AND
             document hash — otherwise it is marked EXPIRED / STALE (persisted)
             and issuance is refused. NOT_DETERMINED never issues (T01, T19).
             Provider engines then commit remotely, BEFORE the invoice is
             touched (reconciling an uncertain earlier attempt instead of
             retrying blindly, T10), so a timeout can never leave a
             half-issued invoice behind.
  apply()    the invoice's tax amounts and totals are set from the quote; any
             client-sent tax percentage is overwritten.
  commit()   the quote becomes COMMITTED and is linked as
             invoices.tax_quote_id, in the caller's transaction together with
             the status change.

RemoteCommitter is the seam for the Phase 4 transactional outbox/saga: today it
calls the provider synchronously; the outbox will replace it without changing
the gate's contract.
"""
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session

from app.core.exceptions import BadRequestException
from app.modules.billing.models import Invoice, InvoiceItem
from app.modules.tax.determination_service import TaxDeterminationService, _round, entity_regime
from app.modules.tax.engines import ProviderAdapter, ProviderError, ProviderTimeout
from app.modules.tax.enums import COMMITTABLE_QUOTE_STATUSES, EntityTaxRegime, RemoteCommitState, TaxQuoteStatus
from app.modules.tax.quote_models import TaxQuote


class TaxIssuanceBlocked(BadRequestException):
    """Issuance refused by the governed tax gate (400, with the reason)."""


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: Optional[datetime]) -> Optional[datetime]:
    if value is not None and value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


def is_governed(db: Session, invoice: Invoice) -> bool:
    return entity_regime(db, invoice.organization_id, invoice.seller_entity_id) == EntityTaxRegime.GOVERNED


class RemoteCommitter:
    """Commits provider quotes. Phase 4 replaces this with an outbox/saga."""

    def __init__(self, provider_lookup=None):
        self.provider_lookup = provider_lookup or (lambda quote: None)

    def commit(self, db: Session, quote: TaxQuote) -> None:
        if quote.remote_commit_state in (RemoteCommitState.NOT_APPLICABLE, RemoteCommitState.COMMITTED):
            return
        adapter: Optional[ProviderAdapter] = self.provider_lookup(quote)
        if adapter is None:
            raise TaxIssuanceBlocked(f"Tax provider {quote.provider_name!r} is not available; the invoice was not issued.")
        ref = f"tax_quote:{quote.id}"
        if quote.remote_commit_state == RemoteCommitState.UNCERTAIN:
            # Never retry a timed-out commit blindly: ask the provider first.
            if adapter.remote_state(quote_ref=ref, idempotency_key=quote.request_hash) == RemoteCommitState.COMMITTED:
                quote.remote_commit_state = RemoteCommitState.COMMITTED
                return
        try:
            quote.provider_correlation_id = adapter.commit(
                quote_ref=ref, idempotency_key=quote.request_hash,
                payload={"tax_amount": str(quote.tax_amount), "currency": quote.currency},
            )
            quote.remote_commit_state = RemoteCommitState.COMMITTED
        except ProviderTimeout:
            quote.remote_commit_state = RemoteCommitState.UNCERTAIN
            db.commit()
            raise TaxIssuanceBlocked("The tax provider did not confirm the commit in time. The invoice was not issued; "
                                     "retrying will reconcile with the provider first.")
        except ProviderError as exc:
            raise TaxIssuanceBlocked(f"The tax provider refused the commit: {exc}. The invoice was not issued.")


class GovernedIssuanceGate:
    def __init__(self, db: Session, committer: Optional[RemoteCommitter] = None,
                 determination: Optional[TaxDeterminationService] = None, now=None):
        self.db = db
        self.now = now or _now
        self.committer = committer or RemoteCommitter()
        self.determination = determination or TaxDeterminationService(db, now=self.now)

    def _latest_quote(self, invoice: Invoice) -> Optional[TaxQuote]:
        return self.db.query(TaxQuote).filter(
            TaxQuote.organization_id == invoice.organization_id, TaxQuote.document_type == "invoice",
            TaxQuote.document_id == invoice.id,
        ).order_by(TaxQuote.created_at.desc(), TaxQuote.id.desc()).first()

    def _refuse(self, quote: Optional[TaxQuote], status: Optional[TaxQuoteStatus], reason: str):
        if quote is not None and status is not None:
            quote.status = status
            quote.stale_reason = reason
            self.db.commit()                      # the quote's new state survives the refused issuance
        raise TaxIssuanceBlocked(reason)

    def prepare(self, invoice: Invoice) -> TaxQuote:
        quote = self._latest_quote(invoice)
        if quote is None:
            self._refuse(None, None, "Tax is NOT_DETERMINED for this invoice: request a governed tax quote "
                                     "(POST /api/v1/tax/quotes) before issuing it.")
        if quote.status not in COMMITTABLE_QUOTE_STATUSES:
            reason = quote.refusal_reason or quote.stale_reason or f"the latest tax quote is {quote.status.name}"
            self._refuse(None, None, f"Tax is NOT_DETERMINED for this invoice: {reason}")
        if quote.expires_at is not None and _aware(quote.expires_at) <= self.now():
            self._refuse(quote, TaxQuoteStatus.EXPIRED, "The tax quote has expired; request a new quote.")
        fingerprint, doc_hash = self.determination.current_fingerprints(invoice.organization_id, "invoice", invoice.id)
        if fingerprint != quote.context_fingerprint:
            self._refuse(quote, TaxQuoteStatus.STALE, "Tax facts changed since the quote (registrations, activations, "
                                                      "buyer evidence, classification or availability); re-quote.")
        if doc_hash != quote.document_hash:
            self._refuse(quote, TaxQuoteStatus.STALE, "The invoice lines, prices, discounts, currency or tax date "
                                                      "changed since the quote; re-quote.")
        quote.status = TaxQuoteStatus.VALIDATED
        quote.validated_at = self.now()
        # Remote first: if the provider times out, only the quote's own state
        # (VALIDATED, remote UNCERTAIN) is persisted — the invoice is untouched.
        self.committer.commit(self.db, quote)
        return quote

    def apply(self, invoice: Invoice, quote: TaxQuote) -> None:
        """Set the invoice's tax figures from the quote (client tax ignored)."""
        items = {i.id: i for i in self.db.query(InvoiceItem).filter(InvoiceItem.invoice_id == invoice.id)}
        for line in quote.lines:
            item = items[line.document_line_id]
            item.tax_percentage = line.effective_rate
            item.tax_amount = line.tax_amount
            item.discount_amount = _round(line.line_discount_unrounded, quote.currency_decimals)
            item.total = line.line_total
        invoice.subtotal = quote.subtotal
        invoice.discount_amount = quote.discount_amount
        invoice.tax_amount = quote.tax_amount
        invoice.total_amount = quote.total_amount
        invoice.balance_due = quote.total_amount - (invoice.paid_amount or 0)

    def commit(self, invoice: Invoice, quote: TaxQuote, actor_id: Optional[int]) -> None:
        quote.status = TaxQuoteStatus.COMMITTED
        quote.committed_at = self.now()
        quote.committed_by = actor_id
        invoice.tax_quote_id = quote.id
