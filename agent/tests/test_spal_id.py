"""A policy's id must embed its owner and name (#81); the schema cannot check it, the agent does."""

import pytest

from freehold_agent.spal import SPALPolicy


def _policy(policy_id: str, owner: str, name: str = "Age") -> dict:
    return {
        "version": "1.0",
        "id": policy_id,
        "name": name,
        "owner": owner,
        "rules": [{"id": "r", "context_scope": "personal/age", "conditions": {}}],
    }


def test_id_must_embed_the_owner_and_name() -> None:
    policy = SPALPolicy.model_validate(_policy("spal:did:key:z6Mkabc:age", "did:key:z6Mkabc"))
    assert policy.key_name == "age"
    with pytest.raises(ValueError, match="id"):
        SPALPolicy.model_validate(_policy("spal:did:key:z6Mkother:age", "did:key:z6Mkabc"))


def test_owner_must_be_a_did() -> None:
    with pytest.raises(ValueError, match="owner"):
        SPALPolicy.model_validate(_policy("spal:not-a-did:age", "not-a-did"))


def test_name_segment_may_contain_anything_but_a_colon() -> None:
    policy = SPALPolicy.model_validate(_policy("spal:did:key:z6Mkabc:a/b c", "did:key:z6Mkabc"))
    assert policy.key_name == "a/b c"
    with pytest.raises(ValueError, match="id"):
        SPALPolicy.model_validate(_policy("spal:did:key:z6Mkabc:", "did:key:z6Mkabc"))
