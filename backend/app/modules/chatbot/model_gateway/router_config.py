"""
model_gateway/router_config.py
-------------------------------
Task-class to model routing configuration for Groq and Anthropic.

Each task class maps to a model configuration that can be changed
without code modifications.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ModelConfig:
    model: str
    max_tokens: int
    temperature: float
    response_format: dict | None = None


# Groq task-class routing — models verified live against Groq API
# Fast tasks use the lightweight model; quality tasks use mid-tier.
GROQ_TASK_MODEL_ROUTING: dict[str, ModelConfig] = {
    "intent_classification": ModelConfig(
        model="allam-2-7b",
        max_tokens=256,
        temperature=0.0,
    ),
    "answer_generation": ModelConfig(
        model="openai/gpt-oss-20b",
        max_tokens=1024,
        temperature=0.1,
    ),
    "drafting": ModelConfig(
        model="allam-2-7b",
        max_tokens=1024,
        temperature=0.0,
        response_format={"type": "json_object"},
    ),
    "explanation": ModelConfig(
        model="openai/gpt-oss-20b",
        max_tokens=1024,
        temperature=0.1,
    ),
    "summarization": ModelConfig(
        model="openai/gpt-oss-20b",
        max_tokens=1536,
        temperature=0.0,
    ),
    "policy_evaluation": ModelConfig(
        model="openai/gpt-oss-20b",
        max_tokens=1024,
        temperature=0.0,
    ),
    "retrieval_rerank": ModelConfig(
        model="openai/gpt-oss-20b",
        max_tokens=1024,
        temperature=0.0,
    ),
}

# Anthropic task-class routing
ANTHROPIC_TASK_MODEL_ROUTING: dict[str, ModelConfig] = {
    "intent_classification": ModelConfig(
        model="claude-3-5-sonnet-20241022",
        max_tokens=256,
        temperature=0.0,
    ),
    "answer_generation": ModelConfig(
        model="claude-3-5-sonnet-20241022",
        max_tokens=2048,
        temperature=0.1,
    ),
    "drafting": ModelConfig(
        model="claude-3-5-sonnet-20241022",
        max_tokens=2048,
        temperature=0.0,
    ),
    "explanation": ModelConfig(
        model="claude-3-5-sonnet-20241022",
        max_tokens=2048,
        temperature=0.1,
    ),
    "summarization": ModelConfig(
        model="claude-3-5-sonnet-20241022",
        max_tokens=2048,
        temperature=0.0,
    ),
    "policy_evaluation": ModelConfig(
        model="claude-3-5-sonnet-20241022",
        max_tokens=2048,
        temperature=0.0,
    ),
    "retrieval_rerank": ModelConfig(
        model="claude-3-5-sonnet-20241022",
        max_tokens=2048,
        temperature=0.0,
    ),
}

# Backward-compatible alias
TASK_MODEL_ROUTING = GROQ_TASK_MODEL_ROUTING

_PROVIDER_ROUTING: dict[str, dict[str, ModelConfig]] = {
    "groq": GROQ_TASK_MODEL_ROUTING,
    "anthropic": ANTHROPIC_TASK_MODEL_ROUTING,
}


def get_model_config(task_class: str, provider: str = "groq") -> ModelConfig:
    """Resolve model config for a task class and provider.

    Falls back to answer_generation config for unknown task classes.
    """
    routing = _PROVIDER_ROUTING.get(provider, GROQ_TASK_MODEL_ROUTING)
    return routing.get(task_class, routing["answer_generation"])
