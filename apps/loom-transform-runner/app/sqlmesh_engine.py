"""SQLMesh engine adapter — virtual environments, plan/apply, column diff.

This is the half of the N4 runner that dbt cannot do:

  • **Virtual data environments** — `sqlmesh plan <env>` builds the environment
    as a set of VIEWS over shared physical tables, so a dev environment costs a
    view swap, not a full rebuild.
  • **Terraform-style plan/apply** — `plan()` categorizes every changed model as
    BREAKING / NON_BREAKING / FORWARD_ONLY / INDIRECT_* / METADATA and lists the
    intervals that would be backfilled. Nothing is executed until `apply()`.
  • **Column-level diff** — `table_diff` reports added / removed / type-changed
    columns between two environments of the same model.

Everything here calls the REAL SQLMesh Python API (`sqlmesh.Context`). There is
no simulation: when SQLMesh raises, the exception text is returned verbatim so
the Console surfaces an honest error instead of a fabricated plan.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any


def _load_context(project_dir: Path, gateway: str | None, env: dict[str, str]):
    """Build a real sqlmesh.Context over the materialized project."""
    for k, v in env.items():
        if v:
            os.environ[k] = v
    from sqlmesh import Context  # lazy import so /health works without sqlmesh

    return Context(paths=str(project_dir), gateway=gateway or None)


def _category_name(snapshot: Any) -> str:
    """SnapshotChangeCategory → lowercase name ('breaking', 'indirect_breaking', …).

    Returns 'unknown' when SQLMesh has not categorized the snapshot (it defers
    to the operator when auto-categorization is off) — the Console then derives
    the severity from the column facts rather than guessing here.
    """
    cat = getattr(snapshot, "change_category", None)
    name = getattr(cat, "name", None)
    return str(name).lower() if name else "unknown"


def _columns_to_types(node: Any) -> dict[str, str]:
    model = getattr(node, "model", node)
    cols = getattr(model, "columns_to_types", None) or {}
    try:
        return {str(k): str(v) for k, v in cols.items()}
    except Exception:  # noqa: BLE001 — column metadata is best-effort, never fatal
        return {}


def _snapshot_name(snapshot: Any) -> str:
    return str(getattr(snapshot, "name", "") or getattr(getattr(snapshot, "model", None), "name", ""))


def _plan_payload(plan_obj: Any, ctx: Any, environment: str) -> dict[str, Any]:
    """Project a SQLMesh Plan into the JSON the Console's parser consumes."""
    diff = getattr(plan_obj, "context_diff", None)
    directly = {str(n) for n in (getattr(plan_obj, "directly_modified", None) or [])}
    indirectly_raw = getattr(plan_obj, "indirectly_modified", None) or {}
    indirectly: dict[str, list[str]] = {}
    try:
        for parent, kids in indirectly_raw.items():
            indirectly[str(parent)] = [str(k) for k in kids]
    except Exception:  # noqa: BLE001
        indirectly = {}

    changes: list[dict[str, Any]] = []

    modified = getattr(diff, "modified_snapshots", None) or {}
    for name, pair in modified.items():
        try:
            new_snap, old_snap = pair
        except (TypeError, ValueError):
            continue
        new_cols = _columns_to_types(new_snap)
        old_cols = _columns_to_types(old_snap)
        changes.append({
            "model": str(name),
            "changeType": "modified",
            "category": _category_name(new_snap),
            "direct": str(name) in directly,
            "downstream": indirectly.get(str(name), []),
            "columns": new_cols,
            "previousColumns": old_cols,
        })

    for snap_id in (getattr(diff, "added", None) or []):
        name = str(getattr(snap_id, "name", snap_id))
        snap = None
        try:
            snap = (getattr(diff, "snapshots", None) or {}).get(snap_id)
        except Exception:  # noqa: BLE001
            snap = None
        changes.append({
            "model": name,
            "changeType": "added",
            # SQLMesh categorizes a brand-new snapshot BREAKING (meaning "must be
            # built"), which is NOT the same as "breaks consumers". Report the
            # category verbatim when we have it and let the Console apply that
            # distinction; report 'unknown' rather than guessing when we do not.
            "category": _category_name(snap) if snap is not None else "unknown",
            "direct": True,
            "downstream": indirectly.get(name, []),
            "columns": _columns_to_types(snap) if snap is not None else {},
            "previousColumns": {},
        })

    removed = getattr(diff, "removed_snapshots", None) or {}
    try:
        removed_items = removed.items()
    except AttributeError:
        removed_items = [(getattr(s, "name", s), s) for s in removed]
    for snap_id, snap in removed_items:
        name = str(getattr(snap_id, "name", snap_id))
        changes.append({
            "model": name,
            "changeType": "removed",
            "category": "breaking",
            "direct": True,
            "downstream": [],
            "columns": {},
            "previousColumns": _columns_to_types(snap),
        })

    backfills: list[dict[str, Any]] = []
    for mi in (getattr(plan_obj, "missing_intervals", None) or []):
        backfills.append({
            "model": _snapshot_name(getattr(mi, "snapshot", mi)) or str(getattr(mi, "snapshot_name", "")),
            "intervals": len(getattr(mi, "merged_intervals", None) or getattr(mi, "intervals", None) or []),
        })

    return {
        "engine": "sqlmesh",
        "plan": {
            "environment": environment,
            "hasChanges": bool(changes),
            "changes": changes,
            "backfills": backfills,
            "restatements": [str(r) for r in (getattr(plan_obj, "restatements", None) or [])],
            "start": str(getattr(plan_obj, "start", "") or ""),
            "end": str(getattr(plan_obj, "end", "") or ""),
        },
        "environments": list_environment_names(ctx),
    }


