"""
Azure Database for PostgreSQL (Flexible Server) backed store (CSA-0046).

.. deprecated:: 0.2.0
    :class:`PostgresStore` is the sync compat shim that predates the
    async refactor described in ADR-0016.  New code should prefer
    :class:`portal.shared.api.persistence_async.AsyncPostgresStore`
    which is the canonical Postgres driver.  The sync class will be
    removed in the next minor release (CSA-0046 v3).

Provides :class:`PostgresStore`, a :class:`StoreBackend` implementation
that persists records to a PostgreSQL table-per-logical-store using
SQLAlchemy 2.0 + ``psycopg`` v3.  The table schema mirrors the SQLite
layout — ``id`` TEXT primary key plus a ``data`` ``JSONB`` column —
so migration of existing records can be performed with a simple dump
and re-insert.

Key features
------------
* **Managed Identity auth** — when ``POSTGRES_USE_MANAGED_IDENTITY`` is
  enabled the connection password is replaced at connect time with a
  fresh Azure AD access token scoped to
  ``https://ossrdbms-aad.database.windows.net/.default``.  Tokens are
  cached in-memory and refreshed 5 minutes before expiry.
* **Password fallback** — when MI is disabled, the URL's embedded
  password (or ``POSTGRES_PASSWORD``) is used.
* **Pool configuration** — ``pool_pre_ping=True`` detects dead
  connections between uses; ``pool_size=10`` / ``max_overflow=20``
  gives headroom under load.
* **Atomic upsert** — ``INSERT ... ON CONFLICT (id) DO UPDATE`` ensures
  :meth:`add` is idempotent and consistent with the SQLite
  ``INSERT OR REPLACE`` semantics the routers expect.
* **Sync Protocol compatibility** — the router surface is synchronous
  because FastAPI routes were written against :class:`SqliteStore`.
  :class:`PostgresStore` therefore uses the SQLAlchemy sync engine with
  the ``psycopg`` v3 driver (which supports both sync and async)
  instead of ``asyncpg``.  The async SQLAlchemy engine is an option for
  future refactors that also convert the routers to ``await`` calls.

See :mod:`portal.shared.api.persistence_factory` for selection logic
and :mod:`portal.shared.api.alembic` for schema migrations.
"""

from __future__ import annotations

import json
import logging
import re
import threading
import time
import uuid
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:  # pragma: no cover — import only for type-checking
    from sqlalchemy.engine import Engine

from .persistence import _table_name_from_filename

logger = logging.getLogger(__name__)


# Token scope for Azure Database for PostgreSQL AAD authentication.
# Documented at:
# https://learn.microsoft.com/azure/postgresql/flexible-server/how-to-configure-sign-in-azure-ad-authentication
_AAD_POSTGRES_SCOPE = "https://ossrdbms-aad.database.windows.net/.default"

# Refresh the cached access token this many seconds before its stated
# expiry.  Five minutes is the recommended buffer for Azure AAD tokens.
_TOKEN_REFRESH_BUFFER_SECONDS = 5 * 60

_SAFE_KEY = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")


class _ManagedIdentityTokenProvider:
    """Fetch + cache an Azure AD access token for Postgres Flexible Server.

    Thread-safe: the cache is protected by a lock so concurrent
    connection attempts only trigger one token acquisition.
    """

    def __init__(self) -> None:
        # Imported lazily so ``azure-identity`` is only required when
        # managed identity is actually enabled.
        from azure.identity import DefaultAzureCredential

        self._credential = DefaultAzureCredential()
        self._token: str | None = None
        self._expires_on: float = 0.0
        self._lock = threading.Lock()

    def get_token(self) -> str:
        """Return a fresh access token, refreshing if near expiry."""
        with self._lock:
            now = time.time()
            if self._token is None or now >= self._expires_on - _TOKEN_REFRESH_BUFFER_SECONDS:
                token = self._credential.get_token(_AAD_POSTGRES_SCOPE)
                self._token = token.token
                self._expires_on = float(token.expires_on)
                logger.debug(
                    "Acquired new Postgres AAD token; expires_on=%s",
                    self._expires_on,
                )
            return self._token


