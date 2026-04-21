"""JSON-RPC 2.0 message types for the Copilot CLI daemon.

Only a narrow subset of JSON-RPC is implemented — we do NOT support
batched requests (YAGNI for a local CLI bridge) and every method is
mapped to a concrete :class:`DaemonMethod` for safe dispatch.

All message models are ``frozen`` so the dispatcher cannot accidentally
mutate request objects.
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class DaemonMethod(str, Enum):
    """Supported RPC method names."""

    ask = "ask"
    ask_stream = "ask_stream"
    ingest = "ingest"
    skills_list = "skills.list"
    skills_run = "skills.run"
    tools_list = "tools.list"
    broker_approve = "broker.approve"
    shutdown = "shutdown"
    ping = "ping"


class JsonRpcRequest(BaseModel):
    """Inbound JSON-RPC request (per spec minus batching)."""

    jsonrpc: Literal["2.0"] = Field(default="2.0")
    id: str | int | None = Field(default=None)
    method: str = Field(min_length=1)
    params: dict[str, Any] = Field(default_factory=dict)

    model_config = ConfigDict(frozen=True)


class JsonRpcError(BaseModel):
    """Error envelope — mirrors the JSON-RPC 2.0 spec."""

    code: int
    message: str
    data: dict[str, Any] | None = Field(default=None)

    model_config = ConfigDict(frozen=True)


class JsonRpcResponse(BaseModel):
    """Outbound response; exactly one of ``result``/``error`` is populated."""

    jsonrpc: Literal["2.0"] = Field(default="2.0")
    id: str | int | None = Field(default=None)
    result: dict[str, Any] | None = Field(default=None)
    error: JsonRpcError | None = Field(default=None)

    model_config = ConfigDict(frozen=True)


class JsonRpcNotification(BaseModel):
    """Server-to-client notification (streaming tokens, status events)."""

    jsonrpc: Literal["2.0"] = Field(default="2.0")
    method: str
    params: dict[str, Any] = Field(default_factory=dict)

    model_config = ConfigDict(frozen=True)


# Standard JSON-RPC error codes — keep the mapping explicit so tests
# can pin the wire contract.
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603


__all__ = [
    "INTERNAL_ERROR",
    "INVALID_PARAMS",
    "INVALID_REQUEST",
    "METHOD_NOT_FOUND",
    "PARSE_ERROR",
    "DaemonMethod",
    "JsonRpcError",
    "JsonRpcNotification",
    "JsonRpcRequest",
    "JsonRpcResponse",
]
