"""DID-signed request envelope: spec conformance, re-partitioning, and verification."""

import hashlib
import hmac
from typing import Any

import pytest
from pci_preimage import DID_SIGNED_REQUEST_ENVELOPE, decode
from pci_preimage.generate_vectors import build_vectors
from pydantic import ValidationError

from pci_agent.envelope import (
    BODY_HASH_WIDTH,
    DEFAULT_LEEWAY_SECONDS,
    DEFAULT_MAX_LIFETIME_SECONDS,
    DOMAIN_SEPARATOR,
    MAX_ACTION_LENGTH,
    MAX_DID_LENGTH,
    MAX_POLICY_ID_LENGTH,
    MAX_SIGNATURE_LENGTH,
    NONCE_WIDTH,
    EnvelopeSigner,
    EnvelopeVerifier,
    NonceStore,
    RequestEnvelope,
    SignedEnvelope,
    new_nonce,
    sign_envelope,
    verify_envelope,
)
from pci_agent.errors import (
    EnvelopeBodyMismatch,
    EnvelopeExpired,
    EnvelopeInvalid,
    EnvelopeLifetimeExceeded,
    EnvelopeMisaddressed,
    EnvelopeNotYetValid,
    EnvelopeReplayed,
    EnvelopeSignatureInvalid,
)

DOC = build_vectors()
ENVELOPE_VECTORS = [v for v in DOC["vectors"] if v["structure"] == DID_SIGNED_REQUEST_ENVELOPE.name]

SENDER = "did:pci:ephemeral:z6Mkabc"
RECIPIENT = "did:web:example.com"
OTHER = "did:pci:ephemeral:z6Mkother"
POLICY_ID = "spal:did:pci:cardano:addr1abc123:health-records"
NONCE = b"\x77" * NONCE_WIDTH
BODY_HASH = b"\x88" * BODY_HASH_WIDTH
ISSUED_AT = 1_753_000_000
EXPIRES_AT = ISSUED_AT + DEFAULT_MAX_LIFETIME_SECONDS

# Transcribed from spec/schemas/encoding/v1.0/test-vectors.json, vector
# "did-envelope-negotiate". Deliberately independent of the generator so an
# encoder regression cannot move both sides of the comparison. It changes only
# with a new registry entry for the envelope structure.
NEGOTIATE_VECTOR_HEX = (
    "000000135043492f6469642d656e76656c6f70652f7631"
    "000000196469643a7063693a657068656d6572616c3a7a364d6b616263"
    "000000136469643a7765623a6578616d706c652e636f6d"
    "000000096e65676f7469617465"
    "0000002f7370616c3a6469643a7063693a63617264616e6f3a61646472316162633132333a"
    "6865616c74682d7265636f726473"
    "77777777777777777777777777777777"
    "00000000687ca840"
    "00000000687cb650"
    "8888888888888888888888888888888888888888888888888888888888888888"
)


class _HmacScheme:
    """Test-only signing scheme standing in for real DID keys.

    Every known DID shares one key, so the only thing that can make a
    signature fail for a known sender is the preimage bytes themselves. That
    keeps the re-partitioning tests honest: under a non-injective encoding the
    forged envelope would verify.
    """

    _KEY = b"test-only shared key"

    def __init__(self, did: str, *also_known: str) -> None:
        self.did = did
        self._known = {did, *also_known}

    def sign(self, preimage: bytes) -> bytes:
        return hmac.new(self._KEY, preimage, hashlib.sha256).digest()

    def verify(self, did: str, preimage: bytes, signature: bytes) -> bool:
        if did not in self._known:
            return False
        return hmac.compare_digest(
            hmac.new(self._KEY, preimage, hashlib.sha256).digest(), signature
        )


class _RecordingScheme(_HmacScheme):
    """HMAC stand-in that records whether verification was ever attempted."""

    def __init__(self, did: str) -> None:
        super().__init__(did)
        self.calls = 0

    def verify(self, did: str, preimage: bytes, signature: bytes) -> bool:
        self.calls += 1
        return super().verify(did, preimage, signature)


class _SetNonceStore:
    """In-memory nonce store: a nonce is claimed once per sender."""

    def __init__(self) -> None:
        self.claimed: set[tuple[str, bytes]] = set()

    def claim(self, sender_did: str, nonce: bytes, expires_at: int) -> bool:
        key = (sender_did, nonce)
        if key in self.claimed:
            return False
        self.claimed.add(key)
        return True


