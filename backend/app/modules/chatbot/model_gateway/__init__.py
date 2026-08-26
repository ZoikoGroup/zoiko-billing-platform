"""
model_gateway/__init__.py
-------------------------
Provider-neutral model gateway for the Zoiko Billing AI Assistant.
"""

from .base import ModelGateway, ModelResponse, ModelMessage, ModelTool
from .groq_gateway import GroqModelGateway
from .anthropic_gateway import AnthropicModelGateway
from .router_config import get_model_config, TASK_MODEL_ROUTING

__all__ = [
    "ModelGateway",
    "ModelResponse",
    "ModelMessage",
    "ModelTool",
    "GroqModelGateway",
    "AnthropicModelGateway",
    "get_model_config",
    "TASK_MODEL_ROUTING",
]
