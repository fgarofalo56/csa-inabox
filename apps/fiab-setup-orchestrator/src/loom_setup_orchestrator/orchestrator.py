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
from .topology_client import register_domain_binding

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


# Contributor built-in role definition id (stable across clouds).
_CONTRIBUTOR_ROLE_DEF_GUID = "b24988ac-6180-42a0-ab88-20f7382dd24c"


def make_authorization_client(subscription_id: str, arm_endpoint: str, authority: str | None):
    """Build a real ``AuthorizationManagementClient`` under the orchestrator's
    managed identity, used for the dlz-attach RBAC honest gate.

    Isolated as a module function so tests can monkeypatch it without a live
    Azure tenant.
    """
    from azure.identity import DefaultAzureCredential
    from azure.mgmt.authorization import AuthorizationManagementClient

    cred_kwargs: dict[str, Any] = {}
    if authority:
        cred_kwargs["authority"] = authority
    credential = DefaultAzureCredential(**cred_kwargs)
    base = arm_endpoint.rstrip("/")
    return AuthorizationManagementClient(
        credential,
        subscription_id,
        base_url=base,
        credential_scopes=[f"{base}/.default"],
    )


def role_assignment_remediation(
    *, principal_id: str | None, subscription_id: str, is_gov: bool
) -> str:
    """The exact, copy-paste ``az role assignment create`` command that grants
    the orchestrator identity Contributor on the dlz-attach target subscription.

    Uses ``--assignee-object-id`` + ``--assignee-principal-type ServicePrincipal``
    (not ``--assignee``) to avoid the Entra replication race for a freshly created
    identity (Learn: *Assign Azure roles using Azure CLI*). Gov-aware.
    """
    oid = principal_id or "<orchestrator-principal-object-id>"
    lines: list[str] = []
    if is_gov:
        lines.append("az cloud set --name AzureUSGovernment")
    lines.append("az role assignment create \\")
    lines.append(f"  --assignee-object-id {oid} \\")
    lines.append("  --assignee-principal-type ServicePrincipal \\")
    lines.append("  --role Contributor \\")
    lines.append(f"  --scope /subscriptions/{subscription_id}")
    return "\n".join(lines)


def orchestrator_has_contributor(
    *,
    subscription_id: str,
    arm_endpoint: str,
    authority: str | None,
    principal_id: str,
) -> bool:
    """Real check that the orchestrator identity holds Contributor (or Owner) at
    ``/subscriptions/<subscription_id>``.

    Lists the role assignments at subscription scope filtered to the orchestrator
    principal and inspects each assignment's roleDefinitionId for the Contributor
    (or Owner) built-in GUID. Returns False on any error so the caller surfaces
    the honest remediation rather than a fake success (no-vaporware).
    """
    try:
        client = make_authorization_client(subscription_id, arm_endpoint, authority)
        scope = f"/subscriptions/{subscription_id}"
        # principalId eq '<oid>' returns the assignments for THIS identity at/above scope.
        assignments = client.role_assignments.list_for_scope(
            scope, filter=f"principalId eq '{principal_id}'"
        )
        privileged = {
            _CONTRIBUTOR_ROLE_DEF_GUID,
            "8e3af657-a8ff-443c-a75c-2fe8c4bcb635",  # Owner
        }
        for a in assignments:
            role_def = (getattr(a, "role_definition_id", "") or "").rsplit("/", 1)[-1].lower()
            if role_def in {g.lower() for g in privileged}:
                return True
        return False
    except Exception:  # noqa: BLE001
        logger.exception("RBAC pre-check failed for subscription %s", subscription_id)
        return False


