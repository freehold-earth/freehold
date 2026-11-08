"""The outbound audit record: one line per model call, written before the call."""

from __future__ import annotations

import hmac
import json
import os
import stat
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from freehold_agent import Agent
from freehold_agent.audit import JsonlAuditSink, ModelCallRecord, prompt_digest
from freehold_agent.config import AgentConfig, LLMConfig
from freehold_agent.custody import Operator
from freehold_agent.errors import AuditUnavailable
from freehold_agent.models.backend import StructuredResponse
from freehold_agent.vault import derive_key
from tests.fakes import SEED_KEY, SEED_POLICY, SEED_ROOT_IDENTITY, FakeVault
from tests.test_agent import FakeBackend
from tests.test_api_unlock import _client as _vault_client
from tests.test_context import PASSWORD, USER, FakeStore

KEY = b"k" * 32
PROMPT = "Context:\n- birthDate: 1990-05-15\n\nQuestion: how old am I?\nAnswer:"


def _record(**overrides: object) -> ModelCallRecord:
    fields: dict[str, object] = {
        "purpose": "ask",
        "backend": "http",
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


# --- The record ---


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


def test_a_record_refuses_a_timestamp_without_a_timezone() -> None:
    """A naive time would be written under a Z it never had."""
    with pytest.raises(ValueError, match="timezone"):
        _record(timestamp=datetime(2026, 11, 8, 12, 0))


def test_a_record_names_the_backend_as_the_configuration_does() -> None:
    with pytest.raises(ValueError):
        _record(backend="openai")


def test_the_prompt_digest_is_keyed_so_the_log_alone_cannot_be_brute_forced() -> None:
    """The prompt is a known template around guessable fields; only the key's holder can verify."""
    assert prompt_digest(PROMPT, KEY) == hmac.new(KEY, PROMPT.encode(), sha256).hexdigest()
    assert prompt_digest(PROMPT, KEY) != prompt_digest(PROMPT, b"other key")
    assert prompt_digest(PROMPT, KEY) != sha256(PROMPT.encode()).hexdigest()


def test_a_record_carries_no_prompt_length() -> None:
    with pytest.raises(ValueError):
        ModelCallRecord(**{**_record().model_dump(), "prompt_chars": 60})


# --- The file ---


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


async def test_a_line_round_trips_to_the_record(tmp_path: Path) -> None:
    sink = JsonlAuditSink(tmp_path / "model-calls.jsonl")
    record = _record()
    await sink.record(record)
    line = (tmp_path / "model-calls.jsonl").read_text().splitlines()[0]
    assert ModelCallRecord.model_validate_json(line) == record


async def test_the_log_and_its_directory_are_readable_by_the_owner_only(tmp_path: Path) -> None:
    sink = JsonlAuditSink(tmp_path / "audit" / "model-calls.jsonl")
    await sink.record(_record())
    assert stat.S_IMODE((tmp_path / "audit").stat().st_mode) == 0o700
    assert stat.S_IMODE((tmp_path / "audit" / "model-calls.jsonl").stat().st_mode) == 0o600


async def test_an_existing_log_is_tightened_but_a_directory_the_sink_did_not_make_is_left(
    tmp_path: Path,
) -> None:
    """A restored file keeps no wider mode; a shared or working directory is not ours to change."""
    directory = tmp_path / "data"
    directory.mkdir(mode=0o755)
    log = directory / "model-calls.jsonl"
    log.write_text("")
    log.chmod(0o644)
    await JsonlAuditSink(log).record(_record())
    assert stat.S_IMODE(directory.stat().st_mode) == 0o755
    assert stat.S_IMODE(log.stat().st_mode) == 0o600


def test_the_keys_in_a_record_cannot_be_changed_either() -> None:
    record = _record()
    assert isinstance(record.context_keys, tuple)


async def test_a_symlink_at_the_log_path_is_not_followed(tmp_path: Path) -> None:
    target = tmp_path / "elsewhere.txt"
    target.write_text("")
    link = tmp_path / "model-calls.jsonl"
    os.symlink(target, link)
    with pytest.raises(AuditUnavailable):
        await JsonlAuditSink(link).record(_record())
    assert target.read_text() == ""


async def test_an_unwritable_path_is_an_audit_unavailable_error(tmp_path: Path) -> None:
    blocker = tmp_path / "file"
    blocker.write_text("not a directory")
    sink = JsonlAuditSink(blocker / "model-calls.jsonl")
    with pytest.raises(AuditUnavailable):
        await sink.record(_record())


# --- The agent writes a record before every model call ---


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
    """A sink whose file can never be written."""

    async def record(self, record: ModelCallRecord) -> None:
        raise AuditUnavailable("the audit log cannot be written")


def _vault() -> FakeVault:
    return FakeVault(
        {
            "root-identity": SEED_ROOT_IDENTITY,
            SEED_KEY: SEED_POLICY,
            "personal-context": {"birthDate": "1990-05-15"},
        }
    )


def _agent(log: Path | None, backend: FakeBackend, vault: FakeVault | None = None) -> Agent:
    """An agent configured for the http backend, with ``backend`` standing in for it."""
    config = AgentConfig(
        llm=LLMConfig(backend="http", url="https://llm.test/v1", model="qwen"),
        audit_log=None if log is None else str(log),
    )
    agent = Agent(config, context_client=vault or _vault())
    agent._openai_backend = backend  # type: ignore[assignment]
    agent._initialized = True
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
    assert record.backend == "http"
    assert record.model == "qwen"
    assert record.custody is Operator.OWNED_HARDWARE
    assert record.policy_id == SEED_POLICY["id"]
    assert record.rule_id == "rule-age"
    assert record.context_scope == "personal/age"
    assert record.context_keys == ("personal-context",)
    assert record.prompt_hmac == prompt_digest(backend.prompts[0], await vault.audit_key())


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


class CountingVault(FakeVault):
    """Counts the audit key requests; a deployment with the log off should make none."""

    def __init__(self, entries: dict[str, object] | None = None) -> None:
        super().__init__(entries)
        self.key_requests = 0

    async def audit_key(self) -> bytes:
        self.key_requests += 1
        return await super().audit_key()


async def test_with_the_log_off_no_key_is_derived() -> None:
    vault = CountingVault(
        {
            "root-identity": SEED_ROOT_IDENTITY,
            SEED_KEY: SEED_POLICY,
            "personal-context": {"birthDate": "1990-05-15"},
        }
    )
    await _agent(None, FakeBackend(), vault).ask(
        "how old am I?", "age-verification", "personal/age"
    )
    assert vault.key_requests == 0


async def test_the_record_names_the_model_a_tier_resolves_to(tmp_path: Path) -> None:
    from freehold_agent.config import resolve_model_for_tier

    log = tmp_path / "model-calls.jsonl"
    config = AgentConfig(
        llm=LLMConfig(backend="http", url="https://llm.test/v1", tier="small"), audit_log=str(log)
    )
    agent = Agent(config, context_client=_vault())
    agent._openai_backend = FakeBackend()  # type: ignore[assignment]
    agent._initialized = True
    await agent.ask("how old am I?", "age-verification", "personal/age")
    assert _lines(log)[0].model == resolve_model_for_tier("small")


class ReunlockingVault(FakeVault):
    """The same holder unlocks again while the ask is in flight."""

    async def audit_key(self) -> bytes:
        self.session += 1
        return await super().audit_key()


async def test_a_re_unlock_by_the_same_holder_during_the_ask_is_refused(tmp_path: Path) -> None:
    """One ask spans one vault session, even when the holder's name did not change."""
    from freehold_agent.errors import ContextUnavailable

    vault = ReunlockingVault(
        {
            "root-identity": SEED_ROOT_IDENTITY,
            SEED_KEY: SEED_POLICY,
            "personal-context": {"birthDate": "1990-05-15"},
        }
    )
    backend = FakeBackend()
    with pytest.raises(ContextUnavailable, match="changed"):
        await _agent(tmp_path / "log.jsonl", backend, vault).ask(
            "how old am I?", "age-verification", "personal/age"
        )
    assert backend.prompts == []


async def test_a_record_that_cannot_be_written_means_no_model_call() -> None:
    backend = FakeBackend()
    agent = Agent(
        AgentConfig(llm=LLMConfig(backend="http", url="https://llm.test/v1")),
        context_client=_vault(),
        audit=FailingSink(),
    )
    agent._openai_backend = backend  # type: ignore[assignment]
    agent._initialized = True
    with pytest.raises(AuditUnavailable):
        await agent.ask("how old am I?", "age-verification", "personal/age")
    assert backend.prompts == []


async def test_a_proposed_request_context_is_recorded_without_holder_data(tmp_path: Path) -> None:
    log, backend = tmp_path / "model-calls.jsonl", FakeStructuredBackend()
    agent = _agent(log, backend)
    await agent.propose_request_context("a bar checks age")
    [record] = _lines(log)
    assert record.purpose == "request_context"
    assert record.backend == "http"
    assert (record.policy_id, record.rule_id, record.context_scope, record.context_keys) == (
        None,
        None,
        None,
        (),
    )
    assert record.prompt_hmac == prompt_digest("a bar checks age", await _vault().audit_key())


async def test_the_default_log_is_a_file_in_the_working_directory(tmp_path: Path) -> None:
    """The conftest fixture makes the test's directory the working one."""
    agent = Agent(
        AgentConfig(llm=LLMConfig(backend="http", url="https://llm.test/v1")),
        context_client=_vault(),
    )
    agent._openai_backend = FakeBackend()  # type: ignore[assignment]
    agent._initialized = True
    await agent.ask("how old am I?", "age-verification", "personal/age")
    assert (tmp_path / "freehold-audit.jsonl").exists()


# --- The holder's audit key costs a password guess what the vault itself costs ---


async def test_the_audit_key_is_the_vaults_slow_derivation_with_a_per_holder_salt() -> None:
    """A fast HMAC of the password would let a copy of the log test password guesses cheaply."""
    client = _vault_client(FakeStore({"root-identity": SEED_ROOT_IDENTITY}))
    assert await client.audit_key() is None
    await client.unlock(USER, PASSWORD)
    salt = sha256(b"freehold-audit:" + USER.encode()).digest()
    assert await client.audit_key() == derive_key(PASSWORD, salt)
    assert await client.audit_key() == await client.audit_key()
    client.lock()
    assert await client.audit_key() is None


async def test_the_audit_key_is_derived_on_first_use_not_at_unlock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A deployment that keeps no record never pays for a key nobody reads."""
    import freehold_agent.context as context_module

    calls: list[str] = []
    real = context_module.derive_key

    def counting(password: str, salt: bytes) -> bytes:
        calls.append(password)
        return real(password, salt)

    monkeypatch.setattr(context_module, "derive_key", counting)
    client = _vault_client(FakeStore({"root-identity": SEED_ROOT_IDENTITY}))
    await client.unlock(USER, PASSWORD)
    assert calls == []
    await client.audit_key()
    await client.audit_key()
    assert calls == [PASSWORD]


async def test_the_session_changes_on_every_lock_and_unlock() -> None:
    client = _vault_client(FakeStore({"root-identity": SEED_ROOT_IDENTITY}))
    first = client.session
    await client.unlock(USER, PASSWORD)
    second = client.session
    client.lock()
    third = client.session
    await client.unlock(USER, PASSWORD)
    assert first != second != third != client.session


async def test_a_lock_during_key_derivation_leaves_no_key(monkeypatch: pytest.MonkeyPatch) -> None:
    """A key derived from a password the client has since forgotten is never kept."""
    import freehold_agent.context as context_module

    client = _vault_client(FakeStore({"root-identity": SEED_ROOT_IDENTITY}))
    await client.unlock(USER, PASSWORD)
    real = context_module.derive_key

    def lock_midway(password: str, salt: bytes) -> bytes:
        client.lock()
        return real(password, salt)

    monkeypatch.setattr(context_module, "derive_key", lock_midway)
    assert await client.audit_key() is None
    assert client.user_id is None


# --- CodeRabbit's round ---


async def test_a_fifo_at_the_log_path_is_refused(tmp_path: Path) -> None:
    """Only a regular file is a record; a pipe would be read once and gone, or block forever."""
    fifo = tmp_path / "model-calls.jsonl"
    os.mkfifo(fifo)
    reader = os.open(fifo, os.O_RDONLY | os.O_NONBLOCK)  # so the open under test cannot block
    try:
        with pytest.raises(AuditUnavailable):
            await JsonlAuditSink(fifo).record(_record())
    finally:
        os.close(reader)


async def test_a_partial_tail_left_by_a_crash_does_not_corrupt_the_next_line(
    tmp_path: Path,
) -> None:
    log = tmp_path / "model-calls.jsonl"
    log.write_text('{"id": "half')
    record = _record()
    await JsonlAuditSink(log).record(record)
    lines = log.read_text().splitlines()
    assert lines[0] == '{"id": "half'
    assert ModelCallRecord.model_validate_json(lines[1]) == record


def test_an_empty_model_name_resolves_like_an_absent_one() -> None:
    from freehold_agent.config import resolve_model_for_tier

    config = LLMConfig(backend="http", url="https://llm.test/v1", model="", tier="small")
    assert config.resolved_model == resolve_model_for_tier("small")


async def test_a_session_change_while_the_record_is_written_stops_the_call(tmp_path: Path) -> None:
    """The data was read under one session; a lock or unlock before the call stops it."""
    from freehold_agent.errors import ContextUnavailable

    vault = _vault()

    class BumpingSink:
        async def record(self, record: ModelCallRecord) -> None:
            vault.session += 1

    backend = FakeBackend()
    agent = Agent(
        AgentConfig(llm=LLMConfig(backend="http", url="https://llm.test/v1")),
        context_client=vault,
        audit=BumpingSink(),
    )
    agent._openai_backend = backend  # type: ignore[assignment]
    agent._initialized = True
    with pytest.raises(ContextUnavailable, match="changed"):
        await agent.ask("how old am I?", "age-verification", "personal/age")
    assert backend.prompts == []


async def test_with_the_log_off_nothing_claims_the_vault_is_locked(
    caplog: pytest.LogCaptureFixture,
) -> None:
    import logging

    with caplog.at_level(logging.INFO, logger="freehold_agent.agent"):
        await _agent(None, FakeBackend()).ask("how old am I?", "age-verification", "personal/age")
    assert "locked" not in caplog.text


async def test_another_holders_unlock_during_derivation_does_not_cache_the_first_holders_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Same password, different holder: the salt differs, so the key in flight is not theirs."""
    import freehold_agent.context as context_module

    store = FakeStore({"root-identity": SEED_ROOT_IDENTITY})
    client = _vault_client(store)
    await client.unlock(USER, PASSWORD)
    real = context_module.derive_key
    switched: list[str] = []

    def switch_holder_midway(password: str, salt: bytes) -> bytes:
        if not switched:
            switched.append("other")
            # The other holder has no entries to check against, so any password unlocks.
            import asyncio

            asyncio.run_coroutine_threadsafe(client.unlock("other-holder", PASSWORD), loop).result()
        return real(password, salt)

    import asyncio

    loop = asyncio.get_running_loop()
    monkeypatch.setattr(context_module, "derive_key", switch_holder_midway)
    first = await client.audit_key()
    assert client.user_id == "other-holder"
    expected = real(PASSWORD, sha256(b"freehold-audit:" + b"other-holder").digest())
    assert first in (None, expected)
    assert await client.audit_key() == expected
