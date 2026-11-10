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


# ── Phase 2: policy, activation and tax context (§05, §07, §08.1, §13.2) ─

class TransactionClass(str, enum.Enum):
    """Routing categories for activation and availability. NOT a legal
    characterization of a supply: that belongs to rule packs (Phase 3+).
    B2B vs B2C is derived from buyer evidence (a verified tax ID), never
    from a tenant flag alone; extensible."""
    B2B_SERVICES = "b2b_services"
    B2C_SERVICES = "b2c_services"
    B2B_DIGITAL  = "b2b_digital"
    B2C_DIGITAL  = "b2c_digital"
    B2B_GOODS    = "b2b_goods"
    B2C_GOODS    = "b2c_goods"


class SupplyCategory(str, enum.Enum):
    """What a platform tax code classifies (combined with buyer status to
    pick a TransactionClass)."""
    SERVICES = "services"
    DIGITAL  = "digital"
    GOODS    = "goods"


def transaction_class_for(is_business_buyer: bool, category: SupplyCategory) -> TransactionClass:
    prefix = "B2B" if is_business_buyer else "B2C"
    return TransactionClass[f"{prefix}_{category.name}"]


class MarketGate(str, enum.Enum):
    """The seven market launch gates of §13.2 — all must pass before a
    market is made available in a calculating mode."""
    LEGAL_AUTHORITY_AND_USAGE_RIGHTS   = "legal_authority_and_usage_rights"
    SOURCE_PROVENANCE_AND_FRESHNESS    = "source_provenance_and_freshness"
    RESOLUTION_AND_DETERMINATION_TESTS = "resolution_and_determination_tests"
    GOLDEN_TESTS_SIGNED_OFF            = "golden_tests_signed_off"
    PROVIDER_CONTRACTS_AND_RECOVERY    = "provider_contracts_and_recovery"
    UI_AND_AUDIT_EVIDENCE              = "ui_and_audit_evidence"
    AVAILABILITY_REGISTRY_UPDATED      = "availability_registry_updated"


class GateStatus(str, enum.Enum):
    NOT_STARTED    = "not_started"
    PASSED         = "passed"
    FAILED         = "failed"
    NOT_APPLICABLE = "not_applicable"   # e.g. provider gate for a native rule pack; needs a note


#: Modes the platform may make available for a market. TENANT_CONFIG_APPROVED
#: is never a platform mode: it is tenant-selected, and only where the active
#: availability version sets tenant_config_permitted.
PLATFORM_AVAILABILITY_MODES = frozenset({
    TaxOperatingMode.NATIVE_RULEPACK_APPROVED,
    TaxOperatingMode.PROVIDER_APPROVED,
    TaxOperatingMode.REFERENCE_ONLY,
    TaxOperatingMode.UNSUPPORTED,
    TaxOperatingMode.SUSPENDED,
})

#: Modes a tenant may activate (they all calculate).
TENANT_ACTIVATION_MODES = CALCULATING_MODES


class PlatformVersionStatus(str, enum.Enum):
    """Lifecycle of versioned platform policy records (market availability,
    tax-code sets). Content is frozen from IN_APPROVAL onward."""
    PENDING_REVIEW    = "pending_review"
    VALIDATION_FAILED = "validation_failed"
    VALIDATED         = "validated"
    IN_APPROVAL       = "in_approval"
    APPROVED          = "approved"
    ACTIVE            = "active"
    SUPERSEDED        = "superseded"
    REJECTED          = "rejected"


EDITABLE_PLATFORM_STATUSES = frozenset({
    PlatformVersionStatus.PENDING_REVIEW, PlatformVersionStatus.VALIDATION_FAILED, PlatformVersionStatus.VALIDATED,
})


class TenantApprovalStatus(str, enum.Enum):
    """Tenant maker-checker lifecycle (activations, legal bases, product
    classifications). APPROVED is the live version; changes are new rows."""
    PROPOSED   = "proposed"
    APPROVED   = "approved"
    REJECTED   = "rejected"
    SUPERSEDED = "superseded"
    WITHDRAWN  = "withdrawn"


class RegistrationStatus(str, enum.Enum):
    ACTIVE        = "active"
    PENDING       = "pending"
    SUSPENDED     = "suspended"
    DEREGISTERED  = "deregistered"


class VerificationStatus(str, enum.Enum):
    UNVERIFIED = "unverified"
    VERIFIED   = "verified"
    INVALID    = "invalid"


class AddressRole(str, enum.Enum):
    BILLING          = "billing"
    SHIPPING         = "shipping"
    SERVICE_LOCATION = "service_location"     # Phase 4c: where a service is performed / used


