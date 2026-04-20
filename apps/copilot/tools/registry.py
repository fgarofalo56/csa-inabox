"""Tool registry — CSA-0100 (AQ-0003).

A :class:`ToolRegistry` is an ordered, name-keyed catalogue of
:class:`~apps.copilot.tools.base.Tool` instances.  The registry enforces
two invariants the agent loop depends on:

1. **Names are unique.**  Registering two tools with the same ``name``
   raises :class:`ValueError` — there is no implicit overwrite, because
   silently shadowing a tool would change agent behaviour in a way
   that is nearly impossible to debug from the outside.
2. **The registry is append-only after construction.**  Callers may
   ``register`` new tools but cannot mutate an existing spec.  To
   replace a tool, build a new :class:`ToolRegistry`.

The registry also exposes a convenience ``default_registry`` factory
that installs the shipped read + execute tools.  Tests build a fresh
registry with just the tools they need.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from apps.copilot.tools.base import Tool, ToolCategory


class ToolSpec(BaseModel):
    """Metadata view of a :class:`Tool`, safe to serialise and inspect.

    The :class:`ToolRegistry` emits a list of these from ``list_tools``
    so the CLI, tests, and LLM planner can enumerate the catalogue
    without touching the underlying tool object (which may hold
    resources such as an Azure client).
    """

    name: str = Field(description="Globally unique tool identifier.")
    category: ToolCategory = Field(description="Tool class: read or execute.")
    description: str = Field(description="Short description shown to the planner.")
    input_schema: dict[str, Any] = Field(
        default_factory=dict,
        description="JSON schema for the tool input model.",
    )
    output_schema: dict[str, Any] = Field(
        default_factory=dict,
        description="JSON schema for the tool output model.",
    )
    requires_confirmation: bool = Field(
        description="True when category == 'execute'; hint for the planner.",
    )

    model_config = ConfigDict(frozen=True)


class ToolRegistry:
    """Append-only registry of Copilot tools.

    The registry preserves insertion order so CLI listings and planner
    prompts are deterministic.  ``get_tool`` raises :class:`KeyError`
    rather than returning ``None`` to force callers to handle missing
    tools explicitly.
    """

    def __init__(self, tools: Iterable[Tool[Any, Any]] | None = None) -> None:
        self._tools: dict[str, Tool[Any, Any]] = {}
        if tools:
            for tool in tools:
                self.register(tool)

    def register(self, tool: Tool[Any, Any]) -> None:
        """Add *tool* to the registry.

        Raises :class:`ValueError` if a tool with the same ``name`` is
        already registered — names must be globally unique within a
        registry to prevent accidental shadowing.
        """
        if not tool.name:
            raise ValueError("Tool.name must be a non-empty string.")
        if tool.name in self._tools:
            raise ValueError(
                f"Tool {tool.name!r} is already registered. Build a new "
                "ToolRegistry if you need to replace an existing tool.",
            )
        if tool.category not in ("read", "execute"):
            raise ValueError(
                f"Tool {tool.name!r} declared invalid category "
                f"{tool.category!r}; expected 'read' or 'execute'.",
            )
        self._tools[tool.name] = tool

    def get_tool(self, name: str) -> Tool[Any, Any]:
        """Return the tool registered under *name*.

        Raises :class:`KeyError` if no matching tool exists.
        """
        try:
            return self._tools[name]
        except KeyError as exc:  # pragma: no cover - trivial rewrap
            raise KeyError(f"No tool registered under name {name!r}.") from exc

    def list_tools(self, category: ToolCategory | None = None) -> list[ToolSpec]:
        """Return metadata for every registered tool, optionally filtered.

        The response preserves registration order.  When ``category``
        is provided, only tools of that class are returned.
        """
        specs: list[ToolSpec] = []
        for tool in self._tools.values():
            if category is not None and tool.category != category:
                continue
            specs.append(self._spec_for(tool))
        return specs

    def names(self, category: ToolCategory | None = None) -> list[str]:
        """Return the registered names, optionally filtered by category."""
        if category is None:
            return list(self._tools.keys())
        return [t.name for t in self._tools.values() if t.category == category]

    def __contains__(self, name: object) -> bool:
        return isinstance(name, str) and name in self._tools

    def __len__(self) -> int:
        return len(self._tools)

    # -- helpers -------------------------------------------------------------

    @staticmethod
    def _spec_for(tool: Tool[Any, Any]) -> ToolSpec:
        """Derive a :class:`ToolSpec` from a registered tool."""
        try:
            input_schema = tool.input_model.model_json_schema()
        except Exception:  # pragma: no cover - defensive
            input_schema = {}
        try:
            output_schema = tool.output_model.model_json_schema()
        except Exception:  # pragma: no cover - defensive
            output_schema = {}
        return ToolSpec(
            name=tool.name,
            category=tool.category,
            description=tool.description,
            input_schema=input_schema,
            output_schema=output_schema,
            requires_confirmation=tool.category == "execute",
        )


__all__ = ["ToolRegistry", "ToolSpec"]