class PostgresStore:
    """Postgres-backed store satisfying :class:`StoreBackend`.

    Each *logical store* maps to a dedicated table whose schema is::

        CREATE TABLE <table> (
            id   TEXT PRIMARY KEY,
            data JSONB NOT NULL
        );

    Every record is stored as a ``JSONB`` blob under its ``id`` so the
    interface is schemaless like SQLite.  Queries against top-level
    fields use Postgres' ``->>`` operator, which benefits from JSONB's
    indexable access path.

    Shared engine
    -------------
    All ``PostgresStore`` instances constructed with the same
    ``database_url`` share a single SQLAlchemy engine + connection pool.
    The engine is created on first use via
    :func:`_get_or_create_engine`.  This mirrors the one-connection-per-
    SqliteStore pattern but uses a pool because Postgres connections are
    heavier and benefit from reuse across requests.
    """

    def __init__(
        self,
        filename: str,
        database_url: str,
        *,
        use_managed_identity: bool = False,
        pool_size: int = 10,
        max_overflow: int = 20,
    ) -> None:
        self._filename = filename
        self.table = _table_name_from_filename(filename)
        self._database_url = database_url
        self._use_managed_identity = use_managed_identity
        self._pool_size = pool_size
        self._max_overflow = max_overflow

        self._engine: Engine = _get_or_create_engine(
            database_url,
            use_managed_identity=use_managed_identity,
            pool_size=pool_size,
            max_overflow=max_overflow,
        )

        self._ensure_table()

    # ── engine ──────────────────────────────────────────────────────────

    def _ensure_table(self) -> None:
        """Create the backing table if it does not yet exist.

        Alembic migrations are the *preferred* way to manage schema in
        production.  This method is a belt-and-braces safety net for
        local runs that bypass ``alembic upgrade head``.
        """
        from sqlalchemy import text

        stmt = text(
            f'CREATE TABLE IF NOT EXISTS "{self.table}" ('
            f"  id   TEXT PRIMARY KEY,"
            f"  data JSONB NOT NULL"
            f")"
        )
        with self._engine.begin() as conn:
            conn.execute(stmt)
        logger.debug("Ensured table '%s' exists in Postgres", self.table)

    # ── internal helpers ────────────────────────────────────────────────

    def _qt(self) -> str:
        """Return the quoted table name safe for SQL interpolation."""
        # Table names come from _table_name_from_filename() which
        # guarantees only [A-Za-z0-9_] characters, so double-quoting is
        # safe and final.
        return f'"{self.table}"'

    # ── CRUD ────────────────────────────────────────────────────────────

    def add(self, item: dict[str, Any]) -> dict[str, Any]:
        """Insert or replace a record (idempotent ``INSERT ... ON CONFLICT``)."""
        from sqlalchemy import text

        if "id" not in item:
            item["id"] = str(uuid.uuid4())

        item_id = str(item["id"])
        payload = json.dumps(item, default=str)

        stmt = text(
            f"INSERT INTO {self._qt()} (id, data) VALUES (:id, CAST(:data AS JSONB)) "
            "ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data"
        )
        with self._engine.begin() as conn:
            conn.execute(stmt, {"id": item_id, "data": payload})
        logger.debug("Added item %s to [%s]", item_id, self.table)
        return item

    def get(self, item_id: str) -> dict[str, Any] | None:
        """Return the record identified by ``item_id`` or ``None``."""
        from sqlalchemy import text

        stmt = text(f"SELECT data FROM {self._qt()} WHERE id = :id")
        with self._engine.connect() as conn:
            row = conn.execute(stmt, {"id": item_id}).fetchone()
        if row is None:
            return None
        return _coerce_json(row[0])

    def update(
        self,
        item_id: str,
        updates: dict[str, Any],
    ) -> dict[str, Any] | None:
        """Shallow-merge ``updates`` into an existing record."""
        from sqlalchemy import text

        select_stmt = text(
            f"SELECT data FROM {self._qt()} WHERE id = :id FOR UPDATE",
        )
        upd_stmt = text(
            f"UPDATE {self._qt()} SET data = CAST(:data AS JSONB) WHERE id = :id",
        )
        with self._engine.begin() as conn:
            row = conn.execute(select_stmt, {"id": item_id}).fetchone()
            if row is None:
                return None
            current = _coerce_json(row[0])
            current.update(updates)
            conn.execute(
                upd_stmt,
                {"id": item_id, "data": json.dumps(current, default=str)},
            )
        logger.debug("Updated item %s in [%s]", item_id, self.table)
        return current

    def update_atomic(
        self,
        item_id: str,
        mutator: Callable[[dict[str, Any]], dict[str, Any]],
    ) -> dict[str, Any] | None:
        """Read-modify-write under a row-level lock inside one transaction."""
        from sqlalchemy import text

        select_stmt = text(
            f"SELECT data FROM {self._qt()} WHERE id = :id FOR UPDATE",
        )
        upd_stmt = text(
            f"UPDATE {self._qt()} SET data = CAST(:data AS JSONB) WHERE id = :id",
        )
        with self._engine.begin() as conn:
            row = conn.execute(select_stmt, {"id": item_id}).fetchone()
            if row is None:
                return None
            current = _coerce_json(row[0])
            updated = mutator(current)
            if not isinstance(updated, dict):
                msg = (
                    f"update_atomic mutator returned {type(updated).__name__}, "
                    "expected dict."
                )
                raise TypeError(msg)
            conn.execute(
                upd_stmt,
                {"id": item_id, "data": json.dumps(updated, default=str)},
            )
        logger.debug("Atomically updated item %s in [%s]", item_id, self.table)
        return updated

    def delete(self, item_id: str) -> bool:
        """Delete a record by ``id``.  Returns ``True`` if a row was removed."""
        from sqlalchemy import text

        stmt = text(f"DELETE FROM {self._qt()} WHERE id = :id")
        with self._engine.begin() as conn:
            result = conn.execute(stmt, {"id": item_id})
            deleted = (result.rowcount or 0) > 0
        if deleted:
            logger.debug("Deleted item %s from [%s]", item_id, self.table)
        return deleted

    def list(self) -> list[dict[str, Any]]:
        """Return every record in insertion order."""
        from sqlalchemy import text

        stmt = text(f"SELECT data FROM {self._qt()} ORDER BY ctid")
        with self._engine.connect() as conn:
            rows = conn.execute(stmt).fetchall()
        return [_coerce_json(r[0]) for r in rows]

    def load(self) -> list[dict[str, Any]]:
        """Alias for :meth:`list`."""
        return self.list()

    def save(self, data: list[dict[str, Any]]) -> None:
        """Bulk-replace every record in a single transaction."""
        from sqlalchemy import text

        delete_stmt = text(f"DELETE FROM {self._qt()}")
        insert_stmt = text(
            f"INSERT INTO {self._qt()} (id, data) VALUES (:id, CAST(:data AS JSONB))"
        )
        with self._engine.begin() as conn:
            conn.execute(delete_stmt)
            for item in data:
                item_id = str(item.get("id", uuid.uuid4()))
                conn.execute(
                    insert_stmt,
                    {"id": item_id, "data": json.dumps(item, default=str)},
                )

    def query(self, **filters: Any) -> list[dict[str, Any]]:
        """Filter records by top-level field equality using ``data->>``.

        Keys are validated against the same identifier regex as
        ``SqliteStore.query`` to prevent SQL injection through crafted
        filter key names (SEC-0001).
        """
        from sqlalchemy import text

        if not filters:
            return self.list()

        for key in filters:
            if not _SAFE_KEY.match(key):
                raise ValueError(f"Unsafe filter key: {key!r}")

        # Stringify filter values because ``data->>`` returns text; the
        # caller passes Python primitives which we coerce to str for
        # comparison.  ``None`` is intentionally rejected — callers that
        # want "field IS NULL" semantics should use :meth:`list` +
        # in-Python filtering, which matches the SQLite backend's
        # behaviour under typical portal call sites.
        conditions = []
        params: dict[str, Any] = {}
        for idx, (key, value) in enumerate(filters.items()):
            pname = f"p{idx}"
            conditions.append(f"data->>'{key}' = :{pname}")
            params[pname] = str(value) if value is not None else None

        sql = f"SELECT data FROM {self._qt()} WHERE {' AND '.join(conditions)} ORDER BY ctid"
        with self._engine.connect() as conn:
            rows = conn.execute(text(sql), params).fetchall()
        return [_coerce_json(r[0]) for r in rows]

    def count(self) -> int:
        """Return the number of records in the store."""
        from sqlalchemy import text

        stmt = text(f"SELECT COUNT(*) FROM {self._qt()}")
        with self._engine.connect() as conn:
            row = conn.execute(stmt).fetchone()
        return int(row[0]) if row else 0

    def clear(self) -> None:
        """Delete every record from the store's table."""
        from sqlalchemy import text

        stmt = text(f"DELETE FROM {self._qt()}")
        with self._engine.begin() as conn:
            conn.execute(stmt)
        logger.info("Cleared all items from [%s]", self.table)


