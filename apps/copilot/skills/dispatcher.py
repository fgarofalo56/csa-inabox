"""Skill dispatcher — composes tool invocations per a :class:`SkillSpec`.

Responsibilities
----------------

* Resolve caller input against the skill's declared
  :class:`SkillInputField` list, applying defaults and enforcing
  ``required``.
* Walk the skill's ``steps`` in order, resolving interpolations, and
  invoke each referenced tool.
* For execute-class tools, acquire a broker
  :class:`~apps.copilot.broker.models.ConfirmationToken` via the
  injected approval callback before invocation.
* Capture every step as a frozen :class:`SkillStep` in the returned
  :class:`SkillResult`; read tools never touch the broker, so their
  ``token_id`` is ``None``.
* Propagate failures into the trace rather than raising — the result
  is the audit surface.

Interpolation grammar (sandboxed, **no** ``eval`` / ``exec``)
-------------------------------------------------------------

Any string value in a step's ``input`` mapping may contain one or more
``{...}`` tokens.  A token references either:

* ``{input.<field_name>}`` — resolves to the caller-supplied input
  under that name, or its declared ``default`` when omitted;
* ``{<step_id>.output.<dotted.path>}`` — resolves to a field in a
  prior step's output dict.

Any other template shape (including raw ``{x}`` without a dotted
namespace) is a :class:`SkillInterpolationError`.

When the token is the *entirety* of the string value, the resolved
object is substituted verbatim (preserving type — lists stay lists,
numbers stay numbers).  When the token is embedded inside a longer
string, the resolved value is coerced to ``str`` via ``str(value)``.
"""

from __future__ import annotations

import re
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

from pydantic import BaseModel, ValidationError

from apps.copilot.broker.broker import (
    BrokerVerificationError,
    ConfirmationBroker,
    compute_input_hash,
)
from apps.copilot.broker.models import (
    ConfirmationRequest,
    ConfirmationToken,
)
from apps.copilot.skills.base import (
    SkillContext,
    SkillResult,
    SkillSpec,
    SkillStep,
    SkillStepSpec,
    StepStatus,
)
from apps.copilot.skills.errors import (
    SkillExecutionError,
    SkillInputError,
    SkillInterpolationError,
)
from apps.copilot.tools.base import (
    MissingConfirmationTokenError,
    Tool,
    ToolInvocationError,
)
from apps.copilot.tools.registry import ToolRegistry
from csa_platform.common.logging import get_logger

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Interpolation engine
# ---------------------------------------------------------------------------


# Match a single ``{...}`` token.  The inner body is captured without
# the braces.  We deliberately reject nested braces — the grammar is
# intentionally narrow.
_TEMPLATE_TOKEN_RE = re.compile(r"\{([^{}]+)\}")

# A legal token body is either ``input.<identifier>`` or
# ``<step_id>.output(.<field>)*``.  Identifiers in the dotted path may
# contain letters, digits, underscore, or hyphen for the step id; path
# segments after ``output`` use dotted identifier form.
_INPUT_BODY_RE = re.compile(r"^input\.([A-Za-z_][A-Za-z0-9_]*)$")
_STEP_BODY_RE = re.compile(
    r"^(?P<step>[A-Za-z_][A-Za-z0-9_-]*)\.output(?:\.(?P<path>[A-Za-z_][A-Za-z0-9_.]*))?$",
)


def _resolve_token(body: str, context: SkillContext) -> Any:
    """Resolve a single template body against *context*.

    Raises :class:`SkillInterpolationError` for any unrecognised shape,
    missing step reference, or missing dotted field.
    """
    m_input = _INPUT_BODY_RE.match(body)
    if m_input:
        name = m_input.group(1)
        if name not in context.inputs:
            raise SkillInterpolationError(
                f"Interpolation references unknown input {name!r}.",
            )
        return context.inputs[name]

    m_step = _STEP_BODY_RE.match(body)
    if m_step:
        step_id = m_step.group("step")
        path = m_step.group("path")  # may be None → whole output dict
        if step_id not in context.step_outputs:
            raise SkillInterpolationError(
                f"Interpolation references step {step_id!r} before it has run.",
            )
        output = context.step_outputs[step_id]
        if output is None:
            raise SkillInterpolationError(
                f"Step {step_id!r} has no output (was skipped or failed).",
            )
        if path is None:
            return output
        cursor: Any = output
        for segment in path.split("."):
            if isinstance(cursor, dict) and segment in cursor:
                cursor = cursor[segment]
            elif isinstance(cursor, list):
                try:
                    idx = int(segment)
                except ValueError as exc:
                    raise SkillInterpolationError(
                        f"Cannot index list with non-integer segment {segment!r} in {body!r}.",
                    ) from exc
                try:
                    cursor = cursor[idx]
                except IndexError as exc:
                    raise SkillInterpolationError(
                        f"Index {idx} out of range for step {step_id!r} output at {body!r}.",
                    ) from exc
            else:
                raise SkillInterpolationError(
                    f"Cannot resolve {body!r}: segment {segment!r} missing.",
                )
        return cursor

    raise SkillInterpolationError(
        f"Unsupported interpolation token {{{body}}}. "
        "Expected {input.<name>} or {step-id.output[.field]}.",
    )


