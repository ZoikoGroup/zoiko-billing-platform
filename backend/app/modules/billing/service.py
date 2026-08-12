"""
modules/billing/service.py
--------------------------
Legacy service module — delegates to app.modules.billing.services.
Kept for backward compatibility; new code should use the service layer directly.
"""

from app.modules.billing.services import *  # noqa: F401, F403
