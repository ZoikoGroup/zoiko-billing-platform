"""Source-hygiene guardrail: no dict literal in the chatbot runtime modules may
contain duplicate constant keys.

A duplicate key is silently resolved to the *last* value by Python, so a
leftover key can hide the very formatting/evidence regressions the guide's
money contract (§4.2) and evidence-store (§2) rules exist to catch. This is an
AST scan over the source files, so it needs no database or fixtures and runs
in CI as a static regression guard.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

_CHATBOT_SOURCE = [
    "app/modules/chatbot/conversation/engine.py",
    "app/modules/chatbot/actions/action_engine.py",
    "app/modules/chatbot/context/ai_context.py",
    "app/modules/chatbot/router.py",
    "app/modules/chatbot/billing_adapter.py",
    "app/modules/chatbot/guardrails/guardrails.py",
    "app/modules/chatbot/knowledge/retrieval.py",
    "app/modules/chatbot/model_gateway/base.py",
    "app/modules/chatbot/model_gateway/groq_gateway.py",
    "app/modules/chatbot/model_gateway/anthropic_gateway.py",
    "app/modules/chatbot/model_gateway/router_config.py",
    "app/modules/chatbot/audit/middleware.py",
]

_ROOT = Path(__file__).resolve().parents[2]


def _constant_dict_keys(node: ast.Dict):
    for key in node.keys:
        if key is None:
            continue
        if isinstance(key, ast.Constant) and isinstance(key.value, str):
            yield key.value


def _duplicate_keys_in(filepath: Path) -> list[tuple[int, str]]:
    tree = ast.parse(filepath.read_text(encoding="utf-8"), filename=str(filepath))
    problems: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Dict):
            continue
        seen: set[str] = set()
        for key in _constant_dict_keys(node):
            if key in seen:
                problems.append((node.lineno, key))
            seen.add(key)
    return problems


@pytest.mark.parametrize(
    "relative",
    [p for p in _CHATBOT_SOURCE if (_ROOT / p).exists()],
    ids=lambda p: p.split("/")[-1],
)
def test_no_duplicate_dict_keys_in_source(relative: str) -> None:
    problems = _duplicate_keys_in(_ROOT / relative)
    assert not problems, (
        f"{relative} contains dict literal(s) with duplicate keys at line(s) "
        + ", ".join(f"{line}:{key!r}" for line, key in problems)
        + " — a duplicate key silently keeps only the last value."
    )