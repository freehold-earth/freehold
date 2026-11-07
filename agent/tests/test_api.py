"""Tests for the FastAPI coordination app."""

import base64

import pytest
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from fastapi.testclient import TestClient

from freehold_agent.api import create_app
from freehold_agent.config import AgentConfig, ApprovalConfig
from freehold_agent.coordination import (
    ApprovalDecision,
    ApprovalMode,
    DecisionOutcome,
    RequestStatus,
    VerificationRequest,
)
from freehold_agent.store import RequestRepository
from tests.test_api_unlock import _client as _vault_client
from tests.test_attestation import did_key, sign_approval
from tests.test_authorization import _root, _signed
from tests.test_context import PASSWORD, USER, FakeStore


def _payload() -> dict:
    return {
        "business_id": "biz",
        "business_name": "Biz",
        "claim": {"type": "age", "params": {"minAge": 18}},
        "terms_hash": "a" * 64,
        "context_scope": "personal/age",
    }


class StubService:
    def __init__(
        self, outcome: DecisionOutcome, approve_outcome: DecisionOutcome | None = None
    ) -> None:
        self._outcome = outcome
        self._approve_outcome = approve_outcome if approve_outcome is not None else outcome

    async def decide(self, request: VerificationRequest) -> ApprovalDecision:
        return ApprovalDecision(outcome=self._outcome, reason="stub", proof={"ok": True})

    async def approve(
        self, request: VerificationRequest, requester_did: str | None = None
    ) -> ApprovalDecision:
        return ApprovalDecision(
            outcome=self._approve_outcome, reason="stub-approve", proof={"ok": True}
        )


def test_health():
    app = create_app(AgentConfig())
    client = TestClient(app)
    assert client.get("/health").json()["status"] == "healthy"


def test_manual_mode_parks_pending():
    app = create_app(AgentConfig(approval=ApprovalConfig(mode=ApprovalMode.MANUAL)))
    client = TestClient(app)
    resp = client.post("/requests", json=_payload())
    assert resp.status_code == 201
    assert resp.json()["status"] == "pending"


def test_fully_autonomous_approves_on_decide():
    config = AgentConfig(approval=ApprovalConfig(mode=ApprovalMode.FULLY_AUTONOMOUS))
    app = create_app(config, service_factory=lambda: StubService(DecisionOutcome.APPROVE))
    client = TestClient(app)
    resp = client.post("/requests", json=_payload())
    assert resp.status_code == 201
    assert resp.json()["status"] == "approved"


def test_fully_autonomous_denies_on_decide():
    config = AgentConfig(approval=ApprovalConfig(mode=ApprovalMode.FULLY_AUTONOMOUS))
    app = create_app(config, service_factory=lambda: StubService(DecisionOutcome.DENY))
    client = TestClient(app)
    resp = client.post("/requests", json=_payload())
    assert resp.json()["status"] == "denied"


def test_get_missing_request_returns_404():
    app = create_app(AgentConfig())
    client = TestClient(app)
    assert client.get("/requests/nope").status_code == 404


def test_manual_approve_verified_sets_approved():
    config = AgentConfig(approval=ApprovalConfig(mode=ApprovalMode.MANUAL))
    app = create_app(
        config,
        service_factory=lambda: StubService(
            DecisionOutcome.APPROVE, approve_outcome=DecisionOutcome.APPROVE
        ),
    )
    client = TestClient(app)
    created = client.post("/requests", json=_payload()).json()
    resp = client.post(f"/requests/{created['id']}/approve")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "approved"
    assert body["response"]["proof"] == {"ok": True}


def test_manual_approve_unverified_sets_rejected():
    config = AgentConfig(approval=ApprovalConfig(mode=ApprovalMode.MANUAL))
    app = create_app(
        config,
        service_factory=lambda: StubService(
            DecisionOutcome.APPROVE, approve_outcome=DecisionOutcome.REJECT
        ),
    )
    client = TestClient(app)
    created = client.post("/requests", json=_payload()).json()
    resp = client.post(f"/requests/{created['id']}/approve")
    assert resp.status_code == 200
    assert resp.json()["status"] == "rejected"


