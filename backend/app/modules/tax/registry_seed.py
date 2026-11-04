"""
app/modules/tax/registry_seed.py
--------------------------------
REFERENCE_ONLY seed data for the Global Tax Reference Registry
(ZB-TAX-ARCH-001 Phase 1): UK, Australia, Canada (federal + provincial) and
the EU member states.

Rules this seed follows:
  * Only sources cited in the handoff (§06.3, §17) are recorded. Each source
    revision is seeded with evidence NOT_CAPTURED: a reviewer must upload the
    captured artifact (the server hashes it) before any approval.
  * Every rate proposal lands in staging as PENDING_REVIEW. Nothing is
    approved or published here; that needs human tax sign-off.
  * A rate_percent is recorded only where the cited page itself states it.
    valid_from and owner are never filled from outside knowledge: validation
    fails until a reviewer supplies them from the legal instrument.
  * Authorities and timezones are left NULL where the handoff cites no
    source for them or a jurisdiction spans several zones (fail closed).
  * Provincial PST/QST: jurisdictions and components only, no rates, until
    the tax lead supplies official provincial sources.

Idempotent: rows are matched on their codes / external_ref and never
updated, so re-running after reviewers have worked on staging is safe.
"""
from decimal import Decimal
from typing import Optional

from sqlalchemy.orm import Session

from app.modules.tax.enums import (
    AcquisitionMethod,
    ComponentCombination,
    JurisdictionLevel,
    RateKind,
    SourceTier,
    StagingOrigin,
    TaxableBaseRule,
)
from app.modules.tax.registry_models import (
    TaxAuthority,
    TaxComponent,
    TaxJurisdiction,
    TaxLegalSourceRevision,
    TaxRateStaging,
    TaxTypeDefinition,
)
from app.modules.tax.registry_service import TaxRegistryPipeline

SEED_LABEL = "ZB-TAX-ARCH-001 Phase 1 reference seed"
SOURCES_CHECKED = "Automated check of the cited page on 2026-11-04 (not evidence capture)"

# (code, name, level, country, subdivision, parent_code, timezone, notes)
JURISDICTIONS = [
    ("EU", "European Union", JurisdictionLevel.SUPRANATIONAL, None, None, None, None,
     "Harmonising VAT law (Directive 2006/112/EC); rates are set by each Member State."),
    ("GB", "United Kingdom", JurisdictionLevel.COUNTRY, "GB", None, None, "Europe/London", None),
    ("AU", "Australia", JurisdictionLevel.COUNTRY, "AU", None, None, None,
     "Multiple timezones: reference lookups need an explicit as_of date."),
    ("CA", "Canada", JurisdictionLevel.COUNTRY, "CA", None, None, None,
     "Multiple timezones: reference lookups need an explicit as_of date."),
    ("CA-AB", "Alberta", JurisdictionLevel.STATE_PROVINCE, "CA", "AB", "CA", "America/Edmonton", None),
    ("CA-BC", "British Columbia", JurisdictionLevel.STATE_PROVINCE, "CA", "BC", "CA", None, "Spans more than one timezone."),
    ("CA-MB", "Manitoba", JurisdictionLevel.STATE_PROVINCE, "CA", "MB", "CA", "America/Winnipeg", None),
    ("CA-NB", "New Brunswick", JurisdictionLevel.STATE_PROVINCE, "CA", "NB", "CA", "America/Moncton", None),
    ("CA-NL", "Newfoundland and Labrador", JurisdictionLevel.STATE_PROVINCE, "CA", "NL", "CA", None, "Spans more than one timezone."),
    ("CA-NS", "Nova Scotia", JurisdictionLevel.STATE_PROVINCE, "CA", "NS", "CA", "America/Halifax", None),
    ("CA-NT", "Northwest Territories", JurisdictionLevel.STATE_PROVINCE, "CA", "NT", "CA", None, "Timezone to be confirmed."),
    ("CA-NU", "Nunavut", JurisdictionLevel.STATE_PROVINCE, "CA", "NU", "CA", None, "Spans more than one timezone."),
    ("CA-ON", "Ontario", JurisdictionLevel.STATE_PROVINCE, "CA", "ON", "CA", None, "Spans more than one timezone."),
    ("CA-PE", "Prince Edward Island", JurisdictionLevel.STATE_PROVINCE, "CA", "PE", "CA", "America/Halifax", None),
    ("CA-QC", "Quebec", JurisdictionLevel.STATE_PROVINCE, "CA", "QC", "CA", None, "Spans more than one timezone."),
    ("CA-SK", "Saskatchewan", JurisdictionLevel.STATE_PROVINCE, "CA", "SK", "CA", None, "Timezone to be confirmed."),
    ("CA-YT", "Yukon", JurisdictionLevel.STATE_PROVINCE, "CA", "YT", "CA", "America/Whitehorse", None),
]

