"""
Data marketplace router.

Endpoints
---------
GET    /api/v1/marketplace/products                        — list data products
GET    /api/v1/marketplace/products/{product_id}            — get data product
POST   /api/v1/marketplace/products                        — register data product
PUT    /api/v1/marketplace/products/{product_id}           — update data product
DELETE /api/v1/marketplace/products/{product_id}           — delete data product
POST   /api/v1/marketplace/products/{product_id}/quality   — trigger quality assessment
GET    /api/v1/marketplace/products/{product_id}/quality    — quality history
GET    /api/v1/marketplace/domains                          — list domains
GET    /api/v1/marketplace/stats                            — marketplace stats
POST   /api/v1/marketplace/access-requests                  — create access request
GET    /api/v1/marketplace/access-requests                  — list access requests
GET    /api/v1/marketplace/access-requests/{request_id}     — get access request
PUT    /api/v1/marketplace/access-requests/{request_id}/approve — approve request
PUT    /api/v1/marketplace/access-requests/{request_id}/deny — deny request
"""

from __future__ import annotations

import logging
import random as _rng
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status

from ..dependencies import get_access_requests_store, get_products_store, get_quality_store
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
from ..services.auth import DomainScope, get_current_user, get_domain_scope

logger = logging.getLogger(__name__)
router = APIRouter()


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
    search: str | None = Query(None, max_length=256),
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


def _generate_product_id(domain: str, name: str) -> str:
    """Generate a product ID from domain and name."""
    # Clean the name to be URL-safe and shorter
    clean_name = name.lower().replace(" ", "-").replace("_", "-")
    # Take first 3 words max, limit to 50 chars total
    words = clean_name.split("-")[:3]
    clean_name = "-".join(words)[:30]
    return f"dp-{domain}-{clean_name}-{uuid.uuid4().hex[:8]}"


def _assert_user_can_access_domain(user_domain: str | None, is_admin: bool, product_domain: str) -> None:
    """Assert that a user can access a specific domain's products.

    Raises HTTPException(403) if the user cannot access the domain.
    """
    if not is_admin and (not user_domain or product_domain != user_domain):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have access to this domain.",
        )


def _assert_admin_only(user: dict[str, Any]) -> None:
    """Assert that a user has admin role.

    Raises HTTPException(403) if the user is not an admin.
    """
    roles = user.get("roles", [])
    if "Admin" not in roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin role required for this operation.",
        )


# ── Write Endpoints ─────────────────────────────────────────────────────────


@router.post(
    "/products",
    response_model=DataProduct,
    status_code=status.HTTP_201_CREATED,
    summary="Register a new data product",
)
async def create_product(
    product_data: DataProductCreate,
    scope: DomainScope = Depends(get_domain_scope),
    store: AsyncStoreBackend = Depends(get_products_store),
) -> DataProduct:
    """Register a new data product in the marketplace.

    Domain scoping: non-admin users can only create products in their own domain.
    """
    # Domain scoping enforcement
    _assert_user_can_access_domain(scope.user_domain, scope.is_admin, product_data.domain)

    now = datetime.now(timezone.utc)

    # Auto-generate ID if not provided
    product_id = _generate_product_id(product_data.domain, product_data.name)

    # Check if product with same ID already exists
    existing = await store.get(product_id)
    if existing:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Product with ID '{product_id}' already exists.",
        )

    # Create the full DataProduct
    product = DataProduct(
        id=product_id,
        name=product_data.name,
        description=product_data.description,
        domain=product_data.domain,
        owner=product_data.owner,
        classification=product_data.classification,
        tags=product_data.tags,
        schema_def=product_data.schema_def,
        sample_queries=product_data.sample_queries,
        documentation_url=product_data.documentation_url,
        version=product_data.version,
        status=product_data.status,
        sla=product_data.sla,
        lineage=product_data.lineage,
        schema_info=product_data.schema_info,
        created_at=now,
        updated_at=now,
    )

    await store.add(product.model_dump())
    return product


@router.put(
    "/products/{product_id}",
    response_model=DataProduct,
    summary="Update a data product",
)
async def update_product(
    product_id: str,
    updates: dict[str, Any],
    scope: DomainScope = Depends(get_domain_scope),
    store: AsyncStoreBackend = Depends(get_products_store),
) -> DataProduct:
    """Update an existing data product.

    Only the domain owner or admin can update a product.
    """
    # Get existing product
    stored_product = await store.get(product_id)
    if not stored_product:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Product '{product_id}' not found.",
        )

    product = DataProduct.model_validate(stored_product)

    # Domain scoping enforcement
    _assert_user_can_access_domain(scope.user_domain, scope.is_admin, product.domain)

    # Apply updates
    now = datetime.now(timezone.utc)
    updates["updated_at"] = now

    # Prevent changing the domain via update
    if "domain" in updates and updates["domain"] != product.domain:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Cannot change product domain via update. Use a separate endpoint if needed.",
        )

    # Create updated product
    updated_data = product.model_dump()
    updated_data.update(updates)
    updated_product = DataProduct.model_validate(updated_data)

    await store.update(product_id, updated_product.model_dump())
    return updated_product


