"""Seams between the approval service and external systems.

Each Protocol is a narrow interface with a Phase 1 implementation. Phase 2
swaps in the real envelope verifier and richer context handling without
changing the service.
"""

from __future__ import annotations

from typing import Protocol

from freehold_agent.audit import AuditSink
from freehold_agent.context import ContextReader
from freehold_agent.coordination import VerificationRequest
from freehold_agent.custody import Operator
from freehold_agent.policy import PolicyCheckResult, Requester, StoredPolicy
from freehold_agent.spal import (
    AvailableProof,
    IdentityType,
    ProofType,
    RequestContext,
    RequestIdentity,
    SPALPolicy,
)
from freehold_agent.zkp import ZKPResult

__all__ = [
    "AuditSink",
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

    def build(self, request: VerificationRequest, requester_did: str | None) -> RequestContext:
        """Map a verification request, and the DID approving it if any, to a RequestContext."""
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
        *,
        custody: Operator,
    ) -> PolicyCheckResult:
        """Return whether the request is permitted by the policy for that scope.

        ``custody`` is the kind of machine the data would go to; the governing
        rule's ceiling is the whole gate, since a read returns its scope alone.
        """
        ...


class ProofGenerator(Protocol):
    """Generates a zero-knowledge proof for a claim."""

    async def generate(self, proof_type: str, proof_data: dict[str, object]) -> ZKPResult:
        """Produce a proof of the given type over the provided inputs."""
        ...


class ContextStoreDataProvider:
    """PrivateDataProvider over the context store: the one entry under the scope's key.

    The entry's fields are returned as a flat mapping; an absent entry, or
    no scope, is an empty one. Nothing beside or under the scope is read.
    The approval service then picks the fields the claim needs; nothing
    else leaves the agent.
    """

    def __init__(self, client: ContextReader) -> None:
        self._client = client

    async def fetch(self, scope: str | None) -> dict[str, object]:
        """Fetch the scope's fields from the context store.

        Raises:
            ContextUnavailable: The store is locked, unreachable, or cannot be
                decrypted; the message says which.
        """
        if not scope:
            return {}
        entry = await self._client.entry(scope)
        return dict(entry.fields()) if entry is not None else {}


class DeterministicContextBuilder:
    """RequestContextBuilder that states what is true of the request and nothing more.

    ``identity`` is the ephemeral DID the holder's app issued for this
    verification, when the approval carries one; the autonomous path has no
    user action to issue a DID and the agent holds no root key to issue one
    itself, so there it is absent, and a rule that requires an ephemeral
    identity denies an autonomous approval. That is the rule's meaning, not
    a gap. ``proofs`` is the claim's own proof, which the service generates
    on approval. Intended use, retention and payment stay unset: the flow
    makes no offer about them and the business makes none.
    """

    def build(self, request: VerificationRequest, requester_did: str | None) -> RequestContext:
        """The request context for a business's verification request."""
        identity = (
            RequestIdentity(type=IdentityType.EPHEMERAL_REQUIRED, did=requester_did)
            if requester_did is not None
            else None
        )
        return RequestContext(
            identity=identity,
            proofs=[AvailableProof(type=ProofType.ZKP, claim=request.claim.type)],
        )


class PassThroughEnvelopeVerifier:
    """Phase 1 EnvelopeVerifier: accepts every request. Enforced in Phase 2."""

    async def verify(self, headers: dict[str, str], body: bytes) -> None:
        """Accept unconditionally (Phase 1)."""
        return None
