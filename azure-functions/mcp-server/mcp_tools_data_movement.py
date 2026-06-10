"""Loom MCP data-movement / pipeline tool registry.

Exposes the Loom **data-movement** surface (pipelines, copy jobs, data flows) as
MCP tools so any MCP client (the Loom agent loop, Claude, VS Code, …) can
**author, consume, and diagnose** pipelines on the Loom deployment.

This is the MCP-server side of the same Azure Data Factory backend the Loom
console BFF uses (apps/fiab-console/lib/azure/adf-client.ts). Everything is real
ARM REST against ``Microsoft.DataFactory/factories`` using the Function App's
managed identity — there are NO mocks (per .claude/rules/no-vaporware.md) and NO
Microsoft Fabric dependency: ADF is the Azure-native default backend for the
data-pipeline / copy-job / dataflow Loom items (per
.claude/rules/no-fabric-dependency.md). Loom works with
``LOOM_DEFAULT_FABRIC_WORKSPACE`` unset.

Configuration (app settings, wired by deploy/main.bicep):
  - ``LOOM_SUBSCRIPTION_ID``  — subscription hosting the factory (shared).
  - ``LOOM_DLZ_RG``           — resource group of the default factory.
  - ``LOOM_ADF_NAME``         — the env-pinned default Data Factory name.
When any are unset, the tools raise ``ToolError`` with the exact missing setting
so the MCP client surfaces an honest gate instead of a fake result.

Tools exposed:

  author / write
    - ``loom_upsert_pipeline``   — create or update a pipeline (activities JSON).
    - ``loom_validate_pipeline`` — syntactic/reference validation of a pipeline.

  consume / read
    - ``loom_list_pipelines``    — pipelines on the default factory + activity count.
    - ``loom_get_pipeline``      — full pipeline definition.
    - ``loom_list_dataflows``    — data flows on the default factory.

  run
    - ``loom_run_pipeline``      — trigger a pipeline run (returns runId).

  diagnose
    - ``loom_list_pipeline_runs`` — recent runs (status, duration, error) for a
      pipeline or factory-wide.
    - ``loom_diagnose_run``      — per-activity output for one run (the Output
      pane: which activity failed and why).

Write tools (``loom_upsert_pipeline``, ``loom_run_pipeline``) require the Function
App identity to hold **Data Factory Contributor** on the factory; read/diagnose
tools work with **Reader**. Missing permission surfaces as the raw ARM 403 in the
tool error (honest, not swallowed).
"""

from __future__ import annotations

import datetime as _dt
import os
import re
from typing import Any

import httpx

# Reuse the shared credential + ToolError from the catalog tool module so a single
# DefaultAzureCredential (managed identity) is used across the whole server.
from mcp_tools import ToolError, _credential  # type: ignore

ADF_API = "2018-06-01"
ARM_BASE = os.environ.get("LOOM_ARM_ENDPOINT", "https://management.azure.com").rstrip("/")
ARM_SCOPE = os.environ.get("LOOM_ARM_SCOPE", "https://management.azure.com/.default")

# ADF object names: 1-140 chars, letters/digits/underscore/hyphen (matches the
# console BFF's NAME_RE and ADF's own naming rules).
_NAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,140}$")


# ── configuration / honest gates ─────────────────────────────────────────────

def _required(key: str, hint: str) -> str:
    val = (os.environ.get(key) or "").strip()
    if not val:
        raise ToolError(
            f"{key} is not set on the MCP Function App. {hint} "
            "(Set it via deploy/main.bicep param adfName / the LOOM_DLZ_RG / "
            "LOOM_SUBSCRIPTION_ID app settings.)"
        )
    return val


def _factory_base() -> str:
    """ARM base URL of the env-pinned default Data Factory."""
    sub = _required("LOOM_SUBSCRIPTION_ID", "Set it to the subscription hosting the Loom Data Factory.")
    rg = _required("LOOM_DLZ_RG", "Set it to the resource group of the default Data Factory.")
    name = _required("LOOM_ADF_NAME", "Set it to the Loom default Data Factory name.")
    return (
        f"{ARM_BASE}/subscriptions/{sub}/resourceGroups/{rg}"
        f"/providers/Microsoft.DataFactory/factories/{name}"
    )


