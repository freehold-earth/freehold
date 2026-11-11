"""The outbound audit: what left the agent for a model, where it went, and under which rule.

One :class:`ModelCallRecord` is written for every model call, before the
call is made, so that there is never an answer without a record. The record
holds what is needed to hold a deployment to account afterwards and nothing
that would make it a second copy of the data: the entry keys sent, a keyed
commitment to the request, never the prompt or a field value. The commitment
is keyed because the prompt is a known template around a few guessable
fields, so a bare hash of it could be brute-forced from the log alone; and
the key is the request's own, so the holder can open one request to a third
party without opening any other.

A :class:`ReceiptRecord` is the line beside it: what became of the terms
receipt an operator owed for the call, the receipt itself when it was
accepted and the reason when it was not.
"""

from __future__ import annotations

import asyncio
import os
import stat
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal, Protocol, Self

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from freehold_agent.authorization import canonical_json
from freehold_agent.config import Backend
from freehold_agent.custody import Operator
from freehold_agent.errors import AuditUnavailable, ReceiptInvalid, ReceiptRefusal
from freehold_agent.receipt import AwaitedReceipt, Receipt

Purpose = Literal["ask", "request_context"]

ReceiptStatus = Literal["not_owed", "unreceipted", "awaited"]
"""Where a call stands on a terms receipt when it is made. ``not_owed``: the
call goes to the holder's own machine, or carries nothing under a rule, so no
operator has terms to sign for. ``unreceipted``: an operator serves it under
a rule, over a transport that carries no receipt, so the operator signs for
nothing. ``awaited``: a receipt is owed with the response, and a
:class:`ReceiptRecord` under the same operator and nonce says what came."""


def _utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise ValueError("the timestamp needs a timezone")
    return value


def _line(record: BaseModel, timestamp: datetime) -> str:
    """A record as one line of canonical JSON, its timestamp in UTC with ``Z``."""
    data = record.model_dump(mode="json")
    data["timestamp"] = timestamp.astimezone(UTC).isoformat().replace("+00:00", "Z")
    return canonical_json(data)


class ModelCallRecord(BaseModel):
    """One outbound model call, as recorded before it is made.

    ``context_keys`` are the vault keys whose entries went into the prompt.
    ``nonce`` and ``commitment`` are the label the request is sent under:
    the commitment identifies, under a key derived for this one request from
    the holder's key, the operator and the nonce, the text the agent sent for
    an ask (the whole prompt) or was given for a request context (the
    description; the framing added around it is the agent's own text). Both
    are None when no key was held. ``operator_did`` is the operator the
    configuration names for the model server, if it names one.
    ``policy_id``, ``rule_id`` and ``context_scope`` are set for an ask and
    None for a call that carries none of the holder's data.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    kind: Literal["model_call"] = "model_call"
    id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    timestamp: datetime = Field(default_factory=lambda: datetime.now(UTC))
    purpose: Purpose
    # The backend as the configuration names it, so a line reconciles with the deployment.
    backend: Backend
    model: str | None = None
    custody: Operator
    policy_id: str | None = None
    rule_id: str | None = None
    context_scope: str | None = None
    context_keys: tuple[str, ...] = ()
    operator_did: str | None = None
    nonce: str | None = Field(default=None, pattern=r"^[0-9a-f]{32}$")
    commitment: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    receipt: ReceiptStatus = "not_owed"

    _aware = field_validator("timestamp")(_utc)

    @model_validator(mode="after")
    def _a_label_is_whole(self) -> Self:
        if (self.nonce is None) != (self.commitment is None):
            raise ValueError("a nonce and a commitment are recorded together or not at all")
        return self

    def line(self) -> str:
        """The record as one line of canonical JSON, the timestamp in UTC with ``Z``."""
        return _line(self, self.timestamp)


class ReceiptRecord(BaseModel):
    """What became of the terms receipt owed for one model call.

    ``audit_id``, ``operator_did`` and ``nonce`` are the call's own, so the
    two lines read as one. An accepted receipt is kept whole, signature
    included: it is the operator's commitment, and a dispute needs it as
    signed. A refused one is not kept, only which check it failed and how.
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    kind: Literal["receipt"] = "receipt"
    id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    timestamp: datetime = Field(default_factory=lambda: datetime.now(UTC))
    audit_id: str
    operator_did: str
    nonce: str = Field(pattern=r"^[0-9a-f]{32}$")
    outcome: Literal["accepted", "refused"]
    receipt: Receipt | None = None
    refusal: ReceiptRefusal | None = None
    detail: str | None = None

    _aware = field_validator("timestamp")(_utc)

    @model_validator(mode="after")
    def _one_outcome(self) -> Self:
        accepted = self.outcome == "accepted"
        if accepted != (self.receipt is not None) or accepted == (self.refusal is not None):
            raise ValueError("an accepted record keeps the receipt; a refused one its refusal")
        return self

    def line(self) -> str:
        """The record as one line of canonical JSON, the timestamp in UTC with ``Z``."""
        return _line(self, self.timestamp)


