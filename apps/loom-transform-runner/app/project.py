"""Shared project materialization + artifact helpers for the transform runner.

The Console generates the project files (dbt or SQLMesh) and POSTs them; this
module writes them into a temp dir with traversal guards, and reads the run
artifacts back out.

`read_dbt_artifacts` deliberately returns `target/manifest.json` and
`target/catalog.json` VERBATIM (as parsed JSON) because the Console's L6 dbt
manifest-lineage parser (lib/dbt/dbt-manifest-lineage.ts, already on main)
consumes exactly those two documents. The N4 runner does NOT fork or reshape
them — it surfaces the same artifacts the loom-dbt-runner surfaced, so L6's
existing parse keeps working unchanged.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pydantic import BaseModel


class GeneratedFile(BaseModel):
    path: str
    content: str


def write_project(root: Path, files: list[GeneratedFile]) -> None:
    """Materialize the generated files under root, guarding against traversal."""
    root_resolved = str(root.resolve())
    for f in files:
        rel = f.path.lstrip("/")
        target = (root / rel).resolve()
        if not str(target).startswith(root_resolved):
            raise ValueError(f"illegal file path: {f.path}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(f.content, encoding="utf-8")


def read_json(path: Path) -> Any | None:
    """Parse a JSON artifact, or None when absent/unreadable (never raises)."""
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return None


def read_dbt_artifacts(project_dir: Path) -> dict[str, Any]:
    """Return dbt's run artifacts in the shape the Console (L6) already expects.

    Keys: `manifest` (target/manifest.json), `catalog` (target/catalog.json),
    `runResults` (target/run_results.json). Missing artifacts are omitted rather
    than faked — the Console treats an absent manifest as "no lineage to emit".
    """
    target = project_dir / "target"
    out: dict[str, Any] = {}
    manifest = read_json(target / "manifest.json")
    if manifest is not None:
        out["manifest"] = manifest
    catalog = read_json(target / "catalog.json")
    if catalog is not None:
        out["catalog"] = catalog
    run_results = read_json(target / "run_results.json")
    if run_results is not None:
        out["runResults"] = run_results
    return out


def parse_run_results(project_dir: Path) -> list[dict[str, Any]]:
    """Per-node status rows from dbt's run_results.json (empty when absent)."""
    data = read_json(project_dir / "target" / "run_results.json")
    if not isinstance(data, dict):
        return []
    out: list[dict[str, Any]] = []
    for r in data.get("results", []):
        unique_id = r.get("unique_id", "")
        out.append({
            "name": unique_id.split(".")[-1] or unique_id,
            "status": r.get("status", "unknown"),
            "message": r.get("message"),
        })
    return out
