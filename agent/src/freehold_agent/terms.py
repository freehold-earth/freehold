"""A policy's terms: what a business agrees to, with the holder's handles removed.

The terms are the contractual content of an S-PAL policy, produced by
allowlist and in a fixed shape so that nothing about who wrote the policy
or how survives into them: the version, each rule's scope and conditions in
a canonical order, and the enforcing validators. The protocol, and the
reasoning behind each dropped field, is ``spec/protocols/policy-terms.md``;
``spec/schemas/spal/v1.0/terms-vectors.json`` pins the bytes, and the
identity package's ``exportTerms`` reproduces them.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from typing import Final

from freehold_agent.authorization import canonical_json

TERMS_HASH_PATTERN: Final = r"^[0-9a-f]{64}$"
"""The terms hash on the wire: 64 lowercase hex characters."""


def export_terms(policy: Mapping[str, object]) -> dict[str, object]:
    """The terms of ``policy``, as the protocol's export step defines them.

    Works on the plain JSON mapping rather than a validated model, so the
    same bytes come out of a document before validation and out of the
    identity package's copy of it.

    Raises:
        ValueError: ``policy`` has no ``version`` or no ``rules`` list; a
            policy without them has no terms, and partial terms are never
            produced.
    """
    version = policy.get("version")
    rules = policy.get("rules")
    if not isinstance(version, str):
        raise ValueError("a policy without a version has no terms")
    if not isinstance(rules, list):
        raise ValueError("a policy without rules has no terms")

    reduced = [_rule(rule) for rule in rules]
    reduced.sort(key=lambda rule: (_utf16(rule["context_scope"]), _utf16(canonical_json(rule))))

    terms: dict[str, object] = {"version": version, "rules": reduced}
    enforcement = policy.get("enforcement")
    validators = enforcement.get("validators") if isinstance(enforcement, Mapping) else None
    if isinstance(validators, list) and validators:
        if not all(isinstance(v, str) for v in validators):
            raise ValueError("enforcement validators must be text")
        terms["enforcement"] = {"validators": sorted(validators, key=_utf16)}
    return terms


def _utf16(text: str) -> bytes:
    """The sort key the protocol fixes: UTF-16 code units, as RFC 8785 orders keys."""
    return text.encode("utf-16-be")


def _rule(rule: object) -> dict[str, object]:
    """A rule reduced to its terms; a rule that is not one has no terms."""
    if not isinstance(rule, Mapping):
        raise ValueError("a rule must be an object")
    scope = rule.get("context_scope")
    conditions = rule.get("conditions")
    if not isinstance(scope, str):
        raise ValueError("a rule's context_scope must be text")
    if not isinstance(conditions, Mapping):
        raise ValueError("a rule's conditions must be an object")
    return {"context_scope": scope, "conditions": _conditions(conditions)}


# The S-PAL 1.0 conditions and the fields of each. A condition or field not
# listed here is not part of the terms until the protocol says it is.
_CONDITION_FIELDS: Final[Mapping[str, tuple[str, ...]]] = {
    "identity": ("type", "linkage"),
    "retention": ("max_seconds", "audit_log"),
    "derivatives": ("training", "aggregation", "resale"),
    "payment": ("protocol", "amount", "currency"),
}
_PROOF_FIELDS: Final = ("type", "claim", "params")
_LINKAGE_FIELDS: Final = ("ephemeral_required", "proof_of_root_allowed", "zk_continuity_allowed")


def _pick(source: Mapping[str, object], fields: tuple[str, ...]) -> dict[str, object]:
    return {name: source[name] for name in fields if name in source}


def _conditions(conditions: Mapping[str, object]) -> dict[str, object]:
    """The conditions a rule's terms carry: the 1.0 conditions, each by its own allowlist."""
    out: dict[str, object] = {}
    for name, fields in _CONDITION_FIELDS.items():
        value = conditions.get(name)
        if isinstance(value, Mapping):
            picked = _pick(value, fields)
            linkage = picked.get("linkage")
            if isinstance(linkage, Mapping):
                picked["linkage"] = _pick(linkage, _LINKAGE_FIELDS)
            out[name] = picked
    proofs = conditions.get("proofs")
    if isinstance(proofs, list):
        out["proofs"] = [_pick(p, _PROOF_FIELDS) for p in proofs if isinstance(p, Mapping)]
    return out


def terms_hash(policy: Mapping[str, object]) -> str:
    """SHA-256 of the canonical JSON of ``policy``'s terms, lowercase hex."""
    return hashlib.sha256(canonical_json(export_terms(policy)).encode()).hexdigest()
