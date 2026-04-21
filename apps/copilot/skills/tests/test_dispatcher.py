"""Tests for :mod:`apps.copilot.skills.dispatcher`.

These tests exercise the core dispatch semantics:

* Input validation (required / enum / unknown-field).
* Interpolation grammar (input refs, step output refs, negative cases).
* Tool invocation routing (read vs execute).
* Failure propagation into structured steps.
* Broker integration (token acquisition + verification).
"""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import BaseModel

from apps.copilot.broker.broker import ConfirmationBroker
from apps.copilot.broker.models import ConfirmationToken
from apps.copilot.config import CopilotSettings
from apps.copilot.skills.base import (
    SkillContext,
    SkillInputField,
    SkillResult,
    SkillSpec,
    SkillStepSpec,
)
from apps.copilot.skills.dispatcher import (
    SkillDispatcher,
    auto_approve_callback,
    interpolate_value,
)
from apps.copilot.skills.errors import (
    SkillInputError,
    SkillInterpolationError,
)
from apps.copilot.tools.base import ToolCategory
from apps.copilot.tools.registry import ToolRegistry

# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class _EchoInput(BaseModel):
    text: str
    count: int = 1


class _EchoOutput(BaseModel):
    echoed: str
    repeats: int


class _EchoTool:
    """Read-class fake tool that echoes its input."""

    name = "echo"
    category: ToolCategory = "read"
    description = "Echo a string N times."
    input_model = _EchoInput
    output_model = _EchoOutput

    def __init__(self, name: str = "echo") -> None:
        self.name = name
        self.calls: list[_EchoInput] = []

    async def __call__(self, input_value: _EchoInput) -> _EchoOutput:
        self.calls.append(input_value)
        return _EchoOutput(
            echoed=input_value.text * input_value.count,
            repeats=input_value.count,
        )


class _FailingToolInput(BaseModel):
    reason: str = "explode"


class _FailingToolOutput(BaseModel):
    ok: bool = False


class _FailingTool:
    """Tool that always raises ToolInvocationError."""

    name = "failing"
    category: ToolCategory = "read"
    description = "Always raises ToolInvocationError."
    input_model = _FailingToolInput
    output_model = _FailingToolOutput

    async def __call__(self, input_value: _FailingToolInput) -> _FailingToolOutput:
        from apps.copilot.tools.base import ToolInvocationError

        raise ToolInvocationError(f"boom: {input_value.reason}")


class _ExecuteInput(BaseModel):
    value: str


class _ExecuteOutput(BaseModel):
    echoed: str
    token_id: str


class _ExecuteTool:
    """Execute-class fake tool that verifies its token via the broker."""

    name = "exec_echo"
    category: ToolCategory = "execute"
    description = "Execute-class echo (requires broker token)."
    input_model = _ExecuteInput
    output_model = _ExecuteOutput

    def __init__(self, broker: ConfirmationBroker) -> None:
        self.broker = broker

    async def __call__(
        self,
        input_value: _ExecuteInput,
        *,
        token: ConfirmationToken | None = None,
    ) -> _ExecuteOutput:
        from apps.copilot.broker.broker import compute_input_hash
        from apps.copilot.tools.base import MissingConfirmationTokenError

        if token is None:
            raise MissingConfirmationTokenError("no token supplied")
        await self.broker.verify(
            token,
            tool_name=self.name,
            input_hash=compute_input_hash(input_value),
        )
        return _ExecuteOutput(echoed=input_value.value.upper(), token_id=token.token_id)


def _make_echo_spec(
    *,
    skill_id: str = "echo-skill",
    category: ToolCategory = "read",
    fallback: str = "fail",
    inputs_list: list[SkillInputField] | None = None,
    steps: list[SkillStepSpec] | None = None,
) -> SkillSpec:
    """Factory for SkillSpec objects used across tests."""
    if inputs_list is None:
        inputs_list = [
            SkillInputField(name="text", type="string", description="", required=True),
        ]
    if steps is None:
        steps = [
            SkillStepSpec(
                id="echo-step",
                tool="echo",
                input={"text": "{input.text}", "count": 2},
            ),
        ]
    return SkillSpec(
        id=skill_id,
        name="Echo skill",
        description="Test skill used across dispatcher tests (> 20 chars long).",
        category=category,
        inputs=inputs_list,
        steps=steps,
        fallback_if_tool_missing=fallback,  # type: ignore[arg-type]
    )


