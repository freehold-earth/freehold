"""The browser apps call the agent cross-origin; only listed origins are answered."""

import pytest
from fastapi.testclient import TestClient

from freehold_agent.api import create_app
from freehold_agent.config import DEFAULT_CORS_ORIGINS, AgentConfig

PREFLIGHT = {
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "content-type",
}


def test_demo_app_origins_are_allowed_by_default() -> None:
    client = TestClient(create_app(AgentConfig()))
    for origin in DEFAULT_CORS_ORIGINS:
        resp = client.options("/unlock", headers={"Origin": origin, **PREFLIGHT})
        assert resp.status_code == 200, origin
        assert resp.headers["access-control-allow-origin"] == origin
    resp = client.get("/health", headers={"Origin": "https://localhost:4501"})
    assert resp.headers["access-control-allow-origin"] == "https://localhost:4501"


def test_other_origins_are_not() -> None:
    client = TestClient(create_app(AgentConfig()))
    resp = client.options("/unlock", headers={"Origin": "https://evil.example", **PREFLIGHT})
    assert resp.status_code == 400
    assert "access-control-allow-origin" not in resp.headers


def test_empty_env_counts_as_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FREEHOLD_CORS_ORIGINS", "")
    assert AgentConfig.from_env().cors_origins == list(DEFAULT_CORS_ORIGINS)


def test_origins_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FREEHOLD_CORS_ORIGINS", "https://app.example/, https://other.example,")
    config = AgentConfig.from_env()
    assert config.cors_origins == ["https://app.example", "https://other.example"]
    client = TestClient(create_app(config))
    resp = client.get("/health", headers={"Origin": "https://app.example"})
    assert resp.headers["access-control-allow-origin"] == "https://app.example"
    resp = client.get("/health", headers={"Origin": "https://localhost:4501"})
    assert "access-control-allow-origin" not in resp.headers


def test_wildcard_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FREEHOLD_CORS_ORIGINS", "*")
    with pytest.raises(ValueError, match="not accepted"):
        AgentConfig.from_env()
    with pytest.raises(ValueError, match="not accepted"):
        AgentConfig(cors_origins=["https://localhost:4501", "*"])
    with pytest.raises(ValueError, match="https://"):
        AgentConfig(cors_origins=["http://localhost:4501"])
    for not_an_origin in [
        "https://localhost:4501/app",
        "https://localhost:4501?x=1",
        "https://u@h",
    ]:
        with pytest.raises(ValueError, match="scheme and host only"):
            AgentConfig(cors_origins=[not_an_origin])
    assert AgentConfig(
        cors_origins=["https://LocalHost:4501/", "https://App.Example:443", "https://[::1]:3000"]
    ).cors_origins == ["https://localhost:4501", "https://app.example", "https://[::1]:3000"]
