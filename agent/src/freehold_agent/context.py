"""Client for the user's context store.

The store (``context-store/src/server.ts``) is a zero-knowledge blob server:
it lists, returns and accepts entries keyed per user, each an opaque
``encrypted_data`` string, and knows nothing of what is inside. Everything
this client offers beyond that, reading entries as data, scoping them,
searching and ranking them, happens here after decryption, so the store's
API surface never has to grow and plaintext never leaves this process.

Reading needs the vault secret. The user's apps encrypt with a password the
user types and never send anywhere, so the agent holds no key until it is
told one: :meth:`ContextClient.unlock` takes the user id and password, checks
them against a stored entry, and keeps them in memory until :meth:`lock` or
:meth:`disconnect`. The password itself is kept because the format salts
every entry separately, so there is no single derived key to hold instead.

Scopes are paths such as ``personal/age``. Their first segment names a
domain, and an entry belongs to a domain when its key is the domain or
starts with the domain followed by ``-`` or ``/`` (``personal-context``
belongs to ``personal``; ``personality`` does not). The segments after the
first are policy language and do not narrow the entries read. Every read
names a scope: with none, or an empty one, nothing is read, so a caller
that forgets the scope gets no data rather than all of it.

Search is lexical: each top-level field of each entry in scope is one item,
ranked by the share of the query's terms found in the field's name or
value. An empty query lists the scope. Semantic ranking is a later step.

An entry the held secret does not open (written under another password, or
not in the vault format) is skipped with a warning rather than failing the
whole read: the secret was checked at unlock, and one stray entry should not
block every approval in its domain.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass
from urllib.parse import quote, unquote

import httpx2

from freehold_agent.config import ContextConfig
from freehold_agent.errors import ContextKeyInvalid, ContextLocked, ContextUnavailable
from freehold_agent.vault import VaultFormatError, VaultKeyError, decrypt_entry

logger = logging.getLogger(__name__)

# Words and numbers, in any script, with camelCase split so "birthDate"
# yields birth, date. [^\W\d_] is "a letter" in Unicode terms.
_TOKEN = re.compile(r"[A-Z]?[^\W\d_A-Z]+|[A-Z]+(?![^\W\d_A-Z])|\d+")

# Entries in a scope are fetched and decrypted together, this many at a time,
# so a broad scope cannot flood the store or the thread pool with PBKDF2 work.
READ_CONCURRENCY = 4

# Pause before an unlock attempt that follows a failed one: ~0.5 s doubling
# to 8 s, so the endpoint is a poor password oracle and PBKDF2 work stays
# bounded. Attempts are serialised, so a flood waits rather than piling up.
UNLOCK_BACKOFF_BASE_SECONDS = 0.5
UNLOCK_BACKOFF_MAX_SECONDS = 8.0


@dataclass
class ContextEntry:
    """A stored entry, decrypted.

    ``data`` is the entry's JSON value, usually an object; an entry whose
    plaintext is not JSON is carried as that string.
    """

    key: str
    data: object
    version: int
    updated_at: str

    def fields(self) -> list[tuple[str, object]]:
        """The entry's top-level fields; a non-object entry is one field, ``value``."""
        if isinstance(self.data, dict):
            return [(str(name), value) for name, value in self.data.items()]
        return [("value", self.data)]


@dataclass(frozen=True)
class _RawEntry:
    """An entry as the store returns it: still encrypted."""

    key: str
    encrypted_data: str
    version: int
    updated_at: str


@dataclass
class ContextItem:
    """One field of one entry, as a search result.

    ``id`` is ``<entry key>/<field>`` with the field percent-encoded, so a
    key may contain slashes and the last one always separates the two;
    ``content`` is the field's value, as the string it is or as JSON when it
    is not a string.
    """

    id: str
    content: str
    score: float
    metadata: dict[str, object] | None = None


def scope_domain(scope: str | None) -> str:
    """The domain a scope names: its first path segment.

    Empty when the scope is None, empty or only slashes; an empty domain is
    the one representation of "no scope", and :func:`in_domain` admits no
    key to it.
    """
    if scope is None:
        return ""
    return scope.strip("/").split("/", 1)[0]


def in_domain(key: str, domain: str) -> bool:
    """Whether an entry key belongs to a domain; an empty domain admits no key."""
    if not domain:
        return False
    return key == domain or key.startswith((domain + "-", domain + "/"))


def _terms(text: str) -> list[str]:
    return [t.lower() for t in _TOKEN.findall(text)]


def _score(terms: list[str], text: str) -> float:
    """Share of the query terms present in ``text``; 1.0 for an empty query."""
    if not terms:
        return 1.0
    words = set(_terms(text))
    return sum(term in words for term in terms) / len(terms)


