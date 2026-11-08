"""S-PAL policy loading from the vault and condition evaluation."""

import json
from pathlib import Path

import pytest
from pydantic import BaseModel

import freehold_agent.spal as spal
from freehold_agent.custody import Operator
from freehold_agent.errors import ContextUnavailable, PolicyRefused
from freehold_agent.policy import (
    GENERIC_DENIAL,
    PolicyChecker,
    PolicyCheckResult,
    Requester,
    policy_key,
)
from freehold_agent.spal import (
    AvailableProof,
    IdentityLinkage,
    IdentityRequirement,
    IdentityType,
    IntendedUse,
    ProofType,
    RequestContext,
    RequestIdentity,
    SPALModel,
    SPALPolicy,
)
from freehold_agent.terms import terms_hash
from tests.fakes import FakeVault

OWNER = "did:key:z6Mktest"
ROOT_IDENTITY = {"did": OWNER, "publicKey": [1] * 32, "createdAt": "2026-11-07T00:00:00Z"}

# --- Helpers ---


def _policy_dict(
    rules: list[dict],
    name: str = "test-policy",
    owner: str = OWNER,
) -> dict:
    return {
        "version": "1.0",
        "id": f"spal:{owner}:{name}",
        "name": "Test Policy",
        "owner": owner,
        "rules": rules,
    }


def _rule_dict(
    rule_id: str = "rule-1",
    scope: str = "test/data",
    conditions: dict | None = None,
) -> dict:
    return {
        "id": rule_id,
        "context_scope": scope,
        "conditions": conditions or {},
    }


def _derivs(
    training: str = "forbidden",
    aggregation: str = "forbidden",
    resale: str = "forbidden",
) -> dict:
    return {
        "training": training,
        "aggregation": aggregation,
        "resale": resale,
    }


def _policy(rules: list[dict]) -> SPALPolicy:
    return SPALPolicy.model_validate(_policy_dict(rules))


def _vault(*policies: dict, root: dict | None = ROOT_IDENTITY) -> FakeVault:
    vault = FakeVault()
    if root is not None:
        vault.put("root-identity", root)
    for policy in policies:
        vault.put(policy_key(policy["id"].rsplit(":", 1)[1]), policy)
    return vault


async def _check(
    rules: list[dict],
    scope: str = "test/data",
    ctx: RequestContext | None = None,
    requester: Requester = Requester.THIRD_PARTY,
) -> PolicyCheckResult:
    checker = PolicyChecker(_vault())
    return await checker.check(
        _policy(rules), scope, ctx or RequestContext(), requester, custody=Operator.OWNED_HARDWARE
    )


# --- Realistic policy fixture (based on the spec's health-records example) ---


HEALTH_POLICY_FIXTURE: dict = {
    "version": "1.0",
    "id": "spal:did:key:z6Mkowner123:health-records",
    "name": "Health Records Access Policy",
    "owner": "did:key:z6Mkowner123",
    "rules": [
        {
            "id": "rule-diagnosis",
            "context_scope": "medical/diagnosis_codes",
            "conditions": {
                "identity": {"type": "ephemeral_required", "linkage": "forbidden"},
                "proofs": [{"type": "zkp", "claim": "is_licensed_provider"}],
                "retention": {"max_seconds": 0, "audit_log": True},
                "derivatives": _derivs(),
            },
        },
        {
            "id": "rule-vaccination-status",
            "context_scope": "medical/immunization/status",
            "conditions": {
                "identity": {"type": "ephemeral_required", "linkage": "forbidden"},
                "proofs": [{"type": "zkp", "claim": "has_vaccination"}],
                "retention": {"max_seconds": 3600, "audit_log": True},
                "derivatives": _derivs(aggregation="anonymized_only"),
                "payment": {"protocol": "x402", "amount": 100, "currency": "sats"},
            },
        },
        {
            "id": "rule-allergies",
            "context_scope": "medical/allergies",
            "conditions": {
                "identity": {"type": "ephemeral_required", "linkage": "forbidden"},
                "proofs": [{"type": "zkp", "claim": "has_allergy"}],
                "retention": {"max_seconds": 0, "audit_log": True},
                "derivatives": _derivs(),
            },
        },
    ],
}


# --- Model parsing tests ---


