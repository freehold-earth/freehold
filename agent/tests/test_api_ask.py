"""POST /ask: the holder asks their agent about their own data, under one of their policies."""

from __future__ import annotations

from fastapi.testclient import TestClient

from freehold_agent import Agent
from freehold_agent.api import create_app
from freehold_agent.config import AgentConfig, LLMConfig
from tests.fakes import SEED_KEY, SEED_POLICY, SEED_ROOT_IDENTITY
from tests.test_agent import FakeBackend
from tests.test_api_unlock import _client as _vault_client
from tests.test_context import PASSWORD, USER, FakeStore

USER_APP = "https://localhost:4501"
BUSINESS_APP = "https://localhost:4502"


def _client(*, backend: bool = True, unlocked: bool = True) -> TestClient:
    store = FakeStore(
        {
            "root-identity": SEED_ROOT_IDENTITY,
            SEED_KEY: SEED_POLICY,
            "personal-context": {"birthDate": "1990-05-15"},
        }
    )
    context = _vault_client(store)
    config = AgentConfig(llm=LLMConfig(backend="none"))
    agent = Agent(config, context_client=context)
    if backend:
        agent._openai_backend = FakeBackend()  # type: ignore[assignment]
    client = TestClient(create_app(config, context_client=context, agent=agent))
    client.__enter__()
    if unlocked:
        assert (
            client.post("/unlock", json={"user_id": USER, "password": PASSWORD}).status_code == 204
        )
    return client


def _ask(scope: str = "personal/age", policy: str = "age-verification") -> dict[str, str]:
    return {"question": "how old am I?", "policy_name": policy, "context_scope": scope}


def test_ask_route_returns_answer_and_rule() -> None:
    resp = _client().post("/ask", json=_ask(), headers={"Origin": USER_APP})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["answer"] == "you are 36"
    assert body["rule_id"] == "rule-age"
    assert body["context_used"] == ["personal-context"]


def test_ask_route_403_on_identity_scope() -> None:
    resp = _client().post("/ask", json=_ask(scope="identity/authorizations"))
    assert resp.status_code == 403
    assert "identity" in resp.json()["detail"]


def test_ask_route_403_without_a_matching_rule() -> None:
    resp = _client().post("/ask", json=_ask(scope="personal/email"))
    assert resp.status_code == 403


def test_ask_route_503_without_backend() -> None:
    resp = _client(backend=False).post("/ask", json=_ask())
    assert resp.status_code == 503
    assert resp.json()["detail"] == "no model backend configured"


def test_ask_route_refuses_business_origin() -> None:
    resp = _client().post("/ask", json=_ask(), headers={"Origin": BUSINESS_APP})
    assert resp.status_code == 403


def test_ask_route_409_when_locked() -> None:
    resp = _client(unlocked=False).post("/ask", json=_ask())
    assert resp.status_code == 409


def test_ask_route_rejects_a_malformed_scope() -> None:
    resp = _client().post("/ask", json=_ask(scope="../root-identity"))
    assert resp.status_code == 422
