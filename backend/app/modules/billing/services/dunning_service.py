import logging
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.core.exceptions import BadRequestException
from app.modules.billing.models import (
    BillingAuditAction,
    CommunicationEventStatus,
    CommunicationEventType,
    DunningActionType,
    DunningCase,
    DunningCaseStatusHistory,
    DunningLevel,
    DunningStatus,
    InvoiceStatus,
)
from app.modules.super_admin.kill_switch_service import (
    TENANT_BILLING_COMMUNICATIONS,
    BillingKillSwitchService,
)
from app.modules.billing.repositories.collection import (
    DunningCaseRepository,
    DunningCaseStatusHistoryRepository,
    DunningLevelRepository,
)
from app.modules.billing.repositories.promise_to_pay import PromiseToPayRepository
from app.modules.billing.repositories.settings import BillingConfigurationRepository
from app.modules.billing.utils.currency_utils import percentage_of
from app.modules.billing.utils.date_utils import days_overdue as compute_days_overdue
from app.modules.billing.repositories.invoice import InvoiceCommunicationRepository, InvoiceRepository
from app.modules.billing.services.audit_service import BillingAuditService
from app.modules.billing.services.base import safe_commit_and_refresh, filter_allowed
from app.modules.billing.services.customer_service import CustomerService
from app.modules.billing.services.settings_service import BillingConfigurationService
from app.services.email_service import send_dunning_reminder_email

logger = logging.getLogger("zoiko_billing")

LEVEL_ALLOWED_FIELDS = {
    "name", "description", "level_number", "min_days_overdue",
    "max_days_overdue", "fee_amount", "fee_percentage",
    "action_type", "action_template", "is_active",
}

CASE_OVERRIDE_FIELDS = {
    "total_overdue_amount", "days_overdue", "current_level",
    "status", "auto_escalate", "next_action_at", "notes",
}


