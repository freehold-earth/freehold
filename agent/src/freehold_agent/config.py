"""
Agent configuration.

The pydantic models are the source of truth, and :meth:`AgentConfig.from_env`
is the one place the environment is read: every variable is a ``FREEHOLD_*``
one, listed in the agent README.
"""

from __future__ import annotations

import math
import os
import ssl
from typing import Literal, cast, get_args
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from freehold_agent.coordination import ApprovalMode
from freehold_agent.custody import Operator

Backend = Literal["http", "ollama", "llamacpp", "none"]

# Where llama-server listens out of the box, over the TLS the stack gives it;
# the HTTP backend's default and the one place this URL is written.
DEFAULT_LLM_URL = "https://127.0.0.1:8080/v1"

# Named model tiers.
#
# freehold-agent targets desktop and server runtimes (see ADR-006 in docs/decisions).
# A dedicated on-device / mobile tier is deferred: stock Ollama's bundled
# llama.cpp does not yet load the Q1_0 quantisation that on-device models
# such as Bonsai-27B ship in (upstream: ollama/ollama#15359), and the mobile
# story lives in a separate native client rather than in this package.
MODEL_TIERS: dict[str, str] = {
    "default": "qwen3.6:27b",
    "small": "phi4-mini:3.8b",
}
DEFAULT_TIER = "default"


def resolve_model_for_tier(tier: str) -> str:
    """Return the model name or tag a named tier asks for.

    Raises ``ValueError`` on an unknown tier so misconfiguration surfaces at
    startup rather than at first inference request.
    """
    try:
        return MODEL_TIERS[tier]
    except KeyError as exc:
        known = ", ".join(sorted(MODEL_TIERS))
        raise ValueError(f"Unknown LLM tier '{tier}' — known tiers: {known}") from exc


def _parse_env_timeout(var_name: str, default: float) -> float:
    """Parse a per-request timeout env var, rejecting non-finite values.

    A non-finite timeout (e.g. ``inf``) disables the httpx2 deadline, so it is
    rejected here rather than silently dropped. Non-positive values are left
    for the pydantic ``Field`` guard to reject with its own message.
    """
    raw = os.environ.get(var_name) or None
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
    """The URL with its scheme in lower case, if it is an ``https://`` one; else refused.

    Every link the agent has carries a secret: prompts and the bearer token
    to the model server, the vault password to the context store, proofs to
    and from the ZKP service. So each is encrypted wherever it runs, loopback
    included: a certificate is cheap, and an exception for "local" links is
    how a remote one ends up in cleartext.

    Args:
        url: The address to check.
        what: How the error names the address, e.g. the setting it came from.

    Returns:
        ``url`` with the scheme as ``https://``, since a scheme is not case
        sensitive but later comparisons are.

    Raises:
        ValueError: If ``url`` does not start with ``https://`` in any case.
    """
    scheme, sep, rest = url.partition("://")
    if sep != "://" or scheme.lower() != "https":
        raise ValueError(
            f"{what} must be an https:// address, got {url!r}: the agent sends nothing in cleartext"
        )
    return f"https://{rest}"


