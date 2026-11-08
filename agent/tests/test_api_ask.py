"""POST /ask: the holder asks their agent about their own data, under one of their policies."""

from __future__ import annotations

from fastapi.testclient import TestClient

from freehold_agent import Agent
from freehold_agent.api import create_app
from freehold_agent.config import AgentConfig, LLMConfig
from freehold_agent.custody import Operator
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
    resp = _client().post(
        "/ask", json=_ask(scope="identity/authorizations"), headers={"Origin": USER_APP}
    )
    assert resp.status_code == 403
    assert "identity" in resp.json()["detail"]


def test_ask_route_403_without_a_matching_rule() -> None:
    resp = _client().post("/ask", json=_ask(scope="personal/notes"), headers={"Origin": USER_APP})
    assert resp.status_code == 403


def test_ask_route_503_without_backend() -> None:
    resp = _client(backend=False).post("/ask", json=_ask(), headers={"Origin": USER_APP})
    assert resp.status_code == 503
    assert resp.json()["detail"] == "no model backend configured"


def test_ask_route_refuses_a_request_with_no_origin() -> None:
    """Only the holder's page asks; a non-browser caller has no Origin and is refused."""
    resp = _client().post("/ask", json=_ask())
    assert resp.status_code == 403


def test_ask_route_refuses_business_origin() -> None:
    resp = _client().post("/ask", json=_ask(), headers={"Origin": BUSINESS_APP})
    assert resp.status_code == 403


def test_ask_route_409_when_locked() -> None:
    resp = _client(unlocked=False).post("/ask", json=_ask(), headers={"Origin": USER_APP})
    assert resp.status_code == 409


def test_ask_route_rejects_a_malformed_scope() -> None:
    resp = _client().post("/ask", json=_ask(scope="../root-identity"), headers={"Origin": USER_APP})
    assert resp.status_code == 422


def test_ask_route_answers_the_dev_server_origin_too() -> None:
    """The user app runs at 4501 in compose and 3000 under vite dev; both are the holder's."""
    resp = _client().post("/ask", json=_ask(), headers={"Origin": "https://localhost:3000"})
    assert resp.status_code == 200, resp.text


def test_ask_about_health_is_refused_when_the_model_is_at_a_federated_operator() -> None:
    """The seed allows age at a federated operator; its health rule says nothing: health stays."""

    store = FakeStore(
        {
            "root-identity": SEED_ROOT_IDENTITY,
            SEED_KEY: SEED_POLICY,
            "personal-context": {"birthDate": "1990-05-15"},
        }
    )
    context = _vault_client(store)
    config = AgentConfig(llm=LLMConfig(backend="none", custody=Operator.FEDERATED_OPERATOR))
    agent = Agent(config, context_client=context)
    agent._openai_backend = FakeBackend()  # type: ignore[assignment]
    client = TestClient(create_app(config, context_client=context, agent=agent))
    client.__enter__()
    assert client.post("/unlock", json={"user_id": USER, "password": PASSWORD}).status_code == 204
    allowed = client.post("/ask", json=_ask(scope="personal/age"), headers={"Origin": USER_APP})
    assert allowed.status_code == 200, allowed.text
    refused = client.post("/ask", json=_ask(scope="health/allergies"), headers={"Origin": USER_APP})
    assert refused.status_code == 403
    assert "custody" in refused.json()["detail"]
    assert "owned_hardware" in refused.json()["detail"]


def test_ask_route_returns_the_audit_id_of_the_record_written_before_the_call() -> None:
    body = _client().post("/ask", json=_ask(), headers={"Origin": USER_APP}).json()
    assert isinstance(body["audit_id"], str) and len(body["audit_id"]) == 32


def test_ask_route_is_503_when_the_record_cannot_be_written() -> None:
    from freehold_agent.errors import AuditUnavailable

    class FailingSink:
        async def record(self, record: object) -> None:
            raise AuditUnavailable("the audit log at /x cannot be written: disk full")

    store = FakeStore(
        {
            "root-identity": SEED_ROOT_IDENTITY,
            SEED_KEY: SEED_POLICY,
            "personal-context": {"birthDate": "1990-05-15"},
        }
    )
    context = _vault_client(store)
    config = AgentConfig(llm=LLMConfig(backend="none"))
    backend = FakeBackend()
    agent = Agent(config, context_client=context, audit=FailingSink())
    agent._openai_backend = backend  # type: ignore[assignment]
    client = TestClient(create_app(config, context_client=context, agent=agent))
    client.__enter__()
    assert client.post("/unlock", json={"user_id": USER, "password": PASSWORD}).status_code == 204
    resp = client.post("/ask", json=_ask(), headers={"Origin": USER_APP})
    assert resp.status_code == 503
    assert "record" in resp.json()["detail"]
    assert backend.prompts == []
