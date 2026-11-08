"""Service requests carry a policy's terms to the business, never its id or owner."""

import json

from freehold_agent.coordination import CreateServiceRequest, PolicyLabel
from freehold_agent.policy import StoredPolicy
from freehold_agent.services import service_requests
from freehold_agent.spal import SPALPolicy
from freehold_agent.store import ServiceRequestRepository
from freehold_agent.terms import export_terms, terms_hash
from tests.fakes import SEED_OWNER, SEED_POLICY


def _stored() -> StoredPolicy:
    return StoredPolicy(
        document=SEED_POLICY,
        policy=SPALPolicy.model_validate(SEED_POLICY),
        terms=export_terms(SEED_POLICY),
        terms_hash=terms_hash(SEED_POLICY),
    )


def _payload() -> CreateServiceRequest:
    return CreateServiceRequest(
        user_id="demo-user",
        user_name="Alice",
        business_id="demo-business",
        service_type="purchase",
        service_name="Purchase Alcohol",
        policy_name="age-verification",
    )


def test_create_attaches_terms_hash_and_label() -> None:
    request = service_requests.create(ServiceRequestRepository(), _payload(), _stored())
    assert request.terms == export_terms(SEED_POLICY)
    assert request.terms_hash == terms_hash(SEED_POLICY)
    assert request.policy_label == PolicyLabel(
        name="Age Verification Only",
        description="Allow businesses to verify age without revealing birth date",
    )
    assert request.status == "pending"


def test_service_request_carries_no_owner_or_id() -> None:
    request = service_requests.create(ServiceRequestRepository(), _payload(), _stored())
    text = request.model_dump_json()
    assert SEED_OWNER not in text
    assert SEED_POLICY["id"] not in text
    assert "rule-age" not in text
    assert "policy_name" not in json.loads(text)
