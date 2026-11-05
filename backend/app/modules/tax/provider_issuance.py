"""
app/modules/tax/provider_issuance.py
------------------------------------
Provider issuance as a state machine over a transactional outbox
(ZB-TAX-ARCH-001 Phase 4a-1, §09.3; plan: TAX_PHASE4_PLAN.md).

Only invoices whose committable quote came from a provider engine use this.
Native and tenant-config quotes keep the synchronous 3a gate.

  begin()     transaction 1: kill switch, estimate-only refusal, circuit and
              reconciliation heartbeat, then ONE outbox row (COMMIT, fixed
              key) is written. From here the invoice is a locked DRAFT.
  deliver()   one attempt at the provider. A timed-out commit is never
              retried: UNCERTAIN rows ask transaction_state(key) first.
  finalize()  transaction 2: kill switch again, then the invoice becomes SENT
              with the committed quote's tax date and currency.
  reconcile() the job: resolves PENDING / UNCERTAIN, finishes or compensates
              REMOTE_COMMITTED rows (retry within the grace window, then void
              by reference if the invoice was never sent), links invoice
              numbers (KEY_ONLY), drift-checks recent commits, writes a
              heartbeat. A stale heartbeat blocks provider issuing.

Nothing here falls back to a native pack, a last-known rate or zero.
"""
import logging
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Callable, Optional

from sqlalchemy import event
from sqlalchemy.orm import Session

from app.config import settings
from app.core.exceptions import BadRequestException
from app.modules.tax.enums import (
    ACTIVE_OUTBOX_STATES,
    CircuitState,
    DocumentReferencePolicy,
    OutboxOperation,
    OutboxState,
    RemoteCommitState,
    ReviewItemKind,
    ReviewItemStatus,
    TaxQuoteStatus,
)
from app.modules.tax.provider_contract import (
    ProviderError,
    ProviderMode,
    ProviderRateLimited,
    ProviderTimeout,
    ProviderTransaction,
    RemoteTransactionState,
)
from app.modules.tax.provider_models import TaxJobHeartbeat, TaxProviderCircuit, TaxProviderOutbox
from app.modules.tax.quote_models import TaxQuote

logger = logging.getLogger("zoiko_billing.tax.provider")

RECONCILIATION_JOB = "tax_provider_reconciliation"
#: Session flag set only while transaction 2 finalizes a locked invoice.
FINALIZING_FLAG = "tax_provider_finalizing"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: Optional[datetime]) -> Optional[datetime]:
    if value is not None and value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


class ProviderIssuanceBlocked(BadRequestException):
    """Provider issuing refused before anything was sent to the provider."""


def default_provider_lookup(name: Optional[str]):
    from app.modules.tax.engines import PROVIDERS

    return PROVIDERS.get(name) if name else None


# ── circuit breaker + heartbeat (fail closed) ────────────────────────────

