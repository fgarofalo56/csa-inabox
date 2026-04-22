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

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel

from csa_platform.common.audit import audit_event_from_request, audit_logger

from ..dependencies import get_access_store, get_products_store
from ..models.marketplace import (
    AccessRequest,
    AccessRequestCreate,
    AccessRequestStatus,
)
from ..models.source import ClassificationLevel
from ..observability.rate_limit import build_rate_limiter, get_route_limit
from ..persistence_async import AsyncStoreBackend
from ..services.auth import DomainScope, get_current_user, get_domain_scope, require_role

logger = logging.getLogger(__name__)
router = APIRouter()

# Per-principal sliding-window rate limiter (CSA-0030).
_limiter = build_rate_limiter()


# ── Request Models ─────────────────────────────────────────────────────────


class ReviewBody(BaseModel):
    """Optional body for approve / deny review actions."""

    notes: str | None = None


# ── Classification-aware duration caps (CSA-0017) ──────────────────────────
# Maps a product's classification level → maximum allowed duration_days for
# any access request targeting it.  Unlisted classifications (e.g. CUI,
# FOUO) default to the most restrictive cap (30d) fail-closed.
_DURATION_CAPS_BY_CLASSIFICATION: dict[ClassificationLevel, int] = {
    ClassificationLevel.PUBLIC: 365,
    ClassificationLevel.INTERNAL: 365,
    ClassificationLevel.CONFIDENTIAL: 90,
    ClassificationLevel.RESTRICTED: 30,
}

# Classifications that require elevated workflow review_notes on submit.
_ELEVATED_REVIEW_CLASSIFICATIONS: set[ClassificationLevel] = {
    ClassificationLevel.RESTRICTED,
    ClassificationLevel.CUI,
    ClassificationLevel.FOUO,
}


def _user_identifier(user: dict) -> str:
    """Best-effort stable identifier for the authenticated user."""
    return (
        user.get("email")
        or user.get("preferred_username")
        or user.get("oid")
        or user.get("sub")
        or "unknown"
    )


async def seed_demo_requests() -> None:
    """Populate realistic demo access requests on first access (async).

    Called once at application startup from the lifespan handler.
    """
    async_store = get_access_store()
    if await async_store.count() > 0:
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
        await async_store.add(ar.model_dump())


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
    store: AsyncStoreBackend = Depends(get_access_store),
) -> list[AccessRequest]:
    """Return access requests with optional filters."""
    results = [AccessRequest.model_validate(item) for item in await store.load()]

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
@_limiter.limit(get_route_limit("access_post", write=True))
async def create_access_request(
    request: Request,
    payload: AccessRequestCreate,
    user: dict = Depends(get_current_user),
    store: AsyncStoreBackend = Depends(get_access_store),
    products_store: AsyncStoreBackend = Depends(get_products_store),
) -> AccessRequest:
    """Submit a new access request for a data product.

    The requester email is extracted from the authenticated user's JWT claims.

    CSA-0017 hardening:
    - Rejects unknown ``data_product_id`` with 404.
    - Enforces classification-aware duration caps (422 on overflow).
    - Tags requests against RESTRICTED/CUI/FOUO products with an elevated
      review note so downstream reviewers know to escalate.
    """
    # Validate product exists (CSA-0017)
    stored_product = await products_store.get(payload.data_product_id)
    if not stored_product:
        raise HTTPException(
            status_code=404,
            detail=f"Data product '{payload.data_product_id}' not found.",
        )

    # Resolve classification; tolerate legacy/unknown values fail-closed.
    raw_classification = stored_product.get("classification") or "internal"
    try:
        classification = ClassificationLevel(raw_classification)
    except ValueError:
        classification = ClassificationLevel.RESTRICTED

    # Enforce classification-aware duration cap (CSA-0017).  Classifications
    # that are not explicitly mapped (CUI, FOUO) inherit the RESTRICTED cap
    # of 30 days fail-closed.
    cap_days = _DURATION_CAPS_BY_CLASSIFICATION.get(
        classification,
        _DURATION_CAPS_BY_CLASSIFICATION[ClassificationLevel.RESTRICTED],
    )
    if payload.duration_days > cap_days:
        raise HTTPException(
            status_code=422,
            detail=(
                f"duration_days={payload.duration_days} exceeds the "
                f"{cap_days}-day cap for '{classification.value}' "
                f"classification."
            ),
        )

    request_id = str(uuid.uuid4())
    requester = user.get("email", user.get("preferred_username", "unknown@contoso.com"))

    # Elevated-workflow hint for sensitive classifications (CSA-0017).
    review_notes: str | None = None
    if classification in _ELEVATED_REVIEW_CLASSIFICATIONS:
        review_notes = (
            f"{classification.value.upper()} data product — "
            "requires manager approval"
        )

    access_request = AccessRequest(
        id=request_id,
        requester_email=requester,
        data_product_id=payload.data_product_id,
        justification=payload.justification,
        access_level=payload.access_level,
        duration_days=payload.duration_days,
        status=AccessRequestStatus.PENDING,
        requested_at=datetime.now(timezone.utc),
        review_notes=review_notes,
    )

    # Persist to JSON store
    await store.add(access_request.model_dump())

    # Tamper-evident audit sink (CSA-0016).  Separate namespace from the
    # operational logger; chain-hashed so offline verification can prove
    # events have not been deleted or modified.
    audit_logger.emit(
        audit_event_from_request(
            request=request,
            user=user,
            action="access_request.create",
            resource={
                "type": "access_request",
                "id": request_id,
                "domain": stored_product.get("domain"),
                "classification": classification.value,
                "product_id": payload.data_product_id,
            },
            outcome="success",
            after={
                "status": AccessRequestStatus.PENDING.value,
                "duration_days": payload.duration_days,
                "elevated": classification in _ELEVATED_REVIEW_CLASSIFICATIONS,
            },
        ),
    )
    return access_request


