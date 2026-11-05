"""
Fake tax provider for ZB-TAX-ARCH-001 tests (Phase 3a T10, Phase 4a-1
outbox, reconciliation and conformance). Never registered in
app.modules.tax.engines.PROVIDERS.

It implements the full adapter contract (provider_contract.ProviderAdapter)
and keeps an in-memory "remote" ledger keyed by our idempotency key, so a
test can see exactly what the provider holds. Faults are injected with
`fail` (a set of mode names; a mode listed in `once` fires only once):

  timeout_after_success    commit lands remotely, then the caller times out
  timeout_before_success   the caller times out and nothing lands
  ambiguous_after_success  commit lands, then the connection resets (ProviderAmbiguous)
  server_error             a 5xx after sending; nothing landed (ProviderAmbiguous)
  commit_error             the provider refuses the commit (ProviderRefused: definite)
  rate_limited             the provider throttles the commit
  state_error              transaction_state fails
  void_error               void fails
  determine_error          the estimate fails (PROVIDER_UNAVAILABLE)

`result_hook(request, result)` lets a test reshape an estimate (reason codes,
foreign jurisdictions, a different tax date) and `remote_tax_delta` makes the
provider's recorded totals drift from ours.
"""
from datetime import date
from decimal import Decimal

from app.modules.tax.engines import ComponentResult, EngineRequest, LineResult
from app.modules.tax.enums import RoundingMode, TaxOutcome
from app.modules.tax.provider_contract import (
    ALLOWED_COMMIT_FIELDS,
    ProviderAdapter,
    ProviderCapabilities,
    ProviderError,
    ProviderAmbiguous,
    ProviderMode,
    ProviderRateLimited,
    ProviderRefused,
    ProviderTimeout,
    ProviderTransaction,
    RemoteTransactionState,
)

FAKE_SECRET = "sk_fake_SUPERSECRET_3141"


class FakeTaxProvider(ProviderAdapter):
    name = "fake-provider"
    version = "1-test"
    rounding_mode = RoundingMode.HALF_UP

    def __init__(self, rate: Decimal = Decimal("10"), fail_mode: str = "", mode: ProviderMode = ProviderMode.COMMIT,
                 link: bool = True, result_hook=None, secret: str = FAKE_SECRET):
        self.rate = Decimal(rate)
        self.fail = {fail_mode} if fail_mode else set()
        self.once = {fail_mode} if fail_mode else set()
        self.mode = mode
        self.link = link
        self.result_hook = result_hook
        self.secret = secret                       # stands in for a credential: must never leak
        self.remote_tax_delta = Decimal("0")
        self.commit_calls = 0
        self.void_calls = 0
        self.ledger: dict = {}                     # idempotency_key -> {"id", "state", "payload"}
        self.links: dict = {}
        self.payloads: list = []

    # ── fault injection ──
    @property
    def fail_mode(self):
        return next(iter(self.fail), "")

    @fail_mode.setter
    def fail_mode(self, value):
        self.fail = {value} if value else set()
        self.once = {value} if value else set()

    def _fires(self, mode: str) -> bool:
        if mode not in self.fail:
            return False
        if mode in self.once:
            self.fail.discard(mode)
        return True

    # ── contract ──
    def capabilities(self) -> ProviderCapabilities:
        return ProviderCapabilities(markets=(("GB", "VAT"),), void=True, link_reference=self.link, mode=self.mode)

    def determine(self, request: EngineRequest) -> LineResult:
        if self._fires("determine_error"):
            raise ProviderError(f"simulated outage (credential {self.secret[:3]}…)")
        components = [ComponentResult(component_code=f"FAKE:{a.jurisdiction_id}:{a.tax_type_id}", rate_percent=self.rate,
                                      rate_source="PROVIDER", jurisdiction_id=a.jurisdiction_id,
                                      tax_type_id=a.tax_type_id, activation_id=a.id)
                      for a in request.activations]
        result = LineResult(outcome=TaxOutcome.STANDARD, explanation_code="PROVIDER_STANDARD", components=components,
                            legal_reason="Fake provider determination.", provider_tax_date=request.tax_date,
                            provider_currency=request.currency)
        return self.result_hook(request, result) if self.result_hook else result

    def commit(self, *, idempotency_key: str, payload: dict, quote_ref: str = None) -> str:
        self.commit_calls += 1
        unexpected = set(payload) - ALLOWED_COMMIT_FIELDS
        if unexpected:
            raise ProviderRefused(f"unexpected payload fields {sorted(unexpected)}")
        if self._fires("commit_error"):
            raise ProviderRefused("simulated refusal")
        if self._fires("rate_limited"):
            raise ProviderRateLimited("simulated throttling", retry_after_seconds=30)
        if self._fires("timeout_before_success"):
            raise ProviderTimeout("simulated timeout; nothing committed")
        if self._fires("server_error"):
            raise ProviderAmbiguous("simulated 503 after the request was sent")
        entry = self.ledger.get(idempotency_key)
        if entry is None:
            entry = {"id": f"fake-{len(self.ledger) + 1}", "state": RemoteTransactionState.COMMITTED,
                     "payload": payload}
            self.ledger[idempotency_key] = entry
            self.payloads.append(payload)
        if self._fires("timeout_after_success"):
            raise ProviderTimeout("simulated timeout after the provider committed")
        if self._fires("ambiguous_after_success"):
            raise ProviderAmbiguous("simulated connection reset after the provider committed")
        return entry["id"]

    def transaction_state(self, *, idempotency_key: str) -> ProviderTransaction:
        if self._fires("state_error"):
            raise ProviderError("simulated state lookup failure")
        entry = self.ledger.get(idempotency_key)
        if entry is None:
            return ProviderTransaction(state=RemoteTransactionState.NOT_FOUND)
        payload = entry["payload"]
        components: dict = {}
        for line in payload.get("lines", []):
            for comp in line.get("components", []):
                components[comp["component_code"]] = components.get(comp["component_code"], Decimal("0")) \
                    + Decimal(comp["tax_amount"])
        return ProviderTransaction(
            state=entry["state"], transaction_id=entry["id"], currency=payload.get("currency"),
            tax_date=date.fromisoformat(payload["tax_date"]) if payload.get("tax_date") else None,
            total_tax=Decimal(payload["totals"]["tax"]) + self.remote_tax_delta,
            total_amount=Decimal(payload["totals"]["total"]) + self.remote_tax_delta, components=components,
        )

    def void(self, *, transaction_id: str, idempotency_key: str, reason: str) -> None:
        if self._fires("void_error"):
            raise ProviderError("simulated void failure")
        for entry in self.ledger.values():
            if entry["id"] == transaction_id:
                entry["state"] = RemoteTransactionState.VOIDED
                self.void_calls += 1
                return
        raise ProviderError(f"unknown transaction {transaction_id}")

    def link_reference(self, *, transaction_id: str, document_reference: str) -> None:
        if not self.link:
            raise ProviderError("linking not supported")
        self.links[transaction_id] = document_reference

    # test helpers
    def committed_keys(self) -> list:
        return [k for k, e in self.ledger.items() if e["state"] == RemoteTransactionState.COMMITTED]
