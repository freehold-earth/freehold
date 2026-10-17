"""
PCI Agent - Layer 2: Local AI agent for Personal Context Infrastructure
"""

from pci_agent.agent import Agent, AgentResponse
from pci_agent.config import AgentConfig, LLMConfig
from pci_agent.context import ContextClient
from pci_agent.envelope import (
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
from pci_agent.models import (
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
from pci_agent.policy import PolicyChecker, PolicyCheckResult
from pci_agent.spal import RequestContext, SPALPolicy

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
