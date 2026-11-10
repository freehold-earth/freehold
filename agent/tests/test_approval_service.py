"""The approval service: both decision paths consult the holder's policy, fail closed."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from freehold_agent.coordination import (
    ApprovalMode,
    DecisionOutcome,
    RequestStatus,
    VerificationClaim,
    VerificationRequest,
)
from freehold_agent.custody import Operator
from freehold_agent.errors import ContextUnavailable, ZKPUnavailable
from freehold_agent.policy import (
    GENERIC_DENIAL,
    PolicyChecker,
    PolicyCheckResult,
    Requester,
    StoredPolicy,
)
from freehold_agent.seams import DeterministicContextBuilder
from freehold_agent.services.approval import ApprovalService, resolved_status_for, status_for
from freehold_agent.spal import IdentityType, ProofType, RequestContext, SPALPolicy
from freehold_agent.terms import export_terms, terms_hash
from freehold_agent.zkp import ZKPResult
from tests.fakes import FakeVault

OWNER = "did:key:z6Mkowner"
EPHEMERAL = "did:key:z6Mkephemeral"


def _policy(conditions: dict | None = None, scope: str = "personal/age") -> dict:
    return {
        "version": "1.0",
        "id": f"spal:{OWNER}:age",
        "name": "Age",
        "owner": OWNER,
        "rules": [{"id": "rule-age", "context_scope": scope, "conditions": conditions or {}}],
    }


SEEDED = _policy(
    {
        "identity": {"type": "ephemeral_required"},
        "proofs": [{"type": "zkp", "claim": "age"}],
        "retention": {"max_seconds": 0, "audit_log": True},
        "derivatives": {"training": "forbidden", "aggregation": "forbidden", "resale": "forbidden"},
    }
)
OPEN = _policy({})


def _vault(policy: dict | None = SEEDED) -> FakeVault:
    vault = FakeVault({"root-identity": {"did": OWNER, "publicKey": [1] * 32}})
    if policy is not None:
        vault.put("policies/age", policy)
    return vault


class FakeData:
    def __init__(self, data: dict[str, object] | None = None, fail: bool = False) -> None:
        self._data = data or {"birthDate": "2000-01-01"}
        self._fail = fail
        self.scopes: list[str | None] = []

    async def fetch(self, scope: str | None) -> dict[str, object]:
        self.scopes.append(scope)
        if self._fail:
            raise ContextUnavailable("no data")
        return self._data


class FakeZKP:
    """Proves everything; its proof names whatever requesterDid it was sent, like the age proof."""

    def __init__(
        self, verified: bool = True, fail: bool = False, names_requester: bool = True
    ) -> None:
        self._verified = verified
        self._fail = fail
        self._names_requester = names_requester
        self.calls: list[tuple[str, dict]] = []

    async def generate(self, proof_type: str, proof_data: dict[str, object]) -> ZKPResult:
        self.calls.append((proof_type, dict(proof_data)))
        if self._fail:
            raise ZKPUnavailable("down")
        signals: dict[str, object] = {"verified": self._verified}
        if self._names_requester and "requesterDid" in proof_data:
            signals["requesterDid"] = proof_data["requesterDid"]
        return ZKPResult(verified=self._verified, proof={"ok": True, "publicSignals": signals})


class BoomData:
    """Fetch fake that fails loudly if reached: a deny must fetch no private data."""

    async def fetch(self, scope: str | None) -> dict[str, object]:
        raise AssertionError("must not fetch private data on a deny")


class BoomZKP:
    """Generate fake that fails loudly if reached: a deny must generate no proof."""

    async def generate(self, proof_type: str, proof_data: dict[str, object]) -> ZKPResult:
        raise AssertionError("must not generate a proof on a deny")


def _req(policy: dict = SEEDED, minutes_valid: int = 5, **overrides: object) -> VerificationRequest:
    now = datetime.now(UTC)
    fields: dict = {
        "id": "a",
        "business_id": "biz",
        "business_name": "Biz",
        "claim": VerificationClaim(type="age", params={"minAge": 18}),
        "terms_hash": terms_hash(policy),
        "context_scope": "personal/age",
        "created_at": now,
        "expires_at": now + timedelta(minutes=minutes_valid),
    }
    fields.update(overrides)
    return VerificationRequest(**fields)


def _svc(
    vault: FakeVault | None = None,
    data: FakeData | BoomData | None = None,
    zkp: FakeZKP | BoomZKP | None = None,
    policy: PolicyChecker | FakePolicy | None = None,
) -> ApprovalService:
    checker = policy or PolicyChecker(vault if vault is not None else _vault())
    return ApprovalService(
        checker, DeterministicContextBuilder(), data or FakeData(), zkp or FakeZKP()
    )


# --- decide: the autonomous path ---


async def test_decide_denies_when_terms_match_no_policy():
    decision = await _svc(_vault(OPEN), data=BoomData(), zkp=BoomZKP()).decide(_req(SEEDED))
    assert decision.outcome is DecisionOutcome.DENY
    assert decision.reason == GENERIC_DENIAL
    assert decision.detail == "terms do not match any policy"


async def test_decide_denies_ephemeral_identity_rule_because_autonomous_has_no_did():
    decision = await _svc(data=BoomData(), zkp=BoomZKP()).decide(_req(SEEDED))
    assert decision.outcome is DecisionOutcome.DENY
    assert decision.reason == GENERIC_DENIAL
    assert "Ephemeral identity required" in (decision.detail or "")
    assert decision.matched_rule_id == "rule-age"


async def test_decide_approves_a_policy_without_identity_condition():
    decision = await _svc(_vault(OPEN)).decide(_req(OPEN))
    assert decision.outcome is DecisionOutcome.APPROVE
    assert decision.matched_rule_id == "rule-age"
    assert decision.proof is not None and decision.proof["ok"] is True
    assert decision.detail is None


async def test_decide_states_the_claims_proof_so_a_proof_rule_passes():
    policy = _policy({"proofs": [{"type": "zkp", "claim": "age"}]})
    decision = await _svc(_vault(policy)).decide(_req(policy))
    assert decision.outcome is DecisionOutcome.APPROVE


async def test_decide_no_rule_for_the_claims_scope_denies():
    policy = _policy({}, scope="personal/email")
    decision = await _svc(_vault(policy), data=BoomData(), zkp=BoomZKP()).decide(_req(policy))
    assert decision.outcome is DecisionOutcome.DENY
    assert "personal/age" in (decision.detail or "")


async def test_context_unavailable_while_reading_the_policy_errors():
    vault = _vault(OPEN)
    vault.error = ContextUnavailable("context store locked")
    decision = await _svc(vault, data=BoomData(), zkp=BoomZKP()).decide(_req(OPEN))
    assert decision.outcome is DecisionOutcome.ERROR
    assert decision.reason == "private data unavailable"


class FakePolicy:
    """A checker whose check returns what it is told; for the fail-closed invariant."""

    def __init__(self, result: PolicyCheckResult) -> None:
        self._result = result

    async def policy_named(self, name: str) -> StoredPolicy:
        raise AssertionError("not used")

    async def policy_for_terms(self, terms: str) -> StoredPolicy:
        return StoredPolicy(
            document=OPEN,
            policy=SPALPolicy.model_validate(OPEN),
            terms=export_terms(OPEN),
            terms_hash=terms_hash(OPEN),
        )

    async def check(
        self,
        policy: SPALPolicy,
        context_scope: str,
        request_context: RequestContext,
        requester: Requester,
        *,
        custody: Operator,
    ) -> PolicyCheckResult:
        return self._result


async def test_a_denial_with_no_rule_does_not_approve() -> None:
    # Fail-closed: the only result without a rule is a denial, and it must not approve.
    policy = FakePolicy(PolicyCheckResult(allowed=False, reason=GENERIC_DENIAL, detail="no rule"))
    decision = await _svc(policy=policy, data=BoomData(), zkp=BoomZKP()).decide(_req(OPEN))
    assert decision.outcome is DecisionOutcome.DENY
    assert decision.detail == "no rule"


async def test_allowed_but_proof_fails_rejects():
    decision = await _svc(_vault(OPEN), zkp=FakeZKP(verified=False)).decide(_req(OPEN))
    assert decision.outcome is DecisionOutcome.REJECT


async def test_context_unavailable_errors_with_the_cause_logged_not_stored(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level("WARNING"):
        decision = await _svc(_vault(OPEN), data=FakeData(fail=True)).decide(_req(OPEN))
    assert decision.outcome is DecisionOutcome.ERROR
    assert decision.reason == "private data unavailable"
    assert "no data" in caplog.text


async def test_only_the_fields_the_claim_needs_reach_the_proof() -> None:
    data = FakeData({"birthDate": "2000-01-01", "fullName": "Alice", "ssn": "123"})
    zkp = FakeZKP()
    decision = await _svc(_vault(OPEN), data=data, zkp=zkp).decide(_req(OPEN))
    assert decision.outcome is DecisionOutcome.APPROVE
    assert zkp.calls == [("age", {"minAge": 18, "birthDate": "2000-01-01"})]


async def test_the_claim_type_not_the_business_chooses_the_scope_checked_and_read() -> None:
    data = FakeData()
    req = _req(OPEN, context_scope="medical/everything")
    await _svc(_vault(OPEN), data=data).decide(req)
    await _svc(_vault(OPEN), data=data).approve(req, EPHEMERAL)
    assert data.scopes == ["personal/age", "personal/age"]


async def test_a_business_cannot_supply_the_private_field_itself() -> None:
    zkp = FakeZKP()
    req = _req(OPEN, claim=VerificationClaim(type="age", params={"minAge": 18, "birthDate": "x"}))
    await _svc(_vault(OPEN), zkp=zkp).decide(req)
    assert zkp.calls[0][1]["birthDate"] == "2000-01-01"


async def test_missing_required_field_errors_without_telling_the_business_which(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level("WARNING"):
        decision = await _svc(_vault(OPEN), data=FakeData({"fullName": "Alice"})).decide(_req(OPEN))
    assert decision.outcome is DecisionOutcome.ERROR
    assert decision.reason == "private data unavailable"
    assert "birthDate" in caplog.text


async def test_unsupported_claim_type_denies_before_reading_data() -> None:
    req = _req(OPEN, claim=VerificationClaim(type="income", params={}))
    vault = _vault(OPEN)
    decision = await _svc(vault, data=BoomData(), zkp=BoomZKP()).decide(req)
    assert decision.outcome is DecisionOutcome.DENY
    assert vault.reads == []


async def test_zkp_unavailable_errors():
    decision = await _svc(_vault(OPEN), zkp=FakeZKP(fail=True)).decide(_req(OPEN))
    assert decision.outcome is DecisionOutcome.ERROR


async def test_expired_request_denies_without_calling_policy():
    vault = _vault(OPEN)
    decision = await _svc(vault).decide(_req(OPEN, minutes_valid=-1))
    assert decision.outcome is DecisionOutcome.DENY
    assert vault.reads == []


@pytest.mark.parametrize(
    ("outcome", "mode", "expected"),
    [
        (DecisionOutcome.APPROVE, ApprovalMode.FULLY_AUTONOMOUS, RequestStatus.APPROVED),
        (DecisionOutcome.REJECT, ApprovalMode.FULLY_AUTONOMOUS, RequestStatus.REJECTED),
        (DecisionOutcome.ERROR, ApprovalMode.FULLY_AUTONOMOUS, RequestStatus.ERROR),
        (DecisionOutcome.DENY, ApprovalMode.FULLY_AUTONOMOUS, RequestStatus.DENIED),
        (DecisionOutcome.DENY, ApprovalMode.AUTO_WITH_NOTIFICATION, RequestStatus.ESCALATED),
    ],
)
def test_status_for(outcome, mode, expected):
    assert status_for(outcome, mode) is expected


# --- approve: the button path ---


async def test_approve_consults_the_policy_with_the_did():
    zkp = FakeZKP()
    decision = await _svc(zkp=zkp).approve(_req(SEEDED), EPHEMERAL)
    assert decision.outcome is DecisionOutcome.APPROVE
    assert decision.matched_rule_id == "rule-age"
    assert decision.requester_did == EPHEMERAL
    assert zkp.calls[0][1]["requesterDid"] == EPHEMERAL


async def test_approve_without_a_did_under_an_ephemeral_rule_denies():
    decision = await _svc(data=BoomData(), zkp=BoomZKP()).approve(_req(SEEDED), None)
    assert decision.outcome is DecisionOutcome.DENY
    assert decision.reason == GENERIC_DENIAL
    assert "Ephemeral identity required" in (decision.detail or "")


async def test_approve_denied_by_policy_generates_no_proof():
    decision = await _svc(_vault(OPEN), data=BoomData(), zkp=BoomZKP()).approve(
        _req(SEEDED), EPHEMERAL
    )
    assert decision.outcome is DecisionOutcome.DENY
    assert decision.detail == "terms do not match any policy"


async def test_approve_unverified_rejects():
    decision = await _svc(zkp=FakeZKP(verified=False)).approve(_req(SEEDED), EPHEMERAL)
    assert decision.outcome is DecisionOutcome.REJECT


async def test_approve_zkp_unavailable_errors():
    decision = await _svc(zkp=FakeZKP(fail=True)).approve(_req(SEEDED), EPHEMERAL)
    assert decision.outcome is DecisionOutcome.ERROR


async def test_approve_context_unavailable_errors():
    decision = await _svc(data=FakeData(fail=True)).approve(_req(SEEDED), EPHEMERAL)
    assert decision.outcome is DecisionOutcome.ERROR


async def test_approve_unsupported_claim_type_denies_without_fetching() -> None:
    req = _req(SEEDED, claim=VerificationClaim(type="income", params={}))
    decision = await _svc(data=BoomData(), zkp=BoomZKP()).approve(req, EPHEMERAL)
    assert decision.outcome is DecisionOutcome.DENY


async def test_approve_expired_request_denies_without_fetching():
    decision = await _svc(data=BoomData(), zkp=BoomZKP()).approve(
        _req(SEEDED, minutes_valid=-1), EPHEMERAL
    )
    assert decision.outcome is DecisionOutcome.DENY


async def test_a_proof_naming_another_did_is_not_stored():
    class WrongNameZKP(FakeZKP):
        async def generate(self, proof_type: str, proof_data: dict[str, object]) -> ZKPResult:
            proof_data = {**proof_data, "requesterDid": "did:key:z6Mkother"}
            return await super().generate(proof_type, proof_data)

    decision = await _svc(zkp=WrongNameZKP()).approve(_req(SEEDED), EPHEMERAL)
    assert decision.outcome is DecisionOutcome.ERROR
    assert decision.proof is None


@pytest.mark.parametrize(
    ("outcome", "expected"),
    [
        (DecisionOutcome.APPROVE, RequestStatus.APPROVED),
        (DecisionOutcome.REJECT, RequestStatus.REJECTED),
        (DecisionOutcome.ERROR, RequestStatus.ERROR),
        (DecisionOutcome.DENY, RequestStatus.DENIED),
    ],
)
def test_resolved_status_for(outcome, expected):
    assert resolved_status_for(outcome) is expected


# --- the deterministic builder ---


def test_builder_states_the_did_when_given():
    ctx = DeterministicContextBuilder().build(_req(SEEDED), EPHEMERAL)
    assert ctx.identity is not None
    assert ctx.identity.type is IdentityType.EPHEMERAL_REQUIRED
    assert ctx.identity.did == EPHEMERAL


def test_builder_states_no_identity_without_a_did():
    ctx = DeterministicContextBuilder().build(_req(SEEDED), None)
    assert ctx.identity is None
    assert ctx.intended_use is None
    assert ctx.offered_retention_seconds is None


def test_builder_states_the_claims_proof():
    ctx = DeterministicContextBuilder().build(_req(SEEDED), None)
    assert [(p.type, p.claim) for p in ctx.proofs] == [(ProofType.ZKP, "age")]
    assert isinstance(ctx, RequestContext)


# --- Custody on the proof path ---

DEVICE_ONLY = _policy({"custody": {"operator": "device_only"}})
DEVICE_ONLY["version"] = "1.1"


async def test_a_proof_service_further_than_the_ceiling_denies() -> None:
    svc = ApprovalService(
        PolicyChecker(_vault(DEVICE_ONLY)),
        DeterministicContextBuilder(),
        BoomData(),
        BoomZKP(),
        zkp_custody=Operator.FEDERATED_OPERATOR,
    )
    decision = await svc.approve(_req(DEVICE_ONLY), EPHEMERAL)
    assert decision.outcome is DecisionOutcome.DENY
    assert "custody" in (decision.detail or "")


async def test_a_proof_service_within_the_ceiling_approves() -> None:
    svc = ApprovalService(
        PolicyChecker(_vault(DEVICE_ONLY)),
        DeterministicContextBuilder(),
        FakeData(),
        FakeZKP(),
        zkp_custody=Operator.DEVICE_ONLY,
    )
    decision = await svc.approve(_req(DEVICE_ONLY), EPHEMERAL)
    assert decision.outcome is DecisionOutcome.APPROVE


async def test_the_proof_service_defaults_to_the_holders_own_hardware() -> None:
    decision = await _svc(_vault(OPEN)).approve(_req(OPEN), EPHEMERAL)
    assert decision.outcome is DecisionOutcome.APPROVE


async def test_a_stricter_sibling_rule_in_the_domain_does_not_hold_an_approval_back() -> None:
    """Proof inputs come from the claim's scope alone; a rule for another scope has no say."""
    policy = _policy({"custody": {"operator": "federated_operator"}})
    policy["version"] = "1.1"
    policy["rules"].append(
        {"id": "rule-health", "context_scope": "personal/health", "conditions": {}}
    )
    svc = ApprovalService(
        PolicyChecker(_vault(policy)),
        DeterministicContextBuilder(),
        FakeData(),
        FakeZKP(),
        zkp_custody=Operator.FEDERATED_OPERATOR,
    )
    decision = await svc.approve(_req(policy), EPHEMERAL)
    assert decision.outcome is DecisionOutcome.APPROVE
