"""Freehold agent entry point: serves the FastAPI coordination app via uvicorn."""

from __future__ import annotations

import uvicorn

from freehold_agent.api import create_app
from freehold_agent.config import AgentConfig


def main() -> None:
    """Start the agent's HTTP server where the configuration says."""
    config = AgentConfig.from_env()
    uvicorn.run(create_app(config), host=config.host, port=config.port)


if __name__ == "__main__":
    main()
