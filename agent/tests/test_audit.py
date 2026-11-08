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


# --- The agent writes a record before every model call ---

from typing import Any  # noqa: E402

from freehold_agent import Agent  # noqa: E402
from freehold_agent.config import AgentConfig, LLMConfig  # noqa: E402
from freehold_agent.models.backend import StructuredResponse  # noqa: E402
from tests.fakes import SEED_KEY, SEED_POLICY, SEED_ROOT_IDENTITY, FakeVault  # noqa: E402
from tests.test_agent import FakeBackend  # noqa: E402


class FakeStructuredBackend(FakeBackend):
    """Answers a structured call with an empty request context."""

    async def generate_structured(
        self, prompt: str, schema: dict[str, Any], **_: object
    ) -> StructuredResponse:
        self.prompts.append(prompt)
        return StructuredResponse(
            data={}, raw_text="{}", model="fake", tokens_used=1, finish_reason="stop"
        )


class FailingSink:
    async def record(self, record: ModelCallRecord) -> None:
        raise AuditUnavailable("disk full")


def _vault() -> FakeVault:
    return FakeVault(
        {
            "root-identity": SEED_ROOT_IDENTITY,
            SEED_KEY: SEED_POLICY,
            "personal-context": {"birthDate": "1990-05-15"},
        }
    )


def _agent(log: Path | None, backend: FakeBackend, vault: FakeVault | None = None) -> Agent:
    config = AgentConfig(
        llm=LLMConfig(backend="none", model="qwen"), audit_log=None if log is None else str(log)
    )
    agent = Agent(config, context_client=vault or _vault())
    agent._openai_backend = backend  # type: ignore[assignment]
    return agent


def _lines(log: Path) -> list[ModelCallRecord]:
    return [ModelCallRecord.model_validate_json(line) for line in log.read_text().splitlines()]


async def test_an_ask_is_recorded_before_the_model_sees_it(tmp_path: Path) -> None:
    log, backend, vault = tmp_path / "model-calls.jsonl", FakeBackend(), _vault()
    response = await _agent(log, backend, vault).ask(
        "how old am I?", "age-verification", "personal/age"
    )
    [record] = _lines(log)
    assert response.audit_id == record.id
    assert record.purpose == "ask"
    assert record.backend == "openai"
    assert record.model == "qwen"
    assert record.custody is Operator.OWNED_HARDWARE
    assert record.policy_id == SEED_POLICY["id"]
    assert record.rule_id == "rule-age"
    assert record.context_scope == "personal/age"
    assert record.context_keys == ["personal-context"]
    assert record.prompt_hmac == prompt_digest(backend.prompts[0], vault.audit_key())


async def test_two_asks_are_two_lines(tmp_path: Path) -> None:
    log = tmp_path / "model-calls.jsonl"
    agent = _agent(log, FakeBackend())
    await agent.ask("how old am I?", "age-verification", "personal/age")
    await agent.ask("and again?", "age-verification", "personal/age")
    assert len(_lines(log)) == 2


async def test_with_the_log_off_the_ask_is_answered_and_nothing_is_written(tmp_path: Path) -> None:
    backend = FakeBackend()
    response = await _agent(None, backend).ask("how old am I?", "age-verification", "personal/age")
    assert response.content == "you are 36"
    assert response.audit_id is None
    assert list(tmp_path.iterdir()) == []


async def test_a_record_that_cannot_be_written_means_no_model_call() -> None:
    backend = FakeBackend()
    agent = Agent(
        AgentConfig(llm=LLMConfig(backend="none")), context_client=_vault(), audit=FailingSink()
    )
    agent._openai_backend = backend  # type: ignore[assignment]
    with pytest.raises(AuditUnavailable):
        await agent.ask("how old am I?", "age-verification", "personal/age")
    assert backend.prompts == []


async def test_a_proposed_request_context_is_recorded_without_holder_data(tmp_path: Path) -> None:
    log, backend = tmp_path / "model-calls.jsonl", FakeStructuredBackend()
    config = AgentConfig(
        llm=LLMConfig(backend="http", url="https://llm.test/v1"), audit_log=str(log)
    )
    agent = Agent(config, context_client=_vault())
    agent._openai_backend = backend  # type: ignore[assignment]
    agent._initialized = True
    await agent.propose_request_context("a bar checks age")
    [record] = _lines(log)
    assert record.purpose == "request_context"
    assert record.backend == "openai"
    assert (record.policy_id, record.rule_id, record.context_scope, record.context_keys) == (
        None,
        None,
        None,
        [],
    )
    assert record.prompt_hmac == prompt_digest("a bar checks age", _vault().audit_key())


async def test_the_default_log_is_a_file_beside_the_agent(tmp_path: Path) -> None:
    """The conftest fixture makes the test's directory the working one."""
    agent = Agent(AgentConfig(llm=LLMConfig(backend="none")), context_client=_vault())
    agent._openai_backend = FakeBackend()  # type: ignore[assignment]
    await agent.ask("how old am I?", "age-verification", "personal/age")
    assert (tmp_path / "freehold-audit.jsonl").exists()


# --- The holder's audit key costs a password guess what the vault itself costs ---

from hashlib import sha256 as _sha256  # noqa: E402

from freehold_agent.vault import derive_key  # noqa: E402
from tests.test_api_unlock import _client as _vault_client  # noqa: E402
from tests.test_context import PASSWORD, USER, FakeStore  # noqa: E402


async def test_the_audit_key_is_the_vaults_slow_derivation_with_a_per_holder_salt() -> None:
    """A fast HMAC of the password would let a copy of the log test password guesses cheaply."""
    client = _vault_client(FakeStore({"root-identity": SEED_ROOT_IDENTITY}))
    assert client.audit_key() is None
    await client.unlock(USER, PASSWORD)
    salt = _sha256(b"freehold-audit:" + USER.encode()).digest()
    assert client.audit_key() == derive_key(PASSWORD, salt)
    assert client.audit_key() == client.audit_key()
    client.lock()
    assert client.audit_key() is None