class AddressConfidence(str, enum.Enum):
    VALIDATED = "validated"   # checked by an address validation service
    ENTERED   = "entered"     # structured fields entered by the tenant
    DERIVED   = "derived"     # derived from legacy free text (backfill)


class EvidenceSource(str, enum.Enum):
    TENANT_ENTERED = "tenant_entered"
    LEGACY_BACKFILL = "legacy_backfill"
    VERIFICATION_SERVICE = "verification_service"


class CertificateStatus(str, enum.Enum):
    ACTIVE     = "active"
    REVOKED    = "revoked"
    SUPERSEDED = "superseded"


class ReviewItemKind(str, enum.Enum):
    REGISTRATION_EXPIRING = "registration_expiring"
    REGISTRATION_EXPIRED  = "registration_expired"
    CERTIFICATE_EXPIRING  = "certificate_expiring"
    CERTIFICATE_EXPIRED   = "certificate_expired"
    TAX_ID_VERIFICATION_EXPIRED = "tax_id_verification_expired"
    PROVIDER_DRIFT        = "provider_drift"      # Phase 4a-1: provider record differs from our snapshot
    ADDRESS_RESOLUTION_STALE = "address_resolution_stale"   # Phase 4c: expired or superseded dataset
    CREDENTIAL_VERSIONS_NOT_DESTROYED = "credential_versions_not_destroyed"   # Phase 4d-0: revoke retry pending
    # Phase 7 PR 3: daily anomaly checks on issued invoices (never change one).
    TAX_SNAPSHOT_MISMATCH   = "tax_snapshot_mismatch"     # governed invoice differs from its committed quote
    CREDIT_EXCEEDS_ORIGINAL = "credit_exceeds_original"   # credit notes exceed the invoice total or its tax


class ReviewItemStatus(str, enum.Enum):
    OPEN     = "open"
    RESOLVED = "resolved"


class ContextIssueKind(str, enum.Enum):
    MISSING     = "missing"
    EXPIRED     = "expired"
    AMBIGUOUS   = "ambiguous"
    UNVERIFIED  = "unverified"
    NOT_PERMITTED = "not_permitted"   # e.g. no effective activation for the market


class TaxContextStatus(str, enum.Enum):
    """Whether a quote's stored tax context still matches current facts."""
    CURRENT = "current"
    STALE   = "stale"


# ── Phase 3a: governed determination (§08, §09) ──────────────────────────

class EngineKind(str, enum.Enum):
    """Which determination engine produced a quote line."""
    NATIVE_RULE_PACK = "native_rule_pack"
    PROVIDER         = "provider"
    TENANT_CONFIG    = "tenant_config"


class RoundingRule(str, enum.Enum):
    """Where tax is rounded to the currency's minor unit (the level; the
    RoundingMode says how). Declared by the engine (rule packs per
    jurisdiction; tenant-config follows the org's tax_rounding_method)."""
    PER_LINE     = "per_line"       # each line's component tax rounded, then summed
    PER_DOCUMENT = "per_document"   # component tax summed unrounded, rounded once, allocated to lines


class RoundingMode(str, enum.Enum):
    """How a value is rounded to the currency's minor unit (F4). Declared by
    the engine with its RoundingRule level; governed math has no default."""
    HALF_UP   = "half_up"     # ties away from zero
    HALF_EVEN = "half_even"   # ties to even (banker's rounding)
    HALF_DOWN = "half_down"   # ties toward zero
    UP        = "up"          # always away from zero
    DOWN      = "down"        # always toward zero (truncate)

    @property
    def decimal_rounding(self) -> str:
        import decimal

        return {
            RoundingMode.HALF_UP: decimal.ROUND_HALF_UP, RoundingMode.HALF_EVEN: decimal.ROUND_HALF_EVEN,
            RoundingMode.HALF_DOWN: decimal.ROUND_HALF_DOWN, RoundingMode.UP: decimal.ROUND_UP,
            RoundingMode.DOWN: decimal.ROUND_DOWN,
        }[self]


class RemoteCommitState(str, enum.Enum):
    """State of a provider-side commit (Phase 4 outbox/saga seam). Native and
    tenant-config engines commit locally only (NOT_APPLICABLE)."""
    NOT_APPLICABLE = "not_applicable"
    PENDING        = "pending"
    UNCERTAIN      = "uncertain"      # timed out: reconcile remote state before any retry (T10)
    COMMITTED      = "committed"
    VOIDED         = "voided"


