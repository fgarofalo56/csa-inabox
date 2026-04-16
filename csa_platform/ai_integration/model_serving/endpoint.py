"""Azure ML managed online endpoint wrapper for model serving.

Provides a unified interface for deploying, invoking, and monitoring ML
models on Azure ML managed online endpoints.  Supports A/B testing via
traffic routing and includes health-check and metrics collection.

Usage::

    endpoint = ModelEndpoint(
        workspace_name="csa-ml-workspace",
        resource_group="rg-csa-prod",
        subscription_id="...",
    )

    # Deploy a model
    endpoint.deploy(
        endpoint_name="crop-yield-predictor",
        model_name="crop-yield-v2",
        model_version="3",
        instance_type="Standard_DS3_v2",
        instance_count=1,
    )

    # Invoke
    result = endpoint.invoke("crop-yield-predictor", {"features": [1.2, 3.4, 5.6]})
"""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from azure.ai.ml import MLClient

from azure.core.exceptions import AzureError, ResourceNotFoundError

from governance.common.logging import configure_structlog, get_logger

configure_structlog(service="model-serving-endpoint")
logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------


@dataclass
class DeploymentConfig:
    """Configuration for a model deployment on a managed online endpoint."""

    endpoint_name: str
    deployment_name: str
    model_name: str
    model_version: str
    instance_type: str = "Standard_DS3_v2"
    instance_count: int = 1
    traffic_percentage: int = 100
    environment_name: str | None = None
    scoring_script: str | None = None
    code_path: str | None = None
    tags: dict[str, str] = field(default_factory=dict)


@dataclass
class EndpointHealth:
    """Health status of a managed online endpoint."""

    endpoint_name: str
    provisioning_state: str
    deployments: list[dict[str, Any]] = field(default_factory=list)
    traffic: dict[str, int] = field(default_factory=dict)
    scoring_uri: str = ""
    is_healthy: bool = False


@dataclass
class InvocationResult:
    """Result of invoking a model endpoint."""

    endpoint_name: str
    response: Any = None
    latency_ms: float = 0.0
    is_error: bool = False
    error_message: str = ""


# ---------------------------------------------------------------------------
# Model Endpoint
# ---------------------------------------------------------------------------


