"""
SQLite-backed persistence utility with WAL mode for concurrent access.

Replaces the original JSON-file persistence with a thread-safe, atomic SQLite
backend.  Each store maps to a table in a shared database; rows are stored as
JSON blobs so the interface stays schemaless.

The public API is identical to the former ``JsonStore`` so every router works
as a drop-in replacement.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import threading
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

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


def _table_name_from_filename(filename: str) -> str:
    """Derive a safe SQLite table name from a legacy JSON filename.

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

        self._ensure_table()
        self._maybe_migrate_json()

    # ── connection helpers ──────────────────────────────────────────────

    def _connect(self) -> sqlite3.Connection:
        """Return a new connection configured for concurrent access."""
        conn = sqlite3.connect(
            str(self.db_path),
            check_same_thread=False,
            timeout=30,
        )
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA synchronous=NORMAL")
        return conn

    @contextmanager
    def _transact_immediate(self) -> Iterator[sqlite3.Connection]:
        """Yield a connection running a single ``BEGIN IMMEDIATE`` txn.

        ``BEGIN IMMEDIATE`` acquires SQLite's RESERVED lock up-front, so
        any concurrent writer is either queued (up to ``busy_timeout``)
        or fails with ``SQLITE_BUSY`` — preventing the
        SELECT-modify-UPDATE race that a plain transaction (which
        deferred the lock until the first write) allows.

        Combined with the process-wide :data:`_WRITE_LOCK`, this gives us
        strong serializable semantics for read-modify-write cycles even
        under concurrent FastAPI worker threads.  Reads outside of such
        cycles continue to use plain :meth:`_connect` for throughput —
        SQLite WAL lets them proceed without taking the write lock.
        """
        with _WRITE_LOCK, self._connect() as conn:
            try:
                conn.execute("BEGIN IMMEDIATE")
                yield conn
                conn.commit()
            except Exception:
                conn.rollback()
                raise

    # ── schema bootstrap ────────────────────────────────────────────────

    def _ensure_table(self) -> None:
        """Create the backing table if it does not yet exist."""
        with self._connect() as conn:
            conn.execute(
                f"""
                CREATE TABLE IF NOT EXISTS [{self.table}] (
                    id   TEXT PRIMARY KEY,
                    data TEXT NOT NULL
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
        with self._connect() as conn:
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

        with self._connect() as conn:
            conn.execute(
                f"INSERT OR REPLACE INTO [{self.table}] (id, data) VALUES (?, ?)",
                (item_id, json.dumps(item, default=str)),
            )
            conn.commit()

        logger.debug("Added item %s to [%s]", item_id, self.table)
        return item

    def get(self, item_id: str) -> dict[str, Any] | None:
        """Return a single item by its ``id``, or ``None``."""
        with self._connect() as conn:
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
        mutator: Any,
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
        with self._connect() as conn:
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
        with self._connect() as conn:
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

    def query(self, **filters: Any) -> list[dict[str, Any]]:
        """Filter items by top-level field values.

        This performs a full table scan with JSON extraction.  Fine for the
        demo-scale data this portal deals with.
        """
        if not filters:
            return self.list()

        items = self.list()
        results = []
        for item in items:
            if all(str(item.get(k)) == str(v) for k, v in filters.items()):
                results.append(item)
        return results

    def count(self) -> int:
        """Return the number of items in the store."""
        with self._connect() as conn:
            row = conn.execute(
                f"SELECT COUNT(*) FROM [{self.table}]"
            ).fetchone()
        return row[0]

    def clear(self) -> None:
        """Remove all items from this store's table."""
        with self._connect() as conn:
            conn.execute(f"DELETE FROM [{self.table}]")
            conn.commit()
        logger.info("Cleared all items from [%s]", self.table)


# ── backward-compatible alias ───────────────────────────────────────────────
# ``SqliteStore`` is the canonical name.  ``JsonStore`` is kept only for
# external callers that have not yet been updated; do not use it in new code.
JsonStore = SqliteStore
