"""
Ollama HTTP backend.

Talks to an Ollama daemon over the ``/api/generate`` endpoint, through a TLS
proxy in front of it, since the agent sends prompts only over ``https://``.
Structured output uses Ollama's ``format`` parameter, which forwards a JSON
schema to llama.cpp's built-in
schema-to-GBNF constraint — the model can only emit tokens that keep the
output conformant.

The environment is read in :meth:`freehold_agent.config.AgentConfig.from_env`
(``FREEHOLD_LLM_BACKEND=ollama`` selects this backend; ``FREEHOLD_LLM_URL``,
``FREEHOLD_LLM_MODEL``, ``FREEHOLD_LLM_TIER``, ``FREEHOLD_LLM_CA_FILE`` and
``FREEHOLD_LLM_TIMEOUT`` configure it); this module takes what it is given.
Ollama serves plain HTTP only, and the agent sends prompts only over
``https://``, so the address given is that of a TLS proxy in front of it.
"""

from __future__ import annotations

import json
from types import TracebackType
from typing import Any

import httpx2

from freehold_agent.config import DEFAULT_TIER, require_https, resolve_model_for_tier
from freehold_agent.models.backend import LLMResponse, StructuredOutputError, StructuredResponse

DEFAULT_TIMEOUT_SECONDS = 120.0
DEFAULT_MAX_RETRIES = 2


class OllamaError(Exception):
    """Base class for Ollama backend errors."""


class OllamaTransportError(OllamaError):
    """Raised when the HTTP call itself failed (connection, non-2xx, etc.)."""


class OllamaTimeoutError(OllamaError):
    """Raised when the daemon did not respond within the configured timeout."""


class OllamaSchemaError(OllamaError, StructuredOutputError):
    """Raised when the model returned text that failed schema decoding."""


class OllamaModelRefusalError(OllamaError):
    """Raised when the model returned an empty/refusal response."""


