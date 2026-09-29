import json
import re
import sys
import os

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
from app.services.email_foundation.renderer import render_template_by_id
from app.modules.notifications.template_registry import TEMPLATE_REGISTRY, NotificationTier

print(f'Testing render_template_by_id for all {len(TEMPLATE_REGISTRY)} registered templates...')
unrendered_errors = []

SAMPLE_CONTEXT = {
    'recipient_first_name': 'Alex',
    'organization_name': 'Acme Corp',
    'company_name': 'Zoiko Billing',
    'sender_identity': 'Zoiko Billing',
    'preheader': 'Your notification details',
    'invoice_number': 'INV-1001',
    'invoice_due_date_local': '2026-10-15',
    'due_date': '2026-10-15',
    'balance_due': 'USD 100.00',
    'invoice_balance_due_formatted': 'USD 100.00',
    'customer_name': 'Acme Customer',
    'plan_name': 'Enterprise Plan',
    'subscription_name': 'Enterprise Pro',
    'subscription_number': 'SUB-5001',
    'quote_number': 'Q-2001',
    'estimate_number': 'EST-101',
    'credit_note_number': 'CN-3001',
    'debit_note_number': 'DN-4001',
    'payment_reference': 'PAY-6001',
    'payment_amount_formatted': 'USD 250.00',
    'amount': 'USD 250.00',
    'amount_formatted': 'USD 250.00',
    'refund_reference': 'REF-7001',
    'dispute_reference': 'DISP-8001',
    'api_key_name': 'Production API Key',
    'charge_reference': 'CHG-9001',
    'commercial_subscription_change_effective_date_local': '2026-11-01',
    'commercial_subscription_renewal_date_local': '2026-12-01',
    'commercial_subscription_trial_end_date_local': '2026-10-31',
    'effective_date': '2026-11-01',
    'renewal_date': '2026-12-01',
    'trial_end_date': '2026-10-31',
    'event_title': 'Zoiko Billing Global Summit',
    'event_public_title': 'Zoiko Billing Global Summit',
    'feature_name': 'Multi-Currency Settlement',
    'incident_title': 'Webhook Delivery Delay',
    'incident_public_title': 'Webhook Delivery Delay',
    'installment_due_date_local': '2026-10-15',
    'integration_name': 'QuickBooks Online',
    'jurisdiction_name': 'United Kingdom (HMRC)',
    'maintenance_date': '2026-10-20',
    'maintenance_start_date_local': '2026-10-20',
    'member_name': 'Jane Doe',
    'member_full_name': 'Jane Doe',
    'organization_billing_sender_name': 'Acme Billing',
    'sender_name': 'Acme Billing',
    'payment_next_retry_date_local': '2026-10-18',
    'retry_date': '2026-10-18',
    'privacy_request_reference': 'DSR-1001',
    'request_reference': 'DSR-1001',
    'promise_due_date_local': '2026-10-25',
    'promise_due_date': '2026-10-25',
    'recipient_email_masked': 'a***@example.com',
    'email_masked': 'a***@example.com',
    'reconciliation_period_display': 'September 2026',
    'reconciliation_period': 'September 2026',
    'release_public_title': 'Zoiko Billing 2.5 Release',
    'release_title': 'Zoiko Billing 2.5 Release',
    'report_name': 'Monthly Revenue Summary',
    'report_period_display': 'September 2026',
    'report_period': 'September 2026',
    'sender_domain_name': 'mail.acme.com',
    'domain_name': 'mail.acme.com',
    'subscription_cancellation_date_local': '2026-10-30',
    'cancellation_date': '2026-10-30',
    'subscription_current_period_end_local': '2026-10-31',
    'period_end_date': '2026-10-31',
    'subscription_trial_end_date_local': '2026-10-31',
    'support_case_reference': 'CASE-5541',
    'case_reference': 'CASE-5541',
    'ticket_id': 'TICK-5541',
    'usage_billing_period_display': '2026-09-01 to 2026-09-30',
    'billing_period': '2026-09-01 to 2026-09-30',
    'usage_meter_name': 'API Call Meter',
    'meter_name': 'API Call Meter',
    'usage_threshold_formatted': '100,000 requests (90%)',
    'threshold_formatted': '100,000 requests (90%)',
    'webhook_endpoint_display': 'https://api.acme.com/webhooks/zoiko',
    'webhook_endpoint': 'https://api.acme.com/webhooks/zoiko',
    'primary_action_url': 'https://app.zoikobilling.com/action',
    'invoice_url': 'https://app.zoikobilling.com/invoices/INV-1001',
    'exception_url': 'https://app.zoikobilling.com/reconciliation/exceptions/1',
    'incident_url': 'https://app.zoikobilling.com/ops/incidents/1',
    'settings_url': 'https://app.zoikobilling.com/settings',
    'verify_url': 'https://app.zoikobilling.com/verify?token=xyz',
    'reset_url': 'https://app.zoikobilling.com/reset?token=xyz',
    'signin_code': '123456',
    'magic_link_url': 'https://app.zoikobilling.com/portal/magic?token=xyz',
    'reason': 'Invoice issued in error',
    'ticket_reference': 'TICKET-999',
}

for tid, meta in TEMPLATE_REGISTRY.items():
    ctx = dict(SAMPLE_CONTEXT)
    if meta.tier in (NotificationTier.T3, NotificationTier.T4):
        ctx['unsubscribe_url'] = 'https://app.zoikobilling.com/unsubscribe?token=xyz'
    
    html = render_template_by_id(tid, ctx)
    
    leftover = re.findall(r'\{\{[a-zA-Z0-9_.]+\}\}', html)
    if leftover:
        unrendered_errors.append((tid, leftover))

print(f'Testing complete. Leftover errors: {len(unrendered_errors)}')
if unrendered_errors:
    for tid, errs in unrendered_errors[:10]:
        print(f'  {tid}: {errs}')
else:
    print('ALL TEMPLATES RENDERED PERFECTLY WITH ZERO UNRENDERED PLACEHOLDERS!')
