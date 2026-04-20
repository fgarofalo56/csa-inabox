"""
Store-backend abstraction for portal persistence (CSA-0046).

.. deprecated:: 0.2.0
    The sync :class:`StoreBackend` / :class:`SqliteStore` pair in this
    module is a transitional compatibility layer.  New code should
    prefer :mod:`portal.shared.api.persistence_async` which is the
    canonical persistence surface per ADR-0016.  The sync layer will
    be removed in the next minor release (CSA-0046 v3).

This module defines the :class:`StoreBackend` ``Protocol`` that every
persistence implementation must satisfy, and ships the historical
SQLite-based implementation (:class:`SqliteStore`) that remains the
default for local / dev / demo environments.

The Protocol mirrors the public surface the routers already depend on:
``add``, ``get``, ``list`` / ``load``, ``update``, ``update_atomic``,
``delete``, ``count``, ``clear``, ``save``, ``query``.  Any new backend
(Postgres in :mod:`portal.shared.api.persistence_postgres`) is a drop-in
replacement without changes to router call-sites.

Construction of the backend at runtime is centralised in
:func:`portal.shared.api.persistence_factory.build_store_backend` which
consults :mod:`portal.shared.api.config` to select between SQLite
(``sqlite://``) and PostgreSQL (``postgresql://``) URLs.  SQLite remains
the default when ``DATABASE_URL`` is unset so no existing dev workflow
breaks.
"""

from __future__ import annotations

import json
import logging
import re
import sqlite3
import threading
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

logger = logging.getLogger(__name__)

# Default database path — all stores share one file for simplicity.
_DEFAULT_DB_DIR = Path("./data")
_DEFAULT_DB_NAME = "portal.db"

# Global process-wide lock serializing read-modify-write sequences
# (e.g. ``update()``, ``save()``).  SQLite WAL mode permits concurrent
# readers + one writer at the OS level; this lock prevents two Python
# threads from interleaving a SELECT-merge-UPDATE pair and producing a
# lost-update, which WAL alone does not protect against (each connection
# gets its own snapshot).
#
# Single-statement operations (``add``, ``get``, ``delete``, ``list``)
# do not take this lock — SQLite atomicity on a single statement is
# sufficient.  The lock is intentionally process-global rather than
# per-``SqliteStore`` so that cross-table transactions (future) compose.
_WRITE_LOCK = threading.RLock()


# ── Protocol ────────────────────────────────────────────────────────────────


@runtime_checkable
class StoreBackend(Protocol):
    """Common persistence contract shared by SQLite and Postgres backends.

    Records are untyped dictionaries with at minimum an ``id`` key; every
    method is synchronous so that the existing FastAPI routers can call
    through without becoming ``await``-heavy.  Backends that use async
    I/O drivers wrap the async engine in a sync facade.

    The methods mirror the historical ``SqliteStore`` surface one-for-one;
    any backend satisfying this protocol is a drop-in replacement.
    """

    def add(self, item: dict[str, Any]) -> dict[str, Any]:
        """Insert or replace a record.  Generates an ``id`` when absent."""
        ...

    def get(self, item_id: str) -> dict[str, Any] | None:
        """Return a record by ``id`` or ``None``."""
        ...

    def list(self) -> list[dict[str, Any]]:
        """Return all records in insertion order."""
        ...

    def load(self) -> list[dict[str, Any]]:
        """Alias for :meth:`list` preserved for legacy callers."""
        ...

    def update(
        self,
        item_id: str,
        updates: dict[str, Any],
    ) -> dict[str, Any] | None:
        """Shallow-merge ``updates`` into an existing record."""
        ...

    def update_atomic(
        self,
        item_id: str,
        mutator: Callable[[dict[str, Any]], dict[str, Any]],
    ) -> dict[str, Any] | None:
        """Read-modify-write under a single transaction."""
        ...

    def delete(self, item_id: str) -> bool:
        """Delete a record by ``id``.  Returns ``True`` if removed."""
        ...

    def count(self) -> int:
        """Return total number of records in the store."""
        ...

    def clear(self) -> None:
        """Remove all records from the store."""
        ...

    def save(self, data: list[dict[str, Any]]) -> None:
        """Bulk-replace every record (legacy API, single atomic txn)."""
        ...

    def query(self, **filters: Any) -> list[dict[str, Any]]:
        """Filter records by top-level field equality."""
        ...


