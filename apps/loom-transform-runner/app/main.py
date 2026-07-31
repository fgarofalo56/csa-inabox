"""CSA Loom — transform runner Container App (N4).

ONE runtime that executes a Console-generated transformation project with
EITHER engine:

  • `dbt`    (DEFAULT, for continuity — the existing dbt ecosystem, adapters,
              packages, and the `target/manifest.json` artifact the Console's
              L6 lineage parser already consumes), or
  • `sqlmesh` (virtual data environments + Terraform-style plan/apply +
              column-level model diff).

Endpoints
---------
  GET  /health                     → liveness/readiness
  GET  /capabilities               → which engines + adapters this image carries
  POST /plan          { backend, files, environment?, … }  → impact preview (no writes)
  POST /apply         { backend, files, environment?, … }  → execute the plan
  POST /run           { backend, files, commands?/environment? }  → materialize
  POST /diff          { files, model, sourceEnvironment, targetEnvironment }
  POST /environments  { files, … }  → the real virtual environments in state

Auth to every data backend is the container's user-assigned MANAGED IDENTITY
(AZURE_CLIENT_ID injected by bicep). No passwords, no storage keys, no secrets
in app settings. Internal ingress only — the Console reaches it over the
Container Apps VNet.
"""
from __future__ import annotations

import tempfile
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI
from pydantic import BaseModel

from . import dbt_engine, sqlmesh_engine
from .project import GeneratedFile, write_project

app = FastAPI(title="loom-transform-runner", version="1.0.0")

Backend = Literal["dbt", "sqlmesh"]

# The dbt adapters this image is BUILT to carry. `fabric` is present but is
# NEVER the default — it is only reachable when a project explicitly selects it
# (no-fabric-dependency.md); synapse / databricks / duckdb are the Azure-native
# and sovereign-OSS defaults.
#
# This is the DECLARED set, not the reported one. `/capabilities` probes each
# module for real (see `_installed_dbt_adapters`) so that if a pin change ever
# drops an adapter, the endpoint says so instead of advertising a dead code
# path. The endpoint's whole job is an honest capability report, and a
# hardcoded list cannot be honest about what the image actually installed.
EXPECTED_DBT_ADAPTERS = {
    "synapse": "dbt.adapters.synapse",
    "databricks": "dbt.adapters.databricks",
    "duckdb": "dbt.adapters.duckdb",
    "fabric": "dbt.adapters.fabric",
}


def _installed_dbt_adapters() -> tuple[list[str], list[str]]:
    """(importable, missing) — probed, never asserted."""
    import importlib.util  # noqa: PLC0415

    installed, missing = [], []
    for name, module in EXPECTED_DBT_ADAPTERS.items():
        try:
            found = importlib.util.find_spec(module) is not None
        except (ImportError, ValueError):
            found = False
        (installed if found else missing).append(name)
    return installed, missing


class TransformRequest(BaseModel):
    files: list[GeneratedFile]
    backend: Backend = "dbt"
    """SQLMesh: the virtual environment to plan/apply/run against."""
    environment: str = "dev"
    """SQLMesh gateway name (config.yaml key). None → the project default."""
    gateway: str | None = None
    """dbt: the command list the Console built from its checkbox picker."""
    commands: list[str] = []
    """Per-run env the runner injects before invoking the engine."""
    env: dict[str, str] = {}
    """dbt plan only: the deployed-state manifest/catalog to diff against."""
    previousManifest: dict[str, Any] | None = None
    previousCatalog: dict[str, Any] | None = None


class DiffRequest(BaseModel):
    files: list[GeneratedFile]
    model: str
    sourceEnvironment: str = "dev"
    targetEnvironment: str = "prod"
    gateway: str | None = None
    env: dict[str, str] = {}


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.get("/capabilities")
def capabilities() -> dict[str, Any]:
    """Honest capability report — what this image can actually execute."""
    engines: dict[str, Any] = {}
    try:
        import dbt.version  # noqa: PLC0415

        installed, missing = _installed_dbt_adapters()
        engines["dbt"] = {"available": True, "version": dbt.version.get_installed_version().to_version_string(),
                          "adapters": installed}
        if missing:
            # Honest gate, not a silent omission: the image was built without an
            # adapter it is supposed to carry.
            engines["dbt"]["missingAdapters"] = missing
            engines["dbt"]["note"] = (
                "This image is missing dbt adapter(s) it is expected to bundle: "
                f"{', '.join(missing)}. Projects targeting them will fail. Check "
                "apps/loom-transform-runner/requirements.txt."
            )
    except Exception as exc:  # noqa: BLE001
        engines["dbt"] = {"available": False, "error": str(exc)}
    try:
        import sqlmesh  # noqa: PLC0415

        engines["sqlmesh"] = {"available": True, "version": getattr(sqlmesh, "__version__", "unknown")}
    except Exception as exc:  # noqa: BLE001
        engines["sqlmesh"] = {"available": False, "error": str(exc)}
    return {"ok": True, "engines": engines, "defaultBackend": "dbt"}


