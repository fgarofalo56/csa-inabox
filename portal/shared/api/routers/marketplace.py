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

Thin HTTP layer — all business logic lives in
:class:`~portal.shared.api.services.marketplace_service.MarketplaceService`.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status

from ..dependencies import get_access_requests_store, get_products_store, get_quality_store
from ..models.marketplace import (
    AccessRequest,
    AccessRequestCreate,
    AccessRequestStatus,
    DataProduct,
    DataProductCreate,
    QualityMetric,
)
from ..persistence_async import AsyncStoreBackend
from ..services.auth import DomainScope, get_current_user, get_domain_scope
from ..services.marketplace_service import MarketplaceService

router = APIRouter()


def _build_service(
    products: AsyncStoreBackend,
    quality: AsyncStoreBackend,
    access: AsyncStoreBackend,
) -> MarketplaceService:
    return MarketplaceService(products, quality, access)


async def seed_demo_products() -> None:
    """Populate realistic demo data products on first access (async).

    Called once at application startup from the lifespan handler.
    """
    svc = MarketplaceService(get_products_store(), get_quality_store(), get_access_requests_store())
    await svc.seed_demo_products()


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
    quality_store: AsyncStoreBackend = Depends(get_quality_store),
    access_store: AsyncStoreBackend = Depends(get_access_requests_store),
) -> list[DataProduct]:
    """Browse the data marketplace with optional filters."""
    svc = _build_service(store, quality_store, access_store)
    return await svc.list_products(
        domain=domain,
        min_quality=min_quality,
        search=search,
        limit=limit,
        offset=offset,
        scope_domain=scope.user_domain,
        is_admin=scope.is_admin,
    )


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
    svc = _build_service(store, get_quality_store(), get_access_requests_store())
    product = await svc.get_product(product_id)
    if not product:
        raise HTTPException(status_code=404, detail=f"Product '{product_id}' not found.")

    # Domain scoping: non-admin users can only access their domain's products.
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
    # Check product exists and enforce domain scoping
    svc = _build_service(store, quality_store, get_access_requests_store())
    product = await svc.get_product(product_id)
    if not product:
        raise HTTPException(status_code=404, detail=f"Product '{product_id}' not found.")

    if not scope.is_admin and (not scope.user_domain or product.domain != scope.user_domain):
        raise HTTPException(status_code=403, detail="You do not have access to this product.")

    history = await svc.get_quality_history(product_id, days=days)
    return history if history is not None else []


@router.get(
    "/domains",
    summary="List domains",
)
async def list_domains(
    scope: DomainScope = Depends(get_domain_scope),
    store: AsyncStoreBackend = Depends(get_products_store),
) -> list[dict]:
    """Return data domains with their product counts.

    CSA-0024: non-admin callers see only their own domain.
    """
    svc = _build_service(store, get_quality_store(), get_access_requests_store())
    return await svc.get_domain_overview(
        scope_domain=scope.user_domain,
        is_admin=scope.is_admin,
    )


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
    """
    svc = _build_service(store, get_quality_store(), get_access_requests_store())
    return await svc.get_platform_stats(
        scope_domain=scope.user_domain,
        is_admin=scope.is_admin,
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
    if not scope.is_admin and (not scope.user_domain or product_data.domain != scope.user_domain):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="You do not have access to this domain.",
        )

    svc = _build_service(store, get_quality_store(), get_access_requests_store())
    try:
        return await svc.create_product(product_data)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))


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
    svc = _build_service(store, get_quality_store(), get_access_requests_store())

    # Check product exists for domain scoping
    product = await svc.get_product(product_id)
    if not product:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Product '{product_id}' not found.")

    if not scope.is_admin and (not scope.user_domain or product.domain != scope.user_domain):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not have access to this domain.")

    try:
        updated = await svc.update_product(product_id, updates)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    if not updated:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Product '{product_id}' not found.")
    return updated


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
    roles = user.get("roles", [])
    if "Admin" not in roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin role required for this operation.",
        )

    svc = _build_service(store, get_quality_store(), get_access_requests_store())
    if not await svc.delete_product(product_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Product '{product_id}' not found.")


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
    svc = _build_service(store, quality_store, get_access_requests_store())

    # Check product exists for domain scoping
    product = await svc.get_product(product_id)
    if not product:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Product '{product_id}' not found.")

    if not scope.is_admin and (not scope.user_domain or product.domain != scope.user_domain):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You do not have access to this domain.")

    result = await svc.trigger_quality_assessment(product_id)
    if not result:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Product '{product_id}' not found.")
    return result


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
    requester_email = user.get("email", user.get("sub", "unknown@example.com"))
    svc = _build_service(products_store, get_quality_store(), store)
    result = await svc.create_access_request(request_data, requester_email)
    if not result:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Data product '{request_data.data_product_id}' not found.",
        )
    return result


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
    roles = user.get("roles", [])
    is_admin = "Admin" in roles
    requester_email = None
    if not is_admin:
        requester_email = user.get("email", user.get("sub", "unknown@example.com"))

    svc = _build_service(get_products_store(), get_quality_store(), store)
    return await svc.list_access_requests(
        status_filter=status_filter,
        product_id=product_id,
        requester_email=requester_email,
        limit=limit,
        offset=offset,
    )


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
    svc = _build_service(get_products_store(), get_quality_store(), store)
    access_request = await svc.get_access_request(request_id)
    if not access_request:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Access request '{request_id}' not found.")

    roles = user.get("roles", [])
    is_admin = "Admin" in roles
    user_email = user.get("email", user.get("sub", "unknown@example.com"))

    if not is_admin and access_request.requester_email != user_email:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="You can only view your own access requests.")

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
    svc = _build_service(products_store, get_quality_store(), store)

    # Check request exists
    access_request = await svc.get_access_request(request_id)
    if not access_request:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Access request '{request_id}' not found.")

    # Check product exists and verify ownership
    product = await svc.get_product(access_request.data_product_id)
    if not product:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Data product '{access_request.data_product_id}' not found.",
        )

    roles = user.get("roles", [])
    is_admin = "Admin" in roles
    user_email = user.get("email", user.get("sub", "unknown@example.com"))

    if not is_admin and product.owner.email != user_email:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the product owner or admin can approve access requests.",
        )

    try:
        result = await svc.approve_access_request(request_id, user_email)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    if not result:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Access request '{request_id}' not found.")
    return result


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
    svc = _build_service(products_store, get_quality_store(), store)

    # Check request exists
    access_request = await svc.get_access_request(request_id)
    if not access_request:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Access request '{request_id}' not found.")

    # Check product exists and verify ownership
    product = await svc.get_product(access_request.data_product_id)
    if not product:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Data product '{access_request.data_product_id}' not found.",
        )

    roles = user.get("roles", [])
    is_admin = "Admin" in roles
    user_email = user.get("email", user.get("sub", "unknown@example.com"))

    if not is_admin and product.owner.email != user_email:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the product owner or admin can deny access requests.",
        )

    try:
        result = await svc.deny_access_request(request_id, user_email, review_notes)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    if not result:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=f"Access request '{request_id}' not found.")
    return result