class TestSPALModelParsing:
    def test_parse_minimal_policy(self) -> None:
        policy = _policy([_rule_dict()])
        assert policy.version == "1.0"
        assert len(policy.rules) == 1
        assert policy.rules[0].context_scope == "test/data"

    def test_reject_empty_rules(self) -> None:
        with pytest.raises(ValueError):
            _policy([])

    def test_reject_missing_required_fields(self) -> None:
        with pytest.raises(ValueError):
            SPALPolicy.model_validate({"version": "1.0"})

    def test_linkage_string_coercion_forbidden(self) -> None:
        req = IdentityRequirement.model_validate(
            {
                "type": "ephemeral_required",
                "linkage": "forbidden",
            }
        )
        assert req.linkage is not None
        assert req.linkage.ephemeral_required is True
        assert req.linkage.proof_of_root_allowed is False
        assert req.linkage.zk_continuity_allowed is False

    def test_linkage_string_coercion_allowed(self) -> None:
        req = IdentityRequirement.model_validate(
            {
                "type": "persistent_allowed",
                "linkage": "allowed",
            }
        )
        assert req.linkage is not None
        assert req.linkage.ephemeral_required is False
        assert req.linkage.proof_of_root_allowed is True
        assert req.linkage.zk_continuity_allowed is True

    def test_linkage_object_passthrough(self) -> None:
        req = IdentityRequirement.model_validate(
            {
                "type": "ephemeral_required",
                "linkage": {
                    "ephemeral_required": True,
                    "proof_of_root_allowed": True,
                    "zk_continuity_allowed": False,
                },
            }
        )
        assert isinstance(req.linkage, IdentityLinkage)
        assert req.linkage.proof_of_root_allowed is True

    def test_parse_multi_rule_policy_with_all_conditions(self) -> None:
        policy = SPALPolicy.model_validate(HEALTH_POLICY_FIXTURE)
        assert len(policy.rules) == 3
        assert policy.rules[0].context_scope == "medical/diagnosis_codes"
        assert policy.rules[1].conditions.payment is not None
        assert policy.rules[1].conditions.payment.amount == 100


# --- Unknown fields are refused, not ignored ---


SPEC_EXAMPLES_DIR = Path(__file__).parents[2] / "spec/schemas/spal/v1.0/examples"
SPEC_EXAMPLES = sorted(SPEC_EXAMPLES_DIR.glob("*.json"))


class TestUnknownFieldsRefused:
    """A condition the agent cannot enforce must fail loudly at load time.

    The S-PAL 1.0 JSON schema leaves ``conditions`` open so that later
    versions can add conditions. The agent is stricter: a rule carrying a
    condition it does not evaluate would otherwise load and evaluate as if
    the condition were absent, which is the opposite of what the policy says.
    """

    def test_unknown_condition_is_refused_and_named(self) -> None:
        rule = _rule_dict(conditions={"processing": {"locality": "device_only"}})
        with pytest.raises(ValueError, match=r"rules\.0\.conditions\.processing"):
            _policy([rule])

    def test_unknown_key_inside_known_condition_is_refused(self) -> None:
        rule = _rule_dict(conditions={"retention": {"max_seconds": 0, "shred": True}})
        with pytest.raises(ValueError, match=r"rules\.0\.conditions\.retention\.shred"):
            _policy([rule])

    def test_unknown_top_level_field_is_refused(self) -> None:
        policy = _policy_dict([_rule_dict()])
        policy["jurisdiction"] = "CA"
        with pytest.raises(ValueError, match="jurisdiction"):
            SPALPolicy.model_validate(policy)

    def test_every_spal_model_keeps_the_strict_config(self) -> None:
        models = [
            obj
            for obj in vars(spal).values()
            if isinstance(obj, type) and issubclass(obj, BaseModel) and obj is not BaseModel
        ]
        assert len(models) >= 15
        outside = [m.__name__ for m in models if not issubclass(m, SPALModel)]
        assert outside == []
        relaxed = [m.__name__ for m in models if m.model_config.get("extra") != "forbid"]
        assert relaxed == []

    def test_unsupported_version_is_refused_by_version(self) -> None:
        policy = _policy_dict([_rule_dict()])
        policy["version"] = "2.0"
        with pytest.raises(ValueError, match="version"):
            SPALPolicy.model_validate(policy)

    def test_unknown_request_field_is_refused(self) -> None:
        with pytest.raises(ValueError, match="offered_retention_secs"):
            RequestContext.model_validate({"offered_retention_secs": 999})

    def test_request_context_json_schema_forbids_additional_properties(self) -> None:
        schema = RequestContext.model_json_schema()
        assert schema["additionalProperties"] is False
        assert schema["$defs"]["IntendedUse"]["additionalProperties"] is False

    def test_spec_examples_are_present(self) -> None:
        assert SPEC_EXAMPLES, f"no spec examples found under {SPEC_EXAMPLES_DIR}"

    @pytest.mark.parametrize("example", SPEC_EXAMPLES, ids=lambda p: p.name)
    def test_spec_examples_still_load(self, example: Path) -> None:
        policy = SPALPolicy.model_validate_json(example.read_bytes())
        assert policy.rules