class DunningService:
    def __init__(self, db: Session):
        self.db = db
        self.level_repo = DunningLevelRepository(db)
        self.case_repo = DunningCaseRepository(db)
        self.history_repo = DunningCaseStatusHistoryRepository(db)
        self.promise_repo = PromiseToPayRepository(db)
        self.invoice_repo = InvoiceRepository(db)
        self.comms_repo = InvoiceCommunicationRepository(db)
        self.config_repo = BillingConfigurationRepository(db)
        self.audit = BillingAuditService(db)
        self.customer_service = CustomerService(db)

    def _get_config(self, organization_id: int):
        """Best-effort access to the org's BillingConfiguration. All the
        dunning/collections automation honors config *defaults* when no
        row exists yet (auto_dunning off, wait days 3/30, level-based
        fees, no penalty/interest), so None is safe everywhere it's used."""
        return self.config_repo.get_by_organization(organization_id)

    def _org_currency(self, organization_id: int) -> str:
        """The org's real configured currency -- used only as a display
        fallback when an invoice's own `currency` is unexpectedly missing.
        Never a hardcoded "USD" literal: for an INR/EUR/AED organization
        that would silently mislabel the reminder email with the wrong
        currency."""
        return BillingConfigurationService(self.db).get_default_currency(organization_id)

    def _record_status_history(
        self, organization_id: int, case_id: int, from_status: Optional[str], to_status: str,
        changed_by: Optional[int] = None, reason: Optional[str] = None,
    ) -> DunningCaseStatusHistory:
        return self.history_repo.log_status_change(organization_id, case_id, from_status, to_status, changed_by, reason)

    # ── Dunning Levels (Configuration) ────────────────────────────────────

    def create_level(self, organization_id: int, created_by: int, **data: Any) -> DunningLevel:
        data = filter_allowed(data, LEVEL_ALLOWED_FIELDS)
        level = self.level_repo.create(organization_id, **data)
        self.audit.log(organization_id, created_by, BillingAuditAction.CREATE, "DunningLevel", level.id, new_values=data)
        return level

    def update_level(self, level_id: int, organization_id: int, updated_by: int, **data: Any) -> DunningLevel:
        data = filter_allowed(data, LEVEL_ALLOWED_FIELDS)
        self.level_repo.get_by_id(level_id, organization_id)
        updated = self.level_repo.update(level_id, organization_id, **data)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "DunningLevel", level_id)
        return updated

    def get_level(self, level_id: int, organization_id: int) -> DunningLevel:
        return self.level_repo.get_by_id(level_id, organization_id)

    def list_levels(self, organization_id: int) -> List[DunningLevel]:
        return self.level_repo.list_active(organization_id)

    def delete_level(self, level_id: int, organization_id: int, updated_by: int) -> None:
        self.level_repo.get_by_id(level_id, organization_id)
        self.level_repo.soft_delete(level_id, organization_id)
        self.audit.log(organization_id, updated_by, BillingAuditAction.DELETE, "DunningLevel", level_id)

    # ── Dunning Cases ─────────────────────────────────────────────────────

    def open_dunning_case(
        self, organization_id: int, customer_id: int,
        invoice_id: int, created_by: int, **overrides: Any,
    ) -> DunningCase:
        """`overrides` lets a caller (e.g. a richer future UI) supply an
        explicit total_overdue_amount/days_overdue/current_level/status/
        auto_escalate/next_action_at/notes; anything omitted is computed from
        the invoice exactly as before, so existing callers passing only
        customer_id/invoice_id see identical behavior."""
        overrides = filter_allowed(overrides, CASE_OVERRIDE_FIELDS)
        invoice = self.invoice_repo.get_by_id(invoice_id, organization_id)
        if invoice.status not in (InvoiceStatus.SENT, InvoiceStatus.OVERDUE, InvoiceStatus.PARTIALLY_PAID):
            raise BadRequestException("Invoice is not eligible for dunning")
        computed_days_overdue = compute_days_overdue(invoice.due_date)
        data = {
            "total_overdue_amount": overrides.get("total_overdue_amount", invoice.balance_due or 0),
            "days_overdue": overrides.get("days_overdue", computed_days_overdue),
            "current_level": overrides.get("current_level", 1),
            "status": overrides.get("status", DunningStatus.ACTIVE),
            "auto_escalate": overrides.get("auto_escalate", True),
            "next_action_at": overrides.get("next_action_at"),
            "notes": overrides.get("notes"),
        }
        case = self.case_repo.create(
            organization_id, customer_id=customer_id,
            invoice_id=invoice_id, created_by=created_by,
            **data,
        )
        self._record_status_history(organization_id, case.id, None, case.status.value, created_by)
        self.audit.log(organization_id, created_by, BillingAuditAction.CREATE, "DunningCase", case.id)
        return case

    def get_case(self, case_id: int, organization_id: int) -> DunningCase:
        return self.case_repo.get_by_id(case_id, organization_id)

    def list_cases(
        self, organization_id: int, page: int = 1, per_page: int = 20,
        search_term: Optional[str] = None, customer_id: Optional[int] = None,
        status: Optional[str] = None, sort_by: str = "created_at",
        sort_order: str = "desc",
    ) -> Dict[str, Any]:
        return self.case_repo.list_paginated(
            organization_id=organization_id, page=page, per_page=per_page,
            sort_by=sort_by, sort_order=sort_order,
            search_term=search_term, customer_id=customer_id, status=status,
        )

    def list_active_cases(self, organization_id: int) -> List[DunningCase]:
        return self.case_repo.list_active_cases(organization_id)

    # ── Escalation ────────────────────────────────────────────────────────

    def escalate_case(self, case_id: int, organization_id: int, updated_by: int) -> DunningCase:
        """Bumps the dunning *level* (Level 1 Friendly Reminder -> ... ->
        Level 5 Collections) — this is a reminder-intensity change, not a
        DunningStatus transition (the case remains ACTIVE), so it is not
        recorded in the status-history/timeline table; it's captured via the
        audit log and via last_action_at/current_level on the case itself.
        A case's DunningStatus only becomes ESCALATED when it is actually
        handed off to a CollectionsCase — see the escalation-to-collections
        automation task."""
        case = self.case_repo.get_by_id(case_id, organization_id)
        levels = self.level_repo.list_active(organization_id)
        if case.current_level >= len(levels):
            raise BadRequestException("Case is already at the highest dunning level")
        case.current_level += 1
        case.last_action_at = datetime.utcnow()
        safe_commit_and_refresh(self.db, case)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "DunningCase", case_id)
        return case

    def resolve_case(self, case_id: int, organization_id: int, resolution_note: Optional[str] = None, updated_by: int = None) -> DunningCase:
        case = self.case_repo.get_by_id(case_id, organization_id)
        old_status = case.status.value
        case.status = DunningStatus.RESOLVED
        case.resolved_at = datetime.utcnow()
        case.resolution_note = resolution_note
        safe_commit_and_refresh(self.db, case)
        self._record_status_history(organization_id, case_id, old_status, DunningStatus.RESOLVED.value, updated_by, resolution_note)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "DunningCase", case_id)
        return case

    def close_case(self, case_id: int, organization_id: int, updated_by: int) -> DunningCase:
        case = self.case_repo.get_by_id(case_id, organization_id)
        old_status = case.status.value
        case.status = DunningStatus.CLOSED
        safe_commit_and_refresh(self.db, case)
        self._record_status_history(organization_id, case_id, old_status, DunningStatus.CLOSED.value, updated_by)
        self.audit.log(organization_id, updated_by, BillingAuditAction.UPDATE, "DunningCase", case_id)
        return case

    # ── Late Fee ──────────────────────────────────────────────────────────

    def calculate_late_fee(self, case: DunningCase, settings: Optional[Dict] = None, days_overdue: Optional[int] = None) -> Dict[str, Decimal]:
        """Level fee + optional org-level penalty and interest.

        `settings` is a BillingConfiguration-like object or dict exposing
        penalty_settings/interest_settings; when omitted (or absent) only the
        level's own fee applies — the pre-existing behavior.

        penalty_settings: {"type": "percentage"|"flat", "value", "max_cap"}
            percentage is computed against total_overdue_amount; flat is a
            fixed amount; max_cap (when set) caps the penalty component.
        interest_settings: {"annual_rate", "compounding", "waive_first_x_days"}
            simple prorated daily interest on total_overdue_amount accrued
            after the waiver window (compounding other than "simple" is
            intentionally not supported — only simple is ever used).
        """
        level = self.level_repo.get_by_level(case.organization_id, case.current_level)
        if not level:
            return {"fee_amount": Decimal("0"), "fee_percentage": Decimal("0")}
        fee_flat = level.fee_amount or Decimal("0")
        fee_pct = level.fee_percentage or Decimal("0")
        pct_amount = percentage_of(case.total_overdue_amount, fee_pct)
        base_fee = fee_flat + pct_amount

        days = days_overdue if days_overdue is not None else (case.days_overdue or 0)

        penalty = Decimal("0")
        penalty_settings = (settings or {}).get("penalty_settings") or {}
        ptype = penalty_settings.get("type")
        pvalue = Decimal(str(penalty_settings.get("value") or 0))
        if ptype and pvalue:
            penalty = percentage_of(case.total_overdue_amount, pvalue) if ptype == "percentage" else pvalue
            max_cap = penalty_settings.get("max_cap")
            if max_cap is not None:
                penalty = min(penalty, Decimal(str(max_cap)))

        interest = Decimal("0")
        interest_settings = (settings or {}).get("interest_settings") or {}
        annual_rate = Decimal(str(interest_settings.get("annual_rate") or 0))
        waive = int(interest_settings.get("waive_first_x_days") or 0)
        if annual_rate and days > waive:
            interest = percentage_of(case.total_overdue_amount, annual_rate) * Decimal(max(days - waive, 0)) / Decimal("365")

        total_fee = base_fee + penalty + interest
        return {
            "fee_amount": fee_flat,
            "fee_percentage": fee_pct,
            "penalty": penalty,
            "interest": interest,
            "total_fee": total_fee,
        }

    # ── Reminder Schedule ─────────────────────────────────────────────────

    def get_reminder_schedule(self, organization_id: int) -> List[Dict[str, Any]]:
        levels = self.level_repo.list_active(organization_id)
        return [
            {
                "level": l.level_number,
                "name": l.name,
                "trigger_after_days": l.min_days_overdue,
                "action_type": l.action_type,
                "action_template": l.action_template,
                "fee_amount": float(l.fee_amount or 0),
                "fee_percentage": float(l.fee_percentage or 0),
            }
            for l in sorted(levels, key=lambda x: x.level_number)
        ]

    def _require_dunning_enabled(self) -> None:
        """ZB-SA-CMD-003 §9.2 — 'Suspend dunning/retries' circuit breaker.
        Gates the AUTOMATED dunning loop only (scheduler-driven case
        opening/progression/collection sends). Manual operator actions on an
        existing case are deliberately not gated by this scope."""
        from app.modules.super_admin.kill_switch_service import TENANT_DUNNING, BillingBlockedError

        try:
            BillingKillSwitchService(self.db).require_enabled(TENANT_DUNNING)
        except BillingBlockedError as exc:
            raise BadRequestException(str(exc))

    def process_dunning(self, organization_id: int) -> List[Dict[str, Any]]:
        """Process dunning for every overdue invoice in the org.

        Honors BillingConfiguration:
          - dunning_wait_days gates *opening* new cases (a case for an
            invoice overdue fewer than N days is never opened by the
            automation; existing cases keep being worked).
          - penalty_settings / interest_settings feed calculate_late_fee.
          - dunning_email_template is used as the reminder body when set.
          - final_notice_template + a "Final Notice" subject are used for the
            highest dunning level.
          - reminder_sms_enabled / reminder_whatsapp_enabled are recorded as
            channel flags in the communication metadata (only email delivery
            is implemented; the toggles decide whether a reminder is sent at
            all on those channels and are surfaced for observability).
        """
        self._require_dunning_enabled()
        overdue = self.invoice_repo.list_all(organization_id, status=InvoiceStatus.OVERDUE, active_only=True)
        levels = self.level_repo.list_active(organization_id)
        if not levels:
            return []
        config = self._get_config(organization_id)
        wait_days = getattr(config, "dunning_wait_days", 3) or 3
        settings = {
            "penalty_settings": getattr(config, "penalty_settings", None) or {},
            "interest_settings": getattr(config, "interest_settings", None) or {},
        }
        custom_template = getattr(config, "dunning_email_template", None)
        final_notice_template = getattr(config, "final_notice_template", None)
        sms_enabled = bool(getattr(config, "reminder_sms_enabled", False))
        whatsapp_enabled = bool(getattr(config, "reminder_whatsapp_enabled", False))
        highest_level = max((l.level_number for l in levels), default=1)

        results = []
        for inv in overdue:
            if not inv.due_date:
                continue
            days_overdue = compute_days_overdue(inv.due_date)
            case = self.case_repo.get_by_invoice_active(organization_id, inv.id)
            is_new_case = False
            if not case:
                if days_overdue < wait_days:
                    # Below the configured wait window: nothing to do yet.
                    continue
                case = self.open_dunning_case(organization_id, inv.customer_id, inv.id, None)
                is_new_case = True
            applicable_level = None
            for level in sorted(levels, key=lambda x: x.level_number):
                if level.min_days_overdue <= days_overdue and (level.max_days_overdue is None or days_overdue <= level.max_days_overdue):
                    applicable_level = level
                    break
            if applicable_level and (is_new_case or applicable_level.level_number > case.current_level):
                case.current_level = applicable_level.level_number
                case.days_overdue = days_overdue
                case.last_action_at = datetime.utcnow()
                case.last_action_type = applicable_level.action_type
                fee = self.calculate_late_fee(case, settings=settings, days_overdue=days_overdue)
                is_final_notice = applicable_level.level_number >= highest_level
                results.append({
                    "case_id": case.id,
                    "invoice_id": inv.id,
                    "invoice_number": inv.invoice_number,
                    "current_level": case.current_level,
                    "action_type": applicable_level.action_type,
                    "late_fee": float(fee["total_fee"]),
                    "days_overdue": days_overdue,
                    "final_notice": is_final_notice,
                })
                if applicable_level.action_type and "email" in applicable_level.action_type.lower():
                    email_sent_to = None
                    email_delivered = False
                    # ZB-SA-CMD-003 §9.2 — "Pause customer billing
                    # communications": the SEND is skipped while the breaker
                    # is engaged, but the case-state progression above is
                    # preserved ("while preserving generated artifacts").
                    comms_paused = not BillingKillSwitchService(self.db).is_enabled(
                        TENANT_BILLING_COMMUNICATIONS
                    )
                    if not comms_paused:
                        try:
                            customer = self.customer_service.get_customer(inv.customer_id, organization_id)
                            if customer and customer.email:
                                email_sent_to = customer.email
                                email_delivered = send_dunning_reminder_email(
                                    email=customer.email,
                                    customer_name=customer.display_name or customer.company_name,
                                    invoice_number=inv.invoice_number,
                                    days_overdue=str(days_overdue),
                                    overdue_amount=str(inv.balance_due or 0),
                                    currency=inv.currency or self._org_currency(organization_id),
                                    late_fee=str(fee["total_fee"]),
                                    organization_id=organization_id,
                                    db=self.db,
                                    custom_body=final_notice_template if is_final_notice else custom_template,
                                    subject_override=(
                                        f"Final Notice — Invoice {inv.invoice_number} | Zoiko Billing"
                                        if is_final_notice else None
                                    ),
                                )
                        except Exception as e:
                            logger.warning("Failed to send dunning email for invoice %d: %s", inv.id, e)
                    self.audit.log(
                        organization_id, None, BillingAuditAction.SEND, "DunningCase", case.id,
                        new_values={
                            "email_sent_to": email_sent_to,
                            "email_delivered": email_delivered,
                            **({"communications_paused_by_breaker": True} if comms_paused else {}),
                        },
                    )
                    comm_status = CommunicationEventStatus.DELIVERED if email_delivered else CommunicationEventStatus.FAILED
                    self.comms_repo.record_event_safe(
                        organization_id=organization_id,
                        invoice_id=inv.id,
                        event_type=CommunicationEventType.REMINDER_SENT,
                        status=comm_status,
                        recipient=email_sent_to,
                        subject=f"Dunning reminder - Invoice {inv.invoice_number} - Level {case.current_level}",
                        body_preview=f"Dunning level {case.current_level} reminder sent to {email_sent_to}" if email_sent_to else None,
                        event_metadata={
                            "case_id": case.id,
                            "level": case.current_level,
                            "days_overdue": days_overdue,
                            "late_fee": str(fee["total_fee"]),
                            "final_notice": is_final_notice,
                            "channels": {"email": True, "sms": sms_enabled, "whatsapp": whatsapp_enabled},
                            "email_delivered": email_delivered,
                        },
                    )
        if results:
            safe_commit_and_refresh(self.db)
        return results

    def process_due_reminders(self, organization_id: int) -> List[Dict[str, Any]]:
        """Pre-due reminders: emails SENT invoices whose due date falls within
        reminder_schedule.before_due (default [3, 1] days before due).

        Each invoice is reminded at most once per lead-time slot (dedup via
        existing reminder communication events), so the daily scheduler run
        can never re-email the same invoice for the same 'N days before due'
        window."""
        self._require_dunning_enabled()
        config = self._get_config(organization_id)
        schedule = getattr(config, "reminder_schedule", None) or {"before_due": [3, 1]}
        before_due = sorted({int(x) for x in (schedule.get("before_due") or [])}, reverse=True)
        if not before_due:
            return []

        today = date.today()
        results = []
        sent_invoices = self.invoice_repo.list_all(organization_id, status=InvoiceStatus.SENT, active_only=True)
        for inv in sent_invoices:
            if not inv.due_date:
                continue
            days_until = (inv.due_date - today).days
            if days_until <= 0 or days_until not in before_due:
                continue
            prior = self.comms_repo.list_by_invoice_safe(organization_id, inv.id)
            if any(
                c.event_type == CommunicationEventType.REMINDER_SENT
                and (c.event_metadata or {}).get("days_before_due") == days_until
                for c in prior
            ):
                continue

            email_sent_to = None
            email_delivered = False
            # ZB-SA-CMD-003 §9.2 — communications breaker pauses the SEND;
            # the dedup event below still records the attempt so the slot is
            # not silently re-fired after release (artifact preserved).
            comms_paused = not BillingKillSwitchService(self.db).is_enabled(
                TENANT_BILLING_COMMUNICATIONS
            )
            if not comms_paused:
                try:
                    customer = self.customer_service.get_customer(inv.customer_id, organization_id)
                    if customer and customer.email:
                        email_sent_to = customer.email
                        email_delivered = send_dunning_reminder_email(
                            email=customer.email,
                            customer_name=customer.display_name or customer.company_name,
                            invoice_number=inv.invoice_number,
                            days_overdue="0",
                            overdue_amount=str(inv.balance_due or 0),
                            currency=inv.currency or self._org_currency(organization_id),
                            late_fee="0",
                            organization_id=organization_id,
                            db=self.db,
                            custom_body=getattr(config, "dunning_email_template", None),
                            subject_override=f"Upcoming Payment Reminder — Invoice {inv.invoice_number} | Zoiko Billing",
                        )
                except Exception as e:
                    logger.warning("Failed to send pre-due reminder for invoice %d: %s", inv.id, e)

            comm_status = CommunicationEventStatus.DELIVERED if email_delivered else CommunicationEventStatus.FAILED
            self.comms_repo.record_event_safe(
                organization_id=organization_id,
                invoice_id=inv.id,
                event_type=CommunicationEventType.REMINDER_SENT,
                status=comm_status,
                recipient=email_sent_to,
                subject=f"Upcoming payment reminder - Invoice {inv.invoice_number}",
                body_preview=f"Pre-due reminder ({days_until}d before due) sent to {email_sent_to}" if email_sent_to else None,
                event_metadata={
                    "days_before_due": days_until,
                    "pre_due": True,
                    "email_delivered": email_delivered,
                    **({"communications_paused_by_breaker": True} if comms_paused else {}),
                },
            )
            results.append({
                "invoice_id": inv.id,
                "invoice_number": inv.invoice_number,
                "days_before_due": days_until,
                "email_sent_to": email_sent_to,
                "email_delivered": email_delivered,
            })

        if results:
            safe_commit_and_refresh(self.db)
        return results

    def send_reminder(self, case_id: int, organization_id: int, updated_by: int, channel: str = "email") -> DunningCase:
        """Manually send a reminder for a case's current level right now.

        Does not change the level or status — only dispatches the email and
        records the communication + audit trail (mirrors what process_dunning
        records for automated sends)."""
        case = self.case_repo.get_by_id(case_id, organization_id)
        invoice = self.invoice_repo.get_by_id(case.invoice_id, organization_id)
        fee = self.calculate_late_fee(case)
        config = self._get_config(organization_id)

        email_sent_to = None
        email_delivered = False
        # ZB-SA-CMD-003 §9.2 — "Pause customer billing communications" gates
        # ALL outbound customer billing emails, manual sends included.
        comms_paused = not BillingKillSwitchService(self.db).is_enabled(
            TENANT_BILLING_COMMUNICATIONS
        )
        if comms_paused:
            raise BadRequestException(
                "Customer billing communications are paused by a platform circuit "
                "breaker (tenant_billing_communications). The reminder was not sent; "
                "the dunning case and its artifacts are preserved."
            )
        try:
            customer = self.customer_service.get_customer(case.customer_id, organization_id)
            if customer and customer.email:
                email_sent_to = customer.email
                email_delivered = send_dunning_reminder_email(
                    email=customer.email,
                    customer_name=customer.display_name or customer.company_name,
                    invoice_number=invoice.invoice_number,
                    days_overdue=str(case.days_overdue or 0),
                    overdue_amount=str(invoice.balance_due or 0),
                    currency=invoice.currency or self._org_currency(organization_id),
                    late_fee=str(fee["total_fee"]),
                    organization_id=organization_id,
                    db=self.db,
                    custom_body=getattr(config, "dunning_email_template", None),
                )
        except Exception as e:
            logger.warning("Failed to send manual reminder for dunning case %d: %s", case.id, e)

        comm_status = CommunicationEventStatus.DELIVERED if email_delivered else CommunicationEventStatus.FAILED
        self.comms_repo.record_event_safe(
            organization_id=organization_id,
            invoice_id=case.invoice_id,
            event_type=CommunicationEventType.REMINDER_SENT,
            status=comm_status,
            recipient=email_sent_to,
            subject=f"Dunning reminder - Invoice {invoice.invoice_number} - Level {case.current_level}",
            body_preview=f"Manual level {case.current_level} reminder sent to {email_sent_to}" if email_sent_to else None,
            event_metadata={
                "case_id": case.id,
                "level": case.current_level,
                "channel": channel,
                "manual": True,
                "email_delivered": email_delivered,
            },
        )
        case.last_action_at = datetime.utcnow()
        case.last_action_type = DunningActionType.EMAIL_REMINDER
        safe_commit_and_refresh(self.db, case)
        self.audit.log(organization_id, updated_by, BillingAuditAction.SEND, "DunningCase", case_id)
        return case

    def preview_reminder(self, case_id: int, organization_id: int) -> Dict[str, Any]:
        """Preview what the next automated reminder would contain — level,
        subject, recipient and the fee that would apply — without sending."""
        case = self.case_repo.get_by_id(case_id, organization_id)
        invoice = self.invoice_repo.get_by_id(case.invoice_id, organization_id)
        level = self.level_repo.get_by_level(case.organization_id, case.current_level)
        config = self._get_config(organization_id)
        fee = self.calculate_late_fee(case)
        return {
            "case_id": case.id,
            "invoice_id": case.invoice_id,
            "invoice_number": invoice.invoice_number,
            "current_level": case.current_level,
            "level_name": level.name if level else None,
            "action_type": level.action_type.value if level and level.action_type else None,
            "days_overdue": case.days_overdue or 0,
            "overdue_amount": float(invoice.balance_due or 0),
            "currency": invoice.currency or self._org_currency(organization_id),
            "late_fee": float(fee["total_fee"]),
            "subject": f"Payment Reminder — Invoice {invoice.invoice_number} | Zoiko Billing",
            "channels": {
                "email": True,
                "sms": bool(getattr(config, "reminder_sms_enabled", False)),
                "whatsapp": bool(getattr(config, "reminder_whatsapp_enabled", False)),
            },
            "is_final_notice": case.current_level >= max(
                (l.level_number for l in self.level_repo.list_active(organization_id)), default=1
            ),
        }

    def list_communications(self, case_id: int, organization_id: int) -> List[Dict[str, Any]]:
        """All communications logged against the case's invoice — the source
        of the comms entries in the case timeline, exposed as its own
        read-only endpoint so the case detail UI can render them directly."""
        case = self.case_repo.get_by_id(case_id, organization_id)
        return [
            {
                "id": c.id,
                "invoice_id": c.invoice_id,
                "event_type": c.event_type.value if hasattr(c.event_type, "value") else str(c.event_type),
                "recipient": c.recipient,
                "subject": c.subject,
                "body_preview": c.body_preview,
                "status": c.status.value if hasattr(c.status, "value") else str(c.status),
                "event_metadata": c.event_metadata,
                "created_by": c.created_by,
                "created_at": c.created_at,
            }
            for c in self.comms_repo.list_by_invoice_safe(organization_id, case.invoice_id)
        ]

    # ── Escalation to Collections (automation) ──────────────────────────────

    def mark_escalated(self, case_id: int, organization_id: int, reason: Optional[str] = None) -> DunningCase:
        """Transitions a DunningCase to ESCALATED — the one DunningStatus
        transition `escalate_case` deliberately does NOT perform (that method
        only bumps the reminder level). This is called exclusively by the
        escalation-to-collections automation task once a case has actually
        been handed off to a CollectionsCase."""
        case = self.case_repo.get_by_id(case_id, organization_id)
        old_status = case.status.value
        case.status = DunningStatus.ESCALATED
        safe_commit_and_refresh(self.db, case)
        self._record_status_history(organization_id, case_id, old_status, DunningStatus.ESCALATED.value, None, reason)
        self.audit.log(organization_id, None, BillingAuditAction.UPDATE, "DunningCase", case_id, new_values={"status": "escalated"})
        return case

    # ── Status History / Timeline ────────────────────────────────────────────

    def list_status_history(self, case_id: int, organization_id: int) -> List[DunningCaseStatusHistory]:
        self.case_repo.get_by_id(case_id, organization_id)
        return self.history_repo.list_by_case(organization_id, case_id)

    def get_timeline(self, case_id: int, organization_id: int) -> List[Dict[str, Any]]:
        case = self.case_repo.get_by_id(case_id, organization_id)
        entries = []

        for sh in self.history_repo.list_by_case(organization_id, case_id):
            entries.append({
                "timestamp": sh.created_at,
                "event_type": "status_change",
                "title": f"Status changed to {sh.to_status}",
                "description": sh.reason,
                "actor_id": sh.changed_by,
                "metadata": {"from_status": sh.from_status, "to_status": sh.to_status, "status_history_id": sh.id},
            })

        for comm in self.comms_repo.list_by_invoice_safe(organization_id, case.invoice_id):
            entries.append({
                "timestamp": comm.created_at,
                "event_type": comm.event_type,
                "title": "Reminder emailed" if comm.event_type == CommunicationEventType.REMINDER_SENT else str(comm.event_type),
                "description": comm.subject or comm.body_preview,
                "actor_id": comm.created_by,
                "metadata": {"recipient": comm.recipient, "status": comm.status, "communication_id": comm.id, **(comm.event_metadata or {})},
            })

        for promise in self.promise_repo.list_by_dunning_case(organization_id, case_id):
            entries.append({
                "timestamp": promise.created_at,
                "event_type": "promise_to_pay_created",
                "title": f"Promise to pay {promise.promise_amount} by {promise.promise_date}",
                "description": promise.notes,
                "actor_id": promise.created_by,
                "metadata": {"promise_id": promise.id, "status": promise.status.value},
            })
            if promise.fulfilled_at:
                entries.append({
                    "timestamp": promise.fulfilled_at, "event_type": "promise_to_pay_fulfilled",
                    "title": "Promise to pay fulfilled", "description": None,
                    "actor_id": None, "metadata": {"promise_id": promise.id},
                })
            if promise.broken_at:
                entries.append({
                    "timestamp": promise.broken_at, "event_type": "promise_to_pay_broken",
                    "title": "Promise to pay broken", "description": None,
                    "actor_id": None, "metadata": {"promise_id": promise.id},
                })

        entries.sort(key=lambda e: e["timestamp"], reverse=True)
        return entries

    # ── Dashboard / Reporting ────────────────────────────────────────────────

    def get_dashboard_stats(self, organization_id: int) -> Dict[str, Any]:
        return self.case_repo.get_dashboard_stats(organization_id)

    def get_level_distribution(self, organization_id: int) -> List[Dict[str, Any]]:
        return self.case_repo.get_level_distribution(organization_id)
