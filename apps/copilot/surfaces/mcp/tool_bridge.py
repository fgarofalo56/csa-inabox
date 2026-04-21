"""Wrap :class:`apps.copilot.tools.*` tools as MCP tools.

The bridge avoids importing the ``mcp`` SDK at module top so the
Copilot package stays importable on hosts without the SDK installed.
Every public function in this module is pure Python — they translate
between MCP wire types and Copilot tool inputs / outputs but never
perform any I/O themselves.

Dependency direction is strictly one-way: the bridge depends on
:mod:`apps.copilot.tools.registry` and :mod:`apps.copilot.agent`, never
the reverse.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from apps.copilot.tools.base import MissingConfirmationTokenError, ToolInvocationError
from apps.copilot.tools.registry import ToolRegistry, ToolSpec


@dataclass(frozen=True)
class MCPToolSpec:
    """Serialisable view of a registered tool, ready for MCP advertisement."""

    name: str
    description: str
    input_schema: dict[str, Any]


def advertise_tools(registry: ToolRegistry) -> list[MCPToolSpec]:
    """Return an ordered list of :class:`MCPToolSpec` for every tool.

    MCP uses flat JSON-schema objects for tool advertising; we render
    the Pydantic input model's schema and strip the ``$defs`` block
    when present (MCP clients inline references on demand).
    """
    specs: list[ToolSpec] = registry.list_tools()
    out: list[MCPToolSpec] = []
    for spec in specs:
        schema = dict(spec.input_schema)
        schema.pop("$defs", None)
        out.append(
            MCPToolSpec(
                name=spec.name,
                description=spec.description,
                input_schema=schema,
            ),
        )
    return out


async def invoke_tool(
    registry: ToolRegistry,
    name: str,
    arguments: dict[str, Any],
) -> dict[str, Any]:
    """Resolve *name* in *registry* and invoke it with *arguments*.

    Returns a dict with at minimum a ``status`` field:
    * ``ok`` — the tool ran successfully; ``output`` contains the
      Pydantic model dump.
    * ``refused_no_token`` — execute tool called without a token.
    * ``failed`` — the tool raised a :class:`ToolInvocationError`.

    The function never raises — MCP clients expect a structured error
    on the wire rather than a Python exception escaping through the
    transport.
    """
    try:
        tool = registry.get_tool(name)
    except KeyError as exc:
        return {"status": "unknown_tool", "error": str(exc)}

    try:
        input_value = tool.input_model.model_validate(arguments)
    except Exception as exc:
        return {"status": "invalid_arguments", "error": str(exc)}

    try:
        if tool.category == "execute":
            return {
                "status": "refused_no_token",
                "error": (
                    f"Tool {name!r} is execute-class and cannot run via MCP "
                    "without a ConfirmationToken — use the FastAPI broker "
                    "endpoints to obtain one first."
                ),
            }
        output = await tool(input_value)
    except MissingConfirmationTokenError as exc:
        return {"status": "refused_no_token", "error": str(exc)}
    except ToolInvocationError as exc:
        return {"status": "failed", "error": str(exc)}

    return {"status": "ok", "output": output.model_dump(mode="json")}


def render_tool_result_text(result: dict[str, Any]) -> str:
    """Render :func:`invoke_tool` result as pretty JSON for MCP TextContent."""
    return json.dumps(result, indent=2, sort_keys=True, default=str)


__all__ = [
    "MCPToolSpec",
    "advertise_tools",
    "invoke_tool",
    "render_tool_result_text",
]
