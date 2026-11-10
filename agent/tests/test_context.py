"""ContextClient against a fake store that serves the real wire format."""

import json

import httpx2
import pytest

from freehold_agent.config import ContextConfig
from freehold_agent.context import ContextClient
from freehold_agent.errors import ContextKeyInvalid, ContextLocked, ContextUnavailable
from freehold_agent.scope import in_scope
from freehold_agent.vault import encrypt_entry

PASSWORD = "demo-password"  # pragma: allowlist secret
USER = "demo-user"


class FakeStore:
    """The context store's read surface: GET /entries and GET /entries/{key}."""

    def __init__(self, entries: dict[str, object] | None = None, password: str = PASSWORD) -> None:
        self.entries: dict[str, str] = {}
        self.requests: list[httpx2.Request] = []
        self.unreachable = False
        self.only_user: str | None = None  # when set, other users see an empty store.
        for key, value in (entries or {}).items():
            self.put(key, value, password)

    def put(self, key: str, value: object, password: str = PASSWORD) -> None:
        self.entries[key] = encrypt_entry(json.dumps(value), password)

    def handle(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        if self.unreachable:
            raise httpx2.ConnectError("connection refused", request=request)
        path = request.url.path
        if self.only_user is not None and request.headers.get("X-User-ID") != self.only_user:
            if path == "/entries":
                return httpx2.Response(200, json={"keys": []})
            return httpx2.Response(404, json={"error": "Not found"})
        if path == "/entries":
            return httpx2.Response(200, json={"keys": list(self.entries)})
        key = httpx2.URL(path).path.removeprefix("/entries/")
        key = key.replace("%2F", "/")
        if key not in self.entries:
            return httpx2.Response(404, json={"error": "Not found"})
        return httpx2.Response(
            200,
            json={
                "key": key,
                "encrypted_data": self.entries[key],
                "created_at": "2026-11-04T00:00:00Z",
                "updated_at": "2026-11-04T00:00:00Z",
                "version": 1,
            },
        )


def _client(store: FakeStore) -> ContextClient:
    http = httpx2.AsyncClient(
        base_url="https://store.test", transport=httpx2.MockTransport(store.handle)
    )
    return ContextClient(ContextConfig(endpoint="https://store.test"), client=http)


async def _unlocked(store: FakeStore, password: str = PASSWORD) -> ContextClient:
    client = _client(store)
    await client.unlock(USER, password)
    return client


DEMO = {
    "personal/age": {"birthDate": "1990-05-15", "fullName": "Alice Demo"},
    "root-identity": {"did": "did:key:z6Mk", "privateKey": "secret"},
}


async def test_reads_are_locked_until_unlock() -> None:
    client = _client(FakeStore(DEMO))
    with pytest.raises(ContextLocked, match="locked"):
        await client.entries("personal/age")
    assert not client.is_unlocked


async def test_unlock_rejects_a_wrong_password_without_holding_it() -> None:
    client = _client(FakeStore(DEMO))
    with pytest.raises(ContextKeyInvalid, match="cannot decrypt"):
        await client.unlock(USER, "wrong")
    assert not client.is_unlocked


async def test_unlock_accepts_any_password_for_an_empty_vault() -> None:
    client = _client(FakeStore())
    await client.unlock(USER, "anything")
    assert client.is_unlocked
    assert await client.entries("personal") == []


async def test_entries_in_scope_are_decrypted_and_the_rest_left_alone() -> None:
    store = FakeStore(DEMO)
    client = await _unlocked(store)

    found = await client.entries("personal/age")

    assert [e.key for e in found] == ["personal/age"]
    assert found[0].data == DEMO["personal/age"]
    assert found[0].version == 1
    fetched = [r.url.path for r in store.requests if r.url.path.startswith("/entries/")]
    assert "/entries/root-identity" not in fetched[1:]  # only the unlock check read it


async def test_no_scope_reads_nothing() -> None:
    client = await _unlocked(FakeStore(DEMO))
    assert await client.entries() == []
    assert await client.entries("") == []
    assert await client.entries("/") == []
    assert await client.search("did") == []


async def test_entries_come_back_in_key_order() -> None:
    store = FakeStore({"personal/b": {"x": 1}, "personal/a": {"y": 2}})
    client = await _unlocked(store)
    assert [e.key for e in await client.entries("personal")] == ["personal/a", "personal/b"]


async def test_requests_identify_the_user() -> None:
    store = FakeStore(DEMO)
    client = await _unlocked(store)
    await client.entries("personal")
    assert {r.headers["X-User-ID"] for r in store.requests} == {USER}


async def test_unreachable_store_is_reported_as_such() -> None:
    store = FakeStore(DEMO)
    client = await _unlocked(store)
    store.unreachable = True
    with pytest.raises(ContextUnavailable, match="unreachable"):
        await client.entries("personal")


async def test_an_entry_deleted_between_listing_and_read_is_skipped() -> None:
    store = FakeStore(DEMO)
    client = await _unlocked(store)
    listing = store.handle

    def racy(request: httpx2.Request) -> httpx2.Response:
        response = listing(request)
        if request.url.path == "/entries":
            store.entries.pop("root-identity", None)
        return response

    client._client = httpx2.AsyncClient(  # noqa: SLF001
        base_url="https://store.test", transport=httpx2.MockTransport(racy)
    )
    store.put("root-identity", DEMO["root-identity"])
    assert [e.key for e in await client.entries("root")] == []


async def test_an_entry_under_another_password_is_skipped_with_a_warning(
    caplog: pytest.LogCaptureFixture,
) -> None:
    store = FakeStore(DEMO)
    store.put("personal/notes", {"note": "x"}, password="other")
    client = await _unlocked(store)
    with caplog.at_level("WARNING"):
        found = await client.entries("personal")
    assert [e.key for e in found] == ["personal/age"]
    assert "skipping entry 'personal/notes'" in caplog.text


async def test_unlock_checks_the_first_vault_format_entry_not_a_stray_blob() -> None:
    store = FakeStore(DEMO)
    store.entries["a-raw-blob"] = "not even json"  # sorts first; not vault format
    client = _client(store)
    await client.unlock(USER, PASSWORD)
    assert client.is_unlocked
    with pytest.raises(ContextKeyInvalid):
        await _client(store).unlock(USER, "wrong")


async def test_failed_unlocks_back_off(monkeypatch: pytest.MonkeyPatch) -> None:
    import freehold_agent.context as context_module

    waits: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        waits.append(seconds)

    monkeypatch.setattr(context_module.asyncio, "sleep", fake_sleep)
    client = _client(FakeStore(DEMO))
    for _ in range(5):
        with pytest.raises(ContextKeyInvalid):
            await client.unlock(USER, "wrong")
    await client.unlock(USER, PASSWORD)
    assert waits == [0.5, 1.0, 2.0, 4.0, 8.0]
    assert client.is_unlocked
    with pytest.raises(ContextKeyInvalid):
        await client.unlock(USER, "wrong")
    await client.unlock(USER, PASSWORD)
    assert waits[-1] == 0.5  # the counter reset on success


async def test_empty_query_lists_every_field_in_scope() -> None:
    client = await _unlocked(FakeStore(DEMO))
    items = await client.search("", scope="personal/age")
    assert [(i.id, i.content, i.score) for i in items] == [
        ("personal/age/birthDate", "1990-05-15", 1.0),
        ("personal/age/fullName", "Alice Demo", 1.0),
    ]
    assert items[0].metadata == {
        "key": "personal/age",
        "field": "birthDate",
        "version": 1,
        "updated_at": "2026-11-04T00:00:00Z",
    }


async def test_camel_case_field_names_match_their_words() -> None:
    client = await _unlocked(FakeStore(DEMO))
    items = await client.search("What is my birth date?", scope="personal")
    assert [i.id for i in items] == ["personal/age/birthDate"]


async def test_search_handles_names_in_any_script() -> None:
    store = FakeStore({"personal/age": {"fullName": "Zoë Müller", "city": "東京"}})
    client = await _unlocked(store)
    assert [i.id for i in await client.search("müller", scope="personal")] == [
        "personal/age/fullName"
    ]
    assert [i.id for i in await client.search("東京", scope="personal")] == ["personal/age/city"]


async def test_nested_text_in_any_script_is_searchable() -> None:
    store = FakeStore({"personal/age": {"aliases": ["Zoë", "東京"]}})
    client = await _unlocked(store)
    items = await client.search("東京", scope="personal")
    assert [(i.id, i.content) for i in items] == [("personal/age/aliases", '["Zoë", "東京"]')]


async def test_a_field_name_with_a_slash_round_trips_through_its_id() -> None:
    store = FakeStore({"personal/age": {"a/b": "x"}})
    client = await _unlocked(store)
    [item] = await client.search("", scope="personal")
    assert item.id == "personal/age/a%2Fb"
    fetched = await client.get(item.id)
    assert fetched is not None and fetched.content == "x"


async def test_disconnect_then_reuse_owns_the_new_pool() -> None:
    client = await _unlocked(FakeStore(DEMO))
    await client.disconnect()
    assert client._owns_client  # noqa: SLF001
    assert client._client is None  # noqa: SLF001


async def test_reads_are_bounded_in_flight(monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio

    import freehold_agent.context as context_module

    in_flight = 0
    peak = 0
    real_open = ContextClient._open

    async def slow_open(self, raw, password):
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        await asyncio.sleep(0)
        try:
            return await real_open(self, raw, password)
        finally:
            in_flight -= 1

    monkeypatch.setattr(ContextClient, "_open", slow_open)
    store = FakeStore({f"personal/{i}": {"n": i} for i in range(12)})
    client = await _unlocked(store)
    assert len(await client.entries("personal")) == 12
    assert 1 <= peak <= context_module.READ_CONCURRENCY


async def test_a_lock_during_the_password_check_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    client = await _unlocked(FakeStore(DEMO))
    real_check = ContextClient._check_password

    async def check_then_lock(self, user_id, password):
        result = await real_check(self, user_id, password)
        self.lock()  # a /lock arriving while the check ran
        return result

    monkeypatch.setattr(ContextClient, "_check_password", check_then_lock)
    with pytest.raises(ContextLocked, match="while the password was being checked"):
        await client.unlock(USER, PASSWORD)
    assert not client.is_unlocked


async def test_an_unchecked_unlock_does_not_reset_the_backoff(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import freehold_agent.context as context_module

    waits: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        waits.append(seconds)

    monkeypatch.setattr(context_module.asyncio, "sleep", fake_sleep)
    store = FakeStore(DEMO)
    store.only_user = USER
    client = _client(store)
    for _ in range(3):
        with pytest.raises(ContextKeyInvalid):
            await client.unlock(USER, "wrong")
    await client.unlock("nobody-yet", "anything")  # no entries: accepted, unchecked
    for _ in range(2):
        with pytest.raises(ContextKeyInvalid):
            await client.unlock(USER, "wrong")
    # The unchecked unlock itself waited (2.0) and left the count at three.
    assert waits == [0.5, 1.0, 2.0, 2.0, 4.0]


async def test_a_stray_entry_sorting_first_does_not_lock_the_user_out() -> None:
    store = FakeStore(DEMO)
    store.put("a-stray", {"old": True}, password="former-password")
    client = _client(store)
    await client.unlock(USER, PASSWORD)
    assert client.is_unlocked and client.user_id == USER
    with pytest.raises(ContextKeyInvalid, match="a-stray"):
        await _client(store).unlock(USER, "opens nothing")


async def test_no_scope_never_asks_the_store() -> None:
    store = FakeStore(DEMO)
    client = await _unlocked(store)
    store.unreachable = True
    assert await client.entries() == []
    assert await client.entries("/") == []


async def test_upper_case_accented_values_match_lower_case_queries() -> None:
    store = FakeStore({"personal/age": {"fullName": "ZOË MÜLLER", "ref": "XMLParser7"}})
    client = await _unlocked(store)
    assert [i.id for i in await client.search("müller", scope="personal")] == [
        "personal/age/fullName"
    ]
    assert [i.id for i in await client.search("parser 7", scope="personal")] == ["personal/age/ref"]


async def test_a_failed_unlock_keeps_the_held_secret() -> None:
    client = await _unlocked(FakeStore(DEMO))
    with pytest.raises(ContextKeyInvalid):
        await client.unlock(USER, "wrong")
    assert client.is_unlocked
    assert [e.key for e in await client.entries("personal")] == ["personal/age"]


async def test_query_terms_rank_fields_and_drop_misses() -> None:
    client = await _unlocked(FakeStore(DEMO))
    items = await client.search("alice 1990", scope="personal")
    assert [(i.id, i.score) for i in items] == [
        ("personal/age/birthDate", 0.5),
        ("personal/age/fullName", 0.5),
    ]
    assert await client.search("nothing here", scope="personal") == []
    assert [i.id for i in await client.search("did", scope="root-identity")] == [
        "root-identity/did"
    ]


async def test_search_respects_limit_and_renders_non_strings_as_json() -> None:
    store = FakeStore({"personal/age": {"age": 36, "tags": ["a", "b"]}})
    client = await _unlocked(store)
    items = await client.search("", scope="personal", limit=1)
    assert [(i.id, i.content) for i in items] == [("personal/age/age", "36")]
    all_items = await client.search("", scope="personal")
    assert all_items[1].content == '["a", "b"]'


async def test_get_returns_one_field_or_none() -> None:
    client = await _unlocked(FakeStore(DEMO))
    item = await client.get("personal/age/birthDate")
    assert item is not None and item.content == "1990-05-15"
    assert await client.get("personal/age/shoeSize") is None
    assert await client.get("missing/birthDate") is None
    assert await client.get("no-separator") is None


async def test_non_object_entries_are_one_value_field() -> None:
    store = FakeStore()
    store.put("notes", "just a string")
    client = await _unlocked(store)
    items = await client.search("", scope="notes")
    assert [(i.id, i.content) for i in items] == [("notes/value", "just a string")]


async def test_unexpected_store_responses_are_unavailable() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(200, json={"nope": True})

    http = httpx2.AsyncClient(
        base_url="https://store.test", transport=httpx2.MockTransport(handler)
    )
    client = ContextClient(ContextConfig(endpoint="https://store.test"), client=http)
    with pytest.raises(ContextUnavailable, match="unexpected listing"):
        await client.unlock(USER, PASSWORD)


async def test_disconnect_locks_and_keeps_an_injected_client_open() -> None:
    store = FakeStore(DEMO)
    client = await _unlocked(store)
    await client.disconnect()
    assert not client.is_unlocked
    with pytest.raises(ContextLocked):
        await client.entries()


@pytest.mark.parametrize(
    ("key", "scope", "expected"),
    [
        ("personal/age", "personal/age", True),
        ("personal/age/history", "personal/age", True),
        ("personal/name", "personal/age", False),
        ("personal-context", "personal", False),
        ("personal/age", "personal", True),
        ("personality", "personal", False),
        ("root-identity", "root", False),
        ("anything", "", False),
        ("anything", None, False),
    ],
)
def test_in_scope(key: str, scope: str | None, expected: bool) -> None:
    """A key is in a scope when it is the scope or sits under it; never beside it."""
    assert in_scope(key, scope) is expected


async def test_entries_for_a_scope_are_the_scope_and_what_is_under_it() -> None:
    store = FakeStore(
        {
            "personal/age": {"birthDate": "1990-05-15"},
            "personal/age/history": {"changed": "never"},
            "personal/name": {"fullName": "Alice"},
            "personal-context": {"legacy": True},
        }
    )
    client = await _unlocked(store)
    assert [e.key for e in await client.entries("personal/age")] == [
        "personal/age",
        "personal/age/history",
    ]
    assert [e.key for e in await client.entries("personal")] == [
        "personal/age",
        "personal/age/history",
        "personal/name",
    ]
    assert await client.entries("") == []


async def test_one_entry_that_cannot_be_opened_is_an_error_not_an_absence() -> None:
    """A listing skips a stray entry; a read of one key must not pretend it is not there."""
    from freehold_agent.errors import ContextKeyInvalid

    store = FakeStore(DEMO)
    store.put("personal/notes", {"note": "x"}, password="other")
    client = await _unlocked(store)
    with pytest.raises(ContextKeyInvalid):
        await client.entry("personal/notes")
    assert [e.key for e in await client.entries("personal")] == ["personal/age"]


@pytest.mark.parametrize("scope", ["personal/age/", "/personal/age", "personal//age"])
async def test_the_reader_refuses_a_scope_that_is_not_a_clean_path(scope: str) -> None:
    """The ask refuses first; the reader refuses too, so no seam can read an odd key."""
    client = await _unlocked(FakeStore(DEMO))
    with pytest.raises(ValueError, match="path"):
        await client.entry(scope)
    with pytest.raises(ValueError, match="path"):
        await client.entries(scope)


def test_in_scope_treats_a_trailing_slash_as_no_scope() -> None:
    assert in_scope("personal/age/history", "personal/age/") is False
    assert in_scope("personal/age", "personal/age/") is False


async def test_a_policy_name_with_a_space_is_still_a_readable_key() -> None:
    """A key must be a clean path; it need not be a scope. Policy names allow spaces."""
    store = FakeStore({**DEMO, "policies/Age Verification": {"version": "1.1"}})
    client = await _unlocked(store)
    found = await client.entry("policies/Age Verification")
    assert found is not None and found.data == {"version": "1.1"}
    assert [e.key for e in await client.entries("policies")] == ["policies/Age Verification"]
