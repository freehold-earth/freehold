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
