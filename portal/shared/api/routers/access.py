"""
Access request management router.

Endpoints
---------
GET    /api/v1/access             — list access requests
POST   /api/v1/access             — create access request
POST   /api/v1/access/{id}/approve — approve request
POST   /api/v1/access/{id}/deny    — deny request
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from ..models.marketplace import (
    AccessRequest,
    AccessRequestCreate,
    AccessRequestStatus,
)
from ..persistence import SqliteStore
from ..services.auth import get_current_user, require_role

logger = logging.getLogger(__name__)
router = APIRouter()


# ── Request Models ─────────────────────────────────────────────────────────


class ReviewBody(BaseModel):
    """Optional body for approve / deny review actions."""

    notes: str | None = None

# ── SQLite persistence ──────────────────────────────────────────────────────
_access_store = SqliteStore("access_requests.json")


def seed_demo_requests() -> None:
    """Populate realistic demo access requests on first access.

    Called once at application startup from the lifespan handler.
    """
    if _access_store.count() > 0:
        return

    now = datetime.now(timezone.utc)
    demos = [
        AccessRequest(
            id="ar-001",
            requester_email="dev.team@contoso.com",
            data_product_id="dp-001",
            justification="Need employee data for headcount dashboard.",
            access_level="read",
            duration_days=90,
            status=AccessRequestStatus.APPROVED,
            requested_at=now - timedelta(days=30),
            reviewed_at=now - timedelta(days=29),
            reviewed_by="jane.smith@contoso.com",
            review_notes="Approved for read-only analytics.",
            expires_at=now + timedelta(days=60),
        ),
        AccessRequest(
            id="ar-002",
            requester_email="ml.team@contoso.com",
            data_product_id="dp-004",
            justification="Training customer churn prediction model.",
            access_level="read",
            duration_days=180,
            status=AccessRequestStatus.PENDING,
            requested_at=now - timedelta(days=2),
        ),
        AccessRequest(
            id="ar-003",
            requester_email="finance.analyst@contoso.com",
            data_product_id="dp-003",
            justification="Quarterly audit report generation.",
            access_level="read_write",
            duration_days=30,
            status=AccessRequestStatus.PENDING,
            requested_at=now - timedelta(hours=6),
        ),
        AccessRequest(
            id="ar-004",
            requester_email="extern.contractor@partner.com",
            data_product_id="dp-002",
            justification="Sensor data analysis for maintenance optimization.",
            access_level="read",
            duration_days=60,
            status=AccessRequestStatus.DENIED,
            requested_at=now - timedelta(days=10),
            reviewed_at=now - timedelta(days=9),
            reviewed_by="bob.chen@contoso.com",
            review_notes="External contractors require VPN + NDA first.",
        ),
    ]
    for ar in demos:
        _access_store.add(ar.model_dump())


# ── Endpoints ────────────────────────────────────────────────────────────────


@router.get(
    "",
    response_model=list[AccessRequest],
    summary="List access requests",
)
async def list_access_requests(
    status_filter: AccessRequestStatus | None = Query(None, alias="status"),
    data_product_id: str | None = None,
    limit: int = Query(50, ge=1, le=200),
    _user: dict = Depends(get_current_user),
) -> list[AccessRequest]:
    """Return access requests with optional filters."""
    results = [AccessRequest.model_validate(item) for item in _access_store.load()]

    # Domain scoping: non-admin users only see their own requests
    user_roles = _user.get("roles", [])
    if "Admin" not in user_roles:
        user_email = _user.get("email") or _user.get("preferred_username", "")
        if user_email:
            results = [r for r in results if r.requester_email == user_email]

    if status_filter:
        results = [r for r in results if r.status == status_filter]
    if data_product_id:
        results = [r for r in results if r.data_product_id == data_product_id]

    # Most recent first
    results.sort(key=lambda r: r.requested_at, reverse=True)
    return results[:limit]


@router.post(
    "",
    response_model=AccessRequest,
    status_code=status.HTTP_201_CREATED,
    summary="Create access request",
)
async def create_access_request(
    payload: AccessRequestCreate,
    user: dict = Depends(get_current_user),
) -> AccessRequest:
    """Submit a new access request for a data product.

    The requester email is extracted from the authenticated user's JWT claims.
    """
    request_id = str(uuid.uuid4())
    access_request = AccessRequest(
        id=request_id,
        requester_email=user.get("email", user.get("preferred_username", "unknown@contoso.com")),
        data_product_id=payload.data_product_id,
        justification=payload.justification,
        access_level=payload.access_level,
        duration_days=payload.duration_days,
        status=AccessRequestStatus.PENDING,
        requested_at=datetime.now(timezone.utc),
    )

    # Persist to JSON store
    _access_store.add(access_request.model_dump())

    # In production: Send notification to the data product owner for approval
    logger.info(
        "Access request created",
        extra={
            "request_id": request_id,
            "product_id": payload.data_product_id,
            "requester": access_request.requester_email,
        },
    )
    return access_request


@router.post(
    "/{request_id}/approve",
    response_model=AccessRequest,
    summary="Approve access request",
)
async def approve_access_request(
    request_id: str,
    body: ReviewBody | None = None,
    user: dict = Depends(require_role("Contributor", "Admin")),
) -> AccessRequest:
    """Approve a pending access request and grant RBAC permissions.

    In production, would apply Azure RBAC role assignment using:

        from azure.mgmt.authorization import AuthorizationManagementClient
        client.role_assignments.create(scope, assignment_name, parameters)
    """
    stored_req = _access_store.get(request_id)
    if not stored_req:
        raise HTTPException(status_code=404, detail=f"Request '{request_id}' not found.")

    req = AccessRequest.model_validate(stored_req)
    if req.status != AccessRequestStatus.PENDING:
        raise HTTPException(
            status_code=400,
            detail=f"Request is '{req.status.value}', only pending requests can be approved.",
        )

    now = datetime.now(timezone.utc)
    req.status = AccessRequestStatus.APPROVED
    req.reviewed_at = now
    req.reviewed_by = user.get("email", user.get("preferred_username", "admin"))
    req.review_notes = body.notes if body else None
    req.expires_at = now + timedelta(days=req.duration_days)

    # Update in store
    _access_store.update(request_id, req.model_dump())

    logger.info("Access request approved", extra={"request_id": request_id})
    return req


@router.post(
    "/{request_id}/deny",
    response_model=AccessRequest,
    summary="Deny access request",
)
async def deny_access_request(
    request_id: str,
    body: ReviewBody | None = None,
    user: dict = Depends(require_role("Contributor", "Admin")),
) -> AccessRequest:
    """Deny a pending access request."""
    stored_req = _access_store.get(request_id)
    if not stored_req:
        raise HTTPException(status_code=404, detail=f"Request '{request_id}' not found.")

    req = AccessRequest.model_validate(stored_req)
    if req.status != AccessRequestStatus.PENDING:
        raise HTTPException(
            status_code=400,
            detail=f"Request is '{req.status.value}', only pending requests can be denied.",
        )

    req.status = AccessRequestStatus.DENIED
    req.reviewed_at = datetime.now(timezone.utc)
    req.reviewed_by = user.get("email", user.get("preferred_username", "admin"))
    req.review_notes = body.notes if body else None

    # Update in store
    _access_store.update(request_id, req.model_dump())

    logger.info("Access request denied", extra={"request_id": request_id})
    return req
