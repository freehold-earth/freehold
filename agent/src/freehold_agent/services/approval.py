"""Autonomous approval orchestration.

ApprovalService.decide is a pure evaluation over injected seams: it consults
policy fail-closed, and only on a conclusive allow does it fetch private data
and generate a proof. Mapping the outcome to a stored status given the
approval mode is a separate pure function so both are independently testable.
"""

from __future__ import annotations

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
class ClaimInputs:
    """What a claim type's proof draws on: the scope read, and the fields sent."""

    scope: str
    fields: tuple[str, ...]


CLAIM_INPUTS: dict[str, ClaimInputs] = {
    "age": ClaimInputs(scope="personal/age", fields=("birthDate",)),
}
"""The private data each supported claim type needs, decided here, not by
the business: a request's own context_scope is policy input and never
chooses what is read. Only the listed fields reach the ZKP service, whatever
else the scope holds; an unlisted claim type is denied before any read."""


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
            The decision: DENY without consulting policy if already expired,
            ERROR if private data or proof generation is unavailable, REJECT if
            policy allows but the generated proof does not verify, otherwise
            APPROVE or DENY per the policy result.
        """
        if request.expires_at <= datetime.now(UTC):
            return ApprovalDecision(outcome=DecisionOutcome.DENY, reason="request expired")

        if request.claim.type not in CLAIM_INPUTS:
            return ApprovalDecision(
                outcome=DecisionOutcome.DENY,
                reason=f"unsupported claim type: {request.claim.type}",
            )

        if request.policy_id is None:
            return ApprovalDecision(outcome=DecisionOutcome.DENY, reason="no policy configured")

        context = self._builder.build(request)
        result = await self._policy.check(
            request.policy_id,
            request.claim.type,
            context_scope=request.context_scope,
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
            private_data = await self._data.fetch(CLAIM_INPUTS[request.claim.type].scope)
        except ContextUnavailable as exc:
            return ApprovalDecision(
                outcome=DecisionOutcome.ERROR,
                reason=f"private data unavailable: {exc}",
                matched_rule_id=result.matched_rule_id,
            )

        return await self._generate_proof(
            request, private_data, matched_rule_id=result.matched_rule_id
        )

    async def approve(self, request: VerificationRequest) -> ApprovalDecision:
        """Generate a proof for a request a human has already approved.

        Skips the policy gate entirely: a human's explicit approval is the
        authorization. Private data is sourced from the context store, same
        as the autonomous path, so it never travels through the request body,
        and the claim type alone decides which scope is read.

        Args:
            request: The verification request being resolved.

        Returns:
            The decision: DENY if the request has already expired, ERROR if
            private data or proof generation is unavailable, REJECT if the
            generated proof does not verify, otherwise APPROVE.
        """
        if request.expires_at <= datetime.now(UTC):
            return ApprovalDecision(outcome=DecisionOutcome.DENY, reason="request expired")

        if request.claim.type not in CLAIM_INPUTS:
            return ApprovalDecision(
                outcome=DecisionOutcome.DENY,
                reason=f"unsupported claim type: {request.claim.type}",
            )

        try:
            private_data = await self._data.fetch(CLAIM_INPUTS[request.claim.type].scope)
        except ContextUnavailable as exc:
            return ApprovalDecision(
                outcome=DecisionOutcome.ERROR, reason=f"private data unavailable: {exc}"
            )
        return await self._generate_proof(request, private_data)

    async def _generate_proof(
        self,
        request: VerificationRequest,
        private_data: dict[str, object],
        *,
        matched_rule_id: str | None = None,
    ) -> ApprovalDecision:
        """Generate and evaluate a proof for the request's claim.

        Args:
            request: The verification request whose claim is being proved.
            private_data: The claim's scope, as fields; only those the claim
                type needs (CLAIM_INPUTS) are sent, and they override any
                same-named claim parameter the business supplied.
            matched_rule_id: The policy rule that authorized this proof, if any.

        Returns:
            ERROR if a needed field is missing or the ZKP service is
            unavailable, otherwise APPROVE or REJECT per whether the
            generated proof verifies.
        """
        required = CLAIM_INPUTS[request.claim.type].fields
        missing = [field for field in required if field not in private_data]
        if missing:
            return ApprovalDecision(
                outcome=DecisionOutcome.ERROR,
                reason=f"private data incomplete: missing {', '.join(missing)}",
                matched_rule_id=matched_rule_id,
            )
        proof_data = {**request.claim.params, **{f: private_data[f] for f in required}}
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
        )


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