def trust_store(ca_file: str | None) -> ssl.SSLContext | bool:
    """What an HTTP client verifies servers against.

    The system store always, and ``ca_file`` beside it when given, so one
    private authority such as the stack's own is trusted next to the public
    ones without assembling a bundle.

    Args:
        ca_file: A PEM file holding the certificate(s) to trust, or None.

    Returns:
        ``True``, meaning the system store alone, when ``ca_file`` is None;
        otherwise a context holding the system store and the file.

    Raises:
        OSError: If the file cannot be read; the message names it.
        ssl.SSLError: If the file holds no certificate.
    """
    if not ca_file:
        return True
    context = ssl.create_default_context()
    try:
        context.load_verify_locations(cafile=ca_file)
    except ssl.SSLError:
        raise
    except OSError as exc:
        raise OSError(f"the CA file {ca_file!r} cannot be read: {exc.strerror or exc}") from exc
    return context


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
    ``tier`` picks a named model when ``model`` is unset, and ``api_key`` is
    sent as a bearer token. The server is verified against the agent's one
    trust store (:attr:`AgentConfig.ca_file`), not a setting of its own.
    """

    # A retired field such as ``model_path`` is refused, not silently dropped.
    model_config = ConfigDict(extra="forbid")

    backend: Backend = "http"
    # Whose machine the model runs on, on the S-PAL custody ladder. The model
    # server ships in the holder's own stack, so hardware the holder controls
    # unless the deployment says otherwise (a federated operator's cluster, say).
    custody: Operator = Operator.OWNED_HARDWARE
    url: str | None = None
    model: str | None = None
    tier: str = "default"
    api_key: str | None = None
    timeout_seconds: float = Field(default=120.0, gt=0.0, allow_inf_nan=False)

    # --- Shared knobs -------------------------------------------------
    context_length: int = Field(default=4096, ge=512, le=1_000_000)
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    max_tokens: int = Field(default=512, ge=1, le=8192)
    n_gpu_layers: int = Field(default=0, ge=0)
    n_threads: int | None = None

    @field_validator("tier")
    @classmethod
    def _a_known_tier(cls, tier: str) -> str:
        """Refuse an unknown tier here, where configuration loads, rather than at the
        first inference, which a service may reach long after it reported healthy."""
        resolve_model_for_tier(tier)
        return tier

    @model_validator(mode="after")
    def _url_for_the_backend(self) -> LLMConfig:
        """Apply the one URL rule.

        The http backend defaults to llama-server's address, the ollama backend
        must be given one, both must be https://, and the in-process loader
        uses none.
        """
        if self.backend in ("llamacpp", "none"):
            self.url = None
        elif self.backend == "http":
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


DEFAULT_CONTEXT_STORE_URL = "https://localhost:8081"

DEFAULT_CORS_ORIGINS = (
    "https://localhost:4501",  # demo user app, compose.
    "https://localhost:4502",  # demo business app, compose.
    "https://localhost:3000",  # demo user app, vite dev.
    "https://localhost:3001",  # demo business app, vite dev.
)
"""Browser origins the coordination API answers. The demo apps call it from
their own origins, which a browser only allows when the API says so; the
apps are served over TLS, so the origins are https:// ones."""

DEFAULT_HOLDER_ORIGINS = (
    "https://localhost:4501",  # demo user app, compose.
    "https://localhost:3000",  # demo user app, vite dev.
)
"""The holder's own app among the default origins: the pages that may ask the
agent about the holder's data and read the holder-facing reasons."""


def _canonical_origin(origin: str, setting: str) -> str:
    """An origin as a browser serializes it: ``https://`` and a host, nothing more.

    A value with a path, query or user part is never what an Origin header
    carries. The result has a lower-case host and no ``:443``, because the
    checks against the header are exact.
    """
    parts = urlsplit(origin)
    try:
        port = parts.port
    except ValueError:
        port = -1
    if (
        parts.scheme.lower() != "https"
        or not parts.hostname
        or port == -1
        or "@" in parts.netloc
        or parts.path not in ("", "/")
        or parts.query
        or parts.fragment
    ):
        raise ValueError(
            f"{setting} must list https:// origins (scheme and host only), got {origin!r}"
        )
    host = f"[{parts.hostname}]" if ":" in parts.hostname else parts.hostname
    return f"https://{host}" + (f":{port}" if port not in (None, 443) else "")


class ContextConfig(BaseModel):
    """Where the user's context store listens.

    The store is a zero-knowledge blob server (``context-store/src/server.ts``);
    the agent decrypts what it reads, so this is only a network location.
    """

    endpoint: str = DEFAULT_CONTEXT_STORE_URL
    timeout_seconds: float = 30.0

    @field_validator("endpoint")
    @classmethod
    def _over_tls(cls, endpoint: str) -> str:
        """The vault password crosses this link; it is never plain HTTP."""
        return require_https(endpoint, "endpoint (FREEHOLD_CONTEXT_STORE_URL)")