AuditRecord = ModelCallRecord | ReceiptRecord


class AuditSink(Protocol):
    """Keeps a record of the outbound audit; raises if it cannot."""

    async def record(self, record: AuditRecord) -> None: ...


async def settle_receipt(
    sink: AuditSink,
    call: ModelCallRecord,
    awaited: AwaitedReceipt,
    presented: object,
    *,
    received_at: datetime,
) -> Receipt:
    """Check what came back for a call that awaited a receipt, and record the outcome.

    The receipt is returned only once its record is kept, so nothing is
    treated as served under terms without the operator's signature on file.

    Args:
        sink: Where the call's own record was kept.
        call: The record of the call, written before it was made.
        awaited: The receipt owed for the call.
        presented: The receipt object the response carried, or None.
        received_at: When the response arrived.

    Raises:
        ReceiptInvalid: What was presented is not the receipt owed; the
            refusal is recorded before this is raised.
        AuditUnavailable: The outcome could not be recorded.
        ValueError: The call's record carries no operator or nonce to key
            the outcome by.
    """
    if call.operator_did is None or call.nonce is None:
        raise ValueError("the call's record names no operator and nonce to keep a receipt under")
    try:
        receipt = awaited.accept(presented, received_at=received_at)
    except ReceiptInvalid as error:
        await sink.record(
            ReceiptRecord(
                audit_id=call.id,
                operator_did=call.operator_did,
                nonce=call.nonce,
                outcome="refused",
                refusal=error.refusal,
                detail=error.detail,
            )
        )
        raise
    await sink.record(
        ReceiptRecord(
            audit_id=call.id,
            operator_did=call.operator_did,
            nonce=call.nonce,
            outcome="accepted",
            receipt=receipt,
        )
    )
    return receipt


class JsonlAuditSink:
    """Appends each record as one line to a local file, creating the file's directory.

    The file is kept readable by its owner only, whether this process made
    it or found it; a directory is made owner-only when this sink creates
    it, and left as found otherwise, since a working or shared directory is
    not the sink's to change. Only a regular file is accepted: a symbolic
    link at the path, a pipe or a device is refused, and the directories
    above it are taken as trusted. Each line is written whole to an
    append-only descriptor and synced to disk before the record is reported
    kept, so a record never outlives its disclosure the other way round; a
    partial line left by an earlier crash is closed off before the next.
    Writes are serialised within this process; two processes appending to
    one file are not coordinated. A path that cannot be written is
    :class:`AuditUnavailable`, so the caller can refuse the call it was
    about to make.
    """

    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock = asyncio.Lock()

    async def record(self, record: AuditRecord) -> None:
        line = record.line() + "\n"
        async with self._lock:
            try:
                await asyncio.to_thread(self._append, line)
            except OSError as exc:
                raise AuditUnavailable(
                    f"the audit log at {self._path} cannot be written: {exc.strerror or exc}"
                ) from exc

    def _append(self, line: str) -> None:
        if not self._path.parent.exists():
            self._path.parent.mkdir(parents=True, mode=0o700)
            os.chmod(self._path.parent, 0o700)
            _sync_directory(self._path.parent)
        flags = os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK
        fd = os.open(self._path, flags, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode):
                raise AuditUnavailable(f"the audit log at {self._path} is not a regular file")
            os.fchmod(fd, 0o600)
            data = line.encode("utf-8")
            if info.st_size > 0 and os.pread(fd, 1, info.st_size - 1) != b"\n":
                data = b"\n" + data
            _write_all(fd, data)
            os.fsync(fd)
        finally:
            os.close(fd)


def _write_all(fd: int, data: bytes) -> None:
    """Write every byte, or raise; a short write is continued, not accepted."""
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        view = view[written:]


def _sync_directory(path: Path) -> None:
    """Make a new directory entry durable before anything is written under it."""
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