# --- Reading policies from the vault ---


class TestPoliciesFromTheVault:
    async def test_policy_named_reads_policies_prefix(self) -> None:
        vault = _vault(_policy_dict([_rule_dict()], name="age"))
        stored = await PolicyChecker(vault).policy_named("age")
        assert stored.policy.key_name == "age"
        assert stored.document["id"] == f"spal:{OWNER}:age"
        assert "entry:policies/age" in vault.reads

    async def test_policy_named_with_slash_in_name_round_trips(self) -> None:
        vault = _vault(_policy_dict([_rule_dict()], name="a/b"))
        stored = await PolicyChecker(vault).policy_named("a/b")
        assert stored.policy.key_name == "a/b"

    async def test_missing_policy_is_refused(self) -> None:
        with pytest.raises(PolicyRefused) as exc_info:
            await PolicyChecker(_vault()).policy_named("age")
        assert exc_info.value.detail == "policy not found"

    async def test_invalid_policy_is_refused_with_the_field_path(self) -> None:
        bad = _policy_dict(
            [_rule_dict(conditions={"processing": {"locality": "device_only"}})], name="age"
        )
        with pytest.raises(PolicyRefused) as exc_info:
            await PolicyChecker(_vault(bad)).policy_named("age")
        assert exc_info.value.detail.startswith("policy is not valid")
        assert "rules.0.conditions.processing" in exc_info.value.detail
        # Field paths only: the vault's values never ride out in a reason.
        assert "device_only" not in exc_info.value.detail
        assert "input_value" not in exc_info.value.detail

    async def test_mis_named_policy_is_refused(self) -> None:
        vault = _vault()
        vault.put(policy_key("age"), _policy_dict([_rule_dict()], name="other"))
        with pytest.raises(PolicyRefused) as exc_info:
            await PolicyChecker(vault).policy_named("age")
        assert exc_info.value.detail == "policy is not the one named"

    async def test_policy_not_the_holders_is_refused(self) -> None:
        vault = _vault(_policy_dict([_rule_dict()], name="age", owner="did:key:z6Mkelse"))
        with pytest.raises(PolicyRefused) as exc_info:
            await PolicyChecker(vault).policy_named("age")
        assert exc_info.value.detail == "policy is not the holder's"

    async def test_missing_root_identity_is_unavailable(self) -> None:
        vault = _vault(_policy_dict([_rule_dict()], name="age"), root=None)
        with pytest.raises(ContextUnavailable, match="root identity"):
            await PolicyChecker(vault).policy_named("age")

    async def test_locked_vault_propagates(self) -> None:
        vault = _vault(_policy_dict([_rule_dict()], name="age"))
        vault.error = ContextUnavailable("context store locked")
        with pytest.raises(ContextUnavailable, match="locked"):
            await PolicyChecker(vault).policy_named("age")

    async def test_policy_for_terms_matches_by_hash(self) -> None:
        age = _policy_dict([_rule_dict(scope="personal/age")], name="age")
        email = _policy_dict([_rule_dict(scope="personal/email")], name="email")
        checker = PolicyChecker(_vault(age, email))
        assert (await checker.policy_for_terms(terms_hash(email))).policy.key_name == "email"

    async def test_policy_for_terms_is_deterministic_for_identical_terms(self) -> None:
        a = _policy_dict([_rule_dict()], name="a")
        b = _policy_dict([_rule_dict()], name="b")
        checker = PolicyChecker(_vault(b, a))
        assert (await checker.policy_for_terms(terms_hash(a))).policy.key_name == "a"

    async def test_unmatched_terms_are_refused(self) -> None:
        checker = PolicyChecker(_vault(_policy_dict([_rule_dict()], name="a")))
        with pytest.raises(PolicyRefused) as exc_info:
            await checker.policy_for_terms("0" * 64)
        assert exc_info.value.detail == "terms do not match any policy"

    async def test_terms_come_from_the_document_not_the_model_defaults(self) -> None:
        doc = _policy_dict([_rule_dict(conditions={"identity": {"type": "ephemeral_required"}})])
        stored = await PolicyChecker(_vault(doc)).policy_named("test-policy")
        assert stored.terms_hash == terms_hash(doc)
        assert "proofs" not in stored.terms["rules"][0]["conditions"]

    async def test_policy_for_terms_skips_a_policy_that_is_not_the_holders(self) -> None:
        theirs = _policy_dict([_rule_dict()], name="a", owner="did:key:z6Mkelse")
        checker = PolicyChecker(_vault(theirs))
        with pytest.raises(PolicyRefused):
            await checker.policy_for_terms(terms_hash(theirs))


