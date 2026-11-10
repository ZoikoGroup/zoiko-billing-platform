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
             Provider quotes (is_remote) are then issued through the Phase 4
             outbox (provider_issuance.ProviderIssuanceService), never here.
  apply()    the invoice's tax amounts and totals are set from the quote; any
             client-sent tax percentage is overwritten.
  commit()   the quote becomes COMMITTED and is linked as
             invoices.tax_quote_id, in the caller's transaction together with
             the status change. A provider quote without a confirmed remote
             commit is refused here too: no invoice reaches SENT from a
             provider quote (estimate-only included) without one.
"""
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.orm import Session

from app.core.exceptions import BadRequestException
from app.modules.billing.models import Invoice, InvoiceItem
from app.modules.tax.determination_service import TaxDeterminationService, _round, entity_regime
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


class GovernedIssuanceGate:
    def __init__(self, db: Session, provider_issuance=None,
                 determination: Optional[TaxDeterminationService] = None, now=None):
        self.db = db
        self.now = now or _now
        self.determination = determination or TaxDeterminationService(db, now=self.now)
        self._provider_issuance = provider_issuance

    @staticmethod
    def is_remote(quote: TaxQuote) -> bool:
        return quote.remote_commit_state != RemoteCommitState.NOT_APPLICABLE

    def provider_issuance(self):
        if self._provider_issuance is None:
            from app.modules.tax.provider_issuance import ProviderIssuanceService

            self._provider_issuance = ProviderIssuanceService(self.db, now=self.now)
        return self._provider_issuance

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

    def _rule_pack_current(self, quote: TaxQuote) -> bool:
        """Phase 8 PR 1: checked alongside the context fingerprint. The
        quote's pack version must still be the ACTIVE one, with the same
        approved hash, and that hash must be the code running now."""
        from app.modules.tax.engines import pack_in_range
        from app.modules.tax.enums import PlatformVersionStatus
        from app.modules.tax.policy_models import TaxRulePackVersion, code_version_of
        from app.modules.tax.rule_pack_integrity import running_hash

        row = self.db.get(TaxRulePackVersion, quote.rule_pack_version_id)
        if row is None or row.status != PlatformVersionStatus.ACTIVE or not pack_in_range(row, quote.tax_date):
            return False
        running = running_hash(row.code, code_version_of(row))
        return bool(quote.rule_pack_code_hash) and quote.rule_pack_code_hash == row.code_hash == running

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
        if quote.rule_pack_version_id is not None and not self._rule_pack_current(quote):
            self._refuse(quote, TaxQuoteStatus.STALE, "The tax rule pack changed since the quote; re-quote.")
        if not self.is_remote(quote):
            quote.status = TaxQuoteStatus.VALIDATED
            quote.validated_at = self.now()
        return quote

    def apply(self, invoice: Invoice, quote: TaxQuote) -> None:
        """Set the invoice's tax figures from the quote (client tax ignored)."""
        items = {i.id: i for i in self.db.query(InvoiceItem).filter(InvoiceItem.invoice_id == invoice.id)}
        for line in quote.lines:
            item = items[line.document_line_id]
            item.tax_percentage = line.effective_rate
            item.tax_amount = line.tax_amount
            item.discount_amount = _round(line.line_discount_unrounded, quote.currency_decimals, quote.rounding_mode)
            item.total = line.line_total
        # The committed tax point and currency, never the moment of issue.
        invoice.tax_date = quote.tax_date
        invoice.currency = quote.currency
        invoice.subtotal = quote.subtotal
        invoice.discount_amount = quote.discount_amount
        invoice.tax_amount = quote.tax_amount
        invoice.total_amount = quote.total_amount
        invoice.balance_due = quote.total_amount - (invoice.paid_amount or 0)

    def commit(self, invoice: Invoice, quote: TaxQuote, actor_id: Optional[int]) -> None:
        if self.is_remote(quote) and quote.remote_commit_state != RemoteCommitState.COMMITTED:
            raise TaxIssuanceBlocked("This invoice's tax comes from a provider and the provider has not committed "
                                     "it; it cannot be issued.")
        quote.status = TaxQuoteStatus.COMMITTED
        quote.committed_at = self.now()
        quote.committed_by = actor_id
        invoice.tax_quote_id = quote.id