class ProviderHealth:
    def __init__(self, db: Session, now: Callable = _now):
        self.db = db
        self.now = now

    def circuit(self, name: str) -> TaxProviderCircuit:
        row = self.db.get(TaxProviderCircuit, name)
        if row is None:
            row = TaxProviderCircuit(provider_name=name, state=CircuitState.CLOSED, failure_count=0,
                                     updated_at=self.now())
            self.db.add(row)
            self.db.flush()
        return row

    def circuit_problem(self, name: str) -> Optional[str]:
        row = self.db.get(TaxProviderCircuit, name)
        if row is None:
            return None
        if row.state == CircuitState.SUSPENDED:
            return f"Tax provider {name} is suspended ({row.suspended_reason or 'no reason recorded'})."
        if row.state == CircuitState.OPEN:
            reopen = _aware(row.opened_at) + timedelta(seconds=settings.TAX_PROVIDER_CB_COOLDOWN_SECONDS)
            if self.now() < reopen:
                return f"Tax provider {name} is unavailable (circuit open after repeated failures)."
        return None                                    # CLOSED, or OPEN past cool-down (one trial allowed)

    def heartbeat_problem(self) -> Optional[str]:
        hb = self.db.get(TaxJobHeartbeat, RECONCILIATION_JOB)
        limit = timedelta(seconds=settings.TAX_PROVIDER_RECONCILIATION_INTERVAL_SECONDS
                          * settings.TAX_PROVIDER_HEARTBEAT_STALE_INTERVALS)
        if hb is None or hb.last_finished_at is None or not hb.last_ok \
                or self.now() - _aware(hb.last_finished_at) > limit:
            return "Provider reconciliation is not running, so provider-taxed invoices cannot be issued safely."
        return None

    def record_failure(self, name: str) -> None:
        row = self.circuit(name)
        if row.state == CircuitState.SUSPENDED:
            return
        now = self.now()
        window = timedelta(seconds=settings.TAX_PROVIDER_CB_WINDOW_SECONDS)
        if row.window_started_at is None or now - _aware(row.window_started_at) > window:
            row.window_started_at, row.failure_count = now, 0
        row.failure_count += 1
        if row.state == CircuitState.OPEN or row.failure_count >= settings.TAX_PROVIDER_CB_FAILURES:
            row.state, row.opened_at = CircuitState.OPEN, now
        row.updated_at = now

    def record_success(self, name: str) -> None:
        row = self.circuit(name)
        if row.state == CircuitState.SUSPENDED:
            return
        row.state, row.failure_count, row.window_started_at, row.opened_at = CircuitState.CLOSED, 0, None, None
        row.updated_at = self.now()

    def suspend(self, name: str, reason: str) -> None:
        """T16: contract ended, credentials or licence revoked. Frozen until resumed."""
        row = self.circuit(name)
        row.state, row.suspended_reason, row.updated_at = CircuitState.SUSPENDED, reason, self.now()

    def resume(self, name: str) -> None:
        row = self.circuit(name)
        row.state, row.suspended_reason, row.failure_count, row.opened_at = CircuitState.CLOSED, None, 0, None
        row.updated_at = self.now()


# ── the issuance state machine ───────────────────────────────────────────

def idempotency_key(quote: TaxQuote) -> str:
    return f"zb:{quote.organization_id}:{quote.document_id}:{quote.id}"


def snapshot_of(txn: ProviderTransaction) -> dict:
    return {
        "state": txn.state.name, "transaction_id": txn.transaction_id, "currency": txn.currency,
        "tax_date": txn.tax_date.isoformat() if txn.tax_date else None,
        "total_tax": str(txn.total_tax) if txn.total_tax is not None else None,
        "total_amount": str(txn.total_amount) if txn.total_amount is not None else None,
        "components": {k: str(v) for k, v in (txn.components or {}).items()},
    }


def drift(quote: TaxQuote, txn: ProviderTransaction) -> list[str]:
    """Differences between our snapshot and the provider's record."""
    problems = []
    if txn.currency is not None and txn.currency != quote.currency:
        problems.append(f"currency {txn.currency} != {quote.currency}")
    if txn.tax_date is not None and txn.tax_date != quote.tax_date:
        problems.append(f"tax date {txn.tax_date} != {quote.tax_date}")
    if txn.total_tax is not None and Decimal(txn.total_tax) != Decimal(quote.tax_amount):
        problems.append(f"tax {txn.total_tax} != {quote.tax_amount}")
    if txn.total_amount is not None and Decimal(txn.total_amount) != Decimal(quote.total_amount):
        problems.append(f"total {txn.total_amount} != {quote.total_amount}")
    ours: dict = {}
    for line in quote.lines:
        for c in line.components:
            ours[c.component_code] = ours.get(c.component_code, Decimal("0")) + Decimal(c.tax_amount)
    if txn.components:
        theirs = {k: Decimal(v) for k, v in txn.components.items()}
        if theirs != ours:
            problems.append("component amounts differ")
    return problems


def build_commit_payload(quote: TaxQuote, row: TaxProviderOutbox, facts: Optional[dict] = None) -> dict:
    """The minimized commit payload (plan §6). No customer names, emails,
    descriptions, notes or PDFs; the buyer is an address only."""
    facts = facts or {}
    seller = facts.get("seller_entity") or {}
    billing = ((facts.get("buyer") or {}).get("addresses") or {}).get("BILLING") or {}
    return {
        "idempotency_key": row.idempotency_key,
        "document_reference": row.document_reference,
        "document_type": "invoice",
        "tax_date": quote.tax_date.isoformat() if quote.tax_date else None,
        "currency": quote.currency,
        "seller": {"country_code": seller.get("country_code"), "subdivision_code": seller.get("subdivision_code")},
        "buyer": {"address": {k: billing.get(k) for k in ("country_code", "subdivision_code", "postal_code", "city")}},
        "lines": [{
            "line_id": line.document_line_id, "quantity": str(line.quantity),
            "net_amount": str(line.taxable_base), "line_discount": str(line.line_discount_unrounded),
            "document_discount": str(line.document_discount_unrounded), "tax_code": line.tax_code,
            "is_tax_inclusive": bool(line.is_tax_inclusive),
            "components": [{"component_code": c.component_code, "tax_amount": str(c.tax_amount)}
                           for c in line.components],
        } for line in quote.lines],
        "totals": {"tax": str(quote.tax_amount), "total": str(quote.total_amount)},
    }


