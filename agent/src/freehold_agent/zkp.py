"""HTTP client for the PCI ZKP service.

Replaces the urllib call in the old server with an injectable httpx2 client so
the approval flow can be tested against a fake transport.
"""

from __future__ import annotations

import httpx2
from pydantic import BaseModel, Field

from freehold_agent.errors import ZKPUnavailable


class ZKPResult(BaseModel):
    """Outcome of a proof-generation request."""

    verified: bool
    proof: dict[str, object] = Field(default_factory=dict)


def _payment_required_message(response: httpx2.Response) -> str:
    """The service's own account of why it cannot pay, or a generic one."""
    try:
        payload = response.json()
    except ValueError:
        payload = None
    error = payload.get("error") if isinstance(payload, dict) else None
    address = payload.get("dustAddress") if isinstance(payload, dict) else None
    message = "verification service cannot pay for proofs"
    if isinstance(error, str) and error:
        message = f"{message}: {error}"
    if isinstance(address, str) and address and address not in message:
        message = f"{message} (sponsor DUST generation to {address})"
    return message


class ZKPClient:
    """Generates zero-knowledge proofs via the PCI ZKP service."""

    def __init__(self, base_url: str, *, client: httpx2.AsyncClient | None = None) -> None:
        self._owns_client = client is None
        self._client = client or httpx2.AsyncClient(base_url=base_url, timeout=30.0)

    async def generate(self, proof_type: str, proof_data: dict[str, object]) -> ZKPResult:
        """Request a proof of the given type.

        Args:
            proof_type: The kind of proof to request (e.g. ``"age"``).
            proof_data: Claim-specific parameters sent as the request body.

        Returns:
            The verification outcome and raw proof payload.

        Raises:
            ZKPUnavailable: If the service cannot be reached, returns an error, or
                returns a response whose shape does not match the expected schema.
                When the service cannot pay for proofs it says so and names the
                DUST address a sponsor should fund, which the message carries.
        """
        try:
            response = await self._client.post(f"/proofs/{proof_type}", json=proof_data)
        except httpx2.HTTPError as exc:
            raise ZKPUnavailable("verification service unavailable") from exc

        if response.status_code == 402:
            raise ZKPUnavailable(_payment_required_message(response))

        try:
            response.raise_for_status()
            payload = response.json()
        except (httpx2.HTTPError, ValueError) as exc:
            raise ZKPUnavailable("verification service unavailable") from exc

        if not isinstance(payload, dict):
            raise ZKPUnavailable("verification service unavailable")

        proof = payload.get("proof", {})
        if not isinstance(proof, dict):
            raise ZKPUnavailable("verification service unavailable")

        signals = proof.get("publicSignals", {})
        verified = bool(signals.get("verified", False)) if isinstance(signals, dict) else False
        return ZKPResult(verified=verified, proof=proof)

    async def aclose(self) -> None:
        """Close the underlying client if this instance owns it."""
        if self._owns_client:
            await self._client.aclose()