def _content(value: object) -> str:
    """A field's value as text: the string it is, or JSON with its non-ASCII text kept."""
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)


class ContextClient:
    """Reads a user's entries from the context store, decrypting them here.

    The HTTP client is opened on first use (or :meth:`connect`) and closed by
    :meth:`disconnect`, unless one is injected, in which case its owner closes
    it. Every read needs :meth:`unlock` first; otherwise :class:`ContextLocked`
    is raised. Every failure to read is a :class:`ContextUnavailable` whose
    message names the cause, so a caller can report it without inspecting it.
    """

    def __init__(self, config: ContextConfig, *, client: httpx2.AsyncClient | None = None) -> None:
        self.config = config
        self._owns_client = client is None
        self._client = client
        self._user_id: str | None = None
        self._password: str | None = None
        self._unlock_gate = asyncio.Lock()
        self._failed_unlocks = 0
        self._read_slots = asyncio.Semaphore(READ_CONCURRENCY)

    async def connect(self) -> None:
        """Open the HTTP connection pool. Reads open it on demand, so this is optional."""
        self._http()

    async def disconnect(self) -> None:
        """Forget the vault secret and close the connection pool this client opened.

        An injected client is detached, not closed; its owner closes it. Any
        pool opened after that is this client's own.
        """
        self.lock()
        client, self._client = self._client, None
        if client is not None and self._owns_client:
            await client.aclose()
        self._owns_client = True

    async def unlock(self, user_id: str, password: str) -> None:
        """Hold the vault secret for ``user_id``, after checking it opens a stored entry.

        The check uses the first entry, by key, that is in the vault format;
        entries that are not are no evidence either way. A user with no such
        entry has nothing to check against, so any password is accepted and
        the first entry written decides. Attempts are serialised, and one
        that follows a failure waits first (see UNLOCK_BACKOFF_BASE_SECONDS).
        A failed attempt leaves whatever secret was held as it was.

        Raises:
            ContextKeyInvalid: The password does not decrypt the user's entries.
            ContextUnavailable: The store cannot be reached or answers unexpectedly.
        """
        async with self._unlock_gate:
            if self._failed_unlocks:
                await asyncio.sleep(self._unlock_backoff())
            try:
                await self._check_password(user_id, password)
            except ContextKeyInvalid:
                self._failed_unlocks += 1
                raise
            self._failed_unlocks = 0
            self._user_id, self._password = user_id, password

    def _unlock_backoff(self) -> float:
        doublings = min(self._failed_unlocks - 1, 16)  # already past the cap by then.
        return min(UNLOCK_BACKOFF_BASE_SECONDS * 2**doublings, UNLOCK_BACKOFF_MAX_SECONDS)

    async def _check_password(self, user_id: str, password: str) -> None:
        for key in sorted(await self._keys(user_id)):
            raw = await self._raw_entry(user_id, key)
            if raw is None:
                continue
            try:
                await asyncio.to_thread(decrypt_entry, raw.encrypted_data, password)
            except VaultFormatError:
                continue
            except VaultKeyError as exc:
                raise ContextKeyInvalid(f"cannot decrypt entry {key!r}") from exc
            return

    def lock(self) -> None:
        """Forget the vault secret; reads raise ContextLocked until the next unlock.

        A read already in progress completes with the secret it took; lock
        is a boundary for new reads, not a cancellation of running ones.
        """
        self._user_id = self._password = None

    @property
    def is_unlocked(self) -> bool:
        """Whether a vault secret is held."""
        return self._password is not None

    async def entries(self, scope: str | None = None) -> list[ContextEntry]:
        """The user's entries in ``scope``, decrypted, by key; none without a scope.

        Entries are fetched and decrypted concurrently, READ_CONCURRENCY at a
        time. One deleted between the listing and its read, or one the held
        secret does not open, is left out (the latter with a warning).

        Raises:
            ContextLocked: No vault secret is held.
            ContextUnavailable: The store cannot be reached or answers unexpectedly.
        """
        user_id, password = self._secret()
        domain = scope_domain(scope)
        keys = sorted(k for k in await self._keys(user_id) if in_domain(k, domain))
        read = await asyncio.gather(*(self._read(user_id, key, password) for key in keys))
        return [entry for entry in read if entry is not None]

    async def _read(self, user_id: str, key: str, password: str) -> ContextEntry | None:
        async with self._read_slots:
            raw = await self._raw_entry(user_id, key)
            if raw is None:
                return None
            try:
                return await self._open(raw, password)
            except ContextKeyInvalid as exc:
                logger.warning("skipping entry %r: %s", key, exc)
                return None

    async def search(
        self,
        query: str,
        scope: str | None = None,
        limit: int = 10,
    ) -> list[ContextItem]:
        """Fields of the entries in ``scope`` that match ``query``, best first.

        An empty query returns every field in scope; otherwise only fields
        with at least one query term, ranked by the share of terms matched.
        Ties keep entry-key then field order. Raises as :meth:`entries` does.
        """
        terms = _terms(query)
        items: list[ContextItem] = []
        for entry in await self.entries(scope):
            for field, value in entry.fields():
                content = _content(value)
                score = _score(terms, f"{field} {content}")
                if score > 0:
                    items.append(self._item(entry, field, content, score))
        items.sort(key=lambda item: -item.score)
        return items[:limit]

    async def get(self, item_id: str) -> ContextItem | None:
        """The item ``<entry key>/<field>``, or None if either is missing.

        Raises as :meth:`entries` does.
        """
        key, sep, field = item_id.rpartition("/")
        if not sep:
            return None
        field = unquote(field)
        user_id, password = self._secret()
        entry = await self._read(user_id, key, password)
        if entry is None:
            return None
        for name, value in entry.fields():
            if name == field:
                return self._item(entry, field, _content(value), 1.0)
        return None

    @staticmethod
    def _item(entry: ContextEntry, field: str, content: str, score: float) -> ContextItem:
        return ContextItem(
            id=f"{entry.key}/{quote(field, safe='')}",
            content=content,
            score=score,
            metadata={
                "key": entry.key,
                "field": field,
                "version": entry.version,
                "updated_at": entry.updated_at,
            },
        )

    def _secret(self) -> tuple[str, str]:
        if self._user_id is None or self._password is None:
            raise ContextLocked("context store locked")
        return self._user_id, self._password

    def _http(self) -> httpx2.AsyncClient:
        if self._client is None:
            self._client = httpx2.AsyncClient(
                base_url=self.config.endpoint, timeout=self.config.timeout_seconds
            )
        return self._client

    async def _request(self, path: str, user_id: str) -> httpx2.Response:
        """GET ``path`` as ``user_id``; a transport failure is ContextUnavailable."""
        try:
            return await self._http().get(path, headers={"X-User-ID": user_id})
        except httpx2.HTTPError as exc:
            raise ContextUnavailable("context store unreachable") from exc

    async def _keys(self, user_id: str) -> list[str]:
        """Every entry key the store holds for ``user_id``.

        Raises:
            ContextUnavailable: The store cannot be reached, answers with an
                error status, or returns something other than a key listing.
        """
        response = await self._request("/entries", user_id)
        if response.status_code != 200:
            raise ContextUnavailable(f"context store error: HTTP {response.status_code}")
        payload = _json(response)
        keys = payload.get("keys") if isinstance(payload, dict) else None
        if not isinstance(keys, list) or not all(isinstance(k, str) for k in keys):
            raise ContextUnavailable("context store returned an unexpected listing")
        return keys

    async def _raw_entry(self, user_id: str, key: str) -> _RawEntry | None:
        """One entry as stored, still encrypted, or None if the store has no such key.

        Raises:
            ContextUnavailable: The store cannot be reached, answers with an
                error status other than 404, or returns a malformed entry.
        """
        response = await self._request(f"/entries/{quote(key, safe='')}", user_id)
        if response.status_code == 404:
            return None
        if response.status_code != 200:
            raise ContextUnavailable(f"context store error: HTTP {response.status_code}")
        payload = _json(response)
        if not isinstance(payload, dict):
            raise ContextUnavailable(f"context store returned an unexpected entry for {key!r}")
        encrypted_data = payload.get("encrypted_data")
        version = payload.get("version")
        updated_at = payload.get("updated_at")
        if (
            not isinstance(encrypted_data, str)
            or not isinstance(version, int)
            or not isinstance(updated_at, str)
        ):
            raise ContextUnavailable(f"context store returned an unexpected entry for {key!r}")
        return _RawEntry(key, encrypted_data, version, updated_at)

    async def _open(self, raw: _RawEntry, password: str) -> ContextEntry:
        """Decrypt a raw entry off the event loop (PBKDF2 is deliberately slow)."""
        try:
            plaintext = await asyncio.to_thread(decrypt_entry, raw.encrypted_data, password)
        except (VaultFormatError, VaultKeyError) as exc:
            raise ContextKeyInvalid(f"cannot decrypt entry {raw.key!r}: {exc}") from exc
        try:
            data: object = json.loads(plaintext)
        except ValueError:
            data = plaintext
        return ContextEntry(key=raw.key, data=data, version=raw.version, updated_at=raw.updated_at)


def _json(response: httpx2.Response) -> object:
    """The response body as JSON; anything else is ContextUnavailable."""
    try:
        return response.json()
    except ValueError as exc:
        raise ContextUnavailable("context store returned a non-JSON response") from exc
