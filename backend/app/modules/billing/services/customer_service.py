import logging
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Dict, List, Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.exceptions import (
    AlreadyExistsException,
    BadRequestException,
    NotFoundException,
)
from app.modules.billing.models import (
    BillingAuditAction,
    BillingCustomer,
    CustomerContact,
    CustomerStatus,
)
from app.modules.billing.repositories.customer import (
    CustomerContactRepository,
    CustomerRepository,
)
from app.modules.billing.services.audit_service import BillingAuditService
from app.modules.billing.services.settings_service import BillingConfigurationService
from app.modules.billing.services.base import safe_commit_and_refresh, filter_allowed

logger = logging.getLogger("zoiko_billing")


def _sanitize_audit_data(data: Dict[str, Any]) -> Dict[str, Any]:
    return {
        k: float(v) if isinstance(v, Decimal) else v
        for k, v in data.items()
    }


CUSTOMER_ALLOWED_FIELDS = {
    "customer_code", "company_name", "display_name", "legal_name",
    "first_name", "last_name", "email", "alternate_email",
    "mobile", "phone", "website",
    "designation", "industry", "employee_count",
    "gst_number", "vat_number", "pan", "tin", "tax_category",
    "tax_id", "tax_id_type",
    "billing_address", "shipping_address",
    "billing_country", "shipping_country",
    "payment_terms",
    "currency", "credit_limit", "credit_days", "price_list",
    "customer_type", "status", "is_active", "notes",
    "tags", "custom_fields",
}
CONTACT_ALLOWED_FIELDS = {
    "first_name", "last_name", "email", "phone", "mobile",
    "job_title", "department", "is_primary", "notes",
}


