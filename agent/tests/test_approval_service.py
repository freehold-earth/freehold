from datetime import UTC, datetime, timedelta

import pytest

from freehold_agent.coordination import (
    ApprovalMode,
    DecisionOutcome,
    RequestStatus,
    VerificationClaim,
    VerificationRequest,
)
from freehold_agent.policy import PolicyCheckResult
from freehold_agent.services.approval import ApprovalService, resolved_status_for, status_for
from freehold_agent.spal import RequestContext


class FakePolicy:
    def __init__(self, result: PolicyCheckResult) -> None:
        self._result = result
        self.scopes: list[str | None] = []

    async def check(self, policy_id, query, context_scope=None, request_context=None):
        self.scopes.append(context_scope)
        return self._result


class FakeBuilder:
    def build(self, request):
        return RequestContext()


class FakeData:
    def __init__(self, data=None, fail=False):
        self._data = data or {"birthDate": "2000-01-01"}
        self._fail = fail
        self.scopes: list[str | None] = []

    async def fetch(self, scope):
        self.scopes.append(scope)
        if self._fail:
            from freehold_agent.errors import ContextUnavailable

            raise ContextUnavailable("no data")
        return self._data


class FakeZKP:
    """Proves everything; its proof names whatever requesterDid it was sent, like the age proof."""

    def __init__(self, verified=True, fail=False, names_requester=True):
        self._verified = verified
        self._fail = fail
        self._names_requester = names_requester
        self.calls: list[tuple[str, dict]] = []

    async def generate(self, proof_type, proof_data):
        self.calls.append((proof_type, dict(proof_data)))
        if self._fail:
            from freehold_agent.errors import ZKPUnavailable

            raise ZKPUnavailable("down")
        from freehold_agent.zkp import ZKPResult

        signals: dict[str, object] = {"verified": self._verified}
        if self._names_requester and "requesterDid" in proof_data:
            signals["requesterDid"] = proof_data["requesterDid"]
        return ZKPResult(verified=self._verified, proof={"ok": True, "publicSignals": signals})


def _req(minutes_valid: int = 5) -> VerificationRequest:
    now = datetime.now(UTC)
    return VerificationRequest(
        id="a",
        business_id="biz",
        business_name="Biz",
        claim=VerificationClaim(type="age", params={"minAge": 18}),
        policy_id="p1",
        context_scope="health/age",
        created_at=now,
        expires_at=now + timedelta(minutes=minutes_valid),
    )


def _svc(policy, data=None, zkp=None) -> ApprovalService:
    return ApprovalService(policy, FakeBuilder(), data or FakeData(), zkp or FakeZKP())


async def test_conclusive_allow_and_verified_proof_approves():
    policy = FakePolicy(PolicyCheckResult(allowed=True, matched_rule_id="r1"))
    decision = await _svc(policy).decide(_req())
    assert decision.outcome is DecisionOutcome.APPROVE
    assert decision.proof is not None and decision.proof["ok"] is True


class BoomData:
    """Fetch fake that fails loudly if reached: a deny must fetch no private data."""

    async def fetch(self, scope):
        raise AssertionError("must not fetch private data on a deny")


class BoomZKP:
    """Generate fake that fails loudly if reached: a deny must generate no proof."""

    async def generate(self, proof_type, proof_data):
        raise AssertionError("must not generate a proof on a deny")


async def test_default_allow_without_matched_rule_does_not_approve():
    # Fail-closed: allowed=True but no rule matched must NOT auto-approve.
    policy = FakePolicy(PolicyCheckResult(allowed=True, matched_rule_id=None))
    decision = await _svc(policy, data=BoomData(), zkp=BoomZKP()).decide(_req())
    assert decision.outcome is DecisionOutcome.DENY


async def test_policy_denied_denies():
    policy = FakePolicy(PolicyCheckResult(allowed=False, matched_rule_id="r1", reason="no"))
    decision = await _svc(policy, data=BoomData(), zkp=BoomZKP()).decide(_req())
    assert decision.outcome is DecisionOutcome.DENY


async def test_allowed_but_proof_fails_rejects():
    policy = FakePolicy(PolicyCheckResult(allowed=True, matched_rule_id="r1"))
    decision = await _svc(policy, zkp=FakeZKP(verified=False)).decide(_req())
    assert decision.outcome is DecisionOutcome.REJECT


async def test_context_unavailable_errors_with_the_cause_logged_not_stored(
    caplog: pytest.LogCaptureFixture,
) -> None:
    policy = FakePolicy(PolicyCheckResult(allowed=True, matched_rule_id="r1"))
    with caplog.at_level("WARNING"):
        decision = await _svc(policy, data=FakeData(fail=True)).decide(_req())
    assert decision.outcome is DecisionOutcome.ERROR
    assert decision.reason == "private data unavailable"
    assert "request a: no data" in caplog.text


