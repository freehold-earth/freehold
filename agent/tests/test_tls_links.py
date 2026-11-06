"""The agent's links against certificates from the stack's own CA.

``infra/scripts/certs.sh`` writes the CA and a certificate per service; the
agent trusts the CA through one setting and refuses anything it did not
sign. This runs the script and speaks to a server holding one of its
certificates, so the script, the trust store and the clients are checked
together rather than each against a stub of the others.
"""

from __future__ import annotations

import http.server
import json
import shutil
import ssl
import subprocess
import threading
from collections.abc import Iterator
from pathlib import Path

import httpx2
import pytest

from freehold_agent.__main__ import main
from freehold_agent.config import trust_store
from freehold_agent.status import StatusClient

CERTS_SH = Path(__file__).resolve().parents[2] / "infra" / "scripts" / "certs.sh"

pytestmark = pytest.mark.skipif(
    shutil.which("openssl") is None or shutil.which("bash") is None or not CERTS_SH.exists(),
    reason="needs openssl, bash and infra/scripts/certs.sh",
)


class _Health(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 (the stdlib's name)
        body = json.dumps({"status": "healthy"}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_: object) -> None:
        return


@pytest.fixture(scope="module")
def certs(tmp_path_factory: pytest.TempPathFactory) -> Path:
    """A directory the stack's script filled: the CA and the zkp service's certificate."""
    directory = tmp_path_factory.mktemp("stack-certs")
    subprocess.run(["bash", str(CERTS_SH), str(directory), "zkp"], check=True, capture_output=True)
    return directory


@pytest.fixture(scope="module")
def tls_server(certs: Path) -> Iterator[str]:
    """A server on loopback holding the zkp certificate; yields its https:// address."""
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Health)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certs / "zkp.crt", certs / "zkp.key")
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"https://127.0.0.1:{server.server_address[1]}"
    finally:
        server.shutdown()
        server.server_close()


async def test_the_ca_file_trusts_the_stack(certs: Path, tls_server: str) -> None:
    async with httpx2.AsyncClient(verify=trust_store(str(certs / "ca.crt"))) as client:
        response = await client.get(f"{tls_server}/health")
    assert response.status_code == 200


async def test_without_the_ca_file_the_stack_is_refused(tls_server: str) -> None:
    async with httpx2.AsyncClient(verify=trust_store(None)) as client:
        with pytest.raises(httpx2.ConnectError):
            await client.get(f"{tls_server}/health")


async def test_the_status_probe_reaches_a_service_over_tls(certs: Path, tls_server: str) -> None:
    client = StatusClient(
        agent_url="https://localhost:8082",
        zkp_url=tls_server,
        cardano_url=tls_server,
        verify=trust_store(str(certs / "ca.crt")),
    )
    try:
        status = await client.check()
    finally:
        await client.aclose()
    assert status.zkp.status == "healthy"


def test_the_api_is_not_served_without_a_certificate(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("FREEHOLD_TLS_CERT_FILE", raising=False)
    monkeypatch.delenv("FREEHOLD_TLS_KEY_FILE", raising=False)
    with pytest.raises(SystemExit, match="FREEHOLD_TLS_CERT_FILE"):
        main()
