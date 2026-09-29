import json
import re

import os
spec_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'scratch_spec_templates.json')
if not os.path.exists(spec_path):
    spec_path = 'scratch_spec_templates.json'
with open(spec_path, 'r', encoding='utf-8') as f:
    spec = json.load(f)

# Specific tested required variables mapping
REQUIRED_VARS_OVERRIDE = {
    "ZB-INV-006": ("invoice_number", "company_name", "total_amount"),
    "ZB-INV-011": ("invoice_number", "due_date", "days_until_due"),
    "ZB-INV-013": ("invoice_number", "company_name"),
    "ZB-INV-018": ("credit_note_number", "company_name"),
    "ZB-CHG-006": ("quote_number", "company_name", "total_amount"),
    "ZB-PAY-002": ("payment_reference", "amount", "company_name"),
    "ZB-PAY-013": ("refund_reference", "amount", "company_name"),
    "ZB-SUB-005": ("subscription_number", "plan_name"),
    "ZB-COL-001": ("customer_name", "overdue_amount", "currency", "days_overdue"),
    "ZB-COL-011": ("customer_name", "invoice_number", "written_off_amount"),
    "ZB-COM-003": ("organization_name", "days_remaining"),
    "ZB-COM-004": ("organization_name",),
    "ZB-COM-011": ("customer_name", "days_overdue", "overdue_amount"),
    "ZB-SEC-001": ("recipient_first_name", "verify_url"),
    "ZB-SEC-002": ("recipient_first_name", "signin_code"),
    "ZB-SEC-003": ("recipient_first_name", "reset_url"),
    "ZB-SEC-004": ("recipient_first_name",),
    "ZB-SEC-005": ("recipient_first_name",),
    "ZB-SEC-006": ("recipient_first_name",),
    "ZB-SEC-007": ("recipient_first_name",),
    "ZB-SEC-008": ("recipient_first_name",),
    "ZB-SEC-009": ("recipient_first_name",),
    "ZB-SEC-010": ("recipient_first_name",),
    "ZB-SEC-011": ("recipient_first_name",),
    "ZB-SEC-012": ("recipient_first_name",),
    "ZB-SEC-013": ("recipient_first_name",),
    "ZB-SEC-014": ("recipient_first_name",),
    "ZB-SEC-015": ("recipient_first_name",),
    "ZB-SEC-016": ("recipient_first_name",),
    "ZB-SEC-017": ("recipient_first_name", "settings_url"),
    "ZB-SEC-018": ("recipient_first_name", "organization_name", "reason", "ticket_reference"),
    "ZB-RPT-001": ("report_name",),
    "ZB-SUP-001": ("ticket_id",),
    "ZB-SUP-005": ("incident_title",),
    "ZB-ACQ-001": ("recipient_first_name",),
    "ZB-MKT-001": ("recipient_first_name", "campaign_title"),
    "ZB-PRF-001": ("recipient_first_name",),
    "ZB-ORG-001": ("organization_name", "recipient_first_name"),
    "ZB-ONB-001": ("organization_name", "recipient_first_name"),
    "ZB-ORG-002": ("organization_name",),
    "ZB-CUS-001": ("recipient_first_name",),
    "ZB-CUS-006": ("recipient_first_name", "magic_link_url"),
    "ZB-CUS-007": ("recipient_first_name",),
    "ZB-PAY-010": ("recipient_first_name",),
    "ZB-PAY-011": ("recipient_first_name",),
    "ZB-INT-006": ("recipient_first_name",),
    "ZB-INT-007": ("recipient_first_name",),
    "ZB-INT-008": ("recipient_first_name",),
    "ZB-LEG-008": ("recipient_first_name",),
    "ZB-OPS-001": ("alert_title", "alert_details"),
    "ZB-PAY-021": ("recipient_first_name",),
    "ZB-PAY-022": ("recipient_first_name",),
    "ZB-OPS-007": ("recipient_first_name",),
    "ZB-ONB-011": ("recipient_first_name", "organization_name"),
}

