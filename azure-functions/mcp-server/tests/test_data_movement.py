"""Unit tests for the Loom MCP data-movement tools.

These exercise the tool registry, the honest config gates, name validation, and
each handler with a faked ARM HTTP layer + faked managed-identity token — no
Azure / network is touched.
"""

import json

import pytest

import mcp_tools  # type: ignore
import mcp_tools_data_movement as dm  # type: ignore


# ── fakes ──────────────────────────────────────────────────────────────────────

class _FakeResp:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload
        self.text = text or (json.dumps(payload) if payload is not None else "")
        self.content = self.text.encode() if self.text else b""

    def json(self):
        if self._payload is None:
            raise ValueError("no json")
        return self._payload


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("LOOM_SUBSCRIPTION_ID", "sub-1")
    monkeypatch.setenv("LOOM_DLZ_RG", "rg-dlz")
    monkeypatch.setenv("LOOM_ADF_NAME", "adf-loom")
    # Never hit real managed identity.
    monkeypatch.setattr(dm, "_arm_token", lambda: "fake-token")
    yield


def _stub_arm(monkeypatch, handler):
    """handler(method, path, body) -> _FakeResp"""
    captured = {}

    def _fake(method, path, *, body=None, params=None, timeout=60):
        captured["method"] = method
        captured["path"] = path
        captured["body"] = body
        captured["params"] = params
        return handler(method, path, body)

    monkeypatch.setattr(dm, "_arm_request", _fake)
    return captured


# ── registry ───────────────────────────────────────────────────────────────────

def test_data_movement_tools_registered_in_main_registry():
    names = set(mcp_tools.TOOLS.keys())
    for expected in [
        "loom_list_pipelines",
        "loom_get_pipeline",
        "loom_list_dataflows",
        "loom_upsert_pipeline",
        "loom_validate_pipeline",
        "loom_run_pipeline",
        "loom_list_pipeline_runs",
        "loom_diagnose_run",
    ]:
        assert expected in names, f"{expected} not registered"


def test_each_tool_has_a_valid_manifest():
    tools = dm.build_tools()
    for tool in tools.values():
        m = tool.manifest()
        assert m["name"].startswith("loom_")
        assert m["description"]
        assert m["inputSchema"]["type"] == "object"


# ── honest gates ─────────────────────────────────────────────────────────────────

def test_missing_adf_name_is_honest_gate(monkeypatch):
    monkeypatch.delenv("LOOM_ADF_NAME", raising=False)
    with pytest.raises(dm.ToolError) as ei:
        dm._list_pipelines({})
    assert "LOOM_ADF_NAME" in str(ei.value)


def test_missing_rg_is_honest_gate(monkeypatch):
    monkeypatch.delenv("LOOM_DLZ_RG", raising=False)
    with pytest.raises(dm.ToolError) as ei:
        dm._list_pipelines({})
    assert "LOOM_DLZ_RG" in str(ei.value)


# ── name validation ──────────────────────────────────────────────────────────────

def test_get_pipeline_requires_name():
    with pytest.raises(dm.ToolError):
        dm._get_pipeline({})


def test_invalid_name_rejected():
    with pytest.raises(dm.ToolError) as ei:
        dm._upsert_pipeline({"name": "bad name!", "activities": []})
    assert "1-140" in str(ei.value)


# ── consume ──────────────────────────────────────────────────────────────────────

def test_list_pipelines_maps_activity_counts(monkeypatch):
    payload = {"value": [
        {"name": "p1", "properties": {"activities": [{}, {}], "description": "d"}},
        {"name": "p2", "properties": {"activities": []}},
    ]}
    cap = _stub_arm(monkeypatch, lambda m, p, b: _FakeResp(200, payload))
    out = dm._list_pipelines({})
    assert cap["method"] == "GET" and cap["path"] == "/pipelines"
    assert out["count"] == 2
    assert out["pipelines"][0] == {"name": "p1", "activities": 2, "description": "d", "folder": None}


def test_list_dataflows(monkeypatch):
    payload = {"value": [{"name": "df1", "properties": {"type": "MappingDataFlow"}}]}
    _stub_arm(monkeypatch, lambda m, p, b: _FakeResp(200, payload))
    out = dm._list_dataflows({})
    assert out["count"] == 1
    assert out["dataflows"][0]["type"] == "MappingDataFlow"


def test_get_pipeline_returns_properties(monkeypatch):
    payload = {"name": "p1", "properties": {"activities": [{"name": "Copy"}]}}
    _stub_arm(monkeypatch, lambda m, p, b: _FakeResp(200, payload))
    out = dm._get_pipeline({"name": "p1"})
    assert out["name"] == "p1"
    assert out["properties"]["activities"][0]["name"] == "Copy"


