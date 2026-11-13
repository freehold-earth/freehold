"""The terms receipt, checked as spec/protocols/terms-receipt.md has the holder's agent check it."""

from __future__ import annotations

import base64
import hmac
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, get_args

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from freehold_agent.custody import Operator
from freehold_agent.didkey import NotAnEd25519DidKey
from freehold_agent.errors import ReceiptInvalid, ReceiptRefusal
from freehold_agent.receipt import (
    LABEL,
    SERVED_AT_ALLOWANCE,
    AwaitedReceipt,
    Receipt,
    RequestLabel,
    request_key,
)
from freehold_agent.spal import (
    Conditions,
    CustodyPolicy,
    DerivativePermission,
    DerivativePolicy,
    RetentionPolicy,
)
from tests.test_attestation import did_key

AUDIT_KEY = b"a" * 32
REQUEST = b'{"method":"tools/call","params":{"name":"ask"}}'
TERMS_HASH = "ab" * 32
SENT_AT = datetime(2026, 11, 11, 12, 0, 0, tzinfo=UTC)
RECEIVED_AT = SENT_AT + timedelta(seconds=4)
OPERATOR_KEY = Ed25519PrivateKey.from_private_bytes(bytes(range(32, 64)))
OPERATOR_DID = did_key(OPERATOR_KEY)
VECTORS = Path(__file__).parents[2] / "spec/schemas/encoding/v1.0/test-vectors.json"

FEDERATED = Conditions(custody=CustodyPolicy(operator=Operator.FEDERATED_OPERATOR))


def _label() -> RequestLabel:
    return RequestLabel.mint(AUDIT_KEY, OPERATOR_DID, REQUEST)


def _awaited(label: RequestLabel, conditions: Conditions = FEDERATED) -> AwaitedReceipt:
    return AwaitedReceipt(label, terms_hash=TERMS_HASH, conditions=conditions, sent_at=SENT_AT)


def _signed(
    label: RequestLabel, key: Ed25519PrivateKey = OPERATOR_KEY, **overrides: Any
) -> dict[str, Any]:
    """A receipt for the labelled request as an operator's gate would return it."""
    members: dict[str, Any] = {
        "operator_did": label.operator_did,
        "terms_hash": TERMS_HASH,
        "nonce": label.nonce.hex(),
        "commitment": label.commitment.hex(),
        "request_id": "req-7f3e2a1c",
        "served_at": int(SENT_AT.timestamp()) + 2,
        "custody": "federated_operator",
        "retention_seconds": 0,
        "training": "forbidden",
        "aggregation": "forbidden",
        "resale": "forbidden",
    }
    members.update(overrides)
    members["signature"] = base64.b64encode(b"\x00" * 64).decode()
    signature = key.sign(Receipt.model_validate(members).preimage())
    members["signature"] = base64.b64encode(signature).decode()
    return members


def _refusal(awaited: AwaitedReceipt, presented: object) -> ReceiptInvalid:
    with pytest.raises(ReceiptInvalid) as caught:
        awaited.accept(presented, received_at=RECEIVED_AT)
    return caught.value


# --- The label a request is sent under ---


def test_a_label_is_a_fresh_nonce_and_the_commitment_the_spec_derives() -> None:
    label = _label()
    assert len(label.nonce) == 16
    key = hmac.new(
        AUDIT_KEY, b"spal/receipt/v1\x00" + OPERATOR_DID.encode() + b"\x00" + label.nonce, "sha256"
    ).digest()
    assert request_key(AUDIT_KEY, OPERATOR_DID, label.nonce) == key
    assert label.commitment == hmac.new(key, REQUEST, "sha256").digest()


def test_two_labels_for_the_same_bytes_share_nothing() -> None:
    first, second = _label(), _label()
    assert first.nonce != second.nonce
    assert first.commitment != second.commitment


def test_the_operator_is_in_the_key_so_a_shared_nonce_shares_no_key() -> None:
    nonce = bytes(16)
    assert request_key(AUDIT_KEY, OPERATOR_DID, nonce) != request_key(AUDIT_KEY, "", nonce)


