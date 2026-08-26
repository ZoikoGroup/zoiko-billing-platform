"""
Seed the Zoiko Billing knowledge base with domain knowledge.
Run once: python seed_knowledge.py
"""
import sys, os
sys.path.insert(0, os.path.dirname(__file__))

from app.database import SessionLocal, initialize_database
from app.modules.chatbot.models import (
    KnowledgeNamespace, KnowledgeSource, KnowledgeDocument, KnowledgeChunk,
    KnowledgeClassification, KnowledgeSourceDocType, FreshnessStatus, SessionChannel, BillingPlane,
    UserRefStatus,
)

KB_ENTRIES = [
    {
        "title": "Billing Reports",
        "chunks": [
            "Zoiko Billing provides six billing reports, available on the Reports page and the Forecast Report page: Revenue Report, Invoice Report, Payment Report, Tax Report, Subscription Report, and Forecast Report. Each report can be filtered by date range and exported for accounting or review.",
            "Revenue Report: shows total billed revenue, collected payments, refunds, and net revenue over a chosen period. Use it to track how much money the business earned and spot revenue trends month over month.",
            "Invoice Report: shows every invoice issued in a period with its status (draft, sent, paid, overdue), total value, and aging. Use it for accounts-receivable follow-up and to see which invoices are unpaid or overdue.",
            "Payment Report: shows payments received in a period, broken down by payment method and status (cleared, pending, failed). Use it to reconcile bank deposits against customer payments.",
            "Tax Report: shows tax amounts charged and collected, grouped by tax rate. Use it to prepare tax filings and verify the correct tax was applied to invoices.",
            "Subscription Report: shows active, cancelled, and expiring subscriptions, plan distribution, and recurring revenue trends. Use it to understand subscriber growth and recurring billing performance.",
            "Forecast Report: projects future revenue, monthly recurring revenue (MRR), and collected cash using simple linear regression on the last 12 months of data. It forecasts 6 months ahead and displays a combined chart of historical and projected values, a monthly breakdown table, and summary KPIs including forecasted 6-month revenue, growth trend, expected MRR, and forecast confidence (R-squared). The report can be exported as CSV, Excel, or JSON.",
        ],
    },
    {
        "title": "User Roles and Permissions",
        "chunks": [
            "Zoiko Billing has three user roles: Super Admin, Organization Admin, and Billing Admin. Roles control what a user can see and do; every action is permission-checked and audit-logged.",
            "Super Admin: platform-level operator. Manages platform settings, organizations, kill switches, and cross-tenant support access. Super Admins are not part of a tenant's billing team and use dedicated support access sessions.",
            "Organization Admin: the administrator of an organization. Manages the organization's profile, users and their role assignments, subscription plan, and can access all billing data for their own organization. Only an Organization Admin can change another user's role within the organization.",
            "Billing Admin: a billing operations role. Can work with invoices, payments, customers, credit notes, refunds, and billing settings for the organization, but cannot manage users or change role assignments.",
            "Permission levels follow tenant isolation: each organization can only see and manage its own billing data, and no role — including Billing Admin — can access another organization's records. Cross-organization access is only possible through audited Super Admin support sessions.",
            "Who can access billing settings: both Organization Admin and Billing Admin roles can open and change billing settings (taxes, numbering, templates, dunning). User management screens (inviting users, changing roles) are restricted to the Organization Admin.",
            "Changing a user's role: an Organization Admin opens the organization's user management screen, selects the member, and assigns the new role. Role changes take effect on the user's next session and are recorded in the audit log.",
        ],
    },
    {
        "title": "Invoices Overview",
        "chunks": [
            "An invoice is a commercial document issued by a seller to a buyer, indicating the products, quantities, and agreed prices for services or products provided. In Zoiko Billing, invoices track what customers owe.",
            "How to create an invoice: Go to Invoices, click Create Invoice, select the customer, add line items with descriptions, quantities, and unit prices, set the tax rate and billing period, review the total, and save as Draft.",
            "How to issue an invoice: Open a Draft invoice, review the details, then click Issue. The invoice status changes to Sent and the customer receives it. Once issued, the invoice cannot be edited.",
            "How to cancel an invoice: Open a Sent invoice, click Cancel, provide a reason for cancellation. Cancelled invoices reduce the customer balance. Only Sent or Overdue invoices can be cancelled.",
            "How to write off an invoice: For uncollectible invoices, open the invoice, click Write Off. This marks the remaining balance as written off for accounting purposes.",
            "Invoice statuses in Zoiko Billing: Draft (created but not yet sent), Sent (delivered to customer, awaiting payment), Partially Paid (some payment received), Paid (fully settled), Overdue (past due date with unpaid balance), Cancelled (voided before any collection effort), Refunded (payment returned to customer), Written Off (remaining balance written off as uncollectable).",
            "An invoice balance due is calculated as: Total Amount minus Paid Amount. If the balance due is zero, the invoice is fully paid. If the due date has passed and balance remains, the invoice is overdue.",
            "To check an invoice status, look up the invoice by its number (e.g., INV-1001) or by customer name. The status, amounts, and due date will be shown.",
            "Invoice line items detail each product or service billed. Each line item has a description, quantity, unit price, and total. Tax may be applied per line item or at the invoice level.",
        ],
    },
    {
        "title": "Payments and Allocations",
        "chunks": [
            "A payment records money received from a customer. Each payment is linked to a customer and may be allocated across one or more invoices.",
            "How to record a payment: Navigate to the Payments section, click Record Payment, select the customer, enter the payment amount, choose the payment method (bank transfer, credit card, cash, check), enter the transaction reference or reference number, and submit. The payment will be created in Pending status.",
            "How to allocate a payment to invoices: After recording a payment, click Allocate on the payment record. Select the invoices you want to apply the payment to. You can split a single payment across multiple invoices. The system will show the balance remaining after allocation. Confirm the allocation to reduce the balance due on each selected invoice.",
            "Payment allocation is the process of applying a payment amount to specific invoices. A single payment can be split across multiple invoices. Allocations reduce the balance due on each allocated invoice.",
            "Payment statuses: Pending (initiated but not confirmed), Processing (being processed by payment gateway), Cleared (successfully processed and funds received), Failed (transaction failed), Cancelled (payment cancelled), Refunded (payment returned to customer).",
            "To find a payment, search by payment number (e.g., PAY-1001), transaction ID, or customer name. The payment amount, date, status, and linked invoices will be shown.",
            "Unallocated payments are payments received that have not yet been applied to any invoice. These appear as credits on the customer's account.",
        ],
    },
    {
        "title": "Credit Notes vs Refunds",
        "chunks": [
            "A credit note (also called credit memo) is a document issued to a customer that reduces the amount they owe. It does not involve actual money movement — it adjusts the customer's account balance. Use a credit note when you need to correct an invoice error, apply a discount, or adjust billing without returning funds.",
            "A refund is the actual return of money to a customer. It involves a real financial transaction where funds are transferred back to the customer's original payment method. Use a refund when the customer has overpaid or when you need to return money for returned goods or cancelled services.",
            "Key difference: A credit note reduces what the customer owes on paper (accounting adjustment). A refund returns actual money to the customer (cash movement). A credit note can lead to a refund if the customer requests their money back, but they are not the same thing.",
            "Credit notes in Zoiko Billing are tracked with a credit note number (e.g., CN-1001), linked to the original invoice, and show the credited amount. They go through statuses: Draft, Issued, Applied.",
            "Refunds in Zoiko Billing are tracked with a refund number (e.g., REF-1001), linked to the original payment, and show the refunded amount. They go through statuses: Pending, Completed, Failed.",
            "When a credit note is applied, it reduces the customer's outstanding balance on the original invoice. The invoice's paid amount is effectively increased by the credit note amount.",
            "How to create a credit note: Go to Credit Notes, click Create Credit Note, select the customer, link it to the original invoice, enter the credit amount and reason, save as Draft, then click Issue to apply it.",
            "How to issue a refund: Go to Payments, find the payment to refund, click Refund, enter the refund amount, select the refund method (original payment method or bank transfer), provide a reason, and submit. The refund will be processed.",
        ],
    },
    {
        "title": "Subscriptions and Plans",
        "chunks": [
            "A subscription represents a recurring billing arrangement where a customer is charged at regular intervals (monthly, annually, etc.) for access to a product or service.",
            "Subscription statuses: Active (currently billing), Paused (temporarily suspended), Cancelled (terminated), Past Due (payment failed on renewal), Trial (in free trial period).",
            "A subscription plan defines the pricing, billing interval, and features included. Plans can have tiers (e.g., Basic, Pro, Enterprise) with different pricing.",
            "Subscription billing cycles define how often a customer is charged: monthly, quarterly, semi-annually, or annually. Each cycle generates an invoice automatically on the renewal date until the subscription is paused or cancelled.",
            "Subscription upgrades and downgrades change the plan mid-cycle. Upgrades typically prorate the remaining billing period. Downgrades apply at the next renewal date.",
            "How to create a subscription: Go to Subscriptions, click Create Subscription, select the customer, choose a plan, set the billing start date, review the prorated charges, and activate.",
            "How to pause or cancel a subscription: Open the subscription, click Pause to temporarily stop billing, or Cancel to terminate. Paused subscriptions resume automatically. Cancelled subscriptions do not resume.",
        ],
    },
    {
        "title": "Proration and Multi-Currency Billing",
        "chunks": [
            "Proration adjusts charges for partial billing periods. When a subscription starts, upgrades, or downgrades partway through a cycle, Zoiko Billing calculates a prorated amount so the customer only pays for the portion of the billing period they actually use.",
            "Multi-currency invoicing lets an organization bill customers in different currencies. Exchange rates convert foreign-currency amounts into the organization's base reporting currency, and every invoice records both its original currency and the converted amount.",
        ],
    },
    {
        "title": "Overdue Invoices and Dunning",
        "chunks": [
            "An overdue invoice is one where the due date has passed and the balance remains unpaid. Overdue invoices may trigger dunning processes.",
            "Dunning is the systematic process of communicating with customers to collect overdue payments. It typically involves escalating reminders: friendly reminder, firm notice, final warning, account suspension.",
            "Dunning levels in Zoiko Billing: Level 1 (gentle reminder at 7 days past due), Level 2 (firm notice at 14 days), Level 3 (final warning at 30 days), Level 4 (account suspension at 45+ days).",
            "How to set up dunning: Go to Billing Settings, open the Dunning tab, configure reminder intervals, email templates, and escalation rules for each dunning level. Dunning runs automatically on overdue invoices.",
            "How to view overdue invoices: Go to the Dashboard, check the Overdue Invoices widget, or go to Invoices and filter by Overdue status. The aging report shows how long each invoice has been overdue.",
            "To check overdue invoices, ask the assistant to show overdue invoices or check the dashboard for overdue counts and amounts.",
        ],
    },
    {
        "title": "Customers and Accounts",
        "chunks": [
            "A customer (or billing customer) represents an organization or individual that purchases products or services. Each customer has contact information, billing address, and payment terms.",
            "Customer details include: company name, contact email, billing address, payment terms (e.g., Net 30), credit limit, and current account balance.",
            "To look up a customer, search by company name, customer code, or email address. The customer's billing history, outstanding balance, and recent invoices will be shown.",
        ],
    },
    {
        "title": "Contracts and Quotations",
        "chunks": [
            "A contract defines the commercial terms between Zoiko and a customer, including pricing, duration, renewal terms, and service levels.",
            "A quotation (or quote) is a preliminary document outlining proposed pricing and terms. It can be accepted by the customer to create a contract or generate an invoice.",
            "Contract statuses: Draft (being prepared), Active (in effect), Expired (past end date), Terminated (ended early).",
            "Quotation statuses: Draft (being prepared), Sent (delivered to customer), Accepted (customer agreed), Rejected (customer declined), Expired (past validity date).",
        ],
    },
    {
        "title": "Billing Workflows and Policies",
        "chunks": [
            "The standard billing workflow: Create Invoice -> Issue Invoice -> Receive Payment -> Allocate Payment -> Close Invoice. If payment is not received by due date, dunning begins.",
            "Zoiko Billing enforces tenant isolation: each organization can only see and manage its own billing data. No cross-organization data access is permitted.",
            "All billing actions are audit-logged. Every invoice creation, payment allocation, credit note, and refund is tracked with who performed the action, when, and what changed.",
        ],
    },
    {
        "title": "Billing Configuration",
        "chunks": [
            "Billing Configuration is the central settings page for the Zoiko Billing module, accessed from the Organization Settings. It contains nine tabs that control every aspect of how billing operates: General, Invoicing, Payments, Tax, Dunning, Revenue, Notifications, Advanced, and Administration.",
            "General tab: configure organization details (company name, billing email, support email, phone, website, logo), country-specific tax registration fields (GSTIN, VAT, PAN, EIN, ABN), physical address, and regional settings including default currency, supported currencies, timezone, language, date format, and fiscal year. Smart Organization Intelligence auto-applies country-specific defaults for India, US, UK, Australia, UAE, and Singapore.",
            "Invoicing tab: set document numbering for invoices, quotes, credit notes, and refunds (prefix, format pattern, sequence reset), invoice defaults (due days, payment reminder timing, late fees), PDF templates (standard, modern, professional, minimal, bold), draft behavior (save as draft, auto-finalize, or send for approval), branding, display toggles (auto-generate numbers, show tax/discount/shipping breakdown), and invoice text, footer, terms, and conditions.",
            "Payments tab: configure default payment terms (net 7 through net 90), rounding method and precision, exchange rate provider and auto-update, grace period and credit limits, auto-send receipts, auto-capture payments, live exchange rate management, and payment gateway toggles (Stripe, Razorpay, PayPal, Cash, Bank Transfer, UPI, Offline).",
            "Tax tab: set tax calculation method (exclusive vs inclusive), tax label (VAT, GST, Sales Tax), tax registration number, rounding method (per line, per invoice, per line item), and toggles for tax-inclusive defaults, show tax on invoice, and auto-calculate. Configure which tax types are enabled (GST, Sales Tax, Service Tax, Withholding Tax, Reverse Charge, Compound Tax) with country-aware smart defaults.",
            "Dunning tab: configure debt collection and overdue invoice escalation: number of escalation levels, wait days between levels, grace days before dunning starts, auto-dunning toggle, escalate-to-collections toggle, SMS and WhatsApp reminder channels, auto-suspend on overdue, and penalty and interest settings (penalty type and value, annual interest rate, simple vs compound).",
            "Revenue tab: set revenue recognition method (immediate, daily or monthly prorated, milestone, manual), deferral days, accounting method (cash, accrual, deferred), recognition frequency (daily through annually), and toggles for revenue recognition and multi-currency support.",
            "Notifications tab: toggle email and in-app notifications for billing events including Invoice Created, Invoice Sent, Invoice Paid, Invoice Overdue, Subscription Renewed, Subscription Cancelled, Payment Failed, Payment Success, and Customer Created.",
            "Advanced tab: enable or disable billing module capabilities including approval workflow, credit notes, discounts, retainers, schedule invoicing, partial payments, auto-apply credits, quotes, contracts, usage-based billing, refunds, auto-tax calculation, and audit logs.",
            "Administration tab: operational and diagnostic tools including System Health dashboard, SMTP Test for email delivery verification, Email Templates browser, Numbering Diagnostics, Tax Diagnostics, Exchange Rate Diagnostics, and Enhanced Validation.",
        ],
    },
]


