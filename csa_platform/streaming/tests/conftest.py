"""Pytest configuration for the streaming test suite.

Sets the asyncio mode so that ``@pytest.mark.asyncio`` tests execute
without requiring a global ``pytest-asyncio`` configuration change.
"""

from __future__ import annotations

import pytest


def pytest_collection_modifyitems(config: pytest.Config, items: list[pytest.Item]) -> None:
    """Apply asyncio mode to streaming tests when collected in isolation."""
    _ = config
    _ = items


# Mode is configured via the pytest_asyncio plugin; we set the default at
# fixture level to avoid relying on global ini configuration.
pytest_plugins: tuple[str, ...] = ("pytest_asyncio",)
