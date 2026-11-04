import pytest

from freehold_agent.config import DEFAULT_CONTEXT_STORE_URL, AgentConfig


def test_default_endpoint_is_the_store_port(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("CONTEXT_STORE_URL", raising=False)
    assert AgentConfig().context.endpoint == DEFAULT_CONTEXT_STORE_URL
    assert AgentConfig.from_env().context.endpoint == DEFAULT_CONTEXT_STORE_URL


def test_endpoint_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CONTEXT_STORE_URL", "http://context-store:8081")
    assert AgentConfig.from_env().context.endpoint == "http://context-store:8081"


def test_empty_env_value_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CONTEXT_STORE_URL", "")
    assert AgentConfig.from_env().context.endpoint == DEFAULT_CONTEXT_STORE_URL
