"""
app/modules/tax/determination_service.py
----------------------------------------
Governed tax determination (ZB-TAX-ARCH-001 Phase 3a, §08.1 steps 1-7).

create_quote() turns a draft invoice or quote of a GOVERNED seller entity
into a persisted TaxQuote:

  1. Assemble the Phase 2 TaxContext (facts, issues, context_fingerprint) and a
     document_hash over the commercial inputs (lines, prices, discounts,
     currency, tax date, entity, customer).
  2. Refuse what Phase 3a does not support (UNSUPPORTED): currencies with more
     than 2 minor units (invoice money columns are NUMERIC(14,2)), shipping or
     round-off on governed invoices, lines that resolve to different engines
     or rounding rules.
  3. Route every line to the activations in effect on the tax date and their
     engine; a line with none is NOT_DETERMINED — never 0% (T01).
  4. Block only on context issues the engine declares as required facts;
     everything else is returned as a warning.
  5. Apply the engine's rates with ONE money path: document discount
     allocated pro-rata before tax (T09), inclusive prices extracted, the
     engine's rounding rule (per line / per document), unrounded amounts kept
     at NUMERIC(18,6) next to the rounded ones.

A quote is QUOTED until the invoice domain revalidates and commits it at
issuance (issuance_gate.py). Refused quotes are persisted too (status
NEEDS_EVIDENCE / UNSUPPORTED) as the record of why determination stopped.
"""
import hashlib
import json
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import ROUND_DOWN, Decimal
from typing import Optional

from sqlalchemy.orm import Session

from app.config import settings
from app.core.exceptions import BadRequestException, NotFoundException, ZoikoException
from app.modules.billing.models import Invoice, InvoiceItem, Quotation, QuotationItem
from app.modules.tax.context_builder import DOCUMENT_TYPES, TaxContextBuilder, _canonical
from app.modules.tax.engines import (
    ACTIVATION_FACTS,
    ROUTING_FACTS,
    ComponentResult,
    EngineRequest,
    EngineResolver,
    LineInput,
    LineResult,
)
from app.modules.tax.provider_contract import REASON_CODES, ProviderError
from app.modules.tax.enums import (
    EngineKind,
    EntityTaxRegime,
    RemoteCommitState,
    RoundingMode,
    RoundingRule,
    SupplyCategory,
    TaxOutcome,
    TaxQuoteStatus,
    TenantApprovalStatus,
    transaction_class_for,
)
from app.modules.tax.currencies import governed_currency_decimals
from app.modules.tax.models import EntityTaxActivation, SellerLegalEntity
from app.modules.tax.quote_models import TaxQuote, TaxQuoteComponent, TaxQuoteLine
from app.modules.tax.tenant_tax_service import TenantTaxService

SIX = Decimal("0.000001")
HUNDRED = Decimal("100")

