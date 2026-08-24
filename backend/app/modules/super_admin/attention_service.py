"""
modules/super_admin/attention_service.py
-------------------------------------------
ZB-SA-CMD-003 §10/§11 — Attention Engine.

Real event ingestion only: this service is called from
core/scheduler.py:_tracked_job_runner (job failure/recovery) and
kill_switch_service.py (kill switch disabled/re-enabled). There is no demo
data generator and no manual "create a P0 for testing" endpoint wired to
anything but the actual event sources plus the operator lifecycle actions
(acknowledge/assign/transition/resolve/suppress) a human performs on a real
item.

Severity is computed here, server-side, from a small deterministic table —
never a hardcoded per-instance label chosen in the frontend. It is
intentionally simple relative to the spec's full "impact class + SLA age +
blast radius + harm + reversibility" model (§8.2): with only two real event
sources (job failure, kill-switch state), a fuller model would be inventing
inputs it doesn't have. This is documented as a deliberate simplification,
not silently passed off as the full model.

SLA clocks use wall-clock minutes (ZB-SA-CMD-003 Table 24 durations), not a
business-hours calendar — the P2/P3 "business hours/days" targets in that
table are approximated as elapsed wall-clock hours/days. A real
business-calendar engine (holidays, per-region hours) is out of scope here.
"""

import logging
import uuid
from datetime import datetime, timedelta
from typing import Optional

from sqlalchemy.orm import Session

from app.core.exceptions import BadRequestException, ForbiddenException, NotFoundException
from app.modules.auth.models import User
from app.modules.super_admin.audit_service import PlatformAuditService
from app.modules.super_admin.models import AttentionItem, AttentionSeverity, AttentionStatus, PlatformAuditAction

logger = logging.getLogger("zoiko_billing.super_admin.attention")

# Table 24 (ack target minutes) — used to compute sla_ack_deadline.
_ACK_TARGET_MINUTES = {
    AttentionSeverity.P0: 5,
    AttentionSeverity.P1: 15,
    AttentionSeverity.P2: 4 * 60,   # "4 business hours" approximated as 4h
    AttentionSeverity.P3: 24 * 60,  # "1 business day" approximated as 24h
}
_MITIGATE_TARGET_MINUTES = {
    AttentionSeverity.P0: 30,
    AttentionSeverity.P1: 4 * 60,
    AttentionSeverity.P2: 2 * 24 * 60,
    AttentionSeverity.P3: 5 * 24 * 60,
}

_OPEN_LIKE_STATUSES = (
    AttentionStatus.OPEN,
    AttentionStatus.ACKNOWLEDGED,
    AttentionStatus.ASSIGNED,
    AttentionStatus.MITIGATING,
    AttentionStatus.MONITORING,
)

_FORWARD_TRANSITIONS = {
    AttentionStatus.OPEN: {AttentionStatus.ACKNOWLEDGED, AttentionStatus.ASSIGNED, AttentionStatus.MITIGATING, AttentionStatus.SUPPRESSED},
    AttentionStatus.ACKNOWLEDGED: {AttentionStatus.ASSIGNED, AttentionStatus.MITIGATING, AttentionStatus.SUPPRESSED},
    AttentionStatus.ASSIGNED: {AttentionStatus.MITIGATING, AttentionStatus.MONITORING, AttentionStatus.SUPPRESSED},
    AttentionStatus.MITIGATING: {AttentionStatus.MONITORING, AttentionStatus.RESOLVED, AttentionStatus.SUPPRESSED},
    AttentionStatus.MONITORING: {AttentionStatus.RESOLVED, AttentionStatus.MITIGATING},
    AttentionStatus.RESOLVED: {AttentionStatus.CLOSED},
}


