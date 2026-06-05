"""Unit tests for the Loom MCP Function server.

These exercise the JSON-RPC routing + auth without touching Azure: the tool
handlers are swapped for fakes, so no managed identity / network is required.
"""

import json
import os

import pytest

import function_app  # type: ignore
import mcp_tools  # type: ignore


class _Req:
    """Minimal func.HttpRequest stand-in."""

    def __init__(self, body, headers=None):
        self._body = body
        self.headers = headers or {}

    def get_json(self):
        if isinstance(self._body, (dict, list)):
            return self._body
        raise ValueError("not json")


@pytest.fixture(autouse=True)
def _env_and_tools(monkeypatch):
    monkeypatch.setenv("LOOM_MCP_API_KEY", "secret-key")

    def _echo(args):
        return {"echo": args}

    fake = mcp_tools.Tool("loom_echo", "echo", {"type": "object"}, _echo)
    monkeypatch.setattr(mcp_tools, "TOOLS", {"loom_echo": fake})
    yield


def _call(body, headers=None):
    resp = function_app.mcp(_Req(body, headers))
    return resp


def test_health_lists_tools():
    resp = function_app.health(_Req(None))
    data = json.loads(resp.get_body())
    assert data["ok"] is True
    assert data["protocolVersion"] == function_app.MCP_PROTOCOL_VERSION
    assert data["apiKeyConfigured"] is True


def test_unauthorized_without_key():
    resp = _call({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert resp.status_code == 401


def test_503_when_key_unset(monkeypatch):
    monkeypatch.delenv("LOOM_MCP_API_KEY", raising=False)
    resp = _call({"jsonrpc": "2.0", "id": 1, "method": "tools/list"}, {"x-api-key": "secret-key"})
    assert resp.status_code == 503
    assert "LOOM_MCP_API_KEY" in json.loads(resp.get_body())["error"]


def test_initialize_handshake():
    resp = _call({"jsonrpc": "2.0", "id": 1, "method": "initialize"}, {"x-api-key": "secret-key"})
    data = json.loads(resp.get_body())
    assert data["result"]["serverInfo"]["name"] == "csa-loom-mcp"
    assert "tools" in data["result"]["capabilities"]


def test_initialized_notification_returns_202():
    resp = _call({"jsonrpc": "2.0", "method": "notifications/initialized"}, {"x-api-key": "secret-key"})
    assert resp.status_code == 202


def test_tools_list():
    resp = _call({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}, {"x-api-key": "secret-key"})
    data = json.loads(resp.get_body())
    names = [t["name"] for t in data["result"]["tools"]]
    assert names == ["loom_echo"]


def test_tools_call_executes_handler():
    resp = _call(
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "loom_echo", "arguments": {"a": 1}}},
        {"authorization": "Bearer secret-key"},
    )
    data = json.loads(resp.get_body())
    assert data["result"]["isError"] is False
    inner = json.loads(data["result"]["content"][0]["text"])
    assert inner == {"echo": {"a": 1}}


def test_tools_call_unknown_tool():
    resp = _call(
        {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {"name": "nope"}},
        {"x-api-key": "secret-key"},
    )
    data = json.loads(resp.get_body())
    assert data["error"]["code"] == -32602


def test_tool_error_surfaces_as_isError(monkeypatch):
    def _boom(args):
        raise mcp_tools.ToolError("AI Search is not configured")

    monkeypatch.setattr(mcp_tools, "TOOLS", {"loom_x": mcp_tools.Tool("loom_x", "x", {"type": "object"}, _boom)})
    resp = _call(
        {"jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": {"name": "loom_x"}},
        {"x-api-key": "secret-key"},
    )
    data = json.loads(resp.get_body())
    assert data["result"]["isError"] is True
    assert "not configured" in data["result"]["content"][0]["text"]