@router.delete(
    "/products/{product_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="Delete a data product",
)
async def delete_product(
    product_id: str,
    user: dict[str, Any] = Depends(get_current_user),
    store: AsyncStoreBackend = Depends(get_products_store),
) -> None:
    """Delete a data product (admin only)."""
    # Admin-only operation
    _assert_admin_only(user)

    # Check if product exists
    stored_product = await store.get(product_id)
    if not stored_product:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Product '{product_id}' not found.",
        )

    await store.remove(product_id)


@router.post(
    "/products/{product_id}/quality",
    response_model=DataProduct,
    summary="Trigger quality assessment",
)
async def trigger_quality_assessment(
    product_id: str,
    scope: DomainScope = Depends(get_domain_scope),
    store: AsyncStoreBackend = Depends(get_products_store),
    quality_store: AsyncStoreBackend = Depends(get_quality_store),
) -> DataProduct:
    """Trigger a quality assessment for a data product.

    In demo mode, generates realistic quality scores.
    """
    # Get existing product
    stored_product = await store.get(product_id)
    if not stored_product:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Product '{product_id}' not found.",
        )

    product = DataProduct.model_validate(stored_product)

    # Domain scoping enforcement
    _assert_user_can_access_domain(scope.user_domain, scope.is_admin, product.domain)

    # Compute quality dimensions (demo mode - generate realistic scores)
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
    await store.update(product_id, updated_product.model_dump())

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
    all_quality_data = await quality_store.load()
    quality_record = None
    for item in all_quality_data:
        if item.get("product_id") == product_id:
            quality_record = item
            break

    if quality_record:
        history = quality_record.get("history", [])
        # Remove today's entry if it exists, then add new one
        history = [h for h in history if h.get("date") != today]
        history.insert(0, new_metric.model_dump())  # Add at beginning (most recent)
        quality_record["history"] = history[:365]  # Keep last year only
        await quality_store.update(quality_record["id"], quality_record)
    else:
        # Create new quality history record
        await quality_store.add({
            "product_id": product_id,
            "history": [new_metric.model_dump()],
        })

    return updated_product


@router.post(
    "/access-requests",
    response_model=AccessRequest,
    status_code=status.HTTP_201_CREATED,
    summary="Create an access request",
)
async def create_access_request(
    request_data: AccessRequestCreate,
    user: dict[str, Any] = Depends(get_current_user),
    store: AsyncStoreBackend = Depends(get_access_requests_store),
    products_store: AsyncStoreBackend = Depends(get_products_store),
) -> AccessRequest:
    """Create a new access request for a data product."""
    # Validate that the data product exists
    product = await products_store.get(request_data.data_product_id)
    if not product:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Data product '{request_data.data_product_id}' not found.",
        )

    # Generate request ID and get user email
    request_id = f"req-{uuid.uuid4().hex[:12]}"
    requester_email = user.get("email", user.get("sub", "unknown@example.com"))

    now = datetime.now(timezone.utc)

    # Create the access request
    access_request = AccessRequest(
        id=request_id,
        requester_email=requester_email,
        data_product_id=request_data.data_product_id,
        justification=request_data.justification,
        access_level=request_data.access_level,
        duration_days=request_data.duration_days,
        requested_at=now,
    )

    await store.add(access_request.model_dump())
    return access_request


@router.get(
    "/access-requests",
    response_model=list[AccessRequest],
    summary="List access requests",
)
async def list_access_requests(
    status_filter: AccessRequestStatus | None = Query(None, alias="status"),
    product_id: str | None = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    user: dict[str, Any] = Depends(get_current_user),
    store: AsyncStoreBackend = Depends(get_access_requests_store),
) -> list[AccessRequest]:
    """List access requests.

    Admin users see all requests. Regular users see only their own.
    """
    results = [AccessRequest.model_validate(item) for item in await store.load()]

    # Filter by user unless admin
    roles = user.get("roles", [])
    is_admin = "Admin" in roles
    if not is_admin:
        user_email = user.get("email", user.get("sub", "unknown@example.com"))
        results = [r for r in results if r.requester_email == user_email]

    # Apply filters
    if status_filter:
        results = [r for r in results if r.status == status_filter]
    if product_id:
        results = [r for r in results if r.data_product_id == product_id]

    # Sort by most recent first
    results.sort(key=lambda r: r.requested_at, reverse=True)
    return results[offset : offset + limit]


