"""
app/modules/tax/engines.py
--------------------------
Determination engines (ZB-TAX-ARCH-001 Phase 3a, §08.1 step 4-5, §09.2-9.3).

An engine decides, per line, the legal outcome and which tax components
apply at which rates. It does NOT do money arithmetic: the determination
service applies rates to taxable bases with one shared, audited money path
(discount allocation, inclusive extraction, rounding), so every engine
reconciles the same way.

Engine kinds:
  * TenantConfigEngine — the tenant's own approved rate (TENANT_CONFIG_APPROVED),
    always labelled "tenant-configured, not verified by Zoiko".
  * RulePackEngine     — a native rule pack: code registered in RULE_PACKS AND an
    ACTIVE tax_rule_pack_versions row. Phase 3b registers the UK and Australia
    packs (app.modules.tax.rule_packs); they stay unusable until published.
    Test-only packs live under tests/ and are injected through the resolver —
    never registered here.
  * ProviderEngine     — wraps a ProviderAdapter (PROVIDER_APPROVED). PROVIDERS is
    empty in Phase 3a; tests inject a fake adapter.

Every engine declares the context facts it requires (required_facts):
only issues on those facts block a quote; the rest are warnings.
"""
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import Callable, Optional

from app.modules.tax.enums import (
    EngineKind,
    RemoteCommitState,
    RoundingMode,
    RoundingRule,
    SupplyCategory,
    TaxOperatingMode,
    TaxOutcome,
    TransactionClass,
)
from app.modules.tax.tenant_tax_service import TENANT_CONFIG_LABEL

#: Context facts every governed quote needs to route a line to an engine at all.
ROUTING_FACTS = frozenset({
    "TAX_DATE_MISSING", "CURRENCY_MISSING", "SELLER_ENTITY_MISSING", "SELLER_ENTITY_INACTIVE", "NO_LINES",
    "LINE_PRODUCT_MISSING", "PRODUCT_CLASSIFICATION_MISSING", "CUSTOMER_MISSING", "BUYER_COUNTRY_MISSING",
    "JURISDICTION_NOT_IN_REGISTRY", "PRICING_MODE_MIXED",
})

#: Context codes about activations: the determination service re-resolves
#: activations per line itself, so these are reported as warnings only.
ACTIVATION_FACTS = frozenset({"NO_ACTIVATION", "NO_EFFECTIVE_ACTIVATION", "ACTIVATION_NOT_EFFECTIVE"})


@dataclass(frozen=True)
class LineInput:
    line_id: int
    line_number: int
    product_id: Optional[int]
    tax_code: Optional[str]
    supply_category: Optional[SupplyCategory]
    registry_product_scope: Optional[str]
    transaction_class: Optional[TransactionClass]
    is_tax_inclusive: bool


@dataclass
class ComponentResult:
    component_code: str
    rate_percent: Decimal
    rate_source: str                       # REGISTRY | TENANT_CONFIG | PROVIDER
    label: Optional[str] = None
    jurisdiction_id: Optional[int] = None
    tax_type_id: Optional[int] = None
    rate_version_id: Optional[int] = None
    activation_id: Optional[int] = None
    reporting_code: Optional[str] = None
    is_reverse_charge: bool = False


@dataclass
class LineResult:
    outcome: TaxOutcome
    explanation_code: str
    components: list = field(default_factory=list)
    legal_reason: Optional[str] = None

    @classmethod
    def not_determined(cls, code: str, reason: str) -> "LineResult":
        return cls(outcome=TaxOutcome.NOT_DETERMINED, explanation_code=code, legal_reason=reason)


@dataclass
class EngineRequest:
    """What an engine may look at for one line. Facts come from the Phase 2
    context builder; activations are the ones in effect for this line."""
    db: object
    tax_date: date
    currency: str
    facts: dict
    line: LineInput
    activations: list
    business_buyer: Optional[bool]          # True / False (consumer treatment) / None (unresolved)


