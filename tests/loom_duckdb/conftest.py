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

The synthetic package is torn down at the end of the session (`_unload_app_package`)
so `sys.modules` is not left carrying repo-wide entries for a container app.
"""
from __future__ import annotations

import importlib.util
import sys
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType

import pytest

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
    # The module has to be in `sys.modules` BEFORE `exec_module` (that is what
    # makes its own relative imports resolvable, and it is what the import
    # machinery itself does). But if execution raises — a missing `duckdb`
    # wheel, a syntax error, an env-dependent import — the half-initialized
    # module must NOT stay cached, or every later `load(name)` silently hands
    # back a broken object and the real error is only ever seen once.
    sys.modules[key] = module
    setattr(parent, name, module)
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(key, None)
        if getattr(parent, name, None) is module:
            delattr(parent, name)
        raise
    return module


@pytest.fixture(scope="session", autouse=True)
def _unload_app_package() -> Iterator[None]:
    """Drop the synthetic package at session end.

    `load()` registers `loom_duckdb_app[.<mod>]` in the process-wide
    `sys.modules`; without this the entries outlive these tests and are visible
    to every other suite in the same session.
    """
    yield
    for key in [k for k in sys.modules if k == PACKAGE or k.startswith(f"{PACKAGE}.")]:
        del sys.modules[key]