# ── author ───────────────────────────────────────────────────────────────────────

def test_upsert_pipeline_from_activities(monkeypatch):
    def _h(m, p, b):
        assert m == "PUT"
        assert p == "/pipelines/p-new"
        assert b["properties"]["activities"] == [{"name": "Copy", "type": "Copy"}]
        return _FakeResp(200, {"name": "p-new", "properties": b["properties"]})

    _stub_arm(monkeypatch, _h)
    out = dm._upsert_pipeline({"name": "p-new", "activities": [{"name": "Copy", "type": "Copy"}]})
    assert out == {"name": "p-new", "activities": 1, "saved": True}


def test_upsert_pipeline_requires_activities_or_properties():
    with pytest.raises(dm.ToolError):
        dm._upsert_pipeline({"name": "p1"})


def test_validate_pipeline_by_value(monkeypatch):
    def _h(m, p, b):
        assert m == "POST" and p == "/validatePipeline"
        return _FakeResp(200, {"activities": [{"name": "Copy"}]})

    _stub_arm(monkeypatch, _h)
    out = dm._validate_pipeline({"activities": [{"name": "Copy", "type": "Copy"}]})
    assert out["valid"] is True
    assert out["status"] == 200


def test_validate_pipeline_surfaces_error(monkeypatch):
    def _h(m, p, b):
        return _FakeResp(400, {"error": {"code": "BadRequest", "message": "boom"}})

    _stub_arm(monkeypatch, _h)
    out = dm._validate_pipeline({"name": "p1"})
    assert out["valid"] is False
    assert out["status"] == 400
    assert out["error"]["message"] == "boom"


# ── run ──────────────────────────────────────────────────────────────────────────

def test_run_pipeline_returns_run_id(monkeypatch):
    def _h(m, p, b):
        assert m == "POST" and p == "/pipelines/p1/createRun"
        assert b == {"k": "v"}
        return _FakeResp(200, {"runId": "run-123"})

    _stub_arm(monkeypatch, _h)
    out = dm._run_pipeline({"name": "p1", "parameters": {"k": "v"}})
    assert out == {"pipeline": "p1", "runId": "run-123", "started": True}


def test_run_pipeline_rejects_non_object_parameters():
    with pytest.raises(dm.ToolError):
        dm._run_pipeline({"name": "p1", "parameters": [1, 2]})


# ── diagnose ─────────────────────────────────────────────────────────────────────

def test_list_pipeline_runs_filters_and_maps(monkeypatch):
    payload = {"value": [
        {"runId": "r1", "pipelineName": "p1", "status": "Succeeded", "durationInMs": 100},
        {"runId": "r2", "pipelineName": "p1", "status": "Failed", "message": "err"},
    ]}

    def _h(m, p, b):
        assert m == "POST" and p == "/queryPipelineRuns"
        assert b["filters"][0]["values"] == ["p1"]
        return _FakeResp(200, payload)

    _stub_arm(monkeypatch, _h)
    out = dm._list_pipeline_runs({"pipeline": "p1", "top": 5})
    assert out["count"] == 2
    assert out["runs"][1]["status"] == "Failed"


def test_diagnose_run_extracts_failed_activities(monkeypatch):
    payload = {"value": [
        {"activityName": "Lookup", "activityType": "Lookup", "status": "Succeeded"},
        {"activityName": "Copy", "activityType": "Copy", "status": "Failed",
         "error": {"errorCode": "2200", "message": "sink failed", "failureType": "UserError"}},
    ]}

    def _h(m, p, b):
        assert p == "/pipelineruns/run-1/queryActivityruns"
        return _FakeResp(200, payload)

    _stub_arm(monkeypatch, _h)
    out = dm._diagnose_run({"runId": "run-1"})
    assert out["activityCount"] == 2
    assert out["failedCount"] == 1
    failed = [a for a in out["activities"] if a["status"] == "Failed"][0]
    assert failed["error"]["message"] == "sink failed"


def test_diagnose_run_requires_run_id():
    with pytest.raises(dm.ToolError):
        dm._diagnose_run({})


def test_arm_error_surfaces_as_tool_error(monkeypatch):
    _stub_arm(monkeypatch, lambda m, p, b: _FakeResp(403, None, text="Forbidden"))
    with pytest.raises(dm.ToolError) as ei:
        dm._list_pipelines({})
    assert "403" in str(ei.value)
