"""
modules/billing/services/admin_service.py
------------------------------------------
Administration service for operational readiness: SMTP testing, email template
preview, diagnostics, billing health checks, and numbering preview.
"""

import logging
import os
import re
import smtplib
import ssl
import time
from datetime import date, datetime, timezone
from decimal import InvalidOperation
from email.mime.text import MIMEText
from typing import Dict, List, Optional

from sqlalchemy.orm import Session

from app.modules.billing.models import TaxRate, Invoice, Quotation, CreditNote, Refund, WriteOff
from app.modules.billing.utils.currency_utils import VALID_CURRENCY_CODES
from app.modules.billing.repositories.settings import BillingConfigurationRepository
from app.modules.billing.schemas import (
    SmtpConnectionResult,
    SmtpTestRequest,
    SmtpTestResponse,
    EmailTemplateListItem,
    EmailTemplatePreviewResponse,
    ExchangeRateDiagnosticsItem,
    ExchangeRateDiagnosticsResponse,
    NumberingDiagnosticsItem,
    TaxDiagnosticsItem,
    SystemDiagnosticComponent,
    BillingHealthCheckResponse,
    BillingConfigurationValidationDiagnostics,
)
from app.modules.billing.services.exchange_rate_service import ExchangeRateService
from app.modules.billing.services.validation_service import BillingValidationService
from app.modules.billing.services.settings_service import BillingConfigurationService
# Single source of truth for the templates directory: app/email_templates/.
# (This used to be computed independently here with one fewer os.path.dirname()
# hop than app/services/email_service.py's TEMPLATE_DIR, so it pointed at the
# non-existent app/modules/email_templates and always logged "not found".)
from app.services.email_service import TEMPLATE_DIR

logger = logging.getLogger("zoiko")

_IF_BLOCK_RE = re.compile(r"\{\{#if (\w+)\}\}(.*?)\{\{/if\}\}", re.DOTALL)
EMAIL_TEMPLATE_VARIABLE_RE = re.compile(r"\{\{(\w+)\}\}")


def _render_local_template(template: str, context: dict) -> str:
    def _eval_if(match):
        key, inner = match.group(1), match.group(2)
        return inner if context.get(key) else ""
    result = _IF_BLOCK_RE.sub(_eval_if, template)
    for key, value in context.items():
        if value is None:
            value = ""
        result = result.replace("{{" + key + "}}", str(value))
    return result


