"""S-PAL 1.1 custody in the agent's model: whose machine may work on the data."""

import json
from pathlib import Path

import pytest

from freehold_agent.spal import CustodyPolicy, HostedModels, Operator, SPALPolicy

OWNER = "did:key:z6Mktest"
SPEC_1_1 = Path(__file__).resolve().parents[2] / "spec/schemas/spal/v1.1/examples"


def _policy(version: str, conditions: dict) -> dict:
    return {
        "version": version,
        "id": f"spal:{OWNER}:age",
        "name": "Age",
        "owner": OWNER,
        "rules": [{"id": "r", "context_scope": "personal/age", "conditions": conditions}],
    }


def test_the_ladder_is_ordered_least_to_most_permissive() -> None:
    assert [o.value for o in Operator] == [
        "device_only",
        "owned_hardware",
        "community_node",
        "federated_operator",
        "attested_enclave",
        "any",
    ]
    assert Operator.DEVICE_ONLY.rank < Operator.OWNED_HARDWARE.rank < Operator.ANY.rank
    assert Operator.FEDERATED_OPERATOR.rank > Operator.COMMUNITY_NODE.rank


def test_custody_parses_with_its_defaults() -> None:
    custody = CustodyPolicy.model_validate({"operator": "federated_operator"})
    assert custody.operator is Operator.FEDERATED_OPERATOR
    assert custody.hosted_models is HostedModels.FORBIDDEN
    assert custody.attestation_required is False


def test_a_1_1_policy_carries_custody() -> None:
    policy = SPALPolicy.model_validate(_policy("1.1", {"custody": {"operator": "device_only"}}))
    assert policy.version == "1.1"
    custody = policy.rules[0].conditions.custody
    assert custody is not None and custody.operator is Operator.DEVICE_ONLY


def test_a_1_0_policy_with_custody_is_refused_by_version() -> None:
    with pytest.raises(ValueError, match="custody needs version 1.1"):
        SPALPolicy.model_validate(_policy("1.0", {"custody": {"operator": "device_only"}}))


def test_a_1_1_policy_without_custody_is_fine() -> None:
    policy = SPALPolicy.model_validate(_policy("1.1", {}))
    assert policy.rules[0].conditions.custody is None


def test_unknown_custody_fields_are_refused() -> None:
    with pytest.raises(ValueError, match="custody.region"):
        SPALPolicy.model_validate(_policy("1.1", {"custody": {"operator": "any", "region": "eu"}}))


@pytest.mark.parametrize("example", sorted(SPEC_1_1.glob("*.json")), ids=lambda p: p.name)
def test_spec_1_1_examples_load(example: Path) -> None:
    policy = SPALPolicy.model_validate_json(example.read_bytes())
    assert any(r.conditions.custody is not None for r in policy.rules)
    assert json.loads(example.read_text())["version"] == "1.1"
