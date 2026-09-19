"""
modules/notifications/service.py
------------------------------------
Single send entry point for the ZB-* email pipeline: dispatch_email().
Every new template goes through this function — never calls
email_service.send_approval_email directly. Pipeline order:

  1. resolve template metadata (raises on unknown id)
  2. active check (code registry AND DB kill-switch)
  3. suppression check (always) + marketing-consent check (T3/T4 only)
  4. required-variable validation
  5. idempotency reservation (dedupe_key unique constraint)
  6. tier-rule enforcement (no unsubscribe/promo leak into T0/T1/T2)
  7. render + background-or-inline send

Every step short of "reserve" logs a CommunicationLog row and returns
without sending — the only way to reach the queued/sent state is to pass
all gates in order.
"""

import logging
from dataclasses import dataclass
from typing import Optional

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.modules.notifications import consent_service, suppression_service
from app.modules.notifications.models import (
    CommunicationLog,
    CommunicationLogStatus,
    CommunicationSend,
    CommunicationSendStatus,
)
from app.modules.notifications.template_registry import (
    ControlRuleFlag,
    TemplateMeta,
    get_template_meta,
)
from app.modules.notifications.template_state_service import NotificationTemplateStateService

logger = logging.getLogger(__name__)

# Renderer registry: template_id -> callable(context) -> (subject, html_body).
# Extend with more `from app.modules.notifications.templates.zb_xxx import RENDERERS`
# entries as later template families are added — this module never needs
# to change shape to add one.
from app.modules.notifications.templates.zb_sec import RENDERERS as _ZB_SEC_RENDERERS

_RENDERERS = {}
_RENDERERS.update(_ZB_SEC_RENDERERS)


@dataclass
class SendDecision:
    allowed: bool
    reason: Optional[str] = None


_FORBIDDEN_KEYS_BY_FLAG = {
    ControlRuleFlag.NO_UNSUBSCRIBE_LINK: {"unsubscribe_url", "unsubscribe_label"},
    ControlRuleFlag.NO_PROMOTIONAL_CONTENT: {"promo_block_html", "promotional_banner_url"},
}


def enforce_tier_rules(meta: TemplateMeta, render_context: dict) -> None:
    """Runtime safety net alongside the T0 shell's structural omission of
    unsubscribe/promo markup (see shell_renderer.py). Raises if a caller
    passed a forbidden context key for this template's control-rule flags.
    """
    for flag, forbidden_keys in _FORBIDDEN_KEYS_BY_FLAG.items():
        if flag in meta.control_rule_flags:
            leaked = forbidden_keys & render_context.keys()
            if leaked:
                raise ValueError(
                    f"{meta.template_id} ({meta.tier.value}) may not render {sorted(leaked)}: "
                    f"violates {flag.value}"
                )


def validate_template_variables(meta: TemplateMeta, context: dict) -> None:
    missing = [v for v in meta.required_variables if context.get(v) is None]
    if missing:
        logger.error(
            "[notifications] template %s missing required variable(s): %s",
            meta.template_id, missing,
        )
        raise ValueError(f"Missing required variable(s) for {meta.template_id}: {missing}")


def check_send_allowed(
    db: Session, recipient_email: str, organization_id: Optional[int], meta: TemplateMeta
) -> SendDecision:
    blocking = suppression_service.is_suppressed(db, recipient_email, organization_id)
    if blocking is not None:
        return SendDecision(False, f"suppressed:{blocking.reason.value}")

    if ControlRuleFlag.REQUIRES_MARKETING_CONSENT in meta.control_rule_flags:
        consent = consent_service.get_consent_state(db, recipient_email, organization_id)
        if consent is None or not consent.granted:
            return SendDecision(False, "no_marketing_consent")

    return SendDecision(True)


def reserve_send(
    db: Session,
    *,
    dedupe_key: str,
    event_name: str,
    entity_type: str,
    entity_id: Optional[int],
    template_id: str,
    organization_id: Optional[int],
    recipient_email: str,
):
    """Stripe-webhook-ledger idiom: check-then-insert, IntegrityError-race-
    caught. Returns (row, should_proceed)."""
    existing = (
        db.query(CommunicationSend)
        .filter(CommunicationSend.dedupe_key == dedupe_key)
        .first()
    )
    if existing is not None:
        if existing.status == CommunicationSendStatus.FAILED:
            existing.status = CommunicationSendStatus.PENDING
            db.flush()
            return existing, True
        return existing, False

    row = CommunicationSend(
        dedupe_key=dedupe_key,
        event_name=event_name,
        entity_type=entity_type,
        entity_id=entity_id,
        template_id=template_id,
        organization_id=organization_id,
        recipient_email=recipient_email,
        status=CommunicationSendStatus.PENDING,
    )
    db.add(row)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        existing = (
            db.query(CommunicationSend)
            .filter(CommunicationSend.dedupe_key == dedupe_key)
            .first()
        )
        return existing, False
    return row, True