class BillingAdminService:
    """
    Operational readiness service for billing administrators.
    Provides SMTP testing, template preview, diagnostics, health checks,
    and numbering sequence preview.
    """

    def __init__(self, db: Session):
        self.db = db
        self.repo = BillingConfigurationRepository(db)
        self.config_svc = BillingConfigurationService(db)
        self.validation_svc = BillingValidationService(db)
        self.exchange_svc = ExchangeRateService(db)

    # ── SMTP Testing ──────────────────────────────────────────────────────────

    def test_smtp_connection(self, organization_id: int, request: SmtpTestRequest) -> SmtpTestResponse:
        from app.modules.super_admin.models import PlatformSetting
        from app.config import settings as _settings

        smtp_host = _settings.SMTP_HOST
        smtp_port = _settings.SMTP_PORT
        smtp_user = _settings.SMTP_USERNAME
        smtp_pass = _settings.SMTP_PASSWORD
        smtp_from = _settings.SMTP_FROM_EMAIL
        use_tls = _settings.SMTP_USE_TLS

        try:
            settings = self.db.query(PlatformSetting).filter(
                PlatformSetting.category == "email"
            ).all()
            mapping = {s.key: s.value for s in settings if s.value}
            smtp_host = mapping.get("smtp_host", smtp_host)
            smtp_port = int(mapping.get("smtp_port", smtp_port))
            smtp_user = mapping.get("smtp_username", smtp_user)
            smtp_from = mapping.get("smtp_from_email", smtp_from)
            use_tls = mapping.get("smtp_use_tls", use_tls)
        except Exception as e:
            logger.warning("Could not load SMTP settings from DB, using defaults: %s", e)

        if isinstance(use_tls, str):
            use_tls = use_tls.lower() in ("true", "1", "yes")

        errors = []
        if not smtp_host:
            errors.append("SMTP host is not configured")
        if not smtp_port:
            errors.append("SMTP port is not configured")
        if not smtp_user:
            errors.append("SMTP username is not configured")
        if not smtp_pass:
            errors.append("SMTP password is not configured")
        if not smtp_from:
            errors.append("SMTP from-email is not configured")

        if errors:
            return SmtpTestResponse(
                success=False,
                message="; ".join(errors),
                connection=SmtpConnectionResult(ok=False, message="Not attempted — configuration incomplete"),
                tls=SmtpConnectionResult(ok=False, message="Not attempted"),
                authentication=SmtpConnectionResult(ok=False, message="Not attempted"),
                sender_identity=SmtpConnectionResult(ok=False, message="Not attempted"),
                test_email_sent=SmtpConnectionResult(ok=False, message="Not attempted"),
                smtp_host=smtp_host,
                smtp_port=smtp_port,
                from_email=smtp_from,
            )

        connection_result = SmtpConnectionResult(ok=False, message="Not attempted")
        tls_result = SmtpConnectionResult(ok=False, message="Not attempted")
        auth_result = SmtpConnectionResult(ok=False, message="Not attempted")
        sender_result = SmtpConnectionResult(ok=False, message="Not attempted")
        email_result = SmtpConnectionResult(ok=False, message="Not attempted")
        server = None

        try:
            start = time.time()
            connection_result.message = f"Connecting to {smtp_host}:{smtp_port}..."
            server = smtplib.SMTP(smtp_host, smtp_port, timeout=10)
            elapsed = (time.time() - start) * 1000
            connection_result.ok = True
            connection_result.message = f"Connected to {smtp_host}:{smtp_port}"
            connection_result.response_time_ms = round(elapsed, 2)

            if use_tls:
                tls_start = time.time()
                server.starttls(context=ssl.create_default_context())
                tls_elapsed = (time.time() - tls_start) * 1000
                tls_result.ok = True
                tls_result.message = "TLS/STARTTLS negotiation succeeded"
                tls_result.response_time_ms = round(tls_elapsed, 2)
            else:
                tls_result.message = "TLS not configured (plain-text connection)"
                tls_result.ok = True

            auth_start = time.time()
            server.login(smtp_user, smtp_pass)
            auth_elapsed = (time.time() - auth_start) * 1000
            auth_result.ok = True
            auth_result.message = "SMTP authentication succeeded"
            auth_result.response_time_ms = round(auth_elapsed, 2)

            sender_result.ok = True
            sender_result.message = f"Sender identity: {smtp_from}"

            msg = MIMEText(
                f"This is a test email from Zoiko Billing.\n\n"
                f"Organization: {organization_id}\n"
                f"Timestamp: {datetime.utcnow().isoformat()}Z\n\n"
                f"SMTP Configuration Test Results:\n"
                f"  Host: {smtp_host}:{smtp_port}\n"
                f"  TLS: {'Enabled' if use_tls else 'Disabled'}\n"
                f"  Auth: {'Success' if auth_result.ok else 'Failed'}\n"
                f"  From: {smtp_from}\n\n"
                f"If you received this email, your SMTP configuration is working correctly."
            )
            msg["Subject"] = request.test_subject
            msg["From"] = smtp_from
            msg["To"] = request.recipient_email

            email_start = time.time()
            server.sendmail(smtp_from, [request.recipient_email], msg.as_string())
            email_elapsed = (time.time() - email_start) * 1000
            email_result.ok = True
            email_result.message = f"Test email sent to {request.recipient_email}"
            email_result.response_time_ms = round(email_elapsed, 2)

            return SmtpTestResponse(
                success=True,
                message="SMTP configuration is valid. Test email sent successfully.",
                connection=connection_result, tls=tls_result,
                authentication=auth_result, sender_identity=sender_result,
                test_email_sent=email_result,
                smtp_host=smtp_host, smtp_port=smtp_port, from_email=smtp_from,
            )

        except smtplib.SMTPAuthenticationError as e:
            auth_result.message = f"Authentication failed: {e}"
            return SmtpTestResponse(success=False, message="SMTP authentication failed. Please check your username and password.", connection=connection_result, tls=tls_result, authentication=auth_result, sender_identity=sender_result, test_email_sent=email_result, smtp_host=smtp_host, smtp_port=smtp_port, from_email=smtp_from)
        except smtplib.SMTPConnectError as e:
            connection_result.message = f"Connection failed: {e}"
            return SmtpTestResponse(success=False, message=f"Could not connect to SMTP server at {smtp_host}:{smtp_port}. Check the host and port.", connection=connection_result, tls=tls_result, authentication=auth_result, sender_identity=sender_result, test_email_sent=email_result, smtp_host=smtp_host, smtp_port=smtp_port, from_email=smtp_from)
        except smtplib.SMTPException as e:
            return SmtpTestResponse(success=False, message=f"SMTP error: {e}", connection=connection_result, tls=tls_result, authentication=auth_result, sender_identity=sender_result, test_email_sent=email_result, smtp_host=smtp_host, smtp_port=smtp_port, from_email=smtp_from)
        except Exception as e:
            return SmtpTestResponse(success=False, message=f"Unexpected error: {e}", connection=connection_result, tls=tls_result, authentication=auth_result, sender_identity=sender_result, test_email_sent=email_result, smtp_host=smtp_host, smtp_port=smtp_port, from_email=smtp_from)
        finally:
            if server:
                try:
                    server.quit()
                except Exception:
                    pass

    # ── SMTP config check (lightweight, no connection attempt) ────────────────

    def _get_smtp_config(self) -> dict:
        from app.modules.super_admin.models import PlatformSetting
        from app.config import settings as _settings
        cfg = {
            "host": _settings.SMTP_HOST,
            "port": _settings.SMTP_PORT,
            "username": _settings.SMTP_USERNAME,
            "from_email": _settings.SMTP_FROM_EMAIL,
            "has_password": bool(_settings.SMTP_PASSWORD),
            "use_tls": _settings.SMTP_USE_TLS,
        }
        try:
            settings = self.db.query(PlatformSetting).filter(
                PlatformSetting.category == "email"
            ).all()
            mapping = {s.key: s.value for s in settings if s.value}
            for k in ("host", "port", "username", "from_email"):
                dk = f"smtp_{k}"
                if dk in mapping:
                    cfg[k] = mapping[dk]
            if "smtp_use_tls" in mapping:
                cfg["use_tls"] = mapping["smtp_use_tls"]
        except Exception:
            pass
        return cfg

    # ── Email Template Preview ────────────────────────────────────────────────

    def list_email_templates(self) -> List[EmailTemplateListItem]:
        if not os.path.isdir(TEMPLATE_DIR):
            logger.warning("Email template directory not found: %s", TEMPLATE_DIR)
            return []
        items = []
        for fname in sorted(os.listdir(TEMPLATE_DIR)):
            if not fname.endswith(".html"):
                continue
            fpath = os.path.join(TEMPLATE_DIR, fname)
            try:
                stat = os.stat(fpath)
                mtime = datetime.fromtimestamp(stat.st_mtime).isoformat()
                items.append(EmailTemplateListItem(
                    name=fname.replace(".html", ""), path=fpath,
                    size_bytes=stat.st_size, last_modified=mtime,
                ))
            except OSError:
                items.append(EmailTemplateListItem(
                    name=fname.replace(".html", ""), path=fpath, size_bytes=0,
                ))
        return items

    def preview_email_template(
        self, template_name: str, variables: Optional[Dict[str, str]] = None,
    ) -> EmailTemplatePreviewResponse:
        fname = f"{template_name}.html" if not template_name.endswith(".html") else template_name
        # template_name is client-supplied; reject any path separator/traversal segment
        # before joining, and re-verify containment on the resolved path as defense in depth.
        if not template_name or os.path.basename(fname) != fname or ".." in template_name:
            raise FileNotFoundError(
                f"Email template '{template_name}' not found. "
                f"Available: {[t.name for t in self.list_email_templates()]}"
            )
        fpath = os.path.join(TEMPLATE_DIR, fname)
        real_template_dir = os.path.realpath(TEMPLATE_DIR)
        real_fpath = os.path.realpath(fpath)
        if os.path.dirname(real_fpath) != real_template_dir or not os.path.isfile(fpath):
            raise FileNotFoundError(
                f"Email template '{template_name}' not found. "
                f"Available: {[t.name for t in self.list_email_templates()]}"
            )
        with open(fpath, "r", encoding="utf-8") as f:
            html_content = f.read()
        variables_found = sorted(set(EMAIL_TEMPLATE_VARIABLE_RE.findall(html_content)))
        variables_provided = list(variables.keys()) if variables else []
        variables_missing = sorted(set(variables_found) - set(variables_provided))
        context = dict(variables) if variables else {}
        rendered_html = _render_local_template(html_content, context)
        subject = f"Template: {template_name}"
        title_match = re.search(r"<title[^>]*>(.*?)</title>", html_content, re.IGNORECASE)
        if title_match:
            subject = title_match.group(1).strip()
        return EmailTemplatePreviewResponse(
            template_name=template_name, subject=subject,
            html_content=html_content, variables_found=variables_found,
            variables_provided=variables_provided,
            variables_missing=variables_missing, rendered_html=rendered_html,
        )

    # ── STEP 7: Numbering Diagnostics (enhanced) ─────────────────────────────

    def get_numbering_diagnostics(self, organization_id: int) -> List[NumberingDiagnosticsItem]:
        config = self.repo.get_by_organization(organization_id)
        if not config:
            return []
        items = []
        entities = [
            ("Invoice",     "invoice_prefix",      "invoice_number_format",
             "invoice_sequence_reset", "auto_generate_invoice_number", Invoice),
            ("Quote",       "quote_prefix",        "quote_number_format",
             "quote_sequence_reset", None, Quotation),
            ("Credit Note", "credit_note_prefix",  "credit_note_number_format",
             "credit_note_sequence_reset", None, CreditNote),
            ("Refund",      "refund_prefix",       "refund_number_format",
             "refund_sequence_reset", None, Refund),
            ("Write-off",   "write_off_prefix",    "write_off_number_format",
             "write_off_sequence_reset", None, WriteOff),
        ]
        used_prefixes = {}
        now = datetime.utcnow()
        year = now.year
        month = now.month
        month_padded = f"{month:02d}"

        for ent_name, prefix_field, fmt_field, reset_field, auto_field, model_cls in entities:
            prefix = getattr(config, prefix_field, None) or ""
            fmt = getattr(config, fmt_field, None)
            reset = getattr(config, reset_field, None)
            auto_gen = getattr(config, auto_field, False) if auto_field else False

            fmt_str = fmt.value if hasattr(fmt, 'value') else str(fmt) if fmt else ""
            reset_str = reset.value if hasattr(reset, 'value') else str(reset) if reset else ""

            warnings = []
            suggestion = None

            # Check prefix uniqueness across entities
            if prefix and prefix in used_prefixes:
                warnings.append(f"Prefix '{prefix}' is also used by {used_prefixes[prefix]} — sequence number collision risk")
            used_prefixes[prefix] = ent_name

            if not prefix:
                warnings.append("No prefix configured")
            if not fmt_str:
                warnings.append("No number format configured")
            elif prefix and fmt_str:
                # Validate prefix + format compatibility
                if fmt_str.startswith("PREFIX-") and prefix not in fmt_str and "PREFIX" not in fmt_str:
                    warnings.append(f"Format '{fmt_str}' does not include prefix '{prefix}' — number may not contain prefix")
                if prefix and len(prefix) > 10:
                    warnings.append(f"Prefix '{prefix}' is longer than 10 characters")

            # Check sequence collision risk: same prefix + same reset period = guaranteed collision
            for other_ent, other_prefix_field, _, other_reset_field, _, _ in entities:
                if other_ent == ent_name:
                    continue
                other_prefix = getattr(config, other_prefix_field, None) or ""
                other_reset = getattr(config, other_reset_field, None)
                other_reset_str = other_reset.value if hasattr(other_reset, 'value') else str(other_reset) if other_reset else ""
                if prefix and other_prefix and prefix == other_prefix and reset_str == other_reset_str:
                    warnings.append(f"Same prefix '{prefix}' and reset '{reset_str}' as {other_ent} — numbers will collide")

            # Preview next number
            next_number = self._preview_next_number(
                organization_id, prefix, fmt_str, reset_str, model_cls, year, month, month_padded,
            )

            suggestion = None
            if warnings:
                if "collision" in warnings[0].lower():
                    suggestion = f"Change the prefix for {ent_name.lower()} to avoid collision"
                elif "No prefix" in warnings[0]:
                    suggestion = f"Set a unique prefix for {ent_name.lower()} numbers"
                else:
                    suggestion = f"Review configuration for {ent_name.lower()}"

            items.append(NumberingDiagnosticsItem(
                entity=ent_name, prefix=prefix,
                format=fmt_str, sequence_reset=reset_str,
                auto_generate=auto_gen, valid=len(warnings) == 0,
                warnings=warnings, suggestion=suggestion,
                next_number=next_number,
            ))
        return items

    def _preview_next_number(
        self, organization_id: int, prefix: str, fmt: str,
        reset: str, model_cls, year: int, month: int, month_padded: str,
    ) -> Optional[str]:
        if not prefix or not fmt:
            return None
        try:
            # Determine sequence scope based on reset policy
            seq_scope = self._sequence_scope(organization_id, model_cls, reset, year, month)
            next_seq = seq_scope + 1 if seq_scope else 1
            seq_padded = f"{next_seq:04d}"
            # Build the formatted number
            number = fmt.replace("PREFIX-", prefix + "-")
            number = number.replace("{PREFIX}", prefix)
            number = number.replace("{YYYY}", str(year))
            number = number.replace("{MM}", month_padded)
            number = number.replace("{YYYYMM}", f"{year}{month_padded}")
            number = number.replace("{SEQ}", seq_padded)
            return number
        except Exception as e:
            logger.debug("Could not preview next number for %s: %s", model_cls.__name__, e)
            return None

    def _sequence_scope(self, organization_id: int, model_cls, reset: str, year: int, month: int) -> int:
        """Count existing records to determine the current sequence scope."""
        if not model_cls or not hasattr(model_cls, 'organization_id'):
            return 0
        try:
            query = self.db.query(model_cls).filter(
                model_cls.organization_id == organization_id
            )
            if reset == "monthly":
                # Scope: current year+month
                query = query.filter(
                    (model_cls.created_at >= datetime(year, month, 1)) |
                    (model_cls.created_at >= date(year, month, 1))
                )
            elif reset == "quarterly":
                q_start_month = ((month - 1) // 3) * 3 + 1
                query = query.filter(
                    (model_cls.created_at >= datetime(year, q_start_month, 1)) |
                    (model_cls.created_at >= date(year, q_start_month, 1))
                )
            elif reset == "annually":
                query = query.filter(
                    (model_cls.created_at >= datetime(year, 1, 1)) |
                    (model_cls.created_at >= date(year, 1, 1))
                )
            return query.count()
        except Exception:
            return 0

    # ── STEP 6: Tax Diagnostics (enhanced) ────────────────────────────────────

    def get_tax_diagnostics(self, organization_id: int) -> List[TaxDiagnosticsItem]:
        config = self.repo.get_by_organization(organization_id)
        items = []

        # 1. Configuration-level checks (from BillingConfiguration)
        tax_fields = [
            ("tax_calculation_method",    "Tax calculation method"),
            ("tax_label",                 "Tax label"),
            ("tax_number",                "Tax registration number"),
            ("tax_rounding_method",       "Tax rounding method"),
            ("default_tax_rate_id",       "Default tax rate ID"),
            ("is_tax_inclusive_default",  "Tax inclusive by default"),
            ("show_tax_on_invoice",       "Show tax on invoice"),
            ("enable_auto_tax_calculation", "Auto tax calculation"),
        ]
        for field, label in tax_fields:
            val = getattr(config, field, None) if config else None
            warnings = []
            suggestion = None
            if val is None or (isinstance(val, str) and not val.strip()):
                warnings.append(f"{label} is not configured")
                suggestion = f"Configure {label.lower()} in billing settings"
            elif isinstance(val, bool) and not val:
                warnings.append(f"{label} is disabled")

            # Special: validate default_tax_rate_id references an active rate
            if field == "default_tax_rate_id" and val is not None:
                try:
                    rate_id = int(val)
                    rate = self.db.query(TaxRate).filter(
                        TaxRate.id == rate_id,
                        TaxRate.organization_id == organization_id,
                    ).first()
                    if not rate:
                        warnings.append(f"Default tax rate ID {val} not found in tax_rates table")
                    elif not rate.is_active:
                        warnings.append(f"Default tax rate '{rate.name}' (ID {val}) is inactive")
                    elif rate.effective_to and rate.effective_to < date.today():
                        warnings.append(f"Default tax rate '{rate.name}' expired on {rate.effective_to}")
                except (ValueError, TypeError):
                    warnings.append(f"Default tax rate ID '{val}' is not a valid integer")

            items.append(TaxDiagnosticsItem(
                field=field, value=str(val) if val is not None else None,
                valid=len(warnings) == 0, warnings=warnings, suggestion=suggestion,
            ))

        # 2. TaxRate entity checks from DB
        try:
            all_rates = self.db.query(TaxRate).filter(
                TaxRate.organization_id == organization_id
            ).all()

            # Inactive rates
            inactive_rates = [r for r in all_rates if not r.is_active]
            if inactive_rates:
                names = ", ".join(f"'{r.name}' (ID {r.id})" for r in inactive_rates[:5])
                items.append(TaxDiagnosticsItem(
                    field="tax_rates.is_active",
                    value=f"{len(inactive_rates)} inactive",
                    valid=False,
                    warnings=[f"{len(inactive_rates)} tax rate(s) are inactive: {names}" +
                              (f" and {len(inactive_rates) - 5} more" if len(inactive_rates) > 5 else "")],
                    suggestion="Review inactive tax rates — consider reactivating or removing them",
                ))
            else:
                items.append(TaxDiagnosticsItem(
                    field="tax_rates.is_active", value="All active",
                    valid=True, warnings=[],
                ))

            # Expired rates (effective_to in the past)
            today = date.today()
            expired = [r for r in all_rates if r.effective_to and r.effective_to < today]
            if expired:
                names = ", ".join(f"'{r.name}' (expired {r.effective_to})" for r in expired[:5])
                items.append(TaxDiagnosticsItem(
                    field="tax_rates.effective_to",
                    value=f"{len(expired)} expired",
                    valid=False,
                    warnings=[f"{len(expired)} tax rate(s) have expired: {names}" +
                              (f" and {len(expired) - 5} more" if len(expired) > 5 else "")],
                    suggestion="Extend effective_to dates or create replacement rates",
                ))

            # Duplicate codes (same code across rates — unique constraint prevents, so check logically)
            codes = [r.code for r in all_rates if r.is_active]
            if len(codes) != len(set(codes)):
                items.append(TaxDiagnosticsItem(
                    field="tax_rates.code", value="Duplicate codes detected",
                    valid=False, warnings=["Duplicate tax rate codes exist (should not happen with DB constraint)"],
                    suggestion="Investigate data integrity issue",
                ))

            # Country-specific checks
            country = (config.country or "").strip() if config else ""
            if country == "India":
                if not any(r.country_code == "IN" for r in all_rates):
                    items.append(TaxDiagnosticsItem(
                        field="tax_rates.country", value="No Indian tax rates",
                        valid=False,
                        warnings=["No tax rates configured for India (country_code = IN)"],
                        suggestion="Create GST-compliant tax rates for India",
                    ))
            elif country in ("United Kingdom", "Germany", "France", "Italy", "Spain", "Netherlands", "Belgium"):
                if not any(r.country_code and r.country_code.upper() in ("GB", "DE", "FR", "IT", "ES", "NL", "BE", "EU") for r in all_rates):
                    items.append(TaxDiagnosticsItem(
                        field="tax_rates.country", value="No EU tax rates",
                        valid=False,
                        warnings=["No tax rates configured for the selected EU country"],
                        suggestion="Create VAT-compliant tax rates",
                    ))

            # No rates at all
            if not all_rates:
                items.append(TaxDiagnosticsItem(
                    field="tax_rates", value="No rates found",
                    valid=False, warnings=["No tax rates exist in the database"],
                    suggestion="Create at least one tax rate for your country",
                ))

        except Exception as e:
            logger.warning("Could not query TaxRate records: %s", e)
            items.append(TaxDiagnosticsItem(
                field="tax_rates", value="Query failed",
                valid=False, warnings=[f"Could not read tax rates: {e}"],
                suggestion="Check database connectivity",
            ))

        if not config:
            return items
        return items

    # ── STEP 5: Exchange Rate Diagnostics (enhanced) ─────────────────────────

    def get_exchange_rate_diagnostics(self, organization_id: int) -> ExchangeRateDiagnosticsResponse:
        config = self.repo.get_by_organization(organization_id)
        if not config:
            return ExchangeRateDiagnosticsResponse(
                provider=ExchangeRateDiagnosticsItem(
                    field="provider", value=None, valid=False,
                    warnings=["No billing configuration found"],
                ),
                base_currency=ExchangeRateDiagnosticsItem(field="base_currency", value=None, valid=False),
                last_refreshed=ExchangeRateDiagnosticsItem(field="last_refreshed", value=None, valid=False),
                valid=False,
            )

        provider_val = config.exchange_rate_provider
        provider_str = provider_val.value if hasattr(provider_val, 'value') else str(provider_val) if provider_val else "manual"
        provider_warnings = []
        if provider_str == "manual":
            provider_warnings.append("Manual rates require periodic updates")

        provider_item = ExchangeRateDiagnosticsItem(
            field="provider", value=provider_str,
            valid=bool(provider_val), warnings=provider_warnings,
        )

        base_ccy = config.exchange_rate_base_currency or (
            config.base_currency.value if hasattr(config.base_currency, 'value')
            else str(config.base_currency) if config.base_currency else "USD"
        )

        last_refreshed = config.exchange_rate_last_refreshed
        staleness_hours = None
        refresh_warnings = []
        if last_refreshed:
            if last_refreshed.tzinfo is None:
                last_refreshed = last_refreshed.replace(tzinfo=timezone.utc)
            staleness_hours = (datetime.utcnow() - last_refreshed.replace(tzinfo=None)).total_seconds() / 3600
            if staleness_hours > 24:
                refresh_warnings.append(f"Rates are {int(staleness_hours)}h old (threshold: 24h)")
        else:
            refresh_warnings.append("Rates have never been refreshed")

        last_refreshed_item = ExchangeRateDiagnosticsItem(
            field="last_refreshed",
            value=last_refreshed.isoformat() if last_refreshed else None,
            valid=len(refresh_warnings) == 0, warnings=refresh_warnings,
        )

        # Enhanced: validate individual cached rate values
        cached_rates = dict(config.exchange_rates) if config.exchange_rates else {}
        cached_rates_clean = {}
        rate_warnings = []
        for k, v in cached_rates.items():
            try:
                fv = float(v)
                if fv <= 0:
                    rate_warnings.append(f"Rate for {k} is zero or negative ({fv}) — data may be corrupt")
                elif fv > 100000:
                    rate_warnings.append(f"Rate for {k} is unusually high ({fv}) — verify data")
                cached_rates_clean[k] = fv
            except (TypeError, ValueError, InvalidOperation):
                rate_warnings.append(f"Rate for {k} has invalid value '{v}'")

        # Detect inactive currencies: currencies in supported_currencies but missing from cached_rates
        supported = set(config.supported_currencies or [])
        inactive_currencies = sorted(supported - set(cached_rates_clean.keys()) - {base_ccy})
        if inactive_currencies:
            rate_warnings.append(
                f"{len(inactive_currencies)} supported currency/currencies missing from cached rates: {', '.join(inactive_currencies[:10])}"
            )

        all_valid = provider_item.valid and last_refreshed_item.valid and len(rate_warnings) == 0

        return ExchangeRateDiagnosticsResponse(
            provider=provider_item,
            base_currency=ExchangeRateDiagnosticsItem(field="base_currency", value=base_ccy, valid=True),
            last_refreshed=last_refreshed_item,
            staleness_hours=round(staleness_hours, 1) if staleness_hours is not None else None,
            cached_rates_count=len(cached_rates_clean),
            cached_rates=cached_rates_clean,
            valid=all_valid,
            rate_warnings=rate_warnings,
            inactive_currencies=inactive_currencies,
        )

    # ── STEP 8: Billing Health Check (enhanced) ───────────────────────────────

    def run_billing_health_check(self, organization_id: int) -> BillingHealthCheckResponse:
        components = []
        config = self.repo.get_by_organization(organization_id)
        checks_at = datetime.utcnow().isoformat() + "Z"

        # 1. Database connectivity check
        start = time.time()
        try:
            from sqlalchemy import text
            self.db.execute(text("SELECT 1"))
            db_elapsed = (time.time() - start) * 1000
            components.append(SystemDiagnosticComponent(
                name="database", status="healthy",
                message="Database connection is responding",
                response_time_ms=round(db_elapsed, 2),
            ))
        except Exception as e:
            db_elapsed = (time.time() - start) * 1000
            components.append(SystemDiagnosticComponent(
                name="database", status="down",
                message=f"Database connection failed: {e}",
                response_time_ms=round(db_elapsed, 2),
            ))

        # 2. Configuration exists check
        start = time.time()
        if config:
            elapsed = (time.time() - start) * 1000
            components.append(SystemDiagnosticComponent(
                name="billing_configuration", status="healthy",
                message="Billing configuration exists",
                response_time_ms=round(elapsed, 2),
            ))
        else:
            elapsed = (time.time() - start) * 1000
            components.append(SystemDiagnosticComponent(
                name="billing_configuration", status="down",
                message="Billing configuration not found. Create one via billing settings.",
                response_time_ms=round(elapsed, 2),
            ))
            # Cannot proceed without config — return early
            return BillingHealthCheckResponse(
                overall_status="down", readiness_score=0,
                components=components, checked_at=checks_at,
            )

        # 3. Company profile check
        start = time.time()
        missing_profile = []
        for f in ("company_name", "billing_email", "country"):
            if not getattr(config, f, None):
                missing_profile.append(f)
        elapsed = (time.time() - start) * 1000
        components.append(SystemDiagnosticComponent(
            name="company_profile",
            status="degraded" if missing_profile else "healthy",
            message=f"Missing fields: {', '.join(missing_profile)}" if missing_profile else "Company profile is complete",
            response_time_ms=round(elapsed, 2),
        ))

        # 4. SMTP check (config + lightweight connection attempt)
        start = time.time()
        smtp_cfg = self._get_smtp_config()
        smtp_configured = bool(smtp_cfg["host"] and smtp_cfg["port"] and smtp_cfg["from_email"])
        smtp_connectable = False

        if smtp_configured:
            try:
                s = smtplib.SMTP(smtp_cfg["host"], int(smtp_cfg["port"]), timeout=5)
                smtp_connectable = True
                smtp_response_time_ms = (time.time() - start) * 1000
                s.quit()
            except Exception:
                pass

        elapsed = (time.time() - start) * 1000
        if smtp_configured and smtp_connectable:
            components.append(SystemDiagnosticComponent(
                name="smtp_configuration", status="healthy",
                message=f"SMTP reachable ({smtp_cfg['host']}:{smtp_cfg['port']})",
                details={"host": smtp_cfg["host"], "port": smtp_cfg["port"],
                         "from_email": smtp_cfg["from_email"]},
                response_time_ms=round(smtp_response_time_ms or elapsed, 2),
            ))
        elif smtp_configured:
            components.append(SystemDiagnosticComponent(
                name="smtp_configuration", status="degraded",
                message=f"SMTP configured but not reachable ({smtp_cfg['host']}:{smtp_cfg['port']})",
                response_time_ms=round(elapsed, 2),
            ))
        else:
            missing = [k for k in ("host", "port", "from_email") if not smtp_cfg[k]]
            components.append(SystemDiagnosticComponent(
                name="smtp_configuration", status="degraded",
                message=f"SMTP incomplete: {', '.join(missing)} not configured",
                response_time_ms=round(elapsed, 2),
            ))

        # 5. Email templates check
        start = time.time()
        template_items = self.list_email_templates()
        elapsed = (time.time() - start) * 1000
        components.append(SystemDiagnosticComponent(
            name="email_templates",
            status="healthy" if template_items else "degraded",
            message=f"{len(template_items)} email template(s) available" if template_items else "No email templates found",
            details={"count": len(template_items),
                     "templates": [t.name for t in template_items]} if template_items else None,
            response_time_ms=round(elapsed, 2),
        ))

        # 6. Validation / Readiness score
        start = time.time()
        try:
            validation_result = self.validation_svc.validate(organization_id=organization_id)
            score = validation_result.get("readiness_score", 0)
            elapsed = (time.time() - start) * 1000
            status = "healthy" if score >= 80 else "degraded" if score >= 40 else "down"
            components.append(SystemDiagnosticComponent(
                name="configuration_readiness", status=status,
                message=f"Readiness score: {score}/100 ({validation_result.get('passed_count', 0)} passed, "
                        f"{validation_result.get('warning_count', 0)} warnings, "
                        f"{validation_result.get('error_count', 0)} errors)",
                response_time_ms=round(elapsed, 2),
            ))
        except Exception as e:
            elapsed = (time.time() - start) * 1000
            components.append(SystemDiagnosticComponent(
                name="configuration_readiness", status="down",
                message=f"Validation failed: {e}",
                response_time_ms=round(elapsed, 2),
            ))

        # 7. Exchange rates check (enhanced with rate-level validation)
        start = time.time()
        try:
            er_diag = self.get_exchange_rate_diagnostics(organization_id)
            elapsed = (time.time() - start) * 1000
            er_status = "healthy"
            er_messages = []
            if not er_diag.provider.valid:
                er_status = "degraded"
                er_messages.append("No provider configured")
            if er_diag.staleness_hours and er_diag.staleness_hours > 48:
                er_status = "degraded"
                er_messages.append(f"Rates stale ({int(er_diag.staleness_hours)}h)")
            if er_diag.cached_rates_count == 0 and er_diag.provider.value != "manual":
                er_status = "degraded"
                er_messages.append("No cached rates")
            if er_diag.rate_warnings:
                er_status = "degraded"
                er_messages.append(f"{len(er_diag.rate_warnings)} rate issue(s)")
            if er_diag.inactive_currencies:
                if er_status == "healthy":
                    er_status = "degraded"
                er_messages.append(f"{len(er_diag.inactive_currencies)} missing currency/currencies")
            components.append(SystemDiagnosticComponent(
                name="exchange_rates", status=er_status,
                message=er_messages[0] if er_messages
                        else f"{er_diag.cached_rates_count} rate(s) cached, {len(er_diag.inactive_currencies)} missing",
                details={"cached_count": er_diag.cached_rates_count,
                         "inactive_currencies": er_diag.inactive_currencies,
                         "rate_warnings": er_diag.rate_warnings} if er_diag.rate_warnings or er_diag.inactive_currencies else None,
                response_time_ms=round(elapsed, 2),
            ))
        except Exception as e:
            elapsed = (time.time() - start) * 1000
            components.append(SystemDiagnosticComponent(
                name="exchange_rates", status="down",
                message=f"Exchange rate check failed: {e}",
                response_time_ms=round(elapsed, 2),
            ))

        # 8. Tax configuration check (direct from DB)
        start = time.time()
        try:
            tax_rates_count = self.db.query(TaxRate).filter(
                TaxRate.organization_id == organization_id,
                TaxRate.is_active == True,
            ).count()
            inactive_tax_count = self.db.query(TaxRate).filter(
                TaxRate.organization_id == organization_id,
                TaxRate.is_active == False,
            ).count()
            today = date.today()
            expired_count = self.db.query(TaxRate).filter(
                TaxRate.organization_id == organization_id,
                TaxRate.effective_to.isnot(None),
                TaxRate.effective_to < today,
            ).count()
            elapsed = (time.time() - start) * 1000

            tax_messages = []
            tax_status = "healthy"
            if tax_rates_count == 0:
                tax_status = "degraded"
                tax_messages.append("No active tax rates")
            if inactive_tax_count > 0:
                tax_status = "degraded"
                tax_messages.append(f"{inactive_tax_count} inactive rate(s)")
            if expired_count > 0:
                tax_status = "degraded"
                tax_messages.append(f"{expired_count} expired rate(s)")
            if not tax_messages:
                tax_messages.append(f"{tax_rates_count} active tax rate(s)")

            components.append(SystemDiagnosticComponent(
                name="tax_configuration", status=tax_status,
                message="; ".join(tax_messages),
                details={"active_rates": tax_rates_count,
                         "inactive_rates": inactive_tax_count,
                         "expired_rates": expired_count},
                response_time_ms=round(elapsed, 2),
            ))
        except Exception as e:
            elapsed = (time.time() - start) * 1000
            components.append(SystemDiagnosticComponent(
                name="tax_configuration", status="down",
                message=f"Tax check failed: {e}",
                response_time_ms=round(elapsed, 2),
            ))

        # 9. Numbering check with sequence status
        start = time.time()
        try:
            numbering_items = self.get_numbering_diagnostics(organization_id)
            elapsed = (time.time() - start) * 1000
            num_warnings = sum(len(n.warnings) for n in numbering_items)
            num_valid = sum(1 for n in numbering_items if n.valid)
            num_total = len(numbering_items)
            numbering_status = "healthy" if num_warnings == 0 else "degraded"
            components.append(SystemDiagnosticComponent(
                name="document_numbering", status=numbering_status,
                message=f"{num_valid}/{num_total} entities valid, {num_warnings} warning(s)" if num_warnings
                        else f"All {num_total} numbering entities valid",
                details={"entities": [n.entity for n in numbering_items],
                         "next_numbers": {n.entity: n.next_number for n in numbering_items if n.next_number}},
                response_time_ms=round(elapsed, 2),
            ))
        except Exception as e:
            elapsed = (time.time() - start) * 1000
            components.append(SystemDiagnosticComponent(
                name="document_numbering", status="down",
                message=f"Numbering check failed: {e}",
                response_time_ms=round(elapsed, 2),
            ))

        # 10. Currency check
        start = time.time()
        try:
            default_ccy = config.default_currency
            base_ccy = config.base_currency
            supported = config.supported_currencies or []
            ccy_warnings = []
            if default_ccy:
                dccy_str = default_ccy.value if hasattr(default_ccy, 'value') else str(default_ccy)
                if dccy_str not in VALID_CURRENCY_CODES:
                    ccy_warnings.append(f"Invalid default currency: {dccy_str}")
            if base_ccy:
                bccy_str = base_ccy.value if hasattr(base_ccy, 'value') else str(base_ccy)
                if bccy_str not in VALID_CURRENCY_CODES:
                    ccy_warnings.append(f"Invalid base currency: {bccy_str}")
            ccy_status = "healthy" if not ccy_warnings else "degraded"
            elapsed = (time.time() - start) * 1000
            components.append(SystemDiagnosticComponent(
                name="currency_configuration", status=ccy_status,
                message=f"{len(supported)} supported currency/currencies, {len(ccy_warnings)} issue(s)" if ccy_warnings
                        else f"{len(supported)} supported currency/currencies, all valid",
                details={"default_currency": str(default_ccy) if default_ccy else None,
                         "base_currency": str(base_ccy) if base_ccy else None,
                         "supported_count": len(supported)},
                response_time_ms=round(elapsed, 2),
            ))
        except Exception as e:
            elapsed = (time.time() - start) * 1000
            components.append(SystemDiagnosticComponent(
                name="currency_configuration", status="down",
                message=f"Currency check failed: {e}",
                response_time_ms=round(elapsed, 2),
            ))

        # Overall status
        overall = (
            "healthy" if all(c.status == "healthy" for c in components)
            else "down" if any(c.status == "down" for c in components)
            else "degraded"
        )
        readiness_comp = next(
            (c for c in components if c.name == "configuration_readiness"), None
        )
        score = 0
        if readiness_comp:
            m = re.search(r"(\d+)/100", readiness_comp.message)
            if m:
                score = int(m.group(1))

        return BillingHealthCheckResponse(
            overall_status=overall, readiness_score=score,
            components=components, checked_at=checks_at,
        )

    # ── Validation Diagnostics ───────────────────────────────────────────────

    def get_validation_diagnostics(self, organization_id: int) -> BillingConfigurationValidationDiagnostics:
        config = self.repo.get_by_organization(organization_id)

        def _field_status(fields: List[str], name: str) -> SystemDiagnosticComponent:
            missing = [f for f in fields if not getattr(config, f, None)]
            status = "healthy" if not missing else "degraded"
            msg = f"{name} is complete" if not missing else f"Missing: {', '.join(missing)}"
            return SystemDiagnosticComponent(
                name=name.lower().replace(" ", "_"), status=status, message=msg,
                details={"field_count": len(fields), "filled": len(fields) - len(missing)}
                if not missing else {"missing": missing},
            )

        return BillingConfigurationValidationDiagnostics(
            company_profile=_field_status(
                ["company_name", "billing_email", "country", "address_line1", "city"],
                "Company Profile",
            ),
            registration=_field_status(
                ["gst_number", "pan_number", "vat_number",
                 "business_registration_number", "tin_number"],
                "Registration",
            ),
            currency=_field_status(
                ["default_currency", "home_currency", "base_currency", "timezone", "language"],
                "Currency",
            ),
            invoicing=_field_status(
                ["invoice_prefix", "quote_prefix", "default_due_days",
                 "fiscal_year_start", "fiscal_year_end"],
                "Invoicing",
            ),
            tax_config=_field_status(
                ["tax_calculation_method", "tax_label", "tax_rounding_method"],
                "Tax Configuration",
            ),
            payment=_field_status(
                ["default_payment_terms", "rounding_method", "rounding_precision"],
                "Payment",
            ),
            exchange_rate=_field_status(
                ["exchange_rate_provider", "exchange_rate_base_currency"],
                "Exchange Rate",
            ),
            numbering=_field_status(
                ["invoice_prefix", "quote_prefix", "credit_note_prefix", "refund_prefix", "write_off_prefix"],
                "Numbering",
            ),
        )