class QuoteConflictError(ZoikoException):
    def __init__(self, message: str):
        super().__init__(status_code=409, error_code="TAX_QUOTE_CONFLICT", message=message)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _sha(payload) -> str:
    blob = json.dumps(_canonical(payload), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


# Governed rounding always takes the engine-declared RoundingMode (F4): there
# is deliberately no default mode here.
def _q6(value: Decimal, mode: RoundingMode) -> Decimal:
    """An unrounded figure as stored (6 decimal places)."""
    return Decimal(value).quantize(SIX, rounding=mode.decimal_rounding)


def _round(value: Decimal, decimals: int, mode: RoundingMode) -> Decimal:
    return Decimal(value).quantize(Decimal(1).scaleb(-decimals), rounding=mode.decimal_rounding)


# ── Document inputs ─────────────────────────────────────────────────────

def load_document(db: Session, organization_id: int, document_type: str, document_id: int):
    if document_type not in DOCUMENT_TYPES:
        raise BadRequestException(f"document_type must be one of {', '.join(DOCUMENT_TYPES)}.")
    if document_type == "invoice":
        doc = db.query(Invoice).filter(Invoice.id == document_id, Invoice.organization_id == organization_id).first()
        if doc is None:
            raise NotFoundException("Invoice", document_id)
        lines = db.query(InvoiceItem).filter(InvoiceItem.invoice_id == doc.id,
                                             InvoiceItem.organization_id == organization_id).all()
    else:
        doc = db.query(Quotation).filter(Quotation.id == document_id, Quotation.organization_id == organization_id).first()
        if doc is None:
            raise NotFoundException("Quote", document_id)
        lines = db.query(QuotationItem).filter(QuotationItem.quotation_id == doc.id,
                                               QuotationItem.organization_id == organization_id).all()
    return doc, sorted(lines, key=lambda l: (l.line_number or 0, l.id))


def _line_price(line) -> Decimal:
    if line.original_amount is not None:
        return Decimal(str(line.original_amount)) * Decimal(str(line.exchange_rate or 1))
    return Decimal(str(line.unit_price or 0))


def _line_gross(line) -> Decimal:
    price = _line_price(line)
    if (getattr(line, "resolved_price_type", None) or "unit") in ("lump_sum", "graduated_total"):
        return price
    return Decimal(str(line.quantity or 0)) * price


def document_hash(document_type: str, doc, lines) -> str:
    """Hash of the commercial inputs a quote was computed from. Client-sent
    tax fields are deliberately excluded: governed tax never comes from them."""
    return _sha({
        "type": document_type, "id": doc.id, "customer_id": doc.customer_id, "currency": doc.currency,
        "seller_entity_id": doc.seller_entity_id, "tax_date": getattr(doc, "tax_date", None),
        "discount_percentage": doc.discount_percentage,
        "shipping_amount": getattr(doc, "shipping_amount", None), "round_off": getattr(doc, "round_off", None),
        "lines": [{
            "id": l.id, "product_id": l.product_id, "quantity": l.quantity, "unit_price": l.unit_price,
            "original_amount": l.original_amount, "exchange_rate": l.exchange_rate,
            "discount_percentage": l.discount_percentage, "is_tax_inclusive": bool(l.is_tax_inclusive),
            "resolved_price_type": getattr(l, "resolved_price_type", None),
        } for l in lines],
    })


def entity_regime(db: Session, organization_id: int, seller_entity_id: Optional[int]) -> Optional[EntityTaxRegime]:
    if seller_entity_id is None:
        return None
    entity = db.query(SellerLegalEntity).filter(SellerLegalEntity.id == seller_entity_id,
                                                SellerLegalEntity.organization_id == organization_id).first()
    return entity.tax_regime if entity else None


def org_rounding_rule(db: Session, organization_id: int) -> RoundingRule:
    """Tenant-config quotes follow the org's tax_rounding_method setting."""
    from app.modules.billing.models import BillingConfiguration, TaxRoundingMethod

    config = db.query(BillingConfiguration).filter(BillingConfiguration.organization_id == organization_id).first()
    method = getattr(config, "tax_rounding_method", None)
    return RoundingRule.PER_DOCUMENT if method == TaxRoundingMethod.PER_INVOICE else RoundingRule.PER_LINE


# ── Money path ──────────────────────────────────────────────────────────

@dataclass
class _Line:
    input: LineInput
    source: object
    gross: Decimal
    line_discount: Decimal
    document_discount: Decimal
    net: Decimal                      # after all discounts (tax-inclusive for inclusive lines)
    routing: Optional[tuple] = None   # (engine, activations) in effect for this line
    result: Optional[LineResult] = None
    base: Decimal = Decimal("0")      # unrounded taxable base after all discounts
    pre_base: Decimal = Decimal("0")  # unrounded ex-tax amount before the document discount
    tax: Decimal = Decimal("0")
    rate: Decimal = Decimal("0")
    component_tax: list = None        # unrounded per component
    component_rounded: list = None


def _apply_rates(lines: list, decimals: int, rule: RoundingRule, mode: RoundingMode) -> None:
    for line in lines:
        rates = [Decimal(c.rate_percent) for c in line.result.components]
        line.rate = sum(r for r, c in zip(rates, line.result.components) if not c.is_reverse_charge) or Decimal("0")
        divisor = (HUNDRED + line.rate) / HUNDRED if line.input.is_tax_inclusive else Decimal("1")
        line.base = line.net / divisor
        line.pre_base = (line.gross - line.line_discount) / divisor
        line.component_tax = [Decimal("0") if c.is_reverse_charge else line.base * r / HUNDRED
                              for r, c in zip(rates, line.result.components)]
        line.tax = sum(line.component_tax, Decimal("0"))

    if rule == RoundingRule.PER_LINE:
        for line in lines:
            line.component_rounded = [_round(t, decimals, mode) for t in line.component_tax]
        return

    # PER_DOCUMENT: round each component code's document total once, then
    # allocate the rounded total back to lines by largest remainder so the
    # lines still sum exactly to the document figure.
    quantum = Decimal(1).scaleb(-decimals)
    by_code: dict = {}
    for li, line in enumerate(lines):
        line.component_rounded = [Decimal("0")] * len(line.component_tax)
        for ci, comp in enumerate(line.result.components):
            by_code.setdefault(comp.component_code, []).append((li, ci))
    for refs in by_code.values():
        exact = [lines[li].component_tax[ci] for li, ci in refs]
        target = _round(sum(exact, Decimal("0")), decimals, mode)
        floors = [(e / quantum).to_integral_value(rounding=ROUND_DOWN) * quantum for e in exact]
        remainder_units = int(((target - sum(floors, Decimal("0"))) / quantum).to_integral_value())
        order = sorted(range(len(refs)), key=lambda i: (exact[i] - floors[i]), reverse=remainder_units > 0)
        step = quantum if remainder_units > 0 else -quantum
        for k in range(abs(remainder_units)):
            floors[order[k % len(order)]] += step
        for (li, ci), value in zip(refs, floors):
            lines[li].component_rounded[ci] = value


# ── Service ─────────────────────────────────────────────────────────────

class TaxDeterminationService:
    def __init__(self, db: Session, resolver: Optional[EngineResolver] = None, now=None):
        self.db = db
        self._resolver = resolver
        self.now = now or _now
        self.tenant = TenantTaxService(db)

    def resolver(self, organization_id: int) -> EngineResolver:
        if self._resolver is None:
            self._resolver = EngineResolver(self.db, tenant_rounding=org_rounding_rule(self.db, organization_id))
        return self._resolver

    # ── public ──
    def create_quote(self, organization_id: int, actor_id: Optional[int], document_type: str, document_id: int,
                     idempotency_key: Optional[str] = None) -> TaxQuote:
        doc, items = load_document(self.db, organization_id, document_type, document_id)
        if entity_regime(self.db, organization_id, doc.seller_entity_id) != EntityTaxRegime.GOVERNED:
            raise BadRequestException("Governed tax quotes apply only to documents of a GOVERNED seller entity.")

        context = TaxContextBuilder(self.db).build(organization_id, document_type, document_id, now=self.now())
        doc_hash = document_hash(document_type, doc, items)
        request_hash = _sha({"fingerprint": context.context_fingerprint, "document_hash": doc_hash})

        key = (idempotency_key or "").strip() or None
        if key:
            existing = self.db.query(TaxQuote).filter(TaxQuote.organization_id == organization_id,
                                                      TaxQuote.idempotency_key == key).first()
            if existing is not None:
                if existing.request_hash != request_hash or (existing.document_type, existing.document_id) != (
                    document_type, document_id
                ):
                    raise QuoteConflictError("This idempotency key was already used for a different quote request.")
                return existing

        quote = TaxQuote(
            organization_id=organization_id, document_type=document_type, document_id=doc.id,
            seller_entity_id=doc.seller_entity_id, currency=doc.currency, tax_date=getattr(doc, "tax_date", None),
            pricing_mode=context.facts.get("pricing_mode"), context_fingerprint=context.context_fingerprint,
            document_hash=doc_hash, request_hash=request_hash, idempotency_key=key,
            created_by=actor_id, created_at=self.now(), status=TaxQuoteStatus.QUOTED,
        )
        try:
            self._determine(quote, organization_id, doc, items, context)
        except _Refusal as refusal:
            quote.status = refusal.status
            quote.refusal_code = refusal.code
            quote.refusal_reason = refusal.reason
            quote.issues = refusal.issues
            quote.warnings = refusal.warnings
            self.db.add(quote)
            self.db.commit()
            return quote
        self.db.commit()
        return quote

    def current_fingerprints(self, organization_id: int, document_type: str, document_id: int) -> tuple:
        doc, items = load_document(self.db, organization_id, document_type, document_id)
        context = TaxContextBuilder(self.db).build(organization_id, document_type, document_id, now=self.now())
        return context.context_fingerprint, document_hash(document_type, doc, items)

    # ── internals ──
    def _determine(self, quote: TaxQuote, organization_id: int, doc, items, context) -> None:
        facts = context.facts
        issues = [i.as_dict() for i in context.issues]

        decimals = governed_currency_decimals(doc.currency)
        if decimals is None:
            raise _Refusal(TaxQuoteStatus.UNSUPPORTED, "CURRENCY_MINOR_UNITS_UNSUPPORTED",
                           f"{doc.currency or 'An unset currency'} is not supported for governed quotes: only ISO 4217 "
                           "currencies with at most 2 minor units are (wider money columns are needed for more).", warnings=issues)
        if Decimal(str(getattr(doc, "shipping_amount", 0) or 0)) != 0 or Decimal(str(getattr(doc, "round_off", 0) or 0)) != 0:
            raise _Refusal(TaxQuoteStatus.UNSUPPORTED, "SHIPPING_OR_ROUND_OFF_UNSUPPORTED",
                           "Shipping and round-off on governed invoices need taxability rules and are not supported yet.",
                           warnings=issues)
        quote.currency_decimals = decimals

        business = facts.get("buyer", {}).get("business_status") == "BUSINESS"
        line_facts = {f["line_id"]: f for f in facts.get("lines", [])}
        jurisdiction_ids = [j["id"] for j in facts.get("jurisdictions", [])]
        tax_date = getattr(doc, "tax_date", None)
        doc_pct = Decimal(str(doc.discount_percentage or 0))

        lines, engines, routing_problems = [], {}, []
        for item in items:
            lf = line_facts.get(item.id, {})
            category = lf.get("supply_category")
            cls = transaction_class_for(business, category) if category is not None else None
            line_input = LineInput(
                line_id=item.id, line_number=item.line_number, product_id=item.product_id, tax_code=lf.get("tax_code"),
                supply_category=category, registry_product_scope=lf.get("registry_product_scope"),
                transaction_class=cls, is_tax_inclusive=bool(item.is_tax_inclusive),
            )
            gross = _line_gross(item)
            line_discount = gross * Decimal(str(item.discount_percentage or 0)) / HUNDRED
            document_discount = (gross - line_discount) * doc_pct / HUNDRED
            lines.append(_Line(input=line_input, source=item, gross=gross, line_discount=line_discount,
                               document_discount=document_discount, net=gross - line_discount - document_discount))

            if tax_date is None or cls is None or not jurisdiction_ids:
                continue                                   # reported through the context issues
            activations = self._effective_activations(organization_id, doc.seller_entity_id, jurisdiction_ids, cls, tax_date)
            line_engines = {}
            for activation in activations:
                engine, reason = self.resolver(organization_id).engine_for(activation)
                if engine is None:
                    routing_problems.append(f"line {item.line_number}: {reason}")
                    continue
                line_engines.setdefault(engine.identity, (engine, []))[1].append(activation)
            if not activations:
                routing_problems.append(f"line {item.line_number}: no activation for {cls.name} is in effect "
                                        f"on {tax_date.isoformat()}")
            if len(line_engines) > 1:
                raise _Refusal(TaxQuoteStatus.UNSUPPORTED, "MIXED_ENGINES",
                               f"Line {item.line_number} resolves to more than one engine; not supported yet.",
                               warnings=issues)
            for identity, (engine, acts) in line_engines.items():
                engines.setdefault(identity, engine)
                lines[-1].routing = (engine, acts)

        if len(engines) > 1:
            raise _Refusal(TaxQuoteStatus.UNSUPPORTED, "MIXED_ENGINES",
                           "The document's lines resolve to different engines or rounding rules/modes; "
                           "split the document or align the activations.", warnings=issues)
        engine = next(iter(engines.values()), None)

        # Only issues on facts the engine requires block the quote (plan change C).
        # Buyer status matters only to an engine that applies: with no engine,
        # the routing problem (e.g. an expired registration) is the reason.
        required = set(engine.required_facts if engine else ROUTING_FACTS)
        if engine is not None and not engine.unresolved_buyer_as_consumer:
            required.add("BUYER_STATUS_UNRESOLVED")
        else:
            required.discard("BUYER_STATUS_UNRESOLVED")
        blocking = [i for i in issues if i["code"] in required and i["code"] not in ACTIVATION_FACTS]
        warnings = [i for i in issues if i not in blocking]
        if blocking:
            raise _Refusal(TaxQuoteStatus.NEEDS_EVIDENCE, "REQUIRED_FACTS_MISSING",
                           "Required tax facts are missing, expired or ambiguous.", issues=blocking, warnings=warnings)
        if engine is None or routing_problems:
            activation_issues = [i for i in warnings if i["code"] in ACTIVATION_FACTS]
            raise _Refusal(TaxQuoteStatus.NEEDS_EVIDENCE, "NOT_DETERMINED",
                           "Tax could not be determined: " + "; ".join(routing_problems or ["no engine applies"]),
                           issues=activation_issues, warnings=[i for i in warnings if i not in activation_issues])

        # Provider engines fail closed: an open or suspended circuit, or any
        # provider error, is PROVIDER_UNAVAILABLE. Never a fallback (§4a-1).
        health = None
        if engine.is_remote:
            from app.modules.tax.provider_issuance import ProviderHealth

            health = ProviderHealth(self.db, now=self.now)
            problem = health.circuit_problem(engine.name)
            if problem:
                raise _Refusal(TaxQuoteStatus.PROVIDER_UNAVAILABLE, "PROVIDER_UNAVAILABLE", problem, warnings=warnings)

        # Buyers without business evidence get consumer treatment only where
        # the engine's rules say so; the line class is re-derived for them.
        for line in lines:
            if line.routing is None:
                raise _Refusal(TaxQuoteStatus.NEEDS_EVIDENCE, "NOT_DETERMINED",
                               f"Line {line.input.line_number} could not be routed to an engine.", warnings=warnings)
            _, acts = line.routing
            request = EngineRequest(db=self.db, tax_date=tax_date, currency=doc.currency, facts=facts, line=line.input,
                                    activations=acts, business_buyer=True if business else None)
            try:
                result = engine.determine(request)
            except ProviderError as exc:
                if health is not None:
                    health.record_failure(engine.name)
                raise _Refusal(TaxQuoteStatus.PROVIDER_UNAVAILABLE, "PROVIDER_UNAVAILABLE",
                               f"The tax provider could not determine tax: {exc}", warnings=warnings)
            if engine.is_remote:
                result = _check_provider_line(engine, line.input.line_number, acts, result, tax_date, doc.currency,
                                              warnings)
            if result.outcome == TaxOutcome.NOT_DETERMINED or not result.components:
                raise _Refusal(TaxQuoteStatus.NEEDS_EVIDENCE, result.explanation_code or "NOT_DETERMINED",
                               f"Line {line.input.line_number}: {result.legal_reason or 'tax could not be determined'}",
                               warnings=warnings)
            line.result = result
        if health is not None:
            health.record_success(engine.name)

        if engine.rounding_mode is None:
            raise _Refusal(TaxQuoteStatus.UNSUPPORTED, "ROUNDING_MODE_UNDECLARED",
                           f"Engine {engine.name} {engine.version} does not declare a rounding mode.",
                           warnings=warnings)
        _apply_rates(lines, decimals, engine.rounding_rule, engine.rounding_mode)
        self._persist(quote, organization_id, engine, lines, decimals, warnings)

    def _effective_activations(self, organization_id, seller_entity_id, jurisdiction_ids, cls, tax_date) -> list:
        candidates = self.db.query(EntityTaxActivation).filter(
            EntityTaxActivation.organization_id == organization_id,
            EntityTaxActivation.seller_entity_id == seller_entity_id,
            EntityTaxActivation.jurisdiction_id.in_(jurisdiction_ids),
            EntityTaxActivation.transaction_class == cls,
            EntityTaxActivation.status == TenantApprovalStatus.APPROVED,
        ).order_by(EntityTaxActivation.id).all()
        return [a for a in candidates if self.tenant.effective_state(a, tax_date)["effective"]]

    def _persist(self, quote: TaxQuote, organization_id: int, engine, lines: list, decimals: int, warnings) -> None:
        """Compute every rounded figure first, then insert the quote once —
        its amounts are frozen columns and are never updated after insert."""
        mode = engine.rounding_mode

        def q6(value):
            return _q6(value, mode)

        sub_u = disc_u = tax_u = tot_u = Decimal("0")
        sub = disc = tax = tot = Decimal("0")
        rounded = []
        for line in lines:
            line_tax = sum(line.component_rounded, Decimal("0"))
            gross_after = _round(line.net, decimals, mode)
            base_rounded = gross_after - line_tax if line.input.is_tax_inclusive else _round(line.base, decimals, mode)
            pre_rounded = _round(line.pre_base, decimals, mode)
            rounded.append((line, line_tax, base_rounded))
            sub_u += line.pre_base
            disc_u += line.pre_base - line.base
            tax_u += line.tax
            tot_u += line.base + line.tax
            sub += pre_rounded
            disc += pre_rounded - base_rounded
            tax += line_tax
            tot += base_rounded + line_tax

        quote.engine_kind = engine.kind
        quote.engine_name = engine.name
        quote.engine_version = engine.version
        quote.rounding_rule = engine.rounding_rule
        quote.rounding_mode = mode
        quote.warnings = warnings or None
        quote.expires_at = self.now() + timedelta(hours=settings.TAX_QUOTE_TTL_HOURS)
        if engine.is_remote:
            quote.provider_name = engine.name
            quote.remote_commit_state = RemoteCommitState.PENDING
        quote.subtotal_unrounded, quote.discount_unrounded = q6(sub_u), q6(disc_u)
        quote.tax_unrounded, quote.total_unrounded = q6(tax_u), q6(tot_u)
        quote.subtotal, quote.discount_amount, quote.tax_amount, quote.total_amount = sub, disc, tax, tot
        self.db.add(quote)
        self.db.flush()

        for line, line_tax, base_rounded in rounded:
            row = TaxQuoteLine(
                organization_id=organization_id, tax_quote_id=quote.id, document_line_id=line.input.line_id,
                line_number=line.input.line_number, product_id=line.input.product_id, tax_code=line.input.tax_code,
                supply_category=line.input.supply_category, transaction_class=line.input.transaction_class,
                outcome=line.result.outcome, explanation_code=line.result.explanation_code,
                legal_reason=line.result.legal_reason, is_tax_inclusive=line.input.is_tax_inclusive,
                quantity=q6(Decimal(str(line.source.quantity or 0))), gross_unrounded=q6(line.gross),
                line_discount_unrounded=q6(line.line_discount), document_discount_unrounded=q6(line.document_discount),
                taxable_base_unrounded=q6(line.base), tax_unrounded=q6(line.tax), effective_rate=line.rate,
                taxable_base=base_rounded, tax_amount=line_tax, line_total=base_rounded + line_tax,
            )
            self.db.add(row)
            self.db.flush()
            for comp, unrounded, comp_rounded in zip(line.result.components, line.component_tax, line.component_rounded):
                self.db.add(TaxQuoteComponent(
                    organization_id=organization_id, tax_quote_id=quote.id, tax_quote_line_id=row.id,
                    component_code=comp.component_code, label=comp.label, jurisdiction_id=comp.jurisdiction_id,
                    tax_type_id=comp.tax_type_id, rate_source=comp.rate_source, rate_version_id=comp.rate_version_id,
                    activation_id=comp.activation_id, rate_percent=comp.rate_percent, taxable_unrounded=q6(line.base),
                    tax_unrounded=q6(unrounded), tax_amount=comp_rounded, reporting_code=comp.reporting_code,
                    is_reverse_charge=comp.is_reverse_charge,
                ))
        self.db.flush()


def _check_provider_line(engine, line_number: int, activations, result: LineResult, tax_date, currency,
                         warnings) -> LineResult:
    """REVIEW_REQUIRED when the provider contradicts our context: tax where we
    hold no registration or obligation, another tax date or currency,
    components that don't add up, or zero tax without a recognised reason."""
    def review(reason):
        raise _Refusal(TaxQuoteStatus.REVIEW_REQUIRED, "PROVIDER_CONTRADICTS_CONTEXT",
                       f"Line {line_number}: {reason}", warnings=warnings)

    if result.outcome == TaxOutcome.NOT_DETERMINED:
        return result
    held = {a.jurisdiction_id for a in activations}
    applied = set(result.applied_jurisdiction_ids or []) | {c.jurisdiction_id for c in result.components
                                                           if c.jurisdiction_id is not None}
    if applied - held:
        review("the provider applied tax in a jurisdiction where this entity has no recorded registration or "
               "obligation.")
    if result.provider_tax_date is not None and result.provider_tax_date != tax_date:
        review(f"the provider used tax date {result.provider_tax_date}, not {tax_date}.")
    if result.provider_currency is not None and result.provider_currency.upper() != (currency or "").upper():
        review(f"the provider used currency {result.provider_currency}, not {currency}.")
    amounts = [c.provider_tax_amount for c in result.components if c.provider_tax_amount is not None]
    if result.provider_line_tax is not None and amounts and sum(amounts, Decimal("0")) != result.provider_line_tax:
        review("the provider's components do not add up to its line total.")
    taxed = any(Decimal(c.rate_percent) > 0 and not c.is_reverse_charge for c in result.components)
    zero = (result.provider_line_tax == 0) if result.provider_line_tax is not None else not taxed
    if zero and activations:
        code = (result.reason_code or "").strip().upper()
        if code not in REASON_CODES:
            review(f"the provider returned no tax {'with unrecognised reason ' + code if code else 'and no reason'} "
                   "although this entity holds a registration here.")
        components = result.components or [ComponentResult(
            component_code=f"{engine.name}:{code}", rate_percent=Decimal("0"), rate_source="PROVIDER",
            jurisdiction_id=a.jurisdiction_id, tax_type_id=a.tax_type_id, activation_id=a.id, reporting_code=code)
            for a in activations]
        return LineResult(outcome=REASON_CODES[code], explanation_code=f"PROVIDER_{code}", components=components,
                          legal_reason=f"{engine.name}: {code.replace('_', ' ').lower()}"
                                       + (f" ({result.legal_reason})" if result.legal_reason else ""))
    return result


class _Refusal(Exception):
    def __init__(self, status: TaxQuoteStatus, code: str, reason: str, issues=None, warnings=None):
        super().__init__(reason)
        self.status, self.code, self.reason = status, code, reason
        self.issues, self.warnings = issues or None, warnings or None


def view_quote(quote: TaxQuote) -> dict:
    return {
        "id": quote.id, "document_type": quote.document_type, "document_id": quote.document_id,
        "seller_entity_id": quote.seller_entity_id, "status": quote.status.name,
        "engine": None if quote.engine_kind is None else {
            "kind": quote.engine_kind.name, "name": quote.engine_name, "version": quote.engine_version,
            "rounding_rule": quote.rounding_rule.name if quote.rounding_rule else None,
            "rounding_mode": quote.rounding_mode.name if quote.rounding_mode else None},
        "currency": quote.currency, "tax_date": quote.tax_date, "pricing_mode": quote.pricing_mode,
        "context_fingerprint": quote.context_fingerprint, "document_hash": quote.document_hash,
        "totals": {"subtotal": quote.subtotal, "discount_amount": quote.discount_amount,
                   "tax_amount": quote.tax_amount, "total_amount": quote.total_amount},
        "totals_unrounded": {"subtotal": quote.subtotal_unrounded, "discount_amount": quote.discount_unrounded,
                             "tax_amount": quote.tax_unrounded, "total_amount": quote.total_unrounded},
        "issues": quote.issues or [], "warnings": quote.warnings or [],
        "refusal": None if not quote.refusal_code else {"code": quote.refusal_code, "reason": quote.refusal_reason},
        "remote_commit_state": quote.remote_commit_state.name,
        "created_at": quote.created_at, "expires_at": quote.expires_at, "validated_at": quote.validated_at,
        "stale_reason": quote.stale_reason, "committed_at": quote.committed_at, "voided_at": quote.voided_at,
        "lines": [{
            "line_number": l.line_number, "document_line_id": l.document_line_id, "product_id": l.product_id,
            "tax_code": l.tax_code, "transaction_class": l.transaction_class.name if l.transaction_class else None,
            "outcome": l.outcome.name, "explanation_code": l.explanation_code, "legal_reason": l.legal_reason,
            "is_tax_inclusive": l.is_tax_inclusive, "effective_rate": l.effective_rate,
            "taxable_base": l.taxable_base, "tax_amount": l.tax_amount, "line_total": l.line_total,
            "components": [{
                "component_code": c.component_code, "label": c.label, "rate_percent": c.rate_percent,
                "rate_source": c.rate_source, "rate_version_id": c.rate_version_id, "activation_id": c.activation_id,
                "tax_amount": c.tax_amount, "tax_unrounded": c.tax_unrounded, "is_reverse_charge": c.is_reverse_charge,
            } for c in l.components],
        } for l in quote.lines],
    }