# ---------------------------------------------------------------------------
# Interpolation
# ---------------------------------------------------------------------------


def test_interpolate_input_token() -> None:
    """{input.name} resolves to the caller-supplied value."""
    ctx = SkillContext(inputs={"name": "world"})
    assert interpolate_value("{input.name}", ctx) == "world"


def test_interpolate_step_output_token() -> None:
    """{step.output.field} resolves to a prior step's output field."""
    ctx = SkillContext(inputs={})
    ctx.record("prev", {"message": "hi", "nested": {"leaf": 42}})
    assert interpolate_value("{prev.output.message}", ctx) == "hi"
    assert interpolate_value("{prev.output.nested.leaf}", ctx) == 42


def test_interpolate_whole_string_preserves_type() -> None:
    """A single-token string returns the resolved object, not its str()."""
    ctx = SkillContext(inputs={})
    ctx.record("prev", {"items": [1, 2, 3]})
    resolved = interpolate_value("{prev.output.items}", ctx)
    assert resolved == [1, 2, 3]
    assert isinstance(resolved, list)


def test_interpolate_embedded_token_coerces_to_string() -> None:
    """An embedded token is substituted via str() inside the surrounding text."""
    ctx = SkillContext(inputs={"n": 7})
    assert interpolate_value("count={input.n}", ctx) == "count=7"


def test_interpolate_rejects_unknown_input() -> None:
    """Referencing a missing caller input is an interpolation error."""
    ctx = SkillContext(inputs={})
    with pytest.raises(SkillInterpolationError, match="unknown input"):
        interpolate_value("{input.missing}", ctx)


def test_interpolate_rejects_unknown_step() -> None:
    """Referencing an unrun step is an interpolation error."""
    ctx = SkillContext(inputs={})
    with pytest.raises(SkillInterpolationError, match="before it has run"):
        interpolate_value("{nope.output.value}", ctx)


def test_interpolate_rejects_bad_grammar() -> None:
    """Any template shape outside the allowed grammar is rejected."""
    ctx = SkillContext(inputs={})
    with pytest.raises(SkillInterpolationError, match="Unsupported interpolation"):
        interpolate_value("{someGarbage}", ctx)


def test_interpolate_recurses_into_dict_and_list() -> None:
    """Interpolation walks into nested dicts and lists."""
    ctx = SkillContext(inputs={"v": "X"})
    payload = {"k": "{input.v}", "lst": ["{input.v}", "Y"]}
    resolved = interpolate_value(payload, ctx)
    assert resolved == {"k": "X", "lst": ["X", "Y"]}


def test_interpolate_leaves_non_strings_alone() -> None:
    """Integers and booleans pass through interpolation unchanged."""
    ctx = SkillContext(inputs={})
    assert interpolate_value(42, ctx) == 42
    assert interpolate_value(True, ctx) is True


def test_interpolate_no_eval_for_evil_payload() -> None:
    """Tokens that look like Python code must NOT be executed."""
    ctx = SkillContext(inputs={})
    # This must not raise a NameError from eval — the sandboxed
    # engine rejects the shape at grammar time.
    with pytest.raises(SkillInterpolationError):
        interpolate_value("{__import__('os').system('ls')}", ctx)


# ---------------------------------------------------------------------------
# Input validation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dispatch_required_input_enforced() -> None:
    """Missing required inputs raise SkillInputError."""
    spec = _make_echo_spec()
    registry = ToolRegistry([_EchoTool()])
    dispatcher = SkillDispatcher()
    with pytest.raises(SkillInputError, match="requires input"):
        await dispatcher.dispatch(spec, {}, registry=registry)


