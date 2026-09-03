"""
modules/notifications/templates/zb_sec.py
--------------------------------------------
Render functions for the ZB-SEC-* (Identity, Authentication and Security)
template family. Each function takes the already-variable-validated
render context and returns (subject, html_body).

Copy for ZB-SEC-001..016 follows the supplied reference catalog's body
pattern verbatim ("A Zoiko Billing security event was recorded for your
account: <event>"). ZB-SEC-017/018 are the two gap-closure templates
proposed in Part 1/Phase 1 of the spec — no id in the supplied catalog
covers either event, so these use bespoke copy in the same tone rather
than being force-fit into an existing id.
"""

from app.modules.notifications.shell_renderer import render_t0_shell

_EYEBROW = "Security Notice"


def _generic_sec_body(recipient_first_name: str, event_description: str) -> str:
    return (
        f"<p style=\"margin:0 0 16px 0;\">Hello {recipient_first_name},</p>"
        f"<p style=\"margin:0;\">A Zoiko Billing security event was recorded for your "
        f"account: <strong style=\"color:#FFFFFF;\">{event_description}</strong>.</p>"
    )


def render_zb_sec_001(context: dict):
    subject = "Verify your email address for Zoiko Billing"
    body = _generic_sec_body(context["recipient_first_name"], "verify email address")
    html = render_t0_shell(
        eyebrow=_EYEBROW, heading="Verify your email address",
        body_html=body, cta_label="Verify email address", cta_url=context["verify_url"],
    )
    return subject, html


def render_zb_sec_002(context: dict):
    subject = "Your Zoiko Billing sign-in code"
    body = (
        f"<p style=\"margin:0 0 16px 0;\">Hello {context['recipient_first_name']},</p>"
        f"<p style=\"margin:0 0 16px 0;\">A Zoiko Billing security event was recorded for your "
        f"account: <strong style=\"color:#FFFFFF;\">sign-in verification code</strong>.</p>"
        f"<p style=\"margin:0; font-size:28px; font-weight:800; letter-spacing:0.2em; color:#FFFFFF;\">"
        f"{context['signin_code']}</p>"
    )
    html = render_t0_shell(
        eyebrow=_EYEBROW, heading="Your sign-in code",
        body_html=body, cta_label="Continue sign-in", cta_url=context.get("signin_url", "#"),
    )
    return subject, html


def render_zb_sec_003(context: dict):
    subject = "Reset your Zoiko Billing password"
    body = _generic_sec_body(context["recipient_first_name"], "password reset requested")
    html = render_t0_shell(
        eyebrow=_EYEBROW, heading="Reset your password",
        body_html=body, cta_label="Reset password", cta_url=context["reset_url"],
    )
    return subject, html


def render_zb_sec_004(context: dict):
    subject = "Your Zoiko Billing password was changed"
    body = _generic_sec_body(context["recipient_first_name"], "password changed")
    html = render_t0_shell(
        eyebrow=_EYEBROW, heading="Your password was changed",
        body_html=body, cta_label="Review security activity", cta_url=context.get("security_url", "#"),
    )
    return subject, html


def render_zb_sec_005(context: dict):
    subject = "Multi-factor authentication was enabled"
    body = _generic_sec_body(context["recipient_first_name"], "multi-factor authentication enabled")
    html = render_t0_shell(
        eyebrow=_EYEBROW, heading="Multi-factor authentication enabled",
        body_html=body, cta_label="Review security settings", cta_url=context.get("security_url", "#"),
    )
    return subject, html


def render_zb_sec_006(context: dict):
    subject = "Multi-factor authentication was disabled"
    body = _generic_sec_body(context["recipient_first_name"], "multi-factor authentication disabled")
    html = render_t0_shell(
        eyebrow=_EYEBROW, heading="Multi-factor authentication disabled",
        body_html=body, cta_label="Secure account", cta_url=context.get("security_url", "#"),
    )
    return subject, html


def render_zb_sec_007(context: dict):
    subject = "New recovery codes were generated"
    body = _generic_sec_body(context["recipient_first_name"], "recovery codes regenerated")
    html = render_t0_shell(
        eyebrow=_EYEBROW, heading="New recovery codes generated",
        body_html=body, cta_label="Review security activity", cta_url=context.get("security_url", "#"),
    )
    return subject, html


def render_zb_sec_008(context: dict):
    subject = "New sign-in to your Zoiko Billing account"
    body = _generic_sec_body(context["recipient_first_name"], "new-device sign-in")
    html = render_t0_shell(
        eyebrow=_EYEBROW, heading="New sign-in to your account",
        body_html=body, cta_label="Review activity", cta_url=context.get("security_url", "#"),
    )
    return subject, html


def render_zb_sec_009(context: dict):
    subject = "We blocked a suspicious Zoiko Billing sign-in"
    body = _generic_sec_body(context["recipient_first_name"], "suspicious sign-in blocked")
    html = render_t0_shell(
        eyebrow=_EYEBROW, heading="We blocked a suspicious sign-in",
        body_html=body, cta_label="Secure account", cta_url=context.get("security_url", "#"),
    )
    return subject, html


def render_zb_sec_010(context: dict):
    subject = "Your Zoiko Billing account was temporarily locked"
    body = _generic_sec_body(context["recipient_first_name"], "account temporarily locked")
    html = render_t0_shell(
        eyebrow=_EYEBROW, heading="Your account was temporarily locked",
        body_html=body, cta_label="Restore account access", cta_url=context.get("security_url", "#"),
    )
    return subject, html


