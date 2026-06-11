"""CSA Loom — dbt runner Container App.

A minimal FastAPI service that executes a *generated* dbt project against the
Synapse dedicated SQL pool (default) or, opt-in, the Fabric Warehouse — the two
Azure-native dbt targets that have no native "dbt task" runtime the way
Databricks Jobs do.

Request flow:
  1. The Console (lib/dbt/dbt-runner.ts) POSTs { files, commands, adapter, env }.
  2. We materialize the files into a temp project dir, point DBT_PROFILES_DIR at
     it (the generated profiles.yml uses authentication=CLI / managed identity),
     inject the per-run env, and run each command via dbt-core in-process.
  3. We parse target/run_results.json for per-node status and return the log.

Auth to the pool is the runner's managed identity (AZURE_CLIENT_ID set by
bicep) via the ODBC "ActiveDirectoryMsi"/CLI path — no secrets are handled here
and none are written into the project (the generated profiles.yml never embeds
credentials).
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="loom-dbt-runner", version="1.0.0")

ALLOWED_ADAPTERS = {"synapse", "fabric"}


class GeneratedFile(BaseModel):
    path: str
    content: str


class RunRequest(BaseModel):
    files: list[GeneratedFile]
    commands: list[str]
    adapter: str = "synapse"
    env: dict[str, str] = {}


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


def _write_project(root: Path, files: list[GeneratedFile]) -> None:
    """Materialize the generated files under root, guarding against traversal."""
    for f in files:
        # Reject absolute paths / parent escapes — the Console only ever sends
        # project-relative paths, but defend the filesystem regardless.
        rel = f.path.lstrip("/")
        target = (root / rel).resolve()
        if not str(target).startswith(str(root.resolve())):
            raise ValueError(f"illegal file path: {f.path}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(f.content, encoding="utf-8")


def _parse_run_results(project_dir: Path) -> list[dict[str, Any]]:
    rr = project_dir / "target" / "run_results.json"
    if not rr.exists():
        return []
    try:
        data = json.loads(rr.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return []
    out: list[dict[str, Any]] = []
    for r in data.get("results", []):
        node = r.get("unique_id", "").split(".")[-1] or r.get("unique_id", "")
        out.append({
            "name": node,
            "status": r.get("status", "unknown"),
            "message": r.get("message"),
        })
    return out


def _run_dbt(command: str, project_dir: Path, env: dict[str, str]) -> tuple[int, str]:
    """Invoke dbt-core for a single command line via the programmatic runner.

    Using dbtRunner (the supported in-process entrypoint) avoids spawning a new
    interpreter and keeps the log in-band.
    """
    from dbt.cli.main import dbtRunner  # imported lazily so /health works w/o dbt

    args = command.split()
    if args and args[0] == "dbt":
        args = args[1:]
    # Pin project + profiles to the materialized dir.
    args += ["--project-dir", str(project_dir), "--profiles-dir", str(project_dir)]

    # dbt reads env_var() at parse time; ensure overrides are present.
    for k, v in env.items():
        if v:
            os.environ[k] = v

    runner = dbtRunner()
    res = runner.invoke(args)
    code = 0 if getattr(res, "success", False) else 1
    # dbt streams to stdout/logs; surface a concise status line per command.
    summary = f"$ dbt {' '.join(args)}\n -> {'OK' if code == 0 else 'FAILED'}"
    if getattr(res, "exception", None):
        summary += f"\n{res.exception}"
    return code, summary


@app.post("/run")
def run(req: RunRequest) -> dict[str, Any]:
    if req.adapter not in ALLOWED_ADAPTERS:
        return {"ok": False, "exitCode": 2,
                "log": f"adapter '{req.adapter}' not supported by this runtime (synapse|fabric)"}
    logs: list[str] = []
    exit_code = 0
    with tempfile.TemporaryDirectory(prefix="loom-dbt-") as tmp:
        project_dir = Path(tmp)
        try:
            _write_project(project_dir, req.files)
        except ValueError as e:
            return {"ok": False, "exitCode": 2, "log": str(e)}

        commands = req.commands or ["dbt deps", "dbt build"]
        for cmd in commands:
            code, out = _run_dbt(cmd, project_dir, req.env)
            logs.append(out)
            if code != 0:
                exit_code = code
                break  # stop on first failure, like a real dbt pipeline

        results = _parse_run_results(project_dir)

    return {
        "ok": exit_code == 0,
        "exitCode": exit_code,
        "log": "\n\n".join(logs),
        "results": results,
    }
