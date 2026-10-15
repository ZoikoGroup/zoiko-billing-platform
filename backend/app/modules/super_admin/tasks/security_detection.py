"""
modules/super_admin/tasks/security_detection.py
------------------------------------------------
ZB-SEC-PRIV-001 (AUD-03, GOV-08) — Security and anomaly detection scheduled task.

Periodically evaluates six detection rules:
1. Repeated denials: >N PLATFORM_ACCESS_DENIED events from the same actor in window
2. Off-hours access: Privileged access activity outside configured UTC hours
3. Many-tenants in short window: Same operator accessing >N different tenants in 10 minutes
4. Heavy viewing: >N data-read events from one actor in an hour
5. Audit chain integrity: Tamper-evident hash chain verification
6. Dormant account activity: Activity from accounts with no prior login in N days

Triggers Attention Items via AttentionService.report_or_update on any detection.
"""

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.config import settings
from app.database import SessionLocal
from app.modules.auth.models import User
from app.modules.super_admin.attention_service import AttentionService
from app.modules.super_admin.audit_service import PlatformAuditService
from app.modules.super_admin.models import (
    AttentionSeverity,
    PlatformAuditAction,
    PlatformAuditLog,
    PrivilegedAccessStatus,
    PrivilegedTenantAccessGrant,
)

logger = logging.getLogger("zoiko_billing.super_admin.detection")


