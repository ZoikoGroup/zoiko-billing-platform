"""Comprehensive multi-question chatbot test through the REAL pipeline.

Seeds a realistic single-org DB (customers, invoices across statuses,
payments, subscriptions, contracts, products, credit notes) and runs a broad
set of questions covering every intent category, printing each ACTUAL answer
so off-topic / unrelated responses are easy to spot.

Run: python -m tests.ai_assistant.live_chat_broad
"""
import sys, os
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.path.insert(0, os.getcwd())

from datetime import date, timedelta
from decimal import Decimal
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.modules.organizations.models import Organization
from app.modules.billing.models import (
    Invoice, InvoiceStatus, BillingCustomer, Payment, PaymentStatus, PaymentType,
    Subscription, BillingSubscriptionStatus, Contract, ContractStatus,
    Product, SubscriptionPlan, CreditNote, CreditNoteStatus, CreditNoteType, PlanCategory,
)
from app.modules.chatbot.conversation.engine import ConversationEngine
from app.modules.chatbot.context.ai_context import AIContext
from app.modules.chatbot.models import AIConversation, ConversationStatus


def seed(db, org):
    today = date.today()
    last_month = (today.replace(day=1) - timedelta(days=1)).replace(day=1)

    acme = BillingCustomer(organization_id=org.id, customer_code="CUST-ACME",
                           company_name="Acme Corp", display_name="Acme",
                           email="a@a.com", currency="USD")
    beta = BillingCustomer(organization_id=org.id, customer_code="CUST-BETA",
                           company_name="Beta Ltd", display_name="Beta",
                           email="b@b.com", currency="INR")
    db.add_all([acme, beta]); db.flush()

    # Products + a plan so subscription/catalog asks have data
    p1 = Product(organization_id=org.id, code="PROD-1", name="Widget",
                 default_price=Decimal("10.00"), currency="USD")
    p2 = Product(organization_id=org.id, code="PROD-2", name="Gadget",
                 default_price=Decimal("25.00"), currency="USD")
    db.add_all([p1, p2]); db.flush()
    plan = SubscriptionPlan(organization_id=org.id, plan_code="PLAN-BASIC",
                            plan_name="Basic Plan", unit_price=Decimal("30.00"),
                            billing_period="monthly", category=PlanCategory.SUBSCRIPTION)
    db.add(plan); db.flush()

    sub = Subscription(organization_id=org.id, customer_id=acme.id,
                       plan_id=plan.id, subscription_number="SUB-9001",
                       status=BillingSubscriptionStatus.ACTIVE,
                       quantity=1, unit_price=Decimal("30.00"), currency="USD",
                       start_date=today, current_term_start=today,
                       current_term_end=today + timedelta(days=30))
    db.add(sub); db.flush()

    c1 = Contract(organization_id=org.id, customer_id=acme.id, contract_number="CT-001",
                  contract_name="Widget Contract", status=ContractStatus.ACTIVE,
                  value=Decimal("1200.00"), currency="USD",
                  start_date=today - timedelta(days=60), end_date=today + timedelta(days=300))
    db.add(c1); db.flush()

    # Invoices in many statuses
    paid = Invoice(organization_id=org.id, customer_id=acme.id, invoice_number="INV-1001",
                   status=InvoiceStatus.PAID, issue_date=today, due_date=today,
                   total_amount="1000.00", paid_amount="1000.00", balance_due="0.00", currency="USD")
    overdue = Invoice(organization_id=org.id, customer_id=acme.id, invoice_number="INV-1002",
                      status=InvoiceStatus.OVERDUE, issue_date=today - timedelta(days=40),
                      due_date=today - timedelta(days=10),
                      total_amount="250.00", paid_amount="0.00", balance_due="250.00", currency="USD")
    sent = Invoice(organization_id=org.id, customer_id=acme.id, invoice_number="INV-1003",
                   status=InvoiceStatus.SENT, issue_date=today - timedelta(days=5),
                   due_date=today + timedelta(days=25),
                   total_amount="75.00", paid_amount="0.00", balance_due="75.00", currency="USD")
    draft = Invoice(organization_id=org.id, customer_id=beta.id, invoice_number="INV-1004",
                    status=InvoiceStatus.DRAFT, issue_date=today, due_date=today,
                    total_amount="999.00", paid_amount="0.00", balance_due="999.00", currency="INR")
    db.add_all([paid, overdue, sent, draft]); db.flush()

    pay = Payment(organization_id=org.id, customer_id=acme.id, payment_number="PAY-5001",
                  amount=Decimal("1000.00"), currency="USD", status=PaymentStatus.CLEARED,
                  payment_type=PaymentType.INVOICE_PAYMENT, payment_date=today)
    db.add(pay); db.flush()

    cn = CreditNote(organization_id=org.id, customer_id=acme.id, credit_note_number="CN-777",
                    credit_note_type=CreditNoteType.ADJUSTMENT,
                    status=CreditNoteStatus.ISSUED, total_amount=Decimal("40.00"),
                    remaining_amount=Decimal("40.00"), currency="USD", issue_date=today)
    db.add(cn); db.flush()

    db.commit()


def run(engine, conv, ctx, q):
    print("\n" + "=" * 76)
    print(f"Q: {q}")
    try:
        resp = engine.send_message(conversation_uid=conv.conversation_uid, message=q, ctx=ctx)
        a = resp.get("answer", "<none>")
        print(f"[{resp.get('mode','?')} | intent={resp.get('intent','?')}] {a}")
        return a
    except Exception as e:
        print(f"  !! ERROR: {e}")
        return f"<ERROR {e}>"


def main():
    eng = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
    Base.metadata.create_all(bind=eng)
    SessionLocal = sessionmaker(bind=eng, autoflush=False, autocommit=False)
    db = SessionLocal()
    org = Organization(organization_name="Zoiko Test", organization_code="ZT1")
    db.add(org); db.flush()
    seed(db, org)
    ctx = AIContext(organization_id=org.id, user_id=1, tenant_context_id=1,
                    role="admin", permissions=[], request_id="broad", tenant_name="Zoiko Test")
    engine = ConversationEngine(db, model_gateway=None)
    conv = AIConversation(conversation_uid="broad-conv", tenant_context_id=1,
                          organization_id=org.id, user_id=1, title="broad",
                          conversation_status=ConversationStatus.OPEN)
    db.add(conv); db.flush()

    questions = [
        # customer_list / outstanding / search
        "who are our customers?", "list customers", "which customers do we have?",
        "which customers have invoices?", "who owes us money?", "which customers owe us money?",
        "outstanding customers", "show customer GOk", "what is my outstanding balance?",
        "what do we owe?",
        # invoice listing / search / count / status
        "show overdue invoices", "list invoices", "show all invoices", "which invoices are unpaid?",
        "how many invoices are overdue?", "how many invoices", "show unpaid invoices",
        "show paid invoices", "what is INV-2024-0001", "show me the invoices",
        # payments
        "list payments", "show payments", "show payments made by Acme", "payments received from Acme",
        "how many payments", "show unpaid invoices",
        # subscriptions / contracts / products
        "list subscriptions", "show subscriptions", "list contracts", "what contracts do we have",
        "list products", "show the catalog", "which products do we have", "count the products",
        # refunds / credit notes
        "how do refunds work", "show credit notes", "any refunds",
        # dashboard / growth / revenue
        "dashboard summary", "revenue this month", "total revenue", "what is the collection rate?",
        "show recent activity",
        # help / general
        "what can you do", "how do refunds work",
    ]
    for q in questions:
        run(engine, conv, ctx, q)
    db.close()


if __name__ == "__main__":
    main()