@pytest.mark.asyncio
async def test_dispatch_applies_default_for_optional() -> None:
    """Optional inputs fall back to their declared default."""
    spec = _make_echo_spec(
        inputs_list=[
            SkillInputField(name="text", type="string", required=False, default="hi"),
        ],
    )
    registry = ToolRegistry([_EchoTool()])
    dispatcher = SkillDispatcher()
    result = await dispatcher.dispatch(spec, {}, registry=registry)
    assert result.success is True
    assert result.steps[0].output == {"echoed": "hihi", "repeats": 2}


@pytest.mark.asyncio
async def test_dispatch_enum_violation_raises() -> None:
    """Values outside the declared enum list are rejected."""
    spec = _make_echo_spec(
        inputs_list=[
            SkillInputField(
                name="text",
                type="string",
                required=True,
                enum=["only", "these"],
            ),
        ],
    )
    registry = ToolRegistry([_EchoTool()])
    dispatcher = SkillDispatcher()
    with pytest.raises(SkillInputError, match="not in the allowed set"):
        await dispatcher.dispatch(spec, {"text": "banned"}, registry=registry)


@pytest.mark.asyncio
async def test_dispatch_rejects_unexpected_input() -> None:
    """Typoed input keys must fail loud."""
    spec = _make_echo_spec()
    registry = ToolRegistry([_EchoTool()])
    dispatcher = SkillDispatcher()
    with pytest.raises(SkillInputError, match="unexpected inputs"):
        await dispatcher.dispatch(spec, {"text": "ok", "extra": 1}, registry=registry)


# ---------------------------------------------------------------------------
# Execution
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_dispatch_runs_read_step() -> None:
    """A simple read-only skill runs to completion with a successful trace."""
    spec = _make_echo_spec()
    tool = _EchoTool()
    registry = ToolRegistry([tool])
    dispatcher = SkillDispatcher()
    result = await dispatcher.dispatch(spec, {"text": "hey"}, registry=registry)
    assert isinstance(result, SkillResult)
    assert result.success is True
    assert result.skill_id == spec.id
    assert result.trace_id
    assert len(result.steps) == 1
    assert result.steps[0].status == "completed"
    assert tool.calls[0].text == "hey"


@pytest.mark.asyncio
async def test_dispatch_missing_tool_skip_mode() -> None:
    """``fallback=skip`` marks the step skipped and continues."""
    spec = _make_echo_spec(
        fallback="skip",
        steps=[
            SkillStepSpec(id="ghost", tool="not-registered", input={}),
            SkillStepSpec(id="real", tool="echo", input={"text": "ok", "count": 1}),
        ],
    )
    registry = ToolRegistry([_EchoTool()])
    dispatcher = SkillDispatcher()
    result = await dispatcher.dispatch(spec, {"text": "ok"}, registry=registry)
    assert [s.status for s in result.steps] == ["skipped", "completed"]
    # Skipped step is not "success" overall but dispatcher continued.
    assert result.success is False


@pytest.mark.asyncio
async def test_dispatch_missing_tool_fail_mode_short_circuits() -> None:
    """``fallback=fail`` short-circuits on the first missing tool."""
    spec = _make_echo_spec(
        fallback="fail",
        steps=[
            SkillStepSpec(id="ghost", tool="not-registered", input={}),
            SkillStepSpec(id="never", tool="echo", input={"text": "x"}),
        ],
    )
    registry = ToolRegistry([_EchoTool()])
    dispatcher = SkillDispatcher()
    result = await dispatcher.dispatch(spec, {"text": "ok"}, registry=registry)
    # Only the first (failing) step should be recorded.
    assert len(result.steps) == 1
    assert result.steps[0].status == "refused_missing_tool"
    assert result.success is False


@pytest.mark.asyncio
async def test_dispatch_captures_tool_failures_in_trace() -> None:
    """Tool errors become failed steps without bubbling out of dispatch."""
    spec = _make_echo_spec(
        steps=[
            SkillStepSpec(id="boom", tool="failing", input={"reason": "test"}),
        ],
    )
    registry = ToolRegistry([_FailingTool()])
    dispatcher = SkillDispatcher()
    result = await dispatcher.dispatch(spec, {"text": "ok"}, registry=registry)
    assert result.success is False
    assert len(result.steps) == 1
    assert result.steps[0].status == "failed"
    assert result.steps[0].message is not None
    assert "boom: test" in result.steps[0].message