def list_environment_names(ctx: Any) -> list[str]:
    try:
        return sorted({str(e.name) for e in ctx.state_reader.get_environments()})
    except Exception:  # noqa: BLE001 — an empty state store is a legitimate first-run state
        return []


def plan(project_dir: Path, environment: str, gateway: str | None, env: dict[str, str]) -> dict[str, Any]:
    """Build (never apply) a SQLMesh plan for `environment`."""
    ctx = _load_context(project_dir, gateway, env)
    plan_obj = ctx.plan(
        environment=environment,
        no_prompts=True,
        auto_apply=False,
        skip_tests=True,
    )
    payload = _plan_payload(plan_obj, ctx, environment)
    payload.update({"ok": True, "exitCode": 0, "log": f"$ sqlmesh plan {environment}\n -> planned"})
    return payload


def apply(project_dir: Path, environment: str, gateway: str | None, env: dict[str, str]) -> dict[str, Any]:
    """Build AND apply the plan — the virtual-environment view swap + backfill."""
    ctx = _load_context(project_dir, gateway, env)
    plan_obj = ctx.plan(
        environment=environment,
        no_prompts=True,
        auto_apply=False,
        skip_tests=True,
    )
    payload = _plan_payload(plan_obj, ctx, environment)
    ctx.apply(plan_obj)
    payload.update({
        "ok": True,
        "exitCode": 0,
        "applied": True,
        "log": f"$ sqlmesh plan {environment} --auto-apply\n -> applied (virtual environment updated)",
        "environments": list_environment_names(ctx),
    })
    return payload


def run(project_dir: Path, environment: str, gateway: str | None, env: dict[str, str]) -> dict[str, Any]:
    """Execute the environment's scheduled cadence (`sqlmesh run`)."""
    ctx = _load_context(project_dir, gateway, env)
    result = ctx.run(environment=environment)
    ok = bool(result) if isinstance(result, bool) else True
    return {
        "ok": ok,
        "exitCode": 0 if ok else 1,
        "engine": "sqlmesh",
        "log": f"$ sqlmesh run {environment}\n -> {'OK' if ok else 'no work to do / failed'}",
        "environments": list_environment_names(ctx),
    }


def environments(project_dir: Path, gateway: str | None, env: dict[str, str]) -> dict[str, Any]:
    """List the real virtual environments recorded in the SQLMesh state store."""
    ctx = _load_context(project_dir, gateway, env)
    rows: list[dict[str, Any]] = []
    try:
        for e in ctx.state_reader.get_environments():
            rows.append({
                "name": str(e.name),
                "planId": str(getattr(e, "plan_id", "") or ""),
                "expiresAt": getattr(e, "expiration_ts", None),
                "models": len(getattr(e, "snapshots", None) or []),
                "isProd": str(e.name) == "prod",
            })
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "exitCode": 1, "engine": "sqlmesh",
                "error": f"SQLMesh state store unreadable: {exc}"}
    return {"ok": True, "exitCode": 0, "engine": "sqlmesh", "environments": rows}


def table_diff(
    project_dir: Path,
    model: str,
    source_env: str,
    target_env: str,
    gateway: str | None,
    env: dict[str, str],
) -> dict[str, Any]:
    """Column-level (and row-level, when keys exist) diff of one model."""
    ctx = _load_context(project_dir, gateway, env)
    diff = ctx.table_diff(
        source=source_env,
        target=target_env,
        select_models=[model],
        show=False,
    )
    entries = diff if isinstance(diff, list) else [diff]
    out: list[dict[str, Any]] = []
    for d in entries:
        col = d.column_diff()
        row = getattr(d, "row_diff", None)
        row_stats = row() if callable(row) else None
        out.append({
            "model": model,
            "source": source_env,
            "target": target_env,
            "columnsAdded": {str(k): str(v) for k, v in (getattr(col, "added", None) or {}).items()},
            "columnsRemoved": {str(k): str(v) for k, v in (getattr(col, "removed", None) or {}).items()},
            "columnsModified": {
                str(k): [str(x) for x in (v if isinstance(v, (list, tuple)) else [v])]
                for k, v in (getattr(col, "modified", None) or {}).items()
            },
            "sourceRows": getattr(row_stats, "s_count", None),
            "targetRows": getattr(row_stats, "t_count", None),
            "joinCount": getattr(row_stats, "join_count", None),
        })
    return {"ok": True, "exitCode": 0, "engine": "sqlmesh", "diffs": out}