# ── Phase 4a-1: provider issuance outbox (§09.3) ─────────────────────────

class OutboxOperation(str, enum.Enum):
    COMMIT = "commit"
    VOID   = "void"
    LINK   = "link"       # attach our invoice number after commit (KEY_ONLY)
    EMAIL  = "email"      # deliver a send-by-email intent once the invoice is SENT
    ADJUST = "adjust"     # credit note / refund adjusting the original provider transaction (T15/T18)


class OutboxState(str, enum.Enum):
    """Provider issuance state machine. PENDING -> REMOTE_COMMITTED -> DONE is
    the happy path; UNCERTAIN means a timeout whose outcome must be looked up
    before anything else (T10)."""
    PENDING          = "pending"
    UNCERTAIN        = "uncertain"
    REMOTE_COMMITTED = "remote_committed"
    DONE             = "done"
    FAILED           = "failed"           # provider refused: nothing committed remotely
    VOIDED           = "voided"           # committed remotely, then voided by reference
    CANCELLED        = "cancelled"        # never committed and now past quote expiry or grace: re-quote
    REVIEW_REQUIRED  = "review_required"  # needs a person (drift, unresolved state, void not possible, ...)


#: States in which the invoice is locked and the row still has work to do.
ACTIVE_OUTBOX_STATES = frozenset({OutboxState.PENDING, OutboxState.UNCERTAIN, OutboxState.REMOTE_COMMITTED})
#: Final states: the row never changes again (apart from post-commit
#: verification fields, see provider_models.TERMINAL_MUTABLE_FIELDS).
TERMINAL_OUTBOX_STATES = frozenset({OutboxState.DONE, OutboxState.FAILED, OutboxState.VOIDED, OutboxState.CANCELLED})
#: States in which a COMMIT row keeps the invoice locked (a person may still
#: need to settle what the provider holds).
LOCKING_OUTBOX_STATES = ACTIVE_OUTBOX_STATES | {OutboxState.REVIEW_REQUIRED}


class OutboxReviewKind(str, enum.Enum):
    """Why a row needs a person."""
    UNRESOLVED_COMMIT = "unresolved_commit"   # outcome unknown past the grace deadline; still polled
    DRIFT             = "drift"               # provider record differs from our quote
    ROW_ERROR         = "row_error"           # unexpected error processing this row (poison row)
    VOID_FAILED       = "void_failed"         # compensation could not void by reference
    PROVIDER_VOIDED   = "provider_voided"     # the provider shows a void we never asked for
    EMAIL_UNCERTAIN   = "email_uncertain"     # an email attempt was interrupted: never resent automatically


class ProviderEnvironment(str, enum.Enum):
    SANDBOX    = "sandbox"
    PRODUCTION = "production"


class ConnectionStatus(str, enum.Enum):
    """A tenant's provider connection (Phase 4a-2). Proposed by a billing
    admin, approved by a different finance approver; SUSPENDED freezes it
    (credentials revoked, T16) until it is resumed by two people again."""
    PROPOSED  = "proposed"
    APPROVED  = "approved"
    REJECTED  = "rejected"
    WITHDRAWN = "withdrawn"
    SUSPENDED = "suspended"


class PlaceOfSupplyRole(str, enum.Enum):
    """Which buyer address a quote was determined with."""
    SHIP_TO          = "ship_to"
    SERVICE_LOCATION = "service_location"
    BILLING_FALLBACK = "billing_fallback"


class CircuitState(str, enum.Enum):
    CLOSED    = "closed"
    OPEN      = "open"         # too many failures: PROVIDER_UNAVAILABLE until the cool-down ends
    SUSPENDED = "suspended"    # frozen by a person (contract ended, credentials revoked; T16)


class DocumentReferencePolicy(str, enum.Enum):
    """What identifies our invoice at the provider (tax lead decides)."""
    KEY_ONLY       = "key_only"         # send our key; link the invoice number after commit
    INVOICE_NUMBER = "invoice_number"   # send the reserved invoice number as the document code


#: Quote statuses that can still be validated and committed at issuance.
COMMITTABLE_QUOTE_STATUSES = frozenset({TaxQuoteStatus.QUOTED, TaxQuoteStatus.VALIDATED})

#: Statuses a quote ends in when determination is refused.
REFUSED_QUOTE_STATUSES = frozenset({
    TaxQuoteStatus.NEEDS_EVIDENCE, TaxQuoteStatus.UNSUPPORTED, TaxQuoteStatus.REVIEW_REQUIRED,
    TaxQuoteStatus.PROVIDER_UNAVAILABLE,
})