# --- Scope matching tests ---


class TestScopeMatching:
    async def test_exact_scope_match(self) -> None:
        result = await _check(
            [_rule_dict(scope="medical/diagnosis_codes")], "medical/diagnosis_codes"
        )
        assert result.matched_rule_id == "rule-1"

    async def test_sub_scope_match(self) -> None:
        result = await _check(
            [_rule_dict(scope="medical/diagnosis_codes")], "medical/diagnosis_codes/icd10"
        )
        assert result.matched_rule_id == "rule-1"

    async def test_no_match_for_parent_scope_denies(self) -> None:
        """A broader request does not match a more specific rule, and no rule means no."""
        result = await _check([_rule_dict(scope="medical/diagnosis_codes")], "medical")
        assert result.allowed is False
        assert result.matched_rule_id is None
        assert result.reason == GENERIC_DENIAL
        assert "medical" in (result.detail or "")

    async def test_denial_details_name_no_policy_or_owner(self) -> None:
        """A detail may reach a business page (the API has no auth yet); it carries no handle."""
        result = await _check([_rule_dict(scope="medical/diagnosis_codes")], "financial/income")
        assert "test-policy" not in (result.detail or "")
        assert OWNER not in (result.detail or "")

    async def test_no_match_for_unrelated_scope_denies(self) -> None:
        result = await _check([_rule_dict(scope="medical/diagnosis_codes")], "financial/income")
        assert result.allowed is False
        assert result.matched_rule_id is None

    async def test_most_specific_rule_wins(self) -> None:
        rules = [
            _rule_dict(rule_id="broad", scope="medical"),
            _rule_dict(rule_id="specific", scope="medical/diagnosis_codes"),
        ]
        result = await _check(rules, "medical/diagnosis_codes")
        assert result.matched_rule_id == "specific"

    async def test_no_partial_prefix_match(self) -> None:
        """'medical/diagnosis' must not match 'medical/diagnosis_codes'."""
        result = await _check([_rule_dict(scope="medical/diagnosis")], "medical/diagnosis_codes")
        assert result.matched_rule_id is None


# --- Condition evaluation tests ---


