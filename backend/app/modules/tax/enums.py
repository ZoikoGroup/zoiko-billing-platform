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


# ── Global Tax Reference Registry (Phase 1, §06-§07, §10) ────────────────
# Platform-level reference vocabulary. None of these values ever appear on
# tenant-private rows; registry tables carry no organization_id (§12.1).

class JurisdictionLevel(str, enum.Enum):
    SUPRANATIONAL  = "supranational"   # e.g. EU: harmonising law, not a rate-setting authority
    COUNTRY        = "country"
    STATE_PROVINCE = "state_province"
    COUNTY         = "county"
    CITY           = "city"
    DISTRICT       = "district"
    SPECIAL_ZONE   = "special_zone"


class ComponentCombination(str, enum.Enum):
    """How a component combines with others in the same jurisdiction chain."""
    ADDITIVE       = "additive"        # computed on the same base, summed
    COMPOUND       = "compound"        # computed on base + prior components
    INTERDEPENDENT = "interdependent"  # requires a rule pack; never auto-combined


class TaxableBaseRule(str, enum.Enum):
    NET_AMOUNT                = "net_amount"
    NET_PLUS_PRIOR_COMPONENTS = "net_plus_prior_components"
    RULE_PACK_DEFINED         = "rule_pack_defined"


class SourceTier(str, enum.Enum):
    """Ranked source hierarchy (§06.1). SECONDARY_COMMENTARY is a research
    signal only and can never back a published rate on its own."""
    PRIMARY_LEGAL_INSTRUMENT = "primary_legal_instrument"
    OFFICIAL_DATASET         = "official_dataset"
    OFFICIAL_GUIDANCE        = "official_guidance"
    LICENSED_PROVIDER        = "licensed_provider"
    SECONDARY_COMMENTARY     = "secondary_commentary"


class AcquisitionMethod(str, enum.Enum):
    """Approved acquisition methods (§06.2). Crawling is not authorized by
    default and AI is a change detector, not an acquisition method, so
    neither is representable here."""
    OFFICIAL_API               = "official_api"
    OFFICIAL_PUBLICATION       = "official_publication"
    MANUAL_VERIFIED_EXTRACTION = "manual_verified_extraction"
    COMMERCIAL_FEED            = "commercial_feed"


class RedistributionPermission(str, enum.Enum):
    UNKNOWN    = "unknown"
    PERMITTED  = "permitted"
    RESTRICTED = "restricted"
    DENIED     = "denied"


class EvidenceStatus(str, enum.Enum):
    NOT_CAPTURED = "not_captured"
    CAPTURED     = "captured"


class RateKind(str, enum.Enum):
    STANDARD      = "standard"
    REDUCED       = "reduced"
    SUPER_REDUCED = "super_reduced"
    PARKING       = "parking"
    ZERO_RATED    = "zero_rated"


class StagingOrigin(str, enum.Enum):
    """Who/what proposed a staged change (the §07 ChangeApproval 'detector')."""
    SEED          = "seed"
    MANUAL        = "manual"
    OFFICIAL_FEED = "official_feed"
    LICENSED_FEED = "licensed_feed"
    AI_PROPOSAL   = "ai_proposal"


class StagedRateStatus(str, enum.Enum):
    """Staging pipeline (§10.1): nothing here is visible on reference reads.

    PENDING_REVIEW -> VALIDATED -> IN_APPROVAL -> APPROVED -> PUBLISHED
    Exits: VALIDATION_FAILED, CONFLICT_ESCALATED (T11), REJECTED.
    """
    PENDING_REVIEW     = "pending_review"
    VALIDATION_FAILED  = "validation_failed"
    CONFLICT_ESCALATED = "conflict_escalated"
    VALIDATED          = "validated"
    IN_APPROVAL        = "in_approval"
    APPROVED           = "approved"
    REJECTED           = "rejected"
    PUBLISHED          = "published"


#: Staged rows a reviewer may still amend.
AMENDABLE_STAGED_STATUSES = frozenset({
    StagedRateStatus.PENDING_REVIEW,
    StagedRateStatus.VALIDATION_FAILED,
    StagedRateStatus.CONFLICT_ESCALATED,
    StagedRateStatus.VALIDATED,
})

#: Staged rows that still compete for a rate key (used for conflict checks).
OPEN_STAGED_STATUSES = AMENDABLE_STAGED_STATUSES | {StagedRateStatus.IN_APPROVAL, StagedRateStatus.APPROVED}


class RateVersionStatus(str, enum.Enum):
    """Published rate versions only ever move ACTIVE -> SUPERSEDED. Any
    other change is a new version (T04)."""
    ACTIVE     = "active"
    SUPERSEDED = "superseded"


class ChangeKind(str, enum.Enum):
    NEW         = "new"
    SUPERSEDING = "superseding"   # correction / retroactive notice / end-dating
