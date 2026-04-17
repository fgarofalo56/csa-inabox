"""
Data Landing Zone (DLZ) provisioning service.

Orchestrates the end-to-end provisioning workflow when a new data source
is registered:

1. Validate the source registration payload.
2. Deploy infrastructure via Bicep / Terraform.
3. Create an ADF pipeline from metadata.
4. Trigger a Microsoft Purview scan.
5. Return provisioning status.

In demo mode the service returns realistic-looking mock results.  In
production each step delegates to the appropriate Azure management SDK.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from ..config import settings
from ..models.source import SourceRecord, SourceStatus

logger = logging.getLogger(__name__)


class ProvisioningResult:
    """Result of a provisioning run.

    Carries the new field values that should be applied to the source record
    by the caller.  The service itself never mutates the input SourceRecord.
    """

    def __init__(
        self,
        *,
        success: bool,
        message: str,
        deployment_id: str | None = None,
        pipeline_id: str | None = None,
        scan_id: str | None = None,
        new_status: SourceStatus | None = None,
        updated_at: datetime | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        self.success = success
        self.message = message
        self.deployment_id = deployment_id
        self.pipeline_id = pipeline_id
        self.scan_id = scan_id
        self.new_status = new_status
        self.updated_at = updated_at
        self.details = details or {}

    def to_dict(self) -> dict[str, Any]:
        """Serialize to a JSON-safe dict."""
        return {
            "success": self.success,
            "message": self.message,
            "deployment_id": self.deployment_id,
            "pipeline_id": self.pipeline_id,
            "scan_id": self.scan_id,
            "details": self.details,
        }


class ProvisioningService:
    """Orchestrates DLZ provisioning for registered data sources."""

    # ── Validation ───────────────────────────────────────────────────────

    @staticmethod
    def validate(source: SourceRecord) -> list[str]:
        """Validate that a source is ready for provisioning.

        Returns a list of error messages (empty if valid).
        """
        errors: list[str] = []
        if not source.name:
            errors.append("Source name is required.")
        if not source.owner or not source.owner.email:
            errors.append("Owner email is required.")
        if source.status not in (
            SourceStatus.DRAFT,
            SourceStatus.APPROVED,
            SourceStatus.ERROR,
        ):
            errors.append(
                f"Source status '{source.status}' is not eligible for provisioning. Must be draft, approved, or error."
            )
        return errors

    # ── Infrastructure Deployment ────────────────────────────────────────

    async def deploy_infrastructure(self, source: SourceRecord) -> str:
        """Deploy Data Landing Zone infrastructure via Bicep/Terraform.

        Returns:
            Deployment ID.

        In production, would use Azure Resource Manager deployment:

            from azure.mgmt.resource import ResourceManagementClient
            from azure.identity import DefaultAzureCredential

            credential = DefaultAzureCredential()
            client = ResourceManagementClient(credential, subscription_id)
            deployment = client.deployments.begin_create_or_update(...)
        """
        deployment_id = f"deploy-{uuid.uuid4().hex[:12]}"
        logger.info(
            "Deploying DLZ infrastructure (mock)",
            extra={
                "source_id": source.id,
                "deployment_id": deployment_id,
                "landing_zone": source.target.landing_zone,
            },
        )
        return deployment_id

    # ── ADF Pipeline Creation ────────────────────────────────────────────

    async def create_adf_pipeline(self, source: SourceRecord) -> str:
        """Create an Azure Data Factory pipeline from source metadata.

        Returns:
            The ADF pipeline resource name.

        In production, would use ADF SDK:

            from azure.mgmt.datafactory import DataFactoryManagementClient
            client = DataFactoryManagementClient(credential, subscription_id)
            client.pipelines.create_or_update(
                resource_group, factory_name, pipeline_name, pipeline_resource
            )
        """
        pipeline_name = f"pl-{source.domain}-{source.name}-{source.source_type.value}"
        logger.info(
            "Creating ADF pipeline (mock)",
            extra={
                "source_id": source.id,
                "pipeline_name": pipeline_name,
                "factory": settings.ADF_FACTORY_NAME or "adf-csainabox-dev",
            },
        )
        return pipeline_name

    # ── Purview Scan ─────────────────────────────────────────────────────

    async def trigger_purview_scan(self, source: SourceRecord) -> str:
        """Register the source with Microsoft Purview and trigger a scan.

        Returns:
            The scan run ID.

        In production, would use Purview REST API:

            async with httpx.AsyncClient() as client:
                resp = await client.put(
                    f"https://{settings.PURVIEW_ACCOUNT_NAME}.purview.azure.com/"
                    f"scan/datasources/{source.name}/scans/default/run",
                    headers={"Authorization": f"Bearer {token}"},
                )
        """
        scan_id = f"scan-{uuid.uuid4().hex[:12]}"
        logger.info(
            "Triggering Purview scan (mock)",
            extra={
                "source_id": source.id,
                "scan_id": scan_id,
                "purview_account": settings.PURVIEW_ACCOUNT_NAME or "pv-csainabox-dev",
            },
        )
        return scan_id

    # ── Full Orchestration ───────────────────────────────────────────────

    async def provision(self, source: SourceRecord) -> ProvisioningResult:
        """Run the full provisioning workflow for a source.

        Steps:
            1. Validate source registration.
            2. Deploy infrastructure (Bicep/Terraform).
            3. Create ADF pipeline from metadata.
            4. Trigger Purview scan.

        Returns:
            :class:`ProvisioningResult` with status and the new field values
            that the caller must apply to the record and persist.  This method
            never mutates the *source* argument.

        Raises:
            Exception: Any unexpected infrastructure error is re-raised with
                additional context so the router can persist the error state
                and return an appropriate HTTP response.
        """
        # 1. Validate
        errors = self.validate(source)
        if errors:
            return ProvisioningResult(
                success=False,
                message="Validation failed.",
                details={"errors": errors},
            )

        # 2. Deploy infrastructure
        deployment_id = await self.deploy_infrastructure(source)

        # 3. Create ADF pipeline
        pipeline_id = await self.create_adf_pipeline(source)

        # 4. Trigger Purview scan
        scan_id = await self.trigger_purview_scan(source)

        now = datetime.now(timezone.utc)
        return ProvisioningResult(
            success=True,
            message="Provisioning initiated successfully.",
            deployment_id=deployment_id,
            pipeline_id=pipeline_id,
            scan_id=scan_id,
            new_status=SourceStatus.PROVISIONING,
            updated_at=now,
            details={
                "landing_zone": source.target.landing_zone,
                "container": source.target.container,
                "format": source.target.format.value,
            },
        )


# Module-level singleton
provisioning_service = ProvisioningService()