def _arm_token() -> str:
    try:
        return _credential().get_token(ARM_SCOPE).token
    except Exception as e:  # pragma: no cover - environment dependent
        raise ToolError(
            "Could not acquire an ARM token via managed identity. Grant the MCP "
            "Function App's identity 'Data Factory Contributor' (author/run) or "
            "'Reader' (read/diagnose) on the Loom Data Factory."
        ) from e


def _validate_name(name: str) -> str:
    name = (name or "").strip()
    if not name:
        raise ToolError("`name` is required.")
    if not _NAME_RE.match(name):
        raise ToolError("`name` must be 1-140 chars: letters, digits, _ or -.")
    return name


# ── ARM REST helpers ─────────────────────────────────────────────────────────

def _arm_request(method: str, path: str, *, body: Any = None, params: dict[str, str] | None = None,
                 timeout: int = 60) -> httpx.Response:
    """Issue an ARM request to ``{factory_base}{path}`` with the MI token.

    ``path`` begins with ``/`` (e.g. ``/pipelines``). The ``api-version`` is added
    automatically along with any extra ``params``.
    """
    url = f"{_factory_base()}{path}"
    qp = {"api-version": ADF_API}
    if params:
        qp.update(params)
    headers = {"authorization": f"Bearer {_arm_token()}"}
    if body is not None:
        headers["content-type"] = "application/json"
    with httpx.Client(timeout=timeout) as client:
        return client.request(method, url, headers=headers, params=qp, json=body)


def _ok_json(resp: httpx.Response, what: str) -> dict[str, Any]:
    if resp.status_code >= 400:
        raise ToolError(f"{what} failed: ARM {resp.status_code}: {resp.text[:400]}")
    if not resp.content:
        return {}
    try:
        return resp.json()
    except ValueError:  # pragma: no cover - ARM returned non-JSON success
        return {}


def _utc_window(days: int) -> tuple[str, str]:
    now = _dt.datetime.now(_dt.timezone.utc)
    start = now - _dt.timedelta(days=max(1, days))
    return start.isoformat(), now.isoformat()


# ── consume: list / get ──────────────────────────────────────────────────────

def _list_pipelines(args: dict[str, Any]) -> dict[str, Any]:
    body = _ok_json(_arm_request("GET", "/pipelines"), "list pipelines")
    pipelines = [
        {
            "name": p.get("name"),
            "activities": len((p.get("properties") or {}).get("activities") or []),
            "description": (p.get("properties") or {}).get("description"),
            "folder": ((p.get("properties") or {}).get("folder") or {}).get("name"),
        }
        for p in body.get("value", [])
    ]
    return {"factory": os.environ.get("LOOM_ADF_NAME"), "count": len(pipelines), "pipelines": pipelines}


def _get_pipeline(args: dict[str, Any]) -> dict[str, Any]:
    name = _validate_name(args.get("name", ""))
    body = _ok_json(_arm_request("GET", f"/pipelines/{name}"), f"get pipeline {name}")
    return {"name": body.get("name"), "properties": body.get("properties")}


def _list_dataflows(args: dict[str, Any]) -> dict[str, Any]:
    body = _ok_json(_arm_request("GET", "/dataflows"), "list data flows")
    flows = [
        {
            "name": f.get("name"),
            "type": (f.get("properties") or {}).get("type"),
            "description": (f.get("properties") or {}).get("description"),
        }
        for f in body.get("value", [])
    ]
    return {"factory": os.environ.get("LOOM_ADF_NAME"), "count": len(flows), "dataflows": flows}


# ── author: upsert / validate ─────────────────────────────────────────────────

def _upsert_pipeline(args: dict[str, Any]) -> dict[str, Any]:
    name = _validate_name(args.get("name", ""))
    props = args.get("properties")
    activities = args.get("activities")
    # Accept either a full `properties` block or a bare `activities` array.
    if props is None and activities is not None:
        if not isinstance(activities, list):
            raise ToolError("`activities` must be a JSON array of ADF activity objects.")
        props = {"activities": activities}
    if not isinstance(props, dict):
        raise ToolError(
            "Provide either `properties` (an ADF pipeline properties object) or "
            "`activities` (an array of ADF activity objects)."
        )
    if not isinstance(props.get("activities"), list):
        props["activities"] = []
    description = args.get("description")
    if isinstance(description, str) and description.strip():
        props["description"] = description.strip()
    payload = {"name": name, "properties": props}
    body = _ok_json(_arm_request("PUT", f"/pipelines/{name}", body=payload), f"upsert pipeline {name}")
    saved_props = body.get("properties") or {}
    return {
        "name": body.get("name") or name,
        "activities": len(saved_props.get("activities") or []),
        "saved": True,
    }


