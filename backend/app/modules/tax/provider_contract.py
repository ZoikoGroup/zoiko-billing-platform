"""
app/modules/tax/provider_contract.py
------------------------------------
The provider-neutral adapter contract (ZB-TAX-ARCH-001 Phase 4a-1, §09.3).

Every specialist tax provider is reached only through a ProviderAdapter. The
contract is independent of the payment processor (§16): nothing here knows
about Stripe or any other payment integration. Any adapter must pass the
conformance suite in tests/tax_provider_conformance/ before it is registered.

  determine()          non-binding estimate per line
  commit()             the legally binding step, idempotent on our key
  transaction_state()  what the provider holds for a key: state, document
                       totals, per-component amounts, tax date, currency
                       (the drift check compares these with our snapshot)
  void()               compensation / cancellation by reference
  capabilities()       markets, features, rate limits and the mode
                       (ESTIMATE_ONLY can quote but never issue)

Adapters translate provider reason codes for untaxed lines into the
canonical REASON_CODES below; anything else is REVIEW_REQUIRED.
"""
import enum
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Optional

from app.modules.tax.enums import RoundingMode, RoundingRule, TaxOutcome


class ProviderError(Exception):
    """Base of every provider failure. An error that is neither a
    ProviderRefused nor a ProviderAmbiguous is treated as ambiguous: the
    request may have been acted on."""


class ProviderRefused(ProviderError):
    """A definite refusal (validation, authentication, unsupported request):
    the provider did NOT act. The commit is FAILED; nothing to reconcile."""


class ProviderAmbiguous(ProviderError):
    """The request may have been acted on (5xx after sending, connection reset
    after the request went out, unknown). Never retried blindly: ask for the
    transaction's state first (T10)."""


class ProviderTimeout(ProviderAmbiguous):
    """No answer in time: the provider may or may not have acted."""


class ProviderRateLimited(ProviderRefused):
    """Throttled: nothing was committed; retry after the indicated delay."""

    def __init__(self, message: str, retry_after_seconds: int = 60):
        super().__init__(message)
        self.retry_after_seconds = retry_after_seconds


class ProviderMode(str, enum.Enum):
    ESTIMATE_ONLY = "estimate_only"     # may quote, can never issue
    COMMIT        = "commit"


class RemoteTransactionState(str, enum.Enum):
    NOT_FOUND = "not_found"
    COMMITTED = "committed"
    VOIDED    = "voided"


#: Canonical reason codes for a line the provider leaves untaxed, mapped to
#: our explicit outcomes (§08.2). Unknown or missing codes where we hold a
#: registration are REVIEW_REQUIRED, never 0% by default.
REASON_CODES = {
    "EXEMPT": TaxOutcome.EXEMPT,
    "ZERO_RATED": TaxOutcome.ZERO_RATED,
    "NON_TAXABLE": TaxOutcome.NON_TAXABLE_BY_RULE,
    "BELOW_THRESHOLD": TaxOutcome.NON_TAXABLE_BY_RULE,
    "REVERSE_CHARGE": TaxOutcome.REVERSE_CHARGE,
    "OUT_OF_SCOPE": TaxOutcome.OUT_OF_SCOPE,
}


@dataclass(frozen=True)
class ProviderCapabilities:
    markets: tuple = ()                      # (("CA", "GST"), ...)
    address_validation: bool = False
    exemptions: bool = False
    void: bool = True
    adjust: bool = False
    link_reference: bool = False
    max_requests_per_minute: Optional[int] = None
    mode: ProviderMode = ProviderMode.COMMIT


@dataclass(frozen=True)
class ProviderTransaction:
    """What the provider holds for one of our idempotency keys."""
    state: RemoteTransactionState
    transaction_id: Optional[str] = None
    currency: Optional[str] = None
    tax_date: Optional[date] = None
    total_tax: Optional[Decimal] = None
    total_amount: Optional[Decimal] = None
    #: {component_code: tax amount}
    components: dict = field(default_factory=dict)


class ProviderAdapter(ABC):
    """A licensed external determination service (§09.3)."""
    name: str
    version: str = "1"
    rounding_rule: RoundingRule = RoundingRule.PER_LINE
    rounding_mode: Optional[RoundingMode] = None
    required_facts: frozenset = frozenset()
    unresolved_buyer_as_consumer: bool = False

    def capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities()

    @abstractmethod
    def determine(self, request):
        """Non-binding estimate for one line (an engines.LineResult)."""

    @abstractmethod
    def commit(self, *, idempotency_key: str, payload: dict) -> str:
        """Commit remotely; return the provider transaction id. Raises
        ProviderRefused (definitely not committed; ProviderRateLimited: retry
        later) or ProviderAmbiguous / ProviderTimeout (outcome unknown)."""

    @abstractmethod
    def transaction_state(self, *, idempotency_key: str) -> ProviderTransaction:
        """The provider's record for this key, with totals for the drift check."""

    @abstractmethod
    def void(self, *, transaction_id: str, idempotency_key: str, reason: str) -> None:
        """Void a committed transaction by reference (compensation)."""

    def adjust(self, *, transaction_id: str, idempotency_key: str, payload: dict) -> str:
        """Credit or return against a committed transaction, by reference
        (T15/T18). Idempotent on the key; same error contract as commit()."""
        raise ProviderRefused(f"{self.name} does not support adjustments.")

    def test_connection(self) -> dict:
        """Check the configured endpoint and credentials. Returns
        {"ok": bool, "detail": str}; never echoes credentials."""
        return {"ok": True, "detail": "not implemented by this adapter"}

    def link_reference(self, *, transaction_id: str, document_reference: str) -> None:
        """Attach our invoice number after commit (option B, KEY_ONLY)."""
        raise ProviderError(f"{self.name} cannot link a document reference.")

    def health(self) -> dict:
        return {"ok": True}


#: Every field a commit / adjust payload may carry (§6 of the Phase 4 plan).
#: Nothing else leaves the platform: no names, emails, descriptions, notes or PDFs.
ALLOWED_COMMIT_FIELDS = frozenset({
    "idempotency_key", "document_reference", "document_type", "tax_date", "currency",
    "seller", "buyer", "lines", "totals", "original_transaction_id",
})


# ── the provider registry: code-defined, never tenant-supplied ───────────

@dataclass(frozen=True)
class ProviderDefinition:
    """A provider Zoiko can talk to. Endpoints are fixed in code per
    environment: a tenant never supplies a URL (no SSRF), and
    test_connection / every call goes only to these hosts."""
    name: str
    factory: object                   # callable(endpoint: str, credentials: str, mode: ProviderMode) -> ProviderAdapter
    endpoints: dict                   # {"SANDBOX": "https://...", "PRODUCTION": "https://..."}

    def endpoint(self, environment: str) -> str:
        url = self.endpoints.get(environment)
        if not url or not url.startswith("https://"):
            raise ProviderRefused(f"{self.name} has no allowlisted {environment} endpoint.")
        return url


#: name -> ProviderDefinition. Empty in production until a provider is
#: contracted (4d); tests register the fake.
PROVIDER_REGISTRY: dict = {}


def provider_definition(name: str) -> Optional[ProviderDefinition]:
    return PROVIDER_REGISTRY.get(name)
ALLOWED_LINE_FIELDS = frozenset({
    "line_id", "quantity", "net_amount", "line_discount", "document_discount", "tax_code", "is_tax_inclusive",
    "components",
})
