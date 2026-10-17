"""Coordination-layer error hierarchy.

All service-raised errors inherit :class:`ServiceError` so the API layer can
map them to HTTP status codes in one place.
"""

from __future__ import annotations


class ServiceError(Exception):
    """Base for freehold-agent coordination errors."""


class ContextUnavailable(ServiceError):  # noqa: N818
    """The user's private data could not be retrieved for a scope."""


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
