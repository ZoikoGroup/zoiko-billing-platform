"""
Email service for the standalone Billing Platform.

Templates are stored in app/email_templates/ as HTML files. SMTP settings
come from the platform's own .env (SMTP_*), with an optional override stored
in PlatformSetting (category == "email"). The SMTP password is read only
from the environment, never from the DB.

Branding (company name, legal entity, address, logo) resolves from the
org's own BillingConfiguration when available, falling back to the
standalone platform's Organization table — never the old platform's hr/HR
modules.
"""

import html as _html
import logging
import os
import re
import smtplib
import ssl
from datetime import datetime, timezone
from email.mime.application import MIMEApplication
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import certifi

logger = logging.getLogger("zoiko_billing")

TEMPLATE_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "email_templates")

_IF_BLOCK_RE = re.compile(r"\{\{#if (\w+)\}\}(.*?)\{\{/if\}\}", re.DOTALL)
_TAG_RE = re.compile(r"<[^>]+>")


def _load_template(name: str) -> str:
    path = os.path.join(TEMPLATE_DIR, name)
    if not os.path.exists(path):
        logger.warning(f"Email template not found: {path}")
        return ""
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def _render_template(template: str, context: dict) -> str:
    def _eval_if(match):
        key, inner = match.group(1), match.group(2)
        return inner if context.get(key) else ""

    result = _IF_BLOCK_RE.sub(_eval_if, template)
    for key, value in context.items():
        if value is None:
            value = ""
        result = result.replace("{{" + key + "}}", str(value))
    return result


