"""FastAPI application for the CSA-in-a-Box Data Marketplace.

Provides REST endpoints for data product registration, discovery, access
request workflows, and quality monitoring. Backed by Azure Cosmos DB and
integrated with Azure Purview for governance.

Endpoints:
    GET  /products                      — List all data products
    GET  /products/{id}                 — Get product details
    POST /products                      — Register a new data product
    POST /access-requests               — Request access to a product
    GET  /access-requests/{id}          — Check request status
    PUT  /access-requests/{id}/approve  — Approve/deny access request
    GET  /products/{id}/quality         — Get quality metrics history
"""

from __future__ import annotations

import os
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware

from csa_platform.common.auth import (
    enforce_auth_safety_gate,
    require_role,
)
from csa_platform.data_marketplace.models.data_product import (
    AccessRequest,
    AccessRequestApproval,
    AccessRequestCreate,
    AccessRequestStatus,
    DataProduct,
    DataProductBase,
    DataProductSummary,
    PaginatedResponse,
    QualityHistoryResponse,
    QualityMetric,
)
from governance.common.logging import configure_structlog, get_logger

configure_structlog(service="data-marketplace-api")
logger = get_logger(__name__)


# ──────────────────────────────────────────────────────────────────────
# Role aliases for readability
# ──────────────────────────────────────────────────────────────────────
#
# Role model matches portal.shared.api (Reader / Contributor / Admin)
# configured in the Entra ID app registration.
#
#   Reader      — browse marketplace, view product details and quality
#   Contributor — register data products, submit access requests
#   Admin       — approve / deny access requests

_ANY_AUTHENTICATED_USER = require_role("Reader", "Contributor", "Admin")
_CONTRIBUTOR_OR_ADMIN = require_role("Contributor", "Admin")
_ADMIN_ONLY = require_role("Admin")


# ──────────────────────────────────────────────────────────────────────
# Cosmos DB client (lazy initialization)
# ──────────────────────────────────────────────────────────────────────

_cosmos_client: Any | None = None
_database: Any | None = None


async def _get_cosmos_database() -> Any:
    """Get or create the Cosmos DB database client.

    Uses the ``azure-cosmos`` async client with Azure AD authentication
    via ``DefaultAzureCredential``.
    """
    global _cosmos_client, _database

    if _database is not None:
        return _database

    try:
        from azure.cosmos.aio import CosmosClient
        from azure.identity.aio import DefaultAzureCredential
    except ImportError as exc:
        raise RuntimeError(
            "azure-cosmos and azure-identity packages are required. "
            "Install with: pip install azure-cosmos azure-identity"
        ) from exc

    endpoint = os.environ.get("COSMOS_ENDPOINT", "")
    database_name = os.environ.get("COSMOS_DATABASE", "marketplace")

    if not endpoint:
        raise RuntimeError("COSMOS_ENDPOINT environment variable is required")

    credential = DefaultAzureCredential()
    _cosmos_client = CosmosClient(endpoint, credential=credential)
    _database = _cosmos_client.get_database_client(database_name)
    return _database


async def _get_container(container_name: str) -> Any:
    """Get a Cosmos DB container client."""
    db = await _get_cosmos_database()
    return db.get_container_client(container_name)


# ──────────────────────────────────────────────────────────────────────
# In-memory store (fallback for development / testing)
# ──────────────────────────────────────────────────────────────────────