class AttentionService:
    def __init__(self, db: Session):
        self.db = db
        self.audit = PlatformAuditService(db)

    # ── Event ingestion (called by real sources only) ───────────────────

    def report_or_update(
        self,
        source: str,
        source_key: str,
        title: str,
        description: Optional[str] = None,
        base_severity: AttentionSeverity = AttentionSeverity.P2,
        escalate_after_occurrences: int = 3,
        organization_id: Optional[int] = None,
    ) -> AttentionItem:
        """Idempotent ingestion: same source_key while non-CLOSED updates the
        existing row (dedup + root-cause grouping); a RESOLVED row reopens
        (keeps its history); otherwise a new OPEN item is created."""
        existing = (
            self.db.query(AttentionItem)
            .filter(AttentionItem.source_key == source_key, AttentionItem.status != AttentionStatus.CLOSED)
            .order_by(AttentionItem.opened_at.desc())
            .first()
        )

        now = datetime.utcnow()

        if existing and existing.status in _OPEN_LIKE_STATUSES:
            existing.occurrence_count += 1
            existing.last_seen_at = now
            existing.description = description or existing.description
            if existing.occurrence_count >= escalate_after_occurrences and existing.severity != AttentionSeverity.P0:
                new_severity = self._escalate(existing.severity)
                if new_severity != existing.severity:
                    self.audit.log_no_commit(
                        actor_id=None, actor_role="system",
                        action=PlatformAuditAction.ATTENTION_ESCALATED,
                        entity_type="AttentionItem", entity_id=existing.id,
                        organization_id=existing.organization_id,
                        correlation_id=existing.correlation_id,
                        metadata={"from": existing.severity.value, "to": new_severity.value, "occurrence_count": existing.occurrence_count},
                    )
                    existing.severity = new_severity
                    self._set_sla_deadlines(existing)
            self.db.flush()
            return existing

        if existing and existing.status == AttentionStatus.RESOLVED:
            existing.status = AttentionStatus.OPEN
            existing.reopened_at = now
            existing.last_seen_at = now
            existing.occurrence_count += 1
            existing.resolved_at = None
            existing.resolution_code = None
            self._set_sla_deadlines(existing)
            self.audit.log_no_commit(
                actor_id=None, actor_role="system",
                action=PlatformAuditAction.ATTENTION_REOPENED,
                entity_type="AttentionItem", entity_id=existing.id,
                organization_id=existing.organization_id,
                correlation_id=existing.correlation_id,
            )
            self.db.flush()
            return existing

        item = AttentionItem(
            source=source,
            source_key=source_key,
            title=title,
            description=description,
            severity=base_severity,
            status=AttentionStatus.OPEN,
            organization_id=organization_id,
            occurrence_count=1,
            correlation_id=uuid.uuid4().hex,
            opened_at=now,
            last_seen_at=now,
        )
        self._set_sla_deadlines(item)
        self.db.add(item)
        self.db.flush()
        self.audit.log_no_commit(
            actor_id=None, actor_role="system",
            action=PlatformAuditAction.ATTENTION_OPENED,
            entity_type="AttentionItem", entity_id=item.id,
            organization_id=organization_id,
            correlation_id=item.correlation_id,
            metadata={"source": source, "source_key": source_key, "severity": base_severity.value},
        )
        self.db.flush()
        logger.warning("Attention item opened: source=%s key=%s severity=%s", source, source_key, base_severity.value)
        return item

    def auto_resolve(self, source: str, source_key: str, resolution_note: str = "Condition cleared automatically.") -> Optional[AttentionItem]:
        """Called when the underlying condition clears on its own (a
        previously-failing job now succeeds; a disabled kill switch is
        re-enabled). Only resolves items still in an open-like state —
        never overwrites a human's in-progress MITIGATING/MONITORING work
        without evidence, so this only auto-fires from OPEN/ACKNOWLEDGED."""
        item = (
            self.db.query(AttentionItem)
            .filter(
                AttentionItem.source_key == source_key,
                AttentionItem.status.in_([AttentionStatus.OPEN, AttentionStatus.ACKNOWLEDGED]),
            )
            .first()
        )
        if item is None:
            return None
        item.status = AttentionStatus.RESOLVED
        item.resolved_at = datetime.utcnow()
        item.resolution_code = "auto_cleared"
        item.description = resolution_note
        self.audit.log_no_commit(
            actor_id=None, actor_role="system",
            action=PlatformAuditAction.ATTENTION_RESOLVED,
            entity_type="AttentionItem", entity_id=item.id,
            organization_id=item.organization_id,
            correlation_id=item.correlation_id,
            metadata={"resolution_code": "auto_cleared"},
        )
        self.db.flush()
        return item

    def _escalate(self, severity: AttentionSeverity) -> AttentionSeverity:
        order = [AttentionSeverity.P3, AttentionSeverity.P2, AttentionSeverity.P1, AttentionSeverity.P0]
        idx = order.index(severity)
        return order[min(idx + 1, len(order) - 1)]

    def _set_sla_deadlines(self, item: AttentionItem) -> None:
        base = item.opened_at or datetime.utcnow()
        item.sla_ack_deadline = base + timedelta(minutes=_ACK_TARGET_MINUTES[item.severity])
        item.sla_mitigate_deadline = base + timedelta(minutes=_MITIGATE_TARGET_MINUTES[item.severity])

    # ── Operator lifecycle actions (audited, server-enforced) ───────────

    def _load(self, item_id: int) -> AttentionItem:
        item = self.db.query(AttentionItem).filter(AttentionItem.id == item_id).first()
        if item is None:
            raise NotFoundException("AttentionItem", "id")
        return item

    def acknowledge(self, actor: User, item_id: int) -> AttentionItem:
        item = self._load(item_id)
        if item.status not in (AttentionStatus.OPEN,):
            raise BadRequestException(f"Cannot acknowledge from status {item.status.value}.")
        item.status = AttentionStatus.ACKNOWLEDGED
        item.acknowledged_at = datetime.utcnow()
        self.db.flush()
        self.audit.log_no_commit(
            actor_id=actor.id, actor_role="super_admin",
            action=PlatformAuditAction.ATTENTION_ACKNOWLEDGED,
            entity_type="AttentionItem", entity_id=item.id,
            organization_id=item.organization_id, correlation_id=item.correlation_id,
        )
        self.db.flush()
        return item

    def assign(self, actor: User, item_id: int, owner_user_id: int) -> AttentionItem:
        item = self._load(item_id)
        if item.status not in _OPEN_LIKE_STATUSES:
            raise BadRequestException(f"Cannot assign an item in status {item.status.value}.")
        owner = self.db.query(User).filter(User.id == owner_user_id).first()
        if owner is None:
            raise NotFoundException("User", "id")
        item.owner_user_id = owner_user_id
        item.assigned_at = datetime.utcnow()
        if item.status in (AttentionStatus.OPEN, AttentionStatus.ACKNOWLEDGED):
            item.status = AttentionStatus.ASSIGNED
        self.db.flush()
        self.audit.log_no_commit(
            actor_id=actor.id, actor_role="super_admin",
            action=PlatformAuditAction.ATTENTION_ASSIGNED,
            entity_type="AttentionItem", entity_id=item.id,
            organization_id=item.organization_id, correlation_id=item.correlation_id,
            metadata={"owner_user_id": owner_user_id},
        )
        self.db.flush()
        return item

    def escalate(self, actor: User, item_id: int, reason: str) -> AttentionItem:
        """§6.4 explicit operator escalation: raises an open item one severity
        level (P3→P2→P1→P0), re-derives its SLA deadlines from the new
        severity, and writes an audited trail. Requires a non-empty reason;
        a P0 cannot escalate further."""
        item = self._load(item_id)
        if item.status not in _OPEN_LIKE_STATUSES:
            raise BadRequestException(f"Cannot escalate an item in status {item.status.value}.")
        if not reason or not reason.strip():
            raise BadRequestException("A reason is required to escalate an attention item.")
        new_severity = self._escalate(item.severity)
        if new_severity == item.severity:
            raise BadRequestException("Item is already at maximum severity (P0).")
        previous = item.severity
        item.severity = new_severity
        self._set_sla_deadlines(item)
        self.db.flush()
        self.audit.log_no_commit(
            actor_id=actor.id, actor_role="super_admin",
            action=PlatformAuditAction.ATTENTION_ESCALATED,
            entity_type="AttentionItem", entity_id=item.id,
            organization_id=item.organization_id, correlation_id=item.correlation_id,
            reason=reason.strip(),
            metadata={"from": previous.value, "to": new_severity.value},
        )
        self.db.flush()
        return item

    def transition(self, actor: User, item_id: int, to_status: AttentionStatus, resolution_code: Optional[str] = None) -> AttentionItem:
        item = self._load(item_id)
        allowed = _FORWARD_TRANSITIONS.get(item.status, set())
        if to_status not in allowed:
            raise BadRequestException(f"Cannot transition from {item.status.value} to {to_status.value}.")
        if to_status == AttentionStatus.RESOLVED and not resolution_code:
            raise BadRequestException("A resolution code is required to resolve an attention item.")

        now = datetime.utcnow()
        item.status = to_status
        if to_status == AttentionStatus.MITIGATING:
            item.mitigating_at = now
        elif to_status == AttentionStatus.MONITORING:
            item.monitoring_at = now
        elif to_status == AttentionStatus.RESOLVED:
            item.resolved_at = now
            item.resolution_code = resolution_code
        elif to_status == AttentionStatus.CLOSED:
            item.closed_at = now
        self.db.flush()

        action = PlatformAuditAction.ATTENTION_RESOLVED if to_status == AttentionStatus.RESOLVED else PlatformAuditAction.ATTENTION_TRANSITIONED
        self.audit.log_no_commit(
            actor_id=actor.id, actor_role="super_admin",
            action=action,
            entity_type="AttentionItem", entity_id=item.id,
            organization_id=item.organization_id, correlation_id=item.correlation_id,
            metadata={"to_status": to_status.value, "resolution_code": resolution_code},
        )
        self.db.flush()
        return item

    def suppress(self, actor: User, item_id: int, reason: str, minutes: int) -> AttentionItem:
        item = self._load(item_id)
        if item.status not in _OPEN_LIKE_STATUSES:
            raise BadRequestException(f"Cannot suppress an item in status {item.status.value}.")
        if not reason:
            raise BadRequestException("A reason is required to suppress an attention item.")
        if minutes <= 0:
            raise BadRequestException("Suppression must be time-bound (minutes must be > 0).")
        item.status = AttentionStatus.SUPPRESSED
        item.suppressed_until = datetime.utcnow() + timedelta(minutes=minutes)
        item.suppression_reason = reason
        self.db.flush()
        self.audit.log_no_commit(
            actor_id=actor.id, actor_role="super_admin",
            action=PlatformAuditAction.ATTENTION_SUPPRESSED,
            entity_type="AttentionItem", entity_id=item.id,
            organization_id=item.organization_id, correlation_id=item.correlation_id,
            reason=reason, metadata={"minutes": minutes},
        )
        self.db.flush()
        return item

    def _lift_expired_suppressions(self) -> None:
        now = datetime.utcnow()
        expired = (
            self.db.query(AttentionItem)
            .filter(AttentionItem.status == AttentionStatus.SUPPRESSED, AttentionItem.suppressed_until <= now)
            .all()
        )
        for item in expired:
            item.status = AttentionStatus.OPEN
            item.suppressed_until = None
        if expired:
            self.db.flush()

    # ── Queries ──────────────────────────────────────────────────────────

    def list_open(
        self,
        limit: int = 50,
        severity: Optional[AttentionSeverity] = None,
        status: Optional[AttentionStatus] = None,
    ) -> list[AttentionItem]:
        """Queue read. Default: all open-like items, severity-ranked. An
        explicit `severity` narrows the live queue; an explicit `status`
        switches to a history view of that exact status (e.g. RESOLVED,
        CLOSED) instead of the default open-like set."""
        self._lift_expired_suppressions()
        query = self.db.query(AttentionItem)
        if status is not None:
            query = query.filter(AttentionItem.status == status)
        else:
            query = query.filter(AttentionItem.status.in_(_OPEN_LIKE_STATUSES))
        if severity is not None:
            query = query.filter(AttentionItem.severity == severity)
        if status is not None:
            return query.order_by(AttentionItem.opened_at.desc()).limit(limit).all()

        severity_rank = {AttentionSeverity.P0: 0, AttentionSeverity.P1: 1, AttentionSeverity.P2: 2, AttentionSeverity.P3: 3}
        items = query.order_by(AttentionItem.opened_at.desc()).limit(500).all()
        items.sort(key=lambda i: (severity_rank.get(i.severity, 9), i.opened_at))
        return items[:limit]

    def get_counts(self) -> dict:
        self._lift_expired_suppressions()
        open_items = (
            self.db.query(AttentionItem)
            .filter(AttentionItem.status.in_(_OPEN_LIKE_STATUSES))
            .all()
        )
        now = datetime.utcnow()
        counts = {"p0": 0, "p1": 0, "p2": 0, "p3": 0}
        sla_breaches = 0
        for item in open_items:
            counts[item.severity.value] += 1
            if item.sla_ack_deadline and item.acknowledged_at is None and now > item.sla_ack_deadline:
                sla_breaches += 1
        return {**counts, "total_open": len(open_items), "sla_breaches": sla_breaches}
