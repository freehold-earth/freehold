"""
PCI Agent - Layer 2: Local AI agent for Personal Context Infrastructure
"""

from freehold_agent.agent import Agent, AgentResponse
from freehold_agent.config import AgentConfig, LLMConfig
from freehold_agent.context import ContextClient
from freehold_agent.envelope import (
    BODY_HASH_WIDTH,
    DEFAULT_LEEWAY_SECONDS,
    DEFAULT_MAX_LIFETIME_SECONDS,
    DOMAIN_SEPARATOR,
    NONCE_WIDTH,
    EnvelopeSigner,
    EnvelopeVerifier,
    NonceStore,
    RequestEnvelope,
    SignedEnvelope,
    new_nonce,
    sign_envelope,
    verify_envelope,
)
from freehold_agent.models import (
    MODEL_TIERS,
    LLMBackend,
    LLMResponse,
    LocalLLM,
    OllamaBackend,
    OllamaError,
    OllamaModelRefusalError,
    OllamaSchemaError,
    OllamaTimeoutError,
    OllamaTransportError,
    OpenAICompatBackend,
    OpenAIError,
    OpenAIModelRefusalError,
    OpenAISchemaError,
    OpenAITimeoutError,
    OpenAITransportError,
    StructuredResponse,
    propose_request_context,
)
from freehold_agent.policy import PolicyChecker, PolicyCheckResult
from freehold_agent.spal import RequestContext, SPALPolicy

__version__ = "0.1.0"

__all__ = [
    "BODY_HASH_WIDTH",
    "DEFAULT_LEEWAY_SECONDS",
    "DEFAULT_MAX_LIFETIME_SECONDS",
    "DOMAIN_SEPARATOR",
    "MODEL_TIERS",
    "NONCE_WIDTH",
    "Agent",
    "AgentConfig",
    "AgentResponse",
    "ContextClient",
    "EnvelopeSigner",
    "EnvelopeVerifier",
    "LLMBackend",
    "LLMConfig",
    "LLMResponse",
    "LocalLLM",
    "NonceStore",
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
    "PolicyCheckResult",
    "PolicyChecker",
    "RequestContext",
    "RequestEnvelope",
    "SPALPolicy",
    "SignedEnvelope",
    "StructuredResponse",
    "new_nonce",
    "propose_request_context",
    "sign_envelope",
    "verify_envelope",
]
