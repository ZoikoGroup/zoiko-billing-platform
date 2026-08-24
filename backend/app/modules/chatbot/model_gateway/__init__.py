"""
model_gateway/__init__.py
-------------------------
Provider-neutral model gateway for the Zoiko Billing AI Assistant.
"""

from .base import ModelGateway, ModelResponse, ModelMessage, ModelTool
from .anthropic_gateway import AnthropicModelGateway
from .groq_gateway import GroqModelGateway
from .router_config import get_model_config, TASK_MODEL_ROUTING, GROQ_TASK_MODEL_ROUTING

__all__ = [
    "ModelGateway",
    "ModelResponse",
    "ModelMessage",
    "ModelTool",
    "AnthropicModelGateway",
    "GroqModelGateway",
    "get_model_config",
    "TASK_MODEL_ROUTING",
    "GROQ_TASK_MODEL_ROUTING",
]
