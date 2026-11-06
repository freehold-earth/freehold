"""The one set of environment variables the agent reads, and what it refuses."""

import pytest

from freehold_agent.config import (
    DEFAULT_CARDANO_URL,
    DEFAULT_LLM_URL,
    DEFAULT_ZKP_URL,
    RETIRED_ENV_NAMES,
    AgentConfig,
    LLMConfig,
)


@pytest.mark.parametrize(("retired", "replacement"), sorted(RETIRED_ENV_NAMES.items()))
def test_a_retired_name_is_refused_with_the_name_that_replaced_it(
    monkeypatch: pytest.MonkeyPatch, retired: str, replacement: str
) -> None:
    monkeypatch.setenv(retired, "anything")
    with pytest.raises(ValueError, match=f"{retired} is no longer read; set {replacement}"):
        AgentConfig.from_env()


def test_the_old_backend_name_is_refused_with_the_new_one(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FREEHOLD_LLM_BACKEND", "openai")
    with pytest.raises(ValueError, match="FREEHOLD_LLM_BACKEND=http"):
        AgentConfig.from_env()
    monkeypatch.setenv("FREEHOLD_LLM_BACKEND", "cloud")
    with pytest.raises(ValueError, match="http, ollama or llamacpp"):
        AgentConfig.from_env()


def test_the_server_and_services_are_read_from_freehold_names(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FREEHOLD_HOST", "0.0.0.0")
    monkeypatch.setenv("FREEHOLD_PORT", "9000")
    monkeypatch.setenv("FREEHOLD_ZKP_URL", "http://zkp:8084")
    monkeypatch.setenv("FREEHOLD_CARDANO_URL", "http://cardano:8080")
    cfg = AgentConfig.from_env()
    assert (cfg.host, cfg.port, cfg.zkp_url, cfg.cardano_url) == (
        "0.0.0.0",
        9000,
        "http://zkp:8084",
        "http://cardano:8080",
    )


def test_defaults_when_nothing_is_set(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in (
        "FREEHOLD_HOST",
        "FREEHOLD_PORT",
        "FREEHOLD_ZKP_URL",
        "FREEHOLD_CARDANO_URL",
        "FREEHOLD_LLM_URL",
    ):
        monkeypatch.delenv(name, raising=False)
    cfg = AgentConfig.from_env()
    assert (cfg.host, cfg.port) == ("127.0.0.1", 8082)
    assert (cfg.zkp_url, cfg.cardano_url) == (DEFAULT_ZKP_URL, DEFAULT_CARDANO_URL)
    assert cfg.llm.url == DEFAULT_LLM_URL


def test_an_approval_mode_outside_the_set_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FREEHOLD_APPROVAL_MODE", "automatic")
    with pytest.raises(ValueError, match="FREEHOLD_APPROVAL_MODE must be one of"):
        AgentConfig.from_env()


def test_host_and_port_are_tolerated_beside_their_replacements(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Shells and platforms set HOST and PORT on their own."""
    monkeypatch.setenv("HOST", "box")
    monkeypatch.setenv("PORT", "3000")
    monkeypatch.setenv("FREEHOLD_HOST", "0.0.0.0")
    monkeypatch.setenv("FREEHOLD_PORT", "9000")
    cfg = AgentConfig.from_env()
    assert (cfg.host, cfg.port) == ("0.0.0.0", 9000)


def test_an_unknown_tier_is_refused_when_configuration_loads(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FREEHOLD_LLM_TIER", "gigantic")
    with pytest.raises(ValueError, match="Unknown LLM tier"):
        AgentConfig.from_env()
    with pytest.raises(ValueError, match="Unknown LLM tier"):
        LLMConfig(tier="gigantic")


def test_an_empty_timeout_counts_as_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FREEHOLD_LLM_TIMEOUT", "")
    assert AgentConfig.from_env().llm.timeout_seconds == LLMConfig().timeout_seconds
    monkeypatch.setenv("FREEHOLD_LLM_TIMEOUT", "30")
    assert AgentConfig.from_env().llm.timeout_seconds == 30.0


def test_a_port_that_is_not_a_number_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FREEHOLD_PORT", "eighty")
    with pytest.raises(ValueError, match="FREEHOLD_PORT"):
        AgentConfig.from_env()


@pytest.mark.parametrize("backend", ["http", "ollama"])
def test_a_plain_http_model_server_is_refused(
    monkeypatch: pytest.MonkeyPatch, backend: str
) -> None:
    monkeypatch.setenv("FREEHOLD_LLM_BACKEND", backend)
    monkeypatch.setenv("FREEHOLD_LLM_URL", "http://127.0.0.1:8080/v1")
    with pytest.raises(ValueError, match="https://"):
        AgentConfig.from_env()
    with pytest.raises(ValueError, match="https://"):
        LLMConfig(backend=backend, url="http://model.internal/v1")  # type: ignore[arg-type]


def test_ollama_needs_an_address_because_it_has_no_tls_of_its_own(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FREEHOLD_LLM_BACKEND", "ollama")
    monkeypatch.delenv("FREEHOLD_LLM_URL", raising=False)
    with pytest.raises(ValueError, match="TLS proxy"):
        AgentConfig.from_env()


def test_the_in_process_loader_takes_its_file_from_the_model_field() -> None:
    cfg = LLMConfig(backend="llamacpp", model="/models/q.gguf")
    assert cfg.model_path == "/models/q.gguf"
    assert LLMConfig(backend="http", model="served-name").model_path is None
