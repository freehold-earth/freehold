"""
Agent configuration.

The pydantic models are the source of truth, and :meth:`AgentConfig.from_env`
is the one place the environment is read: every variable is a ``FREEHOLD_*``
one, listed in the agent README.
"""

from __future__ import annotations

import math
import os
from typing import Literal, cast

from pydantic import BaseModel, Field, field_validator, model_validator

from freehold_agent.coordination import ApprovalMode

Backend = Literal["http", "ollama", "llamacpp"]

# Where llama-server listens out of the box, over the TLS the stack gives it;
# the HTTP backend's default and the one place this URL is written.
DEFAULT_LLM_URL = "https://127.0.0.1:8080/v1"


def _parse_env_timeout(var_name: str, default: float) -> float:
    """Parse a per-request timeout env var, rejecting non-finite values.

    A non-finite timeout (e.g. ``inf``) disables the httpx2 deadline, so it is
    rejected here rather than silently dropped. Non-positive values are left
    for the pydantic ``Field`` guard to reject with its own message.
    """
    raw = os.environ.get(var_name)
    if raw is None:
        return default
    try:
        value = float(raw)
    except ValueError as exc:
        raise ValueError(f"{var_name} must be a float value") from exc
    if not math.isfinite(value):
        raise ValueError(f"{var_name} must be a finite value")
    return value


def require_https(url: str, what: str) -> str:
    """The URL, if it is an ``https://`` one; a plain-HTTP one is refused.

    Prompts, context and the bearer token travel over the model-server link,
    so it is encrypted wherever it runs, loopback included: a certificate is
    cheap, and an exception for "local" links is how a remote one ends up
    in cleartext.

    Args:
        url: The address to check.
        what: How the error names the address, e.g. the setting it came from.

    Returns:
        ``url`` unchanged.

    Raises:
        ValueError: If ``url`` does not start with ``https://``.
    """
    if not url.lower().startswith("https://"):
        raise ValueError(
            f"{what} must be an https:// address, got {url!r}: the agent sends prompts "
            "and its token over this link and does not send them in cleartext"
        )
    return url


class LLMConfig(BaseModel):
    """Configuration for the local language model.

    ``backend`` selects between an HTTP server speaking the chat-completions
    protocol (the default, pointed at a local ``llama-server``), the Ollama
    HTTP daemon, and the in-process ``llama-cpp-python`` GGUF loader. The
    llama.cpp family is the default because it makes no outbound calls
    (ADR-006); Ollama is opted into explicitly. The in-process loader is the
    single-executable fallback and loads nothing until ``model`` names a
    GGUF file.

    One set of fields serves every backend: ``url`` is where the HTTP
    backends reach their server (always ``https://``), ``model`` is the model
    name or tag they ask for, or the GGUF path the in-process loader opens,
    ``tier`` picks a named model when ``model`` is unset, ``api_key`` is sent
    as a bearer token, and ``ca_file`` is a certificate to trust beyond the
    system store, for a server with its own.
    """

    backend: Backend = "http"
    url: str | None = None
    model: str | None = None
    tier: str = "default"
    api_key: str | None = None
    ca_file: str | None = None
    timeout_seconds: float = Field(default=120.0, gt=0.0, allow_inf_nan=False)

    # --- Shared knobs -------------------------------------------------
    context_length: int = Field(default=4096, ge=512, le=1_000_000)
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    max_tokens: int = Field(default=512, ge=1, le=8192)
    n_gpu_layers: int = Field(default=0, ge=0)
    n_threads: int | None = None

    @model_validator(mode="after")
    def _url_for_the_backend(self) -> LLMConfig:
        """The one place the URL rule lives: the http backend defaults to llama-server's
        address, the ollama backend must be given one, both must be https://, and the
        in-process loader uses none."""
        if self.backend == "http":
            self.url = require_https(self.url or DEFAULT_LLM_URL, "url (FREEHOLD_LLM_URL)")
        elif self.backend == "ollama":
            if not self.url:
                raise ValueError(
                    "url (FREEHOLD_LLM_URL) is required for the ollama backend: Ollama serves "
                    "plain HTTP only, so put a TLS proxy in front of it and give its https:// "
                    "address"
                )
            self.url = require_https(self.url, "url (FREEHOLD_LLM_URL)")
        return self

    @property
    def model_path(self) -> str | None:
        """The GGUF file the in-process loader opens; ``model`` under that backend."""
        return self.model if self.backend == "llamacpp" else None


