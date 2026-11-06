"""Live-daemon smoke tests for the Ollama backend.

Skipped by default. Enable with ``uv run pytest -m ollama``. Requires a
local Ollama daemon behind a TLS proxy, ``FREEHOLD_LLM_URL`` pointing at the
proxy, and ``FREEHOLD_LLM_MODEL`` naming a model tag that has already been
pulled (``ollama pull qwen3.6:27b``); ``FREEHOLD_LLM_CA_FILE`` trusts the
proxy's certificate.
"""

from __future__ import annotations

import os

import pytest

from freehold_agent.models.ollama import OllamaBackend

pytestmark = pytest.mark.ollama


@pytest.fixture
def _live_model() -> str:
    model = os.environ.get("FREEHOLD_LLM_MODEL")
    if not model or not os.environ.get("FREEHOLD_LLM_URL"):
        pytest.skip(
            "FREEHOLD_LLM_URL and FREEHOLD_LLM_MODEL not set — point them at a TLS proxy "
            "for Ollama and a pulled tag to run the smoke tests, e.g. phi4-mini:3.8b"
        )
    return model


def _backend(model: str) -> OllamaBackend:
    """A backend from FREEHOLD_LLM_URL and FREEHOLD_LLM_CA_FILE read here directly: the
    smoke tests exercise the backend alone, not AgentConfig."""
    return OllamaBackend(
        base_url=os.environ["FREEHOLD_LLM_URL"],
        model=model,
        ca_file=os.environ.get("FREEHOLD_LLM_CA_FILE"),
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
