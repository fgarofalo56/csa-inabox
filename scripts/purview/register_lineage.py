"""Register lineage entities in Microsoft Purview via the Atlas REST API.

Creates Process entities that model data flow through the CSA-in-a-Box
medallion architecture: Bronze -> Silver -> Gold, with ADF pipelines
and Databricks notebooks as the transformation processes.

Usage::

    python scripts/purview/register_lineage.py \\
        --purview-account csapurview \\
        [--dry-run]

Prerequisites:
    - ``az login`` or DefaultAzureCredential
    - ``azure-purview-catalog`` SDK (``pip install azure-purview-catalog``)
    - Purview account bootstrapped (``bootstrap_catalog.py``)
"""

from __future__ import annotations

import argparse
import json
import sys
import uuid
from typing import Any

from csa_platform.governance.common.logging import configure_structlog, get_logger

configure_structlog(service="csa-purview-lineage")
logger = get_logger(__name__)


# ── Lineage entity definitions ───────────────────────────────────────

# Each lineage entry describes a Process that transforms input datasets
# into output datasets.  Purview uses the Atlas type system where
# Processes have inputsand outputs that reference DataSet entities.

LINEAGE_ENTRIES: list[dict[str, Any]] = [
    {
        "name": "adf_bronze_ingestion",
        "description": "ADF pl_ingest_to_bronze: Raw file ingestion from landing to Bronze layer.",
        "owner": "data-engineering@contoso.com",
        "inputs": [
            {
                "qualifiedName": "adls://csadatalake.dfs.core.windows.net/landing/sales",
                "typeName": "azure_datalake_gen2_path",
            },
            {
                "qualifiedName": "adls://csadatalake.dfs.core.windows.net/landing/finance",
                "typeName": "azure_datalake_gen2_path",
            },
        ],
        "outputs": [
            {
                "qualifiedName": "adls://csadatalake.dfs.core.windows.net/bronze/sales",
                "typeName": "azure_datalake_gen2_path",
            },
            {
                "qualifiedName": "adls://csadatalake.dfs.core.windows.net/bronze/finance",
                "typeName": "azure_datalake_gen2_path",
            },
        ],
    },
    {
        "name": "databricks_bronze_to_silver",
        "description": "Databricks notebook bronze_to_silver_spark.py: Schema enforcement, dedup, validation flags.",
        "owner": "data-engineering@contoso.com",
        "inputs": [
            {
                "qualifiedName": "adls://csadatalake.dfs.core.windows.net/bronze/sales",
                "typeName": "azure_datalake_gen2_path",
            },
            {
                "qualifiedName": "adls://csadatalake.dfs.core.windows.net/bronze/finance",
                "typeName": "azure_datalake_gen2_path",
            },
        ],
        "outputs": [
            {
                "qualifiedName": "adls://csadatalake.dfs.core.windows.net/silver/sales",
                "typeName": "azure_datalake_gen2_path",
            },
            {
                "qualifiedName": "adls://csadatalake.dfs.core.windows.net/silver/finance",
                "typeName": "azure_datalake_gen2_path",
            },
        ],
    },
    {
        "name": "dbt_silver_to_gold",
        "description": "dbt models: Business aggregations, star schema dimensions, KPI metrics.",
        "owner": "data-engineering@contoso.com",
        "inputs": [
            {
                "qualifiedName": "adls://csadatalake.dfs.core.windows.net/silver/sales",
                "typeName": "azure_datalake_gen2_path",
            },
            {
                "qualifiedName": "adls://csadatalake.dfs.core.windows.net/silver/finance",
                "typeName": "azure_datalake_gen2_path",
            },
        ],
        "outputs": [
            {
                "qualifiedName": "adls://csadatalake.dfs.core.windows.net/gold/fact_orders",
                "typeName": "azure_datalake_gen2_path",
            },
            {
                "qualifiedName": "adls://csadatalake.dfs.core.windows.net/gold/dim_customers",
                "typeName": "azure_datalake_gen2_path",
            },
            {
                "qualifiedName": "adls://csadatalake.dfs.core.windows.net/gold/gld_monthly_revenue",
                "typeName": "azure_datalake_gen2_path",
            },
            {
                "qualifiedName": "adls://csadatalake.dfs.core.windows.net/gold/gld_customer_lifetime_value",
                "typeName": "azure_datalake_gen2_path",
            },
        ],
    },
    {
        "name": "streaming_eventhub_to_cosmos",
        "description": "Event processing function: Real-time events from Event Hub to Cosmos DB + ADLS archival.",
        "owner": "data-engineering@contoso.com",
        "inputs": [
            {
                "qualifiedName": "eventhub://csa-eventhub.servicebus.windows.net/csa-events",
                "typeName": "azure_event_hubs_topic",
            },
        ],
        "outputs": [
            {
                "qualifiedName": "cosmosdb://csacosmosdb.documents.azure.com/csa-events/events",
                "typeName": "azure_cosmosdb_collection",
            },
            {
                "qualifiedName": "adls://csadatalake.dfs.core.windows.net/bronze/streaming",
                "typeName": "azure_datalake_gen2_path",
            },
        ],
    },
]


