"""
Platform statistics and domain overview router.

Endpoints
---------
GET    /api/v1/stats                      — platform-wide statistics
GET    /api/v1/stats/domains/{domain}     — single domain overview

The React frontend also calls:
GET    /api/v1/domains                    — all domain overviews (mounted on main app)
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

from ..models.marketplace import DomainOverview, DomainStatus, PlatformStats
from ..services.auth import get_current_user

logger = logging.getLogger(__name__)
router = APIRouter()


# ── Demo Data ────────────────────────────────────────────────────────────────
# TODO: Replace with real queries against the metadata database / Azure
# Monitor metrics in production.

_DEMO_DOMAINS: dict[str, DomainOverview] = {
    "human-resources": DomainOverview(
        name="human-resources",
        source_count=3,
        pipeline_count=4,
        data_product_count=2,
        avg_quality_score=94.5,
        status=DomainStatus.HEALTHY,
    ),
    "manufacturing": DomainOverview(
        name="manufacturing",
        source_count=8,
        pipeline_count=12,
        data_product_count=5,
        avg_quality_score=91.2,
        status=DomainStatus.HEALTHY,
    ),
    "finance": DomainOverview(
        name="finance",
        source_count=5,
        pipeline_count=6,
        data_product_count=3,
        avg_quality_score=98.1,
        status=DomainStatus.HEALTHY,
    ),
    "marketing": DomainOverview(
        name="marketing",
        source_count=4,
        pipeline_count=5,
        data_product_count=2,
        avg_quality_score=87.3,
        status=DomainStatus.WARNING,
    ),
    "supply-chain": DomainOverview(
        name="supply-chain",
        source_count=6,
        pipeline_count=8,
        data_product_count=4,
        avg_quality_score=92.8,
        status=DomainStatus.HEALTHY,
    ),
}


def _compute_platform_stats() -> PlatformStats:
    """Aggregate platform stats from domain data."""
    domains = list(_DEMO_DOMAINS.values())
    return PlatformStats(
        registered_sources=sum(d.source_count for d in domains),
        active_pipelines=sum(d.pipeline_count for d in domains),
        data_products=sum(d.data_product_count for d in domains),
        pending_access_requests=2,  # demo value
        total_data_volume_gb=1_247.6,
        last_24h_pipeline_runs=35,
        avg_quality_score=round(
            sum(d.avg_quality_score for d in domains) / len(domains) if domains else 0,
            1,
        ),
    )


# ── Endpoints ────────────────────────────────────────────────────────────────


@router.get(
    "",
    response_model=PlatformStats,
    summary="Platform statistics",
)
async def get_stats(
    _user: dict = Depends(get_current_user),
) -> PlatformStats:
    """Return platform-wide aggregate statistics for the dashboard."""
    return _compute_platform_stats()


@router.get(
    "/domains/{domain}",
    response_model=DomainOverview,
    summary="Domain overview",
)
async def get_domain_overview(
    domain: str,
    _user: dict = Depends(get_current_user),
) -> DomainOverview:
    """Return an overview of a single data domain."""
    if domain not in _DEMO_DOMAINS:
        raise HTTPException(status_code=404, detail=f"Domain '{domain}' not found.")
    return _DEMO_DOMAINS[domain]
