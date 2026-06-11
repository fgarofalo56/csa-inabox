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

  copy job (simplified data movement — the Loom copy-job item)
    - ``loom_run_copy_job``      — materialise a Copy-job spec into a real ADF
      pipeline (Full / Incremental-watermark / native-CDC) + its datasets and
      run it. Mirrors the console BFF
      apps/fiab-console/app/api/items/copy-job/[id]/run/route.ts.

  data flow (Dataflow Gen2 — Power Query / WranglingDataFlow)
    - ``loom_get_dataflow``      — full definition of one data flow.
    - ``loom_author_dataflow``   — create/update a Power Query (M) Wrangling
      data flow. Mirrors adf-client.ts ``upsertWranglingDataFlow``.
    - ``loom_run_dataflow``      — run a Wrangling data flow via an
      ExecuteWranglingDataflow wrapper pipeline. Mirrors ``runWranglingDataFlow``.

Write tools (``loom_upsert_pipeline``, ``loom_run_pipeline``, ``loom_run_copy_job``,
``loom_author_dataflow``, ``loom_run_dataflow``) require the Function App identity
to hold **Data Factory Contributor** on the factory; read/diagnose tools work with
**Reader**. Missing permission surfaces as the raw ARM 403 in the tool error
(honest, not swallowed).

Incremental / CDC copy jobs additionally require the watermark / LSN checkpoint
control DB. When ``LOOM_COPYJOB_CONTROL_SQL_SERVER`` is unset those modes return a
precise honest gate naming the env var + the bicep module
(platform/fiab/bicep/modules/admin-plane/copy-job-control.bicep, which creates
dbo.copy_watermark + dbo.usp_write_watermark). Full-mode copy needs no control DB.
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


# ── data flow: get / author / run (Dataflow Gen2 — Power Query) ─────────────────
#
# The Azure-native backend for Dataflow Gen2 (Power Query Online) is an ADF
# ``WranglingDataFlow`` resource that a pipeline invokes via an
# ``ExecuteWranglingDataflow`` activity (no Microsoft Fabric). These mirror
# adf-client.ts upsertWranglingDataFlow / runWranglingDataFlow exactly.

def _get_dataflow(args: dict[str, Any]) -> dict[str, Any]:
    name = _validate_name(args.get("name", ""))
    body = _ok_json(_arm_request("GET", f"/dataflows/{name}"), f"get data flow {name}")
    return {"name": body.get("name"), "properties": body.get("properties")}


def _author_dataflow(args: dict[str, Any]) -> dict[str, Any]:
    """Create/update a Power Query (M) Wrangling data flow.

    ``sources`` binds query names in the M script to ADF datasets when the query
    reads from a connector; an inline ``#table(...)`` query needs no source.
    """
    name = _validate_name(args.get("name", ""))
    m_script = args.get("script")
    if not isinstance(m_script, str) or not m_script.strip():
        raise ToolError("`script` (the Power Query / M mashup text) is required.")
    raw_sources = args.get("sources") or []
    if not isinstance(raw_sources, list):
        raise ToolError("`sources` must be an array of {name, datasetName} objects.")
    sources = []
    for s in raw_sources:
        if not isinstance(s, dict) or not (s.get("name") or "").strip():
            raise ToolError("each `sources` entry needs a `name` (the query name in the M script).")
        entry: dict[str, Any] = {"name": s["name"]}
        ds = (s.get("datasetName") or "").strip()
        if ds:
            entry["dataset"] = {"referenceName": ds, "type": "DatasetReference"}
        sources.append(entry)
    payload = {
        "name": name,
        "properties": {
            "type": "WranglingDataFlow",
            "typeProperties": {
                "sources": sources,
                "script": m_script,
                "documentLocale": "en-US",
            },
        },
    }
    body = _ok_json(_arm_request("PUT", f"/dataflows/{name}", body=payload), f"author data flow {name}")
    return {
        "name": body.get("name") or name,
        "type": "WranglingDataFlow",
        "sources": len(sources),
        "saved": True,
    }


