"""Tests for :mod:`apps.copilot.tools.registry` (CSA-0100).

The registry owns two invariants the agent loop depends on: unique
names and append-only mutation.  These tests pin both, plus the
metadata filtering used by ``tools list``.
"""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import BaseModel

from apps.copilot.tools.base import ToolCategory
from apps.copilot.tools.registry import ToolRegistry, ToolSpec


class _DummyInput(BaseModel):
    """Minimal Pydantic input for fake tools."""

    query: str = "hello"


class _DummyOutput(BaseModel):
    """Minimal Pydantic output for fake tools."""

    echo: str = ""


class _FakeTool:
    """Tool implementation that records its calls — no side-effects."""

    input_model = _DummyInput
    output_model = _DummyOutput

    def __init__(self, name: str, category: ToolCategory = "read", description: str = "fake") -> None:
        self.name = name
        self.category = category
        self.description = description
        self.calls: list[_DummyInput] = []

    async def __call__(self, input_value: _DummyInput) -> _DummyOutput:
        self.calls.append(input_value)
        return _DummyOutput(echo=input_value.query)


def test_register_accepts_read_and_execute_tools() -> None:
    """A fresh registry should accept both categories without mutation errors."""
    read_tool = _FakeTool("search")
    exec_tool = _FakeTool("execute_thing", category="execute")
    registry = ToolRegistry()
    registry.register(read_tool)
    registry.register(exec_tool)

    assert len(registry) == 2
    assert "search" in registry
    assert "execute_thing" in registry


def test_register_rejects_duplicate_names() -> None:
    """The registry must refuse to silently shadow an existing tool."""
    registry = ToolRegistry([_FakeTool("alpha")])
    with pytest.raises(ValueError, match="already registered"):
        registry.register(_FakeTool("alpha"))


def test_register_rejects_empty_name() -> None:
    """An empty name is an obvious programming error — fail fast."""
    registry = ToolRegistry()
    tool = _FakeTool("")
    with pytest.raises(ValueError, match="non-empty"):
        registry.register(tool)


def test_register_rejects_invalid_category() -> None:
    """Category is closed: only 'read' and 'execute' are valid."""
    registry = ToolRegistry()
    tool = _FakeTool("weird")
    tool.category = "magic"  # type: ignore[assignment]
    with pytest.raises(ValueError, match="invalid category"):
        registry.register(tool)


def test_get_tool_returns_registered_tool() -> None:
    """``get_tool`` looks up by name and returns the exact object."""
    tool = _FakeTool("one")
    registry = ToolRegistry([tool])
    assert registry.get_tool("one") is tool


def test_get_tool_raises_key_error_for_missing() -> None:
    """Missing tools must raise ``KeyError`` with a clear message."""
    registry = ToolRegistry()
    with pytest.raises(KeyError, match="No tool registered"):
        registry.get_tool("does-not-exist")


def test_list_tools_returns_specs_in_registration_order() -> None:
    """Registration order is preserved and each spec is a ``ToolSpec``."""
    registry = ToolRegistry(
        [_FakeTool("a"), _FakeTool("b", category="execute"), _FakeTool("c")],
    )
    specs = registry.list_tools()
    assert [s.name for s in specs] == ["a", "b", "c"]
    assert all(isinstance(s, ToolSpec) for s in specs)


def test_list_tools_filters_by_category() -> None:
    """Category filtering returns only the requested class."""
    registry = ToolRegistry(
        [
            _FakeTool("r1"),
            _FakeTool("x1", category="execute"),
            _FakeTool("r2"),
            _FakeTool("x2", category="execute"),
        ],
    )
    assert [s.name for s in registry.list_tools(category="read")] == ["r1", "r2"]
    assert [s.name for s in registry.list_tools(category="execute")] == ["x1", "x2"]


def test_list_tools_sets_requires_confirmation_for_execute() -> None:
    """Execute tools must set ``requires_confirmation=True`` in their spec."""
    registry = ToolRegistry(
        [_FakeTool("r"), _FakeTool("x", category="execute")],
    )
    by_name = {s.name: s for s in registry.list_tools()}
    assert by_name["r"].requires_confirmation is False
    assert by_name["x"].requires_confirmation is True


def test_names_filters_by_category() -> None:
    """``names`` convenience method mirrors ``list_tools`` filtering."""
    registry = ToolRegistry(
        [_FakeTool("r"), _FakeTool("x", category="execute")],
    )
    assert registry.names() == ["r", "x"]
    assert registry.names("read") == ["r"]
    assert registry.names("execute") == ["x"]


def test_tool_spec_is_frozen() -> None:
    """``ToolSpec`` is frozen — downstream callers cannot mutate metadata."""
    spec = ToolSpec(
        name="s",
        category="read",
        description="d",
        requires_confirmation=False,
    )
    with pytest.raises(Exception):  # noqa: PT011, B017 — pydantic-version-specific
        spec.name = "mutated"


def test_contains_rejects_non_strings() -> None:
    """``__contains__`` must be safe against non-string lookups."""
    registry = ToolRegistry([_FakeTool("x")])
    assert "x" in registry
    assert 42 not in registry
    assert None not in registry


@pytest.mark.parametrize("count", [0, 1, 5])
def test_len_matches_registration_count(count: int) -> None:
    """``len`` tracks exactly how many tools have been registered."""
    tools: list[Any] = [_FakeTool(f"t{i}") for i in range(count)]
    registry = ToolRegistry(tools)
    assert len(registry) == count
