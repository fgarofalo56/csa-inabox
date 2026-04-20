"""CopilotAgentLoop — CSA-0100 plan/act loop (AQ-0003).

The Phase-1 :class:`apps.copilot.agent.CopilotAgent` is a single-shot
"retrieve → generate → verify" pipeline with one implicit tool.  This
module adds a *plan/act* surface that can reason over a catalogue of
typed tools: it asks a PydanticAI-style planner for a sequence of
tool invocations, runs read tools freely, and routes execute tools
through the :class:`~apps.copilot.broker.broker.ConfirmationBroker`.

The loop is intentionally planner-agnostic — it takes an injectable
:class:`Planner` object whose ``plan`` coroutine returns a list of
:class:`PlannedStep` instructions.  In production this is backed by
PydanticAI with structured output; tests inject a deterministic fake
planner so the end-to-end behaviour can be asserted without an LLM.

Every finished run returns an :class:`AgentTrace` — a frozen object
that records every step, the tool output, whether the step required a
broker token, and any refusal reason.  The trace is what downstream
observability, evaluations, and incident triage read from.
"""

from __future__ import annotations

import time
from typing import Any, Literal, Protocol

from pydantic import BaseModel, ConfigDict, Field

from apps.copilot.broker.broker import (
    BrokerVerificationError,
    ConfirmationBroker,
)
from apps.copilot.broker.models import ConfirmationToken
from apps.copilot.tools.base import (
    MissingConfirmationTokenError,
    Tool,
    ToolInvocationError,
)
from apps.copilot.tools.registry import ToolRegistry
from csa_platform.common.logging import get_logger

logger = get_logger(__name__)


# ---------------------------------------------------------------------------
# Planner contract
# ---------------------------------------------------------------------------


StepStatus = Literal[
    "completed",
    "refused_no_token",
    "refused_broker",
    "refused_missing_tool",
    "failed",
]


class PlannedStep(BaseModel):
    """A planner-issued instruction: "call *tool_name* with *arguments*".

    The agent loop resolves ``tool_name`` to a registry entry,
    validates ``arguments`` against the tool's input model, and runs
    the tool (through the broker if execute-class).  ``token`` is the
    confirmation token the planner proposes for an execute step — it
    may be ``None``, in which case the loop refuses the step and
    returns a structured reason.
    """

    tool_name: str = Field(min_length=1, description="Registered tool name.")
    arguments: dict[str, Any] = Field(
        default_factory=dict,
        description="Keyword arguments forwarded to the tool input model.",
    )
    rationale: str = Field(
        default="",
        description="Optional planner-supplied rationale for this step.",
    )
    token: ConfirmationToken | None = Field(
        default=None,
        description="Confirmation token for execute-class tools; None otherwise.",
    )

    model_config = ConfigDict(frozen=True)


class AgentStep(BaseModel):
    """One recorded step of an agent run.

    The ``output`` field is ``None`` on refusals and errors so callers
    can distinguish "nothing happened" from "empty successful result"
    without checking a separate flag.
    """

    tool: str = Field(description="Tool name that was invoked (or attempted).")
    category: Literal["read", "execute", "unknown"] = Field(
        description="Tool category at the time of invocation.",
    )
    input: dict[str, Any] = Field(default_factory=dict)
    output: dict[str, Any] | None = Field(default=None)
    took_ms: int = Field(ge=0, description="Wall-clock duration in milliseconds.")
    token_id: str | None = Field(
        default=None,
        description="ConfirmationToken.token_id when the step ran through the broker.",
    )
    status: StepStatus = Field(description="Terminal status for the step.")
    message: str | None = Field(
        default=None,
        description="Free-form detail surfaced to the caller (refusal reasons, errors).",
    )

    model_config = ConfigDict(frozen=True)


class AgentTrace(BaseModel):
    """Full trace of a :meth:`CopilotAgentLoop.run` invocation."""

    question: str = Field(description="Original question that drove the plan.")
    steps: list[AgentStep] = Field(default_factory=list)
    refused_reasons: list[str] = Field(default_factory=list)
    total_ms: int = Field(ge=0, description="End-to-end wall-clock duration (ms).")

    model_config = ConfigDict(frozen=True)


class Planner(Protocol):
    """Minimal interface the agent loop needs from a planner.

    The real implementation wraps a PydanticAI ``Agent`` whose
    structured output is a list of :class:`PlannedStep` objects.
    Tests provide a plain object that returns a pre-baked plan.
    """

    async def plan(
        self,
        question: str,
        tools: list[dict[str, Any]],
    ) -> list[PlannedStep]: ...


# ---------------------------------------------------------------------------
# CopilotAgentLoop
# ---------------------------------------------------------------------------