def render_notification(meta: TemplateMeta, context: dict):
    renderer = _RENDERERS.get(meta.template_id)
    if renderer is None:
        raise KeyError(f"No renderer registered for {meta.template_id}")
    return renderer(context)


def _log(
    db: Session,
    meta: TemplateMeta,
    event_name: str,
    organization_id: Optional[int],
    recipient_email: str,
    status: CommunicationLogStatus,
    correlation_id: Optional[str],
    *,
    reason: Optional[str] = None,
    communication_send_id: Optional[int] = None,
) -> None:
    db.add(
        CommunicationLog(
            template_id=meta.template_id,
            event_name=event_name,
            organization_id=organization_id,
            recipient_email=recipient_email,
            status=status,
            reason=reason,
            correlation_id=correlation_id,
            communication_send_id=communication_send_id,
        )
    )


def dispatch_email(
    *,
    template_id: str,
    recipient_email: str,
    context: dict,
    event_name: str,
    entity_type: str,
    entity_id: Optional[int] = None,
    organization_id: Optional[int] = None,
    db: Session,
    background_tasks=None,
    correlation_id: Optional[str] = None,
    idempotency_key: Optional[str] = None,
) -> None:
    meta = get_template_meta(template_id)  # raises KeyError on unknown id

    if not meta.active or not NotificationTemplateStateService(db).is_enabled(template_id):
        _log(
            db, meta, event_name, organization_id, recipient_email,
            CommunicationLogStatus.SKIPPED_INACTIVE, correlation_id,
            reason="template not active",
        )
        db.commit()
        return

    decision = check_send_allowed(db, recipient_email, organization_id, meta)
    if not decision.allowed:
        _log(
            db, meta, event_name, organization_id, recipient_email,
            CommunicationLogStatus.SUPPRESSED, correlation_id,
            reason=decision.reason,
        )
        db.commit()
        return

    validate_template_variables(meta, context)  # raises loudly on missing variable

    dedupe_key = idempotency_key or f"{event_name}:{entity_type}:{entity_id}:{template_id}"
    send_row, proceed = reserve_send(
        db,
        dedupe_key=dedupe_key,
        event_name=event_name,
        entity_type=entity_type,
        entity_id=entity_id,
        template_id=template_id,
        organization_id=organization_id,
        recipient_email=recipient_email,
    )
    db.commit()
    if not proceed:
        return  # already sent (or in flight) elsewhere — true no-op

    render_context = dict(context)
    enforce_tier_rules(meta, render_context)

    args = (
        send_row.id, template_id, recipient_email, render_context,
        organization_id, event_name, correlation_id,
    )
    if background_tasks is not None:
        background_tasks.add_task(_execute_send, *args)
    else:
        _execute_send(*args)


def _execute_send(
    send_row_id: int,
    template_id: str,
    recipient_email: str,
    render_context: dict,
    organization_id: Optional[int],
    event_name: str,
    correlation_id: Optional[str],
) -> None:
    """Runs the blocking SMTP call. Opens its OWN db session — a request-
    scoped session is long closed by the time BackgroundTasks runs (same
    idiom as auth/service.py's _send_registration_emails)."""
    from app.database import SessionLocal
    from app.services.email_service import send_approval_email

    db = SessionLocal()
    try:
        meta = get_template_meta(template_id)
        subject, html_body = render_notification(meta, render_context)
        ok = send_approval_email(
            recipient_email,
            template_name=None,
            context={"subject": subject, **render_context},
            db=db,
            organization_id=organization_id,
            template_body=html_body,
        )

        send_row = db.query(CommunicationSend).get(send_row_id)
        if send_row is not None:
            send_row.status = (
                CommunicationSendStatus.SENT if ok else CommunicationSendStatus.FAILED
            )

        _log(
            db, meta, event_name, organization_id, recipient_email,
            CommunicationLogStatus.SENT if ok else CommunicationLogStatus.FAILED,
            correlation_id,
            reason=None if ok else "SMTP send returned False",
            communication_send_id=send_row_id,
        )
        db.commit()
    except Exception:
        db.rollback()
        logger.exception(
            "[notifications] send failed template=%s recipient=%s",
            template_id, recipient_email,
        )
    finally:
        db.close()
