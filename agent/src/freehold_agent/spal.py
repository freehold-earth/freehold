"""
S-PAL (Sovereign Privacy & Access Language) policy models.

Pydantic models mirroring the S-PAL 1.0 and 1.1 JSON schemas (1.1 adds the
``custody`` condition), plus request-side models used for policy evaluation.
"""

from __future__ import annotations

import re
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from freehold_agent.custody import HostedModels, Operator
from freehold_agent.terms import SAFE_INTEGER

# The name segment of a policy id, as the schema allows it: no colon, no control character.
NAME_PATTERN = re.compile(r"[^:\x00-\x1f\x7f]+")

# The owner pattern of the S-PAL 1.0 schema: a DID in the DID Core character set.
OWNER_DID_PATTERN = re.compile(
    r"^did:[a-z0-9]+:(?:[A-Za-z0-9._:-]|%[0-9A-Fa-f]{2})*(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})$"
)

# --- Enums ---


class IdentityType(StrEnum):
    EPHEMERAL_REQUIRED = "ephemeral_required"
    PERSISTENT_ALLOWED = "persistent_allowed"
    ANY = "any"


class ProofType(StrEnum):
    ZKP = "zkp"
    ATTESTATION = "attestation"
    SIGNATURE = "signature"


class DerivativePermission(StrEnum):
    FORBIDDEN = "forbidden"
    ALLOWED = "allowed"
    REQUIRES_PAYMENT = "requires_payment"
    REQUIRES_CONSENT = "requires_consent"
    ANONYMIZED_ONLY = "anonymized_only"


class PaymentProtocol(StrEnum):
    X402 = "x402"
    LIGHTNING = "lightning"
    CARDANO = "cardano"


class PaymentCurrency(StrEnum):
    SATS = "sats"
    LOVELACE = "lovelace"
    USD_CENTS = "usd_cents"


# --- Shared base ---


