"""Tests for the Agent's Ollama wiring (config-driven dispatch + S-PAL hook)."""

from __future__ import annotations

import json

import httpx2
import pytest

from freehold_agent import Agent, AgentConfig, LLMConfig
from freehold_agent.context import ContextClient
from freehold_agent.models.ollama import OllamaBackend
from freehold_agent.spal import IdentityType, ProofType
from tests.fakes import SEED_KEY, SEED_POLICY, SEED_ROOT_IDENTITY, FakeVault
from tests.test_api_unlock import _client as _vault_client
from tests.test_context import PASSWORD, USER, FakeStore


def _transport(handler):  # noqa: ANN001, ANN201
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


class TestAgentBackendDispatch:
    async def test_default_config_uses_llama_server_backend(self) -> None:
        """Default config = OpenAI-compatible client at llama-server's address (ADR-006)."""
        agent = Agent(AgentConfig())
        assert agent.config.llm.url == "https://127.0.0.1:8080/v1"
        await agent.initialize()
        try:
            assert agent._openai_backend is not None
            assert agent._ollama_backend is None
        finally:
            await agent.close()

    async def test_ollama_backend_selected_when_configured(self) -> None:
        config = AgentConfig(
            llm=LLMConfig(backend="ollama", url="https://127.0.0.1:11434", custody="owned_hardware")
        )
        agent = Agent(config)
        await agent.initialize()
        try:
            assert agent._ollama_backend is not None
            assert agent._openai_backend is None
        finally:
            await agent.close()

    async def test_ollama_generate_answers_an_ask(self) -> None:
        def handler(request: httpx2.Request) -> httpx2.Response:
            body = json.loads(request.content)
            assert "Question: hello" in body["prompt"]
            return httpx2.Response(
                200,
                json={"response": "hi from ollama", "done": True, "eval_count": 5},
            )

        config = AgentConfig(
            llm=LLMConfig(backend="ollama", url="https://127.0.0.1:11434", custody="owned_hardware")
        )
        agent = Agent(config, context_client=await _unlocked_vault())
        await agent.initialize()
        # Swap the backend with one bound to our mock transport.
        await agent._ollama_backend.aclose()  # type: ignore[union-attr]
        agent._ollama_backend = OllamaBackend(
            base_url="https://127.0.0.1:11434", model="test-model", transport=_transport(handler)
        )
        try:
            response = await agent.ask("hello", "age-verification", "personal/age")
            assert response.content == "hi from ollama"
            assert response.rule_id == "rule-age"
        finally:
            await agent.close()

    async def test_close_releases_ollama_client(self) -> None:
        config = AgentConfig(
            llm=LLMConfig(backend="ollama", url="https://127.0.0.1:11434", custody="owned_hardware")
        )
        agent = Agent(config)
        await agent.initialize()
        assert agent._ollama_backend is not None
        await agent.close()
        assert agent._ollama_backend is None


class TestAgentPolicyHook:
    """The ``propose_request_context`` hook is the S-PAL wiring point."""

    async def test_propose_request_context_requires_a_backend(self) -> None:
        """With no model backend there is nothing to propose with."""
        agent = Agent(AgentConfig(llm=LLMConfig(backend="none")), context_client=FakeVault())
        await agent.initialize()
        try:
            with pytest.raises(RuntimeError, match="needs a model backend"):
                await agent.propose_request_context("some prompt")
        finally:
            await agent.close()

    async def test_propose_request_context_returns_validated_model(self) -> None:
        proposal = {
            "identity": {"type": "ephemeral_required", "did": "did:key:zabc"},
            "proofs": [{"type": "zkp", "claim": "age_over_18"}],
            "intended_use": {"training": False, "aggregation": False, "resale": False},
            "offered_retention_seconds": 0,
            "payment_offered": False,
        }

        def handler(request: httpx2.Request) -> httpx2.Response:
            body = json.loads(request.content)
            # The bridge must pass a JSON schema via Ollama's `format` field.
            assert isinstance(body.get("format"), dict)
            return httpx2.Response(
                200,
                json={
                    "response": json.dumps(proposal),
                    "done": True,
                    "eval_count": 25,
                },
            )

        agent = Agent(
            AgentConfig(
                llm=LLMConfig(
                    backend="ollama", url="https://127.0.0.1:11434", custody="owned_hardware"
                )
            )
        )
        await agent.initialize()
        await agent._ollama_backend.aclose()  # type: ignore[union-attr]
        agent._ollama_backend = OllamaBackend(
            base_url="https://127.0.0.1:11434", model="test-model", transport=_transport(handler)
        )
        try:
            ctx = await agent.propose_request_context(
                "Business needs age >= 18 verification for alcohol purchase"
            )
            assert ctx.identity is not None
            assert ctx.identity.type == IdentityType.EPHEMERAL_REQUIRED
            assert ctx.proofs[0].type == ProofType.ZKP
            assert ctx.proofs[0].claim == "age_over_18"
        finally:
            await agent.close()


