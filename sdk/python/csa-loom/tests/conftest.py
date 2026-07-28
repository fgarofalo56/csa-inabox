"""Shared fixtures.

The stub transport itself lives in :mod:`csa_loom.testing` (it is a supported
part of the package, not a test-only helper), so these fixtures are thin.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from csa_loom import LoomClient
from csa_loom.testing import StubTransport

#: sdk/openapi.json — the document both SDKs are generated from.
SPEC_PATH = Path(__file__).resolve().parents[3] / "openapi.json"


@pytest.fixture
def transport() -> StubTransport:
    return StubTransport()


@pytest.fixture
def client(transport: StubTransport) -> LoomClient:
    return LoomClient("https://loom.example.gov", token="loom_pat_abc_secret", transport=transport)


@pytest.fixture(scope="session")
def spec() -> dict[str, Any]:
    """The committed OpenAPI document (``sdk/openapi.json``)."""
    loaded: dict[str, Any] = json.loads(SPEC_PATH.read_text(encoding="utf-8"))
    return loaded