def test_manual_deny_sets_denied():
    config = AgentConfig(approval=ApprovalConfig(mode=ApprovalMode.MANUAL))
    app = create_app(config, service_factory=lambda: StubService(DecisionOutcome.APPROVE))
    client = TestClient(app)
    created = client.post("/requests", json=_payload()).json()
    resp = client.post(f"/requests/{created['id']}/deny")
    assert resp.status_code == 200
    assert resp.json()["status"] == "denied"


def test_approve_missing_request_404():
    app = create_app(AgentConfig())
    client = TestClient(app)
    resp = client.post("/requests/nope/approve")
    assert resp.status_code == 404


def test_approve_non_pending_returns_409():
    config = AgentConfig(approval=ApprovalConfig(mode=ApprovalMode.FULLY_AUTONOMOUS))
    app = create_app(config, service_factory=lambda: StubService(DecisionOutcome.APPROVE))
    client = TestClient(app)
    created = client.post("/requests", json=_payload()).json()
    assert created["status"] == "approved"
    resp = client.post(f"/requests/{created['id']}/approve")
    assert resp.status_code == 409


def test_deny_non_pending_returns_409():
    config = AgentConfig(approval=ApprovalConfig(mode=ApprovalMode.MANUAL))
    app = create_app(config, service_factory=lambda: StubService(DecisionOutcome.APPROVE))
    client = TestClient(app)
    created = client.post("/requests", json=_payload()).json()
    first = client.post(f"/requests/{created['id']}/deny")
    assert first.status_code == 200
    assert first.json()["status"] == "denied"
    resp = client.post(f"/requests/{created['id']}/deny")
    assert resp.status_code == 409


def test_approve_resolves_escalated_request():
    config = AgentConfig(approval=ApprovalConfig(mode=ApprovalMode.AUTO_WITH_NOTIFICATION))
    app = create_app(
        config,
        service_factory=lambda: StubService(
            DecisionOutcome.DENY, approve_outcome=DecisionOutcome.APPROVE
        ),
    )
    client = TestClient(app)
    created = client.post("/requests", json=_payload()).json()
    assert created["status"] == "escalated"

    resp = client.post(f"/requests/{created['id']}/approve")
    assert resp.status_code == 200
    assert resp.json()["status"] == "approved"


def test_deny_resolves_escalated_request():
    config = AgentConfig(approval=ApprovalConfig(mode=ApprovalMode.AUTO_WITH_NOTIFICATION))
    app = create_app(
        config,
        service_factory=lambda: StubService(DecisionOutcome.DENY),
    )
    client = TestClient(app)
    created = client.post("/requests", json=_payload()).json()
    assert created["status"] == "escalated"

    resp = client.post(f"/requests/{created['id']}/deny")
    assert resp.status_code == 200
    assert resp.json()["status"] == "denied"


class RaisingService:
    """Service whose evaluation always raises an unexpected error."""

    async def decide(self, request: VerificationRequest) -> ApprovalDecision:
        raise RuntimeError("boom")

    async def approve(
        self, request: VerificationRequest, requester_did: str | None = None
    ) -> ApprovalDecision:
        raise RuntimeError("boom")


def test_request_id_is_full_uuid():
    app = create_app(AgentConfig(approval=ApprovalConfig(mode=ApprovalMode.MANUAL)))
    client = TestClient(app)
    rid = client.post("/requests", json=_payload()).json()["id"]
    assert len(rid) == 32
    assert all(c in "0123456789abcdef" for c in rid)


def test_manual_approve_denied_outcome_is_terminal_not_escalated():
    # Under auto-with-notification, a human's denial must resolve to DENIED, not re-escalate.
    config = AgentConfig(approval=ApprovalConfig(mode=ApprovalMode.AUTO_WITH_NOTIFICATION))
    app = create_app(
        config,
        service_factory=lambda: StubService(
            DecisionOutcome.DENY, approve_outcome=DecisionOutcome.DENY
        ),
    )
    client = TestClient(app)
    created = client.post("/requests", json=_payload()).json()
    assert created["status"] == "escalated"
    resp = client.post(f"/requests/{created['id']}/approve")
    assert resp.status_code == 200
    assert resp.json()["status"] == "denied"


