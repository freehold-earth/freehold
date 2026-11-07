"""Comprehensive tests for S-PAL policy evaluation."""

from pathlib import Path

import pytest
from pydantic import BaseModel

import freehold_agent.spal as spal
from freehold_agent.policy import PolicyChecker
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

# --- Helpers ---


def _policy_dict(
    rules: list[dict],
    policy_id: str = "test-policy",
    name: str = "Test Policy",
) -> dict:
    return {
        "version": "1.0",
        "id": policy_id,
        "name": name,
        "owner": "did:key:z6Mktest",
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
        policy = SPALPolicy.model_validate(_policy_dict([_rule_dict()]))
        assert policy.version == "1.0"
        assert len(policy.rules) == 1
        assert policy.rules[0].context_scope == "test/data"

    def test_reject_empty_rules(self) -> None:
        with pytest.raises(ValueError):
            SPALPolicy.model_validate(_policy_dict([]))

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
        assert isinstance(req.linkage, IdentityLinkage)
        assert req.linkage.ephemeral_required is True
        assert req.linkage.proof_of_root_allowed is False

    def test_linkage_string_coercion_allowed(self) -> None:
        req = IdentityRequirement.model_validate(
            {
                "type": "any",
                "linkage": "allowed",
            }
        )
        assert isinstance(req.linkage, IdentityLinkage)
        assert req.linkage.ephemeral_required is False
        assert req.linkage.proof_of_root_allowed is True

    def test_linkage_object_passthrough(self) -> None:
        req = IdentityRequirement.model_validate(
            {
                "type": "ephemeral_required",
                "linkage": {
                    "ephemeral_required": True,
                    "proof_of_root_allowed": False,
                    "zk_continuity_allowed": True,
                },
            }
        )
        assert isinstance(req.linkage, IdentityLinkage)
        assert req.linkage.zk_continuity_allowed is True

    def test_parse_multi_rule_policy_with_all_conditions(self) -> None:
        """Parse a realistic policy with identity, proofs, retention, derivatives, payment."""
        policy = SPALPolicy.model_validate(HEALTH_POLICY_FIXTURE)
        assert policy.name == "Health Records Access Policy"
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
            SPALPolicy.model_validate(_policy_dict([rule]))

    def test_unknown_key_inside_known_condition_is_refused(self) -> None:
        rule = _rule_dict(conditions={"retention": {"max_seconds": 0, "shred": True}})
        with pytest.raises(ValueError, match=r"rules\.0\.conditions\.retention\.shred"):
            SPALPolicy.model_validate(_policy_dict([rule]))

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

    @pytest.mark.asyncio
    async def test_checker_reports_the_unknown_field(self) -> None:
        checker = PolicyChecker()
        rule = _rule_dict(conditions={"processing": {"locality": "device_only"}})
        with pytest.raises(ValueError, match=r"(?s)Invalid S-PAL policy 'p'.*processing"):
            await checker.load_policy("p", _policy_dict([rule]))
        assert "p" not in await checker.list_policies()

    def test_spec_examples_are_present(self) -> None:
        assert SPEC_EXAMPLES, f"no spec examples found under {SPEC_EXAMPLES_DIR}"

    @pytest.mark.parametrize("example", SPEC_EXAMPLES, ids=lambda p: p.name)
    def test_spec_examples_still_load(self, example: Path) -> None:
        policy = SPALPolicy.model_validate_json(example.read_bytes())
        assert policy.rules


# --- Scope matching tests ---


class TestScopeMatching:
    @pytest.fixture
    def checker(self) -> PolicyChecker:
        return PolicyChecker()

    async def test_exact_scope_match(self, checker: PolicyChecker) -> None:
        await checker.load_policy(
            "p",
            _policy_dict(
                [
                    _rule_dict(scope="medical/diagnosis_codes"),
                ]
            ),
        )
        result = await checker.check("p", "query", context_scope="medical/diagnosis_codes")
        assert result.matched_rule_id == "rule-1"

    async def test_sub_scope_match(self, checker: PolicyChecker) -> None:
        await checker.load_policy(
            "p",
            _policy_dict(
                [
                    _rule_dict(scope="medical/diagnosis_codes"),
                ]
            ),
        )
        result = await checker.check("p", "query", context_scope="medical/diagnosis_codes/icd10")
        assert result.matched_rule_id == "rule-1"

    async def test_no_match_for_parent_scope(self, checker: PolicyChecker) -> None:
        """A broader request should not match a more specific rule."""
        await checker.load_policy(
            "p",
            _policy_dict(
                [
                    _rule_dict(scope="medical/diagnosis_codes"),
                ]
            ),
        )
        result = await checker.check("p", "query", context_scope="medical")
        assert result.allowed is True
        assert "No rules govern" in (result.reason or "")

    async def test_no_match_for_unrelated_scope(self, checker: PolicyChecker) -> None:
        await checker.load_policy(
            "p",
            _policy_dict(
                [
                    _rule_dict(scope="medical/diagnosis_codes"),
                ]
            ),
        )
        result = await checker.check("p", "query", context_scope="financial/transactions")
        assert result.allowed is True

    async def test_most_specific_rule_wins(self, checker: PolicyChecker) -> None:
        await checker.load_policy(
            "p",
            _policy_dict(
                [
                    _rule_dict(rule_id="broad", scope="medical"),
                    _rule_dict(rule_id="specific", scope="medical/diagnosis_codes"),
                ]
            ),
        )
        result = await checker.check("p", "query", context_scope="medical/diagnosis_codes")
        assert result.matched_rule_id == "specific"

    async def test_no_partial_prefix_match(self, checker: PolicyChecker) -> None:
        """'medical/diag' should not match 'medical/diagnosis_codes'."""
        await checker.load_policy(
            "p",
            _policy_dict(
                [
                    _rule_dict(scope="medical/diagnosis_codes"),
                ]
            ),
        )
        result = await checker.check("p", "query", context_scope="medical/diag")
        assert result.allowed is True
        assert "No rules govern" in (result.reason or "")


# --- Condition evaluation tests ---


class TestConditionEvaluation:
    @pytest.fixture
    def checker(self) -> PolicyChecker:
        return PolicyChecker()

    async def test_no_request_context_returns_required_conditions(
        self, checker: PolicyChecker
    ) -> None:
        await checker.load_policy(
            "p",
            _policy_dict(
                [
                    _rule_dict(
                        conditions={
                            "identity": {"type": "ephemeral_required"},
                            "proofs": [{"type": "zkp", "claim": "age_over_18"}],
                        }
                    ),
                ]
            ),
        )
        result = await checker.check("p", "query", context_scope="test/data")
        assert result.allowed is False
        assert "requires request context" in (result.reason or "")
        assert result.required_conditions is not None
        assert len(result.required_conditions.proofs) == 1

    async def test_empty_conditions_allows_without_request_context(
        self, checker: PolicyChecker
    ) -> None:
        """A rule with no effective conditions should allow without request_context."""
        await checker.load_policy("p", _policy_dict([_rule_dict(conditions={})]))
        result = await checker.check("p", "query", context_scope="test/data")
        assert result.allowed is True
        assert result.matched_rule_id == "rule-1"

    # --- Identity ---

    async def test_ephemeral_identity_required_and_provided(self, checker: PolicyChecker) -> None:
        await checker.load_policy(
            "p",
            _policy_dict(
                [
                    _rule_dict(conditions={"identity": {"type": "ephemeral_required"}}),
                ]
            ),
        )
        ctx = RequestContext(
            identity=RequestIdentity(type=IdentityType.EPHEMERAL_REQUIRED, did="did:key:z123")
        )
        result = await checker.check("p", "query", context_scope="test/data", request_context=ctx)
        assert result.allowed is True

    async def test_ephemeral_identity_required_but_persistent_given(
        self, checker: PolicyChecker
    ) -> None:
        await checker.load_policy(
            "p",
            _policy_dict(
                [
                    _rule_dict(conditions={"identity": {"type": "ephemeral_required"}}),
                ]
            ),
        )
        ctx = RequestContext(identity=RequestIdentity(type=IdentityType.PERSISTENT_ALLOWED))
        result = await checker.check("p", "query", context_scope="test/data", request_context=ctx)
        assert result.allowed is False
        assert "Ephemeral identity required" in (result.reason or "")

    async def test_ephemeral_identity_required_but_none_given(self, checker: PolicyChecker) -> None:
        await checker.load_policy(
            "p",
            _policy_dict(
                [
                    _rule_dict(conditions={"identity": {"type": "ephemeral_required"}}),
                ]
            ),
        )
        ctx = RequestContext()
        result = await checker.check("p", "query", context_scope="test/data", request_context=ctx)
        assert result.allowed is False
        assert "none provided" in (result.reason or "")

    async def test_any_identity_type_allows_all(self, checker: PolicyChecker) -> None:
        await checker.load_policy(
            "p",
            _policy_dict(
                [
                    _rule_dict(conditions={"identity": {"type": "any"}}),
                ]
            ),
        )
        ctx = RequestContext(identity=RequestIdentity(type=IdentityType.PERSISTENT_ALLOWED))
        result = await checker.check("p", "query", context_scope="test/data", request_context=ctx)
        assert result.allowed is True

    # --- Proofs ---

    async def test_required_proof_provided(self, checker: PolicyChecker) -> None:
        await checker.load_policy(
            "p",
            _policy_dict(
                [
                    _rule_dict(
                        conditions={
                            "proofs": [{"type": "zkp", "claim": "age_over_18"}],
                        }
                    ),
                ]
            ),
        )
        ctx = RequestContext(proofs=[AvailableProof(type=ProofType.ZKP, claim="age_over_18")])
        result = await checker.check("p", "query", context_scope="test/data", request_context=ctx)
        assert result.allowed is True

    async def test_required_proof_missing(self, checker: PolicyChecker) -> None:
        await checker.load_policy(
            "p",
            _policy_dict(
                [
                    _rule_dict(
                        conditions={
                            "proofs": [{"type": "zkp", "claim": "age_over_18"}],
                        }
                    ),
                ]
            ),
        )
        ctx = RequestContext(proofs=[])
        result = await checker.check("p", "query", context_scope="test/data", request_context=ctx)
        assert result.allowed is False
        assert "Missing required proof" in (result.reason or "")

    async def test_wrong_proof_type_denied(self, checker: PolicyChecker) -> None:
        await checker.load_policy(
            "p",
            _policy_dict(
                [
                    _rule_dict(
                        conditions={
                            "proofs": [{"type": "zkp", "claim": "age_over_18"}],
                        }
                    ),
                ]
            ),
        )
        ctx = RequestContext(
            proofs=[AvailableProof(type=ProofType.ATTESTATION, claim="age_over_18")]
        )
        result = await checker.check("p", "query", context_scope="test/data", request_context=ctx)
        assert result.allowed is False

    # --- Derivatives ---

    async def test_training_forbidden_and_requested(self, checker: PolicyChecker) -> None:
        await checker.load_policy(
            "p",
            _policy_dict(
                [
                    _rule_dict(
                        conditions={
                            "derivatives": _derivs(aggregation="allowed"),
                        }
                    ),
                ]
            ),
        )
        ctx = RequestContext(intended_use=IntendedUse(training=True))
        result = await checker.check("p", "query", context_scope="test/data", request_context=ctx)
        assert result.allowed is False
        assert "Training" in (result.reason or "")

    async def test_aggregation_forbidden_and_requested(self, checker: PolicyChecker) -> None:
        await checker.load_policy(
            "p",
            _policy_dict(
                [
                    _rule_dict(
                        conditions={
                            "derivatives": _derivs(
                                training="allowed",
                                aggregation="forbidden",
                                resale="allowed",
                            ),
                        }
                    ),
                ]
            ),
        )
        ctx = RequestContext(intended_use=IntendedUse(aggregation=True))
        result = await checker.check("p", "query", context_scope="test/data", request_context=ctx)
        assert result.allowed is False
        assert "Aggregation" in (result.reason or "")

    async def test_resale_forbidden_and_requested(self, checker: PolicyChecker) -> None:
        await checker.load_policy(
            "p",
            _policy_dict(
                [
                    _rule_dict(
                        conditions={
                            "derivatives": _derivs(training="allowed", aggregation="allowed"),
                        }
                    ),
                ]
            ),
        )
        ctx = RequestContext(intended_use=IntendedUse(resale=True))
        result = await checker.check("p", "query", context_scope="test/data", request_context=ctx)
        assert result.allowed is False
        assert "Resale" in (result.reason or "")

    async def test_derivatives_allowed(self, checker: PolicyChecker) -> None:
        await checker.load_policy(
            "p",
            _policy_dict(
                [
                    _rule_dict(
                        conditions={
                            "derivatives": _derivs(
                                training="allowed", aggregation="allowed", resale="allowed"
                            ),
                        }
                    ),
                ]
            ),
        )
        ctx = RequestContext(intended_use=IntendedUse(training=True, aggregation=True, resale=True))
        result = await checker.check("p", "query", context_scope="test/data", request_context=ctx)
        assert result.allowed is True

    # --- Retention ---

    async def test_retention_within_limit(self, checker: PolicyChecker) -> None:
        await checker.load_policy(
            "p",
            _policy_dict(
                [
                    _rule_dict(conditions={"retention": {"max_seconds": 3600, "audit_log": True}}),
                ]
            ),
        )
        ctx = RequestContext(offered_retention_seconds=1800)
        result = await checker.check("p", "query", context_scope="test/data", request_context=ctx)
        assert result.allowed is True

    async def test_retention_exceeds_limit(self, checker: PolicyChecker) -> None:
        await checker.load_policy(
            "p",
            _policy_dict(
                [
                    _rule_dict(conditions={"retention": {"max_seconds": 3600, "audit_log": True}}),
                ]
            ),
        )
        ctx = RequestContext(offered_retention_seconds=7200)
        result = await checker.check("p", "query", context_scope="test/data", request_context=ctx)
        assert result.allowed is False
        assert "retention" in (result.reason or "").lower()

    async def test_immediate_deletion_required(self, checker: PolicyChecker) -> None:
        await checker.load_policy(
            "p",
            _policy_dict(
                [
                    _rule_dict(conditions={"retention": {"max_seconds": 0}}),
                ]
            ),
        )
        ctx = RequestContext(offered_retention_seconds=1)
        result = await checker.check("p", "query", context_scope="test/data", request_context=ctx)
        assert result.allowed is False

    # --- Payment ---

    async def test_payment_required_and_offered(self, checker: PolicyChecker) -> None:
        await checker.load_policy(
            "p",
            _policy_dict(
                [
                    _rule_dict(
                        conditions={
                            "payment": {"protocol": "x402", "amount": 100, "currency": "sats"},
                        }
                    ),
                ]
            ),
        )
        ctx = RequestContext(payment_offered=True)
        result = await checker.check("p", "query", context_scope="test/data", request_context=ctx)
        assert result.allowed is True

    async def test_payment_required_but_not_offered(self, checker: PolicyChecker) -> None:
        await checker.load_policy(
            "p",
            _policy_dict(
                [
                    _rule_dict(
                        conditions={
                            "payment": {"protocol": "x402", "amount": 100, "currency": "sats"},
                        }
                    ),
                ]
            ),
        )
        ctx = RequestContext(payment_offered=False)
        result = await checker.check("p", "query", context_scope="test/data", request_context=ctx)
        assert result.allowed is False
        assert "Payment required" in (result.reason or "")

    # --- All conditions combined ---

    async def test_all_conditions_met(self, checker: PolicyChecker) -> None:
        await checker.load_policy(
            "p",
            _policy_dict(
                [
                    _rule_dict(
                        conditions={
                            "identity": {"type": "ephemeral_required"},
                            "proofs": [{"type": "zkp", "claim": "age_over_18"}],
                            "retention": {"max_seconds": 3600},
                            "derivatives": _derivs(aggregation="allowed"),
                            "payment": {"protocol": "x402", "amount": 100, "currency": "sats"},
                        }
                    ),
                ]
            ),
        )
        ctx = RequestContext(
            identity=RequestIdentity(type=IdentityType.EPHEMERAL_REQUIRED, did="did:key:z123"),
            proofs=[AvailableProof(type=ProofType.ZKP, claim="age_over_18")],
            intended_use=IntendedUse(aggregation=True),
            offered_retention_seconds=1800,
            payment_offered=True,
        )
        result = await checker.check("p", "query", context_scope="test/data", request_context=ctx)
        assert result.allowed is True
        assert result.matched_rule_id == "rule-1"


# --- Integration with realistic policy ---


class TestRealisticPolicyIntegration:
    @pytest.fixture
    def checker(self) -> PolicyChecker:
        return PolicyChecker()

    async def test_health_policy_valid_request(self, checker: PolicyChecker) -> None:
        await checker.load_policy("health", HEALTH_POLICY_FIXTURE)
        ctx = RequestContext(
            identity=RequestIdentity(type=IdentityType.EPHEMERAL_REQUIRED, did="did:key:z123"),
            proofs=[AvailableProof(type=ProofType.ZKP, claim="is_licensed_provider")],
            offered_retention_seconds=0,
        )
        result = await checker.check(
            "health", "query", context_scope="medical/diagnosis_codes", request_context=ctx
        )
        assert result.allowed is True

    async def test_health_policy_wrong_identity(self, checker: PolicyChecker) -> None:
        await checker.load_policy("health", HEALTH_POLICY_FIXTURE)
        ctx = RequestContext(
            identity=RequestIdentity(type=IdentityType.PERSISTENT_ALLOWED),
            proofs=[AvailableProof(type=ProofType.ZKP, claim="is_licensed_provider")],
        )
        result = await checker.check(
            "health", "query", context_scope="medical/diagnosis_codes", request_context=ctx
        )
        assert result.allowed is False
        assert "Ephemeral" in (result.reason or "")

    async def test_health_policy_missing_proof(self, checker: PolicyChecker) -> None:
        await checker.load_policy("health", HEALTH_POLICY_FIXTURE)
        ctx = RequestContext(
            identity=RequestIdentity(type=IdentityType.EPHEMERAL_REQUIRED, did="did:key:z123"),
            proofs=[],
        )
        result = await checker.check(
            "health", "query", context_scope="medical/diagnosis_codes", request_context=ctx
        )
        assert result.allowed is False
        assert "Missing required proof" in (result.reason or "")

    async def test_health_policy_vaccination_needs_payment(self, checker: PolicyChecker) -> None:
        await checker.load_policy("health", HEALTH_POLICY_FIXTURE)
        ctx = RequestContext(
            identity=RequestIdentity(type=IdentityType.EPHEMERAL_REQUIRED, did="did:key:z123"),
            proofs=[AvailableProof(type=ProofType.ZKP, claim="has_vaccination")],
            offered_retention_seconds=3600,
            payment_offered=False,
        )
        result = await checker.check(
            "health",
            "query",
            context_scope="medical/immunization/status",
            request_context=ctx,
        )
        assert result.allowed is False
        assert "Payment required" in (result.reason or "")


# --- Backward compatibility ---


class TestBackwardCompatibility:
    @pytest.fixture
    def checker(self) -> PolicyChecker:
        return PolicyChecker()

    async def test_missing_policy_still_allows(self, checker: PolicyChecker) -> None:
        result = await checker.check("nonexistent", "query")
        assert result.allowed is True

    async def test_no_context_scope_still_allows(self, checker: PolicyChecker) -> None:
        await checker.load_policy("p", _policy_dict([_rule_dict()]))
        result = await checker.check("p", "query")
        assert result.allowed is True

    async def test_invalid_policy_raises_valueerror(self, checker: PolicyChecker) -> None:
        with pytest.raises(ValueError, match="Invalid S-PAL policy"):
            await checker.load_policy("bad", {})

    async def test_empty_rules_raises_valueerror(self, checker: PolicyChecker) -> None:
        with pytest.raises(ValueError, match="Invalid S-PAL policy"):
            await checker.load_policy("bad", _policy_dict([]))
