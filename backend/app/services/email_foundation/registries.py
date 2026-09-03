"""
email_foundation/registries.py
------------------------------
Event and Template Registries for the Zoiko Billing Email System.

Verbatim template IDs and trigger events sourced from specification.
Activation states are ACTIVE for implemented trigger events in codebase.
"""

from dataclasses import dataclass, field
from typing import Dict, List, Optional
from app.services.email_foundation.enums import TemplateTier, ActivationState


@dataclass
class TemplateDefinition:
    id: str
    tier: TemplateTier
    family: str
    required_variables: List[str] = field(default_factory=list)
    activation_state: ActivationState = ActivationState.ACTIVE
    description: str = ""


# Template Registry: ID -> TemplateDefinition
TEMPLATE_REGISTRY: Dict[str, TemplateDefinition] = {
    # --- SEC Family (Tier 0 Security & Identity) ---
    "ZB-SEC-001": TemplateDefinition("ZB-SEC-001", TemplateTier.T0, "SEC", ["recipient_first_name", "verify_url"], ActivationState.ACTIVE, "Verify email address"),
    "ZB-SEC-002": TemplateDefinition("ZB-SEC-002", TemplateTier.T0, "SEC", ["recipient_first_name", "signin_code"], ActivationState.ACTIVE, "Sign-in verification code"),
    "ZB-SEC-003": TemplateDefinition("ZB-SEC-003", TemplateTier.T0, "SEC", ["recipient_first_name", "reset_url"], ActivationState.ACTIVE, "Password reset requested"),
    "ZB-SEC-004": TemplateDefinition("ZB-SEC-004", TemplateTier.T0, "SEC", ["recipient_first_name"], ActivationState.ACTIVE, "Password changed"),
    "ZB-SEC-005": TemplateDefinition("ZB-SEC-005", TemplateTier.T0, "SEC", ["recipient_first_name"], ActivationState.ACTIVE, "Multi-factor authentication enabled"),
    "ZB-SEC-006": TemplateDefinition("ZB-SEC-006", TemplateTier.T0, "SEC", ["recipient_first_name"], ActivationState.ACTIVE, "Multi-factor authentication disabled"),
    "ZB-SEC-007": TemplateDefinition("ZB-SEC-007", TemplateTier.T0, "SEC", ["recipient_first_name"], ActivationState.ACTIVE, "Recovery codes regenerated"),
    "ZB-SEC-008": TemplateDefinition("ZB-SEC-008", TemplateTier.T0, "SEC", ["recipient_first_name"], ActivationState.ACTIVE, "New-device sign-in"),
    "ZB-SEC-009": TemplateDefinition("ZB-SEC-009", TemplateTier.T0, "SEC", ["recipient_first_name"], ActivationState.ACTIVE, "Suspicious sign-in blocked"),
    "ZB-SEC-010": TemplateDefinition("ZB-SEC-010", TemplateTier.T0, "SEC", ["recipient_first_name"], ActivationState.ACTIVE, "Account temporarily locked"),
    "ZB-SEC-011": TemplateDefinition("ZB-SEC-011", TemplateTier.T0, "SEC", ["recipient_first_name"], ActivationState.ACTIVE, "Email-address change requested"),
    "ZB-SEC-012": TemplateDefinition("ZB-SEC-012", TemplateTier.T0, "SEC", ["recipient_first_name"], ActivationState.ACTIVE, "Email address changed"),
    "ZB-SEC-013": TemplateDefinition("ZB-SEC-013", TemplateTier.T0, "SEC", ["recipient_first_name"], ActivationState.ACTIVE, "Account recovery started"),
    "ZB-SEC-014": TemplateDefinition("ZB-SEC-014", TemplateTier.T0, "SEC", ["recipient_first_name"], ActivationState.ACTIVE, "Account recovery completed"),
    "ZB-SEC-015": TemplateDefinition("ZB-SEC-015", TemplateTier.T0, "SEC", ["recipient_first_name"], ActivationState.ACTIVE, "Active session or trusted device revoked"),
    "ZB-SEC-016": TemplateDefinition("ZB-SEC-016", TemplateTier.T0, "SEC", ["recipient_first_name"], ActivationState.ACTIVE, "Session revoked by administrator"),

    # --- Gap Closure Templates (PROPOSED - Pending formal catalog approval) ---
    # PROPOSED TEMPLATE ID ZB-SEC-017 (Pending formal catalog approval)
    "ZB-SEC-017": TemplateDefinition("ZB-SEC-017", TemplateTier.T0, "SEC", ["recipient_first_name", "settings_url"], ActivationState.ACTIVE, "Admin-initiated MFA reset"),
    # PROPOSED TEMPLATE ID ZB-SEC-018 (Pending formal catalog approval)
    "ZB-SEC-018": TemplateDefinition("ZB-SEC-018", TemplateTier.T0, "SEC", ["recipient_first_name", "organization_name", "reason", "ticket_reference"], ActivationState.ACTIVE, "Privileged support access requested"),

    # --- Domain T0 Templates ---
    "ZB-CUS-006": TemplateDefinition("ZB-CUS-006", TemplateTier.T0, "CUS", ["recipient_first_name", "magic_link_url"], ActivationState.ACTIVE, "Secure portal sign-in link"),
    "ZB-CUS-007": TemplateDefinition("ZB-CUS-007", TemplateTier.T0, "CUS", ["recipient_first_name"], ActivationState.ACTIVE, "Portal email or access method changed"),
    "ZB-PAY-010": TemplateDefinition("ZB-PAY-010", TemplateTier.T0, "PAY", ["recipient_first_name"], ActivationState.ACTIVE, "Payment method added"),
    "ZB-PAY-011": TemplateDefinition("ZB-PAY-011", TemplateTier.T0, "PAY", ["recipient_first_name"], ActivationState.ACTIVE, "Payment method removed"),
    "ZB-INT-006": TemplateDefinition("ZB-INT-006", TemplateTier.T0, "INT", ["recipient_first_name"], ActivationState.ACTIVE, "API key created"),
    "ZB-INT-007": TemplateDefinition("ZB-INT-007", TemplateTier.T0, "INT", ["recipient_first_name"], ActivationState.ACTIVE, "API key rotated"),
    "ZB-INT-008": TemplateDefinition("ZB-INT-008", TemplateTier.T0, "INT", ["recipient_first_name"], ActivationState.ACTIVE, "API key revoked"),
    "ZB-LEG-008": TemplateDefinition("ZB-LEG-008", TemplateTier.T0, "LEG", ["recipient_first_name"], ActivationState.ACTIVE, "Security or privacy incident notice"),

    # --- Internal OPS T0 Templates ---
    "ZB-OPS-001": TemplateDefinition("ZB-OPS-001", TemplateTier.T0, "OPS", ["alert_title", "alert_details"], ActivationState.ACTIVE, "Internal operator system alert"),

    # --- T1 Transactional Templates ---

    # ORG / ONB family
    "ZB-ORG-001": TemplateDefinition("ZB-ORG-001", TemplateTier.T1, "ORG", ["organization_name", "recipient_first_name"], ActivationState.ACTIVE, "Organization provisioned / account created"),
    "ZB-ONB-001": TemplateDefinition("ZB-ONB-001", TemplateTier.T1, "ONB", ["organization_name", "recipient_first_name"], ActivationState.ACTIVE, "Product welcome / onboarding started"),

    # CUS family — Customer Portal
    "ZB-CUS-001": TemplateDefinition("ZB-CUS-001", TemplateTier.T1, "CUS", ["recipient_first_name"], ActivationState.STUB, "Customer portal account created"),
    "ZB-CUS-002": TemplateDefinition("ZB-CUS-002", TemplateTier.T1, "CUS", ["recipient_first_name", "reset_url"], ActivationState.STUB, "Customer portal password reset"),
    "ZB-CUS-003": TemplateDefinition("ZB-CUS-003", TemplateTier.T1, "CUS", ["recipient_first_name"], ActivationState.STUB, "Customer portal password changed"),
    "ZB-CUS-004": TemplateDefinition("ZB-CUS-004", TemplateTier.T1, "CUS", ["recipient_first_name"], ActivationState.STUB, "Customer portal invite accepted"),
    "ZB-CUS-005": TemplateDefinition("ZB-CUS-005", TemplateTier.T1, "CUS", ["recipient_first_name"], ActivationState.STUB, "Customer statement ready"),

    # INV family — Invoice lifecycle
    "ZB-INV-001": TemplateDefinition("ZB-INV-001", TemplateTier.T1, "INV", ["invoice_number"], ActivationState.STUB, "Invoice draft created"),
    "ZB-INV-002": TemplateDefinition("ZB-INV-002", TemplateTier.T1, "INV", ["invoice_number"], ActivationState.STUB, "Invoice approved"),
    "ZB-INV-003": TemplateDefinition("ZB-INV-003", TemplateTier.T1, "INV", ["invoice_number"], ActivationState.STUB, "Invoice voided"),
    "ZB-INV-004": TemplateDefinition("ZB-INV-004", TemplateTier.T1, "INV", ["invoice_number"], ActivationState.STUB, "Invoice write-off notice to customer"),
    "ZB-INV-005": TemplateDefinition("ZB-INV-005", TemplateTier.T1, "INV", ["invoice_number"], ActivationState.STUB, "Invoice dispute filed"),
    "ZB-INV-006": TemplateDefinition("ZB-INV-006", TemplateTier.T1, "INV", ["invoice_number", "company_name", "total_amount"], ActivationState.ACTIVE, "Invoice issued / sent to customer"),
    "ZB-INV-007": TemplateDefinition("ZB-INV-007", TemplateTier.T1, "INV", ["invoice_number"], ActivationState.STUB, "Invoice payment link resent"),
    "ZB-INV-008": TemplateDefinition("ZB-INV-008", TemplateTier.T1, "INV", ["invoice_number"], ActivationState.STUB, "Invoice partially paid"),
    "ZB-INV-009": TemplateDefinition("ZB-INV-009", TemplateTier.T1, "INV", ["invoice_number"], ActivationState.STUB, "Invoice paid in full"),
    "ZB-INV-010": TemplateDefinition("ZB-INV-010", TemplateTier.T1, "INV", ["invoice_number"], ActivationState.STUB, "Invoice payment failed"),
    "ZB-INV-011": TemplateDefinition("ZB-INV-011", TemplateTier.T1, "INV", ["invoice_number", "due_date", "days_until_due"], ActivationState.ACTIVE, "Invoice pre-due reminder"),
    "ZB-INV-012": TemplateDefinition("ZB-INV-012", TemplateTier.T1, "INV", ["invoice_number"], ActivationState.STUB, "Invoice due today"),
    "ZB-INV-013": TemplateDefinition("ZB-INV-013", TemplateTier.T1, "INV", ["invoice_number", "company_name"], ActivationState.ACTIVE, "Invoice past-due notice"),
    "ZB-INV-014": TemplateDefinition("ZB-INV-014", TemplateTier.T1, "INV", ["invoice_number"], ActivationState.STUB, "Invoice dispute resolved"),
    "ZB-INV-015": TemplateDefinition("ZB-INV-015", TemplateTier.T1, "INV", ["invoice_number"], ActivationState.STUB, "Invoice write-off recorded (internal)"),
    "ZB-INV-016": TemplateDefinition("ZB-INV-016", TemplateTier.T1, "INV", ["invoice_number"], ActivationState.STUB, "Invoice corrected / amended"),
    "ZB-INV-017": TemplateDefinition("ZB-INV-017", TemplateTier.T1, "INV", ["invoice_number"], ActivationState.STUB, "Invoice deleted"),
    "ZB-INV-018": TemplateDefinition("ZB-INV-018", TemplateTier.T1, "INV", ["credit_note_number", "company_name"], ActivationState.ACTIVE, "Credit note issued"),

    # CHG family — Charges / Estimates / Quotes
    "ZB-CHG-001": TemplateDefinition("ZB-CHG-001", TemplateTier.T1, "CHG", ["quote_number"], ActivationState.STUB, "Estimate created"),
    "ZB-CHG-002": TemplateDefinition("ZB-CHG-002", TemplateTier.T1, "CHG", ["quote_number"], ActivationState.STUB, "Estimate approved internally"),
    "ZB-CHG-003": TemplateDefinition("ZB-CHG-003", TemplateTier.T1, "CHG", ["quote_number"], ActivationState.STUB, "Estimate accepted by customer"),
    "ZB-CHG-004": TemplateDefinition("ZB-CHG-004", TemplateTier.T1, "CHG", ["quote_number"], ActivationState.STUB, "Estimate rejected by customer"),
    "ZB-CHG-005": TemplateDefinition("ZB-CHG-005", TemplateTier.T1, "CHG", ["quote_number"], ActivationState.STUB, "Estimate expired"),
    "ZB-CHG-006": TemplateDefinition("ZB-CHG-006", TemplateTier.T1, "CHG", ["quote_number", "company_name"], ActivationState.ACTIVE, "Estimate / Quote sent to customer"),
    "ZB-CHG-007": TemplateDefinition("ZB-CHG-007", TemplateTier.T1, "CHG", ["quote_number"], ActivationState.STUB, "Estimate voided"),

    # PAY family — Payment events
    "ZB-PAY-001": TemplateDefinition("ZB-PAY-001", TemplateTier.T1, "PAY", ["payment_number"], ActivationState.STUB, "Payment initiated"),
    "ZB-PAY-002": TemplateDefinition("ZB-PAY-002", TemplateTier.T1, "PAY", ["company_name"], ActivationState.ACTIVE, "Payment received"),
    "ZB-PAY-003": TemplateDefinition("ZB-PAY-003", TemplateTier.T1, "PAY", ["payment_number"], ActivationState.STUB, "Payment processing"),
    "ZB-PAY-004": TemplateDefinition("ZB-PAY-004", TemplateTier.T1, "PAY", ["payment_number"], ActivationState.STUB, "Payment failed"),
    "ZB-PAY-005": TemplateDefinition("ZB-PAY-005", TemplateTier.T1, "PAY", ["payment_number"], ActivationState.STUB, "Payment reversed"),
    "ZB-PAY-006": TemplateDefinition("ZB-PAY-006", TemplateTier.T1, "PAY", ["payment_number"], ActivationState.STUB, "Chargeback received"),
    "ZB-PAY-007": TemplateDefinition("ZB-PAY-007", TemplateTier.T1, "PAY", ["payment_number"], ActivationState.STUB, "Chargeback won"),
    "ZB-PAY-008": TemplateDefinition("ZB-PAY-008", TemplateTier.T1, "PAY", ["payment_number"], ActivationState.STUB, "Chargeback lost"),
    "ZB-PAY-009": TemplateDefinition("ZB-PAY-009", TemplateTier.T1, "PAY", ["payment_number"], ActivationState.STUB, "Payment on hold"),
    "ZB-PAY-012": TemplateDefinition("ZB-PAY-012", TemplateTier.T1, "PAY", ["payment_number"], ActivationState.STUB, "Partial refund processed"),
    "ZB-PAY-013": TemplateDefinition("ZB-PAY-013", TemplateTier.T1, "PAY", ["company_name"], ActivationState.ACTIVE, "Refund processed"),

    # SUB family — Subscription lifecycle
    "ZB-SUB-001": TemplateDefinition("ZB-SUB-001", TemplateTier.T1, "SUB", ["plan_name"], ActivationState.STUB, "Subscription created / activated"),
    "ZB-SUB-002": TemplateDefinition("ZB-SUB-002", TemplateTier.T1, "SUB", ["plan_name"], ActivationState.STUB, "Subscription upgraded"),
    "ZB-SUB-003": TemplateDefinition("ZB-SUB-003", TemplateTier.T1, "SUB", ["plan_name"], ActivationState.STUB, "Subscription downgraded"),
    "ZB-SUB-004": TemplateDefinition("ZB-SUB-004", TemplateTier.T1, "SUB", ["plan_name"], ActivationState.STUB, "Subscription cancelled"),
    "ZB-SUB-005": TemplateDefinition("ZB-SUB-005", TemplateTier.T1, "SUB", ["plan_name"], ActivationState.ACTIVE, "Subscription renewed"),
    "ZB-SUB-006": TemplateDefinition("ZB-SUB-006", TemplateTier.T1, "SUB", ["plan_name"], ActivationState.STUB, "Subscription paused"),
    "ZB-SUB-007": TemplateDefinition("ZB-SUB-007", TemplateTier.T1, "SUB", ["plan_name"], ActivationState.STUB, "Subscription resumed"),
    "ZB-SUB-008": TemplateDefinition("ZB-SUB-008", TemplateTier.T1, "SUB", ["plan_name"], ActivationState.STUB, "Subscription expiring soon"),
    "ZB-SUB-009": TemplateDefinition("ZB-SUB-009", TemplateTier.T1, "SUB", ["plan_name"], ActivationState.STUB, "Subscription expired"),
    "ZB-SUB-010": TemplateDefinition("ZB-SUB-010", TemplateTier.T1, "SUB", ["plan_name"], ActivationState.STUB, "Subscription reactivated"),

    # COL family — Collections / Dunning
    "ZB-COL-001": TemplateDefinition("ZB-COL-001", TemplateTier.T2, "COL", ["invoice_number"], ActivationState.ACTIVE, "Dunning reminder"),
    "ZB-COL-011": TemplateDefinition("ZB-COL-011", TemplateTier.T1, "COL", ["customer_name"], ActivationState.ACTIVE, "Write-off executed"),

    # COM family — Commercial / Platform Subscription
    # Note: ZB-COM-001 is the catalog ID for Zoiko Billing account/trial created.
    # It is served by send_org_created_email() (ZB-ORG-001 canonical) + send_product_welcome_email().
    "ZB-COM-001": TemplateDefinition("ZB-COM-001", TemplateTier.T1, "COM", ["company_name"], ActivationState.ACTIVE, "Zoiko Billing account / trial created"),
    "ZB-COM-002": TemplateDefinition("ZB-COM-002", TemplateTier.T1, "COM", ["recipient_name", "invite_link"], ActivationState.ACTIVE, "Admin invitation"),
    # ZB-COM-003 = trial-ending warning (T3 consent-aware, N days before trial_ends_at)
    "ZB-COM-003": TemplateDefinition("ZB-COM-003", TemplateTier.T3, "COM", ["recipient_first_name", "trial_ends_at", "days_remaining"], ActivationState.ACTIVE, "Trial ending soon warning"),
    # ZB-COM-004 = trial expired / account suspended notice (T1 critical)
    "ZB-COM-004": TemplateDefinition("ZB-COM-004", TemplateTier.T1, "COM", ["recipient_first_name", "organization_name"], ActivationState.ACTIVE, "Trial expired / account suspended"),
    # ZB-COM-011 = past-due suspension warning for paid subscriptions (T1)
    "ZB-COM-011": TemplateDefinition("ZB-COM-011", TemplateTier.T1, "COM", ["recipient_first_name", "organization_name", "days_overdue"], ActivationState.ACTIVE, "Past-due subscription suspension warning"),

    # CON family — Contracts
    "ZB-CON-001": TemplateDefinition("ZB-CON-001", TemplateTier.T1, "CON", ["contract_number"], ActivationState.ACTIVE, "Contract activated"),
    "ZB-CON-002": TemplateDefinition("ZB-CON-002", TemplateTier.T1, "CON", ["contract_number"], ActivationState.ACTIVE, "Contract renewed"),

    # GLB family — Global Tax / E-Invoicing (T2)
    "ZB-GLB-001": TemplateDefinition("ZB-GLB-001", TemplateTier.T2, "GLB", ["country"], ActivationState.ACTIVE, "Tax jurisdiction / e-invoicing profile updated"),

    # INT family — Integrations & Webhooks (T2)
    "ZB-INT-001": TemplateDefinition("ZB-INT-001", TemplateTier.T2, "INT", ["integration_name"], ActivationState.ACTIVE, "Integration connected"),
    "ZB-INT-004": TemplateDefinition("ZB-INT-004", TemplateTier.T2, "INT", ["integration_name", "error_message"], ActivationState.ACTIVE, "Webhook or integration failure alert"),

    # RPT family — Scheduled Reports (T2)
    "ZB-RPT-001": TemplateDefinition("ZB-RPT-001", TemplateTier.T2, "RPT", ["report_name"], ActivationState.ACTIVE, "Scheduled financial or audit report ready"),

    # SUP family — Support Tickets & Service Operations (T2)
    "ZB-SUP-001": TemplateDefinition("ZB-SUP-001", TemplateTier.T2, "SUP", ["ticket_id", "subject"], ActivationState.ACTIVE, "Support ticket status updated"),
    "ZB-SUP-005": TemplateDefinition("ZB-SUP-005", TemplateTier.T2, "SUP", ["incident_title"], ActivationState.ACTIVE, "Service incident or scheduled maintenance announcement"),

    # ACQ family — Acquisition / Demo Requests (T3 consent-aware)
    "ZB-ACQ-001": TemplateDefinition("ZB-ACQ-001", TemplateTier.T3, "ACQ", ["recipient_first_name"], ActivationState.ACTIVE, "Demo request received"),

    # MKT family — Marketing / Product Updates (T4 explicit opt-in required)
    "ZB-MKT-001": TemplateDefinition("ZB-MKT-001", TemplateTier.T4, "MKT", ["recipient_first_name", "campaign_title"], ActivationState.ACTIVE, "Product update and marketing newsletter"),

    # PRF family — Preferences (T3 consent-aware)
    "ZB-PRF-001": TemplateDefinition("ZB-PRF-001", TemplateTier.T3, "PRF", ["recipient_first_name"], ActivationState.ACTIVE, "Email communication preferences updated"),
}