def _build_atlas_entity(entry: dict[str, Any]) -> dict[str, Any]:
    """Build an Atlas Process entity payload from a lineage entry."""
    guid = str(uuid.uuid5(uuid.NAMESPACE_URL, f"csa-lineage:{entry['name']}"))

    def _ref(item: dict[str, str]) -> dict[str, Any]:
        return {
            "typeName": item["typeName"],
            "uniqueAttributes": {"qualifiedName": item["qualifiedName"]},
        }

    return {
        "typeName": "Process",
        "attributes": {
            "qualifiedName": f"csa-inabox://{entry['name']}",
            "name": entry["name"],
            "description": entry["description"],
            "owner": entry["owner"],
        },
        "guid": f"-{guid}",
        "relationshipAttributes": {
            "inputs": [_ref(i) for i in entry["inputs"]],
            "outputs": [_ref(o) for o in entry["outputs"]],
        },
    }


def register_lineage(
    account_name: str,
    *,
    dry_run: bool = False,
) -> list[dict[str, Any]]:
    """Register all lineage entities in Purview.

    Args:
        account_name: Purview account name (without .purview.azure.com).
        dry_run: If True, log the payloads without sending them.

    Returns:
        List of registered entity payloads.
    """
    entities = [_build_atlas_entity(e) for e in LINEAGE_ENTRIES]

    if dry_run:
        for entity in entities:
            name = entity["attributes"]["name"]
            logger.info("lineage.dry_run", entity=name, payload=json.dumps(entity, indent=2))
        logger.info("lineage.dry_run_complete", count=len(entities))
        return entities

    try:
        from azure.identity import DefaultAzureCredential
        from azure.purview.catalog import PurviewCatalogClient
    except ImportError:
        logger.error(
            "lineage.sdk_missing",
            message="Install azure-purview-catalog: pip install azure-purview-catalog azure-identity",
        )
        sys.exit(1)

    credential = DefaultAzureCredential()
    endpoint = f"https://{account_name}.purview.azure.com"
    client = PurviewCatalogClient(endpoint=endpoint, credential=credential)

    payload: dict[str, Any] = {
        "entities": entities,
    }

    logger.info("lineage.registering", count=len(entities), account=account_name)
    result: Any = client.entity.create_or_update(body=payload)
    created = result.get("mutatedEntities", {}).get("CREATE", [])
    updated = result.get("mutatedEntities", {}).get("UPDATE", [])
    logger.info(
        "lineage.registered",
        created=len(created),
        updated=len(updated),
    )

    return entities


# ── Scan scheduling ──────────────────────────────────────────────────


def schedule_scans(
    account_name: str,
    storage_account: str,
    *,
    dry_run: bool = False,
) -> None:
    """Create scan definitions and a weekly schedule for ADLS sources.

    Args:
        account_name: Purview account name.
        storage_account: ADLS Gen2 storage account name.
        dry_run: If True, log the payloads without sending them.
    """
    scan_configs = [
        {
            "source_name": f"adls-{storage_account}",
            "scan_name": "weekly-full-scan",
            "scan_level": "Full",
            "schedule": {
                "frequency": "Week",
                "interval": 1,
                "startTime": "2026-01-06T02:00:00Z",
                "weekDays": ["Sunday"],
            },
        },
    ]

    for config in scan_configs:
        logger.info(
            "scan.scheduling",
            source=config["source_name"],
            scan=config["scan_name"],
            schedule=config["schedule"],
            dry_run=dry_run,
        )

        if dry_run:
            logger.info("scan.dry_run_skip", source=config["source_name"])
            continue

        try:
            from azure.identity import DefaultAzureCredential
            from azure.purview.scanning import PurviewScanningClient
        except ImportError:
            logger.error(
                "scan.sdk_missing",
                message="Install azure-purview-scanning: pip install azure-purview-scanning",
            )
            return

        credential = DefaultAzureCredential()
        endpoint = f"https://{account_name}.purview.azure.com"
        client = PurviewScanningClient(endpoint=endpoint, credential=credential)

        # Create the scan definition
        scan_body: dict[str, Any] = {
            "kind": "AdlsGen2Msi",
            "properties": {
                "scanLevel": config["scan_level"],
            },
        }
        client.scans.create_or_update(
            data_source_name=config["source_name"],
            scan_name=config["scan_name"],
            body=scan_body,
        )

        # Attach a schedule trigger
        trigger_body: dict[str, Any] = {
            "properties": {
                "recurrence": config["schedule"],
                "scanLevel": config["scan_level"],
            },
        }
        client.triggers.create_trigger(
            data_source_name=config["source_name"],
            scan_name=config["scan_name"],
            body=trigger_body,
        )
        logger.info("scan.scheduled", source=config["source_name"], scan=config["scan_name"])


# ── CLI ──────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(description="Register lineage in Microsoft Purview")
    parser.add_argument("--purview-account", required=True, help="Purview account name")
    parser.add_argument("--storage-account", default="", help="ADLS storage account name (for scan scheduling)")
    parser.add_argument("--dry-run", action="store_true", help="Log payloads without sending to Purview")
    parser.add_argument("--schedule-scans", action="store_true", help="Also create and schedule scans")
    args = parser.parse_args()

    register_lineage(args.purview_account, dry_run=args.dry_run)

    if args.schedule_scans and args.storage_account:
        schedule_scans(args.purview_account, args.storage_account, dry_run=args.dry_run)
    elif args.schedule_scans and not args.storage_account:
        logger.warning("scan.skipped", message="--schedule-scans requires --storage-account")


if __name__ == "__main__":
    main()
