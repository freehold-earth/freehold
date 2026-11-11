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
from pathlib import Path
from typing import Final

from freehold_agent.audit import AuditSink, JsonlAuditSink, ModelCallRecord, Purpose
from freehold_agent.authorization import ROOT_IDENTITY_KEY
from freehold_agent.config import AgentConfig
from freehold_agent.context import ContextClient, ContextEntry
from freehold_agent.errors import ContextUnavailable, NoModelBackend, PolicyRefused, ScopeEmpty
from freehold_agent.models.backend import StructuredBackend
from freehold_agent.models.local_llm import LocalLLM
from freehold_agent.models.ollama import OllamaBackend
from freehold_agent.models.openai import OpenAICompatBackend
from freehold_agent.models.spal_bridge import (
    propose_request_context as _propose_request_context,
)
from freehold_agent.policy import POLICIES_SCOPE, PolicyChecker, Requester
from freehold_agent.receipt import RequestLabel
from freehold_agent.scope import in_scope, is_scope
from freehold_agent.spal import RequestContext

logger = logging.getLogger(__name__)

IDENTITY_SCOPE: Final = "identity"
"""The scope the holder's app keeps identity records under; an ask never reads it."""


_PRIVATE_SCOPES: Final = (ROOT_IDENTITY_KEY, IDENTITY_SCOPE, POLICIES_SCOPE)
"""Scopes an ask never reads: the root identity key, identity records, and policy
documents, which carry the holder's root DID as owner and id."""


def is_private_key(key: str) -> bool:
    """Whether an entry key holds material that never goes to a model.

    That is the root identity, anything under the identity scope, or a
    policy document.
    """
    return any(in_scope(key, private) for private in _PRIVATE_SCOPES)


def admits_private(scope: str) -> bool:
    """Whether reading ``scope`` could return a private entry.

    Judged by the reader's own rule: a scope reads itself and what is under
    it. The scope that names the root identity key reads it; the identity
    and policies scopes, any scope inside them, and any scope above them,
    admit their records. All are refused, as is an empty scope.
    """
    if not scope:
        return True
    return any(in_scope(p, scope) or in_scope(scope, p) for p in _PRIVATE_SCOPES)


@dataclass
class AgentResponse:
    """An answer to the holder's ask."""

    content: str
    context_used: list[str]
    rule_id: str
    timestamp: datetime
    # The id of the audit record written before the model was called; None
    # when the holder keeps no record.
    audit_id: str | None = None


