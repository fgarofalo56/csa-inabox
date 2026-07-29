"""UDF runtime host — pushed source is only executed for an authenticated caller.

Issue #2653 / CodeQL py/code-injection on
``platform/fiab/bicep/modules/admin-plane/udf-runtime/app.py``.

Executing the request body IS the product here (it is a Python function host),
so the fix is not "remove exec". The defect was that the ``X-Udf-Source-B64``
path was UNAUTHENTICATED: every workload on the shared Container Apps
environment could POST Python and have it executed inside a container that also
carried the Console's managed identity. The host now requires the deployment's
shared key, and fails CLOSED when no key is configured.

These tests import the real host module and drive the real handler method with a
fake socket, so they exercise the shipped code — not a copy of it.
"""
from __future__ import annotations

import base64
import importlib.util
import io
import json
import os
import sys
from collections.abc import Iterator
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
from _pytest.monkeypatch import MonkeyPatch

APP_PY = (
    Path(__file__).resolve().parents[2]
    / "platform"
    / "fiab"
    / "bicep"
    / "modules"
    / "admin-plane"
    / "udf-runtime"
    / "app.py"
)

SAMPLE_SOURCE = (
    "import fabric.functions as fn\n"
    "udf = fn.UserDataFunctions()\n"
    "\n"
    "@udf.function()\n"
    "def pushed(x: int = 1) -> dict:\n"
    "    return {'pushed': x}\n"
)


def _load_host(monkeypatch: MonkeyPatch, host_key: str | None) -> ModuleType:
    """Import udf-runtime/app.py fresh with LOOM_UDF_HOST_KEY set (or unset)."""
    if host_key is None:
        monkeypatch.delenv("LOOM_UDF_HOST_KEY", raising=False)
    else:
        monkeypatch.setenv("LOOM_UDF_HOST_KEY", host_key)
    # The host inserts its own directory on sys.path to import the fabric shim,
    # whose file is named fabric_functions.py in-repo and fabric/functions.py at
    # runtime; make the shim importable as `fabric.functions` for the test.
    pkg_dir = APP_PY.parent
    monkeypatch.syspath_prepend(str(pkg_dir))
    shim_spec = importlib.util.spec_from_file_location(
        "fabric.functions", pkg_dir / "fabric_functions.py"
    )
    assert shim_spec is not None
    assert shim_spec.loader is not None
    fabric_pkg = importlib.util.module_from_spec(
        importlib.util.spec_from_loader("fabric", loader=None)  # type: ignore[arg-type]
    )
    fabric_pkg.__path__ = []  # namespace-ish package
    sys.modules["fabric"] = fabric_pkg
    shim = importlib.util.module_from_spec(shim_spec)
    sys.modules["fabric.functions"] = shim
    shim_spec.loader.exec_module(shim)
    fabric_pkg.functions = shim  # type: ignore[attr-defined]

    spec = importlib.util.spec_from_file_location("loom_udf_host_under_test", APP_PY)
    assert spec is not None
    assert spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class _Recorder:
    """Minimal stand-in for BaseHTTPRequestHandler's response plumbing."""

    def __init__(self) -> None:
        self.code: int | None = None
        self.body: Any = None


def _post(mod: ModuleType, path: str, headers: dict[str, str], payload: dict[str, Any]) -> _Recorder:
    handler = mod.Handler.__new__(mod.Handler)
    rec = _Recorder()

    def _send(code: int, obj: Any) -> None:
        rec.code = code
        rec.body = obj

    handler._send = _send
    handler.path = path
    raw = json.dumps(payload).encode("utf-8")
    lowered = {k.lower(): v for k, v in headers.items()}
    lowered["content-length"] = str(len(raw))
    handler.headers = lowered  # dict.get(name) matches the header API used
    handler.rfile = io.BytesIO(raw)
    handler.do_POST()
    return rec


