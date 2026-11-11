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

A receipt record is the line beside it: what became of the terms receipt an
operator owed for the call, the receipt itself when it was accepted
(:class:`ReceiptAccepted`) and the reason when it was not
(:class:`ReceiptRefused`). :func:`read_record` reads any line back.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import stat
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Literal, Protocol, Self

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    TypeAdapter,
    field_validator,
    model_validator,
)

from freehold_agent.authorization import canonical_json
from freehold_agent.config import Backend
from freehold_agent.custody import Operator
from freehold_agent.errors import AuditUnavailable, ReceiptInvalid, ReceiptRefusal
from freehold_agent.receipt import AwaitedReceipt, Receipt

logger = logging.getLogger(__name__)

Purpose = Literal["ask", "request_context"]

ReceiptStatus = Literal["not_owed", "unreceipted", "awaited"]
"""Where a call stands on a terms receipt when it is made. ``not_owed``: the
call goes to the holder's own machine, or carries nothing under a rule, so no
operator has terms to sign for. ``unreceipted``: an operator serves it under
a rule, over a transport that carries no receipt, so the operator signs for
nothing. ``awaited``: a receipt is owed with the response, and a receipt
record under the same operator and nonce says what came. An awaited call
with no such record beside it was not served under terms, whatever the
reason: the request failed or was abandoned, the process stopped, or the
outcome could not be written."""


class _Line(BaseModel):
    """What every line of the log has: an id, a time, and one canonical spelling."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    id: str = Field(default_factory=lambda: uuid.uuid4().hex)
    timestamp: datetime = Field(default_factory=lambda: datetime.now(UTC))

    @field_validator("timestamp")
    @classmethod
    def _aware(cls, value: datetime) -> datetime:
        """A naive time would be written under a Z it never had."""
        if value.utcoffset() is None:
            raise ValueError("the timestamp needs a timezone")
        return value

    def line(self) -> str:
        """The record as one line of canonical JSON, the timestamp in UTC with ``Z``."""
        return self._spell()

    def _spell(self, *, without: frozenset[str] = frozenset()) -> str:
        data = self.model_dump(mode="json", exclude=set(without))
        data["timestamp"] = self.timestamp.astimezone(UTC).isoformat().replace("+00:00", "Z")
        return canonical_json(data)


class ModelCallRecord(_Line):
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

    ``prompt_hmac`` is read, never written: a line from before requests were
    labelled carries a digest of its prompt under the holder's audit key
    itself, and no nonce or commitment.
    """

    kind: Literal["model_call"] = "model_call"
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
    receipt_status: ReceiptStatus = "not_owed"
    prompt_hmac: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")

    @model_validator(mode="after")
    def _a_label_is_whole_and_a_receipt_has_someone_to_sign_it(self) -> Self:
        """Refuse a record the receipt beside it could never be read with."""
        if (self.nonce is None) != (self.commitment is None):
            raise ValueError("a nonce and a commitment are recorded together or not at all")
        if self.prompt_hmac is not None and self.commitment is not None:
            raise ValueError("a line carries a commitment or the older prompt_hmac, not both")
        if self.receipt_status != "not_owed" and not self.custody.has_operator:
            raise ValueError(
                f"no receipt is owed at {self.custody.value}, the holder's own machine"
            )
        if self.receipt_status == "awaited" and (self.operator_did is None or self.nonce is None):
            raise ValueError("an awaited receipt needs the operator and the nonce it is kept under")
        return self

    def line(self) -> str:
        """The record as one line; the read-only ``prompt_hmac`` is spelled only where present."""
        return self._spell(without=frozenset() if self.prompt_hmac else frozenset({"prompt_hmac"}))


class _ReceiptLine(_Line):
    """What became of the terms receipt owed for one model call.

    ``audit_id``, ``operator_did`` and ``nonce`` are the call's own, so the
    two lines read as one.
    """

    kind: Literal["receipt"] = "receipt"
    audit_id: str
    operator_did: str
    nonce: str = Field(pattern=r"^[0-9a-f]{32}$")


class ReceiptAccepted(_ReceiptLine):
    """The receipt owed for a call, accepted and kept whole, signature included.

    It is the operator's commitment, and a dispute needs it as signed.
    """

    outcome: Literal["accepted"] = "accepted"
    receipt: Receipt


