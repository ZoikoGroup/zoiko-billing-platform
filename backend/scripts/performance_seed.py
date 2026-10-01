"""
scripts/performance_seed.py
---------------------------
Deterministic, tenant-isolated, realistic-scale dataset generator for the
Phase 8 performance & load validation. Safe ONLY on a disposable PostgreSQL
(never production).

Usage:
    $env:BILLING_DATABASE_URL="postgresql+psycopg://billing@127.0.0.1:5433/zoiko_billing_scale"
    python -m scripts.performance_seed
"""

import random
import sys
import time
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import insert, select, text

from app.core.code_generation import generate_organization_code
from app.core.security import hash_password
from app.database import SessionLocal, initialize_database
from app.modules.auth.models import User, UserRole
from app.modules.organizations.models import Organization
from app.modules.billing.models import (
    BillingConfiguration, BillingSetting, BillingCustomer, CustomerContact,
    ProductCategory, Product, PricingPlan, SubscriptionPlan, Subscription,
    SubscriptionEvent, Invoice, InvoiceItem, InvoiceStatusHistory, Quotation,
    QuotationItem, Contract, ContractItem, Payment, PaymentAllocation,
    CreditNote, CreditNoteApplication, Refund, WriteOff, TaxRate,
    BillingAuditLog,
)

M2 = Decimal("0.01")
M4 = Decimal("0.0001")
END_TS = datetime(2026, 8, 31, tzinfo=timezone.utc)
END_DAY = date(2026, 8, 31)
ORG_NAME = "Zoiko PerfScale Org"
RNG_SEED = 20260831
ADMIN_PASSWORD = "PerfScale#2026"

CURRENCIES = [
    ("USD", 60, Decimal("1")), ("EUR", 10, Decimal("0.92")), ("GBP", 7, Decimal("0.79")),
    ("INR", 8, Decimal("83.2")), ("AED", 4, Decimal("3.67")), ("CAD", 3, Decimal("1.36")),
    ("AUD", 3, Decimal("1.52")), ("ZAR", 2, Decimal("18.2")), ("SGD", 2, Decimal("1.35")),
    ("NGN", 1, Decimal("1500")),
]
COUNTRIES = [("United States", 60), ("United Kingdom", 10), ("India", 8), ("Germany", 6),
             ("United Arab Emirates", 4), ("Canada", 3), ("Australia", 3), ("Singapore", 2),
             ("South Africa", 2), ("Nigeria", 1), ("Netherlands", 1)]

CUSTOMER_STATUS_W = [("active", 78), ("inactive", 12), ("suspended", 6), ("closed", 4)]
CUSTOMER_TYPE_W = [("business", 70), ("individual", 22), ("non_profit", 5), ("government", 3)]
QUOTE_STATUS_W = [("draft", 25), ("sent", 25), ("accepted", 20), ("rejected", 10), ("expired", 8), ("converted", 7), ("cancelled", 5)]
CONTRACT_STATUS_W = [("active", 55), ("expired", 20), ("draft", 10), ("terminated", 10), ("cancelled", 5)]
SUBS_STATUS_W = [("active", 65), ("cancelled", 15), ("past_due", 10), ("paused", 6), ("expired", 4)]
INVOICE_STATUS_W = [("draft", 10), ("sent", 20), ("paid", 40), ("partially_paid", 8), ("overdue", 12), ("cancelled", 6), ("refunded", 2), ("written_off", 2)]
PAYMENT_STATUS_W = [("cleared", 80), ("pending", 6), ("processing", 4), ("failed", 6), ("cancelled", 4)]
CREDIT_NOTE_STATUS_W = [("draft", 12), ("approved", 15), ("issued", 30), ("partially_applied", 15), ("fully_applied", 20), ("voided", 8)]
REFUND_STATUS_W = [("completed", 70), ("processing", 8), ("approved", 7), ("pending_approval", 6), ("failed", 4), ("rejected", 3), ("cancelled", 2)]
AUDIT_ACTIONS = ["create", "update", "send", "pay", "refund", "cancel", "approve", "void", "export", "write_off"]
AUDIT_ENTITIES = ["invoice", "customer", "payment", "subscription", "contract", "quotation", "credit_note", "refund", "product"]
PROD_TYPES_W = [("service", 45), ("good", 25), ("subscription", 20), ("usage", 5), ("retainer", 3), ("other", 2)]
PROD_PRICE_BUCKETS = {"service": (50, 5000), "good": (5, 2000), "subscription": (10, 500),
                      "usage": (0.5, 10), "retainer": (1000, 50000), "other": (10, 1000)}
PLAN_PERIOD_W = [("monthly", 70), ("quarterly", 15), ("annual", 10), ("one_time", 5)]
PLAN_CATEGORY_W = [("subscription", 55), ("usage", 20), ("retainer", 15), ("bundle", 10)]
INVOICE_TYPE_W = [("standard", 70), ("subscription", 20), ("usage", 8), ("credit", 1), ("debit", 1)]
STANDALONE_PAY_TYPE_W = [("manual", 40), ("deposit", 30), ("subscription_payment", 30)]
CN_TYPE_W = [("refund", 20), ("adjustment", 15), ("promotional", 10), ("cancellation", 15),
             ("goodwill", 10), ("partial_credit", 20), ("full_credit", 10)]
GATEWAYS = ["credit_card", "ach", "bank_transfer", "paypal", "check", "wire_transfer"]
REFUND_METHODS = ["bank_transfer", "card_refund", "upi", "cash", "cheque"]


def d2(value):
    return Decimal(str(value)).quantize(M2, rounding=ROUND_HALF_UP)


def d4(value):
    return Decimal(str(value)).quantize(M4, rounding=ROUND_HALF_UP)


def weighted_choice(rng, pairs):
    total = sum(w for _, w in pairs)
    r = rng.uniform(0, total)
    upto = 0
    for value, w in pairs:
        upto += w
        if r <= upto:
            return value
    return pairs[-1][0]


def random_offset_days(rng):
    buckets = [(0, 7, 3), (7, 30, 12), (30, 90, 25), (90, 365, 40), (365, 1800, 20)]
    total = sum(w for *_, w in buckets)
    r = rng.uniform(0, total)
    upto = 0
    for lo, hi, w in buckets:
        upto += w
        if r <= upto:
            return rng.randint(lo, hi)
    return rng.randint(90, 365)