class ProviderIssuanceService:
    def __init__(self, db: Session, provider_lookup: Optional[Callable] = None, now: Callable = _now,
                 finalizer: Optional[Callable] = None, facts_loader: Optional[Callable] = None):
        self.db = db
        self.now = now
        self.provider_lookup = provider_lookup or default_provider_lookup
        self.health = ProviderHealth(db, now=now)
        self.finalizer = finalizer or self._default_finalizer
        self.facts_loader = facts_loader or self._default_facts

    # ── helpers ──
    def _finalization_paused(self) -> Optional[str]:
        from app.modules.super_admin.kill_switch_service import (
            TENANT_INVOICE_FINALIZATION,
            BillingBlockedError,
            BillingKillSwitchService,
        )

        try:
            BillingKillSwitchService(self.db).require_enabled(TENANT_INVOICE_FINALIZATION)
        except BillingBlockedError as exc:
            return str(exc)
        return None

    def _default_facts(self, quote: TaxQuote) -> dict:
        from app.modules.tax.context_builder import TaxContextBuilder

        try:
            return TaxContextBuilder(self.db).build(quote.organization_id, "invoice", quote.document_id,
                                                    now=self.now()).facts
        except Exception:                               # payload facts are best-effort; amounts come from the quote
            logger.exception("tax context unavailable for provider payload (quote %s)", quote.id)
            return {}

    def _default_finalizer(self, invoice, quote: TaxQuote, actor_id: Optional[int]) -> None:
        from app.modules.billing.services.invoice_service import InvoiceService

        InvoiceService(self.db).complete_governed_issue(invoice, quote, actor_id, commit=False)

    def _policy(self) -> DocumentReferencePolicy:
        try:
            return DocumentReferencePolicy(str(settings.TAX_PROVIDER_DOCUMENT_REFERENCE).lower())
        except ValueError:
            return DocumentReferencePolicy.KEY_ONLY

    def active_row(self, invoice_id: int) -> Optional[TaxProviderOutbox]:
        return self.db.query(TaxProviderOutbox).filter(
            TaxProviderOutbox.invoice_id == invoice_id, TaxProviderOutbox.operation == OutboxOperation.COMMIT,
            TaxProviderOutbox.state.in_(list(ACTIVE_OUTBOX_STATES))).first()

    def _lock(self, row_id: int) -> Optional[TaxProviderOutbox]:
        """FOR UPDATE SKIP LOCKED on Postgres: two reconcilers never work the same row."""
        q = self.db.query(TaxProviderOutbox).filter(TaxProviderOutbox.id == row_id)
        if self.db.get_bind().dialect.name == "postgresql":
            q = q.with_for_update(skip_locked=True)
        return q.first()

    def _refuse(self, quote: Optional[TaxQuote], reason: str, unavailable: bool = True):
        if quote is not None and unavailable and quote.status in (TaxQuoteStatus.QUOTED, TaxQuoteStatus.VALIDATED):
            quote.status = TaxQuoteStatus.PROVIDER_UNAVAILABLE
            quote.stale_reason = reason
            self.db.commit()
        raise ProviderIssuanceBlocked(reason)

    # ── transaction 1 ──
    def begin(self, invoice, quote: TaxQuote, actor_id: Optional[int]) -> TaxProviderOutbox:
        paused = self._finalization_paused()
        if paused:
            raise BadRequestException(paused)                     # nothing sent, quote untouched
        existing = self.active_row(invoice.id)
        if existing is not None:
            return existing
        adapter = self.provider_lookup(quote.provider_name)
        if adapter is None:
            self._refuse(quote, f"Tax provider {quote.provider_name!r} is not configured; the invoice was not issued.")
        if adapter.capabilities().mode == ProviderMode.ESTIMATE_ONLY:
            raise ProviderIssuanceBlocked(
                f"The {quote.provider_name} connection is estimate-only: it can quote but can never issue. "
                "The invoice stays a draft.")
        problem = self.health.circuit_problem(quote.provider_name) or self.health.heartbeat_problem()
        if problem:
            self._refuse(quote, problem)
        key = idempotency_key(quote)
        reference = invoice.invoice_number if self._policy() == DocumentReferencePolicy.INVOICE_NUMBER else key
        now = self.now()
        grace = now + timedelta(minutes=settings.TAX_PROVIDER_GRACE_MINUTES)
        if quote.expires_at is not None:
            grace = min(grace, _aware(quote.expires_at))
        row = TaxProviderOutbox(
            organization_id=invoice.organization_id, invoice_id=invoice.id, tax_quote_id=quote.id,
            operation=OutboxOperation.COMMIT, provider_name=quote.provider_name, idempotency_key=key,
            document_reference=reference, state=OutboxState.PENDING, attempts=0, next_attempt_at=now,
            grace_deadline=grace, created_by=actor_id, created_at=now, updated_at=now,
        )
        quote.status = TaxQuoteStatus.VALIDATED
        quote.validated_at = now
        quote.remote_commit_state = RemoteCommitState.PENDING
        self.db.add(row)
        self.db.commit()
        return row

    # ── deliver (one attempt) ──
    def deliver(self, row_id: int) -> Optional[TaxProviderOutbox]:
        row = self._lock(row_id)
        if row is None or row.state not in (OutboxState.PENDING, OutboxState.UNCERTAIN):
            return row
        quote = self.db.get(TaxQuote, row.tax_quote_id)
        adapter = self.provider_lookup(row.provider_name)
        now = self.now()
        row.updated_at = now
        if adapter is None:
            row.last_error = "provider not configured"
            row.next_attempt_at = now + timedelta(seconds=settings.TAX_PROVIDER_RECONCILIATION_INTERVAL_SECONDS)
            self.db.commit()
            return row

        if row.state == OutboxState.UNCERTAIN:
            # Never retry a timed-out commit: ask the provider what it holds.
            try:
                txn = adapter.transaction_state(idempotency_key=row.idempotency_key)
            except ProviderError as exc:
                return self._retry_later(row, adapter, f"state lookup failed: {exc}")
            if txn.state == RemoteTransactionState.COMMITTED:
                self.health.record_success(row.provider_name)
                self._remote_committed(row, quote, txn)
                self.db.commit()
                return row
            if txn.state == RemoteTransactionState.VOIDED:
                self._review(row, "The provider reports this transaction as voided, but we never voided it.")
                self.db.commit()
                return row
            # NOT_FOUND: the timed-out attempt never landed; commit with the same key.

        if self.health.circuit_problem(row.provider_name):
            row.next_attempt_at = now + timedelta(seconds=settings.TAX_PROVIDER_CB_COOLDOWN_SECONDS)
            row.last_error = "circuit open"
            self.db.commit()
            return row

        row.attempts += 1
        try:
            transaction_id = adapter.commit(idempotency_key=row.idempotency_key,
                                            payload=build_commit_payload(quote, row, self.facts_loader(quote)))
        except ProviderTimeout as exc:
            row.state = OutboxState.UNCERTAIN
            return self._retry_later(row, adapter, f"commit timed out: {exc}", immediate=True)
        except ProviderRateLimited as exc:
            row.last_error = f"rate limited: {exc}"
            row.next_attempt_at = now + timedelta(seconds=exc.retry_after_seconds)
            self.db.commit()
            return row
        except ProviderError as exc:
            row.state = OutboxState.FAILED
            row.last_error = f"provider refused the commit: {exc}"
            row.completed_at = now
            self.health.record_failure(row.provider_name)
            quote.status = TaxQuoteStatus.PROVIDER_UNAVAILABLE
            quote.stale_reason = row.last_error
            self.db.commit()
            return row
        self.health.record_success(row.provider_name)
        try:
            txn = adapter.transaction_state(idempotency_key=row.idempotency_key)
        except ProviderError:
            txn = ProviderTransaction(state=RemoteTransactionState.COMMITTED, transaction_id=transaction_id)
        if txn.transaction_id is None:
            txn = ProviderTransaction(**{**txn.__dict__, "transaction_id": transaction_id})
        self._remote_committed(row, quote, txn)
        self.db.commit()
        return row

    def _retry_later(self, row, adapter, error: str, immediate: bool = False):
        row.last_error = error
        self.health.record_failure(row.provider_name)
        row.next_attempt_at = self.now() if immediate else \
            self.now() + timedelta(seconds=settings.TAX_PROVIDER_RECONCILIATION_INTERVAL_SECONDS)
        self.db.commit()
        return row

    def _remote_committed(self, row, quote: TaxQuote, txn: ProviderTransaction) -> None:
        row.state = OutboxState.REMOTE_COMMITTED
        row.provider_transaction_id = txn.transaction_id
        row.remote_snapshot = snapshot_of(txn)
        row.last_error = None
        quote.provider_correlation_id = txn.transaction_id
        quote.remote_commit_state = RemoteCommitState.COMMITTED
        problems = drift(quote, txn)
        if problems:
            self._review(row, "The provider's record differs from our quote: " + "; ".join(problems))

    def _review(self, row, reason: str) -> None:
        row.state = OutboxState.REVIEW_REQUIRED
        row.review_reason = reason
        row.updated_at = self.now()

    # ── transaction 2 ──
    def finalize(self, row_id: int, actor_id: Optional[int] = None) -> Optional[TaxProviderOutbox]:
        row = self._lock(row_id)
        if row is None or row.state != OutboxState.REMOTE_COMMITTED:
            return row
        from app.modules.billing.models import Invoice

        quote = self.db.get(TaxQuote, row.tax_quote_id)
        invoice = self.db.get(Invoice, row.invoice_id)
        paused = self._finalization_paused()
        error = paused and f"finalization paused: {paused}"
        if not error:
            self.db.info[FINALIZING_FLAG] = True
            try:
                self.finalizer(invoice, quote, actor_id or row.created_by)
                row.state = OutboxState.DONE
                row.completed_at = row.updated_at = self.now()
                self.db.commit()
            except Exception as exc:                          # rolled back; retried within the grace window
                self.db.rollback()
                error = f"local finalize failed: {exc}"
                logger.warning("provider issuance %s: %s", row_id, error)
            finally:
                self.db.info.pop(FINALIZING_FLAG, None)
            if not error:
                self._enqueue_link(row)
                return row
        row = self.db.get(TaxProviderOutbox, row_id)
        row.last_error, row.updated_at = error, self.now()
        if self.now() >= _aware(row.grace_deadline):
            self._compensate(row, error)
        self.db.commit()
        return row

    def _enqueue_link(self, row: TaxProviderOutbox) -> None:
        if self._policy() != DocumentReferencePolicy.KEY_ONLY:
            return
        adapter = self.provider_lookup(row.provider_name)
        if adapter is None or not adapter.capabilities().link_reference:
            return
        from app.modules.billing.models import Invoice

        invoice = self.db.get(Invoice, row.invoice_id)
        now = self.now()
        self.db.add(TaxProviderOutbox(
            organization_id=row.organization_id, invoice_id=row.invoice_id, tax_quote_id=row.tax_quote_id,
            operation=OutboxOperation.LINK, provider_name=row.provider_name,
            idempotency_key=f"{row.idempotency_key}:link", document_reference=invoice.invoice_number,
            provider_transaction_id=row.provider_transaction_id, state=OutboxState.PENDING, attempts=0,
            next_attempt_at=now, created_by=row.created_by, created_at=now, updated_at=now,
        ))
        self.db.commit()

    def _compensate(self, row: TaxProviderOutbox, reason: str) -> None:
        """After the grace window: void by reference, only if the invoice was
        never sent anywhere; otherwise a person decides."""
        from app.modules.billing.models import Invoice, InvoiceStatus

        invoice = self.db.get(Invoice, row.invoice_id)
        quote = self.db.get(TaxQuote, row.tax_quote_id)
        if invoice.status != InvoiceStatus.DRAFT or invoice.sent_at is not None:
            self._review(row, f"Not voided: the invoice may have been sent ({reason}).")
            return
        adapter = self.provider_lookup(row.provider_name)
        try:
            if adapter is None:
                raise ProviderError("provider not configured")
            adapter.void(transaction_id=row.provider_transaction_id, idempotency_key=f"{row.idempotency_key}:void",
                         reason=reason[:200])
        except ProviderError as exc:
            self._review(row, f"Void by reference failed after the grace window: {exc}")
            return
        now = self.now()
        row.state, row.completed_at, row.updated_at = OutboxState.VOIDED, now, now
        quote.remote_commit_state = RemoteCommitState.VOIDED
        quote.status = TaxQuoteStatus.VOIDED
        quote.voided_at = now
        quote.void_reason = f"Provider transaction voided: {reason}"[:1000]

    # ── the whole issue, inline ──
    def issue(self, invoice, quote: TaxQuote, actor_id: Optional[int]):
        """Transaction 1, one inline delivery, transaction 2. Returns the
        invoice: SENT when the provider confirmed in time, otherwise a locked
        DRAFT that reconciliation finishes ("Issuing — waiting on provider")."""
        row = self.begin(invoice, quote, actor_id)
        self.deliver(row.id)
        self.finalize(row.id, actor_id)
        self.db.refresh(invoice)
        return invoice

    # ── reconciliation job ──
    def reconcile(self) -> dict:
        now = self.now()
        hb = self.db.get(TaxJobHeartbeat, RECONCILIATION_JOB) or TaxJobHeartbeat(job_name=RECONCILIATION_JOB)
        hb.last_started_at = now
        self.db.add(hb)
        self.db.commit()
        stats = {"delivered": 0, "finalized": 0, "voided": 0, "linked": 0, "review": 0, "drift": 0}
        ok = True
        try:
            due = self.db.query(TaxProviderOutbox.id).filter(
                TaxProviderOutbox.operation == OutboxOperation.COMMIT,
                TaxProviderOutbox.state.in_([OutboxState.PENDING, OutboxState.UNCERTAIN]),
                (TaxProviderOutbox.next_attempt_at.is_(None)) | (TaxProviderOutbox.next_attempt_at <= now),
            ).order_by(TaxProviderOutbox.id).all()
            for (row_id,) in due:
                self.deliver(row_id)
                stats["delivered"] += 1
            committed = self.db.query(TaxProviderOutbox.id).filter(
                TaxProviderOutbox.operation == OutboxOperation.COMMIT,
                TaxProviderOutbox.state == OutboxState.REMOTE_COMMITTED).order_by(TaxProviderOutbox.id).all()
            for (row_id,) in committed:
                row = self.finalize(row_id)
                if row is not None and row.state == OutboxState.DONE:
                    stats["finalized"] += 1
                elif row is not None and row.state == OutboxState.VOIDED:
                    stats["voided"] += 1
                elif row is not None and row.state == OutboxState.REVIEW_REQUIRED:
                    stats["review"] += 1
            stats["linked"] = self._process_links()
            stats["drift"] = self._drift_check()
        except Exception:
            ok = False
            self.db.rollback()
            logger.exception("tax provider reconciliation failed")
        hb = self.db.get(TaxJobHeartbeat, RECONCILIATION_JOB)
        hb.last_finished_at = self.now()
        hb.last_ok = ok
        hb.stats = stats
        self.db.commit()
        return stats

    def _process_links(self) -> int:
        done = 0
        rows = self.db.query(TaxProviderOutbox.id).filter(
            TaxProviderOutbox.operation == OutboxOperation.LINK,
            TaxProviderOutbox.state.in_([OutboxState.PENDING, OutboxState.UNCERTAIN])).all()
        for (row_id,) in rows:
            row = self._lock(row_id)
            if row is None:
                continue
            adapter = self.provider_lookup(row.provider_name)
            row.attempts += 1
            try:
                if adapter is None:
                    raise ProviderError("provider not configured")
                adapter.link_reference(transaction_id=row.provider_transaction_id,
                                       document_reference=row.document_reference)
                row.state, row.completed_at = OutboxState.DONE, self.now()
                done += 1
            except ProviderError as exc:
                row.last_error = str(exc)
            row.updated_at = self.now()
            self.db.commit()
        return done

    def _drift_check(self) -> int:
        """Recently committed transactions: our snapshot against the provider's record."""
        from app.modules.tax.models import TaxReviewItem

        since = self.now() - timedelta(hours=settings.TAX_PROVIDER_DRIFT_WINDOW_HOURS)
        found = 0
        rows = self.db.query(TaxProviderOutbox).filter(
            TaxProviderOutbox.operation == OutboxOperation.COMMIT, TaxProviderOutbox.state == OutboxState.DONE,
            TaxProviderOutbox.completed_at >= since).all()
        for row in rows:
            adapter = self.provider_lookup(row.provider_name)
            if adapter is None:
                continue
            try:
                txn = adapter.transaction_state(idempotency_key=row.idempotency_key)
            except ProviderError:
                continue
            quote = self.db.get(TaxQuote, row.tax_quote_id)
            problems = drift(quote, txn) if txn.state == RemoteTransactionState.COMMITTED else \
                [f"provider reports {txn.state.name}"]
            if not problems:
                continue
            open_item = self.db.query(TaxReviewItem).filter(
                TaxReviewItem.organization_id == row.organization_id,
                TaxReviewItem.kind == ReviewItemKind.PROVIDER_DRIFT, TaxReviewItem.subject_type == "TaxProviderOutbox",
                TaxReviewItem.subject_id == row.id, TaxReviewItem.status == ReviewItemStatus.OPEN).first()
            if open_item is None:
                self.db.add(TaxReviewItem(organization_id=row.organization_id, kind=ReviewItemKind.PROVIDER_DRIFT,
                                          subject_type="TaxProviderOutbox", subject_id=row.id,
                                          detail="; ".join(problems)[:2000], created_at=self.now()))
                found += 1
        self.db.commit()
        return found