DEFAULT_CONTEXT_STORE_URL = "http://localhost:8081"

DEFAULT_CORS_ORIGINS = (
    "http://localhost:4501",  # demo user app, compose.
    "http://localhost:4502",  # demo business app, compose.
    "http://localhost:3000",  # demo user app, vite dev.
    "http://localhost:3001",  # demo business app, vite dev.
)
"""Browser origins the coordination API answers. The demo apps call it from
their own origins, which a browser only allows when the API says so."""


class ContextConfig(BaseModel):
    """Where the user's context store listens.

    The store is a zero-knowledge blob server (``context-store/src/server.ts``);
    the agent decrypts what it reads, so this is only a network location.
    """

    endpoint: str = DEFAULT_CONTEXT_STORE_URL
    timeout_seconds: float = 30.0


class ApprovalConfig(BaseModel):
    """Autonomous-approval behavior."""

    mode: ApprovalMode = ApprovalMode.MANUAL


DEFAULT_ZKP_URL = "http://localhost:8084"
DEFAULT_CARDANO_URL = "http://localhost:8080"

# Names the agent used to read, each with the one that replaced it. An old
# name in the environment is refused rather than ignored, so a deployment
# that still sets it finds out at startup instead of running on defaults.
RETIRED_ENV_NAMES = {
    "FREEHOLD_OPENAI_BASE_URL": "FREEHOLD_LLM_URL",
    "FREEHOLD_OPENAI_MODEL": "FREEHOLD_LLM_MODEL",
    "FREEHOLD_OPENAI_API_KEY": "FREEHOLD_LLM_API_KEY",
    "FREEHOLD_OPENAI_TIMEOUT": "FREEHOLD_LLM_TIMEOUT",
    "FREEHOLD_OLLAMA_URL": "FREEHOLD_LLM_URL",
    "FREEHOLD_OLLAMA_MODEL": "FREEHOLD_LLM_MODEL",
    "FREEHOLD_OLLAMA_TIMEOUT": "FREEHOLD_LLM_TIMEOUT",
    "FREEHOLD_LLM_MODEL_PATH": "FREEHOLD_LLM_MODEL",
    "CONTEXT_STORE_URL": "FREEHOLD_CONTEXT_STORE_URL",
    "ZKP_SERVICE_URL": "FREEHOLD_ZKP_URL",
    "CARDANO_API_URL": "FREEHOLD_CARDANO_URL",
    "HOST": "FREEHOLD_HOST",
    "PORT": "FREEHOLD_PORT",
}


def _env(name: str) -> str | None:
    """The variable's value, with an empty one counting as unset, as a cleared export leaves it."""
    return os.environ.get(name) or None


def _refuse_retired_names() -> None:
    for retired, replacement in RETIRED_ENV_NAMES.items():
        if os.environ.get(retired) is not None:
            raise ValueError(f"{retired} is no longer read; set {replacement} instead")


def _backend_from_env() -> Backend:
    value = _env("FREEHOLD_LLM_BACKEND")
    if value is None:
        return "http"
    if value == "openai":
        raise ValueError("FREEHOLD_LLM_BACKEND=openai is now FREEHOLD_LLM_BACKEND=http")
    if value not in ("http", "ollama", "llamacpp"):
        raise ValueError(f"FREEHOLD_LLM_BACKEND must be http, ollama or llamacpp, got {value!r}")
    return cast(Backend, value)


def _approval_mode_from_env() -> ApprovalMode:
    value = _env("FREEHOLD_APPROVAL_MODE")
    if value is None:
        return ApprovalMode.MANUAL
    if value not in tuple(ApprovalMode):
        known = ", ".join(m.value for m in ApprovalMode)
        raise ValueError(f"FREEHOLD_APPROVAL_MODE must be one of {known}, got {value!r}")
    return ApprovalMode(value)


