"""
app/modules/tax/tenant_step_up.py
---------------------------------
Tenant MFA step-up for tax approvals (ZB-TAX-ARCH-001 Phase 5d).

A finance approver presents a fresh TOTP or recovery code when approving:
a provider connection mode change, a regime switch, a provider activation
and a provider void. Governed by TAX_TENANT_STEP_UP_REQUIRED only; the
platform registry's TAX_REGISTRY_STEP_UP_REQUIRED does not affect it, nor
the reverse. The dev-only bypass is refused outside DEBUG by config.

Errors the screens act on:
  TAX_MFA_ENROLMENT_REQUIRED      the approver has no MFA: "enrol MFA to approve"
  TAX_REGISTRY_STEP_UP_REQUIRED   enrolled, no code sent: prompt and retry once
"""
import logging
from typing import Optional

from sqlalchemy.orm import Session

from app.config import settings
from app.core.exceptions import BadRequestException, ZoikoException

logger = logging.getLogger("zoiko_billing.tax.step_up")

ENROL_PATH = "/billing/tax/governance/mfa"


class TaxMfaEnrolmentRequired(BadRequestException):
    def __init__(self, message: str):
        ZoikoException.__init__(self, status_code=400, error_code="TAX_MFA_ENROLMENT_REQUIRED", message=message)


def require_tenant_tax_step_up(db: Session, user, code: Optional[str] = None,
                               recovery_code: Optional[str] = None) -> str:
    """Returns how the approval was protected: verified | bypassed | not_required.
    Must run before any change: verify_step_up commits the session."""
    from app.config import step_up_bypass_active
    from app.modules.auth.mfa_service import is_mfa_enabled, verify_step_up
    from app.modules.tax.registry_router import TaxStepUpRequired

    if not settings.TAX_TENANT_STEP_UP_REQUIRED:
        logger.warning("TAX_TENANT_STEP_UP_REQUIRED is off: tenant tax approval by user %s without step-up.", user.id)
        return "not_required"
    if step_up_bypass_active():
        return "bypassed"
    if not is_mfa_enabled(db, user.id):
        raise TaxMfaEnrolmentRequired(
            f"Enrol MFA to approve: open Tax governance → MFA ({ENROL_PATH}) and set up an authenticator app.")
    if not (code or recovery_code):
        raise TaxStepUpRequired("MFA step-up is required: provide a current authenticator code or a recovery code.")
    verify_step_up(db, user, code=code, recovery_code=recovery_code, enforce_when_retired=True)
    return "verified"