def _materialize(req: TransformRequest | DiffRequest, tmp: str) -> Path | dict[str, Any]:
    project_dir = Path(tmp)
    try:
        write_project(project_dir, req.files)
    except ValueError as e:
        return {"ok": False, "exitCode": 2, "log": str(e), "error": str(e)}
    return project_dir


def _redact(text: str, env: dict[str, str] | None) -> str:
    """Blank out per-run env VALUES that appear verbatim in an engine message.

    `TransformRequest.env` is "per-run env the runner injects before invoking the
    engine" — in practice warehouse credentials and DSNs. dbt and SQLMesh quote
    the connection they failed on, so a connection error can echo one straight
    back through the failure envelope (CodeQL py/stack-trace-exposure).

    Redacting the VALUE, not the whole message, keeps `no-vaporware.md`'s
    requirement that the real engine error reaches the user — an opaque
    "transform failed" is exactly the dishonest error that rule forbids.

    Short values are skipped: a 1-3 char env value (`db`, `1`, `s`) occurs inside
    ordinary words, and blanking every occurrence would shred the message while
    protecting nothing that is secret at that length.
    """
    if not env:
        return text
    out = text
    for value in env.values():
        v = (value or "").strip()
        if len(v) > 3 and v in out:
            out = out.replace(v, "[redacted]")
    return out


def _fail(exc: Exception, action: str, env: dict[str, str] | None = None) -> dict[str, Any]:
    """Honest failure envelope — the engine's real message, never a fake plan.

    The message is redacted against the caller-supplied env first: it is the
    engine's real text, minus any credential the caller handed us to inject.
    """
    msg = _redact(str(exc), env)
    return {"ok": False, "exitCode": 1, "error": f"{action} failed: {msg}", "log": msg}


@app.post("/plan")
def plan(req: TransformRequest) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="loom-transform-") as tmp:
        project_dir = _materialize(req, tmp)
        if isinstance(project_dir, dict):
            return project_dir
        try:
            if req.backend == "sqlmesh":
                return sqlmesh_engine.plan(project_dir, req.environment, req.gateway, req.env)
            return dbt_engine.plan(project_dir, req.env, req.previousManifest, req.previousCatalog)
        except Exception as exc:  # noqa: BLE001
            return _fail(exc, f"{req.backend} plan", req.env)


@app.post("/apply")
def apply(req: TransformRequest) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="loom-transform-") as tmp:
        project_dir = _materialize(req, tmp)
        if isinstance(project_dir, dict):
            return project_dir
        try:
            if req.backend == "sqlmesh":
                return sqlmesh_engine.apply(project_dir, req.environment, req.gateway, req.env)
            # dbt has no view-swap apply: applying a dbt plan IS `dbt build`,
            # which materializes the modified models and their downstream.
            commands = req.commands or ["dbt deps", "dbt build"]
            return dbt_engine.execute(project_dir, commands, req.env)
        except Exception as exc:  # noqa: BLE001
            return _fail(exc, f"{req.backend} apply", req.env)


@app.post("/run")
def run(req: TransformRequest) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="loom-transform-") as tmp:
        project_dir = _materialize(req, tmp)
        if isinstance(project_dir, dict):
            return project_dir
        try:
            if req.backend == "sqlmesh":
                return sqlmesh_engine.run(project_dir, req.environment, req.gateway, req.env)
            commands = req.commands or ["dbt deps", "dbt build"]
            return dbt_engine.execute(project_dir, commands, req.env)
        except Exception as exc:  # noqa: BLE001
            return _fail(exc, f"{req.backend} run", req.env)


@app.post("/environments")
def environments(req: TransformRequest) -> dict[str, Any]:
    """Virtual environments. dbt has none — that is stated, not simulated."""
    if req.backend != "sqlmesh":
        return {
            "ok": True, "exitCode": 0, "engine": "dbt", "environments": [],
            "note": "dbt has no virtual data environments. Switch the project backend to SQLMesh to get environment-scoped view swaps; dbt targets (dev/prod profiles) are configured on the project's target instead.",
        }
    with tempfile.TemporaryDirectory(prefix="loom-transform-") as tmp:
        project_dir = _materialize(req, tmp)
        if isinstance(project_dir, dict):
            return project_dir
        try:
            return sqlmesh_engine.environments(project_dir, req.gateway, req.env)
        except Exception as exc:  # noqa: BLE001
            return _fail(exc, "sqlmesh environments", req.env)


@app.post("/diff")
def diff(req: DiffRequest) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="loom-transform-") as tmp:
        project_dir = _materialize(req, tmp)
        if isinstance(project_dir, dict):
            return project_dir
        try:
            return sqlmesh_engine.table_diff(
                project_dir, req.model, req.sourceEnvironment, req.targetEnvironment,
                req.gateway, req.env,
            )
        except Exception as exc:  # noqa: BLE001
            return _fail(exc, "sqlmesh table diff", req.env)
