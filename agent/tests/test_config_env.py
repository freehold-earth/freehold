"""The one set of environment variables the agent reads, and what it refuses."""

import re
from pathlib import Path

import pytest

from freehold_agent.config import (
    DEFAULT_CARDANO_URL,
    DEFAULT_LLM_URL,
    DEFAULT_ZKP_URL,
    RETIRED_ENV_NAMES,
    AgentConfig,
    LLMConfig,
    trust_store,
)
from freehold_agent.custody import Operator


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
    with pytest.raises(ValueError, match="http, ollama, llamacpp or none"):
        AgentConfig.from_env()


def test_the_server_and_services_are_read_from_freehold_names(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FREEHOLD_HOST", "0.0.0.0")
    monkeypatch.setenv("FREEHOLD_PORT", "9000")
    monkeypatch.setenv("FREEHOLD_ZKP_URL", "https://zkp:8084")
    monkeypatch.setenv("FREEHOLD_CARDANO_URL", "https://cardano:8080")
    monkeypatch.setenv("FREEHOLD_CA_FILE", "/run/secrets/ca_cert")
    monkeypatch.setenv("FREEHOLD_TLS_CERT_FILE", "/run/secrets/agent_cert")
    monkeypatch.setenv("FREEHOLD_TLS_KEY_FILE", "/run/secrets/agent_key")
    cfg = AgentConfig.from_env()
    assert (cfg.host, cfg.port, cfg.zkp_url, cfg.cardano_url) == (
        "0.0.0.0",
        9000,
        "https://zkp:8084",
        "https://cardano:8080",
    )
    assert (cfg.ca_file, cfg.tls_cert_file, cfg.tls_key_file) == (
        "/run/secrets/ca_cert",
        "/run/secrets/agent_cert",
        "/run/secrets/agent_key",
    )


@pytest.mark.parametrize(
    "name", ["FREEHOLD_CONTEXT_STORE_URL", "FREEHOLD_ZKP_URL", "FREEHOLD_CARDANO_URL"]
)
def test_a_plain_http_service_is_refused(monkeypatch: pytest.MonkeyPatch, name: str) -> None:
    monkeypatch.setenv(name, "http://service.internal:8000")
    with pytest.raises(ValueError, match="https://"):
        AgentConfig.from_env()


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


def test_bare_host_and_port_are_ignored(monkeypatch: pytest.MonkeyPatch) -> None:
    """Shells and platforms set HOST and PORT on their own; the agent reads neither."""
    monkeypatch.setenv("HOST", "box")
    monkeypatch.setenv("PORT", "3000")
    cfg = AgentConfig.from_env()
    assert (cfg.host, cfg.port) == ("127.0.0.1", 8082)


def test_a_cleared_retired_name_counts_as_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CONTEXT_STORE_URL", "")
    AgentConfig.from_env()


def test_an_empty_ca_file_means_the_system_store() -> None:
    assert AgentConfig(ca_file="").ca_file is None
    assert AgentConfig(ca_file="").trust_store() is True
    assert trust_store(None) is True
    assert trust_store("") is True


def test_the_certificate_and_key_come_together(monkeypatch: pytest.MonkeyPatch) -> None:
    with pytest.raises(ValueError, match="set together"):
        AgentConfig(tls_cert_file="/run/secrets/agent_cert")
    monkeypatch.setenv("FREEHOLD_TLS_KEY_FILE", "/run/secrets/agent_key")
    with pytest.raises(ValueError, match="FREEHOLD_TLS_CERT_FILE"):
        AgentConfig.from_env()


def test_the_in_process_loader_holds_no_server_address() -> None:
    assert LLMConfig(backend="llamacpp", url="https://stale.example/v1").url is None


def test_a_wildcard_inside_an_origin_is_refused() -> None:
    with pytest.raises(ValueError, match="'\\*' is not accepted"):
        AgentConfig(cors_origins=["https://*.example"])


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
    monkeypatch.setenv("FREEHOLD_LLM_CUSTODY", "owned_hardware")
    with pytest.raises(ValueError, match="https://"):
        AgentConfig.from_env()
    with pytest.raises(ValueError, match="https://"):
        LLMConfig(backend=backend, url="http://model.internal/v1", custody="owned_hardware")  # type: ignore[arg-type]


def test_ollama_needs_an_address_because_it_has_no_tls_of_its_own(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FREEHOLD_LLM_BACKEND", "ollama")
    monkeypatch.delenv("FREEHOLD_LLM_URL", raising=False)
    with pytest.raises(ValueError, match="TLS proxy"):
        AgentConfig.from_env()


def test_a_retired_field_is_refused_rather_than_dropped() -> None:
    with pytest.raises(ValueError, match="model_path"):
        LLMConfig(backend="llamacpp", model_path="/models/q.gguf")  # type: ignore[call-arg]


def test_a_scheme_in_any_case_is_accepted_and_lowered() -> None:
    assert (
        LLMConfig(backend="http", url="HTTPS://Model.internal/v1", custody="owned_hardware").url
        == "https://Model.internal/v1"
    )


def test_the_in_process_loader_takes_its_file_from_the_model_field() -> None:
    cfg = LLMConfig(backend="llamacpp", model="/models/q.gguf")
    assert cfg.model_path == "/models/q.gguf"
    assert LLMConfig(backend="http", model="served-name").model_path is None


def test_backend_none_is_accepted_and_has_no_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FREEHOLD_LLM_BACKEND", "none")
    config = AgentConfig.from_env()
    assert config.llm.backend == "none"
    assert config.llm.url is None


def test_backend_env_error_names_none(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FREEHOLD_LLM_BACKEND", "cloud")
    with pytest.raises(ValueError, match="none"):
        AgentConfig.from_env()


def test_holder_origins_default_to_the_user_apps_origins() -> None:
    config = AgentConfig()
    assert config.holder_origins == ["https://localhost:4501", "https://localhost:3000"]


def test_holder_origins_are_canonicalised_and_must_be_allowed() -> None:
    config = AgentConfig(
        cors_origins=["https://holder.example", "https://biz.example"],
        holder_origins=["https://Holder.example:443"],
    )
    assert config.holder_origins == ["https://holder.example"]
    with pytest.raises(ValueError, match="holder_origins"):
        AgentConfig(
            cors_origins=["https://holder.example"], holder_origins=["https://other.example"]
        )


def test_a_custom_allowlist_without_holder_origins_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FREEHOLD_CORS_ORIGINS", "https://biz.example,https://holder.example")
    assert AgentConfig.from_env().holder_origins == []


def test_holder_origins_come_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FREEHOLD_CORS_ORIGINS", "https://biz.example,https://holder.example")
    monkeypatch.setenv("FREEHOLD_HOLDER_ORIGINS", "https://Holder.example:443")
    assert AgentConfig.from_env().holder_origins == ["https://holder.example"]
    monkeypatch.setenv("FREEHOLD_HOLDER_ORIGINS", "https://other.example")
    with pytest.raises(ValueError, match="holder_origins"):
        AgentConfig.from_env()


def test_custody_settings_default_to_the_holders_own_hardware() -> None:
    """The model server and the proof service ship in the holder's stack."""
    config = AgentConfig()
    assert config.llm.custody is Operator.OWNED_HARDWARE
    assert config.zkp_custody is Operator.OWNED_HARDWARE


def test_custody_settings_come_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FREEHOLD_LLM_CUSTODY", "federated_operator")
    monkeypatch.setenv("FREEHOLD_ZKP_CUSTODY", "device_only")
    config = AgentConfig.from_env()
    assert config.llm.custody is Operator.FEDERATED_OPERATOR
    assert config.zkp_custody is Operator.DEVICE_ONLY


@pytest.mark.parametrize("name", ["FREEHOLD_LLM_CUSTODY", "FREEHOLD_ZKP_CUSTODY"])
def test_an_unknown_custody_value_is_refused_naming_the_ladder(
    monkeypatch: pytest.MonkeyPatch, name: str
) -> None:
    monkeypatch.setenv(name, "cloud")
    with pytest.raises(ValueError, match="device_only.*any"):
        AgentConfig.from_env()


def test_the_audit_log_defaults_to_a_file_beside_the_agent() -> None:
    config = AgentConfig()
    assert config.audit_log == "freehold-audit.jsonl"
    assert not hasattr(config, "audit_logging")


def test_the_audit_log_path_comes_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FREEHOLD_AUDIT_LOG", "/data/model-calls.jsonl")
    assert AgentConfig.from_env().audit_log == "/data/model-calls.jsonl"


def test_the_audit_log_can_be_switched_off(monkeypatch: pytest.MonkeyPatch) -> None:
    """``off`` is the one word that disables it; a path is never mistaken for a switch."""
    monkeypatch.setenv("FREEHOLD_AUDIT_LOG", "off")
    assert AgentConfig.from_env().audit_log is None


def _env_example_block(title: str) -> dict[str, str]:
    """The settings under one titled block of demo/.env.example, as uncommenting them would set.

    Args:
        title: The block's ``## `` heading.

    Returns:
        The ``FREEHOLD_*`` names and values of the block's commented-out assignments.
    """
    path = Path(__file__).resolve().parents[2] / "demo" / ".env.example"
    if not path.exists():
        pytest.skip("the demo's .env.example is not beside this package")
    block: dict[str, str] = {}
    inside = False
    for line in path.read_text().splitlines():
        if line.startswith("## "):
            inside = line[3:].strip() == title
            continue
        if inside and (m := re.fullmatch(r"# (FREEHOLD_\w+)=(.*)", line)):
            block[m.group(1)] = m.group(2).strip()
    return block


def _demo_compose_agent_env_names() -> set[str]:
    """The environment names the demo compose file passes to the agent service."""
    path = Path(__file__).resolve().parents[2] / "demo" / "docker-compose.yml"
    if not path.exists():
        pytest.skip("the demo compose file is not beside this package")
    names: set[str] = set()
    inside_agent = inside_env = False
    for line in path.read_text().splitlines():
        if re.match(r"^  \S", line):
            inside_agent = line.startswith("  agent:")
            inside_env = False
        elif inside_agent and line.strip() == "environment:":
            inside_env = True
        elif inside_agent and inside_env and (m := re.match(r"^      - (FREEHOLD_\w+)", line)):
            names.add(m.group(1))
        elif inside_agent and inside_env and re.match(r"^    \S", line):
            inside_env = False
    return names


def test_the_demo_env_example_operator_block_builds_the_operator_config(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """What the demo README tells the holder to set is what the agent reads and the stack passes."""
    block = _env_example_block("Model at a federated operator")
    assert set(block) == {
        "FREEHOLD_LLM_CUSTODY",
        "FREEHOLD_LLM_BACKEND",
        "FREEHOLD_LLM_URL",
        "FREEHOLD_LLM_API_KEY",
        "FREEHOLD_LLM_MODEL",
    }
    assert set(block) <= _demo_compose_agent_env_names()
    for name, value in block.items():
        monkeypatch.setenv(name, value.replace("<gateway>", "gateway.example"))
    config = AgentConfig.from_env()
    assert config.llm.backend == "http"
    assert config.llm.url == "https://gateway.example/v1"
    assert config.llm.api_key == block["FREEHOLD_LLM_API_KEY"]
    assert config.llm.model == block["FREEHOLD_LLM_MODEL"]
    assert config.llm.custody is Operator.FEDERATED_OPERATOR


def test_naming_a_model_server_without_its_custody_rung_is_refused(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A named server with no rung would be treated as the holder's own hardware, the unsafe way."""
    monkeypatch.setenv("FREEHOLD_LLM_URL", "https://gateway.example/v1")
    with pytest.raises(ValueError, match="FREEHOLD_LLM_CUSTODY"):
        AgentConfig.from_env()
    monkeypatch.setenv("FREEHOLD_LLM_CUSTODY", "owned_hardware")
    assert AgentConfig.from_env().llm.custody is Operator.OWNED_HARDWARE


def test_the_default_model_server_keeps_the_default_rung() -> None:
    """No address named means the agent's own default server, which is the holder's."""
    from freehold_agent.config import DEFAULT_LLM_URL

    config = AgentConfig.from_env()
    assert config.llm.url == DEFAULT_LLM_URL
    assert config.llm.custody is Operator.OWNED_HARDWARE


def test_the_model_itself_refuses_a_named_server_without_its_rung() -> None:
    """The invariant lives on the model, not only in the environment loader."""
    with pytest.raises(ValueError, match="custody"):
        LLMConfig(backend="http", url="https://gateway.example/v1")
    config = LLMConfig(
        backend="http", url="https://gateway.example/v1", custody="federated_operator"
    )
    assert config.custody is Operator.FEDERATED_OPERATOR
    assert LLMConfig(backend="http").custody is Operator.OWNED_HARDWARE


@pytest.mark.parametrize(
    "fields",
    [
        {"url": "https://gateway.example/v1", "custody": "federated_operator"},
        {"api_key": "k"},
        {"model": "m"},
    ],
)
def test_no_backend_with_a_server_named_is_refused(fields: dict[str, str]) -> None:
    """Settings for a server that will never be used are a mistake, not a silent no-op."""
    with pytest.raises(ValueError, match="none"):
        LLMConfig(backend="none", **fields)  # type: ignore[arg-type]


def test_a_model_server_address_needs_a_host() -> None:
    with pytest.raises(ValueError, match="host"):
        LLMConfig(backend="http", url="https:///v1", custody="owned_hardware")
