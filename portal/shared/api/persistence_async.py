"""
Async store backends for portal persistence (CSA-0046 follow-on).

Defines :class:`AsyncStoreBackend` — the async counterpart to
:class:`portal.shared.api.persistence.StoreBackend` — plus two
concrete implementations:

* :class:`AsyncSqliteStore` — ``aiosqlite``-backed async SQLite store.
  Preserves WAL mode and the performance PRAGMAs of the sync
  implementation; an :class:`asyncio.Lock` serialises
  read-modify-write cycles in place of the sync
  :class:`threading.RLock` used by :class:`~portal.shared.api.persistence.SqliteStore`.
  Single-statement operations (``add``, ``get``, ``delete``, ``list``)
  run lock-free.
* :class:`AsyncPostgresStore` — SQLAlchemy 2.0 ``AsyncEngine`` + the
  ``asyncpg`` driver.  Reuses :class:`~portal.shared.api.persistence_postgres._ManagedIdentityTokenProvider`
  semantics via a new :class:`_AsyncManagedIdentityTokenProvider`
  that uses the ``.aio`` variant of ``DefaultAzureCredential`` so
  token acquisition is non-blocking.

Both stores are wired up by
:func:`build_async_store_backend` which mirrors the sync
:func:`portal.shared.api.persistence_factory.build_store_backend`.

Typed exceptions (:class:`StoreBackendError`,
:class:`StoreConnectionError`) and tenacity retry wrappers on
transient driver errors provide the production-grade error
surface the ticket demands.

See ADR-0016 for the full rationale.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol, TypeVar, runtime_checkable

from .persistence import _table_name_from_filename

if TYPE_CHECKING:  # pragma: no cover — import only for type-checking
    from sqlalchemy.ext.asyncio import AsyncEngine

    from .config import Settings

logger = logging.getLogger(__name__)


# ── Typed exceptions ────────────────────────────────────────────────────────


class StoreBackendError(Exception):
    """Base exception for async store backend failures."""


class StoreConnectionError(StoreBackendError):
    """Raised when the async store cannot reach its underlying database."""


# ── Protocol ────────────────────────────────────────────────────────────────


@runtime_checkable
class AsyncStoreBackend(Protocol):
    """Async persistence contract shared by SQLite and Postgres backends.

    Records are untyped dictionaries with at minimum an ``id`` key.
    Every method is a coroutine so FastAPI routes can ``await`` directly
    without blocking the event loop.
    """

    async def add(self, item: dict[str, Any]) -> dict[str, Any]:
        """Insert or replace a record.  Generates an ``id`` when absent."""
        ...

    async def get(self, item_id: str) -> dict[str, Any] | None:
        """Return a record by ``id`` or ``None``."""
        ...

    async def list(self) -> list[dict[str, Any]]:
        """Return all records in insertion order."""
        ...

    async def load(self) -> list[dict[str, Any]]:
        """Alias for :meth:`list` preserved for legacy callers."""
        ...

    async def update(
        self,
        item_id: str,
        updates: dict[str, Any],
    ) -> dict[str, Any] | None:
        """Shallow-merge ``updates`` into an existing record."""
        ...

    async def update_atomic(
        self,
        item_id: str,
        mutator: Callable[[dict[str, Any]], dict[str, Any]],
    ) -> dict[str, Any] | None:
        """Read-modify-write under a single transaction."""
        ...

    async def delete(self, item_id: str) -> bool:
        """Delete a record by ``id``.  Returns ``True`` if a row was removed."""
        ...

    async def count(self) -> int:
        """Return total number of records in the store."""
        ...

    async def clear(self) -> None:
        """Remove all records from the store."""
        ...

    async def save(self, data: list[dict[str, Any]]) -> None:
        """Bulk-replace every record (legacy API, single atomic txn)."""
        ...

    async def query(self, **filters: Any) -> list[dict[str, Any]]:
        """Filter records by top-level field equality."""
        ...

    async def close(self) -> None:
        """Release underlying connection / pool resources."""
        ...


# ── Retry helper ────────────────────────────────────────────────────────────

T = TypeVar("T")


def _retry_transient(
    attempts: int = 3,
    *,
    multiplier: float = 0.25,
    max_wait: float = 2.0,
) -> Callable[[Callable[..., Awaitable[T]]], Callable[..., Awaitable[T]]]:
    """Return a decorator that retries transient driver errors with jittered backoff.

    The decorator wraps an async function and retries on ``OSError``
    (covers aiosqlite ``sqlite3.OperationalError`` + asyncpg network
    blips) and :class:`StoreConnectionError`.  Tenacity is imported
    lazily so SQLite-only deployments that don't install the
    ``async-store`` extra still function — the decorator silently
    degrades to a no-op retry when tenacity is absent.
    """
    try:
        from tenacity import (
            retry,
            retry_if_exception_type,
            stop_after_attempt,
            wait_random_exponential,
        )
    except ImportError:  # pragma: no cover — tenacity is a transitive dep
        def _passthrough(
            fn: Callable[..., Awaitable[T]],
        ) -> Callable[..., Awaitable[T]]:
            return fn

        return _passthrough

    return retry(
        stop=stop_after_attempt(attempts),
        wait=wait_random_exponential(multiplier=multiplier, max=max_wait),
        retry=retry_if_exception_type((OSError, StoreConnectionError)),
        reraise=True,
    )


# ── SQLite default paths ────────────────────────────────────────────────────

_DEFAULT_DB_DIR = Path("./data")
_DEFAULT_DB_NAME = "portal.db"

_SAFE_KEY = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")


# ── Async SQLite store ──────────────────────────────────────────────────────


class AsyncSqliteStore:
    """Async SQLite backend satisfying :class:`AsyncStoreBackend`.

    Backed by ``aiosqlite``.  Schema and PRAGMAs mirror the sync
    :class:`~portal.shared.api.persistence.SqliteStore` exactly so both
    stores can coexist against the same database file — this is what
    lets the migration CLI read a live SQLite database without quiescing
    the portal.

    Concurrency model
    -----------------
    SQLite under WAL permits concurrent readers plus a single writer at
    the OS level.  :attr:`_write_lock` (an :class:`asyncio.Lock`)
    serialises Python-side RMW cycles inside :meth:`update` /
    :meth:`update_atomic` / :meth:`save` so two concurrent coroutines
    cannot interleave SELECT→modify→UPDATE and produce a lost update.
    Single-statement operations (``add``, ``get``, ``delete``, ``list``)
    do not take this lock.
    """

    def __init__(
        self,
        filename: str,
        data_dir: str | Path = _DEFAULT_DB_DIR,
        db_name: str = _DEFAULT_DB_NAME,
    ) -> None:
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)

        self.db_path = self.data_dir / db_name
        self.table = _table_name_from_filename(filename)

        self._write_lock = asyncio.Lock()
        # Underlying aiosqlite connection is opened lazily on first use
        # because constructors are synchronous but aiosqlite's connect
        # is a coroutine.  The first operation performs one-time table
        # creation + PRAGMA setup.
        self._conn: Any = None
        self._init_lock = asyncio.Lock()
        self._initialised = False

    async def _ensure_ready(self) -> Any:
        """Lazy-initialise the aiosqlite connection + backing table."""
        if self._initialised and self._conn is not None:
            return self._conn

        async with self._init_lock:
            if self._initialised and self._conn is not None:
                return self._conn

            try:
                import aiosqlite
            except ImportError as exc:  # pragma: no cover — extra guard
                msg = (
                    "aiosqlite is required for the async SQLite backend. "
                    "Install via `pip install -e .[postgres]` or the "
                    "`async-store` extra."
                )
                raise StoreBackendError(msg) from exc

            try:
                self._conn = await aiosqlite.connect(str(self.db_path))
                await self._conn.execute("PRAGMA journal_mode=WAL")
                await self._conn.execute("PRAGMA busy_timeout=5000")
                await self._conn.execute("PRAGMA synchronous=NORMAL")
                await self._conn.execute(
                    f"CREATE TABLE IF NOT EXISTS [{self.table}] ("
                    "  id   TEXT PRIMARY KEY,"
                    "  data TEXT NOT NULL CHECK(json_valid(data))"
                    ")",
                )
                await self._conn.commit()
            except Exception as exc:
                msg = f"Failed to open async SQLite store at {self.db_path}: {exc}"
                raise StoreConnectionError(msg) from exc

            self._initialised = True
            logger.debug(
                "AsyncSqliteStore ready (db=%s, table=%s)",
                self.db_path,
                self.table,
            )
            return self._conn

    async def close(self) -> None:
        """Close the underlying aiosqlite connection if open."""
        if self._conn is not None:
            try:
                await self._conn.close()
            except Exception as exc:
                logger.warning("AsyncSqliteStore close error: %s", exc)
            self._conn = None
            self._initialised = False

    # ── CRUD ────────────────────────────────────────────────────────────

    @_retry_transient()
    async def add(self, item: dict[str, Any]) -> dict[str, Any]:
        if "id" not in item:
            item["id"] = str(uuid.uuid4())
        item_id = str(item["id"])
        conn = await self._ensure_ready()
        await conn.execute(
            f"INSERT OR REPLACE INTO [{self.table}] (id, data) VALUES (?, ?)",
            (item_id, json.dumps(item, default=str)),
        )
        await conn.commit()
        return item

    @_retry_transient()
    async def get(self, item_id: str) -> dict[str, Any] | None:
        conn = await self._ensure_ready()
        async with conn.execute(
            f"SELECT data FROM [{self.table}] WHERE id = ?",
            (item_id,),
        ) as cursor:
            row = await cursor.fetchone()
        if row is None:
            return None
        return json.loads(row[0])

    async def update(
        self,
        item_id: str,
        updates: dict[str, Any],
    ) -> dict[str, Any] | None:
        async with self._transact() as conn:
            async with conn.execute(
                f"SELECT data FROM [{self.table}] WHERE id = ?",
                (item_id,),
            ) as cur:
                row = await cur.fetchone()
            if row is None:
                return None
            item = json.loads(row[0])
            item.update(updates)
            await conn.execute(
                f"UPDATE [{self.table}] SET data = ? WHERE id = ?",
                (json.dumps(item, default=str), item_id),
            )
        return item

    async def update_atomic(
        self,
        item_id: str,
        mutator: Callable[[dict[str, Any]], dict[str, Any]],
    ) -> dict[str, Any] | None:
        async with self._transact() as conn:
            async with conn.execute(
                f"SELECT data FROM [{self.table}] WHERE id = ?",
                (item_id,),
            ) as cur:
                row = await cur.fetchone()
            if row is None:
                return None
            current = json.loads(row[0])
            updated = mutator(current)
            if not isinstance(updated, dict):
                msg = (
                    f"update_atomic mutator returned {type(updated).__name__}, "
                    "expected dict."
                )
                raise TypeError(msg)
            await conn.execute(
                f"UPDATE [{self.table}] SET data = ? WHERE id = ?",
                (json.dumps(updated, default=str), item_id),
            )
        return updated

    @_retry_transient()
    async def delete(self, item_id: str) -> bool:
        conn = await self._ensure_ready()
        cursor = await conn.execute(
            f"DELETE FROM [{self.table}] WHERE id = ?",
            (item_id,),
        )
        await conn.commit()
        return (cursor.rowcount or 0) > 0

    @_retry_transient()
    async def list(self) -> list[dict[str, Any]]:
        conn = await self._ensure_ready()
        async with conn.execute(
            f"SELECT data FROM [{self.table}] ORDER BY rowid",
        ) as cur:
            rows = await cur.fetchall()
        return [json.loads(r[0]) for r in rows]

    async def load(self) -> list[dict[str, Any]]:
        return await self.list()

    async def save(self, data: list[dict[str, Any]]) -> None:
        async with self._transact() as conn:
            await conn.execute(f"DELETE FROM [{self.table}]")
            for item in data:
                item_id = str(item.get("id", uuid.uuid4()))
                await conn.execute(
                    f"INSERT INTO [{self.table}] (id, data) VALUES (?, ?)",
                    (item_id, json.dumps(item, default=str)),
                )

    @_retry_transient()
    async def query(self, **filters: Any) -> list[dict[str, Any]]:
        if not filters:
            return await self.list()
        for key in filters:
            if not _SAFE_KEY.match(key):
                raise ValueError(f"Unsafe filter key: {key!r}")
        conditions = [
            f"json_extract(data, '$.{key}') = ?" for key in filters
        ]
        params = list(filters.values())
        sql = (
            f"SELECT data FROM [{self.table}]"
            f" WHERE {' AND '.join(conditions)}"
            f" ORDER BY rowid"
        )
        conn = await self._ensure_ready()
        async with conn.execute(sql, params) as cur:
            rows = await cur.fetchall()
        return [json.loads(r[0]) for r in rows]

    @_retry_transient()
    async def count(self) -> int:
        conn = await self._ensure_ready()
        async with conn.execute(
            f"SELECT COUNT(*) FROM [{self.table}]",
        ) as cur:
            row = await cur.fetchone()
        return int(row[0]) if row else 0

    @_retry_transient()
    async def clear(self) -> None:
        conn = await self._ensure_ready()
        await conn.execute(f"DELETE FROM [{self.table}]")
        await conn.commit()

    # ── helpers ────────────────────────────────────────────────────────

    @asynccontextmanager
    async def _transact(self) -> AsyncIterator[Any]:
        """Yield the aiosqlite connection under ``BEGIN IMMEDIATE``.

        Combined with :attr:`_write_lock` this gives strong serialisable
        semantics for read-modify-write cycles even under concurrent
        FastAPI coroutine dispatch.
        """
        conn = await self._ensure_ready()
        async with self._write_lock:
            try:
                await conn.execute("BEGIN IMMEDIATE")
                yield conn
                await conn.commit()
            except Exception:
                await conn.rollback()
                raise


# ── Async Postgres store ────────────────────────────────────────────────────


_AAD_POSTGRES_SCOPE = "https://ossrdbms-aad.database.windows.net/.default"
_TOKEN_REFRESH_BUFFER_SECONDS = 5 * 60


class _AsyncManagedIdentityTokenProvider:
    """Async AAD token provider using :class:`azure.identity.aio.DefaultAzureCredential`.

    Mirrors the sync provider in :mod:`persistence_postgres` but
    performs non-blocking token acquisition.  Tokens are cached
    process-wide and protected by an :class:`asyncio.Lock`.
    """

    def __init__(self) -> None:
        # Lazy import so azure-identity is only required on Postgres-MI
        # deployments.
        from azure.identity.aio import DefaultAzureCredential

        self._credential = DefaultAzureCredential()
        self._token: str | None = None
        self._expires_on: float = 0.0
        self._lock = asyncio.Lock()

    async def get_token(self) -> str:
        """Return a fresh access token, refreshing if near expiry."""
        async with self._lock:
            now = time.time()
            if (
                self._token is None
                or now >= self._expires_on - _TOKEN_REFRESH_BUFFER_SECONDS
            ):
                token = await self._credential.get_token(_AAD_POSTGRES_SCOPE)
                self._token = token.token
                self._expires_on = float(token.expires_on)
                logger.debug(
                    "Acquired async Postgres AAD token; expires_on=%s",
                    self._expires_on,
                )
            return self._token

    async def close(self) -> None:
        """Release the underlying :class:`DefaultAzureCredential`."""
        try:
            await self._credential.close()
        except Exception as exc:
            logger.warning("DefaultAzureCredential.aio close error: %s", exc)


class AsyncPostgresStore:
    """Async Postgres backend satisfying :class:`AsyncStoreBackend`.

    Uses SQLAlchemy 2.0's :class:`AsyncEngine` with the ``asyncpg``
    driver.  Per-URL engines are cached in a module-level dict so
    multiple store instances share a single connection pool.

    Managed identity is wired through asyncpg's ``connect_args`` via a
    callable ``password`` — asyncpg invokes the callable on every new
    connection, so fresh tokens are picked up automatically as the
    cache refreshes.
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
        self._engine: AsyncEngine | None = None
        self._init_lock = asyncio.Lock()
        self._initialised = False

    async def _ensure_ready(self) -> AsyncEngine:
        """Lazy-initialise the AsyncEngine + backing table."""
        if self._initialised and self._engine is not None:
            return self._engine
        async with self._init_lock:
            if self._initialised and self._engine is not None:
                return self._engine
            self._engine = await _get_or_create_async_engine(
                self._database_url,
                use_managed_identity=self._use_managed_identity,
                pool_size=self._pool_size,
                max_overflow=self._max_overflow,
            )
            await self._ensure_table(self._engine)
            self._initialised = True
            return self._engine

    async def _ensure_table(self, engine: AsyncEngine) -> None:
        from sqlalchemy import text

        stmt = text(
            f'CREATE TABLE IF NOT EXISTS "{self.table}" ('
            f"  id   TEXT PRIMARY KEY,"
            f"  data JSONB NOT NULL"
            f")",
        )
        async with engine.begin() as conn:
            await conn.execute(stmt)

    async def close(self) -> None:
        """Dispose of the cached engine (idempotent, shared with other stores)."""
        # Engines are shared across store instances via the module-level
        # cache so we intentionally do NOT dispose here — callers should
        # use :func:`close_async_engines` at application shutdown.  The
        # per-store ``close`` still flips the init flag so a subsequent
        # operation re-resolves the cached engine.
        self._initialised = False
        self._engine = None

    # ── CRUD ────────────────────────────────────────────────────────────

    def _qt(self) -> str:
        # Table names are sanitised via _table_name_from_filename(),
        # which only yields [A-Za-z0-9_].  Double-quoting is final.
        return f'"{self.table}"'

    @_retry_transient()
    async def add(self, item: dict[str, Any]) -> dict[str, Any]:
        from sqlalchemy import text

        if "id" not in item:
            item["id"] = str(uuid.uuid4())
        item_id = str(item["id"])
        payload = json.dumps(item, default=str)
        engine = await self._ensure_ready()
        stmt = text(
            f"INSERT INTO {self._qt()} (id, data) "
            "VALUES (:id, CAST(:data AS JSONB)) "
            "ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data",
        )
        async with engine.begin() as conn:
            await conn.execute(stmt, {"id": item_id, "data": payload})
        return item

    @_retry_transient()
    async def get(self, item_id: str) -> dict[str, Any] | None:
        from sqlalchemy import text

        engine = await self._ensure_ready()
        stmt = text(f"SELECT data FROM {self._qt()} WHERE id = :id")
        async with engine.connect() as conn:
            result = await conn.execute(stmt, {"id": item_id})
            row = result.fetchone()
        if row is None:
            return None
        return _coerce_json(row[0])

    async def update(
        self,
        item_id: str,
        updates: dict[str, Any],
    ) -> dict[str, Any] | None:
        from sqlalchemy import text

        engine = await self._ensure_ready()
        select_stmt = text(
            f"SELECT data FROM {self._qt()} WHERE id = :id FOR UPDATE",
        )
        upd_stmt = text(
            f"UPDATE {self._qt()} SET data = CAST(:data AS JSONB) WHERE id = :id",
        )
        async with engine.begin() as conn:
            result = await conn.execute(select_stmt, {"id": item_id})
            row = result.fetchone()
            if row is None:
                return None
            current = _coerce_json(row[0])
            current.update(updates)
            await conn.execute(
                upd_stmt,
                {"id": item_id, "data": json.dumps(current, default=str)},
            )
        return current

    async def update_atomic(
        self,
        item_id: str,
        mutator: Callable[[dict[str, Any]], dict[str, Any]],
    ) -> dict[str, Any] | None:
        from sqlalchemy import text

        engine = await self._ensure_ready()
        select_stmt = text(
            f"SELECT data FROM {self._qt()} WHERE id = :id FOR UPDATE",
        )
        upd_stmt = text(
            f"UPDATE {self._qt()} SET data = CAST(:data AS JSONB) WHERE id = :id",
        )
        async with engine.begin() as conn:
            result = await conn.execute(select_stmt, {"id": item_id})
            row = result.fetchone()
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
            await conn.execute(
                upd_stmt,
                {"id": item_id, "data": json.dumps(updated, default=str)},
            )
        return updated

    @_retry_transient()
    async def delete(self, item_id: str) -> bool:
        from sqlalchemy import text

        engine = await self._ensure_ready()
        stmt = text(f"DELETE FROM {self._qt()} WHERE id = :id")
        async with engine.begin() as conn:
            result = await conn.execute(stmt, {"id": item_id})
            return (result.rowcount or 0) > 0

    @_retry_transient()
    async def list(self) -> list[dict[str, Any]]:
        from sqlalchemy import text

        engine = await self._ensure_ready()
        stmt = text(f"SELECT data FROM {self._qt()} ORDER BY ctid")
        async with engine.connect() as conn:
            result = await conn.execute(stmt)
            rows = result.fetchall()
        return [_coerce_json(r[0]) for r in rows]

    async def load(self) -> list[dict[str, Any]]:
        return await self.list()

    async def save(self, data: list[dict[str, Any]]) -> None:
        from sqlalchemy import text

        engine = await self._ensure_ready()
        delete_stmt = text(f"DELETE FROM {self._qt()}")
        insert_stmt = text(
            f"INSERT INTO {self._qt()} (id, data) VALUES (:id, CAST(:data AS JSONB))",
        )
        async with engine.begin() as conn:
            await conn.execute(delete_stmt)
            for item in data:
                item_id = str(item.get("id", uuid.uuid4()))
                await conn.execute(
                    insert_stmt,
                    {"id": item_id, "data": json.dumps(item, default=str)},
                )

    @_retry_transient()
    async def query(self, **filters: Any) -> list[dict[str, Any]]:
        from sqlalchemy import text

        if not filters:
            return await self.list()
        for key in filters:
            if not _SAFE_KEY.match(key):
                raise ValueError(f"Unsafe filter key: {key!r}")
        conditions = []
        params: dict[str, Any] = {}
        for idx, (key, value) in enumerate(filters.items()):
            pname = f"p{idx}"
            conditions.append(f"data->>'{key}' = :{pname}")
            params[pname] = str(value) if value is not None else None
        sql = (
            f"SELECT data FROM {self._qt()} "
            f"WHERE {' AND '.join(conditions)} ORDER BY ctid"
        )
        engine = await self._ensure_ready()
        async with engine.connect() as conn:
            result = await conn.execute(text(sql), params)
            rows = result.fetchall()
        return [_coerce_json(r[0]) for r in rows]

    @_retry_transient()
    async def count(self) -> int:
        from sqlalchemy import text

        engine = await self._ensure_ready()
        stmt = text(f"SELECT COUNT(*) FROM {self._qt()}")
        async with engine.connect() as conn:
            result = await conn.execute(stmt)
            row = result.fetchone()
        return int(row[0]) if row else 0

    @_retry_transient()
    async def clear(self) -> None:
        from sqlalchemy import text

        engine = await self._ensure_ready()
        stmt = text(f"DELETE FROM {self._qt()}")
        async with engine.begin() as conn:
            await conn.execute(stmt)


