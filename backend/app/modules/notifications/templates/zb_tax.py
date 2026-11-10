"""
modules/notifications/templates/zb_tax.py
-----------------------------------------
Render functions for the ZB-TAX-* (governed tax) template family.

ZB-TAX-001 (ZB-TAX-ARCH-001 Phase 8 PR 3): an emergency rollback affected
the organization's tax in a market. Sent to the organization's admins. It
never contains amounts, invoice numbers or customer names: the details are
in the organization's own review items.
"""
from html import escape

from app.modules.notifications.shell_renderer import render_t0_shell

_EYEBROW = "Tax Notice"


def render_zb_tax_001(context: dict):
    subject = "Tax rules were rolled back for one of your markets"
    body = (
        f"<p style=\"margin:0 0 16px 0;\">Hello {escape(str(context['recipient_first_name']))},</p>"
        f"<p style=\"margin:0 0 16px 0;\">Zoiko rolled back the tax rules for "
        f"<strong style=\"color:#FFFFFF;\">{escape(str(context['market_label']))}</strong> "
        f"({escape(str(context['date_range']))}).</p>"
        f"<p style=\"margin:0 0 16px 0;\">{escape(str(context['urgency']))} Draft quotes in this market may need "
        f"re-quoting. Issued invoices are not changed; any that need correcting will be reviewed with you.</p>"
        f"<p style=\"margin:0;\">Open your tax review items to see what is affected in your organization.</p>"
    )
    html = render_t0_shell(eyebrow=_EYEBROW, heading="Tax rules rolled back", body_html=body,
                           cta_label="Open review items", cta_url=context.get("review_url", "#"))
    return subject, html


RENDERERS = {
    "ZB-TAX-001": render_zb_tax_001,
}
