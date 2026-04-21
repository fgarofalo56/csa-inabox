"""
Data marketplace router.

Endpoints
---------
GET    /api/v1/marketplace/products                        — list data products
GET    /api/v1/marketplace/products/{product_id}            — get data product
GET    /api/v1/marketplace/products/{product_id}/quality    — quality history
GET    /api/v1/marketplace/domains                          — list domains
GET    /api/v1/marketplace/stats                            — marketplace stats
"""

from __future__ import annotations

import logging
import random as _rng
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query

from ..config import settings
from ..dependencies import get_products_store, get_quality_store
from ..models.marketplace import DataProduct, QualityMetric
from ..models.source import ClassificationLevel
from ..persistence import StoreBackend
from ..persistence_async import AsyncStoreBackend
from ..persistence_factory import build_store_backend
from ..services.auth import DomainScope, get_domain_scope

logger = logging.getLogger(__name__)
router = APIRouter()

# ── Persistence ─────────────────────────────────────────────────────────────
# Backend chosen by the async factory from ``settings.DATABASE_URL`` — see
# ADR-0016.  The sync singletons below are retained as a transitional compat
# layer for the stats router + existing test fixtures.
_products_store: StoreBackend = build_store_backend("marketplace_products.json", settings)
_quality_store: StoreBackend = build_store_backend("marketplace_quality.json", settings)


def get_store() -> StoreBackend:
    """Return the sync products store (compat; new code uses async DI)."""
    return _products_store


async def seed_demo_products() -> None:
    """Populate realistic demo data products on first access (async).

    Called once at application startup from the lifespan handler.
    """
    async_products = get_products_store()
    async_quality = get_quality_store()
    if await async_products.count() > 0:
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
            sla={
                "freshness_minutes": 360,
                "availability_percent": 99.8,
                "valid_row_ratio": 0.97,
            },
            lineage={
                "upstream": ["workday-hris-raw", "org-hierarchy-raw"],
                "downstream": ["workforce-analytics", "headcount-reporting"],
                "transformations": [
                    "dbt model: hr_employee_cleansed",
                    "dbt model: hr_employee_master",
                ],
            },
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
            sla={
                "freshness_minutes": 10,
                "availability_percent": 99.5,
                "valid_row_ratio": 0.99,
            },
            lineage={
                "upstream": ["iot-hub-raw-telemetry"],
                "downstream": ["predictive-maintenance-model", "oee-dashboard"],
                "transformations": [
                    "ADF pipeline: sensor_5min_aggregation",
                    "dbt model: sensor_analytics_gold",
                ],
            },
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
            sla={
                "freshness_minutes": 10080,
                "availability_percent": 99.9,
                "valid_row_ratio": 1.0,
            },
            lineage={
                "upstream": ["sap-erp-gl-extract", "manual-journal-entries"],
                "downstream": ["external-financial-reporting", "management-accounts"],
                "transformations": [
                    "dbt model: gl_staging",
                    "dbt model: gl_validated",
                    "dbt model: gl_snapshot_weekly",
                ],
            },
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
        await async_products.add(dp.model_dump())

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
        await async_quality.add({"product_id": dp.id, "history": history})


# ── Endpoints ────────────────────────────────────────────────────────────────


@router.get(
    "/products",
    response_model=list[DataProduct],
    summary="Browse data products",
)
async def list_products(
    domain: str | None = None,
    search: str | None = None,
    min_quality: float | None = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    scope: DomainScope = Depends(get_domain_scope),
    store: AsyncStoreBackend = Depends(get_products_store),
) -> list[DataProduct]:
    """Browse the data marketplace with optional filters."""
    results = [DataProduct.model_validate(item) for item in await store.load()]

    # Domain scoping: non-admin users only see their domain's products.
    # When a non-admin has no domain claim (e.g. demo mode), return empty
    # rather than leaking data across all domains (SEC-0005).
    if not scope.is_admin:
        if not scope.user_domain:
            return []
        results = [p for p in results if p.domain == scope.user_domain]

    if domain:
        results = [p for p in results if p.domain == domain]
    if min_quality is not None:
        results = [p for p in results if p.quality_score >= min_quality]
    if search:
        q = search.lower()
        results = [p for p in results if q in p.name.lower() or q in p.description.lower()]

    results.sort(key=lambda p: p.quality_score, reverse=True)
    return results[offset : offset + limit]