_SIGNER: EnvelopeSigner = _HmacScheme(SENDER)
_VERIFIER: EnvelopeVerifier = _HmacScheme(SENDER)
_STORE: NonceStore = _SetNonceStore()


def _envelope(**overrides: object) -> RequestEnvelope:
    fields: dict[str, object] = {
        "sender_did": SENDER,
        "recipient_did": RECIPIENT,
        "action": "negotiate",
        "policy_id": POLICY_ID,
        "nonce": NONCE,
        "issued_at": ISSUED_AT,
        "expires_at": EXPIRES_AT,
        "body_hash": BODY_HASH,
    }
    fields.update(overrides)
    return RequestEnvelope(**fields)  # type: ignore[arg-type]


def _envelope_from_vector(vector: dict[str, Any]) -> RequestEnvelope:
    by_name = {f["name"]: f for f in vector["fields"]}
    assert by_name["domain_sep"]["value_utf8"] == DOMAIN_SEPARATOR
    return RequestEnvelope(
        sender_did=by_name["sender_did"]["value_utf8"],
        recipient_did=by_name["recipient_did"]["value_utf8"],
        action=by_name["action"]["value_utf8"],
        policy_id=by_name["policy_id"]["value_utf8"],
        nonce=bytes.fromhex(by_name["nonce"]["value_hex"]),
        issued_at=int(by_name["issued_at"]["value_hex"], 16),
        expires_at=int(by_name["expires_at"]["value_hex"], 16),
        body_hash=bytes.fromhex(by_name["body_hash"]["value_hex"]),
    )


def _verify(signed: SignedEnvelope, scheme: _HmacScheme, **kwargs: Any) -> None:
    kwargs.setdefault("recipient_did", signed.envelope.recipient_did)
    kwargs.setdefault("expected_body_hash", signed.envelope.body_hash)
    kwargs.setdefault("nonce_store", _SetNonceStore())
    kwargs.setdefault("now", ISSUED_AT)
    verify_envelope(signed, scheme, **kwargs)


# --- Spec conformance ---


def test_spec_publishes_envelope_vectors() -> None:
    assert len(ENVELOPE_VECTORS) >= 2


def test_preimage_matches_transcribed_normative_vector() -> None:
    assert _envelope().preimage().hex() == NEGOTIATE_VECTOR_HEX


@pytest.mark.parametrize("vector", ENVELOPE_VECTORS, ids=lambda v: v["name"])
def test_preimage_is_byte_exact_against_spec_vector(vector: dict[str, Any]) -> None:
    assert _envelope_from_vector(vector).preimage().hex() == vector["encoding_hex"]


@pytest.mark.parametrize("vector", ENVELOPE_VECTORS, ids=lambda v: v["name"])
def test_preimage_round_trips_through_spec_decoder(vector: dict[str, Any]) -> None:
    envelope = _envelope_from_vector(vector)
    values = decode(envelope.preimage(), DID_SIGNED_REQUEST_ENVELOPE.specs)
    assert values == (
        DOMAIN_SEPARATOR.encode(),
        envelope.sender_did.encode(),
        envelope.recipient_did.encode(),
        envelope.action.encode(),
        envelope.policy_id.encode(),
        envelope.nonce,
        envelope.issued_at.to_bytes(8, "big"),
        envelope.expires_at.to_bytes(8, "big"),
        envelope.body_hash,
    )


def test_domain_separator_is_the_registry_entry() -> None:
    assert DID_SIGNED_REQUEST_ENVELOPE.domain_separator == DOMAIN_SEPARATOR
    assert DOC["domain_separator_registry"][DOMAIN_SEPARATOR]


def test_empty_policy_id_is_a_distinct_valid_value() -> None:
    assert _envelope(policy_id="").preimage() != _envelope(policy_id=" ").preimage()


# --- Adversarial re-partitioning ---

SENDER_BOUNDARY_GRANTED = {"sender_did": SENDER, "recipient_did": RECIPIENT}
SENDER_BOUNDARY_FORGED = {"sender_did": SENDER + "did:web", "recipient_did": ":example.com"}