def interpolate_value(value: Any, context: SkillContext) -> Any:
    """Recursively resolve interpolation tokens in *value*.

    Dicts and lists are traversed in-place (a new copy is returned);
    strings are scanned for tokens.  Any other type is returned
    unchanged.
    """
    if isinstance(value, str):
        return _interpolate_string(value, context)
    if isinstance(value, dict):
        return {k: interpolate_value(v, context) for k, v in value.items()}
    if isinstance(value, list):
        return [interpolate_value(v, context) for v in value]
    return value


def _interpolate_string(value: str, context: SkillContext) -> Any:
    """Interpolate all ``{...}`` tokens in a string.

    When the string is *exactly* one token, return the resolved value
    preserving its native type.  Otherwise, stringify each token and
    perform textual substitution.
    """
    matches = list(_TEMPLATE_TOKEN_RE.finditer(value))
    if not matches:
        return value

    # Whole-string single-token case → preserve native type.
    if len(matches) == 1 and matches[0].group(0) == value:
        return _resolve_token(matches[0].group(1), context)

    # Multi-token or embedded case → textual replacement.
    def _replace(match: re.Match[str]) -> str:
        return str(_resolve_token(match.group(1), context))

    return _TEMPLATE_TOKEN_RE.sub(_replace, value)


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------


ApprovalCallback = Callable[[SkillSpec, SkillStepSpec, dict[str, Any]], Awaitable[ConfirmationToken]]
"""Callback that issues a :class:`ConfirmationToken` for an execute step.

The dispatcher calls the callback with ``(skill, step, resolved_input)``
and expects an already-approved token.  A typical production wiring
creates a :class:`ConfirmationRequest` via the broker, runs an
operator-confirm UI, and returns the resulting token.  Tests supply a
stub that auto-approves.
"""


