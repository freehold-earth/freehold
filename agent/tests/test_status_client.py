"""Tests for the /services status aggregation client."""

from collections.abc import Callable

import httpx2
import pytest

from freehold_agent.status import StatusClient


def _client(handler: Callable[[httpx2.Request], httpx2.Response]) -> StatusClient:
    transport = httpx2.MockTransport(handler)
    http = httpx2.AsyncClient(transport=transport)
    return StatusClient(
        agent_url="http://agent",
        zkp_url="http://zkp",
        cardano_url="http://cardano",
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


async def test_check_reports_where_to_sponsor_the_zkp_service_and_what_it_holds() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        if request.url.host == "zkp":
            dust = {"address": "mn_dust_undeployed1abc", "balance": "1250000000000000"}
            return httpx2.Response(200, json={"status": "healthy", "dust": dust})
        return httpx2.Response(200, json={"number": 1})

    client = _client(handler)
    result = await client.check()
    assert result.zkp.dust is not None
    assert result.zkp.dust.address == "mn_dust_undeployed1abc"
    assert result.zkp.dust.balance == "1250000000000000"
    await client.aclose()


async def test_check_keeps_the_dust_address_when_the_balance_could_not_be_read() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        if request.url.host == "zkp":
            dust = {"address": "mn_dust_undeployed1abc", "balance": None}
            return httpx2.Response(200, json={"status": "healthy", "dust": dust})
        return httpx2.Response(200, json={"number": 1})

    client = _client(handler)
    result = await client.check()
    assert result.zkp.dust is not None
    assert result.zkp.dust.balance is None
    await client.aclose()


@pytest.mark.parametrize(
    "dust", [None, "soon", {"balance": "5"}, {"address": "", "balance": "5"}, {"address": 7}]
)
async def test_check_reports_no_dust_state_for_a_missing_or_malformed_report(dust: object) -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        if request.url.host == "zkp":
            return httpx2.Response(200, json={"status": "healthy", "dust": dust})
        return httpx2.Response(200, json={"number": 1})

    client = _client(handler)
    result = await client.check()
    assert result.zkp.status == "healthy"
    assert result.zkp.dust is None
    await client.aclose()
