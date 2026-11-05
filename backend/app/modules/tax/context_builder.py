"""
app/modules/tax/context_builder.py
----------------------------------
Tax Context Builder (ZB-TAX-ARCH-001 Phase 2, §08.1 steps 1-4, §09).

``build_tax_context`` assembles every fact a determination would need for a
draft invoice or quote — seller entity, registrations, activations and their
effective state, platform availability, buyer location, tax IDs, exemption
certificates, line classifications, dates, currency and pricing mode — and
returns an explicit list of missing, expired, ambiguous or unverified facts.

It is read-only: it never writes, never creates a customer master, and never
invents a default (an unknown tax date is reported, not replaced by today).
It decides nothing about taxability or place of supply; that is Phase 3.

``context_fingerprint`` is a SHA-256 over the canonical form of every fact
and version used. Phase 3 quotes store it; any mismatch at issue time means
the quote is STALE. Changing any single input changes the fingerprint.
"""
import hashlib
import json
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.core.exceptions import BadRequestException, NotFoundException
from app.modules.billing.models import BillingCustomer, Invoice, InvoiceItem, Quotation, QuotationItem
from app.modules.tax.classification_service import ClassificationService, current_classification_version
from app.modules.tax.enums import (
    AddressConfidence,
    AddressRole,
    CertificateStatus,
    ContextIssueKind,
    SupplyCategory,
    TenantApprovalStatus,
    VerificationStatus,
    transaction_class_for,
)
from app.modules.tax.models import (
    CustomerExemptionCertificate,
    CustomerTaxAddress,
    CustomerTaxId,
    EntityTaxActivation,
    EntityTaxRegistration,
    SellerLegalEntity,
)
from app.modules.tax.registry_models import TaxJurisdiction
from app.modules.tax.tenant_tax_service import TenantTaxService

DOCUMENT_TYPES = ("invoice", "quote")


@dataclass
class ContextIssue:
    kind: ContextIssueKind
    code: str
    path: str
    message: str

    def as_dict(self) -> dict:
        return {"kind": self.kind.name, "code": self.code, "path": self.path, "message": self.message}


@dataclass
class TaxContext:
    document: dict
    facts: dict
    issues: list = field(default_factory=list)
    context_fingerprint: str = ""

    def as_dict(self) -> dict:
        return {
            "document": self.document,
            "facts": self.facts,
            "issues": [i.as_dict() for i in self.issues],
            "complete": not self.issues,
            "context_fingerprint": self.context_fingerprint,
        }