class TaxEngine(ABC):
    kind: EngineKind
    name: str
    version: str
    rounding_rule: RoundingRule = RoundingRule.PER_LINE
    #: Must be declared (F4): an engine without a rounding mode cannot quote.
    rounding_mode: Optional[RoundingMode] = None
    required_facts: frozenset = ROUTING_FACTS
    #: Whether the engine's legal rules treat a buyer without business
    #: evidence as a consumer (charging tax). Engines that don't declare it
    #: refuse lines whose buyer status is unresolved (T08: never 0% by default).
    unresolved_buyer_as_consumer: bool = False
    is_remote: bool = False

    @property
    def identity(self) -> tuple:
        return (self.kind, self.name, self.version, self.rounding_rule, self.rounding_mode)

    @abstractmethod
    def determine(self, request: EngineRequest) -> LineResult:
        ...


# ── Tenant-configured rates ─────────────────────────────────────────────

#: The tenant-config engine's declared rounding mode: the same as the org's
#: own billing arithmetic (legacy money rounding), so governed and legacy figures for a
#: tenant-configured rate agree. A declaration, recorded on every quote.
TENANT_CONFIG_ROUNDING_MODE = RoundingMode.HALF_UP


class TenantConfigEngine(TaxEngine):
    kind = EngineKind.TENANT_CONFIG
    name = "tenant-config"
    version = "1"

    def __init__(self, rounding_rule: RoundingRule = RoundingRule.PER_LINE,
                 rounding_mode: RoundingMode = TENANT_CONFIG_ROUNDING_MODE):
        self.rounding_rule = rounding_rule
        self.rounding_mode = rounding_mode

    def determine(self, request: EngineRequest) -> LineResult:
        components = []
        for activation in request.activations:
            rate = activation.tenant_rate_percent
            if rate is None or Decimal(rate) <= 0:
                return LineResult.not_determined(
                    "TENANT_RATE_NOT_POSITIVE",
                    "A tenant-configured rate must be positive; zero-rating or exemption needs a rule pack "
                    "or provider with a recorded legal reason.",
                )
            components.append(ComponentResult(
                component_code=f"TENANT-CONFIG:{activation.id}", rate_percent=Decimal(rate),
                rate_source="TENANT_CONFIG", label=TENANT_CONFIG_LABEL, jurisdiction_id=activation.jurisdiction_id,
                tax_type_id=activation.tax_type_id, activation_id=activation.id,
            ))
        if not components:
            return LineResult.not_determined("NO_EFFECTIVE_ACTIVATION", "No tenant-configured activation applies.")
        citation = "; ".join(sorted({a.tenant_source_citation for a in request.activations if a.tenant_source_citation}))
        return LineResult(outcome=TaxOutcome.STANDARD, explanation_code="TENANT_CONFIGURED_RATE",
                          components=components, legal_reason=f"{TENANT_CONFIG_LABEL}: {citation}")


# ── Native rule packs ───────────────────────────────────────────────────

class RulePack(ABC):
    """Code for one native rule pack version. Registering it in RULE_PACKS is
    necessary but not sufficient: the matching tax_rule_pack_versions row must
    be ACTIVE (maker-checker approved, golden tests signed off)."""
    code: str
    version: str
    rounding_rule: RoundingRule = RoundingRule.PER_LINE
    #: Required declaration (F4); a pack that leaves it None cannot quote.
    rounding_mode: Optional[RoundingMode] = None
    required_facts: frozenset = ROUTING_FACTS
    unresolved_buyer_as_consumer: bool = False

    @abstractmethod
    def determine(self, request: EngineRequest) -> LineResult:
        ...


class RulePackEngine(TaxEngine):
    kind = EngineKind.NATIVE_RULE_PACK

    def __init__(self, pack: RulePack):
        self.pack = pack
        self.name = pack.code
        self.version = pack.version
        self.rounding_rule = pack.rounding_rule
        self.rounding_mode = pack.rounding_mode
        self.required_facts = pack.required_facts
        self.unresolved_buyer_as_consumer = pack.unresolved_buyer_as_consumer

    def determine(self, request: EngineRequest) -> LineResult:
        return self.pack.determine(request)


#: code -> RulePack class, filled by app.modules.tax.rule_packs (native packs
#: only; see registered_rule_packs()).
RULE_PACKS: dict = {}


def registered_rule_packs() -> dict:
    """RULE_PACKS with the native packs loaded."""
    import app.modules.tax.rule_packs  # noqa: F401  (registers the packs)

    return RULE_PACKS


# ── Providers (interface + seam; no real provider in 3a) ─────────────────

class ProviderError(Exception):
    pass


