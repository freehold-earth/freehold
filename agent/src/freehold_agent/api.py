"""FastAPI coordination service.

Thin controllers only: build the request model, run the mode-appropriate
path, and serialize. All decision logic lives in ApprovalService.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import AsyncIterator, Callable
from contextlib import AsyncExitStack, asynccontextmanager
from datetime import UTC, datetime, timedelta
from typing import Protocol

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from freehold_agent._version import __version__
from freehold_agent.config import AgentConfig
from freehold_agent.context import ContextClient
from freehold_agent.coordination import (
    ApprovalDecision,
    ApprovalMode,
    CreateServiceRequest,
    RequestStatus,
    ServiceRequest,
    ServiceRequestStatus,
    VerificationClaim,
    VerificationRequest,
)
from freehold_agent.errors import (
    ContextKeyInvalid,
    ContextLocked,
    ContextUnavailable,
    ServiceRequestConflict,
    ServiceRequestNotFound,
)
from freehold_agent.policy import PolicyChecker
from freehold_agent.seams import (
    ContextStoreDataProvider,
    DeterministicContextBuilder,
)
from freehold_agent.services import service_requests
from freehold_agent.services.approval import (
    CLAIM_INPUTS,
    ApprovalService,
    resolved_status_for,
    status_for,
)
from freehold_agent.status import ServicesStatus, StatusClient
from freehold_agent.store import RequestRepository, ServiceRequestRepository
from freehold_agent.zkp import ZKPClient

ZKP_SERVICE_URL = os.environ.get("ZKP_SERVICE_URL", "http://localhost:8084")
CARDANO_API_URL = os.environ.get("CARDANO_API_URL", "http://localhost:8080")


class _Decider(Protocol):
    async def decide(self, request: VerificationRequest) -> ApprovalDecision: ...

    async def approve(self, request: VerificationRequest) -> ApprovalDecision: ...


class _StatusSource(Protocol):
    async def check(self) -> ServicesStatus: ...


class UnlockRequest(BaseModel):
    """Inbound payload for POST /unlock: the vault secret the agent reads with.

    The user id travels to the store as a header, so it is held to a plain
    token shape rather than relying on the transport to refuse odd bytes.
    """

    user_id: str = Field(pattern=r"^[A-Za-z0-9._-]{1,128}$")
    password: str


class CreateVerificationRequest(BaseModel):
    """Inbound payload for POST /requests."""

    business_id: str
    business_name: str
    claim: VerificationClaim
    policy_id: str | None = None
    context_scope: str | None = None
    service_request_id: str | None = None


def _default_service_factory(
    zkp_client: ZKPClient, context_client: ContextClient
) -> Callable[[], _Decider]:
    """Build approval services that share the app's ZKP and context clients."""

    def factory() -> _Decider:
        return ApprovalService(
            PolicyChecker(),
            DeterministicContextBuilder(),
            ContextStoreDataProvider(context_client),
            zkp_client,
        )

    return factory


