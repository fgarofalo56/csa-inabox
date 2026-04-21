"""Skill protocol + frozen DTOs (Phase 3, CSA-0100 continuation).

A *skill* is a declarative, YAML-authored workflow that composes one
or more Copilot tools to accomplish a higher-level task.  A skill is
to a tool what a recipe is to an ingredient: it knows the order of
operations, how outputs feed into inputs, and whether the whole
workflow is read-class or execute-class.

Design invariants
-----------------

1. **Immutability.**  Every DTO in this module is ``frozen`` so a
   loaded :class:`SkillSpec` cannot be mutated after registration.
   The dispatcher, which may run concurrently, can safely share a
   single :class:`SkillSpec` instance across coroutines.

2. **Typed inputs + outputs.**  Skills declare their inputs with a
   subset of JSON-schema (string / integer / boolean / array /
   object) so the catalog can validate caller-supplied inputs before
   the first step runs.

3. **Deterministic category.**  The ``category`` field is either
   ``"read"`` or ``"execute"`` — matching the tool categories.  An
   execute-class skill is one that contains *any* execute-class tool
   step.  The loader verifies this invariant when a
   :class:`~apps.copilot.tools.registry.ToolRegistry` is supplied.

4. **No Python.**  Skill YAML does not embed Python; the sandboxed
   interpolation engine (:mod:`apps.copilot.skills.dispatcher`) only
   understands ``{step_id}.output.field`` references — see that
   module's docstring for the full grammar.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from apps.copilot.tools.base import ToolCategory

SkillInputType = Literal["string", "integer", "number", "boolean", "array", "object"]
"""JSON-schema-ish primitive types supported by the skill input contract."""

FallbackMode = Literal["skip", "fail"]
"""How the dispatcher reacts when a referenced tool is missing.

