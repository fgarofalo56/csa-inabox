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

This module also arms the active trace function on Arrow Flight's own threads —
see `arm_tracer` below (#2580).
"""
from __future__ import annotations

import functools
import importlib.util
import sys
import threading
from collections.abc import Callable, Iterator
from pathlib import Path
from types import ModuleType
from typing import Any

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


# ── coverage on Arrow Flight's own threads (#2580) ───────────────────────────
#
# `pyarrow.flight` dispatches every server callback on gRPC's C++-managed
# threads. `sys.settrace` is PER-THREAD, and coverage.py only reaches threads it
# knows about — it installs its tracer through `threading.settrace()`, which
# CPython applies to threads started via the `threading` module and to nothing
# else. So `app/flightsql.py` executed in full while coverage reported 26% of
# it, and the file had to be omitted from the gated set to keep the number from
# lying (#2580).
#
# The two fixes the issue proposed both turned out to be dead ends, measured
# rather than assumed (see the PR body for the runs):
#
#   * `COVERAGE_CORE=sysmon` — coverage REFUSES the sys.monitoring core while
#     `branch = true` ("sys.monitoring can't measure branches in this version")
#     and silently falls back to the default core, so the number does not move.
#     Branch coverage under sysmon needs CPython 3.14+; the CI matrix is
#     3.10/3.11/3.12.
#   * `threading.settrace_all_threads()` — 3.12+, and it only reaches thread
#     states that ALREADY exist. gRPC's threads are created after the call, so
#     the number does not move either.
#
# What does work, on every Python in the matrix: arm the tracer FROM INSIDE the
# foreign thread, on entry to each callback. `threading.gettrace()` (3.10+)
# returns the very callback coverage hands to `threading`-module threads;
# handing it to `sys.settrace()` makes this thread start reporting from the next
# frame onward — which is the production callback itself. Nothing about the
# module under test changes: the real handler runs, on the real gRPC thread,
# over the real wire, and is now visible to the instrument.
#
# `tests/loom_duckdb/test_flightsql.py::TestTracingOnFlightThreads` is the guard
# that keeps this honest: it fails if a Flight callback ever runs on an unarmed
# thread again.

#: Attributes wrapped on entry so the tracer is armed before any of
#: `flightsql.py` executes on a gRPC thread. Anything reached only through these
#: is covered transitively; a NEW server callback has to be added here too.
_TRACED_ENTRYPOINTS: tuple[tuple[str, str], ...] = (
    ("LoomFlightSqlServer", "get_flight_info"),
    ("LoomFlightSqlServer", "get_schema"),
    ("LoomFlightSqlServer", "do_get"),
    ("LoomFlightSqlServer", "list_flights"),
    ("LoomFlightSqlServer", "list_actions"),
    ("AuthMiddlewareFactory", "start_call"),
    ("AuthMiddleware", "sending_headers"),
)


def arm_tracer() -> None:
    """Make the CURRENT thread report to whatever tracer is installed.

    A no-op when nothing is tracing (a plain `pytest` run) or when this thread
    is already traced (coverage's own tracer, or a second callback on a pooled
    gRPC thread).
    """
    if sys.gettrace() is not None:
        return
    trace_fn = threading.gettrace()
    if trace_fn is not None:
        sys.settrace(trace_fn)


def _armed(func: Callable[..., Any]) -> Callable[..., Any]:
    @functools.wraps(func)
    def wrapper(*args: Any, **kwargs: Any) -> Any:
        arm_tracer()
        return func(*args, **kwargs)

    return wrapper


@pytest.fixture(autouse=True)
def _arm_flight_threads(monkeypatch: pytest.MonkeyPatch) -> None:
    """Wrap the Flight entrypoints so foreign threads are traced (#2580).

    Deliberately keyed off `sys.modules` rather than calling `load("flightsql")`:
    the Flight tests `importorskip` pyarrow, and this fixture must stay a no-op
    for the suites (and the environments) that never load the module.
    """
    module = sys.modules.get(f"{PACKAGE}.flightsql")
    if module is None:
        return
    for class_name, method_name in _TRACED_ENTRYPOINTS:
        owner = getattr(module, class_name, None)
        if owner is None:
            continue
        # `__dict__` on purpose: only wrap what the module itself defines, so an
        # inherited pyarrow default is never replaced by a Python wrapper.
        original = owner.__dict__.get(method_name)
        if original is None:
            continue
        monkeypatch.setattr(owner, method_name, _armed(original))
