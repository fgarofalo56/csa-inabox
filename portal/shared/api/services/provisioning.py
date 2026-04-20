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

Data-flow contract (CSA-0045 / AQ-0015)
---------------------------------------
The service is **pure** with respect to the ``SourceRecord`` argument:
it never mutates it.  Instead, ``provision()`` returns a frozen
:class:`ProvisioningResult` DTO carrying the new values the caller
should apply to the record and persist.  This makes the data flow
explicit and unidirectional, and prevents in-memory / DB divergence if
the caller's persist step fails.

Exceptions from the underlying Azure SDK calls are caught inside
``provision()``, logged with full stack context via ``logger.exception``,
and surfaced as an ``ERROR`` result — they are never silently swallowed.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, ConfigDict

from ..config import settings
from ..models.source import SourceRecord, SourceStatus

logger = logging.getLogger(__name__)


class ProvisioningResult(BaseModel):
    """Immutable result of a provisioning attempt for a source.

    The caller applies these values to the :class:`SourceRecord` and
    persists the update; the service itself never mutates the caller's
    state.  Populated by :meth:`ProvisioningService.provision` per
    CSA-0045 / AQ-0015.

    Attributes
    ----------
    success:
        ``True`` when all provisioning steps completed; ``False`` for
        both validation failures and infrastructure errors.  The
        distinction is carried by ``new_status`` (unset on validation
        failure, :attr:`SourceStatus.ERROR` on infrastructure error).
    message:
        Human-readable status message safe to surface to the caller.
    deployment_id / pipeline_id / scan_id:
        Identifiers returned by the underlying Azure SDK calls, or
        ``None`` if the step did not run.
    new_status:
        The status the caller should apply to the record.  ``None``
        means "leave status unchanged" (used for validation failures
        where the service does not want to overwrite caller state).
    updated_at:
        Timestamp the caller should stamp on the record.  ``None``
        means "leave ``updated_at`` unchanged".
    details:
        Structured context — on success the target configuration
        snapshot, on error the exception class and message.
    """

    model_config = ConfigDict(frozen=True, arbitrary_types_allowed=True)

    success: bool
    message: str
    deployment_id: str | None = None
    pipeline_id: str | None = None
    scan_id: str | None = None
    new_status: SourceStatus | None = None
    updated_at: datetime | None = None
    details: dict[str, Any] = {}

    def to_dict(self) -> dict[str, Any]:
        """Serialize to a JSON-safe dict for API response bodies."""
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
            A frozen :class:`ProvisioningResult` with status and the new
            field values that the caller must apply to the record and
            persist.  This method **never** mutates the ``source``
            argument.

        The method does not raise.  Infrastructure exceptions are caught,
        logged with ``logger.exception`` (full stack preserved for
        operators), and reported as a ``success=False`` result with
        ``new_status=ERROR`` and structured ``details``.  This keeps the
        data-flow contract unidirectional and prevents silent swallowing
        of failures (CSA-0045 / AQ-0015).
        """
        # 1. Validate — validation failures return without attempting any
        #    infra work and leave ``new_status`` unset so the caller does
        #    not blindly overwrite the record's existing status.
        errors = self.validate(source)
        if errors:
            return ProvisioningResult(
                success=False,
                message="Validation failed.",
                details={"errors": errors},
            )

        # 2-4. Execute the infra steps.  Any exception is caught, logged
        #      with full stack context, and returned as an ERROR result.
        try:
            deployment_id = await self.deploy_infrastructure(source)
            pipeline_id = await self.create_adf_pipeline(source)
            scan_id = await self.trigger_purview_scan(source)
        except Exception as exc:
            # ``logger.exception`` emits the stack trace automatically;
            # never silently swallow (was the original CSA-0045 defect).
            logger.exception(
                "Provisioning failed for source %s",
                source.id,
                extra={
                    "source_id": source.id,
                    "domain": source.domain,
                },
            )
            return ProvisioningResult(
                success=False,
                message="Provisioning failed due to an infrastructure error.",
                new_status=SourceStatus.ERROR,
                updated_at=datetime.now(timezone.utc),
                details={
                    "error_type": type(exc).__name__,
                    "error_message": str(exc)[:512],
                },
            )

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