def _run_dataflow(args: dict[str, Any]) -> dict[str, Any]:
    """Run a Wrangling data flow via an ExecuteWranglingDataflow wrapper pipeline.

    Each ``sinks`` entry maps an output query → an ADF dataset to write to.
    """
    df_name = _validate_name(args.get("name", ""))
    raw_sinks = args.get("sinks") or []
    if not isinstance(raw_sinks, list):
        raise ToolError("`sinks` must be an array of {queryName, sinkName, datasetName} objects.")
    sinks = []
    for s in raw_sinks:
        if not isinstance(s, dict) or not all((s.get(k) or "").strip() for k in ("queryName", "sinkName", "datasetName")):
            raise ToolError("each `sinks` entry needs `queryName`, `sinkName`, and `datasetName`.")
        sinks.append(s)
    compute_type = (args.get("computeType") or "General").strip() or "General"
    core_count = int(args.get("coreCount", 8) or 8)

    def _sink_ref(s: dict[str, Any]) -> dict[str, Any]:
        return {"name": s["sinkName"], "dataset": {"referenceName": s["datasetName"], "type": "DatasetReference"}}

    type_props: dict[str, Any] = {
        "dataFlow": {"referenceName": df_name, "type": "DataFlowReference"},
        "integrationRuntime": {"referenceName": "AutoResolveIntegrationRuntime", "type": "IntegrationRuntimeReference"},
        "compute": {"computeType": compute_type, "coreCount": core_count},
    }
    if sinks:
        type_props["sinks"] = {s["sinkName"]: _sink_ref(s) for s in sinks}
        type_props["queries"] = [{"queryName": s["queryName"], "dataflowSinks": [_sink_ref(s)]} for s in sinks]
    pipeline_name = f"loom-pq-run-{df_name}"
    pipeline = {
        "name": pipeline_name,
        "properties": {
            "description": f"Loom Power Query (Dataflow Gen2) run for {df_name}",
            "activities": [{"name": "RunDataflow", "type": "ExecuteWranglingDataflow", "dependsOn": [], "typeProperties": type_props}],
            "annotations": ["loom", "dataflow-gen2"],
        },
    }
    _ok_json(_arm_request("PUT", f"/pipelines/{pipeline_name}", body=pipeline), f"materialise wrapper pipeline {pipeline_name}")
    run = _ok_json(_arm_request("POST", f"/pipelines/{pipeline_name}/createRun", body={}), f"run data flow {df_name}")
    return {"dataflow": df_name, "pipelineName": pipeline_name, "runId": run.get("runId"), "started": True}


# ── copy job: materialise + run (Full / Incremental / CDC) ──────────────────────
#
# A 1:1 Python port of the console BFF
# apps/fiab-console/app/api/items/copy-job/[id]/run/route.ts. Builds REAL ADF
# datasets + (for Incremental/CDC) a control linked service + the activity-graph
# pipeline, then triggers a run. No Microsoft Fabric: ADF + Azure SQL only.

_CONTROL_LS = "loom-copy-control-sql"
_SQL_SOURCE = {"AzureSqlSource", "SqlServerSource", "SqlMISource", "AzureSqlDWSource"}
_SQL_SINK = {"AzureSqlSink", "SqlServerSink", "SqlMISink", "AzureSqlDWSink"}


def _is_sql_source(t: str) -> bool: return t in _SQL_SOURCE
def _is_sql_sink(t: str) -> bool: return t in _SQL_SINK


def _split_table(t: str) -> tuple[str, str]:
    i = (t or "").find(".")
    if i < 0:
        return "dbo", t or ""
    return t[:i], t[i + 1:]


def _dataset_type(activity_type: str) -> str:
    if activity_type in _SQL_SOURCE or activity_type in _SQL_SINK:
        if activity_type.startswith("SqlServer"):
            return "SqlServerTable"
        if activity_type.startswith("SqlMI"):
            return "AzureSqlMITable"
        if activity_type.startswith("AzureSqlDW"):
            return "AzureSqlDWTable"
        return "AzureSqlTable"
    if activity_type.startswith("Parquet"):
        return "Parquet"
    if activity_type.startswith("DelimitedText"):
        return "DelimitedText"
    if activity_type.startswith("Json"):
        return "Json"
    if activity_type.startswith("AzureTable"):
        return "AzureTable"
    return "Binary"


