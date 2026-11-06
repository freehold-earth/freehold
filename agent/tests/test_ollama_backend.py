"""Tests for the Ollama HTTP backend.

Uses ``httpx2.MockTransport`` so no daemon is required. Live-daemon smoke
tests live in ``test_ollama_integration.py`` behind the ``ollama`` marker.
"""

from __future__ import annotations

import json
from collections.abc import Callable

import httpx2
import pytest

from freehold_agent.config import MODEL_TIERS, resolve_model_for_tier
from freehold_agent.models.backend import LLMResponse, StructuredResponse
from freehold_agent.models.ollama import (
    OllamaBackend,
    OllamaModelRefusalError,
    OllamaSchemaError,
    OllamaTimeoutError,
    OllamaTransportError,
)
from freehold_agent.models.spal_bridge import RequestContextError, propose_request_context
from freehold_agent.spal import IdentityType, ProofType

# --- helpers ---

# A TLS proxy in front of a local daemon, as the agent requires for Ollama.
OLLAMA = "https://127.0.0.1:11434"


def _mock_transport(
    handler: Callable[[httpx2.Request], httpx2.Response],
) -> httpx2.MockTransport:
    return httpx2.MockTransport(handler)


def _ok(body: dict) -> httpx2.Response:
    return httpx2.Response(200, json=body)


# --- tier resolution ---


class TestTierResolution:
    def test_default_tier_resolves_to_qwen(self) -> None:
        assert resolve_model_for_tier("default") == MODEL_TIERS["default"]
        assert MODEL_TIERS["default"].startswith("qwen3.6")

    def test_on_device_tier_is_not_exposed(self) -> None:
        """No on-device tier: mobile story lives in a separate client (ADR-006)."""
        assert "on-device" not in MODEL_TIERS
        with pytest.raises(ValueError, match="Unknown LLM tier"):
            resolve_model_for_tier("on-device")

    def test_small_tier_resolves_to_phi(self) -> None:
        assert "phi" in resolve_model_for_tier("small").lower()

    def test_unknown_tier_raises(self) -> None:
        with pytest.raises(ValueError, match="Unknown LLM tier"):
            resolve_model_for_tier("gigantic")

    def test_tier_picks_the_shared_model(self) -> None:
        assert OllamaBackend(base_url=OLLAMA, tier="small").model == MODEL_TIERS["small"]

    def test_explicit_model_overrides_tier(self) -> None:
        backend = OllamaBackend(base_url=OLLAMA, model="custom-model:latest", tier="small")
        assert backend.model == "custom-model:latest"

    def test_default_tier_without_a_model(self) -> None:
        backend = OllamaBackend(base_url=OLLAMA)
        assert backend.model == MODEL_TIERS["default"]
        assert backend.base_url == OLLAMA

    def test_plain_http_is_refused(self) -> None:
        with pytest.raises(ValueError, match="https://"):
            OllamaBackend(base_url="http://127.0.0.1:11434")

    async def test_bearer_token_reaches_the_proxy(self) -> None:
        seen: dict[str, str] = {}

        def handler(request: httpx2.Request) -> httpx2.Response:
            seen["auth"] = request.headers.get("authorization", "")
            return httpx2.Response(200, json={"response": "ok", "done": True})

        backend = OllamaBackend(
            base_url=OLLAMA,
            model="m",
            api_key="k1",  # pragma: allowlist secret
            transport=_mock_transport(handler),
        )
        await backend.generate("hi", max_tokens=4)
        await backend.aclose()
        assert seen["auth"] == "Bearer k1"


# --- generate() ---


class TestGenerate:
    async def test_happy_path(self) -> None:
        seen: dict[str, object] = {}

        def handler(request: httpx2.Request) -> httpx2.Response:
            assert request.url.path == "/api/generate"
            assert request.method == "POST"
            body = json.loads(request.content)
            seen.update(body)
            return _ok(
                {
                    "response": "hello world",
                    "done": True,
                    "done_reason": "stop",
                    "eval_count": 12,
                }
            )

        async with OllamaBackend(
            base_url=OLLAMA,
            model="test-model",
            transport=_mock_transport(handler),
        ) as backend:
            result = await backend.generate("Say hi")

        assert isinstance(result, LLMResponse)
        assert result.text == "hello world"
        assert result.tokens_used == 12
        assert result.finish_reason == "stop"
        # Sanity-check the payload we sent to Ollama.
        assert seen["model"] == "test-model"
        assert seen["prompt"] == "Say hi"
        assert seen["stream"] is False
        assert "format" not in seen  # unstructured call must NOT set format

    async def test_generate_transport_error(self) -> None:
        def handler(_req: httpx2.Request) -> httpx2.Response:
            raise httpx2.ConnectError("connection refused")

        backend = OllamaBackend(
            base_url=OLLAMA,
            transport=_mock_transport(handler),
            max_retries=1,
        )
        with pytest.raises(OllamaTransportError, match="transport error"):
            await backend.generate("Hi")
        await backend.aclose()

    async def test_generate_timeout(self) -> None:
        def handler(_req: httpx2.Request) -> httpx2.Response:
            raise httpx2.ReadTimeout("timeout")

        backend = OllamaBackend(
            base_url=OLLAMA,
            transport=_mock_transport(handler),
            max_retries=1,
        )
        with pytest.raises(OllamaTimeoutError):
            await backend.generate("Hi")
        await backend.aclose()

    async def test_generate_non_200(self) -> None:
        def handler(_req: httpx2.Request) -> httpx2.Response:
            return httpx2.Response(400, text="bad payload")

        backend = OllamaBackend(base_url=OLLAMA, transport=_mock_transport(handler))
        with pytest.raises(OllamaTransportError, match="HTTP 400"):
            await backend.generate("Hi")
        await backend.aclose()

    async def test_generate_retries_5xx_then_succeeds(self) -> None:
        calls = {"n": 0}

        def handler(_req: httpx2.Request) -> httpx2.Response:
            calls["n"] += 1
            if calls["n"] == 1:
                return httpx2.Response(503, text="unavailable")
            return _ok({"response": "recovered", "done": True, "eval_count": 3})

        backend = OllamaBackend(base_url=OLLAMA, transport=_mock_transport(handler), max_retries=2)
        result = await backend.generate("Hi")
        assert result.text == "recovered"
        assert calls["n"] == 2
        await backend.aclose()


