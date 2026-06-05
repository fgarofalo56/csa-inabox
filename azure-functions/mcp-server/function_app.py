"""Azure Function: CSA Loom MCP tool server.

A Model Context Protocol (MCP) server, hosted as an Azure Function, that exposes
a **vetted, read-only subset** of Loom operations as MCP tools so any MCP client
(the Loom agent loop, Claude, VS Code, etc.) can call them.

Transport: MCP "Streamable HTTP" in **stateless JSON mode** — a single
``POST /api/mcp`` endpoint speaking JSON-RPC 2.0. The server returns
``application/json`` responses (no SSE session is required for these stateless,
request/response tool calls), which is a valid Streamable-HTTP server profile.

Methods handled:
  - ``initialize``                 → protocol handshake + capabilities
  - ``notifications/initialized``  → acknowledged (no body)
  - ``tools/list``                 → the vetted tool manifests
  - ``tools/call``                 → execute one tool, return its JSON result

Auth: every request must carry the shared API key in ``x-api-key`` (or
``Authorization: Bearer <key>``), matched against the ``LOOM_MCP_API_KEY`` app
setting (sourced from Key Vault). If the key isn't configured the server returns
an honest 503 naming the missing setting — it never serves tools anonymously.

GET ``/api/health`` is an unauthenticated liveness probe.

Per .claude/rules/no-vaporware.md every tool calls a real Azure backend; there
are no mock results. Per .claude/rules/no-fabric-dependency.md the tools are all
Azure-native (AI Search, ARM) — no Fabric dependency.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
from typing import Any

import azure.functions as func

import mcp_tools  # type: ignore

app = func.FunctionApp()
logger = logging.getLogger(__name__)

MCP_PROTOCOL_VERSION = "2025-06-18"
SERVER_INFO = {"name": "csa-loom-mcp", "version": "1.0.0"}


# ── auth ─────────────────────────────────────────────────────────────────────

def _extract_key(req: func.HttpRequest) -> str:
    key = req.headers.get("x-api-key", "")
    if not key:
        auth = req.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            key = auth[7:].strip()
    return key


def _auth_error(req: func.HttpRequest) -> dict[str, Any] | None:
    """Return an error envelope dict when auth fails, else None."""
    expected = os.environ.get("LOOM_MCP_API_KEY", "")
    if not expected:
        return {
            "status": 503,
            "message": (
                "MCP server not fully provisioned: LOOM_MCP_API_KEY app setting is "
                "missing. Set it (Key Vault secretRef) so clients can authenticate."
            ),
        }
    provided = _extract_key(req)
    if not provided or not hmac.compare_digest(provided, expected):
        return {"status": 401, "message": "Unauthorized: missing or invalid API key."}
    return None


# ── JSON-RPC helpers ─────────────────────────────────────────────────────────

def _rpc_result(req_id: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def _rpc_error(req_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": message}}


def _handle_rpc(payload: dict[str, Any]) -> dict[str, Any] | None:
    method = payload.get("method")
    req_id = payload.get("id")
    params = payload.get("params") or {}

    if method == "initialize":
        return _rpc_result(
            req_id,
            {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": SERVER_INFO,
            },
        )

    if method in ("notifications/initialized", "initialized"):
        return None  # notification — no response

    if method == "tools/list":
        return _rpc_result(req_id, {"tools": [t.manifest() for t in mcp_tools.TOOLS.values()]})

    if method == "tools/call":
        name = params.get("name")
        arguments = params.get("arguments") or {}
        tool = mcp_tools.TOOLS.get(name)
        if tool is None:
            return _rpc_error(req_id, -32602, f"Unknown tool: {name}")
        try:
            result = tool.handler(arguments)
            return _rpc_result(
                req_id,
                {"content": [{"type": "text", "text": json.dumps(result, default=str)}], "isError": False},
            )
        except mcp_tools.ToolError as e:
            # Honest gate — surfaced to the client as a tool error, not a crash.
            return _rpc_result(
                req_id,
                {"content": [{"type": "text", "text": str(e)}], "isError": True},
            )
        except Exception as e:  # pragma: no cover - defensive
            logger.exception("tool %s failed", name)
            return _rpc_result(
                req_id,
                {"content": [{"type": "text", "text": f"Tool execution error: {e}"}], "isError": True},
            )

    return _rpc_error(req_id, -32601, f"Method not found: {method}")


# ── HTTP routes ──────────────────────────────────────────────────────────────

@app.route(route="mcp", methods=["POST"], auth_level=func.AuthLevel.ANONYMOUS)
def mcp(req: func.HttpRequest) -> func.HttpResponse:
    auth_err = _auth_error(req)
    if auth_err:
        return func.HttpResponse(
            json.dumps({"ok": False, "error": auth_err["message"]}),
            status_code=auth_err["status"],
            mimetype="application/json",
        )

    try:
        body = req.get_json()
    except ValueError:
        return func.HttpResponse(
            json.dumps(_rpc_error(None, -32700, "Parse error: body is not valid JSON")),
            status_code=400,
            mimetype="application/json",
        )

    # Support a single request or a JSON-RPC batch.
    if isinstance(body, list):
        responses = [r for r in (_handle_rpc(item) for item in body) if r is not None]
        return func.HttpResponse(json.dumps(responses), mimetype="application/json")

    response = _handle_rpc(body)
    if response is None:
        # Notification — 202 Accepted with empty body.
        return func.HttpResponse("", status_code=202)
    return func.HttpResponse(json.dumps(response), mimetype="application/json")


@app.route(route="health", methods=["GET"], auth_level=func.AuthLevel.ANONYMOUS)
def health(req: func.HttpRequest) -> func.HttpResponse:
    configured = bool(os.environ.get("LOOM_MCP_API_KEY"))
    return func.HttpResponse(
        json.dumps(
            {
                "ok": True,
                "server": SERVER_INFO,
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "tools": list(mcp_tools.TOOLS.keys()),
                "apiKeyConfigured": configured,
            }
        ),
        mimetype="application/json",
    )