REPARTITIONS = [
    pytest.param(SENDER_BOUNDARY_GRANTED, SENDER_BOUNDARY_FORGED, id="sender-recipient-boundary"),
    pytest.param(
        {"action": "negotiate", "policy_id": POLICY_ID},
        {"action": "negotiatespal:did:pci:cardano", "policy_id": ":addr1abc123:health-records"},
        id="action-policy-boundary",
    ),
    pytest.param(
        {"recipient_did": RECIPIENT, "action": "negotiate"},
        {"recipient_did": "did:web:example.comnego", "action": "tiate"},
        id="recipient-action-boundary",
    ),
    pytest.param(
        {"action": "negotiate", "policy_id": ""},
        {"action": "negotiat", "policy_id": "e"},
        id="empty-field-boundary",
    ),
]


def _raw_concat(fields: dict[str, str]) -> bytes:
    return "".join(fields.values()).encode()


@pytest.mark.parametrize(("granted", "forged"), REPARTITIONS)
def test_repartitioned_fields_collide_raw_but_not_under_canonical_encoding(
    granted: dict[str, str], forged: dict[str, str]
) -> None:
    assert _raw_concat(granted) == _raw_concat(forged), (
        "fixture must reproduce the raw-concatenation collision"
    )
    assert _envelope(**granted).preimage() != _envelope(**forged).preimage()


@pytest.mark.parametrize(("granted", "forged"), REPARTITIONS)
def test_signature_over_granted_envelope_does_not_verify_forged_repartition(
    granted: dict[str, str], forged: dict[str, str]
) -> None:
    forged_envelope = _envelope(**forged)
    scheme = _HmacScheme(SENDER, forged_envelope.sender_did)
    signed = sign_envelope(_envelope(**granted), scheme)
    replayed = SignedEnvelope(envelope=forged_envelope, signature=signed.signature)
    with pytest.raises(EnvelopeSignatureInvalid):
        _verify(replayed, scheme)


def test_shared_key_scheme_would_accept_the_forgery_under_raw_concatenation() -> None:
    forged_envelope = _envelope(**SENDER_BOUNDARY_FORGED)
    scheme = _HmacScheme(SENDER, forged_envelope.sender_did)
    raw_granted = _raw_concat(SENDER_BOUNDARY_GRANTED)
    raw_forged = _raw_concat(SENDER_BOUNDARY_FORGED)
    assert scheme.verify(forged_envelope.sender_did, raw_forged, scheme.sign(raw_granted))


def test_spec_adversarial_vectors_report_canonical_distinctness() -> None:
    for case in DOC["adversarial"]:
        assert case["raw_concat_collides"] is True
        assert case["encoding_distinct"] is True
        assert case["encoding_a_hex"] != case["encoding_b_hex"]


# --- Field validation at the boundary ---


@pytest.mark.parametrize("width", [0, NONCE_WIDTH - 1, NONCE_WIDTH + 1])
def test_nonce_must_be_exactly_sixteen_bytes(width: int) -> None:
    with pytest.raises(ValidationError):
        _envelope(nonce=b"\x77" * width)


@pytest.mark.parametrize("width", [0, BODY_HASH_WIDTH - 1, BODY_HASH_WIDTH + 1])
def test_body_hash_must_be_exactly_thirty_two_bytes(width: int) -> None:
    with pytest.raises(ValidationError):
        _envelope(body_hash=b"\x88" * width)


@pytest.mark.parametrize("field", ["issued_at", "expires_at"])
@pytest.mark.parametrize("value", [-1, 2**64])
def test_timestamps_must_fit_uint64(field: str, value: int) -> None:
    with pytest.raises(ValidationError):
        _envelope(**{field: value})


def test_expiry_must_follow_issue() -> None:
    with pytest.raises(ValidationError):
        _envelope(expires_at=ISSUED_AT)


@pytest.mark.parametrize("field", ["sender_did", "recipient_did", "action"])
def test_identifying_fields_must_not_be_empty(field: str) -> None:
    with pytest.raises(ValidationError):
        _envelope(**{field: ""})


@pytest.mark.parametrize(
    ("field", "limit"),
    [
        ("sender_did", MAX_DID_LENGTH),
        ("recipient_did", MAX_DID_LENGTH),
        ("action", MAX_ACTION_LENGTH),
        ("policy_id", MAX_POLICY_ID_LENGTH),
    ],
)
def test_text_fields_are_bounded(field: str, limit: int) -> None:
    _envelope(**{field: "x" * limit})
    with pytest.raises(ValidationError):
        _envelope(**{field: "x" * (limit + 1)})