# --- generate_structured() ---


_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "verdict": {"type": "string", "enum": ["allow", "deny"]},
        "reason": {"type": "string"},
    },
    "required": ["verdict", "reason"],
}


class TestGenerateStructured:
    async def test_happy_path(self) -> None:
        captured: dict[str, object] = {}

        def handler(request: httpx2.Request) -> httpx2.Response:
            captured.update(json.loads(request.content))
            return _ok(
                {
                    "response": json.dumps({"verdict": "allow", "reason": "ok"}),
                    "done": True,
                    "done_reason": "stop",
                    "eval_count": 20,
                    "prompt_eval_count": 5,
                    "total_duration": 12345,
                }
            )

        async with OllamaBackend(
            base_url=OLLAMA, model="test-model", transport=_mock_transport(handler)
        ) as backend:
            result = await backend.generate_structured("classify", _SCHEMA)

        assert isinstance(result, StructuredResponse)
        assert result.data == {"verdict": "allow", "reason": "ok"}
        assert result.tokens_used == 20
        assert result.model == "test-model"
        assert result.metadata["prompt_eval_count"] == 5
        # Ollama's structured-output path uses the `format` field.
        assert captured["format"] == _SCHEMA

    async def test_schema_mismatch_raises(self) -> None:
        """Model returned text that isn't JSON."""

        def handler(_req: httpx2.Request) -> httpx2.Response:
            return _ok({"response": "not a JSON object", "done": True, "eval_count": 3})

        backend = OllamaBackend(base_url=OLLAMA, transport=_mock_transport(handler))
        with pytest.raises(OllamaSchemaError, match="not valid JSON"):
            await backend.generate_structured("go", _SCHEMA)
        await backend.aclose()

    async def test_non_object_json_raises(self) -> None:
        def handler(_req: httpx2.Request) -> httpx2.Response:
            return _ok({"response": '["a", "b"]', "done": True, "eval_count": 2})

        backend = OllamaBackend(base_url=OLLAMA, transport=_mock_transport(handler))
        with pytest.raises(OllamaSchemaError, match="JSON object"):
            await backend.generate_structured("go", _SCHEMA)
        await backend.aclose()

    async def test_empty_response_raises_refusal(self) -> None:
        def handler(_req: httpx2.Request) -> httpx2.Response:
            return _ok({"response": "   ", "done": True, "eval_count": 0})

        backend = OllamaBackend(base_url=OLLAMA, transport=_mock_transport(handler))
        with pytest.raises(OllamaModelRefusalError):
            await backend.generate_structured("go", _SCHEMA)
        await backend.aclose()


# --- SPAL bridge: propose_request_context ---


class TestPolicyBridge:
    async def test_propose_request_context_returns_validated_model(self) -> None:
        proposal = {
            "identity": {"type": "ephemeral_required", "did": "did:key:zabc"},
            "proofs": [{"type": "zkp", "claim": "age_over_18"}],
            "intended_use": {"training": False, "aggregation": False, "resale": False},
            "offered_retention_seconds": 3600,
            "payment_offered": True,
        }

        def handler(_req: httpx2.Request) -> httpx2.Response:
            return _ok(
                {
                    "response": json.dumps(proposal),
                    "done": True,
                    "eval_count": 42,
                }
            )

        async with OllamaBackend(
            base_url=OLLAMA, model="test-model", transport=_mock_transport(handler)
        ) as backend:
            ctx = await propose_request_context(backend, "Verify age >= 18 for purchase")

        assert ctx.identity is not None
        assert ctx.identity.type == IdentityType.EPHEMERAL_REQUIRED
        assert ctx.proofs[0].type == ProofType.ZKP
        assert ctx.offered_retention_seconds == 3600
        assert ctx.payment_offered is True

    async def test_propose_request_context_rejects_invalid_shape(self) -> None:
        """Value-level validation catches shape that JSON-schema alone can't."""

        def handler(_req: httpx2.Request) -> httpx2.Response:
            return _ok(
                {
                    "response": json.dumps(
                        {
                            "identity": {"type": "not-a-real-type"},
                            "proofs": [],
                        }
                    ),
                    "done": True,
                    "eval_count": 5,
                }
            )

        backend = OllamaBackend(base_url=OLLAMA, transport=_mock_transport(handler))
        with pytest.raises(RequestContextError, match="invalid RequestContext"):
            await propose_request_context(backend, "prompt")
        await backend.aclose()
