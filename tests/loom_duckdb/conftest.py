"""Load the loom-duckdb modules under test straight from their source files.

`apps/loom-duckdb` ships as a container image, not an installable package, so
the tests import its modules by path. The app's modules use RELATIVE imports
(`from .sqlguard import assert_read_only`, `from . import pbcodec`), so a flat
`spec_from_file_location` load is not enough — the modules have to belong to a
package. `load()` therefore registers a synthetic package whose `__path__`
points at `apps/loom-duckdb/app`, and loads every module as a submodule of it.

That keeps ONE copy of each module in `sys.modules`, which matters because
`engine.ENGINE` is a process-wide singleton the Flight server and the HTTP tier
both reach through: a second copy would give the two surfaces two DuckDBs.

`app/main.py` is NOT loaded here — importing it must happen after the test has
set `LOOM_FLIGHT_ENABLED`, so it has its own fixture in `test_http_tier.py`.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

APP_DIR = Path(__file__).resolve().parents[2] / "apps" / "loom-duckdb" / "app"

#: Synthetic package name. Deliberately NOT `app` — the container runs
#: `uvicorn app.main:app` with the app root on `sys.path`, but a bare `app`
#: on the repo-wide test path would be a namespace-package collision waiting
#: to happen.
PACKAGE = "loom_duckdb_app"


def _package() -> ModuleType:
    """The synthetic parent package that makes the relative imports resolve."""
    pkg = sys.modules.get(PACKAGE)
    if pkg is None:
        pkg = ModuleType(PACKAGE)
        pkg.__path__ = [str(APP_DIR)]
        pkg.__package__ = PACKAGE
        sys.modules[PACKAGE] = pkg
    return pkg


def load(name: str) -> ModuleType:
    """Import `apps/loom-duckdb/app/<name>.py` as `loom_duckdb_app.<name>`."""
    key = f"{PACKAGE}.{name}"
    cached = sys.modules.get(key)
    if cached is not None:
        return cached
    parent = _package()
    spec = importlib.util.spec_from_file_location(key, APP_DIR / f"{name}.py")
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[key] = module
    setattr(parent, name, module)
    spec.loader.exec_module(module)
    return module
