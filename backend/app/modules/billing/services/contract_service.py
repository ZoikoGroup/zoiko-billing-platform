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
    Contract,
    ContractItem,
    ContractStatus,
    Invoice,
    InvoiceStatus,
    PriceSource,
    Product,
    Quotation,
    QuoteStatus,
)
from app.modules.billing.services.price_resolver import PriceResolver
from app.modules.billing.repositories.sales import ContractRepository
from app.modules.billing.services.audit_service import BillingAuditService
from app.modules.billing.services.base import safe_commit_and_refresh
from app.modules.billing.services.customer_service import CustomerService
from app.modules.billing.services.invoice_service import InvoiceService
from app.modules.billing.services.settings_service import BillingConfigurationService
from app.modules.billing.services.quote_service import QuoteService as QuotationService
from app.modules.billing.services.calculation_service import CalculationService
from app.modules.billing.utils.currency_utils import round_money
from app.modules.billing.services.tax_service import TaxService
from app.modules.billing.services.base import filter_allowed
from app.services.email_service import send_contract_activated_email, send_contract_renewed_email

logger = logging.getLogger("zoiko")


CONTRACT_ITEM_ALLOWED_FIELDS = {
    "product_id", "description", "quantity", "unit_price",
    "discount_percentage", "discount_amount", "tax_percentage",
    "tax_amount", "total_amount", "is_tax_inclusive",
    "pricing_plan_id", "price_source", "base_price", "resolved_price",
    "resolved_price_type",
}