# ── platform view: aggregates only (T13) ─────────────────────────────────

def aggregate_health(db: Session, now: Callable = _now) -> dict:
    """Counts per state, oldest active age and circuit state per provider,
    and the heartbeat. No organization, invoice or customer identifiers."""
    from sqlalchemy import func

    current = now()
    providers: dict = {}
    for name, state, count, oldest in db.query(
            TaxProviderOutbox.provider_name, TaxProviderOutbox.state, func.count(TaxProviderOutbox.id),
            func.min(TaxProviderOutbox.created_at)).group_by(TaxProviderOutbox.provider_name,
                                                             TaxProviderOutbox.state):
        p = providers.setdefault(name, {"counts": {}, "oldest_active_age_seconds": None, "circuit": "CLOSED"})
        p["counts"][state.name] = count
        if state in ACTIVE_OUTBOX_STATES or state == OutboxState.REVIEW_REQUIRED:
            age = int((current - _aware(oldest)).total_seconds())
            p["oldest_active_age_seconds"] = max(age, p["oldest_active_age_seconds"] or 0)
    for circuit in db.query(TaxProviderCircuit):
        p = providers.setdefault(circuit.provider_name,
                                 {"counts": {}, "oldest_active_age_seconds": None, "circuit": "CLOSED"})
        p["circuit"] = circuit.state.name
    hb = db.get(TaxJobHeartbeat, RECONCILIATION_JOB)
    return {
        "providers": [{"provider": name, **data} for name, data in sorted(providers.items())],
        "reconciliation": {
            "last_finished_age_seconds": int((current - _aware(hb.last_finished_at)).total_seconds())
            if hb and hb.last_finished_at else None,
            "last_ok": bool(hb and hb.last_ok),
        },
    }


