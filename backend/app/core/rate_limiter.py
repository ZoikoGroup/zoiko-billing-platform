"""
core/rate_limiter.py
--------------------
Shared rate limiter instance for the entire application.
Avoids circular imports by centralizing the limiter.
"""

from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address, default_limits=["200/hour", "60/minute"])