class TestConditionEvaluation:
    async def test_empty_conditions_allow(self) -> None:
        result = await _check([_rule_dict()])
        assert result.allowed is True
        assert result.matched_rule_id == "rule-1"

    async def test_denial_carries_generic_reason_and_specific_detail(self) -> None:
        result = await _check([_rule_dict(conditions={"identity": {"type": "ephemeral_required"}})])
        assert result.allowed is False
        assert result.reason == GENERIC_DENIAL
        assert "Ephemeral identity required" in (result.detail or "")

    # --- Identity ---

    async def test_ephemeral_identity_required_and_provided(self) -> None:
        ctx = RequestContext(
            identity=RequestIdentity(type=IdentityType.EPHEMERAL_REQUIRED, did="did:key:z123")
        )
        result = await _check(
            [_rule_dict(conditions={"identity": {"type": "ephemeral_required"}})], ctx=ctx
        )
        assert result.allowed is True

    async def test_ephemeral_identity_required_but_persistent_given(self) -> None:
        ctx = RequestContext(identity=RequestIdentity(type=IdentityType.PERSISTENT_ALLOWED))
        result = await _check(
            [_rule_dict(conditions={"identity": {"type": "ephemeral_required"}})], ctx=ctx
        )
        assert result.allowed is False
        assert "Ephemeral" in (result.detail or "")

    async def test_any_identity_type_allows_all(self) -> None:
        ctx = RequestContext(identity=RequestIdentity(type=IdentityType.PERSISTENT_ALLOWED))
        result = await _check([_rule_dict(conditions={"identity": {"type": "any"}})], ctx=ctx)
        assert result.allowed is True

    async def test_ephemeral_identity_required_but_none_given(self) -> None:
        result = await _check([_rule_dict(conditions={"identity": {"type": "ephemeral_required"}})])
        assert result.allowed is False
        assert "none provided" in (result.detail or "")

    # --- Proofs ---

    async def test_required_proof_provided(self) -> None:
        ctx = RequestContext(proofs=[AvailableProof(type=ProofType.ZKP, claim="age_over_18")])
        rules = [_rule_dict(conditions={"proofs": [{"type": "zkp", "claim": "age_over_18"}]})]
        assert (await _check(rules, ctx=ctx)).allowed is True

    async def test_required_proof_missing(self) -> None:
        rules = [_rule_dict(conditions={"proofs": [{"type": "zkp", "claim": "age_over_18"}]})]
        result = await _check(rules)
        assert result.allowed is False
        assert "Missing required proof" in (result.detail or "")

    async def test_wrong_proof_type_denied(self) -> None:
        ctx = RequestContext(proofs=[AvailableProof(type=ProofType.SIGNATURE, claim="age_over_18")])
        rules = [_rule_dict(conditions={"proofs": [{"type": "zkp", "claim": "age_over_18"}]})]
        assert (await _check(rules, ctx=ctx)).allowed is False

    # --- Derivatives ---

    async def test_training_forbidden_and_requested(self) -> None:
        ctx = RequestContext(intended_use=IntendedUse(training=True))
        result = await _check([_rule_dict(conditions={"derivatives": _derivs()})], ctx=ctx)
        assert result.allowed is False
        assert "Training" in (result.detail or "")

    async def test_aggregation_forbidden_and_requested(self) -> None:
        ctx = RequestContext(intended_use=IntendedUse(aggregation=True))
        result = await _check([_rule_dict(conditions={"derivatives": _derivs()})], ctx=ctx)
        assert result.allowed is False
        assert "Aggregation" in (result.detail or "")

    async def test_resale_forbidden_and_requested(self) -> None:
        ctx = RequestContext(intended_use=IntendedUse(resale=True))
        result = await _check([_rule_dict(conditions={"derivatives": _derivs()})], ctx=ctx)
        assert result.allowed is False
        assert "Resale" in (result.detail or "")

    async def test_derivatives_allowed(self) -> None:
        ctx = RequestContext(intended_use=IntendedUse(training=True, aggregation=True, resale=True))
        rules = [_rule_dict(conditions={"derivatives": _derivs("allowed", "allowed", "allowed")})]
        assert (await _check(rules, ctx=ctx)).allowed is True

    # --- Retention ---

    async def test_retention_within_limit(self) -> None:
        ctx = RequestContext(offered_retention_seconds=1800)
        rules = [_rule_dict(conditions={"retention": {"max_seconds": 3600}})]
        assert (await _check(rules, ctx=ctx)).allowed is True

    async def test_retention_exceeds_limit(self) -> None:
        ctx = RequestContext(offered_retention_seconds=7200)
        rules = [_rule_dict(conditions={"retention": {"max_seconds": 3600}})]
        result = await _check(rules, ctx=ctx)
        assert result.allowed is False
        assert "exceeds" in (result.detail or "")

    async def test_immediate_deletion_required(self) -> None:
        ctx = RequestContext(offered_retention_seconds=1)
        rules = [_rule_dict(conditions={"retention": {"max_seconds": 0}})]
        assert (await _check(rules, ctx=ctx)).allowed is False

    # --- Payment ---

    async def test_payment_required_but_not_offered(self) -> None:
        rules = [
            _rule_dict(
                conditions={"payment": {"protocol": "x402", "amount": 100, "currency": "sats"}}
            )
        ]
        result = await _check(rules, ctx=RequestContext(payment_offered=False))
        assert result.allowed is False
        assert "Payment required" in (result.detail or "")

    async def test_payment_required_and_offered(self) -> None:
        rules = [
            _rule_dict(
                conditions={"payment": {"protocol": "x402", "amount": 100, "currency": "sats"}}
            )
        ]
        assert (await _check(rules, ctx=RequestContext(payment_offered=True))).allowed is True

    # --- All conditions combined ---

    async def test_all_conditions_met(self) -> None:
        rules = [
            _rule_dict(
                conditions={
                    "identity": {"type": "ephemeral_required"},
                    "proofs": [{"type": "zkp", "claim": "age_over_18"}],
                    "retention": {"max_seconds": 3600},
                    "derivatives": _derivs(aggregation="allowed"),
                    "payment": {"protocol": "x402", "amount": 100, "currency": "sats"},
                }
            )
        ]
        ctx = RequestContext(
            identity=RequestIdentity(type=IdentityType.EPHEMERAL_REQUIRED, did="did:key:z123"),
            proofs=[AvailableProof(type=ProofType.ZKP, claim="age_over_18")],
            intended_use=IntendedUse(aggregation=True),
            offered_retention_seconds=1800,
            payment_offered=True,
        )
        result = await _check(rules, ctx=ctx)
        assert result.allowed is True
        assert result.matched_rule_id == "rule-1"

    # --- The holder asking ---

    async def test_holder_requester_skips_third_party_conditions(self) -> None:
        rules = [
            _rule_dict(
                conditions={
                    "identity": {"type": "ephemeral_required"},
                    "proofs": [{"type": "zkp", "claim": "age"}],
                }
            )
        ]
        result = await _check(rules, requester=Requester.HOLDER)
        assert result.allowed is True
        assert result.matched_rule_id == "rule-1"

    async def test_holder_still_needs_a_matching_rule(self) -> None:
        result = await _check([_rule_dict(scope="other/scope")], requester=Requester.HOLDER)
        assert result.allowed is False
        assert result.matched_rule_id is None