class OllamaBackend:
    """Async HTTP client for a local Ollama daemon.

    Instances own an :class:`httpx2.AsyncClient`. Call :meth:`aclose` when
    done (or use the backend as an async context manager). The client is
    created lazily so the backend is safe to construct from sync code.

    Args:
        base_url: The ``https://`` address of the TLS proxy in front of the daemon.
        model: The model tag to ask for; when unset, ``tier`` picks one.
        tier: A named model tier, used when ``model`` is unset.
        api_key: Sent as ``Authorization: Bearer …`` when set, for a proxy that
            asks for one.
        request_timeout: Per-request deadline in seconds.
        max_retries: Retries on transport failures.
        ca_file: The certificate (or bundle) the proxy is verified against in
            place of the system store, for a proxy with its own; empty means
            the system store, and verification is never disabled.
        temperature: Sampling temperature.
        transport: An httpx2 transport override, for tests.

    Raises:
        ValueError: If ``base_url`` is not ``https://``, or ``tier`` is unknown.
    """

    def __init__(
        self,
        *,
        base_url: str,
        model: str | None = None,
        tier: str | None = None,
        api_key: str | None = None,
        request_timeout: float = DEFAULT_TIMEOUT_SECONDS,
        max_retries: int = DEFAULT_MAX_RETRIES,
        ca_file: str | None = None,
        temperature: float = 0.2,
        transport: httpx2.AsyncBaseTransport | None = None,
    ) -> None:
        self.base_url = require_https(base_url, "the Ollama proxy's address").rstrip("/")
        self.model = model or resolve_model_for_tier(tier or DEFAULT_TIER)
        self.api_key = api_key
        self.ca_file = ca_file or None
        self.request_timeout = request_timeout
        self.max_retries = max_retries
        self.temperature = temperature
        self._transport = transport
        self._client: httpx2.AsyncClient | None = None

    # ---------------------------------------------------------------
    # Lifecycle
    # ---------------------------------------------------------------

    def _get_client(self) -> httpx2.AsyncClient:
        if self._client is None:
            headers = {"Authorization": f"Bearer {self.api_key}"} if self.api_key else None
            self._client = httpx2.AsyncClient(
                base_url=self.base_url,
                timeout=self.request_timeout,
                verify=self.ca_file if self.ca_file is not None else True,
                headers=headers,
                transport=self._transport,
            )
        return self._client

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def __aenter__(self) -> OllamaBackend:
        self._get_client()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        await self.aclose()

    # ---------------------------------------------------------------
    # Public API
    # ---------------------------------------------------------------

    async def generate(
        self,
        prompt: str,
        *,
        model: str | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> LLMResponse:
        """Free-form text generation. Returns unparsed text."""
        payload = self._build_payload(
            prompt=prompt,
            model=model,
            max_tokens=max_tokens,
            temperature=temperature,
            schema=None,
        )
        raw = await self._post_generate(payload)
        return LLMResponse(
            text=str(raw.get("response", "")),
            tokens_used=int(raw.get("eval_count", 0) or 0),
            finish_reason=_finish_reason(raw),
        )

    async def generate_structured(
        self,
        prompt: str,
        schema: dict[str, Any],
        *,
        model: str | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> StructuredResponse:
        """Schema-constrained generation.

        Passes ``schema`` to Ollama's ``format`` field so the model can only
        emit conformant JSON. Callers are still expected to validate the
        result against their own pydantic model at the trust boundary — the
        schema guarantees shape but not semantic correctness.
        """
        payload = self._build_payload(
            prompt=prompt,
            model=model,
            max_tokens=max_tokens,
            temperature=temperature,
            schema=schema,
        )
        raw = await self._post_generate(payload)

        text = str(raw.get("response", "")).strip()
        if not text:
            raise OllamaModelRefusalError(
                f"Ollama model '{payload['model']}' returned an empty response"
            )
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            raise OllamaSchemaError(f"Model output was not valid JSON: {exc.msg}") from exc
        if not isinstance(data, dict):
            raise OllamaSchemaError(
                f"Model output must decode to a JSON object, got {type(data).__name__}"
            )

        return StructuredResponse(
            data=data,
            raw_text=text,
            model=str(payload["model"]),
            tokens_used=int(raw.get("eval_count", 0) or 0),
            finish_reason=_finish_reason(raw),
            metadata={
                "prompt_eval_count": int(raw.get("prompt_eval_count", 0) or 0),
                "total_duration_ns": int(raw.get("total_duration", 0) or 0),
            },
        )

    # ---------------------------------------------------------------
    # Internals
    # ---------------------------------------------------------------

    def _build_payload(
        self,
        *,
        prompt: str,
        model: str | None,
        max_tokens: int | None,
        temperature: float | None,
        schema: dict[str, Any] | None,
    ) -> dict[str, Any]:
        options: dict[str, Any] = {
            "temperature": temperature if temperature is not None else self.temperature,
        }
        if max_tokens is not None:
            options["num_predict"] = max_tokens

        payload: dict[str, Any] = {
            "model": model or self.model,
            "prompt": prompt,
            "stream": False,
            "options": options,
        }
        if schema is not None:
            payload["format"] = schema
        return payload

    async def _post_generate(self, payload: dict[str, Any]) -> dict[str, Any]:
        client = self._get_client()
        last_exc: Exception | None = None

        for attempt in range(self.max_retries + 1):
            try:
                response = await client.post("/api/generate", json=payload)
            except httpx2.TimeoutException as exc:
                last_exc = exc
                if attempt == self.max_retries:
                    raise OllamaTimeoutError(
                        f"Ollama request timed out after {self.request_timeout}s"
                    ) from exc
                continue
            except httpx2.HTTPError as exc:
                last_exc = exc
                if attempt == self.max_retries:
                    raise OllamaTransportError(f"Ollama transport error: {exc}") from exc
                continue

            if response.status_code >= 500 and attempt < self.max_retries:
                # Retry transient 5xx once
                last_exc = OllamaTransportError(f"Ollama returned {response.status_code}")
                continue
            if response.status_code != 200:
                raise OllamaTransportError(
                    f"Ollama returned HTTP {response.status_code}: {response.text[:500]}"
                )

            try:
                data = response.json()
            except ValueError as exc:
                raise OllamaTransportError("Ollama response was not valid JSON") from exc
            if not isinstance(data, dict):
                raise OllamaTransportError(
                    f"Ollama response must be an object, got {type(data).__name__}"
                )
            return data

        # Loop exhausted without returning — should be unreachable because
        # the final iteration raises. Kept as a defensive fallback.
        raise OllamaTransportError(
            f"Ollama request failed after {self.max_retries + 1} attempts: {last_exc}"
        )


def _finish_reason(raw: dict[str, Any]) -> str:
    if raw.get("done") is True:
        reason = raw.get("done_reason")
        if isinstance(reason, str) and reason:
            return reason
        return "stop"
    return "length"