class ApprovalConfig(BaseModel):
    """Autonomous-approval behavior."""

    mode: ApprovalMode = ApprovalMode.MANUAL


DEFAULT_ZKP_URL = "https://localhost:8084"
DEFAULT_CARDANO_URL = "https://localhost:8080"

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
    "FREEHOLD_LLM_CA_FILE": "FREEHOLD_CA_FILE",
    "CONTEXT_STORE_URL": "FREEHOLD_CONTEXT_STORE_URL",
    "ZKP_SERVICE_URL": "FREEHOLD_ZKP_URL",
    "CARDANO_API_URL": "FREEHOLD_CARDANO_URL",
}
# HOST and PORT were read once too, but shells and platforms set those names
# for their own reasons, so they are ignored rather than refused.


def _env(name: str) -> str | None:
    """The variable's value, with an empty one counting as unset, as a cleared export leaves it."""
    return os.environ.get(name) or None


def _refuse_retired_names() -> None:
    """Stop on a retired name, naming its replacement; a cleared one counts as unset."""
    for retired, replacement in RETIRED_ENV_NAMES.items():
        if _env(retired) is not None:
            raise ValueError(f"{retired} is no longer read; set {replacement} instead")


def _backend_from_env() -> Backend | None:
    """The backend named in the environment, or None for the model default."""
    value = _env("FREEHOLD_LLM_BACKEND")
    if value is None:
        return None
    if value == "openai":
        raise ValueError("FREEHOLD_LLM_BACKEND=openai is now FREEHOLD_LLM_BACKEND=http")
    if value not in get_args(Backend):
        raise ValueError(
            f"FREEHOLD_LLM_BACKEND must be http, ollama, llamacpp or none, got {value!r}"
        )
    return cast(Backend, value)


def _operator_from_env(name: str) -> Operator | None:
    """A custody ladder rung named in the environment, or None for the model default."""
    value = _env(name)
    if value is None:
        return None
    if value not in tuple(Operator):
        known = ", ".join(o.value for o in Operator)
        raise ValueError(f"{name} must be one of {known}, got {value!r}")
    return Operator(value)


def _approval_mode_from_env() -> ApprovalMode | None:
    """The approval mode named in the environment, or None for the model default."""
    value = _env("FREEHOLD_APPROVAL_MODE")
    if value is None:
        return None
    if value not in tuple(ApprovalMode):
        known = ", ".join(m.value for m in ApprovalMode)
        raise ValueError(f"FREEHOLD_APPROVAL_MODE must be one of {known}, got {value!r}")
    return ApprovalMode(value)


def _holder_origins_from_env() -> list[str] | None:
    """The holder's app's origins from a comma-separated list, or None for the model default."""
    value = _env("FREEHOLD_HOLDER_ORIGINS")
    if value is None:
        return None
    return [origin.strip() for origin in value.split(",") if origin.strip()]


def _cors_origins_from_env() -> list[str] | None:
    """Browser origins from a comma-separated list, or None for the model default.

    Trailing slashes are dropped, as a browser's Origin header has none.
    """
    value = _env("FREEHOLD_CORS_ORIGINS")
    if value is None:
        return None
    return [o.strip().rstrip("/") for o in value.split(",") if o.strip()]


def _port_from_env() -> int | None:
    """The port named in the environment, or None for the model default."""
    value = _env("FREEHOLD_PORT")
    if value is None:
        return None
    try:
        return int(value)
    except ValueError as exc:
        raise ValueError("FREEHOLD_PORT must be an integer") from exc


def _given(**values: object) -> dict[str, object]:
    """Only the values the environment supplied, so the models keep their own defaults."""
    return {name: value for name, value in values.items() if value is not None}


