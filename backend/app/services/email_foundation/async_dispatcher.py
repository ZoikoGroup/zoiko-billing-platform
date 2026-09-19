"""
email_foundation/async_dispatcher.py
------------------------------------
Async email dispatcher for the Zoiko Billing Email System.

Uses ThreadPoolExecutor to ensure slow or failing SMTP connections never block
user-facing API request threads.
"""

import logging
from concurrent.futures import ThreadPoolExecutor
from typing import Callable, Any

logger = logging.getLogger("zoiko_billing")

# Thread pool for non-blocking email dispatch
_email_executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="email_dispatch_worker")


def submit_email_task(func: Callable[..., Any], *args: Any, **kwargs: Any) -> None:
    """Submits an email send function to the background thread pool executor."""
    try:
        _email_executor.submit(_run_email_task_safely, func, *args, **kwargs)
    except Exception as exc:
        logger.error(f"[ASYNC_DISPATCHER] Failed to enqueue background email task: {exc}", exc_info=True)


def _run_email_task_safely(func: Callable[..., Any], *args: Any, **kwargs: Any) -> None:
    """Safely executes an email background task catching any unexpected exceptions."""
    try:
        func(*args, **kwargs)
    except Exception as exc:
        logger.error(f"[ASYNC_DISPATCHER] Background email worker error: {exc}", exc_info=True)


def shutdown_email_dispatcher() -> None:
    """Gracefully shuts down the background thread pool."""
    try:
        _email_executor.shutdown(wait=False)
    except Exception as exc:
        logger.warning(f"[ASYNC_DISPATCHER] Shutdown error: {exc}")
