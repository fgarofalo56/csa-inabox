"""Vetted Loom MCP tool registry.

Each tool is a small, **read-only**, governance-safe operation backed by a real
Azure REST call using the Function App's managed identity (via DefaultAzure-
Credential). No mocks, no write operations — per .claude/rules/no-vaporware.md.

Tools exposed:

- ``loom_search_catalog``   — query the Loom AI Search ``loom-items`` index.
- ``loom_list_resources``   — list Azure resources in the configured Loom RGs.
- ``loom_list_deployments`` — list recent ARM/bicep deployments in those RGs.

Each tool declares a JSON-Schema ``inputSchema`` (MCP requirement) and a handler
that returns a JSON-serialisable result. Handlers raise ``ToolError`` with a
precise, honest message when the backing service isn't configured (the MCP
client surfaces it verbatim — an honest gate, not a fake empty result).
"""

from __future__ import annotations

import os
from typing import Any, Callable

import httpx
from azure.identity import DefaultAzureCredential

ARM_BASE = os.environ.get("LOOM_ARM_ENDPOINT", "https://management.azure.com").rstrip("/")
ARM_SCOPE = os.environ.get("LOOM_ARM_SCOPE", "https://management.azure.com/.default")
DEPLOYMENTS_API = "2021-04-01"
RESOURCES_API = "2021-04-01"


class ToolError(Exception):
    """Raised by a tool handler when its backend is unreachable/unconfigured.

    The message is surfaced verbatim to the MCP client as an honest gate.
    """


# ── shared credential (lazy) ────────────────────────────────────────────────

_cred: DefaultAzureCredential | None = None


def _credential() -> DefaultAzureCredential:
    global _cred
    if _cred is None:
        _cred = DefaultAzureCredential()
    return _cred


def _arm_token() -> str:
    try:
        return _credential().get_token(ARM_SCOPE).token
    except Exception as e:  # pragma: no cover - environment dependent
        raise ToolError(
            "Could not acquire an ARM token via managed identity. Grant the MCP "
            "Function App's identity Reader on the Loom resource groups and ensure "
            "it runs with a managed identity."
        ) from e


def _loom_resource_groups() -> list[str]:
    raw = os.environ.get("LOOM_RESOURCE_GROUPS", "")
    return [s.strip() for s in raw.split(",") if s.strip()]


def _subscription_id() -> str:
    sub = os.environ.get("LOOM_SUBSCRIPTION_ID", "")
    if not sub:
        raise ToolError(
            "LOOM_SUBSCRIPTION_ID is not set on the MCP Function App. Set it to the "
            "subscription that hosts the Loom deployment."
        )
    return sub


# ── tool: search catalog (AI Search) ────────────────────────────────────────

def _search_catalog(args: dict[str, Any]) -> dict[str, Any]:
    query = str(args.get("query", "")).strip()
    top = int(args.get("top", 10))
    top = max(1, min(top, 50))
    if not query:
        raise ToolError("`query` is required.")

    svc = os.environ.get("LOOM_AI_SEARCH_SERVICE", "")
    index = os.environ.get("LOOM_AI_SEARCH_INDEX", "loom-items")
    if not svc:
        raise ToolError(
            "AI Search is not configured on the MCP Function App. Set "
            "LOOM_AI_SEARCH_SERVICE (and optionally LOOM_AI_SEARCH_INDEX, default "
            "'loom-items') to enable catalog search."
        )

    endpoint = svc if svc.startswith("http") else f"https://{svc}.search.windows.net"
    api_version = os.environ.get("LOOM_AI_SEARCH_API_VERSION", "2024-07-01")
    url = f"{endpoint}/indexes/{index}/docs/search?api-version={api_version}"

    # Prefer AAD (managed identity) against the search data plane; fall back to
    # an admin/query key only if explicitly provided.
    headers = {"content-type": "application/json"}
    key = os.environ.get("LOOM_AI_SEARCH_KEY", "")
    if key:
        headers["api-key"] = key
    else:
        try:
            token = _credential().get_token("https://search.azure.com/.default").token
            headers["authorization"] = f"Bearer {token}"
        except Exception as e:  # pragma: no cover
            raise ToolError(
                "No LOOM_AI_SEARCH_KEY set and could not acquire a search AAD token. "
                "Grant the MCP identity 'Search Index Data Reader' or set a query key."
            ) from e

    body = {"search": query, "top": top, "queryType": "simple"}
    with httpx.Client(timeout=20) as client:
        r = client.post(url, headers=headers, json=body)
    if r.status_code >= 400:
        raise ToolError(f"AI Search returned {r.status_code}: {r.text[:200]}")
    docs = r.json().get("value", [])
    results = [
        {
            "id": d.get("id") or d.get("itemId"),
            "name": d.get("displayName") or d.get("name"),
            "type": d.get("itemType") or d.get("type"),
            "workspace": d.get("workspaceName") or d.get("workspace"),
            "score": d.get("@search.score"),
        }
        for d in docs
    ]
    return {"query": query, "count": len(results), "results": results}