async def test_only_the_fields_the_claim_needs_reach_the_proof() -> None:
    policy = FakePolicy(PolicyCheckResult(allowed=True, matched_rule_id="r1"))
    zkp = FakeZKP()
    data = FakeData({"birthDate": "2000-01-01", "fullName": "Alice Demo"})
    decision = await _svc(policy, data=data, zkp=zkp).decide(_req())
    assert decision.outcome is DecisionOutcome.APPROVE
    assert zkp.calls == [("age", {"minAge": 18, "birthDate": "2000-01-01"})]


async def test_the_claim_type_not_the_business_chooses_the_scope_checked_and_read() -> None:
    policy = FakePolicy(PolicyCheckResult(allowed=True, matched_rule_id="r1"))
    data = FakeData()
    req = _req()
    req.context_scope = "root/identity"
    await _svc(policy, data=data).decide(req)
    await _svc(BoomPolicy(), data=data).approve(req)
    assert policy.scopes == ["personal/age"]
    assert data.scopes == ["personal/age", "personal/age"]


async def test_a_business_cannot_supply_the_private_field_itself() -> None:
    policy = FakePolicy(PolicyCheckResult(allowed=True, matched_rule_id="r1"))
    zkp = FakeZKP()
    req = _req()
    req.claim.params["birthDate"] = "1900-01-01"
    await _svc(policy, zkp=zkp).decide(req)
    assert zkp.calls[0][1]["birthDate"] == "2000-01-01"


async def test_missing_required_field_errors_without_telling_the_business_which(
    caplog: pytest.LogCaptureFixture,
) -> None:
    policy = FakePolicy(PolicyCheckResult(allowed=True, matched_rule_id="r1"))
    with caplog.at_level("WARNING"):
        decision = await _svc(policy, data=FakeData({"fullName": "Alice"})).decide(_req())
    assert decision.outcome is DecisionOutcome.ERROR
    assert decision.reason == "private data unavailable"
    assert "missing birthDate" in caplog.text
    blank = await _svc(policy, data=FakeData({"birthDate": ""})).decide(_req())
    assert blank.outcome is DecisionOutcome.ERROR


async def test_unsupported_claim_type_denies_before_reading_data() -> None:
    policy = FakePolicy(PolicyCheckResult(allowed=True, matched_rule_id="r1"))
    req = _req()
    req.claim = VerificationClaim(type="income", params={})
    decision = await _svc(policy, data=BoomData(), zkp=BoomZKP()).decide(req)
    assert decision.outcome is DecisionOutcome.DENY
    assert decision.reason == "unsupported claim type: income"


async def test_zkp_unavailable_errors():
    policy = FakePolicy(PolicyCheckResult(allowed=True, matched_rule_id="r1"))
    decision = await _svc(policy, zkp=FakeZKP(fail=True)).decide(_req())
    assert decision.outcome is DecisionOutcome.ERROR


async def test_expired_request_denies_without_calling_policy():
    class Boom:
        async def check(self, *a, **k):
            raise AssertionError("policy must not be consulted for expired request")

    decision = await _svc(Boom()).decide(_req(minutes_valid=-1))
    assert decision.outcome is DecisionOutcome.DENY


async def test_missing_policy_id_denies_without_calling_policy():
    class Boom:
        async def check(self, *a, **k):
            raise AssertionError("policy must not be consulted with no policy_id")

    request = _req()
    request.policy_id = None
    decision = await _svc(Boom()).decide(request)
    assert decision.outcome is DecisionOutcome.DENY


