"""Coordination-layer error hierarchy.

All service-raised errors inherit :class:`ServiceError` so the API layer can
map them to HTTP status codes in one place.
"""

from __future__ import annotations

from enum import StrEnum


class ServiceError(Exception):
    """Base for freehold-agent coordination errors."""


class ContextUnavailable(ServiceError):  # noqa: N818
    """The user's private data could not be retrieved for a scope."""


class ContextLocked(ContextUnavailable):  # noqa: N818
    """No vault secret is held, so stored entries cannot be read."""


class ContextKeyInvalid(ContextUnavailable):  # noqa: N818
    """The held (or offered) vault secret does not decrypt the stored entries."""


class ZKPUnavailable(ServiceError):  # noqa: N818
    """The ZKP service could not be reached or returned an error."""


class RequestExpired(ServiceError):  # noqa: N818
    """An action was attempted on a request past its expiry."""


class ServiceRequestNotFound(ServiceError):  # noqa: N818
    """A referenced service request is not tracked."""


class ServiceRequestConflict(ServiceError):  # noqa: N818
    """The service request's status does not allow the attempted action."""


class EnvelopeInvalid(ServiceError):  # noqa: N818
    """A DID-signed request envelope failed verification."""


class EnvelopeSignatureInvalid(EnvelopeInvalid):  # noqa: N818
    """The envelope's signature does not verify for its sender over its preimage."""


class EnvelopeExpired(EnvelopeInvalid):  # noqa: N818
    """The envelope was presented at or after its expiry time."""


class EnvelopeNotYetValid(EnvelopeInvalid):  # noqa: N818
    """The envelope was presented before its issue time."""


class EnvelopeMisaddressed(EnvelopeInvalid):  # noqa: N818
    """The envelope names a recipient other than the service verifying it."""


class EnvelopeLifetimeExceeded(EnvelopeInvalid):  # noqa: N818
    """The envelope's validity window is longer than the verifier allows."""


class EnvelopeBodyMismatch(EnvelopeInvalid):  # noqa: N818
    """The envelope's body hash is not the digest of the payload delivered with it."""


class EnvelopeReplayed(EnvelopeInvalid):  # noqa: N818
    """The envelope's nonce was already accepted from the same sender."""


class AttestationInvalid(ServiceError):  # noqa: N818
    """An approval names a DID whose holder's signature does not check out."""


class AuthorizationInvalid(ServiceError):  # noqa: N818
    """The vault holds no valid root-signed authorization record for a DID."""


class PolicyRefused(ServiceError):  # noqa: N818
    """A policy the vault holds cannot be used: absent, invalid, mis-named,
    not the holder's, or matching no terms. ``detail`` is the holder-facing
    reason; a business sees only the generic denial."""

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


class NoModelBackend(ServiceError):  # noqa: N818
    """No model backend is configured, so nothing can be asked of a model."""

    def __init__(self) -> None:
        super().__init__("no model backend configured")


class AuditUnavailable(ServiceError):  # noqa: N818
    """The outbound audit record could not be written, so no model call was made."""


class ScopeEmpty(ServiceError):  # noqa: N818
    """Nothing is stored under the scope, so there is nothing to answer from."""


class ReceiptRefusal(StrEnum):
    """Which check a terms receipt failed; the first to fail names the refusal."""

    SPENT = "spent"
    MISSING = "missing"
    MALFORMED = "malformed"
    OPERATOR = "operator"
    SIGNATURE = "signature"
    TERMS = "terms"
    NONCE = "nonce"
    COMMITMENT = "commitment"
    SERVED_AT = "served_at"
    CONDITIONS = "conditions"


class ReceiptInvalid(ServiceError):  # noqa: N818
    """What came back for a request is no terms receipt for it.

    ``refusal`` names the check that failed and ``detail`` says how, for the
    holder.
    """

    def __init__(self, refusal: ReceiptRefusal, detail: str) -> None:
        super().__init__(f"{refusal.value}: {detail}")
        self.refusal = refusal
        self.detail = detail