class TestAgentConfigFromEnv:
    def test_env_selects_ollama_backend(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("FREEHOLD_LLM_BACKEND", "ollama")
        monkeypatch.setenv("FREEHOLD_LLM_TIER", "small")
        monkeypatch.setenv("FREEHOLD_LLM_URL", "https://example.internal:11434")
        monkeypatch.setenv(
            "FREEHOLD_LLM_CUSTODY", "owned_hardware"
        )  # a named server names its machine
        monkeypatch.delenv("FREEHOLD_LLM_MODEL", raising=False)
        monkeypatch.delenv("FREEHOLD_LLM_TIMEOUT", raising=False)

        cfg = AgentConfig.from_env()
        assert cfg.llm.backend == "ollama"
        assert cfg.llm.tier == "small"
        assert cfg.llm.url == "https://example.internal:11434"

    def test_env_defaults_to_llama_server(self, monkeypatch: pytest.MonkeyPatch) -> None:
        for var in (
            "FREEHOLD_LLM_BACKEND",
            "FREEHOLD_LLM_URL",
            "FREEHOLD_LLM_MODEL",
            "FREEHOLD_LLM_TIER",
            "FREEHOLD_LLM_TIMEOUT",
        ):
            monkeypatch.delenv(var, raising=False)
        cfg = AgentConfig.from_env()
        assert cfg.llm.backend == "http"
        assert cfg.llm.url == "https://127.0.0.1:8080/v1"

    def test_env_empty_model_and_key_count_as_unset(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """A compose pass-through or cleared export leaves "" behind, not an absence.

        An empty model name must not pin the tier to the default and an empty key
        must not become a bearer header, so both collapse to None.
        """
        monkeypatch.setenv("FREEHOLD_LLM_MODEL", "")
        monkeypatch.setenv("FREEHOLD_LLM_API_KEY", "")
        cfg = AgentConfig.from_env()
        assert cfg.llm.model is None
        assert cfg.llm.api_key is None

    def test_a_cleared_backend_counts_as_unset(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("FREEHOLD_LLM_BACKEND", "")
        monkeypatch.setenv("FREEHOLD_LLM_MODEL", "served-name")
        cfg = AgentConfig.from_env()
        assert cfg.llm.backend == "http"
        assert cfg.llm.model == "served-name"

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
        """If context connect() fails, the Ollama backend must not leak."""
        agent = Agent(
            AgentConfig(
                llm=LLMConfig(
                    backend="ollama", url="https://127.0.0.1:11434", custody="owned_hardware"
                )
            )
        )

        async def boom() -> None:
            raise RuntimeError("context store unavailable")

        monkeypatch.setattr(agent._context_client, "connect", boom)

        with pytest.raises(RuntimeError, match="context store unavailable"):
            await agent.initialize()

        assert agent._ollama_backend is None
        assert not agent._initialized

    async def test_close_runs_backend_release_even_if_disconnect_raises(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A failing disconnect() must not skip backend cleanup."""
        agent = Agent(
            AgentConfig(
                llm=LLMConfig(
                    backend="ollama", url="https://127.0.0.1:11434", custody="owned_hardware"
                )
            )
        )
        await agent.initialize()
        assert agent._ollama_backend is not None

        async def boom() -> None:
            raise RuntimeError("disconnect blew up")

        monkeypatch.setattr(agent._context_client, "disconnect", boom)

        with pytest.raises(RuntimeError, match="disconnect blew up"):
            await agent.close()

        assert agent._ollama_backend is None
        assert not agent._initialized
