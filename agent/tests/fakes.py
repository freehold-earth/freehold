"""Test doubles shared across the agent's suites."""

from __future__ import annotations

from freehold_agent.context import ContextEntry, in_domain, scope_domain


class FakeVault:
    """An unlocked vault in memory, with the read surface of ContextClient.

    ``put`` stores a decrypted entry under a key; ``entries`` filters by the
    scope's domain the way the real client does; ``entry`` reads one key. Set
    ``error`` to make every read raise it, as a locked or unreachable store
    would.
    """

    def __init__(self, entries: dict[str, object] | None = None) -> None:
        self._entries: dict[str, ContextEntry] = {}
        self.error: Exception | None = None
        self.reads: list[str] = []
        for key, data in (entries or {}).items():
            self.put(key, data)

    def put(self, key: str, data: object) -> None:
        self._entries[key] = ContextEntry(
            key=key, data=data, version=1, updated_at="2026-11-07T00:00:00Z"
        )

    async def entries(self, scope: str | None = None) -> list[ContextEntry]:
        self.reads.append(f"entries:{scope}")
        if self.error is not None:
            raise self.error
        domain = scope_domain(scope)
        return [e for k, e in sorted(self._entries.items()) if in_domain(k, domain)]

    async def entry(self, key: str) -> ContextEntry | None:
        self.reads.append(f"entry:{key}")
        if self.error is not None:
            raise self.error
        return self._entries.get(key)
