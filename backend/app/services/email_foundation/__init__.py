"""
email_foundation/__init__.py
----------------------------
Foundation Infrastructure for the Zoiko Billing Email System.
"""

from app.services.email_foundation.enums import (
    TemplateTier,
    ActivationState,
    SendStatus,
    SuppressionReason,
)
from app.services.email_foundation.models import (
    EmailSuppression,
    EmailMarketingConsent,
    EmailOrgPreference,
    CommunicationAuditLog,
)
from app.services.email_foundation.registries import (
    TemplateDefinition,
    TEMPLATE_REGISTRY,
    EVENT_REGISTRY,
    get_template_definition,
    get_template_for_event,
)
from app.services.email_foundation.contract import (
    TierEnforcementError,
    VariableValidationError,
    validate_tier_compliance,
    validate_variable_contract,
)
from app.services.email_foundation.engine import (
    ConsentSuppressionEngine,
    IdempotencySupersessionEngine,
    CommunicationAuditLogger,
)
from app.services.email_foundation.async_dispatcher import (
    submit_email_task,
    shutdown_email_dispatcher,
)

__all__ = [
    "TemplateTier",
    "ActivationState",
    "SendStatus",
    "SuppressionReason",
    "EmailSuppression",
    "EmailMarketingConsent",
    "EmailOrgPreference",
    "CommunicationAuditLog",
    "TemplateDefinition",
    "TEMPLATE_REGISTRY",
    "EVENT_REGISTRY",
    "get_template_definition",
    "get_template_for_event",
    "TierEnforcementError",
    "VariableValidationError",
    "validate_tier_compliance",
    "validate_variable_contract",
    "ConsentSuppressionEngine",
    "IdempotencySupersessionEngine",
    "CommunicationAuditLogger",
    "submit_email_task",
    "shutdown_email_dispatcher",
]
