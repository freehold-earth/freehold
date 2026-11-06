"""Live-daemon smoke tests for the OpenAI-compatible backend.

Skipped by default. Enable with ``uv run pytest -m openai``. Requires a
running chat-completions server over TLS (llama-server, vLLM, SGLang, LM
Studio, …) and ``FREEHOLD_LLM_MODEL`` naming a model it exposes. Set
``FREEHOLD_LLM_URL``, ``FREEHOLD_LLM_API_KEY`` and ``FREEHOLD_CA_FILE`` if
the endpoint differs from the default, requires auth, or has its own
certificate.
"""

from __future__ import annotations

import os

import pytest

from freehold_agent.config import DEFAULT_LLM_URL
from freehold_agent.models.openai import OpenAICompatBackend

pytestmark = pytest.mark.openai


@pytest.fixture
def _live_model() -> str:
    model = os.environ.get("FREEHOLD_LLM_MODEL")
    if not model:
        pytest.skip(
            "FREEHOLD_LLM_MODEL not set — export a model the server exposes to "
            "run the integration smoke tests, e.g. FREEHOLD_LLM_MODEL=Qwen/Qwen3.6-27B"
        )
    return model


def _backend(model: str) -> OpenAICompatBackend:
    return OpenAICompatBackend(
        base_url=os.environ.get("FREEHOLD_LLM_URL", DEFAULT_LLM_URL),
        model=model,
        api_key=os.environ.get("FREEHOLD_LLM_API_KEY"),
        ca_file=os.environ.get("FREEHOLD_CA_FILE") or None,
    )


async def test_smoke_generate(_live_model: str) -> None:
    async with _backend(_live_model) as backend:
        response = await backend.generate("Reply with the single word: pong", max_tokens=8)
    assert response.text.strip() != ""


async def test_smoke_structured(_live_model: str) -> None:
    schema = {
        "type": "object",
        "properties": {"greeting": {"type": "string"}},
        "required": ["greeting"],
    }
    async with _backend(_live_model) as backend:
        result = await backend.generate_structured(
            "Return a friendly greeting as JSON matching the schema.",
            schema,
            max_tokens=64,
        )
    assert "greeting" in result.data
    assert isinstance(result.data["greeting"], str)
