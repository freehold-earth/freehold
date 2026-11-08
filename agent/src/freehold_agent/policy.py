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

from pydantic import BaseModel, ValidationError, model_validator

from freehold_agent.authorization import root_did
from freehold_agent.context import ContextEntry, ContextReader, in_domain, scope_domain
from freehold_agent.custody import Operator
from freehold_agent.errors import PolicyRefused
from freehold_agent.spal import (
    DEFAULT_CUSTODY,
    AccessRule,
    DerivativePermission,
    IdentityType,
    RequestContext,
    SPALPolicy,
)
from freehold_agent.terms import export_terms, rule_order_key, rule_terms, terms_hash

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
    """A policy as the vault holds it: the document the holder wrote, its validated
    form, and its terms, exported once.

    Terms come from the document, not from the model, so the bytes a business
    is shown are the holder's own and not pydantic's defaults.
    """

    document: dict[str, object]
    policy: SPALPolicy
    terms: dict[str, object]
    """What a business is shown: the document's contractual content, by allowlist."""
    terms_hash: str
    """SHA-256 of the canonical JSON of ``terms``; what a business accepts and echoes."""


class PolicyCheckResult(BaseModel):
    """Result of a policy check.

    ``reason`` is what a business may see, and every result carries one; for
    a denial by policy it is the generic denial. ``detail`` says which check
    failed and is for the holder. An allow always names the rule that
    permitted it: there is no default allow, and this type refuses to
    represent one.
    """

    allowed: bool
    reason: str
    detail: str | None = None
    policy_id: str | None = None
    matched_rule_id: str | None = None

    @model_validator(mode="after")
    def _an_allow_names_its_rule(self) -> PolicyCheckResult:
        """Fail closed at the type: ``allowed`` without a ``matched_rule_id`` is not a result."""
        if self.allowed and self.matched_rule_id is None:
            raise ValueError("an allowed result must carry the matched_rule_id that permitted it")
        return self


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

    async def policy_for_terms(self, terms_hash: str) -> StoredPolicy:
        """The holder's policy whose exported terms hash to ``terms_hash``.

        Every policy under the prefix is read and hashed, in key order, and
        the first match wins: one read and one export per stored policy per
        decision, which a holder's handful of policies affords and which
        keeps the holder's latest edit the one that decides. A policy that
        cannot be used is skipped with a warning rather than blocking the
        others, and counted in the detail when nothing matches.

        Raises:
            PolicyRefused: No usable policy has these terms.
            ContextUnavailable: As ``policy_named``.
        """
        holder = await root_did(self._vault)
        unusable = 0
        for entry in sorted(await self._vault.entries(POLICY_KEY_PREFIX), key=lambda e: e.key):
            if not entry.key.startswith(POLICY_KEY_PREFIX):
                continue  # The reader's domain admits ``policies-x`` too; only the prefix counts.
            name = entry.key.removeprefix(POLICY_KEY_PREFIX)
            try:
                stored = _load(entry, name, holder)
            except PolicyRefused:
                unusable += 1
                continue
            if stored.terms_hash == terms_hash:
                return stored
        detail = "terms do not match any policy"
        if unusable:
            noun = "policy" if unusable == 1 else "policies"
            detail += f" ({unusable} stored {noun} could not be used)"
        raise PolicyRefused(detail)

    def domain_custody_denial(
        self, policy: SPALPolicy, context_scope: str, machine: Operator
    ) -> str | None:
        """Why a read of ``context_scope``'s whole domain may not go to ``machine``, or None.

        The store keys entries by domain, so a read for one scope returns the
        domain's entries, including data other rules on that domain govern.
        Every such rule's custody ceiling (the default for a silent one) must
        admit the machine, or the read would carry data past a ceiling the
        holder set. Which rules count is decided by the reader's own
        membership test, in both directions: a read of ``personal`` admits
        keys under ``personal-health``, and a read of ``personal-health``
        is inside ``personal``. The detail names the first rule that keeps
        its data closer, or that requires attestation. The decision is
        canonical, since any blocking rule denies; the detail names the first
        blocking rule in the order the holder wrote them.

        Args:
            policy: The holder's policy, as loaded from the vault.
            context_scope: The scope being read; its domain is what is returned.
            machine: The rung of the machine the data would go to.

        Returns:
            The holder-facing detail of the denial, or None when every rule on
            the domain admits the machine.
        """
        domain = scope_domain(context_scope)
        for rule in policy.rules:
            rule_domain = scope_domain(rule.context_scope)
            if not (in_domain(rule_domain, domain) or in_domain(domain, rule_domain)):
                continue
            ceiling = rule.conditions.custody or DEFAULT_CUSTODY
            if machine.rank > ceiling.operator.rank:
                return (
                    f"custody: this reads the '{domain}' data, and rule '{rule.id}' for "
                    f"'{rule.context_scope}' keeps its data no further than "
                    f"{ceiling.operator.value}; {machine.value} is further"
                )
            if ceiling.attestation_required:
                return (
                    f"custody: this reads the '{domain}' data, and rule '{rule.id}' for "
                    f"'{rule.context_scope}' requires attestation, which none can verify yet"
                )
        return None

    async def check(
        self,
        policy: SPALPolicy,
        context_scope: str,
        request_context: RequestContext,
        requester: Requester,
        *,
        custody: Operator,
    ) -> PolicyCheckResult:
        """Whether the request is permitted by ``policy`` for ``context_scope``.

        The most specific rule covering the scope decides; no rule is a
        denial. Custody is checked first against the kind of machine the data
        would go to, for the holder and a third party alike: the governing
        rule's ceiling, and then every rule on the scope's domain, since a
        read returns the whole domain (``domain_custody_denial``). Then, for a third
        party, every other condition of the rule is evaluated against the
        request context. For the holder asking about their own data, the
        identity, proof, derivative, retention and payment conditions describe
        a third party and are satisfied by definition.

        Args:
            policy: The holder's policy, as loaded from the vault.
            context_scope: The scope the request is about.
            request_context: What is true of the request; ignored for the holder.
            requester: Who is asking.
            custody: The rung of the machine the data would go to: the model
                server for an ask, the proof service for an approval.

        Returns:
            An allow naming the rule, or a denial with the generic reason and
            the holder-facing detail.
        """
        matching = _matching_rules(policy, context_scope)
        if not matching:
            return PolicyCheckResult(
                allowed=False,
                reason=GENERIC_DENIAL,
                detail=f"no rule governs scope '{context_scope}'",
                policy_id=policy.id,
            )
        rule = _governing(matching)
        if (denied := _custody_denial(rule, policy.id, custody)) is not None:
            return denied
        # A read for one scope returns its whole domain, so every rule on the
        # domain must admit the machine too; one call is the whole gate. The
        # walk covers the governing rule again; its own check above stays for
        # the more direct message when it is the one that blocks.
        if (detail := self.domain_custody_denial(policy, context_scope, custody)) is not None:
            return _denied(rule, policy.id, detail)
        if requester is Requester.HOLDER:
            return PolicyCheckResult(
                allowed=True,
                reason="the holder's own access",
                policy_id=policy.id,
                matched_rule_id=rule.id,
            )
        return _evaluate_conditions(rule, policy.id, request_context)