class ProviderTimeout(ProviderError):
    """The provider may or may not have acted: reconcile before retrying (T10)."""


class ProviderAdapter(ABC):
    """A licensed external determination service (§09.3). Estimates are
    non-binding; commit is the legally binding step and is idempotent on the
    key the caller supplies."""
    name: str
    version: str = "1"
    rounding_rule: RoundingRule = RoundingRule.PER_LINE
    rounding_mode: Optional[RoundingMode] = None
    required_facts: frozenset = ROUTING_FACTS
    unresolved_buyer_as_consumer: bool = False

    @abstractmethod
    def determine(self, request: EngineRequest) -> LineResult:
        ...

    @abstractmethod
    def commit(self, *, quote_ref: str, idempotency_key: str, payload: dict) -> str:
        """Commit remotely; return the provider correlation id. May raise
        ProviderTimeout (outcome unknown) or ProviderError (not committed)."""

    @abstractmethod
    def remote_state(self, *, quote_ref: str, idempotency_key: str) -> RemoteCommitState:
        """COMMITTED if the provider holds a committed transaction for this key."""


class ProviderEngine(TaxEngine):
    kind = EngineKind.PROVIDER
    is_remote = True

    def __init__(self, adapter: ProviderAdapter):
        self.adapter = adapter
        self.name = adapter.name
        self.version = adapter.version
        self.rounding_rule = adapter.rounding_rule
        self.rounding_mode = adapter.rounding_mode
        self.required_facts = adapter.required_facts
        self.unresolved_buyer_as_consumer = adapter.unresolved_buyer_as_consumer

    def determine(self, request: EngineRequest) -> LineResult:
        return self.adapter.determine(request)


#: name -> ProviderAdapter instance. Empty in Phase 3a (no provider contract yet).
PROVIDERS: dict = {}


# ── Resolution ──────────────────────────────────────────────────────────

class EngineResolver:
    """Maps an effective activation to its engine. The lookups are
    injectable so tests can supply a test-only pack or fake provider without
    registering either in the application."""

    def __init__(self, db, *, rule_pack_lookup: Optional[Callable] = None,
                 provider_lookup: Optional[Callable] = None,
                 tenant_rounding: RoundingRule = RoundingRule.PER_LINE):
        self.db = db
        self.rule_pack_lookup = rule_pack_lookup or self._registered_rule_pack
        self.provider_lookup = provider_lookup or (lambda activation: None)
        self.tenant_rounding = tenant_rounding

    def _registered_rule_pack(self, activation) -> Optional[RulePack]:
        from app.modules.tax.enums import PlatformVersionStatus
        from app.modules.tax.policy_models import TaxRulePackVersion

        jurisdiction = activation.jurisdiction.code if activation.jurisdiction else None
        tax_type = activation.tax_type.code if activation.tax_type else None
        for row in self.db.query(TaxRulePackVersion).filter(TaxRulePackVersion.status == PlatformVersionStatus.ACTIVE):
            pack_cls = registered_rule_packs().get(row.code)
            if pack_cls is None or getattr(pack_cls, "version", None) != row.version:
                continue
            # The published declaration must still match the code (no drift).
            declared_mode = pack_cls.rounding_mode.name if pack_cls.rounding_mode else None
            if (row.rounding_rule, row.rounding_mode) != (pack_cls.rounding_rule.name, declared_mode):
                continue
            if any(m.get("jurisdiction_code") == jurisdiction and m.get("tax_type") == tax_type for m in row.markets or []):
                return pack_cls()
        return None

    def engine_for(self, activation) -> tuple:
        """(engine or None, reason when None)."""
        if activation.mode == TaxOperatingMode.TENANT_CONFIG_APPROVED:
            return TenantConfigEngine(self.tenant_rounding), None
        if activation.mode == TaxOperatingMode.NATIVE_RULEPACK_APPROVED:
            pack = self.rule_pack_lookup(activation)
            if pack is None:
                return None, "No approved native rule pack covers this market."
            return RulePackEngine(pack), None
        if activation.mode == TaxOperatingMode.PROVIDER_APPROVED:
            adapter = self.provider_lookup(activation)
            if adapter is None:
                return None, "No tax provider is configured for this market."
            return ProviderEngine(adapter), None
        return None, f"{activation.mode.name} does not calculate tax."
