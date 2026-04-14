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
import random
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query

from ..models.marketplace import DataProduct, QualityMetric
from ..models.source import ClassificationLevel
from ..services.auth import get_current_user

logger = logging.getLogger(__name__)
router = APIRouter()

# ── In-memory store (demo) ───────────────────────────────────────────────────
# TODO: Replace with Cosmos DB / PostgreSQL repository class.
_products: dict[str, DataProduct] = {}
_quality_history: dict[str, list[QualityMetric]] = {}


def _seed_demo_products() -> None:
    """Populate realistic demo data products on first access."""
    if _products:
        return

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
            quality_score=94.5,
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
        ),
        DataProduct(
            id="dp-002",
            name="Manufacturing Sensor Analytics",
            description="Aggregated sensor telemetry from the manufacturing floor. "
            "5-minute roll-ups for temperature, pressure, and vibration.",
            domain="manufacturing",
            owner={"name": "Bob Chen", "email": "bob.chen@contoso.com", "team": "Manufacturing IT"},
            classification=ClassificationLevel.INTERNAL,
            quality_score=91.2,
            freshness_hours=0.1,
            completeness=0.99,
            availability=0.995,
            tags={"real-time": "true", "iot": "true"},
            created_at=datetime(2025, 10, 1, tzinfo=timezone.utc),
            updated_at=now - timedelta(minutes=5),
        ),
        DataProduct(
            id="dp-003",
            name="Financial General Ledger",
            description="Weekly GL snapshot for financial reporting. "
            "SOX-compliant with full audit trail.",
            domain="finance",
            owner={"name": "Alice Park", "email": "alice.park@contoso.com", "team": "Financial Reporting"},
            classification=ClassificationLevel.RESTRICTED,
            quality_score=98.1,
            freshness_hours=168.0,
            completeness=1.0,
            availability=0.999,
            tags={"compliance": "sox", "audit": "true"},
            created_at=datetime(2025, 4, 15, tzinfo=timezone.utc),
            updated_at=now - timedelta(days=3),
        ),
        DataProduct(
            id="dp-004",
            name="Customer 360 Profile",
            description="Unified customer view combining CRM, web analytics, "
            "and transaction data. Updated via CDC.",
            domain="marketing",
            owner={"name": "Carlos Diaz", "email": "carlos.diaz@contoso.com", "team": "Customer Insights"},
            classification=ClassificationLevel.CONFIDENTIAL,
            quality_score=87.3,
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
            description="Real-time inventory levels across all warehouses "
            "and distribution centers.",
            domain="supply-chain",
            owner={"name": "Diana Torres", "email": "diana.torres@contoso.com", "team": "Supply Chain Ops"},
            classification=ClassificationLevel.INTERNAL,
            quality_score=92.8,
            freshness_hours=0.5,
            completeness=0.96,
            availability=0.997,
            tags={"warehouse": "all"},
            created_at=datetime(2026, 1, 5, tzinfo=timezone.utc),
            updated_at=now - timedelta(minutes=30),
        ),
    ]
    for dp in demos:
        _products[dp.id] = dp

    # Seed quality history for each product (last 30 days)
    for dp in demos:
        history: list[QualityMetric] = []
        for days_ago in range(30):
            date = (now - timedelta(days=days_ago)).strftime("%Y-%m-%d")
            history.append(
                QualityMetric(
                    date=date,
                    quality_score=dp.quality_score + random.uniform(-3, 2),
                    completeness=dp.completeness + random.uniform(-0.03, 0.01),
                    freshness_hours=dp.freshness_hours + random.uniform(-1, 2),
                    row_count=random.randint(100_000, 5_000_000),
                )
            )
        _quality_history[dp.id] = history


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
    _user: dict = Depends(get_current_user),
) -> list[DataProduct]:
    """Browse the data marketplace with optional filters."""
    _seed_demo_products()
    results = list(_products.values())

    if domain:
        results = [p for p in results if p.domain == domain]
    if min_quality is not None:
        results = [p for p in results if p.quality_score >= min_quality]
    if search:
        q = search.lower()
        results = [
            p for p in results
            if q in p.name.lower() or q in p.description.lower()
        ]

    results.sort(key=lambda p: p.quality_score, reverse=True)
    return results[offset: offset + limit]


@router.get(
    "/products/{product_id}",
    response_model=DataProduct,
    summary="Get a data product",
)
async def get_product(
    product_id: str,
    _user: dict = Depends(get_current_user),
) -> DataProduct:
    """Return detailed data product information."""
    _seed_demo_products()
    if product_id not in _products:
        raise HTTPException(status_code=404, detail=f"Product '{product_id}' not found.")
    return _products[product_id]


@router.get(
    "/products/{product_id}/quality",
    response_model=list[QualityMetric],
    summary="Quality history",
)
async def get_quality_history(
    product_id: str,
    days: int = Query(30, ge=1, le=365),
    _user: dict = Depends(get_current_user),
) -> list[QualityMetric]:
    """Return quality metric history for a data product."""
    _seed_demo_products()
    if product_id not in _products:
        raise HTTPException(status_code=404, detail=f"Product '{product_id}' not found.")
    return _quality_history.get(product_id, [])[:days]


@router.get(
    "/domains",
    summary="List domains",
)
async def list_domains(
    _user: dict = Depends(get_current_user),
) -> list[dict]:
    """Return all data domains with their product counts."""
    _seed_demo_products()
    domains: dict[str, int] = {}
    for product in _products.values():
        domains[product.domain] = domains.get(product.domain, 0) + 1

    return [
        {"name": domain, "product_count": count}
        for domain, count in sorted(domains.items())
    ]


@router.get(
    "/stats",
    summary="Marketplace statistics",
)
async def marketplace_stats(
    _user: dict = Depends(get_current_user),
) -> dict:
    """Return aggregate marketplace statistics."""
    _seed_demo_products()
    products = list(_products.values())
    return {
        "total_products": len(products),
        "total_domains": len({p.domain for p in products}),
        "avg_quality_score": round(
            sum(p.quality_score for p in products) / len(products) if products else 0,
            1,
        ),
        "products_by_domain": {
            domain: count
            for domain, count in sorted(
                _count_by_key(products, lambda p: p.domain).items()
            )
        },
    }


def _count_by_key(items: list, key_fn) -> dict[str, int]:
    """Count items by a key function."""
    counts: dict[str, int] = {}
    for item in items:
        k = key_fn(item)
        counts[k] = counts.get(k, 0) + 1
    return counts