``skip`` — mark the step as skipped and continue with subsequent
steps; later steps that interpolate from the skipped step will
themselves be marked as skipped.  ``fail`` — short-circuit the run
with a :class:`~apps.copilot.skills.errors.SkillExecutionError`.
"""


class SkillInputField(BaseModel):
    """One declared input to a skill.

    Modelled on JSON-schema so the catalog can render an input form
    (CLI, MCP, web) without a parallel schema file.  ``default`` is
    used when the caller omits the field and ``required`` is false.
    """

    name: str = Field(min_length=1, description="Field name (must be a valid Python identifier).")
    type: SkillInputType = Field(description="Declared primitive type.")
    description: str = Field(default="", description="Human-readable description surfaced to the caller.")
    required: bool = Field(default=True, description="When false, the field may be omitted.")
    default: Any = Field(default=None, description="Default value used when the field is omitted.")
    enum: list[Any] | None = Field(
        default=None,
        description="Optional closed set of allowed values (JSON-schema ``enum``).",
    )

    model_config = ConfigDict(frozen=True)

    @field_validator("name")
    @classmethod
    def _name_is_identifier(cls, v: str) -> str:
        if not v.isidentifier():
            raise ValueError(f"Skill input name {v!r} must be a valid Python identifier.")
        return v


class SkillOutputSpec(BaseModel):
    """The shape of a skill's returned outputs.

    Kept deliberately minimal — the dispatcher does not enforce the
    declared output shape at runtime; the field exists so tooling
    (docs generation, MCP surface) can describe the skill without
    running it.
    """

    type: Literal["object"] = Field(
        default="object",
        description="Always an object in Phase 3; reserved for future extension.",
    )
    fields: dict[str, str] = Field(
        default_factory=dict,
        description="Field-name → human description mapping for the skill output.",
    )

    model_config = ConfigDict(frozen=True)


class SkillStepSpec(BaseModel):
    """One step of a skill — a named tool invocation.

    ``input`` is an arbitrary mapping whose *values* may contain
    ``{step_id}.output.field`` interpolations that the dispatcher
    resolves at runtime against earlier steps' outputs.  Values that
    match a top-level caller-input name (or a ``{input.<name>}``
    template) are resolved from the caller input bag.
    """

    id: str = Field(min_length=1, description="Step identifier (unique within the skill).")
    tool: str = Field(min_length=1, description="Name of the registered tool to invoke.")
    input: dict[str, Any] = Field(
        default_factory=dict,
        description="Kwargs forwarded to the tool input model (with interpolation).",
    )
    description: str = Field(default="", description="Optional human description of the step.")

    model_config = ConfigDict(frozen=True)

    @field_validator("id")
    @classmethod
    def _id_is_identifier(cls, v: str) -> str:
        if not v.replace("-", "_").isidentifier():
            raise ValueError(
                f"Step id {v!r} must be kebab-case or snake_case (letters, digits, -, _).",
            )
        return v


class SkillSpec(BaseModel):
    """The canonical, frozen representation of a loaded skill.

    Produced by :func:`apps.copilot.skills.loader.load_skill_spec` and
    stored by :class:`apps.copilot.skills.catalog.SkillCatalog`.  The
    dispatcher never mutates a :class:`SkillSpec` — the same instance
    may be referenced from many concurrent runs.
    """

    id: str = Field(min_length=1, description="Globally unique skill id (kebab-case).")
    name: str = Field(min_length=1, description="Human-readable title.")
    description: str = Field(
        min_length=20,
        description="At least 20 characters so the CLI/catalog listings are useful.",
    )
    category: ToolCategory = Field(description="Skill category; execute gates through the broker.")
    inputs: list[SkillInputField] = Field(
        default_factory=list,
        description="Declared caller inputs, in order.",
    )
    outputs: SkillOutputSpec = Field(default_factory=SkillOutputSpec)
    steps: list[SkillStepSpec] = Field(
        default_factory=list,
        description="Ordered tool invocations composing the skill.",
    )
    fallback_if_tool_missing: FallbackMode = Field(
        default="fail",
        description="``skip`` continues past missing tools; ``fail`` short-circuits.",
    )
    version: str = Field(default="1.0", description="Free-form version string.")
    tags: list[str] = Field(default_factory=list, description="Discovery tags.")
    source_path: str | None = Field(
        default=None,
        description="Repo-relative path to the source YAML (set by the loader).",
    )

    model_config = ConfigDict(frozen=True)

    @field_validator("id")
    @classmethod
    def _id_is_kebab(cls, v: str) -> str:
        if not v.replace("-", "").replace("_", "").isalnum():
            raise ValueError(
                f"Skill id {v!r} must be kebab-case (letters, digits, and hyphens only).",
            )
        if v != v.lower():
            raise ValueError(f"Skill id {v!r} must be lowercase.")
        return v

    @field_validator("steps")
    @classmethod
    def _step_ids_unique(cls, v: list[SkillStepSpec]) -> list[SkillStepSpec]:
        seen: set[str] = set()
        for step in v:
            if step.id in seen:
                raise ValueError(f"Duplicate step id {step.id!r} in skill spec.")
            seen.add(step.id)
        return v

    @property
    def input_names(self) -> frozenset[str]:
        """Set of declared caller input field names, for interpolation."""
        return frozenset(f.name for f in self.inputs)


class SkillContext(BaseModel):
    """Runtime state passed between steps of a dispatch.

    The bag is keyed by step id, with each value being the ``dict``
    dump of the step's tool output (or ``None`` for skipped /
    refused steps).  A reserved ``"input"`` key holds the resolved
    caller input payload so templates such as ``{input.scenario}``
    work alongside ``{walk-tree.output.title}``.
    """

    inputs: dict[str, Any] = Field(default_factory=dict)
    step_outputs: dict[str, dict[str, Any] | None] = Field(default_factory=dict)

    model_config = ConfigDict(frozen=False)  # intentionally mutable during dispatch

    def record(self, step_id: str, output: dict[str, Any] | None) -> None:
        """Store the output of *step_id* for later interpolation.

        Re-storing the same step id raises :class:`RuntimeError`
        because a dispatch must not revisit the same step.
        """
        if step_id in self.step_outputs:
            raise RuntimeError(f"Step {step_id!r} already recorded; skills are single-pass.")
        self.step_outputs[step_id] = output


StepStatus = Literal[
    "completed",
    "skipped",
    "failed",
    "refused_no_token",
    "refused_broker",
    "refused_missing_tool",
]
"""Terminal status for one step of a skill run."""


class SkillStep(BaseModel):
    """Trace record for one executed step.

    ``output`` is ``None`` for any non-``completed`` status so callers
    can distinguish "no-op" from "empty success" without reading a
    separate flag.
    """

    step_id: str = Field(description="Step id from the skill spec.")
    tool: str = Field(description="Tool name that was invoked (or attempted).")
    input: dict[str, Any] = Field(default_factory=dict, description="Resolved tool input.")
    output: dict[str, Any] | None = Field(default=None, description="Tool output on success.")
    status: StepStatus = Field(description="Terminal step status.")
    took_ms: int = Field(ge=0, description="Wall-clock duration in milliseconds.")
    token_id: str | None = Field(
        default=None,
        description="ConfirmationToken.token_id when the step went through the broker.",
    )
    message: str | None = Field(
        default=None,
        description="Free-form detail (failure reason, skip reason).",
    )

    model_config = ConfigDict(frozen=True)


class SkillResult(BaseModel):
    """Full result of a :meth:`SkillDispatcher.dispatch` run.

    ``success`` is true iff every step completed.  The result also
    carries the ``outputs`` dict — either a projection the skill
    author specified in the YAML (future) or, for Phase 3, the
    terminal step's output verbatim.
    """

    skill_id: str = Field(description="Skill that was dispatched.")
    trace_id: str = Field(description="UUID identifying this dispatch; useful for logs.")
    success: bool = Field(description="True when every step completed.")
    outputs: dict[str, Any] = Field(
        default_factory=dict,
        description="Aggregated output (the terminal step's output in Phase 3).",
    )
    steps: list[SkillStep] = Field(
        default_factory=list,
        description="Ordered trace of every executed step.",
    )
    total_ms: int = Field(ge=0, description="End-to-end wall-clock duration in ms.")
    message: str | None = Field(
        default=None,
        description="Free-form summary (populated on failures).",
    )

    model_config = ConfigDict(frozen=True)


__all__ = [
    "FallbackMode",
    "SkillContext",
    "SkillInputField",
    "SkillInputType",
    "SkillOutputSpec",
    "SkillResult",
    "SkillSpec",
    "SkillStep",
    "SkillStepSpec",
    "StepStatus",
]