# EU Member States: (ISO code, name, timezone or None when the VAT territory spans zones)
EU_MEMBER_STATES = [
    ("AT", "Austria", "Europe/Vienna"), ("BE", "Belgium", "Europe/Brussels"), ("BG", "Bulgaria", "Europe/Sofia"),
    ("HR", "Croatia", "Europe/Zagreb"), ("CY", "Cyprus", "Asia/Nicosia"), ("CZ", "Czechia", "Europe/Prague"),
    ("DK", "Denmark", "Europe/Copenhagen"), ("EE", "Estonia", "Europe/Tallinn"), ("FI", "Finland", "Europe/Helsinki"),
    ("FR", "France", None), ("DE", "Germany", "Europe/Berlin"), ("GR", "Greece", "Europe/Athens"),
    ("HU", "Hungary", "Europe/Budapest"), ("IE", "Ireland", "Europe/Dublin"), ("IT", "Italy", "Europe/Rome"),
    ("LV", "Latvia", "Europe/Riga"), ("LT", "Lithuania", "Europe/Vilnius"), ("LU", "Luxembourg", "Europe/Luxembourg"),
    ("MT", "Malta", "Europe/Malta"), ("NL", "Netherlands", "Europe/Amsterdam"), ("PL", "Poland", "Europe/Warsaw"),
    ("PT", "Portugal", None), ("RO", "Romania", "Europe/Bucharest"), ("SK", "Slovakia", "Europe/Bratislava"),
    ("SI", "Slovenia", "Europe/Ljubljana"), ("ES", "Spain", "Europe/Madrid"), ("SE", "Sweden", "Europe/Stockholm"),
]
_EU_NOTES = {
    "FR": "VAT territory spans several timezones (overseas departments); explicit as_of required.",
    "PT": "VAT territory spans several timezones (Azores); regional rates need their own jurisdictions.",
    "ES": "Canary Islands are outside the EU VAT territory and need their own jurisdiction if modelled.",
}
for _code, _name, _tz in EU_MEMBER_STATES:
    JURISDICTIONS.append((_code, _name, JurisdictionLevel.COUNTRY, _code, None, "EU", _tz, _EU_NOTES.get(_code)))

# (code, name, jurisdiction_code)
AUTHORITIES = [
    ("GB-HMRC", "HM Revenue & Customs", "GB"),
    ("AU-ATO", "Australian Taxation Office", "AU"),
    ("CA-CRA", "Canada Revenue Agency", "CA"),
    ("EU-EC", "European Commission", "EU"),
]

TAX_TYPES = [
    ("VAT", "Value added tax"),
    ("GST", "Goods and services tax"),
    ("HST", "Harmonized sales tax"),
    ("PST", "Provincial sales tax"),
    ("QST", "Quebec sales tax"),
]

# (code, name, jurisdiction, tax type, authority code or None, combination, base rule, notes)
COMPONENTS = [
    ("GB-VAT", "UK VAT", "GB", "VAT", "GB-HMRC", ComponentCombination.ADDITIVE, TaxableBaseRule.NET_AMOUNT, None),
    ("AU-GST", "Australian GST", "AU", "GST", "AU-ATO", ComponentCombination.ADDITIVE, TaxableBaseRule.NET_AMOUNT, None),
    ("CA-GST", "Canadian GST", "CA", "GST", "CA-CRA", ComponentCombination.ADDITIVE, TaxableBaseRule.NET_AMOUNT,
     "Federal GST. In participating provinces HST applies instead; which one applies is a determination rule, not a registry fact."),
]
for _prov, _name in (("ON", "Ontario"), ("NB", "New Brunswick"), ("NL", "Newfoundland and Labrador"),
                     ("NS", "Nova Scotia"), ("PE", "Prince Edward Island")):
    COMPONENTS.append((f"CA-{_prov}-HST", f"{_name} HST", f"CA-{_prov}", "HST", "CA-CRA",
                       ComponentCombination.ADDITIVE, TaxableBaseRule.NET_AMOUNT, None))
_PROVINCIAL_PENDING = ("No rate seeded: awaiting an official provincial source from the tax lead. Authority, combination "
                       "and taxable base to be confirmed; INTERDEPENDENT/RULE_PACK_DEFINED keeps it out of any automatic combination.")
