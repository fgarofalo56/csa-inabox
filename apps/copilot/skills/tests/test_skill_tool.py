"""Tests for :mod:`apps.copilot.tools.skill_tool`.

The :class:`SkillTool` adapter exposes each skill as a registry-level
tool so the agent loop can plan skills uniformly.  These tests pin:

* Dynamic input-model generation from the skill spec.
* Category inheritance (read skills → read tool, execute → execute).
* Bulk registration through
  :meth:`ToolRegistry.register_skills`.
* End-to-end dispatch through the tool interface.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from pydantic import BaseModel

from apps.copilot.skills.base import (
    SkillInputField,
    SkillSpec,
    SkillStepSpec,
)
from apps.copilot.skills.catalog import SkillCatalog
from apps.copilot.tools.base import ToolCategory
from apps.copilot.tools.registry import ToolRegistry
from apps.copilot.tools.skill_tool import (
    SkillTool,
    SkillToolOutput,
    register_all_into,
)

FIXTURES = Path(__file__).parent / "fixtures"


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class _EchoInput(BaseModel):
    text: str
    count: int = 1


class _EchoOutput(BaseModel):
    echoed: str


class _EchoTool:
    """Read-class echo tool."""

    name = "echo"
    category: ToolCategory = "read"
    description = "Echo input."
    input_model = _EchoInput
    output_model = _EchoOutput

    async def __call__(self, input_value: _EchoInput) -> _EchoOutput:
        return _EchoOutput(echoed=input_value.text * input_value.count)


def _make_spec(category: ToolCategory = "read") -> SkillSpec:
    return SkillSpec(
        id="echo-skill",
        name="Echo skill",
        description="Test skill for SkillTool unit tests (>=20 chars).",
        category=category,
        inputs=[
            SkillInputField(name="text", type="string", required=True),
            SkillInputField(name="count", type="integer", required=False, default=2),
        ],
        steps=[
            SkillStepSpec(
                id="echo",
                tool="echo",
                input={"text": "{input.text}", "count": "{input.count}"},
            ),
        ],
    )


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_skill_tool_inherits_category_from_spec() -> None:
    """A read skill yields a read-class tool; execute yields execute."""
    catalog = SkillCatalog()
    registry = ToolRegistry([_EchoTool()])

    read_spec = _make_spec(category="read")
    catalog.register(read_spec)
    read_tool = SkillTool(spec=read_spec, catalog=catalog, registry=registry)
    assert read_tool.category == "read"
    assert read_tool.name == "skill.echo-skill"


def test_skill_tool_generates_dynamic_input_model() -> None:
    """The input model matches the declared SkillInputField list."""
    catalog = SkillCatalog()
    registry = ToolRegistry([_EchoTool()])
    spec = _make_spec()
    catalog.register(spec)
    tool = SkillTool(spec=spec, catalog=catalog, registry=registry)

    schema = tool.input_model.model_json_schema()
    assert "text" in schema["properties"]
    assert "count" in schema["properties"]
    # 'text' is required; 'count' has a default and is optional.
    assert set(schema.get("required", [])) == {"text"}


def test_skill_tool_input_model_rejects_unknown_fields() -> None:
    """extra='forbid' on the dynamic model stops typo'd inputs."""
    catalog = SkillCatalog()
    registry = ToolRegistry([_EchoTool()])
    spec = _make_spec()
    catalog.register(spec)
    tool = SkillTool(spec=spec, catalog=catalog, registry=registry)
    with pytest.raises(Exception):  # noqa: B017, PT011 — pydantic ValidationError
        tool.input_model.model_validate({"text": "hi", "mystery": True})


@pytest.mark.asyncio
async def test_skill_tool_runs_skill_end_to_end() -> None:
    """Calling the tool runs the skill and returns a SkillToolOutput."""
    catalog = SkillCatalog()
    registry = ToolRegistry([_EchoTool()])
    spec = _make_spec()
    catalog.register(spec)
    tool = SkillTool(spec=spec, catalog=catalog, registry=registry)

    input_value = tool.input_model.model_validate({"text": "ok", "count": 3})
    output = await tool(input_value)
    assert isinstance(output, SkillToolOutput)
    assert output.success is True
    assert output.steps[0].output == {"echoed": "okokok"}


def test_register_all_into_adds_one_tool_per_skill() -> None:
    """Bulk registration produces ``skill.<id>`` entries."""
    # Use the shipped catalog — guarantees >=6 skills.
    tool_registry = ToolRegistry()
    catalog = SkillCatalog.from_shipped()
    names = register_all_into(tool_registry, catalog)
    assert len(names) >= 6
    for n in names:
        assert n.startswith("skill.")
        assert n in tool_registry


def test_register_skills_method_on_registry() -> None:
    """ToolRegistry.register_skills works via the public facade."""
    registry = ToolRegistry()
    catalog = SkillCatalog.from_shipped()
    names = registry.register_skills(catalog)
    assert len(names) >= 6
    for n in names:
        assert n in registry
        tool_spec = next((s for s in registry.list_tools() if s.name == n), None)
        assert tool_spec is not None
        # Every shipped seed skill is read-class.
        assert tool_spec.category == "read"
        assert tool_spec.requires_confirmation is False


def test_register_skills_preserves_existing_tools() -> None:
    """Bulk-registering skills does not shadow pre-existing tools."""
    registry = ToolRegistry([_EchoTool()])
    catalog = SkillCatalog.from_shipped()
    registry.register_skills(catalog)
    assert "echo" in registry
    assert "skill.grounded-corpus-qa" in registry


def test_skill_tool_output_is_frozen() -> None:
    """The output DTO is frozen — callers cannot mutate results."""
    out = SkillToolOutput(
        skill_id="x",
        trace_id="t",
        success=True,
        outputs={},
        steps=[],
        total_ms=0,
    )
    with pytest.raises(Exception):  # noqa: B017, PT011
        out.skill_id = "mutated"


def test_skill_tool_input_model_includes_optional_defaults() -> None:
    """Optional fields with defaults are resolved correctly in the schema."""
    catalog = SkillCatalog()
    registry = ToolRegistry([_EchoTool()])
    spec = _make_spec()
    catalog.register(spec)
    tool = SkillTool(spec=spec, catalog=catalog, registry=registry)
    # Omit optional 'count' — the default should be applied.
    validated: Any = tool.input_model.model_validate({"text": "x"})
    assert validated.count == 2
