"""POST /unlock and /lock: the app-owned context client and its secret."""

import httpx2
import pytest
from fastapi.testclient import TestClient

from freehold_agent.api import create_app
from freehold_agent.config import AgentConfig, ContextConfig
from freehold_agent.context import ContextClient
from freehold_agent.errors import ContextLocked
from tests.test_context import PASSWORD, USER, FakeStore

DEMO = {"personal-context": {"birthDate": "1990-05-15", "fullName": "Alice Demo"}}


def _client(store: FakeStore) -> ContextClient:
    http = httpx2.AsyncClient(
        base_url="http://store.test", transport=httpx2.MockTransport(store.handle)
    )
    return ContextClient(ContextConfig(endpoint="http://store.test"), client=http)


def test_unlock_then_lock_round_trip():
    context = _client(FakeStore(DEMO))
    app = create_app(AgentConfig(), context_client=context)
    with TestClient(app) as client:
        assert client.get("/health").json()["vault"] == "locked"

        resp = client.post("/unlock", json={"user_id": USER, "password": PASSWORD})
        assert resp.status_code == 204
        assert context.is_unlocked
        assert client.get("/health").json()["vault"] == "unlocked"

        assert client.post("/lock").status_code == 204
        assert not context.is_unlocked
        assert client.get("/health").json()["vault"] == "locked"


def test_wrong_password_is_401_and_not_held():
    context = _client(FakeStore(DEMO))
    with TestClient(create_app(AgentConfig(), context_client=context)) as client:
        resp = client.post("/unlock", json={"user_id": USER, "password": "nope"})
    assert resp.status_code == 401
    assert resp.json()["detail"] == "wrong password"
    assert not context.is_unlocked


def test_unreachable_store_is_503_with_the_cause():
    store = FakeStore(DEMO)
    store.unreachable = True
    with TestClient(create_app(AgentConfig(), context_client=_client(store))) as client:
        resp = client.post("/unlock", json={"user_id": USER, "password": PASSWORD})
    assert resp.status_code == 503
    assert resp.json()["detail"] == "context store unreachable"


def test_unlock_needs_both_fields():
    with TestClient(create_app(AgentConfig(), context_client=_client(FakeStore()))) as client:
        assert client.post("/unlock", json={"user_id": USER}).status_code == 422


async def test_shutdown_forgets_the_secret():
    context = _client(FakeStore(DEMO))
    with TestClient(create_app(AgentConfig(), context_client=context)) as client:
        client.post("/unlock", json={"user_id": USER, "password": PASSWORD})
        assert context.is_unlocked
    assert not context.is_unlocked
    with pytest.raises(ContextLocked):
        await context.entries("personal")