def _dataset_type_props(ds_type: str, table_or_path: str | None) -> dict[str, Any]:
    if ds_type.endswith("Table") and ds_type != "AzureTable":
        schema, table = _split_table(table_or_path or "")
        return {"schema": schema, "table": table}
    if ds_type == "AzureTable":
        return {"tableName": table_or_path or ""}
    path = (table_or_path or "").lstrip("/")
    seg = path.split("/")
    file_system = seg.pop(0) if seg else ""
    folder_path = "/".join(seg)
    loc: dict[str, Any] = {"type": "AzureBlobFSLocation", "fileSystem": file_system}
    if folder_path:
        loc["folderPath"] = folder_path
    return {"location": loc}


def _build_dataset(name: str, activity_type: str, linked_service: str, table_or_path: str | None) -> dict[str, Any]:
    ds_type = _dataset_type(activity_type)
    return {
        "name": name,
        "properties": {
            "type": ds_type,
            "linkedServiceName": {"referenceName": linked_service, "type": "LinkedServiceReference"},
            "schema": [],
            "typeProperties": _dataset_type_props(ds_type, table_or_path),
        },
    }


def _translator(mappings: list[dict[str, str]] | None) -> dict[str, Any] | None:
    if not mappings:
        return None
    return {
        "type": "TabularTranslator",
        "mappings": [{"source": {"name": m.get("source")}, "sink": {"name": m.get("sink")}} for m in mappings],
    }


def _sink_props(spec: dict[str, Any]) -> dict[str, Any]:
    sink = spec["sink"]
    type_ = sink["type"]
    sink_table = sink.get("table") or ""
    write_mode = spec.get("writeMode")
    props: dict[str, Any] = {"type": type_}
    if _is_sql_sink(type_):
        if write_mode == "Overwrite" and sink_table:
            props["preCopyScript"] = f"TRUNCATE TABLE {sink_table}"
        elif write_mode == "Merge":
            keys = [k.strip() for k in (spec.get("mergeKeys") or "").split(",") if k.strip()]
            props["writeBehavior"] = "upsert"
            props["upsertSettings"] = {"useTempDB": True, "keys": keys}
            props["sqlWriterUseTableLock"] = False
    else:
        store: dict[str, Any] = {"type": "AzureBlobFSWriteSettings"}
        if write_mode == "Overwrite":
            store["copyBehavior"] = "Overwrite"
        props["storeSettings"] = store
    return props


def _full_pipeline(name: str, spec: dict[str, Any], src_ds: str, snk_ds: str) -> dict[str, Any]:
    src = spec["source"]
    src_query = src.get("query") or (
        f"SELECT * FROM {src['sourceTable']}" if _is_sql_source(src["type"]) and src.get("sourceTable") else None
    )
    tx = _translator(spec.get("mappings"))
    source_tp: dict[str, Any] = {"type": src["type"]}
    if src_query:
        source_tp["sqlReaderQuery"] = src_query
    type_props: dict[str, Any] = {"source": source_tp, "sink": _sink_props(spec), "enableStaging": False}
    if tx:
        type_props["translator"] = tx
    return {
        "name": f"loom-copy-{name}",
        "properties": {
            "description": f"Loom copy-job {name} (Full · {spec.get('writeMode') or 'Append'})",
            "activities": [{
                "name": "Copy", "type": "Copy",
                "inputs": [{"referenceName": src_ds, "type": "DatasetReference"}],
                "outputs": [{"referenceName": snk_ds, "type": "DatasetReference"}],
                "typeProperties": type_props,
            }],
            "annotations": ["loom", "copy-job", name, "full"],
        },
    }


