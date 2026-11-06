"""Freehold agent entry point: serves the FastAPI coordination app via uvicorn."""

from __future__ import annotations

import uvicorn

from freehold_agent.api import create_app
from freehold_agent.config import AgentConfig


def serve(config: AgentConfig) -> None:
    """Serve the coordination API over TLS where the configuration says.

    Raises:
        ValueError: If the configuration names no certificate and key to
            serve with; the API is never served in cleartext.
    """
    if config.tls_cert_file is None or config.tls_key_file is None:
        raise ValueError(
            "FREEHOLD_TLS_CERT_FILE and FREEHOLD_TLS_KEY_FILE must name the agent's "
            "certificate and key: the API is served over TLS only"
        )
    uvicorn.run(
        create_app(config),
        host=config.host,
        port=config.port,
        ssl_certfile=config.tls_cert_file,
        ssl_keyfile=config.tls_key_file,
    )


def main() -> None:
    """Start the agent from the environment, or say in one line why it cannot."""
    try:
        serve(AgentConfig.from_env())
    except ValueError as exc:
        raise SystemExit(f"freehold-agent: {exc}") from exc


if __name__ == "__main__":
    main()
