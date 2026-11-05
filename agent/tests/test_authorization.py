"""The agent's reading of the vault's root-signed authorization records,
checked byte-for-byte against the spec vectors the identity package also
reproduces, and against records signed here with a root key."""

import json
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from freehold_agent.authorization import (
    authorization_preimage,
    canonical_json,
    root_issued,
    verify_authorization_record,
)
from freehold_agent.context import ContextEntry
from freehold_agent.errors import AuthorizationInvalid
from tests.test_attestation import did_key

VECTORS = json.loads(
    (
        Path(__file__).resolve().parents[2]
        / "spec"
        / "schemas"
        / "encoding"
        / "v1.0"
        / "test-vectors.json"
    ).read_text()
)


def _vector_text(field: dict) -> str:
    return (
        field["value_utf8"] if "value_utf8" in field else bytes.fromhex(field["value_hex"]).decode()
    )


def _record_from_vector(vector: dict) -> dict:
    """The stored record whose fields the vector lists; absent optionals stay absent."""
    f = {field["name"]: _vector_text(field) for field in vector["fields"]}
    context: dict = {"verificationType": f["verification_type"]}
    if f["verifier_did"]:
        context["verifierDid"] = f["verifier_did"]
    if f["policy_hash"]:
        context["policyHash"] = f["policy_hash"]
    if f["metadata"]:
        context["metadata"] = json.loads(f["metadata"])
    record = {
        "ephemeralDid": f["ephemeral_did"],
        "rootDid": f["root_did"],
        "purpose": f["purpose"],
        "context": context,
        "timestamp": f["issued_at"],
    }
    if f["expires_at"]:
        record["expiresAt"] = f["expires_at"]
    if f["root_key_id"]:
        record["rootKeyId"] = f["root_key_id"]
    return record


@pytest.mark.parametrize(
    "vector",
    [v for v in VECTORS["vectors"] if v["structure"] == "did_authorization_record"],
    ids=lambda v: v["name"],
)
def test_preimage_reproduces_the_spec_vector(vector: dict) -> None:
    assert authorization_preimage(_record_from_vector(vector)).hex() == vector["encoding_hex"]


def test_canonical_json_matches_rfc_8785_for_what_a_record_carries() -> None:
    assert canonical_json({"b": 1, "a": [True, None, 'x"y\n'], "é": {"z": 2, "a": 1.0}}) == (
        '{"a":[true,null,"x\\"y\\n"],"b":1,"é":{"a":1,"z":2}}'
    )
    # Keys sort by UTF-16 code units, as JavaScript sorts them: an astral
    # character (surrogate pair) sorts before a BMP character above D800.
    assert canonical_json({"～": 1, "\U0001f600": 2}) == '{"\U0001f600":2,"～":1}'


@pytest.mark.parametrize("bad", [1.5, 2**53, float("inf"), {1: 2}, object(), b"x"])
def test_canonical_json_refuses_what_it_cannot_spell_the_same_way(bad: object) -> None:
    with pytest.raises(ValueError):
        canonical_json(bad)


def _root() -> tuple[Ed25519PrivateKey, str, bytes]:
    key = Ed25519PrivateKey.generate()
    public = key.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw
    )
    return key, did_key(key), public


def _signed(root: Ed25519PrivateKey, root_did: str, ephemeral_did: str, **extra: object) -> dict:
    record: dict = {
        "ephemeralDid": ephemeral_did,
        "rootDid": root_did,
        "purpose": "age verification at Biz",
        "context": {
            "verificationType": "age",
            "metadata": {"requestId": "r1", "businessId": "biz"},
        },
        "timestamp": "2026-11-05T10:00:00.000Z",
        **extra,
    }
    record["rootSignature"] = list(root.sign(authorization_preimage(record)))
    return record


def test_a_record_the_root_signed_verifies() -> None:
    root, root_did, public = _root()
    verify_authorization_record(_signed(root, root_did, "did:key:z6MkEph"), root_did, public)


