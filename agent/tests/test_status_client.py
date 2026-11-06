"""Tests for the /services status aggregation client."""

import asyncio
from collections.abc import Callable

import httpx2
import pytest

from freehold_agent.status import StatusClient


def test_plain_http_is_refused_and_a_trailing_slash_dropped() -> None:
    with pytest.raises(ValueError, match="https://"):
        StatusClient(agent_url="https://agent", zkp_url="http://zkp", cardano_url="https://cardano")
    seen: list[str] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen.append(request.url.path)
        return httpx2.Response(200, json={"status": "healthy"})

    client = StatusClient(
        agent_url="https://agent",
        zkp_url="https://zkp/",
        cardano_url="https://cardano/",
        client=httpx2.AsyncClient(transport=httpx2.MockTransport(handler)),
    )
    asyncio.run(client.check())
    assert "/health" in seen and "//health" not in seen


def _client(handler: Callable[[httpx2.Request], httpx2.Response]) -> StatusClient:
    transport = httpx2.MockTransport(handler)
    http = httpx2.AsyncClient(transport=transport)
    return StatusClient(
        agent_url="https://agent",
        zkp_url="https://zkp",
        cardano_url="https://cardano",
        client=http,
    )


async def test_check_reports_healthy_services_and_latest_block() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        if request.url.host == "zkp":
            return httpx2.Response(200, json={"status": "healthy"})
        return httpx2.Response(200, json={"number": 123})

    client = _client(handler)
    result = await client.check()
    assert result.agent.status == "healthy"
    assert result.zkp.status == "healthy"
    assert result.cardano.status == "healthy"
    assert result.cardano.latest_block == 123
    await client.aclose()


async def test_check_reports_unavailable_on_transport_error() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectError("refused")

    client = _client(handler)
    result = await client.check()
    assert result.zkp.status == "unavailable"
    assert result.zkp.error
    assert result.cardano.status == "unavailable"
    assert result.cardano.latest_block is None
    await client.aclose()


async def test_check_reports_unavailable_on_http_error_status() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(500)

    client = _client(handler)
    result = await client.check()
    assert result.zkp.status == "unavailable"
    assert result.cardano.status == "unavailable"
    await client.aclose()


async def test_check_uses_cardano_height_fallback() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        if request.url.host == "zkp":
            return httpx2.Response(200, json={})
        return httpx2.Response(200, json={"height": 7})

    client = _client(handler)
    result = await client.check()
    assert result.zkp.status == "healthy"
    assert result.cardano.latest_block == 7
    await client.aclose()


async def test_check_reports_block_zero_without_height_fallback() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        if request.url.host == "zkp":
            return httpx2.Response(200, json={"status": "healthy"})
        return httpx2.Response(200, json={"number": 0, "height": 5})

    client = _client(handler)
    result = await client.check()
    assert result.cardano.status == "healthy"
    assert result.cardano.latest_block == 0
    await client.aclose()


async def test_check_tolerates_non_numeric_block() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        if request.url.host == "zkp":
            return httpx2.Response(200, json={"status": "healthy"})
        return httpx2.Response(200, json={"number": "not-a-block"})

    client = _client(handler)
    result = await client.check()
    assert result.cardano.status == "healthy"
    assert result.cardano.latest_block is None
    await client.aclose()


ADDRESS = "mn_dust_undeployed1" + "qpzry9x8gf2tvdw0s3jn54khce6mua7l" * 2


def _zkp(dust: object, wallet: object = "ready") -> Callable[[httpx2.Request], httpx2.Response]:
    def handler(request: httpx2.Request) -> httpx2.Response:
        if request.url.host == "zkp":
            return httpx2.Response(200, json={"status": "healthy", "wallet": wallet, "dust": dust})
        return httpx2.Response(200, json={"number": 1})

    return handler


async def test_check_reports_where_to_sponsor_the_zkp_service_and_what_it_holds() -> None:
    client = _client(_zkp({"address": ADDRESS, "balance": "1250000000000000"}))
    result = await client.check()
    assert result.zkp.wallet == "ready"
    assert result.zkp.dust is not None
    assert result.zkp.dust.address == ADDRESS
    assert result.zkp.dust.balance == "1250000000000000"
    await client.aclose()


@pytest.mark.parametrize("balance", [None, 1250, "1e9", "-5", "", "many", "5\n", "1" * 41])
async def test_check_keeps_the_dust_address_when_the_balance_is_unreadable(balance: object) -> None:
    client = _client(_zkp({"address": ADDRESS, "balance": balance}))
    result = await client.check()
    assert result.zkp.dust is not None
    assert result.zkp.dust.address == ADDRESS
    assert result.zkp.dust.balance is None
    await client.aclose()


@pytest.mark.parametrize(
    "dust",
    [
        None,
        "soon",
        {"balance": "5"},
        {"address": "", "balance": "5"},
        {"address": 7},
        {"address": "not an address"},
        {"address": "mn_addr_undeployed1" + "q" * 40},
        {"address": "mn_dust_undeployed1" + "q" * 201},
        {"address": "mn_dust_undeployed1QQQQQQ"},
        {"address": ADDRESS + "\n"},
        {"address": "mn_dust_undeployed1" + "qpzry9x8gf2tvdw0s3jn54khce6mua7l" + "b1io"},
        {"address": "mn_dust_net02" + "1" + "q" * 40},
        {"address": "mn_dust_" + "a" * 33 + "1" + "q" * 40},
    ],
)
async def test_check_reports_no_dust_state_without_a_usable_address(dust: object) -> None:
    client = _client(_zkp(dust))
    result = await client.check()
    assert result.zkp.status == "healthy"
    assert result.zkp.dust is None
    await client.aclose()


@pytest.mark.parametrize(
    ("reported", "relayed"),
    [
        ("starting", "starting"),
        ("offline", "offline"),
        ("failed", "failed"),
        ("odd", None),
        (None, None),
        ({}, None),
        (["ready"], None),
        (7, None),
    ],
)
async def test_check_relays_the_wallet_readiness_the_service_names(
    reported: object, relayed: str | None
) -> None:
    client = _client(_zkp(None, wallet=reported))
    result = await client.check()
    assert result.zkp.wallet == relayed
    await client.aclose()


@pytest.mark.parametrize("status", [None, "", 7, {"state": "healthy"}, ["healthy"]])
async def test_check_reads_a_status_that_is_not_a_word_as_healthy(status: object) -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        if request.url.host == "zkp":
            return httpx2.Response(200, json={"status": status})
        return httpx2.Response(200, json={"number": 1})

    client = _client(handler)
    result = await client.check()
    assert result.zkp.status == "healthy"
    await client.aclose()