def _canonical(value: Any) -> Any:
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if hasattr(value, "name") and hasattr(value, "value"):          # enums
        return value.name
    if isinstance(value, dict):
        return {str(k): _canonical(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_canonical(v) for v in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return str(value)                                               # Decimal and the like


def fingerprint(document: dict, facts: dict) -> str:
    blob = json.dumps({"document": _canonical(document), "facts": _canonical(facts)},
                      sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def _aware(value: Optional[datetime]) -> Optional[datetime]:
    if value is not None and value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value


class TaxContextBuilder:
    def __init__(self, db: Session):
        self.db = db
        self.tenant = TenantTaxService(db)
        self.classifications = ClassificationService(db)

    def build(self, organization_id: int, document_type: str, document_id: int,
              now: Optional[datetime] = None) -> TaxContext:
        if document_type not in DOCUMENT_TYPES:
            raise BadRequestException(f"document_type must be one of {', '.join(DOCUMENT_TYPES)}.")
        now = now or datetime.now(timezone.utc)
        issues: list[ContextIssue] = []

        def issue(kind, code, path, message):
            issues.append(ContextIssue(kind, code, path, message))

        doc, lines = self._document(organization_id, document_type, document_id)
        tax_date: Optional[date] = getattr(doc, "tax_date", None)
        document = {
            "type": document_type, "id": doc.id, "status": doc.status,
            "number": getattr(doc, "invoice_number", None) or getattr(doc, "quote_number", None),
            "currency": doc.currency, "tax_date": tax_date, "seller_entity_id": doc.seller_entity_id,
            "customer_id": doc.customer_id,
        }
        if tax_date is None:
            issue(ContextIssueKind.MISSING, "TAX_DATE_MISSING", "document.tax_date",
                  "The tax date is not set; it is never assumed.")
        if not (doc.currency or "").strip():
            issue(ContextIssueKind.MISSING, "CURRENCY_MISSING", "document.currency", "The currency is not set.")

        facts: dict = {}

        # ── Seller entity (§08.1 step 1) ──
        entity = None
        if doc.seller_entity_id is None:
            issue(ContextIssueKind.MISSING, "SELLER_ENTITY_MISSING", "document.seller_entity_id",
                  "No issuing seller entity is assigned.")
        else:
            entity = self.db.query(SellerLegalEntity).filter(
                SellerLegalEntity.id == doc.seller_entity_id,
                SellerLegalEntity.organization_id == organization_id).first()
        facts["seller_entity"] = None if entity is None else {
            "id": entity.id, "version": entity.version, "country_code": entity.country_code,
            "subdivision_code": entity.subdivision_code, "timezone": entity.timezone,
            "tax_regime": entity.tax_regime, "is_active": entity.is_active,
            "is_merchant_of_record": entity.is_merchant_of_record,
        }
        if entity is not None:
            if not entity.country_code:
                issue(ContextIssueKind.MISSING, "SELLER_COUNTRY_MISSING", "seller_entity.country_code",
                      "The seller entity has no establishment country.")
            if not entity.is_active:
                issue(ContextIssueKind.NOT_PERMITTED, "SELLER_ENTITY_INACTIVE", "seller_entity",
                      "The seller entity is inactive.")

        # ── Pricing mode and lines (§08.1 step 2) ──
        inclusive_flags = {bool(l.is_tax_inclusive) for l in lines}
        pricing_mode = None
        if not lines:
            issue(ContextIssueKind.MISSING, "NO_LINES", "lines", "The document has no lines.")
        elif len(inclusive_flags) > 1:
            issue(ContextIssueKind.AMBIGUOUS, "PRICING_MODE_MIXED", "lines.is_tax_inclusive",
                  "Lines mix tax-inclusive and tax-exclusive pricing.")
        else:
            pricing_mode = "INCLUSIVE" if inclusive_flags.pop() else "EXCLUSIVE"
        facts["pricing_mode"] = pricing_mode

        line_facts, categories = [], set()
        for line in sorted(lines, key=lambda l: (l.line_number or 0, l.id)):
            entry = {"line_id": line.id, "line_number": line.line_number, "product_id": line.product_id,
                     "classification_id": None, "tax_code": None, "supply_category": None,
                     "registry_product_scope": None, "classification_version": None}
            path = f"lines[{line.line_number}]"
            if line.product_id is None:
                issue(ContextIssueKind.MISSING, "LINE_PRODUCT_MISSING", f"{path}.product_id",
                      "The line has no product, so it has no tax classification.")
            else:
                cls = self.classifications.current(organization_id, line.product_id)
                if cls is None:
                    issue(ContextIssueKind.MISSING, "PRODUCT_CLASSIFICATION_MISSING", f"{path}.classification",
                          f"Product {line.product_id} has no approved tax classification.")
                else:
                    entry.update(classification_id=cls.id, tax_code=cls.tax_code.code,
                                 supply_category=cls.tax_code.supply_category,
                                 registry_product_scope=cls.tax_code.registry_product_scope,
                                 classification_version=cls.classification_version)
                    categories.add(cls.tax_code.supply_category)
            line_facts.append(entry)
        facts["lines"] = line_facts
        facts["classification_version"] = current_classification_version(self.db, organization_id)

        # ── Buyer evidence (§08.1 step 3) ──
        customer = self.db.query(BillingCustomer).filter(
            BillingCustomer.id == doc.customer_id, BillingCustomer.organization_id == organization_id).first()
        facts["buyer"] = self._buyer_facts(organization_id, customer, tax_date, now, categories, issue)

        # ── Jurisdiction, registrations, activations (§08.1 steps 1, 4) ──
        facts["jurisdictions"] = self._jurisdictions(facts["buyer"], issue)
        facts["registrations"], facts["activations"] = self._obligations(
            organization_id, entity, facts["jurisdictions"], facts["buyer"].get("business_status"),
            categories, tax_date, issue)

        context = TaxContext(document=document, facts=facts, issues=issues)
        context.context_fingerprint = fingerprint(document, facts)
        return context

    # ── pieces ──
    def _document(self, organization_id: int, document_type: str, document_id: int):
        if document_type == "invoice":
            doc = self.db.query(Invoice).filter(Invoice.id == document_id,
                                                Invoice.organization_id == organization_id).first()
            if doc is None:
                raise NotFoundException("Invoice", document_id)
            lines = self.db.query(InvoiceItem).filter(InvoiceItem.invoice_id == doc.id,
                                                      InvoiceItem.organization_id == organization_id).all()
        else:
            doc = self.db.query(Quotation).filter(Quotation.id == document_id,
                                                  Quotation.organization_id == organization_id).first()
            if doc is None:
                raise NotFoundException("Quote", document_id)
            lines = self.db.query(QuotationItem).filter(QuotationItem.quotation_id == doc.id,
                                                        QuotationItem.organization_id == organization_id).all()
        return doc, lines

    def _buyer_facts(self, organization_id, customer, tax_date, now, categories, issue) -> dict:
        if customer is None:
            issue(ContextIssueKind.MISSING, "CUSTOMER_MISSING", "buyer", "The customer could not be found.")
            return {"customer_id": None, "business_status": None}

        addresses = self.db.query(CustomerTaxAddress).filter(
            CustomerTaxAddress.organization_id == organization_id, CustomerTaxAddress.customer_id == customer.id,
            CustomerTaxAddress.superseded_at.is_(None)).all()
        by_role = {a.role: a for a in addresses}
        address_facts = {}
        for role in AddressRole:
            a = by_role.get(role)
            address_facts[role.name] = None if a is None else {
                "id": a.id, "country_code": a.country_code, "subdivision_code": a.subdivision_code,
                "postal_code": a.postal_code, "city": a.city, "line1": a.line1, "line2": a.line2,
                "confidence": a.confidence, "source": a.source}
        billing = by_role.get(AddressRole.BILLING)
        if billing is None or not billing.country_code:
            issue(ContextIssueKind.MISSING, "BUYER_COUNTRY_MISSING", "buyer.addresses.BILLING.country_code",
                  "The buyer has no structured billing country.")
        elif billing.confidence == AddressConfidence.DERIVED:
            issue(ContextIssueKind.UNVERIFIED, "BUYER_ADDRESS_DERIVED", "buyer.addresses.BILLING",
                  "The buyer's billing location was derived from legacy free text and has not been confirmed.")
        if billing is not None and billing.country_code and not billing.subdivision_code:
            issue(ContextIssueKind.MISSING, "BUYER_SUBDIVISION_MISSING", "buyer.addresses.BILLING.subdivision_code",
                  "No state/province is recorded; sub-national rules cannot be resolved.")
        from app.modules.tax.address_resolver import ADDRESS_RESOLUTION_COUNTRIES

        if billing is not None and billing.country_code in ADDRESS_RESOLUTION_COUNTRIES:
            # Phase 4c (T07): a ZIP alone never resolves; the street address must
            # be resolved to one district by an address resolver.
            from app.modules.tax.address_resolver import latest_resolution

            resolution = latest_resolution(self.db, organization_id, billing.id)
            address_facts["BILLING"]["resolution"] = None if resolution is None else {
                "id": resolution.id, "status": resolution.status, "precision": resolution.precision,
                "source": resolution.source, "resolver": resolution.resolver_name,
                "jurisdiction_codes": resolution.jurisdiction_codes}
            if not (billing.line1 or "").strip():
                issue(ContextIssueKind.MISSING, "BUYER_STREET_ADDRESS_MISSING", "buyer.addresses.BILLING.line1",
                      "A street address is required: a postal code alone never resolves the tax jurisdiction.")
            elif resolution is None:
                issue(ContextIssueKind.MISSING, "ADDRESS_NOT_RESOLVED", "buyer.addresses.BILLING.resolution",
                      "The billing address has not been resolved to a tax district yet.")
            elif resolution.status != "RESOLVED":
                issue(ContextIssueKind.AMBIGUOUS, "ADDRESS_AMBIGUOUS", "buyer.addresses.BILLING.resolution",
                      f"The billing address resolved {resolution.status.lower()} "
                      f"({resolution.candidates} candidates, precision {resolution.precision}); correct it.")
        if SupplyCategory.GOODS in categories and by_role.get(AddressRole.SHIPPING) is None:
            issue(ContextIssueKind.MISSING, "SHIPPING_ADDRESS_MISSING", "buyer.addresses.SHIPPING",
                  "Goods lines need a structured shipping location.")

        tax_ids = self.db.query(CustomerTaxId).filter(
            CustomerTaxId.organization_id == organization_id, CustomerTaxId.customer_id == customer.id,
            CustomerTaxId.superseded_at.is_(None)).order_by(CustomerTaxId.id).all()
        id_facts, business_evidence = [], []
        for t in tax_ids:
            expired = t.expires_at is not None and _aware(t.expires_at) <= now
            id_facts.append({"id": t.id, "value_normalized": t.value_normalized, "id_type": t.id_type,
                             "country_code": t.country_code, "verification_status": t.verification_status,
                             "verified_at": t.verified_at, "expires_at": t.expires_at, "source": t.source})
            if t.verification_status == VerificationStatus.VERIFIED and not expired:
                business_evidence.append(t.id)
            elif t.verification_status == VerificationStatus.VERIFIED and expired:
                issue(ContextIssueKind.EXPIRED, "TAX_ID_VERIFICATION_EXPIRED", f"buyer.tax_ids[{t.id}]",
                      f"The verification of tax ID {t.id} has expired.")
            elif t.verification_status == VerificationStatus.UNVERIFIED:
                issue(ContextIssueKind.UNVERIFIED, "TAX_ID_UNVERIFIED", f"buyer.tax_ids[{t.id}]",
                      f"Tax ID {t.id} is unverified and is not evidence of business status.")

        # B2B only from evidence; never from customer_type or an unverified ID (T08).
        business_status = "BUSINESS" if business_evidence else None
        if business_status is None:
            issue(ContextIssueKind.AMBIGUOUS, "BUYER_STATUS_UNRESOLVED", "buyer.business_status",
                  "No verified tax ID or other recorded proof establishes whether the buyer is a business.")

        certificates = self.db.query(CustomerExemptionCertificate).filter(
            CustomerExemptionCertificate.organization_id == organization_id,
            CustomerExemptionCertificate.customer_id == customer.id).order_by(CustomerExemptionCertificate.id).all()
        cert_facts = []
        for c in certificates:
            cert_facts.append({"id": c.id, "jurisdiction_id": c.jurisdiction_id, "tax_type_id": c.tax_type_id,
                               "valid_from": c.valid_from, "expires_at": c.expires_at, "status": c.status,
                               "reason_code": c.reason_code, "evidence_attached": c.evidence_file_id is not None})
            if c.status == CertificateStatus.ACTIVE and tax_date is not None and c.expires_at is not None \
                    and c.expires_at <= tax_date:
                issue(ContextIssueKind.EXPIRED, "EXEMPTION_CERTIFICATE_EXPIRED", f"buyer.exemption_certificates[{c.id}]",
                      f"Exemption certificate {c.id} expired before the tax date.")

        return {
            "customer_id": customer.id,
            "addresses": address_facts,
            "tax_ids": id_facts,
            "business_status": business_status,
            "business_evidence_tax_id_ids": business_evidence,
            # Reported for transparency only; never used to decide B2B/B2C.
            "tenant_declared_customer_type": customer.customer_type,
            "exemption_certificates": cert_facts,
        }

    def _jurisdictions(self, buyer: dict, issue) -> list:
        billing = (buyer.get("addresses") or {}).get("BILLING")
        if not billing or not billing.get("country_code"):
            return []
        codes = [billing["country_code"]]
        if billing.get("subdivision_code"):
            codes.append(f"{billing['country_code']}-{billing['subdivision_code']}")
        resolution = billing.get("resolution")
        if "resolution" in billing:
            # Resolved-address countries (US): only the resolved districts count.
            if not resolution or resolution["status"] != "RESOLVED":
                return []
            codes = list(dict.fromkeys(resolution["jurisdiction_codes"]))
        found = {j.code: j for j in self.db.query(TaxJurisdiction).filter(TaxJurisdiction.code.in_(codes))}
        if billing["country_code"] not in found:
            issue(ContextIssueKind.MISSING, "JURISDICTION_NOT_IN_REGISTRY", "jurisdictions",
                  f"{billing['country_code']} is not in the tax reference registry.")
        elif resolution and [c for c in codes if c not in found]:
            issue(ContextIssueKind.MISSING, "JURISDICTION_NOT_IN_REGISTRY", "jurisdictions",
                  "Resolved districts are not in the tax reference registry: "
                  + ", ".join(c for c in codes if c not in found))
        return [{"id": found[c].id, "code": c, "timezone": found[c].timezone} for c in codes if c in found]

    def _obligations(self, organization_id, entity, jurisdictions, business_status, categories, tax_date, issue):
        if entity is None or not jurisdictions:
            return [], []
        jurisdiction_ids = [j["id"] for j in jurisdictions]
        registrations = self.db.query(EntityTaxRegistration).filter(
            EntityTaxRegistration.organization_id == organization_id,
            EntityTaxRegistration.seller_entity_id == entity.id,
            EntityTaxRegistration.jurisdiction_id.in_(jurisdiction_ids)).order_by(EntityTaxRegistration.id).all()
        reg_facts = [{"id": r.id, "jurisdiction_id": r.jurisdiction_id, "tax_type_id": r.tax_type_id,
                      "valid_from": r.valid_from, "valid_to": r.valid_to, "status": r.status,
                      "verification_status": r.verification_status} for r in registrations]

        activations = self.db.query(EntityTaxActivation).filter(
            EntityTaxActivation.organization_id == organization_id,
            EntityTaxActivation.seller_entity_id == entity.id,
            EntityTaxActivation.jurisdiction_id.in_(jurisdiction_ids),
            EntityTaxActivation.status == TenantApprovalStatus.APPROVED).order_by(EntityTaxActivation.id).all()

        needed = set()
        if business_status is not None:
            needed = {transaction_class_for(True, c) for c in categories}
        act_facts = []
        for a in activations:
            state = self.tenant.effective_state(a, tax_date) if tax_date is not None else None
            act_facts.append({
                "id": a.id, "jurisdiction_id": a.jurisdiction_id, "tax_type_id": a.tax_type_id,
                "transaction_class": a.transaction_class, "mode": a.mode, "effective_from": a.effective_from,
                "effective_to": a.effective_to, "registration_id": a.registration_id,
                "legal_basis_id": a.legal_basis_id, "approved_at": a.approved_at,
                "effective": None if state is None else state["effective"],
                "not_effective_reasons": None if state is None else state["reasons"],
                "availability_version_id": None if state is None else state["availability_version_id"],
                "availability_mode": None if state is None else state["availability_mode"],
            })
        if tax_date is not None:
            effective_classes = {f["transaction_class"] for f in act_facts if f["effective"]}
            for cls in sorted(needed - effective_classes, key=lambda c: c.name):
                issue(ContextIssueKind.NOT_PERMITTED, "NO_EFFECTIVE_ACTIVATION", f"activations.{cls.name}",
                      f"No activation for {cls.name} is in effect for this jurisdiction on the tax date.")
            if not act_facts:
                issue(ContextIssueKind.NOT_PERMITTED, "NO_ACTIVATION", "activations",
                      "The seller entity has no approved activation for the buyer's jurisdiction.")
            for f in act_facts:
                for reason in f["not_effective_reasons"] or []:
                    issue(ContextIssueKind.NOT_PERMITTED, "ACTIVATION_NOT_EFFECTIVE", f"activations[{f['id']}]", reason)
        return reg_facts, act_facts


def build_tax_context(db: Session, organization_id: int, document_type: str, document_id: int) -> dict:
    return TaxContextBuilder(db).build(organization_id, document_type, document_id).as_dict()