def _validate_pipeline(args: dict[str, Any]) -> dict[str, Any]:
    """Validate a pipeline by value (in-memory) or the persisted version.

    By value: provide `activities` or `properties` (+ optional `name`).
    Persisted: provide `name` only.
    """
    props = args.get("properties")
    activities = args.get("activities")
    if props is None and activities is not None:
        if not isinstance(activities, list):
            raise ToolError("`activities` must be a JSON array of ADF activity objects.")
        props = {"activities": activities}

    if props is not None:
        name = (args.get("name") or "loom-validate").strip() or "loom-validate"
        payload = {"name": name, "properties": props if isinstance(props, dict) else {"activities": []}}
        resp = _arm_request("POST", "/validatePipeline", body=payload)
    else:
        name = _validate_name(args.get("name", ""))
        resp = _arm_request("POST", f"/pipelines/{name}/validate")

    valid = resp.status_code < 400
    detail: Any
    try:
        detail = resp.json() if resp.content else {}
    except ValueError:
        detail = resp.text[:400]
    return {
        "valid": valid,
        "status": resp.status_code,
        "error": None if valid else (detail if isinstance(detail, str) else detail.get("error") or detail),
        "activities": (detail.get("activities") if isinstance(detail, dict) else None),
    }


# ── run ───────────────────────────────────────────────────────────────────────

def _run_pipeline(args: dict[str, Any]) -> dict[str, Any]:
    name = _validate_name(args.get("name", ""))
    params = args.get("parameters") or {}
    if not isinstance(params, dict):
        raise ToolError("`parameters` must be a JSON object of pipeline parameter name → value.")
    body = _ok_json(
        _arm_request("POST", f"/pipelines/{name}/createRun", body=params),
        f"run pipeline {name}",
    )
    return {"pipeline": name, "runId": body.get("runId"), "started": True}


# ── diagnose ──────────────────────────────────────────────────────────────────

def _list_pipeline_runs(args: dict[str, Any]) -> dict[str, Any]:
    pipeline = (args.get("pipeline") or "").strip()
    days = int(args.get("days", 7) or 7)
    top = max(1, min(int(args.get("top", 20) or 20), 100))
    after, before = _utc_window(days)
    query: dict[str, Any] = {
        "lastUpdatedAfter": after,
        "lastUpdatedBefore": before,
        "orderBy": [{"orderBy": "RunStart", "order": "DESC"}],
    }
    if pipeline:
        query["filters"] = [{"operand": "PipelineName", "operator": "Equals", "values": [pipeline]}]
    body = _ok_json(
        _arm_request("POST", "/queryPipelineRuns", body=query),
        "query pipeline runs",
    )
    runs = [
        {
            "runId": r.get("runId"),
            "pipeline": r.get("pipelineName"),
            "status": r.get("status"),
            "runStart": r.get("runStart"),
            "runEnd": r.get("runEnd"),
            "durationInMs": r.get("durationInMs"),
            "message": r.get("message"),
        }
        for r in body.get("value", [])[:top]
    ]
    return {"pipeline": pipeline or None, "windowDays": days, "count": len(runs), "runs": runs}


def _diagnose_run(args: dict[str, Any]) -> dict[str, Any]:
    run_id = (args.get("runId") or "").strip()
    if not run_id:
        raise ToolError("`runId` is required (from loom_run_pipeline or loom_list_pipeline_runs).")
    days = int(args.get("days", 7) or 7)
    after, before = _utc_window(days)
    query = {"lastUpdatedAfter": after, "lastUpdatedBefore": before}
    body = _ok_json(
        _arm_request("POST", f"/pipelineruns/{run_id}/queryActivityruns", body=query),
        f"diagnose run {run_id}",
    )
    activities = []
    for a in body.get("value", []):
        err = a.get("error") or {}
        activities.append(
            {
                "activity": a.get("activityName"),
                "type": a.get("activityType"),
                "status": a.get("status"),
                "durationInMs": a.get("durationInMs"),
                "error": (
                    {"errorCode": err.get("errorCode"), "message": err.get("message"),
                     "failureType": err.get("failureType")}
                    if (err.get("message") or err.get("errorCode")) else None
                ),
            }
        )
    failed = [a for a in activities if a.get("status") == "Failed"]
    return {
        "runId": run_id,
        "activityCount": len(activities),
        "failedCount": len(failed),
        "activities": activities,
    }


