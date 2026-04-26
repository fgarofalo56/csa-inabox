"""Event Grid notification service for marketplace workflows.

Publishes events to Azure Event Grid when marketplace actions occur:
- Data product registered/updated/deleted
- Access request created/approved/denied
- Quality assessment completed
- SLA breach detected

Usage:
    from csa_platform.data_marketplace.notifications import NotificationService

    notifier = NotificationService(topic_endpoint="https://...")
    await notifier.product_registered(product)
    await notifier.access_request_created(request)
"""

from __future__ import annotations

from typing import Any

import logging
import os
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum

import httpx
from azure.identity import DefaultAzureCredential

logger = logging.getLogger(__name__)


class EventType(str, Enum):
    """Marketplace event types."""

    PRODUCT_REGISTERED = "CSA.Marketplace.ProductRegistered"
    PRODUCT_UPDATED = "CSA.Marketplace.ProductUpdated"
    PRODUCT_DELETED = "CSA.Marketplace.ProductDeleted"
    ACCESS_REQUESTED = "CSA.Marketplace.AccessRequested"
    ACCESS_APPROVED = "CSA.Marketplace.AccessApproved"
    ACCESS_DENIED = "CSA.Marketplace.AccessDenied"
    QUALITY_ASSESSED = "CSA.Marketplace.QualityAssessed"
    SLA_BREACH = "CSA.Marketplace.SLABreach"


@dataclass
class MarketplaceEvent:
    """Event payload for Event Grid."""

    event_type: EventType
    subject: str
    data: dict[str, Any]

    def to_event_grid(self) -> dict[str, Any]:
        return {
            "id": str(uuid.uuid4()),
            "eventType": self.event_type.value,
            "subject": self.subject,
            "eventTime": datetime.now(timezone.utc).isoformat(),
            "data": self.data,
            "dataVersion": "1.0",
        }


class NotificationService:
    """Publish marketplace events to Azure Event Grid."""

    def __init__(
        self,
        topic_endpoint: str | None = None,
        credential: DefaultAzureCredential | None = None,
    ) -> None:
        self._endpoint = (
            (topic_endpoint or os.getenv("EVENT_GRID_TOPIC_ENDPOINT") or "")
        ).rstrip("/")
        self._credential = credential or DefaultAzureCredential()
        self._enabled = bool(self._endpoint)

    async def _publish(self, event: MarketplaceEvent) -> None:
        """Publish an event to Event Grid."""
        if not self._enabled:
            logger.debug("Event Grid not configured, skipping: %s", event.event_type)
            return

        token = self._credential.get_token(
            "https://eventgrid.azure.net/.default"
        )

        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    self._endpoint,
                    headers={
                        "Authorization": f"Bearer {token.token}",
                        "Content-Type": "application/json",
                    },
                    json=[event.to_event_grid()],
                    timeout=10,
                )
                resp.raise_for_status()
                logger.info("Published event: %s", event.event_type.value)
        except Exception as exc:
            logger.warning("Failed to publish event %s: %s", event.event_type, exc)

    async def product_registered(self, product: dict[str, Any]) -> None:
        await self._publish(MarketplaceEvent(
            event_type=EventType.PRODUCT_REGISTERED,
            subject=f"/marketplace/products/{product.get('id', '')}",
            data={
                "product_id": product.get("id"),
                "name": product.get("name"),
                "domain": product.get("domain"),
                "owner": product.get("owner", {}),
            },
        ))

    async def product_updated(self, product: dict[str, Any]) -> None:
        await self._publish(MarketplaceEvent(
            event_type=EventType.PRODUCT_UPDATED,
            subject=f"/marketplace/products/{product.get('id', '')}",
            data={
                "product_id": product.get("id"),
                "name": product.get("name"),
                "updated_fields": list(product.keys()),
            },
        ))

    async def product_deleted(self, product_id: str) -> None:
        await self._publish(MarketplaceEvent(
            event_type=EventType.PRODUCT_DELETED,
            subject=f"/marketplace/products/{product_id}",
            data={"product_id": product_id},
        ))

    async def access_request_created(self, request: dict[str, Any]) -> None:
        await self._publish(MarketplaceEvent(
            event_type=EventType.ACCESS_REQUESTED,
            subject=f"/marketplace/access-requests/{request.get('id', '')}",
            data={
                "request_id": request.get("id"),
                "product_id": request.get("data_product_id"),
                "requester": request.get("requester_email"),
                "access_level": request.get("access_level"),
                "justification": request.get("justification"),
            },
        ))

    async def access_approved(self, request: dict[str, Any]) -> None:
        await self._publish(MarketplaceEvent(
            event_type=EventType.ACCESS_APPROVED,
            subject=f"/marketplace/access-requests/{request.get('id', '')}",
            data={
                "request_id": request.get("id"),
                "product_id": request.get("data_product_id"),
                "requester": request.get("requester_email"),
                "approved_by": request.get("reviewed_by"),
                "expires_at": request.get("expires_at"),
            },
        ))

    async def access_denied(self, request: dict[str, Any]) -> None:
        await self._publish(MarketplaceEvent(
            event_type=EventType.ACCESS_DENIED,
            subject=f"/marketplace/access-requests/{request.get('id', '')}",
            data={
                "request_id": request.get("id"),
                "product_id": request.get("data_product_id"),
                "requester": request.get("requester_email"),
                "denied_by": request.get("reviewed_by"),
                "reason": request.get("review_notes"),
            },
        ))

    async def quality_assessed(self, product_id: str, quality: dict[str, Any]) -> None:
        await self._publish(MarketplaceEvent(
            event_type=EventType.QUALITY_ASSESSED,
            subject=f"/marketplace/products/{product_id}/quality",
            data={
                "product_id": product_id,
                "overall_score": quality.get("overall_score"),
                "gate_status": "PASS" if quality.get("overall_score", 0) >= 0.8 else "FAIL",
            },
        ))

    async def sla_breach(self, product_id: str, breach_details: dict[str, Any]) -> None:
        await self._publish(MarketplaceEvent(
            event_type=EventType.SLA_BREACH,
            subject=f"/marketplace/products/{product_id}/sla",
            data={
                "product_id": product_id,
                "breach_type": breach_details.get("type"),
                "expected": breach_details.get("expected"),
                "actual": breach_details.get("actual"),
            },
        ))