def test_signature_is_bounded() -> None:
    SignedEnvelope(envelope=_envelope(), signature=b"s" * MAX_SIGNATURE_LENGTH)
    with pytest.raises(ValidationError):
        SignedEnvelope(envelope=_envelope(), signature=b"s" * (MAX_SIGNATURE_LENGTH + 1))


@pytest.mark.parametrize("field", ["sender_did", "recipient_did", "action", "policy_id"])
def test_text_fields_must_be_utf8_encodable(field: str) -> None:
    with pytest.raises(ValidationError):
        _envelope(**{field: "did:x:\ud800"})


def test_bytes_fields_are_not_coerced_from_strings() -> None:
    with pytest.raises(ValidationError):
        _envelope(nonce="7" * NONCE_WIDTH)


def test_envelope_is_immutable() -> None:
    with pytest.raises(ValidationError):
        _envelope().action = "proof.submit"


def test_json_round_trip_preserves_binary_fields_and_preimage() -> None:
    signed = sign_envelope(_envelope(nonce=new_nonce()), _HmacScheme(SENDER))
    restored = SignedEnvelope.model_validate_json(signed.model_dump_json())
    assert restored == signed
    assert restored.envelope.preimage() == signed.envelope.preimage()


def test_new_nonce_is_random_and_sixteen_bytes() -> None:
    first, second = new_nonce(), new_nonce()
    assert len(first) == len(second) == NONCE_WIDTH
    assert first != second


# --- Signing and verification ---


def test_sign_then_verify_round_trip() -> None:
    scheme = _HmacScheme(SENDER)
    signed = sign_envelope(_envelope(), scheme)
    _verify(signed, scheme, now=ISSUED_AT)
    _verify(signed, scheme, now=EXPIRES_AT - 1)


def test_verify_defaults_to_the_current_time(monkeypatch: pytest.MonkeyPatch) -> None:
    scheme = _HmacScheme(SENDER)
    signed = sign_envelope(_envelope(), scheme)
    monkeypatch.setattr("pci_agent.envelope.time.time", lambda: float(ISSUED_AT + 1))
    _verify(signed, scheme, now=None)
    monkeypatch.setattr("pci_agent.envelope.time.time", lambda: float(EXPIRES_AT + 3600))
    with pytest.raises(EnvelopeExpired):
        _verify(signed, scheme, now=None)


def test_signer_must_be_the_sender() -> None:
    with pytest.raises(ValueError, match="sender"):
        sign_envelope(_envelope(), _HmacScheme(OTHER))


def test_tampered_signature_is_rejected() -> None:
    scheme = _HmacScheme(SENDER)
    signed = sign_envelope(_envelope(), scheme)
    tampered = SignedEnvelope(
        envelope=signed.envelope,
        signature=bytes([signed.signature[0] ^ 0x01]) + signed.signature[1:],
    )
    with pytest.raises(EnvelopeSignatureInvalid):
        _verify(tampered, scheme)


def test_signature_is_rejected_for_unknown_sender() -> None:
    signed = sign_envelope(_envelope(), _HmacScheme(SENDER))
    with pytest.raises(EnvelopeSignatureInvalid):
        _verify(signed, _HmacScheme(OTHER))


def test_envelope_addressed_elsewhere_is_rejected() -> None:
    scheme = _HmacScheme(SENDER)
    signed = sign_envelope(_envelope(), scheme)
    with pytest.raises(EnvelopeMisaddressed):
        _verify(signed, scheme, recipient_did="did:web:other.example")


def test_body_hash_must_match_the_delivered_payload() -> None:
    scheme = _HmacScheme(SENDER)
    signed = sign_envelope(_envelope(), scheme)
    with pytest.raises(EnvelopeBodyMismatch):
        _verify(signed, scheme, expected_body_hash=b"\x89" * BODY_HASH_WIDTH)


def test_replayed_nonce_is_rejected_per_sender() -> None:
    scheme = _HmacScheme(SENDER, OTHER)
    store = _SetNonceStore()
    signed = sign_envelope(_envelope(), scheme)
    _verify(signed, scheme, nonce_store=store)
    with pytest.raises(EnvelopeReplayed):
        _verify(signed, scheme, nonce_store=store)
    from_other = sign_envelope(_envelope(sender_did=OTHER), _HmacScheme(OTHER))
    _verify(from_other, scheme, nonce_store=store)


