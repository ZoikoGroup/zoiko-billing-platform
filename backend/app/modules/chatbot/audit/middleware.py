"""
audit/middleware.py
------------------
Automatic audit event writing and observability metrics.

Every model_run, tool_invocation, policy_evaluation, and action_execution
automatically writes an audit_event via decorator/middleware — not something
each route has to remember to call.

Tracks:
  - Abstention rate
  - Action draft -> execute conversion
  - Approval rejection rate
  - Retrieval citation coverage
  - Model latency
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from functools import wraps
from typing import Any

from sqlalchemy.orm import Session

from ..context.ai_context import AIContext
from ..models import AIAuditEvent, AuditEventType

logger = logging.getLogger("zoiko_billing.ai.audit")


# ── Metrics collector (in-memory, for dashboards) ───────────────────────────

_metrics = {
    "total_requests": 0,
    "total_model_calls": 0,
    "total_tool_invocations": 0,
    "total_action_drafts": 0,
    "total_action_executions": 0,
    "total_abstentions": 0,
    "total_approvals_requested": 0,
    "total_approvals_rejected": 0,
    "total_retrieval_runs": 0,
    "total_citations": 0,
    "mode_counts": defaultdict(int),
    "risk_class_counts": defaultdict(int),
    "intent_domain_counts": defaultdict(int),
    "model_latencies": [],
    "action_conversions": {
        "draft": 0,
        "preview": 0,
        "confirm": 0,
        "execute": 0,
        "succeeded": 0,
    },
}


def track_metric(metric_name: str, value: Any = 1) -> None:
    """Increment a metric counter."""
    if metric_name in _metrics:
        if isinstance(_metrics[metric_name], int):
            _metrics[metric_name] += value
        elif isinstance(_metrics[metric_name], defaultdict):
            _metrics[metric_name][str(value)] += 1
        elif isinstance(_metrics[metric_name], list):
            _metrics[metric_name].append(value)


def get_metrics() -> dict:
    """Return current metrics snapshot."""
    metrics = dict(_metrics)
    # Compute derived metrics
    total = metrics["total_requests"] or 1
    metrics["abstention_rate"] = round(metrics["total_abstentions"] / total, 4)
    draft = metrics["action_conversions"]["draft"] or 1
    metrics["action_conversion_rate"] = round(
        metrics["action_conversions"]["succeeded"] / draft, 4
    )
    approvals = metrics["total_approvals_requested"] or 1
    metrics["approval_rejection_rate"] = round(
        metrics["total_approvals_rejected"] / approvals, 4
    )
    retrieval_runs = metrics["total_retrieval_runs"] or 1
    metrics["citation_coverage"] = round(
        metrics["total_citations"] / retrieval_runs, 2
    )
    if metrics["model_latencies"]:
        metrics["avg_model_latency_ms"] = round(
            sum(metrics["model_latencies"]) / len(metrics["model_latencies"]), 0
        )
    return metrics


# ── Audit decorator ──────────────────────────────────────────────────────────

def audit_event(
    event_type: AuditEventType,
    *,
    include_request: bool = False,
    include_response: bool = False,
):
    """Decorator that automatically writes an audit_event after a function completes.

    Usage:
        @audit_event(AuditEventType.MODEL_INVOKED, include_request=True)
        def call_model(self, ctx, ...):
            ...
    """
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            start = time.monotonic()
            result = None
            error = None

            try:
                result = func(*args, **kwargs)
                return result
            except Exception as e:
                error = e
                raise
            finally:
                elapsed_ms = int((time.monotonic() - start) * 1000)

                # Extract context from args
                ctx = _extract_context(args, kwargs)
                db = _extract_db(args, kwargs)

                if db and ctx:
                    payload: dict[str, Any] = {
                        "function": func.__qualname__,
                        "elapsed_ms": elapsed_ms,
                    }

                    if include_request:
                        payload["request_args"] = _safe_serialize(kwargs)

                    if include_response and result is not None:
                        payload["response_summary"] = _safe_serialize(result)[:500]

                    if error:
                        payload["error"] = str(error)[:200]

                    try:
                        event = AIAuditEvent(
                            event_uid=str(uuid.uuid4()),
                            tenant_context_id=ctx.tenant_context_id,
                            organization_id=ctx.organization_id,
                            user_id=ctx.user_id,
                            event_type=event_type,
                            event_payload=payload,
                            correlation_id=ctx.request_id,
                        )
                        db.add(event)
                        db.flush()
                    except Exception as audit_err:
                        logger.warning("Failed to write audit event: %s", audit_err)

                # Track metrics
                track_metric("total_requests")
                if event_type == AuditEventType.MODEL_INVOKED:
                    track_metric("total_model_calls")
                    track_metric("model_latencies", elapsed_ms)
                elif event_type == AuditEventType.TOOL_INVOKED:
                    track_metric("total_tool_invocations")
                elif event_type == AuditEventType.ACTION_DRAFTED:
                    track_metric("total_action_drafts")
                    track_metric("action_conversions", "draft")
                elif event_type == AuditEventType.ACTION_EXECUTED:
                    track_metric("total_action_executions")
                    track_metric("action_conversions", "execute")
                elif event_type == AuditEventType.ACTION_APPROVED:
                    track_metric("action_conversions", "confirm")
                elif event_type == AuditEventType.ACTION_REJECTED:
                    track_metric("total_approvals_rejected")

        return wrapper
    return decorator


def _extract_context(args, kwargs) -> AIContext | None:
    """Try to extract AIContext from function arguments."""
    for arg in args:
        if isinstance(arg, AIContext):
            return arg
    for value in kwargs.values():
        if isinstance(value, AIContext):
            return value
    return None


def _extract_db(args, kwargs) -> Session | None:
    """Try to extract SQLAlchemy Session from function arguments."""
    for arg in args:
        if isinstance(arg, Session):
            return arg
    return None


def _safe_serialize(obj: Any) -> str:
    """Safely serialize an object to JSON string for logging."""
    try:
        if isinstance(obj, dict):
            return json.dumps(obj, default=str)[:500]
        return str(obj)[:500]
    except Exception:
        return "<unserializable>"
