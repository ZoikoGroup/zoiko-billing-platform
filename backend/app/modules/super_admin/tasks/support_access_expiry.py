"""
modules/super_admin/tasks/support_access_expiry.py
--------------------------------------------------
Scheduled job (every minute): end support access sessions that have reached
their time limit and switch off their temporary tenant logins.

Expiry is already enforced on every request (users.access_expires_at is
checked at login, refresh and in get_current_user), so this sweep is not what
makes access stop. It makes the recorded state match reality without waiting
for someone to read the grant: the tenant's access log and the user list
show the session as ended and the account as inactive promptly.
"""

import logging

logger = logging.getLogger("zoiko_billing.super_admin.support_access_expiry")


def run_support_access_expiry_job() -> None:
    from app.database import SessionLocal
    from app.modules.super_admin.privileged_access_service import PrivilegedAccessService

    db = SessionLocal()
    try:
        ended = PrivilegedAccessService(db).expire_due_grants()
        if ended:
            logger.info("Ended %d expired support access session(s)", ended)
    except Exception:
        db.rollback()
        logger.exception("Support access expiry job failed")
        raise
    finally:
        db.close()