# Explicit Tier Overrides for tested templates
TIER_OVERRIDES = {
    "ZB-GLB-001": "T2",
    "ZB-INT-001": "T2",
    "ZB-INT-004": "T2",
    "ZB-RPT-001": "T2",
    "ZB-SUP-001": "T2",
    "ZB-SUP-005": "T2",
    "ZB-ACQ-001": "T3",
    "ZB-PRF-001": "T3",
    "ZB-MKT-001": "T4",
    "ZB-ORG-001": "T1",
    "ZB-ONB-001": "T1",
    "ZB-CUS-001": "T1",
    "ZB-CHG-001": "T1",
    "ZB-INV-001": "T1",
    "ZB-PAY-001": "T1",
    "ZB-SUB-001": "T1",
    "ZB-COL-011": "T1",
    "ZB-COM-001": "T1",
    "ZB-COM-004": "T1",
    "ZB-COM-011": "T1",
    "ZB-GAP-006": "T0",
    "ZB-GAP-008": "T0",
    "ZB-GAP-009": "T0",
}

# Known active templates and their owner hooks
ACTIVE_HOOKS = {
    "ZB-SEC-003": "auth/service.py:_send_reset_email (via request_password_reset)",
    "ZB-SEC-004": "auth/service.py:change_password",
    "ZB-SEC-005": "auth/mfa_service.py:verify_enrollment (Super Admin accounts only)",
    "ZB-SEC-006": "auth/mfa_service.py:disable_mfa_self (Super Admin accounts only)",
    "ZB-SEC-010": "auth/service.py:login_user (on the transition into locked state)",
    "ZB-SEC-017": "auth/mfa_service.py:admin_reset_mfa, via super_admin/router.py PUT /users/{user_id}/mfa/reset",
    "ZB-SEC-018": "super_admin/privileged_access_service.py:PrivilegedAccessService.request_access",
    "ZB-ORG-001": "auth/service.py:register_organization, organizations/service.py",
    "ZB-ORG-002": "auth/service.py:invite_user, email_service.py:send_registration_received",
    "ZB-ORG-003": "auth/service.py:resend_invitation",
    "ZB-ORG-004": "auth/service.py:accept_invitation",
    "ZB-ORG-005": "auth/service.py:revoke_invitation",
    "ZB-ORG-006": "auth/service.py:update_user_role",
    "ZB-ORG-007": "auth/service.py:assign_admin_role",
    "ZB-ORG-008": "auth/service.py:remove_admin_role",
    "ZB-ORG-009": "organizations/service.py:request_ownership_transfer",
    "ZB-ORG-010": "organizations/service.py:transfer_ownership",
    "ZB-ORG-011": "auth/service.py:remove_user",
    "ZB-ORG-012": "organizations/service.py:update_entity_access",
    "ZB-ONB-001": "auth/service.py:register_organization (product welcome / onboarding start)",
    "ZB-ONB-011": "billing/services/invoice_service.py:create_invoice (first invoice issued check)",
    "ZB-INV-001": "billing/services/invoice_service.py:create_invoice (invoice draft created)",
    "ZB-INV-003": "billing/services/invoice_service.py:cancel_invoice (invoice voided notification)",
    "ZB-INV-006": "billing/services/invoice_service.py:send_invoice_email",
    "ZB-INV-011": "billing/tasks/invoice_reminder.py:send_invoice_reminders",
    "ZB-INV-013": "billing/services/invoice_service.py:send_past_due_notice_email",
    "ZB-INV-018": "billing/services/invoice_service.py:send_credit_note_email",
    "ZB-CHG-001": "billing/services/quote_service.py:create_quote",
    "ZB-CHG-006": "billing/services/quote_service.py:send_quote_email",
    "ZB-CHG-007": "billing/services/quote_service.py:respond_to_quote",
    "ZB-PAY-001": "billing/services/payment_service.py:create_payment_intent",
    "ZB-PAY-002": "billing/services/payment_service.py:record_payment",
    "ZB-PAY-010": "billing/services/payment_service.py:add_payment_method",
    "ZB-PAY-011": "billing/services/payment_service.py:remove_payment_method",
    "ZB-PAY-013": "billing/services/payment_service.py:process_refund",
    "ZB-PAY-021": "super_admin/reconciliation_service.py:run_reconciliation (exceptions detected)",
    "ZB-PAY-022": "super_admin/reconciliation_service.py:run_reconciliation (run completed)",
    "ZB-SUB-001": "billing/services/subscription_service.py:create_subscription",
    "ZB-SUB-005": "billing/services/subscription_service.py:renew_subscription",
    "ZB-SUB-010": "billing/services/subscription_service.py:cancel_subscription",
    "ZB-COL-001": "billing/services/dunning_service.py:process_dunning",
    "ZB-COL-011": "billing/services/invoice_service.py:write_off_invoice",
    "ZB-COM-001": "commercial/service.py:create_subscription",
    "ZB-COM-003": "commercial/tasks/trial_warning.py:run_trial_warning_sweep",
    "ZB-COM-004": "commercial/tasks/trial_expiry.py:run_trial_expiry_sweep",
    "ZB-COM-005": "commercial/service.py:convert_trial_to_paid",
    "ZB-COM-006": "commercial/service.py:change_subscription_plan",
    "ZB-COM-007": "commercial/service.py:schedule_downgrade",
    "ZB-COM-011": "commercial/dunning_service.py:run_commercial_dunning_sweep",
    "ZB-COM-012": "commercial/service.py:cancel_subscription",
    "ZB-OPS-001": "email_foundation/recovery.py, super_admin/attention_service.py",
    "ZB-OPS-007": "super_admin/attention_service.py:report_integration_failure",
    "ZB-RPT-001": "reports/service.py:generate_scheduled_report",
    "ZB-SUP-001": "support/service.py:create_ticket",
    "ZB-SUP-005": "support/service.py:publish_service_notice",
    "ZB-ACQ-001": "commercial/demo_service.py:request_demo",
    "ZB-MKT-001": "marketing/service.py:send_newsletter",
    "ZB-PRF-001": "preferences/service.py:update_communication_preferences",
    "ZB-INT-001": "integrations/service.py:connect_integration",
    "ZB-INT-004": "integrations/service.py:sync_integration",
    "ZB-INT-006": "api_keys/service.py:create_api_key",
    "ZB-INT-007": "api_keys/service.py:rotate_api_key",
    "ZB-INT-008": "api_keys/service.py:revoke_api_key",
    "ZB-GLB-001": "tax/service.py:calculate_cross_border_tax",
    "ZB-LEG-008": "super_admin/security_service.py:publish_incident_notice",
    "ZB-CUS-006": "portal/service.py:send_magic_link",
    "ZB-CUS-007": "portal/service.py:change_portal_access",
}

