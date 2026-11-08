"""S-PAL 1.1: the `custody` condition, which says whose machine may work on the data.

1.1 is 1.0 plus one condition. The identifier rules are 1.0's, so they are
reused; what is checked here is what 1.1 adds and that the bundled 1.1
examples carry it.
"""

import json
from pathlib import Path

import pytest

from test_spal_schema import is_owner, is_policy_id

SCHEMA_DIR = Path(__file__).resolve().parents[1] / "schemas" / "spal" / "v1.1"
SCHEMA = json.loads((SCHEMA_DIR / "schema.json").read_text())
EXAMPLES = sorted((SCHEMA_DIR / "examples").glob("*.json"))

OPERATORS = [
    "device_only",
    "owned_hardware",
    "community_node",
    "federated_operator",
    "attested_enclave",
    "any",
]


def test_version_and_id_name_1_1() -> None:
    assert SCHEMA["properties"]["version"]["const"] == "1.1"
    assert SCHEMA["$id"].endswith("/spal/v1.1/schema.json")


def test_custody_is_a_condition_with_the_ladder_in_order() -> None:
    assert SCHEMA["$defs"]["Conditions"]["properties"]["custody"] == {
        "$ref": "#/$defs/CustodyPolicy"
    }
    custody = SCHEMA["$defs"]["CustodyPolicy"]
    assert custody["properties"]["operator"]["enum"] == OPERATORS
    assert custody["properties"]["hosted_models"]["enum"] == ["forbidden", "allowed"]
    assert custody["properties"]["hosted_models"]["default"] == "forbidden"
    assert custody["properties"]["attestation_required"]["default"] is False
    assert custody["required"] == ["operator"]
    assert custody["additionalProperties"] is False


def test_1_1_keeps_every_1_0_definition() -> None:
    v10 = json.loads((SCHEMA_DIR.parent / "v1.0" / "schema.json").read_text())
    for name, definition in v10["$defs"].items():
        if name == "Conditions":
            continue
        assert SCHEMA["$defs"][name] == definition, name


def test_examples_are_present() -> None:
    assert {p.stem for p in EXAMPLES} == {"health-records", "employment"}


@pytest.mark.parametrize("path", EXAMPLES, ids=lambda p: p.stem)
def test_examples_are_1_1_and_carry_custody(path: Path) -> None:
    policy = json.loads(path.read_text())
    assert policy["version"] == "1.1"
    assert is_owner(policy["owner"])
    assert is_policy_id(policy["id"])
    with_custody = [r for r in policy["rules"] if "custody" in r["conditions"]]
    assert with_custody, "an example should show the condition"
    for rule in with_custody:
        assert rule["conditions"]["custody"]["operator"] in OPERATORS