@pytest.fixture(autouse=True)
def _clean_modules() -> Iterator[None]:
    yield
    for name in ("fabric", "fabric.functions", "loom_udf_host_under_test"):
        sys.modules.pop(name, None)


def test_pushed_source_without_key_is_refused(monkeypatch: MonkeyPatch) -> None:
    """The exact CodeQL sink: attacker-supplied Python must not be exec'd."""
    mod = _load_host(monkeypatch, "THE-DEPLOYMENT-KEY")
    b64 = base64.b64encode(SAMPLE_SOURCE.encode("utf-8")).decode("ascii")

    rec = _post(mod, "/api/pushed", {"x-udf-source-b64": b64}, {"x": 5})

    assert rec.code == 401
    assert "x-loom-udf-key" in json.dumps(rec.body).lower()


def test_pushed_source_with_wrong_key_is_refused(monkeypatch: MonkeyPatch) -> None:
    mod = _load_host(monkeypatch, "THE-DEPLOYMENT-KEY")
    b64 = base64.b64encode(SAMPLE_SOURCE.encode("utf-8")).decode("ascii")

    rec = _post(
        mod,
        "/api/pushed",
        {"x-udf-source-b64": b64, "x-loom-udf-key": "not-the-key"},
        {"x": 5},
    )

    assert rec.code == 401


def test_pushed_source_is_refused_when_no_key_is_configured(monkeypatch: MonkeyPatch) -> None:
    """FAIL CLOSED: an un-keyed deployment must not be talked into running code."""
    mod = _load_host(monkeypatch, None)
    b64 = base64.b64encode(SAMPLE_SOURCE.encode("utf-8")).decode("ascii")

    rec = _post(mod, "/api/pushed", {"x-udf-source-b64": b64, "x-loom-udf-key": ""}, {"x": 5})

    assert rec.code == 401


def test_pushed_source_with_the_right_key_still_executes(monkeypatch: MonkeyPatch) -> None:
    """The feature is preserved — the Loom BFF holds the key and runs real code."""
    mod = _load_host(monkeypatch, "THE-DEPLOYMENT-KEY")
    b64 = base64.b64encode(SAMPLE_SOURCE.encode("utf-8")).decode("ascii")

    rec = _post(
        mod,
        "/api/pushed",
        {"x-udf-source-b64": b64, "x-loom-udf-key": "THE-DEPLOYMENT-KEY"},
        {"x": 7},
    )

    assert rec.code == 200
    assert rec.body == {"pushed": 7}


def test_source_push_allowed_is_constant_time_and_never_empty_key(monkeypatch: MonkeyPatch) -> None:
    mod = _load_host(monkeypatch, None)
    assert mod.source_push_allowed("") is False
    assert mod.source_push_allowed(None) is False
    assert mod.source_push_allowed("anything") is False


def test_bundled_functions_still_invoke_without_any_key(monkeypatch: MonkeyPatch) -> None:
    """No regression: the bundled/default functions need no key at all."""
    mod = _load_host(monkeypatch, None)
    mod.FUNCS = {"add": lambda a=0, b=0: {"sum": a + b}}  # type: ignore[attr-defined]

    rec = _post(mod, "/api/add", {}, {"a": 2, "b": 3})

    assert rec.code == 200
    assert rec.body == {"sum": 5}


def test_udf_runtime_container_app_has_no_managed_identity() -> None:
    """The sandbox that runs tenant Python must hold no platform credential."""
    bicep = (APP_PY.parent.parent / "udf-runtime.bicep").read_text(encoding="utf-8")
    assert "userAssignedIdentities" not in bicep
    assert "LOOM_UDF_HOST_KEY" in bicep


def test_env_var_name_is_read_by_the_host() -> None:
    src = APP_PY.read_text(encoding="utf-8")
    assert "LOOM_UDF_HOST_KEY" in src
    assert "hmac.compare_digest" in src
    assert os.path.basename(str(APP_PY)) == "app.py"