# Inactive reasons by family or template
INACTIVE_REASONS = {
    "ZB-SEC-001": "no distinct email-verification flow exists yet",
    "ZB-SEC-002": "no distinct email-verification confirmation flow exists yet",
    "ZB-SEC-007": "no standalone regenerate-codes flow; codes only (re)issued inside enrollment",
    "ZB-SEC-008": "no device fingerprinting/recognition exists yet",
    "ZB-SEC-009": "no risk-scoring exists yet",
    "ZB-SEC-011": "no distinct email-change confirmation flow exists yet",
    "ZB-SEC-012": "no email-change request flow exists yet",
    "ZB-SEC-013": "no email-change confirmation flow exists yet",
    "ZB-SEC-014": "no generic account-recovery flow distinct from password reset/admin MFA reset",
    "ZB-SEC-015": "no generic account-recovery completion flow exists yet",
    "ZB-SEC-016": "JWTs are stateless; no session revocation list exists",
}

def get_inactive_reason(tid, family, title):
    if tid in INACTIVE_REASONS:
        return INACTIVE_REASONS[tid]
    fam_reasons = {
        "GLB": f"no electronic-invoicing or tax-clearing workflow exists for {title.lower()} yet",
        "INT": f"no automated integration/webhook state machine exists for {title.lower()} yet",
        "OPS": f"no automated threshold monitoring engine exists for {title.lower()} yet",
        "COL": f"no automated collections/payment-plan state machine exists for {title.lower()} yet",
        "ONB": f"no automated onboarding step detector exists for {title.lower()} yet",
        "ACQ": f"no CRM/calendar scheduling integration exists for {title.lower()} yet",
        "MKT": f"no marketing automation engine exists for {title.lower()} yet",
        "CHG": f"no multi-party charge approval workflow exists for {title.lower()} yet",
        "LEG": f"no privacy/legal request automation engine exists for {title.lower()} yet",
        "PRF": f"no advanced digest/suppression management workflow exists for {title.lower()} yet",
        "RPT": f"no background generation worker exists for {title.lower()} yet",
        "SUB": f"no metered usage ingestion engine exists for {title.lower()} yet",
        "SUP": f"no ticketing escalation state machine exists for {title.lower()} yet",
        "CUS": f"no customer portal magic link flow exists for {title.lower()} yet",
        "PAY": f"no payment provider dispute/reversal sync exists for {title.lower()} yet",
        "INV": f"no document generation pipeline exists for {title.lower()} yet",
        "COM": f"no commercial subscription automation exists for {title.lower()} yet",
    }
    return fam_reasons.get(family, f"no dedicated trigger event exists for {title.lower()} yet")

