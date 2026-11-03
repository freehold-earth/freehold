"""
Model backends for the PCI Agent.

The agent supports three local inference backends:

- ``OpenAICompatBackend`` — HTTP client for any daemon speaking the OpenAI
  ``/chat/completions`` protocol; the default, pointed at a local
  ``llama-server`` (ADR-006), and also fits vLLM, SGLang, LM Studio and
  llamafile. Constrains output via ``response_format`` with a ``json_schema``
  block.
- ``OllamaBackend`` — HTTP client for a local Ollama daemon, an alternative
  selected by configuration; constrains output via Ollama's ``format``.
- ``LocalLLM`` — in-process ``llama-cpp-python`` (GGUF file, no daemon), the
  single-executable fallback.

All implementations satisfy the :class:`LLMBackend` protocol so callers can
swap them transparently; the HTTP backends also satisfy
:class:`StructuredBackend`, which ``spal_bridge.py`` uses to synthesise
``RequestContext`` candidates for :class:`freehold_agent.policy.PolicyChecker`.
"""

from freehold_agent.models.backend import (
    ChatMessage,
    LLMBackend,
    LLMResponse,
    StructuredBackend,
    StructuredOutputError,
    StructuredResponse,
)
from freehold_agent.models.local_llm import LocalLLM
from freehold_agent.models.ollama import (
    DEFAULT_OLLAMA_URL,
    MODEL_TIERS,
    OllamaBackend,
    OllamaError,
    OllamaModelRefusalError,
    OllamaSchemaError,
    OllamaTimeoutError,
    OllamaTransportError,
    resolve_model_for_tier,
)
from freehold_agent.models.openai import (
    DEFAULT_OPENAI_BASE_URL,
    OpenAICompatBackend,
    OpenAIError,
    OpenAIModelRefusalError,
    OpenAISchemaError,
    OpenAITimeoutError,
    OpenAITransportError,
)
from freehold_agent.models.spal_bridge import RequestContextError, propose_request_context

__all__ = [
    "DEFAULT_OLLAMA_URL",
    "DEFAULT_OPENAI_BASE_URL",
    "MODEL_TIERS",
    "ChatMessage",
    "LLMBackend",
    "LLMResponse",
    "LocalLLM",
    "OllamaBackend",
    "OllamaError",
    "OllamaModelRefusalError",
    "OllamaSchemaError",
    "OllamaTimeoutError",
    "OllamaTransportError",
    "OpenAICompatBackend",
    "OpenAIError",
    "OpenAIModelRefusalError",
    "OpenAISchemaError",
    "OpenAITimeoutError",
    "OpenAITransportError",
    "RequestContextError",
    "StructuredBackend",
    "StructuredOutputError",
    "StructuredResponse",
    "propose_request_context",
    "resolve_model_for_tier",
]
