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

    reduced = [
        {"context_scope": rule["context_scope"], "conditions": rule["conditions"]} for rule in rules
    ]
    reduced.sort(key=lambda rule: (rule["context_scope"], canonical_json(rule)))

    terms: dict[str, object] = {"version": version, "rules": reduced}
    enforcement = policy.get("enforcement")
    validators = enforcement.get("validators") if isinstance(enforcement, Mapping) else None
    if isinstance(validators, list) and validators:
        terms["enforcement"] = {"validators": sorted(validators)}
    return terms


def terms_hash(policy: Mapping[str, object]) -> str:
    """SHA-256 of the canonical JSON of ``policy``'s terms, lowercase hex."""
    return hashlib.sha256(canonical_json(export_terms(policy)).encode()).hexdigest()
