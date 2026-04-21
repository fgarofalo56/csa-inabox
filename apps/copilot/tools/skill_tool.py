"""Skill → Tool adapter (Phase 3).

The :class:`CopilotAgentLoop` plans over a
:class:`~apps.copilot.tools.registry.ToolRegistry` of
:class:`~apps.copilot.tools.base.Tool` instances.  Phase 3 introduces
skills — declarative workflows that compose tools.  To keep the agent
loop's plan/act surface uniform, every skill is also surfaced as a
tool named ``skill.<skill_id>``.

:class:`SkillTool` is the adapter: it wraps one
:class:`~apps.copilot.skills.base.SkillSpec` and, on invocation,
delegates to the shared :class:`~apps.copilot.skills.dispatcher.SkillDispatcher`.
The wrapper's ``input_model`` is generated dynamically from the skill's
declared :class:`~apps.copilot.skills.base.SkillInputField` list so the
tool registry exposes a JSON schema that matches the skill contract.

Category inheritance
--------------------

A skill-tool's ``category`` is inherited verbatim from the skill:

* read-class skills → ``category="read"``; the agent loop runs them
  without a broker token.
* execute-class skills → ``category="execute"``; the agent loop
  requires a token on the :class:`PlannedStep`, and the dispatcher
  additionally gates every execute-class *step inside* the skill
  through the broker.

This means an execute-class skill goes through the broker **twice**:
once at the top-level (agent loop → skill-tool) and once per
execute-class step inside the skill.  That is intentional — the outer
token authorises running the skill at all, and the inner tokens
authorise each side-effect.  The outer token may use a distinct
``scope`` that surfaces the skill id for approvers.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, create_model

from apps.copilot.broker.models import ConfirmationToken
from apps.copilot.skills.base import (
    SkillResult,
    SkillSpec,
)
from apps.copilot.skills.catalog import SkillCatalog
from apps.copilot.skills.dispatcher import (
    ApprovalCallback,
    SkillDispatcher,
    auto_approve_callback,
)
from apps.copilot.tools.base import ToolCategory

# ---------------------------------------------------------------------------
# Dynamic input-model construction
# ---------------------------------------------------------------------------


_TYPE_MAP: dict[str, type] = {
    "string": str,
    "integer": int,
    "number": float,
    "boolean": bool,
    "array": list,
    "object": dict,
}


def _input_model_for(spec: SkillSpec) -> type[BaseModel]:
    """Build a frozen Pydantic model describing the skill's caller inputs.

    The class is constructed with :func:`pydantic.create_model` so the
    registry can serialise a JSON schema without any static class
    definitions bleeding into the global namespace.
    """
    fields: dict[str, tuple[Any, Any]] = {}
    for f in spec.inputs:
        py_type = _TYPE_MAP.get(f.type, str)
        if not f.required and f.default is None:
            py_type_annotation: Any = py_type | None
            default: Any = None
        elif not f.required:
            py_type_annotation = py_type
            default = f.default
        else:
            py_type_annotation = py_type
            default = ...

        fields[f.name] = (
            py_type_annotation,
            Field(
                default=default,
                description=f.description or f"Skill input {f.name!r}.",
            ),
        )

    return create_model(  # type: ignore[call-overload, no-any-return]
        _pascal_case(f"{spec.id}-input"),
        __config__=ConfigDict(frozen=True, extra="forbid"),
        **fields,
    )


def _pascal_case(value: str) -> str:
    """Convert kebab/snake case into PascalCase for dynamic class names."""
    parts = value.replace("_", "-").split("-")
    return "".join(p[:1].upper() + p[1:] for p in parts if p)


class SkillToolOutput(SkillResult):
    """Output surface for :class:`SkillTool`.

    :class:`SkillResult` is reused verbatim — the registry exposes the
    full trace so the agent loop and CLI can render it.  A subclass is
    declared purely so tool-spec schema generation attributes the
    output to the tool rather than the generic result DTO.
    """

    model_config = ConfigDict(frozen=True)


# ---------------------------------------------------------------------------
# SkillTool
# ---------------------------------------------------------------------------


class SkillTool:
    """Adapter that exposes a :class:`SkillSpec` as a Tool.

    The tool's ``name`` is ``skill.<skill_id>`` so it cannot collide
    with any primitive tool name.  Instances are constructed one per
    skill; use :meth:`register_all_into` to bulk-register a catalog.
    """

    input_model: type[BaseModel]
    output_model: type[SkillToolOutput] = SkillToolOutput

    def __init__(
        self,
        *,
        spec: SkillSpec,
        catalog: SkillCatalog,
        registry: Any,  # ToolRegistry — typed Any to avoid a cycle
        broker: Any = None,
        dispatcher: SkillDispatcher | None = None,
        approval_callback: ApprovalCallback | None = None,
    ) -> None:
        self.spec = spec
        self.catalog = catalog
        self._registry_ref = registry
        self._broker = broker
        self._dispatcher = dispatcher or SkillDispatcher()
        self._approval_callback = approval_callback
        self.name: str = f"skill.{spec.id}"
        self.category: ToolCategory = spec.category
        self.description: str = spec.description
        self.input_model = _input_model_for(spec)

    async def __call__(
        self,
        input_value: BaseModel,
        *,
        token: ConfirmationToken | None = None,  # noqa: ARG002 - reserved for execute parity
    ) -> SkillToolOutput:
        """Run the skill.

        Read-class skills ignore any supplied token.  Execute-class
        skills currently rely on the *dispatcher* to gate each
        execute step individually — the top-level token is accepted
        for future use by the agent loop but is not verified here
        (the agent loop verifies it before calling us).
        """
        # Determine the approval callback: either the one supplied at
        # construction, or — if a broker is present — the reference
        # auto-approve callback.  For read-only skills broker may be
        # None and no callback is required.
        approval_callback = self._approval_callback
        if approval_callback is None and self._broker is not None:
            async def _wrapped(skill: SkillSpec, step: Any, resolved_input: dict[str, Any]) -> ConfirmationToken:
                return await auto_approve_callback(
                    skill,
                    step,
                    resolved_input,
                    broker=self._broker,
                )

            approval_callback = _wrapped

        result = await self._dispatcher.dispatch(
            self.spec,
            input_value.model_dump(mode="json"),
            registry=self._registry_ref,
            broker=self._broker,
            approval_callback=approval_callback,
        )
        return SkillToolOutput.model_validate(result.model_dump(mode="json"))


# ---------------------------------------------------------------------------
# Bulk registration
# ---------------------------------------------------------------------------


def register_all_into(
    registry: Any,
    catalog: SkillCatalog,
    *,
    broker: Any = None,
    dispatcher: SkillDispatcher | None = None,
    approval_callback: ApprovalCallback | None = None,
) -> list[str]:
    """Register every skill in *catalog* into *registry* as a :class:`SkillTool`.

    Returns the list of tool names that were registered (i.e.
    ``["skill.<id>", ...]``).  Skills whose name would collide with
    an existing tool are skipped — the registry's own uniqueness
    guard still raises, so callers that care about collisions can
    catch :class:`ValueError` themselves.
    """
    registered: list[str] = []
    shared = dispatcher or SkillDispatcher()
    for spec in catalog:
        tool = SkillTool(
            spec=spec,
            catalog=catalog,
            registry=registry,
            broker=broker,
            dispatcher=shared,
            approval_callback=approval_callback,
        )
        registry.register(tool)
        registered.append(tool.name)
    return registered


__all__ = [
    "SkillTool",
    "SkillToolOutput",
    "register_all_into",
]