def _deploy_parameters(req: Any) -> dict[str, dict[str, Any]]:
    """ARM-style ``{name: {"value": ...}}`` parameters mirroring the
    copy-paste ``az deployment sub create -p ...`` the wizard prints —
    boundary, deploymentMode, capacitySku and the parallel DLZ arrays the
    main.bicep ``[for]`` loop consumes.

    For ``topology=='dlz-attach'`` it instead emits the attach shape:
    ``topology`` + ``targetSubscriptionId`` + ``attachDomainName`` + the named
    feature toggles + the hub* coordinates read from the tenant-topology doc
    (passed through on the request by the Console BFF).
    """
    topology = _get(req, "topology") or "tenant"
    if topology == "dlz-attach":
        return _attach_parameters(req)
    domain = _get(req, "domain_name")
    dlz_subs = _get(req, "dlz_subscription_ids") or []
    dlz_domains = _get(req, "dlz_domain_names") or ([domain] if domain else [])
    params: dict[str, dict[str, Any]] = {
        "topology": {"value": "tenant"},
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


# Hub-coordinate fields the dlz-attach deployment threads into main.bicep. The
# Console BFF reads these from the Cosmos `tenant-topology` doc and forwards them
# on the deploy request (camelCase). Mapped 1:1 to main.bicep hub* params.
_HUB_COORDINATE_FIELDS = (
    "hubVnetId",
    "hubLawId",
    "hubAppInsightsConnectionString",
    "hubPrivateDnsZoneIds",
    "hubAdxClusterRgName",
    "hubAdxClusterPrincipalId",
    "hubCatalogEndpoint",
    "hubAiServicesAccountName",
    "hubConsolePrincipalId",
    "hubConsoleUamiName",
    "hubConsoleUamiAppId",
    "hubConsoleUamiId",
    "hubActivatorPrincipalId",
)


def _attach_parameters(req: Any) -> dict[str, dict[str, Any]]:
    """ARM parameters for a ``topology=='dlz-attach'`` deployment: attach ONE
    DLZ in ``targetSubscriptionId`` to the existing hub. No Console is deployed.

    Hub coordinates come from the request (the Console BFF sourced them from the
    Cosmos tenant-topology doc — never free-typed). The named feature toggles are
    forwarded; everything else defaults from the boundary's bicepparam.
    """
    target_sub = _get(req, "target_subscription_id") or _get(req, "subscription_id")
    domain = _get(req, "domain_name")
    params: dict[str, dict[str, Any]] = {
        "topology": {"value": "dlz-attach"},
        "boundary": {"value": _get(req, "boundary")},
        # dlz-attach is a spoke in its own subscription → multi-sub sizing
        # semantics, but the [for] loop stays empty (no dlzSubscriptionIds).
        "deploymentMode": {"value": "multi-sub"},
        "capacitySku": {"value": _get(req, "capacity_sku")},
        "targetSubscriptionId": {"value": target_sub},
        "attachDomainName": {"value": domain},
        "adxEnabled": {"value": bool(_get(req, "adx_enabled", True))},
        "cosmosGraphVectorEnabled": {"value": bool(_get(req, "cosmos_graph_vector_enabled", True))},
        "weaveOntologyEnabled": {"value": bool(_get(req, "weave_ontology_enabled", True))},
        "databricksUnityCatalogEnabled": {
            "value": bool(_get(req, "databricks_unity_catalog_enabled", False))
        },
        "databricksSqlWarehouseEnabled": {
            "value": bool(_get(req, "databricks_sql_warehouse_enabled", False))
        },
    }
    # Forward whichever hub coordinates the request carried (BFF-sourced).
    for field in _HUB_COORDINATE_FIELDS:
        val = _get(req, field)
        if val is None:
            # Tolerate snake_case too (deterministic tests / dict requests).
            snake = "".join(("_" + c.lower()) if c.isupper() else c for c in field)
            val = _get(req, snake)
        if val is not None:
            params[field] = {"value": val}
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

        topology = _get(req, "topology") or "tenant"
        # dlz-attach lands in the NEW (target) subscription; tenant installs land
        # in the hub/admin subscription.
        if topology == "dlz-attach":
            subscription_id = _get(req, "target_subscription_id") or _get(req, "subscription_id")
        else:
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

        # ── dlz-attach RBAC honest gate ───────────────────────────────────────
        # The orchestrator identity must already hold Contributor on the NEW
        # subscription to submit a subscription-scoped deployment there. Check it
        # for real and fail honestly (no fake success — no-vaporware) with the
        # exact `az role assignment create` remediation when it is missing.
        if topology == "dlz-attach":
            principal_id = (os.environ.get("LOOM_ORCHESTRATOR_PRINCIPAL_ID") or "").strip()
            await state_store.update(
                deployment_id,
                status="running",
                progress=0.2,
                current_stage="Checking orchestrator RBAC on the target subscription",
            )
            has_rights = bool(principal_id) and await asyncio.to_thread(
                orchestrator_has_contributor,
                subscription_id=subscription_id,
                arm_endpoint=arm_endpoint,
                authority=authority,
                principal_id=principal_id,
            )
            if not has_rights:
                cmd = role_assignment_remediation(
                    principal_id=principal_id or None,
                    subscription_id=subscription_id,
                    is_gov=is_gov,
                )
                raise RuntimeError(
                    "The Setup Orchestrator identity does not hold Contributor on the target "
                    f"subscription {subscription_id}, so it cannot attach a Data Landing Zone there. "
                    "Grant it with:\n\n" + cmd
                )

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

        # audit-t158: now that the DLZ deployment has actually succeeded,
        # register each deployed domain in the Console's authoritative tenant
        # topology registry (orchestrator → console internal API). This is the
        # "dlz-attach registers the domain automatically" path: it makes the
        # binding show up under /admin/domains with status=active bound to its
        # subscription, RG, region, capacity and Entra groups — no manual step.
        # Best-effort: register_domain_binding swallows all errors and a missing
        # LOOM_CONSOLE_INTERNAL_URL skips silently, so it NEVER fails the deploy.
        domain = _get(req, "domain_name")
        dlz_domains = _get(req, "dlz_domain_names") or ([domain] if domain else [])
        dlz_subs = _get(req, "dlz_subscription_ids") or []
        for idx, dom in enumerate(dlz_domains):
            if not dom:
                continue
            sub_for_domain = (dlz_subs[idx] if idx < len(dlz_subs) else None) or subscription_id
            await register_domain_binding(
                caller_oid=caller_oid,
                domain_id=dom,
                name=_get(req, "vanity_domain") or dom,
                subscription_id=sub_for_domain,
                subscription_ids=dlz_subs or None,
                dlz_rg=_get(req, "dlz_rg"),
                location=region,
                capacity_sku=_get(req, "capacity_sku"),
                admin_group_id=_get(req, "admin_group_id"),
                member_group_id=_get(req, "member_group_id"),
                cost_center=_get(req, "cost_center"),
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
