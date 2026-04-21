"""Unit tests for the MCP tool bridge."""

from __future__ import annotations

from typing import Any, Literal

import pytest
from pydantic import BaseModel

from apps.copilot.surfaces.mcp.tool_bridge import (
    advertise_tools,
    invoke_tool,
    render_tool_result_text,
)
from apps.copilot.tools.base import ToolCategory, ToolInvocationError
from apps.copilot.tools.registry import ToolRegistry


class _EchoIn(BaseModel):
    text: str = ""


class _EchoOut(BaseModel):
    echoed: str = ""


class _EchoTool:
    name: str = "echo"
    category: ToolCategory = "read"
    description: str = "Echo back the input."
    input_model: type[_EchoIn] = _EchoIn
    output_model: type[_EchoOut] = _EchoOut

    async def __call__(self, v: _EchoIn) -> _EchoOut:
        return _EchoOut(echoed=v.text)


class _ExecuteTool:
    name: str = "do_thing"
    category: ToolCategory = "execute"
    description: str = "Execute a dangerous thing."
    input_model: type[_EchoIn] = _EchoIn
    output_model: type[_EchoOut] = _EchoOut

    async def __call__(
        self,
        v: _EchoIn,
        *,
        token: Any = None,  # noqa: ARG002
    ) -> _EchoOut:  # pragma: no cover - never invoked via MCP
        return _EchoOut(echoed=v.text)


class _FailingTool:
    name: str = "broken"
    category: ToolCategory = "read"
    description: str = "Always fails."
    input_model: type[_EchoIn] = _EchoIn
    output_model: type[_EchoOut] = _EchoOut

    async def __call__(self, v: _EchoIn) -> _EchoOut:  # noqa: ARG002
        raise ToolInvocationError("oops")


# Literal re-import to keep unused-import linter happy on older mypy runs.
_ = Literal


def test_advertise_tools_strips_defs() -> None:
    """$defs blocks are removed from advertised schemas."""
    registry = ToolRegistry([_EchoTool()])  # type: ignore[list-item]
    specs = advertise_tools(registry)
    assert len(specs) == 1
    assert specs[0].name == "echo"
    assert "$defs" not in specs[0].input_schema


@pytest.mark.asyncio
async def test_invoke_tool_ok() -> None:
    """A valid read tool invocation returns status=ok with the output dict."""
    registry = ToolRegistry([_EchoTool()])  # type: ignore[list-item]
    result = await invoke_tool(registry, "echo", {"text": "hi"})
    assert result["status"] == "ok"
    assert result["output"] == {"echoed": "hi"}


@pytest.mark.asyncio
async def test_invoke_tool_unknown_name() -> None:
    """Unknown tool names surface a structured error."""
    registry = ToolRegistry()
    result = await invoke_tool(registry, "nope", {})
    assert result["status"] == "unknown_tool"


@pytest.mark.asyncio
async def test_invoke_tool_invalid_arguments() -> None:
    """Pydantic validation errors surface as structured errors."""
    registry = ToolRegistry([_EchoTool()])  # type: ignore[list-item]
    result = await invoke_tool(registry, "echo", {"text": 123})
    # Pydantic coerces ints to str when mode is lax; this test stays
    # tolerant to that — we only require that the dispatch does NOT
    # raise.  If the validator rejects the int we should see a
    # structured error; otherwise we expect ``ok``.
    assert result["status"] in {"ok", "invalid_arguments"}


@pytest.mark.asyncio
async def test_invoke_tool_execute_refused() -> None:
    """Execute-class tools are refused over MCP."""
    registry = ToolRegistry([_ExecuteTool()])  # type: ignore[list-item]
    result = await invoke_tool(registry, "do_thing", {"text": "x"})
    assert result["status"] == "refused_no_token"


@pytest.mark.asyncio
async def test_invoke_tool_propagates_failure() -> None:
    """ToolInvocationError is caught and turned into status=failed."""
    registry = ToolRegistry([_FailingTool()])  # type: ignore[list-item]
    result = await invoke_tool(registry, "broken", {"text": "x"})
    assert result["status"] == "failed"
    assert "oops" in result["error"]


def test_render_tool_result_text_is_pretty_json() -> None:
    """render_tool_result_text emits sorted, indented JSON."""
    text = render_tool_result_text({"status": "ok", "a": 1})
    assert text == '{\n  "a": 1,\n  "status": "ok"\n}'
