"""
Shared model-backend contract.

``OllamaBackend`` and ``OpenAICompatBackend`` satisfy the :class:`LLMBackend`
protocol, letting the :class:`~freehold_agent.agent.Agent` dispatch on config
without knowing which runtime is in use. Both also satisfy
:class:`StructuredBackend`, the contract for JSON-schema constrained output,
and :class:`StructuredOutputError` roots the errors raised when that output
cannot be turned into a validated structure.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, runtime_checkable

Role = Literal["system", "user", "assistant", "tool"]


@dataclass
class LLMResponse:
    """Result of an unstructured ``generate`` call."""

    text: str
    tokens_used: int
    finish_reason: str


@dataclass
class ChatMessage:
    """A single chat-format message."""

    role: Role
    content: str


@dataclass
class StructuredResponse:
    """Result of a JSON-schema constrained generation call.

    ``data`` is the parsed JSON object the model produced. ``raw_text`` is
    kept for diagnostic and audit purposes (S-PAL flows need an audit trail
    of what the model actually emitted).
    """

    data: dict[str, Any]
    raw_text: str
    model: str
    tokens_used: int
    finish_reason: str
    metadata: dict[str, Any] = field(default_factory=dict)


class StructuredOutputError(Exception):
    """Base for failures turning a backend's structured output into a validated model."""


@runtime_checkable
class StructuredBackend(Protocol):
    """A backend that can constrain generation to a JSON schema.

    Both backends satisfy it: ``llama-server`` and other OpenAI-compatible
    servers through ``response_format``, Ollama through ``format``.
    """

    async def generate_structured(
        self,
        prompt: str,
        schema: dict[str, Any],
        *,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> StructuredResponse:
        """Generate a JSON object conforming to ``schema``.

        Args:
            prompt: The user prompt, framing included.
            schema: A JSON Schema the output must conform to.
            max_tokens: Optional generation limit; backend default when ``None``.
            temperature: Optional sampling temperature; backend default when ``None``.

        Returns:
            The parsed object with the raw text and usage the backend reported.

        Raises:
            The backend's own error classes (``OllamaError``, ``OpenAIError``)
            on transport, timeout, schema or refusal failures.
        """
        ...


@runtime_checkable
class LLMBackend(Protocol):
    """Minimum interface every backend must implement."""

    async def generate(
        self,
        prompt: str,
        *,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> LLMResponse:
        """Free-form text generation from a plain prompt."""
        ...

    async def aclose(self) -> None:
        """Release any transport / model resources held by the backend."""
        ...
