"""Tests for the Agent's OpenAI-compatible wiring (config-driven dispatch)."""

from __future__ import annotations

import json
from collections.abc import Callable

import httpx2
import pytest

from freehold_agent import Agent, AgentConfig, LLMConfig
from freehold_agent.models.openai import OpenAICompatBackend
from freehold_agent.spal import IdentityType, ProofType


def _transport(
    handler: Callable[[httpx2.Request], httpx2.Response],
) -> httpx2.MockTransport:
    return httpx2.MockTransport(handler)


def _chat(content: str) -> dict:
    return {
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 3, "completion_tokens": 5, "total_tokens": 8},
    }


# A RequestContext the stubbed model "proposes"; the bridge validates it.
PROPOSAL = {
    "identity": {"type": "ephemeral_required", "did": "did:key:zabc"},
    "proofs": [{"type": "zkp", "claim": "age_over_18"}],
    "intended_use": {"training": False, "aggregation": False, "resale": False},
    "offered_retention_seconds": 0,
    "payment_offered": False,
}


class TestAgentBackendDispatch:
    async def test_openai_backend_selected_when_configured(self) -> None:
        config = AgentConfig(llm=LLMConfig(backend="openai"))
        agent = Agent(config)
        await agent.initialize()
        try:
            assert agent._openai_backend is not None
            assert agent._ollama_backend is None
            assert agent._llm is None
        finally:
            await agent.close()

    async def test_openai_generate_used_when_no_context(self) -> None:
        def handler(request: httpx2.Request) -> httpx2.Response:
            body = json.loads(request.content)
            assert request.url.path == "/v1/chat/completions"
            assert body["messages"][0]["content"].endswith("Answer:")
            assert "Question: hello" in body["messages"][0]["content"]
            return httpx2.Response(200, json=_chat("hi from openai"))

        config = AgentConfig(llm=LLMConfig(backend="openai"))
        agent = Agent(config)
        await agent.initialize()
        # Swap the backend with one bound to our mock transport.
        await agent._openai_backend.aclose()  # type: ignore[union-attr]
        agent._openai_backend = OpenAICompatBackend(
            model="test-model", transport=_transport(handler)
        )
        try:
            response = await agent.process("hello")
            assert response.content == "hi from openai"
        finally:
            await agent.close()

    async def test_propose_request_context_uses_json_schema_response_format(self) -> None:
        """The S-PAL composer runs on the OpenAI-compatible backend (llama-server)."""

        def handler(request: httpx2.Request) -> httpx2.Response:
            body = json.loads(request.content)
            assert request.url.path == "/v1/chat/completions"
            response_format = body["response_format"]
            assert response_format["type"] == "json_schema"
            assert "properties" in response_format["json_schema"]["schema"]
            return httpx2.Response(200, json=_chat(json.dumps(PROPOSAL)))

        agent = Agent(AgentConfig(llm=LLMConfig(backend="openai")))
        await agent.initialize()
        await agent._openai_backend.aclose()  # type: ignore[union-attr]
        agent._openai_backend = OpenAICompatBackend(
            model="test-model", transport=_transport(handler)
        )
        try:
            ctx = await agent.propose_request_context(
                "Business needs age >= 18 verification for alcohol purchase"
            )
            assert ctx.identity is not None
            assert ctx.identity.type == IdentityType.EPHEMERAL_REQUIRED
            assert ctx.proofs[0].type == ProofType.ZKP
        finally:
            await agent.close()

    async def test_default_stack_only_talks_to_the_configured_endpoint(self) -> None:
        """Every request the default config makes goes to the llama-server URL.

        The transport records every request the backend issues; composing a
        request context must produce exactly one, to the configured loopback
        endpoint, and nothing else (ADR-006: the default runtime makes no
        outbound calls).
        """
        seen: list[str] = []

        def handler(request: httpx2.Request) -> httpx2.Response:
            seen.append(str(request.url))
            return httpx2.Response(200, json=_chat(json.dumps(PROPOSAL)))

        config = AgentConfig()
        assert config.llm.backend == "openai"
        agent = Agent(config)
        await agent.initialize()
        await agent._openai_backend.aclose()  # type: ignore[union-attr]
        agent._openai_backend = OpenAICompatBackend(
            base_url=config.llm.openai_base_url,
            model="test-model",
            transport=_transport(handler),
        )
        try:
            await agent.propose_request_context("Verify age >= 18")
            await agent.process("hello")
        finally:
            await agent.close()
        assert seen == ["http://127.0.0.1:8080/v1/chat/completions"] * 2

    async def test_close_releases_openai_client(self) -> None:
        config = AgentConfig(llm=LLMConfig(backend="openai"))
        agent = Agent(config)
        await agent.initialize()
        assert agent._openai_backend is not None
        await agent.close()
        assert agent._openai_backend is None


class TestAgentConfigFromEnv:
    def test_env_selects_openai_backend(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("FREEHOLD_LLM_BACKEND", "openai")
        monkeypatch.setenv("FREEHOLD_LLM_TIER", "small")
        monkeypatch.setenv("FREEHOLD_OPENAI_BASE_URL", "http://example.internal:8000/v1")
        monkeypatch.setenv("FREEHOLD_OPENAI_API_KEY", "sk-xyz")
        monkeypatch.delenv("FREEHOLD_OPENAI_MODEL", raising=False)
        monkeypatch.delenv("FREEHOLD_OPENAI_TIMEOUT", raising=False)

        cfg = AgentConfig.from_env()
        assert cfg.llm.backend == "openai"
        assert cfg.llm.openai_tier == "small"
        assert cfg.llm.openai_base_url == "http://example.internal:8000/v1"
        assert cfg.llm.openai_api_key == "sk-xyz"  # pragma: allowlist secret

    def test_env_openai_timeout_rejects_infinity(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Infinite timeouts disable the httpx2 deadline; reject at parse time."""
        monkeypatch.setenv("FREEHOLD_OPENAI_TIMEOUT", "inf")
        with pytest.raises(ValueError, match="finite"):
            AgentConfig.from_env()

    def test_llm_config_rejects_infinite_openai_timeout(self) -> None:
        with pytest.raises(ValueError):
            LLMConfig(openai_timeout_seconds=float("inf"))


class TestAgentLifecycleSafety:
    async def test_initialize_releases_backend_on_context_failure(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """If context connect() fails, the OpenAI backend must not leak."""
        agent = Agent(AgentConfig(llm=LLMConfig(backend="openai")))

        async def boom() -> None:
            raise RuntimeError("context store unavailable")

        monkeypatch.setattr(agent._context_client, "connect", boom)

        with pytest.raises(RuntimeError, match="context store unavailable"):
            await agent.initialize()

        assert agent._openai_backend is None
        assert not agent._initialized