class SkillDispatcher:
    """Compose tool invocations per a :class:`SkillSpec`.

    Construction is cheap — dispatchers are not tied to a single
    skill; callers may reuse one instance across many dispatches and
    across many registries (passed per-call).
    """

    def __init__(
        self,
        *,
        caller_principal: str = "copilot.skills",
    ) -> None:
        self.caller_principal = caller_principal

    async def dispatch(
        self,
        skill: SkillSpec,
        inputs: dict[str, Any],
        *,
        registry: ToolRegistry,
        broker: ConfirmationBroker | None = None,
        approval_callback: ApprovalCallback | None = None,
    ) -> SkillResult:
        """Execute *skill* with *inputs* and return a structured result.

        *registry* supplies every tool referenced in the skill's
        steps.  *broker* is required when the skill or any of its
        steps is execute-class.  *approval_callback* is required when
        execute steps exist; for tests a stub that issues tokens
        directly works.
        """
        trace_id = str(uuid.uuid4())
        started = time.perf_counter()
        steps: list[SkillStep] = []

        resolved_inputs = self._resolve_inputs(skill, inputs)
        context = SkillContext(inputs=resolved_inputs)
        logger.info(
            "copilot.skill.dispatch.start",
            skill_id=skill.id,
            trace_id=trace_id,
            step_count=len(skill.steps),
        )

        aborted = False
        for step_spec in skill.steps:
            step = await self._run_step(
                skill=skill,
                step_spec=step_spec,
                context=context,
                registry=registry,
                broker=broker,
                approval_callback=approval_callback,
                trace_id=trace_id,
            )
            steps.append(step)
            context.record(step_spec.id, step.output)
            if step.status in ("failed", "refused_broker"):
                # Hard failures abort the dispatch regardless of
                # fallback mode — skip is only for missing-tool cases.
                aborted = True
                break
            if step.status == "refused_missing_tool" and skill.fallback_if_tool_missing == "fail":
                aborted = True
                break

        success = all(s.status == "completed" for s in steps)
        # Aggregate outputs: Phase 3 returns the last completed step's
        # output to keep the contract simple.  If every step was
        # skipped/failed, ``outputs`` stays empty.
        outputs: dict[str, Any] = {}
        for s in reversed(steps):
            if s.status == "completed" and s.output:
                outputs = s.output
                break

        message: str | None = None
        if aborted:
            message = f"Dispatch aborted on step {steps[-1].step_id!r} ({steps[-1].status})."
        elif not success:
            message = "One or more steps did not complete cleanly."

        total_ms = int((time.perf_counter() - started) * 1000)
        logger.info(
            "copilot.skill.dispatch.end",
            skill_id=skill.id,
            trace_id=trace_id,
            success=success,
            total_ms=total_ms,
            aborted=aborted,
        )

        return SkillResult(
            skill_id=skill.id,
            trace_id=trace_id,
            success=success,
            outputs=outputs,
            steps=steps,
            total_ms=total_ms,
            message=message,
        )

    # -- input resolution ----------------------------------------------------

    def _resolve_inputs(
        self,
        skill: SkillSpec,
        inputs: dict[str, Any],
    ) -> dict[str, Any]:
        """Validate caller inputs and apply declared defaults.

        Raises :class:`SkillInputError` when a required field is
        missing or an ``enum``-constrained value is out of range.
        """
        resolved: dict[str, Any] = {}
        for field in skill.inputs:
            if field.name in inputs:
                value = inputs[field.name]
            elif field.required:
                raise SkillInputError(
                    f"Skill {skill.id!r} requires input {field.name!r}.",
                    skill_id=skill.id,
                )
            else:
                value = field.default
            if field.enum is not None and value not in field.enum:
                raise SkillInputError(
                    f"Skill {skill.id!r} input {field.name!r}={value!r} is not in the allowed set {field.enum!r}.",
                    skill_id=skill.id,
                )
            resolved[field.name] = value

        # Reject unknown inputs so typos fail loud.
        unexpected = set(inputs) - skill.input_names
        if unexpected:
            raise SkillInputError(
                f"Skill {skill.id!r} received unexpected inputs: {sorted(unexpected)}.",
                skill_id=skill.id,
            )
        return resolved

    # -- step execution ------------------------------------------------------

    async def _run_step(
        self,
        *,
        skill: SkillSpec,
        step_spec: SkillStepSpec,
        context: SkillContext,
        registry: ToolRegistry,
        broker: ConfirmationBroker | None,
        approval_callback: ApprovalCallback | None,
        trace_id: str,
    ) -> SkillStep:
        """Run a single step, capturing every failure into the trace."""
        started = time.perf_counter()

        # Step 1: Resolve the tool.
        try:
            tool = registry.get_tool(step_spec.tool)
        except KeyError:
            status: StepStatus = "refused_missing_tool"
            message = f"Tool {step_spec.tool!r} is not registered."
            if skill.fallback_if_tool_missing == "skip":
                logger.info(
                    "copilot.skill.step.skipped",
                    skill_id=skill.id,
                    trace_id=trace_id,
                    step_id=step_spec.id,
                    tool=step_spec.tool,
                )
                status = "skipped"
                message = f"Skipped: tool {step_spec.tool!r} is not registered."
            return SkillStep(
                step_id=step_spec.id,
                tool=step_spec.tool,
                input={},
                output=None,
                status=status,
                took_ms=_elapsed_ms(started),
                token_id=None,
                message=message,
            )

        # Step 2: Resolve interpolations against the context.
        try:
            resolved_input = interpolate_value(step_spec.input, context)
        except SkillInterpolationError as exc:
            return SkillStep(
                step_id=step_spec.id,
                tool=step_spec.tool,
                input={},
                output=None,
                status="failed",
                took_ms=_elapsed_ms(started),
                token_id=None,
                message=f"Interpolation failed: {exc}",
            )
        if not isinstance(resolved_input, dict):
            return SkillStep(
                step_id=step_spec.id,
                tool=step_spec.tool,
                input={},
                output=None,
                status="failed",
                took_ms=_elapsed_ms(started),
                token_id=None,
                message=(
                    f"Resolved step input is not a mapping ({type(resolved_input).__name__}). "
                    "Step inputs must always resolve to a JSON object."
                ),
            )

        # Step 3: Validate against the tool's input model.
        try:
            validated_input = tool.input_model.model_validate(resolved_input)
        except ValidationError as exc:
            return SkillStep(
                step_id=step_spec.id,
                tool=step_spec.tool,
                input=resolved_input,
                output=None,
                status="failed",
                took_ms=_elapsed_ms(started),
                token_id=None,
                message=f"Tool input validation failed: {exc.errors()}",
            )

        # Step 4: Acquire a token for execute tools.
        token: ConfirmationToken | None = None
        if tool.category == "execute":
            if broker is None or approval_callback is None:
                return SkillStep(
                    step_id=step_spec.id,
                    tool=tool.name,
                    input=resolved_input,
                    output=None,
                    status="refused_no_token",
                    took_ms=_elapsed_ms(started),
                    token_id=None,
                    message=(
                        f"Execute step {step_spec.id!r} refused: skill dispatcher "
                        "was not given a broker + approval_callback."
                    ),
                )
            try:
                token = await approval_callback(skill, step_spec, resolved_input)
            except Exception as exc:
                return SkillStep(
                    step_id=step_spec.id,
                    tool=tool.name,
                    input=resolved_input,
                    output=None,
                    status="refused_broker",
                    took_ms=_elapsed_ms(started),
                    token_id=None,
                    message=f"Approval callback failed: {exc}",
                )

        # Step 5: Invoke the tool.
        try:
            if tool.category == "execute":
                output = await _call_execute_tool(tool, validated_input, token)
            else:
                output = await tool(validated_input)
        except MissingConfirmationTokenError as exc:
            return SkillStep(
                step_id=step_spec.id,
                tool=tool.name,
                input=resolved_input,
                output=None,
                status="refused_no_token",
                took_ms=_elapsed_ms(started),
                token_id=token.token_id if token else None,
                message=str(exc),
            )
        except BrokerVerificationError as exc:
            return SkillStep(
                step_id=step_spec.id,
                tool=tool.name,
                input=resolved_input,
                output=None,
                status="refused_broker",
                took_ms=_elapsed_ms(started),
                token_id=token.token_id if token else None,
                message=str(exc),
            )
        except ToolInvocationError as exc:
            return SkillStep(
                step_id=step_spec.id,
                tool=tool.name,
                input=resolved_input,
                output=None,
                status="failed",
                took_ms=_elapsed_ms(started),
                token_id=token.token_id if token else None,
                message=str(exc),
            )

        logger.info(
            "copilot.skill.step.completed",
            skill_id=skill.id,
            trace_id=trace_id,
            step_id=step_spec.id,
            tool=tool.name,
            took_ms=_elapsed_ms(started),
            broker_token_id=token.token_id if token else None,
        )
        return SkillStep(
            step_id=step_spec.id,
            tool=tool.name,
            input=resolved_input,
            output=output.model_dump(mode="json"),
            status="completed",
            took_ms=_elapsed_ms(started),
            token_id=token.token_id if token else None,
            message=None,
        )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _call_execute_tool(
    tool: Tool[Any, Any],
    input_value: BaseModel,
    token: ConfirmationToken | None,
) -> BaseModel:
    """Invoke an execute-class tool with its ``token`` kwarg.

    Mirrors :func:`apps.copilot.agent_loop._call_execute_tool` — the
    protocol only declares the positional input, but execute tools
    accept a ``token`` kwarg.
    """
    return await tool(input_value, token=token)  # type: ignore[call-arg,no-any-return]


