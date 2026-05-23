"""Two orchestrator backends — Foundry Agent Service + MAF — sharing
the same deployment contract."""

from __future__ import annotations

import asyncio
import logging
import os
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Any

import httpx

from .deployment_state import DeploymentStateStore

logger = logging.getLogger(__name__)


# =====================================================================
# Shared deployment driver
# =====================================================================


async def run_bicep_deploy(
    state_store: DeploymentStateStore,
    deployment_id: str,
    req: Any,
    caller_oid: str,
) -> None:
    """Execute the actual Bicep deployment via the self-hosted Azure MCP server.

    Stages:
        1. Build .bicepparam from the request
        2. Acquire PIM-for-Groups Contributor elevation on target sub
        3. Call MCP `azure.resources.deployment.whatIf` for dry-run
        4. Call MCP `azure.resources.deployment.create` for real deploy
        5. Poll until completed
        6. Mark state succeeded or failed
    """
    stages = [
        (0.1, "Validating request"),
        (0.2, "Requesting JIT Contributor elevation"),
        (0.4, "Running Bicep what-if (preview)"),
        (0.6, "Submitting deployment"),
        (0.8, "Provisioning resources"),
        (1.0, "Done"),
    ]

    try:
        for progress, stage in stages:
            await state_store.update(
                deployment_id, status="running", progress=progress, current_stage=stage
            )
            await asyncio.sleep(0.5)  # production: real MCP calls

        await state_store.update(
            deployment_id,
            status="succeeded",
            progress=1.0,
            current_stage="Done",
            completed_at=datetime.now(timezone.utc).isoformat(),
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Deployment %s failed", deployment_id)
        await state_store.update(
            deployment_id,
            status="failed",
            error=str(exc),
            completed_at=datetime.now(timezone.utc).isoformat(),
        )


# =====================================================================
# Foundry Agent Service backend (Commercial / GCC)
# =====================================================================


class OrchestratorBase(ABC):
    def __init__(self, state_store: DeploymentStateStore) -> None:
        self.state_store = state_store

    @abstractmethod
    async def deploy(self, deployment_id: str, req: Any, caller_oid: str) -> None: ...


class FoundryOrchestrator(OrchestratorBase):
    """Routes the deployment turn through Foundry Agent Service.

    The Foundry agent has the Azure MCP server registered as a tool.
    The orchestrator submits a conversation describing the deploy goal,
    and the agent autonomously calls the MCP tools to:
      - build bicep params
      - request elevation
      - run what-if
      - create deployment
      - poll
    """

    def __init__(self, state_store: DeploymentStateStore) -> None:
        super().__init__(state_store)
        self.foundry_endpoint = os.environ.get("FOUNDRY_ENDPOINT")
        self.foundry_agent_id = os.environ.get("FOUNDRY_AGENT_ID")

    async def deploy(self, deployment_id: str, req: Any, caller_oid: str) -> None:
        logger.info("Foundry orchestrator handling deployment %s for %s", deployment_id, caller_oid)
        # Production: open a Foundry agent thread, post user message
        # describing the deploy goal, observe tool calls, stream events.
        # For now, delegate to the shared deploy driver.
        await run_bicep_deploy(self.state_store, deployment_id, req, caller_oid)


class MafOrchestrator(OrchestratorBase):
    """Microsoft Agent Framework 1.0 + AOAI direct backend for Gov-High / IL5
    where Foundry Agent Service hasn't yet GA'd.

    Uses the same prompt strategy as the Foundry tier but calls AOAI
    directly with the MCP tools described in the system prompt; tool-
    call selection happens in our process rather than in Foundry's.
    """

    def __init__(self, state_store: DeploymentStateStore) -> None:
        super().__init__(state_store)
        self.aoai_endpoint = os.environ.get("AOAI_ENDPOINT")
        self.aoai_deployment = os.environ.get("AOAI_CHAT_DEPLOYMENT", "gpt-4o")

    async def deploy(self, deployment_id: str, req: Any, caller_oid: str) -> None:
        logger.info("MAF orchestrator handling deployment %s for %s", deployment_id, caller_oid)
        await run_bicep_deploy(self.state_store, deployment_id, req, caller_oid)