# ── Engine factory + MI token injection ─────────────────────────────────────


_ENGINE_CACHE: dict[str, Engine] = {}
_ENGINE_CACHE_LOCK = threading.Lock()


def _get_or_create_engine(
    database_url: str,
    *,
    use_managed_identity: bool,
    pool_size: int,
    max_overflow: int,
) -> Engine:
    """Return a cached SQLAlchemy engine for ``database_url``.

    Engines (and their connection pools) are cached per URL so that
    multiple :class:`PostgresStore` instances constructed against the
    same database share the pool.  The cache key also folds in the
    managed-identity flag so that toggling it produces a fresh engine.
    """
    key = f"{database_url}|mi={use_managed_identity}|ps={pool_size}|mo={max_overflow}"

    with _ENGINE_CACHE_LOCK:
        cached = _ENGINE_CACHE.get(key)
        if cached is not None:
            return cached

        from sqlalchemy import create_engine, event

        engine_url = _normalize_postgres_url(database_url)

        engine = create_engine(
            engine_url,
            pool_pre_ping=True,
            pool_size=pool_size,
            max_overflow=max_overflow,
            future=True,
        )

        if use_managed_identity:
            token_provider = _ManagedIdentityTokenProvider()

            @event.listens_for(engine, "do_connect")
            def _inject_aad_token(
                _dialect: Any,
                _conn_rec: Any,
                _cargs: Any,
                cparams: dict[str, Any],
            ) -> None:
                """Replace the connection password with a fresh AAD token.

                Fires before every new connection is opened by the pool,
                so rotations are transparent to callers.  The first three
                positional arguments (dialect, connection record, connect
                args) are required by the SQLAlchemy event signature but
                unused here — prefixed with ``_`` to silence lint.
                """
                cparams["password"] = token_provider.get_token()

            logger.info(
                "Postgres engine configured with managed identity auth (%s)",
                _redact_password(engine_url),
            )
        else:
            logger.info(
                "Postgres engine configured with password auth (%s)",
                _redact_password(engine_url),
            )

        _ENGINE_CACHE[key] = engine
        return engine