@pytest.mark.parametrize(
    "outcome,mode,expected",
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


class BoomPolicy:
    """Policy fake that fails loudly if reached: approve() must never consult policy."""

    async def check(self, *a, **k):
        raise AssertionError("must not consult policy on a manual approve")


async def test_approve_generates_proof_verified():
    svc = _svc(BoomPolicy(), zkp=FakeZKP(verified=True))
    decision = await svc.approve(_req())
    assert decision.outcome is DecisionOutcome.APPROVE
    assert decision.reason == "verified"
    assert decision.proof is not None and decision.proof["ok"] is True
    assert decision.matched_rule_id is None


async def test_approve_unverified_rejects():
    svc = _svc(BoomPolicy(), zkp=FakeZKP(verified=False))
    decision = await svc.approve(_req())
    assert decision.outcome is DecisionOutcome.REJECT
    assert decision.reason == "criteria not met"


async def test_approve_zkp_unavailable_errors():
    svc = _svc(BoomPolicy(), zkp=FakeZKP(fail=True))
    decision = await svc.approve(_req())
    assert decision.outcome is DecisionOutcome.ERROR
    assert decision.reason == "verification unavailable"


async def test_approve_context_unavailable_errors():
    svc = _svc(BoomPolicy(), data=FakeData(fail=True))
    decision = await svc.approve(_req())
    assert decision.outcome is DecisionOutcome.ERROR
    assert decision.reason == "private data unavailable"


async def test_approve_unsupported_claim_type_denies_without_fetching() -> None:
    req = _req()
    req.claim = VerificationClaim(type="income", params={})
    decision = await _svc(BoomPolicy(), data=BoomData(), zkp=BoomZKP()).approve(req)
    assert decision.outcome is DecisionOutcome.DENY
    assert decision.reason == "unsupported claim type: income"


async def test_approve_expired_request_denies_without_fetching():
    # Fail-closed: an expired request must not fetch private data or generate a proof.
    svc = _svc(BoomPolicy(), data=BoomData(), zkp=BoomZKP())
    decision = await svc.approve(_req(minutes_valid=-1))
    assert decision.outcome is DecisionOutcome.DENY
    assert decision.reason == "request expired"


@pytest.mark.parametrize(
    "outcome,expected",
    [
        (DecisionOutcome.APPROVE, RequestStatus.APPROVED),
        (DecisionOutcome.REJECT, RequestStatus.REJECTED),
        (DecisionOutcome.ERROR, RequestStatus.ERROR),
        (DecisionOutcome.DENY, RequestStatus.DENIED),
    ],
)
def test_resolved_status_for_never_escalates(outcome, expected):
    # A human's decision is terminal: DENY must resolve to DENIED, never ESCALATED.
    assert resolved_status_for(outcome) is expected


async def test_approve_names_the_users_ephemeral_did_in_the_proof() -> None:
    zkp = FakeZKP()
    decision = await _svc(BoomPolicy(), zkp=zkp).approve(_req(), "did:key:z6MkEphemeral")
    assert decision.outcome is DecisionOutcome.APPROVE
    assert decision.requester_did == "did:key:z6MkEphemeral"
    assert zkp.calls == [
        ("age", {"minAge": 18, "birthDate": "2000-01-01", "requesterDid": "did:key:z6MkEphemeral"})
    ]


async def test_approve_without_a_did_and_the_autonomous_path_name_nothing() -> None:
    zkp = FakeZKP()
    human = await _svc(BoomPolicy(), zkp=zkp).approve(_req())
    policy = FakePolicy(PolicyCheckResult(allowed=True, matched_rule_id="r1"))
    autonomous = await _svc(policy, zkp=zkp).decide(_req())
    assert human.requester_did is None and autonomous.requester_did is None
    assert all("requesterDid" not in sent for _, sent in zkp.calls)


async def test_only_listed_claim_params_reach_the_proof() -> None:
    zkp = FakeZKP()
    req = _req()
    req.claim.params.update({"requesterDid": "did:key:z6MkBusiness", "currentDate": "1900-01-01"})
    await _svc(BoomPolicy(), zkp=zkp).approve(req)
    assert zkp.calls == [("age", {"minAge": 18, "birthDate": "2000-01-01"})]


async def test_a_proof_naming_a_did_nobody_asked_for_is_not_stored(
    caplog: pytest.LogCaptureFixture,
) -> None:
    class Chatty(FakeZKP):
        async def generate(self, proof_type, proof_data):
            result = await super().generate(proof_type, proof_data)
            result.proof["publicSignals"]["requesterDid"] = "did:key:z6MkStale"
            return result

    with caplog.at_level("ERROR"):
        decision = await _svc(BoomPolicy(), zkp=Chatty()).approve(_req())
    assert decision.outcome is DecisionOutcome.ERROR
    assert decision.proof is None and decision.requester_did is None
    assert "proof names 'did:key:z6MkStale', not the None" in caplog.text


async def test_a_proof_that_does_not_name_the_attested_did_is_not_stored(
    caplog: pytest.LogCaptureFixture,
) -> None:
    zkp = FakeZKP(names_requester=False)
    with caplog.at_level("ERROR"):
        decision = await _svc(BoomPolicy(), zkp=zkp).approve(_req(), "did:key:z6MkUsers")
    assert decision.outcome is DecisionOutcome.ERROR
    assert decision.reason == "verification unavailable"
    assert decision.proof is None
    assert "proof names None, not the 'did:key:z6MkUsers'" in caplog.text
