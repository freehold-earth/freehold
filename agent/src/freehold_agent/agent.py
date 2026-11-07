"""
Core Agent implementation.

The agent is the one path on which the holder's context reaches a model:

1. ``ask``: the holder asks about their own data, under one of their
   policies. The policy's rule for the scope must exist; identity material
   is never read; the scope's entries go to whichever backend is configured.
   This is the path the compute-locality condition (#42) and the outbound
   audit (#93) govern.
2. ``propose_request_context``: synthesise a
   :class:`~freehold_agent.spal.RequestContext` for the S-PAL flow from a
   natural-language description. Needs a backend with JSON-schema
   constrained output: the OpenAI-compatible backend or Ollama.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime

from freehold_agent.config import AgentConfig
from freehold_agent.context import ContextClient, ContextEntry, scope_domain
from freehold_agent.errors import NoModelBackend, PolicyRefused
from freehold_agent.models.backend import StructuredBackend
from freehold_agent.models.local_llm import LocalLLM
from freehold_agent.models.ollama import OllamaBackend
from freehold_agent.models.openai import OpenAICompatBackend
from freehold_agent.models.spal_bridge import (
    propose_request_context as _propose_request_context,
)
from freehold_agent.policy import PolicyChecker, Requester
from freehold_agent.spal import RequestContext

logger = logging.getLogger(__name__)

REFUSED_ASK_DOMAINS = frozenset({"identity", "root-identity"})
"""Scopes an ask never reads, whatever the policy says: identity material never goes to a model."""


@dataclass
class AgentResponse:
    """An answer to the holder's ask."""

    content: str
    context_used: list[str]
    rule_id: str
    timestamp: datetime