class SPALModel(BaseModel):
    """Base for every S-PAL structure, in a policy or in a request.

    A field this agent does not know is one it cannot evaluate. On the
    policy side that is a condition that would be dropped; on the request
    side it is an offer the checker would never see. Both are refused
    rather than ignored. The JSON schema leaves ``conditions`` open for
    later S-PAL versions; the enforcer must not.

    Instances are frozen: a policy is read, never edited, and the default
    custody is one shared instance. The freeze is shallow; list fields are
    the lists given.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)


# --- Policy-side models ---


class IdentityLinkage(SPALModel):
    ephemeral_required: bool
    proof_of_root_allowed: bool = True
    zk_continuity_allowed: bool = False


class IdentityRequirement(SPALModel):
    """The identity a requester must present.

    ``linkage`` keeps the shape the document gave it, the object or one of
    the two shorthands older examples use, so that the rule's terms, and
    the order the agent evaluates equal-scope rules in, are the document's.
    ``linkage_rules`` spells a shorthand out for the reader.
    """

    type: IdentityType = IdentityType.ANY
    linkage: IdentityLinkage | Literal["forbidden", "allowed"] | None = None

    @property
    def linkage_rules(self) -> IdentityLinkage | None:
        if self.linkage == "forbidden":
            return IdentityLinkage(
                ephemeral_required=True,
                proof_of_root_allowed=False,
                zk_continuity_allowed=False,
            )
        if self.linkage == "allowed":
            return IdentityLinkage(
                ephemeral_required=False,
                proof_of_root_allowed=True,
                zk_continuity_allowed=True,
            )
        return self.linkage


class ProofRequirement(SPALModel):
    type: ProofType
    claim: str
    params: dict[str, Any] | None = None


class RetentionPolicy(SPALModel):
    max_seconds: int = Field(ge=0, le=SAFE_INTEGER)
    audit_log: bool = False


class DerivativePolicy(SPALModel):
    training: DerivativePermission = DerivativePermission.FORBIDDEN
    aggregation: DerivativePermission = DerivativePermission.FORBIDDEN
    resale: DerivativePermission = DerivativePermission.FORBIDDEN


class PaymentRequirement(SPALModel):
    protocol: PaymentProtocol
    amount: int = Field(ge=0, le=SAFE_INTEGER)
    currency: PaymentCurrency


class CustodyPolicy(SPALModel):
    """Whose machine may work on the data under a rule (S-PAL 1.1).

    ``operator`` is a ceiling on the ladder: a machine satisfies the rule when
    its kind of operator is this one or a safer one. A rule without ``custody``
    is read as ``owned_hardware``. ``hosted_models`` is recorded in the terms
    and not yet evaluated; ``attestation_required`` cannot be satisfied until
    attestation exists, so a rule that requires it is refused.
    """

    operator: Operator
    hosted_models: HostedModels = HostedModels.FORBIDDEN
    attestation_required: bool = False


DEFAULT_CUSTODY = CustodyPolicy(operator=Operator.OWNED_HARDWARE)
"""What a rule that says nothing about custody means: hardware the holder controls."""


class Conditions(SPALModel):
    identity: IdentityRequirement | None = None
    proofs: list[ProofRequirement] = Field(default_factory=list)
    retention: RetentionPolicy | None = None
    derivatives: DerivativePolicy | None = None
    payment: PaymentRequirement | None = None
    custody: CustodyPolicy | None = None


class AccessRule(SPALModel):
    id: str
    context_scope: str
    conditions: Conditions


class Enforcement(SPALModel):
    smart_contract: str | None = None
    validators: list[str] = Field(default_factory=list)
    dispute_resolution: str | None = None


class SPALPolicy(SPALModel):
    version: Literal["1.0", "1.1"]
    id: str
    name: str
    description: str | None = None
    created: str | None = None
    updated: str | None = None
    owner: str
    rules: list[AccessRule] = Field(min_length=1)
    enforcement: Enforcement | None = None
    signature: str | None = None

    @model_validator(mode="after")
    def _id_embeds_the_owner(self) -> SPALPolicy:
        """The schema's rule it cannot check itself (#81).

        ``id`` is ``spal:{owner}:{name}`` with this policy's ``owner``, a DID,
        and a name with no colon: the name is the policy's vault key, and a
        colon would make two ids share one key.
        """
        if not OWNER_DID_PATTERN.match(self.owner):
            raise ValueError("owner must be a DID")
        prefix = f"spal:{self.owner}:"
        name = self.id[len(prefix) :]
        if not self.id.startswith(prefix) or not NAME_PATTERN.fullmatch(name):
            raise ValueError(
                "id must be spal:{owner}:{name} with this policy's owner and a name without "
                "a colon or control character"
            )
        return self

    @model_validator(mode="after")
    def _custody_is_1_1(self) -> SPALPolicy:
        """A 1.0 document cannot carry a 1.1 condition: the version says what the rules may say."""
        if self.version == "1.0" and any(r.conditions.custody is not None for r in self.rules):
            raise ValueError("custody needs version 1.1")
        return self

    @property
    def key_name(self) -> str:
        """The name segment of the id: the policy's key under ``policies/``."""
        return self.id.rsplit(":", 1)[1]


# --- Request-side models (for evaluation) ---


class RequestIdentity(SPALModel):
    """Identity info provided by the requester."""

    type: IdentityType
    did: str | None = None


class AvailableProof(SPALModel):
    """A proof the requester can present."""

    type: ProofType
    claim: str


class IntendedUse(SPALModel):
    """What the requester intends to do with the data."""

    training: bool = False
    aggregation: bool = False
    resale: bool = False


class RequestContext(SPALModel):
    """Context about the incoming request, used for policy evaluation."""

    identity: RequestIdentity | None = None
    proofs: list[AvailableProof] = Field(default_factory=list)
    intended_use: IntendedUse | None = None
    offered_retention_seconds: int | None = None
    payment_offered: bool = False