def run_security_detection_job(db: Optional[Session] = None) -> dict:
    """Entry point for the security detection scheduled job."""
    managed_session = False
    if db is None:
        db = SessionLocal()
        managed_session = True

    results = {
        "repeated_denials": 0,
        "off_hours": 0,
        "many_tenants": 0,
        "heavy_viewing": 0,
        "audit_chain_broken": False,
        "dormant_activity": 0,
    }

    try:
        attention = AttentionService(db)
        now = datetime.utcnow()

        # ── 1. Repeated access denials ─────────────────────────────────────────
        denial_threshold = getattr(settings, "DETECTION_REPEATED_DENIALS_THRESHOLD", 5) or 5
        denial_window_mins = getattr(settings, "DETECTION_REPEATED_DENIALS_WINDOW_MINUTES", 10) or 10
        denial_window = now - timedelta(minutes=denial_window_mins)

        denials = (
            db.query(PlatformAuditLog.actor_id, func.count(PlatformAuditLog.id).label("cnt"))
            .filter(
                PlatformAuditLog.action == PlatformAuditAction.PLATFORM_ACCESS_DENIED,
                PlatformAuditLog.created_at >= denial_window,
                PlatformAuditLog.actor_id.isnot(None),
            )
            .group_by(PlatformAuditLog.actor_id)
            .having(func.count(PlatformAuditLog.id) >= denial_threshold)
            .all()
        )

        for actor_id, count in denials:
            results["repeated_denials"] += 1
            attention.report_or_update(
                source="security_detection",
                source_key=f"sec:repeated_denials:{actor_id}",
                title=f"Repeated access denials detected for operator #{actor_id}",
                description=f"Operator #{actor_id} generated {count} access denials in the last {denial_window_mins} minutes (threshold: {denial_threshold}).",
                base_severity=AttentionSeverity.P1,
            )

        # ── 2. Off-hours privileged access ─────────────────────────────────────
        hours_cfg = getattr(settings, "PLATFORM_ACCESS_HOURS_UTC", "06-20") or "06-20"
        try:
            start_hour, end_hour = [int(h) for h in hours_cfg.split("-")]
        except Exception:
            start_hour, end_hour = 6, 20

        current_utc_hour = datetime.now(timezone.utc).hour
        is_off_hours = current_utc_hour < start_hour or current_utc_hour >= end_hour

        if is_off_hours:
            ten_mins_ago = now - timedelta(minutes=10)
            off_hour_grants = (
                db.query(PrivilegedTenantAccessGrant)
                .filter(
                    PrivilegedTenantAccessGrant.status == PrivilegedAccessStatus.ACTIVE,
                    PrivilegedTenantAccessGrant.activated_at >= ten_mins_ago,
                )
                .all()
            )
            for grant in off_hour_grants:
                results["off_hours"] += 1
                attention.report_or_update(
                    source="security_detection",
                    source_key=f"sec:off_hours_access:{grant.id}",
                    title=f"Off-hours privileged access grant #{grant.id}",
                    description=f"Operator #{grant.requested_by_user_id} accessed tenant #{grant.tenant_organization_id} at {now.isoformat()} UTC (allowed: {hours_cfg} UTC).",
                    base_severity=AttentionSeverity.P1,
                    organization_id=grant.tenant_organization_id,
                )

        # ── 3. Many tenants accessed in short window ───────────────────────────
        tenants_threshold = getattr(settings, "DETECTION_MANY_TENANTS_THRESHOLD", 3) or 3
        ten_mins_ago = now - timedelta(minutes=10)

        multi_tenant_operators = (
            db.query(
                PlatformAuditLog.actor_id,
                func.count(func.distinct(PlatformAuditLog.organization_id)).label("tenant_count"),
            )
            .filter(
                PlatformAuditLog.organization_id.isnot(None),
                PlatformAuditLog.created_at >= ten_mins_ago,
                PlatformAuditLog.actor_id.isnot(None),
            )
            .group_by(PlatformAuditLog.actor_id)
            .having(func.count(func.distinct(PlatformAuditLog.organization_id)) >= tenants_threshold)
            .all()
        )

        for actor_id, t_count in multi_tenant_operators:
            results["many_tenants"] += 1
            attention.report_or_update(
                source="security_detection",
                source_key=f"sec:many_tenants:{actor_id}",
                title=f"Operator #{actor_id} accessed {t_count} distinct tenants rapidly",
                description=f"Operator #{actor_id} touched {t_count} tenants in the last 10 minutes (threshold: {tenants_threshold}).",
                base_severity=AttentionSeverity.P1,
            )

        # ── 4. Heavy viewing / data-read anomaly ───────────────────────────────
        viewing_threshold = getattr(settings, "DETECTION_HEAVY_VIEWING_THRESHOLD", 30) or 30
        one_hour_ago = now - timedelta(hours=1)

        heavy_viewers = (
            db.query(PlatformAuditLog.actor_id, func.count(PlatformAuditLog.id).label("read_count"))
            .filter(
                PlatformAuditLog.created_at >= one_hour_ago,
                PlatformAuditLog.actor_id.isnot(None),
            )
            .group_by(PlatformAuditLog.actor_id)
            .having(func.count(PlatformAuditLog.id) >= viewing_threshold)
            .all()
        )

        for actor_id, read_cnt in heavy_viewers:
            results["heavy_viewing"] += 1
            attention.report_or_update(
                source="security_detection",
                source_key=f"sec:heavy_viewing:{actor_id}",
                title=f"Heavy activity volume detected for operator #{actor_id}",
                description=f"Operator #{actor_id} generated {read_cnt} audit operations in the last hour (threshold: {viewing_threshold}).",
                base_severity=AttentionSeverity.P2,
            )

        # ── 5. Tamper-evident audit chain verification ─────────────────────────
        broken_id = PlatformAuditService.verify_audit_chain(db)
        if broken_id:
            results["audit_chain_broken"] = True
            attention.report_or_update(
                source="audit_integrity",
                source_key=f"audit_chain_broken:{broken_id}",
                title="Tamper-evident audit log chain broken",
                description=f"Cryptographic hash chain verification failed starting at audit log #{broken_id}. Immediate review required.",
                base_severity=AttentionSeverity.P0,
            )

        # ── 6. Dormant account activity ────────────────────────────────────────
        dormant_days = getattr(settings, "DETECTION_DORMANT_DAYS_THRESHOLD", 60) or 60
        dormant_cutoff = now - timedelta(days=dormant_days)

        recent_audit_actors = (
            db.query(PlatformAuditLog.actor_id)
            .filter(
                PlatformAuditLog.created_at >= ten_mins_ago,
                PlatformAuditLog.actor_id.isnot(None),
            )
            .distinct()
            .all()
        )

        actor_ids = [r[0] for r in recent_audit_actors]
        if actor_ids:
            dormant_users = (
                db.query(User)
                .filter(
                    User.id.in_(actor_ids),
                    (User.last_login_at.is_(None)) | (User.last_login_at < dormant_cutoff),
                )
                .all()
            )
            for d_user in dormant_users:
                results["dormant_activity"] += 1
                attention.report_or_update(
                    source="security_detection",
                    source_key=f"sec:dormant_account:{d_user.id}",
                    title=f"Activity on dormant account {d_user.email}",
                    description=f"User #{d_user.id} ({d_user.email}) had audit activity but last logged in before {dormant_cutoff.isoformat()}.",
                    base_severity=AttentionSeverity.P1,
                )

        db.commit()
    except Exception as exc:
        db.rollback()
        logger.error("Security detection job failed: %s", exc, exc_info=True)
        raise
    finally:
        if managed_session:
            db.close()

    return results