class InMemoryStore:
    """In-memory data store for development and testing.

    Provides the same interface as Cosmos DB containers but stores
    data in dictionaries. NOT for production use.
    """

    def __init__(self) -> None:
        self.products: dict[str, dict[str, Any]] = {}
        self.access_requests: dict[str, dict[str, Any]] = {}
        self.quality_metrics: dict[str, list[dict[str, Any]]] = {}

    async def create_product(self, product: DataProduct) -> DataProduct:
        """Store a data product."""
        self.products[product.id] = product.model_dump(mode="json", by_alias=True)
        return product

    async def get_product(self, product_id: str) -> DataProduct | None:
        """Retrieve a product by ID."""
        data = self.products.get(product_id)
        return DataProduct(**data) if data else None

    async def list_products(
        self,
        domain: str | None = None,
        tags: list[str] | None = None,
        search: str | None = None,
        page: int = 1,
        per_page: int = 20,
    ) -> tuple[list[DataProduct], int]:
        """List products with optional filtering."""
        items = list(self.products.values())

        if domain:
            items = [i for i in items if i.get("domain") == domain]
        if tags:
            items = [i for i in items if any(t in i.get("tags", []) for t in tags)]
        if search:
            search_lower = search.lower()
            items = [
                i
                for i in items
                if search_lower in i.get("name", "").lower() or search_lower in i.get("description", "").lower()
            ]

        total = len(items)
        start = (page - 1) * per_page
        end = start + per_page
        page_items = items[start:end]

        return [DataProduct(**i) for i in page_items], total

    async def update_product(self, product: DataProduct) -> DataProduct:
        """Update a product."""
        self.products[product.id] = product.model_dump(mode="json", by_alias=True)
        return product

    async def create_access_request(self, request: AccessRequest) -> AccessRequest:
        """Store an access request."""
        self.access_requests[request.id] = request.model_dump(mode="json", by_alias=True)
        return request

    async def get_access_request(self, request_id: str) -> AccessRequest | None:
        """Retrieve an access request by ID."""
        data = self.access_requests.get(request_id)
        return AccessRequest(**data) if data else None

    async def update_access_request(self, request: AccessRequest) -> AccessRequest:
        """Update an access request."""
        self.access_requests[request.id] = request.model_dump(mode="json", by_alias=True)
        return request

    async def add_quality_metric(self, metric: QualityMetric) -> QualityMetric:
        """Store a quality metric."""
        product_id = metric.product_id
        if product_id not in self.quality_metrics:
            self.quality_metrics[product_id] = []
        self.quality_metrics[product_id].append(
            metric.model_dump(mode="json", by_alias=True),
        )
        return metric

    async def get_quality_history(
        self,
        product_id: str,
        limit: int = 30,
    ) -> list[QualityMetric]:
        """Get quality metric history for a product."""
        metrics = self.quality_metrics.get(product_id, [])
        sorted_metrics = sorted(
            metrics,
            key=lambda m: m.get("measured_at", ""),
            reverse=True,
        )
        return [QualityMetric(**m) for m in sorted_metrics[:limit]]


# Global store instance — replaced with Cosmos DB in production.
_store = InMemoryStore()


async def get_store() -> InMemoryStore:
    """Dependency injection for the data store."""
    return _store


