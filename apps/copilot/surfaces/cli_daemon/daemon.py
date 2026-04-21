"""Long-lived Copilot daemon — keeps the agent warm for repeated CLI calls.

The daemon listens on a Unix domain socket (POSIX) or a localhost TCP
socket (Windows).  Each incoming connection carries a single JSON-RPC
request followed by ``\\n`` — responses flow back on the same
connection.  Streaming methods push :class:`JsonRpcNotification`
frames before the terminal :class:`JsonRpcResponse`.

Socket + pidfile layout::

    ${XDG_RUNTIME_DIR:-$HOME/.csa}/copilot.sock
    ${XDG_RUNTIME_DIR:-$HOME/.csa}/copilot.pid

On Windows, the daemon binds to ``127.0.0.1:0`` (OS-assigned port) and
writes ``{"host": "127.0.0.1", "port": 12345, "pid": 42}`` to the
pidfile so clients can discover it.

The daemon is **stateless** from the host perspective — killing the
process is safe at any time; the pidfile is recreated on the next
start.  Tests exercise all paths via tmp_path-scoped fixtures.
"""

from __future__ import annotations

import asyncio
import contextlib
import importlib.util
import json
import os
import signal
import sys
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from apps.copilot.models import AnswerChunk, AnswerResponse, Citation
from apps.copilot.surfaces.cli_daemon.protocol import (
    INTERNAL_ERROR,
    INVALID_PARAMS,
    INVALID_REQUEST,
    METHOD_NOT_FOUND,
    PARSE_ERROR,
    DaemonMethod,
    JsonRpcError,
    JsonRpcNotification,
    JsonRpcRequest,
    JsonRpcResponse,
)
from csa_platform.common.logging import get_logger

if TYPE_CHECKING:  # pragma: no cover
    from apps.copilot.agent import CopilotAgent

logger = get_logger(__name__)


# ─────────────────────────────────────────────────────────────────────────
# Paths
# ─────────────────────────────────────────────────────────────────────────


def _default_runtime_dir() -> Path:
    """Return the preferred runtime directory for sockets / pidfiles."""
    xdg = os.environ.get("XDG_RUNTIME_DIR")
    if xdg:
        return Path(xdg)
    return Path.home() / ".csa"


def default_socket_path() -> Path:
    """Return the default Unix domain socket path."""
    return _default_runtime_dir() / "copilot.sock"


def default_pidfile_path() -> Path:
    """Return the default pidfile path."""
    return _default_runtime_dir() / "copilot.pid"


def is_windows() -> bool:
    """Return True when running on Windows (for transport selection)."""
    return sys.platform.startswith("win")


# ─────────────────────────────────────────────────────────────────────────
# Pidfile
# ─────────────────────────────────────────────────────────────────────────