# ── tool: list resources (ARM) ──────────────────────────────────────────────

def _list_resources(args: dict[str, Any]) -> dict[str, Any]:
    sub = _subscription_id()
    rgs = _loom_resource_groups()
    if not rgs:
        raise ToolError(
            "LOOM_RESOURCE_GROUPS is not set on the MCP Function App. Set it to a "
            "comma-separated list of the Loom resource groups to inspect."
        )
    type_filter = str(args.get("resource_type", "")).strip().lower()
    token = _arm_token()
    out: list[dict[str, Any]] = []
    with httpx.Client(timeout=30) as client:
        for rg in rgs:
            url = f"{ARM_BASE}/subscriptions/{sub}/resourceGroups/{rg}/resources?api-version={RESOURCES_API}"
            r = client.get(url, headers={"authorization": f"Bearer {token}"})
            if r.status_code >= 400:
                continue
            for res in r.json().get("value", []):
                rtype = (res.get("type") or "").lower()
                if type_filter and type_filter not in rtype:
                    continue
                out.append(
                    {
                        "name": res.get("name"),
                        "type": res.get("type"),
                        "location": res.get("location"),
                        "resourceGroup": rg,
                    }
                )
    return {"resourceGroups": rgs, "count": len(out), "resources": out}


# ── tool: list deployments (ARM) ─────────────────────────────────────────────

def _list_deployments(args: dict[str, Any]) -> dict[str, Any]:
    sub = _subscription_id()
    rgs = _loom_resource_groups()
    if not rgs:
        raise ToolError(
            "LOOM_RESOURCE_GROUPS is not set on the MCP Function App. Set it to a "
            "comma-separated list of the Loom resource groups to inspect."
        )
    top = int(args.get("top", 10))
    top = max(1, min(top, 50))
    token = _arm_token()
    out: list[dict[str, Any]] = []
    with httpx.Client(timeout=30) as client:
        for rg in rgs:
            url = (
                f"{ARM_BASE}/subscriptions/{sub}/resourceGroups/{rg}"
                f"/providers/Microsoft.Resources/deployments?api-version={DEPLOYMENTS_API}&$top={top}"
            )
            r = client.get(url, headers={"authorization": f"Bearer {token}"})
            if r.status_code >= 400:
                continue
            for d in r.json().get("value", []):
                props = d.get("properties", {})
                out.append(
                    {
                        "name": d.get("name"),
                        "resourceGroup": rg,
                        "provisioningState": props.get("provisioningState"),
                        "timestamp": props.get("timestamp"),
                        "mode": props.get("mode"),
                    }
                )
    out.sort(key=lambda x: x.get("timestamp") or "", reverse=True)
    return {"resourceGroups": rgs, "count": len(out), "deployments": out[:top]}


# ── registry ─────────────────────────────────────────────────────────────────

class Tool:
    def __init__(self, name: str, description: str, schema: dict[str, Any], handler: Callable[[dict[str, Any]], Any]):
        self.name = name
        self.description = description
        self.schema = schema
        self.handler = handler

    def manifest(self) -> dict[str, Any]:
        return {"name": self.name, "description": self.description, "inputSchema": self.schema}


TOOLS: dict[str, Tool] = {
    t.name: t
    for t in [
        Tool(
            "loom_search_catalog",
            "Search the Loom data catalog (AI Search 'loom-items' index) for items by keyword. Read-only.",
            {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "Search keywords."},
                    "top": {"type": "integer", "description": "Max results (1-50, default 10)."},
                },
                "required": ["query"],
            },
            _search_catalog,
        ),
        Tool(
            "loom_list_resources",
            "List Azure resources in the Loom resource groups, optionally filtered by resource type substring. Read-only.",
            {
                "type": "object",
                "properties": {
                    "resource_type": {"type": "string", "description": "Optional type substring filter, e.g. 'storageAccounts'."},
                },
            },
            _list_resources,
        ),
        Tool(
            "loom_list_deployments",
            "List recent ARM/bicep deployments in the Loom resource groups, newest first. Read-only.",
            {
                "type": "object",
                "properties": {
                    "top": {"type": "integer", "description": "Max deployments per RG (1-50, default 10)."},
                },
            },
            _list_deployments,
        ),
    ]
}
