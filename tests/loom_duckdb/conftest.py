"""Load the loom-duckdb modules under test straight from their source files.

`apps/loom-duckdb` ships as a container image, not an installable package, so
the tests import the pure-Python modules (no duckdb / pyarrow needed) by path.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

APP_DIR = Path(__file__).resolve().parents[2] / "apps" / "loom-duckdb" / "app"


def load(name: str) -> ModuleType:
    """Import `apps/loom-duckdb/app/<name>.py` as a standalone module."""
    key = f"loom_duckdb_{name}"
    if key in sys.modules:
        return sys.modules[key]
    spec = importlib.util.spec_from_file_location(key, APP_DIR / f"{name}.py")
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[key] = module
    spec.loader.exec_module(module)
    return module
