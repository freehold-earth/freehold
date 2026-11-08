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

    async def audit_key(self) -> bytes:
        """The holder's audit key; this vault is always unlocked for one holder."""
        return b"fake-vault-audit-key".ljust(32, b"=")

    # The lifecycle surface the Agent uses on the app's client; nothing to open here.
    async def connect(self) -> None:
        return None

    async def disconnect(self) -> None:
        return None


# The policy the demo's user app seeds on first unlock (demo/apps/user-app/src/policies.ts
# mirrors this; owner and id differ per vault). Tests put it under policies/age-verification.
SEED_OWNER = "did:key:z6MkseedOwner"
SEED_ROOT_IDENTITY: dict[str, object] = {
    "did": SEED_OWNER,
    "publicKey": [7] * 32,
    "createdAt": "2026-11-07T00:00:00Z",
}
_SEED_CONDITIONS: dict[str, object] = {
    "identity": {"type": "ephemeral_required"},
    "proofs": [{"type": "zkp", "claim": "age"}],
    "retention": {"max_seconds": 0, "audit_log": True},
    "derivatives": {"training": "forbidden", "aggregation": "forbidden", "resale": "forbidden"},
}
SEED_POLICY: dict[str, object] = {
    "version": "1.1",
    "id": f"spal:{SEED_OWNER}:age-verification",
    "name": "Age Verification Only",
    "description": "Allow businesses to verify age without revealing birth date",
    "owner": SEED_OWNER,
    "created": "2026-11-07T00:00:00Z",
    "updated": "2026-11-07T00:00:00Z",
    "rules": [
        {
            "id": "rule-age",
            "context_scope": "personal/age",
            # Age may be worked on at a federated operator (the demo's community node).
            "conditions": {**_SEED_CONDITIONS, "custody": {"operator": "federated_operator"}},
        },
        {
            "id": "rule-allergies",
            "context_scope": "health/allergies",
            # Says nothing about custody, so health data stays on hardware the
            # holder controls: a different domain from personal, so the age ask
            # at a federated operator is not held back by it. No proof is
            # required: there is no allergy claim to prove.
            "conditions": {
                "identity": {"type": "ephemeral_required"},
                "retention": {"max_seconds": 0, "audit_log": True},
                "derivatives": {
                    "training": "forbidden",
                    "aggregation": "forbidden",
                    "resale": "forbidden",
                },
            },
        },
    ],
}
SEED_KEY = "policies/age-verification"


def seeded_vault() -> FakeVault:
    """A FakeVault holding the seed root identity and the seed policy."""
    return FakeVault({"root-identity": SEED_ROOT_IDENTITY, SEED_KEY: SEED_POLICY})
