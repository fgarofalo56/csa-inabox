"""Pytest configuration for the streaming test suite.

``pytest_asyncio`` loads via its setuptools entry point (it is a core dev
dependency), so it must NOT be declared in ``pytest_plugins`` here — pytest 8
hard-errors on ``pytest_plugins`` in a non-top-level conftest, which broke
every push-CI run on main after the suite was re-enabled (WS-F2, #2366).
Tests opt in per-function via ``@pytest.mark.asyncio``.
"""

from __future__ import annotations