# --- Integration with realistic policy ---


class TestRealisticPolicyIntegration:
    @pytest.fixture
    def health(self) -> SPALPolicy:
        return SPALPolicy.model_validate(HEALTH_POLICY_FIXTURE)

    async def test_health_policy_valid_request(self, health: SPALPolicy) -> None:
        ctx = RequestContext(
            identity=RequestIdentity(type=IdentityType.EPHEMERAL_REQUIRED, did="did:key:z123"),
            proofs=[AvailableProof(type=ProofType.ZKP, claim="is_licensed_provider")],
            offered_retention_seconds=0,
        )
        result = await PolicyChecker(_vault()).check(
            health,
            "medical/diagnosis_codes",
            ctx,
            Requester.THIRD_PARTY,
            custody=Operator.OWNED_HARDWARE,
        )
        assert result.allowed is True

    async def test_health_policy_wrong_identity(self, health: SPALPolicy) -> None:
        ctx = RequestContext(
            identity=RequestIdentity(type=IdentityType.PERSISTENT_ALLOWED),
            proofs=[AvailableProof(type=ProofType.ZKP, claim="is_licensed_provider")],
        )
        result = await PolicyChecker(_vault()).check(
            health,
            "medical/diagnosis_codes",
            ctx,
            Requester.THIRD_PARTY,
            custody=Operator.OWNED_HARDWARE,
        )
        assert result.allowed is False
        assert "Ephemeral" in (result.detail or "")

    async def test_health_policy_missing_proof(self, health: SPALPolicy) -> None:
        ctx = RequestContext(
            identity=RequestIdentity(type=IdentityType.EPHEMERAL_REQUIRED, did="did:key:z123")
        )
        result = await PolicyChecker(_vault()).check(
            health,
            "medical/diagnosis_codes",
            ctx,
            Requester.THIRD_PARTY,
            custody=Operator.OWNED_HARDWARE,
        )
        assert result.allowed is False
        assert "Missing required proof" in (result.detail or "")

    async def test_health_policy_vaccination_needs_payment(self, health: SPALPolicy) -> None:
        ctx = RequestContext(
            identity=RequestIdentity(type=IdentityType.EPHEMERAL_REQUIRED, did="did:key:z123"),
            proofs=[AvailableProof(type=ProofType.ZKP, claim="has_vaccination")],
            offered_retention_seconds=3600,
            payment_offered=False,
        )
        result = await PolicyChecker(_vault()).check(
            health,
            "medical/immunization/status",
            ctx,
            Requester.THIRD_PARTY,
            custody=Operator.OWNED_HARDWARE,
        )
        assert result.allowed is False
        assert "Payment required" in (result.detail or "")


def test_a_result_cannot_be_allowed_without_a_matched_rule() -> None:
    """The fail-closed invariant lives on the result, so callers need not restate it."""
    with pytest.raises(ValueError, match="matched_rule_id"):
        PolicyCheckResult(allowed=True, reason="x")


