"""The identifier patterns of the S-PAL 1.0 schema, checked against its bundled examples.

Only the ``id`` and ``owner`` patterns and the ``version`` constant are covered;
the examples are not validated against the whole schema here.
"""

import json
import re
from pathlib import Path

import pytest

SCHEMA_DIR = Path(__file__).resolve().parents[1] / "schemas" / "spal" / "v1.0"
SCHEMA = json.loads((SCHEMA_DIR / "schema.json").read_text())
EXAMPLES = sorted((SCHEMA_DIR / "examples").glob("*.json"))

ID_PATTERN_TEXT = SCHEMA["properties"]["id"]["pattern"]
OWNER_PATTERN_TEXT = SCHEMA["properties"]["owner"]["pattern"]
ID_PATTERN = re.compile(ID_PATTERN_TEXT)
OWNER_PATTERN = re.compile(OWNER_PATTERN_TEXT)

# The policy name: anything but a colon or a control character.
NAME_CLASS = r"[^:\x00-\x1f\x7f]+"


def is_owner(value: str) -> bool:
    """Match the whole string, as ECMA-262 ``$`` does in a JSON Schema validator.

    Python's own ``$`` also matches before one trailing newline, so a Python
    ``jsonschema`` validator accepts an owner with a trailing newline where this does not.
    """
    return OWNER_PATTERN.fullmatch(value) is not None


def is_policy_id(value: str) -> bool:
    return ID_PATTERN.fullmatch(value) is not None


def test_policy_id_pattern_embeds_the_owner_pattern() -> None:
    owner_body = OWNER_PATTERN_TEXT.removeprefix("^").removesuffix("$")
    expected = f"^spal:{owner_body}:{NAME_CLASS}$"
    assert expected == ID_PATTERN_TEXT


@pytest.mark.parametrize("path", EXAMPLES, ids=lambda p: p.stem)
def test_example_identifiers_match_the_schema_patterns(path: Path) -> None:
    policy = json.loads(path.read_text())
    assert policy["version"] == SCHEMA["properties"]["version"]["const"]
    assert is_owner(policy["owner"])
    assert is_policy_id(policy["id"])


@pytest.mark.parametrize("path", EXAMPLES, ids=lambda p: p.stem)
def test_example_policy_id_is_owner_did_plus_name(path: Path) -> None:
    policy = json.loads(path.read_text())
    assert policy["id"].startswith(f"spal:{policy['owner']}:")
    assert policy["id"].removeprefix(f"spal:{policy['owner']}:")


@pytest.mark.parametrize(
    "owner",
    [
        "did:key:z6Mkabc",
        "did:prism:abc123",
        "did:web:example.com",
        "did:web:example.com:user:alice",
        "did:key:z6Mk%2Fabc",
        "did:key::abc",
    ],
)
def test_owner_accepts_standard_did_methods(owner: str) -> None:
    assert is_owner(owner)
    assert is_policy_id(f"spal:{owner}:health-records")


def test_last_colon_recovers_an_owner_that_contains_colons() -> None:
    owner = "did:web:example.com:user:alice"
    policy_id = f"spal:{owner}:health-records"
    assert is_policy_id(policy_id)
    recovered_owner, name = policy_id.removeprefix("spal:").rsplit(":", 1)
    assert (recovered_owner, name) == (owner, "health-records")


def test_retired_method_is_not_special_cased_by_the_schema() -> None:
    # did:pci matches the generic method-name production like any other
    # lowercase name; it is retired by convention and has no resolver, and the
    # schema keeps no denylist of method names.
    assert is_owner("did:pci:cardano:addr1abc")


@pytest.mark.parametrize(
    "value",
    [
        "",
        "did:",
        "did:key",
        "did:key:",
        "key:z6Mkabc",
        "spal:did:key:z6Mkabc",
        "did:key:z6Mk abc",
        "did:web:example.com/path?query#fragment",
        "did:KEY:z6Mkabc",
        "did:key:z6Mkabc\n",
        "did:key:abc%zz",
        "did:key:abc%",
        "did:key:abc%2",
    ],
)
def test_malformed_identifiers_are_rejected(value: str) -> None:
    assert not is_owner(value)
    assert not is_policy_id(value)


@pytest.mark.parametrize(
    "policy_id",
    [
        "spal:did:key:z6Mkabc:",
        "spal:did:key:z6Mkabc",
        "spal:did:key:z6Mkabc:a\x00b",
        "spal:did:key:z6Mkabc:a\nb",
        "spal:did:key:z6Mkabc:a\x7fb",
        "spal:did:key:z6Mkabc:health-records\n",
    ],
)
def test_malformed_policy_ids_are_rejected(policy_id: str) -> None:
    assert not is_policy_id(policy_id)


def test_policy_names_keep_spaces_and_non_ascii() -> None:
    assert is_policy_id("spal:did:key:z6Mkabc:Health Records")
    assert is_policy_id("spal:did:key:z6Mkabc:Gesundheitsakten")