# ──────────────────────────────────────────────────────────────────────
# Application lifecycle
# ──────────────────────────────────────────────────────────────────────


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Application lifecycle manager.

    Enforces the authentication safety gate on startup — the app refuses
    to serve requests when ``AUTH_DISABLED=true`` in a non-local
    environment.  Also closes the async Cosmos DB client cleanly.
    """
    enforce_auth_safety_gate()
    logger.info("Data Marketplace starting up")
    environment = os.environ.get("ENVIRONMENT", "dev")
    logger.info("startup.environment", environment=environment)
    yield
    logger.info("Data Marketplace shutting down")
    # Clean up Cosmos DB client
    global _cosmos_client
    if _cosmos_client is not None:
        await _cosmos_client.close()
        _cosmos_client = None


# ──────────────────────────────────────────────────────────────────────
# FastAPI application
# ──────────────────────────────────────────────────────────────────────

# OpenAPI docs are opt-out in non-production environments and off by
# default in production.  Set MARKETPLACE_EXPOSE_DOCS=true to re-enable
# in staging / production deployments where they are explicitly wanted.
_environment = os.environ.get("ENVIRONMENT", "dev").strip().lower()
_expose_docs = os.environ.get("MARKETPLACE_EXPOSE_DOCS", "").strip().lower() in {
    "true",
    "1",
    "yes",
}
_docs_enabled = _environment != "production" or _expose_docs

app = FastAPI(
    title="CSA-in-a-Box Data Marketplace",
    description=(
        "Self-service data product marketplace for discovery, access "
        "management, and quality monitoring across data domains."
    ),
    version="1.0.0",
    docs_url="/docs" if _docs_enabled else None,
    redoc_url="/redoc" if _docs_enabled else None,
    openapi_url="/openapi.json" if _docs_enabled else None,
    lifespan=lifespan,
)

# CORS — require an explicit, non-empty allowlist.  No wildcards, no
# silent localhost default in production.
_cors_raw = os.getenv("CORS_ALLOWED_ORIGINS", "").strip()
if not _cors_raw:
    if _environment in {"local", "dev"}:
        _cors_origins = ["http://localhost:3000"]
        logger.warning(
            "CORS_ALLOWED_ORIGINS not set — defaulting to localhost:3000 "
            "for %s environment only.",
            _environment,
        )
    else:
        msg = (
            "CORS_ALLOWED_ORIGINS must be set to an explicit origin list "
            f"(no wildcards) in {_environment!r} environment."
        )
        raise RuntimeError(msg)
else:
    _cors_origins = [o.strip() for o in _cors_raw.split(",") if o.strip()]
    if any("*" in origin for origin in _cors_origins):
        msg = (
            f"CORS_ALLOWED_ORIGINS contains a wildcard pattern: "
            f"{_cors_origins!r}.  Wildcards with allow_credentials=True "
            "let any Azure-hosted app make credentialed cross-origin "
            "requests.  Enumerate explicit hostnames instead."
        )
        raise RuntimeError(msg)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)


# ──────────────────────────────────────────────────────────────────────
# Health check
# ──────────────────────────────────────────────────────────────────────


@app.get("/health", tags=["system"])
async def health_check() -> dict[str, str]:
    """Health check endpoint for load balancer probes."""
    return {"status": "healthy", "service": "data-marketplace"}


# ──────────────────────────────────────────────────────────────────────
# Data Products endpoints
# ──────────────────────────────────────────────────────────────────────


@app.get(
    "/products",
    response_model=PaginatedResponse[DataProductSummary],
    tags=["products"],
    summary="List all data products",
)
async def list_products(
    domain: str | None = Query(default=None, description="Filter by domain name"),
    tags: str | None = Query(default=None, description="Filter by tags (comma-separated)"),
    search: str | None = Query(default=None, description="Search in name and description"),
    page: int = Query(default=1, ge=1, description="Page number"),
    per_page: int = Query(default=20, ge=1, le=100, description="Items per page"),
    store: InMemoryStore = Depends(get_store),
    _user: dict[str, Any] = Depends(_ANY_AUTHENTICATED_USER),
) -> PaginatedResponse[DataProductSummary]:
    """List all registered data products with optional filtering.

    Returns a paginated list of data product summaries including quality
    scores, tags, and freshness status.
    """
    tag_list = [t.strip() for t in tags.split(",")] if tags else None
    products, total = await store.list_products(
        domain=domain,
        tags=tag_list,
        search=search,
        page=page,
        per_page=per_page,
    )

    summaries = [DataProductSummary.from_product(p) for p in products]

    return PaginatedResponse(
        items=summaries,
        total=total,
        page=page,
        per_page=per_page,
        has_next=(page * per_page) < total,
    )


@app.get(
    "/products/{product_id}",
    response_model=DataProduct,
    tags=["products"],
    summary="Get data product details",
)
async def get_product(
    product_id: str,
    store: InMemoryStore = Depends(get_store),
    _user: dict[str, Any] = Depends(_ANY_AUTHENTICATED_USER),
) -> DataProduct:
    """Get detailed information about a specific data product.

    Returns the full product definition including schema, SLA, lineage,
    quality score, and access count.
    """
    product = await store.get_product(product_id)
    if product is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Data product not found: {product_id}",
        )
    return product


@app.post(
    "/products",
    response_model=DataProduct,
    status_code=status.HTTP_201_CREATED,
    tags=["products"],
    summary="Register a new data product",
)
async def create_product(
    body: DataProductBase,
    store: InMemoryStore = Depends(get_store),
    user: dict[str, Any] = Depends(_CONTRIBUTOR_OR_ADMIN),
) -> DataProduct:
    """Register a new data product in the marketplace.

    The product will be assigned a unique ID and an initial quality score
    of 0. Quality metrics should be pushed separately via the quality
    endpoints.
    """
    product = DataProduct(
        **body.model_dump(by_alias=True),
        id=str(uuid.uuid4()),
    )
    created = await store.create_product(product)
    logger.info(
        "Data product registered: %s/%s (id=%s) by %s",
        created.domain,
        created.name,
        created.id,
        user.get("preferred_username", user.get("sub", "unknown")),
    )
    return created


# ──────────────────────────────────────────────────────────────────────
# Access Request endpoints
# ──────────────────────────────────────────────────────────────────────


@app.post(
    "/access-requests",
    response_model=AccessRequest,
    status_code=status.HTTP_201_CREATED,
    tags=["access-requests"],
    summary="Request access to a data product",
)
async def create_access_request(
    body: AccessRequestCreate,
    store: InMemoryStore = Depends(get_store),
    _user: dict[str, Any] = Depends(_ANY_AUTHENTICATED_USER),
) -> AccessRequest:
    """Submit a new access request for a data product.

    The request is created in ``pending`` status and must be approved by
    the data product owner before access is granted.
    """
    # Verify the product exists
    product = await store.get_product(body.product_id)
    if product is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Data product not found: {body.product_id}",
        )

    access_request = AccessRequest(
        id=str(uuid.uuid4()),
        productId=body.product_id,
        requester=body.requester,
        requested_role=body.requested_role,
        justification=body.justification,
        status=AccessRequestStatus.PENDING,
        expires_at=body.expires_at,
    )

    created = await store.create_access_request(access_request)
    logger.info(
        "Access request created: %s for product %s by %s",
        created.id,
        created.product_id,
        created.requester,
    )
    return created


@app.get(
    "/access-requests/{request_id}",
    response_model=AccessRequest,
    tags=["access-requests"],
    summary="Check access request status",
)
async def get_access_request(
    request_id: str,
    store: InMemoryStore = Depends(get_store),
    _user: dict[str, Any] = Depends(_ANY_AUTHENTICATED_USER),
) -> AccessRequest:
    """Get the current status of an access request."""
    request = await store.get_access_request(request_id)
    if request is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Access request not found: {request_id}",
        )
    return request


@app.put(
    "/access-requests/{request_id}/approve",
    response_model=AccessRequest,
    tags=["access-requests"],
    summary="Approve or deny an access request",
)
async def approve_access_request(
    request_id: str,
    body: AccessRequestApproval,
    store: InMemoryStore = Depends(get_store),
    _user: dict[str, Any] = Depends(_ADMIN_ONLY),
) -> AccessRequest:
    """Approve or deny a pending access request.

    On approval, the system will automatically grant the appropriate RBAC
    role to the requester's managed identity on the data product's
    storage container.
    """
    request = await store.get_access_request(request_id)
    if request is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Access request not found: {request_id}",
        )

    if request.status != AccessRequestStatus.PENDING:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Access request is already {request.status.value}",
        )

    now = datetime.now(timezone.utc)
    request.reviewer = body.reviewer
    request.review_notes = body.notes
    request.reviewed_at = now
    request.status = AccessRequestStatus.APPROVED if body.approved else AccessRequestStatus.DENIED
    if body.expires_at:
        request.expires_at = body.expires_at

    updated = await store.update_access_request(request)

    if body.approved:
        # In production: trigger RBAC assignment via Azure SDK
        product = await store.get_product(request.product_id)
        if product:
            product.access_count += 1
            product.updated_at = now
            await store.update_product(product)

        logger.info(
            "Access request %s APPROVED by %s for product %s",
            request_id,
            body.reviewer,
            request.product_id,
        )
    else:
        logger.info(
            "Access request %s DENIED by %s: %s",
            request_id,
            body.reviewer,
            body.notes,
        )

    return updated


# ──────────────────────────────────────────────────────────────────────
# Quality Metrics endpoints
# ──────────────────────────────────────────────────────────────────────


@app.get(
    "/products/{product_id}/quality",
    response_model=QualityHistoryResponse,
    tags=["quality"],
    summary="Get quality metrics history",
)
async def get_quality_history(
    product_id: str,
    limit: int = Query(default=30, ge=1, le=365, description="Number of data points"),
    store: InMemoryStore = Depends(get_store),
    _user: dict[str, Any] = Depends(_ANY_AUTHENTICATED_USER),
) -> QualityHistoryResponse:
    """Get the quality metrics history for a data product.

    Returns up to ``limit`` most recent quality measurements and the
    current composite quality score with trend information.
    """
    product = await store.get_product(product_id)
    if product is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Data product not found: {product_id}",
        )

    metrics = await store.get_quality_history(product_id, limit=limit)

    # Determine trend from recent scores
    trend = "stable"
    if len(metrics) >= 3:
        recent_values = [m.value for m in metrics[:3]]
        older_values = [m.value for m in metrics[3:6]] if len(metrics) >= 6 else recent_values
        recent_avg = sum(recent_values) / len(recent_values)
        older_avg = sum(older_values) / len(older_values)
        if recent_avg > older_avg * 1.05:
            trend = "improving"
        elif recent_avg < older_avg * 0.95:
            trend = "declining"

    return QualityHistoryResponse(
        product_id=product_id,
        product_name=product.name,
        metrics=metrics,
        current_score=product.quality_score,
        trend=trend,
    )