# ── SQLite helpers ──────────────────────────────────────────────────────────


def _open_connection(db_path: str | Path) -> sqlite3.Connection:
    """Open a SQLite connection and set performance PRAGMAs once."""
    conn = sqlite3.connect(
        str(db_path),
        check_same_thread=False,
        timeout=30,
    )
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


def _table_name_from_filename(filename: str) -> str:
    """Derive a safe SQLite / Postgres table name from a legacy JSON filename.

    ``"sources.json"``  → ``"sources"``
    ``"pipeline_runs.json"`` → ``"pipeline_runs"``
    ``"my-store"`` → ``"my_store"``
    """
    name = filename.removesuffix(".json").replace("-", "_").replace(".", "_")
    # Ensure it starts with a letter or underscore
    if name and not (name[0].isalpha() or name[0] == "_"):
        name = f"_{name}"
    return name


class SqliteStore:
    """SQLite-backed storage with the same CRUD interface as the legacy JsonStore.

    Each item is persisted as a JSON blob in a ``data`` TEXT column alongside
    a ``rowid``-style ``id`` TEXT primary key extracted from the item itself.

    Parameters
    ----------
    filename:
        Logical name of the store.  By convention this was a JSON filename
        (e.g. ``"sources.json"``); the ``.json`` suffix is stripped to produce
        the underlying table name.
    data_dir:
        Directory that holds the SQLite database file.  Created automatically
        if it does not exist.
    db_name:
        SQLite database filename inside *data_dir*.
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

        # Legacy JSON path — used only for one-time migration
        self._legacy_json_path = self.data_dir / filename

        # Cached per-instance connection.  PRAGMAs are set once here so
        # every subsequent operation reuses the same connection without
        # re-issuing PRAGMA statements.  uvicorn runs a single process with
        # asyncio, so one connection per store instance is sufficient.
        # _WRITE_LOCK serialises write paths as before.
        self._conn: sqlite3.Connection = _open_connection(self.db_path)

        self._ensure_table()
        self._maybe_migrate_json()

    # ── connection helpers ──────────────────────────────────────────────

    def _connect(self) -> sqlite3.Connection:
        """Return the cached per-instance connection.

        PRAGMAs were already applied during ``__init__`` via
        :func:`_open_connection`, so no repeated PRAGMA cost is incurred.
        """
        return self._conn

    @contextmanager
    def _transact_immediate(self) -> Iterator[sqlite3.Connection]:
        """Yield the cached connection running a single ``BEGIN IMMEDIATE`` txn.

        ``BEGIN IMMEDIATE`` acquires SQLite's RESERVED lock up-front, so
        any concurrent writer is either queued (up to ``busy_timeout``)
        or fails with ``SQLITE_BUSY`` — preventing the
        SELECT-modify-UPDATE race that a plain transaction (which
        deferred the lock until the first write) allows.

        Combined with the process-wide :data:`_WRITE_LOCK`, this gives us
        strong serializable semantics for read-modify-write cycles even
        under concurrent FastAPI worker threads.  Reads outside of such
        cycles continue to use :meth:`_connect` for throughput —
        SQLite WAL lets them proceed without taking the write lock.
        """
        conn = self._connect()
        with _WRITE_LOCK:
            try:
                conn.execute("BEGIN IMMEDIATE")
                yield conn
                conn.commit()
            except Exception:
                conn.rollback()
                raise

    # ── schema bootstrap ────────────────────────────────────────────────

    def _ensure_table(self) -> None:
        """Create the backing table if it does not yet exist.

        The ``CHECK(json_valid(data))`` constraint lets SQLite reject
        malformed JSON blobs at the storage layer before they propagate
        through the application.
        """
        conn = self._connect()
        conn.execute(
            f"""
            CREATE TABLE IF NOT EXISTS [{self.table}] (
                id   TEXT PRIMARY KEY,
                data TEXT NOT NULL CHECK(json_valid(data))
            )
            """
        )
        conn.commit()
        logger.debug("Ensured table '%s' exists in %s", self.table, self.db_path)

    # ── legacy JSON migration ───────────────────────────────────────────

    def _maybe_migrate_json(self) -> None:
        """One-time import of a legacy JSON file into SQLite."""
        if not self._legacy_json_path.exists():
            return

        try:
            with self._legacy_json_path.open("r", encoding="utf-8") as fh:
                items: list[dict[str, Any]] = json.load(fh)
        except (json.JSONDecodeError, FileNotFoundError):
            return

        if not items:
            return

        # Only migrate when the table is empty (idempotent)
        conn = self._connect()
        row = conn.execute(
            f"SELECT COUNT(*) FROM [{self.table}]"
        ).fetchone()
        if row[0] > 0:
            return

        for item in items:
            item_id = str(item.get("id", uuid.uuid4()))
            conn.execute(
                f"INSERT OR IGNORE INTO [{self.table}] (id, data) VALUES (?, ?)",
                (item_id, json.dumps(item, default=str)),
            )
        conn.commit()

        logger.info(
            "Migrated %d items from %s → table '%s'",
            len(items),
            self._legacy_json_path,
            self.table,
        )

        # Rename the old file so we don't re-read it
        backup = self._legacy_json_path.with_suffix(".json.bak")
        self._legacy_json_path.rename(backup)
        logger.info("Renamed legacy file to %s", backup)

    # ── public CRUD ─────────────────────────────────────────────────────

    def add(self, item: dict[str, Any]) -> dict[str, Any]:
        """Insert a new item, auto-generating an ``id`` if absent."""
        if "id" not in item:
            item["id"] = str(uuid.uuid4())

        item_id = str(item["id"])

        conn = self._connect()
        conn.execute(
            f"INSERT OR REPLACE INTO [{self.table}] (id, data) VALUES (?, ?)",
            (item_id, json.dumps(item, default=str)),
        )
        conn.commit()

        logger.debug("Added item %s to [%s]", item_id, self.table)
        return item

    def get(self, item_id: str) -> dict[str, Any] | None:
        """Return a single item by its ``id``, or ``None``."""
        conn = self._connect()
        row = conn.execute(
            f"SELECT data FROM [{self.table}] WHERE id = ?",
            (item_id,),
        ).fetchone()
        if row is None:
            return None
        return json.loads(row[0])

    def update_atomic(
        self,
        item_id: str,
        mutator: Callable[[dict[str, Any]], dict[str, Any]],
    ) -> dict[str, Any] | None:
        """Apply a *function* to an existing item inside a single txn.

        Use this whenever the new value depends on the current value
        (counters, lists, conditional toggles).  ``mutator`` is called
        with the current item dict and must return the new item dict —
        it runs under the :data:`_WRITE_LOCK` inside the same
        ``BEGIN IMMEDIATE`` transaction as the SELECT and UPDATE, so
        two concurrent callers cannot clobber each other's reads.

        Returns the updated item, or ``None`` if ``item_id`` is missing.

        Example::

            store.update_atomic(
                "counter",
                lambda x: {**x, "n": x["n"] + 1},
            )
        """
        with self._transact_immediate() as conn:
            row = conn.execute(
                f"SELECT data FROM [{self.table}] WHERE id = ?",
                (item_id,),
            ).fetchone()
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

            conn.execute(
                f"UPDATE [{self.table}] SET data = ? WHERE id = ?",
                (json.dumps(updated, default=str), item_id),
            )

        logger.debug("Atomically updated item %s in [%s]", item_id, self.table)
        return updated

    def update(self, item_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
        """Merge *updates* into an existing item.  Returns the merged item or ``None``.

        The SELECT + UPDATE pair runs inside a single ``BEGIN IMMEDIATE``
        transaction under :data:`_WRITE_LOCK`, so two concurrent
        ``update()`` calls on the same row serialize (no lost updates).

        For updates that depend on the current value (counters, list
        appends), use :meth:`update_atomic` instead — ``updates`` is a
        plain merge and cannot express 'increment by one' safely.
        """
        with self._transact_immediate() as conn:
            row = conn.execute(
                f"SELECT data FROM [{self.table}] WHERE id = ?",
                (item_id,),
            ).fetchone()
            if row is None:
                return None

            item = json.loads(row[0])
            item.update(updates)

            conn.execute(
                f"UPDATE [{self.table}] SET data = ? WHERE id = ?",
                (json.dumps(item, default=str), item_id),
            )

        logger.debug("Updated item %s in [%s]", item_id, self.table)
        return item

    def delete(self, item_id: str) -> bool:
        """Delete an item by ``id``.  Returns ``True`` if a row was removed."""
        conn = self._connect()
        cursor = conn.execute(
            f"DELETE FROM [{self.table}] WHERE id = ?",
            (item_id,),
        )
        conn.commit()
        deleted = cursor.rowcount > 0
        if deleted:
            logger.debug("Deleted item %s from [%s]", item_id, self.table)
        return deleted

    def load(self) -> list[dict[str, Any]]:
        """Return every item in insertion order (alias kept for compatibility)."""
        return self.list()

    def list(self) -> list[dict[str, Any]]:
        """Return all items."""
        conn = self._connect()
        rows = conn.execute(
            f"SELECT data FROM [{self.table}] ORDER BY rowid"
        ).fetchall()
        return [json.loads(r[0]) for r in rows]

    def save(self, data: list[dict[str, Any]]) -> None:
        """Bulk-replace every item (legacy compatibility).

        Runs the ``DELETE`` + ``INSERT``s as a single atomic transaction
        under :data:`_WRITE_LOCK` so a crash mid-save cannot leave the
        table half-deleted.
        """
        with self._transact_immediate() as conn:
            conn.execute(f"DELETE FROM [{self.table}]")
            for item in data:
                item_id = str(item.get("id", uuid.uuid4()))
                conn.execute(
                    f"INSERT INTO [{self.table}] (id, data) VALUES (?, ?)",
                    (item_id, json.dumps(item, default=str)),
                )

    # Pattern for safe filter keys — prevents SQL injection via key names.
    _SAFE_KEY = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")

    def query(self, **filters: Any) -> list[dict[str, Any]]:
        """Filter items by top-level field values using SQLite ``json_extract``.

        Filtering is pushed into the WHERE clause so only matching rows are
        transferred from the storage engine to Python.  Values are compared
        without ``str()`` coercion so that integer fields (e.g. status codes)
        match correctly against integer filter arguments.

        Filter keys must be simple identifiers (letters, digits, underscores)
        to prevent SQL injection through crafted key names (SEC-0001).
        """
        if not filters:
            return self.list()

        for key in filters:
            if not self._SAFE_KEY.match(key):
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
        conn = self._connect()
        rows = conn.execute(sql, params).fetchall()
        return [json.loads(r[0]) for r in rows]

    def count(self) -> int:
        """Return the number of items in the store."""
        conn = self._connect()
        row = conn.execute(
            f"SELECT COUNT(*) FROM [{self.table}]"
        ).fetchone()
        return row[0]

    def clear(self) -> None:
        """Remove all items from this store's table."""
        conn = self._connect()
        conn.execute(f"DELETE FROM [{self.table}]")
        conn.commit()
        logger.info("Cleared all items from [%s]", self.table)


__all__ = [
    "SqliteStore",
    "StoreBackend",
    "_table_name_from_filename",
]
