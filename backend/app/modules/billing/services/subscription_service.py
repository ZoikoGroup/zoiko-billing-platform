import logging
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.core.exceptions import (
    AlreadyExistsException,
    BadRequestException,
    NotFoundException,
)
from app.modules.billing.models import (
    BillingAuditAction,
    BillingPeriod,
    CONTRACT_BLOCKED_STATUSES,
    Invoice,
    InvoiceItem,
    InvoiceStatus,
    InvoiceStatusHistory,
    PricingModel,
    PriceSource,
    Product,
    Subscription,
    SubscriptionEvent,
    SubscriptionPlan,
    BillingSubscriptionStatus,
)
from app.modules.billing.services.price_resolver import PriceResolver
from app.modules.billing.utils.currency_utils import round_money, convert_amount
from app.modules.billing.repositories.subscription import (
    SubscriptionEventRepository,
    SubscriptionPlanRepository,
    SubscriptionRepository,
)
from app.modules.billing.services.audit_service import BillingAuditService
from app.modules.billing.services.base import safe_commit_and_refresh, filter_allowed
from app.modules.billing.services.calculation_service import CalculationService
from app.modules.billing.services.customer_service import CustomerService
from app.modules.billing.services.exchange_rate_service import ExchangeRateService
from app.modules.billing.services.settings_service import BillingConfigurationService
from app.services.email_service import send_subscription_renewed_email, send_past_due_notice_email

logger = logging.getLogger("zoiko")

SUB_ALLOWED_FIELDS = {
    "customer_id", "plan_id", "contract_id", "subscription_number",
    "currency", "quantity", "unit_price", "setup_fee",
    "discount_percentage", "discount_amount", "tax_percentage",
    "start_date", "current_term_start", "current_term_end",
    "trial_end_date", "next_billing_at", "status",
    "cancellation_reason", "notes",
    "product_id", "pricing_plan_id", "price_source",
    "base_price", "resolved_price",
}
PLAN_ALLOWED_FIELDS = {
    "plan_name", "plan_code", "description", "category",
    "billing_period", "billing_cycles", "unit_price",
    "setup_fee", "trial_days", "is_public",
    "sort_order", "is_active",
}


