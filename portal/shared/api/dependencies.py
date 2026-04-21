"""
FastAPI dependency-injection providers for the portal routers.

The async :class:`~portal.shared.api.persistence_async.AsyncStoreBackend`
instances are constructed once at module import and exposed to routes
via :func:`fastapi.Depends`.  This keeps the routers free of module-level
singletons and lets tests swap the store implementations with a single
:attr:`app.dependency_overrides` entry per store.

All store instances lazily initialise their underlying driver
(aiosqlite connection or SQLAlchemy AsyncEngine) on first use, so
importing this module is side-effect free aside from reading
:data:`portal.shared.api.config.settings`.

See ADR-0016 for the full async refactor rationale.
"""

from __future__ import annotations

from .config import settings
from .persistence_async import AsyncStoreBackend, build_async_store_backend

# ── Singletons ──────────────────────────────────────────────────────────────
# One async store per logical table.  The sync stores (in
# ``persistence.py`` / ``persistence_postgres.py``) remain in place as a
# deprecated compat layer — see ``persistence_factory.build_store_backend``.

_sources_store: AsyncStoreBackend = build_async_store_backend(
    "sources.json", settings,
)
_pipelines_store: AsyncStoreBackend = build_async_store_backend(
    "pipelines.json", settings,
)
_runs_store: AsyncStoreBackend = build_async_store_backend(
    "pipeline_runs.json", settings,
)
_access_store: AsyncStoreBackend = build_async_store_backend(
    "access_requests.json", settings,
)
_products_store: AsyncStoreBackend = build_async_store_backend(
    "marketplace_products.json", settings,
)
_quality_store: AsyncStoreBackend = build_async_store_backend(
    "marketplace_quality.json", settings,
)


# ── Providers ───────────────────────────────────────────────────────────────


def get_sources_store() -> AsyncStoreBackend:
    """Return the async store for data source registrations."""
    return _sources_store


def get_pipelines_store() -> AsyncStoreBackend:
    """Return the async store for pipeline records."""
    return _pipelines_store


def get_runs_store() -> AsyncStoreBackend:
    """Return the async store for pipeline run history."""
    return _runs_store


def get_access_store() -> AsyncStoreBackend:
    """Return the async store for access requests."""
    return _access_store


def get_products_store() -> AsyncStoreBackend:
    """Return the async store for marketplace data products."""
    return _products_store


def get_quality_store() -> AsyncStoreBackend:
    """Return the async store for marketplace quality history."""
    return _quality_store


def all_stores() -> list[AsyncStoreBackend]:
    """Return every registered async store (used by lifespan close)."""
    return [
        _sources_store,
        _pipelines_store,
        _runs_store,
        _access_store,
        _products_store,
        _quality_store,
    ]


__all__ = [
    "all_stores",
    "get_access_store",
    "get_pipelines_store",
    "get_products_store",
    "get_quality_store",
    "get_runs_store",
    "get_sources_store",
]
