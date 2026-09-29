"""
tests/test_email_rendered_content_no_leftover_placeholders.py
-----------------------------------------------------------------
Regression guard for the email content-repair pass.

Two classes of defect are covered:

1. Unsubstituted placeholders. Every ``send_*`` wrapper in
   ``app/services/email_service.py`` is discovered via the AST, its template and
   its context keys are read from the literal ``send_approval_email`` call, and
   the template is rendered exactly the way production does (branding defaults
   merged with the caller's own context, plus ``login_url``). If the template
   references a key the wrapper never supplies, the renderer emits a literal
   ``{{token}}`` and the test fails.

2. Every rendered email contains real Zoiko Billing branding (160px hosted logo
   + visible "Zoiko Billing" text) so that if images are blocked the recipient
   still knows the source.

3. Wrong-template reuse guards: repointed wrappers must talk about their own
   event, not the template's original event.

The AST approach is deliberate: it is the same static fact the runtime uses, so
a newly added wrapper is covered automatically without a hand-written list.
"""

import ast
import pathlib
import re

import pytest

from app.services.email_service import _BRANDING_DEFAULTS, _load_template, _render_template

SERVICE_PY = pathlib.Path(__file__).resolve().parents[1] / "app" / "services" / "email_service.py"
LOGIN_URL = "https://app.zoikobilling.test/login"

_GENERIC = "x-value"
_PLACEHOLDER_RE = re.compile(r"\{\{\s*[\w#/]+\s*\}\}")


def _sample(key):
    return _GENERIC


def _branding():
    return {**_BRANDING_DEFAULTS, "login_url": LOGIN_URL}


def _discover_wrappers():
    tree = ast.parse(SERVICE_PY.read_text(encoding="utf-8"))
    found = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.FunctionDef) or not node.name.startswith("send_"):
            continue
        for call in ast.walk(node):
            if not (
                isinstance(call, ast.Call)
                and getattr(call.func, "id", "") == "send_approval_email"
            ):
                continue
            if len(call.args) < 2 or not isinstance(call.args[1], ast.Constant):
                continue
            template = call.args[1].value
            if not isinstance(template, str) or not template.endswith(".html"):
                continue
            keys = []
            if len(call.args) >= 3 and isinstance(call.args[2], ast.Dict):
                for k in call.args[2].keys:
                    if isinstance(k, ast.Constant) and isinstance(k.value, str):
                        keys.append(k.value)
            found.append((node.name, template, keys))
            break
    return sorted(found)


WRAPPERS = _discover_wrappers()
WRAPPER_IDS = [w[0] for w in WRAPPERS]


def _render(wrapper):
    _name, template, keys = wrapper
    body = _load_template(template)
    assert body, f"template {template} could not be loaded"
    context = _branding()
    context.update({k: _sample(k) for k in keys})
    return _render_template(body, context)


def test_wrappers_were_discovered():
    assert len(WRAPPERS) >= 40, (
        f"expected the full wrapper inventory, discovered {len(WRAPPERS)}"
    )
    names = [w[0] for w in WRAPPERS]
    assert "send_approval_email" not in names
    assert len(names) == len(set(names))


@pytest.mark.parametrize("wrapper", WRAPPERS, ids=WRAPPER_IDS)
def test_no_leftover_placeholders(wrapper):
    """No literal {{token}} should survive rendering."""
    leaked = sorted(set(_PLACEHOLDER_RE.findall(_render(wrapper))))
    assert not leaked, (
        f"{wrapper[0]} renders {wrapper[1]} but leaves {leaked}; "
        "those tokens would ship to the customer"
    )


@pytest.mark.parametrize("wrapper", WRAPPERS, ids=WRAPPER_IDS)
def test_every_wrapper_renders_the_logo(wrapper):
    _name, template, _keys = wrapper
    html = _render(wrapper)
    expected = _BRANDING_DEFAULTS["logo_url"]
    match = re.search(r'<img[^>]*\ssrc="([^"]*)"[^>]*>', html)
    assert match, f"{wrapper[0]} -> {template} has no logo image"
    assert match.group(1) == expected, (
        f"{wrapper[0]} -> {template} logo src is {match.group(1)!r}, "
        f"expected {expected!r}"
    )
    assert 'width="160"' in match.group(0), (
        f"{wrapper[0]} -> {template} logo should render at 160px wide"
    )


@pytest.mark.parametrize("wrapper", WRAPPERS, ids=WRAPPER_IDS)
def test_every_wrapper_shows_brand_text(wrapper):
    html = _render(wrapper)
    assert "Zoiko Billing" in html, f"{wrapper[0]} -> {template} has no brand text"


def test_support_ticket_update_is_not_an_org_creation_email():
    html = _html("send_support_ticket_updated_email")
    assert "organization created" not in html
    assert "is ready in Zoiko Billing" not in html


def test_report_ready_is_not_an_org_creation_email():
    html = _html("send_report_ready_email")
    assert "organization created" not in html
    assert "is ready in Zoiko Billing" not in html


def test_user_role_change_is_not_an_org_creation_email():
    html = _html("send_user_role_changed_email")
    assert "organization created" not in html
    assert "is ready in Zoiko Billing" not in html


def test_trial_expired_is_not_an_org_creation_email():
    html = _html("send_trial_expired_email")
    assert "organization created" not in html
    assert "is ready in Zoiko Billing" not in html


@pytest.mark.parametrize(
    "fn",
    [
        "send_trial_ending_warning_email",
        "send_trial_converted_email",
        "send_demo_request_received_email",
        "send_marketing_newsletter_email",
        "send_commercial_plan_changed_email",
        "send_plan_version_published_digest_email",
    ],
)
def test_product_wrappers_are_not_the_welcome_template(fn):
    html = _html(fn)
    assert "Welcome to Zoiko Billing" not in html
    assert "onboarding_url" not in html


def test_invoice_voided_uses_its_own_template():
    wrapper = _BY_NAME("send_invoice_voided_email")
    assert wrapper[1] == "invoice_voided.html"
    html = _render(wrapper)
    assert "Amount Due" not in html, "voided invoice must not demand payment"
    assert "has been voided" in html


def test_logo_default_is_a_real_hosted_asset():
    assert _BRANDING_DEFAULTS["logo_url"], "default logo must not be empty"
    assert _BRANDING_DEFAULTS["logo_url"].endswith("/zoiko-billing-logo.png")
    assert "None" not in _BRANDING_DEFAULTS["logo_url"]


def _BY_NAME(fn):
    return next(w for w in WRAPPERS if w[0] == fn)


def _html(fn):
    return _render(_BY_NAME(fn))