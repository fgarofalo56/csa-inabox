"""Standardized App Insights telemetry for Loom services.

Every Loom custom app uses this module to wire OpenTelemetry → App
Insights with consistent resource attributes (service.name,
service.version, deployment.environment, csa-loom.boundary).

Picks up APPLICATIONINSIGHTS_CONNECTION_STRING from env. No-op if
unset so unit tests + local dev work without telemetry config.

Usage:
    from loom_setup_orchestrator.telemetry import configure_telemetry
    configure_telemetry(service_name="loom-setup-orchestrator")
"""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)


def configure_telemetry(
    service_name: str,
    service_version: str = "0.1.0",
    extra_resource_attrs: dict[str, Any] | None = None,
) -> None:
    """Wire OpenTelemetry into App Insights.

    Args:
        service_name: stable identifier emitted as `cloud.role`
            (queryable via `requests | where cloud_RoleName == "X"`)
        service_version: emitted as `cloud.role_instance` part
        extra_resource_attrs: extra attributes merged into the
            OpenTelemetry resource (e.g., `{"csa-loom.boundary": "GCC-High"}`)
    """
    conn = os.environ.get("APPLICATIONINSIGHTS_CONNECTION_STRING")
    if not conn:
        logger.info(
            "APPLICATIONINSIGHTS_CONNECTION_STRING not set; telemetry disabled for %s",
            service_name,
        )
        return

    try:
        from azure.monitor.opentelemetry import configure_azure_monitor
    except ImportError:
        logger.warning(
            "azure-monitor-opentelemetry not installed; telemetry disabled. "
            "Add 'azure-monitor-opentelemetry>=1.6.0' to your dependencies."
        )
        return

    resource_attrs: dict[str, Any] = {
        "service.name": service_name,
        "service.version": service_version,
        "deployment.environment": os.environ.get("CSA_LOOM_BOUNDARY", "Unknown"),
        "csa-loom.tier": os.environ.get("LOOM_TIER", "service"),
    }
    if extra_resource_attrs:
        resource_attrs.update(extra_resource_attrs)

    configure_azure_monitor(
        connection_string=conn,
        resource_attributes=resource_attrs,
        # Sample 100% of requests; tune down for high-traffic services
        # via a sampler config when needed
        enable_live_metrics=True,
    )
    logger.info(
        "Telemetry configured for %s (boundary=%s)",
        service_name, resource_attrs["deployment.environment"],
    )
