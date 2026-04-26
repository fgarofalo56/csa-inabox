"""Purview sync service for the Data Marketplace.

Syncs registered data products to Microsoft Purview for unified governance.
Handles entity creation, classification application, lineage registration,
and glossary term association.

Usage:
    from csa_platform.data_marketplace.purview_sync import PurviewSyncService

    sync = PurviewSyncService(purview_endpoint="https://...")
    await sync.sync_product(product)
    await sync.sync_lineage(product)

Prerequisites:
    pip install azure-identity httpx
    PURVIEW_ENDPOINT environment variable set
"""

from __future__ import annotations

from typing import Any

import logging
import os
from dataclasses import dataclass, field

import httpx
from azure.identity import DefaultAzureCredential

logger = logging.getLogger(__name__)


@dataclass
class SyncResult:
    """Result of a Purview sync operation."""

    success: bool
    entity_guid: str | None = None
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


class PurviewSyncService:
    """Sync data products to Microsoft Purview.

    Creates or updates Purview entities for each marketplace data product,
    applies classification labels, and registers lineage relationships.
    """

    def __init__(
        self,
        purview_endpoint: str | None = None,
        credential: DefaultAzureCredential | None = None,
    ) -> None:
        self._endpoint = (
            (purview_endpoint or os.getenv("PURVIEW_ENDPOINT") or "")
        ).rstrip("/")
        self._credential = credential or DefaultAzureCredential()
        self._token: str | None = None

    async def _get_token(self) -> str:
        """Get or refresh access token."""
        if self._token is None:
            token = self._credential.get_token(
                "https://purview.azure.net/.default"
            )
            self._token = token.token
        return self._token

    async def _headers(self) -> dict[str, str]:
        token = await self._get_token()
        return {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        }

    async def sync_product(self, product: dict[str, Any]) -> SyncResult:
        """Sync a data product to Purview as a catalog entity.

        Creates or updates a Purview entity with the product's metadata,
        schema, classifications, and owner information.
        """
        schema_info = product.get("schema_info") or {}
        location = schema_info.get("location", "")
        qualified_name = location or f"marketplace://{product['domain']}/{product['name']}"

        entity = {
            "entity": {
                "typeName": "azure_datalake_gen2_path",
                "attributes": {
                    "qualifiedName": qualified_name,
                    "name": product["name"],
                    "description": product.get("description", ""),
                    "owner": _extract_owner_email(product),
                },
                "classifications": _build_classifications(product),
                "contacts": {
                    "Owner": [
                        {
                            "id": _extract_owner_email(product),
                            "info": product.get("domain", ""),
                        }
                    ]
                },
            }
        }

        # Add custom attributes for marketplace metadata
        entity["entity"]["attributes"].update(  # type: ignore[union-attr, attr-defined, unused-ignore]
            {
                "userProperties": {
                    "marketplace_id": product.get("id", ""),
                    "domain": product.get("domain", ""),
                    "version": product.get("version", "1.0.0"),
                    "quality_score": str(product.get("quality_score", 0)),
                    "status": product.get("status", "active"),
                }
            }
        )

        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{self._endpoint}/datamap/api/atlas/v2/entity",
                    headers=await self._headers(),
                    json=entity,
                    timeout=30,
                )
                resp.raise_for_status()
                data = resp.json()
                guid = next(iter(data.get("guidAssignments", {}).values()), None)
                logger.info("Synced product '%s' to Purview: %s", product["name"], guid)
                return SyncResult(success=True, entity_guid=guid)
        except httpx.HTTPStatusError as exc:
            logger.error("Purview sync failed for '%s': %s", product["name"], exc)
            return SyncResult(success=False, errors=[str(exc)])
        except Exception as exc:
            logger.error("Purview sync error: %s", exc)
            return SyncResult(success=False, errors=[str(exc)])

    async def sync_lineage(self, product: dict[str, Any]) -> SyncResult:
        """Register lineage relationships in Purview.

        Creates lineage edges between the product and its upstream/downstream
        dependencies as defined in the product's lineage field.
        """
        lineage = product.get("lineage")
        if not lineage:
            return SyncResult(success=True, warnings=["No lineage defined"])

        schema_info = product.get("schema_info") or {}
        _product_qn = schema_info.get("location", f"marketplace://{product['domain']}/{product['name']}")

        process_entity = {
            "entity": {
                "typeName": "Process",
                "attributes": {
                    "qualifiedName": f"marketplace://lineage/{product.get('id', '')}",
                    "name": f"Lineage: {product['name']}",
                    "description": f"Data lineage for marketplace product {product['name']}",
                },
                "relationshipAttributes": {
                    "inputs": [
                        {
                            "typeName": "azure_datalake_gen2_path",
                            "uniqueAttributes": {"qualifiedName": src},
                        }
                        for src in lineage.get("upstream", [])
                    ],
                    "outputs": [
                        {
                            "typeName": "azure_datalake_gen2_path",
                            "uniqueAttributes": {"qualifiedName": dst},
                        }
                        for dst in lineage.get("downstream", [])
                    ],
                },
            }
        }

        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{self._endpoint}/datamap/api/atlas/v2/entity",
                    headers=await self._headers(),
                    json=process_entity,
                    timeout=30,
                )
                resp.raise_for_status()
                data = resp.json()
                guid = next(iter(data.get("guidAssignments", {}).values()), None)
                logger.info("Synced lineage for '%s': %s", product["name"], guid)
                return SyncResult(success=True, entity_guid=guid)
        except Exception as exc:
            logger.error("Lineage sync error: %s", exc)
            return SyncResult(success=False, errors=[str(exc)])

    async def sync_quality(self, product: dict[str, Any]) -> SyncResult:
        """Push quality metrics to Purview as entity attributes."""
        quality = product.get("quality_dimensions")
        if not quality:
            return SyncResult(success=True, warnings=["No quality dimensions"])

        schema_info = product.get("schema_info") or {}
        qualified_name = schema_info.get("location", f"marketplace://{product['domain']}/{product['name']}")

        update = {
            "entity": {
                "typeName": "azure_datalake_gen2_path",
                "attributes": {
                    "qualifiedName": qualified_name,
                    "userProperties": {
                        "quality_overall": str(quality.get("overall_score", 0)),
                        "quality_completeness": str(quality.get("completeness", 0)),
                        "quality_freshness": str(quality.get("freshness", 0)),
                        "quality_accuracy": str(quality.get("accuracy", 0)),
                        "quality_consistency": str(quality.get("consistency", 0)),
                        "quality_measured_at": quality.get("measured_at", ""),
                    },
                },
            }
        }

        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{self._endpoint}/datamap/api/atlas/v2/entity",
                    headers=await self._headers(),
                    json=update,
                    timeout=30,
                )
                resp.raise_for_status()
                return SyncResult(success=True)
        except Exception as exc:
            logger.error("Quality sync error: %s", exc)
            return SyncResult(success=False, errors=[str(exc)])

    async def delete_product(self, product_guid: str) -> SyncResult:
        """Remove a product entity from Purview."""
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.delete(
                    f"{self._endpoint}/datamap/api/atlas/v2/entity/guid/{product_guid}",
                    headers=await self._headers(),
                    timeout=30,
                )
                resp.raise_for_status()
                return SyncResult(success=True, entity_guid=product_guid)
        except Exception as exc:
            logger.error("Delete sync error: %s", exc)
            return SyncResult(success=False, errors=[str(exc)])


def _extract_owner_email(product: dict[str, Any]) -> str:
    """Extract owner email from product's owner field."""
    owner = product.get("owner", {})
    if isinstance(owner, dict):
        return owner.get("email", "unknown@contoso.com")
    return "unknown@contoso.com"


def _build_classifications(product: dict[str, Any]) -> list[dict[str, Any]]:
    """Build Purview classification list from product metadata."""
    classification = product.get("classification", "internal")
    mapping = {
        "public": "Microsoft.Public",
        "internal": "Microsoft.General",
        "confidential": "Microsoft.Confidential",
        "restricted": "Microsoft.HighlyConfidential",
    }
    purview_type = mapping.get(classification, "Microsoft.General")
    return [{"typeName": purview_type}]