async def test_terms_are_computed_once_per_stored_policy() -> None:
    stored = await PolicyChecker(_vault(_policy_dict([_rule_dict()]))).policy_named("test-policy")
    assert stored.terms is stored.terms
    assert stored.terms_hash == terms_hash(stored.document)


async def test_a_stored_policy_the_export_refuses_is_refused_not_an_error() -> None:
    doc = _policy_dict([_rule_dict(conditions={"retention": {"max_seconds": 2**53}})])
    with pytest.raises(PolicyRefused):
        await PolicyChecker(_vault(doc)).policy_named("test-policy")


def test_spec_examples_export_terms_that_hash() -> None:
    for example in SPEC_EXAMPLES:
        assert len(terms_hash(json.loads(example.read_text()))) == 64


async def test_unmatched_terms_say_when_stored_policies_could_not_be_used() -> None:
    bad = _policy_dict([_rule_dict(conditions={"processing": {"locality": "device_only"}})])
    checker = PolicyChecker(_vault(bad))
    with pytest.raises(PolicyRefused) as exc_info:
        await checker.policy_for_terms("0" * 64)
    assert "1 stored" in exc_info.value.detail


async def test_terms_lookup_ignores_keys_outside_the_policies_prefix() -> None:
    """``policies-archive`` is in the ``policies`` domain by the reader's rule, but is no policy."""
    vault = _vault()
    archived = _policy_dict([_rule_dict()], name="archived")
    vault.put("policies-archive", archived)
    with pytest.raises(PolicyRefused, match="terms do not match any policy"):
        await PolicyChecker(vault).policy_for_terms(terms_hash(archived))


async def test_an_invalid_id_or_owner_is_refused_with_the_rule_that_failed() -> None:
    vault = _vault()
    vault.put(policy_key("age"), _policy_dict([_rule_dict()], name="age", owner="not-a-did"))
    with pytest.raises(PolicyRefused) as exc_info:
        await PolicyChecker(vault).policy_named("age")
    assert exc_info.value.detail.startswith("policy is not valid: ")
    assert "owner must be a DID" in exc_info.value.detail
    assert "not-a-did" not in exc_info.value.detail.split(": ", 1)[1].replace(
        "owner must be a DID", ""
    )


async def test_linkage_ephemeral_required_is_enforced_even_when_type_is_any() -> None:
    rules = [
        _rule_dict(
            conditions={"identity": {"type": "any", "linkage": {"ephemeral_required": True}}}
        )
    ]
    denied = await _check(rules)
    assert denied.allowed is False
    assert "Ephemeral identity required" in (denied.detail or "")
    ctx = RequestContext(
        identity=RequestIdentity(type=IdentityType.EPHEMERAL_REQUIRED, did="did:key:z1")
    )
    assert (await _check(rules, ctx=ctx)).allowed is True


async def test_equal_scope_rules_are_chosen_by_terms_order_not_document_order() -> None:
    """Two policies with the same rules in opposite order share a hash; they must decide alike."""
    strict = _rule_dict(rule_id="strict", conditions={"identity": {"type": "ephemeral_required"}})
    lax = _rule_dict(rule_id="lax", conditions={})
    first = await _check([strict, lax])
    second = await _check([lax, strict])
    assert first.allowed == second.allowed
    assert first.matched_rule_id == second.matched_rule_id


# --- Custody: whose machine may work on the data ---


async def _check_at(
    rules: list[dict], machine: Operator, requester: Requester = Requester.THIRD_PARTY
) -> PolicyCheckResult:
    checker = PolicyChecker(_vault())
    policy = SPALPolicy.model_validate({**_policy_dict(rules), "version": "1.1"})
    return await checker.check(policy, "test/data", RequestContext(), requester, custody=machine)


async def test_custody_denies_a_machine_further_than_the_ceiling() -> None:
    rules = [_rule_dict(conditions={"custody": {"operator": "device_only"}})]
    result = await _check_at(rules, Operator.FEDERATED_OPERATOR)
    assert result.allowed is False
    assert result.reason == GENERIC_DENIAL
    assert result.detail == (
        "custody: data under this rule may go no further than device_only; "
        "federated_operator is further"
    )
    assert result.matched_rule_id == "rule-1"


