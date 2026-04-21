"""Tool protocol + shared errors (CSA-0100).

A *tool* is the unit of work the agent loop plans over.  Every tool
must:

* declare a stable ``name`` (unique within a :class:`ToolRegistry`),
* declare a ``category`` — ``"read"`` or ``"execute"``,
* declare typed ``input_model`` / ``output_model`` Pydantic classes,
* implement ``__call__(input_value)`` as an async method.

Execute-class tools receive a ``ConfirmationToken`` via the broker.  The
base protocol surfaces ``requires_confirmation`` as a computed property
so the registry and agent loop can enforce the rule without calling the
tool first.

These classes are intentionally small — the real work (corpus search,
YAML walking, dry-run gate invocation) lives in
:mod:`apps.copilot.tools.readonly` and :mod:`apps.copilot.tools.execute`.
"""

from __future__ import annotations

from typing import Generic, Literal, Protocol, TypeVar, runtime_checkable

from pydantic import BaseModel

ToolCategory = Literal["read", "execute"]
"""The two tool classes. Read tools run freely; execute tools require a token."""


InputT = TypeVar("InputT", bound=BaseModel)
OutputT = TypeVar("OutputT", bound=BaseModel)


class ToolInvocationError(RuntimeError):
    """Raised when a tool cannot fulfil a call for non-schema reasons.

    Schema violations (bad shape, out-of-range values) continue to
    raise :class:`pydantic.ValidationError`.  This exception is
    specifically for runtime conditions such as a broken backing store
    or a gate script that could not be located on disk.
    """


class MissingConfirmationTokenError(ToolInvocationError):
    """Execute-class tool invoked without a broker-issued token.

    The agent loop catches this error, emits a structured step log
    marking the tool refusal, and surfaces a message instructing the
    caller to obtain a :class:`ConfirmationToken` via the broker.
    """


@runtime_checkable
class Tool(Protocol, Generic[InputT, OutputT]):
    """Minimal protocol every Copilot tool implements.

    The generic parameters bind input and output to Pydantic models so
    the agent loop can build a JSON schema for the LLM without any
    tool-specific wiring.  The ``__call__`` coroutine is the single
    side-effect surface.
    """

    name: str
    category: ToolCategory
    description: str
    input_model: type[InputT]
    output_model: type[OutputT]

    async def __call__(self, input_value: InputT) -> OutputT:  # pragma: no cover - protocol
        ...


__all__ = [
    "InputT",
    "MissingConfirmationTokenError",
    "OutputT",
    "Tool",
    "ToolCategory",
    "ToolInvocationError",
]