def seed():
    initialize_database()
    db = SessionLocal()
    try:
        # 1. Create or find namespace
        ns = db.query(KnowledgeNamespace).filter(
            KnowledgeNamespace.namespace_code == "billing_public"
        ).first()
        if not ns:
            ns = KnowledgeNamespace(
                namespace_code="billing_public",
                tenant_id=0,
                allowed_domains='["billing","help","dashboard"]',
                description="Zoiko Billing public knowledge base — product documentation and policies",
            )
            db.add(ns)
            db.flush()
            print(f"Created namespace: billing_public (id={ns.id})")
        else:
            print(f"Namespace billing_public already exists (id={ns.id})")

        # 2. Create source
        src = db.query(KnowledgeSource).filter(
            KnowledgeSource.namespace_id == ns.id,
            KnowledgeSource.title == "Zoiko Billing Knowledge Base",
        ).first()
        if not src:
            src = KnowledgeSource(
                namespace_id=ns.id,
                source_type=KnowledgeSourceDocType.DOC,
                classification=KnowledgeClassification.INTERNAL,
                owner_team="billing",
                title="Zoiko Billing Knowledge Base",
                status="active",
            )
            db.add(src)
            db.flush()
            print(f"Created source: id={src.id}")
        else:
            print(f"Source already exists (id={src.id})")

        # 3. Create documents + chunks (hash-based: a changed chunk set
        # supersedes the old document version instead of being skipped, so
        # content fixes actually reach the retrieval index)
        import hashlib
        from datetime import datetime, timezone

        created_docs = 0
        refreshed_docs = 0
        created_chunks = 0
        for entry in KB_ENTRIES:
            chunks = entry["chunks"]
            content_hash = hashlib.sha256("\n".join(chunks).encode("utf-8")).hexdigest()
            docs = db.query(KnowledgeDocument).filter(
                KnowledgeDocument.source_id == src.id,
                KnowledgeDocument.title == entry["title"],
                KnowledgeDocument.status == "approved",
            ).all()
            if any(d.document_hash == content_hash for d in docs):
                print(f"  Doc unchanged: {entry['title']}")
                continue
            for d in docs:
                d.status = "superseded"
                d.freshness_status = FreshnessStatus.EXPIRED
                d.superseded_at = datetime.now(timezone.utc)
            versions = []
            for d in docs:
                try:
                    versions.append(int(d.document_version))
                except (TypeError, ValueError):
                    versions.append(1)
            doc = KnowledgeDocument(
                source_id=src.id,
                document_version=(max(versions) + 1) if versions else 1,
                document_hash=content_hash,
                freshness_status=FreshnessStatus.CURRENT,
                title=entry["title"],
                status="approved",
            )
            db.add(doc)
            db.flush()
            if docs:
                refreshed_docs += 1
            else:
                created_docs += 1
            for seq, chunk_text in enumerate(chunks, 1):
                db.add(KnowledgeChunk(
                    document_id=doc.id,
                    chunk_sequence=seq,
                    chunk_text=chunk_text,
                    classification=KnowledgeClassification.INTERNAL,
                ))
                created_chunks += 1

        db.commit()
        print(f"\nSeeded: {created_docs} new, {refreshed_docs} refreshed, {created_chunks} chunks")
        print("Knowledge base ready.")
    except Exception as e:
        db.rollback()
        print(f"Error: {e}")
        import traceback
        traceback.print_exc()
    finally:
        db.close()


if __name__ == "__main__":
    seed()