def _normalize_postgres_url(url: str) -> str:
    """Normalise *url* to use the ``psycopg`` (v3) driver.

    Accepts any of:
      - ``postgresql://...``
      - ``postgresql+psycopg://...``
      - ``postgresql+psycopg2://...``
      - ``postgresql+asyncpg://...``  → coerced to psycopg for the sync engine
    """
    if url.startswith("postgresql+asyncpg://"):
        return url.replace("postgresql+asyncpg://", "postgresql+psycopg://", 1)
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+psycopg://", 1)
    return url


def _redact_password(url: str) -> str:
    """Strip any embedded password before logging a connection URL."""
    return re.sub(r"(?<=://)([^:/@]+):([^@]+)@", r"\1:***@", url)


def _coerce_json(value: Any) -> dict[str, Any]:
    """Return a dict from a JSONB value.

    ``psycopg`` v3 returns JSONB columns as already-parsed Python
    objects, but other drivers (and some pool adapters) still hand
    back raw JSON strings.  Handle both transparently.
    """
    if isinstance(value, (bytes, str)):
        parsed = json.loads(value)
    else:
        parsed = value
    if not isinstance(parsed, dict):
        raise TypeError(
            f"Expected JSON object in store row, got {type(parsed).__name__}"
        )
    return parsed


__all__ = [
    "PostgresStore",
]
