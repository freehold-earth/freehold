from datetime import UTC, datetime

import pytest

from freehold_agent.coordination import VerificationClaim, VerificationRequest
from freehold_agent.errors import ContextUnavailable
from freehold_agent.seams import (
    ContextStoreDataProvider,
    DeterministicContextBuilder,
    PassThroughEnvelopeVerifier,
)
from freehold_agent.spal import RequestContext
from tests.fakes import FakeVault


def _req() -> VerificationRequest:
    now = datetime.now(UTC)
    return VerificationRequest(
        id="a",
        business_id="biz",
        business_name="Biz",
        claim=VerificationClaim(type="age", params={"minAge": 18}),
        terms_hash="a" * 64,
        context_scope="health/age",
        created_at=now,
        expires_at=now,
    )


def test_deterministic_builder_returns_request_context():
    ctx = DeterministicContextBuilder().build(_req(), None)
    assert isinstance(ctx, RequestContext)


async def test_passthrough_verifier_accepts_anything():
    # Must not raise.
    await PassThroughEnvelopeVerifier().verify({}, b"")


async def test_context_store_provider_merges_the_scopes_fields() -> None:
    fake = FakeVault(
        {
            "personal/age": {"birthDate": "1990-05-15", "fullName": "Alice"},
            "personal/age/extra": {"fullName": "Alice Demo", "note": "x"},
            "personal/name": {"fullName": "Nobody"},
        }
    )

    result = await ContextStoreDataProvider(fake).fetch("personal/age")

    assert result == {"birthDate": "1990-05-15", "fullName": "Alice Demo", "note": "x"}
    assert fake.reads == ["entries:personal/age"]


async def test_context_store_provider_lets_the_clients_reason_through() -> None:
    fake = FakeVault()
    fake.error = ContextUnavailable("context store locked")

    with pytest.raises(ContextUnavailable, match="locked"):
        await ContextStoreDataProvider(fake).fetch("health/age")
