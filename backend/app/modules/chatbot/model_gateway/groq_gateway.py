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
        self._client: httpx.Client | None = None
        # Connection pool limits - reuse connections for better performance
        self._limits = httpx.Limits(max_keepalive_connections=5, max_connections=10)

    def _get_client(self) -> httpx.Client:
        if self._client is None or self._client.is_closed:
            self._client = httpx.Client(
                timeout=settings.AI_MODEL_TIMEOUT_SECONDS,
                transport=self._transport,
                limits=self._limits,
            )
        return self._client

    def _close_client(self) -> None:
        """Close the httpx client so the next request gets a fresh connection."""
        if self._client is not None and not self._client.is_closed:
            try:
                self._client.close()
            except Exception:
                pass
        self._client = None

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

        resolved_model, resolved_max_tokens, resolved_temperature, payload = self._build_request(
            messages=messages,
            system_prompt=system_prompt,
            tools=tools,
            model=model,
            max_tokens=max_tokens,
            temperature=temperature,
            response_format=response_format,
            stream=False,
        )

        headers = {
            "Authorization": f"Bearer {settings.GROQ_API_KEY}",
            "Content-Type": "application/json",
        }

        start_time = time.monotonic()
        last_error: Exception | None = None
        max_retries = 1
        for attempt in range(max_retries + 1):
            try:
                client = self._get_client()
                req_start = time.monotonic()
                resp = client.post(GROQ_CHAT_COMPLETIONS_URL, json=payload, headers=headers)
                req_latency = int((time.monotonic() - req_start) * 1000)
                last_error = None
                logger.info(
                    "Groq API request completed: attempt=%d status=%d latency=%dms model=%s",
                    attempt + 1, resp.status_code, req_latency, resolved_model,
                )
                break
            except httpx.TimeoutException:
                last_error = httpx.TimeoutException("timeout")
                # Close stale client so the next attempt gets a fresh connection
                self._close_client()
                if attempt < max_retries:
                    logger.warning("Groq API timeout on attempt %d, retrying...", attempt + 1)
                    time.sleep(0.5 * (attempt + 1))
                    continue
                latency_ms = int((time.monotonic() - start_time) * 1000)
                logger.error("Groq API timeout after %dms (%d attempts)", latency_ms, max_retries + 1)
                raise ModelGatewayError("Model provider timeout.", provider="groq", retryable=True)
            except httpx.HTTPError as e:
                last_error = e
                # Close stale client so the next attempt gets a fresh connection
                self._close_client()
                if attempt < max_retries:
                    logger.warning("Groq API connection error on attempt %d: %s", attempt + 1, type(e).__name__)
                    time.sleep(0.5 * (attempt + 1))
                    continue
                latency_ms = int((time.monotonic() - start_time) * 1000)
                logger.error("Groq API connection error: %s", type(e).__name__)
                raise ModelGatewayError(
                    f"Model provider error: {type(e).__name__}",
                    provider="groq",
                    retryable=True,
                )

        latency_ms = int((time.monotonic() - start_time) * 1000)

        # Retry on transient server errors (429, 5xx) even after a successful HTTP round-trip
        if resp.status_code in (429, 500, 502, 503, 504) and (resp.status_code != 429 or attempt < max_retries):
            if attempt < max_retries:
                retry_after = float(resp.headers.get("retry-after", "1"))
                logger.warning("Groq API status %d on attempt %d, retrying in %.1fs...", resp.status_code, attempt + 1, retry_after)
                time.sleep(min(retry_after, 3.0))
                try:
                    client = self._get_client()
                    resp = client.post(GROQ_CHAT_COMPLETIONS_URL, json=payload, headers=headers)
                    latency_ms = int((time.monotonic() - start_time) * 1000)
                except Exception:
                    pass  # fall through to error handling below

        if resp.status_code != 200:
            retryable = resp.status_code in (429, 500, 502, 503, 504)
            # Log model-specific errors clearly
            if resp.status_code in (400, 404):
                try:
                    error_detail = resp.json()
                except Exception:
                    error_detail = resp.text
                logger.error(
                    "Groq API model error status=%d model=%s detail=%s",
                    resp.status_code, resolved_model, error_detail,
                )
            logger.error(
                "Groq API error status=%d after %dms (retryable=%s)",
                resp.status_code, latency_ms, retryable,
            )
            # Close client on error so the next request gets a fresh connection
            self._close_client()
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
    def _build_request(
        *,
        messages: list[ModelMessage],
        system_prompt: str,
        tools: list[ModelTool] | None,
        model: str | None,
        max_tokens: int | None,
        temperature: float | None,
        response_format: dict | None,
        stream: bool,
    ) -> tuple[str, int, float, dict[str, Any]]:
        """Assemble the (model, max_tokens, temperature, payload) for a call.

        Shared by both :meth:`complete` (single response) and
        :meth:`complete_stream` (token streaming) so the two paths can never
        drift apart in prompt construction.
        """
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
        if stream:
            payload["stream"] = True
            payload["stream_options"] = {"include_usage": True}
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

        return resolved_model, resolved_max_tokens, resolved_temperature, payload

    def complete_stream(
        self,
        *,
        messages: list[ModelMessage],
        system_prompt: str = "",
        tools: list[ModelTool] | None = None,
        model: str | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
        response_format: dict | None = None,
    ):
        """Stream content deltas for a completion (SSE chat-completions API).

        Yields plain content fragments (str) as they become available.
        Raises ModelGatewayError for auth/transport/non-OK responses —
        the same failure semantics as :meth:`complete`, but without the
        multi-attempt retry loop (a single retry rides out transient HTTP
        errors; anything else surfaces immediately so the caller can fall
        back to the deterministic path).
        """
        if not settings.GROQ_API_KEY:
            raise ModelGatewayError(
                "GROQ_API_KEY is not configured.",
                provider="groq",
                retryable=False,
            )

        resolved_model, _, _, payload = self._build_request(
            messages=messages,
            system_prompt=system_prompt,
            tools=tools,
            model=model,
            max_tokens=max_tokens,
            temperature=temperature,
            response_format=response_format,
            stream=True,
        )

        headers = {
            "Authorization": f"Bearer {settings.GROQ_API_KEY}",
            "Content-Type": "application/json",
        }
        start_time = time.monotonic()
        client = self._get_client()
        try:
            with client.stream(
                "POST", GROQ_CHAT_COMPLETIONS_URL, json=payload, headers=headers
            ) as resp:
                if resp.status_code != 200:
                    self._close_client()
                    retryable = resp.status_code in (429, 500, 502, 503, 504)
                    logger.error(
                        "Groq stream error status=%d after %dms (retryable=%s)",
                        resp.status_code, int((time.monotonic() - start_time) * 1000), retryable,
                    )
                    raise ModelGatewayError(
                        f"Model provider HTTP {resp.status_code}",
                        provider="groq",
                        retryable=retryable,
                    )
                for line in resp.iter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    data = line[len("data:"):].strip()
                    if data == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    delta = (choices[0].get("delta") or {}).get("content")
                    if delta:
                        yield delta
        except ModelGatewayError:
            raise
        except httpx.TimeoutException:
            self._close_client()
            logger.error("Groq stream timeout after %dms", int((time.monotonic() - start_time) * 1000))
            raise ModelGatewayError("Model provider timeout.", provider="groq", retryable=True) from None
        except httpx.HTTPError as e:
            self._close_client()
            logger.error("Groq stream connection error: %s", type(e).__name__)
            raise ModelGatewayError(
                f"Model provider error: {type(e).__name__}",
                provider="groq",
                retryable=True,
            ) from None

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
