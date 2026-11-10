"""The ask path: the holder asks about their own data under a policy, never about identity."""

from __future__ import annotations

import pytest

from freehold_agent import Agent, AgentConfig
from freehold_agent.agent import is_private_key
from freehold_agent.config import LLMConfig
from freehold_agent.context import ContextEntry
from freehold_agent.custody import Operator
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
            "personal/age": {"birthDate": "1990-05-15"},
            "personal/name": {"fullName": "Alice"},
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
    with pytest.raises(PolicyRefused, match="personal/notes"):
        await _agent(backend=backend).ask(
            "what are my notes?", "age-verification", "personal/notes"
        )
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
    assert response.context_used == ["personal/age", "personal/name"]
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


async def test_agent_neither_connects_nor_disconnects_a_client_it_was_given() -> None:
    class Watching(FakeVault):
        connected = False
        disconnected = False

        async def connect(self) -> None:
            self.connected = True

        async def disconnect(self) -> None:
            self.disconnected = True

    vault = Watching({"root-identity": SEED_ROOT_IDENTITY})
    agent = _agent(vault)
    await agent.initialize()
    await agent.close()
    assert vault.connected is False
    assert vault.disconnected is False


async def test_ask_refuses_a_domain_that_would_admit_the_root_identity_key() -> None:
    """``root/x`` has domain ``root``; the reader admits ``root-identity`` to it. Refused."""
    vault = _vault()
    with pytest.raises(PolicyRefused, match="identity"):
        await _agent(vault, FakeBackend()).ask(
            "what is my key?", "age-verification", "root/anything"
        )
    assert vault.reads == []


def test_private_keys_are_recognised_at_the_key_level() -> None:
    assert is_private_key("root-identity")
    assert is_private_key("identity/authorizations/abc")
    assert is_private_key("identity")
    assert is_private_key("policies/age-verification")
    assert not is_private_key("personal/age")


async def test_ask_refuses_the_policies_domain_because_policies_carry_the_root_did() -> None:
    policy = {**SEED_POLICY, "rules": [{"id": "r", "context_scope": "policies", "conditions": {}}]}
    vault = FakeVault({"root-identity": SEED_ROOT_IDENTITY, SEED_KEY: policy})
    backend = FakeBackend()
    with pytest.raises(PolicyRefused, match="identity"):
        await _agent(vault, backend).ask("what are my policies?", "age-verification", "policies")
    assert backend.prompts == []


async def test_ask_never_puts_an_identity_entry_in_the_prompt_even_if_one_is_in_scope() -> None:
    """Defence in depth: whatever the reader returns, identity keys are dropped before the model."""

    class Leaky(FakeVault):
        async def entries(self, scope: str | None = None) -> list[ContextEntry]:
            root = await super().entry("root-identity")
            assert root is not None
            return [*await super().entries(scope), root]

    vault = Leaky(
        {
            "root-identity": SEED_ROOT_IDENTITY,
            SEED_KEY: SEED_POLICY,
            "personal/age": {"birthDate": "1990-05-15"},
        }
    )
    backend = FakeBackend()
    response = await _agent(vault, backend).ask("how old am I?", "age-verification", "personal/age")
    assert response.context_used == ["personal/age"]
    assert "z6MkseedOwner" not in backend.prompts[0]


async def test_ask_without_backend_reads_nothing_from_the_vault() -> None:
    vault = _vault()
    with pytest.raises(NoModelBackend):
        await _agent(vault).ask("how old am I?", "age-verification", "personal/age")
    assert vault.reads == []


async def test_ask_refuses_when_the_vault_changes_hands_mid_ask() -> None:
    """Another unlock between the policy read and the context read is not one holder's ask."""
    from freehold_agent.errors import ContextUnavailable

    class Switching(FakeVault):
        async def entries(self, scope: str | None = None) -> list[ContextEntry]:
            self.session += 1  # another unlock: a new vault session
            return await super().entries(scope)

    vault = Switching(
        {"root-identity": SEED_ROOT_IDENTITY, SEED_KEY: SEED_POLICY, "personal/age": {"a": 1}}
    )
    backend = FakeBackend()
    with pytest.raises(ContextUnavailable, match="changed"):
        await _agent(vault, backend).ask("how old am I?", "age-verification", "personal/age")
    assert backend.prompts == []