@router.get(
    "/products/{product_id}",
    response_model=DataProduct,
    summary="Get a data product",
)
async def get_product(
    product_id: str,
    scope: DomainScope = Depends(get_domain_scope),
    store: AsyncStoreBackend = Depends(get_products_store),
) -> DataProduct:
    """Return detailed data product information."""
    stored_product = await store.get(product_id)
    if not stored_product:
        raise HTTPException(status_code=404, detail=f"Product '{product_id}' not found.")
    product = DataProduct.model_validate(stored_product)

    # Domain scoping: non-admin users can only access their domain's products.
    # A non-admin with no domain claim is denied regardless of the product domain.
    if not scope.is_admin and (not scope.user_domain or product.domain != scope.user_domain):
        raise HTTPException(status_code=403, detail="You do not have access to this product.")

    return product


@router.get(
    "/products/{product_id}/quality",
    response_model=list[QualityMetric],
    summary="Quality history",
)
async def get_quality_history(
    product_id: str,
    days: int = Query(30, ge=1, le=365),
    scope: DomainScope = Depends(get_domain_scope),
    store: AsyncStoreBackend = Depends(get_products_store),
    quality_store: AsyncStoreBackend = Depends(get_quality_store),
) -> list[QualityMetric]:
    """Return quality metric history for a data product.

    Non-admin users may only view quality history for products in their
    domain (SEC-0007).
    """
    stored = await store.get(product_id)
    if not stored:
        raise HTTPException(status_code=404, detail=f"Product '{product_id}' not found.")

    product = DataProduct.model_validate(stored)

    # Domain scoping: enforce for non-admin callers (SEC-0007).
    if not scope.is_admin and (not scope.user_domain or product.domain != scope.user_domain):
        raise HTTPException(status_code=403, detail="You do not have access to this product.")

    # Find quality history for this product
    all_quality_data = await quality_store.load()
    for item in all_quality_data:
        if item.get("product_id") == product_id:
            history = item.get("history", [])
            return [QualityMetric.model_validate(h) for h in history[:days]]

    return []


@router.get(
    "/domains",
    summary="List domains",
)
async def list_domains(
    scope: DomainScope = Depends(get_domain_scope),
    store: AsyncStoreBackend = Depends(get_products_store),
) -> list[dict]:
    """Return data domains with their product counts.

    CSA-0024: non-admin callers see only their own domain. Admins
    retain platform-wide visibility.
    """
    domains: dict[str, int] = {}
    products = [DataProduct.model_validate(item) for item in await store.load()]
    if not scope.is_admin:
        if not scope.user_domain:
            return []
        products = [p for p in products if p.domain == scope.user_domain]
    for product in products:
        domains[product.domain] = domains.get(product.domain, 0) + 1

    return [{"name": domain, "product_count": count} for domain, count in sorted(domains.items())]


@router.get(
    "/stats",
    summary="Marketplace statistics",
)
async def marketplace_stats(
    scope: DomainScope = Depends(get_domain_scope),
    store: AsyncStoreBackend = Depends(get_products_store),
) -> dict:
    """Return aggregate marketplace statistics.

    CSA-0024: non-admin callers see only their own domain's aggregates.
    Admins retain platform-wide totals.
    """
    products = [DataProduct.model_validate(item) for item in await store.load()]
    if not scope.is_admin:
        if not scope.user_domain:
            products = []
        else:
            products = [p for p in products if p.domain == scope.user_domain]
    return {
        "total_products": len(products),
        "total_domains": len({p.domain for p in products}),
        "avg_quality_score": round(
            sum(p.quality_score for p in products) / len(products) if products else 0,
            3,  # 0.0-1.0 ratio — 3 decimals for dashboard precision (CSA-0003)
        ),
        "products_by_domain": dict(sorted(_count_by_key(products, lambda p: p.domain).items())),
    }


def _count_by_key(items: list, key_fn) -> dict[str, int]:
    """Count items by a key function."""
    counts: dict[str, int] = {}
    for item in items:
        k = key_fn(item)
        counts[k] = counts.get(k, 0) + 1
    return counts
