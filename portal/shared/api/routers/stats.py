"""
Platform statistics and domain overview router.

Endpoints
---------
GET    /api/v1/stats                      — platform-wide statistics
GET    /api/v1/stats/domains/{domain}     — single domain overview
GET    /api/v1/domains                    — all domain overviews (convenience alias)
"""

from __future__ import annotations

import logging
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException

from ..dependencies import (
    get_access_store,
    get_pipelines_store,
    get_products_store,
    get_runs_store,
    get_sources_store,
)
from ..models.marketplace import (
    AccessRequestStatus,
    DomainOverview,
    DomainStatus,
    PlatformStats,
)
from ..persistence_async import AsyncStoreBackend
from ..services.auth import DomainScope, get_domain_scope

logger = logging.getLogger(__name__)
router = APIRouter()

# A second router mounted at /api/v1/domains for the React-frontend alias.
# Kept here so all domain-overview logic is co-located with the stats module.
domains_router = APIRouter()


# ── Helpers ──────────────────────────────────────────────────────────────────


def _avg_quality_score(products: list[dict]) -> float:
    """Compute average quality score from data products, defaulting to 0.

    Returns a 0.0-1.0 ratio (CSA-0003). Rounded to 3 decimals so the
    0-1 scale still produces meaningful dashboard display values.
    """
    scores = [p.get("quality_score", 0) for p in products if p.get("quality_score")]
    if not scores:
        return 0.0
    return round(sum(scores) / len(scores), 3)


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
    """Derive a domain health status from its average quality score.

    ``avg_score`` is a 0.0-1.0 ratio (CSA-0003); thresholds are 0.9
    (healthy) and 0.75 (warning).
    """
    if avg_score >= 0.9:
        return DomainStatus.HEALTHY
    if avg_score >= 0.75:
        return DomainStatus.WARNING
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
        # 0.0-1.0 ratio; 3 decimals preserves dashboard precision (CSA-0003).
        avg_q = round(sum(scores) / len(scores), 3) if scores else 0.0
        overviews[domain] = DomainOverview(
            name=domain,
            source_count=source_by_domain.get(domain, 0),
            pipeline_count=pipeline_by_domain.get(domain, 0),
            data_product_count=product_by_domain.get(domain, 0),
            avg_quality_score=avg_q,
            status=_domain_status_from_quality(avg_q) if scores else DomainStatus.HEALTHY,
        )

    return overviews


def _filter_by_domain(
    items: list[dict], domain: str | None, *, key: str = "domain",
) -> list[dict]:
    """Return *items* whose ``key`` field equals *domain*, empty list on None."""
    if domain is None:
        return []
    return [i for i in items if i.get(key) == domain]


def _filter_pipelines_by_source_domain(
    pipelines: list[dict], sources: list[dict], domain: str | None,
) -> list[dict]:
    """Filter pipelines whose source belongs to *domain*."""
    if domain is None:
        return []
    domain_source_ids = {s.get("id") for s in sources if s.get("domain") == domain}
    return [p for p in pipelines if p.get("source_id") in domain_source_ids]


async def _compute_platform_stats(
    sources_store: AsyncStoreBackend,
    pipelines_store: AsyncStoreBackend,
    runs_store: AsyncStoreBackend,
    products_store: AsyncStoreBackend,
    access_store: AsyncStoreBackend,
    scope: DomainScope | None = None,
) -> PlatformStats:
    """Aggregate platform stats from async stores.

    When *scope* is a non-admin ``DomainScope``, counts and aggregates
    are filtered to the caller's domain (CSA-0024). Admins and callers
    without a scope see platform-wide totals.
    """
    sources = await sources_store.list()
    pipelines = await pipelines_store.list()
    runs = await runs_store.list()
    products = await products_store.list()
    access_requests = await access_store.list()

    # CSA-0024: non-admin callers see only their own domain's aggregates.
    if scope is not None and not scope.is_admin:
        sources = _filter_by_domain(sources, scope.user_domain)
        products = _filter_by_domain(products, scope.user_domain)
        pipelines = _filter_pipelines_by_source_domain(
            pipelines, sources, scope.user_domain,
        )
        in_scope_pipeline_ids = {p.get("id") for p in pipelines}
        runs = [r for r in runs if r.get("pipeline_id") in in_scope_pipeline_ids]
        in_scope_product_ids = {p.get("id") for p in products}
        access_requests = [
            r for r in access_requests
            if r.get("data_product_id") in in_scope_product_ids
        ]

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
    scope: DomainScope = Depends(get_domain_scope),
    sources_store: AsyncStoreBackend = Depends(get_sources_store),
    pipelines_store: AsyncStoreBackend = Depends(get_pipelines_store),
    runs_store: AsyncStoreBackend = Depends(get_runs_store),
    products_store: AsyncStoreBackend = Depends(get_products_store),
    access_store: AsyncStoreBackend = Depends(get_access_store),
) -> PlatformStats:
    """Return aggregate statistics for the dashboard.

    CSA-0024: non-admin callers see only their own domain's counts.
    Admins retain platform-wide visibility.
    """
    return await _compute_platform_stats(
        sources_store, pipelines_store, runs_store, products_store, access_store,
        scope=scope,
    )


@router.get(
    "/domains/{domain}",
    response_model=DomainOverview,
    summary="Domain overview",
)
async def get_domain_overview(
    domain: str,
    scope: DomainScope = Depends(get_domain_scope),
    sources_store: AsyncStoreBackend = Depends(get_sources_store),
    pipelines_store: AsyncStoreBackend = Depends(get_pipelines_store),
    products_store: AsyncStoreBackend = Depends(get_products_store),
) -> DomainOverview:
    """Return an overview of a single data domain.

    CSA-0024: non-admin callers may only view their own domain. Admins
    retain cross-domain visibility.
    """
    if not scope.is_admin and (not scope.user_domain or scope.user_domain != domain):
        raise HTTPException(status_code=403, detail="You do not have access to this domain.")

    sources = await sources_store.list()
    pipelines = await pipelines_store.list()
    products = await products_store.list()

    overviews = _build_domain_overviews(sources, pipelines, products)

    if domain not in overviews:
        raise HTTPException(status_code=404, detail=f"Domain '{domain}' not found.")
    return overviews[domain]


# ── /api/v1/domains (React frontend convenience alias) ───────────────────────


@domains_router.get(
    "",
    response_model=list[DomainOverview],
    summary="All domain overviews",
    tags=["Statistics"],
)
async def list_all_domains(
    scope: DomainScope = Depends(get_domain_scope),
    sources_store: AsyncStoreBackend = Depends(get_sources_store),
    pipelines_store: AsyncStoreBackend = Depends(get_pipelines_store),
    products_store: AsyncStoreBackend = Depends(get_products_store),
) -> list[dict]:
    """Return domain overviews — React frontend convenience alias.

    CSA-0024: non-admin callers see only their own domain. Admins retain
    platform-wide visibility.
    """
    sources = await sources_store.list()
    pipelines = await pipelines_store.list()
    products = await products_store.list()
    overviews = _build_domain_overviews(sources, pipelines, products)
    if not scope.is_admin:
        if not scope.user_domain or scope.user_domain not in overviews:
            return []
        return [overviews[scope.user_domain].model_dump()]
    return [d.model_dump() for d in overviews.values()]
