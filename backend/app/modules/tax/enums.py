"""
app/modules/tax/enums.py
------------------------
Canonical tax taxonomy for the Global Tax Intelligence & Determination
Framework (ZB-TAX-ARCH-001).

These enums are the shared vocabulary every later phase keys off (reference
registry, activation matrix, determination orchestrator, provider adapters,
Tax Control Center UI). They are deliberately defined once, here, so that
"what does NOT_DETERMINED mean" has exactly one answer in the codebase.

Core rule encoded here (§04, §08.2): UNKNOWN is never equivalent to any
legal outcome. ``TaxOutcome.NOT_DETERMINED`` is an error state, not a 0%
rate, and nothing in this module offers a conversion from it to one.
"""
import enum


class TaxOutcome(str, enum.Enum):
    """The explicit legal treatment of a taxed line (§08.2).

    Zero-rated, exempt, out-of-scope, reverse-charged and non-taxable are
    DISTINCT legal outcomes even though several produce a 0.00 tax amount.
    NOT_DETERMINED is the error state for "we could not establish the
    treatment" and must block issuance in governed mode.
    """
    STANDARD            = "standard"
    REDUCED             = "reduced"
    ZERO_RATED          = "zero_rated"
    EXEMPT              = "exempt"
    REVERSE_CHARGE      = "reverse_charge"
    OUT_OF_SCOPE        = "out_of_scope"
    NON_TAXABLE_BY_RULE = "non_taxable_by_rule"
    NOT_DETERMINED      = "not_determined"


#: Outcomes that legally result in no tax being charged to the buyer.
#: Every one of these requires a recorded legal reason / evidence on the
#: line (enforced in Phase 3); none of them may be inferred from a missing
#: rate.
ZERO_AMOUNT_OUTCOMES = frozenset({
    TaxOutcome.ZERO_RATED,
    TaxOutcome.EXEMPT,
    TaxOutcome.REVERSE_CHARGE,
    TaxOutcome.OUT_OF_SCOPE,
    TaxOutcome.NON_TAXABLE_BY_RULE,
})


def is_determined(outcome: "TaxOutcome") -> bool:
    """True for every legal outcome; False only for NOT_DETERMINED."""
    return outcome != TaxOutcome.NOT_DETERMINED


class TaxQuoteStatus(str, enum.Enum):
    """Tax quote lifecycle (§08.2).

    Happy path: DRAFT -> QUOTED -> VALIDATED -> COMMITTED.
    Everything else is an exception state that blocks issuance.
    """
    DRAFT                = "draft"
    QUOTED               = "quoted"
    VALIDATED            = "validated"
    COMMITTED            = "committed"
    NEEDS_EVIDENCE       = "needs_evidence"
    UNSUPPORTED          = "unsupported"
    STALE                = "stale"
    PROVIDER_UNAVAILABLE = "provider_unavailable"
    REVIEW_REQUIRED      = "review_required"
    EXPIRED              = "expired"
    VOIDED               = "voided"


ISSUABLE_QUOTE_STATUSES = frozenset({TaxQuoteStatus.VALIDATED, TaxQuoteStatus.COMMITTED})


class TaxOperatingMode(str, enum.Enum):
    """Per jurisdiction + tax type + transaction class + seller entity
    activation mode (§05). Reference availability and production
    calculation availability are DIFFERENT flags: only the *_APPROVED
    modes may calculate a tax-bearing production invoice.
    """
    REFERENCE_ONLY           = "reference_only"
    TENANT_CONFIG_APPROVED   = "tenant_config_approved"
    NATIVE_RULEPACK_APPROVED = "native_rulepack_approved"
    PROVIDER_APPROVED        = "provider_approved"
    UNSUPPORTED              = "unsupported"
    SUSPENDED                = "suspended"


CALCULATING_MODES = frozenset({
    TaxOperatingMode.TENANT_CONFIG_APPROVED,
    TaxOperatingMode.NATIVE_RULEPACK_APPROVED,
    TaxOperatingMode.PROVIDER_APPROVED,
})


class EntityTaxRegime(str, enum.Enum):
    """Which tax pipeline a seller legal entity's invoices go through.

    LEGACY_MANUAL: pre-framework behaviour (tenant-entered TaxRate rows and a
        per-line percentage). Kept so existing tenants are not suddenly
        blocked from invoicing; surfaced in the UI as "manual / unverified"
        and never presented as a governed determination.
    GOVERNED: the ZB-TAX-ARCH-001 fail-closed pipeline (activation matrix ->
        orchestrator -> quote -> immutable snapshot). Opt-in per entity once
        the entity's jurisdictions are activated.
    """
    LEGACY_MANUAL = "legacy_manual"
    GOVERNED      = "governed"
