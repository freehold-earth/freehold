"""Tests for the Agent's OpenAI-compatible wiring (config-driven dispatch)."""

from __future__ import annotations

import json
from collections.abc import Callable

import httpx2
import pytest

from freehold_agent import Agent, AgentConfig, LLMConfig
from freehold_agent.context import ContextClient
from freehold_agent.models.openai import OpenAICompatBackend
from freehold_agent.spal import IdentityType, ProofType
from tests.fakes import SEED_KEY, SEED_POLICY, SEED_ROOT_IDENTITY
from tests.test_api_unlock import _client as _vault_client
from tests.test_context import PASSWORD, USER, FakeStore


def _transport(
    handler: Callable[[httpx2.Request], httpx2.Response],
) -> httpx2.MockTransport:
    return httpx2.MockTransport(handler)


async def _unlocked_vault() -> ContextClient:
    """A context client over a store holding the seed root, the seed policy and an age entry."""
    store = FakeStore(
        {
            "root-identity": SEED_ROOT_IDENTITY,
            SEED_KEY: SEED_POLICY,
            "personal/age": {"birthDate": "1990-05-15"},
        }
    )
    context = _vault_client(store)
    await context.unlock(USER, PASSWORD)
    return context


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
        config = AgentConfig(llm=LLMConfig(backend="http"))
        agent = Agent(config)
        await agent.initialize()
        try:
            assert agent._openai_backend is not None
            assert agent._ollama_backend is None
            assert agent._llm is None
        finally:
            await agent.close()

    async def test_openai_generate_answers_an_ask(self) -> None:
        handler_prompts: list[str] = []

        def handler(request: httpx2.Request) -> httpx2.Response:
            body = json.loads(request.content)
            assert request.url.path == "/v1/chat/completions"
            assert body["messages"][0]["content"].endswith("Answer:")
            assert "Question: hello" in body["messages"][0]["content"]
            handler_prompts.append(body["messages"][0]["content"])
            return httpx2.Response(200, json=_chat("hi from openai"))

        config = AgentConfig(llm=LLMConfig(backend="http"))
        agent = Agent(config, context_client=await _unlocked_vault())
        await agent.initialize()
        # Swap the backend with one bound to our mock transport.
        await agent._openai_backend.aclose()  # type: ignore[union-attr]
        agent._openai_backend = OpenAICompatBackend(
            model="test-model", transport=_transport(handler)
        )
        try:
            response = await agent.ask("hello", "age-verification", "personal/age")
            assert response.content == "hi from openai"
            assert "birthDate: 1990-05-15" in handler_prompts[0]
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

        agent = Agent(AgentConfig(llm=LLMConfig(backend="http")))
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

    async def test_default_config_sends_llm_requests_only_to_its_endpoint(self) -> None:
        """Every LLM request the default config makes goes to the llama-server URL.

        The transport records what the LLM backend issues and nothing else, so
        this covers the model-call half of ADR-006's no-outbound-calls rule:
        composing a request context and answering a query produce one request
        each, both to the configured loopback endpoint. Other clients are not
        observed here.
        """
        seen: list[str] = []

        def handler(request: httpx2.Request) -> httpx2.Response:
            seen.append(str(request.url))
            return httpx2.Response(200, json=_chat(json.dumps(PROPOSAL)))

        config = AgentConfig()
        assert config.llm.backend == "http"
        agent = Agent(config, context_client=await _unlocked_vault())
        await agent.initialize()
        await agent._openai_backend.aclose()  # type: ignore[union-attr]
        agent._openai_backend = OpenAICompatBackend(
            base_url=config.llm.url,
            model="test-model",
            transport=_transport(handler),
        )
        try:
            await agent.propose_request_context("Verify age >= 18")
            await agent.ask("hello", "age-verification", "personal/age")
        finally:
            await agent.close()
        assert seen == ["https://127.0.0.1:8080/v1/chat/completions"] * 2

    async def test_close_releases_openai_client(self) -> None:
        config = AgentConfig(llm=LLMConfig(backend="http"))
        agent = Agent(config)
        await agent.initialize()
        assert agent._openai_backend is not None
        await agent.close()
        assert agent._openai_backend is None


class TestAgentConfigFromEnv:
    def test_env_selects_http_backend(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("FREEHOLD_LLM_BACKEND", "http")
        monkeypatch.setenv("FREEHOLD_LLM_TIER", "small")
        monkeypatch.setenv("FREEHOLD_LLM_URL", "https://example.internal:8000/v1")
        monkeypatch.setenv("FREEHOLD_LLM_API_KEY", "sk-xyz")
        monkeypatch.setenv("FREEHOLD_CA_FILE", "/etc/freehold/ca.pem")
        monkeypatch.delenv("FREEHOLD_LLM_MODEL", raising=False)
        monkeypatch.delenv("FREEHOLD_LLM_TIMEOUT", raising=False)

        cfg = AgentConfig.from_env()
        assert cfg.llm.backend == "http"
        assert cfg.llm.tier == "small"
        assert cfg.llm.url == "https://example.internal:8000/v1"
        assert cfg.llm.api_key == "sk-xyz"  # pragma: allowlist secret
        assert cfg.ca_file == "/etc/freehold/ca.pem"

    def test_env_timeout_rejects_infinity(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Infinite timeouts disable the httpx2 deadline; reject at parse time."""
        monkeypatch.setenv("FREEHOLD_LLM_TIMEOUT", "inf")
        with pytest.raises(ValueError, match="finite"):
            AgentConfig.from_env()

    def test_llm_config_rejects_infinite_timeout(self) -> None:
        with pytest.raises(ValueError):
            LLMConfig(timeout_seconds=float("inf"))


class TestAgentLifecycleSafety:
    async def test_initialize_releases_backend_on_context_failure(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """If context connect() fails, the OpenAI backend must not leak."""
        agent = Agent(AgentConfig(llm=LLMConfig(backend="http")))

        async def boom() -> None:
            raise RuntimeError("context store unavailable")

        monkeypatch.setattr(agent._context_client, "connect", boom)

        with pytest.raises(RuntimeError, match="context store unavailable"):
            await agent.initialize()

        assert agent._openai_backend is None
        assert not agent._initialized
