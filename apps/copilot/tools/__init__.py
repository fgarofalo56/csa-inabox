"""Copilot tool catalogue — CSA-0100 (AQ-0003).

The ``tools`` package is the plan/act surface the agent loop consults
when routing a user question.  Every tool is a typed, frozen Pydantic
contract with a ``category`` of either ``read`` or ``execute``.

* **read-class** tools may be invoked freely by the agent loop — they
  are pure queries over the corpus, filesystem, or dry-run primitives.
* **execute-class** tools must be accompanied by a valid
  :class:`~apps.copilot.broker.models.ConfirmationToken` issued by the
  :class:`~apps.copilot.broker.broker.ConfirmationBroker` (CSA-0102).
  Invoking an execute tool without a token raises
  :class:`~apps.copilot.tools.base.MissingConfirmationTokenError`.

The module is import-safe: importing ``apps.copilot.tools`` does not
perform any side-effects.  Instantiating a tool merely binds
configuration; side-effects only happen when ``__call__`` is awaited
(and for execute tools, only after broker verification).
"""

from __future__ import annotations

from apps.copilot.tools.base import (
    MissingConfirmationTokenError,
    Tool,
    ToolCategory,
    ToolInvocationError,
)
from apps.copilot.tools.registry import ToolRegistry, ToolSpec

__all__ = [
    "MissingConfirmationTokenError",
    "Tool",
    "ToolCategory",
    "ToolInvocationError",
    "ToolRegistry",
    "ToolSpec",
]