# ── Engine cache + URL helpers ──────────────────────────────────────────────


_ASYNC_ENGINE_CACHE: dict[str, Any] = {}
_ASYNC_ENGINE_CACHE_LOCK = asyncio.Lock()
_ASYNC_TOKEN_PROVIDERS: dict[str, _AsyncManagedIdentityTokenProvider] = {}


async def _get_or_create_async_engine(
    database_url: str,
    *,
    use_managed_identity: bool,
    pool_size: int,
    max_overflow: int,
) -> AsyncEngine:
    """Return a cached AsyncEngine for *database_url*.

    Engine + pool are shared across store instances so concurrent
    router coroutines amortise pool cost across the whole API.
    """
    key = f"{database_url}|mi={use_managed_identity}|ps={pool_size}|mo={max_overflow}"

    async with _ASYNC_ENGINE_CACHE_LOCK:
        cached = _ASYNC_ENGINE_CACHE.get(key)
        if cached is not None:
            return cached

        try:
            from sqlalchemy.ext.asyncio import create_async_engine
        except ImportError as exc:  # pragma: no cover
            msg = (
                "sqlalchemy[asyncio] is required for the async Postgres "
                "backend. Install via `pip install -e .[postgres]`."
            )
            raise StoreBackendError(msg) from exc

        engine_url = _normalize_async_postgres_url(database_url)
        connect_args: dict[str, Any] = {}

        if use_managed_identity:
            token_provider = _AsyncManagedIdentityTokenProvider()
            _ASYNC_TOKEN_PROVIDERS[key] = token_provider

            # asyncpg accepts a *sync* callable that returns a password
            # string.  To bridge that to our async token provider we
            # resolve an initial token synchronously via
            # ``run_until_complete`` is not safe inside a running loop,
            # so we read the cached token directly — the provider
            # already guarantees refresh-before-use semantics via the
            # async lock.  First fetch is done here.
            _initial = await token_provider.get_token()

            def _password_factory() -> str:
                # asyncpg reconnects can fire from a thread; the
                # cached value is updated inside the async provider
                # whenever a fresh token is minted via
                # :meth:`get_token`.  For connection retries we hand
                # back the most recently cached token.
                return token_provider._token or _initial

            connect_args["password"] = _password_factory

            logger.info(
                "Async Postgres engine configured with managed identity (%s)",
                _redact_password(engine_url),
            )
        else:
            logger.info(
                "Async Postgres engine configured with password auth (%s)",
                _redact_password(engine_url),
            )

        engine = create_async_engine(
            engine_url,
            pool_pre_ping=True,
            pool_size=pool_size,
            max_overflow=max_overflow,
            future=True,
            connect_args=connect_args,
        )

        _ASYNC_ENGINE_CACHE[key] = engine
        return engine