def write_pidfile(path: Path, payload: dict[str, Any]) -> None:
    """Write *payload* to *path*, creating parents and overwriting stale pids."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, sort_keys=True), encoding="utf-8")
    tmp.replace(path)


def read_pidfile(path: Path) -> dict[str, Any] | None:
    """Return parsed pidfile payload, or None when missing / malformed."""
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    return data


def remove_pidfile(path: Path) -> None:
    """Remove *path* if it exists; suppress errors (best-effort cleanup)."""
    with contextlib.suppress(FileNotFoundError):
        path.unlink()


# ─────────────────────────────────────────────────────────────────────────
# Agent factory
# ─────────────────────────────────────────────────────────────────────────


def _default_agent_factory() -> CopilotAgent:
    """Build the production :class:`CopilotAgent`."""
    from apps.copilot.agent import CopilotAgent
    from apps.copilot.config import CopilotSettings

    return CopilotAgent.from_settings(CopilotSettings())


# ─────────────────────────────────────────────────────────────────────────
# Daemon
# ─────────────────────────────────────────────────────────────────────────


@dataclass
class DaemonConfig:
    """Runtime configuration for :class:`CopilotDaemon`.

    Most fields have sensible defaults so tests can use ``tmp_path`` by
    overriding just ``socket_path`` and ``pidfile_path``.
    """

    socket_path: Path = field(default_factory=default_socket_path)
    pidfile_path: Path = field(default_factory=default_pidfile_path)
    tcp_host: str = "127.0.0.1"
    tcp_port: int = 0
    force_tcp: bool = False


class CopilotDaemon:
    """Warm-agent daemon speaking JSON-RPC 2.0 over a local socket.

    The daemon owns exactly one :class:`CopilotAgent` (shared across
    connections) and dispatches every request through an internal
    method table.  Shutdown is cooperative — clients send the
    ``shutdown`` RPC or send SIGTERM to the process.
    """

    def __init__(
        self,
        config: DaemonConfig | None = None,
        *,
        agent_factory: Callable[[], Any] | None = None,
    ) -> None:
        self.config = config or DaemonConfig()
        self._agent_factory: Callable[[], Any] = agent_factory or _default_agent_factory
        self._agent: Any = None
        self._server: asyncio.base_events.Server | None = None
        self._shutdown_event = asyncio.Event()
        self._bound_tcp_port: int | None = None

    # -- lifecycle -----------------------------------------------------------

    async def serve(self) -> None:
        """Bind the socket, warm the agent, and accept connections.

        Returns when a client issues the ``shutdown`` RPC or the OS
        signals the process.
        """
        self._agent = self._agent_factory()
        if is_windows() or self.config.force_tcp:
            self._server = await asyncio.start_server(
                self._handle_connection,
                host=self.config.tcp_host,
                port=self.config.tcp_port,
            )
            socket_info = self._server.sockets[0].getsockname() if self._server.sockets else ()
            if isinstance(socket_info, tuple) and len(socket_info) >= 2:
                self._bound_tcp_port = int(socket_info[1])
            payload = {
                "pid": os.getpid(),
                "host": self.config.tcp_host,
                "port": self._bound_tcp_port or 0,
                "transport": "tcp",
                "started_at": time.time(),
            }
        else:
            # Remove a stale socket before binding — POSIX doesn't clean
            # up after a crash.  ``asyncio.start_unix_server`` is only
            # present on POSIX; the attribute access is guarded by the
            # ``is_windows()`` check above.
            self.config.socket_path.parent.mkdir(parents=True, exist_ok=True)
            if self.config.socket_path.exists():
                self.config.socket_path.unlink()
            start_unix_server = getattr(asyncio, "start_unix_server", None)
            if start_unix_server is None:  # pragma: no cover - Windows
                raise RuntimeError(
                    "Unix-domain sockets are unavailable on this platform; "
                    "run with force_tcp=True.",
                )
            self._server = await start_unix_server(
                self._handle_connection,
                path=str(self.config.socket_path),
            )
            payload = {
                "pid": os.getpid(),
                "socket": str(self.config.socket_path),
                "transport": "unix",
                "started_at": time.time(),
            }

        write_pidfile(self.config.pidfile_path, payload)
        logger.info(
            "copilot.daemon.started",
            surface="cli_daemon",
            method="serve",
            pid=os.getpid(),
            pidfile=str(self.config.pidfile_path),
        )

        try:
            await self._shutdown_event.wait()
        finally:
            await self._cleanup()

    async def request_shutdown(self) -> None:
        """Ask the daemon to exit; pending connections finish draining."""
        self._shutdown_event.set()

    async def _cleanup(self) -> None:
        """Close the server socket and remove the pidfile."""
        if self._server is not None:
            self._server.close()
            with contextlib.suppress(Exception):  # pragma: no cover - best effort
                await self._server.wait_closed()
        if not is_windows() and not self.config.force_tcp:
            with contextlib.suppress(OSError):  # pragma: no cover - best effort
                if self.config.socket_path.exists():
                    self.config.socket_path.unlink()
        remove_pidfile(self.config.pidfile_path)
        logger.info(
            "copilot.daemon.stopped",
            surface="cli_daemon",
            method="serve",
            pid=os.getpid(),
        )

    # -- dispatch ------------------------------------------------------------

    async def _handle_connection(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        """Process one client connection — one request, possible stream, one response."""
        raw_line: bytes
        try:
            raw_line = await reader.readline()
        except ConnectionError:  # pragma: no cover - defensive
            writer.close()
            return

        if not raw_line:
            writer.close()
            return

        try:
            data = json.loads(raw_line.decode("utf-8"))
        except json.JSONDecodeError as exc:
            await self._write_response(
                writer,
                JsonRpcResponse(
                    id=None,
                    error=JsonRpcError(code=PARSE_ERROR, message=str(exc)),
                ),
            )
            writer.close()
            return

        try:
            request = JsonRpcRequest.model_validate(data)
        except Exception as exc:
            await self._write_response(
                writer,
                JsonRpcResponse(
                    id=data.get("id") if isinstance(data, dict) else None,
                    error=JsonRpcError(code=INVALID_REQUEST, message=str(exc)),
                ),
            )
            writer.close()
            return

        try:
            await self._dispatch(request, writer)
        except Exception as exc:  # pragma: no cover - defensive catch-all
            logger.exception("copilot.daemon.dispatch_error", error=str(exc))
            await self._write_response(
                writer,
                JsonRpcResponse(
                    id=request.id,
                    error=JsonRpcError(code=INTERNAL_ERROR, message=str(exc)),
                ),
            )
        finally:
            with contextlib.suppress(ConnectionError):  # pragma: no cover
                await writer.drain()
            writer.close()

    async def _dispatch(
        self,
        request: JsonRpcRequest,
        writer: asyncio.StreamWriter,
    ) -> None:
        """Route *request* to the appropriate handler."""
        try:
            method = DaemonMethod(request.method)
        except ValueError:
            await self._write_response(
                writer,
                JsonRpcResponse(
                    id=request.id,
                    error=JsonRpcError(
                        code=METHOD_NOT_FOUND,
                        message=f"Unknown method {request.method!r}",
                    ),
                ),
            )
            return

        handlers: dict[DaemonMethod, Callable[..., Awaitable[JsonRpcResponse]]] = {
            DaemonMethod.ping: self._method_ping,
            DaemonMethod.ask: self._method_ask,
            DaemonMethod.ingest: self._method_ingest,
            DaemonMethod.skills_list: self._method_skills_list,
            DaemonMethod.skills_run: self._method_skills_run,
            DaemonMethod.tools_list: self._method_tools_list,
            DaemonMethod.broker_approve: self._method_broker_approve,
            DaemonMethod.shutdown: self._method_shutdown,
        }

        if method == DaemonMethod.ask_stream:
            await self._method_ask_stream(request, writer)
            return

        handler = handlers[method]
        response = await handler(request)
        await self._write_response(writer, response)

    # -- handlers ------------------------------------------------------------

    async def _method_ping(self, request: JsonRpcRequest) -> JsonRpcResponse:
        return JsonRpcResponse(id=request.id, result={"status": "pong", "pid": os.getpid()})

    async def _method_ask(self, request: JsonRpcRequest) -> JsonRpcResponse:
        question = request.params.get("question")
        if not isinstance(question, str) or not question.strip():
            return JsonRpcResponse(
                id=request.id,
                error=JsonRpcError(
                    code=INVALID_PARAMS,
                    message="`question` must be a non-empty string",
                ),
            )
        assert self._agent is not None
        response: AnswerResponse = await self._agent.ask(question)
        return JsonRpcResponse(id=request.id, result=response.model_dump(mode="json"))

    async def _method_ask_stream(
        self,
        request: JsonRpcRequest,
        writer: asyncio.StreamWriter,
    ) -> None:
        question = request.params.get("question")
        if not isinstance(question, str) or not question.strip():
            await self._write_response(
                writer,
                JsonRpcResponse(
                    id=request.id,
                    error=JsonRpcError(
                        code=INVALID_PARAMS,
                        message="`question` must be a non-empty string",
                    ),
                ),
            )
            return

        assert self._agent is not None
        final_payload: dict[str, Any] | None = None
        async for chunk in self._agent.ask_stream(question):
            await self._write_notification(
                writer,
                JsonRpcNotification(
                    method="ask_stream.event",
                    params=_chunk_to_notification(chunk),
                ),
            )
            if chunk.kind == "done" and isinstance(chunk.payload, AnswerResponse):
                final_payload = chunk.payload.model_dump(mode="json")

        await self._write_response(
            writer,
            JsonRpcResponse(id=request.id, result={"done": True, "final": final_payload}),
        )

    async def _method_ingest(self, request: JsonRpcRequest) -> JsonRpcResponse:
        # The daemon does not run ingestion itself — it returns a broker
        # token request just like the FastAPI surface.
        return JsonRpcResponse(
            id=request.id,
            result={
                "status": "pending_confirmation",
                "token_request_url": "/copilot/broker/request",
                "message": (
                    "Ingestion is execute-class; request a broker token "
                    "before invoking the indexer."
                ),
            },
        )

    async def _method_skills_list(self, request: JsonRpcRequest) -> JsonRpcResponse:
        spec = importlib.util.find_spec("apps.copilot.skills")
        if spec is None:
            return JsonRpcResponse(id=request.id, result={"skills": []})
        try:
            from apps.copilot.skills.catalog import SkillCatalog

            catalog = SkillCatalog.from_shipped()
            skills = [
                {
                    "id": s.id,
                    "name": getattr(s, "name", s.id),
                    "description": getattr(s, "description", ""),
                }
                for s in catalog.list()
            ]
            return JsonRpcResponse(id=request.id, result={"skills": skills})
        except Exception as exc:
            logger.warning("copilot.daemon.skills_list_error", error=str(exc))
            return JsonRpcResponse(id=request.id, result={"skills": []})

    async def _method_skills_run(self, request: JsonRpcRequest) -> JsonRpcResponse:
        spec = importlib.util.find_spec("apps.copilot.skills")
        if spec is None:
            return JsonRpcResponse(
                id=request.id,
                error=JsonRpcError(
                    code=METHOD_NOT_FOUND,
                    message="apps.copilot.skills package is not installed",
                ),
            )
        skill_name = request.params.get("skill_name")
        if not isinstance(skill_name, str) or not skill_name:
            return JsonRpcResponse(
                id=request.id,
                error=JsonRpcError(
                    code=INVALID_PARAMS,
                    message="`skill_name` is required",
                ),
            )
        # Skill execution requires a broker + approval callback that
        # cannot be driven from a transport-layer RPC without leaking
        # tokens on the wire.  The daemon echoes the request with a
        # structured refusal so clients can surface the right message.
        return JsonRpcResponse(
            id=request.id,
            result={
                "status": "refused_interactive",
                "message": (
                    "Skill execution must flow through the FastAPI "
                    "surface or the in-process SkillCatalog API — the "
                    "daemon cannot gate broker approvals safely."
                ),
                "skill_name": skill_name,
            },
        )

    async def _method_tools_list(self, request: JsonRpcRequest) -> JsonRpcResponse:
        # The daemon does not own a populated registry by default; clients
        # that need one should construct their own CopilotAgentLoop via
        # the Python API.  This endpoint advertises only the built-in
        # method surface.
        return JsonRpcResponse(
            id=request.id,
            result={"methods": [m.value for m in DaemonMethod]},
        )

    async def _method_broker_approve(
        self,
        request: JsonRpcRequest,
    ) -> JsonRpcResponse:
        # Parity with the CLI stub: the daemon echoes inputs for audit
        # and exits without approving a real request — the broker is
        # process-local and the canonical approval surface is the
        # FastAPI endpoint.
        return JsonRpcResponse(
            id=request.id,
            result={
                "status": "unimplemented",
                "message": (
                    "Broker approvals flow through the FastAPI surface "
                    "(/copilot/broker/approve).  The daemon does not persist "
                    "pending requests."
                ),
                "echo": request.params,
            },
        )

    async def _method_shutdown(self, request: JsonRpcRequest) -> JsonRpcResponse:
        await self.request_shutdown()
        return JsonRpcResponse(id=request.id, result={"shutting_down": True})

    # -- wire ----------------------------------------------------------------

    @staticmethod
    async def _write_response(
        writer: asyncio.StreamWriter,
        response: JsonRpcResponse,
    ) -> None:
        payload = response.model_dump(mode="json", exclude_none=True)
        writer.write((json.dumps(payload) + "\n").encode("utf-8"))
        await writer.drain()

    @staticmethod
    async def _write_notification(
        writer: asyncio.StreamWriter,
        notification: JsonRpcNotification,
    ) -> None:
        payload = notification.model_dump(mode="json")
        writer.write((json.dumps(payload) + "\n").encode("utf-8"))
        await writer.drain()


def _chunk_to_notification(chunk: AnswerChunk) -> dict[str, Any]:
    """Convert an :class:`AnswerChunk` to the notification params payload."""
    if isinstance(chunk.payload, (AnswerResponse, Citation)):
        return {"kind": chunk.kind, "payload": chunk.payload.model_dump(mode="json")}
    return {"kind": chunk.kind, "payload": chunk.payload}


def _install_signal_handlers(daemon: CopilotDaemon) -> None:
    """Best-effort SIGTERM / SIGINT handlers for graceful shutdown."""
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        with contextlib.suppress(NotImplementedError):  # pragma: no cover - Windows
            loop.add_signal_handler(
                sig,
                lambda: asyncio.create_task(daemon.request_shutdown()),
            )


async def _serve_forever(daemon: CopilotDaemon) -> None:
    """Run :meth:`CopilotDaemon.serve` with signal handlers wired up."""
    _install_signal_handlers(daemon)
    await daemon.serve()


async def iter_lines(reader: asyncio.StreamReader) -> AsyncIterator[bytes]:
    """Yield newline-delimited frames from a stream reader."""
    while True:
        line = await reader.readline()
        if not line:
            return
        yield line


__all__ = [
    "CopilotDaemon",
    "DaemonConfig",
    "default_pidfile_path",
    "default_socket_path",
    "is_windows",
    "iter_lines",
    "read_pidfile",
    "remove_pidfile",
    "write_pidfile",
]