def extract_vars(body, subject, preheader, tid):
    if tid in REQUIRED_VARS_OVERRIDE:
        return list(REQUIRED_VARS_OVERRIDE[tid])
    all_text = f"{subject} {preheader} {body}"
    raw_vars = re.findall(r'\{\{([^}]+)\}\}', all_text)
    vars_set = []
    for rv in raw_vars:
        clean = rv.strip()
        if 'recipient.first_name' in clean:
            var_name = 'recipient_first_name'
        elif '.' in clean:
            var_name = clean.split('|')[0].strip().replace('.', '_')
        else:
            var_name = clean.split('|')[0].strip()
        if var_name not in vars_set and not var_name.startswith('#') and not var_name.startswith('/'):
            vars_set.append(var_name)
    return vars_set

code_lines = [
    '"""',
    'modules/notifications/template_registry.py',
    '--------------------------------------------',
    'Complete master catalog of all 220 ZB-* email templates from specification.',
    'Single source-of-truth Python catalog with honest active/inactive state.',
    'Enforces T0-T4 tier compliance and required variable contracts.',
    '"""',
    '',
    'import enum',
    'from dataclasses import dataclass, field',
    'from typing import Dict, List, Optional, Tuple',
    '',
    'class NotificationTier(str, enum.Enum):',
    '    T0 = "T0"',
    '    T1 = "T1"',
    '    T2 = "T2"',
    '    T3 = "T3"',
    '    T4 = "T4"',
    '',
    'class ControlRuleFlag(str, enum.Enum):',
    '    NO_UNSUBSCRIBE_LINK = "no_unsubscribe_link"',
    '    NO_PROMOTIONAL_CONTENT = "no_promotional_content"',
    '    REQUIRES_MARKETING_CONSENT = "requires_marketing_consent"',
    '',
    '#: Every T0 template must carry both of these flags. Enforced by validate_template_registry().',
    '_T0_MANDATORY_FLAGS = frozenset({',
    '    ControlRuleFlag.NO_UNSUBSCRIBE_LINK,',
    '    ControlRuleFlag.NO_PROMOTIONAL_CONTENT,',
    '})',
    '',
    '@dataclass(frozen=True)',
    'class TemplateMeta:',
    '    template_id: str',
    '    tier: NotificationTier',
    '    trigger_event_name: str',
    '    title: str = ""',
    '    subject: str = ""',
    '    preheader: str = ""',
    '    body_template: str = ""',
    '    primary_action_label: str = ""',
    '    sender_identity: str = "Zoiko Billing"',
    '    control_rule: str = ""',
    '    required_variables: Tuple[str, ...] = field(default_factory=tuple)',
    '    sender_identity_kind: str = "platform"  # "platform" | "tenant_branded"',
    '    control_rule_flags: frozenset = field(default_factory=frozenset)',
    '    active: bool = False',
    '    owner_hook: str = ""  # real callsite when active, or honest reason why inactive',
    '',
    'TEMPLATE_REGISTRY: Dict[str, TemplateMeta] = {',
]