def _elapsed_ms(started: float) -> int:
    """Return elapsed milliseconds since *started* (perf_counter)."""
    return int((time.perf_counter() - started) * 1000)


async def auto_approve_callback(
    skill: SkillSpec,
    step: SkillStepSpec,
    resolved_input: dict[str, Any],
    *,
    broker: ConfirmationBroker,
    caller_principal: str = "copilot.skills",
    approver_principal: str = "copilot.skills.auto",
) -> ConfirmationToken:
    """Reference callback that requests + approves a token in one go.

    Suitable for test harnesses and single-operator CLI flows.  For
    production use, replace this with a callback that routes through
    the real approval UI.

    Raises :class:`SkillExecutionError` wrapping any broker failure
    so the dispatcher can surface it as a refused step.
    """
    request_id = f"skill-{skill.id}-{step.id}-{uuid.uuid4().hex[:8]}"
    input_hash = compute_input_hash(resolved_input)
    try:
        await broker.request(
            ConfirmationRequest(
                request_id=request_id,
                tool_name=step.tool,
                caller_principal=caller_principal,
                scope=f"skill:{skill.id}:{step.id}",
                input_hash=input_hash,
                justification=f"Auto-approved for skill {skill.id}.{step.id}.",
            ),
        )
        return await broker.approve(request_id, approver_principal)
    except Exception as exc:
        raise SkillExecutionError(
            f"auto_approve_callback failed for skill={skill.id} step={step.id}: {exc}",
            skill_id=skill.id,
        ) from exc


__all__ = [
    "ApprovalCallback",
    "SkillDispatcher",
    "auto_approve_callback",
    "interpolate_value",
]