def _normalize_async_postgres_url(url: str) -> str:
    """Coerce *url* to the ``postgresql+asyncpg://`` driver."""
    if url.startswith("postgresql+asyncpg://"):
        return url
    if url.startswith("postgresql+psycopg://"):
        return url.replace("postgresql+psycopg://", "postgresql+asyncpg://", 1)
    if url.startswith("postgresql+psycopg2://"):
        return url.replace("postgresql+psycopg2://", "postgresql+asyncpg://", 1)
    if url.startswith("postgresql://"):
        return url.replace("postgresql://", "postgresql+asyncpg://", 1)
    if url.startswith("postgres://"):
        return url.replace("postgres://", "postgresql+asyncpg://", 1)
    return url


def _redact_password(url: str) -> str:
    """Strip any embedded password before logging a URL."""
    return re.sub(r"(?<=://)([^:/@]+):([^@]+)@", r"\1:***@", url)


def _coerce_json(value: Any) -> dict[str, Any]:
    """Return a dict from a JSONB cell."""
    if isinstance(value, (bytes, str)):
        parsed = json.loads(value)
    else:
        parsed = value
    if not isinstance(parsed, dict):
        raise TypeError(
            f"Expected JSON object in store row, got {type(parsed).__name__}",
        )
    return parsed


