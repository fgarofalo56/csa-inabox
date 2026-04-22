# -*- coding: utf-8 -*-
"""Marketplace business logic — extracted from routers for testability and reuse.

Follows the same service pattern as :mod:`provisioning.py`: the router
is a thin HTTP layer that delegates all domain logic here.  The service
never raises :class:`~fastapi.HTTPException` — it returns ``None`` or
raises domain-specific errors so the router can map them to HTTP status
codes.

Data-flow contract (CSA-0045)
-----------------------------
Methods never mutate the caller's state directly.  They return new model
instances; the caller (router) is responsible for the HTTP response.
"""

from __future__ import annotations

import logging
import random as _rng
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from ..models.marketplace import (
    AccessRequest,
    AccessRequestCreate,
    AccessRequestStatus,
    DataProduct,
    DataProductCreate,
    LineageInfo,
    QualityDimensions,
    QualityMetric,
    SLADefinition,
)
from ..models.source import ClassificationLevel
from ..persistence_async import AsyncStoreBackend

logger = logging.getLogger(__name__)


class MarketplaceService:
    """Domain service for data product marketplace operations."""

    def __init__(
        self,
        product_store: AsyncStoreBackend,
        quality_store: AsyncStoreBackend,
        access_store: AsyncStoreBackend,
    ) -> None:
        self._products = product_store
        self._quality = quality_store
        self._access = access_store

    # ── Product Operations ──────────────────────────────────────────────

    async def list_products(
        self,
        *,
        domain: str | None = None,
        min_quality: float | None = None,
        search: str | None = None,
        limit: int = 50,
        offset: int = 0,
        scope_domain: str | None = None,
        is_admin: bool = True,
    ) -> list[DataProduct]:
        """Browse data products with optional filters.

        ``scope_domain`` / ``is_admin`` implement CSA-0024 domain scoping:
        non-admin users only see their domain's products.  When a non-admin
        has no domain claim, an empty list is returned (SEC-0005).
        """
        results = [DataProduct.model_validate(item) for item in await self._products.load()]

        # Domain scoping (SEC-0005)
        if not is_admin:
            if not scope_domain:
                return []
            results = [p for p in results if p.domain == scope_domain]

        if domain:
            results = [p for p in results if p.domain == domain]
        if min_quality is not None:
            results = [p for p in results if p.quality_score >= min_quality]
        if search:
            q = search.lower()
            results = [p for p in results if q in p.name.lower() or q in p.description.lower()]

        results.sort(key=lambda p: p.quality_score, reverse=True)
        return results[offset : offset + limit]

    async def get_product(self, product_id: str) -> DataProduct | None:
        """Return a single data product by ID, or ``None`` if not found."""
        stored = await self._products.get(product_id)
        if not stored:
            return None
        return DataProduct.model_validate(stored)

    async def create_product(self, data: DataProductCreate) -> DataProduct:
        """Register a new data product in the marketplace.

        Returns the created :class:`DataProduct`.  Raises ``ValueError``
        if a product with the generated ID already exists (extremely
        unlikely due to UUID suffix).
        """
        now = datetime.now(timezone.utc)
        product_id = self._generate_product_id(data.domain, data.name)

        existing = await self._products.get(product_id)
        if existing:
            raise ValueError(f"Product with ID '{product_id}' already exists.")

        product = DataProduct(
            id=product_id,
            name=data.name,
            description=data.description,
            domain=data.domain,
            owner=data.owner,
            classification=data.classification,
            tags=data.tags,
            schema_def=data.schema_def,
            sample_queries=data.sample_queries,
            documentation_url=data.documentation_url,
            version=data.version,
            status=data.status,
            sla=data.sla,
            lineage=data.lineage,
            schema_info=data.schema_info,
            created_at=now,
            updated_at=now,
        )

        await self._products.add(product.model_dump())
        return product

    async def update_product(
        self,
        product_id: str,
        updates: dict[str, Any],
    ) -> DataProduct | None:
        """Apply *updates* to an existing product.

        Returns the updated product, or ``None`` if not found.
        Raises ``ValueError`` if the update tries to change the domain.
        """
        stored = await self._products.get(product_id)
        if not stored:
            return None

        product = DataProduct.model_validate(stored)

        if "domain" in updates and updates["domain"] != product.domain:
            raise ValueError(
                "Cannot change product domain via update. Use a separate endpoint if needed."
            )

        now = datetime.now(timezone.utc)
        updates["updated_at"] = now

        updated_data = product.model_dump()
        updated_data.update(updates)
        updated_product = DataProduct.model_validate(updated_data)

        await self._products.update(product_id, updated_product.model_dump())
        return updated_product

    async def delete_product(self, product_id: str) -> bool:
        """Delete a product.  Returns ``True`` if found, ``False`` otherwise."""
        stored = await self._products.get(product_id)
        if not stored:
            return False
        await self._products.remove(product_id)
        return True

    # ── Quality Operations ──────────────────────────────────────────────

    async def get_quality_history(
        self,
        product_id: str,
        days: int = 30,
    ) -> list[QualityMetric] | None:
        """Return quality metric history for a product.

        Returns ``None`` if the product doesn't exist (so the router
        can return 404).  Returns an empty list if the product exists
        but has no quality history.
        """
        stored = await self._products.get(product_id)
        if not stored:
            return None

        all_quality_data = await self._quality.load()
        for item in all_quality_data:
            if item.get("product_id") == product_id:
                history = item.get("history", [])
                return [QualityMetric.model_validate(h) for h in history[:days]]

        return []

    async def trigger_quality_assessment(self, product_id: str) -> DataProduct | None:
        """Trigger a quality assessment for a data product.

        In demo mode, generates realistic quality scores.
        Returns ``None`` if the product doesn't exist.
        """
        stored = await self._products.get(product_id)
        if not stored:
            return None

        product = DataProduct.model_validate(stored)

        # Compute quality dimensions (demo mode — generate realistic scores)
        now = datetime.now(timezone.utc)
        quality_dims = QualityDimensions.compute(
            completeness=min(1.0, max(0.0, 0.95 + _rng.uniform(-0.1, 0.05))),
            freshness=min(1.0, max(0.0, 0.92 + _rng.uniform(-0.08, 0.08))),
            accuracy=min(1.0, max(0.0, 0.94 + _rng.uniform(-0.06, 0.06))),
            consistency=min(1.0, max(0.0, 0.91 + _rng.uniform(-0.1, 0.09))),
            uniqueness=min(1.0, max(0.0, 0.96 + _rng.uniform(-0.04, 0.04))),
        )

        # Update product with new quality metrics
        updated_data = product.model_dump()
        updated_data.update({
            "quality_score": quality_dims.overall_score,
            "completeness": quality_dims.completeness,
            "quality_dimensions": quality_dims.model_dump(),
            "updated_at": now,
        })

        updated_product = DataProduct.model_validate(updated_data)
        await self._products.update(product_id, updated_product.model_dump())

        # Append to quality history
        today = now.strftime("%Y-%m-%d")
        new_metric = QualityMetric(
            date=today,
            quality_score=quality_dims.overall_score,
            completeness=quality_dims.completeness,
            freshness_hours=updated_product.freshness_hours,
            row_count=_rng.randint(100_000, 5_000_000),
        )

        # Find existing quality history or create new
        all_quality_data = await self._quality.load()
        quality_record = None
        for item in all_quality_data:
            if item.get("product_id") == product_id:
                quality_record = item
                break

        if quality_record:
            history = quality_record.get("history", [])
            # Remove today's entry if it exists, then add new one
            history = [h for h in history if h.get("date") != today]
            history.insert(0, new_metric.model_dump())  # Most recent first
            quality_record["history"] = history[:365]  # Keep last year only
            await self._quality.update(quality_record["id"], quality_record)
        else:
            await self._quality.add({
                "product_id": product_id,
                "history": [new_metric.model_dump()],
            })

        return updated_product

    # ── Access Request Operations ───────────────────────────────────────

    async def list_access_requests(
        self,
        *,
        status_filter: AccessRequestStatus | None = None,
        product_id: str | None = None,
        requester_email: str | None = None,
        limit: int = 50,
        offset: int = 0,
    ) -> list[AccessRequest]:
        """List access requests with optional filters.

        When *requester_email* is set, only that user's requests are
        returned (non-admin path).
        """
        results = [AccessRequest.model_validate(item) for item in await self._access.load()]

        if requester_email:
            results = [r for r in results if r.requester_email == requester_email]
        if status_filter:
            results = [r for r in results if r.status == status_filter]
        if product_id:
            results = [r for r in results if r.data_product_id == product_id]

        results.sort(key=lambda r: r.requested_at, reverse=True)
        return results[offset : offset + limit]

    async def get_access_request(self, request_id: str) -> AccessRequest | None:
        """Return a single access request by ID, or ``None``."""
        stored = await self._access.get(request_id)
        if not stored:
            return None
        return AccessRequest.model_validate(stored)

    async def create_access_request(
        self,
        data: AccessRequestCreate,
        requester_email: str,
    ) -> AccessRequest | None:
        """Create a new access request.

        Returns ``None`` if the referenced data product doesn't exist.
        """
        product = await self._products.get(data.data_product_id)
        if not product:
            return None

        request_id = f"req-{uuid.uuid4().hex[:12]}"
        now = datetime.now(timezone.utc)

        access_request = AccessRequest(
            id=request_id,
            requester_email=requester_email,
            data_product_id=data.data_product_id,
            justification=data.justification,
            access_level=data.access_level,
            duration_days=data.duration_days,
            requested_at=now,
        )

        await self._access.add(access_request.model_dump())
        return access_request

    async def approve_access_request(
        self,
        request_id: str,
        reviewer_email: str,
    ) -> AccessRequest | None:
        """Approve a pending access request.

        Returns ``None`` if the request doesn't exist.
        Raises ``ValueError`` if the request is not in PENDING status.
        """
        stored = await self._access.get(request_id)
        if not stored:
            return None

        access_request = AccessRequest.model_validate(stored)

        if access_request.status != AccessRequestStatus.PENDING:
            raise ValueError(f"Cannot approve request with status '{access_request.status}'.")

        now = datetime.now(timezone.utc)
        expires_at = now + timedelta(days=access_request.duration_days)

        updated_data = access_request.model_dump()
        updated_data.update({
            "status": AccessRequestStatus.APPROVED,
            "reviewed_at": now,
            "reviewed_by": reviewer_email,
            "expires_at": expires_at,
        })

        updated_request = AccessRequest.model_validate(updated_data)
        await self._access.update(request_id, updated_request.model_dump())
        return updated_request

    async def deny_access_request(
        self,
        request_id: str,
        reviewer_email: str,
        review_notes: str | None = None,
    ) -> AccessRequest | None:
        """Deny an access request.

        Returns ``None`` if the request doesn't exist.
        Raises ``ValueError`` if the request is not in a deniable status.
        """
        stored = await self._access.get(request_id)
        if not stored:
            return None

        access_request = AccessRequest.model_validate(stored)

        if access_request.status not in [AccessRequestStatus.PENDING, AccessRequestStatus.APPROVED]:
            raise ValueError(f"Cannot deny request with status '{access_request.status}'.")

        now = datetime.now(timezone.utc)

        updated_data = access_request.model_dump()
        updated_data.update({
            "status": AccessRequestStatus.DENIED,
            "reviewed_at": now,
            "reviewed_by": reviewer_email,
            "review_notes": review_notes,
        })

        updated_request = AccessRequest.model_validate(updated_data)
        await self._access.update(request_id, updated_request.model_dump())
        return updated_request

    # ── Analytics ───────────────────────────────────────────────────────

    async def get_domain_overview(
        self,
        *,
        scope_domain: str | None = None,
        is_admin: bool = True,
    ) -> list[dict]:
        """Return data domains with their product counts.

        CSA-0024: non-admin callers see only their own domain.
        """
        products = [DataProduct.model_validate(item) for item in await self._products.load()]

        if not is_admin:
            if not scope_domain:
                return []
            products = [p for p in products if p.domain == scope_domain]

        domains = self._count_by_key(products, lambda p: p.domain)
        return [{"name": name, "product_count": count} for name, count in sorted(domains.items())]

    async def get_platform_stats(
        self,
        *,
        scope_domain: str | None = None,
        is_admin: bool = True,
    ) -> dict:
        """Return aggregate marketplace statistics.

        CSA-0024: non-admin callers see only their own domain's aggregates.
        """
        products = [DataProduct.model_validate(item) for item in await self._products.load()]

        if not is_admin:
            if not scope_domain:
                products = []
            else:
                products = [p for p in products if p.domain == scope_domain]

        return {
            "total_products": len(products),
            "total_domains": len({p.domain for p in products}),
            "avg_quality_score": round(
                sum(p.quality_score for p in products) / len(products) if products else 0,
                3,  # 0.0-1.0 ratio — 3 decimals for dashboard precision (CSA-0003)
            ),
            "products_by_domain": dict(
                sorted(self._count_by_key(products, lambda p: p.domain).items())
            ),
        }

    # ── Demo Seeding ────────────────────────────────────────────────────

    async def seed_demo_products(self) -> None:
        """Populate realistic demo data products on first access (async).

        Called once at application startup from the lifespan handler.
        """
        if await self._products.count() > 0:
            return

        _rng.seed(42)

        now = datetime.now(timezone.utc)
        demos = [
            DataProduct(
                id="dp-001",
                name="Employee Master Data",
                description="Curated, PII-masked employee records refreshed daily. "
                "Includes org hierarchy, location, and role information.",
                domain="human-resources",
                owner={"name": "Jane Smith", "email": "jane.smith@contoso.com", "team": "People Analytics"},
                classification=ClassificationLevel.CONFIDENTIAL,
                quality_score=0.945,
                freshness_hours=6.2,
                completeness=0.97,
                availability=0.998,
                tags={"pii": "masked", "refresh": "daily"},
                created_at=datetime(2025, 7, 1, tzinfo=timezone.utc),
                updated_at=now - timedelta(hours=6),
                sample_queries=[
                    "SELECT * FROM hr.employee_master WHERE department = 'Engineering'",
                    "SELECT location, COUNT(*) FROM hr.employee_master GROUP BY location",
                ],
                documentation_url="https://wiki.contoso.com/data/hr-employee-master",
                version="2.1.0",
                status="active",
                sla=SLADefinition(
                    freshness_minutes=360,
                    availability_percent=99.8,
                    valid_row_ratio=0.97,
                ),
                lineage=LineageInfo(
                    upstream=["workday-hris-raw", "org-hierarchy-raw"],
                    downstream=["workforce-analytics", "headcount-reporting"],
                    transformations=[
                        "dbt model: hr_employee_cleansed",
                        "dbt model: hr_employee_master",
                    ],
                ),
            ),
            DataProduct(
                id="dp-002",
                name="Manufacturing Sensor Analytics",
                description="Aggregated sensor telemetry from the manufacturing floor. "
                "5-minute roll-ups for temperature, pressure, and vibration.",
                domain="manufacturing",
                owner={"name": "Bob Chen", "email": "bob.chen@contoso.com", "team": "Manufacturing IT"},
                classification=ClassificationLevel.INTERNAL,
                quality_score=0.912,
                freshness_hours=0.1,
                completeness=0.99,
                availability=0.995,
                tags={"real-time": "true", "iot": "true"},
                created_at=datetime(2025, 10, 1, tzinfo=timezone.utc),
                updated_at=now - timedelta(minutes=5),
                version="1.3.0",
                status="active",
                sla=SLADefinition(
                    freshness_minutes=10,
                    availability_percent=99.5,
                    valid_row_ratio=0.99,
                ),
                lineage=LineageInfo(
                    upstream=["iot-hub-raw-telemetry"],
                    downstream=["predictive-maintenance-model", "oee-dashboard"],
                    transformations=[
                        "ADF pipeline: sensor_5min_aggregation",
                        "dbt model: sensor_analytics_gold",
                    ],
                ),
            ),
            DataProduct(
                id="dp-003",
                name="Financial General Ledger",
                description="Weekly GL snapshot for financial reporting. SOX-compliant with full audit trail.",
                domain="finance",
                owner={"name": "Alice Park", "email": "alice.park@contoso.com", "team": "Financial Reporting"},
                classification=ClassificationLevel.RESTRICTED,
                quality_score=0.981,
                freshness_hours=168.0,
                completeness=1.0,
                availability=0.999,
                tags={"compliance": "sox", "audit": "true"},
                created_at=datetime(2025, 4, 15, tzinfo=timezone.utc),
                updated_at=now - timedelta(days=3),
                version="3.0.0",
                status="active",
                sla=SLADefinition(
                    freshness_minutes=10080,
                    availability_percent=99.9,
                    valid_row_ratio=1.0,
                ),
                lineage=LineageInfo(
                    upstream=["sap-erp-gl-extract", "manual-journal-entries"],
                    downstream=["external-financial-reporting", "management-accounts"],
                    transformations=[
                        "dbt model: gl_staging",
                        "dbt model: gl_validated",
                        "dbt model: gl_snapshot_weekly",
                    ],
                ),
            ),
            DataProduct(
                id="dp-004",
                name="Customer 360 Profile",
                description="Unified customer view combining CRM, web analytics, and transaction data. Updated via CDC.",
                domain="marketing",
                owner={"name": "Carlos Diaz", "email": "carlos.diaz@contoso.com", "team": "Customer Insights"},
                classification=ClassificationLevel.CONFIDENTIAL,
                quality_score=0.873,
                freshness_hours=1.5,
                completeness=0.93,
                availability=0.992,
                tags={"cdp": "true"},
                created_at=datetime(2025, 11, 20, tzinfo=timezone.utc),
                updated_at=now - timedelta(hours=2),
            ),
            DataProduct(
                id="dp-005",
                name="Supply Chain Inventory",
                description="Real-time inventory levels across all warehouses and distribution centers.",
                domain="supply-chain",
                owner={"name": "Diana Torres", "email": "diana.torres@contoso.com", "team": "Supply Chain Ops"},
                classification=ClassificationLevel.INTERNAL,
                quality_score=0.928,
                freshness_hours=0.5,
                completeness=0.96,
                availability=0.997,
                tags={"warehouse": "all"},
                created_at=datetime(2026, 1, 5, tzinfo=timezone.utc),
                updated_at=now - timedelta(minutes=30),
            ),
        ]
        for dp in demos:
            await self._products.add(dp.model_dump())

        # Seed quality history for each product (last 30 days)
        for dp in demos:
            history: list[dict] = []
            for days_ago in range(30):
                date = (now - timedelta(days=days_ago)).strftime("%Y-%m-%d")
                # Clamp the perturbed metric back into the [0.0, 1.0] ratio
                # range so QualityMetric's Field(ge, le) validation passes
                # even at the extremes (CSA-0003).
                score = max(0.0, min(1.0, dp.quality_score + _rng.uniform(-0.03, 0.02)))
                comp = max(0.0, min(1.0, dp.completeness + _rng.uniform(-0.03, 0.01)))
                history.append(
                    QualityMetric(
                        date=date,
                        quality_score=score,
                        completeness=comp,
                        freshness_hours=max(0.0, dp.freshness_hours + _rng.uniform(-1, 2)),
                        row_count=_rng.randint(100_000, 5_000_000),
                    ).model_dump(),
                )
            await self._quality.add({"product_id": dp.id, "history": history})

    # ── Helpers (private) ───────────────────────────────────────────────

    @staticmethod
    def _generate_product_id(domain: str, name: str) -> str:
        """Generate a product ID from domain and name."""
        clean_name = name.lower().replace(" ", "-").replace("_", "-")
        words = clean_name.split("-")[:3]
        clean_name = "-".join(words)[:30]
        return f"dp-{domain}-{clean_name}-{uuid.uuid4().hex[:8]}"

    @staticmethod
    def _count_by_key(items: list, key_fn) -> dict[str, int]:
        """Count items by a key function."""
        counts: dict[str, int] = {}
        for item in items:
            k = key_fn(item)
            counts[k] = counts.get(k, 0) + 1
        return counts
