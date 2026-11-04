"""
Fake tax provider for ZB-TAX-ARCH-001 Phase 3a tests (T10). Never registered
in app.modules.tax.engines.PROVIDERS.

`fail_mode="timeout_after_success"` simulates the dangerous case: the provider
commits remotely but the response never arrives, so the caller sees a timeout.
A correct caller reconciles (remote_state) instead of committing again.
"""
from decimal import Decimal

from app.modules.tax.engines import ComponentResult, EngineRequest, LineResult, ProviderAdapter, ProviderTimeout
from app.modules.tax.enums import RemoteCommitState, RoundingMode, TaxOutcome


class FakeTaxProvider(ProviderAdapter):
    name = "fake-provider"
    version = "1-test"
    rounding_mode = RoundingMode.HALF_UP

    def __init__(self, rate: Decimal = Decimal("10"), fail_mode: str = ""):
        self.rate = rate
        self.fail_mode = fail_mode
        self.commit_calls = 0
        self.remote_committed: dict = {}            # idempotency_key -> correlation id

    def determine(self, request: EngineRequest) -> LineResult:
        components = [ComponentResult(component_code=f"FAKE:{a.jurisdiction_id}:{a.tax_type_id}", rate_percent=self.rate,
                                      rate_source="PROVIDER", jurisdiction_id=a.jurisdiction_id,
                                      tax_type_id=a.tax_type_id, activation_id=a.id)
                      for a in request.activations]
        return LineResult(outcome=TaxOutcome.STANDARD, explanation_code="PROVIDER_STANDARD", components=components,
                          legal_reason="Fake provider determination.")

    def commit(self, *, quote_ref: str, idempotency_key: str, payload: dict) -> str:
        self.commit_calls += 1
        correlation = self.remote_committed.setdefault(idempotency_key, f"fake-{len(self.remote_committed) + 1}")
        if self.fail_mode == "timeout_after_success":
            self.fail_mode = ""                    # only the first attempt times out
            raise ProviderTimeout("simulated timeout after the provider committed")
        return correlation

    def remote_state(self, *, quote_ref: str, idempotency_key: str) -> RemoteCommitState:
        return RemoteCommitState.COMMITTED if idempotency_key in self.remote_committed else RemoteCommitState.PENDING
