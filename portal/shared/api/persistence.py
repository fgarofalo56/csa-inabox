"""
Lightweight JSON-file-based persistence utility.

Provides a simple JsonStore class for persisting data structures to JSON files,
replacing in-memory stubs with functional persistence without requiring a database.
"""

from __future__ import annotations

import json
import logging
import uuid
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class JsonStore:
    """JSON file-based storage with basic CRUD operations."""

    def __init__(self, filename: str, data_dir: str | Path = "./data") -> None:
        """Initialize JsonStore.

        Args:
            filename: JSON filename (e.g., "access_requests.json")
            data_dir: Directory to store JSON files (default "./data")
        """
        self.data_dir = Path(data_dir)
        self.file_path = self.data_dir / filename

        # Ensure data directory exists
        self.data_dir.mkdir(parents=True, exist_ok=True)

        # Initialize file if it doesn't exist
        if not self.file_path.exists():
            self._write([])
            logger.info(f"Created new JSON store: {self.file_path}")

    def _read(self) -> list[dict[str, Any]]:
        """Read raw data from JSON file."""
        try:
            with self.file_path.open("r", encoding="utf-8") as f:
                return json.load(f)
        except (json.JSONDecodeError, FileNotFoundError) as e:
            logger.warning(f"Error reading {self.file_path}: {e}. Returning empty list.")
            return []

    def _write(self, data: list[dict[str, Any]]) -> None:
        """Write data to JSON file."""
        try:
            with self.file_path.open("w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, default=str)
        except Exception as e:
            logger.error(f"Error writing to {self.file_path}: {e}")
            raise

    def load(self) -> list[dict[str, Any]]:
        """Load all records from the JSON file."""
        return self._read()

    def save(self, data: list[dict[str, Any]]) -> None:
        """Save all records to the JSON file."""
        self._write(data)

    def add(self, item: dict[str, Any]) -> dict[str, Any]:
        """Add a new item to the store."""
        # Ensure item has an ID
        if "id" not in item:
            item["id"] = str(uuid.uuid4())

        data = self._read()
        data.append(item)
        self._write(data)
        logger.debug(f"Added item with ID {item['id']} to {self.file_path}")
        return item

    def get(self, item_id: str) -> dict[str, Any] | None:
        """Get a single item by ID."""
        data = self._read()
        for item in data:
            if str(item.get("id")) == item_id:
                return item
        return None

    def update(self, item_id: str, updates: dict[str, Any]) -> dict[str, Any] | None:
        """Update an existing item by ID."""
        data = self._read()
        for i, item in enumerate(data):
            if str(item.get("id")) == item_id:
                # Update the item with new values
                item.update(updates)
                data[i] = item
                self._write(data)
                logger.debug(f"Updated item {item_id} in {self.file_path}")
                return item
        return None

    def delete(self, item_id: str) -> bool:
        """Delete an item by ID. Returns True if deleted, False if not found."""
        data = self._read()
        for i, item in enumerate(data):
            if str(item.get("id")) == item_id:
                data.pop(i)
                self._write(data)
                logger.debug(f"Deleted item {item_id} from {self.file_path}")
                return True
        return False

    def count(self) -> int:
        """Return the number of items in the store."""
        return len(self._read())

    def clear(self) -> None:
        """Clear all items from the store."""
        self._write([])
        logger.info(f"Cleared all items from {self.file_path}")