def _cors_origins_from_env() -> list[str]:
    """Browser origins as a comma-separated list, trailing slashes dropped as a browser's
    Origin header has none."""
    value = _env("FREEHOLD_CORS_ORIGINS")
    if value is None:
        return list(DEFAULT_CORS_ORIGINS)
    return [o.strip().rstrip("/") for o in value.split(",") if o.strip()]


def _port_from_env() -> int:
    value = _env("FREEHOLD_PORT")
    if value is None:
        return 8082
    try:
        return int(value)
    except ValueError as exc:
        raise ValueError("FREEHOLD_PORT must be an integer") from exc


class AgentConfig(BaseModel):
    """Main agent configuration"""

    llm: LLMConfig = Field(default_factory=LLMConfig)
    context: ContextConfig = Field(default_factory=ContextConfig)
    approval: ApprovalConfig = Field(default_factory=ApprovalConfig)

    # Where the coordination API listens; loopback unless deployment says otherwise.
    host: str = "127.0.0.1"
    port: int = Field(default=8082, ge=1, le=65535)

    # The services the agent coordinates.
    zkp_url: str = DEFAULT_ZKP_URL
    cardano_url: str = DEFAULT_CARDANO_URL

    # Agent behavior
    max_context_items: int = Field(default=10, ge=1, le=100)
    audit_logging: bool = True

    # Browser origins allowed to call the coordination API; never a wildcard.
    cors_origins: list[str] = Field(default_factory=lambda: list(DEFAULT_CORS_ORIGINS))

    @field_validator("cors_origins")
    @classmethod
    def _no_wildcard(cls, origins: list[str]) -> list[str]:
        if "*" in origins:
            raise ValueError("cors_origins must list origins; '*' is not accepted")
        return origins

    @classmethod
    def from_env(cls) -> AgentConfig:
        """Build an :class:`AgentConfig` from the environment.

        Every variable the agent reads is a ``FREEHOLD_*`` one: ``FREEHOLD_HOST``
        and ``FREEHOLD_PORT`` for the API, ``FREEHOLD_CONTEXT_STORE_URL``,
        ``FREEHOLD_ZKP_URL`` and ``FREEHOLD_CARDANO_URL`` for the services it
        coordinates, ``FREEHOLD_LLM_*`` for the model, ``FREEHOLD_APPROVAL_MODE``
        and ``FREEHOLD_CORS_ORIGINS``. Unset or empty variables fall back to
        the model defaults.

        Raises:
            ValueError: If a retired name is set (the message names its
                replacement), if ``FREEHOLD_LLM_BACKEND``,
                ``FREEHOLD_APPROVAL_MODE``, ``FREEHOLD_PORT`` or
                ``FREEHOLD_LLM_TIMEOUT`` holds a value outside its set, or if
                the model server's address is not ``https://`` (or is missing
                for the ollama backend).
        """
        _refuse_retired_names()
        return cls(
            llm=LLMConfig(
                backend=_backend_from_env(),
                url=_env("FREEHOLD_LLM_URL"),
                model=_env("FREEHOLD_LLM_MODEL"),
                tier=_env("FREEHOLD_LLM_TIER") or "default",
                api_key=_env("FREEHOLD_LLM_API_KEY"),
                ca_file=_env("FREEHOLD_LLM_CA_FILE"),
                timeout_seconds=_parse_env_timeout("FREEHOLD_LLM_TIMEOUT", 120.0),
            ),
            context=ContextConfig(
                endpoint=_env("FREEHOLD_CONTEXT_STORE_URL") or DEFAULT_CONTEXT_STORE_URL
            ),
            approval=ApprovalConfig(mode=_approval_mode_from_env()),
            host=_env("FREEHOLD_HOST") or "127.0.0.1",
            port=_port_from_env(),
            zkp_url=_env("FREEHOLD_ZKP_URL") or DEFAULT_ZKP_URL,
            cardano_url=_env("FREEHOLD_CARDANO_URL") or DEFAULT_CARDANO_URL,
            cors_origins=_cors_origins_from_env(),
        )
