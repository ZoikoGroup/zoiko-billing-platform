from app.database import Base
from app.modules.organizations.models import Organization
from app.modules.billing.models import Invoice, InvoiceStatus
from app.modules.chatbot.conversation.engine import ConversationEngine
from app.modules.chatbot.context.ai_context import AIContext
from app.modules.chatbot.models import AIConversation, ConversationStatus
from sqlalchemy import create_engine
from sqlalchemy.orm import Session
from datetime import date, datetime

engine = create_engine('sqlite:///:memory:')
Base.metadata.create_all(engine)
db = Session(engine)

o = Organization(organization_name='Zoiko Test', organization_code='ZT1')
db.add(o)
db.flush()

# Add some test invoices - mix of statuses
inv1 = Invoice(
    invoice_number='INV-001',
    organization_id=o.id,
    customer_id=1,
    status=InvoiceStatus.SENT,
    issue_date=date.today(),
    due_date=date.today(),
    subtotal=100.00,
    total_amount=100.00
)
inv2 = Invoice(
    invoice_number='INV-002', 
    organization_id=o.id,
    customer_id=1,
    status=InvoiceStatus.PAID,
    issue_date=date.today(),
    due_date=date.today(),
    balance_due=0.00,
    subtotal=50.00,
    total_amount=50.00
)
inv3 = Invoice(
    invoice_number='INV-003',
    organization_id=o.id,
    customer_id=1,
    status=InvoiceStatus.OVERDUE,
    issue_date=date.today(),
    due_date=date.today(),  # yesterday would be overdue
    balance_due=200.00,
    subtotal=200.00,
    total_amount=200.00
)
inv4 = Invoice(
    invoice_number='INV-004',
    organization_id=o.id,
    customer_id=1,
    status=InvoiceStatus.PARTIALLY_PAID,
    issue_date=date.today(),
    due_date=date.today(),
    balance_due=50.00,
    subtotal=100.00,
    total_amount=100.00
)
db.add_all([inv1, inv2, inv3, inv4])
db.commit()

conv = AIConversation(
    conversation_uid='c1', tenant_context_id=1, organization_id=o.id,
    user_id=1, title='t', conversation_status=ConversationStatus.OPEN,
)
db.add(conv)
db.flush()

ctx = AIContext(
    organization_id=o.id, user_id=1, tenant_context_id=1, role='admin',
    permissions=[], request_id='test', tenant_name='Zoiko Test',
)

ce = ConversationEngine(db, model_gateway=None)

# Test "how many open invoices" (plural)
print("=== Test 1: 'how many open invoices' ===")
try:
    result = ce._process_message(conv, 'how many open invoices', ctx)
    print('Answer:', result.get('answer'))
    print('Mode:', result.get('mode'))
except Exception as e:
    import traceback
    traceback.print_exc()

print()

# Test "how many open invoice" (singular)
print("=== Test 2: 'how many open invoice' ===")
try:
    result = ce._process_message(conv, 'how many open invoice', ctx)
    print('Answer:', result.get('answer'))
    print('Mode:', result.get('mode'))
except Exception as e:
    import traceback
    traceback.print_exc()