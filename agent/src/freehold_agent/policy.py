"""S-PAL policy enforcement.

Policies are the holder's data and live in their vault under
``policies/{name}``. The checker reads them through the vault, refuses one
it cannot use, and evaluates a request's scope and context against the
rule that governs it. Nothing is cached: the holder's edit is the next
decision's policy.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from enum import StrEnum
from typing import Final

from pydantic import BaseModel, ValidationError

from freehold_agent.authorization import root_did
from freehold_agent.context import ContextEntry, ContextReader
from freehold_agent.errors import PolicyRefused
from freehold_agent.spal import (
    AccessRule,
    DerivativePermission,
    IdentityType,
    RequestContext,
    SPALPolicy,
)
from freehold_agent.terms import export_terms, terms_hash

logger = logging.getLogger(__name__)

POLICY_KEY_PREFIX: Final = "policies/"
"""Where a holder's policies live in the vault; the owner DID stays inside the value."""

GENERIC_DENIAL: Final = "not permitted by the holder's policy"
"""What a business is told when a policy denies. The specific reason is the holder's."""


def policy_key(name: str) -> str:
    """The vault key of the policy named ``name``."""
    return POLICY_KEY_PREFIX + name


class Requester(StrEnum):
    """Who is asking: a third party that wants the data, or the holder about their own."""

    THIRD_PARTY = "third_party"
    HOLDER = "holder"


@dataclass(frozen=True)
class StoredPolicy:
    """A policy as the vault holds it: the document the holder wrote and its validated form.

    Terms are exported from the document, not from the model, so the bytes a
    business is shown are the holder's own and not pydantic's defaults.
    """

    document: dict[str, object]
    policy: SPALPolicy

    @property
    def terms(self) -> dict[str, object]:
        return export_terms(self.document)

    @property
    def terms_hash(self) -> str:
        return terms_hash(self.document)


class PolicyCheckResult(BaseModel):
    """Result of a policy check.

    ``reason`` is what a business may see; for a denial by policy it is the
    generic denial. ``detail`` says which check failed and is for the holder.
    """

    allowed: bool
    reason: str | None = None
    detail: str | None = None
    policy_id: str | None = None
    matched_rule_id: str | None = None


class PolicyChecker:
    """Reads the holder's policies from the vault and enforces them."""

    def __init__(self, vault: ContextReader) -> None:
        self._vault = vault

    async def policy_named(self, name: str) -> StoredPolicy:
        """The holder's policy under ``policies/{name}``.

        Raises:
            PolicyRefused: No entry, or one that is invalid, not the policy
                named, or not the holder's; ``detail`` says which.
            ContextUnavailable: The vault is locked or unreadable, or its
                root identity cannot be read.
        """
        holder = await root_did(self._vault)
        entry = await self._vault.entry(policy_key(name))
        if entry is None:
            raise _refused(name, "policy not found")
        return _load(entry, name, holder)

    async def policy_for_terms(self, terms: str) -> StoredPolicy:
        """The holder's policy whose exported terms hash to ``terms``.

        Every policy under the prefix is read and hashed, in key order, and
        the first match wins; a holder has a handful. A policy that cannot be
        used is skipped with a warning rather than blocking the others.

        Raises:
            PolicyRefused: No usable policy has these terms.
            ContextUnavailable: As ``policy_named``.
        """
        holder = await root_did(self._vault)
        for entry in sorted(await self._vault.entries(POLICY_KEY_PREFIX), key=lambda e: e.key):
            name = entry.key.removeprefix(POLICY_KEY_PREFIX)
            try:
                stored = _load(entry, name, holder)
            except PolicyRefused:
                continue
            if stored.terms_hash == terms:
                return stored
        raise PolicyRefused("terms do not match any policy")

    async def check(
        self,
        policy: SPALPolicy,
        context_scope: str,
        request_context: RequestContext,
        requester: Requester,
    ) -> PolicyCheckResult:
        """Whether the request is permitted by ``policy`` for ``context_scope``.

        The most specific rule covering the scope decides; no rule is a
        denial. For a third party every condition of the rule is evaluated
        against the request context. For the holder asking about their own
        data, the identity, proof, derivative, retention and payment
        conditions describe a third party and are satisfied by definition;
        the rule still has to exist.
        """
        matching = _matching_rules(policy, context_scope)
        if not matching:
            return PolicyCheckResult(
                allowed=False,
                reason=GENERIC_DENIAL,
                detail=f"no rule governs scope '{context_scope}'",
                policy_id=policy.id,
            )
        rule = max(matching, key=lambda r: len(r.context_scope))
        if requester is Requester.HOLDER:
            return PolicyCheckResult(
                allowed=True,
                reason="the holder's own access",
                policy_id=policy.id,
                matched_rule_id=rule.id,
            )
        return _evaluate_conditions(rule, policy.id, request_context)


