"""
audit/__init__.py
----------------
Audit and observability for the AI assistant.
"""

from .middleware import audit_event, get_metrics

__all__ = ["audit_event", "get_metrics"]