# Event Registry: Versioned mapping from Trigger Event Name -> Template ID
EVENT_REGISTRY: Dict[str, str] = {
    # Identity & Security
    "identity.email_verification_requested": "ZB-SEC-001",
    "identity.email_verified": "ZB-SEC-002",
    "identity.signin_code_issued": "ZB-SEC-003",
    "identity.password_reset_requested": "ZB-SEC-004",
    "identity.password_changed": "ZB-SEC-005",
    "identity.mfa_enabled": "ZB-SEC-006",
    "identity.mfa_disabled": "ZB-SEC-007",
    "identity.recovery_codes_regenerated": "ZB-SEC-008",
    "identity.new_device_signin": "ZB-SEC-009",
    "identity.risky_signin_blocked": "ZB-SEC-010",
    "identity.account_locked": "ZB-SEC-011",
    "identity.email_change_requested": "ZB-SEC-012",
    "identity.email_changed": "ZB-SEC-013",
    "identity.recovery_started": "ZB-SEC-014",
    "identity.recovery_completed": "ZB-SEC-015",
    "identity.session_revoked": "ZB-SEC-016",
    "identity.mfa_reset_by_admin": "ZB-SEC-017",
    "privileged_access.requested": "ZB-SEC-018",
    "support.privileged_access_granted": "ZB-SEC-018",

    # Domain T0
    "portal.magic_link_issued": "ZB-CUS-006",
    "portal.access_changed": "ZB-CUS-007",
    "payment_method.added": "ZB-PAY-010",
    "payment_method.removed": "ZB-PAY-011",
    "api_key.created": "ZB-INT-006",
    "api_key.rotated": "ZB-INT-007",
    "api_key.revoked": "ZB-INT-008",
    "privacy_incident.notice_approved": "ZB-LEG-008",
    "ops.system_alert": "ZB-OPS-001",

    # Billing & Financial T1/T2
    "invoice.sent": "ZB-INV-006",
    "invoice.pre_due_reminder": "ZB-INV-011",
    "invoice.past_due": "ZB-INV-013",
    "credit_note.issued": "ZB-INV-018",
    "quote.sent": "ZB-CHG-006",
    "payment.received": "ZB-PAY-002",
    "refund.processed": "ZB-PAY-013",
    "subscription.renewed": "ZB-SUB-005",
    "dunning.reminder": "ZB-COL-001",
    "write_off.executed": "ZB-COL-011",

    # ORG / ONB
    "organization.created": "ZB-ORG-001",
    "onboarding.started": "ZB-ONB-001",

    # COM — Zoiko platform subscription lifecycle
    "commercial.account_created": "ZB-COM-001",
    "commercial.admin_invited": "ZB-COM-002",
    "commercial.trial_ending_soon": "ZB-COM-003",
    "commercial.trial_expired": "ZB-COM-004",
    "commercial.past_due_suspension_warning": "ZB-COM-011",

    # Contracts
    "contract.activated": "ZB-CON-001",
    "contract.renewed": "ZB-CON-002",

    # T2 Events
    "global.tax_profile_updated": "ZB-GLB-001",
    "integration.connected": "ZB-INT-001",
    "integration.sync_failed": "ZB-INT-004",
    "reports.scheduled_ready": "ZB-RPT-001",
    "support.ticket_updated": "ZB-SUP-001",
    "support.service_maintenance": "ZB-SUP-005",

    # T3 / T4 Events
    "commercial.demo_requested": "ZB-ACQ-001",
    "marketing.newsletter": "ZB-MKT-001",
    "preferences.updated": "ZB-PRF-001",
}


def get_template_definition(template_id: str) -> Optional[TemplateDefinition]:
    return TEMPLATE_REGISTRY.get(template_id)


def get_template_for_event(event_name: str) -> Optional[TemplateDefinition]:
    template_id = EVENT_REGISTRY.get(event_name)
    if not template_id:
        return None
    return get_template_definition(template_id)