class CopilotAgentLoop:
    """Plan/act agent over a :class:`ToolRegistry`.

    The loop is stateless across runs — every call to :meth:`run`
    starts from an empty trace.  Dependencies are all injectable:

    * ``registry`` — tool catalogue to plan over.
    * ``broker``   — confirmation broker for execute-class tools.
    * ``planner``  — returns the plan for a given question.

    The loop catches tool failures and records them as trace steps
    rather than propagating — the return value is the single source
    of truth for what happened during the run.
    """

    def __init__(
        self,
        *,
        registry: ToolRegistry,
        broker: ConfirmationBroker,
        planner: Planner,
    ) -> None:
        self.registry = registry
        self.broker = broker
        self.planner = planner

    async def run(self, question: str) -> AgentTrace:
        """Execute the plan for *question* and return a full trace."""
        if not question or not question.strip():
            return AgentTrace(
                question=question,
                steps=[],
                refused_reasons=["empty_question"],
                total_ms=0,
            )

        started = time.perf_counter()
        tool_specs = [spec.model_dump() for spec in self.registry.list_tools()]

        plan = await self.planner.plan(question, tool_specs)
        steps: list[AgentStep] = []
        refused: list[str] = []

        for planned in plan:
            step = await self._execute_step(planned)
            steps.append(step)
            if step.status != "completed":
                refused.append(f"{step.tool}:{step.status}")

        elapsed_ms = int((time.perf_counter() - started) * 1000)
        return AgentTrace(
            question=question,
            steps=steps,
            refused_reasons=refused,
            total_ms=elapsed_ms,
        )

    # -- internals -----------------------------------------------------------

    async def _execute_step(self, planned: PlannedStep) -> AgentStep:
        """Run one planned step, catching failures into the trace."""
        started = time.perf_counter()

        # Resolve the tool.  Missing tools are surfaced as a refusal
        # with an explicit status rather than propagating a KeyError,
        # because the trace is the audit trail and an LLM-supplied
        # tool_name typo should not crash the whole run.
        try:
            tool = self.registry.get_tool(planned.tool_name)
        except KeyError:
            return AgentStep(
                tool=planned.tool_name,
                category="unknown",
                input=planned.arguments,
                output=None,
                took_ms=_elapsed_ms(started),
                token_id=None,
                status="refused_missing_tool",
                message=f"No tool registered under name {planned.tool_name!r}.",
            )

        # Validate the arguments against the tool's input model.
        try:
            input_value = tool.input_model.model_validate(planned.arguments)
        except Exception as exc:  # pragma: no cover - pydantic raises ValidationError
            return AgentStep(
                tool=tool.name,
                category=tool.category,
                input=planned.arguments,
                output=None,
                took_ms=_elapsed_ms(started),
                token_id=planned.token.token_id if planned.token else None,
                status="failed",
                message=f"Input validation failed: {exc}",
            )

        # Execute-class tools require a token.  Read tools ignore any
        # token provided by the planner (they cannot elevate).
        if tool.category == "execute" and planned.token is None:
            return AgentStep(
                tool=tool.name,
                category=tool.category,
                input=planned.arguments,
                output=None,
                took_ms=_elapsed_ms(started),
                token_id=None,
                status="refused_no_token",
                message=(
                    f"Execute tool {tool.name!r} refused: no ConfirmationToken "
                    "supplied. Request one from the ConfirmationBroker."
                ),
            )

        # Drive the tool.  Execute tools accept a ``token`` kwarg;
        # read tools do not.  Broker verification errors collapse
        # into a refusal step; any other exception becomes a failed
        # step.
        try:
            if tool.category == "execute":
                output = await _call_execute_tool(tool, input_value, planned.token)
            else:
                output = await tool(input_value)
        except MissingConfirmationTokenError as exc:
            return AgentStep(
                tool=tool.name,
                category=tool.category,
                input=planned.arguments,
                output=None,
                took_ms=_elapsed_ms(started),
                token_id=planned.token.token_id if planned.token else None,
                status="refused_no_token",
                message=str(exc),
            )
        except BrokerVerificationError as exc:
            return AgentStep(
                tool=tool.name,
                category=tool.category,
                input=planned.arguments,
                output=None,
                took_ms=_elapsed_ms(started),
                token_id=planned.token.token_id if planned.token else None,
                status="refused_broker",
                message=str(exc),
            )
        except ToolInvocationError as exc:
            return AgentStep(
                tool=tool.name,
                category=tool.category,
                input=planned.arguments,
                output=None,
                took_ms=_elapsed_ms(started),
                token_id=planned.token.token_id if planned.token else None,
                status="failed",
                message=str(exc),
            )

        return AgentStep(
            tool=tool.name,
            category=tool.category,
            input=planned.arguments,
            output=output.model_dump(mode="json"),
            took_ms=_elapsed_ms(started),
            token_id=planned.token.token_id if planned.token else None,
            status="completed",
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

    The indirection exists so mypy can accept ``tool(input_value,
    token=token)`` against the generic :class:`Tool` protocol — the
    execute tools themselves all accept the kwarg but the protocol
    only requires the positional input.
    """
    return await tool(input_value, token=token)  # type: ignore[call-arg,no-any-return]


def _elapsed_ms(started: float) -> int:
    """Return elapsed milliseconds since *started* (perf_counter value)."""
    return int((time.perf_counter() - started) * 1000)


__all__ = [
    "AgentStep",
    "AgentTrace",
    "CopilotAgentLoop",
    "PlannedStep",
    "Planner",
    "StepStatus",
]
