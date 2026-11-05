"""Domain models for the agent coordination flow.

These replace the raw dicts the HTTP layer previously used. Leaf module:
imports only stdlib and pydantic.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field, model_validator


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


class ServiceRequest(BaseModel):
    """A user-to-business service request tracked by the coordinator."""

    id: str
    user_id: str
    user_name: str
    business_id: str
    service_type: str
    service_name: str
    status: ServiceRequestStatus = ServiceRequestStatus.PENDING
    created_at: datetime
    # Advisory for clients only; not enforced anywhere (parity with the legacy
    # server, which stamped an expiry on service requests but never read it).
    expires_at: datetime
    verification_request_id: str | None = None
    completed_at: datetime | None = None


class CreateServiceRequest(BaseModel):
    """Inbound payload for POST /service-requests."""

    user_id: str
    user_name: str
    business_id: str
    service_type: str
    service_name: str


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
    policy_id: str | None = None
    context_scope: str | None = None
    service_request_id: str | None = None
    status: RequestStatus = RequestStatus.PENDING
    created_at: datetime
    expires_at: datetime
    response: dict[str, object] | None = None


class ApproveRequest(BaseModel):
    """Inbound payload for POST /requests/{id}/approve; the body may be absent.

    ``requester_did`` is the ephemeral DID the user's app issued for this
    verification, held to the DID Core syntax; the proof names it.
    ``signature`` is that DID's key's signature over the approval (the
    request id and the DID), base64, and comes with the DID or not at all:
    a DID nobody signed for is not accepted.
    """

    model_config = ConfigDict(ser_json_bytes="base64", val_json_bytes="base64")

    requester_did: str | None = Field(
        default=None,
        max_length=512,
        # DID Core: method, then id segments of idchars or %HH escapes; empty
        # middle segments are allowed, the final one is not.
        pattern=r"^did:[a-z0-9]+:(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2}|:)*(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})$",
    )
    signature: bytes | None = Field(default=None, min_length=1, max_length=4096)

    @model_validator(mode="after")
    def _signed_together(self) -> ApproveRequest:
        if (self.requester_did is None) != (self.signature is None):
            raise ValueError("requester_did and signature come together or not at all")
        return self


class ApprovalDecision(BaseModel):
    """The outcome of evaluating a verification request against policy."""

    outcome: DecisionOutcome
    reason: str
    matched_rule_id: str | None = None
    proof: dict[str, object] | None = None
    # The ephemeral DID the proof names, when the user's app supplied
    # one with its approval; None for an autonomous approval (see #107).
    requester_did: str | None = None
