"""Seams between the approval service and external systems.

Each Protocol is a narrow interface with a Phase 1 implementation. Phase 2
swaps in the real envelope verifier and richer context handling without
changing the service.
"""

from __future__ import annotations

from typing import Protocol

from freehold_agent.context import ContextReader
from freehold_agent.coordination import VerificationRequest
from freehold_agent.policy import PolicyCheckResult, Requester, StoredPolicy
from freehold_agent.spal import RequestContext, SPALPolicy
from freehold_agent.zkp import ZKPResult

__all__ = [
    "ContextReader",
    "ContextStoreDataProvider",
    "DeterministicContextBuilder",
    "EnvelopeVerifier",
    "PassThroughEnvelopeVerifier",
    "PolicyCheck",
    "PrivateDataProvider",
    "ProofGenerator",
    "RequestContextBuilder",
]


class PrivateDataProvider(Protocol):
    """Supplies the user's private data for a context scope."""

    async def fetch(self, scope: str | None) -> dict[str, object]:
        """Return the private data needed to prove a claim in this scope."""
        ...


class RequestContextBuilder(Protocol):
    """Builds a policy-evaluation RequestContext from a verification request."""

    def build(self, request: VerificationRequest) -> RequestContext:
        """Map a verification request to a RequestContext for the policy checker."""
        ...


class EnvelopeVerifier(Protocol):
    """Authenticates an inbound agent message."""

    async def verify(self, headers: dict[str, str], body: bytes) -> None:
        """Raise if the request envelope is not authentic. No-op when disabled."""
        ...


class PolicyCheck(Protocol):
    """Reads the holder's policies and evaluates a request against one."""

    async def policy_named(self, name: str) -> StoredPolicy:
        """The holder's policy under ``policies/{name}``; PolicyRefused if it cannot be used."""
        ...

    async def policy_for_terms(self, terms_hash: str) -> StoredPolicy:
        """The holder's policy whose terms hash to ``terms_hash``; raise PolicyRefused if none."""
        ...

    async def check(
        self,
        policy: SPALPolicy,
        context_scope: str,
        request_context: RequestContext,
        requester: Requester,
    ) -> PolicyCheckResult:
        """Return whether the request is permitted by the policy for that scope."""
        ...


class ProofGenerator(Protocol):
    """Generates a zero-knowledge proof for a claim."""

    async def generate(self, proof_type: str, proof_data: dict[str, object]) -> ZKPResult:
        """Produce a proof of the given type over the provided inputs."""
        ...


class ContextStoreDataProvider:
    """PrivateDataProvider backed by the user's context store.

    The scope's entries are merged into one flat mapping of field to value,
    in entry-key order, so a field that two entries both carry takes the
    later entry's value. The approval service then picks the fields the
    claim needs; nothing else leaves the agent.
    """

    def __init__(self, client: ContextReader) -> None:
        self._client = client

    async def fetch(self, scope: str | None) -> dict[str, object]:
        """Fetch the scope's fields from the context store.

        Raises:
            ContextUnavailable: The store is locked, unreachable, or cannot be
                decrypted; the message says which.
        """
        data: dict[str, object] = {}
        for entry in await self._client.entries(scope):
            data.update(entry.fields())
        return data


class DeterministicContextBuilder:
    """Phase 1 RequestContextBuilder: returns an empty RequestContext, no LLM.

    Phase 1 does not populate any RequestContext field from the verification
    request; it always returns an empty context. The natural-language LLM
    path (Agent.propose_request_context) is reserved for free-text requests
    and is intentionally off the autonomous-approval critical path, so the
    flow needs no live model.

    Warning:
        Because the returned context is empty, S-PAL policy rules whose
        conditions depend on request context (e.g. derivative-use or
        retention conditions) short-circuit on the missing values and are
        NOT enforced — they fall through to a conclusive allow. Until
        Phase 2 populates the context, condition-bearing rules must not be
        trusted as a conclusive allow.
    """

    def build(self, request: VerificationRequest) -> RequestContext:
        """Return an empty RequestContext; Phase 1 maps no request fields.

        Warning:
            The empty context causes condition-bearing policy rules
            (derivative-use, retention) to be skipped rather than enforced,
            which falls through to allow. See the class docstring.
        """
        return RequestContext()


class PassThroughEnvelopeVerifier:
    """Phase 1 EnvelopeVerifier: accepts every request. Enforced in Phase 2."""

    async def verify(self, headers: dict[str, str], body: bytes) -> None:
        """Accept unconditionally (Phase 1)."""
        return None