async def test_an_agent_with_its_own_client_can_unlock_it() -> None:
    from unittest.mock import AsyncMock, patch

    agent = Agent(AgentConfig(llm=LLMConfig(backend="none")))
    with patch.object(agent._context_client, "unlock", new=AsyncMock()) as unlock:
        await agent.unlock("demo-user", "pw")
    unlock.assert_awaited_once_with("demo-user", "pw")
    assert agent.is_unlocked is False
    agent.lock()


async def test_ask_refuses_when_the_model_is_further_than_the_rules_custody() -> None:
    policy = {**SEED_POLICY, "version": "1.1"}
    policy["rules"] = [
        {
            **SEED_POLICY["rules"][0],
            "conditions": {
                **SEED_POLICY["rules"][0]["conditions"],
                "custody": {"operator": "device_only"},
            },
        }
    ]
    vault = FakeVault(
        {
            "root-identity": SEED_ROOT_IDENTITY,
            SEED_KEY: policy,
            "personal/age": {"birthDate": "1990-05-15"},
        }
    )
    backend = FakeBackend()
    agent = Agent(
        AgentConfig(llm=LLMConfig(backend="none", custody=Operator.FEDERATED_OPERATOR)),
        context_client=vault,
    )
    agent._openai_backend = backend  # type: ignore[assignment]
    with pytest.raises(PolicyRefused, match="custody"):
        await agent.ask("how old am I?", "age-verification", "personal/age")
    assert backend.prompts == []


async def test_ask_proceeds_when_the_model_is_within_the_rules_custody() -> None:
    policy = {**SEED_POLICY, "version": "1.1"}
    policy["rules"] = [
        {
            **SEED_POLICY["rules"][0],
            "conditions": {
                **SEED_POLICY["rules"][0]["conditions"],
                "custody": {"operator": "federated_operator"},
            },
        }
    ]
    vault = FakeVault(
        {
            "root-identity": SEED_ROOT_IDENTITY,
            SEED_KEY: policy,
            "personal/age": {"birthDate": "1990-05-15"},
        }
    )
    agent = Agent(
        AgentConfig(llm=LLMConfig(backend="none", custody=Operator.FEDERATED_OPERATOR)),
        context_client=vault,
    )
    agent._openai_backend = FakeBackend()  # type: ignore[assignment]
    response = await agent.ask("how old am I?", "age-verification", "personal/age")
    assert response.rule_id == "rule-age"


async def test_ask_refuses_when_another_rule_in_the_domain_keeps_its_data_closer() -> None:
    """The ask would read the whole personal domain, and the email rule keeps email at home."""
    policy = {**SEED_POLICY, "version": "1.1"}
    base = {k: v for k, v in SEED_POLICY["rules"][0]["conditions"].items() if k != "custody"}
    policy["rules"] = [
        {
            "id": "age",
            "context_scope": "personal/age",
            "conditions": {**base, "custody": {"operator": "federated_operator"}},
        },
        {"id": "email", "context_scope": "personal/email", "conditions": dict(base)},
    ]
    vault = FakeVault(
        {
            "root-identity": SEED_ROOT_IDENTITY,
            SEED_KEY: policy,
            "personal/age": {"birthDate": "1990-05-15"},
            "personal/email": {"email": "a@b"},
        }
    )
    backend = FakeBackend()
    agent = Agent(
        AgentConfig(llm=LLMConfig(backend="none", custody=Operator.FEDERATED_OPERATOR)),
        context_client=vault,
    )
    agent._openai_backend = backend  # type: ignore[assignment]
    with pytest.raises(PolicyRefused, match="personal/email"):
        await agent.ask("how old am I?", "age-verification", "personal/age")
    assert backend.prompts == []
