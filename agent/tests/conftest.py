"""Shared fixtures: the agent's tests read a clean environment."""

import os

import pytest

from freehold_agent.config import RETIRED_ENV_NAMES


@pytest.fixture(autouse=True)
def _clean_agent_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """Clear every variable the agent reads, or refuses, so a developer's shell
    cannot change what a test sees."""
    for name in list(os.environ):
        if name.startswith("FREEHOLD_") or name in RETIRED_ENV_NAMES:
            monkeypatch.delenv(name, raising=False)