def test_create_request_records_error_on_unexpected_failure():
    repo = RequestRepository()
    config = AgentConfig(approval=ApprovalConfig(mode=ApprovalMode.FULLY_AUTONOMOUS))
    app = create_app(config, service_factory=lambda: RaisingService(), repository=repo)
    client = TestClient(app)
    resp = client.post("/requests", json=_payload())
    assert resp.status_code == 500
    stored = repo.list()
    assert len(stored) == 1
    assert stored[0].status is RequestStatus.ERROR


def test_approve_records_error_on_unexpected_failure():
    repo = RequestRepository()
    config = AgentConfig(approval=ApprovalConfig(mode=ApprovalMode.MANUAL))
    app = create_app(config, service_factory=lambda: RaisingService(), repository=repo)
    client = TestClient(app)
    created = client.post("/requests", json=_payload()).json()
    assert created["status"] == "pending"
    resp = client.post(f"/requests/{created['id']}/approve")
    assert resp.status_code == 500
    stored = repo.get(created["id"])
    assert stored is not None
    assert stored.status is RequestStatus.ERROR


def test_default_app_lifespan_closes_cleanly():
    # Exercises the default factory + shared ZKPClient lifespan (startup/shutdown).
    app = create_app(AgentConfig(approval=ApprovalConfig(mode=ApprovalMode.MANUAL)))
    with TestClient(app) as client:
        assert client.get("/health").json()["status"] == "healthy"


def test_a_stated_scope_must_be_the_claims() -> None:
    client = TestClient(create_app(AgentConfig()))
    resp = client.post("/requests", json={**_payload(), "context_scope": "root/identity"})
    assert resp.status_code == 422
    assert "personal/age" in resp.json()["detail"]
    resp = client.post("/requests", json={**_payload(), "context_scope": None})
    assert resp.status_code == 201
    assert resp.json()["context_scope"] == "personal/age"  # the record names the governing scope


def test_unsupported_claim_types_are_refused_at_creation() -> None:
    client = TestClient(create_app(AgentConfig()))
    payload = {**_payload(), "claim": {"type": "income", "params": {}}}
    resp = client.post("/requests", json=payload)
    assert resp.status_code == 422
    assert "income" in resp.json()["detail"]


def _attested(request_id: str, key: Ed25519PrivateKey | None = None) -> dict[str, str]:
    """An approve body the holder of a fresh ephemeral did:key signed for this request."""
    key = key or Ed25519PrivateKey.generate()
    did = did_key(key)
    signature = sign_approval(key, request_id, did)
    return {"requester_did": did, "signature": base64.b64encode(signature).decode()}


def _manual_client(service: StubService | None = None) -> TestClient:
    config = AgentConfig(approval=ApprovalConfig(mode=ApprovalMode.MANUAL))
    svc = service or StubService(DecisionOutcome.APPROVE)
    return TestClient(create_app(config, service_factory=lambda: svc))


_open_clients: list[TestClient] = []


@pytest.fixture(autouse=True)
def _close_clients():  # noqa: ANN202 - a fixture with nothing to return
    """Exit every test client a test opened, so each app's lifespan shuts down."""
    yield
    while _open_clients:
        _open_clients.pop().__exit__(None, None, None)


class _Vault:
    """A user's vault with a root identity and the records its root signed."""

    def __init__(self) -> None:
        self.root, self.root_did, public = _root()
        self.record_keys: dict[str, str] = {}
        self.store = FakeStore(
            {
                "personal-context": {"birthDate": "1990-05-15"},
                "root-identity": {
                    "did": self.root_did,
                    "publicKey": list(public),
                    "privateKey": [0] * 32,
                    "createdAt": "2026-11-05T09:00:00Z",
                },
            }
        )

    def issue(self, key: Ed25519PrivateKey, signer: Ed25519PrivateKey | None = None) -> str:
        """Keep a record for key's DID, signed by the root unless another signer is given.

        Returns the store key the record is under, as the user's app knows it.
        """
        record = _signed(signer or self.root, self.root_did, did_key(key))
        store_key = "identity/authorizations/" + did_key(key)[-8:]
        self.store.put(store_key, record)
        self.record_keys[did_key(key)] = store_key
        return store_key

    def approval(self, request_id: str, key: Ed25519PrivateKey) -> dict[str, str]:
        """The approve body the user's app sends for key's DID: attestation plus record key."""
        return {**_attested(request_id, key), "record_key": self.record_keys[did_key(key)]}

    def client(
        self,
        service: StubService | None = None,
        unlocked: bool = True,
        repository: RequestRepository | None = None,
    ) -> TestClient:
        """A manual-mode app over this vault, unlocked unless told otherwise."""
        context = _vault_client(self.store)
        config = AgentConfig(approval=ApprovalConfig(mode=ApprovalMode.MANUAL))
        svc = service or StubService(DecisionOutcome.APPROVE)
        app = create_app(
            config, service_factory=lambda: svc, context_client=context, repository=repository
        )
        client = TestClient(app)
        client.__enter__()
        _open_clients.append(client)
        if unlocked:
            assert (
                client.post("/unlock", json={"user_id": USER, "password": PASSWORD}).status_code
                == 204
            )
        return client


