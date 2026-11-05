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
              by reference if the invoice was never sent), keeps checking
              unresolved commits, sends recorded email intents once, links
              invoice numbers (KEY_ONLY), verifies and drift-checks commits,
              writes a heartbeat. One failing row never stops the run.
              A stale heartbeat blocks provider issuing.

Errors: a definite refusal (ProviderRefused) FAILS the row; anything else may
have been acted on and is UNCERTAIN until transaction_state says otherwise.
Nothing is committed after quote expiry, and an outcome that stays unknown
past the grace deadline is REVIEW_REQUIRED, never voided blindly.

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
    LOCKING_OUTBOX_STATES,
    TERMINAL_OUTBOX_STATES,
    CircuitState,
    DocumentReferencePolicy,
    OutboxOperation,
    OutboxReviewKind,
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
    ProviderRefused,
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
    """Name-based lookup, used only when a test injects adapters by name."""
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


def snapshot_of(txn: ProviderTransaction, verified: bool = True) -> dict:
    return {
        "verified": verified, "state": txn.state.name, "transaction_id": txn.transaction_id, "currency": txn.currency,
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


def build_commit_payload(db: Session, quote: TaxQuote, row: TaxProviderOutbox) -> dict:
    """The minimized commit payload (plan §6). The buyer is the
    place-of-supply address the quote was determined with, exactly as stored
    on the quote (fix 4); no names, emails, descriptions, notes or PDFs."""
    from app.modules.tax.models import SellerLegalEntity

    seller = db.get(SellerLegalEntity, quote.seller_entity_id) if quote.seller_entity_id else None
    supply = dict(quote.supply_address or {})
    supply.pop("address_id", None)
    supply.pop("resolution_id", None)
    return {
        "idempotency_key": row.idempotency_key,
        "document_reference": row.document_reference,
        "document_type": "invoice",
        "tax_date": quote.tax_date.isoformat() if quote.tax_date else None,
        "currency": quote.currency,
        "seller": {"country_code": getattr(seller, "country_code", None),
                   "subdivision_code": getattr(seller, "subdivision_code", None),
                   "registered_jurisdictions": registered_jurisdictions(db, quote)},
        "buyer": _buyer_payload(db, quote, row, supply),
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


def _buyer_payload(db: Session, quote: TaxQuote, row: TaxProviderOutbox, supply: dict) -> dict:
    """The buyer: address, pseudonymous reference and exemption claims
    (jurisdiction, tax type and reason only; no certificate numbers or files)."""
    from app.modules.billing.models import Invoice
    from app.modules.tax.registry_models import TaxJurisdiction, TaxTypeDefinition

    from app.modules.tax.pseudonym import customer_pseudonym

    buyer = {"address": supply}
    invoice = db.get(Invoice, row.invoice_id) if row.invoice_id else None
    ref = customer_pseudonym(quote.organization_id, getattr(invoice, "customer_id", None))
    if ref:
        buyer["customer_ref"] = ref
    if quote.exemption_claims:
        exemptions = []
        for c in quote.exemption_claims:
            j = db.get(TaxJurisdiction, c["jurisdiction_id"])
            t = db.get(TaxTypeDefinition, c["tax_type_id"]) if c.get("tax_type_id") else None
            exemptions.append({"jurisdiction_code": j.code if j else None, "tax_type": t.code if t else None,
                               "reason_code": c.get("reason_code")})
        buyer["exemptions"] = exemptions
    return buyer


def registered_jurisdictions(db: Session, quote: TaxQuote) -> list:
    """Where the seller entity holds a recorded registration or an approved
    legal basis on the tax date (Phase 4a-2 nexus). The provider may apply
    tax only inside this set; anything else is REVIEW_REQUIRED."""
    from app.modules.tax.enums import TenantApprovalStatus
    from app.modules.tax.models import EntityTaxLegalBasis, EntityTaxRegistration
    from app.modules.tax.registry_models import TaxJurisdiction, TaxTypeDefinition

    if quote.seller_entity_id is None:
        return []
    day = quote.tax_date
    out = []

    def valid(row):
        return (row.valid_from is None or day is None or row.valid_from <= day) and \
            (row.valid_to is None or day is None or day < row.valid_to)

    def codes(row):
        j = db.get(TaxJurisdiction, row.jurisdiction_id)
        t = db.get(TaxTypeDefinition, row.tax_type_id)
        return (j.code if j else None), (t.code if t else None)

    for reg in db.query(EntityTaxRegistration).filter(EntityTaxRegistration.seller_entity_id == quote.seller_entity_id,
                                                      EntityTaxRegistration.organization_id == quote.organization_id):
        if valid(reg):
            j, t = codes(reg)
            out.append({"jurisdiction_code": j, "tax_type": t, "basis": "REGISTRATION",
                        "registration_number": reg.registration_number})
    for basis in db.query(EntityTaxLegalBasis).filter(EntityTaxLegalBasis.seller_entity_id == quote.seller_entity_id,
                                                      EntityTaxLegalBasis.organization_id == quote.organization_id,
                                                      EntityTaxLegalBasis.status == TenantApprovalStatus.APPROVED):
        if valid(basis):
            j, t = codes(basis)
            out.append({"jurisdiction_code": j, "tax_type": t, "basis": "LEGAL_BASIS", "registration_number": None})
    return sorted(out, key=lambda r: (r["jurisdiction_code"] or "", r["tax_type"] or "", r["basis"]))


class ProviderIssuanceService:
    def __init__(self, db: Session, provider_lookup: Optional[Callable] = None, now: Callable = _now,
                 finalizer: Optional[Callable] = None, mailer: Optional[Callable] = None,
                 payload_builder: Optional[Callable] = None):
        self.db = db
        self.now = now
        # Production resolves adapters through the tenant's approved, usable
        # connection (Phase 4a-2); tests may inject a lookup by provider name.
        self._by_name = provider_lookup is not None
        self.provider_lookup = provider_lookup or default_provider_lookup
        self.health = ProviderHealth(db, now=now)
        self.finalizer = finalizer or self._default_finalizer
        self.mailer = mailer or self._default_mailer
        self.payload_builder = payload_builder or build_commit_payload

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

    def _default_finalizer(self, invoice, quote: TaxQuote, actor_id: Optional[int]) -> None:
        from app.modules.billing.services.invoice_service import InvoiceService

        InvoiceService(self.db).complete_governed_issue(invoice, quote, actor_id, commit=False)

    def _default_mailer(self, invoice_id: int, organization_id: int, actor_id: Optional[int]) -> dict:
        from app.modules.billing.services.invoice_service import InvoiceService

        return InvoiceService(self.db).send_invoice_via_email(invoice_id, organization_id, actor_id)

    def _policy(self) -> DocumentReferencePolicy:
        try:
            return DocumentReferencePolicy(str(settings.TAX_PROVIDER_DOCUMENT_REFERENCE).lower())
        except ValueError:
            return DocumentReferencePolicy.KEY_ONLY

    def _adapter(self, obj):
        """The adapter for a quote or outbox row, or None (fail closed). An
        unreachable or refusing secret store is None too, with the reason in
        self.adapter_problem; nothing falls back."""
        self.adapter_problem = None
        if self._by_name:
            return self.provider_lookup(obj.provider_name)
        from app.modules.tax.connection_service import ProviderConnectionService
        from app.modules.tax.secret_store import SecretStoreUnavailable

        try:
            return ProviderConnectionService(self.db).adapter_for_id(getattr(obj, "provider_connection_id", None))
        except SecretStoreUnavailable as exc:
            self.adapter_problem = f"provider credentials are unavailable: {exc.message}"
            return None

    def _past(self, moment: Optional[datetime]) -> bool:
        return moment is not None and self.now() >= _aware(moment)

    def locking_row(self, invoice_id: int) -> Optional[TaxProviderOutbox]:
        """The COMMIT row that currently holds this invoice (active or awaiting review)."""
        return self.db.query(TaxProviderOutbox).filter(
            TaxProviderOutbox.invoice_id == invoice_id, TaxProviderOutbox.operation == OutboxOperation.COMMIT,
            TaxProviderOutbox.state.in_(list(LOCKING_OUTBOX_STATES))).first()

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

    def _review(self, row: TaxProviderOutbox, kind: OutboxReviewKind, reason: str) -> None:
        row.state = OutboxState.REVIEW_REQUIRED
        row.review_kind = kind.name
        row.review_reason = reason[:4000]
        row.updated_at = self.now()

    def _cancel(self, row: TaxProviderOutbox, quote: TaxQuote, reason: str) -> None:
        """Never committed and too late to commit: release the invoice as a
        DRAFT and send the user back to re-quote (Exceptions shows it)."""
        now = self.now()
        row.state, row.completed_at, row.updated_at, row.last_error = OutboxState.CANCELLED, now, now, reason
        if quote.status in (TaxQuoteStatus.QUOTED, TaxQuoteStatus.VALIDATED):
            quote.status = TaxQuoteStatus.STALE
            quote.stale_reason = f"{reason} Request a new tax quote."

    # ── transaction 1 ──
    def begin(self, invoice, quote: TaxQuote, actor_id: Optional[int]) -> TaxProviderOutbox:
        paused = self._finalization_paused()
        if paused:
            raise BadRequestException(paused)                     # nothing sent, quote untouched
        existing = self.locking_row(invoice.id)
        if existing is not None:
            if existing.state == OutboxState.REVIEW_REQUIRED:
                raise ProviderIssuanceBlocked(
                    "This invoice's provider transaction needs review before it can be issued "
                    f"({existing.review_reason or existing.review_kind}).")
            return existing
        adapter = self._adapter(quote)
        if adapter is None:
            self._refuse(quote, f"Tax provider {quote.provider_name!r} is not available "
                                f"({self.adapter_problem or 'not configured'}); the invoice was not issued.")
        if adapter.capabilities().mode == ProviderMode.ESTIMATE_ONLY:
            raise ProviderIssuanceBlocked(
                f"The {quote.provider_name} connection is estimate-only: it can quote but can never issue. "
                "The invoice stays a draft.")
        from app.modules.tax.pseudonym import PseudonymKeyService

        problem = (self.health.circuit_problem(quote.provider_name) or self.health.heartbeat_problem()
                   or PseudonymKeyService(self.db).problem(invoice.organization_id))
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
            provider_connection_id=quote.provider_connection_id,
        )
        quote.status = TaxQuoteStatus.VALIDATED
        quote.validated_at = now
        quote.remote_commit_state = RemoteCommitState.PENDING
        self.db.add(row)
        self.db.commit()
        return row

    def request_send(self, invoice_id: int, actor_id: Optional[int], channel: str = "email") -> Optional[TaxProviderOutbox]:
        """Record that the user asked to send the invoice; delivered exactly
        once after transaction 2 commits (fix 5)."""
        row = self.locking_row(invoice_id)
        if row is None or row.send_intent is not None:
            return row
        row.send_intent = {"channel": channel, "requested_by": actor_id, "requested_at": self.now().isoformat()}
        row.updated_at = self.now()
        self.db.commit()
        return row

    # ── deliver (one attempt) ──
    def deliver(self, row_id: int) -> Optional[TaxProviderOutbox]:
        row = self._lock(row_id)
        if row is None or row.state not in (OutboxState.PENDING, OutboxState.UNCERTAIN):
            return row
        quote = self.db.get(TaxQuote, row.tax_quote_id)
        adapter = self._adapter(row)
        now = self.now()
        row.updated_at = now
        if adapter is None:
            row.last_error = self.adapter_problem or "provider not configured"
            row.next_attempt_at = now + timedelta(seconds=settings.TAX_PROVIDER_RECONCILIATION_INTERVAL_SECONDS)
            self.db.commit()
            return row

        if row.state == OutboxState.UNCERTAIN:
            # Never retry an ambiguous commit: ask the provider what it holds.
            if not self._resolve_uncertain(row, quote, adapter):
                return row
            # NOT_FOUND within the deadlines: commit again with the same key.
        elif self._past(quote.expires_at):
            self._cancel(row, quote, "The tax quote expired before it was sent to the provider.")
            self.db.commit()
            return row

        if self.health.circuit_problem(row.provider_name):
            row.next_attempt_at = now + timedelta(seconds=settings.TAX_PROVIDER_CB_COOLDOWN_SECONDS)
            row.last_error = "circuit open"
            self.db.commit()
            return row
        from app.modules.tax.pseudonym import PseudonymKeyService

        key_problem = PseudonymKeyService(self.db).problem(row.organization_id)
        if key_problem:                                         # nothing is sent under an unacknowledged key
            row.next_attempt_at = now + timedelta(seconds=settings.TAX_PROVIDER_CB_COOLDOWN_SECONDS)
            row.last_error = key_problem
            self.db.commit()
            return row

        payload = self.payload_builder(self.db, quote, row)     # our errors here are not provider errors
        row.attempts += 1
        try:
            transaction_id = adapter.commit(idempotency_key=row.idempotency_key, payload=payload)
        except ProviderRateLimited as exc:
            row.last_error = f"rate limited: {exc}"
            row.next_attempt_at = now + timedelta(seconds=exc.retry_after_seconds)
            self.db.commit()
            return row
        except ProviderRefused as exc:
            row.state = OutboxState.FAILED
            row.last_error = f"provider refused the commit: {exc}"
            row.completed_at = now
            self.health.record_failure(row.provider_name)
            quote.status = TaxQuoteStatus.PROVIDER_UNAVAILABLE
            quote.stale_reason = row.last_error
            self.db.commit()
            return row
        except Exception as exc:                                  # ambiguous: may have been acted on (fix 2)
            row.state = OutboxState.UNCERTAIN
            return self._retry_later(row, f"commit outcome unknown ({type(exc).__name__}: {exc})", immediate=True)
        self.health.record_success(row.provider_name)
        try:
            txn, verified = adapter.transaction_state(idempotency_key=row.idempotency_key), True
        except Exception:                                         # committed, but not yet confirmed (fix 6)
            txn, verified = ProviderTransaction(state=RemoteTransactionState.COMMITTED, transaction_id=transaction_id), False
        if txn.transaction_id is None:
            txn = ProviderTransaction(**{**txn.__dict__, "transaction_id": transaction_id})
        self._remote_committed(row, quote, txn, verified)
        self.db.commit()
        return row

    def _resolve_uncertain(self, row, quote: TaxQuote, adapter) -> bool:
        """Settle an UNCERTAIN row by state lookup. Returns True only when the
        provider definitely holds nothing and a re-commit is still allowed."""
        try:
            txn = adapter.transaction_state(idempotency_key=row.idempotency_key)
        except Exception as exc:
            row.last_error = f"state lookup failed: {exc}"
            self.health.record_failure(row.provider_name)
            if self._past(row.grace_deadline):
                self._review(row, OutboxReviewKind.UNRESOLVED_COMMIT,
                             "The provider's state could not be confirmed by the grace deadline; reconciliation "
                             "keeps checking. Never voided blindly.")
            row.next_attempt_at = self.now() + timedelta(seconds=settings.TAX_PROVIDER_RECONCILIATION_INTERVAL_SECONDS)
            self.db.commit()
            return False
        if txn.state == RemoteTransactionState.COMMITTED:
            self.health.record_success(row.provider_name)
            self._remote_committed(row, quote, txn, True)
            self.db.commit()
            return False
        if txn.state == RemoteTransactionState.VOIDED:
            self._review(row, OutboxReviewKind.PROVIDER_VOIDED,
                         "The provider reports this transaction as voided, but we never voided it.")
            self.db.commit()
            return False
        # NOT_FOUND: definitely not committed.
        if self._past(quote.expires_at) or self._past(row.grace_deadline):
            self._cancel(row, quote, "The provider holds no transaction and the quote is past its deadline.")
            self.db.commit()
            return False
        return True

    def _retry_later(self, row, error: str, immediate: bool = False):
        row.last_error = error
        self.health.record_failure(row.provider_name)
        row.next_attempt_at = self.now() if immediate else \
            self.now() + timedelta(seconds=settings.TAX_PROVIDER_RECONCILIATION_INTERVAL_SECONDS)
        self.db.commit()
        return row

    def _remote_committed(self, row, quote: TaxQuote, txn: ProviderTransaction, verified: bool) -> None:
        row.state = OutboxState.REMOTE_COMMITTED
        row.review_kind = row.review_reason = None
        row.provider_transaction_id = txn.transaction_id
        row.remote_snapshot = snapshot_of(txn, verified)
        row.verified_at = self.now() if verified else None
        row.last_error = None
        quote.provider_correlation_id = txn.transaction_id
        quote.remote_commit_state = RemoteCommitState.COMMITTED
        problems = drift(quote, txn) if verified else []
        if problems:
            self._review(row, OutboxReviewKind.DRIFT, "The provider's record differs from our quote: " + "; ".join(problems))

    def recheck_unresolved(self, row_id: int) -> Optional[TaxProviderOutbox]:
        """Keep checking a commit whose outcome was unknown past the grace
        deadline. Resolved COMMITTED: finish it; NOT_FOUND: cancel. Never void."""
        row = self._lock(row_id)
        if row is None or row.state != OutboxState.REVIEW_REQUIRED \
                or row.review_kind != OutboxReviewKind.UNRESOLVED_COMMIT.name:
            return row
        adapter = self._adapter(row)
        if adapter is None:
            return row
        quote = self.db.get(TaxQuote, row.tax_quote_id)
        try:
            txn = adapter.transaction_state(idempotency_key=row.idempotency_key)
        except Exception as exc:
            row.last_error, row.updated_at = f"state lookup failed: {exc}", self.now()
            self.db.commit()
            return row
        if txn.state == RemoteTransactionState.COMMITTED:
            self._remote_committed(row, quote, txn, True)
            self.db.commit()
            return self.finalize(row_id) if row.state == OutboxState.REMOTE_COMMITTED else row
        if txn.state == RemoteTransactionState.VOIDED:
            self._review(row, OutboxReviewKind.PROVIDER_VOIDED,
                         "The provider reports this transaction as voided, but we never voided it.")
        else:
            self._cancel(row, quote, "The provider holds no transaction for this invoice.")
        self.db.commit()
        return row

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
        email_row_id = None
        if not error:
            self.db.info[FINALIZING_FLAG] = True
            try:
                self.finalizer(invoice, quote, actor_id or row.created_by)
                row.state = OutboxState.DONE
                row.completed_at = row.updated_at = self.now()
                email_row = self._email_row(row)               # same commit as SENT (fix 5)
                self.db.commit()
                email_row_id = email_row.id if email_row is not None else None
            except Exception as exc:                          # rolled back; retried within the grace window
                self.db.rollback()
                error = f"local finalize failed: {exc}"
                logger.warning("provider issuance %s: %s", row_id, error)
            finally:
                self.db.info.pop(FINALIZING_FLAG, None)
            if not error:
                self._enqueue_link(row)
                if email_row_id is not None:
                    self.send_email(email_row_id)              # outside the transaction, exactly once
                return self.db.get(TaxProviderOutbox, row_id)
        row = self.db.get(TaxProviderOutbox, row_id)
        row.last_error, row.updated_at = error, self.now()
        if self._past(row.grace_deadline):
            self._compensate(row, error)
        self.db.commit()
        return row

    def _email_row(self, row: TaxProviderOutbox) -> Optional[TaxProviderOutbox]:
        if not row.send_intent:
            return None
        now = self.now()
        email = TaxProviderOutbox(
            organization_id=row.organization_id, invoice_id=row.invoice_id, tax_quote_id=row.tax_quote_id,
            operation=OutboxOperation.EMAIL, provider_name=row.provider_name,
            idempotency_key=f"{row.idempotency_key}:email", state=OutboxState.PENDING, attempts=0,
            provider_connection_id=row.provider_connection_id,
            send_intent=row.send_intent, next_attempt_at=now,
            created_by=(row.send_intent or {}).get("requested_by") or row.created_by, created_at=now, updated_at=now,
        )
        self.db.add(email)
        self.db.flush()
        return email

    def send_email(self, row_id: int) -> Optional[TaxProviderOutbox]:
        """Deliver a send-by-email intent exactly once. The row is claimed
        (UNCERTAIN) and committed before sending; an interrupted attempt is
        never retried automatically (EMAIL_UNCERTAIN review)."""
        from app.modules.billing.models import BillingAuditAction
        from app.modules.billing.services.audit_service import BillingAuditService

        row = self._lock(row_id)
        if row is None or row.operation != OutboxOperation.EMAIL or row.state != OutboxState.PENDING:
            return row
        row.state, row.attempts, row.updated_at = OutboxState.UNCERTAIN, row.attempts + 1, self.now()
        self.db.commit()                                      # claimed: a second worker skips it
        org_id, invoice_id, actor = row.organization_id, row.invoice_id, row.created_by
        delivered, error = False, None
        try:
            result = self.mailer(invoice_id, org_id, actor) or {}
            delivered = bool(result.get("email_delivered"))
            error = None if delivered else (result.get("message") or "not delivered")
        except Exception as exc:
            self.db.rollback()
            error = f"{type(exc).__name__}: {exc}"
        row = self.db.get(TaxProviderOutbox, row_id)
        now = self.now()
        row.state = OutboxState.DONE if delivered else OutboxState.FAILED
        row.completed_at = row.updated_at = now
        row.last_error = error
        BillingAuditService(self.db).log_no_commit(
            org_id, actor, BillingAuditAction.SEND, "Invoice", invoice_id,
            new_values={"provider_issue_email": "delivered" if delivered else "failed",
                        "error": error, "outbox_id": row.id})
        self.db.commit()
        return row

    def _enqueue_link(self, row: TaxProviderOutbox) -> None:
        if self._policy() != DocumentReferencePolicy.KEY_ONLY:
            return
        adapter = self._adapter(row)
        if adapter is None or not adapter.capabilities().link_reference:
            return
        from app.modules.billing.models import Invoice

        invoice = self.db.get(Invoice, row.invoice_id)
        now = self.now()
        self.db.add(TaxProviderOutbox(
            organization_id=row.organization_id, invoice_id=row.invoice_id, tax_quote_id=row.tax_quote_id,
            operation=OutboxOperation.LINK, provider_name=row.provider_name,
            idempotency_key=f"{row.idempotency_key}:link", document_reference=invoice.invoice_number,
            provider_connection_id=row.provider_connection_id,
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
            self._review(row, OutboxReviewKind.VOID_FAILED, f"Not voided: the invoice may have been sent ({reason}).")
            return
        adapter = self._adapter(row)
        try:
            if adapter is None:
                raise ProviderError("provider not configured")
            adapter.void(transaction_id=row.provider_transaction_id, idempotency_key=f"{row.idempotency_key}:void",
                         reason=reason[:200])
        except Exception as exc:
            self._review(row, OutboxReviewKind.VOID_FAILED, f"Void by reference failed after the grace window: {exc}")
            return
        now = self.now()
        row.state, row.completed_at, row.updated_at = OutboxState.VOIDED, now, now
        quote.remote_commit_state = RemoteCommitState.VOIDED
        quote.status = TaxQuoteStatus.VOIDED
        quote.voided_at = now
        quote.void_reason = f"Provider transaction voided: {reason}"[:1000]

    # ── corrections by reference (Phase 4a-2, T15/T18) ──
    def enqueue_adjust(self, credit_note, quote: TaxQuote, credit_lines: list, actor_id: Optional[int]):
        """A governed credit note against a provider-committed invoice adjusts
        the original provider transaction by reference. Written in the
        caller's transaction (flush only), with the credit note itself."""
        from app.modules.tax.quote_models import TaxQuoteComponent, TaxQuoteLine

        now = self.now()
        codes = {c.id: c.component_code for c in self.db.query(TaxQuoteComponent).filter(
            TaxQuoteComponent.id.in_([cl.tax_quote_component_id for cl in credit_lines] or [0]))}
        doc_lines = {ql.id: ql.document_line_id for ql in self.db.query(TaxQuoteLine).filter(
            TaxQuoteLine.id.in_([cl.tax_quote_line_id for cl in credit_lines] or [0]))}
        lines = {}
        for cl in credit_lines:
            entry = lines.setdefault(cl.tax_quote_line_id, {"line_id": doc_lines.get(cl.tax_quote_line_id),
                                                             "net_amount": Decimal("0"), "components": []})
            entry["components"].append({"component_code": codes.get(cl.tax_quote_component_id),
                                        "tax_amount": str(cl.credited_tax)})
            if len(entry["components"]) == 1:                    # the base is the same for every component
                entry["net_amount"] += Decimal(cl.credited_base)
        tax = sum((Decimal(cl.credited_tax) for cl in credit_lines), Decimal("0"))
        net = sum((Decimal(e["net_amount"]) for e in lines.values()), Decimal("0"))
        payload = {
            "idempotency_key": f"zb:{quote.organization_id}:cn:{credit_note.id}",
            "document_reference": getattr(credit_note, "credit_note_number", None) or f"credit-note-{credit_note.id}",
            "document_type": "credit_note", "original_transaction_id": quote.provider_correlation_id,
            "tax_date": quote.tax_date.isoformat() if quote.tax_date else None, "currency": quote.currency,
            "lines": [{**e, "net_amount": str(e["net_amount"])} for e in lines.values()],
            "totals": {"tax": str(tax), "total": str(net + tax)},
        }
        row = TaxProviderOutbox(
            organization_id=quote.organization_id, invoice_id=quote.document_id, tax_quote_id=quote.id,
            operation=OutboxOperation.ADJUST, provider_name=quote.provider_name,
            provider_connection_id=quote.provider_connection_id, idempotency_key=payload["idempotency_key"],
            document_reference=payload["document_reference"], reference_transaction_id=quote.provider_correlation_id,
            credit_note_id=credit_note.id, request_payload=payload, state=OutboxState.PENDING, attempts=0,
            next_attempt_at=now, grace_deadline=now + timedelta(minutes=settings.TAX_PROVIDER_GRACE_MINUTES),
            created_by=actor_id, created_at=now, updated_at=now)
        self.db.add(row)
        self.db.flush()
        return row

    def enqueue_cancellation(self, invoice, actor_id: Optional[int]):
        """Cancelling or voiding a provider-committed invoice voids the
        provider transaction by reference (flush only, caller's transaction)."""
        quote = self.db.get(TaxQuote, invoice.tax_quote_id) if invoice.tax_quote_id else None
        if quote is None or quote.remote_commit_state != RemoteCommitState.COMMITTED:
            return None
        commit = self.db.query(TaxProviderOutbox).filter(
            TaxProviderOutbox.tax_quote_id == quote.id, TaxProviderOutbox.operation == OutboxOperation.COMMIT,
            TaxProviderOutbox.state == OutboxState.DONE).first()
        if commit is None:
            return None
        now = self.now()
        row = TaxProviderOutbox(
            organization_id=quote.organization_id, invoice_id=invoice.id, tax_quote_id=quote.id,
            operation=OutboxOperation.VOID, provider_name=quote.provider_name,
            provider_connection_id=quote.provider_connection_id, idempotency_key=f"{commit.idempotency_key}:cancel",
            reference_transaction_id=commit.provider_transaction_id, state=OutboxState.PENDING, attempts=0,
            next_attempt_at=now, grace_deadline=now + timedelta(minutes=settings.TAX_PROVIDER_GRACE_MINUTES),
            created_by=actor_id, created_at=now, updated_at=now)
        self.db.add(row)
        self.db.flush()
        return row

    def deliver_correction(self, row_id: int) -> Optional[TaxProviderOutbox]:
        """One attempt at an ADJUST or VOID-by-reference row. Same error
        contract as commit: a refusal needs a person (our credit or
        cancellation stands), an ambiguous outcome is looked up by key."""
        row = self._lock(row_id)
        if row is None or row.operation not in (OutboxOperation.ADJUST, OutboxOperation.VOID) \
                or row.state not in (OutboxState.PENDING, OutboxState.UNCERTAIN):
            return row
        adapter = self._adapter(row)
        now = self.now()
        row.updated_at = now
        if adapter is None:
            row.last_error = "provider connection not usable"
            if self._past(row.grace_deadline):
                self._review(row, OutboxReviewKind.UNRESOLVED_COMMIT,
                             "The provider connection is not usable; the correction has not reached the provider.")
            self.db.commit()
            return row
        original_key = row.idempotency_key.rsplit(":cancel", 1)[0]
        if row.state == OutboxState.UNCERTAIN:
            try:
                txn = adapter.transaction_state(idempotency_key=row.idempotency_key if row.operation ==
                                                OutboxOperation.ADJUST else original_key)
            except Exception as exc:
                row.last_error = f"state lookup failed: {exc}"
                if self._past(row.grace_deadline):
                    self._review(row, OutboxReviewKind.UNRESOLVED_COMMIT,
                                 "The correction's outcome could not be confirmed by the grace deadline; "
                                 "reconciliation keeps checking.")
                self.db.commit()
                return row
            landed = txn.state == (RemoteTransactionState.COMMITTED if row.operation == OutboxOperation.ADJUST
                                   else RemoteTransactionState.VOIDED)
            if landed:
                row.state, row.completed_at, row.verified_at = OutboxState.DONE, now, now
                row.provider_transaction_id = row.provider_transaction_id or txn.transaction_id
                row.remote_snapshot = snapshot_of(txn, True)
                self.db.commit()
                return row
        row.attempts += 1
        try:
            if row.operation == OutboxOperation.ADJUST:
                result = adapter.adjust(transaction_id=row.reference_transaction_id,
                                        idempotency_key=row.idempotency_key, payload=row.request_payload)
            else:
                adapter.void(transaction_id=row.reference_transaction_id, idempotency_key=row.idempotency_key,
                             reason="invoice cancelled")
                result = row.reference_transaction_id
        except ProviderRateLimited as exc:
            row.last_error, row.next_attempt_at = f"rate limited: {exc}", now + timedelta(seconds=exc.retry_after_seconds)
            self.db.commit()
            return row
        except ProviderRefused as exc:
            self._review(row, OutboxReviewKind.VOID_FAILED if row.operation == OutboxOperation.VOID
                         else OutboxReviewKind.ROW_ERROR,
                         f"The provider refused the {row.operation.name.lower()}: {exc}. Our record stands; a person "
                         "must settle the provider side.")
            self.db.commit()
            return row
        except Exception as exc:
            row.state, row.last_error, row.next_attempt_at = OutboxState.UNCERTAIN, f"outcome unknown: {exc}", now
            self.db.commit()
            return row
        row.state, row.completed_at = OutboxState.DONE, now
        row.provider_transaction_id = result
        try:
            key = row.idempotency_key if row.operation == OutboxOperation.ADJUST else original_key
            row.remote_snapshot = snapshot_of(adapter.transaction_state(idempotency_key=key), True)
            row.verified_at = now
        except Exception:
            row.remote_snapshot = {"verified": False, "transaction_id": result}
        self.db.commit()
        return row

    # ── stuck-transaction actions (tenant; Phase 4a-2) ──
    def check_state(self, row_id: int) -> dict:
        """Read-only: what the provider holds for this row's key. Changes nothing."""
        row = self.db.get(TaxProviderOutbox, row_id)
        adapter = self._adapter(row)
        if adapter is None:
            return {"available": False, "detail": "The provider connection is not usable."}
        key = row.idempotency_key.rsplit(":cancel", 1)[0] if row.operation == OutboxOperation.VOID \
            else row.idempotency_key
        try:
            return {"available": True, "provider": snapshot_of(adapter.transaction_state(idempotency_key=key), True)}
        except Exception as exc:
            return {"available": False, "detail": type(exc).__name__}

    def retry(self, row_id: int) -> TaxProviderOutbox:
        """Put a row that failed on our side back in the queue. Safe: an
        uncommitted row is retried through a state lookup first."""
        row = self._lock(row_id)
        if row is None or row.state != OutboxState.REVIEW_REQUIRED \
                or row.review_kind not in (OutboxReviewKind.ROW_ERROR.name, OutboxReviewKind.UNRESOLVED_COMMIT.name):
            raise BadRequestException("Only rows that failed on our side or whose outcome is unresolved can be retried.")
        row.review_kind = row.review_reason = None
        row.state = OutboxState.REMOTE_COMMITTED if (row.operation == OutboxOperation.COMMIT and
                                                     row.provider_transaction_id) else OutboxState.UNCERTAIN
        row.next_attempt_at, row.updated_at = self.now(), self.now()
        self.db.commit()
        return row

    def request_void(self, row_id: int, actor_id: int) -> TaxProviderOutbox:
        row = self._lock(row_id)
        if row is None or row.operation != OutboxOperation.COMMIT or row.state != OutboxState.REVIEW_REQUIRED \
                or not row.provider_transaction_id:
            raise BadRequestException("Only a committed provider transaction that needs review can be voided.")
        row.void_requested_by, row.void_requested_at, row.updated_at = actor_id, self.now(), self.now()
        self.db.commit()
        return row

    def approve_void(self, row_id: int, actor_id: int) -> TaxProviderOutbox:
        """The second person: void by reference, only if never sent."""
        row = self._lock(row_id)
        if row is None or row.void_requested_by is None or row.state != OutboxState.REVIEW_REQUIRED:
            raise BadRequestException("There is no pending void request for this transaction.")
        if row.void_requested_by == actor_id:
            raise BadRequestException("You requested this void; a different user must approve it.")
        self._compensate(row, f"void approved after review (requested by user {row.void_requested_by})")
        self.db.commit()
        return row

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
    def _ids(self, *criteria) -> list:
        return [i for (i,) in self.db.query(TaxProviderOutbox.id).filter(*criteria).order_by(TaxProviderOutbox.id)]

    def _safely(self, step: Callable, row_id: int, stats: dict) -> Optional[TaxProviderOutbox]:
        """Poison-row isolation (fix 1): an unexpected error on one row moves
        that row to REVIEW_REQUIRED and the run carries on."""
        try:
            return step(row_id)
        except Exception as exc:
            self.db.rollback()
            self.db.info.pop(FINALIZING_FLAG, None)
            logger.exception("tax provider reconciliation: row %s failed", row_id)
            stats["row_failures"] += 1
            row = self.db.get(TaxProviderOutbox, row_id)
            if row is not None and row.state not in TERMINAL_OUTBOX_STATES:
                self._review(row, OutboxReviewKind.ROW_ERROR, f"{type(exc).__name__}: {exc}")
                self.db.commit()
            return None

    def reconcile(self) -> dict:
        now = self.now()
        hb = self.db.get(TaxJobHeartbeat, RECONCILIATION_JOB) or TaxJobHeartbeat(job_name=RECONCILIATION_JOB)
        hb.last_started_at = now
        self.db.add(hb)
        self.db.commit()
        stats = {"delivered": 0, "finalized": 0, "voided": 0, "cancelled": 0, "review": 0, "linked": 0,
                 "emailed": 0, "drift": 0, "verified": 0, "row_failures": 0}
        ok = True
        try:
            commit = TaxProviderOutbox.operation == OutboxOperation.COMMIT
            due = self._ids(commit, TaxProviderOutbox.state.in_([OutboxState.PENDING, OutboxState.UNCERTAIN]),
                            (TaxProviderOutbox.next_attempt_at.is_(None)) | (TaxProviderOutbox.next_attempt_at <= now))
            for row_id in due:
                if self._safely(self.deliver, row_id, stats) is not None:
                    stats["delivered"] += 1
            for row_id in self._ids(commit, TaxProviderOutbox.state == OutboxState.REVIEW_REQUIRED,
                                    TaxProviderOutbox.review_kind == OutboxReviewKind.UNRESOLVED_COMMIT.name):
                self._safely(self.recheck_unresolved, row_id, stats)
            for row_id in self._ids(commit, TaxProviderOutbox.state == OutboxState.REMOTE_COMMITTED):
                row = self._safely(self.finalize, row_id, stats)
                if row is not None:
                    key = {OutboxState.DONE: "finalized", OutboxState.VOIDED: "voided",
                           OutboxState.REVIEW_REQUIRED: "review"}.get(row.state)
                    if key:
                        stats[key] += 1
            corrections = TaxProviderOutbox.operation.in_([OutboxOperation.ADJUST, OutboxOperation.VOID])
            for row_id in self._ids(corrections, TaxProviderOutbox.state.in_([OutboxState.PENDING, OutboxState.UNCERTAIN]),
                                    (TaxProviderOutbox.next_attempt_at.is_(None)) |
                                    (TaxProviderOutbox.next_attempt_at <= now)):
                self._safely(self.deliver_correction, row_id, stats)
            for row_id in self._ids(TaxProviderOutbox.operation == OutboxOperation.EMAIL,
                                    TaxProviderOutbox.state == OutboxState.UNCERTAIN):
                self._safely(self._email_interrupted, row_id, stats)
            for row_id in self._ids(TaxProviderOutbox.operation == OutboxOperation.EMAIL,
                                    TaxProviderOutbox.state == OutboxState.PENDING):
                row = self._safely(self.send_email, row_id, stats)
                if row is not None and row.state == OutboxState.DONE:
                    stats["emailed"] += 1
            for row_id in self._ids(TaxProviderOutbox.operation == OutboxOperation.LINK,
                                    TaxProviderOutbox.state.in_([OutboxState.PENDING, OutboxState.UNCERTAIN])):
                row = self._safely(self._link, row_id, stats)
                if row is not None and row.state == OutboxState.DONE:
                    stats["linked"] += 1
            since = now - timedelta(hours=settings.TAX_PROVIDER_DRIFT_WINDOW_HOURS)
            for row_id in self._ids(commit, TaxProviderOutbox.state == OutboxState.DONE,
                                    (TaxProviderOutbox.completed_at >= since) | TaxProviderOutbox.verified_at.is_(None)):
                self._safely(lambda rid: self._verify(rid, stats), row_id, stats)
            stats["cancelled"] = self.db.query(TaxProviderOutbox).filter(
                TaxProviderOutbox.state == OutboxState.CANCELLED, TaxProviderOutbox.completed_at >= now).count()
        except Exception:                                     # job-level: the database itself, not a row
            ok = False
            self.db.rollback()
            logger.exception("tax provider reconciliation failed")
        try:                                                  # Phase 4d-0: credential version housekeeping
            from app.modules.tax.connection_service import sweep_secret_versions

            stats.update(sweep_secret_versions(self.db, now))
        except Exception:
            self.db.rollback()
            logger.exception("tax provider reconciliation: credential version sweep failed")
        try:
            hb = self.db.get(TaxJobHeartbeat, RECONCILIATION_JOB)
            hb.last_finished_at = self.now()
            hb.last_ok = ok
            hb.stats = stats
            self.db.commit()
        except Exception:
            self.db.rollback()
            logger.exception("tax provider reconciliation could not record its heartbeat")
        return stats

    def _email_interrupted(self, row_id: int):
        row = self._lock(row_id)
        if row is not None and row.state == OutboxState.UNCERTAIN:
            self._review(row, OutboxReviewKind.EMAIL_UNCERTAIN,
                         "An email attempt was interrupted; it is not resent automatically to avoid a duplicate.")
            self.db.commit()
        return row

    def _link(self, row_id: int):
        row = self._lock(row_id)
        if row is None:
            return None
        adapter = self._adapter(row)
        row.attempts += 1
        try:
            if adapter is None:
                raise ProviderError("provider not configured")
            adapter.link_reference(transaction_id=row.provider_transaction_id,
                                   document_reference=row.document_reference)
            row.state, row.completed_at = OutboxState.DONE, self.now()
        except ProviderError as exc:
            row.last_error = str(exc)
        row.updated_at = self.now()
        self.db.commit()
        return row

    def _verify(self, row_id: int, stats: dict):
        """Drift check; also confirms snapshots left unverified at commit (fix 6),
        whatever their age."""
        from app.modules.tax.models import TaxReviewItem

        row = self.db.get(TaxProviderOutbox, row_id)
        adapter = self._adapter(row)
        if adapter is None:
            return row
        try:
            txn = adapter.transaction_state(idempotency_key=row.idempotency_key)
        except ProviderError:
            return row
        quote = self.db.get(TaxQuote, row.tax_quote_id)
        problems = drift(quote, txn) if txn.state == RemoteTransactionState.COMMITTED else \
            [f"provider reports {txn.state.name}"]
        if row.verified_at is None:
            row.verified_at = self.now()
            row.remote_snapshot = snapshot_of(txn, True)
            stats["verified"] += 1
        if problems:
            open_item = self.db.query(TaxReviewItem).filter(
                TaxReviewItem.organization_id == row.organization_id,
                TaxReviewItem.kind == ReviewItemKind.PROVIDER_DRIFT, TaxReviewItem.subject_type == "TaxProviderOutbox",
                TaxReviewItem.subject_id == row.id, TaxReviewItem.status == ReviewItemStatus.OPEN).first()
            if open_item is None:
                self.db.add(TaxReviewItem(organization_id=row.organization_id, kind=ReviewItemKind.PROVIDER_DRIFT,
                                          subject_type="TaxProviderOutbox", subject_id=row.id,
                                          detail="; ".join(problems)[:2000], created_at=self.now()))
                stats["drift"] += 1
        self.db.commit()
        return row


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
            TaxProviderOutbox.state.in_(list(LOCKING_OUTBOX_STATES))).first()
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