def _refused(name: str, detail: str) -> PolicyRefused:
    """The refusal to raise, logged on the holder's side first."""
    logger.warning("policy %s: %s", policy_key(name), detail)
    return PolicyRefused(detail)


def _load(entry: ContextEntry, name: str, holder: str) -> StoredPolicy:
    """The policy in ``entry``, if it is valid, is the one named, and is the holder's."""
    try:
        policy = SPALPolicy.model_validate(entry.data)
    except ValidationError as exc:
        raise _refused(name, "policy is not valid: " + _what_failed(exc)) from exc
    if policy.key_name != name:
        raise _refused(name, "policy is not the one named")
    if policy.owner != holder:
        raise _refused(name, "policy is not the holder's")
    assert isinstance(entry.data, dict)  # model_validate accepted it, so it is an object.
    try:
        terms = export_terms(entry.data)
        digest = terms_hash(entry.data)
    except ValueError as exc:
        # The export refuses what the two implementations could not agree on.
        raise _refused(name, "policy has no terms") from exc
    return StoredPolicy(document=entry.data, policy=policy, terms=terms, terms_hash=digest)


def _what_failed(exc: ValidationError) -> str:
    """Which checks failed, without the vault's values.

    A field error is named by its path. A policy-level rule (id embeds the
    owner, owner is a DID) has no path, so its own message is used; those
    messages are this module's and carry no input.
    """
    named = set()
    for error in exc.errors():
        if error["loc"]:
            named.add(".".join(str(part) for part in error["loc"]))
        else:
            named.add(error["msg"].removeprefix("Value error, "))
    return ", ".join(sorted(named))


def _governing(matching: list[AccessRule]) -> AccessRule:
    """The rule that decides among those covering a scope.

    The most specific scope wins. Among rules on one scope, the protocol's
    order for terms decides, not the order the holder wrote them in, so two
    policies with the same terms make the same decision.
    """
    return min(
        matching,
        key=lambda r: (
            -len(r.context_scope),
            # The document's rule, not pydantic's filled defaults, so this is
            # the same order the exported terms carry.
            rule_order_key(rule_terms(r.model_dump(mode="json", exclude_unset=True))),
        ),
    )


def _matching_rules(policy: SPALPolicy, context_scope: str) -> list[AccessRule]:
    """Rules whose context_scope covers the requested scope."""
    return [
        rule
        for rule in policy.rules
        if context_scope == rule.context_scope or context_scope.startswith(rule.context_scope + "/")
    ]


def _custody_denial(
    rule: AccessRule, policy_id: str, machine: Operator
) -> PolicyCheckResult | None:
    """The denial a rule's custody ceiling gives for a machine of kind ``machine``, if any.

    A rule without custody means hardware the holder controls. A ceiling is
    satisfied by its own rung or a safer one. A rule that requires
    attestation cannot be satisfied until attestation exists. ``hosted_models``
    is recorded in the terms and not evaluated here: the agent cannot tell a
    hosted model service from a self-run model by its address.
    """
    ceiling = rule.conditions.custody or DEFAULT_CUSTODY
    if machine.rank > ceiling.operator.rank:
        return _denied(
            rule,
            policy_id,
            f"custody: data under this rule may go no further than {ceiling.operator.value}; "
            f"{machine.value} is further",
        )
    if ceiling.attestation_required:
        return _denied(
            rule, policy_id, "custody: attestation required but none can be verified yet"
        )
    return None


def _denied(rule: AccessRule, policy_id: str, detail: str) -> PolicyCheckResult:
    """A denial by one of ``rule``'s conditions: generic reason out, detail for the holder."""
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
        ephemeral_required = id_req.type == IdentityType.EPHEMERAL_REQUIRED or (
            id_req.linkage is not None and id_req.linkage.ephemeral_required
        )
        if ephemeral_required:
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