def test_approve_records_the_did_the_proof_names_and_the_holders_attestation() -> None:
    class Recording(StubService):
        """Approves everything and remembers which DID each approval named."""

        def __init__(self) -> None:
            super().__init__(DecisionOutcome.APPROVE)
            self.dids: list[str | None] = []

        async def approve(
            self, request: VerificationRequest, requester_did: str | None = None
        ) -> ApprovalDecision:
            self.dids.append(requester_did)
            return ApprovalDecision(
                outcome=DecisionOutcome.APPROVE,
                reason="verified",
                proof={"ok": True},
                requester_did=requester_did,
            )

    service = Recording()
    vault = _Vault()
    key = Ed25519PrivateKey.generate()
    vault.issue(key)
    client = vault.client(service)
    created = client.post("/requests", json=_payload()).json()
    body = vault.approval(created["id"], key)
    resp = client.post(f"/requests/{created['id']}/approve", json=body)
    assert resp.status_code == 200
    assert resp.json()["response"]["requester_did"] == body["requester_did"]
    attestation = {k: v for k, v in body.items() if k != "record_key"}
    assert resp.json()["response"]["attestation"] == attestation
    assert service.dids == [body["requester_did"]]

    bare = client.post("/requests", json=_payload()).json()
    resp = client.post(f"/requests/{bare['id']}/approve")
    assert resp.status_code == 200
    assert resp.json()["response"]["requester_did"] is None
    assert resp.json()["response"]["attestation"] is None


