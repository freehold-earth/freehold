"""Reachability checks for the services the agent coordinates.

Backs the /services aggregate: the agent itself plus the ZKP service and
the Cardano devnet API, probed concurrently with a short timeout.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Literal

import httpx2
from pydantic import BaseModel

logger = logging.getLogger(__name__)

# A bech32m DUST address: `mn_dust` with the network name off mainnet, the
# separator, then the data part. Bounded so a misbehaving service cannot make
# the aggregate echo an arbitrary string as a sponsorship target.
_DUST_ADDRESS = re.compile(r"^mn_dust(_[a-z0-9]+)?1[a-z0-9]{6,200}$")
_SPECKS = re.compile(r"^[0-9]+$")

WalletReadiness = Literal["starting", "offline", "ready", "failed"]
_WALLET_READINESS: frozenset[str] = frozenset(("starting", "offline", "ready", "failed"))


class EndpointStatus(BaseModel):
    """Reachability of one coordinated service."""

    status: str
    url: str
    error: str | None = None


class DustStatus(BaseModel):
    """Where a sponsor designates DUST for the ZKP service's proof fees, and what it holds.

    The balance is in specks as a decimal string, or None when the service could
    not read it.
    """

    address: str
    balance: str | None = None


class ZKPStatus(EndpointStatus):
    """ZKP service reachability, with its wallet's readiness and DUST state.

    The wallet is "offline" when the service runs without a Midnight network
    and proofs cost nothing, "starting" or "failed" before or instead of a
    wallet, and "ready" once DUST can be designated to it. None when the
    service did not say.
    """

    wallet: WalletReadiness | None = None
    dust: DustStatus | None = None


class CardanoStatus(EndpointStatus):
    """Cardano devnet reachability, with the latest block height when available."""

    latest_block: int | None = None


class ServicesStatus(BaseModel):
    """Aggregate status of the agent and the services it coordinates."""

    agent: EndpointStatus
    zkp: ZKPStatus
    cardano: CardanoStatus


class StatusClient:
    """Probes the health of the services the agent depends on."""

    def __init__(
        self,
        *,
        agent_url: str,
        zkp_url: str,
        cardano_url: str,
        client: httpx2.AsyncClient | None = None,
    ) -> None:
        """Configure the probe targets.

        Args:
            agent_url: The agent's own base URL, reported as-is.
            zkp_url: Base URL of the ZKP service; its /health route is probed.
            cardano_url: Base URL of the Cardano devnet API.
            client: HTTP client override (injected in tests). When omitted, an
                owned client with a 5-second timeout is created and closed by
                aclose.
        """
        self._agent_url = agent_url
        self._zkp_url = zkp_url
        self._cardano_url = cardano_url
        self._owns_client = client is None
        self._client = client or httpx2.AsyncClient(timeout=5.0)

    async def check(self) -> ServicesStatus:
        """Probe the coordinated services concurrently and aggregate the results."""
        zkp, cardano = await asyncio.gather(self._check_zkp(), self._check_cardano())
        return ServicesStatus(
            agent=EndpointStatus(status="healthy", url=self._agent_url),
            zkp=zkp,
            cardano=cardano,
        )

    async def _check_zkp(self) -> ZKPStatus:
        """Probe the ZKP service's health route.

        The route reports the service wallet's DUST address and balance once a
        wallet exists; a report that does not fit is left out rather than
        failing the probe.
        """
        try:
            payload = await self._get_json(f"{self._zkp_url}/health")
        except (httpx2.HTTPError, ValueError) as exc:
            return ZKPStatus(status="unavailable", url=self._zkp_url, error=_reason(exc))
        if not isinstance(payload, dict):
            return ZKPStatus(status="healthy", url=self._zkp_url)
        wallet = payload.get("wallet")
        return ZKPStatus(
            status=str(payload.get("status", "healthy")),
            url=self._zkp_url,
            wallet=wallet if wallet in _WALLET_READINESS else None,
            dust=_dust_status(payload.get("dust")),
        )

    async def _check_cardano(self) -> CardanoStatus:
        """Probe the Cardano devnet's latest block.

        The block number field differs across Yaci Store versions (number vs
        height), so both are tried before giving up on the block.
        """
        try:
            payload = await self._get_json(f"{self._cardano_url}/api/v1/blocks/latest")
        except (httpx2.HTTPError, ValueError) as exc:
            return CardanoStatus(status="unavailable", url=self._cardano_url, error=_reason(exc))
        block = None
        if isinstance(payload, dict):
            raw = payload.get("number")
            if raw is None:
                raw = payload.get("height")
            block = raw if isinstance(raw, int) and not isinstance(raw, bool) else None
        return CardanoStatus(status="healthy", url=self._cardano_url, latest_block=block)

    async def _get_json(self, url: str) -> object:
        """Fetch a URL and decode its JSON body, raising on any failure."""
        response = await self._client.get(url)
        response.raise_for_status()
        return response.json()

    async def aclose(self) -> None:
        """Close the underlying client if this instance owns it."""
        if self._owns_client:
            await self._client.aclose()


def _dust_status(reported: object) -> DustStatus | None:
    """Read the service's DUST report, or None when there is none or no usable address.

    The address is what a sponsor acts on, so it is kept whenever it is well
    formed; a balance that is not a speck count is reported as unreadable
    rather than costing the address.
    """
    if reported is None:
        return None
    address = reported.get("address") if isinstance(reported, dict) else None
    if not isinstance(address, str) or not _DUST_ADDRESS.match(address):
        logger.warning("ZKP service reported a DUST address that is not one; left out")
        return None
    balance = reported.get("balance")
    if balance is not None and not (isinstance(balance, str) and _SPECKS.match(balance)):
        logger.warning("ZKP service reported a DUST balance that is not a speck count; left out")
        balance = None
    return DustStatus(address=address, balance=balance)


def _reason(exc: Exception) -> str:
    """Render a probe failure for the status payload."""
    return str(exc) or "unreachable"
