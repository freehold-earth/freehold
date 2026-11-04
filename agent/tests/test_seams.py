from datetime import UTC, datetime

import pytest

from freehold_agent.context import ContextEntry
from freehold_agent.coordination import VerificationClaim, VerificationRequest
from freehold_agent.errors import ContextUnavailable
from freehold_agent.seams import (
    ContextStoreDataProvider,
    DeterministicContextBuilder,
    PassThroughEnvelopeVerifier,
)
from freehold_agent.spal import RequestContext


class _FakeContextClient:
    """Minimal stand-in for ContextClient.entries, without a real connection."""

    def __init__(
        self,
        entries: list[ContextEntry] | None = None,
        error: Exception | None = None,
    ) -> None:
        self._entries = entries or []
        self._error = error
        self.scopes: list[str | None] = []

    async def entries(self, scope: str | None = None) -> list[ContextEntry]:
        self.scopes.append(scope)
        if self._error is not None:
            raise self._error
        return self._entries


def _entry(key: str, data: object) -> ContextEntry:
    return ContextEntry(key=key, data=data, version=1, updated_at="2026-11-04T00:00:00Z")


def _req() -> VerificationRequest:
    now = datetime.now(UTC)
    return VerificationRequest(
        id="a",
        business_id="biz",
        business_name="Biz",
        claim=VerificationClaim(type="age", params={"minAge": 18}),
        context_scope="health/age",
        created_at=now,
        expires_at=now,
    )


def test_deterministic_builder_returns_request_context():
    ctx = DeterministicContextBuilder().build(_req())
    assert isinstance(ctx, RequestContext)


async def test_passthrough_verifier_accepts_anything():
    # Must not raise.
    await PassThroughEnvelopeVerifier().verify({}, b"")


async def test_context_store_provider_merges_the_scopes_fields():
    fake = _FakeContextClient(
        entries=[
            _entry("personal-context", {"birthDate": "1990-05-15", "fullName": "Alice"}),
            _entry("personal-notes", {"fullName": "Alice Demo", "note": "x"}),
        ]
    )

    result = await ContextStoreDataProvider(fake).fetch("personal/age")

    assert result == {"birthDate": "1990-05-15", "fullName": "Alice Demo", "note": "x"}
    assert fake.scopes == ["personal/age"]


async def test_context_store_provider_lets_the_clients_reason_through():
    fake = _FakeContextClient(error=ContextUnavailable("context store locked"))

    with pytest.raises(ContextUnavailable, match="locked"):
        await ContextStoreDataProvider(fake).fetch("health/age")