# ── registry ─────────────────────────────────────────────────────────────────

def build_tools() -> dict[str, Any]:
    """Return ``{name: Tool}`` for the data-movement tools.

    Imported lazily inside the function so a partial/edge import of mcp_tools (in
    tests that monkeypatch TOOLS) never trips the module-level import.
    """
    from mcp_tools import Tool  # type: ignore

    return {
        t.name: t
        for t in [
            Tool(
                "loom_list_pipelines",
                "List data pipelines on the Loom default Data Factory with their activity counts. "
                "Use to discover what pipelines exist before authoring/running. Read-only.",
                {"type": "object", "properties": {}},
                _list_pipelines,
            ),
            Tool(
                "loom_get_pipeline",
                "Get the full definition (activities, parameters, variables) of one pipeline. Read-only.",
                {
                    "type": "object",
                    "properties": {"name": {"type": "string", "description": "Pipeline name."}},
                    "required": ["name"],
                },
                _get_pipeline,
            ),
            Tool(
                "loom_list_dataflows",
                "List mapping/wrangling data flows on the Loom default Data Factory. Read-only.",
                {"type": "object", "properties": {}},
                _list_dataflows,
            ),
            Tool(
                "loom_upsert_pipeline",
                "Create or update a data pipeline. Provide `activities` (array of ADF activity "
                "objects) or a full `properties` object. Requires Data Factory Contributor.",
                {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "description": "Pipeline name (1-140 chars, [A-Za-z0-9_-])."},
                        "activities": {
                            "type": "array",
                            "description": "ADF activity objects (e.g. a Copy activity). Mutually exclusive with `properties`.",
                            "items": {"type": "object"},
                        },
                        "properties": {
                            "type": "object",
                            "description": "Full ADF pipeline `properties` block (activities/parameters/variables).",
                        },
                        "description": {"type": "string", "description": "Optional pipeline description."},
                    },
                    "required": ["name"],
                },
                _upsert_pipeline,
            ),
            Tool(
                "loom_validate_pipeline",
                "Validate a pipeline against ADF's syntactic/reference checker. Pass `name` to "
                "validate the persisted pipeline, or `activities`/`properties` to validate by value. Read-only.",
                {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "description": "Pipeline name (persisted validation, or label for by-value)."},
                        "activities": {"type": "array", "items": {"type": "object"}, "description": "Validate these activities by value."},
                        "properties": {"type": "object", "description": "Validate this full properties block by value."},
                    },
                },
                _validate_pipeline,
            ),
            Tool(
                "loom_run_pipeline",
                "Trigger a run of a pipeline and return its runId. Optional `parameters` object is "
                "passed to the pipeline. Requires Data Factory Contributor.",
                {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "description": "Pipeline name to run."},
                        "parameters": {"type": "object", "description": "Pipeline parameter name → value."},
                    },
                    "required": ["name"],
                },
                _run_pipeline,
            ),
            Tool(
                "loom_list_pipeline_runs",
                "List recent pipeline runs (status, duration, error message) for a pipeline, or "
                "factory-wide if no pipeline is given. Use to diagnose what ran and how it went. Read-only.",
                {
                    "type": "object",
                    "properties": {
                        "pipeline": {"type": "string", "description": "Optional pipeline name filter."},
                        "days": {"type": "integer", "description": "Look-back window in days (default 7, max ADF window 45)."},
                        "top": {"type": "integer", "description": "Max runs to return (1-100, default 20)."},
                    },
                },
                _list_pipeline_runs,
            ),
            Tool(
                "loom_diagnose_run",
                "Diagnose one pipeline run: returns each activity's status, duration, and error "
                "(which activity failed and why). Pass the runId from loom_run_pipeline or "
                "loom_list_pipeline_runs. Read-only.",
                {
                    "type": "object",
                    "properties": {
                        "runId": {"type": "string", "description": "Pipeline run id."},
                        "days": {"type": "integer", "description": "Look-back window in days (default 7)."},
                    },
                    "required": ["runId"],
                },
                _diagnose_run,
            ),
        ]
    }