# ── a locked DRAFT cannot be edited while issuing ────────────────────────

@event.listens_for(Session, "before_flush")
def _guard_issuing_invoices(session, flush_context, instances):
    if session.info.get(FINALIZING_FLAG):
        return
    from app.modules.billing.models import Invoice, InvoiceItem

    ids = set()
    for obj in list(session.dirty) + list(session.deleted) + list(session.new):
        if isinstance(obj, Invoice) and obj.id is not None and (obj in session.new or session.is_modified(obj)
                                                               or obj in session.deleted):
            ids.add(obj.id)
        elif isinstance(obj, InvoiceItem) and obj.invoice_id is not None:
            ids.add(obj.invoice_id)
    if not ids:
        return
    with session.no_autoflush:
        locked = session.query(TaxProviderOutbox.invoice_id).filter(
            TaxProviderOutbox.invoice_id.in_(ids), TaxProviderOutbox.operation == OutboxOperation.COMMIT,
            TaxProviderOutbox.state.in_(list(ACTIVE_OUTBOX_STATES))).first()
    if locked is not None:
        raise ProviderIssuanceBlocked(
            f"Invoice {locked[0]} is being issued (waiting on the tax provider) and cannot be changed.")


def beat_for_tests(db: Session, at: Optional[datetime] = None) -> None:
    """Record a successful reconciliation run (test and fixture helper)."""
    at = at or _now()
    hb = db.get(TaxJobHeartbeat, RECONCILIATION_JOB) or TaxJobHeartbeat(job_name=RECONCILIATION_JOB)
    hb.last_started_at = hb.last_finished_at = at
    hb.last_ok = True
    db.add(hb)
    db.flush()
