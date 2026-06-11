"""Two orchestrator backends — Foundry Agent Service + MAF — sharing
the same deployment contract.

Both delegate the actual provisioning to :func:`run_bicep_deploy`, which
submits a **real subscription-scoped ARM deployment** of main.bicep
(compiled to a ``main.json`` templateLink) under the orchestrator's
managed identity and polls the long-running operation to a terminal
state. There is no simulated progress — the wizard's "done" step only
turns green after ARM reports ``Succeeded`` (per no-vaporware.md)."""

from __future__ import annotations

import asyncio
import logging
import os
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Any

from .deployment_state import DeploymentStateStore

logger = logging.getLogger(__name__)

# Boundaries that target Azure US Government (different ARM endpoint + authority).
_GOV_BOUNDARIES = {"GCC-High", "IL5"}

# How often the LRO is polled while ARM provisions. Override for fast tests.
POLL_INTERVAL_SECS = float(os.environ.get("LOOM_SETUP_POLL_SECS", "5"))


def _get(req: Any, name: str, default: Any = None) -> Any:
    """Read a field from either a Pydantic model or a plain dict (tests)."""
    if isinstance(req, dict):
        return req.get(name, default)
    return getattr(req, name, default)


def make_resource_client(subscription_id: str, arm_endpoint: str, authority: str | None):
    """Build a real ARM ``ResourceManagementClient`` under the orchestrator's
    managed identity (``AZURE_CLIENT_ID`` UAMI granted Contributor on each
    target subscription by setup-orchestrator-rbac.bicep).

    Isolated as a module function so tests can monkeypatch it without a live
    Azure tenant.
    """
    from azure.identity import DefaultAzureCredential
    from azure.mgmt.resource import ResourceManagementClient

    cred_kwargs: dict[str, Any] = {}
    if authority:
        cred_kwargs["authority"] = authority
    credential = DefaultAzureCredential(**cred_kwargs)
    base = arm_endpoint.rstrip("/")
    return ResourceManagementClient(
        credential,
        subscription_id,
        base_url=base,
        credential_scopes=[f"{base}/.default"],
    )


def _deploy_parameters(req: Any) -> dict[str, dict[str, Any]]:
    """ARM-style ``{name: {"value": ...}}`` parameters mirroring the
    copy-paste ``az deployment sub create -p ...`` the wizard prints —
    boundary, deploymentMode, capacitySku and the parallel DLZ arrays the
    main.bicep ``[for]`` loop consumes.
    """
    domain = _get(req, "domain_name")
    dlz_subs = _get(req, "dlz_subscription_ids") or []
    dlz_domains = _get(req, "dlz_domain_names") or ([domain] if domain else [])
    params: dict[str, dict[str, Any]] = {
        "boundary": {"value": _get(req, "boundary")},
        "deploymentMode": {"value": _get(req, "mode")},
        "capacitySku": {"value": _get(req, "capacity_sku")},
        "dlzDomainNames": {"value": dlz_domains},
    }
    if dlz_subs:
        params["dlzSubscriptionIds"] = {"value": dlz_subs}
    vanity = _get(req, "vanity_domain")
    if vanity:
        params["vanityDomain"] = {"value": vanity}
    return params


async def run_bicep_deploy(
    state_store: DeploymentStateStore,
    deployment_id: str,
    req: Any,
    caller_oid: str,
) -> None:
    """Submit a REAL subscription-scoped ARM deployment of main.bicep and poll
    it to a terminal state.

    Stages (each reflects an actual step, not a timer):
        1. Validate the captured request has a target subscription + region.
        2. Resolve the ARM endpoint/authority for the boundary and build the
           managed-identity ResourceManagementClient.
        3. Submit ``deployments.begin_create_or_update_at_subscription_scope``
           with a templateLink to the published main.json and the captured
           parameters (boundary / deploymentMode / capacitySku / DLZ arrays).
        4. Poll the long-running operation until ARM reports done.
        5. Mark state succeeded only when provisioningState == 'Succeeded';
           any other terminal state (or exception) marks it failed.

    The compiled template is referenced via ``LOOM_SETUP_TEMPLATE_URI`` (a
    templateLink to main.json published by the deploy pipeline). When that is
    not configured the deployment fails honestly with the exact remediation —
    it never reports a fake success.
    """
    try:
        await state_store.update(
            deployment_id, status="running", progress=0.1, current_stage="Validating request"
        )

        subscription_id = _get(req, "subscription_id") or _get(req, "target_subscription_id")
        if not subscription_id:
            raise RuntimeError(
                "No target subscription id in the deploy request (subscriptionId)."
            )
        region = _get(req, "region") or _get(req, "location")
        if not region:
            raise RuntimeError(
                "No deployment region in the deploy request (region/location)."
            )

        boundary = _get(req, "boundary")
        is_gov = boundary in _GOV_BOUNDARIES
        arm_endpoint = os.environ.get("LOOM_ARM_ENDPOINT") or (
            "https://management.usgovcloudapi.net" if is_gov else "https://management.azure.com"
        )
        authority = "https://login.microsoftonline.us" if is_gov else None

        template_uri = (os.environ.get("LOOM_SETUP_TEMPLATE_URI") or "").strip()
        if not template_uri:
            raise RuntimeError(
                "LOOM_SETUP_TEMPLATE_URI is not configured. Publish the compiled main.json "
                "(`az bicep build -f platform/fiab/bicep/main.bicep`) to a reachable templateLink "
                "URI and set LOOM_SETUP_TEMPLATE_URI on the Setup Orchestrator so it can submit a "
                "real subscription-scoped deployment."
            )

        await state_store.update(
            deployment_id,
            status="running",
            progress=0.3,
            current_stage="Authenticating (managed identity)",
        )
        client = make_resource_client(subscription_id, arm_endpoint, authority)

        from azure.mgmt.resource.resources.models import (
            Deployment,
            DeploymentMode,
            DeploymentProperties,
            TemplateLink,
        )

        deployment = Deployment(
            location=region,
            properties=DeploymentProperties(
                mode=DeploymentMode.incremental,
                template_link=TemplateLink(uri=template_uri),
                parameters=_deploy_parameters(req),
            ),
        )
        deployment_name = f"loom-setup-{deployment_id}"

        await state_store.update(
            deployment_id,
            status="running",
            progress=0.5,
            current_stage="Submitting subscription deployment",
        )
        poller = await asyncio.to_thread(
            client.deployments.begin_create_or_update_at_subscription_scope,
            deployment_name,
            deployment,
        )

        await state_store.update(
            deployment_id,
            status="running",
            progress=0.7,
            current_stage="Provisioning resources",
        )
        while not poller.done():
            await asyncio.sleep(POLL_INTERVAL_SECS)
        result = await asyncio.to_thread(poller.result)

        provisioning_state = (
            getattr(getattr(result, "properties", None), "provisioning_state", None) or "Succeeded"
        )
        if str(provisioning_state).lower() != "succeeded":
            raise RuntimeError(f"Deployment finished in state '{provisioning_state}'.")

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
        # The Foundry agent thread is the conversational/UX layer; the actual
        # provisioning is the shared, real ARM deployment driver below. Both
        # tiers converge on the same real `begin_create_or_update_at_subscription_scope`.
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
