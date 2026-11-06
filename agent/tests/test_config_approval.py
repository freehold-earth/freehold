import pytest

from freehold_agent.config import AgentConfig
from freehold_agent.coordination import ApprovalMode


def test_default_mode_is_manual():
    assert AgentConfig().approval.mode is ApprovalMode.MANUAL


def test_mode_from_env(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("FREEHOLD_APPROVAL_MODE", "fully_autonomous")
    assert AgentConfig.from_env().approval.mode is ApprovalMode.FULLY_AUTONOMOUS


def test_a_mode_outside_the_set_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    """A typo must not run the agent in manual mode without a word."""
    monkeypatch.setenv("FREEHOLD_APPROVAL_MODE", "bogus")
    with pytest.raises(ValueError, match="FREEHOLD_APPROVAL_MODE must be one of"):
        AgentConfig.from_env()