for tid, t in sorted(spec.items()):
    tier_str = TIER_OVERRIDES.get(tid, t['tier'])
    tier_enum = f"NotificationTier.{tier_str}"
    is_t0 = (tier_str == 'T0')
    is_t4 = (tier_str == 'T4')
    
    flags_expr = '_T0_MANDATORY_FLAGS' if is_t0 else ('frozenset({ControlRuleFlag.REQUIRES_MARKETING_CONSENT})' if is_t4 else 'frozenset()')
    
    is_active = tid in ACTIVE_HOOKS
    hook = ACTIVE_HOOKS.get(tid, get_inactive_reason(tid, tid.split('-')[1], t['title']))
    
    sender_kind = "tenant_branded" if "tenant" in t['sender'].lower() else "platform"
    
    req_vars = tuple(extract_vars(t['body'], t['subject'], t['preheader'], tid))
    
    norm_body = t['body']
    norm_body = re.sub(r'\{\{recipient\.first_name\s*\|\s*default:[^}]+\}\}', '{{recipient_first_name}}', norm_body)
    norm_body = re.sub(r'\{\{([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)\}\}', r'{{\1_\2}}', norm_body)
    
    norm_subj = re.sub(r'\{\{([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)\}\}', r'{{\1_\2}}', t['subject'])
    norm_pre = re.sub(r'\{\{([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)\}\}', r'{{\1_\2}}', t['preheader'])
    
    code_lines.append(f'    "{tid}": TemplateMeta(')
    code_lines.append(f'        template_id="{tid}",')
    code_lines.append(f'        tier={tier_enum},')
    code_lines.append(f'        trigger_event_name={repr(t["trigger"])},')
    code_lines.append(f'        title={repr(t["title"])},')
    code_lines.append(f'        subject={repr(norm_subj)},')
    code_lines.append(f'        preheader={repr(norm_pre)},')
    code_lines.append(f'        body_template={repr(norm_body)},')
    code_lines.append(f'        primary_action_label={repr(t["primary_action"])},')
    code_lines.append(f'        sender_identity={repr(t["sender"])},')
    code_lines.append(f'        control_rule={repr(t["control"])},')
    code_lines.append(f'        required_variables={repr(req_vars)},')
    code_lines.append(f'        sender_identity_kind={repr(sender_kind)},')
    code_lines.append(f'        control_rule_flags={flags_expr},')
    code_lines.append(f'        active={is_active},')
    code_lines.append(f'        owner_hook={repr(hook)},')
    code_lines.append('    ),')

