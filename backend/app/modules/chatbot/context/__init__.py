"""
context/__init__.py
-------------------
Identity, tenancy & context resolution for the AI assistant.
"""

from .ai_context import AIContext, get_ai_context

__all__ = ["AIContext", "get_ai_context"]