def _incremental_pipeline(name: str, spec: dict[str, Any], src_ds: str, snk_ds: str) -> dict[str, Any]:
    src = spec["source"]
    source_table = src["sourceTable"]
    wm = spec["watermarkCol"]
    source_name = spec.get("sourceName") or source_table
    tx = _translator(spec.get("mappings"))
    old_val = "@{activity('LookupOldWatermark').output.resultSets[0].rows[0].last_value}"
    new_val = "@{activity('LookupNewWatermark').output.resultSets[0].rows[0].new_value}"
    bounded_query = f"SELECT * FROM {source_table} WHERE {wm} > '{old_val}' AND {wm} <= '{new_val}'"
    copy_tp: dict[str, Any] = {"source": {"type": src["type"], "sqlReaderQuery": bounded_query}, "sink": _sink_props(spec), "enableStaging": False}
    if tx:
        copy_tp["translator"] = tx
    return {
        "name": f"loom-copy-{name}",
        "properties": {
            "description": f"Loom copy-job {name} (Incremental · watermark {wm})",
            "activities": [
                {
                    "name": "LookupOldWatermark", "type": "Script",
                    "linkedServiceName": {"referenceName": _CONTROL_LS, "type": "LinkedServiceReference"},
                    "typeProperties": {"scripts": [{"type": "Query", "text":
                        f"SELECT ISNULL(last_value, '1900-01-01T00:00:00Z') AS last_value "
                        f"FROM dbo.copy_watermark WHERE source = '{source_name}' AND table_name = '{source_table}'"}]},
                },
                {
                    "name": "LookupNewWatermark", "type": "Script",
                    "linkedServiceName": {"referenceName": src["linkedService"], "type": "LinkedServiceReference"},
                    "typeProperties": {"scripts": [{"type": "Query", "text": f"SELECT MAX({wm}) AS new_value FROM {source_table}"}]},
                },
                {
                    "name": "IncrementalCopyActivity", "type": "Copy",
                    "dependsOn": [
                        {"activity": "LookupOldWatermark", "dependencyConditions": ["Succeeded"]},
                        {"activity": "LookupNewWatermark", "dependencyConditions": ["Succeeded"]},
                    ],
                    "inputs": [{"referenceName": src_ds, "type": "DatasetReference"}],
                    "outputs": [{"referenceName": snk_ds, "type": "DatasetReference"}],
                    "typeProperties": copy_tp,
                },
                {
                    "name": "UpdateWatermark", "type": "SqlServerStoredProcedure",
                    "dependsOn": [{"activity": "IncrementalCopyActivity", "dependencyConditions": ["Succeeded"]}],
                    "linkedServiceName": {"referenceName": _CONTROL_LS, "type": "LinkedServiceReference"},
                    "typeProperties": {"storedProcedureName": "dbo.usp_write_watermark", "storedProcedureParameters": {
                        "source": {"value": source_name, "type": "String"},
                        "table_name": {"value": source_table, "type": "String"},
                        "last_value": {"value": new_val, "type": "String"},
                    }},
                },
            ],
            "annotations": ["loom", "copy-job", name, "incremental"],
        },
    }


def _default_capture_instance(source_table: str) -> str:
    schema, table = _split_table(source_table)
    return f"{schema}_{table}"