class Agent:
    """
    PCI Personal Agent

    Processes queries using local AI while enforcing S-PAL policies
    and retrieving context from the encrypted store.
    """

    def __init__(
        self, config: AgentConfig | None = None, *, context_client: ContextClient | None = None
    ) -> None:
        """Build the agent over ``context_client``, the app's vault client, or its own.

        A client given is shared: it holds the vault secret the API's unlock
        handed it, and the agent neither unlocks nor disconnects it.
        """
        self.config = config or AgentConfig()
        # One of these is set by initialize(), the one the config's backend names;
        # _generate and close() enumerate them and must stay in step.
        self._llm: LocalLLM | None = None
        self._ollama_backend: OllamaBackend | None = None
        self._openai_backend: OpenAICompatBackend | None = None
        # One trust store, built once, shared by every client the agent opens.
        self._verify = self.config.trust_store()
        self._owns_client = context_client is None
        self._context_client = context_client or ContextClient(
            self.config.context, verify=self._verify
        )
        self._policy_checker = PolicyChecker(self._context_client)
        self._initialized = False

    async def initialize(self) -> None:
        """Initialize the agent (load model, connect to context store)"""
        if self._initialized:
            return

        # Load whichever backend the config selects. The llama-cpp path is
        # gated on ``model_path`` for backward compatibility; the Ollama
        # backend has no local file to load — the daemon is expected to be
        # running separately.
        if self.config.llm.backend == "none":
            pass
        elif self.config.llm.backend == "llamacpp":
            if self.config.llm.model_path:
                self._llm = await self._load_llm()
        elif self.config.llm.backend == "ollama":
            self._ollama_backend = self._build_ollama_backend()
        elif self.config.llm.backend == "http":
            self._openai_backend = self._build_openai_backend()

        try:
            await self._context_client.connect()
        except BaseException:
            # Release any backend resources we just acquired so a retry can
            # start from a clean slate; ``_initialized`` stays False.
            await self._release_backend()
            raise

        self._initialized = True

    async def ask(self, question: str, policy_name: str, context_scope: str) -> AgentResponse:
        """Answer the holder's question from their own data in ``context_scope``, under a policy.

        In order: a scope in the identity domain, or the root identity key,
        is refused before anything is read; the named policy is read from the
        vault and must have a rule governing the scope, evaluated for the
        holder; the scope's entries are read and go to the model with the
        question. Nothing is answered without a matching rule, and a locked
        or unreachable vault is an error, never an answer without context.

        Raises:
            PolicyRefused: An identity scope, a policy that cannot be used, or
                no rule for the scope; ``detail`` says which.
            ContextUnavailable: The vault is locked or cannot be read.
            NoModelBackend: No model backend is configured or loaded.
        """
        if not self._initialized:
            await self.initialize()
        if context_scope == "root-identity" or scope_domain(context_scope) in REFUSED_ASK_DOMAINS:
            raise PolicyRefused("identity scopes are never sent to a model")

        stored = await self._policy_checker.policy_named(policy_name)
        result = await self._policy_checker.check(
            stored.policy, context_scope, RequestContext(), Requester.HOLDER
        )
        if not (result.allowed and result.matched_rule_id is not None):
            raise PolicyRefused(result.detail or result.reason or "not permitted")

        entries = await self._context_client.entries(context_scope)
        content = await self._generate(self._build_prompt(question, entries))
        return AgentResponse(
            content=content,
            context_used=[entry.key for entry in entries],
            rule_id=result.matched_rule_id,
            timestamp=datetime.now(UTC),
        )

    async def propose_request_context(
        self,
        prompt: str,
        *,
        system_prompt: str | None = None,
        max_tokens: int | None = None,
        temperature: float | None = None,
    ) -> RequestContext:
        """Ask the LLM to synthesise a ``RequestContext`` for policy evaluation.

        This is the S-PAL wiring point: the caller supplies a natural-language
        description of an incoming business request and gets back a validated
        ``RequestContext`` ready for
        :meth:`freehold_agent.policy.PolicyChecker.check`.

        The LLM is a composer only — ``PolicyChecker`` remains the sole
        adjudicator.

        Args:
            prompt: Natural-language description of the business request.
            system_prompt: Optional override for the framing prompt.
            max_tokens: Optional generation limit forwarded to the backend.
            temperature: Optional sampling temperature forwarded to the backend.

        Returns:
            A validated ``RequestContext``.

        Raises:
            RuntimeError: The configured backend has no JSON-schema constrained
                output (the in-process llama-cpp loader).
            RequestContextError: The model's output did not validate.
            OllamaError: On an Ollama backend failure.
            OpenAIError: On an OpenAI-compatible backend failure.
        """
        if not self._initialized:
            await self.initialize()
        structured: dict[str, StructuredBackend | None] = {
            "http": self._openai_backend,
            "ollama": self._ollama_backend,
        }
        if self.config.llm.backend not in structured:
            raise RuntimeError(
                "propose_request_context needs a backend with JSON-schema constrained "
                "output: the http backend (llama-server) or Ollama; the "
                "in-process llama-cpp backend has none"
            )
        backend = structured[self.config.llm.backend]
        if backend is None:
            raise RuntimeError(
                f"the {self.config.llm.backend} backend is not initialised; the agent "
                "was closed or failed to initialise"
            )
        return await _propose_request_context(
            backend,
            prompt,
            system_prompt=system_prompt,
            max_tokens=max_tokens,
            temperature=temperature,
        )

    async def _load_llm(self) -> LocalLLM:
        """Load the local language model"""
        llm = LocalLLM(self.config.llm)
        await llm.load()
        return llm

    def _build_ollama_backend(self) -> OllamaBackend:
        """Construct an Ollama backend from the current LLM config."""
        cfg = self.config.llm
        if cfg.url is None:  # The config validator requires it for this backend.
            raise RuntimeError("the ollama backend has no server address")
        return OllamaBackend(
            base_url=cfg.url,
            model=cfg.model,
            tier=cfg.tier if cfg.model is None else None,
            api_key=cfg.api_key,
            request_timeout=cfg.timeout_seconds,
            verify=self._verify,
            temperature=cfg.temperature,
        )

    def _build_openai_backend(self) -> OpenAICompatBackend:
        """Construct a chat-completions HTTP backend from the current LLM config."""
        cfg = self.config.llm
        if cfg.url is None:  # The config validator fills the default for this backend.
            raise RuntimeError("the http backend has no server address")
        return OpenAICompatBackend(
            base_url=cfg.url,
            model=cfg.model,
            tier=cfg.tier if cfg.model is None else None,
            api_key=cfg.api_key,
            request_timeout=cfg.timeout_seconds,
            verify=self._verify,
            temperature=cfg.temperature,
        )

    async def _generate(self, prompt: str) -> str:
        """Send the prompt to whichever backend is loaded; none loaded is an error."""
        if self._llm is not None:
            return (await self._llm.generate(prompt)).text
        if self._ollama_backend is not None:
            return (await self._ollama_backend.generate(prompt)).text
        if self._openai_backend is not None:
            return (await self._openai_backend.generate(prompt)).text
        raise NoModelBackend()

    @staticmethod
    def _build_prompt(question: str, entries: list[ContextEntry]) -> str:
        """The prompt: the scope's fields, one per line, then the question."""
        parts: list[str] = []
        if entries:
            parts.append("Context:")
            for entry in entries:
                for name, value in entry.fields():
                    parts.append(f"- {name}: {value}")
            parts.append("")
        parts.append(f"Question: {question}")
        parts.append("Answer:")
        return "\n".join(parts)

    async def close(self) -> None:
        """Cleanup resources.

        Disconnects a context client the agent owns (never one it was given)
        and releases the backend regardless of intermediate failures: a
        raising :meth:`ContextClient.disconnect` must not leak the LLM backend
        or leave stale lifecycle state.
        """
        try:
            if self._owns_client:
                await self._context_client.disconnect()
        finally:
            try:
                await self._release_backend()
            finally:
                self._initialized = False

    async def _release_backend(self) -> None:
        """Release whichever backend is currently loaded, if any."""
        if self._llm is not None:
            try:
                await self._llm.unload()
            finally:
                self._llm = None
        if self._ollama_backend is not None:
            try:
                await self._ollama_backend.aclose()
            finally:
                self._ollama_backend = None
        if self._openai_backend is not None:
            try:
                await self._openai_backend.aclose()
            finally:
                self._openai_backend = None
