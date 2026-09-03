"""
modules/notifications/template_registry.py
--------------------------------------------
Single source-of-truth catalog of ZB-* email templates, in the same spirit
as scheduler.get_job_definitions(): one reviewable Python structure, no
DB migration needed to add a template. A DB row (NotificationTemplateState)
can only ever narrow what's declared active here — it can never activate a
template that has no real call site in this codebase.

Only templates with a genuine, verified trigger event in this codebase are
declared active=True. The other ZB-SEC ids from the reference catalog exist
here as active=False placeholders: registered so the catalog<->code mapping
is visible, dormant because no real event exists yet to fire them.
"""

import enum
from dataclasses import dataclass, field


class NotificationTier(str, enum.Enum):
    T0 = "T0"
    T1 = "T1"
    T2 = "T2"
    T3 = "T3"
    T4 = "T4"


class ControlRuleFlag(str, enum.Enum):
    NO_UNSUBSCRIBE_LINK = "no_unsubscribe_link"
    NO_PROMOTIONAL_CONTENT = "no_promotional_content"
    REQUIRES_MARKETING_CONSENT = "requires_marketing_consent"


#: Every T0 template must carry both of these flags. Enforced by
#: validate_template_registry() at startup.
_T0_MANDATORY_FLAGS = frozenset(
    {ControlRuleFlag.NO_UNSUBSCRIBE_LINK, ControlRuleFlag.NO_PROMOTIONAL_CONTENT}
)


@dataclass(frozen=True)
class TemplateMeta:
    template_id: str
    tier: NotificationTier
    trigger_event_name: str
    subject: str
    required_variables: tuple = field(default_factory=tuple)
    sender_identity_kind: str = "platform"  # "platform" | "tenant_branded"
    control_rule_flags: frozenset = field(default_factory=frozenset)
    active: bool = False
    owner_hook: str = ""  # documentation only, e.g. "auth/service.py:change_password"


_T0_FLAGS = _T0_MANDATORY_FLAGS

