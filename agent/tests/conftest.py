"""Shared fixtures: the agent's unit tests read a clean environment."""

import os
from pathlib import Path

import pytest

from freehold_agent.config import RETIRED_ENV_NAMES

# The live smoke tests are configured through the environment on purpose.
_LIVE_MARKERS = ("openai", "ollama")


@pytest.fixture(autouse=True)
def _clean_agent_environment(
    request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Clear every variable the agent reads, or refuses, and work in a fresh directory.

    A developer's shell then cannot change what a unit test sees, and a
    file the agent writes beside itself, the audit log, lands in the test's
    own directory; the live smoke tests keep their environment, since it is
    how they are pointed at a server.
    """
    if any(request.node.get_closest_marker(name) for name in _LIVE_MARKERS):
        return
    monkeypatch.chdir(tmp_path)
    for name in list(os.environ):
        if name.startswith("FREEHOLD_") or name in RETIRED_ENV_NAMES:
            monkeypatch.delenv(name, raising=False)