def test_a_request_to_no_operator_is_labelled_the_same_way() -> None:
    label = RequestLabel.mint(AUDIT_KEY, "", REQUEST)
    key = request_key(AUDIT_KEY, "", label.nonce)
    assert label.commitment == hmac.new(key, REQUEST, "sha256").digest()


def test_a_did_with_a_nul_byte_or_a_nonce_of_another_length_derives_no_key() -> None:
    with pytest.raises(ValueError, match="NUL"):
        RequestLabel.mint(AUDIT_KEY, "did:key:z6Mk\x00x", REQUEST)
    with pytest.raises(ValueError, match="16 bytes"):
        request_key(AUDIT_KEY, OPERATOR_DID, bytes(15))


@pytest.mark.parametrize(
    ("custody", "owed"),
    [
        (Operator.DEVICE_ONLY, False),
        (Operator.OWNED_HARDWARE, False),
        (Operator.COMMUNITY_NODE, True),
        (Operator.FEDERATED_OPERATOR, True),
        (Operator.ATTESTED_ENCLAVE, True),
        (Operator.ANY, True),
    ],
)
def test_a_machine_has_an_operator_from_community_node_on(custody: Operator, owed: bool) -> None:
    assert custody.has_operator is owed


def test_a_receipt_takes_exactly_the_custody_levels() -> None:
    """The wire model spells the levels out for exact parsing; they must stay the enum's."""
    assert get_args(Receipt.model_fields["custody"].annotation) == tuple(o.value for o in Operator)


# --- The bytes an operator signs ---


@pytest.mark.parametrize("name", ["receipt-served", "receipt-empty-request-id"])
def test_the_preimage_reproduces_the_spec_vector(name: str) -> None:
    [vector] = [v for v in json.loads(VECTORS.read_text())["vectors"] if v["name"] == name]
    fields = {f["name"]: f for f in vector["fields"]}
    assert fields["domain_sep"]["value_utf8"] == LABEL
    receipt = Receipt(
        signature=base64.b64encode(bytes(64)).decode(),
        **{
            name: (
                int(field["value_hex"], 16)
                if name in ("served_at", "retention_seconds")
                else field.get("value_utf8", field.get("value_hex"))
            )
            for name, field in fields.items()
            if name != "domain_sep"
        },
    )
    assert receipt.preimage().hex() == vector["encoding_hex"]


# --- Acceptance ---


def test_the_receipt_for_the_request_is_accepted_and_returned_as_parsed() -> None:
    label = _label()
    presented = _signed(label)
    receipt = _awaited(label).accept(presented, received_at=RECEIVED_AT)
    assert receipt.model_dump() == presented


def test_a_response_without_a_receipt_is_refused_as_missing() -> None:
    assert _refusal(_awaited(_label()), None).refusal is ReceiptRefusal.MISSING


def test_a_receipt_signed_as_another_operator_is_refused_before_its_signature_is_read() -> None:
    label = _label()
    other = Ed25519PrivateKey.generate()
    presented = _signed(label, key=other, operator_did=did_key(other))
    assert _refusal(_awaited(label), presented).refusal is ReceiptRefusal.OPERATOR


def test_a_receipt_another_key_signed_in_the_operators_name_is_refused() -> None:
    label = _label()
    presented = _signed(label, key=Ed25519PrivateKey.generate())
    assert _refusal(_awaited(label), presented).refusal is ReceiptRefusal.SIGNATURE


@pytest.mark.parametrize(
    "member", ["request_id", "served_at", "custody", "retention_seconds", "training"]
)
def test_a_receipt_changed_after_signing_is_refused(member: str) -> None:
    label = _label()
    changed = {
        "request_id": "req-other",
        "served_at": int(SENT_AT.timestamp()) + 3,
        "custody": "community_node",
        "retention_seconds": 1,
        "training": "allowed",
    }
    presented = _signed(label) | {member: changed[member]}
    assert _refusal(_awaited(label), presented).refusal is ReceiptRefusal.SIGNATURE


def test_a_receipt_for_other_terms_is_refused() -> None:
    label = _label()
    presented = _signed(label, terms_hash="cd" * 32)
    assert _refusal(_awaited(label), presented).refusal is ReceiptRefusal.TERMS


