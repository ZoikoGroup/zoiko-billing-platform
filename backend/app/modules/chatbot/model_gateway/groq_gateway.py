"""
model_gateway/groq_gateway.py
------------------------------
Groq implementation of the ModelGateway interface (OpenAI-compatible
chat-completions API, https://api.groq.com).

Uses httpx directly — no extra SDK dependency. Never exposes API keys or
raw prompts in logs; only status codes, exception types and latency.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any

import httpx

from app.config import settings

from .base import ModelGateway, ModelGatewayError, ModelMessage, ModelResponse, ModelTool, ModelToolCall

logger = logging.getLogger("zoiko_billing.ai.model_gateway")

GROQ_CHAT_COMPLETIONS_URL = "https://api.groq.com/openai/v1/chat/completions"


class GroqModelGateway(ModelGateway):
    """Groq LLM provider (llama-3.3-70b-versatile by default)."""

    provider_name = "groq"

    def __init__(self, transport: httpx.BaseTransport | None = None):
        # `transport` is an injection point for tests (httpx.MockTransport).
        self._transport = transport

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
        if not settings.GROQ_API_KEY:
            raise ModelGatewayError(
                "GROQ_API_KEY is not configured.",
                provider="groq",
                retryable=False,
            )

        resolved_model = model or settings.GROQ_MODEL_DEFAULT
        resolved_max_tokens = max_tokens or settings.GROQ_MAX_TOKENS
        resolved_temperature = temperature if temperature is not None else settings.GROQ_TEMPERATURE

        api_messages: list[dict[str, str]] = []
        if system_prompt:
            system_content = system_prompt
            if response_format and response_format.get("type") == "json_object":
                system_content += (
                    "\n\nYou MUST respond with valid JSON only. "
                    "No markdown, no explanation outside the JSON."
                )
            api_messages.append({"role": "system", "content": system_content})
        for msg in messages:
            if msg.role == "system" and system_prompt:
                continue  # explicit system_prompt wins; avoid duplicates
            api_messages.append({
                "role": msg.role if msg.role in ("user", "assistant", "system") else "user",
                "content": msg.content if isinstance(msg.content, str) else json.dumps(msg.content),
            })
        if not any(m["role"] == "user" for m in api_messages):
            api_messages.append({"role": "user", "content": "Hello"})

        payload: dict[str, Any] = {
            "model": resolved_model,
            "max_tokens": resolved_max_tokens,
            "temperature": resolved_temperature,
            "messages": api_messages,
        }
        if tools:
            payload["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.input_schema,
                    },
                }
                for t in tools
            ]
        if response_format and response_format.get("type") == "json_object":
            payload["response_format"] = {"type": "json_object"}

        headers = {
            "Authorization": f"Bearer {settings.GROQ_API_KEY}",
            "Content-Type": "application/json",
        }

        start_time = time.monotonic()
        try:
            with httpx.Client(
                timeout=settings.AI_MODEL_TIMEOUT_SECONDS,
                transport=self._transport,
            ) as client:
                resp = client.post(GROQ_CHAT_COMPLETIONS_URL, json=payload, headers=headers)
        except httpx.TimeoutException:
            latency_ms = int((time.monotonic() - start_time) * 1000)
            logger.error("Groq API timeout after %dms", latency_ms)
            raise ModelGatewayError("Model provider timeout.", provider="groq", retryable=True)
        except httpx.HTTPError as e:
            logger.error("Groq API connection error: %s", type(e).__name__)
            raise ModelGatewayError(
                f"Model provider error: {type(e).__name__}",
                provider="groq",
                retryable=True,
            )

        latency_ms = int((time.monotonic() - start_time) * 1000)

        if resp.status_code != 200:
            retryable = resp.status_code in (429, 500, 502, 503, 504)
            logger.error(
                "Groq API error status=%d after %dms (retryable=%s)",
                resp.status_code, latency_ms, retryable,
            )
            raise ModelGatewayError(
                f"Model provider HTTP {resp.status_code}",
                provider="groq",
                retryable=retryable,
            )

        try:
            data = resp.json()
            choice = data["choices"][0]
            message = choice.get("message") or {}
            content_text = message.get("content") or ""
            tool_calls = [
                ModelToolCall(
                    name=tc.get("function", {}).get("name", ""),
                    input=self._parse_tool_arguments(tc.get("function", {}).get("arguments")),
                    id=tc.get("id", ""),
                )
                for tc in (message.get("tool_calls") or [])
            ]
        except (KeyError, IndexError, ValueError) as e:
            raise ModelGatewayError(
                f"Unexpected Groq response shape: {type(e).__name__}",
                provider="groq",
                retryable=False,
            )

        raw_usage = data.get("usage") or {}
        usage = {
            "input_tokens": raw_usage.get("prompt_tokens", 0),
            "output_tokens": raw_usage.get("completion_tokens", 0),
            "latency_ms": latency_ms,
        }

        logger.info(
            "Model call completed: model=%s latency=%dms tokens=%s tool_calls=%d",
            resolved_model, latency_ms, usage, len(tool_calls),
        )

        return ModelResponse(
            content=content_text,
            tool_calls=tool_calls,
            stop_reason=choice.get("finish_reason") or "",
            model=data.get("model") or resolved_model,
            usage=usage,
            raw={"id": data.get("id", "")},
        )

    @staticmethod
    def _parse_tool_arguments(raw: Any) -> dict[str, Any]:
        if isinstance(raw, dict):
            return raw
        if isinstance(raw, str) and raw.strip():
            try:
                parsed = json.loads(raw)
                return parsed if isinstance(parsed, dict) else {}
            except json.JSONDecodeError:
                return {}
        return {}

    def health_check(self) -> bool:
        return bool(settings.GROQ_API_KEY)


def _is_retryable(exc: Exception) -> bool:
    exc_type = type(exc).__name__
    return exc_type in ("TimeoutException", "ConnectError", "ReadError")