def create_app(
    config: AgentConfig | None = None,
    *,
    service_factory: Callable[[], _Decider] | None = None,
    repository: RequestRepository | None = None,
    service_request_repository: ServiceRequestRepository | None = None,
    status_source: _StatusSource | None = None,
    context_client: ContextClient | None = None,
) -> FastAPI:
    """Build the coordination app.

    Args:
        config: Agent configuration; defaults to AgentConfig().
        service_factory: Builds the approval decider (injected in tests). When
            omitted, one shared ZKPClient is created for the app's lifetime and
            closed on shutdown.
        context_client: Reads the user's context store (injected in tests).
            When omitted one is built from the config. Either way the app
            owns it for its lifetime: POST /unlock hands it the vault secret,
            every approval reads through it, and shutdown disconnects it.
        repository: Request store (injected in tests).
        service_request_repository: Service-request store (injected in tests).
        status_source: Provides the /services aggregate (injected in tests).
            When omitted, one shared StatusClient is created for the app's
            lifetime and closed on shutdown.

    Returns:
        The configured FastAPI application.
    """
    config = config or AgentConfig()
    repo = repository or RequestRepository()
    service_repo = service_request_repository or ServiceRequestRepository()

    # One context client for the app: it holds the vault secret between
    # /unlock and the approvals that read with it, so it cannot be rebuilt per
    # request the way the service is.
    context = context_client or ContextClient(config.context)

    # A single ZKPClient owns one connection pool for the app's lifetime; the
    # per-request service is otherwise cheap to rebuild. Tests inject their own
    # factory and so never create the shared client.
    zkp_client: ZKPClient | None = None
    if service_factory is None:
        zkp_client = ZKPClient(ZKP_SERVICE_URL)
        make_service: Callable[[], _Decider] = _default_service_factory(zkp_client, context)
    else:
        make_service = service_factory

    status_client: StatusClient | None = None
    if status_source is None:
        agent_url = f"http://localhost:{os.environ.get('PORT', '8082')}"
        status_client = StatusClient(
            agent_url=agent_url, zkp_url=ZKP_SERVICE_URL, cardano_url=CARDANO_API_URL
        )
        status_checker: _StatusSource = status_client
    else:
        status_checker = status_source

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        """Close the shared clients on shutdown, each regardless of the others.

        The context client also forgets its vault secret on disconnect.
        """
        async with AsyncExitStack() as stack:
            if status_client is not None:
                stack.push_async_callback(status_client.aclose)
            if zkp_client is not None:
                stack.push_async_callback(zkp_client.aclose)
            stack.push_async_callback(context.disconnect)
            yield

    app = FastAPI(title="freehold-agent", version=__version__, lifespan=lifespan)
    # The demo apps are browser pages on their own origins; without this the
    # browser refuses their calls. An allowlist, never a wildcard, and no
    # credentials: the API has no cookies or auth headers to forward.
    app.add_middleware(
        CORSMiddleware,
        allow_origins=config.cors_origins,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type"],
    )

    @app.get("/health")
    async def health() -> dict[str, str]:
        """Report liveness for container health checks, and whether the vault is unlocked."""
        return {
            "status": "healthy",
            "service": "freehold-agent",
            "vault": "unlocked" if context.is_unlocked else "locked",
        }

    def refuse_foreign_origin(request: Request) -> None:
        """403 a browser request from an origin outside the allowlist.

        CORS only withholds the response from such a page; the request itself
        still runs. The vault endpoints change state, so they refuse it.
        """
        origin = request.headers.get("origin")
        if origin is not None and origin not in config.cors_origins:
            raise HTTPException(status_code=403, detail="origin not allowed")

    def owned_by_unlocked_user(req: VerificationRequest) -> bool:
        """Whether an unlocked vault, if any, is the request's service request's user's.

        A locked vault has no opinion: the approval then fails on its own,
        as "private data unavailable". The guard is against deciding user A's
        request from user B's data while B's vault is open.
        """
        if req.service_request_id is None or context.user_id is None:
            return True
        service_req = service_repo.get(req.service_request_id)
        return service_req is None or service_req.user_id == context.user_id

    @app.post("/unlock", status_code=204)
    async def unlock(payload: UnlockRequest, request: Request) -> None:
        """Hold the user's vault secret so approvals can read their context.

        The password is checked against a stored entry before it is held:
        a wrong one is 401, a store that cannot be reached is 503, a lock
        that arrives during the check is 409.
        """
        refuse_foreign_origin(request)
        try:
            await context.unlock(payload.user_id, payload.password)
        except ContextKeyInvalid as exc:
            raise HTTPException(status_code=401, detail="wrong password") from exc
        except ContextLocked as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        except ContextUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    @app.post("/lock", status_code=204)
    async def lock(request: Request) -> None:
        """Forget the vault secret; approvals fail with 'context store locked' until unlock."""
        refuse_foreign_origin(request)
        context.lock()

    @app.get("/requests")
    async def list_requests() -> dict[str, list[VerificationRequest]]:
        """Return every tracked verification request."""
        return {"requests": repo.list()}

    @app.get("/requests/{request_id}")
    async def get_request(request_id: str) -> VerificationRequest:
        """Return a single request, or 404 if it is not tracked."""
        req = repo.get(request_id)
        if req is None:
            raise HTTPException(status_code=404, detail="request not found")
        return req

    @app.post("/requests", status_code=201)
    async def create_request(payload: CreateVerificationRequest) -> VerificationRequest:
        """Create a request; autonomously resolve it unless in manual mode.

        A claim type without inputs here (CLAIM_INPUTS) cannot be proved, so
        it is refused rather than stored. The claim type decides which scope
        is read; a request may state that scope, but not another, so the
        record never shows a scope that did not govern the decision.
        """
        inputs = CLAIM_INPUTS.get(payload.claim.type)
        if inputs is None:
            raise HTTPException(
                status_code=422, detail=f"unsupported claim type: {payload.claim.type!r}"
            )
        if payload.context_scope is not None and payload.context_scope != inputs.scope:
            raise HTTPException(
                status_code=422,
                detail=f"context_scope for an {payload.claim.type!r} claim is {inputs.scope!r}",
            )
        # Stored as the scope that governs the decision, so the record says so
        # whether or not the business stated it.
        now = datetime.now(UTC)
        req = VerificationRequest(
            id=uuid.uuid4().hex,
            business_id=payload.business_id,
            business_name=payload.business_name,
            claim=payload.claim,
            policy_id=payload.policy_id,
            context_scope=inputs.scope,
            service_request_id=payload.service_request_id,
            created_at=now,
            expires_at=now + timedelta(minutes=5),
        )
        try:
            service_requests.link_verification(service_repo, req)
        except ServiceRequestNotFound as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ServiceRequestConflict as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        # Autonomous approval reads the unlocked user's vault, so a request
        # for someone else's service request waits for that someone's unlock.
        if config.approval.mode is not ApprovalMode.MANUAL and owned_by_unlocked_user(req):
            try:
                decision = await make_service().decide(req)
            except Exception as exc:
                repo.add(_as_error(req))
                raise HTTPException(status_code=500, detail="approval evaluation failed") from exc
            req = req.model_copy(
                update={
                    "status": status_for(decision.outcome, config.approval.mode),
                    "response": {"reason": decision.reason, "proof": decision.proof},
                }
            )
        repo.add(req)
        service_requests.apply_verification_outcome(service_repo, req)
        return req

    @app.post("/requests/{request_id}/approve")
    async def approve_request(request_id: str) -> VerificationRequest:
        """Resolve a pending or escalated request by human approval."""
        req = repo.get(request_id)
        if req is None:
            raise HTTPException(status_code=404, detail="request not found")
        if req.status not in (RequestStatus.PENDING, RequestStatus.ESCALATED):
            raise HTTPException(status_code=409, detail="request already resolved")
        if not owned_by_unlocked_user(req):
            raise HTTPException(
                status_code=409, detail="the unlocked vault is not this request's user's"
            )

        try:
            decision = await make_service().approve(req)
        except Exception as exc:
            repo.replace(_as_error(req))
            raise HTTPException(status_code=500, detail="approval evaluation failed") from exc
        req = req.model_copy(
            update={
                "status": resolved_status_for(decision.outcome),
                "response": {"reason": decision.reason, "proof": decision.proof},
            }
        )
        repo.replace(req)
        service_requests.apply_verification_outcome(service_repo, req)
        return req

    @app.post("/requests/{request_id}/deny")
    async def deny_request(request_id: str) -> VerificationRequest:
        """Resolve a pending or escalated request as denied by the user."""
        req = repo.get(request_id)
        if req is None:
            raise HTTPException(status_code=404, detail="request not found")
        if req.status not in (RequestStatus.PENDING, RequestStatus.ESCALATED):
            raise HTTPException(status_code=409, detail="request already resolved")

        req = req.model_copy(
            update={
                "status": RequestStatus.DENIED,
                "response": {"reason": "denied by user"},
            }
        )
        repo.replace(req)
        service_requests.apply_verification_outcome(service_repo, req)
        return req

    @app.get("/services")
    async def services_status() -> ServicesStatus:
        """Report reachability of the agent and its coordinated services."""
        return await status_checker.check()

    @app.get("/service-requests")
    async def list_service_requests(
        status: ServiceRequestStatus | None = None,
    ) -> dict[str, list[ServiceRequest]]:
        """Return tracked service requests, optionally filtered by status."""
        requests = service_repo.list()
        if status is not None:
            requests = [r for r in requests if r.status is status]
        return {"requests": requests}

    @app.get("/service-requests/{request_id}")
    async def get_service_request(request_id: str) -> ServiceRequest:
        """Return a single service request, or 404 if it is not tracked."""
        service_req = service_repo.get(request_id)
        if service_req is None:
            raise HTTPException(status_code=404, detail="service request not found")
        return service_req

    @app.post("/service-requests", status_code=201)
    async def create_service_request(payload: CreateServiceRequest) -> ServiceRequest:
        """Create a pending service request for the business to pick up."""
        return service_requests.create(service_repo, payload)

    @app.post("/service-requests/{request_id}/complete")
    async def complete_service_request(request_id: str) -> ServiceRequest:
        """Complete a verified service request.

        Completing an already-completed request is idempotent and returns the
        request unchanged with 200; any other unverified state is a 409.
        """
        try:
            return service_requests.complete(service_repo, request_id)
        except ServiceRequestNotFound as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ServiceRequestConflict as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    return app


def _as_error(req: VerificationRequest) -> VerificationRequest:
    """Return a copy of the request marked as failed, for durable auditing."""
    return req.model_copy(
        update={
            "status": RequestStatus.ERROR,
            "response": {"reason": "approval evaluation failed"},
        }
    )
