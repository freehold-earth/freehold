"""
S-PAL (Sovereign Privacy & Access Language) policy models.

Pydantic models mirroring the S-PAL v1.0 JSON schema, plus request-side
models used for policy evaluation.
"""

from __future__ import annotations

import re
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from freehold_agent.terms import SAFE_INTEGER

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
    """

    model_config = ConfigDict(extra="forbid")


# --- Policy-side models ---


class IdentityLinkage(SPALModel):
    ephemeral_required: bool
    proof_of_root_allowed: bool = True
    zk_continuity_allowed: bool = False


class IdentityRequirement(SPALModel):
    type: IdentityType = IdentityType.ANY
    linkage: IdentityLinkage | None = None

    @field_validator("linkage", mode="before")
    @classmethod
    def coerce_linkage_string(cls, v: Any) -> Any:
        """Handle example policies that use 'forbidden' string instead of object."""
        if v == "forbidden":
            return IdentityLinkage(
                ephemeral_required=True,
                proof_of_root_allowed=False,
                zk_continuity_allowed=False,
            )
        if v == "allowed":
            return IdentityLinkage(
                ephemeral_required=False,
                proof_of_root_allowed=True,
                zk_continuity_allowed=True,
            )
        return v


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


class Conditions(SPALModel):
    identity: IdentityRequirement | None = None
    proofs: list[ProofRequirement] = Field(default_factory=list)
    retention: RetentionPolicy | None = None
    derivatives: DerivativePolicy | None = None
    payment: PaymentRequirement | None = None


class AccessRule(SPALModel):
    id: str
    context_scope: str
    conditions: Conditions


class Enforcement(SPALModel):
    smart_contract: str | None = None
    validators: list[str] = Field(default_factory=list)
    dispute_resolution: str | None = None


class SPALPolicy(SPALModel):
    version: Literal["1.0"]
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
        if not self.id.startswith(prefix) or not name or ":" in name:
            raise ValueError(
                "id must be spal:{owner}:{name} with this policy's owner and no colon in the name"
            )
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