for _prov, _name, _type in (("BC", "British Columbia", "PST"), ("MB", "Manitoba", "PST"),
                            ("SK", "Saskatchewan", "PST"), ("QC", "Quebec", "QST")):
    COMPONENTS.append((f"CA-{_prov}-{_type}", f"{_name} {_type}", f"CA-{_prov}", _type, None,
                       ComponentCombination.INTERDEPENDENT, TaxableBaseRule.RULE_PACK_DEFINED, _PROVINCIAL_PENDING))
for _code, _name, _tz in EU_MEMBER_STATES:
    COMPONENTS.append((f"{_code}-VAT", f"{_name} VAT", _code, "VAT", None, ComponentCombination.ADDITIVE,
                       TaxableBaseRule.NET_AMOUNT, "Levying national tax administration not yet recorded from a cited source."))

# handoff ref -> source revision fields
SOURCES = {
    "S11": dict(
        authority="GB-HMRC", source_tier=SourceTier.OFFICIAL_GUIDANCE,
        permanent_url="https://www.gov.uk/guidance/vat-rates-on-different-goods-and-services",
        title="VAT rates on different goods and services",
        citation="HM Revenue & Customs, 'VAT rates on different goods and services', GOV.UK guidance "
                 "(last updated 10 July 2026). ZB-TAX-ARCH-001 source register [S11].",
        internal_notes=f"{SOURCES_CHECKED}: the page lists zero-rated, reduced-rate and exempt categories but does not "
                       "itself state the standard-rate figure; it links to https://www.gov.uk/vat-rates.",
    ),
    "S16": dict(
        authority="AU-ATO", source_tier=SourceTier.OFFICIAL_GUIDANCE,
        permanent_url="https://www.ato.gov.au/api/public/content/0-1e92db95-a75c-4f4e-a3d4-39f43b1a3b25",
        title="GST fundamentals",
        citation="Australian Taxation Office, 'GST fundamentals'. ZB-TAX-ARCH-001 source register [S16].",
        internal_notes=f"{SOURCES_CHECKED}: the URL refused automated retrieval (HTTP 403). Capture it manually; "
                       "the cited URL is an API endpoint, so confirm the public page it corresponds to.",
    ),
    "S12": dict(
        authority="CA-CRA", source_tier=SourceTier.OFFICIAL_GUIDANCE,
        permanent_url="https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/"
                      "charge-collect-which-rate.html",
        title="Charge and collect the GST/HST",
        citation="Canada Revenue Agency, 'Charge and collect the GST/HST' (page date 2026-04-08). "
                 "ZB-TAX-ARCH-001 source register [S12].",
        internal_notes=f"{SOURCES_CHECKED}: no province-by-province table in the page text. Rates appear only in "
                       "prose/examples: Ontario 13% HST; Nova Scotia 14% HST ('On April 1, 2025, ... resulting in an HST "
                       "rate of 14%'). The GST rate and the NB/NL/PE HST rates are not stated in the extracted text. "
                       "No QST rate. A Manitoba PST example exists but PST/QST await provincial sources.",
    ),
    "S9": dict(
        authority="EU-EC", source_tier=SourceTier.OFFICIAL_GUIDANCE,
        permanent_url="https://taxation-customs.ec.europa.eu/taxation/vat/vat-directive/vat-rates_en",
        title="VAT rates — Taxation and Customs Union",
        citation="European Commission, Taxation and Customs Union, 'VAT rates'. ZB-TAX-ARCH-001 source register [S9].",
        internal_notes=f"{SOURCES_CHECKED}: no Member State rate table; it states only the EU minimum standard rate "
                       "(not less than 15%, Art. 97 Directive 2006/112/EC) and refers to TEDB [S10] for national rates. "
                       "National legal publications control (§06.3).",
    ),
    "S10": dict(
        authority="EU-EC", source_tier=SourceTier.OFFICIAL_GUIDANCE,
        permanent_url="https://ec.europa.eu/taxation_customs/tedb/index.html",
        title="Taxes in Europe Database (TEDB)",
        citation="European Commission, 'Taxes in Europe Database' — information supplied by Member States; "
                 "the Commission states it is non-binding. ZB-TAX-ARCH-001 source register [S10].",
        internal_notes="Non-binding reference (§04, §06.3). Not yet checked by automation.",
    ),
}

# Standard-rate proposals: (component code, source ref, rate stated on that page or None)
STANDARD_RATE_PROPOSALS = [
    ("GB-VAT", "S11", None),
    ("AU-GST", "S16", None),
    ("CA-GST", "S12", None),
    ("CA-ON-HST", "S12", Decimal("13")),
    ("CA-NB-HST", "S12", None),
    ("CA-NL-HST", "S12", None),
    ("CA-NS-HST", "S12", Decimal("14")),
    ("CA-PE-HST", "S12", None),
] + [(f"{code}-VAT", "S9", None) for code, _name, _tz in EU_MEMBER_STATES]


