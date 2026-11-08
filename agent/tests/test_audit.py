"""The outbound audit record: one line per model call, written before the call."""

from __future__ import annotations

import hmac
import json
import stat
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path

import pytest
from pydantic import ValidationError

from freehold_agent.audit import JsonlAuditSink, ModelCallRecord, prompt_digest
from freehold_agent.custody import Operator
from freehold_agent.errors import AuditUnavailable

KEY = b"k" * 32
PROMPT = "Context:\n- birthDate: 1990-05-15\n\nQuestion: how old am I?\nAnswer:"


def _record(**overrides: object) -> ModelCallRecord:
    fields: dict[str, object] = {
        "purpose": "ask",
        "backend": "openai",
        "model": "qwen",
        "custody": Operator.OWNED_HARDWARE,
        "policy_id": "spal:did:key:z6Mkroot:age-verification",
        "rule_id": "rule-age",
        "context_scope": "personal/age",
        "context_keys": ["personal-context"],
        "prompt_hmac": prompt_digest(PROMPT, KEY),
    }
    fields.update(overrides)
    return ModelCallRecord(**fields)  # type: ignore[arg-type]


def test_a_record_has_an_id_and_a_utc_timestamp_by_default() -> None:
    record = _record()
    assert len(record.id) == 32
    assert record.timestamp.tzinfo is UTC
    assert record.timestamp <= datetime.now(UTC)


def test_a_record_cannot_be_changed_after_it_is_made() -> None:
    record = _record()
    with pytest.raises(ValidationError):
        record.rule_id = "other"  # type: ignore[misc]


def test_a_record_refuses_a_digest_that_is_not_sha256_hex() -> None:
    with pytest.raises(ValueError):
        _record(prompt_hmac="abc")


def test_the_prompt_digest_is_keyed_so_the_log_alone_cannot_be_brute_forced() -> None:
    """The prompt is a known template around guessable fields; only the key's holder can verify."""
    assert prompt_digest(PROMPT, KEY) == hmac.new(KEY, PROMPT.encode(), sha256).hexdigest()
    assert prompt_digest(PROMPT, KEY) != prompt_digest(PROMPT, b"other key")
    assert prompt_digest(PROMPT, KEY) != sha256(PROMPT.encode()).hexdigest()


def test_a_record_carries_no_prompt_length() -> None:
    with pytest.raises(ValueError):
        ModelCallRecord(**{**_record().model_dump(), "prompt_chars": 60})


async def test_the_sink_appends_one_canonical_line_per_record(tmp_path: Path) -> None:
    sink = JsonlAuditSink(tmp_path / "audit" / "model-calls.jsonl")
    first, second = _record(), _record(purpose="request_context", policy_id=None, rule_id=None)
    await sink.record(first)
    await sink.record(second)
    lines = (tmp_path / "audit" / "model-calls.jsonl").read_text().splitlines()
    assert len(lines) == 2
    parsed = json.loads(lines[0])
    assert parsed["id"] == first.id
    assert parsed["timestamp"].endswith("Z")
    assert list(parsed) == sorted(parsed)
    assert "prompt" not in parsed
    assert "prompt_chars" not in parsed


async def test_the_log_and_its_directory_are_readable_by_the_owner_only(tmp_path: Path) -> None:
    sink = JsonlAuditSink(tmp_path / "audit" / "model-calls.jsonl")
    await sink.record(_record())
    assert stat.S_IMODE((tmp_path / "audit").stat().st_mode) == 0o700
    assert stat.S_IMODE((tmp_path / "audit" / "model-calls.jsonl").stat().st_mode) == 0o600


async def test_a_line_round_trips_to_the_record(tmp_path: Path) -> None:
    sink = JsonlAuditSink(tmp_path / "model-calls.jsonl")
    record = _record()
    await sink.record(record)
    line = (tmp_path / "model-calls.jsonl").read_text().splitlines()[0]
    assert ModelCallRecord.model_validate_json(line) == record


async def test_an_unwritable_path_is_an_audit_unavailable_error(tmp_path: Path) -> None:
    blocker = tmp_path / "file"
    blocker.write_text("not a directory")
    sink = JsonlAuditSink(blocker / "model-calls.jsonl")
    with pytest.raises(AuditUnavailable):
        await sink.record(_record())