class Agent:
    """
    PCI Personal Agent

    Processes queries using local AI while enforcing S-PAL policies
    and retrieving context from the encrypted store.
    """

    def __init__(
        self,
        config: AgentConfig | None = None,
        *,
        context_client: ContextClient | None = None,
        audit: AuditSink | None = None,
    ) -> None:
        """Build the agent over ``context_client``, the app's vault client, or its own.

        A client given is shared: it holds the vault secret the API's unlock
        handed it, and the agent neither unlocks nor disconnects it. ``audit``
        keeps the record of every model call; by default it is the file the
        config names, and none when the config says no record is kept.
        """
        self.config = config or AgentConfig()
        if audit is None and self.config.audit_log is not None:
            audit = JsonlAuditSink(Path(self.config.audit_log))
        self._audit = audit
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

        if self._owns_client:
            try:
                await self._context_client.connect()
            except BaseException:
                # Release any backend resources we just acquired so a retry can
                # start from a clean slate; ``_initialized`` stays False.
                await self._release_backend()
                raise

        self._initialized = True

    async def unlock(self, user_id: str, password: str) -> None:
        """Hand the vault secret to the context client, for an agent that owns its client.

        The API's agent shares the API's client, which ``POST /unlock`` opens;
        an agent built on its own reaches the vault through this.
        """
        await self._context_client.unlock(user_id, password)

    def lock(self) -> None:
        """Forget the vault secret; asks are refused until the next unlock."""
        self._context_client.lock()

    @property
    def is_unlocked(self) -> bool:
        """Whether the context client holds a vault secret."""
        return self._context_client.is_unlocked

    async def ask(self, question: str, policy_name: str, context_scope: str) -> AgentResponse:
        """Answer the holder's question from their own data in ``context_scope``, under a policy.

        In order: a scope that is not a clean path, or that could read
        private material (the root identity key, the identity or policies
        scope, anything under them or any scope above them) is refused before
        anything is read; the
        named policy is read from the vault and must have a rule governing
        the scope whose custody ceiling admits the model server's machine,
        evaluated for the holder; the one entry under the scope's key is
        read, as a claim's scope is on the approval path, and goes to the
        model with the question. Nothing is answered without a matching rule, and a locked
        or unreachable vault is an error, never an answer without context.

        Args:
            question: The holder's question, in their words.
            policy_name: One of the holder's policies, by its vault name.
            context_scope: The scope the question is about, e.g. ``personal/age``.

        Returns:
            The model's answer, the keys of the entries it saw, and the rule
            that permitted the ask.

        Raises:
            PolicyRefused: A scope that is not a clean path or could read
                private material, a policy that cannot be used, or no rule
                for the scope; ``detail`` says which.
            ScopeEmpty: Nothing is stored under the scope.
            ContextUnavailable: The vault is locked or cannot be read.
            NoModelBackend: No model backend is configured or loaded.
            AuditUnavailable: The record of the call could not be written, so
                the call was not made.
        """
        # The cheap refusals first: a bad request never pays for a model load.
        if not is_scope(context_scope):
            raise PolicyRefused("the scope must be a path such as personal/age")
        if admits_private(context_scope):
            raise PolicyRefused("identity scopes are never sent to a model")
        if not self._initialized:
            await self.initialize()
        if not self._has_backend():
            # Nothing is read from the vault for an answer that cannot be made.
            raise NoModelBackend()

        session = self._context_client.session
        stored = await self._policy_checker.policy_named(policy_name)
        result = await self._policy_checker.check(
            stored.policy,
            context_scope,
            RequestContext(),
            Requester.HOLDER,
            custody=self.config.llm.custody,
        )
        if not result.allowed or result.matched_rule_id is None:
            raise PolicyRefused(result.detail or "not permitted")

        # The scope was refused above if it could admit identity material; the
        # key is checked again here so no reader behaviour can leak one. The
        # read is the one entry under the scope's key: an entry under it has
        # its own scope and its own governing rule, and is not read under this one.
        entry = await self._context_client.entry(context_scope)
        if entry is None or is_private_key(entry.key):
            raise ScopeEmpty(f"nothing is stored under scope '{context_scope}'")
        key = await self._context_client.audit_key() if self._audit is not None else None
        if self._context_client.session != session:
            # A lock or unlock landed since the policy was read: one holder's
            # policy must not govern another's data, and one ask spans one
            # vault session, so its record is of the session that read it.
            raise ContextUnavailable("the vault changed hands during the ask")
        keys = [entry.key]
        prompt = self._build_prompt(question, entry)
        record = self._record(
            "ask",
            prompt,
            key,
            policy_id=stored.policy.id,
            rule_id=result.matched_rule_id,
            context_scope=context_scope,
            context_keys=keys,
        )
        audit_id, content = await self._call_model(prompt, record, session)
        return AgentResponse(
            content=content,
            context_used=keys,
            rule_id=result.matched_rule_id,
            timestamp=datetime.now(UTC),
            audit_id=audit_id,
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
            AuditUnavailable: The record of the call could not be written, so
                the call was not made.
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
        # The record covers the description the agent was given; the framing
        # the bridge adds around it is the agent's own text.
        await self._keep(
            self._record(
                "request_context",
                prompt,
                await self._context_client.audit_key() if self._audit is not None else None,
            )
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

    def _has_backend(self) -> bool:
        """Whether a model backend is loaded to answer with."""
        return any(b is not None for b in (self._llm, self._ollama_backend, self._openai_backend))

    def _record(
        self,
        purpose: Purpose,
        prompt: str,
        key: bytes | None,
        *,
        policy_id: str | None = None,
        rule_id: str | None = None,
        context_scope: str | None = None,
        context_keys: list[str] | None = None,
    ) -> ModelCallRecord:
        """The record for a call about to be made, the prompt labelled under ``key``.

        Without a key the record carries no label. A call an operator serves
        under a rule is recorded as unreceipted: no model backend carries a
        terms receipt, so the operator signs for nothing.
        """
        llm = self.config.llm
        label = (
            None
            if key is None
            else RequestLabel.mint(key, llm.operator_did or "", prompt.encode("utf-8"))
        )
        return ModelCallRecord(
            purpose=purpose,
            backend=llm.backend,
            model=llm.resolved_model,
            custody=llm.custody,
            policy_id=policy_id,
            rule_id=rule_id,
            context_scope=context_scope,
            context_keys=tuple(context_keys or ()),
            operator_did=llm.operator_did,
            nonce=None if label is None else label.nonce.hex(),
            commitment=None if label is None else label.commitment.hex(),
            # No model backend carries a receipt, so a rule's call to an operator has none.
            receipt_status=(
                "unreceipted" if rule_id is not None and llm.custody.has_operator else "not_owed"
            ),
        )

    async def _keep(self, record: ModelCallRecord) -> str | None:
        """Write the record and return its id, or None when no record is kept.

        A record that cannot be written raises, so the call it describes is
        never made.
        """
        if self._audit is None:
            return None
        if record.commitment is None:
            logger.info("audit record %s carries no commitment: the vault is locked", record.id)
        await self._audit.record(record)
        return record.id

    async def _call_model(
        self, prompt: str, record: ModelCallRecord, session: int
    ) -> tuple[str | None, str]:
        """Record, then generate: no answer without its record.

        ``session`` is the vault session the prompt's data was read under; if
        it has moved while the record was written, the data is not sent.
        Returns the record's id (None when no record is kept) and the answer.
        """
        audit_id = await self._keep(record)
        if self._context_client.session != session:
            raise ContextUnavailable("the vault changed hands during the ask")
        return audit_id, await self._generate(prompt)

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
    def _build_prompt(question: str, entry: ContextEntry) -> str:
        """The prompt: the entry's fields, one per line, then the question."""
        parts: list[str] = ["Context:"]
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