def render_zb_sec_011(context: dict):
    subject = "Confirm your new Zoiko Billing email address"
    body = _generic_sec_body(context["recipient_first_name"], "email-address change requested")
    html = render_t0_shell(
        eyebrow=_EYEBROW, heading="Confirm your new email address",
        body_html=body, cta_label="Confirm change", cta_url=context.get("confirm_url", "#"),
    )
    return subject, html


def render_zb_sec_012(context: dict):
    subject = "Your Zoiko Billing email address was changed"
    body = _generic_sec_body(context["recipient_first_name"], "email address changed")
    html = render_t0_shell(
        eyebrow=_EYEBROW, heading="Your email address was changed",
        body_html=body, cta_label="Review security activity", cta_url=context.get("security_url", "#"),
    )
    return subject, html


def render_zb_sec_013(context: dict):
    subject = "Zoiko Billing account recovery was started"
    body = _generic_sec_body(context["recipient_first_name"], "account recovery started")
    html = render_t0_shell(
        eyebrow=_EYEBROW, heading="Account recovery started",
        body_html=body, cta_label="Continue account recovery", cta_url=context.get("recovery_url", "#"),
    )
    return subject, html


def render_zb_sec_014(context: dict):
    subject = "Your Zoiko Billing account was recovered"
    body = _generic_sec_body(context["recipient_first_name"], "account recovery completed")
    html = render_t0_shell(
        eyebrow=_EYEBROW, heading="Your account was recovered",
        body_html=body, cta_label="Review security settings", cta_url=context.get("security_url", "#"),
    )
    return subject, html


def render_zb_sec_015(context: dict):
    subject = "A Zoiko Billing session or trusted device was revoked"
    body = _generic_sec_body(context["recipient_first_name"], "active session or trusted device revoked")
    html = render_t0_shell(
        eyebrow=_EYEBROW, heading="A session or trusted device was revoked",
        body_html=body, cta_label="Review active sessions", cta_url=context.get("security_url", "#"),
    )
    return subject, html


def render_zb_sec_016(context: dict):
    subject = "A Zoiko Billing session or trusted device was revoked"
    body = _generic_sec_body(context["recipient_first_name"], "session or trusted device revoked by an administrator")
    html = render_t0_shell(
        eyebrow=_EYEBROW, heading="A session or trusted device was revoked",
        body_html=body, cta_label="Review active sessions", cta_url=context.get("security_url", "#"),
    )
    return subject, html


# --- Gap closures ------------------------------------------------------

def render_zb_sec_017(context: dict):
    """Admin-initiated MFA reset. Proposed new id — see registry owner_hook."""
    subject = "Your multi-factor authentication was reset by an administrator"
    body = (
        f"<p style=\"margin:0 0 16px 0;\">Hello {context['recipient_first_name']},</p>"
        f"<p style=\"margin:0;\">An administrator reset multi-factor authentication on your "
        f"Zoiko Billing account for account-recovery reasons. Re-enroll from Settings to "
        f"restore step-up protection.</p>"
    )
    html = render_t0_shell(
        eyebrow=_EYEBROW, heading="Your MFA was reset by an administrator",
        body_html=body, cta_label="Go to settings", cta_url=context["settings_url"],
    )
    return subject, html


def render_zb_sec_018(context: dict):
    """Privileged/support access requested. Proposed new id — see registry owner_hook."""
    subject = "Support access was requested on your Zoiko Billing account"
    body = (
        f"<p style=\"margin:0 0 16px 0;\">Hello {context['recipient_first_name']},</p>"
        f"<p style=\"margin:0 0 16px 0;\">Zoiko Billing support staff requested time-limited, "
        f"read-only access to <strong style=\"color:#FFFFFF;\">{context['organization_name']}</strong> "
        f"for the following reason: \"{context['reason']}\" (ticket {context['ticket_reference']}).</p>"
        f"<p style=\"margin:0;\">This access requires a separate step-up approval and is time-limited "
        f"and audited. Contact support immediately if this request is unexpected.</p>"
    )
    html = render_t0_shell(
        eyebrow=_EYEBROW, heading="Support access was requested",
        body_html=body, cta_label="Review access request", cta_url=context.get("access_review_url", "#"),
    )
    return subject, html


RENDERERS = {
    "ZB-SEC-001": render_zb_sec_001,
    "ZB-SEC-002": render_zb_sec_002,
    "ZB-SEC-003": render_zb_sec_003,
    "ZB-SEC-004": render_zb_sec_004,
    "ZB-SEC-005": render_zb_sec_005,
    "ZB-SEC-006": render_zb_sec_006,
    "ZB-SEC-007": render_zb_sec_007,
    "ZB-SEC-008": render_zb_sec_008,
    "ZB-SEC-009": render_zb_sec_009,
    "ZB-SEC-010": render_zb_sec_010,
    "ZB-SEC-011": render_zb_sec_011,
    "ZB-SEC-012": render_zb_sec_012,
    "ZB-SEC-013": render_zb_sec_013,
    "ZB-SEC-014": render_zb_sec_014,
    "ZB-SEC-015": render_zb_sec_015,
    "ZB-SEC-016": render_zb_sec_016,
    "ZB-SEC-017": render_zb_sec_017,
    "ZB-SEC-018": render_zb_sec_018,
}
