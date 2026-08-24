"""
model_gateway/base.py
---------------------
Abstract ModelGateway interface and shared schemas.

No module outside model_gateway/ should call a provider SDK directly.
All model interactions go through ModelGateway.complete().
"""

from __future__ import annotations

import hashlib
import json
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass
class ModelMessage:
    role: str  # "user" | "assistant" | "system"
    content: str | list[dict[str, Any]]


@dataclass
class ModelTool:
    name: str
    description: str
    input_schema: dict[str, Any]


@dataclass
class ModelToolCall:
    name: str
    input: dict[str, Any]
    id: str = ""


@dataclass
class ModelResponse:
    content: str = ""
    tool_calls: list[ModelToolCall] = field(default_factory=list)
    stop_reason: str = ""
    model: str = ""
    usage: dict[str, int] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def text(self) -> str:
        return self.content

    @property
    def has_tool_calls(self) -> bool:
        return len(self.tool_calls) > 0

    def content_hash(self) -> str:
        return hashlib.sha256(self.content.encode()).hexdigest()[:16]


class ModelGateway(ABC):
    """Abstract interface for model providers.

    Every other module in the chatbot system calls this interface.
    No provider SDK is imported outside of concrete implementations.
    """

    #: Short provider identifier ("anthropic", "groq", …) used for audit
    #: records and health reporting.
    provider_name: str = "unknown"

    @abstractmethod
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
        """Send a completion request and return a structured response.

        Args:
            messages: Conversation history.
            system_prompt: System instruction (versioned, from prompt_template).
            tools: Allowed tool definitions for this call.
            model: Model override (default from config).
            max_tokens: Max output tokens (default from config).
            temperature: Sampling temperature (default from config).
            response_format: JSON schema enforcement for structured output.

        Returns:
            ModelResponse with content, optional tool_calls, and usage.

        Raises:
            ModelGatewayError: On provider errors, timeouts, or schema violations.
        """
        ...

    def health_check(self) -> bool:
        """Return True if the provider is reachable."""
        return True


class ModelGatewayError(Exception):
    """Raised when a model provider call fails."""

    def __init__(self, message: str, provider: str = "", retryable: bool = False):
        super().__init__(message)
        self.provider = provider
        self.retryable = retryable
