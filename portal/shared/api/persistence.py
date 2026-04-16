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
import uuid
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Default database path — all stores share one file for simplicity.
_DEFAULT_DB_DIR = Path("./data")
_DEFAULT_DB_NAME = "portal.db"


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

    def update(self, item_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
        """Merge *updates* into an existing item.  Returns the merged item or ``None``."""
        with self._connect() as conn:
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
            conn.commit()

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
        """Bulk-replace every item (legacy compatibility)."""
        with self._connect() as conn:
            conn.execute(f"DELETE FROM [{self.table}]")
            for item in data:
                item_id = str(item.get("id", uuid.uuid4()))
                conn.execute(
                    f"INSERT INTO [{self.table}] (id, data) VALUES (?, ?)",
                    (item_id, json.dumps(item, default=str)),
                )
            conn.commit()

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
# Routers do ``from ..persistence import JsonStore`` — this lets them work
# unchanged.
JsonStore = SqliteStore


# ── Legacy class (kept for reference / emergency rollback) ──────────────────

class _LegacyJsonStore:
    """Original JSON file-based storage.  Retained only for reference.

    DO NOT use in production — it has no file locking and concurrent writes
    will lose data.
    """

    def __init__(self, filename: str, data_dir: str | Path = "./data") -> None:
        self.data_dir = Path(data_dir)
        self.file_path = self.data_dir / filename
        self.data_dir.mkdir(parents=True, exist_ok=True)
        if not self.file_path.exists():
            self._write([])

    def _read(self) -> list[dict[str, Any]]:
        try:
            with self.file_path.open("r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, FileNotFoundError):
            return []

    def _write(self, data: list[dict[str, Any]]) -> None:
        with self.file_path.open("w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, default=str)

    def load(self) -> list[dict[str, Any]]:
        return self._read()

    def save(self, data: list[dict[str, Any]]) -> None:
        self._write(data)

    def add(self, item: dict[str, Any]) -> dict[str, Any]:
        if "id" not in item:
            item["id"] = str(uuid.uuid4())
        data = self._read()
        data.append(item)
        self._write(data)
        return item

    def get(self, item_id: str) -> dict[str, Any] | None:
        for item in self._read():
            if str(item.get("id")) == item_id:
                return item
        return None

    def update(self, item_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
        data = self._read()
        for i, item in enumerate(data):
            if str(item.get("id")) == item_id:
                item.update(updates)
                data[i] = item
                self._write(data)
                return item
        return None

    def delete(self, item_id: str) -> bool:
        data = self._read()
        for i, item in enumerate(data):
            if str(item.get("id")) == item_id:
                data.pop(i)
                self._write(data)
                return True
        return False

    def count(self) -> int:
        return len(self._read())

    def clear(self) -> None:
        self._write([])
