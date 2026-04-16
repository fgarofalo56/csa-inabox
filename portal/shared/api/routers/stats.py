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
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException

from ..models.marketplace import (
    AccessRequestStatus,
    DomainOverview,
    DomainStatus,
    PlatformStats,
)
from ..services.auth import get_current_user

logger = logging.getLogger(__name__)
router = APIRouter()


# ── Store accessors ──────────────────────────────────────────────────────────
# Import lazily from sibling routers to avoid circular-import issues at
# module level.  Each router owns its store instance.


def _get_sources() -> list[dict]:
    from .sources import _sources_store
    return _sources_store.list()


def _get_pipelines() -> list[dict]:
    from .pipelines import _pipelines_store
    return _pipelines_store.list()


def _get_pipeline_runs() -> list[dict]:
    from .pipelines import _runs_store
    return _runs_store.list()


def _get_products() -> list[dict]:
    from .marketplace import _products_store
    return _products_store.list()


def _get_access_requests() -> list[dict]:
    from .access import _access_store
    return _access_store.list()


# ── Helpers ──────────────────────────────────────────────────────────────────


def _avg_quality_score(products: list[dict]) -> float:
    """Compute average quality score from data products, defaulting to 0."""
    scores = [p.get("quality_score", 0) for p in products if p.get("quality_score")]
    if not scores:
        return 0.0
    return round(sum(scores) / len(scores), 1)


def _count_recent_runs(runs: list[dict], hours: int = 24) -> int:
    """Count pipeline runs that started within the last *hours*."""
    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    count = 0
    for run in runs:
        started = run.get("started_at")
        if not started:
            continue
        if isinstance(started, str):
            try:
                started = datetime.fromisoformat(started)
            except (ValueError, TypeError):
                continue
        # Make offset-aware if naive
        if started.tzinfo is None:
            started = started.replace(tzinfo=timezone.utc)
        if started >= cutoff:
            count += 1
    return count


def _estimate_volume_gb(sources: list[dict]) -> float:
    """Rough volume estimate based on active source count.

    In production this would query Azure Monitor / storage metrics.
    For now, use a reasonable per-source estimate.
    """
    active = [s for s in sources if s.get("status") in ("active", "provisioning")]
    if not active:
        return 0.0
    # ~100 GB per active source as a reasonable demo estimate
    return round(len(active) * 100.0, 1)


def _domain_status_from_quality(avg_score: float) -> DomainStatus:
    """Derive a domain health status from its average quality score."""
    if avg_score >= 90:
        return DomainStatus.HEALTHY
    elif avg_score >= 75:
        return DomainStatus.WARNING
    else:
        return DomainStatus.CRITICAL


def _build_domain_overviews(
    sources: list[dict],
    pipelines: list[dict],
    products: list[dict],
) -> dict[str, DomainOverview]:
    """Build per-domain overviews from actual store data."""
    # Group counts by domain
    source_by_domain: dict[str, int] = defaultdict(int)
    for s in sources:
        domain = s.get("domain", "unknown")
        source_by_domain[domain] += 1

    # Map source_id → domain so we can attribute pipelines
    source_domain: dict[str, str] = {}
    for s in sources:
        sid = s.get("id")
        if sid:
            source_domain[sid] = s.get("domain", "unknown")

    pipeline_by_domain: dict[str, int] = defaultdict(int)
    for p in pipelines:
        domain = source_domain.get(p.get("source_id", ""), "unknown")
        pipeline_by_domain[domain] += 1

    product_by_domain: dict[str, int] = defaultdict(int)
    quality_by_domain: dict[str, list[float]] = defaultdict(list)
    for dp in products:
        domain = dp.get("domain", "unknown")
        product_by_domain[domain] += 1
        qs = dp.get("quality_score")
        if qs:
            quality_by_domain[domain].append(qs)

    # Collect all known domains across all stores
    all_domains = set(source_by_domain) | set(pipeline_by_domain) | set(product_by_domain)

    overviews: dict[str, DomainOverview] = {}
    for domain in sorted(all_domains):
        scores = quality_by_domain.get(domain, [])
        avg_q = round(sum(scores) / len(scores), 1) if scores else 0.0
        overviews[domain] = DomainOverview(
            name=domain,
            source_count=source_by_domain.get(domain, 0),
            pipeline_count=pipeline_by_domain.get(domain, 0),
            data_product_count=product_by_domain.get(domain, 0),
            avg_quality_score=avg_q,
            status=_domain_status_from_quality(avg_q) if scores else DomainStatus.HEALTHY,
        )

    return overviews


def _compute_platform_stats() -> PlatformStats:
    """Aggregate platform stats from actual store data."""
    sources = _get_sources()
    pipelines = _get_pipelines()
    runs = _get_pipeline_runs()
    products = _get_products()
    access_requests = _get_access_requests()

    pending = [r for r in access_requests if r.get("status") == AccessRequestStatus.PENDING.value]

    return PlatformStats(
        registered_sources=len(sources),
        active_pipelines=len(pipelines),
        data_products=len(products),
        pending_access_requests=len(pending),
        total_data_volume_gb=_estimate_volume_gb(sources),
        last_24h_pipeline_runs=_count_recent_runs(runs),
        avg_quality_score=_avg_quality_score(products),
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
    sources = _get_sources()
    pipelines = _get_pipelines()
    products = _get_products()

    overviews = _build_domain_overviews(sources, pipelines, products)

    if domain not in overviews:
        raise HTTPException(status_code=404, detail=f"Domain '{domain}' not found.")
    return overviews[domain]