async def _enforce_review_authorization(
    *,
    user: dict,
    scope: DomainScope,
    access_request: AccessRequest,
    action: str,
    products_store: AsyncStoreBackend,
) -> dict:
    """Authorize approve/deny on an access request (CSA-0002).

    Rules:
      * Admins may act cross-domain.
      * Non-admin Contributors must share the product's domain.
      * Self-approval/denial is forbidden regardless of role.

    Returns the resolved data product dict for downstream use.
    Raises HTTPException(403) on failure.
    """
    stored_product = await products_store.get(access_request.data_product_id)
    if not stored_product:
        # The product the request points to has vanished — fail closed.
        logger.warning(
            "Review blocked: product missing for access request",
            extra={
                "actor_sub": user.get("sub") or user.get("oid"),
                "action": action,
                "resource_id": access_request.id,
                "product_id": access_request.data_product_id,
                "outcome": "denied",
                "reason": "product_not_found",
            },
        )
        raise HTTPException(
            status_code=404,
            detail=(
                f"Data product '{access_request.data_product_id}' referenced "
                "by this request no longer exists."
            ),
        )

    target_domain = stored_product.get("domain")

    # Self-approval / self-denial is forbidden regardless of role (SoD).
    caller_identifiers = {
        user.get("email"),
        user.get("preferred_username"),
        user.get("sub"),
        user.get("oid"),
    }
    caller_identifiers.discard(None)
    caller_identifiers.discard("")
    if access_request.requester_email in caller_identifiers:
        logger.warning(
            "Self-review blocked on access request",
            extra={
                "actor_sub": user.get("sub") or user.get("oid"),
                "actor": _user_identifier(user),
                "action": action,
                "resource_id": access_request.id,
                "product_id": access_request.data_product_id,
                "target_domain": target_domain,
                "caller_domain": scope.user_domain,
                "outcome": "denied",
                "reason": "self_review_forbidden",
            },
        )
        raise HTTPException(
            status_code=403,
            detail=(
                "Requesters may not approve or deny their own access "
                "requests (segregation of duties)."
            ),
        )

    # Non-admins must share the product's domain.
    if not scope.is_admin and (
        not scope.user_domain or scope.user_domain != target_domain
    ):
        logger.warning(
            "Cross-domain review blocked on access request",
            extra={
                "actor_sub": user.get("sub") or user.get("oid"),
                "actor": _user_identifier(user),
                "action": action,
                "resource_id": access_request.id,
                "product_id": access_request.data_product_id,
                "target_domain": target_domain,
                "caller_domain": scope.user_domain,
                "outcome": "denied",
                "reason": "cross_domain_review_forbidden",
            },
        )
        raise HTTPException(
            status_code=403,
            detail=(
                "You may only review access requests for data products "
                "in your own domain."
            ),
        )

    return stored_product


