"""
model_gateway/anthropic_gateway.py
-----------------------------------
Anthropic Claude implementation of the ModelGateway interface.

Uses the official anthropic SDK. Never exposes API keys or unrestricted
prompts in logs — only prompt_template id + hash are logged.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

from app.config import settings

from .base import ModelGateway, ModelGatewayError, ModelMessage, ModelResponse, ModelTool, ModelToolCall

logger = logging.getLogger("zoiko_billing.ai.model_gateway")


class AnthropicModelGateway(ModelGateway):
    """Anthropic Claude provider implementation."""

    def __init__(self):
        self._client = None

    def _get_client(self):
        if self._client is None:
            if not settings.ANTHROPIC_API_KEY:
                raise ModelGatewayError(
                    "ANTHROPIC_API_KEY is not configured.",
                    provider="anthropic",
                    retryable=False,
                )
            try:
                import anthropic
                self._client = anthropic.Anthropic(
                    api_key=settings.ANTHROPIC_API_KEY,
                    timeout=settings.AI_MODEL_TIMEOUT_SECONDS,
                )
            except ImportError:
                raise ModelGatewayError(
                    "anthropic package is not installed. Run: pip install anthropic",
                    provider="anthropic",
                    retryable=False,
                )
        return self._client

    def complete(
        self,
        *,
        messages: list[ModelMessage],
        system_prompt: str = "",
        tools: list[ModelTool] | None = None,
        model: str | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
        response_format: dict | None = None,
    ) -> ModelResponse:
        client = self._get_client()

        resolved_model = model or settings.ANTHROPIC_MODEL_DEFAULT
        resolved_max_tokens = max_tokens or settings.ANTHROPIC_MAX_TOKENS
        resolved_temperature = temperature if temperature is not None else settings.ANTHROPIC_TEMPERATURE

        # Convert messages to Anthropic format
        api_messages = []
        for msg in messages:
            if msg.role == "system":
                continue  # system messages go via system= param
            api_messages.append({
                "role": msg.role if msg.role in ("user", "assistant") else "user",
                "content": msg.content if isinstance(msg.content, str) else json.dumps(msg.content),
            })

        # Ensure conversation starts with user message
        if not api_messages or api_messages[0]["role"] != "user":
            api_messages.insert(0, {"role": "user", "content": "Hello"})

        # Build kwargs
        kwargs: dict[str, Any] = {
            "model": resolved_model,
            "max_tokens": resolved_max_tokens,
            "temperature": resolved_temperature,
            "messages": api_messages,
        }

        if system_prompt:
            kwargs["system"] = system_prompt

        if tools:
            kwargs["tools"] = [
                {
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.input_schema,
                }
                for t in tools
            ]

        # Structured output enforcement via response_format
        if response_format and response_format.get("type") == "json_object":
            if "system" in kwargs:
                kwargs["system"] += "\n\nYou MUST respond with valid JSON only. No markdown, no explanation outside the JSON."
            else:
                kwargs["system"] = "You MUST respond with valid JSON only. No markdown, no explanation outside the JSON."

        start_time = time.monotonic()
        try:
            response = client.messages.create(**kwargs)
        except Exception as e:
            latency_ms = int((time.monotonic() - start_time) * 1000)
            logger.error("Anthropic API error after %dms: %s", latency_ms, type(e).__name__)
            raise ModelGatewayError(
                f"Model provider error: {type(e).__name__}",
                provider="anthropic",
                retryable=_is_retryable(e),
            )

        latency_ms = int((time.monotonic() - start_time) * 1000)

        # Parse response
        content_text = ""
        tool_calls = []

        for block in response.content:
            if block.type == "text":
                content_text += block.text
            elif block.type == "tool_use":
                tool_calls.append(ModelToolCall(
                    name=block.name,
                    input=block.input if isinstance(block.input, dict) else {},
                    id=block.id,
                ))

        usage = {}
        if hasattr(response, "usage") and response.usage:
            usage = {
                "input_tokens": getattr(response.usage, "input_tokens", 0),
                "output_tokens": getattr(response.usage, "output_tokens", 0),
            }

        logger.info(
            "Model call completed: model=%s latency=%dms tokens=%s tool_calls=%d",
            resolved_model,
            latency_ms,
            usage,
            len(tool_calls),
        )

        return ModelResponse(
            content=content_text,
            tool_calls=tool_calls,
            stop_reason=response.stop_reason or "",
            model=response.model or resolved_model,
            usage=usage,
            raw={"id": response.id, "type": response.type} if hasattr(response, "id") else {},
        )

    def health_check(self) -> bool:
        try:
            self._get_client()
            return True
        except ModelGatewayError:
            return False


def _is_retryable(exc: Exception) -> bool:
    """Determine if an exception is transient and worth retrying."""
    exc_type = type(exc).__name__
    retryable_types = ("RateLimitError", "APIConnectionError", "APITimeoutError", "OverloadedError")
    return exc_type in retryable_types
