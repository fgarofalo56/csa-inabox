"""CSA Loom Setup Orchestrator — two-tier conversational deploy backend.

Tier dispatch (selected at startup from AGENT_ORCHESTRATOR env):
  - foundry-agent-service: route via Foundry Agent Service tool calls
  - maf:                   route via Microsoft Agent Framework 1.0 +
                           direct AOAI calls (Gov fallback)

Both tiers expose the same FastAPI surface to the Console wizard pane:
  POST /api/setup/deploy   — start a deployment
  GET  /api/setup/{id}     — poll status
  GET  /api/setup/{id}/sse — Server-Sent Events stream of progress
"""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
from contextlib import asynccontextmanager
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from .orchestrator import OrchestratorBase, FoundryOrchestrator, MafOrchestrator
from .deployment_state import DeploymentStateStore
from .telemetry import configure_telemetry

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s — %(message)s")

# Configure App Insights at module import (idempotent; no-op if env unset)
configure_telemetry(
    service_name="loom-setup-orchestrator",
    extra_resource_attrs={
        "csa-loom.app": "setup-orchestrator",
    },
)


# =====================================================================
# Request / response shapes
# =====================================================================


class DeployRequest(BaseModel):
    """Deploy payload the Console BFF (/api/setup/deploy) POSTs.

    The wizard sends camelCase keys, so every field carries a camelCase
    ``alias`` and ``populate_by_name=True`` lets the deterministic tests still
    construct it with the snake_case field names. Extra wizard state fields are
    ignored.
    """

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    boundary: Literal["Commercial", "GCC", "GCC-High", "IL5"]
    mode: Literal["single-sub", "multi-sub"]
    domain_name: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9-]+$", alias="domainName")
    capacity_sku: Literal["F2", "F4", "F8", "F32", "F64", "F128", "F512"] = Field(alias="capacitySku")
    # The hub/admin subscription the subscription-scoped deployment targets.
    subscription_id: str | None = Field(default=None, alias="subscriptionId")
    target_subscription_id: str | None = None
    # Region the `az deployment sub create` lands in (wizard sends both).
    region: str | None = None
    location: str | None = None
    # Multi-sub: parallel arrays the main.bicep `[for]` loop consumes.
    dlz_subscription_ids: list[str] | None = Field(default=None, alias="dlzSubscriptionIds")
    dlz_domain_names: list[str] | None = Field(default=None, alias="dlzDomainNames")
    vanity_domain: str | None = Field(default=None, alias="vanityDomain")


class DeployResponse(BaseModel):
    deployment_id: str
    status: Literal["queued"] = "queued"
    stream_url: str


class DeploymentStatus(BaseModel):
    deployment_id: str
    status: Literal["queued", "running", "succeeded", "failed"]
    progress: float = Field(ge=0, le=1)
    current_stage: str
    error: str | None = None
    bicep_parameters: dict[str, Any]
    started_at: str
    completed_at: str | None = None


# =====================================================================
# App + orchestrator wiring
# =====================================================================


orchestrator: OrchestratorBase | None = None
state_store: DeploymentStateStore | None = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    global orchestrator, state_store
    mode = os.environ.get("AGENT_ORCHESTRATOR", "foundry-agent-service")
    state_store = DeploymentStateStore()
    if mode == "foundry-agent-service":
        orchestrator = FoundryOrchestrator(state_store=state_store)
    elif mode == "maf":
        orchestrator = MafOrchestrator(state_store=state_store)
    else:
        raise RuntimeError(f"Unknown AGENT_ORCHESTRATOR: {mode}")
    logger.info("Orchestrator wired: %s", mode)
    yield


app = FastAPI(title="CSA Loom Setup Orchestrator", lifespan=lifespan)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/setup/deploy", response_model=DeployResponse)
async def deploy(req: DeployRequest, request: Request) -> DeployResponse:
    if orchestrator is None or state_store is None:
        raise HTTPException(503, "Orchestrator not initialized")

    # Extract caller identity from the BFF's session header
    caller_oid = request.headers.get("x-loom-caller-oid")
    if not caller_oid:
        raise HTTPException(401, "Missing x-loom-caller-oid header (BFF-injected)")

    deployment_id = str(uuid.uuid4())
    await state_store.create(
        deployment_id=deployment_id,
        request=req.model_dump(),
        caller_oid=caller_oid,
    )

    # Kick off async deployment
    asyncio.create_task(orchestrator.deploy(deployment_id, req, caller_oid))

    return DeployResponse(
        deployment_id=deployment_id,
        stream_url=f"/api/setup/{deployment_id}/sse",
    )


@app.get("/api/setup/{deployment_id}", response_model=DeploymentStatus)
async def get_status(deployment_id: str) -> DeploymentStatus:
    if state_store is None:
        raise HTTPException(503, "State store not initialized")
    state = await state_store.get(deployment_id)
    if state is None:
        raise HTTPException(404, "Deployment not found")
    return DeploymentStatus(**state)


@app.get("/api/setup/{deployment_id}/sse")
async def stream_status(deployment_id: str) -> StreamingResponse:
    """Server-Sent Events stream of deployment progress."""
    if state_store is None:
        raise HTTPException(503, "State store not initialized")

    async def event_gen():
        last_progress = -1.0
        while True:
            state = await state_store.get(deployment_id)
            if state is None:
                yield f"event: error\ndata: deployment not found\n\n"
                return
            if state["progress"] != last_progress:
                last_progress = state["progress"]
                yield f"event: progress\ndata: {state['progress']}\n\n"
                yield f"event: stage\ndata: {state['current_stage']}\n\n"
            if state["status"] in ("succeeded", "failed"):
                yield f"event: {state['status']}\ndata: {state.get('error') or 'ok'}\n\n"
                return
            await asyncio.sleep(1)

    return StreamingResponse(event_gen(), media_type="text/event-stream")