def _cdc_pipeline(name: str, spec: dict[str, Any], src_ds: str, snk_ds: str) -> dict[str, Any]:
    src = spec["source"]
    source_table = src["sourceTable"]
    source_name = spec.get("sourceName") or source_table
    capture_instance = spec.get("cdcCaptureInstance") or _default_capture_instance(source_table)
    tx = _translator(spec.get("mappings"))
    old_lsn_hex = "@{activity('LookupOldLsn').output.resultSets[0].rows[0].last_lsn_hex}"
    max_lsn_hex = "@{activity('LookupMaxLsn').output.resultSets[0].rows[0].max_lsn_hex}"
    net_changes_query = (
        f"DECLARE @from_lsn binary(10) = CONVERT(binary(10), '{old_lsn_hex}', 1); "
        f"DECLARE @to_lsn binary(10) = CONVERT(binary(10), '{max_lsn_hex}', 1); "
        f"IF @from_lsn IS NULL SET @from_lsn = sys.fn_cdc_get_min_lsn('{capture_instance}'); "
        f"ELSE SET @from_lsn = sys.fn_cdc_increment_lsn(@from_lsn); "
        f"SELECT * FROM cdc.fn_cdc_get_net_changes_{capture_instance}(@from_lsn, @to_lsn, 'all');"
    )
    copy_tp: dict[str, Any] = {"source": {"type": src["type"], "sqlReaderQuery": net_changes_query}, "sink": _sink_props(spec), "enableStaging": False}
    if tx:
        copy_tp["translator"] = tx
    return {
        "name": f"loom-copy-{name}",
        "properties": {
            "description": f"Loom copy-job {name} (CDC · capture {capture_instance})",
            "activities": [
                {
                    "name": "LookupOldLsn", "type": "Script",
                    "linkedServiceName": {"referenceName": _CONTROL_LS, "type": "LinkedServiceReference"},
                    "typeProperties": {"scripts": [{"type": "Query", "text":
                        f"SELECT last_value AS last_lsn_hex "
                        f"FROM dbo.copy_watermark WHERE source = '{source_name}' AND table_name = '{source_table}'"}]},
                },
                {
                    "name": "LookupMaxLsn", "type": "Script",
                    "linkedServiceName": {"referenceName": src["linkedService"], "type": "LinkedServiceReference"},
                    "typeProperties": {"scripts": [{"type": "Query", "text":
                        "SELECT master.dbo.fn_varbintohexstr(sys.fn_cdc_get_max_lsn()) AS max_lsn_hex"}]},
                },
                {
                    "name": "CdcCopyActivity", "type": "Copy",
                    "dependsOn": [
                        {"activity": "LookupOldLsn", "dependencyConditions": ["Succeeded"]},
                        {"activity": "LookupMaxLsn", "dependencyConditions": ["Succeeded"]},
                    ],
                    "inputs": [{"referenceName": src_ds, "type": "DatasetReference"}],
                    "outputs": [{"referenceName": snk_ds, "type": "DatasetReference"}],
                    "typeProperties": copy_tp,
                },
                {
                    "name": "UpdateWatermark", "type": "SqlServerStoredProcedure",
                    "dependsOn": [{"activity": "CdcCopyActivity", "dependencyConditions": ["Succeeded"]}],
                    "linkedServiceName": {"referenceName": _CONTROL_LS, "type": "LinkedServiceReference"},
                    "typeProperties": {"storedProcedureName": "dbo.usp_write_watermark", "storedProcedureParameters": {
                        "source": {"value": source_name, "type": "String"},
                        "table_name": {"value": source_table, "type": "String"},
                        "last_value": {"value": max_lsn_hex, "type": "String"},
                    }},
                },
            ],
            "annotations": ["loom", "copy-job", name, "cdc"],
        },
    }


def _validate_side(side: Any, which: str) -> dict[str, Any]:
    if not isinstance(side, dict):
        raise ToolError(f"`{which}` must be an object with at least `linkedService` and `type`.")
    if not (side.get("linkedService") or "").strip():
        raise ToolError(f"`{which}.linkedService` is required (the ADF linked service name for the {which}).")
    if not (side.get("type") or "").strip():
        raise ToolError(f"`{which}.type` is required (e.g. AzureSqlSource / ParquetSink).")
    return side