TEMPLATE_REGISTRY: dict = {
    "ZB-SEC-001": TemplateMeta(
        template_id="ZB-SEC-001",
        tier=NotificationTier.T0,
        trigger_event_name="identity.email_verification_requested",
        subject="Verify your email address for Zoiko Billing",
        required_variables=("recipient_first_name", "verify_url"),
        control_rule_flags=_T0_FLAGS,
        active=False,
        owner_hook="no distinct email-verification flow exists yet",
    ),
    "ZB-SEC-002": TemplateMeta(
        template_id="ZB-SEC-002",
        tier=NotificationTier.T0,
        trigger_event_name="identity.signin_code_issued",
        subject="Your Zoiko Billing sign-in code",
        required_variables=("recipient_first_name", "signin_code"),
        control_rule_flags=_T0_FLAGS,
        active=False,
        owner_hook="no OTP/magic-code login exists yet",
    ),
    "ZB-SEC-003": TemplateMeta(
        template_id="ZB-SEC-003",
        tier=NotificationTier.T0,
        trigger_event_name="identity.password_reset_requested",
        subject="Reset your Zoiko Billing password",
        required_variables=("recipient_first_name", "reset_url"),
        control_rule_flags=_T0_FLAGS,
        active=True,
        owner_hook="auth/service.py:_send_reset_email (via request_password_reset)",
    ),
    "ZB-SEC-004": TemplateMeta(
        template_id="ZB-SEC-004",
        tier=NotificationTier.T0,
        trigger_event_name="identity.password_changed",
        subject="Your Zoiko Billing password was changed",
        required_variables=("recipient_first_name",),
        control_rule_flags=_T0_FLAGS,
        active=True,
        owner_hook="auth/service.py:change_password",
    ),
    "ZB-SEC-005": TemplateMeta(
        template_id="ZB-SEC-005",
        tier=NotificationTier.T0,
        trigger_event_name="identity.mfa_enabled",
        subject="Multi-factor authentication was enabled",
        required_variables=("recipient_first_name",),
        control_rule_flags=_T0_FLAGS,
        active=True,
        owner_hook="auth/mfa_service.py:verify_enrollment (Super Admin accounts only)",
    ),
    "ZB-SEC-006": TemplateMeta(
        template_id="ZB-SEC-006",
        tier=NotificationTier.T0,
        trigger_event_name="identity.mfa_disabled",
        subject="Multi-factor authentication was disabled",
        required_variables=("recipient_first_name",),
        control_rule_flags=_T0_FLAGS,
        active=True,
        owner_hook="auth/mfa_service.py:disable_mfa_self (Super Admin accounts only)",
    ),
    "ZB-SEC-007": TemplateMeta(
        template_id="ZB-SEC-007",
        tier=NotificationTier.T0,
        trigger_event_name="identity.recovery_codes_regenerated",
        subject="New recovery codes were generated",
        required_variables=("recipient_first_name",),
        control_rule_flags=_T0_FLAGS,
        active=False,
        owner_hook="no standalone regenerate-codes flow; codes only (re)issued inside enrollment",
    ),
    "ZB-SEC-008": TemplateMeta(
        template_id="ZB-SEC-008",
        tier=NotificationTier.T0,
        trigger_event_name="identity.new_device_signin",
        subject="New sign-in to your Zoiko Billing account",
        required_variables=("recipient_first_name",),
        control_rule_flags=_T0_FLAGS,
        active=False,
        owner_hook="no device fingerprinting/recognition exists yet",
    ),
    "ZB-SEC-009": TemplateMeta(
        template_id="ZB-SEC-009",
        tier=NotificationTier.T0,
        trigger_event_name="identity.risky_signin_blocked",
        subject="We blocked a suspicious Zoiko Billing sign-in",
        required_variables=("recipient_first_name",),
        control_rule_flags=_T0_FLAGS,
        active=False,
        owner_hook="no risk-scoring exists yet",
    ),
    "ZB-SEC-010": TemplateMeta(
        template_id="ZB-SEC-010",
        tier=NotificationTier.T0,
        trigger_event_name="identity.account_locked",
        subject="Your Zoiko Billing account was temporarily locked",
        required_variables=("recipient_first_name",),
        control_rule_flags=_T0_FLAGS,
        active=True,
        owner_hook="auth/service.py:login_user (on the transition into locked state)",
    ),
    "ZB-SEC-011": TemplateMeta(
        template_id="ZB-SEC-011",
        tier=NotificationTier.T0,
        trigger_event_name="identity.email_change_requested",
        subject="Confirm your new Zoiko Billing email address",
        required_variables=("recipient_first_name",),
        control_rule_flags=_T0_FLAGS,
        active=False,
        owner_hook="no email-change flow exists yet",
    ),
    "ZB-SEC-012": TemplateMeta(
        template_id="ZB-SEC-012",
        tier=NotificationTier.T0,
        trigger_event_name="identity.email_changed",
        subject="Your Zoiko Billing email address was changed",
        required_variables=("recipient_first_name",),
        control_rule_flags=_T0_FLAGS,
        active=False,
        owner_hook="no email-change flow exists yet",
    ),
    "ZB-SEC-013": TemplateMeta(
        template_id="ZB-SEC-013",
        tier=NotificationTier.T0,
        trigger_event_name="identity.recovery_started",
        subject="Zoiko Billing account recovery was started",
        required_variables=("recipient_first_name",),
        control_rule_flags=_T0_FLAGS,
        active=False,
        owner_hook="no generic account-recovery flow distinct from password reset/admin MFA reset",
    ),
    "ZB-SEC-014": TemplateMeta(
        template_id="ZB-SEC-014",
        tier=NotificationTier.T0,
        trigger_event_name="identity.recovery_completed",
        subject="Your Zoiko Billing account was recovered",
        required_variables=("recipient_first_name",),
        control_rule_flags=_T0_FLAGS,
        active=False,
        owner_hook="no generic account-recovery flow distinct from password reset/admin MFA reset",
    ),
    "ZB-SEC-015": TemplateMeta(
        template_id="ZB-SEC-015",
        tier=NotificationTier.T0,
        trigger_event_name="identity.session_revoked",
        subject="A Zoiko Billing session or trusted device was revoked",
        required_variables=("recipient_first_name",),
        control_rule_flags=_T0_FLAGS,
        active=False,
        owner_hook="JWTs are stateless; no revocation list exists",
    ),
    "ZB-SEC-016": TemplateMeta(
        template_id="ZB-SEC-016",
        tier=NotificationTier.T0,
        trigger_event_name="identity.session_revoked_by_admin",
        subject="A Zoiko Billing session or trusted device was revoked",
        required_variables=("recipient_first_name",),
        control_rule_flags=_T0_FLAGS,
        active=False,
        owner_hook="no session-revocation capability exists; closest is user deactivation (different event)",
    ),
    # --- Gap closures (see Part 1/Phase 1 of the spec) ---------------------
    # No template ID in the supplied catalog covers either of these two
    # distinct security actions. Per instruction, these are NOT force-fit
    # into ZB-SEC-006/007 or any other existing id — they are proposed as
    # new, provisionally-numbered ids and should be registered formally in
    # the master spec.
    "ZB-SEC-017": TemplateMeta(
        template_id="ZB-SEC-017",
        tier=NotificationTier.T0,
        trigger_event_name="identity.mfa_reset_by_admin",
        subject="Your multi-factor authentication was reset by an administrator",
        required_variables=("recipient_first_name", "settings_url"),
        control_rule_flags=_T0_FLAGS,
        active=True,
        owner_hook="auth/mfa_service.py:admin_reset_mfa, via super_admin/router.py PUT /users/{user_id}/mfa/reset",
    ),
    "ZB-SEC-018": TemplateMeta(
        template_id="ZB-SEC-018",
        tier=NotificationTier.T0,
        trigger_event_name="privileged_access.requested",
        subject="Support access was requested on your Zoiko Billing account",
        required_variables=("recipient_first_name", "organization_name", "reason", "ticket_reference"),
        control_rule_flags=_T0_FLAGS,
        active=True,
        owner_hook="super_admin/privileged_access_service.py:PrivilegedAccessService.request_access",
    ),
}