def test_a_receipt_for_another_request_to_the_same_operator_is_refused() -> None:
    """Same bytes, same operator, same terms: the nonce alone tells the two requests apart."""
    label, other = _label(), _label()
    assert _refusal(_awaited(label), _signed(other)).refusal is ReceiptRefusal.NONCE


def test_a_receipt_with_another_commitment_is_refused() -> None:
    label = _label()
    presented = _signed(label, commitment="ef" * 32)
    assert _refusal(_awaited(label), presented).refusal is ReceiptRefusal.COMMITMENT


# --- One receipt, one request ---


def test_a_receipt_cannot_be_presented_twice() -> None:
    label = _label()
    awaited, presented = _awaited(label), _signed(label)
    awaited.accept(presented, received_at=RECEIVED_AT)
    assert _refusal(awaited, presented).refusal is ReceiptRefusal.SPENT


def test_a_failed_receipt_spends_the_nonce_so_a_good_one_cannot_follow() -> None:
    label = _label()
    awaited = _awaited(label)
    assert _refusal(awaited, _signed(label, terms_hash="cd" * 32)).refusal is ReceiptRefusal.TERMS
    assert _refusal(awaited, _signed(label)).refusal is ReceiptRefusal.SPENT


def test_a_missing_receipt_spends_the_nonce_too() -> None:
    label = _label()
    awaited = _awaited(label)
    assert _refusal(awaited, None).refusal is ReceiptRefusal.MISSING
    assert _refusal(awaited, _signed(label)).refusal is ReceiptRefusal.SPENT


# --- The time it was served ---


@pytest.mark.parametrize(
    ("served_at", "accepted"),
    [
        (SENT_AT - SERVED_AT_ALLOWANCE, True),
        (SENT_AT - SERVED_AT_ALLOWANCE - timedelta(seconds=1), False),
        (RECEIVED_AT + SERVED_AT_ALLOWANCE, True),
        (RECEIVED_AT + SERVED_AT_ALLOWANCE + timedelta(seconds=1), False),
    ],
)
def test_served_at_lies_within_the_allowance_around_the_call(
    served_at: datetime, accepted: bool
) -> None:
    label = _label()
    presented = _signed(label, served_at=int(served_at.timestamp()))
    if accepted:
        _awaited(label).accept(presented, received_at=RECEIVED_AT)
    else:
        assert _refusal(_awaited(label), presented).refusal is ReceiptRefusal.SERVED_AT


def test_the_times_of_the_call_need_a_timezone() -> None:
    label = _label()
    with pytest.raises(ValueError, match="timezone"):
        AwaitedReceipt(
            label, terms_hash=TERMS_HASH, conditions=FEDERATED, sent_at=datetime(2026, 11, 11)
        )
    awaited = _awaited(label)
    with pytest.raises(ValueError, match="timezone"):
        awaited.accept(_signed(label), received_at=datetime(2026, 11, 11))
    # A caller's mistake spends nothing: the receipt can still be presented.
    awaited.accept(_signed(label), received_at=RECEIVED_AT)
    # And once spent, the same mistake is told it is spent, so nothing invites a retry.
    with pytest.raises(ReceiptInvalid, match="spent"):
        awaited.accept(_signed(label), received_at=datetime(2026, 11, 11))


# --- The conditions against the rule's ---


def test_custody_beyond_the_rules_ceiling_is_refused() -> None:
    label = _label()
    rule = Conditions(custody=CustodyPolicy(operator=Operator.COMMUNITY_NODE))
    error = _refusal(_awaited(label, rule), _signed(label))
    assert error.refusal is ReceiptRefusal.CONDITIONS
    assert "custody" in error.detail


def test_custody_safer_than_the_ceiling_is_accepted() -> None:
    label = _label()
    _awaited(label).accept(_signed(label, custody="community_node"), received_at=RECEIVED_AT)


def test_a_rule_silent_on_custody_has_the_ceiling_owned_hardware() -> None:
    label = _label()
    silent = Conditions()
    error = _refusal(_awaited(label, silent), _signed(label, custody="community_node"))
    assert error.refusal is ReceiptRefusal.CONDITIONS
    label = _label()
    _awaited(label, silent).accept(
        _signed(label, custody="owned_hardware"), received_at=RECEIVED_AT
    )


