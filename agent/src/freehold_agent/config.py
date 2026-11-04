"""
Agent configuration.

Environment overrides follow the 12-factor pattern used elsewhere in the
codebase (see ``__main__.py``): the pydantic models are the source of
truth, and :meth:`AgentConfig.from_env` folds in the ``FREEHOLD_*`` variables at
process start.
"""

from __future__ import annotations

import math
import os
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from freehold_agent.coordination import ApprovalMode

Backend = Literal["ollama", "openai", "llamacpp"]

# Where llama-server listens out of the box; the OpenAI-compatible backend's
# default and the one place this URL is written.
DEFAULT_OPENAI_BASE_URL = "http://127.0.0.1:8080/v1"


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


class LLMConfig(BaseModel):
    """Configuration for the local language model.

    ``backend`` selects between an OpenAI-compatible HTTP endpoint (the
    default, pointed at a local ``llama-server``), the Ollama HTTP daemon, and
    the in-process ``llama-cpp-python`` GGUF loader. The llama.cpp family is
    the default because it makes no outbound calls (ADR-006); Ollama is opted
    into explicitly or via ``FREEHOLD_LLM_BACKEND=ollama``. The in-process
    loader is the single-executable fallback and loads nothing until
    ``model_path`` is set.
    """

    backend: Backend = "openai"

    # --- llama-cpp-python (in-process) --------------------------------
    model_path: str | None = None

    # --- Ollama (HTTP daemon) ----------------------------------------
    ollama_base_url: str = "http://127.0.0.1:11434"
    ollama_tier: str = "default"
    ollama_model: str | None = None
    ollama_timeout_seconds: float = Field(default=120.0, gt=0.0, allow_inf_nan=False)

    # --- OpenAI-compatible (HTTP daemon) -----------------------------
    openai_base_url: str = DEFAULT_OPENAI_BASE_URL
    openai_tier: str = "default"
    openai_model: str | None = None
    openai_api_key: str | None = None
    openai_timeout_seconds: float = Field(default=120.0, gt=0.0, allow_inf_nan=False)

    # --- Shared knobs -------------------------------------------------
    context_length: int = Field(default=4096, ge=512, le=1_000_000)
    temperature: float = Field(default=0.7, ge=0.0, le=2.0)
    max_tokens: int = Field(default=512, ge=1, le=8192)
    n_gpu_layers: int = Field(default=0, ge=0)
    n_threads: int | None = None


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


class AgentConfig(BaseModel):
    """Main agent configuration"""

    llm: LLMConfig = Field(default_factory=LLMConfig)
    context: ContextConfig = Field(default_factory=ContextConfig)
    approval: ApprovalConfig = Field(default_factory=ApprovalConfig)

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

        LLM and approval settings come from ``FREEHOLD_*`` variables; the
        context store's URL from ``CONTEXT_STORE_URL``, the name the compose
        files share with ``ZKP_SERVICE_URL``. ``FREEHOLD_CORS_ORIGINS`` is a
        comma-separated list of browser origins (trailing slashes dropped, as
        a browser's Origin header has none). Unknown / unset / empty
        variables fall back to model defaults.
        """
        # An empty variable counts as unset, as a cleared shell export would leave it
        backend_env = os.environ.get("FREEHOLD_LLM_BACKEND") or None
        model_path = os.environ.get("FREEHOLD_LLM_MODEL_PATH")
        backend: Backend
        if backend_env in ("ollama", "openai", "llamacpp"):
            backend = backend_env  # type: ignore[assignment]
        elif backend_env is None and model_path:
            # A model path alone was the documented way to run the in-process
            # loader before llama-server became the default; keep it working.
            backend = "llamacpp"
        else:
            backend = "openai"

        # FREEHOLD_LLM_TIER is shared across the HTTP backends; FREEHOLD_OPENAI_* mirror
        # the FREEHOLD_OLLAMA_* family for the OpenAI-compatible endpoint.
        tier = os.environ.get("FREEHOLD_LLM_TIER", "default")

        mode_env = os.environ.get("FREEHOLD_APPROVAL_MODE")
        mode = ApprovalMode(mode_env) if mode_env in tuple(ApprovalMode) else ApprovalMode.MANUAL

        origins_env = os.environ.get("FREEHOLD_CORS_ORIGINS") or None
        cors_origins = (
            [o.strip().rstrip("/") for o in origins_env.split(",") if o.strip()]
            if origins_env is not None
            else list(DEFAULT_CORS_ORIGINS)
        )

        return cls(
            llm=LLMConfig(
                backend=backend,
                model_path=model_path,
                ollama_base_url=os.environ.get("FREEHOLD_OLLAMA_URL", "http://127.0.0.1:11434"),
                ollama_tier=tier,
                ollama_model=os.environ.get("FREEHOLD_OLLAMA_MODEL"),
                ollama_timeout_seconds=_parse_env_timeout("FREEHOLD_OLLAMA_TIMEOUT", 120.0),
                openai_base_url=os.environ.get("FREEHOLD_OPENAI_BASE_URL", DEFAULT_OPENAI_BASE_URL),
                openai_tier=tier,
                openai_model=os.environ.get("FREEHOLD_OPENAI_MODEL") or None,
                openai_api_key=os.environ.get("FREEHOLD_OPENAI_API_KEY") or None,
                openai_timeout_seconds=_parse_env_timeout("FREEHOLD_OPENAI_TIMEOUT", 120.0),
            ),
            context=ContextConfig(
                endpoint=os.environ.get("CONTEXT_STORE_URL") or DEFAULT_CONTEXT_STORE_URL
            ),
            approval=ApprovalConfig(mode=mode),
            cors_origins=cors_origins,
        )
