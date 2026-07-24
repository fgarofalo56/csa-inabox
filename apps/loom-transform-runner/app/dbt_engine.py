"""dbt engine adapter — run / plan (state:modified diff) for the N4 runner.

dbt has no native plan/apply. Its closest real equivalent is a **deferred state
comparison**: compile the project, then diff the fresh `target/manifest.json`
against the manifest of the currently-deployed state (`--state`). That is
exactly what `dbt ls --select state:modified` does internally, and it is what
`plan()` below computes — from the two REAL manifests, never from a guess.

The runner emits the raw comparison; the Console
(lib/transform/plan-impact.ts) classifies each change into the shared
breaking / non-breaking impact rows so BOTH engines land in one grid.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from .project import parse_run_results, read_dbt_artifacts, read_json

# dbt commands the Console may request. Anything else is refused (the Console
# builds these from checkboxes — no freeform command strings reach a shell).
ALLOWED_DBT_COMMANDS = {
    "dbt deps", "dbt seed", "dbt run", "dbt build", "dbt test",
    "dbt snapshot", "dbt compile", "dbt docs generate", "dbt parse",
}


def run_dbt(command: str, project_dir: Path, env: dict[str, str], extra: list[str] | None = None) -> tuple[int, str]:
    """Invoke dbt-core in-process for a single command line.

    Uses `dbtRunner` (dbt's supported programmatic entrypoint) so no shell is
    spawned and the result stays in-band.
    """
    from dbt.cli.main import dbtRunner  # lazy so /health works without dbt

    args = command.split()
    if args and args[0] == "dbt":
        args = args[1:]
    args += ["--project-dir", str(project_dir), "--profiles-dir", str(project_dir)]
    if extra:
        args += extra

    for k, v in env.items():
        if v:
            os.environ[k] = v

    res = dbtRunner().invoke(args)
    code = 0 if getattr(res, "success", False) else 1
    summary = f"$ dbt {' '.join(args)}\n -> {'OK' if code == 0 else 'FAILED'}"
    exc = getattr(res, "exception", None)
    if exc:
        summary += f"\n{exc}"
    return code, summary


def execute(project_dir: Path, commands: list[str], env: dict[str, str]) -> dict[str, Any]:
    """Run the requested dbt commands, stopping at the first failure."""
    logs: list[str] = []
    exit_code = 0
    for cmd in commands:
        if cmd not in ALLOWED_DBT_COMMANDS:
            return {"ok": False, "exitCode": 2,
                    "log": f"command '{cmd}' is not an allowed dbt command"}
        code, out = run_dbt(cmd, project_dir, env)
        logs.append(out)
        if code != 0:
            exit_code = code
            break
    payload: dict[str, Any] = {
        "ok": exit_code == 0,
        "exitCode": exit_code,
        "log": "\n\n".join(logs),
        "results": parse_run_results(project_dir),
    }
    # L6 contract: surface target/manifest.json + target/catalog.json verbatim.
    payload.update(read_dbt_artifacts(project_dir))
    return payload


# ── plan (state:modified comparison) ─────────────────────────────────────────

def _nodes(manifest: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    if not isinstance(manifest, dict):
        return {}
    nodes = manifest.get("nodes") or {}
    return {k: v for k, v in nodes.items() if isinstance(v, dict) and v.get("resource_type") == "model"}


def _columns(catalog: dict[str, Any] | None, unique_id: str) -> dict[str, str]:
    """column name → data type, from a dbt catalog.json node (empty when absent)."""
    if not isinstance(catalog, dict):
        return {}
    node = (catalog.get("nodes") or {}).get(unique_id)
    if not isinstance(node, dict):
        return {}
    cols = node.get("columns") or {}
    out: dict[str, str] = {}
    for name, meta in cols.items():
        if isinstance(meta, dict):
            out[str(name)] = str(meta.get("type") or "")
    return out


def _child_map(manifest: dict[str, Any] | None) -> dict[str, list[str]]:
    if not isinstance(manifest, dict):
        return {}
    raw = manifest.get("child_map") or {}
    return {k: list(v) for k, v in raw.items() if isinstance(v, list)}


def plan(
    project_dir: Path,
    env: dict[str, str],
    prev_manifest: dict[str, Any] | None,
    prev_catalog: dict[str, Any] | None,
) -> dict[str, Any]:
    """Compile the project and diff it against the deployed-state manifest.

    Returns the RAW comparison (`added` / `modified` / `removed` node ids, their
    checksums, column type maps, and the downstream child map). The Console
    classifies breaking-ness from these facts.
    """
    code, log = run_dbt("dbt compile", project_dir, env)
    artifacts = read_dbt_artifacts(project_dir)
    new_manifest = artifacts.get("manifest")
    if code != 0 or not new_manifest:
        return {"ok": False, "exitCode": code or 1, "log": log,
                "error": "dbt compile did not produce target/manifest.json"}

    new_nodes = _nodes(new_manifest)
    old_nodes = _nodes(prev_manifest)
    # dbt writes the compiled catalog only after `dbt docs generate`; when the
    # fresh catalog is absent we still report the model-level diff honestly and
    # simply carry no column rows (never invented ones).
    new_catalog = artifacts.get("catalog")
    children = _child_map(new_manifest)

    added, modified, removed = [], [], []
    for uid, node in new_nodes.items():
        name = node.get("name") or uid.split(".")[-1]
        entry = {
            "uniqueId": uid,
            "name": name,
            "schema": node.get("schema"),
            "materialized": ((node.get("config") or {}).get("materialized")),
            "downstream": [c for c in children.get(uid, []) if c.startswith("model.")],
            "columns": _columns(new_catalog, uid),
        }
        if uid not in old_nodes:
            added.append(entry)
            continue
        old = old_nodes[uid]
        same_sql = (node.get("checksum") or {}).get("checksum") == (old.get("checksum") or {}).get("checksum")
        same_config = (node.get("config") or {}) == (old.get("config") or {})
        if same_sql and same_config:
            continue
        entry["previousColumns"] = _columns(prev_catalog, uid)
        entry["sqlChanged"] = not same_sql
        entry["configChanged"] = not same_config
        modified.append(entry)

    for uid, node in old_nodes.items():
        if uid in new_nodes:
            continue
        removed.append({
            "uniqueId": uid,
            "name": node.get("name") or uid.split(".")[-1],
            "schema": node.get("schema"),
            "downstream": [],
            "columns": {},
            "previousColumns": _columns(prev_catalog, uid),
        })

    return {
        "ok": True,
        "exitCode": 0,
        "log": log,
        "engine": "dbt",
        "plan": {
            "added": added,
            "modified": modified,
            "removed": removed,
            "hasState": bool(old_nodes),
        },
        **artifacts,
    }
