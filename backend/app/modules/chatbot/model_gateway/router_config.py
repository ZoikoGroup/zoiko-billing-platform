"""
model_gateway/router_config.py
-------------------------------
Task-class to model routing configuration.

Routing decisions are policy, not hardcoded per action type.
Each task class maps to a model configuration that can be changed
without code modifications. Tables are per provider: every configured
provider must define a row for each supported task class.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ModelConfig:
    model: str
    max_tokens: int
    temperature: float
    response_format: dict | None = None


# Default task-class routing — policy-driven, not hardcoded per action.
# Override via environment or database config as needed.
TASK_MODEL_ROUTING: dict[str, ModelConfig] = {
    "intent_classification": ModelConfig(
        model="claude-haiku-4-20250414",
        max_tokens=256,
        temperature=0.0,
    ),
    "answer_generation": ModelConfig(
        model="claude-sonnet-4-20250514",
        max_tokens=4096,
        temperature=0.1,
    ),
    "drafting": ModelConfig(
        model="claude-sonnet-4-20250514",
        max_tokens=4096,
        temperature=0.0,
        response_format={"type": "json_object"},
    ),
    "explanation": ModelConfig(
        model="claude-sonnet-4-20250514",
        max_tokens=4096,
        temperature=0.1,
    ),
    "summarization": ModelConfig(
        model="claude-haiku-4-20250414",
        max_tokens=1024,
        temperature=0.0,
    ),
    "policy_evaluation": ModelConfig(
        model="claude-haiku-4-20250414",
        max_tokens=512,
        temperature=0.0,
    ),
    "retrieval_rerank": ModelConfig(
        model="claude-haiku-4-20250414",
        max_tokens=512,
        temperature=0.0,
    ),
}

# Groq routing (OpenAI-compatible; free tier). One fast general model covers
# all task classes — llama-3.3-70b is Groq's production-recommended workhorse.
GROQ_TASK_MODEL_ROUTING: dict[str, ModelConfig] = {
    "intent_classification": ModelConfig(
        model="llama-3.3-70b-versatile",
        max_tokens=256,
        temperature=0.0,
    ),
    "answer_generation": ModelConfig(
        model="llama-3.3-70b-versatile",
        max_tokens=4096,
        temperature=0.1,
    ),
    "drafting": ModelConfig(
        model="llama-3.3-70b-versatile",
        max_tokens=4096,
        temperature=0.0,
        response_format={"type": "json_object"},
    ),
    "explanation": ModelConfig(
        model="llama-3.3-70b-versatile",
        max_tokens=4096,
        temperature=0.1,
    ),
    "summarization": ModelConfig(
        model="llama-3.3-70b-versatile",
        max_tokens=1024,
        temperature=0.0,
    ),
    "policy_evaluation": ModelConfig(
        model="llama-3.3-70b-versatile",
        max_tokens=512,
        temperature=0.0,
    ),
    "retrieval_rerank": ModelConfig(
        model="llama-3.3-70b-versatile",
        max_tokens=512,
        temperature=0.0,
    ),
}

_PROVIDER_TABLES = {
    "anthropic": TASK_MODEL_ROUTING,
    "groq": GROQ_TASK_MODEL_ROUTING,
}


def get_model_config(task_class: str, provider: str = "anthropic") -> ModelConfig:
    """Resolve model config for a task class on the given provider.

    Falls back to that provider's answer_generation config for unknown task
    classes, and to the Anthropic table for unknown providers (the original
    default).
    """
    table = _PROVIDER_TABLES.get(provider, TASK_MODEL_ROUTING)
    return table.get(task_class, table["answer_generation"])