#: event_name -> [template_id, ...]. Built from TEMPLATE_REGISTRY rather
#: than declared separately, so the two structures can never drift apart.
EVENT_REGISTRY: dict = {}
for _meta in TEMPLATE_REGISTRY.values():
    EVENT_REGISTRY.setdefault(_meta.trigger_event_name, []).append(_meta.template_id)


def get_template_meta(template_id: str) -> TemplateMeta:
    """Raises KeyError for an unknown id — callers must never treat a
    missing template as a silent no-op."""
    return TEMPLATE_REGISTRY[template_id]


def get_templates_for_event(event_name: str) -> list:
    return [get_template_meta(tid) for tid in EVENT_REGISTRY.get(event_name, [])]


def validate_template_registry(registry: dict = None) -> None:
    """Startup self-check. Call once from main.py's lifespan, next to the
    existing secret-key checks. Raises loudly on any malformed entry —
    a bad registry entry must fail at startup, never fail silently at
    send time.

    Accepts an optional registry override so tests can validate a mutated
    copy without touching the real TEMPLATE_REGISTRY.
    """
    reg = TEMPLATE_REGISTRY if registry is None else registry

    seen_ids = set()
    for template_id, meta in reg.items():
        if template_id != meta.template_id:
            raise ValueError(
                f"Registry key {template_id!r} does not match TemplateMeta.template_id {meta.template_id!r}"
            )
        if template_id in seen_ids:
            raise ValueError(f"Duplicate template_id in registry: {template_id}")
        seen_ids.add(template_id)

        if meta.tier == NotificationTier.T0:
            missing_flags = _T0_MANDATORY_FLAGS - meta.control_rule_flags
            if missing_flags:
                raise ValueError(
                    f"{template_id} is T0 but missing mandatory control-rule flag(s): "
                    f"{[f.value for f in missing_flags]}"
                )

    event_registry = {}
    for meta in reg.values():
        event_registry.setdefault(meta.trigger_event_name, []).append(meta.template_id)
    for event_name, template_ids in event_registry.items():
        for template_id in template_ids:
            if template_id not in reg:
                raise ValueError(
                    f"Event {event_name!r} references unknown template_id {template_id!r}"
                )