async def close_async_engines() -> None:
    """Dispose every cached AsyncEngine + token provider.

    Call from the FastAPI lifespan shutdown handler so connections drain
    cleanly during pod rollouts.
    """
    async with _ASYNC_ENGINE_CACHE_LOCK:
        for key, engine in list(_ASYNC_ENGINE_CACHE.items()):
            try:
                await engine.dispose()
            except Exception as exc:
                logger.warning("AsyncEngine.dispose error for %s: %s", key, exc)
        _ASYNC_ENGINE_CACHE.clear()

        for key, provider in list(_ASYNC_TOKEN_PROVIDERS.items()):
            try:
                await provider.close()
            except Exception as exc:
                logger.warning(
                    "AsyncManagedIdentityTokenProvider close error for %s: %s",
                    key,
                    exc,
                )
        _ASYNC_TOKEN_PROVIDERS.clear()


# ── Factory ─────────────────────────────────────────────────────────────────


def _is_sqlite_url(url: str) -> bool:
    return not url or url.startswith("sqlite:")


def _is_postgres_url(url: str) -> bool:
    return url.startswith(("postgresql://", "postgresql+", "postgres://", "postgres+"))


def build_async_store_backend(
    filename: str,
    settings: Settings,
) -> AsyncStoreBackend:
    """Construct an :class:`AsyncStoreBackend` based on ``settings.DATABASE_URL``.

    Mirrors :func:`portal.shared.api.persistence_factory.build_store_backend`
    but returns the async variant.  Fails closed on unknown URL schemes.
    """
    url = (settings.DATABASE_URL or "").strip()

    if _is_sqlite_url(url):
        logger.info(
            "Using AsyncSqliteStore for '%s' (DATABASE_URL=%s)",
            filename,
            url or "<unset>",
        )
        return AsyncSqliteStore(filename, data_dir=settings.DATA_DIR)

    if _is_postgres_url(url):
        try:
            # Probe imports early so misconfig surfaces with a clear error.
            import asyncpg  # noqa: F401
            import sqlalchemy.ext.asyncio  # noqa: F401
        except ImportError as exc:  # pragma: no cover — env-specific
            msg = (
                "DATABASE_URL selects PostgreSQL but the 'postgres' extra "
                "is not installed.  Run `pip install -e .[portal,postgres]`."
            )
            raise RuntimeError(msg) from exc

        logger.info(
            "Using AsyncPostgresStore for '%s' (managed_identity=%s)",
            filename,
            settings.POSTGRES_USE_MANAGED_IDENTITY,
        )
        return AsyncPostgresStore(
            filename,
            database_url=url,
            use_managed_identity=settings.POSTGRES_USE_MANAGED_IDENTITY,
            pool_size=settings.DATABASE_POOL_SIZE,
            max_overflow=settings.DATABASE_MAX_OVERFLOW,
        )

    msg = (
        f"Unsupported DATABASE_URL scheme: {url!r}.  "
        "Expected 'sqlite:...' or 'postgresql:...'."
    )
    raise ValueError(msg)


__all__ = [
    "AsyncPostgresStore",
    "AsyncSqliteStore",
    "AsyncStoreBackend",
    "StoreBackendError",
    "StoreConnectionError",
    "build_async_store_backend",
    "close_async_engines",
]