@router.get(
    "/access-requests/{request_id}",
    response_model=AccessRequest,
    summary="Get access request details",
)
async def get_access_request(
    request_id: str,
    user: dict[str, Any] = Depends(get_current_user),
    store: AsyncStoreBackend = Depends(get_access_requests_store),
) -> AccessRequest:
    """Get details of a specific access request."""
    stored_request = await store.get(request_id)
    if not stored_request:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Access request '{request_id}' not found.",
        )

    access_request = AccessRequest.model_validate(stored_request)

    # Check if user can access this request
    roles = user.get("roles", [])
    is_admin = "Admin" in roles
    user_email = user.get("email", user.get("sub", "unknown@example.com"))

    if not is_admin and access_request.requester_email != user_email:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You can only view your own access requests.",
        )

    return access_request


@router.put(
    "/access-requests/{request_id}/approve",
    response_model=AccessRequest,
    summary="Approve access request",
)
async def approve_access_request(
    request_id: str,
    user: dict[str, Any] = Depends(get_current_user),
    store: AsyncStoreBackend = Depends(get_access_requests_store),
    products_store: AsyncStoreBackend = Depends(get_products_store),
) -> AccessRequest:
    """Approve an access request.

    Only product owners or admins can approve requests.
    """
    stored_request = await store.get(request_id)
    if not stored_request:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Access request '{request_id}' not found.",
        )

    access_request = AccessRequest.model_validate(stored_request)

    # Get the product to check ownership
    product = await products_store.get(access_request.data_product_id)
    if not product:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Data product '{access_request.data_product_id}' not found.",
        )

    product_data = DataProduct.model_validate(product)

    # Check permissions: admin or product owner
    roles = user.get("roles", [])
    is_admin = "Admin" in roles
    user_email = user.get("email", user.get("sub", "unknown@example.com"))

    if not is_admin and product_data.owner.email != user_email:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the product owner or admin can approve access requests.",
        )

    # Check if request is in a valid state to approve
    if access_request.status != AccessRequestStatus.PENDING:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot approve request with status '{access_request.status}'.",
        )

    # Update request
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(days=access_request.duration_days)

    updated_data = access_request.model_dump()
    updated_data.update({
        "status": AccessRequestStatus.APPROVED,
        "reviewed_at": now,
        "reviewed_by": user_email,
        "expires_at": expires_at,
    })

    updated_request = AccessRequest.model_validate(updated_data)
    await store.update(request_id, updated_request.model_dump())

    return updated_request


@router.put(
    "/access-requests/{request_id}/deny",
    response_model=AccessRequest,
    summary="Deny access request",
)
async def deny_access_request(
    request_id: str,
    review_notes: str | None = None,
    user: dict[str, Any] = Depends(get_current_user),
    store: AsyncStoreBackend = Depends(get_access_requests_store),
    products_store: AsyncStoreBackend = Depends(get_products_store),
) -> AccessRequest:
    """Deny an access request.

    Only product owners or admins can deny requests.
    """
    stored_request = await store.get(request_id)
    if not stored_request:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Access request '{request_id}' not found.",
        )

    access_request = AccessRequest.model_validate(stored_request)

    # Get the product to check ownership
    product = await products_store.get(access_request.data_product_id)
    if not product:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Data product '{access_request.data_product_id}' not found.",
        )

    product_data = DataProduct.model_validate(product)

    # Check permissions: admin or product owner
    roles = user.get("roles", [])
    is_admin = "Admin" in roles
    user_email = user.get("email", user.get("sub", "unknown@example.com"))

    if not is_admin and product_data.owner.email != user_email:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the product owner or admin can deny access requests.",
        )

    # Check if request is in a valid state to deny
    if access_request.status not in [AccessRequestStatus.PENDING, AccessRequestStatus.APPROVED]:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Cannot deny request with status '{access_request.status}'.",
        )

    # Update request
    now = datetime.now(timezone.utc)

    updated_data = access_request.model_dump()
    updated_data.update({
        "status": AccessRequestStatus.DENIED,
        "reviewed_at": now,
        "reviewed_by": user_email,
        "review_notes": review_notes,
    })

    updated_request = AccessRequest.model_validate(updated_data)
    await store.update(request_id, updated_request.model_dump())

    return updated_request