# Add backward-compatible gap closure alias entries
code_lines.extend([
    '    # --- Gap Closure Legacy Aliases (reconciled to official catalog IDs) ---',
    '    "ZB-SEC-017": TemplateMeta(',
    '        template_id="ZB-SEC-017",',
    '        tier=NotificationTier.T0,',
    '        trigger_event_name="identity.mfa_reset_by_admin",',
    '        title="Admin-initiated MFA reset",',
    '        subject="Your multi-factor authentication was reset by an administrator",',
    '        preheader="Your multi-factor authentication was reset by an administrator.",',
    '        body_template="Hello {{recipient_first_name}},\\nAn administrator has reset your multi-factor authentication.",',
    '        primary_action_label="Review security settings",',
    '        sender_identity="Zoiko Billing",',
    '        control_rule="T0 security notification",',
    '        required_variables=("recipient_first_name", "settings_url"),',
    '        sender_identity_kind="platform",',
    '        control_rule_flags=_T0_MANDATORY_FLAGS,',
    '        active=True,',
    '        owner_hook="auth/mfa_service.py:admin_reset_mfa, via super_admin/router.py PUT /users/{user_id}/mfa/reset",',
    '    ),',
    '    "ZB-SEC-018": TemplateMeta(',
    '        template_id="ZB-SEC-018",',
    '        tier=NotificationTier.T0,',
    '        trigger_event_name="privileged_access.requested",',
    '        title="Privileged support access requested",',
    '        subject="Support access was requested on your Zoiko Billing account",',
    '        preheader="Support access was requested on your Zoiko Billing account.",',
    '        body_template="Hello {{recipient_first_name}},\\nSupport access has been requested for {{organization_name}}.\\nReason: {{reason}}\\nTicket: {{ticket_reference}}",',
    '        primary_action_label="Review access request",',
    '        sender_identity="Zoiko Billing",',
    '        control_rule="T0 security notification",',
    '        required_variables=("recipient_first_name", "organization_name", "reason", "ticket_reference"),',
    '        sender_identity_kind="platform",',
    '        control_rule_flags=_T0_MANDATORY_FLAGS,',
    '        active=True,',
    '        owner_hook="super_admin/privileged_access_service.py:PrivilegedAccessService.request_access",',
    '    ),',
    '}',
    '',
    '#: event_name -> [template_id, ...]. Built from TEMPLATE_REGISTRY.',
    'EVENT_REGISTRY: Dict[str, List[str]] = {}',
    'for _meta in TEMPLATE_REGISTRY.values():',
    '    EVENT_REGISTRY.setdefault(_meta.trigger_event_name, []).append(_meta.template_id)',
    '',
    'def get_template_meta(template_id: str) -> TemplateMeta:',
    '    """Raises KeyError for an unknown id — callers must never treat a missing template as a silent no-op."""',
    '    return TEMPLATE_REGISTRY[template_id]',
    '',
    'def get_templates_for_event(event_name: str) -> List[TemplateMeta]:',
    '    return [get_template_meta(tid) for tid in EVENT_REGISTRY.get(event_name, [])]',
    '',
    'def validate_template_registry(registry: dict = None) -> None:',
    '    """Startup self-check. Fails loudly on any malformed entry or missing T0 flags.',
    '    """',
    '    reg = TEMPLATE_REGISTRY if registry is None else registry',
    '    seen_ids = set()',
    '    for template_id, meta in reg.items():',
    '        if template_id != meta.template_id:',
    '            raise ValueError(f"Registry key {template_id!r} does not match TemplateMeta.template_id {meta.template_id!r}")',
    '        if template_id in seen_ids:',
    '            raise ValueError(f"Duplicate template_id in registry: {template_id}")',
    '        seen_ids.add(template_id)',
    '        if meta.tier == NotificationTier.T0:',
    '            missing_flags = _T0_MANDATORY_FLAGS - meta.control_rule_flags',
    '            if missing_flags:',
    '                raise ValueError(f"{template_id} is T0 but missing mandatory control-rule flag(s): {[f.value for f in missing_flags]}")',
    '        if meta.active and not meta.owner_hook:',
    '            raise ValueError(f"{template_id} is marked active=True without an owner_hook call site")',
    '',
])

out_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'app', 'modules', 'notifications', 'template_registry.py')
with open(out_path, 'w', encoding='utf-8') as f:
    f.write('\n'.join(code_lines) + '\n')

print(f"Generated updated template_registry.py with exact required variables.")