def test_retention_above_the_rules_is_refused_and_at_it_accepted() -> None:
    rule = FEDERATED.model_copy(update={"retention": RetentionPolicy(max_seconds=3600)})
    label = _label()
    error = _refusal(_awaited(label, rule), _signed(label, retention_seconds=3601))
    assert error.refusal is ReceiptRefusal.CONDITIONS
    assert "retention" in error.detail
    label = _label()
    _awaited(label, rule).accept(_signed(label, retention_seconds=3600), received_at=RECEIVED_AT)


@pytest.mark.parametrize(
    ("claimed", "condition"),
    [
        ({"retention_seconds": 1}, "retention"),
        ({"training": "allowed"}, "training"),
        ({"training": "requires_payment"}, "training"),
        ({"aggregation": "anonymized_only"}, "aggregation"),
        ({"resale": "requires_consent"}, "resale"),
    ],
)
def test_a_rule_silent_on_retention_and_derivatives_permits_neither(
    claimed: dict[str, object], condition: str
) -> None:
    label = _label()
    error = _refusal(_awaited(label), _signed(label, **claimed))
    assert error.refusal is ReceiptRefusal.CONDITIONS
    assert condition in error.detail


def test_a_rule_that_states_retention_alone_still_forbids_derivatives() -> None:
    rule = FEDERATED.model_copy(update={"retention": RetentionPolicy(max_seconds=3600)})
    label = _label()
    error = _refusal(
        _awaited(label, rule), _signed(label, retention_seconds=3600, training="allowed")
    )
    assert error.refusal is ReceiptRefusal.CONDITIONS
    assert "training" in error.detail


def test_a_rule_that_states_derivatives_alone_still_permits_no_retention() -> None:
    rule = FEDERATED.model_copy(
        update={"derivatives": DerivativePolicy(training=DerivativePermission.ALLOWED)}
    )
    label = _label()
    error = _refusal(_awaited(label, rule), _signed(label, retention_seconds=1, training="allowed"))
    assert error.refusal is ReceiptRefusal.CONDITIONS
    assert "retention" in error.detail


def test_a_rule_silent_on_retention_and_derivatives_accepts_the_strictest() -> None:
    label = _label()
    presented = _signed(
        label,
        retention_seconds=0,
        training="forbidden",
        aggregation="forbidden",
        resale="forbidden",
    )
    receipt = _awaited(label).accept(presented, received_at=RECEIVED_AT)
    assert receipt.retention_seconds == 0


@pytest.mark.parametrize(
    ("asked", "committed", "accepted"),
    [
        (DerivativePermission.FORBIDDEN, "forbidden", True),
        (DerivativePermission.FORBIDDEN, "allowed", False),
        (DerivativePermission.REQUIRES_PAYMENT, "requires_payment", True),
        (DerivativePermission.REQUIRES_PAYMENT, "forbidden", True),
        (DerivativePermission.REQUIRES_PAYMENT, "allowed", False),
        (DerivativePermission.ALLOWED, "allowed", True),
        (DerivativePermission.ALLOWED, "forbidden", True),
        # No value but forbidden counts as stricter than the rule's own.
        (DerivativePermission.ALLOWED, "requires_payment", False),
    ],
)
def test_a_derivative_satisfies_the_rule_by_equalling_it_or_being_forbidden(
    asked: DerivativePermission, committed: str, accepted: bool
) -> None:
    rule = FEDERATED.model_copy(update={"derivatives": DerivativePolicy(training=asked)})
    label = _label()
    presented = _signed(label, training=committed)
    if accepted:
        _awaited(label, rule).accept(presented, received_at=RECEIVED_AT)
    else:
        error = _refusal(_awaited(label, rule), presented)
        assert error.refusal is ReceiptRefusal.CONDITIONS
        assert "training" in error.detail


@pytest.mark.parametrize("name", ["aggregation", "resale"])
def test_every_derivative_is_compared_not_the_first_alone(name: str) -> None:
    rule = FEDERATED.model_copy(update={"derivatives": DerivativePolicy()})
    label = _label()
    error = _refusal(_awaited(label, rule), _signed(label, **{name: "allowed"}))
    assert error.refusal is ReceiptRefusal.CONDITIONS
    assert name in error.detail


# --- The object is refused before any signature check when it is not exact ---

