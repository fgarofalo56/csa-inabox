"""
Tests for :func:`portal.shared.api.persistence_factory.build_store_backend`
(CSA-0046).

Verifies that the factory correctly dispatches on the ``DATABASE_URL``
scheme and that both backends satisfy the :class:`StoreBackend` Protocol.
Postgres-specific behaviour is covered in :mod:`test_persistence` when
a live ``PG_TEST_DSN`` is available; here we exercise the dispatch
logic without standing up a database.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest
from portal.shared.api.persistence import SqliteStore, StoreBackend
from portal.shared.api.persistence_factory import build_store_backend


@dataclass
class _FakeSettings:
    """Minimal settings shim — avoids triggering pydantic .env reads."""

    DATABASE_URL: str = ""
    DATA_DIR: str = ""
    POSTGRES_USE_MANAGED_IDENTITY: bool = False


def test_factory_returns_sqlite_for_empty_url(tmp_path: Any) -> None:
    """An empty DATABASE_URL yields the default SQLite backend."""
    s = _FakeSettings(DATABASE_URL="", DATA_DIR=str(tmp_path))
    backend = build_store_backend("widgets.json", s)  # type: ignore[arg-type]

    assert isinstance(backend, SqliteStore)
    assert isinstance(backend, StoreBackend)


def test_factory_returns_sqlite_for_sqlite_url(tmp_path: Any) -> None:
    """``sqlite://`` URLs select the SQLite backend."""
    s = _FakeSettings(
        DATABASE_URL=f"sqlite:///{tmp_path}/x.db",
        DATA_DIR=str(tmp_path),
    )
    backend = build_store_backend("widgets.json", s)  # type: ignore[arg-type]

    assert isinstance(backend, SqliteStore)


def test_factory_rejects_unknown_scheme() -> None:
    """An unknown URL scheme raises ValueError — fails closed."""
    s = _FakeSettings(DATABASE_URL="mysql://example.com/db")
    with pytest.raises(ValueError, match="Unsupported DATABASE_URL scheme"):
        build_store_backend("widgets.json", s)  # type: ignore[arg-type]


def test_factory_rejects_nonsense_url() -> None:
    """A non-URL string also raises ValueError."""
    s = _FakeSettings(DATABASE_URL="this is not a url")
    with pytest.raises(ValueError, match="Unsupported DATABASE_URL scheme"):
        build_store_backend("widgets.json", s)  # type: ignore[arg-type]


def test_factory_dispatches_on_postgres_scheme() -> None:
    """``postgresql://`` selects PostgresStore (construction only).

    We don't connect to Postgres here — the engine factory is called
    inside ``PostgresStore.__init__`` but SQLAlchemy's engine is lazy:
    the connection is only opened on the first ``_ensure_table`` call.

    This test simply asserts the dispatch path imports and constructs
    the right class.  When the ``psycopg`` / ``sqlalchemy`` packages
    are not installed, we skip rather than fail — matching the
    optional-extra contract.
    """
    try:
        import psycopg  # noqa: F401 — driver presence check
        import sqlalchemy  # noqa: F401 — presence check
    except ImportError:
        pytest.skip("sqlalchemy/psycopg not installed; skipping Postgres dispatch test")

    s = _FakeSettings(
        DATABASE_URL="postgresql://user@localhost:5432/mydb",
        POSTGRES_USE_MANAGED_IDENTITY=False,
    )
    # The engine is constructed lazily; _ensure_table tries to connect.
    # We catch that to keep the test offline-safe.
    from portal.shared.api import persistence_factory as pf

    # Patch PostgresStore._ensure_table to a no-op so no connection is
    # attempted — we're only verifying the dispatch logic here.
    from portal.shared.api import persistence_postgres as pp

    original = pp.PostgresStore._ensure_table
    pp.PostgresStore._ensure_table = lambda _self: None  # type: ignore[method-assign]
    try:
        backend = pf.build_store_backend("widgets.json", s)  # type: ignore[arg-type]
        assert isinstance(backend, pp.PostgresStore)
        assert isinstance(backend, StoreBackend)
    finally:
        pp.PostgresStore._ensure_table = original  # type: ignore[method-assign]


def test_factory_dispatches_on_asyncpg_driver() -> None:
    """``postgresql+asyncpg://`` also selects PostgresStore.

    The URL is rewritten to the sync ``psycopg`` driver inside the
    store implementation.
    """
    try:
        import psycopg  # noqa: F401 — driver presence check
        import sqlalchemy  # noqa: F401
    except ImportError:
        pytest.skip("sqlalchemy/psycopg not installed; skipping Postgres dispatch test")

    s = _FakeSettings(DATABASE_URL="postgresql+asyncpg://user@localhost/db")

    from portal.shared.api import persistence_factory as pf
    from portal.shared.api import persistence_postgres as pp

    original = pp.PostgresStore._ensure_table
    pp.PostgresStore._ensure_table = lambda _self: None  # type: ignore[method-assign]
    try:
        backend = pf.build_store_backend("widgets.json", s)  # type: ignore[arg-type]
        assert isinstance(backend, pp.PostgresStore)
    finally:
        pp.PostgresStore._ensure_table = original  # type: ignore[method-assign]
