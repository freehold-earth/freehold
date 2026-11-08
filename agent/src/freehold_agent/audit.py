"""The outbound audit: what left the agent for a model, where it went, and under which rule.

One :class:`ModelCallRecord` is written for every model call, before the
call is made, so that there is never an answer without a record. The record
holds what is needed to hold a deployment to account afterwards and nothing
that would make it a second copy of the data: the entry keys sent, a hash
of the prompt, never the prompt or a field value.
"""

from __future__ import annotations

import asyncio
import hashlib
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from freehold_agent.authorization import canonical_json
from freehold_agent.custody import Operator
from freehold_agent.errors import AuditUnavailable

Purpose = Literal["ask", "request_context"]
BackendKind = Literal["local", "ollama", "openai"]


def prompt_digest(prompt: str) -> str:
    """SHA-256 of the exact prompt text, as 64 lowercase hex characters."""
    return hashlib.sha256(prompt.encode()).hexdigest()


class ModelCallRecord(BaseModel):
    """One outbound model call, as recorded before it is made.

    ``context_keys`` are the vault keys whose entries went into the prompt;
    ``prompt_sha256`` identifies the prompt without reproducing it.
    ``policy_id``, ``rule_id`` and ``context_scope`` are set for an ask and
    None for a call that carries none of the holder's data.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    timestamp: datetime = Field(default_factory=lambda: datetime.now(UTC))
    purpose: Purpose
    backend: BackendKind
    model: str | None = None
    custody: Operator
    policy_id: str | None = None
    rule_id: str | None = None
    context_scope: str | None = None
    context_keys: list[str] = Field(default_factory=list)
    prompt_sha256: str = Field(pattern=r"^[0-9a-f]{64}$")
    prompt_chars: int = Field(ge=0)

    def line(self) -> str:
        """The record as one line of canonical JSON, the timestamp in UTC with ``Z``."""
        data = self.model_dump(mode="json")
        data["timestamp"] = self.timestamp.astimezone(UTC).isoformat().replace("+00:00", "Z")
        return canonical_json(data)


class JsonlAuditSink:
    """Appends each record as one line to a local file, creating the file's directory.

    Writes are serialised within the process so lines never interleave. A
    path that cannot be written is :class:`AuditUnavailable`, so the caller
    can refuse the call it was about to make.
    """

    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock = asyncio.Lock()

    async def record(self, record: ModelCallRecord) -> None:
        line = record.line() + "\n"
        async with self._lock:
            try:
                await asyncio.to_thread(self._append, line)
            except OSError as exc:
                raise AuditUnavailable(
                    f"the audit log at {self._path} cannot be written: {exc.strerror or exc}"
                ) from exc

    def _append(self, line: str) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        with self._path.open("a", encoding="utf-8") as handle:
            handle.write(line)
