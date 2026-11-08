"""Autonomous approval orchestration.

ApprovalService.decide and ApprovalService.approve are evaluations over
injected seams: both consult the holder's policy fail-closed, and only on a
conclusive allow do they fetch private data and generate a proof. The
difference between them is what the request context can truthfully state:
the button path carries the ephemeral DID the holder's app issued, the
autonomous path has none. Mapping the outcome to a stored status given the
approval mode is a separate pure function so both are independently testable.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Final

from freehold_agent.coordination import (
    ApprovalDecision,
    ApprovalMode,
    DecisionOutcome,
    RequestStatus,
    VerificationRequest,
)
from freehold_agent.custody import Operator
from freehold_agent.errors import ContextUnavailable, PolicyRefused, ZKPUnavailable
from freehold_agent.policy import GENERIC_DENIAL, Requester
from freehold_agent.seams import (
    PolicyCheck,
    PrivateDataProvider,
    ProofGenerator,
    RequestContextBuilder,
)


@dataclass(frozen=True)
class ClaimInputs:
    """What a claim type's proof draws on.

    The scope read, the private fields sent, and the claim params a business
    may supply. Any other param is refused at request creation and, should
    one be stored anyway, left out of the proof inputs, so nothing a business
    sends reaches the proof unlisted.
    """

    scope: str
    fields: tuple[str, ...]
    params: tuple[str, ...]


CLAIM_INPUTS: Final[Mapping[str, ClaimInputs]] = {
    "age": ClaimInputs(scope="personal/age", fields=("birthDate",), params=("minAge",)),
}
"""The private data each supported claim type needs, decided here, not by
the business: the claim's scope is both what the policy is evaluated against
and what is read, so a request's own context_scope cannot steer either. Only
the listed fields reach the ZKP service, whatever else the scope holds; an
unlisted claim type is denied before any read."""

PRIVATE_DATA_UNAVAILABLE = "private data unavailable"
"""The business-facing reason whenever the user's data cannot be read or is
incomplete. The cause (locked vault, unreachable store, missing field) is
about the user's side and is logged here instead of stored on the request,
which both parties can read."""

logger = logging.getLogger(__name__)


class ApprovalService:
    """Evaluates a verification request into an ApprovalDecision."""

    def __init__(
        self,
        policy_checker: PolicyCheck,
        context_builder: RequestContextBuilder,
        data_provider: PrivateDataProvider,
        zkp_client: ProofGenerator,
        *,
        zkp_custody: Operator = Operator.OWNED_HARDWARE,
    ) -> None:
        """Wire the seams a decision needs: policy, context, private data, and ZKP.

        Args:
            policy_checker: Resolves the terms a business accepted to the holder's
                policy and evaluates the claim's scope against it.
            context_builder: Builds the RequestContext used for condition evaluation.
            data_provider: Fetches the private data needed to prove the claim.
            zkp_client: Generates the zero-knowledge proof for an allowed claim.
            zkp_custody: Whose machine the proof service runs on. Making a
                proof handles the raw data, so a rule's custody ceiling binds
                it; the holder's own stack by default.
        """
        self._policy = policy_checker
        self._builder = context_builder
        self._data = data_provider
        self._zkp = zkp_client
        self._zkp_custody = zkp_custody

    async def decide(self, request: VerificationRequest) -> ApprovalDecision:
        """Evaluate a request fail-closed; generate a proof only on a real allow.

        Args:
            request: The verification request to evaluate.

        Returns:
            The decision: DENY without consulting policy if already expired or
            the claim type is unsupported, DENY if the terms match no policy
            of the holder's or the policy denies, ERROR if the vault or proof
            generation is unavailable, REJECT if policy allows but the
            generated proof does not verify, otherwise APPROVE. The policy is
            evaluated against the scope the claim type reads, never against
            the scope the request names. No DID is present on this path, so
            a rule requiring an ephemeral identity denies here.
        """
        if (refusal := _refuse(request)) is not None:
            return refusal
        denial, matched_rule_id = await self._permitted(request, None)
        if denial is not None:
            return denial
        return await self._prove(request, matched_rule_id=matched_rule_id)

    async def approve(
        self, request: VerificationRequest, requester_did: str | None = None
    ) -> ApprovalDecision:
        """Resolve a request a human has approved: the policy decides, then a proof is made.

        The human's approval is consent within the holder's standing rule,
        not around it: the same policy gate as ``decide`` runs first, with the
        ephemeral DID the holder's app issued in the request context, so a
        rule that requires an ephemeral identity is satisfied here and not on
        the autonomous path. Private data is sourced from the context store,
        same as the autonomous path, and the claim type alone decides which
        scope is read.

        Naming the requester (decided 2026-11-05, #107): the proof names the
        DID the app issued. The API layer accepts a DID only with its
        holder's signature over this request and a record in the unlocked
        vault that the vault's root issued it (#110, #18); the ZKP service
        commits the circuit to it. The record itself never leaves the vault.

        Args:
            request: The verification request being resolved.
            requester_did: The ephemeral DID the proof is for, if any; its
                holder's signature has already been checked.

        Returns:
            As ``decide``, with the DID in the context and named by the proof.
        """
        if (refusal := _refuse(request)) is not None:
            return refusal
        denial, matched_rule_id = await self._permitted(request, requester_did)
        if denial is not None:
            return denial
        return await self._prove(
            request, matched_rule_id=matched_rule_id, requester_did=requester_did
        )

    async def _permitted(
        self, request: VerificationRequest, requester_did: str | None
    ) -> tuple[ApprovalDecision | None, str | None]:
        """The policy gate both paths share: a denial, or the rule that permits.

        The terms the business accepted resolve to one of the holder's stored
        policies; that policy's rule for the claim's scope is evaluated
        against what is true of this request. The business-facing reason of
        a denial is generic; the holder-facing detail says which check
        failed. An unreadable vault is ERROR with the cause logged, as for
        private data.
        """
        inputs = CLAIM_INPUTS[request.claim.type]
        try:
            stored = await self._policy.policy_for_terms(request.terms_hash)
            context = self._builder.build(request, requester_did)
            result = await self._policy.check(
                stored.policy,
                inputs.scope,
                context,
                Requester.THIRD_PARTY,
                custody=self._zkp_custody,
            )
        except PolicyRefused as exc:
            logger.warning("request %s: %s", request.id, exc.detail)
            return ApprovalDecision(
                outcome=DecisionOutcome.DENY, reason=GENERIC_DENIAL, detail=exc.detail
            ), None
        except ContextUnavailable as exc:
            logger.warning("request %s: %s", request.id, exc)
            return ApprovalDecision(
                outcome=DecisionOutcome.ERROR, reason=PRIVATE_DATA_UNAVAILABLE
            ), None

        # An allowed result always names its rule (PolicyCheckResult refuses otherwise).
        if not result.allowed:
            logger.warning("request %s: %s", request.id, result.detail or result.reason)
            return ApprovalDecision(
                outcome=DecisionOutcome.DENY,
                reason=GENERIC_DENIAL,
                detail=result.detail,
                matched_rule_id=result.matched_rule_id,
            ), None
        return None, result.matched_rule_id

    async def _prove(
        self,
        request: VerificationRequest,
        *,
        matched_rule_id: str | None,
        requester_did: str | None = None,
    ) -> ApprovalDecision:
        """Read the claim's private data and generate its proof."""
        try:
            private_data = await self._data.fetch(CLAIM_INPUTS[request.claim.type].scope)
        except ContextUnavailable as exc:
            logger.warning("request %s: %s", request.id, exc)
            return ApprovalDecision(
                outcome=DecisionOutcome.ERROR,
                reason=PRIVATE_DATA_UNAVAILABLE,
                matched_rule_id=matched_rule_id,
            )
        return await self._generate_proof(
            request, private_data, matched_rule_id=matched_rule_id, requester_did=requester_did
        )

    async def _generate_proof(
        self,
        request: VerificationRequest,
        private_data: dict[str, object],
        *,
        matched_rule_id: str | None = None,
        requester_did: str | None = None,
    ) -> ApprovalDecision:
        """Generate and evaluate a proof for the request's claim.

        Args:
            request: The verification request whose claim is being proved.
            private_data: The claim's scope, as fields; only those the claim
                type needs (CLAIM_INPUTS) are sent, and they override any
                same-named claim parameter the business supplied.
            matched_rule_id: The policy rule that authorized this proof, if any.
            requester_did: The ephemeral DID the proof should name, sent as
                ``requesterDid``. The proof's public signals must name
                exactly this DID (or none when none was asked for): the
                holder signed for that DID and the circuit commits to what
                it names, so a proof for any other DID is not the one that
                was approved.

        Returns:
            ERROR if a needed field is missing, the ZKP service is
            unavailable, or the proof names a DID other than the one asked
            for; otherwise APPROVE or REJECT per whether the generated proof
            verifies.
        """
        required = CLAIM_INPUTS[request.claim.type].fields
        missing = [field for field in required if private_data.get(field) in (None, "")]
        if missing:
            logger.warning("request %s: private data missing %s", request.id, ", ".join(missing))
            return ApprovalDecision(
                outcome=DecisionOutcome.ERROR,
                reason=PRIVATE_DATA_UNAVAILABLE,
                matched_rule_id=matched_rule_id,
            )
        inputs = CLAIM_INPUTS[request.claim.type]
        proof_data = _proof_inputs(request.claim.params, private_data, inputs, requester_did)
        try:
            zkp = await self._zkp.generate(request.claim.type, proof_data)
        except ZKPUnavailable:
            return ApprovalDecision(
                outcome=DecisionOutcome.ERROR,
                reason="verification unavailable",
                matched_rule_id=matched_rule_id,
            )

        named = _named_requester(zkp.proof)
        if named != requester_did:
            logger.error(
                "request %s: proof names %r, not the %r it was asked to; not stored",
                request.id,
                named,
                requester_did,
            )
            return ApprovalDecision(
                outcome=DecisionOutcome.ERROR,
                reason="verification unavailable",
                matched_rule_id=matched_rule_id,
            )
        outcome = DecisionOutcome.APPROVE if zkp.verified else DecisionOutcome.REJECT
        reason = "verified" if zkp.verified else "criteria not met"
        return ApprovalDecision(
            outcome=outcome,
            reason=reason,
            matched_rule_id=matched_rule_id,
            proof=zkp.proof,
            requester_did=named,
        )


def _proof_inputs(
    params: dict[str, object],
    private_data: dict[str, object],
    inputs: ClaimInputs,
    requester_did: str | None,
) -> dict[str, object]:
    """The body sent to the ZKP service: the claim params the type lists, the
    required private fields, and the DID the proof should name, if any.
    Naming the requester is the user's app's to assert, through the
    approval, which is why it is not a claim param."""
    body: dict[str, object] = {k: v for k, v in params.items() if k in inputs.params}
    body.update({f: private_data[f] for f in inputs.fields})
    if requester_did is not None:
        body["requesterDid"] = requester_did
    return body


def _named_requester(proof: object) -> str | None:
    """The DID the proof carries in its public signals, which must be the one
    that was asked for before the proof is stored."""
    if not isinstance(proof, dict):
        return None
    signals = proof.get("publicSignals")
    named = signals.get("requesterDid") if isinstance(signals, dict) else None
    return named if isinstance(named, str) and named else None


def _refuse(request: VerificationRequest) -> ApprovalDecision | None:
    """The DENY both paths share, before anything is consulted or read.

    An expired request, or one whose claim type has no inputs here, is
    refused the same way whether a policy or a human would otherwise decide.
    """
    if request.expires_at <= datetime.now(UTC):
        return ApprovalDecision(outcome=DecisionOutcome.DENY, reason="request expired")
    if request.claim.type not in CLAIM_INPUTS:
        return ApprovalDecision(
            outcome=DecisionOutcome.DENY, reason=f"unsupported claim type: {request.claim.type}"
        )
    return None


def status_for(outcome: DecisionOutcome, mode: ApprovalMode) -> RequestStatus:
    """Map an evaluation outcome to a stored status given the approval mode.

    Args:
        outcome: The pure evaluation result from ApprovalService.decide.
        mode: The business's configured approval mode.

    Returns:
        The RequestStatus to persist. A DENY is escalated to a human under
        auto-with-notification mode; otherwise it is recorded as denied.
    """
    if outcome is DecisionOutcome.APPROVE:
        return RequestStatus.APPROVED
    if outcome is DecisionOutcome.REJECT:
        return RequestStatus.REJECTED
    if outcome is DecisionOutcome.ERROR:
        return RequestStatus.ERROR
    # DENY: a human may still resolve it under auto-with-notification.
    if mode is ApprovalMode.AUTO_WITH_NOTIFICATION:
        return RequestStatus.ESCALATED
    return RequestStatus.DENIED


def resolved_status_for(outcome: DecisionOutcome) -> RequestStatus:
    """Map a human-resolution outcome to a terminal stored status.

    Unlike status_for, this never escalates: the manual approve and deny
    endpoints record a human's final decision, so a denied outcome becomes
    DENIED rather than being bounced back to ESCALATED.

    Args:
        outcome: The evaluation result of a human-approved request.

    Returns:
        The terminal RequestStatus to persist.
    """
    if outcome is DecisionOutcome.APPROVE:
        return RequestStatus.APPROVED
    if outcome is DecisionOutcome.REJECT:
        return RequestStatus.REJECTED
    if outcome is DecisionOutcome.ERROR:
        return RequestStatus.ERROR
    return RequestStatus.DENIED