class ModelEndpoint:
    """Wrapper around Azure ML managed online endpoints.

    Provides a high-level API for deploying, invoking, and monitoring
    ML models served on Azure ML managed online endpoints.

    Args:
        workspace_name: Azure ML workspace name.
        resource_group: Azure resource group.
        subscription_id: Azure subscription ID.
    """

    def __init__(
        self,
        workspace_name: str = "",
        resource_group: str = "",
        subscription_id: str = "",
    ) -> None:
        self.workspace_name = workspace_name or os.environ.get("AZURE_ML_WORKSPACE", "")
        self.resource_group = resource_group or os.environ.get("AZURE_ML_RESOURCE_GROUP", "")
        self.subscription_id = subscription_id or os.environ.get("AZURE_SUBSCRIPTION_ID", "")
        self._ml_client: MLClient | None = None

    def _get_ml_client(self) -> MLClient:
        """Lazily initialise the Azure ML client."""
        if self._ml_client is None:
            from azure.ai.ml import MLClient
            from azure.identity import DefaultAzureCredential

            self._ml_client = MLClient(
                credential=DefaultAzureCredential(),
                subscription_id=self.subscription_id,
                resource_group_name=self.resource_group,
                workspace_name=self.workspace_name,
            )
        return self._ml_client

    # -- Endpoint lifecycle -------------------------------------------------

    def create_endpoint(
        self,
        endpoint_name: str,
        description: str = "",
        auth_mode: str = "key",
        tags: dict[str, str] | None = None,
    ) -> str:
        """Create a managed online endpoint.

        Args:
            endpoint_name: Unique name for the endpoint.
            description: Human-readable description.
            auth_mode: Authentication mode (``"key"`` or ``"aml_token"``).
            tags: Resource tags.

        Returns:
            The endpoint's scoring URI.
        """
        from azure.ai.ml.entities import ManagedOnlineEndpoint

        client = self._get_ml_client()

        endpoint = ManagedOnlineEndpoint(
            name=endpoint_name,
            description=description or f"CSA-in-a-Box model endpoint: {endpoint_name}",
            auth_mode=auth_mode,
            tags=tags or {"platform": "csa-inabox"},
        )

        logger.info("endpoint.creating", endpoint_name=endpoint_name)
        result = client.online_endpoints.begin_create_or_update(endpoint).result()
        scoring_uri = result.scoring_uri or ""
        logger.info("endpoint.created", endpoint_name=endpoint_name, scoring_uri=scoring_uri)
        return scoring_uri

    def deploy(self, config: DeploymentConfig) -> None:
        """Deploy a model to a managed online endpoint.

        Creates the endpoint if it does not exist, then creates a
        deployment with the specified model and configuration.

        Args:
            config: Deployment configuration.
        """
        from azure.ai.ml.entities import (
            ManagedOnlineDeployment,
            Model,
        )

        client = self._get_ml_client()

        # Ensure endpoint exists
        try:
            client.online_endpoints.get(config.endpoint_name)
            logger.info("endpoint.exists", endpoint_name=config.endpoint_name)
        except ResourceNotFoundError:
            self.create_endpoint(config.endpoint_name, tags=config.tags)

        # Build model reference
        model = Model(
            name=config.model_name,
            version=config.model_version,
        )

        # Create deployment
        deployment = ManagedOnlineDeployment(
            name=config.deployment_name,
            endpoint_name=config.endpoint_name,
            model=model,
            instance_type=config.instance_type,
            instance_count=config.instance_count,
            tags=config.tags,
        )

        if config.environment_name:
            deployment.environment = config.environment_name
        if config.scoring_script and config.code_path:
            from azure.ai.ml.entities import CodeConfiguration

            deployment.code_configuration = CodeConfiguration(
                code=config.code_path,
                scoring_script=config.scoring_script,
            )

        logger.info(
            "deployment.creating",
            deployment_name=config.deployment_name,
            model_name=config.model_name,
            model_version=config.model_version,
            endpoint_name=config.endpoint_name,
        )
        client.online_deployments.begin_create_or_update(deployment).result()
        logger.info("deployment.created", deployment_name=config.deployment_name)

        # Set traffic
        if config.traffic_percentage > 0:
            self.set_traffic(
                config.endpoint_name,
                {config.deployment_name: config.traffic_percentage},
            )

    def set_traffic(
        self,
        endpoint_name: str,
        traffic: dict[str, int],
    ) -> None:
        """Set traffic routing for A/B testing across deployments.

        Args:
            endpoint_name: Name of the managed online endpoint.
            traffic: Mapping of deployment name to traffic percentage.
                Percentages must sum to 100.

        Raises:
            ValueError: If traffic percentages do not sum to 100.
        """
        total = sum(traffic.values())
        if total != 100:
            raise ValueError(f"Traffic percentages must sum to 100, got {total}")

        client = self._get_ml_client()
        endpoint = client.online_endpoints.get(endpoint_name)
        endpoint.traffic = traffic
        client.online_endpoints.begin_create_or_update(endpoint).result()
        logger.info("traffic.updated", endpoint_name=endpoint_name, traffic=traffic)

    def delete_deployment(self, endpoint_name: str, deployment_name: str) -> None:
        """Delete a deployment from an endpoint.

        Args:
            endpoint_name: Name of the managed online endpoint.
            deployment_name: Name of the deployment to remove.
        """
        client = self._get_ml_client()
        logger.info("deployment.deleting", deployment_name=deployment_name, endpoint_name=endpoint_name)
        client.online_deployments.begin_delete(
            name=deployment_name,
            endpoint_name=endpoint_name,
        ).result()
        logger.info("deployment.deleted", deployment_name=deployment_name)

    def delete_endpoint(self, endpoint_name: str) -> None:
        """Delete an entire managed online endpoint and all its deployments.

        Args:
            endpoint_name: Name of the endpoint to delete.
        """
        client = self._get_ml_client()
        logger.info("endpoint.deleting", endpoint_name=endpoint_name)
        client.online_endpoints.begin_delete(name=endpoint_name).result()
        logger.info("endpoint.deleted", endpoint_name=endpoint_name)

    # -- Invocation ---------------------------------------------------------

    def invoke(
        self,
        endpoint_name: str,
        payload: dict[str, Any],
        deployment_name: str | None = None,
    ) -> InvocationResult:
        """Invoke a model endpoint for inference.

        Args:
            endpoint_name: Name of the managed online endpoint.
            payload: Input data as a dictionary.
            deployment_name: Optional specific deployment to target
                (bypasses traffic routing).

        Returns:
            An :class:`InvocationResult` with the model's response.
        """
        client = self._get_ml_client()
        request_json = json.dumps(payload)

        start = time.perf_counter()
        try:
            response = client.online_endpoints.invoke(
                endpoint_name=endpoint_name,
                deployment_name=deployment_name,
                request_file=None,
                request=request_json,
            )
            latency = (time.perf_counter() - start) * 1000

            try:
                parsed = json.loads(response)
            except (json.JSONDecodeError, TypeError):
                parsed = response

            return InvocationResult(
                endpoint_name=endpoint_name,
                response=parsed,
                latency_ms=round(latency, 2),
            )
        except (AzureError, json.JSONDecodeError, OSError) as exc:
            latency = (time.perf_counter() - start) * 1000
            logger.exception("invocation.failed", endpoint_name=endpoint_name)
            return InvocationResult(
                endpoint_name=endpoint_name,
                latency_ms=round(latency, 2),
                is_error=True,
                error_message=str(exc),
            )

    # -- Health & Monitoring ------------------------------------------------

    def health_check(self, endpoint_name: str) -> EndpointHealth:
        """Check the health and status of a managed online endpoint.

        Args:
            endpoint_name: Name of the endpoint to check.

        Returns:
            An :class:`EndpointHealth` with provisioning state, deployments,
            and traffic distribution.
        """
        client = self._get_ml_client()

        try:
            endpoint = client.online_endpoints.get(endpoint_name)
            deployments_list = client.online_deployments.list(endpoint_name)

            deployment_info: list[dict[str, Any]] = []
            for dep in deployments_list:
                deployment_info.append(
                    {
                        "name": dep.name,
                        "model": f"{dep.model.name}:{dep.model.version}" if dep.model else "unknown",
                        "instance_type": dep.instance_type,
                        "instance_count": dep.instance_count,
                        "provisioning_state": dep.provisioning_state,
                    }
                )

            is_healthy = endpoint.provisioning_state == "Succeeded" and all(
                d.get("provisioning_state") == "Succeeded" for d in deployment_info
            )

            return EndpointHealth(
                endpoint_name=endpoint_name,
                provisioning_state=endpoint.provisioning_state,
                deployments=deployment_info,
                traffic=dict(endpoint.traffic) if endpoint.traffic else {},
                scoring_uri=endpoint.scoring_uri or "",
                is_healthy=is_healthy,
            )
        except (AzureError, OSError):
            logger.exception("health_check.failed", endpoint_name=endpoint_name)
            return EndpointHealth(
                endpoint_name=endpoint_name,
                provisioning_state="Unknown",
                is_healthy=False,
            )

    def get_metrics(
        self,
        endpoint_name: str,
        deployment_name: str | None = None,
    ) -> dict[str, Any]:
        """Retrieve metrics for an endpoint or specific deployment.

        Collects request count, latency, and error rate from Azure Monitor
        metrics associated with the endpoint.

        Args:
            endpoint_name: Name of the endpoint.
            deployment_name: Optional deployment name for scoped metrics.

        Returns:
            Dictionary with collected metrics.

        Note:
            In production, this would query Azure Monitor metrics.
            This implementation returns the endpoint metadata as a
            starting point for metric collection integration.
        """
        health = self.health_check(endpoint_name)

        metrics: dict[str, Any] = {
            "endpoint_name": endpoint_name,
            "provisioning_state": health.provisioning_state,
            "is_healthy": health.is_healthy,
            "deployment_count": len(health.deployments),
            "traffic_distribution": health.traffic,
        }

        if deployment_name:
            for dep in health.deployments:
                if dep["name"] == deployment_name:
                    metrics["deployment"] = dep
                    break

        return metrics

    def list_endpoints(self) -> list[dict[str, Any]]:
        """List all managed online endpoints in the workspace.

        Returns:
            List of endpoint summaries.
        """
        client = self._get_ml_client()
        endpoints = client.online_endpoints.list()

        result: list[dict[str, Any]] = []
        for ep in endpoints:
            result.append(
                {
                    "name": ep.name,
                    "provisioning_state": ep.provisioning_state,
                    "scoring_uri": ep.scoring_uri or "",
                    "traffic": dict(ep.traffic) if ep.traffic else {},
                    "tags": dict(ep.tags) if ep.tags else {},
                }
            )
        return result