@pytest.mark.asyncio
async def test_dispatch_step_output_chains_via_interpolation() -> None:
    """Step 2 must see step 1's output through {prev.output.field}."""
    spec = _make_echo_spec(
        inputs_list=[
            SkillInputField(name="text", type="string", required=True),
        ],
        steps=[
            SkillStepSpec(
                id="first",
                tool="echo",
                input={"text": "{input.text}", "count": 2},
            ),
            SkillStepSpec(
                id="second",
                tool="echo",
                input={"text": "{first.output.echoed}", "count": 1},
            ),
        ],
    )
    registry = ToolRegistry([_EchoTool()])
    dispatcher = SkillDispatcher()
    result = await dispatcher.dispatch(spec, {"text": "x"}, registry=registry)
    assert result.success is True
    assert result.steps[1].output == {"echoed": "xx", "repeats": 1}


# ---------------------------------------------------------------------------
# Execute-class skills
# ---------------------------------------------------------------------------


def _make_settings() -> CopilotSettings:
    return CopilotSettings(broker_signing_key="test-key-0000")


@pytest.mark.asyncio
async def test_dispatch_execute_step_refuses_without_broker() -> None:
    """Execute steps without a broker + callback are refused with no token."""
    settings = _make_settings()
    broker = ConfirmationBroker(settings)
    exec_tool = _ExecuteTool(broker=broker)
    spec = SkillSpec(
        id="exec-no-broker",
        name="Exec no broker",
        description="Execute skill that gets no broker at dispatch time.",
        category="execute",
        inputs=[SkillInputField(name="value", type="string", required=True)],
        steps=[
            SkillStepSpec(id="x", tool="exec_echo", input={"value": "{input.value}"}),
        ],
    )
    registry = ToolRegistry([exec_tool])
    dispatcher = SkillDispatcher()
    result = await dispatcher.dispatch(
        spec,
        {"value": "hi"},
        registry=registry,
        broker=None,
        approval_callback=None,
    )
    assert result.success is False
    assert result.steps[0].status == "refused_no_token"


@pytest.mark.asyncio
async def test_dispatch_execute_step_with_auto_approval_succeeds() -> None:
    """With broker + auto-approve callback, execute steps succeed."""
    settings = _make_settings()
    broker = ConfirmationBroker(settings)
    exec_tool = _ExecuteTool(broker=broker)

    async def _cb(skill: Any, step: Any, resolved_input: dict[str, Any]) -> ConfirmationToken:
        return await auto_approve_callback(skill, step, resolved_input, broker=broker)

    spec = SkillSpec(
        id="exec-ok",
        name="Exec ok",
        description="Execute skill that uses the auto-approve reference callback.",
        category="execute",
        inputs=[SkillInputField(name="value", type="string", required=True)],
        steps=[
            SkillStepSpec(id="x", tool="exec_echo", input={"value": "{input.value}"}),
        ],
    )
    registry = ToolRegistry([exec_tool])
    dispatcher = SkillDispatcher()
    result = await dispatcher.dispatch(
        spec,
        {"value": "hi"},
        registry=registry,
        broker=broker,
        approval_callback=_cb,
    )
    assert result.success is True
    assert result.steps[0].status == "completed"
    assert result.steps[0].token_id is not None
    # Output should include the token id from the tool.
    out = result.steps[0].output or {}
    assert out.get("echoed") == "HI"
    assert out.get("token_id") == result.steps[0].token_id


# ---------------------------------------------------------------------------
# Context
# ---------------------------------------------------------------------------


def test_skill_context_record_rejects_duplicate_step() -> None:
    """A single dispatch must not re-record the same step id."""
    ctx = SkillContext(inputs={})
    ctx.record("one", {"a": 1})
    with pytest.raises(RuntimeError, match="already recorded"):
        ctx.record("one", {"a": 2})