def test_a_record_for_another_root_is_refused_before_any_signature_check() -> None:
    root, root_did, public = _root()
    _, other_did, _ = _root()
    with pytest.raises(AuthorizationInvalid, match="not issued by this vault's root"):
        verify_authorization_record(_signed(root, other_did, "did:key:z6MkEph"), root_did, public)


def test_a_record_signed_by_another_key_is_refused() -> None:
    root, root_did, _ = _root()
    _, _, other_public = _root()
    with pytest.raises(AuthorizationInvalid, match="does not verify"):
        verify_authorization_record(
            _signed(root, root_did, "did:key:z6MkEph"), root_did, other_public
        )


def test_a_tampered_record_is_refused() -> None:
    root, root_did, public = _root()
    record = _signed(root, root_did, "did:key:z6MkEph")
    record["ephemeralDid"] = "did:key:z6MkOther"
    with pytest.raises(AuthorizationInvalid, match="does not verify"):
        verify_authorization_record(record, root_did, public)


def test_expiry_is_judged_as_the_identity_package_judges_it() -> None:
    root, root_did, public = _root()
    now = datetime(2026, 11, 5, 12, tzinfo=UTC)
    live = _signed(
        root, root_did, "did:key:z6MkEph", expiresAt=(now + timedelta(hours=1)).isoformat()
    )
    verify_authorization_record(live, root_did, public, now=now)
    stale = _signed(root, root_did, "did:key:z6MkEph", expiresAt="2026-11-05T11:00:00.000Z")
    with pytest.raises(AuthorizationInvalid, match="expired"):
        verify_authorization_record(stale, root_did, public, now=now)
    odd = _signed(root, root_did, "did:key:z6MkEph", expiresAt="never")
    with pytest.raises(AuthorizationInvalid, match="does not parse"):
        verify_authorization_record(odd, root_did, public, now=now)


def test_a_context_key_the_signature_does_not_cover_is_refused() -> None:
    root, root_did, public = _root()
    record = _signed(root, root_did, "did:key:z6MkEph")
    record["context"]["extra"] = "unsigned"
    with pytest.raises(AuthorizationInvalid, match="keys the signature does not cover"):
        verify_authorization_record(record, root_did, public)


@pytest.mark.parametrize(
    "mutate",
    [
        lambda r: r.pop("rootSignature"),
        lambda r: r.__setitem__("rootSignature", [1, 2, 3]),
        lambda r: r.__setitem__("rootSignature", "AAAA"),
        lambda r: r.__setitem__("purpose", 7),
        lambda r: r.__setitem__("context", "age"),
        lambda r: r["context"].__setitem__("metadata", {"ratio": 0.5}),
        lambda r: r.__setitem__("expiresAt", 12345),
    ],
)
def test_a_malformed_record_is_refused_not_crashed_on(mutate: Callable[[dict], object]) -> None:
    root, root_did, public = _root()
    record = _signed(root, root_did, "did:key:z6MkEph")
    mutate(record)
    with pytest.raises(AuthorizationInvalid):
        verify_authorization_record(record, root_did, public)


def test_a_root_key_that_is_not_ed25519_is_refused() -> None:
    root, root_did, _ = _root()
    with pytest.raises(AuthorizationInvalid, match="not an Ed25519 key"):
        verify_authorization_record(
            _signed(root, root_did, "did:key:z6MkEph"), root_did, b"\x00" * 5
        )


async def test_a_root_key_stored_with_non_byte_values_is_refused_not_crashed_on() -> None:
    class Vault:
        async def entries(self, scope: str | None = None) -> list[ContextEntry]:
            if scope == "root-identity":
                root = {"did": "did:key:zR", "publicKey": ["x"]}
                return [ContextEntry("root-identity", root, version=1, updated_at="2026-11-05")]
            return []

    with pytest.raises(AuthorizationInvalid, match="malformed"):
        await root_issued(Vault(), "did:key:zE")