class ContractService:
    def __init__(self, db: Session):
        self.db = db
        self.repo = ContractRepository(db)
        self.customer_service = CustomerService(db)
        self.quote_service = QuotationService(db)
        self.invoice_service = InvoiceService(db)
        self.audit = BillingAuditService(db)
        self.config_service = BillingConfigurationService(db)
        self.tax_service = TaxService(db)

    def create_contract(
        self, organization_id: int, created_by: int, customer_id: int,
        contract_number: str, **data: Any,
    ) -> Contract:
        self.customer_service.get_customer(customer_id, organization_id)
        if self.repo.exists(organization_id, contract_number=contract_number):
            raise AlreadyExistsException("Contract", "contract_number")
        if "currency" not in data or not data.get("currency"):
            customer = self.customer_service.get_customer(customer_id, organization_id)
            data["currency"] = customer.currency or self.config_service.get_default_currency(organization_id)
        contract = self.repo.create(
            organization_id, customer_id=customer_id,
            contract_number=contract_number, **data,
        )
        self.audit.log(organization_id, created_by, BillingAuditAction.CREATE, "Contract", contract.id, new_values=data)
        return contract

    def update_contract(self, contract_id: int, organization_id: int, updated_by: int, **data: Any) -> Contract:
        contract = self.repo.get_by_id(contract_id, organization_id)
        if contract.status not in (ContractStatus.DRAFT, ContractStatus.ACTIVE):
            raise BadRequestException("Contract cannot be modified in its current status")
        if data.get("contract_number") and data["contract_number"] != contract.contract_number:
            if self.repo.exists(organization_id, contract_number=data["contract_number"]):
                raise AlreadyExistsException("Contract", "contract_number")
        updated = self.repo.update(contract_id, organization_id, **data)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "Contract", contract_id)
        return updated

    def get_contract(self, contract_id: int, organization_id: int) -> Contract:
        return self.repo.get_by_id(contract_id, organization_id)

    def get_contract_by_number(self, organization_id: int, number: str) -> Optional[Contract]:
        return self.repo.get_by_number(organization_id, number)

    def list_contracts(
        self, organization_id: int, page: int = 1, per_page: int = 20,
        search_term: Optional[str] = None, customer_id: Optional[int] = None,
        quotation_id: Optional[int] = None,
        status: Optional[str] = None, sort_by: str = "created_at",
        sort_order: str = "desc",
        date_from: Optional[str] = None, date_to: Optional[str] = None,
    ) -> Dict[str, Any]:
        return self.repo.list_paginated(
            organization_id=organization_id, page=page, per_page=per_page,
            sort_by=sort_by, sort_order=sort_order,
            search_term=search_term, customer_id=customer_id, status=status,
            quotation_id=quotation_id,
            date_from=date_from, date_to=date_to,
        )

    def list_active_contracts(self, organization_id: int) -> List[Contract]:
        return self.repo.list_active(organization_id)

    def list_expiring_contracts(self, organization_id: int, within_days: int = 30) -> List[Contract]:
        return self.repo.list_expiring(organization_id, within_days)

    def get_contract_summary(
        self, organization_id: int,
        search_term: Optional[str] = None, customer_id: Optional[int] = None,
        status: Optional[str] = None, date_from: Optional[str] = None, date_to: Optional[str] = None,
    ) -> Dict[str, Any]:
        query = self.db.query(Contract).filter(Contract.organization_id == organization_id, Contract.is_active == True)
        if customer_id:
            query = query.filter(Contract.customer_id == customer_id)
        if status:
            query = query.filter(Contract.status == status)
        if search_term:
            term = f"%{search_term}%"
            query = query.filter((Contract.contract_number.ilike(term)) | (Contract.contract_name.ilike(term)))
        if date_from:
            query = query.filter(Contract.created_at >= date_from)
        if date_to:
            query = query.filter(Contract.created_at <= date_to)

        contracts = query.all()
        today = date.today()
        cutoff_30d = today + timedelta(days=30)

        total = len(contracts)
        active_count = 0
        expiring_count = 0
        expired_count = 0
        draft_count = 0
        terminated_count = 0
        cancelled_count = 0
        total_value = Decimal("0")
        active_value = Decimal("0")
        mrr = Decimal("0")

        for c in contracts:
            val = Decimal(str(c.value or 0))
            total_value += val
            st = (c.status or "").lower()
            if st == "active":
                active_count += 1
                active_value += val
                if c.end_date and today <= c.end_date <= cutoff_30d:
                    expiring_count += 1
                period = (c.billing_period or "").lower()
                if period == "monthly":
                    mrr += val
                elif period == "quarterly":
                    mrr += val / Decimal("3")
                elif period == "semi_annual":
                    mrr += val / Decimal("6")
                elif period == "annual":
                    mrr += val / Decimal("12")
                else:
                    mrr += val / Decimal("12")
            elif st == "expired":
                expired_count += 1
            elif st == "draft":
                draft_count += 1
            elif st == "terminated":
                terminated_count += 1
            elif st == "cancelled":
                cancelled_count += 1

        arr = mrr * Decimal("12")
        return {
            "total": total,
            "active_count": active_count,
            "expiring_count": expiring_count,
            "expired_count": expired_count,
            "draft_count": draft_count,
            "terminated_count": terminated_count,
            "cancelled_count": cancelled_count,
            "total_value": float(round_money(total_value)),
            "active_value": float(round_money(active_value)),
            "mrr": float(round_money(mrr)),
            "arr": float(round_money(arr)),
        }

    def activate_contract(self, contract_id: int, organization_id: int, updated_by: int) -> Contract:
        contract = self.repo.get_by_id(contract_id, organization_id)
        if contract.status != ContractStatus.DRAFT:
            raise BadRequestException("Only draft contracts can be activated")
        contract.status = ContractStatus.ACTIVE
        contract.start_date = date.today()
        safe_commit_and_refresh(self.db, contract)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "Contract", contract_id)
        email_sent_to = None
        email_delivered = False
        try:
            customer = self.customer_service.get_customer(contract.customer_id, organization_id)
            if customer and customer.email:
                email_sent_to = customer.email
                email_delivered = send_contract_activated_email(
                    email=customer.email,
                    customer_name=customer.display_name or customer.company_name,
                    contract_number=contract.contract_number,
                    start_date=str(contract.start_date),
                    end_date=str(contract.end_date) if contract.end_date else "N/A",
                    total_amount=str(contract.value),
                    currency=contract.currency or "USD",
                    organization_id=organization_id,
                    db=self.db,
                )
        except Exception as e:
            logger.warning("Failed to send contract activated email for contract %d: %s", contract_id, e)
        self.audit.log(
            organization_id, updated_by, BillingAuditAction.SEND, "Contract", contract_id,
            new_values={"email_sent_to": email_sent_to, "email_delivered": email_delivered},
        )
        return contract

    def terminate_contract(self, contract_id: int, organization_id: int, updated_by: int, reason: Optional[str] = None) -> Contract:
        contract = self.repo.get_by_id(contract_id, organization_id)
        if contract.status != ContractStatus.ACTIVE:
            raise BadRequestException("Only active contracts can be terminated")
        contract.status = ContractStatus.TERMINATED
        contract.end_date = date.today()
        contract.terminated_reason = reason
        safe_commit_and_refresh(self.db, contract)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "Contract", contract_id)
        return contract

    def renew_contract(self, contract_id: int, organization_id: int, updated_by: int, new_end_date: Optional[date] = None) -> Contract:
        contract = self.repo.get_by_id(contract_id, organization_id)
        if contract.status != ContractStatus.ACTIVE and contract.status != ContractStatus.EXPIRED:
            raise BadRequestException("Contract cannot be renewed")
        if contract.auto_renew and contract.renewal_term_days:
            base = contract.end_date if contract.status == ContractStatus.ACTIVE and contract.end_date else date.today()
            contract.end_date = base + timedelta(days=contract.renewal_term_days)
        elif new_end_date:
            if new_end_date <= date.today():
                raise BadRequestException("New end date must be in the future")
            if contract.end_date and new_end_date <= contract.end_date:
                raise BadRequestException("New end date must be later than the current contract end date")
            contract.end_date = new_end_date
        else:
            raise BadRequestException("No renewal terms configured and no end date provided")
        contract.status = ContractStatus.ACTIVE
        safe_commit_and_refresh(self.db, contract)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "Contract", contract_id)
        email_sent_to = None
        email_delivered = False
        try:
            customer = self.customer_service.get_customer(contract.customer_id, organization_id)
            if customer and customer.email:
                email_sent_to = customer.email
                email_delivered = send_contract_renewed_email(
                    email=customer.email,
                    customer_name=customer.display_name or customer.company_name,
                    contract_number=contract.contract_number,
                    new_end_date=str(contract.end_date),
                    total_amount=str(contract.value),
                    currency=contract.currency or "USD",
                    organization_id=organization_id,
                    db=self.db,
                )
        except Exception as e:
            logger.warning("Failed to send contract renewed email for contract %d: %s", contract_id, e)
        self.audit.log(
            organization_id, updated_by, BillingAuditAction.SEND, "Contract", contract_id,
            new_values={"email_sent_to": email_sent_to, "email_delivered": email_delivered},
        )
        return contract

    def cancel_contract(self, contract_id: int, organization_id: int, updated_by: int) -> Contract:
        contract = self.repo.get_by_id(contract_id, organization_id)
        if contract.status in (ContractStatus.CANCELLED, ContractStatus.TERMINATED):
            raise BadRequestException("Contract is already ended")
        contract.status = ContractStatus.CANCELLED
        safe_commit_and_refresh(self.db, contract)
        self.audit.log(organization_id, updated_by, BillingAuditAction.CANCEL, "Contract", contract_id)
        return contract

    def soft_delete_contract(self, contract_id: int, organization_id: int, deleted_by: int) -> None:
        contract = self.repo.get_by_id(contract_id, organization_id)
        if contract.status == ContractStatus.ACTIVE:
            raise BadRequestException("Active contracts cannot be deleted. Cancel or terminate first.")
        self.repo.soft_delete(contract_id, organization_id)
        self.audit.log(organization_id, deleted_by, BillingAuditAction.DELETE, "Contract", contract_id)

    # ── Contract Items ──────────────────────────────────────────────

    def set_contract_items(self, contract_id: int, organization_id: int, items_data: List[Dict[str, Any]]) -> List[ContractItem]:
        contract = self.repo.get_by_id(contract_id, organization_id)
        if contract.status not in (ContractStatus.DRAFT, ContractStatus.ACTIVE):
            raise BadRequestException("Cannot modify items on a contract in its current status")

        self.db.query(ContractItem).filter(
            ContractItem.contract_id == contract_id,
            ContractItem.organization_id == organization_id,
        ).delete()
        self.db.flush()

        created_items = []
        grand_total = Decimal("0")

        for idx, item_data in enumerate(items_data):
            filtered = filter_allowed(item_data, CONTRACT_ITEM_ALLOWED_FIELDS)
            product_id = filtered.get("product_id")
            if product_id is not None:
                price_source = filtered.get("price_source")
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
                        filtered["base_price"] = Decimal(str(product.default_price or 0))
                    filtered["resolved_price"] = Decimal(str(filtered.get("unit_price", 0)))
                    filtered["pricing_plan_id"] = None
                else:
                    resolver = PriceResolver(self.db)
                    result = resolver.resolve(
                        organization_id=organization_id,
                        product_id=product_id,
                        pricing_plan_id=filtered.get("pricing_plan_id"),
                        quantity=Decimal(str(filtered.get("quantity", 1))),
                    )
                    filtered["base_price"] = result.base_price
                    filtered["resolved_price"] = result.resolved_price
                    filtered["pricing_plan_id"] = result.pricing_plan_id
                    filtered["price_source"] = result.price_source
                    filtered["unit_price"] = result.resolved_price
                    filtered["resolved_price_type"] = result.resolved_price_type
            qty = Decimal(str(filtered.get("quantity", 1)))
            price = Decimal(str(filtered.get("unit_price", 0)))
            disc_pct = Decimal(str(filtered.get("discount_percentage", 0)))
            calc = CalculationService.calculate_line_item(
                quantity=qty,
                unit_price=price,
                discount_percentage=disc_pct,
                tax_percentage=Decimal(str(filtered.get("tax_percentage", 0))),
                price_semantics=filtered.get("resolved_price_type") or "unit",
            )
            total_line = round_money(calc["converted_line_total"], contract.currency)
            item_discount = round_money(calc["converted_discount"], contract.currency)
            item_tax = round_money(calc["converted_tax_amount"], contract.currency)

            filtered["discount_amount"] = item_discount
            filtered["tax_amount"] = item_tax
            filtered["total_amount"] = total_line

            item = ContractItem(
                organization_id=organization_id,
                contract_id=contract_id,
                line_number=idx + 1,
                **filtered,
            )
            self.db.add(item)
            created_items.append(item)
            grand_total += total_line

        self.db.flush()

        contract.value = round_money(grand_total, contract.currency)

        self.audit.log(organization_id, None, BillingAuditAction.UPDATE, "Contract", contract_id)
        return created_items

    def get_contract_items(self, contract_id: int, organization_id: int) -> List[ContractItem]:
        contract = self.repo.get_by_id(contract_id, organization_id)
        return self.db.query(ContractItem).filter(
            ContractItem.contract_id == contract_id,
            ContractItem.organization_id == organization_id,
        ).order_by(ContractItem.line_number).all()

    # ── Quotation → Contract Conversion ──────────────────────────────

    def convert_quotation_to_contract(
        self, organization_id: int, created_by: int,
        quotation_id: int, **data: Any,
    ) -> Contract:
        quotation = self.quote_service.get_quote(quotation_id, organization_id)
        if quotation.status != QuoteStatus.ACCEPTED:
            raise BadRequestException("Only accepted quotations can be converted to contracts")

        existing = self.db.query(Contract).filter(
            Contract.organization_id == organization_id,
            Contract.quotation_id == quotation_id,
            Contract.deleted_at.is_(None),
        ).first()
        if existing:
            raise AlreadyExistsException("Contract", f"already exists for quotation {quotation_id}")

        contract_number = data.get("contract_number") or f"CON-{quotation.quote_number}"
        contract_name = data.get("contract_name") or f"Contract from {quotation.quote_number}"
        start_date = data.get("start_date") or date.today()
        end_date = data.get("end_date")
        notes = data.get("notes") or quotation.notes

        if self.repo.exists(organization_id, contract_number=contract_number):
            contract_number = f"{contract_number}-{int(date.today().strftime('%Y%m%d'))}"

        contract = self.repo.create(
            organization_id=organization_id,
            customer_id=quotation.customer_id,
            quotation_id=quotation_id,
            contract_number=contract_number,
            contract_name=contract_name,
            status=ContractStatus.DRAFT,
            start_date=start_date,
            end_date=end_date,
            value=quotation.total_amount or Decimal("0"),
            currency=quotation.currency or self.config_service.get_default_currency(organization_id),
            notes=notes,
            created_by=created_by,
        )

        items = self.quote_service.list_items(quotation_id, organization_id)
        if items:
            ci_data = []
            for qi in items:
                ci_data.append({
                    "product_id": qi.product_id,
                    "description": qi.description,
                    "quantity": qi.quantity,
                    "unit_price": qi.unit_price,
                    "discount_percentage": qi.discount_percentage,
                    "tax_percentage": qi.tax_percentage,
                    "is_tax_inclusive": qi.is_tax_inclusive,
                    "pricing_plan_id": getattr(qi, "pricing_plan_id", None),
                    "price_source": getattr(qi, "price_source", None),
                    "base_price": getattr(qi, "base_price", None),
                    "resolved_price": getattr(qi, "resolved_price", None),
                })
            self.set_contract_items(contract.id, organization_id, ci_data)

        self.audit.log(organization_id, created_by, BillingAuditAction.CREATE, "Contract", contract.id)
        self.db.refresh(contract)
        return contract

    # ── Contract → Invoice ──────────────────────────────────────────

    def generate_invoice_from_contract(
        self, contract_id: int, organization_id: int, created_by: int,
        invoice_number: Optional[str] = None,
        issue_date: Optional[date] = None,
        due_date: Optional[date] = None,
        resolve_tax: bool = False,
    ) -> Invoice:
        contract = self.repo.get_by_id(contract_id, organization_id)
        if contract.status != ContractStatus.ACTIVE:
            raise BadRequestException("Only active contracts can generate invoices")

        existing = (
            self.db.query(Invoice)
            .filter(
                Invoice.contract_id == contract_id,
                Invoice.organization_id == organization_id,
                Invoice.status != InvoiceStatus.CANCELLED,
            )
            .first()
        )
        if existing:
            raise AlreadyExistsException(
                f"Contract {contract_id} already has invoice {existing.invoice_number} (status={existing.status.value})"
            )

        invoice_issue_date = issue_date or date.today()
        invoice_due_date = due_date or (invoice_issue_date + timedelta(days=30))

        items = self.get_contract_items(contract_id, organization_id)
        subtotal = Decimal("0")

        invoice_items_data = []
        for ci in items:
            subtotal += ci.quantity * ci.unit_price
            invoice_items_data.append({
                "product_id": ci.product_id,
                "description": ci.description,
                "quantity": ci.quantity,
                "unit_price": ci.unit_price,
                "discount_percentage": ci.discount_percentage or Decimal("0"),
                "tax_percentage": ci.tax_percentage or Decimal("0"),
                "is_tax_inclusive": ci.is_tax_inclusive or False,
                "pricing_plan_id": getattr(ci, "pricing_plan_id", None),
                "price_source": getattr(ci, "price_source", None),
                "base_price": getattr(ci, "base_price", None),
                "resolved_price": getattr(ci, "resolved_price", None),
            })

        # Optional server-side tax resolution
        if resolve_tax and subtotal > 0:
            resolved_taxes = self.tax_service.calculate_taxes(
                organization_id, subtotal,
                jurisdiction=contract.jurisdiction if hasattr(contract, 'jurisdiction') else None,
                currency_code=contract.currency,
            )
            if resolved_taxes:
                total_tax_pct = sum(Decimal(str(t.get("tax_percentage", 0))) for t in resolved_taxes)
                # A single resolved rate has an unambiguous source. When
                # calculate_taxes() legitimately combines more than one active
                # rate into total_tax_pct, no single TaxRate id would honestly
                # represent the combined line, so tax_rate_id is deliberately
                # left unset rather than picking one of them arbitrarily.
                resolved_tax_rate_id = resolved_taxes[0]["tax_rate_id"] if len(resolved_taxes) == 1 else None
                for item_data in invoice_items_data:
                    item_data["tax_percentage"] = total_tax_pct
                    item_data["tax_rate_id"] = resolved_tax_rate_id

        # Use the contract's invoice service to create invoice
        inv = self.invoice_service.create_invoice(
            organization_id=organization_id,
            created_by=created_by,
            customer_id=contract.customer_id,
            invoice_number=invoice_number or "auto",
            _skip_recalculate=True,
            contract_id=contract_id,
            issue_date=invoice_issue_date,
            due_date=invoice_due_date,
            currency=contract.currency or self.config_service.get_default_currency(organization_id),
        )

        from app.modules.billing.models import InvoiceItem

        for idx, idata in enumerate(invoice_items_data):
            qty = Decimal(str(idata["quantity"]))
            price = Decimal(str(idata["unit_price"]))
            disc_pct = Decimal(str(idata.get("discount_percentage", 0)))
            tax_pct = Decimal(str(idata.get("tax_percentage", 0)))
            calc = CalculationService.calculate_line_item(
                quantity=qty,
                unit_price=price,
                discount_percentage=disc_pct,
                tax_percentage=tax_pct,
                is_tax_inclusive=bool(idata.get("is_tax_inclusive", False)),
            )
            total_line = calc["converted_line_total"]

            ii = InvoiceItem(
                organization_id=organization_id,
                invoice_id=inv.id,
                line_number=idx + 1,
                product_id=idata.get("product_id"),
                description=idata["description"],
                quantity=qty,
                unit_price=calc["converted_unit_price"],
                discount_percentage=disc_pct,
                discount_amount=calc["converted_discount"],
                tax_percentage=tax_pct,
                tax_amount=calc["converted_tax_amount"],
                tax_rate_id=idata.get("tax_rate_id"),
                total=total_line,
                is_tax_inclusive=idata.get("is_tax_inclusive", False),
                pricing_plan_id=idata.get("pricing_plan_id"),
                price_source=idata.get("price_source"),
                base_price=idata.get("base_price"),
                resolved_price=idata.get("resolved_price"),
            )
            self.db.add(ii)
        self.db.flush()
        # Recalculate invoice totals now that items exist (was skipped during create)
        self.invoice_service.recalculate_invoice(inv.id, organization_id)
        self.audit.log(organization_id, created_by, BillingAuditAction.CREATE, "Invoice", inv.id)
        return inv

    def create_amendment(
        self, contract_id: int, organization_id: int, changed_by: int,
        amendment_date: date, effective_date: date, reason: Optional[str],
        previous_values: Optional[dict], new_values: Optional[dict]
    ) -> Any:
        contract = self.repo.get_by_id(contract_id, organization_id)
        if not contract:
            raise BadRequestException("Contract not found")
        
        from app.modules.billing.models import ContractAmendment
        existing_amendments = self.db.query(ContractAmendment).filter(
            ContractAmendment.contract_id == contract_id,
            ContractAmendment.organization_id == organization_id
        ).all()
        next_num = len(existing_amendments) + 1

        amendment = ContractAmendment(
            organization_id=organization_id,
            contract_id=contract_id,
            amendment_number=next_num,
            amendment_date=amendment_date,
            effective_date=effective_date,
            reason=reason,
            changed_by=changed_by,
            previous_values=previous_values or {},
            new_values=new_values or {}
        )
        self.db.add(amendment)

        contract.contract_version = (contract.contract_version or 1) + 1
        if new_values:
            for k, v in new_values.items():
                if hasattr(contract, k) and k not in ('id', 'organization_id', 'contract_number'):
                    if k in ('start_date', 'end_date', 'signed_at'):
                        if isinstance(v, str):
                            try:
                                v = date.fromisoformat(v)
                            except ValueError:
                                try:
                                    v = datetime.fromisoformat(v)
                                except ValueError:
                                    pass
                    setattr(contract, k, v)
        
        safe_commit_and_refresh(self.db, contract)
        self.db.refresh(amendment)
        self.audit.log(organization_id, changed_by, BillingAuditAction.UPDATE, "ContractAmendment", amendment.id)
        return amendment

    def list_amendments(self, contract_id: int, organization_id: int) -> List[Any]:
        from app.modules.billing.models import ContractAmendment
        return self.db.query(ContractAmendment).filter(
            ContractAmendment.contract_id == contract_id,
            ContractAmendment.organization_id == organization_id
        ).order_by(ContractAmendment.amendment_number.asc()).all()

