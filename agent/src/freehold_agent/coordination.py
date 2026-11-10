"""Domain models for the agent coordination flow.

These replace the raw dicts the HTTP layer previously used. Leaf module:
imports only stdlib and pydantic.
"""

from __future__ import annotations

import base64
from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, model_validator

from freehold_agent.scope import SCOPE_PATTERN

POLICY_NAME_PATTERN = r"^[^:\x00-\x1f\x7f]{1,200}$"
"""The name segment of a policy id, as the schema allows it: anything but a colon
or a control character. The vault key of a policy is ``policies/{name}``."""


class Action(StrEnum):
    """The a2a message vocabulary; enumerated by the DID envelope's action field."""

    SERVICE_REQUEST = "service.request"
    VERIFICATION_REQUEST = "verification.request"
    NEGOTIATE = "negotiate"
    PROOF_SUBMIT = "proof.submit"
    PAYMENT_OFFER = "payment.offer"
    DECISION_APPROVE = "decision.approve"
    DECISION_DENY = "decision.deny"
    SERVICE_COMPLETE = "service.complete"


class ApprovalMode(StrEnum):
    """How the agent resolves an incoming verification request."""

    MANUAL = "manual"
    AUTO_WITH_NOTIFICATION = "auto_with_notification"
    FULLY_AUTONOMOUS = "fully_autonomous"


class RequestStatus(StrEnum):
    """Lifecycle state of a verification request."""

    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    DENIED = "denied"
    ESCALATED = "escalated"
    ERROR = "error"


class DecisionOutcome(StrEnum):
    """Result of a pure approval evaluation, before mode is applied."""

    APPROVE = "approve"
    REJECT = "reject"
    DENY = "deny"
    ERROR = "error"


class ServiceRequestStatus(StrEnum):
    """Lifecycle state of a user-to-business service request."""

    PENDING = "pending"
    VERIFICATION_REQUIRED = "verification_required"
    VERIFIED = "verified"
    COMPLETED = "completed"
    DENIED = "denied"
    REJECTED = "rejected"


class PolicyLabel(BaseModel):
    """How a policy is shown to a business beside its terms: the holder's name and
    description for it. Labels, not terms: they are not hashed and not agreed to."""

    name: str
    description: str | None = None


class ServiceRequest(BaseModel):
    """A user-to-business service request tracked by the coordinator.

    Carries the terms of the holder's policy the request is made under, their
    hash, and a label, so the business sees what it is agreeing to. Never the
    policy id or owner, which identify the holder (spec/protocols/policy-terms.md).
    """

    id: str
    user_id: str
    user_name: str
    business_id: str
    service_type: str
    service_name: str
    terms: dict[str, object]
    terms_hash: str
    policy_label: PolicyLabel
    status: ServiceRequestStatus = ServiceRequestStatus.PENDING
    created_at: datetime
    # Advisory for clients only; not enforced anywhere (parity with the legacy
    # server, which stamped an expiry on service requests but never read it).
    expires_at: datetime
    verification_request_id: str | None = None
    completed_at: datetime | None = None


class CreateServiceRequest(BaseModel):
    """Inbound payload for POST /service-requests.

    ``policy_name`` names one of the holder's own policies (the name segment
    of its id, its key under ``policies/``); the agent attaches that policy's
    terms for the business. The name class is the schema's: anything but a
    colon or a control character.
    """

    user_id: str
    user_name: str
    business_id: str
    service_type: str
    service_name: str
    policy_name: str = Field(pattern=POLICY_NAME_PATTERN)


class AskRequest(BaseModel):
    """Inbound payload for POST /ask: the holder's question about their own data.

    ``policy_name`` is one of the holder's policies; ``context_scope`` is a
    scope path of plain segments, so a traversal-looking value never reaches
    the vault.
    """

    question: str = Field(min_length=1, max_length=4000)
    policy_name: str = Field(pattern=POLICY_NAME_PATTERN)
    context_scope: str = Field(pattern=SCOPE_PATTERN, max_length=512)


class VerificationClaim(BaseModel):
    """The claim a business asks the user to prove (e.g. age >= 18)."""

    type: str
    params: dict[str, object] = Field(default_factory=dict)


class VerificationRequest(BaseModel):
    """A business-to-user verification request tracked by the coordinator."""

    id: str
    business_id: str
    business_name: str
    claim: VerificationClaim
    # The hash of the holder's policy terms the business accepted; never the
    # policy id, which carries the holder's root DID (spec/protocols/policy-terms.md).
    terms_hash: str
    context_scope: str | None = None
    service_request_id: str | None = None
    status: RequestStatus = RequestStatus.PENDING
    created_at: datetime
    expires_at: datetime
    response: dict[str, object] | None = None


class SignedApproval(BaseModel):
    """A requester DID with its holder's signature over the request, as an
    approve body carries them together, and the vault key of the record the
    root signed for that DID when the app says where it is."""

    requester_did: str
    signature: bytes
    record_key: str

    def stored(self) -> dict[str, str]:
        """The attestation as the response keeps it for the business to verify.

        The signature is standard base64, the form the identity package
        writes and reads.
        """
        return {
            "requester_did": self.requester_did,
            "signature": base64.b64encode(self.signature).decode(),
        }


class ApproveRequest(BaseModel):
    """Inbound payload for POST /requests/{id}/approve; the body may be absent.

    ``requester_did`` is the ephemeral DID the user's app issued for this
    verification, held to the DID Core syntax; the proof names it.
    ``signature`` is that DID's key's signature over the approval (the
    request id and the DID), base64, and comes with the DID or not at all:
    a DID nobody signed for is not accepted. ``record_key`` is where in the
    vault the app kept the root-signed record for the DID, so the agent
    reads that one entry; it comes with the DID too, since the agent does
    not search the vault for a record.
    """

    # Inbound only; the stored form is SignedApproval.stored(), standard base64.
    model_config = ConfigDict(val_json_bytes="base64")

    requester_did: str | None = Field(
        default=None,
        max_length=512,
        # DID Core: method, then id segments of idchars or %HH escapes; empty
        # middle segments are allowed, the final one is not.
        pattern=r"^did:[a-z0-9]+:(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2}|:)*(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})$",
    )
    signature: bytes | None = Field(default=None, min_length=1, max_length=4096)
    record_key: str | None = Field(
        default=None, pattern=r"^identity/authorizations/[A-Za-z0-9._-]{1,200}$"
    )

    @model_validator(mode="after")
    def _signed_together(self) -> ApproveRequest:
        """Enforce the class docstring's rule: DID, signature and record key travel together."""
        given = (self.requester_did is None, self.signature is None, self.record_key is None)
        if len(set(given)) != 1:
            raise ValueError("requester_did, signature and record_key come together or not at all")
        return self

    def signed(self) -> SignedApproval | None:
        """The DID, signature and record key as one value, or None for an approval naming no DID."""
        if self.requester_did is None or self.signature is None or self.record_key is None:
            return None
        return SignedApproval(
            requester_did=self.requester_did,
            signature=self.signature,
            record_key=self.record_key,
        )


class ApprovalDecision(BaseModel):
    """The outcome of evaluating a verification request against policy.

    ``reason`` is what the business may read. ``detail`` is the holder's:
    which check of their policy failed, logged and shown to the holder's app
    only, so a business learns nothing about the policy beyond its terms.
    """

    outcome: DecisionOutcome
    reason: str
    detail: str | None = None
    matched_rule_id: str | None = None
    proof: dict[str, object] | None = None
    # The ephemeral DID the proof names, when the user's app supplied
    # one with its approval; None for an autonomous approval (see #107).
    requester_did: str | None = None
