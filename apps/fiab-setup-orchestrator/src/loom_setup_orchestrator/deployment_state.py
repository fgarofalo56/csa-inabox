"""Deployment state — Cosmos-backed in prod; in-memory for dev."""

from __future__ import annotations

import asyncio
import os
from datetime import datetime, timezone
from typing import Any

# Lazy Cosmos import; only required when COSMOS_ENDPOINT is set.

_COSMOS_ENDPOINT = os.environ.get("COSMOS_ENDPOINT")
_DB_NAME = os.environ.get("COSMOS_DATABASE", "workspace-registry")
_CONTAINER = os.environ.get("COSMOS_SETUP_CONTAINER", "deployments")


class DeploymentStateStore:
    """Async store for in-flight deployment state.

    Two implementations:
      - In-memory dict (default, dev mode)
      - Cosmos DB container (when COSMOS_ENDPOINT is set)
    """

    def __init__(self) -> None:
        self._mem: dict[str, dict[str, Any]] = {}
        self._lock = asyncio.Lock()
        self._cosmos = None
        if _COSMOS_ENDPOINT:
            self._wire_cosmos()

    def _wire_cosmos(self) -> None:
        from azure.cosmos.aio import CosmosClient
        from azure.identity.aio import DefaultAzureCredential

        self._cred = DefaultAzureCredential()
        self._cosmos = CosmosClient(_COSMOS_ENDPOINT, credential=self._cred)

    async def create(self, deployment_id: str, request: dict[str, Any], caller_oid: str) -> None:
        record = {
            "id": deployment_id,
            "deployment_id": deployment_id,
            "caller_oid": caller_oid,
            "status": "queued",
            "progress": 0.0,
            "current_stage": "Queued",
            "error": None,
            "bicep_parameters": _render_bicep_parameters(request),
            "started_at": datetime.now(timezone.utc).isoformat(),
            "completed_at": None,
            "request": request,
        }
        async with self._lock:
            self._mem[deployment_id] = record
        if self._cosmos:
            container = self._cosmos.get_database_client(_DB_NAME).get_container_client(_CONTAINER)
            await container.create_item(record)

    async def update(self, deployment_id: str, **fields: Any) -> None:
        async with self._lock:
            record = self._mem.get(deployment_id)
            if not record:
                return
            record.update(fields)
        if self._cosmos:
            container = self._cosmos.get_database_client(_DB_NAME).get_container_client(_CONTAINER)
            await container.upsert_item(self._mem[deployment_id])

    async def get(self, deployment_id: str) -> dict[str, Any] | None:
        async with self._lock:
            return self._mem.get(deployment_id)


def _render_bicep_parameters(req: dict[str, Any]) -> dict[str, Any]:
    """Materialize the .bicepparam content for audit + display."""
    boundary = req["boundary"]
    env = "AzureUSGovernment" if boundary in ("GCC-High", "IL5") else "AzureCloud"
    container_platform = "aks" if boundary in ("GCC-High", "IL5") else "containerApps"
    return {
        "environment": env,
        "boundary": boundary,
        "deploymentMode": req["mode"],
        "containerPlatform": container_platform,
        "capacitySku": req["capacity_sku"],
        "dlzDomainNames": [req["domain_name"]],
    }