_GOOD_SIGNATURE = base64.b64encode(bytes(range(64))).decode()


@pytest.mark.parametrize(
    ("member", "value"),
    [
        ("terms_hash", "AB" * 32),  # Uppercase hex.
        ("terms_hash", "ab" * 31),  # Short.
        ("terms_hash", "ab" * 32 + "\n"),
        ("nonce", "ab" * 32),  # A hash's length, not a nonce's.
        ("commitment", "zz" * 32),
        ("served_at", -1),
        ("served_at", 1.0),
        ("served_at", "1753000000"),
        ("served_at", True),
        ("served_at", 2**53),
        ("retention_seconds", 0.5),
        ("retention_seconds", 2**53),
        ("custody", "Federated_Operator"),
        ("custody", "federated-operator"),
        ("training", "requires_consent"),  # Resale's value, not training's.
        ("aggregation", "requires_payment"),
        ("resale", "anonymized_only"),
        ("request_id", 7),
        ("request_id", "﻿req"),  # A byte-order mark the encoding refuses.
        ("request_id", "r" * 129),  # The handle is kept in the holder's log, so it is short,
        ("request_id", "req\u2028next"),  # and on one line, however a reader splits lines.
        ("request_id", "req\u0085next"),
        ("request_id", "req\nnext"),
        ("request_id", "req\u200bnext"),
        ("operator_did", None),
        ("signature", _GOOD_SIGNATURE.rstrip("=")),  # Unpadded.
        ("signature", _GOOD_SIGNATURE[:40] + "\n" + _GOOD_SIGNATURE[40:]),
        ("signature", _GOOD_SIGNATURE.replace("+", "-").replace("/", "_")[:-4] + "-_8="),
        ("signature", base64.b64encode(bytes(63)).decode()),  # Not a signature's length.
        ("signature", base64.b64encode(bytes(64)).decode()[:-2] + "B="),  # Non-canonical tail.
    ],
)
def test_an_inexact_object_is_malformed(member: str, value: object) -> None:
    label = _label()
    error = _refusal(_awaited(label), _signed(label) | {member: value})
    assert error.refusal is ReceiptRefusal.MALFORMED
    assert member in error.detail


@pytest.mark.parametrize("member", ["operator_did", "nonce", "request_id", "signature", "resale"])
def test_a_missing_member_is_malformed(member: str) -> None:
    label = _label()
    presented = _signed(label)
    del presented[member]
    error = _refusal(_awaited(label), presented)
    assert error.refusal is ReceiptRefusal.MALFORMED
    assert member in error.detail


def test_an_unknown_member_is_malformed_and_its_name_is_not_repeated() -> None:
    """The name of a member the receipt does not have is the presenter's text, of any length."""
    label = _label()
    error = _refusal(_awaited(label), _signed(label) | {"x-injected": "member"})
    assert error.refusal is ReceiptRefusal.MALFORMED
    assert "injected" not in str(error)


@pytest.mark.parametrize("presented", ["a receipt", 7, [], b"{}"])
def test_what_is_not_an_object_is_malformed(presented: object) -> None:
    assert _refusal(_awaited(_label()), presented).refusal is ReceiptRefusal.MALFORMED


def test_a_malformed_detail_names_the_member_and_never_the_value() -> None:
    label = _label()
    error = _refusal(_awaited(label), _signed(label) | {"request_id": "﻿secret-handle"})
    assert "request_id" in error.detail
    assert "secret-handle" not in str(error)


# --- Who can be awaited ---


@pytest.mark.parametrize("did", ["did:web:operator.example", "", "did:key:z6Mkoperator789"])
def test_only_a_did_key_operator_can_owe_a_receipt(did: str) -> None:
    """A did:web receipt is no receipt until its key naming is decided (#136)."""
    label = RequestLabel.mint(AUDIT_KEY, did, REQUEST)
    with pytest.raises(NotAnEd25519DidKey):
        _awaited(label)


def test_a_terms_hash_that_is_not_one_awaits_nothing() -> None:
    with pytest.raises(ValueError, match="terms hash"):
        AwaitedReceipt(_label(), terms_hash="AB" * 32, conditions=FEDERATED, sent_at=SENT_AT)