def test_nonce_is_not_claimed_when_the_signature_fails() -> None:
    scheme = _HmacScheme(SENDER)
    store = _SetNonceStore()
    signed = sign_envelope(_envelope(), scheme)
    with pytest.raises(EnvelopeSignatureInvalid):
        _verify(signed, _HmacScheme(OTHER), nonce_store=store)
    assert store.claimed == set()
    _verify(signed, scheme, nonce_store=store)


def test_leeway_tolerates_clock_skew_at_both_ends() -> None:
    scheme = _HmacScheme(SENDER)
    signed = sign_envelope(_envelope(), scheme)
    _verify(signed, scheme, now=ISSUED_AT - DEFAULT_LEEWAY_SECONDS)
    _verify(signed, scheme, now=EXPIRES_AT + DEFAULT_LEEWAY_SECONDS - 1)


def test_envelope_before_issue_time_beyond_leeway_is_rejected() -> None:
    scheme = _HmacScheme(SENDER)
    signed = sign_envelope(_envelope(), scheme)
    with pytest.raises(EnvelopeNotYetValid):
        _verify(signed, scheme, now=ISSUED_AT - DEFAULT_LEEWAY_SECONDS - 1)


def test_expired_envelope_beyond_leeway_is_rejected() -> None:
    scheme = _HmacScheme(SENDER)
    signed = sign_envelope(_envelope(), scheme)
    with pytest.raises(EnvelopeExpired):
        _verify(signed, scheme, now=EXPIRES_AT + DEFAULT_LEEWAY_SECONDS)


def test_zero_leeway_is_strict() -> None:
    scheme = _HmacScheme(SENDER)
    signed = sign_envelope(_envelope(), scheme)
    with pytest.raises(EnvelopeNotYetValid):
        _verify(signed, scheme, now=ISSUED_AT - 1, leeway=0)
    with pytest.raises(EnvelopeExpired):
        _verify(signed, scheme, now=EXPIRES_AT, leeway=0)


def test_validity_window_longer_than_max_lifetime_is_rejected() -> None:
    scheme = _HmacScheme(SENDER)
    signed = sign_envelope(_envelope(expires_at=EXPIRES_AT + 1), scheme)
    with pytest.raises(EnvelopeLifetimeExceeded):
        _verify(signed, scheme)
    _verify(signed, scheme, max_lifetime=DEFAULT_MAX_LIFETIME_SECONDS + 1)


@pytest.mark.parametrize("option", ["leeway", "max_lifetime"])
def test_negative_verifier_settings_are_configuration_errors(option: str) -> None:
    scheme = _RecordingScheme(SENDER)
    signed = sign_envelope(_envelope(), scheme)
    with pytest.raises(ValueError, match=option):
        _verify(signed, scheme, **{option: -1})
    assert scheme.calls == 0


def test_verifier_settings_are_keyword_only() -> None:
    scheme = _HmacScheme(SENDER)
    signed = sign_envelope(_envelope(), scheme)
    with pytest.raises(TypeError):
        verify_envelope(signed, scheme, RECIPIENT)  # type: ignore[call-arg]


def test_signature_is_not_checked_until_cheap_checks_pass() -> None:
    scheme = _RecordingScheme(SENDER)
    signed = sign_envelope(_envelope(), scheme)
    for failing in (
        {"recipient_did": "did:web:other.example"},
        {"now": EXPIRES_AT + DEFAULT_LEEWAY_SECONDS},
        {"now": ISSUED_AT - DEFAULT_LEEWAY_SECONDS - 1},
        {"max_lifetime": 1},
        {"expected_body_hash": b"\x00" * BODY_HASH_WIDTH},
    ):
        with pytest.raises(EnvelopeInvalid):
            _verify(signed, scheme, **failing)
    assert scheme.calls == 0


def test_verification_errors_share_a_base() -> None:
    for error in (
        EnvelopeSignatureInvalid,
        EnvelopeMisaddressed,
        EnvelopeExpired,
        EnvelopeNotYetValid,
        EnvelopeLifetimeExceeded,
        EnvelopeBodyMismatch,
        EnvelopeReplayed,
    ):
        assert issubclass(error, EnvelopeInvalid)


def test_empty_signature_is_rejected() -> None:
    with pytest.raises(ValidationError):
        SignedEnvelope(envelope=_envelope(), signature=b"")
