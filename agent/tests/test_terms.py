"""The agent's policy-terms export against the spec vectors (spec/protocols/policy-terms.md)."""

import json
from pathlib import Path

import pytest

from freehold_agent.authorization import canonical_json
from freehold_agent.terms import export_terms, terms_hash

VECTORS_FILE = Path(__file__).resolve().parents[2] / "spec/schemas/spal/v1.0/terms-vectors.json"
VECTORS = json.loads(VECTORS_FILE.read_text())["vectors"]


@pytest.mark.parametrize("vector", VECTORS, ids=lambda v: v["name"])
def test_export_reproduces_the_spec_vector(vector: dict) -> None:
    assert canonical_json(export_terms(vector["policy"])) == vector["terms_canonical_json"]
    assert terms_hash(vector["policy"]) == vector["terms_hash"]


def test_export_is_an_allowlist() -> None:
    policy = json.loads(json.dumps(VECTORS[0]["policy"]))
    policy["persona"] = {"type": "personal"}
    policy["rules"][0]["note"] = "x"
    terms = export_terms(policy)
    assert "persona" not in terms
    assert "note" not in terms["rules"][0]


def test_export_requires_version_and_rules() -> None:
    with pytest.raises(ValueError, match="rules"):
        export_terms({"version": "1.0"})
    with pytest.raises(ValueError, match="version"):
        export_terms({"rules": []})


def test_conditions_are_exported_by_allowlist_too() -> None:
    policy = json.loads(json.dumps(VECTORS[0]["policy"]))
    conditions = policy["rules"][0]["conditions"]
    conditions["processing"] = {"locality": "device_only"}
    conditions["retention"] = {"max_seconds": 0, "audit_log": True, "shred": True}
    conditions["proofs"] = [{"type": "zkp", "claim": "x", "params": {"k": 1}, "note": "n"}]
    exported = export_terms(policy)["rules"]
    exported_conditions = next(
        r["conditions"]
        for r in exported
        if r["context_scope"] == policy["rules"][0]["context_scope"]
    )
    assert "processing" not in exported_conditions
    assert exported_conditions["retention"] == {"max_seconds": 0, "audit_log": True}
    assert exported_conditions["proofs"] == [{"type": "zkp", "claim": "x", "params": {"k": 1}}]


def test_rules_sort_by_utf16_code_units_like_canonical_json_keys() -> None:
    vector = next(v for v in VECTORS if v["name"] == "utf16-order")
    scopes = [r["context_scope"] for r in export_terms(vector["policy"])["rules"]]
    assert scopes == ["personal/\U0001f600", "personal/～"]


@pytest.mark.parametrize(
    "rule",
    [
        "not a rule",
        {"context_scope": 7, "conditions": {}},
        {"context_scope": "a/b"},
        {"context_scope": "a/b", "conditions": []},
    ],
    ids=["not-an-object", "scope-not-text", "no-conditions", "conditions-not-object"],
)
def test_a_malformed_rule_has_no_terms(rule: object) -> None:
    with pytest.raises(ValueError, match="rule"):
        export_terms({"version": "1.0", "rules": [rule]})


def test_validators_must_be_text() -> None:
    policy = {"version": "1.0", "rules": [], "enforcement": {"validators": ["cardano", 1]}}
    with pytest.raises(ValueError, match="validators"):
        export_terms(policy)


def test_an_integer_beyond_the_safe_range_has_no_terms() -> None:
    policy = json.loads(json.dumps(VECTORS[0]["policy"]))
    policy["rules"][0]["conditions"]["retention"] = {"max_seconds": 2**53}
    with pytest.raises(ValueError):
        export_terms(policy)


@pytest.mark.parametrize(
    "value",
    [2**53, -1, 1.5, "0", True],
    ids=["too-large", "negative", "float", "text", "bool"],
)
def test_integer_fields_must_be_safe_integers_like_the_typescript_export(value: object) -> None:
    """The identity package refuses these; the agent must refuse them too, or the hashes diverge."""
    policy = json.loads(json.dumps(VECTORS[0]["policy"]))
    policy["rules"][0]["conditions"]["retention"] = {"max_seconds": value}
    with pytest.raises(ValueError, match="safe integer"):
        export_terms(policy)
    policy["rules"][0]["conditions"]["retention"] = {"max_seconds": 0}
    policy["rules"][0]["conditions"]["payment"] = {
        "protocol": "x402",
        "amount": value,
        "currency": "sats",
    }
    with pytest.raises(ValueError, match="safe integer"):
        export_terms(policy)


def test_integral_json_numbers_are_integers_in_both_exports() -> None:
    """JSON ``100.0`` parses as a float here and as the number 100 in JavaScript; same terms."""
    policy = json.loads(json.dumps(VECTORS[0]["policy"]))
    policy["rules"][0]["conditions"]["retention"] = {"max_seconds": 100}
    as_int = terms_hash(policy)
    policy["rules"][0]["conditions"]["retention"] = {"max_seconds": 100.0}
    assert terms_hash(policy) == as_int


def test_a_proof_param_integer_beyond_the_safe_range_has_no_terms() -> None:
    policy = json.loads(json.dumps(VECTORS[0]["policy"]))
    policy["rules"][0]["conditions"]["proofs"] = [
        {"type": "zkp", "claim": "x", "params": {"n": 10**20}}
    ]
    with pytest.raises(ValueError):
        export_terms(policy)