@router.post(
    "/{request_id}/approve",
    response_model=AccessRequest,
    summary="Approve access request",
)
@_limiter.limit(get_route_limit("access_approve", write=True))
async def approve_access_request(
    request: Request,
    request_id: str,
    body: ReviewBody | None = None,
    user: dict = Depends(require_role("Contributor", "Admin")),
    scope: DomainScope = Depends(get_domain_scope),
    store: AsyncStoreBackend = Depends(get_access_store),
    products_store: AsyncStoreBackend = Depends(get_products_store),
) -> AccessRequest:
    """Approve a pending access request and grant RBAC permissions.

    CSA-0002 hardening: non-admin callers must share the product's domain,
    and nobody may approve their own request regardless of role.

    In production, would apply Azure RBAC role assignment using:

        from azure.mgmt.authorization import AuthorizationManagementClient
        client.role_assignments.create(scope, assignment_name, parameters)
    """
    stored_req = await store.get(request_id)
    if not stored_req:
        raise HTTPException(status_code=404, detail=f"Request '{request_id}' not found.")

    req = AccessRequest.model_validate(stored_req)
    if req.status != AccessRequestStatus.PENDING:
        raise HTTPException(
            status_code=400,
            detail=f"Request is '{req.status.value}', only pending requests can be approved.",
        )

    product = await _enforce_review_authorization(
        user=user,
        scope=scope,
        access_request=req,
        action="access_request.approve",
        products_store=products_store,
    )

    now = datetime.now(timezone.utc)
    req.status = AccessRequestStatus.APPROVED
    req.reviewed_at = now
    req.reviewed_by = user.get("email", user.get("preferred_username", "admin"))
    req.review_notes = body.notes if body else None
    req.expires_at = now + timedelta(days=req.duration_days)

    # Update in store
    await store.update(request_id, req.model_dump())

    # Tamper-evident audit sink (CSA-0016).
    audit_logger.emit(
        audit_event_from_request(
            request=request,
            user=user,
            action="access_request.approve",
            resource={
                "type": "access_request",
                "id": request_id,
                "domain": product.get("domain"),
                "product_id": req.data_product_id,
            },
            outcome="success",
            before={"status": AccessRequestStatus.PENDING.value},
            after={
                "status": AccessRequestStatus.APPROVED.value,
                "reviewer": req.reviewed_by,
                "expires_at": req.expires_at.isoformat()
                if req.expires_at
                else None,
            },
        ),
    )
    return req


@router.post(
    "/{request_id}/deny",
    response_model=AccessRequest,
    summary="Deny access request",
)
@_limiter.limit(get_route_limit("access_deny", write=True))
async def deny_access_request(
    request: Request,
    request_id: str,
    body: ReviewBody | None = None,
    user: dict = Depends(require_role("Contributor", "Admin")),
    scope: DomainScope = Depends(get_domain_scope),
    store: AsyncStoreBackend = Depends(get_access_store),
    products_store: AsyncStoreBackend = Depends(get_products_store),
) -> AccessRequest:
    """Deny a pending access request.

    CSA-0002 hardening: non-admin callers must share the product's domain,
    and nobody may deny their own request regardless of role.
    """
    stored_req = await store.get(request_id)
    if not stored_req:
        raise HTTPException(status_code=404, detail=f"Request '{request_id}' not found.")

    req = AccessRequest.model_validate(stored_req)
    if req.status != AccessRequestStatus.PENDING:
        raise HTTPException(
            status_code=400,
            detail=f"Request is '{req.status.value}', only pending requests can be denied.",
        )

    product = await _enforce_review_authorization(
        user=user,
        scope=scope,
        access_request=req,
        action="access_request.deny",
        products_store=products_store,
    )

    req.status = AccessRequestStatus.DENIED
    req.reviewed_at = datetime.now(timezone.utc)
    req.reviewed_by = user.get("email", user.get("preferred_username", "admin"))
    req.review_notes = body.notes if body else None

    # Update in store
    await store.update(request_id, req.model_dump())

    # Tamper-evident audit sink (CSA-0016).  A deny is a negative outcome
    # for the requester but a successful review action by the reviewer —
    # we capture it as outcome=success with action=access_request.deny so
    # the chain reflects the reviewer's intent.
    audit_logger.emit(
        audit_event_from_request(
            request=request,
            user=user,
            action="access_request.deny",
            resource={
                "type": "access_request",
                "id": request_id,
                "domain": product.get("domain"),
                "product_id": req.data_product_id,
            },
            outcome="success",
            before={"status": AccessRequestStatus.PENDING.value},
            after={
                "status": AccessRequestStatus.DENIED.value,
                "reviewer": req.reviewed_by,
            },
            reason=req.review_notes,
        ),
    )
    return req