class SubscriptionService:
    def __init__(self, db: Session):
        self.db = db
        self.repo = SubscriptionRepository(db)
        self.plan_repo = SubscriptionPlanRepository(db)
        self.event_repo = SubscriptionEventRepository(db)
        self.customer_service = CustomerService(db)
        self.audit = BillingAuditService(db)
        self.config_service = BillingConfigurationService(db)
        self.exchange_rate_service = ExchangeRateService(db)

    def _validate_status_transition(self, current: BillingSubscriptionStatus, target: BillingSubscriptionStatus) -> None:
        valid_transitions = {
            BillingSubscriptionStatus.ACTIVE: [BillingSubscriptionStatus.PAUSED, BillingSubscriptionStatus.CANCELLED, BillingSubscriptionStatus.PAST_DUE],
            BillingSubscriptionStatus.PAUSED: [BillingSubscriptionStatus.ACTIVE, BillingSubscriptionStatus.CANCELLED],
            BillingSubscriptionStatus.PAST_DUE: [BillingSubscriptionStatus.ACTIVE, BillingSubscriptionStatus.CANCELLED],
            BillingSubscriptionStatus.CANCELLED: [],
            BillingSubscriptionStatus.EXPIRED: [],
        }
        allowed = valid_transitions.get(current, [])
        if target not in allowed:
            raise BadRequestException(
                f"Cannot transition from {current.value} to {target.value}"
            )

    def _compute_next_billing_date(self, start: date, period: BillingPeriod) -> date:
        if period == BillingPeriod.ONE_TIME:
            return start
        if period == BillingPeriod.MONTHLY:
            return self._add_months(start, 1)
        if period == BillingPeriod.QUARTERLY:
            return self._add_months(start, 3)
        if period == BillingPeriod.SEMI_ANNUAL:
            return self._add_months(start, 6)
        if period == BillingPeriod.ANNUAL:
            return self._add_months(start, 12)
        return start + timedelta(days=30)

    @staticmethod
    def _add_months(start: date, months: int) -> date:
        import calendar
        target_month = start.month + months
        target_year = start.year + (target_month - 1) // 12
        target_month = ((target_month - 1) % 12) + 1
        max_day = calendar.monthrange(target_year, target_month)[1]
        return date(target_year, target_month, min(start.day, max_day))

    def _resolve_currency(self, data: dict, customer_id: int, contract_id: Optional[int], organization_id: int) -> str:
        """Resolve subscription currency using priority:
        Explicit currency → Contract currency → Customer currency → Org default
        """
        currency = data.get("currency")
        if currency:
            return currency.upper()
        if contract_id:
            try:
                from app.modules.billing.repositories.sales import ContractRepository
                contract_repo = ContractRepository(self.db)
                contract = contract_repo.get_by_id(contract_id, organization_id)
                if contract and hasattr(contract, 'currency') and contract.currency:
                    return contract.currency.upper()
            except Exception:
                logger.debug("Contract currency lookup failed for contract_id=%s, falling through to customer", contract_id)
        customer = self.customer_service.get_customer(customer_id, organization_id)
        if customer and hasattr(customer, 'currency') and customer.currency:
            return customer.currency.upper()
        return self.config_service.get_default_currency(organization_id) or "USD"

    def create_subscription(
        self, organization_id: int, created_by: int, customer_id: int,
        plan_id: int, subscription_number: str, **data: Any,
    ) -> Subscription:
        data = filter_allowed(data, SUB_ALLOWED_FIELDS)
        self.customer_service.get_customer(customer_id, organization_id)
        plan = self.plan_repo.get_by_id(plan_id, organization_id)
        if not plan.is_active:
            raise BadRequestException("Subscription plan is not active")
        if self.repo.exists(organization_id, subscription_number=subscription_number):
            raise AlreadyExistsException("Subscription", "subscription_number")
        contract_id = data.get("contract_id")
        if contract_id and self.repo.exists(organization_id, contract_id=contract_id):
            raise AlreadyExistsException("Subscription", "contract_id")
        data.setdefault("unit_price", plan.unit_price or 0)
        data["currency"] = self._resolve_currency(data, customer_id, contract_id, organization_id)
        if not data.get("start_date"):
            data["start_date"] = date.today()
        if not data.get("current_term_start"):
            data["current_term_start"] = data["start_date"]
        if not data.get("current_term_end"):
            period = getattr(plan, "billing_period", BillingPeriod.MONTHLY)
            data["current_term_end"] = self._compute_next_billing_date(data["current_term_start"], period)

        product_id = data.get("product_id")
        if product_id is not None:
            price_source = data.get("price_source")
            if price_source == PriceSource.NEGOTIATED.value:
                product = (
                    self.db.query(Product)
                    .filter(
                        Product.id == product_id,
                        Product.organization_id == organization_id,
                    )
                    .first()
                )
                if product:
                    data["base_price"] = Decimal(str(product.default_price or 0))
                data["resolved_price"] = Decimal(str(data.get("unit_price", 0)))
                data["pricing_plan_id"] = None
            else:
                resolver = PriceResolver(self.db)
                try:
                    result = resolver.resolve(
                        organization_id=organization_id,
                        product_id=product_id,
                        pricing_plan_id=data.get("pricing_plan_id"),
                        quantity=Decimal(str(data.get("quantity", 1))),
                    )
                    data["base_price"] = result.base_price
                    data["resolved_price"] = result.resolved_price
                    data["pricing_plan_id"] = result.pricing_plan_id
                    data["price_source"] = result.price_source
                    data["unit_price"] = result.resolved_price
                except (NotFoundException, BadRequestException) as e:
                    raise

        sub = self.repo.create(
            organization_id,
            customer_id=customer_id, plan_id=plan_id,
            subscription_number=subscription_number,
            **data,
        )
        self._log_event(organization_id, sub.id, "created", None, {"subscription_number": subscription_number, "plan_id": plan_id, "currency": data["currency"]}, created_by=created_by)
        self.audit.log(organization_id, created_by, BillingAuditAction.CREATE, "Subscription", sub.id)
        return sub

    def update_subscription(self, sub_id: int, organization_id: int, updated_by: int, **data: Any) -> Subscription:
        data = filter_allowed(data, SUB_ALLOWED_FIELDS)
        sub = self.repo.get_by_id(sub_id, organization_id)
        old_values = {"status": sub.status.value, "quantity": sub.quantity, "unit_price": str(sub.unit_price)}
        updated = self.repo.update(sub_id, organization_id, **data)
        self._log_event(organization_id, sub_id, "updated", old_values, data, created_by=updated_by)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "Subscription", sub_id)
        return updated

    def get_subscription(self, sub_id: int, organization_id: int) -> Subscription:
        return self.repo.get_by_id(sub_id, organization_id)

    def get_by_number(self, organization_id: int, number: str) -> Optional[Subscription]:
        return self.repo.get_by_number(organization_id, number)

    def list_subscriptions(
        self, organization_id: int, page: int = 1, per_page: int = 20,
        search_term: Optional[str] = None, customer_id: Optional[int] = None,
        plan_id: Optional[int] = None, status: Optional[str] = None,
        sort_by: str = "created_at", sort_order: str = "desc",
        contract_id: Optional[int] = None,
        date_from: Optional[str] = None, date_to: Optional[str] = None,
    ) -> Dict[str, Any]:
        return self.repo.list_paginated(
            organization_id=organization_id, page=page, per_page=per_page,
            sort_by=sort_by, sort_order=sort_order,
            search_term=search_term, customer_id=customer_id,
            plan_id=plan_id, status=status, contract_id=contract_id,
            date_from=date_from, date_to=date_to,
        )

    def list_active(self, organization_id: int) -> List[Subscription]:
        return self.repo.list_active(organization_id)

    def list_due_for_billing(self, organization_id: int, billing_date: str) -> List[Subscription]:
        return self.repo.list_due_for_billing(organization_id, billing_date)

    def get_subscription_summary(
        self, organization_id: int,
        search_term: Optional[str] = None, customer_id: Optional[int] = None,
        plan_id: Optional[int] = None, status: Optional[str] = None,
        contract_id: Optional[int] = None,
        date_from: Optional[str] = None, date_to: Optional[str] = None,
    ) -> Dict[str, Any]:
        query = self.db.query(Subscription).filter(Subscription.organization_id == organization_id, Subscription.is_active == True)
        if customer_id:
            query = query.filter(Subscription.customer_id == customer_id)
        if plan_id:
            query = query.filter(Subscription.plan_id == plan_id)
        if contract_id:
            query = query.filter(Subscription.contract_id == contract_id)
        if status:
            query = query.filter(Subscription.status == status)
        if search_term:
            term = f"%{search_term}%"
            query = query.filter(Subscription.subscription_number.ilike(term))
        if date_from:
            query = query.filter(Subscription.created_at >= date_from)
        if date_to:
            query = query.filter(Subscription.created_at <= date_to)

        subs = query.all()
        today = date.today()
        cutoff_30d = today + timedelta(days=30)

        total = len(subs)
        active_count = 0
        paused_count = 0
        cancelled_count = 0
        expired_count = 0
        past_due_count = 0
        expiring_count = 0
        mrr = Decimal("0")

        for s in subs:
            st = (s.status.value if hasattr(s.status, "value") else str(s.status or "")).lower()
            qty = Decimal(str(s.quantity or 1))
            unit_price = Decimal(str(s.unit_price or 0))
            sub_total = unit_price * qty

            if st == "active":
                active_count += 1
                if s.current_term_end and today <= s.current_term_end <= cutoff_30d:
                    expiring_count += 1
                plan = s.plan
                period = (plan.billing_period.value if plan and hasattr(plan.billing_period, "value") else str(getattr(plan, "billing_period", ""))).lower() if plan else "monthly"
                if period == "monthly":
                    mrr += sub_total
                elif period == "quarterly":
                    mrr += sub_total / Decimal("3")
                elif period == "semi_annual":
                    mrr += sub_total / Decimal("6")
                elif period == "annual":
                    mrr += sub_total / Decimal("12")
                else:
                    mrr += sub_total
            elif st == "paused":
                paused_count += 1
            elif st == "cancelled":
                cancelled_count += 1
            elif st == "expired":
                expired_count += 1
            elif st == "past_due":
                past_due_count += 1

        arr = mrr * Decimal("12")
        return {
            "total": total,
            "active_count": active_count,
            "paused_count": paused_count,
            "cancelled_count": cancelled_count,
            "expired_count": expired_count,
            "past_due_count": past_due_count,
            "expiring_count": expiring_count,
            "mrr": float(round_money(mrr)),
            "arr": float(round_money(arr)),
        }

    def get_invoice_schedule_summary(self, organization_id: int) -> Dict[str, Any]:
        subs = self.db.query(Subscription).filter(Subscription.organization_id == organization_id, Subscription.is_active == True).all()
        today = date.today()
        end_of_week = today + timedelta(days=7)
        end_of_month = today + timedelta(days=30)

        # Subscriptions linked to a CANCELLED/TERMINATED contract will never
        # actually bill again (see CONTRACT_BLOCKED_STATUSES) — excluding
        # them from the due/overdue/renewal counters keeps this summary in
        # agreement with what the scheduler will actually select, instead of
        # showing "due for billing" for something the scheduler will skip.
        # `total` still counts every active subscription regardless.
        from app.modules.billing.models import Contract
        contract_ids = {s.contract_id for s in subs if s.contract_id}
        blocked_contract_ids = set()
        if contract_ids:
            blocked_contract_ids = {
                row.id for row in self.db.query(Contract.id).filter(
                    Contract.id.in_(contract_ids),
                    Contract.status.in_(CONTRACT_BLOCKED_STATUSES),
                ).all()
            }

        total = len(subs)
        dueToday = 0
        dueThisWeek = 0
        dueThisMonth = 0
        renewalReminders = 0
        overdue = 0

        for s in subs:
            if s.contract_id and s.contract_id in blocked_contract_ids:
                continue

            st = (s.status.value if hasattr(s.status, "value") else str(s.status or "")).lower()
            next_b = s.next_billing_at
            term_end = s.current_term_end

            if next_b:
                if next_b == today:
                    dueToday += 1
                if today <= next_b <= end_of_week:
                    dueThisWeek += 1
                if today <= next_b <= end_of_month:
                    dueThisMonth += 1
                if next_b < today and st == "active":
                    overdue += 1

            if term_end and today <= term_end <= end_of_month:
                renewalReminders += 1

        return {
            "total": total,
            "dueToday": dueToday,
            "dueThisWeek": dueThisWeek,
            "dueThisMonth": dueThisMonth,
            "renewalReminders": renewalReminders,
            "overdue": overdue,
        }

    # ── Status Mutations ───────────────────────────────────────────────────

    def activate_subscription(self, sub_id: int, organization_id: int, updated_by: int) -> Subscription:
        sub = self.repo.get_by_id(sub_id, organization_id)
        self._validate_status_transition(sub.status, BillingSubscriptionStatus.ACTIVE)
        sub = self.repo.resume(sub_id, organization_id)
        self._log_event(organization_id, sub_id, "activated", {"status": sub.status.value if hasattr(sub, "status") else None}, {"status": "active"}, created_by=updated_by)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "Subscription", sub_id)
        return sub

    def resume_subscription(self, sub_id: int, organization_id: int, updated_by: int) -> Subscription:
        sub = self.repo.get_by_id(sub_id, organization_id)
        self._validate_status_transition(sub.status, BillingSubscriptionStatus.ACTIVE)
        sub = self.repo.resume(sub_id, organization_id)
        self._log_event(organization_id, sub_id, "resumed", {"status": sub.status.value if hasattr(sub, "status") else None}, {"status": "active"}, created_by=updated_by)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "Subscription", sub_id)
        return sub

    def pause_subscription(self, sub_id: int, organization_id: int, updated_by: int) -> Subscription:
        sub = self.repo.get_by_id(sub_id, organization_id)
        self._validate_status_transition(sub.status, BillingSubscriptionStatus.PAUSED)
        sub = self.repo.pause(sub_id, organization_id)
        self._log_event(organization_id, sub_id, "paused", {"status": "active"}, {"status": "paused"}, created_by=updated_by)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "Subscription", sub_id)
        return sub

    def cancel_subscription(self, sub_id: int, organization_id: int, reason: Optional[str] = None, updated_by: int = None) -> Subscription:
        sub = self.repo.get_by_id(sub_id, organization_id)
        self._validate_status_transition(sub.status, BillingSubscriptionStatus.CANCELLED)
        sub = self.repo.cancel(sub_id, organization_id, reason)
        self._log_event(organization_id, sub_id, "cancelled", {"status": sub.status.value if hasattr(sub, "status") else None}, {"status": "cancelled", "reason": reason}, created_by=updated_by)
        self.audit.log(organization_id, updated_by, BillingAuditAction.CANCEL, "Subscription", sub_id)
        return sub

    # ── Plan Changes ──────────────────────────────────────────────────────

    def change_plan(
        self, sub_id: int, organization_id: int, new_plan_id: int,
        updated_by: int, **data: Any,
    ) -> Subscription:
        sub = self.repo.get_by_id(sub_id, organization_id)
        if sub.status != BillingSubscriptionStatus.ACTIVE:
            raise BadRequestException("Only active subscriptions can change plans")
        new_plan = self.plan_repo.get_by_id(new_plan_id, organization_id)
        if not new_plan.is_active:
            raise BadRequestException("Target plan is not active")
        old_plan_id = sub.plan_id
        sub.plan_id = new_plan_id
        sub.unit_price = data.get("unit_price", new_plan.unit_price or sub.unit_price)
        if new_plan.trial_days and not sub.trial_end_date:
            sub.trial_end_date = date.today() + timedelta(days=new_plan.trial_days)
        safe_commit_and_refresh(self.db, sub)
        self._log_event(organization_id, sub_id, "plan_changed", {"plan_id": old_plan_id}, {"plan_id": new_plan_id}, created_by=updated_by)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "Subscription", sub_id)
        return sub

    # ── Billing Cycle ────────────────────────────────────────────────────

    def compute_next_billing(self, sub: Subscription) -> Optional[date]:
        plan = sub.plan
        if not plan or plan.billing_period == BillingPeriod.ONE_TIME:
            return None
        return self._compute_next_billing_date(sub.current_term_end or date.today(), plan.billing_period)

    def renew_subscription(self, sub_id: int, organization_id: int, updated_by: int) -> Subscription:
        sub = self.repo.get_by_id(sub_id, organization_id)
        if sub.status not in (BillingSubscriptionStatus.ACTIVE, BillingSubscriptionStatus.EXPIRED):
            raise BadRequestException("Subscription cannot be renewed")
        plan = sub.plan
        sub.current_term_start = sub.current_term_end or date.today()
        sub.current_term_end = self._compute_next_billing_date(sub.current_term_start, plan.billing_period)
        sub.next_billing_at = self.compute_next_billing(sub)
        sub.status = BillingSubscriptionStatus.ACTIVE
        safe_commit_and_refresh(self.db, sub)
        self._log_event(organization_id, sub_id, "renewed", None, {"current_term_start": str(sub.current_term_start), "current_term_end": str(sub.current_term_end)}, created_by=updated_by)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "Subscription", sub_id)
        email_sent_to = None
        email_delivered = False
        try:
            customer = self.customer_service.get_customer(sub.customer_id, organization_id)
            if customer and customer.email:
                email_sent_to = customer.email
                email_delivered = send_subscription_renewed_email(
                    email=customer.email,
                    customer_name=customer.display_name or customer.company_name,
                    subscription_number=sub.subscription_number,
                    plan_name=plan.plan_name if plan else "",
                    term_start=str(sub.current_term_start),
                    term_end=str(sub.current_term_end),
                    amount=str(sub.unit_price),
                    currency=sub.currency or "USD",
                    organization_id=organization_id,
                    db=self.db,
                )
        except Exception as e:
            logger.warning("Failed to send subscription renewed email for sub %d: %s", sub_id, e)
        self.audit.log(
            organization_id, updated_by, BillingAuditAction.SEND, "Subscription", sub_id,
            new_values={"email_sent_to": email_sent_to, "email_delivered": email_delivered},
        )
        return sub

    def generate_invoice(self, sub_id: int, organization_id: int, created_by: int) -> dict:
        """
        Generate an invoice for a subscription that is due for billing.

        Uses existing InvoiceService to create the invoice — NO duplicate calculation engine.
        Resolves currency, exchange rate, and tax from the subscription's context.
        Returns dict with invoice_id and amounts.

        Concurrency contract: the subscription row is locked (SELECT FOR UPDATE)
        and the invoice, line item, subscription-term advance and event log are
        committed in ONE transaction. Two concurrent runs for the same
        subscription serialize on the lock; the second sees the already-issued
        invoice (deterministic number) and returns skipped instead of double
        charging or double-advancing the term.
        """
        sub = (
            self.db.query(Subscription)
            .filter(Subscription.id == sub_id, Subscription.organization_id == organization_id)
            .with_for_update()
            .first()
        )
        if not sub:
            raise NotFoundException("Subscription", sub_id)

        if sub.status != BillingSubscriptionStatus.ACTIVE:
            raise BadRequestException(f"Cannot generate invoice for {sub.status.value} subscription")

        # Eligibility guard (defense-in-depth): the scheduler and
        # SubscriptionRepository.list_due_for_billing already exclude
        # contract-blocked subscriptions from selection, but this method is
        # also reachable directly (manual single-subscription generation) —
        # it must independently refuse a subscription whose linked contract
        # has been cancelled/terminated, without mutating the subscription's
        # own status or next_billing_at.
        if sub.contract_id:
            from app.modules.billing.repositories.sales import ContractRepository
            contract = ContractRepository(self.db).get_by_id(sub.contract_id, organization_id)
            if contract.status in CONTRACT_BLOCKED_STATUSES:
                raise BadRequestException(
                    f"Cannot generate invoice: linked contract is {contract.status.value}"
                )

        # Resolve currency from subscription (persisted) → customer → org config
        currency = sub.currency
        if not currency:
            customer = self.customer_service.get_customer(sub.customer_id, organization_id)
            currency = customer.currency if customer and hasattr(customer, 'currency') and customer.currency else None
        if not currency:
            currency = self.config_service.get_default_currency(organization_id)

        # Resolve exchange rate for reference/recording only.
        # Invoice amounts are always in the subscription's own currency.
        # The exchange rate is stored on the invoice for reporting conversion
        # but does NOT alter the invoice line-item amounts.
        config = self.config_service.get_configuration(organization_id)
        base_currency = (
            config.base_currency.value
            if hasattr(config.base_currency, "value")
            else str(config.base_currency or "USD")
        )
        currency = (currency or "").upper().strip()
        base_currency = (base_currency or "").upper().strip()

        if not currency:
            currency = base_currency

        # Always use rate=1 for the invoice (same currency as subscription).
        # Cross-currency conversion is handled at reporting level, not invoice level.
        # Record the reference rate for audit/tracking even if not used for amounts.
        invoice_exchange_rate = Decimal("1")
        reference_rate = None
        if currency != base_currency:
            try:
                ref_rate, _, _ = self.exchange_rate_service.get_rate(
                    organization_id, currency, base_currency,
                )
                if ref_rate is not None and ref_rate > 0:
                    reference_rate = ref_rate
            except BadRequestException:
                raise
            except Exception as e:
                logger.warning(
                    "Could not get exchange rate for %s->%s: %s",
                    currency, base_currency, e,
                )

        # Calculate line item amounts using CalculationService
        qty = Decimal(str(sub.quantity or 1))
        price = Decimal(str(sub.unit_price or 0))
        disc_pct = Decimal(str(sub.discount_percentage or 0))
        tax_pct = Decimal(str(sub.tax_percentage or 0))
        is_tax_inclusive = getattr(sub, 'is_tax_inclusive', False) or False

        calc = CalculationService.calculate_line_item(
            quantity=qty,
            unit_price=price,
            discount_percentage=disc_pct,
            tax_percentage=tax_pct,
            exchange_rate=invoice_exchange_rate,
            is_tax_inclusive=is_tax_inclusive
        )

        # Build invoice data — deterministic number based on scheduled billing date
        # ensures same billing period always produces the same invoice number.
        # Combined with the unique (organization_id, invoice_number) constraint
        # this is the idempotency guarantee for the whole billing cycle.
        billing_date = sub.next_billing_at or date.today()
        invoice_number = f"SUB-{sub.subscription_number}-{billing_date.strftime('%Y%m%d')}"

        # Idempotency re-check under the row lock: if a previous run already
        # issued this period's invoice, do nothing (do NOT advance the term
        # again or double-charge).
        existing_invoice = (
            self.db.query(Invoice)
            .filter(
                Invoice.organization_id == organization_id,
                Invoice.subscription_id == sub.id,
                Invoice.invoice_number == invoice_number,
            )
            .first()
        )
        if existing_invoice is not None:
            logger.info(
                "Invoice already exists for subscription %s, period %s",
                sub.subscription_number, invoice_number,
            )
            return {"skipped": True, "reason": "Invoice already exists for this billing period"}

        invoice = Invoice(
            organization_id=organization_id,
            customer_id=sub.customer_id,
            subscription_id=sub.id,
            contract_id=getattr(sub, 'contract_id', None),
            invoice_number=invoice_number,
            status=InvoiceStatus.DRAFT,
            issue_date=billing_date,
            due_date=billing_date,
            currency=currency,
            exchange_rate=Decimal("1"),
            notes=f"Auto-generated from subscription {sub.subscription_number}",
            subtotal=round_money(calc["converted_subtotal"], currency),
            discount_amount=round_money(calc["converted_discount"], currency),
            tax_amount=round_money(calc["converted_tax_amount"], currency),
            total_amount=round_money(calc["converted_line_total"], currency),
            paid_amount=Decimal("0"),
            balance_due=round_money(calc["converted_line_total"], currency),
            is_recurring=True,
            created_by=created_by,
        )
        self.db.add(invoice)
        self.db.flush()

        # Add invoice line item from subscription/plan data
        plan = sub.plan
        plan_name = plan.plan_name if plan else f"Plan #{sub.plan_id}"
        item_description = f"Subscription {sub.subscription_number} — {plan_name}"
        if sub.quantity and sub.quantity > 1:
            item_description += f" (x{sub.quantity})"

        invoice_item = InvoiceItem(
            organization_id=organization_id,
            invoice_id=invoice.id,
            line_number=1,
            description=item_description,
            quantity=qty,
            unit_price=price,
            discount_percentage=disc_pct,
            tax_percentage=tax_pct,
            total=round_money(calc["converted_line_total"], currency),
            discount_amount=round_money(calc["converted_discount"], currency),
            tax_amount=round_money(calc["converted_tax_amount"], currency),
            is_tax_inclusive=is_tax_inclusive,
            invoice_currency=currency,
            converted_amount=round_money(calc["converted_line_total"], currency),
            product_id=getattr(sub, 'product_id', None),
            pricing_plan_id=getattr(sub, 'pricing_plan_id', None),
            price_source=getattr(sub, 'price_source', None),
            base_price=getattr(sub, 'base_price', None),
            resolved_price=getattr(sub, 'resolved_price', None),
        )
        self.db.add(invoice_item)

        # Advance the subscription term in the SAME transaction.
        sub.current_term_start = billing_date
        sub.current_term_end = self._compute_next_billing_date(billing_date, plan.billing_period if plan else BillingPeriod.MONTHLY)
        sub.next_billing_at = self.compute_next_billing(sub)
        sub.last_billed_at = datetime.utcnow()

        # Status history + subscription event, flushed with the same commit.
        self.db.add(InvoiceStatusHistory(
            organization_id=organization_id,
            invoice_id=invoice.id,
            from_status=None,
            to_status=InvoiceStatus.DRAFT,
            changed_by=created_by,
            reason=f"Auto-generated from subscription {sub.subscription_number}",
        ))
        self.db.add(SubscriptionEvent(
            organization_id=organization_id,
            subscription_id=sub.id,
            event_type="invoice_generated",
            old_value=None,
            new_value={
                "invoice_id": invoice.id,
                "invoice_number": invoice.invoice_number,
                "amount": str(calc["converted_line_total"]),
            },
            created_by=created_by,
        ))

        try:
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise
        self.db.refresh(invoice)

        try:
            self.audit.log(
                organization_id, created_by, BillingAuditAction.CREATE, "Invoice", invoice.id,
                new_values={"invoice_number": invoice.invoice_number, "source": "subscription"},
            )
        except Exception as e:
            logger.warning("Could not write audit log for subscription invoice %s: %s", invoice.id, e)

        return {
            "invoice_id": invoice.id,
            "invoice_number": invoice.invoice_number,
            "amount": float(calc["converted_line_total"]),
            "currency": currency,
        }

    def process_due_subscriptions(self, organization_id: int, billing_date: str, created_by: int) -> dict:
        """
        Process all subscriptions due for billing on a given date.
        Returns summary of processed subscriptions.
        """
        due_subs = self.list_due_for_billing(organization_id, billing_date)
        results = {"processed": 0, "skipped": 0, "failed": 0, "invoices": []}
        
        for sub in due_subs:
            try:
                result = self.generate_invoice(sub.id, organization_id, created_by)
                if result.get("skipped"):
                    results["skipped"] += 1
                else:
                    results["processed"] += 1
                    results["invoices"].append(result)
            except Exception as e:
                logger.error("Failed to generate invoice for subscription %d: %s", sub.id, e)
                results["failed"] += 1
        
        return results

    def mark_past_due(self, sub_id: int, organization_id: int, updated_by: int) -> Subscription:
        sub = self.repo.get_by_id(sub_id, organization_id)
        if sub.status != BillingSubscriptionStatus.ACTIVE:
            raise BadRequestException("Only active subscriptions can become past due")
        sub.status = BillingSubscriptionStatus.PAST_DUE
        safe_commit_and_refresh(self.db, sub)
        self._log_event(organization_id, sub_id, "past_due", {"status": "active"}, {"status": "past_due"})
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "Subscription", sub_id)
        email_sent_to = None
        email_delivered = False
        try:
            customer = self.customer_service.get_customer(sub.customer_id, organization_id)
            if customer and customer.email:
                plan = sub.plan
                days = (date.today() - sub.current_term_end).days if sub.current_term_end else 0
                email_sent_to = customer.email
                email_delivered = send_past_due_notice_email(
                    email=customer.email,
                    customer_name=customer.display_name or customer.company_name,
                    subscription_number=sub.subscription_number,
                    plan_name=plan.plan_name if plan else "",
                    days_overdue=str(max(days, 0)),
                    overdue_amount=str(sub.unit_price),
                    currency=sub.currency or "USD",
                    organization_id=organization_id,
                    db=self.db,
                )
        except Exception as e:
            logger.warning("Failed to send past due email for sub %d: %s", sub_id, e)
        self.audit.log(
            organization_id, updated_by, BillingAuditAction.SEND, "Subscription", sub_id,
            new_values={"email_sent_to": email_sent_to, "email_delivered": email_delivered},
        )
        return sub

    # ── Events ─────────────────────────────────────────────────────────────

    def _log_event(
        self, organization_id: int, subscription_id: int, event_type: str,
        old_value: Optional[dict] = None, new_value: Optional[dict] = None,
        reason: Optional[str] = None, created_by: Optional[int] = None,
    ) -> SubscriptionEvent:
        return self.event_repo.log_event(
            organization_id,
            subscription_id, event_type, old_value, new_value, reason, created_by,
        )

    def list_events(self, subscription_id: int, organization_id: int, limit: int = 50) -> List[SubscriptionEvent]:
        self.repo.get_by_id(subscription_id, organization_id)
        return self.event_repo.list_by_subscription(organization_id, subscription_id, limit)

    # ── Plans ──────────────────────────────────────────────────────────────

    def create_plan(self, organization_id: int, created_by: int, **data: Any) -> SubscriptionPlan:
        data = filter_allowed(data, PLAN_ALLOWED_FIELDS)
        if self.plan_repo.exists(organization_id, plan_code=data.get("plan_code")):
            raise AlreadyExistsException("SubscriptionPlan", "plan_code")
        plan = self.plan_repo.create(organization_id, **data)
        self.audit.log(organization_id, created_by, BillingAuditAction.CREATE, "SubscriptionPlan", plan.id)
        return plan

    def update_plan(self, plan_id: int, organization_id: int, updated_by: int, **data: Any) -> SubscriptionPlan:
        data = filter_allowed(data, PLAN_ALLOWED_FIELDS)
        self.plan_repo.get_by_id(plan_id, organization_id)
        if data.get("plan_code"):
            existing = self.plan_repo.get_by_code(organization_id, data["plan_code"])
            if existing and existing.id != plan_id:
                raise AlreadyExistsException("SubscriptionPlan", "plan_code")
        updated = self.plan_repo.update(plan_id, organization_id, **data)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "SubscriptionPlan", plan_id)
        return updated

    def get_plan(self, plan_id: int, organization_id: int) -> SubscriptionPlan:
        return self.plan_repo.get_by_id(plan_id, organization_id)

    def get_plan_by_code(self, organization_id: int, code: str) -> Optional[SubscriptionPlan]:
        return self.plan_repo.get_by_code(organization_id, code)

    def list_plans(
        self, organization_id: int, page: int = 1, per_page: int = 20,
        search_term: Optional[str] = None, category: Optional[str] = None,
        sort_by: str = "sort_order", sort_order: str = "asc",
    ) -> Dict[str, Any]:
        return self.plan_repo.list_paginated(
            organization_id=organization_id, page=page, per_page=per_page,
            sort_by=sort_by, sort_order=sort_order,
            search_term=search_term, category=category,
        )

    def list_public_plans(self, organization_id: int) -> List[SubscriptionPlan]:
        return self.plan_repo.list_public(organization_id)

    # ── Reporting Aggregation ──────────────────────────────────────────────

    def get_subscription_reporting(self, organization_id: int) -> Dict[str, Any]:
        """
        Compute MRR, ARR and currency breakdown for the organisation's
        active subscriptions.

        Currency-normalisation policy:
          * Each subscription amount is normalised to its billing-period
            (monthly ÷ 1, quarterly ÷ 3, annual ÷ 12, etc.)
          * The normalised monthly amount is converted to the org reporting
            currency using a current exchange rate from ExchangeRateService.
          * Subscriptions whose currency cannot be converted are excluded
            from the aggregate but reported separately.
          * Decimal-safe math throughout — no floating-point for totals.
        """
        active_subs = self.repo.list_active_with_plan(organization_id)
        config = self.config_service.get_configuration(organization_id)
        base_currency = (
            config.base_currency.value
            if hasattr(config.base_currency, "value")
            else str(config.base_currency or "USD")
        )

        BILLING_MONTHS = {
            BillingPeriod.MONTHLY: Decimal("1"),
            BillingPeriod.QUARTERLY: Decimal("3"),
            BillingPeriod.SEMI_ANNUAL: Decimal("6"),
            BillingPeriod.ANNUAL: Decimal("12"),
            BillingPeriod.ONE_TIME: Decimal("1"),
        }

        total_mrr = Decimal("0")
        total_arr = Decimal("0")
        currency_breakdown: Dict[str, Decimal] = {}
        convertible_count = 0
        excluded_count = 0

        # Pre-fetch exchange rates for all unique currency pairs once,
        # instead of calling get_rate() per subscription (avoids repeated live API calls)
        unique_pairs = set()
        for sub in active_subs:
            sub_currency = (sub.currency or "").upper().strip() or base_currency
            if sub_currency != base_currency:
                unique_pairs.add((sub_currency, base_currency))
        rate_cache: Dict[tuple, Decimal] = {}
        for from_c, to_c in unique_pairs:
            try:
                rate, _source, _ts = self.exchange_rate_service.get_rate(
                    organization_id, from_c, to_c,
                )
                rate_cache[(from_c, to_c)] = rate
            except Exception:
                logger.warning("Cannot pre-fetch rate %s→%s for reporting", from_c, to_c)

        for sub in active_subs:
            price = Decimal(str(sub.unit_price or 0))
            qty = Decimal(str(sub.quantity or 1))
            raw_monthly = round_money(price * qty, base_currency)

            # Normalise to monthly
            plan = sub.plan
            period = plan.billing_period if plan else BillingPeriod.MONTHLY
            divisor = BILLING_MONTHS.get(period, Decimal("1"))
            monthly_mrr = round_money(raw_monthly / divisor, base_currency)

            # Per-subscription currency (persisted on the subscription)
            sub_currency = (sub.currency or "").upper().strip()
            if not sub_currency:
                sub_currency = base_currency

            if sub_currency == base_currency:
                total_mrr += monthly_mrr
                currency_breakdown[sub_currency] = currency_breakdown.get(sub_currency, Decimal("0")) + monthly_mrr
                convertible_count += 1
                continue

            # Use pre-fetched rate if available
            rate = rate_cache.get((sub_currency, base_currency))
            if rate is not None:
                converted = convert_amount(monthly_mrr, rate, base_currency)
                total_mrr += converted
                currency_breakdown[sub_currency] = currency_breakdown.get(sub_currency, Decimal("0")) + monthly_mrr
                convertible_count += 1
            else:
                logger.warning(
                    "Cannot convert subscription %s currency %s to %s — excluded from aggregate",
                    sub.subscription_number, sub_currency, base_currency,
                )
                excluded_count += 1

        total_arr = round_money(total_mrr * Decimal("12"), base_currency)

        # Build breakdown list (original-currency values)
        breakdown_list = [
            {"currency": curr, "amount": str(amt)}
            for curr, amt in sorted(currency_breakdown.items())
        ]

        return {
            "reporting_currency": base_currency,
            "mrr": str(total_mrr),
            "arr": str(total_arr),
            "active_subscriptions": convertible_count + excluded_count,
            "convertible_subscriptions": convertible_count,
            "excluded_subscriptions": excluded_count,
            "currency_breakdown": breakdown_list,
        }
