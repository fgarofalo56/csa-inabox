"""
StoreBackend factory (CSA-0046).

Selects the concrete persistence backend at runtime based on the
``DATABASE_URL`` setting:

* Empty / unset / ``sqlite://...``  → :class:`SqliteStore` (default,
  preserves existing local/dev behaviour).
* ``postgresql://...`` or ``postgresql+<driver>://...``
  → :class:`PostgresStore` (Azure Database for PostgreSQL Flexible
  Server with optional managed-identity auth).

The factory fails closed on an unknown URL scheme — a misspelled or
unsupported backend raises ``ValueError`` at startup rather than
silently falling through to SQLite.

Usage::

    from portal.shared.api.config import settings
    from portal.shared.api.persistence_factory import build_store_backend

    store = build_store_backend("sources.json", settings)
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from .persistence import SqliteStore, StoreBackend

if TYPE_CHECKING:  # pragma: no cover — type-only import
    from .config import Settings

logger = logging.getLogger(__name__)


def _is_sqlite_url(url: str) -> bool:
    """Return True when *url* is a SQLite URL (or empty → default SQLite)."""
    if not url:
        return True
    return url.startswith("sqlite:")


def _is_postgres_url(url: str) -> bool:
    """Return True when *url* targets PostgreSQL."""
    return url.startswith(("postgresql://", "postgresql+"))


def build_store_backend(
    filename: str,
    settings: Settings,
) -> StoreBackend:
    """Construct a :class:`StoreBackend` instance for *filename*.

    The returned object satisfies the :class:`StoreBackend` Protocol so
    callers can treat all backends uniformly.

    Parameters
    ----------
    filename:
        Logical name of the store (``"sources.json"`` by convention).
    settings:
        Application :class:`~portal.shared.api.config.Settings` instance
        containing the selected ``DATABASE_URL`` and Postgres-specific
        options.

    Raises
    ------
    ValueError
        If ``settings.DATABASE_URL`` is set to a scheme other than
        SQLite or PostgreSQL.
    """
    url = (settings.DATABASE_URL or "").strip()

    if _is_sqlite_url(url):
        # Preserve the legacy behaviour: SQLite lives under DATA_DIR
        # regardless of the URL body.  ``sqlite:///data/portal.db`` is
        # parsed only to keep the URL form documented — the concrete
        # path is derived from settings so existing deployments don't
        # need an env-var change.
        logger.info("Using SqliteStore for '%s' (DATABASE_URL=%s)", filename, url or "<unset>")
        return SqliteStore(filename, data_dir=settings.DATA_DIR)

    if _is_postgres_url(url):
        # Imported lazily so the `postgres` optional extra is only
        # needed on deployments that actually target Postgres.
        try:
            from .persistence_postgres import PostgresStore
        except ImportError as exc:  # pragma: no cover — env-specific
            raise RuntimeError(
                "DATABASE_URL selects PostgreSQL but the 'postgres' extra "
                "is not installed.  Run `pip install -e .[portal,postgres]`.",
            ) from exc

        logger.info(
            "Using PostgresStore for '%s' (managed_identity=%s)",
            filename,
            settings.POSTGRES_USE_MANAGED_IDENTITY,
        )
        return PostgresStore(
            filename,
            database_url=url,
            use_managed_identity=settings.POSTGRES_USE_MANAGED_IDENTITY,
        )

    raise ValueError(
        f"Unsupported DATABASE_URL scheme: {url!r}.  "
        "Expected 'sqlite:...' or 'postgresql:...'.",
    )


__all__ = [
    "build_store_backend",
]