def _run_copy_job(args: dict[str, Any]) -> dict[str, Any]:
    name = _validate_name(args.get("name", ""))
    source = _validate_side(args.get("source"), "source")
    sink = _validate_side(args.get("sink"), "sink")
    if not (sink.get("table") or "").strip():
        raise ToolError("`sink.table` (the destination table or path) is required.")
    mode_in = (args.get("mode") or "Full")
    mode = "Incremental" if mode_in == "Incremental" else "CDC" if mode_in == "CDC" else "Full"
    write_mode = args.get("writeMode")
    mappings = args.get("mappings")
    if mappings is not None and not isinstance(mappings, list):
        raise ToolError("`mappings` must be an array of {source, sink} column-mapping objects.")
    spec: dict[str, Any] = {
        "source": source, "sink": sink, "mode": mode, "writeMode": write_mode,
        "watermarkCol": args.get("watermarkCol"), "sourceName": args.get("sourceName"),
        "cdcCaptureInstance": args.get("cdcCaptureInstance"), "mergeKeys": args.get("mergeKeys"),
        "mappings": mappings,
    }

    uses_control = mode in ("Incremental", "CDC")
    if mode == "Incremental":
        if not (source.get("sourceTable") or "").strip():
            raise ToolError("`source.sourceTable` is required for incremental copy.")
        if not (spec.get("watermarkCol") or "").strip():
            raise ToolError("`watermarkCol` is required for incremental copy.")
        if not _is_sql_source(source["type"]):
            raise ToolError("incremental copy requires a SQL-family source (the watermark is read with MAX(<column>) against the source table).")
    if mode == "CDC":
        if not (source.get("sourceTable") or "").strip():
            raise ToolError("`source.sourceTable` is required for CDC copy.")
        if not _is_sql_source(source["type"]):
            raise ToolError("CDC copy requires a SQL-family source (Azure SQL / SQL Server / SQL MI) with native change data capture enabled.")
        if write_mode != "Merge" or not (spec.get("mergeKeys") or "").strip():
            raise ToolError("CDC copy applies net changes by key — set `writeMode` to Merge and provide `mergeKeys`.")

    control_server = (os.environ.get("LOOM_COPYJOB_CONTROL_SQL_SERVER") or "").strip()
    if uses_control and not control_server:
        checkpoint = "LSN checkpoint" if mode == "CDC" else "watermark"
        raise ToolError(
            f"LOOM_COPYJOB_CONTROL_SQL_SERVER is not set on the MCP Function App, so the {checkpoint} "
            "control table cannot be reached. Deploy "
            "platform/fiab/bicep/modules/admin-plane/copy-job-control.bicep (it creates dbo.copy_watermark + "
            "dbo.usp_write_watermark) and set LOOM_COPYJOB_CONTROL_SQL_SERVER (+ LOOM_COPYJOB_CONTROL_SQL_DB) "
            "on the MCP Function App. Full-mode copy works without this."
        )

    # Datasets — real ADF child resources referenced by the Copy activity.
    src_ds = f"loom-copy-{name}-src"
    snk_ds = f"loom-copy-{name}-snk"
    _ok_json(_arm_request("PUT", f"/datasets/{src_ds}", body=_build_dataset(src_ds, source["type"], source["linkedService"], source.get("sourceTable"))), f"upsert dataset {src_ds}")
    _ok_json(_arm_request("PUT", f"/datasets/{snk_ds}", body=_build_dataset(snk_ds, sink["type"], sink["linkedService"], sink.get("table"))), f"upsert dataset {snk_ds}")

    if uses_control:
        control_db = (os.environ.get("LOOM_COPYJOB_CONTROL_SQL_DB") or "loom-control").strip() or "loom-control"
        control_ls = {
            "name": _CONTROL_LS,
            "properties": {
                "type": "AzureSqlDatabase",
                "description": "Loom copy-job watermark / CDC LSN checkpoint control DB (dbo.copy_watermark).",
                "typeProperties": {
                    "server": control_server,
                    "database": control_db,
                    "authenticationType": "SystemAssignedManagedIdentity",
                },
            },
        }
        _ok_json(_arm_request("PUT", f"/linkedservices/{_CONTROL_LS}", body=control_ls), f"upsert linked service {_CONTROL_LS}")

    pipeline_name = f"loom-copy-{name}"
    pipeline = (
        _incremental_pipeline(name, spec, src_ds, snk_ds) if mode == "Incremental"
        else _cdc_pipeline(name, spec, src_ds, snk_ds) if mode == "CDC"
        else _full_pipeline(name, spec, src_ds, snk_ds)
    )
    _ok_json(_arm_request("PUT", f"/pipelines/{pipeline_name}", body=pipeline), f"upsert pipeline {pipeline_name}")
    run = _ok_json(_arm_request("POST", f"/pipelines/{pipeline_name}/createRun", body={}), f"run copy job {name}")
    return {"copyJob": name, "pipelineName": pipeline_name, "mode": mode, "runId": run.get("runId"), "started": True}


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
            Tool(
                "loom_get_dataflow",
                "Get the full definition (type, sources, script, sinks) of one data flow. Read-only.",
                {
                    "type": "object",
                    "properties": {"name": {"type": "string", "description": "Data flow name."}},
                    "required": ["name"],
                },
                _get_dataflow,
            ),
            Tool(
                "loom_author_dataflow",
                "Create or update a Power Query (Dataflow Gen2 / WranglingDataFlow) data flow from an M "
                "mashup `script`. `sources` binds query names in the script to existing ADF datasets. "
                "Azure-native, no Microsoft Fabric. Requires Data Factory Contributor.",
                {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "description": "Data flow name (1-140 chars, [A-Za-z0-9_-])."},
                        "script": {"type": "string", "description": "The Power Query / M mashup text (the dataflow's content)."},
                        "sources": {
                            "type": "array",
                            "description": "Bind each M query that reads from a connector to an ADF dataset. Inline #table() queries need no source.",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "name": {"type": "string", "description": "Query name in the M script."},
                                    "datasetName": {"type": "string", "description": "ADF dataset the query reads from."},
                                },
                                "required": ["name"],
                            },
                        },
                    },
                    "required": ["name", "script"],
                },
                _author_dataflow,
            ),
            Tool(
                "loom_run_dataflow",
                "Run a Power Query (Dataflow Gen2) data flow via an ExecuteWranglingDataflow wrapper "
                "pipeline and return its runId. `sinks` map output queries to destination datasets. "
                "Requires Data Factory Contributor.",
                {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "description": "Data flow name to run."},
                        "sinks": {
                            "type": "array",
                            "description": "Map each output query to an ADF dataset to write its result to.",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "queryName": {"type": "string", "description": "Output query whose result is written."},
                                    "sinkName": {"type": "string", "description": "Unique sink name within the activity."},
                                    "datasetName": {"type": "string", "description": "Destination ADF dataset."},
                                },
                                "required": ["queryName", "sinkName", "datasetName"],
                            },
                        },
                        "computeType": {"type": "string", "description": "Spark compute type (General / MemoryOptimized / ComputeOptimized). Default General."},
                        "coreCount": {"type": "integer", "description": "Spark core count (default 8)."},
                    },
                    "required": ["name"],
                },
                _run_dataflow,
            ),
            Tool(
                "loom_run_copy_job",
                "Run a Loom copy job: materialise a Full / Incremental-watermark / native-CDC copy into a "
                "real ADF pipeline (+ its source/sink datasets) and trigger it. Simplified data movement "
                "(Fabric Copy job parity) on Azure Data Factory — no Microsoft Fabric. Incremental/CDC "
                "require LOOM_COPYJOB_CONTROL_SQL_SERVER (honest gate otherwise). Requires Data Factory Contributor.",
                {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "description": "Copy-job name; derives pipeline `loom-copy-<name>` and datasets."},
                        "source": {
                            "type": "object",
                            "description": "Source binding.",
                            "properties": {
                                "linkedService": {"type": "string", "description": "ADF linked service name for the source store."},
                                "type": {"type": "string", "description": "Copy source type, e.g. AzureSqlSource, ParquetSource."},
                                "sourceTable": {"type": "string", "description": "Source table (schema.table) — required for Incremental/CDC."},
                                "query": {"type": "string", "description": "Optional explicit source query (Full mode)."},
                            },
                            "required": ["linkedService", "type"],
                        },
                        "sink": {
                            "type": "object",
                            "description": "Destination binding.",
                            "properties": {
                                "linkedService": {"type": "string", "description": "ADF linked service name for the sink store."},
                                "type": {"type": "string", "description": "Copy sink type, e.g. AzureSqlSink, ParquetSink."},
                                "table": {"type": "string", "description": "Destination table (schema.table) or file path."},
                            },
                            "required": ["linkedService", "type", "table"],
                        },
                        "mode": {"type": "string", "enum": ["Full", "Incremental", "CDC"], "description": "Copy mode (default Full)."},
                        "writeMode": {"type": "string", "enum": ["Append", "Overwrite", "Merge"], "description": "Sink write behaviour. Merge required for CDC."},
                        "watermarkCol": {"type": "string", "description": "Watermark column (Incremental mode)."},
                        "sourceName": {"type": "string", "description": "Logical source key in the watermark control table (defaults to sourceTable)."},
                        "cdcCaptureInstance": {"type": "string", "description": "SQL Server CDC capture instance (CDC mode; defaults to <schema>_<table>)."},
                        "mergeKeys": {"type": "string", "description": "Comma-separated upsert/merge key columns (Merge / CDC)."},
                        "mappings": {
                            "type": "array",
                            "description": "Optional column mappings.",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "source": {"type": "string"},
                                    "sink": {"type": "string"},
                                },
                                "required": ["source", "sink"],
                            },
                        },
                    },
                    "required": ["name", "source", "sink"],
                },
                _run_copy_job,
            ),
        ]
    }
