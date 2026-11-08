"""The policy-terms vectors: what a business agrees to, with the holder's handles removed.

The vectors are the contract between the identity package's ``exportTerms``
and the agent's ``export_terms``; both test suites reproduce them. This test
checks the vectors themselves: only contractual keys, every handle gone, and
the hash consistent with the canonical text.
"""

import hashlib
import json
import re
from pathlib import Path

import pytest

SCHEMA_DIR = Path(__file__).resolve().parents[1] / "schemas" / "spal" / "v1.0"
VECTORS = json.loads((SCHEMA_DIR / "terms-vectors.json").read_text())["vectors"]


def test_vectors_cover_the_three_cases() -> None:
    names = {v["name"] for v in VECTORS}
    assert names >= {"health-records", "employment", "unsorted-rules-with-handles"}


@pytest.mark.parametrize("vector", VECTORS, ids=lambda v: v["name"])
def test_terms_carry_only_contractual_keys(vector: dict) -> None:
    terms = json.loads(vector["terms_canonical_json"])
    assert set(terms) <= {"version", "rules", "enforcement"}
    for rule in terms["rules"]:
        assert set(rule) == {"context_scope", "conditions"}
    if "enforcement" in terms:
        assert set(terms["enforcement"]) == {"validators"}
    assert re.fullmatch(r"[0-9a-f]{64}", vector["terms_hash"])
    digest = hashlib.sha256(vector["terms_canonical_json"].encode()).hexdigest()
    assert digest == vector["terms_hash"]


@pytest.mark.parametrize("vector", VECTORS, ids=lambda v: v["name"])
def test_terms_omit_every_handle(vector: dict) -> None:
    text = vector["terms_canonical_json"]
    policy = vector["policy"]
    for handle in (policy["id"], policy["owner"], policy["name"]):
        assert handle not in text
    for rule in policy["rules"]:
        assert f'"{rule["id"]}"' not in text
