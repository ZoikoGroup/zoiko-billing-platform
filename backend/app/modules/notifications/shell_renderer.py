"""
modules/notifications/shell_renderer.py
------------------------------------------
Dark-theme email shell, built as Python string-composition functions
rather than an on-disk base+slot template. Rationale (see the approved
implementation plan, section I): the existing `_render_template` engine
in app/services/email_service.py has no `{% extends %}`-style inheritance,
and a shared on-disk base file risks a stray context key (e.g.
`unsubscribe_url`) leaking through a `{{#if}}` block meant for a
different tier. A Python builder whose source simply never contains that
token makes a T0 unsubscribe/promo leak structurally impossible, not just
runtime-suppressed.

Chrome (body/card/border/header-banner colors) matches the existing,
already-dark `org_created.html` exactly. The primary CTA button matches
`LoginPage.jsx`'s verified promo-panel treatment pixel-for-pixel (gradient,
shadow, pill radius) per the spec's "pixel-matching the login page" CTA
requirement.

Footer branding tokens ({{company_name}}, {{support_email}},
{{legal_entity}}) are left as literal `{{...}}` placeholders on purpose —
`email_service.send_approval_email` runs `_render_template` over
`template_body` exactly as it does for on-disk templates, substituting
these from `_get_org_branding()` automatically. No unsubscribe-link token
is ever emitted by this module.
"""

# Chrome — matches org_created.html exactly (verified dark template already in production).
_BODY_BG = "#0B0F19"
_CARD_BG = "#0F172A"
_CARD_BORDER = "#1E293B"
_HEADER_GRADIENT = "linear-gradient(135deg, #4F46E5 0%, #2563EB 100%)"
_TEXT_PRIMARY = "#FFFFFF"
_TEXT_SECONDARY = "#CBD5E1"
_TEXT_MUTED = "#64748B"

# CTA — matches LoginPage.jsx's verified promo-panel button exactly.
_ACCENT_BLUE = "#60A5FA"
_CTA_GRADIENT = "linear-gradient(135deg, #2563EB, #1D4ED8)"
_CTA_SHADOW = "0 4px 16px rgba(37,99,235,0.35)"


def render_t0_shell(
    *,
    eyebrow: str,
    heading: str,
    body_html: str,
    cta_label: str,
    cta_url: str,
    accent_color: str = _ACCENT_BLUE,
    secondary_block_html: str = "",
) -> str:
    """T0 (security) shell. No unsubscribe/promotional markup anywhere in
    this function's source — structurally absent, not conditionally
    hidden. Tone is deliberately calm: no red/yellow urgency accents even
    for alarming events (e.g. "suspicious sign-in blocked"), since jarring
    colors on a security email can itself look like a phishing attempt.
    """
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{heading}</title>
</head>
<body style="margin: 0; padding: 0; background-color: {_BODY_BG}; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; color: {_TEXT_SECONDARY};">
  <div style="display: none; max-height: 0px; overflow: hidden; opacity: 0; font-size: 1px; line-height: 1px; color: {_BODY_BG};">
    Review this Zoiko Billing security event.
  </div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: {_BODY_BG}; padding: 40px 10px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width: 600px; background-color: {_CARD_BG}; border-radius: 16px; border: 1px solid {_CARD_BORDER}; overflow: hidden; box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);">
          <tr>
            <td style="background: {_HEADER_GRADIENT}; padding: 32px 40px; text-align: left;">
              <table role="presentation" width="100%">
                <tr>
                  <td>
                    <span style="font-size: 22px; font-weight: 800; color: {_TEXT_PRIMARY}; letter-spacing: -0.5px;">ZOIKO<span style="color: {accent_color};">BILLING</span></span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding: 40px;">
              <p style="margin: 0 0 12px 0; font-family: 'JetBrains Mono', 'Courier New', monospace; font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: {accent_color};">
                {eyebrow}
              </p>
              <h1 style="margin: 0 0 20px 0; font-size: 24px; font-weight: 800; color: {_TEXT_PRIMARY}; letter-spacing: -0.5px; line-height: 1.3;">
                {heading}
              </h1>
              <div style="margin: 0 0 28px 0; font-size: 15px; line-height: 1.7; color: {_TEXT_SECONDARY};">
                {body_html}
              </div>
              {secondary_block_html}
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin-bottom: 24px;">
                <tr>
                  <td style="border-radius: 50px; background: {_CTA_GRADIENT}; box-shadow: {_CTA_SHADOW};">
                    <a href="{cta_url}" target="_blank" style="font-size: 15px; font-weight: 700; color: {_TEXT_PRIMARY}; text-decoration: none; border-radius: 50px; padding: 14px 32px; display: inline-block;">
                      {cta_label} &rarr;
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin: 0; font-size: 13px; line-height: 1.5;">
                <a href="{cta_url}" style="color: {accent_color}; text-decoration: underline;">Or use this link</a>
              </p>
              <p style="margin: 20px 0 0 0; font-size: 13px; line-height: 1.5; color: {_TEXT_MUTED};">
                If this activity was not authorized, secure your account immediately through the official Zoiko Billing application or support route.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color: {_BODY_BG}; padding: 24px 40px; border-top: 1px solid {_CARD_BORDER}; text-align: center;">
              <p style="margin: 0 0 8px 0; font-size: 12px; color: {_TEXT_MUTED};">
                {{{{legal_entity}}}} &bull; Official Account Security &amp; System Communication
              </p>
              <p style="margin: 0; font-size: 12px; color: #475569;">
                Support: {{{{support_email}}}} &bull; &copy; {{{{company_name}}}}. All rights reserved.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>"""
