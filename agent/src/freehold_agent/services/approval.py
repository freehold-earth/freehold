"""Autonomous approval orchestration.

ApprovalService.decide is a pure evaluation over injected seams: it consults
policy fail-closed, and only on a conclusive allow does it fetch private data
and generate a proof. Mapping the outcome to a stored status given the
approval mode is a separate pure function so both are independently testable.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import UTC, datetime

from freehold_agent.coordination import (
    ApprovalDecision,
    ApprovalMode,
    DecisionOutcome,
    RequestStatus,
    VerificationRequest,
)
from freehold_agent.errors import ContextUnavailable, ZKPUnavailable
from freehold_agent.seams import (
    PolicyCheck,
    PrivateDataProvider,
    ProofGenerator,
    RequestContextBuilder,
)


@dataclass(frozen=True)
class _ClaimInputs:
    """What a claim type's proof draws on: the scope read, the fields sent,
    and whether the proof can be bound to the requester's ephemeral DID."""

    scope: str
    fields: tuple[str, ...]
    binds_requester: bool = True


CLAIM_INPUTS: dict[str, _ClaimInputs] = {
    "age": _ClaimInputs(scope="personal/age", fields=("birthDate",)),
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
    ) -> None:
        """Wire the seams a decision needs: policy, context, private data, and ZKP.

        Args:
            policy_checker: Evaluates the request's policy_id/context_scope.
            context_builder: Builds the RequestContext used for condition evaluation.
            data_provider: Fetches the private data needed to prove the claim.
            zkp_client: Generates the zero-knowledge proof for an allowed claim.
        """
        self._policy = policy_checker
        self._builder = context_builder
        self._data = data_provider
        self._zkp = zkp_client

    async def decide(self, request: VerificationRequest) -> ApprovalDecision:
        """Evaluate a request fail-closed; generate a proof only on a real allow.

        Args:
            request: The verification request to evaluate.

        Returns:
            The decision: DENY without consulting policy if already expired or
            the claim type is unsupported, ERROR if private data or proof
            generation is unavailable, REJECT if policy allows but the
            generated proof does not verify, otherwise APPROVE or DENY per the
            policy result. The policy is evaluated against the scope the claim
            type reads, never against the scope the request names.
        """
        if (refusal := _refuse(request)) is not None:
            return refusal

        if request.policy_id is None:
            return ApprovalDecision(outcome=DecisionOutcome.DENY, reason="no policy configured")

        inputs = CLAIM_INPUTS[request.claim.type]
        context = self._builder.build(request)
        result = await self._policy.check(
            request.policy_id,
            request.claim.type,
            context_scope=inputs.scope,
            request_context=context,
        )

        # Fail-closed: only a matched rule that evaluated its conditions counts.
        # A default allow (no matched_rule_id) must not auto-approve.
        if not (result.allowed and result.matched_rule_id is not None):
            return ApprovalDecision(
                outcome=DecisionOutcome.DENY,
                reason=result.reason or "not permitted by policy",
                matched_rule_id=result.matched_rule_id,
            )

        try:
            private_data = await self._data.fetch(inputs.scope)
        except ContextUnavailable as exc:
            logger.warning("request %s: %s", request.id, exc)
            return ApprovalDecision(
                outcome=DecisionOutcome.ERROR,
                reason=PRIVATE_DATA_UNAVAILABLE,
                matched_rule_id=result.matched_rule_id,
            )

        return await self._generate_proof(
            request, private_data, matched_rule_id=result.matched_rule_id
        )

    async def approve(
        self, request: VerificationRequest, requester_did: str | None = None
    ) -> ApprovalDecision:
        """Generate a proof for a request a human has already approved.

        Skips the policy gate entirely: a human's explicit approval is the
        authorization. Private data is sourced from the context store, same
        as the autonomous path, so it never travels through the request body,
        and the claim type alone decides which scope is read.

        Binding (decided 2026-11-05, #107): a human approval may carry the
        ephemeral DID the user's app issued for this verification, and the
        proof is then bound to it. The autonomous path has no user action to
        supply one, so an autonomous proof carries no binding and the
        decision says so with requester_did None; the agent holds no signing
        key of its own in this phase. An agent-issued DID stays a later option.

        Args:
            request: The verification request being resolved.
            requester_did: The ephemeral DID to bind the proof to, if any.

        Returns:
            The decision: DENY if the request has already expired, ERROR if
            private data or proof generation is unavailable, REJECT if the
            generated proof does not verify, otherwise APPROVE.
        """
        if (refusal := _refuse(request)) is not None:
            return refusal

        try:
            private_data = await self._data.fetch(CLAIM_INPUTS[request.claim.type].scope)
        except ContextUnavailable as exc:
            logger.warning("request %s: %s", request.id, exc)
            return ApprovalDecision(outcome=DecisionOutcome.ERROR, reason=PRIVATE_DATA_UNAVAILABLE)
        return await self._generate_proof(request, private_data, requester_did=requester_did)

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
            requester_did: The ephemeral DID to bind the proof to; sent as
                ``requesterDid`` when the claim type binds, and recorded on
                the decision so the business can see what the proof names.

        Returns:
            ERROR if a needed field is missing or the ZKP service is
            unavailable, otherwise APPROVE or REJECT per whether the
            generated proof verifies.
        """
        required = CLAIM_INPUTS[request.claim.type].fields
        missing = [field for field in required if private_data.get(field) in (None, "")]
        # A business-supplied requesterDid never reaches the proof: binding is
        # the user's app's to assert, through the approval, not the claim's.
        private_data = {k: v for k, v in private_data.items() if k != "requesterDid"}
        request = request.model_copy(
            update={
                "claim": request.claim.model_copy(
                    update={
                        "params": {
                            k: v for k, v in request.claim.params.items() if k != "requesterDid"
                        }
                    }
                )
            }
        )
        if missing:
            logger.warning("request %s: private data missing %s", request.id, ", ".join(missing))
            return ApprovalDecision(
                outcome=DecisionOutcome.ERROR,
                reason=PRIVATE_DATA_UNAVAILABLE,
                matched_rule_id=matched_rule_id,
            )
        inputs = CLAIM_INPUTS[request.claim.type]
        bound_to = requester_did if inputs.binds_requester else None
        proof_data = {**request.claim.params, **{f: private_data[f] for f in required}}
        if bound_to is not None:
            proof_data["requesterDid"] = bound_to
        try:
            zkp = await self._zkp.generate(request.claim.type, proof_data)
        except ZKPUnavailable:
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
            requester_did=bound_to,
        )


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
