"""
core/rate_limiter.py
--------------------
Shared rate limiter instance for the entire application.
Avoids circular imports by centralizing the limiter.
"""

from functools import wraps
from typing import Any, Callable

from slowapi import Limiter
from starlette.requests import Request
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address, default_limits=["200/hour", "60/minute"])


def limit_route(limit_value: str) -> Callable:
    """Apply a route limit while keeping direct function tests usable.

    FastAPI always supplies a ``Request`` to HTTP calls. A few legacy tests
    intentionally call synchronous router functions directly, so those calls
    bypass the transport-level limiter rather than failing because they have
    no request object. The production HTTP path still delegates to SlowAPI's
    normal enforcement and response headers.
    """
    def decorator(func: Callable[..., Any]) -> Callable[..., Any]:
        limited = limiter.limit(limit_value)(func)

        @wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            request = kwargs.get("request")
            if not isinstance(request, Request):
                request = next((arg for arg in args if isinstance(arg, Request)), None)
            if request is None:
                return func(*args, **kwargs)
            return limited(*args, **kwargs)

        return wrapper

    return decorator