def random_date(rng):
    return END_DAY - timedelta(days=random_offset_days(rng))


def random_time(rng):
    d = random_date(rng)
    return datetime.combine(d, datetime.min.time(), tzinfo=timezone.utc) + timedelta(seconds=rng.randint(0, 86399))


def pick_currency(rng):
    code = weighted_choice(rng, [(c, w) for c, w, _ in CURRENCIES])
    rate = next(r for c, w, r in CURRENCIES if c == code)
    return code, rate


def pick_country(rng):
    return weighted_choice(rng, COUNTRIES)


def line_item(rng):
    qty = Decimal(rng.randint(1, 5))
    unit = d4(rng.uniform(5, 2000))
    return {"quantity": qty, "unit_price": unit, "total_amount": d2(qty * unit)}


class Seeder:
    def __init__(self, db):
        self.db = db
        self.rng = random.Random(RNG_SEED)
        self.org_id = None
        self.user_ids = []
        self.customer_ids = []
        self.customer_currencies = []
        self.product_ids = []
        self.plan_ids = []
        self.pricing_ids = []
        self.quote_ids = []
        self.contract_ids = []
        self.sub_ids = []
        self.invoice_ids = []
        self.invoice_meta = []
        self.payment_ids = []
        self.refund_link = {}

    def bulk(self, model, rows, batch=2000):
        for i in range(0, len(rows), batch):
            self.db.execute(insert(model), rows[i:i + batch])
        self.db.commit()

    def fetch_ids(self, model, column):
        return list(self.db.execute(
            select(column).where(model.organization_id == self.org_id).order_by(column)
        ).scalars().all())

    def seed_organization(self):
        existing = self.db.query(Organization).filter(Organization.organization_name == ORG_NAME).first()
        if existing:
            print(f"ABORT: performance org already exists (id={existing.id}). Nothing to do.")
            sys.exit(0)
        code = generate_organization_code(ORG_NAME, self.db)
        org = Organization(organization_name=ORG_NAME, organization_code=code, display_name=ORG_NAME,
                           is_active=True, currency="USD", timezone="UTC", industry="Technology",
                           country="United States")
        self.db.add(org)
        self.db.flush()
        self.org_id = org.id
        from app.modules.commercial.service import CommercialAccountService
        CommercialAccountService(self.db).ensure_commercial_account(self.org_id)
        self.db.commit()
        print(f"Organization created id={self.org_id} code={code}")

    def seed_users(self):
        roles = [(UserRole.ORG_ADMIN, "Org"), (UserRole.BILLING_ADMIN, "Billing"),
                 (UserRole.BILLING_ADMIN, "BillingOps"), (UserRole.BILLING_ADMIN, "Revenue"),
                 (UserRole.FINANCE_APPROVER, "Finance"), (UserRole.AUDITOR, "Audit"),
                 (UserRole.BILLING_ADMIN, "Collections"), (UserRole.BILLING_ADMIN, "Sales")]
        for i, (role, first) in enumerate(roles):
            user = User(email=f"perf-{i + 1}@perfscale.zoiko.com",
                        hashed_password=hash_password(ADMIN_PASSWORD), role=role,
                        organization_id=self.org_id, first_name=first,
                        last_name=role.value.title(), phone="", is_active=True, is_verified=True)
            self.db.add(user)
            self.db.flush()
            self.user_ids.append(user.id)
        self.db.commit()
        print(f"Users created: {len(self.user_ids)}")

    def seed_configuration(self):
        rates = {"USD": 1.0, "EUR": 0.92, "GBP": 0.79, "INR": 83.2, "AED": 3.67,
                 "CAD": 1.36, "AUD": 1.52, "ZAR": 18.2, "SGD": 1.35, "NGN": 1500.0}
        now = datetime.now(timezone.utc)
        self.bulk(BillingConfiguration, [{
            "organization_id": self.org_id, "company_name": ORG_NAME,
            "billing_email": "billing@perfscale.zoiko.com", "default_currency": "USD",
            "base_currency": "USD", "supported_currencies": list(rates.keys()),
            "country": "United States", "fiscal_year_start": "01-01", "fiscal_year_end": "12-31",
            "invoice_prefix": "INV-", "quote_prefix": "QTE-", "credit_note_prefix": "CN-",
            "refund_prefix": "RF-", "write_off_prefix": "WO-", "auto_generate_invoice_number": True,
            "default_due_days": 30, "payment_term_options": ["net_30", "net_15", "net_7", "due_on_receipt", "net_60"],
            "supported_payment_methods": ["credit_card", "bank_transfer", "paypal", "ach"],
            "exchange_rate_provider": "manual", "exchange_rate_auto_update": False,
            "exchange_rate_auto_refresh": False, "exchange_rates": rates,
            "exchange_rate_base_currency": "USD", "exchange_rate_last_refreshed": now,
            "exchange_rate_usd": Decimal("1"), "exchange_rate_eur": Decimal("0.92"),
            "exchange_rate_gbp": Decimal("0.79"), "exchange_rate_inr": Decimal("83.2"),
            "exchange_rate_aed": Decimal("3.67"), "exchange_rate_updated_at": now,
            "tax_label": "VAT", "default_payment_terms": "net_30", "grace_period_days": 0,
            "rounding_method": "half_up", "rounding_precision": 2,
        }])
        self.bulk(BillingSetting, [{
            "organization_id": self.org_id, "default_currency": "USD", "fiscal_year_start": "01-01",
            "default_payment_terms": "net_30", "default_invoice_prefix": "INV-", "default_quote_prefix": "QTE-",
            "auto_generate_invoice_number": True, "auto_send_invoices": False, "auto_send_receipts": True,
            "auto_dunning": True, "payment_reminder_days_before": 3, "enable_revenue_recognition": False,
            "enable_multi_currency": True, "billing_email": "billing@perfscale.zoiko.com", "is_active": True,
        }])
        print("Billing configuration + settings seeded")

    def seed_tax_rates(self):
        laws = ["sales_tax", "vat", "gst"]
        rows = []
        for i in range(40):
            country = pick_country(self.rng)
            law = self.rng.choice(laws)
            rate = Decimal(self.rng.choice(["5", "7.5", "10", "12", "18", "20", "22"]))
            rows.append({
                "organization_id": self.org_id, "name": f"{law} {country} {i + 1}",
                "code": f"TAX-{i + 1:03d}", "jurisdiction": country, "rate": rate, "tax_type": law,
                "is_compound": False, "is_recoverable": True, "effective_from": date(2022, 1, 1),
                "effective_to": None, "applies_to": "both", "country_code": country[:2].upper(),
                "is_default": i == 0, "is_active": True, "priority": i % 5,
            })
        self.bulk(TaxRate, rows)
        print("Tax rates seeded: 40")

    def seed_catalog(self):
        cat_rows = [{"organization_id": self.org_id, "name": f"Category {i + 1}",
                     "code": f"CAT-{i + 1:03d}", "description": f"Product category {i + 1}",
                     "is_active": True, "sort_order": i} for i in range(60)]
        self.bulk(ProductCategory, cat_rows)
        cat_ids = self.fetch_ids(ProductCategory, ProductCategory.id)
        product_rows = []
        for i in range(5000):
            ptype = weighted_choice(self.rng, PROD_TYPES_W)
            lo, hi = PROD_PRICE_BUCKETS[ptype]
            unit = d2(self.rng.uniform(lo, hi))
            freq = {"service": "one_time", "good": "one_time", "subscription": "monthly",
                    "usage": "usage_based", "retainer": "monthly", "other": "one_time"}[ptype]
            product_rows.append({
                "organization_id": self.org_id, "category_id": self.rng.choice(cat_ids),
                "name": f"Perf Product {i + 1}", "code": f"SKU-{i + 1:05d}",
                "description": f"Performance catalogue item {i + 1}", "product_type": ptype,
                "unit_label": "unit", "currency": "USD", "default_price": unit,
                "cost_price": d2(unit * Decimal("0.4")), "tax_percentage": Decimal("0"),
                "tax_inclusive": False, "is_subscribable": ptype == "subscription",
                "is_usage_billable": ptype == "usage", "is_active": self.rng.uniform(0, 1) < 0.9,
                "billing_frequency": freq, "default_discount": Decimal("0"), "brand": "Perf",
            })
        self.bulk(Product, product_rows)
        self.product_ids = self.fetch_ids(Product, Product.id)
        print("Products seeded: 5000")

    def seed_plans(self):
        plan_rows = []
        for i in range(500):
            cat = weighted_choice(self.rng, PLAN_CATEGORY_W)
            period = weighted_choice(self.rng, PLAN_PERIOD_W)
            unit = {"subscription": d2(self.rng.uniform(10, 500)), "usage": d2(self.rng.uniform(0.5, 10)),
                    "retainer": d2(self.rng.uniform(1000, 50000)), "bundle": d2(self.rng.uniform(50, 3000))}[cat]
            plan_rows.append({
                "organization_id": self.org_id, "plan_code": f"PLAN-{i + 1:04d}",
                "plan_name": f"Perf Plan {i + 1}", "description": f"Subscription plan {i + 1}",
                "category": cat, "billing_period": period, "billing_cycles": 0, "pricing_model": "flat",
                "unit_price": d4(unit), "setup_fee": d2(self.rng.uniform(0, 100)),
                "trial_days": 0 if self.rng.uniform(0, 1) < 0.7 else 14,
                "is_public": self.rng.uniform(0, 1) < 0.8, "is_active": self.rng.uniform(0, 1) < 0.85,
                "sort_order": i,
            })
        self.bulk(SubscriptionPlan, plan_rows)
        self.plan_ids = self.fetch_ids(SubscriptionPlan, SubscriptionPlan.id)
        pricing_rows = []
        for i in range(500):
            pricing_rows.append({
                "organization_id": self.org_id,
                "product_id": self.product_ids[self.rng.randrange(len(self.product_ids))],
                "name": f"Pricing {i + 1}", "billing_period": weighted_choice(self.rng, PLAN_PERIOD_W),
                "billing_cycle_count": 0,
                "pricing_model": weighted_choice(self.rng, [("flat", 60), ("per_unit", 25), ("tiered", 10), ("volume", 5)]),
                "unit_price": d4(self.rng.uniform(5, 5000)), "flat_fee": d2(self.rng.uniform(0, 200)),
                "setup_fee": d2(self.rng.uniform(0, 50)), "min_quantity": 1, "max_quantity": None,
                "trial_days": 0, "is_active": self.rng.uniform(0, 1) < 0.85,
                "effective_from": date(2022, 1, 1) + timedelta(days=self.rng.randint(0, 1000)),
                "effective_to": None,
            })
        self.bulk(PricingPlan, pricing_rows)
        self.pricing_ids = self.fetch_ids(PricingPlan, PricingPlan.id)
        print("Subscription plans: 500, pricing plans: 500")

    def seed_customers(self):
        customer_rows = []
        contact_rows = []
        for i in range(10000):
            status = weighted_choice(self.rng, CUSTOMER_STATUS_W)
            ctype = weighted_choice(self.rng, CUSTOMER_TYPE_W)
            currency, _ = pick_currency(self.rng)
            country = pick_country(self.rng)
            self.customer_currencies.append(currency)
            email = f"perf-{i + 1:05d}@perfscale.io"
            phone = f"+1-555-{self.rng.randint(100, 999)}-{self.rng.randint(1000, 9999)}"
            customer_rows.append({
                "organization_id": self.org_id, "customer_code": f"CUS-{i + 1:05d}",
                "company_name": f"Perf Customer {i + 1}", "display_name": f"Perf Customer {i + 1}",
                "legal_name": f"Perf Customer {i + 1} LLC", "first_name": f"First{i}",
                "last_name": f"Last{i}", "email": email, "alternate_email": email,
                "mobile": phone, "phone": phone, "website": f"https://perf-customer-{i + 1}.example.com",
                "customer_type": ctype, "billing_address": f"{self.rng.randint(1, 999)} Market St",
                "shipping_address": f"{self.rng.randint(1, 999)} Market St", "billing_country": country,
                "shipping_country": country, "payment_terms": "net_30", "currency": currency,
                "credit_limit": d2(self.rng.uniform(1000, 100000)), "credit_days": 30,
                "outstanding_balance": Decimal("0"), "total_revenue": Decimal("0"), "total_invoices": 0,
                "total_payments": 0, "lifetime_value": Decimal("0"), "credit_balance": Decimal("0"),
                "status": status, "is_active": status == "active", "created_at": random_time(self.rng),
                "created_by": self.user_ids[0],
            })
            contact_rows.append({
                "organization_id": self.org_id, "customer_id": 0, "first_name": f"First{i}",
                "last_name": f"Last{i}", "email": email, "phone": phone, "job_title": "Manager",
                "department": "Finance", "is_primary": True, "is_active": True,
                "created_by": self.user_ids[0],
            })
        self.bulk(BillingCustomer, customer_rows, batch=2000)
        self.customer_ids = self.fetch_ids(BillingCustomer, BillingCustomer.id)
        for k, row in enumerate(contact_rows):
            row["customer_id"] = self.customer_ids[k]
        self.bulk(CustomerContact, contact_rows, batch=2000)
        print("Customers seeded: 10000 (+ contacts)")

    def seed_quotations(self):
        quote_rows = []
        item_rows = []
        n_cust = len(self.customer_ids)
        n_prod = len(self.product_ids)
        for i in range(10000):
            customer_id = self.customer_ids[i % n_cust]
            status = weighted_choice(self.rng, QUOTE_STATUS_W)
            created = random_time(self.rng)
            subtotal = Decimal("0")
            for line in range(1, self.rng.choice([1, 1, 2, 2, 3]) + 1):
                it = line_item(self.rng)
                subtotal += it["total_amount"]
                item_rows.append({
                    "_mi": i, "organization_id": self.org_id, "line_number": line,
                    "product_id": self.product_ids[self.rng.randrange(n_prod)] if self.rng.uniform(0, 1) < 0.9 else None,
                    "description": f"Quote line {line}", "quantity": it["quantity"], "unit_price": it["unit_price"],
                    "discount_percentage": Decimal("0"), "discount_amount": Decimal("0"),
                    "tax_percentage": Decimal("0"), "tax_amount": Decimal("0"),
                    "total_amount": it["total_amount"], "is_tax_inclusive": False,
                })
            subtotal = d2(subtotal)
            quote_rows.append({
                "organization_id": self.org_id, "customer_id": customer_id,
                "quote_number": f"QTE-{i + 1:07d}", "quote_version": 1, "status": status,
                "subject": f"Perf quote {i + 1}", "subtotal": subtotal, "discount_percentage": Decimal("0"),
                "discount_amount": Decimal("0"), "tax_amount": Decimal("0"), "total_amount": subtotal,
                "currency": "USD", "valid_until": created.date() + timedelta(days=30) if status in ("sent", "accepted", "converted") else None,
                "accepted_at": created if status in ("accepted", "converted") else None,
                "rejected_reason": "Budget" if status == "rejected" else None,
                "is_active": status not in ("cancelled", "expired"), "created_at": created,
                "created_by": self.user_ids[0],
            })
        self.bulk(Quotation, quote_rows)
        self.quote_ids = self.fetch_ids(Quotation, Quotation.id)
        for row in item_rows:
            row["quotation_id"] = self.quote_ids[row.pop("_mi")]
        self.bulk(QuotationItem, item_rows)
        print("Quotations seeded: 10000 (+ items)")

    def seed_contracts(self):
        contract_rows = []
        item_rows = []
        n_cust = len(self.customer_ids)
        n_prod = len(self.product_ids)
        n_quotes = len(self.quote_ids)
        for i in range(5000):
            customer_id = self.customer_ids[(i * 7) % n_cust]
            status = weighted_choice(self.rng, CONTRACT_STATUS_W)
            start = random_date(self.rng)
            end = start + timedelta(days=self.rng.choice([182, 365, 365, 730, 1095])) if status in ("active", "draft") else start + timedelta(days=self.rng.randint(30, 600))
            subtotal = Decimal("0")
            for line in range(1, self.rng.choice([1, 1, 2, 3]) + 1):
                it = line_item(self.rng)
                subtotal += it["total_amount"]
                item_rows.append({
                    "_ci": i, "organization_id": self.org_id, "line_number": line,
                    "product_id": self.product_ids[self.rng.randrange(n_prod)] if self.rng.uniform(0, 1) < 0.9 else None,
                    "description": f"Contract line {line}", "quantity": it["quantity"], "unit_price": it["unit_price"],
                    "discount_percentage": Decimal("0"), "discount_amount": Decimal("0"),
                    "tax_percentage": Decimal("0"), "tax_amount": Decimal("0"),
                    "total_amount": it["total_amount"], "is_tax_inclusive": False,
                })
            value = d2(subtotal * Decimal(self.rng.choice([6, 12, 12, 24])))
            signed = status in ("active", "expired", "terminated")
            contract_rows.append({
                "organization_id": self.org_id, "customer_id": customer_id,
                "quotation_id": self.quote_ids[self.rng.randrange(n_quotes)] if self.rng.uniform(0, 1) < 0.2 else None,
                "contract_number": f"CON-{i + 1:07d}", "contract_name": f"Perf Contract {i + 1}",
                "status": status, "start_date": start, "end_date": end, "notice_period_days": 30,
                "auto_renew": status == "active", "billing_period": "monthly", "billing_day": 1,
                "next_billing_date": start + timedelta(days=30) if status == "active" else None,
                "payment_terms": "net_30", "value": value, "currency": "USD",
                "signed_by_customer": signed, "signed_by_org": signed,
                "signed_at": random_time(self.rng) if signed else None,
                "terminated_reason": "End of term" if status == "terminated" else None,
                "contract_version": 1, "is_active": status in ("active", "draft"),
                "created_by": self.user_ids[0],
            })
        self.bulk(Contract, contract_rows)
        self.contract_ids = self.fetch_ids(Contract, Contract.id)
        for row in item_rows:
            row["contract_id"] = self.contract_ids[row.pop("_ci")]
        self.bulk(ContractItem, item_rows)
        print("Contracts seeded: 5000 (+ items)")

    def seed_subscriptions(self):
        sub_rows = []
        event_rows = []
        n_cust = len(self.customer_ids)
        n_plans = len(self.plan_ids)
        n_contracts = len(self.contract_ids)
        n_pricing = len(self.pricing_ids)
        n_prod = len(self.product_ids)
        for i in range(10000):
            status = weighted_choice(self.rng, SUBS_STATUS_W)
            currency, _ = pick_currency(self.rng)
            start = random_date(self.rng) - timedelta(days=365)
            term_days = self.rng.choice([30, 30, 30, 90, 365])
            unit = d2(self.rng.uniform(10, 500))
            sub_rows.append({
                "organization_id": self.org_id,
                "customer_id": self.customer_ids[(i * 3) % n_cust],
                "plan_id": self.plan_ids[i % n_plans],
                "contract_id": self.contract_ids[i % n_contracts] if self.rng.uniform(0, 1) < 0.4 else None,
                "product_id": self.product_ids[self.rng.randrange(n_prod)] if self.rng.uniform(0, 1) < 0.5 else None,
                "pricing_plan_id": self.pricing_ids[i % n_pricing] if self.rng.uniform(0, 1) < 0.5 else None,
                "subscription_number": f"SUB-{i + 1:07d}", "status": status, "currency": currency,
                "quantity": self.rng.randint(1, 5), "unit_price": d4(unit), "price_source": "catalog",
                "base_price": d4(unit), "resolved_price": d4(unit), "setup_fee": Decimal("0"),
                "discount_percentage": Decimal("0"), "discount_amount": Decimal("0"),
                "tax_percentage": Decimal("0"), "start_date": start, "current_term_start": start,
                "current_term_end": start + timedelta(days=term_days), "trial_end_date": None,
                "cancelled_at": random_time(self.rng) if status == "cancelled" else None,
                "paused_at": random_time(self.rng) if status == "paused" else None,
                "last_billed_at": random_time(self.rng),
                "next_billing_at": start + timedelta(days=term_days) if status in ("active", "past_due") else None,
                "cancel_at_period_end": status in ("cancelled", "expired"),
                "is_active": status in ("active", "past_due", "paused"),
                "created_by": self.user_ids[0],
            })
            if self.rng.uniform(0, 1) < 0.5:
                event_rows.append({
                    "organization_id": self.org_id, "subscription_id": 0, "event_type": "status_change",
                    "old_value": {"status": "active"}, "new_value": {"status": status},
                    "reason": "Seeded lifecycle event", "created_by": self.user_ids[0],
                })
        self.bulk(Subscription, sub_rows)
        self.sub_ids = self.fetch_ids(Subscription, Subscription.id)
        n_subs = len(self.sub_ids)
        for k, row in enumerate(event_rows):
            row["subscription_id"] = self.sub_ids[k % n_subs]
        self.bulk(SubscriptionEvent, event_rows)
        print("Subscriptions seeded: 10000 (+ events)")

    def seed_invoices(self):
        n_cust = len(self.customer_ids)
        n_prod = len(self.product_ids)
        n_contracts = len(self.contract_ids)
        n_subs = len(self.sub_ids)
        invoice_rows = []
        item_rows = []
        history_rows = []
        make = lambda d: datetime.combine(d, datetime.min.time(), tzinfo=timezone.utc)
        for i in range(50000):
            status = weighted_choice(self.rng, INVOICE_STATUS_W)
            invoice_type = weighted_choice(self.rng, INVOICE_TYPE_W)
            subtotal = Decimal("0")
            n_items = self.rng.choice([1, 1, 2, 2, 3])
            for line in range(1, n_items + 1):
                it = line_item(self.rng)
                subtotal += it["total_amount"]
                item_rows.append({
                    "_ii": i, "organization_id": self.org_id, "line_number": line,
                    "product_id": self.product_ids[self.rng.randrange(n_prod)] if self.rng.uniform(0, 1) < 0.85 else None,
                    "item_type": "product", "description": f"Invoice line {line}",
                    "quantity": it["quantity"], "unit_price": it["unit_price"],
                    "discount_percentage": Decimal("0"), "discount_amount": Decimal("0"),
                    "tax_percentage": Decimal("0"), "tax_amount": Decimal("0"), "total": it["total_amount"],
                    "is_tax_inclusive": False,
                })
            subtotal = d2(subtotal)
            discount_pct = Decimal(self.rng.choice(["0", "0", "0", "5", "10"]))
            discount_amount = d2(subtotal * discount_pct / Decimal("100"))
            taxable = d2(subtotal - discount_amount)
            tax_pct = Decimal(self.rng.choice(["0", "5", "10", "18", "20"]))
            tax_amount = d2(taxable * tax_pct / Decimal("100"))
            total_amount = d2(taxable + tax_amount)
            issue = random_date(self.rng)
            due = issue + timedelta(days=self.rng.choice([7, 15, 30, 30, 30, 60]))
            created = random_time(self.rng)
            paid_amount = Decimal("0")
            balance_due = total_amount
            sent_at = None
            paid_at = None
            if status in ("sent", "overdue", "partially_paid"):
                sent_at = make(issue)
            if status == "paid":
                paid_amount = total_amount
                balance_due = Decimal("0")
                sent_at = make(issue)
                paid_at = random_time(self.rng)
            elif status == "partially_paid":
                frac = Decimal(str(self.rng.uniform(0.3, 0.7))).quantize(M2)
                paid_amount = d2(total_amount * frac)
                balance_due = d2(total_amount - paid_amount)
                sent_at = make(issue)
                paid_at = make(issue + timedelta(days=self.rng.randint(1, 20)))
            elif status == "refunded":
                paid_amount = total_amount
                balance_due = Decimal("0")
                sent_at = make(issue)
                paid_at = make(issue + timedelta(days=self.rng.randint(1, 15)))
            elif status == "written_off":
                frac = Decimal(str(self.rng.uniform(0, 0.5))).quantize(M2)
                paid_amount = d2(total_amount * frac)
                balance_due = d2(total_amount - paid_amount)

            invoice_rows.append({
                "organization_id": self.org_id,
                "customer_id": self.customer_ids[i % n_cust],
                "subscription_id": self.sub_ids[i % n_subs] if invoice_type == "subscription" else None,
                "quotation_id": None,
                "contract_id": self.contract_ids[i % n_contracts] if self.rng.uniform(0, 1) < 0.2 else None,
                "invoice_number": f"INV-{i + 1:07d}", "invoice_type": invoice_type, "status": status,
                "issue_date": issue, "due_date": due, "subtotal": subtotal,
                "discount_percentage": discount_pct, "discount_amount": discount_amount,
                "tax_amount": tax_amount, "shipping_amount": Decimal("0"), "round_off": Decimal("0"),
                "total_amount": total_amount, "paid_amount": paid_amount, "balance_due": balance_due,
                "currency": "USD", "exchange_rate": Decimal("1"), "notes": f"Perf invoice {i + 1}",
                "payment_terms": "net_30", "sent_at": sent_at, "paid_at": paid_at,
                "cancelled_at": make(issue) if status == "cancelled" else None,
                "is_recurring": invoice_type == "subscription", "is_active": True,
                "created_at": created, "created_by": self.user_ids[2],
            })
            self.invoice_meta.append({
                "customer_id": self.customer_ids[i % n_cust], "status": status,
                "total_amount": total_amount, "paid_amount": paid_amount, "issue_date": issue, "balance_due": balance_due,
            })
            if status in ("paid", "refunded"):
                history_rows.append({
                    "organization_id": self.org_id, "invoice_id": 0,
                    "from_status": "draft", "to_status": status,
                    "changed_by": self.user_ids[2], "created_at": created,
                })
        self.bulk(Invoice, invoice_rows, batch=2000)
        self.invoice_ids = self.fetch_ids(Invoice, Invoice.id)
        for row in item_rows:
            row["invoice_id"] = self.invoice_ids[row.pop("_ii")]
        self.bulk(InvoiceItem, item_rows, batch=2000)
        n_inv = len(self.invoice_ids)
        for k, row in enumerate(history_rows):
            row["invoice_id"] = self.invoice_ids[k % n_inv]
        self.bulk(InvoiceStatusHistory, history_rows)
        print("Invoices seeded: 50000 (+ items, + history)")

    def seed_payments(self):
        payment_rows = []
        allocation_rows = []
        refund_link = {}
        seq = 1
        n_inv = len(self.invoice_ids)
        linked = 0
        for idx, inv_id in enumerate(self.invoice_ids):
            m = self.invoice_meta[idx]
            if m["status"] in ("paid", "partially_paid", "refunded"):
                pay_status = "refunded" if m["status"] == "refunded" else "cleared"
                pmt_amt = m["paid_amount"]
                payment_rows.append({
                    "organization_id": self.org_id, "customer_id": m["customer_id"],
                    "payment_number": f"PAY-{seq:08d}", "transaction_id": f"TX-{seq:08d}",
                    "payment_type": "invoice_payment", "status": pay_status, "amount": pmt_amt,
                    "currency": "USD", "exchange_rate": Decimal("1"), "gateway": "credit_card",
                    "gateway_fee": d2(pmt_amt * Decimal("0.029")), "net_amount": d2(pmt_amt),
                    "payment_date": m["issue_date"] + timedelta(days=self.rng.randint(0, 20)),
                    "cleared_at": random_time(self.rng) if pay_status == "cleared" else None,
                    "receipt_sent": True, "is_active": True, "created_by": self.user_ids[3],
                })
                pmt_idx = len(payment_rows) - 1
                allocation_rows.append({
                    "organization_id": self.org_id, "payment_id": 0, "invoice_id": inv_id,
                    "amount": pmt_amt, "created_by": self.user_ids[3],
                })
                if m["status"] == "refunded":
                    refund_link[inv_id] = pmt_idx
                linked += 1
                seq += 1

        extra_target = 100000 - len(payment_rows)
        n_cust = len(self.customer_ids)
        for _ in range(max(0, extra_target)):
            ptype = weighted_choice(self.rng, STANDALONE_PAY_TYPE_W)
            status = weighted_choice(self.rng, PAYMENT_STATUS_W)
            amount = d2(self.rng.uniform(20, 20000))
            payment_rows.append({
                "organization_id": self.org_id,
                "customer_id": self.customer_ids[self.rng.randrange(n_cust)],
                "payment_number": f"PAY-{seq:08d}", "transaction_id": f"TX-{seq:08d}",
                "payment_type": ptype, "status": status, "amount": amount,
                "currency": "USD", "exchange_rate": Decimal("1"),
                "gateway": self.rng.choice(GATEWAYS),
                "gateway_fee": d2(amount * Decimal("0.029")), "net_amount": d2(amount),
                "payment_date": random_date(self.rng),
                "cleared_at": random_time(self.rng) if status == "cleared" else None,
                "failure_reason": "Insufficient funds" if status == "failed" else None,
                "receipt_sent": status == "cleared", "is_active": True, "created_by": self.user_ids[3],
            })
            seq += 1

        # never let a payment date fall after the seed reference day
        for row in payment_rows:
            if row.get("payment_date") and row["payment_date"] > END_DAY:
                row["payment_date"] = END_DAY - timedelta(days=self.rng.randint(0, 5))

        self.bulk(Payment, payment_rows, batch=2000)
        self.payment_ids = self.fetch_ids(Payment, Payment.id)

        pinned = [i for i in range(n_inv) if self.invoice_meta[i]["status"] in ("paid", "partially_paid", "refunded")]
        for k, inv_idx in enumerate(pinned):
            allocation_rows[k]["payment_id"] = self.payment_ids[k]
        self.bulk(PaymentAllocation, allocation_rows, batch=2000)

        self.refund_link = {inv_id: self.payment_ids[pmt_idx] for inv_id, pmt_idx in refund_link.items()}
        print(f"Payments seeded: {len(payment_rows)} (+ allocations {len(allocation_rows)})")

    def seed_credit_notes(self):
        cn_rows = []
        app_rows = []
        n_cust = len(self.customer_ids)
        n_inv = len(self.invoice_ids)
        for i in range(5000):
            customer_id = self.customer_ids[(i * 11) % n_cust]
            status = weighted_choice(self.rng, CREDIT_NOTE_STATUS_W)
            total = d2(self.rng.uniform(20, 10000))
            issue = random_date(self.rng)
            created = random_time(self.rng)
            ctype = weighted_choice(self.rng, CN_TYPE_W)
            applied = Decimal("0")
            if status == "fully_applied":
                applied = total
            elif status == "partially_applied":
                applied = d2(total * Decimal(str(self.rng.uniform(0.2, 0.8))).quantize(M2))
            remaining = d2(total - applied)
            cn_rows.append({
                "organization_id": self.org_id, "customer_id": customer_id,
                "invoice_id": self.invoice_ids[i % n_inv] if self.rng.uniform(0, 1) < 0.7 else None,
                "credit_note_number": f"CN-{i + 1:08d}", "credit_note_type": ctype,
                "reason": "Perf seeded credit note", "status": status, "subtotal": total,
                "discount_amount": Decimal("0"), "tax_amount": Decimal("0"), "total_amount": total,
                "remaining_amount": remaining, "currency": "USD", "exchange_rate": Decimal("1"),
                "issue_date": issue,
                "approved_at": created if status in ("approved", "issued", "fully_applied", "partially_applied") else None,
                "approved_by": self.user_ids[4], "voided_at": created if status == "voided" else None,
                "is_active": status != "voided", "created_at": created, "created_by": self.user_ids[4],
            })
            if status in ("fully_applied", "partially_applied"):
                app_rows.append({
                    "organization_id": self.org_id, "credit_note_id": 0,
                    "invoice_id": self.invoice_ids[(i * 5) % n_inv], "amount": applied,
                    "created_by": self.user_ids[4],
                })
        self.bulk(CreditNote, cn_rows)
        cn_ids = self.fetch_ids(CreditNote, CreditNote.id)
        n_cn = len(cn_ids)
        for k, row in enumerate(app_rows):
            row["credit_note_id"] = cn_ids[k % n_cn]
        self.bulk(CreditNoteApplication, app_rows)
        print("Credit notes seeded: 5000 (+ applications)")

    def seed_refunds(self):
        refund_rows = []
        refund_items = list(self.refund_link.items())
        n_cust = len(self.customer_ids)
        invoice_id_to_customer = {}
        for idx, inv_id in enumerate(self.invoice_ids):
            invoice_id_to_customer[inv_id] = self.invoice_meta[idx]["customer_id"]
        for i in range(5000):
            if i < len(refund_items):
                invoice_id, payment_id = refund_items[i]
                customer_id = invoice_id_to_customer[invoice_id]
                status = "completed"
                refund_type = "full"
                source = "payment"
            else:
                invoice_id = None
                payment_id = None
                customer_id = self.customer_ids[self.rng.randrange(n_cust)]
                status = weighted_choice(self.rng, REFUND_STATUS_W)
                refund_type = "overpayment_refund"
                source = self.rng.choice(["payment", "invoice", "customer_credit_balance"])
            amount = d2(self.rng.uniform(20, 5000))
            created = random_time(self.rng)
            refund_rows.append({
                "organization_id": self.org_id, "customer_id": customer_id,
                "invoice_id": invoice_id, "payment_id": payment_id, "credit_note_id": None,
                "refund_number": f"RF-{i + 1:07d}", "refund_type": refund_type,
                "refund_source": source, "refund_method": self.rng.choice(REFUND_METHODS),
                "status": status, "amount": amount, "currency": "USD", "exchange_rate": Decimal("1"),
                "gateway": "credit_card", "reason": "Perf seeded refund",
                "approved_at": created if status in ("completed", "processing", "approved", "failed") else None,
                "approved_by": self.user_ids[4],
                "processing_started_at": created if status in ("processing", "completed", "failed") else None,
                "processed_by": self.user_ids[3], "completed_at": created if status == "completed" else None,
                "is_active": status not in ("cancelled", "rejected"), "created_by": self.user_ids[4],
            })
        self.bulk(Refund, refund_rows)
        print("Refunds seeded: 5000")

    def seed_write_offs(self):
        rows = []
        for idx, m in enumerate(self.invoice_meta):
            if m["status"] == "written_off":
                inv_id = self.invoice_ids[idx]
                created = random_time(self.rng)
                rows.append({
                    "organization_id": self.org_id, "customer_id": m["customer_id"],
                    "invoice_id": inv_id, "write_off_number": f"WO-{idx + 1:07d}",
                    "write_off_type": self.rng.choice(["bad_debt", "small_balance", "accounting_adjustment"]),
                    "adjustment_type": "debit_adjustment", "write_off_source": "invoice",
                    "status": self.rng.choice(["executed", "executed", "approved"]),
                    "amount": m["balance_due"] if m["balance_due"] > 0 else m["total_amount"],
                    "currency": "USD", "exchange_rate": Decimal("1"), "reason": "Perf seeded write-off",
                    "approved_at": created, "approved_by": self.user_ids[4],
                    "executed_at": created, "executed_by": self.user_ids[4], "is_active": True,
                    "created_by": self.user_ids[4],
                })
        self.bulk(WriteOff, rows)
        print(f"Write-offs seeded: {len(rows)}")

    def seed_audit_logs(self):
        rows = []
        n_users = len(self.user_ids)
        actions = AUDIT_ACTIONS
        entities = AUDIT_ENTITIES
        for i in range(100000):
            rows.append({
                "organization_id": self.org_id, "actor_id": self.user_ids[self.rng.randrange(n_users)],
                "entity_type": entities[self.rng.randrange(len(entities))],
                "entity_id": self.rng.randint(1, 100000),
                "action": actions[self.rng.randrange(len(actions))], "old_values": None,
                "new_values": {"change_id": i}, "changes": None,
                "ip_address": f"10.0.{self.rng.randint(0, 255)}.{self.rng.randint(1, 254)}",
                "user_agent": "PerfSeeder/1.0", "request_id": f"perf-req-{i:08d}",
                "timestamp": random_time(self.rng),
            })
        self.bulk(BillingAuditLog, rows, batch=5000)
        print("Audit logs seeded: 100000")

    def update_customer_aggregates(self):
        oid = self.org_id
        self.db.execute(text(f"""
            UPDATE billing_customers AS bc SET
                total_invoices = t.cnt, total_revenue = t.rev, outstanding_balance = t.out
            FROM (SELECT customer_id AS cid, COUNT(*) AS cnt,
                         COALESCE(SUM(total_amount),0) AS rev, COALESCE(SUM(balance_due),0) AS out
                  FROM invoices WHERE organization_id = {oid} AND is_active = true
                    AND status NOT IN ('draft','cancelled') GROUP BY customer_id) AS t
            WHERE bc.id = t.cid AND bc.organization_id = {oid}
        """))
        self.db.execute(text(f"""
            UPDATE billing_customers AS bc SET total_payments = t.pays
            FROM (SELECT customer_id AS cid, COUNT(*) AS pays
                  FROM payments WHERE organization_id = {oid} GROUP BY customer_id) AS t
            WHERE bc.id = t.cid AND bc.organization_id = {oid}
        """))
        self.db.execute(text(f"""
            UPDATE billing_customers AS bc SET credit_balance = t.rem
            FROM (SELECT customer_id AS cid, COALESCE(SUM(remaining_amount),0) AS rem
                  FROM credit_notes WHERE organization_id = {oid} AND is_active = true
                    AND status <> 'voided' GROUP BY customer_id) AS t
            WHERE bc.id = t.cid AND bc.organization_id = {oid}
        """))
        self.db.execute(text(f"""
            UPDATE billing_customers SET lifetime_value = COALESCE(total_revenue,0)
            WHERE organization_id = {oid}
        """))
        self.db.commit()
        print("Customer aggregate columns updated")

    def verify(self, counts_only=False):
        oid = self.org_id
        def q(sql):
            return self.db.execute(text(sql).bindparams(oid=oid)).scalar()
        counts = {
            "organizations": q("SELECT COUNT(*) FROM organizations WHERE id = :oid"),
            "users": q("SELECT COUNT(*) FROM users WHERE organization_id = :oid"),
            "billing_customers": q("SELECT COUNT(*) FROM billing_customers WHERE organization_id = :oid"),
            "customer_contacts": q("SELECT COUNT(*) FROM customer_contacts WHERE organization_id = :oid"),
            "products": q("SELECT COUNT(*) FROM products WHERE organization_id = :oid"),
            "subscription_plans": q("SELECT COUNT(*) FROM subscription_plans WHERE organization_id = :oid"),
            "pricing_plans": q("SELECT COUNT(*) FROM pricing_plans WHERE organization_id = :oid"),
            "quotations": q("SELECT COUNT(*) FROM quotations WHERE organization_id = :oid"),
            "quotation_items": q("SELECT COUNT(*) FROM quotation_items WHERE organization_id = :oid"),
            "contracts": q("SELECT COUNT(*) FROM contracts WHERE organization_id = :oid"),
            "contract_items": q("SELECT COUNT(*) FROM contract_items WHERE organization_id = :oid"),
            "subscriptions": q("SELECT COUNT(*) FROM subscriptions WHERE organization_id = :oid"),
            "invoices": q("SELECT COUNT(*) FROM invoices WHERE organization_id = :oid"),
            "invoice_items": q("SELECT COUNT(*) FROM invoice_items WHERE organization_id = :oid"),
            "invoice_status_history": q("SELECT COUNT(*) FROM invoice_status_history WHERE organization_id = :oid"),
            "payments": q("SELECT COUNT(*) FROM payments WHERE organization_id = :oid"),
            "payment_allocations": q("SELECT COUNT(*) FROM payment_allocations WHERE organization_id = :oid"),
            "credit_notes": q("SELECT COUNT(*) FROM credit_notes WHERE organization_id = :oid"),
            "credit_note_applications": q("SELECT COUNT(*) FROM credit_note_applications WHERE organization_id = :oid"),
            "refunds": q("SELECT COUNT(*) FROM refunds WHERE organization_id = :oid"),
            "write_offs": q("SELECT COUNT(*) FROM write_offs WHERE organization_id = :oid"),
            "tax_rates": q("SELECT COUNT(*) FROM tax_rates WHERE organization_id = :oid"),
            "billing_audit_logs": q("SELECT COUNT(*) FROM billing_audit_logs WHERE organization_id = :oid"),
        }
        print("\n-- Row counts --")
        for k, v in counts.items():
            print(f"  {k:<28} {v}")

        checks = {
            "paid invoices with paid_amount != total": q("SELECT COUNT(*) FROM invoices WHERE organization_id = :oid AND status='paid' AND paid_amount <> total_amount"),
            "refunded invoices with balance_due > 0": q("SELECT COUNT(*) FROM invoices WHERE organization_id = :oid AND status='refunded' AND balance_due > 0"),
            "orphaned allocations": q("SELECT COUNT(*) FROM payment_allocations a LEFT JOIN payments p ON p.id=a.payment_id WHERE a.organization_id = :oid AND p.id IS NULL"),
            "negative balances": q("SELECT COUNT(*) FROM invoices WHERE organization_id = :oid AND balance_due < 0"),
            "negative/zero payments": q("SELECT COUNT(*) FROM payments WHERE organization_id = :oid AND amount <= 0"),
            "credit notes remaining > total": q("SELECT COUNT(*) FROM credit_notes WHERE organization_id = :oid AND remaining_amount > total_amount"),
        }
        print("\n-- Financial integrity (must be 0/0) --")
        for k, v in checks.items():
            print(f"  {k:<46} {v}")

        inv_out = q("SELECT COALESCE(SUM(balance_due),0) FROM invoices WHERE organization_id = :oid AND is_active = true AND status IN ('sent','overdue','partially_paid') AND balance_due > 0")
        cust_out = q("SELECT COALESCE(SUM(outstanding_balance),0) FROM billing_customers WHERE organization_id = :oid")
        print(f"  outstanding (invoices aggregated)   {inv_out}")
        print(f"  outstanding (customer cache)        {cust_out}")
        print("\nSeeding complete.")


def main():
    t0 = time.time()
    initialize_database()
    db = SessionLocal()
    try:
        s = Seeder(db)
        s.seed_organization()
        s.seed_users()
        s.seed_configuration()
        s.seed_tax_rates()
        s.seed_catalog()
        s.seed_plans()
        s.seed_customers()
        s.seed_quotations()
        s.seed_contracts()
        s.seed_subscriptions()
        s.seed_invoices()
        s.seed_payments()
        s.seed_credit_notes()
        s.seed_refunds()
        s.seed_write_offs()
        s.seed_audit_logs()
        s.update_customer_aggregates()
        s.verify()
        print(f"Elapsed: {time.time() - t0:.1f}s")
    finally:
        db.close()


if __name__ == "__main__":
    main()