class ReceiptRefused(_ReceiptLine):
    """What came back for a call was not the receipt owed: which check failed, and how.

    The receipt presented, if any, is not kept.
    """

    outcome: Literal["refused"] = "refused"
    refusal: ReceiptRefusal
    detail: str


ReceiptRecord = Annotated[ReceiptAccepted | ReceiptRefused, Field(discriminator="outcome")]
AuditRecord = Annotated[ModelCallRecord | ReceiptRecord, Field(discriminator="kind")]

_RECORD: TypeAdapter[ModelCallRecord | ReceiptAccepted | ReceiptRefused] = TypeAdapter(AuditRecord)


def read_record(line: str) -> ModelCallRecord | ReceiptAccepted | ReceiptRefused:
    """Read one line of the log back as the record it was written from.

    A line from before lines said their kind is a model call.

    Raises:
        ValueError: The line is not a record of the log.
    """
    data = json.loads(line)
    if not isinstance(data, dict):
        raise ValueError("a line of the audit log is a JSON object")
    data.setdefault("kind", "model_call")
    return _RECORD.validate_python(data)


class AuditSink(Protocol):
    """Keeps a record of the outbound audit; raises if it cannot."""

    async def record(self, record: ModelCallRecord | ReceiptAccepted | ReceiptRefused) -> None:
        """Keep the record durably, or raise :class:`AuditUnavailable`."""
        ...


def _require_awaited(call: ModelCallRecord, awaited: AwaitedReceipt) -> None:
    """Refuse a record that is not of the awaited call ``awaited`` was made for."""
    label = awaited.label
    if call.receipt_status != "awaited":
        raise ValueError("the call's record is not of a call that awaits a receipt")
    if (call.operator_did, call.nonce, call.commitment, call.timestamp) != (
        label.operator_did,
        label.nonce.hex(),
        label.commitment.hex(),
        awaited.sent_at,
    ):
        raise ValueError("the call's record is not of the request the receipt is awaited for")


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
    This is the one chance: the nonce is spent by what is presented here, so
    if the outcome cannot be recorded the call stays an awaited one with no
    receipt beside it, which reads as not served under terms. Once the
    check has been made its outcome is written even if the caller is
    cancelled meanwhile: the cancellation waits for the write to end.

    Args:
        sink: Where the call's own record was kept.
        call: The record of the call, written before it was made.
        awaited: The receipt owed for the call, made when the call's record
            was: its label and time of sending are the record's own.
        presented: The receipt object the response carried, or None.
        received_at: When the response arrived.

    Returns:
        The accepted receipt, as kept.

    Raises:
        ReceiptInvalid: What was presented is not the receipt owed; the
            refusal is recorded before this is raised.
        AuditUnavailable: The outcome could not be recorded.
        ValueError: The call's record is not of a call that awaits a receipt,
            or not of the request ``awaited`` was made for. Nothing is
            presented or spent.
    """
    _require_awaited(call, awaited)
    label = awaited.label
    key = (call.id, label.operator_did, label.nonce.hex())
    try:
        receipt = awaited.accept(presented, received_at=received_at)
    except ReceiptInvalid as error:
        await _keep_through_cancellation(sink, _refused(key, error))
        raise
    await _keep_through_cancellation(
        sink, ReceiptAccepted(audit_id=key[0], operator_did=key[1], nonce=key[2], receipt=receipt)
    )
    return receipt


async def _keep_through_cancellation(
    sink: AuditSink, record: ReceiptAccepted | ReceiptRefused
) -> None:
    """Keep the record, finishing the write before a cancellation of the caller is honored.

    A cancelled caller still waits for the write, so its failure is seen
    here and never left on a task nobody awaits; the cancellation is
    raised once the write has ended, in success or in failure.
    """
    write = asyncio.ensure_future(sink.record(record))
    try:
        await asyncio.shield(write)
    except asyncio.CancelledError:
        if not write.done():
            await asyncio.wait([write])
        if not write.cancelled() and write.exception() is not None:
            logger.error("a receipt's outcome could not be recorded: %s", write.exception())
        raise


def _refused(key: tuple[str, str, str], error: ReceiptInvalid) -> ReceiptRefused:
    """The refusal line for the call ``key`` names."""
    return ReceiptRefused(
        audit_id=key[0],
        operator_did=key[1],
        nonce=key[2],
        refusal=error.refusal,
        detail=error.detail,
    )


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

    async def record(self, record: ModelCallRecord | ReceiptAccepted | ReceiptRefused) -> None:
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