class AgentConfig(BaseModel):
    """The agent's configuration: its model, the services it coordinates, and its own API.

    Every link is TLS. ``ca_file`` is the one thing the agent trusts beyond
    the system store, for every server it reaches; ``tls_cert_file`` and
    ``tls_key_file`` are what its own API serves, required to serve it.
    """

    llm: LLMConfig = Field(default_factory=LLMConfig)
    context: ContextConfig = Field(default_factory=ContextConfig)
    approval: ApprovalConfig = Field(default_factory=ApprovalConfig)

    # Where the coordination API listens; loopback unless deployment says otherwise.
    host: str = "127.0.0.1"
    port: int = Field(default=8082, ge=1, le=65535)
    tls_cert_file: str | None = None
    tls_key_file: str | None = None

    # The services the agent coordinates.
    zkp_url: str = DEFAULT_ZKP_URL
    cardano_url: str = DEFAULT_CARDANO_URL
    # Whose machine the proof service runs on: making a proof handles the raw
    # data, so a rule's custody ceiling binds it as it binds the model.
    zkp_custody: Operator = Operator.OWNED_HARDWARE

    # A certificate (or bundle) trusted beside the system store on every link.
    ca_file: str | None = None

    # Agent behavior
    max_context_items: int = Field(default=10, ge=1, le=100)
    audit_logging: bool = True

    # Browser origins allowed to call the coordination API; never a wildcard.
    cors_origins: list[str] = Field(default_factory=lambda: list(DEFAULT_CORS_ORIGINS))
    # The holder's own app's origins: the pages that may ask the agent about the
    # holder's data and read the holder-facing reasons. The user app's origins
    # when the allowlist is the default one; otherwise they must be named, or
    # none may.
    holder_origins: list[str] | None = None

    @field_validator("zkp_url")
    @classmethod
    def _zkp_over_tls(cls, url: str) -> str:
        """Proofs and the claims behind them cross this link; never plain HTTP."""
        return require_https(url, "zkp_url (FREEHOLD_ZKP_URL)")

    @field_validator("cardano_url")
    @classmethod
    def _cardano_over_tls(cls, url: str) -> str:
        """Reads only, but the rule is one rule: never plain HTTP."""
        return require_https(url, "cardano_url (FREEHOLD_CARDANO_URL)")

    @field_validator("ca_file", "tls_cert_file", "tls_key_file")
    @classmethod
    def _empty_is_unset(cls, path: str | None) -> str | None:
        """An empty path is unset, as a cleared export leaves it."""
        return path or None

    @field_validator("cors_origins")
    @classmethod
    def _https_origins_only(cls, origins: list[str]) -> list[str]:
        """Origins as a browser serializes them: ``https://`` and a host, nothing more.

        A page that reaches the API is served over TLS too, and a value with a
        path, query or user part is never what an Origin header carries. Each
        is returned in the browser's form, lower-case host and no ``:443``,
        because the checks against the header are exact.
        """
        if any("*" in origin for origin in origins):
            raise ValueError("cors_origins must list origins; '*' is not accepted")
        return [_canonical_origin(origin, "cors_origins") for origin in origins]

    @model_validator(mode="after")
    def _holder_origins_are_allowed_ones(self) -> AgentConfig:
        """The holder's app is among the allowed pages.

        With the default allowlist the holder's app is the demo user app, at
        its compose and vite-dev origins. With a custom allowlist it is the
        first origin listed, unless named here; either way every holder origin
        is canonicalized and must be allowed.
        """
        if self.holder_origins is None:
            # A custom allowlist names no holder page on its own: without
            # FREEHOLD_HOLDER_ORIGINS nothing may ask and no holder-facing
            # reason leaves the agent, rather than guessing from the order.
            self.holder_origins = (
                list(DEFAULT_HOLDER_ORIGINS)
                if self.cors_origins == list(DEFAULT_CORS_ORIGINS)
                else []
            )
        else:
            self.holder_origins = [
                _canonical_origin(o, "holder_origins") for o in self.holder_origins
            ]
            outside = [o for o in self.holder_origins if o not in self.cors_origins]
            if outside:
                raise ValueError(
                    f"holder_origins must be among cors_origins; not allowed: {outside}"
                )
        return self

    @model_validator(mode="after")
    def _certificate_and_key_together(self) -> AgentConfig:
        """A certificate without its key, or a key without its certificate, serves nothing."""
        if (self.tls_cert_file is None) != (self.tls_key_file is None):
            raise ValueError(
                "tls_cert_file (FREEHOLD_TLS_CERT_FILE) and tls_key_file (FREEHOLD_TLS_KEY_FILE) "
                "are set together: the API is served with a certificate and its key"
            )
        return self

    def trust_store(self) -> ssl.SSLContext | bool:
        """What every client of this configuration verifies servers against.

        Returns:
            The system store alone, or the system store with ``ca_file`` beside it.

        Raises:
            OSError: If ``ca_file`` cannot be read.
            ssl.SSLError: If ``ca_file`` holds no certificate.
        """
        return trust_store(self.ca_file)

    @classmethod
    def from_env(cls) -> AgentConfig:
        """Build an :class:`AgentConfig` from the environment.

        Every variable the agent reads is a ``FREEHOLD_*`` one: ``FREEHOLD_HOST``,
        ``FREEHOLD_PORT``, ``FREEHOLD_TLS_CERT_FILE`` and ``FREEHOLD_TLS_KEY_FILE``
        for the API, ``FREEHOLD_CONTEXT_STORE_URL``, ``FREEHOLD_ZKP_URL`` and
        ``FREEHOLD_CARDANO_URL`` for the services it coordinates,
        ``FREEHOLD_LLM_*`` for the model, ``FREEHOLD_CA_FILE`` for what it
        trusts on every link, ``FREEHOLD_APPROVAL_MODE``, ``FREEHOLD_CORS_ORIGINS``
        and ``FREEHOLD_HOLDER_ORIGINS``. Unset or empty variables fall back to
        the model defaults, which are defined once, on the models.

        Returns:
            The configuration the environment describes.

        Raises:
            ValueError: If a retired name is set (the message names its
                replacement), if ``FREEHOLD_LLM_BACKEND``,
                ``FREEHOLD_APPROVAL_MODE``, ``FREEHOLD_PORT`` or
                ``FREEHOLD_LLM_TIMEOUT`` holds a value outside its set, or if
                a service address is not ``https://`` (or the model server's
                is missing for the ollama backend).
        """
        _refuse_retired_names()
        timeout = _env("FREEHOLD_LLM_TIMEOUT")
        return cls(
            llm=LLMConfig(
                **_given(
                    backend=_backend_from_env(),
                    custody=_operator_from_env("FREEHOLD_LLM_CUSTODY"),
                    url=_env("FREEHOLD_LLM_URL"),
                    model=_env("FREEHOLD_LLM_MODEL"),
                    tier=_env("FREEHOLD_LLM_TIER"),
                    api_key=_env("FREEHOLD_LLM_API_KEY"),
                    timeout_seconds=(
                        _parse_env_timeout("FREEHOLD_LLM_TIMEOUT", 0.0) if timeout else None
                    ),
                )
            ),
            context=ContextConfig(**_given(endpoint=_env("FREEHOLD_CONTEXT_STORE_URL"))),
            approval=ApprovalConfig(**_given(mode=_approval_mode_from_env())),
            **_given(
                host=_env("FREEHOLD_HOST"),
                port=_port_from_env(),
                tls_cert_file=_env("FREEHOLD_TLS_CERT_FILE"),
                tls_key_file=_env("FREEHOLD_TLS_KEY_FILE"),
                zkp_url=_env("FREEHOLD_ZKP_URL"),
                cardano_url=_env("FREEHOLD_CARDANO_URL"),
                ca_file=_env("FREEHOLD_CA_FILE"),
                cors_origins=_cors_origins_from_env(),
                holder_origins=_holder_origins_from_env(),
                zkp_custody=_operator_from_env("FREEHOLD_ZKP_CUSTODY"),
            ),
        )
