"""The ask path: the holder asks about their own data under a policy, never about identity."""

from __future__ import annotations

import pytest

from freehold_agent import Agent, AgentConfig
from freehold_agent.config import LLMConfig
from freehold_agent.errors import ContextLocked, NoModelBackend, PolicyRefused
from freehold_agent.models.backend import LLMResponse
from tests.fakes import SEED_KEY, SEED_POLICY, SEED_ROOT_IDENTITY, FakeVault


class FakeBackend:
    """Answers with fixed text and records the prompt it was given."""

    def __init__(self, text: str = "you are 36") -> None:
        self.text = text
        self.prompts: list[str] = []

    async def generate(self, prompt: str, **_: object) -> LLMResponse:
        self.prompts.append(prompt)
        return LLMResponse(text=self.text, tokens_used=3, finish_reason="stop")

    async def aclose(self) -> None:
        return None


def _vault() -> FakeVault:
    return FakeVault(
        {
            "root-identity": SEED_ROOT_IDENTITY,
            SEED_KEY: SEED_POLICY,
            "personal-context": {"birthDate": "1990-05-15", "fullName": "Alice"},
            "identity/authorizations/abc": {"ephemeralDid": "did:key:z6Mkeph"},
        }
    )


def _agent(vault: FakeVault | None = None, backend: FakeBackend | None = None) -> Agent:
    agent = Agent(AgentConfig(llm=LLMConfig(backend="none")), context_client=vault or _vault())
    if backend is not None:
        agent._openai_backend = backend  # type: ignore[assignment]
    return agent


async def test_ask_refuses_identity_domain_before_reading() -> None:
    vault = _vault()
    with pytest.raises(PolicyRefused, match="identity"):
        await _agent(vault, FakeBackend()).ask(
            "who am I?", "age-verification", "identity/authorizations"
        )
    assert vault.reads == []


async def test_ask_refuses_root_identity_key() -> None:
    vault = _vault()
    with pytest.raises(PolicyRefused, match="identity"):
        await _agent(vault, FakeBackend()).ask(
            "what is my key?", "age-verification", "root-identity"
        )
    assert vault.reads == []


async def test_ask_denies_without_matching_rule() -> None:
    backend = FakeBackend()
    with pytest.raises(PolicyRefused, match="personal/email"):
        await _agent(backend=backend).ask("what is my email?", "age-verification", "personal/email")
    assert backend.prompts == []


async def test_ask_denies_for_a_policy_that_is_not_there() -> None:
    with pytest.raises(PolicyRefused, match="policy not found"):
        await _agent(backend=FakeBackend()).ask("how old am I?", "nope", "personal/age")


async def test_ask_answers_under_a_matching_rule_with_entries_in_scope() -> None:
    backend = FakeBackend()
    response = await _agent(backend=backend).ask(
        "how old am I?", "age-verification", "personal/age"
    )
    assert response.content == "you are 36"
    assert response.rule_id == "rule-age"
    assert response.context_used == ["personal-context"]
    assert "birthDate: 1990-05-15" in backend.prompts[0]
    assert "Question: how old am I?" in backend.prompts[0]
    assert "did:key:z6Mkeph" not in backend.prompts[0]


async def test_ask_under_seeded_policy_passes_as_holder() -> None:
    """The seeded rule requires an ephemeral identity and a proof; the holder asking is neither."""
    response = await _agent(backend=FakeBackend()).ask(
        "how old am I?", "age-verification", "personal/age"
    )
    assert response.rule_id == "rule-age"


async def test_ask_requires_an_unlocked_vault() -> None:
    vault = _vault()
    vault.error = ContextLocked("context store locked")
    with pytest.raises(ContextLocked):
        await _agent(vault, FakeBackend()).ask("how old am I?", "age-verification", "personal/age")


async def test_ask_without_backend_raises_no_model_backend() -> None:
    with pytest.raises(NoModelBackend, match="no model backend configured"):
        await _agent().ask("how old am I?", "age-verification", "personal/age")


async def test_agent_does_not_disconnect_a_client_it_was_given() -> None:
    class Watching(FakeVault):
        disconnected = False

        async def disconnect(self) -> None:
            self.disconnected = True

    vault = Watching({"root-identity": SEED_ROOT_IDENTITY})
    agent = _agent(vault)
    await agent.initialize()
    await agent.close()
    assert vault.disconnected is False