def _by_code(db: Session, model, code: str):
    return db.query(model).filter(model.code == code).first()


def seed_registry(db: Session) -> dict:
    """Insert missing seed rows. Never updates or approves anything. The
    caller commits."""
    counts = {"jurisdictions": 0, "authorities": 0, "tax_types": 0, "components": 0,
              "source_revisions": 0, "staged_rates": 0}

    for code, name, level, country, subdivision, parent_code, tz, notes in JURISDICTIONS:
        if _by_code(db, TaxJurisdiction, code):
            continue
        parent = _by_code(db, TaxJurisdiction, parent_code) if parent_code else None
        db.add(TaxJurisdiction(code=code, name=name, level=level, country_code=country, subdivision_code=subdivision,
                               parent_id=parent.id if parent else None, timezone=tz, notes=notes))
        db.flush()
        counts["jurisdictions"] += 1

    for code, name, jurisdiction_code in AUTHORITIES:
        if _by_code(db, TaxAuthority, code):
            continue
        db.add(TaxAuthority(code=code, name=name, jurisdiction_id=_by_code(db, TaxJurisdiction, jurisdiction_code).id))
        counts["authorities"] += 1

    for code, name in TAX_TYPES:
        if _by_code(db, TaxTypeDefinition, code):
            continue
        db.add(TaxTypeDefinition(code=code, name=name))
        counts["tax_types"] += 1
    db.flush()

    for code, name, jurisdiction_code, type_code, authority_code, combination, base_rule, notes in COMPONENTS:
        if _by_code(db, TaxComponent, code):
            continue
        authority = _by_code(db, TaxAuthority, authority_code) if authority_code else None
        db.add(TaxComponent(
            code=code, name=name, jurisdiction_id=_by_code(db, TaxJurisdiction, jurisdiction_code).id,
            tax_type_id=_by_code(db, TaxTypeDefinition, type_code).id,
            authority_id=authority.id if authority else None, combination=combination,
            taxable_base_rule=base_rule, notes=notes,
        ))
        counts["components"] += 1
    db.flush()

    pipeline = TaxRegistryPipeline(db)
    source_ids: dict[str, int] = {}
    for ref, fields in SOURCES.items():
        existing = db.query(TaxLegalSourceRevision).filter(
            TaxLegalSourceRevision.handoff_ref == ref,
            TaxLegalSourceRevision.permanent_url == fields["permanent_url"],
        ).order_by(TaxLegalSourceRevision.id).first()
        if existing is None:
            existing = pipeline.register_source_revision(
                actor_id=None, authority_id=_by_code(db, TaxAuthority, fields["authority"]).id,
                source_tier=fields["source_tier"], acquisition_method=AcquisitionMethod.MANUAL_VERIFIED_EXTRACTION,
                permanent_url=fields["permanent_url"], title=fields["title"], citation=fields["citation"],
                language="en", handoff_ref=ref, internal_notes=fields["internal_notes"],
            )
            counts["source_revisions"] += 1
        source_ids[ref] = existing.id

    for component_code, ref, stated_rate in STANDARD_RATE_PROPOSALS:
        external_ref = f"seed:{component_code}:STANDARD:GENERAL"
        exists = db.query(TaxRateStaging).filter(
            TaxRateStaging.origin == StagingOrigin.SEED, TaxRateStaging.external_ref == external_ref,
        ).first()
        if exists:
            continue
        pipeline.stage(
            actor_id=None, origin=StagingOrigin.SEED, component_id=_by_code(db, TaxComponent, component_code).id,
            tax_code="STANDARD", product_scope="GENERAL", rate_kind=RateKind.STANDARD, rate_percent=stated_rate,
            source_revision_id=source_ids[ref], external_ref=external_ref,
            raw_payload={"seed": SEED_LABEL, "handoff_ref": ref, "component": component_code,
                         "rate_percent_as_stated_on_source": str(stated_rate) if stated_rate is not None else None},
            reviewer_notes=_review_note(stated_rate),
        )
        counts["staged_rates"] += 1
    return counts


def _review_note(stated_rate: Optional[Decimal]) -> str:
    base = "Seeded PENDING_REVIEW. Reviewer: capture the source, supply valid_from from the legal instrument and an owner"
    if stated_rate is None:
        return base + ", and enter the rate from the official source (the cited page does not state it)."
    return base + ", and confirm the rate against the captured evidence."