async def test_custody_allows_the_ceiling_and_anything_safer() -> None:
    rules = [_rule_dict(conditions={"custody": {"operator": "federated_operator"}})]
    for machine in (Operator.DEVICE_ONLY, Operator.OWNED_HARDWARE, Operator.FEDERATED_OPERATOR):
        assert (await _check_at(rules, machine)).allowed is True, machine
    assert (await _check_at(rules, Operator.ATTESTED_ENCLAVE)).allowed is False


async def test_a_rule_without_custody_means_the_holders_own_hardware() -> None:
    rules = [_rule_dict()]
    assert (await _check_at(rules, Operator.OWNED_HARDWARE)).allowed is True
    denied = await _check_at(rules, Operator.COMMUNITY_NODE)
    assert denied.allowed is False
    assert "no further than owned_hardware" in (denied.detail or "")


async def test_custody_binds_the_holders_own_asks_too() -> None:
    rules = [
        _rule_dict(
            conditions={
                "identity": {"type": "ephemeral_required"},
                "custody": {"operator": "device_only"},
            }
        )
    ]
    holder = await _check_at(rules, Operator.FEDERATED_OPERATOR, Requester.HOLDER)
    assert holder.allowed is False
    assert "custody" in (holder.detail or "")
    assert (await _check_at(rules, Operator.DEVICE_ONLY, Requester.HOLDER)).allowed is True


async def test_attestation_required_cannot_be_satisfied_yet() -> None:
    rules = [
        _rule_dict(
            conditions={"custody": {"operator": "attested_enclave", "attestation_required": True}}
        )
    ]
    result = await _check_at(rules, Operator.OWNED_HARDWARE)
    assert result.allowed is False
    assert "attestation required" in (result.detail or "")


async def test_hosted_models_is_recorded_not_evaluated() -> None:
    for flag in ("forbidden", "allowed"):
        rules = [_rule_dict(conditions={"custody": {"operator": "any", "hosted_models": flag}})]
        assert (await _check_at(rules, Operator.ANY)).allowed is True


async def test_a_domain_read_is_bound_by_the_strictest_rule_in_the_domain() -> None:
    """An ask reads the whole domain, so every rule on that domain must admit the machine."""
    rules = [
        _rule_dict(
            rule_id="age",
            scope="personal/age",
            conditions={"custody": {"operator": "federated_operator"}},
        ),
        _rule_dict(rule_id="email", scope="personal/email"),
    ]
    policy = SPALPolicy.model_validate({**_policy_dict(rules), "version": "1.1"})
    checker = PolicyChecker(_vault())
    denial = checker.domain_custody_denial(policy, "personal/age", Operator.FEDERATED_OPERATOR)
    assert denial is not None
    assert "personal/email" in denial
    assert checker.domain_custody_denial(policy, "personal/age", Operator.OWNED_HARDWARE) is None
    other = SPALPolicy.model_validate({**_policy_dict(rules[:1]), "version": "1.1"})
    assert checker.domain_custody_denial(other, "personal/age", Operator.FEDERATED_OPERATOR) is None


async def test_a_domain_read_counts_every_rule_the_reader_would_admit() -> None:
    """The reader admits ``personal-health/…`` to a read of ``personal``; so must the check."""
    rules = [
        _rule_dict(
            rule_id="age",
            scope="personal/age",
            conditions={"custody": {"operator": "federated_operator"}},
        ),
        _rule_dict(rule_id="allergies", scope="personal-health/allergies"),
    ]
    policy = SPALPolicy.model_validate({**_policy_dict(rules), "version": "1.1"})
    denial = PolicyChecker(_vault()).domain_custody_denial(
        policy, "personal/age", Operator.FEDERATED_OPERATOR
    )
    assert denial is not None
    assert "personal-health/allergies" in denial


async def test_a_sibling_rule_requiring_attestation_holds_a_domain_read_back() -> None:
    rules = [
        _rule_dict(
            rule_id="age", scope="personal/age", conditions={"custody": {"operator": "any"}}
        ),
        _rule_dict(
            rule_id="notes",
            scope="personal/notes",
            conditions={"custody": {"operator": "any", "attestation_required": True}},
        ),
    ]
    policy = SPALPolicy.model_validate({**_policy_dict(rules), "version": "1.1"})
    denial = PolicyChecker(_vault()).domain_custody_denial(policy, "personal/age", Operator.ANY)
    assert denial is not None
    assert "attestation" in denial and "personal/notes" in denial
