import httpx2
import pytest

from freehold_agent.errors import ZKPUnavailable
from freehold_agent.zkp import ZKPClient


def _client(handler) -> ZKPClient:
    transport = httpx2.MockTransport(handler)
    return ZKPClient(
        "https://zkp.test",
        client=httpx2.AsyncClient(base_url="https://zkp.test", transport=transport),
    )


@pytest.mark.anyio
async def test_payment_required_names_the_dust_address() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(
            402,
            json={
                "error": (
                    "The wallet holds no DUST to pay proof fees; "
                    "sponsor DUST generation to mn_dust1abc"
                ),
                "dustAddress": "mn_dust1abc",
            },
        )

    with pytest.raises(ZKPUnavailable, match=r"cannot pay for proofs: .*mn_dust1abc"):
        await _client(handler).generate("age", {"birthDate": "2000-01-01"})


@pytest.mark.anyio
async def test_payment_required_appends_the_address_the_message_omits() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(402, json={"error": "no DUST", "dustAddress": "mn_dust1xyz"})

    with pytest.raises(ZKPUnavailable, match=r"no DUST \(sponsor DUST generation to mn_dust1xyz\)"):
        await _client(handler).generate("age", {})


@pytest.mark.anyio
async def test_payment_required_without_a_message_is_still_specific() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(402, content=b"not json")

    with pytest.raises(ZKPUnavailable, match=r"cannot pay for proofs$"):
        await _client(handler).generate("age", {})


@pytest.mark.anyio
async def test_other_failures_stay_unavailable() -> None:
    def handler(request: httpx2.Request) -> httpx2.Response:
        return httpx2.Response(500, json={"error": "Proof generation failed"})

    with pytest.raises(ZKPUnavailable, match="unavailable"):
        await _client(handler).generate("age", {})
