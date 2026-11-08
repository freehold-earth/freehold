"""The S-PAL custody ladder: whose machine may hold the holder's data while it is worked on.

A leaf module, so configuration (which tags the model server and the proof
service with a rung) and the policy models (which carry a rule's ceiling) can
both import it without a cycle.
"""

from __future__ import annotations

from enum import StrEnum


class Operator(StrEnum):
    """The kinds of operator that may hold the holder's data while it is worked on.

    Ordered least to most permissive. A ``custody`` rule names a ceiling on
    this ladder: a machine satisfies the rule when its kind is the ceiling or
    a safer one.
    """

    DEVICE_ONLY = "device_only"
    OWNED_HARDWARE = "owned_hardware"
    COMMUNITY_NODE = "community_node"
    FEDERATED_OPERATOR = "federated_operator"
    ATTESTED_ENCLAVE = "attested_enclave"
    ANY = "any"

    @property
    def rank(self) -> int:
        """Position on the ladder; a higher rank is a more permissive kind of operator."""
        return list(Operator).index(self)


class HostedModels(StrEnum):
    """Whether a hosted third-party model may receive the data: recorded, not yet evaluated."""

    FORBIDDEN = "forbidden"
    ALLOWED = "allowed"