def _html_to_text(html: str) -> str:
    text = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</tr>|</li>", "\n", html)
    text = _TAG_RE.sub("", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def _get_smtp_settings(db=None) -> dict:
    from app.config import settings as _settings
    defaults = {
        "host": _settings.SMTP_HOST,
        "port": _settings.SMTP_PORT,
        "username": _settings.SMTP_USERNAME,
        "password": _settings.SMTP_PASSWORD,
        "from_email": _settings.SMTP_FROM_EMAIL,
        "use_tls": _settings.SMTP_USE_TLS,
    }
    try:
        from app.modules.super_admin.models import PlatformSetting

        own_session = False
        if db is None:
            from app.database import SessionLocal
            db = SessionLocal()
            own_session = True
        try:
            rows = db.query(PlatformSetting).filter(PlatformSetting.category == "email").all()
            mapping = {s.key: s.value for s in rows if s.value}
            return {
                "host": mapping.get("smtp_host", defaults["host"]),
                "port": mapping.get("smtp_port", defaults["port"]),
                "username": mapping.get("smtp_username", defaults["username"]),
                "password": defaults["password"],
                "from_email": mapping.get("smtp_from_email", defaults["from_email"]),
                "use_tls": mapping.get("smtp_use_tls", defaults["use_tls"]),
            }
        finally:
            if own_session:
                db.close()
    except Exception as e:
        logger.warning(f"[email] Could not load SMTP settings from DB, using defaults: {e}")
        return defaults


_BRANDING_DEFAULTS = {
    "company_name": "Zoiko Billing",
    "support_email": "",
    "website": "",
    "logo_url": "",
    "invoice_footer": "",
    "legal_entity": "",
    "billing_address": "",
    "billing_phone": "",
}


def _get_org_branding(organization_id=None, db=None) -> dict:
    """Prefer the org's own BillingConfiguration (logo, invoice footer, tax
    registration numbers); fall back to the plain Organization record."""
    if not organization_id:
        return dict(_BRANDING_DEFAULTS)
    try:
        from app.modules.billing.services.settings_service import BillingConfigurationService

        own_session = False
        if db is None:
            from app.database import SessionLocal
            db = SessionLocal()
            own_session = True
        try:
            config = BillingConfigurationService(db).get_configuration(organization_id)
            company_name = (config.company_name or "").strip()
            if not company_name:
                from app.modules.organizations.models import Organization
                org = db.query(Organization).filter(Organization.id == organization_id).first()
                company_name = (org.organization_name or org.display_name or "") if org else ""
            if not company_name:
                company_name = _BRANDING_DEFAULTS["company_name"]

            reg_parts = []
            for label, value in (
                ("business registration", config.business_registration_number),
                ("GST", config.gst_number),
                ("VAT", config.vat_number),
                ("PAN", config.pan_number),
                ("TIN", config.tin_number),
            ):
                if value:
                    reg_parts.append(f"{label} no. {value}")
            legal_entity = company_name
            if reg_parts:
                legal_entity = f"{company_name} — {', '.join(reg_parts)}"

            addr_parts = [
                config.address_line1, config.address_line2,
                config.city, config.state, config.postal_code, config.country,
            ]
            billing_address = ", ".join(p for p in addr_parts if p)

            return {
                "company_name": company_name,
                "support_email": config.billing_email or "",
                "website": config.website or "",
                "logo_url": config.logo_url or "",
                "invoice_footer": config.invoice_footer or "",
                "legal_entity": legal_entity,
                "billing_address": billing_address,
                "billing_phone": config.billing_phone or "",
            }
        finally:
            if own_session:
                db.close()
    except Exception as e:
        logger.warning(f"[email] Could not load org branding for organization_id={organization_id}: {e}")
        return dict(_BRANDING_DEFAULTS)


TEMPLATE_NAME_TO_ID = {
    "invoice_sent.html": "ZB-INV-006",
    "past_due_notice.html": "ZB-INV-013",
    "credit_note_issued.html": "ZB-INV-018",
    "quote_sent.html": "ZB-CHG-006",
    "payment_received.html": "ZB-PAY-002",
    "refund_processed.html": "ZB-PAY-013",
    "subscription_renewed.html": "ZB-SUB-005",
    "dunning_reminder.html": "ZB-COL-001",
    "write_off_executed.html": "ZB-COL-011",
    "org_created.html": "ZB-COM-001",
    "org_admin_invite.html": "ZB-COM-002",
    "org_admin_password_reset.html": "ZB-COM-003",
    "contract_activated.html": "ZB-CON-001",
    "contract_renewed.html": "ZB-CON-002",
}


def send_approval_email(
    email: str,
    template_name: str,
    context: dict,
    db=None,
    organization_id=None,
    attachments=None,
    from_email_override=None,
    from_display_name_override=None,
    template_body: str = None,
    event_name: str = None,
    event_id: str = None,
    target_record_id: str = None,
    async_send: bool = False,
) -> bool:
    """Send an email via SMTP passing through the Email Foundation Infrastructure.

    Includes consent/suppression checks, tier enforcement (T0 restriction),
    variable contract validation, idempotency deduplication, supersession handling,
    audit logging, and optional async dispatch.
    """
    from app.services.email_foundation import (
        TemplateTier,
        SendStatus,
        get_template_definition,
        validate_tier_compliance,
        validate_variable_contract,
        ConsentSuppressionEngine,
        IdempotencySupersessionEngine,
        CommunicationAuditLogger,
        submit_email_task,
    )
    from app.database import SessionLocal

    template_id = context.get("template_id") or TEMPLATE_NAME_TO_ID.get(template_name, "ZB-GEN-000")
    template_def = get_template_definition(template_id)
    tier = template_def.tier if template_def else TemplateTier.T1
    family = template_def.family if template_def else "GEN"
    eff_event_name = event_name or context.get("event_name") or f"email.{template_id.lower()}"

    from app.config import settings as _settings

    # Internal Operator Alerts (ZB-OPS-*) MUST route to internal ops channel, never tenants
    if family == "OPS" or template_id.startswith("ZB-OPS-"):
        email = _settings.SMTP_FROM_EMAIL or "ops@zoikobilling.com"

    # 1. Variable Contract Validation
    if template_def:
        validate_variable_contract(template_def, context)

    # 2. Template Loading & Render
    if template_body is not None:
        template = template_body
    else:
        template = _load_template(template_name)
    if not template:
        logger.warning(f"Cannot send email to {email}: template {template_name} not found")
        return False

    from app.config import settings as _settings

    branding = _get_org_branding(organization_id, db=db)
    full_context = {**branding, "login_url": _settings.FRONTEND_URL.rstrip("/") + "/login", **context}
    body = _render_template(template, full_context)

    # 3. Tier Compliance Check (T0 Restrictions)
    validate_tier_compliance(tier, full_context, body)

    # Database Session for Engine Checks & Logging
    own_session = False
    if db is None:
        db = SessionLocal()
        own_session = True

    try:
        eff_event_id = event_id or context.get("event_id")
        eff_target_id = target_record_id or context.get("target_record_id")
        dedupe_key = IdempotencySupersessionEngine.generate_dedupe_key(eff_event_id, template_id, email)

        # 4. Consent & Suppression Check
        eligible, suppression_reason = ConsentSuppressionEngine.check_send_eligibility(
            db, email, organization_id, tier, family
        )
        if not eligible:
            logger.info(f"[EMAIL_FOUNDATION] Suppressing email to {email} ({template_id}) | Reason: {suppression_reason}")
            CommunicationAuditLogger.log_attempt(
                db=db,
                dedupe_key=dedupe_key,
                recipient=email,
                organization_id=organization_id,
                template_id=template_id,
                event_name=eff_event_name,
                event_id=eff_event_id,
                target_record_id=eff_target_id,
                tier=tier,
                status=SendStatus.SUPPRESSED,
                suppression_reason=suppression_reason,
            )
            return False

        # 5. Idempotency Check
        if IdempotencySupersessionEngine.is_duplicate(db, dedupe_key):
            logger.info(f"[EMAIL_FOUNDATION] Duplicate send blocked for {email} | DedupeKey: {dedupe_key}")
            CommunicationAuditLogger.log_attempt(
                db=db,
                dedupe_key=dedupe_key,
                recipient=email,
                organization_id=organization_id,
                template_id=template_id,
                event_name=eff_event_name,
                event_id=eff_event_id,
                target_record_id=eff_target_id,
                tier=tier,
                status=SendStatus.DUPLICATE,
            )
            return False

        # 6. Apply Supersession
        IdempotencySupersessionEngine.apply_supersession(db, email, eff_target_id, eff_event_name)

        # Inner SMTP delivery function
        def _deliver_smtp():
            task_db = db
            task_own_db = False
            if async_send:
                task_db = SessionLocal()
                task_own_db = True

            try:
                smtp = _get_smtp_settings(db=task_db)
                subject = context.get("subject", "Zoiko Billing — Notification")
                if "{{" in subject:
                    subject = _render_template(subject, full_context)

                envelope_from = smtp["from_email"]
                header_from = from_email_override or envelope_from
                sender_name = from_display_name_override or full_context.get("company_name") or "Zoiko Billing"
                reply_to = full_context.get("support_email")

                msg = MIMEMultipart("alternative")
                msg["Subject"] = subject
                msg["From"] = f"{sender_name} <{header_from}>"
                msg["To"] = email
                if reply_to:
                    msg["Reply-To"] = reply_to
                msg.attach(MIMEText(_html_to_text(body), "plain", "utf-8"))
                msg.attach(MIMEText(body, "html", "utf-8"))

                if attachments:
                    for filename, data in attachments:
                        part = MIMEApplication(data, _subtype="pdf")
                        part.add_header("Content-Disposition", "attachment", filename=filename)
                        msg.attach(part)

                try:
                    port = int(smtp["port"])
                    use_tls = str(smtp.get("use_tls", "true")).strip().lower() in ("1", "true", "yes")
                    context_ssl = ssl.create_default_context(cafile=certifi.where())

                    if use_tls and port != 465:
                        with smtplib.SMTP(smtp["host"], port, timeout=30) as server:
                            server.starttls(context=context_ssl)
                            if smtp["username"] and smtp["password"]:
                                server.login(smtp["username"], smtp["password"])
                            server.sendmail(envelope_from, email, msg.as_string())
                    else:
                        with smtplib.SMTP_SSL(smtp["host"], port, context=context_ssl, timeout=30) as server:
                            if smtp["username"] and smtp["password"]:
                                server.login(smtp["username"], smtp["password"])
                            server.sendmail(envelope_from, email, msg.as_string())

                    logger.info(f"[email] Sent to {email} | template={template_name}")
                    CommunicationAuditLogger.log_attempt(
                        db=task_db,
                        dedupe_key=dedupe_key,
                        recipient=email,
                        organization_id=organization_id,
                        template_id=template_id,
                        event_name=eff_event_name,
                        event_id=eff_event_id,
                        target_record_id=eff_target_id,
                        tier=tier,
                        status=SendStatus.SENT,
                    )
                    return True
                except Exception as e:
                    logger.error(f"[email] Failed to send to {email} | template={template_name} | error={e}")
                    CommunicationAuditLogger.log_attempt(
                        db=task_db,
                        dedupe_key=dedupe_key,
                        recipient=email,
                        organization_id=organization_id,
                        template_id=template_id,
                        event_name=eff_event_name,
                        event_id=eff_event_id,
                        target_record_id=eff_target_id,
                        tier=tier,
                        status=SendStatus.FAILED,
                        error_message=str(e),
                    )
                    return False
            finally:
                if task_own_db and task_db:
                    task_db.close()

        if async_send:
            submit_email_task(_deliver_smtp)
            return True
        else:
            return _deliver_smtp()

    finally:
        if own_session:
            db.close()


# ── Org / auth lifecycle emails ─────────────────────────────────────────────

SECURITY_SENDER = "Zoiko Billing Security"


def send_registration_received(email: str, org_name: str, db=None):
    return send_approval_email(email, "registration_received.html", {
        "subject": f"Registration Received — {org_name} | Zoiko Billing",
        "organization_name": org_name,
    }, db=db)


def send_user_invite_email(
    email: str,
    first_name: str,
    invite_link: str,
    invited_by: str = "",
    organization_id=None,
    db=None,
) -> bool:
    workspace = _get_org_branding(organization_id, db=db).get("company_name", "your organization")
    return send_approval_email(email, "org_admin_invite.html", {
        "subject": "You have been invited to {{workspace_name}}",
        "first_name": first_name,
        "inviter_name": invited_by or "your administrator",
        "workspace_name": workspace,
        "expires_at_local": "24 hours",
        "timezone": "UTC",
        "action_url": invite_link,
        "support_email": "",
    }, db=db, organization_id=organization_id, from_display_name_override=SECURITY_SENDER)


def send_org_admin_password_reset_email(
    email: str,
    first_name: str,
    reset_link: str,
    organization_id=None,
    db=None,
) -> bool:
    return send_approval_email(email, "org_admin_password_reset.html", {
        "subject": "Reset your Zoiko Billing password",
        "first_name": first_name,
        "expires_at_local": "24 hours",
        "timezone": "UTC",
        "action_url": reset_link,
        "support_email": "",
    }, db=db, organization_id=organization_id, from_display_name_override=SECURITY_SENDER)


# ── Organization lifecycle emails (ZB-ORG-001, ZB-ONB-001) ──────────────────

# Client-safe role display names — internal enum values and system UUIDs are
# never exposed in notification emails.  Maps internal UserRole enum values
# to human-readable labels; any unrecognized role falls back to "Member".
_ROLE_DISPLAY_MAP = {
    "super_admin": "Administrator",
    "org_admin": "Owner",
    "billing_admin": "Billing Admin",
    "finance_approver": "Finance Approver",
    "auditor": "Auditor",
}


def _verify_tenant_boundary(
    recipient_organization_id,
    expected_organization_id,
    recipient_email: str,
) -> bool:
    """Tenant isolation guardrail for notification dispatch.

    Before rendering or sending any org-scoped email, this function verifies
    that the recipient's organization_id matches the expected tenant boundary.
    Returns True when the boundary is satisfied; False (and logs a warning)
    when a cross-tenant leak is blocked.
    """
    if recipient_organization_id != expected_organization_id:
        logger.warning(
            "[email] Tenant boundary violation blocked: recipient %s "
            "(org_id=%s) does not belong to expected org_id=%s",
            recipient_email,
            recipient_organization_id,
            expected_organization_id,
        )
        return False
    return True


def _sanitize_role_display(role_value: str) -> str:
    """Replace internal role enum values with client-safe display names.
    System UUIDs or unexpected values are replaced with 'Member'."""
    if not role_value:
        return "Member"
    return _ROLE_DISPLAY_MAP.get(str(role_value).lower().strip(), "Member")


def send_org_created_email(
    email: str,
    first_name: str,
    organization_name: str,
    recipient_role: str,
    actor_display_name: str,
    effective_time: str,
    organization_id=None,
    db=None,
) -> bool:
    """ZB-ORG-001: Organization Created notification.

    Triggered immediately after tenant provisioning completes.  Includes a
    tenant isolation check and role sanitization before dispatch.
    """
    if not _verify_tenant_boundary(organization_id, organization_id, email):
        return False

    safe_role = _sanitize_role_display(recipient_role)
    safe_actor = _sanitize_role_display(actor_display_name) if actor_display_name else "System"

    from app.config import settings as _settings
    setup_url = _settings.FRONTEND_URL.rstrip("/") + "/login"

    return send_approval_email(email, "org_created.html", {
        "subject": f"{organization_name} is ready in Zoiko Billing",
        "organization_name": organization_name,
        "recipient_first_name": first_name or "there",
        "recipient_role": safe_role,
        "actor_display_name": safe_actor,
        "effective_time": effective_time,
        "setup_url": setup_url,
    }, db=db, organization_id=organization_id)


def send_product_welcome_email(
    email: str,
    first_name: str,
    organization_name: str,
    organization_id=None,
    db=None,
) -> bool:
    """ZB-ONB-001: Product Welcome / onboarding-started notification.

    Dispatched immediately after ZB-ORG-001 or when the primary user clicks
    Begin Setup.  Includes tenant isolation check before dispatch.
    """
    if not _verify_tenant_boundary(organization_id, organization_id, email):
        return False

    from app.config import settings as _settings
    onboarding_url = _settings.FRONTEND_URL.rstrip("/") + "/billing/settings"

    return send_approval_email(email, "product_welcome.html", {
        "subject": f"Welcome to Zoiko Billing — {organization_name}",
        "organization_name": organization_name,
        "recipient_first_name": first_name or "there",
        "onboarding_url": onboarding_url,
    }, db=db, organization_id=organization_id)


def notify_super_admins_org_created(db=None, organization=None, actor_email: str = None) -> list[str]:
    """ZB-SA-CMD-003 v3.0 master directive: notify every ACTIVE Super Admin
    by real email whenever a new organization is created.

    Recipients are resolved server-side from the users table (role ==
    super_admin AND is_active) — never from client input. The email carries
    only operational metadata (name, code, country, currency, status,
    creator, timestamp and a deep link); it contains NO credentials or
    secrets. Returns the list of recipient addresses that were dispatched
    (best-effort per recipient; a send failure for one admin does not stop
    the others). Callers invoke this AFTER their transaction has committed;
    exceptions bubble to the caller's fire-and-forget guard so a transient
    SMTP failure never fails an already-committed creation.
    """
    if organization is None:
        return []

    from app.config import settings as _settings
    from app.modules.auth.models import User, UserRole

    recipients = (
        db.query(User)
        .filter(User.role == UserRole.SUPER_ADMIN, User.is_active.is_(True))
        .all()
        if db is not None
        else []
    )
    if not recipients:
        logger.warning(
            "[email] No active Super Admin found to notify about organization %s creation",
            getattr(organization, "organization_code", "?"),
        )
        return []

    view_url = _settings.FRONTEND_URL.rstrip("/") + "/super-admin/organizations"
    status = "Active" if getattr(organization, "is_active", True) else "Suspended"
    created_time = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    context = {
        "subject": f"New organization created: {organization.organization_name}",
        "organization_name": organization.organization_name,
        "organization_code": organization.organization_code,
        "country": organization.country or "—",
        "currency": organization.currency or "—",
        "status": status,
        "created_by": actor_email or "System",
        "created_time": created_time,
        "view_url": view_url,
    }

    dispatched: list[str] = []
    for admin in recipients:
        try:
            if send_approval_email(admin.email, "super_admin_org_created.html", context, db=db):
                dispatched.append(admin.email)
            else:
                logger.warning(
                    "[email] Super Admin org-created notification could not be sent to %s (org %s)",
                    admin.email, organization.organization_code,
                )
        except Exception as exc:
            logger.warning(
                "[email] Super Admin org-created notification failed for %s (org %s): %s",
                admin.email, organization.organization_code, exc,
            )
    logger.info(
        "[email] Super Admin org-created notifications dispatched to %d/%d admins for org %s",
        len(dispatched), len(recipients), organization.organization_code,
    )
    return dispatched


# ── Billing module emails ───────────────────────────────────────────────────


def _render_quote_items_html(line_items, currency: str = "USD") -> str:
    """Render line-item rows as email-safe HTML. Values arrive pre-formatted
    from the billing service — the template derives nothing."""
    rows = []
    for item in line_items or []:
        desc = _html.escape(str(item.get("description") or ""))
        qty = _html.escape(str(item.get("quantity") or ""))
        rate = _html.escape(str(item.get("unit_price") or ""))
        amount = _html.escape(str(item.get("total_amount") or ""))
        cell = (
            'padding:9px 0;border-top:1px solid #eaeef2;'
            'font-size:13px;color:#1f2328;vertical-align:top;'
        )
        right = cell + 'text-align:right;white-space:nowrap;'
        rows.append(
            f'<tr>'
            f'<td style="{cell}">{desc}</td>'
            f'<td style="{right}">{qty}</td>'
            f'<td style="{right}">{rate}</td>'
            f'<td style="{right}">{amount}</td>'
            f'</tr>'
        )
    return "".join(rows)


def _render_quote_totals_html(subtotal, discount_amount, tax_amount, total_amount, currency: str = "USD") -> str:
    money_cell = 'text-align:right;white-space:nowrap;'
    row = (
        '<td style="padding:4px 0;font-size:13px;color:#57606a;">{label}</td>'
        '<td style="padding:4px 0;font-size:13px;color:#57606a;{money_cell}">{value}</td>'
    )
    rows = []
    line_items = [("Subtotal", subtotal)]
    if discount_amount:
        line_items.append(("Discount", discount_amount))
    line_items.append(("Tax", tax_amount))
    for label, value in line_items:
        rows.append(
            "<tr>" + row.format(label=_html.escape(str(label)), value=_html.escape(str(value or "")), money_cell=money_cell) + "</tr>"
        )
    rows.append(
        f"<tr>"
        '<td style="border-top:1px solid #E2E8F0;margin-top:4px;padding:10px 0 0;'
        'font-size:15px;font-weight:700;color:#2563EB;">'
        f"Total ({_html.escape(str(currency or ''))})</td>"
        '<td style="border-top:1px solid #E2E8F0;margin-top:4px;padding:10px 0 0;'
        'font-size:15px;font-weight:700;color:#2563EB;' + money_cell + '">'
        f"{_html.escape(str(total_amount or ''))}</td>"
        f"</tr>"
    )
    return "".join(rows)


def _render_invoice_totals_html(subtotal, tax_amount, amount_paid, balance_due, currency: str = "USD") -> str:
    money_cell = 'text-align:right;white-space:nowrap;'
    row = (
        '<td style="padding:4px 0;font-size:13px;color:#57606a;">{label}</td>'
        '<td style="padding:4px 0;font-size:13px;color:#57606a;{money_cell}">{value}</td>'
    )
    rows = []
    for label, value in (
        ("Subtotal", subtotal),
        ("Tax", tax_amount),
        ("Amount paid", amount_paid),
    ):
        rows.append(
            "<tr>" + row.format(label=_html.escape(str(label)), value=_html.escape(str(value or "")), money_cell=money_cell) + "</tr>"
        )
    rows.append(
        f"<tr>"
        '<td style="border-top:1px solid #E2E8F0;margin-top:4px;padding:10px 0 0;'
        'font-size:15px;font-weight:700;color:#2563EB;">'
        f"Balance due ({_html.escape(str(currency or ''))})</td>"
        '<td style="border-top:1px solid #E2E8F0;margin-top:4px;padding:10px 0 0;'
        'font-size:15px;font-weight:700;color:#2563EB;' + money_cell + '">'
        f"{_html.escape(str(balance_due or ''))}</td>"
        f"</tr>"
    )
    return "".join(rows)


def send_invoice_email(
    email: str,
    customer_name: str,
    invoice_number: str,
    issue_date: str,
    due_date: str,
    total_amount: str,
    currency: str = "USD",
    status: str = "Issued",
    balance_due: str = "",
    notes: str = "",
    organization_id=None,
    db=None,
    pdf_bytes: bytes = None,
    pdf_filename: str = None,
    recipient_first_name: str = "",
    line_items: list = None,
    subtotal: str = "",
    tax_amount: str = "",
    amount_paid: str = "",
    reference: str = "",
    review_url: str = "",
) -> bool:
    from app.config import settings as _settings
    attachments = [(pdf_filename or f"{invoice_number}.pdf", pdf_bytes)] if pdf_bytes else None
    balance_due = balance_due or total_amount
    cta_url = review_url or f"{_settings.FRONTEND_URL.rstrip('/')}/login"
    return send_approval_email(email, "invoice_sent.html", {
        "subject": f"Invoice {invoice_number} — payment of {currency} {balance_due} due {due_date}",
        "customer_name": customer_name,
        "recipient_first_name": recipient_first_name or customer_name,
        "invoice_number": invoice_number,
        "issue_date": issue_date,
        "due_date": due_date,
        "total_amount": total_amount,
        "currency": currency,
        "status": status,
        "balance_due": balance_due,
        "amount_paid": amount_paid,
        "reference": reference,
        "notes": notes,
        "review_url": review_url,
        "cta_url": cta_url,
        "line_items_html": _render_quote_items_html(line_items, currency),
        "totals_html": _render_invoice_totals_html(subtotal, tax_amount, amount_paid, balance_due, currency),
    }, db=db, organization_id=organization_id, attachments=attachments, event_name="invoice.sent")


def _get_platform_commercial_from_email(db=None):
    """Plane 1 (Zoiko-billing-the-org) from-email override — a separate
    PlatformSetting category ("email_commercial") from Plane 2's "email"
    category, so overriding one never touches the other's rows."""
    try:
        from app.modules.super_admin.models import PlatformSetting

        own_session = False
        if db is None:
            from app.database import SessionLocal
            db = SessionLocal()
            own_session = True
        try:
            row = (
                db.query(PlatformSetting)
                .filter(
                    PlatformSetting.category == "email_commercial",
                    PlatformSetting.key == "commercial_smtp_from_email",
                )
                .first()
            )
            return row.value if row and row.value else None
        finally:
            if own_session:
                db.close()
    except Exception as e:
        logger.warning(f"[email] Could not load Plane 1 from-email override: {e}")
        return None


def send_platform_invoice_email(
    email: str,
    recipient_org_name: str,
    invoice_number: str,
    issue_date: str,
    due_date: str,
    total_amount: str,
    currency: str = "USD",
    status: str = "Issued",
    balance_due: str = "",
    notes: str = "",
    db=None,
    recipient_first_name: str = "",
    line_items: list = None,
    subtotal: str = "",
    tax_amount: str = "",
    amount_paid: str = "",
    review_url: str = "",
) -> bool:
    """Plane 1 (Zoiko-billing-the-org) invoice email — always sent from the
    fixed "Zoiko Billing Accounts" identity, never the recipient org's own
    branding (Zoiko is the sender here, not the org). No organization_id/PDF
    param: no org-branding lookup, no PDF attachment this pass — the public
    link at review_url carries the full invoice detail."""
    from app.config import settings as _settings
    balance_due = balance_due or total_amount
    cta_url = review_url or f"{_settings.FRONTEND_URL.rstrip('/')}/login"
    from_email_override = _get_platform_commercial_from_email(db=db)
    return send_approval_email(email, "platform_invoice_sent.html", {
        "subject": f"Invoice {invoice_number} from Zoiko Billing — {currency} {balance_due} due {due_date}",
        "recipient_org_name": recipient_org_name,
        "recipient_first_name": recipient_first_name or recipient_org_name,
        "invoice_number": invoice_number,
        "issue_date": issue_date,
        "due_date": due_date,
        "total_amount": total_amount,
        "currency": currency,
        "status": status,
        "balance_due": balance_due,
        "amount_paid": amount_paid,
        "notes": notes,
        "review_url": review_url,
        "cta_url": cta_url,
        "line_items_html": _render_quote_items_html(line_items, currency),
        "totals_html": _render_invoice_totals_html(subtotal, tax_amount, amount_paid, balance_due, currency),
    }, db=db, organization_id=None, from_display_name_override="Zoiko Billing Accounts", from_email_override=from_email_override)


def send_platform_quote_email(
    email: str,
    recipient_org_name: str,
    quote_number: str,
    total_amount: str,
    currency: str = "USD",
    valid_until: str = "",
    notes: str = "",
    terms: str = "",
    db=None,
    recipient_first_name: str = "",
    line_items: list = None,
    subtotal: str = "",
    discount_amount: str = "",
    tax_amount: str = "",
    review_url: str = "",
) -> bool:
    """Plane 1 (Zoiko-billing-the-org) quote email — always sent from the
    fixed "Zoiko Billing Accounts" identity, never the recipient org's own
    branding. The CTA links to the public quote page where the org accepts
    or rejects with no login — mirrors send_platform_invoice_email's shape."""
    from app.config import settings as _settings
    cta_url = review_url or f"{_settings.FRONTEND_URL.rstrip('/')}/login"
    from_email_override = _get_platform_commercial_from_email(db=db)
    return send_approval_email(email, "platform_quote_sent.html", {
        "subject": f"Quote {quote_number} from Zoiko Billing — {currency} {total_amount}",
        "recipient_org_name": recipient_org_name,
        "recipient_first_name": recipient_first_name or recipient_org_name,
        "quote_number": quote_number,
        "total_amount": total_amount,
        "currency": currency,
        "valid_until": valid_until,
        "notes": notes,
        "terms": terms,
        "review_url": review_url,
        "cta_url": cta_url,
        "line_items_html": _render_quote_items_html(line_items, currency),
        "totals_html": _render_quote_totals_html(subtotal, discount_amount, tax_amount, total_amount, currency),
    }, db=db, organization_id=None, from_display_name_override="Zoiko Billing Accounts", from_email_override=from_email_override)


def send_quote_email(
    email: str,
    customer_name: str,
    quote_number: str,
    issue_date: str,
    valid_until: str,
    total_amount: str,
    currency: str = "USD",
    status: str = "Sent",
    notes: str = "",
    recipient_first_name: str = "",
    line_items: list = None,
    subtotal: str = "",
    discount_amount: str = "",
    tax_amount: str = "",
    reference: str = "",
    review_url: str = "",
    organization_id=None,
    db=None,
    pdf_bytes: bytes = None,
    pdf_filename: str = None,
) -> bool:
    from app.config import settings as _settings
    attachments = [(pdf_filename or f"{quote_number}.pdf", pdf_bytes)] if pdf_bytes else None
    cta_url = review_url or f"{_settings.FRONTEND_URL.rstrip('/')}/login"
    return send_approval_email(email, "quote_sent.html", {
        "subject": f"Estimate {quote_number} from {{{{company_name}}}} — {currency} {total_amount}",
        "customer_name": customer_name,
        "recipient_first_name": recipient_first_name or customer_name,
        "quote_number": quote_number,
        "issue_date": issue_date,
        "valid_until": valid_until,
        "total_amount": total_amount,
        "subtotal": subtotal,
        "discount_amount": discount_amount,
        "tax_amount": tax_amount,
        "currency": currency,
        "status": status,
        "reference": reference,
        "notes": notes,
        "review_url": review_url,
        "cta_url": cta_url,
        "line_items_html": _render_quote_items_html(line_items, currency),
        "totals_html": _render_quote_totals_html(subtotal, discount_amount, tax_amount, total_amount, currency),
    }, db=db, organization_id=organization_id, attachments=attachments, event_name="quote.sent")


def send_quote_response_notification_email(
    email: str,
    quote_number: str,
    action: str,
    reason: str,
    customer_name: str,
    total_amount: str,
    currency: str = "USD",
    organization_id=None,
    db=None,
) -> bool:
    """Notify org admins when a customer accepts/rejects an estimate from the
    public estimate page."""
    from app.config import settings as _settings
    action_label = "Accepted" if action == "accepted" else "Rejected"
    return send_approval_email(email, "quote_response_notification.html", {
        "subject": f"Estimate {quote_number} was {action_label} by customer",
        "action": action,
        "action_label": action_label,
        "accent_color": "#16A34A" if action == "accepted" else "#DC2626",
        "quote_number": quote_number,
        "reason": reason or "",
        "customer_name": customer_name,
        "total_amount": total_amount,
        "currency": currency,
        "dashboard_url": f"{_settings.FRONTEND_URL.rstrip('/')}/billing/quotations",
    }, db=db, organization_id=organization_id)


def send_dunning_reminder_email(
    email: str,
    customer_name: str,
    invoice_number: str,
    days_overdue: str,
    overdue_amount: str,
    currency: str = "USD",
    late_fee: str = "0",
    organization_id=None,
    db=None,
    template_name: str = "dunning_reminder.html",
    custom_body: str = None,
    subject_override: str = None,
) -> bool:
    return send_approval_email(email, template_name, {
        "subject": subject_override or f"Payment reminder: Invoice {invoice_number} is {days_overdue} days overdue",
        "customer_name": customer_name,
        "invoice_number": invoice_number,
        "days_overdue": days_overdue,
        "overdue_amount": overdue_amount,
        "currency": currency,
        "late_fee": late_fee,
    }, db=db, organization_id=organization_id, template_body=custom_body, event_name="dunning.reminder")


def send_contract_activated_email(
    email: str,
    customer_name: str,
    contract_number: str,
    start_date: str,
    end_date: str,
    total_amount: str,
    currency: str = "USD",
    organization_id=None,
    db=None,
) -> bool:
    return send_approval_email(email, "contract_activated.html", {
        "subject": f"Contract {contract_number} activated",
        "customer_name": customer_name,
        "contract_number": contract_number,
        "start_date": start_date,
        "end_date": end_date,
        "total_amount": total_amount,
        "currency": currency,
    }, db=db, organization_id=organization_id)


def send_contract_renewed_email(
    email: str,
    customer_name: str,
    contract_number: str,
    new_end_date: str,
    total_amount: str,
    currency: str = "USD",
    organization_id=None,
    db=None,
) -> bool:
    return send_approval_email(email, "contract_renewed.html", {
        "subject": f"Contract {contract_number} renewed",
        "customer_name": customer_name,
        "contract_number": contract_number,
        "new_end_date": new_end_date,
        "total_amount": total_amount,
        "currency": currency,
    }, db=db, organization_id=organization_id)


def send_subscription_renewed_email(
    email: str,
    customer_name: str,
    subscription_number: str,
    plan_name: str,
    term_start: str,
    term_end: str,
    amount: str,
    currency: str = "USD",
    organization_id=None,
    db=None,
) -> bool:
    return send_approval_email(email, "subscription_renewed.html", {
        "subject": f"Your {plan_name} subscription was renewed",
        "customer_name": customer_name,
        "subscription_number": subscription_number,
        "plan_name": plan_name,
        "term_start": term_start,
        "term_end": term_end,
        "amount": amount,
        "currency": currency,
    }, db=db, organization_id=organization_id)


def send_past_due_notice_email(
    email: str,
    customer_name: str,
    subscription_number: str,
    plan_name: str,
    days_overdue: str,
    overdue_amount: str,
    currency: str = "USD",
    organization_id=None,
    db=None,
) -> bool:
    return send_approval_email(email, "past_due_notice.html", {
        "subject": f"Invoice {subscription_number} from {{{{company_name}}}} is {days_overdue} days overdue",
        "customer_name": customer_name,
        "subscription_number": subscription_number,
        "plan_name": plan_name,
        "days_overdue": days_overdue,
        "overdue_amount": overdue_amount,
        "currency": currency,
    }, db=db, organization_id=organization_id, event_name="invoice.past_due")


def send_collections_notice_email(
    email: str,
    customer_name: str,
    invoice_number: str,
    days_overdue: str,
    overdue_amount: str,
    currency: str = "USD",
    late_fee: str = "0",
    organization_id=None,
    db=None,
    custom_body: str = None,
) -> bool:
    """Final-stage notice used when a debt is escalated to collections. Uses
    the same layout as dunning (optionally overridden by
    BillingConfiguration.final_notice_template) under a 'collections' subject."""
    return send_approval_email(email, "dunning_reminder.html", {
        "subject": f"Collection workflow started for invoice {invoice_number}",
        "customer_name": customer_name,
        "invoice_number": invoice_number,
        "days_overdue": days_overdue,
        "overdue_amount": overdue_amount,
        "currency": currency,
        "late_fee": late_fee,
    }, db=db, organization_id=organization_id, template_body=custom_body)


def send_payment_receipt_email(
    email: str,
    customer_name: str,
    payment_number: str,
    payment_date: str,
    amount: str,
    currency: str = "USD",
    payment_method: str = "",
    organization_id=None,
    db=None,
) -> bool:
    return send_approval_email(email, "payment_received.html", {
        "subject": f"Payment received by {{{{company_name}}}}",
        "customer_name": customer_name,
        "payment_number": payment_number,
        "payment_date": payment_date,
        "amount": amount,
        "currency": currency,
        "payment_method": payment_method,
    }, db=db, organization_id=organization_id)


def send_refund_email(
    email: str,
    customer_name: str,
    refund_number: str,
    refund_date: str,
    amount: str,
    currency: str = "USD",
    reason: str = "",
    organization_id=None,
    db=None,
    pdf_bytes: bytes = None,
    pdf_filename: str = None,
) -> bool:
    attachments = [(pdf_filename or f"{refund_number}.pdf", pdf_bytes)] if pdf_bytes else None
    return send_approval_email(email, "refund_processed.html", {
        "subject": f"Your refund from {{{{company_name}}}} is complete",
        "customer_name": customer_name,
        "refund_number": refund_number,
        "refund_date": refund_date,
        "amount": amount,
        "currency": currency,
        "reason": reason,
    }, db=db, organization_id=organization_id, attachments=attachments)


def send_write_off_email(
    email: str,
    customer_name: str,
    write_off_number: str,
    write_off_date: str,
    amount: str,
    currency: str = "USD",
    reason: str = "",
    organization_id=None,
    db=None,
    pdf_bytes: bytes = None,
    pdf_filename: str = None,
) -> bool:
    attachments = [(pdf_filename or f"{write_off_number}.pdf", pdf_bytes)] if pdf_bytes else None
    return send_approval_email(email, "write_off_executed.html", {
        "subject": f"Write-off decision recorded for {customer_name}",
        "customer_name": customer_name,
        "write_off_number": write_off_number,
        "write_off_date": write_off_date,
        "amount": amount,
        "currency": currency,
        "reason": reason,
    }, db=db, organization_id=organization_id, attachments=attachments)


def send_credit_note_email(
    email: str,
    customer_name: str,
    credit_note_number: str,
    issue_date: str,
    total_amount: str,
    currency: str = "USD",
    reason: str = "",
    organization_id=None,
    db=None,
    pdf_bytes: bytes = None,
    pdf_filename: str = None,
) -> bool:
    attachments = [(pdf_filename or f"{credit_note_number}.pdf", pdf_bytes)] if pdf_bytes else None
    return send_approval_email(email, "credit_note_issued.html", {
        "subject": f"Credit note {credit_note_number} from {{{{company_name}}}}",
        "customer_name": customer_name,
        "credit_note_number": credit_note_number,
        "issue_date": issue_date,
        "total_amount": total_amount,
        "currency": currency,
        "reason": reason,
    }, db=db, organization_id=organization_id, attachments=attachments, event_name="credit_note.issued")


# ── ZB-INV-011: Invoice pre-due reminder ─────────────────────────────────────

def send_invoice_reminder_email(
    email: str,
    customer_name: str,
    invoice_number: str,
    due_date: str,
    days_until_due: int,
    balance_due: str,
    currency: str = "USD",
    organization_id=None,
    db=None,
    review_url: str = "",
) -> bool:
    """ZB-INV-011: Pre-due invoice reminder.

    Sent N days before an invoice's due_date (where N = settings.INVOICE_REMINDER_LEAD_DAYS).
    Subject and preheader match the catalog spec verbatim.
    """
    from app.config import settings as _settings
    cta_url = review_url or f"{_settings.FRONTEND_URL.rstrip('/')}/billing/invoices"
    return send_approval_email(email, "invoice_sent.html", {
        "subject": f"Reminder: Invoice {invoice_number} from {{{{company_name}}}} is due in {days_until_due} day{'s' if days_until_due != 1 else ''}",
        "preheader": f"Payment of {currency} {balance_due} is due on {due_date}.",
        "customer_name": customer_name,
        "recipient_first_name": customer_name,
        "invoice_number": invoice_number,
        "due_date": due_date,
        "days_until_due": days_until_due,
        "balance_due": balance_due,
        "currency": currency,
        "cta_url": cta_url,
        "template_id": "ZB-INV-011",
    }, db=db, organization_id=organization_id, event_name="invoice.pre_due_reminder")


# ── ZB-COM-003: Trial ending soon warning ─────────────────────────────────────

def send_trial_ending_warning_email(
    email: str,
    recipient_first_name: str,
    organization_name: str,
    trial_ends_at: str,
    days_remaining: int,
    organization_id=None,
    db=None,
) -> bool:
    """ZB-COM-003: Trial ending soon — proactive warning N days before trial_ends_at.

    T3 template: consent-aware; the pipeline suppresses if org has opted out of
    lifecycle communications. Subject and body copy match catalog spec.
    """
    from app.config import settings as _settings
    upgrade_url = _settings.FRONTEND_URL.rstrip("/") + "/billing/plans"
    return send_approval_email(email, "product_welcome.html", {
        "subject": f"Your Zoiko Billing trial ends in {days_remaining} day{'s' if days_remaining != 1 else ''} — upgrade to keep access",
        "preheader": f"Your free trial expires on {trial_ends_at}. Upgrade now to avoid interruption.",
        "recipient_first_name": recipient_first_name or "there",
        "organization_name": organization_name,
        "trial_ends_at": trial_ends_at,
        "days_remaining": days_remaining,
        "upgrade_url": upgrade_url,
        "template_id": "ZB-COM-003",
    }, db=db, organization_id=organization_id, event_name="commercial.trial_ending_soon")


# ── ZB-COM-004: Trial expired / account suspended ─────────────────────────────

def send_trial_expired_email(
    email: str,
    recipient_first_name: str,
    organization_name: str,
    organization_id=None,
    db=None,
) -> bool:
    """ZB-COM-004: Trial expired and account suspended.

    T1 template: critical — sent immediately after trial_expiry.py transitions
    the subscription to SUSPENDED. Includes payment/upgrade CTA.
    """
    from app.config import settings as _settings
    upgrade_url = _settings.FRONTEND_URL.rstrip("/") + "/billing/plans"
    return send_approval_email(email, "org_created.html", {
        "subject": "Your Zoiko Billing trial has ended — reactivate to restore access",
        "preheader": f"Your trial for {organization_name} has expired. Upgrade now to restore access.",
        "recipient_first_name": recipient_first_name or "there",
        "organization_name": organization_name,
        "upgrade_url": upgrade_url,
        "template_id": "ZB-COM-004",
    }, db=db, organization_id=organization_id, event_name="commercial.trial_expired")


# ── ZB-COM-011: Past-due paid subscription suspension warning ─────────────────

def send_past_due_suspension_warning_email(
    email: str,
    recipient_first_name: str,
    organization_name: str,
    days_overdue: int,
    amount_due: str,
    currency: str = "USD",
    organization_id=None,
    db=None,
) -> bool:
    """ZB-COM-011: Past-due suspension warning for paid subscriptions.

    T1 template: sent by the commercial dunning job before suspending a paid
    subscription that has been past-due for enough days. Copy matches catalog spec.
    """
    from app.config import settings as _settings
    pay_url = _settings.FRONTEND_URL.rstrip("/") + "/billing/payments"
    return send_approval_email(email, "past_due_notice.html", {
        "subject": f"Action required: Your Zoiko Billing subscription is {days_overdue} days past due",
        "preheader": f"Pay {currency} {amount_due} now to avoid suspension of {organization_name}.",
        "recipient_first_name": recipient_first_name or "there",
        "organization_name": organization_name,
        "days_overdue": days_overdue,
        "overdue_amount": amount_due,
        "currency": currency,
        "pay_url": pay_url,
        "template_id": "ZB-COM-011",
    }, db=db, organization_id=organization_id, event_name="commercial.past_due_suspension_warning")


# ── Tier 2 Operational & Support Email Dispatches ────────────────────────────

def send_report_ready_email(
    email: str,
    recipient_first_name: str,
    report_name: str,
    report_url: str = "",
    organization_id=None,
    db=None,
) -> bool:
    """ZB-RPT-001: Scheduled financial or audit report is ready for download (T2)."""
    return send_approval_email(email, "org_created.html", {
        "subject": f"Your scheduled report '{report_name}' is ready",
        "preheader": f"Download your {report_name} from Zoiko Billing.",
        "recipient_first_name": recipient_first_name or "there",
        "report_name": report_name,
        "report_url": report_url,
        "template_id": "ZB-RPT-001",
    }, db=db, organization_id=organization_id, event_name="reports.scheduled_ready")


def send_support_ticket_updated_email(
    email: str,
    recipient_first_name: str,
    ticket_id: str,
    subject: str,
    status: str = "Updated",
    organization_id=None,
    db=None,
) -> bool:
    """ZB-SUP-001: Support ticket status update (T2)."""
    return send_approval_email(email, "org_created.html", {
        "subject": f"Support Ticket #{ticket_id}: {subject} [{status}]",
        "preheader": f"Your support ticket #{ticket_id} has been updated.",
        "recipient_first_name": recipient_first_name or "there",
        "ticket_id": ticket_id,
        "status": status,
        "template_id": "ZB-SUP-001",
    }, db=db, organization_id=organization_id, event_name="support.ticket_updated")


def send_service_maintenance_email(
    email: str,
    recipient_first_name: str,
    incident_title: str,
    scheduled_time: str = "",
    organization_id=None,
    db=None,
) -> bool:
    """ZB-SUP-005: Service incident or scheduled maintenance notice (T2)."""
    return send_approval_email(email, "org_created.html", {
        "subject": f"Maintenance Notice: {incident_title}",
        "preheader": f"Scheduled maintenance update for Zoiko Billing.",
        "recipient_first_name": recipient_first_name or "there",
        "incident_title": incident_title,
        "scheduled_time": scheduled_time,
        "template_id": "ZB-SUP-005",
    }, db=db, organization_id=organization_id, event_name="support.service_maintenance")


# ── Tier 3 & Tier 4 Consent-Gated Email Dispatches ───────────────────────────

def send_demo_request_received_email(
    email: str,
    recipient_first_name: str,
    organization_id=None,
    db=None,
) -> bool:
    """ZB-ACQ-001: Demo request received confirmation (T3 — consent-aware)."""
    return send_approval_email(email, "product_welcome.html", {
        "subject": "We received your Zoiko Billing demo request",
        "preheader": "Thank you for requesting a demo of Zoiko Billing.",
        "recipient_first_name": recipient_first_name or "there",
        "template_id": "ZB-ACQ-001",
    }, db=db, organization_id=organization_id, event_name="commercial.demo_requested")


def send_marketing_newsletter_email(
    email: str,
    recipient_first_name: str,
    campaign_title: str,
    organization_id=None,
    db=None,
) -> bool:
    """ZB-MKT-001: Promotional newsletter / product announcement (T4 — REQUIRES EXPLICIT OPT-IN CONSENT)."""
    return send_approval_email(email, "product_welcome.html", {
        "subject": f"Zoiko Billing Updates: {campaign_title}",
        "preheader": f"Latest features and updates: {campaign_title}.",
        "recipient_first_name": recipient_first_name or "there",
        "campaign_title": campaign_title,
        "template_id": "ZB-MKT-001",
    }, db=db, organization_id=organization_id, event_name="marketing.newsletter")


def send_preference_updated_email(
    email: str,
    recipient_first_name: str,
    organization_id=None,
    db=None,
) -> bool:
    """ZB-PRF-001: Email preference updated confirmation (T3 — consent-aware)."""
    return send_approval_email(email, "org_created.html", {
        "subject": "Your email communication preferences have been updated",
        "preheader": "Confirmation of your updated communication settings.",
        "recipient_first_name": recipient_first_name or "there",
        "template_id": "ZB-PRF-001",
    }, db=db, organization_id=organization_id, event_name="preferences.updated")