def _refused(name: str, detail: str) -> PolicyRefused:
    logger.warning("policy %s: %s", policy_key(name), detail)
    return PolicyRefused(detail)


def _load(entry: ContextEntry, name: str, holder: str) -> StoredPolicy:
    """The policy in ``entry``, if it is valid, is the one named, and is the holder's."""
    try:
        policy = SPALPolicy.model_validate(entry.data)
    except ValidationError as exc:
        # Field paths name what is wrong; the values are the vault's and stay in it.
        paths = sorted({".".join(str(part) for part in error["loc"]) for error in exc.errors()})
        raise _refused(name, "policy is not valid: " + ", ".join(paths)) from exc
    if policy.key_name != name:
        raise _refused(name, "policy is not the one named")
    if policy.owner != holder:
        raise _refused(name, "policy is not the holder's")
    assert isinstance(entry.data, dict)  # model_validate accepted it, so it is an object
    return StoredPolicy(document=entry.data, policy=policy)


def _matching_rules(policy: SPALPolicy, context_scope: str) -> list[AccessRule]:
    """Rules whose context_scope covers the requested scope."""
    return [
        rule
        for rule in policy.rules
        if context_scope == rule.context_scope or context_scope.startswith(rule.context_scope + "/")
    ]


def _denied(rule: AccessRule, policy_id: str, detail: str) -> PolicyCheckResult:
    return PolicyCheckResult(
        allowed=False,
        reason=GENERIC_DENIAL,
        detail=detail,
        policy_id=policy_id,
        matched_rule_id=rule.id,
    )


def _evaluate_conditions(
    rule: AccessRule, policy_id: str, ctx: RequestContext
) -> PolicyCheckResult:
    """Evaluate a rule's conditions against a third party's request context."""
    conditions = rule.conditions

    if conditions.identity is not None:
        id_req = conditions.identity
        if id_req.type == IdentityType.EPHEMERAL_REQUIRED:
            if ctx.identity is None:
                return _denied(rule, policy_id, "Ephemeral identity required but none provided")
            if ctx.identity.type != IdentityType.EPHEMERAL_REQUIRED:
                return _denied(
                    rule,
                    policy_id,
                    f"Ephemeral identity required but got '{ctx.identity.type}'",
                )

    available_claims = {(p.type, p.claim) for p in ctx.proofs}
    for proof_req in conditions.proofs:
        if (proof_req.type, proof_req.claim) not in available_claims:
            return _denied(
                rule,
                policy_id,
                f"Missing required proof: {proof_req.type} for '{proof_req.claim}'",
            )

    if conditions.derivatives is not None and ctx.intended_use is not None:
        derivs = conditions.derivatives
        use = ctx.intended_use
        if use.training and derivs.training == DerivativePermission.FORBIDDEN:
            return _denied(rule, policy_id, "Training use is forbidden by policy")
        if use.aggregation and derivs.aggregation == DerivativePermission.FORBIDDEN:
            return _denied(rule, policy_id, "Aggregation is forbidden by policy")
        if use.resale and derivs.resale == DerivativePermission.FORBIDDEN:
            return _denied(rule, policy_id, "Resale is forbidden by policy")

    if (
        conditions.retention is not None
        and ctx.offered_retention_seconds is not None
        and ctx.offered_retention_seconds > conditions.retention.max_seconds
    ):
        return _denied(
            rule,
            policy_id,
            f"Offered retention ({ctx.offered_retention_seconds}s) exceeds "
            f"maximum ({conditions.retention.max_seconds}s)",
        )

    if conditions.payment is not None and not ctx.payment_offered:
        return _denied(
            rule,
            policy_id,
            f"Payment required: {conditions.payment.amount} {conditions.payment.currency}",
        )

    return PolicyCheckResult(
        allowed=True,
        reason="All conditions met",
        policy_id=policy_id,
        matched_rule_id=rule.id,
    )