class CustomerService:
    def __init__(self, db: Session):
        self.db = db
        self.repo = CustomerRepository(db)
        self.contact_repo = CustomerContactRepository(db)
        self.audit = BillingAuditService(db)

    def _validate_duplicate(
        self, organization_id: int, email: Optional[str] = None,
        code: Optional[str] = None, company_name: Optional[str] = None,
        exclude_id: Optional[int] = None,
    ) -> None:
        if email:
            existing = self.repo.get_first(organization_id, email=email)
            if existing and (exclude_id is None or existing.id != exclude_id):
                raise AlreadyExistsException("Customer", "email")
        if code:
            existing = self.repo.get_first(organization_id, customer_code=code)
            if existing and (exclude_id is None or existing.id != exclude_id):
                raise AlreadyExistsException("Customer", "customer_code")
        if company_name:
            existing = self.repo.get_first(organization_id, company_name=company_name)
            if existing and (exclude_id is None or existing.id != exclude_id):
                raise AlreadyExistsException("Customer", "company_name")

    def _resolve_org_currency(self, organization_id: int) -> str:
        """Resolve the organization's base/default currency.

        Delegates to BillingConfigurationService, the single authoritative
        source for this lookup (base_currency -> default_currency -> "USD").
        This is the last-resort fallback; callers should prefer
        customer/document currency.
        """
        try:
            return BillingConfigurationService(self.db).get_default_currency(organization_id)
        except Exception:
            logger.debug("Could not resolve org currency for org %s, falling back to USD", organization_id)
            return "USD"

    def create_customer(
        self, organization_id: int, created_by: int, **data: Any,
    ) -> BillingCustomer:
        data = filter_allowed(data, CUSTOMER_ALLOWED_FIELDS)
        # Resolve empty/missing currency to organization base currency
        raw_currency = (data.get("currency") or "").strip()
        if not raw_currency:
            data["currency"] = self._resolve_org_currency(organization_id)
        if not data.get("display_name"):
            data["display_name"] = data.get("company_name") or f"{data.get('first_name', '')} {data.get('last_name', '')}".strip() or "Unnamed Customer"
        self._validate_duplicate(
            organization_id,
            email=data.get("email"),
            code=data.get("customer_code"),
            company_name=data.get("company_name"),
        )
        # create_no_commit + log_no_commit + a single commit below makes the
        # customer row and its audit entry atomic: previously each was its
        # own commit, so a failure writing the audit row (e.g. a transient DB
        # error) still left the customer durably created while the request
        # itself surfaced as a 500 -- a partial-success/false-failure.
        customer = self.repo.create_no_commit(organization_id, **data)
        self.audit.log_no_commit(
            organization_id, created_by, BillingAuditAction.CREATE,
            "BillingCustomer", customer.id,
            new_values=_sanitize_audit_data(data),
        )
        safe_commit_and_refresh(self.db, customer)
        logger.info(f"[BILLING] Customer created: org={organization_id} id={customer.id}")
        return customer

    def update_customer(
        self, customer_id: int, organization_id: int, updated_by: int, **data: Any,
    ) -> BillingCustomer:
        data = filter_allowed(data, CUSTOMER_ALLOWED_FIELDS)
        customer = self.repo.get_by_id(customer_id, organization_id)
        old_values = {
            "company_name": customer.company_name,
            "email": customer.email,
            "customer_code": customer.customer_code,
            "status": customer.status.value if customer.status else None,
        }
        if data.get("email") and data["email"] != customer.email:
            self._validate_duplicate(organization_id, email=data["email"], exclude_id=customer_id)
        if data.get("customer_code") and data["customer_code"] != customer.customer_code:
            self._validate_duplicate(organization_id, code=data["customer_code"], exclude_id=customer_id)
        if data.get("company_name") and data["company_name"] != customer.company_name:
            self._validate_duplicate(organization_id, company_name=data["company_name"], exclude_id=customer_id)
        updated = self.repo.update(customer_id, organization_id, **data)
        self.audit.log(
            organization_id, updated_by, BillingAuditAction.UPDATE,
            "BillingCustomer", customer_id,
            old_values=_sanitize_audit_data(old_values), new_values=_sanitize_audit_data(data),
        )
        return updated

    def get_customer(self, customer_id: int, organization_id: int) -> BillingCustomer:
        return self.repo.get_by_id(customer_id, organization_id)

    def sync_outstanding_balance(self, customer_id: int, organization_id: int) -> BillingCustomer:
        """Recompute a customer's outstanding_balance from their live unpaid
        invoices. Shared by PaymentService.allocate_payment/deallocate_payment
        and CreditNoteService.apply_to_invoice — any operation that moves an
        invoice's balance_due must call this afterward to keep the customer's
        cached balance in sync.

        Uses the SAME aggregation as the dashboard (status filter + is_active
        + currency conversion to the org's base currency) so the cached value
        is always consistent with the org-wide outstanding figure (Issue 1)."""
        from app.modules.billing.models import Invoice
        from app.modules.billing.services.dashboard_service import BillingDashboardService
        customer = self.get_customer(customer_id, organization_id)
        svc = BillingDashboardService(self.db)
        by_customer = svc.get_outstanding_by_customer(organization_id)
        outstanding = float(next((r["outstanding"] for r in by_customer if r["customer_id"] == customer_id), 0.0))
        customer.outstanding_balance = Decimal(str(outstanding))
        safe_commit_and_refresh(self.db, customer)
        return customer

    def get_customer_by_code(self, organization_id: int, code: str) -> Optional[BillingCustomer]:
        return self.repo.get_by_code(organization_id, code)

    def list_customers(
        self, organization_id: int, page: int = 1, per_page: int = 20,
        search_term: Optional[str] = None, customer_type: Optional[str] = None,
        status: Optional[str] = None, sort_by: str = "company_name",
        sort_order: str = "asc", active_only: bool = True,
        country: Optional[str] = None, currency: Optional[str] = None,
        industry: Optional[str] = None, credit_limit_min: Optional[float] = None,
        credit_limit_max: Optional[float] = None,
        payment_terms: Optional[str] = None,
        date_from: Optional[str] = None, date_to: Optional[str] = None,
    ) -> Dict[str, Any]:
        filters = {}
        if customer_type:
            filters["customer_type"] = customer_type
        if status:
            filters["status"] = status
        if country:
            filters["billing_country"] = country
        if currency:
            filters["currency"] = currency
        if industry:
            filters["industry"] = industry
        if payment_terms:
            filters["payment_terms"] = payment_terms
        
        result = self.repo.list_paginated(
            organization_id=organization_id, page=page, per_page=per_page,
            sort_by=sort_by, sort_order=sort_order, active_only=active_only,
            search_term=search_term,
            credit_limit_min=credit_limit_min,
            credit_limit_max=credit_limit_max,
            date_from=date_from,
            date_to=date_to,
            **filters,
        )

        return result

    def search_customers(self, organization_id: int, term: str, limit: int = 20) -> List[BillingCustomer]:
        result = self.repo.list_paginated(
            organization_id=organization_id,
            search_term=term,
            active_only=True,
            page=1,
            per_page=limit
        )
        return result.get("items", [])

    def activate_customer(self, customer_id: int, organization_id: int, updated_by: int) -> BillingCustomer:
        customer = self.repo.get_by_id(customer_id, organization_id)
        if customer.status == CustomerStatus.ACTIVE:
            raise BadRequestException("Customer is already active")
        customer.status = CustomerStatus.ACTIVE
        customer.is_active = True
        safe_commit_and_refresh(self.db, customer)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "BillingCustomer", customer_id)
        return customer

    def deactivate_customer(self, customer_id: int, organization_id: int, updated_by: int) -> BillingCustomer:
        customer = self.repo.get_by_id(customer_id, organization_id)
        if customer.status == CustomerStatus.INACTIVE:
            raise BadRequestException("Customer is already inactive")
        customer.status = CustomerStatus.INACTIVE
        customer.is_active = False
        safe_commit_and_refresh(self.db, customer)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "BillingCustomer", customer_id)
        return customer

    def suspend_customer(self, customer_id: int, organization_id: int, updated_by: int) -> BillingCustomer:
        customer = self.repo.get_by_id(customer_id, organization_id)
        customer.status = CustomerStatus.SUSPENDED
        customer.is_active = False
        safe_commit_and_refresh(self.db, customer)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "BillingCustomer", customer_id)
        return customer

    # ── Contacts ─────────────────────────────────────────────────────────

    def add_contact(self, organization_id: int, customer_id: int, created_by: int, **data: Any) -> CustomerContact:
        data = filter_allowed(data, CONTACT_ALLOWED_FIELDS)
        self.repo.get_by_id(customer_id, organization_id)
        contact = self.contact_repo.create(organization_id, customer_id=customer_id, **data)
        self.audit.log(organization_id, created_by, BillingAuditAction.CREATE, "CustomerContact", contact.id)
        return contact

    def update_contact(self, customer_id: int, contact_id: int, organization_id: int, updated_by: int, **data: Any) -> CustomerContact:
        data = filter_allowed(data, CONTACT_ALLOWED_FIELDS)
        self.repo.get_by_id(customer_id, organization_id)
        contact = self.contact_repo.get_by_id_and_customer(contact_id, organization_id, customer_id)
        for field, value in data.items():
            if hasattr(contact, field) and value is not None:
                setattr(contact, field, value)
        safe_commit_and_refresh(self.db, contact)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "CustomerContact", contact_id)
        return contact

    def remove_contact(self, customer_id: int, contact_id: int, organization_id: int, updated_by: int) -> None:
        self.repo.get_by_id(customer_id, organization_id)
        self.contact_repo.get_by_id_and_customer(contact_id, organization_id, customer_id)
        self.contact_repo.soft_delete(contact_id, organization_id)
        self.audit.log(organization_id, updated_by, BillingAuditAction.DELETE, "CustomerContact", contact_id)

    def set_primary_contact(self, customer_id: int, contact_id: int, organization_id: int, updated_by: int) -> CustomerContact:
        self.repo.get_by_id(customer_id, organization_id)
        self.contact_repo.get_by_id_and_customer(contact_id, organization_id, customer_id)
        contact = self.contact_repo.set_primary(organization_id, contact_id)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "CustomerContact", contact_id)
        return contact

    def list_contacts(self, organization_id: int, customer_id: int) -> List[CustomerContact]:
        self.repo.get_by_id(customer_id, organization_id)
        return self.contact_repo.list_by_customer(organization_id, customer_id)

    # ── Counts ──────────────────────────────────────────────────────────

    def count_customers(self, organization_id: int, active_only: bool = True) -> int:
        return self.repo.count(organization_id, active_only=active_only)

    def exists_by_email(self, organization_id: int, email: str) -> bool:
        return self.repo.exists(organization_id, email=email)

    # ── Hard Delete ───────────────────────────────────────────────────────

    def hard_delete_customer(self, customer_id: int, organization_id: int) -> None:
        self.repo.hard_delete(customer_id, organization_id)
        logger.info(f"[BILLING] Customer hard-deleted: org={organization_id} id={customer_id}")

    def restore_customer(self, customer_id: int, organization_id: int, updated_by: int) -> BillingCustomer:
        customer = self.repo.restore(customer_id, organization_id)
        if customer is None:
            raise NotFoundException("BillingCustomer", customer_id)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "BillingCustomer", customer_id)
        logger.info(f"[BILLING] Customer restored: org={organization_id} id={customer_id}")
        return customer

    def bulk_delete_customers(self, organization_id: int, ids: List[int]) -> int:
        deleted = self.repo.bulk_hard_delete(ids, organization_id)
        logger.info(f"[BILLING] Bulk hard-delete: org={organization_id} ids={ids} count={deleted}")
        return deleted

    # ── Bulk Status Update ────────────────────────────────────────────────

    def bulk_update_status(self, organization_id: int, ids: List[int], status: str, updated_by: int) -> int:
        customers = self.repo.get_by_ids(ids, organization_id)
        now = datetime.now(timezone.utc)
        for customer in customers:
            customer.status = CustomerStatus(status)
            customer.updated_at = now
        safe_commit_and_refresh(self.db, *customers)
        for customer in customers:
            self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "BillingCustomer", customer.id)
        logger.info(f"[BILLING] Bulk status update: org={organization_id} status={status} count={len(customers)}")
        return len(customers)

    # ── Analytics ─────────────────────────────────────────────────────────

    def get_customer_analytics(self, organization_id: int, customer_id: int) -> Dict[str, Any]:
        from app.modules.billing.models import Invoice, Payment, Quotation, Contract, Subscription, CreditNote, Refund, PaymentAllocation
        from app.modules.billing.services.dashboard_service import BillingDashboardService
        customer = self.repo.get_by_id(customer_id, organization_id)

        total_revenue = float(customer.total_revenue or 0)
        # FIX (Issue 1): outstanding must be computed LIVE with the same
        # aggregation as the dashboard aggregate (status filter + is_active +
        # currency conversion) — never from the possibly-stale cached column.
        # This guarantees per-customer outstanding sums to the org aggregate.
        svc = BillingDashboardService(self.db)
        by_customer = svc.get_outstanding_by_customer(organization_id)
        outstanding = float(next((r["outstanding"] for r in by_customer if r["customer_id"] == customer_id), 0.0))

        # All previously loaded every invoice/payment row for this customer
        # into Python, then walked a nested loop over `i.payment_allocations`
        # (an unloaded relationship) per paid invoice -- one extra query per
        # invoice (N+1) just to compute an average. Replaced with plain SQL
        # aggregates, matching the org-wide pattern already used in
        # get_kpi_data's avg_collection_days query.
        total_invoices = self.db.query(func.count(Invoice.id)).filter(
            Invoice.organization_id == organization_id,
            Invoice.customer_id == customer_id,
        ).scalar() or 0

        paid_invoice_count = self.db.query(func.count(Invoice.id)).filter(
            Invoice.organization_id == organization_id,
            Invoice.customer_id == customer_id,
            Invoice.status == "paid",
        ).scalar() or 0

        total_paid = float(self.db.query(func.coalesce(func.sum(Payment.amount), 0)).filter(
            Payment.organization_id == organization_id,
            Payment.customer_id == customer_id,
            Payment.status == "cleared",
        ).scalar() or 0)

        avg_invoice = round(total_revenue / max(paid_invoice_count, 1), 2)

        avg_payment_time_days = self.db.query(
            func.coalesce(func.avg(Payment.payment_date - Invoice.issue_date), 0)
        ).select_from(PaymentAllocation).join(
            Payment, PaymentAllocation.payment_id == Payment.id
        ).join(
            Invoice, PaymentAllocation.invoice_id == Invoice.id
        ).filter(
            Invoice.organization_id == organization_id,
            Invoice.customer_id == customer_id,
            Payment.status == "cleared",
            Payment.payment_date.isnot(None),
            Invoice.issue_date.isnot(None),
        ).scalar() or 0
        avg_payment_time = round(float(avg_payment_time_days), 1)

        open_quotations = self.db.query(func.count(Quotation.id)).filter(
            Quotation.organization_id == organization_id,
            Quotation.customer_id == customer_id,
            Quotation.status.in_(["draft", "sent"]),
        ).scalar() or 0
        
        active_contracts = self.db.query(func.count(Contract.id)).filter(
            Contract.organization_id == organization_id,
            Contract.customer_id == customer_id,
            Contract.status == "active",
        ).scalar() or 0
        
        active_subscriptions = self.db.query(func.count(Subscription.id)).filter(
            Subscription.organization_id == organization_id,
            Subscription.customer_id == customer_id,
            Subscription.status == "active",
        ).scalar() or 0
        
        credit_notes = self.db.query(func.coalesce(func.sum(CreditNote.total_amount), 0)).filter(
            CreditNote.organization_id == organization_id,
            CreditNote.customer_id == customer_id,
        ).scalar() or 0
        
        refunds = self.db.query(func.coalesce(func.sum(Refund.amount), 0)).filter(
            Refund.organization_id == organization_id,
            Refund.customer_id == customer_id,
            Refund.status == "completed",
        ).scalar() or 0
        
        return {
            "total_revenue": total_revenue,
            "total_invoices": total_invoices,
            "outstanding_balance": outstanding,
            "total_paid": total_paid,
            "avg_invoice_value": avg_invoice,
            "avg_payment_time_days": avg_payment_time,
            "open_quotations": open_quotations,
            "active_contracts": active_contracts,
            "active_subscriptions": active_subscriptions,
            "credit_notes_total": float(credit_notes),
            "refunds_total": float(refunds),
        }

    # ── Activity / Audit ──────────────────────────────────────────────────

    def get_customer_activity(self, organization_id: int, customer_id: int, limit: int = 100) -> List[Any]:
        from app.modules.billing.models import BillingAuditLog
        return self.db.query(BillingAuditLog).filter(
            BillingAuditLog.organization_id == organization_id,
            BillingAuditLog.entity_type == "BillingCustomer",
            BillingAuditLog.entity_id == customer_id,
        ).order_by(BillingAuditLog.timestamp.desc()).limit(limit).all()

    # ── Export ────────────────────────────────────────────────────────────

    def export_customers(self, organization_id: int, fmt: str = "json") -> List[BillingCustomer]:
        return self.repo.list_all(organization_id, active_only=False)

    # ── KPI Dashboard ─────────────────────────────────────────────────────

    def get_kpi_data(
        self,
        organization_id: int,
        period: str = "all_time",
        date_from: Optional[str] = None,
        date_to: Optional[str] = None,
    ) -> Dict[str, Any]:
        from app.modules.billing.models import Invoice, Payment, Quotation, Subscription, Contract, CreditNote, Refund
        # created_at/updated_at are stored timezone-aware; keep `now` and the
        # parsed period bounds timezone-aware too so comparisons/filters against
        # those columns stay consistent instead of mixing naive and aware values.
        now = datetime.now(timezone.utc)
        period_end = None

        if date_from or date_to:
            # Custom range takes precedence over the named period bucket.
            try:
                period_start = datetime.fromisoformat(date_from).replace(tzinfo=timezone.utc) if date_from else None
            except ValueError:
                period_start = None
            try:
                period_end = datetime.fromisoformat(date_to).replace(tzinfo=timezone.utc) if date_to else None
            except ValueError:
                period_end = None
            if period_end:
                period_end = period_end.replace(hour=23, minute=59, second=59, microsecond=999999)
        # Compute period start based on filter
        elif period == "today":
            period_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        elif period == "last_7_days":
            period_start = now - timedelta(days=7)
        elif period == "last_30_days":
            period_start = now - timedelta(days=30)
        elif period == "this_month":
            period_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        elif period == "this_quarter":
            quarter_month = ((now.month - 1) // 3) * 3 + 1
            period_start = now.replace(month=quarter_month, day=1, hour=0, minute=0, second=0, microsecond=0)
        elif period == "this_year":
            period_start = now.replace(month=1, day=1, hour=0, minute=0, second=0, microsecond=0)
        else:
            period_start = None

        thirty_days_ago = now - timedelta(days=30)
        
        total = self.repo.count(organization_id, active_only=False)
        active = self.repo.count(organization_id, active_only=True)
        inactive = total - active
        
        new_customers_30d = self.db.query(func.count(self.repo.model.id)).filter(
            self.repo.model.organization_id == organization_id,
            self.repo.model.created_at >= thirty_days_ago,
        ).scalar() or 0
        
        customers_with_outstanding = self.db.query(func.count(func.distinct(Invoice.customer_id))).filter(
            Invoice.organization_id == organization_id,
            Invoice.status.in_(["sent", "overdue", "partially_paid"]),
            Invoice.balance_due > 0,
        ).scalar() or 0
        
        customers_over_credit_limit = self.db.query(func.count(self.repo.model.id)).filter(
            self.repo.model.organization_id == organization_id,
            self.repo.model.credit_limit > 0,
            self.repo.model.outstanding_balance > self.repo.model.credit_limit,
        ).scalar() or 0
        
        total_revenue = float(self.db.query(func.coalesce(func.sum(Payment.amount), 0)).filter(
            Payment.organization_id == organization_id,
            Payment.status == "cleared",
        ).scalar() or 0)

        # Period-filtered revenue
        revenue_period_filter = [Payment.organization_id == organization_id, Payment.status == "cleared"]
        if period_start:
            revenue_period_filter.append(Payment.payment_date >= period_start)
        if period_end:
            revenue_period_filter.append(Payment.payment_date <= period_end)
        period_revenue = float(self.db.query(func.coalesce(func.sum(Payment.amount), 0)).filter(
            *revenue_period_filter
        ).scalar() or 0)
        
        total_customers_count = max(total, 1)
        avg_revenue_per_customer = round(total_revenue / total_customers_count, 2)
        
        outstanding = float(self.db.query(func.coalesce(func.sum(Invoice.total_amount - Invoice.paid_amount), 0)).filter(
            Invoice.organization_id == organization_id,
            Invoice.status.in_(["sent", "overdue", "partially_paid"]),
        ).scalar() or 0)
        
        paid_invoices = self.db.query(func.count(Invoice.id)).filter(
            Invoice.organization_id == organization_id,
            Invoice.status == "paid",
        ).scalar() or 0
        
        total_invoices = self.db.query(func.count(Invoice.id)).filter(
            Invoice.organization_id == organization_id,
        ).scalar() or 0
        
        avg_invoice_value = round(total_revenue / max(total_invoices, 1), 2)

        # Period-filtered invoice counts
        invoice_period_filter = [Invoice.organization_id == organization_id]
        if period_start:
            invoice_period_filter.append(Invoice.created_at >= period_start)
        if period_end:
            invoice_period_filter.append(Invoice.created_at <= period_end)
        period_total_invoices = self.db.query(func.count(Invoice.id)).filter(
            *invoice_period_filter
        ).scalar() or 0
        period_paid_invoices = self.db.query(func.count(Invoice.id)).filter(
            *invoice_period_filter, Invoice.status == "paid"
        ).scalar() or 0
        period_avg_invoice_value = round(period_revenue / max(period_paid_invoices, 1), 2)

        # Period-filtered new customers
        new_customers_filter = [
            self.repo.model.organization_id == organization_id,
            self.repo.model.created_at >= (period_start or thirty_days_ago),
        ]
        if period_end:
            new_customers_filter.append(self.repo.model.created_at <= period_end)
        period_new_customers = self.db.query(func.count(self.repo.model.id)).filter(
            *new_customers_filter
        ).scalar() or 0
        
        open_quotations = self.db.query(func.count(Quotation.id)).filter(
            Quotation.organization_id == organization_id,
            Quotation.status.in_(["draft", "sent"]),
        ).scalar() or 0
        
        active_contracts = self.db.query(func.count(Contract.id)).filter(
            Contract.organization_id == organization_id,
            Contract.status == "active",
        ).scalar() or 0
        
        active_subscriptions = self.db.query(func.count(Subscription.id)).filter(
            Subscription.organization_id == organization_id,
            Subscription.status == "active",
        ).scalar() or 0
        
        credit_notes_total = float(self.db.query(func.coalesce(func.sum(CreditNote.total_amount), 0)).filter(
            CreditNote.organization_id == organization_id,
            CreditNote.status == "issued",
        ).scalar() or 0)
        
        refunds_total = float(self.db.query(func.coalesce(func.sum(Refund.amount), 0)).filter(
            Refund.organization_id == organization_id,
            Refund.status == "completed",
        ).scalar() or 0)
        
        revenue_by_customer = self.db.query(
            Invoice.customer_id,
            func.coalesce(func.sum(Invoice.total_amount), 0).label("revenue"),
        ).filter(
            Invoice.organization_id == organization_id,
            Invoice.status == "paid",
        ).group_by(Invoice.customer_id).order_by(
            func.coalesce(func.sum(Invoice.total_amount), 0).desc()
        ).limit(10).all()
        
        # FIX (Issue 1): outstanding_by_customer must use the SAME aggregation
        # as the org aggregate (status filter + is_active + currency conversion)
        # so the sum of per-customer outstanding always equals the dashboard
        # aggregate. The previous query summed raw balance_due WITHOUT currency
        # conversion and WITHOUT the is_active filter — so per-customer figures
        # could never sum to the org-wide converted aggregate.
        from app.modules.billing.services.dashboard_service import BillingDashboardService
        obc_svc = BillingDashboardService(self.db)
        outstanding_by_customer = obc_svc.get_outstanding_by_customer(organization_id)
        
        from app.modules.billing.models import PaymentAllocation
        avg_collection_days = self.db.query(
            func.coalesce(func.avg(Payment.payment_date - Invoice.issue_date), 0)
        ).select_from(PaymentAllocation).join(
            Payment, PaymentAllocation.payment_id == Payment.id
        ).join(
            Invoice, PaymentAllocation.invoice_id == Invoice.id
        ).filter(
            Payment.organization_id == organization_id,
            Payment.status == "cleared",
            Payment.payment_date.isnot(None),
            Invoice.issue_date.isnot(None),
        ).scalar() or 0
        
        return {
            "total_customers": total,
            "active_customers": active,
            "inactive_customers": inactive,
            "new_customers_30d": new_customers_30d,
            "customers_with_outstanding_balance": customers_with_outstanding,
            "customers_over_credit_limit": customers_over_credit_limit,
            "total_revenue": total_revenue,
            "period_revenue": period_revenue,
            "avg_revenue_per_customer": avg_revenue_per_customer,
            "avg_collection_time_days": round(float(avg_collection_days), 1),
            "outstanding_balance": outstanding,
            "credit_utilization": round((outstanding / total_revenue * 100) if total_revenue else 0, 2),
            "avg_invoice_value": avg_invoice_value,
            "total_invoices": total_invoices,
            "paid_invoices": paid_invoices,
            "open_quotations": open_quotations,
            "active_contracts": active_contracts,
            "active_subscriptions": active_subscriptions,
            "credit_notes_total": credit_notes_total,
            "refunds_total": refunds_total,
            "period_total_invoices": period_total_invoices,
            "period_paid_invoices": period_paid_invoices,
            "period_avg_invoice_value": period_avg_invoice_value,
            "period_new_customers": period_new_customers,
            "revenue_by_customer": [
                {"customer_id": r[0], "revenue": float(r[1])} for r in revenue_by_customer
            ],
            "outstanding_by_customer": [
                {"customer_id": r["customer_id"], "outstanding": float(r["outstanding"])}
                for r in outstanding_by_customer
            ],
        }

    # ── Credit Balance ────────────────────────────────────────────────────

    def adjust_credit_balance(
        self, customer_id: int, organization_id: int, amount: Decimal,
        adj_type: str, reason: str, updated_by: int,
    ) -> Dict[str, Any]:
        customer = self.repo.get_by_id(customer_id, organization_id)
        prev = Decimal(str(customer.credit_balance or 0))
        adj = Decimal(str(amount))
        if adj_type == "increase":
            customer.credit_balance = prev + adj
        elif adj_type == "decrease":
            new_val = prev - adj
            if new_val < 0:
                raise BadRequestException("Credit balance cannot be negative")
            customer.credit_balance = new_val
        else:
            if adj < 0:
                raise BadRequestException("Adjusted balance cannot be negative")
            customer.credit_balance = adj
        safe_commit_and_refresh(self.db, customer)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "BillingCustomer", customer_id)
        return {
            "customer_id": customer_id,
            "previous_balance": float(prev),
            "new_balance": float(customer.credit_balance or 0),
            "adjustment": float(adj),
            "type": adj_type,
            "message": f"Credit balance {adj_type} of {adj} completed",
        }

    # ── Customer Documents ────────────────────────────────────────────────

    def list_documents(self, organization_id: int, customer_id: int) -> List[Any]:
        from app.modules.billing.repositories.document import CustomerDocumentRepository
        repo = CustomerDocumentRepository(self.db)
        self.repo.get_by_id(customer_id, organization_id)
        return repo.list_by_customer(organization_id, customer_id)

    def add_document(self, organization_id: int, customer_id: int, uploaded_by: int, **data: Any) -> Any:
        from app.modules.billing.repositories.document import CustomerDocumentRepository
        repo = CustomerDocumentRepository(self.db)
        self.repo.get_by_id(customer_id, organization_id)
        doc = repo.create(organization_id, customer_id=customer_id, uploaded_by=uploaded_by, **data)
        self.audit.log(organization_id, uploaded_by, BillingAuditAction.CREATE, "CustomerDocument", doc.id)
        return doc

    def delete_document(self, document_id: int, customer_id: int, organization_id: int) -> None:
        from app.modules.billing.repositories.document import CustomerDocumentRepository
        repo = CustomerDocumentRepository(self.db)
        self.repo.get_by_id(customer_id, organization_id)
        repo.hard_delete(document_id, organization_id)

    # ── Customer Notes ────────────────────────────────────────────────────

    def list_notes(self, organization_id: int, customer_id: int) -> List[Any]:
        from app.modules.billing.repositories.notes import CustomerNoteRepository
        repo = CustomerNoteRepository(self.db)
        self.repo.get_by_id(customer_id, organization_id)
        return repo.list_by_customer(organization_id, customer_id)

    def add_note(self, organization_id: int, customer_id: int, created_by: int, **data: Any) -> Any:
        from app.modules.billing.repositories.notes import CustomerNoteRepository
        repo = CustomerNoteRepository(self.db)
        self.repo.get_by_id(customer_id, organization_id)
        note = repo.create(organization_id, customer_id=customer_id, created_by=created_by, **data)
        self.audit.log(organization_id, created_by, BillingAuditAction.CREATE, "CustomerNote", note.id)
        return note

    def update_note(self, note_id: int, customer_id: int, organization_id: int, updated_by: int, **data: Any) -> Any:
        from app.modules.billing.repositories.notes import CustomerNoteRepository
        repo = CustomerNoteRepository(self.db)
        note = repo.get_by_id(note_id, organization_id)
        for field, value in data.items():
            if hasattr(note, field) and value is not None:
                setattr(note, field, value)
        note.updated_by = updated_by
        safe_commit_and_refresh(self.db, note)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "CustomerNote", note_id)
        return note

    def delete_note(self, note_id: int, customer_id: int, organization_id: int) -> None:
        from app.modules.billing.repositories.notes import CustomerNoteRepository
        repo = CustomerNoteRepository(self.db)
        repo.hard_delete(note_id, organization_id)

    # ── Customer Statement ────────────────────────────────────────────────

    def generate_statement(
        self, customer_id: int, organization_id: int,
        date_from: Optional[str] = None, date_to: Optional[str] = None,
    ) -> Dict[str, Any]:
        from app.modules.billing.models import Invoice, PaymentAllocation, CreditNote
        customer = self.repo.get_by_id(customer_id, organization_id)
        invoices = self.db.query(Invoice).filter(
            Invoice.organization_id == organization_id,
            Invoice.customer_id == customer_id,
            Invoice.is_active == True,
        ).order_by(Invoice.issue_date.asc()).all()

        credit_notes = self.db.query(CreditNote).filter(
            CreditNote.organization_id == organization_id,
            CreditNote.customer_id == customer_id,
            CreditNote.status == "issued",
        ).order_by(CreditNote.issue_date.asc()).all()

        period_invoices = []
        total_invoiced = Decimal("0")
        total_paid = Decimal("0")
        total_credited = Decimal("0")

        for inv in invoices:
            inv_allocations = self.db.query(PaymentAllocation).filter(
                PaymentAllocation.invoice_id == inv.id,
                PaymentAllocation.organization_id == organization_id,
            ).all()
            inv_paid = sum(Decimal(str(a.amount)) for a in inv_allocations)
            total_invoiced += inv.total_amount
            total_paid += inv_paid
            period_invoices.append({
                "invoice_id": inv.id,
                "invoice_number": inv.invoice_number,
                "issue_date": inv.issue_date.isoformat(),
                "due_date": inv.due_date.isoformat() if inv.due_date else None,
                "total_amount": float(inv.total_amount),
                "paid_amount": float(inv_paid),
                "balance_due": float(inv.balance_due),
                "status": inv.status.value,
            })

        for cn in credit_notes:
            total_credited += cn.total_amount

        closing_balance = float(
            sum(i.balance_due for i in invoices if i.status not in ("paid", "cancelled", "refunded"))
        )

        return {
            "customer_id": customer_id,
            "customer_name": customer.display_name or customer.company_name,
            "customer_code": customer.customer_code,
            "currency": customer.currency or self._resolve_org_currency(organization_id),
            "date_from": date_from,
            "date_to": date_to,
            "opening_balance": float(customer.outstanding_balance or 0),
            "closing_balance": closing_balance,
            "total_invoiced": float(total_invoiced),
            "total_paid": float(total_paid),
            "total_credited": float(total_credited),
            "invoices": period_invoices,
        }

    # ── Import ────────────────────────────────────────────────────────────

    def import_customers(self, organization_id: int, created_by: int, items: List[Dict[str, Any]]) -> Dict[str, Any]:
        from sqlalchemy.exc import IntegrityError
        import csv, io, json
        
        parsed_items = []
        for item in items:
            if isinstance(item, str):
                try:
                    item = json.loads(item)
                except (json.JSONDecodeError, TypeError):
                    skipped = 1
                    return {"success": False, "imported": 0, "skipped": 1, "errors": [f"Invalid JSON in import: {item[:100]}"]}
            if isinstance(item, dict):
                parsed_items.append(item)
            elif hasattr(item, "read"):
                content = item.read()
                if isinstance(content, bytes):
                    content = content.decode("utf-8-sig")
                try:
                    reader = csv.DictReader(io.StringIO(content))
                    for row in reader:
                        parsed_items.append({k.strip(): v.strip() for k, v in row.items() if k and v})
                except Exception:
                    try:
                        parsed_items = json.loads(content)
                        if isinstance(parsed_items, dict):
                            parsed_items = [parsed_items]
                    except (json.JSONDecodeError, TypeError):
                        pass
        
        imported = 0
        skipped = 0
        errors = []
        seen_codes = set()
        
        for idx, item in enumerate(parsed_items):
            try:
                data = filter_allowed(item, CUSTOMER_ALLOWED_FIELDS)
                if not data.get("customer_code") or not data.get("company_name"):
                    skipped += 1
                    errors.append(f"Row {idx + 1}: Missing customer_code or company_name")
                    continue
                code = data["customer_code"]
                if code in seen_codes:
                    skipped += 1
                    errors.append(f"Row {idx + 1}: Duplicate customer_code in import: {code}")
                    continue
                existing = self.repo.get_first(organization_id, customer_code=code)
                if existing:
                    skipped += 1
                    errors.append(f"Row {idx + 1}: Duplicate customer_code: {code}")
                    continue
                if data.get("email"):
                    email_exists = self.repo.get_first(organization_id, email=data["email"])
                    if email_exists:
                        skipped += 1
                        errors.append(f"Row {idx + 1}: Duplicate email: {data['email']}")
                        continue
                if not data.get("display_name"):
                    data["display_name"] = data["company_name"]
                if not data.get("currency"):
                    from app.modules.billing.repositories.settings import BillingConfigurationRepository
                    cfg_repo = BillingConfigurationRepository(self.db)
                    config = cfg_repo.get_by_organization(organization_id)
                    data["currency"] = config.base_currency.value if config and config.base_currency else "USD"
                seen_codes.add(code)
                self.repo.create(organization_id, **data)
                imported += 1
            except (IntegrityError, ValueError, TypeError, AlreadyExistsException) as e:
                self.db.rollback()
                skipped += 1
                errors.append(str(e)[:200])
                logger.warning(f"[BILLING] Import row {idx + 1} skipped: {e}")
            except Exception as e:
                self.db.rollback()
                skipped += 1
                errors.append(f"Row {idx + 1}: {str(e)[:200]}")
                logger.error(f"[BILLING] Import unexpected error row {idx + 1}: {e}", exc_info=True)
        if imported:
            self.audit.log(organization_id, created_by, BillingAuditAction.CREATE, "BillingCustomer", 0)
        return {"success": len(errors) == 0, "imported": imported, "skipped": skipped, "errors": errors}
