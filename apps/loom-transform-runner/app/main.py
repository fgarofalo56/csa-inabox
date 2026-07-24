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

# The dbt adapters bundled in this image. `fabric` is present but is NEVER the
# default — it is only reachable when a project explicitly selects it
# (no-fabric-dependency.md); synapse / databricks / duckdb are the Azure-native
# and sovereign-OSS defaults.
BUNDLED_DBT_ADAPTERS = ["synapse", "databricks", "duckdb", "fabric"]


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

        engines["dbt"] = {"available": True, "version": dbt.version.get_installed_version().to_version_string(),
                          "adapters": BUNDLED_DBT_ADAPTERS}
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


def _fail(exc: Exception, action: str) -> dict[str, Any]:
    """Honest failure envelope — the engine's real message, never a fake plan."""
    return {"ok": False, "exitCode": 1, "error": f"{action} failed: {exc}", "log": str(exc)}


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
            return _fail(exc, f"{req.backend} plan")


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
            return _fail(exc, f"{req.backend} apply")


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
            return _fail(exc, f"{req.backend} run")


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
            return _fail(exc, "sqlmesh environments")


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
            return _fail(exc, "sqlmesh table diff")