def test_an_approval_that_produced_no_proof_stores_no_attestation() -> None:
    vault = _Vault()
    key = Ed25519PrivateKey.generate()
    vault.issue(key)
    client = vault.client(StubService(DecisionOutcome.APPROVE, DecisionOutcome.ERROR))
    created = client.post("/requests", json=_payload()).json()
    resp = client.post(
        f"/requests/{created['id']}/approve", json=vault.approval(created["id"], key)
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "error"
    assert resp.json()["response"]["attestation"] is None
    assert resp.json()["response"]["requester_did"] is None


def test_a_did_the_vaults_root_issued_is_accepted() -> None:
    vault = _Vault()
    key = Ed25519PrivateKey.generate()
    vault.issue(key)
    client = vault.client()
    created = client.post("/requests", json=_payload()).json()
    resp = client.post(
        f"/requests/{created['id']}/approve", json=vault.approval(created["id"], key)
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "approved"


def test_an_approval_that_says_where_its_record_is_needs_one_read() -> None:
    vault = _Vault()
    for _ in range(5):
        vault.issue(Ed25519PrivateKey.generate())
    key = Ed25519PrivateKey.generate()
    record_key = vault.issue(key)
    client = vault.client()
    created = client.post("/requests", json=_payload()).json()
    del vault.store.requests[:]
    body = {**_attested(created["id"], key), "record_key": record_key}
    resp = client.post(f"/requests/{created['id']}/approve", json=body)
    assert resp.status_code == 200
    reads = [r.url.path for r in vault.store.requests if r.url.path.startswith("/entries/")]
    assert sorted(reads) == sorted(["/entries/root-identity", "/entries/" + record_key])

    # A key that holds nothing, or another DID's record, does not vouch for this one.
    other = client.post("/requests", json=_payload()).json()
    missing = {**_attested(other["id"], key), "record_key": "identity/authorizations/nothing"}
    assert client.post(f"/requests/{other['id']}/approve", json=missing).status_code == 403
    wrong = {**_attested(other["id"], key), "record_key": vault.issue(Ed25519PrivateKey.generate())}
    assert client.post(f"/requests/{other['id']}/approve", json=wrong).status_code == 403


def test_a_denial_that_lands_while_the_proof_is_made_is_not_overwritten() -> None:
    repo = RequestRepository()

    class DenyMeanwhile(StubService):
        """Approves, but the user denied the request while the proof was being made."""

        async def approve(
            self, request: VerificationRequest, requester_did: str | None = None
        ) -> ApprovalDecision:
            repo.replace(request.model_copy(update={"status": RequestStatus.DENIED}))
            return ApprovalDecision(outcome=DecisionOutcome.APPROVE, reason="verified", proof={})

    vault = _Vault()
    key = Ed25519PrivateKey.generate()
    vault.issue(key)
    client = vault.client(DenyMeanwhile(DecisionOutcome.APPROVE), repository=repo)
    created = client.post("/requests", json=_payload()).json()
    body = vault.approval(created["id"], key)
    resp = client.post(f"/requests/{created['id']}/approve", json=body)
    assert resp.status_code == 409
    assert client.get(f"/requests/{created['id']}").json()["status"] == "denied"


@pytest.mark.parametrize("record_key", ["personal-context", "identity/authorizations/", "../x"])
def test_a_record_key_outside_the_records_is_refused_at_the_door(record_key: str) -> None:
    vault = _Vault()
    key = Ed25519PrivateKey.generate()
    vault.issue(key)
    client = vault.client()
    created = client.post("/requests", json=_payload()).json()
    # The 422 is the body model's: the key's shape is wrong, whatever the signature says.
    body = {**_attested(created["id"], key), "record_key": record_key}
    assert client.post(f"/requests/{created['id']}/approve", json=body).status_code == 422


def test_a_did_the_vault_holds_no_record_for_is_refused_and_nothing_is_approved() -> None:
    vault = _Vault()
    other = vault.issue(Ed25519PrivateKey.generate())  # Some other DID of the user's.
    client = vault.client()
    created = client.post("/requests", json=_payload()).json()
    body = {**_attested(created["id"]), "record_key": other}
    resp = client.post(f"/requests/{created['id']}/approve", json=body)
    assert resp.status_code == 403
    assert resp.json()["detail"] == "the vault does not vouch for this DID"
    assert client.get(f"/requests/{created['id']}").json()["status"] == "pending"


def test_a_record_another_root_signed_is_refused() -> None:
    vault = _Vault()
    key = Ed25519PrivateKey.generate()
    vault.issue(key, signer=Ed25519PrivateKey.generate())
    client = vault.client()
    created = client.post("/requests", json=_payload()).json()
    resp = client.post(
        f"/requests/{created['id']}/approve", json=vault.approval(created["id"], key)
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "the vault does not vouch for this DID"


def test_a_vault_without_a_root_identity_cannot_vouch_for_any_did() -> None:
    vault = _Vault()
    key = Ed25519PrivateKey.generate()
    vault.issue(key)
    del vault.store.entries["root-identity"]
    client = vault.client()
    created = client.post("/requests", json=_payload()).json()
    resp = client.post(
        f"/requests/{created['id']}/approve", json=vault.approval(created["id"], key)
    )
    assert resp.status_code == 403
    assert resp.json()["detail"] == "the vault does not vouch for this DID"


def test_a_locked_vault_cannot_vouch_so_a_named_did_is_refused_for_a_retry() -> None:
    vault = _Vault()
    key = Ed25519PrivateKey.generate()
    vault.issue(key)
    client = vault.client(unlocked=False)
    created = client.post("/requests", json=_payload()).json()
    resp = client.post(
        f"/requests/{created['id']}/approve", json=vault.approval(created["id"], key)
    )
    assert resp.status_code == 409
    assert "locked" in resp.json()["detail"]
    assert client.get(f"/requests/{created['id']}").json()["status"] == "pending"


def test_an_unreachable_store_cannot_vouch_either() -> None:
    vault = _Vault()
    key = Ed25519PrivateKey.generate()
    vault.issue(key)
    client = vault.client()
    created = client.post("/requests", json=_payload()).json()
    vault.store.unreachable = True
    resp = client.post(
        f"/requests/{created['id']}/approve", json=vault.approval(created["id"], key)
    )
    assert resp.status_code == 503
    assert client.get(f"/requests/{created['id']}").json()["status"] == "pending"


def test_a_did_nobody_signed_for_is_not_accepted() -> None:
    client = _manual_client()
    created = client.post("/requests", json=_payload()).json()
    resp = client.post(
        f"/requests/{created['id']}/approve", json={"requester_did": "did:key:z6MkEphemeral"}
    )
    assert resp.status_code == 422
    resp = client.post(f"/requests/{created['id']}/approve", json={"signature": "AAAA"})
    assert resp.status_code == 422
    # A DID and signature without the record's key are refused at the door too.
    attested = _attested(created["id"])
    assert client.post(f"/requests/{created['id']}/approve", json=attested).status_code == 422
    assert client.get(f"/requests/{created['id']}").json()["status"] == "pending"


def test_an_attestation_for_another_request_is_refused_and_nothing_is_approved() -> None:
    vault = _Vault()
    key = Ed25519PrivateKey.generate()
    vault.issue(key)
    client = vault.client()
    first = client.post("/requests", json=_payload()).json()
    second = client.post("/requests", json=_payload()).json()
    body = vault.approval(first["id"], key)
    resp = client.post(f"/requests/{second['id']}/approve", json=body)
    assert resp.status_code == 403
    assert "possession" in resp.json()["detail"]
    assert client.get(f"/requests/{second['id']}").json()["status"] == "pending"
    assert client.post(f"/requests/{first['id']}/approve", json=body).status_code == 200


def test_a_signature_by_a_key_other_than_the_dids_is_refused() -> None:
    client = _manual_client()
    created = client.post("/requests", json=_payload()).json()
    body = {**_attested(created["id"]), "record_key": "identity/authorizations/any"}
    body["requester_did"] = did_key(Ed25519PrivateKey.generate())
    resp = client.post(f"/requests/{created['id']}/approve", json=body)
    assert resp.status_code == 403


def test_a_business_cannot_name_the_requester_through_claim_params() -> None:
    client = TestClient(create_app(AgentConfig()))
    payload = {
        **_payload(),
        "claim": {"type": "age", "params": {"minAge": 18, "requesterDid": "x"}},
    }
    resp = client.post("/requests", json=payload)
    assert resp.status_code == 422
    assert "requesterDid" in resp.json()["detail"]


@pytest.mark.parametrize(
    "did",
    ["not a did", "did:key:", "did:key:abc:", "did:web:ex%2", "did:web:ex%zz", "DID:key:abc"],
)
def test_approve_rejects_a_malformed_did(did: str) -> None:
    client = _manual_client()
    created = client.post("/requests", json=_payload()).json()
    resp = client.post(
        f"/requests/{created['id']}/approve", json={"requester_did": did, "signature": "AAAA"}
    )
    assert resp.status_code == 422


@pytest.mark.parametrize("did", ["did:web:example.com:user", "did:plc:ab%2Fcd"])
def test_a_did_whose_key_the_identifier_does_not_carry_cannot_prove_possession(
    did: str,
) -> None:
    client = _manual_client()
    created = client.post("/requests", json=_payload()).json()
    body = {
        **_attested(created["id"]),
        "requester_did": did,
        "record_key": "identity/authorizations/any",
    }
    resp = client.post(f"/requests/{created['id']}/approve", json=body)
    assert resp.status_code == 403
    assert "did:key" in resp.json()["detail"]


def test_autonomous_approval_states_it_names_no_did() -> None:
    config = AgentConfig(approval=ApprovalConfig(mode=ApprovalMode.FULLY_AUTONOMOUS))
    client = TestClient(
        create_app(config, service_factory=lambda: StubService(DecisionOutcome.APPROVE))
    )
    created = client.post("/requests", json=_payload()).json()
    assert created["status"] == "approved"
    assert "requester_did" in created["response"]
    assert created["response"]["requester_did"] is None
